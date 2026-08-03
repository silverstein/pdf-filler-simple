import { createHash } from "node:crypto";
import {
  EXTRACTION_IR_IDENTITY,
  validatePdfLayoutSemantics,
} from "./layout-extraction.js";

const RENDERER = Object.freeze({
  name: "pdf-tools.layout-markdown-renderer",
  version: "1.3.0",
});
const SUPPORTED_LAYOUT_IR_VERSION = "1.2.0";

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

// Ported from firecrawl/pdf-inspector (MIT): src/tables/detect_rects.rs.
// These are deliberately named, bounded geometry gates rather than a
// confidence score: the renderer either has enough ruling evidence to prove a
// grid or it reports why it declined one.
const RECT_CLUSTER_ADJACENCY_TOLERANCE = 3;
const RECT_SNAP_TOLERANCE = 6;
const RECT_CELL_ASSIGNMENT_SLACK = 2;
const RECT_MIN_CLUSTER_RECTS = 6;
const MAX_CLUSTER_RECTS = 2000;
const RECT_MIN_FILL_RATIO = 0.3;
const RECT_MAX_COLUMNS = 25;
const RECT_CONTAINMENT_TOLERANCE = 2;
// Two cell rectangles sharing a drawn border may overlap by a stroke width;
// anything beyond this in BOTH axes is competing evidence, not a border.
const RECT_MATERIAL_OVERLAP = 1;

const MAX_MARKDOWN_BYTES_LIMIT = 200_000;
const GAP_CODES = new Set([
  "CONTROL_CHARACTERS_SANITIZED",
  "IMAGE_CONTENT_NOT_RENDERED",
  "INVALID_TEXT_GEOMETRY",
  "LINK_ANNOTATIONS_UNAVAILABLE",
  "LINK_MAPPING_AMBIGUOUS",
  "OCR_NOT_PERFORMED",
  "PAGE_RANGE_INCOMPLETE",
  "RAW_PAGE_GEOMETRY_UNAVAILABLE",
  "SOURCE_CHARACTER_LIMIT_REACHED",
  "SOURCE_ITEM_LIMIT_REACHED",
  "TABLE_RULING_UNSUPPORTED",
  "TABLE_TOPOLOGY_UNKNOWN",
  "TEXT_INTEGRITY_SUSPECT",
  "TEXT_LAYER_EMPTY",
  "TEXT_LAYER_FAILED",
  "UNSUPPORTED_LINK_TARGET",
  "VECTOR_CONTENT_NOT_INTERPRETED",
]);

const LIMITATIONS = Object.freeze([
  "Headings are emitted only when a short line has consistent font metrics and is at least 1.5 times the page's median line height.",
  "Lists are emitted only for literal bullet glyphs or decimal markers present in the source text.",
  "Links are emitted only for source-validated http or https annotation targets that map to exactly one contiguous run of text on one line. Internal destinations, actions, other schemes, ambiguous or partially covered labels, and links inside reconstructed tables remain escaped text reported as a conversion gap, and URL-looking source text is escaped to resist host autolinking.",
  "Tables are reconstructed only from text-item column geometry or clean ruled-rectangle grid evidence, and only when every row fills every detected column and the first row is typographically distinct enough to evidence a header (or has non-recurring first-row ruling evidence), because a Markdown table imposes header semantics. Merged or spanning cells are not interpreted, and table-like content that fails either test remains escaped reading-order text reported as a conversion gap.",
  "Vector paint operations beyond any reconstructed table rulings are not interpreted.",
  "OCR is not performed. Image-only text and text that exists only inside page images are omitted and reported as conversion gaps.",
  "Unsafe control characters and malformed UTF-16 surrogates are replaced with the Unicode replacement character and reported as conversion gaps.",
]);

function assertion(condition, message) {
  if (!condition) throw new Error(`Invalid Markdown conversion semantics: ${message}`);
}

function validateSupportedLayoutIdentity(layout) {
  assertion(layout.ir?.name === EXTRACTION_IR_IDENTITY.name
    && layout.ir?.version === SUPPORTED_LAYOUT_IR_VERSION
    && SUPPORTED_LAYOUT_IR_VERSION === EXTRACTION_IR_IDENTITY.version,
  `unsupported layout IR; expected ${EXTRACTION_IR_IDENTITY.name} ${SUPPORTED_LAYOUT_IR_VERSION}`);
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

/**
 * Whether renderLine rewrites this line's structure (bullet or ordered marker).
 * Such lines cannot carry a spliced inline link.
 */
function rewritesLineStructure(line) {
  const text = line.text.trim();
  return /^[\u2022\u2023\u25e6\u2043\u2219]\s+(.+)$/u.test(text)
    || /^(\d{1,3})([.)])\s+(.+)$/u.test(text);
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

// A link rect must contain essentially all of a text item's box for that item
// to count as labelled by the link. Anything partially covered is ambiguous.
const LINK_ITEM_CONTAINMENT = 0.95;

function itemBox(item) {
  if (item.bbox
    && Number.isFinite(item.bbox.x) && Number.isFinite(item.bbox.y)
    && Number.isFinite(item.bbox.width) && Number.isFinite(item.bbox.height)) {
    return item.bbox;
  }
  return null;
}

function coveredFraction(box, rect) {
  const overlapWidth = Math.min(box.x + box.width, rect.x + rect.width) - Math.max(box.x, rect.x);
  const overlapHeight = Math.min(box.y + box.height, rect.y + rect.height) - Math.max(box.y, rect.y);
  if (overlapWidth <= 0 || overlapHeight <= 0) return 0;
  const area = box.width * box.height;
  if (!(area > 0)) return 0;
  return (overlapWidth * overlapHeight) / area;
}

/**
 * Percent-encode the characters that would otherwise terminate or reshape a
 * Markdown inline-link destination. The IR already guarantees an absolute
 * http/https href with no whitespace or control characters.
 */
function encodeLinkDestination(href) {
  return href.replace(/[()<>\\]/gu, character => (
    `%${character.codePointAt(0).toString(16).toUpperCase().padStart(2, "0")}`
  ));
}

/**
 * Prove where each retained item sits inside the line's exact text. Offsets are
 * recovered by scanning line.text forward, so a label can later be spliced from
 * the original string rather than rebuilt from item fragments. Returns null if
 * any item cannot be located, which fails the line closed.
 */
function itemOffsets(line, items) {
  const offsets = [];
  let cursor = 0;
  for (const item of items) {
    if (typeof item.text !== "string" || item.text.length === 0) return null;
    const index = line.text.indexOf(item.text, cursor);
    if (index === -1) return null;
    offsets.push({ start: index, end: index + item.text.length });
    cursor = index + item.text.length;
  }
  return offsets;
}

/**
 * Build one page-global plan for every link annotation.
 *
 * Fail-closed. A link is rendered only when it covers items on exactly one
 * eligible line, those items form one contiguous run, no item is partially
 * covered, no other annotation of any kind touches them, and the label offsets
 * are provable against the line's exact text. Every other outcome degrades to
 * escaped text plus a typed gap, so a rect spanning two lines can never emit
 * two links.
 *
 * Every annotation contributes a footprint, including unsupported and
 * ambiguous ones, so an unsupported target overlapping a supported label
 * suppresses that label instead of being silently ignored.
 */
function planPageLinks(rows, links, excludedLineIds) {
  const spansByLine = new Map();
  const offsetsByLine = new Map();
  let ambiguous = false;
  let unsupportedTarget = false;

  for (const row of rows) {
    const offsets = itemOffsets(row.line, row.cells);
    if (offsets !== null) offsetsByLine.set(row.line.id, offsets);
  }

  const footprints = [];
  const candidates = [];
  for (const link of links) {
    const supported = link.target_kind === "http";
    if (!supported) unsupportedTarget = true;
    if (link.rect === null) {
      if (supported) ambiguous = true;
      continue;
    }
    const touched = new Map();
    let partial = false;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      for (let itemIndex = 0; itemIndex < row.cells.length; itemIndex += 1) {
        const box = itemBox(row.cells[itemIndex]);
        if (box === null) continue;
        const fraction = coveredFraction(box, link.rect);
        if (fraction <= 0) continue;
        if (!touched.has(rowIndex)) touched.set(rowIndex, { contained: [], any: [] });
        touched.get(rowIndex).any.push(itemIndex);
        if (fraction >= LINK_ITEM_CONTAINMENT) touched.get(rowIndex).contained.push(itemIndex);
        else partial = true;
      }
    }
    // Footprints cover every item this annotation overlaps at all.
    for (const [rowIndex, entry] of touched) {
      footprints.push({
        link,
        lineId: rows[rowIndex].line.id,
        start: Math.min(...entry.any),
        end: Math.max(...entry.any),
      });
    }
    if (!supported) continue;
    if (touched.size !== 1 || partial) {
      ambiguous = true;
      continue;
    }
    const [rowIndex, entry] = [...touched.entries()][0];
    const row = rows[rowIndex];
    const indexes = entry.contained;
    const contiguous = indexes.length > 0
      && indexes[indexes.length - 1] - indexes[0] + 1 === indexes.length;
    // A heading or list line is rewritten structurally by renderLine, so a
    // link landing there cannot be spliced and must be reported, not dropped.
    if (!contiguous
      || excludedLineIds.has(row.line.id)
      || !offsetsByLine.has(row.line.id)) {
      ambiguous = true;
      continue;
    }
    // renderLine emits line.text.trim(), so a line carrying leading or
    // trailing content cannot be spliced without changing structure depending
    // on whether a link happened to resolve. A label containing LF or CR would
    // also break the inline-link grammar. Both fail closed.
    const offsets = offsetsByLine.get(row.line.id);
    const label = row.line.text.slice(
      offsets[indexes[0]].start,
      offsets[indexes[indexes.length - 1]].end,
    );
    if (row.line.text !== row.line.text.trim() || /[\r\n]/u.test(label)) {
      ambiguous = true;
      continue;
    }
    candidates.push({
      link,
      lineId: row.line.id,
      start: indexes[0],
      end: indexes[indexes.length - 1],
      url: link.url,
    });
  }

  // Drop any candidate whose items are also touched by a different annotation.
  const kept = candidates.filter(candidate => !footprints.some(other => (
    other.link !== candidate.link
    && other.lineId === candidate.lineId
    && other.start <= candidate.end
    && candidate.start <= other.end
  )));
  if (kept.length !== candidates.length) ambiguous = true;

  for (const span of kept) {
    if (!spansByLine.has(span.lineId)) spansByLine.set(span.lineId, []);
    spansByLine.get(span.lineId).push(span);
  }
  for (const spans of spansByLine.values()) {
    spans.sort((left, right) => left.start - right.start);
  }
  return { spansByLine, offsetsByLine, ambiguous, unsupportedTarget };
}

/**
 * Splice links into the line's exact source text. Text outside a link is taken
 * verbatim from line.text, so spacing, punctuation, and scripts without word
 * separators are preserved.
 */
function renderLinkedLine(line, offsets, spans) {
  let cursor = 0;
  let rendered = "";
  for (const span of spans) {
    const from = offsets[span.start].start;
    const to = offsets[span.end].end;
    if (from < cursor) return null;
    rendered += escapePlainMarkdown(line.text.slice(cursor, from));
    rendered += `[${escapePlainMarkdown(line.text.slice(from, to))}](${encodeLinkDestination(span.url)})`;
    cursor = to;
  }
  return rendered + escapePlainMarkdown(line.text.slice(cursor));
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

function rectRight(rect) {
  return rect.x + rect.width;
}

function rectBottom(rect) {
  return rect.y + rect.height;
}

function rectsExactlyEqual(left, right) {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height
    && left.verb === right.verb;
}

function containsRect(outer, inner, tolerance = RECT_CONTAINMENT_TOLERANCE) {
  return outer.x <= inner.x + tolerance
    && outer.y <= inner.y + tolerance
    && rectRight(outer) >= rectRight(inner) - tolerance
    && rectBottom(outer) >= rectBottom(inner) - tolerance;
}

function preprocessRuledRects(page) {
  const evidence = page.ruled_rects;
  // A truncated page cannot distinguish a complete grid from one whose
  // omitted rects would change its topology. It is intentionally a hard
  // disable, not a partial table candidate.
  if (!evidence || evidence.status !== "available") return null;
  const sourceRects = evidence.items
    .map((rect, order) => ({ ...rect, order }))
    .filter(rect => rect.width > 0 && rect.height > 0);
  if (sourceRects.length === 0) return [];

  const medianWidth = median(sourceRects.map(rect => rect.width));
  const widthFiltered = sourceRects.filter(rect => rect.width <= medianWidth * 10);
  const unique = widthFiltered.filter((rect, index, all) => (
    all.findIndex(candidate => rectsExactlyEqual(candidate, rect)) === index
  ));
  const containedFiltered = unique.filter((inner, innerIndex, all) => {
    const innerArea = inner.width * inner.height;
    return !all.some((outer, outerIndex) => {
      if (outerIndex === innerIndex) return false;
      if (outer.x < 5 && outer.y < 5) return false;
      // Preserve cell rectangles underneath a one-row band until the grid
      // has been built. A body-row band is ambiguous and must be classified
      // as topology, not allowed to erase the evidence needed to classify it.
      if (Math.abs(outer.height - inner.height) <= RECT_CONTAINMENT_TOLERANCE
        && outer.width > inner.width + RECT_CONTAINMENT_TOLERANCE) return false;
      const outerArea = outer.width * outer.height;
      return outerArea > innerArea * 1.2
        && outer.height < inner.height * 4
        && containsRect(outer, inner);
    });
  });
  const medianHeight = median(containedFiltered.length > 0
    ? containedFiltered.map(rect => rect.height)
    : sourceRects.map(rect => rect.height));
  const filtered = containedFiltered
    .filter(rect => !(rect.x < 5 && rect.y < 5 && rect.height > medianHeight * 20))
    .sort((left, right) => left.order - right.order);
  return filtered.length > MAX_CLUSTER_RECTS ? null : filtered;
}

function intervalGap(firstStart, firstEnd, secondStart, secondEnd) {
  if (firstEnd < secondStart) return secondStart - firstEnd;
  if (secondEnd < firstStart) return firstStart - secondEnd;
  return 0;
}

function rectsAdjacent(left, right) {
  return intervalGap(left.x, rectRight(left), right.x, rectRight(right))
      <= RECT_CLUSTER_ADJACENCY_TOLERANCE
    && intervalGap(left.y, rectBottom(left), right.y, rectBottom(right))
      <= RECT_CLUSTER_ADJACENCY_TOLERANCE;
}

function clusterRuledRects(rects) {
  const parents = rects.map((_rect, index) => index);
  const find = index => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  for (let left = 0; left < rects.length; left += 1) {
    for (let right = left + 1; right < rects.length; right += 1) {
      if (rectsAdjacent(rects[left], rects[right])) union(left, right);
    }
  }
  const membersByRoot = new Map();
  rects.forEach((_rect, index) => {
    const root = find(index);
    if (!membersByRoot.has(root)) membersByRoot.set(root, []);
    membersByRoot.get(root).push(index);
  });
  return [...membersByRoot.values()]
    .map(members => members.sort((left, right) => rects[left].order - rects[right].order))
    .sort((left, right) => rects[left[0]].order - rects[right[0]].order)
    .filter(members => members.length >= RECT_MIN_CLUSTER_RECTS)
    .map(members => members.map(index => rects[index]));
}

function snapEdges(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const groups = [];
  for (const value of sorted) {
    const last = groups[groups.length - 1];
    if (last && value - last.values[last.values.length - 1] <= RECT_SNAP_TOLERANCE) {
      last.values.push(value);
    } else {
      groups.push({ values: [value] });
    }
  }
  return groups.map(group => median(group.values));
}

function coversInterval(rect, start, end, tolerance = RECT_SNAP_TOLERANCE) {
  return rect.x <= start + tolerance
    && rectRight(rect) >= end - tolerance;
}

function gridRectCoverage(rect, xEdges, yEdges, tolerance = RECT_SNAP_TOLERANCE) {
  const columns = [];
  const rows = [];
  for (let column = 0; column < xEdges.length - 1; column += 1) {
    if (coversInterval(rect, xEdges[column], xEdges[column + 1], tolerance)) columns.push(column);
  }
  for (let row = 0; row < yEdges.length - 1; row += 1) {
    if (rect.y <= yEdges[row] + tolerance
      && rectBottom(rect) >= yEdges[row + 1] - tolerance) rows.push(row);
  }
  return { columns, rows };
}

function rectEdgesMatchCell(rect, column, row, xEdges, yEdges) {
  return Math.abs(rect.x - xEdges[column]) <= RECT_SNAP_TOLERANCE
    && Math.abs(rectRight(rect) - xEdges[column + 1]) <= RECT_SNAP_TOLERANCE
    && Math.abs(rect.y - yEdges[row]) <= RECT_SNAP_TOLERANCE
    && Math.abs(rectBottom(rect) - yEdges[row + 1]) <= RECT_SNAP_TOLERANCE;
}

function boxesOverlap(left, right) {
  return Math.min(left.x + left.width, right.x + right.width) > Math.max(left.x, right.x)
    && Math.min(left.y + left.height, right.y + right.height) > Math.max(left.y, right.y);
}

function clusterBounds(cluster) {
  return {
    x: Math.min(...cluster.map(rect => rect.x)),
    y: Math.min(...cluster.map(rect => rect.y)),
    right: Math.max(...cluster.map(rect => rectRight(rect))),
    bottom: Math.max(...cluster.map(rect => rectBottom(rect))),
  };
}

function pointInsideCluster(item, bounds) {
  const box = itemBox(item);
  if (!box) return false;
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  return centerX >= bounds.x && centerX <= bounds.right
    && centerY >= bounds.y && centerY <= bounds.bottom;
}

function hasFirstRowBandEvidence(bands) {
  const firstRow = bands.find(band => band.rows.length === 1 && band.rows[0] === 0);
  if (!firstRow) return false;
  return !bands.some(band => band !== firstRow
    && band.rows.length === 1
    && band.rows[0] > 0
    && Math.abs(band.rect.y - firstRow.rect.y) <= RECT_SNAP_TOLERANCE
    && Math.abs(rectBottom(band.rect) - rectBottom(firstRow.rect)) <= RECT_SNAP_TOLERANCE);
}

function tryBuildRectGrid(page, run, clusters, itemById) {
  const runLineIds = new Set(run.map(row => row.line.id));
  const candidates = [];
  for (const cluster of clusters) {
    if (cluster.length < RECT_MIN_CLUSTER_RECTS) continue;
    const bounds = clusterBounds(cluster);
    const lineRecords = page.lines.map(line => {
      const allItems = line.item_ids.map(id => itemById.get(id)).filter(Boolean);
      const insideItems = allItems.filter(item => pointInsideCluster(item, bounds));
      const nonWhitespace = allItems.filter(item => item.is_whitespace !== true
        && typeof item.text === "string" && item.text.trim().length > 0);
      const insideNonWhitespace = insideItems.filter(item => item.is_whitespace !== true
        && typeof item.text === "string" && item.text.trim().length > 0);
      if (insideNonWhitespace.length === 0) return null;
      return {
        line,
        allItems,
        items: insideItems,
        nonWhitespace,
        insideNonWhitespace,
      };
    }).filter(Boolean);
    if (lineRecords.length < TABLE_MIN_ROWS || !lineRecords.some(record => runLineIds.has(record.line.id))) continue;
    candidates.push({ cluster, bounds, lineRecords });
  }

  for (const { cluster, bounds, lineRecords } of candidates) {
    const xEdges = snapEdges(cluster.flatMap(rect => [rect.x, rectRight(rect)]));
    const yEdges = snapEdges(cluster.flatMap(rect => [rect.y, rectBottom(rect)]));
    const gridShape = xEdges.length >= 3 && yEdges.length >= 4;
    const canReportUnsupported = gridShape && lineRecords.length >= TABLE_MIN_ROWS;
    if (!gridShape) continue;
    const columnCount = xEdges.length - 1;
    const rowCount = yEdges.length - 1;
    if (columnCount < TABLE_MIN_COLUMNS || columnCount > RECT_MAX_COLUMNS || rowCount < TABLE_MIN_ROWS) {
      if (canReportUnsupported) return { reason: "ruling_unsupported" };
      continue;
    }

    const bands = [];
    const occupiedCells = new Set();
    const cellRects = [];
    let filledCells = 0;
    const totalCells = columnCount * rowCount;
    for (const rect of cluster) {
      const coverage = gridRectCoverage(rect, xEdges, yEdges);
      if (coverage.columns.length === columnCount && coverage.rows.length === 1) {
        // A full-width band is only safe as first-row header evidence. On a
        // body row it could be decoration or a merged cell, so abandon the
        // entire candidate with a topology gap.
        if (coverage.rows[0] > 0) return { reason: "topology" };
        if (bands.some(band => band.rows[0] === coverage.rows[0])) {
          return { reason: "topology" };
        }
        bands.push({ rect, ...coverage });
        continue;
      }
      // Every non-band rectangle must describe exactly one cell. This catches
      // merged spans and competing/shifted grids before text can be emitted.
      if (coverage.columns.length !== 1 || coverage.rows.length !== 1
        || !rectEdgesMatchCell(rect, coverage.columns[0], coverage.rows[0], xEdges, yEdges)) {
        return { reason: "topology" };
      }
      const cellKey = `${coverage.rows[0]}:${coverage.columns[0]}`;
      if (occupiedCells.has(cellKey)) return { reason: "topology" };
      occupiedCells.add(cellKey);
      cellRects.push(rect);
    }
    // Distinct cell rectangles may share borders, but a material geometric
    // overlap in both axes means two grids compete for the same region even
    // when both rects snap cleanly to (different) cells. Fail closed.
    for (let first = 0; first < cellRects.length; first += 1) {
      for (let second = first + 1; second < cellRects.length; second += 1) {
        const a = cellRects[first];
        const b = cellRects[second];
        const overlapWidth = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapHeight = Math.min(rectBottom(a), rectBottom(b)) - Math.max(a.y, b.y);
        if (overlapWidth > RECT_MATERIAL_OVERLAP && overlapHeight > RECT_MATERIAL_OVERLAP) {
          return { reason: "topology" };
        }
      }
    }
    for (let row = 0; row < rowCount; row += 1) {
      for (let column = 0; column < columnCount; column += 1) {
        if (cluster.some(rect => coversInterval(rect, xEdges[column], xEdges[column + 1])
          && rect.y <= yEdges[row] + RECT_SNAP_TOLERANCE
          && rectBottom(rect) >= yEdges[row + 1] - RECT_SNAP_TOLERANCE)) filledCells += 1;
      }
    }
    if (filledCells / totalCells < RECT_MIN_FILL_RATIO) return { reason: "ruling_unsupported" };

    const cells = Array.from({ length: rowCount }, () => (
      Array.from({ length: columnCount }, () => [])
    ));
    for (const record of lineRecords) {
      // A line partially crossing the cluster would be split or duplicated by
      // a table render, so the whole line must be inside the same evidence box.
      if (record.nonWhitespace.some(item => !pointInsideCluster(item, bounds))) {
        return { reason: "topology" };
      }
      for (const item of record.insideNonWhitespace) {
        const box = itemBox(item);
        const centerX = box.x + box.width / 2;
        const matches = [];
        for (let row = 0; row < rowCount; row += 1) {
          for (let column = 0; column < columnCount; column += 1) {
            if (centerX >= xEdges[column] - RECT_CELL_ASSIGNMENT_SLACK
              && centerX <= xEdges[column + 1] + RECT_CELL_ASSIGNMENT_SLACK
              && box.y >= yEdges[row] - RECT_CELL_ASSIGNMENT_SLACK
              && box.y <= yEdges[row + 1] + RECT_CELL_ASSIGNMENT_SLACK) {
              matches.push({ row, column });
            }
          }
        }
        // An item near a snapped boundary can be eligible for two cells. A
        // first-match choice would invent topology, so abandon instead.
        if (matches.length !== 1) return { reason: "topology" };
        const cell = cells[matches[0].row][matches[0].column];
        if (cell.some(entry => boxesOverlap(entry.item.bbox, box))) {
          return { reason: "topology" };
        }
        cell.push({ item, line: record.line });
      }
    }
    const assignedItems = new Set(lineRecords.flatMap(record => record.insideNonWhitespace));
    const unrepresentedItem = page.raw_items.some(item => (
      item.is_whitespace !== true
        && typeof item.text === "string"
        && item.text.trim().length > 0
        && pointInsideCluster(item, bounds)
        && !assignedItems.has(item)
    ));
    if (unrepresentedItem) return { reason: "topology" };

    const grid = cells.map(row => row.map(cell => {
      cell.sort((left, right) => (
        right.item.bbox.y - left.item.bbox.y
          || left.item.bbox.x - right.item.bbox.x
      ));
      if (cell.some(entry => /[\r\n]/u.test(entry.item.text) || /[\r\n]/u.test(entry.line.text))) return null;
      return cell.map(entry => entry.item.text.trim()).filter(Boolean).join(" ");
    }));
    if (grid.some(row => row.some(value => value === null))) return { reason: "topology" };

    const emptyColumns = grid[0].map((_value, column) => grid.every(row => row[column] === ""));
    let firstColumn = 0;
    let lastColumn = columnCount - 1;
    while (firstColumn <= lastColumn && emptyColumns[firstColumn]) firstColumn += 1;
    while (lastColumn >= firstColumn && emptyColumns[lastColumn]) lastColumn -= 1;
    if (emptyColumns.slice(firstColumn, lastColumn + 1).some(Boolean)) return { reason: "ruling_unsupported" };
    if (firstColumn > lastColumn) return { reason: "ruling_unsupported" };
    const trimmedGrid = grid.map(row => row.slice(firstColumn, lastColumn + 1));
    const candidateRows = lineRecords
      .sort((left, right) => left.line.y - right.line.y)
      .map(record => ({ line: record.line, cells: record.insideNonWhitespace }));
    if (!hasHeaderEvidence(candidateRows) && !hasFirstRowBandEvidence(bands)) {
      return { reason: "header" };
    }
    if (candidateRows.some(row => !runLineIds.has(row.line.id))) return { reason: "topology" };
    return { kind: "table", grid: trimmedGrid, rows: candidateRows };
  }
  return null;
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
  const ruledRects = preprocessRuledRects(page);
  const ruledClusters = ruledRects ? clusterRuledRects(ruledRects) : [];
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
      const ruling = ruledClusters.length > 0
        ? tryBuildRectGrid(page, run, ruledClusters, itemById)
        : null;
      if (ruling?.kind === "table") {
        segments.push({ kind: "table", rows: run, grid: ruling.grid });
      } else {
        // Preserve the reason from the rect-evidence attempt. The text path
        // can independently see a header/topology failure, but it must not
        // overwrite a more specific rect-path failure and its gap detail.
        if (ruling?.reason === "topology") {
          tableReason = "topology";
        } else if (ruling?.reason === "header") {
          tableReason = "header";
        } else if (ruling?.reason === "ruling_unsupported") {
          tableReason = "ruling_unsupported";
        } else if (tableLike) {
          tableReason = grid && grid.every(Boolean) ? "header" : "topology";
        }
        segments.push({ kind: "text", rows: run });
      }
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

/**
 * Resolve every link annotation on the page against the rendered lines.
 * Table runs cannot carry inline links in this renderer, so their lines are
 * excluded from the plan and any link landing there degrades to a typed gap.
 */
function analyzePageLinks(page, analysis, headings) {
  const links = page.link_annotations;
  // A truncated annotation list cannot prove that an omitted annotation does
  // not overlap a retained label. Suppress the whole page's explicit-link
  // projection so the overlap rule remains fail-closed.
  if (!links || links.status !== "available" || links.truncated === true) {
    return {
      spansByLine: new Map(),
      offsetsByLine: new Map(),
      unavailable: true,
      ambiguous: false,
      unsupportedTarget: false,
    };
  }
  const rows = analysis.segments.flatMap(segment => (
    segment.kind === "table" ? [] : segment.rows
  ));
  const excluded = new Set(rows
    .filter(row => headings.get(row.line.id) || rewritesLineStructure(row.line))
    .map(row => row.line.id));
  const plan = planPageLinks(rows, links.items ?? [], excluded);
  return {
    spansByLine: plan.spansByLine,
    offsetsByLine: plan.offsetsByLine,
    unavailable: false,
    ambiguous: plan.ambiguous,
    unsupportedTarget: plan.unsupportedTarget,
  };
}

function pageGaps(page, analysis, linkState) {
  const gaps = [];
  const add = (code, message) => gaps.push({ code, page: page.page, message });
  if (linkState?.unavailable) {
    add("LINK_ANNOTATIONS_UNAVAILABLE", "Link annotation evidence was unavailable or truncated for this page, so no explicit links were emitted.");
  }
  if (linkState?.unsupportedTarget) {
    add("UNSUPPORTED_LINK_TARGET", "At least one link targets an internal destination, an action, or an unsupported scheme, so it remains escaped text.");
  }
  if (linkState?.ambiguous) {
    add("LINK_MAPPING_AMBIGUOUS", "At least one link could not be mapped to exactly one contiguous run of source text, so it remains escaped text.");
  }
  if (analysis?.tableReason === "topology") {
    add("TABLE_TOPOLOGY_UNKNOWN", "Table-like content was detected but its column topology could not be reconstructed, so it remains reading-order text.");
  }
  if (analysis?.tableReason === "header") {
    add("TABLE_TOPOLOGY_UNKNOWN", "A column grid was detected but no source evidence distinguishes a header row, and a Markdown table would impose one, so it remains reading-order text.");
  }
  if (analysis?.tableReason === "ruling_unsupported") {
    add("TABLE_RULING_UNSUPPORTED", "Ruled rectangle evidence described a grid-shaped region, but its table topology could not be reconstructed, so it remains reading-order text.");
  if (page.text_integrity?.status === "suspect") {
    const details = page.text_integrity.signals
      .map(signal => `${signal.kind}=${signal.count}`)
      .join(", ");
    add("TEXT_INTEGRITY_SUSPECT", `Text-layer integrity signals were detected (${details}); extracted text is retained but may require visual inspection.`);
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
    add("VECTOR_CONTENT_NOT_INTERPRETED", "Vector paint operations beyond any reconstructed table rulings were not interpreted.");
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
  const linkState = analyzePageLinks(page, analysis, headings);
  const lines = analysis.segments.flatMap(segment => (
    segment.kind === "table"
      ? renderTable(segment.grid)
      : segment.rows.map(({ line }) => {
        const spans = linkState.spansByLine.get(line.id);
        const offsets = linkState.offsetsByLine.get(line.id);
        if (spans && spans.length > 0 && offsets && !headings.get(line.id)) {
          const linked = renderLinkedLine(line, offsets, spans);
          if (linked !== null) return linked;
        }
        return renderLine(line, headings.get(line.id));
      })
  ));
  const markdown = lines.length > 0
    ? lines.join("\n")
    : "[No source-backed text was available on this page.]";
  const gaps = pageGaps(page, analysis, linkState);
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
 * uses the layout IR's own text-item column geometry plus independently
 * validated closed ruled-rectangle evidence. The non-rect path remains the
 * pre-1.3.0 path; the rect path never infers merged or spanning cells and
 * abandons on ambiguous geometry.
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
    // Deliberately throws rather than emitting a gap: truncating would cut a
    // line or a Unicode sequence. There is therefore no byte-limit gap code,
    // because a code the renderer can never emit would misdescribe the
    // contract to callers.
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
