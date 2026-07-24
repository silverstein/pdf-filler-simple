import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_ENTRIES = 50000;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const PORTABLE_RUNTIME_SYMLINK_MODES = Object.freeze([0o700, 0o755, 0o777]);
const SHA256 = /^[a-f0-9]{64}$/;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function within(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function isCanonicalRecordPath(value) {
  return typeof value === "string" && value.length >= 1 && !value.includes("\\") && !value.startsWith("/") && path.posix.normalize(value) === value
    && value.split("/").every(component => component && component !== "." && component !== "..");
}

function isFinalizedBytecodePath(recordPath) {
  const components = recordPath.split("/");
  return components.slice(1).includes("__pycache__") || components.at(-1).endsWith(".pyc");
}

function buildFinalizedBytecodeAuthority(receipt, finalization) {
  if (!finalization || typeof finalization !== "object" || Array.isArray(finalization)
    || finalization.protocol !== "pdf-tools.docling-finalization.v1"
    || finalization.handoff_id !== receipt.handoff_id || !SHA256.test(finalization.receipt_sha256 ?? "")
    || !SHA256.test(finalization.finalization_id ?? "")
    || finalization.execution_state !== "setup_complete_not_executed"
    || !Array.isArray(finalization.managed_python_files) || !Array.isArray(finalization.venv_files)) {
    throw new Error("Runtime capture requires a valid receipt-bound finalization");
  }
  const { finalization_id: finalizationId, ...core } = finalization;
  if (finalizationId !== sha256(Buffer.from(`pdf-tools.docling-finalization.v1\0${canonicalJson(core)}`))) {
    throw new Error("Runtime capture finalization digest is invalid");
  }

  const authority = new Map();
  for (const [label, entries] of [["managed_python", finalization.managed_python_files], ["venv", finalization.venv_files]]) {
    for (const entry of entries) {
      if (!isCanonicalRecordPath(entry?.relative_path)) throw new Error("Finalized runtime record path is invalid");
      const recordPath = `${label}/${entry.relative_path}`;
      if (!isFinalizedBytecodePath(recordPath)) continue;
      const basename = entry.relative_path.split("/").at(-1);
      let record;
      if (entry.type === "directory" && basename === "__pycache__"
        && [0o700, 0o755].includes(entry.mode) && Number.isInteger(entry.links) && entry.links >= 1) {
        record = { path: recordPath, type: "directory", mode: entry.mode, links: entry.links };
      } else if (entry.type === "file" && basename.endsWith(".pyc")
        && [0o600, 0o644, 0o700, 0o711, 0o755].includes(entry.mode)
        && Number.isInteger(entry.links) && entry.links >= 1 && Number.isInteger(entry.bytes) && entry.bytes >= 0
        && SHA256.test(entry.sha256 ?? "")) {
        record = { path: recordPath, type: "file", mode: entry.mode, links: entry.links, bytes: entry.bytes, sha256: entry.sha256 };
      } else {
        throw new Error(`Finalization contains unauthorized Python bytecode record: ${recordPath}`);
      }
      if (authority.has(recordPath)) throw new Error(`Finalization contains duplicate Python bytecode authority: ${recordPath}`);
      authority.set(recordPath, record);
    }
  }
  return authority;
}

function acceptFinalizedBytecodeRecord(record, authority, observed) {
  if (!isFinalizedBytecodePath(record.path)) return;
  const expected = authority.get(record.path);
  if (!expected || canonicalJson(expected) !== canonicalJson(record) || observed.has(record.path)) {
    throw new Error(`Runtime Python bytecode differs from finalization: ${record.path}`);
  }
  observed.add(record.path);
}

async function stableFileSnapshot(filename, recordPath, { allowOwnerExecuteOnly = false } = {}) {
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    const mode = Number(before.mode & 0o777n);
    const allowedModes = allowOwnerExecuteOnly ? [0o600, 0o644, 0o700, 0o711, 0o755] : [0o600, 0o644, 0o700, 0o755];
    if (!before.isFile() || before.size > BigInt(MAX_FILE_BYTES) || before.nlink < 1n || !allowedModes.includes(mode)) {
      throw new Error(`Runtime file violates mode/link/size policy: ${recordPath}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    for (const property of ["dev", "ino", "nlink", "size", "mtimeNs", "ctimeNs"]) {
      if (String(before[property]) !== String(after[property])) throw new Error(`Runtime file changed while read: ${recordPath}`);
    }
    return { bytes, record: { path: recordPath, type: "file", mode, links: Number(before.nlink), bytes: bytes.length, sha256: sha256(bytes) } };
  } finally { await handle.close(); }
}

async function stableFileRecord(filename, recordPath, options) {
  return (await stableFileSnapshot(filename, recordPath, options)).record;
}

async function walk(label, root, allowedRoots, records, state, bytecodeAuthority, observedBytecode, relative = "", allowPrivateRuntimeModes = false) {
  const directory = relative ? path.join(root, relative) : root;
  const metadata = await fs.lstat(directory);
  const mode = metadata.mode & 0o777;
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.nlink < 1 || ![0o700, 0o755].includes(mode)) {
    throw new Error(`Runtime directory violates mode/link policy: ${label}`);
  }
  const directoryRecord = { path: relative ? `${label}/${relative.split(path.sep).join("/")}` : label, type: "directory", mode, links: metadata.nlink };
  acceptFinalizedBytecodeRecord(directoryRecord, bytecodeAuthority, observedBytecode);
  records.push(directoryRecord);
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (++state.entries > MAX_ENTRIES) throw new Error("Runtime environment exceeds the entry-count ceiling");
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const child = path.join(root, childRelative);
    const recordPath = `${label}/${childRelative.split(path.sep).join("/")}`;
    const childMetadata = await fs.lstat(child);
    if (childMetadata.isSymbolicLink()) {
      const target = await fs.readlink(child);
      const resolved = path.resolve(path.dirname(child), target);
      const symlinkMode = childMetadata.mode & 0o777;
      if (!allowPrivateRuntimeModes || childMetadata.nlink !== 1 || !PORTABLE_RUNTIME_SYMLINK_MODES.includes(symlinkMode)
        || !allowedRoots.some(rootPath => within(rootPath, resolved))) {
        throw new Error(`Runtime symlink violates link/containment policy: ${recordPath}`);
      }
      const record = { path: recordPath, type: "symlink", mode: symlinkMode, links: 1, target };
      acceptFinalizedBytecodeRecord(record, bytecodeAuthority, observedBytecode);
      records.push(record);
    } else if (childMetadata.isDirectory()) await walk(label, root, allowedRoots, records, state, bytecodeAuthority, observedBytecode, childRelative, allowPrivateRuntimeModes);
    else if (childMetadata.isFile()) {
      const record = await stableFileRecord(child, recordPath, { allowOwnerExecuteOnly: allowPrivateRuntimeModes });
      state.bytes += record.bytes;
      if (state.bytes > MAX_TOTAL_BYTES) throw new Error("Runtime environment exceeds the aggregate byte ceiling");
      acceptFinalizedBytecodeRecord(record, bytecodeAuthority, observedBytecode);
      records.push(record);
    } else throw new Error(`Runtime environment contains an unsupported entry: ${recordPath}`);
  }
}

export function validateDoclingRuntimeInventory(inventory) {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)
    || canonicalJson(Object.keys(inventory).sort()) !== canonicalJson(["entry_count", "handoff_id", "inventory_id", "inventory_sha256", "platform", "records", "total_file_bytes", "uv_version"])
    || inventory.inventory_id !== "pdf-tools.docling-runtime-inventory.v1" || !SHA256.test(inventory.handoff_id ?? "")
    || !Array.isArray(inventory.records) || inventory.records.length < 1 || inventory.records.length > MAX_ENTRIES + 16
    || inventory.entry_count !== inventory.records.length || !Number.isInteger(inventory.total_file_bytes) || inventory.total_file_bytes < 0) {
    throw new Error("Runtime inventory shape is invalid");
  }
  const core = { ...inventory }; delete core.inventory_sha256;
  if (inventory.inventory_sha256 !== sha256(Buffer.from(`pdf-tools.docling-runtime-inventory.v1\0${canonicalJson(core)}`))) throw new Error("Runtime inventory digest is invalid");
  let bytes = 0; const paths = new Set();
  for (const record of inventory.records) {
    if (!record || !isCanonicalRecordPath(record.path) || paths.has(record.path) || !["file", "directory", "symlink"].includes(record.type)
      || !Number.isInteger(record.mode) || !Number.isInteger(record.links) || record.links < 1) throw new Error("Runtime inventory record is invalid");
    paths.add(record.path);
    if (record.type === "file") {
      const [inventoryRoot, ...relativeParts] = record.path.split("/");
      const allowedModes = relativeParts.length > 0 && ["managed_python", "venv"].includes(inventoryRoot)
        ? [0o600, 0o644, 0o700, 0o711, 0o755] : [0o600, 0o644, 0o700, 0o755];
      if (canonicalJson(Object.keys(record).sort()) !== canonicalJson(["bytes", "links", "mode", "path", "sha256", "type"])
        || !Number.isInteger(record.bytes) || record.bytes < 0 || !SHA256.test(record.sha256 ?? "") || !allowedModes.includes(record.mode)) throw new Error("Runtime file record is invalid");
      bytes += record.bytes;
    } else if (record.type === "directory" && (canonicalJson(Object.keys(record).sort()) !== canonicalJson(["links", "mode", "path", "type"])
      || ![0o700, 0o755].includes(record.mode))) throw new Error("Runtime directory record is invalid");
    else if (record.type === "symlink") {
      const [inventoryRoot, ...relativeParts] = record.path.split("/");
      if (canonicalJson(Object.keys(record).sort()) !== canonicalJson(["links", "mode", "path", "target", "type"])
        || relativeParts.length < 1 || !["managed_python", "venv"].includes(inventoryRoot) || !PORTABLE_RUNTIME_SYMLINK_MODES.includes(record.mode)
        || record.links !== 1 || typeof record.target !== "string" || !record.target) throw new Error("Runtime symlink record is invalid");
    }
  }
  if (bytes !== inventory.total_file_bytes || bytes > MAX_TOTAL_BYTES) throw new Error("Runtime inventory byte total is invalid");
  return inventory;
}

export async function captureDoclingRuntimeInventory(receipt, finalization) {
  if (!receipt?.toolchain?.uv || !receipt.platform || !SHA256.test(receipt.handoff_id ?? "")) throw new Error("Runtime capture requires receipt-bound identity");
  const bytecodeAuthority = buildFinalizedBytecodeAuthority(receipt, finalization);
  const observedBytecode = new Set();
  const roots = { managed_python: receipt.roots.uv_python_install, venv: path.join(receipt.roots.sidecar_snapshot, "venv"), models: receipt.roots.models };
  const resolvedRoots = Object.fromEntries(Object.entries(roots).map(([label, value]) => [label, path.resolve(value)]));
  const allowedRoots = {
    managed_python: [resolvedRoots.managed_python],
    venv: [resolvedRoots.venv, resolvedRoots.managed_python],
    models: [],
  };
  const records = []; const state = { entries: 0, bytes: 0 };
  for (const [label, root] of Object.entries(resolvedRoots)) {
    await walk(label, root, allowedRoots[label], records, state, bytecodeAuthority, observedBytecode, "", label === "managed_python" || label === "venv");
  }
  if (observedBytecode.size !== bytecodeAuthority.size) throw new Error("Finalized Python bytecode is missing from the runtime environment");
  for (const [filename, recordPath] of [[path.join(receipt.roots.sidecar_snapshot, "requirements.lock"), "requirements.lock"], [receipt.toolchain.uv.path, "toolchain/uv"]]) {
    const record = await stableFileRecord(filename, recordPath); records.push(record); state.bytes += record.bytes;
  }
  const uvRecord = records.find(record => record.path === "toolchain/uv");
  if (uvRecord.bytes !== receipt.toolchain.uv.bytes || uvRecord.sha256 !== receipt.toolchain.uv.sha256) throw new Error("Runtime uv binary differs from receipt identity");
  if (state.bytes > MAX_TOTAL_BYTES) throw new Error("Runtime environment exceeds the aggregate byte ceiling");
  records.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const core = {
    inventory_id: "pdf-tools.docling-runtime-inventory.v1", handoff_id: receipt.handoff_id, records,
    entry_count: records.length, total_file_bytes: state.bytes, uv_version: receipt.toolchain.uv.version, platform: receipt.platform,
  };
  return validateDoclingRuntimeInventory({ ...core, inventory_sha256: sha256(Buffer.from(`pdf-tools.docling-runtime-inventory.v1\0${canonicalJson(core)}`)) });
}

async function spawnCaptured({ command, cwd, environment, stdin, maxStdoutBytes }) {
  const child = spawn(command[0], command.slice(1), { cwd, env: { ...environment }, stdio: ["pipe", "pipe", "pipe"] });
  const stdout = []; const stderr = []; let stdoutBytes = 0; let stderrBytes = 0;
  child.stdout.on("data", chunk => { stdoutBytes += chunk.length; if (stdoutBytes <= maxStdoutBytes) stdout.push(chunk); else child.kill("SIGKILL"); });
  child.stderr.on("data", chunk => { stderrBytes += chunk.length; if (stderrBytes <= 4 * 1024 * 1024) stderr.push(chunk); else child.kill("SIGKILL"); });
  child.stdin.end(stdin);
  const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  if (stdoutBytes > maxStdoutBytes || stderrBytes > 4 * 1024 * 1024) throw new Error("Fresh process exceeded its capture ceiling");
  return { pid: child.pid, exit_code: exit.code, signal: exit.signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes };
}

export async function runThreeFreshProcessEvidence({ receipt, finalization, command, cwd, environment, requestBytes, sourcePath, maxStdoutBytes, beforeEach = null, afterEach = null }) {
  if (!Array.isArray(command) || command.length < 1 || !Buffer.isBuffer(requestBytes) || !Number.isInteger(maxStdoutBytes) || maxStdoutBytes < 1) throw new Error("Fresh-process runner arguments are invalid");
  const sourceBytes = (await stableFileSnapshot(sourcePath, "source.pdf")).bytes;
  const before = await captureDoclingRuntimeInventory(receipt, finalization);
  const after = []; const processes = [];
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    if (beforeEach) await beforeEach(repetition);
    const observed = await spawnCaptured({ command, cwd, environment, stdin: requestBytes, maxStdoutBytes });
    if (observed.exit_code !== 0) throw new Error(`Fresh process ${repetition} failed: ${observed.stderr.toString().slice(0, 500)}`);
    const response = JSON.parse(observed.stdout);
    processes.push({
      repetition, pid: observed.pid, exit_code: observed.exit_code, signal: observed.signal,
      stdin_bytes: requestBytes.length, request_sha256: sha256(requestBytes), source_bytes: sourceBytes.length,
      source_sha256: sha256(sourceBytes), stdout_bytes: observed.stdout_bytes, response_sha256: sha256(Buffer.from(canonicalJson(response))),
    });
    after.push(await captureDoclingRuntimeInventory(receipt, finalization));
    if (afterEach) await afterEach(repetition);
  }
  return validateThreeFreshProcessEvidence({
    protocol: "pdf-tools.docling-three-process-evidence.v1", handoff_id: receipt.handoff_id,
    before, after, processes, stable: true,
  });
}

export function validateThreeFreshProcessEvidence(evidence) {
  if (!evidence || canonicalJson(Object.keys(evidence).sort()) !== canonicalJson(["after", "before", "handoff_id", "processes", "protocol", "stable"])
    || evidence.protocol !== "pdf-tools.docling-three-process-evidence.v1" || evidence.stable !== true
    || !SHA256.test(evidence.handoff_id ?? "") || !Array.isArray(evidence.after) || evidence.after.length !== 3
    || !Array.isArray(evidence.processes) || evidence.processes.length !== 3) throw new Error("Three-process evidence shape is invalid");
  const before = validateDoclingRuntimeInventory(evidence.before);
  if (before.handoff_id !== evidence.handoff_id) throw new Error("Three-process evidence handoff binding is invalid");
  const after = evidence.after.map(validateDoclingRuntimeInventory);
  if (after.some(item => item.handoff_id !== evidence.handoff_id || item.inventory_sha256 !== before.inventory_sha256)) throw new Error("Runtime inventory drifted across fresh processes");
  const pids = new Set(); const requests = new Set(); const requestBytes = new Set(); const sources = new Set(); const sourceBytes = new Set(); const responses = new Set();
  for (const [index, process] of evidence.processes.entries()) {
    if (!process || canonicalJson(Object.keys(process).sort()) !== canonicalJson(["exit_code", "pid", "repetition", "request_sha256", "response_sha256", "signal", "source_bytes", "source_sha256", "stdin_bytes", "stdout_bytes"])
      || process.repetition !== index + 1 || !Number.isInteger(process.pid) || process.pid < 1 || pids.has(process.pid) || process.exit_code !== 0 || process.signal !== null
      || !Number.isInteger(process.stdin_bytes) || process.stdin_bytes < 1 || !Number.isInteger(process.source_bytes) || process.source_bytes < 1
      || !Number.isInteger(process.stdout_bytes) || process.stdout_bytes < 1
      || ![process.request_sha256, process.source_sha256, process.response_sha256].every(value => SHA256.test(value ?? ""))) throw new Error("Runner-owned process record is invalid");
    pids.add(process.pid); requests.add(process.request_sha256); requestBytes.add(process.stdin_bytes);
    sources.add(process.source_sha256); sourceBytes.add(process.source_bytes); responses.add(process.response_sha256);
  }
  if (requests.size !== 1 || requestBytes.size !== 1 || sources.size !== 1 || sourceBytes.size !== 1 || responses.size !== 1) throw new Error("Fresh processes were not deterministic for one identical request and source");
  return evidence;
}
