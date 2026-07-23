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
export const CODEX_ENVIRONMENT_NAMES = [
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
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
  await fs.writeFile(filename, value, { flag: "wx", mode: 0o600 });
}

async function runCaptured(program, args, {
  cwd,
  env,
  stdin = null,
  stdoutPath,
  stderrPath,
}) {
  const stdout = await fs.open(stdoutPath, "wx", 0o600);
  const stderr = await fs.open(stderrPath, "wx", 0o600);
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
    return await completion;
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
    codexBinary,
    sandboxBinary,
    attesterPath,
    expectedCommitSha1,
    expectedTreeSha1,
    expectedContentTreeSha256,
    sourceCommit,
    model,
  } = options;
  if (!ALLOWED_ARMS.has(arm)) throw new Error("unsupported explicit Codex arm");
  if (!/^[a-z0-9-]+$/.test(caseId)) throw new Error("caseId is invalid");
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
  if (pathInside(caseRoot, resultsRoot) || pathInside(resultsRoot, caseRoot)) {
    throw new Error("resultsRoot and caseRoot must not contain each other");
  }
  for (const [left, right] of [
    [caseRoot, codexHome],
    [codexHome, caseRoot],
    [resultsRoot, codexHome],
    [codexHome, resultsRoot],
  ]) {
    if (pathInside(left, right)) {
      throw new Error("caseRoot, resultsRoot, and codexHome must be disjoint");
    }
  }
  if (
    pathInside(caseRoot, attesterPath)
    || pathInside(resultsRoot, attesterPath)
    || pathInside(codexHome, attesterPath)
  ) {
    throw new Error("attesterPath must be operator-owned outside run roots");
  }
  if (
    pathInside(caseRoot, sandboxBinary)
    || pathInside(resultsRoot, sandboxBinary)
    || pathInside(codexHome, sandboxBinary)
  ) {
    throw new Error("sandboxBinary must remain outside run roots");
  }
  if ((await exactDirectoryEntries(codexHome)).join("\0") !== "auth.json") {
    throw new Error("codexHome must initially contain only auth.json");
  }
  if (
    await fs.realpath(caseRoot) !== caseRoot
    || await fs.realpath(codexHome) !== codexHome
  ) {
    throw new Error("caseRoot and codexHome must use canonical paths");
  }
  const authStat = await fs.lstat(path.join(codexHome, "auth.json"));
  if (!authStat.isFile() || authStat.isSymbolicLink() || (authStat.mode & 0o077) !== 0) {
    throw new Error("auth.json must be a private regular file");
  }

  await fs.mkdir(resultsRoot, { mode: 0o700 });
  const runtimeTemporaryRoot = path.join(codexHome, "tmp");
  await fs.mkdir(runtimeTemporaryRoot, { mode: 0o700 });
  const environment = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
    LANG: "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    TMPDIR: runtimeTemporaryRoot,
    ...SYNTHETIC_GIT_ENV,
    CODEX_HOME: codexHome,
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
  const preAttestation = await attester.attestAgentWorkflowArm(attestationArgs);
  await writeExclusive(
    path.join(resultsRoot, "pre-run-attestation.json"),
    `${JSON.stringify(preAttestation, null, 2)}\n`,
  );
  if (!preAttestation.pass) throw new Error("pre-run case attestation failed");

  const { stdout: codexVersion } = await execFileAsync(
    codexBinary,
    ["--version"],
    { encoding: "utf8", env: environment },
  );
  const responsePath = path.join(resultsRoot, "response.json");
  const deniedUserHome = os.userInfo().homedir;
  const sandboxProfile = codexSandboxProfile(deniedUserHome);
  const codexArgs = codexExecArgs({ model, responsePath });
  const execArgs = sandboxedCodexArgs({
    sandboxProfile,
    codexBinary,
    codexArgs,
  });
  const launchPlan = {
    schema_version: "pdf-tools.agent-workflow-launch-plan.v1",
    arm,
    case_id: caseId,
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
    model,
    case_root: caseRoot,
    results_root: resultsRoot,
    codex_home: codexHome,
    codex_home_initial_entries: ["auth.json"],
    prompt_sha256: sha256(prompt),
    response_schema_sha256: sha256(responseSchema),
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
  await writeExclusive(
    path.join(resultsRoot, "launch-plan.json"),
    `${JSON.stringify(launchPlan, null, 2)}\n`,
  );

  const startedAt = new Date().toISOString();
  const processResult = await runCaptured(sandboxBinary, execArgs, {
    cwd: caseRoot,
    env: environment,
    stdin: prompt,
    stdoutPath: path.join(resultsRoot, "events.jsonl"),
    stderrPath: path.join(resultsRoot, "stderr.txt"),
  });
  const finishedAt = new Date().toISOString();
  const postAttestation = await attester.attestAgentWorkflowArm(attestationArgs);
  await writeExclusive(
    path.join(resultsRoot, "post-run-attestation.json"),
    `${JSON.stringify(postAttestation, null, 2)}\n`,
  );

  const promptInputArgs = codexPromptInputArgs(prompt);
  const sandboxedPromptInputArgs = sandboxedCodexArgs({
    sandboxProfile,
    codexBinary,
    codexArgs: promptInputArgs,
  });
  const promptInputResult = await runCaptured(sandboxBinary, sandboxedPromptInputArgs, {
    cwd: caseRoot,
    env: environment,
    stdoutPath: path.join(resultsRoot, "prompt-input.json"),
    stderrPath: path.join(resultsRoot, "prompt-input.stderr.txt"),
  });
  const launchOutcome = {
    schema_version: "pdf-tools.agent-workflow-launch-outcome.v1",
    started_at: startedAt,
    finished_at: finishedAt,
    process_exit_code: processResult.code,
    process_signal: processResult.signal,
    post_attestation_pass: postAttestation.pass,
    prompt_input_exit_code: promptInputResult.code,
    prompt_input_signal: promptInputResult.signal,
    prompt_input_command: {
      program: sandboxBinary,
      argv: sandboxedPromptInputArgs,
      codex_program: codexBinary,
      codex_argv: promptInputArgs,
      cwd: caseRoot,
      environment_policy: launchPlan.command.environment_policy,
    },
  };
  await writeExclusive(
    path.join(resultsRoot, "launch-outcome.json"),
    `${JSON.stringify(launchOutcome, null, 2)}\n`,
  );
  if (processResult.code !== 0 || processResult.signal !== null) {
    throw new Error("Codex execution did not exit successfully");
  }
  if (!postAttestation.pass) throw new Error("post-run case attestation failed");
  if (promptInputResult.code !== 0 || promptInputResult.signal !== null) {
    throw new Error("Codex prompt-input capture did not exit successfully");
  }
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
    codexBinary: "--codex-binary",
    sandboxBinary: "--sandbox-binary",
    attesterPath: "--attester",
    expectedCommitSha1: "--expected-commit-sha1",
    expectedTreeSha1: "--expected-tree-sha1",
    expectedContentTreeSha256: "--expected-content-tree-sha256",
    sourceCommit: "--source-commit",
    model: "--model",
  };
  const result = {};
  for (const [key, flag] of Object.entries(mapping)) {
    if (!values[flag]) throw new Error(`Missing required argument: ${flag}`);
    result[key] = values[flag];
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCodexAgentWorkflowCase(parseArgs(process.argv.slice(2)));
}
