#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFormalAccessibilityEvaluation } from "../test/eval/accessibility-formal.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONTRACT = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "accessibility",
  "formal-corpus.v1.json"
);

function requiredOption(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} requires a value`);
  return process.argv[index + 1];
}

const report = await runFormalAccessibilityEvaluation({
  contractPath: DEFAULT_CONTRACT,
  corpusDirectory: requiredOption("--corpus-dir"),
  validatorPath: requiredOption("--validator"),
  validatorArtifactPath: requiredOption("--validator-artifact"),
  runtimeArchivePath: requiredOption("--runtime-archive"),
  javaHome: requiredOption("--java-home"),
  reportDirectory: requiredOption("--report-dir"),
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
