import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { SHARE_FILES } from "../package-for-friend.js";
import { SERVER_FILES } from "../scripts/build-mcpb.mjs";
import {
  buildSourceBoundDocumentValidation,
  prepareSourceBoundResponsePipeline,
  runSourceBoundResponsePipelineAttempt,
  VERIFIED_EXTRACTION_RESPONSE_PIPELINE_POLICY,
} from "../scripts/verified-extraction-response-pipeline.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const canonicalJson = value => Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const chunkId = value => `chunk.${value.repeat(64)}`;
const documentId = "public-safe-pipeline-document";
const expectedModel = "oda-local-model";
const sourceSha256 = "1".repeat(64);
const schemaSha256 = "2".repeat(64);
const publication = "Suggested citation: River, A.B., 2025, A public-safe report. https://doi.org/10.1234/example";
const chunk = value => ({ ...value, content_sha256: sha(Buffer.from(value.content, "utf8")) });
const chunks = [
  chunk({ document_id: documentId, chunk_id: chunkId("a"), page_range: { start_page: 1, end_page: 1 },
    starts_at_heading: true, content: "TITLE\nU.S. Geological Survey\nRiver, A.B.\nTable 1. Summary values" }),
  chunk({ document_id: documentId, chunk_id: chunkId("b"), page_range: { start_page: 2, end_page: 2 },
    starts_at_heading: false, content: publication }),
  chunk({ document_id: documentId, chunk_id: chunkId("c"), page_range: { start_page: 3, end_page: 3 },
    starts_at_heading: true, content: "References\nOther, A., 2024, An unrelated cited work." }),
];
const tableRegions = {
  observed: 1,
  returned: 1,
  omitted: 0,
  items: [{
    region_id: "p1-t1",
    page: 1,
    reason: "TABLE_TOPOLOGY_UNKNOWN",
    coordinate_space: "pdfjs_viewport_top_left_points",
    bbox: { x: 10, y: 20, width: 300, height: 120 },
    text_item_count: 8,
    evidence_truncation: {
      text_items: "complete", ruled_rects: "complete", ruling_segments: "complete",
      painted_rectangles: "complete",
    },
  }],
  all_items_sha256: "8".repeat(64),
};
const sourcePagesBody = {
  version: 1,
  scheme: "verified-extraction-normalized-source-pages.v1",
  document_id: documentId,
  source_identity: {
    pdf_sha256: sourceSha256,
    page_count: 3,
    pdfjs_package_sha256: "7".repeat(64),
    normalization: "unicode_whitespace_runs_to_ascii_space_then_trim",
  },
  pages: [
    "TITLE U.S. Geological Survey River, A.B. Table 1. Summary values",
    publication,
    "References Other, A., 2024, An unrelated cited work.",
  ].map((normalizedText, index) => ({
    page_one_based: index + 1,
    normalized_text: normalizedText,
    normalized_text_sha256: sha(normalizedText),
  })),
};
const sourcePages = {
  ...sourcePagesBody,
  source_page_text_bundle_sha256: sha(canonicalJson(sourcePagesBody)),
};
const documentMapBody = {
  page_count: 3,
  bindings: {
    source: { sha256: sourceSha256, size_bytes: 1024 },
    schema: { sha256: schemaSha256, size_bytes: 256 },
    renderer: { name: "pdf-tools-markdown", version: "1.0.0" },
  },
  chunks: { descriptors: chunks.map(item => ({ chunk_id: item.chunk_id })) },
  table_regions: tableRegions,
};
const documentMap = {
  ...documentMapBody,
  document_map_sha256: sha(canonicalJson(documentMapBody)),
};
const withDocumentMapDigest = body => ({
  ...body,
  document_map_sha256: sha(canonicalJson(body)),
});
const proposal = () => ({
  agency: { value: "U.S. Geological Survey", citation: { chunk_id: chunkId("a"), quote: "U.S. Geological Survey" } },
  publication_citation_excerpt: { value: publication,
    citation: { chunk_id: chunkId("b"), quote: publication } },
  contributors: [{ name: "River, A.B.", citation: { chunk_id: chunkId("a"), quote: "River, A.B." } }],
  first_table: { page_one_based: 1, anchor_excerpt: "Table 1. Summary values",
    citation: { chunk_id: chunkId("a"), quote: "Table 1. Summary values" } },
});
const response = () => Buffer.from(JSON.stringify({
  id: "synthetic-response",
  model: expectedModel,
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(proposal()) } }],
  usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
}));
const artifact = bytes => ({
  response_bytes: bytes,
  raw_response_artifact: { path: `raw/${sha(bytes)}.json`, bytes: bytes.length, sha256: sha(bytes) },
});
const prepare = overrides => prepareSourceBoundResponsePipeline({
  attemptId: "successor-attempt-0001",
  trialId: "successor-trial-0001",
  predecessorRoleIds: ["baseline-attempt-0001", "baseline-trial-0001"],
  documentId,
  documentMap,
  documentChunks: chunks,
  documentSourcePages: sourcePages,
  batchChunkIds: [[chunkId("a"), chunkId("b")], [chunkId("c")]],
  expectedModel,
  maxOutputTokens: 4096,
  ...overrides,
});

describe("verified extraction response pipeline", () => {
  it("carries one exact canonical source-page bundle and frozen batch policy through request construction", async () => {
    const prepared = prepare();
    expect(prepared.plan.document_validation).toMatchObject({
      document_id: documentId,
      document_map_sha256: documentMap.document_map_sha256,
      source_sha256: sourceSha256,
      schema_sha256: schemaSha256,
      source_page_text_bundle_sha256: sourcePages.source_page_text_bundle_sha256,
      ordered_chunk_ids: chunks.map(item => item.chunk_id),
      table_regions: tableRegions,
    });
    const invokeRequest = vi.fn(async ({ batch, request }) => {
      expect(batch.policy.source_page_text_bundle_sha256)
        .toBe(sourcePages.source_page_text_bundle_sha256);
      expect(request.seed).toBe(20260829);
      expect(request.messages[1].content).toContain("CANONICAL SOURCE PAGES:");
      expect(request.messages[1].content).toContain("first source-classified actual data table is on physical page 1");
      return artifact(response());
    });
    const result = await runSourceBoundResponsePipelineAttempt({
      prepared,
      documentChunks: chunks,
      invokeRequest,
    });
    expect(invokeRequest).toHaveBeenCalledTimes(1);
    expect(result.receipt).toMatchObject({
      outcome: { classification: "completed", reason_code: "none" },
      observed: { model_calls: 1, skipped_reference_batches: 1 },
      benchmark_claim_ready: false,
    });
    expect(result.source_extraction).toMatchObject({
      status: "complete",
      selected: {
        publication: { agency: "U.S. Geological Survey", publication_citation_excerpt: publication },
        contributors: [{ name: "River, A.B." }],
        summary: { contributor_count: 1, first_table: { page_one_based: 1 } },
      },
      result: { summary: { contributor_count: 1 } },
      missing_required_paths: [],
    });
  });

  it("rejects missing, drifted, duplicated, or substituted source bindings before invocation", async () => {
    expect(() => prepare({ documentSourcePages: undefined })).toThrow(/documentSourcePages/u);
    expect(() => prepare({ documentSourcePages: {
      ...sourcePages,
      source_page_text_bundle_sha256: "f".repeat(64),
    } })).toThrow(/self-digest drifted/u);
    const sourceDriftMapBody = {
      ...documentMapBody,
      bindings: {
        ...documentMapBody.bindings,
        source: { ...documentMapBody.bindings.source, sha256: "e".repeat(64) },
      },
    };
    expect(() => prepare({ documentMap: withDocumentMapDigest(sourceDriftMapBody) }))
      .toThrow(/source identity drifted/u);
    const duplicateMapBody = {
      ...documentMapBody,
      chunks: { descriptors: [documentMap.chunks.descriptors[0], documentMap.chunks.descriptors[0],
        documentMap.chunks.descriptors[2]] },
    };
    expect(() => prepare({ documentMap: withDocumentMapDigest(duplicateMapBody) }))
      .toThrow(/duplicate chunk identities/u);
    expect(() => prepare({ documentMap: {
      ...documentMap,
      table_regions: { ...documentMap.table_regions, omitted: 1 },
    } })).toThrow(/retained map bytes/u);

    const prepared = prepare();
    prepared.document_source_pages.pages[0].normalized_text += " drift";
    const invokeRequest = vi.fn();
    await expect(runSourceBoundResponsePipelineAttempt({ prepared, documentChunks: chunks, invokeRequest }))
      .rejects.toThrow(/digest drifted/u);
    expect(invokeRequest).not.toHaveBeenCalled();
  });

  it("derives the exact validation object rather than accepting caller-authored binding fields", () => {
    const validation = buildSourceBoundDocumentValidation({
      documentId,
      documentMap,
      documentChunks: chunks,
      documentSourcePages: sourcePages,
    });
    expect(Object.keys(validation).sort()).toEqual([
      "document_id", "document_map_sha256", "ordered_chunk_ids", "renderer_sha256", "schema_sha256",
      "source_page_text_bundle_sha256", "source_sha256", "table_regions",
    ]);
    expect(validation.renderer_sha256).toBe(sha(canonicalJson(documentMap.bindings.renderer)));
  });

  it("remains internal experimental source", () => {
    expect(VERIFIED_EXTRACTION_RESPONSE_PIPELINE_POLICY.version).toBe("1.1.0-experimental");
    expect(SERVER_FILES).not.toContain("verified-extraction-response-pipeline.mjs");
    expect(SHARE_FILES).not.toContain("scripts/verified-extraction-response-pipeline.mjs");
  });
});
