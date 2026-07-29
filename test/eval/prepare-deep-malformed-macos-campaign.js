#!/usr/bin/env node

/**
 * Prepare one exact 13 × 6 v2 product-campaign plan from a passing,
 * twice-provisioned native corpus comparison receipt.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEEP_FULL_SCALE_BASE_FIXTURE_NAMES,
} from "../helpers/deep-malformed-fixtures.js";
import { canonicalJson } from "./docling-macos-supervisor.js";
import { campaignV2Internals } from "./deep-malformed-macos-campaign-v2.js";

const PLAN_PROTOCOL = "pdf-tools.deep-malformed-macos-campaign-plan.v2";
const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_CORPUS_COMPARISON_BYTES = 1024 * 1024;
const MAX_BUILD_RECEIPT_BYTES = 256 * 1024;
const MAX_FIRST_PARTY_BYTES = 4 << 20;
const TOOL_NAMES = Object.freeze([
  "get_pdf_info",
  "read_pdf_fields",
  "read_pdf_content",
  "get_page_analysis",
  "rotate_pdf_pages",
  "split_pdf",
]);
const DEPENDENCIES = Object.freeze({
  sdk: Object.freeze({
    name: "@modelcontextprotocol/sdk",
    relative: "node_modules/@modelcontextprotocol/sdk/package.json",
  }),
  pdf_lib: Object.freeze({
    name: "pdf-lib",
    relative: "node_modules/pdf-lib/package.json",
  }),
  pdfjs_dist: Object.freeze({
    name: "pdfjs-dist",
    relative: "node_modules/pdfjs-dist/package.json",
  }),
  canvas: Object.freeze({
    name: "@napi-rs/canvas",
    relative: "node_modules/@napi-rs/canvas/package.json",
  }),
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
    throw new Error(`Unable to inspect evidence with ${path.basename(executable)}`);
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

async function realMode0700Directory(directory) {
  if (path.resolve(directory) !== directory) {
    throw new Error("Directory path must be canonical and absolute");
  }
  await noLinkAncestors(directory);
  const metadata = await fs.lstat(directory, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || Number(metadata.mode & 0o777n) !== 0o700
    || await fs.realpath(directory) !== directory) {
    throw new Error("Private plan parent must be a real mode-0700 directory");
  }
}

async function stableFile(filename, maximumBytes, { includeBytes = false } = {}) {
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

async function canonicalJsonFile(filename, maximumBytes) {
  const observed = await stableFile(filename, maximumBytes, { includeBytes: true });
  const text = observed.contents.toString("utf8");
  const trimmed = text.trim();
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new Error("Evidence file must contain valid JSON");
  }
  if (`${canonicalJson(value)}\n` !== text) {
    throw new Error("Evidence file must be canonical JSON plus one newline");
  }
  return { identity: observed.identity, value };
}

async function jsonFile(filename, maximumBytes) {
  const observed = await stableFile(filename, maximumBytes, { includeBytes: true });
  let value;
  try {
    value = JSON.parse(observed.contents.toString("utf8"));
  } catch {
    throw new Error(`JSON metadata is invalid: ${filename}`);
  }
  return { identity: observed.identity, value };
}

async function writeCanonicalJson(filename, value, maximumBytes) {
  const output = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  if (output.length > maximumBytes) throw new Error("Prepared plan exceeds its byte ceiling");
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
  return (await stableFile(filename, maximumBytes)).identity;
}

async function dependencyEvidence(candidatePath) {
  const output = {};
  for (const [key, dependency] of Object.entries(DEPENDENCIES)) {
    const packageJson = await jsonFile(
      path.join(candidatePath, dependency.relative),
      1024 * 1024,
    );
    if (packageJson.value?.name !== dependency.name
      || typeof packageJson.value?.version !== "string"
      || packageJson.value.version.length < 1
      || packageJson.value.version.length > 100) {
      throw new Error(`Installed dependency metadata is invalid for ${dependency.name}`);
    }
    output[key] = {
      name: dependency.name,
      version: packageJson.value.version,
      package_json: packageJson.identity,
    };
  }
  if (output.pdfjs_dist.version !== "5.4.624") {
    throw new Error("Protected pdfjs-dist pin changed");
  }
  return output;
}

async function main() {
  if (process.platform !== "darwin" || process.argv.length !== 10) {
    throw new Error(
      "Usage: prepare-deep-malformed-macos-campaign.js "
      + "/candidate /supervisor /build-receipt /corpus-comparison "
      + "/qpdf /attempt-root /plan-output /logical-run-label",
    );
  }
  const [, , candidatePath, supervisorPath, buildReceiptPath,
    corpusComparisonPath, qpdfRequestedPath, attemptRoot, planOutput,
    logicalRunLabel] = process.argv;
  if (!["run-a", "run-b"].includes(logicalRunLabel)) {
    throw new Error("Logical run label must be run-a or run-b");
  }
  for (const filename of [
    candidatePath,
    supervisorPath,
    buildReceiptPath,
    corpusComparisonPath,
    qpdfRequestedPath,
    attemptRoot,
    planOutput,
  ]) {
    if (path.resolve(filename) !== filename) throw new Error("Every path must be canonical and absolute");
  }
  if (path.dirname(attemptRoot) !== path.dirname(planOutput)) {
    throw new Error("Attempt root and plan output must share one private parent");
  }
  await realMode0700Directory(path.dirname(planOutput));
  for (const absent of [attemptRoot, planOutput]) {
    await fs.lstat(absent).then(
      () => { throw new Error("Attempt root or plan output already exists"); },
      error => {
        if (error?.code !== "ENOENT") throw error;
      },
    );
  }

  await noLinkAncestors(candidatePath);
  const candidateMetadata = await fs.lstat(candidatePath);
  if (!candidateMetadata.isDirectory() || candidateMetadata.isSymbolicLink()
    || await fs.realpath(candidatePath) !== candidatePath) {
    throw new Error("Candidate must be a real canonical directory");
  }
  const head = commandOutput("/usr/bin/git", ["rev-parse", "HEAD"], candidatePath);
  const tree = commandOutput("/usr/bin/git", ["rev-parse", "HEAD^{tree}"], candidatePath);
  const status = commandOutput(
    "/usr/bin/git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    candidatePath,
  );
  if (!/^[a-f0-9]{40}$/.test(head) || !/^[a-f0-9]{40}$/.test(tree) || status !== "") {
    throw new Error("Candidate must have exact clean Git identity");
  }
  const candidate = {
    path: candidatePath,
    head,
    tree,
    controller: (await stableFile(
      path.join(candidatePath, "test/eval/deep-malformed-macos-campaign-v2.js"),
      MAX_FIRST_PARTY_BYTES,
    )).identity,
    runner: (await stableFile(
      path.join(candidatePath, "test/helpers/deep-malformed-row-runner-v2.js"),
      MAX_FIRST_PARTY_BYTES,
    )).identity,
    server_entry: (await stableFile(
      path.join(candidatePath, "server/index.js"),
      MAX_FIRST_PARTY_BYTES,
    )).identity,
    fixture_module: (await stableFile(
      path.join(candidatePath, "test/helpers/deep-malformed-fixtures.js"),
      MAX_FIRST_PARTY_BYTES,
    )).identity,
    package_lock: (await stableFile(
      path.join(candidatePath, "package-lock.json"),
      16 << 20,
    )).identity,
    dependencies: await dependencyEvidence(candidatePath),
  };
  const supervisor = {
    binary: (await stableFile(supervisorPath, MAX_FIRST_PARTY_BYTES)).identity,
    build_receipt: (await stableFile(
      buildReceiptPath,
      MAX_BUILD_RECEIPT_BYTES,
    )).identity,
  };
  if (![0o700, 0o755].includes(supervisor.binary.mode)) {
    throw new Error("Supervisor binary must have mode 0700 or 0755");
  }
  const buildReceipt = await canonicalJsonFile(
    buildReceiptPath,
    MAX_BUILD_RECEIPT_BYTES,
  );
  if (buildReceipt.value?.protocol !== "pdf-tools.macos-eval-supervisor-build.v1"
    || buildReceipt.value?.testing !== false
    || canonicalJson(buildReceipt.value?.binary) !== canonicalJson(supervisor.binary)
    || buildReceipt.value?.source?.sha256
      !== (await stableFile(
        path.join(candidatePath, "test/eval/native/docling-macos-supervisor.c"),
        MAX_FIRST_PARTY_BYTES,
      )).identity.sha256) {
    throw new Error("Supervisor build receipt does not bind candidate source and binary");
  }
  const nodePath = await fs.realpath(process.execPath);
  if (nodePath !== process.execPath) {
    throw new Error("Campaign preparer must be invoked by canonical Node path");
  }
  const runtime = {
    node: {
      version: process.version,
      executable: (await stableFile(nodePath, 256 << 20)).identity,
    },
  };

  const corpusComparison = await canonicalJsonFile(
    corpusComparisonPath,
    MAX_CORPUS_COMPARISON_BYTES,
  );
  if (corpusComparison.value?.candidate?.head !== head
    || corpusComparison.value?.candidate?.tree !== tree
    || corpusComparison.value?.fixture_generator?.sha256
      !== candidate.fixture_module.sha256
    || corpusComparison.value?.fixture_generator?.path
      !== candidate.fixture_module.path
    || corpusComparison.value?.controller?.path !== path.join(
      candidatePath,
      "test/eval/provision-deep-malformed-corpus-v2.js",
    )
    || corpusComparison.value?.provisioner?.path !== path.join(
      candidatePath,
      "test/helpers/deep-malformed-corpus-provisioner-v2.js",
    )) {
    throw new Error("Corpus comparison does not authorize this candidate");
  }
  const corpusAuthority = {
    comparison: corpusComparison.identity,
    manifest: corpusComparison.value.manifests?.generation_a,
    provision_controller: corpusComparison.value.controller,
    provisioner: corpusComparison.value.provisioner,
    logical_fixture_digest:
      corpusComparison.value.logical_fixture_digest,
  };
  await campaignV2Internals.verifyCorpus(
    corpusAuthority,
    candidate,
    runtime,
  );

  const qpdfPath = await fs.realpath(qpdfRequestedPath);
  if (qpdfPath !== qpdfRequestedPath) {
    throw new Error("qpdf path must already be canonical, not a symlink");
  }
  const qpdf = {
    ...(await stableFile(qpdfPath, 64 << 20)).identity,
    version: commandOutput(qpdfPath, ["--version"]),
  };
  const timeouts = {
    product_ms: 45_000,
    canary_ms: 10_000,
  };
  const evidenceLimits = {
    inventory_entries: 512,
    per_file_bytes: 250 << 20,
    aggregate_inventory_bytes: 500 << 20,
    response_bytes: 4 << 20,
    response_nodes: 100_000,
    scanner_string_bytes: 4 << 20,
    semantic_fingerprint_bytes: 64 << 20,
    qpdf_timeout_ms: 10_000,
    qpdf_output_bytes: 1024 * 1024,
    row_result_bytes: 1024 * 1024,
    campaign_result_bytes: 16 << 20,
  };
  const nativeLimits = {
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
  };
  const matrix = DEEP_FULL_SCALE_BASE_FIXTURE_NAMES.flatMap(fixture =>
    TOOL_NAMES.map(tool => ({ fixture, tool })));
  if (matrix.length !== 78) throw new Error("Frozen campaign matrix is not 13 × 6");
  const plan = {
    protocol: PLAN_PROTOCOL,
    logical_run_label: logicalRunLabel,
    attempt_root: attemptRoot,
    candidate,
    supervisor,
    corpus: corpusAuthority,
    qpdf,
    runtime,
    timeouts,
    native_limits: nativeLimits,
    evidence_limits: evidenceLimits,
    matrix,
  };
  const planIdentity = await writeCanonicalJson(
    planOutput,
    plan,
    MAX_PLAN_BYTES,
  );
  process.stdout.write(`${canonicalJson({
    protocol: "pdf-tools.deep-malformed-macos-campaign-plan-prepared.v2",
    logical_run_label: logicalRunLabel,
    matrix_rows: matrix.length,
    plan: planIdentity,
    logical_plan_digest: sha256(Buffer.from(canonicalJson({
      ...plan,
      logical_run_label: "<normalized>",
      attempt_root: "<normalized>",
    }), "utf8")),
  })}\n`);
}

main().catch(error => {
  process.stderr.write(`Campaign plan preparation failed: ${error.message}\n`);
  process.exitCode = 1;
});
