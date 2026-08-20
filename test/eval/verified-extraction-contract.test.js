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
      for (const workflowRole of ["baseline", "candidate"]) {
        const runPlan = runPlanFor(manifest, document, workflowRole);
        const score = scoreVerifiedExtractionCandidate({
          manifest,
          workflowRole,
          runPlan,
          document,
          schema,
          truth,
          citationOracle,
          candidate: {
            document_id: document.id,
            source_sha256: document.artifacts.pdf.sha256,
            schema_sha256: document.artifacts.schema.sha256,
            execution_binding_sha256: executionBinding(runPlan),
            result: truth,
            citations: citationOracle.citations,
            uncertainties: [],
            completion: { complete: true, processed_pages: document.page_count, omitted_paths: [] },
          },
        });
        expect(score.deterministic_failure).toBe(false);
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
    const runPlan = runPlanFor(manifest, document);
    const base = {
      document_id: document.id,
      source_sha256: document.artifacts.pdf.sha256,
      schema_sha256: document.artifacts.schema.sha256,
      execution_binding_sha256: executionBinding(runPlan),
      result: structuredClone(truth),
      citations: structuredClone(citationOracle.citations),
      uncertainties: [],
      completion: { complete: true, processed_pages: document.page_count, omitted_paths: [] },
    };
    await expect(Promise.resolve().then(() => scoreVerifiedExtractionCandidate({
      manifest, workflowRole: "candidate", runPlan, document, schema, truth, citationOracle,
      candidate: { ...base, source_sha256: "0".repeat(64) },
    }))).rejects.toThrow(/binding mismatch/);
    delete base.result.account.status;
    base.citations["account.id"].quote = "near enough is not replay";
    base.completion.processed_pages -= 1;
    const score = scoreVerifiedExtractionCandidate({ manifest, workflowRole: "candidate", runPlan, document, schema, truth, citationOracle, candidate: base });
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
    const runPlan = runPlanFor(manifest, document);
    const result = structuredClone(truth);
    result.account.unrequested_note = "extra";
    const score = scoreVerifiedExtractionCandidate({
      manifest,
      workflowRole: "candidate",
      runPlan,
      document,
      schema,
      truth,
      citationOracle,
      candidate: {
        document_id: document.id,
        source_sha256: document.artifacts.pdf.sha256,
        schema_sha256: document.artifacts.schema.sha256,
        execution_binding_sha256: executionBinding(runPlan),
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
    const runPlan = runPlanFor(manifest, document);
    const candidate = {
      document_id: document.id,
      source_sha256: document.artifacts.pdf.sha256,
      schema_sha256: document.artifacts.schema.sha256,
      execution_binding_sha256: executionBinding(runPlan),
      result: truth,
      citations: { ...citationOracle.citations, fabricated: { page: 1, quote: "not present anywhere" } },
      uncertainties: [],
      completion: { complete: true, processed_pages: document.page_count, omitted_paths: [] },
    };
    const score = scoreVerifiedExtractionCandidate({
      manifest, workflowRole: "candidate", runPlan, document, schema, truth, citationOracle, candidate,
    });
    expect(score.extra_citation_count).toBe(1);
    expect(score.deterministic_failure).toBe(true);
    await expect(Promise.resolve().then(() => scoreVerifiedExtractionCandidate({
      manifest,
      workflowRole: "candidate",
      runPlan,
      document,
      schema,
      truth,
      citationOracle,
      candidate: { ...candidate, execution_binding_sha256: undefined },
    }))).rejects.toThrow(/execution binding mismatch/);
  });

  it("requires every frozen workflow, scorer, model, host, settings, and budget binding", async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(BENCHMARK_ROOT, "manifest.v1.json"), "utf8"));
    const document = manifest.documents[0];
    const { schema, truth, citationOracle } = await loadDocument(document);
    const original = runPlanFor(manifest, document);
    const candidateFor = runPlan => ({
      document_id: document.id,
      source_sha256: document.artifacts.pdf.sha256,
      schema_sha256: document.artifacts.schema.sha256,
      execution_binding_sha256: executionBinding(runPlan),
      result: truth,
      citations: citationOracle.citations,
      uncertainties: [],
      completion: { complete: true, processed_pages: document.page_count, omitted_paths: [] },
    });
    const mutants = [
      plan => { delete plan.workflow_protocol_sha256; },
      plan => { delete plan.scorer_sha256; },
      plan => { delete plan.model.version; },
      plan => { delete plan.host.runtime; },
      plan => { plan.settings_sha256 = "0".repeat(64); },
      plan => { plan.time_budget_ms = 0; },
      plan => { plan.retry_budget = -1; },
    ];
    for (const mutate of mutants) {
      const runPlan = structuredClone(original);
      mutate(runPlan);
      expect(() => scoreVerifiedExtractionCandidate({
        manifest,
        workflowRole: "candidate",
        runPlan,
        document,
        schema,
        truth,
        citationOracle,
        candidate: candidateFor(runPlan),
      })).toThrow();
    }
  });

  it("rejects impossible calendar dates and reports zero-denominator rates as not applicable", async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(BENCHMARK_ROOT, "manifest.v1.json"), "utf8"));
    const document = manifest.documents[0];
    const { schema, truth, citationOracle } = await loadDocument(document);
    const runPlan = runPlanFor(manifest, document);
    const result = structuredClone(truth);
    result.reporting.period_start = "2026-99-99";
    const score = scoreVerifiedExtractionCandidate({
      manifest,
      workflowRole: "candidate",
      runPlan,
      document,
      schema,
      truth,
      citationOracle,
      candidate: {
        document_id: document.id,
        source_sha256: document.artifacts.pdf.sha256,
        schema_sha256: document.artifacts.schema.sha256,
        execution_binding_sha256: executionBinding(runPlan),
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
