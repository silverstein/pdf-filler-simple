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

function sameSet(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function confusionMetrics(results) {
  const families = {};
  for (const result of results) {
    const expected = new Set(result.expected_failure_ids);
    for (const finding of result.assessment.screen.findings) {
      const family = finding.rule_family;
      families[family] ??= {
        true_positives: 0,
        true_negatives: 0,
        false_positives: 0,
        false_negatives: 0,
      };
      const shouldFail = expected.has(finding.id);
      const didFail = !finding.passed;
      if (shouldFail && didFail) families[family].true_positives += 1;
      else if (!shouldFail && !didFail) families[family].true_negatives += 1;
      else if (!shouldFail && didFail) families[family].false_positives += 1;
      else families[family].false_negatives += 1;
    }
  }
  return Object.fromEntries(Object.entries(families).sort(([left], [right]) => left.localeCompare(right))
    .map(([family, counts]) => {
      const positivePredictions = counts.true_positives + counts.false_positives;
      const positiveExpectations = counts.true_positives + counts.false_negatives;
      return [family, {
        ...counts,
        precision: positivePredictions === 0 ? null : counts.true_positives / positivePredictions,
        recall: positiveExpectations === 0 ? null : counts.true_positives / positiveExpectations,
      }];
    }));
}

export async function runAccessibilityEvaluation({
  manifestPath = DEFAULT_MANIFEST,
  partition = "all",
} = {}) {
  const resolvedManifest = path.resolve(manifestPath);
  const { manifest } = await loadAccessibilityManifest(resolvedManifest);
  const fixtures = partition === "all"
    ? manifest.fixtures
    : manifest.fixtures.filter(fixture => fixture.partition === partition);
  if (fixtures.length === 0) throw new Error(`No accessibility fixtures selected for partition ${partition}`);

  const results = [];
  for (const fixture of fixtures) {
    const candidatePath = await resolveAccessibilityFixturePath(resolvedManifest, fixture);
    const bytes = await fs.readFile(candidatePath);
    const assessment = await screenPdfAccessibility(candidatePath);
    const actualFailureFamilies = [...new Set(assessment.screen.findings
      .filter(finding => !finding.passed)
      .map(finding => finding.rule_family))];
    const exactFailuresMatch = sameSet(
      fixture.expected.expected_failure_ids,
      assessment.screen.failures
    );
    const exactFamiliesMatch = sameSet(
      fixture.expected.expected_rule_families,
      actualFailureFamilies
    );
    const expectationMet = digest(bytes) === fixture.sha256
      && assessment.screen.status === fixture.expected.screen_status
      && exactFailuresMatch
      && exactFamiliesMatch
      && assessment.screen.observations.pdfua_identification.part === fixture.expected.declared_pdfua_part
      && assessment.claims.maximum_claim_state === fixture.expected.maximum_claim_state
      && assessment.claims.pdfua_conformance.status === "not_established"
      && assessment.claims.wcag_conformance.status === "not_established"
      && assessment.claims.certified_conformance.status === "not_established";

    results.push({
      id: fixture.id,
      partition: fixture.partition,
      sha256_matches: digest(bytes) === fixture.sha256,
      expected_failure_ids: fixture.expected.expected_failure_ids,
      exact_failures_match: exactFailuresMatch,
      exact_rule_families_match: exactFamiliesMatch,
      expectation_met: expectationMet,
      assessment,
    });
  }
  return {
    corpus_version: manifest.corpus_version,
    partition,
    passed: results.every(result => result.expectation_met),
    rule_family_confusion: confusionMetrics(results),
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
