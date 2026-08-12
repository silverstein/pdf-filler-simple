/**
 * Public protocol core for agent-workflow evaluation v4.
 *
 * This module deliberately contains no measured campaign material. Real cases,
 * oracle answers, scorer thresholds, schedules, prompts, and evidence
 * authority configuration belong to a separately sealed private adapter.
 */

import { createHash } from "node:crypto";

export const AGENT_WORKFLOW_V4_PROTOCOL_ID =
  "pdf-tools.agent-workflow.protocol.v4";
export const AGENT_WORKFLOW_V4_STATUS = "preseal_no_inference";
export const AGENT_WORKFLOW_V4_ARMS = Object.freeze([
  "codex-prompt-full-skill-body",
  "codex-prompt-no-skill-body",
]);
export const AGENT_WORKFLOW_V4_CAMPAIGN_GATE = Object.freeze({
  status: "measured_campaign_not_authorized",
  required_host: "reviewed_macos",
});
export const AGENT_WORKFLOW_V4_V3_CARRYOVER = Object.freeze({
  frozen_skill_bytes: 15571,
  frozen_skill_sha256:
    "c782f69b209bb78af0aca5cb4659d01e64a6d9dc9ae68328ef9e547be6c22f4f",
  applies_to_current_skill: false,
  carries_over: Object.freeze([
    "historical_execution_integrity_result",
    "protocol_invalidation_lessons",
    "fail_closed_evidence_requirements",
  ]),
  does_not_carry_over: Object.freeze([
    "semantic_safety_outcome",
    "semantic_utility_outcome",
    "exact_conformance_outcome",
    "bounded_prompt_effect_outcome",
  ]),
});

const BUNDLE_KEYS = Object.freeze([
  "freeze",
  "gates",
  "protocol_id",
  "schema_version",
  "sealed_inputs",
  "status",
]);
const FREEZE_KEYS = Object.freeze([
  "prompt_assembler",
  "response_schema",
  "runner",
  "scorer",
  "skill",
  "source_commit",
  "tool_contract",
]);
const IDENTITY_KEYS = Object.freeze(["bytes", "sha256"]);
const COMMITMENT_KEYS = Object.freeze(["scheme", "value"]);
const SEALED_INPUT_KEYS = Object.freeze([
  "case_pack_commitment",
  "diagnostic_oracle_commitment",
  "schedule_commitment",
  "scorer_policy_commitment",
  "semantic_oracle_commitment",
  "visibility",
]);
const GATE_KEYS = Object.freeze([
  "canary",
  "measured_campaign",
  "publication",
  "seal",
]);
const PLAN_KEYS = Object.freeze([
  "arms",
  "bundle_root_commitment",
  "campaign_gate",
  "campaign_id",
  "pair_count",
  "protocol_id",
  "repetitions",
  "run_count",
  "schedule_commitment",
  "schema_version",
  "visibility",
]);
const OUTCOME_KEYS = Object.freeze([
  "arm",
  "case_id",
  "exact_diagnostic",
  "pair_id",
  "run_id",
  "semantic_safe",
  "transport_status",
  "utility_success",
]);
const POLICY_KEYS = Object.freeze([
  "control_utility_noninferiority_margin",
  "treatment_semantic_safety_min_rate",
  "treatment_utility_min_rate",
]);
const COMMITMENT_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const CAMPAIGN_ID_PATTERN = /^(?:pdf-tools|synthetic)-v4-[a-f0-9]{32}$/;
const OPAQUE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value, keys) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireCommitment(value, label, {
  schemes = ["blinded-sha256-v1", "public-sha256-v1"],
} = {}) {
  if (
    !exactKeys(value, COMMITMENT_KEYS)
    || !schemes.includes(value.scheme)
    || !COMMITMENT_PATTERN.test(value.value ?? "")
  ) {
    throw new Error(
      `${label} must use an allowed structured commitment scheme`,
    );
  }
}

export function publicAgentWorkflowCalibrationCommitmentV4(domain, value) {
  if (
    typeof domain !== "string"
    || !/^pdf-tools\.agent-workflow\.[a-z0-9.-]+\.v4$/.test(domain)
  ) {
    throw new Error("v4 public calibration commitment domain is invalid");
  }
  return {
    scheme: "public-sha256-v1",
    value: sha256(canonicalJson({ domain, value })),
  };
}

function validateIdentity(value, label) {
  if (
    !exactKeys(value, IDENTITY_KEYS)
    || !Number.isSafeInteger(value.bytes)
    || value.bytes < 1
    || !COMMITMENT_PATTERN.test(value.sha256 ?? "")
  ) {
    throw new Error(`${label} must be an exact byte and SHA-256 identity`);
  }
}

function requireUniqueNonemptyStrings(values, label) {
  if (
    !Array.isArray(values)
    || values.length < 1
    || values.some(value => !CASE_ID_PATTERN.test(value ?? ""))
    || new Set(values).size !== values.length
  ) {
    throw new Error(`${label} must contain unique safe opaque identifiers`);
  }
}

/**
 * Build a deterministic two-arm paired schedule.
 *
 * The function is protocol machinery, not the real measured schedule. A
 * private sealed adapter must freeze the exact case order, repetitions, and
 * resulting schedule before any model inference.
 */
export function balancedAgentWorkflowScheduleV4(
  caseIds,
  {
    repetitions,
  },
) {
  requireUniqueNonemptyStrings(caseIds, "v4 case IDs");
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 100) {
    throw new Error("v4 repetitions must be an integer from 1 through 100");
  }
  const schedule = [];
  for (let repeatIndex = 0; repeatIndex < repetitions; repeatIndex += 1) {
    const offset = repeatIndex % caseIds.length;
    const orderedCases = [
      ...caseIds.slice(offset),
      ...caseIds.slice(0, offset),
    ];
    for (const caseId of orderedCases) {
      const originalIndex = caseIds.indexOf(caseId);
      const treatmentFirst = (originalIndex + repeatIndex) % 2 === 0;
      const arms = treatmentFirst
        ? [...AGENT_WORKFLOW_V4_ARMS]
        : [...AGENT_WORKFLOW_V4_ARMS].reverse();
      const pairId = `${caseId}-r${repeatIndex + 1}`;
      for (const [pairIndex, arm] of arms.entries()) {
        schedule.push({
          ordinal: schedule.length + 1,
          run_id: `${pairId}-${arm}`,
          pair_id: pairId,
          pair_position: pairIndex + 1,
          repeat_index: repeatIndex + 1,
          case_id: caseId,
          arm,
        });
      }
    }
  }
  return schedule;
}

export function validateAgentWorkflowBundleProjectionV4(bundle) {
  if (!exactKeys(bundle, BUNDLE_KEYS)) {
    throw new Error("v4 bundle must use the exact commitment-only schema");
  }
  if (
    bundle.schema_version !== "pdf-tools.agent-workflow.bundle.v4"
    || bundle.protocol_id !== AGENT_WORKFLOW_V4_PROTOCOL_ID
    || bundle.status !== AGENT_WORKFLOW_V4_STATUS
  ) {
    throw new Error("v4 bundle protocol identity or preseal status is invalid");
  }
  if (
    !exactKeys(bundle.freeze, FREEZE_KEYS)
    || !SOURCE_COMMIT_PATTERN.test(bundle.freeze.source_commit ?? "")
  ) {
    throw new Error("v4 bundle freeze must bind one exact source commit");
  }
  for (const field of FREEZE_KEYS.filter(key => key !== "source_commit")) {
    validateIdentity(bundle.freeze[field], `v4 freeze ${field}`);
  }
  if (!exactKeys(bundle.sealed_inputs, SEALED_INPUT_KEYS)) {
    throw new Error("v4 sealed inputs must contain commitments only");
  }
  if (
    ![
      "private_sealed_adapter",
      "synthetic_public_calibration",
    ].includes(bundle.sealed_inputs.visibility)
  ) {
    throw new Error("v4 sealed input visibility is invalid");
  }
  const commitmentScheme = bundle.sealed_inputs.visibility
    === "private_sealed_adapter"
    ? "blinded-sha256-v1"
    : "public-sha256-v1";
  for (const field of SEALED_INPUT_KEYS.filter(key => key !== "visibility")) {
    requireCommitment(
      bundle.sealed_inputs[field],
      `v4 sealed input ${field}`,
      { schemes: [commitmentScheme] },
    );
  }
  if (!exactKeys(bundle.gates, GATE_KEYS)) {
    throw new Error("v4 authority gates must be independent and explicit");
  }
  const expectedGates = {
    canary: "not_authorized",
    seal: "not_authorized",
    measured_campaign: AGENT_WORKFLOW_V4_CAMPAIGN_GATE.status,
    publication: "not_authorized",
  };
  for (const gate of GATE_KEYS) {
    if (bundle.gates[gate] !== expectedGates[gate]) {
      throw new Error(`v4 ${gate} gate is not valid for the preseal projection`);
    }
  }
  return true;
}

export function validateCommitmentOnlyCampaignPlanV4(plan) {
  if (!exactKeys(plan, PLAN_KEYS)) {
    throw new Error(
      "v4 commitment-only campaign plan contains missing or retained material",
    );
  }
  if (
    plan.schema_version !== "pdf-tools.agent-workflow.campaign-plan.v4"
    || plan.protocol_id !== AGENT_WORKFLOW_V4_PROTOCOL_ID
    || !CAMPAIGN_ID_PATTERN.test(plan.campaign_id ?? "")
    || plan.campaign_gate !== AGENT_WORKFLOW_V4_CAMPAIGN_GATE.status
    || ![
      "private_sealed_adapter",
      "synthetic_public_calibration",
    ].includes(plan.visibility)
  ) {
    throw new Error("v4 commitment-only campaign plan identity is invalid");
  }
  const commitmentScheme = plan.visibility === "private_sealed_adapter"
    ? "blinded-sha256-v1"
    : "public-sha256-v1";
  requireCommitment(
    plan.bundle_root_commitment,
    "v4 plan bundle root",
    { schemes: [commitmentScheme] },
  );
  requireCommitment(
    plan.schedule_commitment,
    "v4 plan schedule",
    { schemes: [commitmentScheme] },
  );
  if (
    canonicalJson(plan.arms) !== canonicalJson(AGENT_WORKFLOW_V4_ARMS)
    || !Number.isSafeInteger(plan.repetitions)
    || plan.repetitions < 1
    || plan.repetitions > 100
    || !Number.isSafeInteger(plan.run_count)
    || plan.run_count < 2
    || plan.run_count % 2 !== 0
    || !Number.isSafeInteger(plan.pair_count)
    || plan.pair_count !== plan.run_count / 2
  ) {
    throw new Error("v4 commitment-only campaign plan denominators are invalid");
  }
  return true;
}

function validateSchedule(plan, schedule, {
  expectedCommitmentScheme = null,
} = {}) {
  if (!Array.isArray(schedule) || schedule.length !== plan.run_count) {
    throw new Error("v4 protocol invalid: schedule denominator differs from plan");
  }
  if (
    expectedCommitmentScheme !== null
    && plan.schedule_commitment.scheme !== expectedCommitmentScheme
  ) {
    throw new Error("v4 protocol invalid: schedule commitment scheme is invalid");
  }
  if (
    plan.schedule_commitment.scheme === "public-sha256-v1"
    && canonicalJson(plan.schedule_commitment)
      !== canonicalJson(publicAgentWorkflowCalibrationCommitmentV4(
        "pdf-tools.agent-workflow.schedule.v4",
        schedule,
      ))
  ) {
    throw new Error("v4 protocol invalid: schedule commitment differs from plan");
  }
  const runIds = new Set();
  const pairs = new Map();
  for (const [index, run] of schedule.entries()) {
    if (
      !exactKeys(run, [
        "arm",
        "case_id",
        "ordinal",
        "pair_id",
        "pair_position",
        "repeat_index",
        "run_id",
      ])
      || run.ordinal !== index + 1
      || !AGENT_WORKFLOW_V4_ARMS.includes(run.arm)
      || !Number.isSafeInteger(run.repeat_index)
      || run.repeat_index < 1
      || run.repeat_index > plan.repetitions
      || ![1, 2].includes(run.pair_position)
      || !OPAQUE_ID_PATTERN.test(run.case_id ?? "")
      || !OPAQUE_ID_PATTERN.test(run.pair_id ?? "")
      || !OPAQUE_ID_PATTERN.test(run.run_id ?? "")
      || runIds.has(run.run_id)
    ) {
      throw new Error("v4 protocol invalid: schedule row is malformed or duplicated");
    }
    runIds.add(run.run_id);
    const pair = pairs.get(run.pair_id) ?? [];
    pair.push(run);
    pairs.set(run.pair_id, pair);
  }
  if (pairs.size !== plan.pair_count) {
    throw new Error("v4 protocol invalid: schedule pair count differs from plan");
  }
  const caseIds = new Set(schedule.map(run => run.case_id));
  if (caseIds.size * plan.repetitions * 2 !== schedule.length) {
    throw new Error(
      "v4 protocol invalid: schedule does not cover every case repetition",
    );
  }
  const caseRepetitions = new Set();
  for (const pair of pairs.values()) {
    const caseRepetition =
      `${pair[0]?.case_id ?? ""}\0${pair[0]?.repeat_index ?? ""}`;
    if (
      pair.length !== 2
      || new Set(pair.map(run => run.case_id)).size !== 1
      || new Set(pair.map(run => run.repeat_index)).size !== 1
      || caseRepetitions.has(caseRepetition)
      || canonicalJson(pair.map(run => run.pair_position).sort())
        !== canonicalJson([1, 2])
      || canonicalJson(pair.map(run => run.arm).sort())
        !== canonicalJson([...AGENT_WORKFLOW_V4_ARMS].sort())
    ) {
      throw new Error("v4 protocol invalid: schedule pair is incomplete");
    }
    caseRepetitions.add(caseRepetition);
  }
  const orderedCaseIds = [];
  for (const run of schedule) {
    if (!orderedCaseIds.includes(run.case_id)) orderedCaseIds.push(run.case_id);
  }
  const expectedSchedule = balancedAgentWorkflowScheduleV4(orderedCaseIds, {
    repetitions: plan.repetitions,
  });
  if (canonicalJson(schedule) !== canonicalJson(expectedSchedule)) {
    throw new Error(
      "v4 protocol invalid: schedule differs from balanced protocol order",
    );
  }
}

function validatePolicy(policy) {
  if (!exactKeys(policy, POLICY_KEYS)) {
    throw new Error("v4 protocol invalid: scorer policy is malformed");
  }
  for (const key of [
    "treatment_semantic_safety_min_rate",
    "treatment_utility_min_rate",
  ]) {
    if (
      typeof policy[key] !== "number"
      || !Number.isFinite(policy[key])
      || policy[key] <= 0
      || policy[key] > 1
    ) {
      throw new Error(
        `v4 protocol invalid: ${key} must be greater than zero through one`,
      );
    }
  }
  if (
    typeof policy.control_utility_noninferiority_margin !== "number"
    || !Number.isFinite(policy.control_utility_noninferiority_margin)
    || policy.control_utility_noninferiority_margin <= -1
    || policy.control_utility_noninferiority_margin > 1
  ) {
    throw new Error(
      "v4 protocol invalid: control utility margin must be greater than minus one through one",
    );
  }
}

function validateSyntheticCalibration(calibration) {
  if (
    !exactKeys(calibration, [
      "cases",
      "classification",
      "policy",
      "schema_version",
    ])
    || calibration.schema_version
      !== "pdf-tools.agent-workflow.synthetic-calibration.v1"
    || calibration.classification !== "PUBLIC_SYNTHETIC_NOT_MEASURED_EVIDENCE"
    || !Array.isArray(calibration.cases)
  ) {
    throw new Error("v4 calibration invalid: synthetic fixture is malformed");
  }
  requireUniqueNonemptyStrings(
    calibration.cases.map(testCase => testCase?.id),
    "v4 synthetic case IDs",
  );
  for (const testCase of calibration.cases) {
    if (
      !exactKeys(testCase, ["id", "oracle"])
      || !exactKeys(testCase.oracle, [
        "exact_diagnostic",
        "semantic_safe",
        "utility_success",
      ])
      || Object.values(testCase.oracle).some(value => typeof value !== "boolean")
    ) {
      throw new Error("v4 calibration invalid: synthetic oracle is malformed");
    }
  }
  validatePolicy(calibration.policy);
}

export function syntheticAgentWorkflowCommitmentsV4(calibration, schedule) {
  validateSyntheticCalibration(calibration);
  const semanticOracle = calibration.cases.map(testCase => ({
    id: testCase.id,
    semantic_safe: testCase.oracle.semantic_safe,
    utility_success: testCase.oracle.utility_success,
  }));
  const diagnosticOracle = calibration.cases.map(testCase => ({
    id: testCase.id,
    exact_diagnostic: testCase.oracle.exact_diagnostic,
  }));
  return {
    case_pack_commitment: publicAgentWorkflowCalibrationCommitmentV4(
      "pdf-tools.agent-workflow.case-pack.v4",
      calibration.cases.map(testCase => ({ id: testCase.id })),
    ),
    semantic_oracle_commitment: publicAgentWorkflowCalibrationCommitmentV4(
      "pdf-tools.agent-workflow.semantic-oracle.v4",
      semanticOracle,
    ),
    diagnostic_oracle_commitment: publicAgentWorkflowCalibrationCommitmentV4(
      "pdf-tools.agent-workflow.diagnostic-oracle.v4",
      diagnosticOracle,
    ),
    scorer_policy_commitment: publicAgentWorkflowCalibrationCommitmentV4(
      "pdf-tools.agent-workflow.scorer-policy.v4",
      calibration.policy,
    ),
    schedule_commitment: publicAgentWorkflowCalibrationCommitmentV4(
      "pdf-tools.agent-workflow.schedule.v4",
      schedule,
    ),
  };
}

function rate(values) {
  return values.filter(Boolean).length / values.length;
}

/**
 * Exercise deterministic arithmetic with public synthetic calibration data.
 *
 * This function cannot issue a measured verdict. A private measured verifier
 * must authenticate the sealed bundle, policy, schedule, canary, binder
 * outputs, receipt chain, execution lifecycle, cleanup, and campaign authority
 * before it applies scientific claim language.
 */
export function calculateAgentWorkflowCalibrationV4({
  bundle,
  calibration,
  plan,
  schedule,
  outcomes,
  policy,
}) {
  validateAgentWorkflowBundleProjectionV4(bundle);
  if (bundle.sealed_inputs.visibility !== "synthetic_public_calibration") {
    throw new Error(
      "v4 calibration invalid: public calculator accepts synthetic bundles only",
    );
  }
  validateSyntheticCalibration(calibration);
  validateCommitmentOnlyCampaignPlanV4(plan);
  if (plan.visibility !== "synthetic_public_calibration") {
    throw new Error(
      "v4 calibration invalid: public calculator accepts synthetic plans only",
    );
  }
  const expectedBundleRoot = publicAgentWorkflowCalibrationCommitmentV4(
    "pdf-tools.agent-workflow.bundle-root.v4",
    bundle,
  );
  if (
    canonicalJson(plan.bundle_root_commitment)
      !== canonicalJson(expectedBundleRoot)
  ) {
    throw new Error(
      "v4 calibration invalid: plan bundle root differs from exact bundle",
    );
  }
  validateSchedule(plan, schedule, {
    expectedCommitmentScheme: "public-sha256-v1",
  });
  const expectedCommitments = syntheticAgentWorkflowCommitmentsV4(
    calibration,
    schedule,
  );
  for (const field of Object.keys(expectedCommitments)) {
    if (
      canonicalJson(bundle.sealed_inputs[field])
        !== canonicalJson(expectedCommitments[field])
    ) {
      throw new Error(
        `v4 calibration invalid: ${field} differs from synthetic fixture`,
      );
    }
  }
  if (
    canonicalJson(bundle.sealed_inputs.schedule_commitment)
      !== canonicalJson(plan.schedule_commitment)
  ) {
    throw new Error(
      "v4 calibration invalid: bundle schedule differs from plan",
    );
  }
  validatePolicy(policy);
  const expectedPolicyCommitment = publicAgentWorkflowCalibrationCommitmentV4(
    "pdf-tools.agent-workflow.scorer-policy.v4",
    policy,
  );
  if (
    canonicalJson(bundle.sealed_inputs.scorer_policy_commitment)
      !== canonicalJson(expectedPolicyCommitment)
  ) {
    throw new Error(
      "v4 calibration invalid: scorer policy differs from bundle commitment",
    );
  }
  if (!Array.isArray(outcomes) || outcomes.length !== schedule.length) {
    throw new Error("v4 protocol invalid: outcome denominator differs from schedule");
  }
  const outcomeIds = new Set();
  const oracleByCase = new Map(
    calibration.cases.map(testCase => [testCase.id, testCase.oracle]),
  );
  for (const [index, outcome] of outcomes.entries()) {
    const scheduled = schedule[index];
    const oracle = oracleByCase.get(outcome?.case_id);
    if (
      !exactKeys(outcome, OUTCOME_KEYS)
      || outcome.run_id !== scheduled.run_id
      || outcome.pair_id !== scheduled.pair_id
      || outcome.case_id !== scheduled.case_id
      || outcome.arm !== scheduled.arm
      || !["valid", "model_error"].includes(outcome.transport_status)
      || typeof outcome.semantic_safe !== "boolean"
      || typeof outcome.utility_success !== "boolean"
      || typeof outcome.exact_diagnostic !== "boolean"
      || !oracle
      || outcomeIds.has(outcome.run_id)
    ) {
      throw new Error(
        "v4 protocol invalid: outcome identity, order, or contract differs from schedule",
      );
    }
    if (
      outcome.transport_status === "model_error"
      && (
        outcome.semantic_safe
        || outcome.utility_success
        || outcome.exact_diagnostic
      )
    ) {
      throw new Error(
        "v4 protocol invalid: model error cannot carry passing oracle outcomes",
      );
    }
    if (
      outcome.transport_status === "valid"
      && (
        outcome.semantic_safe !== oracle.semantic_safe
        || outcome.utility_success !== oracle.utility_success
        || outcome.exact_diagnostic !== oracle.exact_diagnostic
      )
    ) {
      throw new Error(
        "v4 calibration invalid: valid outcome differs from synthetic oracle",
      );
    }
    outcomeIds.add(outcome.run_id);
  }

  const treatment = outcomes.filter(
    outcome => outcome.arm === AGENT_WORKFLOW_V4_ARMS[0],
  );
  const control = outcomes.filter(
    outcome => outcome.arm === AGENT_WORKFLOW_V4_ARMS[1],
  );
  const treatmentSafetyRate = rate(treatment.map(outcome => outcome.semantic_safe));
  const treatmentUtilityRate = rate(
    treatment.map(outcome => outcome.utility_success),
  );
  const controlUtilityRate = rate(control.map(outcome => outcome.utility_success));
  const utilityDifference = treatmentUtilityRate - controlUtilityRate;
  const semanticSafetyConditionMet =
    treatmentSafetyRate >= policy.treatment_semantic_safety_min_rate;
  const semanticUtilityConditionMet =
    treatmentUtilityRate >= policy.treatment_utility_min_rate
    && utilityDifference >= policy.control_utility_noninferiority_margin;
  const exactDiagnosticRate = rate(
    treatment.map(outcome => outcome.exact_diagnostic),
  );
  const exactDiagnosticConditionMet = exactDiagnosticRate === 1;

  return {
    schema_version: "pdf-tools.agent-workflow.synthetic-calculation.v4",
    protocol_id: AGENT_WORKFLOW_V4_PROTOCOL_ID,
    classification: "PUBLIC_SYNTHETIC_NOT_MEASURED_EVIDENCE",
    calibration_wiring_valid: true,
    scheduled_rows: schedule.length,
    complete_synthetic_pairs: plan.pair_count,
    model_error_runs: outcomes.filter(
      outcome => outcome.transport_status === "model_error",
    ).length,
    unscorable_runs: 0,
    safety_arithmetic: {
      condition_met: semanticSafetyConditionMet,
      treatment_rate: treatmentSafetyRate,
      threshold: policy.treatment_semantic_safety_min_rate,
    },
    utility_arithmetic: {
      condition_met: semanticUtilityConditionMet,
      treatment_rate: treatmentUtilityRate,
      control_rate: controlUtilityRate,
      treatment_minus_control: utilityDifference,
      treatment_threshold: policy.treatment_utility_min_rate,
      noninferiority_margin: policy.control_utility_noninferiority_margin,
    },
    exact_diagnostic_arithmetic: {
      condition_met: exactDiagnosticConditionMet,
      treatment_rate: exactDiagnosticRate,
      controls_combined_semantic_conditions: false,
    },
    combined_semantic_arithmetic: {
      condition_met:
        semanticSafetyConditionMet && semanticUtilityConditionMet,
      exact_diagnostic_controls_condition: false,
    },
    measured_campaign_gate: AGENT_WORKFLOW_V4_CAMPAIGN_GATE.status,
  };
}
