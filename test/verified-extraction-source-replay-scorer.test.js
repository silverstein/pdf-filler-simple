import { describe, expect, it } from "vitest";

import {
  buildSourceReplayScoringBindings,
  canonicalJson,
  scoreSourceReplayResult,
  sha256,
} from "../scripts/verified-extraction-source-replay-scorer.mjs";

const semantics = {
  version: 1,
  contract: "verified-extraction-source-replay-task-semantics.v2",
  contributor_name_representation: {
    field: "contributors[].name",
    meaning: "human-readable display name exactly as frozen in the pre-execution truth oracle",
    surname_only_hidden_key_allowed: false,
  },
  citation_support: {
    representation: "whitespace-normalized literal substring of the bound source page",
    normalization: "replace each nonempty run of Unicode whitespace with one ASCII space and trim both ends",
    minimum_normalized_characters: 3,
    maximum_normalized_characters: 700,
    submitted_value_rule: "the normalized quote must contain the complete normalized submitted value or the field-specific anchor",
    correct_page_required: true,
    exact_oracle_window_equality_is_primary: false,
    exact_oracle_window_equality_is_secondary_diagnostic: true,
  },
  first_table: {
    meaning: "first actual data table in reading order",
    selected_classification: "actual_data_table",
    excluded_prior_classifications: ["contents_list"],
    oracle_requirement: "freeze prior exclusions",
  },
  result_field_semantics: {
    exact_fields: ["publication.agency", "contributors[].name", "summary.contributor_count",
      "summary.first_table.page_one_based"],
    "publication.publication_citation_excerpt": {
      representation: "bounded normalized literal source span",
      allowed_modes: ["suggested_citation_block", "doi_context_when_label_absent"],
      suggested_citation_block_rule: "must begin with Suggested citation: and contain a DOI",
      doi_context_when_label_absent_rule: "must contain the support anchor",
      minimum_normalized_characters: 50,
      maximum_normalized_characters: 700,
    },
    "summary.first_table.anchor_excerpt": {
      representation: "bounded normalized literal source span from the selected actual table heading",
      must_begin_with: "Table 1",
      minimum_normalized_characters: 20,
      maximum_normalized_characters: 360,
      selection_binding: "exact selected table",
    },
    hidden_exact_window_required: false,
  },
  campaign_rule: {
    freeze_before_execution: true,
    consumed_campaign_rescoring_allowed: false,
    source_bundle_required: true,
    wrong_source_fails_closed: true,
  },
  authorization: {
    model_execution_authorized: false,
    provider_execution_authorized: false,
    integration_authorized: false,
    benchmark_claim_ready: false,
    public_claim_authorized: false,
  },
};

const schema = {
  type: "object",
  required: ["publication", "contributors", "summary"],
  additionalProperties: false,
  properties: {
    publication: {
      type: "object",
      required: ["agency", "publication_citation_excerpt"],
      additionalProperties: false,
      properties: { agency: { type: "string" }, publication_citation_excerpt: { type: "string" } },
    },
    contributors: {
      type: "array",
      "x-key": "name",
      items: {
        type: "object",
        required: ["name"],
        additionalProperties: false,
        properties: { name: { type: "string" } },
      },
    },
    summary: {
      type: "object",
      required: ["contributor_count", "first_table"],
      additionalProperties: false,
      properties: {
        contributor_count: { type: "integer" },
        first_table: {
          type: "object",
          required: ["page_one_based", "anchor_excerpt"],
          additionalProperties: false,
          properties: { page_one_based: { type: "integer" }, anchor_excerpt: { type: "string" } },
        },
      },
    },
  },
};

function fixture() {
  const result = {
    publication: {
      agency: "U.S. Geological Survey",
      publication_citation_excerpt: "Suggested citation: North, A., and Vale, B., 2026, A measured report: U.S. Geological Survey Report 1, https://doi.org/10.1/example.",
    },
    contributors: [{ name: "Alice North" }, { name: "Basil Vale" }],
    summary: {
      contributor_count: 2,
      first_table: { page_one_based: 3, anchor_excerpt: "Table 1. Verified measurements for the first actual data table" },
    },
  };
  const texts = [
    "Prepared by the U.S. Geological Survey. Alice North and Basil Vale completed this report.",
    `${result.publication.publication_citation_excerpt} Additional publication context follows.`,
    `${result.summary.first_table.anchor_excerpt}. Row headings and measured values follow.`,
  ];
  const pages = texts.map((normalized_text, index) => ({
    page_one_based: index + 1,
    normalized_text,
    normalized_text_sha256: sha256(normalized_text),
  }));
  const sourceBundleBody = {
    version: 1,
    scheme: "verified-extraction-normalized-source-pages.v1",
    document_id: "doc-1",
    source_identity: {
      pdf_sha256: "1".repeat(64),
      page_count: pages.length,
      pdfjs_package_sha256: "2".repeat(64),
      normalization: "unicode_whitespace_runs_to_ascii_space_then_trim",
    },
    pages,
  };
  const sourceBundle = { ...sourceBundleBody,
    source_page_text_bundle_sha256: sha256(canonicalJson(sourceBundleBody)) };
  const documentChunks = texts.map((content, index) => ({
    document_id: "doc-1",
    chunk_id: `chunk.${sha256(`chunk-${index + 1}`)}`,
    page_range: { start_page: index + 1, end_page: index + 1 },
    starts_at_heading: index === 2,
    content,
    content_sha256: sha256(Buffer.from(content, "utf8")),
  }));
  const schemaBytes = Buffer.from(`${JSON.stringify(schema, null, 2)}\n`, "utf8");
  const citations = {
    "publication.agency": { page: 1, quote: texts[0] },
    "publication.publication_citation_excerpt": { page: 2,
      quote: result.publication.publication_citation_excerpt },
    "contributors[name=Alice North]": { page: 1,
      quote: "U.S. Geological Survey. Alice North and Basil Vale completed this report." },
    "contributors[name=Basil Vale]": { page: 1,
      quote: "Alice North and Basil Vale completed this report." },
    "summary.first_table": { page: 3, quote: texts[2] },
  };
  const truthOracle = {
    version: 2,
    document_id: "doc-1",
    task_semantics_sha256: sha256(canonicalJson(semantics)),
    source_page_text_bundle_sha256: sourceBundle.source_page_text_bundle_sha256,
    result,
    publication_excerpt_selection: {
      mode: "suggested_citation_block",
      page_one_based: 2,
      support_anchor: result.publication.publication_citation_excerpt,
      suggested_citation_label_absent: false,
    },
    first_table_selection: {
      selected: {
        page_one_based: 3,
        anchor_excerpt: result.summary.first_table.anchor_excerpt,
        support_anchor: "Table 1. Verified measurements",
        classification: "actual_data_table",
      },
      excluded_prior_mentions: [],
    },
    exact_oracle_windows: Object.fromEntries(Object.entries(citations).map(([key, citation]) => [key,
      { ...citation, quote: citation.quote.split(". ")[0] }])),
  };
  const bindings = buildSourceReplayScoringBindings({
    documentId: "doc-1",
    documentMapSha256: "3".repeat(64),
    schemaBytes,
    sourceBundle,
    documentChunks,
  });
  return { bindings, schema, schemaBytes, semantics, sourceBundle, documentChunks, truthOracle, result,
    citations };
}

function score(overrides = {}) {
  return scoreSourceReplayResult({ ...fixture(), ...overrides });
}

describe("verified extraction source-replay scorer", () => {
  it("accepts different exact source-valid windows and keeps oracle equality diagnostic", () => {
    const scored = score();
    expect(scored.source_replay_citations).toEqual({ numerator: 5, denominator: 5, rate: 1 });
    expect(scored.exact_oracle_window_secondary_diagnostic.numerator).toBeLessThan(5);
    expect(scored.deterministic_failure).toBe(false);
    expect(scored.scoring_bindings_sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    ["wrong page", ({ citations }) => { citations["publication.agency"].page = 2; }],
    ["nonliteral quote", ({ citations }) => { citations["publication.agency"].quote = "invented U.S. Geological Survey text"; }],
    ["quote without value", ({ citations }) => { citations["publication.agency"].quote = "Alice North and Basil Vale completed this report."; }],
    ["missing citation", ({ citations }) => { delete citations["publication.agency"]; }],
    ["extra citation", ({ citations }) => { citations.extra = citations["publication.agency"]; }],
    ["path substitution", ({ citations }) => {
      citations["contributors[name=Alice North]"] = citations["summary.first_table"];
    }],
    ["wrong chunk", ({ documentChunks }) => { documentChunks[0].content = "unrelated";
      documentChunks[0].content_sha256 = sha256("unrelated"); }],
  ])("rejects %s", (_label, mutate) => {
    const args = fixture();
    mutate(args);
    expect(() => scoreSourceReplayResult(args)).toThrow();
  });

  it("rejects stale schema bytes", () => {
    const args = fixture();
    args.schemaBytes = Buffer.from(`${JSON.stringify({ ...schema, title: "drift" })}\n`);
    expect(() => scoreSourceReplayResult(args)).toThrow(/bindings drifted|schema/u);
  });

  it("rejects stale source bytes and document identities", () => {
    const args = fixture();
    args.sourceBundle.pages[0].normalized_text += " drift";
    expect(() => scoreSourceReplayResult(args)).toThrow(/digest/u);
    const other = fixture();
    other.documentChunks[0].document_id = "doc-2";
    expect(() => scoreSourceReplayResult(other)).toThrow(/identity/u);
  });

  it("rejects document-map and denominator substitution", () => {
    const args = fixture();
    args.bindings.document_map_sha256 = "4".repeat(64);
    expect(() => scoreSourceReplayResult(args)).toThrow(/bindings drifted/u);
    const duplicate = fixture();
    duplicate.documentChunks.push(structuredClone(duplicate.documentChunks[0]));
    expect(() => scoreSourceReplayResult(duplicate)).toThrow(/identity/u);
  });
});
