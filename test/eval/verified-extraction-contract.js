import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;
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

function isBoundSha256(value) {
  return SHA256.test(value) && !/^0+$/.test(value);
}

function isBoundGitCommit(value) {
  return GIT_COMMIT.test(value) && !/^0+$/.test(value);
}

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

function validateProductIdentity(productIdentity, label = "product identity") {
  if (!productIdentity || typeof productIdentity !== "object" || Array.isArray(productIdentity)) {
    throw new Error(`Complete ${label} is required`);
  }
  if (productIdentity.scheme !== "pdf-tools-product-identity.v1") {
    throw new Error(`Unknown ${label} scheme`);
  }
  if (productIdentity.kind === "git_source_tree") {
    exactSet(Object.keys(productIdentity), ["scheme", "kind", "git_commit", "git_tree"], `${label} keys`);
    if (!isBoundGitCommit(productIdentity.git_commit) || !isBoundGitCommit(productIdentity.git_tree)) {
      throw new Error(`Invalid ${label}`);
    }
  } else if (productIdentity.kind === "packaged_artifact") {
    exactSet(Object.keys(productIdentity), ["scheme", "kind", "git_commit", "artifact_sha256"], `${label} keys`);
    if (!isBoundGitCommit(productIdentity.git_commit) || !isBoundSha256(productIdentity.artifact_sha256)) {
      throw new Error(`Invalid ${label}`);
    }
  } else {
    throw new Error(`Unknown ${label} kind`);
  }
  return sha256(Buffer.from(canonicalJson(productIdentity)));
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
  if (manifest.run_plan_admission?.comparison_contract_id !== "verified-extraction-comparison-authority.v1"
    || manifest.run_plan_admission?.candidate_execution_contract_id !== "verified-extraction-candidate-execution-authority.v1"
    || manifest.run_plan_admission?.measured_campaigns_authorized !== 0
    || manifest.run_plan_admission?.state !== "no_measured_execution_authorized") {
    throw new Error("Benchmark contract must not authorize a measured execution");
  }
  if (manifest.product_identity_qualification?.scheme !== "pdf-tools-product-identity.v1"
    || manifest.product_identity_qualification?.contract_validation !== "syntactic_shape_and_immutable_binding_only"
    || manifest.product_identity_qualification?.independent_observation_required !== true
    || manifest.product_identity_qualification?.execution_gate !== "e9e.2_real_git_or_package_preflight_required") {
    throw new Error("Product identity qualification boundary must remain explicit and fail-closed");
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

function validateSharedExecution(sharedExecution) {
  exactSet(Object.keys(sharedExecution || {}), [
    "model", "host", "settings", "settings_sha256", "time_budget_ms",
  ], "shared execution keys");
  for (const [label, record, keys] of [
    ["model", sharedExecution?.model, ["provider", "id", "version"]],
    ["host", sharedExecution?.host, ["id", "platform", "architecture", "runtime"]],
  ]) {
    exactSet(Object.keys(record || {}), keys, `${label} binding keys`);
    if (!record || keys.some(key => typeof record[key] !== "string" || record[key].trim() === "")) {
      throw new Error(`Complete ${label} binding is required`);
    }
  }
  if (!sharedExecution.settings || typeof sharedExecution.settings !== "object" || Array.isArray(sharedExecution.settings)) {
    throw new Error("Model settings are required");
  }
  if (!SHA256.test(sharedExecution.settings_sha256)
    || sha256(Buffer.from(canonicalJson(sharedExecution.settings))) !== sharedExecution.settings_sha256) {
    throw new Error("Model settings binding mismatch");
  }
  if (!Number.isInteger(sharedExecution.time_budget_ms) || sharedExecution.time_budget_ms < 1) {
    throw new Error("Positive time budget is required");
  }
}

function expectedProtocolBindings(manifest) {
  return Object.fromEntries(["baseline", "candidate"].map(workflowRole => [workflowRole, {
    id: manifest.protocols?.[workflowRole]?.value?.id,
    sha256: manifest.protocols?.[workflowRole]?.sha256,
  }]));
}

function executionPlan({ comparison, workflowRole, productIdentity }) {
  return {
    comparison_authority_sha256: comparison.authority_sha256,
    workflow_role: workflowRole,
    protocol_binding: comparison.value.protocol_bindings[workflowRole],
    scorer_binding: comparison.value.scorer_binding,
    shared_execution: comparison.value.shared_execution,
    retry_budget: comparison.value.retry_budget,
    product_identity: productIdentity,
  };
}

export function validateComparisonAuthority({ manifest, comparisonAuthority }) {
  exactSet(Object.keys(comparisonAuthority || {}), [
    "comparison_version", "comparison_id", "benchmark_id", "benchmark_manifest_sha256", "admission_class",
    "authorized_at", "candidate_identity_state", "admitted_document_ids", "workflow_roles", "protocol_bindings",
    "scorer_binding", "shared_execution", "baseline_product_identity", "trials_per_document", "retry_budget",
    "replacement_policy", "trial_count", "attempt_slot_count", "trials",
  ], "comparison authority keys");
  if (comparisonAuthority?.comparison_version !== 1
    || comparisonAuthority?.benchmark_id !== manifest?.benchmark_id
    || typeof comparisonAuthority?.comparison_id !== "string" || comparisonAuthority.comparison_id.length < 8) {
    throw new Error("Invalid comparison authority identity");
  }
  const manifestSha256 = sha256(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  if (!SHA256.test(comparisonAuthority.benchmark_manifest_sha256)
    || comparisonAuthority.benchmark_manifest_sha256 !== manifestSha256) {
    throw new Error("Comparison benchmark manifest binding mismatch");
  }
  if (comparisonAuthority.admission_class !== "synthetic_scorer_calibration") {
    throw new Error("No measured campaign is authorized by this benchmark contract");
  }
  const authorizedAt = Date.parse(comparisonAuthority.authorized_at);
  if (!Number.isFinite(authorizedAt)) throw new Error("Comparison authority requires an authorization timestamp");
  if (comparisonAuthority.candidate_identity_state !== "pending_implementation") {
    throw new Error("Pre-baseline comparison must not contain a candidate product identity");
  }
  exactSet(Object.keys(comparisonAuthority.protocol_bindings || {}), ["baseline", "candidate"], "comparison protocol roles");
  const protocols = expectedProtocolBindings(manifest);
  if (canonicalJson(comparisonAuthority.protocol_bindings) !== canonicalJson(protocols)) {
    throw new Error("Comparison protocol binding mismatch");
  }
  exactSet(Object.keys(comparisonAuthority.scorer_binding || {}), ["sha256"], "comparison scorer binding keys");
  if (comparisonAuthority.scorer_binding.sha256 !== manifest.scorer?.sha256) {
    throw new Error("Comparison scorer binding mismatch");
  }
  validateSharedExecution(comparisonAuthority.shared_execution);
  validateProductIdentity(comparisonAuthority.baseline_product_identity, "baseline product identity");
  const documentIds = (manifest.documents || []).map(document => document.id).sort();
  if (!Array.isArray(comparisonAuthority.admitted_document_ids)
    || new Set(comparisonAuthority.admitted_document_ids).size !== comparisonAuthority.admitted_document_ids.length) {
    throw new Error("Comparison admitted document IDs must be unique");
  }
  exactSet(comparisonAuthority.admitted_document_ids, documentIds, "comparison admitted documents");
  if (!Array.isArray(comparisonAuthority.workflow_roles)
    || new Set(comparisonAuthority.workflow_roles).size !== comparisonAuthority.workflow_roles.length) {
    throw new Error("Comparison workflow roles must be unique");
  }
  exactSet(comparisonAuthority.workflow_roles, ["baseline", "candidate"], "comparison workflow roles");
  if (!Number.isInteger(comparisonAuthority.trials_per_document) || comparisonAuthority.trials_per_document < 1) {
    throw new Error("Positive trials per document are required");
  }
  if (!Number.isInteger(comparisonAuthority.retry_budget) || comparisonAuthority.retry_budget < 0) {
    throw new Error("Non-negative comparison retry budget is required");
  }
  if (comparisonAuthority.replacement_policy !== "no_product_replacement_harness_retry_only") {
    throw new Error("Comparison replacement policy must retain every product result");
  }
  const expectedTrialCount = documentIds.length * 2 * comparisonAuthority.trials_per_document;
  const expectedAttemptSlotCount = expectedTrialCount * (comparisonAuthority.retry_budget + 1);
  if (comparisonAuthority.trial_count !== expectedTrialCount
    || comparisonAuthority.attempt_slot_count !== expectedAttemptSlotCount
    || !Array.isArray(comparisonAuthority.trials) || comparisonAuthority.trials.length !== expectedTrialCount) {
    throw new Error("Comparison frozen attempt or trial count mismatch");
  }
  const trialsById = new Map();
  const attemptIds = new Set();
  const coverage = new Set();
  for (const trial of comparisonAuthority.trials) {
    exactSet(Object.keys(trial || {}), [
      "trial_id", "document_id", "workflow_role", "trial_index", "attempt_ids",
    ], "comparison trial keys");
    if (typeof trial.trial_id !== "string" || trial.trial_id.length < 8 || trialsById.has(trial.trial_id)) {
      throw new Error("Comparison trial IDs must be unique and non-empty");
    }
    if (!documentIds.includes(trial.document_id) || !["baseline", "candidate"].includes(trial.workflow_role)
      || !Number.isInteger(trial.trial_index) || trial.trial_index < 1
      || trial.trial_index > comparisonAuthority.trials_per_document) {
      throw new Error(`Invalid comparison trial binding: ${trial.trial_id}`);
    }
    if (!Array.isArray(trial.attempt_ids)
      || trial.attempt_ids.length !== comparisonAuthority.retry_budget + 1
      || new Set(trial.attempt_ids).size !== trial.attempt_ids.length
      || trial.attempt_ids.some(attemptId => typeof attemptId !== "string" || attemptId.length < 8 || attemptIds.has(attemptId))) {
      throw new Error(`Invalid comparison attempt identities: ${trial.trial_id}`);
    }
    const coverageKey = `${trial.document_id}\u0000${trial.workflow_role}\u0000${trial.trial_index}`;
    if (coverage.has(coverageKey)) throw new Error(`Duplicate comparison trial coverage: ${trial.trial_id}`);
    coverage.add(coverageKey);
    trialsById.set(trial.trial_id, trial);
    for (const attemptId of trial.attempt_ids) attemptIds.add(attemptId);
  }
  for (const documentId of documentIds) {
    for (let trialIndex = 1; trialIndex <= comparisonAuthority.trials_per_document; trialIndex++) {
      for (const workflowRole of ["baseline", "candidate"]) {
        const coverageKey = `${documentId}\u0000${workflowRole}\u0000${trialIndex}`;
        if (!coverage.has(coverageKey)) throw new Error(`Comparison trial coverage is incomplete: ${coverageKey}`);
      }
    }
  }
  const authoritySha256 = sha256(Buffer.from(canonicalJson(comparisonAuthority)));
  const validated = {
    value: comparisonAuthority,
    authority_sha256: authoritySha256,
    authorized_at_ms: authorizedAt,
    trials_by_id: trialsById,
  };
  validated.baseline_execution_plan_sha256 = sha256(Buffer.from(canonicalJson(executionPlan({
    comparison: validated,
    workflowRole: "baseline",
    productIdentity: comparisonAuthority.baseline_product_identity,
  }))));
  return validated;
}

export function validateCandidateExecutionAuthority({ manifest, comparisonAuthority, candidateExecutionAuthority }) {
  const comparison = validateComparisonAuthority({ manifest, comparisonAuthority });
  exactSet(Object.keys(candidateExecutionAuthority || {}), [
    "authority_version", "authority_id", "comparison_authority_sha256", "authorized_at", "workflow_role",
    "product_identity", "execution_plan_sha256",
  ], "candidate execution authority keys");
  if (candidateExecutionAuthority?.authority_version !== 1
    || typeof candidateExecutionAuthority?.authority_id !== "string" || candidateExecutionAuthority.authority_id.length < 8
    || candidateExecutionAuthority.workflow_role !== "candidate") {
    throw new Error("Invalid candidate execution authority identity");
  }
  if (candidateExecutionAuthority.comparison_authority_sha256 !== comparison.authority_sha256) {
    throw new Error("Candidate execution comparison binding mismatch");
  }
  const authorizedAt = Date.parse(candidateExecutionAuthority.authorized_at);
  if (!Number.isFinite(authorizedAt) || authorizedAt <= comparison.authorized_at_ms) {
    throw new Error("Candidate execution authority must follow comparison authorization");
  }
  validateProductIdentity(candidateExecutionAuthority.product_identity, "candidate product identity");
  const executionPlanSha256 = sha256(Buffer.from(canonicalJson(executionPlan({
    comparison,
    workflowRole: "candidate",
    productIdentity: candidateExecutionAuthority.product_identity,
  }))));
  if (candidateExecutionAuthority.execution_plan_sha256 !== executionPlanSha256) {
    throw new Error("Candidate execution plan binding mismatch");
  }
  return {
    authority_sha256: sha256(Buffer.from(canonicalJson(candidateExecutionAuthority))),
    authorized_at_ms: authorizedAt,
    execution_plan_sha256: executionPlanSha256,
    product_identity: candidateExecutionAuthority.product_identity,
    comparison,
  };
}

export function scoreVerifiedExtractionCandidate({
  manifest, workflowRole, comparisonAuthority, candidateExecutionAuthority, document, schema, truth, citationOracle, candidate,
}) {
  if (!candidate || typeof candidate !== "object") throw new Error("Candidate run record is required");
  if (!["baseline", "candidate"].includes(workflowRole)) throw new Error("Unknown workflow role");
  const expectedBindings = {
    document_id: document.id,
    source_sha256: document.artifacts.pdf.sha256,
    schema_sha256: document.artifacts.schema.sha256,
  };
  for (const [key, expected] of Object.entries(expectedBindings)) {
    if (candidate[key] !== expected) throw new Error(`Candidate harness binding mismatch: ${key}`);
  }
  const comparison = validateComparisonAuthority({ manifest, comparisonAuthority });
  if (candidate.comparison_authority_sha256 !== comparison.authority_sha256) {
    throw new Error("Candidate comparison authority binding mismatch");
  }
  const roleAuthority = workflowRole === "baseline" ? {
    authority_sha256: comparison.authority_sha256,
    authorized_at_ms: comparison.authorized_at_ms,
    execution_plan_sha256: comparison.baseline_execution_plan_sha256,
    product_identity: comparisonAuthority.baseline_product_identity,
  } : validateCandidateExecutionAuthority({ manifest, comparisonAuthority, candidateExecutionAuthority });
  if (candidate.role_authority_sha256 !== roleAuthority.authority_sha256) {
    throw new Error("Candidate role authority binding mismatch");
  }
  const executionBindingSha256 = roleAuthority.execution_plan_sha256;
  if (candidate.execution_binding_sha256 !== executionBindingSha256) throw new Error("Candidate execution binding mismatch");
  if (canonicalJson(candidate.product_identity) !== canonicalJson(roleAuthority.product_identity)) {
    throw new Error("Candidate product identity binding mismatch");
  }
  const trial = comparison.trials_by_id.get(candidate.trial_id);
  if (!trial || trial.document_id !== document.id || trial.workflow_role !== workflowRole) {
    throw new Error("Candidate comparison trial binding mismatch");
  }
  const attemptIndex = trial.attempt_ids.indexOf(candidate.attempt_id);
  if (attemptIndex < 0 || candidate.attempt_index !== attemptIndex + 1) {
    throw new Error("Candidate campaign attempt binding mismatch");
  }
  const startedAt = Date.parse(candidate.execution?.started_at);
  const completedAt = Date.parse(candidate.execution?.completed_at);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)
    || startedAt <= comparison.authorized_at_ms || startedAt <= roleAuthority.authorized_at_ms || completedAt < startedAt) {
    throw new Error("Candidate execution chronology does not follow role authorization");
  }
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
    if (actual && canonicalJson(Object.keys(actual).sort()) === canonicalJson(["page", "quote"])
      && actual.page === expected.page && actual.quote === expected.quote) correctCitations += 1;
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
    workflow_role: workflowRole,
    comparison_authority_sha256: comparison.authority_sha256,
    role_authority_sha256: roleAuthority.authority_sha256,
    trial_id: trial.trial_id,
    attempt_id: candidate.attempt_id,
    attempt_index: candidate.attempt_index,
    claim_eligible: false,
    execution_binding_sha256: executionBindingSha256,
    product_identity: roleAuthority.product_identity,
    product_identity_sha256: validateProductIdentity(roleAuthority.product_identity, `${workflowRole} product identity`),
    product_identity_qualification: "external_preflight_required",
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

export function verifyVerifiedExtractionCampaignReceipt({
  manifest, comparisonAuthority, candidateExecutionAuthority, documentContexts, attemptReceipts,
}) {
  const comparison = validateComparisonAuthority({ manifest, comparisonAuthority });
  const candidateAuthority = validateCandidateExecutionAuthority({
    manifest, comparisonAuthority, candidateExecutionAuthority,
  });
  const documentIds = (manifest.documents || []).map(document => document.id);
  exactSet(Object.keys(documentContexts || {}), documentIds, "campaign document contexts");
  for (const document of manifest.documents) {
    const context = documentContexts[document.id];
    exactSet(Object.keys(context || {}), ["document", "schema", "truth", "citationOracle"], "campaign document context keys");
    if (canonicalJson(context.document) !== canonicalJson(document)) {
      throw new Error(`Campaign document context mismatch: ${document.id}`);
    }
    for (const [contextKey, artifactRole] of [
      ["schema", "schema"], ["truth", "truth"], ["citationOracle", "citations"],
    ]) {
      const contextBytes = Buffer.from(`${JSON.stringify(context[contextKey], null, 2)}\n`);
      if (sha256(contextBytes) !== document.artifacts[artifactRole].sha256
        || contextBytes.length !== document.artifacts[artifactRole].bytes) {
        throw new Error(`Campaign document context artifact mismatch: ${document.id}/${artifactRole}`);
      }
    }
  }
  if (!Array.isArray(attemptReceipts) || attemptReceipts.length !== comparisonAuthority.attempt_slot_count) {
    throw new Error("Campaign receipt does not account for every frozen attempt slot");
  }
  const receiptsByAttemptId = new Map();
  const scoresByAttemptId = new Map();
  for (const receipt of attemptReceipts) {
    exactSet(Object.keys(receipt || {}), [
      "receipt_version", "comparison_authority_sha256", "role_authority_sha256", "trial_id", "attempt_id", "attempt_index",
      "document_id", "workflow_role", "outcome_kind", "outcome",
    ], "campaign attempt receipt keys");
    const expectedRoleAuthoritySha256 = receipt.workflow_role === "baseline"
      ? comparison.authority_sha256 : candidateAuthority.authority_sha256;
    if (receipt.receipt_version !== 1 || receipt.comparison_authority_sha256 !== comparison.authority_sha256
      || receipt.role_authority_sha256 !== expectedRoleAuthoritySha256) {
      throw new Error("Campaign attempt receipt authority mismatch");
    }
    if (receiptsByAttemptId.has(receipt.attempt_id)) throw new Error(`Duplicate campaign attempt receipt: ${receipt.attempt_id}`);
    const trial = comparison.trials_by_id.get(receipt.trial_id);
    const attemptIndex = trial?.attempt_ids.indexOf(receipt.attempt_id) ?? -1;
    if (!trial || attemptIndex < 0 || receipt.attempt_index !== attemptIndex + 1
      || receipt.document_id !== trial.document_id || receipt.workflow_role !== trial.workflow_role) {
      throw new Error(`Unplanned or substituted campaign attempt receipt: ${receipt.attempt_id}`);
    }
    if (!receipt.outcome || typeof receipt.outcome !== "object" || Array.isArray(receipt.outcome)) {
      throw new Error(`Malformed campaign attempt outcome: ${receipt.attempt_id}`);
    }
    if (receipt.outcome_kind === "product_result") {
      exactSet(Object.keys(receipt.outcome), ["candidate", "candidate_sha256"], "product result outcome keys");
      const candidateDigest = sha256(Buffer.from(canonicalJson(receipt.outcome.candidate)));
      if (!SHA256.test(receipt.outcome.candidate_sha256) || receipt.outcome.candidate_sha256 !== candidateDigest) {
        throw new Error(`Campaign product result digest mismatch: ${receipt.attempt_id}`);
      }
      const context = documentContexts[trial.document_id];
      const score = scoreVerifiedExtractionCandidate({
        manifest,
        workflowRole: trial.workflow_role,
        comparisonAuthority,
        candidateExecutionAuthority,
        document: context.document,
        schema: context.schema,
        truth: context.truth,
        citationOracle: context.citationOracle,
        candidate: receipt.outcome.candidate,
      });
      if (score?.document_id !== trial.document_id || score?.workflow_role !== trial.workflow_role
        || score?.comparison_authority_sha256 !== comparison.authority_sha256
        || score?.role_authority_sha256 !== expectedRoleAuthoritySha256
        || score?.trial_id !== trial.trial_id || score?.attempt_id !== receipt.attempt_id
        || score?.attempt_index !== receipt.attempt_index || typeof score?.deterministic_failure !== "boolean") {
        throw new Error(`Campaign product score binding mismatch: ${receipt.attempt_id}`);
      }
      scoresByAttemptId.set(receipt.attempt_id, score);
    } else if (receipt.outcome_kind === "harness_failure") {
      exactSet(Object.keys(receipt.outcome), ["failure_code", "execution"], "harness failure outcome keys");
      if (!manifest.protocols?.scoring?.value?.harness_failures?.includes(receipt.outcome.failure_code)) {
        throw new Error(`Unknown campaign harness failure: ${receipt.attempt_id}`);
      }
      exactSet(Object.keys(receipt.outcome.execution || {}), ["started_at", "completed_at"], "harness failure execution keys");
      const startedAt = Date.parse(receipt.outcome.execution?.started_at);
      const completedAt = Date.parse(receipt.outcome.execution?.completed_at);
      if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)
        || startedAt <= comparison.authorized_at_ms
        || startedAt <= (trial.workflow_role === "candidate" ? candidateAuthority.authorized_at_ms : comparison.authorized_at_ms)
        || completedAt < startedAt) {
        throw new Error(`Campaign harness failure chronology mismatch: ${receipt.attempt_id}`);
      }
    } else if (receipt.outcome_kind === "not_run") {
      exactSet(Object.keys(receipt.outcome), ["reason"], "not-run outcome keys");
      if (!["retry_not_needed", "retry_not_used"].includes(receipt.outcome.reason)) {
        throw new Error(`Unknown campaign not-run reason: ${receipt.attempt_id}`);
      }
    } else {
      throw new Error(`Unknown campaign attempt outcome: ${receipt.attempt_id}`);
    }
    receiptsByAttemptId.set(receipt.attempt_id, receipt);
  }

  const totals = {
    planned_trials: comparisonAuthority.trial_count,
    planned_attempt_slots: comparisonAuthority.attempt_slot_count,
    attempted_attempts: 0,
    unused_attempt_slots: 0,
    product_success_trials: 0,
    product_failure_trials: 0,
    harness_failure_trials: 0,
    harness_failure_attempts: 0,
  };
  const deterministicDenominators = {
    documents: comparisonAuthority.trial_count,
    leaf_values: 0,
    citation_obligations: 0,
    keyed_array_items: 0,
    calculations: 0,
  };
  const deterministicNumerators = {
    schema_valid_documents: 0,
    leaf_values: 0,
    citation_obligations: 0,
    keyed_array_items: 0,
    calculations: 0,
  };
  for (const trial of comparisonAuthority.trials) {
    const document = manifest.documents.find(item => item.id === trial.document_id);
    deterministicDenominators.leaf_values += document.deterministic_denominators.leaf_values;
    deterministicDenominators.citation_obligations += document.deterministic_denominators.citation_obligations;
    deterministicDenominators.keyed_array_items += document.deterministic_denominators.keyed_array_items;
    deterministicDenominators.calculations += document.deterministic_denominators.calculations;
    let productReceipt = null;
    let harnessFailures = 0;
    let executionClosed = false;
    for (const [index, attemptId] of trial.attempt_ids.entries()) {
      const receipt = receiptsByAttemptId.get(attemptId);
      if (!receipt) throw new Error(`Missing campaign attempt receipt: ${attemptId}`);
      if (receipt.outcome_kind === "not_run") {
        totals.unused_attempt_slots += 1;
        if (index === 0) throw new Error(`Primary campaign attempt cannot be omitted: ${attemptId}`);
        const expectedReason = productReceipt ? "retry_not_needed" : "retry_not_used";
        if (receipt.outcome.reason !== expectedReason) throw new Error(`Campaign not-run reason contradicts trial history: ${attemptId}`);
        executionClosed = true;
        continue;
      }
      if (executionClosed) throw new Error(`Campaign attempt resumed after a not-run receipt: ${attemptId}`);
      totals.attempted_attempts += 1;
      if (receipt.outcome_kind === "harness_failure") {
        if (productReceipt) throw new Error(`Harness retry replaced a retained product result: ${attemptId}`);
        harnessFailures += 1;
        totals.harness_failure_attempts += 1;
      } else {
        if (productReceipt) throw new Error(`Duplicate or replacement product result: ${attemptId}`);
        productReceipt = receipt;
      }
    }
    if (productReceipt) {
      const score = scoresByAttemptId.get(productReceipt.attempt_id);
      if (score.json_schema_valid) deterministicNumerators.schema_valid_documents += 1;
      deterministicNumerators.leaf_values += score.leaf_recall.numerator;
      deterministicNumerators.citation_obligations += score.citation_replay_rate.numerator;
      deterministicNumerators.keyed_array_items += score.keyed_array_recall.numerator;
      deterministicNumerators.calculations += score.calculation_replay_rate.numerator;
      if (score.deterministic_failure) totals.product_failure_trials += 1;
      else totals.product_success_trials += 1;
    } else {
      if (harnessFailures < 1) throw new Error(`Campaign trial has no retained outcome: ${trial.trial_id}`);
      totals.harness_failure_trials += 1;
    }
  }
  if (totals.product_success_trials + totals.product_failure_trials + totals.harness_failure_trials !== totals.planned_trials) {
    throw new Error("Campaign trial denominator is incomplete");
  }
  return {
    comparison_id: comparisonAuthority.comparison_id,
    comparison_authority_sha256: comparison.authority_sha256,
    candidate_execution_authority_sha256: candidateAuthority.authority_sha256,
    benchmark_id: manifest.benchmark_id,
    claim_eligible: false,
    complete: true,
    product_identity_qualification: "external_preflight_required",
    deterministic_denominators: deterministicDenominators,
    deterministic_numerators: deterministicNumerators,
    ...totals,
  };
}
