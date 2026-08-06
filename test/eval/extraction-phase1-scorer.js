import path from "node:path";
import {
  assertSchema,
  canonicalJson,
  deriveTargetLeafPointers,
  reportAttemptKey,
  sha256,
} from "./extraction-phase1-protocol.js";
import { verifyRetainedPhase1Report } from "./extraction-phase1-report-verifier.js";
import { aggregateLayoutCanonicalEvidence, scoreLayoutCanonicalEvidence } from "./extraction-phase1-layout-evidence.js";
import { verifyLayoutOccurrenceOracle } from "../../scripts/eval-generate-extraction-layout-oracle.mjs";

export const PHASE1_SCORER_ID = "pdf-tools.extraction-phase1-scorer.v1";
export const PHASE1_SCORE_REPORT_ID = "pdf-tools.extraction-phase1-score-report.v1";
export const PHASE1_SCORE_INDEX_ID = "pdf-tools.extraction-phase1-score-index.v1";
const DEFAULT_SCORE_PATH = "phase1-score-report.v1.json";
const DEFAULT_INDEX_PATH = "phase1-score-index.v1.json";
export const PHASE1_SCORER_CONTRACT_SHA256 = sha256(Buffer.from(canonicalJson({
  structured: "exact-json-pointer-and-Object.is-v1",
  abstention: "oracle-bound-contract-leaf-v1",
  text: "normalized-whitespace-fragment-order-cer-wer-v1",
  table: "raw-start-cell-and-canonical-span-v1",
  stability: "response-without-request-id-or-runner-outcome-v1",
  evidence_credit: "source-validated-layout-ir-scorer-only-page-bbox-fact-answer-v1",
})));

const SUCCESS_OUTCOMES = new Set(["completed", "partial", "abstained"]);
const EXACT_ORACLE_KEYS = ["cases", "manifest_bytes_sha256", "manifest_schema_bytes_sha256", "manifest_schema_sha256", "oracle_id", "oracle_version", "phase0_manifest_sha256"];
const EXACT_ORACLE_CASE_KEYS = ["case_id", "contract_leaf_policies", "expected_pages_sha256", "expected_table_sha256", "fact_ids", "target_schema_sha256", "truth_leaves"];
const EXACT_POLICY_KEYS = ["allowed_gap_reasons", "expected_decision", "field_path"];
const EXACT_TRUTH_LEAF_KEYS = ["contract_path", "disposition", "fact_support", "field_path", "value"];
const EXACT_FACT_SUPPORT_KEYS = ["fact_ids", "mode"];
export const PHASE1_SCORER_LOCAL_SOURCE_PATHS = Object.freeze({
  accessibility_inspection_module: "server/accessibility-inspection.js",
  artifact_config_schema: "test/fixtures/eval/extraction/phase1/artifact-config.schema.json",
  artifact_inventory_schema: "test/fixtures/eval/extraction/phase1/artifact-inventory.schema.json",
  artifact_module: "test/eval/extraction-phase1-artifacts.js",
  companion_module: "test/eval/extraction-phase1-companion.js",
  companion_schema: "test/fixtures/eval/extraction/phase1/execution-companion.schema.json",
  corpus_module: "test/eval/extraction-phase1-corpus.js",
  corpus_schema: "test/fixtures/eval/extraction/phase1/corpus.schema.json",
  execution_index_schema: "test/fixtures/eval/extraction/phase1/execution-index.schema.json",
  generation_privacy_schema: "test/fixtures/eval/extraction/phase1/generation-privacy.schema.json",
  generation_verifier_common_module: "test/eval/extraction-phase1-generation-verifier-common.js",
  index_schema: "test/fixtures/eval/extraction/phase1/score-index.schema.json",
  layout_evidence_module: "test/eval/extraction-phase1-layout-evidence.js",
  layout_extraction_module: "server/layout-extraction.js",
  type3_cm_reference_module: "server/type3-cm-reference.js",
  layout_oracle: "test/fixtures/eval/extraction/phase1/layout-occurrence-oracle.v1.json",
  layout_oracle_generator: "scripts/eval-generate-extraction-layout-oracle.mjs",
  layout_oracle_schema: "test/fixtures/eval/extraction/phase1/layout-occurrence-oracle.schema.json",
  manifest_schema: "test/fixtures/eval/extraction/manifest.schema.json",
  markdown_conversion_module: "server/markdown-conversion.js",
  mcp_sdk_package: "node_modules/@modelcontextprotocol/sdk/package.json",
  oracle_schema: "test/fixtures/eval/extraction/phase1/scoring-oracle.schema.json",
  orchestration_script: "scripts/eval-score-extraction-candidates.mjs",
  output_schemas_module: "server/output-schemas.js",
  package_json: "package.json",
  package_lock: "package-lock.json",
  pdf_comparison_module: "server/pdf-comparison.js",
  pdf_observations_module: "server/pdf-observations.js",
  pdf_lib_package: "node_modules/pdf-lib/package.json",
  pdfjs_package: "node_modules/pdfjs-dist/package.json",
  plan_schema: "test/fixtures/eval/extraction/phase1/run-plan.schema.json",
  protocol_module: "test/eval/extraction-phase1-protocol.js",
  publisher_module: "test/eval/extraction-phase1-publisher.js",
  receipt_schema: "test/fixtures/eval/extraction/phase1/cross-device-receipt.schema.json",
  registry_schema: "test/fixtures/eval/extraction/phase1/candidate-registry.schema.json",
  report_schema: "test/fixtures/eval/extraction/phase1/report.schema.json",
  report_verifier_module: "test/eval/extraction-phase1-report-verifier.js",
  request_schema: "test/fixtures/eval/extraction/phase1/candidate-request.schema.json",
  response_schema: "test/fixtures/eval/extraction/phase1/candidate-response.schema.json",
  score_generation_verifier_module: "test/eval/extraction-phase1-score-generation-verifier.js",
  score_schema: "test/fixtures/eval/extraction/phase1/score-report.schema.json",
  scorer_module: "test/eval/extraction-phase1-scorer.js",
  scoring_oracle: "test/fixtures/eval/extraction/phase1/scoring-oracle.v1.json",
});
const REQUIRED_SCORER_SOURCE_ROLES = Object.freeze(Object.keys(PHASE1_SCORER_LOCAL_SOURCE_PATHS).sort());
const REQUIRED_SCORER_PARSED_JSON_ROLES = Object.freeze([
  "artifact_config_schema", "artifact_inventory_schema", "companion_schema", "corpus_schema", "execution_index_schema",
  "generation_privacy_schema", "index_schema", "layout_oracle", "layout_oracle_schema", "manifest_schema",
  "mcp_sdk_package", "oracle_schema", "package_json", "package_lock", "pdf_lib_package", "pdfjs_package",
  "plan_schema", "receipt_schema", "registry_schema", "report_schema", "request_schema", "response_schema",
  "score_schema", "scoring_oracle",
]);

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function f1(precision, recall) {
  if (precision === null || recall === null) return null;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function pointerToken(value) {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function flattenScoringLeaves(value, pointer = "") {
  if (Array.isArray(value)) {
    if (value.length === 0) return [[pointer, []]];
    return value.flatMap((item, index) => flattenScoringLeaves(item, `${pointer}/${index}`));
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) return [[pointer, {}]];
    return keys.flatMap(key => flattenScoringLeaves(value[key], `${pointer}/${pointerToken(key)}`));
  }
  return [[pointer, value]];
}

function valueAtPointer(value, pointer) {
  if (pointer === "") return { found: true, value };
  let current = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || current === undefined || !Object.hasOwn(current, key)) {
      return { found: false, value: undefined };
    }
    current = current[key];
  }
  return { found: true, value: current };
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} has unexpected keys`);
  }
}

function schemaAtPointer(schema, pointer) {
  let current = schema;
  if (pointer === "") return current;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current?.type === "object") current = current.properties?.[key];
    else if (current?.type === "array") current = current.items;
    else return null;
  }
  return current ?? null;
}

export function validatePhase1ScoringOracle(oracle, oracleSchema, manifest, {
  manifestBytesSha256,
  manifestSchema,
  manifestSchemaBytesSha256,
} = {}) {
  assertSchema(oracle, oracleSchema, "extraction Phase 1 scoring oracle");
  exactKeys(oracle, EXACT_ORACLE_KEYS, "Extraction scoring oracle");
  const manifestDigest = sha256(Buffer.from(canonicalJson(manifest)));
  if (oracle.oracle_id !== "pdf-tools.extraction-phase1-scoring-oracle.v1"
    || oracle.oracle_version !== 1
    || oracle.phase0_manifest_sha256 !== manifestDigest
    || oracle.manifest_bytes_sha256 !== manifestBytesSha256
    || oracle.manifest_schema_sha256 !== sha256(Buffer.from(canonicalJson(manifestSchema)))
    || oracle.manifest_schema_bytes_sha256 !== manifestSchemaBytesSha256) {
    throw new Error("Extraction scoring oracle is not bound to the exact Phase 0 manifest");
  }
  if (canonicalJson(oracle.cases.map(item => item.case_id))
    !== canonicalJson(manifest.fixtures.map(item => item.id))) {
    throw new Error("Extraction scoring oracle case order or denominator drifted");
  }
  for (const [index, oracleCase] of oracle.cases.entries()) {
    exactKeys(oracleCase, EXACT_ORACLE_CASE_KEYS, `Extraction scoring oracle case ${oracleCase.case_id}`);
    const fixture = manifest.fixtures[index];
    const contractLeaves = deriveTargetLeafPointers(fixture.target_schema);
    if (oracleCase.target_schema_sha256 !== sha256(Buffer.from(canonicalJson(fixture.target_schema)))
      || oracleCase.expected_pages_sha256 !== sha256(Buffer.from(canonicalJson(fixture.expected.pages)))
      || oracleCase.expected_table_sha256 !== sha256(Buffer.from(canonicalJson(fixture.expected.table)))
      || canonicalJson(oracleCase.fact_ids) !== canonicalJson(fixture.expected.facts.map(fact => fact.id))) {
      throw new Error(`Extraction scoring oracle schema, truth, or fact bindings drifted for ${fixture.id}`);
    }
    if (canonicalJson(oracleCase.contract_leaf_policies.map(item => item.field_path)) !== canonicalJson(contractLeaves)) {
      throw new Error(`Extraction scoring oracle contract leaves drifted for ${fixture.id}`);
    }
    for (const policy of oracleCase.contract_leaf_policies) {
      exactKeys(policy, EXACT_POLICY_KEYS, `Extraction scoring policy ${fixture.id}${policy.field_path}`);
      if (!schemaAtPointer(fixture.target_schema, policy.field_path)) {
        throw new Error(`Extraction scoring oracle references a non-schema leaf for ${fixture.id}`);
      }
      if (policy.expected_decision === "answer" && policy.allowed_gap_reasons.length !== 0) {
        throw new Error(`Answer policy cannot authorize gap reasons for ${fixture.id}${policy.field_path}`);
      }
      if (policy.expected_decision === "abstain" && policy.allowed_gap_reasons.length === 0) {
        throw new Error(`Abstention policy requires a typed reason for ${fixture.id}${policy.field_path}`);
      }
    }
    const flattenedTruth = flattenScoringLeaves(fixture.ground_truth);
    if (oracleCase.truth_leaves.length !== flattenedTruth.length) throw new Error(`Extraction scoring oracle truth denominator drifted for ${fixture.id}`);
    const fixtureFactIds = new Set(fixture.expected.facts.map(fact => fact.id));
    const factById = new Map(fixture.expected.facts.map(fact => [fact.id, fact]));
    for (const [leafIndex, leaf] of oracleCase.truth_leaves.entries()) {
      exactKeys(leaf, EXACT_TRUTH_LEAF_KEYS, `Extraction scoring truth leaf ${fixture.id}${leaf.field_path}`);
      exactKeys(leaf.fact_support, EXACT_FACT_SUPPORT_KEYS, `Extraction scoring fact support ${fixture.id}${leaf.field_path}`);
      const [fieldPath, value] = flattenedTruth[leafIndex];
      const policy = oracleCase.contract_leaf_policies.find(item => item.field_path === leaf.contract_path);
      if (leaf.field_path !== fieldPath || !Object.is(leaf.value, value) || !policy
        || !(leaf.field_path === leaf.contract_path || leaf.field_path.startsWith(`${leaf.contract_path}/`))
        || leaf.disposition !== policy.expected_decision
        || leaf.fact_support.fact_ids.some(factId => !fixtureFactIds.has(factId))
        || leaf.fact_support.fact_ids.some(factId => {
          const factPath = factById.get(factId)?.field_path;
          return !(leaf.field_path === factPath || leaf.field_path.startsWith(`${factPath}/`));
        })
        || (leaf.fact_support.mode === "none") !== (leaf.fact_support.fact_ids.length === 0)) {
        throw new Error(`Extraction scoring oracle truth leaf is not exactly bound for ${fixture.id}${fieldPath}`);
      }
    }
  }
  return true;
}

function normalizedText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function exactEditDistance(actualIterable, expectedIterable) {
  const expected = Array.isArray(expectedIterable) ? expectedIterable : [...expectedIterable];
  if (expected.length === 0) {
    if (typeof actualIterable === "string" || Array.isArray(actualIterable)) return [...actualIterable].length;
    let length = 0;
    for (const ignored of actualIterable) length += 1;
    return length;
  }
  const width = BigInt(expected.length);
  const allBits = (1n << width) - 1n;
  const highBit = 1n << (width - 1n);
  const equalityMasks = new Map();
  for (const [index, token] of expected.entries()) {
    equalityMasks.set(token, (equalityMasks.get(token) ?? 0n) | (1n << BigInt(index)));
  }
  let positive = allBits;
  let negative = 0n;
  let distance = expected.length;
  for (const token of actualIterable) {
    const equal = equalityMasks.get(token) ?? 0n;
    const vertical = equal | negative;
    const horizontal = ((((equal & positive) + positive) ^ positive) | equal) & allBits;
    let positiveHorizontal = (negative | ~(horizontal | positive)) & allBits;
    let negativeHorizontal = positive & horizontal;
    if ((positiveHorizontal & highBit) !== 0n) distance += 1;
    else if ((negativeHorizontal & highBit) !== 0n) distance -= 1;
    positiveHorizontal = ((positiveHorizontal << 1n) | 1n) & allBits;
    negativeHorizontal = (negativeHorizontal << 1n) & allBits;
    positive = (negativeHorizontal | ~(vertical | positiveHorizontal)) & allBits;
    negative = positiveHorizontal & vertical;
  }
  return distance;
}

export function scoreDistinctFragmentSequence(text, fragments) {
  const used = [];
  let orderedCursor = 0;
  let found = 0;
  let orderedFound = 0;
  let ordered = true;
  for (const fragment of fragments) {
    let index = text.indexOf(fragment);
    while (index >= 0 && used.some(range => index < range.end && index + fragment.length > range.start)) {
      index = text.indexOf(fragment, index + 1);
    }
    if (index >= 0) {
      found += 1;
      used.push({ start: index, end: index + fragment.length });
    }
    const orderedIndex = text.indexOf(fragment, orderedCursor);
    if (orderedIndex < 0) ordered = false;
    else {
      orderedFound += 1;
      orderedCursor = orderedIndex + fragment.length;
    }
  }
  return { found, ordered_found: orderedFound, ordered };
}

function arrayParent(pointer) {
  const match = pointer.match(/^(.*)\/[0-9]+(?:\/.*)?$/);
  return match?.[1] ?? null;
}

function scoreStructured(fixture, oracleCase, response, eligible) {
  const candidate = response && (response.status === "completed" || response.status === "partial")
    ? response.structured_candidate
    : null;
  const policyByPath = new Map(oracleCase.contract_leaf_policies.map(policy => [policy.field_path, policy]));
  const contractFor = pointer => [...policyByPath.keys()].find(contractPath => pointer === contractPath || pointer.startsWith(`${contractPath}/`));
  const allCandidateLeaves = candidate === null ? [] : flattenScoringLeaves(candidate);
  const allTruthLeaves = flattenScoringLeaves(fixture.ground_truth);
  const truthLeaves = allTruthLeaves.filter(([pointer]) => policyByPath.get(contractFor(pointer))?.expected_decision === "answer");
  const candidateLeaves = allCandidateLeaves.filter(([pointer]) => policyByPath.get(contractFor(pointer))?.expected_decision === "answer");
  const candidateByPointer = new Map(candidateLeaves);
  const truthByPointer = new Map(truthLeaves);
  let correct = 0;
  let wrong = 0;
  let missing = 0;
  let shiftedArray = 0;
  if (eligible) for (const [pointer, expected] of truthLeaves) {
    if (!candidateByPointer.has(pointer)) {
      missing += 1;
      continue;
    }
    if (Object.is(candidateByPointer.get(pointer), expected)) correct += 1;
    else {
      wrong += 1;
      const parent = arrayParent(pointer);
      if (parent !== null && candidateLeaves.some(([candidatePointer, value]) =>
        candidatePointer !== pointer && arrayParent(candidatePointer) === parent && Object.is(value, expected))) {
        shiftedArray += 1;
      }
    }
  }
  const spurious = eligible ? candidateLeaves.filter(([pointer]) => !truthByPointer.has(pointer)).length : 0;
  const gaps = new Map((response?.gaps ?? []).map(gap => [gap.field_path, gap]));
  let answeredExpected = 0;
  let correctlyAbstained = 0;
  let falseAnswers = 0;
  let falseAbstentions = 0;
  let typedGapCorrect = 0;
  let typedGapWrongReason = 0;
  let expectedAnswer = 0;
  let expectedAbstain = 0;
  if (eligible) for (const policy of oracleCase.contract_leaf_policies) {
    const answered = candidate !== null && valueAtPointer(candidate, policy.field_path).found;
    const gap = gaps.get(policy.field_path);
    if (policy.expected_decision === "answer") {
      expectedAnswer += 1;
      if (answered) answeredExpected += 1;
      else {
        falseAbstentions += 1;
        if (gap) typedGapWrongReason += 1;
      }
    } else {
      expectedAbstain += 1;
      if (answered) falseAnswers += 1;
      else if (gap && policy.allowed_gap_reasons.includes(gap.reason)) {
        correctlyAbstained += 1;
        typedGapCorrect += 1;
      } else if (gap) typedGapWrongReason += 1;
    }
  }
  const dataPrecision = ratio(correct, correct + wrong + spurious);
  const dataRecall = ratio(correct, eligible ? truthLeaves.length : 0);
  return {
    available: eligible,
    schema_valid: eligible && candidate !== null ? true : null,
    schema_scope: candidate === null ? "not_applicable" : response.status === "partial" ? "answered_projection" : "complete_target",
    contract_leaves: {
      total: oracleCase.contract_leaf_policies.length,
      expected_answer: expectedAnswer,
      expected_abstain: expectedAbstain,
      answered_expected: answeredExpected,
      correctly_abstained: correctlyAbstained,
      false_answers: falseAnswers,
      false_abstentions: falseAbstentions,
      typed_gap_correct: typedGapCorrect,
      typed_gap_wrong_reason: typedGapWrongReason,
      false_answer_rate: ratio(falseAnswers, expectedAbstain),
      selective_abstention_coverage: ratio(correctlyAbstained, expectedAbstain),
      selective_abstention_accuracy: ratio(typedGapCorrect, typedGapCorrect + typedGapWrongReason + falseAnswers),
    },
    data_leaves: {
      truth: eligible ? truthLeaves.length : 0,
      candidate: eligible ? candidateLeaves.length : 0,
      correct,
      wrong,
      missing,
      spurious,
      shifted_array: shiftedArray,
      precision: dataPrecision,
      recall: dataRecall,
      f1: f1(dataPrecision, dataRecall),
    },
  };
}

function scoreText(fixture, response, eligible) {
  const pageTexts = new Map();
  for (const pageText of response?.page_texts ?? []) {
    const prior = pageTexts.get(pageText.page) ?? [];
    prior.push(pageText.text);
    pageTexts.set(pageText.page, prior);
  }
  const expectedPageNumbers = new Set(fixture.expected.pages.map(page => page.page));
  const duplicatePages = [...pageTexts.values()].reduce((total, values) => total + Math.max(0, values.length - 1), 0);
  const spuriousPages = [...pageTexts.entries()].filter(([page]) => !expectedPageNumbers.has(page)).reduce((total, [, values]) => total + values.length, 0);
  const result = {
    available: eligible,
    pages: eligible ? fixture.expected.pages.length : 0,
    pages_present: 0,
    duplicate_pages: eligible ? duplicatePages : 0,
    spurious_pages: eligible ? spuriousPages : 0,
    fragments: 0,
    fragments_found: 0,
    ordered_pages: 0,
    ordered_fragments_found: 0,
    character_distance: 0,
    characters: 0,
    word_distance: 0,
    words: 0,
    fragment_recall: null,
    reading_order_accuracy: null,
    ordered_fragment_recall: null,
    cer: null,
    wer: null,
  };
  if (!eligible) return result;
  for (const expectedPage of fixture.expected.pages) {
    const values = pageTexts.get(expectedPage.page) ?? [];
    const text = values.length === 1 ? normalizedText(values[0]) : "";
    const expected = normalizedText(expectedPage.transcript);
    if (pageTexts.has(expectedPage.page)) result.pages_present += 1;
    const coverage = scoreDistinctFragmentSequence(text, expectedPage.ordered_fragments);
    result.fragments += expectedPage.ordered_fragments.length;
    result.fragments_found += coverage.found;
    result.ordered_fragments_found += coverage.ordered_found;
    result.ordered_pages += coverage.ordered ? 1 : 0;
    result.character_distance += exactEditDistance(text, expected);
    result.characters += [...expected].length;
    const actualWords = text ? text.split(" ") : [];
    const expectedWords = expected ? expected.split(" ") : [];
    result.word_distance += exactEditDistance(actualWords, expectedWords);
    result.words += expectedWords.length;
  }
  result.fragment_recall = ratio(result.fragments_found, result.fragments);
  result.reading_order_accuracy = ratio(result.ordered_pages, result.pages);
  result.ordered_fragment_recall = ratio(result.ordered_fragments_found, result.fragments);
  result.cer = ratio(result.character_distance, result.characters);
  result.wer = ratio(result.word_distance, result.words);
  return result;
}

function expectedRegions(table) {
  return table.merged_cells.map(value => {
    const match = /^R([0-9]+)C([0-9]+):R([0-9]+)C([0-9]+)$/.exec(value);
    return { start_row: Number(match[1]), start_column: Number(match[2]), end_row: Number(match[3]), end_column: Number(match[4]) };
  });
}

function classifiedCellCounts(expectedCells, candidateByCoordinate, predicate) {
  const selected = expectedCells.filter(cell => predicate(cell.value));
  let correct = 0;
  let wrong = 0;
  let missing = 0;
  for (const cell of selected) {
    const candidate = candidateByCoordinate.get(`${cell.row}:${cell.column}`);
    if (!candidate) missing += 1;
    else if (Object.is(candidate.value, cell.value)) correct += 1;
    else wrong += 1;
  }
  return { expected: selected.length, correct, wrong, missing };
}

export function scoreRawTableValueClass(expectedCells, candidateCells, predicate) {
  return classifiedCellCounts(
    expectedCells,
    new Map(candidateCells.map(cell => [`${cell.row}:${cell.column}`, cell])),
    predicate,
  );
}

function tableRates(result) {
  const cellPrecision = ratio(result.cells.correct, result.cells.correct + result.cells.wrong + result.cells.spurious);
  const cellRecall = ratio(result.cells.correct, result.cells.expected);
  const spanPrecision = ratio(result.spans.correct, result.spans.correct + result.spans.spurious);
  const spanRecall = ratio(result.spans.correct, result.spans.expected);
  result.cells.precision = cellPrecision;
  result.cells.recall = cellRecall;
  result.cells.f1 = f1(cellPrecision, cellRecall);
  result.topology.accuracy = ratio(result.topology.correct, result.topology.expected);
  result.spans.precision = spanPrecision;
  result.spans.recall = spanRecall;
  result.spans.f1 = f1(spanPrecision, spanRecall);
  return result;
}

function tableSelectionRank(table, expected) {
  const expectedByCoordinate = new Map(expected.cells.map(cell => [`${cell.row}:${cell.column}`, cell]));
  const candidateByCoordinate = new Map(table.cells.map(cell => [`${cell.row}:${cell.column}`, cell]));
  const expectedSpans = expectedRegions(expected);
  let exactCells = 0;
  let wrongCells = 0;
  let missingCells = 0;
  for (const [coordinate, expectedCell] of expectedByCoordinate) {
    const candidateCell = candidateByCoordinate.get(coordinate);
    if (!candidateCell) missingCells += 1;
    else if (Object.is(candidateCell.value, expectedCell.value)) exactCells += 1;
    else wrongCells += 1;
  }
  const spuriousCells = [...candidateByCoordinate.keys()].filter(key => !expectedByCoordinate.has(key)).length;
  const topology = Number(table.row_count === expected.row_count)
    + Number(table.column_count === expected.column_count)
    + Number(canonicalJson(table.merged_regions) === canonicalJson(expectedSpans));
  return [-topology, -exactCells, wrongCells, missingCells, spuriousCells, canonicalJson(table)];
}

function compareRanks(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function scoreTable(fixture, response, eligible) {
  const expected = fixture.expected.table;
  const candidates = response?.tables ?? [];
  if (!eligible) return tableRates({
    available: false, applicable: Boolean(expected), expected_tables: 0, observed_tables: 0, missing_tables: 0, spurious_tables: 0,
    detected: false, candidate_tables: 0, topology: { correct: 0, expected: 0 },
    spans: { correct: 0, expected: 0, spurious: 0 }, cells: { correct: 0, expected: 0, wrong: 0, missing: 0, spurious: 0 },
    blank: { expected: 0, correct: 0, wrong: 0, missing: 0 }, null: { expected: 0, correct: 0, wrong: 0, missing: 0 }, zero: { expected: 0, correct: 0, wrong: 0, missing: 0 },
  });
  const matching = expected ? candidates.filter(table => table.pages.includes(expected.page)) : [];
  const candidate = expected && matching.length > 0
    ? [...matching].sort((left, right) => compareRanks(tableSelectionRank(left, expected), tableSelectionRank(right, expected)))[0]
    : null;
  const emptyClass = { expected: 0, correct: 0, wrong: 0, missing: 0 };
  if (!expected) return tableRates({
    available: eligible,
    applicable: false,
    expected_tables: 0,
    observed_tables: candidates.length,
    missing_tables: 0,
    spurious_tables: candidates.length,
    detected: candidates.length === 0,
    candidate_tables: candidates.length,
    topology: { correct: 0, expected: 0 },
    spans: { correct: 0, expected: 0, spurious: candidates.flatMap(table => table.merged_regions).length },
    cells: { correct: 0, expected: 0, wrong: 0, missing: 0, spurious: candidates.flatMap(table => table.cells).length },
    blank: emptyClass, null: emptyClass, zero: emptyClass,
  });
  const expectedByCoordinate = new Map(expected.cells.map(cell => [`${cell.row}:${cell.column}`, cell]));
  const candidateByCoordinate = new Map((candidate?.cells ?? []).map(cell => [`${cell.row}:${cell.column}`, cell]));
  let correct = 0;
  let wrong = 0;
  let missing = 0;
  for (const expectedCell of expected.cells) {
    const candidateCell = candidateByCoordinate.get(`${expectedCell.row}:${expectedCell.column}`);
    if (!candidateCell) missing += 1;
    else if (Object.is(candidateCell.value, expectedCell.value)) correct += 1;
    else wrong += 1;
  }
  const spurious = [...candidateByCoordinate.keys()].filter(key => !expectedByCoordinate.has(key)).length
    + candidates.filter(table => table !== candidate).flatMap(table => table.cells).length;
  const expectedSpans = expectedRegions(expected);
  const candidateSpans = candidate?.merged_regions ?? [];
  const regionTokens = values => values.map(value => canonicalJson(value));
  const expectedSpanTokens = new Set(regionTokens(expectedSpans));
  const candidateSpanTokens = regionTokens(candidateSpans);
  const spansCorrect = candidateSpanTokens.filter(value => expectedSpanTokens.has(value)).length;
  const extraSpanCount = candidates.filter(table => table !== candidate).flatMap(table => table.merged_regions).length;
  return tableRates({
    available: eligible,
    applicable: true,
    expected_tables: 1,
    observed_tables: candidates.length,
    missing_tables: candidate ? 0 : 1,
    spurious_tables: candidate ? Math.max(0, candidates.length - 1) : candidates.length,
    detected: Boolean(candidate),
    candidate_tables: candidates.length,
    topology: {
      correct: candidate
        ? Number(candidate.row_count === expected.row_count)
          + Number(candidate.column_count === expected.column_count)
          + Number(canonicalJson(candidate.merged_regions) === canonicalJson(expectedSpans))
        : 0,
      expected: 3,
    },
    spans: { correct: spansCorrect, expected: expectedSpans.length, spurious: candidateSpanTokens.filter(value => !expectedSpanTokens.has(value)).length + extraSpanCount },
    cells: { correct, expected: expected.cells.length, wrong, missing, spurious },
    blank: classifiedCellCounts(expected.cells, candidateByCoordinate, value => value === ""),
    null: classifiedCellCounts(expected.cells, candidateByCoordinate, value => value === null),
    zero: classifiedCellCounts(expected.cells, candidateByCoordinate, value => value === 0 || value === "0"),
  });
}

function semanticDigest(attempt) {
  if (attempt.response) {
    const response = structuredClone(attempt.response);
    delete response.request_id;
    return sha256(Buffer.from(canonicalJson(response)));
  }
  return sha256(Buffer.from(canonicalJson({
    outcome: attempt.outcome,
    outcome_reason: attempt.outcome_reason,
    error_code: attempt.error_code,
    unmet_requirements: attempt.unmet_requirements,
    failure: attempt.failure,
  })));
}

function scoreAttempt(attempt, fixture, oracleCase, layoutOracleCase, reconciliation) {
  const eligible = SUCCESS_OUTCOMES.has(attempt.outcome) && Boolean(attempt.response);
  const scored = {
    attempt_key: reportAttemptKey(attempt),
    candidate_id: attempt.candidate_id,
    case_id: attempt.case_id,
    repetition: attempt.repetition,
    outcome: attempt.outcome,
    quality_available: eligible,
    semantic_sha256: semanticDigest(attempt),
    structured: scoreStructured(fixture, oracleCase, attempt.response, eligible),
    text: scoreText(fixture, attempt.response, eligible),
    table: scoreTable(fixture, attempt.response, eligible),
    canonical_evidence: scoreLayoutCanonicalEvidence({
      fixture,
      oracleCase,
      layoutOracleCase,
      response: attempt.response,
      reconciliation,
      layout: attempt.request?.inputs?.layout_ir ?? null,
    }),
    resources: {
      spawned: attempt.execution.spawned,
      elapsed_ms: attempt.execution.elapsed_ms,
      stdout_bytes: attempt.execution.stdout_bytes,
      stderr_bytes: attempt.execution.stderr_bytes,
      source_bytes: attempt.source.size_bytes,
      request_bytes: attempt.request === null ? null : Buffer.byteLength(canonicalJson(attempt.request)),
      source_immutable: attempt.source.immutable,
      timed_out: attempt.execution.timed_out,
      stdout_limit_exceeded: attempt.execution.stdout_limit_exceeded,
      stderr_limit_exceeded: attempt.execution.stderr_limit_exceeded,
      process_group_termination_attempted: attempt.execution.process_group_termination_attempted,
      process_group_empty_after_cleanup: attempt.execution.process_group_empty_after_cleanup,
      process_tree_peak_rss_bytes: null,
      network_egress_bytes: null,
    },
  };
  return scored;
}

function sum(attempts, selector) {
  return attempts.reduce((total, attempt) => total + selector(attempt), 0);
}

function aggregate(attempts, report, registry, manifest) {
  const configuredIds = new Set(registry.candidates.filter(candidate => candidate.configured).map(candidate => candidate.id));
  const result = {
    denominator: {
      planned: report.denominator.planned,
      retained: attempts.length,
      configured: attempts.filter(attempt => configuredIds.has(attempt.candidate_id)).length,
      spawned: attempts.filter(attempt => attempt.resources.spawned).length,
      quality_available: attempts.filter(attempt => attempt.quality_available).length,
      configured_quality_coverage: null,
      outcomes: structuredClone(report.denominator.outcomes),
    },
    structured: {
      truth_data_leaves: sum(attempts, item => item.structured.data_leaves.truth),
      candidate_data_leaves: sum(attempts, item => item.structured.data_leaves.candidate),
      correct: sum(attempts, item => item.structured.data_leaves.correct),
      wrong: sum(attempts, item => item.structured.data_leaves.wrong),
      missing: sum(attempts, item => item.structured.data_leaves.missing),
      spurious: sum(attempts, item => item.structured.data_leaves.spurious),
      shifted_array: sum(attempts, item => item.structured.data_leaves.shifted_array),
      false_answers: sum(attempts, item => item.structured.contract_leaves.false_answers),
      false_abstentions: sum(attempts, item => item.structured.contract_leaves.false_abstentions),
      correctly_abstained: sum(attempts, item => item.structured.contract_leaves.correctly_abstained),
      typed_gap_correct: sum(attempts, item => item.structured.contract_leaves.typed_gap_correct),
      typed_gap_wrong_reason: sum(attempts, item => item.structured.contract_leaves.typed_gap_wrong_reason),
      precision: null,
      recall: null,
      f1: null,
      false_answer_rate: null,
      selective_abstention_coverage: null,
      selective_abstention_accuracy: null,
    },
    text: {
      pages: sum(attempts, item => item.text.pages),
      pages_present: sum(attempts, item => item.text.pages_present),
      duplicate_pages: sum(attempts, item => item.text.duplicate_pages),
      spurious_pages: sum(attempts, item => item.text.spurious_pages),
      fragments: sum(attempts, item => item.text.fragments),
      fragments_found: sum(attempts, item => item.text.fragments_found),
      ordered_pages: sum(attempts, item => item.text.ordered_pages),
      ordered_fragments_found: sum(attempts, item => item.text.ordered_fragments_found),
      character_distance: sum(attempts, item => item.text.character_distance),
      characters: sum(attempts, item => item.text.characters),
      word_distance: sum(attempts, item => item.text.word_distance),
      words: sum(attempts, item => item.text.words),
      fragment_recall: null,
      reading_order_accuracy: null,
      ordered_fragment_recall: null,
      cer: null,
      wer: null,
    },
    table: {
      applicable_attempts: attempts.filter(item => item.quality_available && item.table.applicable).length,
      detected: attempts.filter(item => item.quality_available && item.table.applicable && item.table.detected).length,
      expected_tables: sum(attempts, item => item.table.expected_tables),
      observed_tables: sum(attempts, item => item.table.observed_tables),
      missing_tables: sum(attempts, item => item.table.missing_tables),
      spurious_tables: sum(attempts, item => item.table.spurious_tables),
      cells_correct: sum(attempts, item => item.table.cells.correct),
      cells_expected: sum(attempts, item => item.table.cells.expected),
      cells_wrong: sum(attempts, item => item.table.cells.wrong),
      cells_missing: sum(attempts, item => item.table.cells.missing),
      cells_spurious: sum(attempts, item => item.table.cells.spurious),
      spans_correct: sum(attempts, item => item.table.spans.correct),
      spans_expected: sum(attempts, item => item.table.spans.expected),
      spans_spurious: sum(attempts, item => item.table.spans.spurious),
      cell_precision: null,
      cell_recall: null,
      cell_f1: null,
      topology_accuracy: null,
      span_precision: null,
      span_recall: null,
      span_f1: null,
    },
    resources: {
      elapsed_ms_total: sum(attempts, item => item.resources.elapsed_ms),
      elapsed_ms_max: Math.max(0, ...attempts.map(item => item.resources.elapsed_ms)),
      stdout_bytes: sum(attempts, item => item.resources.stdout_bytes),
      stderr_bytes: sum(attempts, item => item.resources.stderr_bytes),
      source_bytes: sum(attempts, item => item.resources.source_bytes),
      request_bytes: sum(attempts, item => item.resources.request_bytes ?? 0),
      source_immutable: attempts.filter(item => item.resources.source_immutable).length,
      timed_out: attempts.filter(item => item.resources.timed_out).length,
      stdout_limit_exceeded: attempts.filter(item => item.resources.stdout_limit_exceeded).length,
      stderr_limit_exceeded: attempts.filter(item => item.resources.stderr_limit_exceeded).length,
      process_group_termination_attempted: attempts.filter(item => item.resources.process_group_termination_attempted).length,
      process_group_cleanup_failures: attempts.filter(item => item.resources.process_group_empty_after_cleanup === false).length,
      process_tree_peak_rss_bytes: null,
      network_egress_bytes: null,
    },
    privacy_and_isolation: {
      fixture_privacy_class: manifest.fixtures.every(fixture => fixture.privacy.class === "synthetic") ? "synthetic" : "mixed",
      contains_personal_data: manifest.fixtures.some(fixture => fixture.privacy.contains_personal_data),
      filesystem_isolation: report.environment.filesystem_isolation,
      network_isolation: report.environment.network_isolation,
      memory_limit: report.environment.memory_limit,
      process_tree_memory_measurement: report.environment.process_tree_memory_measurement,
      process_group_termination: report.environment.process_group_termination,
      egress_measurement: false,
    },
  };
  result.denominator.configured_quality_coverage = ratio(result.denominator.quality_available, result.denominator.configured);
  result.structured.precision = ratio(result.structured.correct, result.structured.correct + result.structured.wrong + result.structured.spurious);
  result.structured.recall = ratio(result.structured.correct, result.structured.truth_data_leaves);
  result.structured.f1 = f1(result.structured.precision, result.structured.recall);
  const expectedAbstain = sum(attempts, item => item.structured.contract_leaves.expected_abstain);
  result.structured.false_answer_rate = ratio(result.structured.false_answers, expectedAbstain);
  result.structured.selective_abstention_coverage = ratio(result.structured.correctly_abstained, expectedAbstain);
  result.structured.selective_abstention_accuracy = ratio(result.structured.typed_gap_correct, result.structured.typed_gap_correct + result.structured.typed_gap_wrong_reason + result.structured.false_answers);
  result.text.fragment_recall = ratio(result.text.fragments_found, result.text.fragments);
  result.text.reading_order_accuracy = ratio(result.text.ordered_pages, result.text.pages);
  result.text.ordered_fragment_recall = ratio(result.text.ordered_fragments_found, result.text.fragments);
  result.text.cer = ratio(result.text.character_distance, result.text.characters);
  result.text.wer = ratio(result.text.word_distance, result.text.words);
  result.table.cell_precision = ratio(result.table.cells_correct, result.table.cells_correct + result.table.cells_wrong + result.table.cells_spurious);
  result.table.cell_recall = ratio(result.table.cells_correct, result.table.cells_expected);
  result.table.cell_f1 = f1(result.table.cell_precision, result.table.cell_recall);
  result.table.topology_accuracy = ratio(sum(attempts, item => item.table.topology.correct), sum(attempts, item => item.table.topology.expected));
  result.table.span_precision = ratio(result.table.spans_correct, result.table.spans_correct + result.table.spans_spurious);
  result.table.span_recall = ratio(result.table.spans_correct, result.table.spans_expected);
  result.table.span_f1 = f1(result.table.span_precision, result.table.span_recall);
  return result;
}

function stability(attempts, plan) {
  const groups = [];
  for (const selection of plan.candidates) {
    const caseIds = [...new Set(attempts.filter(item => item.candidate_id === selection.candidate_id).map(item => item.case_id))];
    for (const caseId of caseIds) {
      const selected = attempts.filter(item => item.candidate_id === selection.candidate_id && item.case_id === caseId);
      const digests = selected.map(item => item.semantic_sha256);
      groups.push({
        candidate_id: selection.candidate_id,
        case_id: caseId,
        repetitions_expected: plan.repetitions,
        repetitions_observed: selected.length,
        semantic_sha256: digests,
        outcome_consistent: new Set(selected.map(item => item.outcome)).size === 1,
        stable: selected.every(item => item.quality_available) && selected.length === plan.repetitions
          ? new Set(digests).size === 1
          : null,
        quality_credit: selected.every(item => item.quality_available) && selected.length === plan.repetitions,
      });
    }
  }
  return groups;
}

export async function scorePhase1Report(report, {
  verification,
  oracle,
  oracleBytes,
  oracleSchema,
  scoreSchema,
  scorerSourceBytesByRole,
  reportBytes,
  preflightEvidenceBytes,
  corpus,
  pdfjsLib,
  validatorSourceBytesByRole,
  layoutOracle,
  layoutOracleBytes,
  layoutOracleSchema,
  scorerParsedJsonByRole,
} = {}) {
  const independentlyVerified = await verifyRetainedPhase1Report({ reportBytes, verification, corpus, pdfjsLib, validatorSourceBytesByRole, trustedFailureEvidenceByAttemptKey: verification.failureEvidenceByAttemptKey });
  if (canonicalJson(independentlyVerified.report) !== canonicalJson(report)) throw new Error("Extraction Phase 1 report differs from its retained source bytes");
  if (!preflightEvidenceBytes) throw new Error("Extraction Phase 1 scorer requires retained trusted failure evidence map bytes");
  const retainedFailureEvidence = JSON.parse(Buffer.from(preflightEvidenceBytes).toString("utf8"));
  exactKeys(retainedFailureEvidence, ["failure_evidence_by_attempt_key", "preflight_evidence_sha256", "report_id", "run_id"], "Extraction trusted failure evidence map");
  if (retainedFailureEvidence.report_id !== report.report_id || retainedFailureEvidence.run_id !== report.run_id
    || retainedFailureEvidence.preflight_evidence_sha256 !== report.preflight_evidence_sha256
    || canonicalJson(retainedFailureEvidence.failure_evidence_by_attempt_key) !== canonicalJson(independentlyVerified.failureEvidenceByAttemptKey)) {
    throw new Error("Extraction trusted failure evidence map bytes differ from trusted verification evidence");
  }
  if (!oracleBytes || canonicalJson(JSON.parse(Buffer.from(oracleBytes).toString("utf8"))) !== canonicalJson(oracle)) {
    throw new Error("Extraction Phase 1 scoring oracle differs from its trusted source bytes");
  }
  validatePhase1ScoringOracle(oracle, oracleSchema, verification.manifest, {
    manifestBytesSha256: verification.manifestBytesSha256,
    manifestSchema: verification.manifestSchema,
    manifestSchemaBytesSha256: verification.manifestSchemaBytesSha256,
  });
  if (!layoutOracleBytes || canonicalJson(JSON.parse(Buffer.from(layoutOracleBytes).toString("utf8"))) !== canonicalJson(layoutOracle)) {
    throw new Error("Layout occurrence oracle differs from its retained source bytes");
  }
  assertSchema(layoutOracle, layoutOracleSchema, "extraction Phase 1 layout occurrence oracle");
  await verifyLayoutOccurrenceOracle(layoutOracle, {
    manifestBytes: corpus.manifestBytes,
    manifestSchemaBytes: corpus.manifestSchemaBytes,
    fixtureBytesById: corpus.fixtureBytesById,
    caseIds: corpus.descriptor.selected_case_ids,
  });
  const fixtureById = new Map(verification.manifest.fixtures.map(fixture => [fixture.id, fixture]));
  const oracleById = new Map(oracle.cases.map(item => [item.case_id, item]));
  const layoutOracleById = new Map(layoutOracle.cases.map(item => [item.case_id, item]));
  const attempts = report.attempts.map(attempt => scoreAttempt(
    attempt,
    fixtureById.get(attempt.case_id),
    oracleById.get(attempt.case_id),
    layoutOracleById.get(attempt.case_id),
    independentlyVerified.layoutEvidenceByAttemptKey[reportAttemptKey(attempt)],
  ));
  if (!scorerSourceBytesByRole || typeof scorerSourceBytesByRole !== "object" || Array.isArray(scorerSourceBytesByRole)
    || canonicalJson(Object.keys(scorerSourceBytesByRole).sort()) !== canonicalJson(REQUIRED_SCORER_SOURCE_ROLES)) {
    throw new Error("Extraction Phase 1 scorer requires trusted scorer source bytes");
  }
  const scorerSources = Object.keys(scorerSourceBytesByRole).sort().map(role => {
    const source = scorerSourceBytesByRole[role];
    exactKeys(source, ["bytes", "path"], `Extraction scorer source role ${role}`);
    if (source.path !== PHASE1_SCORER_LOCAL_SOURCE_PATHS[role]) throw new Error(`Extraction scorer source role ${role} has an unexpected path`);
    const bytes = Buffer.from(source.bytes);
    return { role, path: source.path, bytes: bytes.length, sha256: sha256(bytes) };
  });
  if (!scorerParsedJsonByRole || canonicalJson(Object.keys(scorerParsedJsonByRole).sort()) !== canonicalJson(REQUIRED_SCORER_PARSED_JSON_ROLES)) {
    throw new Error("Extraction scorer requires every parsed local JSON source input");
  }
  for (const [role, value] of Object.entries(scorerParsedJsonByRole)) {
    if (canonicalJson(JSON.parse(Buffer.from(scorerSourceBytesByRole[role].bytes).toString("utf8"))) !== canonicalJson(value)) {
      throw new Error(`Extraction scorer source role ${role} differs from its parsed scoring input`);
    }
  }
  const dependencyVersions = [
    ["@modelcontextprotocol/sdk", "mcp_sdk_package"],
    ["pdf-lib", "pdf_lib_package"],
    ["pdfjs-dist", "pdfjs_package"],
  ];
  for (const [packageName, role] of dependencyVersions) {
    const installedMetadata = scorerParsedJsonByRole[role];
    const lockedMetadata = scorerParsedJsonByRole.package_lock.packages?.[`node_modules/${packageName}`];
    if (!installedMetadata?.version || installedMetadata.version !== lockedMetadata?.version) {
      throw new Error(`Extraction scorer dependency metadata differs from package-lock for ${packageName}`);
    }
  }
  if (scorerParsedJsonByRole.pdfjs_package.version !== "5.4.624" || String(pdfjsLib?.version) !== "5.4.624") {
    throw new Error("Extraction scorer requires exact PDF.js 5.4.624 metadata and loaded runtime version");
  }
  const score = {
    score_report_id: PHASE1_SCORE_REPORT_ID,
    score_report_version: 1,
    benchmark_claim_ready: false,
    calibration_claim_ready: false,
    canonical_evidence_claim_ready: false,
    scorer_id: PHASE1_SCORER_ID,
    scorer_contract_sha256: PHASE1_SCORER_CONTRACT_SHA256,
    scorer_sources: scorerSources,
    scorer_local_source_set_sha256: sha256(Buffer.from(canonicalJson(scorerSources))),
    execution_report_sha256: sha256(Buffer.from(canonicalJson(report))),
    execution_report_bytes_sha256: sha256(Buffer.from(reportBytes)),
    phase0_manifest_sha256: report.phase0_manifest_sha256,
    oracle_sha256: sha256(Buffer.from(canonicalJson(oracle))),
    oracle_bytes_sha256: sha256(Buffer.from(oracleBytes)),
    oracle_schema_sha256: sha256(Buffer.from(canonicalJson(oracleSchema))),
    layout_oracle_sha256: sha256(Buffer.from(canonicalJson(layoutOracle))),
    layout_oracle_bytes_sha256: sha256(Buffer.from(layoutOracleBytes)),
    layout_oracle_schema_sha256: sha256(Buffer.from(canonicalJson(layoutOracleSchema))),
    preflight_evidence_sha256: report.preflight_evidence_sha256,
    preflight_evidence_bytes_sha256: sha256(Buffer.from(preflightEvidenceBytes)),
    attempts,
    aggregate: aggregate(attempts, report, verification.registry, verification.manifest),
    stability: stability(attempts, verification.plan),
    canonical_evidence: aggregateLayoutCanonicalEvidence(attempts),
    unavailable_claims: [
      "Canonical ODA evidence outside exact source-validated layout_ir attempts",
      "Process-tree peak memory",
      "CPU time and CPU limits",
      "Process-count limits",
      "Network egress bytes",
      "Filesystem isolation",
      "Network isolation",
      "Candidate cost",
      "Candidate command, interpreter, environment, runtime closure, artifact, model, weight, and native bridge identity",
      "Installed external scorer runtime and module-byte closure",
      "Benchmark or calibration readiness",
    ],
  };
  assertSchema(score, scoreSchema, "extraction Phase 1 score report");
  return score;
}

export function createPhase1ScoreBundle(score, {
  scorePath = DEFAULT_SCORE_PATH,
  indexPath = DEFAULT_INDEX_PATH,
  scoreSchema,
  indexSchema,
  scorerSourceBytesByRole,
} = {}) {
  assertSchema(score, scoreSchema, "extraction Phase 1 score report");
  if (path.resolve(scorePath) === path.resolve(indexPath)) throw new Error("Extraction score report and index paths must be distinct");
  if (!scorerSourceBytesByRole?.index_schema
    || canonicalJson(JSON.parse(Buffer.from(scorerSourceBytesByRole.index_schema.bytes).toString("utf8"))) !== canonicalJson(indexSchema)) {
    throw new Error("Extraction score index schema differs from its trusted source bytes");
  }
  const scoreText = `${JSON.stringify(score, null, 2)}\n`;
  const relativeScorePath = path.relative(path.dirname(path.resolve(indexPath)), path.resolve(scorePath)).split(path.sep).join("/");
  if (!relativeScorePath || path.isAbsolute(relativeScorePath)) throw new Error("Extraction score artifact path is invalid");
  const index = {
    index_id: PHASE1_SCORE_INDEX_ID,
    index_version: 1,
    claim_ready: false,
    score_report: {
      path: relativeScorePath,
      bytes: Buffer.byteLength(scoreText),
      sha256: sha256(Buffer.from(scoreText)),
    },
    bindings: {
      execution_report_sha256: score.execution_report_sha256,
      execution_report_bytes_sha256: score.execution_report_bytes_sha256,
      phase0_manifest_sha256: score.phase0_manifest_sha256,
      oracle_sha256: score.oracle_sha256,
      oracle_bytes_sha256: score.oracle_bytes_sha256,
      oracle_schema_sha256: score.oracle_schema_sha256,
      layout_oracle_sha256: score.layout_oracle_sha256,
      layout_oracle_bytes_sha256: score.layout_oracle_bytes_sha256,
      layout_oracle_schema_sha256: score.layout_oracle_schema_sha256,
      score_schema_sha256: sha256(Buffer.from(canonicalJson(scoreSchema))),
      preflight_evidence_sha256: score.preflight_evidence_sha256,
      preflight_evidence_bytes_sha256: score.preflight_evidence_bytes_sha256,
      scorer_contract_sha256: score.scorer_contract_sha256,
      scorer_local_source_set_sha256: score.scorer_local_source_set_sha256,
    },
  };
  assertSchema(index, indexSchema, "extraction Phase 1 score index");
  return { score, scoreText, index, indexText: `${JSON.stringify(index, null, 2)}\n` };
}

export async function verifyPhase1ScoreBundle({
  scoreText,
  index,
  report,
  scorePath = DEFAULT_SCORE_PATH,
  indexPath = DEFAULT_INDEX_PATH,
}, context) {
  if (path.resolve(scorePath) === path.resolve(indexPath)) throw new Error("Extraction score report and index paths must be distinct");
  if (!context.scorerSourceBytesByRole?.index_schema
    || canonicalJson(JSON.parse(Buffer.from(context.scorerSourceBytesByRole.index_schema.bytes).toString("utf8"))) !== canonicalJson(context.indexSchema)) {
    throw new Error("Extraction score index schema differs from its trusted source bytes");
  }
  assertSchema(index, context.indexSchema, "retained extraction Phase 1 score index");
  const bytes = Buffer.from(scoreText);
  const expectedScorePath = path.relative(path.dirname(path.resolve(indexPath)), path.resolve(scorePath)).split(path.sep).join("/");
  if (index.claim_ready !== false
    || index.score_report.path !== expectedScorePath
    || index.score_report.bytes !== bytes.length
    || index.score_report.sha256 !== sha256(bytes)) {
    throw new Error("Extraction Phase 1 score index byte binding is invalid");
  }
  const retained = JSON.parse(scoreText);
  assertSchema(retained, context.scoreSchema, "retained extraction Phase 1 score report");
  const rescored = await scorePhase1Report(report, context);
  if (canonicalJson(retained) !== canonicalJson(rescored)) {
    throw new Error("Retained extraction Phase 1 score differs from independent rescore");
  }
  const bindings = {
    execution_report_sha256: retained.execution_report_sha256,
    execution_report_bytes_sha256: retained.execution_report_bytes_sha256,
    phase0_manifest_sha256: retained.phase0_manifest_sha256,
    oracle_sha256: retained.oracle_sha256,
    oracle_bytes_sha256: retained.oracle_bytes_sha256,
    oracle_schema_sha256: retained.oracle_schema_sha256,
    layout_oracle_sha256: retained.layout_oracle_sha256,
    layout_oracle_bytes_sha256: retained.layout_oracle_bytes_sha256,
    layout_oracle_schema_sha256: retained.layout_oracle_schema_sha256,
    score_schema_sha256: sha256(Buffer.from(canonicalJson(context.scoreSchema))),
    preflight_evidence_sha256: retained.preflight_evidence_sha256,
    preflight_evidence_bytes_sha256: retained.preflight_evidence_bytes_sha256,
    scorer_contract_sha256: retained.scorer_contract_sha256,
    scorer_local_source_set_sha256: retained.scorer_local_source_set_sha256,
  };
  if (canonicalJson(index.bindings) !== canonicalJson(bindings)) {
    throw new Error("Extraction Phase 1 score index input bindings are invalid");
  }
  return true;
}
