#!/usr/bin/env node

/**
 * Execute one frozen 13 × 6 native macOS malformed-PDF campaign.
 *
 * Every row gets one fresh runner process group and one fresh MCP server.
 * There are no retries. Any transport outcome, supervisor limit, malformed
 * record, state-policy failure, invalid output, process escape, or missing row
 * is a qualification failure.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEEP_FIXTURE_CATALOG,
  DEEP_FULL_SCALE_BASE_FIXTURE_NAMES,
} from "../helpers/deep-malformed-fixtures.js";
import {
  canonicalJson,
  parseCanonicalCandidateJson,
  runSupervisedCandidate,
  validateSupervisorEvidence,
  validateSupervisorLease,
} from "./docling-macos-supervisor.js";
import {
  QPDF_BUDGET_BUILD_PROTOCOL,
  QPDF_BUDGET_COMMAND_CLAIM_BOUNDARY,
  QPDF_BUDGET_COMMAND_PROTOCOL,
  QPDF_ORACLE_POLICY,
  validQpdfPolicy,
  verifyQpdfMacosBudgetExecBuild,
} from "./qpdf-macos-budget-exec.js";

const PLAN_PROTOCOL = "pdf-tools.deep-malformed-macos-campaign-plan.v3";
const RESULT_PROTOCOL = "pdf-tools.deep-malformed-macos-campaign-result.v3";
const ROW_REQUEST_PROTOCOL = "pdf-tools.deep-malformed-row-request.v3";
const ROW_RESULT_PROTOCOL = "pdf-tools.deep-malformed-row-result.v3";
const CORPUS_COMPARISON_PROTOCOL =
  "pdf-tools.deep-malformed-corpus-reproducibility.v2";
const CORPUS_MANIFEST_PROTOCOL = "pdf-tools.deep-malformed-corpus-manifest.v2";
const MAX_PLAN_BYTES = 1024 * 1024;
const MAX_CORPUS_COMPARISON_BYTES = 1024 * 1024;
const MAX_CORPUS_MANIFEST_BYTES = 4 << 20;
const MAX_BUILD_RECEIPT_BYTES = 256 * 1024;
const MAX_FIRST_PARTY_BYTES = 4 << 20;
const SHA256 = /^[a-f0-9]{64}$/;
const CONTROL_PDF_BYTES = 728;
const CONTROL_PDF_SHA256 =
  "289a4cf752399fad51e42c1ba9c06dc1e6b8d471dfbc8403f2045b8ea2f8ecef";
const ROOT_LABELS = Object.freeze([
  "input",
  "rotate_output",
  "split_output",
  "profiles",
  "downloads",
  "home",
  "tmp",
]);
const TOOL_NAMES = Object.freeze([
  "get_pdf_info",
  "read_pdf_fields",
  "read_pdf_content",
  "get_page_analysis",
  "rotate_pdf_pages",
  "split_pdf",
]);
const PDFJS_CANARY_TOOLS = new Set([
  "read_pdf_content",
  "get_page_analysis",
]);
const MUTATOR_TOOLS = new Set([
  "rotate_pdf_pages",
  "split_pdf",
]);
const DEPENDENCY_RELATIVE_PATHS = Object.freeze({
  sdk: "node_modules/@modelcontextprotocol/sdk/package.json",
  pdf_lib: "node_modules/pdf-lib/package.json",
  pdfjs_dist: "node_modules/pdfjs-dist/package.json",
  canvas: "node_modules/@napi-rs/canvas/package.json",
});
const EXPECTED_TIMEOUTS = Object.freeze({
  product_ms: 45_000,
  canary_ms: 10_000,
});
const EXPECTED_NATIVE_LIMITS = Object.freeze({
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
const EXPECTED_EVIDENCE_LIMITS = Object.freeze({
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
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort());
}

function integer(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
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
    throw new Error("Campaign directory must be real, canonical, and mode 0700");
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
      throw new Error(`File changed while read: ${filename}`);
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
  let value;
  try {
    value = JSON.parse(text.trim());
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
  if (output.length > maximumBytes) throw new Error("Campaign receipt exceeds its byte ceiling");
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

function validateIdentity(value, maximumBytes) {
  return exactKeys(value, ["bytes", "links", "mode", "path", "sha256"])
    && typeof value.path === "string"
    && path.resolve(value.path) === value.path
    && integer(value.bytes, 1, maximumBytes)
    && value.links === 1
    && integer(value.mode, 0, 0o777)
    && SHA256.test(value.sha256);
}

function validateDependency(value, expectedName) {
  return exactKeys(value, ["name", "package_json", "version"])
    && value.name === expectedName
    && typeof value.version === "string"
    && value.version.length >= 1
    && value.version.length <= 100
    && validateIdentity(value.package_json, 1024 * 1024);
}

function expectedMatrix() {
  return DEEP_FULL_SCALE_BASE_FIXTURE_NAMES.flatMap(fixture =>
    TOOL_NAMES.map(tool => ({ fixture, tool })));
}

function validatePlan(plan) {
  if (!exactKeys(plan, [
    "attempt_root",
    "candidate",
    "corpus",
    "evidence_limits",
    "logical_run_label",
    "matrix",
    "native_limits",
    "protocol",
    "qpdf",
    "qpdf_budget_exec",
    "runtime",
    "supervisor",
    "timeouts",
  ])
    || plan.protocol !== PLAN_PROTOCOL
    || !["run-a", "run-b"].includes(plan.logical_run_label)
    || typeof plan.attempt_root !== "string"
    || path.resolve(plan.attempt_root) !== plan.attempt_root
  || !exactKeys(plan.candidate, [
      "controller",
      "dependencies",
      "fixture_module",
      "head",
      "package_lock",
      "path",
      "runner",
      "server_entry",
      "tree",
    ])
    || typeof plan.candidate.path !== "string"
    || path.resolve(plan.candidate.path) !== plan.candidate.path
    || !/^[a-f0-9]{40}$/.test(plan.candidate.head)
    || !/^[a-f0-9]{40}$/.test(plan.candidate.tree)
    || !validateIdentity(plan.candidate.runner, MAX_FIRST_PARTY_BYTES)
    || !validateIdentity(plan.candidate.controller, MAX_FIRST_PARTY_BYTES)
    || !validateIdentity(plan.candidate.server_entry, MAX_FIRST_PARTY_BYTES)
    || !validateIdentity(plan.candidate.fixture_module, MAX_FIRST_PARTY_BYTES)
    || !validateIdentity(plan.candidate.package_lock, 16 << 20)
    || plan.candidate.controller.path !== path.join(
      plan.candidate.path,
      "test/eval/deep-malformed-macos-campaign-v3.js",
    )
    || plan.candidate.runner.path !== path.join(
      plan.candidate.path,
      "test/helpers/deep-malformed-row-runner-v3.js",
    )
    || plan.candidate.server_entry.path !== path.join(
      plan.candidate.path,
      "server/index.js",
    )
    || plan.candidate.fixture_module.path !== path.join(
      plan.candidate.path,
      "test/helpers/deep-malformed-fixtures.js",
    )
    || plan.candidate.package_lock.path !== path.join(
      plan.candidate.path,
      "package-lock.json",
    )
    || !exactKeys(plan.candidate.dependencies, [
      "canvas",
      "pdf_lib",
      "pdfjs_dist",
      "sdk",
    ])
    || !validateDependency(
      plan.candidate.dependencies.sdk,
      "@modelcontextprotocol/sdk",
    )
    || !validateDependency(plan.candidate.dependencies.pdf_lib, "pdf-lib")
    || !validateDependency(plan.candidate.dependencies.pdfjs_dist, "pdfjs-dist")
    || plan.candidate.dependencies.pdfjs_dist.version !== "5.4.624"
    || !validateDependency(plan.candidate.dependencies.canvas, "@napi-rs/canvas")
    || Object.entries(DEPENDENCY_RELATIVE_PATHS).some(
      ([key, relative]) =>
        plan.candidate.dependencies[key].package_json.path
          !== path.join(plan.candidate.path, relative),
    )
    || !exactKeys(plan.supervisor, ["binary", "build_receipt"])
    || !validateIdentity(plan.supervisor.binary, MAX_FIRST_PARTY_BYTES)
    || ![0o700, 0o755].includes(plan.supervisor.binary.mode)
    || !validateIdentity(plan.supervisor.build_receipt, MAX_BUILD_RECEIPT_BYTES)
    || !exactKeys(plan.corpus, [
      "comparison",
      "logical_fixture_digest",
      "manifest",
      "provision_controller",
      "provisioner",
    ])
    || !validateIdentity(plan.corpus.comparison, MAX_CORPUS_COMPARISON_BYTES)
    || !validateIdentity(plan.corpus.manifest, MAX_CORPUS_MANIFEST_BYTES)
    || !validateIdentity(
      plan.corpus.provision_controller,
      MAX_FIRST_PARTY_BYTES,
    )
    || !validateIdentity(plan.corpus.provisioner, MAX_FIRST_PARTY_BYTES)
    || plan.corpus.provision_controller.path !== path.join(
      plan.candidate.path,
      "test/eval/provision-deep-malformed-corpus-v2.js",
    )
    || plan.corpus.provisioner.path !== path.join(
      plan.candidate.path,
      "test/helpers/deep-malformed-corpus-provisioner-v2.js",
    )
    || !SHA256.test(plan.corpus.logical_fixture_digest)
    || !exactKeys(plan.runtime, ["node"])
    || !exactKeys(plan.runtime.node, ["executable", "version"])
    || !validateIdentity(plan.runtime.node.executable, 256 << 20)
    || typeof plan.runtime.node.version !== "string"
    || plan.runtime.node.version.length < 1
    || plan.runtime.node.version.length > 100
    || !exactKeys(plan.qpdf, [
      "bytes",
      "links",
      "mode",
      "path",
      "sha256",
      "version",
    ])
    || typeof plan.qpdf.path !== "string"
    || path.resolve(plan.qpdf.path) !== plan.qpdf.path
    || !integer(plan.qpdf.bytes, 1, 64 << 20)
    || plan.qpdf.links !== 1
    || !integer(plan.qpdf.mode, 0, 0o777)
    || !SHA256.test(plan.qpdf.sha256)
    || typeof plan.qpdf.version !== "string"
    || plan.qpdf.version.length < 1
    || plan.qpdf.version.length > 200
    || (plan.qpdf.mode & 0o111) === 0
    || !exactKeys(plan.qpdf_budget_exec, [
      "binary",
      "build_receipt",
      "policy",
    ])
    || !validateIdentity(
      plan.qpdf_budget_exec.binary,
      MAX_FIRST_PARTY_BYTES,
    )
    || ![0o700, 0o755].includes(plan.qpdf_budget_exec.binary.mode)
    || !validateIdentity(
      plan.qpdf_budget_exec.build_receipt,
      MAX_BUILD_RECEIPT_BYTES,
    )
    || !validQpdfPolicy(plan.qpdf_budget_exec.policy)
    || canonicalJson(plan.qpdf_budget_exec.policy)
      !== canonicalJson(QPDF_ORACLE_POLICY)
    || canonicalJson(plan.timeouts) !== canonicalJson(EXPECTED_TIMEOUTS)
    || canonicalJson(plan.native_limits) !== canonicalJson(EXPECTED_NATIVE_LIMITS)
    || canonicalJson(plan.evidence_limits) !== canonicalJson(EXPECTED_EVIDENCE_LIMITS)
    || canonicalJson(plan.matrix) !== canonicalJson(expectedMatrix())
    || plan.matrix.length !== 78) {
    throw new Error("Campaign plan violates its exact v3 schema");
  }
}

async function verifyIdentity(expected, maximumBytes) {
  const observed = (await stableFile(expected.path, maximumBytes)).identity;
  if (canonicalJson(observed) !== canonicalJson(expected)) {
    throw new Error(`Evidence identity changed: ${expected.path}`);
  }
  return observed;
}

async function verifyCandidate(candidate) {
  await noLinkAncestors(candidate.path);
  const metadata = await fs.lstat(candidate.path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || await fs.realpath(candidate.path) !== candidate.path
    || commandOutput("/usr/bin/git", ["rev-parse", "HEAD"], candidate.path)
      !== candidate.head
    || commandOutput("/usr/bin/git", ["rev-parse", "HEAD^{tree}"], candidate.path)
      !== candidate.tree
    || commandOutput(
      "/usr/bin/git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      candidate.path,
    ) !== "") {
    throw new Error("Candidate Git identity or cleanliness changed");
  }
  await verifyIdentity(candidate.runner, MAX_FIRST_PARTY_BYTES);
  await verifyIdentity(candidate.controller, MAX_FIRST_PARTY_BYTES);
  await verifyIdentity(candidate.server_entry, MAX_FIRST_PARTY_BYTES);
  await verifyIdentity(candidate.fixture_module, MAX_FIRST_PARTY_BYTES);
  await verifyIdentity(candidate.package_lock, 16 << 20);
  for (const dependency of Object.values(candidate.dependencies)) {
    const observed = await stableFile(
      dependency.package_json.path,
      1024 * 1024,
      { includeBytes: true },
    );
    if (canonicalJson(observed.identity)
      !== canonicalJson(dependency.package_json)) {
      throw new Error(`Dependency identity changed: ${dependency.name}`);
    }
    const parsed = JSON.parse(observed.contents.toString("utf8"));
    if (parsed?.name !== dependency.name || parsed?.version !== dependency.version) {
      throw new Error(`Installed dependency metadata changed: ${dependency.name}`);
    }
  }
}

async function verifySupervisor(supervisor, candidate) {
  await verifyIdentity(supervisor.binary, MAX_FIRST_PARTY_BYTES);
  await verifyIdentity(supervisor.build_receipt, MAX_BUILD_RECEIPT_BYTES);
  const receipt = await canonicalJsonFile(
    supervisor.build_receipt.path,
    MAX_BUILD_RECEIPT_BYTES,
  );
  const source = (await stableFile(
    path.join(candidate.path, "test/eval/native/docling-macos-supervisor.c"),
    MAX_FIRST_PARTY_BYTES,
  )).identity;
  if (receipt.value?.protocol !== "pdf-tools.macos-eval-supervisor-build.v1"
    || receipt.value?.testing !== false
    || canonicalJson(receipt.value?.binary) !== canonicalJson(supervisor.binary)
    || receipt.value?.source?.sha256 !== source.sha256) {
    throw new Error("Supervisor build receipt no longer binds binary/source");
  }
}

async function verifyQpdfBudgetExec(authority, candidate) {
  await verifyIdentity(authority.binary, MAX_FIRST_PARTY_BYTES);
  await verifyIdentity(authority.build_receipt, MAX_BUILD_RECEIPT_BYTES);
  const receipt = await canonicalJsonFile(
    authority.build_receipt.path,
    MAX_BUILD_RECEIPT_BYTES,
  );
  if (receipt.value?.protocol !== QPDF_BUDGET_BUILD_PROTOCOL
      || canonicalJson(receipt.value?.binary)
        !== canonicalJson(authority.binary)
      || receipt.value?.testing !== false) {
    throw new Error("qpdf budget launcher receipt does not bind production binary");
  }
  await verifyQpdfMacosBudgetExecBuild(receipt.value, {
    sourcePath: path.join(
      candidate.path,
      "test/eval/native/qpdf-macos-budget-exec.c",
    ),
    binaryPath: authority.binary.path,
    architecture: process.arch,
    testing: false,
    verifyToolchain: true,
  });
}

function validateCorpusComparison(comparison, candidate, corpus) {
  const comparisonRoot = path.dirname(corpus.comparison.path);
  if (!exactKeys(comparison, [
    "candidate",
    "controller",
    "fixture_generator",
    "logical_fixture_digest",
    "logical_fixtures",
    "manifests",
    "protocol",
    "provisioner",
    "result",
    "supervisor",
  ])
    || comparison.protocol !== CORPUS_COMPARISON_PROTOCOL
    || !exactKeys(comparison.candidate, ["head", "path", "tree"])
    || comparison.candidate.path !== candidate.path
    || comparison.candidate.head !== candidate.head
    || comparison.candidate.tree !== candidate.tree
    || canonicalJson(comparison.controller)
      !== canonicalJson(corpus.provision_controller)
    || canonicalJson(comparison.provisioner)
      !== canonicalJson(corpus.provisioner)
    || canonicalJson(comparison.fixture_generator)
      !== canonicalJson(candidate.fixture_module)
    || !exactKeys(comparison.supervisor, ["binary", "build_receipt"])
    || !validateIdentity(comparison.supervisor.binary, MAX_FIRST_PARTY_BYTES)
    || !validateIdentity(
      comparison.supervisor.build_receipt,
      MAX_BUILD_RECEIPT_BYTES,
    )
    || !exactKeys(comparison.manifests, [
      "generation_a",
      "generation_b",
    ])
    || !validateIdentity(
      comparison.manifests.generation_a,
      MAX_CORPUS_MANIFEST_BYTES,
    )
    || !validateIdentity(
      comparison.manifests.generation_b,
      MAX_CORPUS_MANIFEST_BYTES,
    )
    || canonicalJson(comparison.manifests.generation_a)
      !== canonicalJson(corpus.manifest)
    || comparison.manifests.generation_a.path !== path.join(
      comparisonRoot,
      "generation-a",
      "manifest.json",
    )
    || comparison.manifests.generation_b.path !== path.join(
      comparisonRoot,
      "generation-b",
      "manifest.json",
    )
    || !Array.isArray(comparison.logical_fixtures)
    || comparison.logical_fixtures.length !== 13
    || comparison.logical_fixtures.map(row => row.name).join("\n")
      !== DEEP_FULL_SCALE_BASE_FIXTURE_NAMES.join("\n")
    || comparison.logical_fixtures.some(row =>
      !exactKeys(row, [
        "bytes",
        "generator_sha256",
        "klass",
        "name",
        "node_sha256",
        "node_version",
        "note_sha256",
        "sha256",
        "zlib_version",
      ])
      || DEEP_FIXTURE_CATALOG.find(entry => entry.name === row.name)?.klass
        !== row.klass
      || !integer(row.bytes, 1, 250 << 20)
      || !SHA256.test(row.sha256)
      || !SHA256.test(row.note_sha256)
      || row.generator_sha256 !== candidate.fixture_module.sha256
      || typeof row.node_version !== "string"
      || row.node_version.length < 1
      || row.node_version.length > 100
      || !SHA256.test(row.node_sha256)
      || typeof row.zlib_version !== "string"
      || row.zlib_version.length < 1
      || row.zlib_version.length > 100)
    || comparison.logical_fixture_digest
      !== sha256(Buffer.from(
        canonicalJson(comparison.logical_fixtures),
        "utf8",
      ))
    || comparison.logical_fixture_digest !== corpus.logical_fixture_digest
    || !exactKeys(comparison.result, [
      "accepted_generations",
      "all_provisioning_rows_product_owned",
      "byte_reproducible",
      "fixtures_per_generation",
      "planned_generations",
      "status",
    ])
    || comparison.result.status !== "pass"
    || comparison.result.planned_generations !== 2
    || comparison.result.accepted_generations !== 2
    || comparison.result.fixtures_per_generation !== 13
    || comparison.result.all_provisioning_rows_product_owned !== true
    || comparison.result.byte_reproducible !== true) {
    throw new Error("Corpus comparison violates its exact v2 contract");
  }
}

function validProvisionRecord(
  record,
  source,
  logical,
  manifest,
  candidate,
) {
  return exactKeys(record, [
    "environment",
    "execution",
    "fixture",
    "generator",
    "protocol",
    "request",
  ])
    && record.protocol
      === "pdf-tools.deep-malformed-corpus-provision-result.v2"
    && exactKeys(record.request, [
      "candidate_tree",
      "fixture",
      "generator_sha256",
      "output_path",
      "protocol",
      "scale",
    ])
    && record.request.protocol
      === "pdf-tools.deep-malformed-corpus-provision-request.v2"
    && record.request.fixture === source.name
    && record.request.scale === "full"
    && record.request.output_path === source.input.path
    && record.request.candidate_tree === candidate.tree
    && record.request.generator_sha256 === candidate.fixture_module.sha256
    && exactKeys(record.fixture, ["input", "klass", "name", "note_sha256"])
    && record.fixture.name === source.name
    && record.fixture.klass === source.klass
    && record.fixture.note_sha256 === source.note_sha256
    && canonicalJson(record.fixture.input) === canonicalJson(source.input)
    && canonicalJson(record.generator)
      === canonicalJson(candidate.fixture_module)
    && exactKeys(record.environment, [
      "node_executable",
      "node_version",
      "zlib_version",
    ])
    && record.environment.node_version
      === manifest.environment.controller_node.version
    && canonicalJson(record.environment.node_executable)
      === canonicalJson(manifest.environment.controller_node.executable)
    && record.environment.zlib_version
      === manifest.environment.controller_node.zlib_version
    && record.environment.node_version === logical.node_version
    && record.environment.node_executable.sha256 === logical.node_sha256
    && record.environment.zlib_version === logical.zlib_version
    && exactKeys(record.execution, ["elapsed_ns", "pid"])
    && integer(record.execution.pid, 1, 2147483647)
    && integer(record.execution.elapsed_ns, 0, 60_000_000_000);
}

function validProvisioning(
  provisioning,
  source,
  logical,
  manifest,
  candidate,
) {
  if (!exactKeys(provisioning, [
    "candidate_stdout",
    "request",
    "supervisor_evidence",
    "supervisor_exit",
    "supervisor_lease",
    "supervisor_stderr",
  ])
    || !exactKeys(provisioning.candidate_stdout, [
      "bytes",
      "record",
      "sha256",
    ])
    || !exactKeys(provisioning.supervisor_stderr, ["bytes", "sha256"])
    || !exactKeys(provisioning.supervisor_exit, ["code", "signal"])
    || canonicalJson(provisioning.request)
      !== canonicalJson(provisioning.candidate_stdout.record?.request)
    || !validProvisionRecord(
      provisioning.candidate_stdout.record,
      source,
      logical,
      manifest,
      candidate,
    )) {
    return false;
  }
  const recordBytes = Buffer.from(
    `${canonicalJson(provisioning.candidate_stdout.record)}\n`,
    "utf8",
  );
  if (provisioning.candidate_stdout.bytes !== recordBytes.length
    || provisioning.candidate_stdout.sha256 !== sha256(recordBytes)
    || provisioning.supervisor_stderr.bytes !== 0
    || provisioning.supervisor_stderr.sha256 !== sha256(Buffer.alloc(0))
    || provisioning.supervisor_exit.code !== 0
    || provisioning.supervisor_exit.signal !== null) {
    return false;
  }
  try {
    validateSupervisorLease(provisioning.supervisor_lease);
    validateSupervisorEvidence(
      provisioning.supervisor_evidence,
      provisioning.supervisor_lease,
      expectedSupervisorOptions({ native_limits: manifest.limits }),
    );
  } catch {
    return false;
  }
  return provisioning.supervisor_evidence.controller_accepted === true
    && provisioning.supervisor_evidence.controller_failure === "none"
    && provisioning.supervisor_evidence.capture.stdout_retained_bytes
      === provisioning.candidate_stdout.bytes
    && provisioning.supervisor_evidence.capture.stderr_observed_bytes === 0
    && provisioning.supervisor_evidence.capture.stderr_retained_bytes === 0
    && provisioning.supervisor_evidence.observations
      .original_process_group_empty === true
    && provisioning.supervisor_evidence.observations
      .escaped_session_detected === false
    && integer(
      provisioning.supervisor_evidence.observations.max_group_members,
      1,
      8,
    )
    && integer(
      provisioning.supervisor_evidence.observations
        .observed_process_identity_count,
      1,
      16,
    );
}

function validateCorpusManifest(
  manifest,
  comparison,
  candidate,
  expectedGeneration,
  runtime,
  manifestAuthority,
) {
  const expectedInputsRoot = path.join(
    path.dirname(manifestAuthority.path),
    "inputs",
  );
  if (!exactKeys(manifest, [
    "candidate",
    "controller",
    "environment",
    "fixture_generator",
    "fixtures",
    "generation",
    "limits",
    "protocol",
    "provisioner",
    "supervisor",
  ])
    || manifest.protocol !== CORPUS_MANIFEST_PROTOCOL
    || manifest.generation !== expectedGeneration
    || canonicalJson(manifest.candidate)
      !== canonicalJson(comparison.candidate)
    || canonicalJson(manifest.controller)
      !== canonicalJson(comparison.controller)
    || canonicalJson(manifest.provisioner)
      !== canonicalJson(comparison.provisioner)
    || canonicalJson(manifest.fixture_generator)
      !== canonicalJson(comparison.fixture_generator)
    || canonicalJson(manifest.supervisor)
      !== canonicalJson(comparison.supervisor)
    || canonicalJson(manifest.limits)
      !== canonicalJson(EXPECTED_NATIVE_LIMITS)
    || !exactKeys(manifest.environment, [
      "architecture",
      "controller_node",
      "hostname",
      "platform",
      "release",
    ])
    || manifest.environment.platform !== "darwin"
    || !["arm64", "x64"].includes(manifest.environment.architecture)
    || typeof manifest.environment.hostname !== "string"
    || manifest.environment.hostname.length < 1
    || typeof manifest.environment.release !== "string"
    || manifest.environment.release.length < 1
    || !exactKeys(manifest.environment.controller_node, [
      "executable",
      "version",
      "zlib_version",
    ])
    || canonicalJson({
      executable: manifest.environment.controller_node.executable,
      version: manifest.environment.controller_node.version,
    }) !== canonicalJson(runtime.node)
    || manifest.environment.controller_node.zlib_version
      !== process.versions.zlib
    || !Array.isArray(manifest.fixtures)
    || manifest.fixtures.length !== 13
    || manifest.fixtures.map(row => row.name).join("\n")
      !== DEEP_FULL_SCALE_BASE_FIXTURE_NAMES.join("\n")) {
    throw new Error(
      `Corpus ${expectedGeneration} manifest violates its exact v2 contract`,
    );
  }
  const fixtures = [];
  for (let index = 0; index < manifest.fixtures.length; index += 1) {
    const source = manifest.fixtures[index];
    const logical = comparison.logical_fixtures?.[index];
    const catalog = DEEP_FIXTURE_CATALOG.find(row => row.name === source.name);
    if (!exactKeys(source, [
      "environment",
      "generator",
      "input",
      "klass",
      "name",
      "note_sha256",
      "provisioning",
    ])
      || !catalog || source.klass !== catalog.klass
      || source.name !== logical?.name
      || source.klass !== logical?.klass
      || source.note_sha256 !== logical?.note_sha256
      || source.input.bytes !== logical?.bytes
      || source.input.sha256 !== logical?.sha256
      || !validateIdentity(source.input, 250 << 20)
      || source.input.mode !== 0o400
      || source.input.path !== path.join(
        expectedInputsRoot,
        `${source.name}.pdf`,
      )
      || canonicalJson(source.generator)
        !== canonicalJson(candidate.fixture_module)
      || canonicalJson(source.environment)
        !== canonicalJson(
          source.provisioning?.candidate_stdout?.record?.environment,
        )
      || !SHA256.test(source.note_sha256 ?? "")
      || !validProvisioning(
        source.provisioning,
        source,
        logical,
        manifest,
        candidate,
      )) {
      throw new Error(`Corpus fixture authority failed at ${source?.name ?? index}`);
    }
    fixtures.push({
      name: source.name,
      klass: source.klass,
      note_sha256: source.note_sha256,
      path: source.input.path,
      bytes: source.input.bytes,
      sha256: source.input.sha256,
    });
  }
  return fixtures;
}

async function verifyCorpus(corpus, candidate, runtime) {
  await verifyIdentity(corpus.comparison, MAX_CORPUS_COMPARISON_BYTES);
  await verifyIdentity(corpus.manifest, MAX_CORPUS_MANIFEST_BYTES);
  const comparison = await canonicalJsonFile(
    corpus.comparison.path,
    MAX_CORPUS_COMPARISON_BYTES,
  );
  const manifest = await canonicalJsonFile(
    corpus.manifest.path,
    MAX_CORPUS_MANIFEST_BYTES,
  );
  await verifyIdentity(corpus.provision_controller, MAX_FIRST_PARTY_BYTES);
  await verifyIdentity(corpus.provisioner, MAX_FIRST_PARTY_BYTES);
  validateCorpusComparison(comparison.value, candidate, corpus);
  const secondaryManifest = await canonicalJsonFile(
    comparison.value.manifests.generation_b.path,
    MAX_CORPUS_MANIFEST_BYTES,
  );
  if (canonicalJson(secondaryManifest.identity)
      !== canonicalJson(comparison.value.manifests.generation_b)) {
    throw new Error("Secondary corpus manifest identity changed");
  }
  const fixtures = validateCorpusManifest(
    manifest.value,
    comparison.value,
    candidate,
    "generation-a",
    runtime,
    corpus.manifest,
  );
  const secondaryFixtures = validateCorpusManifest(
    secondaryManifest.value,
    comparison.value,
    candidate,
    "generation-b",
    runtime,
    comparison.value.manifests.generation_b,
  );
  for (const generation of [fixtures, secondaryFixtures]) {
    for (const fixture of generation) {
      const observed = (await stableFile(fixture.path, 250 << 20)).identity;
      if (observed.bytes !== fixture.bytes
        || observed.sha256 !== fixture.sha256
        || observed.mode !== 0o400
        || observed.links !== 1) {
        throw new Error(`Read-only corpus fixture changed: ${fixture.name}`);
      }
    }
  }
  if (canonicalJson(fixtures.map(row => ({
    bytes: row.bytes,
    klass: row.klass,
    name: row.name,
    note_sha256: row.note_sha256,
    sha256: row.sha256,
  }))) !== canonicalJson(secondaryFixtures.map(row => ({
    bytes: row.bytes,
    klass: row.klass,
    name: row.name,
    note_sha256: row.note_sha256,
    sha256: row.sha256,
  })))) {
    throw new Error("Independent corpus generations are not byte-reproducible");
  }
  return {
    comparison,
    fixtures,
    manifest,
    secondary_manifest: secondaryManifest,
  };
}

function expectedScannerSubstitutions(workRoot) {
  return [
    {
      label: "control-argument",
      path: path.join(workRoot, "input", "control.pdf"),
    },
    {
      label: "input-argument",
      path: path.join(workRoot, "input", "candidate.pdf"),
    },
    {
      label: "rotate-output-argument",
      path: path.join(workRoot, "outputs", "rotate", "rotated.pdf"),
    },
    {
      label: "split-output-argument",
      path: path.join(workRoot, "outputs", "split"),
    },
    {
      label: "split-output-child",
      path: path.join(
        workRoot,
        "outputs",
        "split",
        "candidate_pages_1-1.pdf",
      ),
    },
  ];
}

function validScanner(scanner, workRoot) {
  return exactKeys(scanner, [
    "allowed_path_substitutions",
    "normalized_response",
    "normalized_scanned_bytes",
    "pass",
    "protocol",
    "raw_internal_matches",
    "scanned_bytes",
    "scanned_nodes",
    "scanned_strings",
  ])
    && scanner.protocol === "pdf-tools.deep-malformed-response-leak-scan.v3"
    && integer(scanner.scanned_nodes, 1, EXPECTED_EVIDENCE_LIMITS.response_nodes)
    && integer(scanner.scanned_strings, 1, EXPECTED_EVIDENCE_LIMITS.response_nodes)
    && integer(scanner.scanned_bytes, 1, EXPECTED_EVIDENCE_LIMITS.scanner_string_bytes)
    && integer(
      scanner.normalized_scanned_bytes,
      1,
      EXPECTED_EVIDENCE_LIMITS.scanner_string_bytes,
    )
    && scanner.raw_internal_matches === 0
    && scanner.pass === true
    && exactKeys(scanner.normalized_response, [
      "canonical_bytes",
      "sha256",
    ])
    && integer(
      scanner.normalized_response.canonical_bytes,
      1,
      EXPECTED_EVIDENCE_LIMITS.response_bytes,
    )
    && SHA256.test(scanner.normalized_response.sha256)
    && Array.isArray(scanner.allowed_path_substitutions)
    && scanner.allowed_path_substitutions.length === 5
    && scanner.allowed_path_substitutions.every((row, index) =>
      exactKeys(row, ["label", "path", "uses"])
      && row.label === expectedScannerSubstitutions(workRoot)[index].label
      && row.path === expectedScannerSubstitutions(workRoot)[index].path
      && integer(row.uses, 0, 1_000_000));
}

function validResponseObservation(
  observation,
  workRoot,
  { requireSuccess = false } = {},
) {
  return exactKeys(observation, ["outcome", "response"])
    && observation.outcome === "response"
    && exactKeys(observation.response, [
      "canonical_bytes",
      "content_items",
      "is_error",
      "scanner",
      "sha256",
      "structured_error",
      "valid_call_tool_result",
    ])
    && integer(
      observation.response.canonical_bytes,
      1,
      EXPECTED_EVIDENCE_LIMITS.response_bytes,
    )
    && SHA256.test(observation.response.sha256)
    && observation.response.valid_call_tool_result === true
    && integer(observation.response.content_items, 1, 10_000)
    && validScanner(observation.response.scanner, workRoot)
    && (observation.response.structured_error === null
      || (
        exactKeys(observation.response.structured_error, [
          "code",
          "error_schema_version",
          "status",
        ])
        && observation.response.structured_error.status === "failed"
        && (
          (
            observation.response.structured_error.error_schema_version === 1
            && typeof observation.response.structured_error.code === "string"
          )
          || (
            observation.response.structured_error.error_schema_version === null
            && observation.response.structured_error.code
              === "content_extraction_failed"
          )
        )
      ))
    && (!requireSuccess || (
      observation.response.is_error === false
      && observation.response.structured_error === null
    ));
}

function validRowIdentity(value, maximumBytes, {
  expectedPath = null,
  expectedMode = null,
} = {}) {
  return exactKeys(value, [
    "bytes",
    "device",
    "inode",
    "links",
    "mode",
    "path",
    "sha256",
  ])
    && typeof value.path === "string"
    && path.resolve(value.path) === value.path
    && (expectedPath === null || value.path === expectedPath)
    && integer(value.bytes, 1, maximumBytes)
    && value.links === 1
    && integer(value.mode, 0, 0o777)
    && (expectedMode === null || value.mode === expectedMode)
    && typeof value.device === "string"
    && /^[0-9]+$/.test(value.device)
    && typeof value.inode === "string"
    && /^[0-9]+$/.test(value.inode)
    && SHA256.test(value.sha256);
}

function validInventoryEntry(entry) {
  const pathValid = typeof entry?.path === "string"
    && !path.posix.isAbsolute(entry.path)
    && entry.path.length >= 1
    && entry.path.length <= 4096
    && !entry.path.split("/").some(segment =>
      segment === "." || segment === ".." || segment === "");
  const directory = exactKeys(entry, ["kind", "mode", "path"])
    && entry.kind === "directory"
    && entry.path.endsWith("/")
    && typeof entry.path === "string"
    && !path.posix.isAbsolute(entry.path)
    && entry.path.slice(0, -1).length >= 1
    && !entry.path.slice(0, -1).split("/").some(segment =>
      segment === "." || segment === ".." || segment === "")
    && integer(entry.mode, 0, 0o777);
  const file = exactKeys(entry, [
    "bytes",
    "kind",
    "links",
    "mode",
    "path",
    "sha256",
  ])
    && entry.kind === "file"
    && pathValid
    && !entry.path.endsWith("/")
    && integer(entry.mode, 0, 0o777)
    && integer(entry.bytes, 1, EXPECTED_EVIDENCE_LIMITS.per_file_bytes)
    && entry.links === 1
    && SHA256.test(entry.sha256);
  return directory || file;
}

function validInventory(inventory) {
  if (!exactKeys(inventory, ["aggregate_bytes", "roots", "total_entries"])
    || !Array.isArray(inventory.roots)
    || inventory.roots.map(root => root.label).join("\n") !== ROOT_LABELS.join("\n")
    || inventory.roots.some(root =>
      !exactKeys(root, ["aggregate_bytes", "entries", "label", "mode"])
      || root.mode !== 0o700
      || !Array.isArray(root.entries)
      || root.entries.some(entry => !validInventoryEntry(entry))
      || root.entries.map(entry => entry.path).join("\n")
        !== [...root.entries.map(entry => entry.path)].sort().join("\n")
      || new Set(root.entries.map(entry => entry.path)).size !== root.entries.length
      || root.aggregate_bytes !== root.entries
        .filter(entry => entry.kind === "file")
        .reduce((sum, entry) => sum + entry.bytes, 0))
    || inventory.total_entries !== inventory.roots
      .reduce((sum, root) => sum + root.entries.length, 0)
    || inventory.aggregate_bytes !== inventory.roots
      .reduce((sum, root) => sum + root.aggregate_bytes, 0)
    || inventory.total_entries > EXPECTED_EVIDENCE_LIMITS.inventory_entries
    || inventory.aggregate_bytes
      > EXPECTED_EVIDENCE_LIMITS.aggregate_inventory_bytes) {
    return false;
  }
  return true;
}

async function inventoryActualWorkRoot(workRoot) {
  const roots = [
    ["input", path.join(workRoot, "input")],
    ["rotate_output", path.join(workRoot, "outputs", "rotate")],
    ["split_output", path.join(workRoot, "outputs", "split")],
    ["profiles", path.join(workRoot, "profiles")],
    ["downloads", path.join(workRoot, "downloads")],
    ["home", path.join(workRoot, "home")],
    ["tmp", path.join(workRoot, "tmp")],
  ];
  const rows = [];
  let totalEntries = 0;
  let totalBytes = 0;
  for (const [label, root] of roots) {
    await realMode0700Directory(root);
    const entries = [];
    let rootBytes = 0;
    async function visit(directory, relativeDirectory) {
      const children = await fs.readdir(directory, { withFileTypes: true });
      children.sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      for (const child of children) {
        const relativePath = path.posix.join(relativeDirectory, child.name);
        const filename = path.join(directory, child.name);
        const metadata = await fs.lstat(filename, { bigint: true });
        if (metadata.isSymbolicLink()) {
          throw new Error("Outer inventory found a symbolic link");
        }
        if (metadata.isDirectory()) {
          entries.push({
            path: `${relativePath}/`,
            kind: "directory",
            mode: Number(metadata.mode & 0o777n),
          });
          await visit(filename, relativePath);
        } else if (metadata.isFile() && metadata.nlink === 1n) {
          const identity = (await stableFile(
            filename,
            EXPECTED_EVIDENCE_LIMITS.per_file_bytes,
          )).identity;
          entries.push({
            path: relativePath,
            kind: "file",
            mode: identity.mode,
            bytes: identity.bytes,
            sha256: identity.sha256,
            links: identity.links,
          });
          rootBytes += identity.bytes;
        } else {
          throw new Error("Outer inventory found a hardlink or special entry");
        }
        if (entries.length > EXPECTED_EVIDENCE_LIMITS.inventory_entries
          || rootBytes
            > EXPECTED_EVIDENCE_LIMITS.aggregate_inventory_bytes) {
          throw new Error("Outer inventory exceeded its evidence ceiling");
        }
      }
    }
    await visit(root, "");
    entries.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    rows.push({
      label,
      mode: 0o700,
      entries,
      aggregate_bytes: rootBytes,
    });
    totalEntries += entries.length;
    totalBytes += rootBytes;
    if (totalEntries > EXPECTED_EVIDENCE_LIMITS.inventory_entries
      || totalBytes > EXPECTED_EVIDENCE_LIMITS.aggregate_inventory_bytes) {
      throw new Error("Combined outer inventory exceeded its evidence ceiling");
    }
  }
  return {
    roots: rows,
    total_entries: totalEntries,
    aggregate_bytes: totalBytes,
  };
}

function inventoryByLabel(inventory) {
  return new Map(inventory.roots.map(root => [root.label, root]));
}

function unchangedRoot(beforeByLabel, afterByLabel, label) {
  return canonicalJson(beforeByLabel.get(label))
    === canonicalJson(afterByLabel.get(label));
}

function rederiveInventoryPolicy({
  request,
  baseline,
  immediate,
  final,
  product,
}) {
  const baselineByLabel = inventoryByLabel(baseline);
  const immediateByLabel = inventoryByLabel(immediate);
  const finalByLabel = inventoryByLabel(final);
  const finalMatchesImmediate = ROOT_LABELS.every(label =>
    unchangedRoot(immediateByLabel, finalByLabel, label));
  const productSucceeded = product?.outcome === "response"
    && product.response?.is_error === false;
  const outputKind = request.tool === "rotate_pdf_pages"
    ? "rotate"
    : request.tool === "split_pdf"
      ? "split"
      : "none";
  const nonOutputLabels = ROOT_LABELS.filter(label =>
    !["rotate_output", "split_output"].includes(label));
  const nonOutputsUnchanged = nonOutputLabels.every(label =>
    unchangedRoot(baselineByLabel, immediateByLabel, label));
  const rotateEntries = immediateByLabel.get("rotate_output").entries;
  const splitEntries = immediateByLabel.get("split_output").entries;
  let expectedOutputDelta = false;
  if (!productSucceeded || outputKind === "none") {
    expectedOutputDelta = unchangedRoot(
      baselineByLabel,
      immediateByLabel,
      "rotate_output",
    ) && unchangedRoot(
      baselineByLabel,
      immediateByLabel,
      "split_output",
    );
  } else if (outputKind === "rotate") {
    expectedOutputDelta = canonicalJson(rotateEntries.map(row => ({
      path: row.path,
      kind: row.kind,
    }))) === canonicalJson([{ path: "rotated.pdf", kind: "file" }])
      && unchangedRoot(
        baselineByLabel,
        immediateByLabel,
        "split_output",
      );
  } else {
    expectedOutputDelta = canonicalJson(splitEntries.map(row => ({
      path: row.path,
      kind: row.kind,
    }))) === canonicalJson([{
      path: "candidate_pages_1-1.pdf",
      kind: "file",
    }])
      && unchangedRoot(
        baselineByLabel,
        immediateByLabel,
        "rotate_output",
      );
  }
  return {
    output_kind: outputKind,
    product_succeeded: productSucceeded,
    non_outputs_unchanged: nonOutputsUnchanged,
    expected_output_delta: expectedOutputDelta,
    final_matches_immediate: finalMatchesImmediate,
    pass: nonOutputsUnchanged && expectedOutputDelta && finalMatchesImmediate,
  };
}

function qpdfInputMatchesRowIdentity(actual, expected) {
  if (!actual || !expected) return false;
  return canonicalJson({
    path: actual.path,
    bytes: actual.bytes,
    sha256: actual.sha256,
    mode: actual.mode,
    links: actual.links,
    device: actual.device,
    inode: actual.inode,
  }) === canonicalJson({
    path: expected.path,
    bytes: expected.bytes,
    sha256: expected.sha256,
    mode: expected.mode,
    links: expected.links,
    device: expected.device,
    inode: expected.inode,
  });
}

function validQpdfObservation(value, {
  maximumStdout = EXPECTED_EVIDENCE_LIMITS.qpdf_output_bytes,
  requireText = true,
  expectedPgid = null,
  expectedParentPid = null,
  expectedLauncherSha256 = null,
  expectedInputIdentity = null,
} = {}) {
  const ready = value?.containment?.ready;
  const input = value?.containment?.input;
  const readyInput = ready?.input;
  const command = value?.command;
  const addressSpaceBaseline = ready?.address_space_baseline_bytes;
  const addressSpaceHeadroom = ready?.address_space_headroom_bytes;
  const addressSpaceLimit = Number.isSafeInteger(addressSpaceBaseline)
      && Number.isSafeInteger(addressSpaceHeadroom)
    ? addressSpaceBaseline + addressSpaceHeadroom
    : null;
  const expectedLimits = {
    address_space: {
      current: addressSpaceLimit,
      maximum: addressSpaceLimit,
    },
    file_size: {
      current: QPDF_ORACLE_POLICY.file_size_bytes,
      maximum: QPDF_ORACLE_POLICY.file_size_bytes,
    },
    cpu: {
      current: QPDF_ORACLE_POLICY.cpu_soft_seconds,
      maximum: QPDF_ORACLE_POLICY.cpu_hard_seconds,
    },
    nofile: {
      current: QPDF_ORACLE_POLICY.nofile,
      maximum: QPDF_ORACLE_POLICY.nofile,
    },
    core: { current: 0, maximum: 0 },
  };
  const stdoutKeys = requireText
    ? ["bytes", "sha256", "text"]
    : ["bytes", "sha256"];
  return exactKeys(value, [
    "claim_boundary",
    "classification",
    "command",
    "containment",
    "pass",
    "policy",
    "protocol",
  ])
    && value.protocol === QPDF_BUDGET_COMMAND_PROTOCOL
    && value.claim_boundary === QPDF_BUDGET_COMMAND_CLAIM_BOUNDARY
    && value.classification === "passed"
    && value.pass === true
    && canonicalJson(value.policy) === canonicalJson(QPDF_ORACLE_POLICY)
    && exactKeys(value.containment, [
      "budget_enforced",
      "control_error_sha256",
      "error",
      "control_eof_after_ready",
      "executables_stable",
      "expected_parent_pid",
      "expected_pgid",
      "input",
      "input_error_sha256",
      "input_stable",
      "launcher_sha256",
      "ready",
      "same_process_group",
      "same_session",
      "spawned_pid",
    ])
    && value.containment.budget_enforced === true
    && value.containment.control_eof_after_ready === true
    && value.containment.executables_stable === true
    && value.containment.input_stable === true
    && value.containment.input_error_sha256 === null
    && value.containment.same_process_group === true
    && value.containment.same_session === true
    && integer(
      value.containment.expected_parent_pid,
      2,
      2147483647,
    )
    && integer(value.containment.expected_pgid, 2, 2147483647)
    && (expectedPgid === null
      || value.containment.expected_pgid === expectedPgid)
    && (expectedParentPid === null
      || value.containment.expected_parent_pid === expectedParentPid)
    && value.containment.error === null
    && value.containment.control_error_sha256 === null
    && SHA256.test(value.containment.launcher_sha256)
    && (expectedLauncherSha256 === null
      || value.containment.launcher_sha256 === expectedLauncherSha256)
    && exactKeys(ready, [
      "address_space_baseline_bytes",
      "address_space_headroom_bytes",
      "address_space_observed_bytes",
      "error_number",
      "input",
      "limits",
      "pgid",
      "pid",
      "sequence",
      "sid",
      "stage",
      "type",
    ])
    && ready.type === 1 && ready.sequence === 0
    && ready.stage === 10
    && ready.error_number === 0
    && ready.pid === value.containment.spawned_pid
    && ready.pgid === value.containment.expected_pgid
    && integer(ready.sid, 1, 2147483647)
    && exactKeys(input, [
      "bytes",
      "device",
      "group",
      "inode",
      "links",
      "mode",
      "owner",
      "path",
      "sha256",
    ])
    && typeof input.path === "string"
    && path.resolve(input.path) === input.path
    && integer(input.bytes, 1, 250 << 20)
    && /^[1-9][0-9]*$/.test(input.device)
    && /^[1-9][0-9]*$/.test(input.inode)
    && input.links === 1
    && integer(input.mode, 0, 0o777)
    && integer(input.owner, 0, 0xffffffff)
    && integer(input.group, 0, 0xffffffff)
    && SHA256.test(input.sha256)
    && (expectedInputIdentity === null
      || qpdfInputMatchesRowIdentity(input, expectedInputIdentity))
    && exactKeys(readyInput, [
      "bytes", "device", "group", "inode", "links", "mode", "owner",
    ])
    && canonicalJson(readyInput) === canonicalJson({
      device: input.device,
      inode: input.inode,
      bytes: input.bytes,
      mode: input.mode,
      links: input.links,
      owner: input.owner,
      group: input.group,
    })
    && integer(
      ready.address_space_baseline_bytes,
      1,
      Number.MAX_SAFE_INTEGER,
    )
    && ready.address_space_headroom_bytes
      === QPDF_ORACLE_POLICY.address_space_headroom_bytes
    && integer(
      ready.address_space_observed_bytes,
      1,
      Number.MAX_SAFE_INTEGER,
    )
    && Number.isSafeInteger(addressSpaceLimit)
    && ready.address_space_observed_bytes <= addressSpaceLimit
    && canonicalJson(ready.limits) === canonicalJson(expectedLimits)
    && exactKeys(command, [
      "code", "outcome", "output_overflow", "signal", "stderr", "stdout",
      "timed_out",
    ])
    && command.outcome === "close" && command.code === 0
    && command.signal === null && command.timed_out === false
    && command.output_overflow === false
    && exactKeys(command.stdout, stdoutKeys)
    && integer(command.stdout.bytes, 0, maximumStdout)
    && SHA256.test(command.stdout.sha256)
    && (!requireText
      || (typeof command.stdout.text === "string"
        && Buffer.byteLength(command.stdout.text) === command.stdout.bytes
        && command.stdout.sha256
          === sha256(Buffer.from(command.stdout.text, "utf8"))))
    && exactKeys(command.stderr, ["bytes", "sha256"])
    && command.stderr.bytes === 0
    && command.stderr.sha256 === sha256(Buffer.alloc(0));
}

function validSemanticFingerprint(
  value,
  expectedContainment,
  expectedLauncherSha256,
  expectedInputIdentity,
) {
  const fields = [
    "trailer.value./ID",
    "trailer.value./Info.value./CreationDate",
    "trailer.value./Info.value./ModDate",
  ];
  if (!exactKeys(value, [
    "canonicalization",
    "command",
    "normalization",
    "normalized",
    "pass",
    "protocol",
  ])
    || value.protocol
      !== "pdf-tools.qpdf-semantic-object-graph-fingerprint.v1"
    || value.pass !== true
    || !exactKeys(value.canonicalization, [
      "command",
      "output",
      "pass",
      "protocol",
    ])
    || value.canonicalization.protocol
      !== "pdf-tools.qpdf-object-stream-disabled-projection.v1"
    || value.canonicalization.pass !== true
    || !validQpdfObservation(value.canonicalization.command, {
      requireText: false,
      expectedPgid: expectedContainment?.pgid,
      expectedParentPid: expectedContainment?.pid,
      expectedLauncherSha256,
      expectedInputIdentity,
    })
    || value.canonicalization.command.command.stdout.bytes !== 0
    || !exactKeys(value.canonicalization.output, [
      "bytes",
      "device",
      "inode",
      "links",
      "mode",
      "path",
      "sha256",
    ])
    || !integer(
      value.canonicalization.output.bytes,
      1,
      EXPECTED_EVIDENCE_LIMITS.per_file_bytes,
    )
    || value.canonicalization.output.mode !== 0o600
    || value.canonicalization.output.links !== 1
    || typeof value.canonicalization.output.path !== "string"
    || path.resolve(value.canonicalization.output.path)
      !== value.canonicalization.output.path
    || path.basename(value.canonicalization.output.path) !== "projection.pdf"
    || path.dirname(path.dirname(value.canonicalization.output.path))
      !== path.dirname(expectedInputIdentity?.path ?? "")
    || !path.basename(path.dirname(value.canonicalization.output.path))
      .startsWith(".qpdf-semantic-projection-")
    || !/^[1-9][0-9]*$/.test(value.canonicalization.output.device)
    || !/^[1-9][0-9]*$/.test(value.canonicalization.output.inode)
    || !SHA256.test(value.canonicalization.output.sha256)
    || !validQpdfObservation(value.command, {
      maximumStdout: EXPECTED_EVIDENCE_LIMITS.semantic_fingerprint_bytes,
      requireText: false,
      expectedPgid: expectedContainment?.pgid,
      expectedParentPid: expectedContainment?.pid,
      expectedLauncherSha256,
      expectedInputIdentity: value.canonicalization.output,
    })
    || !integer(
      value.command.command.stdout.bytes,
      1,
      EXPECTED_EVIDENCE_LIMITS.semantic_fingerprint_bytes,
    )
    || !exactKeys(value.normalization, [
      "clock_tolerance_ms",
      "excluded_fields",
      "excluded_occurrences",
      "excluded_value_classes",
      "observed_nodes",
      "retained_nonvolatile_occurrences",
    ])
    || value.normalization.clock_tolerance_ms !== 600_000
    || canonicalJson(value.normalization.excluded_fields)
      !== canonicalJson(fields)
    || !exactKeys(value.normalization.excluded_occurrences, fields)
    || !exactKeys(value.normalization.excluded_value_classes, fields)
    || !exactKeys(
      value.normalization.retained_nonvolatile_occurrences,
      fields,
    )
    || !integer(value.normalization.observed_nodes, 1, 1_000_000)
    || !exactKeys(value.normalized, ["canonical_bytes", "sha256"])
    || !integer(
      value.normalized.canonical_bytes,
      1,
      EXPECTED_EVIDENCE_LIMITS.semantic_fingerprint_bytes,
    )
    || !SHA256.test(value.normalized.sha256)) {
    return false;
  }
  const excluded = value.normalization.excluded_occurrences;
  const retained = value.normalization.retained_nonvolatile_occurrences;
  const classes = value.normalization.excluded_value_classes;
  if (excluded["trailer.value./ID"] !== 1
    || retained["trailer.value./ID"] !== 0
    || classes["trailer.value./ID"]
      !== "binary-id-array:2x128-bit") {
    return false;
  }
  for (const field of fields.slice(1)) {
    if (!integer(excluded[field], 0, 1)
      || !integer(retained[field], 0, 1)
      || excluded[field] + retained[field] > 1
      || (excluded[field] === 1
        ? classes[field]
          !== "unicode-pdf-date:utc-second:near-fingerprint"
        : classes[field] !== null)) {
      return false;
    }
  }
  return true;
}

function validateRowRecord(
  record,
  request,
  matrixRow,
  workRoot,
  outerFinalInventory,
  outerQpdfStable,
) {
  const topLevelValid = exactKeys(record, [
    "baseline_canary",
    "baseline_inventory",
    "baseline_pdfjs_canary",
    "execution",
    "final_inventory",
    "fixture",
    "identity_observations",
    "immediate_inventory",
    "inventory_policy",
    "output_validation",
    "product",
    "protocol",
    "request",
    "same_server_canary",
    "same_server_pdfjs_canary",
  ]);
  const fixtureValid = exactKeys(record?.fixture, ["control", "input", "source"])
    && validRowIdentity(
      record.fixture.source,
      EXPECTED_EVIDENCE_LIMITS.per_file_bytes,
      { expectedPath: request.fixture.path, expectedMode: 0o400 },
    )
    && validRowIdentity(
      record.fixture.input,
      EXPECTED_EVIDENCE_LIMITS.per_file_bytes,
      {
        expectedPath: path.join(workRoot, "input", "candidate.pdf"),
        expectedMode: 0o400,
      },
    )
    && validRowIdentity(
      record.fixture.control,
      EXPECTED_EVIDENCE_LIMITS.per_file_bytes,
      {
        expectedPath: path.join(workRoot, "input", "control.pdf"),
        expectedMode: 0o400,
      },
    )
    && record.fixture.source.bytes === request.fixture.bytes
    && record?.fixture?.source?.sha256 === request.fixture.sha256
    && record?.fixture?.input?.bytes === request.fixture.bytes
    && record?.fixture?.input?.sha256 === request.fixture.sha256
    && record.fixture.control.bytes === CONTROL_PDF_BYTES
    && record.fixture.control.sha256 === CONTROL_PDF_SHA256
    && DEEP_FIXTURE_CATALOG.find(entry =>
      entry.name === request.fixture.name)?.klass === request.fixture.klass
    && (
      record.fixture.input.device !== record.fixture.source.device
      || record.fixture.input.inode !== record.fixture.source.inode
    );
  const serverValid = exactKeys(record?.execution, [
    "inherited_containment",
    "post_server",
    "product_elapsed_ns",
    "runner_pid",
    "server",
    "server_closed_unexpectedly",
    "total_elapsed_ns",
  ])
    && exactKeys(
      record?.execution?.inherited_containment,
      ["pgid", "pid"],
    )
    && exactKeys(record?.execution?.server, ["pid", "sha256", "value"])
    && exactKeys(record?.execution?.post_server, ["pid", "sha256", "value"])
    && integer(record?.execution?.runner_pid, 1, Number.MAX_SAFE_INTEGER)
    && record.execution.inherited_containment.pid
      === record.execution.runner_pid
    && record.execution.inherited_containment.pgid
      === record.execution.runner_pid
    && integer(record?.execution?.server?.pid, 1, Number.MAX_SAFE_INTEGER)
    && typeof record?.execution?.server?.value === "string"
    && record.execution.server.value.length >= 1
    && record.execution.server.value.length <= 200
    && SHA256.test(record?.execution?.server?.sha256 ?? "")
    && record.execution.server.sha256
      === sha256(Buffer.from(record.execution.server.value, "utf8"))
    && canonicalJson(record.execution.post_server)
      === canonicalJson(record.execution.server)
    && record?.execution?.server_closed_unexpectedly === false
    && integer(record?.execution?.product_elapsed_ns, 0, 120_000_000_000)
    && integer(record?.execution?.total_elapsed_ns, 0, 180_000_000_000);
  const identityObservationsValid = exactKeys(
    record?.identity_observations,
    ["baseline", "final", "unchanged"],
  )
    && exactKeys(
      record.identity_observations.baseline,
      ["control", "input", "source"],
    )
    && exactKeys(
      record.identity_observations.final,
      ["control", "input", "source"],
    )
    && canonicalJson(record.identity_observations.baseline)
      === canonicalJson(record.fixture)
    && canonicalJson(record.identity_observations.final)
      === canonicalJson(record.identity_observations.baseline)
    && record.identity_observations.unchanged === true;
  const baselineValid = validResponseObservation(
    record?.baseline_canary,
    workRoot,
    { requireSuccess: true },
  );
  const postValid = validResponseObservation(
    record?.same_server_canary,
    workRoot,
    { requireSuccess: true },
  );
  const pdfjsExpected = PDFJS_CANARY_TOOLS.has(matrixRow.tool);
  const pdfjsValid = pdfjsExpected
      ? validResponseObservation(
        record?.baseline_pdfjs_canary,
        workRoot,
        { requireSuccess: true },
      ) && validResponseObservation(
        record?.same_server_pdfjs_canary,
        workRoot,
        { requireSuccess: true },
      )
    : record?.baseline_pdfjs_canary === null
      && record?.same_server_pdfjs_canary === null;
  const productValid = validResponseObservation(record?.product, workRoot);
  const standardProductError =
    record?.product?.response?.structured_error?.status === "failed"
    && record.product.response.structured_error.error_schema_version === 1
    && [
      "PDF_RESOURCE_LIMIT_EXCEEDED",
      "tool_execution_failed",
    ].includes(record.product.response.structured_error.code);
  const contentExtractionError =
    matrixRow.tool === "read_pdf_content"
    && record?.product?.response?.structured_error?.status === "failed"
    && record.product.response.structured_error.error_schema_version === null
    && record.product.response.structured_error.code
      === "content_extraction_failed";
  const productErrorContract = record?.product?.response?.is_error === false
    ? record.product.response.structured_error === null
    : record?.product?.response?.is_error === true
      && (standardProductError || contentExtractionError);
  const rederivedPolicy = validInventory(record?.baseline_inventory)
    && validInventory(record?.immediate_inventory)
    && validInventory(record?.final_inventory)
    ? rederiveInventoryPolicy({
        request,
        baseline: record.baseline_inventory,
        immediate: record.immediate_inventory,
        final: record.final_inventory,
        product: record.product,
      })
    : null;
  const inventoriesValid = validInventory(record?.baseline_inventory)
    && validInventory(record?.immediate_inventory)
    && validInventory(record?.final_inventory)
    && canonicalJson(record?.inventory_policy) === canonicalJson(rederivedPolicy)
    && rederivedPolicy.pass === true;
  const mutatorSuccess = MUTATOR_TOOLS.has(matrixRow.tool)
    && record?.product?.response?.is_error === false;
  const expectedOutputPath = matrixRow.tool === "rotate_pdf_pages"
    ? path.join(workRoot, "outputs", "rotate", "rotated.pdf")
    : path.join(workRoot, "outputs", "split", "candidate_pages_1-1.pdf");
  const outputRecord = record?.output_validation?.outputs?.[0];
  const outputLabel = matrixRow.tool === "rotate_pdf_pages"
    ? "rotate_output"
    : "split_output";
  const expectedOutputEntry = outputRecord?.identity === undefined
    ? null
    : {
        path: path.basename(expectedOutputPath),
        kind: "file",
        mode: outputRecord.identity.mode,
        bytes: outputRecord.identity.bytes,
        sha256: outputRecord.identity.sha256,
        links: outputRecord.identity.links,
      };
  const immediateOutputEntries = validInventory(record?.immediate_inventory)
    ? inventoryByLabel(record.immediate_inventory).get(outputLabel).entries
    : null;
  const finalOutputEntries = validInventory(record?.final_inventory)
    ? inventoryByLabel(record.final_inventory).get(outputLabel).entries
    : null;
  const outputValid = exactKeys(
    record?.output_validation,
    ["outputs", "pass", "required"],
  )
    && Array.isArray(record.output_validation.outputs)
    && record?.output_validation?.pass === true
    && (mutatorSuccess
      ? record.output_validation.required === true
        && record.output_validation.outputs?.length === 1
        && exactKeys(outputRecord, [
          "identity",
          "nonalias",
          "qpdf_check",
          "qpdf_pages",
          "qpdf_stable",
          "semantic",
          "semantic_fingerprint",
        ])
        && validRowIdentity(
          outputRecord.identity,
          EXPECTED_EVIDENCE_LIMITS.per_file_bytes,
          { expectedPath: expectedOutputPath, expectedMode: 0o600 },
        )
        && outputRecord.nonalias === true
        && (
          outputRecord.identity.device !== record.fixture.input.device
          || outputRecord.identity.inode !== record.fixture.input.inode
        )
        && canonicalJson(immediateOutputEntries)
          === canonicalJson([expectedOutputEntry])
        && canonicalJson(finalOutputEntries)
          === canonicalJson([expectedOutputEntry])
        && outputRecord.qpdf_stable === true
        && validSemanticFingerprint(
          outputRecord.semantic_fingerprint,
          record.execution.inherited_containment,
          request.qpdf_budget_exec.binary.sha256,
          outputRecord.identity,
        )
        && validQpdfObservation(
          outputRecord.qpdf_check,
          {
            expectedPgid: record.execution.inherited_containment.pgid,
            expectedParentPid:
              record.execution.inherited_containment.pid,
            expectedLauncherSha256:
              request.qpdf_budget_exec.binary.sha256,
            expectedInputIdentity: outputRecord.identity,
          },
        )
        && validQpdfObservation(
          outputRecord.qpdf_pages,
          {
            expectedPgid: record.execution.inherited_containment.pgid,
            expectedParentPid:
              record.execution.inherited_containment.pid,
            expectedLauncherSha256:
              request.qpdf_budget_exec.binary.sha256,
            expectedInputIdentity: outputRecord.identity,
          },
        )
        && exactKeys(outputRecord.semantic, [
          "finite_geometry",
          "first_page_rotation",
          "loadable",
          "pages",
        ])
        && outputRecord.semantic.loadable === true
        && outputRecord.semantic.pages === 1
        && outputRecord.semantic.finite_geometry === true
        && (matrixRow.tool !== "rotate_pdf_pages"
          || outputRecord.semantic.first_page_rotation === 90)
      : record?.output_validation?.required === false
        && record?.output_validation?.outputs?.length === 0);
  return {
    top_level_schema: topLevelValid,
    protocol: record?.protocol === ROW_RESULT_PROTOCOL,
    request: canonicalJson(record?.request) === canonicalJson(request),
    fixture: fixtureValid,
    input_identity_unchanged: identityObservationsValid,
    server_identity: serverValid,
    baseline_canary: baselineValid,
    pdfjs_canaries: pdfjsValid,
    product_response: productValid,
    product_error_contract: productErrorContract,
    post_canary: postValid,
    inventories: inventoriesValid,
    outer_final_inventory: validInventory(outerFinalInventory)
      && canonicalJson(outerFinalInventory)
        === canonicalJson(record?.final_inventory),
    outer_qpdf_stable: outerQpdfStable === true,
    output: outputValid,
    matrix_binding: request.fixture.name === matrixRow.fixture
      && request.tool === matrixRow.tool,
  };
}

function allAssertionsPass(assertions) {
  return Object.values(assertions).every(value => value === true);
}

function expectedSupervisorOptions(plan) {
  return {
    deadlineMs: plan.native_limits.deadline_ms,
    leaderExitGraceMs: plan.native_limits.leader_exit_grace_ms,
    sampleIntervalMs: plan.native_limits.sample_interval_ms,
    stdoutMaxBytes: plan.native_limits.stdout_max_bytes,
    stderrMaxBytes: plan.native_limits.stderr_max_bytes,
    physicalFootprintMaxBytes:
      plan.native_limits.physical_footprint_max_bytes,
    addressSpaceBytes: plan.native_limits.address_space_bytes,
    cpuSeconds: plan.native_limits.cpu_seconds,
    fileSizeBytes: plan.native_limits.file_size_bytes,
    nofile: plan.native_limits.nofile,
  };
}

function validateCampaignSupervisorEvidence(evidence, lease, plan) {
  try {
    validateSupervisorLease(lease);
    validateSupervisorEvidence(
      evidence,
      lease,
      expectedSupervisorOptions(plan),
    );
  } catch {
    return false;
  }
  return evidence.controller_accepted === true
    && evidence.controller_failure === "none"
    && evidence.observations.original_process_group_empty === true
    && evidence.observations.escaped_session_detected === false
    && integer(evidence.observations.max_group_members, 2, 16)
    && integer(evidence.observations.observed_process_identity_count, 2, 64);
}

async function main() {
  if (process.platform !== "darwin"
    || process.argv.length !== 3
    || path.resolve(process.argv[2]) !== process.argv[2]) {
    throw new Error("Usage: deep-malformed-macos-campaign-v3.js /canonical/plan.json");
  }
  const planObserved = await canonicalJsonFile(process.argv[2], MAX_PLAN_BYTES);
  const plan = Object.freeze(planObserved.value);
  validatePlan(plan);
  if (path.dirname(plan.attempt_root)
      !== path.dirname(planObserved.identity.path)) {
    throw new Error("Campaign attempt root must be a direct plan sibling");
  }
  const invokedNode = await fs.realpath(process.execPath);
  if (invokedNode !== plan.runtime.node.executable.path
    || process.version !== plan.runtime.node.version) {
    throw new Error("Campaign controller Node runtime differs from the plan");
  }
  await verifyIdentity(plan.runtime.node.executable, 256 << 20);
  await realMode0700Directory(path.dirname(plan.attempt_root));
  await fs.lstat(plan.attempt_root).then(
    () => { throw new Error("Campaign attempt root already exists"); },
    error => {
      if (error?.code !== "ENOENT") throw error;
    },
  );
  await verifyCandidate(plan.candidate);
  await verifySupervisor(plan.supervisor, plan.candidate);
  await verifyQpdfBudgetExec(plan.qpdf_budget_exec, plan.candidate);
  const corpus = await verifyCorpus(
    plan.corpus,
    plan.candidate,
    plan.runtime,
  );
  const qpdfObserved = (await stableFile(plan.qpdf.path, 64 << 20)).identity;
  if (qpdfObserved.bytes !== plan.qpdf.bytes
    || qpdfObserved.sha256 !== plan.qpdf.sha256
    || qpdfObserved.mode !== plan.qpdf.mode
    || qpdfObserved.links !== plan.qpdf.links
    || commandOutput(plan.qpdf.path, ["--version"]) !== plan.qpdf.version) {
    throw new Error("qpdf identity or version changed");
  }
  const nodeExecutable = invokedNode;
  await fs.mkdir(plan.attempt_root, { mode: 0o700 });
  const rows = [];
  for (let index = 0; index < plan.matrix.length; index += 1) {
    const matrixRow = plan.matrix[index];
    const fixture = corpus.fixtures.find(row => row.name === matrixRow.fixture);
    if (!fixture) throw new Error(`Matrix fixture missing from corpus: ${matrixRow.fixture}`);
    const rowRoot = path.join(
      plan.attempt_root,
      `row-${String(index + 1).padStart(4, "0")}`,
    );
    const workRoot = path.join(rowRoot, "work");
    const runnerHome = path.join(rowRoot, "runner-home");
    const runnerTmp = path.join(rowRoot, "runner-tmp");
    await fs.mkdir(rowRoot, { mode: 0o700 });
    await fs.mkdir(workRoot, { mode: 0o700 });
    await fs.mkdir(runnerHome, { mode: 0o700 });
    await fs.mkdir(runnerTmp, { mode: 0o700 });
    const {
      campaign_result_bytes: _campaignResultBytes,
      ...rowEvidenceLimits
    } = plan.evidence_limits;
    const request = {
      protocol: ROW_REQUEST_PROTOCOL,
      fixture,
      tool: matrixRow.tool,
      call_timeout_ms: plan.timeouts.product_ms,
      canary_timeout_ms: plan.timeouts.canary_ms,
      evidence_limits: rowEvidenceLimits,
      qpdf: plan.qpdf,
      qpdf_budget_exec: {
        binary: plan.qpdf_budget_exec.binary,
        policy: plan.qpdf_budget_exec.policy,
      },
    };
    const result = await runSupervisedCandidate({
      binaryPath: plan.supervisor.binary.path,
      expectedBinary: plan.supervisor.binary,
      cwd: rowRoot,
      command: [nodeExecutable, plan.candidate.runner.path],
      stdin: Buffer.from(canonicalJson(request), "utf8"),
      environment: {
        HOME: runnerHome,
        TMPDIR: runnerTmp,
        LANG: "C",
        LC_ALL: "C",
        PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        PDF_TOOLS_CAMPAIGN_WORK_ROOT: workRoot,
        PDF_TOOLS_CORPUS_INPUT_ROOT: path.dirname(fixture.path),
      },
      deadlineMs: plan.native_limits.deadline_ms,
      leaderExitGraceMs: plan.native_limits.leader_exit_grace_ms,
      sampleIntervalMs: plan.native_limits.sample_interval_ms,
      stdoutMaxBytes: plan.native_limits.stdout_max_bytes,
      stderrMaxBytes: plan.native_limits.stderr_max_bytes,
      physicalFootprintMaxBytes:
        plan.native_limits.physical_footprint_max_bytes,
      addressSpaceBytes: plan.native_limits.address_space_bytes,
      cpuSeconds: plan.native_limits.cpu_seconds,
      fileSizeBytes: plan.native_limits.file_size_bytes,
      nofile: plan.native_limits.nofile,
    });
    let record = null;
    let parseError = null;
    if (result.evidence.controller_accepted) {
      try {
        record = parseCanonicalCandidateJson(
          result.stdout,
          plan.evidence_limits.row_result_bytes,
        );
      } catch (error) {
        parseError = {
          message_sha256: sha256(Buffer.from(String(error?.message ?? error), "utf8")),
        };
      }
    }
    let outerFinalInventory = null;
    let outerInventoryError = null;
    try {
      outerFinalInventory = await inventoryActualWorkRoot(workRoot);
    } catch (error) {
      outerInventoryError = {
        message_sha256: sha256(
          Buffer.from(String(error?.message ?? error), "utf8"),
        ),
      };
    }
    const outerInventorySerialized = outerFinalInventory === null
      ? null
      : Buffer.from(canonicalJson(outerFinalInventory), "utf8");
    let outerQpdfStable = false;
    try {
      const observedQpdf = (await stableFile(
        plan.qpdf.path,
        64 << 20,
      )).identity;
      outerQpdfStable = observedQpdf.bytes === plan.qpdf.bytes
        && observedQpdf.sha256 === plan.qpdf.sha256
        && observedQpdf.mode === plan.qpdf.mode
        && observedQpdf.links === plan.qpdf.links;
    } catch {
      outerQpdfStable = false;
    }
    const assertions = record === null
      ? null
        : validateRowRecord(
          record,
          request,
          matrixRow,
          workRoot,
          outerFinalInventory,
          outerQpdfStable,
        );
    const supervisorEvidenceValid =
      validateCampaignSupervisorEvidence(
        result.evidence,
        result.lease,
        plan,
      )
      && result.evidence.capture.stdout_retained_bytes
        === result.stdout.length
      && result.exit?.code === 0
      && result.exit?.signal === null
      && result.supervisor_stderr.length === 0;
    const qualificationPass = supervisorEvidenceValid
      && assertions !== null
      && allAssertionsPass(assertions);
    rows.push({
      ordinal: index + 1,
      matrix: matrixRow,
      request,
      supervisor_evidence: result.evidence,
      supervisor_lease: result.lease,
      supervisor_exit: result.exit,
      candidate_stdout: {
        bytes: result.stdout.length,
        sha256: sha256(result.stdout),
        parse_error: parseError,
        record,
      },
      supervisor_stderr: {
        bytes: result.supervisor_stderr.length,
        sha256: sha256(result.supervisor_stderr),
      },
      outer_final_inventory: {
        canonical_bytes: outerInventorySerialized?.length ?? null,
        sha256: outerInventorySerialized === null
          ? null
          : sha256(outerInventorySerialized),
        error: outerInventoryError,
      },
      assertions,
      supervisor_evidence_valid: supervisorEvidenceValid,
      product_boundary_owned: result.evidence?.controller_accepted === true
        && result.evidence?.controller_failure === "none",
      qualification_pass: qualificationPass,
    });
  }
  const result = {
    protocol: RESULT_PROTOCOL,
    plan: {
      identity: planObserved.identity,
      value: plan,
    },
    environment: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      architecture: os.arch(),
      node: {
        version: plan.runtime.node.version,
        executable: plan.runtime.node.executable,
      },
    },
    candidate: plan.candidate,
    supervisor: plan.supervisor,
    qpdf_budget_exec: plan.qpdf_budget_exec,
    corpus: {
      comparison: corpus.comparison.identity,
      manifest: corpus.manifest.identity,
      provision_controller: plan.corpus.provision_controller,
      provisioner: plan.corpus.provisioner,
      logical_fixture_digest: plan.corpus.logical_fixture_digest,
    },
    rows,
    summary: {
      planned_rows: 78,
      observed_rows: rows.length,
      supervisor_evidence_valid_rows:
        rows.filter(row => row.supervisor_evidence_valid).length,
      product_boundary_owned_rows:
        rows.filter(row => row.product_boundary_owned).length,
      qualification_pass_rows:
        rows.filter(row => row.qualification_pass).length,
      qualification_failed_rows:
        rows.filter(row => !row.qualification_pass).length,
      matrix_complete:
        canonicalJson(rows.map(row => row.matrix)) === canonicalJson(expectedMatrix()),
      status: rows.length === 78
        && rows.every(row => row.qualification_pass)
        ? "pass"
        : "fail",
    },
  };
  const receiptPath = path.join(plan.attempt_root, "receipt.json");
  const receipt = await writeCanonicalJson(
    receiptPath,
    result,
    plan.evidence_limits.campaign_result_bytes,
  );
  process.stdout.write(`${canonicalJson({
    protocol: "pdf-tools.deep-malformed-macos-campaign-receipt-written.v3",
    receipt,
    summary: result.summary,
  })}\n`);
  if (result.summary.status !== "pass") process.exitCode = 1;
}

export const campaignV3Internals = Object.freeze({
  expectedMatrix,
  expectedSupervisorOptions,
  rederiveInventoryPolicy,
  validateCampaignSupervisorEvidence,
  validateCorpusComparison,
  validateCorpusManifest,
  validatePlan,
  validateRowRecord,
  validQpdfObservation,
  validInventory,
  verifyCandidate,
  verifyCorpus,
  verifySupervisor,
  verifyQpdfBudgetExec,
});

if (process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`Campaign controller failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
