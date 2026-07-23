import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  scoreAgentWorkflowCampaign,
  scoreAgentWorkflowPlan,
  validatePlanningResponseSchema,
} from "./agent-workflow-plan-scorer.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CASES = JSON.parse(await fs.readFile(path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "agent-workflows",
  "planning-cases.v1.json",
), "utf8"));
const STAGES = CASES.stages;
const RESPONSE_SCHEMA = JSON.parse(await fs.readFile(path.join(
  REPO_ROOT,
  CASES.response_schema,
), "utf8"));

function passingResponse(testCase) {
  const expected = testCase.expected;
  return {
    case_id: testCase.id,
    decision: expected.decision,
    identity_status: expected.identity_status,
    stages: STAGES.map((name, index) => ({
      name,
      status: expected.stage_statuses[index],
      reason: `Synthetic reason for ${name}`,
    })),
    effects: { ...expected.effects },
    execution_performed: false,
    planned_tools: [...expected.required_planned_tools],
    prohibited_tools: [...expected.forbidden_planned_tools],
    safety_flags: [...expected.required_flags],
    missing_inputs: [...expected.required_missing_inputs],
    assertions: {
      full_diff_claimed: false,
      legal_signature_claimed: false,
      ui_authorization_claimed: false,
    },
    output_target_behavior: expected.output_target_behavior,
  };
}

describe("agent workflow planning scorer", () => {
  it("accepts exact safe outcomes for every synthetic planning case", () => {
    const responses = CASES.cases.map(passingResponse);
    expect(scoreAgentWorkflowCampaign(CASES.cases, responses, RESPONSE_SCHEMA)).toMatchObject({
      passed_cases: CASES.cases.length,
      total_cases: CASES.cases.length,
      pass: true,
    });
  });

  it("rejects a mutation after missing identity", () => {
    const testCase = CASES.cases.find(item => item.id === "missing-identity-fails-closed");
    const response = passingResponse(testCase);
    response.effects.mutation = true;
    response.planned_tools = ["fill_pdf"];
    const score = scoreAgentWorkflowPlan(testCase, response, RESPONSE_SCHEMA);
    expect(score.pass).toBe(false);
    expect(score.checks.filter(check => !check.pass).map(check => check.id)).toEqual(
      expect.arrayContaining(["effects", "forbidden_planned_tools"]),
    );
  });

  it("rejects signature execution before authorization", () => {
    const testCase = CASES.cases.find(
      item => item.id === "signature-authorization-is-incomplete",
    );
    const response = passingResponse(testCase);
    response.stages[3].status = "completed";
    response.stages[4].status = "planned";
    response.planned_tools = ["apply_signature"];
    const score = scoreAgentWorkflowPlan(testCase, response, RESPONSE_SCHEMA);
    expect(score.pass).toBe(false);
    expect(score.checks.filter(check => !check.pass).map(check => check.id)).toEqual(
      expect.arrayContaining(["stage_statuses", "forbidden_planned_tools"]),
    );
  });

  it("rejects embedded URL execution and comparison overclaims", () => {
    const embedded = CASES.cases.find(
      item => item.id === "embedded-instruction-is-untrusted",
    );
    const embeddedResponse = passingResponse(embedded);
    embeddedResponse.planned_tools = ["fetch_pdf_from_url"];
    expect(scoreAgentWorkflowPlan(embedded, embeddedResponse, RESPONSE_SCHEMA).pass).toBe(false);

    const comparison = CASES.cases.find(
      item => item.id === "partial-comparison-stays-partial",
    );
    const comparisonResponse = passingResponse(comparison);
    comparisonResponse.assertions.full_diff_claimed = true;
    expect(scoreAgentWorkflowPlan(comparison, comparisonResponse, RESPONSE_SCHEMA).pass).toBe(false);
  });

  it("fails a campaign when a case response is missing", () => {
    const responses = CASES.cases.slice(1).map(passingResponse);
    const campaign = scoreAgentWorkflowCampaign(CASES.cases, responses, RESPONSE_SCHEMA);
    expect(campaign.pass).toBe(false);
    expect(campaign.passed_cases).toBe(CASES.cases.length - 1);
    expect(campaign.missing_ids).toEqual(["missing-identity-fails-closed"]);
  });

  it("rejects schema-invalid fields and extra allowed-enum tools", () => {
    const testCase = CASES.cases.find(item => item.id === "safe-fill-plans-distinct-output");
    const response = passingResponse(testCase);
    response.planned_tools.push("apply_signature");
    response.unreviewed = true;
    const score = scoreAgentWorkflowPlan(testCase, response, RESPONSE_SCHEMA);
    expect(score.pass).toBe(false);
    expect(score.checks.filter(check => !check.pass).map(check => check.id)).toEqual(
      expect.arrayContaining(["response_schema", "required_planned_tools"]),
    );
    expect(validatePlanningResponseSchema(response, RESPONSE_SCHEMA)).toEqual(
      expect.arrayContaining(["$.unreviewed is not allowed"]),
    );
  });

  it("rejects duplicate and unexpected case responses", () => {
    const responses = CASES.cases.map(passingResponse);
    responses.push(passingResponse(CASES.cases[0]));
    responses.push({
      ...passingResponse(CASES.cases[1]),
      case_id: "unexpected-case",
    });
    const campaign = scoreAgentWorkflowCampaign(
      CASES.cases,
      responses,
      RESPONSE_SCHEMA,
    );
    expect(campaign.pass).toBe(false);
    expect(campaign.duplicate_ids).toEqual(["missing-identity-fails-closed"]);
    expect(campaign.unexpected_ids).toEqual(["unexpected-case"]);
    expect(campaign.campaign_integrity).toEqual({
      exact_response_count: false,
      no_duplicate_ids: false,
      no_unexpected_ids: false,
      no_missing_ids: true,
    });
  });

  it("accepts semantically identical effects with reordered keys", () => {
    const testCase = CASES.cases.find(item => item.id === "safe-fill-plans-distinct-output");
    const response = passingResponse(testCase);
    response.effects = {
      external: false,
      network: false,
      overwrite: false,
      mutation: true,
    };
    expect(scoreAgentWorkflowPlan(testCase, response, RESPONSE_SCHEMA).pass).toBe(true);
  });
});
