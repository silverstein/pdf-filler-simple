#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bindAgentWorkflowRun,
} from "./eval-bind-agent-workflow-run.mjs";
import {
  scoreAgentWorkflowPlan,
} from "../test/eval/agent-workflow-plan-scorer.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const SCORER_PATH = path.join(
  REPO_ROOT,
  "test",
  "eval",
  "agent-workflow-plan-scorer.js",
);
const SCRIPT_ARTIFACT =
  "scripts/eval-score-agent-workflow-repeated-campaign.mjs";
const SCORER_ARTIFACT = "test/eval/agent-workflow-plan-scorer.js";
const TREATMENT_ARM = "codex-prompt-full-skill-body";
const CONTROL_ARM = "codex-prompt-no-skill-body";
const SAFETY_CRITICAL_CHECKS = new Set([
  "decision",
  "identity_status",
  "stage_statuses",
  "effects",
  "no_execution",
  "required_flags",
  "required_missing_inputs",
  "required_planned_tools",
  "forbidden_planned_tools",
  "forbidden_tools_declared",
  "no_overclaims",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function equalJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizedBoundManifest(value) {
  const copy = structuredClone(value);
  if (copy?.event_validation) copy.event_validation.file = "<EVENT_FILE>";
  return copy;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function pathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function summarizeArm(runs) {
  const passedChecks = runs.reduce((sum, run) => sum + run.score.passed, 0);
  const totalChecks = runs.reduce((sum, run) => sum + run.score.total, 0);
  return {
    runs: runs.length,
    exact_runs: runs.filter(run => run.score.pass).length,
    passed_checks: passedChecks,
    total_checks: totalChecks,
    check_rate: totalChecks === 0 ? null : passedChecks / totalChecks,
    safety_critical_failures: runs.flatMap(run =>
      run.score.checks
        .filter(check => SAFETY_CRITICAL_CHECKS.has(check.id) && !check.pass)
        .map(check => ({
          run_id: run.schedule.run_id,
          case_id: run.schedule.case_id,
          repeat_index: run.schedule.repeat_index,
          check_id: check.id,
        }))),
  };
}

export async function scoreRepeatedAgentWorkflowCampaign({
  resultsRoot,
  preparationManifestPath,
  oraclePath,
  outputPath,
}) {
  for (const [label, value] of Object.entries({
    resultsRoot,
    preparationManifestPath,
    oraclePath,
    outputPath,
  })) {
    if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  }
  if (pathInside(resultsRoot, outputPath)) {
    throw new Error("campaign score output must remain outside the raw results root");
  }

  const [preparationBytes, oracleBytes, scriptBytes, scorerBytes] = await Promise.all([
    fs.readFile(preparationManifestPath),
    fs.readFile(oraclePath),
    fs.readFile(SCRIPT_PATH),
    fs.readFile(SCORER_PATH),
  ]);
  const preparation = parseJson(preparationBytes, "preparation manifest");
  const oracle = parseJson(oracleBytes, "oracle");
  if (
    ![
      "inline-full-body-heldout-v1",
      "inline-full-body-heldout-v2",
    ].includes(preparation.protocol_id)
    || oracle.protocol_id !== preparation.protocol_id
    || oracle.source_commit !== preparation.source_commit
    || sha256(oracleBytes) !== preparation.oracle_sha256
    || sha256(scriptBytes)
      !== preparation.controller_artifacts?.[SCRIPT_ARTIFACT]?.sha256
    || sha256(scorerBytes)
      !== preparation.controller_artifacts?.[SCORER_ARTIFACT]?.sha256
    || sha256(canonicalJson(preparation.run_schedule))
      !== preparation.run_schedule_sha256
  ) {
    throw new Error("trusted campaign inputs do not match the frozen preparation");
  }

  const expectedRunIds = preparation.run_schedule.map(entry => entry.run_id);
  if (
    new Set(expectedRunIds).size !== expectedRunIds.length
    || new Set(preparation.run_schedule.map(entry => entry.ordinal)).size
      !== preparation.run_schedule.length
    || !equalJson(
      preparation.run_schedule.map(entry => entry.ordinal),
      Array.from(
        { length: preparation.run_schedule.length },
        (_, index) => index + 1,
      ),
    )
  ) {
    throw new Error("frozen schedule contains duplicate or invalid run identities");
  }
  for (const testCase of oracle.cases) {
    for (const arm of [TREATMENT_ARM, CONTROL_ARM]) {
      if (preparation.run_schedule.filter(entry =>
        entry.case_id === testCase.id && entry.arm === arm).length !== 3) {
        throw new Error("frozen schedule must contain exactly three runs per case and arm");
      }
    }
  }
  const resultEntries = await fs.readdir(resultsRoot, { withFileTypes: true });
  if (resultEntries.some(entry => !entry.isDirectory())) {
    throw new Error("raw results root may contain only scheduled run directories");
  }
  const actualRunIds = resultEntries.map(entry => entry.name).sort();
  if (!equalJson(actualRunIds, [...expectedRunIds].sort())) {
    throw new Error("raw results root does not contain the exact frozen run schedule");
  }

  const casesById = new Map(oracle.cases.map(testCase => [testCase.id, testCase]));
  const preparationSha256 = sha256(preparationBytes);
  const runs = [];
  for (const scheduled of preparation.run_schedule) {
    const scheduledRoot = path.join(resultsRoot, scheduled.run_id);
    const manifestPath = path.join(
      scheduledRoot,
      "run-manifest.json",
    );
    const manifestBytes = await fs.readFile(manifestPath);
    const manifest = parseJson(manifestBytes, `run manifest ${scheduled.run_id}`);
    const reboundRoot = await fs.mkdtemp(path.join(
      os.tmpdir(),
      "pdf-tools-agent-workflow-rebind-",
    ));
    let rebound;
    try {
      for (const entry of await fs.readdir(scheduledRoot)) {
        if (entry !== "run-manifest.json") {
          await fs.cp(
            path.join(scheduledRoot, entry),
            path.join(reboundRoot, entry),
            { recursive: true },
          );
        }
      }
      rebound = await bindAgentWorkflowRun({
        runRoot: reboundRoot,
        preparationManifestPath,
        arm: scheduled.arm,
        caseId: scheduled.case_id,
        runId: scheduled.run_id,
        outputPath: path.join(reboundRoot, "run-manifest.json"),
      });
    } finally {
      await fs.rm(reboundRoot, { recursive: true, force: true });
    }
    if (!equalJson(
      normalizedBoundManifest(rebound),
      normalizedBoundManifest(manifest),
    )) {
      throw new Error(`stored run manifest does not rebind: ${scheduled.run_id}`);
    }
    if (
      manifest.claim_ready !== true
      || manifest.run_id !== scheduled.run_id
      || manifest.schedule_ordinal !== scheduled.ordinal
      || manifest.arm !== scheduled.arm
      || manifest.case_id !== scheduled.case_id
      || manifest.repeat_index !== scheduled.repeat_index
      || manifest.pair_id !== scheduled.pair_id
      || manifest.pair_position !== scheduled.pair_position
      || manifest.run_schedule_sha256 !== preparation.run_schedule_sha256
      || manifest.source_commit !== preparation.source_commit
      || manifest.preparation_manifest?.sha256 !== preparationSha256
      || manifest.event_validation?.pass !== true
      || manifest.event_validation?.model_callable_tool_items !== 0
      || !Number.isFinite(manifest.event_validation?.input_tokens)
      || !Number.isFinite(manifest.event_validation?.output_tokens)
      || !equalJson(
        manifest.controller_artifacts,
        preparation.controller_artifacts,
      )
      || manifest.intervention_evidence?.id !== preparation.intervention.id
      || manifest.intervention_evidence?.condition !== (
        scheduled.arm === TREATMENT_ARM
          ? "full_skill_body_present"
          : "no_skill_body_present"
      )
      || !manifest.prompt_input_evidence
    ) {
      throw new Error(`bound run differs from schedule: ${scheduled.run_id}`);
    }
    const testCase = casesById.get(scheduled.case_id);
    if (!testCase) throw new Error(`oracle is missing case ${scheduled.case_id}`);
    runs.push({
      schedule: scheduled,
      manifest_sha256: sha256(manifestBytes),
      manifest,
      score: scoreAgentWorkflowPlan(testCase, manifest.response),
    });
  }

  const isolationFields = ["case_root", "results_root", "codex_home"];
  for (const field of isolationFields) {
    const values = runs.map(run => run.manifest.runtime_isolation?.[field]);
    if (
      values.some(value => typeof value !== "string" || !path.isAbsolute(value))
      || new Set(values).size !== values.length
    ) {
      throw new Error(`every run must have a distinct absolute ${field}`);
    }
  }
  for (let index = 0; index < runs.length; index += 1) {
    const started = Date.parse(runs[index].manifest.timing?.started_at);
    const finished = Date.parse(runs[index].manifest.timing?.finished_at);
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
      throw new Error(`invalid run timing: ${runs[index].schedule.run_id}`);
    }
    if (index > 0) {
      const previousFinished = Date.parse(runs[index - 1].manifest.timing.finished_at);
      if (started < previousFinished) {
        throw new Error("run timing does not follow the frozen sequential schedule");
      }
    }
  }
  const hostIdentities = new Set(runs.map(run => canonicalJson(run.manifest.host)));
  const requestedModels = new Set(runs.map(run => run.manifest.model));
  const threadIds = runs.map(run => run.manifest.event_validation.thread_id);
  const messageItemIds = runs.map(
    run => run.manifest.event_validation.agent_message_item_id,
  );
  const rawEventHashes = runs.map(
    run => run.manifest.event_validation.raw_sha256,
  );
  const compoundEventIds = runs.map(run =>
    `${run.manifest.event_validation.thread_id}\0${run.manifest.event_validation.agent_message_item_id}`);
  const developerDigests = new Set(runs.map(
    run => run.manifest.prompt_input_evidence.normalized_developer_sha256,
  ));
  const environmentDigests = new Set(runs.map(
    run => run.manifest.prompt_input_evidence
      .normalized_environment_context_sha256,
  ));
  if (
    hostIdentities.size !== 1
    || requestedModels.size !== 1
    || threadIds.some(value => typeof value !== "string" || !value)
    || new Set(threadIds).size !== runs.length
    || messageItemIds.some(value => typeof value !== "string" || !value)
    || new Set(compoundEventIds).size !== runs.length
    || rawEventHashes.some(value => typeof value !== "string" || !value)
    || new Set(rawEventHashes).size !== runs.length
    || developerDigests.size !== 1
    || environmentDigests.size !== 1
  ) {
    throw new Error(
      "host, prompt context, requested model, or event replay identity differs across runs",
    );
  }

  const treatmentRuns = runs.filter(run => run.schedule.arm === TREATMENT_ARM);
  const controlRuns = runs.filter(run => run.schedule.arm === CONTROL_ARM);
  const arms = {
    [TREATMENT_ARM]: summarizeArm(treatmentRuns),
    [CONTROL_ARM]: summarizeArm(controlRuns),
  };
  const pairs = [];
  for (const pairId of [...new Set(runs.map(run => run.schedule.pair_id))]) {
    const pairRuns = runs.filter(run => run.schedule.pair_id === pairId);
    const treatment = pairRuns.find(run => run.schedule.arm === TREATMENT_ARM);
    const control = pairRuns.find(run => run.schedule.arm === CONTROL_ARM);
    if (
      pairRuns.length !== 2
      || !treatment
      || !control
      || treatment.schedule.case_id !== control.schedule.case_id
      || treatment.schedule.repeat_index !== control.schedule.repeat_index
      || treatment.manifest.prompt_input_evidence.normalized_developer_sha256
        !== control.manifest.prompt_input_evidence.normalized_developer_sha256
      || treatment.manifest.prompt_input_evidence
        .normalized_environment_context_sha256
        !== control.manifest.prompt_input_evidence
          .normalized_environment_context_sha256
      || treatment.manifest.prompt_input_evidence
        .normalized_evaluation_prompt_sha256
        !== control.manifest.prompt_input_evidence
          .normalized_evaluation_prompt_sha256
      || treatment.manifest.prompt_input_evidence.shared_evaluation_prompt_sha256
        !== control.manifest.prompt_input_evidence.shared_evaluation_prompt_sha256
    ) {
      throw new Error(`incomplete paired trial: ${pairId}`);
    }
    pairs.push({
      pair_id: pairId,
      case_id: treatment.schedule.case_id,
      repeat_index: treatment.schedule.repeat_index,
      treatment_first: treatment.schedule.pair_position === 1,
      treatment_passed_checks: treatment.score.passed,
      control_passed_checks: control.score.passed,
      check_delta: treatment.score.passed - control.score.passed,
      treatment_exact: treatment.score.pass,
      control_exact: control.score.pass,
    });
  }
  const perCase = Object.fromEntries(oracle.cases.map(testCase => {
    const casePairs = pairs.filter(pair => pair.case_id === testCase.id);
    const delta = casePairs.reduce((sum, pair) => sum + pair.check_delta, 0);
    return [testCase.id, {
      pairs: casePairs.length,
      check_delta: delta,
      positive_repetitions: casePairs.filter(pair => pair.check_delta > 0).length,
      tied_repetitions: casePairs.filter(pair => pair.check_delta === 0).length,
      negative_repetitions: casePairs.filter(pair => pair.check_delta < 0).length,
    }];
  }));
  const caseSummaries = Object.values(perCase);
  const integrityReady = runs.length === preparation.run_schedule.length
    && pairs.length === preparation.run_schedule.length / 2
    && runs.every(run => run.manifest.event_validation.model_callable_tool_items === 0);
  const treatmentSafetyReady =
    arms[TREATMENT_ARM].safety_critical_failures.length === 0;
  const treatmentOnlyExactWins = pairs.filter(
    pair => pair.treatment_exact && !pair.control_exact,
  ).length;
  const controlOnlyExactWins = pairs.filter(
    pair => !pair.treatment_exact && pair.control_exact,
  ).length;
  const treatmentExactReady =
    arms[TREATMENT_ARM].exact_runs === treatmentRuns.length;
  const comparativeSignalReady =
    treatmentOnlyExactWins >= 6 && controlOnlyExactWins === 0;

  const result = {
    schema_version: "pdf-tools.agent-workflow-repeated-campaign-score.v2",
    claim_boundary: "Descriptive paired planning evidence for exact workflow Markdown present in the Codex user prompt versus absent. No inferential population claim, native skill-loading claim, PDF execution claim, MCP or MCPB claim, Claude claim, or independent benchmark claim is supported.",
    source_commit: preparation.source_commit,
    protocol_id: preparation.protocol_id,
    intervention_id: preparation.intervention.id,
    host: runs[0].manifest.host,
    requested_model: runs[0].manifest.model,
    preparation_manifest_sha256: preparationSha256,
    oracle_sha256: sha256(oracleBytes),
    run_schedule_sha256: preparation.run_schedule_sha256,
    run_count: runs.length,
    pair_count: pairs.length,
    arms,
    pairs,
    per_case: perCase,
    acceptance: {
      integrity_ready: integrityReady,
      treatment_safety_ready: treatmentSafetyReady,
      treatment_exact_ready: treatmentExactReady,
      comparative_signal_ready: comparativeSignalReady,
      treatment_only_exact_pair_wins: treatmentOnlyExactWins,
      control_only_exact_pair_wins: controlOnlyExactWins,
      protocol_go: integrityReady
        && treatmentSafetyReady
        && treatmentExactReady,
      comparative_claim_go: integrityReady
        && treatmentSafetyReady
        && treatmentExactReady
        && comparativeSignalReady,
    },
    statistics_boundary: {
      inferential_test_predeclared: false,
      effect_interval_predeclared: false,
      interpretation: "Report paired check deltas and repeat consistency descriptively only.",
    },
    runs: runs.map(run => ({
      ...run.schedule,
      manifest_sha256: run.manifest_sha256,
      passed_checks: run.score.passed,
      total_checks: run.score.total,
      exact: run.score.pass,
      failed_checks: run.score.checks
        .filter(check => !check.pass)
        .map(check => check.id),
    })),
  };
  await fs.writeFile(
    outputPath,
    `${JSON.stringify(result, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return result;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    values[argv[index]] = argv[index + 1];
  }
  const mapping = {
    resultsRoot: "--results-root",
    preparationManifestPath: "--preparation-manifest",
    oraclePath: "--oracle",
    outputPath: "--output",
  };
  const result = {};
  for (const [key, flag] of Object.entries(mapping)) {
    if (!values[flag]) throw new Error(`Missing required argument: ${flag}`);
    result[key] = values[flag];
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  const result = await scoreRepeatedAgentWorkflowCampaign(
    parseArgs(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify({
    protocol_go: result.acceptance.protocol_go,
    run_count: result.run_count,
    pair_count: result.pair_count,
    treatment_passed_checks: result.arms[TREATMENT_ARM].passed_checks,
    control_passed_checks: result.arms[CONTROL_ARM].passed_checks,
  })}\n`);
}
