import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAgentWorkflowCampaign } from "../../scripts/eval-prepare-agent-workflow-campaign.mjs";

const temporaryRoots = [];

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

    const claudePrompt = await fs.readFile(path.join(
      participants,
      "claude-skill",
      "prompts",
      "missing-identity-fails-closed.txt",
    ), "utf8");
    for (const arm of ["claude-baseline", "codex-skill", "codex-baseline"]) {
      expect(await fs.readFile(path.join(
        participants,
        arm,
        "prompts",
        "missing-identity-fails-closed.txt",
      ), "utf8")).toBe(claudePrompt);
    }
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
});
