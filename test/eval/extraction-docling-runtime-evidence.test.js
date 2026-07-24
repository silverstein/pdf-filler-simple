import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  captureDoclingRuntimeInventory,
  validateDoclingRuntimeInventory,
} from "./extraction-docling-runtime-evidence.js";

const roots = [];
const SHA = "a".repeat(64);
const digest = value => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-docling-runtime-")); roots.push(root);
  const snapshot = path.join(root, "snapshot"); const managed = path.join(root, "managed"); const models = path.join(root, "models"); const uv = path.join(root, "uv");
  const managedExecutable = path.join(managed, "bin/python3.12");
  const venvExecutable = path.join(snapshot, "venv/bin/docling");
  const managedSymlink = path.join(managed, "bin/python-link");
  const venvSymlink = path.join(snapshot, "venv/bin/python");
  await Promise.all([fs.mkdir(path.join(snapshot, "venv/bin"), { recursive: true }), fs.mkdir(path.join(managed, "bin"), { recursive: true }), fs.mkdir(models)]);
  await Promise.all([
    fs.writeFile(managedExecutable, "python"), fs.symlink(managedExecutable, managedSymlink), fs.symlink(managedExecutable, venvSymlink),
    fs.writeFile(venvExecutable, "docling"),
    fs.writeFile(path.join(snapshot, "venv/empty.marker"), ""), fs.writeFile(path.join(snapshot, "requirements.lock"), "locked"),
    fs.writeFile(path.join(models, "weight.bin"), "weight"), fs.writeFile(uv, "uv"),
  ]);
  await Promise.all([fs.chmod(managedExecutable, 0o711), fs.chmod(venvExecutable, 0o711)]);
  const receipt = { handoff_id: SHA, roots: { sidecar_snapshot: snapshot, uv_python_install: managed, models }, toolchain: { uv: { path: uv, version: "uv 0.8.15", bytes: 2, sha256: digest("uv") } }, platform: { interpreter: "cpython-3.12.13-macos-aarch64-none", operating_system: "macos", architecture: "arm64", os_build: "25G88", kernel_release: "25.6.0", node_version: "v24.4.1" } };
  return { root, receipt, snapshot, managedExecutable, venvExecutable, managedSymlink, venvSymlink, models };
}

function resignInventory(inventory) {
  const core = structuredClone(inventory);
  delete core.inventory_sha256;
  return { ...core, inventory_sha256: digest(Buffer.from(`pdf-tools.docling-runtime-inventory.v1\0${canonicalJson(core)}`)) };
}

function boundFinalization(receipt, {
  managed_python_files = [],
  venv_files = [],
  model_files = [],
} = {}) {
  const core = {
    protocol: "pdf-tools.docling-finalization.v1",
    handoff_id: receipt.handoff_id,
    receipt_sha256: SHA,
    managed_python_files,
    venv_files,
    model_files,
    execution_state: "setup_complete_not_executed",
  };
  return { ...core, finalization_id: digest(Buffer.from(`pdf-tools.docling-finalization.v1\0${canonicalJson(core)}`)) };
}

async function finalizedTreeRecord(root, relativePath) {
  const filename = path.join(root, ...relativePath.split("/"));
  const metadata = await fs.lstat(filename);
  const base = { relative_path: relativePath, type: metadata.isDirectory() ? "directory" : "file", mode: metadata.mode & 0o777, links: metadata.nlink };
  if (metadata.isDirectory()) return base;
  const bytes = await fs.readFile(filename);
  return { ...base, bytes: bytes.length, sha256: digest(bytes) };
}

async function installManagedBytecode(receipt) {
  const directoryRelative = "lib/python3.12/encodings/__pycache__";
  const directory = path.join(receipt.roots.uv_python_install, ...directoryRelative.split("/"));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const fileRelatives = ["aliases.cpython-312.pyc", "ascii.cpython-312.pyc", "utf_8.cpython-312.pyc"]
    .map(name => `${directoryRelative}/${name}`);
  await Promise.all(fileRelatives.map((relativePath, index) => fs.writeFile(
    path.join(receipt.roots.uv_python_install, ...relativePath.split("/")),
    Buffer.from(`finalized-bytecode-${index}`),
    { mode: 0o600 },
  )));
  const managed_python_files = [];
  for (const relativePath of [directoryRelative, ...fileRelatives]) {
    managed_python_files.push(await finalizedTreeRecord(receipt.roots.uv_python_install, relativePath));
  }
  return {
    directoryRelative,
    fileRelatives,
    inventories: { managed_python_files, venv_files: [], model_files: [] },
    finalization: boundFinalization(receipt, { managed_python_files }),
  };
}

async function captureWithObservedSymlinkMode(receipt, filenames, mode, finalization = boundFinalization(receipt)) {
  const selected = new Set(filenames.map(filename => path.resolve(filename)));
  const realLstat = fs.lstat.bind(fs);
  const lstat = vi.spyOn(fs, "lstat").mockImplementation(async (...arguments_) => {
    const metadata = await realLstat(...arguments_);
    if (selected.has(path.resolve(String(arguments_[0]))) && metadata.isSymbolicLink()) metadata.mode = (metadata.mode & ~0o777) | mode;
    return metadata;
  });
  try { return await captureDoclingRuntimeInventory(receipt, finalization); } finally { lstat.mockRestore(); }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("Docling runtime evidence", () => {
  it("requires a valid receipt-bound finalization while accepting empty marker files", async () => {
    const { receipt } = await fixture();
    await expect(captureDoclingRuntimeInventory(receipt)).rejects.toThrow(/finalization/);
    const inventory = await captureDoclingRuntimeInventory(receipt, boundFinalization(receipt));
    expect(inventory.records).toContainEqual(expect.objectContaining({ path: "venv/empty.marker", bytes: 0, sha256: digest("") }));
    const wrongReceipt = boundFinalization({ ...receipt, handoff_id: "b".repeat(64) });
    await expect(captureDoclingRuntimeInventory(receipt, wrongReceipt)).rejects.toThrow(/receipt-bound finalization/);
    const invalidDigest = { ...boundFinalization(receipt), finalization_id: "0".repeat(64) };
    await expect(captureDoclingRuntimeInventory(receipt, invalidDigest)).rejects.toThrow(/finalization digest/);
  });

  it("accepts the exact finalized managed-Python bytecode baseline", async () => {
    const { receipt } = await fixture();
    const bytecode = await installManagedBytecode(receipt);
    const inventory = await captureDoclingRuntimeInventory(receipt, bytecode.finalization);
    for (const record of bytecode.inventories.managed_python_files) {
      expect(inventory.records).toContainEqual({ path: `managed_python/${record.relative_path}`, ...Object.fromEntries(Object.entries(record).filter(([key]) => key !== "relative_path")) });
    }
  });

  it("rejects unbound __pycache__ directories and .pyc files", async () => {
    const { receipt, snapshot } = await fixture();
    const unboundDirectory = path.join(snapshot, "venv/__pycache__");
    await fs.mkdir(unboundDirectory, { mode: 0o700 });
    await expect(captureDoclingRuntimeInventory(receipt, boundFinalization(receipt))).rejects.toThrow(/bytecode differs/);
    await fs.rm(unboundDirectory, { recursive: true });
    await fs.writeFile(path.join(snapshot, "venv/leak.pyc"), "bytecode");
    await expect(captureDoclingRuntimeInventory(receipt, boundFinalization(receipt))).rejects.toThrow(/bytecode/);
  });

  it("rejects finalized bytecode with mismatched hash, bytes, mode, path, role, type, or links", async () => {
    const { receipt } = await fixture();
    const bytecode = await installManagedBytecode(receipt);
    const mutate = async callback => {
      const inventories = structuredClone(bytecode.inventories);
      callback(inventories);
      await expect(captureDoclingRuntimeInventory(receipt, boundFinalization(receipt, inventories))).rejects.toThrow(/bytecode|Finalization/);
    };
    const file = inventories => inventories.managed_python_files.find(record => record.type === "file");
    await mutate(inventories => { file(inventories).sha256 = "0".repeat(64); });
    await mutate(inventories => { file(inventories).bytes += 1; });
    await mutate(inventories => { file(inventories).mode = 0o644; });
    await mutate(inventories => { file(inventories).relative_path = `${bytecode.directoryRelative}/other.cpython-312.pyc`; });
    await mutate(inventories => { inventories.venv_files.push(inventories.managed_python_files.pop()); });
    await mutate(inventories => { file(inventories).type = "directory"; });
    await mutate(inventories => { file(inventories).links += 1; });
  });

  it("rejects finalized bytecode that is missing from the live runtime", async () => {
    const { receipt } = await fixture();
    const relative_path = "lib/python3.12/encodings/__pycache__/missing.cpython-312.pyc";
    const missing = { relative_path, type: "file", mode: 0o600, links: 1, bytes: 4, sha256: digest("miss") };
    await expect(captureDoclingRuntimeInventory(receipt, boundFinalization(receipt, { managed_python_files: [missing] }))).rejects.toThrow(/missing/);
  });

  it("never authorizes Python bytecode in the models role", async () => {
    const { receipt, models } = await fixture();
    const directoryRelative = "__pycache__";
    const fileRelative = "__pycache__/model.cpython-312.pyc";
    await fs.mkdir(path.join(models, directoryRelative), { mode: 0o700 });
    await fs.writeFile(path.join(models, ...fileRelative.split("/")), "model-bytecode", { mode: 0o600 });
    const model_files = [
      await finalizedTreeRecord(models, directoryRelative),
      await finalizedTreeRecord(models, fileRelative),
    ];
    await expect(captureDoclingRuntimeInventory(receipt, boundFinalization(receipt, { model_files }))).rejects.toThrow(/bytecode differs/);
  });

  it("accepts exact mode-0711 files only in receipt-bound managed Python and venv inventories", async () => {
    const { receipt, managedExecutable, venvExecutable } = await fixture();
    const inventory = await captureDoclingRuntimeInventory(receipt, boundFinalization(receipt));
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

  it("accepts and retains portable observed symlink modes only for managed Python and venv symlinks", async () => {
    const value = await fixture();
    const ordinary = await captureDoclingRuntimeInventory(value.receipt, boundFinalization(value.receipt));
    const observedManagedMode = (await fs.lstat(value.managedSymlink)).mode & 0o777;
    const observedVenvMode = (await fs.lstat(value.venvSymlink)).mode & 0o777;
    expect([0o755, 0o777]).toContain(observedManagedMode);
    expect([0o755, 0o777]).toContain(observedVenvMode);
    expect(ordinary.records).toContainEqual(expect.objectContaining({ path: "managed_python/bin/python-link", type: "symlink", mode: observedManagedMode, target: value.managedExecutable }));
    expect(ordinary.records).toContainEqual(expect.objectContaining({ path: "venv/bin/python", type: "symlink", mode: observedVenvMode, target: value.managedExecutable }));

    for (const mode of [0o700, 0o755, 0o777]) {
      const portableMode = await captureWithObservedSymlinkMode(value.receipt, [value.managedSymlink, value.venvSymlink], mode);
      expect(portableMode.records).toContainEqual(expect.objectContaining({ path: "managed_python/bin/python-link", type: "symlink", mode }));
      expect(portableMode.records).toContainEqual(expect.objectContaining({ path: "venv/bin/python", type: "symlink", mode }));
    }

    for (const mode of [0o000, 0o705, 0o711, 0o733, 0o775]) {
      const forged = structuredClone(ordinary);
      forged.records.find(record => record.path === "managed_python/bin/python-link").mode = mode;
      expect(() => validateDoclingRuntimeInventory(resignInventory(forged))).toThrow(/symlink record/);
    }
    const forgedLinks = structuredClone(ordinary);
    forgedLinks.records.find(record => record.path === "managed_python/bin/python-link").links = 2;
    expect(() => validateDoclingRuntimeInventory(resignInventory(forgedLinks))).toThrow(/symlink record/);
    const forgedModel = structuredClone(ordinary);
    forgedModel.records.find(record => record.path === "managed_python/bin/python-link").path = "models/python-link";
    expect(() => validateDoclingRuntimeInventory(resignInventory(forgedModel))).toThrow(/symlink record/);
    for (const forgedPath of ["managed_python/../models/python-link", "venv/../models/python-link"]) {
      const traversal = structuredClone(ordinary);
      traversal.records.find(record => record.path === "managed_python/bin/python-link").path = forgedPath;
      expect(() => validateDoclingRuntimeInventory(resignInventory(traversal))).toThrow(/inventory record/);
    }
  });

  it.each([0o000, 0o705, 0o711, 0o733, 0o775])("rejects unsupported observed symlink mode %s", async mode => {
    const value = await fixture();
    await expect(captureWithObservedSymlinkMode(value.receipt, [value.venvSymlink], mode)).rejects.toThrow(/symlink violates/);
  });

  it("rejects model and escaping runtime symlinks", async () => {
    const modelCase = await fixture();
    await fs.symlink(path.join(modelCase.models, "weight.bin"), path.join(modelCase.models, "weight-link"));
    await expect(captureDoclingRuntimeInventory(modelCase.receipt, boundFinalization(modelCase.receipt))).rejects.toThrow(/symlink violates/);

    const managedToModels = await fixture();
    await fs.rm(managedToModels.managedSymlink);
    await fs.symlink(path.join(managedToModels.models, "weight.bin"), managedToModels.managedSymlink);
    await expect(captureDoclingRuntimeInventory(managedToModels.receipt, boundFinalization(managedToModels.receipt))).rejects.toThrow(/symlink violates/);

    const venvToModels = await fixture();
    await fs.rm(venvToModels.venvSymlink);
    await fs.symlink(path.join(venvToModels.models, "weight.bin"), venvToModels.venvSymlink);
    await expect(captureDoclingRuntimeInventory(venvToModels.receipt, boundFinalization(venvToModels.receipt))).rejects.toThrow(/symlink violates/);

    const escapeCase = await fixture();
    const outside = path.join(escapeCase.root, "outside-runtime");
    await fs.writeFile(outside, "outside");
    await fs.symlink(outside, path.join(escapeCase.snapshot, "venv/bin/escape"));
    await expect(captureDoclingRuntimeInventory(escapeCase.receipt, boundFinalization(escapeCase.receipt))).rejects.toThrow(/symlink violates/);
  });

  it.each([
    ["managed Python group-write mode 0771", "managedExecutable", 0o771],
    ["venv group/other-write mode 0733", "venvExecutable", 0o733],
    ["venv group-write mode 0760", "venvExecutable", 0o760],
  ])("rejects %s", async (_label, target, mode) => {
    const value = await fixture();
    await fs.chmod(value[target], mode);
    await expect(captureDoclingRuntimeInventory(value.receipt, boundFinalization(value.receipt))).rejects.toThrow(/mode\/link\/size policy/);
  });
});
