#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadComparisonManifest,
  resolveComparisonDocumentPath,
} from "../test/eval/comparison-manifest.js";
import { buildSharedLibraryReferenceReport } from "../test/eval/comparison-reference-baseline.js";
import { scoreComparisonReport, validateComparisonReport } from "../test/eval/comparison-scorer.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "comparison",
  "manifest.v1.json",
);
const OUTPUT_DIRECTORY = path.resolve(
  process.argv[2] ?? path.join(REPO_ROOT, "docs", "evidence", "comparison-v1"),
);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  const bytes = await fs.readFile(filePath);
  return { path: path.relative(REPO_ROOT, filePath), sha256: digest(bytes), bytes: bytes.length };
}

const manifest = await loadComparisonManifest(MANIFEST_PATH);
const documentById = new Map(manifest.documents.map(document => [document.id, document]));
const isolatedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-comparison-baseline-"));

try {
  const pairs = [];
  for (const [index, pair] of manifest.pairs.entries()) {
    const pairDirectory = path.join(isolatedDirectory, `case-${String(index + 1).padStart(2, "0")}`);
    await fs.mkdir(pairDirectory, { recursive: true });
    const before = documentById.get(pair.before_document_id);
    const after = documentById.get(pair.after_document_id);
    const beforePath = path.join(pairDirectory, "before.pdf");
    const afterPath = path.join(pairDirectory, "after.pdf");
    await Promise.all([
      fs.copyFile(resolveComparisonDocumentPath(MANIFEST_PATH, before), beforePath),
      fs.copyFile(resolveComparisonDocumentPath(MANIFEST_PATH, after), afterPath),
    ]);
    pairs.push({
      pairId: pair.id,
      beforePath,
      afterPath,
      beforeSha256: before.sha256,
      afterSha256: after.sha256,
    });
  }

  const rawReport = await buildSharedLibraryReferenceReport({
    benchmarkId: manifest.benchmark_id,
    benchmarkVersion: manifest.benchmark_version,
    renderer: manifest.canonical_renderer,
    pairs,
  });
  const validationErrors = validateComparisonReport(manifest, rawReport);
  if (validationErrors.length) {
    throw new Error(`Generated report is invalid:\n${validationErrors.join("\n")}`);
  }
  const scoredReport = scoreComparisonReport(manifest, rawReport);
  if (!scoredReport.valid) throw new Error("Generated report did not pass scorer validation");

  await fs.mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const rawArtifact = await writeJson(
    path.join(OUTPUT_DIRECTORY, "shared-library-report.v1.json"),
    rawReport,
  );
  const scoredArtifact = await writeJson(
    path.join(OUTPUT_DIRECTORY, "shared-library-score.v1.json"),
    scoredReport,
  );
  const runIndex = {
    schema_version: 1,
    benchmark_id: manifest.benchmark_id,
    benchmark_version: manifest.benchmark_version,
    claim_boundary: rawReport.claim_boundary,
    benchmark_claim_ready: false,
    generated_at: new Date().toISOString(),
    source_revision: process.env.GIT_COMMIT ?? null,
    corpus_manifest: {
      path: path.relative(REPO_ROOT, MANIFEST_PATH),
      sha256: digest(await fs.readFile(MANIFEST_PATH)),
    },
    renderer_fingerprint_sha256: digest(JSON.stringify(manifest.canonical_renderer)),
    artifacts: [rawArtifact, scoredArtifact],
    result: {
      passed: scoredReport.passed,
      pairs_passed: scoredReport.aggregate.pairs_passed,
      pairs_total: scoredReport.aggregate.pairs_total,
      event_f1: scoredReport.aggregate.event_metrics.f1,
      evidence_completeness: scoredReport.aggregate.evidence_metrics.completeness,
    },
  };
  const indexArtifact = await writeJson(path.join(OUTPUT_DIRECTORY, "run-index.v1.json"), runIndex);
  process.stdout.write(`${JSON.stringify({
    output_directory: OUTPUT_DIRECTORY,
    artifacts: [...runIndex.artifacts, indexArtifact],
    result: runIndex.result,
  }, null, 2)}\n`);
} finally {
  await fs.rm(isolatedDirectory, { recursive: true });
}
