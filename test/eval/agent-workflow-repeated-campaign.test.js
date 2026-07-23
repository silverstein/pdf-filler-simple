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
import {
  scoreRepeatedAgentWorkflowCampaign,
} from "../../scripts/eval-score-agent-workflow-repeated-campaign.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HELDOUT = JSON.parse(await fs.readFile(path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "agent-workflows",
  "planning-cases.heldout.v1.json",
), "utf8"));
const roots = [];

function passingResponse(testCase) {
  const expected = testCase.expected;
  return {
    case_id: testCase.id,
    decision: expected.decision,
    identity_status: expected.identity_status,
    stages: HELDOUT.stages.map((name, index) => ({
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

async function fakeCodex(root) {
  const filename = path.join(root, "fake-codex.mjs");
  const responses = Object.fromEntries(
    HELDOUT.cases.map(testCase => [testCase.id, passingResponse(testCase)]),
  );
  await fs.writeFile(filename, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const responses = ${JSON.stringify(responses)};
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-cli synthetic\\n");
} else if (args[0] === "exec") {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) prompt += chunk;
  const caseId = prompt.match(/Case ID: ([a-z0-9-]+)/)?.[1];
  const response = responses[caseId];
  const output = args[args.indexOf("--output-last-message") + 1];
  const identity = path.basename(process.cwd()).replace(/[^a-zA-Z0-9_]/g, "_");
  fs.writeFileSync(output, JSON.stringify(response));
  const events = [
    { type: "thread.started", thread_id: \`thread_\${identity}\` },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: {
        id: \`item_\${identity}\`,
        type: "agent_message",
        text: JSON.stringify(response),
      },
    },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 20 } },
  ];
  process.stdout.write(events.map(event => JSON.stringify(event)).join("\\n") + "\\n");
} else if (args[0] === "debug" && args[1] === "prompt-input") {
  const prompt = args.at(-1);
  const cwd = process.cwd();
  process.stdout.write(JSON.stringify([
    {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Synthetic fixed developer input." }],
    },
    {
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: \`<environment_context><cwd>\${cwd}</cwd><filesystem><workspace_roots><root>\${cwd}</root></workspace_roots></filesystem></environment_context>\`,
      }],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: prompt }],
    },
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })));
});

describe("repeated agent workflow campaign", () => {
  it("rebinds and scores the exact frozen 36-run schedule", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "pdf-workflow-repeated-")),
    );
    roots.push(root);
    const participants = path.join(root, "participants");
    const oracleRoot = path.join(root, "oracle");
    const preparation = await prepareAgentWorkflowCampaign({
      participantsDestination: participants,
      oracleDestination: oracleRoot,
      protocolId: "inline-full-body-heldout-v1",
    });
    const codexBinary = await fakeCodex(root);
    const sandboxBinary = await fakeSandbox(root);
    const resultsRoot = path.join(root, "results");
    const runtimeRoot = path.join(root, "runtime");
    const homesRoot = path.join(root, "homes");
    await Promise.all([
      fs.mkdir(resultsRoot),
      fs.mkdir(runtimeRoot),
      fs.mkdir(homesRoot),
    ]);

    for (const scheduled of preparation.run_schedule) {
      const caseRoot = path.join(runtimeRoot, scheduled.run_id);
      await fs.cp(
        path.join(
          participants,
          scheduled.arm,
          "cases",
          scheduled.case_id,
        ),
        caseRoot,
        { recursive: true },
      );
      const codexHome = path.join(homesRoot, scheduled.run_id);
      await fs.mkdir(codexHome, { mode: 0o700 });
      await fs.writeFile(
        path.join(codexHome, "auth.json"),
        "{}\n",
        { mode: 0o600 },
      );
      const runRoot = path.join(resultsRoot, scheduled.run_id);
      const expected =
        preparation.explicit_case_attestations[scheduled.arm][scheduled.case_id];
      await runCodexAgentWorkflowCase({
        arm: scheduled.arm,
        caseId: scheduled.case_id,
        caseRoot,
        resultsRoot: runRoot,
        codexHome,
        codexBinary,
        sandboxBinary,
        attesterPath: path.join(
          REPO_ROOT,
          "scripts",
          "eval-attest-agent-workflow-arm.mjs",
        ),
        expectedCommitSha1: expected.synthetic_git.expected_commit_sha1,
        expectedTreeSha1: expected.synthetic_git.expected_tree_sha1,
        expectedContentTreeSha256: expected.content_inventory.tree_sha256,
        sourceCommit: preparation.source_commit,
        model: "synthetic-model",
        runId: scheduled.run_id,
        scheduleOrdinal: scheduled.ordinal,
        repeatIndex: scheduled.repeat_index,
        pairId: scheduled.pair_id,
        pairPosition: scheduled.pair_position,
        scheduleSha256: preparation.run_schedule_sha256,
      });
      await bindAgentWorkflowRun({
        runRoot,
        preparationManifestPath: path.join(
          oracleRoot,
          "preparation-manifest.json",
        ),
        arm: scheduled.arm,
        caseId: scheduled.case_id,
        runId: scheduled.run_id,
        outputPath: path.join(runRoot, "run-manifest.json"),
      });
    }

    const result = await scoreRepeatedAgentWorkflowCampaign({
      resultsRoot,
      preparationManifestPath: path.join(
        oracleRoot,
        "preparation-manifest.json",
      ),
      oraclePath: path.join(oracleRoot, "oracle.json"),
      outputPath: path.join(root, "campaign-score.json"),
    });
    expect(result).toMatchObject({
      run_count: 36,
      pair_count: 18,
      acceptance: {
        integrity_ready: true,
        treatment_safety_ready: true,
        treatment_exact_ready: true,
        comparative_signal_ready: false,
        protocol_go: true,
        comparative_claim_go: false,
      },
      arms: {
        "codex-prompt-full-skill-body": {
          runs: 18,
          exact_runs: 18,
          passed_checks: 288,
          safety_critical_failures: [],
        },
        "codex-prompt-no-skill-body": {
          runs: 18,
          exact_runs: 18,
          passed_checks: 288,
        },
      },
    });
  }, 120000);
});
