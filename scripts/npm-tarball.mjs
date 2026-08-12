/*
 * Just enough of the npm registry to read a pinned tarball's own metadata.
 *
 * `scripts/vendor-npm-license-provenance.mjs` needs the `package.json` and the
 * licence texts that are actually inside the tarball `package-lock.json`
 * points at — not the ones inside `node_modules/`. The installed tree is a
 * platform-dependent projection of the lock: on any one machine roughly a
 * dozen locked packages are simply absent because their `os`/`cpu` did not
 * match, so a licence inventory derived from it can never be complete. The
 * tarball is the same artifact on every platform, and its digest is already
 * pinned, so it is the only source that is both complete and verifiable.
 *
 * The gzip and tar reading is done here rather than through a dependency
 * because this runs before any bill of materials exists, and adding a
 * dependency in order to describe the dependencies is a circularity worth
 * avoiding for sixty lines of format that has not changed since 1988.
 */

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const BLOCK_SIZE = 512;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Verifies an npm `integrity` value against the bytes it is supposed to
 * describe. npm writes `<algorithm>-<base64 digest>`; anything else is refused
 * rather than assumed to be fine.
 */
export function verifyIntegrity(bytes, integrity) {
  const match = /^(sha(?:1|256|384|512))-([A-Za-z0-9+/=]+)$/.exec(integrity || "");
  if (!match) throw new Error(`Unsupported npm integrity value: ${integrity}`);
  const actual = createHash(match[1]).update(bytes).digest("base64");
  if (actual !== match[2]) {
    throw new Error(`Tarball digest does not match the locked integrity: ${match[1]}-${actual} != ${integrity}`);
  }
  return true;
}

function readOctal(block, offset, length) {
  const raw = block.subarray(offset, offset + length).toString("ascii").replace(/\0.*$/, "").trim();
  if (raw === "") return 0;
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Malformed tar numeric field: ${JSON.stringify(raw)}`);
  }
  return value;
}

function readString(block, offset, length) {
  return block.subarray(offset, offset + length).toString("utf8").replace(/\0.*$/, "");
}

/**
 * Reads every regular file out of a gzipped tar, returning a Map of POSIX path
 * to bytes. Unknown entry types are skipped rather than guessed at, except for
 * the long-name extensions, which are honoured so a long path cannot silently
 * become the wrong path.
 */
export function readGzippedTarFiles(gzippedBytes) {
  const bytes = gunzipSync(gzippedBytes);
  const files = new Map();
  let offset = 0;
  let pendingLongName = null;
  while (offset + BLOCK_SIZE <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK_SIZE);
    if (header.every(byte => byte === 0)) break;
    const typeFlag = String.fromCharCode(header[156]) || "0";
    const size = readOctal(header, 124, 12);
    const dataStart = offset + BLOCK_SIZE;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) throw new Error("Truncated tar entry");
    const prefix = readString(header, 345, 155);
    const rawName = readString(header, 0, 100);
    const name = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    pendingLongName = null;
    if (typeFlag === "L") {
      pendingLongName = bytes.subarray(dataStart, dataEnd).toString("utf8").replace(/\0.*$/, "");
    } else if (typeFlag === "0" || typeFlag === "\0" || typeFlag === "7") {
      files.set(name.replace(/\/+$/, ""), Buffer.from(bytes.subarray(dataStart, dataEnd)));
    }
    offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  return files;
}

/**
 * Downloads the exact tarball the lock pins, refuses it unless its bytes match
 * the locked integrity digest, and returns its files.
 */
export async function fetchLockedTarballFiles(resolved, integrity) {
  const response = await fetch(resolved);
  if (!response.ok) throw new Error(`Registry fetch failed for ${resolved}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyIntegrity(bytes, integrity);
  return { files: readGzippedTarFiles(bytes), tarballSha256: sha256(bytes) };
}
