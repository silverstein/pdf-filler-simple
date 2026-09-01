import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { SHARE_FILES } from "../package-for-friend.js";
import { SERVER_FILES } from "../scripts/build-mcpb.mjs";
import {
  buildSchemaDirectedWorkspaceState,
  buildSourceBoundDocumentValidation,
  deriveRetainedPagePartition,
  finalizeSourceBoundResponsePipelineAttempt,
  prepareSchemaDirectedSourceBoundResponsePipeline,
  prepareSourceBoundResponsePipeline,
  projectSchemaDirectedSourceBoundResponsePipelineResult,
  recoverSchemaDirectedSourceBoundResponsePipelineAttempt,
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
    starts_at_heading: true, content: "TITLE\nBy Alice B. River\nU.S. Geological Survey\nTable 1. Summary values" }),
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
    "TITLE By Alice B. River U.S. Geological Survey Table 1. Summary values",
    `U.S. Geological Survey ${publication}`,
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
  contributors: [{ name: "Alice B. River", citation: { chunk_id: chunkId("a"), quote: "Alice B. River" } }],
  first_table: { page_one_based: 1, anchor_excerpt: "Table 1. Summary values",
    citation: { chunk_id: chunkId("a"), quote: "Table 1. Summary values" } },
});
const response = () => Buffer.from(JSON.stringify({
  id: "synthetic-response",
  model: expectedModel,
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(proposal()) } }],
  usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
}));
const responseForProposal = candidate => Buffer.from(JSON.stringify({
  id: "synthetic-response",
  model: expectedModel,
  choices: [{ index: 0, finish_reason: "stop", message: {
    role: "assistant", content: JSON.stringify(candidate),
  } }],
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
  contextWindowTokens: 32768,
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
      expect(request.messages[1].content)
        .toContain("first source-classified actual data table heading is on physical page 1");
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
        contributors: [{ name: "Alice B. River" }],
        summary: { contributor_count: 1, first_table: { page_one_based: 1 } },
      },
      result: { summary: { contributor_count: 1 } },
      missing_required_paths: [],
    });
    expect(finalizeSourceBoundResponsePipelineAttempt({
      prepared,
      documentChunks: chunks,
      attempt: result,
    })).toEqual({
      extraction_sha256: result.source_extraction.extraction_sha256,
      result: result.source_extraction.result,
      public_citations: result.source_extraction.public_citations,
      workspace_state: {
        publication: result.source_extraction.result.publication,
        contributors: result.source_extraction.result.contributors,
        summary: result.source_extraction.result.summary,
        citations: Object.fromEntries(Object.entries(result.source_extraction.citation_evidence)
          .map(([field, citation]) => [field, {
            page: citation.public_citation.page,
            quote: citation.public_citation.quote,
            ...citation.workspace_citation,
          }])),
      },
    });
  });

  it("routes schema evidence before preparation and projects a completed result from retained source", () => {
    const routed = prepareSchemaDirectedSourceBoundResponsePipeline({
      attemptId: "successor-attempt-0001",
      trialId: "successor-trial-0001",
      predecessorRoleIds: ["baseline-attempt-0001", "baseline-trial-0001"],
      documentId,
      documentMap,
      documentChunks: chunks,
      documentSourcePages: sourcePages,
      expectedModel,
      maxOutputTokens: 4096,
      contextWindowTokens: 32768,
    });
    expect(routed.evidence_plan.selected_chunk_ids).toEqual([chunkId("a"), chunkId("b")]);
    expect(routed.prepared.plan.batches.flatMap(batch => batch.chunk_ids)).toEqual([
      chunkId("a"), chunkId("b"),
    ]);
    expect(routed.prepared.plan.batches.flatMap(batch => batch.chunk_ids)).not.toContain(chunkId("c"));
    expect(routed.prepared.plan).toMatchObject({
      document_routing: routed.evidence_plan,
      denominator: { document_chunks: 3, routed_chunks: 2, unrouted_chunks: 1 },
      benchmark_claim_ready: false,
    });

    const finalized = {
      extraction_sha256: "9".repeat(64),
      result: {
        publication: { agency: "U.S. Geological Survey", publication_citation_excerpt: publication },
        contributors: [{ name: "Alice B. River" }, { name: "Unrelated Reference" }],
        summary: { contributor_count: 2,
          first_table: { page_one_based: 1, anchor_excerpt: "Table 1. Summary values" } },
      },
      public_citations: {},
      workspace_state: {},
    };
    const projected = projectSchemaDirectedSourceBoundResponsePipelineResult({
      evidencePlan: routed.evidence_plan,
      documentChunks: chunks,
      documentTableRegions: tableRegions,
      documentSourcePages: sourcePages,
      finalized,
    });
    expect(projected.canonical_projection.result).toMatchObject({
      contributors: [{ name: "Alice B. River" }],
      summary: { contributor_count: 1, first_table: { page_one_based: 1 } },
    });
    expect(projected.workspace_state).toMatchObject({
      publication: projected.canonical_projection.result.publication,
      contributors: [{ name: "Alice B. River" }],
      summary: projected.canonical_projection.result.summary,
      citations: {
        "publication.agency": {
          page: 1,
          chunk_id: chunkId("a"),
          start_utf8_byte: 0,
          end_utf8_byte: Buffer.byteLength(chunks[0].content, "utf8"),
          quote_sha256: chunks[0].content_sha256,
        },
        "publication.publication_citation_excerpt": {
          page: 2,
          chunk_id: chunkId("b"),
          start_utf8_byte: 0,
          end_utf8_byte: Buffer.byteLength(chunks[1].content, "utf8"),
          quote_sha256: chunks[1].content_sha256,
        },
        "contributors[name=Alice B. River]": { page: 1, chunk_id: chunkId("a") },
        "summary.first_table": { page: 1, chunk_id: chunkId("a") },
      },
    });
    expect(Object.keys(projected.workspace_state.citations).sort())
      .toEqual(Object.keys(projected.canonical_projection.citations).sort());
    expect(JSON.stringify(projected.workspace_state)).not.toContain("Unrelated Reference");
    expect(projected.source_pipeline).toEqual(finalized);
    expect(projected.benchmark_claim_ready).toBe(false);

    const projectionDrift = structuredClone(projected.canonical_projection);
    projectionDrift.citations["publication.agency"].page = 2;
    expect(() => buildSchemaDirectedWorkspaceState({
      canonicalProjection: projectionDrift,
      documentChunks: chunks,
    })).toThrow(/digest drifted/u);

    const redigestProjection = projection => {
      delete projection.projection_sha256;
      projection.projection_sha256 = sha(Buffer.from(canonicalJson(projection), "utf8"));
      return projection;
    };
    const wrongPage = redigestProjection(structuredClone(projected.canonical_projection));
    wrongPage.citations["publication.agency"].page = 2;
    redigestProjection(wrongPage);
    const reboundWorkspace = buildSchemaDirectedWorkspaceState({
      canonicalProjection: wrongPage,
      documentChunks: chunks,
    });
    expect(reboundWorkspace.citations["publication.agency"]).toMatchObject({
      page: 1,
      chunk_id: chunkId("a"),
      quote: chunks[0].content,
      quote_sha256: chunks[0].content_sha256,
    });

    const unsupportedValue = redigestProjection(structuredClone(projected.canonical_projection));
    unsupportedValue.result.publication.agency = "Unsupported Agency";
    redigestProjection(unsupportedValue);
    expect(() => buildSchemaDirectedWorkspaceState({
      canonicalProjection: unsupportedValue,
      documentChunks: chunks,
    })).toThrow(/does not contain its submitted value/u);

    const ambiguousChunk = chunk({
      ...chunks[0],
      chunk_id: chunkId("d"),
    });
    const repeatedSupport = buildSchemaDirectedWorkspaceState({
      canonicalProjection: projected.canonical_projection,
      documentChunks: [...chunks, ambiguousChunk],
    });
    expect(repeatedSupport.citations["publication.agency"].chunk_id).toBe(chunkId("a"));

    const unsupportedChunks = chunks.map(item => ({ ...item }));
    unsupportedChunks[0].content = "TITLE\nNo agency, contributor, or table support remains.";
    unsupportedChunks[0].content_sha256 = sha(Buffer.from(unsupportedChunks[0].content, "utf8"));
    expect(() => buildSchemaDirectedWorkspaceState({
      canonicalProjection: projected.canonical_projection,
      documentChunks: unsupportedChunks,
    })).toThrow(/no source-bound workspace support/u);

    expect(() => buildSchemaDirectedWorkspaceState({
      canonicalProjection: projected.canonical_projection,
      documentChunks: [...chunks.slice(0, 2), { ...chunks[2], document_id: "other-document" }],
    })).toThrow(/span multiple documents/u);

    const contentDrift = structuredClone(chunks);
    contentDrift[0].content += " drift";
    expect(() => buildSchemaDirectedWorkspaceState({
      canonicalProjection: projected.canonical_projection,
      documentChunks: contentDrift,
    })).toThrow(/binding is invalid/u);
  });

  it("recovers missing contributor, citation, and table fields only from retained source evidence", async () => {
    const routed = prepareSchemaDirectedSourceBoundResponsePipeline({
      attemptId: "successor-attempt-0001",
      trialId: "successor-trial-0001",
      predecessorRoleIds: ["baseline-attempt-0001", "baseline-trial-0001"],
      documentId,
      documentMap,
      documentChunks: chunks,
      documentSourcePages: sourcePages,
      expectedModel,
      maxOutputTokens: 4096,
      contextWindowTokens: 32768,
    });
    const incomplete = await runSourceBoundResponsePipelineAttempt({
      prepared: routed.prepared,
      documentChunks: chunks,
      invokeRequest: async ({ batch }) => {
        const candidate = {
          agency: null,
          publication_citation_excerpt: null,
          contributors: [],
          first_table: null,
        };
        if (batch.chunk_ids.includes(chunkId("a"))) {
          candidate.agency = proposal().agency;
          candidate.contributors = [proposal().contributors[0], {
            name: "Stale, S.T.",
            citation: { chunk_id: chunkId("f"), quote: "Stale, S.T." },
          }];
        }
        return artifact(responseForProposal(candidate));
      },
    });
    expect(incomplete.source_extraction).toMatchObject({
      status: "incomplete",
      selected: {
        publication: { agency: "U.S. Geological Survey", publication_citation_excerpt: null },
        contributors: [],
        summary: { first_table: null },
      },
      missing_required_paths: [
        "contributors", "publication.publication_citation_excerpt", "summary.first_table",
      ],
    });

    const recovered = recoverSchemaDirectedSourceBoundResponsePipelineAttempt({
      evidencePlan: routed.evidence_plan,
      prepared: routed.prepared,
      documentChunks: chunks,
      documentTableRegions: tableRegions,
      documentSourcePages: sourcePages,
      attempt: incomplete,
    });
    expect(recovered.finalized).toMatchObject({
      extraction_sha256: incomplete.source_extraction.extraction_sha256,
      result: {
        publication: { agency: "U.S. Geological Survey", publication_citation_excerpt: publication },
        contributors: [{ name: "Alice B. River" }],
        summary: { contributor_count: 1,
          first_table: { page_one_based: 1, anchor_excerpt: "Table 1. Summary values" } },
      },
      public_citations: {
        "contributors[name=Alice B. River]": expect.objectContaining({ page: 1 }),
        "publication.publication_citation_excerpt": expect.objectContaining({ page: 2 }),
        "summary.first_table": expect.objectContaining({ page: 1 }),
      },
    });
    expect(recovered.recovery_receipt).toMatchObject({
      contract: { name: "pdf-tools.schema-directed-source-recovery", version: 1 },
      source_extraction_sha256: incomplete.source_extraction.extraction_sha256,
      recovered_paths: [
        "contributors", "publication.publication_citation_excerpt", "summary.first_table",
      ],
      model_or_provider_calls_made: 0,
      oracle_accessed: false,
      benchmark_claim_ready: false,
    });
    expect(recovered.recovery_receipt.receipt_sha256).toBe(sha(Buffer.from(canonicalJson(
      Object.fromEntries(Object.entries(recovered.recovery_receipt)
        .filter(([key]) => key !== "receipt_sha256")),
    ), "utf8")));

    const projected = projectSchemaDirectedSourceBoundResponsePipelineResult({
      evidencePlan: routed.evidence_plan,
      documentChunks: chunks,
      documentTableRegions: tableRegions,
      documentSourcePages: sourcePages,
      finalized: recovered.finalized,
    });
    expect(projected.canonical_projection.result).toEqual(recovered.finalized.result);
    expect(projected.workspace_state).toEqual(recovered.finalized.workspace_state);

    const admissionDrift = structuredClone(incomplete);
    admissionDrift.admissions[0].submitted_proposal.contributors[0].name = "Substituted Person";
    expect(() => recoverSchemaDirectedSourceBoundResponsePipelineAttempt({
      evidencePlan: routed.evidence_plan,
      prepared: routed.prepared,
      documentChunks: chunks,
      documentTableRegions: tableRegions,
      documentSourcePages: sourcePages,
      attempt: admissionDrift,
    })).toThrow();
  });

  it("fails closed when deterministic recovery lacks exact source-bound authority", async () => {
    const routed = prepareSchemaDirectedSourceBoundResponsePipeline({
      attemptId: "successor-attempt-0001",
      trialId: "successor-trial-0001",
      predecessorRoleIds: ["baseline-attempt-0001", "baseline-trial-0001"],
      documentId,
      documentMap,
      documentChunks: chunks,
      documentSourcePages: sourcePages,
      expectedModel,
      maxOutputTokens: 4096,
      contextWindowTokens: 32768,
    });
    const run = candidate => runSourceBoundResponsePipelineAttempt({
      prepared: routed.prepared,
      documentChunks: chunks,
      invokeRequest: async () => artifact(responseForProposal(candidate)),
    });
    const absentAgency = await run({
      agency: null, publication_citation_excerpt: null, contributors: [], first_table: null,
    });
    expect(() => recoverSchemaDirectedSourceBoundResponsePipelineAttempt({
      evidencePlan: routed.evidence_plan,
      prepared: routed.prepared,
      documentChunks: chunks,
      documentTableRegions: tableRegions,
      documentSourcePages: sourcePages,
      attempt: absentAgency,
    })).toThrow(/non-recoverable required path/u);

    const unsupportedContributor = await run({
      agency: proposal().agency,
      publication_citation_excerpt: null,
      contributors: [{ name: "Stale, S.T.",
        citation: { chunk_id: chunkId("f"), quote: "Stale, S.T." } }],
      first_table: null,
    });
    expect(() => recoverSchemaDirectedSourceBoundResponsePipelineAttempt({
      evidencePlan: routed.evidence_plan,
      prepared: routed.prepared,
      documentChunks: chunks,
      documentTableRegions: tableRegions,
      documentSourcePages: sourcePages,
      attempt: unsupportedContributor,
    })).toThrow(/no complete source-bound display name/u);

    const planDrift = structuredClone(routed.evidence_plan);
    planDrift.byline_page_one_based = 2;
    expect(() => recoverSchemaDirectedSourceBoundResponsePipelineAttempt({
      evidencePlan: planDrift,
      prepared: routed.prepared,
      documentChunks: chunks,
      documentTableRegions: tableRegions,
      documentSourcePages: sourcePages,
      attempt: unsupportedContributor,
    })).toThrow(/evidence plan drifted/u);

    const complete = await run(proposal());
    expect(() => recoverSchemaDirectedSourceBoundResponsePipelineAttempt({
      evidencePlan: routed.evidence_plan,
      prepared: routed.prepared,
      documentChunks: chunks,
      documentTableRegions: tableRegions,
      documentSourcePages: sourcePages,
      attempt: complete,
    })).toThrow(/Only an incomplete source extraction/u);
  });

  it("fails closed when finalized source extraction drifts from its receipt or retained admissions", async () => {
    const prepared = prepare();
    const result = await runSourceBoundResponsePipelineAttempt({
      prepared,
      documentChunks: chunks,
      invokeRequest: async () => artifact(response()),
    });
    const returnedDrift = structuredClone(result);
    returnedDrift.receipt.source_extraction = structuredClone(result.receipt.source_extraction);
    returnedDrift.source_extraction.result.publication.agency = "Substituted agency";
    expect(() => finalizeSourceBoundResponsePipelineAttempt({
      prepared,
      documentChunks: chunks,
      attempt: returnedDrift,
    })).toThrow(/receipt and returned source extraction drifted/u);

    const replayDrift = structuredClone(result);
    replayDrift.source_extraction.workspace_citations["publication.agency"].start_utf8_byte += 1;
    replayDrift.receipt.source_extraction = structuredClone(replayDrift.source_extraction);
    expect(() => finalizeSourceBoundResponsePipelineAttempt({
      prepared,
      documentChunks: chunks,
      attempt: replayDrift,
    })).toThrow(/does not replay from retained admissions/u);
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

  it("splits an oversized multi-chunk request at deterministic chunk boundaries", () => {
    const wideCombined = prepare({ contextWindowTokens: 100000 });
    const wideSingles = prepare({
      contextWindowTokens: 100000,
      batchChunkIds: [[chunkId("a")], [chunkId("b")], [chunkId("c")]],
    });
    const singleCeiling = Math.max(
      wideSingles.plan.batches[0].context_capacity_observation.required_context_tokens_upper_bound,
      wideSingles.plan.batches[1].context_capacity_observation.required_context_tokens_upper_bound,
    );
    expect(wideCombined.plan.batches[0].context_capacity_observation
      .required_context_tokens_upper_bound).toBeGreaterThan(singleCeiling);
    const fitted = prepare({ contextWindowTokens: singleCeiling });
    expect(fitted.plan.batch_chunk_ids).toEqual([
      [chunkId("a")], [chunkId("b")], [chunkId("c")],
    ]);
    expect(fitted.plan.batches.slice(0, 2).every(batch => (
      batch.context_capacity_observation.fits
    ))).toBe(true);
  });

  it("splits a mixed reference and appendix batch before planning model calls", () => {
    const appendixChunks = [
      chunk({ ...chunks[0], content: "TITLE\nU.S. Geological Survey\nRiver, A.B." }),
      chunks[1],
      chunks[2],
      chunk({ document_id: documentId, chunk_id: chunkId("d"),
        page_range: { start_page: 4, end_page: 4 }, starts_at_heading: true,
        content: "Appendix 1. Measurements\nTable 1. Exact appendix values and totals" }),
    ];
    const appendixPageTexts = [
      "TITLE U.S. Geological Survey River, A.B.",
      publication,
      "References Other, A., 2024, An unrelated cited work.",
      "Appendix 1. Measurements Table 1. Exact appendix values and totals",
    ];
    const appendixSourcePagesBody = {
      ...structuredClone(sourcePagesBody),
      source_identity: { ...sourcePagesBody.source_identity, page_count: 4 },
      pages: appendixPageTexts.map((normalizedText, index) => ({
        page_one_based: index + 1,
        normalized_text: normalizedText,
        normalized_text_sha256: sha(normalizedText),
      })),
    };
    const appendixSourcePages = {
      ...appendixSourcePagesBody,
      source_page_text_bundle_sha256: sha(canonicalJson(appendixSourcePagesBody)),
    };
    const appendixMapBody = {
      ...structuredClone(documentMapBody),
      page_count: 4,
      chunks: { descriptors: appendixChunks.map(item => ({ chunk_id: item.chunk_id })) },
    };
    const appendixMap = withDocumentMapDigest(appendixMapBody);
    const prepared = prepare({
      documentMap: appendixMap,
      documentChunks: appendixChunks,
      documentSourcePages: appendixSourcePages,
      batchChunkIds: [[chunkId("a"), chunkId("b")], [chunkId("c"), chunkId("d")]],
    });
    expect(prepared.plan.batch_chunk_ids).toEqual([
      [chunkId("a"), chunkId("b")], [chunkId("c")], [chunkId("d")],
    ]);
    expect(prepared.plan.batches.map(batch => batch.action)).toEqual([
      "model_call", "skip_reference_section", "model_call",
    ]);
    expect(prepared.plan.batches[2].policy).toMatchObject({
      allowed_fields: expect.arrayContaining(["first_table"]),
      first_actual_table: { page_one_based: 4, chunk_id: chunkId("d") },
    });
  });

  it("retains a typed zero-call rejection when one chunk cannot fit", async () => {
    const prepared = prepare({
      contextWindowTokens: 4097,
      batchChunkIds: [[chunkId("a")], [chunkId("b")], [chunkId("c")]],
    });
    const invokeRequest = vi.fn();
    const result = await runSourceBoundResponsePipelineAttempt({
      prepared,
      documentChunks: chunks,
      invokeRequest,
    });
    expect(invokeRequest).not.toHaveBeenCalled();
    expect(result.receipt).toMatchObject({
      outcome: { classification: "completed", reason_code: "typed_batch_rejections" },
      observed: { model_calls: 0, typed_rejected_batches: 2, skipped_reference_batches: 1 },
      benchmark_claim_ready: false,
    });
    expect(result.receipt.batch_outcomes.slice(0, 2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "model_context_capacity_exceeded", model_call_count: 0,
        response_observation: expect.objectContaining({ fits: false, model_or_provider_calls_made: 0 }) }),
    ]));
    expect(result.source_extraction).toMatchObject({
      status: "incomplete",
      result: null,
    });
    expect(() => finalizeSourceBoundResponsePipelineAttempt({
      prepared,
      documentChunks: chunks,
      attempt: result,
    })).toThrow(expect.objectContaining({
      code: "incomplete_extraction",
      missing_required_paths: [
        "contributors", "publication.agency", "publication.publication_citation_excerpt", "summary.first_table",
      ],
    }));
  });

  it("preserves campaign-budget exhaustion across the request callback boundary", async () => {
    const prepared = prepare();
    const result = await runSourceBoundResponsePipelineAttempt({
      prepared,
      documentChunks: chunks,
      invokeRequest: async () => {
        const error = new Error("frozen campaign call ceiling exhausted");
        error.code = "model_call_budget_exhausted";
        error.tokens_complete = true;
        error.completed_request_count = 283;
        throw error;
      },
    });
    expect(result.receipt).toMatchObject({
      observed: { model_calls: 0, unattempted_batches: 1 },
      outcome: {
        classification: "harness_failure",
        reason_code: "model_call_budget_exhausted",
        completed_request_count: 283,
      },
      source_extraction: null,
    });
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

  it.each([
    ["before document work", [], { processed_page_numbers: [],
      unprocessed_page_numbers: [1, 2, 3, 4, 5] }],
    ["during the first batch", [1, 2], { processed_page_numbers: [1, 2],
      unprocessed_page_numbers: [3, 4, 5] }],
    ["after later successful batches", [1, 2, 3, 4], { processed_page_numbers: [1, 2, 3, 4],
      unprocessed_page_numbers: [5] }],
  ])("derives a truthful retained-page partition at budget exhaustion %s", (_label, retained, expected) => {
    expect(deriveRetainedPagePartition({
      pageCount: 5,
      retainedPageNumbers: retained,
      aggregateTraceRetained: true,
    })).toEqual(expected);
  });

  it("clears processed pages when the aggregate trace is not retained", () => {
    expect(deriveRetainedPagePartition({
      pageCount: 5,
      retainedPageNumbers: [1, 2, 3],
      aggregateTraceRetained: false,
    })).toEqual({
      processed_page_numbers: [],
      unprocessed_page_numbers: [1, 2, 3, 4, 5],
    });
    for (const retainedPageNumbers of [[2, 1], [1, 1], [0], [6]]) {
      expect(() => deriveRetainedPagePartition({
        pageCount: 5,
        retainedPageNumbers,
        aggregateTraceRetained: true,
      })).toThrow();
    }
  });

  it("remains internal experimental source", () => {
    expect(VERIFIED_EXTRACTION_RESPONSE_PIPELINE_POLICY.version).toBe("1.5.0-experimental");
    expect(SERVER_FILES).not.toContain("verified-extraction-response-pipeline.mjs");
    expect(SHARE_FILES).not.toContain("scripts/verified-extraction-response-pipeline.mjs");
  });
});
