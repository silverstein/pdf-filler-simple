import { createHash } from "node:crypto";
import {
  EXTRACTION_IR_IDENTITY,
  validatePdfLayoutSemantics,
} from "./layout-extraction.js";

const RENDERER = Object.freeze({
  name: "pdf-tools.layout-markdown-renderer",
  version: "1.1.0",
});

// Bounded geometric table inference. A run of adjacent lines is treated as a
// table only when every row fills every detected column, so ragged or
// ambiguous candidates degrade to reading-order text plus a typed gap rather
// than to an invented topology.
const TABLE_MIN_ROWS = 2;
const TABLE_MIN_COLUMNS = 2;
const TABLE_COLUMN_TOLERANCE_POINTS = 3;
// A column must recur on at least this many lines to count as structure, and
// this fraction of a run's text items must sit in those columns.
const TABLE_MIN_COLUMN_ROWS = 2;
const TABLE_COLUMNAR_COVERAGE = 0.8;
// How much taller the first row must be to evidence a header row.
const HEADER_HEIGHT_RATIO = 1.15;

const MAX_MARKDOWN_BYTES_LIMIT = 200_000;
const GAP_CODES = new Set([
  "CONTROL_CHARACTERS_SANITIZED",
  "IMAGE_CONTENT_NOT_RENDERED",
  "INVALID_TEXT_GEOMETRY",
  "LINK_ANNOTATIONS_UNAVAILABLE",
  "LINK_MAPPING_AMBIGUOUS",
  "MARKDOWN_BYTE_LIMIT_REACHED",
  "OCR_NOT_PERFORMED",
  "PAGE_RANGE_INCOMPLETE",
  "RAW_PAGE_GEOMETRY_UNAVAILABLE",
  "SOURCE_CHARACTER_LIMIT_REACHED",
  "SOURCE_ITEM_LIMIT_REACHED",
  "TABLE_TOPOLOGY_UNKNOWN",
  "TEXT_LAYER_EMPTY",
  "TEXT_LAYER_FAILED",
  "UNSUPPORTED_LINK_TARGET",
  "VECTOR_CONTENT_NOT_INTERPRETED",
]);

const LIMITATIONS = Object.freeze([
  "Headings are emitted only when a short line has consistent font metrics and is at least 1.5 times the page's median line height.",
  "Lists are emitted only for literal bullet glyphs or decimal markers present in the source text.",
  "Explicit links are not emitted because source-validated PDF annotation targets are not represented by this layout IR; common URL-looking source text is escaped to resist host autolinking.",
  "Tables are reconstructed only from text-item column geometry, and only when every row fills every detected column and the first row is typographically distinct enough to evidence a header, because a Markdown table imposes header semantics. Ruling lines and merged or spanning cells are not interpreted, and table-like content that fails either test remains escaped reading-order text reported as a conversion gap.",
  "OCR is not performed. Image-only text and text that exists only inside page images are omitted and reported as conversion gaps.",
  "Unsafe control characters and malformed UTF-16 surrogates are replaced with the Unicode replacement character and reported as conversion gaps.",
]);

function assertion(condition, message) {
  if (!condition) throw new Error(`Invalid Markdown conversion semantics: ${message}`);
}

function validateSupportedLayoutIdentity(layout) {
  assertion(layout.ir?.name === EXTRACTION_IR_IDENTITY.name
    && layout.ir?.version === EXTRACTION_IR_IDENTITY.version,
  `unsupported layout IR; expected ${EXTRACTION_IR_IDENTITY.name} ${EXTRACTION_IR_IDENTITY.version}`);
  assertion(layout.parser?.name === "pdfjs-dist" && layout.parser?.version === "5.4.624",
    "unsupported parser; expected pdfjs-dist 5.4.624");
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function containsUnsafeText(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      else return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function sanitizeUnsafeText(value) {
  let sanitized = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      sanitized += "\ufffd";
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        sanitized += value[index] + value[index + 1];
        index += 1;
      } else {
        sanitized += "\ufffd";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      sanitized += "\ufffd";
    } else {
      sanitized += value[index];
    }
  }
  return sanitized;
}

function escapePlainMarkdown(value) {
  const escaped = sanitizeUnsafeText(String(value))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_\[\]|])/g, "\\$1")
    .replace(/https?:/giu, match => `${match.slice(0, -1)}&#58;`)
    .replace(/\b(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}\b/giu, domain => domain.replace(".", "&#46;"))
    .replace(/@(?=[\p{L}\p{N}.-]+&#46;[\p{L}]{2,})/giu, "&#64;");
  // A source text item may itself contain LF or CR, which sanitizeUnsafeText
  // deliberately preserves. Every physical line start must therefore be
  // guarded, not just the start of the string, or embedded block syntax stays
  // live. Leading whitespace is matched horizontally so "^" cannot consume the
  // newline that defines the next line.
  return escaped
    .replace(/^([^\S\r\n]*)([=-]+)([^\S\r\n]*)$/gmu, "$1\\$2$3")
    .replace(/^([^\S\r\n]*)(~{3,})(.*)$/gmu, "$1\\$2$3")
    .replace(/^([^\S\r\n]*)([#>+\-=])(?=[^\S\r\n]|$)/gmu, "$1\\$2")
    .replace(/^([^\S\r\n]*)(\d{1,9})([.)])(?=[^\S\r\n])/gmu, "$1$2\\$3");
}

function lineFontEvidence(page) {
  const itemById = new Map(page.raw_items.map(item => [item.id, item]));
  return page.lines.map(line => {
    const items = line.item_ids.map(id => itemById.get(id)).filter(Boolean);
    const heights = items.map(item => item.line_height).filter(Number.isFinite);
    const fontNames = new Set(items.map(item => item.font_name));
    return {
      line,
      height: heights.length > 0 ? median(heights) : null,
      consistentHeight: heights.length > 0
        && Math.max(...heights) - Math.min(...heights) <= Math.max(0.5, median(heights) * 0.1),
      consistentFont: fontNames.size === 1 && !fontNames.has(null),
    };
  });
}

function headingLevels(page) {
  const evidence = lineFontEvidence(page);
  const heights = evidence.map(value => value.height).filter(Number.isFinite);
  if (heights.length < 4) return new Map();
  const bodyHeight = median(heights);
  const bodyEvidence = heights.filter(height => Math.abs(height - bodyHeight) <= bodyHeight * 0.1);
  if (bodyEvidence.length < 3) return new Map();
  const candidates = evidence.filter(({ line, height, consistentHeight, consistentFont }) => (
    consistentHeight
      && consistentFont
      && height >= bodyHeight * 1.5
      && line.text.length > 0
      && line.text.length <= 120
      && !/[.!?;]$/u.test(line.text)
      && !/^\s*(?:[\u2022\u2023\u25e6\u2043\u2219]|\d{1,3}[.)])\s+/u.test(line.text)
  ));
  const levels = [...new Set(candidates.map(value => value.height))].sort((left, right) => right - left);
  return new Map(candidates.map(({ line, height }) => [line.id, Math.min(6, levels.indexOf(height) + 1)]));
}

function renderLine(line, headingLevel) {
  const text = line.text.trim();
  if (headingLevel) return `${"#".repeat(headingLevel)} ${escapePlainMarkdown(text)}`;
  const bullet = text.match(/^[\u2022\u2023\u25e6\u2043\u2219]\s+(.+)$/u);
  if (bullet) return `- ${escapePlainMarkdown(bullet[1])}`;
  const ordered = text.match(/^(\d{1,3})([.)])\s+(.+)$/u);
  if (ordered) return `${ordered[1]}${ordered[2]} ${escapePlainMarkdown(ordered[3])}`;
  return escapePlainMarkdown(text);
}

function itemStartX(item) {
  if (item.bbox && Number.isFinite(item.bbox.x)) return item.bbox.x;
  return Number.isFinite(item.x) ? item.x : NaN;
}

function lineCells(line, itemById) {
  return line.item_ids
    .map(id => itemById.get(id))
    .filter(item => item
      && item.is_whitespace !== true
      && typeof item.text === "string"
      && item.text.trim().length > 0
      && Number.isFinite(itemStartX(item)));
}

function columnAnchors(rows) {
  const xs = rows
    .flatMap(row => row.cells.map(itemStartX))
    .sort((left, right) => left - right);
  const clusters = [];
  for (const x of xs) {
    const last = clusters[clusters.length - 1];
    if (last && x - last.anchor <= TABLE_COLUMN_TOLERANCE_POINTS) {
      last.values.push(x);
    } else {
      clusters.push({ anchor: x, values: [x] });
    }
  }
  return clusters.map(cluster => median(cluster.values));
}

function nearestAnchor(anchors, x) {
  let best = -1;
  for (let index = 0; index < anchors.length; index += 1) {
    const distance = Math.abs(anchors[index] - x);
    if (distance > TABLE_COLUMN_TOLERANCE_POINTS) continue;
    if (best === -1 || distance < Math.abs(anchors[best] - x)) best = index;
  }
  return best;
}

/**
 * Keep only anchors that recur down the run. A column that appears in a single
 * line is word placement, not table structure; requiring recurrence is what
 * stops ordinary prose from being read as a failed table.
 */
function columnarAnalysis(run) {
  const anchors = columnAnchors(run);
  const rowsPerAnchor = anchors.map(() => new Set());
  run.forEach((row, rowIndex) => {
    for (const item of row.cells) {
      const index = nearestAnchor(anchors, itemStartX(item));
      if (index !== -1) rowsPerAnchor[index].add(rowIndex);
    }
  });
  const columnar = anchors.filter(
    (_anchor, index) => rowsPerAnchor[index].size >= TABLE_MIN_COLUMN_ROWS,
  );
  const totalCells = run.reduce((total, row) => total + row.cells.length, 0);
  const covered = run.reduce((total, row) => total + row.cells.filter(
    item => nearestAnchor(columnar, itemStartX(item)) !== -1,
  ).length, 0);
  const coverage = totalCells === 0 ? 0 : covered / totalCells;
  return {
    columnar,
    tableLike: columnar.length >= TABLE_MIN_COLUMNS
      && coverage >= TABLE_COLUMNAR_COVERAGE,
  };
}

function rowHeight(row) {
  const heights = row.cells.map(item => item.line_height).filter(Number.isFinite);
  return heights.length > 0 ? median(heights) : null;
}

/**
 * A GFM table necessarily promotes its first row to header semantics, so a
 * geometrically complete grid is not sufficient: emitting one without source
 * evidence would invent a header.
 *
 * Deliberately not evidence: a differing font_name. That field is a synthetic
 * per-document resource identity, and the same visible font subset or embedded
 * twice yields different ids, so a difference there does not imply any visible
 * distinction. Line height is the one stable visual metric this IR exposes.
 */
function hasHeaderEvidence(run) {
  const [header, ...body] = run;
  if (body.length === 0) return false;
  const headerHeight = rowHeight(header);
  const bodyHeights = body.map(rowHeight).filter(Number.isFinite);
  if (headerHeight === null || bodyHeights.length === 0) return false;
  const bodyHeight = median(bodyHeights);
  return bodyHeight > 0 && headerHeight >= bodyHeight * HEADER_HEIGHT_RATIO;
}

function assignRowToColumns(row, anchors) {
  const assigned = new Map();
  for (const item of row.cells) {
    const index = nearestAnchor(anchors, itemStartX(item));
    if (index === -1 || assigned.has(index)) return null;
    const text = item.text.trim();
    // A newline inside a cell would terminate the row and break the grid.
    // Such a run is not eligible for table emission.
    if (/[\r\n]/u.test(text)) return null;
    assigned.set(index, text);
  }
  if (assigned.size !== anchors.length) return null;
  return anchors.map((_anchor, index) => assigned.get(index));
}

/**
 * Partition a page's lines into reading-order segments. Each segment is either
 * a confidently reconstructed table or a run of ordinary lines. Table-like runs
 * that cannot be reconstructed are returned as text with tableReason set, so
 * the caller can report typed partial coverage instead of silently flattening.
 */
function segmentPageLines(page) {
  const itemById = new Map(page.raw_items.map(item => [item.id, item]));
  const rows = page.lines.map(line => ({ line, cells: lineCells(line, itemById) }));
  const segments = [];
  let tableReason = null;
  let index = 0;
  while (index < rows.length) {
    let end = index;
    while (end < rows.length && rows[end].cells.length >= TABLE_MIN_COLUMNS) end += 1;
    const run = rows.slice(index, end);
    if (run.length < TABLE_MIN_ROWS) {
      segments.push({ kind: "text", rows: rows.slice(index, Math.max(end, index + 1)) });
      index = Math.max(end, index + 1);
      continue;
    }
    const { columnar, tableLike } = columnarAnalysis(run);
    const grid = tableLike ? run.map(row => assignRowToColumns(row, columnar)) : null;
    if (grid && grid.every(Boolean) && hasHeaderEvidence(run)) {
      segments.push({ kind: "table", rows: run, grid });
    } else {
      // Only report a topology gap for runs that actually look columnar.
      // Ordinary prose that happens to share a left margin must not be
      // reported as an unreconstructed table.
      if (tableLike) {
        tableReason = grid && grid.every(Boolean) ? "header" : "topology";
      }
      segments.push({ kind: "text", rows: run });
    }
    index = end;
  }
  return { segments, tableReason };
}

// escapePlainMarkdown already escapes "|" (and backslashes before it), so a
// second pass here would emit "\\|", which is an escaped backslash followed by
// a live cell delimiter. Reuse the single existing escape.
function escapeTableCell(value) {
  return escapePlainMarkdown(value);
}

function renderTable(grid) {
  const [header, ...body] = grid;
  const lines = [
    `| ${header.map(escapeTableCell).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map(row => `| ${row.map(escapeTableCell).join(" | ")} |`),
  ];
  return lines;
}

function pageGaps(page, analysis) {
  const gaps = [];
  const add = (code, message) => gaps.push({ code, page: page.page, message });
  if (analysis?.tableReason === "topology") {
    add("TABLE_TOPOLOGY_UNKNOWN", "Table-like content was detected but its column topology could not be reconstructed, so it remains reading-order text.");
  }
  if (analysis?.tableReason === "header") {
    add("TABLE_TOPOLOGY_UNKNOWN", "A column grid was detected but no source evidence distinguishes a header row, and a Markdown table would impose one, so it remains reading-order text.");
  }
  if (page.extraction_status === "failed") {
    add("TEXT_LAYER_FAILED", "The page text-layer extraction failed.");
  }
  if (page.text_layer_status === "empty") {
    add("TEXT_LAYER_EMPTY", "No source-backed text-layer content was available on this page.");
  }
  if (page.truncation.reasons.includes("max_items")) {
    add("SOURCE_ITEM_LIMIT_REACHED", "Source text items were omitted because the extraction item limit was reached.");
  }
  if (page.truncation.reasons.includes("max_characters")) {
    add("SOURCE_CHARACTER_LIMIT_REACHED", "Source text was omitted because the extraction character limit was reached.");
  }
  if (page.reading_order.strategy === "unavailable_output_omitted") {
    add("PAGE_RANGE_INCOMPLETE", "The accepted layout projection omitted this page's reading-order evidence, so the requested range is incomplete.");
  }
  if (page.modality_hint === "image-only-candidate") {
    add("OCR_NOT_PERFORMED", "The page appears image-only, and OCR was not performed.");
    add("IMAGE_CONTENT_NOT_RENDERED", "Image content was not rendered into Markdown.");
  } else if (page.modality_hint === "mixed-content-candidate" && page.has_image_operations) {
    add("OCR_NOT_PERFORMED", "Images may contain text that is absent because OCR was not performed.");
    add("IMAGE_CONTENT_NOT_RENDERED", "Image content was not rendered into Markdown.");
  }
  if (page.has_vector_paint_operations) {
    add("VECTOR_CONTENT_NOT_INTERPRETED", "Vector-painted content was not interpreted as text or table structure.");
  }
  if (page.errors.some(error => error.code === "RAW_PAGE_GEOMETRY_UNAVAILABLE")) {
    add("RAW_PAGE_GEOMETRY_UNAVAILABLE", "Raw MediaBox, CropBox, or rotation evidence was unavailable.");
  }
  if (page.errors.some(error => error.code === "NONFINITE_TEXT_GEOMETRY")) {
    add("INVALID_TEXT_GEOMETRY", "At least one retained text item had invalid geometry and was omitted from layout reconstruction.");
  }
  if (page.lines.some(line => containsUnsafeText(line.text))) {
    add("CONTROL_CHARACTERS_SANITIZED", "Unsafe control characters or malformed UTF-16 surrogates were replaced with the Unicode replacement character.");
  }
  if (page.extraction_status === "partial" && gaps.length === 0) {
    add("PAGE_RANGE_INCOMPLETE", "The page layout evidence is partial, so the requested range is not fully represented.");
  }
  return gaps;
}

function pageStatus(page, gaps) {
  if (page.extraction_status === "failed" && page.lines.length === 0) return "failed";
  return gaps.length > 0 ? "partial" : "complete";
}

function renderPage(page) {
  const headings = headingLevels(page);
  const analysis = segmentPageLines(page);
  const lines = analysis.segments.flatMap(segment => (
    segment.kind === "table"
      ? renderTable(segment.grid)
      : segment.rows.map(({ line }) => renderLine(line, headings.get(line.id)))
  ));
  const markdown = lines.length > 0
    ? lines.join("\n")
    : "[No source-backed text was available on this page.]";
  const gaps = pageGaps(page, analysis);
  return {
    page: page.page,
    conversion_status: pageStatus(page, gaps),
    markdown,
    markdown_bytes: utf8Bytes(markdown),
    line_count: page.lines.length,
    rendered_line_count: lines.length,
    gaps,
  };
}

function renderDocumentMarkdown(renderedPages, includePageBoundaries, gaps) {
  const sections = renderedPages.map(({ page, markdown }) => (
    includePageBoundaries ? `<!-- PDF page ${page} -->\n\n${markdown}` : markdown
  ));
  const separator = includePageBoundaries ? "\n\n---\n\n" : "\n\n";
  const parts = [sections.join(separator)];
  if (gaps.length > 0) {
    parts.push([
      "## Conversion gaps",
      "",
      ...gaps.map(gap => `- Page ${gap.page}: ${escapePlainMarkdown(gap.message)}`),
    ].join("\n"));
  }
  parts.push([
    "## Conversion limitations",
    "",
    ...LIMITATIONS.map(limitation => `- ${escapePlainMarkdown(limitation)}`),
  ].join("\n"));
  return `${parts.filter(Boolean).join("\n\n")}\n`;
}

function documentStatus(pages) {
  if (pages.length > 0 && pages.every(page => page.conversion_status === "failed")) return "failed";
  return pages.every(page => page.conversion_status === "complete") ? "complete" : "partial";
}

function resultPageStatus(page) {
  if (page.rendered_line_count === 0 && page.gaps.some(gap => gap.code === "TEXT_LAYER_FAILED")) return "failed";
  return page.gaps.length > 0 ? "partial" : "complete";
}

function provenanceFromLayout(layout) {
  return {
    source: {
      file_name: layout.source.file_name,
      sha256: layout.source.sha256,
      size_bytes: layout.source.size_bytes,
    },
    layout: {
      name: layout.ir.name,
      version: layout.ir.version,
      parser_name: layout.parser.name,
      parser_version: layout.parser.version,
      page_range: {
        start_page: layout.page_range.start_page,
        end_page: layout.page_range.end_page,
        total_pages: layout.page_range.total_pages,
      },
    },
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Validate the deterministic renderer result. When layout is supplied, this
 * also binds provenance, page status, line counts, gaps, and page byte counts
 * to the accepted layout IR. This proves internal conversion semantics, not
 * source evidence. Callers must source-validate the layout IR before rendering.
 */
export function validateMarkdownConversionSemantics(result, { layout = null } = {}) {
  assertion(sameJson(result.renderer, RENDERER), "renderer identity mismatch");
  assertion(result.options?.include_page_boundaries === true || result.options?.include_page_boundaries === false,
    "include_page_boundaries must be boolean");
  assertion(Number.isSafeInteger(result.limits?.max_markdown_bytes)
    && result.limits.max_markdown_bytes >= 1
    && result.limits.max_markdown_bytes <= MAX_MARKDOWN_BYTES_LIMIT, "max_markdown_bytes is out of range");
  assertion(typeof result.markdown === "string", "markdown must be a string");
  const markdownBytes = utf8Bytes(result.markdown);
  assertion(result.markdown_bytes === markdownBytes, "markdown UTF-8 byte count mismatch");
  assertion(result.markdown_sha256 === sha256(result.markdown), "markdown SHA-256 mismatch");
  if (result.saved_output !== undefined && result.saved_output !== null) {
    assertion(result.saved_output.bytes === markdownBytes, "saved output UTF-8 byte count mismatch");
    assertion(result.saved_output.sha256 === result.markdown_sha256, "saved output SHA-256 mismatch");
  }
  assertion(markdownBytes <= result.limits.max_markdown_bytes, "markdown exceeds max_markdown_bytes");
  assertion(Array.isArray(result.pages) && result.pages.length > 0, "pages must be a non-empty array");
  for (const page of result.pages) {
    assertion(Number.isInteger(page.page) && page.page >= 1, "page number is invalid");
    assertion(["complete", "partial", "failed"].includes(page.conversion_status), `page ${page.page} status is invalid`);
    assertion(Number.isSafeInteger(page.markdown_bytes) && page.markdown_bytes >= 0, `page ${page.page} byte count is invalid`);
    assertion(Number.isSafeInteger(page.line_count) && page.line_count >= 0, `page ${page.page} line count is invalid`);
    assertion(Number.isSafeInteger(page.rendered_line_count) && page.rendered_line_count >= 0, `page ${page.page} rendered line count is invalid`);
    assertion(Array.isArray(page.gaps), `page ${page.page} gaps must be an array`);
    for (const gap of page.gaps) {
      assertion(GAP_CODES.has(gap.code), `unknown gap code ${gap.code}`);
      assertion(gap.page === page.page, `gap ${gap.code} page mismatch`);
      assertion(typeof gap.message === "string" && gap.message.length > 0, `gap ${gap.code} message is invalid`);
    }
    assertion(page.conversion_status === resultPageStatus(page), `page ${page.page} status does not match its gaps`);
  }
  const flattenedGaps = result.pages.flatMap(page => page.gaps);
  assertion(sameJson(result.gaps, flattenedGaps), "document gaps are not the exact flattened page gaps");
  assertion(result.conversion_status === documentStatus(result.pages), "document conversion status mismatch");
  assertion(sameJson(result.limitations, LIMITATIONS), "renderer limitations mismatch");

  if (layout !== null) {
    validatePdfLayoutSemantics(layout, { enforceOutputBudget: false });
    validateSupportedLayoutIdentity(layout);
    assertion(sameJson(result.provenance, provenanceFromLayout(layout)), "source or layout provenance mismatch");
    assertion(result.pages.length === layout.pages.length, "page count does not match layout IR");
    for (let index = 0; index < layout.pages.length; index += 1) {
      const expected = renderPage(layout.pages[index]);
      const actual = result.pages[index];
      assertion(actual.page === expected.page, `page ${expected.page} order mismatch`);
      assertion(actual.line_count === expected.line_count, `page ${expected.page} line count mismatch`);
      assertion(actual.rendered_line_count === expected.rendered_line_count, `page ${expected.page} rendered line count mismatch`);
      assertion(actual.markdown_bytes === expected.markdown_bytes, `page ${expected.page} byte count mismatch`);
      assertion(actual.conversion_status === expected.conversion_status, `page ${expected.page} status mismatch`);
      assertion(sameJson(actual.gaps, expected.gaps), `page ${expected.page} gaps mismatch`);
    }
    const expectedMarkdown = renderDocumentMarkdown(
      layout.pages.map(renderPage),
      result.options.include_page_boundaries,
      flattenedGaps,
    );
    assertion(result.markdown === expectedMarkdown, "markdown does not match the bound layout IR");
  }
  return result;
}

/**
 * Render an already source-validated PDF Tools layout IR to deterministic
 * Markdown. This function rechecks IR semantics but deliberately performs no
 * I/O, PDF parsing, rendering, OCR, or annotation lookup. Table reconstruction
 * is bounded to the layout IR's own text-item column geometry; it reads no
 * ruling lines and infers no merged or spanning cells.
 */
export function renderPdfLayoutToMarkdown(layout, {
  includePageBoundaries = true,
  maxMarkdownBytes = 50000,
} = {}) {
  validatePdfLayoutSemantics(layout, { enforceOutputBudget: false });
  validateSupportedLayoutIdentity(layout);
  if (typeof includePageBoundaries !== "boolean") {
    throw new TypeError("includePageBoundaries must be a boolean.");
  }
  if (!Number.isSafeInteger(maxMarkdownBytes)
    || maxMarkdownBytes < 1
    || maxMarkdownBytes > MAX_MARKDOWN_BYTES_LIMIT) {
    throw new RangeError(`maxMarkdownBytes must be an integer from 1 through ${MAX_MARKDOWN_BYTES_LIMIT}.`);
  }

  const renderedPages = layout.pages.map(renderPage);
  const gaps = renderedPages.flatMap(page => page.gaps);
  const markdown = renderDocumentMarkdown(renderedPages, includePageBoundaries, gaps);
  const markdownBytes = utf8Bytes(markdown);
  if (markdownBytes > maxMarkdownBytes) {
    throw new RangeError(
      `Markdown output is ${markdownBytes} UTF-8 bytes, which exceeds maxMarkdownBytes ${maxMarkdownBytes}. Request a narrower page range or raise the limit.`,
    );
  }

  const result = {
    renderer: { ...RENDERER },
    conversion_status: documentStatus(renderedPages),
    markdown,
    markdown_sha256: sha256(markdown),
    markdown_bytes: markdownBytes,
    options: { include_page_boundaries: includePageBoundaries },
    limits: { max_markdown_bytes: maxMarkdownBytes },
    pages: renderedPages.map(({ markdown: _markdown, ...page }) => page),
    gaps,
    limitations: [...LIMITATIONS],
    provenance: provenanceFromLayout(layout),
  };
  return validateMarkdownConversionSemantics(result, { layout });
}

export const MARKDOWN_RENDERER_IDENTITY = RENDERER;
