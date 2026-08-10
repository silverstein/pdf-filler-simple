/**
 * The worker thread that actually runs QPDF, and the only module in the tree
 * that loads the vendored QPDF WebAssembly runtime.
 *
 * ## Why decryption runs here rather than in the server
 *
 * QPDF-WASM is a synchronous Emscripten build: `callMain` is one blocking call
 * that returns only when QPDF is finished. Nothing on the calling thread runs
 * while it is in flight — not a timer, not an incoming MCP request, not a
 * promise continuation. A deadline expressed as a `setTimeout` on that thread
 * cannot fire until the work it was meant to bound has already completed, so
 * an in-process timeout is not a timeout at all; it is an after-the-fact
 * report.
 *
 * That matters because the input is hostile by assumption and the size cap
 * bounds bytes, not work. Measured against this runtime, a 14.3 MiB encrypted
 * document built from 800,000 tiny indirect objects — comfortably inside the
 * 16 MiB cap — spends more than five seconds inside a single `callMain`. Object
 * count, not file size, is what that costs, and nothing bounds object count.
 * Run in the server process, that is five seconds during which every tool is
 * unavailable, and it is a lower bound rather than a limit.
 *
 * A worker thread is the smallest construct that fixes it. `worker.terminate()`
 * goes through V8's execution terminator, which interrupts WebAssembly at its
 * stack-guard checks rather than waiting for the call to return, so the parent
 * can enforce a real wall-clock deadline. Measured against that document,
 * deadlines of 100 ms, 250 ms, 1 s, 2.5 s and 4 s each land within 60 ms of
 * themselves, and the process then consumes under 1 ms of further CPU over the
 * following 2 seconds — against the 4 seconds of CPU the same decrypt burns
 * when it is allowed to finish. The work is killed, not abandoned.
 *
 * ## Where the plaintext lives
 *
 * In this process, and only in this process. The decrypted bytes are copied out
 * of the WebAssembly heap into a standalone `ArrayBuffer` and handed to the
 * parent through `postMessage`'s transfer list, which reassigns ownership of
 * the same pages rather than serializing them: no copy, no pipe, no file, no
 * process boundary. That is deliberate. Routing this through the existing
 * pdf-lib child process would have forced the plaintext across a real process
 * boundary — through a pipe or a staged temporary file — which is exactly the
 * property the original design set out to avoid.
 *
 * The ciphertext and the password arrive by the same route and are zeroed here
 * before the worker is torn down. As the wrapper's header says, that shortens
 * the window rather than closing it: the WebAssembly heap holds its own copies
 * of everything QPDF touched. Destroying the thread does put those copies
 * beyond reach of anything still running in the process, which the in-process
 * arrangement could not promise — but it does not hand the pages back to the
 * operating system, and the wrapper's header has the measurements that say so.
 * Termination is bought for the deadline, not for the memory.
 *
 * ## What this module is not allowed to decide
 *
 * Nothing. The password rules, the permission rules, the size cap and every
 * caller-visible message live in `server/qpdf-decrypt.js`. This module runs the
 * two QPDF invocations that module asks for, reports facts, and maps failures
 * to opaque reason codes. It never composes a message for a user, because QPDF
 * prefixes its diagnostics with `argv[0]` and echoes the virtual paths below.
 */

import { parentPort, workerData } from "node:worker_threads";

const QPDF_RUNTIME_RELATIVE_PATH = "../vendor/qpdf-wasm/runtime/qpdf.mjs";

// Fixed paths inside the module's private in-memory filesystem. A fresh module
// is created for every QPDF invocation, and a fresh worker for every request,
// so these never collide.
const VIRTUAL_INPUT_PATH = "/in.pdf";
const VIRTUAL_OUTPUT_PATH = "/out.pdf";
const VIRTUAL_PASSWORD_PATH = "/pw";

// The JSON inspection output is a few hundred bytes; QPDF diagnostics are a
// few lines. Anything beyond this means the runtime is not behaving as built.
const QPDF_OUTPUT_BYTE_CAP = 64 * 1024;

/*
 * QPDF's documented exit codes. 3 means the operation completed but the file
 * needed recovery — a damaged cross-reference table, a stream whose declared
 * length was wrong, and so on. Real-world PDFs produce it often enough that
 * rejecting it would make this feature fail on documents QPDF read perfectly
 * well. It is accepted only when output was actually produced, and the
 * recovered document then still has to survive pdf-lib's parse and the page-
 * tree validation, so accepting a warning is not accepting a broken document.
 *
 * 2 is a genuine error, and includes the one case that must stay
 * distinguishable: a password the document did not accept.
 */
const QPDF_EXIT_SUCCESS = 0;
const QPDF_EXIT_WARNINGS = 3;
const qpdfCompleted = status => status === QPDF_EXIT_SUCCESS || status === QPDF_EXIT_WARNINGS;

/*
 * QPDF's own wording for a password that matched neither the user nor the
 * owner password. Matched here only, to tell "this needs a password you did not
 * give" apart from "this file is broken" — advice that would otherwise be wrong
 * half the time. The matched text never leaves this thread. If the wording ever
 * changes the classification falls back to the malformed reason, which is the
 * safe direction: it never claims a password would help.
 */
const QPDF_INVALID_PASSWORD_DIAGNOSTIC = "invalid password";

/** Raised for a condition the parent has a fixed message for. */
class WorkerDecryptionFailure extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Collects a QPDF output stream under a hard byte cap. The captured text is
 * used only to parse the inspection JSON and to classify a failure; it is never
 * sent to the parent.
 */
function boundedCapture() {
  const lines = [];
  let bytes = 0;
  let overflowed = false;
  return {
    write(line) {
      const text = String(line);
      bytes += Buffer.byteLength(text, "utf8") + 1;
      if (bytes > QPDF_OUTPUT_BYTE_CAP) {
        overflowed = true;
        return;
      }
      lines.push(text);
    },
    get overflowed() {
      return overflowed;
    },
    text() {
      return lines.join("\n");
    },
  };
}

/**
 * Builds the password file contents. QPDF's `--password-file` reads the first
 * line, which keeps the password out of `argv` — where it would otherwise be
 * visible to anything that can read the process's command line, and would be
 * echoed back by QPDF's own usage diagnostics.
 *
 * The line-break rejection is the parent's rule and the parent applies it
 * before a worker is ever started, so a password reaching this point should
 * already be representable. It is re-checked rather than assumed because the
 * failure it prevents is a silent truncation reported as a wrong password.
 */
function passwordFileBytes(password) {
  if (/[\r\n]/.test(password)) {
    throw new WorkerDecryptionFailure("password_unrepresentable");
  }
  return Buffer.from(`${password}\n`, "utf8");
}

let runtimeFactoryPromise = null;

/**
 * Resolves the runtime's ESM factory once per worker. The factory is just a
 * function; each call below still instantiates its own module, so no QPDF
 * state, filesystem entry, or password crosses between the two invocations.
 *
 * The specifier is computed rather than literal so that test-time bundlers
 * leave the Emscripten output alone: it resolves its own `.wasm` sibling from
 * `import.meta.url` and has to be loaded as a plain Node module. The path is
 * identical in the checkout, the MCPB and the share ZIP, so this resolves the
 * same way in all three. A worker thread loads it through Node's own loader in
 * every one of those hosts, which is a plainer path than the main thread had.
 */
async function loadQpdfFactory() {
  if (!runtimeFactoryPromise) {
    const runtimeUrl = new URL(QPDF_RUNTIME_RELATIVE_PATH, import.meta.url).href;
    runtimeFactoryPromise = import(runtimeUrl).then(module => {
      if (typeof module.default !== "function") {
        throw new WorkerDecryptionFailure("runtime_unavailable");
      }
      return module.default;
    });
    runtimeFactoryPromise.catch(() => {});
  }
  return runtimeFactoryPromise;
}

/**
 * Runs one QPDF invocation in its own freshly instantiated module and tears it
 * down afterwards. Returns the exit status, the captured stdout, the captured
 * stderr, and the requested output file if the run produced one.
 *
 * The module, its `FS`, and its raw exports never leave this function: the
 * vendored runtime's README is explicit that callers must be given a narrow
 * operation API rather than the module or its filesystem. Nothing this module
 * sends to the parent carries either.
 */
async function runQpdf(args, inputs, outputPath = null) {
  const createQpdf = await loadQpdfFactory();
  const stdout = boundedCapture();
  const stderr = boundedCapture();
  let qpdf = null;
  let status;
  let output = null;
  try {
    qpdf = await createQpdf({
      print: line => stdout.write(line),
      printErr: line => stderr.write(line),
    });
    for (const [virtualPath, bytes] of Object.entries(inputs)) {
      qpdf.FS.writeFile(virtualPath, bytes);
    }
    try {
      status = qpdf.callMain([...args]);
    } catch (error) {
      // Emscripten reports a normal `exit()` by throwing an object carrying
      // the status. Anything without an integer status is a real fault.
      if (!Number.isInteger(error?.status)) {
        throw new WorkerDecryptionFailure("qpdf_faulted");
      }
      status = error.status;
    }
    if (qpdfCompleted(status) && outputPath) {
      // Copied into an ArrayBuffer this thread owns outright. What `FS.readFile`
      // returns may be a view onto the WebAssembly heap, which cannot be
      // transferred and must not be handed out even if it could be.
      const raw = qpdf.FS.readFile(outputPath);
      output = new Uint8Array(raw.length);
      output.set(raw);
    }
  } catch (error) {
    if (error instanceof WorkerDecryptionFailure) throw error;
    throw new WorkerDecryptionFailure("qpdf_faulted");
  } finally {
    // Overwrite then unlink every virtual file, so the ciphertext, the
    // password and any plaintext output stop being reachable through this
    // module before it is dropped. Best effort by nature: the WebAssembly heap
    // keeps its own copies until this thread is destroyed, which — unlike the
    // in-process arrangement this replaced — is something that then happens.
    if (qpdf) {
      for (const virtualPath of [...Object.keys(inputs), ...(outputPath ? [outputPath] : [])]) {
        try {
          const existing = qpdf.FS.readFile(virtualPath);
          qpdf.FS.writeFile(virtualPath, new Uint8Array(existing.length));
          qpdf.FS.unlink(virtualPath);
        } catch {
          // The file may never have been created, or QPDF may have removed it.
        }
      }
    }
    qpdf = null;
  }
  if (stdout.overflowed || stderr.overflowed) {
    throw new WorkerDecryptionFailure("qpdf_output_overflow");
  }
  return { status, stdout: stdout.text(), stderr: stderr.text(), output };
}

/**
 * Reads the document's encryption state and effective permissions without
 * producing any decrypted output. Returns only the four facts the parent's
 * rules are written against.
 */
async function inspectEncryption(pdfBytes, password) {
  const { status, stdout, stderr } = await runQpdf(
    [
      "--json=latest",
      "--json-key=encrypt",
      `--password-file=${VIRTUAL_PASSWORD_PATH}`,
      VIRTUAL_INPUT_PATH,
    ],
    {
      [VIRTUAL_INPUT_PATH]: pdfBytes,
      [VIRTUAL_PASSWORD_PATH]: passwordFileBytes(password ?? ""),
    },
  );
  if (!qpdfCompleted(status)) {
    // QPDF does not fall back to the empty password when a wrong one is given,
    // so a supplied-but-wrong password fails here rather than opening the
    // document by way of an empty user password. A malformed file fails here
    // too, and must not be reported as needing a password. Which of the two
    // password reasons applies depends on whether one was supplied, and that
    // is the parent's call, so both collapse to one code here.
    throw new WorkerDecryptionFailure(
      stderr.toLowerCase().includes(QPDF_INVALID_PASSWORD_DIAGNOSTIC)
        ? "password_not_accepted"
        : "unreadable_document",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout)?.encrypt;
  } catch {
    throw new WorkerDecryptionFailure("malformed_inspection");
  }
  if (
    !parsed
    || typeof parsed.encrypted !== "boolean"
    || typeof parsed.ownerpasswordmatched !== "boolean"
    || typeof parsed.userpasswordmatched !== "boolean"
    || !parsed.capabilities
    || typeof parsed.capabilities.extract !== "boolean"
  ) {
    throw new WorkerDecryptionFailure("malformed_inspection");
  }
  return {
    encrypted: parsed.encrypted,
    ownerPasswordMatched: parsed.ownerpasswordmatched,
    userPasswordMatched: parsed.userpasswordmatched,
    capabilities: parsed.capabilities,
  };
}

/** Produces the decrypted document. */
async function decrypt(pdfBytes, password) {
  const { status, output } = await runQpdf(
    [
      `--password-file=${VIRTUAL_PASSWORD_PATH}`,
      "--decrypt",
      VIRTUAL_INPUT_PATH,
      VIRTUAL_OUTPUT_PATH,
    ],
    {
      [VIRTUAL_INPUT_PATH]: pdfBytes,
      [VIRTUAL_PASSWORD_PATH]: passwordFileBytes(password ?? ""),
    },
    VIRTUAL_OUTPUT_PATH,
  );
  if (!qpdfCompleted(status) || !output || output.length === 0) {
    throw new WorkerDecryptionFailure("decrypt_failed");
  }
  return output;
}

/*
 * The request. One worker serves exactly one document, so the ciphertext and
 * the password arrive once, in `workerData`, and both phases read them from
 * here.
 *
 * The parent transfers the ciphertext rather than cloning it, so these bytes
 * are the parent's own copy of the file, moved. The parent made that copy
 * precisely so the caller's on-disk bytes are never detached out from under it.
 */
const ciphertext = new Uint8Array(workerData.ciphertext);
const password = workerData.password;

function zeroRequest() {
  ciphertext.fill(0);
}

/**
 * Phase one runs immediately: the parent cannot apply its permission rules
 * until it has the encryption facts, and it does not decrypt anything it is
 * going to refuse.
 *
 * Phase two waits for the parent to say yes. If the answer is no — refused, or
 * the deadline expired — the parent terminates this thread and nothing further
 * runs here.
 */
async function main() {
  const encryption = await inspectEncryption(ciphertext, password);

  // The listener goes on before the report goes out, so the parent's answer
  // cannot arrive at a port that is not yet listening for it.
  const permission = new Promise((resolve, reject) => {
    parentPort.once("message", message => {
      if (message?.kind === "decrypt") resolve();
      else reject(new WorkerDecryptionFailure("protocol_violation"));
    });
  });
  parentPort.postMessage({ kind: "inspected", encryption });
  await permission;

  const plaintext = await decrypt(ciphertext, password);
  zeroRequest();
  // Transferred, not cloned: ownership of these exact pages moves to the
  // parent and this thread's reference is detached. There is no second copy to
  // wipe, and nothing is serialized.
  parentPort.postMessage({ kind: "decrypted", plaintext: plaintext.buffer }, [plaintext.buffer]);
}

main().catch(error => {
  zeroRequest();
  parentPort.postMessage({
    kind: "failed",
    reason: error instanceof WorkerDecryptionFailure ? error.reason : "qpdf_faulted",
  });
});
