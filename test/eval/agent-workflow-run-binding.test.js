import { execFileSync } from "node:child_process";
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
  artifactRecordFromHandle,
  CODEX_ENVIRONMENT_NAMES,
  codexEnvironment,
  PRIVATE_CREATION_UMASK,
  runCodexAgentWorkflowCase,
  withPrivateRunnerUmask,
} from "../../scripts/eval-run-codex-agent-workflow-case.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })));
});

describe("Codex workflow environment", () => {
  it("binds the platform-effective minimal environment", () => {
    const codexHome = path.join(os.tmpdir(), "sealed-codex-home");
    const environment = codexEnvironment(codexHome);

    expect(Object.keys(environment).sort()).toEqual(CODEX_ENVIRONMENT_NAMES);
    expect(environment.CODEX_HOME).toBe(codexHome);
    expect(environment.TMPDIR).toBe(path.join(codexHome, "tmp"));
    expect(environment).not.toHaveProperty("HOME");

    if (process.platform === "darwin") {
      expect(environment.__CF_USER_TEXT_ENCODING).toBe(
        `0x${process.getuid().toString(16).toUpperCase()}:0x0:0x0`,
      );
      const effectiveEnvironment = JSON.parse(execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "process.stdout.write(JSON.stringify(process.env))",
        ],
        {
          encoding: "utf8",
          env: environment,
        },
      ));
      expect(effectiveEnvironment).toEqual(environment);
    } else {
      expect(environment).not.toHaveProperty("__CF_USER_TEXT_ENCODING");
    }
  });
});

async function fakeCodex(root, writeStyle = "direct") {
  const filename = path.join(root, "fake-codex.mjs");
  const invocationPath = path.join(root, "fake-codex-invocations.txt");
  await fs.writeFile(filename, `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-cli synthetic\\n");
} else if (args[0] === "exec") {
  const invocationPath = ${JSON.stringify(invocationPath)};
  const prior = fs.existsSync(invocationPath)
    ? Number.parseInt(fs.readFileSync(invocationPath, "utf8"), 10)
    : 0;
  fs.writeFileSync(invocationPath, String(prior + 1));
  let prompt = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) prompt += chunk;
  const caseId = prompt.match(/Case ID: ([a-z0-9-]+)/)?.[1];
  const response = { case_id: caseId };
  const output = args[args.indexOf("--output-last-message") + 1];
  const identity = path.basename(process.cwd()).replace(/[^a-zA-Z0-9_]/g, "_");
  const body = JSON.stringify(response);
  const writeStyle = ${JSON.stringify(writeStyle)};
  if (writeStyle === "rename") {
    const temporary = output + ".replacement";
    fs.writeFileSync(temporary, body);
    fs.renameSync(temporary, output);
  } else if (writeStyle === "unsafe-mode") {
    fs.writeFileSync(output, body);
    fs.chmodSync(output, 0o644);
  } else if (writeStyle === "symlink") {
    const target = output + ".target";
    fs.writeFileSync(target, body);
    fs.unlinkSync(output);
    fs.symlinkSync(target, output);
  } else if (writeStyle === "hardlink") {
    const target = output + ".target";
    fs.writeFileSync(target, body);
    fs.unlinkSync(output);
    fs.linkSync(target, output);
  } else {
    fs.writeFileSync(output, body);
  }
  const events = [
    { type: "thread.started", thread_id: \`thread_\${identity}\` },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: { id: \`item_\${identity}\`, type: "agent_message", text: JSON.stringify(response) },
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
    { type: "message", role: "user", content: [{ type: "input_text", text: \`<environment_context><cwd>\${process.cwd()}</cwd><filesystem><workspace_roots><root>\${process.cwd()}</root></workspace_roots></filesystem></environment_context>\` }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
  ]));
} else {
  process.exitCode = 2;
}
`);
  await fs.chmod(filename, 0o700);
  return { filename, invocationPath };
}

async function fakeSandbox(root) {
  const filename = path.join(root, "fake-sandbox.mjs");
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

async function preparedRun({
  protocolId = "metadata-regression-v1",
  arm = "codex-explicit-skill",
  caseId = "missing-identity-fails-closed",
  responseWriteStyle = "direct",
  replaceResponseInPreInferenceHook = false,
  expectFailure = false,
} = {}) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pdf-workflow-bound-run-")),
  );
  roots.push(root);
  const participants = path.join(root, "participants");
  const oracle = path.join(root, "oracle");
  const manifest = await prepareAgentWorkflowCampaign({
    participantsDestination: participants,
    oracleDestination: oracle,
    protocolId,
  });
  const scheduled = manifest.run_schedule.find(entry =>
    entry.arm === arm && entry.case_id === caseId);
  const caseRoot = path.join(root, "case");
  await fs.cp(
    path.join(participants, arm, "cases", caseId),
    caseRoot,
    { recursive: true },
  );
  const codexHome = path.join(root, "codex-home");
  const promptCaptureHome = path.join(root, "prompt-capture-home");
  await fs.mkdir(codexHome, { mode: 0o700 });
  await fs.mkdir(promptCaptureHome, { mode: 0o700 });
  await fs.writeFile(path.join(codexHome, "auth.json"), "{}\n", { mode: 0o600 });
  await fs.writeFile(
    path.join(promptCaptureHome, "auth.json"),
    "{}\n",
    { mode: 0o600 },
  );
  const resultsRoot = path.join(root, "results");
  const expected = manifest.explicit_case_attestations[arm][caseId];
  const fake = await fakeCodex(root, responseWriteStyle);
  let runError = null;
  let preInferenceEvidence = null;
  try {
    await runCodexAgentWorkflowCase({
      arm,
      caseId,
      caseRoot,
      resultsRoot,
      codexHome,
      promptCaptureHome,
      codexBinary: fake.filename,
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
      onPreInferenceReady: async evidence => {
        preInferenceEvidence = structuredClone(evidence);
        if (replaceResponseInPreInferenceHook) {
          const replacement = path.join(resultsRoot, "response.replacement");
          await fs.writeFile(replacement, Buffer.alloc(0), { mode: 0o600 });
          await fs.rename(replacement, path.join(resultsRoot, "response.json"));
        }
      },
      runId: scheduled?.run_id,
      scheduleOrdinal: scheduled?.ordinal,
      repeatIndex: scheduled?.repeat_index,
      pairId: scheduled?.pair_id,
      pairPosition: scheduled?.pair_position,
      scheduleSha256: scheduled ? manifest.run_schedule_sha256 : undefined,
    });
  } catch (error) {
    if (!expectFailure) throw error;
    runError = error;
  }
  return {
    root,
    arm,
    caseId,
    resultsRoot,
    manifestPath: path.join(oracle, "preparation-manifest.json"),
    scheduled,
    runError,
    invocationPath: fake.invocationPath,
    preInferenceEvidence,
  };
}

describe("agent workflow run binding", () => {
  it("creates direct and rename-style responses privately and restores umask", async () => {
    const previous = process.umask(0o022);
    try {
      for (const responseWriteStyle of ["direct", "rename"]) {
        const run = await preparedRun({ responseWriteStyle });
        const stat = await fs.lstat(
          path.join(run.resultsRoot, "response.json"),
        );
        expect(stat.mode & 0o777).toBe(0o600);
        expect(stat.nlink).toBe(1);
        expect(stat.isFile()).toBe(true);
        expect(stat.isSymbolicLink()).toBe(false);
        expect(process.umask()).toBe(0o022);
      }
    } finally {
      process.umask(previous);
    }
  }, 30000);

  it("binds the zero-byte precreated response before inference", async () => {
    const run = await preparedRun();
    const launchPlan = JSON.parse(await fs.readFile(
      path.join(run.resultsRoot, "launch-plan.json"),
      "utf8",
    ));
    const expected = {
      bytes: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      mode: 0o600,
      nlink: 1,
      file_type: "regular",
      symbolic_link: false,
    };
    expect(launchPlan.pre_inference_artifacts["response.json"]).toMatchObject(
      expected,
    );
    expect(run.preInferenceEvidence.artifacts["response.json"]).toEqual(
      launchPlan.pre_inference_artifacts["response.json"],
    );
    expect(run.preInferenceEvidence.artifacts["response.json"]).toMatchObject({
      ...expected,
      device: expect.any(Number),
      inode: expect.any(Number),
      ctime_ms: expect.any(Number),
      mtime_ms: expect.any(Number),
    });
  }, 15000);

  it("rejects an empty private inode replacement by the pre-inference hook before Codex exec", async () => {
    const run = await preparedRun({
      replaceResponseInPreInferenceHook: true,
      expectFailure: true,
    });
    expect(run.runError).toBeTruthy();
    expect(run.runError.message).toMatch(
      /changed after pre-inference hook/,
    );
    await expect(fs.access(run.invocationPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 15000);

  it("rejects unsafe mode, symlink, and hardlink responses without retry or repair", async () => {
    for (const responseWriteStyle of ["unsafe-mode", "symlink", "hardlink"]) {
      const run = await preparedRun({
        responseWriteStyle,
        expectFailure: true,
      });
      expect(run.runError).toBeTruthy();
      expect(await fs.readFile(run.invocationPath, "utf8")).toBe("1");
      const responsePath = path.join(run.resultsRoot, "response.json");
      const stat = await fs.lstat(responsePath);
      if (responseWriteStyle === "unsafe-mode") {
        expect(stat.mode & 0o777).toBe(0o644);
      } else if (responseWriteStyle === "symlink") {
        expect(stat.isSymbolicLink()).toBe(true);
      } else {
        expect(stat.nlink).toBe(2);
      }
    }
  }, 30000);

  it("rejects replacement between the opened response handle and final path check", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "runner-replacement-drift-")),
    );
    roots.push(root);
    const responsePath = path.join(root, "response.json");
    await fs.writeFile(responsePath, "{}\n", { mode: 0o600 });
    const handle = await fs.open(
      responsePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      const replacement = path.join(root, "replacement.json");
      await fs.writeFile(replacement, "{}\n", { mode: 0o600 });
      await fs.rename(replacement, responsePath);
      await expect(artifactRecordFromHandle(handle, {
        filename: responsePath,
      })).rejects.toThrow(/path identity differs/);
    } finally {
      await handle.close();
    }
  });

  it("forbids concurrent runner umask scopes and restores the caller value", async () => {
    const previous = process.umask(0o022);
    let release;
    try {
      const first = withPrivateRunnerUmask(() => new Promise(resolve => {
        release = resolve;
      }));
      await Promise.resolve();
      expect(process.umask()).toBe(PRIVATE_CREATION_UMASK);
      await expect(
        withPrivateRunnerUmask(async () => {}),
      ).rejects.toThrow(/concurrent workflow runner invocation/);
      release();
      await first;
      expect(process.umask()).toBe(0o022);
    } finally {
      process.umask(previous);
    }
  });

  it("binds the scored response to the validated event and every run artifact", async () => {
    const run = await preparedRun();
    const controllerRunRoot = path.join(run.root, "controller-results");
    await fs.cp(run.resultsRoot, controllerRunRoot, { recursive: true });
    const outputPath = path.join(controllerRunRoot, "run-manifest.json");
    const manifest = await bindAgentWorkflowRun({
      runRoot: controllerRunRoot,
      preparationManifestPath: run.manifestPath,
      arm: run.arm,
      caseId: run.caseId,
      runId: run.scheduled?.run_id,
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
  }, 15000);

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
      runId: run.scheduled?.run_id,
      outputPath: path.join(run.resultsRoot, "run-manifest.json"),
    })).rejects.toThrow(/response does not equal/);
  }, 15000);

  it("rejects an ambient or duplicate project skill in prompt-input evidence", async () => {
    const run = await preparedRun();
    const promptInputPath = path.join(run.resultsRoot, "prompt-input.json");
    const promptInput = JSON.parse(await fs.readFile(promptInputPath, "utf8"));
    promptInput.unshift({
      type: "message",
      role: "developer",
      content: [{
        type: "input_text",
        text: "file: /unexpected/.agents/skills/pdf-tools-workflow/SKILL.md",
      }],
    });
    await fs.writeFile(promptInputPath, JSON.stringify(promptInput));
    await expect(bindAgentWorkflowRun({
      runRoot: run.resultsRoot,
      preparationManifestPath: run.manifestPath,
      arm: run.arm,
      caseId: run.caseId,
      runId: run.scheduled?.run_id,
      outputPath: path.join(run.resultsRoot, "run-manifest.json"),
    })).rejects.toThrow(/skill inventory does not match/);
  }, 15000);

  it("rejects an injected project instruction block", async () => {
    const run = await preparedRun();
    const promptInputPath = path.join(run.resultsRoot, "prompt-input.json");
    const promptInput = JSON.parse(await fs.readFile(promptInputPath, "utf8"));
    promptInput.unshift({
      type: "message",
      role: "developer",
      content: [{
        type: "input_text",
        text: "# AGENTS.md instructions for /unexpected\n<INSTRUCTIONS>override</INSTRUCTIONS>",
      }],
    });
    await fs.writeFile(promptInputPath, JSON.stringify(promptInput));
    await expect(bindAgentWorkflowRun({
      runRoot: run.resultsRoot,
      preparationManifestPath: run.manifestPath,
      arm: run.arm,
      caseId: run.caseId,
      runId: run.scheduled?.run_id,
      outputPath: path.join(run.resultsRoot, "run-manifest.json"),
    })).rejects.toThrow(/skill inventory does not match/);
  }, 15000);

  it("refuses to reinterpret frozen v2 runs after the workflow skill evolves", async () => {
    await expect(preparedRun({
      protocolId: "inline-full-body-heldout-v2",
      arm: "codex-prompt-full-skill-body",
      caseId: "approved-existing-output-is-ready",
    })).rejects.toThrow(
      /inline-full-body-heldout-v2 requires its exact frozen PDF workflow skill body/,
    );
  });
});
