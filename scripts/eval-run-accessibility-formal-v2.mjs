#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFormalAccessibilityV2Evaluation } from "../test/eval/accessibility-formal-v2.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONTRACT = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "accessibility",
  "formal-corpus.v2.json"
);

function requiredOption(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} requires a value`);
  return process.argv[index + 1];
}

function optionalOption(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a value`);
  return process.argv[index + 1];
}

const result = await runFormalAccessibilityV2Evaluation({
  contractPath: optionalOption("--contract", DEFAULT_CONTRACT),
  corpusDirectory: requiredOption("--corpus-dir"),
  publicKeyPath: requiredOption("--public-key"),
  signaturePath: requiredOption("--signature"),
  verifierPath: requiredOption("--verifier"),
  validatorPath: requiredOption("--validator"),
  validatorArtifactPath: requiredOption("--validator-artifact"),
  runtimeArchivePath: requiredOption("--runtime-archive"),
  javaHome: requiredOption("--java-home"),
  generationRoot: requiredOption("--generation-root"),
});

process.stdout.write(`${JSON.stringify(result.public_projection, null, 2)}\n`);
if (!result.passed) process.exitCode = 1;
