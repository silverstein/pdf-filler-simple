import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { SHARE_FILES } from "../package-for-friend.js";
import { SERVER_FILES } from "../scripts/build-mcpb.mjs";
import { buildSchemaDirectedEvidencePlan } from "../scripts/verified-extraction-evidence-router.mjs";
import {
  materializeAdmittedSourceExtraction,
  ModelCallBudgetExhaustedError,
  prepareResponseAdmissionController,
  responseAdmissionControllerFailure,
  runResponseAdmissionControllerAttempt,
  validateResponseAdmissionControllerPlan,
  VERIFIED_EXTRACTION_RESPONSE_CONTROLLER_POLICY,
} from "../scripts/verified-extraction-response-controller.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const canonicalJson = value => Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const chunkId = value => `chunk.${value.repeat(64)}`;
const documentId = "public-safe-controller-document";
const documentMapSha256 = "9".repeat(64);
const expectedModel = "oda-local-model";
const sourceSha256 = "1".repeat(64);
const publication = "Suggested citation: River, A.B., 2025, A public-safe report. https://doi.org/10.1234/example";
const chunk = value => ({ ...value, content_sha256: sha(Buffer.from(value.content, "utf8")) });
const chunks = [
  chunk({ document_id: documentId, chunk_id: chunkId("a"), page_range: { start_page: 1, end_page: 1 },
    starts_at_heading: true, content: "TITLE\nBy Alice B. River\nU.S. Geological Survey\nRiver, A.B.\nTable 1. Summary values" }),
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
    "TITLE By Alice B. River U.S. Geological Survey River, A.B. Table 1. Summary values",
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
const documentValidation = {
  document_id: documentId,
  document_map_sha256: documentMapSha256,
  source_sha256: sourceSha256,
  source_page_text_bundle_sha256: sourcePages.source_page_text_bundle_sha256,
  schema_sha256: "2".repeat(64),
  renderer_sha256: "3".repeat(64),
  ordered_chunk_ids: chunks.map(item => item.chunk_id),
  table_regions: tableRegions,
};
const proposal = () => ({
  agency: { value: "U.S. Geological Survey", citation: { chunk_id: chunkId("a"), quote: "U.S. Geological Survey" } },
  publication_citation_excerpt: { value: publication,
    citation: { chunk_id: chunkId("b"), quote: publication } },
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
const prepareController = overrides => prepareResponseAdmissionController({
  documentSourcePages: sourcePages,
  contextWindowTokens: 32768,
  ...overrides,
});
const runController = overrides => runResponseAdmissionControllerAttempt({
  documentSourcePages: sourcePages,
  ...overrides,
});
const validateControllerPlan = overrides => validateResponseAdmissionControllerPlan({
  documentSourcePages: sourcePages,
  ...overrides,
});
const plan = () => prepareController({
  attemptId: "successor-attempt-0001",
  trialId: "successor-trial-0001",
  predecessorRoleIds: ["v13-attempt-0001", "v13-trial-0001"],
  documentValidation,
  documentChunks: chunks,
  batchChunkIds: [[chunkId("a"), chunkId("b")], [chunkId("c")]],
  expectedModel,
  maxOutputTokens: 4096,
  contextWindowTokens: 32768,
});

describe("verified extraction response controller", () => {
  it("binds the complete ordered scope and never calls the reference-section batch", async () => {
    const invokeBatch = vi.fn(async () => artifact(response()));
    const result = await runController({ plan: plan(), documentChunks: chunks, invokeBatch });
    expect(invokeBatch).toHaveBeenCalledTimes(1);
    expect(result.receipt).toMatchObject({
      denominator: { document_chunks: 3, batches: 2, model_batches: 1, reference_skipped_batches: 1 },
      observed: { batch_outcomes: 2, admitted_batches: 1, typed_rejected_batches: 0, model_calls: 1,
        skipped_reference_batches: 1, unattempted_batches: 0 },
      outcome: { classification: "completed", reason_code: "none" },
      calculation_evidence: { contributor_count: 1,
        contributor_count_derivation: "derived_from_unique_exact_admitted_contributor_names" },
      benchmark_claim_ready: false,
    });
    expect(result.receipt.receipt_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.receipt.batch_outcomes[0].admission).toEqual(result.admissions[0]);
    expect(result.source_extraction).toMatchObject({
      status: "complete",
      selected: {
        publication: { agency: "U.S. Geological Survey", publication_citation_excerpt: publication },
        contributors: [{ name: "River, A.B." }],
        summary: { contributor_count: 1,
          first_table: { page_one_based: 1, anchor_excerpt: "Table 1. Summary values" } },
      },
      result: {
        publication: { agency: "U.S. Geological Survey", publication_citation_excerpt: publication },
        contributors: [{ name: "River, A.B." }],
        summary: { contributor_count: 1 },
      },
      missing_required_paths: [],
      benchmark_claim_ready: false,
    });
    expect(result.receipt.source_extraction).toEqual(result.source_extraction);
  });

  it("binds a routed ordered subset while retaining the full document denominator", () => {
    const documentRouting = buildSchemaDirectedEvidencePlan({
      documentId,
      documentMapSha256,
      sourceSha256,
      documentChunks: chunks,
      documentTableRegions: tableRegions,
      documentSourcePages: sourcePages,
    });
    const routed = prepareController({
      attemptId: "routed-attempt-0001",
      trialId: "routed-trial-0001",
      documentValidation,
      documentChunks: chunks,
      batchChunkIds: [[chunkId("a"), chunkId("b")]],
      documentRouting,
      expectedModel,
      maxOutputTokens: 4096,
    });
    expect(routed).toMatchObject({
      contract: { version: "1.7.0-experimental" },
      document_routing: documentRouting,
      denominator: { document_chunks: 3, routed_chunks: 2, unrouted_chunks: 1 },
    });
    expect(validateControllerPlan({ plan: routed, documentChunks: chunks })).toBe(routed);

    for (const mutate of [
      value => { value.document_routing.plan_sha256 = "5".repeat(64); },
      value => { value.document_routing.selected_chunk_ids.push(chunkId("c")); },
      value => { value.document_routing.selected_chunk_ids.reverse(); },
      value => { value.document_routing.selected_chunk_ids[1] = chunkId("d"); },
      value => { value.document_routing.total_chunk_count = 2; },
    ]) {
      const drifted = structuredClone(routed);
      mutate(drifted);
      delete drifted.plan_sha256;
      drifted.plan_sha256 = sha(canonicalJson(drifted));
      expect(() => validateControllerPlan({ plan: drifted, documentChunks: chunks })).toThrow();
    }
  });

  it("retains exact source spans when an admitted batch uniquely projects internal whitespace", async () => {
    const projectedChunks = [
      chunk({ ...chunks[0], content: "TITLE\nU.S. Geological\nSurvey\nRiver,\nA.B.\nTable 1.\tSummary values" }),
      chunk({ ...chunks[1], content: "Suggested citation: River, A.B., 2025,\nA public-safe report.\nhttps://doi.org/10.1234/example" }),
      chunks[2],
    ];
    const projectedPlan = prepareController({
      attemptId: "successor-attempt-projection",
      trialId: "successor-trial-projection",
      predecessorRoleIds: ["v13-attempt-0001"],
      documentValidation,
      documentChunks: projectedChunks,
      batchChunkIds: [[chunkId("a"), chunkId("b")], [chunkId("c")]],
      expectedModel,
      maxOutputTokens: 4096,
    });
    const result = await runController({
      plan: projectedPlan,
      documentChunks: projectedChunks,
      invokeBatch: async () => artifact(response()),
    });
    expect(result.receipt.outcome.classification).toBe("completed");
    expect(result.admissions[0].source_replay.citations).toMatchObject([
      { field: "agency", quote: "U.S. Geological Survey",
        projection: { chunk_quote_match: "unique_source_token_projection" } },
      { field: "publication_citation_excerpt", quote: publication },
      { field: "contributors[0]", quote: "River, A.B." },
      { field: "first_table", quote: "Table 1. Summary values" },
    ]);
    expect(result.source_extraction).toMatchObject({
      status: "complete",
      selected: { publication: { publication_citation_excerpt: publication } },
      citation_evidence: {
        "publication.publication_citation_excerpt": {
          quote: publication,
          chunk_source_excerpt: "Suggested citation: River, A.B., 2025,\nA public-safe report.\nhttps://doi.org/10.1234/example",
          projection: { chunk_quote_match: "unique_source_token_projection" },
          public_citation: { page: 2, quote: publication },
          workspace_citation: {
            chunk_id: chunkId("b"),
            start_utf8_byte: 0,
            end_utf8_byte: Buffer.byteLength(
              "Suggested citation: River, A.B., 2025,\nA public-safe report.\nhttps://doi.org/10.1234/example",
              "utf8",
            ),
            quote_sha256: sha("Suggested citation: River, A.B., 2025,\nA public-safe report.\nhttps://doi.org/10.1234/example"),
          },
        },
      },
      public_citations: {
        "publication.publication_citation_excerpt": { page: 2, quote: publication },
      },
      workspace_citations: {
        "publication.publication_citation_excerpt": {
          chunk_id: chunkId("b"),
          start_utf8_byte: 0,
          end_utf8_byte: Buffer.byteLength(
            "Suggested citation: River, A.B., 2025,\nA public-safe report.\nhttps://doi.org/10.1234/example",
            "utf8",
          ),
          quote_sha256: sha("Suggested citation: River, A.B., 2025,\nA public-safe report.\nhttps://doi.org/10.1234/example"),
        },
      },
      missing_required_paths: [],
    });
  });

  it("admits the one exact fenced-JSON representation through the controller", async () => {
    const payload = JSON.stringify(proposal());
    const bytes = response({ content: `\`\`\`json\n${payload}\n\`\`\`` });
    const result = await runController({
      plan: plan(), documentChunks: chunks, invokeBatch: async () => artifact(bytes),
    });
    expect(result.receipt).toMatchObject({
      observed: { admitted_batches: 1, typed_rejected_batches: 0, model_calls: 1 },
      outcome: { classification: "completed", reason_code: "none" },
    });
    expect(result.admissions[0].content_representation).toEqual({
      kind: "single_lowercase_json_markdown_fence.v1",
      raw_content_sha256: sha(`\`\`\`json\n${payload}\n\`\`\``),
      strict_json_payload: payload,
      strict_json_payload_sha256: sha(payload),
    });
  });

  it.each([
    ["model_output_truncated", response({ content: "{\"agency\":", finishReason: "length" })],
    ["model_response_ambiguous_or_malformed", response({ content: "{\"agency\":null" })],
  ])("isolates a denominator-preserving %s batch and completes the frozen scope", async (reasonCode, bytes) => {
    const result = await runController({
      plan: plan(), documentChunks: chunks, invokeBatch: async () => artifact(bytes),
    });
    expect(result.receipt).toMatchObject({
      denominator: { document_chunks: 3, batches: 2 },
      observed: { batch_outcomes: 2, typed_rejected_batches: 1, model_calls: 1,
        skipped_reference_batches: 1, unattempted_batches: 0 },
      outcome: { classification: "completed", reason_code: "typed_batch_rejections" },
      calculation_evidence: { contributor_count: 0 },
    });
    expect(result.receipt.batch_outcomes[0].response_observation.response_sha256).toBe(sha(bytes));
    expect(result.receipt.batch_outcomes[0].status).toBe(reasonCode);
    expect(result.receipt.batch_outcomes[1].status).toBe("skipped_reference_section");
  });

  it("routes first_table only to the batch containing the classified actual data table", () => {
    const routed = prepareController({
      attemptId: "successor-attempt-routing",
      trialId: "successor-trial-routing",
      documentValidation,
      documentChunks: chunks,
      batchChunkIds: [[chunkId("a")], [chunkId("b")], [chunkId("c")]],
      expectedModel,
      maxOutputTokens: 4096,
    });
    expect(routed.batches[0].policy.allowed_fields).toContain("first_table");
    expect(routed.batches[0].schema.properties.first_table).toHaveProperty("anyOf");
    expect(routed.batches[1].policy.allowed_fields).not.toContain("first_table");
    expect(routed.batches[1].schema.properties.first_table).toEqual({ type: "null" });
    expect(routed.batches[2]).toMatchObject({ action: "skip_reference_section", policy: { allowed_fields: [] } });
  });

  it("continues later source batches after a typed malformed response", async () => {
    const laterChunk = chunk({
      document_id: documentId,
      chunk_id: chunkId("d"),
      page_range: { start_page: 2, end_page: 2 },
      starts_at_heading: false,
      content: publication,
    });
    const continuationChunks = [chunks[0], laterChunk, chunks[2]];
    const continuationValidation = {
      ...documentValidation,
      ordered_chunk_ids: continuationChunks.map(item => item.chunk_id),
    };
    const continuationPlan = prepareController({
      attemptId: "successor-attempt-continuation",
      trialId: "successor-trial-continuation",
      documentValidation: continuationValidation,
      documentChunks: continuationChunks,
      batchChunkIds: [[chunkId("a")], [chunkId("d")], [chunkId("c")]],
      expectedModel,
      maxOutputTokens: 4096,
    });
    let call = 0;
    const result = await runController({
      plan: continuationPlan,
      documentChunks: continuationChunks,
      invokeBatch: async () => {
        call += 1;
        if (call === 1) return artifact(response({ content: "{\"agency\":null" }));
        return artifact(response({ content: JSON.stringify({
          agency: null,
          publication_citation_excerpt: {
            value: publication,
            citation: { chunk_id: chunkId("d"), quote: publication },
          },
          contributors: [],
          first_table: null,
        }) }));
      },
    });
    expect(call).toBe(2);
    expect(result.receipt).toMatchObject({
      observed: { batch_outcomes: 3, admitted_batches: 1, typed_rejected_batches: 1,
        model_calls: 2, unattempted_batches: 0 },
      outcome: { classification: "completed", reason_code: "typed_batch_rejections" },
    });
    expect(result.receipt.batch_outcomes.map(item => item.status)).toEqual([
      "model_response_ambiguous_or_malformed", "admitted", "skipped_reference_section",
    ]);
    expect(result.admissions[0].proposal.publication_citation_excerpt.value)
      .toBe(publication);
  });

  it("halts later batches after a genuine controller failure", async () => {
    const laterChunk = chunk({
      document_id: documentId,
      chunk_id: chunkId("d"),
      page_range: { start_page: 2, end_page: 2 },
      starts_at_heading: false,
      content: "Suggested citation: River, A.B., 2025, A public-safe report.",
    });
    const fatalChunks = [chunks[0], laterChunk, chunks[2]];
    const fatalPlan = prepareController({
      attemptId: "successor-attempt-fatal",
      trialId: "successor-trial-fatal",
      documentValidation: {
        ...documentValidation,
        ordered_chunk_ids: fatalChunks.map(item => item.chunk_id),
      },
      documentChunks: fatalChunks,
      batchChunkIds: [[chunkId("a")], [chunkId("d")], [chunkId("c")]],
      expectedModel,
      maxOutputTokens: 4096,
    });
    const invokeBatch = vi.fn(async () => { throw new Error("synthetic controller fault"); });
    const result = await runController({
      plan: fatalPlan,
      documentChunks: fatalChunks,
      invokeBatch,
    });
    expect(invokeBatch).toHaveBeenCalledTimes(1);
    expect(result.receipt).toMatchObject({
      observed: { batch_outcomes: 1, admitted_batches: 0, typed_rejected_batches: 0,
        model_calls: 0, unattempted_batches: 2 },
      outcome: { classification: "harness_failure", reason_code: "controller_failure" },
      calculation_evidence: null,
    });
  });

  it("retains typed campaign-budget exhaustion before the first document batch", async () => {
    const result = await runController({
      plan: plan(),
      documentChunks: chunks,
      invokeBatch: async () => {
        throw new ModelCallBudgetExhaustedError({ completedRequestCount: 0 });
      },
    });
    expect(result.receipt).toMatchObject({
      contract: { version: 3 },
      observed: { batch_outcomes: 1, model_calls: 0, unattempted_batches: 1 },
      outcome: {
        classification: "harness_failure",
        reason_code: "model_call_budget_exhausted",
        completed_request_count: 0,
      },
      calculation_evidence: null,
      source_extraction: null,
    });
    expect(result.receipt.batch_outcomes[0]).toMatchObject({
      status: "model_call_budget_exhausted",
      model_call_count: 0,
      completed_request_count: 0,
    });
    expect(responseAdmissionControllerFailure(result.receipt)).toMatchObject({
      code: "model_call_budget_exhausted",
      completed_request_count: 0,
      tokens_complete: true,
    });
    const drifted = structuredClone(result.receipt);
    drifted.outcome.completed_request_count = 1;
    expect(() => responseAdmissionControllerFailure(drifted)).toThrow(/digest drifted/u);
  });

  it("preserves the exact campaign count after admitted document batches", async () => {
    const splitPlan = prepareController({
      attemptId: "successor-attempt-budget-mid-document",
      trialId: "successor-trial-budget-mid-document",
      predecessorRoleIds: ["v29-attempt-0001"],
      documentValidation,
      documentChunks: chunks,
      batchChunkIds: [[chunkId("a")], [chunkId("b")], [chunkId("c")]],
      expectedModel,
      maxOutputTokens: 4096,
      contextWindowTokens: 32768,
    });
    let calls = 0;
    const result = await runController({
      plan: splitPlan,
      documentChunks: chunks,
      invokeBatch: async () => {
        calls += 1;
        if (calls === 2) {
          const error = new Error("campaign ceiling reached after retained request 283");
          error.code = "model_call_budget_exhausted";
          error.tokens_complete = true;
          error.completed_request_count = 283;
          throw error;
        }
        return artifact(response());
      },
    });
    expect(calls).toBe(2);
    expect(result.receipt).toMatchObject({
      observed: {
        batch_outcomes: 2,
        admitted_batches: 1,
        model_calls: 1,
        unattempted_batches: 1,
      },
      outcome: {
        classification: "harness_failure",
        reason_code: "model_call_budget_exhausted",
        completed_request_count: 283,
      },
      calculation_evidence: null,
      source_extraction: null,
    });
    expect(result.receipt.batch_outcomes.map(item => item.status)).toEqual([
      "admitted", "model_call_budget_exhausted",
    ]);
    expect(responseAdmissionControllerFailure(result.receipt)).toMatchObject({
      code: "model_call_budget_exhausted",
      completed_request_count: 283,
    });
  });

  it.each([
    ["missing count", error => { delete error.completed_request_count; }],
    ["fractional count", error => { error.completed_request_count = 2.5; }],
    ["unknown token state", error => { error.tokens_complete = false; }],
  ])("does not accept a forged budget signal with %s", async (_label, mutate) => {
    const invokeBatch = async () => {
      const error = new Error("forged budget signal");
      error.code = "model_call_budget_exhausted";
      error.tokens_complete = true;
      error.completed_request_count = 3;
      mutate(error);
      throw error;
    };
    const result = await runController({ plan: plan(), documentChunks: chunks, invokeBatch });
    expect(result.receipt.outcome).toEqual({
      classification: "harness_failure",
      reason_code: "controller_failure",
      message: "forged budget signal",
      completed_request_count: null,
    });
  });

  it.each([
    ["stale chunk", candidate => { candidate.agency.citation.chunk_id = chunkId("f"); }],
    ["cross-document chunk", candidate => { candidate.agency.citation.chunk_id = chunkId("c"); }],
    ["extra citation", candidate => { candidate.agency.citation.quote = "Table 1. Summary values"; }],
  ])("retains safe fields while typing %s in the admitted batch", async (_label, mutate) => {
    const candidate = proposal();
    mutate(candidate);
    const bytes = response({ content: JSON.stringify(candidate) });
    const result = await runController({
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
    expect(result.source_extraction).toMatchObject({
      status: "incomplete",
      missing_required_paths: ["publication.agency"],
      result: null,
    });
  });

  it("rejects forged canonical replay evidence during final materialization", async () => {
    const exactPlan = plan();
    const result = await runController({
      plan: exactPlan, documentChunks: chunks, invokeBatch: async () => artifact(response()),
    });
    const forged = structuredClone(result.admissions);
    forged[0].source_replay.citations[1].quote = "forged publication quote";
    expect(() => materializeAdmittedSourceExtraction({
      plan: exactPlan,
      admissions: forged,
      documentChunks: chunks,
      documentSourcePages: sourcePages,
    })).toThrow(/binding is invalid|does not independently replay|projection drifted/u);
  });

  it("materializes multiple admitted batches only in frozen order", async () => {
    const splitPlan = prepareController({
      attemptId: "successor-attempt-split-materialization",
      trialId: "successor-trial-split-materialization",
      predecessorRoleIds: ["v13-attempt-0001"],
      documentValidation,
      documentChunks: chunks,
      batchChunkIds: [[chunkId("a")], [chunkId("b")], [chunkId("c")]],
      expectedModel,
      maxOutputTokens: 4096,
    });
    const proposals = [{
      agency: proposal().agency,
      publication_citation_excerpt: null,
      contributors: proposal().contributors,
      first_table: proposal().first_table,
    }, {
      agency: null,
      publication_citation_excerpt: proposal().publication_citation_excerpt,
      contributors: [],
      first_table: null,
    }];
    let call = 0;
    const result = await runController({
      plan: splitPlan,
      documentChunks: chunks,
      invokeBatch: async () => artifact(response({ content: JSON.stringify(proposals[call++]) })),
    });
    expect(result.source_extraction).toMatchObject({ status: "complete", missing_required_paths: [] });
    expect(() => materializeAdmittedSourceExtraction({
      plan: splitPlan,
      admissions: [...result.admissions].reverse(),
      documentChunks: chunks,
      documentSourcePages: sourcePages,
    })).toThrow(/frozen batch order/u);
  });

  it("replays the consumed V20 controller-plan version without minting it for new plans", async () => {
    const currentPlan = plan();
    const result = await runController({
      plan: currentPlan, documentChunks: chunks, invokeBatch: async () => artifact(response()),
    });
    for (const version of ["1.3.0-experimental", "1.4.0-experimental"]) {
      const legacyPlan = structuredClone(currentPlan);
      legacyPlan.contract.version = version;
      delete legacyPlan.model_context;
      delete legacyPlan.document_routing;
      delete legacyPlan.denominator.routed_chunks;
      delete legacyPlan.denominator.unrouted_chunks;
      legacyPlan.batches.forEach(batch => { delete batch.context_capacity_observation; });
      delete legacyPlan.plan_sha256;
      legacyPlan.plan_sha256 = sha(canonicalJson(legacyPlan));
      expect(validateControllerPlan({ plan: legacyPlan, documentChunks: chunks })).toBe(legacyPlan);
      expect(materializeAdmittedSourceExtraction({
        plan: legacyPlan,
        admissions: result.admissions,
        documentChunks: chunks,
        documentSourcePages: sourcePages,
      })).toMatchObject({ status: "complete", missing_required_paths: [] });
    }
    for (const version of ["1.5.0-experimental", "1.6.0-experimental"]) {
      const immediatePredecessor = structuredClone(currentPlan);
      immediatePredecessor.contract.version = version;
      delete immediatePredecessor.document_routing;
      delete immediatePredecessor.denominator.routed_chunks;
      delete immediatePredecessor.denominator.unrouted_chunks;
      delete immediatePredecessor.plan_sha256;
      immediatePredecessor.plan_sha256 = sha(canonicalJson(immediatePredecessor));
      expect(validateControllerPlan({ plan: immediatePredecessor, documentChunks: chunks }))
        .toBe(immediatePredecessor);
      expect(materializeAdmittedSourceExtraction({
        plan: immediatePredecessor,
        admissions: result.admissions,
        documentChunks: chunks,
        documentSourcePages: sourcePages,
      })).toMatchObject({ status: "complete", missing_required_paths: [] });
    }
    expect(prepareController({
      attemptId: "fresh-version-check",
      trialId: "fresh-version-check-trial",
      documentValidation,
      documentChunks: chunks,
      batchChunkIds: [[chunkId("a"), chunkId("b")], [chunkId("c")]],
      expectedModel,
      maxOutputTokens: 4096,
      contextWindowTokens: 32768,
    }).contract.version).toBe("1.7.0-experimental");
  });

  it("retains an invocation/controller failure without inventing a model call", async () => {
    const result = await runController({
      plan: plan(), documentChunks: chunks, invokeBatch: async () => { throw new Error("synthetic transport break"); },
    });
    expect(result.receipt).toMatchObject({
      observed: { batch_outcomes: 1, model_calls: 0, unattempted_batches: 1 },
      outcome: { classification: "harness_failure", reason_code: "controller_failure" },
      calculation_evidence: null,
    });
  });

  it("rejects scope, map, plan, role-identity, and raw-artifact drift before admission", async () => {
    expect(() => prepareController({
      attemptId: "v13-attempt-0001", trialId: "successor-trial-0001",
      predecessorRoleIds: ["v13-attempt-0001"], documentValidation, documentChunks: chunks,
      batchChunkIds: [[chunkId("a"), chunkId("b"), chunkId("c")]], expectedModel, maxOutputTokens: 4096,
    })).toThrow(/overlaps a predecessor/u);
    expect(() => prepareController({
      attemptId: "successor-attempt-0001", trialId: "successor-trial-0001",
      documentValidation, documentChunks: chunks,
      batchChunkIds: [[chunkId("a"), chunkId("c")], [chunkId("b")]], expectedModel, maxOutputTokens: 4096,
    })).toThrow();
    const drifted = plan();
    drifted.document_validation.document_map_sha256 = "8".repeat(64);
    expect(() => validateControllerPlan({ plan: drifted, documentChunks: chunks })).toThrow();
    const contextDrift = plan();
    contextDrift.model_context.context_window_tokens += 1;
    delete contextDrift.model_context.binding_sha256;
    contextDrift.model_context.binding_sha256 = sha(canonicalJson(contextDrift.model_context));
    delete contextDrift.plan_sha256;
    contextDrift.plan_sha256 = sha(canonicalJson(contextDrift));
    expect(() => validateControllerPlan({ plan: contextDrift, documentChunks: chunks }))
      .toThrow(/drifted from the exact document chunks/u);
    const bytes = response();
    const wrongArtifact = artifact(bytes);
    wrongArtifact.raw_response_artifact.sha256 = "7".repeat(64);
    const result = await runController({
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
