import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as FILE_SYSTEM_CONSTANTS } from "node:fs";
import defaultFileSystem from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const PROVENANCE_PATH = path.join(
  REPO_ROOT,
  "test/fixtures/eval/extraction/oracles/layout-encrypted-qpdf-r4.provenance.json",
);

const PINNED = Object.freeze({
  purpose: "Real encrypted read_pdf_layout password classification and authenticated extraction oracle",
  sourcePath: "test/fixtures/eval/extraction/synthetic/two-column-order.pdf",
  sourceBytes: 2427,
  sourceSha256: "aaaae6795676db9e33f79e75f4662808ee9646f8f2bb12a319f74e3edb11c101",
  fixturePath: "test/fixtures/eval/extraction/oracles/layout-encrypted-qpdf-r4.pdf",
  fixtureBytes: 3247,
  intermediateSha256: "23dd0051ce9932f47fa27e39ce4590ea3b589d5c586b679b251f1c6d0a1d431b",
  fixtureSha256: "28f4003b7ff37735033778c96c7c704ee1b5955d2a424aeb507d65de046e4e5a",
  imageReference: "oda-qpdf-wasm-probe@sha256:01296613065c60ee861b5aeb542fb30ef1d8212491e968585e049a62c5c3e4e8",
  imageId: "sha256:01296613065c60ee861b5aeb542fb30ef1d8212491e968585e049a62c5c3e4e8",
  qpdfMjsBytes: 34382,
  qpdfMjsSha256: "0c087b0d6ed0b57dd24a8b82e081207809dd97edff618d753c39a5639dcdc7c3",
  qpdfWasmBytes: 2450542,
  qpdfWasmSha256: "36830fb93e3f8a8a9bf4e8352b8b9b5f9ef1a25702b2eeaae0b52ab0b6746e6f",
  version: "12.3.2",
  versionStdout: [
    "generate-layout-encrypted-oracle.mjs version 12.3.2",
    "Run generate-layout-encrypted-oracle.mjs --copyright to see copyright and license information.",
  ],
  versionStdoutSha256: "2dd2382cc10110d3687a1aa1c087cc7ee116ef03aa53730ac608578a95b5efe4",
  runRecordSha256: [
    "be910b4cd47736a554c47e33b3edaea270ba3984881bde6173aa7b5d8ba3cdf0",
    "e4f6d4a8df9bc3341163a1b49486664d9d51c5924cea45824d0d7c3ede2621df",
  ],
  userPassword: "oda-layout-user-2026",
  ownerPassword: "oda-layout-owner-2026",
  wrongPassword: "definitely-wrong-layout-password",
  clearHeader: "%PDF-",
  oracleHeader: "xxxxx",
  encryption: "AES-128 revision 4",
  intentionalMalformation: "The five-byte %PDF- header marker was deterministically replaced with xxxxx after QPDF encryption. PDF.js 5.4.624 recovers and authenticates the document; pdf-lib 1.17.1 rejects it, exercising fail-soft raw-box enrichment.",
  postprocess: "Replace byte offsets 0-4 (%PDF-) with ASCII xxxxx without changing file length.",
  securityNotice: "This test fixture deliberately uses fixed document IDs and AES initialization vectors for byte reproducibility. It is insecure and must never be used for production encryption. The generator obtains two hash-pinned research artifacts from an exact local scratch image and never packages QPDF with PDF Tools.",
});

const QPDF_ARGUMENTS = Object.freeze([
  "/input.pdf",
  "--encrypt",
  PINNED.userPassword,
  PINNED.ownerPassword,
  "128",
  "--use-aes=y",
  "--",
  "--static-id",
  "--static-aes-iv",
  "/encrypted.pdf",
]);
const QPDF_STREAM_BYTE_CAP = 64 * 1024;
const PROCESS_OUTPUT_BYTE_CAP = 64 * 1024;
let qpdfFactoryQueue = Promise.resolve();

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertValue(actual, expected, field) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`Encrypted layout oracle provenance mismatch at ${field}.`);
  }
}

function assertExactKeys(value, expectedKeys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Encrypted layout oracle provenance mismatch at ${field}.`);
  }
  assertValue(Object.keys(value).sort(), [...expectedKeys].sort(), `${field} keys`);
}

function assertProvenanceContractUnsafe(provenance) {
  assertExactKeys(provenance, [
    "schema_version",
    "fixture_id",
    "ownership",
    "license",
    "purpose",
    "source_fixture",
    "encrypted_fixture",
    "qpdf",
    "passwords",
    "generation",
  ], "root");
  assertValue(provenance?.schema_version, 1, "schema_version");
  assertValue(provenance?.fixture_id, "oda-layout-encrypted-qpdf-r4-v1", "fixture_id");
  assertValue(provenance?.ownership, "Open Document Alliance generated synthetic fixture", "ownership");
  assertValue(provenance?.license, "CC0-1.0", "license");
  assertValue(provenance?.purpose, PINNED.purpose, "purpose");
  assertValue(provenance?.source_fixture, {
    path: PINNED.sourcePath,
    bytes: PINNED.sourceBytes,
    sha256: PINNED.sourceSha256,
  }, "source_fixture");
  assertExactKeys(provenance?.encrypted_fixture, [
    "path",
    "bytes",
    "sha256",
    "encryption",
    "encryption_dictionary",
    "qpdf_output_sha256_before_malformed_header_oracle",
    "intentional_malformation",
  ], "encrypted_fixture");
  assertValue(provenance?.encrypted_fixture?.path, PINNED.fixturePath, "encrypted_fixture.path");
  assertValue(provenance?.encrypted_fixture?.bytes, PINNED.fixtureBytes, "encrypted_fixture.bytes");
  assertValue(provenance?.encrypted_fixture?.sha256, PINNED.fixtureSha256, "encrypted_fixture.sha256");
  assertValue(provenance?.encrypted_fixture?.encryption, PINNED.encryption, "encrypted_fixture.encryption");
  assertValue(provenance?.encrypted_fixture?.encryption_dictionary, {
    filter: "Standard",
    version: 4,
    revision: 4,
    key_length_bits: 128,
    crypt_filter_method: "AESV2",
    stream_filter: "StdCF",
    string_filter: "StdCF",
  }, "encrypted_fixture.encryption_dictionary");
  assertValue(
    provenance?.encrypted_fixture?.qpdf_output_sha256_before_malformed_header_oracle,
    PINNED.intermediateSha256,
    "encrypted_fixture.qpdf_output_sha256_before_malformed_header_oracle",
  );
  assertValue(
    provenance?.encrypted_fixture?.intentional_malformation,
    PINNED.intentionalMalformation,
    "encrypted_fixture.intentional_malformation",
  );
  assertValue(provenance?.qpdf, {
    version: PINNED.version,
    scratch_image: PINNED.imageReference,
    scratch_image_id_sha256: PINNED.imageId,
    qpdf_mjs_bytes: PINNED.qpdfMjsBytes,
    qpdf_mjs_sha256: PINNED.qpdfMjsSha256,
    qpdf_wasm_bytes: PINNED.qpdfWasmBytes,
    qpdf_wasm_sha256: PINNED.qpdfWasmSha256,
    version_stdout: PINNED.versionStdout,
    version_stdout_sha256: PINNED.versionStdoutSha256,
  }, "qpdf");
  assertValue(provenance?.passwords, {
    user: PINNED.userPassword,
    owner: PINNED.ownerPassword,
    wrong_password_oracle: PINNED.wrongPassword,
  }, "passwords");
  assertExactKeys(provenance?.generation, [
    "generator",
    "qpdf_arguments",
    "postprocess",
    "reproducible_across_two_runs",
    "runs",
    "reversible_header_transform",
    "test_only_insecure_flags",
    "security_notice",
  ], "generation");
  assertValue(provenance?.generation?.generator, "scripts/generate-layout-encrypted-oracle.mjs", "generation.generator");
  assertValue(provenance?.generation?.qpdf_arguments, QPDF_ARGUMENTS, "generation.qpdf_arguments");
  assertValue(provenance?.generation?.postprocess, PINNED.postprocess, "generation.postprocess");
  assertValue(provenance?.generation?.reproducible_across_two_runs, true, "generation.reproducible_across_two_runs");
  assertValue(provenance?.generation?.test_only_insecure_flags, ["--static-id", "--static-aes-iv"], "generation.test_only_insecure_flags");
  assertValue(provenance?.generation?.runs, [1, 2].map(run => ({
    run,
    input_sha256: PINNED.sourceSha256,
    qpdf_intermediate_bytes: PINNED.fixtureBytes,
    qpdf_intermediate_sha256: PINNED.intermediateSha256,
    final_fixture_bytes: PINNED.fixtureBytes,
    final_fixture_sha256: PINNED.fixtureSha256,
    run_record_sha256: PINNED.runRecordSha256[run - 1],
  })), "generation.runs");
  for (const [index, run] of provenance.generation.runs.entries()) {
    assertExactKeys(run, [
      "run",
      "input_sha256",
      "qpdf_intermediate_bytes",
      "qpdf_intermediate_sha256",
      "final_fixture_bytes",
      "final_fixture_sha256",
      "run_record_sha256",
    ], `generation.runs[${index}]`);
  }
  assertValue(provenance?.generation?.reversible_header_transform, {
    byte_offsets: [0, 4],
    forward: `${PINNED.clearHeader} to ${PINNED.oracleHeader}`,
    inverse: `${PINNED.oracleHeader} to ${PINNED.clearHeader}`,
    byte_length_preserved: true,
    round_trip_verified: true,
  }, "generation.reversible_header_transform");
  assertValue(provenance?.generation?.security_notice, PINNED.securityNotice, "generation.security_notice");
  return true;
}

export function assertProvenanceContract(provenance) {
  try {
    return assertProvenanceContractUnsafe(provenance);
  } catch (error) {
    throw sanitizeError(error);
  }
}

export function replaceExactHeader(bytes, expectedHeader, replacementHeader) {
  const expected = Buffer.from(expectedHeader, "ascii");
  const replacement = Buffer.from(replacementHeader, "ascii");
  if (expected.length !== replacement.length) throw new Error("Header transform must preserve byte length.");
  const result = Buffer.from(bytes);
  if (!result.subarray(0, expected.length).equals(expected)) {
    throw new Error("Encrypted layout oracle header did not match the expected transform input.");
  }
  replacement.copy(result, 0);
  return result;
}

export function runLocalProcess(command, args, { timeoutMs = 60_000 } = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: PROCESS_OUTPUT_BYTE_CAP,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
}

function redactDiagnostic(value) {
  let redacted = String(value ?? "");
  for (const secret of [PINNED.userPassword, PINNED.ownerPassword, PINNED.wrongPassword]) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted.trim().slice(0, 2000);
}

function sanitizeError(error, seen = new WeakSet()) {
  if (!(error instanceof Error)) return new Error(redactDiagnostic(error));
  if (seen.has(error)) return new Error("Circular error reference omitted.");
  seen.add(error);
  const sanitizedCause = error.cause ? sanitizeError(error.cause, seen) : undefined;
  let sanitized;
  if (error instanceof AggregateError || Array.isArray(error.errors)) {
    const nested = Array.from(error.errors ?? [], value => sanitizeError(value, seen));
    sanitized = new AggregateError(
      nested,
      redactDiagnostic(error.message),
      sanitizedCause ? { cause: sanitizedCause } : undefined,
    );
  } else {
    sanitized = new Error(
      redactDiagnostic(error.message),
      sanitizedCause ? { cause: sanitizedCause } : undefined,
    );
  }
  sanitized.name = redactDiagnostic(error.name) || sanitized.name;
  if (sanitized.stack) sanitized.stack = redactDiagnostic(sanitized.stack);
  return sanitized;
}

function processFailure(label, result) {
  const details = [
    `status=${result?.status ?? "unavailable"}`,
    result?.signal ? `signal=${redactDiagnostic(result.signal)}` : null,
    result?.error?.code ? `code=${redactDiagnostic(result.error.code)}` : null,
    result?.error?.errno ? `errno=${redactDiagnostic(result.error.errno)}` : null,
    result?.error?.message ? `error=${redactDiagnostic(result.error.message)}` : null,
    result?.stderr ? `stderr=${redactDiagnostic(result.stderr)}` : null,
  ].filter(Boolean).join("; ");
  return new Error(`${label} failed (${details}).`);
}

function invokeProcess(processRunner, command, args) {
  try {
    return processRunner(command, args);
  } catch (error) {
    return { status: null, stdout: "", stderr: "", error };
  }
}

function runChecked(processRunner, label, command, args) {
  const result = invokeProcess(processRunner, command, args);
  if (result?.error || result?.status !== 0) throw processFailure(label, result);
  return String(result.stdout ?? "").trim();
}

function aggregateWithDetails(summary, errors) {
  const retained = errors.filter(Boolean).map(error => sanitizeError(error));
  const details = retained.map(error => redactDiagnostic(error?.message || error)).join(" | ");
  return sanitizeError(new AggregateError(retained, details ? `${summary} ${details}` : summary));
}

function exactMissingContainerResult(result, containerReference) {
  const stdout = String(result?.stdout ?? "").trim();
  if (result?.error || result?.status !== 1 || (stdout !== "" && stdout !== "[]")) return false;
  const stderr = String(result.stderr ?? "").trim();
  return stderr === `Error: No such container: ${containerReference}`
    || stderr === `Error response from daemon: No such container: ${containerReference}`;
}

function classifyCreateResult(result) {
  if (!result?.error && result?.status === 0 && !result?.signal) return "success";
  if (!result?.error && Number.isInteger(result?.status) && result.status !== 0 && !result?.signal) {
    return "known_failure";
  }
  return "indeterminate";
}

async function assertCidfileInitiallyAbsent(cidfilePath, fileSystem) {
  try {
    await fileSystem.lstat(cidfilePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Scratch artifact CID file unexpectedly existed before Docker create.");
}

async function readTrustedCidfile(cidfilePath, fileSystem) {
  let initialStat;
  try {
    initialStat = await fileSystem.lstat(cidfilePath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing", cid: null, errors: [] };
    return { kind: "invalid", cid: null, errors: [sanitizeError(error)] };
  }
  if (
    !initialStat.isFile()
    || initialStat.isSymbolicLink()
    || initialStat.nlink !== 1n
    || initialStat.size < 64n
    || initialStat.size > 65n
  ) {
    return {
      kind: "invalid",
      cid: null,
      errors: [new Error("Scratch artifact CID file was not a trusted single-link regular file of the expected size.")],
    };
  }

  let handle = null;
  const errors = [];
  let raw = null;
  const sameIdentity = (left, right) => Boolean(
    right
    && right.isFile()
    && !right.isSymbolicLink()
    && right.dev === left.dev
    && right.ino === left.ino
    && right.nlink === left.nlink
    && right.mode === left.mode
    && right.size === left.size
    && right.mtimeNs === left.mtimeNs
    && right.ctimeNs === left.ctimeNs
    && right.birthtimeNs === left.birthtimeNs
  );
  try {
    handle = await fileSystem.open(
      cidfilePath,
      FILE_SYSTEM_CONSTANTS.O_RDONLY | (FILE_SYSTEM_CONSTANTS.O_NOFOLLOW ?? 0),
    );
    const openedStat = await handle.stat({ bigint: true });
    if (!sameIdentity(initialStat, openedStat)) {
      errors.push(new Error("Scratch artifact CID file identity changed during its trusted read."));
    } else {
      const boundedBytes = Buffer.alloc(66);
      const firstRead = await handle.read(boundedBytes, 0, boundedBytes.length, 0);
      const expectedSize = Number(initialStat.size);
      if (firstRead.bytesRead !== expectedSize) {
        errors.push(new Error("Scratch artifact CID file did not reach EOF at its expected bounded size."));
      } else {
        const eofProbe = Buffer.alloc(1);
        const eofRead = await handle.read(eofProbe, 0, 1, expectedSize);
        if (eofRead.bytesRead !== 0) {
          errors.push(new Error("Scratch artifact CID file grew beyond its expected bounded EOF."));
        } else {
          raw = boundedBytes.subarray(0, firstRead.bytesRead).toString("ascii");
        }
      }
      const postReadStat = await handle.stat({ bigint: true });
      if (!sameIdentity(initialStat, postReadStat)) {
        errors.push(new Error("Scratch artifact CID file identity changed during its bounded descriptor read."));
      }
    }
  } catch (error) {
    errors.push(sanitizeError(error));
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        errors.push(sanitizeError(error));
      }
    }
  }
  if (errors.length > 0 || !/^[a-f0-9]{64}\n?$/.test(raw ?? "")) {
    if (errors.length === 0) errors.push(new Error("Scratch artifact CID file contents were invalid."));
    return { kind: "invalid", cid: null, errors };
  }
  return { kind: "valid", cid: raw.trim(), errors: [] };
}

async function cleanupCidfile(cidfilePath, fileSystem) {
  const errors = [];
  try {
    await fileSystem.rm(cidfilePath, { force: true });
  } catch (error) {
    errors.push(new Error(`Scratch artifact CID file removal failed: ${redactDiagnostic(error?.message || error)}`));
  }
  try {
    await fileSystem.lstat(cidfilePath);
    errors.push(new Error("Scratch artifact CID file remained after cleanup."));
  } catch (error) {
    if (error?.code !== "ENOENT") errors.push(sanitizeError(error));
  }
  return errors;
}

function inspectExactOwnedContainer(processRunner, {
  cid,
  containerName,
  ownershipLabelKey,
  ownershipLabelValue,
}) {
  const inspection = invokeProcess(processRunner, "docker", ["container", "inspect", cid]);
  if (inspection?.error || inspection?.status !== 0) {
    return {
      owned: false,
      error: exactMissingContainerResult(inspection, cid)
        ? new Error("The CID-bound scratch artifact container was absent during ownership reconciliation.")
        : processFailure("Scratch artifact CID ownership inspection", inspection),
    };
  }
  let records;
  try {
    records = JSON.parse(String(inspection.stdout ?? ""));
  } catch {
    return { owned: false, error: new Error("Scratch artifact CID ownership inspection returned invalid JSON.") };
  }
  const record = Array.isArray(records) && records.length === 1 ? records[0] : null;
  const owned = Boolean(
    record
    && record.Id === cid
    && record.Name === `/${containerName}`
    && record.Image === PINNED.imageId
    && record.Config?.Image === PINNED.imageReference
    && record.Config?.Labels?.[ownershipLabelKey] === ownershipLabelValue
    && record.Path === "/"
    && Array.isArray(record.Args)
    && record.Args.length === 0
    && record.State?.Status === "created"
  );
  return {
    owned,
    error: owned ? null : new Error(
      "Scratch artifact CID ownership inspection did not match the exact CID, name, nonce label, image, command, and created-state contract.",
    ),
  };
}

async function copyPinnedArtifactsUnsafe(temporaryRoot, {
  processRunner = runLocalProcess,
  fileSystem = defaultFileSystem,
} = {}) {
  const imageId = runChecked(
    processRunner,
    "Pinned scratch image inspection",
    "docker",
    ["image", "inspect", PINNED.imageReference, "--format", "{{.Id}}"],
  );
  assertValue(imageId, PINNED.imageId, "local scratch image ID");

  const containerName = `oda-layout-oracle-${randomBytes(12).toString("hex")}`;
  const ownershipLabelKey = "org.open-document-alliance.pdf-tools.layout-oracle";
  const ownershipLabelValue = randomBytes(32).toString("hex");
  const cidfilePath = path.join(temporaryRoot, `.docker-cid-${randomBytes(16).toString("hex")}`);
  await assertCidfileInitiallyAbsent(cidfilePath, fileSystem);
  const preflight = invokeProcess(processRunner, "docker", ["container", "inspect", containerName]);
  if (preflight?.status === 0 && !preflight?.error) {
    throw new Error("Scratch artifact container name was already in use before create; no existing resource was modified.");
  }
  if (!exactMissingContainerResult(preflight, containerName)) {
    throw processFailure("Scratch artifact container preflight absence verification", preflight);
  }

  const creation = invokeProcess(processRunner, "docker", [
    "create",
    "--pull=never",
    "--name",
    containerName,
    "--label",
    `${ownershipLabelKey}=${ownershipLabelValue}`,
    "--cidfile",
    cidfilePath,
    PINNED.imageReference,
    "/",
  ]);
  const createClassification = classifyCreateResult(creation);
  let primaryError = null;
  const cleanupErrors = [];
  let candidateCid = null;
  let removedOwnedContainer = false;
  try {
    if (createClassification !== "success") {
      primaryError = processFailure("Scratch artifact container creation", creation);
    }

    const cidfile = await readTrustedCidfile(cidfilePath, fileSystem);
    if (createClassification === "known_failure") {
      if (cidfile.kind !== "missing") {
        cleanupErrors.push(new Error(
          "A known failed Docker create produced or raced with a CID file; ownership was denied and no container was removed.",
        ));
      }
    } else if (cidfile.kind !== "valid") {
      cleanupErrors.push(...cidfile.errors);
      cleanupErrors.push(new Error(
        `Docker create was ${createClassification} but its trusted CID file was ${cidfile.kind}; ownership remained unresolved and no container was removed.`,
      ));
    } else {
      candidateCid = cidfile.cid;
      if (createClassification === "success") {
        const creationStdout = String(creation.stdout ?? "");
        if (
          Buffer.byteLength(creationStdout, "utf8") > 256
          || !/^[a-f0-9]{64}\n?$/.test(creationStdout)
          || creationStdout.trim() !== candidateCid
        ) {
          primaryError = new Error("Scratch artifact container creation stdout did not exactly match the trusted CID file.");
        }
      }
      const ownership = inspectExactOwnedContainer(processRunner, {
        cid: candidateCid,
        containerName,
        ownershipLabelKey,
        ownershipLabelValue,
      });
      if (!ownership.owned) {
        cleanupErrors.push(ownership.error);
        candidateCid = null;
      }
    }

    if (!primaryError && cleanupErrors.length === 0 && candidateCid) {
      for (const file of ["qpdf.mjs", "qpdf.wasm"]) {
        runChecked(
          processRunner,
          `Scratch artifact copy for ${file}`,
          "docker",
          ["cp", `${candidateCid}:/${file}`, path.join(temporaryRoot, file)],
        );
      }
    }
  } catch (error) {
    primaryError = sanitizeError(error);
  } finally {
    if (candidateCid) {
      const freshOwnership = inspectExactOwnedContainer(processRunner, {
        cid: candidateCid,
        containerName,
        ownershipLabelKey,
        ownershipLabelValue,
      });
      if (!freshOwnership.owned) {
        cleanupErrors.push(new Error(
          `Scratch artifact ownership changed before removal; the resource was preserved. ${freshOwnership.error.message}`,
        ));
      } else {
        const removal = invokeProcess(processRunner, "docker", ["rm", "--force", candidateCid]);
        if (removal?.error || removal?.status !== 0) {
          cleanupErrors.push(processFailure("Scratch artifact container removal", removal));
        } else {
          removedOwnedContainer = true;
        }
      }
    }
    cleanupErrors.push(...await cleanupCidfile(cidfilePath, fileSystem));
  }

  if (candidateCid && removedOwnedContainer) {
    const cidInspection = invokeProcess(processRunner, "docker", ["container", "inspect", candidateCid]);
    if (!exactMissingContainerResult(cidInspection, candidateCid)) {
      cleanupErrors.push(
        cidInspection?.status === 0 && !cidInspection?.error
          ? new Error("The exact CID-bound scratch artifact container remained after removal.")
          : processFailure("Scratch artifact CID absence verification", cidInspection),
      );
    }
  }
  const nameInspection = invokeProcess(processRunner, "docker", ["container", "inspect", containerName]);
  if (!exactMissingContainerResult(nameInspection, containerName)) {
    cleanupErrors.push(
      nameInspection?.status === 0 && !nameInspection?.error
        ? new Error("A container occupied the trusted scratch name after reconciliation; it was not removed without exact current ownership proof.")
        : processFailure("Scratch artifact name absence verification", nameInspection),
    );
  }
  if (cleanupErrors.length > 0) {
    throw aggregateWithDetails(
      "Scratch artifact extraction did not complete with verified cleanup.",
      [primaryError, ...cleanupErrors],
    );
  }
  if (primaryError) throw primaryError;

  const files = (await fileSystem.readdir(temporaryRoot)).sort();
  assertValue(files, ["qpdf.mjs", "qpdf.wasm"], "temporary artifact inventory");
  const contracts = {
    "qpdf.mjs": { bytes: PINNED.qpdfMjsBytes, sha256: PINNED.qpdfMjsSha256 },
    "qpdf.wasm": { bytes: PINNED.qpdfWasmBytes, sha256: PINNED.qpdfWasmSha256 },
  };
  for (const [file, contract] of Object.entries(contracts)) {
    const filePath = path.join(temporaryRoot, file);
    const bytes = await fileSystem.readFile(filePath);
    assertValue((await fileSystem.stat(filePath)).size, contract.bytes, `${file} bytes`);
    assertValue(sha256(bytes), contract.sha256, `${file} sha256`);
  }
}

export async function copyPinnedArtifacts(...args) {
  try {
    return await copyPinnedArtifactsUnsafe(...args);
  } catch (error) {
    throw sanitizeError(error);
  }
}

function boundedLineCapture(streamName) {
  const lines = [];
  let capturedBytes = 0;
  let totalBytes = 0;
  let lineCount = 0;
  let exceeded = false;
  return {
    lines,
    write(value) {
      const line = String(value);
      const separatorBytes = lineCount === 0 ? 0 : 1;
      lineCount += 1;
      const lineBytes = Buffer.byteLength(line, "utf8");
      totalBytes = Math.min(Number.MAX_SAFE_INTEGER, totalBytes + separatorBytes + lineBytes);
      if (exceeded || capturedBytes + separatorBytes + lineBytes > QPDF_STREAM_BYTE_CAP) {
        exceeded = true;
        return;
      }
      lines.push(line);
      capturedBytes += separatorBytes + lineBytes;
    },
    assertWithinLimit() {
      if (!exceeded) return;
      const preview = redactDiagnostic(lines.join("\n"));
      throw sanitizeError(new Error(
        `QPDF ${streamName} exceeded the ${QPDF_STREAM_BYTE_CAP}-byte hard cap after draining ${totalBytes} bytes.${preview ? ` Captured preview: ${preview}` : ""}`,
      ));
    },
  };
}

function cleanupQpdfVirtualFiles(qpdf, args, inputs) {
  if (typeof qpdf?.FS?.unlink !== "function") return [];
  const cleanupErrors = [];
  const candidates = new Set([
    ...Object.keys(inputs),
    ...args.filter(value => typeof value === "string" && /^\/[^\0]*\.pdf$/i.test(value)),
  ]);
  for (const filePath of candidates) {
    try {
      qpdf.FS.unlink(filePath);
    } catch (error) {
      cleanupErrors.push(new Error(
        `QPDF virtual file cleanup failed for ${filePath}: ${redactDiagnostic(error?.message || error)}`,
      ));
    }
  }
  return cleanupErrors;
}

function throwQpdfFailure(primaryError, qpdf, args, inputs) {
  const cleanupErrors = cleanupQpdfVirtualFiles(qpdf, args, inputs);
  if (cleanupErrors.length > 0) {
    throw aggregateWithDetails(
      "QPDF execution failed and virtual filesystem cleanup was incomplete.",
      [primaryError, ...cleanupErrors],
    );
  }
  throw sanitizeError(primaryError);
}

async function instantiateQpdfWithStableProgram(createQpdf, options) {
  const previousFactory = qpdfFactoryQueue;
  let releaseFactory;
  qpdfFactoryQueue = new Promise(resolve => {
    releaseFactory = resolve;
  });
  await previousFactory;
  const originalArgv = [...process.argv];
  try {
    process.argv = [originalArgv[0] ?? process.execPath, "generate-layout-encrypted-oracle.mjs"];
    return await createQpdf(options);
  } finally {
    process.argv = originalArgv;
    releaseFactory();
  }
}

export async function runQpdf(createQpdf, args, inputs = {}) {
  const stdout = boundedLineCapture("stdout");
  const stderr = boundedLineCapture("stderr");
  let qpdf;
  try {
    qpdf = await instantiateQpdfWithStableProgram(createQpdf, {
      thisProgram: "generate-layout-encrypted-oracle.mjs",
      print: line => stdout.write(line),
      printErr: line => stderr.write(line),
    });
    for (const [filePath, bytes] of Object.entries(inputs)) qpdf.FS.writeFile(filePath, bytes);
  } catch (error) {
    throwQpdfFailure(error, qpdf, args, inputs);
  }
  let status;
  let exitedWithIntegerStatus = false;
  try {
    status = qpdf.callMain([...args]);
  } catch (error) {
    if (!Number.isInteger(error?.status)) {
      throwQpdfFailure(error, qpdf, args, inputs);
    }
    status = error.status;
    exitedWithIntegerStatus = true;
  }
  const outputErrors = [];
  try {
    stdout.assertWithinLimit();
  } catch (error) {
    outputErrors.push(error);
  }
  try {
    stderr.assertWithinLimit();
  } catch (error) {
    outputErrors.push(error);
  }
  const statusError = !Number.isInteger(status)
    ? new Error("QPDF callMain returned a non-integer status.")
    : status !== 0
      ? new Error(`QPDF exited with nonzero status ${status}.`)
      : null;
  if (outputErrors.length > 0 || statusError) {
    const cleanupErrors = cleanupQpdfVirtualFiles(qpdf, args, inputs);
    const failures = [
      ...outputErrors,
      ...(statusError ? [statusError] : []),
      ...cleanupErrors,
    ];
    if (failures.length > 1) {
      throw aggregateWithDetails(
        "QPDF execution failed and virtual filesystem cleanup was evaluated.",
        failures,
      );
    }
    throw sanitizeError(failures[0]);
  }
  if (exitedWithIntegerStatus) {
    const cleanupErrors = cleanupQpdfVirtualFiles(qpdf, args, inputs);
    if (cleanupErrors.length > 0) {
      throw aggregateWithDetails(
        "QPDF zero-status thrown exit cleanup was incomplete.",
        cleanupErrors,
      );
    }
  }
  return {
    status,
    stdout: stdout.lines,
    stderr: stderr.lines,
    readOutput(filePath) {
      if (exitedWithIntegerStatus) return null;
      try {
        return Buffer.from(qpdf.FS.readFile(filePath));
      } catch {
        return null;
      }
    },
  };
}

async function readPinnedRepositoryInputs(fileSystem) {
  const sourceBytes = await fileSystem.readFile(path.join(REPO_ROOT, PINNED.sourcePath));
  assertValue(sourceBytes.length, PINNED.sourceBytes, "source bytes");
  assertValue(sha256(sourceBytes), PINNED.sourceSha256, "source sha256");
  const committedFixture = await fileSystem.readFile(path.join(REPO_ROOT, PINNED.fixturePath));
  assertValue(committedFixture.length, PINNED.fixtureBytes, "committed fixture bytes");
  assertValue(sha256(committedFixture), PINNED.fixtureSha256, "committed fixture sha256");
  return { sourceBytes, committedFixture };
}

async function assertRepositoryInputsUnchanged(fileSystem, baseline, stage) {
  const current = await readPinnedRepositoryInputs(fileSystem);
  if (!current.sourceBytes.equals(baseline.sourceBytes)) {
    throw new Error(`Pinned source fixture changed ${stage}.`);
  }
  if (!current.committedFixture.equals(baseline.committedFixture)) {
    throw new Error(`Committed encrypted fixture changed ${stage}.`);
  }
}

function expectedProverReport(provenance, runs = provenance.generation.runs) {
  return {
    schema_version: 1,
    fixture_id: provenance.fixture_id,
    image_id_sha256: PINNED.imageId,
    qpdf_version: PINNED.version,
    qpdf_version_stdout_sha256: PINNED.versionStdoutSha256,
    artifact_sha256: {
      "qpdf.mjs": PINNED.qpdfMjsSha256,
      "qpdf.wasm": PINNED.qpdfWasmSha256,
    },
    runs,
    byte_identical_across_two_runs: true,
    aes_128_revision_4_dictionary_verified: true,
    reversible_header_transform_verified: true,
    committed_fixture_match: true,
    scratch_container_cleanup_verified: true,
  };
}

function assertProverReport(report, provenance) {
  assertProvenanceContractUnsafe(provenance);
  assertValue(report, expectedProverReport(provenance), "fixture prover report");
  return true;
}

async function provePinnedFixture(temporaryRoot, provenance, {
  processRunner = runLocalProcess,
  fileSystem = defaultFileSystem,
} = {}) {
  const baseline = await readPinnedRepositoryInputs(fileSystem);
  await copyPinnedArtifacts(temporaryRoot, { processRunner, fileSystem });
  const moduleUrl = pathToFileURL(path.join(temporaryRoot, "qpdf.mjs")).href;
  const createQpdf = (await import(moduleUrl)).default;
  const versionRun = await runQpdf(createQpdf, ["--version"]);
  assertValue(versionRun.status, 0, "QPDF version status");
  assertValue(versionRun.stderr, [], "QPDF version stderr");
  const versionStdoutSha256 = sha256(versionRun.stdout.join("\n"));
  if (versionStdoutSha256 !== PINNED.versionStdoutSha256) {
    throw new Error(
      `QPDF version stdout drifted to sha256 ${versionStdoutSha256}: ${JSON.stringify(versionRun.stdout)}.`,
    );
  }
  assertValue(versionRun.stdout, PINNED.versionStdout, "QPDF version stdout");
  await assertRepositoryInputsUnchanged(fileSystem, baseline, "after copied QPDF JavaScript execution");

  const generatedRuns = [];
  for (let runNumber = 1; runNumber <= 2; runNumber += 1) {
    const qpdfRun = await runQpdf(createQpdf, QPDF_ARGUMENTS, { "/input.pdf": baseline.sourceBytes });
    assertValue(qpdfRun.status, 0, `run ${runNumber} status`);
    assertValue(qpdfRun.stdout, [], `run ${runNumber} stdout`);
    assertValue(qpdfRun.stderr, [], `run ${runNumber} stderr`);
    const secretSurface = JSON.stringify({ stdout: qpdfRun.stdout, stderr: qpdfRun.stderr });
    for (const password of Object.values(provenance.passwords)) {
      if (secretSurface.includes(password)) throw new Error(`QPDF run ${runNumber} exposed a test password.`);
    }
    const intermediate = qpdfRun.readOutput("/encrypted.pdf");
    if (!intermediate) throw new Error(`QPDF run ${runNumber} did not create the encrypted fixture.`);
    assertValue(intermediate.length, PINNED.fixtureBytes, `run ${runNumber} intermediate bytes`);
    assertValue(sha256(intermediate), PINNED.intermediateSha256, `run ${runNumber} intermediate sha256`);
    const encryptionDictionary = intermediate.toString("latin1");
    for (const token of [
      "/Filter /Standard",
      "/V 4",
      "/R 4",
      "/Length 128",
      "/CFM /AESV2",
      "/StmF /StdCF",
      "/StrF /StdCF",
    ]) {
      if (!encryptionDictionary.includes(token)) {
        throw new Error(`Run ${runNumber} lacked the pinned AES-128 revision 4 marker ${token}.`);
      }
    }

    const finalFixture = replaceExactHeader(intermediate, PINNED.clearHeader, PINNED.oracleHeader);
    const restoredIntermediate = replaceExactHeader(finalFixture, PINNED.oracleHeader, PINNED.clearHeader);
    if (!restoredIntermediate.equals(intermediate)) throw new Error(`Run ${runNumber} header transform was not reversible.`);
    assertValue(finalFixture.length, PINNED.fixtureBytes, `run ${runNumber} final bytes`);
    assertValue(sha256(finalFixture), PINNED.fixtureSha256, `run ${runNumber} final sha256`);
    if (!finalFixture.equals(baseline.committedFixture)) throw new Error(`Run ${runNumber} did not match the committed fixture bytes.`);
    const runRecord = {
      run: runNumber,
      input_sha256: sha256(baseline.sourceBytes),
      qpdf_intermediate_bytes: intermediate.length,
      qpdf_intermediate_sha256: sha256(intermediate),
      final_fixture_bytes: finalFixture.length,
      final_fixture_sha256: sha256(finalFixture),
    };
    const runRecordSha256 = sha256(JSON.stringify(runRecord));
    assertValue(runRecordSha256, PINNED.runRecordSha256[runNumber - 1], `run ${runNumber} record sha256`);
    generatedRuns.push({ ...runRecord, run_record_sha256: runRecordSha256 });
    await assertRepositoryInputsUnchanged(fileSystem, baseline, `after QPDF encryption run ${runNumber}`);
  }
  assertValue(generatedRuns, provenance.generation.runs, "generated run ledger");
  return expectedProverReport(provenance, generatedRuns);
}

async function missing(target, fileSystem) {
  try {
    await fileSystem.access(target);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

export async function generateLayoutEncryptedOracle({
  provenance = null,
  temporaryParent = os.tmpdir(),
  fileSystem = defaultFileSystem,
  processRunner = runLocalProcess,
} = {}) {
  const usesUnverifiedSeams = fileSystem !== defaultFileSystem || processRunner !== runLocalProcess;
  let temporaryRoot;
  try {
    temporaryRoot = await fileSystem.mkdtemp(path.join(temporaryParent, "oda-layout-encrypted-oracle-"));
  } catch (error) {
    throw sanitizeError(error);
  }
  let report = null;
  let primaryError = null;
  const cleanupErrors = [];
  try {
    const resolvedProvenance = provenance ?? JSON.parse(await fileSystem.readFile(PROVENANCE_PATH, "utf8"));
    assertProvenanceContract(resolvedProvenance);
    const candidateReport = await provePinnedFixture(temporaryRoot, resolvedProvenance, { fileSystem, processRunner });
    assertProverReport(candidateReport, resolvedProvenance);
    if (usesUnverifiedSeams) {
      throw new Error("Injected process or filesystem seams are non-verifying and cannot emit a certified report.");
    }
    report = candidateReport;
  } catch (error) {
    primaryError = sanitizeError(error);
  } finally {
    try {
      await fileSystem.rm(temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(sanitizeError(error));
    }
  }
  try {
    if (!(await missing(temporaryRoot, fileSystem))) {
      cleanupErrors.push(new Error("Encrypted layout oracle temporary directory remained after cleanup."));
    }
  } catch (error) {
    cleanupErrors.push(sanitizeError(error));
  }
  if (cleanupErrors.length > 0) {
    throw aggregateWithDetails(
      "Encrypted layout oracle did not complete with verified temporary cleanup.",
      [primaryError, ...cleanupErrors],
    );
  }
  if (primaryError) throw sanitizeError(primaryError);
  return { ...report, temporary_directory_cleanup_verified: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  generateLayoutEncryptedOracle()
    .then(report => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch(error => {
      const sanitized = sanitizeError(error);
      process.stderr.write(`Encrypted layout oracle verification failed: ${sanitized.message}\n`);
      process.exitCode = 1;
    });
}
