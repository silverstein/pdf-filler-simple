import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONDITION_END,
  FULL_BODY_CONTROL_ARM,
  FULL_BODY_END,
  FULL_BODY_START,
  FULL_BODY_TREATMENT_ARM,
} from "../../scripts/eval-prepare-agent-workflow-campaign.mjs";
import {
  balancedSemanticSchedule,
  prepareAgentWorkflowCampaignV3,
} from "../../scripts/eval-prepare-agent-workflow-campaign-v3.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CASES = JSON.parse(await fs.readFile(path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "agent-workflows",
  "planning-cases.heldout.v3.json",
), "utf8"));
const roots = [];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function allText(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const values = [];
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) values.push(await allText(absolute));
    else values.push(await fs.readFile(absolute, "utf8"));
  }
  return values.join("\n");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })));
});

describe("agent workflow v3 preparation", () => {
  it("creates an exact 96-run schedule balanced within every case", () => {
    const caseIds = CASES.cases.map(testCase => testCase.id);
    const schedule = balancedSemanticSchedule(caseIds);
    expect(schedule).toHaveLength(96);
    expect(new Set(schedule.map(entry => entry.run_id)).size).toBe(96);
    expect(schedule.map(entry => entry.ordinal)).toEqual(
      Array.from({ length: 96 }, (_, index) => index + 1),
    );
    for (const caseId of caseIds) {
      expect(schedule.filter(entry =>
        entry.case_id === caseId
        && entry.arm === FULL_BODY_TREATMENT_ARM)).toHaveLength(4);
      expect(schedule.filter(entry =>
        entry.case_id === caseId
        && entry.arm === FULL_BODY_CONTROL_ARM)).toHaveLength(4);
      expect(schedule.filter(entry =>
        entry.case_id === caseId
        && entry.pair_position === 1
        && entry.arm === FULL_BODY_TREATMENT_ARM)).toHaveLength(2);
      expect(schedule.filter(entry =>
        entry.case_id === caseId
        && entry.pair_position === 1
        && entry.arm === FULL_BODY_CONTROL_ARM)).toHaveLength(2);
    }
    expect(() => balancedSemanticSchedule(caseIds.slice(1))).toThrow(
      /exactly twelve cases/,
    );
  });

  it("separates prompt-only participants from both independent oracles", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "pdf-workflow-v3-prepare-")),
    );
    roots.push(root);
    const participants = path.join(root, "participants");
    const oracleRoot = path.join(root, "oracle");
    const manifest = await prepareAgentWorkflowCampaignV3({
      participantsDestination: participants,
      oracleDestination: oracleRoot,
    });
    expect(manifest).toMatchObject({
      protocol_id: "inline-full-body-semantic-heldout-v3",
      case_count: 12,
      repetitions: 4,
      run_count: 96,
      pair_count: 48,
      intervention: {
        id: "full_skill_markdown_in_user_prompt_v3",
        treatment_arm: FULL_BODY_TREATMENT_ARM,
        control_arm: FULL_BODY_CONTROL_ARM,
        skill_body_bytes: 15571,
        skill_body_sha256:
          "c782f69b209bb78af0aca5cb4659d01e64a6d9dc9ae68328ef9e547be6c22f4f",
      },
    });
    expect(manifest.prior_resource_bindings.campaigns).toMatchObject({
      "inline-full-body-heldout-v1": { outcome: "NO_GO" },
      "inline-full-body-heldout-v2": { outcome: "NO_GO" },
    });
    const participantText = await allText(participants);
    expect(participantText).not.toContain('"semantic":');
    expect(participantText).not.toContain('"conformance":');
    expect(participantText).not.toContain('"permitted_now_ceiling":');
    expect(participantText).not.toContain('"expected":');

    const caseId = "single-encrypted-zero-evidence";
    const treatmentPrompt = await fs.readFile(path.join(
      participants,
      FULL_BODY_TREATMENT_ARM,
      "cases",
      caseId,
      "prompt.txt",
    ), "utf8");
    const controlPrompt = await fs.readFile(path.join(
      participants,
      FULL_BODY_CONTROL_ARM,
      "cases",
      caseId,
      "prompt.txt",
    ), "utf8");
    const skillBody = await fs.readFile(path.join(
      REPO_ROOT,
      "plugins",
      "pdf-tools-workflow",
      "skills",
      "pdf-tools-workflow",
      "SKILL.md",
    ), "utf8");
    expect(treatmentPrompt).toContain(`${FULL_BODY_START}\n${skillBody}`);
    expect(treatmentPrompt).toContain(`\n${FULL_BODY_END}\n${CONDITION_END}\n\n`);
    expect(controlPrompt).toContain(`${FULL_BODY_START}\n\n${FULL_BODY_END}`);
    expect(controlPrompt).not.toContain("# PDF Tools workflow");
    expect(treatmentPrompt.replace(
      `${FULL_BODY_START}\n${skillBody}\n${FULL_BODY_END}`,
      `${FULL_BODY_START}\n\n${FULL_BODY_END}`,
    )).toBe(controlPrompt);
    expect(sha256(treatmentPrompt)).toBe(
      manifest.paired_case_contracts[caseId].treatment_prompt_sha256,
    );
    expect(sha256(controlPrompt)).toBe(
      manifest.paired_case_contracts[caseId].control_prompt_sha256,
    );

    const oracle = JSON.parse(await fs.readFile(
      path.join(oracleRoot, "oracle.json"),
      "utf8",
    ));
    expect(oracle).toMatchObject({
      protocol_id: "inline-full-body-semantic-heldout-v3",
      cases: expect.arrayContaining([
        expect.objectContaining({
          id: caseId,
          semantic: expect.objectContaining({ id: caseId }),
          conformance: expect.objectContaining({ id: caseId }),
        }),
      ]),
    });
    expect(oracle.cases).toHaveLength(12);
    expect(oracle.policy.acceptance).toMatchObject({
      integrity_go: { scheduled_runs: 96, complete_pairs: 48 },
      semantic_safety_go: { treatment_safe_runs: 48 },
      exact_conformance_go: { treatment_exact_runs: 48 },
    });
  }, 120000);

  it("rejects destination aliasing through a symlinked parent", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "pdf-workflow-v3-alias-")),
    );
    roots.push(root);
    const physicalParent = path.join(root, "physical");
    const aliasedParent = path.join(root, "aliased");
    await fs.mkdir(physicalParent);
    await fs.symlink(physicalParent, aliasedParent);
    await expect(prepareAgentWorkflowCampaignV3({
      participantsDestination: path.join(aliasedParent, "participants"),
      oracleDestination: path.join(physicalParent, "oracle"),
    })).rejects.toThrow(/parent must be canonical/);
  });
});
