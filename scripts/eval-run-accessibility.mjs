#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadAccessibilityManifest,
  resolveAccessibilityFixturePath,
} from "../test/eval/accessibility-manifest.js";
import { screenPdfAccessibility } from "../test/eval/accessibility-scorer.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "accessibility",
  "manifest.v1.json"
);

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a value`);
  return process.argv[index + 1];
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function runAccessibilityEvaluation({
  manifestPath = DEFAULT_MANIFEST,
  partition = "all",
} = {}) {
  const resolvedManifest = path.resolve(manifestPath);
  const manifest = await loadAccessibilityManifest(resolvedManifest);
  const fixtures = partition === "all"
    ? manifest.fixtures
    : manifest.fixtures.filter(fixture => fixture.partition === partition);
  if (fixtures.length === 0) throw new Error(`No accessibility fixtures selected for partition ${partition}`);

  const results = [];
  for (const fixture of fixtures) {
    const candidatePath = resolveAccessibilityFixturePath(resolvedManifest, fixture);
    const bytes = await fs.readFile(candidatePath);
    const assessment = await screenPdfAccessibility(candidatePath);
    const requiredFailuresFound = fixture.expected.required_failure_ids.every(id =>
      assessment.screen.failures.includes(id)
    );
    const expectationMet = digest(bytes) === fixture.sha256
      && assessment.screen.status === fixture.expected.screen_status
      && requiredFailuresFound
      && assessment.screen.observations.pdfua_identification.part === fixture.expected.declared_pdfua_part
      && assessment.claims.maximum_claim_state === fixture.expected.maximum_claim_state
      && assessment.claims.pdfua_conformance.status === "not_established"
      && assessment.claims.wcag_conformance.status === "not_established"
      && assessment.claims.certified_conformance.status === "not_established";

    results.push({
      id: fixture.id,
      partition: fixture.partition,
      sha256_matches: digest(bytes) === fixture.sha256,
      expectation_met: expectationMet,
      assessment,
    });
  }
  return {
    corpus_version: manifest.corpus_version,
    partition,
    passed: results.every(result => result.expectation_met),
    results,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runAccessibilityEvaluation({
    manifestPath: option("--manifest", DEFAULT_MANIFEST),
    partition: option("--partition", "all"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}
