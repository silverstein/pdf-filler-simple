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
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
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
const MANIFEST_SCHEMA = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "olmocr",
  "manifest.schema.json",
);
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
    || manifest.claim_boundary?.public_benchmark_claim !== "prohibited"
    || manifest.scorer?.profile !== "directional-js-v2"
    || manifest.execution?.tool !== "convert_pdf_to_markdown"
    || manifest.execution?.page !== 1
    || canonicalJson(manifest.execution?.options) !== canonicalJson({
      compact: false,
      emit_table_proposals: false,
      end_page: 1,
      include_page_boundaries: false,
      max_characters: 50000,
      max_items: 1000,
      max_markdown_bytes: 50000,
      remove_page_furniture: true,
      start_page: 1,
    })
    || manifest.gate?.id !== "pdf-tools.olmocr-bench.no-regression.v1"
    || !SHA256.test(manifest.gate?.reference_run_sha256 ?? "")
    || !SHA256.test(manifest.gate?.reference_scorer_sha256 ?? "")
    || manifest.gate?.reference_run_sha256 !== manifest.reference_run?.run_sha256
    || manifest.gate?.reference_scorer_profile !== manifest.scorer?.profile
    || !manifest.gate?.reference?.headline_excluding_math_proxy
    || !manifest.gate?.reference?.math_proxy
    || !manifest.gate?.reference?.by_category
    || !manifest.source?.metadata || Array.isArray(manifest.source.metadata)) {
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
  const [source, schemaSource] = await Promise.all([
    boundedRegularFile(filename, 1024 * 1024, "manifest"),
    boundedRegularFile(MANIFEST_SCHEMA, 1024 * 1024, "manifest schema"),
  ]);
  const manifest = JSON.parse(source.bytes.toString("utf8"));
  const schema = JSON.parse(schemaSource.bytes.toString("utf8"));
  const validation = new AjvJsonSchemaValidator().getValidator(schema)(manifest);
  if (!validation.valid) {
    throw new Error(`olmOCR-bench manifest fails its schema: ${JSON.stringify(validation.error)}`);
  }
  return { manifest: validateManifest(manifest), binding: source, schemaBinding: schemaSource };
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
    execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: REPO_ROOT,
      maxBuffer: 64 * 1024 * 1024,
    }),
  ]);
  const serverFiles = [];
  const visit = async (directory, relativeDirectory) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath, relativePath);
      else if (entry.isFile() && entry.name.endsWith(".js")) serverFiles.push(relativePath);
    }
  };
  await visit(path.join(REPO_ROOT, "server"), "server");
  const files = [];
  for (const relativePath of ["package.json", "package-lock.json", ...serverFiles]) {
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
  if (filename === REPO_ROOT || filename.startsWith(`${REPO_ROOT}${path.sep}`)) {
    throw new Error("Evaluation output must be written outside the repository");
  }
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
  let linked = false;
  try {
    await fs.link(temporary, filename);
    linked = true;
    const directoryHandle = await fs.open(parent, fsConstants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (linked) await fs.unlink(filename).catch(() => {});
    throw error;
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
  return { path: filename, size_bytes: bytes.length, sha256: sha256(bytes) };
}

function safeEnvironment(overrides) {
  return Object.fromEntries(Object.entries({ ...process.env, ...overrides })
    .filter(([, value]) => typeof value === "string"));
}

async function runConversions({ benchRoot, pdfs, limit, manifest }) {
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
      const record = {
        pdf: relativePath,
        ok: false,
        outcome: "harness_failure",
        markdown: "",
        gaps: [],
        status: null,
        pages: [],
      };
      try {
        const result = await client.callTool({
          name: manifest.execution.tool,
          arguments: {
            pdf_path: path.join(pdfRoot, relativePath),
            ...manifest.execution.options,
          },
        });
        if (result.isError) throw new Error("convert_pdf_to_markdown returned isError=true");
        const structured = result.structuredContent ?? {};
        if (typeof structured.markdown !== "string" || !Array.isArray(structured.gaps)) {
          throw new Error("convert_pdf_to_markdown returned an invalid structured result");
        }
        record.markdown = structured.markdown;
        record.gaps = structured.gaps.map(gap => typeof gap === "string"
          ? { code: gap }
          : { code: gap?.code, message: gap?.message, page: gap?.page });
        record.status = structured.conversion_status ?? null;
        record.pages = (structured.pages ?? []).map(page => ({
          page: page?.page,
          conversion_status: page?.conversion_status,
          line_count: page?.line_count,
          rendered_line_count: page?.rendered_line_count,
        }));
        if (!["complete", "partial"].includes(record.status)
          || record.pages.length !== 1
          || record.pages.some(page => page.conversion_status === "failed")) {
          record.outcome = "product_failure";
          record.error = `conversion_status=${String(record.status)}`;
        } else {
          record.ok = true;
          record.outcome = "converted";
        }
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

function exactKeys(value, required, optional, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => !allowed.has(key))) {
    throw new Error(`${label} has missing or unexpected keys`);
  }
}

export function validateRunReport(report) {
  exactKeys(report, [
    "schema", "manifest_sha256", "manifest_size_bytes", "corpus", "evaluator",
    "candidate", "selection", "qualifying", "records",
  ], [], "run report");
  if (report.schema !== "pdf-tools.olmocr-bench-run.v1"
    || !SHA256.test(report.manifest_sha256)
    || !Number.isSafeInteger(report.manifest_size_bytes) || report.manifest_size_bytes < 1
    || typeof report.qualifying !== "boolean"
    || !Array.isArray(report.records)) {
    throw new Error("Run report identity or records are invalid");
  }
  exactKeys(report.selection, ["full", "pdf_count"], [], "run selection");
  if (typeof report.selection.full !== "boolean"
    || !Number.isSafeInteger(report.selection.pdf_count) || report.selection.pdf_count < 1
    || report.selection.pdf_count !== report.records.length) {
    throw new Error("Run selection does not match its records");
  }
  exactKeys(report.candidate, [
    "git_revision", "git_clean", "runtime_source_sha256", "runtime_sources",
  ], [], "candidate binding");
  if (!GIT_SHA1.test(report.candidate.git_revision)
    || typeof report.candidate.git_clean !== "boolean"
    || !SHA256.test(report.candidate.runtime_source_sha256)
    || !Array.isArray(report.candidate.runtime_sources)
    || report.candidate.runtime_sources.length < 2
    || report.candidate.runtime_sources.some(source => (
      typeof source?.path !== "string" || !source.path
      || !Number.isSafeInteger(source.size_bytes) || source.size_bytes < 1
      || !SHA256.test(source.sha256 ?? "")
    ))
    || sha256(Buffer.from(canonicalJson(report.candidate.runtime_sources)))
      !== report.candidate.runtime_source_sha256) {
    throw new Error("Candidate binding is invalid");
  }
  const pdfs = [];
  for (const [index, record] of report.records.entries()) {
    exactKeys(record, ["pdf", "ok", "outcome", "markdown", "gaps", "status", "pages"], ["error"], `record ${index}`);
    if (typeof record.pdf !== "string" || !record.pdf
      || typeof record.ok !== "boolean"
      || !["converted", "product_failure", "harness_failure"].includes(record.outcome)
      || typeof record.markdown !== "string"
      || !Array.isArray(record.gaps)
      || !Array.isArray(record.pages)
      || record.gaps.some(gap => typeof gap?.code !== "string" || !gap.code)) {
      throw new Error(`Run record ${index} has an invalid shape`);
    }
    if (record.ok !== (record.outcome === "converted")
      || (record.ok && !["complete", "partial"].includes(record.status))
      || (record.ok && (record.pages.length !== 1
        || record.pages.some(page => (
          page?.page !== 1
          || !["complete", "partial"].includes(page.conversion_status)
          || !Number.isSafeInteger(page.line_count) || page.line_count < 0
          || !Number.isSafeInteger(page.rendered_line_count) || page.rendered_line_count < 0
        ))))) {
      throw new Error(`Run record ${index} has contradictory conversion state`);
    }
    pdfs.push(record.pdf);
  }
  if (new Set(pdfs).size !== pdfs.length
    || canonicalJson(pdfs) !== canonicalJson([...pdfs].sort())) {
    throw new Error("Run records must be unique and sorted by PDF path");
  }
  const expectedQualifying = report.selection.full
    && report.candidate.git_clean
    && report.records.every(record => record.ok);
  if (report.qualifying !== expectedQualifying) {
    throw new Error("Run report qualifying flag contradicts its evidence");
  }
  return report;
}

async function loadRun(filename) {
  const source = await boundedRegularFile(filename, 1024 * 1024 * 1024, "run report");
  let parsed = null;
  if (source.bytes[0] === 0x7b) {
    try {
      parsed = JSON.parse(source.bytes.toString("utf8"));
    } catch {
      // The retained first-run input is JSONL and also begins with an object.
    }
  }
  if (parsed !== null) {
    if (parsed?.schema !== "pdf-tools.olmocr-bench-run.v1" || !Array.isArray(parsed.records)) {
      throw new Error("JSON run report has an unknown schema or missing records");
    }
    const report = validateRunReport(parsed);
    return { records: report.records, qualifying: report.qualifying, binding: source, report };
  }
  const records = parseJsonLines(source.bytes, "legacy run report");
  return { records, qualifying: false, binding: source, report: null };
}

async function main() {
  if (!["linux", "darwin"].includes(process.platform)) {
    throw new Error("The olmOCR-bench gate requires a POSIX Linux or macOS host");
  }
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
  const scorerBinding = evaluator.files.find(file => file.path === "test/eval/olmocr-bench-scorer.js");
  if (scorerBinding?.sha256 !== manifest.gate.reference_scorer_sha256) {
    throw new Error("Gate reference scorer digest does not match the current scorer");
  }
  if (options.command === "verify") {
    process.stdout.write(`${JSON.stringify({ verified: true, ...common, tests: corpus.tests.length, pdfs: corpus.pdfs.length }, null, 2)}\n`);
    return;
  }
  if (options.command === "run") {
    const candidate = await candidateBinding();
    const { selected, records } = await runConversions({
      benchRoot: options.benchRoot,
      pdfs: corpus.pdfs,
      limit: options.limit,
      manifest,
    });
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
    if (!report.qualifying) process.exitCode = 2;
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
  if (run.report) {
    const observedPdfs = run.records.map(record => record.pdf);
    const expectedPdfs = corpus.pdfs.slice(0, run.report.selection.pdf_count);
    if (canonicalJson(observedPdfs) !== canonicalJson(expectedPdfs)
      || run.report.selection.full !== (observedPdfs.length === corpus.pdfs.length)) {
      throw new Error("Run selection does not match the pinned deterministic corpus order");
    }
  }
  const report = scoreOlmocrBench({
    tests: corpus.tests,
    records: run.records,
    runQualifying: run.qualifying,
    claimBoundary: manifest.claim_boundary,
    gatePolicy: manifest.gate,
    bindings: {
      ...common,
      run_sha256: run.binding.sha256,
      run_size_bytes: run.binding.size_bytes,
      candidate: run.report?.candidate ?? null,
      scorer_profile: manifest.scorer.profile,
    },
  });
  const output = await writeAtomicExclusive(options.outputPath, report);
  process.stdout.write(`${JSON.stringify({ written: output, qualifying: report.qualifying, release_regression_gate: report.release_regression_gate, headline: report.headline_excluding_math_proxy, math_proxy: report.math_proxy }, null, 2)}\n`);
  if (!report.release_regression_gate.passed) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
