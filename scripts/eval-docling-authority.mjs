#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const EXPECTED_ROLES = new Set([
  "adapter_entrypoint", "model_setup_helper", "candidate_config", "candidate_config_schema",
  "candidate_request_schema", "candidate_response_schema", "handoff_schema", "handoff_generator_source",
  "handoff_verifier_source", "runtime_evidence_source", "handoff_authority", "handoff_verifier_cli",
  "finalization_schema", "three_process_schema", "direct_requirements",
]);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function readStable(filename, maxBytes, requiredMode = null, allowEmpty = false) {
  if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("Docling authority requires O_NOFOLLOW");
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || (!allowEmpty && before.size < 1n) || before.size > BigInt(maxBytes)
      || (requiredMode !== null && Number(before.mode & 0o777n) !== requiredMode)) {
      throw new Error(`Authority input violates its file contract: ${filename}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    for (const property of ["dev", "ino", "nlink", "size", "mtimeNs", "ctimeNs"]) {
      if (String(before[property]) !== String(after[property])) throw new Error(`Authority input changed while read: ${filename}`);
    }
    if (BigInt(bytes.length) !== before.size) throw new Error(`Authority input length changed while read: ${filename}`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function assertNoLinkAncestors(filename, { allowMissingLeaf = false } = {}) {
  const absolute = path.resolve(filename);
  if (absolute !== filename) throw new Error(`Authority path is not canonical absolute: ${filename}`);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    try {
      const metadata = await fs.lstat(cursor);
      if (metadata.isSymbolicLink()) throw new Error(`Authority path contains a symbolic link: ${cursor}`);
    } catch (error) {
      if (error.code === "ENOENT" && allowMissingLeaf && index === parts.length - 1) return { exists: false, path: absolute };
      throw error;
    }
  }
  const real = await fs.realpath(absolute);
  if (real !== absolute) throw new Error(`Authority path differs from its real path: ${absolute}`);
  return { exists: true, path: absolute };
}

async function assertDirectory(filename, { allowMissingLeaf = false } = {}) {
  const checked = await assertNoLinkAncestors(filename, { allowMissingLeaf });
  if (!checked.exists) return checked;
  const metadata = await fs.lstat(filename);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.nlink < 1 || (metadata.mode & 0o777) !== 0o700) {
    throw new Error(`Authority root is not a real mode-0700 directory: ${filename}`);
  }
  return checked;
}

function parseProtectedRoots(raw) {
  let roots;
  try { roots = JSON.parse(raw); } catch { throw new Error("Out-of-band protected roots are not JSON"); }
  if (!Array.isArray(roots) || roots.length < 1 || roots.some(root => typeof root !== "string" || path.resolve(root) !== root)
    || new Set(roots).size !== roots.length || canonicalJson([...roots].sort()) !== raw) {
    throw new Error("Out-of-band protected roots are not a canonical absolute set");
  }
  return roots;
}

function recordByRole(receipt, role) {
  const record = receipt.inputs.find(item => item.role === role);
  if (!record) throw new Error(`Receipt is missing retained role: ${role}`);
  return record;
}

function identityDigest(identity) {
  return sha256(Buffer.from(`pdf-tools.docling-macos-handoff.v1\0${canonicalJson(identity)}`));
}

async function verifyRootPolicy(receipt, protectedRoots) {
  for (const protectedRoot of protectedRoots) await assertNoLinkAncestors(protectedRoot, { allowMissingLeaf: true });
  const rootNames = ["uv", "uv_python_install", "models", "runs", "sidecar_snapshot", "authority_home", "authority_tmp"];
  for (const name of rootNames) {
    const root = receipt.roots[name];
    if (typeof root !== "string" || path.resolve(root) !== root) throw new Error(`Receipt root is not canonical: ${name}`);
    if (protectedRoots.some(protectedRoot => within(protectedRoot, root))) throw new Error(`Receipt root is inside protected storage: ${name}`);
    await assertDirectory(root, { allowMissingLeaf: name === "models" });
  }
  if (!within(receipt.roots.runs, receipt.roots.authority_home) || !within(receipt.roots.runs, receipt.roots.authority_tmp)) {
    throw new Error("Authority HOME/TMPDIR must remain under the run root");
  }
}

function assertReceiptShape(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || receipt.protocol !== "pdf-tools.docling-macos-handoff.v1" || receipt.execution_state !== "not_run"
    || !SHA256.test(receipt.handoff_id ?? "") || identityDigest(receipt.identity) !== receipt.handoff_id
    || !receipt.roots || !receipt.toolchain?.uv || !receipt.toolchain?.node
    || !Array.isArray(receipt.inputs) || receipt.inputs.length !== EXPECTED_ROLES.size
    || !Array.isArray(receipt.fixtures) || receipt.fixtures.length < 1 || receipt.fixtures.length > 100) {
    throw new Error("Receipt shape or identity is invalid");
  }
  const roles = new Set();
  const names = new Set();
  for (const item of receipt.inputs) {
    if (!item || typeof item !== "object" || canonicalJson(Object.keys(item).sort()) !== canonicalJson(["bytes", "filename", "role", "sha256"])
      || !EXPECTED_ROLES.has(item.role) || roles.has(item.role) || typeof item.filename !== "string"
      || path.basename(item.filename) !== item.filename || names.has(item.filename) || !Number.isInteger(item.bytes)
      || item.bytes < 1 || !SHA256.test(item.sha256)) throw new Error("Receipt retained inventory is invalid");
    roles.add(item.role); names.add(item.filename);
  }
  if ([...EXPECTED_ROLES].some(role => !roles.has(role)) || canonicalJson(receipt.identity.inputs) !== canonicalJson(receipt.inputs)
    || canonicalJson(receipt.identity.fixtures) !== canonicalJson(receipt.fixtures)) {
    throw new Error("Receipt identity does not bind exact retained inventories");
  }
}

function assertRealizedRecipe(receipt, receiptPath) {
  const snapshot = receipt.roots.sidecar_snapshot;
  const rolePath = role => path.join(snapshot, recordByRole(receipt, role).filename);
  const venv = path.join(snapshot, "venv");
  const python = path.join(venv, "bin", "python");
  const lock = path.join(snapshot, "requirements.lock");
  const finalization = path.join(path.dirname(receiptPath), "docling-finalization.v1.json");
  const receiptDigestPlaceholder = "$OUT_OF_BAND_RECEIPT_SHA256";
  const protectedRootsPlaceholder = "$OUT_OF_BAND_PROTECTED_ROOTS_JSON";
  const finalizationDigestPlaceholder = "$OUT_OF_BAND_FINALIZATION_SHA256";
  const baseEnvironment = {
    HOME: receipt.roots.authority_home, TMPDIR: receipt.roots.authority_tmp, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C",
    UV_CACHE_DIR: receipt.roots.uv, UV_PYTHON_INSTALL_DIR: receipt.roots.uv_python_install, PYTHONDONTWRITEBYTECODE: "1",
  };
  const expectedSetupCommands = [
    [receipt.toolchain.uv.path, "python", "install", "3.12.13"],
    [receipt.toolchain.uv.path, "venv", "--python", "3.12.13", venv],
    [receipt.toolchain.uv.path, "pip", "compile", rolePath("direct_requirements"), "--python", python, "--generate-hashes", "--output-file", lock],
    [receipt.toolchain.uv.path, "pip", "sync", lock, "--python", python, "--require-hashes"],
    [python, "-B", rolePath("model_setup_helper"), "--config", rolePath("candidate_config"), "--expected-config-sha256", recordByRole(receipt, "candidate_config").sha256, "--models-path", receipt.roots.models],
  ];
  const expectedAdapterCommand = [
    python, "-B", rolePath("adapter_entrypoint"), "--config", rolePath("candidate_config"), "--artifacts-path", receipt.roots.models,
    "--receipt", receiptPath, "--expected-receipt-sha256", receiptDigestPlaceholder,
  ];
  const expectedSetupAuthority = [
    receipt.toolchain.node.path, SELF, "setup", "--receipt", receiptPath, "--expected-receipt-sha256", receiptDigestPlaceholder,
    "--protected-roots-json", protectedRootsPlaceholder,
  ];
  const expectedExecuteAuthority = [
    receipt.toolchain.node.path, SELF, "execute", "--receipt", receiptPath, "--expected-receipt-sha256", receiptDigestPlaceholder,
    "--protected-roots-json", protectedRootsPlaceholder, "--finalization", finalization,
    "--expected-finalization-sha256", finalizationDigestPlaceholder,
  ];
  const expectedNormalizedRecipe = {
    setup: {
      network_required: true,
      environment: {
        HOME: "$AUTHORITY_HOME", TMPDIR: "$AUTHORITY_TMP", PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C",
        UV_CACHE_DIR: "$UV_CACHE_ROOT", UV_PYTHON_INSTALL_DIR: "$UV_PYTHON_INSTALL_ROOT", PYTHONDONTWRITEBYTECODE: "1",
      },
      authority_command: ["$NODE", "$AUTHORITY", "setup", "--receipt", "$RECEIPT", "--expected-receipt-sha256", receiptDigestPlaceholder, "--protected-roots-json", protectedRootsPlaceholder],
      commands: [
        ["$UV", "python", "install", "3.12.13"],
        ["$UV", "venv", "--python", "3.12.13", "$VENV_ROOT"],
        ["$UV", "pip", "compile", "$DIRECT_REQUIREMENTS", "--python", "$PYTHON", "--generate-hashes", "--output-file", "$LOCK"],
        ["$UV", "pip", "sync", "$LOCK", "--python", "$PYTHON", "--require-hashes"],
        ["$PYTHON", "-B", "$MODEL_SETUP_HELPER", "--config", "$CONFIG", "--expected-config-sha256", "$CONFIG_SHA256", "--models-path", "$MODELS_ROOT"],
      ],
      finalization: { protocol: "pdf-tools.docling-finalization.v1", out_of_band_sha256_required: true },
    },
    execution: {
      offline_intent: true, network_isolation_enforced: false,
      environment: {
        HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_DATASETS_OFFLINE: "1",
        HOME: "$AUTHORITY_HOME", TMPDIR: "$AUTHORITY_TMP", PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C",
        UV_CACHE_DIR: "$UV_CACHE_ROOT", UV_PYTHON_INSTALL_DIR: "$UV_PYTHON_INSTALL_ROOT", PYTHONDONTWRITEBYTECODE: "1",
      },
      authority_command: ["$NODE", "$AUTHORITY", "execute", "--receipt", "$RECEIPT", "--expected-receipt-sha256", receiptDigestPlaceholder, "--protected-roots-json", protectedRootsPlaceholder, "--finalization", "$FINALIZATION", "--expected-finalization-sha256", finalizationDigestPlaceholder],
      adapter_command: ["$PYTHON", "-B", "$ADAPTER", "--config", "$CONFIG", "--artifacts-path", "$MODELS_ROOT", "--receipt", "$RECEIPT", "--expected-receipt-sha256", receiptDigestPlaceholder],
    },
  };
  if (canonicalJson(receipt.identity.recipe) !== canonicalJson(expectedNormalizedRecipe)
    || receipt.setup?.network_required !== true || canonicalJson(receipt.setup.environment) !== canonicalJson(baseEnvironment)
    || canonicalJson(receipt.setup.authority_command) !== canonicalJson(expectedSetupAuthority)
    || canonicalJson(receipt.setup.commands) !== canonicalJson(expectedSetupCommands)
    || canonicalJson(receipt.setup.finalization) !== canonicalJson({ protocol: "pdf-tools.docling-finalization.v1", path: finalization, out_of_band_sha256_required: true })
    || receipt.execution?.offline_intent !== true || receipt.execution.network_isolation_enforced !== false
    || canonicalJson(receipt.execution.environment) !== canonicalJson({ ...baseEnvironment, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_DATASETS_OFFLINE: "1" })
    || canonicalJson(receipt.execution.command_template) !== canonicalJson(expectedExecuteAuthority)
    || canonicalJson(receipt.execution.adapter_command) !== canonicalJson(expectedAdapterCommand)) {
    throw new Error("Receipt does not realize the retained authority recipe");
  }
}

async function verifyTool(tool, label) {
  await assertNoLinkAncestors(tool.path);
  const bytes = await readStable(tool.path, MAX_INPUT_BYTES);
  if (bytes.length !== tool.bytes || sha256(bytes) !== tool.sha256) throw new Error(`${label} binary differs from receipt identity`);
}

export async function verifyHandoffAuthority({ receiptPath, expectedReceiptSha256, protectedRootsJson }) {
  if (!SHA256.test(expectedReceiptSha256 ?? "")) throw new Error("Out-of-band receipt SHA-256 is required");
  if (path.resolve(receiptPath) !== receiptPath) throw new Error("Receipt path must be canonical absolute");
  await assertNoLinkAncestors(receiptPath);
  const receiptBytes = await readStable(receiptPath, MAX_RECEIPT_BYTES, 0o600);
  if (sha256(receiptBytes) !== expectedReceiptSha256) throw new Error("Receipt differs from its out-of-band SHA-256");
  const receipt = JSON.parse(receiptBytes);
  if (!receiptBytes.equals(Buffer.from(`${canonicalJson(receipt)}\n`))) throw new Error("Receipt bytes are not canonical");
  assertReceiptShape(receipt);
  assertRealizedRecipe(receipt, receiptPath);
  const protectedRoots = parseProtectedRoots(protectedRootsJson);
  if (sha256(Buffer.from(`pdf-tools.docling-protected-roots.v1\0${canonicalJson(protectedRoots)}`)) !== receipt.roots.protected_roots_sha256) {
    throw new Error("Protected roots differ from the receipt-bound digest");
  }
  await verifyRootPolicy(receipt, protectedRoots);
  const snapshot = receipt.roots.sidecar_snapshot;
  for (const item of receipt.inputs) {
    const filename = path.join(snapshot, item.filename);
    await assertNoLinkAncestors(filename);
    const bytes = await readStable(filename, MAX_INPUT_BYTES, 0o600);
    if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) throw new Error(`Retained input mismatch: ${item.role}`);
  }
  const authority = path.join(snapshot, recordByRole(receipt, "handoff_authority").filename);
  if (await fs.realpath(SELF) !== authority) throw new Error("Executed authority is not the receipt-bound retained authority");
  await Promise.all([verifyTool(receipt.toolchain.uv, "uv"), verifyTool(receipt.toolchain.node, "Node")]);
  if (await fs.realpath(process.execPath) !== receipt.toolchain.node.path) throw new Error("Executed Node is not the receipt-bound Node binary");
  const fixtureRoot = path.join(path.dirname(receiptPath), "fixtures");
  await assertDirectory(fixtureRoot);
  const fixtureNames = [];
  for (const fixture of receipt.fixtures) {
    const filename = path.join(fixtureRoot, fixture.filename);
    const bytes = await readStable(filename, 8 * 1024 * 1024, 0o600);
    if (bytes.length !== fixture.bytes || sha256(bytes) !== fixture.sha256) throw new Error(`Fixture mismatch: ${fixture.ordinal}`);
    fixtureNames.push(fixture.filename);
  }
  if (canonicalJson((await fs.readdir(fixtureRoot)).sort()) !== canonicalJson(fixtureNames.sort())) throw new Error("Fixture root contains unbound entries");
  return { receipt, receiptBytes, protectedRoots };
}

function exactEnvironment(environment) {
  const required = ["HOME", "TMPDIR", "PATH", "LANG", "LC_ALL", "UV_CACHE_DIR", "UV_PYTHON_INSTALL_DIR", "PYTHONDONTWRITEBYTECODE"];
  const offline = ["HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE"];
  const expected = environment?.HF_HUB_OFFLINE === "1" ? [...required, ...offline] : required;
  if (!environment || canonicalJson(Object.keys(environment).sort()) !== canonicalJson(expected.sort())
    || environment.PYTHONDONTWRITEBYTECODE !== "1" || environment.LANG !== "C" || environment.LC_ALL !== "C") {
    throw new Error("Receipt environment is not the exact authority environment");
  }
  return Object.freeze({ ...environment });
}

async function spawnBound(command, { environment, cwd, stdin = null, stdoutLimit = 16 * 1024 * 1024, stderrLimit = 4 * 1024 * 1024 }) {
  if (!Array.isArray(command) || command.length < 1 || command.some(item => typeof item !== "string" || !item)) throw new Error("Bound command is invalid");
  const child = spawn(command[0], command.slice(1), { cwd, env: exactEnvironment(environment), stdio: ["pipe", "pipe", "pipe"] });
  const stdout = []; const stderr = [];
  let stdoutBytes = 0; let stderrBytes = 0;
  child.stdout.on("data", chunk => { stdoutBytes += chunk.length; if (stdoutBytes <= stdoutLimit) stdout.push(chunk); else child.kill("SIGKILL"); });
  child.stderr.on("data", chunk => { stderrBytes += chunk.length; if (stderrBytes <= stderrLimit) stderr.push(chunk); else child.kill("SIGKILL"); });
  if (stdin === null) child.stdin.end(); else child.stdin.end(stdin);
  const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, pid: child.pid })); });
  if (stdoutBytes > stdoutLimit || stderrBytes > stderrLimit) throw new Error("Bound command exceeded its capture ceiling");
  return { ...result, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

async function digestTree(root, allowedRoots, { strictPrivate = false } = {}) {
  const records = [];
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const filename = path.join(directory, entry.name);
      const relative_path = path.relative(root, filename).split(path.sep).join("/");
      const metadata = await fs.lstat(filename);
      const mode = metadata.mode & 0o777;
      if (metadata.isSymbolicLink()) {
        const target = await fs.readlink(filename);
        const resolved = path.resolve(path.dirname(filename), target);
        if (strictPrivate || metadata.nlink !== 1 || !allowedRoots.some(allowed => within(allowed, resolved))) {
          throw new Error(`Finalized tree contains an unsafe symbolic link: ${relative_path}`);
        }
        records.push({ relative_path, type: "symlink", mode, links: metadata.nlink, target });
      } else if (metadata.isDirectory()) {
        if (![0o700, 0o755].includes(mode) || metadata.nlink < 1 || (strictPrivate && mode !== 0o700)) {
          throw new Error(`Finalized tree directory violates mode/link policy: ${relative_path}`);
        }
        records.push({ relative_path, type: "directory", mode, links: metadata.nlink });
        await walk(filename);
      }
      else if (metadata.isFile()) {
        const bytes = await readStable(filename, 512 * 1024 * 1024, null, true);
        if (![0o600, 0o644, 0o700, 0o755].includes(mode) || metadata.nlink < 1 || (strictPrivate && (mode !== 0o600 || metadata.nlink !== 1))) {
          throw new Error(`Finalized tree file violates mode/link policy: ${relative_path}`);
        }
        records.push({ relative_path, type: "file", bytes: bytes.length, mode, links: metadata.nlink, sha256: sha256(bytes) });
      } else throw new Error(`Finalized tree contains an unsupported entry: ${relative_path}`);
    }
  }
  await walk(root);
  return records;
}

async function writeExclusive(filename, bytes) {
  const handle = await fs.open(filename, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function finalizeSetup(context, receiptPath, receiptSha) {
  const { receipt } = context;
  const snapshot = receipt.roots.sidecar_snapshot;
  const python = path.join(snapshot, "venv", "bin", "python");
  const pythonReal = await fs.realpath(python);
  if (!within(receipt.roots.uv_python_install, pythonReal)) throw new Error("Managed Python executable escapes its receipt-bound root");
  const pythonBytes = await readStable(pythonReal, MAX_INPUT_BYTES);
  const versionResult = await spawnBound([python, "-B", "--version"], { environment: receipt.setup.environment, cwd: receipt.roots.authority_tmp });
  if (versionResult.code !== 0) throw new Error("Managed Python version capture failed");
  const distributionsProgram = "import importlib.metadata,json;print(json.dumps(sorted((d.metadata['Name'],d.version) for d in importlib.metadata.distributions()),separators=(',',':')))";
  const distributionsResult = await spawnBound([python, "-B", "-c", distributionsProgram], { environment: receipt.setup.environment, cwd: receipt.roots.authority_tmp });
  if (distributionsResult.code !== 0) throw new Error("Installed distribution capture failed");
  const lockPath = path.join(snapshot, "requirements.lock");
  const lockBytes = await readStable(lockPath, 16 * 1024 * 1024, null, true);
  const allowedRuntimeRoots = [receipt.roots.models, receipt.roots.uv_python_install, path.join(snapshot, "venv")];
  const [modelFiles, managedPythonFiles, venvFiles] = await Promise.all([
    digestTree(receipt.roots.models, allowedRuntimeRoots, { strictPrivate: true }),
    digestTree(receipt.roots.uv_python_install, allowedRuntimeRoots),
    digestTree(path.join(snapshot, "venv"), allowedRuntimeRoots),
  ]);
  const rootPolicy = {};
  for (const [name, value] of Object.entries(receipt.roots).filter(([, value]) => typeof value === "string" && value.startsWith("/"))) {
    const metadata = await fs.lstat(value);
    rootPolicy[name] = { path: value, real_path: await fs.realpath(value), mode: metadata.mode & 0o777, links: metadata.nlink };
  }
  const finalizationCore = {
    protocol: "pdf-tools.docling-finalization.v1",
    handoff_id: receipt.handoff_id,
    receipt_sha256: receiptSha,
    platform: receipt.platform,
    toolchain: receipt.toolchain,
    lock: { bytes: lockBytes.length, sha256: sha256(lockBytes) },
    python: { path: pythonReal, bytes: pythonBytes.length, sha256: sha256(pythonBytes), version: versionResult.stdout.toString().trim() || versionResult.stderr.toString().trim() },
    installed_distributions: JSON.parse(distributionsResult.stdout),
    model_files: modelFiles,
    managed_python_files: managedPythonFiles,
    venv_files: venvFiles,
    root_policy: rootPolicy,
    network_isolation_enforced: false,
    execution_state: "setup_complete_not_executed",
  };
  const finalization = { ...finalizationCore, finalization_id: sha256(Buffer.from(`pdf-tools.docling-finalization.v1\0${canonicalJson(finalizationCore)}`)) };
  const bytes = Buffer.from(`${canonicalJson(finalization)}\n`);
  const filename = path.join(path.dirname(receiptPath), "docling-finalization.v1.json");
  await writeExclusive(filename, bytes);
  return { finalization, finalizationPath: filename, finalizationSha256: sha256(bytes) };
}

async function verifyFinalization(context, finalizationPath, expectedFinalizationSha256) {
  if (!SHA256.test(expectedFinalizationSha256 ?? "")) throw new Error("Out-of-band finalization SHA-256 is required");
  const receiptRunRoot = path.dirname(context.receipt.setup.finalization.path);
  if (finalizationPath !== context.receipt.setup.finalization.path || path.resolve(finalizationPath) !== finalizationPath
    || !within(context.receipt.roots.runs, receiptRunRoot)) throw new Error("Finalization path is outside the receipt-bound run root");
  await assertNoLinkAncestors(finalizationPath);
  const bytes = await readStable(finalizationPath, 16 * 1024 * 1024, 0o600);
  if (sha256(bytes) !== expectedFinalizationSha256) throw new Error("Finalization differs from its out-of-band SHA-256");
  const value = JSON.parse(bytes);
  if (!bytes.equals(Buffer.from(`${canonicalJson(value)}\n`)) || value.protocol !== "pdf-tools.docling-finalization.v1"
    || value.handoff_id !== context.receipt.handoff_id || value.receipt_sha256 !== sha256(context.receiptBytes)) {
    throw new Error("Finalization identity is invalid");
  }
  const { finalization_id, ...core } = value;
  if (finalization_id !== sha256(Buffer.from(`pdf-tools.docling-finalization.v1\0${canonicalJson(core)}`))) throw new Error("Finalization digest is invalid");
  const exactTopLevel = ["execution_state", "finalization_id", "handoff_id", "installed_distributions", "lock", "managed_python_files", "model_files", "network_isolation_enforced", "platform", "protocol", "python", "receipt_sha256", "root_policy", "toolchain", "venv_files"];
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson(exactTopLevel)
    || value.execution_state !== "setup_complete_not_executed" || value.network_isolation_enforced !== false
    || canonicalJson(value.platform) !== canonicalJson(context.receipt.platform)
    || canonicalJson(value.toolchain) !== canonicalJson(context.receipt.toolchain)
    || !Array.isArray(value.installed_distributions)
    || value.installed_distributions.some(item => !Array.isArray(item) || item.length !== 2 || item.some(part => typeof part !== "string" || !part))) {
    throw new Error("Finalization shape or retained identity is invalid");
  }
  const snapshot = context.receipt.roots.sidecar_snapshot;
  const lockBytes = await readStable(path.join(snapshot, "requirements.lock"), 16 * 1024 * 1024, null, true);
  if (canonicalJson(value.lock) !== canonicalJson({ bytes: lockBytes.length, sha256: sha256(lockBytes) })) throw new Error("Finalized lock has drifted");
  const python = path.join(snapshot, "venv", "bin", "python");
  const pythonReal = await fs.realpath(python);
  if (!within(context.receipt.roots.uv_python_install, pythonReal)) throw new Error("Finalized Python escapes its receipt-bound root");
  const pythonBytes = await readStable(pythonReal, MAX_INPUT_BYTES);
  const versionResult = await spawnBound([python, "-B", "--version"], { environment: context.receipt.setup.environment, cwd: context.receipt.roots.authority_tmp });
  const distributionsProgram = "import importlib.metadata,json;print(json.dumps(sorted((d.metadata['Name'],d.version) for d in importlib.metadata.distributions()),separators=(',',':')))";
  const distributionsResult = await spawnBound([python, "-B", "-c", distributionsProgram], { environment: context.receipt.setup.environment, cwd: context.receipt.roots.authority_tmp });
  if (versionResult.code !== 0 || distributionsResult.code !== 0) throw new Error("Finalized Python identity capture failed");
  const currentPython = {
    path: pythonReal, bytes: pythonBytes.length, sha256: sha256(pythonBytes),
    version: versionResult.stdout.toString().trim() || versionResult.stderr.toString().trim(),
  };
  if (canonicalJson(value.python) !== canonicalJson(currentPython)
    || canonicalJson(value.installed_distributions) !== canonicalJson(JSON.parse(distributionsResult.stdout))) {
    throw new Error("Finalized Python environment has drifted");
  }
  const allowedRuntimeRoots = [context.receipt.roots.models, context.receipt.roots.uv_python_install, path.join(context.receipt.roots.sidecar_snapshot, "venv")];
  const current = await Promise.all([
    digestTree(context.receipt.roots.models, allowedRuntimeRoots, { strictPrivate: true }),
    digestTree(context.receipt.roots.uv_python_install, allowedRuntimeRoots),
    digestTree(path.join(context.receipt.roots.sidecar_snapshot, "venv"), allowedRuntimeRoots),
  ]);
  if (canonicalJson(current[0]) !== canonicalJson(value.model_files) || canonicalJson(current[1]) !== canonicalJson(value.managed_python_files)
    || canonicalJson(current[2]) !== canonicalJson(value.venv_files)) throw new Error("Finalized runtime has drifted");
  const currentRootPolicy = {};
  for (const [name, root] of Object.entries(context.receipt.roots).filter(([, root]) => typeof root === "string" && root.startsWith("/"))) {
    const metadata = await fs.lstat(root);
    currentRootPolicy[name] = { path: root, real_path: await fs.realpath(root), mode: metadata.mode & 0o777, links: metadata.nlink };
  }
  if (canonicalJson(currentRootPolicy) !== canonicalJson(value.root_policy)) throw new Error("Finalized root policy has drifted");
  return value;
}

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1]) throw new Error(`${name} is required`);
  return argv[index + 1];
}

async function main() {
  const [action, ...argv] = process.argv.slice(2);
  const receiptPath = path.resolve(option(argv, "--receipt"));
  const expectedReceiptSha256 = option(argv, "--expected-receipt-sha256");
  const protectedRootsJson = option(argv, "--protected-roots-json");
  let context = await verifyHandoffAuthority({ receiptPath, expectedReceiptSha256, protectedRootsJson });
  if (action === "verify") {
    process.stdout.write(`${JSON.stringify({ verified: true, handoff_id: context.receipt.handoff_id, receipt_sha256: expectedReceiptSha256 })}\n`);
    return;
  }
  if (action === "setup") {
    for (const command of context.receipt.setup.commands) {
      context = await verifyHandoffAuthority({ receiptPath, expectedReceiptSha256, protectedRootsJson });
      const result = await spawnBound(command, { environment: context.receipt.setup.environment, cwd: context.receipt.roots.authority_tmp });
      if (result.code !== 0) throw new Error(`Setup command failed (${path.basename(command[0])}): ${result.stderr.toString().slice(0, 500)}`);
      context = await verifyHandoffAuthority({ receiptPath, expectedReceiptSha256, protectedRootsJson });
    }
    const finalized = await finalizeSetup(context, receiptPath, expectedReceiptSha256);
    await verifyHandoffAuthority({ receiptPath, expectedReceiptSha256, protectedRootsJson });
    process.stdout.write(`${JSON.stringify({ setup_complete: true, handoff_id: context.receipt.handoff_id, finalization_path: finalized.finalizationPath, finalization_sha256: finalized.finalizationSha256 })}\n`);
    return;
  }
  if (action === "execute") {
    const finalizationPath = path.resolve(option(argv, "--finalization"));
    const expectedFinalizationSha256 = option(argv, "--expected-finalization-sha256");
    await verifyFinalization(context, finalizationPath, expectedFinalizationSha256);
    const request = await new Promise((resolve, reject) => {
      const chunks = []; let bytes = 0;
      process.stdin.on("data", chunk => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) reject(new Error("Authority stdin exceeds its ceiling")); else chunks.push(chunk); });
      process.stdin.on("end", () => resolve(Buffer.concat(chunks))); process.stdin.on("error", reject);
    });
    const command = context.receipt.execution.adapter_command.map(value => value === "$OUT_OF_BAND_RECEIPT_SHA256" ? expectedReceiptSha256
      : value === "$OUT_OF_BAND_FINALIZATION_SHA256" ? expectedFinalizationSha256 : value);
    const result = await spawnBound(command, { environment: context.receipt.execution.environment, cwd: context.receipt.roots.authority_tmp, stdin: request });
    context = await verifyHandoffAuthority({ receiptPath, expectedReceiptSha256, protectedRootsJson });
    await verifyFinalization(context, finalizationPath, expectedFinalizationSha256);
    if (result.code !== 0) throw new Error(`Adapter command failed: ${result.stderr.toString().slice(0, 500)}`);
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    return;
  }
  if (action === "probe") {
    const finalizationPath = path.resolve(option(argv, "--finalization"));
    const expectedFinalizationSha256 = option(argv, "--expected-finalization-sha256");
    const attemptDir = path.resolve(option(argv, "--attempt-dir"));
    const requestPath = path.resolve(option(argv, "--request"));
    await assertDirectory(attemptDir);
    await verifyFinalization(context, finalizationPath, expectedFinalizationSha256);
    const requestBytes = await readStable(requestPath, 16 * 1024 * 1024, 0o600);
    const request = JSON.parse(requestBytes);
    if (!Number.isInteger(request?.limits?.max_stdout_bytes) || request.limits.max_stdout_bytes < 1) throw new Error("Probe request lacks a bounded stdout limit");
    const sourcePath = path.join(attemptDir, "source.pdf");
    await readStable(sourcePath, request.limits.max_source_bytes, null);
    const runtimeRecord = recordByRole(context.receipt, "runtime_evidence_source");
    const runtimePath = path.join(context.receipt.roots.sidecar_snapshot, runtimeRecord.filename);
    const runtime = await import(`${pathToFileURL(runtimePath).href}?sha256=${runtimeRecord.sha256}`);
    const command = context.receipt.execution.adapter_command.map(value => value === "$OUT_OF_BAND_RECEIPT_SHA256" ? expectedReceiptSha256 : value);
    const reverify = async () => {
      context = await verifyHandoffAuthority({ receiptPath, expectedReceiptSha256, protectedRootsJson });
      await verifyFinalization(context, finalizationPath, expectedFinalizationSha256);
    };
    await reverify();
    const evidence = await runtime.runThreeFreshProcessEvidence({
      receipt: context.receipt, command, cwd: attemptDir, environment: context.receipt.execution.environment,
      requestBytes, sourcePath, maxStdoutBytes: request.limits.max_stdout_bytes, beforeEach: reverify, afterEach: reverify,
    });
    const evidenceBytes = Buffer.from(`${canonicalJson(evidence)}\n`);
    const evidencePath = path.join(path.dirname(receiptPath), "docling-three-process-evidence.v1.json");
    await writeExclusive(evidencePath, evidenceBytes);
    process.stdout.write(`${JSON.stringify({ probe_complete: true, handoff_id: context.receipt.handoff_id, evidence_path: evidencePath, evidence_sha256: sha256(evidenceBytes) })}\n`);
    return;
  }
  throw new Error("Action must be verify, setup, execute, or probe");
}

if (path.resolve(process.argv[1] ?? "") === SELF) {
  main().catch(error => { process.stderr.write(`Docling authority failed: ${error.message}\n`); process.exitCode = 1; });
}
