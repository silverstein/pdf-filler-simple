#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GIB = 1024 ** 3;
const SHA256 = /^[a-f0-9]{64}$/;
const REQUIRED_OPTIONS = [
  "--attempt-source-root",
  "--finalization",
  "--finalization-sha256",
  "--output",
  "--receipt",
  "--receipt-sha256",
  "--work-root",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function options(argv) {
  if (argv.length !== REQUIRED_OPTIONS.length * 2) {
    throw new Error(`Expected exactly: ${REQUIRED_OPTIONS.join(", ")}`);
  }
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!REQUIRED_OPTIONS.includes(name) || Object.hasOwn(result, name) || !value) {
      throw new Error(`Unknown, duplicate, or empty option: ${name}`);
    }
    result[name] = name.endsWith("-sha256") ? value : path.resolve(value);
  }
  if (!SHA256.test(result["--receipt-sha256"])
    || !SHA256.test(result["--finalization-sha256"])) {
    throw new Error("Calibration requires out-of-band SHA-256 bindings");
  }
  return result;
}

async function privateDirectory(filename, label) {
  const [real, metadata] = await Promise.all([fs.realpath(filename), fs.lstat(filename)]);
  if (real !== filename || !metadata.isDirectory() || metadata.isSymbolicLink()
    || (metadata.mode & 0o777) !== 0o700) {
    throw new Error(`${label} must be a canonical mode-0700 directory`);
  }
  return filename;
}

function within(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function emptyPrivateDirectory(filename, label) {
  await privateDirectory(filename, label);
  if ((await fs.readdir(filename)).length !== 0) {
    throw new Error(`${label} must start empty`);
  }
  return filename;
}

async function stableFile(filename, maximumBytes, label, requiredMode = null) {
  if (path.resolve(filename) !== filename || typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error(`${label} path is invalid`);
  }
  const before = await fs.lstat(filename, { bigint: true });
  const mode = Number(before.mode & 0o777n);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
    || before.size < 1n || before.size > BigInt(maximumBytes)
    || (requiredMode !== null && mode !== requiredMode)
    || await fs.realpath(filename) !== filename) {
    throw new Error(`${label} violates its regular-file contract`);
  }
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    for (const key of ["dev", "ino", "nlink", "size", "mode", "mtimeNs", "ctimeNs"]) {
      if (String(before[key]) !== String(after[key])) throw new Error(`${label} changed while read`);
    }
    if (bytes.length !== Number(before.size)) throw new Error(`${label} changed length while read`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function nextPowerOfTwo(value, minimum, maximum) {
  let result = minimum;
  while (result < value && result < maximum) result *= 2;
  return Math.min(result, maximum);
}

function adapterCommand(receipt, receiptSha256) {
  const placeholder = "$OUT_OF_BAND_RECEIPT_SHA256";
  const command = receipt?.execution?.adapter_command;
  if (!Array.isArray(command) || command.filter(value => value === placeholder).length !== 1) {
    throw new Error("Receipt adapter command is invalid");
  }
  return command.map(value => value === placeholder ? receiptSha256 : value);
}

async function runPass({
  name,
  attempts,
  build,
  command,
  environment,
  addressSpaceBytes,
  physicalFootprintMaxBytes,
  cpuSeconds,
  parseResponse,
  runCandidate,
}) {
  const records = [];
  for (const attempt of attempts) {
    const requestBytes = await stableFile(
      path.join(attempt, "request.json"),
      16 * 1024 * 1024,
      `${name} request`,
      0o600,
    );
    const sourceBytes = await stableFile(
      path.join(attempt, "source.pdf"),
      1024 * 1024 * 1024,
      `${name} source`,
      0o600,
    );
    const request = parseResponse(requestBytes, requestBytes.length);
    const result = await runCandidate({
      binaryPath: build.binary.path,
      expectedBinary: build.binary,
      cwd: attempt,
      command,
      stdin: requestBytes,
      environment,
      deadlineMs: request.limits.deadline_ms,
      leaderExitGraceMs: 2000,
      sampleIntervalMs: 50,
      stdoutMaxBytes: request.limits.max_stdout_bytes,
      stderrMaxBytes: request.limits.max_stderr_bytes,
      physicalFootprintMaxBytes,
      addressSpaceBytes,
      cpuSeconds,
      fileSizeBytes: 512 * 1024 * 1024,
      nofile: 1024,
    });
    if (!result.lease || !result.evidence.controller_accepted
      || result.evidence.controller_failure !== "none"
      || !result.evidence.observations.original_process_group_empty
      || result.exit.code !== 0 || result.exit.signal !== null) {
      throw Object.assign(new Error(`${name} supervisor rejected ${path.basename(attempt)}`), {
        supervisor: {
          lease: result.lease,
          evidence: result.evidence,
          exit: result.exit,
          supervisor_stderr: result.supervisor_stderr.toString("utf8").slice(0, 1000),
        },
      });
    }
    parseResponse(result.stdout, request.limits.max_stdout_bytes);
    const [requestAfter, sourceAfter, entriesAfter] = await Promise.all([
      stableFile(path.join(attempt, "request.json"), requestBytes.length, `${name} request`, 0o600),
      stableFile(path.join(attempt, "source.pdf"), sourceBytes.length, `${name} source`, 0o600),
      fs.readdir(attempt),
    ]);
    if (!requestAfter.equals(requestBytes) || !sourceAfter.equals(sourceBytes)
      || canonicalJson(entriesAfter.sort()) !== canonicalJson(["request.json", "source.pdf"])) {
      throw new Error(`${name} attempt retained unexpected writable state`);
    }
    records.push({
      attempt: path.basename(attempt),
      request_sha256: sha256(requestBytes),
      source_sha256: sha256(sourceBytes),
      response_sha256: sha256(result.stdout),
      lease: result.lease,
      evidence: result.evidence,
    });
  }
  return records;
}

function recordByRole(receipt, role) {
  const matches = receipt.inputs?.filter(record => record.role === role) ?? [];
  if (matches.length !== 1) throw new Error(`Calibration receipt must bind exactly one ${role}`);
  return matches[0];
}

async function retainedFile(receipt, role, maximumBytes = 16 * 1024 * 1024) {
  const record = recordByRole(receipt, role);
  const filename = path.join(receipt.roots.sidecar_snapshot, record.filename);
  const bytes = await stableFile(filename, maximumBytes, `retained ${role}`, 0o600);
  if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) {
    throw new Error(`Retained ${role} differs from the calibration receipt`);
  }
  return { bytes, filename, record };
}

async function stageAttempts(sourceRoot, workRoot, passName) {
  const sourceAttempts = (await fs.readdir(sourceRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith("probe-"))
    .map(entry => path.join(sourceRoot, entry.name))
    .sort();
  if (sourceAttempts.length !== 8) {
    throw new Error("Calibration requires the exact eight-case source attempt set");
  }
  const passRoot = path.join(workRoot, passName);
  await fs.mkdir(passRoot, { mode: 0o700 });
  await privateDirectory(passRoot, `${passName} pass root`);
  const attempts = [];
  for (const [index, sourceAttempt] of sourceAttempts.entries()) {
    await privateDirectory(sourceAttempt, "source attempt directory");
    const sourceEntries = (await fs.readdir(sourceAttempt)).sort();
    if (canonicalJson(sourceEntries) !== canonicalJson(["request.json", "source.pdf"])) {
      throw new Error("Calibration source attempt contains unexpected state");
    }
    const [requestBytes, sourceBytes] = await Promise.all([
      stableFile(path.join(sourceAttempt, "request.json"), 16 * 1024 * 1024, "source request", 0o600),
      stableFile(path.join(sourceAttempt, "source.pdf"), 1024 * 1024 * 1024, "source PDF", 0o600),
    ]);
    const attempt = path.join(passRoot, `attempt-${String(index + 1).padStart(2, "0")}`);
    await fs.mkdir(attempt, { mode: 0o700 });
    await Promise.all([
      writeExclusive(path.join(attempt, "request.json"), requestBytes),
      writeExclusive(path.join(attempt, "source.pdf"), sourceBytes),
    ]);
    attempts.push(attempt);
  }
  return attempts;
}

async function writeExclusive(filename, bytes) {
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
}

export async function calibrateDoclingSupervisor(rawOptions) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Docling supervisor calibration requires darwin/arm64");
  }
  const receiptPath = rawOptions["--receipt"];
  const finalizationPath = rawOptions["--finalization"];
  const attemptSourceRoot = await privateDirectory(
    rawOptions["--attempt-source-root"],
    "attempt source root",
  );
  const workRoot = await emptyPrivateDirectory(rawOptions["--work-root"], "work root");
  const outputPath = rawOptions["--output"];
  const receiptRunRoot = await privateDirectory(path.dirname(receiptPath), "receipt run root");
  if (path.dirname(finalizationPath) !== receiptRunRoot
    || path.dirname(outputPath) !== workRoot
    || [receiptRunRoot, attemptSourceRoot].some(
      root => within(root, workRoot) || within(workRoot, root),
    )) {
    throw new Error("Calibration work root must be distinct from receipt and source attempt roots");
  }
  const receiptBytes = await stableFile(receiptPath, 16 * 1024 * 1024, "receipt", 0o600);
  if (sha256(receiptBytes) !== rawOptions["--receipt-sha256"]) {
    throw new Error("Calibration receipt differs from its out-of-band SHA-256");
  }
  const receipt = JSON.parse(receiptBytes);
  const receiptSha256 = sha256(receiptBytes);
  const finalizationBytes = await stableFile(
    finalizationPath,
    16 * 1024 * 1024,
    "finalization",
    0o600,
  );
  if (sha256(finalizationBytes) !== rawOptions["--finalization-sha256"]) {
    throw new Error("Calibration finalization differs from its out-of-band SHA-256");
  }
  const finalization = JSON.parse(finalizationBytes);
  if (finalization.handoff_id !== receipt.handoff_id
    || finalization.receipt_sha256 !== receiptSha256
    || canonicalJson(finalization.supervisor_build)
      !== canonicalJson(receipt.execution?.supervisor?.build)
    || !finalization.installed_distributions.some(
      ([name, version]) => name === "docling-slim" && version === "2.114.0",
    )) {
    throw new Error("Calibration requires the exact finalized Docling 2.114.0 handoff");
  }
  const controller = await retainedFile(receipt, "supervisor_controller");
  const controllerModule = await import(
    `data:text/javascript;base64,${controller.bytes.toString("base64")}`,
  );
  if (!["parseCanonicalCandidateJson", "runSupervisedCandidate", "verifyDoclingMacosSupervisorBuild"]
    .every(name => typeof controllerModule[name] === "function")) {
    throw new Error("Retained calibration controller exports are invalid");
  }
  const supervisorSource = await retainedFile(receipt, "supervisor_source");
  const build = await controllerModule.verifyDoclingMacosSupervisorBuild(
    receipt.execution.supervisor.build,
    {
      sourcePath: supervisorSource.filename,
      binaryPath: receipt.execution.supervisor.build.binary.path,
      architecture: "arm64",
      testing: false,
    },
  );
  if (canonicalJson(build) !== canonicalJson(finalization.supervisor_build)) {
    throw new Error("Calibration build differs across receipt, finalization, and live verification");
  }
  const calibrationSourceBytes = await stableFile(
    fileURLToPath(import.meta.url),
    1024 * 1024,
    "executed calibration source",
  );
  const command = adapterCommand(receipt, receiptSha256);
  const observationAttempts = await stageAttempts(
    attemptSourceRoot,
    workRoot,
    "observation",
  );
  const confirmationAttempts = await stageAttempts(
    attemptSourceRoot,
    workRoot,
    "confirmation",
  );
  const deadlines = await Promise.all(observationAttempts.map(async attempt => {
    const request = JSON.parse(await stableFile(
      path.join(attempt, "request.json"),
      16 * 1024 * 1024,
      "request",
      0o600,
    ));
    return request.limits.deadline_ms;
  }));
  const cpuSeconds = Math.min(3600, Math.ceil(Math.max(...deadlines) / 1000) + 60);
  const observation = await runPass({
    name: "observation",
    attempts: observationAttempts,
    build,
    command,
    environment: receipt.execution.environment,
    addressSpaceBytes: 1024 * GIB,
    physicalFootprintMaxBytes: 64 * GIB,
    cpuSeconds,
    parseResponse: controllerModule.parseCanonicalCandidateJson,
    runCandidate: controllerModule.runSupervisedCandidate,
  });
  const observedVirtual = Math.max(...observation.map(
    record => record.evidence.observations.max_sampled_group_virtual_bytes,
  ));
  const observedPhysical = Math.max(...observation.map(
    record => record.evidence.observations.max_sampled_group_physical_footprint_bytes,
  ));
  const recommendedPolicy = {
    protocol: "pdf-tools.docling-macos-supervisor-policy.v1",
    sample_interval_ms: 50,
    leader_exit_grace_ms: 2000,
    sampled_group_physical_footprint_max_bytes: nextPowerOfTwo(observedPhysical * 2, 4 * GIB, 64 * GIB),
    address_space_bytes: nextPowerOfTwo(observedVirtual * 2, 64 * GIB, 1024 * GIB),
    cpu_seconds: cpuSeconds,
    file_size_bytes: 512 * 1024 * 1024,
    nofile: 1024,
  };
  const frozenPolicy = { ...receipt.execution.supervisor.policy };
  delete frozenPolicy.calibration_attestation_sha256;
  if (canonicalJson(recommendedPolicy) !== canonicalJson(frozenPolicy)) {
    throw new Error("Calibration recommendation differs from the frozen receipt policy");
  }
  const confirmation = await runPass({
    name: "confirmation",
    attempts: confirmationAttempts,
    build,
    command,
    environment: receipt.execution.environment,
    addressSpaceBytes: recommendedPolicy.address_space_bytes,
    physicalFootprintMaxBytes: recommendedPolicy.sampled_group_physical_footprint_max_bytes,
    cpuSeconds,
    parseResponse: controllerModule.parseCanonicalCandidateJson,
    runCandidate: controllerModule.runSupervisedCandidate,
  });
  const report = {
    protocol: "pdf-tools.docling-macos-supervisor-calibration.v1",
    claim_boundary: "Private non-scored calibration only. This is not benchmark or product evidence.",
    calibration_source: {
      bytes: calibrationSourceBytes.length,
      sha256: sha256(calibrationSourceBytes),
    },
    receipt: {
      handoff_id: receipt.handoff_id,
      bytes: receiptBytes.length,
      sha256: receiptSha256,
    },
    finalization: {
      bytes: finalizationBytes.length,
      sha256: sha256(finalizationBytes),
      finalization_id: finalization.finalization_id,
    },
    retained_sources: {
      supervisor_controller: {
        bytes: controller.record.bytes,
        sha256: controller.record.sha256,
      },
      supervisor_source: {
        bytes: supervisorSource.record.bytes,
        sha256: supervisorSource.record.sha256,
      },
    },
    build,
    observation,
    observed_maxima: {
      sampled_group_virtual_bytes: observedVirtual,
      sampled_group_physical_footprint_bytes: observedPhysical,
    },
    recommended_policy: recommendedPolicy,
    confirmation,
  };
  const bytes = Buffer.from(`${canonicalJson(report)}\n`);
  await writeExclusive(outputPath, bytes);
  return { output: outputPath, bytes: bytes.length, sha256: sha256(bytes), recommended_policy: recommendedPolicy };
}

async function main() {
  const result = await calibrateDoclingSupervisor(options(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`Docling supervisor calibration failed: ${JSON.stringify({
      message: error.message,
      code: error.code ?? null,
      exit: error.exit ?? null,
      cause: error.cause?.message ?? null,
      supervisor: error.supervisor ?? null,
    })}\n`);
    process.exitCode = 1;
  });
}
