import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindAgentWorkflowRun,
} from "../../scripts/eval-bind-agent-workflow-run.mjs";
import {
  prepareAgentWorkflowCampaign,
} from "../../scripts/eval-prepare-agent-workflow-campaign.mjs";
import {
  runCodexAgentWorkflowCase,
} from "../../scripts/eval-run-codex-agent-workflow-case.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })));
});

async function fakeCodex(root) {
  const filename = path.join(root, "fake-codex.mjs");
  await fs.writeFile(filename, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-cli synthetic\\n");
} else if (args[0] === "exec") {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) prompt += chunk;
  const caseId = prompt.match(/Case ID: ([a-z0-9-]+)/)?.[1];
  const response = { case_id: caseId };
  const output = args[args.indexOf("--output-last-message") + 1];
  fs.writeFileSync(output, JSON.stringify(response));
  const events = [
    { type: "thread.started", thread_id: "thread_1" },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: JSON.stringify(response) },
    },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  process.stdout.write(events.map(event => JSON.stringify(event)).join("\\n") + "\\n");
} else if (args[0] === "debug" && args[1] === "prompt-input") {
  const prompt = args.at(-1);
  const skill = path.join(
    process.cwd(),
    ".agents",
    "skills",
    "pdf-tools-workflow",
    "SKILL.md",
  );
  const inventory = fs.existsSync(skill) ? \`\\nfile: \${skill}\` : "";
  process.stdout.write(JSON.stringify([
    { type: "message", role: "developer", content: [{ type: "input_text", text: inventory }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
  ]));
} else {
  process.exitCode = 2;
}
`);
  await fs.chmod(filename, 0o700);
  return filename;
}

async function fakeSandbox(root) {
  const filename = path.join(root, "fake-sandbox.mjs");
  await fs.writeFile(filename, `#!/usr/bin/env node
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
if (args[0] !== "-p" || args.length < 4) process.exit(2);
const child = spawn(args[2], args.slice(3), { stdio: "inherit" });
child.once("error", () => process.exit(2));
child.once("close", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 2);
});
`);
  await fs.chmod(filename, 0o700);
  return filename;
}

async function preparedRun() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pdf-workflow-bound-run-")),
  );
  roots.push(root);
  const participants = path.join(root, "participants");
  const oracle = path.join(root, "oracle");
  const manifest = await prepareAgentWorkflowCampaign({
    participantsDestination: participants,
    oracleDestination: oracle,
  });
  const arm = "codex-explicit-skill";
  const caseId = "missing-identity-fails-closed";
  const caseRoot = path.join(root, "case");
  await fs.cp(
    path.join(participants, arm, "cases", caseId),
    caseRoot,
    { recursive: true },
  );
  const codexHome = path.join(root, "codex-home");
  await fs.mkdir(codexHome, { mode: 0o700 });
  await fs.writeFile(path.join(codexHome, "auth.json"), "{}\n", { mode: 0o600 });
  const resultsRoot = path.join(root, "results");
  const expected = manifest.explicit_case_attestations[arm][caseId];
  await runCodexAgentWorkflowCase({
    arm,
    caseId,
    caseRoot,
    resultsRoot,
    codexHome,
    codexBinary: await fakeCodex(root),
    sandboxBinary: await fakeSandbox(root),
    attesterPath: path.join(
      REPO_ROOT,
      "scripts",
      "eval-attest-agent-workflow-arm.mjs",
    ),
    expectedCommitSha1: expected.synthetic_git.expected_commit_sha1,
    expectedTreeSha1: expected.synthetic_git.expected_tree_sha1,
    expectedContentTreeSha256: expected.content_inventory.tree_sha256,
    sourceCommit: manifest.source_commit,
    model: "synthetic-model",
  });
  return {
    root,
    arm,
    caseId,
    resultsRoot,
    manifestPath: path.join(oracle, "preparation-manifest.json"),
  };
}

describe("agent workflow run binding", () => {
  it("binds the scored response to the validated event and every run artifact", async () => {
    const run = await preparedRun();
    const outputPath = path.join(run.resultsRoot, "run-manifest.json");
    const manifest = await bindAgentWorkflowRun({
      runRoot: run.resultsRoot,
      preparationManifestPath: run.manifestPath,
      arm: run.arm,
      caseId: run.caseId,
      outputPath,
    });
    expect(manifest).toMatchObject({
      claim_ready: true,
      arm: run.arm,
      case_id: run.caseId,
      response: { case_id: run.caseId },
      event_validation: { pass: true, model_callable_tool_items: 0 },
    });
    expect(Object.keys(manifest.artifacts)).toEqual(
      expect.arrayContaining([
        "events.jsonl",
        "response.json",
        "pre-run-attestation.json",
        "post-run-attestation.json",
        "prompt-input.json",
      ]),
    );
  });

  it("rejects a swapped response and refuses to reuse a result directory", async () => {
    const run = await preparedRun();
    await expect(runCodexAgentWorkflowCase({
      arm: run.arm,
      caseId: run.caseId,
      caseRoot: path.join(run.root, "case"),
      resultsRoot: run.resultsRoot,
      codexHome: path.join(run.root, "codex-home"),
      codexBinary: path.join(run.root, "fake-codex.mjs"),
      sandboxBinary: path.join(run.root, "fake-sandbox.mjs"),
      attesterPath: path.join(
        REPO_ROOT,
        "scripts",
        "eval-attest-agent-workflow-arm.mjs",
      ),
      expectedCommitSha1: "0".repeat(40),
      expectedTreeSha1: "0".repeat(40),
      expectedContentTreeSha256: "0".repeat(64),
      sourceCommit: "0".repeat(40),
      model: "synthetic-model",
    })).rejects.toThrow();

    await fs.writeFile(
      path.join(run.resultsRoot, "response.json"),
      JSON.stringify({ case_id: "safe-fill-plans-distinct-output" }),
    );
    await expect(bindAgentWorkflowRun({
      runRoot: run.resultsRoot,
      preparationManifestPath: run.manifestPath,
      arm: run.arm,
      caseId: run.caseId,
      outputPath: path.join(run.resultsRoot, "run-manifest.json"),
    })).rejects.toThrow(/response does not equal/);
  });
});
