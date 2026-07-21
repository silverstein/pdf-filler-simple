#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, hostname, platform, arch } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
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

const LAUNCH_ENVIRONMENT_KEYS = Object.freeze([
  "CODEX_CI", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "NODE_EXTRA_CA_CERTS", "PATH",
  "SSL_CERT_DIR", "SSL_CERT_FILE", "TMPDIR", "TZ", "USER",
]);
const LAUNCH_SECRET_KEYS = Object.freeze(["OPENAI_API_KEY"]);

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

async function resolveExecutable(command) {
  if (path.isAbsolute(command)) return fs.realpath(command);
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      await fs.access(candidate, fsSync.constants.X_OK);
      return await fs.realpath(candidate);
    } catch {
      // Keep searching PATH.
    }
  }
  throw new Error(`Executable is not available on PATH: ${command}`);
}

async function fingerprintRuntimeFile(filename) {
  const realPath = await fs.realpath(filename);
  const bytes = await fs.readFile(realPath);
  return { path: filename, real_path: realPath, size: bytes.length, sha256: sha256(bytes) };
}

async function findPackageRoot(filename) {
  let current = path.dirname(await fs.realpath(filename));
  const filesystemRoot = path.parse(current).root;
  while (true) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(current, "package.json"), "utf8"));
      if (typeof manifest.name === "string" && manifest.name.length > 0) {
        return { root: current, name: manifest.name };
      }
    } catch {
      // Continue toward the filesystem root.
    }
    if (current === filesystemRoot) throw new Error(`No package root contains ${filename}`);
    current = path.dirname(current);
  }
}

export async function fingerprintRuntimeTree(root, { excludeDirectories = [] } = {}) {
  const realRoot = await fs.realpath(root);
  const excluded = new Set(excludeDirectories);
  const entries = [];
  async function visit(directory, relativeDirectory = "") {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (child.isDirectory() && excluded.has(child.name)) continue;
      const relative = normalizeRelative(path.join(relativeDirectory, child.name));
      const absolute = path.join(directory, child.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Runtime tree contains unsupported symlink: ${absolute}`);
      if (stat.isDirectory()) {
        await visit(absolute, relative);
      } else if (stat.isFile()) {
        const bytes = await fs.readFile(absolute);
        entries.push({ path: relative, mode: stat.mode & 0o777, size: bytes.length, sha256: sha256(bytes) });
      } else {
        throw new Error(`Runtime tree contains unsupported entry: ${absolute}`);
      }
    }
  }
  await visit(realRoot);
  return {
    root,
    real_root: realRoot,
    file_count: entries.length,
    total_bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    tree_sha256: sha256(canonicalJson(entries)),
  };
}

function codexPlatformPackage() {
  return {
    "darwin-arm64": "@openai/codex-darwin-arm64",
    "darwin-x64": "@openai/codex-darwin-x64",
    "linux-arm64": "@openai/codex-linux-arm64",
    "linux-x64": "@openai/codex-linux-x64",
    "win32-arm64": "@openai/codex-win32-arm64",
    "win32-x64": "@openai/codex-win32-x64",
  }[`${process.platform}-${process.arch}`];
}

export function captureLaunchEnvironment(environment = process.env, secretSalt = randomBytes(32).toString("hex")) {
  const nonSecret = Object.fromEntries(LAUNCH_ENVIRONMENT_KEYS.map(key => [key, environment[key] ?? null]));
  const secretCommitments = Object.fromEntries(LAUNCH_SECRET_KEYS.map(key => [
    key,
    environment[key] === undefined ? null : sha256(`${secretSalt}\0${environment[key]}`),
  ]));
  return {
    environment_schema_version: 1,
    non_secret: nonSecret,
    secret_salt: secretSalt,
    secret_commitments: secretCommitments,
    stripped_prefixes: ["PDF_TOOLS_"],
  };
}

export function buildLaunchEnvironment(contract, environment = process.env) {
  exactObjectKeys(contract, [
    "environment_schema_version", "non_secret", "secret_salt", "secret_commitments", "stripped_prefixes",
  ], "environment contract");
  if (contract.environment_schema_version !== 1
    || !isObjectRecord(contract.non_secret)
    || !isObjectRecord(contract.secret_commitments)
    || !/^[a-f0-9]{64}$/.test(contract.secret_salt)
    || canonicalJson(Object.keys(contract.non_secret)) !== canonicalJson(LAUNCH_ENVIRONMENT_KEYS)
    || canonicalJson(Object.keys(contract.secret_commitments)) !== canonicalJson(LAUNCH_SECRET_KEYS)
    || canonicalJson(contract.stripped_prefixes) !== canonicalJson(["PDF_TOOLS_"])) {
    throw new Error("Environment contract is malformed");
  }
  const current = captureLaunchEnvironment(environment, contract.secret_salt);
  if (canonicalJson(current) !== canonicalJson(contract)) {
    throw new Error("Allowlisted Codex launch environment changed after planning");
  }
  const result = {};
  for (const [key, value] of Object.entries(contract.non_secret)) {
    if (value !== null) result[key] = value;
  }
  for (const [key, commitment] of Object.entries(contract.secret_commitments)) {
    if (commitment !== null) result[key] = environment[key];
  }
  return result;
}

async function runtimeFingerprints(codexExecutable = "codex") {
  const nativeCanvasPackage = {
    "darwin-arm64": "@napi-rs/canvas-darwin-arm64",
    "darwin-x64": "@napi-rs/canvas-darwin-x64",
    "linux-arm64": "@napi-rs/canvas-linux-arm64-gnu",
    "linux-x64": "@napi-rs/canvas-linux-x64-gnu",
    "win32-arm64": "@napi-rs/canvas-win32-arm64-msvc",
    "win32-x64": "@napi-rs/canvas-win32-x64-msvc",
  }[`${process.platform}-${process.arch}`];
  if (!nativeCanvasPackage) throw new Error(`Unsupported canvas runtime ${process.platform}-${process.arch}`);
  const resolvedCodex = await resolveExecutable(codexExecutable);
  const codexPackage = codexPlatformPackage();
  if (!codexPackage) throw new Error(`Unsupported Codex runtime ${process.platform}-${process.arch}`);
  const codexPackageInfo = await findPackageRoot(resolvedCodex);
  const nodeModulesPath = path.join(REPO_ROOT, "node_modules");
  const files = {
    controller_node: process.execPath,
    mcp_node: process.execPath,
    codex: resolvedCodex,
    mcp_sdk_entry: fileURLToPath(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js")),
    mcp_sdk_stdio: fileURLToPath(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js")),
    mcp_sdk_types: fileURLToPath(import.meta.resolve("@modelcontextprotocol/sdk/types.js")),
    mcp_sdk_ajv: fileURLToPath(import.meta.resolve("@modelcontextprotocol/sdk/validation/ajv")),
    pdf_lib_entry: require.resolve("pdf-lib"),
    pdf_lib_manifest: require.resolve("pdf-lib/package.json"),
    pdfjs_entry: require.resolve("pdfjs-dist/legacy/build/pdf.mjs"),
    pdfjs_manifest: require.resolve("pdfjs-dist/package.json"),
    canvas_entry: require.resolve("@napi-rs/canvas"),
    canvas_manifest: require.resolve("@napi-rs/canvas/package.json"),
    canvas_native_entry: require.resolve(nativeCanvasPackage),
    canvas_native_manifest: require.resolve(`${nativeCanvasPackage}/package.json`),
  };
  const fingerprints = {};
  for (const [label, filename] of Object.entries(files)) {
    fingerprints[label] = await fingerprintRuntimeFile(filename);
  }
  const packageManifests = {
    mcp_sdk_tree: require.resolve("@modelcontextprotocol/sdk/package.json"),
    pdf_lib_tree: require.resolve("pdf-lib/package.json"),
    pdfjs_tree: require.resolve("pdfjs-dist/package.json"),
    canvas_tree: require.resolve("@napi-rs/canvas/package.json"),
    canvas_native_tree: require.resolve(`${nativeCanvasPackage}/package.json`),
  };
  for (const [label, manifest] of Object.entries(packageManifests)) {
    fingerprints[label] = await fingerprintRuntimeTree(path.dirname(manifest));
  }
  if (codexPackageInfo.name === "@openai/codex") {
    const codexRequire = createRequire(resolvedCodex);
    const codexPlatformManifest = codexRequire.resolve(`${codexPackage}/package.json`);
    fingerprints.codex_package_tree = await fingerprintRuntimeTree(codexPackageInfo.root, {
      excludeDirectories: ["node_modules"],
    });
    fingerprints.codex_platform_tree = await fingerprintRuntimeTree(path.dirname(codexPlatformManifest));
  } else {
    fingerprints.codex_package_tree = null;
    fingerprints.codex_platform_tree = null;
  }
  fingerprints.node_modules_root = {
    path: nodeModulesPath,
    real_path: await fs.realpath(nodeModulesPath),
    type: "directory",
  };
  return fingerprints;
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

function isObjectRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

async function writeText(filename, value) {
  const temporary = `${filename}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  try {
    await fs.writeFile(temporary, value, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, "utf8"));
}

async function readRegularFile(filename, encoding = null) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Expected a retained regular file: ${filename}`);
  }
  return fs.readFile(filename, encoding ?? undefined);
}

async function loadSuite() {
  const suite = await readJson(SUITE_PATH);
  if (suite?.suite_id !== "pdf-tools.trajectory.v1" || !Array.isArray(suite.jobs)) {
    throw new Error("Trajectory suite is missing its pinned ID or jobs array");
  }
  return suite;
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

async function assertDirectoryChain(root, candidate, label) {
  const rootReal = await fs.realpath(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(rootReal, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a child of ${rootReal}`);
  }
  let current = rootReal;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${label} ancestry must contain only real directories: ${current}`);
    }
  }
  const currentReal = await fs.realpath(current);
  if (currentReal !== current) throw new Error(`${label} resolves outside its lexical directory chain`);
  return currentReal;
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

async function validatePlannedRunInputs({ campaignRoot, run }) {
  const runRoot = await assertDirectoryChain(
    campaignRoot, path.join(campaignRoot, run.directory), "Campaign run directory",
  );
  const workspace = await assertDirectoryChain(
    runRoot, path.join(runRoot, "workspace"), "Campaign workspace",
  );
  const manifestPath = path.join(runRoot, "planned-workspace-manifest.json");
  const promptPath = path.join(runRoot, "prompt.txt");
  const [manifestText, prompt] = await Promise.all([
    readRegularFile(manifestPath, "utf8"),
    readRegularFile(promptPath, "utf8"),
  ]);
  if (sha256(manifestText) !== run.workspace_manifest_raw_sha256) {
    throw new Error("Raw planned workspace manifest changed after planning");
  }
  if (sha256(prompt) !== run.prompt_sha256) throw new Error("Prompt changed after planning");
  const manifest = JSON.parse(manifestText);
  if (!Array.isArray(manifest.entries)
    || manifest.manifest_sha256 !== sha256(canonicalJson(manifest.entries))
    || manifest.manifest_sha256 !== run.workspace_manifest_sha256) {
    throw new Error("Planned workspace manifest does not match its frozen canonical digest");
  }
  const inputSnapshot = inputSnapshotFromManifest(manifest);
  if (sha256(canonicalJson(inputSnapshot)) !== run.input_sha256) {
    throw new Error("Planned input snapshot does not match its frozen digest");
  }
  const currentManifest = await snapshotTree(workspace);
  if (currentManifest.manifest_sha256 !== run.workspace_manifest_sha256) {
    throw new Error("Run workspace changed after planning");
  }
  return { runRoot, workspace, manifest, manifestText, prompt, currentManifest };
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

export function buildCodexArgs({
  workspace,
  model = DEFAULT_MODEL,
  serverPath = path.join(REPO_ROOT, "server", "index.js"),
  nodeExecutable = process.execPath,
}) {
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
    "-c", `mcp_servers.pdf_tools.command=${tomlString(nodeExecutable)}`,
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
    this.decoder = new StringDecoder("utf8");
  }

  push(chunk, observedAt = isoNow()) {
    this.pending += Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : String(chunk);
    const lines = this.pending.split("\n");
    this.pending = lines.pop();
    return lines.map(line => this.#record(line.replace(/\r$/, ""), observedAt));
  }

  finish(observedAt = isoNow()) {
    this.pending += this.decoder.end();
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

export function classifyRunOutcome(arrivals, exit = {}) {
  if (completedPdfCalls(arrivals).length > 0) return "completed";
  if (arrivals.some(arrival => arrival.event?.type === "turn.completed")) return "completed";
  return "harness_failure";
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

function hostDiagnostics(arrivals) {
  return arrivals.map(completedItem).filter(item => item?.type === "error")
    .map(safeDiagnosticMessage).filter(Boolean);
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

function campaignEvidenceDigest({
  campaign, launcherRecordSha256, launchClaimRawSha256, launcherStartRawSha256,
  arrivalsRawSha256, preManifestRawSha256, postManifestRawSha256,
}) {
  return sha256(canonicalJson({
    launch_contract_sha256: campaign.launch_contract_sha256,
    codex_version: campaign.codex_version,
    node_runtime: campaign.node_runtime,
    source_fingerprints: campaign.source_fingerprints,
    runtime_fingerprints: campaign.runtime_fingerprints,
    environment_contract: campaign.environment_contract,
    launcher_record_sha256: launcherRecordSha256,
    launch_claim_raw_sha256: launchClaimRawSha256,
    launcher_start_raw_sha256: launcherStartRawSha256,
    arrivals_raw_sha256: arrivalsRawSha256,
    pre_manifest_raw_sha256: preManifestRawSha256,
    post_manifest_raw_sha256: postManifestRawSha256,
  }));
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

export function buildCallObservations(arrivals, sourceObservations) {
  const starts = new Map(arrivals.map(arrival => [startedItem(arrival)?.id, arrival]).filter(([id]) => typeof id === "string"));
  const observations = {};
  for (const arrival of arrivals) {
    const item = completedItem(arrival);
    if (item?.type !== "mcp_tool_call" || item.server !== "pdf_tools" || typeof item.id !== "string") continue;
    const started = starts.get(item.id);
    const startedCall = startedItem(started);
    if (startedCall?.type !== "mcp_tool_call"
      || startedCall.server !== item.server
      || startedCall.tool !== item.tool
      || canonicalJson(startedCall.arguments ?? {}) !== canonicalJson(item.arguments ?? {})) continue;
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
  launchClaimRawSha256,
  launcherStartRawSha256,
  arrivalsRawSha256,
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
  const campaignDigest = campaignEvidenceDigest({
    campaign, launcherRecordSha256, launchClaimRawSha256, launcherStartRawSha256,
    arrivalsRawSha256, preManifestRawSha256, postManifestRawSha256,
  });
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
    hostEvent(
      `${runId}.event.campaign-evidence`,
      "campaign_evidence_bound",
      "codex_comparison_controller",
      launcherObservedAt,
      `sha256:${campaignDigest}`,
      eventProvenance("agent_host", "campaign_evidence_digest", campaignDigest),
    ),
  ];
  const outcome = classifyRunOutcome(arrivals, exit);
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

const RETAINED_RUN_FILES = Object.freeze([
  "prompt.txt",
  "planned-workspace-manifest.json",
  "launch-claim.json",
  "launcher-start.json",
  "codex.jsonl",
  "codex.stderr",
  "jsonl-arrivals.jsonl",
  "pre-filesystem-manifest.json",
  "post-filesystem-manifest.json",
  "launcher-record.json",
  "observer.json",
]);

const LAUNCHER_START_KEYS = Object.freeze([
  "launcher_schema_version", "invocation_id", "command", "args", "cwd", "model", "codex_version",
  "started_at", "timeout_ms", "prompt_sha256", "plan_sha256", "source_fingerprints",
  "runtime_fingerprints",
  "environment_contract",
]);

const LAUNCHER_RECORD_KEYS = Object.freeze([
  ...LAUNCHER_START_KEYS,
  "finished_at", "exit", "stdout_sha256", "stderr_sha256", "arrival_count", "parse_error_count",
  "completed_pdf_call_count", "classified_outcome", "host_diagnostics", "limitations",
]);

const ARRIVAL_KEYS = Object.freeze([
  "arrival_schema_version", "line_number", "observed_at", "line_sha256", "event", "parse_error",
]);

function rawJsonlLines(text) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map(line => line.replace(/\r$/, ""));
}

async function verifyCompletedRunEvidence({ campaignRoot, campaign, plan, job, run, entry }) {
  const runRoot = await assertDirectoryChain(
    campaignRoot, path.join(campaignRoot, run.directory), "Campaign run directory",
  );
  const workspace = await assertDirectoryChain(
    runRoot, path.join(runRoot, "workspace"), "Campaign workspace",
  );
  for (const filename of RETAINED_RUN_FILES) {
    const stat = await fs.lstat(path.join(runRoot, filename));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${run.directory}/${filename} must be a retained regular file`);
    }
  }
  const [
    prompt, plannedManifestText, claimText, launcherStartText, rawText, stderrBytes, arrivalsText,
    preManifestText, postManifestText, launcherText, observerText,
  ] = await Promise.all([
    fs.readFile(path.join(runRoot, "prompt.txt"), "utf8"),
    fs.readFile(path.join(runRoot, "planned-workspace-manifest.json"), "utf8"),
    fs.readFile(path.join(runRoot, "launch-claim.json"), "utf8"),
    fs.readFile(path.join(runRoot, "launcher-start.json"), "utf8"),
    fs.readFile(path.join(runRoot, "codex.jsonl"), "utf8"),
    fs.readFile(path.join(runRoot, "codex.stderr")),
    fs.readFile(path.join(runRoot, "jsonl-arrivals.jsonl"), "utf8"),
    fs.readFile(path.join(runRoot, "pre-filesystem-manifest.json"), "utf8"),
    fs.readFile(path.join(runRoot, "post-filesystem-manifest.json"), "utf8"),
    fs.readFile(path.join(runRoot, "launcher-record.json"), "utf8"),
    fs.readFile(path.join(runRoot, "observer.json"), "utf8"),
  ]);
  if (sha256(prompt) !== run.prompt_sha256
    || sha256(plannedManifestText) !== run.workspace_manifest_raw_sha256) {
    throw new Error(`${run.directory} prompt or planned manifest no longer matches the launch contract`);
  }
  const plannedManifest = JSON.parse(plannedManifestText);
  const claim = JSON.parse(claimText);
  const launcherStart = JSON.parse(launcherStartText);
  const preManifest = JSON.parse(preManifestText);
  const postManifest = JSON.parse(postManifestText);
  for (const [label, manifest] of [
    ["planned", plannedManifest], ["pre", preManifest], ["post", postManifest],
  ]) {
    if (!Array.isArray(manifest.entries)
      || manifest.manifest_sha256 !== sha256(canonicalJson(manifest.entries))) {
      throw new Error(`${run.directory} ${label} manifest failed canonical verification`);
    }
  }
  if (plannedManifest.manifest_sha256 !== run.workspace_manifest_sha256
    || preManifest.manifest_sha256 !== run.workspace_manifest_sha256
    || sha256(canonicalJson(inputSnapshotFromManifest(preManifest))) !== run.input_sha256) {
    throw new Error(`${run.directory} pre-run workspace does not match the frozen inputs`);
  }
  const currentManifest = await snapshotTree(workspace);
  if (currentManifest.manifest_sha256 !== postManifest.manifest_sha256) {
    throw new Error(`${run.directory} workspace changed after post-run capture`);
  }
  exactObjectKeys(claim, ["launch_claim_schema_version", "invocation_id", "claimed_at"], "launch claim");
  if (claim.launch_claim_schema_version !== 1 || claim.invocation_id !== entry.invocation_id
    || !Number.isFinite(Date.parse(claim.claimed_at))) {
    throw new Error(`${run.directory} launch claim does not bind the planned invocation`);
  }
  exactObjectKeys(launcherStart, LAUNCHER_START_KEYS, "launcher start");
  const expectedArgs = buildCodexArgs({ workspace, model: campaign.model });
  if (launcherStart.launcher_schema_version !== 1
    || launcherStart.invocation_id !== entry.invocation_id
    || launcherStart.command !== campaign.codex_executable
    || launcherStart.cwd !== workspace
    || launcherStart.model !== campaign.model
    || launcherStart.codex_version !== campaign.codex_version
    || launcherStart.timeout_ms !== campaign.timeout_ms
    || launcherStart.prompt_sha256 !== run.prompt_sha256
    || launcherStart.plan_sha256 !== campaign.plan_sha256
    || !Number.isFinite(Date.parse(launcherStart.started_at))
    || Date.parse(claim.claimed_at) > Date.parse(launcherStart.started_at)
    || canonicalJson(launcherStart.args) !== canonicalJson(expectedArgs)
    || canonicalJson(launcherStart.source_fingerprints) !== canonicalJson(campaign.source_fingerprints)
    || canonicalJson(launcherStart.runtime_fingerprints) !== canonicalJson(campaign.runtime_fingerprints)
    || canonicalJson(launcherStart.environment_contract) !== canonicalJson(campaign.environment_contract)) {
    throw new Error(`${run.directory} launcher start record does not match the frozen launch contract`);
  }
  const launcher = JSON.parse(launcherText);
  exactObjectKeys(launcher, LAUNCHER_RECORD_KEYS, "launcher record");
  exactObjectKeys(launcher.exit, ["exit_code", "signal", "timed_out", "spawn_error"], "launcher exit");
  for (const [key, value] of Object.entries(launcherStart)) {
    if (canonicalJson(launcher[key]) !== canonicalJson(value)) {
      throw new Error(`${run.directory} launcher record changed start field ${key}`);
    }
  }
  if (!Number.isFinite(Date.parse(launcher.finished_at))
    || Date.parse(launcher.finished_at) < Date.parse(launcher.started_at)
    || typeof launcher.exit.timed_out !== "boolean"
    || (launcher.exit.exit_code !== null && !Number.isInteger(launcher.exit.exit_code))
    || (launcher.exit.signal !== null && typeof launcher.exit.signal !== "string")
    || (launcher.exit.spawn_error !== null && typeof launcher.exit.spawn_error !== "string")) {
    throw new Error(`${run.directory} launcher completion record is invalid`);
  }
  if (launcher.stdout_sha256 !== sha256(rawText)
    || launcher.stderr_sha256 !== sha256(stderrBytes)) {
    throw new Error(`${run.directory} launcher stdout/stderr digests do not match retained bytes`);
  }
  const rawLines = rawJsonlLines(rawText);
  const arrivals = rawJsonlLines(arrivalsText).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`${run.directory} arrival ledger line ${index + 1} is not JSON`);
    }
  });
  if (arrivals.length !== rawLines.length || launcher.arrival_count !== arrivals.length) {
    throw new Error(`${run.directory} arrival ledger does not cover the raw transcript denominator`);
  }
  for (const [index, arrival] of arrivals.entries()) {
    exactObjectKeys(arrival, ARRIVAL_KEYS, `arrival ${index + 1}`);
    if (arrival.arrival_schema_version !== 1
      || arrival.line_number !== index + 1
      || arrival.line_sha256 !== sha256(rawLines[index])
      || !Number.isFinite(Date.parse(arrival.observed_at))
      || Date.parse(arrival.observed_at) < Date.parse(launcher.started_at)
      || Date.parse(arrival.observed_at) > Date.parse(launcher.finished_at)) {
      throw new Error(`${run.directory} arrival ${index + 1} failed line/timestamp verification`);
    }
    try {
      const event = JSON.parse(rawLines[index]);
      if (arrival.parse_error !== null || canonicalJson(arrival.event) !== canonicalJson(event)) {
        throw new Error(`${run.directory} arrival ${index + 1} changed its parsed event`);
      }
    } catch (error) {
      if (error.message.includes("changed its parsed event")) throw error;
      if (arrival.event !== null || arrival.parse_error !== error.message) {
        throw new Error(`${run.directory} arrival ${index + 1} did not retain its parse failure`);
      }
    }
  }
  const parseErrorCount = arrivals.filter(item => item.parse_error !== null).length;
  if (launcher.parse_error_count !== parseErrorCount
    || launcher.completed_pdf_call_count !== completedPdfCalls(arrivals).length
    || launcher.classified_outcome !== classifyRunOutcome(arrivals, launcher.exit)
    || canonicalJson(launcher.host_diagnostics) !== canonicalJson(hostDiagnostics(arrivals))
    || canonicalJson(launcher.limitations) !== canonicalJson([HOST_LIMITATION, TRANSPORT_LIMITATION])) {
    throw new Error(`${run.directory} launcher summary does not replay from retained arrivals`);
  }
  const observer = JSON.parse(observerText);
  if (observer.outcome !== launcher.classified_outcome) {
    throw new Error(`${run.directory} observer outcome does not match replayed classification`);
  }
  const launcherSha256 = sha256(launcherText);
  const launcherEvent = observer.run?.events?.find(event => event?.type === "agent_launch_observed");
  const campaignEvent = observer.run?.events?.find(event => event?.type === "campaign_evidence_bound");
  const campaignDigest = campaignEvidenceDigest({
    campaign,
    launcherRecordSha256: launcherSha256,
    launchClaimRawSha256: sha256(claimText),
    launcherStartRawSha256: sha256(launcherStartText),
    arrivalsRawSha256: sha256(arrivalsText),
    preManifestRawSha256: sha256(preManifestText),
    postManifestRawSha256: sha256(postManifestText),
  });
  if (launcherEvent?.reference !== `sha256:${launcherSha256}`
    || launcherEvent?.provenance?.raw_sha256 !== launcherSha256
    || campaignEvent?.reference !== `sha256:${campaignDigest}`
    || campaignEvent?.provenance?.raw_sha256 !== campaignDigest) {
    throw new Error(`${run.directory} observer does not bind the launcher and campaign evidence`);
  }
  const planEvent = observer.run.events.find(event => event?.type === "run_plan_committed");
  const inputEvent = observer.run.events.find(event => event?.type === "input_snapshot_observed");
  const effectsEvent = observer.run.events.find(event => event?.type === "effects_observed");
  if (planEvent?.provenance?.raw_sha256 !== campaign.plan_raw_sha256
    || inputEvent?.provenance?.raw_sha256 !== sha256(preManifestText)
    || effectsEvent?.provenance?.raw_sha256 !== sha256(postManifestText)) {
    throw new Error(`${run.directory} observer filesystem/plan provenance does not match retained files`);
  }
  for (const [label, observedAt] of [
    ["input", inputEvent?.observed_at],
    ["effects", effectsEvent?.observed_at],
    ["launcher", launcherEvent?.observed_at],
  ]) {
    if (!Number.isFinite(Date.parse(observedAt))) {
      throw new Error(`${run.directory} observer ${label} timestamp is invalid`);
    }
  }
  if (Date.parse(inputEvent.observed_at) < Date.parse(launcher.started_at)
    || Date.parse(effectsEvent.observed_at) < Date.parse(inputEvent.observed_at)
    || Date.parse(launcher.finished_at) < Date.parse(effectsEvent.observed_at)
    || Date.parse(launcherEvent.observed_at) < Date.parse(launcher.finished_at)
    || !Number.isFinite(Date.parse(observer.run?.finished_at))
    || Date.parse(observer.run.finished_at) < Date.parse(launcherEvent.observed_at)) {
    throw new Error(`${run.directory} observer timestamps are not monotonic`);
  }
  const expectedObserver = buildObserver({
    campaign,
    plan,
    entry,
    job,
    arrivals,
    preManifest,
    postManifest,
    preManifestRawSha256: sha256(preManifestText),
    postManifestRawSha256: sha256(postManifestText),
    planRawSha256: campaign.plan_raw_sha256,
    stdoutSha256: launcher.stdout_sha256,
    stderrSha256: launcher.stderr_sha256,
    launcherRecordSha256: launcherSha256,
    launchClaimRawSha256: sha256(claimText),
    launcherStartRawSha256: sha256(launcherStartText),
    arrivalsRawSha256: sha256(arrivalsText),
    startedAt: launcher.started_at,
    preObservedAt: inputEvent.observed_at,
    effectsObservedAt: effectsEvent.observed_at,
    launcherObservedAt: launcherEvent.observed_at,
    finishedAt: observer.run.finished_at,
    exit: launcher.exit,
  });
  if (canonicalJson(observer) !== canonicalJson(expectedObserver)) {
    throw new Error(`${run.directory} observer cannot be rederived from retained run evidence`);
  }
  return { runRoot, observer, launcher, arrivals };
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
  return `pdf-tools.trajectory.codex-comparison.${now.replace(/[-:.TZ]/g, "")}.${randomBytes(8).toString("hex")}`;
}

export async function planCampaign({
  campaignPath,
  count,
  model,
  timeoutMs,
  documentsRoot = DOCUMENTS_ROOT,
  codexExecutable = "codex",
}) {
  const campaignRoot = await assertCampaignPath(campaignPath, documentsRoot, { mayNotExist: true });
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
    const manifestText = await writeJson(
      path.join(runRoot, "planned-workspace-manifest.json"), manifest, { exclusive: true },
    );
    const promptText = `${buildPrompt(job)}\n`;
    await fs.writeFile(path.join(runRoot, "prompt.txt"), promptText, { flag: "wx", mode: 0o600 });
    runs.push({
      repeat_index: entry.repeat_index,
      invocation_id: entry.invocation_id,
      directory: normalizeRelative(directory),
      workspace_manifest_sha256: manifest.manifest_sha256,
      workspace_manifest_raw_sha256: sha256(manifestText),
      input_sha256: sha256(canonicalJson(inputSnapshot)),
      prompt_sha256: sha256(promptText),
    });
  }
  const planText = await writeJson(path.join(campaignRoot, "pre-run-plan.json"), plan, { exclusive: true });
  const finalSuite = await loadSuite();
  if (sha256(canonicalJson(finalSuite)) !== plan.suite_sha256) {
    throw new Error("Trajectory suite changed while the pre-run plan was being created");
  }
  const resolvedCodexExecutable = await resolveExecutable(codexExecutable);
  const environmentContract = captureLaunchEnvironment();
  const launchEnvironment = buildLaunchEnvironment(environmentContract);
  const codexVersion = await commandOutput(resolvedCodexExecutable, ["--version"], { env: launchEnvironment });
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
    codex_executable: resolvedCodexExecutable,
    codex_version: codexVersion,
    node_runtime: nodeRuntime(),
    runtime_fingerprints: await runtimeFingerprints(resolvedCodexExecutable),
    environment_contract: environmentContract,
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
    "created_at", "timeout_ms", "codex_executable", "codex_version", "node_runtime", "runtime_fingerprints",
    "environment_contract", "git_commit", "suite_sha256", "plan_sha256",
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
  if (!path.isAbsolute(campaign.codex_executable) || !isObjectRecord(campaign.runtime_fingerprints)
    || !isObjectRecord(campaign.environment_contract)) {
    throw new Error("Campaign runtime fingerprints and Codex executable are invalid");
  }
  buildLaunchEnvironment(campaign.environment_contract);
  if (!Number.isInteger(campaign.timeout_ms) || campaign.timeout_ms < 1_000) {
    throw new Error("Campaign timeout must be at least 1000 ms");
  }
  exactObjectKeys(campaign.node_runtime, ["version", "modules", "napi", "v8"], "campaign.node_runtime");
  const planByRepeat = new Map(plan.entries.map(entry => [entry.repeat_index, entry]));
  const seenRepeats = new Set();
  for (const run of campaign.runs) {
    exactObjectKeys(run, [
      "repeat_index", "invocation_id", "directory", "workspace_manifest_sha256",
      "workspace_manifest_raw_sha256", "input_sha256", "prompt_sha256",
    ], "campaign.runs[]");
    const entry = planByRepeat.get(run.repeat_index);
    if (!entry || entry.invocation_id !== run.invocation_id || seenRepeats.has(run.repeat_index)) {
      throw new Error("Campaign run entries must map one-to-one to the frozen plan");
    }
    if (run.directory !== normalizeRelative(path.join("runs", runName(run.repeat_index)))) {
      throw new Error("Campaign run directory does not match its repeat index");
    }
    for (const key of [
      "workspace_manifest_sha256", "workspace_manifest_raw_sha256", "input_sha256", "prompt_sha256",
    ]) {
      if (!/^[a-f0-9]{64}$/.test(run[key])) throw new Error(`Campaign ${key} must be SHA-256`);
    }
    seenRepeats.add(run.repeat_index);
  }
}

async function loadCampaign(campaignPath, { documentsRoot = DOCUMENTS_ROOT } = {}) {
  const campaignRoot = await assertCampaignPath(campaignPath, documentsRoot);
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
  const launchEnvironment = buildLaunchEnvironment(campaign.environment_contract);
  const currentCodexVersion = await commandOutput(
    campaign.codex_executable, ["--version"], { env: launchEnvironment },
  );
  if (currentCodexVersion !== campaign.codex_version) throw new Error("Codex CLI version changed after planning");
  if (canonicalJson(nodeRuntime()) !== canonicalJson(campaign.node_runtime)) {
    throw new Error("Node.js runtime changed after planning");
  }
  if (canonicalJson(await runtimeFingerprints(campaign.codex_executable))
    !== canonicalJson(campaign.runtime_fingerprints)) {
    throw new Error("Installed Codex, Node, or PDF runtime changed after planning");
  }
  return { campaignRoot, campaign, plan, suite, job, planText };
}

async function appendArrival(stream, arrival) {
  await new Promise((resolve, reject) => {
    stream.write(`${JSON.stringify(arrival)}\n`, error => error ? reject(error) : resolve());
  });
}

async function runCodexProcess({
  executable, args, prompt, cwd, timeoutMs, stdoutPath, stderrPath, arrivalsPath, environment,
}) {
  const stdoutStream = fsSync.createWriteStream(stdoutPath, { flags: "wx", mode: 0o600 });
  const stderrStream = fsSync.createWriteStream(stderrPath, { flags: "wx", mode: 0o600 });
  const arrivalStream = fsSync.createWriteStream(arrivalsPath, { flags: "wx", mode: 0o600 });
  const collector = new JsonlArrivalCollector();
  const arrivalWrites = [];
  let spawnError = null;
  let timedOut = false;
  let timeout;
  const result = await new Promise(resolve => {
    const child = spawn(executable, args, { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] });
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

export async function runCampaignEntry({ campaignPath, repeatIndex, documentsRoot = DOCUMENTS_ROOT }) {
  const { campaignRoot, campaign, plan, job, planText } = await loadCampaign(
    campaignPath, { documentsRoot },
  );
  const entry = plan.entries.find(item => item.repeat_index === repeatIndex);
  const run = campaign.runs.find(item => item.repeat_index === repeatIndex);
  if (!entry || !run) throw new Error(`Repeat ${repeatIndex} is outside the frozen denominator`);
  const plannedInputs = await validatePlannedRunInputs({ campaignRoot, run });
  const runRoot = plannedInputs.runRoot;
  const claimText = await writeJson(path.join(runRoot, "launch-claim.json"), {
    launch_claim_schema_version: 1,
    invocation_id: entry.invocation_id,
    claimed_at: isoNow(),
  }, { exclusive: true });
  const claimedInputs = await validatePlannedRunInputs({ campaignRoot, run });
  const workspace = claimedInputs.workspace;
  const startedAt = isoNow();
  const preManifest = claimedInputs.currentManifest;
  const preObservedAt = isoNow();
  const preText = await writeJson(path.join(runRoot, "pre-filesystem-manifest.json"), preManifest, { exclusive: true });
  const prompt = claimedInputs.prompt;
  const args = buildCodexArgs({ workspace, model: campaign.model });
  const launcherStart = {
    launcher_schema_version: 1,
    invocation_id: entry.invocation_id,
    command: campaign.codex_executable,
    args,
    cwd: workspace,
    model: campaign.model,
    codex_version: campaign.codex_version,
    started_at: startedAt,
    timeout_ms: campaign.timeout_ms,
    prompt_sha256: sha256(prompt),
    plan_sha256: campaign.plan_sha256,
    source_fingerprints: campaign.source_fingerprints,
    runtime_fingerprints: campaign.runtime_fingerprints,
    environment_contract: campaign.environment_contract,
  };
  const launcherStartText = await writeJson(
    path.join(runRoot, "launcher-start.json"), launcherStart, { exclusive: true },
  );
  await validatePlannedRunInputs({ campaignRoot, run });
  const processResult = await runCodexProcess({
    executable: campaign.codex_executable,
    args,
    prompt,
    cwd: workspace,
    timeoutMs: campaign.timeout_ms,
    stdoutPath: path.join(runRoot, "codex.jsonl"),
    stderrPath: path.join(runRoot, "codex.stderr"),
    arrivalsPath: path.join(runRoot, "jsonl-arrivals.jsonl"),
    environment: buildLaunchEnvironment(campaign.environment_contract),
  });
  const postManifest = await snapshotTree(workspace);
  const effectsObservedAt = isoNow();
  const postText = await writeJson(path.join(runRoot, "post-filesystem-manifest.json"), postManifest, { exclusive: true });
  const stdoutBytes = await fs.readFile(path.join(runRoot, "codex.jsonl"));
  const stderrBytes = await fs.readFile(path.join(runRoot, "codex.stderr"));
  const diagnostics = hostDiagnostics(processResult.arrivals);
  const launcherRecord = {
    ...launcherStart,
    finished_at: isoNow(),
    exit: processResult.exit,
    stdout_sha256: sha256(stdoutBytes),
    stderr_sha256: sha256(stderrBytes),
    arrival_count: processResult.arrivals.length,
    parse_error_count: processResult.arrivals.filter(item => item.parse_error).length,
    completed_pdf_call_count: completedPdfCalls(processResult.arrivals).length,
    classified_outcome: classifyRunOutcome(processResult.arrivals, processResult.exit),
    host_diagnostics: diagnostics,
    limitations: [HOST_LIMITATION, TRANSPORT_LIMITATION],
  };
  const launcherText = await writeJson(path.join(runRoot, "launcher-record.json"), launcherRecord, { exclusive: true });
  const arrivalsText = await fs.readFile(path.join(runRoot, "jsonl-arrivals.jsonl"), "utf8");
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
    launchClaimRawSha256: sha256(claimText),
    launcherStartRawSha256: sha256(launcherStartText),
    arrivalsRawSha256: sha256(arrivalsText),
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

export async function finalizeCampaign(campaignPath, { documentsRoot = DOCUMENTS_ROOT } = {}) {
  const { campaignRoot, campaign, plan, job } = await loadCampaign(campaignPath, { documentsRoot });
  for (const run of campaign.runs) {
    const entry = plan.entries.find(item => item.repeat_index === run.repeat_index);
    if (!entry) throw new Error(`${run.directory} is absent from the frozen run plan`);
    try {
      await verifyCompletedRunEvidence({ campaignRoot, campaign, plan, job, run, entry });
    } catch (error) {
      throw new Error(`Frozen denominator is unresolved or invalid for ${run.directory}: ${error.message}`);
    }
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
  await writeText(path.join(campaignRoot, "ingester.stdout"), `${ingesterStdout}\n`);
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
