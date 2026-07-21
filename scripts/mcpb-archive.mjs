import { createHash, randomUUID } from "crypto";
import {
  lstatSync,
  openSync,
  closeSync,
  chmodSync,
  fsyncSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import path from "path";
import { unzipSync, zipSync } from "fflate";

const ZIP_EPOCH_MS = Date.UTC(1980, 0, 1, 0, 0, 0);
const ZIP_LAST_YEAR = 2099; // fflate 0.8.3's explicit DOS-date upper bound.
const FILE_MODE = 0o644;
const REGULAR_FILE_MODE = 0o100000 | FILE_MODE;

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

export function canonicalZipMtime(sourceDateEpoch = process.env.SOURCE_DATE_EPOCH) {
  let epochMs = ZIP_EPOCH_MS;
  if (sourceDateEpoch !== undefined && sourceDateEpoch !== "") {
    if (!/^[0-9]+$/.test(String(sourceDateEpoch))) {
      throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer number of seconds");
    }
    const seconds = Number(sourceDateEpoch);
    if (!Number.isSafeInteger(seconds)) {
      throw new Error("SOURCE_DATE_EPOCH is outside JavaScript's safe integer range");
    }
    epochMs = Math.max(seconds * 1000, ZIP_EPOCH_MS);
  }

  const utc = new Date(epochMs);
  if (Number.isNaN(utc.getTime()) || utc.getUTCFullYear() > ZIP_LAST_YEAR) {
    throw new Error(`SOURCE_DATE_EPOCH must resolve to a date no later than ${ZIP_LAST_YEAR}`);
  }

  // fflate serializes local Date fields. Constructing a local Date from the
  // desired UTC fields makes the DOS timestamp byte-identical in every TZ.
  return new Date(
    utc.getUTCFullYear(),
    utc.getUTCMonth(),
    utc.getUTCDate(),
    utc.getUTCHours(),
    utc.getUTCMinutes(),
    utc.getUTCSeconds() - (utc.getUTCSeconds() % 2),
    0,
  );
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

export function createCanonicalZip(expectedFiles, sourceDateEpoch = process.env.SOURCE_DATE_EPOCH) {
  const sorted = [...expectedFiles].sort((a, b) => compareArchivePaths(a.path, b.path));
  const unique = new Set();
  const mtime = canonicalZipMtime(sourceDateEpoch);
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

export function verifyCanonicalZip(bytes, expectedFiles, sourceDateEpoch = process.env.SOURCE_DATE_EPOCH) {
  const expected = [...expectedFiles].sort((a, b) => compareArchivePaths(a.path, b.path));
  const entries = readCentralDirectory(bytes);
  if (entries.length !== expected.length) {
    throw new Error(`Archive file count mismatch: ${entries.length} != ${expected.length}`);
  }
  const expectedTimestamp = dosFields(canonicalZipMtime(sourceDateEpoch));
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

  const unpacked = unzipSync(bytes);
  const unpackedPaths = Object.keys(unpacked).sort(compareArchivePaths);
  if (unpackedPaths.length !== expected.length) throw new Error("Unpacked archive path count mismatch");
  for (let index = 0; index < expected.length; index += 1) {
    const wanted = expected[index];
    if (unpackedPaths[index] !== wanted.path) throw new Error(`Unpacked archive parity mismatch: ${wanted.path}`);
    const actual = unpacked[wanted.path];
    if (actual.length !== wanted.size || sha256Bytes(actual) !== wanted.sha256) {
      throw new Error(`Unpacked archive content mismatch: ${wanted.path}`);
    }
  }
  return entries;
}

export function writeCanonicalBytesAtomic({
  bytes,
  expectedFiles,
  outputPath,
  sourceDateEpoch = process.env.SOURCE_DATE_EPOCH,
  beforeRename,
}) {
  const candidate = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.candidate-${process.pid}-${randomUUID()}`,
  );
  let descriptor;
  const outputDirectory = path.dirname(outputPath);
  const syncDirectory = () => {
    let directoryDescriptor;
    try {
      directoryDescriptor = openSync(outputDirectory, "r");
      fsyncSync(directoryDescriptor);
    } catch {
      // Directory fsync is unsupported on some filesystems/platforms. The
      // candidate file itself is always fsynced before activation.
    } finally {
      if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
    }
  };
  try {
    descriptor = openSync(candidate, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    chmodSync(candidate, 0o644);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    verifyCanonicalZip(readFileSync(candidate), expectedFiles, sourceDateEpoch);
    if (beforeRename) beforeRename(candidate);
    syncDirectory();
    renameSync(candidate, outputPath);
    syncDirectory();
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(candidate, { force: true });
    throw error;
  }
  return {
    bytes: statSync(outputPath).size,
    files: expectedFiles.length,
    sha256: sha256Bytes(readFileSync(outputPath)),
    expectedFiles,
  };
}

export function writeCanonicalMcpbAtomic({
  stagingDir,
  outputPath,
  sourceDateEpoch = process.env.SOURCE_DATE_EPOCH,
  beforeRename,
}) {
  const expectedFiles = buildExpectedFileManifest(stagingDir);
  const bytes = createCanonicalZip(expectedFiles, sourceDateEpoch);
  return writeCanonicalBytesAtomic({
    bytes,
    expectedFiles,
    outputPath,
    sourceDateEpoch,
    beforeRename,
  });
}

export const CANONICAL_FILE_MODE = FILE_MODE;
