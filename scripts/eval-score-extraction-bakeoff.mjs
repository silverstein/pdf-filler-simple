#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  scoreExtractionBakeoff,
  sha256,
} from "../test/eval/extraction-bakeoff-scorer.js";

const REQUIRED_OPTIONS = Object.freeze([
  "--docling-report",
  "--docling-report-sha256",
  "--manifest",
  "--manifest-sha256",
  "--markdown-report",
  "--markdown-report-sha256",
  "--output",
]);
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCORER_PATH = path.resolve(path.dirname(SCRIPT_PATH), "..", "test", "eval", "extraction-bakeoff-scorer.js");

function exactOptions(argv) {
  if (argv.length !== REQUIRED_OPTIONS.length * 2) throw new Error("Exact bakeoff scoring options are required");
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!REQUIRED_OPTIONS.includes(name) || Object.hasOwn(options, name) || !value) {
      throw new Error(`Invalid bakeoff scoring option: ${name ?? "<missing>"}`);
    }
    options[name] = value;
  }
  return options;
}

async function stableFile(filename, { privateFile = false } = {}) {
  const handle = await fs.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_INPUT_BYTES
      || (privateFile && (before.mode & 0o777) !== 0o600)) {
      throw new Error(`Input violates its regular-file contract: ${filename}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`Input changed while read: ${filename}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function privateOutputParent(filename) {
  const parent = await fs.realpath(path.dirname(filename));
  const stat = await fs.lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
    throw new Error("Bakeoff score output parent must be a private mode-0700 directory");
  }
  return parent;
}

export async function scoreBakeoffFiles(options) {
  const manifestPath = path.resolve(options["--manifest"]);
  const markdownPath = path.resolve(options["--markdown-report"]);
  const doclingPath = path.resolve(options["--docling-report"]);
  const outputPath = path.resolve(options["--output"]);
  const [manifestBytes, markdownBytes, doclingBytes, scorerBytes, orchestrationBytes] = await Promise.all([
    stableFile(manifestPath),
    stableFile(markdownPath, { privateFile: true }),
    stableFile(doclingPath, { privateFile: true }),
    stableFile(SCORER_PATH),
    stableFile(SCRIPT_PATH),
  ]);
  const bindings = {
    manifest_sha256: sha256(manifestBytes),
    markdown_report_sha256: sha256(markdownBytes),
    docling_report_sha256: sha256(doclingBytes),
    scorer_source_sha256: sha256(scorerBytes),
    orchestration_source_sha256: sha256(orchestrationBytes),
  };
  if (bindings.manifest_sha256 !== options["--manifest-sha256"]
    || bindings.markdown_report_sha256 !== options["--markdown-report-sha256"]
    || bindings.docling_report_sha256 !== options["--docling-report-sha256"]) {
    throw new Error("Baked-off input bytes differ from their approved identities");
  }
  await privateOutputParent(outputPath);
  const report = scoreExtractionBakeoff({
    manifest: parseJson(manifestBytes, "manifest"),
    markdownReport: parseJson(markdownBytes, "Markdown report"),
    doclingReport: parseJson(doclingBytes, "Docling report"),
    sourceBindings: bindings,
  });
  const outputBytes = Buffer.from(`${canonicalJson(report)}\n`);
  const handle = await fs.open(outputPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(outputBytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { output: outputPath, bytes: outputBytes.length, sha256: sha256(outputBytes), cases: report.cases.length };
}

async function main() {
  const result = await scoreBakeoffFiles(exactOptions(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
