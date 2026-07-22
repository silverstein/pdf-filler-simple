import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAX_HANDOFF_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FIXTURE_TOTAL_BYTES = 8 * 1024 * 1024;

function canonicalJson(value) {
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
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function defaultDoclingMacRoots(home = os.homedir()) {
  return {
    cacheRoot: path.join(home, "Library", "Caches", "oda-pdf-tools-extraction"),
    sidecarRoot: path.join(home, "Sites", "pdf-tools-extraction-sidecars"),
    protectedRoots: [
      path.join(home, "Documents"),
      path.join(home, "Dropbox"),
      path.join(home, "Library", "Mobile Documents"),
      path.join(home, "Library", "CloudStorage"),
    ],
  };
}

async function assertNoSymlinkAncestors(filename) {
  const absolute = path.resolve(filename);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const metadata = await fs.lstat(cursor);
      if (metadata.isSymbolicLink()) throw new Error(`Handoff path contains a symbolic link: ${cursor}`);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
}

async function secureDirectory(directory) {
  await assertNoSymlinkAncestors(directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await assertNoSymlinkAncestors(directory);
  const [metadata, resolved] = await Promise.all([fs.lstat(directory), fs.realpath(directory)]);
  if (!metadata.isDirectory() || resolved !== path.resolve(directory) || (metadata.mode & 0o777) !== 0o700) {
    throw new Error(`Handoff directory must be a real mode-0700 directory: ${directory}`);
  }
  return resolved;
}

async function readStableRegularFile(filename, maxBytes = MAX_HANDOFF_FILE_BYTES) {
  if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("Docling handoff requires O_NOFOLLOW support");
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maxBytes)) {
      throw new Error(`Handoff input must be a bounded, single-link regular file: ${filename}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    for (const property of ["dev", "ino", "nlink", "size", "mtimeNs", "ctimeNs"]) {
      if (String(before[property]) !== String(after[property])) throw new Error(`Handoff input changed while read: ${filename}`);
    }
    if (BigInt(bytes.length) !== before.size) throw new Error(`Handoff input length changed while read: ${filename}`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writeExclusive(filename, bytes, mode = 0o600) {
  const handle = await fs.open(filename, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const metadata = await fs.lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== mode) {
    throw new Error(`Handoff output did not retain its strict file contract: ${filename}`);
  }
}

function protectedRootDigest(protectedRoots) {
  return sha256(Buffer.from(`pdf-tools.docling-protected-roots.v1\0${canonicalJson([...protectedRoots].map(value => path.resolve(value)).sort())}`));
}

export async function phase0PdfPaths(repoRoot = REPO_ROOT) {
  const manifestPath = path.join(repoRoot, "test/fixtures/eval/extraction/manifest.v1.json");
  const manifest = JSON.parse(await readStableRegularFile(manifestPath, 1024 * 1024));
  if (manifest.suite_id !== "pdf-tools.extraction.phase0" || !Array.isArray(manifest.fixtures)) {
    throw new Error("Phase 0 manifest identity is invalid");
  }
  const fixturePaths = [];
  for (const fixture of manifest.fixtures) {
    const fixturePath = path.resolve(path.dirname(manifestPath), fixture.path);
    const bytes = await readStableRegularFile(fixturePath, MAX_FIXTURE_TOTAL_BYTES);
    if (sha256(bytes) !== fixture.sha256) throw new Error("Phase 0 fixture bytes do not match the accepted manifest");
    fixturePaths.push(fixturePath);
  }
  return fixturePaths;
}

export async function prepareDoclingMacHandoff({
  repoRoot = REPO_ROOT,
  cacheRoot,
  sidecarRoot,
  protectedRoots,
  fixturePaths,
  expectedPlatform = { platform: "darwin", architecture: "arm64" },
  observedPlatform = { platform: process.platform, architecture: process.arch },
} = {}) {
  if (!cacheRoot || !sidecarRoot || !Array.isArray(protectedRoots) || protectedRoots.length < 1
    || !Array.isArray(fixturePaths) || fixturePaths.length < 1) {
    throw new Error("Docling handoff requires explicit roots and at least one PDF fixture");
  }
  if (observedPlatform.platform !== expectedPlatform.platform || observedPlatform.architecture !== expectedPlatform.architecture) {
    throw new Error(`Docling handoff requires ${expectedPlatform.platform}/${expectedPlatform.architecture}`);
  }
  const resolvedCache = path.resolve(cacheRoot);
  const resolvedSidecar = path.resolve(sidecarRoot);
  for (const destination of [resolvedCache, resolvedSidecar]) {
    if (protectedRoots.some(root => within(root, destination))) {
      throw new Error("Docling handoff destinations must remain outside Documents, iCloud, Dropbox, and other protected roots");
    }
  }
  if (within(resolvedCache, resolvedSidecar) || within(resolvedSidecar, resolvedCache)) {
    throw new Error("Docling cache and sidecar roots must not contain one another");
  }

  const sourceSpecs = [
    ["adapter_entrypoint", "test/eval/candidates/docling/adapter.py"],
    ["model_setup_helper", "test/eval/candidates/docling/fetch_pinned_layout.py"],
    ["candidate_config", "test/fixtures/eval/extraction/phase1/docling-candidate-config.v1.json"],
    ["candidate_config_schema", "test/fixtures/eval/extraction/phase1/docling-candidate-config.schema.json"],
    ["candidate_request_schema", "test/fixtures/eval/extraction/phase1/candidate-request.schema.json"],
    ["candidate_response_schema", "test/fixtures/eval/extraction/phase1/candidate-response.schema.json"],
    ["handoff_schema", "test/fixtures/eval/extraction/phase1/docling-handoff.schema.json"],
  ];
  const sourceInputs = [];
  for (const [role, relativePath] of sourceSpecs) {
    const bytes = await readStableRegularFile(path.join(repoRoot, ...relativePath.split("/")));
    sourceInputs.push({ role, relativePath, bytes, sha256: sha256(bytes) });
  }
  const config = JSON.parse(sourceInputs.find(item => item.role === "candidate_config").bytes);
  const requirementsBytes = Buffer.from(`${config.packages
    .map(item => `${item.name === "docling-slim" ? config.install_requirement : `${item.name}==${item.version}`} --hash=sha256:${item.wheel_sha256}`)
    .sort().join("\n")}\n`);
  sourceInputs.push({ role: "direct_requirements", relativePath: "direct-requirements.in", bytes: requirementsBytes, sha256: sha256(requirementsBytes) });

  let fixtureTotalBytes = 0;
  const fixtureInputs = [];
  const fixtureDigests = new Set();
  for (const [index, fixturePath] of fixturePaths.entries()) {
    if (path.extname(fixturePath).toLowerCase() !== ".pdf") throw new Error("Docling handoff accepts only PDF fixtures");
    const bytes = await readStableRegularFile(fixturePath, MAX_FIXTURE_TOTAL_BYTES);
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Docling handoff fixture is not a PDF byte stream");
    fixtureTotalBytes += bytes.length;
    if (fixtureTotalBytes > MAX_FIXTURE_TOTAL_BYTES) throw new Error("Docling handoff fixture set exceeds the 8 MiB aggregate ceiling");
    const digest = sha256(bytes);
    if (fixtureDigests.has(digest)) throw new Error("Docling handoff fixture set contains duplicate bytes");
    fixtureDigests.add(digest);
    fixtureInputs.push({ ordinal: index + 1, bytes, sha256: digest, filename: `source-${String(index + 1).padStart(3, "0")}-${digest.slice(0, 12)}.pdf` });
  }
  const handoffIdentity = {
    protocol: "pdf-tools.docling-macos-handoff.v1",
    platform: expectedPlatform,
    source_inputs: sourceInputs.map(({ role, relativePath, bytes, ...identity }) => ({ role, source_name: path.basename(relativePath), bytes: bytes.length, ...identity })),
    fixtures: fixtureInputs.map(({ bytes, ...identity }) => ({ ...identity, bytes: bytes.length })),
  };
  const handoffId = sha256(Buffer.from(`pdf-tools.docling-macos-handoff.v1\0${canonicalJson(handoffIdentity)}`));

  await Promise.all([secureDirectory(resolvedCache), secureDirectory(resolvedSidecar)]);
  const uvRoot = await secureDirectory(path.join(resolvedCache, "uv"));
  const modelsRoot = await secureDirectory(path.join(resolvedCache, "models"));
  const runsRoot = await secureDirectory(path.join(resolvedCache, "runs"));
  const snapshotRoot = path.join(resolvedSidecar, `docling-${handoffId.slice(0, 16)}`);
  const runRoot = path.join(runsRoot, `handoff-${handoffId.slice(0, 16)}`);
  for (const destination of [snapshotRoot, runRoot]) {
    try {
      await fs.lstat(destination);
      throw new Error(`Refusing to overwrite an existing Docling handoff: ${destination}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await Promise.all([secureDirectory(snapshotRoot), secureDirectory(runRoot)]);
  const fixtureRoot = await secureDirectory(path.join(runRoot, "fixtures"));

  const retainedInputs = [];
  for (const input of sourceInputs) {
    const filename = input.role === "direct_requirements" ? "direct-requirements.in" : path.basename(input.relativePath);
    const destination = path.join(snapshotRoot, filename);
    await writeExclusive(destination, input.bytes);
    retainedInputs.push({ role: input.role, filename, bytes: input.bytes.length, sha256: input.sha256 });
  }
  const retainedFixtures = [];
  for (const fixture of fixtureInputs) {
    await writeExclusive(path.join(fixtureRoot, fixture.filename), fixture.bytes);
    retainedFixtures.push({ ordinal: fixture.ordinal, filename: fixture.filename, bytes: fixture.bytes.length, sha256: fixture.sha256 });
  }

  const venvRoot = path.join(snapshotRoot, "venv");
  const lockPath = path.join(snapshotRoot, "requirements.lock");
  const inputPath = path.join(snapshotRoot, "direct-requirements.in");
  const adapterPath = path.join(snapshotRoot, "adapter.py");
  const setupHelperPath = path.join(snapshotRoot, "fetch_pinned_layout.py");
  const configPath = path.join(snapshotRoot, "docling-candidate-config.v1.json");
  const receipt = {
    protocol: "pdf-tools.docling-macos-handoff.v1",
    handoff_id: handoffId,
    execution_state: "not_run",
    platform: { interpreter: "cpython-3.12.13-macos-aarch64-none", operating_system: "macos", architecture: "arm64", os_build: "capture_at_setup" },
    roots: {
      uv: uvRoot,
      models: modelsRoot,
      runs: runsRoot,
      sidecar_snapshot: snapshotRoot,
      protected_roots_sha256: protectedRootDigest(protectedRoots),
    },
    inputs: retainedInputs,
    fixtures: retainedFixtures,
    setup: {
      network_required: true,
      environment: { UV_CACHE_DIR: uvRoot },
      commands: [
        ["uv", "python", "install", "3.12.13"],
        ["uv", "venv", "--python", "3.12.13", venvRoot],
        ["uv", "pip", "compile", inputPath, "--python", path.join(venvRoot, "bin", "python"), "--generate-hashes", "--output-file", lockPath],
        ["uv", "pip", "sync", lockPath, "--python", path.join(venvRoot, "bin", "python"), "--require-hashes"],
        [path.join(venvRoot, "bin", "python"), setupHelperPath, "--config", configPath, "--models-path", modelsRoot],
      ],
      required_post_setup_evidence: ["uv_version", "python_version", "os_build", "resolved_lock_sha256", "installed_distribution_inventory", "model_file_inventory", "model_weight_sha256"],
    },
    execution: {
      offline_intent: true,
      network_isolation_enforced: false,
      environment: { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_DATASETS_OFFLINE: "1", UV_CACHE_DIR: uvRoot },
      command_template: [path.join(venvRoot, "bin", "python"), adapterPath, "--config", configPath, "--artifacts-path", modelsRoot],
      fixture_presentation: "Runner stages each retained PDF as source.pdf and does not expose this receipt or Phase 0 truth to the candidate request.",
    },
    claim_boundary: "Unexecuted private evaluation handoff only. No benchmark, package, product, redistribution, or release claim is authorized.",
  };
  const receiptBytes = Buffer.from(`${canonicalJson(receipt)}\n`);
  const receiptPath = path.join(runRoot, "docling-handoff.v1.json");
  await writeExclusive(receiptPath, receiptBytes);
  return { receipt, receiptPath, receipt_sha256: sha256(receiptBytes) };
}
