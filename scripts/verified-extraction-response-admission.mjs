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
const SOURCE_PROJECTION_POLICY = "chunk-plus-canonical-source-page-token-projection.v1";
const SOURCE_PAGE_SCHEME = "verified-extraction-normalized-source-pages.v1";
const SOURCE_PAGE_NORMALIZATION = "unicode_whitespace_runs_to_ascii_space_then_trim";
const MIN_CITATION_CHARACTERS = 3;
const MAX_CITATION_CHARACTERS = 700;
const MIN_PUBLICATION_CHARACTERS = 50;
const MAX_PUBLICATION_CHARACTERS = 700;
const MIN_TABLE_ANCHOR_CHARACTERS = 20;
const MAX_TABLE_ANCHOR_CHARACTERS = 360;
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

function boundedStringAllowEmpty(value, label, maximum = 4096) {
  assertion(typeof value === "string", `${label} must be a string`);
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

function normalizeSourceText(value) {
  assertion(typeof value === "string", "source text must be a string");
  return value.replace(/\s+/gu, " ").trim();
}

function withoutKey(value, key) {
  const copy = structuredClone(value);
  delete copy[key];
  return copy;
}

export function validateNormalizedSourcePageBundle(value, { documentId, sourceSha256 } = {}) {
  exactKeys(value, ["document_id", "pages", "scheme", "source_identity", "source_page_text_bundle_sha256",
    "version"], "documentSourcePages");
  assertion(value.version === 1 && value.scheme === SOURCE_PAGE_SCHEME,
    "documentSourcePages contract is unsupported");
  boundedString(value.document_id, "documentSourcePages.document_id", 512);
  if (documentId !== undefined) assertion(value.document_id === documentId,
    "documentSourcePages belongs to another document");
  exactKeys(value.source_identity,
    ["normalization", "page_count", "pdf_sha256", "pdfjs_package_sha256"],
    "documentSourcePages.source_identity");
  assertion(SHA256.test(value.source_identity.pdf_sha256 ?? "")
    && value.source_identity.pdf_sha256 !== "0".repeat(64),
  "documentSourcePages PDF identity is invalid");
  if (sourceSha256 !== undefined) assertion(value.source_identity.pdf_sha256 === sourceSha256,
    "documentSourcePages PDF identity drifted");
  assertion(SHA256.test(value.source_identity.pdfjs_package_sha256 ?? "")
    && value.source_identity.pdfjs_package_sha256 !== "0".repeat(64),
  "documentSourcePages PDF.js identity is invalid");
  assertion(value.source_identity.normalization === SOURCE_PAGE_NORMALIZATION,
    "documentSourcePages normalization drifted");
  assertion(Number.isSafeInteger(value.source_identity.page_count)
    && value.source_identity.page_count >= 1 && value.source_identity.page_count <= 10000,
  "documentSourcePages page count is invalid");
  assertion(Array.isArray(value.pages)
    && value.pages.length === value.source_identity.page_count,
  "documentSourcePages page denominator is incomplete");
  const pagesByNumber = new Map();
  value.pages.forEach((page, index) => {
    exactKeys(page, ["normalized_text", "normalized_text_sha256", "page_one_based"],
      `documentSourcePages.pages[${index}]`);
    assertion(page.page_one_based === index + 1,
      "documentSourcePages pages are omitted, duplicated, or out of order");
    boundedStringAllowEmpty(page.normalized_text, `documentSourcePages.pages[${index}].normalized_text`,
      16 * 1024 * 1024);
    assertion(page.normalized_text === normalizeSourceText(page.normalized_text),
      `documentSourcePages.pages[${index}] is not canonical`);
    assertion(SHA256.test(page.normalized_text_sha256 ?? "")
      && page.normalized_text_sha256 === sha256(Buffer.from(page.normalized_text, "utf8")),
    `documentSourcePages.pages[${index}] digest drifted`);
    pagesByNumber.set(page.page_one_based, page);
  });
  assertion(SHA256.test(value.source_page_text_bundle_sha256 ?? "")
    && value.source_page_text_bundle_sha256
      === sha256(Buffer.from(canonicalJson(withoutKey(value, "source_page_text_bundle_sha256")), "utf8")),
  "documentSourcePages self-digest drifted");
  return { pagesByNumber, sha256: value.source_page_text_bundle_sha256 };
}

export function buildNormalizedSourcePageBundle({
  documentId, sourceBytes, pdfjsPackageBytes, layouts,
}) {
  boundedString(documentId, "documentId", 512);
  assertion(Buffer.isBuffer(sourceBytes) || sourceBytes instanceof Uint8Array,
    "sourceBytes must be exact bytes");
  assertion(Buffer.isBuffer(pdfjsPackageBytes) || pdfjsPackageBytes instanceof Uint8Array,
    "pdfjsPackageBytes must be exact bytes");
  const exactSourceBytes = Buffer.from(sourceBytes);
  const exactPdfjsPackageBytes = Buffer.from(pdfjsPackageBytes);
  assertion(exactSourceBytes.length > 0 && exactSourceBytes.length <= 250 * 1024 * 1024,
    "sourceBytes is outside the supported bound");
  assertion(exactPdfjsPackageBytes.length > 0 && exactPdfjsPackageBytes.length <= 1024 * 1024,
    "pdfjsPackageBytes is outside the supported bound");
  let pdfjsPackage;
  try {
    pdfjsPackage = parseStrictJson(exactPdfjsPackageBytes, "pdfjsPackageBytes");
  } catch (error) {
    throw new Error(`pdfjsPackageBytes is invalid: ${error.message}`);
  }
  assertion(pdfjsPackage?.name === "pdfjs-dist" && pdfjsPackage.version === "5.4.624",
    "PDF.js package identity is unsupported");
  assertion(Array.isArray(layouts) && layouts.length > 0, "layouts must be a non-empty array");
  const sourceSha256 = sha256(exactSourceBytes);
  const totalPages = layouts[0]?.page_range?.total_pages;
  assertion(Number.isSafeInteger(totalPages) && totalPages >= 1 && totalPages <= 10000,
    "layout page denominator is invalid");
  const pages = layouts.flatMap((layout, layoutIndex) => {
    assertion(layout?.source?.sha256 === sourceSha256,
      `layouts[${layoutIndex}] source identity drifted`);
    assertion(layout?.parser?.name === "pdfjs-dist" && layout.parser.version === "5.4.624",
      `layouts[${layoutIndex}] parser identity drifted`);
    assertion(layout?.page_range?.total_pages === totalPages && Array.isArray(layout.pages),
      `layouts[${layoutIndex}] page denominator drifted`);
    return layout.pages;
  }).sort((left, right) => left.page - right.page);
  assertion(pages.length === totalPages,
    "layouts omit or duplicate canonical source pages");
  const retainedPages = pages.map((page, index) => {
    assertion(page?.page === index + 1 && Array.isArray(page.raw_items),
      "layouts contain an omitted, duplicated, substituted, or out-of-order page");
    assertion(page?.truncation?.omitted_items === 0
      && page?.counts?.observed_items === page.raw_items.length
      && page?.counts?.returned_items === page.raw_items.length,
    `layout page ${page.page} does not retain the complete PDF.js text-item denominator`);
    const sourceItems = [...page.raw_items].sort((left, right) => left.source_index - right.source_index);
    sourceItems.forEach((item, itemIndex) => {
      assertion(item.source_index === itemIndex && typeof (item.source_text ?? item.text) === "string",
        `layout page ${page.page} raw item order is incomplete`);
    });
    const normalizedText = normalizeSourceText(sourceItems.map(item => item.source_text ?? item.text).join(" "));
    return {
      page_one_based: page.page,
      normalized_text: normalizedText,
      normalized_text_sha256: sha256(Buffer.from(normalizedText, "utf8")),
    };
  });
  const body = {
    version: 1,
    scheme: SOURCE_PAGE_SCHEME,
    document_id: documentId,
    source_identity: {
      pdf_sha256: sourceSha256,
      page_count: totalPages,
      pdfjs_package_sha256: sha256(exactPdfjsPackageBytes),
      normalization: SOURCE_PAGE_NORMALIZATION,
    },
    pages: retainedPages,
  };
  const bundle = {
    ...body,
    source_page_text_bundle_sha256: sha256(Buffer.from(canonicalJson(body), "utf8")),
  };
  validateNormalizedSourcePageBundle(bundle, { documentId, sourceSha256 });
  return bundle;
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
    items: value.items,
    first: value.items[0] ?? null,
  };
}

function looksLikeContentsPage(pageText) {
  const lead = pageText.slice(0, 500);
  const dotLeaderCount = pageText.match(/\.{3,}/gu)?.length ?? 0;
  return /^(?:contents|table of contents|list of (?:figures|tables)|figures|tables)\b/iu.test(lead)
    || /\bcontents\b/iu.test(lead) && /(?:\.{3,}|\bTable\s+2\b.*\bTable\s+3\b)/iu.test(pageText)
    || /^[ivxlcdm]+\s+/iu.test(lead) && dotLeaderCount >= 2;
}

function selectUniqueTableSupport({ anchorExcerpt, documentChunks, pageOneBased }) {
  const coveringChunks = documentChunks.filter(chunk => (
    chunk.page_range.start_page <= pageOneBased && chunk.page_range.end_page >= pageOneBased
      && chunk.content.split(/\r?\n/gu).some(line => (
        /^\s*(?:Table|TABLE)\s+1(?:\.[0-9]+)?\.(?:\s+\S.*)?\s*$/u.test(line)
      ))
  ));
  const anchors = sourceTokens(anchorExcerpt)
    .filter(entry => entry.end >= MIN_TABLE_ANCHOR_CHARACTERS && entry.end <= 80)
    .map(entry => anchorExcerpt.slice(0, entry.end).trimEnd())
    .filter((anchor, index, all) => index === 0 || anchor !== all[index - 1])
    .reverse();
  for (const supportAnchor of anchors) {
    const supportingChunks = coveringChunks.filter(chunk => {
      try {
        uniqueTokenProjection(chunk.content, supportAnchor, "first actual table chunk heading");
        return true;
      } catch {
        return false;
      }
    });
    if (supportingChunks.length === 1) {
      return { chunk: supportingChunks[0], supportAnchor };
    }
  }
  return null;
}

function selectFirstActualTable({ documentChunks, tableRegions, sourcePages }) {
  for (const page of sourcePages.pagesByNumber.values()) {
    if (looksLikeContentsPage(page.normalized_text)) continue;
    const heading = /\b(?:Table|TABLE)\s+1(?:\.[0-9]+)?\.\s+\S/gu.exec(page.normalized_text);
    if (!heading) continue;
    const pageOneBased = page.page_one_based;
    const anchorExcerpt = page.normalized_text.slice(heading.index,
      Math.min(page.normalized_text.length, heading.index + MAX_TABLE_ANCHOR_CHARACTERS));
    if (anchorExcerpt.length < MIN_TABLE_ANCHOR_CHARACTERS) continue;
    const support = selectUniqueTableSupport({ anchorExcerpt, documentChunks, pageOneBased });
    if (support === null) continue;
    const { chunk, supportAnchor } = support;
    const region = tableRegions.items.find(item => item.page === pageOneBased) ?? null;
    return {
      page_one_based: pageOneBased,
      chunk_id: chunk.chunk_id,
      region_id: region?.region_id ?? null,
      support_anchor: supportAnchor,
      support_anchor_sha256: sha256(Buffer.from(supportAnchor, "utf8")),
      classification: "actual_data_table",
      evidence_kind: region === null
        ? "canonical_source_heading"
        : "canonical_source_heading_plus_abandoned_table_region",
    };
  }
  return null;
}

export function classifySourceBoundBatch({
  documentId, documentMapSha256, sourceSha256, documentChunks, documentTableRegions,
  documentSourcePages, batchChunkIds,
}) {
  boundedString(documentId, "documentId", 512);
  assertion(SHA256.test(documentMapSha256 ?? ""), "documentMapSha256 is invalid");
  assertion(Array.isArray(documentChunks) && documentChunks.length > 0,
    "documentChunks must be a non-empty array");
  assertion(Array.isArray(batchChunkIds) && batchChunkIds.length > 0,
    "batchChunkIds must be a non-empty array");
  assertion(SHA256.test(sourceSha256 ?? "") && sourceSha256 !== "0".repeat(64),
    "sourceSha256 is invalid");
  const tableRegions = validateDocumentTableRegions(documentTableRegions);
  const sourcePages = validateNormalizedSourcePageBundle(documentSourcePages, { documentId, sourceSha256 });
  const seen = new Set();
  let inReferenceSection = false;
  let precedingChunkPage = 0;
  const allPolicies = documentChunks.map((chunk, index) => {
    validateChunk(chunk, documentId, index);
    assertion(chunk.page_range.start_page >= precedingChunkPage,
      "documentChunks are not in deterministic page order");
    precedingChunkPage = chunk.page_range.start_page;
    assertion(sourcePages.pagesByNumber.has(chunk.page_range.start_page),
      `chunks[${index}] page is absent from documentSourcePages`);
    assertion(!seen.has(chunk.chunk_id), "documentChunks contain a duplicate chunk identity");
    seen.add(chunk.chunk_id);
    if (chunk.starts_at_heading) {
      const heading = firstLine(chunk.content);
      if (REFERENCE_HEADINGS.has(heading)) inReferenceSection = true;
      else if (/^Appendix(?:\s|$)/iu.test(heading)) inReferenceSection = false;
    }
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
  const firstActualTable = selectFirstActualTable({ documentChunks, tableRegions, sourcePages });
  const containsFirstActualTable = firstActualTable !== null && batchChunks.some(chunk => (
    chunk.page_range.start_page <= firstActualTable.page_one_based
      && chunk.page_range.end_page >= firstActualTable.page_one_based
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
    source_sha256: sourceSha256,
    source_page_text_bundle_sha256: sourcePages.sha256,
    document_table_regions_sha256: tableRegions.sha256,
    document_chunk_scope_sha256: documentChunkScopeSha256,
    first_actual_table: firstActualTable,
    batch_chunk_ids: [...batchChunkIds],
    allowed_fields: containsReferenceSection ? [] : ALL_FIELDS.filter(field => (
      field !== "first_table" || containsFirstActualTable
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
      quote: { type: "string", minLength: MIN_CITATION_CHARACTERS, maxLength: MAX_CITATION_CHARACTERS },
    },
  };
  const citedString = (enabledValue, maximum = 4096) => enabledValue ? {
    anyOf: [
      { type: "null" },
      {
        type: "object",
        additionalProperties: false,
        required: ["value", "citation"],
        properties: { value: { type: "string", minLength: 1, maxLength: maximum }, citation },
      },
    ],
  } : { type: "null" };
  return {
    type: "object",
    additionalProperties: false,
    required: ALL_FIELDS,
    properties: {
      agency: citedString(enabled.has("agency"), 512),
      publication_citation_excerpt: citedString(enabled.has("publication_citation_excerpt"),
        MAX_PUBLICATION_CHARACTERS),
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
              anchor_excerpt: { type: "string", minLength: MIN_TABLE_ANCHOR_CHARACTERS,
                maxLength: MAX_TABLE_ANCHOR_CHARACTERS },
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

function sourceTokens(value) {
  return [...value.matchAll(/[\p{L}\p{M}\p{N}]+|[^\s\p{L}\p{M}\p{N}]/gu)].map(match => ({
    value: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function uniqueTokenProjection(source, submitted, label) {
  boundedString(source, `${label}.source`, 16 * 1024 * 1024);
  boundedString(submitted, `${label}.submitted`);
  assertion(submitted === submitted.trim(), `${label} has leading or trailing whitespace`);
  const sourceEntries = sourceTokens(source);
  const submittedEntries = sourceTokens(submitted);
  assertion(submittedEntries.length > 0, `${label} has no source tokens`);
  const submittedValues = submittedEntries.map(entry => entry.value);
  const matches = [];
  for (let start = 0; start <= sourceEntries.length - submittedValues.length; start += 1) {
    if (submittedValues.every((value, offset) => sourceEntries[start + offset].value === value)) {
      const first = sourceEntries[start];
      const last = sourceEntries[start + submittedValues.length - 1];
      matches.push({
        start_utf16: first.start,
        end_utf16: last.end,
        source_excerpt: source.slice(first.start, last.end),
      });
    }
  }
  assertion(matches.length > 0, `${label} does not replay from the tokenized source`);
  assertion(matches.length === 1, `${label} is ambiguous in the tokenized source`);
  const match = matches[0];
  return {
    ...match,
    method: match.source_excerpt === submitted ? "exact" : "unique_source_token_projection",
  };
}

function byteOffset(value, utf16Offset) {
  return Buffer.byteLength(value.slice(0, utf16Offset), "utf8");
}

function validateCitation(citation, chunksById, sourcePages, claimedValue, label) {
  exactKeys(citation, ["chunk_id", "quote"], `${label}.citation`);
  assertion(CHUNK_ID.test(citation.chunk_id), `${label}.citation.chunk_id is invalid`);
  boundedString(citation.quote, `${label}.citation.quote`);
  const chunk = chunksById.get(citation.chunk_id);
  assertion(chunk, `${label}.citation references a stale or cross-document chunk`);
  const chunkQuoteProjection = uniqueTokenProjection(chunk.content, citation.quote,
    `${label}.citation chunk quote`);
  const chunkClaimProjection = uniqueTokenProjection(chunkQuoteProjection.source_excerpt, claimedValue,
    `${label}.citation chunk claimed value`);
  const sourcePage = sourcePages.pagesByNumber.get(chunk.page_range.start_page);
  assertion(sourcePage, `${label}.citation references a page absent from the canonical source bundle`);
  const quoteProjection = uniqueTokenProjection(sourcePage.normalized_text, citation.quote,
    `${label}.citation canonical page quote`);
  const claimProjection = uniqueTokenProjection(quoteProjection.source_excerpt, claimedValue,
    `${label}.citation canonical page claimed value`);
  const quoteStart = byteOffset(sourcePage.normalized_text, quoteProjection.start_utf16);
  const quoteBytes = Buffer.from(quoteProjection.source_excerpt, "utf8");
  const claimStart = quoteStart + byteOffset(quoteProjection.source_excerpt, claimProjection.start_utf16);
  const claimBytes = Buffer.from(claimProjection.source_excerpt, "utf8");
  const chunkQuoteStart = byteOffset(chunk.content, chunkQuoteProjection.start_utf16);
  const chunkQuoteBytes = Buffer.from(chunkQuoteProjection.source_excerpt, "utf8");
  const chunkClaimStart = chunkQuoteStart
    + byteOffset(chunkQuoteProjection.source_excerpt, chunkClaimProjection.start_utf16);
  const normalizedQuoteLength = normalizeSourceText(quoteProjection.source_excerpt).length;
  assertion(normalizedQuoteLength >= MIN_CITATION_CHARACTERS
    && normalizedQuoteLength <= MAX_CITATION_CHARACTERS,
  `${label}.citation canonical quote length is invalid`);
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
    source_page_text_sha256: sourcePage.normalized_text_sha256,
    source_page_text_bundle_sha256: sourcePages.sha256,
    claim_source_excerpt: claimProjection.source_excerpt,
    claim_source_excerpt_sha256: sha256(claimBytes),
    claim_start_utf8_byte: claimStart,
    claim_end_utf8_byte: claimStart + claimBytes.length,
    chunk_source_excerpt: chunkQuoteProjection.source_excerpt,
    chunk_source_excerpt_sha256: sha256(chunkQuoteBytes),
    chunk_start_utf8_byte: chunkQuoteStart,
    chunk_end_utf8_byte: chunkQuoteStart + chunkQuoteBytes.length,
    chunk_claim_source_excerpt: chunkClaimProjection.source_excerpt,
    chunk_claim_source_excerpt_sha256: sha256(Buffer.from(chunkClaimProjection.source_excerpt, "utf8")),
    chunk_claim_start_utf8_byte: chunkClaimStart,
    chunk_claim_end_utf8_byte: chunkClaimStart
      + Buffer.byteLength(chunkClaimProjection.source_excerpt, "utf8"),
    projection: {
      policy: SOURCE_PROJECTION_POLICY,
      canonical_page_quote_match: quoteProjection.method,
      canonical_page_claim_match: claimProjection.method,
      chunk_quote_match: chunkQuoteProjection.method,
      chunk_claim_match: chunkClaimProjection.method,
    },
  };
}

export function compareAdmittedCitationEvidence({
  admission, batchPolicy, documentChunks, documentSourcePages, oracleCitations = [],
}) {
  exactKeys(admission, ["batch_policy_sha256", "benchmark_claim_ready", "content_representation", "contract", "document_id", "observation",
    "document_table_regions", "document_table_regions_sha256", "field_outcomes", "first_table_evidence",
    "package_inclusion", "document_map_sha256", "proposal", "proposal_sha256", "source_replay", "source_sha256",
    "source_page_text_bundle_sha256", "submitted_proposal", "submitted_proposal_sha256"], "admission");
  exactKeys(admission.contract, ["name", "version"], "admission.contract");
  assertion(admission.contract.name === "pdf-tools.verified-extraction-response-admission"
    && admission.contract.version === "1.6.0-experimental", "admission contract is invalid");
  assertion(admission.benchmark_claim_ready === false && admission.package_inclusion === "disabled_experimental",
    "admission readiness boundary is invalid");
  assertion(SHA256.test(admission.document_map_sha256) && SHA256.test(admission.batch_policy_sha256)
    && SHA256.test(admission.source_sha256) && SHA256.test(admission.source_page_text_bundle_sha256),
  "admission document-map or batch-policy binding is invalid");
  const sourcePages = validateNormalizedSourcePageBundle(documentSourcePages, {
    documentId: admission.document_id,
    sourceSha256: admission.source_sha256,
  });
  assertion(sourcePages.sha256 === admission.source_page_text_bundle_sha256,
    "admission source-page bundle binding is invalid");
  assertion(Array.isArray(documentChunks) && documentChunks.length > 0,
    "documentChunks must be supplied for independent citation replay");
  const chunksById = new Map();
  documentChunks.forEach((chunk, index) => {
    validateChunk(chunk, admission.document_id, index);
    assertion(!chunksById.has(chunk.chunk_id), "documentChunks contain a duplicate chunk identity");
    chunksById.set(chunk.chunk_id, chunk);
  });
  const tableRegions = validateDocumentTableRegions(admission.document_table_regions);
  assertion(SHA256.test(admission.document_table_regions_sha256)
    && admission.document_table_regions_sha256 === tableRegions.sha256,
  "admission table-region binding is invalid");
  const recomputedBatchPolicy = classifySourceBoundBatch({
    documentId: admission.document_id,
    documentMapSha256: admission.document_map_sha256,
    sourceSha256: admission.source_sha256,
    documentChunks,
    documentTableRegions: admission.document_table_regions,
    documentSourcePages,
    batchChunkIds: batchPolicy?.batch_chunk_ids,
  });
  assertion(canonicalJson(batchPolicy) === canonicalJson(recomputedBatchPolicy)
    && admission.batch_policy_sha256
      === sha256(Buffer.from(canonicalJson(recomputedBatchPolicy), "utf8")),
  "admission batch-policy binding is invalid");
  const admittedBatchChunkIds = new Set(recomputedBatchPolicy.batch_chunk_ids);
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
      assertion(outcome.reason_code === "none" && outcome.message === null
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
      ["document_table_regions_sha256", "region", "region_sha256", "selection", "selection_sha256"],
      "admission.first_table_evidence");
    const region = admission.first_table_evidence.region;
    const selection = admission.first_table_evidence.selection;
    exactKeys(selection, ["chunk_id", "classification", "evidence_kind", "page_one_based", "region_id",
      "support_anchor", "support_anchor_sha256"], "admission.first_table_evidence.selection");
    const hasRegion = selection.region_id !== null;
    if (hasRegion) {
      exactKeys(region,
        ["bbox", "coordinate_space", "evidence_truncation", "page", "reason", "region_id", "text_item_count"],
      "admission.first_table_evidence.region");
    }
    const match = hasRegion && typeof region?.region_id === "string"
      ? region.region_id.match(TABLE_REGION_ID) : null;
    assertion(admission.first_table_evidence.document_table_regions_sha256
      === admission.document_table_regions_sha256
      && SHA256.test(admission.first_table_evidence.selection_sha256)
      && admission.first_table_evidence.selection_sha256
        === sha256(Buffer.from(canonicalJson(selection), "utf8"))
      && selection.classification === "actual_data_table"
      && selection.support_anchor_sha256 === sha256(Buffer.from(selection.support_anchor, "utf8"))
      && selection.page_one_based === admission.proposal.first_table.page_one_based,
    "admission first-table region evidence is invalid");
    if (hasRegion) {
      assertion(selection.evidence_kind === "canonical_source_heading_plus_abandoned_table_region"
        && SHA256.test(admission.first_table_evidence.region_sha256)
        && admission.first_table_evidence.region_sha256
          === sha256(Buffer.from(canonicalJson(region), "utf8"))
        && canonicalJson(region)
          === canonicalJson(tableRegions.items.find(item => item.region_id === selection.region_id))
        && match && Number(match[1]) === region.page
        && region.page === selection.page_one_based,
      "admission first-table region evidence is invalid");
    } else {
      assertion(selection.evidence_kind === "canonical_source_heading"
        && region === null && admission.first_table_evidence.region_sha256 === null,
      "admission first-table source-heading evidence is invalid");
    }
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
    exactKeys(citation, ["chunk_claim_end_utf8_byte", "chunk_claim_source_excerpt",
      "chunk_claim_source_excerpt_sha256", "chunk_claim_start_utf8_byte", "chunk_end_utf8_byte", "chunk_id",
      "chunk_source_excerpt", "chunk_source_excerpt_sha256", "chunk_start_utf8_byte", "claim_end_utf8_byte",
      "claim_source_excerpt", "claim_source_excerpt_sha256", "claim_start_utf8_byte", "document_id",
      "end_utf8_byte", "field", "page_one_based", "projection", "quote", "quote_sha256",
      "source_page_text_bundle_sha256", "source_page_text_sha256", "start_utf8_byte", "submitted_quote",
      "submitted_quote_sha256"], `admission.source_replay.citations[${index}]`);
    exactKeys(citation.projection, ["canonical_page_claim_match", "canonical_page_quote_match",
      "chunk_claim_match", "chunk_quote_match", "policy"],
      `admission.source_replay.citations[${index}].projection`);
    assertion(citation.document_id === admission.document_id && CHUNK_ID.test(citation.chunk_id)
      && admittedBatchChunkIds.has(citation.chunk_id)
      && Number.isSafeInteger(citation.page_one_based) && citation.page_one_based >= 1
      && Number.isSafeInteger(citation.start_utf8_byte) && citation.start_utf8_byte >= 0
      && Number.isSafeInteger(citation.end_utf8_byte)
      && citation.end_utf8_byte === citation.start_utf8_byte + Buffer.byteLength(citation.quote, "utf8")
      && SHA256.test(citation.quote_sha256)
      && citation.quote_sha256 === sha256(Buffer.from(citation.quote, "utf8"))
      && SHA256.test(citation.submitted_quote_sha256)
      && citation.submitted_quote_sha256 === sha256(Buffer.from(citation.submitted_quote, "utf8"))
      && citation.source_page_text_bundle_sha256 === admission.source_page_text_bundle_sha256
      && SHA256.test(citation.source_page_text_sha256)
      && Number.isSafeInteger(citation.claim_start_utf8_byte)
      && Number.isSafeInteger(citation.claim_end_utf8_byte)
      && citation.claim_start_utf8_byte >= citation.start_utf8_byte
      && citation.claim_end_utf8_byte <= citation.end_utf8_byte
      && citation.claim_end_utf8_byte === citation.claim_start_utf8_byte
        + Buffer.byteLength(citation.claim_source_excerpt, "utf8")
      && SHA256.test(citation.claim_source_excerpt_sha256)
      && citation.claim_source_excerpt_sha256
        === sha256(Buffer.from(citation.claim_source_excerpt, "utf8"))
      && Number.isSafeInteger(citation.chunk_start_utf8_byte) && citation.chunk_start_utf8_byte >= 0
      && citation.chunk_end_utf8_byte === citation.chunk_start_utf8_byte
        + Buffer.byteLength(citation.chunk_source_excerpt, "utf8")
      && citation.chunk_source_excerpt_sha256
        === sha256(Buffer.from(citation.chunk_source_excerpt, "utf8"))
      && citation.chunk_claim_start_utf8_byte >= citation.chunk_start_utf8_byte
      && citation.chunk_claim_end_utf8_byte <= citation.chunk_end_utf8_byte
      && citation.chunk_claim_end_utf8_byte === citation.chunk_claim_start_utf8_byte
        + Buffer.byteLength(citation.chunk_claim_source_excerpt, "utf8")
      && citation.chunk_claim_source_excerpt_sha256
        === sha256(Buffer.from(citation.chunk_claim_source_excerpt, "utf8"))
      && citation.projection.policy === SOURCE_PROJECTION_POLICY,
    `admission.source_replay.citations[${index}] binding is invalid`);
    const [expectedField, expectedClaim] = expectedCitationClaims[index];
    assertion(citation.field === expectedField && typeof expectedClaim === "string",
      `admission.source_replay.citations[${index}] does not bind its proposal field`);
    let submitted;
    if (expectedField === "agency" || expectedField === "publication_citation_excerpt") {
      submitted = admission.submitted_proposal[expectedField];
    } else if (expectedField === "first_table") {
      submitted = admission.submitted_proposal.first_table;
    } else {
      const contributorIndex = Number(/^contributors\[([0-9]+)\]$/u.exec(expectedField)?.[1]);
      submitted = admission.submitted_proposal.contributors[contributorIndex];
    }
    const submittedClaim = expectedField === "first_table" ? submitted?.anchor_excerpt
      : expectedField.startsWith("contributors[") ? submitted?.name : submitted?.value;
    const replayedQuote = uniqueTokenProjection(citation.quote, citation.submitted_quote,
      `admission.source_replay.citations[${index}].submitted_quote`);
    const replayedClaim = uniqueTokenProjection(citation.quote, submittedClaim,
      `admission.source_replay.citations[${index}].claim`);
    assertion(replayedQuote.start_utf16 === 0 && replayedQuote.end_utf16 === citation.quote.length
      && replayedQuote.source_excerpt === citation.quote
      && replayedQuote.method === citation.projection.canonical_page_quote_match
      && replayedClaim.source_excerpt === citation.claim_source_excerpt
      && replayedClaim.source_excerpt === expectedClaim
      && citation.start_utf8_byte + byteOffset(citation.quote, replayedClaim.start_utf16)
        === citation.claim_start_utf8_byte
      && replayedClaim.method === citation.projection.canonical_page_claim_match,
    `admission.source_replay.citations[${index}] projection drifted`);
    const independentlyReplayed = validateCitation(submitted?.citation, chunksById, sourcePages,
      submittedClaim, expectedField);
    assertion(canonicalJson(citation) === canonicalJson({ field: expectedField, ...independentlyReplayed }),
      `admission.source_replay.citations[${index}] does not independently replay`);
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

function validateCitedString(item, chunksById, sourcePages, label) {
  if (item === null) return null;
  exactKeys(item, ["citation", "value"], label);
  boundedString(item.value, `${label}.value`);
  return validateCitation(item.citation, chunksById, sourcePages, item.value, label);
}

function canonicalCitedString(item, replay) {
  if (item === null || replay === null) return null;
  return {
    value: replay.claim_source_excerpt,
    citation: { chunk_id: item.citation.chunk_id, quote: replay.quote },
  };
}

function validatePublicationSemantics(value, sourcePages) {
  const normalized = normalizeSourceText(value);
  assertion(normalized.length >= MIN_PUBLICATION_CHARACTERS
    && normalized.length <= MAX_PUBLICATION_CHARACTERS,
  "publication_citation_excerpt length is invalid");
  const hasSuggestedCitation = [...sourcePages.pagesByNumber.values()]
    .some(page => page.normalized_text.includes("Suggested citation:"));
  if (hasSuggestedCitation) {
    assertion(normalized.startsWith("Suggested citation:"),
      "publication_citation_excerpt must begin with Suggested citation:");
  }
  assertion(/(?:https:\/\/doi\.org\/|\bdoi:)/iu.test(normalized),
    "publication_citation_excerpt must retain DOI support");
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

function admitProposal(submittedProposal, chunksById, allowedFields, tableRegions, sourcePages,
  firstActualTable) {
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
      const replay = validateCitedString(submitted, chunksById, sourcePages, field);
      if (field === "publication_citation_excerpt" && replay) {
        validatePublicationSemantics(replay.claim_source_excerpt, sourcePages);
      }
      proposal[field] = canonicalCitedString(submitted, replay);
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
        ...validateCitation(contributor.citation, chunksById, sourcePages, contributor.name,
          `contributors[${index}]`) };
    });
    assertion(contributorCitations.every((citation) => !/\s+and\s+|;/iu.test(citation.claim_source_excerpt)),
      "contributors must contain one human-readable display name per item");
    proposal.contributors = submittedContributors.map((contributor, index) => ({
      name: contributorCitations[index].claim_source_excerpt,
      citation: {
        chunk_id: contributor.citation.chunk_id,
        quote: contributorCitations[index].quote,
      },
    }));
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
      const replay = validateCitation(submittedTable.citation, chunksById, sourcePages,
        submittedTable.anchor_excerpt, "first_table");
      assertion(replay.page_one_based === submittedTable.page_one_based,
        "first_table page does not match its exact chunk");
      assertion(firstActualTable !== null,
        "first_table is not supported by a deterministic actual-data-table classification");
      assertion(firstActualTable.page_one_based === submittedTable.page_one_based,
        "first_table page does not match the first classified actual data table");
      const anchor = normalizeSourceText(replay.claim_source_excerpt);
      assertion(anchor.length >= MIN_TABLE_ANCHOR_CHARACTERS
        && anchor.length <= MAX_TABLE_ANCHOR_CHARACTERS,
      "first_table anchor length is invalid");
      assertion(/^Table\s+1(?:[.\s:—-]|$)/iu.test(anchor),
        "first_table anchor must begin with Table 1");
      assertion(anchor.startsWith(firstActualTable.support_anchor)
        || firstActualTable.support_anchor.startsWith(anchor),
      "first_table anchor does not bind the selected actual table heading");
      proposal.first_table = {
        page_one_based: submittedTable.page_one_based,
        anchor_excerpt: replay.claim_source_excerpt,
        citation: { chunk_id: submittedTable.citation.chunk_id, quote: replay.quote },
      };
      citations.push({ field: "first_table", ...replay });
      const selectedRegion = tableRegions.items.find(item => item.region_id === firstActualTable.region_id);
      firstTableEvidence = {
        document_table_regions_sha256: tableRegions.sha256,
        selection: structuredClone(firstActualTable),
        selection_sha256: sha256(Buffer.from(canonicalJson(firstActualTable), "utf8")),
        region: selectedRegion === undefined ? null : structuredClone(selectedRegion),
        region_sha256: selectedRegion === undefined
          ? null : sha256(Buffer.from(canonicalJson(selectedRegion), "utf8")),
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
  sourceSha256,
  documentChunks,
  documentTableRegions,
  documentSourcePages,
  batchChunkIds,
  batchPolicy,
}) {
  const bytes = Buffer.isBuffer(responseBytes) ? responseBytes : Buffer.from(responseBytes);
  boundedString(expectedModel, "expectedModel", 512);
  nonnegativeInteger(maxOutputTokens, "maxOutputTokens");
  assertion(maxOutputTokens > 0, "maxOutputTokens must be positive");
  boundedString(documentId, "documentId", 512);
  assertion(SHA256.test(documentMapSha256 ?? ""), "documentMapSha256 is invalid");
  assertion(SHA256.test(sourceSha256 ?? "") && sourceSha256 !== "0".repeat(64),
    "sourceSha256 is invalid");
  assertion(Array.isArray(documentChunks) && documentChunks.length > 0,
    "documentChunks must be a non-empty array");
  const documentChunksById = new Map();
  documentChunks.forEach((chunk, index) => {
    validateChunk(chunk, documentId, index);
    assertion(!documentChunksById.has(chunk.chunk_id), "documentChunks contain a duplicate chunk identity");
    documentChunksById.set(chunk.chunk_id, chunk);
  });
  const tableRegions = validateDocumentTableRegions(documentTableRegions);
  const sourcePages = validateNormalizedSourcePageBundle(documentSourcePages, { documentId, sourceSha256 });
  exactKeys(batchPolicy, ["allowed_fields", "batch_chunk_ids", "chunk_policies", "document_chunk_scope_sha256",
    "document_id", "document_map_sha256", "document_table_regions_sha256", "first_actual_table",
    "model_call_recommended", "source_page_text_bundle_sha256", "source_sha256"],
  "batchPolicy");
  assertion(batchPolicy.document_id === documentId, "batchPolicy belongs to another document");
  const recomputedPolicy = classifySourceBoundBatch({
    documentId,
    documentMapSha256,
    sourceSha256,
    documentChunks,
    documentTableRegions,
    documentSourcePages,
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
    admitted = admitProposal(submittedProposal, chunksById, batchPolicy.allowed_fields, tableRegions,
      sourcePages, batchPolicy.first_actual_table);
  } catch (error) {
    throw new ModelOutputAdmissionError(error.message, "model_proposal_not_source_bound", observation);
  }
  return {
    contract: { name: "pdf-tools.verified-extraction-response-admission", version: "1.6.0-experimental" },
    document_id: documentId,
    document_map_sha256: documentMapSha256,
    source_sha256: sourceSha256,
    source_page_text_bundle_sha256: sourcePages.sha256,
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
  version: "1.6.0-experimental",
  boundary: "Only strict proposals whose submitted citations and claims uniquely replay both to an exact SHA-bound document-map chunk and to the separately SHA-bound canonical PDF.js source page are admitted. Canonical page spans are retained so renderer punctuation spacing cannot masquerade as source replay. Publication excerpts retain the complete Suggested citation block and DOI when that label exists. A first_table proposal must bind a deterministic actual-data-table candidate: the first exact capitalized Table 1 or Table 1.x heading with a bounded source prefix that uniquely replays to one retained chunk on the same canonical source page, with contents/list pages excluded. Abandoned-table-region evidence is retained when present but is not treated as a complete inventory because confidently reconstructed tables do not appear there. References remain evidence-ineligible, while an explicit later Appendix heading reopens source eligibility for that appendix. Source-invalid known fields become typed null/empty rejections while independently valid fields remain admitted. Output-cap termination is typed, exact hidden-oracle-window equality remains only a secondary diagnostic, and the helper remains internal experimental code that does not itself authorize model or provider execution.",
});
