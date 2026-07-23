import { constants as defaultFsConstants } from "node:fs";
import defaultFileSystem from "node:fs/promises";

const PDF_CHANGED_MESSAGE = "PDF changed while it was being read. Retry the request.";
const PDF_TOO_LARGE_MESSAGE = "read_pdf_layout accepts source PDFs up to 250 MiB.";
const PATH_RACE_ERROR_CODES = new Set(["ELOOP", "ENOENT", "ENOTDIR", "ESTALE"]);

export const PDF_MUTATION_MAX_FILE_BYTES = 250 * 1024 * 1024;
export const PDF_MERGE_MAX_TOTAL_BYTES = 500 * 1024 * 1024;
export const PDF_MUTATION_FILE_LIMIT_MESSAGE = "PDF input exceeds the 250 MiB per-file limit.";
export const PDF_MERGE_AGGREGATE_LIMIT_MESSAGE = "merge_pdfs inputs exceed the 500 MiB aggregate limit.";

export function pdfMutationFileLimitError() {
  const error = new Error(PDF_MUTATION_FILE_LIMIT_MESSAGE);
  error.code = "PDF_INPUT_TOO_LARGE";
  return error;
}

export function pdfMergeAggregateLimitError() {
  const error = new Error(PDF_MERGE_AGGREGATE_LIMIT_MESSAGE);
  error.code = "PDF_MERGE_INPUTS_TOO_LARGE";
  return error;
}

function pdfChangedError(cause) {
  const error = new Error(PDF_CHANGED_MESSAGE, cause ? { cause } : undefined);
  error.code = "PDF_CHANGED_DURING_READ";
  return error;
}

function comparableTime(stats, nanosecondsKey, millisecondsKey) {
  if (typeof stats[nanosecondsKey] === "bigint") return `ns:${stats[nanosecondsKey]}`;
  if (Number.isFinite(stats[millisecondsKey])) return `ms:${stats[millisecondsKey]}`;
  return null;
}

function sameFileIdentity(left, right) {
  const leftMtime = comparableTime(left, "mtimeNs", "mtimeMs");
  const rightMtime = comparableTime(right, "mtimeNs", "mtimeMs");
  const leftCtime = comparableTime(left, "ctimeNs", "ctimeMs");
  const rightCtime = comparableTime(right, "ctimeNs", "ctimeMs");
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && leftMtime !== null
    && leftMtime === rightMtime
    && leftCtime !== null
    && leftCtime === rightCtime;
}

function stableFileIdentity(stats) {
  return {
    device: String(stats.dev),
    inode: String(stats.ino),
  };
}

function boundedFileSize(stats, maxBytes, createSizeLimitError) {
  const size = stats.size;
  if (typeof size === "bigint") {
    if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER) || size > BigInt(maxBytes)) {
      throw createSizeLimitError();
    }
    return Number(size);
  }
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
    throw createSizeLimitError();
  }
  return size;
}

function readOnlyNoFollowFlags(constants) {
  const noFollow = Number.isInteger(constants.O_NOFOLLOW) ? constants.O_NOFOLLOW : 0;
  return constants.O_RDONLY | noFollow;
}

async function raceAware(operation) {
  try {
    return await operation();
  } catch (error) {
    if (PATH_RACE_ERROR_CODES.has(error?.code)) throw pdfChangedError(error);
    throw error;
  }
}

function validateBoundedReadArguments(maxBytes, assertPathAllowed, createSizeLimitError) {
  if (typeof assertPathAllowed !== "function") {
    throw new TypeError("A bounded PDF file operation requires an allowed-path policy.");
  }
  if (typeof createSizeLimitError !== "function") {
    throw new TypeError("createSizeLimitError must be a function.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("maxBytes must be a non-negative safe integer.");
  }
}

/**
 * Check a PDF's stable descriptor size without reading or allocating its
 * contents. This is deliberately separate from recovery: an existing
 * oversized request must fail without publishing, rolling back, or deleting
 * any output-transaction artifact in the containing directory.
 */
export async function preflightBoundedPdfFileSafely(resolvedPath, maxBytes, {
  fileSystem = defaultFileSystem,
  constants = defaultFsConstants,
  assertPathAllowed,
  createSizeLimitError = () => new Error(PDF_TOO_LARGE_MESSAGE),
} = {}) {
  validateBoundedReadArguments(maxBytes, assertPathAllowed, createSizeLimitError);

  const canonicalPath = await fileSystem.realpath(resolvedPath);
  assertPathAllowed(canonicalPath);
  const pathBefore = await raceAware(() => fileSystem.lstat(canonicalPath, { bigint: true }));
  if (!pathBefore.isFile()) throw new Error("PDF path must identify a regular file.");

  const handle = await raceAware(() => fileSystem.open(canonicalPath, readOnlyNoFollowFlags(constants)));
  try {
    const before = await raceAware(() => handle.stat({ bigint: true }));
    if (!before.isFile()) throw new Error("PDF path must identify a regular file.");
    if (!sameFileIdentity(pathBefore, before)) throw pdfChangedError();
    const sizeBytes = boundedFileSize(before, maxBytes, createSizeLimitError);
    const after = await raceAware(() => handle.stat({ bigint: true }));
    if (!sameFileIdentity(before, after)) throw pdfChangedError();

    const pathAfter = await raceAware(() => fileSystem.lstat(canonicalPath, { bigint: true }));
    if (!pathAfter.isFile() || !sameFileIdentity(after, pathAfter)) throw pdfChangedError();
    const canonicalAfter = await raceAware(() => fileSystem.realpath(canonicalPath));
    if (canonicalAfter !== canonicalPath) throw pdfChangedError();
    assertPathAllowed(canonicalAfter);
    return {
      sizeBytes,
      canonicalPath: canonicalAfter,
      fileIdentity: stableFileIdentity(after),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Read a bounded regular file from one descriptor while rejecting observable
 * pathname or inode changes. The injected filesystem seam exists only so race
 * behavior can be tested at deterministic call boundaries.
 */
export async function readBoundedPdfFileSafely(resolvedPath, maxBytes, {
  fileSystem = defaultFileSystem,
  constants = defaultFsConstants,
  assertPathAllowed,
  createSizeLimitError = () => new Error(PDF_TOO_LARGE_MESSAGE),
} = {}) {
  validateBoundedReadArguments(maxBytes, assertPathAllowed, createSizeLimitError);

  const canonicalPath = await fileSystem.realpath(resolvedPath);
  assertPathAllowed(canonicalPath);
  const pathBefore = await raceAware(() => fileSystem.lstat(canonicalPath, { bigint: true }));
  if (!pathBefore.isFile()) throw new Error("PDF path must identify a regular file.");

  const handle = await raceAware(() => fileSystem.open(canonicalPath, readOnlyNoFollowFlags(constants)));
  try {
    const before = await raceAware(() => handle.stat({ bigint: true }));
    if (!before.isFile()) throw new Error("PDF path must identify a regular file.");
    if (!sameFileIdentity(pathBefore, before)) throw pdfChangedError();

    const sizeBytes = boundedFileSize(before, maxBytes, createSizeLimitError);
    const bytes = Buffer.allocUnsafe(sizeBytes);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await raceAware(() => handle.read(bytes, offset, bytes.length - offset, offset));
      if (bytesRead === 0) throw pdfChangedError();
      offset += bytesRead;
    }

    const after = await raceAware(() => handle.stat({ bigint: true }));
    if (!sameFileIdentity(before, after)) throw pdfChangedError();

    const pathAfter = await raceAware(() => fileSystem.lstat(canonicalPath, { bigint: true }));
    if (!pathAfter.isFile() || !sameFileIdentity(after, pathAfter)) throw pdfChangedError();

    const canonicalAfter = await raceAware(() => fileSystem.realpath(canonicalPath));
    if (canonicalAfter !== canonicalPath) throw pdfChangedError();
    assertPathAllowed(canonicalAfter);
    return {
      bytes,
      sizeBytes,
      canonicalPath: canonicalAfter,
      fileIdentity: stableFileIdentity(after),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Perform a non-allocating pass over every currently present merge input
 * before any recovery-aware reader is allowed to run. Missing paths are
 * retained as unknown because a stale transaction may legitimately restore
 * them; present files still prove per-file and known aggregate bounds.
 */
export async function preflightPdfMutationInputsWithinMergeLimit(resolvedPaths, {
  preflightInput,
  maxFileBytes = PDF_MUTATION_MAX_FILE_BYTES,
  maxTotalBytes = PDF_MERGE_MAX_TOTAL_BYTES,
} = {}) {
  if (!Array.isArray(resolvedPaths) || typeof preflightInput !== "function") {
    throw new TypeError("preflightPdfMutationInputsWithinMergeLimit requires paths and a preflight reader.");
  }
  if (
    !Number.isSafeInteger(maxFileBytes)
    || maxFileBytes < 0
    || !Number.isSafeInteger(maxTotalBytes)
    || maxTotalBytes < 0
  ) {
    throw new TypeError("Merge PDF byte limits must be non-negative safe integers.");
  }

  const observations = [];
  let knownTotalSizeBytes = 0;
  for (const resolvedPath of resolvedPaths) {
    const observation = await preflightInput(
      resolvedPath,
      maxFileBytes,
      pdfMutationFileLimitError,
    );
    if (observation === null) {
      observations.push({ resolvedPath, missingBeforeRecovery: true, sizeBytes: null });
      continue;
    }
    if (
      !observation
      || !Number.isSafeInteger(observation.sizeBytes)
      || observation.sizeBytes < 0
      || observation.sizeBytes > maxFileBytes
    ) {
      throw new Error("Bounded PDF input preflight returned an invalid result.");
    }
    if (knownTotalSizeBytes + observation.sizeBytes > maxTotalBytes) {
      throw pdfMergeAggregateLimitError();
    }
    knownTotalSizeBytes += observation.sizeBytes;
    observations.push({
      resolvedPath,
      missingBeforeRecovery: false,
      sizeBytes: observation.sizeBytes,
    });
  }
  return { observations, knownTotalSizeBytes };
}

/**
 * Read merge inputs in request order while never asking the descriptor reader
 * to allocate beyond either the per-file or remaining aggregate allowance.
 * The injected reader is the recovery-aware one-descriptor reader in the
 * server; the seam also makes the aggregate budget independently testable
 * without constructing hundreds of MiB of fixture data.
 */
export async function readPdfMutationInputsWithinMergeLimit(resolvedPaths, {
  readInput,
  maxFileBytes = PDF_MUTATION_MAX_FILE_BYTES,
  maxTotalBytes = PDF_MERGE_MAX_TOTAL_BYTES,
} = {}) {
  if (!Array.isArray(resolvedPaths) || typeof readInput !== "function") {
    throw new TypeError("readPdfMutationInputsWithinMergeLimit requires paths and a reader.");
  }
  if (
    !Number.isSafeInteger(maxFileBytes)
    || maxFileBytes < 0
    || !Number.isSafeInteger(maxTotalBytes)
    || maxTotalBytes < 0
  ) {
    throw new TypeError("Merge PDF byte limits must be non-negative safe integers.");
  }

  const inputs = [];
  let totalSizeBytes = 0;
  for (const resolvedPath of resolvedPaths) {
    const remainingBytes = maxTotalBytes - totalSizeBytes;
    const aggregateLimitIsTighter = remainingBytes < maxFileBytes;
    const maxBytes = Math.min(maxFileBytes, remainingBytes);
    const createSizeLimitError = aggregateLimitIsTighter
      ? pdfMergeAggregateLimitError
      : pdfMutationFileLimitError;
    const input = await readInput(resolvedPath, maxBytes, createSizeLimitError);
    if (
      !input
      || !Number.isSafeInteger(input.sizeBytes)
      || input.sizeBytes < 0
      || input.sizeBytes > maxBytes
      || !Buffer.isBuffer(input.pdfBytes)
      || input.pdfBytes.length !== input.sizeBytes
    ) {
      throw new Error("Bounded PDF input reader returned an invalid result.");
    }
    totalSizeBytes += input.sizeBytes;
    inputs.push(input);
  }
  return { inputs, totalSizeBytes };
}
