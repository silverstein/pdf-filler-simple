#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_WORKFLOW_V4_ARMS,
  AGENT_WORKFLOW_V4_CAMPAIGN_GATE,
  AGENT_WORKFLOW_V4_PROTOCOL_ID,
  AGENT_WORKFLOW_V4_STATUS,
  balancedAgentWorkflowScheduleV4,
  calculateAgentWorkflowCalibrationV4,
  publicAgentWorkflowCalibrationCommitmentV4,
  syntheticAgentWorkflowCommitmentsV4,
  validateAgentWorkflowBundleProjectionV4,
  validateCommitmentOnlyCampaignPlanV4,
} from "./eval-agent-workflow-protocol-v4.mjs";
import {
  verifiedSourceCommit,
} from "./eval-prepare-agent-workflow-campaign.mjs";
import { parseStrictJson } from "./eval-strict-json.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const CALIBRATION_PATH = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "agent-workflows",
  "agent-workflow-v4.synthetic-calibration.json",
);
const CURRENT_SKILL_PATH = path.join(
  REPO_ROOT,
  "plugins",
  "pdf-tools-workflow",
  "skills",
  "pdf-tools-workflow",
  "SKILL.md",
);
const CURRENT_TOOL_CONTRACT_PATH = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "trajectories",
  "tool-contracts.v3.json",
);
const CURRENT_RUNNER_PATH = path.join(
  REPO_ROOT,
  "scripts",
  "eval-run-codex-agent-workflow-case.mjs",
);
const SYNTHETIC_OUTCOME_SCHEMA_PATH = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "agent-workflows",
  "agent-workflow-v4.synthetic-outcome.schema.json",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileIdentity(filename) {
  const bytes = await fs.readFile(filename);
  return {
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

export async function rehearseAgentWorkflowProtocolV4() {
  const sourceCommit = await verifiedSourceCommit();
  const calibrationBytes = await fs.readFile(CALIBRATION_PATH);
  const calibration = parseStrictJson(
    calibrationBytes,
    "v4 public synthetic calibration",
  );
  if (
    calibration.schema_version
      !== "pdf-tools.agent-workflow.synthetic-calibration.v1"
    || calibration.classification !== "PUBLIC_SYNTHETIC_NOT_MEASURED_EVIDENCE"
    || !Array.isArray(calibration.cases)
  ) {
    throw new Error("v4 public synthetic calibration identity is invalid");
  }
  const repetitions = 2;
  const schedule = balancedAgentWorkflowScheduleV4(
    calibration.cases.map(testCase => testCase.id),
    { repetitions },
  );
  const [
    protocolCore,
    rehearsalScript,
    calibrationFixture,
    syntheticOutcomeSchema,
    currentSkill,
    currentToolContract,
    currentRunner,
  ] = await Promise.all([
    fileIdentity(path.join(
      REPO_ROOT,
      "scripts",
      "eval-agent-workflow-protocol-v4.mjs",
    )),
    fileIdentity(SCRIPT_PATH),
    fileIdentity(CALIBRATION_PATH),
    fileIdentity(SYNTHETIC_OUTCOME_SCHEMA_PATH),
    fileIdentity(CURRENT_SKILL_PATH),
    fileIdentity(CURRENT_TOOL_CONTRACT_PATH),
    fileIdentity(CURRENT_RUNNER_PATH),
  ]);
  const bundle = {
    schema_version: "pdf-tools.agent-workflow.bundle.v4",
    protocol_id: AGENT_WORKFLOW_V4_PROTOCOL_ID,
    status: AGENT_WORKFLOW_V4_STATUS,
    freeze: {
      source_commit: sourceCommit,
      skill: currentSkill,
      tool_contract: currentToolContract,
      response_schema: syntheticOutcomeSchema,
      prompt_assembler: protocolCore,
      runner: currentRunner,
      scorer: protocolCore,
    },
    sealed_inputs: {
      visibility: "synthetic_public_calibration",
      ...syntheticAgentWorkflowCommitmentsV4(calibration, schedule),
    },
    gates: {
      canary: "not_authorized",
      seal: "not_authorized",
      measured_campaign: AGENT_WORKFLOW_V4_CAMPAIGN_GATE.status,
      publication: "not_authorized",
    },
  };
  validateAgentWorkflowBundleProjectionV4(bundle);
  const bundleRootCommitment = publicAgentWorkflowCalibrationCommitmentV4(
    "pdf-tools.agent-workflow.bundle-root.v4",
    bundle,
  );
  const plan = {
    schema_version: "pdf-tools.agent-workflow.campaign-plan.v4",
    protocol_id: AGENT_WORKFLOW_V4_PROTOCOL_ID,
    campaign_id: `synthetic-v4-${bundleRootCommitment.value.slice(0, 32)}`,
    bundle_root_commitment: bundleRootCommitment,
    schedule_commitment: bundle.sealed_inputs.schedule_commitment,
    run_count: schedule.length,
    pair_count: schedule.length / 2,
    repetitions,
    arms: [...AGENT_WORKFLOW_V4_ARMS],
    campaign_gate: AGENT_WORKFLOW_V4_CAMPAIGN_GATE.status,
    visibility: "synthetic_public_calibration",
  };
  validateCommitmentOnlyCampaignPlanV4(plan);
  const oracleByCase = Object.fromEntries(
    calibration.cases.map(testCase => [testCase.id, testCase.oracle]),
  );
  const outcomes = schedule.map(run => ({
    run_id: run.run_id,
    pair_id: run.pair_id,
    case_id: run.case_id,
    arm: run.arm,
    transport_status: "valid",
    ...oracleByCase[run.case_id],
  }));
  const calculation = calculateAgentWorkflowCalibrationV4({
    bundle,
    calibration,
    plan,
    schedule,
    outcomes,
    policy: calibration.policy,
  });
  return {
    schema_version: "pdf-tools.agent-workflow.no-model-rehearsal.v4",
    protocol_id: AGENT_WORKFLOW_V4_PROTOCOL_ID,
    classification: "PUBLIC_SYNTHETIC_NOT_MEASURED_EVIDENCE",
    source_commit: sourceCommit,
    model_invoked: false,
    measured_campaign_gate: AGENT_WORKFLOW_V4_CAMPAIGN_GATE.status,
    bundle_projection: bundle,
    plan,
    authorities: {
      protocol_core: protocolCore,
      rehearsal_script: rehearsalScript,
      calibration_fixture: calibrationFixture,
      synthetic_outcome_schema: syntheticOutcomeSchema,
      current_skill_candidate: currentSkill,
      current_tool_contract_v3_candidate: currentToolContract,
      current_runner_candidate: currentRunner,
    },
    synthetic_calculation: calculation,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  if (process.argv.length !== 2) {
    console.error("Usage: node scripts/eval-rehearse-agent-workflow-protocol-v4.mjs");
    process.exit(2);
  }
  try {
    const receipt = await rehearseAgentWorkflowProtocolV4();
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
