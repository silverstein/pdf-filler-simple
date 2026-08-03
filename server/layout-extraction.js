import { PDFDocument } from "pdf-lib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const IR_NAME = "pdf-tools.extraction-ir";
const IR_VERSION = "1.1.0";
const INTERNAL_SOURCE_REPLAY = Symbol("pdf-layout-internal-source-replay");
const INTERNAL_MARKDOWN_PROJECTION = Symbol("pdf-layout-internal-markdown-projection");

/**
 * PDF.js factory directories must end with a forward slash on every platform:
 * its factory validation is literally `.endsWith("/")`, so the
 * backslash-terminated paths fileURLToPath produces on Windows fail with
 * "Invalid factory url" and take every layout operation down with them.
 * Node's fs accepts forward-slash Windows paths, so normalizing the
 * separators is sufficient and platform-neutral.
 */
export function pdfjsFactoryDirectory(nativePath) {
  const normalized = String(nativePath).replaceAll("\\", "/");
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

const PDFJS_DOCUMENT_ASSETS = Object.freeze({
  cMapUrl: pdfjsFactoryDirectory(fileURLToPath(new URL("../node_modules/pdfjs-dist/cmaps/", import.meta.url))),
  cMapPacked: true,
  standardFontDataUrl: pdfjsFactoryDirectory(fileURLToPath(new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url))),
});
const ITEM_SPACE = Object.freeze({
  origin: "top_left",
  unit: "points_1_72_in_after_user_unit",
  reference_box: "pdfjs_display_viewport",
});
const RAW_PAGE_SPACE = Object.freeze({
  basis: "pdf_default_user_space",
  unit: "pdf_user_unit",
  stage: "before_user_unit_and_page_rotation",
});

function round(value) {
  return Number(Number(value).toFixed(3));
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function box(value) {
  return {
    x: round(value.x),
    y: round(value.y),
    width: round(value.width),
    height: round(value.height),
  };
}

function normalizedRotation(value) {
  return ((Number(value) % 360) + 360) % 360;
}

function effectiveViewportScale(viewportTransform) {
  return Math.hypot(Number(viewportTransform[0]), Number(viewportTransform[1]));
}

function ascentRatio(style) {
  if (Number.isFinite(Number(style?.ascent)) && Number(style.ascent) !== 0) {
    return { ratio: Number(style.ascent), source: "style_ascent" };
  }
  if (Number.isFinite(Number(style?.descent)) && Number(style.descent) !== 0) {
    return { ratio: 1 + Number(style.descent), source: "style_descent_fallback" };
  }
  return { ratio: 0.8, source: "default_0_8" };
}

export function pageGeometry(pdfLibPage, pdfjsPage, viewport, pageNumber) {
  const mediaBox = pdfLibPage ? box(pdfLibPage.getMediaBox()) : null;
  const cropBox = pdfLibPage ? box(pdfLibPage.getCropBox()) : null;
  const rawPdfRotation = pdfLibPage ? normalizedRotation(pdfLibPage.getRotation().angle) : null;
  const displayRotation = pdfjsPage ? normalizedRotation(pdfjsPage.rotate) : null;
  return {
    page: pageNumber,
    media_box: mediaBox,
    crop_box: cropBox,
    pdfjs_view: pdfjsPage ? pdfjsPage.view.map(round) : null,
    user_unit: pdfjsPage ? round(pdfjsPage.userUnit || 1) : null,
    raw_pdf_rotation: rawPdfRotation,
    display_rotation: displayRotation,
    rotation_matches_raw: displayRotation === null || rawPdfRotation === null ? null : displayRotation === rawPdfRotation,
    display_width: viewport ? round(viewport.width) : null,
    display_height: viewport ? round(viewport.height) : null,
    viewport_transform: viewport ? viewport.transform.map(round) : null,
    raw_page_space: { ...RAW_PAGE_SPACE },
    item_space: { ...ITEM_SPACE },
  };
}

const MAX_LINK_ANNOTATIONS = 200;
const SUPPORTED_LINK_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Resolve a link annotation to a supported target.
 *
 * Trust boundary: the only target string ever resolved is PDF.js's sanitized
 * `url`. The raw `unsafeUrl` is used solely as a typeof presence signal when
 * classifying the target class, and its content is never read, parsed, or
 * emitted. The value returned is the normalized `parsed.href`, not the
 * original string.
 */
function supportedLinkUrl(annotation) {
  const url = typeof annotation?.url === "string" ? annotation.url : null;
  if (url === null || url.length === 0 || url.length > 2048) return null;
  if (/[\u0000-\u0020\u007f-\u009f]/u.test(url)) return null;
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!SUPPORTED_LINK_PROTOCOLS.has(parsed.protocol)) return null;
  if (parsed.href.length > 2048) return null;
  if (/[\u0000-\u0020\u007f-\u009f]/u.test(parsed.href)) return null;
  return parsed.href;
}

/**
 * Which target classes the annotation declares. Presence only: `unsafeUrl` is
 * counted by type, never by content.
 */
function linkTargetClasses(annotation) {
  const classes = [];
  if (typeof annotation?.url === "string" || typeof annotation?.unsafeUrl === "string") {
    classes.push("url");
  }
  if (annotation?.dest !== undefined && annotation?.dest !== null) classes.push("destination");
  if (annotation?.action !== undefined && annotation?.action !== null) classes.push("action");
  return classes;
}

function linkTargetKind(annotation) {
  const classes = linkTargetClasses(annotation);
  // A safe url must not win over a co-declared destination or action. More
  // than one declared class is ambiguous and degrades to escaped text.
  if (classes.length === 0) return "none";
  if (classes.length > 1) return "ambiguous_target";
  if (classes[0] === "destination") return "internal_destination";
  if (classes[0] === "action") return "action";
  return supportedLinkUrl(annotation) !== null ? "http" : "unsupported_scheme";
}

function applyViewportPoint(transform, x, y) {
  return [
    transform[0] * x + transform[2] * y + transform[4],
    transform[1] * x + transform[3] * y + transform[5],
  ];
}

/**
 * Project an annotation rect from PDF user space into the same display
 * viewport the text items use, so rotation and CropBox origin are already
 * folded in by the viewport transform.
 */
function linkRectGeometry(viewportTransform, rect) {
  if (!Array.isArray(viewportTransform) || viewportTransform.length !== 6) return null;
  if (!viewportTransform.every(Number.isFinite)) return null;
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) return null;
  const [x1, y1, x2, y2] = rect;
  const corners = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
    .map(([x, y]) => applyViewportPoint(viewportTransform, x, y));
  const xs = corners.map(corner => corner[0]);
  const ys = corners.map(corner => corner[1]);
  if (![...xs, ...ys].every(Number.isFinite)) return null;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x: round(x),
    y: round(y),
    width: round(Math.max(...xs) - x),
    height: round(Math.max(...ys) - y),
  };
}

function collectLinkAnnotations(annotations, viewportTransform, pageNumber) {
  const items = [];
  let truncated = false;
  for (const annotation of Array.isArray(annotations) ? annotations : []) {
    if (annotation?.subtype !== "Link") continue;
    if (items.length >= MAX_LINK_ANNOTATIONS) {
      truncated = true;
      break;
    }
    const targetKind = linkTargetKind(annotation);
    items.push({
      id: `p${String(pageNumber).padStart(4, "0")}-link${String(items.length + 1).padStart(4, "0")}`,
      rect: linkRectGeometry(viewportTransform, annotation.rect),
      target_kind: targetKind,
      url: targetKind === "http" ? supportedLinkUrl(annotation) : null,
    });
  }
  return { status: "available", truncated, items };
}

const UNAVAILABLE_LINK_ANNOTATIONS = Object.freeze({
  status: "unavailable",
  truncated: false,
  items: [],
});

function multiplyTransforms(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function computeItemGeometry(viewportTransform, rawTransform, rawWidth, rawHeight, style) {
  const rawValues = [...viewportTransform, ...rawTransform, rawWidth, rawHeight];
  if (!rawValues.every(value => typeof value === "number" && Number.isFinite(value))) {
    return {
      valid: false,
      quad: null,
      bbox: null,
      line_height: null,
      ascent_ratio: null,
      ascent_source: null,
      advance_source: style?.vertical === true ? "item_height" : "item_width",
    };
  }
  const transformed = multiplyTransforms(viewportTransform, rawTransform);
  if (!transformed.every(Number.isFinite)) {
    return {
      valid: false,
      quad: null,
      bbox: null,
      line_height: null,
      ascent_ratio: null,
      ascent_source: null,
      advance_source: style?.vertical === true ? "item_height" : "item_width",
    };
  }
  const baseline = { x: transformed[4], y: transformed[5] };
  const fontSize = Math.hypot(transformed[2], transformed[3]);
  const viewportScale = effectiveViewportScale(viewportTransform);
  const isVertical = style?.vertical === true;
  const rawAdvance = isVertical ? rawHeight : rawWidth;
  const advanceLength = Math.abs(rawAdvance) * viewportScale;
  let angle = Math.atan2(transformed[1], transformed[0]);
  if (isVertical) angle += Math.PI / 2;
  const advance = { x: Math.cos(angle) * advanceLength, y: Math.sin(angle) * advanceLength };
  const cross = { x: -Math.sin(angle) * fontSize, y: Math.cos(angle) * fontSize };
  const ascent = ascentRatio(style);
  const top = {
    x: baseline.x + fontSize * ascent.ratio * Math.sin(angle),
    y: baseline.y - fontSize * ascent.ratio * Math.cos(angle),
  };
  const points = [
    top,
    { x: top.x + advance.x, y: top.y + advance.y },
    { x: top.x + cross.x, y: top.y + cross.y },
    { x: top.x + advance.x + cross.x, y: top.y + advance.y + cross.y },
  ];
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  return {
    valid: true,
    quad: points.map(point => ({ x: round(point.x), y: round(point.y) })),
    bbox: {
      x: round(Math.min(...xs)),
      y: round(Math.min(...ys)),
      width: round(Math.max(...xs) - Math.min(...xs)),
      height: round(Math.max(...ys) - Math.min(...ys)),
    },
    line_height: round(fontSize),
    ascent_ratio: round(ascent.ratio),
    ascent_source: ascent.source,
    advance_source: isVertical ? "item_height" : "item_width",
  };
}

function direction(value) {
  return ["ltr", "rtl", "ttb"].includes(value) ? value : "unknown";
}

function lineText(items, lineDirection) {
  let text = "";
  let previous = null;
  for (const item of items) {
    if (previous) {
      const gap = lineDirection === "rtl"
        ? previous.x - (item.x + item.width)
        : item.x - (previous.x + previous.width);
      const spaceThreshold = Math.max(1, Math.min(item.line_height ?? 8, previous.line_height ?? 8) * 0.2);
      if (gap > spaceThreshold && !text.endsWith(" ")) text += " ";
    }
    text += item.text;
    previous = item;
  }
  return normalizeText(text);
}

function combineBounds(items) {
  const right = Math.max(...items.map(item => item.x + item.width));
  const bottom = Math.max(...items.map(item => item.y + item.height));
  const x = Math.min(...items.map(item => item.x));
  const y = Math.min(...items.map(item => item.y));
  return { x: round(x), y: round(y), width: round(right - x), height: round(bottom - y) };
}

function materializeLine(lineItems, pageNumber, lineDirection) {
  const sourceFirstIndex = Math.min(...lineItems.map(item => item.source_index));
  return {
    id: `p${String(pageNumber).padStart(4, "0")}-l${String(sourceFirstIndex + 1).padStart(6, "0")}`,
    source_first_index: sourceFirstIndex,
    text: lineText(lineItems, lineDirection),
    ...combineBounds(lineItems),
    direction: lineDirection,
    item_ids: lineItems.map(item => item.id),
    reading_order_index: -1,
    column_index: 0,
  };
}

function medianNumber(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function itemBaselineCenter(item) {
  return item.y + item.height / 2;
}

function baselineInvariant(lineItems, toleranceFactor) {
  if (lineItems.length <= 1) return true;
  const centers = lineItems.map(itemBaselineCenter);
  const heights = lineItems.map(item => item.line_height).filter(Number.isFinite);
  const referenceHeight = heights.length > 0 ? medianNumber(heights) : 8;
  const centerMedian = medianNumber(centers);
  const tolerances = lineItems.map(item => Math.max(2, Math.min(referenceHeight, item.line_height ?? referenceHeight) * toleranceFactor));
  return lineItems.every((item, index) => Math.abs(centers[index] - centers[0]) <= tolerances[index]
    && Math.abs(centers[index] - centerMedian) <= tolerances[index])
    && Math.max(...centers) - Math.min(...centers) <= Math.min(...tolerances);
}

function groupLines(items, pageNumber) {
  const ordered = [...items].sort((left, right) => {
    const leftCenter = left.y + left.height / 2;
    const rightCenter = right.y + right.height / 2;
    return leftCenter - rightCenter || left.x - right.x || left.source_index - right.source_index;
  });
  const lines = [];
  for (const item of ordered) {
    const center = item.y + item.height / 2;
    let best = null;
    let bestDistance = Infinity;
    for (const line of lines) {
      if (line.direction !== item.direction || line.hard_segment !== item.hard_segment) continue;
      if (!baselineInvariant([...line.items, item], 0.35)) continue;
      const distance = Math.abs(center - medianNumber(line.items.map(itemBaselineCenter)));
      const lineLeft = Math.min(...line.items.map(value => value.x));
      const lineRight = Math.max(...line.items.map(value => value.x + value.width));
      const alongAxisGap = Math.max(0, lineLeft - (item.x + item.width), item.x - lineRight);
      const maxAlongAxisGap = Math.max(24, Math.min(line.median_font_size, item.line_height ?? line.median_font_size) * 4);
      if (alongAxisGap > maxAlongAxisGap) continue;
      if (distance < bestDistance) {
        best = line;
        bestDistance = distance;
      }
    }
    if (!best) {
      lines.push({ center, direction: item.direction, hard_segment: item.hard_segment, median_font_size: item.line_height ?? 8, items: [item] });
    } else {
      best.items.push(item);
      best.center = best.items.reduce((sum, value) => sum + value.y + value.height / 2, 0) / best.items.length;
      const sizes = best.items.map(value => value.line_height).filter(Number.isFinite).sort((a, b) => a - b);
      if (sizes.length > 0) best.median_font_size = sizes[Math.floor(sizes.length / 2)];
    }
  }
  return lines.map(line => {
    const lineItems = [...line.items].sort((left, right) => {
      if (line.direction === "rtl") return right.x - left.x || left.source_index - right.source_index;
      return left.x - right.x || left.source_index - right.source_index;
    });
    return materializeLine(lineItems, pageNumber, line.direction);
  });
}

function sourceOrderLines(items, pageNumber) {
  const segments = [];
  let current = null;
  for (const item of [...items].sort((left, right) => left.source_index - right.source_index)) {
    if (!item.geometry_valid || item.is_whitespace) continue;
    if (!current
      || current.hard_segment !== item.hard_segment
      || current.direction !== item.direction
      || !baselineInvariant([...current.items, item], 0.5)) {
      current = { hard_segment: item.hard_segment, direction: item.direction, items: [] };
      segments.push(current);
    }
    current.items.push(item);
  }
  return segments.map(segment => materializeLine(segment.items, pageNumber, segment.direction));
}

function buildBlocks(lines, pageNumber, columnCount) {
  const blocks = [];
  for (const line of lines) {
    const previous = blocks.at(-1);
    if (!previous || previous.column_index !== line.column_index) {
      blocks.push({
        id: `p${String(pageNumber).padStart(4, "0")}-b${String(blocks.length + 1).padStart(4, "0")}`,
        kind: line.column_index === -1 ? "spanning_flow" : columnCount > 1 ? "column_flow" : "page_flow",
        column_index: line.column_index,
        line_ids: [],
      });
    }
    blocks.at(-1).line_ids.push(line.id);
  }
  return blocks;
}

function readingOrder(lines, displayWidth, { sourceLines, forceSourceOrder = false, fallbackReason = null } = {}) {
  const sourceOrder = [...sourceLines].sort((left, right) => left.source_first_index - right.source_first_index);
  if (forceSourceOrder) {
    return {
      lines: sourceOrder,
      strategy: "source_order_fallback",
      confidence: "not_calibrated",
      column_count: 1,
      limitations: [
        fallbackReason || "Geometry was ambiguous, so source item order was retained.",
        "Source order is parser order and is not proof of intended or visible reading order.",
      ],
    };
  }
  const defaultResult = {
    lines: sourceOrder,
    strategy: "source_order_fallback",
    confidence: "not_calibrated",
    column_count: 1,
    limitations: [
      "Column evidence was insufficient or ambiguous, so source item order was retained.",
      "Source order is parser order and is not proof of intended or visible reading order.",
    ],
  };
  if (lines.length < 4) return defaultResult;

  const byX = [...lines].sort((left, right) => left.x - right.x || left.y - right.y);
  let largestGap = { size: 0, index: -1 };
  for (let index = 1; index < byX.length; index += 1) {
    const gap = byX[index].x - byX[index - 1].x;
    if (gap > largestGap.size) largestGap = { size: gap, index };
  }
  if (largestGap.index < 2 || byX.length - largestGap.index < 2 || largestGap.size < displayWidth * 0.15) {
    return defaultResult;
  }
  const threshold = (byX[largestGap.index - 1].x + byX[largestGap.index].x) / 2;
  const spanning = lines.filter(line => line.x < threshold && line.x + line.width > threshold);
  const left = lines.filter(line => line.x <= threshold && !spanning.includes(line));
  const right = lines.filter(line => line.x > threshold);
  if (left.length < 2 || right.length < 2) return defaultResult;
  const gutterLeft = Math.max(...left.map(line => line.x + line.width));
  const gutterRight = Math.min(...right.map(line => line.x));
  if (gutterRight - gutterLeft < Math.max(12, displayWidth * 0.05)) return defaultResult;
  const span = values => ({
    top: Math.min(...values.map(line => line.y)),
    bottom: Math.max(...values.map(line => line.y + line.height)),
  });
  const leftSpan = span(left);
  const rightSpan = span(right);
  const overlap = Math.max(0, Math.min(leftSpan.bottom, rightSpan.bottom) - Math.max(leftSpan.top, rightSpan.top));
  const minimumSpan = Math.min(leftSpan.bottom - leftSpan.top, rightSpan.bottom - rightSpan.top);
  if (minimumSpan <= 0 || overlap / minimumSpan < 0.5) return defaultResult;
  const hasSegmentedBaseline = values => values.some((line, index) => values.slice(index + 1).some(other => {
    const centerDistance = Math.abs((line.y + line.height / 2) - (other.y + other.height / 2));
    const tolerance = Math.max(2, Math.min(line.height, other.height) * 0.35);
    const horizontallySeparate = line.x + line.width <= other.x || other.x + other.width <= line.x;
    return horizontallySeparate && centerDistance <= tolerance;
  }));
  if (hasSegmentedBaseline(left) || hasSegmentedBaseline(right)) {
    return {
      ...defaultResult,
      limitations: [
        "A candidate column contained multiple non-overlapping lines on the same baseline, so table-like or segmented content retained source order.",
        "Source order is parser order and is not proof of intended or visible reading order.",
      ],
    };
  }
  const columnTop = Math.min(leftSpan.top, rightSpan.top);
  const columnBottom = Math.max(leftSpan.bottom, rightSpan.bottom);
  const spanningAbove = spanning.filter(line => line.y + line.height <= columnTop);
  const spanningBelow = spanning.filter(line => line.y >= columnBottom);
  if (spanningAbove.length + spanningBelow.length !== spanning.length) return defaultResult;

  for (const line of left) line.column_index = 0;
  for (const line of right) line.column_index = 1;
  for (const line of spanning) line.column_index = -1;
  const stableGeometryOrder = values => values.sort((a, b) => a.y - b.y || a.x - b.x || a.source_first_index - b.source_first_index);
  return {
    lines: [
      ...stableGeometryOrder(spanningAbove),
      ...stableGeometryOrder(left),
      ...stableGeometryOrder(right),
      ...stableGeometryOrder(spanningBelow),
    ],
    strategy: "two_column_left_to_right",
    confidence: "not_calibrated",
    column_count: 2,
    limitations: [
      "Two-column order requires persistent non-overlapping line boxes and a real gutter; confidence is not calibrated.",
      "Spanning headings or footers are retained only when they are geometrically outside both column spans.",
      "Tables, floating objects, and footnotes are not inferred.",
    ],
  };
}

function imageOperationSet(pdfjsLib) {
  return new Set([
    pdfjsLib.OPS?.paintImageXObject,
    pdfjsLib.OPS?.paintJpegXObject,
    pdfjsLib.OPS?.paintImageMaskXObject,
    pdfjsLib.OPS?.paintImageMaskXObjectGroup,
    pdfjsLib.OPS?.paintInlineImageXObject,
    pdfjsLib.OPS?.paintInlineImageXObjectGroup,
    pdfjsLib.OPS?.paintImageXObjectRepeat,
    pdfjsLib.OPS?.paintImageMaskXObjectRepeat,
  ].filter(Number.isInteger));
}

function vectorOperationSet(pdfjsLib) {
  return new Set([
    pdfjsLib.OPS?.stroke,
    pdfjsLib.OPS?.closeStroke,
    pdfjsLib.OPS?.fill,
    pdfjsLib.OPS?.eoFill,
    pdfjsLib.OPS?.fillStroke,
    pdfjsLib.OPS?.eoFillStroke,
    pdfjsLib.OPS?.closeFillStroke,
    pdfjsLib.OPS?.closeEOFillStroke,
    pdfjsLib.OPS?.shadingFill,
    pdfjsLib.OPS?.constructPath,
    pdfjsLib.OPS?.rawFillPath,
  ].filter(Number.isInteger));
}

function errorRecord(stage, error) {
  return {
    stage,
    code: String(error?.name || "Error"),
    message: String(error?.message || error || "Unknown parser error").slice(0, 500),
  };
}

function withDeadline(operation, deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return Promise.reject(Object.assign(new Error("PDF layout extraction exceeded its 20 second deadline."), { code: "LAYOUT_DEADLINE" }));
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("PDF layout extraction exceeded its 20 second deadline."), { code: "LAYOUT_DEADLINE" })), remaining);
    }),
  ]).finally(() => clearTimeout(timer));
}

function classifyLoadingError(error, pdfjsLib) {
  const passwordCode = Number(error?.code);
  const passwordName = String(error?.name || "");
  if (passwordName !== "PasswordException") return error;
  const requiredCode = Number(pdfjsLib.PasswordResponses?.NEED_PASSWORD ?? 1);
  const incorrectCode = Number(pdfjsLib.PasswordResponses?.INCORRECT_PASSWORD ?? 2);
  if (passwordCode === requiredCode) {
    return Object.assign(new Error("PDF password is required."), { code: "PASSWORD_REQUIRED" });
  }
  if (passwordCode === incorrectCode) {
    return Object.assign(new Error("PDF password is incorrect."), { code: "PASSWORD_INCORRECT" });
  }
  return Object.assign(new Error("PDF password authentication failed."), { code: "PASSWORD_AUTHENTICATION_FAILED" });
}

function isFatalParserResourceError(error) {
  const name = String(error?.name || "");
  const code = String(error?.code || "");
  return code === "LAYOUT_DEADLINE"
    || /Abort|Cancel|Timeout|MissingPDF|UnexpectedResponse/i.test(name)
    || /DEADLINE|TIMEOUT|ABORT|CANCEL|ENOMEM|RESOURCE|EIO|EMFILE|ENFILE/i.test(code);
}

function recomputeDocumentTruncation(payload) {
  const truncatedPages = payload.pages.filter(page => page.truncation.truncated);
  payload.truncation.truncated = truncatedPages.length > 0;
  payload.truncation.omitted_items = truncatedPages.reduce((sum, page) => sum + page.truncation.omitted_items, 0);
  payload.truncation.omitted_characters = truncatedPages.reduce((sum, page) => sum + page.truncation.omitted_characters, 0);
  payload.truncation.first_omitted_page = truncatedPages[0]?.page ?? null;
  payload.truncation.first_omitted_source_index = truncatedPages[0]?.truncation.first_omitted_source_index ?? null;
}

function markOutputBudget(payload, maxOutputCharacters) {
  if (JSON.stringify(payload).length <= maxOutputCharacters) return payload;
  if (!payload.truncation.reasons.includes("max_output_characters")) payload.truncation.reasons.push("max_output_characters");
  for (let index = payload.pages.length - 1; index >= 0 && JSON.stringify(payload).length > maxOutputCharacters; index -= 1) {
    const page = payload.pages[index];
    if (page.raw_items.length === 0 && page.lines.length === 0 && page.flow_text.length === 0) continue;
    page.truncation.truncated = true;
    if (!page.truncation.reasons.includes("max_output_characters")) page.truncation.reasons.push("max_output_characters");
    page.truncation.first_omitted_source_index = page.raw_items[0]?.source_index ?? page.truncation.first_omitted_source_index;
    page.truncation.omitted_items = page.counts.observed_items;
    page.truncation.omitted_non_whitespace_items = page.counts.observed_non_whitespace_items;
    page.truncation.omitted_characters = page.counts.observed_characters;
    page.counts.returned_items = 0;
    page.counts.returned_non_whitespace_items = 0;
    page.counts.returned_characters = 0;
    page.raw_items = [];
    page.lines = [];
    page.blocks = [];
    // Link items are page detail too. Leaving them would keep a link-heavy
    // page over budget and turn a bounded partial into a whole-call error.
    page.link_annotations = { status: "unavailable", truncated: true, items: [] };
    page.flow_text = "";
    page.spatial_text = "";
    page.reading_order = {
      strategy: "unavailable_output_omitted",
      confidence: "not_calibrated",
      column_count: 0,
      limitations: ["Reading-order evidence was omitted to satisfy max_output_characters."],
    };
    if (page.text_layer_status === "present") page.text_layer_status = "partial";
    page.extraction_status = "partial";
    page.needs_visual_inspection = true;
    if (!page.limitations.includes("Page detail omitted to satisfy max_output_characters.")) {
      page.limitations.push("Page detail omitted to satisfy max_output_characters.");
    }
  }
  recomputeDocumentTruncation(payload);
  if (JSON.stringify(payload).length > maxOutputCharacters) {
    throw new Error("Layout metadata exceeds max_output_characters. Request a narrower page range.");
  }
  payload.extraction_status = payload.pages.every(page => page.extraction_status === "failed") ? "failed" : "partial";
  return payload;
}

function finiteOrNull(value) {
  return Number.isFinite(Number(value)) ? round(value) : null;
}

function safeTransform(transform) {
  return Array.from({ length: 6 }, (_, index) => finiteOrNull(transform?.[index]));
}

function semanticAssertion(condition, message) {
  if (!condition) throw new Error(`Invalid Extraction IR semantics: ${message}`);
}

function sameRoundedNumber(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 0.002;
}

function roundedProductTolerance(left, right, leftError = 0.0005, rightError = 0.0005) {
  return 0.001 + Math.abs(left) * rightError + Math.abs(right) * leftError + leftError * rightError;
}

function roundedSpanProductTolerance(start, end, scale) {
  const span = end - start;
  return 0.001 + Math.abs(span) * 0.0005 + Math.abs(scale) * 0.001 + 0.0000005;
}

function expectedViewportGeometry(view, userUnit, rotation) {
  const [x1, y1, x2, y2] = view;
  const scale = userUnit;
  const xSpanTolerance = roundedSpanProductTolerance(x1, x2, scale);
  const ySpanTolerance = roundedSpanProductTolerance(y1, y2, scale);
  if (rotation === 0) {
    return {
      width: (x2 - x1) * scale,
      height: (y2 - y1) * scale,
      transform: [scale, 0, 0, -scale, -x1 * scale, y2 * scale],
      width_tolerance: xSpanTolerance,
      height_tolerance: ySpanTolerance,
      transform_tolerances: [0.002, 0.002, 0.002, 0.002, roundedProductTolerance(x1, scale), roundedProductTolerance(y2, scale)],
    };
  }
  if (rotation === 90) {
    return {
      width: (y2 - y1) * scale,
      height: (x2 - x1) * scale,
      transform: [0, scale, scale, 0, -y1 * scale, -x1 * scale],
      width_tolerance: ySpanTolerance,
      height_tolerance: xSpanTolerance,
      transform_tolerances: [0.002, 0.002, 0.002, 0.002, roundedProductTolerance(y1, scale), roundedProductTolerance(x1, scale)],
    };
  }
  if (rotation === 180) {
    return {
      width: (x2 - x1) * scale,
      height: (y2 - y1) * scale,
      transform: [-scale, 0, 0, scale, x2 * scale, -y1 * scale],
      width_tolerance: xSpanTolerance,
      height_tolerance: ySpanTolerance,
      transform_tolerances: [0.002, 0.002, 0.002, 0.002, roundedProductTolerance(x2, scale), roundedProductTolerance(y1, scale)],
    };
  }
  return {
    width: (y2 - y1) * scale,
    height: (x2 - x1) * scale,
    transform: [0, -scale, -scale, 0, y2 * scale, x2 * scale],
    width_tolerance: ySpanTolerance,
    height_tolerance: xSpanTolerance,
    transform_tolerances: [0.002, 0.002, 0.002, 0.002, roundedProductTolerance(y2, scale), roundedProductTolerance(x2, scale)],
  };
}

export function validatePdfLayoutSemantics(payload, {
  sourceBytes = null,
  enforceOutputBudget = true,
} = {}) {
  semanticAssertion(payload.id_scope.source_sha256 === payload.source.sha256, "ID scope source hash mismatch");
  semanticAssertion(payload.id_scope.parser_version === payload.parser.version, "ID scope parser mismatch");
  semanticAssertion(payload.id_scope.ir_version === payload.ir.version, "ID scope IR mismatch");
  semanticAssertion(payload.id_scope.requested_start_page === payload.page_range.requested_start_page, "ID scope start page mismatch");
  semanticAssertion(payload.id_scope.requested_end_page === payload.page_range.requested_end_page, "ID scope end page mismatch");
  semanticAssertion(payload.id_scope.max_items === payload.limits.max_items, "ID scope item limit mismatch");
  semanticAssertion(payload.id_scope.max_characters === payload.limits.max_characters, "ID scope character limit mismatch");
  semanticAssertion(payload.id_scope.max_output_characters === payload.limits.max_output_characters, "ID scope output limit mismatch");
  semanticAssertion(Number.isSafeInteger(payload.source.size_bytes)
    && payload.source.size_bytes >= 1
    && payload.source.size_bytes <= 250 * 1024 * 1024, "invalid source size");
  if (sourceBytes !== null) {
    semanticAssertion(payload.source.size_bytes === sourceBytes.length, "source byte length mismatch");
    semanticAssertion(payload.source.sha256 === createHash("sha256").update(sourceBytes).digest("hex"), "source byte hash mismatch");
  }
  semanticAssertion(Number.isInteger(payload.page_range.requested_start_page) && payload.page_range.requested_start_page >= 1, "invalid requested start page");
  semanticAssertion(payload.page_range.requested_end_page >= payload.page_range.requested_start_page, "invalid requested end page");
  semanticAssertion(payload.page_range.start_page === payload.page_range.requested_start_page
    && payload.page_range.end_page === payload.page_range.requested_end_page
    && payload.page_range.end_page <= payload.page_range.total_pages, "effective page range mismatch");
  semanticAssertion(payload.pages.length <= 10, "page range exceeds hard limit");
  semanticAssertion(payload.limits.max_items >= 1 && payload.limits.max_items <= 5000, "item limit out of range");
  semanticAssertion(payload.limits.max_characters >= 1 && payload.limits.max_characters <= 100000, "character limit out of range");
  semanticAssertion(payload.limits.max_output_characters >= 20000 && payload.limits.max_output_characters <= 200000, "output limit out of range");
  semanticAssertion(payload.limits.deadline_ms === 20000, "deadline mismatch");
  semanticAssertion(payload.pages.length === payload.page_range.end_page - payload.page_range.start_page + 1, "page range length mismatch");

  const documentIds = new Set();
  for (let pageOffset = 0; pageOffset < payload.pages.length; pageOffset += 1) {
    const page = payload.pages[pageOffset];
    const expectedPage = payload.page_range.start_page + pageOffset;
    const pagePrefix = `p${String(expectedPage).padStart(4, "0")}`;
    const links = page.link_annotations;
    semanticAssertion(links && typeof links === "object" && !Array.isArray(links),
      `page ${page.page} link annotations are malformed`);
    semanticAssertion(["available", "unavailable"].includes(links.status),
      `page ${page.page} link annotation status is invalid`);
    semanticAssertion(typeof links.truncated === "boolean",
      `page ${page.page} link annotation truncation flag is invalid`);
    semanticAssertion(Array.isArray(links.items) && links.items.length <= MAX_LINK_ANNOTATIONS,
      `page ${page.page} link annotation list is invalid`);
    semanticAssertion(links.status === "available" || links.items.length === 0,
      `page ${page.page} reports unavailable link annotations with retained items`);
    // An unavailable link state is only legitimate when the page carries an
    // annotations-stage error or had its detail omitted for the output budget.
    // Without this, downgrading available evidence to unavailable would pass.
    const linkAnnotationError = page.errors.some(
      error => error.stage === "annotations" || error.stage === "page",
    );
    const linkBudgetOmitted = page.truncation.reasons.includes("max_output_characters");
    if (links.status === "unavailable") {
      semanticAssertion(linkAnnotationError || linkBudgetOmitted,
        `page ${page.page} reports unavailable link annotations without supporting evidence`);
      semanticAssertion(!linkBudgetOmitted || links.truncated === true,
        `page ${page.page} omitted link detail for the output budget without recording truncation`);
    }
    for (let linkIndex = 0; linkIndex < links.items.length; linkIndex += 1) {
      const link = links.items[linkIndex];
      semanticAssertion(link.id === `${pagePrefix}-link${String(linkIndex + 1).padStart(4, "0")}`,
        `page ${page.page} link ${link.id} is out of order`);
      semanticAssertion([
        "http",
        "internal_destination",
        "action",
        "unsupported_scheme",
        "ambiguous_target",
        "none",
      ].includes(link.target_kind), `page ${page.page} link ${link.id} target kind is invalid`);
      // Only an http target may carry a URL, and it must already be exactly
      // the normalized absolute form the resolver would produce.
      if (link.target_kind === "http") {
        semanticAssertion(typeof link.url === "string"
          && link.url === supportedLinkUrl({ url: link.url }),
        `page ${page.page} link ${link.id} url is not a normalized supported target`);
      } else {
        semanticAssertion(link.url === null,
          `page ${page.page} link ${link.id} retains a url for a non-http target`);
      }
      semanticAssertion(!documentIds.has(link.id), `duplicate ID ${link.id}`);
      documentIds.add(link.id);
      semanticAssertion(link.rect === null || (
        Number.isFinite(link.rect.x) && Number.isFinite(link.rect.y)
        && Number.isFinite(link.rect.width) && Number.isFinite(link.rect.height)
        && link.rect.width >= 0 && link.rect.height >= 0
      ), `page ${page.page} link ${link.id} rect is invalid`);
    }
    semanticAssertion(page.page === expectedPage && page.id === pagePrefix, `page ${expectedPage} identity mismatch`);
    semanticAssertion(page.geometry.page === page.page, `page ${page.page} geometry identity mismatch`);
    semanticAssertion(page.geometry.rotation_matches_raw === (page.geometry.display_rotation === null || page.geometry.raw_pdf_rotation === null
      ? null : page.geometry.display_rotation === page.geometry.raw_pdf_rotation), `page ${page.page} rotation cross-check mismatch`);
    const rawGeometryUnavailable = page.errors.some(error => error.code === "RAW_PAGE_GEOMETRY_UNAVAILABLE");
    if (rawGeometryUnavailable) {
      semanticAssertion(page.geometry.media_box === null
        && page.geometry.crop_box === null
        && page.geometry.raw_pdf_rotation === null
        && page.geometry.rotation_matches_raw === null, `page ${page.page} unavailable raw geometry contains claims`);
    } else {
      semanticAssertion(page.geometry.media_box !== null
        && page.geometry.crop_box !== null
        && page.geometry.raw_pdf_rotation !== null, `page ${page.page} raw geometry lacks unavailability evidence`);
    }
    for (const rawBox of [page.geometry.media_box, page.geometry.crop_box]) {
      if (rawBox) {
        semanticAssertion([rawBox.x, rawBox.y, rawBox.width, rawBox.height].every(Number.isFinite)
          && rawBox.width > 0 && rawBox.height > 0, `page ${page.page} invalid raw page box`);
      }
    }
    if (page.geometry.display_width !== null || page.geometry.display_height !== null) {
      semanticAssertion(Number.isFinite(page.geometry.display_width) && page.geometry.display_width > 0
        && Number.isFinite(page.geometry.display_height) && page.geometry.display_height > 0, `page ${page.page} invalid display size`);
      semanticAssertion(Array.isArray(page.geometry.viewport_transform)
        && page.geometry.viewport_transform.length === 6
        && page.geometry.viewport_transform.every(Number.isFinite), `page ${page.page} invalid viewport transform`);
      semanticAssertion(Array.isArray(page.geometry.pdfjs_view)
        && page.geometry.pdfjs_view.length === 4
        && page.geometry.pdfjs_view.every(Number.isFinite), `page ${page.page} invalid PDF.js view`);
      semanticAssertion(Number.isFinite(page.geometry.user_unit) && page.geometry.user_unit > 0, `page ${page.page} invalid UserUnit`);
      semanticAssertion(sameRoundedNumber(effectiveViewportScale(page.geometry.viewport_transform), page.geometry.user_unit), `page ${page.page} viewport scale/UserUnit mismatch`);
      const [viewX1, viewY1, viewX2, viewY2] = page.geometry.pdfjs_view;
      semanticAssertion(viewX2 > viewX1 && viewY2 > viewY1, `page ${page.page} invalid PDF.js view bounds`);
      semanticAssertion([0, 90, 180, 270].includes(page.geometry.display_rotation), `page ${page.page} invalid display rotation`);
      const expectedViewport = expectedViewportGeometry(
        page.geometry.pdfjs_view,
        page.geometry.user_unit,
        page.geometry.display_rotation,
      );
      semanticAssertion(Math.abs(page.geometry.display_width - expectedViewport.width) <= expectedViewport.width_tolerance
        && Math.abs(page.geometry.display_height - expectedViewport.height) <= expectedViewport.height_tolerance, `page ${page.page} display size/view mismatch`);
      semanticAssertion(page.geometry.viewport_transform.every((value, index) => Math.abs(value - expectedViewport.transform[index]) <= expectedViewport.transform_tolerances[index]), `page ${page.page} viewport transform/view/rotation mismatch`);
    }
    semanticAssertion(!documentIds.has(page.id), `duplicate ID ${page.id}`);
    documentIds.add(page.id);

    const itemById = new Map();
    let returnedCharacters = 0;
    for (let index = 0; index < page.raw_items.length; index += 1) {
      const item = page.raw_items[index];
      const expectedId = `${pagePrefix}-i${String(item.source_index + 1).padStart(6, "0")}`;
      semanticAssertion(item.id === expectedId, `item ID ${item.id} is outside its page/source scope`);
      semanticAssertion(!documentIds.has(item.id), `duplicate ID ${item.id}`);
      semanticAssertion(Number.isSafeInteger(item.source_index) && item.source_index >= 0, `item ${item.id} has unsafe source index`);
      semanticAssertion(item.source_index === index, `page ${page.page} retained items are not the exact source prefix`);
      documentIds.add(item.id);
      itemById.set(item.id, item);
      returnedCharacters += item.text.length;
      const expectedTextKind = item.text.length === 0 ? "empty" : item.text.trim().length === 0 ? "whitespace" : "non_whitespace";
      semanticAssertion(item.text_kind === expectedTextKind, `item ${item.id} text_kind mismatch`);
      semanticAssertion(item.is_whitespace === (expectedTextKind !== "non_whitespace"), `item ${item.id} whitespace mismatch`);
      semanticAssertion(item.geometry_provenance.formula === "pdfjs_text_item_style_metric_advance_box_approximation", `item ${item.id} formula provenance mismatch`);
      semanticAssertion(item.geometry_provenance.quad_order === "anchor_top_terminal_top_anchor_bottom_terminal_bottom", `item ${item.id} quad order mismatch`);
      semanticAssertion(item.geometry_provenance.advance_source === (item.font.vertical ? "item_height" : "item_width"), `item ${item.id} advance provenance mismatch`);
      const expectedGeometry = computeItemGeometry(
        page.geometry.viewport_transform ?? [],
        item.raw_transform ?? [],
        item.raw_width,
        item.raw_height,
        item.font,
      );
      semanticAssertion(item.geometry_valid === expectedGeometry.valid, `item ${item.id} geometry validity mismatch`);
      if (!item.geometry_valid) {
        semanticAssertion(item.bbox_status === "invalid" && item.quad === null && item.bbox === null, `item ${item.id} invalid geometry mismatch`);
        semanticAssertion([item.x, item.y, item.width, item.height, item.line_height].every(value => value === null), `item ${item.id} invalid geometry leaked coordinates`);
        semanticAssertion(item.geometry_provenance.ascent_source === null && item.geometry_provenance.ascent_ratio === null, `item ${item.id} invalid geometry provenance mismatch`);
      } else {
        semanticAssertion(Array.isArray(item.raw_transform)
          && item.raw_transform.length === 6
          && item.raw_transform.every(value => typeof value === "number" && Number.isFinite(value))
          && typeof item.raw_width === "number" && Number.isFinite(item.raw_width) && item.raw_width >= 0
          && typeof item.raw_height === "number" && Number.isFinite(item.raw_height) && item.raw_height >= 0, `item ${item.id} invalid raw PDF.js metrics`);
        semanticAssertion(Array.isArray(item.quad) && item.quad.length === 4 && item.bbox, `item ${item.id} missing valid geometry`);
        semanticAssertion(Number.isFinite(item.line_height) && item.line_height >= 0, `item ${item.id} invalid line height`);
        semanticAssertion(item.quad.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)), `item ${item.id} has non-finite quad`);
        semanticAssertion(item.quad.every((point, pointIndex) => sameRoundedNumber(point.x, expectedGeometry.quad[pointIndex].x)
          && sameRoundedNumber(point.y, expectedGeometry.quad[pointIndex].y)), `item ${item.id} quad does not match raw PDF.js metrics`);
        semanticAssertion(sameRoundedNumber(item.line_height, expectedGeometry.line_height), `item ${item.id} line height mismatch`);
        semanticAssertion(item.geometry_provenance.advance_source === expectedGeometry.advance_source
          && item.geometry_provenance.ascent_source === expectedGeometry.ascent_source
          && sameRoundedNumber(item.geometry_provenance.ascent_ratio, expectedGeometry.ascent_ratio), `item ${item.id} recomputed provenance mismatch`);
        const expectedRawCrossMetric = Math.hypot(item.raw_transform[2], item.raw_transform[3]);
        const rawCrossMetric = item.font.vertical ? item.raw_width : item.raw_height;
        semanticAssertion(rawCrossMetric === 0 || sameRoundedNumber(rawCrossMetric, expectedRawCrossMetric), `item ${item.id} raw cross metric mismatch`);
        const xs = item.quad.map(point => point.x);
        const ys = item.quad.map(point => point.y);
        const expectedBox = {
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
        };
        semanticAssertion(sameRoundedNumber(item.bbox.x, expectedBox.x)
          && sameRoundedNumber(item.bbox.y, expectedBox.y)
          && sameRoundedNumber(item.bbox.width, expectedBox.width)
          && sameRoundedNumber(item.bbox.height, expectedBox.height), `item ${item.id} bbox does not enclose its quad`);
        semanticAssertion(sameRoundedNumber(item.x, item.bbox.x)
          && sameRoundedNumber(item.y, item.bbox.y)
          && sameRoundedNumber(item.width, item.bbox.width)
          && sameRoundedNumber(item.height, item.bbox.height), `item ${item.id} convenience bbox mismatch`);
        const expectedBboxStatus = item.bbox.width === 0 || item.bbox.height === 0 ? "degenerate" : "valid";
        semanticAssertion(item.bbox_status === expectedBboxStatus, `item ${item.id} bbox_status mismatch`);
        semanticAssertion(sameRoundedNumber(item.bbox.x, expectedGeometry.bbox.x)
          && sameRoundedNumber(item.bbox.y, expectedGeometry.bbox.y)
          && sameRoundedNumber(item.bbox.width, expectedGeometry.bbox.width)
          && sameRoundedNumber(item.bbox.height, expectedGeometry.bbox.height), `item ${item.id} bbox does not match raw PDF.js metrics`);
        const expectedAscent = ascentRatio(item.font);
        semanticAssertion(item.geometry_provenance.ascent_source === expectedAscent.source
          && sameRoundedNumber(item.geometry_provenance.ascent_ratio, expectedAscent.ratio), `item ${item.id} ascent provenance mismatch`);
      }
    }

    semanticAssertion(page.counts.returned_items === page.raw_items.length, `page ${page.page} returned item count mismatch`);
    semanticAssertion(page.counts.returned_characters === returnedCharacters, `page ${page.page} returned character count mismatch`);
    semanticAssertion(page.counts.observed_items === page.counts.returned_items + page.truncation.omitted_items, `page ${page.page} observed item count mismatch`);
    semanticAssertion(page.counts.observed_characters === page.counts.returned_characters + page.truncation.omitted_characters, `page ${page.page} observed character count mismatch`);
    const returnedNonWhitespace = page.raw_items.filter(item => item.text_kind === "non_whitespace").length;
    semanticAssertion(page.counts.returned_non_whitespace_items === returnedNonWhitespace, `page ${page.page} returned non-whitespace count mismatch`);
    semanticAssertion(page.counts.observed_non_whitespace_items === page.counts.returned_non_whitespace_items + page.truncation.omitted_non_whitespace_items, `page ${page.page} observed non-whitespace count mismatch`);
    const pageHasOmissions = page.truncation.omitted_items > 0 || page.truncation.omitted_characters > 0;
    semanticAssertion(page.truncation.truncated === pageHasOmissions, `page ${page.page} truncation flag mismatch`);
    semanticAssertion(new Set(page.truncation.reasons).size === page.truncation.reasons.length, `page ${page.page} duplicate truncation reasons`);
    semanticAssertion(page.truncation.reasons.every(reason => ["max_items", "max_characters", "max_output_characters"].includes(reason)), `page ${page.page} unknown truncation reason`);
    semanticAssertion(page.truncation.truncated
      ? page.truncation.reasons.length > 0 && page.truncation.first_omitted_source_index !== null
      : page.truncation.reasons.length === 0 && page.truncation.first_omitted_source_index === null, `page ${page.page} truncation evidence mismatch`);
    if (page.truncation.first_omitted_source_index !== null) {
      semanticAssertion(page.truncation.first_omitted_source_index === page.raw_items.length,
        `page ${page.page} first omitted index is not the exact prefix boundary`);
    }
    semanticAssertion(page.text_layer_status === "partial" ? page.truncation.truncated : true, `page ${page.page} partial text status lacks truncation`);

    const lineById = new Map();
    const referencedItems = new Set();
    for (let index = 0; index < page.lines.length; index += 1) {
      const line = page.lines[index];
      semanticAssertion(line.reading_order_index === index, `line ${line.id} order mismatch`);
      semanticAssertion(line.id === `${pagePrefix}-l${String(line.source_first_index + 1).padStart(6, "0")}`, `line ${line.id} scope mismatch`);
      semanticAssertion(!documentIds.has(line.id), `duplicate ID ${line.id}`);
      semanticAssertion(line.item_ids.length > 0, `line ${line.id} is empty`);
      documentIds.add(line.id);
      lineById.set(line.id, line);
      const lineItems = line.item_ids.map(id => itemById.get(id));
      semanticAssertion(lineItems.every(Boolean), `line ${line.id} has a dangling item reference`);
      semanticAssertion(lineItems.every(item => item.geometry_valid && item.text_kind === "non_whitespace"), `line ${line.id} contains unsupported items`);
      semanticAssertion(lineItems.every(item => item.direction === line.direction), `line ${line.id} direction mismatch`);
      semanticAssertion(baselineInvariant(lineItems, 0.5), `line ${line.id} baseline spread mismatch`);
      semanticAssertion(Math.min(...lineItems.map(item => item.source_index)) === line.source_first_index, `line ${line.id} source index mismatch`);
      semanticAssertion(line.text === lineText(lineItems, line.direction), `line ${line.id} text mismatch`);
      const expectedLineBox = combineBounds(lineItems);
      semanticAssertion(sameRoundedNumber(line.x, expectedLineBox.x)
        && sameRoundedNumber(line.y, expectedLineBox.y)
        && sameRoundedNumber(line.width, expectedLineBox.width)
        && sameRoundedNumber(line.height, expectedLineBox.height), `line ${line.id} bounds mismatch`);
      for (const item of lineItems) {
        semanticAssertion(!referencedItems.has(item.id), `item ${item.id} appears in multiple lines`);
        semanticAssertion(item.line_id === line.id && item.column_index === line.column_index, `item ${item.id} line back-reference mismatch`);
        referencedItems.add(item.id);
      }
    }
    for (const item of page.raw_items) {
      semanticAssertion(Number.isInteger(item.reading_order_index)
        && item.reading_order_index >= 0
        && item.reading_order_index < page.raw_items.length, `item ${item.id} order is out of range`);
      semanticAssertion(item.line_id === null ? item.column_index === null : lineById.has(item.line_id), `item ${item.id} has a dangling line reference`);
      semanticAssertion(referencedItems.has(item.id) === (item.geometry_valid && item.text_kind === "non_whitespace"), `item ${item.id} line membership mismatch`);
    }
    semanticAssertion(new Set(page.raw_items.map(item => item.reading_order_index)).size === page.raw_items.length, `page ${page.page} item order is not a permutation`);
    const expectedItemOrder = [...page.lines.flatMap(line => line.item_ids), ...page.raw_items.filter(item => !referencedItems.has(item.id)).map(item => item.id)];
    for (let index = 0; index < expectedItemOrder.length; index += 1) {
      semanticAssertion(itemById.get(expectedItemOrder[index]).reading_order_index === index, `page ${page.page} item order reconstruction mismatch`);
    }

    const flattenedBlockLines = [];
    for (let index = 0; index < page.blocks.length; index += 1) {
      const block = page.blocks[index];
      semanticAssertion(block.id === `${pagePrefix}-b${String(index + 1).padStart(4, "0")}`, `block ${block.id} scope mismatch`);
      semanticAssertion(!documentIds.has(block.id), `duplicate ID ${block.id}`);
      semanticAssertion(block.line_ids.length > 0 && block.line_ids.every(id => lineById.has(id)), `block ${block.id} has dangling or empty line references`);
      const blockLines = block.line_ids.map(id => lineById.get(id));
      semanticAssertion(blockLines.every(line => line.column_index === block.column_index), `block ${block.id} column mismatch`);
      const expectedKind = block.column_index === -1
        ? "spanning_flow" : page.reading_order.column_count > 1 ? "column_flow" : "page_flow";
      semanticAssertion(block.kind === expectedKind, `block ${block.id} kind mismatch`);
      documentIds.add(block.id);
      flattenedBlockLines.push(...block.line_ids);
    }
    semanticAssertion(JSON.stringify(flattenedBlockLines) === JSON.stringify(page.lines.map(line => line.id)), `page ${page.page} block coverage mismatch`);
    semanticAssertion(page.flow_text === page.lines.map(line => line.text).join("\n"), `page ${page.page} flow text mismatch`);
    const expectedSpatial = page.lines.map(line => `[${line.id} x=${line.x} y=${line.y} w=${line.width} h=${line.height}] ${line.text}`).join("\n");
    semanticAssertion(page.spatial_text === expectedSpatial, `page ${page.page} spatial text mismatch`);
    const outputOmitted = page.truncation.reasons.includes("max_output_characters");
    semanticAssertion(outputOmitted
      ? page.reading_order.strategy === "unavailable_output_omitted" && page.lines.length === 0 && page.blocks.length === 0
      : page.reading_order.strategy !== "unavailable_output_omitted", `page ${page.page} reading-order availability mismatch`);
    if (page.reading_order.strategy === "two_column_left_to_right") {
      semanticAssertion(page.reading_order.column_count === 2 && page.lines.some(line => line.column_index === 0)
        && page.lines.some(line => line.column_index === 1), `page ${page.page} two-column evidence mismatch`);
    } else if (page.reading_order.strategy === "source_order_fallback") {
      semanticAssertion(page.reading_order.column_count === 1, `page ${page.page} source-order column count mismatch`);
    }
    const expectedTextLayerStatus = page.errors.some(error => error.stage === "page" || error.stage === "text")
      ? "failed" : page.counts.observed_items === 0 ? "empty" : page.truncation.truncated ? "partial" : "present";
    semanticAssertion(page.text_layer_status === expectedTextLayerStatus, `page ${page.page} text-layer status mismatch`);
    const expectedImageStatus = page.errors.some(error => error.stage === "page" || error.stage === "operators")
      ? "failed" : page.has_image_operations ? "detected" : "not_detected";
    semanticAssertion(page.image_detection_status === expectedImageStatus, `page ${page.page} image status mismatch`);
    const hasObservedText = page.counts.observed_non_whitespace_items > 0;
    const expectedModality = expectedImageStatus === "failed"
      ? "unknown"
      : hasObservedText && (page.has_image_operations || page.has_vector_paint_operations) ? "mixed-content-candidate"
        : hasObservedText ? "text-layer-candidate"
          : page.has_image_operations ? "image-only-candidate"
            : page.has_vector_paint_operations ? "vector-only-candidate" : "empty-candidate";
    semanticAssertion(page.modality_hint === expectedModality, `page ${page.page} modality mismatch`);
    const hasInvalidGeometry = page.raw_items.some(item => !item.geometry_valid);
    const hasRawGeometryGap = page.errors.some(error => error.code === "RAW_PAGE_GEOMETRY_UNAVAILABLE");
    const hasAnnotationError = page.errors.some(error => error.stage === "annotations");
    // Degraded link evidence, including a hit 200-link cap, is partial evidence.
    const hasDegradedLinks = page.link_annotations.status !== "available"
      || page.link_annotations.truncated === true;
    const expectedExtraction = expectedTextLayerStatus === "failed"
      ? "failed"
      : page.truncation.truncated || hasInvalidGeometry || hasRawGeometryGap || expectedImageStatus === "failed" || expectedModality !== "text-layer-candidate" || hasAnnotationError || hasDegradedLinks
        ? "partial" : "complete";
    semanticAssertion(page.extraction_status === expectedExtraction, `page ${page.page} extraction status mismatch`);
    semanticAssertion(page.needs_visual_inspection === (expectedExtraction !== "complete" || expectedModality !== "text-layer-candidate"), `page ${page.page} visual-inspection status mismatch`);
    if (page.extraction_status === "complete") {
      semanticAssertion(page.text_layer_status === "present"
        && page.image_detection_status !== "failed"
        && page.modality_hint === "text-layer-candidate"
        && !page.needs_visual_inspection
        && !page.truncation.truncated
        && page.errors.length === 0
        && page.link_annotations.status === "available"
        && page.link_annotations.truncated === false
        && page.raw_items.every(item => item.geometry_valid), `page ${page.page} complete status overclaims evidence`);
    }
    if (page.text_layer_status === "failed") semanticAssertion(page.extraction_status === "failed", `page ${page.page} failed text status mismatch`);
    semanticAssertion(page.errors.every(error => ["page", "text", "operators", "geometry", "annotations"].includes(error.stage)
      && typeof error.code === "string" && error.code.length > 0 && error.code.length <= 100
      && typeof error.message === "string" && error.message.length > 0 && error.message.length <= 500), `page ${page.page} invalid error record`);
  }

  const truncatedPages = payload.pages.filter(page => page.truncation.truncated);
  const omittedItems = truncatedPages.reduce((sum, page) => sum + page.truncation.omitted_items, 0);
  const omittedCharacters = truncatedPages.reduce((sum, page) => sum + page.truncation.omitted_characters, 0);
  const documentReasons = [...new Set(payload.pages.flatMap(page => page.truncation.reasons))];
  semanticAssertion(payload.truncation.truncated === (truncatedPages.length > 0), "document truncation flag mismatch");
  semanticAssertion(payload.truncation.omitted_items === omittedItems && payload.truncation.omitted_characters === omittedCharacters, "document omission counts mismatch");
  semanticAssertion(payload.truncation.first_omitted_page === (truncatedPages[0]?.page ?? null), "document first omitted page mismatch");
  semanticAssertion(payload.truncation.first_omitted_source_index === (truncatedPages[0]?.truncation.first_omitted_source_index ?? null), "document first omitted item mismatch");
  semanticAssertion(JSON.stringify(payload.truncation.reasons) === JSON.stringify(documentReasons), "document truncation reasons mismatch");
  const expectedStatus = payload.pages.every(page => page.extraction_status === "complete")
    ? "complete" : payload.pages.every(page => page.extraction_status === "failed") ? "failed" : "partial";
  semanticAssertion(payload.extraction_status === expectedStatus, "document extraction status mismatch");
  if (enforceOutputBudget) {
    semanticAssertion(JSON.stringify(payload).length <= payload.limits.max_output_characters, "serialized output exceeds its declared limit");
  }
  return payload;
}

function sourceEvidenceAssertion(condition, message) {
  if (!condition) throw new Error(`Invalid Extraction IR source evidence: ${message}`);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function replayOutputBudgetIndependently(seedPayload, maxOutputCharacters) {
  const replay = structuredClone(seedPayload);
  replay.id_scope.max_output_characters = maxOutputCharacters;
  replay.limits.max_output_characters = maxOutputCharacters;
  if (JSON.stringify(replay).length <= maxOutputCharacters) return replay;
  if (!replay.truncation.reasons.includes("max_output_characters")) replay.truncation.reasons.push("max_output_characters");
  for (let index = replay.pages.length - 1; index >= 0 && JSON.stringify(replay).length > maxOutputCharacters; index -= 1) {
    const page = replay.pages[index];
    if (page.raw_items.length === 0 && page.lines.length === 0 && page.flow_text.length === 0) continue;
    page.truncation.truncated = true;
    if (!page.truncation.reasons.includes("max_output_characters")) page.truncation.reasons.push("max_output_characters");
    page.truncation.first_omitted_source_index = page.raw_items[0]?.source_index ?? page.truncation.first_omitted_source_index;
    page.truncation.omitted_items = page.counts.observed_items;
    page.truncation.omitted_non_whitespace_items = page.counts.observed_non_whitespace_items;
    page.truncation.omitted_characters = page.counts.observed_characters;
    page.counts.returned_items = 0;
    page.counts.returned_non_whitespace_items = 0;
    page.counts.returned_characters = 0;
    page.raw_items = [];
    page.lines = [];
    page.blocks = [];
    page.link_annotations = { status: "unavailable", truncated: true, items: [] };
    page.flow_text = "";
    page.spatial_text = "";
    page.reading_order = {
      strategy: "unavailable_output_omitted",
      confidence: "not_calibrated",
      column_count: 0,
      limitations: ["Reading-order evidence was omitted to satisfy max_output_characters."],
    };
    if (page.text_layer_status === "present") page.text_layer_status = "partial";
    page.extraction_status = "partial";
    page.needs_visual_inspection = true;
    if (!page.limitations.includes("Page detail omitted to satisfy max_output_characters.")) {
      page.limitations.push("Page detail omitted to satisfy max_output_characters.");
    }
  }
  const truncatedPages = replay.pages.filter(page => page.truncation.truncated);
  replay.truncation.truncated = truncatedPages.length > 0;
  replay.truncation.reasons = [...new Set(replay.pages.flatMap(page => page.truncation.reasons))];
  replay.truncation.omitted_items = truncatedPages.reduce((sum, page) => sum + page.truncation.omitted_items, 0);
  replay.truncation.omitted_characters = truncatedPages.reduce((sum, page) => sum + page.truncation.omitted_characters, 0);
  replay.truncation.first_omitted_page = truncatedPages[0]?.page ?? null;
  replay.truncation.first_omitted_source_index = truncatedPages[0]?.truncation.first_omitted_source_index ?? null;
  sourceEvidenceAssertion(JSON.stringify(replay).length <= maxOutputCharacters, "independent output-budget replay exceeds its declared limit");
  replay.extraction_status = replay.pages.every(page => page.extraction_status === "failed") ? "failed" : "partial";
  return replay;
}

/**
 * Reparse the named source bytes and bind the Extraction IR's raw page and
 * TextItem evidence to that parse. Raw pdf-lib boxes/rotation are bound when a
 * second pdf-lib parse succeeds; otherwise their explicit unavailable/null
 * state is verified. validatePdfLayoutSemantics is deliberately
 * synchronous and proves only internal consistency (plus byte identity when
 * sourceBytes is supplied); callers claiming source-bound evidence must await
 * this validator instead.
 */
export async function validatePdfLayoutSourceEvidence(payload, {
  pdfjsLib,
  sourceBytes,
  password = null,
  deadlineAt = Date.now() + 20000,
  enforceOutputBudget = true,
} = {}) {
  validatePdfLayoutSemantics(payload, { sourceBytes, enforceOutputBudget });
  sourceEvidenceAssertion(pdfjsLib && typeof pdfjsLib.getDocument === "function", "PDF.js parser is required");
  sourceEvidenceAssertion(sourceBytes && Number.isSafeInteger(sourceBytes.length), "source bytes are required");
  sourceEvidenceAssertion(String(pdfjsLib.version || "unknown") === payload.parser.version, "parser version mismatch");

  let loadingTask = null;
  let document = null;
  let pdfLibPages = null;
  try {
    loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(sourceBytes),
      password: password || undefined,
      useWorkerFetch: false,
      isEvalSupported: false,
      ...PDFJS_DOCUMENT_ASSETS,
    });
    try {
      document = await withDeadline(loadingTask.promise, deadlineAt);
    } catch (error) {
      throw classifyLoadingError(error, pdfjsLib);
    }
    sourceEvidenceAssertion(document.numPages === payload.page_range.total_pages, "source page count mismatch");
    try {
      const pdfLibDocument = await withDeadline(PDFDocument.load(sourceBytes, { ignoreEncryption: true, updateMetadata: false }), deadlineAt);
      pdfLibPages = pdfLibDocument.getPages();
      if (pdfLibPages.length !== document.numPages) pdfLibPages = null;
    } catch (error) {
      if (isFatalParserResourceError(error)) throw error;
      pdfLibPages = null;
    }

    // Independent reference replay of the public retention contract. Keep this
    // intentionally small and separate from extractPdfLayout's product loop so
    // a shared implementation bug cannot validate itself.
    let replayRetainedItems = 0;
    let replayRetainedCharacters = 0;
    const sourceImageOps = imageOperationSet(pdfjsLib);
    const sourceVectorOps = vectorOperationSet(pdfjsLib);
    for (const outputPage of payload.pages) {
      let sourcePage = null;
      try {
        let sourceViewport = null;
        let sourcePageError = null;
        try {
          sourcePage = await withDeadline(document.getPage(outputPage.page), deadlineAt);
          sourceViewport = sourcePage.getViewport({ scale: 1 });
        } catch (error) {
          if (isFatalParserResourceError(error)) throw error;
          sourcePageError = error;
        }
        // Independently re-derive link annotation evidence from the reparsed
        // source. Annotations enter the IR as a trust-boundary crossing, so
        // they are re-read here rather than accepted from the product loop.
        let replayLinks = UNAVAILABLE_LINK_ANNOTATIONS;
        let replayLinksRead = false;
        if (sourcePage !== null && typeof sourcePage.getAnnotations === "function") {
          try {
            const sourceAnnotations = await withDeadline(
              sourcePage.getAnnotations({ intent: "display" }),
              deadlineAt,
            );
            replayLinks = collectLinkAnnotations(
              sourceAnnotations,
              sourceViewport?.transform ?? null,
              outputPage.page,
            );
            replayLinksRead = true;
          } catch (error) {
            if (isFatalParserResourceError(error) || error?.code === "LAYOUT_DEADLINE") throw error;
            replayLinks = UNAVAILABLE_LINK_ANNOTATIONS;
          }
        }
        const sourceGeometry = pageGeometry(
          pdfLibPages?.[outputPage.page - 1] ?? null,
          sourcePage,
          sourceViewport,
          outputPage.page,
        );
        for (const field of [
          "pdfjs_view",
          "user_unit",
          "display_rotation",
          "display_width",
          "display_height",
          "viewport_transform",
        ]) {
          sourceEvidenceAssertion(
            sameJson(outputPage.geometry[field], sourceGeometry[field]),
            `page ${outputPage.page} ${field} differs from reparsed source`,
          );
        }
        if (pdfLibPages) {
          for (const field of ["media_box", "crop_box", "raw_pdf_rotation", "rotation_matches_raw"]) {
            sourceEvidenceAssertion(
              sameJson(outputPage.geometry[field], sourceGeometry[field]),
              `page ${outputPage.page} ${field} differs from reparsed source`,
            );
          }
        } else {
          sourceEvidenceAssertion(
            outputPage.geometry.media_box === null
              && outputPage.geometry.crop_box === null
              && outputPage.geometry.raw_pdf_rotation === null
              && outputPage.geometry.rotation_matches_raw === null
              && outputPage.errors.some(error => error.code === "RAW_PAGE_GEOMETRY_UNAVAILABLE"),
            `page ${outputPage.page} raw page geometry is unverified but output contains claims`,
          );
        }
        if (sourcePageError !== null) {
          const expectedError = errorRecord("page", sourcePageError);
          const expectedErrors = [];
          if (!pdfLibPages) {
            expectedErrors.push({
              stage: "geometry",
              code: "RAW_PAGE_GEOMETRY_UNAVAILABLE",
              message: "Raw page-box enrichment was unavailable; PDF.js display geometry remains authoritative.",
            });
          }
          expectedErrors.push(expectedError);
          sourceEvidenceAssertion(
            sameJson(outputPage.errors, expectedErrors)
              && outputPage.text_layer_status === "failed"
              && outputPage.image_detection_status === "failed"
              && outputPage.extraction_status === "failed"
              && outputPage.modality_hint === "unknown"
              && outputPage.needs_visual_inspection === true
              && sameJson(outputPage.counts, {
                observed_items: 0,
                returned_items: 0,
                observed_non_whitespace_items: 0,
                returned_non_whitespace_items: 0,
                observed_characters: 0,
                returned_characters: 0,
              })
              && sameJson(outputPage.truncation, {
                truncated: false,
                reasons: [],
                omitted_items: 0,
                omitted_non_whitespace_items: 0,
                omitted_characters: 0,
                first_omitted_source_index: null,
              })
              && outputPage.raw_items.length === 0
              && outputPage.lines.length === 0
              && outputPage.blocks.length === 0
              && outputPage.flow_text === ""
              && outputPage.spatial_text === ""
              && sameJson(outputPage.reading_order, {
                strategy: "source_order_fallback",
                confidence: "not_calibrated",
                column_count: 1,
                limitations: [
                  "Column evidence was insufficient or ambiguous, so source item order was retained.",
                  "Source order is parser order and is not proof of intended or visible reading order.",
                ],
              })
              && outputPage.has_image_operations === null
              && outputPage.has_vector_paint_operations === null,
            `page ${outputPage.page} ordinary page failure differs from reparsed source`,
          );
          continue;
        }

        // Link-annotation evidence. Placed after the replay's own page-failure
        // handling so a genuine page or deadline failure is reported on its own
        // terms rather than as a link mismatch.
        if (outputPage.link_annotations.status === "available") {
          // An available claim must be authenticated by a successful
          // independent read. A missing getAnnotations or a failed replay read
          // can never authenticate link evidence.
          sourceEvidenceAssertion(
            replayLinksRead,
            `page ${outputPage.page} claims available link evidence that was not independently reparsed`,
          );
          sourceEvidenceAssertion(
            JSON.stringify(outputPage.link_annotations) === JSON.stringify(replayLinks),
            `page ${outputPage.page} link annotations differ from independently reparsed source`,
          );
        } else {
          const linkBudgetOmitted = outputPage.truncation.reasons.includes("max_output_characters");
          const linkReadFailed = outputPage.errors.some(
            error => error.stage === "annotations" || error.stage === "page",
          );
          sourceEvidenceAssertion(
            linkBudgetOmitted || linkReadFailed,
            `page ${outputPage.page} reports unavailable link evidence without supporting evidence`,
          );
          sourceEvidenceAssertion(
            outputPage.link_annotations.items.length === 0
              && (!linkBudgetOmitted || outputPage.link_annotations.truncated === true),
            `page ${outputPage.page} unavailable link evidence is malformed`,
          );
        }

        let textContent = null;
        try {
          textContent = await withDeadline(sourcePage.getTextContent({ includeMarkedContent: false, disableNormalization: false }), deadlineAt);
        } catch (error) {
          if (isFatalParserResourceError(error)) throw error;
          const expectedError = errorRecord("text", error);
          sourceEvidenceAssertion(
            outputPage.text_layer_status === "failed"
              && outputPage.raw_items.length === 0
              && outputPage.errors.some(outputError => sameJson(outputError, expectedError)),
            `page ${outputPage.page} source text parse failed but output claims text evidence`,
          );
        }
        const sourceEntries = (textContent?.items ?? [])
          .filter(item => typeof item?.str === "string")
          .map((item, sourceIndex) => [sourceIndex, item]);
        sourceEvidenceAssertion(outputPage.counts.observed_items === sourceEntries.length, `page ${outputPage.page} observed item count differs from reparsed source`);
        sourceEvidenceAssertion(
          outputPage.counts.observed_non_whitespace_items === sourceEntries.filter(([, item]) => item.str.trim().length > 0).length,
          `page ${outputPage.page} observed non-whitespace count differs from reparsed source`,
        );
        sourceEvidenceAssertion(
          outputPage.counts.observed_characters === sourceEntries.reduce((sum, [, item]) => sum + item.str.length, 0),
          `page ${outputPage.page} observed character count differs from reparsed source`,
        );

        let replayPrefixLength = 0;
        let replayReason = null;
        for (const [, sourceItem] of sourceEntries) {
          const exceedsItems = replayRetainedItems >= payload.limits.max_items;
          const exceedsCharacters = replayRetainedCharacters + sourceItem.str.length > payload.limits.max_characters;
          if (replayReason !== null || exceedsItems || exceedsCharacters) {
            if (replayReason === null) replayReason = exceedsItems ? "max_items" : "max_characters";
            continue;
          }
          replayPrefixLength += 1;
          replayRetainedItems += 1;
          replayRetainedCharacters += sourceItem.str.length;
        }
        const outputOmitted = outputPage.truncation.reasons.includes("max_output_characters");
        const expectedReturnedEntries = outputOmitted ? [] : sourceEntries.slice(0, replayPrefixLength);
        const expectedOmittedEntries = outputOmitted ? sourceEntries : sourceEntries.slice(replayPrefixLength);
        const expectedReasons = [
          ...(replayReason === null ? [] : [replayReason]),
          ...(outputOmitted ? ["max_output_characters"] : []),
        ];
        sourceEvidenceAssertion(
          sameJson(outputPage.raw_items.map(item => item.source_index), expectedReturnedEntries.map(([sourceIndex]) => sourceIndex)),
          `page ${outputPage.page} retained items differ from independently replayed limits`,
        );
        sourceEvidenceAssertion(
          sameJson(outputPage.truncation.reasons, expectedReasons),
          `page ${outputPage.page} truncation reason differs from independently replayed limits`,
        );
        sourceEvidenceAssertion(
          outputPage.truncation.omitted_items === expectedOmittedEntries.length
            && outputPage.truncation.omitted_non_whitespace_items === expectedOmittedEntries.filter(([, item]) => item.str.trim().length > 0).length
            && outputPage.truncation.omitted_characters === expectedOmittedEntries.reduce((sum, [, item]) => sum + item.str.length, 0),
          `page ${outputPage.page} omission counts differ from independently replayed limits`,
        );
        sourceEvidenceAssertion(
          outputPage.truncation.first_omitted_source_index === (expectedOmittedEntries.length > 0 ? expectedReturnedEntries.length : null),
          `page ${outputPage.page} first omitted index differs from independently replayed limits`,
        );

        const sourceByIndex = new Map(sourceEntries);
        const fontIds = new Map();
        for (const outputItem of outputPage.raw_items) {
          const sourceItem = sourceByIndex.get(outputItem.source_index);
          sourceEvidenceAssertion(sourceItem, `item ${outputItem.id} source index is absent from reparsed source`);
          const sourceStyle = textContent?.styles?.[sourceItem.fontName] ?? {};
          if (typeof sourceItem.fontName === "string" && !fontIds.has(sourceItem.fontName)) {
            fontIds.set(sourceItem.fontName, `font-${String(fontIds.size + 1).padStart(4, "0")}`);
          }
          const sourceFont = {
            family: typeof sourceStyle.fontFamily === "string" ? sourceStyle.fontFamily : null,
            ascent: finiteOrNull(sourceStyle.ascent),
            descent: finiteOrNull(sourceStyle.descent),
            vertical: sourceStyle.vertical === true,
          };
          const comparisons = [
            ["text", outputItem.text, sourceItem.str],
            ["has_eol", outputItem.has_eol, sourceItem.hasEOL === true],
            ["raw_transform", outputItem.raw_transform, safeTransform(sourceItem.transform)],
            ["raw_width", outputItem.raw_width, finiteOrNull(sourceItem.width)],
            ["raw_height", outputItem.raw_height, finiteOrNull(sourceItem.height)],
            ["font_name", outputItem.font_name, typeof sourceItem.fontName === "string" ? fontIds.get(sourceItem.fontName) : null],
            ["font", outputItem.font, sourceFont],
            ["direction", outputItem.direction, direction(sourceItem.dir)],
          ];
          for (const [field, actual, expected] of comparisons) {
            sourceEvidenceAssertion(sameJson(actual, expected), `item ${outputItem.id} ${field} differs from reparsed source`);
          }
        }

        let sourceOperators = null;
        let sourceOperatorError = null;
        try {
          sourceOperators = await withDeadline(sourcePage.getOperatorList(), deadlineAt);
        } catch (error) {
          if (isFatalParserResourceError(error)) throw error;
          sourceOperatorError = error;
        }
        if (sourceOperatorError === null) {
          const sourceHasImageOperations = sourceOperators.fnArray.some(operation => sourceImageOps.has(operation));
          const sourceHasVectorOperations = sourceOperators.fnArray.some(operation => sourceVectorOps.has(operation));
          sourceEvidenceAssertion(
            outputPage.has_image_operations === sourceHasImageOperations
              && outputPage.has_vector_paint_operations === sourceHasVectorOperations
              && !outputPage.errors.some(error => error.stage === "operators"),
            `page ${outputPage.page} operator evidence differs from reparsed source`,
          );
        } else {
          const expectedError = errorRecord("operators", sourceOperatorError);
          sourceEvidenceAssertion(
            outputPage.has_image_operations === null
              && outputPage.has_vector_paint_operations === null
              && outputPage.errors.some(outputError => sameJson(outputError, expectedError)),
            `page ${outputPage.page} source operator parse failed but output claims operator evidence`,
          );
        }
      } finally {
        sourcePage?.cleanup();
      }
    }
    const sourceTruncatedPages = payload.pages.filter(page => page.truncation.truncated);
    const sourceDocumentTruncation = {
      truncated: sourceTruncatedPages.length > 0,
      reasons: [...new Set(payload.pages.flatMap(page => page.truncation.reasons))],
      omitted_items: sourceTruncatedPages.reduce((sum, page) => sum + page.truncation.omitted_items, 0),
      omitted_characters: sourceTruncatedPages.reduce((sum, page) => sum + page.truncation.omitted_characters, 0),
      first_omitted_page: sourceTruncatedPages[0]?.page ?? null,
      first_omitted_source_index: sourceTruncatedPages[0]?.truncation.first_omitted_source_index ?? null,
    };
    sourceEvidenceAssertion(sameJson(payload.truncation, sourceDocumentTruncation), "document truncation differs from source-verified page records");
    const sourceDocumentStatus = payload.pages.every(page => page.extraction_status === "complete")
      ? "complete" : payload.pages.every(page => page.extraction_status === "failed") ? "failed" : "partial";
    sourceEvidenceAssertion(payload.extraction_status === sourceDocumentStatus, "document status differs from source-verified page records");
    if (!enforceOutputBudget) {
      sourceEvidenceAssertion(
        payload.pages.every(page => !page.truncation.reasons.includes("max_output_characters")),
        "internal Markdown evidence contains a public output-budget omission",
      );
    } else if (payload.pages.some(page => page.truncation.reasons.includes("max_output_characters"))) {
      const replaySeed = await extractPdfLayout({
        pdfjsLib,
        pdfBytes: sourceBytes,
        sourcePath: payload.source.pdf_path,
        sourceFileName: payload.source.file_name,
        sourceSha256: payload.source.sha256,
        sourceSizeBytes: payload.source.size_bytes,
        password,
        requestedStartPage: payload.page_range.requested_start_page,
        requestedEndPage: payload.page_range.requested_end_page,
        maxItems: payload.limits.max_items,
        maxCharacters: payload.limits.max_characters,
        maxOutputCharacters: 200000,
        deadlineMs: payload.limits.deadline_ms,
        operationDeadlineAt: deadlineAt,
        sourceEvidenceValidationToken: INTERNAL_SOURCE_REPLAY,
      });
      const replayedBudget = replayOutputBudgetIndependently(replaySeed, payload.limits.max_output_characters);
      sourceEvidenceAssertion(sameJson(payload, replayedBudget), "output omission differs from independent budget replay");
    }
    return payload;
  } finally {
    await document?.destroy().catch(() => {});
    await loadingTask?.destroy?.().catch(() => {});
  }
}

function horizontalGeometryIsAmbiguous(item) {
  if (item.direction === "ttb") return true;
  if (!item.geometry_valid || !item.quad || item.raw_width === 0) return false;
  const start = item.quad[0];
  const end = item.quad[1];
  const magnitude = Math.hypot(end.x - start.x, end.y - start.y);
  return magnitude > 0 && Math.abs((end.y - start.y) / magnitude) > 0.05;
}

export async function extractPdfLayout({
  pdfjsLib,
  pdfBytes,
  sourcePath,
  sourceFileName,
  sourceSha256,
  sourceSizeBytes = pdfBytes.length,
  password = null,
  requestedStartPage = 1,
  requestedEndPage = requestedStartPage,
  maxItems = 1000,
  maxCharacters = 50000,
  maxOutputCharacters = 50000,
  deadlineMs = 20000,
  operationDeadlineAt = null,
  sourceEvidenceValidationToken = null,
  outputProjectionToken = null,
}) {
  const deadlineAt = operationDeadlineAt ?? Date.now() + deadlineMs;
  let loadingTask = null;
  let document = null;
  try {
    loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(pdfBytes),
      password: password || undefined,
      useWorkerFetch: false,
      isEvalSupported: false,
      ...PDFJS_DOCUMENT_ASSETS,
    });
    try {
      document = await withDeadline(loadingTask.promise, deadlineAt);
    } catch (error) {
      throw classifyLoadingError(error, pdfjsLib);
    }
    let pdfLibPages = null;
    try {
      const pdfLibDocument = await withDeadline(PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false }), deadlineAt);
      pdfLibPages = pdfLibDocument.getPages();
    } catch (error) {
      if (isFatalParserResourceError(error)) throw error;
      pdfLibPages = null;
    }
    const totalPages = document.numPages;
    if (pdfLibPages && pdfLibPages.length !== totalPages) pdfLibPages = null;
    if (requestedStartPage < 1 || requestedStartPage > totalPages) {
      throw new Error(`start_page ${requestedStartPage} is out of range (1-${totalPages}).`);
    }
    if (requestedEndPage < requestedStartPage || requestedEndPage > totalPages) {
      throw new Error(`end_page ${requestedEndPage} is out of range (${requestedStartPage}-${totalPages}).`);
    }

    const pages = [];
    let retainedItemCount = 0;
    let retainedCharacterCount = 0;
    const imageOps = imageOperationSet(pdfjsLib);
    const vectorOps = vectorOperationSet(pdfjsLib);

    for (let pageNumber = requestedStartPage; pageNumber <= requestedEndPage; pageNumber += 1) {
      const errors = [];
      const limitations = [];
      if (!pdfLibPages) {
        errors.push({
          stage: "geometry",
          code: "RAW_PAGE_GEOMETRY_UNAVAILABLE",
          message: "Raw page-box enrichment was unavailable; PDF.js display geometry remains authoritative.",
        });
        limitations.push("Raw MediaBox, CropBox, and PDF rotation enrichment was unavailable for this page.");
      }
      let textContent = null;
      let hasImageOperations = null;
      let hasVectorPaintOperations = null;
      let pdfjsPage = null;
      let viewport = null;
      let linkAnnotations = UNAVAILABLE_LINK_ANNOTATIONS;
      try {
        pdfjsPage = await withDeadline(document.getPage(pageNumber), deadlineAt);
        viewport = pdfjsPage.getViewport({ scale: 1 });
        try {
          if (typeof pdfjsPage.getAnnotations !== "function") {
            throw new Error("Parser does not expose annotation evidence.");
          }
          const annotations = await withDeadline(
            pdfjsPage.getAnnotations({ intent: "display" }),
            deadlineAt,
          );
          linkAnnotations = collectLinkAnnotations(
            annotations,
            viewport?.transform ?? null,
            pageNumber,
          );
        } catch (error) {
          if (isFatalParserResourceError(error)) throw error;
          errors.push(errorRecord("annotations", error));
        }
        try {
          textContent = await withDeadline(pdfjsPage.getTextContent({ includeMarkedContent: false, disableNormalization: false }), deadlineAt);
        } catch (error) {
          if (isFatalParserResourceError(error)) throw error;
          errors.push(errorRecord("text", error));
        }
        try {
          const operators = await withDeadline(pdfjsPage.getOperatorList(), deadlineAt);
          hasImageOperations = operators.fnArray.some(operation => imageOps.has(operation));
          hasVectorPaintOperations = operators.fnArray.some(operation => vectorOps.has(operation));
        } catch (error) {
          if (isFatalParserResourceError(error)) throw error;
          errors.push(errorRecord("operators", error));
        }
      } catch (error) {
        if (isFatalParserResourceError(error)) throw error;
        errors.push(errorRecord("page", error));
      } finally {
        pdfjsPage?.cleanup();
      }

      const geometry = pageGeometry(pdfLibPages?.[pageNumber - 1] ?? null, pdfjsPage, viewport, pageNumber);
      const textItemEntries = (textContent?.items ?? [])
        .filter(item => typeof item?.str === "string")
        .map((item, sourceIndex) => [sourceIndex, item]);
      const observedCharacters = textItemEntries.reduce((sum, [, item]) => sum + item.str.length, 0);
      const rawItems = [];
      const pageReasons = [];
      let firstOmittedSourceIndex = null;
      let hardSegment = 0;
      let invalidGeometry = false;
      const fontIds = new Map();

      for (const [sourceIndex, item] of textItemEntries) {
        const retentionAlreadyTruncated = firstOmittedSourceIndex !== null;
        const exceedsItems = retainedItemCount >= maxItems;
        const exceedsCharacters = retainedCharacterCount + item.str.length > maxCharacters;
        if (retentionAlreadyTruncated || exceedsItems || exceedsCharacters) {
          if (firstOmittedSourceIndex === null) firstOmittedSourceIndex = sourceIndex;
          if (!retentionAlreadyTruncated) {
            const reason = exceedsItems ? "max_items" : "max_characters";
            if (!pageReasons.includes(reason)) pageReasons.push(reason);
          }
          if (item.hasEOL) hardSegment += 1;
          continue;
        }
        const style = textContent?.styles?.[item.fontName] ?? {};
        const rawTransform = safeTransform(item.transform);
        const rawWidth = finiteOrNull(item.width);
        const rawHeight = finiteOrNull(item.height);
        const font = {
          family: typeof style.fontFamily === "string" ? style.fontFamily : null,
          ascent: finiteOrNull(style.ascent),
          descent: finiteOrNull(style.descent),
          vertical: style.vertical === true,
        };
        const geometryItem = computeItemGeometry(
          geometry.viewport_transform ?? [],
          rawTransform,
          rawWidth,
          rawHeight,
          font,
        );
        if (typeof item.fontName === "string" && !fontIds.has(item.fontName)) {
          fontIds.set(item.fontName, `font-${String(fontIds.size + 1).padStart(4, "0")}`);
        }
        if (!geometryItem.valid) {
          invalidGeometry = true;
          errors.push({ stage: "geometry", code: "NONFINITE_TEXT_GEOMETRY", message: `Text item ${sourceIndex} has non-finite geometry.` });
        }
        const rawItem = {
          id: `p${String(pageNumber).padStart(4, "0")}-i${String(sourceIndex + 1).padStart(6, "0")}`,
          source_index: sourceIndex,
          text: item.str,
          is_whitespace: item.str.trim().length === 0,
          text_kind: item.str.length === 0 ? "empty" : item.str.trim().length === 0 ? "whitespace" : "non_whitespace",
          has_eol: item.hasEOL === true,
          raw_transform: rawTransform,
          raw_width: rawWidth,
          raw_height: rawHeight,
          font_name: typeof item.fontName === "string" ? fontIds.get(item.fontName) : null,
          font,
          geometry_kind: "pdfjs_text_run_advance_box",
          geometry_valid: geometryItem.valid,
          bbox_status: !geometryItem.valid ? "invalid" : geometryItem.bbox.width === 0 || geometryItem.bbox.height === 0 ? "degenerate" : "valid",
          geometry_provenance: {
            formula: "pdfjs_text_item_style_metric_advance_box_approximation",
            quad_order: "anchor_top_terminal_top_anchor_bottom_terminal_bottom",
            advance_source: geometryItem.advance_source,
            ascent_source: geometryItem.ascent_source,
            ascent_ratio: geometryItem.ascent_ratio,
          },
          quad: geometryItem.quad,
          bbox: geometryItem.bbox,
          x: geometryItem.bbox?.x ?? null,
          y: geometryItem.bbox?.y ?? null,
          width: geometryItem.bbox?.width ?? null,
          height: geometryItem.bbox?.height ?? null,
          line_height: geometryItem.line_height,
          direction: direction(item.dir),
          reading_order_index: -1,
          line_id: null,
          column_index: null,
        };
        Object.defineProperty(rawItem, "hard_segment", { value: hardSegment, enumerable: false });
        rawItems.push(rawItem);
        retainedItemCount += 1;
        retainedCharacterCount += item.str.length;
        if (item.hasEOL) hardSegment += 1;
      }

      const lineCandidates = rawItems.filter(item => item.geometry_valid && !item.is_whitespace);
      const forceSourceOrder = invalidGeometry || lineCandidates.some(horizontalGeometryIsAmbiguous);
      const sourceLines = sourceOrderLines(rawItems, pageNumber);
      const grouped = groupLines(lineCandidates, pageNumber);
      const ordered = readingOrder(grouped, geometry.display_width ?? geometry.crop_box.width, {
        sourceLines,
        forceSourceOrder,
        fallbackReason: invalidGeometry
          ? "At least one retained item had invalid geometry, so source order was retained."
          : "Vertical or skewed text made geometric order ambiguous, so source order was retained.",
      });
      const itemById = new Map(rawItems.map(item => [item.id, item]));
      const orderedIds = [];
      ordered.lines.forEach((line, lineIndex) => {
        line.reading_order_index = lineIndex;
        for (const itemId of line.item_ids) {
          const item = itemById.get(itemId);
          item.line_id = line.id;
          item.column_index = line.column_index;
          orderedIds.push(itemId);
        }
      });
      const orderedIdSet = new Set(orderedIds);
      for (const item of rawItems) {
        if (!orderedIdSet.has(item.id)) {
          orderedIds.push(item.id);
          orderedIdSet.add(item.id);
        }
      }
      const orderById = new Map(orderedIds.map((id, index) => [id, index]));
      for (const item of rawItems) item.reading_order_index = orderById.get(item.id);

      const textLayerStatus = errors.some(error => error.stage === "page" || error.stage === "text")
        ? "failed" : textItemEntries.length === 0 ? "empty" : firstOmittedSourceIndex !== null ? "partial" : "present";
      const imageDetectionStatus = errors.some(error => error.stage === "page" || error.stage === "operators")
        ? "failed" : hasImageOperations ? "detected" : "not_detected";
      const hasText = textItemEntries.some(([, item]) => item.str.trim().length > 0);
      let modalityHint = "unknown";
      if (imageDetectionStatus !== "failed") {
        if (hasText && (hasImageOperations || hasVectorPaintOperations)) modalityHint = "mixed-content-candidate";
        else if (hasText) modalityHint = "text-layer-candidate";
        else if (hasImageOperations) modalityHint = "image-only-candidate";
        else if (hasVectorPaintOperations) modalityHint = "vector-only-candidate";
        else modalityHint = "empty-candidate";
      }
      const pageTruncated = firstOmittedSourceIndex !== null;
      let extractionStatus = "complete";
      if (textLayerStatus === "failed") extractionStatus = "failed";
      else if (pageTruncated || invalidGeometry || !pdfLibPages || imageDetectionStatus === "failed" || modalityHint !== "text-layer-candidate" || errors.some(error => error.stage === "annotations") || linkAnnotations.truncated === true) extractionStatus = "partial";
      const needsVisualInspection = extractionStatus !== "complete" || modalityHint !== "text-layer-candidate";
      if (hasImageOperations) limitations.push("Image paint operations were detected, but no image was rendered or OCRed; this is not raster-content proof.");
      if (hasVectorPaintOperations) limitations.push("Vector paint operations were detected but not interpreted.");
      if (imageDetectionStatus === "failed") limitations.push("Image and vector gap detection failed for this page.");
      if (pageTruncated) limitations.push("Page content is incomplete because a caller-supplied retention limit was reached.");
      if (invalidGeometry) limitations.push("At least one retained text item had non-finite geometry and was excluded from geometric reconstruction.");
      limitations.push("The PDF text layer can contain hidden, clipped, duplicated, or OCR-overlay text and is not proof of visible content.");

      const flowText = ordered.lines.map(line => line.text).join("\n");
      pages.push({
        id: `p${String(pageNumber).padStart(4, "0")}`,
        page: pageNumber,
        text_layer_status: textLayerStatus,
        image_detection_status: imageDetectionStatus,
        modality_hint: modalityHint,
        extraction_status: extractionStatus,
        needs_visual_inspection: needsVisualInspection,
        geometry,
        has_image_operations: hasImageOperations,
        has_vector_paint_operations: hasVectorPaintOperations,
        link_annotations: linkAnnotations,
        raw_items: rawItems,
        lines: ordered.lines,
        blocks: buildBlocks(ordered.lines, pageNumber, ordered.column_count),
        reading_order: {
          strategy: ordered.strategy,
          confidence: ordered.confidence,
          column_count: ordered.column_count,
          limitations: ordered.limitations,
        },
        flow_text: flowText,
        spatial_text: ordered.lines.map(line => `[${line.id} x=${line.x} y=${line.y} w=${line.width} h=${line.height}] ${line.text}`).join("\n"),
        counts: {
          observed_items: textItemEntries.length,
          returned_items: rawItems.length,
          observed_non_whitespace_items: textItemEntries.filter(([, item]) => item.str.trim().length > 0).length,
          returned_non_whitespace_items: rawItems.filter(item => item.text_kind === "non_whitespace").length,
          observed_characters: observedCharacters,
          returned_characters: rawItems.reduce((sum, item) => sum + item.text.length, 0),
        },
        truncation: {
          truncated: pageTruncated,
          reasons: pageReasons,
          omitted_items: textItemEntries.length - rawItems.length,
          omitted_non_whitespace_items: textItemEntries.filter(([, item]) => item.str.trim().length > 0).length
            - rawItems.filter(item => item.text_kind === "non_whitespace").length,
          omitted_characters: observedCharacters - rawItems.reduce((sum, item) => sum + item.text.length, 0),
          first_omitted_source_index: firstOmittedSourceIndex,
        },
        errors,
        limitations,
      });
    }

    const payload = {
      ir: { name: IR_NAME, version: IR_VERSION },
      parser: { name: "pdfjs-dist", version: String(pdfjsLib.version || "unknown") },
      source: { pdf_path: sourcePath, file_name: sourceFileName, sha256: sourceSha256, size_bytes: sourceSizeBytes },
      id_scope: {
        kind: "source_parser_ir_options",
        source_sha256: sourceSha256,
        parser_version: String(pdfjsLib.version || "unknown"),
        ir_version: IR_VERSION,
        requested_start_page: requestedStartPage,
        requested_end_page: requestedEndPage,
        max_items: maxItems,
        max_characters: maxCharacters,
        max_output_characters: maxOutputCharacters,
      },
      page_range: {
        requested_start_page: requestedStartPage,
        requested_end_page: requestedEndPage,
        start_page: requestedStartPage,
        end_page: requestedEndPage,
        total_pages: totalPages,
      },
      extraction_status: pages.every(page => page.extraction_status === "complete")
        ? "complete" : pages.every(page => page.extraction_status === "failed") ? "failed" : "partial",
      pages,
      limits: { max_items: maxItems, max_characters: maxCharacters, max_output_characters: maxOutputCharacters, deadline_ms: deadlineMs },
      truncation: {
        truncated: false,
        reasons: [...new Set(pages.flatMap(page => page.truncation.reasons))],
        omitted_items: 0,
        omitted_characters: 0,
        first_omitted_page: null,
        first_omitted_source_index: null,
      },
      limitations: [
        "Local PDF.js text-layer geometry only; no rendering, OCR, table inference, or arbitrary schema extraction is performed.",
        "PDF.js display-viewport coordinates are not interchangeable with render_pdf_region or signing coordinates; do not pass these boxes to those tools.",
        "Text-run quads are a deterministic PDF.js TextItem/style-metric approximation, not DOM TextLayer or glyph ink bounds.",
        "Text-layer content can be hidden, clipped, duplicated, or an OCR overlay and is not proof of visible page content.",
        "Reading order is deterministic conservative reconstruction, not tagged-PDF or intended semantic order.",
      ],
    };
    recomputeDocumentTruncation(payload);
    const internalMarkdownProjection = outputProjectionToken === INTERNAL_MARKDOWN_PROJECTION;
    const projectedPayload = internalMarkdownProjection
      ? payload
      : markOutputBudget(payload, maxOutputCharacters);
    const validatedPayload = validatePdfLayoutSemantics(projectedPayload, {
      sourceBytes: pdfBytes,
      enforceOutputBudget: !internalMarkdownProjection,
    });
    if (sourceEvidenceValidationToken === INTERNAL_SOURCE_REPLAY) return validatedPayload;
    return await validatePdfLayoutSourceEvidence(validatedPayload, {
      pdfjsLib,
      sourceBytes: pdfBytes,
      password,
      deadlineAt,
      enforceOutputBudget: !internalMarkdownProjection,
    });
  } finally {
    await document?.destroy().catch(() => {});
    await loadingTask?.destroy?.().catch(() => {});
  }
}

/**
 * Produce source-validated bounded layout evidence for the deterministic local
 * Markdown renderer before the public read_pdf_layout response projection can
 * omit whole-page detail. This remains bounded by the same page, item,
 * character, and deadline limits. It is not an MCP response payload and must
 * be reduced by the Markdown renderer before returning to a client.
 */
export async function extractPdfLayoutForMarkdown(options) {
  return extractPdfLayout({
    ...options,
    outputProjectionToken: INTERNAL_MARKDOWN_PROJECTION,
  });
}

export const EXTRACTION_IR_IDENTITY = Object.freeze({ name: IR_NAME, version: IR_VERSION });
