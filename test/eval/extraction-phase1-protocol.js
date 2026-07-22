import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

export const PHASE1_PROTOCOL = "pdf-tools.extraction-candidate.v1";
export const PHASE1_REGISTRY_ID = "pdf-tools.extraction-candidate-registry.v1";
export const PHASE1_PLAN_ID = "pdf-tools.extraction-phase1-plan.v1";
export const PHASE1_REPORT_ID = "pdf-tools.extraction-phase1-report.v1";
export const PHASE1_CLAIM_BOUNDARY = "Candidate protocol calibration only. No benchmark, product, bundle, privacy-isolation, or release claim is authorized.";
export const PHASE1_LIMITATIONS = Object.freeze([
  "The Node runner enforces fresh processes, wall-clock deadlines, bounded output capture, a scrubbed environment, and staged-source mutation detection.",
  "The runner does not claim filesystem, network, CPU, memory, process-count, or process-tree memory isolation.",
  "Truth projection is verified only for the serialized request and adapter-builder task object; the candidate process is not filesystem isolated from the repository.",
  "Canonical ODA evidence and field evidence are prohibited until a separate scorer independently binds source items, page geometry, quotes, and regions.",
  "Process-group cleanup cannot contain a candidate that deliberately creates a new operating-system session.",
  "All committed candidate slots are unconfigured. Third-party framework, model, license, and native-host evidence are separate work.",
]);

export function validatePhase1ReportByteContract({
  limits,
  plannedAttempts,
  potentiallySpawnedAttempts = null,
  retainedEvidenceBytes = null,
  observedBytes = null,
}) {
  if (!limits || !Number.isInteger(limits.max_report_bytes) || limits.max_report_bytes < 1024 * 1024
    || !Number.isInteger(plannedAttempts) || plannedAttempts < 1) throw new Error("Phase 1 report byte contract inputs are invalid");
  let denominatorTheoreticalMaxBytes = null;
  if (potentiallySpawnedAttempts !== null) {
    if (!Number.isInteger(potentiallySpawnedAttempts) || potentiallySpawnedAttempts < 0 || potentiallySpawnedAttempts > plannedAttempts) {
      throw new Error("Phase 1 potentially spawned attempt count is invalid");
    }
    const fixedReportBytes = 4 * 1024 * 1024;
    const unspawnedAttemptBytes = 64 * 1024;
    const spawnedAttemptBytes = (3 * limits.max_stdout_bytes) + (2 * limits.max_stderr_bytes)
      + (2 * limits.max_request_bytes) + (256 * 1024);
    denominatorTheoreticalMaxBytes = fixedReportBytes
      + (potentiallySpawnedAttempts * spawnedAttemptBytes)
      + ((plannedAttempts - potentiallySpawnedAttempts) * unspawnedAttemptBytes);
    if (!Number.isSafeInteger(denominatorTheoreticalMaxBytes)) throw new Error("Phase 1 conservative denominator footprint is not a safe integer");
  }
  if (retainedEvidenceBytes !== null
    && (!Number.isInteger(retainedEvidenceBytes) || retainedEvidenceBytes < 0 || retainedEvidenceBytes > limits.max_report_bytes)) {
    throw new Error("Phase 1 incremental retained evidence exceeds max_report_bytes before report serialization");
  }
  if (observedBytes !== null && (!Number.isInteger(observedBytes) || observedBytes < 1 || observedBytes > limits.max_report_bytes)) {
    throw new Error("Phase 1 retained report exceeds the explicit max_report_bytes memory and publication ceiling");
  }
  return { max_report_bytes: limits.max_report_bytes, denominator_theoretical_max_bytes: denominatorTheoreticalMaxBytes };
}
export const PREDECLARED_CANDIDATE_IDS = Object.freeze([
  "control.current_product.v0",
  "candidate.layout_ir.v1",
  "candidate.direct_pdf.v1",
  "candidate.raster.v1",
  "candidate.remote_model.v1",
]);

const SHA256 = /^[a-f0-9]{64}$/;
const INPUT_MODES = new Set(["layout_ir", "direct_pdf", "raster"]);
const EMPTY_FAILURE = Object.freeze({
  stage: null,
  runner_code: null,
  detail_code: null,
  request_observed_bytes: null,
  request_limit_bytes: null,
});
const FORBIDDEN_REQUEST_KEYS = new Set([
  "ground_truth",
  "expected",
  "partition",
  "category",
  "fact_ids",
  "truth_boxes",
  "answer_state",
  "evaluation_policy",
  "scorer_thresholds",
  "repo_root",
  "repository_root",
]);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function loadJsonWithSchema(jsonPath, schemaPath, label) {
  const [jsonText, schemaText] = await Promise.all([
    fs.readFile(jsonPath, "utf8"),
    fs.readFile(schemaPath, "utf8"),
  ]);
  const value = JSON.parse(jsonText);
  const schema = JSON.parse(schemaText);
  assertSchema(value, schema, label);
  return {
    value,
    sha256: sha256(Buffer.from(canonicalJson(value))),
    schema_sha256: sha256(Buffer.from(canonicalJson(schema))),
  };
}

export function assertSchema(value, schema, label = "value") {
  const validation = new AjvJsonSchemaValidator().getValidator(schema)(value);
  if (!validation.valid) throw new Error(`Invalid ${label}: ${validation.errorMessage}`);
  return true;
}

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.push(key);
      collectKeys(item, keys);
    }
  }
  return keys;
}

export function assertTruthProjectedRequest(request, { repositoryRoot = null } = {}) {
  const inspected = structuredClone(request);
  if (inspected.task?.target_schema) inspected.task.target_schema = {};
  for (const key of collectKeys(inspected)) {
    if (FORBIDDEN_REQUEST_KEYS.has(key)) throw new Error(`Candidate request exposes forbidden truth key: ${key}`);
  }
  const serialized = canonicalJson(request);
  if (repositoryRoot && serialized.includes(path.resolve(repositoryRoot))) {
    throw new Error("Candidate request exposes the repository root");
  }
  if (request.protocol !== PHASE1_PROTOCOL || !SHA256.test(request.request_id)) {
    throw new Error("Candidate request has an invalid protocol or runner-owned request ID");
  }
  return true;
}

export function validateRegistry(registry) {
  if (registry.registry_id !== PHASE1_REGISTRY_ID) throw new Error("Unexpected extraction candidate registry ID");
  const ids = registry.candidates.map(candidate => candidate.id);
  if (new Set(ids).size !== ids.length) throw new Error("Extraction candidate registry contains duplicate IDs");
  if (canonicalJson([...ids].sort()) !== canonicalJson([...PREDECLARED_CANDIDATE_IDS].sort())) {
    throw new Error("Extraction candidate registry must contain exactly the predeclared candidate slots");
  }
  for (const candidate of registry.candidates) {
    if (candidate.configured !== Boolean(candidate.command)) {
      throw new Error(`Candidate ${candidate.id} configuration state does not match its command`);
    }
    if (candidate.configured && !path.isAbsolute(candidate.command.executable)) {
      throw new Error(`Candidate ${candidate.id} executable must be an absolute path`);
    }
  }
  return true;
}

export function validatePlan(plan, registry) {
  if (plan.plan_id !== PHASE1_PLAN_ID) throw new Error("Unexpected extraction Phase 1 plan ID");
  const registryById = new Map(registry.candidates.map(candidate => [candidate.id, candidate]));
  const ids = new Set();
  for (const selection of plan.candidates) {
    if (ids.has(selection.candidate_id)) throw new Error(`Duplicate candidate in extraction plan: ${selection.candidate_id}`);
    ids.add(selection.candidate_id);
    const candidate = registryById.get(selection.candidate_id);
    if (!candidate) throw new Error(`Extraction plan references an unknown candidate: ${selection.candidate_id}`);
    if (!candidate.input_modes.includes(selection.input_mode)) {
      throw new Error(`Candidate ${selection.candidate_id} does not declare ${selection.input_mode} input support`);
    }
  }
  return true;
}

export function detectHarnessCapabilities() {
  return {
    platform: process.platform,
    architecture: process.arch,
    node_version: process.version,
    wall_clock_timeout: true,
    stdout_byte_limit: true,
    stderr_byte_limit: true,
    clean_environment: true,
    source_mutation_detection: true,
    fresh_process_per_attempt: true,
    process_group_termination: process.platform !== "win32",
    filesystem_isolation: false,
    network_isolation: false,
    cpu_limit: false,
    memory_limit: false,
    process_count_limit: false,
    process_tree_memory_measurement: false,
  };
}

export function unmetRequirements(candidate, capabilities) {
  const mapping = {
    process_group_termination: "process_group_termination",
    filesystem_isolation: "filesystem_isolation",
    network_isolation: "network_isolation",
    cpu_limit: "cpu_limit",
    memory_limit: "memory_limit",
    process_count_limit: "process_count_limit",
  };
  return Object.entries(mapping)
    .filter(([requirement, capability]) => candidate.requirements[requirement] && !capabilities[capability])
    .map(([requirement]) => requirement);
}

export function buildCandidateRequest({
  candidateId,
  inputMode,
  stagedSourcePath,
  sourceSha256,
  sourceSizeBytes,
  pageCount,
  targetSchema,
  limits,
  repositoryRoot = null,
  layoutIr = null,
  rasterManifest = null,
  attemptBinding = null,
}) {
  if (!PREDECLARED_CANDIDATE_IDS.includes(candidateId)) throw new Error(`Unknown candidate ID: ${candidateId}`);
  if (!INPUT_MODES.has(inputMode)) throw new Error(`Unsupported input mode: ${inputMode}`);
  if (stagedSourcePath !== "source.pdf") throw new Error("Staged candidate source path must be exactly source.pdf relative to the candidate working directory");
  if (!SHA256.test(sourceSha256)) throw new Error("Source digest must be runner-owned SHA-256");
  const targetSchemaSha256 = sha256(Buffer.from(canonicalJson(targetSchema)));
  const requestBody = {
    candidate_id: candidateId,
    input_mode: inputMode,
    source: {
      path: stagedSourcePath,
      media_type: "application/pdf",
      sha256: sourceSha256,
      size_bytes: sourceSizeBytes,
      page_count: pageCount,
    },
    inputs: {
      layout_ir: inputMode === "layout_ir" ? layoutIr : null,
      raster_manifest: inputMode === "raster" ? rasterManifest : null,
    },
    task: {
      instruction: "Return only source-supported structured data conforming to target_schema, with engine-native evidence when available or a typed gap.",
      target_schema: targetSchema,
      target_schema_sha256: targetSchemaSha256,
    },
    limits: structuredClone(limits),
  };
  const request = {
    protocol: PHASE1_PROTOCOL,
    request_id: computeCandidateRequestId({ protocol: PHASE1_PROTOCOL, ...requestBody }, attemptBinding),
    ...requestBody,
  };
  const observedRequestBytes = Buffer.byteLength(canonicalJson(request));
  if (!Number.isInteger(limits.max_request_bytes)
    || observedRequestBytes > limits.max_request_bytes) {
    const error = new Error("Serialized candidate request exceeds the runner request byte limit");
    error.code = "REQUEST_LIMIT_EXCEEDED";
    error.observed_bytes = observedRequestBytes;
    error.limit_bytes = limits.max_request_bytes;
    throw error;
  }
  assertTruthProjectedRequest(request, { repositoryRoot });
  return request;
}

export function computeCandidateRequestId(request, attemptBinding) {
  const { request_id: ignoredRequestId, protocol: ignoredProtocol, ...requestBody } = request;
  return sha256(Buffer.from(canonicalJson({ ...requestBody, attempt_binding: attemptBinding })));
}

export function assertResponseIdentity(response, request) {
  if (response.protocol !== request.protocol || response.request_id !== request.request_id) {
    throw new Error("Candidate response is not bound to the runner request");
  }
  if ((response.status === "completed" || response.status === "partial") && response.decision !== "answer") {
    throw new Error("Completed or partial candidate response must use the answer decision");
  }
  if ((response.status === "abstained" || response.status === "error") && response.decision !== "abstain") {
    throw new Error("Abstained or error candidate response must use the abstain decision");
  }
  return true;
}

function valueAtJsonPointer(value, pointer) {
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

function pointerToken(value) {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function deriveTargetLeafPointers(schema, pointer = "") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("Target schema must be an object");
  }
  const forbiddenComposition = ["$ref", "allOf", "oneOf", "not", "if", "then", "else"].find(key => Object.hasOwn(schema, key));
  if (forbiddenComposition) throw new Error(`Unsupported target schema construct for Phase 1 gap accounting: ${forbiddenComposition}`);
  if (schema.type === "object" || Object.hasOwn(schema, "properties")) {
    if (schema.type !== "object" || schema.additionalProperties !== false
      || !schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
      throw new Error("Phase 1 object schemas require properties and additionalProperties false");
    }
    const propertyNames = Object.keys(schema.properties).sort();
    const required = Array.isArray(schema.required) ? [...schema.required].sort() : [];
    if (canonicalJson(required) !== canonicalJson(propertyNames)) {
      throw new Error("Phase 1 gap accounting requires every declared object property to be required");
    }
    return propertyNames.flatMap(name => deriveTargetLeafPointers(
      schema.properties[name],
      `${pointer}/${pointerToken(name)}`,
    ));
  }
  const supportedLeaf = ["string", "number", "integer", "boolean", "null", "array"].includes(schema.type)
    || Object.hasOwn(schema, "const")
    || Array.isArray(schema.enum)
    || Array.isArray(schema.anyOf);
  if (!supportedLeaf) throw new Error("Unsupported target schema leaf for Phase 1 gap accounting");
  return [pointer];
}

function buildAnsweredProjectionSchema(schema, answeredLeafSet, pointer = "") {
  if (schema.type !== "object") return structuredClone(schema);
  const properties = {};
  const required = [];
  for (const name of Object.keys(schema.properties).sort()) {
    const childPointer = `${pointer}/${pointerToken(name)}`;
    if (![...answeredLeafSet].some(leaf => leaf === childPointer || leaf.startsWith(`${childPointer}/`))) continue;
    properties[name] = buildAnsweredProjectionSchema(schema.properties[name], answeredLeafSet, childPointer);
    required.push(name);
  }
  return { type: "object", additionalProperties: false, required, properties };
}

function validateTables(tables, pageCount) {
  const tableIds = tables.map(table => table.id);
  if (new Set(tableIds).size !== tableIds.length) throw new Error("Candidate response contains duplicate table IDs");
  for (const table of tables) {
    if (table.pages.some(page => page > pageCount)) throw new Error("Candidate table references a page outside the source");
    const starts = new Set();
    const occupied = new Set();
    const expectedMergedRegions = [];
    for (const cell of table.cells) {
      if (cell.present !== true || !Object.hasOwn(cell, "value")) {
        throw new Error("Candidate table cell must explicitly preserve a present raw value");
      }
      const start = `${cell.row}:${cell.column}`;
      if (starts.has(start)) throw new Error(`Candidate table contains duplicate cell coordinate ${start}`);
      starts.add(start);
      const endRow = cell.row + cell.row_span - 1;
      const endColumn = cell.column + cell.column_span - 1;
      if (endRow > table.row_count || endColumn > table.column_count) {
        throw new Error(`Candidate table cell span is outside declared bounds at ${start}`);
      }
      for (let row = cell.row; row <= endRow; row += 1) {
        for (let column = cell.column; column <= endColumn; column += 1) {
          const coordinate = `${row}:${column}`;
          if (occupied.has(coordinate)) throw new Error(`Candidate table cells overlap at ${coordinate}`);
          occupied.add(coordinate);
        }
      }
      if (cell.row_span > 1 || cell.column_span > 1) {
        expectedMergedRegions.push({
          start_row: cell.row,
          start_column: cell.column,
          end_row: endRow,
          end_column: endColumn,
        });
      }
    }
    const sortRegion = (left, right) => left.start_row - right.start_row
      || left.start_column - right.start_column
      || left.end_row - right.end_row
      || left.end_column - right.end_column;
    if (canonicalJson([...table.merged_regions].sort(sortRegion)) !== canonicalJson(expectedMergedRegions.sort(sortRegion))) {
      throw new Error("Candidate table merged regions do not exactly match canonical cell-span coverage");
    }
  }
}

export function validateCandidateResponseSemantics(response, request, {
  targetSchema,
} = {}) {
  assertResponseIdentity(response, request);
  const requestedLeaves = deriveTargetLeafPointers(targetSchema);
  const requestedLeafSet = new Set(requestedLeaves);
  if (response.evidence.length > 0 || response.field_evidence.length > 0) {
    throw new Error("Canonical evidence is unavailable until the independent ODA geometry scorer is implemented");
  }
  for (const pageText of response.page_texts) {
    if (pageText.page > request.source.page_count) throw new Error("Candidate page text references a page outside the source");
    if (request.input_mode === "direct_pdf" && pageText.source_item_ids.length > 0) {
      throw new Error("Direct-PDF native references cannot populate ODA source item IDs");
    }
    if (request.input_mode === "direct_pdf" && pageText.text_kind === "born_digital_text_layer") {
      throw new Error("Direct-PDF candidate text cannot claim born-digital text-layer origin without runner-bound source items");
    }
  }
  for (const nativeEvidence of response.native_evidence) {
    if (nativeEvidence.page > request.source.page_count) throw new Error("Candidate native evidence references a page outside the source");
    const { bbox, page_geometry: geometry } = nativeEvidence;
    if (bbox.x < 0 || bbox.y < 0 || bbox.x + bbox.width > geometry.width || bbox.y + bbox.height > geometry.height) {
      throw new Error("Candidate native evidence bbox is outside its declared engine page geometry");
    }
  }
  const nativeEvidenceIds = response.native_evidence.map(item => item.id);
  if (new Set(nativeEvidenceIds).size !== nativeEvidenceIds.length) throw new Error("Candidate response contains duplicate native evidence IDs");
  validateTables(response.tables, request.source.page_count);
  const runnerFieldBindings = [];
  const gapPaths = response.gaps.map(gap => gap.field_path);
  if (new Set(gapPaths).size !== gapPaths.length) throw new Error("Candidate response contains duplicate gap paths");
  for (const gapPath of gapPaths) {
    if (!requestedLeafSet.has(gapPath)) throw new Error(`Candidate gap is not an exact requested leaf: ${gapPath}`);
  }
  const answerBearing = response.status === "completed" || response.status === "partial";
  const answeredLeaves = answerBearing
    ? requestedLeaves.filter(pointer => valueAtJsonPointer(response.structured_candidate, pointer).found)
    : [];
  const answeredLeafSet = new Set(answeredLeaves);
  if (gapPaths.some(pointer => answeredLeafSet.has(pointer))) {
    throw new Error("Candidate response overlaps answered and gap leaf paths");
  }
  const accountedLeaves = new Set([...answeredLeaves, ...gapPaths]);
  if (response.status === "completed") {
    const validation = new AjvJsonSchemaValidator().getValidator(targetSchema)(response.structured_candidate);
    if (!validation.valid) throw new Error(`Completed candidate output violates target schema: ${validation.errorMessage}`);
    if (gapPaths.length > 0 || answeredLeaves.length !== requestedLeaves.length) {
      throw new Error("Completed candidate response must answer every requested leaf with zero gaps");
    }
  }
  if (response.status === "partial") {
    if (answeredLeaves.length === 0 || gapPaths.length === 0 || accountedLeaves.size !== requestedLeaves.length) {
      throw new Error("Partial candidate response must account for every requested leaf with both answers and typed gaps");
    }
    const projectionSchema = buildAnsweredProjectionSchema(targetSchema, answeredLeafSet);
    const validation = new AjvJsonSchemaValidator().getValidator(projectionSchema)(response.structured_candidate);
    if (!validation.valid) throw new Error(`Partial candidate output violates its answered schema projection: ${validation.errorMessage}`);
  }
  if (response.status === "abstained") {
    if (answeredLeaves.length !== 0 || gapPaths.length !== requestedLeaves.length || accountedLeaves.size !== requestedLeaves.length) {
      throw new Error("Abstained candidate response must gap every requested leaf without answers");
    }
  }
  if (response.status === "error") {
    if (response.page_texts.length || response.tables.length || response.native_evidence.length || response.evidence.length
      || response.field_evidence.length || response.gaps.length) {
      throw new Error("Error candidate response cannot claim extracted content, evidence, or field coverage");
    }
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(response.diagnostics.code ?? "")
      || typeof response.diagnostics.message !== "string"
      || response.diagnostics.message.length < 1
      || response.diagnostics.message.length > 500) {
      throw new Error("Error candidate response requires stable bounded diagnostics");
    }
  } else if (response.diagnostics.code !== null || response.diagnostics.message !== null) {
    throw new Error("Non-error candidate response diagnostics must remain null");
  }
  return runnerFieldBindings;
}

export function reportAttemptKey(attempt) {
  return `${attempt.candidate_id}\u0000${attempt.case_id}\u0000${attempt.repetition}`;
}

export function artifactDriftOperationalDigest(attempt, drift) {
  const { operational_evidence_sha256: ignored, ...operational } = drift;
  return sha256(Buffer.from(`pdf-tools.artifact-drift-operational.v1\0${canonicalJson({
    candidate_id: attempt.candidate_id,
    case_id: attempt.case_id,
    repetition: attempt.repetition,
    source: attempt.source,
    request: attempt.request,
    execution: attempt.execution,
    captures: attempt.captures,
    request_sha256: attempt.bindings.request_sha256,
    stdout_sha256: attempt.bindings.stdout_sha256,
    stderr_sha256: attempt.bindings.stderr_sha256,
    operational,
  })}`));
}

export function verifyPhase1Report(report, {
  registry,
  registrySchema,
  plan,
  planSchema,
  manifest,
  sourceFactsById,
  requestSchema,
  responseSchema,
  reportSchema,
  adapterAvailability,
  failureEvidenceByAttemptKey,
  artifactEligibilityByCandidateId = {},
  repositoryRoot = null,
}) {
  assertSchema(report, reportSchema, "retained extraction Phase 1 report");
  assertSchema(registry, registrySchema, "retained extraction candidate registry");
  assertSchema(plan, planSchema, "retained extraction Phase 1 plan");
  validateRegistry(registry);
  validatePlan(plan, registry);
  if (report.report_id !== PHASE1_REPORT_ID) throw new Error("Unexpected extraction Phase 1 report ID");
  if (report.benchmark_claim_ready !== false || report.calibration_claim_ready !== false
    || report.truth_isolation_claim_ready !== false) {
    throw new Error("Extraction Phase 1 readiness flags must remain false");
  }
  if (report.claim_boundary !== PHASE1_CLAIM_BOUNDARY
    || canonicalJson(report.limitations) !== canonicalJson(PHASE1_LIMITATIONS)) {
    throw new Error("Extraction Phase 1 claim boundary or limitations contradict the fail-closed protocol");
  }
  const currentCapabilities = detectHarnessCapabilities();
  if (canonicalJson(report.environment.input_adapters) !== canonicalJson(adapterAvailability)) {
    throw new Error("Extraction Phase 1 input-adapter availability is not independently bound");
  }
  if (!failureEvidenceByAttemptKey || typeof failureEvidenceByAttemptKey !== "object"
    || Array.isArray(failureEvidenceByAttemptKey)
    || report.preflight_evidence_sha256 !== sha256(Buffer.from(canonicalJson(failureEvidenceByAttemptKey)))) {
    throw new Error("Extraction Phase 1 preflight evidence map is not independently hash-bound");
  }
  const environmentInvariant = report.environment.wall_clock_timeout
    && report.environment.stdout_byte_limit
    && report.environment.stderr_byte_limit
    && report.environment.clean_environment
    && report.environment.source_mutation_detection
    && report.environment.fresh_process_per_attempt
    && !report.environment.filesystem_isolation
    && !report.environment.network_isolation
    && !report.environment.cpu_limit
    && !report.environment.memory_limit
    && !report.environment.process_count_limit
    && !report.environment.process_tree_memory_measurement
    && report.environment.platform === currentCapabilities.platform
    && report.environment.architecture === currentCapabilities.architecture
    && report.environment.node_version === currentCapabilities.node_version
    && report.environment.process_group_termination === currentCapabilities.process_group_termination;
  if (!environmentInvariant) throw new Error("Extraction Phase 1 environment capability claims are inconsistent");
  const exactBindings = {
    registry_sha256: sha256(Buffer.from(canonicalJson(registry))),
    registry_schema_sha256: sha256(Buffer.from(canonicalJson(registrySchema))),
    plan_sha256: sha256(Buffer.from(canonicalJson(plan))),
    plan_schema_sha256: sha256(Buffer.from(canonicalJson(planSchema))),
    phase0_manifest_sha256: sha256(Buffer.from(canonicalJson(manifest))),
    request_schema_sha256: sha256(Buffer.from(canonicalJson(requestSchema))),
    response_schema_sha256: sha256(Buffer.from(canonicalJson(responseSchema))),
  };
  for (const [field, digest] of Object.entries(exactBindings)) {
    if (report[field] !== digest) throw new Error(`Extraction Phase 1 report ${field} binding is invalid`);
  }
  const manifestCaseIds = manifest.fixtures.map(fixture => fixture.id);
  const fixtureIds = plan.case_ids ?? manifestCaseIds;
  if (canonicalJson(report.denominator.planned_case_ids) !== canonicalJson(fixtureIds)) {
    throw new Error("Extraction Phase 1 report case selection is not bound to the plan and manifest");
  }
  const expectedKeys = [];
  for (const selection of plan.candidates) {
    for (const caseId of fixtureIds) {
      for (let repetition = 1; repetition <= plan.repetitions; repetition += 1) {
        expectedKeys.push(`${selection.candidate_id}\u0000${caseId}\u0000${repetition}`);
      }
    }
  }
  const observedKeys = report.attempts.map(reportAttemptKey);
  if (canonicalJson(observedKeys) !== canonicalJson(expectedKeys)) {
    throw new Error("Extraction Phase 1 report denominator is missing, duplicated, or reordered");
  }
  if (new Set(observedKeys).size !== observedKeys.length) throw new Error("Extraction Phase 1 report contains duplicate attempts");
  if (canonicalJson(Object.keys(failureEvidenceByAttemptKey).sort()) !== canonicalJson([...expectedKeys].sort())) {
    throw new Error("Extraction Phase 1 preflight evidence map does not cover the exact denominator");
  }
  if (report.denominator.planned !== expectedKeys.length || report.denominator.retained !== observedKeys.length) {
    throw new Error("Extraction Phase 1 denominator counts do not match retained attempts");
  }
  for (const outcome of ["completed", "partial", "abstained", "error", "not_run"]) {
    const count = report.attempts.filter(attempt => attempt.outcome === outcome).length;
    if (report.denominator.outcomes[outcome] !== count) throw new Error(`Incorrect ${outcome} denominator count`);
  }
  const registryById = new Map(registry.candidates.map(candidate => [candidate.id, candidate]));
  const selectionById = new Map(plan.candidates.map(selection => [selection.candidate_id, selection]));
  const fixturesById = new Map(manifest.fixtures.map(fixture => [fixture.id, fixture]));
  for (const attempt of report.attempts) {
    const attemptKey = reportAttemptKey(attempt);
    const candidate = registryById.get(attempt.candidate_id);
    const selection = selectionById.get(attempt.candidate_id);
    const fixture = fixturesById.get(attempt.case_id);
    const verifiedSource = sourceFactsById?.[attempt.case_id];
    if (!candidate || !selection || !fixture) throw new Error(`Report retains an unknown candidate or case: ${reportAttemptKey(attempt)}`);
    const trustedFailureEvidence = failureEvidenceByAttemptKey[attemptKey];
    const retainedFailureEvidence = {
      outcome: attempt.outcome,
      error_code: attempt.error_code,
      outcome_reason: attempt.outcome_reason,
      unmet_requirements: attempt.unmet_requirements,
      failure: attempt.failure,
    };
    if (canonicalJson(retainedFailureEvidence) !== canonicalJson(trustedFailureEvidence)) {
      throw new Error(`Attempt preflight or failure evidence drifted from the runner-owned record for ${attempt.case_id}`);
    }
    if (attempt.input_mode !== selection.input_mode) throw new Error(`Report input mode drifted for ${attempt.candidate_id}`);
    const eligibilityUnmet = unmetRequirements(candidate, report.environment);
    if (candidate.configured && candidate.license?.reviewed !== true) eligibilityUnmet.push("reviewed_license");
    if (candidate.configured && artifactEligibilityByCandidateId[candidate.id] === "captured_review_pending") eligibilityUnmet.push("artifact_license_review");
    if (candidate.configured && artifactEligibilityByCandidateId[candidate.id] === "precheck_failed") eligibilityUnmet.push("artifact_precheck_failed");
    if (candidate.configured && selection.input_mode !== "direct_pdf" && adapterAvailability[selection.input_mode] !== true) {
      eligibilityUnmet.push(`${selection.input_mode}_adapter`);
    }
    if (!SHA256.test(attempt.source.sha256)
      || (attempt.source.after_sha256 !== null && !SHA256.test(attempt.source.after_sha256))) {
      throw new Error(`Report has an invalid source digest for ${attempt.case_id}`);
    }
    if (!verifiedSource
      || attempt.source.manifest_path !== fixture.path
      || attempt.source.sha256 !== fixture.sha256
      || attempt.source.sha256 !== verifiedSource.sha256
      || attempt.source.size_bytes !== verifiedSource.size_bytes
      || attempt.source.page_count !== verifiedSource.page_count) {
      throw new Error(`Report source is not bound to the Phase 0 fixture for ${attempt.case_id}`);
    }
    const sourceMutated = attempt.source.sha256 !== attempt.source.after_sha256;
    if (sourceMutated && (attempt.outcome !== "error" || !["SOURCE_MUTATED", "ARTIFACT_DRIFT"].includes(attempt.error_code))) {
      throw new Error(`Report does not fail closed on source mutation for ${attempt.case_id}`);
    }
    if (attempt.source.immutable !== !sourceMutated
      || (attempt.source.after_sha256 === null) !== (attempt.source.after_read_error !== null)) {
      throw new Error(`Report source immutability evidence is invalid for ${attempt.case_id}`);
    }

    const execution = attempt.execution;
    const stdoutBytes = attempt.captures.stdout_base64 === null ? null : Buffer.from(attempt.captures.stdout_base64, "base64");
    const stderrBytes = attempt.captures.stderr_base64 === null ? null : Buffer.from(attempt.captures.stderr_base64, "base64");
    for (const [label, encoded, bytes, digest] of [
      ["stdout", attempt.captures.stdout_base64, stdoutBytes, attempt.bindings.stdout_sha256],
      ["stderr", attempt.captures.stderr_base64, stderrBytes, attempt.bindings.stderr_sha256],
    ]) {
      if (encoded === null) {
        if (digest !== null) throw new Error(`Attempt has an unexplained ${label} digest for ${attempt.case_id}`);
      } else {
        if (bytes.toString("base64") !== encoded || sha256(bytes) !== digest) {
          throw new Error(`Attempt ${label} capture binding is invalid for ${attempt.case_id}`);
        }
      }
    }
    if (!execution.spawned) {
      if (execution.process_id !== null || execution.exit_code !== null || execution.signal !== null || execution.timed_out
        || execution.stdout_limit_exceeded || execution.stderr_limit_exceeded
        || execution.stdout_bytes !== 0 || execution.stderr_bytes !== 0
        || execution.process_group_termination_attempted || execution.process_group_empty_after_cleanup !== null
        || execution.elapsed_ms !== 0 || stdoutBytes !== null || stderrBytes !== null) {
        throw new Error(`Unspawned attempt retains impossible execution evidence for ${attempt.case_id}`);
      }
    } else {
      if (!Number.isInteger(execution.process_id) || execution.process_id < 1) {
        throw new Error(`Spawned attempt lacks a process identity for ${attempt.case_id}`);
      }
      if ((execution.exit_code === null) === (execution.signal === null)) {
        throw new Error(`Spawned attempt must retain exactly one exit code or signal for ${attempt.case_id}`);
      }
      if (!stdoutBytes || !stderrBytes || execution.stdout_bytes < stdoutBytes.length || execution.stderr_bytes < stderrBytes.length) {
        throw new Error(`Spawned attempt capture counts are invalid for ${attempt.case_id}`);
      }
      if (attempt.request) {
        if (stdoutBytes.length !== Math.min(execution.stdout_bytes, attempt.request.limits.max_stdout_bytes)
          || stderrBytes.length !== Math.min(execution.stderr_bytes, attempt.request.limits.max_stderr_bytes)
          || execution.stdout_limit_exceeded !== (execution.stdout_bytes > attempt.request.limits.max_stdout_bytes)
          || execution.stderr_limit_exceeded !== (execution.stderr_bytes > attempt.request.limits.max_stderr_bytes)) {
          throw new Error(`Attempt output-limit evidence is inconsistent for ${attempt.case_id}`);
        }
      }
      if ((execution.timed_out || execution.stdout_limit_exceeded || execution.stderr_limit_exceeded)
        && !execution.process_group_termination_attempted) {
        throw new Error(`Bounded attempt lacks process-group cleanup evidence for ${attempt.case_id}`);
      }
      if (report.environment.process_group_termination
        && (!execution.process_group_termination_attempted || execution.process_group_empty_after_cleanup !== true)) {
        throw new Error(`Attempt does not prove an empty process group after cleanup for ${attempt.case_id}`);
      }
    }

    if (attempt.request) {
      assertSchema(attempt.request, requestSchema, "retained extraction candidate request");
      assertTruthProjectedRequest(attempt.request, { repositoryRoot });
      const attemptBinding = sha256(Buffer.from(`${report.run_id}\u0000${attempt.candidate_id}\u0000${attempt.case_id}\u0000${attempt.repetition}`));
      if (attempt.request.request_id !== computeCandidateRequestId(attempt.request, attemptBinding)
        || attempt.request.candidate_id !== attempt.candidate_id
        || attempt.request.input_mode !== attempt.input_mode
        || attempt.request.source.sha256 !== attempt.source.sha256
        || attempt.request.source.size_bytes !== attempt.source.size_bytes
        || attempt.request.source.page_count !== attempt.source.page_count
        || attempt.request.source.media_type !== fixture.media_type
        || canonicalJson(attempt.request.task.target_schema) !== canonicalJson(fixture.target_schema)
        || attempt.request.task.target_schema_sha256 !== sha256(Buffer.from(canonicalJson(fixture.target_schema)))
        || canonicalJson(attempt.request.limits) !== canonicalJson(plan.limits)
        || sha256(Buffer.from(canonicalJson(attempt.request))) !== attempt.bindings.request_sha256) {
        throw new Error(`Retained request is not exactly bound to its plan, fixture, and attempt for ${attempt.case_id}`);
      }
      if ((attempt.input_mode === "direct_pdf" && (attempt.request.inputs.layout_ir !== null || attempt.request.inputs.raster_manifest !== null))
        || (attempt.input_mode === "layout_ir" && (attempt.request.inputs.layout_ir === null || attempt.request.inputs.raster_manifest !== null))
        || (attempt.input_mode === "raster" && (attempt.request.inputs.raster_manifest === null || attempt.request.inputs.layout_ir !== null))) {
        throw new Error(`Retained request input payload does not match its mode for ${attempt.case_id}`);
      }
    } else if (attempt.bindings.request_sha256 !== null || execution.spawned) {
      throw new Error(`Attempt lacks a required request binding for ${attempt.case_id}`);
    }

    if (attempt.response) {
      assertSchema(attempt.response, responseSchema, "retained extraction candidate response");
      if (!attempt.request || sha256(Buffer.from(canonicalJson(attempt.response))) !== attempt.bindings.response_canonical_sha256) {
        throw new Error(`Report response binding is invalid for ${attempt.case_id}`);
      }
      validateCandidateResponseSemantics(attempt.response, attempt.request, { targetSchema: fixture.target_schema });
      if (attempt.outcome !== attempt.response.status || attempt.runner_field_bindings.length !== 0) {
        throw new Error(`Report outcome or prohibited field bindings drifted for ${attempt.case_id}`);
      }
      const parsedStdout = JSON.parse(stdoutBytes.toString("utf8"));
      if (canonicalJson(parsedStdout) !== canonicalJson(attempt.response)
        || execution.exit_code !== 0 || execution.signal !== null
        || execution.timed_out || execution.stdout_limit_exceeded || execution.stderr_limit_exceeded) {
        throw new Error(`Retained response is inconsistent with exact process output for ${attempt.case_id}`);
      }
    } else if (attempt.bindings.response_canonical_sha256 !== null || attempt.runner_field_bindings.length !== 0) {
      throw new Error(`Attempt has response bindings without a retained response for ${attempt.case_id}`);
    }
    if (attempt.outcome === "error" ? attempt.error_code === null : attempt.error_code !== null) {
      throw new Error(`Attempt error code is inconsistent with outcome for ${attempt.case_id}`);
    }
    if ((attempt.error_code === "ARTIFACT_DRIFT") !== Object.hasOwn(attempt, "artifact_drift")) {
      throw new Error(`Attempt artifact drift diagnostics are inconsistent for ${attempt.case_id}`);
    }
    if (attempt.artifact_drift) {
      if (attempt.artifact_drift.operational_evidence_sha256 !== artifactDriftOperationalDigest(attempt, attempt.artifact_drift)) {
        throw new Error(`Attempt artifact drift operational evidence is invalid for ${attempt.case_id}`);
      }
      if (attempt.artifact_drift.response_canonical_sha256 !== null) {
        if (!stdoutBytes) throw new Error(`Attempt artifact drift lost operational response bytes for ${attempt.case_id}`);
        const operationalResponse = JSON.parse(stdoutBytes.toString("utf8"));
        if (sha256(Buffer.from(canonicalJson(operationalResponse))) !== attempt.artifact_drift.response_canonical_sha256
          || operationalResponse.status !== attempt.artifact_drift.outcome) throw new Error(`Attempt artifact drift operational response is invalid for ${attempt.case_id}`);
      }
    }

    const successfulOutcomes = new Set(["completed", "partial", "abstained"]);
    if (successfulOutcomes.has(attempt.outcome)) {
      if (!candidate.configured || !attempt.request || !attempt.response || !execution.spawned
        || execution.exit_code !== 0 || execution.signal !== null
        || attempt.response.status !== attempt.outcome || attempt.unmet_requirements.length !== 0
        || eligibilityUnmet.length !== 0 || !attempt.source.immutable
        || canonicalJson(attempt.failure) !== canonicalJson(EMPTY_FAILURE)) {
        throw new Error(`Successful attempt lacks a complete configured execution proof for ${attempt.case_id}`);
      }
    } else if (attempt.outcome === "not_run") {
      if (attempt.request || attempt.response || execution.spawned || attempt.error_code !== null
        || !attempt.source.immutable || canonicalJson(attempt.failure) !== canonicalJson(EMPTY_FAILURE)) {
        throw new Error(`Not-run attempt retains execution or failure evidence for ${attempt.case_id}`);
      }
      if (!candidate.configured) {
        if (attempt.unmet_requirements.length !== 0
          || attempt.outcome_reason !== "Candidate registry slot is intentionally unconfigured") {
          throw new Error(`Unconfigured not-run reason is not bound to the registry for ${attempt.case_id}`);
        }
      } else {
        if (eligibilityUnmet.length === 0
          || canonicalJson(attempt.unmet_requirements) !== canonicalJson(eligibilityUnmet)
          || attempt.outcome_reason !== `Runner cannot truthfully enforce or provide: ${eligibilityUnmet.join(", ")}`) {
          throw new Error(`Configured not-run attempt lacks verifiable unmet requirements for ${attempt.case_id}`);
        }
      }
    } else if (attempt.outcome === "error") {
      if (!candidate.configured || (attempt.error_code !== "ARTIFACT_DRIFT" && (eligibilityUnmet.length !== 0 || attempt.unmet_requirements.length !== 0))
        || attempt.failure.runner_code !== attempt.error_code || attempt.failure.stage === null
        || attempt.failure.detail_code === null
        || (attempt.error_code !== "REQUEST_LIMIT_EXCEEDED"
          && (attempt.failure.request_observed_bytes !== null || attempt.failure.request_limit_bytes !== null))) {
        throw new Error(`Error attempt is not bound to a configured candidate for ${attempt.case_id}`);
      }
      let failureProven = false;
      if (attempt.response) {
        failureProven = attempt.response.status === "error"
          && attempt.error_code === attempt.response.diagnostics.code
          && attempt.failure.stage === "candidate_response"
          && attempt.failure.request_observed_bytes === null
          && attempt.failure.request_limit_bytes === null;
      } else {
        const cleanSpawnedExit = execution.spawned && execution.exit_code === 0 && execution.signal === null
          && !execution.timed_out && !execution.stdout_limit_exceeded && !execution.stderr_limit_exceeded;
        if (attempt.error_code === "SOURCE_LIMIT_EXCEEDED") {
          failureProven = !attempt.request && !execution.spawned
            && attempt.failure.stage === "source_preflight"
            && (attempt.source.size_bytes > plan.limits.max_source_bytes
              || attempt.source.page_count > plan.limits.max_pages);
        } else if (attempt.error_code === "REQUEST_LIMIT_EXCEEDED") {
          failureProven = !attempt.request && !execution.spawned
            && attempt.failure.stage === "request_build"
            && attempt.failure.detail_code === "REQUEST_LIMIT_EXCEEDED"
            && attempt.failure.request_limit_bytes === plan.limits.max_request_bytes
            && attempt.failure.request_observed_bytes > attempt.failure.request_limit_bytes;
        } else if (attempt.error_code === "HARNESS_ATTEMPT_FAILURE") {
          failureProven = !execution.spawned
            && ["adapter_build", "request_build", "process_execution"].includes(attempt.failure.stage)
            && attempt.failure.request_observed_bytes === null
            && attempt.failure.request_limit_bytes === null
            && attempt.outcome_reason === `Runner could not complete the candidate attempt: ${attempt.failure.detail_code}`;
        } else if (attempt.error_code === "SOURCE_MUTATED") {
          failureProven = !attempt.source.immutable && attempt.failure.stage === "source_postcheck";
        } else if (attempt.error_code === "ARTIFACT_DRIFT") {
          failureProven = attempt.failure.stage === "artifact_postcheck"
            && attempt.failure.detail_code === "ARTIFACT_DEPLOYMENT_DRIFT"
            && attempt.artifact_drift && attempt.artifact_drift.outcome !== undefined
            && attempt.outcome_reason === "Runner detected candidate artifact deployment drift after execution";
        } else if (attempt.error_code === "SPAWN_FAILED") {
          failureProven = Boolean(attempt.request) && !execution.spawned && attempt.failure.stage === "process_spawn";
        } else if (attempt.error_code === "DEADLINE_EXCEEDED") {
          failureProven = Boolean(attempt.request) && execution.spawned && execution.timed_out
            && attempt.failure.stage === "process_execution";
        } else if (attempt.error_code === "STDOUT_LIMIT_EXCEEDED") {
          failureProven = Boolean(attempt.request) && execution.spawned && execution.stdout_limit_exceeded
            && attempt.failure.stage === "process_execution";
        } else if (attempt.error_code === "STDERR_LIMIT_EXCEEDED") {
          failureProven = Boolean(attempt.request) && execution.spawned && execution.stderr_limit_exceeded
            && attempt.failure.stage === "process_execution";
        } else if (attempt.error_code === "NONZERO_EXIT") {
          failureProven = Boolean(attempt.request) && execution.spawned
            && (execution.exit_code !== 0 || execution.signal !== null)
            && attempt.failure.stage === "process_execution";
        } else if (attempt.error_code === "INVALID_RESPONSE_JSON" && cleanSpawnedExit
          && attempt.failure.stage === "response_parse") {
          try {
            JSON.parse(stdoutBytes.toString("utf8"));
          } catch {
            failureProven = true;
          }
        } else if (attempt.error_code === "INVALID_RESPONSE_CONTRACT" && cleanSpawnedExit
          && attempt.failure.stage === "response_validation") {
          try {
            const rejectedResponse = JSON.parse(stdoutBytes.toString("utf8"));
            assertSchema(rejectedResponse, responseSchema, "rejected extraction candidate response");
            validateCandidateResponseSemantics(rejectedResponse, attempt.request, { targetSchema: fixture.target_schema });
          } catch (error) {
            if (!(error instanceof SyntaxError)) failureProven = true;
          }
        }
      }
      if (!failureProven) throw new Error(`Error attempt lacks independently checkable failure evidence for ${attempt.case_id}`);
    }
  }
  return true;
}
