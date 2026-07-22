import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

function metric({ applicable = true, availability = "measured", numerator = null, denominator = null, score = null, ...details }) {
  return { applicable, availability, numerator, denominator, score, ...details };
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function flatten(value, pointer = "") {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flatten(item, `${pointer}/${index}`));
  }
  if (value && typeof value === "object") {
    return Object.keys(value).sort().flatMap(key => flatten(value[key], `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`));
  }
  return [[pointer || "/", value]];
}

function valueAtPointer(value, pointer) {
  if (pointer === "/") return value;
  let current = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || current === undefined || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function sequenceCoverage(text, fragments) {
  let cursor = 0;
  let found = 0;
  let ordered = true;
  for (const fragment of fragments) {
    const anywhere = text.indexOf(fragment);
    if (anywhere >= 0) found += 1;
    const next = text.indexOf(fragment, cursor);
    if (next < 0) ordered = false;
    else cursor = next + fragment.length;
  }
  return { found, total: fragments.length, ordered };
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function errorRates(actual, expected) {
  const actualText = normalizeText(actual);
  const expectedText = normalizeText(expected);
  const actualWords = actualText ? actualText.split(" ") : [];
  const expectedWords = expectedText ? expectedText.split(" ") : [];
  return {
    cer: expectedText.length === 0 ? 0 : editDistance([...actualText], [...expectedText]) / expectedText.length,
    wer: expectedWords.length === 0 ? 0 : editDistance(actualWords, expectedWords) / expectedWords.length,
  };
}

function scoreStructured(fixture, observation) {
  let candidate = observation.structured_candidate ?? null;
  let parseStatus = "unavailable";
  if (typeof observation.structured_candidate_raw === "string") {
    try {
      candidate = JSON.parse(observation.structured_candidate_raw);
      parseStatus = "measured";
    } catch {
      parseStatus = "invalid";
    }
  } else if (candidate !== null) {
    parseStatus = "measured";
  }
  const parsed = parseStatus === "measured";
  const validation = parsed
    ? new AjvJsonSchemaValidator().getValidator(fixture.target_schema)(candidate)
    : { valid: false, errorMessage: null };
  const truthLeaves = flatten(fixture.ground_truth);
  const candidateLeaves = parsed ? flatten(candidate) : [];
  const truthByPointer = new Map(truthLeaves);
  const candidateByPointer = new Map(candidateLeaves);
  const matched = parsed ? truthLeaves.filter(([pointer, expected]) => Object.is(candidateByPointer.get(pointer), expected)).length : 0;
  const missing = truthLeaves.filter(([pointer, expected]) => !Object.is(candidateByPointer.get(pointer), expected)).length;
  const spurious = candidateLeaves.filter(([pointer, actual]) => !truthByPointer.has(pointer) || !Object.is(truthByPointer.get(pointer), actual)).length;
  const precision = matched + spurious === 0 ? 0 : matched / (matched + spurious);
  const recall = truthLeaves.length === 0 ? 1 : matched / truthLeaves.length;
  const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
  return {
    json_parse: metric({ availability: parseStatus, numerator: parsed ? 1 : 0, denominator: 1, score: parsed ? 1 : 0 }),
    schema_validity: metric({ availability: parsed ? "measured" : parseStatus, numerator: validation.valid ? 1 : 0, denominator: 1, score: validation.valid ? 1 : 0, error: validation.errorMessage ?? null }),
    field_correctness: metric({
      availability: parsed ? "measured" : parseStatus,
      numerator: matched,
      denominator: truthLeaves.length,
      score: f1,
      true_positive: matched,
      missing,
      spurious,
      precision,
      recall,
      f1,
    }),
  };
}

function scoreTextAndOcr(fixture, observation) {
  let bornFound = 0;
  let bornTotal = 0;
  let bornOrdered = 0;
  let bornPages = 0;
  let ocrFound = 0;
  let ocrPages = 0;
  let cerTotal = 0;
  let werTotal = 0;
  let rasterRendered = 0;
  const pageTexts = new Map((observation.page_texts ?? []).map(page => [page.page, normalizeText(page.text)]));
  const ocrTexts = new Map((observation.ocr_texts ?? []).map(page => [page.page, normalizeText(page.text)]));

  for (const page of fixture.expected.pages) {
    if (page.modality === "born_digital") {
      const result = sequenceCoverage(pageTexts.get(page.page) ?? "", page.ordered_fragments);
      bornFound += result.found;
      bornTotal += result.total;
      bornOrdered += result.ordered ? 1 : 0;
      bornPages += 1;
    } else {
      ocrPages += 1;
      if ((observation.raster_pages ?? []).some(item => item.page === page.page && item.ok)) rasterRendered += 1;
      if (ocrTexts.has(page.page)) {
        ocrFound += 1;
        const rates = errorRates(ocrTexts.get(page.page), page.transcript);
        cerTotal += rates.cer;
        werTotal += rates.wer;
      }
    }
  }
  return {
    text_coverage: metric({ applicable: bornTotal > 0, availability: bornTotal > 0 ? "measured" : "not_applicable", numerator: bornFound, denominator: bornTotal, score: bornTotal > 0 ? bornFound / bornTotal : null }),
    reading_order: metric({ applicable: bornPages > 0, availability: bornPages > 0 ? "measured" : "not_applicable", numerator: bornOrdered, denominator: bornPages, score: bornPages > 0 ? bornOrdered / bornPages : null }),
    ocr: metric({
      applicable: ocrPages > 0,
      availability: ocrPages === 0 ? "not_applicable" : ocrFound === 0 ? "unavailable" : "measured",
      numerator: ocrFound,
      denominator: ocrPages,
      score: ocrPages > 0 ? ocrFound / ocrPages : null,
      cer: ocrFound > 0 ? cerTotal / ocrFound : null,
      wer: ocrFound > 0 ? werTotal / ocrFound : null,
    }),
    raster_render: metric({
      applicable: ocrPages > 0,
      availability: ocrPages > 0 ? "measured" : "not_applicable",
      numerator: rasterRendered,
      denominator: ocrPages,
      score: ocrPages > 0 ? rasterRendered / ocrPages : null,
    }),
  };
}

function scoreTable(fixture, observation) {
  if (!fixture.expected.table) return {
    table_topology: metric({ applicable: false, availability: "not_applicable" }),
    table_cells: metric({ applicable: false, availability: "not_applicable" }),
  };
  const candidate = observation.table_candidate;
  if (!candidate) return {
    table_topology: metric({ availability: "unavailable", numerator: 0, denominator: 3, score: 0 }),
    table_cells: metric({ availability: "unavailable", numerator: 0, denominator: fixture.expected.table.cells.length, score: 0 }),
  };
  const expected = fixture.expected.table;
  const topology = [
    candidate.row_count === expected.row_count,
    candidate.column_count === expected.column_count,
    JSON.stringify(candidate.merged_cells ?? []) === JSON.stringify(expected.merged_cells),
  ];
  const cellToken = cell => `${cell.row}:${cell.column}:${JSON.stringify(cell.value)}`;
  const remainingExpected = new Map();
  for (const cell of expected.cells) {
    const token = cellToken(cell);
    remainingExpected.set(token, (remainingExpected.get(token) ?? 0) + 1);
  }
  let matchedCells = 0;
  let spuriousCells = 0;
  for (const cell of candidate.cells ?? []) {
    const token = cellToken(cell);
    const remaining = remainingExpected.get(token) ?? 0;
    if (remaining > 0) {
      matchedCells += 1;
      remainingExpected.set(token, remaining - 1);
    } else {
      spuriousCells += 1;
    }
  }
  const missingCells = expected.cells.length - matchedCells;
  const precision = matchedCells + spuriousCells === 0 ? 0 : matchedCells / (matchedCells + spuriousCells);
  const recall = expected.cells.length === 0 ? 1 : matchedCells / expected.cells.length;
  const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
  return {
    table_topology: metric({ numerator: topology.filter(Boolean).length, denominator: topology.length, score: topology.filter(Boolean).length / topology.length }),
    table_cells: metric({
      numerator: matchedCells,
      denominator: expected.cells.length,
      score: f1,
      true_positive: matchedCells,
      missing: missingCells,
      spurious: spuriousCells,
      precision,
      recall,
      f1,
    }),
  };
}

function intersectionArea(left, right) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

function bboxMatchesTruth(candidate, truth, geometry, policy) {
  if (!candidate || !truth || !geometry || candidate.coordinate_space !== truth.coordinate_space) return false;
  if (candidate.width <= 0 || candidate.height <= 0) return false;
  const page = geometry.media_box;
  const withinPage = candidate.x >= page.x
    && candidate.y >= page.y
    && candidate.x + candidate.width <= page.x + page.width
    && candidate.y + candidate.height <= page.y + page.height;
  if (!withinPage) return false;
  const candidateArea = candidate.width * candidate.height;
  const truthArea = truth.width * truth.height;
  const overlap = intersectionArea(candidate, truth);
  const union = candidateArea + truthArea - overlap;
  const iou = union === 0 ? 0 : overlap / union;
  const truthContainment = truthArea === 0 ? 0 : overlap / truthArea;
  const pageAreaRatio = candidateArea / (page.width * page.height);
  return iou >= policy.minimum_iou
    && truthContainment >= policy.minimum_truth_containment
    && pageAreaRatio <= policy.maximum_page_area_ratio;
}

function scoreEvidence(fixture, observation, evaluationPolicy) {
  const bboxPolicy = evaluationPolicy?.evidence_bbox;
  if (!bboxPolicy) throw new Error("Missing manifest-pinned evidence bbox policy");
  const pageEvidence = new Map((observation.evidence ?? [])
    .filter(item => item.kind === "page"
      && item.source_sha256 === fixture.sha256
      && item.result_sha256 === observation.page_result_sha256)
    .map(item => [item.page, item]));
  let pageSupported = 0;
  let factSupported = 0;
  let bboxSupported = 0;
  for (const fact of fixture.expected.facts) {
    const evidence = pageEvidence.get(fact.page);
    const geometry = fixture.expected.page_geometry.find(page => page.page === fact.page);
    const pageBound = evidence && normalizeText(evidence.text).includes(fact.anchor_text);
    if (pageBound) pageSupported += 1;
    const factBound = pageBound && evidence.fact_ids?.includes(fact.id);
    if (factBound) factSupported += 1;
    const bboxValid = bboxMatchesTruth(evidence?.bbox, fact.bbox, geometry, bboxPolicy);
    if (factBound && bboxValid) bboxSupported += 1;
  }
  const total = fixture.expected.facts.length;
  return {
    evidence_page: metric({ applicable: total > 0, availability: total > 0 ? "measured" : "not_applicable", numerator: pageSupported, denominator: total, score: total > 0 ? pageSupported / total : null }),
    evidence_bbox: metric({ applicable: total > 0, availability: total > 0 ? (bboxSupported > 0 ? "measured" : "unavailable") : "not_applicable", numerator: bboxSupported, denominator: total, score: total > 0 ? bboxSupported / total : null }),
    evidence_fact: metric({ applicable: total > 0, availability: total > 0 ? (factSupported > 0 ? "measured" : "unavailable") : "not_applicable", numerator: factSupported, denominator: total, score: total > 0 ? factSupported / total : null }),
    evidence_answer: metric({ applicable: true, availability: "unavailable", numerator: 0, denominator: 1, score: 0, reason: "No per-answer mapping is implemented" }),
  };
}

export function scoreExtractionCase(fixture, observation, evaluationPolicy) {
  return {
    ...scoreStructured(fixture, observation),
    ...scoreTextAndOcr(fixture, observation),
    ...scoreTable(fixture, observation),
    ...scoreEvidence(fixture, observation, evaluationPolicy),
  };
}
