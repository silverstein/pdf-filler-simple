import { createHash } from "node:crypto";
import {
  EXTRACTION_IR_IDENTITY,
  validatePdfLayoutSemantics,
} from "./layout-extraction.js";
import {
  analyzeValidatedPdfPagesForDocumentMap,
  MARKDOWN_RENDERER_IDENTITY,
} from "./markdown-conversion.js";

export const DOCUMENT_MAP_IDENTITY = Object.freeze({
  name: "pdf-tools.source-bound-document-map",
  version: "1.0.0-experimental",
});

export const DEFAULT_DOCUMENT_MAP_CHUNK_POLICY = Object.freeze({
  name: "pdf-tools.document-map-chunk-policy",
  version: "1.0.0-experimental",
  max_chunk_utf8_bytes: 12000,
  max_lines_per_chunk: 80,
  max_returned_chunks: 4096,
  max_returned_headings: 2048,
  max_returned_table_regions: 512,
  max_returned_gaps: 4096,
});

const POLICY_KEYS = Object.freeze(Object.keys(DEFAULT_DOCUMENT_MAP_CHUNK_POLICY).sort());
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_SOURCE_BYTES = 250 * 1024 * 1024;
const MAX_SCHEMA_BYTES = 1024 * 1024;
const MAX_DOCUMENT_PAGES = 10000;

function assertion(condition, message) {
  if (!condition) throw new Error(`Invalid document-map contract: ${message}`);
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    assertion(Number.isFinite(value), "canonical values must contain only finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  assertion(value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype,
    "canonical values must contain only plain objects");
  return `{${Object.keys(value).sort(compareCodePoints).map(key => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Canonical(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}

function exactBytes(value, label, maximum) {
  assertion(Buffer.isBuffer(value) || value instanceof Uint8Array,
    `${label} must be exact bytes`);
  const bytes = Buffer.from(value);
  assertion(bytes.length > 0 && bytes.length <= maximum,
    `${label} must contain 1 through ${maximum} bytes`);
  return bytes;
}

function boundedInteger(value, label, minimum, maximum) {
  assertion(Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `${label} must be an integer from ${minimum} through ${maximum}`);
  return value;
}

function normalizePolicy(value) {
  assertion(value && typeof value === "object" && !Array.isArray(value),
    "chunk policy must be an object");
  assertion(JSON.stringify(Object.keys(value).sort()) === JSON.stringify(POLICY_KEYS),
    "chunk policy keys are invalid");
  assertion(value.name === DEFAULT_DOCUMENT_MAP_CHUNK_POLICY.name,
    "chunk policy name is unsupported");
  assertion(value.version === DEFAULT_DOCUMENT_MAP_CHUNK_POLICY.version,
    "chunk policy version is unsupported");
  return {
    name: value.name,
    version: value.version,
    max_chunk_utf8_bytes: boundedInteger(value.max_chunk_utf8_bytes,
      "max_chunk_utf8_bytes", 256, 100000),
    max_lines_per_chunk: boundedInteger(value.max_lines_per_chunk,
      "max_lines_per_chunk", 1, 1000),
    max_returned_chunks: boundedInteger(value.max_returned_chunks,
      "max_returned_chunks", 1, 10000),
    max_returned_headings: boundedInteger(value.max_returned_headings,
      "max_returned_headings", 0, 10000),
    max_returned_table_regions: boundedInteger(value.max_returned_table_regions,
      "max_returned_table_regions", 0, 5000),
    max_returned_gaps: boundedInteger(value.max_returned_gaps,
      "max_returned_gaps", 0, 20000),
  };
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizeLayouts(layouts, sourceBytes) {
  assertion(Array.isArray(layouts) && layouts.length > 0,
    "layouts must be a non-empty array");
  const sourceSha256 = sha256Bytes(sourceBytes);
  const first = layouts[0];
  const totalPages = first?.page_range?.total_pages;
  boundedInteger(totalPages, "total_pages", 1, MAX_DOCUMENT_PAGES);
  const parser = first?.parser;
  const ir = first?.ir;
  assertion(parser && typeof parser.name === "string" && typeof parser.version === "string",
    "parser identity is missing");
  assertion(ir && typeof ir.name === "string" && typeof ir.version === "string",
    "Extraction IR identity is missing");
  assertion(parser.name === "pdfjs-dist" && parser.version === "5.4.624",
    "parser identity is unsupported");
  assertion(sameJson(ir, EXTRACTION_IR_IDENTITY),
    "Extraction IR identity is unsupported");
  const pages = [];
  for (const layout of layouts) {
    validatePdfLayoutSemantics(layout, { enforceOutputBudget: false });
    assertion(layout.source.sha256 === sourceSha256
      && layout.source.size_bytes === sourceBytes.length,
    "layout source identity does not match the exercised PDF bytes");
    assertion(layout.page_range.total_pages === totalPages,
      "layout total-page identity drifted");
    assertion(sameJson(layout.parser, parser) && sameJson(layout.ir, ir),
      "layout parser or IR identity drifted");
    pages.push(...layout.pages);
  }
  pages.sort((left, right) => left.page - right.page);
  assertion(pages.length === totalPages, "layouts must contain every source page exactly once");
  for (let index = 0; index < pages.length; index += 1) {
    assertion(pages[index].page === index + 1,
      "layouts contain an omitted, duplicated, substituted, or out-of-order page");
  }
  return { pages, totalPages, parser: { ...parser }, ir: { ...ir } };
}

function splitUtf8(value, maximumBytes) {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return [value];
  const parts = [];
  let part = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes && part.length > 0) {
      parts.push(part);
      part = "";
      bytes = 0;
    }
    part += character;
    bytes += characterBytes;
  }
  if (part.length > 0) parts.push(part);
  return parts;
}

function chunkPage(page, analysis, bindings, policy) {
  const chunks = [];
  let pending = [];
  let pendingBytes = 0;
  const flush = () => {
    if (pending.length === 0) return;
    const content = pending.map(entry => entry.text).join("\n");
    const itemIds = [...new Set(pending.flatMap(entry => entry.item_ids))].sort(compareCodePoints);
    const binding = {
      document_map: DOCUMENT_MAP_IDENTITY,
      source: bindings.source,
      schema: bindings.schema,
      parser: bindings.parser,
      extraction_ir: bindings.extraction_ir,
      renderer: bindings.renderer,
      chunk_policy_sha256: bindings.chunk_policy.sha256,
      page: page.page,
      first_line_id: pending[0].line_id,
      last_line_id: pending[pending.length - 1].line_id,
      first_fragment: pending[0].fragment,
      last_fragment: pending[pending.length - 1].fragment,
      admitted_item_ids_sha256: sha256Canonical(itemIds),
      content_sha256: sha256Bytes(Buffer.from(content, "utf8")),
    };
    const chunkSha256 = sha256Canonical(binding);
    chunks.push({
      descriptor: {
        chunk_id: `chunk.${chunkSha256}`,
        page_range: { start_page: page.page, end_page: page.page },
        line_range: {
          first_line_id: binding.first_line_id,
          last_line_id: binding.last_line_id,
          first_fragment: binding.first_fragment,
          last_fragment: binding.last_fragment,
        },
        starts_at_heading: pending[0].heading_level !== null,
        line_fragments: pending.length,
        admitted_item_count: itemIds.length,
        admitted_item_ids_sha256: binding.admitted_item_ids_sha256,
        content_utf8_bytes: Buffer.byteLength(content, "utf8"),
        content_sha256: binding.content_sha256,
      },
      content,
      itemIds,
    });
    pending = [];
    pendingBytes = 0;
  };

  for (const line of analysis.content_lines) {
    const fragments = splitUtf8(line.text, policy.max_chunk_utf8_bytes);
    for (const [fragmentIndex, text] of fragments.entries()) {
      const fragment = `${fragmentIndex + 1}/${fragments.length}`;
      const textBytes = Buffer.byteLength(text, "utf8");
      const separatorBytes = pending.length === 0 ? 0 : 1;
      const headingBoundary = line.heading_level !== null && fragmentIndex === 0;
      if (pending.length > 0 && (headingBoundary
        || pending.length >= policy.max_lines_per_chunk
        || pendingBytes + separatorBytes + textBytes > policy.max_chunk_utf8_bytes)) flush();
      pending.push({ ...line, text, fragment });
      pendingBytes += (pending.length === 1 ? 0 : 1) + textBytes;
      if (fragments.length > 1) flush();
    }
  }
  flush();
  return chunks;
}

function compactTableRegion(region) {
  return {
    region_id: region.region_id,
    page: region.page,
    reason: region.reason,
    coordinate_space: region.coordinate_space,
    bbox: region.bbox,
    text_item_count: region.text_items.length,
    evidence_truncation: region.truncation,
  };
}

function summarizePage(page, analysis, pageChunks, returnedChunkIds) {
  const rawItemById = new Map(page.raw_items.map(item => [item.id, item]));
  const rawItemIds = new Set(rawItemById.keys());
  const furnitureLineIds = new Set(analysis.furniture.map(entry => entry.lineId));
  const lineById = new Map(page.lines.map(line => [line.id, line]));
  const furnitureItemIds = new Set([...furnitureLineIds]
    .flatMap(lineId => lineById.get(lineId)?.item_ids ?? []));
  const contentLineIds = new Set(analysis.content_lines.map(line => line.line_id));
  const contentItemIds = new Set(analysis.content_lines.flatMap(line => line.item_ids));
  const emptyLineItemIds = new Set(page.lines
    .filter(line => !contentLineIds.has(line.id) && !furnitureLineIds.has(line.id))
    .flatMap(line => line.item_ids));
  const categorizedReturned = new Set([
    ...contentItemIds,
    ...furnitureItemIds,
    ...emptyLineItemIds,
  ]);
  const unassignedItemIds = [...rawItemIds].filter(id => !categorizedReturned.has(id));
  const charactersFor = itemIds => [...itemIds]
    .reduce((sum, id) => sum + rawItemById.get(id).text.length, 0);
  assertion([...contentItemIds].every(id => rawItemIds.has(id))
    && [...furnitureItemIds].every(id => rawItemIds.has(id))
    && [...emptyLineItemIds].every(id => rawItemIds.has(id)),
  `page ${page.page} line references an item outside the returned IR`);
  assertion(contentItemIds.size + furnitureItemIds.size + emptyLineItemIds.size
    + unassignedItemIds.length === rawItemIds.size,
  `page ${page.page} returned-item categories overlap or omit an item`);
  assertion(page.counts.observed_items === rawItemIds.size + page.truncation.omitted_items,
    `page ${page.page} observed-item accounting drifted`);
  const chunkItemIds = new Set(pageChunks.flatMap(chunk => chunk.itemIds));
  assertion(chunkItemIds.size === contentItemIds.size
    && [...chunkItemIds].every(id => contentItemIds.has(id)),
  `page ${page.page} chunk item coverage drifted`);
  const contentCharacters = charactersFor(contentItemIds);
  const furnitureCharacters = charactersFor(furnitureItemIds);
  const emptyLineCharacters = charactersFor(emptyLineItemIds);
  const unassignedCharacters = charactersFor(unassignedItemIds);
  assertion(page.counts.observed_characters === contentCharacters
    + furnitureCharacters
    + emptyLineCharacters
    + unassignedCharacters
    + page.truncation.omitted_characters,
  `page ${page.page} observed-character accounting drifted`);
  const returnedChunks = pageChunks.filter(chunk => returnedChunkIds.includes(chunk.descriptor.chunk_id));
  const omittedChunks = pageChunks.filter(chunk => !returnedChunkIds.includes(chunk.descriptor.chunk_id));
  return {
    page: page.page,
    extraction_status: page.extraction_status,
    text_layer_status: page.text_layer_status,
    modality_hint: page.modality_hint,
    needs_visual_inspection: page.needs_visual_inspection,
    counts: {
      observed_items: page.counts.observed_items,
      returned_items: rawItemIds.size,
      chunk_admitted_items: contentItemIds.size,
      layout_omitted_items: page.truncation.omitted_items,
      furniture_omitted_items: furnitureItemIds.size,
      empty_line_omitted_items: emptyLineItemIds.size,
      unassigned_omitted_items: unassignedItemIds.length,
      observed_characters: page.counts.observed_characters,
      returned_characters: page.counts.returned_characters,
      chunk_admitted_characters: contentCharacters,
      layout_omitted_characters: page.truncation.omitted_characters,
      furniture_omitted_characters: furnitureCharacters,
      empty_line_omitted_characters: emptyLineCharacters,
      unassigned_omitted_characters: unassignedCharacters,
    },
    omission_reasons: [
      ...(page.truncation.omitted_items > 0 ? [{
        reason: "layout_retention_limit",
        count: page.truncation.omitted_items,
        detail: [...page.truncation.reasons],
      }] : []),
      ...(furnitureItemIds.size > 0 ? [{ reason: "page_furniture", count: furnitureItemIds.size }] : []),
      ...(emptyLineItemIds.size > 0 ? [{ reason: "empty_line", count: emptyLineItemIds.size }] : []),
      ...(unassignedItemIds.length > 0 ? [{ reason: "unassigned_ir_item", count: unassignedItemIds.length }] : []),
    ],
    chunk_counts: {
      observed: pageChunks.length,
      returned: returnedChunkIds.length,
      omitted: pageChunks.length - returnedChunkIds.length,
      returned_content_utf8_bytes: returnedChunks
        .reduce((sum, chunk) => sum + chunk.descriptor.content_utf8_bytes, 0),
      omitted_content_utf8_bytes: omittedChunks
        .reduce((sum, chunk) => sum + chunk.descriptor.content_utf8_bytes, 0),
      returned_admitted_item_references: returnedChunks
        .reduce((sum, chunk) => sum + chunk.descriptor.admitted_item_count, 0),
      omitted_admitted_item_references: omittedChunks
        .reduce((sum, chunk) => sum + chunk.descriptor.admitted_item_count, 0),
    },
    returned_chunk_ids: returnedChunkIds,
    heading_count: analysis.headings.length,
    table_region_count: analysis.table_regions.length,
    gap_codes: [...new Set(analysis.gaps.map(gap => gap.code))].sort(compareCodePoints),
  };
}

function buildInternal({ sourceBytes: sourceValue, schemaBytes: schemaValue, layouts, chunkPolicy }) {
  const sourceBytes = exactBytes(sourceValue, "sourceBytes", MAX_SOURCE_BYTES);
  const schemaBytes = exactBytes(schemaValue, "schemaBytes", MAX_SCHEMA_BYTES);
  const policy = normalizePolicy(chunkPolicy);
  const normalized = normalizeLayouts(layouts, sourceBytes);
  const bindings = {
    source: { sha256: sha256Bytes(sourceBytes), size_bytes: sourceBytes.length },
    schema: { sha256: sha256Bytes(schemaBytes), size_bytes: schemaBytes.length },
    parser: normalized.parser,
    extraction_ir: normalized.ir,
    renderer: { ...MARKDOWN_RENDERER_IDENTITY },
    chunk_policy: { ...policy, sha256: sha256Canonical(policy) },
  };
  const analyses = analyzeValidatedPdfPagesForDocumentMap(normalized.pages);
  const allChunks = normalized.pages.flatMap((page, index) => (
    chunkPage(page, analyses[index], bindings, policy)
  ));
  const returnedChunks = allChunks.slice(0, policy.max_returned_chunks);
  const returnedChunkIds = new Set(returnedChunks.map(chunk => chunk.descriptor.chunk_id));
  const headings = analyses.flatMap(analysis => analysis.headings.map(heading => ({
    page: analysis.page,
    ...heading,
  })));
  const tableRegions = analyses.flatMap(analysis => analysis.table_regions.map(compactTableRegion));
  const gaps = analyses.flatMap(analysis => analysis.gaps.map(gap => ({
    page: analysis.page,
    code: gap.code,
  })));
  const pages = normalized.pages.map((page, index) => {
    const pageChunks = allChunks.filter(chunk => chunk.descriptor.page_range.start_page === page.page);
    return summarizePage(page, analyses[index], pageChunks,
      pageChunks.filter(chunk => returnedChunkIds.has(chunk.descriptor.chunk_id))
        .map(chunk => chunk.descriptor.chunk_id));
  });
  const total = name => pages.reduce((sum, page) => sum + page.counts[name], 0);
  const mapWithoutDigest = {
    contract: { ...DOCUMENT_MAP_IDENTITY },
    bindings,
    page_count: normalized.totalPages,
    pages,
    headings: {
      observed: headings.length,
      returned: Math.min(headings.length, policy.max_returned_headings),
      omitted: Math.max(0, headings.length - policy.max_returned_headings),
      items: headings.slice(0, policy.max_returned_headings),
      all_items_sha256: sha256Canonical(headings),
    },
    table_regions: {
      observed: tableRegions.length,
      returned: Math.min(tableRegions.length, policy.max_returned_table_regions),
      omitted: Math.max(0, tableRegions.length - policy.max_returned_table_regions),
      items: tableRegions.slice(0, policy.max_returned_table_regions),
      all_items_sha256: sha256Canonical(tableRegions),
    },
    gaps: {
      observed: gaps.length,
      returned: Math.min(gaps.length, policy.max_returned_gaps),
      omitted: Math.max(0, gaps.length - policy.max_returned_gaps),
      items: gaps.slice(0, policy.max_returned_gaps),
      all_items_sha256: sha256Canonical(gaps),
    },
    chunks: {
      observed: allChunks.length,
      returned: returnedChunks.length,
      omitted: allChunks.length - returnedChunks.length,
      returned_content_utf8_bytes: returnedChunks
        .reduce((sum, chunk) => sum + chunk.descriptor.content_utf8_bytes, 0),
      omitted_content_utf8_bytes: allChunks.slice(returnedChunks.length)
        .reduce((sum, chunk) => sum + chunk.descriptor.content_utf8_bytes, 0),
      returned_admitted_item_references: returnedChunks
        .reduce((sum, chunk) => sum + chunk.descriptor.admitted_item_count, 0),
      omitted_admitted_item_references: allChunks.slice(returnedChunks.length)
        .reduce((sum, chunk) => sum + chunk.descriptor.admitted_item_count, 0),
      descriptors: returnedChunks.map(chunk => chunk.descriptor),
      all_descriptors_sha256: sha256Canonical(allChunks.map(chunk => chunk.descriptor)),
    },
    coverage: {
      observed_pages: normalized.totalPages,
      accounted_pages: pages.length,
      observed_items: total("observed_items"),
      returned_items: total("returned_items"),
      chunk_admitted_items: total("chunk_admitted_items"),
      layout_omitted_items: total("layout_omitted_items"),
      furniture_omitted_items: total("furniture_omitted_items"),
      empty_line_omitted_items: total("empty_line_omitted_items"),
      unassigned_omitted_items: total("unassigned_omitted_items"),
      observed_characters: total("observed_characters"),
      returned_characters: total("returned_characters"),
      chunk_admitted_characters: total("chunk_admitted_characters"),
      layout_omitted_characters: total("layout_omitted_characters"),
      furniture_omitted_characters: total("furniture_omitted_characters"),
      empty_line_omitted_characters: total("empty_line_omitted_characters"),
      unassigned_omitted_characters: total("unassigned_omitted_characters"),
      accounted: true,
    },
    limitations: [
      "This is a deterministic source and schema binding over PDF Tools Extraction IR; it performs no OCR, inference, schema filling, or model call.",
      "Chunk content contains source text lines after the active evidence-safe page-furniture exclusions; typed gaps and every omitted item count remain explicit.",
      "Renderer headings and table regions are deterministic candidates, not claims that arbitrary document semantics or table topology were recovered.",
    ],
  };
  assertion(mapWithoutDigest.coverage.observed_items
    === mapWithoutDigest.coverage.chunk_admitted_items
      + mapWithoutDigest.coverage.layout_omitted_items
      + mapWithoutDigest.coverage.furniture_omitted_items
      + mapWithoutDigest.coverage.empty_line_omitted_items
      + mapWithoutDigest.coverage.unassigned_omitted_items,
  "document item denominator is not fully accounted");
  assertion(mapWithoutDigest.coverage.observed_characters
    === mapWithoutDigest.coverage.chunk_admitted_characters
      + mapWithoutDigest.coverage.layout_omitted_characters
      + mapWithoutDigest.coverage.furniture_omitted_characters
      + mapWithoutDigest.coverage.empty_line_omitted_characters
      + mapWithoutDigest.coverage.unassigned_omitted_characters,
  "document character denominator is not fully accounted");
  const documentMap = {
    ...mapWithoutDigest,
    document_map_sha256: sha256Canonical(mapWithoutDigest),
  };
  return { documentMap, allChunks };
}

export function buildSourceBoundDocumentMap({
  sourceBytes,
  schemaBytes,
  layouts,
  chunkPolicy = DEFAULT_DOCUMENT_MAP_CHUNK_POLICY,
}) {
  return buildInternal({ sourceBytes, schemaBytes, layouts, chunkPolicy }).documentMap;
}

export function validateSourceBoundDocumentMap(documentMap, {
  sourceBytes,
  schemaBytes,
  layouts,
  chunkPolicy = DEFAULT_DOCUMENT_MAP_CHUNK_POLICY,
}) {
  assertion(documentMap && typeof documentMap === "object" && !Array.isArray(documentMap),
    "document map must be an object");
  assertion(SHA256.test(documentMap.document_map_sha256 ?? ""),
    "document-map digest is invalid");
  const expected = buildInternal({ sourceBytes, schemaBytes, layouts, chunkPolicy }).documentMap;
  assertion(sameJson(documentMap, expected),
    "document map is stale, drifted, or bound to different inputs");
  return documentMap;
}

export function readSourceBoundDocumentChunk({
  documentMap,
  chunkId,
  sourceBytes,
  schemaBytes,
  layouts,
  chunkPolicy = DEFAULT_DOCUMENT_MAP_CHUNK_POLICY,
}) {
  assertion(typeof chunkId === "string" && /^chunk\.[a-f0-9]{64}$/u.test(chunkId),
    "chunkId is invalid");
  const { documentMap: expected, allChunks } = buildInternal({
    sourceBytes,
    schemaBytes,
    layouts,
    chunkPolicy,
  });
  assertion(sameJson(documentMap, expected),
    "document map is stale, drifted, or bound to different inputs");
  const returned = new Set(documentMap.chunks.descriptors.map(chunk => chunk.chunk_id));
  assertion(returned.has(chunkId), "chunk is unknown or omitted by the frozen output bound");
  const chunk = allChunks.find(candidate => candidate.descriptor.chunk_id === chunkId);
  assertion(chunk, "chunk content cannot be reconstructed");
  return {
    document_map_sha256: documentMap.document_map_sha256,
    chunk_id: chunkId,
    page_range: chunk.descriptor.page_range,
    content: chunk.content,
    content_utf8_bytes: chunk.descriptor.content_utf8_bytes,
    content_sha256: chunk.descriptor.content_sha256,
    admitted_item_count: chunk.descriptor.admitted_item_count,
    omitted_item_count: 0,
  };
}
