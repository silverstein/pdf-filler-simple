#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
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
  artifactDriftOperationalDigest,
  buildCandidateRequest,
  canonicalJson,
  detectHarnessCapabilities,
  loadJsonWithSchema,
  reportAttemptKey,
  sha256,
  unmetRequirements,
  validateCandidateResponseSemantics,
  validatePhase1ReportByteContract,
  validatePlan,
  validateRegistry,
} from "../test/eval/extraction-phase1-protocol.js";
import {
  validateExtractionManifestBytes,
  resolveExtractionFixture,
} from "../test/eval/extraction-manifest.js";
import {
  PHASE1_ARTIFACT_CONFIG_ID,
  PHASE1_ARTIFACT_ROLES,
  buildArtifactInventory,
  buildCandidateCommandEvidence,
  redactArtifactConfiguration,
  validateArtifactConfiguration,
  verifyArtifactInventory,
} from "../test/eval/extraction-phase1-artifacts.js";
import {
  PHASE1_COMPANION_SOURCE_PATHS,
  buildPrivacyEvidence,
  buildRunnerEnvironmentAttestation,
  buildGenerationPrivacyAttestation,
  createExecutionCompanion,
  deriveRunnerResourceFacts,
} from "../test/eval/extraction-phase1-companion.js";
import { publishImmutableGeneration } from "../test/eval/extraction-phase1-publisher.js";
import {
  reconcileLayoutIrEvidence,
} from "../test/eval/extraction-phase1-layout-evidence.js";
import { PHASE1_CORPUS_LIMITS, buildRetainedPhase1Corpus } from "../test/eval/extraction-phase1-corpus.js";
import { verifyRetainedPhase1Report } from "../test/eval/extraction-phase1-report-verifier.js";
import { createExecutionGenerationSemanticVerifier } from "../test/eval/extraction-phase1-execution-generation-verifier.js";

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
  companionSchema: path.join(PHASE1_ROOT, "execution-companion.schema.json"),
  corpusSchema: path.join(PHASE1_ROOT, "corpus.schema.json"),
  artifactInventorySchema: path.join(PHASE1_ROOT, "artifact-inventory.schema.json"),
});

function pathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function prospectiveRealPath(target) {
  let cursor = path.resolve(target);
  const missingSegments = [];
  while (true) {
    try {
      const realAncestor = await fs.realpath(cursor);
      return path.join(realAncestor, ...missingSegments.reverse());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function validateSourcePrivacyBoundary({ trustedPrivacyClass, trustedProhibitedRoots, generationRoot }) {
  if (!["public_synthetic", "private_local", "private_local_minimized"].includes(trustedPrivacyClass)) {
    throw new Error("Unknown extraction privacy class");
  }
  if (trustedPrivacyClass === "public_synthetic") return { realTrustedProhibitedRoots: trustedProhibitedRoots };
  if (!generationRoot || !path.isAbsolute(generationRoot)
    || !Array.isArray(trustedProhibitedRoots) || trustedProhibitedRoots.length === 0) {
    throw new Error("Private extraction requires an absolute generation root and trusted source prohibited roots");
  }
  const [realRepoRoot, realGenerationRoot, realTrustedProhibitedRoots] = await Promise.all([
    fs.realpath(REPO_ROOT),
    prospectiveRealPath(generationRoot),
    Promise.all(trustedProhibitedRoots.map(root => fs.realpath(root))),
  ]);
  if (!realTrustedProhibitedRoots.some(root => pathInside(root, realRepoRoot))) {
    throw new Error("Private extraction source prohibited roots must cover the repository and package root");
  }
  for (const prohibited of realTrustedProhibitedRoots) {
    if (pathInside(prohibited, realGenerationRoot) || pathInside(realGenerationRoot, prohibited)) {
      throw new Error("Private extraction generation root overlaps a trusted prohibited repository or package root");
    }
  }
  return { realRepoRoot, realGenerationRoot, realTrustedProhibitedRoots };
}

function notApplicableArtifactConfig(candidateId) {
  return {
    config_id: PHASE1_ARTIFACT_CONFIG_ID,
    candidate_id: candidateId,
    configured: false,
    root_specs: [],
    role_dispositions: PHASE1_ARTIFACT_ROLES.map(role => ({ role, status: "not_applicable", reason: "candidate_not_configured" })),
    components: [],
    licenses: [],
  };
}

async function loadRunnerSourceBytes() {
  return Object.fromEntries(await Promise.all(Object.entries(PHASE1_COMPANION_SOURCE_PATHS).map(async ([role, relativePath]) => [
    role,
    { path: relativePath, bytes: await fs.readFile(path.join(REPO_ROOT, relativePath)) },
  ])));
}

function assertRunnerSourcesUnchanged(beforeSources, afterSources, beforeEnvironment, afterEnvironment) {
  const projection = sources => Object.fromEntries(Object.entries(sources).map(([role, source]) => [role, {
    path: source.path,
    bytes: source.bytes.length,
    sha256: sha256(source.bytes),
  }]));
  if (canonicalJson(projection(beforeSources)) !== canonicalJson(projection(afterSources))
    || canonicalJson(beforeEnvironment) !== canonicalJson(afterEnvironment)) {
    const error = new Error("Runner direct sources or runtime environment changed during candidate execution");
    error.code = "RUNNER_SOURCE_DRIFT";
    throw error;
  }
}

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

async function sourceFacts(bytes) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  return {
    bytes,
    sha256: sha256(bytes),
    size_bytes: bytes.length,
    page_count: pdf.getPageCount(),
  };
}

async function readTrustedCorpusFile(filename, maxBytes) {
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maxBytes)) throw new Error(`Corpus source is not a bounded regular file: ${filename}`);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (String(before.dev) !== String(after.dev) || String(before.ino) !== String(after.ino)
      || String(before.size) !== String(after.size) || String(before.mtimeNs) !== String(after.mtimeNs)
      || String(before.ctimeNs) !== String(after.ctimeNs) || BigInt(bytes.length) !== before.size) {
      throw new Error(`Corpus source changed while read: ${filename}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
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
  if (execution.timed_out) return { error_code: "DEADLINE_EXCEEDED", reason: "Candidate exceeded the runner wall-clock deadline" };
  if (spawnError) return { error_code: "SPAWN_FAILED", reason: `Candidate process could not start: ${spawnError.code ?? spawnError.message}` };
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
    runner_evidence: null,
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
  pdfjsLib,
  validatorSourceSetSha256,
  layoutValidationCache,
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
  await fs.writeFile(stagedSourcePath, source.bytes, { mode: 0o600, flag: "wx" });
  await fs.chmod(stagedSourcePath, 0o444);
  let request = null;
  let response = null;
  let runnerFieldBindings = [];
  let runnerEvidence = null;
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
      stagedSourcePath: "source.pdf",
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
          validateCandidateResponseSemantics(response, request, { targetSchema: fixture.target_schema });
          runnerEvidence = await reconcileLayoutIrEvidence({
            request,
            response,
            sourceBytes: source.bytes,
            pdfjsLib,
            validatorSourceSetSha256,
            validationCache: layoutValidationCache,
          });
          runnerFieldBindings = runnerEvidence.field_bindings;
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
          runnerEvidence = null;
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
    runnerEvidence = null;
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
    runnerEvidence = null;
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
    runner_evidence: runnerEvidence,
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
  artifactConfigSchemaPath = path.join(PHASE1_ROOT, "artifact-config.schema.json"),
  artifactInventorySchemaPath = DEFAULT_PATHS.artifactInventorySchema,
  companionSchemaPath = DEFAULT_PATHS.companionSchema,
  corpusSchemaPath = DEFAULT_PATHS.corpusSchema,
  executionIndexSchemaPath = path.join(PHASE1_ROOT, "execution-index.schema.json"),
  generationPrivacySchemaPath = path.join(PHASE1_ROOT, "generation-privacy.schema.json"),
  generationRoot = null,
  outputPath = null,
  inputBuilders = null,
  verificationEvidence = null,
  artifactConfigurations = null,
  trustedPrivacyClass = "public_synthetic",
  trustedProhibitedRoots = [],
  testOnlyRunnerSourceLoader = null,
  testOnlyAfterAttempts = null,
  testOnlyPublicationFaultInjector = null,
} = {}) {
  if (outputPath !== null) throw new Error("Direct report persistence was removed; use generationRoot for immutable generation publication");
  const [manifestBytes, manifestSchemaBytes] = await Promise.all([
    readTrustedCorpusFile(manifestPath, PHASE1_CORPUS_LIMITS.max_manifest_bytes),
    readTrustedCorpusFile(manifestSchemaPath, PHASE1_CORPUS_LIMITS.max_manifest_bytes),
  ]);
  const manifest = await validateExtractionManifestBytes({
    manifestPath,
    manifestBytes,
    schemaBytes: manifestSchemaBytes,
    verifyFixtureFiles: false,
  });
  const [registryLoaded, planLoaded, requestSchemaText, responseSchemaText, reportSchemaText, artifactConfigSchemaText, artifactInventorySchemaText, companionSchemaText, corpusSchemaBytes, executionIndexSchemaText, generationPrivacySchemaText] = await Promise.all([
    loadJsonWithSchema(registryPath, registrySchemaPath, "extraction candidate registry"),
    loadJsonWithSchema(planPath, planSchemaPath, "extraction Phase 1 plan"),
    fs.readFile(requestSchemaPath, "utf8"),
    fs.readFile(responseSchemaPath, "utf8"),
    fs.readFile(reportSchemaPath, "utf8"),
    fs.readFile(artifactConfigSchemaPath, "utf8"),
    fs.readFile(artifactInventorySchemaPath, "utf8"),
    fs.readFile(companionSchemaPath, "utf8"),
    readTrustedCorpusFile(corpusSchemaPath, PHASE1_CORPUS_LIMITS.max_manifest_bytes),
    fs.readFile(executionIndexSchemaPath, "utf8"),
    fs.readFile(generationPrivacySchemaPath, "utf8"),
  ]);
  const registry = registryLoaded.value;
  const plan = planLoaded.value;
  const requestSchema = JSON.parse(requestSchemaText);
  const responseSchema = JSON.parse(responseSchemaText);
  const reportSchema = JSON.parse(reportSchemaText);
  const artifactConfigSchema = JSON.parse(artifactConfigSchemaText);
  const artifactInventorySchema = JSON.parse(artifactInventorySchemaText);
  const companionSchema = JSON.parse(companionSchemaText);
  const corpusSchema = JSON.parse(corpusSchemaBytes);
  const executionIndexSchema = JSON.parse(executionIndexSchemaText);
  const generationPrivacySchema = JSON.parse(generationPrivacySchemaText);
  validateRegistry(registry);
  validatePlan(plan, registry);
  if (plan.phase0_suite_id !== manifest.manifest.suite_id) throw new Error("Extraction Phase 1 plan targets the wrong Phase 0 suite");
  const manifestById = new Map(manifest.manifest.fixtures.map(fixture => [fixture.id, fixture]));
  const selectedCaseIds = plan.case_ids ?? manifest.manifest.fixtures.map(fixture => fixture.id);
  if (selectedCaseIds.some(id => !manifestById.has(id))) throw new Error("Extraction Phase 1 plan selects an unknown Phase 0 case");
  const [registrySchema, planSchema] = await Promise.all([
    fs.readFile(registrySchemaPath, "utf8").then(JSON.parse), fs.readFile(planSchemaPath, "utf8").then(JSON.parse),
  ]);
  const retainedFixtureBytesById = {};
  let remainingFixtureBytes = PHASE1_CORPUS_LIMITS.max_total_fixture_bytes;
  for (const caseId of selectedCaseIds) {
    const fixture = manifestById.get(caseId);
    if (remainingFixtureBytes < 1) throw new Error("Selected extraction fixtures exceed the aggregate retained-corpus byte ceiling");
    const bytes = await readTrustedCorpusFile(
      resolveExtractionFixture(manifestPath, fixture),
      Math.min(PHASE1_CORPUS_LIMITS.max_fixture_bytes, remainingFixtureBytes),
    );
    retainedFixtureBytesById[caseId] = bytes;
    remainingFixtureBytes -= bytes.length;
  }
  await validateExtractionManifestBytes({
    manifestPath,
    manifestBytes,
    schemaBytes: manifestSchemaBytes,
    fixtureBytesById: retainedFixtureBytesById,
    verifyFixtureFiles: false,
  });
  const retainedCorpus = await buildRetainedPhase1Corpus({
    manifestBytes,
    manifestSchemaBytes,
    selectedCaseIds,
    fixtureBytesById: retainedFixtureBytesById,
    trustedPrivacyClass,
    corpusSchema,
  });
  const corpusManifestAnchors = {
    expectedManifestRawSha256: sha256(manifestBytes),
    expectedManifestCanonicalSha256: sha256(Buffer.from(canonicalJson(JSON.parse(manifestBytes)))),
    expectedManifestSchemaRawSha256: sha256(manifestSchemaBytes),
    expectedManifestSchemaCanonicalSha256: sha256(Buffer.from(canonicalJson(JSON.parse(manifestSchemaBytes)))),
  };
  const plannedAttempts = plan.candidates.length * selectedCaseIds.length * plan.repetitions;
  validatePhase1ReportByteContract({ limits: plan.limits, plannedAttempts });

  const capabilities = detectHarnessCapabilities();
  const adapterAvailability = {
    direct_pdf: true,
    layout_ir: typeof inputBuilders?.layout_ir === "function",
    raster: typeof inputBuilders?.raster === "function",
  };
  const selectedCandidateIds = plan.candidates.map(item => item.candidate_id);
  const trustedCandidateIds = registry.candidates.map(item => item.id);
  const artifactConfigByCandidateId = {};
  for (const candidateId of selectedCandidateIds) {
    const candidate = registry.candidates.find(item => item.id === candidateId);
    const configured = artifactConfigurations?.[candidateId] ?? notApplicableArtifactConfig(candidateId);
    if (candidate.configured && !artifactConfigurations?.[candidateId]) {
      throw new Error(`Configured candidate requires a separate runner-owned artifact configuration: ${candidateId}`);
    }
    if (configured.configured !== candidate.configured) throw new Error(`Candidate registry and artifact configuration disagree: ${candidateId}`);
    artifactConfigByCandidateId[candidateId] = configured;
  }
  const artifactConfigBindingByCandidateId = Object.fromEntries(selectedCandidateIds.map(candidateId => {
    const config = artifactConfigByCandidateId[candidateId];
    const rawBytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
    const redacted = redactArtifactConfiguration(config);
    return [candidateId, {
      raw_bytes: rawBytes.length,
      raw_sha256: sha256(rawBytes),
      canonical_sha256: sha256(Buffer.from(canonicalJson(config))),
      redacted_config: redacted,
      redacted_config_sha256: sha256(Buffer.from(canonicalJson(redacted))),
    }];
  }));
  for (const candidateId of selectedCandidateIds) {
    assertSchema(artifactConfigByCandidateId[candidateId], artifactConfigSchema, `artifact configuration ${candidateId}`);
    validateArtifactConfiguration(artifactConfigByCandidateId[candidateId], trustedCandidateIds);
  }
  if (testOnlyRunnerSourceLoader !== null && typeof testOnlyRunnerSourceLoader !== "function") {
    throw new Error("testOnlyRunnerSourceLoader must be a function when supplied");
  }
  if (testOnlyAfterAttempts !== null && typeof testOnlyAfterAttempts !== "function") throw new Error("testOnlyAfterAttempts must be a function when supplied");
  if (testOnlyPublicationFaultInjector !== null && typeof testOnlyPublicationFaultInjector !== "function") throw new Error("testOnlyPublicationFaultInjector must be a function when supplied");
  await validateSourcePrivacyBoundary({ trustedPrivacyClass, trustedProhibitedRoots, generationRoot });
  const runnerSourceLoader = testOnlyRunnerSourceLoader ?? loadRunnerSourceBytes;
  const sourceBytesBeforeAttempts = await runnerSourceLoader();
  const validatorSourceSetSha256 = sha256(Buffer.from(canonicalJson(Object.fromEntries(Object.entries(sourceBytesBeforeAttempts).map(([role, source_]) => [role, {
    path: source_.path,
    bytes: source_.bytes.length,
    sha256: sha256(source_.bytes),
  }])))));
  const layoutValidationCache = new Map();
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (String(pdfjsLib.version) !== "5.4.624") throw new Error("Extraction layout evidence requires pinned pdfjs-dist 5.4.624");
  const runnerEnvironmentBeforeAttempts = await buildRunnerEnvironmentAttestation({ sourceBytesByRole: sourceBytesBeforeAttempts });
  const beforeResultByCandidateId = Object.fromEntries(await Promise.all(selectedCandidateIds.map(async candidateId => {
    try {
      return [candidateId, { status: "captured", inventory: await buildArtifactInventory(artifactConfigByCandidateId[candidateId], { trustedCandidateIds }), error_code: null, error_message_sha256: null }];
    } catch (error) {
      return [candidateId, { status: "failed", inventory: null, error_code: stableFailureDetailCode(error.code ?? error.name), error_message_sha256: sha256(Buffer.from(String(error.message ?? error.name).slice(0, 500))) }];
    }
  })));
  const commandBeforeByCandidateId = {};
  for (const candidateId of selectedCandidateIds) {
    const candidate = registry.candidates.find(item => item.id === candidateId);
    if (!candidate.configured || beforeResultByCandidateId[candidateId].status === "failed") {
      commandBeforeByCandidateId[candidateId] = null;
      continue;
    }
    try {
      commandBeforeByCandidateId[candidateId] = await buildCandidateCommandEvidence(
        candidate,
        artifactConfigByCandidateId[candidateId],
        beforeResultByCandidateId[candidateId].inventory,
      );
    } catch (error) {
      commandBeforeByCandidateId[candidateId] = null;
      beforeResultByCandidateId[candidateId] = {
        status: "failed", inventory: null, error_code: stableFailureDetailCode(error.code ?? error.name),
        error_message_sha256: sha256(Buffer.from(String(error.message ?? error.name).slice(0, 500))),
      };
    }
  }
  const potentiallySpawnedSelections = plan.candidates.filter(selection => {
    const candidate = registry.candidates.find(item => item.id === selection.candidate_id);
    return candidate.configured
      && beforeResultByCandidateId[candidate.id].status !== "failed"
      && beforeResultByCandidateId[candidate.id].inventory?.state !== "captured_review_pending"
      && commandBeforeByCandidateId[candidate.id] !== null
      && candidateUnmetRequirements(candidate, selection, capabilities, inputBuilders).length === 0;
  }).length;
  const potentiallySpawnedAttempts = potentiallySpawnedSelections * selectedCaseIds.length * plan.repetitions;
  validatePhase1ReportByteContract({ limits: plan.limits, plannedAttempts, potentiallySpawnedAttempts });
  const runId = sha256(Buffer.from(randomUUID()));
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-extraction-phase1-"));
  const attempts = [];
  const failureEvidenceByAttemptKey = {};
  const verifiedSourceFacts = {};
  let retainedEvidenceBytes = 4 * 1024 * 1024;
  const recordAttempt = attempt => {
    const key = reportAttemptKey(attempt);
    if (Object.hasOwn(failureEvidenceByAttemptKey, key)) throw new Error(`Duplicate extraction attempt evidence key: ${key}`);
    const failureEvidence = {
      outcome: attempt.outcome,
      error_code: attempt.error_code,
      outcome_reason: attempt.outcome_reason,
      unmet_requirements: attempt.unmet_requirements,
      failure: attempt.failure,
    };
    const incrementalBytes = Buffer.byteLength(JSON.stringify(attempt)) + Buffer.byteLength(JSON.stringify(failureEvidence));
    validatePhase1ReportByteContract({
      limits: plan.limits,
      plannedAttempts,
      retainedEvidenceBytes: retainedEvidenceBytes + incrementalBytes,
    });
    retainedEvidenceBytes += incrementalBytes;
    failureEvidenceByAttemptKey[key] = deepFreeze(structuredClone(failureEvidence));
    attempts.push(attempt);
  };
  let afterResultByCandidateId = null;
  let commandObservationRegistry = registry;
  try {
    const registryById = new Map(registry.candidates.map(candidate => [candidate.id, candidate]));
    for (const selection of plan.candidates) {
      const candidate = registryById.get(selection.candidate_id);
      for (const caseId of selectedCaseIds) {
        const fixture = manifestById.get(caseId);
        const source = await sourceFacts(retainedFixtureBytesById[caseId]);
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
          if (candidate.configured && beforeResultByCandidateId[candidate.id].status === "failed") eligibilityUnmet.push("artifact_precheck_failed");
          if (candidate.configured && beforeResultByCandidateId[candidate.id].inventory?.state === "captured_review_pending") eligibilityUnmet.push("artifact_license_review");
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
              pdfjsLib,
              validatorSourceSetSha256,
              layoutValidationCache,
            }));
          }
        }
      }
    }
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
    if (testOnlyAfterAttempts) {
      commandObservationRegistry = structuredClone(registry);
      await testOnlyAfterAttempts({ registry: commandObservationRegistry, plan: structuredClone(plan) });
    }
    afterResultByCandidateId = Object.fromEntries(await Promise.all(selectedCandidateIds.map(async candidateId => {
      try {
        return [candidateId, { status: "captured", inventory: await buildArtifactInventory(artifactConfigByCandidateId[candidateId], { trustedCandidateIds }), error_code: null, error_message_sha256: null }];
      } catch (error) {
        return [candidateId, {
          status: "failed",
          inventory: null,
          error_code: stableFailureDetailCode(error.code ?? error.name),
          error_message_sha256: sha256(Buffer.from(String(error.message ?? error.name).slice(0, 500))),
        }];
      }
    })));
  }

  const sourceBytesAfterAttempts = await runnerSourceLoader();
  const runnerEnvironmentAfterAttempts = await buildRunnerEnvironmentAttestation({ sourceBytesByRole: sourceBytesAfterAttempts });
  assertRunnerSourcesUnchanged(sourceBytesBeforeAttempts, sourceBytesAfterAttempts, runnerEnvironmentBeforeAttempts, runnerEnvironmentAfterAttempts);
  const commandAfterByCandidateId = {};
  for (const candidateId of selectedCandidateIds) {
    const candidate = commandObservationRegistry.candidates.find(item => item.id === candidateId);
    if (!candidate.configured || commandBeforeByCandidateId[candidateId] === null || afterResultByCandidateId[candidateId].status === "failed") {
      commandAfterByCandidateId[candidateId] = null;
      continue;
    }
    try {
      commandAfterByCandidateId[candidateId] = await buildCandidateCommandEvidence(
        candidate,
        artifactConfigByCandidateId[candidateId],
        afterResultByCandidateId[candidateId].inventory,
      );
    } catch {
      commandAfterByCandidateId[candidateId] = null;
    }
  }

  const driftedCandidateIds = new Set(selectedCandidateIds.filter(candidateId => {
    if (beforeResultByCandidateId[candidateId].status === "failed") return false;
    const result = afterResultByCandidateId[candidateId];
    if (result.status !== "captured") return true;
    try {
      verifyArtifactInventory(result.inventory, beforeResultByCandidateId[candidateId].inventory);
      if (canonicalJson(commandBeforeByCandidateId[candidateId]) !== canonicalJson(commandAfterByCandidateId[candidateId])) return true;
      return false;
    } catch {
      return true;
    }
  }));
  for (const attempt of attempts) {
    if (!driftedCandidateIds.has(attempt.candidate_id)) continue;
    const operational = {
      outcome: attempt.outcome,
      error_code: attempt.error_code,
      outcome_reason: attempt.outcome_reason,
      response_canonical_sha256: attempt.bindings.response_canonical_sha256,
      failure: structuredClone(attempt.failure),
      unmet_requirements: structuredClone(attempt.unmet_requirements),
      operational_evidence_sha256: null,
    };
    operational.operational_evidence_sha256 = artifactDriftOperationalDigest(attempt, operational);
    attempt.artifact_drift = operational;
    attempt.outcome = "error";
    attempt.error_code = "ARTIFACT_DRIFT";
    attempt.outcome_reason = "Runner detected candidate artifact deployment drift after execution";
    attempt.response = null;
    attempt.runner_evidence = null;
    attempt.runner_field_bindings = [];
    attempt.bindings.response_canonical_sha256 = null;
    attempt.failure = retainedFailure("artifact_postcheck", "ARTIFACT_DRIFT", "ARTIFACT_DEPLOYMENT_DRIFT");
    failureEvidenceByAttemptKey[reportAttemptKey(attempt)] = deepFreeze(structuredClone({
      outcome: attempt.outcome,
      error_code: attempt.error_code,
      outcome_reason: attempt.outcome_reason,
      unmet_requirements: attempt.unmet_requirements,
      failure: attempt.failure,
    }));
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
  const artifactAttestationByCandidateId = Object.fromEntries(selectedCandidateIds.map(candidateId => {
    const beforeResult = beforeResultByCandidateId[candidateId];
    const before = beforeResult.inventory;
    const afterResult = afterResultByCandidateId[candidateId];
    const after = afterResult.inventory;
    const precheckFailed = beforeResult.status === "failed";
    const changed = driftedCandidateIds.has(candidateId);
    return [candidateId, {
      before,
      after,
      precheck: {
        status: beforeResult.status,
        error_code: beforeResult.error_code,
        error_message_sha256: beforeResult.error_message_sha256,
      },
      postcheck: {
        status: afterResult.status,
        error_code: afterResult.error_code,
        error_message_sha256: afterResult.error_message_sha256,
      },
      drift: {
        status: precheckFailed ? "precheck_failed" : afterResult.status === "failed" ? "postcheck_failed" : changed ? "changed" : "unchanged",
        before_inventory_self_sha256: before?.digests.inventory_self_sha256 ?? null,
        after_inventory_self_sha256: after?.digests.inventory_self_sha256 ?? null,
      },
    }];
  }));
  const commandRuntimeByCandidateId = Object.fromEntries(selectedCandidateIds.map(candidateId => [candidateId, {
    before: commandBeforeByCandidateId[candidateId],
    after: commandAfterByCandidateId[candidateId],
    status: commandBeforeByCandidateId[candidateId] === null ? "unavailable"
      : canonicalJson(commandBeforeByCandidateId[candidateId]) === canonicalJson(commandAfterByCandidateId[candidateId]) ? "unchanged_incomplete_nonclaiming" : "changed",
  }]));
  const resourceFactsByAttemptKey = deepFreeze(deriveRunnerResourceFacts(report, artifactAttestationByCandidateId));
  const retainedEvidenceBytesBeforeSerialization = (4 * 1024 * 1024)
    + Buffer.byteLength(JSON.stringify(attempts))
    + Buffer.byteLength(JSON.stringify(failureEvidenceByAttemptKey));
  validatePhase1ReportByteContract({
    limits: plan.limits,
    plannedAttempts,
    retainedEvidenceBytes: retainedEvidenceBytesBeforeSerialization,
  });
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  validatePhase1ReportByteContract({ limits: plan.limits, plannedAttempts, observedBytes: reportBytes.length });
  for (const attestation of Object.values(artifactAttestationByCandidateId)) {
    if (attestation.before) assertSchema(attestation.before, artifactInventorySchema, "before artifact inventory");
    if (attestation.after) assertSchema(attestation.after, artifactInventorySchema, "after artifact inventory");
  }
  assertSchema(report, reportSchema, "extraction Phase 1 report");
  const reportVerificationInputs = {
    registry,
    registrySchema,
    plan,
    planSchema,
    manifest: manifest.manifest,
    manifestSchema: JSON.parse(manifestSchemaBytes),
    manifestBytesSha256: sha256(manifestBytes),
    manifestSchemaBytesSha256: sha256(manifestSchemaBytes),
    requestSchema,
    responseSchema,
    reportSchema,
    adapterAvailability,
    artifactEligibilityByCandidateId: Object.fromEntries(selectedCandidateIds.map(candidateId => [candidateId, beforeResultByCandidateId[candidateId].status === "failed" ? "precheck_failed" : beforeResultByCandidateId[candidateId].inventory.state])),
    repositoryRoot: REPO_ROOT,
  };
  const verifiedReport = await verifyRetainedPhase1Report({
    reportBytes,
    verification: reportVerificationInputs,
    corpus: retainedCorpus,
    pdfjsLib,
    validatorSourceBytesByRole: sourceBytesBeforeAttempts,
    trustedFailureEvidenceByAttemptKey: failureEvidenceByAttemptKey,
  });
  const independentlyVerifiedLayoutEvidence = verifiedReport.layoutEvidenceByAttemptKey;
  if (verificationEvidence && typeof verificationEvidence === "object") {
    verificationEvidence.adapterAvailability = structuredClone(adapterAvailability);
    verificationEvidence.failureEvidenceByAttemptKey = structuredClone(failureEvidenceByAttemptKey);
    verificationEvidence.resourceFactsByAttemptKey = structuredClone(resourceFactsByAttemptKey);
    verificationEvidence.artifactAttestationByCandidateId = structuredClone(artifactAttestationByCandidateId);
    verificationEvidence.artifactConfigBindingByCandidateId = structuredClone(artifactConfigBindingByCandidateId);
    verificationEvidence.commandRuntimeByCandidateId = structuredClone(commandRuntimeByCandidateId);
    verificationEvidence.layoutEvidenceByAttemptKey = structuredClone(independentlyVerifiedLayoutEvidence);
  }
  if (generationRoot) {
    await validateSourcePrivacyBoundary({ trustedPrivacyClass, trustedProhibitedRoots, generationRoot });
    const resolvedGenerationRoot = path.resolve(generationRoot);
    const relativeToRepo = path.relative(REPO_ROOT, resolvedGenerationRoot);
    if (relativeToRepo === "" || (!relativeToRepo.startsWith("..") && !path.isAbsolute(relativeToRepo))) {
      throw new Error("Extraction generations must be persisted outside the repository");
    }
    await fs.mkdir(generationRoot, { recursive: true, mode: 0o700 });
    const publicationPrivacyBoundary = await validateSourcePrivacyBoundary({
      trustedPrivacyClass,
      trustedProhibitedRoots,
      generationRoot,
    });
    const sourceProhibitedRoots = trustedPrivacyClass === "public_synthetic"
      ? trustedProhibitedRoots
      : publicationPrivacyBoundary.realTrustedProhibitedRoots;
    const sourceBytesByRole = sourceBytesBeforeAttempts;
    const privacyEvidence = await buildPrivacyEvidence({
      trustedPrivacyClass,
      runRoot: generationRoot,
      trustedProhibitedRoots: sourceProhibitedRoots,
      publicationAuthorized: false,
      expectedRetainedFilePaths: trustedPrivacyClass === "public_synthetic" ? null : [],
      policyOnly: true,
    });
    const runnerEnvironmentAttestation = runnerEnvironmentBeforeAttempts;
    const companion = createExecutionCompanion({
      report,
      reportBytes,
      failureEvidenceByAttemptKey,
      resourceFactsByAttemptKey,
      artifactAttestationByCandidateId,
      artifactConfigBindingByCandidateId,
      commandRuntimeByCandidateId,
      privacyEvidence,
      sourceBytesByRole,
      runnerEnvironmentAttestation,
    });
    const companionBytes = Buffer.from(`${JSON.stringify(companion, null, 2)}\n`);
    assertSchema(companion, companionSchema, "execution companion");
    const inventoryArtifacts = {};
    const normalizedIds = new Set();
    for (const [candidateId, attestation] of Object.entries(artifactAttestationByCandidateId)) {
      const safeId = candidateId.replace(/[^a-z0-9]+/g, "_");
      if (normalizedIds.has(safeId)) throw new Error("Candidate IDs collide after generation filename normalization");
      normalizedIds.add(safeId);
      inventoryArtifacts[`artifact_config_${safeId}`] = { filename: `artifact-config-${safeId}.json`, bytes: Buffer.from(`${JSON.stringify(artifactConfigBindingByCandidateId[candidateId], null, 2)}\n`) };
      if (attestation.before) inventoryArtifacts[`artifact_before_${safeId}`] = { filename: `artifact-before-${safeId}.json`, bytes: Buffer.from(`${JSON.stringify(attestation.before, null, 2)}\n`) };
      if (attestation.after) inventoryArtifacts[`artifact_after_${safeId}`] = { filename: `artifact-after-${safeId}.json`, bytes: Buffer.from(`${JSON.stringify(attestation.after, null, 2)}\n`) };
    }
    let generationPrivacyAttestation = null;
    const publicationTransactionId = randomUUID();
    const executionSemanticVerifier = await createExecutionGenerationSemanticVerifier({
      repositoryRoot: REPO_ROOT,
      manifestPath,
      manifestSchemaPath,
      trustedPrivacyClass,
      trustedProhibitedRoots: sourceProhibitedRoots,
      trust: { kind: "local_claim_owned", expected_transaction_id: publicationTransactionId, expected_generation_sha256: null },
    });
    const published = await publishImmutableGeneration({
      parentDirectory: generationRoot,
      runId,
      kind: "execution",
      transactionId: publicationTransactionId,
      artifacts: {
        candidate_registry: { filename: "candidate-registry.v1.json", bytes: Buffer.from(`${JSON.stringify(registry, null, 2)}\n`) },
        execution_companion: { filename: "execution-companion.v1.json", bytes: companionBytes },
        execution_report: { filename: "execution-report.v1.json", bytes: reportBytes },
        ...retainedCorpus.artifacts,
        ...inventoryArtifacts,
        run_plan: { filename: "run-plan.v1.json", bytes: Buffer.from(`${JSON.stringify(plan, null, 2)}\n`) },
      },
      preIndexArtifactBuilder: async ({ stagingPath, artifacts }) => {
        generationPrivacyAttestation = await buildGenerationPrivacyAttestation({
          stagingPath,
          artifacts,
          policy: trustedPrivacyClass,
          trustedProhibitedRoots: sourceProhibitedRoots,
        });
        assertSchema(generationPrivacyAttestation, generationPrivacySchema, "generation privacy attestation");
        return { role: "privacy_attestation", filename: "generation-privacy.v1.json", bytes: Buffer.from(`${JSON.stringify(generationPrivacyAttestation, null, 2)}\n`) };
      },
      finalGenerationVerifier: executionSemanticVerifier,
      faultInjector: testOnlyPublicationFaultInjector,
    });
    assertSchema(published.index, executionIndexSchema, "execution generation index");
    if (verificationEvidence && typeof verificationEvidence === "object") {
      verificationEvidence.generation = published;
      verificationEvidence.semanticVerifier = executionSemanticVerifier;
    }
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const generationRootOption = option("--generation-root", null);
  if (!generationRootOption) throw new Error("Usage requires an explicit --generation-root outside the repository and sync/share roots");
  const generationRoot = path.resolve(generationRootOption);
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
    generationRoot,
  });
  process.stdout.write(`${JSON.stringify({ generation_root: generationRoot, run_id: report.run_id, denominator: report.denominator, claim_ready: false }, null, 2)}\n`);
}
