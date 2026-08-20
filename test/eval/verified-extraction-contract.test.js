import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  scoreVerifiedExtractionCandidate,
  verifyVerifiedExtractionContract,
} from "./verified-extraction-contract.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BENCHMARK_ROOT = path.join(REPO_ROOT, "test", "fixtures", "eval", "verified-extraction");

async function loadDocument(document) {
  const readJson = role => fs.readFile(path.join(BENCHMARK_ROOT, document.artifacts[role].path), "utf8").then(JSON.parse);
  const [schema, truth, citationOracle] = await Promise.all([readJson("schema"), readJson("truth"), readJson("citations")]);
  return { schema, truth, citationOracle };
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
      const score = scoreVerifiedExtractionCandidate({
        document,
        schema,
        truth,
        citationOracle,
        candidate: {
          document_id: document.id,
          source_sha256: document.artifacts.pdf.sha256,
          schema_sha256: document.artifacts.schema.sha256,
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
  }, 30000);

  it("fails closed for wrong bindings, silent omissions, citation drift, and truncation", async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(BENCHMARK_ROOT, "manifest.v1.json"), "utf8"));
    const document = manifest.documents[0];
    const { schema, truth, citationOracle } = await loadDocument(document);
    const base = {
      document_id: document.id,
      source_sha256: document.artifacts.pdf.sha256,
      schema_sha256: document.artifacts.schema.sha256,
      result: structuredClone(truth),
      citations: structuredClone(citationOracle.citations),
      uncertainties: [],
      completion: { complete: true, processed_pages: document.page_count, omitted_paths: [] },
    };
    await expect(Promise.resolve().then(() => scoreVerifiedExtractionCandidate({
      document, schema, truth, citationOracle, candidate: { ...base, source_sha256: "0".repeat(64) },
    }))).rejects.toThrow(/binding mismatch/);
    delete base.result.account.status;
    base.citations["account.id"].quote = "near enough is not replay";
    base.completion.processed_pages -= 1;
    const score = scoreVerifiedExtractionCandidate({ document, schema, truth, citationOracle, candidate: base });
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
    const result = structuredClone(truth);
    result.account.unrequested_note = "extra";
    const score = scoreVerifiedExtractionCandidate({
      document,
      schema,
      truth,
      citationOracle,
      candidate: {
        document_id: document.id,
        source_sha256: document.artifacts.pdf.sha256,
        schema_sha256: document.artifacts.schema.sha256,
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
