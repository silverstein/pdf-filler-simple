#!/usr/bin/env node

/**
 * Compare two passing, independent executions of the frozen 13 × 6 native
 * malformed-PDF campaign.
 *
 * The logical comparison retains exact path-normalized responses, product
 * outcomes, typed errors, scanner counts, exact non-output inventories,
 * operation-specific QPDF object-graph fingerprints, independent output
 * validation, and qualification assertions. It deliberately excludes only
 * attempt-root paths, file-system object numbers, process IDs, timings,
 * supervisor samples/peaks, raw response identities containing distinct
 * planned argument paths, and raw output identities containing explicitly
 * located clock metadata. Each individual campaign still retains every raw
 * response and output identity.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "./docling-macos-supervisor.js";
import { campaignV3Internals } from "./deep-malformed-macos-campaign-v3.js";

const CAMPAIGN_PROTOCOL = "pdf-tools.deep-malformed-macos-campaign-result.v3";
const COMPARISON_PROTOCOL =
  "pdf-tools.deep-malformed-macos-campaign-reproducibility.v3";
const MAX_RECEIPT_BYTES = 16 << 20;
const MAX_COMPARISON_BYTES = 4 << 20;
const SHA256 = /^[a-f0-9]{64}$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort())
      === canonicalJson([...expected].sort());
}

async function noLinkAncestors(filename) {
  let cursor = path.resolve(filename);
  for (;;) {
    const metadata = await fs.lstat(cursor);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Path contains a symbolic link: ${cursor}`);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

async function stableFile(
  filename,
  maximumBytes,
  { includeBytes = false } = {},
) {
  if (path.resolve(filename) !== filename) {
    throw new Error("Evidence path must be canonical and absolute");
  }
  await noLinkAncestors(filename);
  const before = await fs.lstat(filename, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size < 1n || before.size > BigInt(maximumBytes)) {
    throw new Error(`Evidence violates its regular-file contract: ${filename}`);
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
    if (descriptorBefore.dev !== before.dev
      || descriptorBefore.ino !== before.ino
      || descriptorBefore.size !== before.size
      || descriptorBefore.mode !== before.mode
      || descriptorBefore.nlink !== before.nlink) {
      throw new Error(`Evidence changed before read: ${filename}`);
    }
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      observedBytes += bytesRead;
      if (observedBytes > maximumBytes) {
        throw new Error(`Evidence exceeds its byte ceiling: ${filename}`);
      }
      const bytes = buffer.subarray(0, bytesRead);
      digest.update(bytes);
      if (includeBytes) chunks.push(Buffer.from(bytes));
    }
    const descriptorAfter = await handle.stat({ bigint: true });
    const pathnameAfter = await fs.lstat(filename, { bigint: true });
    if (descriptorAfter.dev !== before.dev
      || descriptorAfter.ino !== before.ino
      || descriptorAfter.size !== before.size
      || descriptorAfter.mode !== before.mode
      || descriptorAfter.nlink !== before.nlink
      || pathnameAfter.dev !== before.dev
      || pathnameAfter.ino !== before.ino
      || pathnameAfter.size !== before.size
      || pathnameAfter.mode !== before.mode
      || pathnameAfter.nlink !== before.nlink
      || observedBytes !== Number(before.size)) {
      throw new Error(`Evidence changed during read: ${filename}`);
    }
  } finally {
    await handle.close();
  }
  if (await fs.realpath(filename) !== filename) {
    throw new Error(`Evidence path is not canonical: ${filename}`);
  }
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
  const observed = await stableFile(
    filename,
    maximumBytes,
    { includeBytes: true },
  );
  const text = observed.contents.toString("utf8");
  let value;
  try {
    value = JSON.parse(text.trim());
  } catch {
    throw new Error("Campaign receipt must contain valid JSON");
  }
  if (`${canonicalJson(value)}\n` !== text) {
    throw new Error("Campaign receipt must be canonical JSON plus one newline");
  }
  return { identity: observed.identity, value };
}

async function writeCanonicalJson(filename, value, maximumBytes) {
  const output = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  if (output.length > maximumBytes) {
    throw new Error("Campaign comparison exceeds its byte ceiling");
  }
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

function passingSummary(summary) {
  return exactKeys(summary, [
    "matrix_complete",
    "observed_rows",
    "planned_rows",
    "product_boundary_owned_rows",
    "qualification_failed_rows",
    "qualification_pass_rows",
    "status",
    "supervisor_evidence_valid_rows",
  ])
    && summary.planned_rows === 78
    && summary.observed_rows === 78
    && summary.supervisor_evidence_valid_rows === 78
    && summary.product_boundary_owned_rows === 78
    && summary.qualification_pass_rows === 78
    && summary.qualification_failed_rows === 0
    && summary.matrix_complete === true
    && summary.status === "pass";
}

function validReceiptRow(receipt, row, index) {
  if (!exactKeys(row, [
    "assertions",
    "candidate_stdout",
    "matrix",
    "ordinal",
    "outer_final_inventory",
    "product_boundary_owned",
    "qualification_pass",
    "request",
    "supervisor_evidence",
    "supervisor_evidence_valid",
    "supervisor_exit",
    "supervisor_lease",
    "supervisor_stderr",
  ])
    || !exactKeys(row.candidate_stdout, [
      "bytes",
      "parse_error",
      "record",
      "sha256",
    ])
    || !exactKeys(row.outer_final_inventory, [
      "canonical_bytes",
      "error",
      "sha256",
    ])
    || row.candidate_stdout.parse_error !== null
    || row.outer_final_inventory.error !== null
    || !Number.isSafeInteger(row.outer_final_inventory.canonical_bytes)
    || row.outer_final_inventory.canonical_bytes < 1
    || !SHA256.test(row.outer_final_inventory.sha256 ?? "")
    || row.ordinal !== index + 1
    || row.qualification_pass !== true
    || row.product_boundary_owned !== true
    || row.supervisor_evidence_valid !== true
    || !campaignV3Internals.validateCampaignSupervisorEvidence(
      row.supervisor_evidence,
      row.supervisor_lease,
      receipt.plan.value,
    )
    || row.supervisor_evidence?.controller_accepted !== true
    || row.supervisor_evidence?.controller_failure !== "none"
    || row.supervisor_evidence?.observations
      ?.original_process_group_empty !== true
    || row.supervisor_evidence?.observations
      ?.escaped_session_detected !== false
    || row.supervisor_evidence?.capture?.stdout_retained_bytes
      !== row.candidate_stdout?.bytes
    || row.supervisor_exit?.code !== 0
    || row.supervisor_exit?.signal !== null
    || row.supervisor_stderr?.bytes !== 0
    || row.supervisor_stderr?.sha256 !== sha256(Buffer.alloc(0))
    || row.candidate_stdout?.record?.protocol
      !== "pdf-tools.deep-malformed-row-result.v3"
    || canonicalJson(row.request) !== canonicalJson(
      row.candidate_stdout.record.request,
    )
    || canonicalJson(row.matrix)
      !== canonicalJson(receipt.plan.value.matrix[index])) {
    return false;
  }
  const recordBytes = Buffer.from(
    `${canonicalJson(row.candidate_stdout.record)}\n`,
    "utf8",
  );
  const finalInventoryBytes = Buffer.from(
    canonicalJson(row.candidate_stdout.record.final_inventory),
    "utf8",
  );
  if (row.candidate_stdout.bytes !== recordBytes.length
    || row.candidate_stdout.sha256 !== sha256(recordBytes)
    || row.outer_final_inventory.canonical_bytes
      !== finalInventoryBytes.length
    || row.outer_final_inventory.sha256 !== sha256(finalInventoryBytes)) {
    return false;
  }
  const workRoot = path.join(
    receipt.plan.value.attempt_root,
    `row-${String(index + 1).padStart(4, "0")}`,
    "work",
  );
  const rederivedAssertions = campaignV3Internals.validateRowRecord(
    row.candidate_stdout.record,
    row.request,
    row.matrix,
    workRoot,
    row.candidate_stdout.record.final_inventory,
    true,
  );
  return canonicalJson(row.assertions) === canonicalJson(rederivedAssertions)
    && Object.values(rederivedAssertions).every(value => value === true);
}

function receiptAuthoritiesValid(receipt, expectedLabel, planAuthority) {
  try {
    campaignV3Internals.validatePlan(receipt?.plan?.value);
  } catch {
    return false;
  }
  return exactKeys(receipt, [
    "candidate",
    "corpus",
    "environment",
    "plan",
    "protocol",
    "rows",
    "summary",
    "supervisor",
    "qpdf_budget_exec",
  ])
    && receipt.protocol === CAMPAIGN_PROTOCOL
    && exactKeys(receipt.plan, ["identity", "value"])
    && path.dirname(receipt.plan.value.attempt_root)
      === path.dirname(receipt.plan.identity.path)
    && canonicalJson(planAuthority.identity)
      === canonicalJson(receipt.plan.identity)
    && canonicalJson(planAuthority.value)
      === canonicalJson(receipt.plan.value)
    && receipt.plan?.value?.logical_run_label === expectedLabel
    && canonicalJson(receipt.candidate)
      === canonicalJson(receipt.plan.value.candidate)
    && canonicalJson(receipt.supervisor)
      === canonicalJson(receipt.plan.value.supervisor)
    && canonicalJson(receipt.qpdf_budget_exec)
      === canonicalJson(receipt.plan.value.qpdf_budget_exec)
    && canonicalJson(receipt.corpus) === canonicalJson({
      comparison: receipt.plan.value.corpus.comparison,
      manifest: receipt.plan.value.corpus.manifest,
      provision_controller:
        receipt.plan.value.corpus.provision_controller,
      provisioner: receipt.plan.value.corpus.provisioner,
      logical_fixture_digest:
        receipt.plan.value.corpus.logical_fixture_digest,
    })
    && exactKeys(receipt.environment, [
      "architecture",
      "hostname",
      "node",
      "platform",
      "release",
    ])
    && receipt.environment.platform === "darwin"
    && typeof receipt.environment.hostname === "string"
    && typeof receipt.environment.release === "string"
    && typeof receipt.environment.architecture === "string"
    && canonicalJson(receipt.environment.node)
      === canonicalJson(receipt.plan.value.runtime.node);
}

async function validateReceipt(receipt, expectedLabel) {
  let planAuthority;
  try {
    planAuthority = await canonicalJsonFile(
      receipt?.plan?.identity?.path,
      1024 * 1024,
    );
  } catch {
    throw new Error(`Campaign receipt has an invalid ${expectedLabel} plan authority`);
  }
  if (!receiptAuthoritiesValid(
    receipt,
    expectedLabel,
    planAuthority,
  )
    || !passingSummary(receipt.summary)
    || !Array.isArray(receipt.rows)
    || receipt.rows.length !== 78
    || receipt.rows.some((row, index) =>
      !validReceiptRow(receipt, row, index))) {
    throw new Error(`Campaign receipt is not a passing exact ${expectedLabel}`);
  }
}

function normalizedPlan(plan) {
  const {
    attempt_root: _attemptRoot,
    logical_run_label: _logicalRunLabel,
    ...stable
  } = plan;
  return stable;
}

function scannerSemantics(scanner) {
  return {
    protocol: scanner.protocol,
    scanned_nodes: scanner.scanned_nodes,
    scanned_strings: scanner.scanned_strings,
    normalized_scanned_bytes: scanner.normalized_scanned_bytes,
    normalized_response: scanner.normalized_response,
    allowed_path_substitutions: scanner.allowed_path_substitutions.map(row => ({
      label: row.label,
      uses: row.uses,
    })),
    raw_internal_matches: scanner.raw_internal_matches,
    pass: scanner.pass,
  };
}

function responseSemantics(observation) {
  if (observation === null) return null;
  return {
    outcome: observation.outcome,
    response: {
      valid_call_tool_result: observation.response.valid_call_tool_result,
      is_error: observation.response.is_error,
      structured_error: observation.response.structured_error,
      content_items: observation.response.content_items,
      scanner: scannerSemantics(observation.response.scanner),
    },
  };
}

function identitySemantics(identity) {
  return {
    bytes: identity.bytes,
    sha256: identity.sha256,
    mode: identity.mode,
    links: identity.links,
  };
}

function inventorySemantics(inventory) {
  const outputLabels = new Set(["rotate_output", "split_output"]);
  return {
    total_entries: inventory.total_entries,
    roots: inventory.roots.map(root => outputLabels.has(root.label)
      ? {
          label: root.label,
          mode: root.mode,
          entries: root.entries.map(entry => entry.kind === "file"
            ? {
                path: entry.path,
                kind: entry.kind,
                mode: entry.mode,
                links: entry.links,
                nonempty: entry.bytes >= 1,
                within_file_ceiling: entry.bytes <= (250 << 20),
                hash_recorded: SHA256.test(entry.sha256),
              }
            : entry),
          within_aggregate_ceiling: root.aggregate_bytes <= (500 << 20),
        }
      : root),
  };
}

function outputSemantics(outputValidation) {
  return {
    required: outputValidation.required,
    pass: outputValidation.pass,
    outputs: outputValidation.outputs.map(output => ({
      identity: {
        mode: output.identity.mode,
        links: output.identity.links,
        nonempty: output.identity.bytes >= 1,
        within_file_ceiling: output.identity.bytes <= (250 << 20),
        hash_recorded: SHA256.test(output.identity.sha256),
      },
      nonalias: output.nonalias,
      qpdf_stable: output.qpdf_stable,
      qpdf_check_pass: output.qpdf_check.pass === true
        && output.qpdf_check.containment.budget_enforced === true
        && output.qpdf_check.containment.control_eof_after_ready === true,
      qpdf_pages_pass: output.qpdf_pages.pass === true
        && output.qpdf_pages.containment.budget_enforced === true
        && output.qpdf_pages.containment.control_eof_after_ready === true
        && output.qpdf_pages.command.stdout.text.trim() === "1",
      semantic: output.semantic,
      semantic_fingerprint: {
        protocol: output.semantic_fingerprint.protocol,
        canonicalization: {
          protocol: output.semantic_fingerprint.canonicalization.protocol,
          command_pass:
            output.semantic_fingerprint.canonicalization.pass === true
            && output.semantic_fingerprint.canonicalization.command.command
              .outcome === "close"
            && output.semantic_fingerprint.canonicalization.command.command
              .code === 0
            && output.semantic_fingerprint.canonicalization.command.command
              .signal === null
            && output.semantic_fingerprint.canonicalization.command.command
              .timed_out === false
            && output.semantic_fingerprint.canonicalization.command.command
              .output_overflow === false,
          output: {
            mode: output.semantic_fingerprint.canonicalization.output.mode,
            links: output.semantic_fingerprint.canonicalization.output.links,
            nonempty:
              output.semantic_fingerprint.canonicalization.output.bytes >= 1,
            within_file_ceiling:
              output.semantic_fingerprint.canonicalization.output.bytes
                <= (250 << 20),
            hash_recorded: SHA256.test(
              output.semantic_fingerprint.canonicalization.output.sha256,
            ),
          },
          pass: output.semantic_fingerprint.canonicalization.pass,
        },
        normalization: output.semantic_fingerprint.normalization,
        normalized: output.semantic_fingerprint.normalized,
        pass: output.semantic_fingerprint.pass,
      },
    })),
  };
}

function logicalRow(row) {
  const record = row.candidate_stdout.record;
  return {
    ordinal: row.ordinal,
    matrix: row.matrix,
    fixture: {
      source: identitySemantics(record.fixture.source),
      input: identitySemantics(record.fixture.input),
      control: identitySemantics(record.fixture.control),
    },
    baseline_canary: responseSemantics(record.baseline_canary),
    baseline_pdfjs_canary: responseSemantics(record.baseline_pdfjs_canary),
    product: responseSemantics(record.product),
    same_server_canary: responseSemantics(record.same_server_canary),
    same_server_pdfjs_canary:
      responseSemantics(record.same_server_pdfjs_canary),
    identity_unchanged: record.identity_observations.unchanged,
    baseline_inventory: inventorySemantics(record.baseline_inventory),
    immediate_inventory: inventorySemantics(record.immediate_inventory),
    final_inventory: inventorySemantics(record.final_inventory),
    inventory_policy: record.inventory_policy,
    output_validation: outputSemantics(record.output_validation),
    assertions: row.assertions,
    outer_final_inventory: {
      independently_matched: row.assertions.outer_final_inventory,
      evidence_retained: row.outer_final_inventory.error === null
        && Number.isSafeInteger(row.outer_final_inventory.canonical_bytes)
        && SHA256.test(row.outer_final_inventory.sha256),
    },
    qualification: {
      supervisor_evidence_valid: row.supervisor_evidence_valid,
      product_boundary_owned: row.product_boundary_owned,
      qualification_pass: row.qualification_pass,
    },
  };
}

async function main() {
  if (process.platform !== "darwin"
    || process.argv.length !== 5
    || process.argv.slice(2).some(filename =>
      path.resolve(filename) !== filename)) {
    throw new Error(
      "Usage: compare-deep-malformed-macos-campaign-v3.js "
      + "/run-a/receipt.json /run-b/receipt.json /comparison.json",
    );
  }
  const [runAPath, runBPath, outputPath] = process.argv.slice(2);
  if (new Set([runAPath, runBPath, outputPath]).size !== 3) {
    throw new Error("Campaign authorities and comparison output must differ");
  }
  await noLinkAncestors(path.dirname(outputPath));
  const parent = await fs.lstat(path.dirname(outputPath), { bigint: true });
  if (!parent.isDirectory() || parent.isSymbolicLink()
    || Number(parent.mode & 0o777n) !== 0o700
    || await fs.realpath(path.dirname(outputPath)) !== path.dirname(outputPath)) {
    throw new Error("Comparison output parent must be a real mode-0700 directory");
  }
  const runA = await canonicalJsonFile(runAPath, MAX_RECEIPT_BYTES);
  const runB = await canonicalJsonFile(runBPath, MAX_RECEIPT_BYTES);
  await validateReceipt(runA.value, "run-a");
  await validateReceipt(runB.value, "run-b");
  if (canonicalJson(normalizedPlan(runA.value.plan.value))
      !== canonicalJson(normalizedPlan(runB.value.plan.value))
    || runA.value.candidate.head !== runB.value.candidate.head
    || runA.value.candidate.tree !== runB.value.candidate.tree
    || runA.value.corpus.logical_fixture_digest
      !== runB.value.corpus.logical_fixture_digest) {
    throw new Error("Campaign authorities do not bind one exact logical plan");
  }
  const authorityPlan = runA.value.plan.value;
  const invokedNode = await fs.realpath(process.execPath);
  if (invokedNode !== authorityPlan.runtime.node.executable.path
    || process.version !== authorityPlan.runtime.node.version
    || canonicalJson((await stableFile(invokedNode, 256 << 20)).identity)
      !== canonicalJson(authorityPlan.runtime.node.executable)) {
    throw new Error("Comparator Node runtime differs from campaign authorities");
  }
  await campaignV3Internals.verifyCandidate(authorityPlan.candidate);
  await campaignV3Internals.verifySupervisor(
    authorityPlan.supervisor,
    authorityPlan.candidate,
  );
  await campaignV3Internals.verifyQpdfBudgetExec(
    authorityPlan.qpdf_budget_exec,
    authorityPlan.candidate,
  );
  await campaignV3Internals.verifyCorpus(
    authorityPlan.corpus,
    authorityPlan.candidate,
    authorityPlan.runtime,
  );
  const qpdfObserved = (await stableFile(
    authorityPlan.qpdf.path,
    64 << 20,
  )).identity;
  if (qpdfObserved.bytes !== authorityPlan.qpdf.bytes
    || qpdfObserved.sha256 !== authorityPlan.qpdf.sha256
    || qpdfObserved.mode !== authorityPlan.qpdf.mode
    || qpdfObserved.links !== authorityPlan.qpdf.links) {
    throw new Error("qpdf authority changed before campaign comparison");
  }
  const logicalA = runA.value.rows.map(logicalRow);
  const logicalB = runB.value.rows.map(logicalRow);
  const canonicalA = canonicalJson(logicalA);
  const canonicalB = canonicalJson(logicalB);
  if (canonicalA !== canonicalB) {
    throw new Error("Independent campaigns are not logically reproducible");
  }
  const comparison = {
    protocol: COMPARISON_PROTOCOL,
    candidate: {
      head: runA.value.candidate.head,
      tree: runA.value.candidate.tree,
    },
    corpus_logical_fixture_digest:
      runA.value.corpus.logical_fixture_digest,
    authorities: {
      run_a: runA.identity,
      run_b: runB.identity,
    },
    normalized_plan_digest: sha256(Buffer.from(
      canonicalJson(normalizedPlan(runA.value.plan.value)),
      "utf8",
    )),
    logical_rows: logicalA,
    logical_rows_digest: sha256(Buffer.from(canonicalA, "utf8")),
    result: {
      planned_runs: 2,
      accepted_runs: 2,
      rows_per_run: 78,
      product_owned_rows_per_run: 78,
      qualification_pass_rows_per_run: 78,
      logically_reproducible: true,
      status: "pass",
    },
  };
  const identity = await writeCanonicalJson(
    outputPath,
    comparison,
    MAX_COMPARISON_BYTES,
  );
  if (!SHA256.test(identity.sha256)) {
    throw new Error("Comparison output identity is invalid");
  }
  process.stdout.write(`${canonicalJson({
    protocol:
      "pdf-tools.deep-malformed-macos-campaign-reproducibility-written.v3",
    comparison: identity,
    summary: comparison.result,
  })}\n`);
}

export const campaignComparisonV3Internals = Object.freeze({
  inventorySemantics,
  logicalRow,
  normalizedPlan,
  outputSemantics,
  receiptAuthoritiesValid,
  responseSemantics,
  validateReceipt,
});

if (process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`Campaign comparison failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
