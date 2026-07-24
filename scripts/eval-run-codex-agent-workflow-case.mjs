#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ALLOWED_ARMS = new Set([
  "codex-explicit-skill",
  "codex-explicit-baseline",
  "codex-prompt-full-skill-body",
  "codex-prompt-no-skill-body",
]);
const HELDOUT_ARMS = new Set([
  "codex-prompt-full-skill-body",
  "codex-prompt-no-skill-body",
]);
const FEATURE_DENIES = [
  "apps",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode",
  "code_mode_host",
  "computer_use",
  "goals",
  "hooks",
  "image_generation",
  "in_app_browser",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "network_proxy",
  "plugins",
  "remote_plugin",
  "request_permissions_tool",
  "shell_tool",
  "skill_mcp_dependency_install",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "unified_exec",
  "workspace_dependencies",
];
const SYNTHETIC_GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "PDF Workflow Eval",
  GIT_AUTHOR_EMAIL: "eval@invalid.local",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "PDF Workflow Eval",
  GIT_COMMITTER_EMAIL: "eval@invalid.local",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  LC_ALL: "C",
  TZ: "UTC",
};
const CODEX_BASE_ENVIRONMENT_NAMES = [
  "CODEX_HOME",
  "GIT_AUTHOR_DATE",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_NAME",
  "GIT_COMMITTER_DATE",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "PATH",
  "TERM",
  "TMPDIR",
  "TZ",
];
const MACOS_EFFECTIVE_ENVIRONMENT_NAMES = [
  "__CF_USER_TEXT_ENCODING",
];
export const CODEX_ENVIRONMENT_NAMES = [
  ...CODEX_BASE_ENVIRONMENT_NAMES,
  ...(process.platform === "darwin" ? MACOS_EFFECTIVE_ENVIRONMENT_NAMES : []),
];
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function macosUserTextEncoding() {
  if (process.platform !== "darwin") return {};
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("macOS Codex environment requires a stable numeric uid");
  }
  return {
    // CoreFoundation injects this value even when child_process receives a
    // minimal env. Supplying and binding the deterministic value makes the
    // effective environment explicit instead of silently host-dependent.
    __CF_USER_TEXT_ENCODING: `0x${uid.toString(16).toUpperCase()}:0x0:0x0`,
  };
}

export function codexEnvironment(codexHome) {
  const environment = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
    LANG: "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    TMPDIR: path.join(codexHome, "tmp"),
    ...SYNTHETIC_GIT_ENV,
    ...macosUserTextEncoding(),
    CODEX_HOME: codexHome,
  };
  if (
    canonicalJson(Object.keys(environment).sort())
      !== canonicalJson(CODEX_ENVIRONMENT_NAMES)
  ) {
    throw new Error("Codex environment differs from the sealed allowlist");
  }
  return environment;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function pathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function featureDenyArgs() {
  return FEATURE_DENIES.flatMap(feature => ["--disable", feature]);
}

export function codexExecArgs({ model, responsePath }) {
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--model",
    model,
    "--output-schema",
    "response-schema.json",
    "--json",
    "--output-last-message",
    responsePath,
    ...featureDenyArgs(),
    "-",
  ];
}

export function codexPromptInputArgs(prompt) {
  return [
    "debug",
    "prompt-input",
    ...featureDenyArgs(),
    prompt,
  ];
}

function sandboxString(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

export function codexSandboxProfile(deniedUserHome) {
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read* (subpath ${sandboxString(deniedUserHome)}))`,
    `(deny file-write* (subpath ${sandboxString(deniedUserHome)}))`,
  ].join("\n");
}

export function sandboxedCodexArgs({ sandboxProfile, codexBinary, codexArgs }) {
  return ["-p", sandboxProfile, codexBinary, ...codexArgs];
}

async function writeExclusive(filename, value) {
  const handle = await fs.open(filename, "wx+", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
    return await artifactRecordFromHandle(handle);
  } finally {
    await handle.close();
  }
}

async function artifactRecordFromHandle(handle, {
  requirePrivate = true,
  requireSingleLink = true,
} = {}) {
  const stat = await handle.stat();
  if (
    !stat.isFile()
    || (requireSingleLink && stat.nlink !== 1)
    || (requirePrivate && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error("evidence artifact must be a private single-link regular file");
  }
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < stat.size) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, stat.size - position),
      position,
    );
    if (bytesRead === 0) throw new Error("evidence artifact ended while hashing");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return {
    bytes: stat.size,
    sha256: hash.digest("hex"),
    mode: stat.mode & 0o777,
    nlink: stat.nlink,
    device: stat.dev,
    inode: stat.ino,
  };
}

async function executableIdentity(filename) {
  const canonicalPath = await fs.realpath(filename);
  const pathStat = await fs.lstat(filename);
  if (
    canonicalPath !== filename
    || !pathStat.isFile()
    || pathStat.isSymbolicLink()
  ) {
    throw new Error("campaign executable must be a canonical regular file");
  }
  const handle = await fs.open(
    canonicalPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    return {
      canonical_path: canonicalPath,
      ...await artifactRecordFromHandle(handle, {
        requirePrivate: false,
        requireSingleLink: false,
      }),
    };
  } finally {
    await handle.close();
  }
}

async function privateFileIdentity(filename) {
  const handle = await fs.open(
    filename,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    return await artifactRecordFromHandle(handle);
  } finally {
    await handle.close();
  }
}

async function runCaptured(program, args, {
  cwd,
  env,
  stdin = null,
  stdoutPath,
  stderrPath,
}) {
  const stdout = await fs.open(stdoutPath, "wx+", 0o600);
  const stderr = await fs.open(stderrPath, "wx+", 0o600);
  try {
    const child = spawn(program, args, {
      cwd,
      env,
      shell: false,
      stdio: ["pipe", stdout.fd, stderr.fd],
    });
    child.stdin.on("error", () => {});
    const completion = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    if (stdin === null) child.stdin.end();
    else child.stdin.end(stdin);
    const result = await completion;
    await Promise.all([stdout.sync(), stderr.sync()]);
    return {
      ...result,
      stdout_artifact: await artifactRecordFromHandle(stdout),
      stderr_artifact: await artifactRecordFromHandle(stderr),
    };
  } finally {
    await Promise.all([stdout.close(), stderr.close()]);
  }
}

async function initializeSyntheticRepository(caseRoot, environment) {
  await execFileAsync("git", [
    "init",
    "-q",
    "--object-format=sha1",
    "--template=",
  ], { cwd: caseRoot, env: environment });
  await execFileAsync("git", [
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.eol=lf",
    "add",
    "-A",
  ], { cwd: caseRoot, env: environment });
  await execFileAsync("git", [
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.eol=lf",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "Synthetic participant arm",
  ], { cwd: caseRoot, env: environment });
}

async function exactDirectoryEntries(root) {
  return (await fs.readdir(root)).sort();
}

export async function runCodexAgentWorkflowCase(options) {
  const {
    arm,
    caseId,
    caseRoot,
    resultsRoot,
    codexHome,
    promptCaptureHome = null,
    codexBinary,
    sandboxBinary,
    attesterPath,
    expectedCommitSha1,
    expectedTreeSha1,
    expectedContentTreeSha256,
    sourceCommit,
    model,
    runId = null,
    scheduleOrdinal = null,
    repeatIndex = null,
    pairId = null,
    pairPosition = null,
    scheduleSha256 = null,
    expectedAuthSha256 = null,
    onPreInferenceReady = null,
    onProcessComplete = null,
  } = options;
  if (!ALLOWED_ARMS.has(arm)) throw new Error("unsupported explicit Codex arm");
  if (!/^[a-z0-9-]+$/.test(caseId)) throw new Error("caseId is invalid");
  if (HELDOUT_ARMS.has(arm)) {
    if (
      typeof runId !== "string"
      || !/^[a-z0-9-]+$/.test(runId)
      || typeof pairId !== "string"
      || !/^[a-z0-9-]+$/.test(pairId)
      || !Number.isInteger(scheduleOrdinal)
      || scheduleOrdinal < 1
      || !Number.isInteger(repeatIndex)
      || repeatIndex < 1
      || ![1, 2].includes(pairPosition)
      || typeof scheduleSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(scheduleSha256)
      || typeof promptCaptureHome !== "string"
      || !path.isAbsolute(promptCaptureHome)
    ) {
      throw new Error("held-out runs require valid frozen schedule metadata");
    }
  }
  for (const [label, value] of Object.entries({
    caseRoot,
    resultsRoot,
    codexHome,
    codexBinary,
    sandboxBinary,
    attesterPath,
  })) {
    if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  }
  if (promptCaptureHome !== null && !path.isAbsolute(promptCaptureHome)) {
    throw new Error("promptCaptureHome must be absolute when supplied");
  }
  if (
    expectedAuthSha256 !== null
    && (
      typeof expectedAuthSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(expectedAuthSha256)
    )
  ) {
    throw new Error("expectedAuthSha256 must be a SHA-256 digest");
  }
  if (pathInside(caseRoot, resultsRoot) || pathInside(resultsRoot, caseRoot)) {
    throw new Error("resultsRoot and caseRoot must not contain each other");
  }
  for (const [left, right] of [
    [caseRoot, codexHome],
    [codexHome, caseRoot],
    [resultsRoot, codexHome],
    [codexHome, resultsRoot],
    ...(promptCaptureHome === null ? [] : [
      [caseRoot, promptCaptureHome],
      [promptCaptureHome, caseRoot],
      [resultsRoot, promptCaptureHome],
      [promptCaptureHome, resultsRoot],
      [codexHome, promptCaptureHome],
      [promptCaptureHome, codexHome],
    ]),
  ]) {
    if (pathInside(left, right)) {
      throw new Error("caseRoot, resultsRoot, and codexHome must be disjoint");
    }
  }
  if (
    pathInside(caseRoot, attesterPath)
    || pathInside(resultsRoot, attesterPath)
    || pathInside(codexHome, attesterPath)
    || (promptCaptureHome !== null && pathInside(promptCaptureHome, attesterPath))
  ) {
    throw new Error("attesterPath must be operator-owned outside run roots");
  }
  if (
    pathInside(caseRoot, sandboxBinary)
    || pathInside(resultsRoot, sandboxBinary)
    || pathInside(codexHome, sandboxBinary)
    || (promptCaptureHome !== null && pathInside(promptCaptureHome, sandboxBinary))
  ) {
    throw new Error("sandboxBinary must remain outside run roots");
  }
  if ((await exactDirectoryEntries(codexHome)).join("\0") !== "auth.json") {
    throw new Error("codexHome must initially contain only auth.json");
  }
  if (
    promptCaptureHome !== null
    && (await exactDirectoryEntries(promptCaptureHome)).join("\0") !== "auth.json"
  ) {
    throw new Error("promptCaptureHome must initially contain only auth.json");
  }
  if (
    await fs.realpath(caseRoot) !== caseRoot
    || await fs.realpath(codexHome) !== codexHome
    || (
      promptCaptureHome !== null
      && await fs.realpath(promptCaptureHome) !== promptCaptureHome
    )
  ) {
    throw new Error("caseRoot and codexHome must use canonical paths");
  }
  const authStat = await fs.lstat(path.join(codexHome, "auth.json"));
  if (
    !authStat.isFile()
    || authStat.isSymbolicLink()
    || authStat.nlink !== 1
    || (authStat.mode & 0o077) !== 0
  ) {
    throw new Error("auth.json must be a private regular file");
  }
  if (promptCaptureHome !== null) {
    const captureAuthStat = await fs.lstat(
      path.join(promptCaptureHome, "auth.json"),
    );
    if (
      !captureAuthStat.isFile()
      || captureAuthStat.isSymbolicLink()
      || captureAuthStat.nlink !== 1
      || (captureAuthStat.mode & 0o077) !== 0
    ) {
      throw new Error("prompt capture auth.json must be a private regular file");
    }
  }
  const codexAuthIdentity = await privateFileIdentity(
    path.join(codexHome, "auth.json"),
  );
  const promptCaptureAuthIdentity = promptCaptureHome === null
    ? codexAuthIdentity
    : await privateFileIdentity(path.join(promptCaptureHome, "auth.json"));
  if (
    expectedAuthSha256 !== null
    && (
      codexAuthIdentity.sha256 !== expectedAuthSha256
      || promptCaptureAuthIdentity.sha256 !== expectedAuthSha256
    )
  ) {
    throw new Error("isolated authentication copies differ from campaign preflight");
  }

  await fs.mkdir(resultsRoot, { mode: 0o700 });
  const runtimeTemporaryRoot = path.join(codexHome, "tmp");
  await fs.mkdir(runtimeTemporaryRoot, { mode: 0o700 });
  const environment = codexEnvironment(codexHome);
  if (environment.TMPDIR !== runtimeTemporaryRoot) {
    throw new Error("Codex temporary root differs from the sealed environment");
  }
  const promptCaptureTemporaryRoot = promptCaptureHome === null
    ? runtimeTemporaryRoot
    : path.join(promptCaptureHome, "tmp");
  if (promptCaptureHome !== null) {
    await fs.mkdir(promptCaptureTemporaryRoot, { mode: 0o700 });
  }
  const promptCaptureEnvironment = {
    ...environment,
    TMPDIR: promptCaptureTemporaryRoot,
    CODEX_HOME: promptCaptureHome ?? codexHome,
  };
  const attesterBytes = await fs.readFile(attesterPath);
  const launcherBytes = await fs.readFile(fileURLToPath(import.meta.url));
  const attester = await import(pathToFileURL(attesterPath).href);
  const prompt = await fs.readFile(path.join(caseRoot, "prompt.txt"), "utf8");
  const responseSchema = await fs.readFile(
    path.join(caseRoot, "response-schema.json"),
  );

  await initializeSyntheticRepository(caseRoot, environment);
  const attestationArgs = {
    armRoot: caseRoot,
    expectedCommitSha1,
    expectedTreeSha1,
    expectedContentTreeSha256,
  };
  const { stdout: codexVersion } = await execFileAsync(
    codexBinary,
    ["--version"],
    { encoding: "utf8", env: environment },
  );
  const [codexExecutable, sandboxExecutable] = await Promise.all([
    executableIdentity(codexBinary),
    executableIdentity(sandboxBinary),
  ]);
  const responsePath = path.join(resultsRoot, "response.json");
  const deniedUserHome = os.userInfo().homedir;
  const sandboxProfile = codexSandboxProfile(deniedUserHome);
  const codexArgs = codexExecArgs({ model, responsePath });
  const execArgs = sandboxedCodexArgs({
    sandboxProfile,
    codexBinary,
    codexArgs,
  });
  const promptInputArgs = codexPromptInputArgs(prompt);
  const sandboxedPromptInputArgs = sandboxedCodexArgs({
    sandboxProfile,
    codexBinary,
    codexArgs: promptInputArgs,
  });
  const launchPlan = {
    schema_version: "pdf-tools.agent-workflow-launch-plan.v1",
    arm,
    case_id: caseId,
    run_id: runId,
    schedule_ordinal: scheduleOrdinal,
    repeat_index: repeatIndex,
    pair_id: pairId,
    pair_position: pairPosition,
    run_schedule_sha256: scheduleSha256,
    source_commit: sourceCommit,
    expected_identity: {
      commit_sha1: expectedCommitSha1,
      git_tree_sha1: expectedTreeSha1,
      content_tree_sha256: expectedContentTreeSha256,
    },
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      architecture: os.arch(),
      release: os.release(),
      node_version: process.version,
      codex_version: codexVersion.trim(),
    },
    executable_identity: {
      codex: codexExecutable,
      sandbox: sandboxExecutable,
    },
    model,
    case_root: caseRoot,
    results_root: resultsRoot,
    codex_home: codexHome,
    prompt_capture_home: promptCaptureHome ?? codexHome,
    codex_home_initial_entries: ["auth.json"],
    prompt_sha256: sha256(prompt),
    response_schema_sha256: sha256(responseSchema),
    auth_source_sha256: expectedAuthSha256,
    attester_sha256: sha256(attesterBytes),
    launcher_sha256: sha256(launcherBytes),
    isolation: {
      process_home_inherited: false,
      denied_user_home: deniedUserHome,
      sandbox_program: sandboxBinary,
      sandbox_profile: sandboxProfile,
      environment_names: Object.keys(environment).sort(),
    },
    command: {
      program: sandboxBinary,
      argv: execArgs,
      codex_program: codexBinary,
      codex_argv: codexArgs,
      cwd: caseRoot,
      stdin: "prompt.txt",
      stdin_sha256: sha256(prompt),
      stdout: path.join(resultsRoot, "events.jsonl"),
      stderr: path.join(resultsRoot, "stderr.txt"),
      environment_policy: {
        CODEX_HOME: codexHome,
        feature_denies: FEATURE_DENIES,
      },
    },
  };
  const launchPlanArtifact = await writeExclusive(
    path.join(resultsRoot, "launch-plan.json"),
    `${JSON.stringify(launchPlan, null, 2)}\n`,
  );

  const promptInputStartedAt = new Date().toISOString();
  const promptInputResult = await runCaptured(
    sandboxBinary,
    sandboxedPromptInputArgs,
    {
      cwd: caseRoot,
      env: promptCaptureEnvironment,
      stdoutPath: path.join(resultsRoot, "prompt-input.json"),
      stderrPath: path.join(resultsRoot, "prompt-input.stderr.txt"),
    },
  );
  const promptInputFinishedAt = new Date().toISOString();
  if (promptInputResult.code !== 0 || promptInputResult.signal !== null) {
    throw new Error("Codex prompt-input reconstruction did not exit successfully");
  }
  const preAttestation = await attester.attestAgentWorkflowArm(attestationArgs);
  const preAttestationArtifact = await writeExclusive(
    path.join(resultsRoot, "pre-run-attestation.json"),
    `${JSON.stringify(preAttestation, null, 2)}\n`,
  );
  if (!preAttestation.pass) throw new Error("pre-run case attestation failed");
  if (typeof onPreInferenceReady === "function") {
    await onPreInferenceReady({
      schema_version: "pdf-tools.agent-workflow-pre-inference-ready.v1",
      run_id: runId,
      schedule_ordinal: scheduleOrdinal,
      recorded_at: new Date().toISOString(),
      prompt_input_started_at: promptInputStartedAt,
      prompt_input_finished_at: promptInputFinishedAt,
      prompt_input_exit_code: promptInputResult.code,
      prompt_input_signal: promptInputResult.signal,
      model,
      host: launchPlan.host,
      executable_identity: launchPlan.executable_identity,
      expected_identity: launchPlan.expected_identity,
      runtime_isolation: {
        case_root: caseRoot,
        results_root: resultsRoot,
        codex_home: codexHome,
        prompt_capture_home: promptCaptureHome ?? codexHome,
      },
      prompt_sha256: sha256(prompt),
      response_schema_sha256: sha256(responseSchema),
      auth_source_sha256: expectedAuthSha256,
      auth_artifacts: {
        codex_home: codexAuthIdentity,
        prompt_capture_home: promptCaptureAuthIdentity,
      },
      inference_command: launchPlan.command,
      prompt_reconstruction_command: {
        program: sandboxBinary,
        argv: sandboxedPromptInputArgs,
        codex_program: codexBinary,
        codex_argv: promptInputArgs,
        cwd: caseRoot,
        environment_policy: {
          ...launchPlan.command.environment_policy,
          CODEX_HOME: promptCaptureHome ?? codexHome,
        },
      },
      artifacts: {
        "launch-plan.json": launchPlanArtifact,
        "prompt-input.json": promptInputResult.stdout_artifact,
        "prompt-input.stderr.txt": promptInputResult.stderr_artifact,
        "pre-run-attestation.json": preAttestationArtifact,
      },
    });
  }

  const startedAt = new Date().toISOString();
  const processResult = await runCaptured(sandboxBinary, execArgs, {
    cwd: caseRoot,
    env: environment,
    stdin: prompt,
    stdoutPath: path.join(resultsRoot, "events.jsonl"),
    stderrPath: path.join(resultsRoot, "stderr.txt"),
  });
  const finishedAt = new Date().toISOString();
  const [postCodexExecutable, postSandboxExecutable] = await Promise.all([
    executableIdentity(codexBinary),
    executableIdentity(sandboxBinary),
  ]);
  const postExecutableIdentity = {
    codex: postCodexExecutable,
    sandbox: postSandboxExecutable,
  };
  let responseArtifact = {
    present: false,
    bytes: 0,
    sha256: null,
    mode: null,
    nlink: null,
    device: null,
    inode: null,
  };
  try {
    const responseHandle = await fs.open(
      responsePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      await responseHandle.chmod(0o600);
      responseArtifact = {
        present: true,
        ...await artifactRecordFromHandle(responseHandle),
      };
    } finally {
      await responseHandle.close();
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const processArtifacts = {
    "events.jsonl": {
      present: true,
      ...processResult.stdout_artifact,
    },
    "response.json": responseArtifact,
    "stderr.txt": {
      present: true,
      ...processResult.stderr_artifact,
    },
  };
  if (typeof onProcessComplete === "function") {
    await onProcessComplete({
      schema_version: "pdf-tools.agent-workflow-process-completion.v1",
      run_id: runId,
      schedule_ordinal: scheduleOrdinal,
      started_at: startedAt,
      finished_at: finishedAt,
      process_exit_code: processResult.code,
      process_signal: processResult.signal,
      prompt_sha256: sha256(prompt),
      model,
      host: launchPlan.host,
      executable_identity: launchPlan.executable_identity,
      post_executable_identity: postExecutableIdentity,
      inference_command_sha256: sha256(canonicalJson(launchPlan.command)),
      artifacts: processArtifacts,
    });
  }
  const postAttestation = await attester.attestAgentWorkflowArm(attestationArgs);
  await writeExclusive(
    path.join(resultsRoot, "post-run-attestation.json"),
    `${JSON.stringify(postAttestation, null, 2)}\n`,
  );

  const launchOutcome = {
    schema_version: "pdf-tools.agent-workflow-launch-outcome.v1",
    started_at: startedAt,
    finished_at: finishedAt,
    process_exit_code: processResult.code,
    process_signal: processResult.signal,
    post_attestation_pass: postAttestation.pass,
    prompt_input_started_at: promptInputStartedAt,
    prompt_input_finished_at: promptInputFinishedAt,
    prompt_input_exit_code: promptInputResult.code,
    prompt_input_signal: promptInputResult.signal,
    prompt_input_command: {
      program: sandboxBinary,
      argv: sandboxedPromptInputArgs,
      codex_program: codexBinary,
      codex_argv: promptInputArgs,
      cwd: caseRoot,
      environment_policy: {
        ...launchPlan.command.environment_policy,
        CODEX_HOME: promptCaptureHome ?? codexHome,
      },
    },
    prompt_input_claim:
      "deterministic_pre_inference_reconstruction_not_literal_inference_transport_capture",
    post_executable_identity: postExecutableIdentity,
  };
  await writeExclusive(
    path.join(resultsRoot, "launch-outcome.json"),
    `${JSON.stringify(launchOutcome, null, 2)}\n`,
  );
  if (processResult.code !== 0 || processResult.signal !== null) {
    throw new Error("Codex execution did not exit successfully");
  }
  if (!postAttestation.pass) throw new Error("post-run case attestation failed");
  return launchOutcome;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    values[argv[index]] = argv[index + 1];
  }
  const mapping = {
    arm: "--arm",
    caseId: "--case-id",
    caseRoot: "--case-root",
    resultsRoot: "--results-root",
    codexHome: "--codex-home",
    promptCaptureHome: "--prompt-capture-home",
    codexBinary: "--codex-binary",
    sandboxBinary: "--sandbox-binary",
    attesterPath: "--attester",
    expectedCommitSha1: "--expected-commit-sha1",
    expectedTreeSha1: "--expected-tree-sha1",
    expectedContentTreeSha256: "--expected-content-tree-sha256",
    sourceCommit: "--source-commit",
    model: "--model",
    runId: "--run-id",
    scheduleOrdinal: "--schedule-ordinal",
    repeatIndex: "--repeat-index",
    pairId: "--pair-id",
    pairPosition: "--pair-position",
    scheduleSha256: "--run-schedule-sha256",
  };
  const result = {};
  for (const [key, flag] of Object.entries(mapping)) {
    if (
      !values[flag]
      && !new Set([
        "runId",
        "scheduleOrdinal",
        "repeatIndex",
        "pairId",
        "pairPosition",
        "scheduleSha256",
        "promptCaptureHome",
      ]).has(key)
    ) {
      throw new Error(`Missing required argument: ${flag}`);
    }
    result[key] = values[flag];
  }
  for (const key of ["scheduleOrdinal", "repeatIndex", "pairPosition"]) {
    if (result[key] !== undefined) result[key] = Number.parseInt(result[key], 10);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCodexAgentWorkflowCase(parseArgs(process.argv.slice(2)));
}
