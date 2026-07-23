#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const REQUIRED_OPTIONS = [
  "--finalization",
  "--finalization-sha256",
  "--manifest",
  "--manifest-sha256",
  "--output",
  "--protected-roots-json",
  "--receipt",
  "--receipt-sha256",
  "--receipt-schema",
  "--receipt-schema-sha256",
];

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactOptions(argv) {
  if (argv.length !== REQUIRED_OPTIONS.length * 2) {
    throw new Error(`Expected exactly: ${REQUIRED_OPTIONS.join(", ")}`);
  }
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!REQUIRED_OPTIONS.includes(name) || Object.hasOwn(values, name) || !value) {
      throw new Error(`Unknown, duplicate, or empty option: ${name}`);
    }
    values[name] = value;
  }
  return values;
}

async function canonicalDirectory(filename, label, requiredMode = null) {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  const [real, metadata] = await Promise.all([fs.realpath(filename), fs.lstat(filename)]);
  if (real !== filename || !metadata.isDirectory() || metadata.isSymbolicLink()
    || (requiredMode !== null && (metadata.mode & 0o777) !== requiredMode)) {
    throw new Error(`${label} must be a canonical regular directory`);
  }
  return filename;
}

async function stableFile(filename, maximumBytes, label, requiredMode = null) {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename || typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error(`${label} path or runtime support is invalid`);
  }
  if (await fs.realpath(filename) !== filename) throw new Error(`${label} must be a canonical regular file`);
  const pathnameBefore = await fs.lstat(filename, { bigint: true });
  const mode = Number(pathnameBefore.mode & 0o777n);
  if (!pathnameBefore.isFile() || pathnameBefore.isSymbolicLink() || pathnameBefore.nlink !== 1n
    || pathnameBefore.size < 1n || pathnameBefore.size > BigInt(maximumBytes)
    || (requiredMode !== null && mode !== requiredMode)) {
    throw new Error(`${label} violates its bounded regular-file contract`);
  }
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const descriptorBefore = await handle.stat({ bigint: true });
    const sameIdentity = (left, right) => ["dev", "ino", "nlink", "size", "mtimeNs", "ctimeNs"]
      .every(key => String(left[key]) === String(right[key]));
    if (!descriptorBefore.isFile() || !sameIdentity(pathnameBefore, descriptorBefore)) {
      throw new Error(`${label} pathname differs from its open descriptor`);
    }
    const bytes = await handle.readFile();
    const [descriptorAfter, pathnameAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.lstat(filename, { bigint: true }),
    ]);
    if (!sameIdentity(descriptorBefore, descriptorAfter) || !sameIdentity(descriptorBefore, pathnameAfter)
      || BigInt(bytes.length) !== descriptorBefore.size) {
      throw new Error(`${label} changed while read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseJson(bytes, label, { canonical = false } = {}) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not JSON: ${error.message}`);
  }
  if (canonical && !bytes.equals(Buffer.from(`${canonicalJson(value)}\n`))) {
    throw new Error(`${label} is not canonical newline-terminated JSON`);
  }
  return value;
}

function validateSchema(value, schema, label) {
  const validation = new AjvJsonSchemaValidator().getValidator(schema)(value);
  if (!validation.valid) throw new Error(`${label} schema validation failed: ${validation.errorMessage}`);
}

export function validateReceipt(receipt, schema) {
  validateSchema(receipt, schema, "Docling receipt");
  const identityDigest = sha256(Buffer.from(
    `pdf-tools.docling-macos-handoff.v1\0${canonicalJson(receipt.identity)}`,
  ));
  if (identityDigest !== receipt.handoff_id
    || canonicalJson(receipt.identity.inputs) !== canonicalJson(receipt.inputs)
    || canonicalJson(receipt.identity.fixtures) !== canonicalJson(receipt.fixtures)) {
    throw new Error("Docling receipt identity or retained inventories are invalid");
  }
  return receipt;
}

export function validateFinalization(finalization, schema, receipt, receiptSha256) {
  validateSchema(finalization, schema, "Docling finalization");
  const { finalization_id: finalizationId, ...core } = finalization;
  const expectedId = sha256(Buffer.from(`pdf-tools.docling-finalization.v1\0${canonicalJson(core)}`));
  if (finalizationId !== expectedId || finalization.handoff_id !== receipt.handoff_id
    || finalization.receipt_sha256 !== receiptSha256
    || finalization.execution_state !== "setup_complete_not_executed") {
    throw new Error("Docling finalization identity is invalid");
  }
  return finalization;
}

function recordByRole(receipt, role) {
  const matches = receipt.inputs.filter(record => record.role === role);
  if (matches.length !== 1) throw new Error(`Receipt must bind exactly one ${role} input`);
  return matches[0];
}

async function importRetainedModule(receipt, role) {
  const record = recordByRole(receipt, role);
  const filename = path.join(receipt.roots.sidecar_snapshot, record.filename);
  const bytes = await stableFile(filename, record.bytes, `retained ${role}`, 0o600);
  if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) {
    throw new Error(`Retained ${role} differs from its receipt identity`);
  }
  return {
    module: await import(`${pathToFileURL(filename).href}?sha256=${record.sha256}`),
    record,
    bytes,
  };
}

export async function createRetainedAuthorityVerifier({
  receipt,
  receiptPath,
  receiptSha256,
  protectedRootsJson,
}) {
  const verifierSource = await importRetainedModule(receipt, "handoff_verifier_source");
  const launcherRecord = recordByRole(receipt, "handoff_verifier_cli");
  const launcherPath = path.join(receipt.roots.sidecar_snapshot, launcherRecord.filename);
  const launcherBytes = await stableFile(
    launcherPath,
    launcherRecord.bytes,
    "retained handoff verifier CLI",
    0o600,
  );
  if (launcherBytes.length !== launcherRecord.bytes || sha256(launcherBytes) !== launcherRecord.sha256
    || typeof verifierSource.module.runDoclingAuthority !== "function") {
    throw new Error("Retained Docling authority launcher differs from its receipt identity");
  }
  const verify = async () => {
    const result = await verifierSource.module.runDoclingAuthority({
      receiptPath,
      expectedReceiptSha256: receiptSha256,
      protectedRootsJson,
      action: "verify",
      launcherPath,
    });
    const evidence = parseJson(result.stdout, "sealed authority verification");
    if (canonicalJson(Object.keys(evidence).sort()) !== canonicalJson(["handoff_id", "receipt_sha256", "verified"])
      || evidence.verified !== true || evidence.handoff_id !== receipt.handoff_id
      || evidence.receipt_sha256 !== receiptSha256) {
      throw new Error("Sealed Docling authority returned invalid verification evidence");
    }
    return evidence;
  };
  return { verify, verifierSource, launcherRecord, launcherPath, launcherBytes };
}

function protectedRootsBinding(value, receipt) {
  let roots;
  try {
    roots = JSON.parse(value);
  } catch {
    throw new Error("Protected roots are not JSON");
  }
  if (!Array.isArray(roots) || roots.length < 1 || new Set(roots).size !== roots.length
    || roots.some(root => typeof root !== "string" || !path.isAbsolute(root) || path.resolve(root) !== root)
    || canonicalJson([...roots].sort()) !== value
    || sha256(Buffer.from(`pdf-tools.docling-protected-roots.v1\0${value}`)) !== receipt.roots.protected_roots_sha256) {
    throw new Error("Protected roots do not match the receipt binding");
  }
  return value;
}

function fixtureBindings(manifest, receipt) {
  if (manifest?.suite_id !== "pdf-tools.extraction.phase0" || manifest.manifest_version !== 1
    || manifest.suite_version !== "v0.1.0" || !Array.isArray(manifest.fixtures)
    || manifest.fixtures.length !== 8 || receipt.fixtures.length !== 8) {
    throw new Error("Docling bakeoff requires the exact eight-case Phase 0 corpus");
  }
  return manifest.fixtures.map((fixture, index) => {
    const retained = receipt.fixtures[index];
    const suffix = fixture.id.replace("pdf-tools.extraction.phase0.", "");
    if (!/^[a-z0-9-]{1,128}$/.test(suffix) || retained.ordinal !== index + 1
      || retained.sha256 !== fixture.sha256 || retained.filename !== `source-${String(index + 1).padStart(3, "0")}-${fixture.sha256.slice(0, 12)}.pdf`
      || !Number.isSafeInteger(retained.bytes) || retained.bytes < 1
      || !Number.isSafeInteger(fixture.expected?.pages?.length) || fixture.expected.pages.length < 1) {
      throw new Error(`Docling fixture binding is invalid at ordinal ${index + 1}`);
    }
    return { fixture, retained, suffix, pageCount: fixture.expected.pages.length };
  });
}

export function validateCandidateResponse(response, request, schema) {
  validateSchema(response, schema, "Docling candidate response");
  if (response.protocol !== request.protocol || response.request_id !== request.request_id) {
    throw new Error("Docling response is not bound to its request");
  }
  return response;
}

function adapterCommand(receipt, receiptSha256) {
  const command = receipt.execution.adapter_command;
  if (!Array.isArray(command) || command.length < 2 || command.some(value => typeof value !== "string" || !value)
    || command.filter(value => value === "$OUT_OF_BAND_RECEIPT_SHA256").length !== 1) {
    throw new Error("Receipt adapter command is invalid");
  }
  return command.map(value => value === "$OUT_OF_BAND_RECEIPT_SHA256" ? receiptSha256 : value);
}

async function spawnCaptured({ command, cwd, environment, stdin, stdoutLimit, stderrLimit, deadlineMs }) {
  const child = spawn(command[0], command.slice(1), {
    cwd,
    detached: process.platform !== "win32",
    env: { ...environment },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let exceeded = false;
  let timedOut = false;
  const startedAt = process.hrtime.bigint();
  const stop = () => {
    try {
      if (process.platform !== "win32" && Number.isSafeInteger(child.pid)) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {}
  };
  child.stdout.on("data", chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= stdoutLimit) stdout.push(chunk);
    else { exceeded = true; stop(); }
  });
  child.stderr.on("data", chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes <= stderrLimit) stderr.push(chunk);
    else { exceeded = true; stop(); }
  });
  const timer = setTimeout(() => { timedOut = true; stop(); }, deadlineMs);
  child.stdin.end(stdin);
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  if (exceeded || timedOut || exit.code !== 0 || exit.signal !== null) {
    const diagnostic = Buffer.concat(stderr).toString("utf8").slice(0, 500);
    throw new Error(`Docling adapter process failed (${exit.code}, ${exit.signal}): ${diagnostic}`);
  }
  return {
    pid: child.pid,
    elapsed_ms: elapsedMs,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
    stdout_bytes: stdoutBytes,
    stderr_bytes: stderrBytes,
  };
}

function parseCanonicalResponse(stdout, request, schema) {
  const response = parseJson(stdout, "Docling response", { canonical: true });
  return validateCandidateResponse(response, request, schema);
}

function inventorySummary(inventory) {
  if (!inventory || !SHA256.test(inventory.inventory_sha256 ?? "")
    || !Number.isSafeInteger(inventory.entry_count) || !Number.isSafeInteger(inventory.total_file_bytes)) {
    throw new Error("Docling runtime inventory summary is invalid");
  }
  return {
    inventory_sha256: inventory.inventory_sha256,
    entry_count: inventory.entry_count,
    total_file_bytes: inventory.total_file_bytes,
    uv_version: inventory.uv_version,
  };
}

async function writeExclusive(filename, bytes) {
  await canonicalDirectory(path.dirname(filename), "output parent", 0o700);
  const handle = await fs.open(
    filename,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const metadata = await fs.lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("Docling bakeoff output violates its private regular-file contract");
  }
}

export async function captureDoclingBakeoff(options) {
  const expectedDigests = [
    options["--finalization-sha256"],
    options["--manifest-sha256"],
    options["--receipt-sha256"],
    options["--receipt-schema-sha256"],
  ];
  if (!expectedDigests.every(value => SHA256.test(value ?? ""))) {
    throw new Error("One or more expected SHA-256 values are invalid");
  }
  const finalizationPath = path.resolve(options["--finalization"]);
  const manifestPath = path.resolve(options["--manifest"]);
  const outputPath = path.resolve(options["--output"]);
  const receiptPath = path.resolve(options["--receipt"]);
  const receiptSchemaPath = path.resolve(options["--receipt-schema"]);
  const receiptSha256 = options["--receipt-sha256"];
  const finalizationSha256 = options["--finalization-sha256"];
  const [receiptBytes, receiptSchemaBytes, finalizationBytes, manifestBytes] = await Promise.all([
    stableFile(receiptPath, MAX_METADATA_BYTES, "receipt", 0o600),
    stableFile(receiptSchemaPath, MAX_METADATA_BYTES, "receipt schema"),
    stableFile(finalizationPath, MAX_METADATA_BYTES, "finalization", 0o600),
    stableFile(manifestPath, MAX_METADATA_BYTES, "manifest"),
  ]);
  if (sha256(receiptBytes) !== receiptSha256
    || sha256(receiptSchemaBytes) !== options["--receipt-schema-sha256"]
    || sha256(finalizationBytes) !== finalizationSha256
    || sha256(manifestBytes) !== options["--manifest-sha256"]) {
    throw new Error("One or more retained inputs differ from their expected SHA-256 values");
  }
  const receipt = validateReceipt(
    parseJson(receiptBytes, "receipt", { canonical: true }),
    parseJson(receiptSchemaBytes, "receipt schema"),
  );
  const protectedRootsJson = protectedRootsBinding(options["--protected-roots-json"], receipt);
  const finalizationSchemaRecord = recordByRole(receipt, "finalization_schema");
  const finalizationSchemaPath = path.join(receipt.roots.sidecar_snapshot, finalizationSchemaRecord.filename);
  const finalizationSchemaBytes = await stableFile(
    finalizationSchemaPath,
    finalizationSchemaRecord.bytes,
    "retained finalization schema",
    0o600,
  );
  if (sha256(finalizationSchemaBytes) !== finalizationSchemaRecord.sha256) {
    throw new Error("Retained finalization schema differs from its receipt identity");
  }
  const finalization = validateFinalization(
    parseJson(finalizationBytes, "finalization", { canonical: true }),
    parseJson(finalizationSchemaBytes, "finalization schema"),
    receipt,
    receiptSha256,
  );
  if (receipt.setup.finalization.path !== finalizationPath) {
    throw new Error("Finalization path differs from the receipt binding");
  }
  const manifest = parseJson(manifestBytes, "manifest");
  const bindings = fixtureBindings(manifest, receipt);
  const runRoot = await canonicalDirectory(path.dirname(receiptPath), "receipt run root", 0o700);
  const outputRoot = await canonicalDirectory(path.dirname(outputPath), "output parent", 0o700);
  if (runRoot === outputRoot || outputPath.startsWith(`${runRoot}${path.sep}`)) {
    throw new Error("Consolidated output must remain outside the receipt run root");
  }
  const authorityRecord = recordByRole(receipt, "handoff_authority");
  const authorityPath = path.join(receipt.roots.sidecar_snapshot, authorityRecord.filename);
  const authorityBytes = await stableFile(authorityPath, authorityRecord.bytes, "retained handoff authority", 0o600);
  if (authorityBytes.length !== authorityRecord.bytes || sha256(authorityBytes) !== authorityRecord.sha256) {
    throw new Error("Retained handoff authority differs from its receipt identity");
  }
  const runtimeSource = await importRetainedModule(receipt, "runtime_evidence_source");
  if (typeof runtimeSource.module.captureDoclingRuntimeInventory !== "function") {
    throw new Error("Retained runtime evidence module exports are invalid");
  }
  const requestSchemaSource = recordByRole(receipt, "candidate_request_schema");
  const responseSchemaSource = recordByRole(receipt, "candidate_response_schema");
  const [requestSchemaBytes, responseSchemaBytes] = await Promise.all([
    stableFile(path.join(receipt.roots.sidecar_snapshot, requestSchemaSource.filename), requestSchemaSource.bytes, "request schema", 0o600),
    stableFile(path.join(receipt.roots.sidecar_snapshot, responseSchemaSource.filename), responseSchemaSource.bytes, "response schema", 0o600),
  ]);
  if (sha256(requestSchemaBytes) !== requestSchemaSource.sha256 || sha256(responseSchemaBytes) !== responseSchemaSource.sha256) {
    throw new Error("Retained candidate schema differs from its receipt identity");
  }
  const requestSchema = parseJson(requestSchemaBytes, "request schema");
  const responseSchema = parseJson(responseSchemaBytes, "response schema");
  const authorityVerifier = await createRetainedAuthorityVerifier({
    receipt,
    receiptPath,
    receiptSha256,
    protectedRootsJson,
  });
  const verifyAuthority = authorityVerifier.verify;
  const verifyFinalizationFile = async () => {
    const current = await stableFile(finalizationPath, finalizationBytes.length, "reopened finalization", 0o600);
    if (!current.equals(finalizationBytes)) throw new Error("Docling finalization changed during the campaign");
  };
  const captureInventory = async () => inventorySummary(
    await runtimeSource.module.captureDoclingRuntimeInventory(receipt, finalization),
  );
  await verifyAuthority();
  const baselineInventory = await captureInventory();
  const command = adapterCommand(receipt, receiptSha256);
  const cases = [];
  for (const binding of bindings) {
    const attemptDir = await canonicalDirectory(path.join(runRoot, `probe-${binding.suffix}`), `attempt ${binding.fixture.id}`, 0o700);
    const requestPath = path.join(attemptDir, "request.json");
    const sourcePath = path.join(attemptDir, "source.pdf");
    const [requestBytes, sourceBytes] = await Promise.all([
      stableFile(requestPath, 16 * 1024 * 1024, `request ${binding.fixture.id}`, 0o600),
      stableFile(sourcePath, 1024 * 1024 * 1024, `source ${binding.fixture.id}`, 0o600),
    ]);
    const request = parseJson(requestBytes, `request ${binding.fixture.id}`, { canonical: true });
    validateSchema(request, requestSchema, `request ${binding.fixture.id}`);
    if (request.source.sha256 !== binding.retained.sha256 || request.source.size_bytes !== binding.retained.bytes
      || request.source.page_count !== binding.pageCount || request.source.path !== "source.pdf"
      || sourceBytes.length !== binding.retained.bytes || sha256(sourceBytes) !== binding.retained.sha256) {
      throw new Error(`Staged request or source binding differs for ${binding.fixture.id}`);
    }
    const runs = [];
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      await verifyAuthority();
      await verifyFinalizationFile();
      const before = await captureInventory();
      if (before.inventory_sha256 !== baselineInventory.inventory_sha256) {
        throw new Error(`Docling runtime drifted before ${binding.fixture.id} repetition ${repetition}`);
      }
      const observed = await spawnCaptured({
        command,
        cwd: attemptDir,
        environment: receipt.execution.environment,
        stdin: requestBytes,
        stdoutLimit: request.limits.max_stdout_bytes,
        stderrLimit: request.limits.max_stderr_bytes,
        deadlineMs: request.limits.deadline_ms,
      });
      const response = parseCanonicalResponse(observed.stdout, request, responseSchema);
      await verifyAuthority();
      await verifyFinalizationFile();
      const after = await captureInventory();
      if (after.inventory_sha256 !== baselineInventory.inventory_sha256) {
        throw new Error(`Docling runtime drifted after ${binding.fixture.id} repetition ${repetition}`);
      }
      const [requestAfter, sourceAfter] = await Promise.all([
        stableFile(requestPath, requestBytes.length, `reopened request ${binding.fixture.id}`, 0o600),
        stableFile(sourcePath, sourceBytes.length, `reopened source ${binding.fixture.id}`, 0o600),
      ]);
      if (!requestAfter.equals(requestBytes) || !sourceAfter.equals(sourceBytes)) {
        throw new Error(`Docling staged input changed for ${binding.fixture.id}`);
      }
      runs.push({
        repetition,
        pid: observed.pid,
        elapsed_ms: observed.elapsed_ms,
        response_sha256: sha256(Buffer.from(canonicalJson(response))),
        stdout_bytes: observed.stdout_bytes,
        stderr: { bytes: observed.stderr_bytes, sha256: sha256(observed.stderr) },
        runtime_before_sha256: before.inventory_sha256,
        runtime_after_sha256: after.inventory_sha256,
      });
      if (repetition === 1) runs[0].response = response;
    }
    if (new Set(runs.map(run => run.pid)).size !== 3
      || new Set(runs.map(run => run.response_sha256)).size !== 1) {
      throw new Error(`Docling fresh-process evidence is not deterministic for ${binding.fixture.id}`);
    }
    cases.push({
      case_id: binding.fixture.id,
      category: binding.fixture.category,
      partition: binding.fixture.partition,
      page_count: binding.pageCount,
      source_bytes: sourceBytes.length,
      source_sha256: sha256(sourceBytes),
      source_reopened_verified: true,
      request_bytes: requestBytes.length,
      request_sha256: sha256(requestBytes),
      stable: true,
      runs,
    });
  }
  await verifyAuthority();
  await verifyFinalizationFile();
  const finalInventory = await captureInventory();
  if (canonicalJson(finalInventory) !== canonicalJson(baselineInventory)) {
    throw new Error("Docling runtime inventory changed across the campaign");
  }
  const [receiptAfter, finalizationAfter, authorityAfter, verifierAfter, launcherAfter, runtimeAfter] = await Promise.all([
    stableFile(receiptPath, receiptBytes.length, "reopened receipt", 0o600),
    stableFile(finalizationPath, finalizationBytes.length, "reopened finalization", 0o600),
    stableFile(authorityPath, authorityBytes.length, "reopened authority", 0o600),
    stableFile(
      path.join(receipt.roots.sidecar_snapshot, authorityVerifier.verifierSource.record.filename),
      authorityVerifier.verifierSource.bytes.length,
      "reopened authority verifier",
      0o600,
    ),
    stableFile(authorityVerifier.launcherPath, authorityVerifier.launcherBytes.length, "reopened authority launcher", 0o600),
    stableFile(path.join(receipt.roots.sidecar_snapshot, runtimeSource.record.filename), runtimeSource.bytes.length, "reopened runtime evidence source", 0o600),
  ]);
  if (!receiptAfter.equals(receiptBytes) || !finalizationAfter.equals(finalizationBytes)
    || !authorityAfter.equals(authorityBytes)
    || !verifierAfter.equals(authorityVerifier.verifierSource.bytes)
    || !launcherAfter.equals(authorityVerifier.launcherBytes)
    || !runtimeAfter.equals(runtimeSource.bytes)) {
    throw new Error("Docling retained authority changed across the campaign");
  }
  const report = {
    protocol: "pdf-tools.docling-bakeoff.v1",
    source_bindings: {
      handoff_id: receipt.handoff_id,
      receipt_sha256: receiptSha256,
      receipt_schema_sha256: options["--receipt-schema-sha256"],
      finalization_id: finalization.finalization_id,
      finalization_sha256: finalizationSha256,
      finalization_schema_sha256: finalizationSchemaRecord.sha256,
      manifest_sha256: options["--manifest-sha256"],
      authority_sha256: authorityRecord.sha256,
      authority_verifier_sha256: authorityVerifier.verifierSource.record.sha256,
      authority_launcher_sha256: authorityVerifier.launcherRecord.sha256,
      runtime_evidence_source_sha256: runtimeSource.record.sha256,
      request_schema_sha256: requestSchemaSource.sha256,
      response_schema_sha256: responseSchemaSource.sha256,
    },
    runtime: {
      platform: receipt.platform,
      inventory: baselineInventory,
      final_inventory_sha256: finalInventory.inventory_sha256,
      stable: true,
      network_isolation_enforced: receipt.execution.network_isolation_enforced,
    },
    adapter_command_sha256: sha256(Buffer.from(canonicalJson(command))),
    repetitions_per_case: 3,
    cases,
  };
  const reportBytes = Buffer.from(`${canonicalJson(report)}\n`);
  await writeExclusive(outputPath, reportBytes);
  return { output: outputPath, bytes: reportBytes.length, sha256: sha256(reportBytes), cases: cases.length };
}

async function main() {
  const result = await captureDoclingBakeoff(exactOptions(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`Docling bakeoff failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
