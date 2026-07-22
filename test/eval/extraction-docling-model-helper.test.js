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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-docling-model-helper-"));
  roots.push(root);
  const models = path.join(root, "models");
  const repository = "fixture/layout-model";
  const repositoryRoot = path.join(models, "fixture--layout-model");
  await fs.mkdir(repositoryRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(models, 0o700);
  const fileBytes = {
    "fixture--layout-model/config.json": Buffer.from("config"),
    "fixture--layout-model/preprocessor_config.json": Buffer.from("preprocessor"),
    "fixture--layout-model/weight.bin": Buffer.from("weight"),
  };
  for (const [relative, bytes] of Object.entries(fileBytes)) await fs.writeFile(path.join(models, relative), bytes, { mode: 0o600 });
  const files = Object.entries(fileBytes).sort(([left], [right]) => left.localeCompare(right)).map(([relative_path, bytes]) => ({
    relative_path, bytes: bytes.length, sha256: sha256(bytes),
  }));
  const config = {
    layout_model: {
      repository,
      revision: "1".repeat(40),
      weight_bytes: fileBytes["fixture--layout-model/weight.bin"].length,
      weight_sha256: sha256(fileBytes["fixture--layout-model/weight.bin"]),
      config_sha256: sha256(fileBytes["fixture--layout-model/config.json"]),
      preprocessor_config_sha256: sha256(fileBytes["fixture--layout-model/preprocessor_config.json"]),
    },
  };
  const configBytes = Buffer.from(`${canonicalJson(config)}\n`);
  const configPath = path.join(root, "config.json");
  await fs.writeFile(configPath, configBytes, { mode: 0o600 });
  const inventory = {
    inventory_id: "pdf-tools.docling-layout-model-inventory.v1",
    repository,
    revision: config.layout_model.revision,
    files,
    file_set_sha256: sha256(Buffer.from(`pdf-tools.docling-layout-model-files.v1\0${canonicalJson(files)}`)),
    networked_setup: true,
    execution_state: "not_run",
  };
  await fs.writeFile(path.join(models, "layout-model-inventory.v1.json"), `${canonicalJson(inventory)}\n`, { mode: 0o600 });
  return { models, configPath, configSha: sha256(configBytes) };
}

function run(args) {
  return spawnSync("python3", [HELPER, ...args], {
    env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8",
  });
}

afterEach(async () => Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))));

describe("Docling pinned model helper", () => {
  it("reuses only the exact content-addressed mode-0600 inventory without network imports", async () => {
    const fixture = await setup();
    const result = run(["--config", fixture.configPath, "--expected-config-sha256", fixture.configSha, "--models-path", fixture.models]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ reused: true });
  });

  it("rejects config, file, and extra-file drift in an existing model root", async () => {
    const wrongConfig = await setup();
    expect(run(["--config", wrongConfig.configPath, "--expected-config-sha256", "0".repeat(64), "--models-path", wrongConfig.models]).status).not.toBe(0);

    const changed = await setup();
    await fs.appendFile(path.join(changed.models, "fixture--layout-model/weight.bin"), "changed");
    expect(run(["--config", changed.configPath, "--expected-config-sha256", changed.configSha, "--models-path", changed.models]).status).not.toBe(0);

    const extra = await setup();
    await fs.writeFile(path.join(extra.models, "extra.bin"), "extra", { mode: 0o600 });
    expect(run(["--config", extra.configPath, "--expected-config-sha256", extra.configSha, "--models-path", extra.models]).status).not.toBe(0);
  });
});
