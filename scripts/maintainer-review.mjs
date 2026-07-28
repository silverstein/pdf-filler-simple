#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(REPO_ROOT, "config", "maintainer-review.v1.json");
const REPORT_SCHEMA_PATH = path.join(REPO_ROOT, "schemas", "maintainer-review-report.v1.schema.json");
const RELEASE_SCHEMA_PATH = path.join(REPO_ROOT, "schemas", "maintainer-release-evidence-input.v1.schema.json");
const RELEASE_RECEIPT_SCHEMA_PATH = path.join(REPO_ROOT, "schemas", "maintainer-release-receipt.v1.schema.json");
const ALLOWED_REMOTE_HOSTS = new Set(["api.github.com", "registry.npmjs.org"]);
const ACTIVE_BEAD_STATUSES = new Set(["open", "in_progress", "blocked", "deferred"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SAFE_REF_PATTERN = /^(?!-)[A-Za-z0-9][A-Za-z0-9._/@{}^~:+-]{0,198}$/;
const REVIEW_KEY_LABEL_PATTERN = /^review-key:([0-9a-f]{64})$/;
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;
const TOKEN_LIKE_PATTERN = /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[opsu]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|Bearer\s+[A-Za-z0-9._~-]{16,}|sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|AKIA[0-9A-Z]{16})\b/gi;
const URL_CREDENTIAL_PATTERN = /\b(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi;
const ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'=(])(?:\/(?:Users|Volumes|home|private|var|tmp|opt|etc|root|mnt)\/[^\s,;:)"']+|~\/[^\s,;:)"']+|[A-Za-z]:\\[^\s,;:)"']+)(?:\s+(?![/~]|https?:|[A-Za-z]:\\)[^\s,;:)"']+[/\\][^\s,;:)"']*)*/gi;
const SAFE_CHILD_ENV_KEYS = [
  "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
];

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function valueSha256(value) {
  return sha256(Buffer.from(canonicalJson(value)));
}

function sanitizeText(value, maximum = 500) {
  return String(value)
    .replace(ANSI_PATTERN, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(TOKEN_LIKE_PATTERN, "[redacted-token]")
    .replace(URL_CREDENTIAL_PATTERN, "$1[redacted-credentials]@")
    .replace(ABSOLUTE_PATH_PATTERN, " [redacted-path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function boundedError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeText(message, 500) || "Unknown error";
}

function assertPositiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`);
  }
}

function validateOfficialUrl(urlString, expectedBasePath = null) {
  const url = new URL(urlString);
  if (url.protocol !== "https:" || !ALLOWED_REMOTE_HOSTS.has(url.hostname) || url.username || url.password || url.hash) {
    throw new Error("Remote URL is outside the official allowlist");
  }
  if (expectedBasePath && !url.pathname.startsWith(expectedBasePath)) throw new Error("Remote URL path is outside the configured endpoint");
  return url;
}

function validateCommand(command, kind) {
  if (!Array.isArray(command) || command.length < 2 || command.length > 30) throw new Error(`${kind} must be a bounded argument array`);
  if (command.some(argument => typeof argument !== "string" || !argument || argument.length > 500 || argument.includes("\0"))) {
    throw new Error(`${kind} contains an invalid argument`);
  }
  const executable = command[0];
  if (kind === "evaluation.contract_command" && executable !== "node_modules/.bin/vitest") {
    throw new Error("Contract health must use the repository-pinned Vitest binary");
  }
  if (kind === "evaluation.score_command" && (executable !== "node" || command[1] !== "scripts/eval-run.mjs")) {
    throw new Error("Product score must use the allowlisted structured evaluator");
  }
  if (kind === "evaluation.score_command"
    && (command.length !== 4 || command[2] !== "--partition" || !SAFE_ID_PATTERN.test(command[3]))) {
    throw new Error("Product score must declare exactly one safe fixture partition");
  }
  if (path.isAbsolute(executable) || executable.split(/[\\/]/).includes("..")) throw new Error(`${kind} executable is unsafe`);
}

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Maintainer review config must be an object");
  if (config.config_id !== "oda-pdf-tools.maintainer-review.v1") throw new Error("Unexpected maintainer review config_id");
  for (const key of [
    "command_timeout_ms", "evaluation_timeout_ms", "max_command_output_bytes",
    "remote_timeout_ms", "max_remote_bytes", "max_aggregate_remote_bytes",
    "max_previous_report_bytes", "max_release_evidence_bytes", "max_candidate_bytes",
    "max_receipt_bytes", "max_aggregate_receipt_bytes", "max_github_pages", "max_total_runtime_ms",
  ]) {
    assertPositiveInteger(config.limits?.[key], `limits.${key}`, 1_000_000_000);
  }
  if (config.limits.max_remote_bytes > config.limits.max_aggregate_remote_bytes) {
    throw new Error("Per-source remote limit exceeds aggregate remote limit");
  }
  if (config.limits.max_receipt_bytes > config.limits.max_aggregate_receipt_bytes) {
    throw new Error("Per-receipt limit exceeds aggregate receipt limit");
  }
  if (!Array.isArray(config.remote_sources) || !config.remote_sources.length) throw new Error("remote_sources must be non-empty");
  const sourceIds = new Set();
  for (const source of config.remote_sources) {
    if (!SAFE_ID_PATTERN.test(source?.id || "") || sourceIds.has(source.id)) throw new Error("Remote source ids must be unique safe ids");
    sourceIds.add(source.id);
    if (!["github_releases", "npm_latest"].includes(source.kind)) throw new Error(`Unsupported remote source kind: ${source.kind}`);
    if (typeof source.required !== "boolean") throw new Error(`Remote source required flag is missing: ${source.id}`);
    validateOfficialUrl(source.url);
    if (source.kind === "npm_latest" && (typeof source.package !== "string" || !source.package || source.package.length > 200)) {
      throw new Error(`npm_latest source lacks a bounded package name: ${source.id}`);
    }
  }
  validateCommand(config.evaluation?.contract_command, "evaluation.contract_command");
  validateCommand(config.evaluation?.score_command, "evaluation.score_command");
  if (!SAFE_ID_PATTERN.test(config.evaluation?.slice_id || "")) throw new Error("evaluation.slice_id is invalid");
  assertPositiveInteger(config.github?.max_items, "github.max_items", 500);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.github?.repository || "")) throw new Error("github.repository is invalid");
  for (const key of ["issues_url", "pulls_url"]) {
    const url = validateOfficialUrl(config.github?.[key] || "");
    if (url.hostname !== "api.github.com" || !url.pathname.startsWith(`/repos/${config.github.repository}/`)) {
      throw new Error(`github.${key} is outside the configured repository`);
    }
  }
  if (typeof config.github.discussions_required !== "boolean") throw new Error("github.discussions_required must be boolean");
  if (!Array.isArray(config.release_evidence?.required_receipt_kinds) || !config.release_evidence.required_receipt_kinds.length) {
    throw new Error("release_evidence.required_receipt_kinds must be non-empty");
  }
  if (new Set(config.release_evidence.required_receipt_kinds).size !== config.release_evidence.required_receipt_kinds.length) {
    throw new Error("release evidence receipt kinds must be unique");
  }
  if (!Array.isArray(config.human_gates) || !config.human_gates.length) throw new Error("human_gates must be non-empty");
  const gateIds = new Set();
  for (const gate of config.human_gates) {
    if (!SAFE_ID_PATTERN.test(gate?.id || "") || gateIds.has(gate.id) || gate.state !== "standing") throw new Error("human_gates contains an invalid entry");
    if (typeof gate.description !== "string" || !gate.description || gate.description.length > 500) throw new Error("human gate description is invalid");
    gateIds.add(gate.id);
  }
  return config;
}

async function readStableRegularFile(filename, maxBytes) {
  const resolved = path.resolve(filename);
  const before = await fs.lstat(resolved);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error(`Refusing unbounded or non-regular input: ${path.basename(resolved)}`);
  const bytes = await fs.readFile(resolved);
  const after = await fs.lstat(resolved);
  if (!after.isFile() || after.isSymbolicLink()
    || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
    throw new Error(`Input changed while being read: ${path.basename(resolved)}`);
  }
  return {
    bytes,
    sha256: sha256(bytes),
    size: bytes.length,
    identity: { dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs },
  };
}

function childEnvironment(base = process.env) {
  const environment = {};
  for (const key of SAFE_CHILD_ENV_KEYS) {
    if (typeof base[key] === "string") environment[key] = base[key];
  }
  environment.CI = "1";
  environment.FORCE_COLOR = "0";
  environment.NO_COLOR = "1";
  return environment;
}

function terminateChild(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may already have exited.
    }
  }
}

export function runCommandBounded(executable, args, {
  cwd = REPO_ROOT,
  timeoutMs = 30_000,
  maxOutputBytes = 1_048_576,
  environment = childEnvironment(),
  now = () => performance.now(),
} = {}) {
  return new Promise(resolve => {
    const started = now();
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let spawnError = null;
    let forceTimer = null;
    let timer = null;
    const child = spawn(executable, args, {
      cwd,
      env: environment,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const finish = (exitCode = null, signal = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolve({
        exitCode,
        signal,
        timedOut,
        outputLimitExceeded,
        durationMs: Math.max(0, Math.round(now() - started)),
        stdout,
        stderr,
        error: spawnError,
      });
    };
    const append = (current, chunk) => {
      const next = Buffer.concat([current, Buffer.from(chunk)]);
      if (next.length > maxOutputBytes) {
        outputLimitExceeded = true;
        terminateChild(child, "SIGTERM");
        return next.subarray(next.length - maxOutputBytes);
      }
      return next;
    };
    child.stdout?.on("data", chunk => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", chunk => {
      stderr = append(stderr, chunk);
    });
    child.on("error", error => {
      spawnError = boundedError(error);
      finish();
    });
    child.on("close", finish);
    timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child, "SIGTERM");
      forceTimer = setTimeout(() => terminateChild(child, "SIGKILL"), 1000);
      forceTimer.unref();
    }, timeoutMs);
    timer.unref();
  });
}

export function fetchOfficialJson(urlString, {
  timeoutMs = 12_000,
  maxBytes = 1_048_576,
  expectedBasePath = null,
} = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = validateOfficialUrl(urlString, expectedBasePath);
    } catch (error) {
      reject(error);
      return;
    }
    const request = https.get(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Open-Document-Alliance-PDF-Tools-maintainer-review/1",
      },
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Official API returned HTTP ${response.statusCode}`));
        return;
      }
      const contentType = String(response.headers["content-type"] || "").toLowerCase();
      if (!contentType.includes("json")) {
        response.resume();
        reject(new Error("Official API returned a non-JSON content type"));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy(new Error("Official API response exceeded the byte limit"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        try {
          resolve({ payload: JSON.parse(bytes.toString("utf8")), bytes, sha256: sha256(bytes) });
        } catch {
          reject(new Error("Official API returned malformed JSON"));
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Official API request timed out")));
    request.on("error", reject);
  });
}

function sourceRecord(kind, locator, contentSha256 = null, bytes = null, items = null, truncated = false) {
  return { kind, locator, content_sha256: contentSha256, bytes, items, truncated };
}

function observation(id, area, status, source, publicValue = null, error = null) {
  return { id, area, status, source, public_value: publicValue, error };
}

function safePublicValue(value) {
  const encoded = canonicalJson(value);
  if (Buffer.byteLength(encoded) > 524_288) throw new Error("Normalized public value exceeded its report limit");
  return value;
}

function unwrapFetchResult(result) {
  if (result && typeof result === "object" && Buffer.isBuffer(result.bytes) && Object.hasOwn(result, "payload")) return result;
  const bytes = Buffer.from(JSON.stringify(result));
  return { payload: result, bytes, sha256: sha256(bytes) };
}

function normalizeRemoteValue(source, payload) {
  if (source.kind === "npm_latest") {
    if (!payload || typeof payload.version !== "string") throw new Error("npm latest payload lacks version");
    return safePublicValue({
      package: source.package,
      version: sanitizeText(payload.version, 100),
      integrity: typeof payload.dist?.integrity === "string" ? sanitizeText(payload.dist.integrity, 200) : null,
      deprecated: typeof payload.deprecated === "string" ? sanitizeText(payload.deprecated, 300) : null,
    });
  }
  if (!Array.isArray(payload)) throw new Error("GitHub releases payload is not an array");
  const releases = payload.slice(0, 5).map(release => ({
    tag_name: typeof release.tag_name === "string" ? sanitizeText(release.tag_name, 100) : null,
    prerelease: Boolean(release.prerelease),
    draft: Boolean(release.draft),
    published_at: typeof release.published_at === "string" ? sanitizeText(release.published_at, 100) : null,
  }));
  return safePublicValue({
    latest: releases[0] || null,
    latest_stable: releases.find(release => !release.prerelease && !release.draft) || null,
    releases,
  });
}

async function collectFrontier(config, offline, fetchJson, budget) {
  const observations = [];
  for (const remote of [...config.remote_sources].sort((left, right) => left.id.localeCompare(right.id))) {
    const locator = remote.url;
    if (offline) {
      observations.push(observation(
        remote.id,
        remote.area,
        "skipped",
        sourceRecord("official_api", locator),
        null,
        "Offline mode",
      ));
      continue;
    }
    try {
      const remaining = config.limits.max_aggregate_remote_bytes - budget.bytes;
      if (remaining <= 0) throw new Error("Aggregate remote byte budget exhausted");
      const result = unwrapFetchResult(await fetchJson(locator, {
        timeoutMs: config.limits.remote_timeout_ms,
        maxBytes: Math.min(config.limits.max_remote_bytes, remaining),
      }));
      budget.bytes += result.bytes.length;
      observations.push(observation(
        remote.id,
        remote.area,
        "observed",
        sourceRecord("official_api", locator, result.sha256, result.bytes.length, Array.isArray(result.payload) ? result.payload.length : 1),
        normalizeRemoteValue(remote, result.payload),
      ));
    } catch (error) {
      observations.push(observation(
        remote.id,
        remote.area,
        "unavailable",
        sourceRecord("official_api", locator),
        null,
        boundedError(error),
      ));
    }
  }
  return observations;
}

async function collectGithubPage(baseUrl, page, perPage, maxBytes, config, fetchJson, budget) {
  const url = new URL(baseUrl);
  url.searchParams.set("state", "all");
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));
  const remaining = config.limits.max_aggregate_remote_bytes - budget.bytes;
  if (remaining <= 0) throw new Error("Aggregate remote byte budget exhausted");
  const result = unwrapFetchResult(await fetchJson(url.toString(), {
    timeoutMs: config.limits.remote_timeout_ms,
    maxBytes: Math.min(maxBytes, remaining),
    expectedBasePath: new URL(baseUrl).pathname,
  }));
  budget.bytes += result.bytes.length;
  if (!Array.isArray(result.payload)) throw new Error("GitHub intake payload is not an array");
  return result;
}

async function collectGithubKind(kind, config, offline, fetchJson, budget) {
  const id = kind === "issue" ? "github.issues" : "github.pull-requests";
  const baseUrl = kind === "issue" ? config.github.issues_url : config.github.pulls_url;
  if (offline) {
    return observation(id, "github-intake", "skipped", sourceRecord("official_api", baseUrl), null, "Offline mode");
  }
  try {
    const perPage = kind === "pull-request" ? 20 : 100;
    const items = [];
    const digests = [];
    let bytes = 0;
    let truncated = false;
    for (let page = 1; page <= config.limits.max_github_pages; page += 1) {
      const remainingSourceBytes = config.limits.max_remote_bytes - bytes;
      if (remainingSourceBytes <= 0) {
        truncated = true;
        break;
      }
      const result = await collectGithubPage(
        baseUrl,
        page,
        perPage,
        remainingSourceBytes,
        config,
        fetchJson,
        budget,
      );
      bytes += result.bytes.length;
      digests.push(result.sha256);
      const pageItems = result.payload.filter(item => kind !== "issue" || !item.pull_request);
      for (const item of pageItems) {
        if (items.length >= config.github.max_items) {
          truncated = true;
          break;
        }
        if (!Number.isInteger(item.number) || item.number <= 0) continue;
        items.push({
          number: item.number,
          state: String(item.state || "").toUpperCase(),
          updated_at: typeof item.updated_at === "string" ? sanitizeText(item.updated_at, 100) : null,
          ...(kind === "pull-request" ? { is_draft: Boolean(item.draft) } : {}),
        });
      }
      if (truncated || result.payload.length < perPage) break;
      if (page === config.limits.max_github_pages) truncated = true;
    }
    items.sort((left, right) => left.number - right.number);
    return observation(
      id,
      "github-intake",
      "observed",
      sourceRecord("official_api", baseUrl, sha256(Buffer.from(canonicalJson(digests))), bytes, items.length, truncated),
      safePublicValue(items),
    );
  } catch (error) {
    return observation(id, "github-intake", "unavailable", sourceRecord("official_api", baseUrl), null, boundedError(error));
  }
}

function parseBeadsJsonl(bytes) {
  const issues = [];
  const ids = new Set();
  for (const [index, line] of bytes.toString("utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let issue;
    try {
      issue = JSON.parse(line);
    } catch {
      throw new Error(`Beads JSONL line ${index + 1} is malformed`);
    }
    if (issue?._type && issue._type !== "issue") continue;
    if (typeof issue?.id !== "string" || ids.has(issue.id)) throw new Error(`Beads JSONL line ${index + 1} has a missing or duplicate id`);
    ids.add(issue.id);
    issues.push({
      id: issue.id,
      status: typeof issue.status === "string" ? issue.status : "unknown",
      priority: Number.isInteger(issue.priority) ? issue.priority : null,
      issue_type: typeof issue.issue_type === "string" ? issue.issue_type : null,
      external_ref: typeof issue.external_ref === "string" ? sanitizeText(issue.external_ref, 500) : null,
      dependencies: Array.isArray(issue.dependencies) ? issue.dependencies.map(dependency => ({
        depends_on_id: typeof dependency.depends_on_id === "string" ? dependency.depends_on_id : null,
        type: typeof dependency.type === "string" ? dependency.type : null,
      })).filter(dependency => dependency.depends_on_id && dependency.type) : [],
      review_keys: Array.isArray(issue.labels)
        ? issue.labels.map(label => REVIEW_KEY_LABEL_PATTERN.exec(label)?.[1]).filter(Boolean).sort()
        : [],
    });
  }
  return issues.sort((left, right) => left.id.localeCompare(right.id));
}

function summarizeBeads(issues) {
  const statusCounts = {};
  const priorityCounts = {};
  for (const issue of issues) {
    statusCounts[issue.status] = (statusCounts[issue.status] || 0) + 1;
    const priority = issue.priority === null ? "unknown" : String(issue.priority);
    priorityCounts[priority] = (priorityCounts[priority] || 0) + 1;
  }
  return safePublicValue({
    issue_count: issues.length,
    status_counts: Object.fromEntries(Object.entries(statusCounts).sort()),
    priority_counts: Object.fromEntries(Object.entries(priorityCounts).sort()),
    issues,
  });
}

function normalizeExternalRef(externalRef) {
  if (typeof externalRef !== "string") return null;
  const shorthand = /^gh-(\d+)$/.exec(externalRef);
  if (shorthand) return { key: `issue:${Number(shorthand[1])}`, number: Number(shorthand[1]), kind: "issue" };
  const github = /^https:\/\/github\.com\/Open-Document-Alliance\/PDF-Tools\/(issues|pull|discussions)\/(\d+)(?:[/?#].*)?$/i.exec(externalRef);
  if (!github) return null;
  const type = github[1].toLowerCase();
  const kind = type === "pull" ? "pull-request" : type === "discussions" ? "discussion" : "issue";
  return { key: `${kind}:${Number(github[2])}`, number: Number(github[2]), kind };
}

export function calculateGithubBeadsReconciliation(
  beads,
  githubIssues,
  githubPullRequests,
  { issuesComplete = true, pullRequestsComplete = true } = {},
) {
  if (!Array.isArray(beads) || !Array.isArray(githubIssues) || !Array.isArray(githubPullRequests)) {
    return {
      status: "unavailable",
      untriaged_open_issues: [],
      untriaged_open_pull_requests: [],
      active_beads_linked_to_closed_items: [],
      closed_beads_linked_to_open_items: [],
      beads_linked_to_missing_items: [],
      external_ref_multiplicity: [],
      canonical_review_key_conflicts: [],
    };
  }
  const itemStates = new Map([
    ...githubIssues.map(item => [`issue:${item.number}`, item.state]),
    ...githubPullRequests.map(item => [`pull-request:${item.number}`, item.state]),
  ]);
  const groups = new Map();
  const normalizedGroups = new Map();
  for (const bead of beads) {
    const normalized = normalizeExternalRef(bead.external_ref);
    if (!normalized) continue;
    if (!groups.has(normalized.key)) groups.set(normalized.key, []);
    groups.get(normalized.key).push(bead);
    normalizedGroups.set(normalized.key, normalized);
  }
  const untriagedIssues = githubIssues
    .filter(item => item.state === "OPEN" && !groups.has(`issue:${item.number}`))
    .map(item => item.number)
    .sort((left, right) => left - right);
  const untriagedPulls = githubPullRequests
    .filter(item => item.state === "OPEN" && !groups.has(`pull-request:${item.number}`))
    .map(item => item.number)
    .sort((left, right) => left - right);
  const activeLinkedClosed = [];
  const closedLinkedOpen = [];
  const multiplicity = [];
  const missingItems = [];
  for (const [key, group] of [...groups.entries()].sort()) {
    const state = itemStates.get(key);
    const normalized = normalizedGroups.get(key);
    const active = group.filter(bead => ACTIVE_BEAD_STATUSES.has(bead.status));
    if (state === "CLOSED") activeLinkedClosed.push(...active.map(bead => bead.id));
    if (state === "OPEN" && !active.length) closedLinkedOpen.push(...group.filter(bead => bead.status === "closed").map(bead => bead.id));
    if (active.length > 1) {
      multiplicity.push({
        external_ref: key,
        bead_ids: active.map(bead => bead.id).sort(),
      });
    }
    const collectionComplete = normalized.kind === "issue"
      ? issuesComplete
      : normalized.kind === "pull-request" ? pullRequestsComplete : false;
    if (collectionComplete && !itemStates.has(key)) {
      missingItems.push({
        external_ref: key,
        bead_ids: group.map(bead => bead.id).sort(),
      });
    }
  }
  const reviewKeyGroups = new Map();
  for (const bead of beads.filter(item => ACTIVE_BEAD_STATUSES.has(item.status))) {
    for (const reviewKey of bead.review_keys || []) {
      if (!reviewKeyGroups.has(reviewKey)) reviewKeyGroups.set(reviewKey, []);
      reviewKeyGroups.get(reviewKey).push(bead.id);
    }
  }
  const conflicts = [...reviewKeyGroups.entries()]
    .filter(([, beadIds]) => new Set(beadIds).size > 1)
    .map(([reviewKey, beadIds]) => ({ review_key: reviewKey, bead_ids: [...new Set(beadIds)].sort() }))
    .sort((left, right) => left.review_key.localeCompare(right.review_key));
  const result = {
    status: "aligned",
    untriaged_open_issues: [...new Set(untriagedIssues)],
    untriaged_open_pull_requests: [...new Set(untriagedPulls)],
    active_beads_linked_to_closed_items: [...new Set(activeLinkedClosed)].sort(),
    closed_beads_linked_to_open_items: [...new Set(closedLinkedOpen)].sort(),
    beads_linked_to_missing_items: missingItems,
    external_ref_multiplicity: multiplicity,
    canonical_review_key_conflicts: conflicts,
  };
  if (untriagedIssues.length || untriagedPulls.length || activeLinkedClosed.length
    || closedLinkedOpen.length || missingItems.length || conflicts.length) {
    result.status = "findings";
  }
  return result;
}

function commandReceipt(commandId, classification, result, summary = null, error = null) {
  return {
    classification,
    command_id: commandId,
    exit_code: result?.exitCode ?? null,
    duration_ms: result?.durationMs ?? null,
    stdout_sha256: result ? sha256(result.stdout) : null,
    stdout_bytes: result?.stdout?.length ?? 0,
    stderr_sha256: result ? sha256(result.stderr) : null,
    stderr_bytes: result?.stderr?.length ?? 0,
    summary: safePublicValue(summary),
    error,
  };
}

function commandHarnessError(result, label) {
  if (result.error) return result.error;
  if (result.timedOut) return `${label} timed out`;
  if (result.outputLimitExceeded) return `${label} exceeded the output limit`;
  if (result.signal) return `${label} terminated by signal ${sanitizeText(result.signal, 50)}`;
  if (!Number.isInteger(result.exitCode)) return `${label} did not return an exit code`;
  return null;
}

async function evaluationComparisonKey(scoreCommand) {
  const paths = [
    "scripts/eval-run.mjs",
    "test/eval/fixture-manifest.js",
    "test/eval/scorers.js",
    "test/fixtures/eval/manifest.v1.json",
    "test/fixtures/eval/manifest.schema.json",
    "package-lock.json",
    "node_modules/pdf-lib/package.json",
    "node_modules/pdfjs-dist/package.json",
  ];
  const sources = [];
  let manifest = null;
  let packageLock = null;
  const installedPackages = new Map();
  for (const relativePath of paths) {
    const file = await readStableRegularFile(path.join(REPO_ROOT, relativePath), 8_388_608);
    sources.push({ path: relativePath, sha256: file.sha256, bytes: file.size });
    if (relativePath === "test/fixtures/eval/manifest.v1.json") {
      manifest = JSON.parse(file.bytes.toString("utf8"));
    }
    if (relativePath === "package-lock.json") {
      packageLock = JSON.parse(file.bytes.toString("utf8"));
    }
    const packageName = /^node_modules\/(pdf-lib|pdfjs-dist)\/package\.json$/.exec(relativePath)?.[1];
    if (packageName) {
      const packageJson = JSON.parse(file.bytes.toString("utf8"));
      installedPackages.set(packageName, {
        version: packageJson.version,
        package_sha256: file.sha256,
      });
    }
  }
  const partition = scoreCommand[3];
  if (!manifest || typeof manifest.corpus_version !== "string" || !Array.isArray(manifest.fixtures)) {
    throw new Error("Evaluation manifest has an invalid contract shape");
  }
  const fixtureIds = manifest.fixtures
    .filter(fixture => fixture?.partition === partition)
    .map(fixture => fixture?.id)
    .sort();
  if (!fixtureIds.length || fixtureIds.some(id => typeof id !== "string" || !id)
    || new Set(fixtureIds).size !== fixtureIds.length) {
    throw new Error("Evaluation manifest does not select a unique nonempty fixture set");
  }
  const scorerRuntime = {};
  for (const packageName of ["pdf-lib", "pdfjs-dist"]) {
    const installed = installedPackages.get(packageName);
    const locked = packageLock?.packages?.[`node_modules/${packageName}`];
    if (!installed || typeof installed.version !== "string" || installed.version !== locked?.version) {
      throw new Error(`Installed scorer runtime differs from the lockfile: ${packageName}`);
    }
    scorerRuntime[packageName] = {
      installed_version: installed.version,
      installed_package_sha256: installed.package_sha256,
      locked_version: locked.version,
      locked_integrity: locked.integrity ?? null,
    };
  }
  const contract = {
    command: scoreCommand,
    partition,
    corpus_version: manifest.corpus_version,
    fixture_ids: fixtureIds,
    runtime: {
      node_version: process.version,
      platform: process.platform,
      architecture: process.arch,
      scorer_packages: scorerRuntime,
    },
  };
  return {
    sources,
    contract,
    sha256: valueSha256({ sources, contract }),
  };
}

async function runEvaluations(config, enabled, repoDirty, sourceMatchesCheckout, runCommand, previousReport) {
  if (!enabled || repoDirty || !sourceMatchesCheckout) {
    const reason = !enabled
      ? "Evaluation disabled by CLI option"
      : repoDirty
        ? "Evaluation refused on a dirty source checkout"
        : "Evaluation refused because the requested ref does not match the checked-out source";
    const classification = !enabled ? "skipped" : "unavailable";
    const empty = commandReceipt("contract-health", classification, null, null, reason);
    const score = commandReceipt("product-score", classification, null, null, reason);
    return {
      slice_id: config.evaluation.slice_id,
      contract_health: empty,
      product_score: score,
      score_drift: "not_evaluated",
    };
  }
  const environment = childEnvironment();
  const contractCommand = config.evaluation.contract_command;
  const contractExecutable = path.join(REPO_ROOT, contractCommand[0]);
  const contractResult = await runCommand(contractExecutable, contractCommand.slice(1), {
    cwd: REPO_ROOT,
    timeoutMs: config.limits.evaluation_timeout_ms,
    maxOutputBytes: config.limits.max_command_output_bytes,
    environment,
  });
  const contractHarnessError = commandHarnessError(contractResult, "Contract health slice")
    || (![0, 1].includes(contractResult.exitCode) ? `Contract health slice exited outside its result contract: ${contractResult.exitCode}` : null);
  const contractClassification = contractHarnessError ? "harness_failure" : contractResult.exitCode === 0 ? "pass" : "product_fail";
  const contract = commandReceipt(
    "contract-health",
    contractClassification,
    contractResult,
    { passed: contractClassification === "pass" },
    contractHarnessError,
  );
  const scoreCommand = config.evaluation.score_command;
  const scoreResult = await runCommand(process.execPath, scoreCommand.slice(1), {
    cwd: REPO_ROOT,
    timeoutMs: config.limits.evaluation_timeout_ms,
    maxOutputBytes: config.limits.max_command_output_bytes,
    environment,
  });
  let scoreClassification = "harness_failure";
  let scoreSummary = null;
  let scoreError = commandHarnessError(scoreResult, "Product score slice");
  if (!scoreError) {
    try {
      const parsed = JSON.parse(scoreResult.stdout.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.results) || !parsed.results.length
        || !["number", "string"].includes(typeof parsed.corpus_version)
        || (typeof parsed.corpus_version === "string" && !parsed.corpus_version.trim())
        || typeof parsed.partition !== "string"
        || typeof parsed.passed !== "boolean") {
        throw new Error("Structured evaluator output has an invalid shape");
      }
      const comparison = await evaluationComparisonKey(scoreCommand);
      if (parsed.results.some(item => !item || typeof item !== "object"
        || typeof item.id !== "string" || typeof item.expectation_met !== "boolean")) {
        throw new Error("Structured evaluator output has invalid result records");
      }
      const fixtureIds = parsed.results.map(item => item.id).sort();
      if (new Set(fixtureIds).size !== fixtureIds.length) {
        throw new Error("Structured evaluator output has invalid fixture ids");
      }
      const expectationMet = parsed.results.filter(item => item.expectation_met === true).length;
      if (parsed.partition !== comparison.contract.partition) {
        throw new Error("Structured evaluator output partition differs from the configured partition");
      }
      if (String(parsed.corpus_version) !== String(comparison.contract.corpus_version)) {
        throw new Error("Structured evaluator output corpus version differs from the fixture manifest");
      }
      if (canonicalJson(fixtureIds) !== canonicalJson(comparison.contract.fixture_ids)) {
        throw new Error("Structured evaluator output fixture set differs from the configured partition");
      }
      if (parsed.results.some(item => Object.hasOwn(item, "partition")
        && item.partition !== comparison.contract.partition)) {
        throw new Error("Structured evaluator result partition differs from the configured partition");
      }
      const allExpectationsMet = expectationMet === parsed.results.length;
      if (parsed.passed !== allExpectationsMet) {
        throw new Error("Structured evaluator pass bit disagrees with its result records");
      }
      const expectedExitCode = parsed.passed ? 0 : 1;
      if (scoreResult.exitCode !== expectedExitCode) {
        throw new Error("Structured evaluator exit code disagrees with its pass bit");
      }
      scoreClassification = parsed.passed ? "product_pass" : "product_fail";
      scoreSummary = {
        corpus_version: typeof parsed.corpus_version === "string"
          ? sanitizeText(parsed.corpus_version, 100)
          : parsed.corpus_version,
        partition: comparison.contract.partition,
        case_count: parsed.results.length,
        expectation_met: expectationMet,
        fixture_set_sha256: valueSha256(fixtureIds),
        comparison_key_sha256: comparison.sha256,
        source_count: comparison.sources.length,
      };
      if (![0, 1].includes(scoreResult.exitCode)) throw new Error("Structured evaluator exited outside its product result contract");
    } catch (error) {
      scoreClassification = "harness_failure";
      scoreError = boundedError(error);
      scoreSummary = null;
    }
  }
  const score = commandReceipt("product-score", scoreClassification, scoreResult, scoreSummary, scoreError);
  let scoreDrift = "not_evaluated";
  const previousScore = previousReport?.evaluation?.product_score;
  if (previousScore && scoreSummary && previousScore.summary) {
    if (previousScore.summary.comparison_key_sha256 !== scoreSummary.comparison_key_sha256) {
      scoreDrift = "incomparable_due_to_harness_or_contract_change";
    } else {
      const previousMet = previousScore.summary.expectation_met;
      scoreDrift = scoreSummary.expectation_met === previousMet
        ? "no_change"
        : scoreSummary.expectation_met > previousMet ? "improved" : "regressed";
    }
  }
  return {
    slice_id: config.evaluation.slice_id,
    contract_health: contract,
    product_score: score,
    score_drift: scoreDrift,
  };
}

async function inspectReleaseEvidence(config, options) {
  const supplied = Boolean(options.candidatePath || options.expectedCandidateSha256 || options.releaseEvidencePath);
  const empty = {
    status: "not_supplied",
    evidence_id: null,
    index_sha256: null,
    index_bytes: null,
    candidate_sha256: null,
    candidate_bytes: null,
    source_commit: null,
    missing_receipt_kinds: [...config.release_evidence.required_receipt_kinds].sort(),
    stale_receipt_ids: [],
    failed_receipt_ids: [],
    verified_receipt_count: 0,
    aggregate_receipt_bytes: 0,
    verified_receipts: [],
    known_limitation_count: 0,
    known_limitations: [],
    maintainer_approval_present: false,
    outstanding_human_gates: [],
    error: null,
  };
  if (!supplied) return empty;
  if (!options.candidatePath || !options.expectedCandidateSha256 || !options.releaseEvidencePath) {
    return {
      ...empty,
      status: "harness_failure",
      outstanding_human_gates: ["release"],
      error: "Candidate, expected SHA-256, and release evidence index must be supplied together",
    };
  }
  if (!SHA256_PATTERN.test(options.expectedCandidateSha256)) {
    return {
      ...empty,
      status: "harness_failure",
      outstanding_human_gates: ["release"],
      error: "Expected candidate SHA-256 is invalid",
    };
  }
  try {
    const [candidate, evidenceFile, schemaFile, receiptSchemaFile] = await Promise.all([
      readStableRegularFile(options.candidatePath, config.limits.max_candidate_bytes),
      readStableRegularFile(options.releaseEvidencePath, config.limits.max_release_evidence_bytes),
      readStableRegularFile(RELEASE_SCHEMA_PATH, 1_048_576),
      readStableRegularFile(RELEASE_RECEIPT_SCHEMA_PATH, 1_048_576),
    ]);
    const evidence = JSON.parse(evidenceFile.bytes);
    const schema = JSON.parse(schemaFile.bytes);
    const validation = new AjvJsonSchemaValidator().getValidator(schema)(evidence);
    if (!validation.valid) throw new Error(`Release evidence index failed schema validation: ${validation.errorMessage}`);
    if (new Set(evidence.receipts.map(receipt => receipt.receipt_id)).size !== evidence.receipts.length) {
      throw new Error("Release evidence receipt IDs must be unique");
    }
    const receiptSchema = JSON.parse(receiptSchemaFile.bytes);
    const receiptValidator = new AjvJsonSchemaValidator().getValidator(receiptSchema);
    const evidenceDirectory = await fs.realpath(path.dirname(path.resolve(options.releaseEvidencePath)));
    let aggregateReceiptBytes = 0;
    const verifiedReceipts = [];
    for (const receiptIndex of evidence.receipts) {
      const relativePath = receiptIndex.receipt_path;
      if (typeof relativePath !== "string" || path.posix.isAbsolute(relativePath)
        || relativePath.includes("\\") || relativePath.split("/").some(segment => !segment || segment === "." || segment === "..")) {
        throw new Error(`Release receipt path is unsafe: ${receiptIndex.receipt_id}`);
      }
      let currentDirectory = evidenceDirectory;
      const segments = relativePath.split("/");
      for (const segment of segments.slice(0, -1)) {
        currentDirectory = path.join(currentDirectory, segment);
        const directoryStatus = await fs.lstat(currentDirectory);
        if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
          throw new Error(`Release receipt parent is not a regular directory: ${receiptIndex.receipt_id}`);
        }
      }
      const receiptPath = path.join(currentDirectory, segments.at(-1));
      const receiptFile = await readStableRegularFile(receiptPath, config.limits.max_receipt_bytes);
      aggregateReceiptBytes += receiptFile.size;
      if (aggregateReceiptBytes > config.limits.max_aggregate_receipt_bytes) {
        throw new Error("Release receipts exceed the aggregate byte limit");
      }
      if (receiptFile.sha256 !== receiptIndex.receipt_sha256) {
        throw new Error(`Release receipt byte hash differs from the index: ${receiptIndex.receipt_id}`);
      }
      const receipt = JSON.parse(receiptFile.bytes.toString("utf8"));
      const receiptValidation = receiptValidator(receipt);
      if (!receiptValidation.valid) {
        throw new Error(`Release receipt failed schema validation: ${receiptIndex.receipt_id}`);
      }
      for (const field of [
        "receipt_id", "kind", "status", "artifact_sha256", "source_commit", "evidence_sha256",
      ]) {
        if (receipt[field] !== receiptIndex[field]) {
          throw new Error(`Release receipt identity differs from the index: ${receiptIndex.receipt_id}`);
        }
      }
      verifiedReceipts.push({
        receipt_id: receipt.receipt_id,
        kind: receipt.kind,
        status: receipt.status,
        artifact_sha256: receipt.artifact_sha256,
        source_commit: receipt.source_commit,
        evidence_sha256: receipt.evidence_sha256,
        receipt_sha256: receiptFile.sha256,
        observed_at: receipt.observed_at,
        limitation_count: receipt.limitations.length,
        limitations: receipt.limitations.map(item => sanitizeText(item, 500)).filter(Boolean),
      });
    }
    verifiedReceipts.sort((left, right) => left.receipt_id.localeCompare(right.receipt_id));
    const knownLimitations = evidence.known_limitations
      .map(item => sanitizeText(item, 500))
      .filter(Boolean);
    const hasDeclaredLimitations = evidence.known_limitations.length > 0
      || verifiedReceipts.some(receipt => receipt.limitation_count > 0);
    const missingKinds = config.release_evidence.required_receipt_kinds
      .filter(kind => !evidence.receipts.some(receipt => receipt.kind === kind))
      .sort();
    const staleReceiptIds = evidence.receipts
      .filter(receipt => receipt.artifact_sha256 !== candidate.sha256 || receipt.source_commit !== options.expectedSourceCommit)
      .map(receipt => receipt.receipt_id)
    const inventoryReceipt = evidence.receipts.find(receipt => receipt.kind === "artifact_inventory");
    const sbomReceipt = evidence.receipts.find(receipt => receipt.kind === "sbom_licenses");
    if (inventoryReceipt && inventoryReceipt.evidence_sha256 !== evidence.candidate.inventory_sha256) {
      staleReceiptIds.push(inventoryReceipt.receipt_id);
    }
    if (sbomReceipt && sbomReceipt.evidence_sha256 !== evidence.candidate.sbom_sha256) {
      staleReceiptIds.push(sbomReceipt.receipt_id);
    }
    const staleReceipts = [...new Set(staleReceiptIds)].sort();
    const failedReceipts = evidence.receipts
      .filter(receipt => receipt.status !== "pass")
      .map(receipt => receipt.receipt_id)
      .sort();
    const candidateStale = candidate.sha256 !== options.expectedCandidateSha256
      || candidate.sha256 !== evidence.candidate.sha256
      || evidence.candidate.source_commit !== options.expectedSourceCommit
      || evidence.candidate.package_version !== options.expectedPackageVersion;
    const status = candidateStale || staleReceipts.length
      ? "stale"
      : missingKinds.length || failedReceipts.length
        ? "incomplete"
        : hasDeclaredLimitations
          ? "automated_checks_pass_with_limitations"
          : "automated_checks_pass";
    const hostReceiptIds = evidence.receipts
      .filter(receipt => receipt.kind.startsWith("native_host_"))
      .map(receipt => receipt.receipt_id);
    const hostGateActive = missingKinds.some(kind => kind.startsWith("native_host_"))
      || failedReceipts.some(id => hostReceiptIds.includes(id))
      || staleReceipts.some(id => hostReceiptIds.includes(id));
    return {
      status,
      evidence_id: evidence.evidence_id,
      index_sha256: evidenceFile.sha256,
      index_bytes: evidenceFile.size,
      candidate_sha256: candidate.sha256,
      candidate_bytes: candidate.size,
      source_commit: evidence.candidate.source_commit,
      missing_receipt_kinds: missingKinds,
      stale_receipt_ids: staleReceipts,
      failed_receipt_ids: failedReceipts,
      verified_receipt_count: evidence.receipts.length,
      aggregate_receipt_bytes: aggregateReceiptBytes,
      verified_receipts: verifiedReceipts,
      known_limitation_count: evidence.known_limitations.length,
      known_limitations: knownLimitations,
      maintainer_approval_present: Boolean(evidence.maintainer_approval_ref),
      outstanding_human_gates: hostGateActive ? ["host-access", "release"] : ["release"],
      error: null,
    };
  } catch (error) {
    return {
      ...empty,
      status: "harness_failure",
      outstanding_human_gates: ["release"],
      error: boundedError(error),
    };
  }
}

function factsFromObservations(observations) {
  return observations.map(item => ({
    fact_id: `fact.${item.id}`,
    observation_id: item.id,
    status: item.status,
    value_sha256: valueSha256(item.public_value),
    public_value: item.public_value,
  })).sort((left, right) => left.fact_id.localeCompare(right.fact_id));
}

function changesFromBaseline(facts, previousReport) {
  if (!previousReport) {
    return facts.map(fact => ({
      change_id: `change.${fact.observation_id}`,
      classification: "not_evaluated",
      current_fact_id: fact.fact_id,
      previous_fact_id: null,
    }));
  }
  const previous = new Map((previousReport.facts || []).map(fact => [fact.observation_id, fact]));
  const changes = [];
  for (const fact of facts) {
    const old = previous.get(fact.observation_id);
    if (!old) {
      changes.push({
        change_id: `change.${fact.observation_id}`,
        classification: "added",
        current_fact_id: fact.fact_id,
        previous_fact_id: null,
      });
      continue;
    }
    if (old.status === fact.status && old.value_sha256 === fact.value_sha256) continue;
    let classification = "changed";
    if (old.status !== "observed" && fact.status === "observed") classification = "recovered";
    else if (old.status === "observed" && fact.status !== "observed") classification = "regressed";
    changes.push({
      change_id: `change.${fact.observation_id}`,
      classification,
      current_fact_id: fact.fact_id,
      previous_fact_id: old.fact_id,
    });
  }
  return changes.sort((left, right) => left.change_id.localeCompare(right.change_id));
}

function inference(id, ruleId, severity, statement, observationIds) {
  return {
    id,
    rule_id: ruleId,
    severity,
    statement,
    fact_ids: observationIds.map(observationId => `fact.${observationId}`).sort(),
  };
}

function buildInferences(config, observations, reconciliation, evaluation, releaseEvidence, sourceBinding) {
  const inferences = [];
  const byId = new Map(observations.map(item => [item.id, item]));
  if (sourceBinding.repo_dirty) {
    inferences.push(inference(
      "repository.dirty",
      "source-identity.v1",
      "warning",
      "The source checkout is dirty, so evaluation was refused and source identity is partial.",
      ["local.repository"],
    ));
  }
  if (sourceBinding.source_moved) {
    inferences.push(inference(
      "repository.moved",
      "source-stability.v1",
      "failure",
      "The requested source ref moved during collection; observations do not describe one immutable source state.",
      ["local.repository"],
    ));
  }
  if (!sourceBinding.source_identity_stable) {
    inferences.push(inference(
      "repository.source-identity-moved",
      "source-stability.v1",
      "failure",
      "Local HEAD and the requested source ref did not remain bound to one commit throughout collection.",
      ["local.repository"],
    ));
  }
  if (sourceBinding.working_tree_moved) {
    inferences.push(inference(
      "repository.working-tree-moved",
      "source-stability.v1",
      "failure",
      "The working-tree status changed during collection, so observations may span different source bytes.",
      ["local.repository"],
    ));
  }
  if (!sourceBinding.requested_ref_matches_checkout) {
    inferences.push(inference(
      "repository.ref-mismatch",
      "source-identity.v1",
      "failure",
      "The requested ref does not match the checked-out source, so working-tree files and evaluations cannot be attributed to that ref.",
      ["local.repository"],
    ));
  }
  const versions = byId.get("local.versions")?.public_value;
  if (versions && new Set([versions.package_version, versions.manifest_version, versions.mcpb_manifest_version]).size > 1) {
    inferences.push(inference(
      "release.version-skew",
      "release-version-alignment.v1",
      "failure",
      "Package and extension manifest versions are not aligned.",
      ["local.versions"],
    ));
  }
  const localDependencies = new Map((versions?.dependencies || []).map(dependency => [dependency.name, dependency]));
  for (const source of config.remote_sources.filter(item => item.kind === "npm_latest")) {
    const remote = byId.get(source.id);
    const local = localDependencies.get(source.package);
    if (remote?.status !== "observed" || !local?.resolved || remote.public_value.version === local.resolved) continue;
    const policy = config.dependency_policies?.[source.package];
    const policyText = policy
      ? ` Compatibility is not inferred; ${policy.policy} applies because ${policy.reason}`
      : " Compatibility, safety, host adoption, and quality are not inferred from the latest tag.";
    inferences.push(inference(
      `dependency-drift.${source.id.replace(/^frontier\./, "")}`,
      "dependency-latest-is-not-compatibility.v1",
      "info",
      `${source.package} resolves to ${local.resolved} locally while the official latest tag reports ${remote.public_value.version}.${policyText}`,
      ["local.versions", source.id],
    ));
  }
  if (reconciliation.status === "findings") {
    inferences.push(inference(
      "github-beads.findings",
      "intake-reconciliation.v1",
      "warning",
      "GitHub intake and exported Beads state contain untriaged or lifecycle findings. External-reference multiplicity alone is informational and may represent valid parent/child work.",
      ["local.beads", "github.issues", "github.pull-requests"],
    ));
  }
  if (evaluation.contract_health.classification === "product_fail") {
    inferences.push(inference(
      "evaluation.contract-failure",
      "contract-health.v1",
      "failure",
      "The predeclared lightweight contract/harness integrity slice failed.",
      ["evaluation.contract-health"],
    ));
  }
  if (evaluation.product_score.classification === "product_fail") {
    inferences.push(inference(
      "evaluation.product-failure",
      "development-corpus-score.v1",
      "failure",
      "The structured development-corpus evaluator reported at least one unmet expectation.",
      ["evaluation.product-score"],
    ));
  }
  if (evaluation.score_drift === "regressed") {
    inferences.push(inference(
      "evaluation.score-regression",
      "comparable-score-drift.v1",
      "failure",
      "The comparable structured evaluator score regressed from the supplied previous report.",
      ["evaluation.product-score"],
    ));
  }
  if (releaseEvidence.status === "stale") {
    inferences.push(inference(
      "release-evidence.stale",
      "exact-artifact-binding.v1",
      "failure",
      "At least one release receipt or expected identity is bound to bytes other than the supplied candidate.",
      ["release.evidence"],
    ));
  } else if (releaseEvidence.status === "incomplete") {
    inferences.push(inference(
      "release-evidence.incomplete",
      "release-evidence-completeness.v1",
      "warning",
      "The supplied release evidence is missing, unavailable, or failing one or more required automated receipt kinds.",
      ["release.evidence"],
    ));
  } else if (releaseEvidence.status === "automated_checks_pass_with_limitations") {
    inferences.push(inference(
      "release-evidence.qualified",
      "release-evidence-qualification.v1",
      "warning",
      "Required automated receipts passed, but the evidence index or retained receipts declare limitations that qualify the result.",
      ["release.evidence"],
    ));
  }
  return inferences.sort((left, right) => left.id.localeCompare(right.id));
}

function reviewKey(namespace, value) {
  return sha256(Buffer.from(`${namespace}:${canonicalJson(value)}`));
}

function proposal(proposalId, title, reason, observationIds, requiredAuthority = "control_tower_review", humanGateId = null, existingBeadIds = []) {
  const key = reviewKey(proposalId, { title, reason, observationIds });
  return {
    proposal_id: proposalId,
    review_key: key,
    title,
    reason,
    fact_ids: observationIds.map(id => `fact.${id}`).sort(),
    existing_bead_ids: [...new Set(existingBeadIds)].sort(),
    acceptance_state: "unaccepted",
    required_authority: requiredAuthority,
    human_gate_id: humanGateId,
  };
}

function buildProposals(reconciliation, evaluation) {
  const proposals = [];
  for (const number of reconciliation.untriaged_open_issues) {
    proposals.push(proposal(
      `github-issue-${number}.triage`,
      `Review GitHub issue #${number}`,
      "Open public intake has no explicit exported Bead reference. It is untriaged, not automatically accepted work.",
      ["local.beads", "github.issues"],
    ));
  }
  for (const number of reconciliation.untriaged_open_pull_requests) {
    proposals.push(proposal(
      `github-pr-${number}.triage`,
      `Review pull request #${number}`,
      "Open pull-request intake has no explicit exported Bead reference. It is untriaged, not automatically accepted work.",
      ["local.beads", "github.pull-requests"],
    ));
  }
  for (const conflict of reconciliation.canonical_review_key_conflicts) {
    proposals.push(proposal(
      `review-key-${conflict.review_key.slice(0, 16)}.conflict`,
      "Resolve duplicate canonical review-key ownership",
      `Multiple Beads claim explicit canonical review key ${conflict.review_key}: ${conflict.bead_ids.join(", ")}.`,
      ["local.beads"],
      "control_tower_review",
      null,
      conflict.bead_ids,
    ));
  }
  if (["product_fail", "harness_failure", "unavailable"].includes(evaluation.contract_health.classification)
    || ["product_fail", "harness_failure", "unavailable"].includes(evaluation.product_score.classification)) {
    proposals.push(proposal(
      "evaluation.maintainer-health-investigation",
      "Investigate the recurring maintainer review evaluation slice",
      "At least one predeclared evaluation component did not produce an admissible pass. Preserve product-versus-harness classification.",
      ["evaluation.contract-health", "evaluation.product-score"],
      "control_tower_review",
      null,
      ["pdf-toolkit-mcp-igr.6"],
    ));
  }
  return proposals.sort((left, right) => left.proposal_id.localeCompare(right.proposal_id));
}

function activeHumanGates(config, releaseEvidence) {
  const activeIds = new Set(releaseEvidence.outstanding_human_gates);
  return config.human_gates.map(gate => {
    const active = activeIds.has(gate.id);
    return {
      id: gate.id,
      description: gate.description,
      state: active ? "active" : "standing",
      active_reason: active
        ? gate.id === "release"
          ? "Automated collection never authorizes release publication."
          : "Required exact supported-host evidence is missing or failing for the supplied candidate."
        : null,
      fact_ids: active ? ["fact.release.evidence"] : [],
    };
  });
}

function reportErrors(observations, requiredSkippedIds, sourceBinding, beadsChanged, totalRuntimeExceeded) {
  const requiredSkipped = new Set(requiredSkippedIds);
  const errors = observations
    .filter(item => ["unavailable", "failed"].includes(item.status)
      || (item.status === "skipped" && requiredSkipped.has(item.id)))
    .map(item => ({
      error_id: `source.${item.id}`,
      severity: "warning",
      message: item.error || "Source did not produce an admissible observation",
      fact_ids: [`fact.${item.id}`],
    }));
  if (sourceBinding.source_moved) {
    errors.push({
      error_id: "source.ref-moved",
      severity: "failure",
      message: "Requested source ref changed during collection.",
      fact_ids: ["fact.local.repository"],
    });
  }
  if (!sourceBinding.source_identity_stable) {
    errors.push({
      error_id: "source.identity-moved",
      severity: "failure",
      message: "Local HEAD and requested source ref did not remain bound to one commit.",
      fact_ids: ["fact.local.repository"],
    });
  }
  if (sourceBinding.working_tree_moved) {
    errors.push({
      error_id: "source.working-tree-moved",
      severity: "failure",
      message: "Working-tree status changed during collection.",
      fact_ids: ["fact.local.repository"],
    });
  }
  if (!sourceBinding.requested_ref_matches_checkout) {
    errors.push({
      error_id: "source.ref-checkout-mismatch",
      severity: "failure",
      message: "Requested source ref does not match the checked-out source.",
      fact_ids: ["fact.local.repository"],
    });
  }
  if (beadsChanged) {
    errors.push({
      error_id: "source.beads-moved",
      severity: "failure",
      message: "Exported Beads state changed during collection.",
      fact_ids: ["fact.local.beads"],
    });
  }
  if (totalRuntimeExceeded) {
    errors.push({
      error_id: "bounds.total-runtime",
      severity: "failure",
      message: "Collection exceeded the configured total-runtime limit.",
      fact_ids: ["fact.local.repository"],
    });
  }
  return errors.sort((left, right) => left.error_id.localeCompare(right.error_id));
}

function countSeverities(inferences) {
  return {
    info: inferences.filter(item => item.severity === "info").length,
    warning: inferences.filter(item => item.severity === "warning").length,
    failure: inferences.filter(item => item.severity === "failure").length,
  };
}

async function gitValue(runCommand, args, config) {
  const result = await runCommand("git", ["--no-optional-locks", ...args], {
    cwd: REPO_ROOT,
    timeoutMs: config.limits.command_timeout_ms,
    maxOutputBytes: config.limits.max_command_output_bytes,
    environment: childEnvironment(),
  });
  const harnessError = commandHarnessError(result, "Git inspection");
  if (harnessError || result.exitCode !== 0) throw new Error(harnessError || `Git inspection exited ${result.exitCode}`);
  return result.stdout.toString("utf8").trim();
}

async function loadPreviousReport(filename, config, configSha256, reportSchema) {
  if (!filename) return { report: null, binding: { status: "not_supplied", report_id: null, sha256: null } };
  const file = await readStableRegularFile(filename, config.limits.max_previous_report_bytes);
  const report = JSON.parse(file.bytes);
  const validation = new AjvJsonSchemaValidator().getValidator(reportSchema)(report);
  if (!validation.valid) throw new Error(`Previous report failed schema validation: ${validation.errorMessage}`);
  if (report.source_binding?.config_sha256 !== configSha256) {
    return {
      report: null,
      binding: {
        status: "supplied_incompatible",
        report_id: report.report_id,
        sha256: file.sha256,
      },
    };
  }
  return {
    report,
    binding: {
      status: "supplied_compatible",
      report_id: report.report_id,
      sha256: file.sha256,
    },
  };
}

export async function loadMaintainerReviewConfig() {
  const file = await readStableRegularFile(CONFIG_PATH, 1_048_576);
  return { file, config: validateConfig(JSON.parse(file.bytes)) };
}

function assertReferentialIntegrity(report) {
  const observationIds = new Set(report.observations.map(item => item.id));
  const factIds = new Set(report.facts.map(item => item.fact_id));
  if (observationIds.size !== report.observations.length || factIds.size !== report.facts.length) throw new Error("Report contains duplicate observation or fact ids");
  for (const fact of report.facts) {
    if (!observationIds.has(fact.observation_id)) throw new Error(`Fact references missing observation: ${fact.fact_id}`);
  }
  const references = [
    ...report.inferences.flatMap(item => item.fact_ids),
    ...report.proposed_work.flatMap(item => item.fact_ids),
    ...report.human_gates.flatMap(item => item.fact_ids),
    ...report.errors.flatMap(item => item.fact_ids),
  ];
  if (references.some(id => !factIds.has(id))) throw new Error("Report contains a reference to a missing fact");
  if (report.decisions.length) throw new Error("Unattended collector must not make decisions");
}

export async function runMaintainerReview({
  offline = false,
  evaluationEnabled = true,
  previousReportPath = null,
  requestedRef = "HEAD",
  candidatePath = null,
  expectedCandidateSha256 = null,
  releaseEvidencePath = null,
  generatedAt = new Date().toISOString(),
  runCommand = runCommandBounded,
  fetchJson = fetchOfficialJson,
  now = () => performance.now(),
} = {}) {
  const started = now();
  if (!SAFE_REF_PATTERN.test(requestedRef)) throw new Error("Requested source ref is invalid");
  const [{ file: configFile, config }, reportSchemaFile] = await Promise.all([
    loadMaintainerReviewConfig(),
    readStableRegularFile(REPORT_SCHEMA_PATH, 1_048_576),
  ]);
  const reportSchema = JSON.parse(reportSchemaFile.bytes);
  const { report: previousReport, binding: previousBinding } = await loadPreviousReport(
    previousReportPath,
    config,
    configFile.sha256,
    reportSchema,
  );
  const runtimeReserveMs = config.limits.command_timeout_ms;
  const remainingOperationalRuntimeMs = () => Math.max(
    0,
    config.limits.max_total_runtime_ms - runtimeReserveMs - Math.max(0, now() - started),
  );
  const deadlineFetchJson = async (urlString, options) => {
    const remaining = remainingOperationalRuntimeMs();
    if (remaining <= 0) throw new Error("Total runtime budget exhausted before remote collection");
    return fetchJson(urlString, {
      ...options,
      timeoutMs: Math.max(1, Math.min(options.timeoutMs, Math.floor(remaining))),
    });
  };
  const deadlineRunCommand = async (executable, args, options) => {
    const remaining = remainingOperationalRuntimeMs();
    if (remaining <= 0) {
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        outputLimitExceeded: false,
        durationMs: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        error: "Total runtime budget exhausted before evaluation",
      };
    }
    return runCommand(executable, args, {
      ...options,
      timeoutMs: Math.max(1, Math.min(options.timeoutMs, Math.floor(remaining))),
    });
  };
  const [
    localHead,
    startHead,
    originMaster,
    gitStatus,
    packageFile,
    lockFile,
    manifestFile,
    mcpbManifestFile,
    beadsFile,
    installedVitestFile,
    installedSdkFile,
    installedPdfLibFile,
    installedPdfjsFile,
  ] = await Promise.all([
    gitValue(runCommand, ["rev-parse", "--verify", "HEAD^{commit}"], config),
    gitValue(runCommand, ["rev-parse", "--verify", `${requestedRef}^{commit}`], config),
    gitValue(runCommand, ["rev-parse", "--verify", "origin/master^{commit}"], config),
    gitValue(runCommand, ["status", "--porcelain=v1", "--untracked-files=all"], config),
    readStableRegularFile(path.join(REPO_ROOT, "package.json"), 1_048_576),
    readStableRegularFile(path.join(REPO_ROOT, "package-lock.json"), 8_388_608),
    readStableRegularFile(path.join(REPO_ROOT, "manifest.json"), 1_048_576),
    readStableRegularFile(path.join(REPO_ROOT, "manifest.mcpb.json"), 1_048_576),
    readStableRegularFile(path.join(REPO_ROOT, ".beads", "issues.jsonl"), 8_388_608),
    readStableRegularFile(path.join(REPO_ROOT, "node_modules", "vitest", "package.json"), 1_048_576),
    readStableRegularFile(path.join(REPO_ROOT, "node_modules", "@modelcontextprotocol", "sdk", "package.json"), 1_048_576),
    readStableRegularFile(path.join(REPO_ROOT, "node_modules", "pdf-lib", "package.json"), 1_048_576),
    readStableRegularFile(path.join(REPO_ROOT, "node_modules", "pdfjs-dist", "package.json"), 1_048_576),
  ]);
  for (const [label, digest] of [["local HEAD", localHead], ["requested ref", startHead], ["origin/master", originMaster]]) {
    if (!GIT_OID_PATTERN.test(digest)) throw new Error(`${label} did not resolve to an exact commit`);
  }
  const repoDirty = Boolean(gitStatus);
  const requestedRefMatchesCheckout = localHead === startHead;
  const packageJson = JSON.parse(packageFile.bytes);
  const packageLock = JSON.parse(lockFile.bytes);
  const manifest = JSON.parse(manifestFile.bytes);
  const mcpbManifest = JSON.parse(mcpbManifestFile.bytes);
  const installedVitest = JSON.parse(installedVitestFile.bytes);
  const installedSdk = JSON.parse(installedSdkFile.bytes);
  const installedPdfLib = JSON.parse(installedPdfLibFile.bytes);
  const installedPdfjs = JSON.parse(installedPdfjsFile.bytes);
  const runtimeIdentity = {
    node_version: process.version,
    platform: process.platform,
    architecture: process.arch,
    installed_vitest_version: installedVitest.version,
    installed_vitest_package_sha256: installedVitestFile.sha256,
    installed_sdk_version: installedSdk.version,
    installed_sdk_package_sha256: installedSdkFile.sha256,
    installed_pdf_lib_version: installedPdfLib.version,
    installed_pdf_lib_package_sha256: installedPdfLibFile.sha256,
    installed_pdfjs_version: installedPdfjs.version,
    installed_pdfjs_package_sha256: installedPdfjsFile.sha256,
  };
  const beads = parseBeadsJsonl(beadsFile.bytes);
  const dependencies = [...new Set([
    ...Object.keys(packageJson.dependencies || {}),
    ...Object.keys(packageJson.devDependencies || {}),
  ])].sort().map(name => {
    const locked = packageLock.packages?.[`node_modules/${name}`] || {};
    return {
      name,
      declared: packageJson.dependencies?.[name] ?? packageJson.devDependencies?.[name] ?? null,
      scope: Object.hasOwn(packageJson.dependencies || {}, name) ? "production" : "development",
      resolved: typeof locked.version === "string" ? locked.version : null,
      integrity: typeof locked.integrity === "string" ? locked.integrity : null,
    };
  });
  const observations = [
    observation(
      "local.repository",
      "repository",
      "observed",
      sourceRecord("local_command", "git --no-optional-locks rev-parse/status", valueSha256({ localHead, startHead, originMaster, repoDirty }), null, 4),
      {
        local_head: localHead,
        requested_ref_head: startHead,
        requested_ref_matches_checkout: requestedRefMatchesCheckout,
        origin_master: originMaster,
        dirty: repoDirty,
      },
    ),
    observation(
      "local.versions",
      "release-evidence",
      "observed",
      sourceRecord(
        "local_file",
        "project manifests and installed validator/evaluator package identities",
        valueSha256([
          packageFile.sha256,
          lockFile.sha256,
          manifestFile.sha256,
          mcpbManifestFile.sha256,
          installedVitestFile.sha256,
          installedSdkFile.sha256,
          installedPdfLibFile.sha256,
          installedPdfjsFile.sha256,
          runtimeIdentity,
        ]),
        packageFile.size + lockFile.size + manifestFile.size + mcpbManifestFile.size
          + installedVitestFile.size + installedSdkFile.size
          + installedPdfLibFile.size + installedPdfjsFile.size,
        8,
      ),
      safePublicValue({
        package_version: packageJson.version,
        manifest_version: manifest.version,
        mcpb_manifest_version: mcpbManifest.version,
        runtime: runtimeIdentity,
        dependencies,
      }),
    ),
    observation(
      "local.beads",
      "beads",
      "observed",
      sourceRecord("local_file", ".beads/issues.jsonl", beadsFile.sha256, beadsFile.size, beads.length),
      summarizeBeads(beads),
    ),
  ];
  const budget = { bytes: 0 };
  const githubIssues = await collectGithubKind("issue", config, offline, deadlineFetchJson, budget);
  const githubPulls = await collectGithubKind("pull-request", config, offline, deadlineFetchJson, budget);
  const frontier = await collectFrontier(config, offline, deadlineFetchJson, budget);
  const discussions = observation(
    "github.discussions",
    "github-intake",
    "skipped",
    sourceRecord("official_api", "GitHub discussions query-only collector not configured"),
    null,
    "Discussion intake is outside this v1 REST collection and remains a stated limitation",
  );
  observations.push(githubIssues, githubPulls, discussions, ...frontier);
  const evaluation = await runEvaluations(
    config,
    evaluationEnabled,
    repoDirty,
    requestedRefMatchesCheckout,
    deadlineRunCommand,
    previousReport,
  );
  observations.push(
    observation(
      "evaluation.contract-health",
      "evaluation",
      ["pass", "product_pass", "product_fail"].includes(evaluation.contract_health.classification) ? "observed"
        : evaluation.contract_health.classification === "skipped" ? "skipped" : "failed",
      sourceRecord(
        "derived",
        config.evaluation.slice_id,
        valueSha256(evaluation.contract_health),
        evaluation.contract_health.stdout_bytes + evaluation.contract_health.stderr_bytes,
        1,
        evaluation.contract_health.classification === "harness_failure",
      ),
      {
        classification: evaluation.contract_health.classification,
        exit_code: evaluation.contract_health.exit_code,
        duration_ms: evaluation.contract_health.duration_ms,
      },
      evaluation.contract_health.error,
    ),
    observation(
      "evaluation.product-score",
      "evaluation",
      ["product_pass", "product_fail"].includes(evaluation.product_score.classification) ? "observed"
        : evaluation.product_score.classification === "skipped" ? "skipped" : "failed",
      sourceRecord(
        "derived",
        "scripts/eval-run.mjs",
        valueSha256(evaluation.product_score),
        evaluation.product_score.stdout_bytes + evaluation.product_score.stderr_bytes,
        evaluation.product_score.summary?.case_count ?? null,
        evaluation.product_score.classification === "harness_failure",
      ),
      {
        classification: evaluation.product_score.classification,
        summary: evaluation.product_score.summary,
        score_drift: evaluation.score_drift,
      },
      evaluation.product_score.error,
    ),
  );
  const releaseEvidence = await inspectReleaseEvidence(config, {
    candidatePath,
    expectedCandidateSha256,
    releaseEvidencePath,
    expectedSourceCommit: startHead,
    expectedPackageVersion: packageJson.version,
  });
  observations.push(observation(
    "release.evidence",
    "release-evidence",
    releaseEvidence.status === "harness_failure" ? "failed" : "observed",
    sourceRecord(
      "derived",
      "explicit candidate, evidence index, and retained receipts",
      releaseEvidence.index_sha256 ?? valueSha256(releaseEvidence),
      (releaseEvidence.candidate_bytes ?? 0)
        + (releaseEvidence.index_bytes ?? 0)
        + releaseEvidence.aggregate_receipt_bytes,
      1 + releaseEvidence.verified_receipt_count,
      releaseEvidence.status === "harness_failure",
    ),
    {
      status: releaseEvidence.status,
      evidence_id: releaseEvidence.evidence_id,
      index_sha256: releaseEvidence.index_sha256,
      index_bytes: releaseEvidence.index_bytes,
      candidate_sha256: releaseEvidence.candidate_sha256,
      source_commit: releaseEvidence.source_commit,
      missing_receipt_kinds: releaseEvidence.missing_receipt_kinds,
      stale_receipt_ids: releaseEvidence.stale_receipt_ids,
      failed_receipt_ids: releaseEvidence.failed_receipt_ids,
      verified_receipt_count: releaseEvidence.verified_receipt_count,
      aggregate_receipt_bytes: releaseEvidence.aggregate_receipt_bytes,
      verified_receipts: releaseEvidence.verified_receipts,
      known_limitation_count: releaseEvidence.known_limitation_count,
      known_limitations: releaseEvidence.known_limitations,
      maintainer_approval_present: releaseEvidence.maintainer_approval_present,
    },
    releaseEvidence.error,
  ));
  observations.sort((left, right) => left.id.localeCompare(right.id));
  const reconciliation = calculateGithubBeadsReconciliation(
    beads,
    githubIssues.status === "observed" ? githubIssues.public_value : null,
    githubPulls.status === "observed" ? githubPulls.public_value : null,
    {
      issuesComplete: githubIssues.status === "observed" && !githubIssues.source.truncated,
      pullRequestsComplete: githubPulls.status === "observed" && !githubPulls.source.truncated,
    },
  );
  const [endHead, endLocalHead, endGitStatus, beadsEnd] = await Promise.all([
    gitValue(runCommand, ["rev-parse", "--verify", `${requestedRef}^{commit}`], config),
    gitValue(runCommand, ["rev-parse", "--verify", "HEAD^{commit}"], config),
    gitValue(runCommand, ["status", "--porcelain=v1", "--untracked-files=all"], config),
    readStableRegularFile(path.join(REPO_ROOT, ".beads", "issues.jsonl"), 8_388_608),
  ]);
  const sourceBinding = {
    config_id: config.config_id,
    config_sha256: configFile.sha256,
    requested_ref: requestedRef,
    local_head: localHead,
    end_local_head: endLocalHead,
    start_head: startHead,
    end_head: endHead,
    origin_master: originMaster,
    source_moved: startHead !== endHead,
    local_head_moved: localHead !== endLocalHead,
    source_identity_stable: localHead === endLocalHead
      && localHead === startHead
      && startHead === endHead,
    repo_dirty_end: Boolean(endGitStatus),
    working_tree_moved: gitStatus !== endGitStatus,
    requested_ref_matches_checkout: requestedRefMatchesCheckout,
    repo_dirty: repoDirty,
    beads_sha256: beadsFile.sha256,
    previous_report: previousBinding,
  };
  const beadsChanged = beadsFile.sha256 !== beadsEnd.sha256;
  const elapsed = Math.max(0, Math.round(now() - started));
  const totalRuntimeExceeded = elapsed > config.limits.max_total_runtime_ms;
  const releaseEvidenceSupplied = Boolean(candidatePath || expectedCandidateSha256 || releaseEvidencePath);
  const requiredSourceIds = [
    "local.repository", "local.versions", "local.beads", "github.issues", "github.pull-requests",
    ...config.remote_sources.filter(source => source.required).map(source => source.id),
    "evaluation.contract-health", "evaluation.product-score",
    ...(releaseEvidenceSupplied ? ["release.evidence"] : []),
  ].sort();
  const requiredSet = new Set(requiredSourceIds);
  const unavailableIds = observations.filter(item => requiredSet.has(item.id) && ["unavailable", "failed"].includes(item.status)).map(item => item.id).sort();
  const skippedIds = observations.filter(item => requiredSet.has(item.id) && item.status === "skipped").map(item => item.id).sort();
  const truncatedIds = observations.filter(item => item.source.truncated).map(item => item.id).sort();
  const observedIds = observations.filter(item => item.status === "observed").map(item => item.id).sort();
  const partial = unavailableIds.length > 0 || skippedIds.length > 0 || truncatedIds.length > 0
    || sourceBinding.source_moved || !sourceBinding.source_identity_stable || sourceBinding.working_tree_moved
    || !sourceBinding.requested_ref_matches_checkout
    || beadsChanged || totalRuntimeExceeded;
  const coverage = {
    status: partial ? "partial" : "complete",
    required_source_ids: requiredSourceIds,
    observed_source_ids: observedIds,
    unavailable_source_ids: unavailableIds,
    skipped_source_ids: skippedIds,
    truncated_source_ids: truncatedIds,
    aggregate_remote_bytes: budget.bytes,
    total_duration_ms: elapsed,
  };
  const facts = factsFromObservations(observations);
  const changes = changesFromBaseline(facts, previousReport);
  const inferences = buildInferences(config, observations, reconciliation, evaluation, releaseEvidence, sourceBinding);
  const proposedWork = buildProposals(reconciliation, evaluation);
  const humanGates = activeHumanGates(config, releaseEvidence);
  const errors = reportErrors(
    observations,
    skippedIds,
    sourceBinding,
    beadsChanged,
    totalRuntimeExceeded,
  );
  const limitations = [
    "The collector observes and proposes; it does not accept work, mutate Beads, post externally, build or install artifacts, or authorize a release.",
    "An npm latest tag is a version fact, not evidence of compatibility, safety, host adoption, or state-of-the-art quality.",
    "Direct evaluator or stdio success does not prove packed MCPB, Claude Desktop, Cowork, Codex, ChatGPT, or Windows host behavior.",
    "GitHub Discussions are not collected by the v1 REST intake and require a separately reviewed query-only GraphQL collector.",
    "A missing previous report makes temporal change not evaluated rather than proving no drift.",
  ];
  const inferenceCounts = countSeverities(inferences);
  const completeFindings = inferenceCounts.failure > 0 || inferenceCounts.warning > 0
    || reconciliation.status === "findings" || proposedWork.length > 0 || errors.length > 0;
  const status = partial ? "partial" : completeFindings ? "complete_findings" : "complete_ok";
  const exitCode = partial ? 2 : completeFindings ? 1 : 0;
  const compactTimestamp = generatedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const reportBody = {
    generated_at: generatedAt,
    mode: {
      offline,
      evaluation_enabled: evaluationEnabled,
      previous_report_supplied: Boolean(previousReportPath),
      release_evidence_supplied: releaseEvidenceSupplied,
    },
    source_binding: sourceBinding,
    coverage,
    observations,
    facts,
    changes,
    inferences,
    decisions: [],
    proposed_work: proposedWork,
    github_beads_reconciliation: reconciliation,
    evaluation,
    release_evidence: releaseEvidence,
    human_gates: humanGates,
    limitations,
    errors,
    summary: {
      status,
      fact_count: facts.length,
      change_count: changes.length,
      inference_counts: inferenceCounts,
      proposal_count: proposedWork.length,
      active_human_gate_ids: humanGates.filter(gate => gate.state === "active").map(gate => gate.id).sort(),
      exit_code: exitCode,
    },
  };
  const report = {
    schema_version: 1,
    report_id: `pdf-tools.maintainer-review.v1.${compactTimestamp}.${valueSha256(reportBody).slice(0, 12)}`,
    ...reportBody,
  };
  assertReferentialIntegrity(report);
  const validation = new AjvJsonSchemaValidator().getValidator(reportSchema)(report);
  if (!validation.valid) throw new Error(`Generated maintainer review failed schema validation: ${validation.errorMessage}`);
  return report;
}

function parseCli(argumentsList) {
  const options = {
    offline: false,
    evaluationEnabled: true,
    previousReportPath: null,
    requestedRef: "HEAD",
    candidatePath: null,
    expectedCandidateSha256: null,
    releaseEvidencePath: null,
    compact: false,
  };
  const valueOption = (argument, index) => {
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    return value;
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--offline") options.offline = true;
    else if (argument === "--skip-eval") options.evaluationEnabled = false;
    else if (argument === "--compact") options.compact = true;
    else if (argument === "--previous") {
      options.previousReportPath = valueOption(argument, index);
      index += 1;
    } else if (argument === "--ref") {
      options.requestedRef = valueOption(argument, index);
      index += 1;
    } else if (argument === "--candidate") {
      options.candidatePath = valueOption(argument, index);
      index += 1;
    } else if (argument === "--expected-candidate-sha256") {
      options.expectedCandidateSha256 = valueOption(argument, index);
      index += 1;
    } else if (argument === "--release-evidence") {
      options.releaseEvidencePath = valueOption(argument, index);
      index += 1;
    } else {
      throw new Error(`Unknown maintainer-review option: ${argument}`);
    }
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCli(process.argv.slice(2));
    const report = await runMaintainerReview(options);
    process.stdout.write(options.compact ? `${JSON.stringify(report)}\n` : `${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.summary.exit_code;
  } catch (error) {
    process.stderr.write(`Maintainer review failed: ${boundedError(error)}\n`);
    process.exitCode = 2;
  }
}
