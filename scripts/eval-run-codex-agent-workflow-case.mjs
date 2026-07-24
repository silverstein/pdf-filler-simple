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
const DEFAULT_NON_CAMPAIGN_TIMEOUT_MS = 120_000;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const MAX_PROCESS_TIMEOUT_MS = 15 * 60_000;
const MAX_TERMINATION_GRACE_MS = 30_000;
export const PRIVATE_CREATION_UMASK = 0o077;
export const PRIVATE_EVIDENCE_MODE = 0o600;
export const RUNNER_API_VERSION = "pdf-tools.agent-workflow-runner.r13-v1";
let runnerInvocationActive = false;
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

export function codexBaseContextArgs() {
  return [
    "debug",
    "prompt-input",
    ...featureDenyArgs(),
    "--",
  ];
}

function sandboxString(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function seatbeltSubpathRule(action, operations, root) {
  return `(${action} ${operations} (subpath ${sandboxString(root)}))`;
}

export function codexSandboxProfile(configuration) {
  if (typeof configuration === "string") {
    return [
      "(version 1)",
      "(allow default)",
      seatbeltSubpathRule("deny", "file-read*", configuration),
      seatbeltSubpathRule("deny", "file-write*", configuration),
    ].join("\n");
  }
  const {
    broadDeniedRoots,
    allowedRoots,
    protectedDeniedRoots,
  } = configuration ?? {};
  for (const [label, roots] of Object.entries({
    broadDeniedRoots,
    allowedRoots,
    protectedDeniedRoots,
  })) {
    if (
      !Array.isArray(roots)
      || roots.some(root => typeof root !== "string" || !path.isAbsolute(root))
      || new Set(roots).size !== roots.length
    ) {
      throw new Error(`${label} must contain unique absolute paths`);
    }
  }
  return [
    "(version 1)",
    "(allow default)",
    ...broadDeniedRoots.flatMap(root => [
      seatbeltSubpathRule("deny", "file-read*", root),
      seatbeltSubpathRule("deny", "file-write*", root),
    ]),
    ...allowedRoots.flatMap(root => [
      seatbeltSubpathRule("allow", "file-read*", root),
      seatbeltSubpathRule("allow", "file-write*", root),
    ]),
    ...protectedDeniedRoots.flatMap(root => [
      seatbeltSubpathRule("deny", "file-read*", root),
      seatbeltSubpathRule("deny", "file-write*", root),
    ]),
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
    return await artifactRecordFromHandle(handle, { filename });
  } finally {
    await handle.close();
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.ctimeMs === right.ctimeMs
    && left.mtimeMs === right.mtimeMs;
}

export async function artifactRecordFromHandle(handle, {
  filename = null,
  requirePrivate = true,
  requireSingleLink = true,
} = {}) {
  const stat = await handle.stat();
  if (filename !== null) {
    const initialPathStat = await fs.lstat(filename);
    if (
      initialPathStat.isSymbolicLink()
      || !initialPathStat.isFile()
      || !sameFileIdentity(stat, initialPathStat)
    ) {
      throw new Error("evidence path identity differs from the opened handle");
    }
  }
  if (
    !stat.isFile()
    || (requireSingleLink && stat.nlink !== 1)
    || (requirePrivate && (stat.mode & 0o777) !== PRIVATE_EVIDENCE_MODE)
  ) {
    throw new Error(
      "evidence artifact must be a mode-0600 single-link regular file",
    );
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
  const finalStat = await handle.stat();
  if (!sameFileIdentity(stat, finalStat)) {
    throw new Error("evidence artifact changed while being hashed");
  }
  let symbolicLink = false;
  if (filename !== null) {
    const pathStat = await fs.lstat(filename);
    symbolicLink = pathStat.isSymbolicLink();
    if (
      symbolicLink
      || !pathStat.isFile()
      || !sameFileIdentity(finalStat, pathStat)
    ) {
      throw new Error("evidence path identity differs from the opened handle");
    }
  }
  return {
    bytes: finalStat.size,
    sha256: hash.digest("hex"),
    mode: finalStat.mode & 0o777,
    nlink: finalStat.nlink,
    device: finalStat.dev,
    inode: finalStat.ino,
    ctime_ms: finalStat.ctimeMs,
    mtime_ms: finalStat.mtimeMs,
    file_type: "regular",
    symbolic_link: symbolicLink,
  };
}

export async function inspectPrivateEvidenceFile(filename) {
  const handle = await fs.open(
    filename,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    return await artifactRecordFromHandle(handle, { filename });
  } finally {
    await handle.close();
  }
}

export async function withPrivateRunnerUmask(callback) {
  if (runnerInvocationActive) {
    throw new Error("concurrent workflow runner invocation is forbidden");
  }
  runnerInvocationActive = true;
  let previousUmask;
  try {
    previousUmask = process.umask(PRIVATE_CREATION_UMASK);
    if (process.umask() !== PRIVATE_CREATION_UMASK) {
      throw new Error("workflow runner failed to install private creation umask");
    }
    return await callback();
  } finally {
    try {
      if (previousUmask !== undefined) process.umask(previousUmask);
    } finally {
      runnerInvocationActive = false;
    }
  }
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
        filename: canonicalPath,
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
    return await artifactRecordFromHandle(handle, { filename });
  } finally {
    await handle.close();
  }
}

async function canonicalDirectory(root, label) {
  if (typeof root !== "string" || !path.isAbsolute(root) || root === path.parse(root).root) {
    throw new Error(`${label} must be an absolute non-root directory`);
  }
  const [canonical, stat] = await Promise.all([
    fs.realpath(root),
    fs.lstat(root),
  ]);
  if (
    canonical !== root
    || stat.isSymbolicLink()
    || !stat.isDirectory()
  ) {
    throw new Error(`${label} must be an existing canonical directory`);
  }
  return canonical;
}

function assertPairwiseDisjoint(roots, label) {
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (
        pathInside(roots[left], roots[right])
        || pathInside(roots[right], roots[left])
      ) {
        throw new Error(`${label} must be pairwise disjoint`);
      }
    }
  }
}

function sortSeatbeltRoots(roots) {
  return [...new Set(roots)].sort((left, right) => {
    const depthDifference = left.split(path.sep).length - right.split(path.sep).length;
    if (depthDifference !== 0) return depthDifference;
    return left < right ? -1 : (left > right ? 1 : 0);
  });
}

async function campaignSandboxProfile({
  isolation,
  caseRoot,
  resultsRoot,
  codexHome,
  promptCaptureHome,
}) {
  if (
    !isolation
    || typeof isolation !== "object"
    || Array.isArray(isolation)
  ) {
    throw new Error("held-out runs require an isolation contract");
  }
  if (
    canonicalJson(Object.keys(isolation).sort())
      !== canonicalJson(["denied_roots", "schema_version"])
    || isolation.schema_version
      !== "pdf-tools.agent-workflow-campaign-isolation.v1"
    || !isolation.denied_roots
    || typeof isolation.denied_roots !== "object"
    || Array.isArray(isolation.denied_roots)
  ) {
    throw new Error("isolation has an invalid exact shape or schema version");
  }
  const deniedRoots = isolation.denied_roots;
  const exactDeniedKeys = [
    "additional_sensitive_roots",
    "auth_sensitive_roots",
    "campaign_evidence_control_root",
    "operator_home",
    "receipt_control_roots",
    "sealed_bundle_root",
    "source_repo_root",
  ];
  if (
    canonicalJson(Object.keys(deniedRoots).sort())
      !== canonicalJson(exactDeniedKeys)
    || !Array.isArray(deniedRoots.receipt_control_roots)
    || deniedRoots.receipt_control_roots.length === 0
    || !Array.isArray(deniedRoots.auth_sensitive_roots)
    || deniedRoots.auth_sensitive_roots.length === 0
    || !Array.isArray(deniedRoots.additional_sensitive_roots)
    || new Set(deniedRoots.receipt_control_roots).size
      !== deniedRoots.receipt_control_roots.length
    || new Set(deniedRoots.auth_sensitive_roots).size
      !== deniedRoots.auth_sensitive_roots.length
    || new Set(deniedRoots.additional_sensitive_roots).size
      !== deniedRoots.additional_sensitive_roots.length
  ) {
    throw new Error("isolation.denied_roots has an invalid exact shape");
  }
  const operatorHome = await canonicalDirectory(
    deniedRoots.operator_home,
    "isolation.denied_roots.operator_home",
  );
  const actualOperatorHome = await fs.realpath(os.userInfo().homedir);
  if (operatorHome !== actualOperatorHome) {
    throw new Error("isolation operator_home differs from the operator home");
  }
  const broadDeniedRoots = await Promise.all([
    ["campaign_evidence_control_root", deniedRoots.campaign_evidence_control_root],
    ["sealed_bundle_root", deniedRoots.sealed_bundle_root],
    ["source_repo_root", deniedRoots.source_repo_root],
  ].map(async ([label, root]) =>
    canonicalDirectory(root, `isolation.denied_roots.${label}`)));
  broadDeniedRoots.unshift(operatorHome);
  const protectedDeniedRoots = await Promise.all([
    ...deniedRoots.receipt_control_roots.map((root, index) => [
      `receipt_control_roots[${index}]`,
      root,
    ]),
    ...deniedRoots.auth_sensitive_roots.map((root, index) => [
      `auth_sensitive_roots[${index}]`,
      root,
    ]),
    ...deniedRoots.additional_sensitive_roots.map((root, index) => [
      `additional_sensitive_roots[${index}]`,
      root,
    ]),
  ].map(async ([label, root]) =>
    canonicalDirectory(root, `isolation.denied_roots.${label}`)));
  const allowedRoots = [
    caseRoot,
    resultsRoot,
    codexHome,
    promptCaptureHome,
  ];
  assertPairwiseDisjoint(allowedRoots, "current attempt roots");
  if (!pathInside(deniedRoots.campaign_evidence_control_root, resultsRoot)) {
    throw new Error(
      "resultsRoot must be inside isolation campaign_evidence_control_root",
    );
  }
  for (const broadRoot of [
    operatorHome,
    broadDeniedRoots[2],
    broadDeniedRoots[3],
  ]) {
    for (const allowedRoot of allowedRoots) {
      if (
        pathInside(broadRoot, allowedRoot)
        || pathInside(allowedRoot, broadRoot)
      ) {
        throw new Error(
          "operator, bundle, and source roots must be disjoint from the attempt",
        );
      }
    }
  }
  if (
    new Set(protectedDeniedRoots).size !== protectedDeniedRoots.length
  ) {
    throw new Error("protected denied roots must be unique");
  }
  for (const protectedRoot of protectedDeniedRoots) {
    for (const allowedRoot of allowedRoots) {
      if (
        pathInside(protectedRoot, allowedRoot)
        || pathInside(allowedRoot, protectedRoot)
      ) {
        throw new Error(
          "receipt/control and explicit sensitive roots must be disjoint from the attempt",
        );
      }
    }
  }
  const sortedBroadDeniedRoots = sortSeatbeltRoots(broadDeniedRoots);
  const sortedAllowedRoots = sortSeatbeltRoots(allowedRoots);
  const sortedProtectedDeniedRoots = sortSeatbeltRoots(protectedDeniedRoots);
  return {
    broad_denied_roots: sortedBroadDeniedRoots,
    allowed_roots: sortedAllowedRoots,
    protected_denied_roots: sortedProtectedDeniedRoots,
    profile: codexSandboxProfile({
      broadDeniedRoots: sortedBroadDeniedRoots,
      allowedRoots: sortedAllowedRoots,
      protectedDeniedRoots: sortedProtectedDeniedRoots,
    }),
  };
}

function validateDuration(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be a positive bounded integer`);
  }
  return value;
}

function validateAbortSignal(signal) {
  if (
    signal !== null
    && (
      typeof signal !== "object"
      || typeof signal.aborted !== "boolean"
      || typeof signal.addEventListener !== "function"
      || typeof signal.removeEventListener !== "function"
    )
  ) {
    throw new Error("abortSignal must be an AbortSignal");
  }
}

function resolveLifecycle(lifecycle, heldout) {
  if (lifecycle === null && !heldout) {
    return {
      schema_version: "pdf-tools.agent-workflow-process-lifecycle.v1",
      prompt_input_timeout_ms: DEFAULT_NON_CAMPAIGN_TIMEOUT_MS,
      inference_timeout_ms: DEFAULT_NON_CAMPAIGN_TIMEOUT_MS,
      termination_grace_ms: DEFAULT_TERMINATION_GRACE_MS,
    };
  }
  if (
    !lifecycle
    || typeof lifecycle !== "object"
    || Array.isArray(lifecycle)
    || canonicalJson(Object.keys(lifecycle).sort()) !== canonicalJson([
      "inference_timeout_ms",
      "prompt_input_timeout_ms",
      "schema_version",
      "termination_grace_ms",
    ])
    || lifecycle.schema_version
      !== "pdf-tools.agent-workflow-process-lifecycle.v1"
  ) {
    throw new Error("held-out runs require an exact lifecycle contract");
  }
  validateDuration(
    lifecycle.prompt_input_timeout_ms,
    "lifecycle.prompt_input_timeout_ms",
    MAX_PROCESS_TIMEOUT_MS,
  );
  validateDuration(
    lifecycle.inference_timeout_ms,
    "lifecycle.inference_timeout_ms",
    MAX_PROCESS_TIMEOUT_MS,
  );
  validateDuration(
    lifecycle.termination_grace_ms,
    "lifecycle.termination_grace_ms",
    MAX_TERMINATION_GRACE_MS,
  );
  return lifecycle;
}

function publicProcessResult(result) {
  return {
    pid: result.pid,
    process_group: result.process_group,
    code: result.code,
    process_signal: result.signal,
    spawn_error: result.spawn_error,
    stdin_error: result.stdin_error,
    timed_out: result.timed_out,
    aborted: result.aborted,
    termination_reason: result.termination_reason,
    termination_requested_at: result.termination_requested_at,
    sigterm_attempted: result.sigterm_attempted,
    sigterm_sent: result.sigterm_sent,
    sigkill_attempted: result.sigkill_attempted,
    sigkill_sent: result.sigkill_sent,
    process_group_alive_after_close: result.process_group_alive_after_close,
    process_group_reaped: result.process_group_alive_after_close === null
      ? null
      : result.process_group_alive_after_close === false,
    timeout_ms: result.timeout_ms,
    termination_grace_ms: result.termination_grace_ms,
  };
}

function processFailure(message, result) {
  const error = new Error(message);
  error.code = result.timed_out
    ? "CODEX_PROCESS_TIMEOUT"
    : (result.aborted ? "CODEX_PROCESS_ABORTED" : "CODEX_PROCESS_FAILED");
  error.process_result = publicProcessResult(result);
  return error;
}

export function isCleanProcessResult(result) {
  return result.code === 0
    && result.signal === null
    && result.spawn_error === null
    && result.stdin_error === null
    && result.timed_out === false
    && result.aborted === false
    && result.termination_reason === null
    && result.process_group_alive_after_close !== true;
}

export function validateBaseContextCapture(bytes, {
  forbiddenPrompt,
  caseRoot,
  forbiddenContextMarkers,
}) {
  let capture;
  try {
    capture = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("base-context capture is not valid JSON");
  }
  if (
    !Array.isArray(capture)
    || capture.length !== 4
    || canonicalJson(capture.map(item => item?.role))
      !== canonicalJson(["developer", "developer", "developer", "user"])
  ) {
    throw new Error("base-context capture has an unexpected message sequence");
  }
  if (
    typeof forbiddenPrompt !== "string"
    || forbiddenPrompt.length === 0
    || !Array.isArray(forbiddenContextMarkers)
    || forbiddenContextMarkers.length < 3
    || new Set(forbiddenContextMarkers).size !== forbiddenContextMarkers.length
    || forbiddenContextMarkers.some(marker =>
      typeof marker !== "string"
      || marker.length === 0
      || !forbiddenPrompt.includes(marker))
    || !forbiddenContextMarkers.includes("CASE_BODY_BEGIN")
    || !forbiddenContextMarkers.includes("SKILL_BODY_BEGIN")
  ) {
    throw new Error("held-out base-context markers are incomplete");
  }
  const expectedContentCounts = [2, 1, 1, 1];
  const contentEvidence = [];
  const texts = [];
  for (let itemIndex = 0; itemIndex < capture.length; itemIndex += 1) {
    const item = capture[itemIndex];
    if (
      !item
      || typeof item !== "object"
      || Array.isArray(item)
      || canonicalJson(Object.keys(item).sort())
        !== canonicalJson([
          "content",
          "internal_chat_message_metadata_passthrough",
          "role",
          "type",
        ])
      || item.type !== "message"
      || canonicalJson(item.internal_chat_message_metadata_passthrough)
        !== canonicalJson({ turn_id: "auto-compact-0" })
      || !Array.isArray(item.content)
      || item.content.length !== expectedContentCounts[itemIndex]
    ) {
      throw new Error("base-context capture message shape differs from the pin");
    }
    const itemContent = [];
    for (let contentIndex = 0; contentIndex < item.content.length; contentIndex += 1) {
      const content = item.content[contentIndex];
      if (
        !content
        || typeof content !== "object"
        || Array.isArray(content)
        || canonicalJson(Object.keys(content).sort())
          !== canonicalJson(["text", "type"])
        || content.type !== "input_text"
        || typeof content.text !== "string"
      ) {
        throw new Error("base-context capture content differs from the pin");
      }
      texts.push(content.text);
      itemContent.push({
        ordinal: contentIndex + 1,
        bytes: Buffer.byteLength(content.text),
        sha256: sha256(content.text),
      });
    }
    contentEvidence.push({
      ordinal: itemIndex + 1,
      role: item.role,
      content_count: item.content.length,
      content: itemContent,
    });
  }
  const environmentText = texts.at(-1);
  if (
    !environmentText.trimStart().startsWith("<environment_context>")
    || !environmentText.trimEnd().endsWith("</environment_context>")
    || !environmentText.includes(caseRoot)
    || texts.some(text => text.includes(forbiddenPrompt))
    || texts.slice(0, -1).some(text =>
      forbiddenContextMarkers.some(marker => text.includes(marker)))
  ) {
    throw new Error(
      "base-context capture contains held-out material or an invalid environment",
    );
  }
  const normalizedEnvironment = environmentText.replaceAll(
    caseRoot,
    "$CASE_ROOT",
  );
  return {
    bytes: Buffer.byteLength(bytes),
    sha256: sha256(bytes),
    canonical_sha256: sha256(canonicalJson(capture)),
    item_count: capture.length,
    content_item_count: texts.length,
    ordered_content: contentEvidence,
    environment_context_normalized_sha256: sha256(normalizedEnvironment),
    heldout_prompt_absent: true,
  };
}

function signalProcess(child, processGroup, signal) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) return false;
  try {
    if (processGroup) process.kill(-child.pid, signal);
    else child.kill(signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function processGroupAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function runCaptured(program, args, {
  cwd,
  env,
  stdin = null,
  stdoutPath,
  stderrPath,
  timeoutMs,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  abortSignal = null,
  useProcessGroup = process.platform === "darwin",
}) {
  validateDuration(timeoutMs, "timeoutMs", MAX_PROCESS_TIMEOUT_MS);
  validateDuration(
    terminationGraceMs,
    "terminationGraceMs",
    MAX_TERMINATION_GRACE_MS,
  );
  validateAbortSignal(abortSignal);
  if (abortSignal?.aborted) {
    throw new Error("Codex process aborted before spawn");
  }
  const stdout = await fs.open(stdoutPath, "wx+", 0o600);
  const stderr = await fs.open(stderrPath, "wx+", 0o600);
  try {
    const child = spawn(program, args, {
      cwd,
      env,
      detached: useProcessGroup,
      shell: false,
      stdio: ["pipe", stdout.fd, stderr.fd],
    });
    let spawnError = null;
    let stdinError = null;
    let closed = false;
    let timedOut = false;
    let aborted = false;
    let terminationReason = null;
    let terminationRequestedAt = null;
    let sigtermAttempted = false;
    let sigtermSent = false;
    let sigkillAttempted = false;
    let sigkillSent = false;
    let terminationPromise = null;
    let resolveClose;
    const completion = new Promise(resolve => {
      resolveClose = resolve;
    });
    child.stdin.on("error", error => {
      stdinError = `${error.name}:${error.code ?? "unknown"}`;
    });
    child.once("error", error => {
      spawnError = `${error.name}:${error.code ?? "unknown"}`;
    });
    child.once("close", (code, signal) => {
      if (closed) return;
      closed = true;
      resolveClose({ code, signal });
    });
    const terminate = reason => {
      if (terminationPromise !== null || closed) return terminationPromise;
      terminationReason = reason;
      terminationRequestedAt = new Date().toISOString();
      timedOut = reason === "timeout";
      aborted = reason === "abort";
      terminationPromise = (async () => {
        sigtermAttempted = true;
        sigtermSent = signalProcess(child, useProcessGroup, "SIGTERM");
        await Promise.race([completion, delay(terminationGraceMs)]);
        if (!closed || (useProcessGroup && processGroupAlive(child.pid))) {
          sigkillAttempted = true;
          sigkillSent = signalProcess(child, useProcessGroup, "SIGKILL");
        }
      })();
      return terminationPromise;
    };
    const timeout = setTimeout(() => {
      void terminate("timeout");
    }, timeoutMs);
    timeout.unref?.();
    const abort = () => {
      void terminate("abort");
    };
    abortSignal?.addEventListener("abort", abort, { once: true });
    if (stdin === null) child.stdin.end();
    else child.stdin.end(stdin);
    const result = await completion;
    clearTimeout(timeout);
    abortSignal?.removeEventListener("abort", abort);
    if (terminationPromise !== null) await terminationPromise;
    let processGroupAliveAfterClose = null;
    if (useProcessGroup) {
      processGroupAliveAfterClose = processGroupAlive(child.pid);
      if (processGroupAliveAfterClose) {
        if (terminationReason === null) {
          terminationReason = "process_group_reap";
          terminationRequestedAt = new Date().toISOString();
          sigtermAttempted = true;
          sigtermSent = signalProcess(child, true, "SIGTERM");
          await delay(terminationGraceMs);
          processGroupAliveAfterClose = processGroupAlive(child.pid);
        }
      }
      if (processGroupAliveAfterClose) {
        sigkillAttempted = true;
        sigkillSent = signalProcess(child, true, "SIGKILL") || sigkillSent;
        await delay(Math.min(terminationGraceMs, 100));
        processGroupAliveAfterClose = processGroupAlive(child.pid);
      }
    }
    await Promise.all([stdout.sync(), stderr.sync()]);
    return {
      ...result,
      pid: child.pid ?? null,
      process_group: useProcessGroup ? (child.pid ?? null) : null,
      spawn_error: spawnError,
      stdin_error: stdinError,
      timed_out: timedOut,
      aborted,
      termination_reason: terminationReason,
      termination_requested_at: terminationRequestedAt,
      sigterm_attempted: sigtermAttempted,
      sigterm_sent: sigtermSent,
      sigkill_attempted: sigkillAttempted,
      sigkill_sent: sigkillSent,
      process_group_alive_after_close: processGroupAliveAfterClose,
      timeout_ms: timeoutMs,
      termination_grace_ms: terminationGraceMs,
      stdout_artifact: await artifactRecordFromHandle(stdout, {
        filename: stdoutPath,
      }),
      stderr_artifact: await artifactRecordFromHandle(stderr, {
        filename: stderrPath,
      }),
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

async function runCodexAgentWorkflowCasePrivate(options) {
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
    isolation = null,
    lifecycle = null,
    signal = null,
    forbiddenContextMarkers = null,
  } = options;
  if (!ALLOWED_ARMS.has(arm)) throw new Error("unsupported explicit Codex arm");
  if (!/^[a-z0-9-]+$/.test(caseId)) throw new Error("caseId is invalid");
  const heldout = HELDOUT_ARMS.has(arm);
  const resolvedLifecycle = resolveLifecycle(lifecycle, heldout);
  validateAbortSignal(signal);
  if (heldout) {
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
      || isolation === null
      || !Array.isArray(forbiddenContextMarkers)
      || !forbiddenContextMarkers.includes("CASE_BODY_BEGIN")
      || !forbiddenContextMarkers.includes("SKILL_BODY_BEGIN")
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
  if (await fs.realpath(resultsRoot) !== resultsRoot) {
    throw new Error("resultsRoot must use a canonical path");
  }
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
  const precreatedResponseArtifact = await writeExclusive(
    responsePath,
    Buffer.alloc(0),
  );
  const deniedUserHome = await fs.realpath(os.userInfo().homedir);
  const campaignSandbox = heldout
    ? await campaignSandboxProfile({
      isolation,
      caseRoot,
      resultsRoot,
      codexHome,
      promptCaptureHome,
    })
    : null;
  const sandboxProfile = campaignSandbox?.profile
    ?? codexSandboxProfile(deniedUserHome);
  const sandboxProfileSha256 = sha256(sandboxProfile);
  const isolationSha256 = isolation === null
    ? null
    : sha256(canonicalJson(isolation));
  const lifecyclePolicySha256 = sha256(canonicalJson(resolvedLifecycle));
  const codexArgs = codexExecArgs({ model, responsePath });
  const execArgs = sandboxedCodexArgs({
    sandboxProfile,
    codexBinary,
    codexArgs,
  });
  const promptInputArgs = heldout
    ? codexBaseContextArgs()
    : codexPromptInputArgs(prompt);
  const sandboxedPromptInputArgs = sandboxedCodexArgs({
    sandboxProfile,
    codexBinary,
    codexArgs: promptInputArgs,
  });
  const launchPlan = {
    schema_version: "pdf-tools.agent-workflow-launch-plan.v1",
    runner_api_version: RUNNER_API_VERSION,
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
      private_creation_umask: PRIVATE_CREATION_UMASK,
      response_precreated_mode: PRIVATE_EVIDENCE_MODE,
      denied_user_home: deniedUserHome,
      sandbox_program: sandboxBinary,
      sandbox_profile: sandboxProfile,
      sandbox_profile_sha256: sandboxProfileSha256,
      isolation_sha256: isolationSha256,
      campaign: campaignSandbox === null
        ? null
        : {
          schema_version: isolation.schema_version,
          broad_denied_roots: campaignSandbox.broad_denied_roots,
          allowed_roots: campaignSandbox.allowed_roots,
          protected_denied_roots: campaignSandbox.protected_denied_roots,
          ordered_rule_classes: [
            "broad_deny",
            "current_attempt_allow",
            "protected_deny",
          ],
        },
      environment_names: Object.keys(environment).sort(),
    },
    lifecycle: {
      schema_version: resolvedLifecycle.schema_version,
      prompt_input_timeout_ms: resolvedLifecycle.prompt_input_timeout_ms,
      inference_timeout_ms: resolvedLifecycle.inference_timeout_ms,
      termination_grace_ms: resolvedLifecycle.termination_grace_ms,
      lifecycle_policy_sha256: lifecyclePolicySha256,
      signal_registered: signal !== null,
      darwin_detached_process_group: process.platform === "darwin",
      retry_policy: "none",
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
    pre_inference_artifacts: {
      "response.json": precreatedResponseArtifact,
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
      timeoutMs: resolvedLifecycle.prompt_input_timeout_ms,
      terminationGraceMs: resolvedLifecycle.termination_grace_ms,
      abortSignal: signal,
    },
  );
  const promptInputFinishedAt = new Date().toISOString();
  if (!isCleanProcessResult(promptInputResult)) {
    throw processFailure(
      heldout
        ? "Codex base-context capture did not exit successfully"
        : "Codex prompt-input reconstruction did not exit successfully",
      promptInputResult,
    );
  }
  let baseContextCapture = null;
  if (heldout) {
    const promptInputBytes = await fs.readFile(
      path.join(resultsRoot, "prompt-input.json"),
    );
    baseContextCapture = validateBaseContextCapture(promptInputBytes, {
      forbiddenPrompt: prompt,
      caseRoot,
      forbiddenContextMarkers,
    });
    if (
      baseContextCapture.sha256
        !== promptInputResult.stdout_artifact.sha256
      || baseContextCapture.bytes !== promptInputResult.stdout_artifact.bytes
    ) {
      throw new Error("base-context capture changed after process completion");
    }
  }
  const preAttestation = await attester.attestAgentWorkflowArm(attestationArgs);
  const preAttestationArtifact = await writeExclusive(
    path.join(resultsRoot, "pre-run-attestation.json"),
    `${JSON.stringify(preAttestation, null, 2)}\n`,
  );
  if (!preAttestation.pass) throw new Error("pre-run case attestation failed");
  const preInferenceResponseArtifact = await inspectPrivateEvidenceFile(
    responsePath,
  );
  if (
    canonicalJson(preInferenceResponseArtifact)
      !== canonicalJson(precreatedResponseArtifact)
  ) {
    throw new Error("precreated response.json changed before inference");
  }
  if (typeof onPreInferenceReady === "function") {
    await onPreInferenceReady({
      schema_version: "pdf-tools.agent-workflow-pre-inference-ready.v1",
      runner_api_version: RUNNER_API_VERSION,
      run_id: runId,
      schedule_ordinal: scheduleOrdinal,
      recorded_at: new Date().toISOString(),
      prompt_input_started_at: promptInputStartedAt,
      prompt_input_finished_at: promptInputFinishedAt,
      prompt_input_exit_code: promptInputResult.code,
      prompt_input_signal: promptInputResult.signal,
      prompt_input_process: publicProcessResult(promptInputResult),
      prompt_input_claim: heldout
        ? "validated_base_context_capture_without_user_prompt"
        : "legacy_non_campaign_prompt_reconstruction",
      base_context_capture: baseContextCapture,
      isolation_sha256: isolationSha256,
      lifecycle_policy_sha256: lifecyclePolicySha256,
      sandbox_profile_sha256: sandboxProfileSha256,
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
        timeout_ms: resolvedLifecycle.prompt_input_timeout_ms,
        termination_grace_ms: resolvedLifecycle.termination_grace_ms,
      },
      artifacts: {
        "response.json": preInferenceResponseArtifact,
        "launch-plan.json": launchPlanArtifact,
        "prompt-input.json": promptInputResult.stdout_artifact,
        "prompt-input.stderr.txt": promptInputResult.stderr_artifact,
        "pre-run-attestation.json": preAttestationArtifact,
      },
    });
  }

  const startedAt = new Date().toISOString();
  const launchResponseArtifact = await inspectPrivateEvidenceFile(responsePath);
  if (
    canonicalJson(launchResponseArtifact)
      !== canonicalJson(precreatedResponseArtifact)
  ) {
    throw new Error(
      "precreated response.json changed after pre-inference hook",
    );
  }
  const processResult = await runCaptured(sandboxBinary, execArgs, {
    cwd: caseRoot,
    env: environment,
    stdin: prompt,
    stdoutPath: path.join(resultsRoot, "events.jsonl"),
    stderrPath: path.join(resultsRoot, "stderr.txt"),
    timeoutMs: resolvedLifecycle.inference_timeout_ms,
    terminationGraceMs: resolvedLifecycle.termination_grace_ms,
    abortSignal: signal,
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
    file_type: null,
    symbolic_link: null,
  };
  try {
    const responseHandle = await fs.open(
      responsePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      responseArtifact = {
        present: true,
        ...await artifactRecordFromHandle(responseHandle, {
          filename: responsePath,
        }),
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
      runner_api_version: RUNNER_API_VERSION,
      run_id: runId,
      schedule_ordinal: scheduleOrdinal,
      started_at: startedAt,
      finished_at: finishedAt,
      process_exit_code: processResult.code,
      process_signal: processResult.signal,
      process: publicProcessResult(processResult),
      isolation_sha256: isolationSha256,
      lifecycle_policy_sha256: lifecyclePolicySha256,
      sandbox_profile_sha256: sandboxProfileSha256,
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
    runner_api_version: RUNNER_API_VERSION,
    started_at: startedAt,
    finished_at: finishedAt,
    process_exit_code: processResult.code,
    process_signal: processResult.signal,
    process: publicProcessResult(processResult),
    isolation_sha256: isolationSha256,
    lifecycle_policy_sha256: lifecyclePolicySha256,
    sandbox_profile_sha256: sandboxProfileSha256,
    post_attestation_pass: postAttestation.pass,
    prompt_input_started_at: promptInputStartedAt,
    prompt_input_finished_at: promptInputFinishedAt,
    prompt_input_exit_code: promptInputResult.code,
    prompt_input_signal: promptInputResult.signal,
    prompt_input_process: publicProcessResult(promptInputResult),
    base_context_capture: baseContextCapture,
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
      timeout_ms: resolvedLifecycle.prompt_input_timeout_ms,
      termination_grace_ms: resolvedLifecycle.termination_grace_ms,
    },
    prompt_input_claim: heldout
      ? "validated_base_context_capture_without_user_prompt"
      : "deterministic_pre_inference_reconstruction_not_literal_inference_transport_capture",
    post_executable_identity: postExecutableIdentity,
  };
  await writeExclusive(
    path.join(resultsRoot, "launch-outcome.json"),
    `${JSON.stringify(launchOutcome, null, 2)}\n`,
  );
  if (!isCleanProcessResult(processResult)) {
    throw processFailure("Codex execution did not exit successfully", processResult);
  }
  if (!postAttestation.pass) throw new Error("post-run case attestation failed");
  return launchOutcome;
}

export async function runCodexAgentWorkflowCase(options) {
  return withPrivateRunnerUmask(
    () => runCodexAgentWorkflowCasePrivate(options),
  );
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
