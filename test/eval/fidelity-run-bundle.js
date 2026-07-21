import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createComparisonAjv } from "./comparison-schema-ajv.js";
import {
  canonicalJson,
  digestCanonical,
  digestRunIndex,
  verifyCanonicalJsonBytes,
} from "./fidelity-integrity.js";
import { loadFidelityManifest, verifyFidelityDocuments } from "./fidelity-manifest.js";
import { scoreFidelityReport } from "./fidelity-scorer.js";
import { sha256 } from "./fidelity-observations.js";

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function equal(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function safeArtifactPath(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

async function validateArtifactPath(root, relativePath) {
  const resolved = safeArtifactPath(root, relativePath);
  if (!resolved) throw new Error("path escapes run root");
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(root) !== root) {
    throw new Error("run root is not a real directory");
  }
  const components = path.relative(root, resolved).split(path.sep);
  let current = root;
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("path contains a symlink");
    if (index < components.length - 1 && !stat.isDirectory()) throw new Error("path parent is not a directory");
  }
  return resolved;
}

async function readCanonical(filePath, errors, label) {
  try {
    const bytes = await fs.readFile(filePath);
    return { bytes, value: verifyCanonicalJsonBytes(bytes) };
  } catch (error) {
    errors.push(`${label}: ${error.message}`);
    return { bytes: null, value: null };
  }
}

export async function verifyFidelityRunBundle(runRoot, { repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const root = path.resolve(runRoot);
  const errors = [];
  const manifestPath = path.join(repoRoot, "test", "fixtures", "eval", "fidelity", "manifest.v1.json");
  const reportSchemaPath = path.join(repoRoot, "test", "fixtures", "eval", "fidelity", "report.schema.json");
  const indexSchemaPath = path.join(repoRoot, "test", "fixtures", "eval", "fidelity", "run-index.schema.json");
  const runnerPath = path.join(repoRoot, "scripts", "eval-run-fidelity-campaign.mjs");
  const [manifest, reportSchema, indexSchema] = await Promise.all([
    loadFidelityManifest(manifestPath),
    fs.readFile(reportSchemaPath, "utf8").then(JSON.parse),
    fs.readFile(indexSchemaPath, "utf8").then(JSON.parse),
  ]);
  const reportRecord = await readCanonical(path.join(root, "fidelity-report.v2.json"), errors, "report");
  const scoreRecord = await readCanonical(path.join(root, "fidelity-score.v2.json"), errors, "score");
  const indexRecord = await readCanonical(path.join(root, "run-index.v2.json"), errors, "run index");
  const report = reportRecord.value;
  const score = scoreRecord.value;
  const index = indexRecord.value;
  if (!report || !score || !index) return { valid: false, errors, manifest, report, score, index };

  const ajv = createComparisonAjv();
  const validateReport = ajv.compile(reportSchema);
  const validateIndex = ajv.compile(indexSchema);
  if (!validateReport(report)) errors.push(`report schema: ${ajv.errorsText(validateReport.errors, { separator: "; " })}`);
  if (!validateIndex(index)) errors.push(`run-index schema: ${ajv.errorsText(validateIndex.errors, { separator: "; " })}`);

  if (report.digests?.manifest_sha256 !== digestCanonical("manifest", manifest)) errors.push("report manifest digest is stale");
  if (report.digests?.runner_sha256 !== sha256(await fs.readFile(runnerPath))) errors.push("report runner digest is stale");
  const fixtureBindings = await verifyFidelityDocuments(manifestPath, manifest);
  if (!equal(report.fixture_bindings, fixtureBindings) || !fixtureBindings.every(binding => binding.passed)) errors.push("fixture bindings do not match trusted corpus bytes");
  if (index.digests?.manifest_sha256 !== report.digests?.manifest_sha256
    || index.digests?.runner_sha256 !== report.digests?.runner_sha256
    || index.digests?.source_revision !== report.digests?.source_revision) errors.push("index provenance digests differ from report");
  if (!equal(index.provenance, report.provenance) || index.claim_boundary !== report.claim_boundary) errors.push("index provenance differs from report");
  if (index.digests?.report_sha256 !== sha256(reportRecord.bytes)) errors.push("index report byte digest differs");
  if (index.digests?.score_sha256 !== sha256(scoreRecord.bytes)) errors.push("index score byte digest differs");
  if (index.digests?.cell_set_sha256 !== digestCanonical("report", report.cell_bindings)) errors.push("index cell-set digest differs");
  if (!equal(index.cell_bindings, report.cell_bindings)) errors.push("index cell bindings differ from report");
  if (index.run_sha256 !== digestRunIndex(index)) errors.push("run-index digest differs from canonical index content");

  const recomputedScore = scoreFidelityReport(manifest, report);
  if (!equal(score, recomputedScore)) errors.push("persisted score differs from independent recomputation");
  if (!equal(index.denominator, score.denominator)) errors.push("index denominator differs from score");
  const expectedResult = {
    valid: score.valid,
    execution_complete: score.execution_complete,
    passed: score.passed,
    product_failures: score.required_failures.filter(failure => failure.gate !== "harness").length,
    harness_failures: score.denominator.harness_failures,
  };
  if (!equal(index.result, expectedResult) || index.benchmark_claim_ready !== score.passed) errors.push("index result or claim-ready flag differs from score");

  const reportArtifacts = new Map(report.artifacts.map(artifact => [artifact.artifact_id, artifact]));
  if (reportArtifacts.size !== report.artifacts.length) errors.push("report artifact ids are not unique");
  if (new Set(report.artifacts.map(artifact => artifact.path)).size !== report.artifacts.length) errors.push("report artifact paths are not unique");
  const indexRunArtifacts = index.artifacts.filter(artifact => artifact.role === "report" || artifact.role === "score");
  if (indexRunArtifacts.length !== 2) errors.push("index must bind exactly one report and one score artifact");
  if (new Set(index.artifacts.map(artifact => artifact.artifact_id)).size !== index.artifacts.length) errors.push("index artifact ids are not unique");
  if (new Set(index.artifacts.map(artifact => artifact.path)).size !== index.artifacts.length) errors.push("index artifact paths are not unique");
  const indexCellArtifacts = index.artifacts.filter(artifact => artifact.role !== "report" && artifact.role !== "score");
  if (!equal(indexCellArtifacts, report.artifacts)) errors.push("index cell artifacts differ from report artifacts");
  let evidenceIntegrity = true;
  for (const artifact of index.artifacts) {
    try {
      const resolved = await validateArtifactPath(root, artifact.path);
      const stat = await fs.lstat(resolved);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.byte_length || stat.size === 0) throw new Error("not the bound nonempty regular file");
      const bytes = await fs.readFile(resolved);
      if (sha256(bytes) !== artifact.sha256) throw new Error("SHA-256 differs");
    } catch (error) {
      errors.push(`artifact ${artifact.artifact_id}: ${error.message}`);
      evidenceIntegrity = false;
    }
  }
  for (const cell of report.cells) {
    for (const artifactId of cell.artifact_ids) {
      const artifact = reportArtifacts.get(artifactId);
      if (!artifact || artifact.cell_id !== cell.cell_id) {
        errors.push(`${cell.cell_id} references missing or foreign artifact ${artifactId}`);
        evidenceIntegrity = false;
      }
    }
    if (cell.outcome === "completed" && !equal(cell.engines?.poppler, report.engine_fingerprints?.poppler)) {
      errors.push(`${cell.cell_id} Poppler identity differs from report fingerprint`);
    }
    for (const evidence of cell.failure_evidence ?? []) {
      for (const image of [evidence.before, evidence.after, evidence.unexpected_delta_gt8]) {
        const artifact = report.artifacts.find(item => item.path === image.path && item.sha256 === image.sha256 && item.cell_id === cell.cell_id);
        if (!artifact) {
          errors.push(`${cell.cell_id} failure evidence is not artifact-bound: ${image.path}`);
          evidenceIntegrity = false;
        }
      }
    }
  }
  if (report.failure_evidence_integrity !== evidenceIntegrity) errors.push("failure_evidence_integrity does not match independently verified artifacts");
  return { valid: errors.length === 0, errors, manifest, report, score, index };
}
