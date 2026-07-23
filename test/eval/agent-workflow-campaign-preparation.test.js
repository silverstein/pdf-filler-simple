import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAgentWorkflowCampaign } from "../../scripts/eval-prepare-agent-workflow-campaign.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REVIEWED_RUBRIC_SOURCE_SHA256 =
  "b0dc68aa961c8f0f2eb3ef197b96762323ffdcc4afc52bdbcd54b2373fcff642";
const REVIEWED_RUBRIC_EMBEDDED_SHA256 =
  "c194c1817d07fb9813128f3ef4b31e7229b3b6d5e33b6a0e8c424feda070dd76";
const temporaryRoots = [];

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
      "prompts",
      "missing-identity-fails-closed.txt",
    ), "utf8");
    expect(explicitPrompt).toContain("$pdf-tools-workflow");
    expect(explicitPrompt).toContain("may load only the explicitly named");
    expect(await fs.readFile(path.join(
      participants,
      "codex-explicit-baseline",
      "prompts",
      "missing-identity-fails-closed.txt",
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
      ".agents",
      "skills",
      "pdf-tools-workflow",
      "SKILL.md",
    ))).toMatchObject({ mode: expect.any(Number) });
    await expect(fs.stat(path.join(
      participants,
      "codex-explicit-baseline",
      ".agents",
    ))).rejects.toMatchObject({ code: "ENOENT" });
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
