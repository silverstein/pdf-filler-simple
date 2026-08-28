import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { SHARE_FILES } from "../package-for-friend.js";
import { SERVER_FILES } from "../scripts/build-mcpb.mjs";
import {
  prepareResponseAdmissionController,
  runResponseAdmissionControllerAttempt,
  validateResponseAdmissionControllerPlan,
  VERIFIED_EXTRACTION_RESPONSE_CONTROLLER_POLICY,
} from "../scripts/verified-extraction-response-controller.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const chunkId = value => `chunk.${value.repeat(64)}`;
const documentId = "public-safe-controller-document";
const documentMapSha256 = "9".repeat(64);
const expectedModel = "oda-local-model";
const chunk = value => ({ ...value, content_sha256: sha(Buffer.from(value.content, "utf8")) });
const chunks = [
  chunk({ document_id: documentId, chunk_id: chunkId("a"), page_range: { start_page: 1, end_page: 1 },
    starts_at_heading: true, content: "TITLE\nU.S. Geological Survey\nRiver, A.B.\nTable 1. Summary values" }),
  chunk({ document_id: documentId, chunk_id: chunkId("b"), page_range: { start_page: 2, end_page: 2 },
    starts_at_heading: false, content: "Suggested citation: River, A.B., 2025, A public-safe report." }),
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
const documentValidation = {
  document_id: documentId,
  document_map_sha256: documentMapSha256,
  source_sha256: "1".repeat(64),
  schema_sha256: "2".repeat(64),
  renderer_sha256: "3".repeat(64),
  ordered_chunk_ids: chunks.map(item => item.chunk_id),
  table_regions: tableRegions,
};
const proposal = () => ({
  agency: { value: "U.S. Geological Survey", citation: { chunk_id: chunkId("a"), quote: "U.S. Geological Survey" } },
  publication_citation_excerpt: { value: "River, A.B., 2025, A public-safe report.",
    citation: { chunk_id: chunkId("b"), quote: "River, A.B., 2025, A public-safe report." } },
  contributors: [{ name: "River, A.B.", citation: { chunk_id: chunkId("a"), quote: "River, A.B." } }],
  first_table: { page_one_based: 1, anchor_excerpt: "Table 1. Summary values",
    citation: { chunk_id: chunkId("a"), quote: "Table 1. Summary values" } },
});
const response = ({ content = JSON.stringify(proposal()), finishReason = "stop" } = {}) => Buffer.from(JSON.stringify({
  id: "synthetic-response",
  model: expectedModel,
  choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content } }],
  usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
}));
const artifact = bytes => ({
  response_bytes: bytes,
  raw_response_artifact: { path: `raw/${sha(bytes)}.json`, bytes: bytes.length, sha256: sha(bytes) },
});
const plan = () => prepareResponseAdmissionController({
  attemptId: "successor-attempt-0001",
  trialId: "successor-trial-0001",
  predecessorRoleIds: ["v13-attempt-0001", "v13-trial-0001"],
  documentValidation,
  documentChunks: chunks,
  batchChunkIds: [[chunkId("a"), chunkId("b")], [chunkId("c")]],
  expectedModel,
  maxOutputTokens: 4096,
});

describe("verified extraction response controller", () => {
  it("binds the complete ordered scope and never calls the reference-section batch", async () => {
    const invokeBatch = vi.fn(async () => artifact(response()));
    const result = await runResponseAdmissionControllerAttempt({ plan: plan(), documentChunks: chunks, invokeBatch });
    expect(invokeBatch).toHaveBeenCalledTimes(1);
    expect(result.receipt).toMatchObject({
      denominator: { document_chunks: 3, batches: 2, model_batches: 1, reference_skipped_batches: 1 },
      observed: { batch_outcomes: 2, admitted_batches: 1, model_calls: 1,
        skipped_reference_batches: 1, unattempted_batches: 0 },
      outcome: { classification: "completed", reason_code: "none" },
      calculation_evidence: { contributor_count: 1,
        contributor_count_derivation: "derived_from_unique_exact_admitted_contributor_names" },
      benchmark_claim_ready: false,
    });
    expect(result.receipt.receipt_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.receipt.batch_outcomes[0].admission).toEqual(result.admissions[0]);
  });

  it("retains exact source spans when an admitted batch uniquely projects internal whitespace", async () => {
    const projectedChunks = [
      chunk({ ...chunks[0], content: "TITLE\nU.S. Geological\nSurvey\nRiver,\nA.B.\nTable 1.\tSummary values" }),
      chunk({ ...chunks[1], content: "Suggested citation: River, A.B., 2025,\nA public-safe report." }),
      chunks[2],
    ];
    const projectedPlan = prepareResponseAdmissionController({
      attemptId: "successor-attempt-projection",
      trialId: "successor-trial-projection",
      predecessorRoleIds: ["v13-attempt-0001"],
      documentValidation,
      documentChunks: projectedChunks,
      batchChunkIds: [[chunkId("a"), chunkId("b")], [chunkId("c")]],
      expectedModel,
      maxOutputTokens: 4096,
    });
    const result = await runResponseAdmissionControllerAttempt({
      plan: projectedPlan,
      documentChunks: projectedChunks,
      invokeBatch: async () => artifact(response()),
    });
    expect(result.receipt.outcome.classification).toBe("completed");
    expect(result.admissions[0].source_replay.citations).toMatchObject([
      { field: "agency", quote: "U.S. Geological\nSurvey",
        projection: { quote_match: "unique_internal_whitespace_projection" } },
      { field: "publication_citation_excerpt", quote: "River, A.B., 2025,\nA public-safe report." },
      { field: "contributors[0]", quote: "River,\nA.B." },
      { field: "first_table", quote: "Table 1.\tSummary values" },
    ]);
  });

  it.each([
    ["model_output_truncated", response({ content: "{\"agency\":", finishReason: "length" })],
    ["model_response_ambiguous_or_malformed", response({ content: "{\"agency\":null" })],
  ])("retains a denominator-preserving %s receipt", async (reasonCode, bytes) => {
    const result = await runResponseAdmissionControllerAttempt({
      plan: plan(), documentChunks: chunks, invokeBatch: async () => artifact(bytes),
    });
    expect(result.receipt).toMatchObject({
      denominator: { document_chunks: 3, batches: 2 },
      observed: { batch_outcomes: 1, model_calls: 1, unattempted_batches: 1 },
      outcome: { classification: "product_failure", reason_code: reasonCode },
      calculation_evidence: null,
    });
    expect(result.receipt.batch_outcomes[0].response_observation.response_sha256).toBe(sha(bytes));
  });

  it.each([
    ["stale chunk", candidate => { candidate.agency.citation.chunk_id = chunkId("f"); }],
    ["cross-document chunk", candidate => { candidate.agency.citation.chunk_id = chunkId("c"); }],
    ["extra citation", candidate => { candidate.agency.citation.quote = "Table 1. Summary values"; }],
  ])("retains safe fields while typing %s in the admitted batch", async (_label, mutate) => {
    const candidate = proposal();
    mutate(candidate);
    const bytes = response({ content: JSON.stringify(candidate) });
    const result = await runResponseAdmissionControllerAttempt({
      plan: plan(), documentChunks: chunks, invokeBatch: async () => artifact(bytes),
    });
    expect(result.receipt.outcome).toMatchObject({ classification: "completed", reason_code: "none" });
    expect(result.admissions[0].proposal.agency).toBeNull();
    expect(result.admissions[0].field_outcomes.agency).toMatchObject({
      status: "rejected", reason_code: "not_source_bound", citation_count: 0,
    });
    expect(result.admissions[0].proposal.publication_citation_excerpt)
      .toEqual(proposal().publication_citation_excerpt);
    expect(result.receipt.denominator.document_chunks).toBe(3);
  });

  it("retains an invocation/controller failure without inventing a model call", async () => {
    const result = await runResponseAdmissionControllerAttempt({
      plan: plan(), documentChunks: chunks, invokeBatch: async () => { throw new Error("synthetic transport break"); },
    });
    expect(result.receipt).toMatchObject({
      observed: { batch_outcomes: 1, model_calls: 0, unattempted_batches: 1 },
      outcome: { classification: "harness_failure", reason_code: "controller_failure" },
      calculation_evidence: null,
    });
  });

  it("rejects scope, map, plan, role-identity, and raw-artifact drift before admission", async () => {
    expect(() => prepareResponseAdmissionController({
      attemptId: "v13-attempt-0001", trialId: "successor-trial-0001",
      predecessorRoleIds: ["v13-attempt-0001"], documentValidation, documentChunks: chunks,
      batchChunkIds: [[chunkId("a"), chunkId("b"), chunkId("c")]], expectedModel, maxOutputTokens: 4096,
    })).toThrow(/overlaps a predecessor/u);
    expect(() => prepareResponseAdmissionController({
      attemptId: "successor-attempt-0001", trialId: "successor-trial-0001",
      documentValidation, documentChunks: chunks,
      batchChunkIds: [[chunkId("a"), chunkId("c")], [chunkId("b")]], expectedModel, maxOutputTokens: 4096,
    })).toThrow();
    const drifted = plan();
    drifted.document_validation.document_map_sha256 = "8".repeat(64);
    expect(() => validateResponseAdmissionControllerPlan({ plan: drifted, documentChunks: chunks })).toThrow();
    const bytes = response();
    const wrongArtifact = artifact(bytes);
    wrongArtifact.raw_response_artifact.sha256 = "7".repeat(64);
    const result = await runResponseAdmissionControllerAttempt({
      plan: plan(), documentChunks: chunks, invokeBatch: async () => wrongArtifact,
    });
    expect(result.receipt.outcome).toMatchObject({
      classification: "harness_failure", reason_code: "controller_failure",
    });
    expect(result.receipt.batch_outcomes[0].raw_response_artifact).toBeNull();
  });

  it("remains internal experimental source with no execution authority", () => {
    expect(VERIFIED_EXTRACTION_RESPONSE_CONTROLLER_POLICY.boundary).toContain("no model or provider call");
    expect(SERVER_FILES).not.toContain("verified-extraction-response-controller.mjs");
    expect(SHARE_FILES).not.toContain("scripts/verified-extraction-response-controller.mjs");
  });
});
