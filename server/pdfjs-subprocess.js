import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

export const PDF_RESOURCE_LIMIT_CODE = "PDF_RESOURCE_LIMIT_EXCEEDED";

const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULT_BYTES = 24 * 1024 * 1024;
const DEFAULT_MAX_BINARY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_MAX_OLD_SPACE_MB = 384;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_QUEUED_OPERATIONS = 8;
const TERMINATION_GRACE_MS = 1000;
const PDFJS_OPERATIONS = new Set([
  "analyze_pages",
  "detect_signature_zones",
  "extract_layout",
  "extract_layout_for_markdown",
  "read_content",
  "read_pages",
  "render_page",
  "render_region",
  "search_text",
]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WORKER_ERROR = Symbol("pdfjs-worker-error");

let activeOperationCount = 0;
const queuedOperations = [];
const activeChildren = new Set();
const activeThreadWorkers = new Set();
const activeThreadSystemChildren = new Set();
let inProcessWorkerModulePromise = null;
let inProcessCanvasGuardInstalled = false;

export function selectPdfjsIsolationMode({
  electronVersion = process.versions.electron ?? null,
  processType = process.type ?? null,
  hasElectronParentPort = process.parentPort != null,
  executable = process.execPath,
} = {}) {
  const executableName = typeof executable === "string" ? basename(executable) : "";
  const embeddedElectronHost = typeof electronVersion === "string"
    || processType === "utility"
    || hasElectronParentPort
    || /(?:^electron$|^claude(?: helper(?: \(plugin\))?)?(?:\.exe)?$)/i.test(executableName);
  return embeddedElectronHost ? "in_process" : "subprocess";
}

const DEFAULT_ISOLATION_MODE = selectPdfjsIsolationMode();
console.error("[PDF Tools] PDF.js execution host", JSON.stringify({
  argv0: basename(process.argv0 ?? ""),
  electron: typeof process.versions.electron === "string",
  executable: basename(process.execPath),
  mode: DEFAULT_ISOLATION_MODE,
  parent_port: process.parentPort != null,
  process_type: typeof process.type === "string" ? process.type : null,
  utility_arg: [...process.execArgv, ...process.argv]
    .some(argument => /^--(?:type=utility|utility-sub-type=)/.test(argument)),
}));

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
}

function nonEmptyString(value, label, maximum = 32_768) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function validateSource(source) {
  exactKeys(
    source,
    ["canonical_path", "file_identity", "sha256", "size_bytes"],
    "PDF.js source binding",
  );
  nonEmptyString(source.canonical_path, "source.canonical_path");
  boundedInteger(source.size_bytes, "source.size_bytes", 1, 250 * 1024 * 1024);
  if (!/^[a-f0-9]{64}$/.test(source.sha256)) {
    throw new TypeError("source.sha256 must be a lowercase SHA-256 digest.");
  }
  exactKeys(source.file_identity, ["device", "inode"], "source.file_identity");
  nonEmptyString(source.file_identity.device, "source.file_identity.device", 128);
  nonEmptyString(source.file_identity.inode, "source.file_identity.inode", 128);
}

function validateRequest(request) {
  exactKeys(
    request,
    [
      "allowed_directories",
      "operation",
      "options",
      "password",
      "protocol_version",
      "source",
    ],
    "PDF.js subprocess request",
  );
  if (request.protocol_version !== PROTOCOL_VERSION) {
    throw new TypeError(`PDF.js subprocess protocol_version must be ${PROTOCOL_VERSION}.`);
  }
  if (!PDFJS_OPERATIONS.has(request.operation)) {
    throw new TypeError(`Unsupported PDF.js subprocess operation: ${request.operation}.`);
  }
  validateSource(request.source);
  if (
    !Array.isArray(request.allowed_directories)
    || request.allowed_directories.length < 1
    || request.allowed_directories.length > 64
  ) {
    throw new TypeError("allowed_directories must contain from 1 to 64 canonical directories.");
  }
  for (const [index, directory] of request.allowed_directories.entries()) {
    nonEmptyString(directory, `allowed_directories[${index}]`);
  }
  if (request.password !== null) {
    nonEmptyString(request.password, "password", 4096);
  }
  if (!request.options || typeof request.options !== "object" || Array.isArray(request.options)) {
    throw new TypeError("options must be an object.");
  }
  const encoded = Buffer.from(JSON.stringify(request), "utf8");
  if (encoded.length > MAX_REQUEST_BYTES) {
    throw new TypeError(`PDF.js subprocess request exceeds ${MAX_REQUEST_BYTES} bytes.`);
  }
  return encoded;
}

function resourceLimitError(reason, cause = null) {
  const error = new Error(
    "PDF processing exceeded its isolated resource budget. "
    + "The operation was stopped and the main PDF Tools server remains available. "
    + "Try a narrower page range, smaller render size, or a simpler PDF.",
    cause ? { cause } : undefined,
  );
  error.name = "PdfResourceLimitError";
  error.code = PDF_RESOURCE_LIMIT_CODE;
  error.reason = reason;
  return error;
}

function subprocessFailure(message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "PDFJS_SUBPROCESS_FAILED";
  return error;
}

function abortError() {
  const error = new Error("The isolated PDF operation was cancelled.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function childEnvironment(environment, platform, operationDirectory) {
  const selected = {
    PATH: environment.PATH ?? "",
    PDF_TOOLS_DISABLE_SYSTEM_RENDERER: "1",
    TEMP: operationDirectory,
    TMP: operationDirectory,
    TMPDIR: operationDirectory,
  };
  for (const name of ["HOME", "LANG", "LC_ALL"]) {
    if (typeof environment[name] === "string") selected[name] = environment[name];
  }
  if (platform === "win32") {
    for (const name of ["SystemRoot", "WINDIR"]) {
      if (typeof environment[name] === "string") selected[name] = environment[name];
    }
  }
  return selected;
}

function boundedCollector(maximumBytes, onOverflow) {
  const chunks = [];
  let bytes = 0;
  let overflowed = false;
  return {
    add(chunk) {
      const value = Buffer.from(chunk);
      const remaining = Math.max(0, maximumBytes - bytes);
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      bytes += value.length;
      if (bytes > maximumBytes && !overflowed) {
        overflowed = true;
        onOverflow();
      }
    },
    result() {
      return {
        bytes: Buffer.concat(chunks),
        observedBytes: bytes,
        overflowed,
      };
    },
  };
}

function signalChild(child, signal) {
  if (!child?.pid) return false;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function parseWorkerResponse(bytes, operation) {
  const encoded = bytes.toString("utf8");
  if (encoded.length === 0 || encoded.trim() !== encoded) {
    throw subprocessFailure("The isolated PDF worker returned an invalid response frame.");
  }
  let response;
  try {
    response = JSON.parse(encoded);
  } catch (error) {
    throw subprocessFailure("The isolated PDF worker returned an invalid response.", error);
  }
  try {
    if (response?.status === "ok") {
      exactKeys(
        response,
        ["binary", "operation", "protocol_version", "result", "status"],
        "PDF.js worker response",
      );
      if (response.protocol_version !== PROTOCOL_VERSION || response.operation !== operation) {
        throw new TypeError("The worker response does not match the request.");
      }
      if (!response.result || typeof response.result !== "object" || Array.isArray(response.result)) {
        throw new TypeError("The worker result must be an object.");
      }
      if (response.binary !== null) {
        exactKeys(response.binary, ["bytes", "mime_type", "sha256"], "PDF.js worker binary");
        boundedInteger(response.binary.bytes, "worker binary bytes", 1, DEFAULT_MAX_BINARY_BYTES);
        if (
          response.binary.mime_type !== "image/png"
          || !/^[a-f0-9]{64}$/.test(response.binary.sha256)
        ) {
          throw new TypeError("The worker binary descriptor is invalid.");
        }
      }
      return { binary: response.binary, result: response.result };
    }
    if (response?.status === "error") {
      exactKeys(
        response,
        ["error", "operation", "protocol_version", "status"],
        "PDF.js worker error",
      );
      exactKeys(response.error, ["code", "message", "name"], "PDF.js worker error detail");
      if (response.protocol_version !== PROTOCOL_VERSION || response.operation !== operation) {
        throw new TypeError("The worker error does not match the request.");
      }
      const error = new Error(nonEmptyString(response.error.message, "worker error message", 4096));
      error.name = nonEmptyString(response.error.name, "worker error name", 256);
      error[WORKER_ERROR] = true;
      if (response.error.code !== null) {
        error.code = nonEmptyString(response.error.code, "worker error code", 256);
      }
      throw error;
    }
  } catch (error) {
    if (error?.[WORKER_ERROR]) throw error;
    throw subprocessFailure("The isolated PDF worker returned an invalid response shape.", error);
  }
  throw subprocessFailure("The isolated PDF worker returned an unknown response shape.");
}

function validateThreadMessage(message, operation, maxResultBytes, maxBinaryBytes) {
  try {
    exactKeys(message, ["binary", "frame"], "PDF.js thread response");
    const encoded = Buffer.from(JSON.stringify(message.frame), "utf8");
    if (encoded.length > maxResultBytes) {
      throw resourceLimitError("worker_output_limit");
    }
    const parsed = parseWorkerResponse(encoded, operation);
    const binaryBytes = message.binary === null ? Buffer.alloc(0) : Buffer.from(message.binary);
    return parsed.binary === null
      ? parsed.result
      : {
          ...parsed.result,
          binary: validateBinaryResult(
            binaryBytes,
            parsed.binary,
            parsed.result,
            maxBinaryBytes,
          ),
        };
  } catch (error) {
    if (error?.code === PDF_RESOURCE_LIMIT_CODE || error?.code === "PDFJS_SUBPROCESS_FAILED") {
      throw error;
    }
    throw subprocessFailure("The isolated PDF worker thread returned an invalid response.", error);
  }
}

function validateBinaryResult(binaryBytes, descriptor, result, maximumBytes) {
  if (descriptor === null) {
    if (binaryBytes.length !== 0) {
      throw subprocessFailure("The isolated PDF worker returned unexpected binary output.");
    }
    return null;
  }
  if (
    descriptor.bytes !== binaryBytes.length
    || binaryBytes.length > maximumBytes
    || createHash("sha256").update(binaryBytes).digest("hex") !== descriptor.sha256
  ) {
    throw subprocessFailure("The isolated PDF worker returned mismatched binary output.");
  }
  if (
    binaryBytes.length < 24
    || !binaryBytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw subprocessFailure("The isolated PDF worker returned invalid PNG output.");
  }
  const pngWidth = binaryBytes.readUInt32BE(16);
  const pngHeight = binaryBytes.readUInt32BE(20);
  if (
    !Number.isSafeInteger(result.width)
    || !Number.isSafeInteger(result.height)
    || result.width !== pngWidth
    || result.height !== pngHeight
  ) {
    throw subprocessFailure("The isolated PDF worker returned mismatched PNG dimensions.");
  }
  return Buffer.from(binaryBytes);
}

function looksLikeHeapExhaustion(stderr) {
  return /heap out of memory|allocation failed|fatal process out of memory|reached heap limit/i.test(
    stderr.toString("utf8"),
  );
}

function removeQueuedOperation(waiter) {
  const index = queuedOperations.indexOf(waiter);
  if (index >= 0) queuedOperations.splice(index, 1);
}

function releaseOperationSlot() {
  activeOperationCount = Math.max(0, activeOperationCount - 1);
  while (queuedOperations.length > 0 && activeOperationCount < 1) {
    const waiter = queuedOperations.shift();
    if (waiter.settled) continue;
    waiter.settled = true;
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    activeOperationCount += 1;
    waiter.resolve(releaseOperationSlot);
  }
}

async function acquireOperationSlot(deadlineAt, signal) {
  if (signal?.aborted) throw abortError();
  if (activeOperationCount < 1) {
    activeOperationCount += 1;
    return releaseOperationSlot;
  }
  if (queuedOperations.length >= MAX_QUEUED_OPERATIONS) {
    throw resourceLimitError("worker_queue_limit");
  }
  return await new Promise((resolve, reject) => {
    const waiter = {
      onAbort: null,
      resolve,
      settled: false,
      signal,
      timer: null,
    };
    const rejectWaiter = error => {
      if (waiter.settled) return;
      waiter.settled = true;
      clearTimeout(waiter.timer);
      removeQueuedOperation(waiter);
      signal?.removeEventListener("abort", waiter.onAbort);
      reject(error);
    };
    waiter.onAbort = () => rejectWaiter(abortError());
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    waiter.timer = setTimeout(
      () => rejectWaiter(resourceLimitError("worker_queue_timeout")),
      Math.max(0, deadlineAt - Date.now()),
    );
    waiter.timer.unref();
    queuedOperations.push(waiter);
  });
}

async function runSpawnedWorker({
  environment,
  executable,
  maxBinaryBytes,
  maxOldSpaceMb,
  maxResultBytes,
  maxStderrBytes,
  operationDirectory,
  platform,
  request,
  requestBytes,
  signal,
  spawnProcess,
  timeoutMs,
  workerPath,
}) {
  return await new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let terminationStarted = false;
    let terminationTimer = null;
    let deadlineTimer = null;
    let spawnError = null;
    let exitCode = null;
    let exitSignal = null;
    let activeEntry = null;

    const terminate = reason => {
      if (!child || terminationStarted) return;
      terminationStarted = true;
      if (reason === "timeout") timedOut = true;
      if (reason === "abort") aborted = true;
      signalChild(child, "SIGTERM");
      terminationTimer = setTimeout(() => {
        signalChild(child, "SIGKILL");
      }, TERMINATION_GRACE_MS);
      terminationTimer.unref();
    };

    const stdout = boundedCollector(maxResultBytes, () => terminate("stdout"));
    const stderr = boundedCollector(maxStderrBytes, () => terminate("stderr"));
    const binary = boundedCollector(maxBinaryBytes, () => terminate("binary"));

    const finish = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(terminationTimer);
      signal?.removeEventListener?.("abort", onAbort);
      if (activeEntry) activeChildren.delete(activeEntry);

      const stdoutResult = stdout.result();
      const stderrResult = stderr.result();
      const binaryResult = binary.result();
      if (spawnError) {
        reject(subprocessFailure("The isolated PDF worker could not be started.", spawnError));
        return;
      }
      if (aborted) {
        reject(abortError());
        return;
      }
      if (timedOut) {
        reject(resourceLimitError("wall_timeout"));
        return;
      }
      if (stdoutResult.overflowed || stderrResult.overflowed || binaryResult.overflowed) {
        reject(resourceLimitError("worker_output_limit"));
        return;
      }
      if (exitSignal || looksLikeHeapExhaustion(stderrResult.bytes)) {
        reject(resourceLimitError("worker_memory_or_signal_limit"));
        return;
      }
      if (exitCode !== 0) {
        reject(subprocessFailure("The isolated PDF worker failed safely."));
        return;
      }
      try {
        const parsed = parseWorkerResponse(stdoutResult.bytes, request.operation);
        const validatedBinary = validateBinaryResult(
          binaryResult.bytes,
          parsed.binary,
          parsed.result,
          maxBinaryBytes,
        );
        resolve(validatedBinary === null
          ? parsed.result
          : { ...parsed.result, binary: validatedBinary });
      } catch (error) {
        reject(error);
      }
    };

    const onAbort = () => terminate("abort");

    try {
      child = spawnProcess(
        executable,
        [`--max-old-space-size=${maxOldSpaceMb}`, workerPath],
        {
          cwd: operationDirectory,
          // Stay in the enclosing host's process session. A detached worker can
          // evade host-level lifecycle and resource supervision on POSIX.
          detached: false,
          env: childEnvironment(environment, platform, operationDirectory),
          shell: false,
          stdio: ["pipe", "pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch (error) {
      spawnError = error;
      void finish();
      return;
    }

    activeEntry = { child };
    activeChildren.add(activeEntry);
    child.once("error", error => {
      spawnError = error;
      if (!child.pid) queueMicrotask(() => void finish());
    });
    child.stdout.on("data", chunk => stdout.add(chunk));
    child.stderr.on("data", chunk => stderr.add(chunk));
    if (!child.stdio[3]) {
      spawnError = subprocessFailure("The isolated PDF worker binary channel is unavailable.");
      terminate("binary");
    } else {
      child.stdio[3].on("data", chunk => binary.add(chunk));
    }
    child.once("close", (code, signalName) => {
      exitCode = code;
      exitSignal = signalName;
      void finish();
    });
    child.stdin.on("error", error => {
      if (error?.code !== "EPIPE") spawnError = spawnError || error;
    });
    child.stdin.end(requestBytes);

    signal?.addEventListener?.("abort", onAbort, { once: true });
    deadlineTimer = setTimeout(() => terminate("timeout"), timeoutMs);
    deadlineTimer.unref();
  });
}

async function runThreadWorker({
  environment,
  maxBinaryBytes,
  maxOldSpaceMb,
  maxResultBytes,
  operationDirectory,
  platform,
  request,
  signal,
  spawnProcess,
  timeoutMs,
  workerClass,
  workerPath,
}) {
  return await new Promise((resolve, reject) => {
    let worker;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let response = null;
    let workerError = null;
    let deadlineTimer = null;
    let terminationPromise = null;
    let terminationStarted = false;
    const systemChildren = new Set();

    const terminateSystemChildren = async () => {
      await Promise.all([...systemChildren].map(async child => {
        let cleanupTimer;
        const closed = new Promise((resolve, reject) => {
          child.once("close", resolve);
          cleanupTimer = setTimeout(
            () => reject(resourceLimitError("system_renderer_cleanup_unproven")),
            TERMINATION_GRACE_MS,
          );
          cleanupTimer.unref();
        });
        signalChild(child, "SIGKILL");
        try {
          await closed;
        } finally {
          clearTimeout(cleanupTimer);
        }
      }));
    };

    const runSystemCommand = message => {
      exactKeys(
        message,
        ["args", "command", "id", "kind", "timeout_ms"],
        "PDF.js system-command frame",
      );
      if (
        platform !== "darwin"
        || message.command !== "/usr/bin/sips"
        || !Array.isArray(message.args)
        || message.args.length > 128
        || message.args.some(argument => typeof argument !== "string" || argument.length > 32_768)
      ) {
        throw subprocessFailure("The PDF.js worker requested an unsupported system command.");
      }
      boundedInteger(message.id, "PDF.js system-command id", 1, 2 ** 31 - 1);
      boundedInteger(message.timeout_ms, "PDF.js system-command timeout", 100, 30_000);
      if (terminationStarted) throw abortError();
      if (systemChildren.size >= 1) {
        throw resourceLimitError("system_renderer_concurrency_limit");
      }
      return new Promise((resolveCommand, rejectCommand) => {
        let child;
        let settled = false;
        let timedOut = false;
        let outputOverflow = false;
        let childError = null;
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let deadline = null;
        const finishCommand = error => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          if (child) {
            systemChildren.delete(child);
            activeThreadSystemChildren.delete(child);
          }
          if (error) rejectCommand(error);
          else resolveCommand();
        };
        try {
          child = spawnProcess(message.command, message.args, {
            cwd: operationDirectory,
            detached: false,
            env: childEnvironment(environment, platform, operationDirectory),
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          });
        } catch (error) {
          rejectCommand(error);
          return;
        }
        systemChildren.add(child);
        activeThreadSystemChildren.add(child);
        child.stdout.on("data", chunk => {
          stdoutBytes += chunk.length;
          if (stdoutBytes > DEFAULT_MAX_STDERR_BYTES) {
            outputOverflow = true;
            signalChild(child, "SIGKILL");
          }
        });
        child.stderr.on("data", chunk => {
          stderrBytes += chunk.length;
          if (stderrBytes > DEFAULT_MAX_STDERR_BYTES) {
            outputOverflow = true;
            signalChild(child, "SIGKILL");
          }
        });
        child.once("error", error => {
          childError = error;
          if (!child.pid) finishCommand(error);
          else signalChild(child, "SIGKILL");
        });
        child.once("close", (code, signalName) => {
          if (childError) {
            finishCommand(childError);
          } else if (timedOut) {
            finishCommand(resourceLimitError("system_renderer_timeout"));
          } else if (outputOverflow) {
            finishCommand(resourceLimitError("system_renderer_output_limit"));
          } else if (code !== 0 || signalName !== null) {
            finishCommand(subprocessFailure("The macOS system PDF renderer could not render this page."));
          } else {
            finishCommand(null);
          }
        });
        deadline = setTimeout(() => {
          timedOut = true;
          signalChild(child, "SIGKILL");
        }, message.timeout_ms);
        deadline.unref();
      });
    };

    const replyToSystemCommand = (id, status, error = null) => {
      try {
        worker.postMessage({
          kind: "system_command_result",
          id,
          status,
          error: error === null
            ? null
            : {
                name: typeof error?.name === "string" ? error.name.slice(0, 256) : "Error",
                code: typeof error?.code === "string" ? error.code.slice(0, 256) : null,
                message: typeof error?.message === "string"
                  ? error.message.slice(0, 4096)
                  : "The macOS system PDF renderer could not complete this operation.",
              },
        });
      } catch {}
    };

    const finish = async code => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      signal?.removeEventListener?.("abort", onAbort);
      if (worker) activeThreadWorkers.delete(worker);
      try {
        if (terminationPromise) {
          await terminationPromise;
        } else if (systemChildren.size > 0) {
          await terminateSystemChildren();
        }
      } catch (error) {
        reject(resourceLimitError("system_renderer_cleanup_unproven", error));
        return;
      }
      if (aborted) {
        reject(abortError());
        return;
      }
      if (timedOut) {
        reject(resourceLimitError("wall_timeout"));
        return;
      }
      if (workerError?.code === "PDFJS_SUBPROCESS_FAILED") {
        reject(workerError);
        return;
      }
      if (workerError || code !== 0 || response === null) {
        reject(resourceLimitError("worker_memory_or_signal_limit", workerError));
        return;
      }
      try {
        resolve(validateThreadMessage(
          response,
          request.operation,
          maxResultBytes,
          maxBinaryBytes,
        ));
      } catch (error) {
        reject(error);
      }
    };

    const terminate = reason => {
      if (!worker || terminationStarted) return;
      terminationStarted = true;
      if (reason === "timeout") timedOut = true;
      if (reason === "abort") aborted = true;
      terminationPromise = terminateSystemChildren()
        .finally(() => worker.terminate());
    };
    const onAbort = () => terminate("abort");

    try {
      worker = new workerClass(workerPath, {
        env: childEnvironment(environment, platform, operationDirectory),
        resourceLimits: {
          maxOldGenerationSizeMb: maxOldSpaceMb,
        },
        workerData: {
          pdf_tools_worker: "pdfjs",
          request,
        },
      });
      activeThreadWorkers.add(worker);
    } catch (error) {
      reject(subprocessFailure("The isolated PDF worker thread could not be started.", error));
      return;
    }
    worker.on("message", message => {
      try {
        if (message?.kind === "system_command") {
          const id = message.id;
          void runSystemCommand(message).then(
            () => replyToSystemCommand(id, "ok"),
            error => replyToSystemCommand(id, "error", error),
          );
          return;
        }
        exactKeys(message, ["kind", "response"], "PDF.js thread message");
        if (message.kind !== "response" || response !== null) {
          throw subprocessFailure("The isolated PDF worker thread returned an invalid response sequence.");
        }
        response = message.response;
      } catch (error) {
        workerError = error?.code === "PDFJS_SUBPROCESS_FAILED"
          ? error
          : subprocessFailure(
              "The isolated PDF worker thread returned an invalid control message.",
              error,
            );
        terminate("protocol");
      }
    });
    worker.once("messageerror", error => {
      workerError = subprocessFailure(
        "The isolated PDF worker thread returned an unreadable control message.",
        error,
      );
      terminate("protocol");
    });
    worker.once("error", error => {
      workerError = error;
    });
    worker.once("exit", code => {
      void finish(code);
    });
    signal?.addEventListener?.("abort", onAbort, { once: true });
    deadlineTimer = setTimeout(() => terminate("timeout"), timeoutMs);
    deadlineTimer.unref();
  });
}

async function loadInProcessWorkerModule() {
  inProcessWorkerModulePromise ??= import("./pdfjs-worker.js");
  return await inProcessWorkerModulePromise;
}

function installInProcessCanvasNativeGuard() {
  if (inProcessCanvasGuardInstalled) return;
  inProcessCanvasGuardInstalled = true;
  const originalDlopen = process.dlopen;
  process.dlopen = function guardedDlopen(module, filename, ...args) {
    const normalizedFilename = String(filename ?? "").replaceAll("\\", "/");
    if (
      normalizedFilename.includes("/node_modules/@napi-rs/canvas")
      || /\/skia\.[^/]+\.node$/i.test(normalizedFilename)
    ) {
      const error = new Error(
        "The native canvas binding is disabled in this embedded PDF host.",
      );
      error.code = "PDFJS_EMBEDDED_NATIVE_CANVAS_DISABLED";
      throw error;
    }
    return originalDlopen.call(this, module, filename, ...args);
  };
}

async function runInProcessWorker({
  maxBinaryBytes,
  maxResultBytes,
  request,
  signal,
}) {
  // Both isolated PDF.js paths were measured to crash Claude's embedded
  // UtilityProcess. Its process.execPath is Claude Helper (Plugin) rather than
  // a Node binary, so relaunching it produced SIGTRAP helper crashes, and
  // ELECTRON_RUN_AS_NODE=1 exited 133 on a direct probe. The Node worker-thread
  // fallback made Electron create a helper process and crash as well, which is
  // specific to this library's native-canvas probe and browser-like runtime
  // classification. It is NOT a general claim that the host cannot create a
  // Node worker: PDF-lib keeps a worker_thread boundary on this same host and
  // has completed live rotate, merge, and split mutations there.
  //
  // This compatibility path retains source binding, allowed-directory checks,
  // request, path, queue, output, and binary bounds, native-canvas blocking,
  // and macOS system-child reaping. It is not a separate heap or process
  // boundary and cannot forcibly stop synchronous parser work.
  if (signal?.aborted) throw abortError();
  installInProcessCanvasNativeGuard();
  const workerModule = await loadInProcessWorkerModule();
  const operationResult = await workerModule.executePdfjsWorkerRequest(request);
  if (signal?.aborted) throw abortError();
  const encodedResult = Buffer.from(JSON.stringify(operationResult.result), "utf8");
  if (encodedResult.length > maxResultBytes) {
    throw resourceLimitError("worker_output_limit");
  }
  if (operationResult.binary === null) return operationResult.result;
  const binary = Buffer.from(operationResult.binary);
  const descriptor = {
    bytes: binary.length,
    mime_type: "image/png",
    sha256: createHash("sha256").update(binary).digest("hex"),
  };
  return {
    ...operationResult.result,
    binary: validateBinaryResult(
      binary,
      descriptor,
      operationResult.result,
      maxBinaryBytes,
    ),
  };
}

export async function runPdfjsSubprocess(request, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResultBytes = DEFAULT_MAX_RESULT_BYTES,
  maxBinaryBytes = DEFAULT_MAX_BINARY_BYTES,
  maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
  maxOldSpaceMb = DEFAULT_MAX_OLD_SPACE_MB,
  workerPath = fileURLToPath(new URL("./pdfjs-worker.js", import.meta.url)),
  executable = process.execPath,
  environment = process.env,
  platform = process.platform,
  spawnProcess = spawn,
  isolationMode = DEFAULT_ISOLATION_MODE,
  workerClass = Worker,
  signal = null,
} = {}) {
  const requestBytes = validateRequest(request);
  boundedInteger(timeoutMs, "timeoutMs", 100, 5 * 60_000);
  boundedInteger(maxResultBytes, "maxResultBytes", 1024, 64 * 1024 * 1024);
  boundedInteger(maxBinaryBytes, "maxBinaryBytes", 1024, DEFAULT_MAX_BINARY_BYTES);
  boundedInteger(maxStderrBytes, "maxStderrBytes", 1024, 1024 * 1024);
  boundedInteger(maxOldSpaceMb, "maxOldSpaceMb", 64, 4096);
  nonEmptyString(workerPath, "workerPath");
  nonEmptyString(executable, "executable");
  if (!["in_process", "subprocess", "worker_thread"].includes(isolationMode)) {
    throw new TypeError("isolationMode must be in_process, subprocess, or worker_thread.");
  }

  const deadlineAt = Date.now() + timeoutMs;
  const releaseSlot = await acquireOperationSlot(deadlineAt, signal);
  let operationDirectory = null;
  let operationError = null;
  let result;
  try {
    operationDirectory = await mkdtemp(join(tmpdir(), "pdf-tools-pdfjs-"));
    await chmod(operationDirectory, 0o700);
    if (signal?.aborted) throw abortError();
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs < 100) throw resourceLimitError("worker_queue_timeout");
    result = isolationMode === "in_process"
      ? await runInProcessWorker({
          maxBinaryBytes,
          maxResultBytes,
          request,
          signal,
        })
      : isolationMode === "worker_thread"
        ? await runThreadWorker({
          environment,
          maxBinaryBytes,
          maxOldSpaceMb,
          maxResultBytes,
          operationDirectory,
          platform,
          request,
          signal,
          spawnProcess,
          timeoutMs: remainingMs,
          workerClass,
          workerPath,
        })
      : await runSpawnedWorker({
          environment,
          executable,
          maxBinaryBytes,
          maxOldSpaceMb,
          maxResultBytes,
          maxStderrBytes,
          operationDirectory,
          platform,
          request,
          requestBytes,
          signal,
          spawnProcess,
          timeoutMs: remainingMs,
          workerPath,
        });
  } catch (error) {
    operationError = error;
  }

  let cleanupError = null;
  if (operationDirectory !== null) {
    try {
      await rm(operationDirectory, { force: true, recursive: true });
    } catch (error) {
      cleanupError = error;
    }
  }
  releaseSlot();
  if (cleanupError) {
    throw resourceLimitError("operation_directory_cleanup_unproven", cleanupError);
  }
  if (operationError) throw operationError;
  return result;
}

export function createPdfjsSubprocessRequest({
  operation,
  source,
  options = {},
  password = null,
  allowedDirectories,
}) {
  const request = {
    protocol_version: PROTOCOL_VERSION,
    operation,
    source,
    password,
    options,
    allowed_directories: allowedDirectories,
  };
  validateRequest(request);
  return request;
}

export async function terminateAllPdfjsSubprocesses() {
  const inProcessWorker = inProcessWorkerModulePromise === null
    ? null
    : await inProcessWorkerModulePromise;
  await Promise.all([
    ...[...activeChildren].map(async ({ child }) => {
      const closed = new Promise(resolve => child.once("close", resolve));
      signalChild(child, "SIGTERM");
      const escalation = setTimeout(
        () => signalChild(child, "SIGKILL"),
        TERMINATION_GRACE_MS,
      );
      escalation.unref();
      await closed;
      clearTimeout(escalation);
    }),
    ...[...activeThreadWorkers].map(worker => worker.terminate()),
    inProcessWorker?.terminateAllPdfjsWorkerSystemChildren(),
  ]);
  await Promise.all(
    [...activeThreadSystemChildren].map(async child => {
      const closed = new Promise(resolve => child.once("close", resolve));
      signalChild(child, "SIGKILL");
      await closed;
    }),
  );
}

export function forceTerminateAllPdfjsSubprocesses() {
  for (const { child } of activeChildren) {
    signalChild(child, "SIGKILL");
  }
  for (const worker of activeThreadWorkers) {
    void worker.terminate();
  }
  for (const child of activeThreadSystemChildren) {
    signalChild(child, "SIGKILL");
  }
  if (inProcessWorkerModulePromise !== null) {
    void inProcessWorkerModulePromise.then(
      worker => worker.forceTerminateAllPdfjsWorkerSystemChildren(),
      () => {},
    );
  }
}
