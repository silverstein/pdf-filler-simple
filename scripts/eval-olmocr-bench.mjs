#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { scoreOlmocrBench } from "../test/eval/olmocr-bench-scorer.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "olmocr",
  "manifest.v1.json",
);
const RUNTIME_SOURCE_FILES = [
  "package.json",
  "package-lock.json",
  "server/index.js",
  "server/layout-extraction.js",
  "server/markdown-conversion.js",
  "server/markdown-output-transaction.js",
  "server/output-schemas.js",
  "server/pdfjs-subprocess.js",
  "server/pdfjs-worker.js",
  "server/type3-cm-reference.js",
];
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_SHA1 = /^[a-f0-9]{40}$/u;

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

function usage() {
  return [
    "Usage:",
    "  node scripts/eval-olmocr-bench.mjs verify --bench-root ABSOLUTE_PATH [--manifest PATH]",
    "  node scripts/eval-olmocr-bench.mjs run --bench-root ABSOLUTE_PATH --output ABSOLUTE_PATH [--manifest PATH] [--limit N]",
    "  node scripts/eval-olmocr-bench.mjs score --bench-root ABSOLUTE_PATH --run ABSOLUTE_PATH --output ABSOLUTE_PATH [--manifest PATH]",
  ].join("\n");
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!["verify", "run", "score"].includes(command)) throw new Error(usage());
  const allowed = new Set(["--bench-root", "--manifest", "--output", "--run", "--limit"]);
  if (rest.length % 2 !== 0) throw new Error(usage());
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!allowed.has(key) || Object.hasOwn(options, key) || !value) {
      throw new Error(`Unknown, duplicate, or empty option: ${key}`);
    }
    options[key] = value;
  }
  if (!options["--bench-root"]) throw new Error("--bench-root is required");
  if ((command === "run" || command === "score") && !options["--output"]) {
    throw new Error("--output is required");
  }
  if (command === "score" && !options["--run"]) throw new Error("--run is required");
  if (command !== "run" && options["--limit"]) throw new Error("--limit is valid only for run");
  if (command !== "score" && options["--run"]) throw new Error("--run is valid only for score");
  const limit = options["--limit"] === undefined ? null : Number(options["--limit"]);
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  return {
    command,
    benchRoot: path.resolve(options["--bench-root"]),
    manifestPath: path.resolve(options["--manifest"] ?? DEFAULT_MANIFEST),
    outputPath: options["--output"] ? path.resolve(options["--output"]) : null,
    runPath: options["--run"] ? path.resolve(options["--run"]) : null,
    limit,
  };
}

async function canonicalDirectory(filename, label) {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  const resolved = await fs.realpath(filename);
  const metadata = await fs.lstat(filename);
  if (resolved !== filename || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a canonical directory`);
  }
  return filename;
}

async function boundedRegularFile(filename, maximumBytes, label) {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename
    || typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error(`${label} must be an absolute normalized regular-file path`);
  }
  if (await fs.realpath(filename) !== filename) throw new Error(`${label} must be canonical`);
  const before = await fs.lstat(filename, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size < 1n || before.size > BigInt(maximumBytes)) {
    throw new Error(`${label} violates its bounded single-link regular-file contract`);
  }
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const descriptorBefore = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const [descriptorAfter, after] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.lstat(filename, { bigint: true }),
    ]);
    const identity = value => ["dev", "ino", "size", "mtimeNs", "ctimeNs"]
      .map(key => String(value[key])).join(":");
    if (identity(before) !== identity(descriptorBefore)
      || identity(before) !== identity(descriptorAfter)
      || identity(before) !== identity(after)
      || BigInt(bytes.length) !== before.size) {
      throw new Error(`${label} changed while it was read`);
    }
    return { bytes, size_bytes: bytes.length, sha256: sha256(bytes) };
  } finally {
    await handle.close();
  }
}

function validateManifest(manifest) {
  if (manifest?.suite_id !== "pdf-tools.olmocr-bench.directional.v1"
    || manifest.suite_version !== 1
    || manifest.benchmark_claim_ready !== false
    || manifest.source?.redistribution !== "external_only"
    || manifest.source?.license !== "ODC-BY-1.0"
    || !GIT_SHA1.test(manifest.source?.revision ?? "")
    || !Array.isArray(manifest.source?.categories)
    || manifest.source.categories.length < 1
    || manifest.claim_boundary?.public_benchmark_claim !== "prohibited") {
    throw new Error("olmOCR-bench manifest identity or claim boundary is invalid");
  }
  const inventory = manifest.source.pdf_inventory;
  if (!Number.isSafeInteger(inventory?.count) || inventory.count < 1
    || !Number.isSafeInteger(inventory?.total_size_bytes) || inventory.total_size_bytes < 1
    || !SHA256.test(inventory?.canonical_inventory_sha256 ?? "")
    || manifest.execution?.required_pdf_count !== inventory.count
    || !Number.isSafeInteger(manifest.execution?.required_test_count)) {
    throw new Error("olmOCR-bench manifest inventory contract is invalid");
  }
  const categoryIds = new Set();
  for (const category of manifest.source.categories) {
    if (typeof category.id !== "string" || categoryIds.has(category.id)
      || category.file !== `bench_data/${category.id}.jsonl`
      || !SHA256.test(category.sha256)
      || !Number.isSafeInteger(category.size_bytes) || category.size_bytes < 1
      || !Number.isSafeInteger(category.test_count) || category.test_count < 1
      || !Number.isSafeInteger(category.unique_pdf_count) || category.unique_pdf_count < 1) {
      throw new Error("olmOCR-bench manifest category binding is invalid");
    }
    categoryIds.add(category.id);
  }
  return manifest;
}

async function loadManifest(filename) {
  const source = await boundedRegularFile(filename, 1024 * 1024, "manifest");
  return { manifest: validateManifest(JSON.parse(source.bytes.toString("utf8"))), binding: source };
}

function parseJsonLines(bytes, label) {
  return bytes.toString("utf8").split(/\r?\n/u).filter(line => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${label} line ${index + 1} is not valid JSON: ${error.message}`);
    }
  });
}

async function verifyCorpus(benchRoot, manifest) {
  await canonicalDirectory(benchRoot, "benchmark root");
  const tests = [];
  const pdfPaths = new Set();
  const categoryBindings = [];
  for (const category of manifest.source.categories) {
    const filename = path.join(benchRoot, category.file);
    const source = await boundedRegularFile(filename, 8 * 1024 * 1024, `category ${category.id}`);
    if (source.sha256 !== category.sha256 || source.size_bytes !== category.size_bytes) {
      throw new Error(`Category ${category.id} does not match the pinned manifest`);
    }
    const categoryTests = parseJsonLines(source.bytes, category.id);
    if (categoryTests.length !== category.test_count
      || new Set(categoryTests.map(test => test.pdf)).size !== category.unique_pdf_count) {
      throw new Error(`Category ${category.id} counts do not match the pinned manifest`);
    }
    for (const test of categoryTests) {
      if (test.page !== manifest.execution.page || typeof test.pdf !== "string" || !test.pdf) {
        throw new Error(`Category ${category.id} contains an invalid page or PDF path`);
      }
      const normalized = path.posix.normalize(test.pdf);
      if (normalized !== test.pdf || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
        throw new Error(`Category ${category.id} contains an unsafe PDF path`);
      }
      pdfPaths.add(test.pdf);
      tests.push({ ...test, category: category.id });
    }
    categoryBindings.push({ id: category.id, ...source });
  }
  if (tests.length !== manifest.execution.required_test_count
    || pdfPaths.size !== manifest.source.pdf_inventory.count) {
    throw new Error("Corpus totals do not match the pinned manifest");
  }
  const inventory = [];
  for (const relativePath of [...pdfPaths].sort()) {
    const filename = path.join(benchRoot, "bench_data", "pdfs", relativePath);
    const source = await boundedRegularFile(filename, 200 * 1024 * 1024, `PDF ${relativePath}`);
    inventory.push({ path: `bench_data/pdfs/${relativePath}`, size_bytes: source.size_bytes, sha256: source.sha256 });
  }
  const totalSize = inventory.reduce((total, item) => total + item.size_bytes, 0);
  const inventorySha256 = sha256(Buffer.from(canonicalJson(inventory)));
  if (totalSize !== manifest.source.pdf_inventory.total_size_bytes
    || inventorySha256 !== manifest.source.pdf_inventory.canonical_inventory_sha256) {
    throw new Error("PDF inventory does not match the pinned manifest");
  }
  const metadataBindings = {};
  for (const [relativePath, expected] of Object.entries(manifest.source.metadata)) {
    const source = await boundedRegularFile(path.join(benchRoot, relativePath), 1024 * 1024, `metadata ${relativePath}`);
    if (source.size_bytes !== expected.size_bytes || source.sha256 !== expected.sha256) {
      throw new Error(`Metadata ${relativePath} does not match the pinned manifest`);
    }
    metadataBindings[relativePath] = expected;
  }
  return {
    tests,
    pdfs: [...pdfPaths].sort(),
    binding: {
      upstream_revision: manifest.source.revision,
      category_sha256: Object.fromEntries(categoryBindings.map(item => [item.id, item.sha256])),
      pdf_inventory_sha256: inventorySha256,
      pdf_count: inventory.length,
      pdf_total_size_bytes: totalSize,
      metadata: metadataBindings,
    },
  };
}

async function candidateBinding() {
  const [{ stdout: revision }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }),
    execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: REPO_ROOT }),
  ]);
  const files = [];
  for (const relativePath of RUNTIME_SOURCE_FILES) {
    const bytes = await fs.readFile(path.join(REPO_ROOT, relativePath));
    files.push({ path: relativePath, size_bytes: bytes.length, sha256: sha256(bytes) });
  }
  return {
    git_revision: revision.trim(),
    git_clean: status.trim().length === 0,
    runtime_source_sha256: sha256(Buffer.from(canonicalJson(files))),
    runtime_sources: files,
  };
}

async function evaluatorBinding() {
  const files = [];
  for (const relativePath of [
    "scripts/eval-olmocr-bench.mjs",
    "test/eval/olmocr-bench-scorer.js",
    "test/fixtures/eval/olmocr/manifest.schema.json",
  ]) {
    const bytes = await fs.readFile(path.join(REPO_ROOT, relativePath));
    files.push({ path: relativePath, size_bytes: bytes.length, sha256: sha256(bytes) });
  }
  return {
    sha256: sha256(Buffer.from(canonicalJson(files))),
    files,
  };
}

async function writeAtomicExclusive(filename, value) {
  const parent = path.dirname(filename);
  await canonicalDirectory(parent, "output directory");
  try {
    await fs.lstat(filename);
    throw new Error(`Output already exists: ${filename}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = path.join(parent, `.${path.basename(filename)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(temporary, filename);
    const directoryHandle = await fs.open(parent, fsConstants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
  return { path: filename, size_bytes: bytes.length, sha256: sha256(bytes) };
}

function safeEnvironment(overrides) {
  return Object.fromEntries(Object.entries({ ...process.env, ...overrides })
    .filter(([, value]) => typeof value === "string"));
}

async function runConversions({ benchRoot, pdfs, limit }) {
  const selected = limit === null ? pdfs : pdfs.slice(0, limit);
  const pdfRoot = path.join(benchRoot, "bench_data", "pdfs");
  const isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-olmocr-"));
  await fs.chmod(isolatedHome, 0o700);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO_ROOT, "server", "index.js")],
    env: safeEnvironment({
      HOME: isolatedHome,
      XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
      XDG_CACHE_HOME: path.join(isolatedHome, ".cache"),
      ALLOWED_DIRECTORIES: pdfRoot,
      PDF_TOOLS_ALLOWED_DIRECTORIES: pdfRoot,
    }),
    stderr: "ignore",
  });
  const client = new Client({ name: "pdf-tools-olmocr-bench", version: "1.0.0" }, { capabilities: {} });
  const records = [];
  try {
    await client.connect(transport);
    let completed = 0;
    for (const relativePath of selected) {
      const record = { pdf: relativePath, ok: false, markdown: "", gaps: [], status: null };
      try {
        const result = await client.callTool({
          name: "convert_pdf_to_markdown",
          arguments: {
            pdf_path: path.join(pdfRoot, relativePath),
            ...{ start_page: 1, end_page: 1 },
          },
        });
        if (result.isError) throw new Error("convert_pdf_to_markdown returned isError=true");
        const structured = result.structuredContent ?? {};
        if (typeof structured.markdown !== "string" || !Array.isArray(structured.gaps)) {
          throw new Error("convert_pdf_to_markdown returned an invalid structured result");
        }
        record.ok = true;
        record.markdown = structured.markdown;
        record.gaps = structured.gaps.map(gap => typeof gap === "string"
          ? { code: gap }
          : { code: gap?.code, message: gap?.message, page: gap?.page });
        record.status = structured.conversion_status ?? null;
      } catch (error) {
        record.error = String(error?.message ?? error).slice(0, 500);
      }
      records.push(record);
      completed += 1;
      if (completed % 25 === 0 || completed === selected.length) {
        process.stderr.write(`olmOCR-bench ${completed}/${selected.length}\n`);
      }
    }
  } finally {
    await client.close().catch(() => {});
    await fs.rm(isolatedHome, { recursive: true, force: true });
  }
  return { selected, records };
}

async function loadRun(filename) {
  const source = await boundedRegularFile(filename, 1024 * 1024 * 1024, "run report");
  if (source.bytes[0] === 0x7b) {
    try {
      const parsed = JSON.parse(source.bytes.toString("utf8"));
      if (parsed?.schema === "pdf-tools.olmocr-bench-run.v1" && Array.isArray(parsed.records)) {
        return { records: parsed.records, qualifying: parsed.qualifying === true, binding: source, report: parsed };
      }
    } catch {
      // The retained first-run input is JSONL and also begins with an object.
    }
  }
  const records = parseJsonLines(source.bytes, "legacy run report");
  return { records, qualifying: false, binding: source, report: null };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { manifest, binding: manifestBinding } = await loadManifest(options.manifestPath);
  const [corpus, evaluator] = await Promise.all([
    verifyCorpus(options.benchRoot, manifest),
    evaluatorBinding(),
  ]);
  const common = {
    manifest_sha256: manifestBinding.sha256,
    manifest_size_bytes: manifestBinding.size_bytes,
    corpus: corpus.binding,
    evaluator,
  };
  if (options.command === "verify") {
    process.stdout.write(`${JSON.stringify({ verified: true, ...common, tests: corpus.tests.length, pdfs: corpus.pdfs.length }, null, 2)}\n`);
    return;
  }
  if (options.command === "run") {
    const candidate = await candidateBinding();
    const { selected, records } = await runConversions({ benchRoot: options.benchRoot, pdfs: corpus.pdfs, limit: options.limit });
    const [afterManifest, afterCorpus, afterCandidate, afterEvaluator] = await Promise.all([
      loadManifest(options.manifestPath),
      verifyCorpus(options.benchRoot, manifest),
      candidateBinding(),
      evaluatorBinding(),
    ]);
    if (afterManifest.binding.sha256 !== manifestBinding.sha256
      || canonicalJson(afterCorpus.binding) !== canonicalJson(corpus.binding)
      || canonicalJson(afterCorpus.pdfs) !== canonicalJson(corpus.pdfs)
      || canonicalJson(afterCandidate) !== canonicalJson(candidate)
      || canonicalJson(afterEvaluator) !== canonicalJson(evaluator)) {
      throw new Error("Manifest, corpus, candidate, or evaluator changed while conversions were running");
    }
    const fullSelection = selected.length === corpus.pdfs.length;
    const report = {
      schema: "pdf-tools.olmocr-bench-run.v1",
      ...common,
      candidate,
      selection: { full: fullSelection, pdf_count: selected.length },
      qualifying: fullSelection && candidate.git_clean && records.every(record => record.ok),
      records,
    };
    const output = await writeAtomicExclusive(options.outputPath, report);
    process.stdout.write(`${JSON.stringify({ written: output, qualifying: report.qualifying, conversions_failed: records.filter(record => !record.ok).length }, null, 2)}\n`);
    return;
  }
  const run = await loadRun(options.runPath);
  if (run.report && (
    run.report.manifest_sha256 !== common.manifest_sha256
    || canonicalJson(run.report.corpus) !== canonicalJson(common.corpus)
    || canonicalJson(run.report.evaluator) !== canonicalJson(common.evaluator)
  )) {
    throw new Error("Run report does not bind the current manifest, corpus, and evaluator");
  }
  const report = scoreOlmocrBench({
    tests: corpus.tests,
    records: run.records,
    runQualifying: run.qualifying,
    claimBoundary: manifest.claim_boundary,
    bindings: {
      ...common,
      run_sha256: run.binding.sha256,
      run_size_bytes: run.binding.size_bytes,
      candidate: run.report?.candidate ?? null,
      scorer_profile: manifest.scorer.profile,
    },
  });
  const output = await writeAtomicExclusive(options.outputPath, report);
  process.stdout.write(`${JSON.stringify({ written: output, qualifying: report.qualifying, headline: report.headline_excluding_math_proxy, math_proxy: report.math_proxy }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
