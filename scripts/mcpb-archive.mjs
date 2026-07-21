import { createHash, randomUUID } from "crypto";
import {
  lstatSync,
  openSync,
  closeSync,
  chmodSync,
  fsyncSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import path from "path";
import { zipSync } from "fflate";

const FILE_MODE = 0o644;
const REGULAR_FILE_MODE = 0o100000 | FILE_MODE;
const UNSUPPORTED_DIRECTORY_FSYNC_ERRORS = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR"]);

export class McpbPostActivationDurabilityError extends Error {
  constructor(message, { cause, outputPath, sha256, bytes }) {
    super(message, { cause });
    this.name = "McpbPostActivationDurabilityError";
    this.activated = true;
    this.outputPath = outputPath;
    this.sha256 = sha256;
    this.bytes = bytes;
  }
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(filename) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(filename, "r");
  try {
    let bytesRead;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function compareArchivePaths(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function assertSafeArchivePath(relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    relativePath.startsWith("/") ||
    /^[A-Za-z]:/.test(relativePath)
  ) {
    throw new Error(`Unsafe archive path: ${JSON.stringify(relativePath)}`);
  }

  const parts = relativePath.split("/");
  if (parts.some(part => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe archive path: ${JSON.stringify(relativePath)}`);
  }
  if (path.posix.normalize(relativePath) !== relativePath) {
    throw new Error(`Non-canonical archive path: ${JSON.stringify(relativePath)}`);
  }
  return relativePath;
}

export function canonicalZipMtime() {
  // fflate writes local Date fields into the DOS header. This local constructor
  // therefore encodes the same literal 1980-01-01 00:00 fields in every TZ,
  // including DST-transition zones. SOURCE_DATE_EPOCH is intentionally ignored.
  return new Date(1980, 0, 1, 0, 0, 0, 0);
}

export function collectRegularFiles(rootDir) {
  const root = path.resolve(rootDir);
  const files = [];

  function visit(directory) {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => compareArchivePaths(a.name, b.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const metadata = lstatSync(absolutePath);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      assertSafeArchivePath(relativePath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Archive stage contains a symbolic link: ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        visit(absolutePath);
      } else if (metadata.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error(`Archive stage contains a non-regular entry: ${relativePath}`);
      }
    }
  }

  visit(root);
  return files;
}

export function buildExpectedFileManifest(rootDir) {
  const files = collectRegularFiles(rootDir);
  return files.map(relativePath => {
    const bytes = readFileSync(path.join(rootDir, ...relativePath.split("/")));
    return {
      path: relativePath,
      bytes,
      size: bytes.length,
      sha256: sha256Bytes(bytes),
      mode: FILE_MODE,
    };
  });
}

export function createCanonicalZip(expectedFiles) {
  const sorted = [...expectedFiles].sort((a, b) => compareArchivePaths(a.path, b.path));
  const unique = new Set();
  const mtime = canonicalZipMtime();
  const inputs = {};
  for (const file of sorted) {
    assertSafeArchivePath(file.path);
    if (unique.has(file.path)) throw new Error(`Duplicate archive path: ${file.path}`);
    unique.add(file.path);
    inputs[file.path] = [file.bytes, { os: 3, attrs: REGULAR_FILE_MODE << 16, mtime, level: 9 }];
  }
  return zipSync(inputs, { os: 3, attrs: REGULAR_FILE_MODE << 16, mtime, level: 9 });
}

function findEndOfCentralDirectory(bytes) {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("ZIP end-of-central-directory record is missing");
}

export function readCentralDirectory(bytes) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(buffer);
  if (buffer.readUInt16LE(eocd + 20) !== 0 || eocd + 22 !== buffer.length) {
    throw new Error("ZIP must have no EOCD comment or trailing bytes");
  }
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported by the canonical MCPB verifier");
  }
  if (centralOffset + centralSize > eocd) throw new Error("ZIP central directory is out of bounds");

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central-directory entry at offset ${cursor}`);
    }
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > centralOffset + centralSize) throw new Error("Truncated ZIP central-directory entry");
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    entries.push({
      path: name,
      os: buffer[cursor + 5],
      compression: buffer.readUInt16LE(cursor + 10),
      dosTime: buffer.readUInt16LE(cursor + 12),
      dosDate: buffer.readUInt16LE(cursor + 14),
      crc32: buffer.readUInt32LE(cursor + 16),
      compressedSize: buffer.readUInt32LE(cursor + 20),
      size: buffer.readUInt32LE(cursor + 24),
      unixMode: (buffer.readUInt32LE(cursor + 38) >>> 16) & 0xffff,
      mode: (buffer.readUInt32LE(cursor + 38) >>> 16) & 0o777,
      extraLength,
      commentLength,
    });
    cursor = end;
  }
  if (cursor !== centralOffset + centralSize) throw new Error("ZIP central-directory size mismatch");
  return entries;
}

function dosFields(date) {
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    dosDate: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function verifyCanonicalZip(bytes, expectedFiles) {
  const expected = [...expectedFiles].sort((a, b) => compareArchivePaths(a.path, b.path));
  const canonical = createCanonicalZip(expected);
  if (!Buffer.from(bytes).equals(Buffer.from(canonical))) {
    throw new Error("Archive bytes do not exactly match the canonical encoding");
  }
  const entries = readCentralDirectory(bytes);
  if (entries.length !== expected.length) {
    throw new Error(`Archive file count mismatch: ${entries.length} != ${expected.length}`);
  }
  const expectedTimestamp = dosFields(canonicalZipMtime());
  const seen = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const wanted = expected[index];
    assertSafeArchivePath(entry.path);
    if (seen.has(entry.path)) throw new Error(`Duplicate archive path: ${entry.path}`);
    seen.add(entry.path);
    if (entry.path !== wanted.path) {
      throw new Error(`Archive order/path mismatch at ${index}: ${entry.path} != ${wanted.path}`);
    }
    if (entry.os !== 3 || entry.unixMode !== REGULAR_FILE_MODE || entry.mode !== FILE_MODE) {
      throw new Error(`Archive mode metadata is not canonical for ${entry.path}`);
    }
    if (entry.dosTime !== expectedTimestamp.dosTime || entry.dosDate !== expectedTimestamp.dosDate) {
      throw new Error(`Archive timestamp is not canonical for ${entry.path}`);
    }
    if (entry.extraLength !== 0 || entry.commentLength !== 0) {
      throw new Error(`Archive contains extra metadata for ${entry.path}`);
    }
    if (entry.compression !== 8) throw new Error(`Archive compression is not canonical for ${entry.path}`);
    if (entry.size !== wanted.size) throw new Error(`Archive size mismatch for ${entry.path}`);
  }

  return entries;
}

function defaultDirectoryFsync(directory) {
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(directory, directoryFsync) {
  try {
    directoryFsync(directory);
  } catch (error) {
    if (!UNSUPPORTED_DIRECTORY_FSYNC_ERRORS.has(error?.code)) throw error;
  }
}

export function writeCanonicalBytesAtomic({
  bytes,
  expectedFiles,
  outputPath,
  canonicalVerified = false,
  beforeRename,
  operations = {},
}) {
  const candidate = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.candidate-${process.pid}-${randomUUID()}`,
  );
  let descriptor;
  const fileFsync = operations.fileFsync || fsyncSync;
  const remove = operations.remove || (filename => rmSync(filename, { force: true }));
  try {
    descriptor = openSync(candidate, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    chmodSync(candidate, 0o644);
    fileFsync(descriptor);
    const completedDescriptor = descriptor;
    descriptor = undefined;
    closeSync(completedDescriptor);
    if (canonicalVerified) {
      if (statSync(candidate).size !== bytes.length || sha256File(candidate) !== sha256Bytes(bytes)) {
        throw new Error("Candidate bytes changed while being written");
      }
    } else {
      verifyCanonicalZip(readFileSync(candidate), expectedFiles);
    }
    if (beforeRename) beforeRename(candidate);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    remove(candidate);
    throw error;
  }
  const activated = activateCanonicalCandidateAtomic({
    candidatePath: candidate,
    outputPath,
    expectedSha256: sha256Bytes(bytes),
    expectedBytes: bytes.length,
    operations,
  });
  return {
    bytes: activated.bytes,
    files: expectedFiles.length,
    sha256: activated.sha256,
  };
}

export function writeCanonicalMcpbAtomic({
  stagingDir,
  outputPath,
  beforeRename,
  operations,
}) {
  const expectedFiles = buildExpectedFileManifest(stagingDir);
  const bytes = createCanonicalZip(expectedFiles);
  return writeCanonicalBytesAtomic({
    bytes,
    expectedFiles,
    outputPath,
    beforeRename,
    operations,
  });
}

export function activateCanonicalCandidateAtomic({
  candidatePath,
  outputPath,
  expectedSha256,
  expectedBytes,
  operations = {},
}) {
  const outputDirectory = path.dirname(outputPath);
  if (path.dirname(candidatePath) !== outputDirectory) {
    throw new Error("Canonical candidate must be a sibling of the output for atomic activation");
  }
  const fileFsync = operations.fileFsync || fsyncSync;
  const directoryFsync = operations.directoryFsync || defaultDirectoryFsync;
  const rename = operations.rename || renameSync;
  const remove = operations.remove || (filename => rmSync(filename, { force: true }));
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 || "") || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    throw new Error("Canonical activation requires an expected SHA-256 and byte length");
  }
  let descriptor;
  let renamed = false;
  try {
    descriptor = openSync(candidatePath, "r");
    fileFsync(descriptor);
    const completedDescriptor = descriptor;
    descriptor = undefined;
    closeSync(completedDescriptor);
    syncDirectory(outputDirectory, directoryFsync);
    if (operations.beforeRename) operations.beforeRename(candidatePath);
    const candidateMetadata = lstatSync(candidatePath);
    if (
      !candidateMetadata.isFile() ||
      candidateMetadata.isSymbolicLink() ||
      candidateMetadata.size !== expectedBytes ||
      sha256File(candidatePath) !== expectedSha256
    ) {
      throw new Error("Canonical candidate changed before atomic activation");
    }
    rename(candidatePath, outputPath);
    renamed = true;
    syncDirectory(outputDirectory, directoryFsync);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!renamed) {
      remove(candidatePath);
      throw error;
    }
    let bytes = expectedBytes;
    let sha256 = expectedSha256;
    try {
      bytes = statSync(outputPath).size;
      sha256 = sha256File(outputPath);
    } catch {
      // Preserve the expected identity when post-rename evidence cannot be read.
    }
    throw new McpbPostActivationDurabilityError(
      "MCPB candidate was activated, but post-rename directory fsync failed; the new output is present but crash durability is not confirmed",
      { cause: error, outputPath, sha256, bytes },
    );
  }
  const result = {
    bytes: statSync(outputPath).size,
    sha256: sha256File(outputPath),
    activated: true,
  };
  if (result.bytes !== expectedBytes || result.sha256 !== expectedSha256) {
    throw new McpbPostActivationDurabilityError(
      "MCPB was activated, but its post-rename identity does not match the verified candidate",
      {
        cause: new Error(`Expected ${expectedBytes} bytes/${expectedSha256}; found ${result.bytes} bytes/${result.sha256}`),
        outputPath,
        sha256: result.sha256,
        bytes: result.bytes,
      },
    );
  }
  return result;
}

export const CANONICAL_FILE_MODE = FILE_MODE;
