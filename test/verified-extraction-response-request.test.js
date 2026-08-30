import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { SHARE_FILES } from "../package-for-friend.js";
import { SERVER_FILES } from "../scripts/build-mcpb.mjs";
import {
  buildModelContextCapacityBinding,
  buildSourceBoundExtractionRequest,
  ModelContextCapacityError,
  observeSourceBoundExtractionRequestCapacity,
  preflightSourceBoundExtractionRequest,
  VERIFIED_EXTRACTION_CONTEXT_CAPACITY_POLICY,
  VERIFIED_EXTRACTION_REQUEST_MODE,
} from "../scripts/verified-extraction-response-request.mjs";
import {
  buildVerifiedExtractionProposalSchema,
  classifySourceBoundBatch,
} from "../scripts/verified-extraction-response-admission.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const chunkId = value => `chunk.${value.repeat(64)}`;
const sourceSha256 = "1".repeat(64);
const documentMapSha256 = "9".repeat(64);
const chunk = ({ id, page, content }) => ({
  document_id: "public-safe-request-document",
  chunk_id: chunkId(id),
  page_range: { start_page: page, end_page: page },
  starts_at_heading: false,
  content,
  content_sha256: sha(Buffer.from(content, "utf8")),
});
const chunks = [
  chunk({ id: "a", page: 7, content: "Table 1. Exact public-safe anchor" }),
  chunk({ id: "b", page: 8, content: "Supporting public-safe text" }),
];
const tableRegions = {
  observed: 1,
  returned: 1,
  omitted: 0,
  items: [{
    region_id: "p7-t1",
    page: 7,
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
  document_id: "public-safe-request-document",
  source_identity: {
    pdf_sha256: sourceSha256,
    page_count: 8,
    pdfjs_package_sha256: "7".repeat(64),
    normalization: "unicode_whitespace_runs_to_ascii_space_then_trim",
  },
  pages: Array.from({ length: 8 }, (_, index) => {
    const normalizedText = index === 6 ? chunks[0].content
      : index === 7 ? chunks[1].content : `Source page ${index + 1}`;
    return { page_one_based: index + 1, normalized_text: normalizedText,
      normalized_text_sha256: sha(normalizedText) };
  }),
};
const sourcePages = {
  ...sourcePagesBody,
  source_page_text_bundle_sha256: sha(canonical(sourcePagesBody)),
};
const batchPolicy = batchChunkIds => classifySourceBoundBatch({
  documentId: "public-safe-request-document",
  documentMapSha256,
  sourceSha256,
  documentChunks: chunks,
  documentTableRegions: tableRegions,
  documentSourcePages: sourcePages,
  batchChunkIds,
});

describe("verified extraction response request", () => {
  it("binds exact physical page metadata and the first deterministic table page", () => {
    const request = buildSourceBoundExtractionRequest({
      model: "local-public-safe-model",
      maxOutputTokens: 4096,
      schema: buildVerifiedExtractionProposalSchema(),
      documentChunks: chunks,
      documentTableRegions: tableRegions,
      documentSourcePages: sourcePages,
      batchPolicy: batchPolicy(chunks.map(item => item.chunk_id)),
      batchChunkIds: chunks.map(item => item.chunk_id),
    });
    const prompt = request.messages[1].content;
    expect(prompt).toContain(`[chunk_id=${chunkId("a")} page_one_based=7 first_table_region=true]`);
    expect(prompt).toContain(`[chunk_id=${chunkId("b")} page_one_based=8 first_table_region=false]`);
    expect(prompt).toContain("The first source-classified actual data table is on physical page 7");
    expect(prompt).toContain("CANONICAL SOURCE PAGES:");
    expect(prompt).toContain("A requested field may be absent from this batch");
    expect(prompt).not.toContain("Every requested field is present in the source");
    expect(request).toMatchObject({ temperature: 0, top_p: 1, seed: 20260829, stream: false });
  });

  it("requires first_table null when no deterministic table region exists", () => {
    const request = buildSourceBoundExtractionRequest({
      model: "local-public-safe-model",
      maxOutputTokens: 4096,
      schema: buildVerifiedExtractionProposalSchema({
        allowedFields: ["agency", "publication_citation_excerpt", "contributors"],
      }),
      documentChunks: chunks,
      documentTableRegions: { ...tableRegions, observed: 0, returned: 0, items: [] },
      documentSourcePages: sourcePages,
      batchPolicy: classifySourceBoundBatch({
        documentId: "public-safe-request-document",
        documentMapSha256,
        sourceSha256,
        documentChunks: chunks,
        documentTableRegions: { ...tableRegions, observed: 0, returned: 0, items: [] },
        documentSourcePages: sourcePages,
        batchChunkIds: [chunkId("b")],
      }),
      batchChunkIds: [chunkId("b")],
    });
    expect(request.messages[1].content).toContain("No deterministic first table region exists; first_table must be null");
  });

  it("rejects duplicate, unknown, or multi-page chunk scope", () => {
    const common = {
      model: "local-public-safe-model",
      maxOutputTokens: 4096,
      schema: buildVerifiedExtractionProposalSchema(),
      documentChunks: chunks,
      documentTableRegions: tableRegions,
      documentSourcePages: sourcePages,
      batchPolicy: batchPolicy(chunks.map(item => item.chunk_id)),
    };
    expect(() => buildSourceBoundExtractionRequest({
      ...common, batchChunkIds: [chunkId("a"), chunkId("a")],
    })).toThrow();
    expect(() => buildSourceBoundExtractionRequest({
      ...common, batchChunkIds: [chunkId("f")],
    })).toThrow();
    expect(() => buildSourceBoundExtractionRequest({
      ...common,
      documentChunks: [{ ...chunks[0], page_range: { start_page: 7, end_page: 8 } }],
      batchChunkIds: [chunkId("a")],
    })).toThrow();
    expect(() => buildSourceBoundExtractionRequest({
      ...common,
      documentChunks: [{ ...chunks[0], content_sha256: "f".repeat(64) }],
      batchChunkIds: [chunkId("a")],
    })).toThrow();
    expect(() => buildSourceBoundExtractionRequest({
      ...common, batchChunkIds: [chunkId("b"), chunkId("a")],
    })).toThrow();
  });

  it("rejects source-page drift and oversized prompt material before request construction", () => {
    const common = {
      model: "local-public-safe-model",
      maxOutputTokens: 4096,
      schema: buildVerifiedExtractionProposalSchema(),
      documentChunks: chunks,
      documentTableRegions: tableRegions,
      batchPolicy: batchPolicy([chunkId("a")]),
      batchChunkIds: [chunkId("a")],
    };
    const drifted = structuredClone(sourcePages);
    drifted.pages[6].normalized_text += " drift";
    expect(() => buildSourceBoundExtractionRequest({
      ...common, documentSourcePages: drifted,
    })).toThrow(/digest drifted/u);

    const oversizedBody = structuredClone(sourcePagesBody);
    oversizedBody.pages[6].normalized_text = `Table 1. Exact public-safe anchor ${"x".repeat(48 * 1024 + 1)}`;
    oversizedBody.pages[6].normalized_text_sha256 = sha(oversizedBody.pages[6].normalized_text);
    const oversized = {
      ...oversizedBody,
      source_page_text_bundle_sha256: sha(canonical(oversizedBody)),
    };
    expect(() => buildSourceBoundExtractionRequest({
      ...common,
      documentSourcePages: oversized,
      batchPolicy: classifySourceBoundBatch({
        documentId: "public-safe-request-document",
        documentMapSha256,
        sourceSha256,
        documentChunks: chunks,
        documentTableRegions: tableRegions,
        documentSourcePages: oversized,
        batchChunkIds: [chunkId("a")],
      }),
    })).toThrow(/prompt byte limit/u);
  });

  it("enforces a deterministic model-bound context ceiling before invocation", () => {
    const request = buildSourceBoundExtractionRequest({
      model: "local-public-safe-model",
      maxOutputTokens: 4096,
      schema: buildVerifiedExtractionProposalSchema(),
      documentChunks: chunks,
      documentTableRegions: tableRegions,
      documentSourcePages: sourcePages,
      batchPolicy: batchPolicy(chunks.map(item => item.chunk_id)),
      batchChunkIds: chunks.map(item => item.chunk_id),
    });
    const wide = buildModelContextCapacityBinding({
      model: request.model,
      contextWindowTokens: 100000,
    });
    const observed = observeSourceBoundExtractionRequestCapacity({ request, contextBinding: wide });
    expect(observed).toMatchObject({ fits: true, reserved_output_tokens: 4096,
      model_or_provider_calls_made: 0 });
    expect(observed.observation_sha256).toMatch(/^[a-f0-9]{64}$/u);

    const exact = buildModelContextCapacityBinding({
      model: request.model,
      contextWindowTokens: observed.required_context_tokens_upper_bound,
    });
    expect(preflightSourceBoundExtractionRequest({ request, contextBinding: exact }).fits).toBe(true);
    const short = buildModelContextCapacityBinding({
      model: request.model,
      contextWindowTokens: observed.required_context_tokens_upper_bound - 1,
    });
    expect(() => preflightSourceBoundExtractionRequest({ request, contextBinding: short }))
      .toThrow(ModelContextCapacityError);
    const injectedMessage = structuredClone(request);
    injectedMessage.messages.push({ role: "assistant", content: "unplanned template turn" });
    expect(() => preflightSourceBoundExtractionRequest({ request: injectedMessage, contextBinding: wide }))
      .toThrow();
  });

  it("counts exact UTF-8 request bytes for multibyte prompt content", () => {
    const request = buildSourceBoundExtractionRequest({
      model: "local-public-safe-model",
      maxOutputTokens: 4096,
      schema: buildVerifiedExtractionProposalSchema(),
      documentChunks: chunks,
      documentTableRegions: tableRegions,
      documentSourcePages: sourcePages,
      batchPolicy: batchPolicy(chunks.map(item => item.chunk_id)),
      batchChunkIds: chunks.map(item => item.chunk_id),
    });
    const binding = buildModelContextCapacityBinding({ model: request.model, contextWindowTokens: 100000 });
    const ascii = structuredClone(request);
    ascii.messages[1].content += "aaa";
    const multibyte = structuredClone(request);
    multibyte.messages[1].content += "é😀";
    const asciiObservation = observeSourceBoundExtractionRequestCapacity({ request: ascii,
      contextBinding: binding });
    const multibyteObservation = observeSourceBoundExtractionRequestCapacity({ request: multibyte,
      contextBinding: binding });
    expect(multibyteObservation.request_utf8_bytes - asciiObservation.request_utf8_bytes).toBe(3);
    expect(multibyteObservation.prompt_tokens_upper_bound - asciiObservation.prompt_tokens_upper_bound).toBe(3);
  });

  it("remains internal experimental source", () => {
    expect(VERIFIED_EXTRACTION_REQUEST_MODE).toBe("prompted_json_with_exact_chunk_page_metadata");
    expect(VERIFIED_EXTRACTION_CONTEXT_CAPACITY_POLICY).toMatchObject({
      estimator: "utf8_request_bytes_plus_fixed_chat_template_ceiling",
      maximum_prompt_tokens_per_request_utf8_byte: 1,
    });
    expect(SERVER_FILES).not.toContain("verified-extraction-response-request.mjs");
    expect(SHARE_FILES).not.toContain("scripts/verified-extraction-response-request.mjs");
  });
});
