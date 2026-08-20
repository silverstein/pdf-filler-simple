import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  scoreVerifiedExtractionCandidate,
  sha256,
  validateCandidateExecutionAuthority,
  validateComparisonAuthority,
  verifyVerifiedExtractionContract,
  verifyVerifiedExtractionCampaignReceipt,
} from "./verified-extraction-contract.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BENCHMARK_ROOT = path.join(REPO_ROOT, "test", "fixtures", "eval", "verified-extraction");

async function loadDocument(document) {
  const readJson = role => fs.readFile(path.join(BENCHMARK_ROOT, document.artifacts[role].path), "utf8").then(JSON.parse);
  const [schema, truth, citationOracle] = await Promise.all([readJson("schema"), readJson("truth"), readJson("citations")]);
  return { schema, truth, citationOracle };
}

function syntheticBaselineIdentity() {
  return {
    scheme: "pdf-tools-product-identity.v1",
    kind: "git_source_tree",
    git_commit: "1".repeat(40),
    git_tree: "a".repeat(40),
  };
}

function syntheticCandidateIdentity() {
  return {
    scheme: "pdf-tools-product-identity.v1",
    kind: "packaged_artifact",
    git_commit: "2".repeat(40),
    artifact_sha256: "b".repeat(64),
  };
}

function comparisonAuthorityFor(manifest, { retryBudget = 1, trialsPerDocument = 1 } = {}) {
  const trials = [];
  for (const document of manifest.documents) {
    for (let trialIndex = 1; trialIndex <= trialsPerDocument; trialIndex++) {
      for (const workflowRole of ["baseline", "candidate"]) {
        trials.push({
          trial_id: `trial-${workflowRole}-${document.id}-${trialIndex}`,
          document_id: document.id,
          workflow_role: workflowRole,
          trial_index: trialIndex,
          attempt_ids: Array.from({ length: retryBudget + 1 }, (_, index) => (
            `attempt-${workflowRole}-${document.id}-${trialIndex}-${index + 1}`
          )),
        });
      }
    }
  }
  const settings = { temperature: 0, max_output_tokens: 4096 };
  return {
    comparison_version: 1,
    comparison_id: "synthetic-comparison-complete-v1",
    benchmark_id: manifest.benchmark_id,
    benchmark_manifest_sha256: sha256(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)),
    admission_class: "synthetic_scorer_calibration",
    authorized_at: "2026-08-20T12:00:00.000Z",
    candidate_identity_state: "pending_implementation",
    admitted_document_ids: manifest.documents.map(document => document.id).sort(),
    workflow_roles: ["baseline", "candidate"],
    protocol_bindings: Object.fromEntries(["baseline", "candidate"].map(workflowRole => [workflowRole, {
      id: manifest.protocols[workflowRole].value.id,
      sha256: manifest.protocols[workflowRole].sha256,
    }])),
    scorer_binding: { sha256: manifest.scorer.sha256 },
    shared_execution: {
      model: { provider: "host-managed-test", id: "synthetic-model", version: "fixture-v1" },
      host: { id: "synthetic-host", platform: "test", architecture: "test", runtime: "node-test" },
      settings,
      settings_sha256: sha256(Buffer.from(canonicalJson(settings))),
      time_budget_ms: 120000,
    },
    baseline_product_identity: syntheticBaselineIdentity(),
    trials_per_document: trialsPerDocument,
    retry_budget: retryBudget,
    replacement_policy: "no_product_replacement_harness_retry_only",
    trial_count: trials.length,
    attempt_slot_count: trials.length * (retryBudget + 1),
    trials,
  };
}

function candidateExecutionPlan(comparisonAuthority, comparisonDigest, productIdentity) {
  return {
    comparison_authority_sha256: comparisonDigest,
    workflow_role: "candidate",
    protocol_binding: comparisonAuthority.protocol_bindings.candidate,
    scorer_binding: comparisonAuthority.scorer_binding,
    shared_execution: comparisonAuthority.shared_execution,
    retry_budget: comparisonAuthority.retry_budget,
    product_identity: productIdentity,
  };
}

function candidateExecutionAuthorityFor(manifest, comparisonAuthority) {
  const comparison = validateComparisonAuthority({ manifest, comparisonAuthority });
  const productIdentity = syntheticCandidateIdentity();
  return {
    authority_version: 1,
    authority_id: "synthetic-candidate-execution-v1",
    comparison_authority_sha256: comparison.authority_sha256,
    authorized_at: "2026-08-20T12:00:30.000Z",
    workflow_role: "candidate",
    product_identity: productIdentity,
    execution_plan_sha256: sha256(Buffer.from(canonicalJson(candidateExecutionPlan(
      comparisonAuthority, comparison.authority_sha256, productIdentity,
    )))),
  };
}

function trialFor(comparisonAuthority, document, workflowRole, trialIndex = 1) {
  return comparisonAuthority.trials.find(trial => trial.document_id === document.id
    && trial.workflow_role === workflowRole && trial.trial_index === trialIndex);
}

function runRecordFor({
  manifest, comparisonAuthority, candidateExecutionAuthority, document, workflowRole, result, citationOracle, attemptIndex = 1,
}) {
  const comparison = validateComparisonAuthority({ manifest, comparisonAuthority });
  const roleAuthority = workflowRole === "baseline" ? {
    authority_sha256: comparison.authority_sha256,
    execution_plan_sha256: comparison.baseline_execution_plan_sha256,
    product_identity: comparisonAuthority.baseline_product_identity,
  } : validateCandidateExecutionAuthority({ manifest, comparisonAuthority, candidateExecutionAuthority });
  const trial = trialFor(comparisonAuthority, document, workflowRole);
  return {
    document_id: document.id,
    source_sha256: document.artifacts.pdf.sha256,
    schema_sha256: document.artifacts.schema.sha256,
    comparison_authority_sha256: comparison.authority_sha256,
    role_authority_sha256: roleAuthority.authority_sha256,
    execution_binding_sha256: roleAuthority.execution_plan_sha256,
    product_identity: structuredClone(roleAuthority.product_identity),
    trial_id: trial.trial_id,
    attempt_id: trial.attempt_ids[attemptIndex - 1],
    attempt_index: attemptIndex,
    execution: { started_at: "2026-08-20T12:01:00.000Z", completed_at: "2026-08-20T12:02:00.000Z" },
    result: structuredClone(result),
    citations: structuredClone(citationOracle.citations),
    uncertainties: [],
    completion: { complete: true, processed_pages: document.page_count, omitted_paths: [] },
  };
}

function attemptReceiptFor(trial, comparisonAuthority, candidateExecutionAuthority, attemptIndex, outcomeKind, outcome) {
  const comparisonDigest = sha256(Buffer.from(canonicalJson(comparisonAuthority)));
  const roleAuthorityDigest = trial.workflow_role === "baseline" ? comparisonDigest
    : sha256(Buffer.from(canonicalJson(candidateExecutionAuthority)));
  return {
    receipt_version: 1,
    comparison_authority_sha256: comparisonDigest,
    role_authority_sha256: roleAuthorityDigest,
    trial_id: trial.trial_id,
    attempt_id: trial.attempt_ids[attemptIndex - 1],
    attempt_index: attemptIndex,
    document_id: trial.document_id,
    workflow_role: trial.workflow_role,
    outcome_kind: outcomeKind,
    outcome,
  };
}

function productReceiptFor(candidate, trial, comparisonAuthority, candidateExecutionAuthority) {
  return attemptReceiptFor(trial, comparisonAuthority, candidateExecutionAuthority, candidate.attempt_index, "product_result", {
    candidate,
    candidate_sha256: sha256(Buffer.from(canonicalJson(candidate))),
  });
}

function harnessFailureOutcome(failureCode = "timeout") {
  return {
    failure_code: failureCode,
    execution: { started_at: "2026-08-20T12:01:00.000Z", completed_at: "2026-08-20T12:02:00.000Z" },
  };
}

async function successfulCampaignState(manifest, comparisonAuthority, candidateExecutionAuthority) {
  const documentContexts = Object.fromEntries(await Promise.all(manifest.documents.map(async document => [
    document.id, { document, ...await loadDocument(document) },
  ])));
  const receipts = [];
  for (const trial of comparisonAuthority.trials) {
    const document = manifest.documents.find(item => item.id === trial.document_id);
    const { truth, citationOracle } = documentContexts[document.id];
    const candidate = runRecordFor({
      manifest, comparisonAuthority, candidateExecutionAuthority, document,
      workflowRole: trial.workflow_role, result: truth, citationOracle,
    });
    receipts.push(productReceiptFor(candidate, trial, comparisonAuthority, candidateExecutionAuthority));
    for (let attemptIndex = 2; attemptIndex <= trial.attempt_ids.length; attemptIndex++) {
      receipts.push(attemptReceiptFor(
        trial, comparisonAuthority, candidateExecutionAuthority, attemptIndex, "not_run", { reason: "retry_not_needed" },
      ));
    }
  }
  return { receipts, documentContexts };
}

describe("verified extraction benchmark contract", () => {
  it("replays every exact byte, page, truth, citation, calculation, and denominator binding", async () => {
    const verified = await verifyVerifiedExtractionContract({ benchmarkRoot: BENCHMARK_ROOT, repoRoot: REPO_ROOT });
    expect(verified.totals).toEqual({
      documents: 3,
      pages: 288,
      leaf_values: 97,
      citation_obligations: 43,
      keyed_array_items: 27,
      calculations: 1,
    });
    expect(verified.manifest.claim_boundary.benchmark_claim_ready).toBe(false);
    expect(verified.manifest.product_identity_qualification.contract_validation)
      .toBe("syntactic_shape_and_immutable_binding_only");
  }, 30000);

  it("validates baseline before candidate identity exists and preserves it after later authorization", async () => {
    const { manifest } = await verifyVerifiedExtractionContract({ benchmarkRoot: BENCHMARK_ROOT, repoRoot: REPO_ROOT });
    const comparisonAuthority = comparisonAuthorityFor(manifest);
    const comparisonBefore = validateComparisonAuthority({ manifest, comparisonAuthority });
    expect(comparisonAuthority.candidate_identity_state).toBe("pending_implementation");
    expect(JSON.stringify(comparisonAuthority)).not.toContain(syntheticCandidateIdentity().git_commit);
    const document = manifest.documents[0];
    const { schema, truth, citationOracle } = await loadDocument(document);
    const baseline = runRecordFor({
      manifest, comparisonAuthority, document, workflowRole: "baseline", result: truth, citationOracle,
    });
    const baselineScore = scoreVerifiedExtractionCandidate({
      manifest, workflowRole: "baseline", comparisonAuthority, document, schema, truth, citationOracle, candidate: baseline,
    });
    expect(baselineScore).toMatchObject({ deterministic_failure: false, product_identity_qualification: "external_preflight_required" });
    const retainedBaselineDigest = sha256(Buffer.from(canonicalJson(baseline)));
    const candidateExecutionAuthority = candidateExecutionAuthorityFor(manifest, comparisonAuthority);
    const comparisonAfter = validateComparisonAuthority({ manifest, comparisonAuthority });
    expect(comparisonAfter.authority_sha256).toBe(comparisonBefore.authority_sha256);
    expect(comparisonAfter.baseline_execution_plan_sha256).toBe(comparisonBefore.baseline_execution_plan_sha256);
    expect(sha256(Buffer.from(canonicalJson(baseline)))).toBe(retainedBaselineDigest);
    expect(() => scoreVerifiedExtractionCandidate({
      manifest, workflowRole: "baseline", comparisonAuthority, candidateExecutionAuthority,
      document, schema, truth, citationOracle, candidate: baseline,
    })).not.toThrow();
  }, 30000);

  it("requires later candidate authority and prevents it from drifting any frozen comparison dimension", async () => {
    const { manifest } = await verifyVerifiedExtractionContract({ benchmarkRoot: BENCHMARK_ROOT, repoRoot: REPO_ROOT });
    const comparisonAuthority = comparisonAuthorityFor(manifest);
    const candidateExecutionAuthority = candidateExecutionAuthorityFor(manifest, comparisonAuthority);
    const document = manifest.documents[0];
    const { schema, truth, citationOracle } = await loadDocument(document);
    const candidate = runRecordFor({
      manifest, comparisonAuthority, candidateExecutionAuthority, document,
      workflowRole: "candidate", result: truth, citationOracle,
    });
    expect(() => scoreVerifiedExtractionCandidate({
      manifest, workflowRole: "candidate", comparisonAuthority,
      document, schema, truth, citationOracle, candidate,
    })).toThrow(/candidate execution authority keys|Invalid candidate execution authority/);
    for (const field of ["model", "host", "settings", "protocol_bindings", "scorer_binding", "retry_budget", "trials"]) {
      const injected = structuredClone(candidateExecutionAuthority);
      injected[field] = structuredClone(comparisonAuthority[field] ?? comparisonAuthority.shared_execution[field]);
      expect(() => validateCandidateExecutionAuthority({
        manifest, comparisonAuthority, candidateExecutionAuthority: injected,
      })).toThrow(/candidate execution authority keys/);
    }
    const wrongComparison = structuredClone(candidateExecutionAuthority);
    wrongComparison.comparison_authority_sha256 = "c".repeat(64);
    expect(() => validateCandidateExecutionAuthority({
      manifest, comparisonAuthority, candidateExecutionAuthority: wrongComparison,
    })).toThrow(/comparison binding mismatch/);
    const wrongPlan = structuredClone(candidateExecutionAuthority);
    wrongPlan.execution_plan_sha256 = "d".repeat(64);
    expect(() => validateCandidateExecutionAuthority({
      manifest, comparisonAuthority, candidateExecutionAuthority: wrongPlan,
    })).toThrow(/execution plan binding mismatch/);
    for (const mutate of [
      authority => { authority.shared_execution.model.version = "drifted"; },
      authority => { authority.shared_execution.host.id = "drifted"; },
      authority => {
        authority.shared_execution.settings.temperature = 1;
        authority.shared_execution.settings_sha256 = sha256(Buffer.from(canonicalJson(authority.shared_execution.settings)));
      },
      authority => { authority.shared_execution.time_budget_ms += 1; },
      authority => { authority.protocol_bindings.candidate.sha256 = "e".repeat(64); },
      authority => { authority.scorer_binding.sha256 = "e".repeat(64); },
      authority => { authority.retry_budget += 1; },
      authority => { authority.trials.pop(); },
    ]) {
      const drifted = structuredClone(comparisonAuthority);
      mutate(drifted);
      expect(() => validateCandidateExecutionAuthority({
        manifest, comparisonAuthority: drifted, candidateExecutionAuthority,
      })).toThrow();
    }
  }, 30000);

  it("gives a perfect score only to complete role-bound exact replays", async () => {
    const { manifest } = await verifyVerifiedExtractionContract({ benchmarkRoot: BENCHMARK_ROOT, repoRoot: REPO_ROOT });
    const comparisonAuthority = comparisonAuthorityFor(manifest);
    const candidateExecutionAuthority = candidateExecutionAuthorityFor(manifest, comparisonAuthority);
    for (const document of manifest.documents) {
      const { schema, truth, citationOracle } = await loadDocument(document);
      for (const workflowRole of ["baseline", "candidate"]) {
        const score = scoreVerifiedExtractionCandidate({
          manifest, workflowRole, comparisonAuthority, candidateExecutionAuthority,
          document, schema, truth, citationOracle,
          candidate: runRecordFor({
            manifest, comparisonAuthority, candidateExecutionAuthority, document, workflowRole, result: truth, citationOracle,
          }),
        });
        expect(score).toMatchObject({ deterministic_failure: false, claim_eligible: false });
        expect(score.leaf_recall.rate).toBe(1);
        expect(score.citation_replay_rate.rate).toBe(1);
      }
    }
  }, 30000);

  it("fails closed for identity and execution drift, omissions, extra leaves, citations, and truncation", async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(BENCHMARK_ROOT, "manifest.v1.json"), "utf8"));
    const comparisonAuthority = comparisonAuthorityFor(manifest);
    const candidateExecutionAuthority = candidateExecutionAuthorityFor(manifest, comparisonAuthority);
    const document = manifest.documents[0];
    const { schema, truth, citationOracle } = await loadDocument(document);
    const base = runRecordFor({
      manifest, comparisonAuthority, candidateExecutionAuthority, document, workflowRole: "candidate",
      result: structuredClone(truth), citationOracle: { ...citationOracle, citations: structuredClone(citationOracle.citations) },
    });
    for (const mutate of [
      candidate => { candidate.source_sha256 = "0".repeat(64); },
      candidate => { candidate.comparison_authority_sha256 = "c".repeat(64); },
      candidate => { candidate.role_authority_sha256 = "d".repeat(64); },
      candidate => { candidate.execution_binding_sha256 = undefined; },
      candidate => { candidate.product_identity.artifact_sha256 = "e".repeat(64); },
      candidate => { candidate.execution.started_at = candidateExecutionAuthority.authorized_at; },
    ]) {
      const drifted = structuredClone(base);
      mutate(drifted);
      expect(() => scoreVerifiedExtractionCandidate({
        manifest, workflowRole: "candidate", comparisonAuthority, candidateExecutionAuthority,
        document, schema, truth, citationOracle, candidate: drifted,
      })).toThrow();
    }
    delete base.result.account.status;
    base.result.account.unrequested_note = "extra";
    base.citations["account.id"].quote = "near enough is not replay";
    base.citations.fabricated = { page: 1, quote: "not present anywhere" };
    base.completion.processed_pages -= 1;
    const score = scoreVerifiedExtractionCandidate({
      manifest, workflowRole: "candidate", comparisonAuthority, candidateExecutionAuthority,
      document, schema, truth, citationOracle, candidate: base,
    });
    expect(score).toMatchObject({
      json_schema_valid: false,
      silent_omission_count: 1,
      extra_citation_count: 1,
      truncation_count: 1,
      deterministic_failure: true,
    });
    expect(score.leaf_precision.rate).toBeLessThan(1);
  });

  it("treats canonical product identities as binding-only and rejects malformed shapes", async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(BENCHMARK_ROOT, "manifest.v1.json"), "utf8"));
    const comparisonAuthority = comparisonAuthorityFor(manifest);
    const document = manifest.documents[0];
    const { schema, truth, citationOracle } = await loadDocument(document);
    const baseline = runRecordFor({
      manifest, comparisonAuthority, document, workflowRole: "baseline", result: truth, citationOracle,
    });
    const score = scoreVerifiedExtractionCandidate({
      manifest, workflowRole: "baseline", comparisonAuthority,
      document, schema, truth, citationOracle, candidate: baseline,
    });
    expect(score.product_identity_qualification).toBe("external_preflight_required");
    for (const mutate of [
      identity => { identity.scheme = "unclassified"; },
      identity => { identity.kind = "source_tree"; },
      identity => { identity.git_commit = "0".repeat(40); },
      identity => { identity.git_tree = "0".repeat(40); },
      identity => { identity.unclassified = true; },
    ]) {
      const malformed = structuredClone(comparisonAuthority);
      mutate(malformed.baseline_product_identity);
      expect(() => validateComparisonAuthority({ manifest, comparisonAuthority: malformed })).toThrow();
    }
  });

  it("requires both role authorities for a complete campaign and rejects every denominator escape hatch", async () => {
    const { manifest } = await verifyVerifiedExtractionContract({ benchmarkRoot: BENCHMARK_ROOT, repoRoot: REPO_ROOT });
    const comparisonAuthority = comparisonAuthorityFor(manifest);
    const candidateExecutionAuthority = candidateExecutionAuthorityFor(manifest, comparisonAuthority);
    const { receipts, documentContexts } = await successfulCampaignState(
      manifest, comparisonAuthority, candidateExecutionAuthority,
    );
    const verifyReceipt = attemptReceipts => verifyVerifiedExtractionCampaignReceipt({
      manifest, comparisonAuthority, candidateExecutionAuthority, documentContexts, attemptReceipts,
    });
    expect(() => verifyVerifiedExtractionCampaignReceipt({
      manifest, comparisonAuthority, documentContexts, attemptReceipts: receipts,
    })).toThrow(/candidate execution authority/);
    expect(verifyReceipt(receipts)).toMatchObject({
      complete: true,
      claim_eligible: false,
      product_identity_qualification: "external_preflight_required",
      planned_trials: 6,
      planned_attempt_slots: 12,
      product_success_trials: 6,
      deterministic_denominators: {
        documents: 6,
        leaf_values: 194,
        citation_obligations: 86,
        keyed_array_items: 54,
        calculations: 2,
      },
    });
    const driftedContexts = structuredClone(documentContexts);
    driftedContexts[manifest.documents[0].id].truth.account.status = "inactive";
    expect(() => verifyVerifiedExtractionCampaignReceipt({
      manifest, comparisonAuthority, candidateExecutionAuthority,
      documentContexts: driftedContexts, attemptReceipts: receipts,
    })).toThrow(/context artifact mismatch/);
    for (const mutate of [
      authority => { authority.admitted_document_ids.pop(); },
      authority => { authority.admitted_document_ids.push(authority.admitted_document_ids[0]); },
      authority => { authority.workflow_roles.push("candidate"); },
      authority => { authority.trial_count -= 1; },
      authority => { authority.attempt_slot_count -= 1; },
      authority => { authority.trials.pop(); },
      authority => { authority.trials[1].attempt_ids[0] = authority.trials[0].attempt_ids[0]; },
      authority => { authority.trials[0].document_id = manifest.documents[1].id; },
      authority => { authority.trials[0].workflow_role = "candidate"; },
      authority => { authority.replacement_policy = "replace-failures"; },
      authority => { authority.candidate_product_identity = syntheticCandidateIdentity(); },
    ]) {
      const mutated = structuredClone(comparisonAuthority);
      mutate(mutated);
      expect(() => validateComparisonAuthority({ manifest, comparisonAuthority: mutated })).toThrow();
    }
    expect(() => verifyReceipt(receipts.slice(1))).toThrow(/every frozen attempt slot/);
    const duplicated = structuredClone(receipts);
    duplicated[duplicated.length - 1] = structuredClone(duplicated[0]);
    expect(() => verifyReceipt(duplicated)).toThrow(/Duplicate campaign attempt receipt/);
    for (const mutate of [
      receipt => { receipt.document_id = manifest.documents[1].id; },
      receipt => { receipt.attempt_id = "unplanned-attempt-id"; },
      receipt => { receipt.role_authority_sha256 = "d".repeat(64); },
      receipt => { receipt.comparison_authority_sha256 = "e".repeat(64); },
    ]) {
      const substituted = structuredClone(receipts);
      mutate(substituted[0]);
      expect(() => verifyReceipt(substituted)).toThrow();
    }
    const firstTrial = comparisonAuthority.trials[0];
    const firstDocument = manifest.documents.find(document => document.id === firstTrial.document_id);
    const firstLoaded = await loadDocument(firstDocument);
    const retryCandidate = runRecordFor({
      manifest, comparisonAuthority, candidateExecutionAuthority, document: firstDocument,
      workflowRole: firstTrial.workflow_role, result: firstLoaded.truth,
      citationOracle: firstLoaded.citationOracle, attemptIndex: 2,
    });
    const replacement = structuredClone(receipts);
    replacement[replacement.findIndex(receipt => receipt.attempt_id === firstTrial.attempt_ids[1])]
      = productReceiptFor(retryCandidate, firstTrial, comparisonAuthority, candidateExecutionAuthority);
    expect(() => verifyReceipt(replacement)).toThrow(/replacement product result/);
    const omittedPrimary = structuredClone(receipts);
    omittedPrimary[omittedPrimary.findIndex(receipt => receipt.attempt_id === firstTrial.attempt_ids[0])]
      = attemptReceiptFor(firstTrial, comparisonAuthority, candidateExecutionAuthority, 1, "not_run", { reason: "retry_not_used" });
    expect(() => verifyReceipt(omittedPrimary)).toThrow(/Primary campaign attempt cannot be omitted/);
  }, 30000);

  it("retains product and harness failures in the frozen aggregate denominator", async () => {
    const { manifest } = await verifyVerifiedExtractionContract({ benchmarkRoot: BENCHMARK_ROOT, repoRoot: REPO_ROOT });
    const comparisonAuthority = comparisonAuthorityFor(manifest);
    const candidateExecutionAuthority = candidateExecutionAuthorityFor(manifest, comparisonAuthority);
    const { receipts, documentContexts } = await successfulCampaignState(
      manifest, comparisonAuthority, candidateExecutionAuthority,
    );
    const firstTrial = comparisonAuthority.trials[0];
    receipts[receipts.findIndex(receipt => receipt.attempt_id === firstTrial.attempt_ids[0])]
      = attemptReceiptFor(firstTrial, comparisonAuthority, candidateExecutionAuthority, 1, "harness_failure", harnessFailureOutcome());
    receipts[receipts.findIndex(receipt => receipt.attempt_id === firstTrial.attempt_ids[1])]
      = attemptReceiptFor(firstTrial, comparisonAuthority, candidateExecutionAuthority, 2, "not_run", { reason: "retry_not_used" });
    const secondTrial = comparisonAuthority.trials[1];
    const secondProductIndex = receipts.findIndex(receipt => receipt.attempt_id === secondTrial.attempt_ids[0]);
    delete receipts[secondProductIndex].outcome.candidate.result.account.status;
    receipts[secondProductIndex].outcome.candidate_sha256 = sha256(Buffer.from(canonicalJson(
      receipts[secondProductIndex].outcome.candidate,
    )));
    const aggregate = verifyVerifiedExtractionCampaignReceipt({
      manifest, comparisonAuthority, candidateExecutionAuthority, documentContexts, attemptReceipts: receipts,
    });
    expect(aggregate).toMatchObject({
      planned_trials: 6,
      product_success_trials: 4,
      product_failure_trials: 1,
      harness_failure_trials: 1,
      harness_failure_attempts: 1,
      deterministic_denominators: {
        documents: 6,
        leaf_values: 194,
        citation_obligations: 86,
        keyed_array_items: 54,
        calculations: 2,
      },
      deterministic_numerators: {
        schema_valid_documents: 4,
        leaf_values: 180,
        citation_obligations: 73,
        keyed_array_items: 54,
        calculations: 2,
      },
    });
  }, 30000);

  it("rejects impossible dates, uses null zero-denominator rates, and rejects retained-byte tampering", async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(BENCHMARK_ROOT, "manifest.v1.json"), "utf8"));
    const comparisonAuthority = comparisonAuthorityFor(manifest);
    const candidateExecutionAuthority = candidateExecutionAuthorityFor(manifest, comparisonAuthority);
    const document = manifest.documents[0];
    const { schema, truth, citationOracle } = await loadDocument(document);
    const result = structuredClone(truth);
    result.reporting.period_start = "2026-99-99";
    const score = scoreVerifiedExtractionCandidate({
      manifest, workflowRole: "candidate", comparisonAuthority, candidateExecutionAuthority,
      document, schema, truth, citationOracle,
      candidate: runRecordFor({
        manifest, comparisonAuthority, candidateExecutionAuthority, document,
        workflowRole: "candidate", result, citationOracle,
      }),
    });
    expect(score.json_schema_valid).toBe(false);
    expect(score.calculation_replay_rate).toEqual({ numerator: 0, denominator: 0, rate: null });
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "verified-extraction-contract-"));
    try {
      await fs.cp(BENCHMARK_ROOT, temporaryRoot, { recursive: true });
      const copiedManifest = JSON.parse(await fs.readFile(path.join(temporaryRoot, "manifest.v1.json"), "utf8"));
      await fs.appendFile(path.join(temporaryRoot, copiedManifest.documents[0].artifacts.truth.path), " ");
      await expect(verifyVerifiedExtractionContract({ benchmarkRoot: temporaryRoot, repoRoot: REPO_ROOT }))
        .rejects.toThrow(/Artifact binding mismatch/);
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
