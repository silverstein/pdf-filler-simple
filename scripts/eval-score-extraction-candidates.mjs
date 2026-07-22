#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createPhase1ScoreBundle,
  scorePhase1Report,
  verifyPhase1ScoreBundle,
} from "../test/eval/extraction-phase1-scorer.js";
import { loadPreflightEvidenceSidecar, sha256 } from "../test/eval/extraction-phase1-protocol.js";
import { loadExtractionManifest } from "../test/eval/extraction-manifest.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTRACTION_ROOT = path.join(REPO_ROOT, "test", "fixtures", "eval", "extraction");
const PHASE1_ROOT = path.join(EXTRACTION_ROOT, "phase1");

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a value`);
  return process.argv[index + 1];
}

function flag(name) {
  return process.argv.includes(name);
}

async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, "utf8"));
}

async function canonicalPath(filename) {
  const resolved = path.resolve(filename);
  const suffix = [];
  let cursor = resolved;
  while (true) {
    try {
      return path.join(await fs.realpath(cursor), ...suffix.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function assertSafeArtifactPaths(scorePath, indexPath, inputPaths) {
  const [scoreCanonical, indexCanonical, ...inputCanonical] = await Promise.all([
    canonicalPath(scorePath), canonicalPath(indexPath), ...inputPaths.map(canonicalPath),
  ]);
  const identities = await Promise.all([scorePath, indexPath, ...inputPaths].map(async filename => {
    try {
      const stat = await fs.stat(filename);
      return `${stat.dev}:${stat.ino}`;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return null;
    }
  }));
  const [scoreIdentity, indexIdentity, ...inputIdentities] = identities;
  if (scoreCanonical === indexCanonical) throw new Error("Score report and score index outputs must be distinct");
  if (scoreIdentity && scoreIdentity === indexIdentity) throw new Error("Score report and score index outputs must be distinct");
  for (const [output, identity] of [[scoreCanonical, scoreIdentity], [indexCanonical, indexIdentity]]) {
    if (inputCanonical.includes(output) || (identity && inputIdentities.includes(identity))) {
      throw new Error("Score output must not alias a trusted scoring input");
    }
  }
}

export async function scoreExtractionCandidateReport({
  reportPath,
  preflightPath = `${reportPath}.preflight.json`,
  scorePath,
  indexPath = `${scorePath}.index.json`,
  manifestPath = path.join(EXTRACTION_ROOT, "manifest.v1.json"),
  manifestSchemaPath = path.join(EXTRACTION_ROOT, "manifest.schema.json"),
  registryPath = path.join(PHASE1_ROOT, "candidate-registry.v1.json"),
  registrySchemaPath = path.join(PHASE1_ROOT, "candidate-registry.schema.json"),
  planPath = path.join(PHASE1_ROOT, "run-plan.v1.json"),
  planSchemaPath = path.join(PHASE1_ROOT, "run-plan.schema.json"),
  requestSchemaPath = path.join(PHASE1_ROOT, "candidate-request.schema.json"),
  responseSchemaPath = path.join(PHASE1_ROOT, "candidate-response.schema.json"),
  reportSchemaPath = path.join(PHASE1_ROOT, "report.schema.json"),
  oraclePath = path.join(PHASE1_ROOT, "scoring-oracle.v1.json"),
  oracleSchemaPath = path.join(PHASE1_ROOT, "scoring-oracle.schema.json"),
  scoreSchemaPath = path.join(PHASE1_ROOT, "score-report.schema.json"),
  indexSchemaPath = path.join(PHASE1_ROOT, "score-index.schema.json"),
  adapterAvailability = { direct_pdf: true, layout_ir: false, raster: false },
} = {}) {
  if (!reportPath || !scorePath) throw new Error("Scoring requires reportPath and scorePath");
  const scorerModulePath = path.join(REPO_ROOT, "test", "eval", "extraction-phase1-scorer.js");
  const protocolModulePath = path.join(REPO_ROOT, "test", "eval", "extraction-phase1-protocol.js");
  const manifestLoaderPath = path.join(REPO_ROOT, "test", "eval", "extraction-manifest.js");
  const orchestrationPath = fileURLToPath(import.meta.url);
  await assertSafeArtifactPaths(scorePath, indexPath, [
    reportPath, preflightPath, manifestPath, manifestSchemaPath, registryPath, registrySchemaPath,
    planPath, planSchemaPath, requestSchemaPath, responseSchemaPath, reportSchemaPath,
    oraclePath, oracleSchemaPath, scoreSchemaPath, indexSchemaPath, scorerModulePath, protocolModulePath, manifestLoaderPath, orchestrationPath,
  ]);
  await Promise.all([fs.mkdir(path.dirname(scorePath), { recursive: true }), fs.mkdir(path.dirname(indexPath), { recursive: true })]);
  const [reportBytes, preflightEvidenceBytes, manifestBytes, manifestSchemaBytes, registry, registrySchema, plan, planSchema, requestSchema, responseSchema, reportSchema, oracleBytes, oracleSchema, scoreSchema, indexSchema] = await Promise.all([
    fs.readFile(reportPath), fs.readFile(preflightPath), fs.readFile(manifestPath), fs.readFile(manifestSchemaPath),
    readJson(registryPath), readJson(registrySchemaPath), readJson(planPath), readJson(planSchemaPath), readJson(requestSchemaPath), readJson(responseSchemaPath), readJson(reportSchemaPath),
    fs.readFile(oraclePath), readJson(oracleSchemaPath), readJson(scoreSchemaPath), readJson(indexSchemaPath),
  ]);
  const report = JSON.parse(reportBytes);
  const manifestLoaded = await loadExtractionManifest(manifestPath, manifestSchemaPath);
  const failureEvidenceByAttemptKey = await loadPreflightEvidenceSidecar(preflightPath, report);
  const sourceFactsById = Object.fromEntries(await Promise.all(manifestLoaded.manifest.fixtures.map(async fixture => {
    const stat = await fs.stat(path.join(path.dirname(manifestPath), fixture.path));
    return [fixture.id, { sha256: fixture.sha256, size_bytes: stat.size, page_count: fixture.expected.page_geometry.length }];
  })));
  const rolePaths = {
    scorer_module: scorerModulePath,
    scoring_oracle: oraclePath,
    oracle_schema: oracleSchemaPath,
    score_schema: scoreSchemaPath,
    index_schema: indexSchemaPath,
    manifest_loader: manifestLoaderPath,
    orchestration_script: orchestrationPath,
    protocol_module: protocolModulePath,
    report_schema: reportSchemaPath,
  };
  const scorerSourceBytesByRole = Object.fromEntries(await Promise.all(Object.entries(rolePaths).map(async ([role, filename]) => [role, { path: path.relative(REPO_ROOT, filename), bytes: await fs.readFile(filename) }])));
  const context = {
    verification: {
      registry, registrySchema, plan, planSchema, manifest: manifestLoaded.manifest,
      manifestSchema: JSON.parse(manifestSchemaBytes), manifestBytesSha256: sha256(manifestBytes), manifestSchemaBytesSha256: sha256(manifestSchemaBytes),
      sourceFactsById, requestSchema, responseSchema, reportSchema, adapterAvailability, failureEvidenceByAttemptKey, repositoryRoot: REPO_ROOT,
    },
    oracle: JSON.parse(oracleBytes), oracleBytes, oracleSchema, scoreSchema, indexSchema,
    scorerSourceBytesByRole, reportBytes, preflightEvidenceBytes,
  };
  const score = scorePhase1Report(report, context);
  const bundle = createPhase1ScoreBundle(score, { ...context, scorePath, indexPath });
  const suffix = `.tmp-${process.pid}-${randomUUID()}`;
  const temporaryScorePath = `${scorePath}${suffix}`;
  const temporaryIndexPath = `${indexPath}${suffix}`;
  try {
    await Promise.all([fs.writeFile(temporaryScorePath, bundle.scoreText), fs.writeFile(temporaryIndexPath, bundle.indexText)]);
    await fs.rename(temporaryScorePath, scorePath);
    await fs.rename(temporaryIndexPath, indexPath);
  } finally {
    await Promise.all([fs.rm(temporaryScorePath, { force: true }), fs.rm(temporaryIndexPath, { force: true })]);
  }
  const [reloadedScoreText, reloadedIndex] = await Promise.all([fs.readFile(scorePath, "utf8"), readJson(indexPath)]);
  verifyPhase1ScoreBundle({ scoreText: reloadedScoreText, index: reloadedIndex, report, scorePath, indexPath }, context);
  return { score, index: reloadedIndex, scorePath, indexPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reportOption = option("--report", null);
  if (!reportOption) throw new Error("Usage: node scripts/eval-score-extraction-candidates.mjs --report <report.json> [--output <score.json>] [--index <index.json>]");
  const reportPath = path.resolve(reportOption);
  const scorePath = path.resolve(option("--output", `${reportPath}.score.json`));
  const result = await scoreExtractionCandidateReport({
    reportPath,
    preflightPath: path.resolve(option("--preflight", `${reportPath}.preflight.json`)),
    scorePath,
    indexPath: path.resolve(option("--index", `${scorePath}.index.json`)),
    registryPath: path.resolve(option("--registry", path.join(PHASE1_ROOT, "candidate-registry.v1.json"))),
    planPath: path.resolve(option("--plan", path.join(PHASE1_ROOT, "run-plan.v1.json"))),
    adapterAvailability: { direct_pdf: true, layout_ir: flag("--layout-ir-adapter"), raster: flag("--raster-adapter") },
  });
  process.stdout.write(`${JSON.stringify({ score: result.scorePath, index: result.indexPath, denominator: result.score.aggregate.denominator, claim_ready: false }, null, 2)}\n`);
}
