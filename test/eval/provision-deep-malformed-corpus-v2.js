#!/usr/bin/env node

/**
 * Native-supervise two independent generations of the frozen 13-fixture
 * full-scale malformed-PDF corpus and retain exact manifests plus a logical
 * reproducibility comparison.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEEP_FIXTURE_CATALOG,
  DEEP_FULL_SCALE_BASE_FIXTURE_NAMES,
} from "../helpers/deep-malformed-fixtures.js";
import {
  canonicalJson,
  parseCanonicalCandidateJson,
  runSupervisedCandidate,
} from "./docling-macos-supervisor.js";

const PROVISION_REQUEST_PROTOCOL =
  "pdf-tools.deep-malformed-corpus-provision-request.v2";
const PROVISION_RESULT_PROTOCOL =
  "pdf-tools.deep-malformed-corpus-provision-result.v2";
const MANIFEST_PROTOCOL = "pdf-tools.deep-malformed-corpus-manifest.v2";
const COMPARISON_PROTOCOL =
  "pdf-tools.deep-malformed-corpus-reproducibility.v2";
const MAX_FIRST_PARTY_BYTES = 4 << 20;
const MAX_SUPERVISOR_BYTES = 4 << 20;
const MAX_BUILD_RECEIPT_BYTES = 256 * 1024;
const MAX_PROVISION_RESULT_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 4 << 20;
const MAX_COMPARISON_BYTES = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

const NATIVE_LIMITS = Object.freeze({
  deadline_ms: 60_000,
  leader_exit_grace_ms: 1000,
  sample_interval_ms: 5,
  stdout_max_bytes: 1024 * 1024,
  stderr_max_bytes: 1024 * 1024,
  physical_footprint_max_bytes: 2 * 2 ** 30,
  address_space_bytes: 512 * 2 ** 30,
  cpu_seconds: 60,
  file_size_bytes: 1024 * 1024 * 1024,
  nofile: 512,
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function commandOutput(executable, args, cwd = undefined) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new Error(`Unable to inspect candidate with ${path.basename(executable)}`);
  }
  return result.stdout.trim();
}

async function noLinkAncestors(filename) {
  let cursor = path.resolve(filename);
  for (;;) {
    const metadata = await fs.lstat(cursor);
    if (metadata.isSymbolicLink()) throw new Error(`Path contains a symbolic link: ${cursor}`);
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

async function realDirectory(directory, expectedMode = 0o700) {
  if (path.resolve(directory) !== directory) {
    throw new Error("Directory path must be canonical and absolute");
  }
  await noLinkAncestors(directory);
  const metadata = await fs.lstat(directory, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || Number(metadata.mode & 0o777n) !== expectedMode
    || await fs.realpath(directory) !== directory) {
    throw new Error("Directory violates its identity or mode contract");
  }
}

async function stableFile(
  filename,
  maximumBytes,
  { includeBytes = false } = {},
) {
  if (path.resolve(filename) !== filename) throw new Error("File path must be canonical and absolute");
  await noLinkAncestors(filename);
  const before = await fs.lstat(filename, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size < 1n || before.size > BigInt(maximumBytes)) {
    throw new Error(`File violates its regular-file contract: ${filename}`);
  }
  const handle = await fs.open(
    filename,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  const digest = createHash("sha256");
  const chunks = [];
  let observedBytes = 0;
  try {
    const descriptorBefore = await handle.stat({ bigint: true });
    if (descriptorBefore.dev !== before.dev || descriptorBefore.ino !== before.ino
      || descriptorBefore.size !== before.size || descriptorBefore.mode !== before.mode
      || descriptorBefore.nlink !== before.nlink) {
      throw new Error(`File changed before read: ${filename}`);
    }
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      observedBytes += bytesRead;
      if (observedBytes > maximumBytes) throw new Error(`File exceeds its byte ceiling: ${filename}`);
      const bytes = buffer.subarray(0, bytesRead);
      digest.update(bytes);
      if (includeBytes) chunks.push(Buffer.from(bytes));
    }
    const descriptorAfter = await handle.stat({ bigint: true });
    const pathnameAfter = await fs.lstat(filename, { bigint: true });
    if (descriptorAfter.dev !== before.dev || descriptorAfter.ino !== before.ino
      || descriptorAfter.size !== before.size || descriptorAfter.mode !== before.mode
      || descriptorAfter.nlink !== before.nlink
      || pathnameAfter.dev !== before.dev || pathnameAfter.ino !== before.ino
      || pathnameAfter.size !== before.size || pathnameAfter.mode !== before.mode
      || pathnameAfter.nlink !== before.nlink
      || observedBytes !== Number(before.size)) {
      throw new Error(`File changed during read: ${filename}`);
    }
  } finally {
    await handle.close();
  }
  if (await fs.realpath(filename) !== filename) throw new Error(`File is not canonical: ${filename}`);
  return {
    identity: {
      path: filename,
      bytes: observedBytes,
      sha256: digest.digest("hex"),
      mode: Number(before.mode & 0o777n),
      links: Number(before.nlink),
    },
    contents: includeBytes ? Buffer.concat(chunks) : null,
  };
}

async function stableFileIdentity(filename, maximumBytes) {
  return (await stableFile(filename, maximumBytes)).identity;
}

async function stableCanonicalJson(filename, maximumBytes) {
  const observed = await stableFile(
    filename,
    maximumBytes,
    { includeBytes: true },
  );
  const text = observed.contents.toString("utf8");
  const trimmed = text.trim();
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new Error("Evidence file must contain valid JSON");
  }
  if (`${canonicalJson(value)}\n` !== text) {
    throw new Error("Evidence file must contain canonical JSON plus one newline");
  }
  return { identity: observed.identity, value };
}

async function writeCanonicalJson(filename, value, maximumBytes) {
  const output = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  if (output.length > maximumBytes) throw new Error("Canonical evidence exceeds its byte ceiling");
  const handle = await fs.open(
    filename,
    fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(output);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return stableFileIdentity(filename, maximumBytes);
}

function validateBuildReceipt(receipt, supervisor, source) {
  if (receipt?.protocol !== "pdf-tools.macos-eval-supervisor-build.v1"
    || receipt?.testing !== false
    || canonicalJson(receipt?.binary) !== canonicalJson(supervisor)
    || receipt?.source?.sha256 !== source.sha256
    || receipt?.platform?.operating_system !== "macos"
    || !["arm64", "x86_64"].includes(receipt?.platform?.architecture)) {
    throw new Error("Supervisor build receipt does not bind binary/source/host");
  }
}

function validateIdentity(value, maximumBytes, {
  expectedPath = null,
  expectedMode = null,
} = {}) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort())
      === canonicalJson(["bytes", "links", "mode", "path", "sha256"])
    && typeof value.path === "string"
    && path.resolve(value.path) === value.path
    && (expectedPath === null || value.path === expectedPath)
    && Number.isSafeInteger(value.bytes)
    && value.bytes >= 1
    && value.bytes <= maximumBytes
    && value.links === 1
    && Number.isSafeInteger(value.mode)
    && value.mode >= 0
    && value.mode <= 0o777
    && (expectedMode === null || value.mode === expectedMode)
    && SHA256.test(value.sha256);
}

function validateProvisionRecord(
  record,
  request,
  {
    fixtureGenerator,
    nodeExecutable,
  },
) {
  return record
    && canonicalJson(Object.keys(record).sort()) === canonicalJson([
      "environment",
      "execution",
      "fixture",
      "generator",
      "protocol",
      "request",
    ])
    && record?.protocol === PROVISION_RESULT_PROTOCOL
    && canonicalJson(record?.request) === canonicalJson(request)
    && record.request.candidate_tree === request.candidate_tree
    && record.request.scale === "full"
    && record.request.output_path === request.output_path
    && record.request.generator_sha256 === fixtureGenerator.sha256
    && canonicalJson(Object.keys(record?.fixture ?? {}).sort())
      === canonicalJson(["input", "klass", "name", "note_sha256"])
    && record?.fixture?.name === request.fixture
    && DEEP_FIXTURE_CATALOG.find(entry => entry.name === request.fixture)?.klass
      === record?.fixture?.klass
    && SHA256.test(record?.fixture?.note_sha256 ?? "")
    && validateIdentity(
      record?.fixture?.input,
      250 << 20,
      { expectedPath: request.output_path, expectedMode: 0o400 },
    )
    && canonicalJson(record?.generator) === canonicalJson(fixtureGenerator)
    && canonicalJson(Object.keys(record?.environment ?? {}).sort())
      === canonicalJson(["node_executable", "node_version", "zlib_version"])
    && record?.environment?.zlib_version === process.versions.zlib
    && record?.environment?.node_version === process.version
    && canonicalJson(record?.environment?.node_executable)
      === canonicalJson(nodeExecutable)
    && canonicalJson(Object.keys(record?.execution ?? {}).sort())
      === canonicalJson(["elapsed_ns", "pid"])
    && Number.isSafeInteger(record?.execution?.pid)
    && record.execution.pid >= 1
    && Number.isSafeInteger(record?.execution?.elapsed_ns)
    && record.execution.elapsed_ns >= 0
    && record.execution.elapsed_ns <= 60_000_000_000;
}

function logicalFixture(row) {
  return {
    name: row.name,
    klass: row.klass,
    note_sha256: row.note_sha256,
    bytes: row.input.bytes,
    sha256: row.input.sha256,
    generator_sha256: row.generator.sha256,
    node_version: row.environment.node_version,
    node_sha256: row.environment.node_executable.sha256,
    zlib_version: row.environment.zlib_version,
  };
}

async function provisionGeneration({
  label,
  root,
  candidate,
  controller,
  provisioner,
  fixtureGenerator,
  supervisor,
  buildReceipt,
  nodeExecutable,
  nodeIdentity,
}) {
  const generationRoot = path.join(root, label);
  const inputsRoot = path.join(generationRoot, "inputs");
  const attemptsRoot = path.join(generationRoot, "attempts");
  await fs.mkdir(generationRoot, { mode: 0o700 });
  await fs.mkdir(inputsRoot, { mode: 0o700 });
  await fs.mkdir(attemptsRoot, { mode: 0o700 });
  const fixtures = [];
  for (const fixtureName of DEEP_FULL_SCALE_BASE_FIXTURE_NAMES) {
    const attemptRoot = path.join(attemptsRoot, fixtureName);
    const tmpRoot = path.join(attemptRoot, "tmp");
    const homeRoot = path.join(attemptRoot, "home");
    await fs.mkdir(attemptRoot, { mode: 0o700 });
    await fs.mkdir(tmpRoot, { mode: 0o700 });
    await fs.mkdir(homeRoot, { mode: 0o700 });
    const outputPath = path.join(inputsRoot, `${fixtureName}.pdf`);
    const request = {
      protocol: PROVISION_REQUEST_PROTOCOL,
      fixture: fixtureName,
      scale: "full",
      output_path: outputPath,
      candidate_tree: candidate.tree,
      generator_sha256: fixtureGenerator.sha256,
    };
    const result = await runSupervisedCandidate({
      binaryPath: supervisor.path,
      expectedBinary: supervisor,
      cwd: attemptRoot,
      command: [nodeExecutable, provisioner.path],
      stdin: Buffer.from(canonicalJson(request), "utf8"),
      environment: {
        HOME: homeRoot,
        TMPDIR: tmpRoot,
        LANG: "C",
        LC_ALL: "C",
        PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        PDF_TOOLS_CORPUS_OUTPUT_ROOT: inputsRoot,
      },
      deadlineMs: NATIVE_LIMITS.deadline_ms,
      leaderExitGraceMs: NATIVE_LIMITS.leader_exit_grace_ms,
      sampleIntervalMs: NATIVE_LIMITS.sample_interval_ms,
      stdoutMaxBytes: NATIVE_LIMITS.stdout_max_bytes,
      stderrMaxBytes: NATIVE_LIMITS.stderr_max_bytes,
      physicalFootprintMaxBytes: NATIVE_LIMITS.physical_footprint_max_bytes,
      addressSpaceBytes: NATIVE_LIMITS.address_space_bytes,
      cpuSeconds: NATIVE_LIMITS.cpu_seconds,
      fileSizeBytes: NATIVE_LIMITS.file_size_bytes,
      nofile: NATIVE_LIMITS.nofile,
    });
    const record = result.evidence.controller_accepted
      ? parseCanonicalCandidateJson(result.stdout, MAX_PROVISION_RESULT_BYTES)
      : null;
    const valid = result.evidence.controller_accepted === true
      && result.evidence.controller_failure === "none"
      && result.evidence.observations?.original_process_group_empty === true
      && result.evidence.observations?.escaped_session_detected === false
      && result.evidence.capture?.stdout_retained_bytes === result.stdout.length
      && result.evidence.capture?.stderr_observed_bytes === 0
      && result.evidence.capture?.stderr_retained_bytes === 0
      && result.exit?.code === 0
      && result.exit?.signal === null
      && result.supervisor_stderr.length === 0
      && validateProvisionRecord(record, request, {
        fixtureGenerator,
        nodeExecutable: nodeIdentity,
      });
    if (!valid) throw new Error(`Native provisioning failed for ${label}/${fixtureName}`);
    const input = await stableFileIdentity(outputPath, 250 << 20);
    if (input.bytes !== record.fixture.input.bytes
      || input.sha256 !== record.fixture.input.sha256
      || input.mode !== 0o400) {
      throw new Error(`Read-only corpus identity mismatch for ${label}/${fixtureName}`);
    }
    fixtures.push({
      name: fixtureName,
      klass: record.fixture.klass,
      note_sha256: record.fixture.note_sha256,
      input,
      generator: record.generator,
      environment: record.environment,
      provisioning: {
        request,
        candidate_stdout: {
          bytes: result.stdout.length,
          sha256: sha256(result.stdout),
          record,
        },
        supervisor_stderr: {
          bytes: result.supervisor_stderr.length,
          sha256: sha256(result.supervisor_stderr),
        },
        supervisor_evidence: result.evidence,
        supervisor_lease: result.lease,
        supervisor_exit: result.exit,
      },
    });
  }
  const manifest = {
    protocol: MANIFEST_PROTOCOL,
    generation: label,
    candidate,
    controller,
    provisioner,
    fixture_generator: fixtureGenerator,
    supervisor: {
      binary: supervisor,
      build_receipt: buildReceipt.identity,
    },
    environment: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      architecture: os.arch(),
      controller_node: {
        version: process.version,
        executable: nodeIdentity,
        zlib_version: process.versions.zlib,
      },
    },
    limits: NATIVE_LIMITS,
    fixtures,
  };
  const observedInputNames = (await fs.readdir(inputsRoot, {
    withFileTypes: true,
  })).map(entry => {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Corpus input root contains a non-file for ${label}`);
    }
    return entry.name;
  }).sort();
  const expectedInputNames = DEEP_FULL_SCALE_BASE_FIXTURE_NAMES
    .map(name => `${name}.pdf`)
    .sort();
  if (canonicalJson(observedInputNames) !== canonicalJson(expectedInputNames)) {
    throw new Error(`Corpus input root has an unexpected delta for ${label}`);
  }
  const manifestPath = path.join(generationRoot, "manifest.json");
  const manifestIdentity = await writeCanonicalJson(
    manifestPath,
    manifest,
    MAX_MANIFEST_BYTES,
  );
  return {
    manifest,
    identity: manifestIdentity,
    logical_fixtures: fixtures.map(logicalFixture),
  };
}

async function main() {
  if (process.platform !== "darwin" || process.argv.length !== 7) {
    throw new Error(
      "Usage: provision-deep-malformed-corpus-v2.js "
      + "/candidate /supervisor /build-receipt /private-output-root /comparison-output",
    );
  }
  const [, , candidatePath, supervisorPath, buildReceiptPath, outputRoot,
    comparisonOutput] = process.argv;
  for (const filename of [
    candidatePath,
    supervisorPath,
    buildReceiptPath,
    outputRoot,
    comparisonOutput,
  ]) {
    if (path.resolve(filename) !== filename) throw new Error("Every path must be canonical and absolute");
  }
  if (path.dirname(comparisonOutput) !== outputRoot) {
    throw new Error("Comparison output must be a direct child of the private output root");
  }
  await realDirectory(outputRoot);
  if ((await fs.readdir(outputRoot)).length !== 0) {
    throw new Error("Private corpus output root must start empty");
  }
  await noLinkAncestors(candidatePath);
  const candidateMetadata = await fs.lstat(candidatePath);
  if (!candidateMetadata.isDirectory() || candidateMetadata.isSymbolicLink()
    || await fs.realpath(candidatePath) !== candidatePath) {
    throw new Error("Candidate must be a real canonical directory");
  }
  const candidate = {
    path: candidatePath,
    head: commandOutput("/usr/bin/git", ["rev-parse", "HEAD"], candidatePath),
    tree: commandOutput("/usr/bin/git", ["rev-parse", "HEAD^{tree}"], candidatePath),
  };
  if (!/^[a-f0-9]{40}$/.test(candidate.head)
    || !/^[a-f0-9]{40}$/.test(candidate.tree)
    || commandOutput(
      "/usr/bin/git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      candidatePath,
    ) !== "") {
    throw new Error("Candidate must have exact clean Git identity");
  }
  const provisioner = await stableFileIdentity(
    path.join(candidatePath, "test/helpers/deep-malformed-corpus-provisioner-v2.js"),
    MAX_FIRST_PARTY_BYTES,
  );
  const fixtureGenerator = await stableFileIdentity(
    path.join(candidatePath, "test/helpers/deep-malformed-fixtures.js"),
    MAX_FIRST_PARTY_BYTES,
  );
  const controller = await stableFileIdentity(
    path.join(candidatePath, "test/eval/provision-deep-malformed-corpus-v2.js"),
    MAX_FIRST_PARTY_BYTES,
  );
  const supervisor = await stableFileIdentity(
    supervisorPath,
    MAX_SUPERVISOR_BYTES,
  );
  if (![0o700, 0o755].includes(supervisor.mode)) {
    throw new Error("Supervisor binary must have mode 0700 or 0755");
  }
  const buildReceipt = await stableCanonicalJson(
    buildReceiptPath,
    MAX_BUILD_RECEIPT_BYTES,
  );
  const supervisorSource = await stableFileIdentity(
    path.join(candidatePath, "test/eval/native/docling-macos-supervisor.c"),
    MAX_FIRST_PARTY_BYTES,
  );
  validateBuildReceipt(buildReceipt.value, supervisor, supervisorSource);
  const nodeExecutable = await fs.realpath(process.execPath);
  const nodeIdentity = await stableFileIdentity(nodeExecutable, 256 << 20);

  const generationA = await provisionGeneration({
    label: "generation-a",
    root: outputRoot,
    candidate,
    controller,
    provisioner,
    fixtureGenerator,
    supervisor,
    buildReceipt,
    nodeExecutable,
    nodeIdentity,
  });
  const generationB = await provisionGeneration({
    label: "generation-b",
    root: outputRoot,
    candidate,
    controller,
    provisioner,
    fixtureGenerator,
    supervisor,
    buildReceipt,
    nodeExecutable,
    nodeIdentity,
  });
  const logicalA = canonicalJson(generationA.logical_fixtures);
  const logicalB = canonicalJson(generationB.logical_fixtures);
  if (logicalA !== logicalB
    || generationA.logical_fixtures.length
      !== DEEP_FULL_SCALE_BASE_FIXTURE_NAMES.length
    || generationA.logical_fixtures.map(row => row.name).join("\n")
      !== DEEP_FULL_SCALE_BASE_FIXTURE_NAMES.join("\n")) {
    throw new Error("Two native corpus generations are not logically identical");
  }
  const comparison = {
    protocol: COMPARISON_PROTOCOL,
    candidate,
    controller,
    fixture_generator: fixtureGenerator,
    provisioner,
    supervisor: {
      binary: supervisor,
      build_receipt: buildReceipt.identity,
    },
    manifests: {
      generation_a: generationA.identity,
      generation_b: generationB.identity,
    },
    logical_fixtures: generationA.logical_fixtures,
    logical_fixture_digest: sha256(Buffer.from(logicalA, "utf8")),
    result: {
      planned_generations: 2,
      accepted_generations: 2,
      fixtures_per_generation: DEEP_FULL_SCALE_BASE_FIXTURE_NAMES.length,
      all_provisioning_rows_product_owned: true,
      byte_reproducible: true,
      status: "pass",
    },
  };
  const identity = await writeCanonicalJson(
    comparisonOutput,
    comparison,
    MAX_COMPARISON_BYTES,
  );
  process.stdout.write(`${canonicalJson({
    protocol: "pdf-tools.deep-malformed-corpus-reproducibility-written.v2",
    comparison: identity,
    summary: comparison.result,
  })}\n`);
}

main().catch(error => {
  process.stderr.write(`Corpus provisioning controller failed: ${error.message}\n`);
  process.exitCode = 1;
});
