import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PDF_MERGE_MAX_TOTAL_BYTES,
  PDF_MUTATION_MAX_FILE_BYTES,
  hashBoundedPdfFileSafely,
} from "./bounded-pdf-file.js";
import { assertBoundedPdfStructure } from "./pdf-lib-worker.js";
import {
  PDF_LIB_RSS_FRAME_BYTES,
  PDF_LIB_RSS_MAGIC,
  PDF_LIB_RSS_PROTOCOL_VERSION,
  PDF_LIB_RSS_READY,
  PDF_LIB_RSS_SAMPLE,
  PDF_LIB_RSS_TERMINAL,
} from "./pdf-lib-rss-monitor.js";

export const PDF_RESOURCE_LIMIT_CODE = "PDF_RESOURCE_LIMIT_EXCEEDED";
export const PDF_LIB_MUTATION_TOOL_NAMES = new Set([
  "add_signature_field",
  "apply_page_plan",
  "apply_signature",
  "apply_text",
  "bulk_fill_from_csv",
  "fill_pdf",
  "fill_with_profile",
  "merge_pdfs",
  "prepare_signing_packet",
  "reorder_pdf_pages",
  "rotate_pdf_pages",
  "split_pdf",
]);

const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_STAGE_FILE_BYTES = 500 * 1024 * 1024;
const MAX_STAGE_TOTAL_BYTES = 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OLD_SPACE_MB = 384;
const TERMINATION_GRACE_MS = 1000;
const RSS_MONITOR_STARTUP_TIMEOUT_MS = 2000;
const RSS_MONITOR_STALL_TIMEOUT_MS = 250;
const RSS_MONITOR_IO_GRACE_MS = 100;
const RSS_MONITOR_TERMINAL_CLOSE_TIMEOUT_MS = 500;
const IMMEDIATE_HARD_KILL_REASONS = new Set([
  "rss_limit_exceeded",
  "rss_monitor_pipe_error",
  "rss_monitor_pipe_missing",
  "rss_monitor_premature_end",
  "rss_monitor_protocol_error",
  "rss_monitor_stalled",
  "rss_monitor_terminal_before_activation",
  "rss_monitor_terminal_child_stall",
]);
const OPERATION_SHUTDOWN_TIMEOUT_MS = 15_000;
// The V8 old-space flag is not a hard RSS ceiling: PDF buffers and native
// decoder allocations live outside that heap. Keep aggregate admission low.
const MAX_ACTIVE_MUTATIONS = 2;
const activeChildren = new Set();
const activeOperations = new Set();
let activeMutationReservations = 0;
let shutdownInProgress = false;
let gracefulShutdownPromise = null;
const OPTION_KEYS = new Map([
  ["fill_pdf", ["field_data"]],
  ["fill_with_profile", ["field_data"]],
  ["bulk_fill_from_csv", ["records"]],
  ["merge_pdfs", []],
  ["split_pdf", ["page_ranges"]],
  ["rotate_pdf_pages", ["degrees", "pages"]],
  ["reorder_pdf_pages", ["page_order", "rotations"]],
  ["apply_page_plan", ["page_order", "rotations"]],
  ["add_signature_field", ["allow_resign", "placement"]],
  ["apply_signature", [
    "allow_resign", "audit_line", "audit_text", "draw_audit_line",
    "modification_at", "placement", "signature",
  ]],
  ["prepare_signing_packet", ["allow_resign", "field_values", "signature_locations"]],
  ["apply_text", [
    "allow_resign", "audit_line", "font_style", "modification_at", "placement", "text",
  ]],
]);

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

function resourceError(reason, cause = null) {
  const error = new Error(
    "PDF processing exceeded its isolated resource budget. "
    + "The operation was stopped and the main PDF Tools server remains available. "
    + "Try a smaller or simpler PDF.",
    cause ? { cause } : undefined,
  );
  error.name = "PdfResourceLimitError";
  error.code = PDF_RESOURCE_LIMIT_CODE;
  error.reason = reason;
  return error;
}

function validateSource(source, index) {
  exactKeys(source, ["canonical_path", "file_identity", "sha256", "size_bytes"], `sources[${index}]`);
  if (typeof source.canonical_path !== "string" || !path.isAbsolute(source.canonical_path)) {
    throw new TypeError(`sources[${index}].canonical_path must be absolute.`);
  }
  if (!Number.isSafeInteger(source.size_bytes) || source.size_bytes < 1
      || source.size_bytes > PDF_MUTATION_MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(source.sha256)) {
    throw new TypeError(`sources[${index}] has an invalid size or digest.`);
  }
  exactKeys(source.file_identity, ["device", "inode"], `sources[${index}].file_identity`);
  if (typeof source.file_identity.device !== "string" || typeof source.file_identity.inode !== "string") {
    throw new TypeError(`sources[${index}] has an invalid file identity.`);
  }
}

export function createPdfLibMutationRequest({ operation, sources, options, password = null }) {
  if (!PDF_LIB_MUTATION_TOOL_NAMES.has(operation)) throw new TypeError(`Unsupported mutation: ${operation}.`);
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 1000) {
    throw new TypeError("Mutation requests require from 1 to 1000 sources.");
  }
  sources.forEach(validateSource);
  if (operation !== "merge_pdfs" && sources.length !== 1) {
    throw new TypeError(`${operation} requires exactly one source.`);
  }
  if (
    operation === "merge_pdfs"
    && sources.reduce((sum, source) => sum + source.size_bytes, 0) > PDF_MERGE_MAX_TOTAL_BYTES
  ) {
    throw new TypeError("merge_pdfs source bindings exceed the aggregate limit.");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Mutation options must be an object.");
  }
  exactKeys(options, OPTION_KEYS.get(operation), `${operation} options`);
  if (password !== null && (typeof password !== "string" || password.length < 1 || password.length > 4096)) {
    throw new TypeError("Mutation password is invalid.");
  }
  return { operation, sources, options, password };
}

function collector(maximum, overflow) {
  const chunks = [];
  let observed = 0;
  let overflowed = false;
  return {
    add(chunk) {
      const bytes = Buffer.from(chunk);
      const remaining = Math.max(0, maximum - observed);
      if (remaining) chunks.push(bytes.subarray(0, remaining));
      observed += bytes.length;
      if (observed > maximum && !overflowed) {
        overflowed = true;
        overflow();
      }
    },
    result: () => ({ bytes: Buffer.concat(chunks), observed, overflowed }),
  };
}

const MIB = 1024 * 1024;
export const PDF_LIB_RSS_MINIMUM_BYTES = 512 * MIB;
export const PDF_LIB_RSS_MAXIMUM_BYTES = 1024 * MIB;
export const PDF_LIB_RSS_HEADROOM_BYTES = 256 * MIB;

export function calculatePdfLibRssLimit(sourceBytes) {
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 1) {
    throw new TypeError("PDF source aggregate must be a positive safe integer.");
  }
  const projected = BigInt(sourceBytes) * 4n + BigInt(PDF_LIB_RSS_HEADROOM_BYTES);
  const bounded = projected < BigInt(PDF_LIB_RSS_MINIMUM_BYTES)
    ? BigInt(PDF_LIB_RSS_MINIMUM_BYTES)
    : projected > BigInt(PDF_LIB_RSS_MAXIMUM_BYTES)
      ? BigInt(PDF_LIB_RSS_MAXIMUM_BYTES)
      : projected;
  return Number(bounded);
}

export class PdfLibRssFrameParser {
  constructor({ maximumRssBytes, onReady = () => {}, onFrame = () => {} }) {
    if (!Number.isSafeInteger(maximumRssBytes) || maximumRssBytes < 1
        || typeof onReady !== "function" || typeof onFrame !== "function") {
      throw new TypeError("Invalid PDF RSS parser configuration.");
    }
    this.maximumRssBytes = maximumRssBytes;
    this.onReady = onReady;
    this.onFrame = onFrame;
    this.pending = Buffer.alloc(0);
    this.frames = 0;
    this.lastSequence = -1;
    this.ready = false;
    this.terminal = false;
    this.maximumObservedRss = 0;
  }

  add(chunk) {
    const bytes = Buffer.from(chunk);
    if (bytes.length === 0) return;
    if (bytes.length > PDF_LIB_RSS_FRAME_BYTES * 0x10000) {
      throw new Error("PDF RSS monitor chunk exceeds its frame ceiling.");
    }
    const available = this.pending.length
      ? Buffer.concat([this.pending, bytes])
      : bytes;
    let offset = 0;
    while (available.length - offset >= PDF_LIB_RSS_FRAME_BYTES) {
      const frame = available.subarray(offset, offset + PDF_LIB_RSS_FRAME_BYTES);
      this.#frame(frame);
      offset += PDF_LIB_RSS_FRAME_BYTES;
    }
    this.pending = Buffer.from(available.subarray(offset));
  }

  #frame(frame) {
    if (!frame.subarray(0, 4).equals(PDF_LIB_RSS_MAGIC)
        || frame[4] !== PDF_LIB_RSS_PROTOCOL_VERSION) {
      throw new Error("PDF RSS monitor frame header is invalid.");
    }
    const type = frame[5];
    const sequence = frame.readUInt16BE(6);
    const rssBig = frame.readBigUInt64BE(8);
    if (rssBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("PDF RSS monitor value is not safely representable.");
    }
    const rssBytes = Number(rssBig);
    if (rssBytes === 0) {
      throw new Error("PDF RSS monitor value must be positive.");
    }
    if (this.frames >= 0x10000 || sequence !== this.lastSequence + 1) {
      throw new Error("PDF RSS monitor sequence is invalid.");
    }
    if (!this.ready) {
      if (type !== PDF_LIB_RSS_READY || sequence !== 0) {
        throw new Error("PDF RSS monitor did not begin with READY.");
      }
      this.ready = true;
    } else if (this.terminal || type === PDF_LIB_RSS_READY
        || ![PDF_LIB_RSS_SAMPLE, PDF_LIB_RSS_TERMINAL].includes(type)) {
      throw new Error("PDF RSS monitor frame type is invalid.");
    } else if (type === PDF_LIB_RSS_TERMINAL) {
      this.terminal = true;
    }
    this.frames += 1;
    this.lastSequence = sequence;
    this.maximumObservedRss = Math.max(this.maximumObservedRss, rssBytes);
    if (rssBytes > this.maximumRssBytes) {
      const error = new Error("PDF RSS monitor observed a limit breach.");
      error.code = "PDF_LIB_RSS_LIMIT";
      throw error;
    }
    this.onFrame({ type, sequence, rssBytes });
    if (type === PDF_LIB_RSS_READY) this.onReady();
  }

  finish() {
    if (this.pending.length !== 0) {
      throw new Error("PDF RSS monitor ended with a partial frame.");
    }
    if (!this.ready || !this.terminal || this.frames < 2) {
      throw new Error("PDF RSS monitor lifecycle is incomplete.");
    }
    return {
      frames: this.frames,
      lastSequence: this.lastSequence,
      maximumObservedRss: this.maximumObservedRss,
    };
  }
}

function childEnvironment(environment, operationDirectory, platform) {
  const selected = {
    PATH: environment.PATH ?? "",
    PDF_TOOLS_DISABLE_SYSTEM_RENDERER: "1",
    TEMP: operationDirectory,
    TMP: operationDirectory,
    TMPDIR: operationDirectory,
  };
  for (const key of ["HOME", "LANG", "LC_ALL"]) {
    if (typeof environment[key] === "string") selected[key] = environment[key];
  }
  if (platform === "win32") {
    for (const key of ["SystemRoot", "WINDIR"]) {
      if (typeof environment[key] === "string") selected[key] = environment[key];
    }
  }
  return selected;
}

async function waitForWorker(
  child,
  requestBytes,
  timeoutMs,
  maximumOldSpaceMb,
  expectedOperation,
  maximumRssBytes,
) {
  let terminationReason = null;
  let childError = null;
  let escalation = null;
  let startupDeadline = null;
  let stallDeadline = null;
  let stallGraceDeadline = null;
  let terminalCloseDeadline = null;
  let requestActivated = false;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  ready.catch(() => {});
  const terminate = reason => {
    if (terminationReason !== null) return;
    terminationReason = reason;
    readyReject(resourceError(reason));
    const hardKill = IMMEDIATE_HARD_KILL_REASONS.has(reason);
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill(hardKill ? "SIGKILL" : "SIGTERM"); } catch {}
    }
    if (hardKill) return;
    escalation = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch {}
      }
    }, TERMINATION_GRACE_MS);
    escalation.unref();
  };
  const closed = new Promise(resolve => child.once(
    "close",
    (code, signal) => resolve({ code, signal }),
  ));
  const stdout = collector(MAX_STDOUT_BYTES, () => terminate("stdout_overflow"));
  const stderr = collector(MAX_STDERR_BYTES, () => terminate("stderr_overflow"));
  const monitorStream = child.stdio?.[3];
  if (!monitorStream) {
    child.stdout?.resume();
    child.stderr?.resume();
    child.stdin?.destroy();
    terminate("rss_monitor_pipe_missing");
    await closed;
    if (escalation) clearTimeout(escalation);
    throw resourceError("rss_monitor_pipe_missing");
  }
  const resetStallDeadline = () => {
    if (stallDeadline) clearTimeout(stallDeadline);
    if (stallGraceDeadline) clearTimeout(stallGraceDeadline);
    stallDeadline = setTimeout(
      () => {
        stallGraceDeadline = setTimeout(
          () => terminate("rss_monitor_stalled"),
          RSS_MONITOR_IO_GRACE_MS,
        );
        stallGraceDeadline.unref();
      },
      RSS_MONITOR_STALL_TIMEOUT_MS,
    );
    stallDeadline.unref();
  };
  const parser = new PdfLibRssFrameParser({
    maximumRssBytes,
    onReady() {
      if (startupDeadline) clearTimeout(startupDeadline);
      resetStallDeadline();
      readyResolve();
    },
    onFrame({ type }) {
      if (type === PDF_LIB_RSS_SAMPLE) resetStallDeadline();
      if (type === PDF_LIB_RSS_TERMINAL && stallDeadline) {
        clearTimeout(stallDeadline);
        stallDeadline = null;
        if (stallGraceDeadline) {
          clearTimeout(stallGraceDeadline);
          stallGraceDeadline = null;
        }
      }
      if (type === PDF_LIB_RSS_TERMINAL) {
        if (!requestActivated) {
          terminate("rss_monitor_terminal_before_activation");
          return;
        }
        terminalCloseDeadline = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            terminate("rss_monitor_terminal_child_stall");
          }
        }, RSS_MONITOR_TERMINAL_CLOSE_TIMEOUT_MS);
        terminalCloseDeadline.unref();
      }
    },
  });
  child.stdout.on("data", stdout.add);
  child.stderr.on("data", stderr.add);
  monitorStream.on("data", chunk => {
    try {
      parser.add(chunk);
    } catch (error) {
      terminate(error?.code === "PDF_LIB_RSS_LIMIT"
        ? "rss_limit_exceeded"
        : "rss_monitor_protocol_error");
    }
  });
  monitorStream.on("error", error => {
    terminate("rss_monitor_pipe_error");
  });
  monitorStream.on("end", () => {
    if (!parser.terminal) {
      terminate("rss_monitor_premature_end");
      return;
    }
    try {
      parser.finish();
    } catch {
      terminate("rss_monitor_protocol_error");
    }
  });
  child.on("error", error => {
    childError ??= error;
    terminate("worker_spawn_failed");
  });
  child.stdin.on("error", error => {
    if (error?.code !== "EPIPE") {
      childError ??= error;
      terminate("worker_stdin_failed");
    }
  });
  startupDeadline = setTimeout(
    () => terminate("rss_monitor_startup_timeout"),
    Math.min(RSS_MONITOR_STARTUP_TIMEOUT_MS, timeoutMs),
  );
  startupDeadline.unref();
  const deadline = setTimeout(() => terminate("timeout"), timeoutMs);
  deadline.unref();
  try {
    await Promise.race([
      ready,
      closed.then(() => { throw resourceError("rss_monitor_missing_ready"); }),
    ]);
    if (!terminationReason) {
      requestActivated = true;
      child.stdin.end(requestBytes);
    }
  } catch {
    // The first-wins termination reason is reported after the child and every
    // inherited pipe have closed.
  }
  const { code, signal } = await closed;
  clearTimeout(deadline);
  if (startupDeadline) clearTimeout(startupDeadline);
  if (stallDeadline) clearTimeout(stallDeadline);
  if (stallGraceDeadline) clearTimeout(stallGraceDeadline);
  if (terminalCloseDeadline) clearTimeout(terminalCloseDeadline);
  if (escalation) clearTimeout(escalation);
  const out = stdout.result();
  const err = stderr.result();
  if (terminationReason || signal || out.overflowed || err.overflowed) {
    throw resourceError(
      terminationReason ?? `worker_signal_${signal}`,
      childError,
    );
  }
  try {
    parser.finish();
  } catch (error) {
    throw resourceError("rss_monitor_incomplete", error);
  }
  if (code !== 0 && out.bytes.length === 0) {
    throw resourceError(`worker_exit_${code}_heap_${maximumOldSpaceMb}`);
  }
  let response;
  try {
    const text = out.bytes.toString("utf8");
    if (!text || text.trim() !== text) throw new Error("invalid frame");
    response = JSON.parse(text);
  } catch (error) {
    throw resourceError("malformed_control_output", error);
  }
  if (response?.status === "error") {
    try {
      exactKeys(response, ["error", "operation", "protocol_version", "status"], "worker error");
      exactKeys(response.error, ["code", "message", "name", "reason"], "worker error detail");
    } catch (error) {
      throw resourceError("malformed_control_output", error);
    }
    if (response.protocol_version !== PROTOCOL_VERSION || response.operation !== expectedOperation) {
      throw resourceError("mismatched_control_output");
    }
    if (response.error.code === PDF_RESOURCE_LIMIT_CODE) {
      throw resourceError(response.error.reason ?? "worker_resource_limit");
    }
    const error = new Error(response.error.message);
    error.name = response.error.name;
    if (response.error.code !== null) error.code = response.error.code;
    throw error;
  }
  if (code !== 0) throw resourceError(`worker_exit_${code}_heap_${maximumOldSpaceMb}`);
  try {
    exactKeys(response, ["manifest", "operation", "protocol_version", "result", "status"], "worker response");
  } catch (error) {
    throw resourceError("malformed_control_output", error);
  }
  if (
    response.status !== "ok"
    || response.protocol_version !== PROTOCOL_VERSION
    || response.operation !== expectedOperation
  ) {
    throw resourceError("mismatched_control_output");
  }
  return response;
}

async function hashFile(filePath) {
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function validateStage(stageDirectory, response, operation) {
  if (response.operation !== operation || !Array.isArray(response.manifest)
      || response.manifest.length < 1 || response.manifest.length > 1000
      || !response.result || typeof response.result !== "object" || Array.isArray(response.result)) {
    throw resourceError("invalid_stage_manifest");
  }
  const names = await fs.readdir(stageDirectory);
  const expectedNames = response.manifest.map(entry => entry.filename).sort();
  if (JSON.stringify([...names].sort()) !== JSON.stringify(expectedNames)) {
    throw resourceError("incomplete_or_extra_stage");
  }
  let total = 0;
  const outputs = [];
  for (const [index, entry] of response.manifest.entries()) {
    exactKeys(entry, ["file_identity", "filename", "sha256", "size_bytes"], `manifest[${index}]`);
    exactKeys(entry.file_identity, ["device", "inode"], `manifest[${index}].file_identity`);
    const expectedName = `output-${String(index + 1).padStart(4, "0")}.pdf`;
    if (entry.filename !== expectedName || !/^[a-f0-9]{64}$/.test(entry.sha256)
        || !Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 1
        || entry.size_bytes > MAX_STAGE_FILE_BYTES) {
      throw resourceError("invalid_stage_manifest");
    }
    total += entry.size_bytes;
    if (total > MAX_STAGE_TOTAL_BYTES) throw resourceError("stage_total_too_large");
    const outputPath = path.join(stageDirectory, entry.filename);
    const stats = await fs.lstat(outputPath, { bigint: true });
    const mode = Number(stats.mode & 0o777n);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n
        || String(stats.dev) !== entry.file_identity.device
        || String(stats.ino) !== entry.file_identity.inode
        || Number(stats.size) !== entry.size_bytes
        || (process.platform !== "win32" && (mode & 0o077) !== 0)
        || (typeof process.getuid === "function" && stats.uid !== BigInt(process.getuid()))
        || await hashFile(outputPath) !== entry.sha256) {
      throw resourceError("unsafe_or_changed_stage");
    }
    outputs.push({ ...entry, path: outputPath });
  }
  return outputs;
}

async function readStageOutput(output) {
  const pathStats = await fs.lstat(output.path, { bigint: true });
  if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
    throw resourceError("stage_changed_before_read");
  }
  let handle;
  try {
    handle = await fs.open(output.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw resourceError("stage_changed_before_read", error);
  }
  try {
    const before = await handle.stat({ bigint: true });
    const mode = Number(before.mode & 0o777n);
    if (!before.isFile() || before.nlink !== 1n
        || String(before.dev) !== output.file_identity.device
        || String(before.ino) !== output.file_identity.inode
        || Number(before.size) !== output.size_bytes
        || (process.platform !== "win32" && (mode & 0o077) !== 0)
        || (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))) {
      throw resourceError("stage_changed_before_read");
    }
    const bytes = Buffer.allocUnsafe(output.size_bytes);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw resourceError("stage_changed_during_read");
      offset += bytesRead;
    }
    const overflow = Buffer.allocUnsafe(1);
    if ((await handle.read(overflow, 0, 1, bytes.length)).bytesRead !== 0) {
      throw resourceError("stage_changed_during_read");
    }
    const after = await handle.stat({ bigint: true });
    if (String(after.dev) !== String(before.dev) || String(after.ino) !== String(before.ino)
        || Number(after.size) !== bytes.length || after.nlink !== before.nlink
        || createHash("sha256").update(bytes).digest("hex") !== output.sha256) {
      throw resourceError("stage_changed_during_read");
    }
    if (bytes.subarray(0, 1024).indexOf(Buffer.from("%PDF-", "ascii")) < 0) {
      throw resourceError("invalid_staged_pdf_header");
    }
    assertBoundedPdfStructure(bytes);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function revalidateSources(sources) {
  for (const source of sources) {
    const current = await hashBoundedPdfFileSafely(
      source.canonical_path,
      PDF_MUTATION_MAX_FILE_BYTES,
      {
        assertPathAllowed(candidate) {
          if (path.resolve(candidate) !== source.canonical_path) throw new Error("Source path binding changed.");
        },
      },
    );
    if (current.canonicalPath !== source.canonical_path
        || current.sizeBytes !== source.size_bytes
        || current.sha256 !== source.sha256
        || current.fileIdentity.device !== source.file_identity.device
        || current.fileIdentity.inode !== source.file_identity.inode) {
      throw resourceError("source_drift_before_activation");
    }
  }
}

export async function runPdfLibMutation(request, consumeStage, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maximumOldSpaceMb = DEFAULT_OLD_SPACE_MB,
  rssLimitCalculator = calculatePdfLibRssLimit,
  workerPath = fileURLToPath(new URL("./pdf-lib-worker.js", import.meta.url)),
  executable = process.execPath,
  environment = process.env,
  platform = process.platform,
  spawnProcess = spawn,
  beforeSpawn = null,
} = {}) {
  const base = createPdfLibMutationRequest(request);
  if (typeof consumeStage !== "function") throw new TypeError("consumeStage must be a function.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60 * 1000) {
    throw new TypeError("timeoutMs must be a positive bounded integer.");
  }
  if (!Number.isSafeInteger(maximumOldSpaceMb) || maximumOldSpaceMb < 64 || maximumOldSpaceMb > 4096) {
    throw new TypeError("maximumOldSpaceMb must be between 64 and 4096.");
  }
  if (typeof rssLimitCalculator !== "function") {
    throw new TypeError("rssLimitCalculator must be a function.");
  }
  if (beforeSpawn !== null && typeof beforeSpawn !== "function") {
    throw new TypeError("beforeSpawn must be a function.");
  }
  if (shutdownInProgress) {
    throw resourceError("mutation_shutdown_in_progress");
  }
  if (activeMutationReservations >= MAX_ACTIVE_MUTATIONS) {
    throw resourceError("mutation_concurrency_limit");
  }
  activeMutationReservations += 1;
  let settleOperation;
  const operationSettlement = new Promise(resolve => { settleOperation = resolve; });
  activeOperations.add(operationSettlement);
  let operationDirectory;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    try {
      await fs.rm(operationDirectory, { recursive: true, force: true });
      cleaned = true;
    } catch (error) {
      throw resourceError("stage_cleanup_unproven", error);
    }
  };
  try {
    operationDirectory = await fs.mkdtemp(path.join(tmpdir(), "pdf-tools-pdflib-"));
    await fs.chmod(operationDirectory, 0o700);
    const stageDirectory = path.join(operationDirectory, "stage");
    await fs.mkdir(stageDirectory, { mode: 0o700 });
    const framed = {
      protocol_version: PROTOCOL_VERSION,
      operation: base.operation,
      sources: base.sources,
      password: base.password,
      options: base.options,
      stage_directory: stageDirectory,
    };
    const requestBytes = Buffer.from(JSON.stringify(framed), "utf8");
    if (requestBytes.length > MAX_REQUEST_BYTES) throw resourceError("request_too_large");
    const sourceAggregateBytes = base.sources.reduce(
      (sum, source) => sum + source.size_bytes,
      0,
    );
    const maximumRssBytes = rssLimitCalculator(sourceAggregateBytes);
    if (!Number.isSafeInteger(maximumRssBytes)
        || maximumRssBytes < 1
        || maximumRssBytes > PDF_LIB_RSS_MAXIMUM_BYTES) {
      throw new TypeError("rssLimitCalculator returned an invalid limit.");
    }
    if (beforeSpawn) await beforeSpawn();
    // A shutdown can begin while an admitted operation awaits private staging
    // setup. Recheck immediately before the synchronous spawn boundary so the
    // drain cannot miss a child created after its snapshot.
    if (shutdownInProgress) throw resourceError("mutation_shutdown_in_progress");
    const child = spawnProcess(executable, [
      `--max-old-space-size=${maximumOldSpaceMb}`,
      workerPath,
    ], {
      cwd: operationDirectory,
      detached: false,
      env: childEnvironment(environment, operationDirectory, platform),
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    activeChildren.add(child);
    let response;
    try {
      response = await waitForWorker(
        child,
        requestBytes,
        timeoutMs,
        maximumOldSpaceMb,
        base.operation,
        maximumRssBytes,
      );
    } finally {
      activeChildren.delete(child);
    }
    const outputs = await validateStage(stageDirectory, response, base.operation);
    await revalidateSources(base.sources);
    let releasedBeforeActivation = false;
    const atomicTransition = async transition => {
      if (transition !== "journal_prepared" || releasedBeforeActivation) return;
      await revalidateSources(base.sources);
      await cleanup();
      releasedBeforeActivation = true;
    };
    const result = await consumeStage({
      result: response.result,
      outputs: outputs.map(output => ({
        ...output,
        readBytes: () => readStageOutput(output),
      })),
      atomicTransition,
    });
    if (!cleaned) await cleanup();
    return result;
  } catch (error) {
    if (operationDirectory && !cleaned) {
      try { await cleanup(); } catch (cleanupError) { throw cleanupError; }
    }
    throw error;
  } finally {
    activeMutationReservations -= 1;
    activeOperations.delete(operationSettlement);
    settleOperation();
  }
}

function terminateChild(child) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, TERMINATION_GRACE_MS);
    timer.unref();
    const settled = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("close", settled);
    try { child.kill("SIGTERM"); } catch { settled(); }
  });
}

export function terminateAllPdfLibMutations() {
  if (gracefulShutdownPromise) return gracefulShutdownPromise;
  shutdownInProgress = true;
  const operations = [...activeOperations];
  const childTerminations = [...activeChildren].map(terminateChild);
  gracefulShutdownPromise = (async () => {
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(resourceError("mutation_shutdown_timeout")),
          OPERATION_SHUTDOWN_TIMEOUT_MS,
        );
        timer.unref();
      });
      await Promise.race([
        Promise.allSettled([...childTerminations, ...operations]),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
      gracefulShutdownPromise = null;
      // A completed drain may be used as a bounded test or lifecycle hook. If
      // an operation did not settle before escalation, keep admission closed.
      if (activeOperations.size === 0) shutdownInProgress = false;
    }
  })();
  return gracefulShutdownPromise;
}

export function forceTerminateAllPdfLibMutations() {
  shutdownInProgress = true;
  for (const child of activeChildren) {
    try { child.kill("SIGKILL"); } catch {}
  }
}
