import { constants as defaultFsConstants } from "node:fs";
import defaultFileSystem from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const PDF_CHANGED_MESSAGE = "PDF changed while it was being read. Retry the request.";
const PDF_TOO_LARGE_MESSAGE = "read_pdf_layout accepts source PDFs up to 250 MiB.";
const PDF_HASH_CHUNK_BYTES = 1024 * 1024;
const PDF_HASH_MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const PDF_HEADER_WINDOW_BYTES = 1024;
const PDF_HEADER_MAGIC = Buffer.from("%PDF-", "ascii");
const PATH_RACE_ERROR_CODES = new Set(["ELOOP", "ENOENT", "ENOTDIR", "ESTALE"]);

export const PDF_MUTATION_MAX_FILE_BYTES = 250 * 1024 * 1024;
export const PDF_MERGE_MAX_TOTAL_BYTES = 500 * 1024 * 1024;
export const PDF_MUTATION_FILE_LIMIT_MESSAGE = "PDF input exceeds the 250 MiB per-file limit.";
export const PDF_MERGE_AGGREGATE_LIMIT_MESSAGE = "merge_pdfs inputs exceed the 500 MiB aggregate limit.";
export const PDF_INVALID_HEADER_MESSAGE =
  "PDF input does not contain a %PDF- header within the first 1,024 bytes.";

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

function pdfInvalidHeaderError() {
  const error = new Error(PDF_INVALID_HEADER_MESSAGE);
  error.code = "PDF_INVALID_HEADER";
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

function isStableFileIdentity(identity) {
  return Boolean(
    identity
    && typeof identity.device === "string"
    && identity.device.length > 0
    && typeof identity.inode === "string"
    && identity.inode.length > 0
  );
}

function sameStableFileIdentity(left, right) {
  return isStableFileIdentity(left)
    && isStableFileIdentity(right)
    && left.device === right.device
    && left.inode === right.inode;
}

function recoveryDirectoryChangedError(cause) {
  const error = new Error(
    "PDF recovery directory changed during input preparation. Retry the request.",
    cause ? { cause } : undefined,
  );
  error.code = "PDF_RECOVERY_DIRECTORY_CHANGED";
  return error;
}

function pdfInputAliasChangedError(cause) {
  const error = new Error(
    "PDF input alias changed during recovery. Retry the request.",
    cause ? { cause } : undefined,
  );
  error.code = "PDF_INPUT_ALIAS_CHANGED";
  return error;
}

function pdfInputAliasUnsafeError(cause) {
  const error = new Error(
    "PDF input alias has an unsafe or unsupported target.",
    cause ? { cause } : undefined,
  );
  error.code = "PDF_INPUT_ALIAS_UNSAFE";
  return error;
}

function stableSymlinkIdentity(stats) {
  return {
    ...stableFileIdentity(stats),
    size: String(stats.size),
    mtime: comparableTime(stats, "mtimeNs", "mtimeMs"),
    ctime: comparableTime(stats, "ctimeNs", "ctimeMs"),
  };
}

function sameStableSymlinkIdentity(left, right) {
  return isStableSymlinkIdentity(left)
    && isStableSymlinkIdentity(right)
    && sameStableFileIdentity(left, right)
    && typeof left.size === "string"
    && left.size === right?.size
    && typeof left.mtime === "string"
    && left.mtime === right?.mtime
    && typeof left.ctime === "string"
    && left.ctime === right?.ctime;
}

function isStableSymlinkIdentity(identity) {
  return isStableFileIdentity(identity)
    && typeof identity.size === "string"
    && identity.size.length > 0
    && typeof identity.mtime === "string"
    && identity.mtime.length > 0
    && typeof identity.ctime === "string"
    && identity.ctime.length > 0;
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

async function inspectCanonicalDirectoryBinding(
  canonicalPath,
  fileSystem,
  assertPathAllowed,
  expectedIdentity = null,
) {
  try {
    assertPathAllowed(canonicalPath);
    const before = await fileSystem.lstat(canonicalPath, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw recoveryDirectoryChangedError();
    }
    const canonicalAfter = await fileSystem.realpath(canonicalPath);
    const after = await fileSystem.lstat(canonicalAfter, { bigint: true });
    const beforeIdentity = stableFileIdentity(before);
    const afterIdentity = stableFileIdentity(after);
    if (
      canonicalAfter !== canonicalPath
      || !after.isDirectory()
      || after.isSymbolicLink()
      || !sameStableFileIdentity(beforeIdentity, afterIdentity)
      || (expectedIdentity && !sameStableFileIdentity(afterIdentity, expectedIdentity))
    ) {
      throw recoveryDirectoryChangedError();
    }
    assertPathAllowed(canonicalAfter);
    return {
      canonicalPath: canonicalAfter,
      fileIdentity: afterIdentity,
    };
  } catch (error) {
    if (error?.code === "PDF_RECOVERY_DIRECTORY_CHANGED") throw error;
    throw recoveryDirectoryChangedError(error);
  }
}

export async function bindCanonicalRecoveryDirectory(directoryPath, {
  fileSystem = defaultFileSystem,
  assertPathAllowed,
} = {}) {
  if (typeof assertPathAllowed !== "function") {
    throw new TypeError("bindCanonicalRecoveryDirectory requires an allowed-path policy.");
  }
  const requestedPath = path.resolve(directoryPath);
  let canonicalPath;
  try {
    canonicalPath = await fileSystem.realpath(requestedPath);
  } catch (error) {
    throw recoveryDirectoryChangedError(error);
  }
  const inspected = await inspectCanonicalDirectoryBinding(
    canonicalPath,
    fileSystem,
    assertPathAllowed,
  );
  return { requestedPath, ...inspected };
}

export async function assertCanonicalRecoveryDirectory(binding, {
  fileSystem = defaultFileSystem,
  assertPathAllowed,
} = {}) {
  if (
    !binding
    || typeof binding.requestedPath !== "string"
    || typeof binding.canonicalPath !== "string"
    || !isStableFileIdentity(binding.fileIdentity)
    || typeof assertPathAllowed !== "function"
  ) {
    throw new TypeError("assertCanonicalRecoveryDirectory requires a valid binding and allowed-path policy.");
  }
  try {
    assertPathAllowed(binding.requestedPath);
    const canonicalFromRequestedPath = await fileSystem.realpath(binding.requestedPath);
    if (canonicalFromRequestedPath !== binding.canonicalPath) {
      throw recoveryDirectoryChangedError();
    }
    const inspected = await inspectCanonicalDirectoryBinding(
      binding.canonicalPath,
      fileSystem,
      assertPathAllowed,
      binding.fileIdentity,
    );
    return { requestedPath: binding.requestedPath, ...inspected };
  } catch (error) {
    if (error?.code === "PDF_RECOVERY_DIRECTORY_CHANGED") throw error;
    throw recoveryDirectoryChangedError(error);
  }
}

async function inspectDanglingPdfInputAlias(binding, {
  fileSystem,
  assertPathAllowed,
  allowPresentTarget,
}) {
  try {
    assertPathAllowed(binding.aliasPath);
    const before = await fileSystem.lstat(binding.aliasPath, { bigint: true });
    if (!before.isSymbolicLink()) throw pdfInputAliasChangedError();
    const linkTarget = await fileSystem.readlink(binding.aliasPath);
    const after = await fileSystem.lstat(binding.aliasPath, { bigint: true });
    const identity = stableSymlinkIdentity(after);
    if (
      !after.isSymbolicLink()
      || !sameFileIdentity(before, after)
      || !sameStableSymlinkIdentity(identity, binding.aliasIdentity)
      || linkTarget !== binding.linkTarget
    ) {
      throw pdfInputAliasChangedError();
    }

    const resolvedTargetPath = path.resolve(path.dirname(binding.aliasPath), linkTarget);
    if (resolvedTargetPath !== binding.resolvedTargetPath) throw pdfInputAliasChangedError();
    assertPathAllowed(resolvedTargetPath);
    const recoveryDirectory = await assertCanonicalRecoveryDirectory(
      binding.recoveryDirectory,
      { fileSystem, assertPathAllowed },
    );
    const expectedCanonicalPath = path.join(
      recoveryDirectory.canonicalPath,
      path.basename(resolvedTargetPath),
    );
    if (expectedCanonicalPath !== binding.expectedCanonicalPath) {
      throw pdfInputAliasChangedError();
    }

    let targetStats;
    try {
      targetStats = await fileSystem.lstat(resolvedTargetPath, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") return binding;
      throw error;
    }
    if (!allowPresentTarget || !targetStats.isFile() || targetStats.isSymbolicLink()) {
      throw pdfInputAliasUnsafeError();
    }
    const canonicalTargetPath = await fileSystem.realpath(resolvedTargetPath);
    assertPathAllowed(canonicalTargetPath);
    if (canonicalTargetPath !== binding.expectedCanonicalPath) {
      throw pdfInputAliasUnsafeError();
    }
    return binding;
  } catch (error) {
    if (
      error?.code === "PDF_INPUT_ALIAS_CHANGED"
      || error?.code === "PDF_INPUT_ALIAS_UNSAFE"
      || error?.code === "PDF_RECOVERY_DIRECTORY_CHANGED"
    ) {
      throw error;
    }
    if (PATH_RACE_ERROR_CODES.has(error?.code)) throw pdfInputAliasChangedError(error);
    throw pdfInputAliasUnsafeError(error);
  }
}

export async function bindDanglingPdfInputAlias(aliasPath, {
  fileSystem = defaultFileSystem,
  assertPathAllowed,
} = {}) {
  if (typeof assertPathAllowed !== "function") {
    throw new TypeError("bindDanglingPdfInputAlias requires an allowed-path policy.");
  }
  const resolvedAliasPath = path.resolve(aliasPath);
  try {
    assertPathAllowed(resolvedAliasPath);
    const before = await fileSystem.lstat(resolvedAliasPath, { bigint: true });
    if (!before.isSymbolicLink()) throw pdfInputAliasUnsafeError();
    const linkTarget = await fileSystem.readlink(resolvedAliasPath);
    const after = await fileSystem.lstat(resolvedAliasPath, { bigint: true });
    if (!after.isSymbolicLink() || !sameFileIdentity(before, after)) {
      throw pdfInputAliasChangedError();
    }
    const resolvedTargetPath = path.resolve(path.dirname(resolvedAliasPath), linkTarget);
    assertPathAllowed(resolvedTargetPath);
    const recoveryDirectory = await bindCanonicalRecoveryDirectory(
      path.dirname(resolvedTargetPath),
      { fileSystem, assertPathAllowed },
    );
    const binding = {
      aliasPath: resolvedAliasPath,
      aliasIdentity: stableSymlinkIdentity(after),
      linkTarget,
      resolvedTargetPath,
      expectedCanonicalPath: path.join(
        recoveryDirectory.canonicalPath,
        path.basename(resolvedTargetPath),
      ),
      recoveryDirectory,
    };
    return await inspectDanglingPdfInputAlias(binding, {
      fileSystem,
      assertPathAllowed,
      allowPresentTarget: false,
    });
  } catch (error) {
    if (
      error?.code === "PDF_INPUT_ALIAS_CHANGED"
      || error?.code === "PDF_INPUT_ALIAS_UNSAFE"
      || error?.code === "PDF_RECOVERY_DIRECTORY_CHANGED"
    ) {
      throw error;
    }
    if (PATH_RACE_ERROR_CODES.has(error?.code)) throw pdfInputAliasChangedError(error);
    throw pdfInputAliasUnsafeError(error);
  }
}

export async function assertDanglingPdfInputAlias(binding, {
  fileSystem = defaultFileSystem,
  assertPathAllowed,
  allowPresentTarget = true,
} = {}) {
  if (
    !binding
    || typeof binding.aliasPath !== "string"
    || typeof binding.linkTarget !== "string"
    || typeof binding.resolvedTargetPath !== "string"
    || typeof binding.expectedCanonicalPath !== "string"
    || !isStableSymlinkIdentity(binding.aliasIdentity)
    || typeof assertPathAllowed !== "function"
  ) {
    throw new TypeError("assertDanglingPdfInputAlias requires a valid binding and allowed-path policy.");
  }
  return await inspectDanglingPdfInputAlias(binding, {
    fileSystem,
    assertPathAllowed,
    allowPresentTarget,
  });
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
  const recoveryDirectory = await bindCanonicalRecoveryDirectory(
    path.dirname(canonicalPath),
    { fileSystem, assertPathAllowed },
  );
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
    await assertCanonicalRecoveryDirectory(recoveryDirectory, {
      fileSystem,
      assertPathAllowed,
    });
    return {
      sizeBytes,
      canonicalPath: canonicalAfter,
      fileIdentity: stableFileIdentity(after),
      recoveryDirectory,
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
  return await consumeBoundedPdfFileSafely(resolvedPath, maxBytes, {
    fileSystem,
    constants,
    assertPathAllowed,
    createSizeLimitError,
  }, async (handle, sizeBytes) => {
    const bytes = Buffer.allocUnsafe(sizeBytes);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await raceAware(() => handle.read(bytes, offset, bytes.length - offset, offset));
      if (bytesRead === 0) throw pdfChangedError();
      offset += bytesRead;
    }
    return { bytes };
  });
}

/**
 * Consume one bounded PDF while its read-only, no-follow descriptor remains
 * open. The callback receives the exact bytes and digest authorized by the
 * race-aware pathname/descriptor checks. Identity is checked again only after
 * the callback completes, so semantic parsers can never silently switch to a
 * replacement pathname during one operation.
 */
export async function withBoundedPdfFileSafely(resolvedPath, maxBytes, {
  fileSystem = defaultFileSystem,
  constants = defaultFsConstants,
  assertPathAllowed,
  createSizeLimitError = () => new Error(PDF_TOO_LARGE_MESSAGE),
} = {}, consume) {
  if (typeof consume !== "function") {
    throw new TypeError("consume must be a function.");
  }
  return await consumeBoundedPdfFileSafely(resolvedPath, maxBytes, {
    fileSystem,
    constants,
    assertPathAllowed,
    createSizeLimitError,
  }, async (handle, sizeBytes, sourceIdentity) => {
    const bytes = Buffer.allocUnsafe(sizeBytes);
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await raceAware(
        () => handle.read(bytes, offset, bytes.length - offset, offset),
      );
      if (bytesRead === 0) throw pdfChangedError();
      hash.update(bytes.subarray(offset, offset + bytesRead));
      offset += bytesRead;
    }
    return {
      value: await consume({
        ...sourceIdentity,
        bytes,
        sha256: hash.digest("hex"),
        sizeBytes,
      }),
    };
  }).then(({ value }) => value);
}

async function consumeBoundedPdfFileSafely(
  resolvedPath,
  maxBytes,
  {
    fileSystem,
    constants,
    assertPathAllowed,
    createSizeLimitError,
  },
  consume,
) {
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
    const consumed = await consume(handle, sizeBytes, {
      canonicalPath,
      fileIdentity: stableFileIdentity(before),
    });

    const after = await raceAware(() => handle.stat({ bigint: true }));
    if (!sameFileIdentity(before, after)) throw pdfChangedError();

    const pathAfter = await raceAware(() => fileSystem.lstat(canonicalPath, { bigint: true }));
    if (!pathAfter.isFile() || !sameFileIdentity(after, pathAfter)) throw pdfChangedError();

    const canonicalFromRequestedPath = await raceAware(() => fileSystem.realpath(resolvedPath));
    if (canonicalFromRequestedPath !== canonicalPath) throw pdfChangedError();
    const canonicalAfter = await raceAware(() => fileSystem.realpath(canonicalPath));
    if (canonicalAfter !== canonicalPath) throw pdfChangedError();
    assertPathAllowed(canonicalAfter);
    return {
      ...consumed,
      sizeBytes,
      canonicalPath: canonicalAfter,
      fileIdentity: stableFileIdentity(after),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Hash a bounded regular file from one descriptor without allocating the
 * complete file while rejecting the same observable pathname and inode races
 * as the byte reader.
 */
export async function hashBoundedPdfFileSafely(resolvedPath, maxBytes, {
  fileSystem = defaultFileSystem,
  constants = defaultFsConstants,
  assertPathAllowed,
  createSizeLimitError = () => new Error(PDF_TOO_LARGE_MESSAGE),
  chunkBytes = PDF_HASH_CHUNK_BYTES,
} = {}) {
  if (
    !Number.isSafeInteger(chunkBytes)
    || chunkBytes < 1
    || chunkBytes > PDF_HASH_MAX_CHUNK_BYTES
  ) {
    throw new TypeError(
      `chunkBytes must be a positive safe integer no greater than ${PDF_HASH_MAX_CHUNK_BYTES}.`,
    );
  }
  const { headerValid, ...identity } = await consumeBoundedPdfFileSafely(resolvedPath, maxBytes, {
    fileSystem,
    constants,
    assertPathAllowed,
    createSizeLimitError,
  }, async (handle, sizeBytes) => {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, Math.max(sizeBytes, 1)));
    const headerWindow = Buffer.allocUnsafe(Math.min(sizeBytes, PDF_HEADER_WINDOW_BYTES));
    if (headerWindow.length === 0) return { headerValid: false };
    let headerBytes = 0;
    let offset = 0;
    while (offset < sizeBytes) {
      const headerRemaining = headerWindow.length - headerBytes;
      const length = Math.min(
        buffer.length,
        sizeBytes - offset,
        headerRemaining > 0 ? headerRemaining : Number.POSITIVE_INFINITY,
      );
      const { bytesRead } = await raceAware(() => handle.read(buffer, 0, length, offset));
      if (bytesRead === 0) throw pdfChangedError();
      if (headerBytes < headerWindow.length) {
        const copied = Math.min(bytesRead, headerWindow.length - headerBytes);
        buffer.copy(headerWindow, headerBytes, 0, copied);
        headerBytes += copied;
      }
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
      if (
        headerBytes === headerWindow.length
        && headerWindow.indexOf(PDF_HEADER_MAGIC) < 0
      ) {
        return { headerValid: false };
      }
    }

    return {
      sha256: hash.digest("hex"),
      headerValid: true,
    };
  });
  if (!headerValid) throw pdfInvalidHeaderError();
  return identity;
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
