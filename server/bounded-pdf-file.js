import { constants as defaultFsConstants } from "node:fs";
import defaultFileSystem from "node:fs/promises";

const PDF_CHANGED_MESSAGE = "PDF changed while it was being read. Retry the request.";
const PDF_TOO_LARGE_MESSAGE = "read_pdf_layout accepts source PDFs up to 250 MiB.";
const PATH_RACE_ERROR_CODES = new Set(["ELOOP", "ENOENT", "ENOTDIR", "ESTALE"]);

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

function boundedFileSize(stats, maxBytes) {
  const size = stats.size;
  if (typeof size === "bigint") {
    if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER) || size > BigInt(maxBytes)) {
      throw new Error(PDF_TOO_LARGE_MESSAGE);
    }
    return Number(size);
  }
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
    throw new Error(PDF_TOO_LARGE_MESSAGE);
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

/**
 * Read a bounded regular file from one descriptor while rejecting observable
 * pathname or inode changes. The injected filesystem seam exists only so race
 * behavior can be tested at deterministic call boundaries.
 */
export async function readBoundedPdfFileSafely(resolvedPath, maxBytes, {
  fileSystem = defaultFileSystem,
  constants = defaultFsConstants,
  assertPathAllowed,
} = {}) {
  if (typeof assertPathAllowed !== "function") {
    throw new TypeError("readBoundedPdfFileSafely requires an allowed-path policy.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("maxBytes must be a non-negative safe integer.");
  }

  const canonicalPath = await fileSystem.realpath(resolvedPath);
  assertPathAllowed(canonicalPath);
  const pathBefore = await raceAware(() => fileSystem.lstat(canonicalPath, { bigint: true }));
  if (!pathBefore.isFile()) throw new Error("PDF path must identify a regular file.");

  const handle = await raceAware(() => fileSystem.open(canonicalPath, readOnlyNoFollowFlags(constants)));
  try {
    const before = await raceAware(() => handle.stat({ bigint: true }));
    if (!before.isFile()) throw new Error("PDF path must identify a regular file.");
    if (!sameFileIdentity(pathBefore, before)) throw pdfChangedError();

    const sizeBytes = boundedFileSize(before, maxBytes);
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
