import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SHARE_FILES } from "../package-for-friend.js";
import { SERVER_FILES } from "../scripts/build-mcpb.mjs";
import {
  admitStructuredModelResponse,
  buildNormalizedSourcePageBundle,
  buildVerifiedExtractionProposalSchema,
  classifySourceBoundBatch,
  compareAdmittedCitationEvidence,
  MAX_ADMITTED_CONTRIBUTORS,
  ModelOutputAdmissionError,
  parseModelResponseProposalContent,
  VERIFIED_EXTRACTION_RESPONSE_ADMISSION_POLICY,
} from "../scripts/verified-extraction-response-admission.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const shapes = JSON.parse(fs.readFileSync(path.join(
  ROOT, "fixtures", "eval", "verified-extraction-response-admission", "v13-malformed-response-shapes.v1.json",
), "utf8"));
const MODEL = "oda-local-model";
const DOCUMENT = "public-safe-document";
const DOCUMENT_MAP_SHA256 = "9".repeat(64);
const SOURCE_SHA256 = "1".repeat(64);
const PUBLICATION = "Suggested citation: River, A.B., 2025, A public-safe report. https://doi.org/10.1234/example";
const id = character => `chunk.${character.repeat(64)}`;
const contentSha = content => createHash("sha256").update(content).digest("hex");
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const chunk = value => ({ ...value, content_sha256: contentSha(value.content) });
const chunks = [
  chunk({
    document_id: DOCUMENT,
    chunk_id: id("a"),
    page_range: { start_page: 1, end_page: 1 },
    starts_at_heading: true,
    content: "TITLE\nU.S. Geological Survey\nRiver, A.B.\nTable 1. Summary values",
  }),
  chunk({
    document_id: DOCUMENT,
    chunk_id: id("b"),
    page_range: { start_page: 2, end_page: 2 },
    starts_at_heading: false,
    content: PUBLICATION,
  }),
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
const sourcePages = (pageTexts = [
  "TITLE U.S. Geological Survey River, A.B. Table 1. Summary values",
  PUBLICATION,
]) => {
  const body = {
    version: 1,
    scheme: "verified-extraction-normalized-source-pages.v1",
    document_id: DOCUMENT,
    source_identity: {
      pdf_sha256: SOURCE_SHA256,
      page_count: pageTexts.length,
      pdfjs_package_sha256: "7".repeat(64),
      normalization: "unicode_whitespace_runs_to_ascii_space_then_trim",
    },
    pages: pageTexts.map((normalizedText, index) => ({
      page_one_based: index + 1,
      normalized_text: normalizedText,
      normalized_text_sha256: contentSha(normalizedText),
    })),
  };
  return { ...body, source_page_text_bundle_sha256: contentSha(canonical(body)) };
};
const SOURCE_PAGES = sourcePages();

const proposal = () => ({
  agency: {
    value: "U.S. Geological Survey",
    citation: { chunk_id: id("a"), quote: "U.S. Geological Survey" },
  },
  publication_citation_excerpt: {
    value: PUBLICATION,
    citation: { chunk_id: id("b"), quote: PUBLICATION },
  },
  contributors: [{
    name: "River, A.B.",
    citation: { chunk_id: id("a"), quote: "River, A.B." },
  }],
  first_table: {
    page_one_based: 1,
    anchor_excerpt: "Table 1. Summary values",
    citation: { chunk_id: id("a"), quote: "Table 1. Summary values" },
  },
});

function response({ content = JSON.stringify(proposal()), finishReason = "stop", completionTokens = 200,
  model = MODEL } = {}) {
  return Buffer.from(JSON.stringify({
    id: "synthetic-response",
    model,
    choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content } }],
    usage: { prompt_tokens: 100, completion_tokens: completionTokens, total_tokens: 100 + completionTokens },
  }));
}

const batchChunkIds = chunks.map(chunk => chunk.chunk_id);
const classification = (overrides = {}) => classifySourceBoundBatch({
  documentId: DOCUMENT, documentMapSha256: DOCUMENT_MAP_SHA256, sourceSha256: SOURCE_SHA256,
  documentChunks: chunks, documentTableRegions: tableRegions, documentSourcePages: SOURCE_PAGES,
  batchChunkIds,
  ...overrides,
});
const policy = () => classification();
const admit = overrides => admitStructuredModelResponse({
  responseBytes: response(),
  expectedModel: MODEL,
  maxOutputTokens: 4096,
  documentId: DOCUMENT,
  documentMapSha256: DOCUMENT_MAP_SHA256,
  sourceSha256: SOURCE_SHA256,
  documentChunks: chunks,
  documentTableRegions: tableRegions,
  documentSourcePages: SOURCE_PAGES,
  batchChunkIds,
  batchPolicy: policy(),
  ...overrides,
});
const compare = overrides => compareAdmittedCitationEvidence({
  documentChunks: chunks,
  documentSourcePages: SOURCE_PAGES,
  batchPolicy: policy(),
  ...overrides,
});

describe("verified extraction response admission", () => {
  it("derives the scorer-compatible canonical source-page bundle from complete retained PDF.js items", () => {
    const sourceBytes = Buffer.from("synthetic-pdf-bytes");
    const pdfjsPackageBytes = Buffer.from(JSON.stringify({ name: "pdfjs-dist", version: "5.4.624" }));
    const derived = buildNormalizedSourcePageBundle({
      documentId: DOCUMENT,
      sourceBytes,
      pdfjsPackageBytes,
      layouts: [{
        source: { sha256: contentSha(sourceBytes) },
        parser: { name: "pdfjs-dist", version: "5.4.624" },
        page_range: { total_pages: 3 },
        pages: [
          { page: 1, raw_items: [
            { source_index: 0, text: "U.S. Geological Survey" },
            { source_index: 1, text: " , " },
            { source_index: 2, text: "Report" },
          ], counts: { observed_items: 3, returned_items: 3 }, truncation: { omitted_items: 0 } },
          { page: 2, raw_items: [
            { source_index: 0, text: "recovered", source_text: "original" },
          ], counts: { observed_items: 1, returned_items: 1 }, truncation: { omitted_items: 0 } },
          { page: 3, raw_items: [], counts: { observed_items: 0, returned_items: 0 },
            truncation: { omitted_items: 0 } },
        ],
      }],
    });
    expect(derived).toMatchObject({
      document_id: DOCUMENT,
      source_identity: {
        pdf_sha256: contentSha(sourceBytes),
        pdfjs_package_sha256: contentSha(pdfjsPackageBytes),
        page_count: 3,
      },
      pages: [
        { page_one_based: 1, normalized_text: "U.S. Geological Survey , Report" },
        { page_one_based: 2, normalized_text: "original" },
        { page_one_based: 3, normalized_text: "" },
      ],
      source_page_text_bundle_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const truncated = structuredClone({
      source: { sha256: contentSha(sourceBytes) },
      parser: { name: "pdfjs-dist", version: "5.4.624" },
      page_range: { total_pages: 1 },
      pages: [{ page: 1, raw_items: [], counts: { observed_items: 1, returned_items: 0 },
        truncation: { omitted_items: 1 } }],
    });
    expect(() => buildNormalizedSourcePageBundle({
      documentId: DOCUMENT, sourceBytes, pdfjsPackageBytes, layouts: [truncated],
    })).toThrow(/complete PDF\.js text-item denominator/u);
  });

  it("admits one strict complete source-replayed proposal and derives its count", () => {
    const result = admit();
    expect(result).toMatchObject({
      document_id: DOCUMENT,
      batch_policy_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      observation: { finish_reason: "stop", output_truncated: false },
      source_replay: {
        citation_count: 4,
        contributor_count: 1,
        contributor_count_derivation: "derived_from_admitted_contributors_not_model_arithmetic",
      },
      benchmark_claim_ready: false,
      package_inclusion: "disabled_experimental",
    });
    expect(result.source_replay.citations.every(item => item.document_id === DOCUMENT)).toBe(true);
    expect(result.content_representation).toEqual({
      kind: "direct_strict_json",
      raw_content_sha256: contentSha(JSON.stringify(proposal())),
      strict_json_payload: JSON.stringify(proposal()),
      strict_json_payload_sha256: contentSha(JSON.stringify(proposal())),
    });
  });

  it("admits one exact lowercase-json fence and binds raw and payload representations", () => {
    const payload = JSON.stringify(proposal());
    const content = `\`\`\`json\n${payload}\n\`\`\``;
    const result = admit({ responseBytes: response({ content }) });
    expect(result.proposal).toEqual(proposal());
    expect(result.content_representation).toEqual({
      kind: "single_lowercase_json_markdown_fence.v1",
      raw_content_sha256: contentSha(content),
      strict_json_payload: payload,
      strict_json_payload_sha256: contentSha(payload),
    });
    expect(result.observation.content_sha256).toBe(contentSha(content));
  });

  it.each([
    ["generic fence", payload => `\`\`\`\n${payload}\n\`\`\``],
    ["uppercase language", payload => `\`\`\`JSON\n${payload}\n\`\`\``],
    ["leading whitespace", payload => ` \`\`\`json\n${payload}\n\`\`\``],
    ["trailing whitespace", payload => `\`\`\`json\n${payload}\n\`\`\`\n`],
    ["missing opening newline", payload => `\`\`\`json${payload}\n\`\`\``],
    ["missing closing newline", payload => `\`\`\`json\n${payload}\`\`\``],
    ["trailing prose", payload => `\`\`\`json\n${payload}\n\`\`\`\nDone`],
    ["multiple fences", payload => `\`\`\`json\n${payload}\n\`\`\`\n\`\`\`json\n${payload}\n\`\`\``],
    ["nested fence", payload => `\`\`\`json\n${payload.slice(0, -1)},"note":"\`\`\`"}\n\`\`\``],
  ])("rejects %s as an unsupported response representation", (_label, wrap) => {
    const content = wrap(JSON.stringify(proposal()));
    expect(() => parseModelResponseProposalContent(content)).toThrow();
    expect(() => admit({ responseBytes: response({ content }) })).toThrow();
  });

  it("rejects duplicate members and malformed JSON inside the exact fence", () => {
    const duplicate = JSON.stringify(proposal()).replace(
      `"name":"River, A.B."`,
      `"name":"Unsupported","name":"River, A.B."`,
    );
    expect(() => parseModelResponseProposalContent(`\`\`\`json\n${duplicate}\n\`\`\``))
      .toThrow(/duplicate object key "name"/u);
    expect(() => parseModelResponseProposalContent("```json\n{\"agency\":null\n```"))
      .toThrow();
  });

  it("retains submitted text and the unique exact source bytes for internal-whitespace projection", () => {
    const whitespaceChunks = [
      chunk({
        ...chunks[0],
        content: "TITLE\nU.S. Geological\n\tSurvey\nRiver,\nA.B.\nTable 1.\tSummary values",
      }),
      chunk({
        ...chunks[1],
        content: "Suggested citation:\nRiver, A.B., 2025,\nA public-safe report.\nhttps://doi.org/10.1234/example",
      }),
    ];
    const candidate = proposal();
    const whitespacePolicy = classification({
      documentId: DOCUMENT,
      documentMapSha256: DOCUMENT_MAP_SHA256,
      documentChunks: whitespaceChunks,
      documentTableRegions: tableRegions,
      batchChunkIds,
    });
    const result = admit({
      documentChunks: whitespaceChunks,
      batchPolicy: whitespacePolicy,
      responseBytes: response({ content: JSON.stringify(candidate) }),
    });
    expect(result.contract.version).toBe("1.6.0-experimental");
    expect(result.first_table_evidence).toMatchObject({
      document_table_regions_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      region: { region_id: "p1-t1", page: 1 },
      region_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(result.source_replay.citations).toMatchObject([
      {
        field: "agency",
        quote: "U.S. Geological Survey",
        submitted_quote: "U.S. Geological Survey",
        claim_source_excerpt: "U.S. Geological Survey",
        projection: {
          policy: "chunk-plus-canonical-source-page-token-projection.v1",
          canonical_page_quote_match: "exact",
          canonical_page_claim_match: "exact",
          chunk_quote_match: "unique_source_token_projection",
          chunk_claim_match: "unique_source_token_projection",
        },
      },
      {
        field: "publication_citation_excerpt",
        quote: PUBLICATION,
        submitted_quote: PUBLICATION,
      },
      {
        field: "contributors[0]",
        quote: "River, A.B.",
        submitted_quote: "River, A.B.",
      },
      {
        field: "first_table",
        quote: "Table 1. Summary values",
        submitted_quote: "Table 1. Summary values",
      },
    ]);
    expect(compare({ admission: result, batchPolicy: whitespacePolicy,
      documentChunks: whitespaceChunks, oracleCitations: [] })
      .primary_source_replay).toEqual({ numerator: 4, denominator: 4, complete: true });
  });

  it("canonicalizes renderer punctuation spacing to the exact source-page span", () => {
    const canonicalPublication = "Suggested citation: River , A.B., 2025, A public-safe report. https://doi.org/10.1234/example";
    const punctuationPages = sourcePages([
      SOURCE_PAGES.pages[0].normalized_text,
      canonicalPublication,
    ]);
    const punctuationPolicy = classification({ documentSourcePages: punctuationPages });
    const result = admit({
      documentSourcePages: punctuationPages,
      batchPolicy: punctuationPolicy,
    });
    expect(result.submitted_proposal.publication_citation_excerpt.value).toBe(PUBLICATION);
    expect(result.proposal.publication_citation_excerpt).toEqual({
      value: canonicalPublication,
      citation: { chunk_id: id("b"), quote: canonicalPublication },
    });
    expect(result.source_replay.citations[1]).toMatchObject({
      quote: canonicalPublication,
      submitted_quote: PUBLICATION,
      projection: { canonical_page_quote_match: "unique_source_token_projection" },
    });
    expect(() => compare({
      admission: result,
      batchPolicy: punctuationPolicy,
      documentSourcePages: punctuationPages,
      oracleCitations: [],
    })).not.toThrow();
  });

  it.each([
    ["non-whitespace claim drift", candidate => {
      candidate.agency.value = "U.S. Geologic Survey";
    }],
    ["leading submitted whitespace", candidate => {
      candidate.agency.citation.quote = " U.S. Geological Survey";
    }],
    ["whitespace inserted where the source has none", candidate => {
      candidate.agency.value = "U.S. Geo logical Survey";
    }],
  ])("types %s as a field rejection instead of normalizing it", (_label, mutate) => {
    const candidate = proposal();
    mutate(candidate);
    const result = admit({ responseBytes: response({ content: JSON.stringify(candidate) }) });
    expect(result.proposal.agency).toBeNull();
    expect(result.field_outcomes.agency).toMatchObject({
      status: "rejected", reason_code: "not_source_bound", citation_count: 0,
    });
    expect(result.proposal.publication_citation_excerpt).toEqual(proposal().publication_citation_excerpt);
    expect(compare({ admission: result, oracleCitations: [] })
      .primary_source_replay.denominator).toBe(3);
  });

  it("rejects a citation that has more than one exact or whitespace-equivalent source span", () => {
    const duplicateChunks = [
      chunk({ ...chunks[0], content: `${chunks[0].content}\nU.S. Geological\nSurvey` }),
      chunks[1],
    ];
    const duplicatePolicy = classification({
      documentId: DOCUMENT,
      documentMapSha256: DOCUMENT_MAP_SHA256,
      documentChunks: duplicateChunks,
      documentTableRegions: tableRegions,
      batchChunkIds,
    });
    const result = admit({
      documentChunks: duplicateChunks,
      batchPolicy: duplicatePolicy,
      responseBytes: response(),
    });
    expect(result.field_outcomes.agency).toMatchObject({ status: "rejected", message: expect.stringMatching(/ambiguous/u) });
    expect(result.proposal.agency).toBeNull();
  });

  it("counts overlapping source spans as ambiguity", () => {
    const overlappingChunks = [chunk({ ...chunks[0], content: `${chunks[0].content}\nA A A` }), chunks[1]];
    const candidate = proposal();
    candidate.agency = { value: "A A", citation: { chunk_id: id("a"), quote: "A A" } };
    const result = admit({
      documentChunks: overlappingChunks,
      batchPolicy: classification({
        documentId: DOCUMENT,
        documentMapSha256: DOCUMENT_MAP_SHA256,
        documentChunks: overlappingChunks,
        documentTableRegions: tableRegions,
        batchChunkIds,
      }),
      responseBytes: response({ content: JSON.stringify(candidate) }),
    });
    expect(result.field_outcomes.agency).toMatchObject({ status: "rejected", message: expect.stringMatching(/ambiguous/u) });
  });

  it("searches a bounded full chunk without applying the smaller submitted-quote limit", () => {
    const longChunks = [
      chunk({ ...chunks[0], content: `${"x".repeat(5000)}\n${chunks[0].content}` }),
      chunks[1],
    ];
    const longPolicy = classification({
      documentId: DOCUMENT,
      documentMapSha256: DOCUMENT_MAP_SHA256,
      documentChunks: longChunks,
      documentTableRegions: tableRegions,
      batchChunkIds,
    });
    expect(admit({ documentChunks: longChunks, batchPolicy: longPolicy }).source_replay.citation_count).toBe(4);
  });

  it("scores source replay as primary and exact oracle span equality as secondary", () => {
    const candidate = proposal();
    candidate.agency.citation.quote = "TITLE\nU.S. Geological Survey";
    const admission = admit({ responseBytes: response({ content: JSON.stringify(candidate) }) });
    const comparison = compare({
      admission,
      oracleCitations: [
        { document_id: DOCUMENT, document_map_sha256: DOCUMENT_MAP_SHA256,
          page_one_based: 1, quote: "U.S. Geological Survey" },
        { document_id: DOCUMENT, document_map_sha256: DOCUMENT_MAP_SHA256,
          page_one_based: 2, quote: PUBLICATION },
        { document_id: DOCUMENT, document_map_sha256: DOCUMENT_MAP_SHA256,
          page_one_based: 1, quote: "River, A.B." },
        { document_id: DOCUMENT, document_map_sha256: DOCUMENT_MAP_SHA256,
          page_one_based: 1, quote: "Table 1. Summary values" },
      ],
    });
    expect(comparison).toEqual({
      primary_source_replay: { numerator: 4, denominator: 4, complete: true },
      secondary_exact_oracle_span: { numerator: 3, denominator: 4, complete: false },
      exact_oracle_span_is_source_support_gate: false,
      benchmark_claim_ready: false,
    });
  });

  it("replays all 17 observed malformed shapes as typed output-cap truncation", () => {
    expect(shapes.shapes).toHaveLength(17);
    for (const shape of shapes.shapes) {
      try {
        admit({ responseBytes: response({
          content: `{"agency":null,"publication_citation_excerpt":null,"contributors":[{"name":"cut-${shape.id}`,
          finishReason: shape.finish_reason,
          completionTokens: shape.completion_tokens,
        }) });
        throw new Error("expected truncation rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(ModelOutputAdmissionError);
        expect(error.code).toBe(shapes.expected_failure_code);
        expect(error.observation).toMatchObject({
          document_id: DOCUMENT,
          document_map_sha256: DOCUMENT_MAP_SHA256,
          batch_policy_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          finish_reason: "length",
          max_output_tokens: shapes.max_output_tokens,
          usage: { output_tokens: 4096 },
          output_truncated: true,
        });
        expect(error.observation.content_sha256).toMatch(/^[a-f0-9]{64}$/u);
      }
    }
  });

  it("rejects duplicate members in the outer envelope and every proposal depth", () => {
    const outer = Buffer.from(`{"model":"${MODEL}","model":"${MODEL}","choices":[],"usage":{}}`);
    expect(() => admit({ responseBytes: outer })).toThrow(/duplicate object key "model"/u);

    const clean = proposal();
    const nested = JSON.stringify(clean).replace(
      `"name":"River, A.B."`,
      `"name":"Unsupported","name":"River, A.B."`,
    );
    expect(() => admit({ responseBytes: response({ content: nested }) })).toThrow(/duplicate object key "name"/u);
  });

  it("classifies reference sections and makes them model-call ineligible", () => {
    const referenceChunks = [chunk({
      document_id: DOCUMENT,
      chunk_id: id("c"),
      page_range: { start_page: 9, end_page: 9 },
      starts_at_heading: true,
      content: "References Cited\nOther, A., 2024, An unrelated cited work.",
    })];
    const fullDocument = [...chunks, ...referenceChunks, chunk({
      document_id: DOCUMENT,
      chunk_id: id("e"),
      page_range: { start_page: 10, end_page: 10 },
      starts_at_heading: false,
      content: "Other, B., 2023, A second unrelated cited work.",
    })];
    const referencePolicy = classification({
      documentId: DOCUMENT,
      documentMapSha256: DOCUMENT_MAP_SHA256,
      documentChunks: fullDocument,
      documentTableRegions: tableRegions,
      documentSourcePages: sourcePages(Array.from({ length: 10 }, (_, index) => (
        index === 0 ? SOURCE_PAGES.pages[0].normalized_text
          : index === 1 ? PUBLICATION
            : index === 8 ? "References Cited Other, A., 2024, An unrelated cited work."
              : index === 9 ? "Other, B., 2023, A second unrelated cited work."
                : `Source page ${index + 1}`
      ))),
      batchChunkIds: [id("e")],
    });
    expect(referencePolicy).toMatchObject({
      allowed_fields: [],
      model_call_recommended: false,
      batch_chunk_ids: [id("e")],
    });
    expect(() => admitStructuredModelResponse({
      responseBytes: response({ content: JSON.stringify({
        agency: null,
        publication_citation_excerpt: null,
        contributors: [{
          name: "Other, A.", citation: { chunk_id: id("c"), quote: "Other, A." },
        }],
        first_table: null,
      }) }),
      expectedModel: MODEL,
      maxOutputTokens: 4096,
      documentId: DOCUMENT,
      documentMapSha256: DOCUMENT_MAP_SHA256,
      sourceSha256: SOURCE_SHA256,
      documentChunks: fullDocument,
      documentTableRegions: tableRegions,
      documentSourcePages: sourcePages(Array.from({ length: 10 }, (_, index) => (
        index === 0 ? SOURCE_PAGES.pages[0].normalized_text
          : index === 1 ? PUBLICATION
            : index === 8 ? "References Cited Other, A., 2024, An unrelated cited work."
              : index === 9 ? "Other, B., 2023, A second unrelated cited work."
                : `Source page ${index + 1}`
      ))),
      batchChunkIds: [id("e")],
      batchPolicy: referencePolicy,
    })).toThrow(/not admitted for a reference-section batch/u);
  });

  it.each([
    ["stale chunk", "agency", candidate => { candidate.agency.citation.chunk_id = id("f"); }],
    ["quote absent from exact chunk", "agency", candidate => { candidate.agency.citation.quote = "USGS"; }],
    ["extra citation unrelated to value", "agency", candidate => {
      candidate.agency.citation.quote = "Table 1. Summary values";
    }],
    ["table page drift", "first_table", candidate => { candidate.first_table.page_one_based = 2; }],
  ])("retains safe fields while typing %s", (_label, field, mutate) => {
    const candidate = proposal();
    mutate(candidate);
    const result = admit({
      documentChunks: chunks,
      batchChunkIds,
      batchPolicy: policy(),
      responseBytes: response({ content: JSON.stringify(candidate) }),
    });
    expect(result.field_outcomes[field]).toMatchObject({ status: "rejected", reason_code: "not_source_bound" });
    expect(result.proposal[field]).toEqual(field === "contributors" ? [] : null);
    expect(result.source_replay.citation_count).toBe(3);
    expect(() => compare({ admission: result, oracleCitations: [] })).not.toThrow();
  });

  it("rejects a contents-page table reference even when its cited chunk and proposed source page agree", () => {
    const contentsChunk = chunk({
      document_id: DOCUMENT,
      chunk_id: id("c"),
      page_range: { start_page: 7, end_page: 7 },
      starts_at_heading: true,
      content: "Contents\nTable 1. Summary values .......... 12",
    });
    const actualTableChunk = chunk({
      document_id: DOCUMENT,
      chunk_id: id("d"),
      page_range: { start_page: 6, end_page: 6 },
      starts_at_heading: false,
      content: "Table 1. Summary values\nColumn A Column B",
    });
    const scopedChunks = [actualTableChunk, contentsChunk];
    const scopedRegions = structuredClone(tableRegions);
    scopedRegions.items[0].region_id = "p6-t1";
    scopedRegions.items[0].page = 6;
    const candidate = {
      agency: null,
      publication_citation_excerpt: null,
      contributors: [],
      first_table: {
        page_one_based: 7,
        anchor_excerpt: "Table 1. Summary values",
        citation: { chunk_id: id("c"), quote: "Table 1. Summary values .......... 12" },
      },
    };
    const scopedPolicy = classification({
      documentId: DOCUMENT,
      documentMapSha256: DOCUMENT_MAP_SHA256,
      documentChunks: scopedChunks,
      documentTableRegions: scopedRegions,
      documentSourcePages: sourcePages(Array.from({ length: 7 }, (_, index) => (
        index === 5 ? "Table 1. Summary values Column A Column B"
          : index === 6 ? "Contents Table 1. Summary values .......... 12"
            : `Source page ${index + 1}`
      ))),
      batchChunkIds: scopedChunks.map(item => item.chunk_id),
    });
    const result = admitStructuredModelResponse({
      responseBytes: response({ content: JSON.stringify(candidate) }),
      expectedModel: MODEL,
      maxOutputTokens: 4096,
      documentId: DOCUMENT,
      documentMapSha256: DOCUMENT_MAP_SHA256,
      sourceSha256: SOURCE_SHA256,
      documentChunks: scopedChunks,
      documentTableRegions: scopedRegions,
      documentSourcePages: sourcePages(Array.from({ length: 7 }, (_, index) => (
        index === 5 ? "Table 1. Summary values Column A Column B"
          : index === 6 ? "Contents Table 1. Summary values .......... 12"
            : `Source page ${index + 1}`
      ))),
      batchChunkIds: scopedChunks.map(item => item.chunk_id),
      batchPolicy: scopedPolicy,
    });
    expect(result.proposal.first_table).toBeNull();
    expect(result.first_table_evidence).toBeNull();
    expect(result.field_outcomes.first_table).toMatchObject({
      status: "rejected",
      message: expect.stringMatching(/first classified actual data table/u),
    });

    candidate.first_table.page_one_based = 6;
    candidate.first_table.citation = { chunk_id: id("d"), quote: "Table 1. Summary values" };
    const actual = admitStructuredModelResponse({
      responseBytes: response({ content: JSON.stringify(candidate) }),
      expectedModel: MODEL,
      maxOutputTokens: 4096,
      documentId: DOCUMENT,
      documentMapSha256: DOCUMENT_MAP_SHA256,
      sourceSha256: SOURCE_SHA256,
      documentChunks: scopedChunks,
      documentTableRegions: scopedRegions,
      documentSourcePages: sourcePages(Array.from({ length: 7 }, (_, index) => (
        index === 5 ? "Table 1. Summary values Column A Column B"
          : index === 6 ? "Contents Table 1. Summary values .......... 12"
            : `Source page ${index + 1}`
      ))),
      batchChunkIds: scopedChunks.map(item => item.chunk_id),
      batchPolicy: scopedPolicy,
    });
    expect(actual.proposal.first_table.page_one_based).toBe(6);
    expect(actual.first_table_evidence).toMatchObject({ region: { region_id: "p6-t1", page: 6 } });
    expect(() => compare({
      admission: actual,
      batchPolicy: scopedPolicy,
      documentChunks: scopedChunks,
      documentSourcePages: sourcePages(Array.from({ length: 7 }, (_, index) => (
        index === 5 ? "Table 1. Summary values Column A Column B"
          : index === 6 ? "Contents Table 1. Summary values .......... 12"
            : `Source page ${index + 1}`
      ))),
      oracleCitations: [],
    })).not.toThrow();
  });

  it("skips an earlier contents-page table region and selects the first actual Table 1 heading", () => {
    const contentsChunk = chunk({
      document_id: DOCUMENT,
      chunk_id: id("c"),
      page_range: { start_page: 6, end_page: 6 },
      starts_at_heading: true,
      content: "Contents\nTable 1. Summary values .......... 12",
    });
    const actualChunk = chunk({
      document_id: DOCUMENT,
      chunk_id: id("d"),
      page_range: { start_page: 7, end_page: 7 },
      starts_at_heading: true,
      content: "Table 1. Actual measurements and sample totals\nColumn A Column B",
    });
    const scopedChunks = [contentsChunk, actualChunk];
    const scopedRegions = structuredClone(tableRegions);
    scopedRegions.observed = 2;
    scopedRegions.returned = 2;
    scopedRegions.items = [
      { ...scopedRegions.items[0], region_id: "p6-t1", page: 6 },
      { ...scopedRegions.items[0], region_id: "p7-t1", page: 7 },
    ];
    const scopedPages = sourcePages(Array.from({ length: 7 }, (_, index) => (
      index === 5 ? "Contents Table 1. Summary values .......... 12"
        : index === 6 ? "Table 1. Actual measurements and sample totals Column A Column B"
          : `Source page ${index + 1}`
    )));
    const scopedPolicy = classification({
      documentChunks: scopedChunks,
      documentTableRegions: scopedRegions,
      documentSourcePages: scopedPages,
      batchChunkIds: scopedChunks.map(item => item.chunk_id),
    });
    expect(scopedPolicy.first_actual_table).toMatchObject({
      page_one_based: 7,
      chunk_id: id("d"),
      region_id: "p7-t1",
      classification: "actual_data_table",
    });
    const candidate = {
      agency: null,
      publication_citation_excerpt: null,
      contributors: [],
      first_table: {
        page_one_based: 7,
        anchor_excerpt: "Table 1. Actual measurements and sample totals",
        citation: { chunk_id: id("d"), quote: "Table 1. Actual measurements and sample totals" },
      },
    };
    const result = admitStructuredModelResponse({
      responseBytes: response({ content: JSON.stringify(candidate) }),
      expectedModel: MODEL,
      maxOutputTokens: 4096,
      documentId: DOCUMENT,
      documentMapSha256: DOCUMENT_MAP_SHA256,
      sourceSha256: SOURCE_SHA256,
      documentChunks: scopedChunks,
      documentTableRegions: scopedRegions,
      documentSourcePages: scopedPages,
      batchChunkIds: scopedChunks.map(item => item.chunk_id),
      batchPolicy: scopedPolicy,
    });
    expect(result.proposal.first_table).toMatchObject({ page_one_based: 7 });
    expect(result.first_table_evidence).toMatchObject({
      region: { region_id: "p7-t1", page: 7 },
      selection: { classification: "actual_data_table", page_one_based: 7 },
    });
    expect(() => compare({ admission: result, batchPolicy: scopedPolicy, documentChunks: scopedChunks,
      documentSourcePages: scopedPages })).not.toThrow();

    const reversed = [...scopedChunks].reverse();
    expect(() => classification({
      documentChunks: reversed,
      documentTableRegions: scopedRegions,
      documentSourcePages: scopedPages,
      batchChunkIds: reversed.map(item => item.chunk_id),
    })).toThrow(/deterministic page order/u);
  });

  it("does not treat the abandoned-region inventory as a complete table inventory", () => {
    const hidden = { ...structuredClone(tableRegions), observed: 1, returned: 0, omitted: 1, items: [] };
    const hiddenPolicy = classification({
      documentId: DOCUMENT, documentMapSha256: DOCUMENT_MAP_SHA256, documentChunks: chunks,
      documentTableRegions: hidden, batchChunkIds,
    });
    const hiddenResult = admit({ documentTableRegions: hidden, batchPolicy: hiddenPolicy });
    expect(hiddenResult.field_outcomes.first_table).toMatchObject({ status: "admitted", message: null });
    expect(hiddenResult.first_table_evidence).toMatchObject({
      region: null,
      region_sha256: null,
      selection: { evidence_kind: "canonical_source_heading", region_id: null },
    });
    expect(() => compare({ admission: hiddenResult, batchPolicy: hiddenPolicy })).not.toThrow();

    const reordered = structuredClone(tableRegions);
    reordered.observed = 2;
    reordered.returned = 2;
    reordered.items.push({ ...structuredClone(reordered.items[0]), region_id: "p1-t2" });
    reordered.items.reverse();
    expect(() => classification({
      documentId: DOCUMENT, documentMapSha256: DOCUMENT_MAP_SHA256, documentChunks: chunks,
      documentTableRegions: reordered, batchChunkIds,
    })).toThrow(/deterministic page\/ordinal order/u);

    const drifted = structuredClone(tableRegions);
    drifted.items[0].page = 2;
    expect(() => admit({ documentTableRegions: drifted })).toThrow(/identity is invalid/u);
  });

  it("classifies a canonical mid-page Table 1 heading without an abandoned table region", () => {
    const noRegions = { ...structuredClone(tableRegions), observed: 0, returned: 0, omitted: 0, items: [] };
    const scopedChunks = [chunk({
      document_id: DOCUMENT,
      chunk_id: id("d"),
      page_range: { start_page: 1, end_page: 1 },
      starts_at_heading: false,
      content: "Report header\nTable 1. Exact source-bound measurements Column A Column B",
    })];
    const scopedPages = sourcePages([
      "Report header Table 1. Exact source-bound measurements Column A Column B",
    ]);
    const scopedPolicy = classification({
      documentChunks: scopedChunks,
      documentTableRegions: noRegions,
      documentSourcePages: scopedPages,
      batchChunkIds: [id("d")],
    });
    expect(scopedPolicy.first_actual_table).toMatchObject({
      page_one_based: 1,
      chunk_id: id("d"),
      region_id: null,
      evidence_kind: "canonical_source_heading",
      classification: "actual_data_table",
    });
    expect(scopedPolicy.allowed_fields).toContain("first_table");
  });

  it("uses the longest unique source prefix when renderer text merges later tokens", () => {
    const noRegions = { ...structuredClone(tableRegions), observed: 0, returned: 0, omitted: 0, items: [] };
    const scopedChunks = [chunk({
      document_id: DOCUMENT,
      chunk_id: id("d"),
      page_range: { start_page: 1, end_page: 1 },
      starts_at_heading: false,
      content: "Table 1. Summary of the 40Ar/39Ar analyses of selected samples",
    })];
    const scopedPolicy = classification({
      documentChunks: scopedChunks,
      documentTableRegions: noRegions,
      documentSourcePages: sourcePages([
        "Table 1. Summary of the 40 Ar/ 39 Ar analyses of selected samples",
      ]),
      batchChunkIds: [id("d")],
    });
    expect(scopedPolicy.first_actual_table).toMatchObject({
      chunk_id: id("d"),
      support_anchor: "Table 1. Summary of the",
    });
    expect(scopedPolicy.allowed_fields).toContain("first_table");
  });

  it("accepts a retained heading split after the table number", () => {
    const noRegions = { ...structuredClone(tableRegions), observed: 0, returned: 0, omitted: 0, items: [] };
    const scopedChunks = [chunk({
      document_id: DOCUMENT,
      chunk_id: id("d"),
      page_range: { start_page: 1, end_page: 1 },
      starts_at_heading: false,
      content: "Table 1.\nCharacteristics of monitored streams and exact measurements",
    })];
    const scopedPolicy = classification({
      documentChunks: scopedChunks,
      documentTableRegions: noRegions,
      documentSourcePages: sourcePages([
        "Table 1. Characteristics of monitored streams and exact measurements",
      ]),
      batchChunkIds: [id("d")],
    });
    expect(scopedPolicy.first_actual_table).toMatchObject({ page_one_based: 1, chunk_id: id("d") });
  });

  it("reopens evidence eligibility at an explicit appendix after references", () => {
    const noRegions = { ...structuredClone(tableRegions), observed: 0, returned: 0, omitted: 0, items: [] };
    const scopedChunks = [
      chunk({
        document_id: DOCUMENT,
        chunk_id: id("c"),
        page_range: { start_page: 1, end_page: 1 },
        starts_at_heading: true,
        content: "References Cited\nUnsupported, A., 2025",
      }),
      chunk({
        document_id: DOCUMENT,
        chunk_id: id("d"),
        page_range: { start_page: 2, end_page: 2 },
        starts_at_heading: true,
        content: "Appendix 1. Measurements\nTable 1. Exact appendix values and totals",
      }),
    ];
    const scopedPages = sourcePages(scopedChunks.map(item => item.content.replace(/\n/gu, " ")));
    const appendixPolicy = classification({
      documentChunks: scopedChunks,
      documentTableRegions: noRegions,
      documentSourcePages: scopedPages,
      batchChunkIds: [id("d")],
    });
    expect(appendixPolicy.chunk_policies).toEqual([
      { chunk_id: id("d"), evidence_admission: "source_replay_required" },
    ]);
    expect(appendixPolicy.allowed_fields).toContain("first_table");

    const referencePolicy = classification({
      documentChunks: scopedChunks,
      documentTableRegions: noRegions,
      documentSourcePages: scopedPages,
      batchChunkIds: [id("c")],
    });
    expect(referencePolicy.allowed_fields).toEqual([]);
  });

  it("skips roman-numeral list pages and lowercase cross-references before the actual heading", () => {
    const noRegions = { ...structuredClone(tableRegions), observed: 0, returned: 0, omitted: 0, items: [] };
    const scopedChunks = [
      chunk({
        document_id: DOCUMENT,
        chunk_id: id("c"),
        page_range: { start_page: 1, end_page: 1 },
        starts_at_heading: false,
        content: "iv Figures 1. Map ........ 2 Table 1. Listed table ........ 10",
      }),
      chunk({
        document_id: DOCUMENT,
        chunk_id: id("d"),
        page_range: { start_page: 2, end_page: 2 },
        starts_at_heading: false,
        content: "Discussion refers to table 1.\nTable 1. Actual measurements and sample totals",
      }),
    ];
    const scopedPages = sourcePages(scopedChunks.map(item => item.content.replace(/\n/gu, " ")));
    const scopedPolicy = classification({
      documentChunks: scopedChunks,
      documentTableRegions: noRegions,
      documentSourcePages: scopedPages,
      batchChunkIds: scopedChunks.map(item => item.chunk_id),
    });
    expect(scopedPolicy.first_actual_table).toMatchObject({ page_one_based: 2, chunk_id: id("d") });
  });

  it("does not promote a capitalized inline Table 1 cross-reference", () => {
    const noRegions = { ...structuredClone(tableRegions), observed: 0, returned: 0, omitted: 0, items: [] };
    const scopedChunks = [
      chunk({
        document_id: DOCUMENT,
        chunk_id: id("c"),
        page_range: { start_page: 1, end_page: 1 },
        starts_at_heading: false,
        content: "Discussion refers to Table 1. Results are described below.",
      }),
      chunk({
        document_id: DOCUMENT,
        chunk_id: id("d"),
        page_range: { start_page: 2, end_page: 2 },
        starts_at_heading: false,
        content: "Table 1. Actual measurements and sample totals",
      }),
    ];
    const scopedPolicy = classification({
      documentChunks: scopedChunks,
      documentTableRegions: noRegions,
      documentSourcePages: sourcePages(scopedChunks.map(item => item.content)),
      batchChunkIds: scopedChunks.map(item => item.chunk_id),
    });
    expect(scopedPolicy.first_actual_table).toMatchObject({ page_one_based: 2, chunk_id: id("d") });
  });

  it("fails closed when a canonical table heading does not uniquely replay to one retained chunk", () => {
    const noRegions = { ...structuredClone(tableRegions), observed: 0, returned: 0, omitted: 0, items: [] };
    const duplicate = ["e", "f"].map(character => chunk({
      document_id: DOCUMENT,
      chunk_id: id(character),
      page_range: { start_page: 1, end_page: 1 },
      starts_at_heading: false,
      content: "Table 1. Duplicate same-page heading and values",
    }));
    const scopedPolicy = classification({
      documentChunks: duplicate,
      documentTableRegions: noRegions,
      documentSourcePages: sourcePages(["Table 1. Duplicate same-page heading and values"]),
      batchChunkIds: duplicate.map(item => item.chunk_id),
    });
    expect(scopedPolicy.first_actual_table).toBeNull();
    expect(scopedPolicy.allowed_fields).not.toContain("first_table");
  });

  it("rejects canonical source-page byte or self-digest drift before admission", () => {
    const pageDrift = structuredClone(SOURCE_PAGES);
    pageDrift.pages[0].normalized_text += " drift";
    expect(() => classification({ documentSourcePages: pageDrift })).toThrow(/page.*digest drifted/u);
    const bundleDrift = structuredClone(SOURCE_PAGES);
    bundleDrift.source_page_text_bundle_sha256 = "f".repeat(64);
    expect(() => classification({ documentSourcePages: bundleDrift })).toThrow(/self-digest drifted/u);
  });

  it("rejects a cross-document chunk before field admission", () => {
    const candidate = proposal();
    candidate.agency.citation.chunk_id = id("d");
    const crossDocument = chunk({ document_id: "another-document", chunk_id: id("d"),
      page_range: { start_page: 1, end_page: 1 }, starts_at_heading: false,
      content: "U.S. Geological Survey" });
    expect(() => admit({
      documentChunks: [...chunks, crossDocument],
      responseBytes: response({ content: JSON.stringify(candidate) }),
    })).toThrow(/another document/u);
  });

  it("rejects contributor overflow and caller-supplied arithmetic", () => {
    const candidate = proposal();
    candidate.contributors = Array.from({ length: MAX_ADMITTED_CONTRIBUTORS + 1 }, (_, index) => ({
      name: `Author ${index}`,
      citation: { chunk_id: id("a"), quote: "River, A.B." },
    }));
    const overflow = admit({ responseBytes: response({ content: JSON.stringify(candidate) }) });
    expect(overflow.proposal.contributors).toEqual([]);
    expect(overflow.field_outcomes.contributors).toMatchObject({
      status: "rejected", message: expect.stringMatching(/maxItems 32/u),
    });

    const arithmetic = { ...proposal(), contributor_count: 1 };
    expect(() => admit({ responseBytes: response({ content: JSON.stringify(arithmetic) }) }))
      .toThrow(/proposal keys are invalid/u);
  });

  it("rejects the whole contributor field when one member is stale without erasing safe scalar fields", () => {
    const candidate = proposal();
    candidate.contributors.push({
      name: "Stale, S.T.",
      citation: { chunk_id: id("f"), quote: "Stale, S.T." },
    });
    const result = admit({ responseBytes: response({ content: JSON.stringify(candidate) }) });
    expect(result.submitted_proposal.contributors).toHaveLength(2);
    expect(result.proposal.contributors).toEqual([]);
    expect(result.field_outcomes.contributors).toMatchObject({
      status: "rejected", reason_code: "not_source_bound", citation_count: 0,
    });
    expect(result.proposal.agency).toEqual(proposal().agency);
    expect(result.source_replay.citations.map(citation => citation.field))
      .toEqual(["agency", "publication_citation_excerpt", "first_table"]);
    expect(() => compare({ admission: result, oracleCitations: [] })).not.toThrow();
  });

  it("rejects response identity, usage, finish-reason, and policy drift", () => {
    expect(() => admit({ responseBytes: response({ model: "other-model" }) })).toThrow(/identity drifted/u);
    expect(() => admit({ responseBytes: response({ completionTokens: 4097 }) })).toThrow(/usage is invalid/u);
    expect(() => admit({ responseBytes: response({ finishReason: "content_filter" }) }))
      .toThrow(/finish reason is unsupported/u);
    expect(() => admit({ batchPolicy: { ...policy(), allowed_fields: [] } })).toThrow(/batchPolicy drifted/u);

    const extraChoice = JSON.parse(response().toString("utf8"));
    extraChoice.choices.push(extraChoice.choices[0]);
    expect(() => admit({ responseBytes: Buffer.from(JSON.stringify(extraChoice)) }))
      .toThrow(/choice envelope is invalid/u);

    const contentDrift = structuredClone(chunks);
    contentDrift[0].content += "\nforged";
    expect(() => admit({ documentChunks: contentDrift })).toThrow(/does not bind its exact content/u);
    expect(() => admit({ documentMapSha256: "8".repeat(64) })).toThrow(/batchPolicy drifted/u);
  });

  it("rejects a tampered admission before secondary oracle comparison", () => {
    const admission = admit();
    admission.source_replay.contributor_count = 99;
    expect(() => compare({ admission, oracleCitations: [] }))
      .toThrow(/contributor derivation is invalid/u);

    const narrowedPolicy = classification({ batchChunkIds: [id("a")] });
    const narrowed = admit();
    narrowed.batch_policy_sha256 = contentSha(canonical(narrowedPolicy));
    narrowed.observation.batch_policy_sha256 = narrowed.batch_policy_sha256;
    expect(() => compare({ admission: narrowed, batchPolicy: narrowedPolicy, oracleCitations: [] }))
      .toThrow(/binding is invalid/u);
  });

  it("replays and rejects drift in the retained response representation", () => {
    const direct = admit();
    direct.content_representation.strict_json_payload += " ";
    expect(() => compare({ admission: direct, oracleCitations: [] }))
      .toThrow(/content representation replay is invalid/u);

    const payload = JSON.stringify(proposal());
    const fenced = admit({ responseBytes: response({ content: `\`\`\`json\n${payload}\n\`\`\`` }) });
    fenced.content_representation.kind = "direct_strict_json";
    expect(() => compare({ admission: fenced, oracleCitations: [] }))
      .toThrow(/content representation replay is invalid/u);
  });

  it("rejects source-projection metadata drift before secondary oracle comparison", () => {
    const admission = admit();
    admission.source_replay.citations[0].projection.canonical_page_claim_match
      = "unique_source_token_projection";
    expect(() => compare({ admission, oracleCitations: [] }))
      .toThrow(/projection drifted/u);
  });

  it("rejects typed field-outcome and submitted-proposal drift before secondary comparison", () => {
    const candidate = proposal();
    candidate.first_table.page_one_based = 2;
    const partial = admit({ responseBytes: response({ content: JSON.stringify(candidate) }) });
    expect(partial.field_outcomes.first_table.status).toBe("rejected");
    partial.field_outcomes.first_table.message = null;
    expect(() => compare({ admission: partial, oracleCitations: [] }))
      .toThrow(/rejection state is invalid/u);

    const submittedDrift = admit();
    submittedDrift.submitted_proposal.agency.value = "drift";
    expect(() => compare({ admission: submittedDrift, oracleCitations: [] }))
      .toThrow(/content representation replay is invalid/u);

    const regionDrift = admit();
    regionDrift.first_table_evidence.region.page = 2;
    expect(() => compare({ admission: regionDrift, oracleCitations: [] }))
      .toThrow(/first-table region evidence is invalid/u);
  });

  it("rejects cross-document and duplicate oracle citations", () => {
    const admission = admit();
    const oracle = {
      document_id: DOCUMENT,
      document_map_sha256: DOCUMENT_MAP_SHA256,
      page_one_based: 1,
      quote: "U.S. Geological Survey",
    };
    expect(() => compare({
      admission,
      oracleCitations: [{ ...oracle, document_id: "other-document" }],
    })).toThrow(/document, map, or page binding is invalid/u);
    expect(() => compare({ admission, oracleCitations: [oracle, oracle] }))
      .toThrow(/duplicate exact citation/u);
  });

  it("publishes a bounded strict schema and remains internal experimental code", () => {
    const schema = buildVerifiedExtractionProposalSchema();
    expect(schema.properties.contributors.maxItems).toBe(MAX_ADMITTED_CONTRIBUTORS);
    const referenceSchema = buildVerifiedExtractionProposalSchema({ allowedFields: [] });
    expect(referenceSchema.properties.contributors.maxItems).toBe(0);
    expect(referenceSchema.properties.agency).toEqual({ type: "null" });
    expect(VERIFIED_EXTRACTION_RESPONSE_ADMISSION_POLICY.boundary).toContain("secondary diagnostic");
    expect(SERVER_FILES).not.toContain("verified-extraction-response-admission.mjs");
    expect(SHARE_FILES).not.toContain("scripts/verified-extraction-response-admission.mjs");
  });
});
