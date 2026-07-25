import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const FORMAL_EVIDENCE_RUNNER_VERSION = 2;
const SHA256 = /^[a-f0-9]{64}$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameSet(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

async function regularFile(filePath, label) {
  const entry = await fs.lstat(filePath);
  if (entry.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  const resolved = await fs.realpath(filePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  return resolved;
}

async function containedRegularFile(rootPath, filename, label) {
  if (path.isAbsolute(filename)) throw new Error(`${label} must be relative`);
  const normalized = path.normalize(filename);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} escapes the corpus directory`);
  }
  const root = await fs.realpath(rootPath);
  let candidate = root;
  for (const segment of normalized.split(path.sep).filter(Boolean)) {
    candidate = path.join(candidate, segment);
    const entry = await fs.lstat(candidate);
    if (entry.isSymbolicLink()) throw new Error(`${label} must not contain symbolic links`);
  }
  const resolved = await fs.realpath(candidate);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} resolves outside the corpus directory`);
  }
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  return resolved;
}

function run(command, args, {
  env = process.env,
  cwd,
  timeoutMs = 60_000,
  maxOutputBytes = 16 * 1024 * 1024,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let outputLimitExceeded = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const collect = target => chunk => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        outputLimitExceeded = true;
        child.kill("SIGKILL");
      } else {
        target.push(chunk);
      }
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timed_out: timedOut,
        output_limit_exceeded: outputLimitExceeded,
      });
    });
  });
}

function validateContract(contract) {
  const errors = [];
  if (contract?.contract_version !== 1) errors.push("contract_version must equal 1");
  if (contract?.evidence_runner_version !== FORMAL_EVIDENCE_RUNNER_VERSION) {
    errors.push("evidence_runner_version does not match executable runner");
  }
  if (!contract?.validator?.version || contract.validator.profile !== "ua1") {
    errors.push("validator version and ua1 profile must be explicit");
  }
  for (const field of ["installer_sha256", "installed_wrapper_sha256", "installed_cli_jar_sha256"]) {
    if (!SHA256.test(contract?.validator?.[field] ?? "")) errors.push(`validator.${field} must be SHA-256`);
  }
  if (!SHA256.test(contract?.validator?.signature_sha256 ?? "")
    || !/^[A-F0-9]{40}$/.test(contract?.validator?.signature_fingerprint ?? "")
    || contract?.validator?.signature_verification !== "not_verified_no_trusted_key") {
    errors.push("validator signature evidence and unverified status must be explicit");
  }
  if (contract?.validator?.expected_exit_codes?.compliant !== 0
    || contract?.validator?.expected_exit_codes?.non_compliant !== 1) {
    errors.push("validator exit semantics must pin compliant=0 and non_compliant=1");
  }
  for (const field of ["archive_sha256", "java_binary_sha256"]) {
    if (!SHA256.test(contract?.runtime?.[field] ?? "")) errors.push(`runtime.${field} must be SHA-256`);
  }
  if (contract?.corpus?.license_spdx_id !== "CC-BY-4.0"
    || contract?.corpus?.redistribution !== "allowed") {
    errors.push("corpus must explicitly record CC-BY-4.0 redistribution");
  }
  if (!Array.isArray(contract?.fixtures) || contract.fixtures.length < 2
    || !contract.fixtures.some(fixture => fixture.expected_machine_compliant === true)
    || !contract.fixtures.some(fixture => fixture.expected_machine_compliant === false)) {
    errors.push("formal corpus must contain known-good and known-defect fixtures");
  }
  const ids = new Set();
  for (const fixture of contract?.fixtures ?? []) {
    if (!/^[a-z0-9][a-z0-9.-]+$/.test(fixture.id ?? "")) errors.push("formal fixture IDs must be path-safe");
    if (ids.has(fixture.id)) errors.push(`duplicate formal fixture ${fixture.id}`);
    ids.add(fixture.id);
    if (typeof fixture.filename !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.pdf$/.test(fixture.filename)
      || path.posix.basename(fixture.filename) !== fixture.filename
      || path.win32.basename(fixture.filename) !== fixture.filename) {
      errors.push(`${fixture.id} filename must be a single safe PDF basename`);
    }
    if (!SHA256.test(fixture.sha256 ?? "")) errors.push(`${fixture.id} must pin SHA-256`);
    if (!Number.isInteger(fixture.size) || fixture.size < 1) errors.push(`${fixture.id} must pin a positive byte size`);
    if (!/^https:\/\//.test(fixture.source_url ?? "")) errors.push(`${fixture.id} must have an HTTPS source URL`);
    if (!Array.isArray(fixture.expected_failed_rule_keys)
      || new Set(fixture.expected_failed_rule_keys).size !== fixture.expected_failed_rule_keys.length) {
      errors.push(`${fixture.id} failed rule keys must be a unique array`);
    }
    if (fixture.expected_machine_compliant && fixture.expected_failed_rule_keys.length !== 0) {
      errors.push(`${fixture.id} compliant fixture cannot expect failed rules`);
    }
    if (!fixture.expected_machine_compliant && fixture.expected_failed_rule_keys.length === 0) {
      errors.push(`${fixture.id} defect fixture must expect failed rules`);
    }
  }
  const trial = contract?.recorded_local_trial;
  if (!trial || Number.isNaN(Date.parse(trial.executed_at ?? ""))
    || typeof trial.platform !== "string" || trial.platform.length === 0
    || trial.pass_exit_code !== contract?.validator?.expected_exit_codes?.compliant
    || trial.fail_exit_code !== contract?.validator?.expected_exit_codes?.non_compliant
    || !SHA256.test(trial.pass_raw_report_sha256 ?? "")
    || !SHA256.test(trial.fail_raw_report_sha256 ?? "")
    || trial.raw_reports_committed !== false
    || typeof trial.reason !== "string" || trial.reason.length === 0) {
    errors.push("recorded_local_trial must contain typed, hash-bound informational evidence");
  }
  return errors;
}

export async function loadFormalAccessibilityContract(contractPath) {
  const resolved = await regularFile(contractPath, "Formal accessibility contract");
  const contract = JSON.parse(await fs.readFile(resolved, "utf8"));
  const errors = validateContract(contract);
  if (errors.length > 0) throw new Error(`Invalid formal accessibility contract:\n- ${errors.join("\n- ")}`);
  return { contract, contract_path: resolved, contract_sha256: sha256(await fs.readFile(resolved)) };
}

function ruleKey(summary) {
  return `${summary.specification}#${summary.clause}#${summary.testNumber}`;
}

export function parseVeraPdfEvidence(rawReport, exitCode, fixture, contract) {
  const reportSha256 = sha256(rawReport);
  const report = JSON.parse(rawReport.toString("utf8"));
  const releaseDetails = report?.report?.buildInformation?.releaseDetails;
  const jobs = report?.report?.jobs;
  const batch = report?.report?.batchSummary;
  if (!Array.isArray(releaseDetails) || releaseDetails.length === 0
    || releaseDetails.some(release => release.version !== contract.validator.version)) {
    throw new Error("veraPDF report build versions do not match the pinned validator");
  }
  if (!Array.isArray(jobs) || jobs.length !== 1 || jobs[0].validationResult?.length !== 1) {
    throw new Error("veraPDF report must contain exactly one job and validation result");
  }
  const validation = jobs[0].validationResult[0];
  if (path.basename(jobs[0].itemDetails?.name ?? "") !== fixture.filename
    || jobs[0].itemDetails?.size !== fixture.size) {
    throw new Error("veraPDF report item identity does not match the pinned fixture");
  }
  if (validation.jobEndStatus !== "normal") throw new Error("veraPDF job did not end normally");
  if (validation.profileName !== contract.validator.profile_name) {
    throw new Error("veraPDF report profile does not match the pinned profile");
  }
  const unhealthy = batch?.outOfMemory !== 0
    || batch?.veraExceptions !== 0
    || batch?.failedEncryptedJobs !== 0
    || batch?.failedParsingJobs !== 0
    || batch?.validationSummary?.failedJobCount !== 0;
  if (unhealthy) throw new Error("veraPDF report contains a processing or harness failure");
  if (typeof validation.compliant !== "boolean") throw new Error("veraPDF compliance result is not boolean");
  const summaries = validation.details?.ruleSummaries ?? [];
  const passedRules = validation.details?.passedRules;
  const failedRules = validation.details?.failedRules;
  const passedChecks = validation.details?.passedChecks;
  const failedChecks = validation.details?.failedChecks;
  if (!Number.isInteger(passedRules) || !Number.isInteger(failedRules)
    || !Number.isInteger(passedChecks) || !Number.isInteger(failedChecks)
    || passedRules < 0 || failedRules < 0 || passedChecks < 0 || failedChecks < 0
    || passedRules + failedRules === 0 || passedChecks + failedChecks === 0
    || failedRules !== summaries.length
    || (validation.compliant && (failedRules !== 0 || failedChecks !== 0))
    || (!validation.compliant && (failedRules === 0 || failedChecks === 0))) {
    throw new Error("veraPDF compliance boolean conflicts with failure counters");
  }
  const expectedExit = validation.compliant
    ? contract.validator.expected_exit_codes.compliant
    : contract.validator.expected_exit_codes.non_compliant;
  if (exitCode !== expectedExit) {
    throw new Error(`veraPDF exit code ${exitCode} conflicts with report result; expected ${expectedExit}`);
  }
  const failedRuleKeys = summaries.map(ruleKey).sort();
  const exactRulesMatch = sameSet(failedRuleKeys, fixture.expected_failed_rule_keys);
  return {
    raw_report_sha256: reportSha256,
    validator_version: contract.validator.version,
    profile: contract.validator.profile,
    profile_name: validation.profileName,
    job_end_status: validation.jobEndStatus,
    exit_code: exitCode,
    machine_compliant: validation.compliant,
    passed_rules: passedRules,
    failed_rules: failedRules,
    passed_checks: passedChecks,
    failed_checks: failedChecks,
    failed_rule_keys: failedRuleKeys,
    exact_failed_rules_match: exactRulesMatch,
    expectation_met: validation.compliant === fixture.expected_machine_compliant && exactRulesMatch,
    machine_validation_result: validation.compliant
      ? "validator_profile_passed"
      : "validator_profile_failed",
    claim_gate_ingestion: "not_available_phase_0",
    pdfua_conformance: "not_established_without_complete_human_review",
    wcag_conformance: "not_established",
    certified_conformance: "not_established",
  };
}

function formalConfusion(results) {
  const byFamily = {};
  for (const result of results) {
    const family = result.rule_family;
    byFamily[family] ??= {
      true_positives: 0,
      true_negatives: 0,
      false_positives: 0,
      false_negatives: 0,
      harness_failures: 0,
    };
    const expectedDefect = !result.expected_machine_compliant;
    const detectedDefect = result.evidence ? !result.evidence.machine_compliant : false;
    if (result.harness_error) byFamily[family].harness_failures += 1;
    else if (expectedDefect && detectedDefect) byFamily[family].true_positives += 1;
    else if (!expectedDefect && !detectedDefect) byFamily[family].true_negatives += 1;
    else if (!expectedDefect && detectedDefect) byFamily[family].false_positives += 1;
    else byFamily[family].false_negatives += 1;
  }
  return byFamily;
}

/**
 * Directories that must never appear on the formal validator's PATH.
 *
 * The veraPDF entry point is a shell wrapper, so every directory on its PATH is
 * a place an attacker who can write there gets to supply a binary the run may
 * execute. On macOS `/usr/local/bin` is group-writable by admin users without
 * sudo, and on many Linux setups it is similarly loose, so it is exactly the
 * kind of location that must not sit in front of a run whose output we treat as
 * formal machine evidence. Nothing about veraPDF requires it: the wrapper needs
 * a shell, a handful of coreutils, and the pinned JRE, all of which live in
 * `/usr/bin`, `/bin`, and the hash-verified `JAVA_HOME`.
 */
export const MUTABLE_PATH_DIRECTORIES = Object.freeze([
  "/usr/local/bin",
  "/usr/local/sbin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
]);

/**
 * Build the sealed environment for a formal validator run.
 *
 * Exported separately from the runner so the trust properties can be asserted
 * directly, without a veraPDF or JRE install present.
 */
export function buildFormalRunnerEnvironment({ javaHome, runtimeHome }) {
  const resolvedJavaHome = path.resolve(javaHome);
  const searchPath = [path.join(resolvedJavaHome, "bin"), "/usr/bin", "/bin"];
  for (const directory of searchPath) {
    if (MUTABLE_PATH_DIRECTORIES.includes(directory)) {
      throw new Error(`Formal runner PATH must exclude mutable directory ${directory}`);
    }
  }
  return {
    HOME: runtimeHome,
    XDG_CACHE_HOME: path.join(runtimeHome, "cache"),
    XDG_CONFIG_HOME: path.join(runtimeHome, "config"),
    TMPDIR: path.join(runtimeHome, "tmp"),
    JAVA_HOME: resolvedJavaHome,
    PATH: searchPath.join(":"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
  };
}

export async function runFormalAccessibilityEvaluation({
  contractPath,
  corpusDirectory,
  validatorPath,
  validatorArtifactPath,
  runtimeArchivePath,
  javaHome,
  reportDirectory,
}) {
  const { contract, contract_sha256: contractSha256 } = await loadFormalAccessibilityContract(contractPath);
  const validator = await regularFile(validatorPath, "veraPDF wrapper");
  const installer = await regularFile(validatorArtifactPath, "veraPDF installer artifact");
  const runtimeArchive = await regularFile(runtimeArchivePath, "Java runtime archive");
  const java = await regularFile(path.join(javaHome, "bin", "java"), "Java runtime binary");
  const cliJar = await regularFile(
    path.join(path.dirname(validator), "bin", `cli-${contract.validator.version}.jar`),
    "veraPDF CLI jar"
  );
  const pinnedArtifactsMatch = sha256(await fs.readFile(installer)) === contract.validator.installer_sha256
    && sha256(await fs.readFile(validator)) === contract.validator.installed_wrapper_sha256
    && sha256(await fs.readFile(cliJar)) === contract.validator.installed_cli_jar_sha256
    && sha256(await fs.readFile(runtimeArchive)) === contract.runtime.archive_sha256
    && sha256(await fs.readFile(java)) === contract.runtime.java_binary_sha256;
  if (!pinnedArtifactsMatch) throw new Error("Formal validator/runtime artifact hash mismatch");

  await fs.mkdir(reportDirectory, { recursive: true });
  if ((await fs.lstat(reportDirectory)).isSymbolicLink()) {
    throw new Error("Formal raw-report directory must not be a symbolic link");
  }
  const reportsRoot = await fs.realpath(reportDirectory);
  const runtimeHome = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-verapdf-home-"));
  const resolvedJavaHome = path.resolve(javaHome);
  const environment = buildFormalRunnerEnvironment({ javaHome: resolvedJavaHome, runtimeHome });
  await Promise.all([
    fs.mkdir(environment.XDG_CACHE_HOME),
    fs.mkdir(environment.XDG_CONFIG_HOME),
    fs.mkdir(environment.TMPDIR),
  ]);
  try {
    const version = await run(validator, ["--version"], { cwd: runtimeHome, env: environment });
    if (version.code !== 0 || version.signal || version.timed_out || version.output_limit_exceeded
      || !version.stdout.toString("utf8").includes(`veraPDF ${contract.validator.version}`)) {
      throw new Error(`veraPDF version preflight failed (exit=${version.code}, signal=${version.signal ?? "none"}, stderr_sha256=${sha256(version.stderr)})`);
    }
    const results = [];
    for (const fixture of contract.fixtures) {
      const fixturePath = await containedRegularFile(corpusDirectory, fixture.filename, fixture.id);
      const fixtureHashMatches = sha256(await fs.readFile(fixturePath)) === fixture.sha256;
      if (!fixtureHashMatches) throw new Error(`${fixture.id} SHA-256 mismatch`);
      const execution = await run(validator, [
        "--format",
        "json",
        "--flavour",
        contract.validator.profile,
        fixturePath,
      ], { cwd: runtimeHome, env: environment });
      const reportPath = path.join(reportsRoot, `${fixture.id}.raw.json`);
      await fs.writeFile(reportPath, execution.stdout, { flag: "wx" });
      let evidence = null;
      let harnessError = null;
      try {
        if (execution.signal) throw new Error(`validator terminated by signal ${execution.signal}`);
        if (execution.timed_out) throw new Error("validator timed out");
        if (execution.output_limit_exceeded) throw new Error("validator exceeded output limit");
        evidence = parseVeraPdfEvidence(execution.stdout, execution.code, fixture, contract);
      } catch (error) {
        harnessError = error.message;
      }
      results.push({
        id: fixture.id,
        rule_family: fixture.rule_family,
        expected_machine_compliant: fixture.expected_machine_compliant,
        fixture_sha256: fixture.sha256,
        fixture_hash_matches: fixtureHashMatches,
        raw_report_path: reportPath,
        raw_report_sha256: sha256(execution.stdout),
        stderr_sha256: sha256(execution.stderr),
        evidence,
        harness_error: harnessError,
        expectation_met: !harnessError && evidence.expectation_met,
      });
    }
    return {
      evidence_runner_version: FORMAL_EVIDENCE_RUNNER_VERSION,
      contract_sha256: contractSha256,
      execution_environment: {
        inherited_parent_environment: false,
        inherited_working_directory: false,
        java_home: resolvedJavaHome,
        locale: environment.LC_ALL,
        timezone: environment.TZ,
        disposable_home: true,
        java_injection_variables_present: false,
      },
      validator: {
        name: contract.validator.name,
        version: contract.validator.version,
        profile: contract.validator.profile,
        installer_sha256: contract.validator.installer_sha256,
        signature_verification: contract.validator.signature_verification,
      },
      passed: results.every(result => result.expectation_met),
      rule_family_confusion: formalConfusion(results),
      repair_guidance_assessment: contract.repair_guidance_assessment,
      limitations: [
        "Machine validation covers only veraPDF's machine-verifiable profile rules.",
        "The release signature is recorded but was not verified against a trusted public key.",
        "No human review, PDF/UA conformance, WCAG conformance, legal compliance, or certification is established.",
      ],
      results,
    };
  } finally {
    await fs.rm(runtimeHome, { recursive: true, force: true });
  }
}
