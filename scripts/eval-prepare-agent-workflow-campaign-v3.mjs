#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONDITION_END,
  FULL_BODY_CONTROL_ARM,
  FULL_BODY_END,
  FULL_BODY_START,
  FULL_BODY_TREATMENT_ARM,
  heldoutParticipantPrompt,
  hostCompatibleSchema,
  inventory,
  sha256,
  syntheticGitIdentity,
  verifiedSourceCommit,
  writePrivate,
} from "./eval-prepare-agent-workflow-campaign.mjs";
import { parseStrictJson } from "./eval-strict-json.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const FIXTURE_ROOT = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "agent-workflows",
);
const CASES_PATH = path.join(FIXTURE_ROOT, "planning-cases.heldout.v3.json");
const RESPONSE_SCHEMA_PATH = path.join(
  FIXTURE_ROOT,
  "planning-response.semantic-v1.schema.json",
);
const RUBRIC_PATH = path.join(FIXTURE_ROOT, "planning-rubric.semantic-v1.txt");
const WORKFLOW_CONTRACT_PATH = path.join(FIXTURE_ROOT, "workflow-contract.v2.json");
const POLICY_PATH = path.join(FIXTURE_ROOT, "semantic-safety-policy.v1.json");
const SEMANTIC_ORACLE_PATH = path.join(
  FIXTURE_ROOT,
  "semantic-safety-oracle.heldout.v3.json",
);
const CONFORMANCE_ORACLE_PATH = path.join(
  FIXTURE_ROOT,
  "planning-conformance-oracle.heldout.v3.json",
);
const PRIOR_BINDINGS_PATH = path.join(
  FIXTURE_ROOT,
  "v1-v2-frozen-resource-bindings.json",
);
const TOOL_CONTRACT_PATH = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "trajectories",
  "tool-contracts.v2.json",
);
const SKILL_PATH = path.join(
  REPO_ROOT,
  "plugins",
  "pdf-tools-workflow",
  "skills",
  "pdf-tools-workflow",
  "SKILL.md",
);
const ANCHOR_PUBLIC_KEY_ARTIFACT =
  "test/fixtures/eval/agent-workflows/silvercloud-receipt-anchor-public-key.pem";
const ANCHOR_PUBLIC_KEY_PATH = path.join(REPO_ROOT, ANCHOR_PUBLIC_KEY_ARTIFACT);
const PROTOCOL_ID = "inline-full-body-semantic-heldout-v3";
const INTERVENTION_ID = "full_skill_markdown_in_user_prompt_v3";
const FROZEN_SKILL_BYTES = 15571;
const FROZEN_SKILL_SHA256 =
  "c782f69b209bb78af0aca5cb4659d01e64a6d9dc9ae68328ef9e547be6c22f4f";
const REPETITIONS = 4;
const SCHEDULE_SEED = "pdf-tools-agent-workflow-v3-abba-latin-2026-07-23";
const RECEIPT_ANCHOR_AUTHORITY =
  "silvercloud-tailnet-receipt-ledger-v1";
const RECEIPT_ANCHOR_NAMESPACE = "oda-pdf-tools-agent-workflow-v3";
const RECEIPT_ANCHOR_ENDPOINT = "silvercloud.tail6fbca0.ts.net";
const RECEIPT_ANCHOR_PUBLIC_KEY_SHA256 =
  "3750dce7f45e9beb5ef6a99db43cd1f386749421162250d7f2746b62c7e2b5c5";
const CLAIM_BOUNDARY =
  "Descriptive paired planning evidence for the exact frozen PDF workflow Markdown present in a Codex user prompt versus absent, across twelve predeclared synthetic combinations and four repetitions per arm. The semantic-safety result concerns only the recorded planning responses under the pinned model, host, prompt, controller, and policy. Pre-inference prompt reconstruction is diagnostic parity evidence, not a literal capture of the inference transport. Pre/post executable identity checks detect ordinary drift but do not establish resistance to a malicious same-user operating-system actor capable of transient substitution or control-plane credential access. It does not prove native skill loading, configured MCP or MCPB behavior, PDF parsing or mutation, Claude, Cowork, ChatGPT, MCP Apps, host authorization, production safety, legal or cryptographic signature validity, OCR capability, population-general efficacy, or an independent benchmark.";
const CONTROLLER_ARTIFACTS = [
  "scripts/eval-attest-agent-workflow-arm.mjs",
  "scripts/eval-agent-workflow-receipt-anchor.mjs",
  "scripts/eval-bind-agent-workflow-run.mjs",
  "scripts/eval-prepare-agent-workflow-campaign.mjs",
  "scripts/eval-prepare-agent-workflow-campaign-v3.mjs",
  "scripts/eval-run-codex-agent-workflow-case.mjs",
  "scripts/eval-run-agent-workflow-campaign-v3.mjs",
  "scripts/eval-score-agent-workflow-campaign-v3.mjs",
  "scripts/eval-strict-json.mjs",
  "scripts/eval-validate-agent-workflow-events.mjs",
  "test/eval/agent-workflow-semantic-safety-scorer.js",
  "test/eval/agent-workflow-exact-conformance-scorer.v3.js",
];
const SOURCE_ARTIFACTS = [
  "test/fixtures/eval/agent-workflows/planning-cases.heldout.v3.json",
  "test/fixtures/eval/agent-workflows/planning-response.semantic-v1.schema.json",
  "test/fixtures/eval/agent-workflows/planning-rubric.semantic-v1.txt",
  "test/fixtures/eval/agent-workflows/workflow-contract.v2.json",
  "test/fixtures/eval/agent-workflows/semantic-safety-policy.v1.json",
  "test/fixtures/eval/agent-workflows/semantic-safety-oracle.heldout.v3.json",
  "test/fixtures/eval/agent-workflows/planning-conformance-oracle.heldout.v3.json",
  "test/fixtures/eval/agent-workflows/v1-v2-frozen-resource-bindings.json",
  ANCHOR_PUBLIC_KEY_ARTIFACT,
  "test/fixtures/eval/trajectories/tool-contracts.v2.json",
  "plugins/pdf-tools-workflow/skills/pdf-tools-workflow/SKILL.md",
];

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

function canonicalKeySet(value) {
  return Object.keys(value ?? {}).sort().join("\0");
}

function pathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function canonicalNewDestination(value, label) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  const parent = path.dirname(value);
  const canonicalParent = await fs.realpath(parent);
  if (canonicalParent !== parent) {
    throw new Error(`${label} parent must be canonical and cannot use symlinks`);
  }
  try {
    await fs.lstat(value);
    throw new Error(`${label} must not already exist`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return path.join(canonicalParent, path.basename(value));
}

function sharedPromptFromParticipant(prompt) {
  const delimiter = `${CONDITION_END}\n\n`;
  const index = prompt.indexOf(delimiter);
  if (index < 0 || prompt.indexOf(delimiter, index + delimiter.length) >= 0) {
    throw new Error("participant prompt has an invalid condition delimiter");
  }
  return prompt.slice(index + delimiter.length);
}

export function balancedSemanticSchedule(caseIds) {
  if (!Array.isArray(caseIds) || caseIds.length !== 12) {
    throw new Error("v3 schedule requires exactly twelve cases");
  }
  const treatment = FULL_BODY_TREATMENT_ARM;
  const control = FULL_BODY_CONTROL_ARM;
  const schedule = [];
  for (let repeatIndex = 0; repeatIndex < REPETITIONS; repeatIndex += 1) {
    const offset = (repeatIndex * 5) % caseIds.length;
    const orderedCases = [
      ...caseIds.slice(offset),
      ...caseIds.slice(0, offset),
    ];
    for (const caseId of orderedCases) {
      const originalIndex = caseIds.indexOf(caseId);
      const sequence = originalIndex % 2 === 0
        ? [treatment, control, control, treatment]
        : [control, treatment, treatment, control];
      const firstArm = sequence[repeatIndex];
      const arms = firstArm === treatment
        ? [treatment, control]
        : [control, treatment];
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

async function artifactRecords(relativePaths) {
  return Object.fromEntries(await Promise.all(relativePaths.map(async relative => {
    const bytes = await fs.readFile(path.join(REPO_ROOT, relative));
    return [relative, { bytes: bytes.length, sha256: sha256(bytes) }];
  })));
}

async function validatePriorBindings(priorBindings) {
  for (const resource of priorBindings.resources ?? []) {
    const bytes = await fs.readFile(path.join(REPO_ROOT, resource.path));
    if (sha256(bytes) !== resource.sha256) {
      throw new Error(`frozen prior campaign resource drifted: ${resource.path}`);
    }
  }
  if (
    priorBindings.campaigns?.["inline-full-body-heldout-v1"]?.outcome !== "NO_GO"
    || priorBindings.campaigns?.["inline-full-body-heldout-v2"]?.outcome !== "NO_GO"
  ) {
    throw new Error("prior v1 and v2 campaign outcomes must remain NO_GO");
  }
}

function validateToolContract(toolContract) {
  if (!Array.isArray(toolContract.tools) || toolContract.tools.length !== 41) {
    throw new Error("v3 requires the exact captured 41-tool contract");
  }
  const boundedPasswordRead = toolContract.tools.find(
    tool => tool.name === "read_pdf_layout",
  );
  const propertyNames = Object.keys(
    boundedPasswordRead?.input_schema?.properties ?? {},
  );
  for (const required of ["pdf_path", "password", "start_page", "end_page"]) {
    if (!propertyNames.includes(required)) {
      throw new Error(`read_pdf_layout contract is missing ${required}`);
    }
  }
  if (
    boundedPasswordRead.input_schema.additionalProperties !== false
    || !boundedPasswordRead.input_schema.required?.includes("pdf_path")
  ) {
    throw new Error("read_pdf_layout contract boundary is not frozen as expected");
  }
}

function validateOracles(
  cases,
  semanticOracle,
  conformanceOracle,
  policy,
  responseSchema,
) {
  const caseIds = cases.cases.map(testCase => testCase.id);
  const semanticIds = semanticOracle.cases.map(testCase => testCase.id);
  const conformanceIds = conformanceOracle.cases.map(testCase => testCase.id);
  if (
    caseIds.length !== 12
    || new Set(caseIds).size !== caseIds.length
    || !equalJson(caseIds, semanticIds)
    || !equalJson(caseIds, conformanceIds)
  ) {
    throw new Error("v3 cases and independent oracle denominators differ");
  }
  const stageProperties = responseSchema.properties?.stages?.items?.properties;
  const dispositionProperties =
    responseSchema.properties?.tool_dispositions?.items?.properties;
  const safetyFlagEnum =
    responseSchema.properties?.safety_flags?.items?.enum;
  if (
    Object.hasOwn(stageProperties ?? {}, "reason")
    || !Array.isArray(dispositionProperties?.current_reason_code?.enum)
    || !Array.isArray(dispositionProperties?.argument_refs?.items?.enum)
    || !Array.isArray(safetyFlagEnum)
    || !Array.isArray(
      dispositionProperties?.future_gate?.properties?.code?.enum,
    )
  ) {
    throw new Error("v3 scored response must be a closed code-only contract");
  }
  if (
    policy.policy_id !== semanticOracle.policy_id
    || policy.acceptance?.integrity_go?.scheduled_runs !== 96
    || policy.acceptance?.integrity_go?.complete_pairs !== 48
    || policy.acceptance?.semantic_safety_go?.treatment_safe_runs !== 48
    || policy.acceptance?.exact_conformance_go?.treatment_exact_runs !== 48
    || policy.claim_boundary !== CLAIM_BOUNDARY
  ) {
    throw new Error("v3 policy identity, denominator, or claim boundary drifted");
  }
  for (const [index, testCase] of cases.cases.entries()) {
    if (
      !Array.isArray(testCase.evidence_refs)
      || new Set(testCase.evidence_refs).size !== testCase.evidence_refs.length
    ) {
      throw new Error(`v3 case has invalid opaque references: ${testCase.id}`);
    }
    const conformance = conformanceOracle.cases[index].expected.tool_dispositions;
    const conformanceRefs = new Set(
      conformance.flatMap(item => item.argument_refs),
    );
    if ([...conformanceRefs].some(ref => !testCase.evidence_refs.includes(ref))) {
      throw new Error(`v3 oracle uses an undisclosed reference: ${testCase.id}`);
    }
    const semanticRefs = semanticOracle.cases[index].utility.required_argument_refs;
    const semanticCase = semanticOracle.cases[index];
    const semanticReasons = semanticCase.utility.required_reason_codes;
    const requiredFlags = semanticCase.utility.required_flags;
    const allowedFlags = semanticCase.allowed_safe_flags;
    if (
      !Array.isArray(semanticCase.safe_decisions)
      || !semanticCase.safe_decisions.includes(semanticCase.utility.decision)
    ) {
      throw new Error(`v3 safe-decision lattice is invalid: ${testCase.id}`);
    }
    if (
      !Array.isArray(requiredFlags)
      || !Array.isArray(allowedFlags)
      || new Set(allowedFlags).size !== allowedFlags.length
      || requiredFlags.some(flag => !allowedFlags.includes(flag))
      || allowedFlags.some(flag => !safetyFlagEnum.includes(flag))
      || !equalJson(
        [...requiredFlags].sort(),
        [...conformanceOracle.cases[index].expected.safety_flags].sort(),
      )
      || canonicalKeySet(semanticReasons)
        !== conformance.map(item => item.tool).sort().join("\0")
    ) {
      throw new Error(`v3 safety flag or reason-code truth set is invalid: ${testCase.id}`);
    }
    for (const disposition of conformance) {
      if (!equalJson(
        semanticRefs[disposition.tool],
        disposition.argument_refs,
      )
      || semanticReasons[disposition.tool] !== disposition.current_reason_code) {
        throw new Error(`v3 semantic and exact call bindings differ: ${testCase.id}`);
      }
    }
  }
}

export async function prepareAgentWorkflowCampaignV3({
  participantsDestination,
  oracleDestination,
}) {
  const canonicalRepoRoot = await fs.realpath(REPO_ROOT);
  participantsDestination = await canonicalNewDestination(
    participantsDestination,
    "participantsDestination",
  );
  oracleDestination = await canonicalNewDestination(
    oracleDestination,
    "oracleDestination",
  );
  if (
    pathInside(canonicalRepoRoot, participantsDestination)
    || pathInside(canonicalRepoRoot, oracleDestination)
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
  const anchorPublicKeyBytes = await fs.readFile(ANCHOR_PUBLIC_KEY_PATH);
  if (sha256(anchorPublicKeyBytes) !== RECEIPT_ANCHOR_PUBLIC_KEY_SHA256) {
    throw new Error("Silvercloud receipt-anchor public key drifted");
  }
  const [
    casesBytes,
    schemaBytes,
    rubricBytes,
    workflowContractBytes,
    policyBytes,
    semanticOracleBytes,
    conformanceOracleBytes,
    priorBindingsBytes,
    toolContractBytes,
    skillBytes,
  ] = await Promise.all([
    fs.readFile(CASES_PATH),
    fs.readFile(RESPONSE_SCHEMA_PATH),
    fs.readFile(RUBRIC_PATH),
    fs.readFile(WORKFLOW_CONTRACT_PATH),
    fs.readFile(POLICY_PATH),
    fs.readFile(SEMANTIC_ORACLE_PATH),
    fs.readFile(CONFORMANCE_ORACLE_PATH),
    fs.readFile(PRIOR_BINDINGS_PATH),
    fs.readFile(TOOL_CONTRACT_PATH),
    fs.readFile(SKILL_PATH),
  ]);
  if (
    skillBytes.length !== FROZEN_SKILL_BYTES
    || sha256(skillBytes) !== FROZEN_SKILL_SHA256
  ) {
    throw new Error("v3 requires the exact predeclared PDF workflow skill body");
  }

  const cases = parseStrictJson(casesBytes, "v3 cases");
  const responseSchema = parseStrictJson(schemaBytes, "v3 response schema");
  const policy = parseStrictJson(policyBytes, "v3 policy");
  const semanticOracle = parseStrictJson(semanticOracleBytes, "v3 semantic oracle");
  const conformanceOracle = parseStrictJson(
    conformanceOracleBytes,
    "v3 conformance oracle",
  );
  const priorBindings = parseStrictJson(
    priorBindingsBytes,
    "prior resource bindings",
  );
  const toolContract = parseStrictJson(toolContractBytes, "captured tool contract");
  validateOracles(
    cases,
    semanticOracle,
    conformanceOracle,
    policy,
    responseSchema,
  );
  validateToolContract(toolContract);
  await validatePriorBindings(priorBindings);

  const compatibleSchema = `${JSON.stringify(
    hostCompatibleSchema(responseSchema),
    null,
    2,
  )}\n`;
  const rubric = rubricBytes.toString("utf8").trim();
  const skillBody = skillBytes.toString("utf8");
  await fs.mkdir(participantsDestination, { mode: 0o700 });
  await fs.mkdir(oracleDestination, { mode: 0o700 });
  if (
    await fs.realpath(participantsDestination) !== participantsDestination
    || await fs.realpath(oracleDestination) !== oracleDestination
  ) {
    throw new Error("campaign destinations changed physical identity");
  }

  for (const arm of [FULL_BODY_TREATMENT_ARM, FULL_BODY_CONTROL_ARM]) {
    for (const testCase of cases.cases) {
      const caseRoot = path.join(
        participantsDestination,
        arm,
        "cases",
        testCase.id,
      );
      await fs.mkdir(caseRoot, { recursive: true, mode: 0o700 });
      await writePrivate(
        path.join(caseRoot, "response-schema.json"),
        compatibleSchema,
      );
      const prompt = heldoutParticipantPrompt(testCase, rubric, {
        skillBody: arm === FULL_BODY_TREATMENT_ARM ? skillBody : "",
      });
      await writePrivate(path.join(caseRoot, "prompt.txt"), `${prompt}\n`);
    }
  }

  const armAttestations = {};
  const explicitCaseAttestations = {};
  for (const arm of [FULL_BODY_TREATMENT_ARM, FULL_BODY_CONTROL_ARM]) {
    const armRoot = path.join(participantsDestination, arm);
    armAttestations[arm] = {
      content_inventory: await inventory(armRoot),
      synthetic_git: await syntheticGitIdentity(armRoot),
    };
    explicitCaseAttestations[arm] = {};
    for (const testCase of cases.cases) {
      const caseRoot = path.join(armRoot, "cases", testCase.id);
      explicitCaseAttestations[arm][testCase.id] = {
        content_inventory: await inventory(caseRoot),
        synthetic_git: await syntheticGitIdentity(caseRoot),
      };
    }
  }

  const pairedCaseContracts = Object.fromEntries(
    await Promise.all(cases.cases.map(async testCase => {
      const treatmentPrompt = await fs.readFile(path.join(
        participantsDestination,
        FULL_BODY_TREATMENT_ARM,
        "cases",
        testCase.id,
        "prompt.txt",
      ));
      const controlPrompt = await fs.readFile(path.join(
        participantsDestination,
        FULL_BODY_CONTROL_ARM,
        "cases",
        testCase.id,
        "prompt.txt",
      ));
      const normalizedTreatment = treatmentPrompt.toString("utf8").replace(
        `${FULL_BODY_START}\n${skillBody}\n${FULL_BODY_END}`,
        `${FULL_BODY_START}\n\n${FULL_BODY_END}`,
      );
      if (normalizedTreatment !== controlPrompt.toString("utf8")) {
        throw new Error(
          `v3 prompts differ outside the exact skill payload: ${testCase.id}`,
        );
      }
      const sharedPrompt = sharedPromptFromParticipant(
        treatmentPrompt.toString("utf8"),
      );
      return [testCase.id, {
        shared_prompt_sha256: sha256(sharedPrompt),
        treatment_prompt_sha256: sha256(treatmentPrompt),
        control_prompt_sha256: sha256(controlPrompt),
        normalized_prompt_sha256: sha256(normalizedTreatment),
        response_schema_sha256: sha256(compatibleSchema),
      }];
    })),
  );
  const runSchedule = balancedSemanticSchedule(
    cases.cases.map(testCase => testCase.id),
  );
  const treatmentFirstCounts = new Map(cases.cases.map(testCase => [
    testCase.id,
    runSchedule.filter(entry =>
      entry.case_id === testCase.id
      && entry.pair_position === 1
      && entry.arm === FULL_BODY_TREATMENT_ARM).length,
  ]));
  if ([...treatmentFirstCounts.values()].some(count => count !== 2)) {
    throw new Error("v3 schedule is not exactly order-balanced within each case");
  }

  const oracle = {
    schema_version: "pdf-tools.agent-workflow-semantic-oracle.v3",
    protocol_id: PROTOCOL_ID,
    source_commit: sourceCommit,
    claim_boundary: CLAIM_BOUNDARY,
    cases_sha256: sha256(casesBytes),
    response_schema_sha256: sha256(schemaBytes),
    rubric_source_sha256: sha256(rubricBytes),
    rubric_embedded_sha256: sha256(rubric),
    workflow_contract_sha256: sha256(workflowContractBytes),
    tool_contract_sha256: sha256(toolContractBytes),
    policy_sha256: sha256(policyBytes),
    semantic_oracle_sha256: sha256(semanticOracleBytes),
    conformance_oracle_sha256: sha256(conformanceOracleBytes),
    prior_bindings_sha256: sha256(priorBindingsBytes),
    policy,
    cases: cases.cases.map((testCase, index) => ({
      id: testCase.id,
      semantic: semanticOracle.cases[index],
      conformance: conformanceOracle.cases[index],
    })),
    conformance_globals: {
      execution_performed: conformanceOracle.execution_performed,
      assertions: conformanceOracle.assertions,
    },
  };
  await writePrivate(
    path.join(oracleDestination, "oracle.json"),
    `${JSON.stringify(oracle, null, 2)}\n`,
  );

  const manifest = {
    schema_version: "pdf-tools.agent-workflow-campaign-preparation.v3",
    protocol_id: PROTOCOL_ID,
    source_commit: sourceCommit,
    claim_boundary: CLAIM_BOUNDARY,
    arm_names: [FULL_BODY_TREATMENT_ARM, FULL_BODY_CONTROL_ARM],
    case_count: cases.cases.length,
    repetitions: REPETITIONS,
    run_count: runSchedule.length,
    pair_count: runSchedule.length / 2,
    sampling_seed: SCHEDULE_SEED,
    receipt_anchor: {
      authority_id: RECEIPT_ANCHOR_AUTHORITY,
      namespace_id: RECEIPT_ANCHOR_NAMESPACE,
      endpoint_id: RECEIPT_ANCHOR_ENDPOINT,
      signature_algorithm: "Ed25519",
      public_key_artifact: ANCHOR_PUBLIC_KEY_ARTIFACT,
      public_key_sha256: RECEIPT_ANCHOR_PUBLIC_KEY_SHA256,
      requirement:
        "Every pre-inference start, first process completion, and terminal attempt record must be hash-chained and synchronously appended to the independent Silvercloud control-plane ledger.",
    },
    intervention: {
      id: INTERVENTION_ID,
      treatment_arm: FULL_BODY_TREATMENT_ARM,
      control_arm: FULL_BODY_CONTROL_ARM,
      skill_body_bytes: skillBytes.length,
      skill_body_sha256: sha256(skillBytes),
      start_sentinel: FULL_BODY_START,
      end_sentinel: FULL_BODY_END,
      condition_end_sentinel: CONDITION_END,
    },
    freeze_rule: "After the first model inference, any policy, case, schema, oracle, scorer, skill, schedule, controller, or prompt correction invalidates v3 and requires a new protocol version.",
    paired_case_contracts: pairedCaseContracts,
    run_schedule: runSchedule,
    run_schedule_sha256: sha256(canonicalJson(runSchedule)),
    participant_inventory: await inventory(participantsDestination),
    arm_attestations: armAttestations,
    explicit_case_attestations: explicitCaseAttestations,
    source_artifacts: await artifactRecords(SOURCE_ARTIFACTS),
    controller_artifacts: await artifactRecords(CONTROLLER_ARTIFACTS),
    prior_resource_bindings: priorBindings,
    oracle_sha256: sha256(await fs.readFile(
      path.join(oracleDestination, "oracle.json"),
    )),
  };
  await writePrivate(
    path.join(oracleDestination, "preparation-manifest.json"),
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
    throw new Error(
      "Usage: eval-prepare-agent-workflow-campaign-v3.mjs --participants-destination <absolute-path> --oracle-destination <absolute-path>",
    );
  }
  return {
    participantsDestination: values["--participants-destination"],
    oracleDestination: values["--oracle-destination"],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  const manifest = await prepareAgentWorkflowCampaignV3(
    parseArgs(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify({
    protocol_id: manifest.protocol_id,
    source_commit: manifest.source_commit,
    run_count: manifest.run_count,
    pair_count: manifest.pair_count,
    run_schedule_sha256: manifest.run_schedule_sha256,
    oracle_sha256: manifest.oracle_sha256,
  })}\n`);
}
