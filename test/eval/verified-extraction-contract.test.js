import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  scoreVerifiedExtractionCandidate,
  sha256,
  verifyVerifiedExtractionContract,
} from "./verified-extraction-contract.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BENCHMARK_ROOT = path.join(REPO_ROOT, "test", "fixtures", "eval", "verified-extraction");

async function loadDocument(document) {
  const readJson = role => fs.readFile(path.join(BENCHMARK_ROOT, document.artifacts[role].path), "utf8").then(JSON.parse);
  const [schema, truth, citationOracle] = await Promise.all([readJson("schema"), readJson("truth"), readJson("citations")]);
  return { schema, truth, citationOracle };
}

function runPlanFor(manifest, document, workflowRole = "candidate") {
  const settings = { temperature: 0, max_output_tokens: 4096 };
  return {
    plan_version: 1,
    plan_id: `synthetic-${workflowRole}-${document.id}`,
    workflow_role: workflowRole,
    document_id: document.id,
    source_sha256: document.artifacts.pdf.sha256,
    schema_sha256: document.artifacts.schema.sha256,
    workflow_protocol_id: manifest.protocols[workflowRole].value.id,
    workflow_protocol_sha256: manifest.protocols[workflowRole].sha256,
    scorer_sha256: manifest.scorer.sha256,
    model: { provider: "host-managed-test", id: "synthetic-model", version: "fixture-v1" },
    host: { id: "synthetic-host", platform: "test", architecture: "test", runtime: "node-test" },
    settings,
    settings_sha256: sha256(Buffer.from(canonicalJson(settings))),
    time_budget_ms: 120000,
    retry_budget: 1,
  };
}

function executionBinding(runPlan) {
  return sha256(Buffer.from(canonicalJson(runPlan)));
}

function pairedAuthorityFor(manifest, document) {
  const plans = {
    baseline: runPlanFor(manifest, document, "baseline"),
    candidate: runPlanFor(manifest, document, "candidate"),
  };
  return {
    authority_version: 1,
    benchmark_id: manifest.benchmark_id,
    pair_id: `synthetic-pair-${document.id}`,
    admission_class: "synthetic_scorer_calibration",
    authorized_at: "2026-08-20T12:00:00.000Z",
    plans,
    plan_sha256: {
      baseline: executionBinding(plans.baseline),
      candidate: executionBinding(plans.candidate),
    },
  };
}

function pairAuthorityBinding(authority) {
  return sha256(Buffer.from(canonicalJson(authority)));
}

function executionChronology() {
  return { started_at: "2026-08-20T12:01:00.000Z", completed_at: "2026-08-20T12:02:00.000Z" };
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
  }, 30000);

  it("gives a perfect deterministic score only to a complete exact replay", async () => {
    const { manifest } = await verifyVerifiedExtractionContract({ benchmarkRoot: BENCHMARK_ROOT, repoRoot: REPO_ROOT });
    for (const document of manifest.documents) {
      const { schema, truth, citationOracle } = await loadDocument(document);
      const pairedRunAuthority = pairedAuthorityFor(manifest, document);
      for (const workflowRole of ["baseline", "candidate"]) {
        const score = scoreVerifiedExtractionCandidate({
          manifest,
          workflowRole,
          pairedRunAuthority,
          document,
          schema,
          truth,
          citationOracle,
          candidate: {
            document_id: document.id,
            source_sha256: document.artifacts.pdf.sha256,
            schema_sha256: document.artifacts.schema.sha256,
            pair_authority_sha256: pairAuthorityBinding(pairedRunAuthority),
            execution_binding_sha256: pairedRunAuthority.plan_sha256[workflowRole],
            execution: executionChronology(),
            result: truth,
            citations: citationOracle.citations,
            uncertainties: [],
            completion: { complete: true, processed_pages: document.page_count, omitted_paths: [] },
          },
        });
        expect(score.deterministic_failure).toBe(false);
        expect(score.claim_eligible).toBe(false);
        expect(score.leaf_recall.rate).toBe(1);
        expect(score.citation_replay_rate.rate).toBe(1);
        expect(score.truncation_count).toBe(0);
      }
    }
  }, 30000);

  it("fails closed for wrong bindings, silent omissions, citation drift, and truncation", async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(BENCHMARK_ROOT, "manifest.v1.json"), "utf8"));
    const document = manifest.documents[0];
    const { schema, truth, citationOracle } = await loadDocument(document);
    const pairedRunAuthority = pairedAuthorityFor(manifest, document);
    const base = {
      document_id: document.id,
      source_sha256: document.artifacts.pdf.sha256,
      schema_sha256: document.artifacts.schema.sha256,
      pair_authority_sha256: pairAuthorityBinding(pairedRunAuthority),
      execution_binding_sha256: pairedRunAuthority.plan_sha256.candidate,
      execution: executionChronology(),
      result: structuredClone(truth),
      citations: structuredClone(citationOracle.citations),
      uncertainties: [],
      completion: { complete: true, processed_pages: document.page_count, omitted_paths: [] },
    };
    await expect(Promise.resolve().then(() => scoreVerifiedExtractionCandidate({
      manifest, workflowRole: "candidate", pairedRunAuthority, document, schema, truth, citationOracle,
      candidate: { ...base, source_sha256: "0".repeat(64) },
    }))).rejects.toThrow(/binding mismatch/);
    delete base.result.account.status;
    base.citations["account.id"].quote = "near enough is not replay";
    base.completion.processed_pages -= 1;
    const score = scoreVerifiedExtractionCandidate({ manifest, workflowRole: "candidate", pairedRunAuthority, document, schema, truth, citationOracle, candidate: base });
    expect(score).toMatchObject({
      json_schema_valid: false,
      silent_omission_count: 1,
      truncation_count: 1,
      deterministic_failure: true,
    });
    expect(score.citation_replay_rate.numerator).toBe(score.citation_replay_rate.denominator - 1);
  });

  it("counts extra submitted leaves against precision and fails the primary gate", async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(BENCHMARK_ROOT, "manifest.v1.json"), "utf8"));
    const document = manifest.documents[0];
    const { schema, truth, citationOracle } = await loadDocument(document);
    const pairedRunAuthority = pairedAuthorityFor(manifest, document);
    const result = structuredClone(truth);
    result.account.unrequested_note = "extra";
    const score = scoreVerifiedExtractionCandidate({
      manifest,
      workflowRole: "candidate",
      pairedRunAuthority,
      document,
      schema,
      truth,
      citationOracle,
      candidate: {
        document_id: document.id,
        source_sha256: document.artifacts.pdf.sha256,
        schema_sha256: document.artifacts.schema.sha256,
        pair_authority_sha256: pairAuthorityBinding(pairedRunAuthority),
        execution_binding_sha256: pairedRunAuthority.plan_sha256.candidate,
        execution: executionChronology(),
        result,
        citations: citationOracle.citations,
        uncertainties: [],
        completion: { complete: true, processed_pages: document.page_count, omitted_paths: [] },
      },
    });
    expect(score.leaf_recall.rate).toBe(1);
    expect(score.leaf_precision.rate).toBeLessThan(1);
    expect(score.deterministic_failure).toBe(true);
  });

  it("rejects unidentified execution and fails extra fabricated citations", async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(BENCHMARK_ROOT, "manifest.v1.json"), "utf8"));
    const document = manifest.documents[0];
    const { schema, truth, citationOracle } = await loadDocument(document);
    const pairedRunAuthority = pairedAuthorityFor(manifest, document);
    const candidate = {
      document_id: document.id,
      source_sha256: document.artifacts.pdf.sha256,
      schema_sha256: document.artifacts.schema.sha256,
      pair_authority_sha256: pairAuthorityBinding(pairedRunAuthority),
      execution_binding_sha256: pairedRunAuthority.plan_sha256.candidate,
      execution: executionChronology(),
      result: truth,
      citations: { ...citationOracle.citations, fabricated: { page: 1, quote: "not present anywhere" } },
      uncertainties: [],
      completion: { complete: true, processed_pages: document.page_count, omitted_paths: [] },
    };
    const score = scoreVerifiedExtractionCandidate({
      manifest, workflowRole: "candidate", pairedRunAuthority, document, schema, truth, citationOracle, candidate,
    });
    expect(score.extra_citation_count).toBe(1);
    expect(score.deterministic_failure).toBe(true);
    await expect(Promise.resolve().then(() => scoreVerifiedExtractionCandidate({
      manifest,
      workflowRole: "candidate",
      pairedRunAuthority,
      document,
      schema,
      truth,
      citationOracle,
      candidate: { ...candidate, execution_binding_sha256: undefined },
    }))).rejects.toThrow(/execution binding mismatch/);
    const nestedEvidence = structuredClone(candidate);
    delete nestedEvidence.citations.fabricated;
    nestedEvidence.citations["account.id"].alternate = { page: 1, quote: "not present anywhere" };
    const nestedScore = scoreVerifiedExtractionCandidate({
      manifest, workflowRole: "candidate", pairedRunAuthority, document, schema, truth, citationOracle, candidate: nestedEvidence,
    });
    expect(nestedScore.citation_replay_rate.numerator).toBe(nestedScore.citation_replay_rate.denominator - 1);
    expect(nestedScore.deterministic_failure).toBe(true);
  });

  it("requires every frozen workflow, scorer, model, host, settings, and budget binding", async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(BENCHMARK_ROOT, "manifest.v1.json"), "utf8"));
    const document = manifest.documents[0];
    const { schema, truth, citationOracle } = await loadDocument(document);
    const original = pairedAuthorityFor(manifest, document);
    const candidateFor = pairedRunAuthority => ({
      document_id: document.id,
      source_sha256: document.artifacts.pdf.sha256,
      schema_sha256: document.artifacts.schema.sha256,
      pair_authority_sha256: pairAuthorityBinding(pairedRunAuthority),
      execution_binding_sha256: pairedRunAuthority.plan_sha256.candidate,
      execution: executionChronology(),
      result: truth,
      citations: citationOracle.citations,
      uncertainties: [],
      completion: { complete: true, processed_pages: document.page_count, omitted_paths: [] },
    });
    const mutants = [
      authority => { delete authority.plans.candidate.workflow_protocol_sha256; },
      authority => { delete authority.plans.candidate.scorer_sha256; },
      authority => { delete authority.plans.candidate.model.version; },
      authority => { delete authority.plans.candidate.host.runtime; },
      authority => { authority.plans.candidate.settings_sha256 = "0".repeat(64); },
      authority => { authority.plans.candidate.time_budget_ms = 0; },
      authority => { authority.plans.candidate.retry_budget = -1; },
      authority => { authority.plans.candidate.model.provider = "different-provider"; },
      authority => { authority.plans.candidate.model.version = "different-version"; },
      authority => { authority.plans.candidate.host.id = "different-host"; },
      authority => {
        authority.plans.candidate.settings.temperature = 1;
        authority.plans.candidate.settings_sha256 = sha256(Buffer.from(canonicalJson(authority.plans.candidate.settings)));
      },
      authority => { authority.plans.candidate.time_budget_ms += 1; },
      authority => { authority.plans.candidate.retry_budget += 1; },
    ];
    for (const mutate of mutants) {
      const pairedRunAuthority = structuredClone(original);
      mutate(pairedRunAuthority);
      pairedRunAuthority.plan_sha256.candidate = executionBinding(pairedRunAuthority.plans.candidate);
      expect(() => scoreVerifiedExtractionCandidate({
        manifest,
        workflowRole: "candidate",
        pairedRunAuthority,
        document,
        schema,
        truth,
        citationOracle,
        candidate: candidateFor(pairedRunAuthority),
      })).toThrow();
    }
    const measuredAuthority = structuredClone(original);
    measuredAuthority.admission_class = "measured";
    expect(() => scoreVerifiedExtractionCandidate({
      manifest,
      workflowRole: "candidate",
      pairedRunAuthority: measuredAuthority,
      document,
      schema,
      truth,
      citationOracle,
      candidate: candidateFor(measuredAuthority),
    })).toThrow(/No measured paired run is authorized/);
    const chronologyCandidate = candidateFor(original);
    chronologyCandidate.execution.started_at = original.authorized_at;
    expect(() => scoreVerifiedExtractionCandidate({
      manifest,
      workflowRole: "candidate",
      pairedRunAuthority: original,
      document,
      schema,
      truth,
      citationOracle,
      candidate: chronologyCandidate,
    })).toThrow(/chronology/);
  });

  it("rejects impossible calendar dates and reports zero-denominator rates as not applicable", async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(BENCHMARK_ROOT, "manifest.v1.json"), "utf8"));
    const document = manifest.documents[0];
    const { schema, truth, citationOracle } = await loadDocument(document);
    const pairedRunAuthority = pairedAuthorityFor(manifest, document);
    const result = structuredClone(truth);
    result.reporting.period_start = "2026-99-99";
    const score = scoreVerifiedExtractionCandidate({
      manifest,
      workflowRole: "candidate",
      pairedRunAuthority,
      document,
      schema,
      truth,
      citationOracle,
      candidate: {
        document_id: document.id,
        source_sha256: document.artifacts.pdf.sha256,
        schema_sha256: document.artifacts.schema.sha256,
        pair_authority_sha256: pairAuthorityBinding(pairedRunAuthority),
        execution_binding_sha256: pairedRunAuthority.plan_sha256.candidate,
        execution: executionChronology(),
        result,
        citations: citationOracle.citations,
        uncertainties: [],
        completion: { complete: true, processed_pages: document.page_count, omitted_paths: [] },
      },
    });
    expect(score.json_schema_valid).toBe(false);
    expect(score.calculation_replay_rate).toEqual({ numerator: 0, denominator: 0, rate: null });
    expect(score.deterministic_failure).toBe(true);
  });

  it("rejects retained-byte tampering before oracle use", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "verified-extraction-contract-"));
    try {
      await fs.cp(BENCHMARK_ROOT, temporaryRoot, { recursive: true });
      const manifestPath = path.join(temporaryRoot, "manifest.v1.json");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      const target = path.join(temporaryRoot, manifest.documents[0].artifacts.truth.path);
      await fs.appendFile(target, " ");
      await expect(verifyVerifiedExtractionContract({ benchmarkRoot: temporaryRoot, repoRoot: REPO_ROOT })).rejects.toThrow(/Artifact binding mismatch/);
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
