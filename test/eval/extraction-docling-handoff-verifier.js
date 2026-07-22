import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const EXPECTED_ROLES = new Set([
  "adapter_entrypoint", "model_setup_helper", "candidate_config", "candidate_config_schema",
  "candidate_request_schema", "candidate_response_schema", "handoff_schema",
  "handoff_generator_source", "handoff_verifier_source", "handoff_verifier_cli", "direct_requirements",
  "runtime_evidence_source",
]);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readStableRegular(filename, maxBytes, expectedMode = null) {
  if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("Docling handoff verification requires O_NOFOLLOW support");
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maxBytes)
      || (expectedMode !== null && Number(before.mode & 0o777n) !== expectedMode)) {
      throw new Error(`Docling handoff input violates its file contract: ${filename}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    for (const property of ["dev", "ino", "nlink", "size", "mtimeNs", "ctimeNs"]) {
      if (String(before[property]) !== String(after[property])) throw new Error(`Docling handoff input changed while read: ${filename}`);
    }
    if (BigInt(bytes.length) !== before.size) throw new Error(`Docling handoff input length changed while read: ${filename}`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function assertExactRecordSet(records, label) {
  if (!Array.isArray(records) || records.length < 1) throw new Error(`${label} must be a nonempty inventory`);
  const roles = new Set();
  const filenames = new Set();
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)
      || canonicalJson(Object.keys(record).sort()) !== canonicalJson(["bytes", "filename", "role", "sha256"])
      || typeof record.role !== "string" || roles.has(record.role)
      || typeof record.filename !== "string" || path.basename(record.filename) !== record.filename || filenames.has(record.filename)
      || !Number.isInteger(record.bytes) || record.bytes < 1 || !SHA256.test(record.sha256)) {
      throw new Error(`${label} contains an invalid or duplicate record`);
    }
    roles.add(record.role);
    filenames.add(record.filename);
  }
  if (records.length !== EXPECTED_ROLES.size || roles.size !== EXPECTED_ROLES.size
    || [...EXPECTED_ROLES].some(role => !roles.has(role))) {
    throw new Error(`${label} does not contain the exact required role set`);
  }
  return records;
}

function byRole(records, role) {
  const record = records.find(item => item.role === role);
  if (!record) throw new Error(`Docling retained input inventory is missing ${role}`);
  return record;
}

function normalizedRecipeFromReceipt(receipt, inputRecords, receiptPath) {
  const snapshot = receipt.roots.sidecar_snapshot;
  const input = role => path.join(snapshot, byRole(inputRecords, role).filename);
  const python = path.join(snapshot, "venv", "bin", "python");
  const configSha = byRole(inputRecords, "candidate_config").sha256;
  const normalizedPreflight = ["$TRUSTED_NODE", "$TRUSTED_VERIFIER", "--receipt", "$RECEIPT", "--expected-receipt-sha256", "$OUT_OF_BAND_RECEIPT_SHA256"];
  const expectedPreflight = [process.execPath, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/eval-verify-docling-macos-handoff.mjs"), "--receipt", receiptPath, "--expected-receipt-sha256", "$OUT_OF_BAND_RECEIPT_SHA256"];
  const expectedSetup = [
    [receipt.toolchain.uv.path, "python", "install", "3.12.13"],
    [receipt.toolchain.uv.path, "venv", "--python", "3.12.13", path.join(snapshot, "venv")],
    [receipt.toolchain.uv.path, "pip", "compile", input("direct_requirements"), "--python", python, "--generate-hashes", "--output-file", path.join(snapshot, "requirements.lock")],
    [receipt.toolchain.uv.path, "pip", "sync", path.join(snapshot, "requirements.lock"), "--python", python, "--require-hashes"],
    [python, input("model_setup_helper"), "--config", input("candidate_config"), "--expected-config-sha256", configSha, "--models-path", receipt.roots.models],
  ];
  const expectedExecution = [python, input("adapter_entrypoint"), "--config", input("candidate_config"), "--artifacts-path", receipt.roots.models, "--receipt", receiptPath, "--expected-receipt-sha256", "$OUT_OF_BAND_RECEIPT_SHA256"];
  if (canonicalJson(receipt.setup.preflight_command) !== canonicalJson(expectedPreflight)
    || canonicalJson(receipt.execution.preflight_command) !== canonicalJson(expectedPreflight)
    || canonicalJson(receipt.setup.commands) !== canonicalJson(expectedSetup)
    || canonicalJson(receipt.execution.command_template) !== canonicalJson(expectedExecution)) {
    throw new Error("Docling realized commands do not match the handoff contract");
  }
  return {
    setup: {
      network_required: true,
      environment: { UV_CACHE_DIR: "$UV_CACHE_ROOT", UV_PYTHON_INSTALL_DIR: "$UV_PYTHON_INSTALL_ROOT", PYTHONDONTWRITEBYTECODE: "1" },
      preflight: normalizedPreflight,
      commands: [
        ["$UV", "python", "install", "3.12.13"],
        ["$UV", "venv", "--python", "3.12.13", "$VENV_ROOT"],
        ["$UV", "pip", "compile", "$DIRECT_REQUIREMENTS", "--python", "$PYTHON", "--generate-hashes", "--output-file", "$LOCK"],
        ["$UV", "pip", "sync", "$LOCK", "--python", "$PYTHON", "--require-hashes"],
        ["$PYTHON", "$MODEL_SETUP_HELPER", "--config", "$CONFIG", "--expected-config-sha256", "$CONFIG_SHA256", "--models-path", "$MODELS_ROOT"],
      ],
    },
    execution: {
      offline_intent: true,
      network_isolation_enforced: false,
      environment: {
        HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_DATASETS_OFFLINE: "1",
        UV_CACHE_DIR: "$UV_CACHE_ROOT", UV_PYTHON_INSTALL_DIR: "$UV_PYTHON_INSTALL_ROOT", PYTHONDONTWRITEBYTECODE: "1",
      },
      preflight: normalizedPreflight,
      command: ["$PYTHON", "$ADAPTER", "--config", "$CONFIG", "--artifacts-path", "$MODELS_ROOT", "--receipt", "$RECEIPT", "--expected-receipt-sha256", "$OUT_OF_BAND_RECEIPT_SHA256"],
    },
  };
}

export function computeDoclingHandoffId(identity) {
  return sha256(Buffer.from(`pdf-tools.docling-macos-handoff.v1\0${canonicalJson(identity)}`));
}

export async function verifyDoclingHandoff({ receiptPath, expectedReceiptSha256, trustedSchemaPath }) {
  if (!SHA256.test(expectedReceiptSha256 ?? "")) throw new Error("Out-of-band Docling receipt SHA-256 is required");
  const [receiptBytes, schemaBytes] = await Promise.all([
    readStableRegular(receiptPath, MAX_RECEIPT_BYTES, 0o600),
    readStableRegular(trustedSchemaPath, MAX_RECEIPT_BYTES),
  ]);
  if (sha256(receiptBytes) !== expectedReceiptSha256) throw new Error("Docling receipt does not match the out-of-band SHA-256");
  const receipt = JSON.parse(receiptBytes);
  if (!receiptBytes.equals(Buffer.from(`${canonicalJson(receipt)}\n`))) throw new Error("Docling receipt bytes are not canonical");
  const schema = JSON.parse(schemaBytes);
  const validation = new AjvJsonSchemaValidator().getValidator(schema)(receipt);
  if (!validation.valid) throw new Error(`Invalid Docling handoff receipt: ${validation.errorMessage}`);
  if (computeDoclingHandoffId(receipt.identity) !== receipt.handoff_id) throw new Error("Docling handoff identity digest mismatch");
  const inputRecords = assertExactRecordSet(receipt.inputs, "Docling retained input inventory");
  if (canonicalJson(receipt.identity.inputs) !== canonicalJson(inputRecords)) throw new Error("Docling identity does not bind the retained input inventory");
  if (canonicalJson(receipt.identity.fixtures) !== canonicalJson(receipt.fixtures)) throw new Error("Docling identity does not bind the retained fixture inventory");
  if (canonicalJson(receipt.identity.recipe) !== canonicalJson(normalizedRecipeFromReceipt(receipt, inputRecords, path.resolve(receiptPath)))) {
    throw new Error("Docling identity does not bind the realized setup and execution recipe");
  }

  const snapshotRoot = await fs.realpath(receipt.roots.sidecar_snapshot);
  const snapshotMetadata = await fs.lstat(snapshotRoot);
  if (!snapshotMetadata.isDirectory() || snapshotMetadata.isSymbolicLink() || (snapshotMetadata.mode & 0o777) !== 0o700) {
    throw new Error("Docling snapshot root is not a real mode-0700 directory");
  }
  for (const record of inputRecords) {
    const bytes = await readStableRegular(path.join(snapshotRoot, record.filename), MAX_INPUT_BYTES, 0o600);
    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) throw new Error(`Docling retained input mismatch: ${record.role}`);
  }
  const fixtureRoot = path.join(path.dirname(receiptPath), "fixtures");
  const fixtureMetadata = await fs.lstat(fixtureRoot);
  if (!fixtureMetadata.isDirectory() || fixtureMetadata.isSymbolicLink() || (fixtureMetadata.mode & 0o777) !== 0o700) {
    throw new Error("Docling fixture root is not a real mode-0700 directory");
  }
  for (const fixture of receipt.fixtures) {
    const bytes = await readStableRegular(path.join(fixtureRoot, fixture.filename), 8 * 1024 * 1024, 0o600);
    if (bytes.length !== fixture.bytes || sha256(bytes) !== fixture.sha256) throw new Error(`Docling retained fixture mismatch: ${fixture.ordinal}`);
  }
  const fixtureNames = (await fs.readdir(fixtureRoot)).sort();
  if (canonicalJson(fixtureNames) !== canonicalJson(receipt.fixtures.map(item => item.filename).sort())) {
    throw new Error("Docling fixture directory contains files outside the anchored inventory");
  }
  const uvBytes = await readStableRegular(receipt.toolchain.uv.path, MAX_INPUT_BYTES);
  if (uvBytes.length !== receipt.toolchain.uv.bytes || sha256(uvBytes) !== receipt.toolchain.uv.sha256) {
    throw new Error("Docling uv binary no longer matches the anchored toolchain identity");
  }
  const uvVersion = spawnSync(receipt.toolchain.uv.path, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (uvVersion.error || uvVersion.status !== 0 || uvVersion.stdout.trim() !== receipt.toolchain.uv.version) {
    throw new Error("Docling uv version no longer matches the anchored toolchain identity");
  }
  return { receipt, receipt_sha256: expectedReceiptSha256 };
}
