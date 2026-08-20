import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const EXPECTED_SCHEMA_SUBSET = [
  "object", "array", "string", "number", "integer", "boolean", "null", "required", "properties",
  "additionalProperties", "enum", "format:date", "items", "minItems", "maxItems", "x-key",
];
const ALLOWED_SCHEMA_KEYS = new Set([
  "$schema", "$id", "type", "required", "properties", "additionalProperties", "enum", "format",
  "items", "minItems", "maxItems", "x-key",
]);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readStableFile(filename, maxBytes) {
  if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("Verified extraction contract requires O_NOFOLLOW support");
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maxBytes)) {
      throw new Error(`Verified extraction artifact is not a bounded regular file: ${filename}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(bytes.length) !== before.size) {
      throw new Error(`Verified extraction artifact changed while read: ${filename}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function resolveInside(root, relativePath) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) throw new Error(`Unsafe artifact path: ${relativePath}`);
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Artifact escapes benchmark root: ${relativePath}`);
  return resolved;
}

function exactSet(actual, expected, label) {
  const left = [...new Set(actual)].sort();
  const right = [...expected].sort();
  if (canonicalJson(left) !== canonicalJson(right)) throw new Error(`Unexpected ${label}`);
}

function validateSchemaValue(schema, value, at = "$") {
  if (!schema || typeof schema !== "object" || typeof schema.type !== "string") throw new Error(`Invalid schema at ${at}`);
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Truth type mismatch at ${at}`);
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`Missing truth property ${at}.${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (!schema.properties?.[key]) {
        if (schema.additionalProperties === false) throw new Error(`Unexpected truth property ${at}.${key}`);
        continue;
      }
      validateSchemaValue(schema.properties[key], item, `${at}.${key}`);
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`Truth type mismatch at ${at}`);
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`Truth array too short at ${at}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`Truth array too long at ${at}`);
    if (schema["x-key"]) {
      const keys = value.map(item => item?.[schema["x-key"]]);
      if (keys.some(key => typeof key !== "string") || new Set(keys).size !== keys.length) throw new Error(`Invalid keyed array at ${at}`);
    }
    value.forEach((item, index) => validateSchemaValue(schema.items, item, `${at}[${index}]`));
    return;
  }
  const matches = schema.type === "string" ? typeof value === "string"
    : schema.type === "number" ? typeof value === "number" && Number.isFinite(value)
      : schema.type === "integer" ? Number.isInteger(value)
        : schema.type === "boolean" ? typeof value === "boolean"
          : schema.type === "null" ? value === null : false;
  if (!matches) throw new Error(`Truth type mismatch at ${at}`);
  if (schema.enum && !schema.enum.some(item => Object.is(item, value))) throw new Error(`Truth enum mismatch at ${at}`);
  if (schema.format === "date") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const year = Number(match?.[1]);
    const month = Number(match?.[2]);
    const day = Number(match?.[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const monthLengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (!match || year < 1 || month < 1 || month > 12 || day < 1 || day > monthLengths[month - 1]) {
      throw new Error(`Truth date mismatch at ${at}`);
    }
  }
}

function assertSchemaSubset(schema, at = "$") {
  for (const key of Object.keys(schema)) if (!ALLOWED_SCHEMA_KEYS.has(key)) throw new Error(`Unsupported schema keyword at ${at}: ${key}`);
  if (!["object", "array", "string", "number", "integer", "boolean", "null"].includes(schema.type)) {
    throw new Error(`Unsupported schema type at ${at}: ${schema.type}`);
  }
  if (schema.format !== undefined && schema.format !== "date") throw new Error(`Unsupported schema format at ${at}: ${schema.format}`);
  if (schema.type === "object") {
    if (!schema.properties || typeof schema.properties !== "object") throw new Error(`Object schema has no properties at ${at}`);
    for (const [key, child] of Object.entries(schema.properties)) assertSchemaSubset(child, `${at}.${key}`);
  }
  if (schema.type === "array") {
    if (!schema.items || typeof schema.items !== "object") throw new Error(`Array schema has no items at ${at}`);
    assertSchemaSubset(schema.items, `${at}[]`);
  }
}

function enumerateLeaves(schema, value, at = "$") {
  if (schema.type === "object") {
    return Object.entries(schema.properties || {}).flatMap(([key, child]) => enumerateLeaves(child, value?.[key], `${at}.${key}`));
  }
  if (schema.type === "array") {
    const keyName = schema["x-key"];
    return (value || []).flatMap((item, index) => {
      const segment = keyName ? `[${keyName}=${item[keyName]}]` : `[${index}]`;
      return enumerateLeaves(schema.items, item, `${at}${segment}`);
    });
  }
  return [{ path: at, value }];
}

function resolveMetricPath(root, metricPath) {
  const parts = metricPath.split(".");
  let current = root;
  for (const part of parts) {
    const match = /^([^[]+)\[([^=]+)=([^\]]+)\]$/.exec(part);
    if (match) {
      const [, property, key, expected] = match;
      current = current?.[property];
      if (!Array.isArray(current)) return { found: false };
      current = current.find(item => String(item?.[key]) === expected);
    } else {
      if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) return { found: false };
      current = current[part];
    }
    if (current === undefined) return { found: false };
  }
  return { found: true, value: current };
}

function replayCalculation(truth, calculation) {
  const values = calculation.operands.map(operand => {
    const resolved = resolveMetricPath(truth, operand);
    if (!resolved.found || typeof resolved.value !== "number") throw new Error(`Calculation operand does not resolve: ${operand}`);
    return resolved.value;
  });
  if (calculation.operation !== "sum") throw new Error(`Unsupported calculation operation: ${calculation.operation}`);
  const actual = values.reduce((sum, value) => sum + value, 0);
  if (!Object.is(actual, calculation.expected)) throw new Error(`Calculation oracle mismatch for ${calculation.output_path}`);
  const output = resolveMetricPath(truth, calculation.output_path);
  if (!output.found || !Object.is(output.value, actual)) throw new Error(`Calculated output differs from truth: ${calculation.output_path}`);
}

function documentDenominators(schema, truth, citationOracle) {
  const keyedArrays = [];
  function visit(currentSchema, currentValue) {
    if (currentSchema.type === "object") {
      for (const [key, child] of Object.entries(currentSchema.properties || {})) visit(child, currentValue?.[key]);
    } else if (currentSchema.type === "array") {
      if (currentSchema["x-key"]) keyedArrays.push(currentValue.length);
      for (const item of currentValue) visit(currentSchema.items, item);
    }
  }
  visit(schema, truth);
  return {
    leaf_values: enumerateLeaves(schema, truth).length,
    citation_obligations: Object.keys(citationOracle.citations).length,
    keyed_array_items: keyedArrays.reduce((sum, count) => sum + count, 0),
    calculations: citationOracle.calculations.length,
  };
}

async function extractPages(pdfBytes, pageNumbers) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (String(pdfjs.version) !== "5.4.624") throw new Error(`Expected pdfjs-dist 5.4.624, found ${pdfjs.version}`);
  const task = pdfjs.getDocument({ data: new Uint8Array(pdfBytes), isEvalSupported: false, useSystemFonts: true });
  const document = await task.promise;
  try {
    const pages = new Map();
    for (const pageNumber of [...new Set(pageNumbers)].sort((a, b) => a - b)) {
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) {
        throw new Error(`Citation page is outside the document: ${pageNumber}`);
      }
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      pages.set(pageNumber, content.items.filter(item => typeof item.str === "string").map(item => item.str).join(" ").replace(/\s+/g, " ").trim());
    }
    return { pageCount: document.numPages, pages };
  } finally {
    await document.destroy();
  }
}

function assertDocumentShape(document) {
  if (!document || typeof document !== "object" || typeof document.id !== "string") throw new Error("Malformed benchmark document");
  if (!Number.isInteger(document.page_count) || document.page_count < 1) throw new Error(`Invalid page count for ${document.id}`);
  if (!document.rights?.admitted || document.rights.license !== "MIT" || document.rights.personal_data !== false
    || !document.rights.author || !document.rights.source) {
    throw new Error(`Incomplete rights admission for ${document.id}`);
  }
  exactSet(Object.keys(document.artifacts || {}), ["pdf", "schema", "truth", "citations"], `artifact roles for ${document.id}`);
}

export async function verifyVerifiedExtractionContract({ benchmarkRoot, repoRoot } = {}) {
  if (!benchmarkRoot || !repoRoot) throw new Error("benchmarkRoot and repoRoot are required");
  benchmarkRoot = path.resolve(benchmarkRoot);
  repoRoot = path.resolve(repoRoot);
  const manifestBytes = await readStableFile(path.join(benchmarkRoot, "manifest.v1.json"), MAX_JSON_BYTES);
  const manifest = JSON.parse(manifestBytes);
  if (manifest.manifest_version !== 1 || manifest.benchmark_id !== "oda-verified-extraction-synthetic-v1") {
    throw new Error("Unexpected verified extraction manifest identity");
  }
  exactSet(manifest.schema_subset || [], EXPECTED_SCHEMA_SUBSET, "schema subset");
  if (manifest.claim_boundary?.benchmark_claim_ready !== false
    || manifest.claim_boundary?.classification !== "private_synthetic_calibration_only") {
    throw new Error("Benchmark claim boundary must remain private and not claim-ready");
  }
  if (!Array.isArray(manifest.external_candidates) || manifest.external_candidates.length !== 3
    || manifest.external_candidates.some(candidate => candidate.admitted !== false)) {
    throw new Error("External corpus candidates must remain explicitly not admitted");
  }
  const generatorBytes = await readStableFile(resolveInside(repoRoot, manifest.generator.path), MAX_JSON_BYTES);
  if (!SHA256.test(manifest.generator.sha256) || sha256(generatorBytes) !== manifest.generator.sha256) {
    throw new Error("Generator binding mismatch");
  }
  const scorerBytes = await readStableFile(resolveInside(repoRoot, manifest.scorer?.path), MAX_JSON_BYTES);
  if (!SHA256.test(manifest.scorer?.sha256) || sha256(scorerBytes) !== manifest.scorer.sha256) {
    throw new Error("Scorer binding mismatch");
  }
  exactSet(Object.keys(manifest.protocols || {}), ["baseline", "candidate", "scoring", "holdout"], "protocol roles");
  for (const [role, binding] of Object.entries(manifest.protocols)) {
    const digest = sha256(Buffer.from(`${JSON.stringify(binding.value, null, 2)}\n`));
    if (!SHA256.test(binding.sha256) || digest !== binding.sha256) throw new Error(`Protocol binding mismatch: ${role}`);
  }
  if (manifest.protocols.candidate.value.implementation_state !== "not_implemented_at_freeze") {
    throw new Error("Candidate protocol was not frozen before implementation");
  }
  if (!/cannot change, excuse, or override/.test(manifest.protocols.scoring.value.model_judge)) {
    throw new Error("Model judge boundary is not fail-closed");
  }
  exactSet(manifest.protocols.holdout.value.development_documents, ["nested-ledger-120", "keyed-register-96"], "development documents");
  exactSet(manifest.protocols.holdout.value.held_out_calibration_documents, ["citation-calculation-72"], "held-out documents");

  const ids = new Set();
  const totals = { documents: 0, pages: 0, leaf_values: 0, citation_obligations: 0, keyed_array_items: 0, calculations: 0 };
  for (const document of manifest.documents || []) {
    assertDocumentShape(document);
    if (ids.has(document.id)) throw new Error(`Duplicate benchmark document: ${document.id}`);
    ids.add(document.id);
    const loaded = {};
    for (const [role, binding] of Object.entries(document.artifacts)) {
      if (!SHA256.test(binding.sha256) || !Number.isInteger(binding.bytes) || binding.bytes < 1) throw new Error(`Invalid ${role} binding for ${document.id}`);
      const bytes = await readStableFile(resolveInside(benchmarkRoot, binding.path), role === "pdf" ? MAX_PDF_BYTES : MAX_JSON_BYTES);
      if (bytes.length !== binding.bytes || sha256(bytes) !== binding.sha256) throw new Error(`Artifact binding mismatch for ${document.id}/${role}`);
      loaded[role] = bytes;
    }
    const schema = JSON.parse(loaded.schema);
    const truth = JSON.parse(loaded.truth);
    const citations = JSON.parse(loaded.citations);
    if (citations.document_id !== document.id || !citations.citations || !Array.isArray(citations.calculations)) {
      throw new Error(`Malformed citation oracle for ${document.id}`);
    }
    assertSchemaSubset(schema);
    validateSchemaValue(schema, truth);
    const leaves = enumerateLeaves(schema, truth).map(item => item.path.slice(2));
    const citationPaths = Object.keys(citations.citations);
    for (const leaf of leaves) {
      if (!citationPaths.some(citationPath => leaf === citationPath || leaf.startsWith(`${citationPath}.`))) {
        throw new Error(`Truth leaf has no citation obligation in ${document.id}: ${leaf}`);
      }
    }
    const independentPdf = await PDFDocument.load(loaded.pdf, { updateMetadata: false });
    if (independentPdf.getPageCount() !== document.page_count) throw new Error(`pdf-lib page count mismatch for ${document.id}`);
    const replay = await extractPages(loaded.pdf, Object.values(citations.citations).map(item => item.page));
    if (replay.pageCount !== document.page_count) throw new Error(`PDF.js page count mismatch for ${document.id}`);
    for (const [citationPath, citation] of Object.entries(citations.citations)) {
      if (typeof citation.quote !== "string" || !replay.pages.get(citation.page)?.includes(citation.quote)) {
        throw new Error(`Citation quote does not replay for ${document.id}/${citationPath}`);
      }
    }
    for (const calculation of citations.calculations) replayCalculation(truth, calculation);
    const denominators = documentDenominators(schema, truth, citations);
    if (canonicalJson(denominators) !== canonicalJson(document.deterministic_denominators)) {
      throw new Error(`Deterministic denominator mismatch for ${document.id}`);
    }
    totals.documents += 1;
    totals.pages += document.page_count;
    for (const key of ["leaf_values", "citation_obligations", "keyed_array_items", "calculations"]) totals[key] += denominators[key];
  }
  if (canonicalJson(totals) !== canonicalJson(manifest.deterministic_denominators)) throw new Error("Aggregate denominator mismatch");
  const splitIds = Object.fromEntries(manifest.documents.map(document => [document.id, document.split]));
  for (const id of manifest.protocols.holdout.value.development_documents) {
    if (splitIds[id] !== "development") throw new Error(`Development split mismatch: ${id}`);
  }
  for (const id of manifest.protocols.holdout.value.held_out_calibration_documents) {
    if (splitIds[id] !== "held_out_calibration") throw new Error(`Held-out split mismatch: ${id}`);
  }
  return { manifest, manifest_sha256: sha256(manifestBytes), totals };
}

function collectSubmittedLeaves(value, at = "$", leaves = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectSubmittedLeaves(item, `${at}[${index}]`, leaves));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) collectSubmittedLeaves(item, `${at}.${key}`, leaves);
  } else {
    leaves.push({ path: at, value });
  }
  return leaves;
}

function keyedArrayCounts(schema, truth, candidate, at = "$") {
  const counts = { expected: 0, submitted: 0, correct: 0 };
  if (schema.type === "object") {
    for (const [key, child] of Object.entries(schema.properties || {})) {
      const nested = keyedArrayCounts(child, truth?.[key], candidate?.[key], `${at}.${key}`);
      for (const metric of Object.keys(counts)) counts[metric] += nested[metric];
    }
  } else if (schema.type === "array") {
    const expectedItems = Array.isArray(truth) ? truth : [];
    const submittedItems = Array.isArray(candidate) ? candidate : [];
    if (schema["x-key"]) {
      const key = schema["x-key"];
      const expected = new Set(expectedItems.map(item => `${item?.[key]}`));
      const submitted = submittedItems.map(item => `${item?.[key]}`);
      counts.expected += expected.size;
      counts.submitted += submitted.length;
      counts.correct += submitted.filter((item, index) => expected.has(item) && submitted.indexOf(item) === index).length;
    }
    for (const [index, item] of expectedItems.entries()) {
      const key = schema["x-key"];
      const paired = key ? submittedItems.find(candidateItem => candidateItem?.[key] === item?.[key]) : submittedItems[index];
      const nested = keyedArrayCounts(schema.items, item, paired, `${at}[${index}]`);
      for (const metric of Object.keys(counts)) counts[metric] += nested[metric];
    }
  }
  return counts;
}

function safeRatio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function validateRunPlan({ manifest, workflowRole, document, runPlan, candidate }) {
  if (!manifest || !["baseline", "candidate"].includes(workflowRole)) throw new Error("Frozen manifest and workflow role are required");
  const protocol = manifest.protocols?.[workflowRole];
  if (!protocol || !manifest.scorer) throw new Error("Frozen scorer and workflow protocol bindings are required");
  const required = {
    plan_version: 1,
    workflow_role: workflowRole,
    document_id: document.id,
    source_sha256: document.artifacts.pdf.sha256,
    schema_sha256: document.artifacts.schema.sha256,
    workflow_protocol_id: protocol.value.id,
    workflow_protocol_sha256: protocol.sha256,
    scorer_sha256: manifest.scorer.sha256,
  };
  for (const [key, expected] of Object.entries(required)) {
    if (runPlan?.[key] !== expected) throw new Error(`Run plan binding mismatch: ${key}`);
  }
  if (typeof runPlan.plan_id !== "string" || runPlan.plan_id.length < 8) throw new Error("Run plan ID is required");
  for (const [label, record, keys] of [
    ["model", runPlan.model, ["provider", "id", "version"]],
    ["host", runPlan.host, ["id", "platform", "architecture", "runtime"]],
  ]) {
    if (!record || keys.some(key => typeof record[key] !== "string" || record[key].trim() === "")) {
      throw new Error(`Complete ${label} binding is required`);
    }
  }
  if (!runPlan.settings || typeof runPlan.settings !== "object" || Array.isArray(runPlan.settings)) throw new Error("Model settings are required");
  if (!SHA256.test(runPlan.settings_sha256)
    || sha256(Buffer.from(canonicalJson(runPlan.settings))) !== runPlan.settings_sha256) {
    throw new Error("Model settings binding mismatch");
  }
  if (!Number.isInteger(runPlan.time_budget_ms) || runPlan.time_budget_ms < 1) throw new Error("Positive time budget is required");
  if (!Number.isInteger(runPlan.retry_budget) || runPlan.retry_budget < 0) throw new Error("Non-negative retry budget is required");
  const binding = sha256(Buffer.from(canonicalJson(runPlan)));
  if (candidate.execution_binding_sha256 !== binding) throw new Error("Candidate execution binding mismatch");
  return binding;
}

export function scoreVerifiedExtractionCandidate({ manifest, workflowRole, runPlan, document, schema, truth, citationOracle, candidate }) {
  if (!candidate || typeof candidate !== "object") throw new Error("Candidate run record is required");
  const expectedBindings = {
    document_id: document.id,
    source_sha256: document.artifacts.pdf.sha256,
    schema_sha256: document.artifacts.schema.sha256,
  };
  for (const [key, expected] of Object.entries(expectedBindings)) {
    if (candidate[key] !== expected) throw new Error(`Candidate harness binding mismatch: ${key}`);
  }
  const executionBindingSha256 = validateRunPlan({ manifest, workflowRole, document, runPlan, candidate });
  let schemaValid = true;
  try {
    validateSchemaValue(schema, candidate.result);
  } catch {
    schemaValid = false;
  }
  const truthLeaves = enumerateLeaves(schema, truth);
  let correctLeaves = 0;
  let missingLeaves = 0;
  const missingPaths = [];
  for (const leaf of truthLeaves) {
    const metricPath = leaf.path.slice(2);
    const resolved = resolveMetricPath(candidate.result, metricPath);
    if (!resolved.found) {
      missingLeaves += 1;
      missingPaths.push(metricPath);
    } else if (canonicalJson(resolved.value) === canonicalJson(leaf.value)) {
      correctLeaves += 1;
    }
  }
  const submittedLeaves = collectSubmittedLeaves(candidate.result).length;
  const keyed = keyedArrayCounts(schema, truth, candidate.result);
  const citations = candidate.citations && typeof candidate.citations === "object" ? candidate.citations : {};
  const expectedCitationKeys = Object.keys(citationOracle.citations);
  const submittedCitationKeys = Object.keys(citations);
  const extraCitationCount = submittedCitationKeys.filter(key => !expectedCitationKeys.includes(key)).length;
  let correctCitations = 0;
  for (const [citationPath, expected] of Object.entries(citationOracle.citations)) {
    const actual = citations[citationPath];
    if (actual?.page === expected.page && actual?.quote === expected.quote) correctCitations += 1;
  }
  let replayedCalculations = 0;
  for (const calculation of citationOracle.calculations) {
    try {
      replayCalculation(candidate.result, calculation);
      replayedCalculations += 1;
    } catch {
      // A failed deterministic replay remains a failed primary obligation.
    }
  }
  const disclosed = new Set([
    ...(Array.isArray(candidate.uncertainties) ? candidate.uncertainties.map(item => item?.path) : []),
    ...(Array.isArray(candidate.completion?.omitted_paths) ? candidate.completion.omitted_paths : []),
  ].filter(item => typeof item === "string"));
  const silentOmissions = missingPaths.filter(missing => ![...disclosed].some(pathValue => missing === pathValue || missing.startsWith(`${pathValue}.`))).length;
  const truncationCount = candidate.completion?.complete === true
    && candidate.completion?.processed_pages === document.page_count ? 0 : 1;
  return {
    document_id: document.id,
    execution_binding_sha256: executionBindingSha256,
    json_schema_valid: schemaValid,
    leaf_precision: { numerator: correctLeaves, denominator: submittedLeaves, rate: safeRatio(correctLeaves, submittedLeaves) },
    leaf_recall: { numerator: correctLeaves, denominator: truthLeaves.length, rate: safeRatio(correctLeaves, truthLeaves.length) },
    keyed_array_precision: { numerator: keyed.correct, denominator: keyed.submitted, rate: safeRatio(keyed.correct, keyed.submitted) },
    keyed_array_recall: { numerator: keyed.correct, denominator: keyed.expected, rate: safeRatio(keyed.correct, keyed.expected) },
    citation_replay_rate: { numerator: correctCitations, denominator: Object.keys(citationOracle.citations).length, rate: safeRatio(correctCitations, Object.keys(citationOracle.citations).length) },
    extra_citation_count: extraCitationCount,
    calculation_replay_rate: { numerator: replayedCalculations, denominator: citationOracle.calculations.length, rate: safeRatio(replayedCalculations, citationOracle.calculations.length) },
    missing_leaf_count: missingLeaves,
    silent_omission_count: silentOmissions,
    truncation_count: truncationCount,
    deterministic_failure: !schemaValid || correctLeaves !== truthLeaves.length || correctLeaves !== submittedLeaves || keyed.correct !== keyed.expected
      || correctCitations !== Object.keys(citationOracle.citations).length || replayedCalculations !== citationOracle.calculations.length
      || extraCitationCount > 0 || silentOmissions > 0 || truncationCount > 0,
  };
}
