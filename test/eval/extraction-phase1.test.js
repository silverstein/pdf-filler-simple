import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCandidateRequest,
  canonicalJson,
  deriveTargetLeafPointers,
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
  extraArgs = [],
  inputBuilders = null,
  geometryReconciliationVerifier = null,
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
  candidate.command = { executable: process.execPath, args: [MOCK_CANDIDATE, mode, ...extraArgs] };
  plan.case_ids = [manifest.fixtures[0].id];
  plan.repetitions = repetitions;
  plan.candidates = [{ candidate_id: candidateId, input_mode: inputMode }];
  plan.limits.deadline_ms = deadlineMs;
  plan.limits.max_stdout_bytes = maxStdoutBytes;
  const registryPath = path.join(root, "registry.json");
  const planPath = path.join(root, "plan.json");
  await Promise.all([
    fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`),
    fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`),
  ]);
  return runExtractionCandidates({
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
    geometryReconciliationVerifier,
  });
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
      limits: { deadline_ms: 1000, max_stdout_bytes: 1024, max_stderr_bytes: 0, max_source_bytes: 1000, max_pages: 1 },
      repositoryRoot: REPO_ROOT,
      attemptBinding: "opaque-attempt",
    });
    const serialized = canonicalJson(request);
    for (const forbidden of ["ground_truth", "expected", "partition", "category", "fact_ids", "answer_state", "evaluation_policy", REPO_ROOT]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(request.request_id).toMatch(/^[a-f0-9]{64}$/);
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
      limits: { deadline_ms: 1000, max_stdout_bytes: 1024, max_stderr_bytes: 0, max_source_bytes: 1000, max_pages: 1 },
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
    ]) {
      const mutant = structuredClone(partial);
      mutate(mutant);
      expect(() => validateCandidateResponseSemantics(mutant, request, { targetSchema })).toThrow();
    }

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
  });

  it("retains every default candidate, case, and repetition as explicit not_run", async () => {
    const report = await runExtractionCandidates();
    expect(report.denominator).toMatchObject({
      planned: 120,
      retained: 120,
      outcomes: { completed: 0, partial: 0, abstained: 0, error: 0, not_run: 120 },
    });
    expect(report.benchmark_claim_ready).toBe(false);
    expect(report.calibration_claim_ready).toBe(false);
    expect(report.environment).toMatchObject({
      fresh_process_per_attempt: true,
      network_isolation: false,
      filesystem_isolation: false,
      memory_limit: false,
      process_tree_memory_measurement: false,
    });
  });

  it("uses a fresh process for every repetition and accepts typed partial and abstained outcomes", async () => {
    const completed = await configuredRun("completed");
    expect(completed.attempts[0]).toMatchObject({ outcome: "completed", error_code: null });

    const partial = await configuredRun("partial", { repetitions: 2 });
    expect(partial.denominator.outcomes.partial).toBe(2);
    expect(new Set(partial.attempts.map(attempt => attempt.response.diagnostics.message)).size).toBe(2);
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

  it("accepts geometry evidence only behind a runner-owned reconciliation and recomputes field digests", async () => {
    const native = await configuredRun("native-evidence");
    expect(native.attempts[0]).toMatchObject({
      outcome: "partial",
      response: { evidence: [], native_evidence: [{ coordinate_space: "test-engine.bottom-left-points.v1", native_ref: "#/texts/0" }] },
    });

    const rejected = await configuredRun("evidence");
    expect(rejected.attempts[0]).toMatchObject({ outcome: "error", error_code: "INVALID_RESPONSE_CONTRACT" });

    let observedBuilderInput;
    const accepted = await configuredRun("evidence", {
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
      geometryReconciliationVerifier: async ({ input_mode: inputMode, input, task }) => {
        expect(inputMode).toBe("layout_ir");
        expect(input.ir).toEqual({ name: "pdf-tools.extraction-ir", version: "1.0.0" });
        expect(Object.isFrozen(task)).toBe(true);
        return "phase1-test exact display geometry oracle";
      },
    });
    expect(accepted.attempts[0].outcome).toBe("partial");
    expect(accepted.attempts[0].response.field_evidence[0]).not.toHaveProperty("value_sha256");
    expect(accepted.attempts[0].request.inputs.geometry_reconciliation).toMatchObject({
      status: "proven",
      coordinate_space: "pdf-tools.display-top-left-points.v1",
      method: "phase1-test exact display geometry oracle",
      source_sha256: accepted.attempts[0].source.sha256,
    });
    expect(Object.isFrozen(observedBuilderInput.task)).toBe(true);
    expect(Object.isFrozen(observedBuilderInput.task.source)).toBe(true);
    expect(canonicalJson(observedBuilderInput.task)).not.toMatch(/ground_truth|expected|partition|category|fact_ids|answer_state|evaluation_policy|\.pdf|pdf-tools\.extraction\.phase0/);
    expect(observedBuilderInput).not.toHaveProperty("fixture");
    expect(accepted.attempts[0].runner_field_bindings).toEqual([{
      field_path: "/vendor",
      value_sha256: sha256(Buffer.from(canonicalJson("fixture-value"))),
      evidence_ids: ["evidence.1"],
    }]);
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

  it("rejects retained report, field digest, and denominator mutation", async () => {
    const report = await configuredRun("partial");
    const [registry, plan, manifest, requestSchema, responseSchema] = await Promise.all([
      loadJsonWithSchema(REGISTRY, REGISTRY_SCHEMA, "registry"),
      loadJsonWithSchema(PLAN, PLAN_SCHEMA, "plan"),
      fs.readFile(MANIFEST, "utf8").then(JSON.parse),
      fs.readFile(REQUEST_SCHEMA, "utf8").then(JSON.parse),
      fs.readFile(RESPONSE_SCHEMA, "utf8").then(JSON.parse),
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
    const verify = mutant => verifyPhase1Report(mutant, {
      registry: configuredRegistry,
      registrySha256: report.registry_sha256,
      plan: configuredPlan,
      planSha256: report.plan_sha256,
      manifestSha256: report.phase0_manifest_sha256,
      manifestCaseIds: manifest.fixtures.map(fixture => fixture.id),
      manifestFixtures: manifest.fixtures,
      requestSchema,
      responseSchema,
    });
    expect(verify(report)).toBe(true);
    for (const mutate of [
      value => { value.attempts.pop(); },
      value => { value.denominator.outcomes.partial = 0; },
      value => { value.attempts[0].bindings.request_sha256 = "0".repeat(64); },
      value => { value.attempts[0].outcome = "completed"; value.denominator.outcomes.partial = 0; value.denominator.outcomes.completed = 1; },
    ]) {
      const mutant = structuredClone(report);
      mutate(mutant);
      expect(() => verify(mutant)).toThrow();
    }
  });
});
