#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_ENVIRONMENT_NAMES,
  codexExecArgs,
  codexPromptInputArgs,
  sandboxedCodexArgs,
} from "./eval-run-codex-agent-workflow-case.mjs";
import {
  validateAgentWorkflowEventFile,
} from "./eval-validate-agent-workflow-events.mjs";

const BINDER_PATH = fileURLToPath(import.meta.url);
const EVENT_VALIDATOR_PATH = fileURLToPath(new URL(
  "./eval-validate-agent-workflow-events.mjs",
  import.meta.url,
));
const BINDER_ARTIFACT = "scripts/eval-bind-agent-workflow-run.mjs";
const EVENT_VALIDATOR_ARTIFACT =
  "scripts/eval-validate-agent-workflow-events.mjs";
const LAUNCHER_ARTIFACT =
  "scripts/eval-run-codex-agent-workflow-case.mjs";
const ATTESTER_ARTIFACT =
  "scripts/eval-attest-agent-workflow-arm.mjs";
const REQUIRED_ARTIFACTS = [
  "events.jsonl",
  "launch-outcome.json",
  "launch-plan.json",
  "post-run-attestation.json",
  "pre-run-attestation.json",
  "prompt-input.json",
  "prompt-input.stderr.txt",
  "response.json",
  "stderr.txt",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function equalJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function artifactRecord(bytes) {
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

function attestExpected(value, expected, label) {
  if (
    value?.pass !== true
    || value?.clean !== true
    || value?.commit_count !== 1
    || value?.parent_count !== 0
    || value?.commit_sha1 !== expected.synthetic_git.expected_commit_sha1
    || value?.git_tree_sha1 !== expected.synthetic_git.expected_tree_sha1
    || value?.content_inventory?.tree_sha256
      !== expected.content_inventory.tree_sha256
  ) {
    throw new Error(`${label} does not match the trusted per-case identity`);
  }
}

export async function bindAgentWorkflowRun({
  runRoot,
  preparationManifestPath,
  arm,
  caseId,
  outputPath,
}) {
  for (const [label, value] of Object.entries({
    runRoot,
    preparationManifestPath,
    outputPath,
  })) {
    if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  }
  if (path.dirname(outputPath) !== runRoot) {
    throw new Error("outputPath must be a direct child of runRoot");
  }
  const actualArtifacts = (await fs.readdir(runRoot)).sort();
  if (!equalJson(actualArtifacts, REQUIRED_ARTIFACTS)) {
    throw new Error("runRoot must contain exactly the unbound run artifact set");
  }

  const preparationBytes = await fs.readFile(preparationManifestPath);
  const preparation = parseJson(preparationBytes, "preparation manifest");
  const expected = preparation?.explicit_case_attestations?.[arm]?.[caseId];
  if (!expected) throw new Error("arm and case are absent from the trusted manifest");
  const launcherPath = fileURLToPath(new URL(
    "./eval-run-codex-agent-workflow-case.mjs",
    import.meta.url,
  ));
  const [binderBytes, eventValidatorBytes, launcherBytes] = await Promise.all([
    fs.readFile(BINDER_PATH),
    fs.readFile(EVENT_VALIDATOR_PATH),
    fs.readFile(launcherPath),
  ]);
  if (
    sha256(binderBytes) !== preparation?.controller_artifacts?.[BINDER_ARTIFACT]?.sha256
    || sha256(eventValidatorBytes)
      !== preparation?.controller_artifacts?.[EVENT_VALIDATOR_ARTIFACT]?.sha256
    || sha256(launcherBytes)
      !== preparation?.controller_artifacts?.[LAUNCHER_ARTIFACT]?.sha256
  ) {
    throw new Error("controller validator code differs from the trusted preparation");
  }

  const bytesByName = {};
  await Promise.all(REQUIRED_ARTIFACTS.map(async name => {
    bytesByName[name] = await fs.readFile(path.join(runRoot, name));
  }));
  const events = bytesByName["events.jsonl"].toString("utf8")
    .split(/\r?\n/)
    .filter(line => line.trim())
    .map((line, index) => parseJson(Buffer.from(line), `event line ${index + 1}`));
  const eventValidation = await validateAgentWorkflowEventFile(
    path.join(runRoot, "events.jsonl"),
  );
  if (!eventValidation.pass) throw new Error("event stream validation failed");

  const response = parseJson(bytesByName["response.json"], "response");
  const eventResponse = parseJson(
    Buffer.from(events[2].item.text),
    "validated agent message",
  );
  if (!equalJson(response, eventResponse)) {
    throw new Error("response does not equal the validated agent message");
  }
  if (response?.case_id !== caseId) {
    throw new Error("response case_id does not match the bound case");
  }

  const pre = parseJson(bytesByName["pre-run-attestation.json"], "pre-attestation");
  const post = parseJson(bytesByName["post-run-attestation.json"], "post-attestation");
  attestExpected(pre, expected, "pre-attestation");
  attestExpected(post, expected, "post-attestation");
  if (!equalJson(pre.content_inventory, post.content_inventory)) {
    throw new Error("case content changed between pre- and post-attestation");
  }

  const plan = parseJson(bytesByName["launch-plan.json"], "launch plan");
  const outcome = parseJson(bytesByName["launch-outcome.json"], "launch outcome");
  if (
    plan.arm !== arm
    || plan.case_id !== caseId
    || plan.source_commit !== preparation.source_commit
    || !equalJson(plan.expected_identity, {
      commit_sha1: expected.synthetic_git.expected_commit_sha1,
      git_tree_sha1: expected.synthetic_git.expected_tree_sha1,
      content_tree_sha256: expected.content_inventory.tree_sha256,
    })
  ) {
    throw new Error("launch plan does not match the trusted arm and case");
  }
  const promptEntry = expected.content_inventory.entries.find(
    entry => entry.path === "prompt.txt",
  );
  const schemaEntry = expected.content_inventory.entries.find(
    entry => entry.path === "response-schema.json",
  );
  if (
    !promptEntry
    || !schemaEntry
    || plan.prompt_sha256 !== promptEntry.sha256
    || plan.response_schema_sha256 !== schemaEntry.sha256
    || plan.command.stdin_sha256 !== promptEntry.sha256
    || plan.attester_sha256
      !== preparation?.controller_artifacts?.[ATTESTER_ARTIFACT]?.sha256
    || plan.launcher_sha256
      !== preparation?.controller_artifacts?.[LAUNCHER_ARTIFACT]?.sha256
  ) {
    throw new Error("launch plan input hashes do not match the trusted case inventory");
  }
  const expectedCodexArgs = codexExecArgs({
    model: plan.model,
    responsePath: path.join(runRoot, "response.json"),
  });
  const expectedExecArgs = sandboxedCodexArgs({
    sandboxProfile: plan.isolation?.sandbox_profile,
    codexBinary: plan.command.codex_program,
    codexArgs: expectedCodexArgs,
  });
  if (
    plan.isolation?.process_home_inherited !== false
    || !path.isAbsolute(plan.isolation?.denied_user_home ?? "")
    || plan.command.program !== plan.isolation?.sandbox_program
    || !equalJson(plan.isolation?.environment_names, CODEX_ENVIRONMENT_NAMES)
    || plan.command.cwd !== plan.case_root
    || plan.command.stdout !== path.join(runRoot, "events.jsonl")
    || plan.command.stderr !== path.join(runRoot, "stderr.txt")
    || !equalJson(plan.command.codex_argv, expectedCodexArgs)
    || !equalJson(plan.command.argv, expectedExecArgs)
  ) {
    throw new Error("launch command differs from the reviewed Codex command");
  }
  if (
    outcome.process_exit_code !== 0
    || outcome.process_signal !== null
    || outcome.post_attestation_pass !== true
    || outcome.prompt_input_exit_code !== 0
    || outcome.prompt_input_signal !== null
  ) {
    throw new Error("launch outcome is not a successful attested run");
  }

  const promptInput = parseJson(bytesByName["prompt-input.json"], "prompt input");
  if (
    !Array.isArray(promptInput)
    || promptInput.some(item =>
      item?.type !== "message" || !["developer", "user"].includes(item?.role))
  ) {
    throw new Error("prompt input must contain only developer and user messages");
  }
  const promptInputText = canonicalJson(promptInput);
  const capturedPrompt = outcome?.prompt_input_command?.codex_argv?.at(-1);
  const expectedPromptInputCodexArgs = codexPromptInputArgs(capturedPrompt);
  const expectedPromptInputArgs = sandboxedCodexArgs({
    sandboxProfile: plan.isolation.sandbox_profile,
    codexBinary: plan.command.codex_program,
    codexArgs: expectedPromptInputCodexArgs,
  });
  if (
    typeof capturedPrompt !== "string"
    || sha256(capturedPrompt) !== promptEntry.sha256
    || !equalJson(outcome.prompt_input_command.codex_argv, expectedPromptInputCodexArgs)
    || !equalJson(outcome.prompt_input_command.argv, expectedPromptInputArgs)
    || outcome.prompt_input_command.cwd !== plan.case_root
    || outcome.prompt_input_command.program !== plan.command.program
    || outcome.prompt_input_command.codex_program !== plan.command.codex_program
    || !promptInputText.includes(`Case ID: ${caseId}`)
    || !promptInputText.includes("$pdf-tools-workflow")
    || promptInputText.includes(plan.isolation.denied_user_home)
  ) {
    throw new Error("prompt-input evidence does not match the reviewed run input");
  }
  const skillPath = `${plan.case_root}/.agents/skills/pdf-tools-workflow/SKILL.md`;
  const systemSkillRoot = `${plan.codex_home}/skills/.system/`;
  const skillFiles = [...promptInputText.matchAll(
    /file:\s*([^"\s)]+\/SKILL\.md)/g,
  )].map(match => match[1]);
  const unexpectedSkillFiles = skillFiles.filter(filename =>
    filename !== skillPath && !filename.startsWith(systemSkillRoot));
  if (
    unexpectedSkillFiles.length > 0
    || (arm === "codex-explicit-skill"
      && skillFiles.filter(filename => filename === skillPath).length !== 1)
    || (arm === "codex-explicit-baseline"
      && skillFiles.some(filename =>
        filename.includes("pdf-tools-workflow") || filename === skillPath))
    || /(?:AGENTS|CLAUDE)\.md/.test(promptInputText)
    || /\.codex\/plugins|\.claude-plugin|mcpServers/.test(promptInputText)
  ) {
    throw new Error("prompt-input skill inventory does not match the bound arm");
  }

  const artifacts = Object.fromEntries(
    REQUIRED_ARTIFACTS.map(name => [name, artifactRecord(bytesByName[name])]),
  );
  const manifest = {
    schema_version: "pdf-tools.agent-workflow-bound-run.v1",
    claim_ready: true,
    arm,
    case_id: caseId,
    source_commit: preparation.source_commit,
    model: plan.model,
    host: plan.host,
    expected_identity: plan.expected_identity,
    preparation_manifest: {
      bytes: preparationBytes.length,
      sha256: sha256(preparationBytes),
    },
    case_inventory_sha256: sha256(
      Buffer.from(canonicalJson(expected.content_inventory)),
    ),
    controller_artifacts: preparation.controller_artifacts,
    artifacts,
    command: plan.command,
    prompt_input_command: outcome.prompt_input_command,
    event_validation: eventValidation,
    response,
  };
  await fs.writeFile(
    outputPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return manifest;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    values[argv[index]] = argv[index + 1];
  }
  const mapping = {
    runRoot: "--run-root",
    preparationManifestPath: "--preparation-manifest",
    arm: "--arm",
    caseId: "--case-id",
    outputPath: "--output",
  };
  const result = {};
  for (const [key, flag] of Object.entries(mapping)) {
    if (!values[flag]) throw new Error(`Missing required argument: ${flag}`);
    result[key] = values[flag];
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await bindAgentWorkflowRun(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({
    claim_ready: result.claim_ready,
    arm: result.arm,
    case_id: result.case_id,
    event_sha256: result.artifacts["events.jsonl"].sha256,
    response_sha256: result.artifacts["response.json"].sha256,
  })}\n`);
}
