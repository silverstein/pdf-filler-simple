#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadFixtureManifest,
  resolveFixturePath,
  selectFixtures,
} from "../test/eval/fixture-manifest.js";
import { scorePdfFixture } from "../test/eval/scorers.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST = path.join(REPO_ROOT, "test", "fixtures", "eval", "manifest.v1.json");

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a value`);
  return process.argv[index + 1];
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function runEvaluation({
  manifestPath = DEFAULT_MANIFEST,
  partition = "development",
} = {}) {
  const resolvedManifest = path.resolve(manifestPath);
  const manifest = await loadFixtureManifest(resolvedManifest);
  const fixtures = selectFixtures(manifest, partition);
  const results = [];

  for (const fixture of fixtures) {
    const fixturePath = resolveFixturePath(resolvedManifest, fixture);
    const bytes = await fs.readFile(fixturePath);
    const digest = sha256(bytes);
    const scored = await scorePdfFixture(fixturePath, fixture.expected);
    const actualOutcome = scored.passed ? "pass" : "fail";
    results.push({
      id: fixture.id,
      partition: fixture.partition,
      sha256_matches: digest === fixture.sha256,
      expected_outcome: fixture.expected_outcome,
      actual_outcome: actualOutcome,
      expectation_met: digest === fixture.sha256 && actualOutcome === fixture.expected_outcome,
      scorers: scored.scorers,
    });
  }

  return {
    corpus_version: manifest.corpus_version,
    partition,
    passed: results.length > 0 && results.every(item => item.expectation_met),
    results,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runEvaluation({
    manifestPath: option("--manifest", DEFAULT_MANIFEST),
    partition: option("--partition", "development"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}
