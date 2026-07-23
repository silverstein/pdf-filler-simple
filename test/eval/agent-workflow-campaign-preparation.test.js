import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { attestAgentWorkflowArm } from "../../scripts/eval-attest-agent-workflow-arm.mjs";
import {
  CONDITION_END,
  FULL_BODY_CONTROL_ARM,
  FULL_BODY_END,
  FULL_BODY_START,
  FULL_BODY_TREATMENT_ARM,
  prepareAgentWorkflowCampaign,
} from "../../scripts/eval-prepare-agent-workflow-campaign.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REVIEWED_RUBRIC_SOURCE_SHA256 =
  "b0dc68aa961c8f0f2eb3ef197b96762323ffdcc4afc52bdbcd54b2373fcff642";
const REVIEWED_RUBRIC_EMBEDDED_SHA256 =
  "c194c1817d07fb9813128f3ef4b31e7229b3b6d5e33b6a0e8c424feda070dd76";
const execFileAsync = promisify(execFile);
const temporaryRoots = [];
const SYNTHETIC_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "PDF Workflow Eval",
  GIT_AUTHOR_EMAIL: "eval@invalid.local",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "PDF Workflow Eval",
  GIT_COMMITTER_EMAIL: "eval@invalid.local",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  LC_ALL: "C",
  TZ: "UTC",
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })));
});

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

describe("agent workflow campaign preparation", () => {
  it("separates prompt-only participant roots from the trusted oracle", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-workflow-campaign-"));
    temporaryRoots.push(parent);
    const participants = path.join(parent, "participants");
    const trusted = path.join(parent, "oracle");
    const manifest = await prepareAgentWorkflowCampaign({
      participantsDestination: participants,
      oracleDestination: trusted,
    });

    expect(manifest.arm_names).toEqual([
      "claude-skill",
      "claude-baseline",
      "codex-skill",
      "codex-baseline",
      "codex-explicit-skill",
      "codex-explicit-baseline",
    ]);
    expect(manifest.source_commit).toMatch(/^[a-f0-9]{40,64}$/);
    expect(await allText(participants)).not.toMatch(/"expected"\s*:/);
    expect(await allText(path.join(participants, "claude-baseline"))).not.toMatch(
      /# PDF Tools workflow|Global invariants/,
    );
    expect(await allText(path.join(participants, "codex-baseline"))).not.toMatch(
      /# PDF Tools workflow|Global invariants/,
    );

    const oracle = JSON.parse(await fs.readFile(path.join(trusted, "oracle.json"), "utf8"));
    expect(oracle.cases).toHaveLength(5);
    expect(oracle.cases.every(testCase => testCase.expected)).toBe(true);
    const rubricBytes = await fs.readFile(path.join(
      REPO_ROOT,
      "test",
      "fixtures",
      "eval",
      "agent-workflows",
      "planning-rubric.v1.txt",
    ));
    const embeddedRubric = rubricBytes.toString("utf8").trim();
    expect(oracle.rubric_source_sha256).toBe(sha256(rubricBytes));
    expect(oracle.rubric_embedded_sha256).toBe(sha256(embeddedRubric));
    expect(oracle.rubric_source_sha256).toBe(REVIEWED_RUBRIC_SOURCE_SHA256);
    expect(oracle.rubric_embedded_sha256).toBe(REVIEWED_RUBRIC_EMBEDDED_SHA256);

    const claudePrompt = await fs.readFile(path.join(
      participants,
      "claude-skill",
      "prompts",
      "missing-identity-fails-closed.txt",
    ), "utf8");
    expect(claudePrompt).toContain("Case ID: missing-identity-fails-closed");
    expect(claudePrompt).toContain("Use this shared response classification contract:");
    const embeddedStart = claudePrompt.indexOf(
      "Use this shared response classification contract:",
    );
    const embeddedEnd = claudePrompt.indexOf("\n\nCase:", embeddedStart);
    expect(claudePrompt.slice(embeddedStart, embeddedEnd)).toBe(embeddedRubric);
    const oracleOnlyTokens = new Set(oracle.cases.flatMap(testCase => [
      testCase.id,
      ...testCase.expected.required_flags,
      ...testCase.expected.required_missing_inputs,
      ...testCase.expected.required_planned_tools,
      ...testCase.expected.forbidden_planned_tools,
    ]));
    for (const token of oracleOnlyTokens) {
      expect(embeddedRubric, token).not.toContain(token);
    }
    for (const arm of ["claude-baseline", "codex-skill", "codex-baseline"]) {
      expect(await fs.readFile(path.join(
        participants,
        arm,
        "prompts",
        "missing-identity-fails-closed.txt",
      ), "utf8")).toBe(claudePrompt);
    }
    const explicitPrompt = await fs.readFile(path.join(
      participants,
      "codex-explicit-skill",
      "cases",
      "missing-identity-fails-closed",
      "prompt.txt",
    ), "utf8");
    expect(explicitPrompt).toContain("$pdf-tools-workflow");
    expect(explicitPrompt).toContain("may natively load only the exact named");
    expect(explicitPrompt).toContain("No model-callable tool use is permitted");
    expect(await fs.readFile(path.join(
      participants,
      "codex-explicit-baseline",
      "cases",
      "missing-identity-fails-closed",
      "prompt.txt",
    ), "utf8")).toBe(explicitPrompt);
    expect(claudePrompt).not.toContain("$pdf-tools-workflow");
    expect(await fs.stat(path.join(
      participants,
      "claude-skill",
      "plugin",
      "pdf-tools-workflow",
      "skills",
      "pdf-tools-workflow",
      "SKILL.md",
    ))).toMatchObject({ mode: expect.any(Number) });
    expect(await fs.stat(path.join(
      participants,
      "codex-skill",
      ".agents",
      "skills",
      "pdf-tools-workflow",
      "SKILL.md",
    ))).toMatchObject({ mode: expect.any(Number) });
    expect(await fs.stat(path.join(
      participants,
      "codex-explicit-skill",
      "cases",
      "missing-identity-fails-closed",
      ".agents",
      "skills",
      "pdf-tools-workflow",
      "SKILL.md",
    ))).toMatchObject({ mode: expect.any(Number) });
    await expect(fs.stat(path.join(
      participants,
      "codex-explicit-baseline",
      "cases",
      "missing-identity-fails-closed",
      ".agents",
    ))).rejects.toMatchObject({ code: "ENOENT" });

    const explicitSkillRoot = path.join(
      participants,
      "codex-explicit-skill",
      "cases",
      "missing-identity-fails-closed",
    );
    const expectedAttestation = manifest.explicit_case_attestations[
      "codex-explicit-skill"
    ]["missing-identity-fails-closed"];
    await execFileAsync("git", [
      "init",
      "-q",
      "--object-format=sha1",
      "--template=",
    ], { cwd: explicitSkillRoot, env: SYNTHETIC_GIT_ENV });
    await execFileAsync("git", [
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.eol=lf",
      "add",
      "-A",
    ], { cwd: explicitSkillRoot, env: SYNTHETIC_GIT_ENV });
    await execFileAsync("git", [
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.eol=lf",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "Synthetic participant arm",
    ], {
      cwd: explicitSkillRoot,
      env: SYNTHETIC_GIT_ENV,
    });
    expect(await attestAgentWorkflowArm({
      armRoot: explicitSkillRoot,
      expectedCommitSha1: expectedAttestation.synthetic_git.expected_commit_sha1,
      expectedTreeSha1: expectedAttestation.synthetic_git.expected_tree_sha1,
      expectedContentTreeSha256: expectedAttestation.content_inventory.tree_sha256,
    })).toMatchObject({
      pass: true,
      commit_count: 1,
      parent_count: 0,
      clean: true,
    });

    await fs.appendFile(path.join(
      explicitSkillRoot,
      "prompt.txt",
    ), "\nchanged after attestation\n");
    expect((await attestAgentWorkflowArm({
      armRoot: explicitSkillRoot,
      expectedCommitSha1: expectedAttestation.synthetic_git.expected_commit_sha1,
      expectedTreeSha1: expectedAttestation.synthetic_git.expected_tree_sha1,
      expectedContentTreeSha256: expectedAttestation.content_inventory.tree_sha256,
    })).pass).toBe(false);
  });

  it("refuses relative, repository-contained, and nested destinations", async () => {
    await expect(prepareAgentWorkflowCampaign({
      participantsDestination: "relative",
      oracleDestination: "/tmp/oracle",
    })).rejects.toThrow(/participantsDestination must be absolute/);
    await expect(prepareAgentWorkflowCampaign({
      participantsDestination: "/tmp/participants",
      oracleDestination: "relative",
    })).rejects.toThrow(/oracleDestination must be absolute/);
    await expect(prepareAgentWorkflowCampaign({
      participantsDestination: path.join(process.cwd(), "participant-output"),
      oracleDestination: "/tmp/oracle",
    })).rejects.toThrow(/outside the source repository/);
    await expect(prepareAgentWorkflowCampaign({
      participantsDestination: "/tmp/campaign",
      oracleDestination: "/tmp/campaign/oracle",
    })).rejects.toThrow(/must not contain each other/);
  });

  it("freezes an inline-full-body held-out campaign with a balanced schedule", async () => {
    const parent = await fs.mkdtemp(path.join(
      os.tmpdir(),
      "pdf-tools-workflow-heldout-campaign-",
    ));
    temporaryRoots.push(parent);
    const participants = path.join(parent, "participants");
    const trusted = path.join(parent, "oracle");
    const manifest = await prepareAgentWorkflowCampaign({
      participantsDestination: participants,
      oracleDestination: trusted,
      protocolId: "inline-full-body-heldout-v1",
    });

    expect(manifest).toMatchObject({
      protocol_id: "inline-full-body-heldout-v1",
      arm_names: [FULL_BODY_TREATMENT_ARM, FULL_BODY_CONTROL_ARM],
      repetitions: 3,
      intervention: {
        id: "full_skill_markdown_in_user_prompt_v1",
        treatment_arm: FULL_BODY_TREATMENT_ARM,
        control_arm: FULL_BODY_CONTROL_ARM,
      },
    });
    expect(manifest.run_schedule).toHaveLength(36);
    expect(new Set(manifest.run_schedule.map(run => run.run_id)).size).toBe(36);
    expect(manifest.run_schedule.map(run => run.ordinal)).toEqual(
      Array.from({ length: 36 }, (_, index) => index + 1),
    );
    expect(manifest.run_schedule.filter(
      run => run.arm === FULL_BODY_TREATMENT_ARM,
    )).toHaveLength(18);
    expect(manifest.run_schedule.filter(
      run => run.arm === FULL_BODY_CONTROL_ARM,
    )).toHaveLength(18);
    const pairs = [...new Set(manifest.run_schedule.map(run => run.pair_id))];
    expect(pairs).toHaveLength(18);
    expect(pairs.filter(pairId => manifest.run_schedule.find(
      run => run.pair_id === pairId && run.pair_position === 1,
    ).arm === FULL_BODY_TREATMENT_ARM)).toHaveLength(9);
    expect([1, 2, 3].map(repeatIndex => manifest.run_schedule
      .filter(run => run.repeat_index === repeatIndex && run.pair_position === 1)
      .map(run => run.case_id))).toEqual([
      [
        "missing-output-path-blocks-plan",
        "existing-output-needs-specific-approval",
        "preview-click-does-not-authorize-signature",
        "safe-fill-ignores-embedded-fetch",
        "partial-diff-rejects-embedded-fetch",
        "bounded-summary-needs-no-diff-flags",
      ],
      [
        "preview-click-does-not-authorize-signature",
        "safe-fill-ignores-embedded-fetch",
        "partial-diff-rejects-embedded-fetch",
        "bounded-summary-needs-no-diff-flags",
        "missing-output-path-blocks-plan",
        "existing-output-needs-specific-approval",
      ],
      [
        "partial-diff-rejects-embedded-fetch",
        "bounded-summary-needs-no-diff-flags",
        "missing-output-path-blocks-plan",
        "existing-output-needs-specific-approval",
        "preview-click-does-not-authorize-signature",
        "safe-fill-ignores-embedded-fetch",
      ],
    ]);

    const skillBody = await fs.readFile(path.join(
      REPO_ROOT,
      "plugins",
      "pdf-tools-workflow",
      "skills",
      "pdf-tools-workflow",
      "SKILL.md",
    ), "utf8");
    const caseId = "missing-output-path-blocks-plan";
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
    expect(treatmentPrompt).toContain(`${FULL_BODY_START}\n${skillBody}`);
    expect(treatmentPrompt).toContain(`\n${FULL_BODY_END}\n${CONDITION_END}\n\n`);
    expect(controlPrompt).toContain(`${FULL_BODY_START}\n\n${FULL_BODY_END}`);
    expect(controlPrompt).not.toContain("# PDF Tools workflow");
    expect(treatmentPrompt.replace(
      `${FULL_BODY_START}\n${skillBody}\n${FULL_BODY_END}`,
      `${FULL_BODY_START}\n\n${FULL_BODY_END}`,
    )).toBe(controlPrompt);
    const treatmentShared = treatmentPrompt.split(`${CONDITION_END}\n\n`)[1];
    const controlShared = controlPrompt.split(`${CONDITION_END}\n\n`)[1];
    expect(treatmentShared).toBe(controlShared);
    expect(sha256(treatmentShared)).toBe(
      manifest.paired_case_contracts[caseId].shared_prompt_sha256,
    );
    expect(await allText(participants)).not.toContain('"expected":');
    expect(await allText(participants)).not.toContain(
      ".agents/skills/pdf-tools-workflow",
    );

    const oracle = JSON.parse(await fs.readFile(
      path.join(trusted, "oracle.json"),
      "utf8",
    ));
    expect(oracle.protocol_id).toBe("inline-full-body-heldout-v1");
    expect(oracle.cases).toHaveLength(6);
  });
});
