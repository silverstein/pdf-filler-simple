import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadComparisonManifest, resolveComparisonDocumentPath } from "./comparison-manifest.js";
import { buildProductPrimitiveReport } from "./comparison-product-baseline.js";
import { buildControllerObservationRegistry } from "./comparison-observation-registry.js";
import { scoreComparisonReport, validateComparisonReport } from "./comparison-scorer.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "comparison", "manifest.v1.json");

describe("current PDF Tools compare_pdfs baseline", () => {
  it("records the seven-channel product contract without promoting calibration to a benchmark claim", async () => {
    const manifest = await loadComparisonManifest(MANIFEST_PATH);
    const documents = new Map(manifest.documents.map(document => [document.id, document]));
    const report = await buildProductPrimitiveReport({
      benchmarkId: manifest.benchmark_id,
      benchmarkVersion: manifest.benchmark_version,
      renderer: manifest.canonical_renderer,
      repositoryRoot: REPO_ROOT,
      host: "local-test-host-stdio",
      pairs: manifest.pairs.map(pair => ({
        pairId: pair.id,
        beforePath: resolveComparisonDocumentPath(MANIFEST_PATH, documents.get(pair.before_document_id)),
        afterPath: resolveComparisonDocumentPath(MANIFEST_PATH, documents.get(pair.after_document_id)),
        beforeSha256: documents.get(pair.before_document_id).sha256,
        afterSha256: documents.get(pair.after_document_id).sha256,
      })),
    });
    expect(validateComparisonReport(manifest, report)).toEqual([]);
    const scored = scoreComparisonReport(manifest, report, buildControllerObservationRegistry(report));
    expect(scored.valid).toBe(true);
    expect(scored.passed).toBe(false);
    expect(scored.aggregate.pairs_total).toBe(7);
    for (const channel of ["semantic", "text", "structure", "form_field", "annotation", "metadata"]) {
      expect(scored.aggregate.channel_metrics[channel].f1, channel).toBe(1);
    }
    expect(report.pairs.every(pair => Object.values(pair.channel_status)
      .every(status => status === "supported"))).toBe(true);
    expect(report.pairs.every(pair => pair.tool_calls === 6)).toBe(true);
    expect(report.pairs.every(pair => pair.iteration_costs.length === 5)).toBe(true);
    expect(report.pairs.every(pair => pair.peak_rss_bytes === null
      && pair.resource_measurement_status === "unavailable")).toBe(true);
    expect(report.engine.provenance).toContain("compare_pdfs output gated");
    expect(report.engine.network_requests).toBe(0);
    expect(report.benchmark_claim_ready).toBe(false);
    expect(report.platform.host).toBe("local-test-host-stdio");
  }, 120_000);
});
