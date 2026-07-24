import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadComparisonManifest } from "./comparison-manifest.js";
import {
  assertComparisonBenchmarkBinding,
  assertComparisonManifestBinding,
  assertFrozenComparisonReferenceScore,
  loadComparisonReferenceRenderer,
  requireComparisonReportHostLabel,
} from "./comparison-reference-renderer.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "comparison",
  "manifest.v1.json",
);

function frozenScore() {
  return {
    valid: true,
    aggregate: {
      event_metrics: { tp: 9, fp: 0, fn: 0 },
      evidence_metrics: {
        expected_anchors: 27,
        matched_anchors: 27,
        two_sided_facets: 13,
        two_sided_complete: 13,
      },
      pairs_passed: 7,
      pairs_total: 7,
    },
  };
}

describe("comparison reference-renderer admission", () => {
  it("binds the exact benchmark identity and immutable manifest bytes", async () => {
    const manifest = await loadComparisonManifest(MANIFEST_PATH);
    const reference = await loadComparisonReferenceRenderer();
    expect(() => assertComparisonBenchmarkBinding(manifest, reference)).not.toThrow();
    await expect(assertComparisonManifestBinding(MANIFEST_PATH, reference))
      .resolves.toBe(reference.corpus_manifest_sha256);
  });

  it("requires the complete frozen score before canonical evidence can be written", () => {
    const exact = frozenScore();
    expect(() => assertFrozenComparisonReferenceScore(exact)).not.toThrow();
    const missingAnchor = structuredClone(exact);
    missingAnchor.aggregate.evidence_metrics.matched_anchors -= 1;
    expect(() => assertFrozenComparisonReferenceScore(missingAnchor)).toThrow(/complete frozen/);
    const failedPair = structuredClone(exact);
    failedPair.aggregate.pairs_passed -= 1;
    expect(() => assertFrozenComparisonReferenceScore(failedPair)).toThrow(/complete frozen/);
    const falsePositive = structuredClone(exact);
    falsePositive.aggregate.event_metrics.fp = 1;
    expect(() => assertFrozenComparisonReferenceScore(falsePositive)).toThrow(/complete frozen/);
  });

  it("requires an explicit public-safe host label instead of inventing physical provenance", () => {
    expect(requireComparisonReportHostLabel({
      PDF_TOOLS_COMPARISON_HOST_LABEL: "reviewed-reference-host",
    })).toBe("reviewed-reference-host");
    expect(() => requireComparisonReportHostLabel({})).toThrow(/explicit public-safe/);
    expect(() => requireComparisonReportHostLabel({
      PDF_TOOLS_COMPARISON_HOST_LABEL: "M-MacBook-Pro.local",
    })).toThrow(/explicit public-safe/);
  });
});
