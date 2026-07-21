#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  digestCanonical,
  digestCell,
  digestRunIndex,
  prettyCanonicalJson,
} from "../test/eval/fidelity-integrity.js";
import { sha256 } from "../test/eval/fidelity-observations.js";
import { verifyFidelityRunBundle } from "../test/eval/fidelity-run-bundle.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestedRoot = process.argv[2];
if (!requestedRoot) throw new Error("Usage: node scripts/eval-adversarial-fidelity-bundle.mjs /path/to/verified-run");
const sourceRoot = path.resolve(requestedRoot);

async function readJson(root, filename) {
  return JSON.parse(await fs.readFile(path.join(root, filename), "utf8"));
}

async function writeJson(root, filename, value) {
  await fs.writeFile(path.join(root, filename), prettyCanonicalJson(value));
}

async function expectRejected(label, root, expectedError) {
  const result = await verifyFidelityRunBundle(root, { repoRoot: REPO_ROOT });
  if (result.valid || !result.errors.some(error => error.includes(expectedError))) {
    throw new Error(`${label} was not rejected for ${expectedError}: ${result.errors.join("; ")}`);
  }
  return { label, expected_error: expectedError, observed_errors: result.errors.length };
}

const baseline = await verifyFidelityRunBundle(sourceRoot, { repoRoot: REPO_ROOT });
if (!baseline.valid) throw new Error(`Source bundle is not valid: ${baseline.errors.join("; ")}`);
const evidenceArtifact = baseline.index.artifacts.find(artifact => artifact.cell_id !== null);

async function prepareAttackArtifact(root) {
  if (evidenceArtifact) return evidenceArtifact;
  const index = await readJson(root, "run-index.v2.json");
  const scoreArtifact = index.artifacts.find(artifact => artifact.role === "score");
  const nestedPath = "bound-artifacts/fidelity-score.v2.json";
  await fs.mkdir(path.join(root, path.dirname(nestedPath)), { recursive: true });
  await fs.copyFile(path.join(root, scoreArtifact.path), path.join(root, nestedPath));
  scoreArtifact.path = nestedPath;
  index.run_sha256 = digestRunIndex(index);
  await writeJson(root, "run-index.v2.json", index);
  const prepared = await verifyFidelityRunBundle(root, { repoRoot: REPO_ROOT });
  if (!prepared.valid) throw new Error(`Nested score binding preparation failed: ${prepared.errors.join("; ")}`);
  return scoreArtifact;
}

const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-fidelity-adversarial-"));
const results = [];
try {
  {
    const root = path.join(scratchRoot, "artifact-bytes");
    await fs.cp(sourceRoot, root, { recursive: true });
    const artifact = await prepareAttackArtifact(root);
    await fs.appendFile(path.join(root, artifact.path), Buffer.from([0]));
    results.push(await expectRejected("artifact byte mutation", root, `artifact ${artifact.artifact_id}:`));
  }
  {
    const root = path.join(scratchRoot, "symlink-parent");
    await fs.cp(sourceRoot, root, { recursive: true });
    const artifact = await prepareAttackArtifact(root);
    const artifactParent = path.dirname(path.join(root, artifact.path));
    const movedParent = path.join(scratchRoot, "outside-artifact-parent");
    await fs.rename(artifactParent, movedParent);
    await fs.symlink(movedParent, artifactParent, "dir");
    results.push(await expectRejected("symlinked artifact parent", root, "path contains a symlink"));
  }
  {
    const root = path.join(scratchRoot, "resigned-report");
    await fs.cp(sourceRoot, root, { recursive: true });
    const report = await readJson(root, "fidelity-report.v2.json");
    const index = await readJson(root, "run-index.v2.json");
    const cell = report.cells.find(candidate => candidate.outcome === "completed" && candidate.tool_calls.length > 0);
    cell.tool_calls[0].is_error = !cell.tool_calls[0].is_error;
    const binding = report.cell_bindings.find(candidate => candidate.cell_id === cell.cell_id);
    binding.cell_sha256 = digestCell(cell);
    const reportBytes = prettyCanonicalJson(report);
    await fs.writeFile(path.join(root, "fidelity-report.v2.json"), reportBytes);
    index.cell_bindings = structuredClone(report.cell_bindings);
    index.digests.report_sha256 = sha256(reportBytes);
    index.digests.cell_set_sha256 = digestCanonical("report", report.cell_bindings);
    const reportArtifact = index.artifacts.find(artifact => artifact.role === "report");
    reportArtifact.sha256 = sha256(reportBytes);
    reportArtifact.byte_length = reportBytes.length;
    index.run_sha256 = digestRunIndex(index);
    await writeJson(root, "run-index.v2.json", index);
    results.push(await expectRejected("re-signed report with stale score", root, "persisted score differs from independent recomputation"));
  }
  {
    const root = path.join(scratchRoot, "resigned-index");
    await fs.cp(sourceRoot, root, { recursive: true });
    const index = await readJson(root, "run-index.v2.json");
    index.denominator.completed -= 1;
    index.run_sha256 = digestRunIndex(index);
    await writeJson(root, "run-index.v2.json", index);
    results.push(await expectRejected("re-signed index denominator", root, "index denominator differs from score"));
  }
} finally {
  await fs.rm(scratchRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ baseline_valid: true, attacks_rejected: results }, null, 2)}\n`);
