import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  captureDoclingRuntimeInventory,
  runThreeFreshProcessEvidence,
  validateDoclingRuntimeInventory,
  validateThreeFreshProcessEvidence,
} from "./extraction-docling-runtime-evidence.js";
import { assertSchema } from "./extraction-phase1-protocol.js";

const roots = [];
const SHA = "a".repeat(64);
const digest = value => createHash("sha256").update(value).digest("hex");
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EVIDENCE_SCHEMA = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "test/fixtures/eval/extraction/phase1/docling-three-process-evidence.schema.json"), "utf8"));

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-docling-runtime-")); roots.push(root);
  const snapshot = path.join(root, "snapshot"); const managed = path.join(root, "managed"); const models = path.join(root, "models"); const uv = path.join(root, "uv"); const attempt = path.join(root, "attempt");
  const managedExecutable = path.join(managed, "bin/python3.12");
  const venvExecutable = path.join(snapshot, "venv/bin/docling");
  const managedSymlink = path.join(managed, "bin/python-link");
  const venvSymlink = path.join(snapshot, "venv/bin/python");
  await Promise.all([fs.mkdir(path.join(snapshot, "venv/bin"), { recursive: true }), fs.mkdir(path.join(managed, "bin"), { recursive: true }), fs.mkdir(models), fs.mkdir(attempt)]);
  await Promise.all([
    fs.writeFile(managedExecutable, "python"), fs.symlink(managedExecutable, managedSymlink), fs.symlink(managedExecutable, venvSymlink),
    fs.writeFile(venvExecutable, "docling"),
    fs.writeFile(path.join(snapshot, "venv/empty.marker"), ""), fs.writeFile(path.join(snapshot, "requirements.lock"), "locked"),
    fs.writeFile(path.join(models, "weight.bin"), "weight"), fs.writeFile(uv, "uv"), fs.writeFile(path.join(attempt, "source.pdf"), "%PDF-source"),
  ]);
  await Promise.all([fs.chmod(managedExecutable, 0o711), fs.chmod(venvExecutable, 0o711)]);
  const receipt = { handoff_id: SHA, roots: { sidecar_snapshot: snapshot, uv_python_install: managed, models }, toolchain: { uv: { path: uv, version: "uv 0.8.15", bytes: 2, sha256: digest("uv") } }, platform: { interpreter: "cpython-3.12.13-macos-aarch64-none", operating_system: "macos", architecture: "arm64", os_build: "25G88", kernel_release: "25.6.0", node_version: "v24.4.1" } };
  return { root, receipt, snapshot, managedExecutable, venvExecutable, managedSymlink, venvSymlink, models, attempt };
}

function resignInventory(inventory) {
  const core = structuredClone(inventory);
  delete core.inventory_sha256;
  return { ...core, inventory_sha256: digest(Buffer.from(`pdf-tools.docling-runtime-inventory.v1\0${canonicalJson(core)}`)) };
}

async function captureWithObservedSymlinkMode(receipt, filenames, mode) {
  const selected = new Set(filenames.map(filename => path.resolve(filename)));
  const realLstat = fs.lstat.bind(fs);
  const lstat = vi.spyOn(fs, "lstat").mockImplementation(async (...arguments_) => {
    const metadata = await realLstat(...arguments_);
    if (selected.has(path.resolve(String(arguments_[0]))) && metadata.isSymbolicLink()) metadata.mode = (metadata.mode & ~0o777) | mode;
    return metadata;
  });
  try { return await captureDoclingRuntimeInventory(receipt); } finally { lstat.mockRestore(); }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("Docling runtime evidence", () => {
  it("owns three real child processes and recomputes unchanged inventories and deterministic responses", async () => {
    const { receipt, attempt } = await fixture();
    const requestBytes = Buffer.from('{"request_id":"probe"}\n');
    const evidence = await runThreeFreshProcessEvidence({
      receipt, command: [process.execPath, "-e", "let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({ok:true,input:b.length})+'\\n'))"],
      cwd: attempt, environment: { PATH: process.env.PATH }, requestBytes, sourcePath: path.join(attempt, "source.pdf"), maxStdoutBytes: 4096,
    });
    expect(new Set(evidence.processes.map(item => item.pid)).size).toBe(3);
    expect(evidence.after.every(item => item.inventory_sha256 === evidence.before.inventory_sha256)).toBe(true);
    expect(() => assertSchema(evidence, EVIDENCE_SCHEMA, "Docling three-process evidence")).not.toThrow();
    const ownerExecuteOnlyModel = structuredClone(evidence);
    ownerExecuteOnlyModel.before.records.find(record => record.path === "models/weight.bin").mode = 0o711;
    expect(() => assertSchema(ownerExecuteOnlyModel, EVIDENCE_SCHEMA, "Docling three-process evidence")).toThrow();
    const groupWritableManagedPython = structuredClone(evidence);
    groupWritableManagedPython.before.records.find(record => record.path === "managed_python/bin/python3.12").mode = 0o771;
    expect(() => assertSchema(groupWritableManagedPython, EVIDENCE_SCHEMA, "Docling three-process evidence")).toThrow();
    const observedPrivateSymlinks = structuredClone(evidence);
    for (const inventory of [observedPrivateSymlinks.before, ...observedPrivateSymlinks.after]) {
      for (const record of inventory.records.filter(item => item.type === "symlink")) record.mode = 0o700;
    }
    expect(() => assertSchema(observedPrivateSymlinks, EVIDENCE_SCHEMA, "Docling three-process evidence")).not.toThrow();
    for (const mode of [0o755, 0o711, 0o733]) {
      const unsafeSymlinkMode = structuredClone(evidence);
      unsafeSymlinkMode.before.records.find(record => record.path === "managed_python/bin/python-link").mode = mode;
      expect(() => assertSchema(unsafeSymlinkMode, EVIDENCE_SCHEMA, "Docling three-process evidence")).toThrow();
    }
    const modelSymlink = structuredClone(evidence);
    const modelAlias = modelSymlink.before.records.find(record => record.path === "managed_python/bin/python-link");
    modelAlias.path = "models/python-link";
    expect(() => assertSchema(modelSymlink, EVIDENCE_SCHEMA, "Docling three-process evidence")).toThrow();
    for (const forgedPath of ["managed_python/../models/weight.bin", "venv/../models/weight.bin"]) {
      const traversalAlias = structuredClone(evidence);
      const aliasedModel = traversalAlias.before.records.find(record => record.path === "models/weight.bin");
      aliasedModel.path = forgedPath;
      aliasedModel.mode = 0o711;
      expect(() => assertSchema(traversalAlias, EVIDENCE_SCHEMA, "Docling three-process evidence")).toThrow();
    }
    const forged = structuredClone(evidence);
    forged.before.inventory_sha256 = "0".repeat(64);
    expect(() => validateThreeFreshProcessEvidence(forged)).toThrow(/digest/);
  });

  it("rejects forged inventory digests, drift, and Python bytecode while accepting empty marker files", async () => {
    const { receipt, snapshot } = await fixture();
    const inventory = await captureDoclingRuntimeInventory(receipt);
    expect(inventory.records).toContainEqual(expect.objectContaining({ path: "venv/empty.marker", bytes: 0, sha256: digest("") }));
    await fs.writeFile(path.join(snapshot, "venv/leak.pyc"), "bytecode");
    await expect(captureDoclingRuntimeInventory(receipt)).rejects.toThrow(/bytecode drift/);
  });

  it("accepts exact mode-0711 files only in receipt-bound managed Python and venv inventories", async () => {
    const { receipt, managedExecutable, venvExecutable } = await fixture();
    const inventory = await captureDoclingRuntimeInventory(receipt);
    expect(inventory.records).toContainEqual(expect.objectContaining({ path: "managed_python/bin/python3.12", mode: 0o711 }));
    expect(inventory.records).toContainEqual(expect.objectContaining({ path: "venv/bin/docling", mode: 0o711 }));
    expect((await fs.stat(managedExecutable)).mode & 0o777).toBe(0o711);
    expect((await fs.stat(venvExecutable)).mode & 0o777).toBe(0o711);

    const forgedModel = structuredClone(inventory);
    forgedModel.records.find(record => record.path === "models/weight.bin").mode = 0o711;
    expect(() => validateDoclingRuntimeInventory(resignInventory(forgedModel))).toThrow(/file record/);

    for (const forgedPath of ["managed_python/../models/weight.bin", "venv/../models/weight.bin", "managed_python/./bin/python3.12", "managed_python//bin/python3.12", "/managed_python/bin/python3.12", "managed_python\\bin\\python3.12", "managed_python/bin/python3.12/"]) {
      const forgedPathInventory = structuredClone(inventory);
      forgedPathInventory.records.find(record => record.path === "models/weight.bin").path = forgedPath;
      forgedPathInventory.records.find(record => record.path === forgedPath).mode = 0o711;
      expect(() => validateDoclingRuntimeInventory(resignInventory(forgedPathInventory))).toThrow(/inventory record/);
    }
  });

  it("accepts and retains observed mode-0700 or mode-0777 only for managed Python and venv symlinks", async () => {
    const value = await fixture();
    const ordinary = await captureDoclingRuntimeInventory(value.receipt);
    expect(ordinary.records).toContainEqual(expect.objectContaining({ path: "managed_python/bin/python-link", type: "symlink", mode: 0o777 }));
    expect(ordinary.records).toContainEqual(expect.objectContaining({ path: "venv/bin/python", type: "symlink", mode: 0o777 }));

    const privateMode = await captureWithObservedSymlinkMode(value.receipt, [value.managedSymlink, value.venvSymlink], 0o700);
    expect(privateMode.records).toContainEqual(expect.objectContaining({ path: "managed_python/bin/python-link", type: "symlink", mode: 0o700 }));
    expect(privateMode.records).toContainEqual(expect.objectContaining({ path: "venv/bin/python", type: "symlink", mode: 0o700 }));
    expect((await fs.lstat(value.managedSymlink)).mode & 0o777).toBe(0o777);
    expect((await fs.lstat(value.venvSymlink)).mode & 0o777).toBe(0o777);

    for (const mode of [0o755, 0o711, 0o733]) {
      const forged = structuredClone(ordinary);
      forged.records.find(record => record.path === "managed_python/bin/python-link").mode = mode;
      expect(() => validateDoclingRuntimeInventory(resignInventory(forged))).toThrow(/symlink record/);
    }
    const forgedModel = structuredClone(ordinary);
    forgedModel.records.find(record => record.path === "managed_python/bin/python-link").path = "models/python-link";
    expect(() => validateDoclingRuntimeInventory(resignInventory(forgedModel))).toThrow(/symlink record/);
    for (const forgedPath of ["managed_python/../models/python-link", "venv/../models/python-link"]) {
      const traversal = structuredClone(ordinary);
      traversal.records.find(record => record.path === "managed_python/bin/python-link").path = forgedPath;
      expect(() => validateDoclingRuntimeInventory(resignInventory(traversal))).toThrow(/inventory record/);
    }
  });

  it.each([0o755, 0o711, 0o733])("rejects observed symlink mode %s", async mode => {
    const value = await fixture();
    await expect(captureWithObservedSymlinkMode(value.receipt, [value.venvSymlink], mode)).rejects.toThrow(/symlink violates/);
  });

  it("rejects model and escaping runtime symlinks", async () => {
    const modelCase = await fixture();
    await fs.symlink(path.join(modelCase.models, "weight.bin"), path.join(modelCase.models, "weight-link"));
    await expect(captureDoclingRuntimeInventory(modelCase.receipt)).rejects.toThrow(/symlink violates/);

    const escapeCase = await fixture();
    const outside = path.join(escapeCase.root, "outside-runtime");
    await fs.writeFile(outside, "outside");
    await fs.symlink(outside, path.join(escapeCase.snapshot, "venv/bin/escape"));
    await expect(captureDoclingRuntimeInventory(escapeCase.receipt)).rejects.toThrow(/symlink violates/);
  });

  it.each([
    ["managed Python group-write mode 0771", "managedExecutable", 0o771],
    ["venv group/other-write mode 0733", "venvExecutable", 0o733],
    ["venv group-write mode 0760", "venvExecutable", 0o760],
  ])("rejects %s", async (_label, target, mode) => {
    const value = await fixture();
    await fs.chmod(value[target], mode);
    await expect(captureDoclingRuntimeInventory(value.receipt)).rejects.toThrow(/mode\/link\/size policy/);
  });
});
