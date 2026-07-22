import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attestThreeFreshProcessStability, captureDoclingRuntimeInventory } from "./extraction-docling-runtime-evidence.js";

const roots = [];
const SHA = "a".repeat(64);

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-docling-runtime-"));
  roots.push(root);
  const snapshot = path.join(root, "snapshot");
  const managed = path.join(root, "managed");
  const models = path.join(root, "models");
  const uvPath = path.join(root, "uv");
  await Promise.all([fs.mkdir(path.join(snapshot, "venv/bin"), { recursive: true }), fs.mkdir(path.join(managed, "bin"), { recursive: true }), fs.mkdir(models)]);
  await Promise.all([
    fs.writeFile(path.join(managed, "bin/python3.12"), "python"),
    fs.symlink(path.join(managed, "bin/python3.12"), path.join(snapshot, "venv/bin/python")),
    fs.writeFile(path.join(snapshot, "venv/pyvenv.cfg"), "home = managed"),
    fs.writeFile(path.join(snapshot, "requirements.lock"), "locked"),
    fs.writeFile(path.join(models, "weight.bin"), "weight"),
    fs.writeFile(uvPath, "uv"),
  ]);
  const uvBytes = Buffer.from("uv");
  return {
    receipt: {
      handoff_id: SHA,
      roots: { sidecar_snapshot: snapshot, uv_python_install: managed, models },
      toolchain: { uv: { path: uvPath, version: "uv 0.8.15", bytes: uvBytes.length, sha256: "e6184ce10e266134fdcfa401e8f1a95005bcd4f18d16b62b757323e2833fe9a9" } },
      platform: { operating_system: "macos", architecture: "arm64", os_build: "25G88" },
    },
    snapshot,
  };
}

afterEach(async () => Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))));

describe("Docling runtime evidence", () => {
  it("proves exactly three distinct fresh processes left the anchored runtime unchanged", async () => {
    const { receipt } = await fixture();
    const before = await captureDoclingRuntimeInventory(receipt);
    const after = await Promise.all([1, 2, 3].map(() => captureDoclingRuntimeInventory(receipt)));
    const evidence = attestThreeFreshProcessStability({
      before,
      after,
      processes: [1, 2, 3].map(pid => ({ pid, exit_code: 0, request_sha256: SHA, source_sha256: SHA, response_sha256: SHA })),
    });
    expect(evidence).toMatchObject({ stable: true, process_ids: [1, 2, 3], baseline_inventory_sha256: before.inventory_sha256 });
  });

  it("rejects environment mutation, process reuse, and Python bytecode drift", async () => {
    const { receipt, snapshot } = await fixture();
    const before = await captureDoclingRuntimeInventory(receipt);
    await fs.appendFile(path.join(snapshot, "venv/pyvenv.cfg"), " changed");
    const changed = await captureDoclingRuntimeInventory(receipt);
    expect(() => attestThreeFreshProcessStability({
      before,
      after: [before, before, changed],
      processes: [1, 2, 3].map(pid => ({ pid, exit_code: 0, request_sha256: SHA, source_sha256: SHA, response_sha256: SHA })),
    })).toThrow(/drifted/);
    expect(() => attestThreeFreshProcessStability({
      before,
      after: [before, before, before],
      processes: [1, 1, 3].map(pid => ({ pid, exit_code: 0, request_sha256: SHA, source_sha256: SHA, response_sha256: SHA })),
    })).toThrow(/invalid or reused/);
    expect(() => attestThreeFreshProcessStability({
      before,
      after: [before, before, before],
      processes: [1, 2, 3].map(pid => ({ pid, exit_code: 0, request_sha256: SHA, source_sha256: SHA, response_sha256: String(pid).repeat(64) })),
    })).toThrow(/deterministic responses/);
    await fs.writeFile(path.join(snapshot, "venv/leak.pyc"), "bytecode");
    await expect(captureDoclingRuntimeInventory(receipt)).rejects.toThrow(/bytecode drift/);
  });
});
