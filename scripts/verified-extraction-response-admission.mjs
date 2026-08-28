import { createHash } from "node:crypto";

import { parseStrictJson } from "./eval-strict-json.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const CHUNK_ID = /^chunk\.[a-f0-9]{64}$/u;
const REFERENCE_HEADINGS = new Set([
  "bibliography",
  "literature cited",
  "references",
  "references cited",
  "selected references",
  "works cited",
]);
const PROPOSAL_KEYS = ["agency", "contributors", "first_table", "publication_citation_excerpt"];
const ALL_FIELDS = ["agency", "publication_citation_excerpt", "contributors", "first_table"];

export const MAX_ADMITTED_CONTRIBUTORS = 32;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertion(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  assertion(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assertion(JSON.stringify(actual) === JSON.stringify(wanted), `${label} keys are invalid`);
}

function boundedString(value, label, maximum = 4096) {
  assertion(typeof value === "string" && value.length > 0, `${label} must be a non-empty string`);
  assertion(Buffer.byteLength(value, "utf8") <= maximum, `${label} exceeds its UTF-8 byte limit`);
}

function nonnegativeInteger(value, label) {
  assertion(Number.isSafeInteger(value) && value >= 0, `${label} must be a non-negative integer`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateChunk(chunk, expectedDocumentId, index) {
  exactKeys(chunk, ["chunk_id", "content", "content_sha256", "document_id", "page_range", "starts_at_heading"],
    `chunks[${index}]`);
  assertion(chunk.document_id === expectedDocumentId, `chunks[${index}] belongs to another document`);
  assertion(CHUNK_ID.test(chunk.chunk_id), `chunks[${index}].chunk_id is invalid`);
  boundedString(chunk.content, `chunks[${index}].content`, 1024 * 1024);
  assertion(SHA256.test(chunk.content_sha256)
    && chunk.content_sha256 === sha256(Buffer.from(chunk.content, "utf8")),
  `chunks[${index}].content_sha256 does not bind its exact content`);
  exactKeys(chunk.page_range, ["end_page", "start_page"], `chunks[${index}].page_range`);
  assertion(Number.isSafeInteger(chunk.page_range.start_page) && chunk.page_range.start_page >= 1
    && chunk.page_range.end_page === chunk.page_range.start_page,
  `chunks[${index}] must bind one positive page`);
  assertion(typeof chunk.starts_at_heading === "boolean", `chunks[${index}].starts_at_heading is invalid`);
}

function firstLine(content) {
  return content.split(/\r?\n/u, 1)[0].trim().replace(/[.:]$/u, "").toLocaleLowerCase("en-US");
}

export function classifySourceBoundBatch({ documentId, documentMapSha256, documentChunks, batchChunkIds }) {
  boundedString(documentId, "documentId", 512);
  assertion(SHA256.test(documentMapSha256 ?? ""), "documentMapSha256 is invalid");
  assertion(Array.isArray(documentChunks) && documentChunks.length > 0,
    "documentChunks must be a non-empty array");
  assertion(Array.isArray(batchChunkIds) && batchChunkIds.length > 0,
    "batchChunkIds must be a non-empty array");
  const seen = new Set();
  let inReferenceSection = false;
  const allPolicies = documentChunks.map((chunk, index) => {
    validateChunk(chunk, documentId, index);
    assertion(!seen.has(chunk.chunk_id), "documentChunks contain a duplicate chunk identity");
    seen.add(chunk.chunk_id);
    if (chunk.starts_at_heading && REFERENCE_HEADINGS.has(firstLine(chunk.content))) inReferenceSection = true;
    return {
      chunk_id: chunk.chunk_id,
      evidence_admission: inReferenceSection ? "forbidden_reference_section" : "source_replay_required",
    };
  });
  assertion(new Set(batchChunkIds).size === batchChunkIds.length
    && batchChunkIds.every(chunkId => CHUNK_ID.test(chunkId) && seen.has(chunkId)),
  "batchChunkIds contains an unknown or duplicate chunk identity");
  const indices = batchChunkIds.map(chunkId => documentChunks.findIndex(chunk => chunk.chunk_id === chunkId));
  assertion(indices.every((index, offset) => offset === 0 || index === indices[offset - 1] + 1),
    "batchChunkIds must be one ordered contiguous document range");
  const chunkPolicies = indices.map(index => allPolicies[index]);
  const containsReferenceSection = chunkPolicies
    .some(item => item.evidence_admission === "forbidden_reference_section");
  const documentChunkScopeSha256 = sha256(Buffer.from(canonicalJson(
    documentChunks.map(chunk => ({
      chunk_id: chunk.chunk_id,
      content_sha256: chunk.content_sha256,
      page_range: chunk.page_range,
      starts_at_heading: chunk.starts_at_heading,
    })),
  ), "utf8"));
  return {
    document_id: documentId,
    document_map_sha256: documentMapSha256,
    document_chunk_scope_sha256: documentChunkScopeSha256,
    batch_chunk_ids: [...batchChunkIds],
    allowed_fields: containsReferenceSection ? [] : [...ALL_FIELDS],
    model_call_recommended: !containsReferenceSection,
    chunk_policies: chunkPolicies,
  };
}

export function buildVerifiedExtractionProposalSchema({ allowedFields = ALL_FIELDS } = {}) {
  assertion(Array.isArray(allowedFields)
    && allowedFields.every(field => ALL_FIELDS.includes(field))
    && new Set(allowedFields).size === allowedFields.length, "allowedFields is invalid");
  const enabled = new Set(allowedFields);
  const citation = {
    type: "object",
    additionalProperties: false,
    required: ["chunk_id", "quote"],
    properties: {
      chunk_id: { type: "string", pattern: "^chunk\\.[a-f0-9]{64}$" },
      quote: { type: "string", minLength: 1, maxLength: 4096 },
    },
  };
  const citedString = enabledValue => enabledValue ? {
    anyOf: [
      { type: "null" },
      {
        type: "object",
        additionalProperties: false,
        required: ["value", "citation"],
        properties: { value: { type: "string", minLength: 1, maxLength: 4096 }, citation },
      },
    ],
  } : { type: "null" };
  return {
    type: "object",
    additionalProperties: false,
    required: ALL_FIELDS,
    properties: {
      agency: citedString(enabled.has("agency")),
      publication_citation_excerpt: citedString(enabled.has("publication_citation_excerpt")),
      contributors: enabled.has("contributors") ? {
        type: "array",
        maxItems: MAX_ADMITTED_CONTRIBUTORS,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "citation"],
          properties: { name: { type: "string", minLength: 1, maxLength: 512 }, citation },
        },
      } : { type: "array", maxItems: 0 },
      first_table: enabled.has("first_table") ? {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["page_one_based", "anchor_excerpt", "citation"],
            properties: {
              page_one_based: { type: "integer", minimum: 1 },
              anchor_excerpt: { type: "string", minLength: 1, maxLength: 4096 },
              citation,
            },
          },
        ],
      } : { type: "null" },
    },
  };
}

export class ModelOutputAdmissionError extends Error {
  constructor(message, code, observation) {
    super(message);
    this.name = "ModelOutputAdmissionError";
    this.code = code;
    this.observation = observation;
  }
}

function validateCitation(citation, chunksById, claimedValue, label) {
  exactKeys(citation, ["chunk_id", "quote"], `${label}.citation`);
  assertion(CHUNK_ID.test(citation.chunk_id), `${label}.citation.chunk_id is invalid`);
  boundedString(citation.quote, `${label}.citation.quote`);
  const chunk = chunksById.get(citation.chunk_id);
  assertion(chunk, `${label}.citation references a stale or cross-document chunk`);
  const content = Buffer.from(chunk.content, "utf8");
  const quote = Buffer.from(citation.quote, "utf8");
  const claimed = Buffer.from(claimedValue, "utf8");
  const offset = content.indexOf(quote);
  assertion(offset >= 0, `${label}.citation quote does not replay from the exact chunk`);
  assertion(quote.includes(claimed), `${label}.citation does not contain the claimed value`);
  return {
    document_id: chunk.document_id,
    chunk_id: chunk.chunk_id,
    page_one_based: chunk.page_range.start_page,
    quote: citation.quote,
    start_utf8_byte: offset,
    end_utf8_byte: offset + quote.length,
    quote_sha256: sha256(quote),
  };
}

export function compareAdmittedCitationEvidence({ admission, oracleCitations = [] }) {
  exactKeys(admission, ["batch_policy_sha256", "benchmark_claim_ready", "contract", "document_id", "observation",
    "package_inclusion", "document_map_sha256", "proposal", "proposal_sha256", "source_replay"], "admission");
  exactKeys(admission.contract, ["name", "version"], "admission.contract");
  assertion(admission.contract.name === "pdf-tools.verified-extraction-response-admission"
    && admission.contract.version === "1.0.0-experimental", "admission contract is invalid");
  assertion(admission.benchmark_claim_ready === false && admission.package_inclusion === "disabled_experimental",
    "admission readiness boundary is invalid");
  assertion(SHA256.test(admission.document_map_sha256) && SHA256.test(admission.batch_policy_sha256),
    "admission document-map or batch-policy binding is invalid");
  exactKeys(admission.observation, ["batch_policy_sha256", "content_sha256", "document_id",
    "document_map_sha256", "finish_reason", "max_output_tokens", "output_truncated", "response_sha256", "usage"],
  "admission.observation");
  assertion(admission.observation.document_id === admission.document_id
    && admission.observation.document_map_sha256 === admission.document_map_sha256
    && admission.observation.batch_policy_sha256 === admission.batch_policy_sha256
    && SHA256.test(admission.observation.response_sha256)
    && SHA256.test(admission.observation.content_sha256)
    && admission.observation.finish_reason === "stop"
    && admission.observation.output_truncated === false
    && Number.isSafeInteger(admission.observation.max_output_tokens)
    && admission.observation.max_output_tokens > 0,
  "admission observation binding is invalid");
  exactKeys(admission.observation.usage, ["input_tokens", "output_tokens", "total_tokens"],
    "admission.observation.usage");
  assertion([admission.observation.usage.input_tokens, admission.observation.usage.output_tokens,
    admission.observation.usage.total_tokens].every(value => Number.isSafeInteger(value) && value >= 0)
    && admission.observation.usage.input_tokens + admission.observation.usage.output_tokens
      === admission.observation.usage.total_tokens
    && admission.observation.usage.output_tokens <= admission.observation.max_output_tokens,
  "admission observation usage is invalid");
  assertion(SHA256.test(admission.proposal_sha256)
    && admission.proposal_sha256 === sha256(Buffer.from(canonicalJson(admission.proposal), "utf8")),
  "admission proposal digest drifted");
  exactKeys(admission.source_replay, ["citation_count", "citations", "contributor_count",
    "contributor_count_derivation"], "admission.source_replay");
  assertion(Array.isArray(admission.source_replay.citations)
    && admission.source_replay.citation_count === admission.source_replay.citations.length,
  "admission citations are invalid");
  assertion(admission.source_replay.contributor_count === admission.proposal.contributors?.length
    && admission.source_replay.contributor_count_derivation
      === "derived_from_admitted_contributors_not_model_arithmetic",
  "admission contributor derivation is invalid");
  exactKeys(admission.proposal, PROPOSAL_KEYS, "admission.proposal");
  assertion(Array.isArray(admission.proposal.contributors), "admission proposal contributors are invalid");
  const expectedCitationClaims = [
    admission.proposal.agency === null ? null : ["agency", admission.proposal.agency?.value],
    admission.proposal.publication_citation_excerpt === null ? null
      : ["publication_citation_excerpt", admission.proposal.publication_citation_excerpt?.value],
    ...admission.proposal.contributors.map((contributor, index) => [`contributors[${index}]`, contributor?.name]),
    admission.proposal.first_table === null ? null
      : ["first_table", admission.proposal.first_table?.anchor_excerpt],
  ].filter(Boolean);
  assertion(expectedCitationClaims.length === admission.source_replay.citations.length,
    "admission proposal and citation denominator disagree");
  admission.source_replay.citations.forEach((citation, index) => {
    exactKeys(citation, ["chunk_id", "document_id", "end_utf8_byte", "field", "page_one_based", "quote",
      "quote_sha256", "start_utf8_byte"], `admission.source_replay.citations[${index}]`);
    assertion(citation.document_id === admission.document_id && CHUNK_ID.test(citation.chunk_id)
      && Number.isSafeInteger(citation.page_one_based) && citation.page_one_based >= 1
      && Number.isSafeInteger(citation.start_utf8_byte) && citation.start_utf8_byte >= 0
      && Number.isSafeInteger(citation.end_utf8_byte)
      && citation.end_utf8_byte === citation.start_utf8_byte + Buffer.byteLength(citation.quote, "utf8")
      && SHA256.test(citation.quote_sha256)
      && citation.quote_sha256 === sha256(Buffer.from(citation.quote, "utf8")),
    `admission.source_replay.citations[${index}] binding is invalid`);
    const [expectedField, expectedClaim] = expectedCitationClaims[index];
    assertion(citation.field === expectedField && typeof expectedClaim === "string"
      && Buffer.from(citation.quote, "utf8").includes(Buffer.from(expectedClaim, "utf8")),
    `admission.source_replay.citations[${index}] does not bind its proposal field`);
  });
  assertion(Array.isArray(oracleCitations), "oracleCitations must be an array");
  const seenOracleCitations = new Set();
  const exactOracleSet = new Set(oracleCitations.map((citation, index) => {
    exactKeys(citation, ["document_id", "document_map_sha256", "page_one_based", "quote"],
      `oracleCitations[${index}]`);
    assertion(citation.document_id === admission.document_id
      && citation.document_map_sha256 === admission.document_map_sha256
      && Number.isSafeInteger(citation.page_one_based) && citation.page_one_based >= 1,
      `oracleCitations[${index}] document, map, or page binding is invalid`);
    boundedString(citation.quote, `oracleCitations[${index}].quote`);
    const identity = canonicalJson(citation);
    assertion(!seenOracleCitations.has(identity), "oracleCitations contains a duplicate exact citation");
    seenOracleCitations.add(identity);
    return canonicalJson({ page_one_based: citation.page_one_based, quote: citation.quote });
  }));
  const replayed = admission.source_replay.citations.length;
  const exactOracleMatches = admission.source_replay.citations.filter(citation => exactOracleSet.has(canonicalJson({
    page_one_based: citation.page_one_based,
    quote: citation.quote,
  }))).length;
  return {
    primary_source_replay: {
      numerator: replayed,
      denominator: replayed,
      complete: true,
    },
    secondary_exact_oracle_span: {
      numerator: exactOracleMatches,
      denominator: replayed,
      complete: exactOracleMatches === replayed,
    },
    exact_oracle_span_is_source_support_gate: false,
    benchmark_claim_ready: false,
  };
}

function validateCitedString(item, chunksById, label) {
  if (item === null) return null;
  exactKeys(item, ["citation", "value"], label);
  boundedString(item.value, `${label}.value`);
  return validateCitation(item.citation, chunksById, item.value, label);
}

function validateProposal(proposal, chunksById, allowedFields) {
  exactKeys(proposal, PROPOSAL_KEYS, "proposal");
  const allowed = new Set(allowedFields);
  for (const field of ["agency", "publication_citation_excerpt"]) {
    if (!allowed.has(field)) assertion(proposal[field] === null, `${field} is forbidden for this source section`);
  }
  if (!allowed.has("contributors")) {
    assertion(Array.isArray(proposal.contributors) && proposal.contributors.length === 0,
      "contributors are forbidden for this source section");
  }
  if (!allowed.has("first_table")) assertion(proposal.first_table === null,
    "first_table is forbidden for this source section");

  const citations = [];
  for (const field of ["agency", "publication_citation_excerpt"]) {
    const replay = validateCitedString(proposal[field], chunksById, field);
    if (replay) citations.push({ field, ...replay });
  }
  assertion(Array.isArray(proposal.contributors), "contributors must be an array");
  assertion(proposal.contributors.length <= MAX_ADMITTED_CONTRIBUTORS,
    `contributors exceeds maxItems ${MAX_ADMITTED_CONTRIBUTORS}`);
  const contributorNames = new Set();
  proposal.contributors.forEach((contributor, index) => {
    exactKeys(contributor, ["citation", "name"], `contributors[${index}]`);
    boundedString(contributor.name, `contributors[${index}].name`, 512);
    assertion(!contributorNames.has(contributor.name), "contributors contains a duplicate exact name");
    contributorNames.add(contributor.name);
    citations.push({ field: `contributors[${index}]`,
      ...validateCitation(contributor.citation, chunksById, contributor.name, `contributors[${index}]`) });
  });
  if (proposal.first_table !== null) {
    exactKeys(proposal.first_table, ["anchor_excerpt", "citation", "page_one_based"], "first_table");
    nonnegativeInteger(proposal.first_table.page_one_based, "first_table.page_one_based");
    assertion(proposal.first_table.page_one_based >= 1, "first_table.page_one_based must be positive");
    boundedString(proposal.first_table.anchor_excerpt, "first_table.anchor_excerpt");
    const replay = validateCitation(proposal.first_table.citation, chunksById,
      proposal.first_table.anchor_excerpt, "first_table");
    assertion(replay.page_one_based === proposal.first_table.page_one_based,
      "first_table page does not match its exact chunk");
    citations.push({ field: "first_table", ...replay });
  }
  return citations;
}

function observationFor({
  responseBytes,
  content,
  finishReason,
  maxOutputTokens,
  usage,
  documentId,
  documentMapSha256,
  batchPolicySha256,
}) {
  return {
    document_id: documentId,
    document_map_sha256: documentMapSha256,
    batch_policy_sha256: batchPolicySha256,
    response_sha256: sha256(responseBytes),
    content_sha256: typeof content === "string" ? sha256(Buffer.from(content, "utf8")) : null,
    finish_reason: finishReason ?? null,
    max_output_tokens: maxOutputTokens,
    usage,
    output_truncated: finishReason === "length",
  };
}

export function admitStructuredModelResponse({
  responseBytes,
  expectedModel,
  maxOutputTokens,
  documentId,
  documentMapSha256,
  documentChunks,
  batchChunkIds,
  batchPolicy,
}) {
  const bytes = Buffer.isBuffer(responseBytes) ? responseBytes : Buffer.from(responseBytes);
  boundedString(expectedModel, "expectedModel", 512);
  nonnegativeInteger(maxOutputTokens, "maxOutputTokens");
  assertion(maxOutputTokens > 0, "maxOutputTokens must be positive");
  boundedString(documentId, "documentId", 512);
  assertion(SHA256.test(documentMapSha256 ?? ""), "documentMapSha256 is invalid");
  assertion(Array.isArray(documentChunks) && documentChunks.length > 0,
    "documentChunks must be a non-empty array");
  const documentChunksById = new Map();
  documentChunks.forEach((chunk, index) => {
    validateChunk(chunk, documentId, index);
    assertion(!documentChunksById.has(chunk.chunk_id), "documentChunks contain a duplicate chunk identity");
    documentChunksById.set(chunk.chunk_id, chunk);
  });
  exactKeys(batchPolicy, ["allowed_fields", "batch_chunk_ids", "chunk_policies", "document_chunk_scope_sha256",
    "document_id", "document_map_sha256", "model_call_recommended"], "batchPolicy");
  assertion(batchPolicy.document_id === documentId, "batchPolicy belongs to another document");
  const recomputedPolicy = classifySourceBoundBatch({
    documentId,
    documentMapSha256,
    documentChunks,
    batchChunkIds,
  });
  assertion(canonicalJson(batchPolicy) === canonicalJson(recomputedPolicy), "batchPolicy drifted from exact chunks");
  const batchPolicySha256 = sha256(Buffer.from(canonicalJson(batchPolicy), "utf8"));
  const chunksById = new Map(batchChunkIds.map(chunkId => [chunkId, documentChunksById.get(chunkId)]));

  let body;
  try {
    body = parseStrictJson(bytes, "model response");
  } catch (error) {
    throw new ModelOutputAdmissionError(error.message, "model_response_ambiguous_or_malformed", {
      document_id: documentId,
      document_map_sha256: documentMapSha256,
      batch_policy_sha256: batchPolicySha256,
      response_sha256: sha256(bytes), content_sha256: null, finish_reason: null,
      max_output_tokens: maxOutputTokens, usage: null, output_truncated: null,
    });
  }
  const choice = body?.choices?.[0];
  const content = choice?.message?.content;
  const finishReason = choice?.finish_reason;
  const promptTokens = body?.usage?.prompt_tokens;
  const completionTokens = body?.usage?.completion_tokens;
  const totalTokens = body?.usage?.total_tokens;
  const usage = Number.isSafeInteger(promptTokens) && Number.isSafeInteger(completionTokens)
    && Number.isSafeInteger(totalTokens)
    ? { input_tokens: promptTokens, output_tokens: completionTokens, total_tokens: totalTokens }
    : null;
  const observation = observationFor({
    responseBytes: bytes,
    content,
    finishReason,
    maxOutputTokens,
    usage,
    documentId,
    documentMapSha256,
    batchPolicySha256,
  });
  if (!Array.isArray(body?.choices) || body.choices.length !== 1 || choice?.index !== 0
    || choice?.message?.role !== "assistant") {
    throw new ModelOutputAdmissionError("model response choice envelope is invalid",
      "model_response_envelope_invalid", observation);
  }
  if (!usage || promptTokens < 0 || completionTokens < 0 || totalTokens < 0
    || promptTokens + completionTokens !== totalTokens || completionTokens > maxOutputTokens) {
    throw new ModelOutputAdmissionError("model response usage is invalid", "model_response_usage_invalid", observation);
  }
  if (body.model !== expectedModel) {
    throw new ModelOutputAdmissionError("model response identity drifted", "model_binding_mismatch", observation);
  }
  if (finishReason === "length") {
    throw new ModelOutputAdmissionError("model output reached the frozen output-token cap",
      "model_output_truncated", observation);
  }
  if (finishReason !== "stop") {
    throw new ModelOutputAdmissionError("model response finish reason is unsupported",
      "model_finish_reason_unsupported", observation);
  }
  if (typeof content !== "string") {
    throw new ModelOutputAdmissionError("model response content is missing", "model_response_content_missing", observation);
  }
  if (!batchPolicy.model_call_recommended) {
    throw new ModelOutputAdmissionError("model call was not admitted for a reference-section batch",
      "model_call_unplanned_reference_section", observation);
  }
  let proposal;
  try {
    proposal = parseStrictJson(content, "model response content");
  } catch (error) {
    throw new ModelOutputAdmissionError(error.message, "model_response_ambiguous_or_malformed", observation);
  }
  let citations;
  try {
    citations = validateProposal(proposal, chunksById, batchPolicy.allowed_fields);
  } catch (error) {
    throw new ModelOutputAdmissionError(error.message, "model_proposal_not_source_bound", observation);
  }
  return {
    contract: { name: "pdf-tools.verified-extraction-response-admission", version: "1.0.0-experimental" },
    document_id: documentId,
    document_map_sha256: documentMapSha256,
    batch_policy_sha256: batchPolicySha256,
    observation,
    proposal,
    proposal_sha256: sha256(Buffer.from(canonicalJson(proposal), "utf8")),
    source_replay: {
      citation_count: citations.length,
      citations,
      contributor_count: proposal.contributors.length,
      contributor_count_derivation: "derived_from_admitted_contributors_not_model_arithmetic",
    },
    benchmark_claim_ready: false,
    package_inclusion: "disabled_experimental",
  };
}

export const VERIFIED_EXTRACTION_RESPONSE_ADMISSION_POLICY = Object.freeze({
  name: "pdf-tools.verified-extraction-response-admission",
  version: "1.0.0-experimental",
  boundary: "Only strict, complete, source-replayed proposals from a separately validated SHA-bound document map and current batch are admitted. This helper rehashes chunks but does not replace document-map source/schema/renderer validation. Output-cap termination is a typed truncation failure. Reference-section batches are evidence-ineligible. Exact oracle-span equality remains a separate secondary evaluation and is not treated as source support.",
});
