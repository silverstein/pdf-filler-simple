#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  openVerifiedSourceSnapshot,
  validateRepositoryRelativePath,
  verifiedCleanSourceCommit,
} from "./source-worktree-state.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGRESSION_CASES_PATH = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "agent-workflows",
  "planning-cases.v1.json",
);
const HELDOUT_CASES_PATH = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "agent-workflows",
  "planning-cases.heldout.v1.json",
);
const HELDOUT_V2_CASES_PATH = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "agent-workflows",
  "planning-cases.heldout.v2.json",
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
  "scripts/eval-score-agent-workflow-repeated-campaign.mjs",
  "scripts/eval-validate-agent-workflow-events.mjs",
  "test/eval/agent-workflow-plan-scorer.js",
];
const execFileAsync = promisify(execFile);
const REGRESSION_ARM_NAMES = [
  "claude-skill",
  "claude-baseline",
  "codex-skill",
  "codex-baseline",
  "codex-explicit-skill",
  "codex-explicit-baseline",
];
const REGRESSION_EXPLICIT_CODEX_ARMS = new Set([
  "codex-explicit-skill",
  "codex-explicit-baseline",
]);
export const FULL_BODY_TREATMENT_ARM = "codex-prompt-full-skill-body";
export const FULL_BODY_CONTROL_ARM = "codex-prompt-no-skill-body";
export const FULL_BODY_START =
  "<<<BEGIN WORKFLOW REFERENCE MATERIAL>>>";
export const FULL_BODY_END =
  "<<<END WORKFLOW REFERENCE MATERIAL>>>";
export const CONDITION_END =
  "<<<END PDF TOOLS CAMPAIGN CONDITION>>>";
const PROTOCOLS = {
  "metadata-regression-v1": {
    kind: "metadata-regression",
    casesPath: REGRESSION_CASES_PATH,
    armNames: REGRESSION_ARM_NAMES,
    explicitCodexArms: REGRESSION_EXPLICIT_CODEX_ARMS,
    repetitions: 1,
    claimBoundary: "Prompt-only participant roots and the trusted oracle have independent destinations. Transfer only the participant root to a model host. This preparation does not run or validate a model host.",
  },
  "inline-full-body-heldout-v1": {
    kind: "inline-full-body-heldout",
    casesPath: HELDOUT_CASES_PATH,
    armNames: [FULL_BODY_TREATMENT_ARM, FULL_BODY_CONTROL_ARM],
    explicitCodexArms: new Set([FULL_BODY_TREATMENT_ARM, FULL_BODY_CONTROL_ARM]),
    repetitions: 3,
    interventionId: "full_skill_markdown_in_user_prompt_v1",
    frozenSkillBytes: 11702,
    frozenSkillSha256:
      "8196ad2ad4e6969428e0f1ca482bd13b4a463036fe53aee544ce5c73ab9a42a7",
    claimBoundary: "Planning-only, inline-full-body versus no-body Codex prompt trials. The treatment proves only that exact workflow Markdown was present in the user prompt. It does not prove native skill discovery, PDF execution, MCP, MCPB, Claude behavior, or an independent benchmark.",
  },
  "inline-full-body-heldout-v2": {
    kind: "inline-full-body-heldout",
    casesPath: HELDOUT_V2_CASES_PATH,
    armNames: [FULL_BODY_TREATMENT_ARM, FULL_BODY_CONTROL_ARM],
    explicitCodexArms: new Set([FULL_BODY_TREATMENT_ARM, FULL_BODY_CONTROL_ARM]),
    repetitions: 3,
    interventionId: "full_skill_markdown_in_user_prompt_v2",
    frozenSkillBytes: 13487,
    frozenSkillSha256:
      "4bcc22a21497dbc3ec8dcdbba2fa6497a307f7aa8b0a9d10369da892695064ff",
    claimBoundary: "Fresh v2 planning-only, inline-full-body versus no-body Codex prompt trials after preserving the v1 NO-GO. The treatment proves only that exact workflow Markdown was present in the user prompt. It does not prove native skill discovery, PDF execution, MCP, MCPB, Claude behavior, or an independent benchmark.",
  },
};
const DEFAULT_PROTOCOL = "metadata-regression-v1";
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

export function sha256(value) {
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

export async function writePrivate(filename, value) {
  await fs.writeFile(filename, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

function repositoryRelativePath(absolutePath) {
  return validateRepositoryRelativePath(
    path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/"),
    "campaign source path",
  );
}

async function materializeCommitTree(entries, destination) {
  for (const entry of entries) {
    const destinationPath = path.join(destination, ...entry.path.split("/"));
    await fs.mkdir(path.dirname(destinationPath), {
      recursive: true,
      mode: 0o700,
    });
    await fs.writeFile(destinationPath, entry.bytes, {
      flag: "wx",
      mode: 0o600,
    });
  }
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

export async function inventory(root) {
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

export async function syntheticGitIdentity(root) {
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

function sharedHeldoutPrompt(testCase, rubric) {
  const lines = [
    "This is a synthetic planning-only evaluation.",
    "No model-callable tool use is permitted. Do not call PDF, filesystem, shell, network, task, or other tools, and do not execute any operation.",
    "Return only one JSON object matching response-schema.json.",
    "Account for all seven workflow stages in order.",
    `Case ID: ${testCase.id}`,
    rubric.trim(),
    `Case: ${testCase.prompt}`,
  ];
  if (Array.isArray(testCase.evidence_refs)) {
    lines.splice(
      lines.length - 1,
      0,
      `Available opaque evidence references: ${testCase.evidence_refs.join(", ")}.`,
    );
  }
  return lines.join("\n\n");
}

export function heldoutParticipantPrompt(testCase, rubric, {
  skillBody = "",
} = {}) {
  const condition = [
    "Apply any workflow reference text inside the block below as the governing workflow instructions for this synthetic case. The block may be empty.",
    FULL_BODY_START,
    skillBody,
    FULL_BODY_END,
    CONDITION_END,
  ].join("\n");
  return `${condition}\n\n${sharedHeldoutPrompt(testCase, rubric)}`;
}

export function balancedHeldoutSchedule(caseIds, repetitions = 3) {
  if (!Array.isArray(caseIds) || caseIds.length === 0) {
    throw new Error("held-out schedule requires at least one case");
  }
  if (!Number.isInteger(repetitions) || repetitions < 2) {
    throw new Error("held-out schedule requires at least two repetitions");
  }
  const schedule = [];
  for (let repeatIndex = 0; repeatIndex < repetitions; repeatIndex += 1) {
    const offset = (repeatIndex * 2) % caseIds.length;
    const orderedCases = [
      ...caseIds.slice(offset),
      ...caseIds.slice(0, offset),
    ];
    for (const caseId of orderedCases) {
      const originalIndex = caseIds.indexOf(caseId);
      const treatmentFirst = (repeatIndex + originalIndex) % 2 === 0;
      const arms = treatmentFirst
        ? [FULL_BODY_TREATMENT_ARM, FULL_BODY_CONTROL_ARM]
        : [FULL_BODY_CONTROL_ARM, FULL_BODY_TREATMENT_ARM];
      const pairId = `${caseId}-r${repeatIndex + 1}`;
      arms.forEach((arm, pairPosition) => {
        schedule.push({
          ordinal: schedule.length + 1,
          run_id: `${pairId}-${arm}`,
          pair_id: pairId,
          pair_position: pairPosition + 1,
          repeat_index: repeatIndex + 1,
          case_id: caseId,
          arm,
        });
      });
    }
  }
  return schedule;
}

export function hostCompatibleSchema(value) {
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

export async function verifiedSourceCommit() {
  return verifiedCleanSourceCommit(REPO_ROOT, {
    label: "campaign source worktree",
  });
}

export async function prepareAgentWorkflowCampaign({
  participantsDestination,
  oracleDestination,
  protocolId = DEFAULT_PROTOCOL,
}) {
  const protocol = PROTOCOLS[protocolId];
  if (!protocol) throw new Error(`unsupported campaign protocol: ${protocolId}`);
  const isHeldout = protocol.kind === "inline-full-body-heldout";
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

  const sourceSnapshot = await openVerifiedSourceSnapshot(REPO_ROOT, {
    label: "campaign source worktree",
  });
  const sourceCommit = sourceSnapshot.commit;
  const participantsRoot = participantsDestination;
  const trustedRoot = oracleDestination;

  const casesBytes = await sourceSnapshot.readFile(
    repositoryRelativePath(protocol.casesPath),
  );
  const cases = JSON.parse(casesBytes);
  const rubricBytes = await sourceSnapshot.readFile(
    repositoryRelativePath(RUBRIC_PATH),
  );
  const rubric = rubricBytes.toString("utf8");
  const embeddedRubric = rubric.trim();
  const responseSchemaRelativePath = validateRepositoryRelativePath(
    cases.response_schema,
    "campaign response schema",
  );
  const responseSchemaBytes = await sourceSnapshot.readFile(
    responseSchemaRelativePath,
  );
  const responseSchema = JSON.parse(responseSchemaBytes);
  const compatibleSchema = `${JSON.stringify(hostCompatibleSchema(responseSchema), null, 2)}\n`;
  const skillBodyBytes = await sourceSnapshot.readFile(
    repositoryRelativePath(path.join(SKILL_ROOT, "SKILL.md")),
  );
  const skillBody = skillBodyBytes.toString("utf8");
  if (
    isHeldout
    && (
      skillBodyBytes.length !== protocol.frozenSkillBytes
      || sha256(skillBodyBytes) !== protocol.frozenSkillSha256
    )
  ) {
    throw new Error(
      `${protocolId} requires its exact frozen PDF workflow skill body`,
    );
  }
  const pluginTree = protocolId === "metadata-regression-v1"
    ? await sourceSnapshot.readTree(repositoryRelativePath(PLUGIN_ROOT))
    : null;
  const skillTreePrefix = "skills/pdf-tools-workflow/";
  const skillTree = pluginTree?.filter(entry =>
    entry.path.startsWith(skillTreePrefix)).map(entry => Object.freeze({
    ...entry,
    path: entry.path.slice(skillTreePrefix.length),
  }));
  if (pluginTree && (!skillTree || skillTree.length === 0)) {
    throw new Error("campaign commit snapshot is missing its PDF workflow skill tree");
  }
  const controllerArtifacts = Object.fromEntries(await Promise.all(
    CONTROLLER_ARTIFACTS.map(async relative => {
      const bytes = await sourceSnapshot.readFile(relative);
      return [relative, {
        bytes: bytes.length,
        sha256: sha256(bytes),
      }];
    }),
  ));

  await fs.mkdir(participantsRoot, { mode: 0o700 });
  await fs.mkdir(trustedRoot, { mode: 0o700 });

  for (const arm of protocol.armNames) {
    const armRoot = path.join(participantsRoot, arm);
    if (protocol.explicitCodexArms.has(arm)) {
      for (const testCase of cases.cases) {
        const caseRoot = path.join(armRoot, "cases", testCase.id);
        await fs.mkdir(caseRoot, { recursive: true, mode: 0o700 });
        await writePrivate(
          path.join(caseRoot, "response-schema.json"),
          compatibleSchema,
        );
        const prompt = isHeldout
          ? heldoutParticipantPrompt(testCase, embeddedRubric, {
            skillBody: arm === FULL_BODY_TREATMENT_ARM ? skillBody : "",
          })
          : participantPrompt(testCase, embeddedRubric, { explicitSkill: true });
        await writePrivate(path.join(caseRoot, "prompt.txt"), `${prompt}\n`);
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

  if (protocolId === "metadata-regression-v1") {
    await materializeCommitTree(
      pluginTree,
      path.join(participantsRoot, "claude-skill", "plugin", "pdf-tools-workflow"),
    );
    await fs.mkdir(
      path.join(participantsRoot, "codex-skill", ".agents", "skills"),
      { recursive: true, mode: 0o700 },
    );
    await materializeCommitTree(
      skillTree,
      path.join(participantsRoot, "codex-skill", ".agents", "skills", "pdf-tools-workflow"),
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
      await materializeCommitTree(
        skillTree,
        path.join(skillsRoot, "pdf-tools-workflow"),
      );
    }
  }

  const armAttestations = {};
  for (const arm of protocol.armNames) {
    const armRoot = path.join(participantsRoot, arm);
    armAttestations[arm] = {
      content_inventory: await inventory(armRoot),
      synthetic_git: await syntheticGitIdentity(armRoot),
    };
  }
  const explicitCaseAttestations = {};
  for (const arm of protocol.explicitCodexArms) {
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
    protocol_id: protocolId,
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
  const oracleBytes = `${JSON.stringify(oracle, null, 2)}\n`;

  const pairedCaseContracts = isHeldout
    ? Object.fromEntries(await Promise.all(cases.cases.map(async testCase => {
      const treatmentPrompt = await fs.readFile(path.join(
        participantsRoot,
        FULL_BODY_TREATMENT_ARM,
        "cases",
        testCase.id,
        "prompt.txt",
      ));
      const controlPrompt = await fs.readFile(path.join(
        participantsRoot,
        FULL_BODY_CONTROL_ARM,
        "cases",
        testCase.id,
        "prompt.txt",
      ));
      const sharedPrompt = `${sharedHeldoutPrompt(testCase, embeddedRubric)}\n`;
      const normalizedTreatment = treatmentPrompt.toString("utf8").replace(
        `${FULL_BODY_START}\n${skillBody}\n${FULL_BODY_END}`,
        `${FULL_BODY_START}\n\n${FULL_BODY_END}`,
      );
      if (normalizedTreatment !== controlPrompt.toString("utf8")) {
        throw new Error(
          `held-out prompts differ outside the exact skill payload: ${testCase.id}`,
        );
      }
      return [testCase.id, {
        shared_prompt_sha256: sha256(sharedPrompt),
        treatment_prompt_sha256: sha256(treatmentPrompt),
        control_prompt_sha256: sha256(controlPrompt),
        normalized_prompt_sha256: sha256(normalizedTreatment),
        response_schema_sha256: sha256(compatibleSchema),
      }];
    })))
    : null;
  const runSchedule = isHeldout
    ? balancedHeldoutSchedule(
      cases.cases.map(testCase => testCase.id),
      protocol.repetitions,
    )
    : [];
  const manifest = {
    schema_version: isHeldout
      ? "pdf-tools.agent-workflow-campaign-preparation.v2"
      : "pdf-tools.agent-workflow-campaign-preparation.v1",
    protocol_id: protocolId,
    source_commit: sourceCommit,
    claim_boundary: protocol.claimBoundary,
    arm_names: protocol.armNames,
    repetitions: protocol.repetitions,
    sampling_seed: isHeldout
      ? "unavailable"
      : null,
    intervention: isHeldout
      ? {
        id: protocol.interventionId,
        treatment_arm: FULL_BODY_TREATMENT_ARM,
        control_arm: FULL_BODY_CONTROL_ARM,
        skill_body_bytes: skillBodyBytes.length,
        skill_body_sha256: sha256(skillBodyBytes),
        start_sentinel: FULL_BODY_START,
        end_sentinel: FULL_BODY_END,
        condition_end_sentinel: CONDITION_END,
      }
      : null,
    paired_case_contracts: pairedCaseContracts,
    run_schedule: runSchedule,
    run_schedule_sha256: sha256(canonicalJson(runSchedule)),
    participant_inventory: await inventory(participantsRoot),
    arm_attestations: armAttestations,
    explicit_case_attestations: explicitCaseAttestations,
    controller_artifacts: controllerArtifacts,
    oracle_sha256: sha256(oracleBytes),
  };
  await sourceSnapshot.verifyUnchanged();
  await writePrivate(
    path.join(trustedRoot, "oracle.json"),
    oracleBytes,
  );
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
    protocolId: values["--protocol"] ?? DEFAULT_PROTOCOL,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await prepareAgentWorkflowCampaign(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
