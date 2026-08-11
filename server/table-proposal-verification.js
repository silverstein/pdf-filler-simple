import { createHash, timingSafeEqual } from "node:crypto";
import { renderVerifiedTableMarkdown } from "./markdown-conversion.js";

export const TABLE_PROPOSAL_VERIFIER = Object.freeze({
  name: "pdf-tools.table-proposal-verifier",
  version: "0.3.0",
});

export const TABLE_PROPOSAL_CLAIM_BOUNDARY =
  "Accepted cell content is constructed only from reparsed source text items, and the proposed grid is well formed and consistent with all source-replayed ruling geometry available. GFM output is a syntax-escaped rectangular projection; row and column spans remain authoritative only in the structured cells. Consistency is not proof of unique topology; ambiguous or unsupported geometry is rejected.";

export const TABLE_PROPOSAL_REASON_CODES = Object.freeze([
  "TABLE_PROPOSAL_TOKEN_MISMATCH",
  "TABLE_PROPOSAL_REGION_NOT_FOUND",
  "TABLE_PROPOSAL_REGION_TRUNCATED",
  "TABLE_PROPOSAL_REGION_UNSUPPORTED",
  "TABLE_PROPOSAL_CELL_INVALID",
  "TABLE_PROPOSAL_ITEM_UNKNOWN",
  "TABLE_PROPOSAL_ITEM_DUPLICATED",
  "TABLE_PROPOSAL_ITEM_MISSING",
  "TABLE_PROPOSAL_LINE_STRADDLE",
  "TABLE_PROPOSAL_ROW_ORDER",
  "TABLE_PROPOSAL_COLUMN_ORDER",
  "TABLE_PROPOSAL_HEADER_UNSUPPORTED",
  "TABLE_PROPOSAL_GRID_INVALID",
  "TABLE_PROPOSAL_CUTS_INCONSISTENT",
  "TABLE_PROPOSAL_RULING_CONFLICT",
  "TABLE_PROPOSAL_TOPOLOGY_AMBIGUOUS",
]);

export const MAX_TABLE_PROPOSAL_CELLS = 1000;
export const MAX_TABLE_PROPOSAL_ITEM_IDS_PER_CELL = 400;
export const MAX_TABLE_PROPOSAL_GRID_SLOTS = 10_000;

const RULING_TOLERANCE = 1;

const CHECK_NAMES = Object.freeze([
  "token_binding",
  "region_evidence",
  "cell_input",
  "coverage",
  "one_cell",
  "row_non_straddle",
  "row_order",
  "column_order",
  "rectangular_grid",
  "cut_line_consistency",
  "ruled_line_agreement",
  "topology_ambiguity",
  "header_evidence",
  "content_source",
]);

function assertion(condition, message) {
  if (!condition) throw new Error(message);
}

function baseChecks() {
  return Object.fromEntries(CHECK_NAMES.map(name => [name, "not_run"]));
}

function tokenMatches(actual, expected) {
  if (typeof actual !== "string" || !/^[a-f0-9]{64}$/.test(actual)) return false;
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function rejectedResult({ source, layout, regionId, page, regionReason = null, checks, reasons }) {
  return {
    verifier: { ...TABLE_PROPOSAL_VERIFIER },
    status: "rejected",
    reason_codes: reasons,
    source,
    layout,
    region: {
      region_id: regionId,
      page,
      abandonment_reason: regionReason,
    },
    source_reparsed: true,
    checks,
    table: null,
    claim_boundary: TABLE_PROPOSAL_CLAIM_BOUNDARY,
  };
}

export function normalizeTableProposalCells(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TABLE_PROPOSAL_CELLS) {
    throw new TypeError(`cells must contain 1 through ${MAX_TABLE_PROPOSAL_CELLS} entries.`);
  }
  return value.map((cell, index) => {
    if (!cell || typeof cell !== "object" || Array.isArray(cell)) {
      throw new TypeError(`cells[${index}] must be an object.`);
    }
    const allowed = new Set(["row", "column", "rowspan", "colspan", "item_ids"]);
    const unknown = Object.keys(cell).find(key => !allowed.has(key));
    if (unknown) throw new TypeError(`Unknown cells[${index}] argument: ${unknown}.`);
    const normalized = {
      row: cell.row,
      column: cell.column,
      rowspan: cell.rowspan,
      colspan: cell.colspan,
      item_ids: cell.item_ids,
    };
    for (const key of ["row", "column"]) {
      if (!Number.isSafeInteger(normalized[key]) || normalized[key] < 0 || normalized[key] > 999) {
        throw new TypeError(`cells[${index}].${key} must be an integer from 0 through 999.`);
      }
    }
    for (const key of ["rowspan", "colspan"]) {
      if (!Number.isSafeInteger(normalized[key]) || normalized[key] < 1 || normalized[key] > 1000) {
        throw new TypeError(`cells[${index}].${key} must be an integer from 1 through 1000.`);
      }
    }
    if (!Array.isArray(normalized.item_ids)
      || normalized.item_ids.length > MAX_TABLE_PROPOSAL_ITEM_IDS_PER_CELL
      || normalized.item_ids.some(id => typeof id !== "string" || id.length === 0 || id.length > 128)) {
      throw new TypeError(
        `cells[${index}].item_ids must be an array of at most ${MAX_TABLE_PROPOSAL_ITEM_IDS_PER_CELL} non-empty strings.`,
      );
    }
    return { ...normalized, item_ids: [...normalized.item_ids] };
  });
}

function orderCells(cells) {
  return [...cells].sort((left, right) => (
    left.row - right.row
      || left.column - right.column
      || left.rowspan - right.rowspan
      || left.colspan - right.colspan
  ));
}

function addReason(reasons, reason) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function finiteBox(box) {
  return box && typeof box === "object" && !Array.isArray(box)
    && Number.isFinite(box.x) && Number.isFinite(box.y)
    && Number.isFinite(box.width) && box.width >= 0
    && Number.isFinite(box.height) && box.height >= 0;
}

function clusterRulingSegments(segments, orientation) {
  const candidates = segments
    .filter(segment => segment?.orientation === orientation)
    .map(segment => ({
      position: orientation === "vertical"
        ? (segment.x1 + segment.x2) / 2 : (segment.y1 + segment.y2) / 2,
      segment,
    }))
    .filter(candidate => Number.isFinite(candidate.position))
    .sort((left, right) => left.position - right.position
      || left.segment.source_operator_index - right.segment.source_operator_index);
  const clusters = [];
  for (const candidate of candidates) {
    const cluster = clusters.at(-1);
    if (cluster && Math.abs(candidate.position - cluster.position) <= RULING_TOLERANCE) {
      cluster.segments.push(candidate.segment);
      cluster.position = cluster.segments.reduce((sum, segment) => sum + (
        orientation === "vertical" ? (segment.x1 + segment.x2) / 2 : (segment.y1 + segment.y2) / 2
      ), 0) / cluster.segments.length;
    } else {
      clusters.push({ position: candidate.position, segments: [candidate.segment] });
    }
  }
  return clusters;
}

function segmentCoversSample(segment, orientation, sample) {
  const first = orientation === "vertical" ? segment.y1 : segment.x1;
  const second = orientation === "vertical" ? segment.y2 : segment.x2;
  return sample >= Math.min(first, second) - RULING_TOLERANCE
    && sample <= Math.max(first, second) + RULING_TOLERANCE;
}

function gridOccupancy(cells) {
  const rowCount = Math.max(0, ...cells.map(cell => cell.row + cell.rowspan));
  const columnCount = Math.max(0, ...cells.map(cell => cell.column + cell.colspan));
  if (rowCount < 1 || columnCount < 1 || rowCount * columnCount > MAX_TABLE_PROPOSAL_GRID_SLOTS) {
    return { valid: false, rowCount, columnCount, slots: new Map() };
  }
  const slots = new Map();
  let valid = true;
  cells.forEach((cell, cellIndex) => {
    if (cell.row + cell.rowspan > rowCount || cell.column + cell.colspan > columnCount) valid = false;
    for (let row = cell.row; row < cell.row + cell.rowspan; row += 1) {
      for (let column = cell.column; column < cell.column + cell.colspan; column += 1) {
        const key = `${row}:${column}`;
        if (slots.has(key)) valid = false;
        else slots.set(key, cellIndex);
      }
    }
  });
  if (slots.size !== rowCount * columnCount) valid = false;
  return { valid, rowCount, columnCount, slots };
}

function intervalSamples(region, cuts, axis) {
  if (!finiteBox(region.bbox)) return null;
  const start = axis === "x" ? region.bbox.x : region.bbox.y;
  const end = start + (axis === "x" ? region.bbox.width : region.bbox.height);
  const positions = cuts.map(cut => cut.position);
  if (positions.some((position, index) => !Number.isFinite(position)
    || (index > 0 && position <= positions[index - 1])
    || position <= start - RULING_TOLERANCE
    || position >= end + RULING_TOLERANCE)) return null;
  const bounds = [start, ...positions, end];
  return bounds.slice(0, -1).map((value, index) => (value + bounds[index + 1]) / 2);
}

function interiorRulingCuts(region, cuts, axis) {
  if (!finiteBox(region.bbox)) return [];
  const start = axis === "x" ? region.bbox.x : region.bbox.y;
  const end = start + (axis === "x" ? region.bbox.width : region.bbox.height);
  return cuts.filter(cut => cut.position > start + RULING_TOLERANCE
    && cut.position < end - RULING_TOLERANCE);
}

function itemFitsCellCuts(item, cell, verticalCuts, horizontalCuts, rowCount, columnCount) {
  if (!finiteBox(item.bbox)) return false;
  const left = cell.column === 0 ? -Infinity : verticalCuts[cell.column - 1]?.position;
  const rightIndex = cell.column + cell.colspan;
  const right = rightIndex === columnCount ? Infinity : verticalCuts[rightIndex - 1]?.position;
  const top = cell.row === 0 ? -Infinity : horizontalCuts[cell.row - 1]?.position;
  const bottomIndex = cell.row + cell.rowspan;
  const bottom = bottomIndex === rowCount ? Infinity : horizontalCuts[bottomIndex - 1]?.position;
  if (![left, right, top, bottom].every(value => value === Infinity || value === -Infinity || Number.isFinite(value))) return false;
  return item.bbox.x >= left - RULING_TOLERANCE
    && item.bbox.x + item.bbox.width <= right + RULING_TOLERANCE
    && item.bbox.y >= top - RULING_TOLERANCE
    && item.bbox.y + item.bbox.height <= bottom + RULING_TOLERANCE;
}

/**
 * Pure B3 proof over a source-regenerated region. Exported so the adversarial
 * eval can quantify the incremental catch rate without exposing a public
 * verifier bypass.
 */
export function evaluateTableGridConsistency({ region, cells, itemById }) {
  const checks = {
    rectangular_grid: "not_run",
    cut_line_consistency: "not_run",
    ruled_line_agreement: "not_run",
    topology_ambiguity: "not_run",
  };
  const reasons = [];
  const occupancy = gridOccupancy(cells);
  checks.rectangular_grid = occupancy.valid ? "passed" : "failed";
  if (!occupancy.valid) {
    addReason(reasons, "TABLE_PROPOSAL_GRID_INVALID");
    return { checks, reasons, ruledHeaderEvidence: false };
  }

  const rulingSegments = Array.isArray(region.ruling_segments) ? region.ruling_segments : [];
  const verticalCuts = interiorRulingCuts(
    region,
    clusterRulingSegments(rulingSegments, "vertical"),
    "x",
  );
  const horizontalCuts = interiorRulingCuts(
    region,
    clusterRulingSegments(rulingSegments, "horizontal"),
    "y",
  );
  if (verticalCuts.length === 0 && horizontalCuts.length === 0) {
    checks.topology_ambiguity = "failed";
    addReason(reasons, "TABLE_PROPOSAL_TOPOLOGY_AMBIGUOUS");
    return { checks, reasons, ruledHeaderEvidence: false };
  }
  checks.topology_ambiguity = "passed";

  const columnSamples = intervalSamples(region, verticalCuts, "x");
  const rowSamples = intervalSamples(region, horizontalCuts, "y");
  const firstRowCut = horizontalCuts[0];
  const sourceRuledHeaderEvidence = firstRowCut !== undefined
    && Array.isArray(columnSamples)
    && columnSamples.length > 0
    && columnSamples.every(sample => firstRowCut.segments.some(segment => (
      segmentCoversSample(segment, "horizontal", sample)
    )));
  const dimensionsMatch = verticalCuts.length === occupancy.columnCount - 1
    && horizontalCuts.length === occupancy.rowCount - 1
    && columnSamples?.length === occupancy.columnCount
    && rowSamples?.length === occupancy.rowCount;
  const itemsFit = dimensionsMatch && cells.every(cell => cell.item_ids.every(id => (
    itemById.has(id)
      && itemFitsCellCuts(
        itemById.get(id),
        cell,
        verticalCuts,
        horizontalCuts,
        occupancy.rowCount,
        occupancy.columnCount,
      )
  )));
  checks.cut_line_consistency = dimensionsMatch && itemsFit ? "passed" : "failed";
  if (checks.cut_line_consistency === "failed") {
    addReason(reasons, "TABLE_PROPOSAL_CUTS_INCONSISTENT");
    if (verticalCuts.length > occupancy.columnCount - 1
      || horizontalCuts.length > occupancy.rowCount - 1) {
      checks.ruled_line_agreement = "failed";
      addReason(reasons, "TABLE_PROPOSAL_RULING_CONFLICT");
    }
    return { checks, reasons, ruledHeaderEvidence: sourceRuledHeaderEvidence };
  }

  let rulingConflict = false;
  verticalCuts.forEach((cut, boundaryIndex) => {
    rowSamples.forEach((sample, row) => {
      const proposalHasBoundary = occupancy.slots.get(`${row}:${boundaryIndex}`)
        !== occupancy.slots.get(`${row}:${boundaryIndex + 1}`);
      const sourceHasBoundary = cut.segments.some(segment => segmentCoversSample(segment, "vertical", sample));
      if (proposalHasBoundary !== sourceHasBoundary) rulingConflict = true;
    });
  });
  horizontalCuts.forEach((cut, boundaryIndex) => {
    columnSamples.forEach((sample, column) => {
      const proposalHasBoundary = occupancy.slots.get(`${boundaryIndex}:${column}`)
        !== occupancy.slots.get(`${boundaryIndex + 1}:${column}`);
      const sourceHasBoundary = cut.segments.some(segment => segmentCoversSample(segment, "horizontal", sample));
      if (proposalHasBoundary !== sourceHasBoundary) rulingConflict = true;
    });
  });
  checks.ruled_line_agreement = rulingConflict ? "failed" : "passed";
  if (rulingConflict) addReason(reasons, "TABLE_PROPOSAL_RULING_CONFLICT");

  return { checks, reasons, ruledHeaderEvidence: sourceRuledHeaderEvidence };
}

/**
 * Verify one untrusted structural proposal against a B1 region descriptor that
 * was regenerated from the current, independently source-validated layout IR.
 * This function performs no I/O and accepts no caller-supplied text/geometry.
 */
export function verifyTableProposalAgainstRegion({
  source,
  layout,
  regionId,
  page,
  region,
  proposalToken,
  expectedProposalToken,
  cells,
}) {
  const checks = baseChecks();
  const reasons = [];

  if (!tokenMatches(proposalToken, expectedProposalToken)) {
    checks.token_binding = "failed";
    addReason(reasons, "TABLE_PROPOSAL_TOKEN_MISMATCH");
    return rejectedResult({ source, layout, regionId, page, checks, reasons });
  }
  checks.token_binding = "passed";

  if (!region) {
    checks.region_evidence = "failed";
    addReason(reasons, "TABLE_PROPOSAL_REGION_NOT_FOUND");
    return rejectedResult({ source, layout, regionId, page, checks, reasons });
  }
  if (Object.values(region.truncation ?? {}).some(status => status !== "complete")) {
    checks.region_evidence = "failed";
    addReason(reasons, "TABLE_PROPOSAL_REGION_TRUNCATED");
    return rejectedResult({
      source,
      layout,
      regionId,
      page,
      regionReason: region.reason,
      checks,
      reasons,
    });
  }
  const regionItemIds = new Set();
  const regionReadingOrders = new Set();
  const unsupportedRegionItems = !Array.isArray(region.text_items) || region.text_items.some(item => {
    const unsupported = !item || typeof item.id !== "string" || item.id.length === 0
      || typeof item.text !== "string" || typeof item.line_id !== "string" || item.line_id.length === 0
      || !Number.isSafeInteger(item.reading_order_index) || item.reading_order_index < 0
      || regionItemIds.has(item.id) || regionReadingOrders.has(item.reading_order_index);
    regionItemIds.add(item?.id);
    regionReadingOrders.add(item?.reading_order_index);
    return unsupported;
  });
  if (unsupportedRegionItems) {
    checks.region_evidence = "failed";
    addReason(reasons, "TABLE_PROPOSAL_REGION_UNSUPPORTED");
    return rejectedResult({
      source,
      layout,
      regionId,
      page,
      regionReason: region.reason,
      checks,
      reasons,
    });
  }
  checks.region_evidence = "passed";

  const orderedCells = orderCells(cells);
  const anchors = new Set();
  let invalidCell = false;
  for (const cell of orderedCells) {
    const anchor = `${cell.row}:${cell.column}`;
    if (anchors.has(anchor)) invalidCell = true;
    anchors.add(anchor);
    if (cell.row + cell.rowspan > 1000 || cell.column + cell.colspan > 1000) invalidCell = true;
  }
  checks.cell_input = invalidCell ? "failed" : "passed";
  if (invalidCell) addReason(reasons, "TABLE_PROPOSAL_CELL_INVALID");

  const itemById = new Map(region.text_items.map(item => [item.id, item]));
  const assignments = new Map();
  let unknown = false;
  let duplicated = false;
  for (const cell of orderedCells) {
    for (const itemId of cell.item_ids) {
      if (!itemById.has(itemId)) {
        unknown = true;
        continue;
      }
      if (assignments.has(itemId)) duplicated = true;
      else assignments.set(itemId, cell);
    }
  }
  const missing = region.text_items.some(item => !assignments.has(item.id));
  checks.coverage = unknown || missing ? "failed" : "passed";
  checks.one_cell = duplicated ? "failed" : "passed";
  if (unknown) addReason(reasons, "TABLE_PROPOSAL_ITEM_UNKNOWN");
  if (duplicated) addReason(reasons, "TABLE_PROPOSAL_ITEM_DUPLICATED");
  if (missing) addReason(reasons, "TABLE_PROPOSAL_ITEM_MISSING");

  const assignedItems = region.text_items
    .filter(item => assignments.has(item.id))
    .sort((left, right) => left.reading_order_index - right.reading_order_index || left.id.localeCompare(right.id));
  const lineRows = new Map();
  const lineColumns = new Map();
  for (const item of assignedItems) {
    const cell = assignments.get(item.id);
    const lineId = item.line_id ?? `item:${item.id}`;
    if (!lineRows.has(lineId)) lineRows.set(lineId, []);
    if (!lineColumns.has(lineId)) lineColumns.set(lineId, []);
    lineRows.get(lineId).push(cell.row);
    lineColumns.get(lineId).push(cell.column);
  }
  const lineStraddle = [...lineRows.values()].some(rows => new Set(rows).size > 1);
  const rowSequence = assignedItems.map(item => assignments.get(item.id).row);
  const rowOrderInvalid = rowSequence.some((row, index) => index > 0 && row < rowSequence[index - 1]);
  const columnOrderInvalid = [...lineColumns.values()].some(columns => (
    columns.some((column, index) => index > 0 && column < columns[index - 1])
  ));
  checks.row_non_straddle = lineStraddle ? "failed" : "passed";
  checks.row_order = rowOrderInvalid ? "failed" : "passed";
  checks.column_order = columnOrderInvalid ? "failed" : "passed";
  if (lineStraddle) addReason(reasons, "TABLE_PROPOSAL_LINE_STRADDLE");
  if (rowOrderInvalid) addReason(reasons, "TABLE_PROPOSAL_ROW_ORDER");
  if (columnOrderInvalid) addReason(reasons, "TABLE_PROPOSAL_COLUMN_ORDER");

  let ruledHeaderEvidence = false;
  const gridEligible = !invalidCell && !unknown && !duplicated && !missing;
  if (gridEligible) {
    const grid = evaluateTableGridConsistency({ region, cells: orderedCells, itemById });
    Object.assign(checks, grid.checks);
    for (const reason of grid.reasons) addReason(reasons, reason);
    ruledHeaderEvidence = grid.ruledHeaderEvidence;
  }

  const firstSourceLine = assignedItems[0]?.line_id ?? null;
  const firstSourceRows = assignedItems
    .filter(item => item.line_id === firstSourceLine)
    .map(item => assignments.get(item.id).row);
  const firstLineIsHeader = firstSourceRows.length > 0 && firstSourceRows.every(row => row === 0);
  const headerEvidence = firstLineIsHeader && (ruledHeaderEvidence || (
    region.header_hints?.status === "available"
      && region.header_hints.first_row_band === "taller_than_body"
  ));
  checks.header_evidence = headerEvidence ? "passed" : "failed";
  if (!headerEvidence) addReason(reasons, "TABLE_PROPOSAL_HEADER_UNSUPPORTED");

  if (reasons.length > 0) {
    return rejectedResult({
      source,
      layout,
      regionId,
      page,
      regionReason: region.reason,
      checks,
      reasons,
    });
  }

  const tableCells = orderedCells.map(cell => {
    const sourceItems = cell.item_ids
      .map(id => itemById.get(id))
      .sort((left, right) => left.reading_order_index - right.reading_order_index || left.id.localeCompare(right.id));
    const sourceFragments = sourceItems.map(item => item.text);
    return {
      row: cell.row,
      column: cell.column,
      rowspan: cell.rowspan,
      colspan: cell.colspan,
      item_ids: sourceItems.map(item => item.id),
      // Never introduce separator characters that were not present in a
      // source text item. B4's Markdown projection applies syntax escaping but
      // keeps this structured proof surface as exact item-text concatenation.
      text: sourceFragments.join(""),
    };
  });
  checks.content_source = tableCells.every((cell, index) => (
    cell.text === orderedCells[index].item_ids
      .map(id => itemById.get(id))
      .sort((left, right) => left.reading_order_index - right.reading_order_index || left.id.localeCompare(right.id))
      .map(item => item.text)
      .join("")
  )) ? "passed" : "failed";
  if (checks.content_source !== "passed") {
    addReason(reasons, "TABLE_PROPOSAL_CELL_INVALID");
    return rejectedResult({
      source,
      layout,
      regionId,
      page,
      regionReason: region.reason,
      checks,
      reasons,
    });
  }

  const table = {
    row_count: Math.max(...tableCells.map(cell => cell.row + cell.rowspan)),
    column_count: Math.max(...tableCells.map(cell => cell.column + cell.colspan)),
    cells: tableCells,
    content_origin: "reparsed_pdf_text_layer",
  };
  const markdown = renderVerifiedTableMarkdown(table);
  table.markdown = markdown;
  table.markdown_format = "gfm";
  table.markdown_span_projection = "anchor_text_with_empty_continuation_cells";
  table.markdown_bytes = Buffer.byteLength(markdown, "utf8");
  table.markdown_sha256 = createHash("sha256").update(markdown, "utf8").digest("hex");

  return {
    verifier: { ...TABLE_PROPOSAL_VERIFIER },
    status: "accepted",
    reason_codes: [],
    source,
    layout,
    region: {
      region_id: regionId,
      page,
      abandonment_reason: region.reason,
    },
    source_reparsed: true,
    checks,
    table,
    claim_boundary: TABLE_PROPOSAL_CLAIM_BOUNDARY,
  };
}

export function validateTableProposalVerificationResult(result) {
  assertion(result && typeof result === "object" && !Array.isArray(result),
    "table proposal verification result must be an object");
  assertion(result.verifier?.name === TABLE_PROPOSAL_VERIFIER.name
    && result.verifier?.version === TABLE_PROPOSAL_VERIFIER.version,
  "table proposal verifier identity mismatch");
  assertion(["accepted", "rejected"].includes(result.status),
    "table proposal verification status is invalid");
  assertion(Array.isArray(result.reason_codes)
    && result.reason_codes.every(code => TABLE_PROPOSAL_REASON_CODES.includes(code))
    && new Set(result.reason_codes).size === result.reason_codes.length,
  "table proposal verification reason codes are invalid");
  assertion(result.source_reparsed === true, "table proposal source_reparsed must be true");
  assertion(result.claim_boundary === TABLE_PROPOSAL_CLAIM_BOUNDARY,
    "table proposal claim boundary mismatch");
  assertion(result.checks && typeof result.checks === "object" && !Array.isArray(result.checks),
    "table proposal checks must be an object");
  assertion(Object.keys(result.checks).length === CHECK_NAMES.length
    && CHECK_NAMES.every(name => ["passed", "failed", "not_run"].includes(result.checks[name])),
  "table proposal check statuses are invalid");
  if (result.status === "accepted") {
    assertion(result.reason_codes.length === 0, "accepted table proposal cannot carry rejection reasons");
    assertion(result.table && Array.isArray(result.table.cells), "accepted table proposal must carry a table");
    assertion(CHECK_NAMES.every(name => result.checks[name] === "passed"),
      "accepted table proposal must pass every verifier check");
    assertion(result.table.content_origin === "reparsed_pdf_text_layer",
      "accepted table content origin mismatch");
    const expectedMarkdown = renderVerifiedTableMarkdown(result.table);
    assertion(result.table.markdown === expectedMarkdown,
      "accepted table Markdown projection mismatch");
    assertion(result.table.markdown_format === "gfm",
      "accepted table Markdown format mismatch");
    assertion(result.table.markdown_span_projection === "anchor_text_with_empty_continuation_cells",
      "accepted table Markdown span projection mismatch");
    assertion(result.table.markdown_bytes === Buffer.byteLength(expectedMarkdown, "utf8"),
      "accepted table Markdown byte count mismatch");
    assertion(result.table.markdown_sha256
      === createHash("sha256").update(expectedMarkdown, "utf8").digest("hex"),
    "accepted table Markdown digest mismatch");
  } else {
    assertion(result.reason_codes.length > 0, "rejected table proposal must carry a reason");
    assertion(result.table === null, "rejected table proposal cannot carry a table");
    assertion(Object.values(result.checks).includes("failed"),
      "rejected table proposal must carry a failed check");
  }
  return result;
}
