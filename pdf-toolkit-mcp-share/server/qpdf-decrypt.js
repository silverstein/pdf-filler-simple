/**
 * Decryption of encrypted PDFs for the read-only tools, and the only module
 * under `server/` that loads the vendored QPDF WebAssembly runtime.
 *
 * pdf-lib 1.17.1 cannot decrypt anything, so every tool that reads through it
 * fails on an encrypted document no matter what password the caller supplies.
 * This module gives three of those tools — `read_pdf_fields`, `validate_pdf`
 * and `extract_to_csv` — a way through. All three only ever read: none of them
 * writes a PDF back, so nothing here can re-encrypt a document, change its
 * protection, or persist a decrypted copy.
 *
 * ## What this deliberately does not do
 *
 * It is not a "remove the password" facility. QPDF will decrypt an
 * owner-locked document — one that opens with an empty user password but whose
 * `/P` denies modification — without any password at all, and will re-lock it
 * afterwards with an identical `/P` and `/R`. Shipping that shape would make
 * PDF Tools a permissions-circumvention tool. So decryption is gated twice:
 *
 *   - a caller who supplies a password that the document accepts is acting on
 *     a credential they already hold, and proceeds; but
 *   - a caller who supplies none, and merely benefits from the document's
 *     empty user password, proceeds only if the document's own `/P` grants the
 *     permission the operation needs, and is otherwise refused by name.
 *
 * The empty string counts as *no password*, so the check above cannot be
 * sidestepped by passing `""` to a document whose user password is empty.
 *
 * ## Which permission bit
 *
 * All three tools require `extract` — `/P` bit 5, "copy or otherwise extract
 * text and graphics". Every one of them copies document content out of the
 * document: `read_pdf_fields` returns field names and their current values,
 * `validate_pdf` reports field names and whether each is filled, and
 * `extract_to_csv` writes field values to a CSV file on disk. That is
 * extraction under any reading of the bit.
 *
 * Two nearby bits are deliberately *not* accepted as substitutes:
 *
 *   - `accessibility` (bit 10) is almost always granted and would make the
 *     check vacuous. It authorizes extraction for assistive technology, and
 *     nothing here can establish that the caller is assistive technology.
 *   - `modifyforms` (bit 9) authorizes filling a form, not reading what is
 *     already in it. A document may permit filling while denying extraction,
 *     and honouring `modifyforms` here would hand back the values that
 *     `extract` was set to withhold.
 *
 * ## Memory
 *
 * QPDF-WASM costs roughly 16x the input size plus a ~45 MB baseline, and the
 * WebAssembly heap is not reliably returned to the OS within the process.
 * Encrypted inputs therefore get their own explicit, much lower size cap
 * (`PDF_ENCRYPTED_MAX_FILE_BYTES`) instead of the 250 MiB mutation cap, and
 * oversized ones are refused with a size message rather than being allowed to
 * run into an out-of-memory kill. See the constant for the measurements.
 *
 * ## Plaintext handling
 *
 * Decrypted bytes exist only in memory and are never written to disk. The
 * caller gets a `release()` and must call it once it has finished reading the
 * loaded document. Be honest about what that buys: `release()` overwrites the
 * Node buffer it handed out, but JavaScript cannot guarantee erasure. The
 * WebAssembly heap holds its own copies that only the module's own teardown
 * reclaims, the garbage collector may already have copied the buffer, and any
 * of those pages may have been written to swap. This reduces the window in
 * which plaintext is readable in the process; it does not eliminate it.
 */

const QPDF_RUNTIME_RELATIVE_PATH = "../vendor/qpdf-wasm/runtime/qpdf.mjs";

// Fixed paths inside the module's private in-memory filesystem. A fresh module
// is created for every QPDF invocation, so these never collide across calls.
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

/**
 * The per-file ceiling for an encrypted input, deliberately separate from and
 * far below `PDF_MUTATION_MAX_FILE_BYTES` (250 MiB), which must not govern
 * this path.
 *
 * Measured against this runtime on macOS/arm64, decrypting costs a peak RSS of
 * roughly `16 x input + 45 MB`:
 *
 *   |  input | peak RSS delta |
 *   | -----: | -------------: |
 *   | 1.0 MB |          52 MB |
 *   | 7.3 MB |         162 MB |
 *   | 14.6MB |         272 MB |
 *   | 29.2MB |         472 MB |
 *
 * At 16 MiB the decrypt peak is about 300 MB, and the plaintext then has to be
 * parsed by pdf-lib on top of that, landing the whole read comfortably inside
 * the 1024 MiB that `PDF_LIB_RSS_MAXIMUM_BYTES` already treats as the point
 * where a PDF operation has consumed too much. Doubling the cap to 32 MiB
 * would put the decrypt alone near 560 MB and the full read past 700 MB, with
 * no useful margin; that is the reason for the specific number rather than a
 * rounder, larger one.
 *
 * Repeated decryption within one process was measured not to accumulate: RSS
 * plateaus near the high-water mark of the single largest input rather than
 * summing, so a per-file cap is sufficient and `extract_to_csv` does not need
 * an additional aggregate bound.
 */
export const PDF_ENCRYPTED_MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * The operations allowed to decrypt, and the `/P` capability each one needs
 * when the caller supplied no password. Adding an entry here is a security
 * decision: it grants a tool the ability to read encrypted documents.
 */
export const ENCRYPTED_READ_OPERATIONS = Object.freeze({
  read_pdf_fields: Object.freeze({
    capability: "extract",
    activity: "read its form fields and their values",
  }),
  validate_pdf: Object.freeze({
    capability: "extract",
    activity: "report which of its form fields are filled",
  }),
  extract_to_csv: Object.freeze({
    capability: "extract",
    activity: "extract its form data to a CSV file",
  }),
});

/** Human-readable names for the `/P` capabilities this module can require. */
const CAPABILITY_LABELS = Object.freeze({
  extract: "content copying and extraction",
});

export const PDF_ENCRYPTED_FILE_LIMIT_MESSAGE =
  `Encrypted PDF exceeds the ${PDF_ENCRYPTED_MAX_FILE_BYTES / (1024 * 1024)} MiB limit for `
  + "decryption. Decrypting a PDF costs about 16 times its size in memory, so encrypted inputs "
  + "have a lower size limit than unencrypted ones. Decrypt the file first (for example with "
  + "qpdf) and retry with the decrypted copy.";

export const PDF_PASSWORD_REJECTED_MESSAGE =
  "The password was not accepted: this PDF is encrypted, and the supplied password matches "
  + "neither its user password nor its owner password. Check the password and retry.";

export const PDF_PASSWORD_REQUIRED_MESSAGE =
  "This PDF is encrypted and cannot be opened without a password. Supply the document's "
  + "password in the 'password' parameter and retry.";

export const PDF_PASSWORD_UNREPRESENTABLE_MESSAGE =
  "This password cannot be used: it contains a line break. Passwords are handed to the decryption "
  + "engine through a single-line password file, never on a command line, so a password containing "
  + "a carriage return or newline cannot be represented. Remove the line break and retry.";

export const PDF_DECRYPTION_FAILED_MESSAGE =
  "This PDF is encrypted and could not be decrypted: the document is malformed, incomplete, or "
  + "uses an encryption scheme this build does not support.";

/**
 * Refusal text for the owner-locked case. Names the denied permission, says
 * plainly that no password was supplied, and points at the one legitimate way
 * forward, without ever suggesting a way around the restriction.
 */
export function pdfPermissionDeniedMessage(operation) {
  const { activity, capability } = ENCRYPTED_READ_OPERATIONS[operation];
  const label = CAPABILITY_LABELS[capability];
  return `This PDF is encrypted and its permissions deny ${label} (/P '${capability}'), so `
    + `PDF Tools will not ${activity}. It opens without a password, but that does not grant the `
    + "denied permission, and PDF Tools does not override a document's own restrictions. "
    + "If you hold the owner password, supply it in the 'password' parameter and retry.";
}

/**
 * Parameter text for the three tools that can now decrypt. Replaces
 * `PDF_LIB_UNUSABLE_PASSWORD_DESCRIPTION`, which is false for exactly these.
 */
export const PDF_DECRYPTABLE_PASSWORD_DESCRIPTION =
  "Password for an encrypted PDF. Supply the user or owner password and the document is "
  + `decrypted in memory to complete this read (encrypted inputs are limited to `
  + `${PDF_ENCRYPTED_MAX_FILE_BYTES / (1024 * 1024)} MiB). Leave it unset for an unencrypted `
  + "document. An encrypted document that opens without a password is still read only if its "
  + "own permissions allow content extraction; PDF Tools does not override them.";

export class PdfDecryptionError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "PdfDecryptionError";
    this.reason = reason;
  }
}

/**
 * Collects a QPDF output stream under a hard byte cap. The captured text is
 * used only to parse the inspection JSON and is never surfaced to a caller:
 * QPDF prefixes its diagnostics with `argv[0]` and echoes virtual paths, so
 * every failure below maps to a fixed message instead.
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
 */
function passwordFileBytes(password) {
  // QPDF reads the first line of the file, so a password containing a line
  // break would be silently truncated and then reported as "not accepted" —
  // a confusing lie. Refuse it explicitly instead.
  if (/[\r\n]/.test(password)) {
    throw new PdfDecryptionError("password_unrepresentable", PDF_PASSWORD_UNREPRESENTABLE_MESSAGE);
  }
  return Buffer.from(`${password}\n`, "utf8");
}

/**
 * A password is "supplied" only if it is a non-empty string.
 *
 * The empty string is treated as absent because it is exactly the credential
 * an owner-locked document accepts: counting it as "supplied" would let any
 * caller claim credentialed access to a document whose user password is empty
 * and skip the `/P` check entirely.
 *
 * Whitespace is *not* trimmed. A password of `" "` is unusual but legitimate,
 * and it needs no special handling to be safe: it is not the empty password,
 * so QPDF rejects it on a document that expects one, and the caller gets an
 * honest "not accepted" instead of a silent permission check.
 */
export function normalizeSuppliedPassword(password) {
  if (password === null || password === undefined) return null;
  if (typeof password !== "string") {
    throw new TypeError("PDF password must be a string.");
  }
  return password === "" ? null : password;
}

let runtimeFactoryPromise = null;

/**
 * Whether this process has ever asked for the QPDF runtime. Exists so the
 * "an unencrypted document pays nothing" property can be asserted as a fact
 * rather than as a claim in a comment. It exposes no capability.
 */
export function isQpdfRuntimeLoaded() {
  return runtimeFactoryPromise !== null;
}

/*
 * Decryptions run one at a time.
 *
 * The size cap is derived from the peak cost of a *single* decrypt. The MCP
 * server does not serialize tool calls, so without this two concurrent
 * encrypted reads would each be allowed 16 MiB and the budget the cap was
 * calculated against would be wrong by a factor of the concurrency. Queueing
 * makes the measured single-operation peak the real ceiling no matter how many
 * callers arrive at once.
 *
 * A queued caller waits rather than fails: at the cap a decrypt is on the order
 * of a second, which is a far better outcome than an out-of-memory kill that
 * takes the whole server down. The queue never rejects, so one failing
 * operation cannot poison the chain for the next.
 */
let decryptionQueue = Promise.resolve();

function queueDecryption(operation) {
  const result = decryptionQueue.then(operation, operation);
  decryptionQueue = result.then(() => {}, () => {});
  return result;
}

/**
 * Resolves the runtime's ESM factory once per process. The factory is just a
 * function; each call below still instantiates its own module, so no QPDF
 * state, filesystem entry, or password crosses between requests.
 *
 * The specifier is computed rather than literal so that test-time bundlers
 * leave the Emscripten output alone: it resolves its own `.wasm` sibling from
 * `import.meta.url` and has to be loaded as a plain Node module. The path is
 * identical in the checkout, the MCPB and the share ZIP, so this resolves the
 * same way in all three.
 */
async function loadQpdfFactory() {
  if (!runtimeFactoryPromise) {
    const runtimeUrl = new URL(QPDF_RUNTIME_RELATIVE_PATH, import.meta.url).href;
    runtimeFactoryPromise = import(runtimeUrl).then(module => {
      if (typeof module.default !== "function") {
        throw new PdfDecryptionError("runtime_unavailable", PDF_DECRYPTION_FAILED_MESSAGE);
      }
      return module.default;
    });
    runtimeFactoryPromise.catch(() => {});
  }
  return runtimeFactoryPromise;
}

/**
 * Runs one QPDF invocation in its own freshly instantiated module and tears it
 * down afterwards. Returns the exit status, the captured stdout, and the
 * requested output file if the run produced one.
 *
 * The module, its `FS`, and its raw exports never leave this function: the
 * vendored runtime's README is explicit that callers must be given a narrow
 * operation API rather than the module or its filesystem.
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
        throw new PdfDecryptionError("qpdf_faulted", PDF_DECRYPTION_FAILED_MESSAGE);
      }
      status = error.status;
    }
    if (qpdfCompleted(status) && outputPath) {
      output = Buffer.from(qpdf.FS.readFile(outputPath));
    }
  } catch (error) {
    if (error instanceof PdfDecryptionError) throw error;
    throw new PdfDecryptionError("qpdf_faulted", PDF_DECRYPTION_FAILED_MESSAGE);
  } finally {
    // Overwrite then unlink every virtual file, so the ciphertext, the
    // password and any plaintext output stop being reachable through this
    // module before it is dropped. Best effort by nature: the WebAssembly heap
    // keeps its own copies until the module itself is collected.
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
    throw new PdfDecryptionError("qpdf_output_overflow", PDF_DECRYPTION_FAILED_MESSAGE);
  }
  return { status, stdout: stdout.text(), stderr: stderr.text(), output };
}

/*
 * QPDF's own wording for a password that matched neither the user nor the
 * owner password. Matched internally only, to tell "this needs a password you
 * did not give" apart from "this file is broken" — advice that would otherwise
 * be wrong half the time. The matched text is never surfaced: QPDF prefixes
 * its diagnostics with argv[0] and echoes the virtual input path. If the
 * wording ever changes the classification falls back to the malformed message,
 * which is the safe direction: it never claims a password would help.
 */
const QPDF_INVALID_PASSWORD_DIAGNOSTIC = "invalid password";

/**
 * Reads the document's encryption state and effective permissions without
 * producing any decrypted output.
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
    // too, and must not be reported as needing a password.
    if (!stderr.toLowerCase().includes(QPDF_INVALID_PASSWORD_DIAGNOSTIC)) {
      throw new PdfDecryptionError("unreadable_document", PDF_DECRYPTION_FAILED_MESSAGE);
    }
    throw new PdfDecryptionError(
      password === null ? "password_required" : "password_rejected",
      password === null ? PDF_PASSWORD_REQUIRED_MESSAGE : PDF_PASSWORD_REJECTED_MESSAGE,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout)?.encrypt;
  } catch {
    throw new PdfDecryptionError("malformed_inspection", PDF_DECRYPTION_FAILED_MESSAGE);
  }
  if (
    !parsed
    || typeof parsed.encrypted !== "boolean"
    || typeof parsed.ownerpasswordmatched !== "boolean"
    || typeof parsed.userpasswordmatched !== "boolean"
    || !parsed.capabilities
    || typeof parsed.capabilities.extract !== "boolean"
  ) {
    throw new PdfDecryptionError("malformed_inspection", PDF_DECRYPTION_FAILED_MESSAGE);
  }
  return {
    encrypted: parsed.encrypted,
    ownerPasswordMatched: parsed.ownerpasswordmatched,
    userPasswordMatched: parsed.userpasswordmatched,
    capabilities: parsed.capabilities,
  };
}

/**
 * Decrypts an encrypted PDF for one of the read-only operations, subject to
 * the size cap, the password rules and the permission rules documented above.
 *
 * Returns `{ plaintext, encryption, release }`. The caller owns `release()`
 * and must call it once it has finished reading the document that was loaded
 * from `plaintext`.
 *
 * @param {Buffer} pdfBytes  The encrypted file exactly as it is on disk.
 * @param {string|null} password  The caller-supplied password, if any.
 * @param {string} operation  A key of `ENCRYPTED_READ_OPERATIONS`.
 */
export async function decryptPdfForRead(pdfBytes, password, operation) {
  return queueDecryption(() => decryptPdfForReadExclusively(pdfBytes, password, operation));
}

/** The body of `decryptPdfForRead`, run with the decryption queue held. */
async function decryptPdfForReadExclusively(pdfBytes, password, operation) {
  const rules = ENCRYPTED_READ_OPERATIONS[operation];
  if (!rules) {
    throw new TypeError(`Operation '${operation}' is not permitted to decrypt PDFs.`);
  }
  if (!Buffer.isBuffer(pdfBytes) && !(pdfBytes instanceof Uint8Array)) {
    throw new TypeError("Encrypted PDF bytes must be a Buffer or Uint8Array.");
  }
  const suppliedPassword = normalizeSuppliedPassword(password);

  // Checked before anything is instantiated, so an oversized input costs a
  // length comparison rather than an out-of-memory kill.
  if (pdfBytes.length > PDF_ENCRYPTED_MAX_FILE_BYTES) {
    throw new PdfDecryptionError("encrypted_input_too_large", PDF_ENCRYPTED_FILE_LIMIT_MESSAGE);
  }

  const encryption = await inspectEncryption(pdfBytes, suppliedPassword);
  if (!encryption.encrypted) {
    // pdf-lib refused this document as encrypted but QPDF sees no encryption
    // dictionary. The two disagree about what the file is, so decrypting it
    // would be guessing.
    throw new PdfDecryptionError("encryption_state_disagreement", PDF_DECRYPTION_FAILED_MESSAGE);
  }

  const credentialed = suppliedPassword !== null
    && (encryption.ownerPasswordMatched || encryption.userPasswordMatched);
  if (!credentialed && encryption.capabilities[rules.capability] !== true) {
    throw new PdfDecryptionError(
      "permission_denied",
      pdfPermissionDeniedMessage(operation),
    );
  }

  const { status, output } = await runQpdf(
    [
      `--password-file=${VIRTUAL_PASSWORD_PATH}`,
      "--decrypt",
      VIRTUAL_INPUT_PATH,
      VIRTUAL_OUTPUT_PATH,
    ],
    {
      [VIRTUAL_INPUT_PATH]: pdfBytes,
      [VIRTUAL_PASSWORD_PATH]: passwordFileBytes(suppliedPassword ?? ""),
    },
    VIRTUAL_OUTPUT_PATH,
  );
  if (!qpdfCompleted(status) || !output || output.length === 0) {
    throw new PdfDecryptionError("decrypt_failed", PDF_DECRYPTION_FAILED_MESSAGE);
  }

  let released = false;
  return {
    plaintext: output,
    encryption,
    release() {
      if (released) return;
      released = true;
      // See the module header: this shortens the window in which plaintext is
      // readable in this process. It cannot guarantee erasure.
      output.fill(0);
    },
  };
}
