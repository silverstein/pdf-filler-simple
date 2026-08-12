import crypto from "node:crypto";

export const EXTRACTION_BAKEOFF_SCORE_PROTOCOL = "pdf-tools.extraction-bakeoff-score.v1";

export const EXTRACTION_BAKEOFF_METRIC_CONTRACT = Object.freeze({
  transcript: "per-page normalized-whitespace exact match, character/word edit distance, and distinct ordered/unordered fragment recall against the Phase 0 manifest",
  table: "exact declared row/column topology, merged regions, and coordinate-bound cell values against the Phase 0 manifest; text is never promoted into inferred table structure",
  raster: "expected raster pages with non-empty text, complete ordered fragments, and explicit disclosure when raster text is omitted",
  stability: "three fresh distinct process IDs and one canonical output hash per case",
  latency: "per-case minimum, median, maximum, and aggregate median wall-clock milliseconds from the retained reports",
  structured_schema: "not scored in this parser bakeoff; arbitrary-schema answering remains covered by the separate Phase 1 scorer",
});

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function normalizedText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function unescapeMarkdown(value) {
  return value.replace(/\\([\\`*_{}\[\]()<>#+.!|\-])/g, "$1")
    .replace(/&#([0-9]+);/g, (_, codePoint) => String.fromCodePoint(Number(codePoint)))
    .replace(/&(amp|lt|gt);/g, (_, entity) => ({ amp: "&", lt: "<", gt: ">" })[entity]);
}

export function projectMarkdownPages(markdown) {
  const source = String(markdown ?? "");
  const marker = /^<!-- PDF page ([1-9][0-9]*) -->\s*$/gm;
  const matches = [...source.matchAll(marker)];
  if (matches.length === 0) throw new Error("Markdown bakeoff result has no page markers");
  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? source.length;
    let body = source.slice(start, end);
    const metadata = body.search(/^## Conversion (?:gaps|limitations)\s*$/m);
    if (metadata >= 0) body = body.slice(0, metadata);
    const lines = body.split(/\r?\n/).map(line => line.trim()).filter(line => {
      return line !== "" && line !== "---" && line !== "[No source-backed text was available on this page.]";
    }).map(line => unescapeMarkdown(line.replace(/^#{1,6}\s+/, "")));
    return { page: Number(match[1]), text: lines.join("\n") };
  });
}

export function editDistance(actual, expected) {
  const left = Array.isArray(actual) ? actual : [...actual];
  const right = Array.isArray(expected) ? expected : [...expected];
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (Object.is(left[row - 1], right[column - 1]) ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

export function scoreDistinctFragments(text, fragments) {
  const normalized = normalizedText(text);
  const expected = fragments.map(normalizedText);
  const used = [];
  let found = 0;
  let orderedFound = 0;
  let cursor = 0;
  for (const fragment of expected) {
    let index = normalized.indexOf(fragment);
    while (index >= 0 && used.some(range => index < range.end && index + fragment.length > range.start)) {
      index = normalized.indexOf(fragment, index + 1);
    }
    if (index >= 0) {
      found += 1;
      used.push({ start: index, end: index + fragment.length });
    }
    const orderedIndex = normalized.indexOf(fragment, cursor);
    if (orderedIndex >= 0) {
      orderedFound += 1;
      cursor = orderedIndex + fragment.length;
    }
  }
  return { found, ordered_found: orderedFound, total: expected.length };
}

function words(value) {
  const normalized = normalizedText(value);
  return normalized === "" ? [] : normalized.split(" ");
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function scorePage(expectedPage, actualText) {
  const expected = normalizedText(expectedPage.transcript);
  const actual = normalizedText(actualText);
  const expectedWords = words(expected);
  const actualWords = words(actual);
  const fragments = scoreDistinctFragments(actual, expectedPage.ordered_fragments);
  return {
    page: expectedPage.page,
    modality: expectedPage.modality,
    exact_match: actual === expected,
    text_available: actual !== "",
    character_edits: editDistance(actual, expected),
    expected_characters: [...expected].length,
    word_edits: editDistance(actualWords, expectedWords),
    expected_words: expectedWords.length,
    fragments_found: fragments.found,
    ordered_fragments_found: fragments.ordered_found,
    expected_fragments: fragments.total,
  };
}

function summarizePages(pages) {
  const totals = pages.reduce((summary, page) => {
    summary.pages += 1;
    summary.exact_pages += Number(page.exact_match);
    summary.character_edits += page.character_edits;
    summary.expected_characters += page.expected_characters;
    summary.word_edits += page.word_edits;
    summary.expected_words += page.expected_words;
    summary.fragments_found += page.fragments_found;
    summary.ordered_fragments_found += page.ordered_fragments_found;
    summary.expected_fragments += page.expected_fragments;
    return summary;
  }, {
    pages: 0,
    exact_pages: 0,
    character_edits: 0,
    expected_characters: 0,
    word_edits: 0,
    expected_words: 0,
    fragments_found: 0,
    ordered_fragments_found: 0,
    expected_fragments: 0,
  });
  return {
    ...totals,
    exact_page_rate: ratio(totals.exact_pages, totals.pages),
    character_error_rate: ratio(totals.character_edits, totals.expected_characters),
    word_error_rate: ratio(totals.word_edits, totals.expected_words),
    fragment_recall: ratio(totals.fragments_found, totals.expected_fragments),
    ordered_fragment_recall: ratio(totals.ordered_fragments_found, totals.expected_fragments),
  };
}

function regionKey(region) {
  if (typeof region === "string") return region;
  const startRow = region.start_row ?? region.row ?? region.row_start;
  const startColumn = region.start_column ?? region.column ?? region.column_start;
  const endRow = region.end_row ?? (startRow + (region.row_span ?? 1) - 1);
  const endColumn = region.end_column ?? (startColumn + (region.column_span ?? 1) - 1);
  if (![startRow, startColumn, endRow, endColumn].every(Number.isInteger)) {
    throw new Error("Candidate table has an invalid merged region");
  }
  return `R${startRow}C${startColumn}:R${endRow}C${endColumn}`;
}

const MAX_PROJECTED_TABLE_ROWS = 200;
const MAX_PROJECTED_TABLE_COLUMNS = 64;

function splitTableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|") || trimmed.length < 2) return null;
  // Split on unescaped delimiters only, so an escaped pipe inside a cell stays
  // part of that cell rather than creating a column.
  return trimmed.slice(1, -1).split(/(?<!\\)\|/u).map(cell => cell.trim());
}

function isDelimiterRow(cells) {
  return Array.isArray(cells)
    && cells.length > 0
    && cells.every(cell => /^:?-{3,}:?$/u.test(cell));
}

/**
 * Project the first GFM table on a page back into the scorer's candidate table
 * shape. Bounded and conservative: it reads one table, requires the delimiter
 * row and every body row to have exactly the header's column count, and
 * reports no merged regions because GFM cannot express them. A page with no
 * conforming table projects to null, which scores as absent rather than as a
 * wrong topology.
 */
export function projectMarkdownTable(markdown, page) {
  const source = String(markdown ?? "");
  const marker = /^<!-- PDF page ([1-9][0-9]*) -->\s*$/gm;
  const matches = [...source.matchAll(marker)];
  if (matches.length === 0) return null;
  const index = matches.findIndex(match => Number(match[1]) === page);
  if (index === -1) return null;
  const start = matches[index].index + matches[index][0].length;
  const end = matches[index + 1]?.index ?? source.length;
  let body = source.slice(start, end);
  const metadata = body.search(/^## Conversion (?:gaps|limitations)\s*$/m);
  if (metadata >= 0) body = body.slice(0, metadata);

  const lines = body.split(/\r?\n/);
  for (let cursor = 0; cursor + 1 < lines.length; cursor += 1) {
    const header = splitTableCells(lines[cursor]);
    if (header === null) continue;
    if (!isDelimiterRow(splitTableCells(lines[cursor + 1]))) continue;
    if (splitTableCells(lines[cursor + 1]).length !== header.length) return null;
    if (header.length > MAX_PROJECTED_TABLE_COLUMNS) {
      throw new Error("Projected Markdown table exceeds its column ceiling");
    }
    const rows = [header];
    for (let row = cursor + 2; row < lines.length; row += 1) {
      const cells = splitTableCells(lines[row]);
      if (cells === null) break;
      if (cells.length !== header.length) return null;
      rows.push(cells);
      if (rows.length > MAX_PROJECTED_TABLE_ROWS) {
        throw new Error("Projected Markdown table exceeds its row ceiling");
      }
    }
    return {
      page,
      row_count: rows.length,
      column_count: header.length,
      merged_regions: [],
      cells: rows.flatMap((cells, rowIndex) => cells.map((value, columnIndex) => ({
        row: rowIndex + 1,
        column: columnIndex + 1,
        value: unescapeMarkdown(value),
      }))),
    };
  }
  return null;
}

export function scoreTable(expected, candidate) {
  if (expected === null) return { applicable: false };
  const retainedCells = (candidate?.cells ?? []).filter(cell => cell.present !== false);
  const coordinates = retainedCells.map(cell => `${cell.row}:${cell.column}`);
  if (new Set(coordinates).size !== coordinates.length) throw new Error("Candidate table has duplicate cell coordinates");
  const cells = new Map(retainedCells.map(cell => [`${cell.row}:${cell.column}`, cell.value]));
  const expectedMerged = [...expected.merged_cells].sort();
  const actualMerged = (candidate?.merged_regions ?? []).map(regionKey).sort();
  const exactCells = expected.cells.filter(cell => cells.has(`${cell.row}:${cell.column}`)
    && Object.is(cells.get(`${cell.row}:${cell.column}`), cell.value)).length;
  const candidateCellCount = cells.size;
  const dimensionsExact = candidate?.row_count === expected.row_count
    && candidate?.column_count === expected.column_count;
  const mergedExact = canonicalJson(actualMerged) === canonicalJson(expectedMerged);
  const cellsExact = exactCells === expected.cells.length && candidateCellCount === expected.cells.length;
  return {
    applicable: true,
    present: candidate !== null && candidate !== undefined,
    dimensions_exact: dimensionsExact,
    merged_regions_exact: mergedExact,
    cells_exact: cellsExact,
    topology_exact: dimensionsExact && mergedExact && cellsExact,
    exact_cells: exactCells,
    expected_cells: expected.cells.length,
    candidate_cells: candidateCellCount,
    row_count: candidate?.row_count ?? null,
    column_count: candidate?.column_count ?? null,
  };
}

function disclosureText(value) {
  return normalizedText(value).toLowerCase();
}

function markdownDisclosure(result, pattern) {
  const messages = [
    ...(result.limitations ?? []),
    ...(result.gaps ?? []).map(gap => `${gap.code ?? ""} ${gap.message ?? ""}`),
  ];
  return messages.some(message => pattern.test(disclosureText(message)));
}

function doclingDisclosure(response, pattern) {
  const messages = [
    response.diagnostics?.code,
    response.diagnostics?.message,
    ...(response.gaps ?? []).flatMap(gap => [gap.reason, gap.detail]),
  ];
  return messages.some(message => pattern.test(disclosureText(message)));
}

function validateRuns(caseRecord, hashKey, payloadKey, label) {
  if (caseRecord.stable !== true || caseRecord.source_reopened_verified !== true
    || !Array.isArray(caseRecord.runs) || caseRecord.runs.length !== 3) {
    throw new Error(`${label} ${caseRecord.case_id} lacks stable three-process evidence`);
  }
  const pids = caseRecord.runs.map(run => run.pid);
  const hashes = caseRecord.runs.map(run => run[hashKey]);
  if (new Set(pids).size !== 3 || new Set(hashes).size !== 1
    || caseRecord.runs[0][payloadKey] === null || caseRecord.runs[0][payloadKey] === undefined
    || caseRecord.runs.slice(1).some(run => run[payloadKey] !== null && run[payloadKey] !== undefined)) {
    throw new Error(`${label} ${caseRecord.case_id} violates retained determinism evidence`);
  }
  return {
    stable: true,
    source_reopened_verified: true,
    repetitions: 3,
    distinct_pids: 3,
    distinct_output_hashes: 1,
  };
}

function latency(runs) {
  const values = runs.map(run => run.elapsed_ms);
  if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error("Invalid bakeoff latency");
  return { minimum: Math.min(...values), median: median(values), maximum: Math.max(...values), runs: values };
}

function markdownPageTexts(result, expectedPages) {
  const projected = new Map(projectMarkdownPages(result.markdown).map(page => [page.page, page.text]));
  if (projected.size !== expectedPages.length || expectedPages.some(page => !projected.has(page.page))) {
    throw new Error("Markdown page projection does not match fixture truth pages");
  }
  return projected;
}

function doclingPageTexts(response, expectedPages) {
  const grouped = new Map();
  for (const item of response.page_texts ?? []) {
    if (!grouped.has(item.page)) grouped.set(item.page, []);
    grouped.get(item.page).push(item.text);
  }
  const expectedPageNumbers = new Set(expectedPages.map(page => page.page));
  if (grouped.size !== expectedPageNumbers.size
    || expectedPages.some(page => !grouped.has(page.page))
    || [...grouped.keys()].some(page => !expectedPageNumbers.has(page))) {
    throw new Error("Docling page projection does not match fixture truth pages");
  }
  return new Map([...grouped].map(([page, texts]) => [page, texts.join("\n")]));
}

function scoreSystemCase(fixture, caseRecord, { kind }) {
  const payloadKey = kind === "markdown" ? "result" : "response";
  const hashKey = kind === "markdown" ? "result_sha256" : "response_sha256";
  const payload = caseRecord.runs[0][payloadKey];
  const projected = kind === "markdown"
    ? markdownPageTexts(payload, fixture.expected.pages)
    : doclingPageTexts(payload, fixture.expected.pages);
  const pages = fixture.expected.pages.map(page => scorePage(page, projected.get(page.page)));
  const rasterOmissions = pages.filter(page => page.modality === "raster" && !page.text_available);
  const rasterDisclosure = kind === "markdown"
    ? markdownDisclosure(payload, /ocr not performed|ocr_not_performed|image-only|text_layer_empty/)
    : doclingDisclosure(payload, /ocr|image-only|raster/);
  // Now that Markdown tables are actually projected and scored above, this
  // measures whether the remaining table limits are disclosed, not whether
  // tables are unsupported. Vocabulary covers the typed gap code and the
  // current limitation wording.
  const tableDisclosure = kind === "markdown"
    ? markdownDisclosure(
      payload,
      /table_topology_unknown|table topology|column topology|table structure.*not|merged or spanning cells/,
    )
    : doclingDisclosure(payload, /table topology|table structure|table.*unsupported/);
  const candidateTable = kind === "markdown"
    ? (fixture.expected.table === null
      ? null
      : projectMarkdownTable(payload.markdown, fixture.expected.table.page))
    : (payload.tables?.[0] ?? null);
  return {
    transcript: { pages, totals: summarizePages(pages) },
    table: scoreTable(fixture.expected.table, candidateTable),
    coverage: {
      expected_raster_pages: pages.filter(page => page.modality === "raster").length,
      raster_pages_with_text: pages.filter(page => page.modality === "raster" && page.text_available).length,
      raster_pages_with_complete_ordered_fragments: pages.filter(page => page.modality === "raster"
        && page.ordered_fragments_found === page.expected_fragments).length,
      raster_omissions: rasterOmissions.length,
      raster_omissions_disclosed: rasterOmissions.length === 0 ? null : rasterDisclosure,
      table_topology_limit_disclosed: fixture.expected.table === null ? null : tableDisclosure,
    },
    stability: validateRuns(caseRecord, hashKey, payloadKey, kind),
    latency_ms: latency(caseRecord.runs),
  };
}

function aggregateSystem(cases, kind) {
  const systems = cases.map(item => item.systems[kind]);
  const pageTotals = summarizePages(systems.flatMap(system => system.transcript.pages));
  const tables = systems.map(system => system.table).filter(table => table.applicable);
  const raster = systems.reduce((summary, system) => {
    summary.expected_pages += system.coverage.expected_raster_pages;
    summary.pages_with_text += system.coverage.raster_pages_with_text;
    summary.pages_with_complete_ordered_fragments += system.coverage.raster_pages_with_complete_ordered_fragments;
    summary.omissions += system.coverage.raster_omissions;
    if (system.coverage.raster_omissions_disclosed === true) summary.disclosed_omissions += system.coverage.raster_omissions;
    return summary;
  }, { expected_pages: 0, pages_with_text: 0, pages_with_complete_ordered_fragments: 0, omissions: 0, disclosed_omissions: 0 });
  const allLatencies = systems.flatMap(system => system.latency_ms.runs);
  const exactCells = tables.reduce((sum, table) => sum + table.exact_cells, 0);
  const expectedCells = tables.reduce((sum, table) => sum + table.expected_cells, 0);
  return {
    transcript: pageTotals,
    table: {
      applicable_cases: tables.length,
      topology_exact_cases: tables.filter(table => table.topology_exact).length,
      exact_cells: exactCells,
      expected_cells: expectedCells,
      exact_cell_rate: ratio(exactCells, expectedCells),
    },
    raster: {
      ...raster,
      text_availability_rate: ratio(raster.pages_with_text, raster.expected_pages),
      complete_ordered_fragment_rate: ratio(raster.pages_with_complete_ordered_fragments, raster.expected_pages),
      omission_disclosure_rate: ratio(raster.disclosed_omissions, raster.omissions),
    },
    stability: {
      cases: systems.length,
      stable_cases: systems.filter(system => system.stability.stable).length,
      distinct_processes: systems.reduce((sum, system) => sum + system.stability.distinct_pids, 0),
    },
    latency_ms: {
      attempts: allLatencies.length,
      minimum: Math.min(...allLatencies),
      median: median(allLatencies),
      maximum: Math.max(...allLatencies),
    },
  };
}

function validateReportAlignment(manifest, markdownReport, doclingReport, sourceBindings) {
  if (markdownReport.protocol !== "pdf-tools.markdown-bakeoff.v1"
    || doclingReport.protocol !== "pdf-tools.docling-bakeoff.v1"
    || markdownReport.repetitions_per_case !== 3 || doclingReport.repetitions_per_case !== 3
    || !markdownReport.runtime || doclingReport.runtime?.stable !== true) {
    throw new Error("Bakeoff report protocol or runtime contract is invalid");
  }
  const markdownBindings = markdownReport.source_bindings;
  const doclingBindings = doclingReport.source_bindings;
  if (!markdownBindings || !doclingBindings
    || markdownBindings.manifest_sha256 !== sourceBindings.manifest_sha256
    || doclingBindings.manifest_sha256 !== sourceBindings.manifest_sha256
    || markdownBindings.handoff_id !== doclingBindings.handoff_id
    || markdownBindings.receipt_sha256 !== doclingBindings.receipt_sha256
    || markdownBindings.receipt_schema_sha256 !== doclingBindings.receipt_schema_sha256) {
    throw new Error("Bakeoff reports do not share one authenticated campaign binding");
  }
  const fixtureIds = manifest.fixtures.map(fixture => fixture.id);
  if (canonicalJson(markdownReport.cases.map(item => item.case_id)) !== canonicalJson(fixtureIds)
    || canonicalJson(doclingReport.cases.map(item => item.case_id)) !== canonicalJson(fixtureIds)) {
    throw new Error("Bakeoff report case order or denominator drifted from the manifest");
  }
  for (let index = 0; index < manifest.fixtures.length; index += 1) {
    const fixture = manifest.fixtures[index];
    const markdownCase = markdownReport.cases[index];
    const doclingCase = doclingReport.cases[index];
    if (markdownCase.source_sha256 !== fixture.sha256 || doclingCase.source_sha256 !== fixture.sha256
      || markdownCase.source_sha256 !== doclingCase.source_sha256
      || markdownCase.page_count !== fixture.expected.pages.length
      || doclingCase.page_count !== fixture.expected.pages.length
      || markdownCase.category !== fixture.category || doclingCase.category !== fixture.category) {
      throw new Error(`Bakeoff source or fixture binding drifted for ${fixture.id}`);
    }
  }
}

export function scoreExtractionBakeoff({ manifest, markdownReport, doclingReport, sourceBindings }) {
  if (!manifest || !Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
    throw new Error("Extraction manifest is invalid");
  }
  validateReportAlignment(manifest, markdownReport, doclingReport, sourceBindings);
  const cases = manifest.fixtures.map((fixture, index) => ({
    case_id: fixture.id,
    category: fixture.category,
    page_count: fixture.expected.pages.length,
    source_sha256: fixture.sha256,
    systems: {
      markdown: scoreSystemCase(fixture, markdownReport.cases[index], { kind: "markdown" }),
      docling: scoreSystemCase(fixture, doclingReport.cases[index], { kind: "docling" }),
    },
  }));
  return {
    protocol: EXTRACTION_BAKEOFF_SCORE_PROTOCOL,
    source_bindings: sourceBindings,
    metric_contract: EXTRACTION_BAKEOFF_METRIC_CONTRACT,
    metric_contract_sha256: sha256(Buffer.from(canonicalJson(EXTRACTION_BAKEOFF_METRIC_CONTRACT))),
    cases,
    aggregates: {
      markdown: aggregateSystem(cases, "markdown"),
      docling: aggregateSystem(cases, "docling"),
    },
  };
}
