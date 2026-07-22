import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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
  await Promise.all([fs.mkdir(path.join(snapshot, "venv/bin"), { recursive: true }), fs.mkdir(path.join(managed, "bin"), { recursive: true }), fs.mkdir(models), fs.mkdir(attempt)]);
  await Promise.all([
    fs.writeFile(managedExecutable, "python"), fs.symlink(managedExecutable, path.join(snapshot, "venv/bin/python")),
    fs.writeFile(venvExecutable, "docling"),
    fs.writeFile(path.join(snapshot, "venv/empty.marker"), ""), fs.writeFile(path.join(snapshot, "requirements.lock"), "locked"),
    fs.writeFile(path.join(models, "weight.bin"), "weight"), fs.writeFile(uv, "uv"), fs.writeFile(path.join(attempt, "source.pdf"), "%PDF-source"),
  ]);
  await Promise.all([fs.chmod(managedExecutable, 0o711), fs.chmod(venvExecutable, 0o711)]);
  const receipt = { handoff_id: SHA, roots: { sidecar_snapshot: snapshot, uv_python_install: managed, models }, toolchain: { uv: { path: uv, version: "uv 0.8.15", bytes: 2, sha256: digest("uv") } }, platform: { interpreter: "cpython-3.12.13-macos-aarch64-none", operating_system: "macos", architecture: "arm64", os_build: "25G88", kernel_release: "25.6.0", node_version: "v24.4.1" } };
  return { receipt, snapshot, managedExecutable, venvExecutable, models, attempt };
}

function resignInventory(inventory) {
  const core = structuredClone(inventory);
  delete core.inventory_sha256;
  return { ...core, inventory_sha256: digest(Buffer.from(`pdf-tools.docling-runtime-inventory.v1\0${canonicalJson(core)}`)) };
}

afterEach(async () => Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))));

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
