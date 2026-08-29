import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { SHARE_FILES } from "../package-for-friend.js";
import { SERVER_FILES } from "../scripts/build-mcpb.mjs";
import {
  buildSourceBoundExtractionRequest,
  VERIFIED_EXTRACTION_REQUEST_MODE,
} from "../scripts/verified-extraction-response-request.mjs";
import { buildVerifiedExtractionProposalSchema } from "../scripts/verified-extraction-response-admission.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const chunkId = value => `chunk.${value.repeat(64)}`;
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
  items: [{ region_id: "p7-t1", page: 7 }],
  all_items_sha256: "8".repeat(64),
};

describe("verified extraction response request", () => {
  it("binds exact physical page metadata and the first deterministic table page", () => {
    const request = buildSourceBoundExtractionRequest({
      model: "local-public-safe-model",
      maxOutputTokens: 4096,
      schema: buildVerifiedExtractionProposalSchema(),
      documentChunks: chunks,
      documentTableRegions: tableRegions,
      batchChunkIds: chunks.map(item => item.chunk_id),
    });
    const prompt = request.messages[1].content;
    expect(prompt).toContain(`[chunk_id=${chunkId("a")} page_one_based=7 first_table_region=true]`);
    expect(prompt).toContain(`[chunk_id=${chunkId("b")} page_one_based=8 first_table_region=false]`);
    expect(prompt).toContain("The deterministic first table region is on physical page 7");
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

  it("remains internal experimental source", () => {
    expect(VERIFIED_EXTRACTION_REQUEST_MODE).toBe("prompted_json_with_exact_chunk_page_metadata");
    expect(SERVER_FILES).not.toContain("verified-extraction-response-request.mjs");
    expect(SHARE_FILES).not.toContain("scripts/verified-extraction-response-request.mjs");
  });
});
