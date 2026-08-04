#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { scoreShannonMarkdown } from "../test/eval/shannon-markdown-scorer.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST = path.join(REPO_ROOT, "test", "fixtures", "eval", "shannon", "manifest.v1.json");
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_SHA1 = /^[a-f0-9]{40}$/u;
const OPTIONS = ["--manifest", "--source", "--pdf-inspector-root", "--output-dir"];
const RUNTIME_SOURCE_FILES = [
  "package.json",
  "package-lock.json",
  "server/index.js",
  "server/output-schemas.js",
  "server/pdfjs-subprocess.js",
  "server/pdfjs-worker.js",
  "server/layout-extraction.js",
  "server/type3-cm-reference.js",
  "server/markdown-conversion.js",
  "server/markdown-output-transaction.js",
];

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactOptions(argv) {
  if (argv.length === 0) return { "--manifest": DEFAULT_MANIFEST };
  if (argv.length % 2 !== 0) throw new Error(`Expected option/value pairs: ${OPTIONS.join(", ")}`);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!OPTIONS.includes(name) || Object.hasOwn(values, name) || !value) {
      throw new Error(`Unknown, duplicate, or empty option: ${name}`);
    }
    values[name] = value;
  }
  return values;
}

async function canonicalRegular(filename, maximumBytes, label) {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename || typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error(`${label} must be an absolute normalized regular-file path`);
  }
  if (await fs.realpath(filename) !== filename) throw new Error(`${label} must be canonical`);
  const before = await fs.lstat(filename, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n
    || before.size > BigInt(maximumBytes)) {
    throw new Error(`${label} violates its bounded single-link regular-file contract`);
  }
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const descriptorBefore = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const [descriptorAfter, after] = await Promise.all([handle.stat({ bigint: true }), fs.lstat(filename, { bigint: true })]);
    const identity = value => ["dev", "ino", "size", "mtimeNs", "ctimeNs"].map(key => String(value[key])).join(":");
    if (identity(before) !== identity(descriptorBefore) || identity(before) !== identity(descriptorAfter)
      || identity(before) !== identity(after) || BigInt(bytes.length) !== before.size) {
      throw new Error(`${label} changed while it was read`);
    }
    return { bytes, size_bytes: bytes.length, sha256: sha256(bytes) };
  } finally {
    await handle.close();
  }
}

async function canonicalDirectory(filename, label) {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename || await fs.realpath(filename) !== filename) {
    throw new Error(`${label} must be an absolute canonical directory`);
  }
  const metadata = await fs.lstat(filename);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a directory`);
  return filename;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} has unexpected keys`);
  }
}

export function validateShannonManifest(manifest) {
  exactKeys(manifest, [
    "suite_id", "suite_version", "benchmark_claim_ready", "calibration_claim_ready",
    "source", "execution", "candidates", "oracle",
  ], "Shannon manifest");
  if (manifest.suite_id !== "pdf-tools.shannon-markdown-adversarial.v1" || manifest.suite_version !== 1
    || manifest.benchmark_claim_ready !== false || manifest.calibration_claim_ready !== false) {
    throw new Error("Shannon manifest claim boundary is invalid");
  }
  const source = manifest.source;
  if (!source || source.redistribution !== "external_only" || !/^https:\/\//u.test(source.url)
    || !SHA256.test(source.sha256) || !Number.isSafeInteger(source.size_bytes) || source.size_bytes < 1
    || source.page_count !== 55) {
    throw new Error("Shannon external source binding is invalid");
  }
  const execution = manifest.execution;
  if (execution?.repetitions !== 3 || execution.pdf_tools_page_span !== 10
    || !Number.isSafeInteger(execution.deadline_ms) || execution.deadline_ms < 1000
    || !Number.isSafeInteger(execution.max_stdout_bytes) || execution.max_stdout_bytes < 200000
    || !Number.isSafeInteger(execution.max_stderr_bytes) || execution.max_stderr_bytes < 1000) {
    throw new Error("Shannon execution contract is invalid");
  }
  const pdfInspector = manifest.candidates?.pdf_inspector;
  if (pdfInspector?.slot !== "candidate.direct_pdf.v1" || !GIT_SHA1.test(pdfInspector.revision)
    || !SHA256.test(pdfInspector.resolved_lock_sha256) || pdfInspector.license !== "MIT") {
    throw new Error("pdf-inspector candidate binding is invalid");
  }
  if (manifest.candidates?.pdf_tools?.slot !== "control.current_product.v0"
    || manifest.candidates?.layout_reference?.slot !== "candidate.layout_ir.v1"
    || manifest.candidates.layout_reference.status !== "not_run") {
    throw new Error("Candidate slot projection is invalid");
  }
  if (!manifest.oracle || !Array.isArray(manifest.oracle.expected_headings)
    || !Array.isArray(manifest.oracle.ordered_anchor_groups)
    || !Array.isArray(manifest.oracle.paragraph_continuity)
    || !Array.isArray(manifest.oracle.equation_anchors)
    || !Array.isArray(manifest.oracle.footnote_anchors)
    || !Array.isArray(manifest.oracle.exactly_once_anchors)) {
    throw new Error("Shannon sampled oracle is invalid");
  }
  if (!Number.isSafeInteger(manifest.oracle.equation_max_span_characters)
    || manifest.oracle.equation_max_span_characters < 20
    || manifest.oracle.equation_max_span_characters > 500
    || manifest.oracle.equation_anchors.some(anchor => {
      try {
        exactKeys(anchor, ["page", "tokens"], "Shannon equation anchor");
      } catch {
        return true;
      }
      return !Number.isSafeInteger(anchor.page) || anchor.page < 1 || anchor.page > source.page_count
        || !Array.isArray(anchor.tokens) || anchor.tokens.length < 2
        || anchor.tokens.some(token => typeof token !== "string" || token.trim().length < 1);
    })) {
    throw new Error("Shannon sampled oracle is invalid");
  }
  return manifest;
}

function appendBounded(chunks, state, chunk, maximumBytes, label, onOverflow) {
  state.observed += chunk.length;
  if (state.observed > maximumBytes) {
    if (!state.error) {
      state.error = new Error(`${label} exceeded ${maximumBytes} bytes`);
      onOverflow(state.error);
    }
    return;
  }
  chunks.push(chunk);
}

function parseMaximumRss(stderr) {
  const matches = [...stderr.matchAll(/(?:^|\n)\s*(\d+)\s+maximum resident set size\b/gu)];
  if (matches.length !== 1) return null;
  const bytes = Number(matches[0][1]);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

async function waitForExit(child, deadlineMs, label) {
  let timer;
  try {
    return await Promise.race([
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`${label} exceeded its wall-clock deadline`));
        }, deadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runPdfInspector({ binary, sourcePath, manifest }) {
  const stdout = [];
  const stderr = [];
  const stdoutState = { observed: 0 };
  const stderrState = { observed: 0 };
  const started = process.hrtime.bigint();
  const child = spawn("/usr/bin/time", ["-l", binary, sourcePath, "--json", "--pages"], {
    cwd: path.dirname(binary),
    env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitPromise = waitForExit(child, manifest.execution.deadline_ms, "pdf-inspector");
  const terminate = () => child.kill("SIGTERM");
  child.stdout.on("data", chunk => appendBounded(stdout, stdoutState, chunk, manifest.execution.max_stdout_bytes, "pdf-inspector stdout", terminate));
  child.stderr.on("data", chunk => appendBounded(stderr, stderrState, chunk, manifest.execution.max_stderr_bytes, "pdf-inspector stderr", terminate));
  const exit = await exitPromise;
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const stdoutBytes = Buffer.concat(stdout);
  const stderrText = Buffer.concat(stderr).toString("utf8");
  if (stdoutState.error) throw stdoutState.error;
  if (stderrState.error) throw stderrState.error;
  if (exit.code !== 0 || exit.signal !== null) throw new Error(`pdf-inspector exited with code ${exit.code} and signal ${exit.signal}`);
  let response;
  try {
    response = JSON.parse(stdoutBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`pdf-inspector did not return one JSON value: ${error.message}`);
  }
  if (response.pdf_type !== "text_based" || response.page_count !== manifest.source.page_count
    || response.has_text !== true || !Array.isArray(response.pages_needing_ocr)
    || response.pages_needing_ocr.length !== 0 || typeof response.markdown !== "string" || response.markdown.length < 1) {
    throw new Error("pdf-inspector response violates the Shannon candidate contract");
  }
  return {
    markdown: response.markdown,
    attempt: {
      elapsed_ms: Math.round(elapsedMs * 1000) / 1000,
      maximum_resident_set_size_bytes: parseMaximumRss(stderrText),
      stdout_bytes: stdoutBytes.length,
      stderr_bytes: Buffer.byteLength(stderrText),
      reported_processing_time_ms: response.processing_time_ms,
      pdf_type: response.pdf_type,
      pages_needing_ocr: response.pages_needing_ocr,
      is_complex: response.is_complex,
      pages_with_tables: response.pages_with_tables,
      pages_with_columns: response.pages_with_columns,
      has_encoding_issues: response.has_encoding_issues,
    },
  };
}

function createJsonRpc(child, maximumBytes) {
  let pending = "";
  let observed = 0;
  let nextId = 1;
  const waiting = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    observed += Buffer.byteLength(chunk);
    if (observed > maximumBytes) {
      for (const { reject } of waiting.values()) reject(new Error("PDF Tools MCP stdout exceeded its retained byte ceiling"));
      waiting.clear();
      child.kill("SIGTERM");
      return;
    }
    pending += chunk;
    while (pending.includes("\n")) {
      const boundary = pending.indexOf("\n");
      const line = pending.slice(0, boundary);
      pending = pending.slice(boundary + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        for (const { reject } of waiting.values()) reject(new Error(`PDF Tools emitted invalid JSON-RPC: ${error.message}`));
        waiting.clear();
        continue;
      }
      if (!Object.hasOwn(message, "id") || !waiting.has(message.id)) continue;
      const waiter = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) waiter.reject(new Error(`PDF Tools JSON-RPC error ${message.error.code}: ${message.error.message}`));
      else waiter.resolve(message.result);
    }
  });
  child.once("close", (code, signal) => {
    for (const { reject } of waiting.values()) {
      reject(new Error(`PDF Tools MCP server closed with code ${code} and signal ${signal}`));
    }
    waiting.clear();
  });
  const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
  return {
    get observedBytes() { return observed; },
    notify(method, params = {}) { send({ jsonrpc: "2.0", method, params }); },
    request(method, params, deadlineMs) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`PDF Tools ${method} request timed out`));
        }, deadlineMs);
        waiting.set(id, {
          resolve: value => { clearTimeout(timer); resolve(value); },
          reject: error => { clearTimeout(timer); reject(error); },
        });
        send({ jsonrpc: "2.0", id, method, params });
      });
    },
  };
}

function validatePdfToolsChunk(result, { source, startPage, endPage, manifest }) {
  const value = result?.structuredContent;
  if (result?.isError === true || !value || typeof value.markdown !== "string" || value.markdown.length < 1
    || value.renderer?.name !== manifest.candidates.pdf_tools.renderer_name
    || value.renderer?.version !== manifest.candidates.pdf_tools.renderer_version
    || value.provenance?.layout?.parser_name !== manifest.candidates.pdf_tools.parser_name
    || value.provenance?.layout?.parser_version !== manifest.candidates.pdf_tools.parser_version
    || value.provenance?.source?.sha256 !== source.sha256
    || value.provenance?.source?.size_bytes !== source.size_bytes
    || value.provenance?.layout?.page_range?.start_page !== startPage
    || value.provenance?.layout?.page_range?.end_page !== endPage
    || value.provenance?.layout?.page_range?.total_pages !== manifest.source.page_count
    || value.markdown_sha256 !== sha256(Buffer.from(value.markdown, "utf8"))
    || value.markdown_bytes !== Buffer.byteLength(value.markdown, "utf8")
    || !Array.isArray(value.gaps) || !Array.isArray(value.pages)) {
    throw new Error(`PDF Tools Markdown evidence is invalid for pages ${startPage}-${endPage}: ${JSON.stringify({
      is_error: result?.isError ?? null,
      error_text: result?.isError === true && typeof result?.content?.[0]?.text === "string"
        ? result.content[0].text.slice(0, 1000)
        : null,
      has_structured_content: Boolean(value),
      renderer: value?.renderer ?? null,
      provenance: value?.provenance ?? null,
      markdown_bytes_valid: typeof value?.markdown === "string"
        && value.markdown_bytes === Buffer.byteLength(value.markdown, "utf8"),
      markdown_sha256_valid: typeof value?.markdown === "string"
        && value.markdown_sha256 === sha256(Buffer.from(value.markdown, "utf8")),
      gaps_array: Array.isArray(value?.gaps),
      pages_array: Array.isArray(value?.pages),
    })}`);
  }
  return value;
}

async function runPdfTools({ sourcePath, source, manifest, stateRoot }) {
  const stderr = [];
  const stderrState = { observed: 0 };
  const serverEntry = path.join(REPO_ROOT, "server", "index.js");
  const child = spawn("/usr/bin/time", ["-l", process.execPath, serverEntry], {
    cwd: REPO_ROOT,
    env: {
      ALLOWED_DIRECTORIES: path.dirname(sourcePath),
      DEFAULT_DOWNLOAD_DIR: stateRoot,
      DEFAULT_PDF_DIR: path.dirname(sourcePath),
      DEFAULT_PROFILES_DIR: path.join(stateRoot, "profiles"),
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      PDF_TOOLS_DISABLE_SYSTEM_RENDERER: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exitPromise = waitForExit(child, manifest.execution.deadline_ms + 30000, "PDF Tools MCP server");
  child.stderr.on("data", chunk => appendBounded(
    stderr,
    stderrState,
    chunk,
    manifest.execution.max_stderr_bytes,
    "PDF Tools stderr",
    () => child.kill("SIGTERM"),
  ));
  const rpc = createJsonRpc(child, manifest.execution.max_stdout_bytes);
  const started = process.hrtime.bigint();
  let chunks;
  let forcedShutdown;
  try {
    await rpc.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "pdf-tools-shannon-bakeoff", version: "1.0.0" },
    }, 30000);
    rpc.notify("notifications/initialized");
    chunks = [];
    for (let startPage = 1; startPage <= manifest.source.page_count; startPage += manifest.execution.pdf_tools_page_span) {
      const endPage = Math.min(manifest.source.page_count, startPage + manifest.execution.pdf_tools_page_span - 1);
      const result = await rpc.request("tools/call", {
        name: "convert_pdf_to_markdown",
        arguments: {
          pdf_path: sourcePath,
          start_page: startPage,
          end_page: endPage,
          max_items: 5000,
          max_characters: 100000,
          max_markdown_bytes: 200000,
          include_page_boundaries: true,
        },
      }, manifest.execution.deadline_ms);
      chunks.push(validatePdfToolsChunk(result, { source, startPage, endPage, manifest }));
    }
  } finally {
    child.stdin.end();
    forcedShutdown = setTimeout(() => child.kill("SIGTERM"), 5000);
  }
  const exit = await exitPromise.finally(() => clearTimeout(forcedShutdown));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const stderrText = Buffer.concat(stderr).toString("utf8");
  if (stderrState.error) throw stderrState.error;
  if (exit.code !== 0 && exit.code !== 143 && exit.signal !== "SIGTERM") {
    throw new Error(`PDF Tools server exited with code ${exit.code} and signal ${exit.signal}`);
  }
  const markdown = chunks.map(chunk => chunk.markdown).join("\n\n");
  return {
    markdown,
    attempt: {
      elapsed_ms: Math.round(elapsedMs * 1000) / 1000,
      maximum_resident_set_size_bytes: parseMaximumRss(stderrText),
      stdout_bytes: rpc.observedBytes,
      stderr_bytes: Buffer.byteLength(stderrText),
      page_calls: chunks.map(chunk => ({
        start_page: chunk.provenance.layout.page_range.start_page,
        end_page: chunk.provenance.layout.page_range.end_page,
        conversion_status: chunk.conversion_status,
        markdown_bytes: chunk.markdown_bytes,
        gap_count: chunk.gaps.length,
      })),
      conversion_statuses: [...new Set(chunks.map(chunk => chunk.conversion_status))].sort(),
      total_gap_count: chunks.reduce((total, chunk) => total + chunk.gaps.length, 0),
    },
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function gitValue(root, args) {
  const { stdout } = await execFileAsync("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function runtimeSourceIdentity() {
  const files = [];
  for (const relativePath of RUNTIME_SOURCE_FILES) {
    const retained = await canonicalRegular(path.join(REPO_ROOT, relativePath), 32 * 1024 * 1024, `PDF Tools runtime source ${relativePath}`);
    files.push({ path: relativePath, sha256: retained.sha256, size_bytes: retained.size_bytes });
  }
  const trackedRuntimeStatus = await gitValue(REPO_ROOT, [
    "status", "--porcelain", "--untracked-files=no", "--", ...RUNTIME_SOURCE_FILES,
  ]);
  return {
    git_revision: await gitValue(REPO_ROOT, ["rev-parse", "HEAD"]),
    tracked_runtime_files_clean: trackedRuntimeStatus === "",
    tracked_runtime_status_sha256: trackedRuntimeStatus === ""
      ? null
      : sha256(Buffer.from(trackedRuntimeStatus, "utf8")),
    files,
    source_set_sha256: sha256(Buffer.from(canonicalJson(files))),
  };
}

async function writePrivate(filename, bytes) {
  await fs.writeFile(filename, bytes, { mode: 0o600, flag: "wx" });
  await fs.chmod(filename, 0o600);
}

async function writePrivateExecutable(filename, bytes) {
  await fs.writeFile(filename, bytes, { mode: 0o700, flag: "wx" });
  await fs.chmod(filename, 0o700);
}

async function run(options) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The initial Shannon bakeoff is intentionally calibrated only for macOS arm64");
  }
  const manifestPath = path.resolve(options["--manifest"] ?? DEFAULT_MANIFEST);
  const manifestFile = await canonicalRegular(manifestPath, 1024 * 1024, "Shannon manifest");
  const manifest = validateShannonManifest(JSON.parse(manifestFile.bytes.toString("utf8")));
  const sourcePath = path.resolve(options["--source"] ?? "");
  const inspectorRoot = path.resolve(options["--pdf-inspector-root"] ?? "");
  const outputDir = path.resolve(options["--output-dir"] ?? "");
  if (!sourcePath || !inspectorRoot || !outputDir) {
    throw new Error("--source, --pdf-inspector-root, and --output-dir are required");
  }
  await canonicalDirectory(inspectorRoot, "pdf-inspector source root");
  const repositoryReal = await fs.realpath(REPO_ROOT);
  if (outputDir === repositoryReal || outputDir.startsWith(`${repositoryReal}${path.sep}`)) {
    throw new Error("Shannon output must remain outside the repository and package boundary");
  }
  await fs.mkdir(outputDir, { mode: 0o700, recursive: false });
  await fs.chmod(outputDir, 0o700);
  const canonicalOutput = await canonicalDirectory(outputDir, "Shannon output directory");
  const source = await canonicalRegular(sourcePath, 16 * 1024 * 1024, "Shannon source PDF");
  if (source.sha256 !== manifest.source.sha256 || source.size_bytes !== manifest.source.size_bytes) {
    throw new Error("Shannon source bytes do not match the non-redistributed manifest binding");
  }
  const [revision, trackedStatus] = await Promise.all([
    gitValue(inspectorRoot, ["rev-parse", "HEAD"]),
    gitValue(inspectorRoot, ["status", "--porcelain", "--untracked-files=no"]),
  ]);
  if (revision !== manifest.candidates.pdf_inspector.revision || trackedStatus !== "") {
    throw new Error("pdf-inspector source checkout is not the exact clean pinned revision");
  }
  const lock = await canonicalRegular(path.join(inspectorRoot, "Cargo.lock"), 4 * 1024 * 1024, "pdf-inspector resolved lock");
  if (lock.sha256 !== manifest.candidates.pdf_inspector.resolved_lock_sha256) {
    throw new Error("pdf-inspector resolved lock differs from the reviewed pin");
  }
  const binaryPath = path.join(inspectorRoot, "target", "release", "pdf2md");
  const binary = await canonicalRegular(binaryPath, 64 * 1024 * 1024, "pdf-inspector binary");
  const pdfToolsSource = await runtimeSourceIdentity();
  const attempts = { pdf_tools: [], pdf_inspector: [] };
  const markdownByCandidate = { pdf_tools: [], pdf_inspector: [] };
  const inputRoot = await fs.mkdtemp(path.join(canonicalOutput, ".verified-inputs-"));
  await fs.chmod(inputRoot, 0o700);
  const executionSourcePath = path.join(inputRoot, "shannon-source.pdf");
  const executionBinaryPath = path.join(inputRoot, "pdf2md");
  await writePrivate(executionSourcePath, source.bytes);
  await writePrivateExecutable(executionBinaryPath, binary.bytes);
  try {
    for (let repetition = 1; repetition <= manifest.execution.repetitions; repetition += 1) {
      const sourceBefore = await canonicalRegular(executionSourcePath, 16 * 1024 * 1024, "Shannon source snapshot before attempt");
      const inspector = await runPdfInspector({ binary: executionBinaryPath, sourcePath: executionSourcePath, manifest });
      const stateRoot = await fs.mkdtemp(path.join(canonicalOutput, `.pdf-tools-state-r${repetition}-`));
      await fs.chmod(stateRoot, 0o700);
      let current;
      try {
        current = await runPdfTools({ sourcePath: executionSourcePath, source, manifest, stateRoot });
      } finally {
        await fs.rm(stateRoot, { recursive: true, force: true });
      }
      const [sourceAfter, binaryAfter, runtimeAfter] = await Promise.all([
        canonicalRegular(executionSourcePath, 16 * 1024 * 1024, "Shannon source snapshot after attempt"),
        canonicalRegular(executionBinaryPath, 64 * 1024 * 1024, "pdf-inspector binary snapshot after attempt"),
        runtimeSourceIdentity(),
      ]);
      if (sourceBefore.sha256 !== sourceAfter.sha256 || sourceBefore.size_bytes !== sourceAfter.size_bytes
        || sourceAfter.sha256 !== source.sha256 || binaryAfter.sha256 !== binary.sha256
        || canonicalJson(runtimeAfter) !== canonicalJson(pdfToolsSource)) {
        throw new Error("A verified candidate input changed during execution");
      }
      for (const [candidate, result] of [["pdf_inspector", inspector], ["pdf_tools", current]]) {
        const markdownBytes = Buffer.from(result.markdown, "utf8");
        const filename = `${candidate.replaceAll("_", "-")}-r${repetition}.md`;
        await writePrivate(path.join(canonicalOutput, filename), markdownBytes);
        attempts[candidate].push({
          repetition,
          output_file: filename,
          markdown_sha256: sha256(markdownBytes),
          markdown_bytes: markdownBytes.length,
          ...result.attempt,
        });
        markdownByCandidate[candidate].push(result.markdown);
      }
    }
  } finally {
    await fs.rm(inputRoot, { recursive: true, force: true });
  }

  const [finalRevision, finalTrackedStatus, finalLock] = await Promise.all([
    gitValue(inspectorRoot, ["rev-parse", "HEAD"]),
    gitValue(inspectorRoot, ["status", "--porcelain", "--untracked-files=no"]),
    canonicalRegular(path.join(inspectorRoot, "Cargo.lock"), 4 * 1024 * 1024, "pdf-inspector resolved lock after execution"),
  ]);
  if (finalRevision !== revision || finalTrackedStatus !== trackedStatus || finalLock.sha256 !== lock.sha256) {
    throw new Error("pdf-inspector reviewed source binding changed during execution");
  }

  for (const candidate of Object.keys(attempts)) {
    if (new Set(attempts[candidate].map(attempt => attempt.markdown_sha256)).size !== 1) {
      throw new Error(`${candidate} Markdown changed across fresh-process repetitions`);
    }
  }

  const metrics = {
    pdf_tools: scoreShannonMarkdown({
      markdown: markdownByCandidate.pdf_tools[0],
      oracle: manifest.oracle,
      evidence: { page_identity: true, typed_coverage_gaps: true, canonical_coordinates: true, engine_native_coordinates: false },
    }),
    pdf_inspector: scoreShannonMarkdown({
      markdown: markdownByCandidate.pdf_inspector[0],
      oracle: manifest.oracle,
      evidence: { page_identity: false, typed_coverage_gaps: false, canonical_coordinates: false, engine_native_coordinates: false },
    }),
  };
  const report = {
    report_id: "pdf-tools.shannon-markdown-bakeoff-report.v1",
    report_version: 1,
    benchmark_claim_ready: false,
    calibration_claim_ready: false,
    generated_at: new Date().toISOString(),
    host: {
      hostname_sha256: sha256(Buffer.from(os.hostname())),
      platform: process.platform,
      architecture: process.arch,
      os_release: os.release(),
      node_version: process.version,
    },
    source: {
      id: manifest.source.id,
      url: manifest.source.url,
      redistribution: manifest.source.redistribution,
      sha256: source.sha256,
      size_bytes: source.size_bytes,
      page_count: manifest.source.page_count,
    },
    manifest: { sha256: manifestFile.sha256, size_bytes: manifestFile.size_bytes },
    candidates: {
      pdf_tools: {
        slot: manifest.candidates.pdf_tools.slot,
        packaging_status: "source_checkout_not_packed_mcpb",
        ...pdfToolsSource,
      },
      pdf_inspector: {
        slot: manifest.candidates.pdf_inspector.slot,
        repository: manifest.candidates.pdf_inspector.repository,
        revision,
        crate_version: manifest.candidates.pdf_inspector.crate_version,
        license: manifest.candidates.pdf_inspector.license,
        resolved_lock_sha256: lock.sha256,
        binary_sha256: binary.sha256,
        binary_size_bytes: binary.size_bytes,
        packaging_status: "external_evaluation_only",
      },
      layout_reference: manifest.candidates.layout_reference,
    },
    execution_boundary: {
      fresh_process_per_repetition: true,
      verified_input_snapshots: true,
      runtime_sources_revalidated_after_each_repetition: true,
      network_isolation: false,
      hard_memory_limit: false,
      source_reopened_before_and_after: true,
      pdf_tools_page_span: manifest.execution.pdf_tools_page_span,
    },
    attempts,
    aggregates: Object.fromEntries(Object.entries(attempts).map(([candidate, records]) => [candidate, {
      repetitions: records.length,
      deterministic_markdown: new Set(records.map(record => record.markdown_sha256)).size === 1,
      median_elapsed_ms: median(records.map(record => record.elapsed_ms)),
      median_maximum_resident_set_size_bytes: records.every(record => record.maximum_resident_set_size_bytes !== null)
        ? median(records.map(record => record.maximum_resident_set_size_bytes))
        : null,
      artifact_or_runtime_size_bytes: candidate === "pdf_inspector" ? binary.size_bytes : null,
    }])),
    metrics,
    limitations: [
      "The oracle is a sampled structural-anchor contract, not a complete manually transcribed 55-page ground truth.",
      "No metric families are blended into an overall score.",
      "PDF Tools ran from the named source checkout, not a packed MCPB artifact.",
      "The stronger layout-reference slot was not run because no Shannon-specific hash-bound handoff exists.",
      "The source PDF and pdf-inspector executable run from private verified snapshots. PDF Tools JavaScript and dependency paths run from the named checkout and are revalidated after each repetition rather than executed from a filesystem-isolated snapshot.",
      "Network inactivity is intended by the candidate commands but is not syscall-isolated.",
      "Maximum RSS is observed from the macOS time wrapper and is not a hard memory limit.",
      "A successful evaluation does not authorize bundling, release, or a comparative product claim.",
    ],
  };
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writePrivate(path.join(canonicalOutput, "report.v1.json"), reportBytes);
  return { report, report_sha256: sha256(reportBytes), output_dir: canonicalOutput };
}

export async function runShannonMarkdownBakeoff(options) {
  return run(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(exactOptions(process.argv.slice(2)))
    .then(result => process.stdout.write(`${JSON.stringify({
      output_dir: result.output_dir,
      report_sha256: result.report_sha256,
      aggregates: result.report.aggregates,
    }, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${error.stack ?? error.message}\n`);
      process.exitCode = 1;
    });
}
