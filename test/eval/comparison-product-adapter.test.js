import { describe, expect, it } from "vitest";
import { COMPARISON_CHANNELS } from "./comparison-manifest.js";
import { assertProductMatchesCanonicalAdapter } from "./comparison-product-baseline.js";

const BEFORE = "a".repeat(64);
const AFTER = "b".repeat(64);

function fixture() {
  const coverage = Object.fromEntries(COMPARISON_CHANNELS.map(channel => [
    channel,
    { status: "supported", reason_codes: [] },
  ]));
  const product = {
    status: "complete",
    before_source: { sha256: BEFORE },
    after_source: { sha256: AFTER },
    source_immutability: { before: { unchanged: true }, after: { unchanged: true } },
    coverage,
    page_alignments: [{ before_page: 1, after_page: 1, relation: "same" }],
    observations: [{
      id: "product.before",
      channel: "text",
      document_sha256: BEFORE,
      page: 1,
      page_box: [0, 0, 612, 792],
      rotation: 0,
      display_region: [72, 100, 100, 14],
      value_sha256: "c".repeat(64),
    }, {
      id: "product.after",
      channel: "text",
      document_sha256: AFTER,
      page: 1,
      page_box: [0, 0, 612, 792],
      rotation: 0,
      display_region: [72, 102, 100, 14],
      value_sha256: "d".repeat(64),
    }],
    changes: [{
      salience: "material",
      facets: [{
        channel: "text",
        operation: "modified",
        before_evidence_id: "product.before",
        after_evidence_id: "product.after",
      }],
      presentation: { disposition: "report" },
    }],
  };
  const canonical = {
    before_sha256: BEFORE,
    after_sha256: AFTER,
    channel_status: Object.fromEntries(COMPARISON_CHANNELS.map(channel => [channel, "supported"])),
    alignments: [{ before_page: 1, after_page: 1, relation: "same", anchor: "opaque" }],
    observations: [{
      id: "canonical.before",
      channel: "text",
      document_sha256: BEFORE,
      page: 1,
      page_box: [0, 0, 612, 792],
      rotation: 0,
      region: [72, 101, 100, 14],
      value_sha256: "c".repeat(64),
    }, {
      id: "canonical.after",
      channel: "text",
      document_sha256: AFTER,
      page: 1,
      page_box: [0, 0, 612, 792],
      rotation: 0,
      region: [72, 101, 100, 14],
      value_sha256: "d".repeat(64),
    }],
    detected_events: [{
      id: "candidate.reference.1",
      salience: "material",
      facets: [{
        channel: "text",
        operation: "modified",
        before_evidence_id: "canonical.before",
        after_evidence_id: "canonical.after",
      }],
    }],
    presentation_decisions: [{
      event_id: "candidate.reference.1",
      disposition: "report",
    }],
  };
  return { product, canonical };
}

describe("frozen-v1 compare_pdfs adapter", () => {
  it("requires exact nonvisual values and overlapping direct product regions", () => {
    const { product, canonical } = fixture();
    expect(() => assertProductMatchesCanonicalAdapter(product, canonical)).not.toThrow();

    const wrongValue = structuredClone(product);
    wrongValue.observations[0].value_sha256 = "e".repeat(64);
    expect(() => assertProductMatchesCanonicalAdapter(wrongValue, canonical)).toThrow(/canonical event/);

    const wrongRegion = structuredClone(product);
    wrongRegion.observations[0].display_region = [400, 400, 10, 10];
    expect(() => assertProductMatchesCanonicalAdapter(wrongRegion, canonical)).toThrow(/canonical event/);
  });

  it("projects typed partial coverage into frozen-v1 unavailable without accepting missing coverage", () => {
    const { product, canonical } = fixture();
    product.coverage.semantic = {
      status: "partial",
      reason_codes: ["REPEATED_PAGE_AMBIGUITY"],
    };
    canonical.channel_status.semantic = "unavailable";
    expect(() => assertProductMatchesCanonicalAdapter(product, canonical)).not.toThrow();

    const missingProductCoverage = structuredClone(product);
    delete missingProductCoverage.coverage.semantic;
    expect(() => assertProductMatchesCanonicalAdapter(missingProductCoverage, canonical))
      .toThrow(/cannot be projected/);

    const missingCanonicalCoverage = structuredClone(canonical);
    delete missingCanonicalCoverage.channel_status.semantic;
    expect(() => assertProductMatchesCanonicalAdapter(product, missingCanonicalCoverage))
      .toThrow(/cannot be projected/);
  });
});
