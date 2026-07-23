#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
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
const RUBRIC_PATH = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "agent-workflows",
  "planning-rubric.v1.txt",
);
const SKILL_ROOT = path.join(
  REPO_ROOT,
  "plugins",
  "pdf-tools-workflow",
  "skills",
  "pdf-tools-workflow",
);
const PLUGIN_ROOT = path.join(REPO_ROOT, "plugins", "pdf-tools-workflow");
const CONTROLLER_ARTIFACTS = [
  "scripts/eval-attest-agent-workflow-arm.mjs",
  "scripts/eval-bind-agent-workflow-run.mjs",
  "scripts/eval-run-codex-agent-workflow-case.mjs",
  "scripts/eval-validate-agent-workflow-events.mjs",
];
const execFileAsync = promisify(execFile);
const ARM_NAMES = [
  "claude-skill",
  "claude-baseline",
  "codex-skill",
  "codex-baseline",
  "codex-explicit-skill",
  "codex-explicit-baseline",
];
const EXPLICIT_CODEX_ARMS = new Set([
  "codex-explicit-skill",
  "codex-explicit-baseline",
]);
const SYNTHETIC_GIT_ENV = {
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
const SYNTHETIC_GIT_MESSAGE = "Synthetic participant arm";

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
  entries.sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ));
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

async function syntheticGitIdentity(root) {
  const temporaryRoot = await fs.mkdtemp(path.join(
    os.tmpdir(),
    "pdf-tools-agent-workflow-git-",
  ));
  try {
    const gitEnvironment = { ...process.env, ...SYNTHETIC_GIT_ENV };
    await execFileAsync("git", [
      "init",
      "-q",
      "--object-format=sha1",
      "--template=",
      temporaryRoot,
    ], { env: gitEnvironment });
    for (const entry of await fs.readdir(root)) {
      await fs.cp(
        path.join(root, entry),
        path.join(temporaryRoot, entry),
        { recursive: true },
      );
    }
    await execFileAsync("git", [
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.eol=lf",
      "add",
      "-A",
    ], { cwd: temporaryRoot, env: gitEnvironment });
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
      SYNTHETIC_GIT_MESSAGE,
    ], {
      cwd: temporaryRoot,
      env: gitEnvironment,
    });
    const [{ stdout: commit }, { stdout: tree }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: temporaryRoot,
        encoding: "utf8",
      }),
      execFileAsync("git", ["rev-parse", "HEAD^{tree}"], {
        cwd: temporaryRoot,
        encoding: "utf8",
      }),
    ]);
    return {
      expected_commit_sha1: commit.trim(),
      expected_tree_sha1: tree.trim(),
      author_name: "PDF Workflow Eval",
      author_email: "eval@invalid.local",
      author_and_committer_date: SYNTHETIC_GIT_ENV.GIT_AUTHOR_DATE,
      commit_message: SYNTHETIC_GIT_MESSAGE,
      parent_count: 0,
    };
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

function participantPrompt(testCase, rubric, { explicitSkill = false } = {}) {
  const lines = [
    "This is a synthetic planning-only evaluation.",
    explicitSkill
      ? "The host may natively load only the exact named pdf-tools-workflow SKILL.md. No model-callable tool use is permitted. Do not call PDF, filesystem, shell, network, task, or other tools, and do not execute any operation."
      : "Do not call tools, inspect files, or execute any operation.",
    "Return only one JSON object matching response-schema.json.",
    "Account for all seven workflow stages in order.",
    `Case ID: ${testCase.id}`,
    rubric.trim(),
    `Case: ${testCase.prompt}`,
  ];
  if (explicitSkill) lines.unshift("$pdf-tools-workflow");
  return lines.join("\n\n");
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
  const rubricBytes = await fs.readFile(RUBRIC_PATH);
  const rubric = rubricBytes.toString("utf8");
  const embeddedRubric = rubric.trim();
  const responseSchemaPath = path.join(REPO_ROOT, cases.response_schema);
  const responseSchemaBytes = await fs.readFile(responseSchemaPath);
  const responseSchema = JSON.parse(responseSchemaBytes);
  const compatibleSchema = `${JSON.stringify(hostCompatibleSchema(responseSchema), null, 2)}\n`;

  for (const arm of ARM_NAMES) {
    const armRoot = path.join(participantsRoot, arm);
    if (EXPLICIT_CODEX_ARMS.has(arm)) {
      for (const testCase of cases.cases) {
        const caseRoot = path.join(armRoot, "cases", testCase.id);
        await fs.mkdir(caseRoot, { recursive: true, mode: 0o700 });
        await writePrivate(
          path.join(caseRoot, "response-schema.json"),
          compatibleSchema,
        );
        await writePrivate(
          path.join(caseRoot, "prompt.txt"),
          `${participantPrompt(testCase, embeddedRubric, {
            explicitSkill: true,
          })}\n`,
        );
      }
    } else {
      const promptsRoot = path.join(armRoot, "prompts");
      await fs.mkdir(promptsRoot, { recursive: true, mode: 0o700 });
      await writePrivate(path.join(armRoot, "response-schema.json"), compatibleSchema);
      for (const testCase of cases.cases) {
        await writePrivate(
          path.join(promptsRoot, `${testCase.id}.txt`),
          `${participantPrompt(testCase, embeddedRubric)}\n`,
        );
      }
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
  for (const testCase of cases.cases) {
    const skillsRoot = path.join(
      participantsRoot,
      "codex-explicit-skill",
      "cases",
      testCase.id,
      ".agents",
      "skills",
    );
    await fs.mkdir(skillsRoot, { recursive: true, mode: 0o700 });
    await fs.cp(
      SKILL_ROOT,
      path.join(skillsRoot, "pdf-tools-workflow"),
      { recursive: true, errorOnExist: true, force: false },
    );
  }

  const armAttestations = {};
  for (const arm of ARM_NAMES) {
    const armRoot = path.join(participantsRoot, arm);
    armAttestations[arm] = {
      content_inventory: await inventory(armRoot),
      synthetic_git: await syntheticGitIdentity(armRoot),
    };
  }
  const explicitCaseAttestations = {};
  for (const arm of EXPLICIT_CODEX_ARMS) {
    explicitCaseAttestations[arm] = {};
    for (const testCase of cases.cases) {
      const caseRoot = path.join(participantsRoot, arm, "cases", testCase.id);
      explicitCaseAttestations[arm][testCase.id] = {
        content_inventory: await inventory(caseRoot),
        synthetic_git: await syntheticGitIdentity(caseRoot),
      };
    }
  }

  const oracle = {
    schema_version: cases.schema_version,
    source_commit: sourceCommit,
    cases_sha256: sha256(casesBytes),
    rubric_source_sha256: sha256(rubricBytes),
    rubric_embedded_sha256: sha256(embeddedRubric),
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
    arm_attestations: armAttestations,
    explicit_case_attestations: explicitCaseAttestations,
    controller_artifacts: Object.fromEntries(await Promise.all(
      CONTROLLER_ARTIFACTS.map(async relative => {
        const bytes = await fs.readFile(path.join(REPO_ROOT, relative));
        return [relative, {
          bytes: bytes.length,
          sha256: sha256(bytes),
        }];
      }),
    )),
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
