#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadTrajectorySuite,
  summarizeTrajectoryTrials,
  validateTrajectoryTrialSet,
} from "../test/eval/trajectory-grader.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SUITE = path.join(REPO_ROOT, "test", "fixtures", "eval", "trajectories", "jobs.v1.json");
const DEFAULT_TRIALS = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "trajectories",
  "calibration-trials.v1.json"
);

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a value`);
  return path.resolve(process.argv[index + 1]);
}

export async function runTrajectoryEvaluation({ suitePath = DEFAULT_SUITE, trialsPath = DEFAULT_TRIALS } = {}) {
  const suite = await loadTrajectorySuite(suitePath);
  const trialSet = JSON.parse(await fs.readFile(trialsPath, "utf8"));
  const validationErrors = validateTrajectoryTrialSet(suite, trialSet);
  if (validationErrors.length > 0) {
    throw new Error(`Invalid trajectory trial set:\n- ${validationErrors.join("\n- ")}`);
  }
  const summary = summarizeTrajectoryTrials(suite, trialSet.trials, {
    calibration: trialSet.calibration,
    attestation: trialSet.attestation,
    trialSetId: trialSet.trial_set_id,
    claimBoundary: trialSet.claim_boundary,
    runPlan: trialSet.run_plan,
  });
  return {
    trial_set_id: trialSet.trial_set_id,
    trial_set_schema_version: trialSet.trial_set_schema_version,
    calibration: trialSet.calibration,
    claim_boundary: trialSet.claim_boundary,
    ...summary,
    benchmark_claim_ready: trialSet.calibration === false
      && summary.suite_ready
      && summary.trust_ready
      && summary.independence_ready
      && summary.harness_ready
      && summary.sample_size_ready,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runTrajectoryEvaluation({
    suitePath: option("--suite", DEFAULT_SUITE),
    trialsPath: option("--trials", DEFAULT_TRIALS),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
