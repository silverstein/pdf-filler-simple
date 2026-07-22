#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import {
  PHASE1_CLAIM_BOUNDARY,
  PHASE1_LIMITATIONS,
  PHASE1_REPORT_ID,
  assertSchema,
  buildCandidateRequest,
  canonicalJson,
  detectHarnessCapabilities,
  loadJsonWithSchema,
  reportAttemptKey,
  sha256,
  unmetRequirements,
  validateCandidateResponseSemantics,
  validatePlan,
  validateRegistry,
  verifyPhase1Report,
} from "../test/eval/extraction-phase1-protocol.js";
import {
  loadExtractionManifest,
  resolveExtractionFixture,
} from "../test/eval/extraction-manifest.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTRACTION_ROOT = path.join(REPO_ROOT, "test", "fixtures", "eval", "extraction");
const PHASE1_ROOT = path.join(EXTRACTION_ROOT, "phase1");
const DEFAULT_PATHS = Object.freeze({
  manifest: path.join(EXTRACTION_ROOT, "manifest.v1.json"),
  manifestSchema: path.join(EXTRACTION_ROOT, "manifest.schema.json"),
  registry: path.join(PHASE1_ROOT, "candidate-registry.v1.json"),
  registrySchema: path.join(PHASE1_ROOT, "candidate-registry.schema.json"),
  plan: path.join(PHASE1_ROOT, "run-plan.v1.json"),
  planSchema: path.join(PHASE1_ROOT, "run-plan.schema.json"),
  requestSchema: path.join(PHASE1_ROOT, "candidate-request.schema.json"),
  responseSchema: path.join(PHASE1_ROOT, "candidate-response.schema.json"),
  reportSchema: path.join(PHASE1_ROOT, "report.schema.json"),
  output: path.join(REPO_ROOT, "docs", "evidence", "extraction-phase1-sidecars.v1.json"),
});

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a value`);
  return process.argv[index + 1];
}

function elapsedMs(started) {
  return Number((Number(process.hrtime.bigint() - started) / 1_000_000).toFixed(3));
}

function emptyExecution() {
  return {
    spawned: false,
    exit_code: null,
    signal: null,
    timed_out: false,
    stdout_limit_exceeded: false,
    stderr_limit_exceeded: false,
    stdout_bytes: 0,
    stderr_bytes: 0,
    process_id: null,
    process_group_termination_attempted: false,
    process_group_empty_after_cleanup: null,
    elapsed_ms: 0,
  };
}

function nullBindings() {
  return {
    request_sha256: null,
    stdout_sha256: null,
    stderr_sha256: null,
    response_canonical_sha256: null,
  };
}

function emptyFailure() {
  return {
    stage: null,
    runner_code: null,
    detail_code: null,
    request_observed_bytes: null,
    request_limit_bytes: null,
  };
}

function stableFailureDetailCode(value) {
  const normalized = String(value ?? "UNKNOWN_FAILURE")
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return /^[A-Z]/.test(normalized) ? normalized : `ERROR_${normalized || "UNKNOWN"}`.slice(0, 64);
}

function retainedFailure(stage, runnerCode, detailCode = runnerCode, requestBytes = null, requestLimit = null) {
  return {
    stage,
    runner_code: runnerCode,
    detail_code: stableFailureDetailCode(detailCode),
    request_observed_bytes: requestBytes,
    request_limit_bytes: requestLimit,
  };
}

async function sourceFacts(sourcePath) {
  const bytes = await fs.readFile(sourcePath);
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  return {
    bytes,
    sha256: sha256(bytes),
    size_bytes: bytes.length,
    page_count: pdf.getPageCount(),
  };
}

async function afterSourceDigest(sourcePath) {
  try {
    return { sha256: sha256(await fs.readFile(sourcePath)), error: null };
  } catch (error) {
    return { sha256: null, error: error.code ?? error.message };
  }
}

function boundedCollector(limit, onLimit) {
  const chunks = [];
  let observedBytes = 0;
  let retainedBytes = 0;
  let exceeded = false;
  return {
    add(chunk) {
      observedBytes += chunk.length;
      if (retainedBytes < limit) {
        const retained = chunk.subarray(0, Math.max(0, limit - retainedBytes));
        chunks.push(retained);
        retainedBytes += retained.length;
      }
      if (!exceeded && observedBytes > limit) {
        exceeded = true;
        onLimit();
      }
    },
    result() {
      return { bytes: Buffer.concat(chunks), observedBytes, exceeded };
    },
  };
}

function cleanCandidateEnvironment(attemptRoot, executable) {
  return {
    HOME: path.join(attemptRoot, "home"),
    TMPDIR: path.join(attemptRoot, "tmp"),
    PATH: [path.dirname(executable), "/usr/bin", "/bin"].join(path.delimiter),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export async function runCandidateProcess({ command, request, attemptRoot, limits, capabilities }) {
  const started = process.hrtime.bigint();
  let child;
  let settled = false;
  let timedOut = false;
  let terminationAttempted = false;
  let forceTimer;
  let timeoutTimer;
  let escalationPromise = null;
  let resolveEscalation = null;
  let processGroupEmptyAfterCleanup = null;

  const processGroupExists = () => {
    if (!child || !capabilities.process_group_termination) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      spawnError = spawnError ?? error;
      return true;
    }
  };

  const terminate = () => {
    if (!child || terminationAttempted) return;
    terminationAttempted = true;
    escalationPromise = new Promise(resolve => {
      resolveEscalation = resolve;
    });
    try {
      if (capabilities.process_group_termination) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") spawnError = spawnError ?? error;
    }
    forceTimer = setTimeout(() => {
      try {
        if (capabilities.process_group_termination) process.kill(-child.pid, "SIGKILL");
        else if (!settled) child.kill("SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") spawnError = spawnError ?? error;
      } finally {
        resolveEscalation();
      }
    }, 250);
  };

  const stdout = boundedCollector(limits.max_stdout_bytes, terminate);
  const stderr = boundedCollector(limits.max_stderr_bytes, terminate);
  let spawnError = null;
  let exitCode = null;
  let exitSignal = null;
  let successfullyStarted = false;
  let processId = null;

  await fs.mkdir(path.join(attemptRoot, "home"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(attemptRoot, "tmp"), { recursive: true, mode: 0o700 });
  try {
    child = spawn(command.executable, command.args, {
      cwd: attemptRoot,
      env: cleanCandidateEnvironment(attemptRoot, command.executable),
      detached: capabilities.process_group_termination,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    spawnError = error;
  }

  if (child) {
    child.stdout.on("data", chunk => stdout.add(chunk));
    child.stderr.on("data", chunk => stderr.add(chunk));
    const completion = new Promise(resolve => {
      child.once("spawn", () => {
        successfullyStarted = true;
        processId = child.pid;
      });
      child.once("error", error => {
        spawnError = error;
      });
      child.once("close", (code, signal) => {
        settled = true;
        exitCode = code;
        exitSignal = signal;
        resolve();
      });
    });
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, limits.deadline_ms);
    child.stdin.on("error", error => {
      if (error.code !== "EPIPE") spawnError = error;
    });
    child.stdin.end(`${canonicalJson(request)}\n`);
    await completion;
    if (escalationPromise) await escalationPromise;
    if (successfullyStarted && capabilities.process_group_termination) {
      terminationAttempted = true;
      if (processGroupExists()) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") spawnError = spawnError ?? error;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (processGroupExists()) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") spawnError = spawnError ?? error;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      processGroupEmptyAfterCleanup = !processGroupExists();
    }
  }
  clearTimeout(timeoutTimer);
  if (!terminationAttempted) clearTimeout(forceTimer);
  const stdoutResult = stdout.result();
  const stderrResult = stderr.result();
  return {
    stdout: stdoutResult.bytes,
    stderr: stderrResult.bytes,
    spawnError,
    execution: {
      spawned: successfullyStarted,
      process_id: processId,
      exit_code: successfullyStarted ? exitCode : null,
      signal: successfullyStarted ? exitSignal : null,
      timed_out: timedOut,
      stdout_limit_exceeded: stdoutResult.exceeded,
      stderr_limit_exceeded: stderrResult.exceeded,
      stdout_bytes: stdoutResult.observedBytes,
      stderr_bytes: stderrResult.observedBytes,
      process_group_termination_attempted: terminationAttempted,
      process_group_empty_after_cleanup: processGroupEmptyAfterCleanup,
      elapsed_ms: successfullyStarted ? elapsedMs(started) : 0,
    },
  };
}

function outcomeFromExecution(execution, spawnError) {
  if (spawnError) return { error_code: "SPAWN_FAILED", reason: `Candidate process could not start: ${spawnError.code ?? spawnError.message}` };
  if (execution.timed_out) return { error_code: "DEADLINE_EXCEEDED", reason: "Candidate exceeded the runner wall-clock deadline" };
  if (execution.stdout_limit_exceeded) return { error_code: "STDOUT_LIMIT_EXCEEDED", reason: "Candidate exceeded the runner stdout byte limit" };
  if (execution.stderr_limit_exceeded) return { error_code: "STDERR_LIMIT_EXCEEDED", reason: "Candidate exceeded the runner stderr byte limit" };
  if (execution.exit_code !== 0) return { error_code: "NONZERO_EXIT", reason: `Candidate exited with code ${execution.exit_code} and signal ${execution.signal ?? "none"}` };
  return null;
}

function candidateUnmetRequirements(candidate, selection, capabilities, inputBuilders) {
  const unmet = unmetRequirements(candidate, capabilities);
  if (candidate.license?.reviewed !== true) unmet.push("reviewed_license");
  if (selection.input_mode !== "direct_pdf" && typeof inputBuilders?.[selection.input_mode] !== "function") {
    unmet.push(`${selection.input_mode}_adapter`);
  }
  return unmet;
}

async function unconfiguredAttempt({ candidate, selection, fixture, repetition, source }) {
  return {
    candidate_id: candidate.id,
    case_id: fixture.id,
    repetition,
    input_mode: selection.input_mode,
    outcome: "not_run",
    outcome_reason: "Candidate registry slot is intentionally unconfigured",
    error_code: null,
    source: {
      manifest_path: fixture.path,
      sha256: source.sha256,
      after_sha256: source.sha256,
      after_read_error: null,
      size_bytes: source.size_bytes,
      page_count: source.page_count,
      immutable: true,
    },
    request: null,
    response: null,
    runner_field_bindings: [],
    bindings: nullBindings(),
    captures: { stdout_base64: null, stderr_base64: null },
    unmet_requirements: [],
    execution: emptyExecution(),
    failure: emptyFailure(),
  };
}

async function runAttempt({
  candidate,
  selection,
  fixture,
  fixturePath,
  repetition,
  source,
  runId,
  plan,
  capabilities,
  requestSchema,
  responseSchema,
  runRoot,
  inputBuilders,
  eligibilityUnmet,
}) {
  if (!candidate.configured) return unconfiguredAttempt({ candidate, selection, fixture, repetition, source });
  const inputBuilder = selection.input_mode === "direct_pdf" ? null : inputBuilders?.[selection.input_mode];
  if (eligibilityUnmet.length > 0) {
    const retained = await unconfiguredAttempt({ candidate, selection, fixture, repetition, source });
    retained.outcome_reason = `Runner cannot truthfully enforce or provide: ${eligibilityUnmet.join(", ")}`;
    retained.unmet_requirements = eligibilityUnmet;
    return retained;
  }

  const attemptRoot = await fs.mkdtemp(path.join(runRoot, "attempt-"));
  const stagedSourcePath = path.join(attemptRoot, "source.pdf");
  await fs.copyFile(fixturePath, stagedSourcePath);
  await fs.chmod(stagedSourcePath, 0o444);
  let request = null;
  let response = null;
  let runnerFieldBindings = [];
  let processResult = null;
  let outcome = "error";
  let errorCode = null;
  let outcomeReason = "Candidate attempt failed before producing a valid response";
  let currentStage = inputBuilder ? "adapter_build" : "request_build";
  let failure = emptyFailure();
  try {
    const publicTask = deepFreeze({
      source: {
        media_type: "application/pdf",
        sha256: source.sha256,
        size_bytes: source.size_bytes,
        page_count: source.page_count,
      },
      target_schema: structuredClone(fixture.target_schema),
    });
    const supplementalInput = inputBuilder
      ? await inputBuilder({ attemptRoot, stagedSourcePath, task: publicTask })
      : null;
    const inputPayload = supplementalInput?.payload ?? supplementalInput;
    currentStage = "request_build";
    request = buildCandidateRequest({
      candidateId: candidate.id,
      inputMode: selection.input_mode,
      stagedSourcePath,
      sourceSha256: source.sha256,
      sourceSizeBytes: source.size_bytes,
      pageCount: source.page_count,
      targetSchema: fixture.target_schema,
      limits: plan.limits,
      repositoryRoot: REPO_ROOT,
      layoutIr: selection.input_mode === "layout_ir" ? inputPayload : null,
      rasterManifest: selection.input_mode === "raster" ? inputPayload : null,
      attemptBinding: sha256(Buffer.from(`${runId}\u0000${candidate.id}\u0000${fixture.id}\u0000${repetition}`)),
    });
    assertSchema(request, requestSchema, "extraction candidate request");
    currentStage = "process_execution";
    processResult = await runCandidateProcess({
      command: candidate.command,
      request,
      attemptRoot,
      limits: plan.limits,
      capabilities,
    });
    const executionFailure = outcomeFromExecution(processResult.execution, processResult.spawnError);
    if (executionFailure) {
      errorCode = executionFailure.error_code;
      outcomeReason = executionFailure.reason;
      failure = retainedFailure(
        errorCode === "SPAWN_FAILED" ? "process_spawn" : "process_execution",
        errorCode,
        processResult.spawnError?.code ?? errorCode,
      );
    } else {
      const stdoutText = processResult.stdout.toString("utf8");
      try {
        response = JSON.parse(stdoutText);
      } catch {
        errorCode = "INVALID_RESPONSE_JSON";
        outcomeReason = "Candidate stdout was not exactly one JSON response";
        failure = retainedFailure("response_parse", errorCode);
      }
      if (response) {
        try {
          assertSchema(response, responseSchema, "extraction candidate response");
          runnerFieldBindings = validateCandidateResponseSemantics(response, request, { targetSchema: fixture.target_schema });
          outcome = response.status;
          errorCode = response.status === "error" ? response.diagnostics.code ?? "CANDIDATE_ERROR" : null;
          outcomeReason = response.status === "error"
            ? response.diagnostics.message ?? "Candidate returned an error response"
            : `Candidate returned a schema-valid ${response.status} response`;
          failure = response.status === "error"
            ? retainedFailure("candidate_response", errorCode)
            : emptyFailure();
        } catch (error) {
          response = null;
          runnerFieldBindings = [];
          errorCode = "INVALID_RESPONSE_CONTRACT";
          outcomeReason = error.message;
          failure = retainedFailure("response_validation", errorCode, error.code ?? error.name);
        }
      }
    }
  } catch (error) {
    outcome = "error";
    errorCode = error.code === "REQUEST_LIMIT_EXCEEDED" ? error.code : "HARNESS_ATTEMPT_FAILURE";
    const detailCode = stableFailureDetailCode(error.code ?? error.name);
    outcomeReason = `Runner could not complete the candidate attempt: ${detailCode}`;
    failure = retainedFailure(
      currentStage,
      errorCode,
      detailCode,
      errorCode === "REQUEST_LIMIT_EXCEEDED" ? error.observed_bytes : null,
      errorCode === "REQUEST_LIMIT_EXCEEDED" ? error.limit_bytes : null,
    );
    response = null;
    runnerFieldBindings = [];
  }
  const after = await afterSourceDigest(stagedSourcePath);
  const immutable = after.sha256 === source.sha256;
  if (!immutable) {
    outcome = "error";
    errorCode = "SOURCE_MUTATED";
    outcomeReason = "Candidate changed or removed its staged source copy";
    failure = retainedFailure("source_postcheck", errorCode, after.error ?? errorCode);
    response = null;
    runnerFieldBindings = [];
  }
  const stdout = processResult?.stdout ?? null;
  const stderr = processResult?.stderr ?? null;
  const retained = {
    candidate_id: candidate.id,
    case_id: fixture.id,
    repetition,
    input_mode: selection.input_mode,
    outcome,
    outcome_reason: outcomeReason,
    error_code: errorCode,
    source: {
      manifest_path: fixture.path,
      sha256: source.sha256,
      after_sha256: after.sha256,
      after_read_error: after.error,
      size_bytes: source.size_bytes,
      page_count: source.page_count,
      immutable,
    },
    request,
    response,
    runner_field_bindings: runnerFieldBindings,
    bindings: {
      request_sha256: request ? sha256(Buffer.from(canonicalJson(request))) : null,
      stdout_sha256: processResult?.execution.spawned && stdout ? sha256(stdout) : null,
      stderr_sha256: processResult?.execution.spawned && stderr ? sha256(stderr) : null,
      response_canonical_sha256: response ? sha256(Buffer.from(canonicalJson(response))) : null,
    },
    captures: {
      stdout_base64: processResult?.execution.spawned && stdout ? stdout.toString("base64") : null,
      stderr_base64: processResult?.execution.spawned && stderr ? stderr.toString("base64") : null,
    },
    unmet_requirements: [],
    execution: processResult?.execution ?? emptyExecution(),
    failure,
  };
  await fs.rm(attemptRoot, { recursive: true, force: true });
  return retained;
}

export async function runExtractionCandidates({
  manifestPath = DEFAULT_PATHS.manifest,
  manifestSchemaPath = DEFAULT_PATHS.manifestSchema,
  registryPath = DEFAULT_PATHS.registry,
  registrySchemaPath = DEFAULT_PATHS.registrySchema,
  planPath = DEFAULT_PATHS.plan,
  planSchemaPath = DEFAULT_PATHS.planSchema,
  requestSchemaPath = DEFAULT_PATHS.requestSchema,
  responseSchemaPath = DEFAULT_PATHS.responseSchema,
  reportSchemaPath = DEFAULT_PATHS.reportSchema,
  outputPath = null,
  inputBuilders = null,
  verificationEvidence = null,
} = {}) {
  const [manifest, registryLoaded, planLoaded, requestSchemaText, responseSchemaText, reportSchemaText] = await Promise.all([
    loadExtractionManifest(manifestPath, manifestSchemaPath),
    loadJsonWithSchema(registryPath, registrySchemaPath, "extraction candidate registry"),
    loadJsonWithSchema(planPath, planSchemaPath, "extraction Phase 1 plan"),
    fs.readFile(requestSchemaPath, "utf8"),
    fs.readFile(responseSchemaPath, "utf8"),
    fs.readFile(reportSchemaPath, "utf8"),
  ]);
  const registry = registryLoaded.value;
  const plan = planLoaded.value;
  const requestSchema = JSON.parse(requestSchemaText);
  const responseSchema = JSON.parse(responseSchemaText);
  const reportSchema = JSON.parse(reportSchemaText);
  validateRegistry(registry);
  validatePlan(plan, registry);
  if (plan.phase0_suite_id !== manifest.manifest.suite_id) throw new Error("Extraction Phase 1 plan targets the wrong Phase 0 suite");
  const manifestById = new Map(manifest.manifest.fixtures.map(fixture => [fixture.id, fixture]));
  const selectedCaseIds = plan.case_ids ?? manifest.manifest.fixtures.map(fixture => fixture.id);
  if (selectedCaseIds.some(id => !manifestById.has(id))) throw new Error("Extraction Phase 1 plan selects an unknown Phase 0 case");

  const capabilities = detectHarnessCapabilities();
  const adapterAvailability = {
    direct_pdf: true,
    layout_ir: typeof inputBuilders?.layout_ir === "function",
    raster: typeof inputBuilders?.raster === "function",
  };
  const runId = sha256(Buffer.from(randomUUID()));
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-extraction-phase1-"));
  const attempts = [];
  const failureEvidenceByAttemptKey = {};
  const verifiedSourceFacts = {};
  const recordAttempt = attempt => {
    const key = reportAttemptKey(attempt);
    if (Object.hasOwn(failureEvidenceByAttemptKey, key)) throw new Error(`Duplicate extraction attempt evidence key: ${key}`);
    failureEvidenceByAttemptKey[key] = deepFreeze(structuredClone({
      outcome: attempt.outcome,
      error_code: attempt.error_code,
      outcome_reason: attempt.outcome_reason,
      unmet_requirements: attempt.unmet_requirements,
      failure: attempt.failure,
    }));
    attempts.push(attempt);
  };
  try {
    const registryById = new Map(registry.candidates.map(candidate => [candidate.id, candidate]));
    for (const selection of plan.candidates) {
      const candidate = registryById.get(selection.candidate_id);
      for (const caseId of selectedCaseIds) {
        const fixture = manifestById.get(caseId);
        const fixturePath = resolveExtractionFixture(manifestPath, fixture);
        const source = await sourceFacts(fixturePath);
        if (source.sha256 !== fixture.sha256) throw new Error(`Source hash drifted before candidate execution: ${fixture.id}`);
        verifiedSourceFacts[fixture.id] = {
          sha256: source.sha256,
          size_bytes: source.size_bytes,
          page_count: source.page_count,
        };
        for (let repetition = 1; repetition <= plan.repetitions; repetition += 1) {
          const eligibilityUnmet = candidate.configured
            ? candidateUnmetRequirements(candidate, selection, capabilities, inputBuilders)
            : [];
          if (!candidate.configured) {
            recordAttempt(await unconfiguredAttempt({ candidate, selection, fixture, repetition, source }));
          } else if (eligibilityUnmet.length > 0) {
            const retained = await unconfiguredAttempt({ candidate, selection, fixture, repetition, source });
            retained.outcome_reason = `Runner cannot truthfully enforce or provide: ${eligibilityUnmet.join(", ")}`;
            retained.unmet_requirements = eligibilityUnmet;
            recordAttempt(retained);
          } else if (source.size_bytes > plan.limits.max_source_bytes || source.page_count > plan.limits.max_pages) {
            const retained = await unconfiguredAttempt({ candidate, selection, fixture, repetition, source });
            retained.outcome = "error";
            retained.error_code = "SOURCE_LIMIT_EXCEEDED";
            retained.outcome_reason = "Source exceeds the plan's byte or page limit";
            retained.failure = retainedFailure("source_preflight", retained.error_code);
            recordAttempt(retained);
          } else {
            recordAttempt(await runAttempt({
              candidate,
              selection,
              fixture,
              fixturePath,
              repetition,
              source,
              runId,
              plan,
              capabilities,
              requestSchema,
              responseSchema,
              runRoot,
              inputBuilders,
              eligibilityUnmet,
            }));
          }
        }
      }
    }
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }

  const outcomeCount = outcome => attempts.filter(attempt => attempt.outcome === outcome).length;
  const report = {
    report_id: PHASE1_REPORT_ID,
    report_version: 1,
    run_id: runId,
    benchmark_claim_ready: false,
    calibration_claim_ready: false,
    truth_isolation_claim_ready: false,
    claim_boundary: PHASE1_CLAIM_BOUNDARY,
    phase0_manifest_sha256: manifest.manifest_sha256,
    registry_sha256: registryLoaded.sha256,
    registry_schema_sha256: registryLoaded.schema_sha256,
    plan_sha256: planLoaded.sha256,
    plan_schema_sha256: planLoaded.schema_sha256,
    request_schema_sha256: sha256(Buffer.from(canonicalJson(requestSchema))),
    response_schema_sha256: sha256(Buffer.from(canonicalJson(responseSchema))),
    preflight_evidence_sha256: sha256(Buffer.from(canonicalJson(failureEvidenceByAttemptKey))),
    environment: { ...capabilities, input_adapters: adapterAvailability },
    denominator: {
      planned: attempts.length,
      retained: attempts.length,
      planned_case_ids: selectedCaseIds,
      outcomes: Object.fromEntries(["completed", "partial", "abstained", "error", "not_run"].map(outcome => [outcome, outcomeCount(outcome)])),
    },
    attempts,
    limitations: [...PHASE1_LIMITATIONS],
  };
  assertSchema(report, reportSchema, "extraction Phase 1 report");
  verifyPhase1Report(report, {
    registry,
    registrySchema: JSON.parse(await fs.readFile(registrySchemaPath, "utf8")),
    plan,
    planSchema: JSON.parse(await fs.readFile(planSchemaPath, "utf8")),
    manifest: manifest.manifest,
    sourceFactsById: verifiedSourceFacts,
    requestSchema,
    responseSchema,
    reportSchema,
    adapterAvailability,
    failureEvidenceByAttemptKey,
    repositoryRoot: REPO_ROOT,
  });
  if (verificationEvidence && typeof verificationEvidence === "object") {
    verificationEvidence.adapterAvailability = structuredClone(adapterAvailability);
    verificationEvidence.failureEvidenceByAttemptKey = structuredClone(failureEvidenceByAttemptKey);
  }
  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    await fs.writeFile(`${outputPath}.preflight.json`, `${JSON.stringify({
      report_id: report.report_id,
      run_id: report.run_id,
      preflight_evidence_sha256: report.preflight_evidence_sha256,
      failure_evidence_by_attempt_key: failureEvidenceByAttemptKey,
    }, null, 2)}\n`);
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.resolve(option("--output", DEFAULT_PATHS.output));
  const report = await runExtractionCandidates({
    manifestPath: path.resolve(option("--manifest", DEFAULT_PATHS.manifest)),
    manifestSchemaPath: path.resolve(option("--manifest-schema", DEFAULT_PATHS.manifestSchema)),
    registryPath: path.resolve(option("--registry", DEFAULT_PATHS.registry)),
    registrySchemaPath: path.resolve(option("--registry-schema", DEFAULT_PATHS.registrySchema)),
    planPath: path.resolve(option("--plan", DEFAULT_PATHS.plan)),
    planSchemaPath: path.resolve(option("--plan-schema", DEFAULT_PATHS.planSchema)),
    requestSchemaPath: path.resolve(option("--request-schema", DEFAULT_PATHS.requestSchema)),
    responseSchemaPath: path.resolve(option("--response-schema", DEFAULT_PATHS.responseSchema)),
    reportSchemaPath: path.resolve(option("--report-schema", DEFAULT_PATHS.reportSchema)),
    outputPath: output,
  });
  process.stdout.write(`${JSON.stringify({ output, denominator: report.denominator }, null, 2)}\n`);
}
