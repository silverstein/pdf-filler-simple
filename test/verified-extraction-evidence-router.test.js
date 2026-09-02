import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  buildSchemaDirectedEvidencePlan,
  canonicalizeSchemaDirectedExtraction,
  verifySchemaDirectedCanonicalProjection,
} from "../scripts/verified-extraction-evidence-router.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const documentId = "schema-routed-public-safe-document";
const sourceSha256 = "1".repeat(64);
const documentMapSha256 = "2".repeat(64);
const id = character => `chunk.${character.repeat(64)}`;
const chunk = value => ({ ...value, content_sha256: sha(value.content) });
const citation = "Suggested citation: River, A.B., Lake, C.D., and Stone, E.F., 2025, A public-safe report: U.S. Geological Survey Open-File Report 2025-1000, 20 p., https://doi.org/10.1234/example . ISSN 1234-5678 (online)";
const pageTexts = [
  "A public-safe report By Alice B. River, Carol D. Lake, and Erin F. Stone U.S. Geological Survey",
  citation,
  "Contents Table 1. Contents entry ........ 10 Table 2. Another entry ........ 20",
  "Narrative page with no requested evidence.",
  "Table 1. Verified measurements Station Value A 10 B 20 Notes continue for a deterministic canonical table anchor.",
  "References Other, A.B., 2024, An unrelated cited work.",
];
const chunks = pageTexts.map((content, index) => chunk({
  document_id: documentId,
  chunk_id: id(String.fromCharCode(97 + index)),
  page_range: { start_page: index + 1, end_page: index + 1 },
  starts_at_heading: index === 2 || index === 5,
  content,
}));
const sourcePagesBody = {
  version: 1,
  scheme: "verified-extraction-normalized-source-pages.v1",
  document_id: documentId,
  source_identity: {
    pdf_sha256: sourceSha256,
    page_count: pageTexts.length,
    pdfjs_package_sha256: "3".repeat(64),
    normalization: "unicode_whitespace_runs_to_ascii_space_then_trim",
  },
  pages: pageTexts.map((normalizedText, index) => ({
    page_one_based: index + 1,
    normalized_text: normalizedText,
    normalized_text_sha256: sha(normalizedText),
  })),
};
const sourcePages = {
  ...sourcePagesBody,
  source_page_text_bundle_sha256: sha(canonical(sourcePagesBody)),
};
const tableRegions = {
  observed: 1,
  returned: 1,
  omitted: 0,
  items: [{
    region_id: "p5-t1",
    page: 5,
    reason: "TABLE_TOPOLOGY_UNKNOWN",
    coordinate_space: "pdfjs_viewport_top_left_points",
    bbox: { x: 10, y: 20, width: 300, height: 120 },
    text_item_count: 8,
    evidence_truncation: {
      text_items: "complete",
      ruled_rects: "complete",
      ruling_segments: "complete",
      painted_rectangles: "complete",
    },
  }],
  all_items_sha256: "4".repeat(64),
};
const build = overrides => buildSchemaDirectedEvidencePlan({
  documentId,
  documentMapSha256,
  sourceSha256,
  documentChunks: chunks,
  documentTableRegions: tableRegions,
  documentSourcePages: sourcePages,
  ...overrides,
});
const result = {
  publication: {
    agency: "U.S. Geological Survey",
    publication_citation_excerpt: citation.slice(0, -25),
  },
  contributors: [
    { name: "Alice B. River" },
    { name: "Unrelated Reference" },
    { name: "Carol D. Lake" },
    { name: "Erin F. Stone" },
  ],
  summary: {
    contributor_count: 4,
    first_table: { page_one_based: 3, anchor_excerpt: "Table 1. Contents entry" },
  },
};

describe("schema-directed verified-extraction evidence routing", () => {
  it("routes only citation, credited byline, and earliest actual-table pages", () => {
    const plan = build();
    expect(plan.selected_pages).toEqual([
      { page_one_based: 1, reasons: ["credited_byline_cross_check"], chunk_ids: [id("a")] },
      { page_one_based: 2, reasons: ["publication_citation_and_contributors"], chunk_ids: [id("b")] },
      { page_one_based: 5, reasons: ["first_actual_table"], chunk_ids: [id("e")] },
    ]);
    expect(plan.selected_chunk_count).toBe(3);
    expect(plan.total_chunk_count).toBe(6);
    expect(plan.maximum_model_calls_after_context_splitting).toBe(3);
    expect(plan.first_actual_table).toMatchObject({
      page_one_based: 5,
      canonical_anchor_excerpt: pageTexts[4],
    });
    expect(plan.model_or_provider_calls_made).toBe(0);
    expect(plan.oracle_accessed).toBe(false);
  });

  it("projects complete citation text, credited surnames, count, and real table deterministically", () => {
    const plan = build();
    const projection = canonicalizeSchemaDirectedExtraction({
      plan,
      documentChunks: chunks,
      documentTableRegions: tableRegions,
      documentSourcePages: sourcePages,
      result,
    });
    expect(projection.result).toEqual({
      publication: {
        agency: "U.S. Geological Survey",
        publication_citation_excerpt: citation,
      },
      contributors: [
        { name: "Alice B. River" },
        { name: "Carol D. Lake" },
        { name: "Erin F. Stone" },
      ],
      summary: {
        contributor_count: 3,
        first_table: { page_one_based: 5, anchor_excerpt: pageTexts[4] },
      },
    });
    expect(projection.diagnostics).toMatchObject({
      proposed_contributors: 4,
      citation_contributors: 3,
      retained_contributors: 3,
      dropped_proposed_contributors: ["Unrelated Reference"],
      model_or_provider_calls_made: 0,
      oracle_accessed: false,
    });
    expect(Object.values(projection.citations).every(citationValue => (
      sourcePages.pages[citationValue.page - 1].normalized_text.includes(citationValue.quote)
    ))).toBe(true);
    expect(verifySchemaDirectedCanonicalProjection({
      plan,
      documentChunks: chunks,
      documentTableRegions: tableRegions,
      documentSourcePages: sourcePages,
      result,
      projection,
    })).toEqual(projection);
  });

  it("finds a credited-name page from citation surnames when the source omits a By heading", () => {
    const withoutBy = structuredClone(sourcePages);
    withoutBy.pages[0].normalized_text = withoutBy.pages[0].normalized_text.replace(" By ", " ");
    withoutBy.pages[0].normalized_text_sha256 = sha(withoutBy.pages[0].normalized_text);
    const body = structuredClone(withoutBy);
    delete body.source_page_text_bundle_sha256;
    withoutBy.source_page_text_bundle_sha256 = sha(canonical(body));
    const fallback = build({ documentSourcePages: withoutBy });
    expect(fallback.byline_page_one_based).toBe(1);
    expect(fallback.selected_pages[0]).toMatchObject({
      page_one_based: 1,
      reasons: ["credited_byline_cross_check"],
    });
  });

  it("finds an unlabelled front-matter citation without opening later references", () => {
    const unlabelled = structuredClone(sourcePages);
    unlabelled.pages[1].normalized_text = unlabelled.pages[1].normalized_text
      .replace("Suggested citation: ", "Copyright notice. ");
    unlabelled.pages[1].normalized_text_sha256 = sha(unlabelled.pages[1].normalized_text);
    const body = structuredClone(unlabelled);
    delete body.source_page_text_bundle_sha256;
    unlabelled.source_page_text_bundle_sha256 = sha(canonical(body));
    const plan = build({ documentSourcePages: unlabelled });
    expect(plan.citation_page_one_based).toBe(2);
    expect(plan.selected_pages.map(page => page.page_one_based)).toEqual([1, 2, 5]);
  });

  it("fails closed on plan, source, reference, citation, or proposal drift", () => {
    const plan = build();
    const planDrift = structuredClone(plan);
    planDrift.selected_chunk_ids = [id("d")];
    expect(() => canonicalizeSchemaDirectedExtraction({
      plan: planDrift,
      documentChunks: chunks,
      documentTableRegions: tableRegions,
      documentSourcePages: sourcePages,
      result,
    })).toThrow(/does not replay/u);

    const sourceDrift = structuredClone(sourcePages);
    sourceDrift.pages[1].normalized_text += " drift";
    expect(() => build({ documentSourcePages: sourceDrift })).toThrow(/digest drifted/u);

    const missingCitation = structuredClone(sourcePages);
    missingCitation.pages[1].normalized_text = "No citation evidence here.";
    const missingBody = structuredClone(missingCitation);
    delete missingBody.source_page_text_bundle_sha256;
    missingCitation.pages[1].normalized_text_sha256 = sha(missingCitation.pages[1].normalized_text);
    missingBody.pages[1].normalized_text_sha256 = missingCitation.pages[1].normalized_text_sha256;
    missingCitation.source_page_text_bundle_sha256 = sha(canonical(missingBody));
    expect(() => build({ documentSourcePages: missingCitation })).toThrow(/citation page/u);

    const missingByline = structuredClone(sourcePages);
    missingByline.pages[0].normalized_text = "A public-safe report U.S. Geological Survey";
    missingByline.pages[0].normalized_text_sha256 = sha(missingByline.pages[0].normalized_text);
    const missingBylineBody = structuredClone(missingByline);
    delete missingBylineBody.source_page_text_bundle_sha256;
    missingByline.source_page_text_bundle_sha256 = sha(canonical(missingBylineBody));
    expect(() => build({ documentSourcePages: missingByline })).toThrow(/credited-name page/u);

    const unsupportedAgency = structuredClone(result);
    unsupportedAgency.publication.agency = "Invented Agency";
    expect(() => canonicalizeSchemaDirectedExtraction({
      plan,
      documentChunks: chunks,
      documentTableRegions: tableRegions,
      documentSourcePages: sourcePages,
      result: unsupportedAgency,
    })).toThrow(/agency is absent/u);

    const onlyReference = structuredClone(result);
    onlyReference.contributors = [{ name: "Unrelated Reference" }];
    expect(() => canonicalizeSchemaDirectedExtraction({
      plan,
      documentChunks: chunks,
      documentTableRegions: tableRegions,
      documentSourcePages: sourcePages,
      result: onlyReference,
    })).toThrow(/no complete source-bound display name/u);
  });
});
