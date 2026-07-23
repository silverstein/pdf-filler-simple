import {
  createHash,
  generateKeyPairSync,
} from "node:crypto";
import * as actualCrypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  fileURLToPath,
  pathToFileURL,
} from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindAgentWorkflowRun,
} from "../../scripts/eval-bind-agent-workflow-run.mjs";
import {
  prepareAgentWorkflowCampaignV3,
} from "../../scripts/eval-prepare-agent-workflow-campaign-v3.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE_ROOT = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "agent-workflows",
);
const CONFORMANCE = JSON.parse(await fs.readFile(path.join(
  FIXTURE_ROOT,
  "planning-conformance-oracle.heldout.v3.json",
), "utf8"));
const STAGES = [
  "inspect",
  "compare",
  "plan",
  "authorize",
  "transform",
  "validate",
  "return",
];
const roots = [];

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactResponse(testCase) {
  const expected = testCase.expected;
  return {
    case_id: testCase.id,
    decision: expected.decision,
    identity_status: expected.identity_status,
    stages: STAGES.map((name, index) => ({
      name,
      status: expected.stage_statuses[index],
    })),
    effects: expected.effects,
    execution_performed: CONFORMANCE.execution_performed,
    tool_dispositions: expected.tool_dispositions,
    safety_flags: expected.safety_flags,
    missing_inputs: expected.missing_inputs,
    coverage: expected.coverage,
    assertions: CONFORMANCE.assertions,
    output_target_behavior: expected.output_target_behavior,
  };
}

async function fakeCodex(root) {
  const filename = path.join(root, "fake-codex-v3.mjs");
  const responses = Object.fromEntries(
    CONFORMANCE.cases.map(testCase => [testCase.id, exactResponse(testCase)]),
  );
  await fs.writeFile(filename, `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";

const responses = ${JSON.stringify(responses)};
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-cli synthetic-v3\\n");
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
    { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 200 } },
  ];
  process.stdout.write(events.map(event => JSON.stringify(event)).join("\\n") + "\\n");
} else if (args[0] === "debug" && args[1] === "prompt-input") {
  const prompt = args.at(-1);
  const cwd = process.cwd();
  process.stdout.write(JSON.stringify([
    {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Synthetic fixed v3 developer input." }],
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
  const filename = path.join(root, "fake-sandbox-v3.mjs");
  await fs.writeFile(filename, `#!${process.execPath}
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

async function testAnchorAdapter(root, productionAnchorScript, pinnedKeySha256) {
  const filename = path.join(root, "test-anchor-adapter.mjs");
  await fs.writeFile(filename, `#!/usr/bin/env node
import {
  appendAnchoredReceipt,
  exportAnchoredReceipts,
} from ${JSON.stringify(pathToFileURL(productionAnchorScript).href)};

const [command, ...rest] = process.argv.slice(2);
const values = {};
for (let index = 0; index < rest.length; index += 2) {
  values[rest[index]] = rest[index + 1];
}
const options = {
  privateKeyPath: values["--private-key"],
  authorityId: values["--authority-id"],
  namespaceId: values["--namespace-id"],
};
let result;
if (command === "append") {
  let recordText = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) recordText += chunk;
  result = await appendAnchoredReceipt({ ...options, recordText });
} else if (command === "export") {
  result = await exportAnchoredReceipts({
    ...options,
    campaignId: values["--campaign-id"],
  });
} else {
  throw new Error("unsupported test anchor command");
}
result.public_key_sha256 = ${JSON.stringify(pinnedKeySha256)};
process.stdout.write(\`\${JSON.stringify(result)}\\n\`);
`);
  await fs.chmod(filename, 0o700);
  return filename;
}

afterEach(async () => {
  vi.doUnmock("node:crypto");
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })));
});

describe("agent workflow v3 campaign", () => {
  it("rebinds and independently scores the exact 96-run frozen schedule", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "pdf-workflow-v3-campaign-")),
    );
    roots.push(root);
    const participants = path.join(root, "participants");
    const oracleRoot = path.join(root, "oracle");
    const preparation = await prepareAgentWorkflowCampaignV3({
      participantsDestination: participants,
      oracleDestination: oracleRoot,
    });
    const codexBinary = await fakeCodex(root);
    const sandboxBinary = await fakeSandbox(root);
    const resultsRoot = path.join(root, "results");
    const runtimeRoot = path.join(root, "runtime");
    const homesRoot = path.join(root, "homes");
    const promptCaptureHomesRoot = path.join(root, "capture-homes");
    const authSourcePath = path.join(root, "auth.json");
    await fs.writeFile(authSourcePath, "{}\n", { mode: 0o600 });
    const receiptLedgerPath = path.join(root, "receipts.jsonl");
    const anchorAckLedgerPath = path.join(root, "anchor-acks.jsonl");
    const anchorExportPath = path.join(root, "anchor-export.json");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyPath = path.join(root, "test-anchor-private.pem");
    const testOnlyAnchorPublicKeyBytes = publicKey.export({
      type: "spki",
      format: "pem",
    });
    const pinnedAnchorPublicKeyBytes = await fs.readFile(path.join(
      FIXTURE_ROOT,
      "silvercloud-receipt-anchor-public-key.pem",
    ));
    vi.doMock("node:crypto", () => ({
      ...actualCrypto,
      createPublicKey(value) {
        if (
          Buffer.isBuffer(value)
          && value.equals(pinnedAnchorPublicKeyBytes)
        ) {
          return actualCrypto.createPublicKey(testOnlyAnchorPublicKeyBytes);
        }
        return actualCrypto.createPublicKey(value);
      },
    }));
    const [
      { runAgentWorkflowCampaignV3 },
      { scoreAgentWorkflowCampaignV3 },
    ] = await Promise.all([
      import("../../scripts/eval-run-agent-workflow-campaign-v3.mjs"),
      import("../../scripts/eval-score-agent-workflow-campaign-v3.mjs"),
    ]);
    await fs.writeFile(
      privateKeyPath,
      privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );
    await fs.mkdir(
      path.join(root, "namespaces", "oda-pdf-tools-agent-workflow-v3"),
      { recursive: true, mode: 0o700 },
    );
    const productionAnchorScript = path.join(
      REPO_ROOT,
      "scripts",
      "eval-agent-workflow-receipt-anchor.mjs",
    );
    const anchorScript = await testAnchorAdapter(
      root,
      productionAnchorScript,
      createHash("sha256").update(pinnedAnchorPublicKeyBytes).digest("hex"),
    );
    const preparationBytes = await fs.readFile(path.join(
      oracleRoot,
      "preparation-manifest.json",
    ));
    const campaignId = `pdf-tools-v3-${createHash("sha256")
      .update(preparationBytes)
      .digest("hex")
      .slice(0, 32)}`;
    const anchorCommandConfigPath = path.join(root, "anchor-config.json");
    await fs.writeFile(
      anchorCommandConfigPath,
      `${JSON.stringify({
        schema_version:
          "pdf-tools.agent-workflow-receipt-anchor-command.v1",
        authority_id: "silvercloud-tailnet-receipt-ledger-v1",
        namespace_id: "oda-pdf-tools-agent-workflow-v3",
        endpoint_id: "silvercloud.tail6fbca0.ts.net",
        append: {
          program: process.execPath,
          argv: [
            anchorScript,
            "append",
            "--private-key",
            privateKeyPath,
            "--authority-id",
            "silvercloud-tailnet-receipt-ledger-v1",
            "--namespace-id",
            "oda-pdf-tools-agent-workflow-v3",
          ],
        },
        export: {
          program: process.execPath,
          argv: [
            anchorScript,
            "export",
            "--private-key",
            privateKeyPath,
            "--authority-id",
            "silvercloud-tailnet-receipt-ledger-v1",
            "--namespace-id",
            "oda-pdf-tools-agent-workflow-v3",
            "--campaign-id",
            campaignId,
          ],
        },
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await runAgentWorkflowCampaignV3({
      participantsRoot: participants,
      preparationManifestPath: path.join(
        oracleRoot,
        "preparation-manifest.json",
      ),
      oraclePath: path.join(oracleRoot, "oracle.json"),
      resultsRoot,
      runtimeRoot,
      homesRoot,
      promptCaptureHomesRoot,
      authSourcePath,
      codexBinary,
      sandboxBinary,
      model: "synthetic-v3-model",
      receiptLedgerPath,
      anchorAckLedgerPath,
      anchorExportPath,
      anchorCommandConfigPath,
    });

    const scorePath = path.join(root, "campaign-score.json");
    const result = await scoreAgentWorkflowCampaignV3({
      resultsRoot,
      preparationManifestPath: path.join(
        oracleRoot,
        "preparation-manifest.json",
      ),
      oraclePath: path.join(oracleRoot, "oracle.json"),
      receiptLedgerPath,
      anchorAckLedgerPath,
      anchorExportPath,
      anchorCommandConfigPath,
      outputPath: scorePath,
    });
    expect(result).toMatchObject({
      run_count: 96,
      pair_count: 48,
      acceptance: {
        integrity_go: true,
        semantic_safety_go: true,
        semantic_utility_go: true,
        exact_conformance_go: true,
        bounded_prompt_effect_go: false,
        overall_go: false,
        hard_gate_classification_failures: 0,
        systematically_overblocked_ready_cases: 0,
        cases_with_positive_mean_paired_utility_delta: 0,
        cases_with_worse_treatment_unsafe_count: 0,
      },
      arms: {
        "codex-prompt-full-skill-body": {
          runs: 48,
          safe_runs: 48,
          useful_runs: 48,
          exact_runs: 48,
          unsafe_runs: 0,
          unscorable_runs: 0,
        },
        "codex-prompt-no-skill-body": {
          runs: 48,
          safe_runs: 48,
          useful_runs: 48,
          exact_runs: 48,
          unsafe_runs: 0,
          unscorable_runs: 0,
        },
      },
    });

    const firstRunRoot = path.join(
      resultsRoot,
      preparation.run_schedule[0].run_id,
    );
    const firstManifestPath = path.join(firstRunRoot, "run-manifest.json");
    const originalManifestBytes = await fs.readFile(firstManifestPath);
    const firstManifest = JSON.parse(originalManifestBytes);
    firstManifest.response.decision = "ready";
    await fs.writeFile(firstManifestPath, `${JSON.stringify(firstManifest, null, 2)}\n`);
    await expect(scoreAgentWorkflowCampaignV3({
      resultsRoot,
      preparationManifestPath: path.join(
        oracleRoot,
        "preparation-manifest.json",
      ),
      oraclePath: path.join(oracleRoot, "oracle.json"),
      receiptLedgerPath,
      anchorAckLedgerPath,
      anchorExportPath,
      anchorCommandConfigPath,
      outputPath: path.join(root, "mutated-campaign-score.json"),
    })).rejects.toThrow(/does not rebind/);
    await fs.writeFile(firstManifestPath, originalManifestBytes);

    const responsePath = path.join(firstRunRoot, "response.json");
    const eventsPath = path.join(firstRunRoot, "events.jsonl");
    const originalResponseBytes = await fs.readFile(responsePath);
    const originalEventsBytes = await fs.readFile(eventsPath);
    const laundered = JSON.parse(originalResponseBytes);
    laundered.decision = "ready";
    const events = originalEventsBytes.toString("utf8").trim()
      .split(/\r?\n/)
      .map(line => JSON.parse(line));
    events[2].item.text = JSON.stringify(laundered);
    await Promise.all([
      fs.writeFile(responsePath, JSON.stringify(laundered)),
      fs.writeFile(
        eventsPath,
        `${events.map(event => JSON.stringify(event)).join("\n")}\n`,
      ),
      fs.unlink(firstManifestPath),
    ]);
    const firstScheduled = preparation.run_schedule[0];
    await bindAgentWorkflowRun({
      runRoot: firstRunRoot,
      preparationManifestPath: path.join(
        oracleRoot,
        "preparation-manifest.json",
      ),
      arm: firstScheduled.arm,
      caseId: firstScheduled.case_id,
      runId: firstScheduled.run_id,
      outputPath: firstManifestPath,
    });
    await expect(scoreAgentWorkflowCampaignV3({
      resultsRoot,
      preparationManifestPath: path.join(
        oracleRoot,
        "preparation-manifest.json",
      ),
      oraclePath: path.join(oracleRoot, "oracle.json"),
      receiptLedgerPath,
      anchorAckLedgerPath,
      anchorExportPath,
      anchorCommandConfigPath,
      outputPath: path.join(root, "laundered-campaign-score.json"),
    })).rejects.toThrow(/sealed first process artifacts differ/);
    await Promise.all([
      fs.writeFile(responsePath, originalResponseBytes),
      fs.writeFile(eventsPath, originalEventsBytes),
      fs.writeFile(firstManifestPath, originalManifestBytes),
    ]);

    const externalResponsePath = path.join(root, "external-response.json");
    await fs.writeFile(externalResponsePath, originalResponseBytes, {
      mode: 0o600,
    });
    await fs.unlink(responsePath);
    await fs.symlink(externalResponsePath, responsePath);
    await expect(scoreAgentWorkflowCampaignV3({
      resultsRoot,
      preparationManifestPath: path.join(
        oracleRoot,
        "preparation-manifest.json",
      ),
      oraclePath: path.join(oracleRoot, "oracle.json"),
      receiptLedgerPath,
      anchorAckLedgerPath,
      anchorExportPath,
      anchorCommandConfigPath,
      outputPath: path.join(root, "symlinked-campaign-score.json"),
    })).rejects.toThrow(/private single-link regular file/);
    await fs.unlink(responsePath);
    await fs.writeFile(responsePath, originalResponseBytes, { mode: 0o600 });

    const mutatedOraclePath = path.join(root, "mutated-oracle.json");
    const mutatedPreparationPath = path.join(root, "mutated-preparation.json");
    const mutatedOracle = JSON.parse(await fs.readFile(
      path.join(oracleRoot, "oracle.json"),
      "utf8",
    ));
    mutatedOracle.claim_boundary = "Post-inference rewritten claim.";
    const mutatedOracleBytes = Buffer.from(
      `${JSON.stringify(mutatedOracle, null, 2)}\n`,
    );
    const mutatedPreparation = JSON.parse(await fs.readFile(
      path.join(oracleRoot, "preparation-manifest.json"),
      "utf8",
    ));
    mutatedPreparation.oracle_sha256 = createHash("sha256")
      .update(mutatedOracleBytes)
      .digest("hex");
    await Promise.all([
      fs.writeFile(mutatedOraclePath, mutatedOracleBytes, { mode: 0o600 }),
      fs.writeFile(
        mutatedPreparationPath,
        `${JSON.stringify(mutatedPreparation, null, 2)}\n`,
        { mode: 0o600 },
      ),
    ]);
    await expect(scoreAgentWorkflowCampaignV3({
      resultsRoot,
      preparationManifestPath: mutatedPreparationPath,
      oraclePath: mutatedOraclePath,
      receiptLedgerPath,
      anchorAckLedgerPath,
      anchorExportPath,
      anchorCommandConfigPath,
      outputPath: path.join(root, "rewritten-oracle-score.json"),
    })).rejects.toThrow(/deterministic source derivation/);

    const receiptLines = (await fs.readFile(receiptLedgerPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map(line => JSON.parse(line));
    const previousReceipt = receiptLines.at(-1);
    const secondAttemptUnsigned = {
      schema_version: "pdf-tools.agent-workflow-receipt.v1",
      campaign_id: previousReceipt.campaign_id,
      anchor_authority_id: previousReceipt.anchor_authority_id,
      anchor_namespace_id: previousReceipt.anchor_namespace_id,
      receipt_ordinal: receiptLines.length + 1,
      previous_record_sha256: previousReceipt.record_sha256,
      type: "attempt_started",
      recorded_at: new Date().toISOString(),
      run_id: firstScheduled.run_id,
      schedule_ordinal: firstScheduled.ordinal,
      attempt_index: 2,
    };
    const secondAttempt = {
      ...secondAttemptUnsigned,
      record_sha256: createHash("sha256")
        .update(canonicalJson(secondAttemptUnsigned))
        .digest("hex"),
    };
    const retriedLedgerPath = path.join(root, "retried-receipts.jsonl");
    const retriedAnchorExportPath = path.join(
      root,
      "retried-anchor-export.json",
    );
    const retriedBytes = Buffer.from(
      `${receiptLines.map(record => JSON.stringify(record)).join("\n")}\n${JSON.stringify(secondAttempt)}\n`,
    );
    await Promise.all([
      fs.writeFile(retriedLedgerPath, retriedBytes, { mode: 0o600 }),
      fs.copyFile(anchorExportPath, retriedAnchorExportPath),
    ]);
    await expect(scoreAgentWorkflowCampaignV3({
      resultsRoot,
      preparationManifestPath: path.join(
        oracleRoot,
        "preparation-manifest.json",
      ),
      oraclePath: path.join(oracleRoot, "oracle.json"),
      receiptLedgerPath: retriedLedgerPath,
      anchorAckLedgerPath,
      anchorExportPath: retriedAnchorExportPath,
      anchorCommandConfigPath,
      outputPath: path.join(root, "retried-campaign-score.json"),
    })).rejects.toThrow(/exact zero-retry schedule/);
  }, 600000);
});
