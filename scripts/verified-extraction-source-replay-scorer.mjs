import crypto from "node:crypto";

const SHA256 = /^[0-9a-f]{64}$/;
const CHUNK_ID = /^chunk\.[0-9a-f]{64}$/;
const CONTRIBUTOR_KEY = /^contributors\[name=(.+)\]$/;

export const VERIFIED_EXTRACTION_SOURCE_REPLAY_SCORER = Object.freeze({
  name: "pdf-tools.verified-extraction-source-replay-scorer",
  version: "1.0.0-experimental",
});

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function normalizeSourceText(value) {
  if (typeof value !== "string") throw new Error("Source text must be a string");
  return value.replace(/\s+/gu, " ").trim();
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) throw new Error(`${label} has unexpected keys`);
}

function requireSha(value, label) {
  if (typeof value !== "string" || !SHA256.test(value) || /^0+$/.test(value)) throw new Error(`${label} must be a nonzero SHA-256`);
}

function withoutKey(value, key) {
  const copy = structuredClone(value);
  delete copy[key];
  return copy;
}

function chunkScope(documentChunks, documentId) {
  if (!Array.isArray(documentChunks) || documentChunks.length < 1) {
    throw new Error("A non-empty exact document chunk scope is required");
  }
  const seen = new Set();
  return documentChunks.map((chunk, index) => {
    exactKeys(chunk, ["chunk_id", "content", "content_sha256", "document_id", "page_range",
      "starts_at_heading"], `document chunk ${index}`);
    if (chunk.document_id !== documentId || !CHUNK_ID.test(chunk.chunk_id)
      || seen.has(chunk.chunk_id)) throw new Error(`Invalid document chunk identity at ${index}`);
    seen.add(chunk.chunk_id);
    if (!chunk.page_range || !Number.isInteger(chunk.page_range.start_page)
      || chunk.page_range.start_page < 1 || chunk.page_range.start_page !== chunk.page_range.end_page) {
      throw new Error(`Invalid document chunk page range at ${index}`);
    }
    if (typeof chunk.content !== "string" || !chunk.content
      || sha256(Buffer.from(chunk.content, "utf8")) !== chunk.content_sha256) {
      throw new Error(`Invalid document chunk content binding at ${index}`);
    }
    return {
      chunk_id: chunk.chunk_id,
      page_one_based: chunk.page_range.start_page,
      content_sha256: chunk.content_sha256,
    };
  });
}

export function buildSourceReplayScoringBindings({
  documentId,
  documentMapSha256,
  schemaBytes,
  sourceBundle,
  documentChunks,
}) {
  if (typeof documentId !== "string" || !documentId) throw new Error("Invalid scoring document ID");
  requireSha(documentMapSha256, "Document map identity");
  if (!Buffer.isBuffer(schemaBytes) || schemaBytes.length < 1) {
    throw new Error("Exact schema bytes are required");
  }
  validateSourceBundle(sourceBundle);
  if (sourceBundle.document_id !== documentId) throw new Error("Scoring source document drift");
  const scope = chunkScope(documentChunks, documentId);
  const body = {
    contract: structuredClone(VERIFIED_EXTRACTION_SOURCE_REPLAY_SCORER),
    document_id: documentId,
    document_map_sha256: documentMapSha256,
    schema_sha256: sha256(schemaBytes),
    source_sha256: sourceBundle.source_identity.pdf_sha256,
    source_page_text_bundle_sha256: sourceBundle.source_page_text_bundle_sha256,
    document_chunk_scope_sha256: sha256(canonicalJson(scope)),
    document_chunk_count: scope.length,
    benchmark_claim_ready: false,
  };
  return { ...body, bindings_sha256: sha256(canonicalJson(body)) };
}

export function validateSourceReplayScoringBindings({
  bindings,
  schemaBytes,
  sourceBundle,
  documentChunks,
}) {
  exactKeys(bindings, ["benchmark_claim_ready", "bindings_sha256", "contract",
    "document_chunk_count", "document_chunk_scope_sha256", "document_id",
    "document_map_sha256", "schema_sha256", "source_page_text_bundle_sha256",
    "source_sha256"], "source replay scoring bindings");
  const rebuilt = buildSourceReplayScoringBindings({
    documentId: bindings.document_id,
    documentMapSha256: bindings.document_map_sha256,
    schemaBytes,
    sourceBundle,
    documentChunks,
  });
  if (canonicalJson(bindings) !== canonicalJson(rebuilt)) {
    throw new Error("Source replay scoring bindings drifted from the exact source context");
  }
  return bindings;
}

export function validateTaskSemantics(semantics) {
  exactKeys(semantics, ["version", "contract", "contributor_name_representation", "citation_support", "first_table", "result_field_semantics", "campaign_rule", "authorization"], "task semantics");
  if (semantics.version !== 1 || semantics.contract !== "verified-extraction-source-replay-task-semantics.v2") throw new Error("Unsupported task semantics");
  exactKeys(semantics.contributor_name_representation, ["field", "meaning", "surname_only_hidden_key_allowed"], "contributor semantics");
  if (semantics.contributor_name_representation?.surname_only_hidden_key_allowed !== false) throw new Error("Hidden contributor key semantics are forbidden");
  const support = semantics.citation_support;
  exactKeys(support, ["representation", "normalization", "minimum_normalized_characters", "maximum_normalized_characters", "submitted_value_rule", "correct_page_required", "exact_oracle_window_equality_is_primary", "exact_oracle_window_equality_is_secondary_diagnostic"], "citation semantics");
  if (support?.representation !== "whitespace-normalized literal substring of the bound source page") throw new Error("Unsupported citation representation");
  if (!Number.isInteger(support.minimum_normalized_characters) || support.minimum_normalized_characters < 1) throw new Error("Invalid citation minimum");
  if (!Number.isInteger(support.maximum_normalized_characters) || support.maximum_normalized_characters < support.minimum_normalized_characters) throw new Error("Invalid citation maximum");
  if (support.correct_page_required !== true || support.exact_oracle_window_equality_is_primary !== false || support.exact_oracle_window_equality_is_secondary_diagnostic !== true) throw new Error("Citation replay policy drift");
  exactKeys(semantics.first_table, ["meaning", "selected_classification", "excluded_prior_classifications", "oracle_requirement"], "first-table semantics");
  if (semantics.first_table?.selected_classification !== "actual_data_table") throw new Error("First-table selected classification drift");
  if (!Array.isArray(semantics.first_table.excluded_prior_classifications) || semantics.first_table.excluded_prior_classifications.length < 1 || new Set(semantics.first_table.excluded_prior_classifications).size !== semantics.first_table.excluded_prior_classifications.length) throw new Error("Invalid excluded first-table classifications");
  exactKeys(semantics.result_field_semantics, ["exact_fields", "publication.publication_citation_excerpt", "summary.first_table.anchor_excerpt", "hidden_exact_window_required"], "result field semantics");
  if (semantics.result_field_semantics.hidden_exact_window_required !== false) throw new Error("Hidden exact excerpt windows are forbidden");
  if (!Array.isArray(semantics.result_field_semantics.exact_fields) || semantics.result_field_semantics.exact_fields.length !== 4) throw new Error("Exact result field contract drift");
  exactKeys(semantics.result_field_semantics["publication.publication_citation_excerpt"], ["representation", "allowed_modes", "suggested_citation_block_rule", "doi_context_when_label_absent_rule", "minimum_normalized_characters", "maximum_normalized_characters"], "publication excerpt semantics");
  if (canonicalJson(semantics.result_field_semantics["publication.publication_citation_excerpt"].allowed_modes) !== canonicalJson(["suggested_citation_block", "doi_context_when_label_absent"])) throw new Error("Publication excerpt modes drift");
  exactKeys(semantics.result_field_semantics["summary.first_table.anchor_excerpt"], ["representation", "must_begin_with", "minimum_normalized_characters", "maximum_normalized_characters", "selection_binding"], "table anchor semantics");
  exactKeys(semantics.campaign_rule, ["freeze_before_execution", "consumed_campaign_rescoring_allowed", "source_bundle_required", "wrong_source_fails_closed"], "campaign semantics");
  if (semantics.campaign_rule?.freeze_before_execution !== true || semantics.campaign_rule?.consumed_campaign_rescoring_allowed !== false || semantics.campaign_rule?.source_bundle_required !== true || semantics.campaign_rule?.wrong_source_fails_closed !== true) throw new Error("Campaign rule drift");
  exactKeys(semantics.authorization, ["model_execution_authorized", "provider_execution_authorized", "integration_authorized", "benchmark_claim_ready", "public_claim_authorized"], "semantic authorization");
  if (Object.values(semantics.authorization || {}).some((value) => value !== false)) throw new Error("Preparation contract cannot authorize execution or claims");
  return true;
}

export function validateSourceBundle(bundle) {
  exactKeys(bundle, ["version", "scheme", "document_id", "source_identity", "pages", "source_page_text_bundle_sha256"], "source bundle");
  if (bundle.version !== 1 || bundle.scheme !== "verified-extraction-normalized-source-pages.v1") throw new Error("Unsupported source bundle");
  if (typeof bundle.document_id !== "string" || !bundle.document_id) throw new Error("Invalid source document ID");
  exactKeys(bundle.source_identity, ["pdf_sha256", "page_count", "pdfjs_package_sha256", "normalization"], "source identity");
  requireSha(bundle.source_identity.pdf_sha256, "PDF identity");
  requireSha(bundle.source_identity.pdfjs_package_sha256, "PDF.js identity");
  if (!Number.isInteger(bundle.source_identity.page_count) || bundle.source_identity.page_count < 1) throw new Error("Invalid source page count");
  if (bundle.source_identity.normalization !== "unicode_whitespace_runs_to_ascii_space_then_trim") throw new Error("Source normalization drift");
  if (!Array.isArray(bundle.pages) || bundle.pages.length !== bundle.source_identity.page_count) throw new Error("Incomplete source page bundle");
  const seen = new Set();
  for (const page of bundle.pages) {
    exactKeys(page, ["page_one_based", "normalized_text", "normalized_text_sha256"], "source page");
    if (!Number.isInteger(page.page_one_based) || page.page_one_based < 1 || page.page_one_based > bundle.source_identity.page_count || seen.has(page.page_one_based)) throw new Error("Invalid or duplicate source page");
    seen.add(page.page_one_based);
    if (page.normalized_text !== normalizeSourceText(page.normalized_text)) throw new Error("Source page text is not canonical");
    requireSha(page.normalized_text_sha256, "Source page text digest");
    if (sha256(page.normalized_text) !== page.normalized_text_sha256) throw new Error("Source page text digest drift");
  }
  for (let page = 1; page <= bundle.source_identity.page_count; page += 1) if (!seen.has(page)) throw new Error("Omitted source page");
  requireSha(bundle.source_page_text_bundle_sha256, "Source bundle digest");
  if (sha256(canonicalJson(withoutKey(bundle, "source_page_text_bundle_sha256"))) !== bundle.source_page_text_bundle_sha256) throw new Error("Source bundle self-digest drift");
  return true;
}

function validateResult(result) {
  exactKeys(result, ["publication", "contributors", "summary"], "result");
  exactKeys(result.publication, ["agency", "publication_citation_excerpt"], "publication");
  if (typeof result.publication.agency !== "string" || !result.publication.agency) throw new Error("Invalid agency");
  if (typeof result.publication.publication_citation_excerpt !== "string" || !result.publication.publication_citation_excerpt) throw new Error("Invalid publication citation excerpt");
  if (!Array.isArray(result.contributors) || result.contributors.length < 1) throw new Error("Invalid contributors");
  const names = result.contributors.map((item) => {
    exactKeys(item, ["name"], "contributor");
    if (typeof item.name !== "string" || !item.name || item.name !== item.name.trim()) throw new Error("Invalid contributor display name");
    return item.name;
  });
  if (new Set(names).size !== names.length) throw new Error("Duplicate contributor display name");
  exactKeys(result.summary, ["contributor_count", "first_table"], "summary");
  if (result.summary.contributor_count !== names.length) throw new Error("Contributor count mismatch");
  exactKeys(result.summary.first_table, ["page_one_based", "anchor_excerpt"], "first table");
  if (!Number.isInteger(result.summary.first_table.page_one_based) || result.summary.first_table.page_one_based < 1) throw new Error("Invalid first-table page");
  if (typeof result.summary.first_table.anchor_excerpt !== "string" || !result.summary.first_table.anchor_excerpt) throw new Error("Invalid first-table anchor");
  return true;
}

function expectedCitationKeys(result) {
  return [
    "publication.agency",
    "publication.publication_citation_excerpt",
    ...result.contributors.map((item) => `contributors[name=${item.name}]`),
    "summary.first_table",
  ];
}

function validateTruthOracle({ truthOracle, semanticsSha256, sourceBundle }) {
  exactKeys(truthOracle, ["version", "document_id", "task_semantics_sha256", "source_page_text_bundle_sha256", "result", "publication_excerpt_selection", "first_table_selection", "exact_oracle_windows"], "truth oracle");
  if (truthOracle.version !== 2 || truthOracle.document_id !== sourceBundle.document_id) throw new Error("Truth document binding drift");
  requireSha(truthOracle.task_semantics_sha256, "Truth semantics digest");
  if (truthOracle.task_semantics_sha256 !== semanticsSha256) throw new Error("Truth semantics binding drift");
  if (truthOracle.source_page_text_bundle_sha256 !== sourceBundle.source_page_text_bundle_sha256) throw new Error("Truth source binding drift");
  validateResult(truthOracle.result);
  exactKeys(truthOracle.publication_excerpt_selection, ["mode", "page_one_based", "support_anchor", "suggested_citation_label_absent"], "publication excerpt selection");
  const publicationSelection = truthOracle.publication_excerpt_selection;
  if (!["suggested_citation_block", "doi_context_when_label_absent"].includes(publicationSelection.mode)) throw new Error("Invalid publication excerpt mode");
  if (!Number.isInteger(publicationSelection.page_one_based) || publicationSelection.page_one_based < 1 || typeof publicationSelection.support_anchor !== "string" || !publicationSelection.support_anchor) throw new Error("Invalid publication excerpt selection");
  const publicationPage = sourceBundle.pages.find((page) => page.page_one_based === publicationSelection.page_one_based)?.normalized_text;
  if (!publicationPage?.includes(normalizeSourceText(publicationSelection.support_anchor))) throw new Error("Publication excerpt support anchor is not source-bound");
  const labelExists = sourceBundle.pages.some((page) => page.normalized_text.includes("Suggested citation:"));
  if (publicationSelection.mode === "suggested_citation_block" && (publicationSelection.suggested_citation_label_absent !== false || !labelExists || !publicationSelection.support_anchor.startsWith("Suggested citation:"))) throw new Error("Suggested-citation selection drift");
  if (publicationSelection.mode === "doi_context_when_label_absent" && (publicationSelection.suggested_citation_label_absent !== true || labelExists || !/(?:https:\/\/doi\.org\/|\bdoi:)/iu.test(publicationSelection.support_anchor))) throw new Error("DOI-context fallback is not justified");
  exactKeys(truthOracle.first_table_selection, ["selected", "excluded_prior_mentions"], "first-table selection");
  exactKeys(truthOracle.first_table_selection.selected, ["page_one_based", "anchor_excerpt", "support_anchor", "classification"], "selected first table");
  if (truthOracle.first_table_selection.selected.classification !== "actual_data_table") throw new Error("Selected table is not an actual data table");
  if (truthOracle.first_table_selection.selected.page_one_based !== truthOracle.result.summary.first_table.page_one_based || truthOracle.first_table_selection.selected.anchor_excerpt !== truthOracle.result.summary.first_table.anchor_excerpt) throw new Error("First-table truth binding drift");
  if (typeof truthOracle.first_table_selection.selected.support_anchor !== "string" || normalizeSourceText(truthOracle.first_table_selection.selected.support_anchor).length < 20 || !normalizeSourceText(truthOracle.first_table_selection.selected.anchor_excerpt).startsWith(normalizeSourceText(truthOracle.first_table_selection.selected.support_anchor))) throw new Error("Invalid selected table support anchor");
  if (!Array.isArray(truthOracle.first_table_selection.excluded_prior_mentions)) throw new Error("Invalid excluded table mentions");
  for (const mention of truthOracle.first_table_selection.excluded_prior_mentions) {
    exactKeys(mention, ["page_one_based", "quote", "classification"], "excluded table mention");
    if (!Number.isInteger(mention.page_one_based) || mention.page_one_based < 1 || mention.page_one_based > truthOracle.result.summary.first_table.page_one_based) throw new Error("Excluded mention is not prior to selected table");
    if (typeof mention.quote !== "string" || !mention.quote) throw new Error("Invalid excluded mention quote");
    const pageText = sourceBundle.pages.find((page) => page.page_one_based === mention.page_one_based)?.normalized_text;
    if (!pageText?.includes(normalizeSourceText(mention.quote))) throw new Error("Excluded mention is not source-bound");
  }
  exactKeys(truthOracle.exact_oracle_windows, expectedCitationKeys(truthOracle.result), "exact oracle windows");
  return true;
}

function validateSemanticResult({ semantics, sourceBundle, documentChunks, truthOracle, result,
  citations }) {
  const truth = truthOracle.result;
  const failures = [];
  if (result.publication.agency !== truth.publication.agency) failures.push("publication.agency");
  if (canonicalJson(result.contributors) !== canonicalJson(truth.contributors)) failures.push("contributors");
  if (result.summary.contributor_count !== truth.summary.contributor_count) failures.push("summary.contributor_count");
  if (result.summary.first_table.page_one_based !== truth.summary.first_table.page_one_based) failures.push("summary.first_table.page_one_based");

  const publicationRule = semantics.result_field_semantics["publication.publication_citation_excerpt"];
  const publicationExcerpt = normalizeSourceText(result.publication.publication_citation_excerpt);
  if (publicationExcerpt.length < publicationRule.minimum_normalized_characters || publicationExcerpt.length > publicationRule.maximum_normalized_characters) failures.push("publication.publication_citation_excerpt.length");
  const publicationSelection = truthOracle.publication_excerpt_selection;
  if (publicationSelection.mode === "suggested_citation_block") {
    if (!publicationExcerpt.startsWith("Suggested citation:")) failures.push("publication.publication_citation_excerpt.prefix");
    if (!/(?:https:\/\/doi\.org\/|\bdoi:)/iu.test(publicationExcerpt)) failures.push("publication.publication_citation_excerpt.doi");
  } else if (!publicationExcerpt.includes(normalizeSourceText(publicationSelection.support_anchor))) {
    failures.push("publication.publication_citation_excerpt.doi_context_support");
  }

  const tableRule = semantics.result_field_semantics["summary.first_table.anchor_excerpt"];
  const tableAnchor = normalizeSourceText(result.summary.first_table.anchor_excerpt);
  if (tableAnchor.length < tableRule.minimum_normalized_characters || tableAnchor.length > tableRule.maximum_normalized_characters) failures.push("summary.first_table.anchor_excerpt.length");
  if (!/^Table\s+1(?:[.\s:—-]|$)/iu.test(tableAnchor)) failures.push("summary.first_table.anchor_excerpt.prefix");
  const selectedSupport = normalizeSourceText(truthOracle.first_table_selection.selected.support_anchor);
  if (!tableAnchor.startsWith(selectedSupport) && !selectedSupport.startsWith(tableAnchor)) failures.push("summary.first_table.anchor_excerpt.selection");

  try {
    for (const key of expectedCitationKeys(result)) replaySourceCitation({ sourceBundle,
      documentChunks, semantics, result, key, citation: citations[key] });
  } catch {
    failures.push("source_replay_citation_support");
  }
  return { valid: failures.length === 0, failures };
}

function supportValueForKey(result, key) {
  if (key === "publication.agency") return { value: result.publication.agency, page: null };
  if (key === "publication.publication_citation_excerpt") return { value: result.publication.publication_citation_excerpt, page: null };
  if (key === "summary.first_table") return { value: result.summary.first_table.anchor_excerpt, page: result.summary.first_table.page_one_based };
  const match = CONTRIBUTOR_KEY.exec(key);
  if (!match || !result.contributors.some((item) => item.name === match[1])) throw new Error(`Unsupported citation key: ${key}`);
  return { value: match[1], page: null };
}

export function replaySourceCitation({ sourceBundle, documentChunks, semantics, result, key, citation }) {
  exactKeys(citation, ["page", "quote"], `citation ${key}`);
  if (!Number.isInteger(citation.page) || citation.page < 1) throw new Error(`Invalid citation page for ${key}`);
  const quote = normalizeSourceText(citation.quote);
  const min = semantics.citation_support.minimum_normalized_characters;
  const max = semantics.citation_support.maximum_normalized_characters;
  if (quote.length < min || quote.length > max) throw new Error(`Citation quote length is invalid for ${key}`);
  const sourcePage = sourceBundle.pages.find((page) => page.page_one_based === citation.page);
  if (!sourcePage || !sourcePage.normalized_text.includes(quote)) throw new Error(`Citation quote is not literal source text for ${key}`);
  const supportingChunks = documentChunks.filter((chunk) => chunk.page_range.start_page === citation.page);
  if (supportingChunks.length < 1) {
    throw new Error(`Citation page has no bound document chunk for ${key}`);
  }
  const support = supportValueForKey(result, key);
  if (support.page !== null && citation.page !== support.page) throw new Error(`Citation page does not support ${key}`);
  if (!quote.includes(normalizeSourceText(support.value))) throw new Error(`Citation quote does not contain the submitted value for ${key}`);
  return true;
}

export function scoreSourceReplayResult({
  bindings,
  schema,
  schemaBytes,
  semantics,
  sourceBundle,
  documentChunks,
  truthOracle,
  result,
  citations,
}) {
  validateSourceReplayScoringBindings({ bindings, schemaBytes, sourceBundle, documentChunks });
  let parsedSchema;
  try {
    parsedSchema = JSON.parse(schemaBytes.toString("utf8"));
  } catch {
    throw new Error("Exact schema bytes are not JSON");
  }
  if (canonicalJson(parsedSchema) !== canonicalJson(schema)) throw new Error("Parsed schema drifted from exact schema bytes");
  validateTaskSemantics(semantics);
  validateSourceBundle(sourceBundle);
  const semanticsSha256 = sha256(canonicalJson(semantics));
  validateTruthOracle({ truthOracle, semanticsSha256, sourceBundle });
  validateResult(result);
  const expectedKeys = expectedCitationKeys(result);
  exactKeys(citations, expectedKeys, "submitted citations");
  const citationReplay = {};
  for (const key of expectedKeys) {
    replaySourceCitation({ sourceBundle, documentChunks, semantics, result, key,
      citation: citations[key] });
    citationReplay[key] = true;
  }
  const resultExact = canonicalJson(result) === canonicalJson(truthOracle.result);
  const semanticAssessment = validateSemanticResult({ semantics, sourceBundle, documentChunks,
    truthOracle, result, citations });
  const exactOracleWindowMatches = expectedKeys.filter((key) => canonicalJson(citations[key]) === canonicalJson(truthOracle.exact_oracle_windows[key])).length;
  return {
    document_id: sourceBundle.document_id,
    source_page_text_bundle_sha256: sourceBundle.source_page_text_bundle_sha256,
    scoring_bindings_sha256: bindings.bindings_sha256,
    schema_sha256: bindings.schema_sha256,
    document_map_sha256: bindings.document_map_sha256,
    task_semantics_sha256: semanticsSha256,
    semantic_result_valid: semanticAssessment.valid,
    semantic_result_failures: semanticAssessment.failures,
    exact_oracle_result_secondary_diagnostic: resultExact,
    source_replay_citations: { numerator: expectedKeys.length, denominator: expectedKeys.length, rate: 1 },
    exact_oracle_window_secondary_diagnostic: { numerator: exactOracleWindowMatches, denominator: expectedKeys.length, rate: exactOracleWindowMatches / expectedKeys.length },
    deterministic_failure: !semanticAssessment.valid,
  };
}
