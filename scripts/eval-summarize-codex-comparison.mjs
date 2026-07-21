#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { runTrajectoryEvaluation } from "./eval-run-trajectories.mjs";
import { validateCampaign } from "./eval-run-codex-comparison.mjs";
import { assertPrivacySafeProjection } from "./eval-comparison-evidence-integrity.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = path.join(
  REPO_ROOT,
  "test", "fixtures", "eval", "comparison", "agent-evidence-summary.schema.json",
);

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required`);
  return path.resolve(process.argv[index + 1]);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readJsonWithBytes(filePath) {
  const bytes = await fs.readFile(filePath);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

function ensureDescriptiveThreeRunReport(report) {
  if (report.attempted_trials !== 3
    || report.product_trials !== 3
    || report.harness_failures !== 0
    || report.passed_trials !== 3
    || report.product_statistics?.pass_rate !== 1
    || report.product_statistics?.sample_variance !== 0
    || report.trust_ready !== false
    || report.independence_ready !== false
    || report.harness_ready !== false
    || report.sample_size_ready !== false
    || report.benchmark_claim_ready !== false) {
    throw new Error("Trajectory report exceeds or contradicts the descriptive three-run boundary");
  }
}

function gitBytes(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "buffer" });
}

function verifySourceFingerprints(campaign) {
  execFileSync("git", ["merge-base", "--is-ancestor", campaign.git_commit, "HEAD"], {
    cwd: REPO_ROOT,
    stdio: "ignore",
  });
  const entries = Object.entries(campaign.source_fingerprints ?? {});
  if (entries.length === 0) throw new Error("Campaign source fingerprints must not be empty");
  for (const [relativePath, expectedSha256] of entries) {
    if (path.isAbsolute(relativePath) || relativePath.includes("..")) {
      throw new Error(`Campaign source fingerprint path is unsafe: ${relativePath}`);
    }
    const actualSha256 = sha256(gitBytes(["show", `${campaign.git_commit}:${relativePath}`]));
    if (actualSha256 !== expectedSha256) {
      throw new Error(`Campaign source fingerprint mismatch for ${relativePath}`);
    }
  }
}

export async function summarizeCodexComparison({
  campaignPath,
  planPath,
  trialsPath,
  reportPath,
}) {
  const [campaignFile, planFile, trialsFile, reportFile] = await Promise.all([
    readJsonWithBytes(campaignPath),
    readJsonWithBytes(planPath),
    readJsonWithBytes(trialsPath),
    readJsonWithBytes(reportPath),
  ]);
  const campaign = campaignFile.value;
  const plan = planFile.value;
  const trials = trialsFile.value;
  const report = reportFile.value;

  validateCampaign(campaign, plan);
  verifySourceFingerprints(campaign);
  if (campaign.plan_raw_sha256 !== sha256(planFile.bytes)) {
    throw new Error("Raw pre-run plan digest does not match the campaign commitment");
  }
  const replayedReport = await runTrajectoryEvaluation({ trialsPath });
  if (canonicalJson(replayedReport) !== canonicalJson(report)) {
    throw new Error("Trajectory report does not replay canonically from retained measured trials");
  }
  ensureDescriptiveThreeRunReport(report);
  if (campaign.trial_set_id !== trials.trial_set_id
    || trials.trial_set_id !== report.trial_set_id
    || campaign.job_id !== "pdf-tools.trajectory.v1.compare-and-explain"
    || campaign.count !== 3
    || campaign.runs.length !== 3
    || trials.run_plan?.entries?.length !== 3
    || trials.trials?.length !== 3
    || report.results?.length !== 3
    || campaign.plan_sha256 !== trials.attestation?.run_plan_sha256
    || trials.trials.some(trial => trial.model !== campaign.model || trial.job_id !== campaign.job_id)) {
    throw new Error("Campaign, plan, trials, and report do not retain one complete three-run comparison set");
  }

  const resultByRepeat = new Map(report.results.map(result => [result.repeat_index, result]));
  const summary = {
    schema_version: 1,
    summary_id: "pdf-tools.comparison-agent-evidence.v1",
    generated_at: campaign.created_at,
    trial_set_id: campaign.trial_set_id,
    job_id: campaign.job_id,
    model: campaign.model,
    source_revision: campaign.git_commit,
    source_digests: {
      campaign_sha256: sha256(campaignFile.bytes),
      pre_run_plan_sha256: sha256(planFile.bytes),
      measured_trials_sha256: sha256(trialsFile.bytes),
      trajectory_report_sha256: sha256(reportFile.bytes),
      run_plan_sha256: campaign.plan_sha256,
    },
    privacy_boundary: {
      projection: true,
      raw_evidence_published: false,
      raw_evidence_retention: "maintainer_private",
      external_replay_ready: false,
      excluded_categories: [
        "absolute_paths",
        "hostnames",
        "usernames",
        "environment",
        "raw_transcripts",
        "retained_image_bytes",
      ],
    },
    denominator: {
      planned: campaign.count,
      attempted: report.attempted_trials,
      product_trials: report.product_trials,
      harness_failures: report.harness_failures,
    },
    result: {
      passed_trials: report.passed_trials,
      pass_rate: report.product_statistics.pass_rate,
      sample_variance: report.product_statistics.sample_variance,
    },
    claim_gates: {
      trust_ready: report.trust_ready,
      independence_ready: report.independence_ready,
      full_suite_harness_ready: report.harness_ready,
      sample_size_ready: report.sample_size_ready,
      native_host: false,
      packed_mcpb: false,
      benchmark_claim_ready: report.benchmark_claim_ready,
    },
    runs: trials.trials.map(trial => {
      const grade = resultByRepeat.get(trial.repeat_index);
      if (!grade || grade.classification !== "product_trial" || grade.passed !== true) {
        throw new Error(`Repeat ${trial.repeat_index} is not a retained passing product trial`);
      }
      return {
        repeat_index: trial.repeat_index,
        classification: grade.classification,
        passed: grade.passed,
        transcript_sha256: trial.sample.transcript_sha256,
        answer_value_sha256: trial.final_answer.answer_value_sha256,
        tool_calls: trial.trajectory.map(step => ({
          tool: step.tool,
          arguments: step.arguments,
          raw_result_sha256: step.result.raw_result_sha256,
        })),
        render_evidence: trial.trajectory.flatMap(step =>
          step.result.semantic_observations.render_regions.map(region => ({
            source: region.source,
            source_sha256: region.source_sha256,
            page: region.page,
            image_sha256: region.image_sha256,
            image_byte_length: region.image_byte_length,
            observed_image_width_px: region.observed_image_width_px,
            observed_image_height_px: region.observed_image_height_px,
            visual_oracle: region.visual_oracle,
          }))),
        effects: {
          created: trial.effects.created.length,
          modified: trial.effects.modified.length,
          deleted: trial.effects.deleted.length,
          external_requests: trial.effects.external_requests.length,
          signature_applied: trial.effects.signature_applied,
        },
      };
    }),
  };

  assertPrivacySafeProjection(summary);
  const schema = JSON.parse(await fs.readFile(SCHEMA_PATH, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  ajv.addFormat("date-time", value => Number.isFinite(Date.parse(value)));
  const validate = ajv.compile(schema);
  if (!validate(summary)) {
    throw new Error(`Agent evidence summary schema failed: ${JSON.stringify(validate.errors)}`);
  }
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputPath = argument("--output");
  const summary = await summarizeCodexComparison({
    campaignPath: argument("--campaign"),
    planPath: argument("--plan"),
    trialsPath: argument("--trials"),
    reportPath: argument("--report"),
  });
  await fs.writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${outputPath}\n`);
}
