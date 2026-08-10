/**
 * Decryption of encrypted PDFs for the read-only tools: the size cap, the
 * password rules, the permission rules, the queue, the deadline, and every
 * message a caller can see.
 *
 * The QPDF runtime itself is not loaded here. It runs in a worker thread —
 * `server/qpdf-decrypt-worker.js`, the only module in the tree that loads it —
 * which this module starts, drives, bounds and destroys. See that file for why
 * the work cannot run on the server's own thread; see below for what this
 * module decides.
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
 * Both gates are evaluated here, in the server, between the worker's two
 * phases. The worker reports what the document says about itself and then
 * waits; it is told to decrypt only after this module has decided that it may.
 * A refusal is therefore a refusal to do the work, not a decision to throw the
 * result away.
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
 * QPDF-WASM costs roughly 16x the input size plus a ~45 MB baseline, which is
 * why encrypted inputs get their own explicit, much lower size cap
 * (`PDF_ENCRYPTED_MAX_FILE_BYTES`) instead of the 250 MiB mutation cap. See the
 * constant for those measurements.
 *
 * Isolation was expected to improve on that, on the theory that a heap dying
 * with its thread would be returned where an in-process collection was not. It
 * does not, and the measurements say so plainly. On macOS/arm64, after a single
 * 14.6 MiB decrypt and a forced-GC settle:
 *
 *   | arrangement | peak RSS | settled RSS | retained over baseline |
 *   | ----------- | -------: | ----------: | ---------------------: |
 *   | in-process  |   333 MB |      243 MB |                 188 MB |
 *   | worker      |   315 MB |      315 MB |                 260 MB |
 *
 * Destroying the thread returns *less* than collecting the module did: the
 * freed pages stay mapped in the process, so `terminate()` buys nothing here
 * and costs about 70 MB of resting RSS. What neither arrangement does is
 * accumulate — eight consecutive near-cap decrypts plateau at 373 MB
 * in-process and 352 MB in workers rather than summing, because each new
 * worker reuses the pages the last one released. So the per-file cap remains
 * sufficient and `extract_to_csv` still needs no aggregate bound.
 *
 * The deadline is what isolation actually buys. The memory column is a cost,
 * and a small one against the 1024 MiB budget, but it is not a saving and must
 * not be read as one; see the size constant.
 *
 * ## Plaintext handling
 *
 * Decrypted bytes exist only in memory and are never written to disk. They also
 * never leave this process: the worker is a thread, and the plaintext reaches
 * this module through `postMessage`'s transfer list, which moves ownership of
 * the same pages rather than serializing them. Nothing is copied, piped, or
 * staged to a file. That was an explicit property of the original in-process
 * design and isolation keeps it; routing decryption through the existing
 * pdf-lib *child process* instead would have given up exactly that.
 *
 * The caller gets a `release()` and must call it once it has finished reading
 * the loaded document. Be honest about what that buys: `release()` overwrites
 * the Node buffer it handed out, but JavaScript cannot guarantee erasure. The
 * garbage collector may already have copied the buffer, and any of those pages
 * may have been written to swap. This reduces the window in which plaintext is
 * readable in the process; it does not eliminate it. The WebAssembly heap's own
 * copies are a smaller problem than they were, because the thread holding them
 * is destroyed at the end of every request.
 */

import { Worker } from "node:worker_threads";

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
 * Isolation did not change any of that, and specifically did not earn a larger
 * number. The peak of a single decrypt is what this cap is derived from, and
 * the measurements in the module header put the worker's peak at 315 MB against
 * 333 MB in-process — a few percent, not a factor. Repeated decryption still
 * plateaus rather than accumulating, so `extract_to_csv` still needs no
 * aggregate bound, but that was true before as well. Raising the cap would
 * raise the peak against the same 1024 MiB budget, with nothing new to pay for
 * it.
 */
export const PDF_ENCRYPTED_MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * The wall-clock ceiling on one decryption, enforced by destroying the worker
 * thread that is running it.
 *
 * The size cap bounds input bytes; it does not bound work. QPDF's cost tracks
 * the number of objects in a document, and object count is nearly free per
 * byte: a 14.3 MiB encrypted file built from 800,000 tiny indirect objects —
 * inside the cap — takes over five seconds, and there is no honest reason to
 * believe five seconds is the worst a 16 MiB document can do.
 *
 * 30 seconds matches `DEFAULT_TIMEOUT_MS` in `server/pdf-lib-subprocess.js`,
 * which is the number this codebase already uses for "a PDF operation that has
 * not finished by now is not going to". It is generous against measurement —
 * the slowest legitimate near-cap decrypt observed is 1.6 seconds, and the
 * slowest constructed one 5.7 — and it can afford to be, because a decryption
 * that runs long no longer blocks anything. The server's own thread is free the
 * whole time; the deadline bounds how long a hostile document may occupy a
 * queue slot and a CPU, not how long the server is unresponsive.
 */
export const PDF_DECRYPTION_TIMEOUT_MS = 30_000;

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

export const PDF_DECRYPTION_TIMEOUT_MESSAGE =
  `Decrypting this PDF did not finish within ${PDF_DECRYPTION_TIMEOUT_MS / 1000} seconds and was `
  + "stopped. How long decryption takes depends on how many objects a document contains rather "
  + "than on how large it is, so a small file can still exceed the limit. Decrypt the file first "
  + "(for example with qpdf) and retry with the decrypted copy.";

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

/**
 * The deadline one request runs under.
 *
 * `timeoutMs` exists for tests, which need to watch the deadline fire without
 * waiting out the real one. It can only ever tighten: anything larger than
 * `PDF_DECRYPTION_TIMEOUT_MS`, and anything that is not a usable positive
 * number, collapses to the product's own limit. There is deliberately no way
 * to grant a document more time than the product allows.
 */
export function resolveDecryptionDeadlineMs(timeoutMs) {
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, PDF_DECRYPTION_TIMEOUT_MS)
    : PDF_DECRYPTION_TIMEOUT_MS;
}

export class PdfDecryptionError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "PdfDecryptionError";
    this.reason = reason;
  }
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

const DECRYPTION_WORKER_URL = new URL("./qpdf-decrypt-worker.js", import.meta.url);

let qpdfRuntimeReached = false;
const activeDecryptionWorkers = new Set();

/**
 * Whether this process has ever started a decryption worker, and so has ever
 * reached the QPDF runtime. Exists so the "an unencrypted document pays
 * nothing" property can be asserted as a fact rather than as a claim in a
 * comment. It exposes no capability.
 *
 * It is now a stronger fact than it was. The runtime is not merely unloaded
 * until something is decrypted; the module that loads it is not on the server's
 * import graph at all, and only ever runs on another thread.
 */
export function isQpdfRuntimeLoaded() {
  return qpdfRuntimeReached;
}

/**
 * Destroys every decryption worker that is still running. Called from the
 * server's signal handlers: a worker thread keeps the process alive, and a
 * decryption that has just started should not hold a shutdown open for the
 * length of its deadline.
 */
export function terminateAllDecryptionWorkers() {
  return Promise.all([...activeDecryptionWorkers].map(async worker => {
    try {
      await worker.terminate();
    } catch {
      // Already gone.
    }
  }));
}

/**
 * The same, without waiting — for the `exit` handler, where nothing
 * asynchronous can still run.
 */
export function forceTerminateAllDecryptionWorkers() {
  for (const worker of activeDecryptionWorkers) {
    try {
      void worker.terminate();
    } catch {
      // Already gone.
    }
  }
}

/*
 * Decryptions run one at a time.
 *
 * The size cap is derived from the peak cost of a *single* decrypt. The MCP
 * server does not serialize tool calls, so without this two concurrent
 * encrypted reads would each be allowed 16 MiB and the budget the cap was
 * calculated against would be wrong by a factor of the concurrency. Queueing
 * makes the measured single-operation peak the real ceiling no matter how many
 * callers arrive at once, and it bounds the number of live worker threads to
 * one along with it.
 *
 * A queued caller waits rather than fails: at the cap a decrypt is on the order
 * of a second, which is a far better outcome than an out-of-memory kill that
 * takes the whole server down. The queue never rejects, so one failing
 * operation cannot poison the chain for the next. The deadline below is what
 * stops a hostile document from holding the queue indefinitely.
 *
 * The queue is held until the worker thread is *gone*, not until the caller has
 * its answer. Those are different moments on the success path: the plaintext
 * has already been transferred out, so the caller has no stake in the teardown,
 * while the invariant that matters — one QPDF heap alive at a time — is exactly
 * what the queue is for. Destroying a worker holding a decrypted document costs
 * a measured 55-60 ms, and settling first takes that off the critical path of
 * an idle-queue request. Back-to-back requests still pay it, in the queue,
 * which is the correct place for it.
 *
 * A `run` here returns `{ outcome, teardown }`; `outcome` is what the caller
 * gets, `teardown` is what the next caller waits on. A `run` that throws before
 * a worker exists (the size cap, an unusable password) has neither, and simply
 * rejects.
 */
let decryptionQueue = Promise.resolve();

function queueDecryption(run) {
  const started = decryptionQueue.then(run, run);
  decryptionQueue = started
    .then(result => result?.teardown, () => {})
    .then(() => {}, () => {});
  return started.then(result => result.outcome);
}

/**
 * Turns a worker reason code into the caller-visible failure. The worker never
 * composes a message: QPDF prefixes its diagnostics with `argv[0]` and echoes
 * the virtual input path, so every failure maps to one of this module's own
 * fixed strings here.
 *
 * `password_not_accepted` is the one code that splits, and it splits on
 * something only this side knows: whether the caller supplied a password at
 * all. The same QPDF failure means "you need a password" to one caller and
 * "that password is wrong" to another.
 */
function workerFailure(reason, suppliedPassword) {
  if (reason === "password_not_accepted") {
    return suppliedPassword === null
      ? new PdfDecryptionError("password_required", PDF_PASSWORD_REQUIRED_MESSAGE)
      : new PdfDecryptionError("password_rejected", PDF_PASSWORD_REJECTED_MESSAGE);
  }
  if (reason === "password_unrepresentable") {
    return new PdfDecryptionError(reason, PDF_PASSWORD_UNREPRESENTABLE_MESSAGE);
  }
  // Every remaining code — unreadable_document, malformed_inspection,
  // decrypt_failed, qpdf_faulted, qpdf_output_overflow, runtime_unavailable,
  // protocol_violation — is a "this document did not decrypt" for the caller,
  // and stays distinguishable only in `reason`.
  return new PdfDecryptionError(
    typeof reason === "string" && reason.length > 0 ? reason : "qpdf_faulted",
    PDF_DECRYPTION_FAILED_MESSAGE,
  );
}

/**
 * Runs one document through one worker thread, under one deadline.
 *
 * The worker is destroyed on every exit path, success included. That is not
 * tidiness: `worker.terminate()` is the only mechanism that stops a synchronous
 * QPDF invocation already in flight, and it is why the work is out here at all.
 *
 * Returns `{ outcome, teardown }`. A *failure* is not reported until the thread
 * is actually dead, because "the deadline stopped this" has to mean it stopped;
 * a *success* is reported as soon as the plaintext has arrived, because by then
 * the thread holds nothing anyone is waiting for. `teardown` resolves once the
 * worker is gone either way, and is what the queue holds.
 */
function runDecryptionWorker(pdfBytes, suppliedPassword, rules, operation, timeoutMs) {
  let markTornDown;
  const teardown = new Promise(resolveTeardown => { markTornDown = resolveTeardown; });
  const outcome = new Promise((resolve, reject) => {
    // An exact copy, transferred to the worker. The caller's `pdfBytes` is the
    // file as it is on disk and other code still holds it, so its backing store
    // must not be detached; and a Node Buffer may be a window onto a shared
    // pool, which must not be handed to another thread whatever the intent.
    const ciphertext = new Uint8Array(pdfBytes.byteLength);
    ciphertext.set(pdfBytes);

    let worker;
    try {
      worker = new Worker(DECRYPTION_WORKER_URL, {
        workerData: { ciphertext: ciphertext.buffer, password: suppliedPassword },
        transferList: [ciphertext.buffer],
      });
    } catch {
      markTornDown();
      reject(new PdfDecryptionError("worker_unavailable", PDF_DECRYPTION_FAILED_MESSAGE));
      return;
    }
    qpdfRuntimeReached = true;
    activeDecryptionWorkers.add(worker);

    let settled = false;
    let deadline = null;
    // Retained from the inspection phase: it is what the permission rules were
    // applied to, and the caller is entitled to see the same facts.
    let inspectedEncryption = null;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      // A success is handed over now: the plaintext is already in this thread's
      // memory and the worker's own copy was detached when it was transferred.
      if (!error) resolve(value);
      const done = () => {
        activeDecryptionWorkers.delete(worker);
        // A failure waits: `decrypt_timeout` in particular must not be reported
        // while the thread it is about is still running.
        if (error) reject(error);
        markTornDown();
      };
      let termination = null;
      try {
        termination = worker.terminate();
      } catch {
        termination = null;
      }
      if (termination && typeof termination.then === "function") termination.then(done, done);
      else done();
    };

    worker.on("message", message => {
      if (message?.kind === "inspected") {
        const { encryption } = message;
        if (!encryption?.encrypted) {
          // pdf-lib refused this document as encrypted but QPDF sees no
          // encryption dictionary. The two disagree about what the file is, so
          // decrypting it would be guessing.
          settle(new PdfDecryptionError(
            "encryption_state_disagreement",
            PDF_DECRYPTION_FAILED_MESSAGE,
          ));
          return;
        }
        const credentialed = suppliedPassword !== null
          && (encryption.ownerPasswordMatched || encryption.userPasswordMatched);
        if (!credentialed && encryption.capabilities?.[rules.capability] !== true) {
          settle(new PdfDecryptionError("permission_denied", pdfPermissionDeniedMessage(operation)));
          return;
        }
        inspectedEncryption = encryption;
        try {
          worker.postMessage({ kind: "decrypt" });
        } catch {
          settle(new PdfDecryptionError("qpdf_faulted", PDF_DECRYPTION_FAILED_MESSAGE));
        }
        return;
      }
      if (message?.kind === "decrypted") {
        // A view onto the transferred pages. No copy was made crossing the
        // boundary and none is made here.
        const plaintext = Buffer.from(message.plaintext);
        if (plaintext.length === 0) {
          settle(new PdfDecryptionError("decrypt_failed", PDF_DECRYPTION_FAILED_MESSAGE));
          return;
        }
        let released = false;
        settle(null, {
          plaintext,
          encryption: inspectedEncryption,
          release() {
            if (released) return;
            released = true;
            // See the module header: this shortens the window in which
            // plaintext is readable in this process. It cannot guarantee
            // erasure.
            plaintext.fill(0);
          },
        });
        return;
      }
      if (message?.kind === "failed") {
        settle(workerFailure(message.reason, suppliedPassword));
        return;
      }
      settle(new PdfDecryptionError("protocol_violation", PDF_DECRYPTION_FAILED_MESSAGE));
    });

    worker.once("messageerror", () => {
      settle(new PdfDecryptionError("protocol_violation", PDF_DECRYPTION_FAILED_MESSAGE));
    });
    worker.once("error", () => {
      settle(new PdfDecryptionError("worker_faulted", PDF_DECRYPTION_FAILED_MESSAGE));
    });
    worker.once("exit", () => {
      // Only reachable when the thread died without reporting: an
      // out-of-memory abort, or a fault the worker's own handler could not
      // survive. A settled request has already terminated it.
      settle(new PdfDecryptionError("worker_exited", PDF_DECRYPTION_FAILED_MESSAGE));
    });

    deadline = setTimeout(() => {
      settle(new PdfDecryptionError("decrypt_timeout", PDF_DECRYPTION_TIMEOUT_MESSAGE));
    }, timeoutMs);
    // The deadline must not be a reason for the process to stay alive; the
    // worker it is guarding already is one.
    deadline.unref();
  });
  return { outcome, teardown };
}

/**
 * Decrypts an encrypted PDF for one of the read-only operations, subject to
 * the size cap, the password rules, the permission rules and the deadline
 * documented above.
 *
 * Returns `{ plaintext, encryption, release }`. The caller owns `release()`
 * and must call it once it has finished reading the document that was loaded
 * from `plaintext`.
 *
 * @param {Buffer} pdfBytes  The encrypted file exactly as it is on disk.
 * @param {string|null} password  The caller-supplied password, if any.
 * @param {string} operation  A key of `ENCRYPTED_READ_OPERATIONS`.
 * @param {{timeoutMs?: number}} [options]  See `resolveDecryptionDeadlineMs`.
 */
export async function decryptPdfForRead(pdfBytes, password, operation, options = {}) {
  return queueDecryption(() => decryptPdfForReadExclusively(pdfBytes, password, operation, options));
}

/** The body of `decryptPdfForRead`, run with the decryption queue held. */
async function decryptPdfForReadExclusively(pdfBytes, password, operation, { timeoutMs } = {}) {
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

  // The worker hands QPDF the password through a single-line password file
  // rather than through argv, and QPDF reads the first line of it, so a
  // password containing a line break would be silently truncated and then
  // reported as "not accepted" — a confusing lie. Refuse it here, before a
  // thread is started for it.
  if (suppliedPassword !== null && /[\r\n]/.test(suppliedPassword)) {
    throw new PdfDecryptionError("password_unrepresentable", PDF_PASSWORD_UNREPRESENTABLE_MESSAGE);
  }

  return runDecryptionWorker(
    pdfBytes,
    suppliedPassword,
    rules,
    operation,
    resolveDecryptionDeadlineMs(timeoutMs),
  );
}
