import { createHash } from "node:crypto";

import { parseStrictJson } from "./eval-strict-json.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const CHUNK_ID = /^chunk\.[a-f0-9]{64}$/u;
const TABLE_REGION_ID = /^p([1-9][0-9]*)-t([1-9][0-9]*)$/u;
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
const SOURCE_PROJECTION_POLICY = "exact-or-unique-internal-whitespace.v1";
const JSON_FENCE_PREFIX = "```json\n";
const JSON_FENCE_SUFFIX = "\n```";

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

function validateDocumentTableRegions(value) {
  exactKeys(value, ["all_items_sha256", "items", "observed", "omitted", "returned"],
    "documentTableRegions");
  for (const field of ["observed", "omitted", "returned"]) {
    nonnegativeInteger(value[field], `documentTableRegions.${field}`);
  }
  assertion(value.returned <= 5000 && value.observed <= 1000000,
    "documentTableRegions exceeds its bounded inventory");
  assertion(value.observed === value.returned + value.omitted,
    "documentTableRegions denominator is inconsistent");
  assertion(Array.isArray(value.items) && value.items.length === value.returned,
    "documentTableRegions returned inventory is inconsistent");
  assertion(SHA256.test(value.all_items_sha256 ?? "") && value.all_items_sha256 !== "0".repeat(64),
    "documentTableRegions complete inventory digest is invalid");
  const seen = new Set();
  let precedingPage = 0;
  let precedingOrdinal = 0;
  value.items.forEach((item, index) => {
    exactKeys(item, ["bbox", "coordinate_space", "evidence_truncation", "page", "reason", "region_id",
      "text_item_count"], `documentTableRegions.items[${index}]`);
    const match = typeof item.region_id === "string" ? item.region_id.match(TABLE_REGION_ID) : null;
    boundedString(item.region_id, `documentTableRegions.items[${index}].region_id`, 64);
    nonnegativeInteger(item.page, `documentTableRegions.items[${index}].page`);
    const ordinal = match ? Number(match[2]) : NaN;
    assertion(match && item.page >= 1 && Number(match[1]) === item.page
      && Number.isSafeInteger(ordinal) && ordinal >= 1 && !seen.has(item.region_id),
      `documentTableRegions.items[${index}] identity is invalid`);
    seen.add(item.region_id);
    nonnegativeInteger(item.text_item_count, `documentTableRegions.items[${index}].text_item_count`);
    assertion(item.text_item_count > 0, `documentTableRegions.items[${index}] is empty`);
    boundedString(item.reason, `documentTableRegions.items[${index}].reason`, 256);
    boundedString(item.coordinate_space, `documentTableRegions.items[${index}].coordinate_space`, 256);
    exactKeys(item.bbox, ["height", "width", "x", "y"], `documentTableRegions.items[${index}].bbox`);
    assertion(Object.values(item.bbox).every(Number.isFinite) && item.bbox.width > 0 && item.bbox.height > 0,
      `documentTableRegions.items[${index}].bbox is invalid`);
    exactKeys(item.evidence_truncation, ["painted_rectangles", "ruled_rects", "ruling_segments", "text_items"],
      `documentTableRegions.items[${index}].evidence_truncation`);
    assertion(Object.values(item.evidence_truncation)
      .every(status => status === "complete" || status === "truncated"),
    `documentTableRegions.items[${index}].evidence_truncation is invalid`);
    assertion(item.page > precedingPage || (item.page === precedingPage && ordinal > precedingOrdinal),
      "documentTableRegions items are not in deterministic page/ordinal order");
    precedingPage = item.page;
    precedingOrdinal = ordinal;
  });
  return {
    sha256: sha256(Buffer.from(canonicalJson(value), "utf8")),
    first: value.items[0] ?? null,
  };
}

export function classifySourceBoundBatch({
  documentId, documentMapSha256, documentChunks, documentTableRegions, batchChunkIds,
}) {
  boundedString(documentId, "documentId", 512);
  assertion(SHA256.test(documentMapSha256 ?? ""), "documentMapSha256 is invalid");
  assertion(Array.isArray(documentChunks) && documentChunks.length > 0,
    "documentChunks must be a non-empty array");
  assertion(Array.isArray(batchChunkIds) && batchChunkIds.length > 0,
    "batchChunkIds must be a non-empty array");
  const tableRegions = validateDocumentTableRegions(documentTableRegions);
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
  const batchChunks = indices.map(index => documentChunks[index]);
  const containsReferenceSection = chunkPolicies
    .some(item => item.evidence_admission === "forbidden_reference_section");
  const containsFirstTableRegion = tableRegions.first !== null && batchChunks.some(chunk => (
    chunk.page_range.start_page <= tableRegions.first.page
      && chunk.page_range.end_page >= tableRegions.first.page
  ));
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
    document_table_regions_sha256: tableRegions.sha256,
    document_chunk_scope_sha256: documentChunkScopeSha256,
    batch_chunk_ids: [...batchChunkIds],
    allowed_fields: containsReferenceSection ? [] : ALL_FIELDS.filter(field => (
      field !== "first_table" || containsFirstTableRegion
    )),
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

export function parseModelResponseProposalContent(content) {
  boundedString(content, "model response content", 1024 * 1024);
  try {
    return {
      proposal: parseStrictJson(content, "model response content"),
      representation: {
        kind: "direct_strict_json",
        raw_content_sha256: sha256(Buffer.from(content, "utf8")),
        strict_json_payload: content,
        strict_json_payload_sha256: sha256(Buffer.from(content, "utf8")),
      },
    };
  } catch (directError) {
    const hasExactFence = content.startsWith(JSON_FENCE_PREFIX)
      && content.endsWith(JSON_FENCE_SUFFIX)
      && content.length > JSON_FENCE_PREFIX.length + JSON_FENCE_SUFFIX.length;
    if (!hasExactFence) throw directError;
    const payload = content.slice(JSON_FENCE_PREFIX.length, -JSON_FENCE_SUFFIX.length);
    if (payload.includes("```")) {
      throw new Error("model response content contains a nested or multiple Markdown fence");
    }
    return {
      proposal: parseStrictJson(payload, "model response fenced JSON payload"),
      representation: {
        kind: "single_lowercase_json_markdown_fence.v1",
        raw_content_sha256: sha256(Buffer.from(content, "utf8")),
        strict_json_payload: payload,
        strict_json_payload_sha256: sha256(Buffer.from(payload, "utf8")),
      },
    };
  }
}

function whitespaceWidthAt(value, offset) {
  const point = value.codePointAt(offset);
  if (point === undefined) return 0;
  const character = String.fromCodePoint(point);
  return /^\s$/u.test(character) ? character.length : 0;
}

function whitespaceProjectionMatches(source, pieces) {
  const matches = [];
  let searchOffset = 0;
  while (searchOffset <= source.length - pieces[0].length) {
    const start = source.indexOf(pieces[0], searchOffset);
    if (start < 0) break;
    let cursor = start + pieces[0].length;
    let matched = true;
    for (const piece of pieces.slice(1)) {
      let whitespace = whitespaceWidthAt(source, cursor);
      if (whitespace === 0) {
        matched = false;
        break;
      }
      while (whitespace > 0) {
        cursor += whitespace;
        whitespace = whitespaceWidthAt(source, cursor);
      }
      if (!source.startsWith(piece, cursor)) {
        matched = false;
        break;
      }
      cursor += piece.length;
    }
    if (matched) matches.push({ index: start, source_excerpt: source.slice(start, cursor) });
    searchOffset = start + 1;
  }
  return matches;
}

function uniqueSourceProjection(source, submitted, label) {
  boundedString(source, `${label}.source`, 1024 * 1024);
  boundedString(submitted, `${label}.submitted`);
  assertion(submitted === submitted.trim(), `${label} has leading or trailing whitespace`);

  const exactOffsets = [];
  let offset = 0;
  while ((offset = source.indexOf(submitted, offset)) >= 0) {
    exactOffsets.push(offset);
    offset += 1;
  }
  if (exactOffsets.length > 1) throw new Error(`${label} is ambiguous in the exact source`);

  const pieces = submitted.split(/\s+/u);
  const projectionMatches = pieces.length > 1 && pieces.every(piece => piece.length > 0)
    ? whitespaceProjectionMatches(source, pieces)
    : [];
  if (exactOffsets.length === 1) {
    assertion(projectionMatches.length <= 1, `${label} is ambiguous after whitespace projection`);
    return {
      method: "exact",
      source_excerpt: submitted,
      start_utf16: exactOffsets[0],
      end_utf16: exactOffsets[0] + submitted.length,
    };
  }

  assertion(pieces.length > 1 && pieces.every(piece => piece.length > 0),
    `${label} does not replay from the exact source`);
  assertion(projectionMatches.length > 0, `${label} does not replay from the exact source`);
  assertion(projectionMatches.length === 1, `${label} is ambiguous after whitespace projection`);
  const match = projectionMatches[0];
  return {
    method: "unique_internal_whitespace_projection",
    source_excerpt: match.source_excerpt,
    start_utf16: match.index,
    end_utf16: match.index + match.source_excerpt.length,
  };
}

function byteOffset(value, utf16Offset) {
  return Buffer.byteLength(value.slice(0, utf16Offset), "utf8");
}

function validateCitation(citation, chunksById, claimedValue, label) {
  exactKeys(citation, ["chunk_id", "quote"], `${label}.citation`);
  assertion(CHUNK_ID.test(citation.chunk_id), `${label}.citation.chunk_id is invalid`);
  boundedString(citation.quote, `${label}.citation.quote`);
  const chunk = chunksById.get(citation.chunk_id);
  assertion(chunk, `${label}.citation references a stale or cross-document chunk`);
  const quoteProjection = uniqueSourceProjection(chunk.content, citation.quote, `${label}.citation quote`);
  const claimProjection = uniqueSourceProjection(quoteProjection.source_excerpt, claimedValue,
    `${label}.citation claimed value`);
  const quoteStart = byteOffset(chunk.content, quoteProjection.start_utf16);
  const quoteBytes = Buffer.from(quoteProjection.source_excerpt, "utf8");
  const claimStart = quoteStart + byteOffset(quoteProjection.source_excerpt, claimProjection.start_utf16);
  const claimBytes = Buffer.from(claimProjection.source_excerpt, "utf8");
  const submittedQuote = Buffer.from(citation.quote, "utf8");
  return {
    document_id: chunk.document_id,
    chunk_id: chunk.chunk_id,
    page_one_based: chunk.page_range.start_page,
    quote: quoteProjection.source_excerpt,
    start_utf8_byte: quoteStart,
    end_utf8_byte: quoteStart + quoteBytes.length,
    quote_sha256: sha256(quoteBytes),
    submitted_quote: citation.quote,
    submitted_quote_sha256: sha256(submittedQuote),
    claim_source_excerpt: claimProjection.source_excerpt,
    claim_source_excerpt_sha256: sha256(claimBytes),
    claim_start_utf8_byte: claimStart,
    claim_end_utf8_byte: claimStart + claimBytes.length,
    projection: {
      policy: SOURCE_PROJECTION_POLICY,
      quote_match: quoteProjection.method,
      claim_match: claimProjection.method,
    },
  };
}

export function compareAdmittedCitationEvidence({ admission, oracleCitations = [] }) {
  exactKeys(admission, ["batch_policy_sha256", "benchmark_claim_ready", "content_representation", "contract", "document_id", "observation",
    "document_table_regions", "document_table_regions_sha256", "field_outcomes", "first_table_evidence",
    "package_inclusion", "document_map_sha256", "proposal", "proposal_sha256", "source_replay",
    "submitted_proposal", "submitted_proposal_sha256"], "admission");
  exactKeys(admission.contract, ["name", "version"], "admission.contract");
  assertion(admission.contract.name === "pdf-tools.verified-extraction-response-admission"
    && admission.contract.version === "1.4.0-experimental", "admission contract is invalid");
  assertion(admission.benchmark_claim_ready === false && admission.package_inclusion === "disabled_experimental",
    "admission readiness boundary is invalid");
  assertion(SHA256.test(admission.document_map_sha256) && SHA256.test(admission.batch_policy_sha256),
    "admission document-map or batch-policy binding is invalid");
  const tableRegions = validateDocumentTableRegions(admission.document_table_regions);
  assertion(SHA256.test(admission.document_table_regions_sha256)
    && admission.document_table_regions_sha256 === tableRegions.sha256,
  "admission table-region binding is invalid");
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
  exactKeys(admission.content_representation,
    ["kind", "raw_content_sha256", "strict_json_payload", "strict_json_payload_sha256"],
    "admission.content_representation");
  assertion(["direct_strict_json", "single_lowercase_json_markdown_fence.v1"]
    .includes(admission.content_representation.kind)
    && admission.content_representation.raw_content_sha256 === admission.observation.content_sha256
    && SHA256.test(admission.content_representation.strict_json_payload_sha256),
  "admission content representation binding is invalid");
  boundedString(admission.content_representation.strict_json_payload,
    "admission.content_representation.strict_json_payload", 1024 * 1024);
  const replayedSubmittedProposal = parseStrictJson(admission.content_representation.strict_json_payload,
    "admission.content_representation.strict_json_payload");
  const reconstructedContent = admission.content_representation.kind === "direct_strict_json"
    ? admission.content_representation.strict_json_payload
    : `${JSON_FENCE_PREFIX}${admission.content_representation.strict_json_payload}${JSON_FENCE_SUFFIX}`;
  assertion(admission.content_representation.strict_json_payload_sha256
    === sha256(Buffer.from(admission.content_representation.strict_json_payload, "utf8"))
    && admission.content_representation.raw_content_sha256
      === sha256(Buffer.from(reconstructedContent, "utf8"))
    && canonicalJson(replayedSubmittedProposal) === canonicalJson(admission.submitted_proposal),
  "admission content representation replay is invalid");
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
  assertion(SHA256.test(admission.submitted_proposal_sha256)
    && admission.submitted_proposal_sha256
      === sha256(Buffer.from(canonicalJson(admission.submitted_proposal), "utf8")),
  "admission submitted-proposal digest drifted");
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
  exactKeys(admission.submitted_proposal, PROPOSAL_KEYS, "admission.submitted_proposal");
  assertion(Array.isArray(admission.proposal.contributors), "admission proposal contributors are invalid");
  exactKeys(admission.field_outcomes, ALL_FIELDS, "admission.field_outcomes");
  for (const field of ALL_FIELDS) {
    const outcome = admission.field_outcomes[field];
    exactKeys(outcome, ["admitted_sha256", "citation_count", "message", "reason_code", "status",
      "submitted_sha256"], `admission.field_outcomes.${field}`);
    const submitted = admission.submitted_proposal[field];
    const admitted = admission.proposal[field];
    assertion(SHA256.test(outcome.submitted_sha256)
      && outcome.submitted_sha256 === sha256(Buffer.from(canonicalJson(submitted), "utf8"))
      && SHA256.test(outcome.admitted_sha256)
      && outcome.admitted_sha256 === sha256(Buffer.from(canonicalJson(admitted), "utf8"))
      && Number.isSafeInteger(outcome.citation_count) && outcome.citation_count >= 0,
    `admission.field_outcomes.${field} digest or count is invalid`);
    const emptyValue = field === "contributors" ? [] : null;
    const admittedCitationCount = field === "contributors"
      ? (Array.isArray(admitted) ? admitted.length : -1)
      : admitted === null ? 0 : 1;
    if (outcome.status === "admitted") {
      assertion(canonicalJson(submitted) === canonicalJson(admitted)
        && outcome.reason_code === "none" && outcome.message === null
        && outcome.citation_count === admittedCitationCount && admittedCitationCount > 0,
      `admission.field_outcomes.${field} admitted state is invalid`);
    } else if (outcome.status === "not_proposed") {
      assertion(canonicalJson(submitted) === canonicalJson(emptyValue)
        && canonicalJson(admitted) === canonicalJson(emptyValue)
        && outcome.reason_code === "none" && outcome.message === null && outcome.citation_count === 0,
      `admission.field_outcomes.${field} not-proposed state is invalid`);
    } else {
      assertion(outcome.status === "rejected" && canonicalJson(admitted) === canonicalJson(emptyValue)
        && outcome.reason_code === "not_source_bound" && typeof outcome.message === "string"
        && outcome.message.length > 0 && Buffer.byteLength(outcome.message, "utf8") <= 4096
        && outcome.citation_count === 0,
      `admission.field_outcomes.${field} rejection state is invalid`);
    }
  }
  assertion(ALL_FIELDS.reduce((total, field) => total + admission.field_outcomes[field].citation_count, 0)
    === admission.source_replay.citation_count,
  "admission field-outcome and source-replay citation denominators disagree");
  if (admission.field_outcomes.first_table.status === "admitted") {
    exactKeys(admission.first_table_evidence,
      ["document_table_regions_sha256", "region", "region_sha256"], "admission.first_table_evidence");
    exactKeys(admission.first_table_evidence.region,
      ["bbox", "coordinate_space", "evidence_truncation", "page", "reason", "region_id", "text_item_count"],
    "admission.first_table_evidence.region");
    const region = admission.first_table_evidence.region;
    const match = typeof region.region_id === "string" ? region.region_id.match(TABLE_REGION_ID) : null;
    assertion(admission.first_table_evidence.document_table_regions_sha256
      === admission.document_table_regions_sha256
      && SHA256.test(admission.first_table_evidence.region_sha256)
      && admission.first_table_evidence.region_sha256
        === sha256(Buffer.from(canonicalJson(region), "utf8"))
      && canonicalJson(region) === canonicalJson(tableRegions.first)
      && match && Number(match[1]) === region.page
      && region.page === admission.proposal.first_table.page_one_based,
    "admission first-table region evidence is invalid");
  } else {
    assertion(admission.first_table_evidence === null,
      "admission retains table-region evidence for a non-admitted first_table field");
  }
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
    exactKeys(citation, ["chunk_id", "claim_end_utf8_byte", "claim_source_excerpt",
      "claim_source_excerpt_sha256", "claim_start_utf8_byte", "document_id", "end_utf8_byte", "field",
      "page_one_based", "projection", "quote", "quote_sha256", "start_utf8_byte", "submitted_quote",
      "submitted_quote_sha256"], `admission.source_replay.citations[${index}]`);
    exactKeys(citation.projection, ["claim_match", "policy", "quote_match"],
      `admission.source_replay.citations[${index}].projection`);
    assertion(citation.document_id === admission.document_id && CHUNK_ID.test(citation.chunk_id)
      && Number.isSafeInteger(citation.page_one_based) && citation.page_one_based >= 1
      && Number.isSafeInteger(citation.start_utf8_byte) && citation.start_utf8_byte >= 0
      && Number.isSafeInteger(citation.end_utf8_byte)
      && citation.end_utf8_byte === citation.start_utf8_byte + Buffer.byteLength(citation.quote, "utf8")
      && SHA256.test(citation.quote_sha256)
      && citation.quote_sha256 === sha256(Buffer.from(citation.quote, "utf8"))
      && SHA256.test(citation.submitted_quote_sha256)
      && citation.submitted_quote_sha256 === sha256(Buffer.from(citation.submitted_quote, "utf8"))
      && Number.isSafeInteger(citation.claim_start_utf8_byte)
      && Number.isSafeInteger(citation.claim_end_utf8_byte)
      && citation.claim_start_utf8_byte >= citation.start_utf8_byte
      && citation.claim_end_utf8_byte <= citation.end_utf8_byte
      && citation.claim_end_utf8_byte === citation.claim_start_utf8_byte
        + Buffer.byteLength(citation.claim_source_excerpt, "utf8")
      && SHA256.test(citation.claim_source_excerpt_sha256)
      && citation.claim_source_excerpt_sha256
        === sha256(Buffer.from(citation.claim_source_excerpt, "utf8"))
      && citation.projection.policy === SOURCE_PROJECTION_POLICY,
    `admission.source_replay.citations[${index}] binding is invalid`);
    const [expectedField, expectedClaim] = expectedCitationClaims[index];
    assertion(citation.field === expectedField && typeof expectedClaim === "string",
      `admission.source_replay.citations[${index}] does not bind its proposal field`);
    const replayedQuote = uniqueSourceProjection(citation.quote, citation.submitted_quote,
      `admission.source_replay.citations[${index}].submitted_quote`);
    const replayedClaim = uniqueSourceProjection(citation.quote, expectedClaim,
      `admission.source_replay.citations[${index}].claim`);
    assertion(replayedQuote.start_utf16 === 0 && replayedQuote.end_utf16 === citation.quote.length
      && replayedQuote.source_excerpt === citation.quote
      && replayedQuote.method === citation.projection.quote_match
      && replayedClaim.source_excerpt === citation.claim_source_excerpt
      && citation.start_utf8_byte + byteOffset(citation.quote, replayedClaim.start_utf16)
        === citation.claim_start_utf8_byte
      && replayedClaim.method === citation.projection.claim_match,
    `admission.source_replay.citations[${index}] projection drifted`);
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

function fieldOutcome({ status, submitted, admitted, citationCount = 0, error = null }) {
  return {
    status,
    reason_code: error ? "not_source_bound" : "none",
    message: error ? String(error?.message ?? error) : null,
    citation_count: citationCount,
    submitted_sha256: sha256(Buffer.from(canonicalJson(submitted), "utf8")),
    admitted_sha256: sha256(Buffer.from(canonicalJson(admitted), "utf8")),
  };
}

function admitProposal(submittedProposal, chunksById, allowedFields, tableRegions) {
  exactKeys(submittedProposal, PROPOSAL_KEYS, "proposal");
  const allowed = new Set(allowedFields);
  const proposal = { agency: null, publication_citation_excerpt: null, contributors: [], first_table: null };
  const citations = [];
  const fieldOutcomes = {};
  let firstTableEvidence = null;
  for (const field of ["agency", "publication_citation_excerpt"]) {
    const submitted = submittedProposal[field];
    try {
      if (!allowed.has(field)) assertion(submitted === null, `${field} is forbidden for this source section`);
      const replay = validateCitedString(submitted, chunksById, field);
      proposal[field] = structuredClone(submitted);
      if (replay) citations.push({ field, ...replay });
      fieldOutcomes[field] = fieldOutcome({
        status: replay ? "admitted" : "not_proposed",
        submitted,
        admitted: proposal[field],
        citationCount: replay ? 1 : 0,
      });
    } catch (error) {
      fieldOutcomes[field] = fieldOutcome({ status: "rejected", submitted, admitted: null, error });
    }
  }

  const submittedContributors = submittedProposal.contributors;
  try {
    assertion(Array.isArray(submittedContributors), "contributors must be an array");
    if (!allowed.has("contributors")) assertion(submittedContributors.length === 0,
      "contributors are forbidden for this source section");
    assertion(submittedContributors.length <= MAX_ADMITTED_CONTRIBUTORS,
      `contributors exceeds maxItems ${MAX_ADMITTED_CONTRIBUTORS}`);
    const contributorNames = new Set();
    const contributorCitations = submittedContributors.map((contributor, index) => {
      exactKeys(contributor, ["citation", "name"], `contributors[${index}]`);
      boundedString(contributor.name, `contributors[${index}].name`, 512);
      assertion(!contributorNames.has(contributor.name), "contributors contains a duplicate exact name");
      contributorNames.add(contributor.name);
      return { field: `contributors[${index}]`,
        ...validateCitation(contributor.citation, chunksById, contributor.name, `contributors[${index}]`) };
    });
    proposal.contributors = structuredClone(submittedContributors);
    citations.push(...contributorCitations);
    fieldOutcomes.contributors = fieldOutcome({
      status: submittedContributors.length > 0 ? "admitted" : "not_proposed",
      submitted: submittedContributors,
      admitted: proposal.contributors,
      citationCount: contributorCitations.length,
    });
  } catch (error) {
    fieldOutcomes.contributors = fieldOutcome({
      status: "rejected", submitted: submittedContributors, admitted: [], error,
    });
  }

  const submittedTable = submittedProposal.first_table;
  try {
    if (!allowed.has("first_table")) assertion(submittedTable === null,
      "first_table is forbidden for this source section");
    if (submittedTable !== null) {
      exactKeys(submittedTable, ["anchor_excerpt", "citation", "page_one_based"], "first_table");
      nonnegativeInteger(submittedTable.page_one_based, "first_table.page_one_based");
      assertion(submittedTable.page_one_based >= 1, "first_table.page_one_based must be positive");
      boundedString(submittedTable.anchor_excerpt, "first_table.anchor_excerpt");
      const replay = validateCitation(submittedTable.citation, chunksById,
        submittedTable.anchor_excerpt, "first_table");
      assertion(replay.page_one_based === submittedTable.page_one_based,
        "first_table page does not match its exact chunk");
      assertion(tableRegions.first !== null,
        "first_table is not supported by a returned deterministic table region");
      assertion(tableRegions.first.page === submittedTable.page_one_based,
        "first_table page does not match the first deterministic table region");
      proposal.first_table = structuredClone(submittedTable);
      citations.push({ field: "first_table", ...replay });
      firstTableEvidence = {
        document_table_regions_sha256: tableRegions.sha256,
        region: structuredClone(tableRegions.first),
        region_sha256: sha256(Buffer.from(canonicalJson(tableRegions.first), "utf8")),
      };
    }
    fieldOutcomes.first_table = fieldOutcome({
      status: submittedTable === null ? "not_proposed" : "admitted",
      submitted: submittedTable,
      admitted: proposal.first_table,
      citationCount: submittedTable === null ? 0 : 1,
    });
  } catch (error) {
    fieldOutcomes.first_table = fieldOutcome({ status: "rejected", submitted: submittedTable, admitted: null, error });
  }
  return { proposal, citations, fieldOutcomes, firstTableEvidence };
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
  documentTableRegions,
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
  const tableRegions = validateDocumentTableRegions(documentTableRegions);
  exactKeys(batchPolicy, ["allowed_fields", "batch_chunk_ids", "chunk_policies", "document_chunk_scope_sha256",
    "document_id", "document_map_sha256", "document_table_regions_sha256", "model_call_recommended"],
  "batchPolicy");
  assertion(batchPolicy.document_id === documentId, "batchPolicy belongs to another document");
  const recomputedPolicy = classifySourceBoundBatch({
    documentId,
    documentMapSha256,
    documentChunks,
    documentTableRegions,
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
  let parsedContent;
  try {
    parsedContent = parseModelResponseProposalContent(content);
  } catch (error) {
    throw new ModelOutputAdmissionError(error.message, "model_response_ambiguous_or_malformed", observation);
  }
  const submittedProposal = parsedContent.proposal;
  let admitted;
  try {
    admitted = admitProposal(submittedProposal, chunksById, batchPolicy.allowed_fields, tableRegions);
  } catch (error) {
    throw new ModelOutputAdmissionError(error.message, "model_proposal_not_source_bound", observation);
  }
  return {
    contract: { name: "pdf-tools.verified-extraction-response-admission", version: "1.4.0-experimental" },
    document_id: documentId,
    document_map_sha256: documentMapSha256,
    batch_policy_sha256: batchPolicySha256,
    document_table_regions: structuredClone(documentTableRegions),
    document_table_regions_sha256: tableRegions.sha256,
    observation,
    content_representation: parsedContent.representation,
    submitted_proposal: submittedProposal,
    submitted_proposal_sha256: sha256(Buffer.from(canonicalJson(submittedProposal), "utf8")),
    proposal: admitted.proposal,
    proposal_sha256: sha256(Buffer.from(canonicalJson(admitted.proposal), "utf8")),
    field_outcomes: admitted.fieldOutcomes,
    first_table_evidence: admitted.firstTableEvidence,
    source_replay: {
      citation_count: admitted.citations.length,
      citations: admitted.citations,
      contributor_count: admitted.proposal.contributors.length,
      contributor_count_derivation: "derived_from_admitted_contributors_not_model_arithmetic",
    },
    benchmark_claim_ready: false,
    package_inclusion: "disabled_experimental",
  };
}

export const VERIFIED_EXTRACTION_RESPONSE_ADMISSION_POLICY = Object.freeze({
  name: "pdf-tools.verified-extraction-response-admission",
  version: "1.4.0-experimental",
  boundary: "Only strict proposals whose submitted citations and claims uniquely replay to exact source bytes in a separately validated SHA-bound document map and current batch are admitted. Proposal representation is either direct strict JSON or one exact lowercase-json Markdown fence with no surrounding bytes, nested fence, prose, or alternate wrapper; the raw content and strict payload digests are both retained. Internal whitespace projection is explicit and fail-closed on ambiguity; submitted and exact source spans are both retained. A first_table proposal additionally binds the exact cited page to the first deterministic table-region signal in the validated document map; contents-page destination references cannot satisfy that boundary. A source-invalid known field is replaced by its schema-safe null or empty value with a digest-bound typed rejection while independently valid fields remain admitted; malformed envelopes, duplicate members, and top-level field smuggling still reject the whole response. This helper rehashes chunks and binds table-region inventory but does not replace document-map source/schema/renderer validation. Output-cap termination is a typed truncation failure. Reference-section batches are evidence-ineligible. Exact oracle-span equality remains a separate secondary evaluation and is not treated as source support.",
});
