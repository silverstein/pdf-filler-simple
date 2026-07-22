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
const REPOSITORY_FILES = [".gitattributes", "README.md", "config.json", "docling_heron_400.png", "model.safetensors", "preprocessor_config.json"];

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

async function setup({ failDownload = false, unexpectedLocalCache = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-docling-model-helper-"));
  roots.push(root);
  const parent = path.join(root, "models");
  const models = path.join(parent, "fresh-target");
  const fakeModuleRoot = path.join(root, "fake-python");
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  const hfCache = path.join(root, "hf-cache");
  await Promise.all([parent, fakeModuleRoot, home, tmp, hfCache].map(directory => fs.mkdir(directory, { mode: 0o700 })));
  const repositoryContents = {
    ".gitattributes": "attributes", "README.md": "readme", "config.json": "config",
    "docling_heron_400.png": "png", "model.safetensors": "weight", "preprocessor_config.json": "preprocessor",
  };
  const fileBytes = { config: Buffer.from(repositoryContents["config.json"]), preprocessor: Buffer.from(repositoryContents["preprocessor_config.json"]), weight: Buffer.from(repositoryContents["model.safetensors"]) };
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
  const moduleSource = `from pathlib import Path
import os
def snapshot_download(repo_id,revision,local_dir):
 cache=Path(os.environ['HF_HOME']); log=cache/'xet'/'logs'/'download.log'; log.parent.mkdir(parents=True); log.write_text('transient')
 escape=os.environ.get('PDF_TOOLS_TEST_CACHE_ESCAPE_TARGET')
 if escape:
  (cache/'outside-link').symlink_to(escape); os.mkfifo(cache/'transient-fifo')
 p=Path(local_dir); p.mkdir(parents=True)
 files=${JSON.stringify(repositoryContents)}
 for name,value in files.items():
  target=p/name; target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(value.encode())
 mutation=os.environ.get('PDF_TOOLS_TEST_LOCAL_METADATA_MUTATION')
 hf=p/'.cache'/'huggingface'; download=hf/'download'; trees=hf/'trees'; download.mkdir(parents=True); trees.mkdir()
 (hf/'.gitignore').write_text('*\\n'); (hf/'CACHEDIR.TAG').write_text('Signature: 8a477f597d28d172789f06886806bc55\\n')
 tree_revision='2'*40 if mutation == 'wrong-revision' else revision
 (trees/f'{tree_revision}.json').write_text('{}')
 for name in files:
  metadata=download/f'{name}.metadata'; lock=download/f'{name}.lock'; metadata.parent.mkdir(parents=True,exist_ok=True)
  if not (mutation in ('symlink','special') and name == 'config.json'): metadata.write_text('transient')
  if not (mutation == 'missing' and name == 'README.md'): lock.write_bytes(b'')
 if mutation == 'symlink': (download/'config.json.metadata').symlink_to(p/'config.json')
 if mutation == 'special': os.mkfifo(download/'config.json.metadata')
 if mutation == 'extra': (download/'model.safetensors.incomplete').write_text('unexpected')
${unexpectedLocalCache ? " (p/'.cache'/'unexpected.bin').write_bytes(b'unexpected')" : ""}
${failDownload ? " (p/'partial').write_bytes(b'partial'); raise RuntimeError('interrupted')" : ""}
`;
  await fs.writeFile(path.join(fakeModuleRoot, "huggingface_hub.py"), moduleSource, { mode: 0o600 });
  return { root, parent, models, fakeModuleRoot, configPath, configSha: sha256(configBytes), home, tmp, hfCache };
}

function run(fixture, expectedSha = fixture.configSha, environment = {}, hfCachePath = fixture.hfCache) {
  return spawnSync("python3", [HELPER, "--config", fixture.configPath, "--expected-config-sha256", expectedSha, "--models-path", fixture.models, "--hf-cache-path", hfCachePath], {
    env: {
      PATH: process.env.PATH, PYTHONPATH: fixture.fakeModuleRoot, PYTHONDONTWRITEBYTECODE: "1",
      HOME: fixture.home, TMPDIR: fixture.tmp, HF_HOME: fixture.hfCache, ...environment,
    },
    encoding: "utf8",
  });
}

async function expectIsolationEmpty(fixture) {
  for (const directory of [fixture.home, fixture.tmp, fixture.hfCache]) expect(await fs.readdir(directory)).toEqual([]);
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
    const inventory = JSON.parse(await fs.readFile(path.join(fixture.models, "layout-model-inventory.v1.json"), "utf8"));
    expect(inventory.files.some(file => file.relative_path.includes(".cache"))).toBe(false);
    expect(inventory.files.map(file => file.relative_path).sort()).toEqual(REPOSITORY_FILES.map(filename => `fixture--layout-model/${filename}`).sort());
    expect((await fs.stat(fixture.hfCache)).mode & 0o777).toBe(0o700);
    await expectIsolationEmpty(fixture);
  });

  it("rejects config mismatch and an already-existing target without self-authorized reuse", async () => {
    const wrong = await setup();
    expect(run(wrong, "0".repeat(64)).status).not.toBe(0);
    expect(await fs.stat(wrong.models).catch(error => error.code)).toBe("ENOENT");
    await expectIsolationEmpty(wrong);

    const existing = await setup();
    await fs.mkdir(existing.models, { mode: 0o700 });
    expect(run(existing).status).not.toBe(0);
  });

  it("does not poison the final target when a staged download is interrupted", async () => {
    const interrupted = await setup({ failDownload: true });
    expect(run(interrupted).status).not.toBe(0);
    expect(await fs.stat(interrupted.models).catch(error => error.code)).toBe("ENOENT");
    expect((await fs.readdir(interrupted.parent)).some(name => name.includes(".staging-"))).toBe(false);
    await expectIsolationEmpty(interrupted);
  });

  it("rejects unexpected local download cache shapes without publishing them", async () => {
    const fixture = await setup({ unexpectedLocalCache: true });
    const result = run(fixture);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/\.cache.*unexpected shape/i);
    expect(await fs.stat(fixture.models).catch(error => error.code)).toBe("ENOENT");
    expect((await fs.readdir(fixture.parent)).some(name => name.includes(".staging-"))).toBe(false);
    await expectIsolationEmpty(fixture);
  });

  it.each(["extra", "missing", "wrong-revision", "symlink", "special"])("rejects %s pinned local metadata without publishing", async mutation => {
    const fixture = await setup();
    const result = run(fixture, fixture.configSha, { PDF_TOOLS_TEST_LOCAL_METADATA_MUTATION: mutation });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/metadata|download records/i);
    expect(await fs.stat(fixture.models).catch(error => error.code)).toBe("ENOENT");
    expect((await fs.readdir(fixture.parent)).some(name => name.includes(".staging-"))).toBe(false);
    await expectIsolationEmpty(fixture);
  });

  it("refuses a substituted or pre-populated receipt-bound HF cache", async () => {
    const substituted = await setup();
    const alternate = path.join(substituted.root, "alternate-cache");
    await fs.mkdir(alternate, { mode: 0o700 });
    const mismatch = run(substituted, substituted.configSha, { HF_HOME: alternate });
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toMatch(/does not match the receipt-bound cache path/i);
    expect(await fs.stat(substituted.models).catch(error => error.code)).toBe("ENOENT");
    await expectIsolationEmpty(substituted);

    const populated = await setup();
    await fs.writeFile(path.join(populated.hfCache, "sentinel"), "do not delete", { mode: 0o600 });
    const refused = run(populated);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/must be empty before setup/i);
    expect(await fs.readFile(path.join(populated.hfCache, "sentinel"), "utf8")).toBe("do not delete");
  });

  it("unlinks cache symlinks and special files without touching their targets", async () => {
    const fixture = await setup();
    const outside = path.join(fixture.root, "outside-cache-target");
    await fs.writeFile(outside, "preserve", { mode: 0o600 });
    const result = run(fixture, fixture.configSha, { PDF_TOOLS_TEST_CACHE_ESCAPE_TARGET: outside });
    expect(result.status, result.stderr).toBe(0);
    expect(await fs.readFile(outside, "utf8")).toBe("preserve");
    await expectIsolationEmpty(fixture);
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
    await expectIsolationEmpty(fixture);
  });
});
