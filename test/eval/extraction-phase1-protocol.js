import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

export const PHASE1_PROTOCOL = "pdf-tools.extraction-candidate.v1";
export const PHASE1_REGISTRY_ID = "pdf-tools.extraction-candidate-registry.v1";
export const PHASE1_PLAN_ID = "pdf-tools.extraction-phase1-plan.v1";
export const PHASE1_REPORT_ID = "pdf-tools.extraction-phase1-report.v1";
export const PREDECLARED_CANDIDATE_IDS = Object.freeze([
  "control.current_product.v0",
  "candidate.layout_ir.v1",
  "candidate.direct_pdf.v1",
  "candidate.raster.v1",
  "candidate.remote_model.v1",
]);

const SHA256 = /^[a-f0-9]{64}$/;
const INPUT_MODES = new Set(["layout_ir", "direct_pdf", "raster"]);
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
  geometryReconciliation = null,
}) {
  if (!PREDECLARED_CANDIDATE_IDS.includes(candidateId)) throw new Error(`Unknown candidate ID: ${candidateId}`);
  if (!INPUT_MODES.has(inputMode)) throw new Error(`Unsupported input mode: ${inputMode}`);
  if (!path.isAbsolute(stagedSourcePath)) throw new Error("Staged candidate source path must be absolute");
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
      geometry_reconciliation: geometryReconciliation,
    },
    task: {
      instruction: "Return only source-supported structured data conforming to target_schema, with field-level evidence or a typed gap.",
      target_schema: targetSchema,
      target_schema_sha256: targetSchemaSha256,
    },
    limits: structuredClone(limits),
  };
  const request = {
    protocol: PHASE1_PROTOCOL,
    request_id: sha256(Buffer.from(canonicalJson({ ...requestBody, attempt_binding: attemptBinding }))),
    ...requestBody,
  };
  assertTruthProjectedRequest(request, { repositoryRoot });
  return request;
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
  if (pointer === "/") return { found: true, value };
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
  return [pointer || "/"];
}

export function validateCandidateResponseSemantics(response, request, {
  targetSchema,
  geometryReconciled = false,
} = {}) {
  assertResponseIdentity(response, request);
  const requestedLeaves = deriveTargetLeafPointers(targetSchema);
  const requestedLeafSet = new Set(requestedLeaves);
  const evidenceIds = response.evidence.map(item => item.id);
  if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error("Candidate response contains duplicate evidence IDs");
  const evidenceIdSet = new Set(evidenceIds);
  for (const evidence of response.evidence) {
    if (evidence.page > request.source.page_count) throw new Error("Candidate evidence references a page outside the source");
  }
  if (response.evidence.length > 0 && !geometryReconciled) {
    throw new Error("Candidate evidence geometry is not independently reconciled to pdf-tools.display-top-left-points.v1");
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
  }
  for (const table of response.tables) {
    if (table.pages.some(page => page > request.source.page_count)) throw new Error("Candidate table references a page outside the source");
  }
  const fieldPaths = response.field_evidence.map(item => item.field_path);
  if (new Set(fieldPaths).size !== fieldPaths.length) throw new Error("Candidate response contains duplicate field-evidence paths");
  const runnerFieldBindings = [];
  for (const binding of response.field_evidence) {
    if (!requestedLeafSet.has(binding.field_path)) {
      throw new Error(`Candidate field evidence does not reference an exact requested leaf: ${binding.field_path}`);
    }
    const resolved = valueAtJsonPointer(response.structured_candidate, binding.field_path);
    if (!resolved.found) throw new Error(`Candidate field evidence references a missing value: ${binding.field_path}`);
    if (binding.evidence_ids.some(id => !evidenceIdSet.has(id))) {
      throw new Error(`Candidate field evidence references an unknown evidence ID: ${binding.field_path}`);
    }
    runnerFieldBindings.push({
      field_path: binding.field_path,
      value_sha256: sha256(Buffer.from(canonicalJson(resolved.value))),
      evidence_ids: [...binding.evidence_ids],
    });
  }
  const gapPaths = response.gaps.map(gap => gap.field_path);
  if (new Set(gapPaths).size !== gapPaths.length) throw new Error("Candidate response contains duplicate gap paths");
  for (const gapPath of gapPaths) {
    if (!requestedLeafSet.has(gapPath)) throw new Error(`Candidate gap is not an exact requested leaf: ${gapPath}`);
  }
  const answeredLeaves = requestedLeaves.filter(pointer => valueAtJsonPointer(response.structured_candidate, pointer).found);
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
  }
  return runnerFieldBindings;
}

export function reportAttemptKey(attempt) {
  return `${attempt.candidate_id}\u0000${attempt.case_id}\u0000${attempt.repetition}`;
}

export function verifyPhase1Report(report, {
  registry,
  registrySha256,
  plan,
  planSha256,
  manifestSha256,
  manifestCaseIds,
  manifestFixtures = null,
  requestSchema,
  responseSchema,
  repositoryRoot = null,
}) {
  if (report.report_id !== PHASE1_REPORT_ID) throw new Error("Unexpected extraction Phase 1 report ID");
  if (report.benchmark_claim_ready !== false || report.calibration_claim_ready !== false) {
    throw new Error("Extraction Phase 1 readiness flags must remain false");
  }
  if (report.registry_sha256 !== registrySha256
    || report.plan_sha256 !== planSha256
    || report.phase0_manifest_sha256 !== manifestSha256) {
    throw new Error("Extraction Phase 1 report input bindings are invalid");
  }
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
  if (report.denominator.planned !== expectedKeys.length || report.denominator.retained !== observedKeys.length) {
    throw new Error("Extraction Phase 1 denominator counts do not match retained attempts");
  }
  for (const outcome of ["completed", "partial", "abstained", "error", "not_run"]) {
    const count = report.attempts.filter(attempt => attempt.outcome === outcome).length;
    if (report.denominator.outcomes[outcome] !== count) throw new Error(`Incorrect ${outcome} denominator count`);
  }
  const registryIds = new Set(registry.candidates.map(candidate => candidate.id));
  const fixturesById = new Map((manifestFixtures ?? []).map(fixture => [fixture.id, fixture]));
  for (const attempt of report.attempts) {
    if (!registryIds.has(attempt.candidate_id)) throw new Error(`Report retains unknown candidate ${attempt.candidate_id}`);
    if (!SHA256.test(attempt.source.sha256)
      || (attempt.source.after_sha256 !== null && !SHA256.test(attempt.source.after_sha256))) {
      throw new Error(`Report has an invalid source digest for ${attempt.case_id}`);
    }
    const sourceMutated = attempt.source.sha256 !== attempt.source.after_sha256;
    if (sourceMutated && (attempt.outcome !== "error" || attempt.error_code !== "SOURCE_MUTATED")) {
      throw new Error(`Report does not fail closed on source mutation for ${attempt.case_id}`);
    }
    if (attempt.source.immutable !== !sourceMutated) {
      throw new Error(`Report source immutability flag is invalid for ${attempt.case_id}`);
    }
    const fixture = fixturesById.get(attempt.case_id);
    if (fixture && (attempt.source.manifest_path !== fixture.path || attempt.source.sha256 !== fixture.sha256)) {
      throw new Error(`Report source is not bound to the Phase 0 fixture for ${attempt.case_id}`);
    }
    if (attempt.request) {
      if (requestSchema) assertSchema(attempt.request, requestSchema, "retained extraction candidate request");
      if (sha256(Buffer.from(canonicalJson(attempt.request))) !== attempt.bindings.request_sha256) {
        throw new Error(`Report request binding is invalid for ${attempt.case_id}`);
      }
      assertTruthProjectedRequest(attempt.request, { repositoryRoot });
    } else if (attempt.bindings.request_sha256 !== null) {
      throw new Error(`Not-run attempt has an unexplained request digest for ${attempt.case_id}`);
    }
    if (attempt.response) {
      if (responseSchema) assertSchema(attempt.response, responseSchema, "retained extraction candidate response");
      if (sha256(Buffer.from(canonicalJson(attempt.response))) !== attempt.bindings.response_canonical_sha256) {
        throw new Error(`Report response binding is invalid for ${attempt.case_id}`);
      }
      assertResponseIdentity(attempt.response, attempt.request);
      if (fixture) {
        const geometry = attempt.request.inputs.geometry_reconciliation;
        const inputPayload = attempt.request.input_mode === "layout_ir"
          ? attempt.request.inputs.layout_ir
          : attempt.request.input_mode === "raster"
            ? attempt.request.inputs.raster_manifest
            : null;
        const geometryReconciled = attempt.request.input_mode !== "direct_pdf"
          && geometry?.status === "proven"
          && geometry.coordinate_space === "pdf-tools.display-top-left-points.v1"
          && geometry.source_sha256 === attempt.source.sha256
          && geometry.input_sha256 === sha256(Buffer.from(canonicalJson(inputPayload)));
        validateCandidateResponseSemantics(attempt.response, attempt.request, {
          targetSchema: fixture.target_schema,
          geometryReconciled,
        });
      }
      if (attempt.outcome !== attempt.response.status) {
        throw new Error(`Report outcome is not bound to the retained response for ${attempt.case_id}`);
      }
      const expectedFieldBindings = attempt.response.field_evidence.map(binding => {
        const resolved = valueAtJsonPointer(attempt.response.structured_candidate, binding.field_path);
        if (!resolved.found) throw new Error(`Retained field evidence references a missing value: ${binding.field_path}`);
        return {
          field_path: binding.field_path,
          value_sha256: sha256(Buffer.from(canonicalJson(resolved.value))),
          evidence_ids: [...binding.evidence_ids],
        };
      });
      if (canonicalJson(attempt.runner_field_bindings) !== canonicalJson(expectedFieldBindings)) {
        throw new Error(`Runner-owned field-value bindings are invalid for ${attempt.case_id}`);
      }
    } else if (attempt.bindings.response_canonical_sha256 !== null) {
      throw new Error(`Attempt has an unexplained canonical response digest for ${attempt.case_id}`);
    } else if (attempt.runner_field_bindings.length !== 0) {
      throw new Error(`Attempt has field-value bindings without a retained response for ${attempt.case_id}`);
    }
  }
  return true;
}
