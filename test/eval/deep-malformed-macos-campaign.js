#!/usr/bin/env node

/**
 * Native-supervised macOS controller for bead pdf-toolkit-mcp-33l.
 *
 * The plan and result are canonical JSON. Every repetition gets a fresh
 * mode-0700 attempt directory, fresh row-runner process group, and fresh MCP
 * server. A returned supervisor rejection is a contained product-row failure;
 * it is never relabeled as a passing fail-closed result.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  canonicalJson,
  parseCanonicalCandidateJson,
  runSupervisedCandidate,
} from "./docling-macos-supervisor.js";

const PLAN_PROTOCOL = "pdf-tools.deep-malformed-macos-campaign-plan.v1";
const RESULT_PROTOCOL = "pdf-tools.deep-malformed-macos-campaign-result.v1";
const ROW_REQUEST_PROTOCOL = "pdf-tools.deep-malformed-row-request.v1";
const ROW_RESULT_PROTOCOL = "pdf-tools.deep-malformed-row-result.v1";
const MAX_PLAN_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

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

async function stableRegularFile(filename, maximumBytes) {
  if (path.resolve(filename) !== filename) throw new Error("File path must be canonical and absolute");
  await noLinkAncestors(filename);
  const before = await fs.lstat(filename, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size < 1n || before.size > BigInt(maximumBytes)) {
    throw new Error(`File violates its stable regular-file contract: ${filename}`);
  }
  const handle = await fs.open(filename, "r");
  let bytes;
  try {
    const descriptor = await handle.stat({ bigint: true });
    if (descriptor.dev !== before.dev || descriptor.ino !== before.ino
      || descriptor.size !== before.size || descriptor.mode !== before.mode
      || descriptor.nlink !== before.nlink) {
      throw new Error(`File changed before read: ${filename}`);
    }
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathnameAfter = await fs.lstat(filename, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mode !== before.mode
      || after.nlink !== before.nlink
      || pathnameAfter.dev !== before.dev || pathnameAfter.ino !== before.ino
      || pathnameAfter.size !== before.size || pathnameAfter.mode !== before.mode
      || pathnameAfter.nlink !== before.nlink || bytes.length !== Number(before.size)) {
      throw new Error(`File changed during read: ${filename}`);
    }
  } finally {
    await handle.close();
  }
  if (await fs.realpath(filename) !== filename) throw new Error(`File is not canonical: ${filename}`);
  return {
    contents: bytes,
    identity: {
      path: filename,
      bytes: bytes.length,
      sha256: sha256(bytes),
      mode: Number(before.mode & 0o777n),
      links: Number(before.nlink),
    },
  };
}

function validateRequest(request) {
  return exactKeys(request, [
    "call_timeout_ms",
    "expanded_bytes",
    "fixture",
    "protocol",
    "tool",
  ])
    && request.protocol === ROW_REQUEST_PROTOCOL
    && request.fixture === "contiguous-b"
    && ["get_pdf_info", "read_pdf_content", "get_page_analysis", "render_pdf_page"]
      .includes(request.tool)
    && integer(request.expanded_bytes, 1024, 16 << 20)
    && integer(request.call_timeout_ms, 1000, 60_000);
}

function validateLimits(limits) {
  return exactKeys(limits, [
    "address_space_bytes",
    "cpu_seconds",
    "deadline_ms",
    "file_size_bytes",
    "leader_exit_grace_ms",
    "nofile",
    "physical_footprint_max_bytes",
    "sample_interval_ms",
    "stderr_max_bytes",
    "stdout_max_bytes",
  ])
    && integer(limits.deadline_ms, 1, 600_000)
    && integer(limits.leader_exit_grace_ms, 0, 5000)
    && integer(limits.sample_interval_ms, 1, 1000)
    && integer(limits.stdout_max_bytes, 1, 16_777_216)
    && integer(limits.stderr_max_bytes, 1, 16_777_216)
    && integer(limits.physical_footprint_max_bytes, 16_777_216, 549_755_813_888)
    && integer(limits.address_space_bytes, 1_073_741_824, 1_099_511_627_776)
    && integer(limits.cpu_seconds, 1, 3600)
    && integer(limits.file_size_bytes, 1_048_576, 1_073_741_824)
    && integer(limits.nofile, 32, 4096);
}

function validatePlan(plan) {
  if (!exactKeys(plan, [
    "attempt_root",
    "candidate",
    "limits",
    "protocol",
    "rows",
    "supervisor",
  ])
    || plan.protocol !== PLAN_PROTOCOL
    || typeof plan.attempt_root !== "string"
    || path.resolve(plan.attempt_root) !== plan.attempt_root
    || !exactKeys(plan.candidate, ["head", "path", "runner_sha256", "tree"])
    || typeof plan.candidate.path !== "string"
    || path.resolve(plan.candidate.path) !== plan.candidate.path
    || !/^[a-f0-9]{40}$/.test(plan.candidate.head)
    || !/^[a-f0-9]{40}$/.test(plan.candidate.tree)
    || !SHA256.test(plan.candidate.runner_sha256)
    || !exactKeys(plan.supervisor, ["bytes", "links", "mode", "path", "sha256"])
    || typeof plan.supervisor.path !== "string"
    || path.resolve(plan.supervisor.path) !== plan.supervisor.path
    || !integer(plan.supervisor.bytes, 1, 4 << 20)
    || ![0o700, 0o755].includes(plan.supervisor.mode)
    || plan.supervisor.links !== 1
    || !SHA256.test(plan.supervisor.sha256)
    || !validateLimits(plan.limits)
    || !Array.isArray(plan.rows)
    || plan.rows.length < 1
    || plan.rows.length > 100
    || plan.rows.some(row => !exactKeys(row, ["repetitions", "request"])
      || !integer(row.repetitions, 1, 10)
      || !validateRequest(row.request))) {
    throw new Error("Campaign plan violates its exact schema");
  }
}

async function readPlan(filename) {
  const observed = await stableRegularFile(filename, MAX_PLAN_BYTES);
  const text = observed.contents.toString("utf8").trim();
  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    throw new Error("Campaign plan must be valid JSON");
  }
  if (canonicalJson(plan) !== text) throw new Error("Campaign plan must be canonical JSON");
  validatePlan(plan);
  return { plan: Object.freeze(plan), identity: observed.identity };
}

async function verifyCandidate(candidate) {
  await noLinkAncestors(candidate.path);
  const metadata = await fs.lstat(candidate.path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || await fs.realpath(candidate.path) !== candidate.path) {
    throw new Error("Candidate path must be a real canonical directory");
  }
  const observed = {
    head: commandOutput("/usr/bin/git", ["rev-parse", "HEAD"], candidate.path),
    tree: commandOutput("/usr/bin/git", ["rev-parse", "HEAD^{tree}"], candidate.path),
    status: commandOutput(
      "/usr/bin/git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      candidate.path,
    ),
  };
  if (observed.head !== candidate.head || observed.tree !== candidate.tree || observed.status !== "") {
    throw new Error("Candidate Git identity or cleanliness differs from the plan");
  }
  const runner = (await stableRegularFile(
    path.join(candidate.path, "test/helpers/deep-malformed-row-runner.js"),
    4 << 20,
  )).identity;
  if (runner.sha256 !== candidate.runner_sha256) {
    throw new Error("Candidate row runner differs from the plan");
  }
  return {
    path: candidate.path,
    head: observed.head,
    tree: observed.tree,
    runner,
  };
}

function acceptedRowAssertions(record, request) {
  const productLeak = record?.product?.response?.raw_internal_leak
    ?? record?.product?.error?.raw_internal_leak
    ?? null;
  return {
    protocol_ok: record?.protocol === ROW_RESULT_PROTOCOL,
    request_ok: canonicalJson(record?.request) === canonicalJson(request),
    baseline_ok: record?.baseline_canary?.outcome === "response"
      && record?.baseline_canary?.response?.is_error === false
      && record?.baseline_canary?.response?.raw_internal_leak === false,
    product_completed: record?.product?.outcome === "response",
    product_is_error: record?.product?.response?.is_error ?? null,
    product_structured_error: record?.product?.response?.structured_error ?? null,
    product_resource_limit_error:
      record?.product?.response?.structured_error?.status === "failed"
      && record?.product?.response?.structured_error?.error_schema_version === 1
      && record?.product?.response?.structured_error?.code
        === "PDF_RESOURCE_LIMIT_EXCEEDED",
    product_raw_internal_leak: productLeak,
    post_canary_ok: record?.same_server_canary?.outcome === "response"
      && record?.same_server_canary?.response?.is_error === false
      && record?.same_server_canary?.response?.raw_internal_leak === false,
    filesystem_unchanged: record?.filesystem?.unchanged === true,
  };
}

function productPass(assertions, evidence) {
  return assertions !== null
    && evidence?.controller_accepted === true
    && evidence?.controller_failure === "none"
    && evidence?.observations?.original_process_group_empty === true
    && evidence?.observations?.escaped_session_detected === false
    && assertions.protocol_ok
    && assertions.request_ok
    && assertions.baseline_ok
    && assertions.product_completed
    && assertions.product_is_error === true
    && assertions.product_resource_limit_error === true
    && assertions.product_raw_internal_leak === false
    && assertions.post_canary_ok
    && assertions.filesystem_unchanged;
}

function harnessValid(evidence) {
  return evidence?.observations?.original_process_group_empty === true
    && evidence?.observations?.escaped_session_detected === false
    && [
      "none",
      "deadline",
      "stdout_limit",
      "stderr_limit",
      "physical_footprint_limit",
    ].includes(evidence?.controller_failure);
}

async function runCampaign(plan, planIdentity) {
  if (process.platform !== "darwin") throw new Error("Native campaign requires macOS");
  const candidate = await verifyCandidate(plan.candidate);
  const supervisor = (await stableRegularFile(plan.supervisor.path, 4 << 20)).identity;
  if (canonicalJson(supervisor) !== canonicalJson(plan.supervisor)) {
    throw new Error("Supervisor identity differs from the plan");
  }
  const nodeExecutable = await fs.realpath(process.execPath);
  const nodeIdentity = (await stableRegularFile(nodeExecutable, 256 << 20)).identity;
  await noLinkAncestors(path.dirname(plan.attempt_root));
  await fs.mkdir(plan.attempt_root, { mode: 0o700 });

  const rows = [];
  let ordinal = 0;
  for (const plannedRow of plan.rows) {
    for (let repetition = 1; repetition <= plannedRow.repetitions; repetition += 1) {
      ordinal += 1;
      const cwd = path.join(plan.attempt_root, `row-${String(ordinal).padStart(4, "0")}`);
      await fs.mkdir(cwd, { mode: 0o700 });
      await fs.mkdir(path.join(cwd, "tmp"), { mode: 0o700 });
      await fs.mkdir(path.join(cwd, "work"), { mode: 0o700 });
      const stdin = Buffer.from(canonicalJson(plannedRow.request), "utf8");
      const result = await runSupervisedCandidate({
        binaryPath: supervisor.path,
        expectedBinary: supervisor,
        cwd,
        command: [nodeExecutable, candidate.runner.path],
        stdin,
        environment: {
          LANG: "C",
          LC_ALL: "C",
          PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
          PDF_TOOLS_CAMPAIGN_WORK_ROOT: path.join(cwd, "work"),
          TMPDIR: path.join(cwd, "tmp"),
        },
        deadlineMs: plan.limits.deadline_ms,
        leaderExitGraceMs: plan.limits.leader_exit_grace_ms,
        sampleIntervalMs: plan.limits.sample_interval_ms,
        stdoutMaxBytes: plan.limits.stdout_max_bytes,
        stderrMaxBytes: plan.limits.stderr_max_bytes,
        physicalFootprintMaxBytes: plan.limits.physical_footprint_max_bytes,
        addressSpaceBytes: plan.limits.address_space_bytes,
        cpuSeconds: plan.limits.cpu_seconds,
        fileSizeBytes: plan.limits.file_size_bytes,
        nofile: plan.limits.nofile,
      });
      const record = result.evidence.controller_accepted
        ? parseCanonicalCandidateJson(result.stdout, plan.limits.stdout_max_bytes)
        : null;
      const assertions = record === null
        ? null
        : acceptedRowAssertions(record, plannedRow.request);
      rows.push({
        ordinal,
        repetition,
        request: plannedRow.request,
        supervisor_evidence: result.evidence,
        supervisor_exit: result.exit,
        candidate_stdout: {
          bytes: result.stdout.length,
          sha256: sha256(result.stdout),
          record,
        },
        supervisor_stderr: {
          bytes: result.supervisor_stderr.length,
          sha256: sha256(result.supervisor_stderr),
        },
        assertions,
        harness_valid: harnessValid(result.evidence),
        product_boundary_owned: result.evidence?.controller_accepted === true
          && result.evidence?.controller_failure === "none",
        product_pass: productPass(assertions, result.evidence),
      });
    }
  }

  return {
    protocol: RESULT_PROTOCOL,
    plan: {
      identity: planIdentity,
      value: plan,
    },
    environment: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      architecture: os.arch(),
      node: {
        invoked_executable: process.execPath,
        canonical_executable: nodeExecutable,
        version: process.version,
        identity: nodeIdentity,
      },
    },
    candidate,
    supervisor,
    rows,
    summary: {
      planned_rows: rows.length,
      harness_valid_rows: rows.filter(row => row.harness_valid).length,
      product_pass_rows: rows.filter(row => row.product_pass).length,
      product_failed_rows: rows.filter(row => !row.product_pass).length,
      harness_status: rows.every(row => row.harness_valid) ? "pass" : "fail",
      product_status: rows.every(row => row.product_pass) ? "pass" : "fail",
    },
  };
}

async function main() {
  if (process.argv.length !== 3 || path.resolve(process.argv[2]) !== process.argv[2]) {
    throw new Error("Usage: deep-malformed-macos-campaign.js /canonical/absolute/plan.json");
  }
  const { plan, identity } = await readPlan(process.argv[2]);
  const result = await runCampaign(plan, identity);
  const output = Buffer.from(`${canonicalJson(result)}\n`, "utf8");
  if (output.length > MAX_RESULT_BYTES) throw new Error("Campaign result exceeds its byte ceiling");
  const receiptPath = path.join(plan.attempt_root, "receipt.json");
  const handle = await fs.open(receiptPath, "wx", 0o600);
  try {
    await handle.writeFile(output);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const receipt = (await stableRegularFile(receiptPath, MAX_RESULT_BYTES)).identity;
  process.stdout.write(`${canonicalJson({
    protocol: "pdf-tools.deep-malformed-macos-campaign-receipt-written.v1",
    receipt,
    summary: result.summary,
  })}\n`);
}

main().catch(error => {
  process.stderr.write(`Campaign controller failed: ${error.message}\n`);
  process.exitCode = 1;
});
