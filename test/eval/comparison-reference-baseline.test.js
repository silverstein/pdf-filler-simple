import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadComparisonManifest, resolveComparisonDocumentPath } from "./comparison-manifest.js";
import { buildSharedLibraryReferenceReport } from "./comparison-reference-baseline.js";
import { buildControllerObservationRegistry } from "./comparison-observation-registry.js";
import { scoreComparisonReport, validateComparisonReport } from "./comparison-scorer.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "comparison", "manifest.v1.json");

describe("truth-blind shared-library comparison reference", () => {
  it("derives all seven pair reports without receiving roles or expected events", async () => {
    const manifest = await loadComparisonManifest(MANIFEST_PATH);
    const documents = new Map(manifest.documents.map(document => [document.id, document]));
    const report = await buildSharedLibraryReferenceReport({
      benchmarkId: manifest.benchmark_id,
      benchmarkVersion: manifest.benchmark_version,
      renderer: manifest.canonical_renderer,
      pairs: manifest.pairs.map(pair => ({
        pairId: pair.id,
        beforePath: resolveComparisonDocumentPath(MANIFEST_PATH, documents.get(pair.before_document_id)),
        afterPath: resolveComparisonDocumentPath(MANIFEST_PATH, documents.get(pair.after_document_id)),
        beforeSha256: documents.get(pair.before_document_id).sha256,
        afterSha256: documents.get(pair.after_document_id).sha256,
      })),
    });
    expect(validateComparisonReport(manifest, report)).toEqual([]);
    const registry = buildControllerObservationRegistry(report);
    const scored = scoreComparisonReport(manifest, report, registry);
    expect(scored.valid).toBe(true);
    expect(scored.passed).toBe(false);
    expect(scored.aggregate.isolation_passed).toBe(false);
    expect(scored.aggregate).toMatchObject({
      event_metrics: { tp: 9, fp: 0, fn: 0, precision: 1, recall: 1, f1: 1 },
      evidence_metrics: { completeness: 1, two_sided_citation_rate: 1 },
      pairs_passed: 7,
      pairs_total: 7,
    });
    expect(report.benchmark_claim_ready).toBe(false);
    expect(report.claim_boundary).toContain("not independent confirmation");
    expect(report.pairs.every(pair => pair.tool_calls === 0
      && pair.logical_input_bytes === pair.warmup_cost.logical_input_bytes * 6
      && pair.rendered_pixels === pair.warmup_cost.rendered_pixels * 6)).toBe(true);
  }, 60_000);
});
