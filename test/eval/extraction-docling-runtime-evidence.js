import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "./extraction-docling-handoff-verifier.js";

const MAX_FILES = 50000;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function within(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function stableFileRecord(filename, relativePath) {
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(MAX_FILE_BYTES)) {
      throw new Error(`Runtime evidence file violates its bounded contract: ${relativePath}`);
    }
    const digest = createHash("sha256");
    let observed = 0;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (observed <= MAX_FILE_BYTES) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, MAX_FILE_BYTES + 1 - observed), observed);
      if (bytesRead === 0) break;
      observed += bytesRead;
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    for (const property of ["dev", "ino", "nlink", "size", "mtimeNs", "ctimeNs"]) {
      if (String(before[property]) !== String(after[property])) throw new Error(`Runtime evidence file changed while read: ${relativePath}`);
    }
    if (BigInt(observed) !== before.size) throw new Error(`Runtime evidence file length changed while read: ${relativePath}`);
    return {
      path: relativePath, type: "file", mode: Number(before.mode & 0o777n), links: Number(before.nlink),
      bytes: observed, sha256: digest.digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

async function walk(rootLabel, root, allowedRoots, records, state, relative = "") {
  const directory = relative ? path.join(root, relative) : root;
  const metadata = await fs.lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Runtime evidence root is not a real directory: ${rootLabel}`);
  records.push({ path: relative ? `${rootLabel}/${relative}` : rootLabel, type: "directory", mode: metadata.mode & 0o777 });
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) throw new Error("Runtime environment contains forbidden Python bytecode drift");
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const child = path.join(root, childRelative);
    const recordPath = `${rootLabel}/${childRelative.split(path.sep).join("/")}`;
    state.files += 1;
    if (state.files > MAX_FILES) throw new Error("Runtime environment exceeds the file-count evidence ceiling");
    const childMetadata = await fs.lstat(child);
    if (childMetadata.isSymbolicLink()) {
      const target = await fs.readlink(child);
      const resolved = path.resolve(path.dirname(child), target);
      if (!allowedRoots.some(allowed => within(allowed, resolved))) throw new Error(`Runtime symlink escapes the anchored roots: ${recordPath}`);
      records.push({ path: recordPath, type: "symlink", mode: childMetadata.mode & 0o777, target });
    } else if (childMetadata.isDirectory()) {
      await walk(rootLabel, root, allowedRoots, records, state, childRelative);
    } else if (childMetadata.isFile()) {
      const record = await stableFileRecord(child, recordPath);
      state.bytes += record.bytes;
      if (state.bytes > MAX_TOTAL_BYTES) throw new Error("Runtime environment exceeds the aggregate evidence ceiling");
      records.push(record);
    } else {
      throw new Error(`Runtime environment contains an unsupported filesystem entry: ${recordPath}`);
    }
  }
}

export async function captureDoclingRuntimeInventory(receipt) {
  if (!receipt?.toolchain?.uv || !receipt.platform) throw new Error("Runtime evidence requires the receipt-bound host and uv toolchain identity");
  const roots = {
    managed_python: receipt.roots.uv_python_install,
    venv: path.join(receipt.roots.sidecar_snapshot, "venv"),
    models: receipt.roots.models,
  };
  const allowedRoots = Object.values(roots).map(value => path.resolve(value));
  const records = [];
  const state = { files: 0, bytes: 0 };
  for (const [label, root] of Object.entries(roots)) await walk(label, path.resolve(root), allowedRoots, records, state);
  const lockPath = path.join(receipt.roots.sidecar_snapshot, "requirements.lock");
  const lock = await stableFileRecord(lockPath, "requirements.lock");
  state.bytes += lock.bytes;
  if (state.bytes > MAX_TOTAL_BYTES) throw new Error("Runtime environment exceeds the aggregate evidence ceiling");
  records.push(lock);
  const uv = await stableFileRecord(receipt.toolchain.uv.path, "toolchain/uv");
  if (uv.bytes !== receipt.toolchain.uv.bytes || uv.sha256 !== receipt.toolchain.uv.sha256) {
    throw new Error("Runtime evidence uv binary differs from the receipt-bound toolchain");
  }
  state.bytes += uv.bytes;
  if (state.bytes > MAX_TOTAL_BYTES) throw new Error("Runtime environment exceeds the aggregate evidence ceiling");
  records.push(uv);
  records.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const inventory = {
    inventory_id: "pdf-tools.docling-runtime-inventory.v1",
    handoff_id: receipt.handoff_id,
    records,
    entry_count: records.length,
    total_file_bytes: state.bytes,
    uv_version: receipt.toolchain.uv.version,
    platform: receipt.platform,
  };
  return { ...inventory, inventory_sha256: sha256(Buffer.from(`pdf-tools.docling-runtime-inventory.v1\0${canonicalJson(inventory)}`)) };
}

export function attestThreeFreshProcessStability({ before, after, processes }) {
  if (!before || !Array.isArray(after) || after.length !== 3 || !Array.isArray(processes) || processes.length !== 3) {
    throw new Error("Docling runtime evidence requires exactly three fresh processes and three post-run inventories");
  }
  const processIds = new Set();
  const requestDigests = new Set();
  const sourceDigests = new Set();
  const responseDigests = new Set();
  for (const process of processes) {
    if (!Number.isInteger(process.pid) || process.pid < 1 || processIds.has(process.pid) || process.exit_code !== 0
      || ![process.request_sha256, process.source_sha256, process.response_sha256].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) {
      throw new Error("Docling runtime evidence contains an invalid or reused process result");
    }
    processIds.add(process.pid);
    requestDigests.add(process.request_sha256);
    sourceDigests.add(process.source_sha256);
    responseDigests.add(process.response_sha256);
  }
  if (requestDigests.size !== 1 || sourceDigests.size !== 1 || responseDigests.size !== 1) {
    throw new Error("Docling runtime evidence does not prove deterministic responses for one identical request and source");
  }
  if (after.some(inventory => inventory.inventory_sha256 !== before.inventory_sha256)) {
    throw new Error("Docling runtime inventory drifted across fresh processes");
  }
  return {
    evidence_id: "pdf-tools.docling-three-process-stability.v1",
    handoff_id: before.handoff_id,
    baseline_inventory_sha256: before.inventory_sha256,
    process_ids: [...processIds],
    request_sha256: [...requestDigests][0],
    source_sha256: [...sourceDigests][0],
    response_sha256: [...responseDigests][0],
    stable: true,
  };
}
