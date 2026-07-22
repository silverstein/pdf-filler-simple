import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCandidateRequest,
  canonicalJson,
  computeCandidateRequestId,
  deriveTargetLeafPointers,
  loadPreflightEvidenceSidecar,
  loadJsonWithSchema,
  sha256,
  validatePlan,
  validateCandidateResponseSemantics,
  validateRegistry,
  verifyPhase1Report,
} from "./extraction-phase1-protocol.js";
import { runExtractionCandidates } from "../../scripts/eval-run-extraction-candidates.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTRACTION_ROOT = path.join(REPO_ROOT, "test", "fixtures", "eval", "extraction");
const PHASE1_ROOT = path.join(EXTRACTION_ROOT, "phase1");
const MOCK_CANDIDATE = path.join(PHASE1_ROOT, "mock-candidate.mjs");
const REGISTRY = path.join(PHASE1_ROOT, "candidate-registry.v1.json");
const REGISTRY_SCHEMA = path.join(PHASE1_ROOT, "candidate-registry.schema.json");
const PLAN = path.join(PHASE1_ROOT, "run-plan.v1.json");
const PLAN_SCHEMA = path.join(PHASE1_ROOT, "run-plan.schema.json");
const REQUEST_SCHEMA = path.join(PHASE1_ROOT, "candidate-request.schema.json");
const RESPONSE_SCHEMA = path.join(PHASE1_ROOT, "candidate-response.schema.json");
const REPORT_SCHEMA = path.join(PHASE1_ROOT, "report.schema.json");
const MANIFEST = path.join(EXTRACTION_ROOT, "manifest.v1.json");
const MANIFEST_SCHEMA = path.join(EXTRACTION_ROOT, "manifest.schema.json");
const DIRECT_ONLY_ADAPTERS = Object.freeze({ direct_pdf: true, layout_ir: false, raster: false });
const temporaryRoots = [];

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-phase1-test-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function configuredRun(mode, {
  candidateId = "candidate.direct_pdf.v1",
  inputMode = "direct_pdf",
  repetitions = 1,
  deadlineMs = 2000,
  maxStdoutBytes = 4096,
  maxRequestBytes = null,
  extraArgs = [],
  inputBuilders = null,
  executable = process.execPath,
  returnContext = false,
} = {}) {
  const root = await temporaryRoot();
  const [registry, plan, manifest] = await Promise.all([
    fs.readFile(REGISTRY, "utf8").then(JSON.parse),
    fs.readFile(PLAN, "utf8").then(JSON.parse),
    fs.readFile(MANIFEST, "utf8").then(JSON.parse),
  ]);
  const candidate = registry.candidates.find(item => item.id === candidateId);
  candidate.configured = true;
  candidate.version = "test-double-1.0.0";
  candidate.license = { framework_spdx: "MIT", model_license: null, reviewed: true };
  candidate.command = { executable, args: [MOCK_CANDIDATE, mode, ...extraArgs] };
  plan.case_ids = [manifest.fixtures[0].id];
  plan.repetitions = repetitions;
  plan.candidates = [{ candidate_id: candidateId, input_mode: inputMode }];
  plan.limits.deadline_ms = deadlineMs;
  plan.limits.max_stdout_bytes = maxStdoutBytes;
  if (maxRequestBytes !== null) plan.limits.max_request_bytes = maxRequestBytes;
  const registryPath = path.join(root, "registry.json");
  const planPath = path.join(root, "plan.json");
  await Promise.all([
    fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`),
    fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`),
  ]);
  const verificationEvidence = {};
  const report = await runExtractionCandidates({
    manifestPath: MANIFEST,
    manifestSchemaPath: MANIFEST_SCHEMA,
    registryPath,
    registrySchemaPath: REGISTRY_SCHEMA,
    planPath,
    planSchemaPath: PLAN_SCHEMA,
    requestSchemaPath: REQUEST_SCHEMA,
    responseSchemaPath: RESPONSE_SCHEMA,
    reportSchemaPath: REPORT_SCHEMA,
    inputBuilders,
    verificationEvidence,
  });
  return returnContext ? { report, registry, plan, verificationEvidence } : report;
}

describe("structured extraction Phase 1 external candidate boundary", () => {
  it("strictly validates the predeclared registry and default three-repetition plan", async () => {
    const [registry, plan] = await Promise.all([
      loadJsonWithSchema(REGISTRY, REGISTRY_SCHEMA, "candidate registry"),
      loadJsonWithSchema(PLAN, PLAN_SCHEMA, "candidate plan"),
    ]);
    expect(validateRegistry(registry.value)).toBe(true);
    expect(validatePlan(plan.value, registry.value)).toBe(true);
    expect(plan.value.repetitions).toBe(3);
    expect(registry.value.candidates.map(item => item.id)).toEqual([
      "control.current_product.v0",
      "candidate.layout_ir.v1",
      "candidate.direct_pdf.v1",
      "candidate.raster.v1",
      "candidate.remote_model.v1",
    ]);
    expect(registry.value.candidates.every(item => item.configured === false && item.command === null)).toBe(true);
  });

  it("constructs a hash-bound truth projection without scorer or repository context", () => {
    const request = buildCandidateRequest({
      candidateId: "candidate.direct_pdf.v1",
      inputMode: "direct_pdf",
      stagedSourcePath: path.join(os.tmpdir(), "phase1-source.pdf"),
      sourceSha256: "a".repeat(64),
      sourceSizeBytes: 100,
      pageCount: 1,
      targetSchema: { type: "object", properties: { vendor: { type: "string" } } },
      limits: { deadline_ms: 1000, max_stdout_bytes: 1024, max_stderr_bytes: 0, max_request_bytes: 4096, max_source_bytes: 1000, max_pages: 1 },
      repositoryRoot: REPO_ROOT,
      attemptBinding: "opaque-attempt",
    });
    const serialized = canonicalJson(request);
    for (const forbidden of ["ground_truth", "expected", "partition", "category", "fact_ids", "answer_state", "evaluation_policy", REPO_ROOT]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(request.request_id).toMatch(/^[a-f0-9]{64}$/);
    expect(request.request_id).toBe(computeCandidateRequestId(request, "opaque-attempt"));
    const mutated = structuredClone(request);
    mutated.source.sha256 = "b".repeat(64);
    expect(sha256(Buffer.from(canonicalJson(mutated)))).not.toBe(sha256(Buffer.from(canonicalJson(request))));
  });

  it("accounts for exact target-schema leaves across completed, partial, abstained, and error responses", () => {
    const targetSchema = {
      type: "object",
      additionalProperties: false,
      required: ["a", "nested"],
      properties: {
        a: { type: "string" },
        nested: {
          type: "object",
          additionalProperties: false,
          required: ["b"],
          properties: { b: { type: "number" } },
        },
      },
    };
    expect(deriveTargetLeafPointers(targetSchema)).toEqual(["/a", "/nested/b"]);
    const request = buildCandidateRequest({
      candidateId: "candidate.direct_pdf.v1",
      inputMode: "direct_pdf",
      stagedSourcePath: path.join(os.tmpdir(), "phase1-source.pdf"),
      sourceSha256: "a".repeat(64),
      sourceSizeBytes: 100,
      pageCount: 1,
      targetSchema,
      limits: { deadline_ms: 1000, max_stdout_bytes: 1024, max_stderr_bytes: 0, max_request_bytes: 4096, max_source_bytes: 1000, max_pages: 1 },
    });
    const partial = {
      protocol: request.protocol,
      request_id: request.request_id,
      status: "partial",
      decision: "answer",
      structured_candidate: { a: "answered" },
      page_texts: [], tables: [], native_evidence: [], evidence: [], field_evidence: [],
      gaps: [{ field_path: "/nested/b", reason: "absent_in_source", detail: "No source-supported value" }],
      diagnostics: { code: null, message: null },
    };
    expect(validateCandidateResponseSemantics(partial, request, { targetSchema })).toEqual([]);
    for (const mutate of [
      value => { value.gaps[0].field_path = "/nested"; },
      value => { value.gaps.push(structuredClone(value.gaps[0])); },
      value => { value.gaps[0].field_path = "/a"; },
      value => { value.gaps = []; },
      value => { value.structured_candidate.a = 42; },
      value => { value.structured_candidate.extra = true; },
      value => { value.structured_candidate.nested = {}; },
    ]) {
      const mutant = structuredClone(partial);
      mutate(mutant);
      expect(() => validateCandidateResponseSemantics(mutant, request, { targetSchema })).toThrow();
    }
    const diagnosticMutant = structuredClone(partial);
    diagnosticMutant.diagnostics.message = "not allowed on non-error output";
    expect(() => validateCandidateResponseSemantics(diagnosticMutant, request, { targetSchema })).toThrow();

    const completed = structuredClone(partial);
    Object.assign(completed, {
      status: "completed",
      structured_candidate: { a: "answered", nested: { b: 2 } },
      gaps: [],
    });
    expect(validateCandidateResponseSemantics(completed, request, { targetSchema })).toEqual([]);

    const abstained = structuredClone(partial);
    Object.assign(abstained, {
      status: "abstained",
      decision: "abstain",
      structured_candidate: null,
      gaps: ["/a", "/nested/b"].map(fieldPath => ({ field_path: fieldPath, reason: "insufficient_evidence", detail: "No answer" })),
    });
    expect(validateCandidateResponseSemantics(abstained, request, { targetSchema })).toEqual([]);
    abstained.gaps.pop();
    expect(() => validateCandidateResponseSemantics(abstained, request, { targetSchema })).toThrow();

    const error = structuredClone(abstained);
    Object.assign(error, {
      status: "error",
      gaps: [],
      diagnostics: { code: "MODEL_FAILURE", message: "Candidate could not process the source" },
    });
    expect(validateCandidateResponseSemantics(error, request, { targetSchema })).toEqual([]);
    error.diagnostics.code = "unstable code";
    expect(() => validateCandidateResponseSemantics(error, request, { targetSchema })).toThrow();

    const optionalSchema = structuredClone(targetSchema);
    optionalSchema.required = ["a"];
    expect(() => deriveTargetLeafPointers(optionalSchema)).toThrow(/every declared object property/);
    expect(deriveTargetLeafPointers({ type: "string" })).toEqual([""]);
    expect(deriveTargetLeafPointers({
      type: "object",
      additionalProperties: false,
      required: [""],
      properties: { "": { type: "string" } },
    })).toEqual(["/"]);

    const rootSchema = { type: "string" };
    const rootRequest = buildCandidateRequest({
      candidateId: "candidate.direct_pdf.v1",
      inputMode: "direct_pdf",
      stagedSourcePath: path.join(os.tmpdir(), "phase1-root-source.pdf"),
      sourceSha256: "a".repeat(64),
      sourceSizeBytes: 100,
      pageCount: 1,
      targetSchema: rootSchema,
      limits: { deadline_ms: 1000, max_stdout_bytes: 1024, max_stderr_bytes: 0, max_request_bytes: 4096, max_source_bytes: 1000, max_pages: 1 },
    });
    const rootCompleted = {
      ...structuredClone(completed),
      request_id: rootRequest.request_id,
      structured_candidate: "root answer",
    };
    expect(validateCandidateResponseSemantics(rootCompleted, rootRequest, { targetSchema: rootSchema })).toEqual([]);
    const rootAbstained = {
      ...structuredClone(abstained),
      request_id: rootRequest.request_id,
      gaps: [{ field_path: "", reason: "insufficient_evidence", detail: "No root answer" }],
    };
    expect(validateCandidateResponseSemantics(rootAbstained, rootRequest, { targetSchema: rootSchema })).toEqual([]);
  });

  it("retains every default candidate, case, and repetition as explicit not_run", async () => {
    const root = await temporaryRoot();
    const outputPath = path.join(root, "phase1-report.json");
    const verificationEvidence = {};
    const report = await runExtractionCandidates({ outputPath, verificationEvidence });
    const sidecarPath = `${outputPath}.preflight.json`;
    const loadedEvidence = await loadPreflightEvidenceSidecar(sidecarPath, report);
    expect(loadedEvidence).toEqual(verificationEvidence.failureEvidenceByAttemptKey);
    const malformedSidecar = JSON.parse(await fs.readFile(sidecarPath, "utf8"));
    malformedSidecar.unexpected = true;
    await fs.writeFile(sidecarPath, `${JSON.stringify(malformedSidecar, null, 2)}\n`);
    await expect(loadPreflightEvidenceSidecar(sidecarPath, report)).rejects.toThrow();
    expect(report.denominator).toMatchObject({
      planned: 120,
      retained: 120,
      outcomes: { completed: 0, partial: 0, abstained: 0, error: 0, not_run: 120 },
    });
    expect(report.benchmark_claim_ready).toBe(false);
    expect(report.calibration_claim_ready).toBe(false);
    expect(report.truth_isolation_claim_ready).toBe(false);
    expect(report.environment).toMatchObject({
      fresh_process_per_attempt: true,
      network_isolation: false,
      filesystem_isolation: false,
      memory_limit: false,
      process_tree_memory_measurement: false,
    });

    const [registry, registrySchema, plan, planSchema, manifest, requestSchema, responseSchema, reportSchema] = await Promise.all([
      fs.readFile(REGISTRY, "utf8").then(JSON.parse),
      fs.readFile(REGISTRY_SCHEMA, "utf8").then(JSON.parse),
      fs.readFile(PLAN, "utf8").then(JSON.parse),
      fs.readFile(PLAN_SCHEMA, "utf8").then(JSON.parse),
      fs.readFile(MANIFEST, "utf8").then(JSON.parse),
      fs.readFile(REQUEST_SCHEMA, "utf8").then(JSON.parse),
      fs.readFile(RESPONSE_SCHEMA, "utf8").then(JSON.parse),
      fs.readFile(REPORT_SCHEMA, "utf8").then(JSON.parse),
    ]);
    const sourceFactsById = Object.fromEntries(await Promise.all(manifest.fixtures.map(async fixture => {
      const stat = await fs.stat(path.join(EXTRACTION_ROOT, fixture.path));
      return [fixture.id, {
        sha256: fixture.sha256,
        size_bytes: stat.size,
        page_count: fixture.expected.page_geometry.length,
      }];
    })));
    const verify = mutant => verifyPhase1Report(mutant, {
      registry,
      registrySchema,
      plan,
      planSchema,
      manifest,
      sourceFactsById,
      requestSchema,
      responseSchema,
      reportSchema,
      adapterAvailability: verificationEvidence.adapterAvailability,
      failureEvidenceByAttemptKey: verificationEvidence.failureEvidenceByAttemptKey,
    });
    expect(verify(report)).toBe(true);
    for (const outcome of ["completed", "partial", "abstained", "error"]) {
      const mutant = structuredClone(report);
      mutant.attempts[0].outcome = outcome;
      mutant.denominator.outcomes.not_run -= 1;
      mutant.denominator.outcomes[outcome] += 1;
      if (outcome === "error") {
        mutant.attempts[0].error_code = "HARNESS_ATTEMPT_FAILURE";
        mutant.attempts[0].outcome_reason = "Forged runner failure";
      }
      expect(() => verify(mutant), `not_run -> ${outcome}`).toThrow();
    }
    for (const mutate of [
      value => { value.environment.platform = value.environment.platform === "win32" ? "linux" : "win32"; },
      value => { value.environment.architecture = "forged-architecture"; },
      value => { value.environment.node_version = "v0.0.0"; },
      value => { value.attempts[0].execution.elapsed_ms = 1; },
      value => { value.unexpected = true; },
      value => { value.attempts[0].unexpected = true; },
      value => { value.claim_boundary = "Benchmark approved and ready"; },
      value => { value.limitations = ["No limitations"]; },
    ]) {
      const mutant = structuredClone(report);
      mutate(mutant);
      expect(() => verify(mutant)).toThrow();
    }

  });

  it("keeps an unconfigured candidate not_run when source preflight limits are ineligible", async () => {
    const root = await temporaryRoot();
    const [plan, manifest] = await Promise.all([
      fs.readFile(PLAN, "utf8").then(JSON.parse),
      fs.readFile(MANIFEST, "utf8").then(JSON.parse),
    ]);
    plan.case_ids = [manifest.fixtures[0].id];
    plan.repetitions = 1;
    plan.candidates = [{ candidate_id: "candidate.direct_pdf.v1", input_mode: "direct_pdf" }];
    plan.limits.max_source_bytes = 1;
    const planPath = path.join(root, "unconfigured-plan.json");
    await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    const report = await runExtractionCandidates({ planPath });
    expect(report.attempts[0]).toMatchObject({ outcome: "not_run", error_code: null, request: null });
  });

  it("cannot relabel an ineligible configured candidate as a success or runner error", async () => {
    const root = await temporaryRoot();
    const [registry, registrySchema, plan, planSchema, manifest, requestSchema, responseSchema, reportSchema] = await Promise.all([
      fs.readFile(REGISTRY, "utf8").then(JSON.parse),
      fs.readFile(REGISTRY_SCHEMA, "utf8").then(JSON.parse),
      fs.readFile(PLAN, "utf8").then(JSON.parse),
      fs.readFile(PLAN_SCHEMA, "utf8").then(JSON.parse),
      fs.readFile(MANIFEST, "utf8").then(JSON.parse),
      fs.readFile(REQUEST_SCHEMA, "utf8").then(JSON.parse),
      fs.readFile(RESPONSE_SCHEMA, "utf8").then(JSON.parse),
      fs.readFile(REPORT_SCHEMA, "utf8").then(JSON.parse),
    ]);
    const candidate = registry.candidates.find(item => item.id === "candidate.direct_pdf.v1");
    candidate.configured = true;
    candidate.version = "test-double-1.0.0";
    candidate.license = { framework_spdx: "MIT", model_license: null, reviewed: true };
    candidate.command = { executable: process.execPath, args: [MOCK_CANDIDATE, "partial"] };
    candidate.requirements.filesystem_isolation = true;
    plan.case_ids = [manifest.fixtures[0].id];
    plan.repetitions = 1;
    plan.candidates = [{ candidate_id: candidate.id, input_mode: "direct_pdf" }];
    const registryPath = path.join(root, "ineligible-registry.json");
    const planPath = path.join(root, "ineligible-plan.json");
    await Promise.all([
      fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`),
      fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`),
    ]);
    const verificationEvidence = {};
    const report = await runExtractionCandidates({ registryPath, planPath, verificationEvidence });
    expect(report.attempts[0]).toMatchObject({
      outcome: "not_run",
      unmet_requirements: ["filesystem_isolation"],
      request: null,
      response: null,
      execution: { spawned: false },
    });
    const fixture = manifest.fixtures[0];
    const stat = await fs.stat(path.join(EXTRACTION_ROOT, fixture.path));
    const verify = mutant => verifyPhase1Report(mutant, {
      registry,
      registrySchema,
      plan,
      planSchema,
      manifest,
      sourceFactsById: {
        [fixture.id]: {
          sha256: fixture.sha256,
          size_bytes: stat.size,
          page_count: fixture.expected.page_geometry.length,
        },
      },
      requestSchema,
      responseSchema,
      reportSchema,
      adapterAvailability: verificationEvidence.adapterAvailability,
      failureEvidenceByAttemptKey: verificationEvidence.failureEvidenceByAttemptKey,
    });
    const expectRelabelsRejected = (retainedReport, retainedPlan, retainedVerify, label) => {
      expect(retainedVerify(retainedReport)).toBe(true);
      for (const outcome of ["completed", "partial", "abstained"]) {
        const mutant = structuredClone(retainedReport);
        mutant.attempts[0].outcome = outcome;
        mutant.attempts[0].unmet_requirements = [];
        mutant.attempts[0].outcome_reason = "Forged successful attempt";
        mutant.denominator.outcomes.not_run = 0;
        mutant.denominator.outcomes[outcome] = 1;
        expect(() => retainedVerify(mutant), `${label} not_run -> ${outcome}`).toThrow();
      }
      for (const errorCode of ["HARNESS_ATTEMPT_FAILURE", "REQUEST_LIMIT_EXCEEDED"]) {
        const mutant = structuredClone(retainedReport);
        mutant.attempts[0].outcome = "error";
        mutant.attempts[0].error_code = errorCode;
        mutant.attempts[0].unmet_requirements = [];
        mutant.attempts[0].outcome_reason = "Forged runner failure";
        mutant.attempts[0].failure = errorCode === "REQUEST_LIMIT_EXCEEDED"
          ? {
              stage: "request_build",
              runner_code: errorCode,
              detail_code: errorCode,
              request_observed_bytes: retainedPlan.limits.max_request_bytes + 1,
              request_limit_bytes: retainedPlan.limits.max_request_bytes,
            }
          : {
              stage: "request_build",
              runner_code: errorCode,
              detail_code: "ERROR",
              request_observed_bytes: null,
              request_limit_bytes: null,
            };
        mutant.denominator.outcomes.not_run = 0;
        mutant.denominator.outcomes.error = 1;
        expect(() => retainedVerify(mutant), `${label} not_run -> ${errorCode}`).toThrow();
      }
    };
    expectRelabelsRejected(report, plan, verify, "capability-censored");

    const adapterRegistry = JSON.parse(await fs.readFile(REGISTRY, "utf8"));
    const adapterPlan = JSON.parse(await fs.readFile(PLAN, "utf8"));
    const adapterCandidate = adapterRegistry.candidates.find(item => item.id === "candidate.layout_ir.v1");
    adapterCandidate.configured = true;
    adapterCandidate.version = "test-double-1.0.0";
    adapterCandidate.license = { framework_spdx: "MIT", model_license: null, reviewed: true };
    adapterCandidate.command = { executable: process.execPath, args: [MOCK_CANDIDATE, "partial"] };
    adapterPlan.case_ids = [fixture.id];
    adapterPlan.repetitions = 1;
    adapterPlan.candidates = [{ candidate_id: adapterCandidate.id, input_mode: "layout_ir" }];
    const adapterRegistryPath = path.join(root, "adapter-ineligible-registry.json");
    const adapterPlanPath = path.join(root, "adapter-ineligible-plan.json");
    await Promise.all([
      fs.writeFile(adapterRegistryPath, `${JSON.stringify(adapterRegistry, null, 2)}\n`),
      fs.writeFile(adapterPlanPath, `${JSON.stringify(adapterPlan, null, 2)}\n`),
    ]);
    const adapterVerificationEvidence = {};
    const adapterReport = await runExtractionCandidates({
      registryPath: adapterRegistryPath,
      planPath: adapterPlanPath,
      verificationEvidence: adapterVerificationEvidence,
    });
    expect(adapterReport.attempts[0]).toMatchObject({
      outcome: "not_run",
      unmet_requirements: ["layout_ir_adapter"],
    });
    const verifyAdapter = mutant => verifyPhase1Report(mutant, {
      registry: adapterRegistry,
      registrySchema,
      plan: adapterPlan,
      planSchema,
      manifest,
      sourceFactsById: {
        [fixture.id]: {
          sha256: fixture.sha256,
          size_bytes: stat.size,
          page_count: fixture.expected.page_geometry.length,
        },
      },
      requestSchema,
      responseSchema,
      reportSchema,
      adapterAvailability: adapterVerificationEvidence.adapterAvailability,
      failureEvidenceByAttemptKey: adapterVerificationEvidence.failureEvidenceByAttemptKey,
    });
    expectRelabelsRejected(adapterReport, adapterPlan, verifyAdapter, "adapter-censored");
  });

  it("bounds the serialized request including supplemental adapter input", async () => {
    const { report, registry, plan, verificationEvidence } = await configuredRun("partial", {
      candidateId: "candidate.layout_ir.v1",
      inputMode: "layout_ir",
      maxRequestBytes: 1024,
      inputBuilders: { layout_ir: async () => ({ payload: { text: "x".repeat(4096) } }) },
      returnContext: true,
    });
    expect(report.attempts[0]).toMatchObject({
      outcome: "error",
      error_code: "REQUEST_LIMIT_EXCEEDED",
      request: null,
      execution: { spawned: false, process_id: null },
      failure: {
        stage: "request_build",
        runner_code: "REQUEST_LIMIT_EXCEEDED",
        request_limit_bytes: 1024,
      },
    });
    expect(report.attempts[0].failure.request_observed_bytes).toBeGreaterThan(1024);
    const [registrySchema, planSchema, manifest, requestSchema, responseSchema, reportSchema] = await Promise.all([
      fs.readFile(REGISTRY_SCHEMA, "utf8").then(JSON.parse),
      fs.readFile(PLAN_SCHEMA, "utf8").then(JSON.parse),
      fs.readFile(MANIFEST, "utf8").then(JSON.parse),
      fs.readFile(REQUEST_SCHEMA, "utf8").then(JSON.parse),
      fs.readFile(RESPONSE_SCHEMA, "utf8").then(JSON.parse),
      fs.readFile(REPORT_SCHEMA, "utf8").then(JSON.parse),
    ]);
    const fixture = manifest.fixtures[0];
    const stat = await fs.stat(path.join(EXTRACTION_ROOT, fixture.path));
    const verify = mutant => verifyPhase1Report(mutant, {
      registry,
      registrySchema,
      plan,
      planSchema,
      manifest,
      sourceFactsById: {
        [fixture.id]: {
          sha256: fixture.sha256,
          size_bytes: stat.size,
          page_count: fixture.expected.page_geometry.length,
        },
      },
      requestSchema,
      responseSchema,
      reportSchema,
      adapterAvailability: verificationEvidence.adapterAvailability,
      failureEvidenceByAttemptKey: verificationEvidence.failureEvidenceByAttemptKey,
    });
    expect(verify(report)).toBe(true);
    for (const mutate of [
      value => { value.attempts[0].failure.stage = "adapter_build"; },
      value => { value.attempts[0].failure.runner_code = "HARNESS_ATTEMPT_FAILURE"; },
      value => { value.attempts[0].failure.detail_code = "ERROR"; },
      value => { value.attempts[0].failure.request_observed_bytes += 1; },
      value => { value.attempts[0].failure.request_observed_bytes = 1024; },
      value => { value.attempts[0].failure.request_limit_bytes = 1025; },
      value => { value.environment.input_adapters.layout_ir = false; },
    ]) {
      const mutant = structuredClone(report);
      mutate(mutant);
      expect(() => verify(mutant)).toThrow();
    }

    const harnessContext = await configuredRun("partial", {
      candidateId: "candidate.layout_ir.v1",
      inputMode: "layout_ir",
      inputBuilders: {
        layout_ir: async () => {
          const error = new Error("adapter failed");
          error.code = "ADAPTER_FAILURE";
          throw error;
        },
      },
      returnContext: true,
    });
    expect(harnessContext.report.attempts[0]).toMatchObject({
      outcome: "error",
      error_code: "HARNESS_ATTEMPT_FAILURE",
      outcome_reason: "Runner could not complete the candidate attempt: ADAPTER_FAILURE",
      failure: {
        stage: "adapter_build",
        runner_code: "HARNESS_ATTEMPT_FAILURE",
        detail_code: "ADAPTER_FAILURE",
        request_observed_bytes: null,
        request_limit_bytes: null,
      },
    });
    const verifyHarness = mutant => verifyPhase1Report(mutant, {
      registry: harnessContext.registry,
      registrySchema,
      plan: harnessContext.plan,
      planSchema,
      manifest,
      sourceFactsById: {
        [fixture.id]: {
          sha256: fixture.sha256,
          size_bytes: stat.size,
          page_count: fixture.expected.page_geometry.length,
        },
      },
      requestSchema,
      responseSchema,
      reportSchema,
      adapterAvailability: harnessContext.verificationEvidence.adapterAvailability,
      failureEvidenceByAttemptKey: harnessContext.verificationEvidence.failureEvidenceByAttemptKey,
    });
    expect(verifyHarness(harnessContext.report)).toBe(true);
    for (const mutate of [
      value => { value.attempts[0].failure.stage = null; },
      value => { value.attempts[0].failure.stage = "request_build"; },
      value => { value.attempts[0].failure.runner_code = "REQUEST_LIMIT_EXCEEDED"; },
      value => { value.attempts[0].failure.detail_code = "FORGED_FAILURE"; },
      value => {
        value.attempts[0].failure.detail_code = "DIFFERENT_FAILURE";
        value.attempts[0].outcome_reason = "Runner could not complete the candidate attempt: DIFFERENT_FAILURE";
      },
      value => { value.attempts[0].failure.request_observed_bytes = 1; },
      value => { value.attempts[0].failure.request_limit_bytes = 1; },
    ]) {
      const mutant = structuredClone(harnessContext.report);
      mutate(mutant);
      expect(() => verifyHarness(mutant)).toThrow();
    }
  });

  it("uses a fresh process for every repetition and accepts typed partial and abstained outcomes", async () => {
    const completed = await configuredRun("completed");
    expect(completed.attempts[0]).toMatchObject({ outcome: "completed", error_code: null });

    const partial = await configuredRun("partial", { repetitions: 2 });
    expect(partial.denominator.outcomes.partial).toBe(2);
    expect(new Set(partial.attempts.map(attempt => attempt.execution.process_id)).size).toBe(2);
    expect(new Set(partial.attempts.map(attempt => attempt.request.request_id)).size).toBe(2);

    const abstained = await configuredRun("abstain");
    expect(abstained.attempts[0]).toMatchObject({ outcome: "abstained", error_code: null });
    expect(abstained.attempts[0].response.gaps[0].reason).toBe("unsupported_modality");
  });

  it("rejects malformed, replayed, over-limit, and falsely typed direct-PDF output", async () => {
    const cases = [
      ["multiple-json", "INVALID_RESPONSE_JSON"],
      ["wrong-request", "INVALID_RESPONSE_CONTRACT"],
      ["born-digital-direct", "INVALID_RESPONSE_CONTRACT"],
    ];
    for (const [mode, code] of cases) {
      const report = await configuredRun(mode);
      expect(report.attempts[0]).toMatchObject({ outcome: "error", error_code: code, response: null });
    }
    const overLimit = await configuredRun("oversize", { maxStdoutBytes: 1024 });
    expect(overLimit.attempts[0]).toMatchObject({
      outcome: "error",
      error_code: "STDOUT_LIMIT_EXCEEDED",
      execution: { stdout_limit_exceeded: true, process_group_termination_attempted: true },
    });
    const spawnFailure = await configuredRun("partial", { executable: path.join(os.tmpdir(), "missing-phase1-candidate") });
    expect(spawnFailure.attempts[0]).toMatchObject({
      outcome: "error",
      error_code: "SPAWN_FAILED",
      execution: { spawned: false, process_id: null },
      captures: { stdout_base64: null, stderr_base64: null },
    });
  });

  it("fails closed on source mutation while preserving the original fixture", async () => {
    const before = await fs.readFile(path.join(EXTRACTION_ROOT, "synthetic", "born-digital-flat.pdf"));
    const report = await configuredRun("mutate");
    expect(report.attempts[0]).toMatchObject({
      outcome: "error",
      error_code: "SOURCE_MUTATED",
      response: null,
      source: { immutable: false },
    });
    expect(await fs.readFile(path.join(EXTRACTION_ROOT, "synthetic", "born-digital-flat.pdf"))).toEqual(before);
  });

  it("retains native evidence but structurally prohibits canonical evidence for every input mode", async () => {
    const native = await configuredRun("native-evidence");
    expect(native.attempts[0]).toMatchObject({
      outcome: "partial",
      response: { evidence: [], native_evidence: [{ coordinate_space: "test-engine.bottom-left-points.v1", native_ref: "#/texts/0" }] },
    });
    for (const mutate of [
      value => { value.native_evidence.push(structuredClone(value.native_evidence[0])); },
      value => { value.native_evidence[0].bbox.x = 700; },
      value => { value.native_evidence[0].bbox.height = 900; },
    ]) {
      const mutant = structuredClone(native.attempts[0].response);
      mutate(mutant);
      expect(() => validateCandidateResponseSemantics(mutant, native.attempts[0].request, {
        targetSchema: native.attempts[0].request.task.target_schema,
      })).toThrow();
    }

    const rejected = await configuredRun("evidence");
    expect(rejected.attempts[0]).toMatchObject({ outcome: "error", error_code: "INVALID_RESPONSE_CONTRACT" });

    let observedBuilderInput;
    const emptyIrCannotAuthorize = await configuredRun("evidence", {
      candidateId: "candidate.layout_ir.v1",
      inputMode: "layout_ir",
      inputBuilders: {
        layout_ir: async input => {
          observedBuilderInput = input;
          return {
            payload: { ir: { name: "pdf-tools.extraction-ir", version: "1.0.0" }, pages: [] },
          };
        },
      },
    });
    expect(emptyIrCannotAuthorize.attempts[0]).toMatchObject({
      outcome: "error",
      error_code: "INVALID_RESPONSE_CONTRACT",
      response: null,
    });
    expect(Object.isFrozen(observedBuilderInput.task)).toBe(true);
    expect(Object.isFrozen(observedBuilderInput.task.source)).toBe(true);
    expect(canonicalJson(observedBuilderInput.task)).not.toMatch(/ground_truth|expected|partition|category|fact_ids|answer_state|evaluation_policy|\.pdf|pdf-tools\.extraction\.phase0/);
    expect(observedBuilderInput).not.toHaveProperty("fixture");
    expect(emptyIrCannotAuthorize.attempts[0].runner_field_bindings).toEqual([]);
  });

  it.runIf(process.platform !== "win32")("terminates the candidate process group at the deadline", async () => {
    const root = await temporaryRoot();
    const sentinel = path.join(root, "escaped-child.txt");
    const report = await configuredRun("timeout-tree", { deadlineMs: 100, extraArgs: [sentinel] });
    expect(report.attempts[0]).toMatchObject({
      outcome: "error",
      error_code: "DEADLINE_EXCEEDED",
      execution: { timed_out: true, process_group_termination_attempted: true },
    });
    await new Promise(resolve => setTimeout(resolve, 650));
    await expect(fs.access(sentinel)).rejects.toThrow();
  });

  it.runIf(process.platform !== "win32")("cleans the process group after a successful leader exits", async () => {
    const root = await temporaryRoot();
    const sentinel = path.join(root, "successful-escaped-child.txt");
    const report = await configuredRun("success-tree", { extraArgs: [sentinel] });
    expect(report.attempts[0]).toMatchObject({
      outcome: "partial",
      execution: {
        exit_code: 0,
        process_group_termination_attempted: true,
        process_group_empty_after_cleanup: true,
      },
    });
    await new Promise(resolve => setTimeout(resolve, 650));
    await expect(fs.access(sentinel)).rejects.toThrow();
  });

  it("preserves raw table values and rejects invalid span topology", async () => {
    const report = await configuredRun("table");
    const attempt = report.attempts[0];
    expect(attempt.outcome).toBe("partial");
    expect(attempt.response.tables[0].cells.map(cell => cell.value)).toEqual(["", 0, null]);
    expect(attempt.response.tables[0].cells.some(cell => cell.row === 2 && cell.column === 2)).toBe(false);
    const targetSchema = attempt.request.task.target_schema;
    for (const mutate of [
      value => { value.tables[0].cells.push(structuredClone(value.tables[0].cells[0])); },
      value => { value.tables[0].cells[0].column_span = 4; },
      value => { value.tables[0].cells[1].column = 2; },
      value => { value.tables[0].merged_regions = []; },
      value => { value.tables[0].cells[0].present = false; },
    ]) {
      const mutant = structuredClone(attempt.response);
      mutate(mutant);
      expect(() => validateCandidateResponseSemantics(mutant, attempt.request, { targetSchema })).toThrow();
    }
  });

  it("independently rejects schema, capture, execution, request, and denominator mutations", async () => {
    const configuredContext = await configuredRun("partial", { returnContext: true });
    const { report } = configuredContext;
    const [registry, registrySchema, plan, planSchema, manifest, requestSchema, responseSchema, reportSchema] = await Promise.all([
      loadJsonWithSchema(REGISTRY, REGISTRY_SCHEMA, "registry"),
      fs.readFile(REGISTRY_SCHEMA, "utf8").then(JSON.parse),
      loadJsonWithSchema(PLAN, PLAN_SCHEMA, "plan"),
      fs.readFile(PLAN_SCHEMA, "utf8").then(JSON.parse),
      fs.readFile(MANIFEST, "utf8").then(JSON.parse),
      fs.readFile(REQUEST_SCHEMA, "utf8").then(JSON.parse),
      fs.readFile(RESPONSE_SCHEMA, "utf8").then(JSON.parse),
      fs.readFile(REPORT_SCHEMA, "utf8").then(JSON.parse),
    ]);
    const configuredRegistry = structuredClone(registry.value);
    const candidate = configuredRegistry.candidates.find(item => item.id === "candidate.direct_pdf.v1");
    candidate.configured = true;
    candidate.version = "test-double-1.0.0";
    candidate.license = { framework_spdx: "MIT", model_license: null, reviewed: true };
    candidate.command = { executable: process.execPath, args: [MOCK_CANDIDATE, "partial"] };
    const configuredPlan = structuredClone(plan.value);
    configuredPlan.case_ids = [manifest.fixtures[0].id];
    configuredPlan.repetitions = 1;
    configuredPlan.candidates = [{ candidate_id: "candidate.direct_pdf.v1", input_mode: "direct_pdf" }];
    configuredPlan.limits.deadline_ms = 2000;
    configuredPlan.limits.max_stdout_bytes = 4096;
    const selectedFixture = manifest.fixtures[0];
    const selectedFixtureStat = await fs.stat(path.join(EXTRACTION_ROOT, selectedFixture.path));
    const sourceFactsById = {
      [selectedFixture.id]: {
        sha256: selectedFixture.sha256,
        size_bytes: selectedFixtureStat.size,
        page_count: selectedFixture.expected.page_geometry.length,
      },
    };
    const verify = mutant => verifyPhase1Report(mutant, {
      registry: configuredRegistry,
      registrySchema,
      plan: configuredPlan,
      planSchema,
      manifest,
      sourceFactsById,
      requestSchema,
      responseSchema,
      reportSchema,
      adapterAvailability: configuredContext.verificationEvidence.adapterAvailability,
      failureEvidenceByAttemptKey: configuredContext.verificationEvidence.failureEvidenceByAttemptKey,
    });
    expect(verify(report)).toBe(true);
    const rebindRequest = value => {
      value.attempts[0].bindings.request_sha256 = sha256(Buffer.from(canonicalJson(value.attempts[0].request)));
    };
    for (const mutate of [
      value => { value.attempts.pop(); },
      value => { value.denominator.outcomes.partial = 0; },
      value => { value.registry_schema_sha256 = "0".repeat(64); },
      value => { value.plan_schema_sha256 = "0".repeat(64); },
      value => { value.request_schema_sha256 = "0".repeat(64); },
      value => { value.response_schema_sha256 = "0".repeat(64); },
      value => { value.preflight_evidence_sha256 = "0".repeat(64); },
      value => { value.truth_isolation_claim_ready = true; },
      value => { value.claim_boundary = "Benchmark approved and ready"; },
      value => { value.limitations = ["No limitations"]; },
      value => { value.attempts[0].bindings.request_sha256 = "0".repeat(64); },
      value => { value.attempts[0].captures.stdout_base64 = Buffer.from("{}").toString("base64"); },
      value => { value.attempts[0].captures.stderr_base64 = Buffer.from("changed").toString("base64"); },
      value => { value.attempts[0].execution.stdout_bytes += 1; },
      value => { value.attempts[0].execution.stdout_limit_exceeded = true; },
      value => { value.attempts[0].execution.process_group_empty_after_cleanup = false; },
      value => { value.attempts[0].execution.spawned = false; },
      value => { value.attempts[0].execution.process_id = null; },
      value => { value.attempts[0].source.after_read_error = "EIO"; },
      value => { value.attempts[0].source.after_sha256 = null; },
      value => { value.attempts[0].source.immutable = false; },
      value => { value.attempts[0].source.size_bytes += 1; },
      value => { value.attempts[0].source.page_count += 1; },
      value => { value.attempts[0].request.request_id = "0".repeat(64); rebindRequest(value); },
      value => { value.attempts[0].request.candidate_id = "candidate.raster.v1"; rebindRequest(value); },
      value => { value.attempts[0].request.input_mode = "raster"; rebindRequest(value); },
      value => { value.attempts[0].request.source.sha256 = "0".repeat(64); rebindRequest(value); },
      value => { value.attempts[0].request.source.size_bytes += 1; rebindRequest(value); },
      value => { value.attempts[0].request.source.page_count += 1; rebindRequest(value); },
      value => { value.attempts[0].request.task.target_schema.properties.vendor.type = "number"; rebindRequest(value); },
      value => { value.attempts[0].request.task.target_schema_sha256 = "0".repeat(64); rebindRequest(value); },
      value => { value.attempts[0].request.limits.deadline_ms += 1; rebindRequest(value); },
      value => { value.attempts[0].outcome = "completed"; value.denominator.outcomes.partial = 0; value.denominator.outcomes.completed = 1; },
    ]) {
      const mutant = structuredClone(report);
      mutate(mutant);
      expect(() => verify(mutant)).toThrow();
    }

    const failedContext = await configuredRun("multiple-json", { returnContext: true });
    const noResponseError = failedContext.report;
    const failedRegistry = structuredClone(configuredRegistry);
    failedRegistry.candidates.find(item => item.id === "candidate.direct_pdf.v1").command.args = [MOCK_CANDIDATE, "multiple-json"];
    const verifyFailed = mutant => verifyPhase1Report(mutant, {
      registry: failedRegistry,
      registrySchema,
      plan: configuredPlan,
      planSchema,
      manifest,
      sourceFactsById,
      requestSchema,
      responseSchema,
      reportSchema,
      adapterAvailability: failedContext.verificationEvidence.adapterAvailability,
      failureEvidenceByAttemptKey: failedContext.verificationEvidence.failureEvidenceByAttemptKey,
    });
    expect(verifyFailed(noResponseError)).toBe(true);
    const forgedSuccess = structuredClone(noResponseError);
    forgedSuccess.attempts[0].outcome = "completed";
    forgedSuccess.attempts[0].error_code = null;
    forgedSuccess.denominator.outcomes.error = 0;
    forgedSuccess.denominator.outcomes.completed = 1;
    expect(() => verifyFailed(forgedSuccess)).toThrow();
  });
});
