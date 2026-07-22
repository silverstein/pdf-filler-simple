import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "./extraction-phase1-protocol.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HELPER = path.join(REPO_ROOT, "test/eval/candidates/docling/fetch_pinned_layout.py");
const roots = [];

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

async function setup({ failDownload = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-docling-model-helper-"));
  roots.push(root);
  const parent = path.join(root, "models");
  const models = path.join(parent, "fresh-target");
  const fakeModuleRoot = path.join(root, "fake-python");
  await Promise.all([fs.mkdir(parent, { mode: 0o700 }), fs.mkdir(fakeModuleRoot, { mode: 0o700 })]);
  const fileBytes = { config: Buffer.from("config"), preprocessor: Buffer.from("preprocessor"), weight: Buffer.from("weight") };
  const config = {
    layout_model: {
      repository: "fixture/layout-model", revision: "1".repeat(40),
      weight_bytes: fileBytes.weight.length, weight_sha256: sha256(fileBytes.weight),
      config_sha256: sha256(fileBytes.config), preprocessor_config_sha256: sha256(fileBytes.preprocessor),
    },
  };
  const configBytes = Buffer.from(`${canonicalJson(config)}\n`);
  const configPath = path.join(root, "config.json");
  await fs.writeFile(configPath, configBytes, { mode: 0o600 });
  const moduleSource = failDownload
    ? "from pathlib import Path\ndef snapshot_download(repo_id,revision,local_dir):\n Path(local_dir).mkdir(parents=True); (Path(local_dir)/'partial').write_bytes(b'partial'); raise RuntimeError('interrupted')\n"
    : "from pathlib import Path\ndef snapshot_download(repo_id,revision,local_dir):\n p=Path(local_dir); p.mkdir(parents=True); (p/'config.json').write_bytes(b'config'); (p/'preprocessor_config.json').write_bytes(b'preprocessor'); (p/'weight.bin').write_bytes(b'weight')\n";
  await fs.writeFile(path.join(fakeModuleRoot, "huggingface_hub.py"), moduleSource, { mode: 0o600 });
  return { root, parent, models, fakeModuleRoot, configPath, configSha: sha256(configBytes) };
}

function run(fixture, expectedSha = fixture.configSha, environment = {}) {
  return spawnSync("python3", [HELPER, "--config", fixture.configPath, "--expected-config-sha256", expectedSha, "--models-path", fixture.models], {
    env: { PATH: process.env.PATH, PYTHONPATH: fixture.fakeModuleRoot, PYTHONDONTWRITEBYTECODE: "1", ...environment }, encoding: "utf8",
  });
}

afterEach(async () => Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))));

describe("Docling pinned model helper", () => {
  it("downloads into a private sibling, verifies it, and atomically publishes a fresh target", async () => {
    const fixture = await setup();
    const result = run(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ reused: false, inventory_path: path.join(fixture.models, "layout-model-inventory.v1.json") });
    expect((await fs.stat(fixture.models)).mode & 0o777).toBe(0o700);
    expect((await fs.readdir(fixture.parent)).sort()).toEqual(["fresh-target"]);
  });

  it("rejects config mismatch and an already-existing target without self-authorized reuse", async () => {
    const wrong = await setup();
    expect(run(wrong, "0".repeat(64)).status).not.toBe(0);
    expect(await fs.stat(wrong.models).catch(error => error.code)).toBe("ENOENT");

    const existing = await setup();
    await fs.mkdir(existing.models, { mode: 0o700 });
    expect(run(existing).status).not.toBe(0);
  });

  it("does not poison the final target when a staged download is interrupted", async () => {
    const interrupted = await setup({ failDownload: true });
    expect(run(interrupted).status).not.toBe(0);
    expect(await fs.stat(interrupted.models).catch(error => error.code)).toBe("ENOENT");
    expect((await fs.readdir(interrupted.parent)).some(name => name.includes(".staging-"))).toBe(false);
  });

  it("reconciles only an intent-marked target after post-rename parent fsync failure", async () => {
    const fixture = await setup();
    const failed = run(fixture, fixture.configSha, { PDF_TOOLS_DOCLING_TEST_PARENT_FSYNC_FAILURE: "1" });
    expect(failed.status).not.toBe(0);
    expect((await fs.stat(fixture.models)).isDirectory()).toBe(true);
    expect((await fs.readdir(fixture.parent)).some(name => name.endsWith(".publication-intent.v1.json"))).toBe(true);
    const recovered = run(fixture);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({ reused: false, recovered_after_parent_fsync: true });
    expect((await fs.readdir(fixture.parent)).sort()).toEqual(["fresh-target"]);
  });
});
