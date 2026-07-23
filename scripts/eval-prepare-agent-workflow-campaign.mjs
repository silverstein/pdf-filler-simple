#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CASES_PATH = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "agent-workflows",
  "planning-cases.v1.json",
);
const SKILL_ROOT = path.join(
  REPO_ROOT,
  "plugins",
  "pdf-tools-workflow",
  "skills",
  "pdf-tools-workflow",
);
const PLUGIN_ROOT = path.join(REPO_ROOT, "plugins", "pdf-tools-workflow");
const execFileAsync = promisify(execFile);
const ARM_NAMES = [
  "claude-skill",
  "claude-baseline",
  "codex-skill",
  "codex-baseline",
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

async function writePrivate(filename, value) {
  await fs.writeFile(filename, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function listFiles(root, relativeRoot = "") {
  const entries = await fs.readdir(path.join(root, relativeRoot), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of entries) {
    const relative = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, relative));
    else if (entry.isFile()) files.push(relative.split(path.sep).join("/"));
    else throw new Error(`Unsupported campaign source entry: ${relative}`);
  }
  return files;
}

async function inventory(root) {
  const entries = [];
  for (const relative of await listFiles(root)) {
    const bytes = await fs.readFile(path.join(root, relative));
    entries.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return {
    file_count: entries.length,
    total_bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    tree_sha256: sha256(canonicalJson(entries)),
    entries,
  };
}

function participantPrompt(testCase) {
  return [
    "This is a synthetic planning-only evaluation.",
    "Do not call tools, inspect files, or execute any operation.",
    "Return only one JSON object matching response-schema.json.",
    "Account for all seven workflow stages in order.",
    testCase.prompt,
  ].join(" ");
}

function hostCompatibleSchema(value) {
  if (Array.isArray(value)) return value.map(hostCompatibleSchema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !new Set(["$schema", "$id", "uniqueItems"]).has(key))
    .map(([key, child]) => [key, hostCompatibleSchema(child)]));
}

function pathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function verifiedSourceCommit() {
  const [{ stdout: sourceCommit }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }),
    execFileAsync(
      "git",
      ["-C", REPO_ROOT, "status", "--porcelain", "--untracked-files=all"],
      { encoding: "utf8" },
    ),
  ]);
  if (status.trim()) {
    throw new Error("campaign source worktree must be clean at its exact HEAD");
  }
  return sourceCommit.trim();
}

export async function prepareAgentWorkflowCampaign({
  participantsDestination,
  oracleDestination,
}) {
  if (!path.isAbsolute(participantsDestination)) {
    throw new Error("participantsDestination must be absolute");
  }
  if (!path.isAbsolute(oracleDestination)) {
    throw new Error("oracleDestination must be absolute");
  }
  if (
    pathInside(REPO_ROOT, participantsDestination)
    || pathInside(REPO_ROOT, oracleDestination)
  ) {
    throw new Error("campaign destinations must remain outside the source repository");
  }
  if (
    pathInside(participantsDestination, oracleDestination)
    || pathInside(oracleDestination, participantsDestination)
  ) {
    throw new Error("participant and oracle destinations must not contain each other");
  }

  const sourceCommit = await verifiedSourceCommit();
  const participantsRoot = participantsDestination;
  const trustedRoot = oracleDestination;
  await fs.mkdir(participantsRoot, { mode: 0o700 });
  await fs.mkdir(trustedRoot, { mode: 0o700 });

  const casesBytes = await fs.readFile(CASES_PATH);
  const cases = JSON.parse(casesBytes);
  const responseSchemaPath = path.join(REPO_ROOT, cases.response_schema);
  const responseSchemaBytes = await fs.readFile(responseSchemaPath);
  const responseSchema = JSON.parse(responseSchemaBytes);
  const compatibleSchema = `${JSON.stringify(hostCompatibleSchema(responseSchema), null, 2)}\n`;

  for (const arm of ARM_NAMES) {
    const armRoot = path.join(participantsRoot, arm);
    const promptsRoot = path.join(armRoot, "prompts");
    await fs.mkdir(promptsRoot, { recursive: true, mode: 0o700 });
    await writePrivate(path.join(armRoot, "response-schema.json"), compatibleSchema);
    for (const testCase of cases.cases) {
      await writePrivate(
        path.join(promptsRoot, `${testCase.id}.txt`),
        `${participantPrompt(testCase)}\n`,
      );
    }
  }

  await fs.cp(
    PLUGIN_ROOT,
    path.join(participantsRoot, "claude-skill", "plugin", "pdf-tools-workflow"),
    { recursive: true, errorOnExist: true, force: false },
  );
  await fs.mkdir(
    path.join(participantsRoot, "codex-skill", ".agents", "skills"),
    { recursive: true, mode: 0o700 },
  );
  await fs.cp(
    SKILL_ROOT,
    path.join(participantsRoot, "codex-skill", ".agents", "skills", "pdf-tools-workflow"),
    { recursive: true, errorOnExist: true, force: false },
  );

  const oracle = {
    schema_version: cases.schema_version,
    source_commit: sourceCommit,
    cases_sha256: sha256(casesBytes),
    response_schema_sha256: sha256(responseSchemaBytes),
    cases: cases.cases.map(testCase => ({
      id: testCase.id,
      expected: testCase.expected,
    })),
  };
  await writePrivate(
    path.join(trustedRoot, "oracle.json"),
    `${JSON.stringify(oracle, null, 2)}\n`,
  );

  const manifest = {
    schema_version: "pdf-tools.agent-workflow-campaign-preparation.v1",
    source_commit: sourceCommit,
    claim_boundary: "Prompt-only participant roots and the trusted oracle have independent destinations. Transfer only the participant root to a model host. This preparation does not run or validate a model host.",
    arm_names: ARM_NAMES,
    participant_inventory: await inventory(participantsRoot),
    oracle_sha256: sha256(await fs.readFile(path.join(trustedRoot, "oracle.json"))),
  };
  await writePrivate(
    path.join(trustedRoot, "preparation-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    values[argv[index]] = argv[index + 1];
  }
  if (!values["--participants-destination"] || !values["--oracle-destination"]) {
    throw new Error("Usage: eval-prepare-agent-workflow-campaign.mjs --participants-destination <absolute-path> --oracle-destination <absolute-path>");
  }
  return {
    participantsDestination: values["--participants-destination"],
    oracleDestination: values["--oracle-destination"],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await prepareAgentWorkflowCampaign(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
