#!/usr/bin/env node

import { execFileSync } from "node:child_process";
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
import { buildProductPrimitiveReport } from "../test/eval/comparison-product-baseline.js";
import { buildPopplerComparisonSensor } from "../test/eval/comparison-poppler-baseline.js";
import { buildControllerObservationRegistry } from "../test/eval/comparison-observation-registry.js";
import { rendererFingerprint } from "../test/eval/comparison-observations.js";
import { createComparisonAjv } from "../test/eval/comparison-schema-ajv.js";
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
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).trim();
if (process.env.GIT_COMMIT && process.env.GIT_COMMIT !== sourceRevision) {
  throw new Error(`GIT_COMMIT ${process.env.GIT_COMMIT} does not match HEAD ${sourceRevision}`);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  const bytes = await fs.readFile(filePath);
  return { path: path.relative(REPO_ROOT, filePath), sha256: digest(bytes), bytes: bytes.length };
}

const manifest = await loadComparisonManifest(MANIFEST_PATH);
const ajv = createComparisonAjv();
const manifestSchema = JSON.parse(await fs.readFile(path.join(
  REPO_ROOT, "test", "fixtures", "eval", "comparison", "manifest.schema.json"
), "utf8"));
const reportSchema = JSON.parse(await fs.readFile(path.join(
  REPO_ROOT, "test", "fixtures", "eval", "comparison", "report.schema.json"
), "utf8"));
const validateManifestSchema = ajv.compile(manifestSchema);
const validateReportSchema = ajv.compile(reportSchema);
if (!validateManifestSchema(manifest)) {
  throw new Error(`Manifest JSON Schema validation failed: ${JSON.stringify(validateManifestSchema.errors)}`);
}
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
  if (!validateReportSchema(rawReport)) {
    throw new Error(`Shared report JSON Schema validation failed: ${JSON.stringify(validateReportSchema.errors)}`);
  }
  const validationErrors = validateComparisonReport(manifest, rawReport);
  if (validationErrors.length) {
    throw new Error(`Generated report is invalid:\n${validationErrors.join("\n")}`);
  }
  const sharedRegistry = buildControllerObservationRegistry(rawReport, {
    producer: "eval-run-comparison-baselines.mjs",
    truth_loaded_after_report_freeze: false,
    network_enforcement: "not_enforced",
    claim_boundary: "In-process shared-library reference; truth and repository were controller-visible and network was not OS-denied.",
  });
  const scoredReport = scoreComparisonReport(manifest, rawReport, sharedRegistry);
  if (!scoredReport.valid) throw new Error("Generated report did not pass scorer validation");
  const productReport = await buildProductPrimitiveReport({
    benchmarkId: manifest.benchmark_id,
    benchmarkVersion: manifest.benchmark_version,
    renderer: manifest.canonical_renderer,
    pairs,
    repositoryRoot: REPO_ROOT,
    allowedDirectory: isolatedDirectory,
  });
  if (!validateReportSchema(productReport)) {
    throw new Error(`Product report JSON Schema validation failed: ${JSON.stringify(validateReportSchema.errors)}`);
  }
  const productValidationErrors = validateComparisonReport(manifest, productReport);
  if (productValidationErrors.length) {
    throw new Error(`Generated product report is invalid:\n${productValidationErrors.join("\n")}`);
  }
  const productRegistry = buildControllerObservationRegistry(productReport, {
    producer: "eval-run-comparison-baselines.mjs",
    truth_loaded_after_report_freeze: false,
    network_enforcement: "not_enforced",
    claim_boundary: "MCP subprocess used opaque PDFs but repository/environment/network isolation was not OS-enforced.",
  });
  const productScore = scoreComparisonReport(manifest, productReport, productRegistry);
  if (!productScore.valid) throw new Error("Generated product report did not pass scorer validation");
  const popplerSensor = await buildPopplerComparisonSensor({
    benchmarkId: manifest.benchmark_id,
    benchmarkVersion: manifest.benchmark_version,
    pairs,
  });

  await fs.mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const rawArtifact = await writeJson(
    path.join(OUTPUT_DIRECTORY, "shared-library-report.v1.json"),
    rawReport,
  );
  const scoredArtifact = await writeJson(
    path.join(OUTPUT_DIRECTORY, "shared-library-score.v1.json"),
    scoredReport,
  );
  const sharedRegistryArtifact = await writeJson(
    path.join(OUTPUT_DIRECTORY, "shared-library-observation-registry.v1.json"),
    sharedRegistry,
  );
  const productArtifact = await writeJson(
    path.join(OUTPUT_DIRECTORY, "current-product-report.v1.json"),
    productReport,
  );
  const productScoreArtifact = await writeJson(
    path.join(OUTPUT_DIRECTORY, "current-product-score.v1.json"),
    productScore,
  );
  const productRegistryArtifact = await writeJson(
    path.join(OUTPUT_DIRECTORY, "current-product-observation-registry.v1.json"),
    productRegistry,
  );
  const popplerArtifact = await writeJson(
    path.join(OUTPUT_DIRECTORY, "poppler-sensor.v1.json"),
    popplerSensor,
  );
  const runIndex = {
    schema_version: 1,
    benchmark_id: manifest.benchmark_id,
    benchmark_version: manifest.benchmark_version,
    claim_boundary: "Descriptive shared-library and current-product source-server measurements. Truth, repository/shell, and network isolation were not OS-enforced; controller registries are unsigned; neither global score passes; no packed MCPB or native host was tested.",
    benchmark_claim_ready: false,
    generated_at: new Date().toISOString(),
    source_revision: sourceRevision,
    corpus_manifest: {
      path: path.relative(REPO_ROOT, MANIFEST_PATH),
      sha256: digest(await fs.readFile(MANIFEST_PATH)),
    },
    renderer_fingerprint_sha256: rendererFingerprint(manifest.canonical_renderer),
    artifacts: [
      rawArtifact,
      scoredArtifact,
      sharedRegistryArtifact,
      productArtifact,
      productScoreArtifact,
      productRegistryArtifact,
      popplerArtifact,
    ],
    result: {
      shared_library: {
        passed: scoredReport.passed,
        pairs_passed: scoredReport.aggregate.pairs_passed,
        pairs_total: scoredReport.aggregate.pairs_total,
        event_f1: scoredReport.aggregate.event_metrics.f1,
        evidence_completeness: scoredReport.aggregate.evidence_metrics.completeness,
      },
      current_product: {
        passed: productScore.passed,
        pairs_passed: productScore.aggregate.pairs_passed,
        pairs_total: productScore.aggregate.pairs_total,
        event_f1: productScore.aggregate.event_metrics.f1,
        evidence_completeness: productScore.aggregate.evidence_metrics.completeness,
      },
      poppler_sensor: {
        engine_status: popplerSensor.engine_status,
        pairs_observed: popplerSensor.pairs.length,
        event_level_scored: false,
      },
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
