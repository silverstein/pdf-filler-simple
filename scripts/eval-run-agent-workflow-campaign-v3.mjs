#!/usr/bin/env node

import {
  createHash,
  createPublicKey,
  verify,
} from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bindAgentWorkflowRun,
} from "./eval-bind-agent-workflow-run.mjs";
import {
  verifiedSourceCommit,
} from "./eval-prepare-agent-workflow-campaign.mjs";
import {
  balancedSemanticSchedule,
  prepareAgentWorkflowCampaignV3,
} from "./eval-prepare-agent-workflow-campaign-v3.mjs";
import {
  runCodexAgentWorkflowCase,
} from "./eval-run-codex-agent-workflow-case.mjs";
import { parseStrictJson } from "./eval-strict-json.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const PROTOCOL_ID = "inline-full-body-semantic-heldout-v3";

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

function pathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function requirePrivateFile(filename, label) {
  if (
    !path.isAbsolute(filename)
    || path.resolve(filename) !== filename
    || await fs.realpath(filename) !== filename
  ) {
    throw new Error(`${label} must be a canonical absolute file`);
  }
  const stat = await fs.lstat(filename);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || (stat.mode & 0o077) !== 0
  ) {
    throw new Error(`${label} must be a private single-link regular file`);
  }
}

async function readPrivateFileOnce(filename, label) {
  const handle = await fs.open(
    filename,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile()
      || stat.nlink !== 1
      || (stat.mode & 0o077) !== 0
    ) {
      throw new Error(`${label} must be a private single-link regular file`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function requireCanonicalExecutable(filename, label) {
  if (
    !path.isAbsolute(filename)
    || path.resolve(filename) !== filename
    || await fs.realpath(filename) !== filename
  ) {
    throw new Error(`${label} must be a canonical absolute executable`);
  }
  const stat = await fs.lstat(filename);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || (stat.mode & 0o111) === 0
  ) {
    throw new Error(`${label} must be an executable regular file`);
  }
}

async function requireCanonicalDirectory(value, label) {
  if (
    !path.isAbsolute(value)
    || path.resolve(value) !== value
    || await fs.realpath(value) !== value
  ) {
    throw new Error(`${label} must be a canonical absolute directory`);
  }
  const stat = await fs.lstat(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a physical directory`);
  }
}

async function createCanonicalDirectory(value, label) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  const parent = path.dirname(value);
  if (await fs.realpath(parent) !== parent) {
    throw new Error(`${label} parent must be canonical`);
  }
  await fs.mkdir(value, { mode: 0o700 });
  if (await fs.realpath(value) !== value) {
    throw new Error(`${label} changed physical identity`);
  }
}

async function requireNewFilePath(value, label) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  if (await fs.realpath(path.dirname(value)) !== path.dirname(value)) {
    throw new Error(`${label} parent must be canonical`);
  }
  try {
    await fs.lstat(value);
    throw new Error(`${label} must not exist`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function writePrivateBytes(filename, bytes) {
  const handle = await fs.open(filename, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function runCommand(command, stdin = null) {
  if (
    typeof command?.program !== "string"
    || !path.isAbsolute(command.program)
    || !Array.isArray(command.argv)
    || command.argv.some(value => typeof value !== "string")
  ) {
    throw new Error("anchor command must use an absolute program and string argv");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command.program, command.argv, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null) {
        reject(new Error(
          `receipt anchor command failed: ${Buffer.concat(stderr).toString("utf8").trim()}`,
        ));
        return;
      }
      resolve(Buffer.concat(stdout));
    });
    child.stdin.end(stdin);
  });
}

function receiptHash(record) {
  return sha256(canonicalJson(record));
}

function unsignedEnvelope(value) {
  const copy = structuredClone(value);
  delete copy.signature_algorithm;
  delete copy.public_key_sha256;
  delete copy.signature_base64;
  return copy;
}

function verifyAnchorEnvelope(value, publicKey, publicKeySha256) {
  return value?.signature_algorithm === "Ed25519"
    && value?.public_key_sha256 === publicKeySha256
    && typeof value?.signature_base64 === "string"
    && verify(
      null,
      Buffer.from(canonicalJson(unsignedEnvelope(value))),
      publicKey,
      Buffer.from(value.signature_base64, "base64"),
    );
}

async function artifactRecords(relativeRecords) {
  for (const [relative, expected] of Object.entries(relativeRecords)) {
    const bytes = await fs.readFile(path.join(REPO_ROOT, relative));
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) {
      throw new Error(`frozen campaign artifact drifted: ${relative}`);
    }
  }
}

async function rederiveFrozenCampaign(preparationBytes, oracleBytes) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-v3-run-preflight-")),
  );
  try {
    const oracleDestination = path.join(root, "oracle");
    await prepareAgentWorkflowCampaignV3({
      participantsDestination: path.join(root, "participants"),
      oracleDestination,
    });
    const [derivedPreparation, derivedOracle] = await Promise.all([
      fs.readFile(path.join(oracleDestination, "preparation-manifest.json")),
      fs.readFile(path.join(oracleDestination, "oracle.json")),
    ]);
    if (
      !derivedPreparation.equals(preparationBytes)
      || !derivedOracle.equals(oracleBytes)
    ) {
      throw new Error(
        "campaign preparation or oracle differs from deterministic source derivation",
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function runAgentWorkflowCampaignV3({
  participantsRoot,
  preparationManifestPath,
  oraclePath,
  resultsRoot,
  runtimeRoot,
  homesRoot,
  promptCaptureHomesRoot,
  authSourcePath,
  codexBinary,
  sandboxBinary,
  model,
  receiptLedgerPath,
  anchorAckLedgerPath,
  anchorExportPath,
  anchorCommandConfigPath,
}) {
  for (const [value, label] of [
    [participantsRoot, "participantsRoot"],
    [resultsRoot, "resultsRoot"],
    [runtimeRoot, "runtimeRoot"],
    [homesRoot, "homesRoot"],
    [promptCaptureHomesRoot, "promptCaptureHomesRoot"],
  ]) {
    if (label === "participantsRoot") await requireCanonicalDirectory(value, label);
    else await createCanonicalDirectory(value, label);
  }
  for (const [value, label] of [
    [preparationManifestPath, "preparationManifestPath"],
    [oraclePath, "oraclePath"],
    [authSourcePath, "authSourcePath"],
    [anchorCommandConfigPath, "anchorCommandConfigPath"],
  ]) {
    await requirePrivateFile(value, label);
  }
  for (const [value, label] of [
    [receiptLedgerPath, "receiptLedgerPath"],
    [anchorAckLedgerPath, "anchorAckLedgerPath"],
    [anchorExportPath, "anchorExportPath"],
  ]) {
    await requireNewFilePath(value, label);
  }
  const campaignRoots = [
    participantsRoot,
    resultsRoot,
    runtimeRoot,
    homesRoot,
    promptCaptureHomesRoot,
  ];
  for (const [index, left] of campaignRoots.entries()) {
    for (const right of campaignRoots.slice(index + 1)) {
      if (pathInside(left, right) || pathInside(right, left)) {
        throw new Error("campaign roots must be physically disjoint");
      }
    }
  }
  if (
    campaignRoots.some(root =>
      pathInside(root, receiptLedgerPath)
      || pathInside(root, anchorAckLedgerPath)
      || pathInside(root, anchorExportPath))
  ) {
    throw new Error("receipt evidence must remain outside campaign roots");
  }
  if (
    typeof model !== "string"
    || model.trim().length === 0
    || !path.isAbsolute(codexBinary)
    || !path.isAbsolute(sandboxBinary)
  ) {
    throw new Error("model and campaign executables must be explicit");
  }
  await Promise.all([
    requireCanonicalExecutable(codexBinary, "codexBinary"),
    requireCanonicalExecutable(sandboxBinary, "sandboxBinary"),
  ]);

  const [preparationBytes, oracleBytes, anchorConfigBytes] = await Promise.all([
    fs.readFile(preparationManifestPath),
    fs.readFile(oraclePath),
    fs.readFile(anchorCommandConfigPath),
  ]);
  const preparation = parseStrictJson(preparationBytes, "preparation manifest");
  const oracle = parseStrictJson(oracleBytes, "oracle");
  const anchorConfig = parseStrictJson(anchorConfigBytes, "anchor command config");
  const anchorPublicKeyBytes = await fs.readFile(path.join(
    REPO_ROOT,
    preparation.receipt_anchor?.public_key_artifact ?? "",
  ));
  const anchorPublicKeySha256 = sha256(anchorPublicKeyBytes);
  const anchorPublicKey = createPublicKey(anchorPublicKeyBytes);
  const authSourceBytes = await readPrivateFileOnce(
    authSourcePath,
    "authSourcePath",
  );
  const authSourceSha256 = sha256(authSourceBytes);
  if (
    preparation.protocol_id !== PROTOCOL_ID
    || oracle.protocol_id !== PROTOCOL_ID
    || sha256(oracleBytes) !== preparation.oracle_sha256
    || preparation.source_commit !== await verifiedSourceCommit()
    || !equalJson(
      preparation.run_schedule,
      balancedSemanticSchedule(oracle.cases.map(testCase => testCase.id)),
    )
    || anchorConfig.schema_version
      !== "pdf-tools.agent-workflow-receipt-anchor-command.v1"
    || anchorConfig.authority_id !== preparation.receipt_anchor?.authority_id
    || anchorConfig.namespace_id !== preparation.receipt_anchor?.namespace_id
    || anchorConfig.endpoint_id !== preparation.receipt_anchor?.endpoint_id
    || anchorPublicKeySha256
      !== preparation.receipt_anchor?.public_key_sha256
  ) {
    throw new Error("campaign inputs are not the exact frozen v3 protocol");
  }
  await artifactRecords({
    ...preparation.source_artifacts,
    ...preparation.controller_artifacts,
  });
  await rederiveFrozenCampaign(preparationBytes, oracleBytes);

  const preparationSha256 = sha256(preparationBytes);
  const campaignId = `pdf-tools-v3-${preparationSha256.slice(0, 32)}`;
  const ledgerHandle = await fs.open(receiptLedgerPath, "ax", 0o600);
  const ackLedgerHandle = await fs.open(anchorAckLedgerPath, "ax", 0o600);
  let receiptOrdinal = 0;
  let previousRecordSha256 = null;
  async function appendReceipt(type, body) {
    const {
      schema_version: payloadSchemaVersion,
      ...payload
    } = body;
    for (const protectedField of [
      "campaign_id",
      "anchor_authority_id",
      "anchor_namespace_id",
      "receipt_ordinal",
      "previous_record_sha256",
      "record_sha256",
      "type",
    ]) {
      if (Object.hasOwn(payload, protectedField)) {
        throw new Error(`receipt payload cannot override ${protectedField}`);
      }
    }
    const unsigned = {
      schema_version: "pdf-tools.agent-workflow-receipt.v1",
      campaign_id: campaignId,
      anchor_authority_id: anchorConfig.authority_id,
      anchor_namespace_id: anchorConfig.namespace_id,
      receipt_ordinal: receiptOrdinal + 1,
      previous_record_sha256: previousRecordSha256,
      type,
      ...(payloadSchemaVersion === undefined
        ? {}
        : { payload_schema_version: payloadSchemaVersion }),
      ...payload,
    };
    const record = { ...unsigned, record_sha256: receiptHash(unsigned) };
    const recordText = `${JSON.stringify(record)}\n`;
    const ackBytes = await runCommand(anchorConfig.append, recordText);
    const ack = parseStrictJson(ackBytes, "anchor acknowledgement");
    if (
      ack.schema_version !== "pdf-tools.agent-workflow-anchor-ack.v2"
      || ack.authority_id !== anchorConfig.authority_id
      || ack.namespace_id !== anchorConfig.namespace_id
      || ack.campaign_id !== campaignId
      || ack.receipt_ordinal !== record.receipt_ordinal
      || ack.record_sha256 !== record.record_sha256
      || !verifyAnchorEnvelope(
        ack,
        anchorPublicKey,
        anchorPublicKeySha256,
      )
    ) {
      throw new Error("receipt anchor returned a mismatched acknowledgement");
    }
    await ledgerHandle.write(recordText);
    await ledgerHandle.sync();
    await ackLedgerHandle.write(`${JSON.stringify(ack)}\n`);
    await ackLedgerHandle.sync();
    receiptOrdinal = record.receipt_ordinal;
    previousRecordSha256 = record.record_sha256;
    return record;
  }

  try {
    await appendReceipt("campaign_header", {
      preparation_manifest_sha256: preparationSha256,
      oracle_sha256: sha256(oracleBytes),
      source_commit: preparation.source_commit,
      run_schedule_sha256: preparation.run_schedule_sha256,
      run_count: preparation.run_count,
      pair_count: preparation.pair_count,
      anchor_command_config_sha256: sha256(anchorConfigBytes),
      controller_artifacts_sha256: sha256(
        canonicalJson(preparation.controller_artifacts),
      ),
      auth_source_sha256: authSourceSha256,
    });
    await appendReceipt("campaign_started", {
      recorded_at: new Date().toISOString(),
      host: os.hostname(),
      model,
    });

    for (const scheduled of preparation.run_schedule) {
      await appendReceipt("attempt_started", {
        recorded_at: new Date().toISOString(),
        run_id: scheduled.run_id,
        schedule_ordinal: scheduled.ordinal,
        attempt_index: 1,
      });
      let processCompletion = null;
      let preInferenceReady = null;
      try {
        const caseRoot = path.join(runtimeRoot, scheduled.run_id);
        await fs.cp(
          path.join(
            participantsRoot,
            scheduled.arm,
            "cases",
            scheduled.case_id,
          ),
          caseRoot,
          { recursive: true, errorOnExist: true, force: false },
        );
        const codexHome = path.join(homesRoot, scheduled.run_id);
        const promptCaptureHome = path.join(
          promptCaptureHomesRoot,
          scheduled.run_id,
        );
        await Promise.all([
          fs.mkdir(codexHome, { mode: 0o700 }),
          fs.mkdir(promptCaptureHome, { mode: 0o700 }),
        ]);
        await Promise.all([
          writePrivateBytes(
            path.join(codexHome, "auth.json"),
            authSourceBytes,
          ),
          writePrivateBytes(
            path.join(promptCaptureHome, "auth.json"),
            authSourceBytes,
          ),
        ]);
        const runRoot = path.join(resultsRoot, scheduled.run_id);
        const expected =
          preparation.explicit_case_attestations[scheduled.arm][scheduled.case_id];
        await runCodexAgentWorkflowCase({
          arm: scheduled.arm,
          caseId: scheduled.case_id,
          caseRoot,
          resultsRoot: runRoot,
          codexHome,
          promptCaptureHome,
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
          model,
          runId: scheduled.run_id,
          scheduleOrdinal: scheduled.ordinal,
          repeatIndex: scheduled.repeat_index,
          pairId: scheduled.pair_id,
          pairPosition: scheduled.pair_position,
          scheduleSha256: preparation.run_schedule_sha256,
          expectedAuthSha256: authSourceSha256,
          onPreInferenceReady: async evidence => {
            preInferenceReady = await appendReceipt(
              "pre_inference_ready",
              evidence,
            );
          },
          onProcessComplete: async completion => {
            processCompletion = await appendReceipt(
              "process_completed",
              completion,
            );
          },
        });
        if (preInferenceReady === null || processCompletion === null) {
          throw new Error("pre-inference or model completion was not sealed");
        }
        const manifestPath = path.join(runRoot, "run-manifest.json");
        await bindAgentWorkflowRun({
          runRoot,
          preparationManifestPath,
          arm: scheduled.arm,
          caseId: scheduled.case_id,
          runId: scheduled.run_id,
          outputPath: manifestPath,
        });
        const manifestBytes = await fs.readFile(manifestPath);
        await appendReceipt("attempt_finished", {
          recorded_at: new Date().toISOString(),
          run_id: scheduled.run_id,
          schedule_ordinal: scheduled.ordinal,
          attempt_index: 1,
          run_manifest_sha256: sha256(manifestBytes),
          process_completion_record_sha256: processCompletion.record_sha256,
          pre_inference_record_sha256: preInferenceReady.record_sha256,
        });
      } catch (error) {
        await appendReceipt("attempt_failed", {
          recorded_at: new Date().toISOString(),
          run_id: scheduled.run_id,
          schedule_ordinal: scheduled.ordinal,
          attempt_index: 1,
          failure_code: "campaign_attempt_failed",
          pre_inference_record_sha256:
            preInferenceReady?.record_sha256 ?? null,
          process_completion_record_sha256:
            processCompletion?.record_sha256 ?? null,
        });
        throw error;
      }
    }
    await appendReceipt("campaign_finished", {
      recorded_at: new Date().toISOString(),
      completed_runs: preparation.run_count,
    });
  } finally {
    await Promise.all([ledgerHandle.close(), ackLedgerHandle.close()]);
  }

  const anchorExportBytes = await runCommand(anchorConfig.export);
  const anchorExport = parseStrictJson(
    anchorExportBytes,
    "signed anchor export",
  );
  const localLedger = await fs.readFile(receiptLedgerPath);
  if (
    anchorExport.schema_version
      !== "pdf-tools.agent-workflow-anchor-export.v2"
    || anchorExport.authority_id !== anchorConfig.authority_id
    || anchorExport.namespace_id !== anchorConfig.namespace_id
    || anchorExport.campaign_id !== campaignId
    || anchorExport.receipt_count !== receiptOrdinal
    || anchorExport.ledger_sha256 !== sha256(localLedger)
    || anchorExport.ledger_tip_sha256 !== previousRecordSha256
    || !verifyAnchorEnvelope(
      anchorExport,
      anchorPublicKey,
      anchorPublicKeySha256,
    )
  ) {
    throw new Error("signed external anchor export differs from local receipts");
  }
  await fs.writeFile(anchorExportPath, `${JSON.stringify(anchorExport)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return {
    campaign_id: campaignId,
    receipt_count: receiptOrdinal,
    receipt_ledger_sha256: sha256(localLedger),
    anchor_public_key_sha256: anchorPublicKeySha256,
    completed_runs: preparation.run_count,
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    values[argv[index]] = argv[index + 1];
  }
  const mapping = {
    participantsRoot: "--participants-root",
    preparationManifestPath: "--preparation-manifest",
    oraclePath: "--oracle",
    resultsRoot: "--results-root",
    runtimeRoot: "--runtime-root",
    homesRoot: "--homes-root",
    promptCaptureHomesRoot: "--prompt-capture-homes-root",
    authSourcePath: "--auth-source",
    codexBinary: "--codex-binary",
    sandboxBinary: "--sandbox-binary",
    model: "--model",
    receiptLedgerPath: "--receipt-ledger",
    anchorAckLedgerPath: "--anchor-ack-ledger",
    anchorExportPath: "--anchor-export",
    anchorCommandConfigPath: "--anchor-command-config",
  };
  const result = {};
  for (const [key, flag] of Object.entries(mapping)) {
    if (!values[flag]) throw new Error(`Missing required argument: ${flag}`);
    result[key] = values[flag];
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  const result = await runAgentWorkflowCampaignV3(
    parseArgs(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
