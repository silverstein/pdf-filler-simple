#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { homedir, hostname, platform, arch } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "trajectories", "jobs.v1.json");
const DOCUMENTS_ROOT = path.join(homedir(), "Documents");
const JOB_ID = "pdf-tools.trajectory.v1.compare-and-explain";
const DEFAULT_MODEL = "gpt-5.6-sol";
const DEFAULT_COUNT = 3;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const CAMPAIGN_SCHEMA_VERSION = 1;
const HOST_LIMITATION = "Codex JSONL retains a host-visible image that may be transformed from the original MCP image payload; server-declared geometry and host-visible PNG identity are recorded separately.";
const TRANSPORT_LIMITATION = "Remote model inference transport was predeclared and accounted separately; PDF Tools server network denial and model-visible tool isolation were configuration controls, not an OS-level network namespace.";
const CLAIM_BOUNDARY = `Unsigned descriptive repeated headless Codex CLI trials on public synthetic fixtures. ${HOST_LIMITATION} ${TRANSPORT_LIMITATION} Repeats share one fixture instance and are not independent benchmark evidence; no native Claude Desktop or packed MCPB was tested.`;

const FIXTURES = Object.freeze([{
  role: "before",
  fixture_id: "pdf-tools.eval.v1.dev-page-order-source",
  source: "test/fixtures/eval/synthetic/dev-page-order-source.pdf",
  destination: "input/before.pdf",
  sha256: "bca00ea1e9c27e45c58ace3a80d4df0a56db91c15c0e3d812fe3d22a925b2168",
}, {
  role: "after",
  fixture_id: "pdf-tools.eval.v1.dev-page-order-visibly-wrong",
  source: "test/fixtures/eval/synthetic/dev-page-order-visibly-wrong.pdf",
  destination: "input/after.pdf",
  sha256: "8dcb160b21f450a388de112767ad3a25b026f32bfd8064cfcc85e8825374b7e0",
}]);

const DISABLED_FEATURES = Object.freeze([
  "apps",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "chronicle",
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
  "plugins",
  "remote_plugin",
  "shell_tool",
  "skill_mcp_dependency_install",
  "tool_suggest",
  "unified_exec",
  "workspace_dependencies",
]);

const SOURCE_FINGERPRINT_PATHS = Object.freeze([
  "package.json",
  "server/index.js",
  "server/helpers.js",
  "server/output-schemas.js",
  "server/resource-uri.js",
  "server/stderr-suppression.js",
  "package-lock.json",
  "scripts/eval-run-codex-comparison.mjs",
  "scripts/eval-ingest-codex-trajectory.mjs",
  "scripts/eval-run-trajectories.mjs",
  "test/eval/png-evidence.js",
  "test/eval/trajectory-grader.js",
  "test/fixtures/eval/manifest.v1.json",
  "test/fixtures/eval/trajectories/jobs.v1.json",
  "test/fixtures/eval/trajectories/tool-contracts.v1.json",
  "test/fixtures/eval/trajectories/trust-registry.v1.json",
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

function isoNow(now = new Date()) {
  return now.toISOString();
}

function nodeRuntime() {
  return {
    version: process.version,
    modules: process.versions.modules,
    napi: process.versions.napi,
    v8: process.versions.v8,
  };
}

export function campaignCommitmentSha256(campaign) {
  const payload = Object.fromEntries(Object.entries(campaign)
    .filter(([key]) => key !== "launch_contract_sha256"));
  return sha256(canonicalJson(payload));
}

function runName(repeatIndex) {
  return `repeat-${String(repeatIndex).padStart(2, "0")}`;
}

function normalizeRelative(filename) {
  return filename.split(path.sep).join("/");
}

function exactObjectKeys(value, expected, location) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  const missing = expected.filter(key => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter(key => !expected.includes(key));
  if (missing.length || unknown.length) {
    throw new Error(`${location} keys invalid (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"})`);
  }
}

async function writeJson(filename, value, { exclusive = false } = {}) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (exclusive) {
    await fs.writeFile(filename, text, { flag: "wx", mode: 0o600 });
    return text;
  }
  const temporary = `${filename}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, text, { flag: "wx", mode: 0o600 });
  await fs.rename(temporary, filename);
  return text;
}

async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, "utf8"));
}

async function loadSuite() {
  const suite = await readJson(SUITE_PATH);
  if (suite?.suite_id !== "pdf-tools.trajectory.v1" || !Array.isArray(suite.jobs)) {
    throw new Error("Trajectory suite is missing its pinned ID or jobs array");
  }
  return suite;
}

async function exists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
  }
}

export async function assertCampaignPath(campaignPath, documentsRoot = DOCUMENTS_ROOT, { mayNotExist = false } = {}) {
  const documentsReal = await fs.realpath(documentsRoot);
  const candidate = path.resolve(campaignPath);
  let resolved;
  if (mayNotExist) {
    const parentReal = await fs.realpath(path.dirname(candidate));
    resolved = path.join(parentReal, path.basename(candidate));
  } else {
    resolved = await fs.realpath(candidate);
  }
  const relative = path.relative(documentsReal, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Campaign must be a child of ${documentsReal}`);
  }
  return resolved;
}

async function snapshotEntry(root, absolute, relative) {
  const stat = await fs.lstat(absolute);
  const base = {
    path: normalizeRelative(relative),
    mode: stat.mode & 0o777,
  };
  if (stat.isSymbolicLink()) {
    return { ...base, type: "symlink", target: await fs.readlink(absolute) };
  }
  if (stat.isDirectory()) return { ...base, type: "directory" };
  if (stat.isFile()) {
    const bytes = await fs.readFile(absolute);
    return { ...base, type: "file", size: bytes.length, sha256: sha256(bytes) };
  }
  throw new Error(`Unsupported workspace entry type: ${path.relative(root, absolute)}`);
}

export async function snapshotTree(root) {
  const entries = [];
  async function visit(directory, relativeDirectory = "") {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relative = path.join(relativeDirectory, child.name);
      const absolute = path.join(directory, child.name);
      const entry = await snapshotEntry(root, absolute, relative);
      entries.push(entry);
      if (entry.type === "directory") await visit(absolute, relative);
    }
  }
  await visit(root);
  return {
    manifest_schema_version: 1,
    entries,
    manifest_sha256: sha256(canonicalJson(entries)),
  };
}

export function diffManifests(before, after) {
  const beforeMap = new Map(before.entries.map(entry => [entry.path, entry]));
  const afterMap = new Map(after.entries.map(entry => [entry.path, entry]));
  const created = [...afterMap.keys()].filter(item => !beforeMap.has(item));
  const deleted = [...beforeMap.keys()].filter(item => !afterMap.has(item));
  const modified = [...beforeMap.keys()].filter(item => afterMap.has(item)
    && canonicalJson(beforeMap.get(item)) !== canonicalJson(afterMap.get(item)));
  return {
    created: created.sort(),
    modified: modified.sort(),
    deleted: deleted.sort(),
  };
}

function inputSnapshotFromManifest(manifest) {
  const files = manifest.entries.filter(entry => FIXTURES.some(fixture => fixture.destination === entry.path));
  if (files.length !== FIXTURES.length || files.some(entry => entry.type !== "file")) {
    throw new Error("Workspace manifest does not contain both pinned input PDF files");
  }
  return {
    input_snapshot_schema_version: 1,
    files: files.map(entry => ({ path: entry.path, size: entry.size, sha256: entry.sha256 })),
  };
}

export function fixtureInstanceRecord() {
  return {
    fixture_instance_schema_version: 1,
    fixtures: FIXTURES.map(({ role, fixture_id, destination, sha256: digest }) => ({
      role,
      fixture_id,
      path: destination,
      sha256: digest,
    })),
  };
}

export function buildRunPlan({
  suite,
  job,
  count = DEFAULT_COUNT,
  trialSetId,
  plannedAt,
  fixtureInstanceSha256 = sha256(canonicalJson(fixtureInstanceRecord())),
  claimBoundary = CLAIM_BOUNDARY,
}) {
  if (!Number.isInteger(count) || count < 1) throw new Error("count must be a positive integer");
  if (!job || job.id !== JOB_ID) throw new Error(`Expected trajectory job ${JOB_ID}`);
  const semanticOperationSha256 = sha256(canonicalJson(job.expected_semantics));
  return {
    run_plan_schema_version: 1,
    run_plan_id: `${trialSetId}.run-plan`,
    trial_set_id: trialSetId,
    suite_id: suite.suite_id,
    suite_sha256: sha256(canonicalJson(suite)),
    claim_boundary: claimBoundary,
    planned_at: plannedAt,
    planner: "scripts/eval-run-codex-comparison.mjs",
    attestation: {
      attestation_schema_version: 1,
      kind: "pre_run_plan",
      producer: "scripts/eval-run-codex-comparison.mjs#plan",
      produced_at: plannedAt,
      key_id: null,
      signature: null,
    },
    entries: Array.from({ length: count }, (_, index) => {
      const repeatIndex = index + 1;
      return {
        invocation_id: `${trialSetId}.invocation.${repeatIndex}`,
        job_id: job.id,
        repeat_index: repeatIndex,
        fixture_instance_sha256: fixtureInstanceSha256,
        seed: `${trialSetId}.repeat-${repeatIndex}`,
        semantic_operation_sha256: semanticOperationSha256,
      };
    }),
  };
}

function tomlString(value) {
  return JSON.stringify(value);
}

function tomlInlineStringTable(value) {
  return `{${Object.entries(value).map(([key, item]) => `${key}=${tomlString(item)}`).join(",")}}`;
}

export function buildCodexArgs({ workspace, model = DEFAULT_MODEL, serverPath = path.join(REPO_ROOT, "server", "index.js") }) {
  const serverEnvironment = {
    ALLOWED_DIRECTORIES: workspace,
    DEFAULT_PROFILES_DIR: path.join(workspace, "state"),
    DEFAULT_PDF_DIR: path.join(workspace, "input"),
    DEFAULT_DOWNLOAD_DIR: path.join(workspace, "downloads"),
    TMPDIR: path.join(workspace, "tmp"),
  };
  const args = [
    "-a", "never",
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--skip-git-repo-check",
    "--color", "never",
    "-C", workspace,
    "-s", "read-only",
    "--model", model,
    "-c", "project_doc_max_bytes=0",
    "-c", "include_apps_instructions=false",
    "-c", "include_collaboration_mode_instructions=false",
    "-c", "include_environment_context=false",
    "-c", "web_search=\"disabled\"",
    "-c", "model_reasoning_effort=\"medium\"",
    "-c", "model_reasoning_summary=\"none\"",
    "-c", "model_verbosity=\"low\"",
  ];
  for (const feature of DISABLED_FEATURES) args.push("--disable", feature);
  args.push(
    "-c", "mcp_servers.pdf_tools.command=\"node\"",
    "-c", `mcp_servers.pdf_tools.args=${JSON.stringify([serverPath])}`,
    "-c", `mcp_servers.pdf_tools.cwd=${tomlString(workspace)}`,
    "-c", `mcp_servers.pdf_tools.env=${tomlInlineStringTable(serverEnvironment)}`,
    "-c", `mcp_servers.pdf_tools.enabled_tools=${JSON.stringify(["read_pdf_pages", "render_pdf_page"])}`,
    "-",
  );
  return args;
}

export function buildPrompt(job) {
  const calls = job.expected_semantics.required_calls.map(call =>
    `- ${call.tool} ${JSON.stringify(call.arguments)}`).join("\n");
  return [
    "This is a predeclared, read-only PDF Tools evaluation on public synthetic fixtures.",
    "Use only the pdf_tools MCP server. Do not use shell, file-editing, web, browser, computer-use, sub-agent, app, or any other tools.",
    "Make exactly these four calls; do not make additional calls:",
    calls,
    "After every call completes, return only the JSON requested by the job. Do not include a preamble or Markdown in the terminal answer.",
    job.prompt,
  ].join("\n\n");
}

export class JsonlArrivalCollector {
  constructor() {
    this.pending = "";
    this.arrivals = [];
    this.lineNumber = 0;
  }

  push(chunk, observedAt = isoNow()) {
    this.pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const lines = this.pending.split("\n");
    this.pending = lines.pop();
    return lines.map(line => this.#record(line.replace(/\r$/, ""), observedAt));
  }

  finish(observedAt = isoNow()) {
    if (!this.pending) return [];
    const line = this.pending.replace(/\r$/, "");
    this.pending = "";
    return [this.#record(line, observedAt)];
  }

  #record(line, observedAt) {
    this.lineNumber += 1;
    let event = null;
    let parseError = null;
    try {
      event = JSON.parse(line);
    } catch (error) {
      parseError = error.message;
    }
    const arrival = {
      arrival_schema_version: 1,
      line_number: this.lineNumber,
      observed_at: observedAt,
      line_sha256: sha256(line),
      event,
      parse_error: parseError,
    };
    this.arrivals.push(arrival);
    return arrival;
  }
}

function completedItem(arrival) {
  return arrival.event?.type === "item.completed" ? arrival.event.item : null;
}

function startedItem(arrival) {
  return arrival.event?.type === "item.started" ? arrival.event.item : null;
}

function completedPdfCalls(arrivals) {
  return arrivals.map(completedItem).filter(item => item?.type === "mcp_tool_call" && item.server === "pdf_tools");
}

export function classifyRunOutcome(arrivals) {
  return completedPdfCalls(arrivals).length > 0 ? "completed" : "harness_failure";
}

function successfulCall(item) {
  return item?.status === "completed"
    && (item.error === null || item.error === undefined)
    && item.result?.isError !== true
    && item.result?.is_error !== true;
}

function structuredResult(item) {
  return item.result?.structured_content ?? item.result?.structuredContent ?? {};
}

function exactCall(item, required) {
  return item.tool === required.tool && canonicalJson(item.arguments ?? {}) === canonicalJson(required.arguments);
}

export function buildFinalAnswerAnnotations(job, arrivals) {
  const calls = completedPdfCalls(arrivals).filter(successfulCall);
  const evidence = [];
  for (const observation of job.expected_semantics.required_observations) {
    const required = job.expected_semantics.required_calls.find(call => call.tool === observation.tool
      && call.arguments.pdf_path === observation.value.source
      && Number(call.arguments.page ?? call.arguments.start_page ?? 1) === observation.value.page);
    const call = required && calls.find(item => exactCall(item, required));
    if (!call || typeof call.id !== "string") continue;
    const structured = structuredResult(call);
    if (observation.collection === "pages") {
      const page = structured.pages?.find(item => Number(item.page_number ?? item.page) === observation.value.page);
      if (!page || typeof page.text !== "string") continue;
      evidence.push({
        evidence_schema_version: 1,
        id: `evidence.${observation.id}`,
        kind: "page",
        source: observation.value.source,
        result_item_id: call.id,
        page: observation.value.page,
      });
    } else if (observation.collection === "render_regions") {
      const region = call.tool === "render_pdf_page"
        ? [0, 0, Number(structured.width_points), Number(structured.height_points)]
        : [
          Number(structured.region_points?.x), Number(structured.region_points?.y),
          Number(structured.region_points?.width), Number(structured.region_points?.height),
        ];
      if (region.some(value => !Number.isFinite(value))
        || canonicalJson(region) !== canonicalJson(observation.value.region)) continue;
      evidence.push({
        evidence_schema_version: 1,
        id: `evidence.${observation.id}`,
        kind: "region",
        source: observation.value.source,
        result_item_id: call.id,
        page: observation.value.page,
        region,
      });
    }
  }
  const allRequiredEvidence = evidence.length === job.success_evidence.min_references;
  return {
    evidence,
    claims: allRequiredEvidence ? [{
      claim_schema_version: 1,
      id: "claim.page-one-comparison",
      important: true,
      evidence_ids: evidence.map(item => item.id),
    }] : [],
    limitations: [HOST_LIMITATION, TRANSPORT_LIMITATION],
  };
}

function safeDiagnosticMessage(item) {
  if (typeof item?.message !== "string") return null;
  return {
    item_id: typeof item.id === "string" ? item.id : null,
    type: item.type,
    message_sha256: sha256(item.message),
  };
}

function externalRequests(arrivals) {
  const items = arrivals.flatMap(arrival => [startedItem(arrival), completedItem(arrival)]).filter(item =>
    item?.type === "mcp_tool_call" && item.server === "pdf_tools" && item.tool === "fetch_pdf_from_url");
  return [...new Set(items.map(item => `pdf_tools:fetch_pdf_from_url:${item.id}`))];
}

function eventProvenance(authority, captureMethod, rawSha256) {
  return {
    provenance_schema_version: 1,
    authority,
    capture_method: captureMethod,
    raw_sha256: rawSha256,
  };
}

function hostEvent(eventId, type, source, observedAt, reference, provenance) {
  return {
    event_schema_version: 1,
    event_id: eventId,
    type,
    source,
    observed_at: observedAt,
    reference,
    provenance,
  };
}

function sourceObservationMap({ runId, preObservedAt, preManifest }) {
  const byPath = new Map(preManifest.entries.map(entry => [entry.path, entry]));
  return new Map(FIXTURES.map(fixture => {
    const entry = byPath.get(fixture.destination);
    if (!entry || entry.type !== "file" || entry.sha256 !== fixture.sha256) {
      throw new Error(`Pinned source changed before launch: ${fixture.destination}`);
    }
    const eventId = `${runId}.event.source.${fixture.role}`;
    return [fixture.destination, {
      snapshot: {
        path: fixture.destination,
        exists: true,
        sha256: entry.sha256,
        observer_event_id: eventId,
        observation_method: "filesystem_stat_sha256",
      },
      event: hostEvent(
        eventId,
        "filesystem_source_observed",
        "filesystem_capture",
        preObservedAt,
        `sha256:${entry.sha256}`,
        eventProvenance("filesystem_observer", "filesystem_stat_sha256", sha256(canonicalJson(entry))),
      ),
    }];
  }));
}

function buildCallObservations(arrivals, sourceObservations) {
  const starts = new Map(arrivals.map(arrival => [startedItem(arrival)?.id, arrival]).filter(([id]) => typeof id === "string"));
  const observations = {};
  for (const arrival of arrivals) {
    const item = completedItem(arrival);
    if (item?.type !== "mcp_tool_call" || item.server !== "pdf_tools" || typeof item.id !== "string") continue;
    const started = starts.get(item.id);
    if (!started) continue;
    const source = typeof item.arguments?.pdf_path === "string" ? item.arguments.pdf_path : null;
    const sourceObservation = source ? sourceObservations.get(source) : null;
    observations[item.id] = {
      started_at: started.observed_at,
      finished_at: arrival.observed_at,
      observed_sources: source ? [source] : [],
      observed_artifacts: new Set(["render_pdf_page", "render_pdf_region"]).has(item.tool) && sourceObservation
        ? [sourceObservation.snapshot] : [],
    };
  }
  return observations;
}

function harnessFailure({ runId, finishedAt, exit, stderrSha256 }) {
  const code = exit.timed_out ? "codex_timeout"
    : exit.spawn_error ? "codex_launch_error"
      : exit.exit_code === 0 ? "no_completed_pdf_calls" : `codex_exit_${exit.exit_code ?? "unknown"}`;
  const detail = exit.timed_out ? "Codex exceeded the controller timeout before completing a PDF tool call"
    : exit.spawn_error ? `Codex could not launch: ${exit.spawn_error}`
      : `Codex exited without a completed PDF tool call (exit=${exit.exit_code}, signal=${exit.signal ?? "none"})`;
  const eventId = `${runId}.event.harness-failure`;
  return {
    event: hostEvent(
      eventId,
      "harness_failure",
      "codex_launcher",
      finishedAt,
      `sha256:${stderrSha256}`,
      eventProvenance("agent_host", "launcher_exit_status", stderrSha256),
    ),
    value: {
      harness_schema_version: 1,
      code,
      phase: "host_session",
      detail,
      event_id: eventId,
    },
  };
}

export function buildObserver({
  campaign,
  plan,
  entry,
  job,
  arrivals,
  preManifest,
  postManifest,
  preManifestRawSha256,
  postManifestRawSha256,
  planRawSha256,
  stdoutSha256,
  stderrSha256,
  launcherRecordSha256,
  startedAt,
  preObservedAt,
  effectsObservedAt,
  launcherObservedAt,
  finishedAt,
  exit,
}) {
  const repeatIndex = entry.repeat_index;
  const runId = `${campaign.trial_set_id}.run.${repeatIndex}`;
  const sourceObservations = sourceObservationMap({ runId, preObservedAt, preManifest });
  const inputSnapshot = inputSnapshotFromManifest(preManifest);
  const inputSha256 = sha256(canonicalJson(inputSnapshot));
  const effectsDiff = diffManifests(preManifest, postManifest);
  const effectsEventId = `${runId}.event.effects`;
  const planDigest = sha256(canonicalJson(plan));
  const effects = {
    effects_schema_version: 1,
    observer_event_id: effectsEventId,
    ...effectsDiff,
    external_requests: externalRequests(arrivals),
    signature_applied: completedPdfCalls(arrivals).some(item => item.tool === "apply_signature" && successfulCall(item)),
  };
  const events = [
    hostEvent(
      `${runId}.event.run-plan`,
      "run_plan_committed",
      "codex_launcher",
      startedAt,
      `sha256:${planDigest}`,
      eventProvenance("agent_host", "pre_run_plan_commitment", planRawSha256),
    ),
    hostEvent(
      `${runId}.event.input-snapshot`,
      "input_snapshot_observed",
      "filesystem_capture",
      preObservedAt,
      `sha256:${inputSha256}`,
      eventProvenance("filesystem_observer", "filesystem_manifest_sha256", preManifestRawSha256),
    ),
    hostEvent(
      `${runId}.event.fixture-instance`,
      "fixture_instance_observed",
      "filesystem_capture",
      preObservedAt,
      `sha256:${entry.fixture_instance_sha256}`,
      eventProvenance("filesystem_observer", "fixture_manifest_sha256", sha256(canonicalJson(fixtureInstanceRecord()))),
    ),
    ...[...sourceObservations.values()].map(item => item.event),
    hostEvent(
      effectsEventId,
      "effects_observed",
      "filesystem_capture",
      effectsObservedAt,
      `sha256:${sha256(canonicalJson({ effects, before: preManifest.manifest_sha256, after: postManifest.manifest_sha256 }))}`,
      eventProvenance("filesystem_observer", "filesystem_diff", postManifestRawSha256),
    ),
    hostEvent(
      `${runId}.event.launcher`,
      "agent_launch_observed",
      "codex_launcher",
      launcherObservedAt,
      `sha256:${launcherRecordSha256}`,
      eventProvenance("agent_host", "launcher_record_sha256", launcherRecordSha256),
    ),
  ];
  const outcome = classifyRunOutcome(arrivals);
  let failure = null;
  if (outcome === "harness_failure") {
    failure = harnessFailure({ runId, finishedAt, exit, stderrSha256 });
    events.push(failure.event);
  }
  const diagnosticItems = arrivals.map(completedItem).filter(item => item?.type === "error")
    .map(safeDiagnosticMessage).filter(Boolean);
  const annotations = buildFinalAnswerAnnotations(job, arrivals);
  if (diagnosticItems.length > 0) {
    annotations.limitations.push(`Codex emitted ${diagnosticItems.length} retained host diagnostic item(s); messages are hash-bound in the launcher record and raw transcript.`);
  }
  return {
    observer_schema_version: 1,
    trial_set_id: campaign.trial_set_id,
    suite_id: campaign.suite_id,
    trial_id: `${campaign.trial_set_id}.trial.${repeatIndex}`,
    job_id: entry.job_id,
    repeat_index: repeatIndex,
    agent: "codex-cli",
    model: campaign.model,
    claim_boundary: campaign.claim_boundary,
    run: {
      run_schema_version: 1,
      run_id: runId,
      started_at: startedAt,
      finished_at: finishedAt,
      host: {
        name: hostname(),
        version: campaign.codex_version,
        platform: `${platform()}-${arch()}`,
      },
      events,
    },
    call_observations: buildCallObservations(arrivals, sourceObservations),
    effects: outcome === "completed" ? effects : {},
    artifacts: [],
    final_answer_annotations: outcome === "completed" ? annotations : { evidence: [], claims: [], limitations: [] },
    correction_refs: [],
    sample: {
      input_sha256: inputSha256,
      fixture_instance_sha256: entry.fixture_instance_sha256,
      seed: entry.seed,
      invocation_id: entry.invocation_id,
    },
    outcome,
    harness_failure: failure?.value ?? null,
  };
}

export function buildBatchManifest(campaign) {
  return {
    runs: campaign.runs.map(run => ({
      raw: `${run.directory}/codex.jsonl`,
      observer: `${run.directory}/observer.json`,
    })),
  };
}

async function commandOutput(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr.trim()}`));
      else resolve(stdout.trim());
    });
  });
}

async function sourceFingerprints() {
  const result = {};
  for (const relative of SOURCE_FINGERPRINT_PATHS) {
    result[relative] = sha256(await fs.readFile(path.join(REPO_ROOT, relative)));
  }
  return result;
}

async function createWorkspace(workspace) {
  await fs.mkdir(path.join(workspace, "input"), { recursive: true });
  await fs.mkdir(path.join(workspace, "state", "signatures"), { recursive: true });
  await fs.mkdir(path.join(workspace, "state", "backups"), { recursive: true });
  await fs.mkdir(path.join(workspace, "downloads"), { recursive: true });
  await fs.mkdir(path.join(workspace, "tmp"), { recursive: true });
  for (const fixture of FIXTURES) {
    const source = path.join(REPO_ROOT, fixture.source);
    const bytes = await fs.readFile(source);
    if (sha256(bytes) !== fixture.sha256) throw new Error(`Pinned fixture hash mismatch: ${fixture.source}`);
    const destination = path.join(workspace, fixture.destination);
    await fs.copyFile(source, destination, fsSync.constants.COPYFILE_EXCL);
    await fs.chmod(destination, 0o444);
  }
}

function campaignId(now) {
  return `pdf-tools.trajectory.codex-comparison.${now.replace(/[-:.TZ]/g, "")}`;
}

async function planCampaign({ campaignPath, count, model, timeoutMs }) {
  const campaignRoot = await assertCampaignPath(campaignPath, DOCUMENTS_ROOT, { mayNotExist: true });
  await fs.mkdir(campaignRoot, { recursive: false, mode: 0o700 });
  const suite = await loadSuite();
  const job = suite.jobs.find(item => item.id === JOB_ID);
  if (!job) throw new Error(`Suite does not contain ${JOB_ID}`);
  const plannedAt = isoNow();
  const trialSetId = campaignId(plannedAt);
  const fixtureRecord = fixtureInstanceRecord();
  const fixtureInstanceSha256 = sha256(canonicalJson(fixtureRecord));
  const plan = buildRunPlan({ suite, job, count, trialSetId, plannedAt, fixtureInstanceSha256 });
  const runs = [];
  for (const entry of plan.entries) {
    const directory = path.join("runs", runName(entry.repeat_index));
    const runRoot = path.join(campaignRoot, directory);
    const workspace = path.join(runRoot, "workspace");
    await fs.mkdir(runRoot, { recursive: true, mode: 0o700 });
    await createWorkspace(workspace);
    const manifest = await snapshotTree(workspace);
    const inputSnapshot = inputSnapshotFromManifest(manifest);
    await writeJson(path.join(runRoot, "planned-workspace-manifest.json"), manifest, { exclusive: true });
    await fs.writeFile(path.join(runRoot, "prompt.txt"), `${buildPrompt(job)}\n`, { flag: "wx", mode: 0o600 });
    runs.push({
      repeat_index: entry.repeat_index,
      invocation_id: entry.invocation_id,
      directory: normalizeRelative(directory),
      workspace_manifest_sha256: manifest.manifest_sha256,
      input_sha256: sha256(canonicalJson(inputSnapshot)),
    });
  }
  const planText = await writeJson(path.join(campaignRoot, "pre-run-plan.json"), plan, { exclusive: true });
  const finalSuite = await loadSuite();
  if (sha256(canonicalJson(finalSuite)) !== plan.suite_sha256) {
    throw new Error("Trajectory suite changed while the pre-run plan was being created");
  }
  const codexVersion = await commandOutput("codex", ["--version"]);
  const gitCommit = await commandOutput("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT });
  const campaign = {
    campaign_schema_version: CAMPAIGN_SCHEMA_VERSION,
    trial_set_id: trialSetId,
    suite_id: suite.suite_id,
    job_id: job.id,
    count,
    model,
    claim_boundary: CLAIM_BOUNDARY,
    created_at: plannedAt,
    timeout_ms: timeoutMs,
    codex_version: codexVersion,
    node_runtime: nodeRuntime(),
    git_commit: gitCommit,
    suite_sha256: sha256(canonicalJson(suite)),
    plan_sha256: sha256(canonicalJson(plan)),
    plan_raw_sha256: sha256(planText),
    fixture_instance_sha256: fixtureInstanceSha256,
    source_fingerprints: await sourceFingerprints(),
    runs,
  };
  campaign.launch_contract_sha256 = campaignCommitmentSha256(campaign);
  await writeJson(path.join(campaignRoot, "campaign.json"), campaign, { exclusive: true });
  return { campaignRoot, campaign, plan };
}

export function validateCampaign(campaign, plan) {
  exactObjectKeys(campaign, [
    "campaign_schema_version", "trial_set_id", "suite_id", "job_id", "count", "model", "claim_boundary",
    "created_at", "timeout_ms", "codex_version", "node_runtime", "git_commit", "suite_sha256", "plan_sha256",
    "plan_raw_sha256", "fixture_instance_sha256", "source_fingerprints", "runs", "launch_contract_sha256",
  ], "campaign");
  if (campaign.campaign_schema_version !== CAMPAIGN_SCHEMA_VERSION) throw new Error("Unsupported campaign schema");
  if (campaign.launch_contract_sha256 !== campaignCommitmentSha256(campaign)) {
    throw new Error("Campaign launch contract changed after planning");
  }
  if (campaign.plan_sha256 !== sha256(canonicalJson(plan))) throw new Error("Pre-run plan no longer matches campaign commitment");
  if (campaign.trial_set_id !== plan.trial_set_id
    || campaign.suite_id !== plan.suite_id
    || campaign.claim_boundary !== plan.claim_boundary) {
    throw new Error("Campaign identity and claim boundary must match the frozen plan");
  }
  if (campaign.suite_sha256 !== plan.suite_sha256) {
    throw new Error("Campaign suite digest must match the frozen plan");
  }
  if (campaign.count !== plan.entries.length || campaign.runs.length !== plan.entries.length) {
    throw new Error("Campaign denominator does not match the frozen plan");
  }
  if (typeof campaign.model !== "string" || campaign.model.length === 0) throw new Error("Campaign model must be non-empty");
  if (!Number.isInteger(campaign.timeout_ms) || campaign.timeout_ms < 1_000) {
    throw new Error("Campaign timeout must be at least 1000 ms");
  }
  exactObjectKeys(campaign.node_runtime, ["version", "modules", "napi", "v8"], "campaign.node_runtime");
  const planByRepeat = new Map(plan.entries.map(entry => [entry.repeat_index, entry]));
  const seenRepeats = new Set();
  for (const run of campaign.runs) {
    exactObjectKeys(run, [
      "repeat_index", "invocation_id", "directory", "workspace_manifest_sha256", "input_sha256",
    ], "campaign.runs[]");
    const entry = planByRepeat.get(run.repeat_index);
    if (!entry || entry.invocation_id !== run.invocation_id || seenRepeats.has(run.repeat_index)) {
      throw new Error("Campaign run entries must map one-to-one to the frozen plan");
    }
    if (run.directory !== normalizeRelative(path.join("runs", runName(run.repeat_index)))) {
      throw new Error("Campaign run directory does not match its repeat index");
    }
    for (const key of ["workspace_manifest_sha256", "input_sha256"]) {
      if (!/^[a-f0-9]{64}$/.test(run[key])) throw new Error(`Campaign ${key} must be SHA-256`);
    }
    seenRepeats.add(run.repeat_index);
  }
}

async function loadCampaign(campaignPath) {
  const campaignRoot = await assertCampaignPath(campaignPath);
  const campaign = await readJson(path.join(campaignRoot, "campaign.json"));
  const planText = await fs.readFile(path.join(campaignRoot, "pre-run-plan.json"), "utf8");
  const plan = JSON.parse(planText);
  validateCampaign(campaign, plan);
  if (campaign.plan_raw_sha256 !== sha256(planText)) throw new Error("Raw pre-run plan file changed after planning");
  const suite = await loadSuite();
  if (campaign.suite_sha256 !== sha256(canonicalJson(suite))) throw new Error("Trajectory suite changed after planning");
  const job = suite.jobs.find(item => item.id === campaign.job_id);
  if (!job) throw new Error(`Suite no longer contains ${campaign.job_id}`);
  const fingerprints = await sourceFingerprints();
  if (canonicalJson(fingerprints) !== canonicalJson(campaign.source_fingerprints)) {
    throw new Error("Pinned controller/server/evaluation sources changed after planning");
  }
  const currentCodexVersion = await commandOutput("codex", ["--version"]);
  if (currentCodexVersion !== campaign.codex_version) throw new Error("Codex CLI version changed after planning");
  if (canonicalJson(nodeRuntime()) !== canonicalJson(campaign.node_runtime)) {
    throw new Error("Node.js runtime changed after planning");
  }
  return { campaignRoot, campaign, plan, suite, job, planText };
}

async function appendArrival(stream, arrival) {
  await new Promise((resolve, reject) => {
    stream.write(`${JSON.stringify(arrival)}\n`, error => error ? reject(error) : resolve());
  });
}

async function runCodexProcess({ args, prompt, cwd, timeoutMs, stdoutPath, stderrPath, arrivalsPath }) {
  const stdoutStream = fsSync.createWriteStream(stdoutPath, { flags: "wx", mode: 0o600 });
  const stderrStream = fsSync.createWriteStream(stderrPath, { flags: "wx", mode: 0o600 });
  const arrivalStream = fsSync.createWriteStream(arrivalsPath, { flags: "wx", mode: 0o600 });
  const collector = new JsonlArrivalCollector();
  const arrivalWrites = [];
  let spawnError = null;
  let timedOut = false;
  let timeout;
  const result = await new Promise(resolve => {
    const child = spawn("codex", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    timeout.unref();
    child.stdout.on("data", chunk => {
      stdoutStream.write(chunk);
      const observedAt = isoNow();
      for (const arrival of collector.push(chunk, observedAt)) {
        arrivalWrites.push(appendArrival(arrivalStream, arrival));
      }
    });
    child.stderr.on("data", chunk => stderrStream.write(chunk));
    child.on("error", error => { spawnError = error.message; });
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
  clearTimeout(timeout);
  for (const arrival of collector.finish(isoNow())) arrivalWrites.push(appendArrival(arrivalStream, arrival));
  await Promise.all(arrivalWrites);
  await Promise.all([
    new Promise(resolve => stdoutStream.end(resolve)),
    new Promise(resolve => stderrStream.end(resolve)),
    new Promise(resolve => arrivalStream.end(resolve)),
  ]);
  return {
    arrivals: collector.arrivals,
    exit: {
      exit_code: result.exitCode,
      signal: result.signal,
      timed_out: timedOut,
      spawn_error: spawnError,
    },
  };
}

async function runCampaignEntry({ campaignPath, repeatIndex }) {
  const { campaignRoot, campaign, plan, job, planText } = await loadCampaign(campaignPath);
  const entry = plan.entries.find(item => item.repeat_index === repeatIndex);
  const run = campaign.runs.find(item => item.repeat_index === repeatIndex);
  if (!entry || !run) throw new Error(`Repeat ${repeatIndex} is outside the frozen denominator`);
  const runRoot = path.join(campaignRoot, run.directory);
  await writeJson(path.join(runRoot, "launch-claim.json"), {
    launch_claim_schema_version: 1,
    invocation_id: entry.invocation_id,
    claimed_at: isoNow(),
  }, { exclusive: true });
  const workspace = path.join(runRoot, "workspace");
  const plannedManifest = await readJson(path.join(runRoot, "planned-workspace-manifest.json"));
  const startedAt = isoNow();
  const preManifest = await snapshotTree(workspace);
  if (preManifest.manifest_sha256 !== plannedManifest.manifest_sha256) {
    throw new Error("Run workspace changed after planning; invocation remains claimed for operator audit");
  }
  const preObservedAt = isoNow();
  const preText = await writeJson(path.join(runRoot, "pre-filesystem-manifest.json"), preManifest, { exclusive: true });
  const prompt = await fs.readFile(path.join(runRoot, "prompt.txt"), "utf8");
  const args = buildCodexArgs({ workspace, model: campaign.model });
  const launcherStart = {
    launcher_schema_version: 1,
    invocation_id: entry.invocation_id,
    command: "codex",
    args,
    cwd: workspace,
    model: campaign.model,
    codex_version: campaign.codex_version,
    started_at: startedAt,
    timeout_ms: campaign.timeout_ms,
    prompt_sha256: sha256(prompt),
    plan_sha256: campaign.plan_sha256,
    source_fingerprints: campaign.source_fingerprints,
  };
  await writeJson(path.join(runRoot, "launcher-start.json"), launcherStart, { exclusive: true });
  const processResult = await runCodexProcess({
    args,
    prompt,
    cwd: workspace,
    timeoutMs: campaign.timeout_ms,
    stdoutPath: path.join(runRoot, "codex.jsonl"),
    stderrPath: path.join(runRoot, "codex.stderr"),
    arrivalsPath: path.join(runRoot, "jsonl-arrivals.jsonl"),
  });
  const postManifest = await snapshotTree(workspace);
  const effectsObservedAt = isoNow();
  const postText = await writeJson(path.join(runRoot, "post-filesystem-manifest.json"), postManifest, { exclusive: true });
  const stdoutBytes = await fs.readFile(path.join(runRoot, "codex.jsonl"));
  const stderrBytes = await fs.readFile(path.join(runRoot, "codex.stderr"));
  const diagnostics = processResult.arrivals.map(completedItem).filter(item => item?.type === "error")
    .map(safeDiagnosticMessage).filter(Boolean);
  const launcherRecord = {
    ...launcherStart,
    finished_at: isoNow(),
    exit: processResult.exit,
    stdout_sha256: sha256(stdoutBytes),
    stderr_sha256: sha256(stderrBytes),
    arrival_count: processResult.arrivals.length,
    parse_error_count: processResult.arrivals.filter(item => item.parse_error).length,
    completed_pdf_call_count: completedPdfCalls(processResult.arrivals).length,
    classified_outcome: classifyRunOutcome(processResult.arrivals),
    host_diagnostics: diagnostics,
    limitations: [HOST_LIMITATION, TRANSPORT_LIMITATION],
  };
  const launcherText = await writeJson(path.join(runRoot, "launcher-record.json"), launcherRecord, { exclusive: true });
  const launcherObservedAt = isoNow();
  const finishedAt = isoNow();
  const observer = buildObserver({
    campaign,
    plan,
    entry,
    job,
    arrivals: processResult.arrivals,
    preManifest,
    postManifest,
    preManifestRawSha256: sha256(preText),
    postManifestRawSha256: sha256(postText),
    planRawSha256: sha256(planText),
    stdoutSha256: launcherRecord.stdout_sha256,
    stderrSha256: launcherRecord.stderr_sha256,
    launcherRecordSha256: sha256(launcherText),
    startedAt,
    preObservedAt,
    effectsObservedAt,
    launcherObservedAt,
    finishedAt,
    exit: processResult.exit,
  });
  await writeJson(path.join(runRoot, "observer.json"), observer, { exclusive: true });
  return { runRoot, observer, launcherRecord };
}

async function finalizeCampaign(campaignPath) {
  const { campaignRoot, campaign } = await loadCampaign(campaignPath);
  const missing = [];
  for (const run of campaign.runs) {
    for (const filename of ["codex.jsonl", "observer.json", "launcher-record.json"]) {
      if (!await exists(path.join(campaignRoot, run.directory, filename))) {
        missing.push(`${run.directory}/${filename}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(`Frozen denominator is unresolved; refusing partial ingestion:\n- ${missing.join("\n- ")}`);
  }
  const batch = buildBatchManifest(campaign);
  const batchPath = path.join(campaignRoot, "batch-manifest.json");
  await writeJson(batchPath, batch);
  const trialsPath = path.join(campaignRoot, "measured-trials.json");
  const ingesterStdout = await commandOutput(process.execPath, [
    path.join(REPO_ROOT, "scripts", "eval-ingest-codex-trajectory.mjs"),
    "--plan", path.join(campaignRoot, "pre-run-plan.json"),
    "--batch", batchPath,
    "--output", trialsPath,
  ], { cwd: REPO_ROOT });
  await fs.writeFile(path.join(campaignRoot, "ingester.stdout"), `${ingesterStdout}\n`, { mode: 0o600 });
  const reportText = await commandOutput(process.execPath, [
    path.join(REPO_ROOT, "scripts", "eval-run-trajectories.mjs"),
    "--trials", trialsPath,
  ], { cwd: REPO_ROOT });
  const report = JSON.parse(reportText);
  await writeJson(path.join(campaignRoot, "trajectory-report.json"), report);
  return { campaignRoot, trialsPath, report };
}

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function usage() {
  return `Usage:
  node scripts/eval-run-codex-comparison.mjs plan [--campaign PATH] [--count N | --pilot] [--model MODEL] [--timeout-ms N]
  node scripts/eval-run-codex-comparison.mjs run --campaign PATH --repeat N
  node scripts/eval-run-codex-comparison.mjs finalize --campaign PATH

plan is non-model and freezes the complete denominator before any launch. run invokes a paid remote model once.
finalize refuses to ingest until every planned invocation has a retained product or harness-failure observer.\n`;
}

async function main() {
  const command = process.argv[2];
  if (!command || hasFlag("--help")) {
    process.stdout.write(usage());
    return;
  }
  if (command === "plan") {
    if (hasFlag("--pilot") && argument("--count") !== null) throw new Error("--pilot and --count are mutually exclusive");
    const count = hasFlag("--pilot") ? 1 : Number(argument("--count", String(DEFAULT_COUNT)));
    const model = argument("--model", DEFAULT_MODEL);
    const timeoutMs = Number(argument("--timeout-ms", String(DEFAULT_TIMEOUT_MS)));
    if (!Number.isInteger(count) || count < 1) throw new Error("--count must be a positive integer");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) throw new Error("--timeout-ms must be at least 1000");
    const defaultPath = path.join(DOCUMENTS_ROOT, `pdf-tools-codex-comparison-${Date.now()}`);
    const result = await planCampaign({
      campaignPath: path.resolve(argument("--campaign", defaultPath)),
      count,
      model,
      timeoutMs,
    });
    process.stdout.write(`${result.campaignRoot}\n${result.campaign.plan_sha256}\n`);
    return;
  }
  if (command === "run") {
    const campaignPath = argument("--campaign");
    const repeatIndex = Number(argument("--repeat"));
    if (!campaignPath || !Number.isInteger(repeatIndex) || repeatIndex < 1) {
      throw new Error("run requires --campaign PATH and positive --repeat N");
    }
    const result = await runCampaignEntry({ campaignPath: path.resolve(campaignPath), repeatIndex });
    process.stdout.write(`${result.observer.outcome}\n${result.runRoot}\n`);
    return;
  }
  if (command === "finalize") {
    const campaignPath = argument("--campaign");
    if (!campaignPath) throw new Error("finalize requires --campaign PATH");
    const result = await finalizeCampaign(path.resolve(campaignPath));
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    return;
  }
  throw new Error(`Unknown command ${command}\n${usage()}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
