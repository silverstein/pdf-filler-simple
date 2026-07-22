import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256 } from "./extraction-phase1-protocol.js";
import { compareUnicodeCodePoints } from "./extraction-phase1-artifacts.js";
import {
  buildGenerationPrivacyAttestation,
  createCrossDeviceReceipt,
  generationProhibitedRootSetSha256,
  verifyFinalGenerationPrivacy,
  verifyCrossDeviceReceipt,
} from "./extraction-phase1-companion.js";

export const PHASE1_EXECUTION_INDEX_ID = "pdf-tools.extraction-phase1-execution-index.v1";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;
const SAFE_ROLE = /^[a-z][a-z0-9_]{0,63}$/;
const GENERATION_KINDS = new Set(["execution", "received_execution", "received_score", "score"]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INDEX_KEYS = ["artifacts", "claim_ready", "index_content_sha256", "index_id", "index_version", "kind", "run_id", "source_generation_sha256", "state", "transaction_id"];
const SCORE_PROVENANCE_BINDING_KEYS = [
  "execution_report_bytes_sha256", "execution_report_sha256", "oracle_bytes_sha256", "oracle_schema_sha256",
  "oracle_sha256", "layout_oracle_bytes_sha256", "layout_oracle_schema_sha256", "layout_oracle_sha256", "phase0_manifest_sha256", "preflight_evidence_bytes_sha256", "preflight_evidence_sha256",
  "score_schema_sha256", "scorer_contract_sha256", "scorer_source_set_sha256",
];

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
}

function indexContentSha256(index) {
  const { index_content_sha256: ignored, ...content } = index;
  return sha256(Buffer.from(`pdf-tools.extraction-phase1-execution-index.v1\0${canonicalJson(content)}`));
}

export function computeGenerationSha256(index, indexBytes) {
  if (!validateIndex(index) || !Buffer.isBuffer(indexBytes)
    || !indexBytes.equals(Buffer.from(`${JSON.stringify(index, null, 2)}\n`))) throw new Error("Generation digest requires a valid canonical index");
  return sha256(Buffer.from(`pdf-tools.extraction-generation.v1\0${canonicalJson({ index, index_raw_sha256: sha256(indexBytes) })}`));
}

function validateIndex(index) {
  if (!exactKeys(index, INDEX_KEYS) || index.index_id !== PHASE1_EXECUTION_INDEX_ID || index.index_version !== 1
    || index.state !== "complete" || index.claim_ready !== false || !/^[a-f0-9]{64}$/.test(index.run_id)
    || !GENERATION_KINDS.has(index.kind) || !UUID_V4.test(index.transaction_id)
    || (index.kind === "execution"
      ? index.source_generation_sha256 !== null
      : !/^[a-f0-9]{64}$/.test(index.source_generation_sha256))
    || !Array.isArray(index.artifacts) || index.artifacts.length === 0
    || index.index_content_sha256 !== indexContentSha256(index)) return false;
  let previousRole = null;
  const paths = new Set();
  for (const artifact of index.artifacts) {
    if (!exactKeys(artifact, ["bytes", "path", "role", "sha256"]) || !SAFE_ROLE.test(artifact.role)
      || !SAFE_FILENAME.test(artifact.path) || !Number.isInteger(artifact.bytes) || artifact.bytes < 1
      || !/^[a-f0-9]{64}$/.test(artifact.sha256) || paths.has(artifact.path.toLowerCase())
      || (previousRole !== null && compareUnicodeCodePoints(previousRole, artifact.role) >= 0)) return false;
    previousRole = artifact.role;
    paths.add(artifact.path.toLowerCase());
  }
  return true;
}

async function inject(faultInjector, phase, context = {}) {
  if (faultInjector) await faultInjector(phase, context);
}

async function fsyncDirectory(directory) {
  const handle = await fs.open(directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertRealDirectory(directory, expectedMode = null) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Generation path is not a real directory: ${directory}`);
  if (expectedMode !== null && (stat.mode & 0o777) !== expectedMode) throw new Error(`Generation directory has an unsafe mode: ${directory}`);
  return stat;
}

async function acquireOrVerifyClaim(claimPath, transactionId, { adoptExisting = false } = {}) {
  const expected = Buffer.from(`${transactionId}\n`);
  let handle;
  let created = false;
  try {
    handle = await fs.open(claimPath, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    created = true;
    await handle.writeFile(expected);
    await handle.sync();
  } catch (error) {
    if (error?.code !== "EEXIST" || !adoptExisting) throw error;
    handle = await fs.open(claimPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!before.isFile() || Number(before.mode & 0o777n) !== 0o600 || !bytes.equals(expected)
      || String(before.dev) !== String(after.dev) || String(before.ino) !== String(after.ino)
      || String(before.size) !== String(after.size) || String(before.mtimeNs) !== String(after.mtimeNs)
      || String(before.ctimeNs) !== String(after.ctimeNs)) throw new Error("Generation claim is invalid or changed while verified");
  } finally {
    if (handle) await handle.close();
  }
  return { created };
}

function safeArtifactRecords(artifacts) {
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts) || Object.keys(artifacts).length === 0) throw new Error("Generation requires at least one artifact");
  const records = Object.entries(artifacts).map(([role, item]) => {
    if (!SAFE_ROLE.test(role) || !item || typeof item !== "object" || Array.isArray(item)
      || canonicalJson(Object.keys(item).sort()) !== canonicalJson(["bytes", "filename"])
      || !Buffer.isBuffer(item.bytes) || item.bytes.length === 0 || !SAFE_FILENAME.test(item.filename)) {
      throw new Error(`Invalid generation artifact: ${role}`);
    }
    return { role, filename: item.filename, bytes: item.bytes };
  });
  records.sort((a, b) => compareUnicodeCodePoints(a.role, b.role));
  if (new Set(records.map(item => item.filename.toLowerCase())).size !== records.length) throw new Error("Generation artifact filenames collide");
  return records;
}

async function writeVerifiedFile(directory, record, faultInjector, isIndex = false) {
  if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("Immutable generation publication requires O_NOFOLLOW support");
  const prefix = isIndex ? "index" : `artifact:${record.role}`;
  const temporaryName = `.${record.filename}.write-${randomUUID()}`;
  const temporaryPath = path.join(directory, temporaryName);
  const finalPath = path.join(directory, record.filename);
  let handle;
  try {
    handle = await fs.open(temporaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(record.bytes);
    await inject(faultInjector, "after_write", { item: prefix });
    await handle.sync();
    await inject(faultInjector, "after_file_fsync", { item: prefix });
  } finally {
    if (handle) await handle.close();
  }
  const verify = await fs.open(temporaryPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await verify.stat();
    const retained = await verify.readFile();
    const after = await verify.stat();
    if (!stat.isFile() || stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size
      || (stat.mode & 0o777) !== 0o600 || retained.length !== record.bytes.length
      || sha256(retained) !== sha256(record.bytes)) throw new Error(`Generation artifact failed reopen verification: ${record.role}`);
  } finally {
    await verify.close();
  }
  await inject(faultInjector, "before_file_rename", { item: prefix });
  await fs.rename(temporaryPath, finalPath);
  await inject(faultInjector, "after_file_rename", { item: prefix });
  await fsyncDirectory(directory);
  await inject(faultInjector, "after_staging_fsync", { item: prefix });
  return { role: record.role, path: record.filename, bytes: record.bytes.length, sha256: sha256(record.bytes) };
}

async function verifyRetainedArtifacts(directory, records) {
  const directoryBefore = await fs.lstat(directory, { bigint: true });
  if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) throw new Error("Generation staging path is not a real directory");
  const names = await fs.readdir(directory);
  const expected = records.map(item => item.path).sort(compareUnicodeCodePoints);
  if (canonicalJson([...names].sort(compareUnicodeCodePoints)) !== canonicalJson(expected)) throw new Error("Generation staging contains an unexpected, missing, or stale file");
  for (const record of records) {
    const observed = await hashFileNoFollow(path.join(directory, record.path));
    if (observed.bytes !== record.bytes || observed.sha256 !== record.sha256) throw new Error(`Generation artifact changed before commit: ${record.role}`);
  }
  const namesAfter = await fs.readdir(directory);
  const directoryAfter = await fs.lstat(directory, { bigint: true });
  if (!directoryAfter.isDirectory() || directoryAfter.isSymbolicLink()) throw new Error("Generation staging path changed type while verified");
  if (canonicalJson([...namesAfter].sort(compareUnicodeCodePoints)) !== canonicalJson([...names].sort(compareUnicodeCodePoints))) throw new Error("Generation staging file set changed while verified");
  for (const key of ["dev", "ino", "mtimeNs", "ctimeNs"]) {
    if (String(directoryBefore[key]) !== String(directoryAfter[key])) throw new Error("Generation staging directory changed while verified");
  }
}

export async function publishImmutableGeneration({
  parentDirectory,
  runId,
  kind,
  artifacts,
  sourceGenerationSha256 = null,
  transactionId = randomUUID(),
  faultInjector = null,
  preIndexArtifactBuilder = null,
  finalGenerationVerifier = null,
}) {
  if (!/^[a-f0-9]{64}$/.test(runId) || !GENERATION_KINDS.has(kind)
    || !UUID_V4.test(transactionId)
    || (sourceGenerationSha256 !== null && !/^[a-f0-9]{64}$/.test(sourceGenerationSha256))) throw new Error("Generation identity is invalid");
  const parentStat = await assertRealDirectory(parentDirectory);
  const records = safeArtifactRecords(artifacts);
  const stagingName = `.staging-${kind}-${runId}-${transactionId}`;
  const generationName = `${kind}-${runId}-${transactionId}`;
  const stagingPath = path.join(parentDirectory, stagingName);
  const generationPath = path.join(parentDirectory, generationName);
  const claimPath = path.join(parentDirectory, `.claim-${generationName}`);
  await acquireOrVerifyClaim(claimPath, transactionId);
  await fsyncDirectory(parentDirectory);
  try {
    await fs.lstat(generationPath);
    throw new Error("Generation destination identity was precreated or reused");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fs.mkdir(stagingPath, { mode: 0o700 });
  const stagingStat = await assertRealDirectory(stagingPath, 0o700);
  if (stagingStat.dev !== parentStat.dev) throw new Error("Generation staging and destination parent are not on the same filesystem");
  await inject(faultInjector, "after_staging_create", { stagingPath });
  const retained = [];
  for (const record of records) retained.push(await writeVerifiedFile(stagingPath, record, faultInjector));
  if (preIndexArtifactBuilder) {
    const added = await preIndexArtifactBuilder({ stagingPath, artifacts: structuredClone(retained) });
    const [validated] = safeArtifactRecords({ [added.role]: { filename: added.filename, bytes: added.bytes } });
    if (retained.some(item => item.role === validated.role || item.path.toLowerCase() === validated.filename.toLowerCase())) throw new Error("Pre-index artifact collides with an ordinary generation artifact");
    retained.push(await writeVerifiedFile(stagingPath, validated, faultInjector));
    retained.sort((a, b) => compareUnicodeCodePoints(a.role, b.role));
  }
  await verifyRetainedArtifacts(stagingPath, retained);
  await inject(faultInjector, "after_preindex_reinspection", { stagingPath });
  const index = {
    index_id: PHASE1_EXECUTION_INDEX_ID,
    index_version: 1,
    state: "complete",
    claim_ready: false,
    run_id: runId,
    kind,
    transaction_id: transactionId,
    source_generation_sha256: sourceGenerationSha256,
    artifacts: retained,
    index_content_sha256: null,
  };
  index.index_content_sha256 = indexContentSha256(index);
  if (!validateIndex(index)) throw new Error("Generated execution index failed its strict contract");
  const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`);
  await inject(faultInjector, "before_commit_marker", { stagingPath });
  await verifyRetainedArtifacts(stagingPath, retained);
  await writeVerifiedFile(stagingPath, { role: "execution_index", filename: "execution-index.v1.json", bytes: indexBytes }, faultInjector, true);
  await inject(faultInjector, "after_commit_marker", { stagingPath });
  let published = false;
  let finalGenerationSha256 = null;
  try {
    const stagingInspection = await inspectGenerationDirectory(stagingPath, {
      allowStaging: true,
      activeClaimTransactionId: transactionId,
    });
    if (stagingInspection.state !== "complete") throw new Error(`Staging generation failed exact reinspection: ${stagingInspection.reason}`);
    await runSemanticGenerationVerifier({
      verifier: finalGenerationVerifier,
      generationPath: stagingPath,
      inspection: stagingInspection,
    });
    await inject(faultInjector, "before_final_rename", { stagingPath, generationPath });
    try {
      await fs.lstat(generationPath);
      throw new Error("Generation destination identity was precreated or reused");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fs.rename(stagingPath, generationPath);
    published = true;
    await inject(faultInjector, "after_final_rename", { generationPath });
    const finalInspection = await inspectGenerationDirectory(generationPath, { activeClaimTransactionId: transactionId });
    if (finalInspection.state !== "complete") throw new Error(`Final generation failed exact reinspection: ${finalInspection.reason}`);
    finalGenerationSha256 = finalInspection.generation_sha256;
    await runSemanticGenerationVerifier({
      verifier: finalGenerationVerifier,
      generationPath,
      inspection: finalInspection,
    });
    await fsyncDirectory(parentDirectory);
    await inject(faultInjector, "after_parent_fsync", { generationPath });
    const cleanupInspection = await inspectGenerationDirectory(generationPath, { activeClaimTransactionId: transactionId });
    if (cleanupInspection.state !== "complete") throw new Error(`Final generation changed before claim cleanup: ${cleanupInspection.reason}`);
    await fs.unlink(claimPath);
    await fsyncDirectory(parentDirectory);
  } catch (error) {
    if (published) {
      error.publication_state = "durability_uncertain";
      error.generation_path = generationPath;
    }
    throw error;
  }
  const completedInspection = await inspectGenerationDirectory(generationPath);
  if (completedInspection.state !== "complete" || completedInspection.generation_sha256 !== finalGenerationSha256) {
    throw new Error(`Completed generation failed claim-free reinspection: ${completedInspection.reason ?? "generation_digest_changed"}`);
  }
  await runSemanticGenerationVerifier({ verifier: finalGenerationVerifier, generationPath, inspection: completedInspection });
  return {
    state: "complete",
    generationPath,
    generationName,
    index: completedInspection.index,
    indexBytes: completedInspection.indexBytes,
    generation_sha256: completedInspection.generation_sha256,
  };
}

async function readFileNoFollow(filename, { maxBytes = 16 * 1024 * 1024 } = {}) {
  if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("Immutable generation verification requires O_NOFOLLOW support");
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (before.size > BigInt(maxBytes)) throw new Error("Generation control file exceeds its bounded read limit");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!before.isFile() || String(before.dev) !== String(after.dev) || String(before.ino) !== String(after.ino)
      || String(before.size) !== String(after.size) || String(before.mtimeNs) !== String(after.mtimeNs) || String(before.ctimeNs) !== String(after.ctimeNs)
      || Number(before.mode & 0o777n) !== 0o600 || BigInt(bytes.length) !== before.size) throw new Error("Generation file identity or mode changed while verifying");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function hashFileNoFollow(filename, { onChunk = null } = {}) {
  if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("Immutable generation verification requires O_NOFOLLOW support");
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || Number(before.mode & 0o777n) !== 0o600) throw new Error("Generation file is not a mode-0600 regular file");
    const digest = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      digest.update(chunk.subarray(0, bytesRead));
      bytes += bytesRead;
      if (onChunk) await onChunk(bytesRead);
    }
    const after = await handle.stat({ bigint: true });
    if (String(before.dev) !== String(after.dev) || String(before.ino) !== String(after.ino)
      || String(before.size) !== String(after.size) || String(before.mtimeNs) !== String(after.mtimeNs)
      || String(before.ctimeNs) !== String(after.ctimeNs) || BigInt(bytes) !== before.size) {
      throw new Error("Generation file identity changed while streaming");
    }
    return { bytes, sha256: digest.digest("hex") };
  } finally {
    await handle.close();
  }
}

export async function inspectGenerationDirectory(generationPath, { allowStaging = false, activeClaimTransactionId = null } = {}) {
  await assertRealDirectory(generationPath, 0o700);
  const directoryBefore = await fs.lstat(generationPath, { bigint: true });
  if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) return { state: "corruption", reason: "generation_path_is_not_real_directory" };
  const names = await fs.readdir(generationPath);
  if (!names.includes("execution-index.v1.json")) return { state: "incomplete_ignored", reason: "commit_marker_absent" };
  let indexBytes;
  let index;
  try {
    indexBytes = await readFileNoFollow(path.join(generationPath, "execution-index.v1.json"));
    index = JSON.parse(indexBytes);
  } catch (error) {
    return { state: "corruption", reason: `invalid_commit_marker:${error.code ?? error.message}` };
  }
  if (!validateIndex(index)) return { state: "corruption", reason: "invalid_index_contract" };
  const expectedIndexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`);
  if (!indexBytes.equals(expectedIndexBytes)) return { state: "corruption", reason: "noncanonical_index_bytes" };
  const expectedName = `${index.kind}-${index.run_id}-${index.transaction_id}`;
  const basename = path.basename(generationPath);
  if (basename !== expectedName && !(allowStaging && basename === `.staging-${expectedName}`)) return { state: "corruption", reason: "directory_identity_mismatch" };
  const claimPath = path.join(path.dirname(generationPath), `.claim-${expectedName}`);
  let claimPresent = false;
  try {
    const claimStat = await fs.lstat(claimPath);
    claimPresent = true;
    if (!claimStat.isFile() || claimStat.isSymbolicLink() || (claimStat.mode & 0o777) !== 0o600) return { state: "corruption", reason: "invalid_transaction_claim" };
  } catch (error) {
    if (error?.code !== "ENOENT") return { state: "corruption", reason: "invalid_transaction_claim" };
  }
  if (claimPresent && activeClaimTransactionId === null) return { state: "durability_uncertain", reason: "active_transaction_claim" };
  if (activeClaimTransactionId !== null) {
    if (!claimPresent || activeClaimTransactionId !== index.transaction_id) return { state: "corruption", reason: "active_transaction_claim_mismatch" };
    try {
      await acquireOrVerifyClaim(claimPath, activeClaimTransactionId, { adoptExisting: true });
    } catch {
      return { state: "corruption", reason: "invalid_transaction_claim" };
    }
  }
  const expectedNames = new Set(["execution-index.v1.json"]);
  for (const artifact of index.artifacts) {
    if (expectedNames.has(artifact.path)) return { state: "corruption", reason: "invalid_artifact_record" };
    expectedNames.add(artifact.path);
    try {
      const observed = await hashFileNoFollow(path.join(generationPath, artifact.path));
      if (observed.bytes !== artifact.bytes || observed.sha256 !== artifact.sha256) return { state: "corruption", reason: `artifact_mismatch:${artifact.role}` };
    } catch (error) {
      return { state: "corruption", reason: `artifact_unavailable:${artifact.role}:${error.code ?? error.message}` };
    }
  }
  if (canonicalJson([...names].sort(compareUnicodeCodePoints)) !== canonicalJson([...expectedNames].sort(compareUnicodeCodePoints))) return { state: "corruption", reason: "unexpected_or_missing_file" };
  const namesAfter = await fs.readdir(generationPath);
  const directoryAfter = await fs.lstat(generationPath, { bigint: true });
  if (!directoryAfter.isDirectory() || directoryAfter.isSymbolicLink()) return { state: "corruption", reason: "directory_type_changed_during_verification" };
  if (canonicalJson([...namesAfter].sort(compareUnicodeCodePoints)) !== canonicalJson([...names].sort(compareUnicodeCodePoints))) return { state: "corruption", reason: "directory_file_set_changed_during_verification" };
  for (const key of ["dev", "ino", "mtimeNs", "ctimeNs"]) {
    if (String(directoryBefore[key]) !== String(directoryAfter[key])) return { state: "corruption", reason: "directory_identity_changed_during_verification" };
  }
  return {
    state: "complete",
    index,
    indexBytes,
    generation_sha256: computeGenerationSha256(index, indexBytes),
  };
}

function requiresSemanticGenerationVerification(index) {
  return index.artifacts.some(item => ["privacy_attestation", "received_privacy_attestation"].includes(item.role));
}

function requiresCompositeExtractionVerification(index) {
  return index.artifacts.some(item => item.role === "phase0_corpus");
}

async function runSemanticGenerationVerifier({ verifier, generationPath, inspection }) {
  if (requiresSemanticGenerationVerification(inspection.index) && typeof verifier !== "function") {
    throw new Error("Semantic generation verification is required for privacy-attested artifacts");
  }
  if (verifier) {
    await verifier({
      generationPath,
      index: inspection.index,
      indexBytes: inspection.indexBytes,
    });
  }
}

export async function readVerifiedGenerationArtifact(generationPath, inspection, role, { maxBytes = 16 * 1024 * 1024 } = {}) {
  if (inspection?.state !== "complete" || inspection.index?.artifacts?.every(item => item.role !== role)) {
    throw new Error(`Complete generation does not contain required artifact role: ${role}`);
  }
  const record = inspection.index.artifacts.find(item => item.role === role);
  if (record.bytes > maxBytes) throw new Error(`Generation artifact exceeds bounded control-file limit: ${role}`);
  const bytes = await readFileNoFollow(path.join(generationPath, record.path), { maxBytes });
  if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) throw new Error(`Generation artifact changed after inspection: ${role}`);
  return { record, bytes };
}

async function copyVerifiedArtifactToStaging({ sourcePath, stagingPath, artifact, copyFaultInjector }) {
  const temporaryPath = path.join(stagingPath, `.${artifact.path}.receive-${randomUUID()}`);
  const finalPath = path.join(stagingPath, artifact.path);
  let source;
  let destination;
  try {
    source = await fs.open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const sourceBefore = await source.stat({ bigint: true });
    if (!sourceBefore.isFile() || Number(sourceBefore.mode & 0o777n) !== 0o600) throw new Error(`Source artifact is not a mode-0600 regular file: ${artifact.role}`);
    destination = await fs.open(temporaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    const digest = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (true) {
      const { bytesRead } = await source.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      digest.update(chunk.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(chunk, written, bytesRead - written, null);
        if (result.bytesWritten === 0) throw new Error(`Destination made no progress while receiving: ${artifact.role}`);
        written += result.bytesWritten;
      }
      bytes += bytesRead;
      await inject(copyFaultInjector, "source_chunk", { role: artifact.role, chunk_bytes: bytesRead, copied_bytes: bytes });
    }
    const sourceAfter = await source.stat({ bigint: true });
    if (String(sourceBefore.dev) !== String(sourceAfter.dev) || String(sourceBefore.ino) !== String(sourceAfter.ino)
      || String(sourceBefore.size) !== String(sourceAfter.size) || String(sourceBefore.mtimeNs) !== String(sourceAfter.mtimeNs)
      || String(sourceBefore.ctimeNs) !== String(sourceAfter.ctimeNs) || BigInt(bytes) !== sourceBefore.size
      || bytes !== artifact.bytes || digest.digest("hex") !== artifact.sha256) throw new Error(`Source artifact changed during cross-device copy: ${artifact.role}`);
    await destination.sync();
  } catch (error) {
    if (destination) await destination.close().catch(() => {});
    if (source) await source.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  await destination.close();
  await source.close();
  const reopened = await hashFileNoFollow(temporaryPath, {
    onChunk: chunkBytes => inject(copyFaultInjector, "destination_verify_chunk", { role: artifact.role, chunk_bytes: chunkBytes }),
  });
  if (reopened.bytes !== artifact.bytes || reopened.sha256 !== artifact.sha256) throw new Error(`Destination artifact failed reopen verification: ${artifact.role}`);
  await fs.rename(temporaryPath, finalPath);
  await fsyncDirectory(stagingPath);
  return { role: artifact.role, path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256 };
}

async function deriveSourceCodeIdentity(generationPath, inspection) {
  const role = inspection.index.kind === "execution" ? "execution_companion" : "score_provenance";
  const artifact = await readVerifiedGenerationArtifact(generationPath, inspection, role);
  let retained;
  try {
    retained = JSON.parse(artifact.bytes);
  } catch {
    throw new Error("Source generation code identity artifact is not JSON");
  }
  if (!artifact.bytes.equals(Buffer.from(`${JSON.stringify(retained, null, 2)}\n`))) throw new Error("Source generation code identity artifact is not canonical");
  let identity;
  if (inspection.index.kind === "execution") {
    if (retained.companion_id !== "pdf-tools.extraction-phase1-execution-companion.v1" || retained.companion_version !== 1
      || retained.report?.run_id !== inspection.index.run_id || retained.report?.report_id !== "pdf-tools.extraction-phase1-report.v1") {
      throw new Error("Execution source companion identity is invalid");
    }
    identity = { kind: "execution_direct_source_set_sha256", sha256: retained.direct_source_set_sha256, source_artifact_role: role };
  } else {
    const scoreReportRecord = inspection.index.artifacts.find(item => item.role === "score_report");
    if (!exactKeys(retained, ["bindings", "claim_ready", "index_id", "index_version", "score_report"])
      || retained.index_id !== "pdf-tools.extraction-phase1-score-index.v1" || retained.index_version !== 1
      || retained.claim_ready !== false || !exactKeys(retained.bindings, SCORE_PROVENANCE_BINDING_KEYS)
      || Object.values(retained.bindings).some(value => !/^[a-f0-9]{64}$/.test(value))
      || !exactKeys(retained.score_report, ["bytes", "path", "sha256"])
      || !Number.isInteger(retained.score_report.bytes) || retained.score_report.bytes < 1
      || !/^[a-f0-9]{64}$/.test(retained.score_report.sha256)
      || !scoreReportRecord || canonicalJson(retained.score_report) !== canonicalJson({
        path: scoreReportRecord.path,
        bytes: scoreReportRecord.bytes,
        sha256: scoreReportRecord.sha256,
      })) {
      throw new Error("Score source provenance identity is invalid");
    }
    identity = { kind: "score_scorer_source_set_sha256", sha256: retained.bindings.scorer_source_set_sha256, source_artifact_role: role };
  }
  if (!/^[a-f0-9]{64}$/.test(identity.sha256)) throw new Error("Source generation code identity is unavailable or invalid");
  return identity;
}

export async function receiveVerifiedGeneration({
  sourceGenerationPath,
  destinationParentDirectory,
  sourceHost,
  destinationHost,
  transportedAt,
  transport,
  transactionId = randomUUID(),
  keyId = null,
  signature = null,
  trustedSignatureVerifier = null,
  trustedSourceProhibitedRootSetSha256 = null,
  destinationTrustedProhibitedRoots = [],
  copyFaultInjector = null,
  publicationFaultInjector = null,
  semanticVerifier = null,
}) {
  if (!UUID_V4.test(transactionId)) throw new Error("Cross-device receive transaction identity is invalid");
  const realSourceGenerationPath = await fs.realpath(path.resolve(sourceGenerationPath));
  const sourceBefore = await inspectGenerationDirectory(realSourceGenerationPath);
  if (sourceBefore.state !== "complete" || !["execution", "score"].includes(sourceBefore.index.kind)) {
    throw new Error("Cross-device receive requires a complete original execution or score generation");
  }
  if (requiresCompositeExtractionVerification(sourceBefore.index) && typeof semanticVerifier !== "function") {
    throw new Error("Cross-device receive requires a composite extraction semantic verifier");
  }
  if (requiresCompositeExtractionVerification(sourceBefore.index)) {
    await runSemanticGenerationVerifier({ verifier: semanticVerifier, generationPath: realSourceGenerationPath, inspection: sourceBefore });
  }
  const sourcePrivacyArtifact = await readVerifiedGenerationArtifact(realSourceGenerationPath, sourceBefore, "privacy_attestation");
  const sourcePrivacyAttestation = JSON.parse(sourcePrivacyArtifact.bytes);
  if (!sourcePrivacyArtifact.bytes.equals(Buffer.from(`${JSON.stringify(sourcePrivacyAttestation, null, 2)}\n`))) throw new Error("Source generation privacy evidence is not canonical");
  await verifyFinalGenerationPrivacy({ generationPath: realSourceGenerationPath, index: sourceBefore.index, privacyAttestation: sourcePrivacyAttestation });
  const publicSourceRootSetSha256 = generationProhibitedRootSetSha256([]);
  const expectedSourceRootSetSha256 = trustedSourceProhibitedRootSetSha256 ?? publicSourceRootSetSha256;
  if (!/^[a-f0-9]{64}$/.test(expectedSourceRootSetSha256)
    || sourcePrivacyAttestation.prohibited_root_set_sha256 !== expectedSourceRootSetSha256) {
    throw new Error("Transfer prohibited roots do not match source generation privacy evidence");
  }
  if (sourcePrivacyAttestation.policy !== "public_synthetic") {
    if (trustedSourceProhibitedRootSetSha256 === null
      || !Array.isArray(destinationTrustedProhibitedRoots) || destinationTrustedProhibitedRoots.length === 0) {
      throw new Error("Private transfer requires distinct trusted source and destination prohibited-root evidence");
    }
    const realRepo = await fs.realpath(REPO_ROOT);
    const realRoots = await Promise.all(destinationTrustedProhibitedRoots.map(item => fs.realpath(item)));
    if (!realRoots.some(root => realRepo === root || realRepo.startsWith(`${root}${path.sep}`))) throw new Error("Private transfer prohibited roots must cover the repository and package root");
    const realDestination = await fs.realpath(destinationParentDirectory);
    for (const prohibited of realRoots) {
      if (realSourceGenerationPath === prohibited || realSourceGenerationPath.startsWith(`${prohibited}${path.sep}`)
        || realDestination === prohibited || realDestination.startsWith(`${prohibited}${path.sep}`)) {
        throw new Error("Private transfer source or destination overlaps a trusted prohibited repository, sync, share, or package root");
      }
    }
  }
  const realDestinationParent = await fs.realpath(destinationParentDirectory);
  const realRepo = await fs.realpath(REPO_ROOT);
  if (realDestinationParent === realRepo || realDestinationParent.startsWith(`${realRepo}${path.sep}`)) throw new Error("Received generations must remain outside the repository and package root");
  const receivedKind = sourceBefore.index.kind === "execution" ? "received_execution" : "received_score";
  const sourceCodeIdentity = await deriveSourceCodeIdentity(realSourceGenerationPath, sourceBefore);
  const parentStat = await assertRealDirectory(destinationParentDirectory);
  const generationName = `${receivedKind}-${sourceBefore.index.run_id}-${transactionId}`;
  const stagingPath = path.join(destinationParentDirectory, `.staging-${generationName}`);
  const generationPath = path.join(destinationParentDirectory, generationName);
  const claimPath = path.join(destinationParentDirectory, `.claim-${generationName}`);
  await acquireOrVerifyClaim(claimPath, transactionId);
  await fsyncDirectory(destinationParentDirectory);
  try {
    await fs.lstat(generationPath);
    throw new Error("Generation destination identity was precreated or reused");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fs.mkdir(stagingPath, { mode: 0o700 });
  const stagingStat = await assertRealDirectory(stagingPath, 0o700);
  if (stagingStat.dev !== parentStat.dev) throw new Error("Received generation staging and destination parent are not on the same filesystem");
  await inject(publicationFaultInjector, "after_staging_create", { stagingPath });
  const retained = [];
  for (const artifact of sourceBefore.index.artifacts) {
    if (artifact.role === "transfer_receipt") throw new Error("Cross-device receive does not recursively receive a receipt-bearing generation");
    await inject(copyFaultInjector, "before_source_artifact_copy", { role: artifact.role, path: artifact.path });
    retained.push(await copyVerifiedArtifactToStaging({
      sourcePath: path.join(realSourceGenerationPath, artifact.path), stagingPath, artifact, copyFaultInjector,
    }));
    await inject(copyFaultInjector, "after_source_artifact_copy", { role: artifact.role, path: artifact.path });
    await inject(publicationFaultInjector, "after_destination_artifact_copy", { role: artifact.role, path: artifact.path, stagingPath });
  }
  const sourceAfter = await inspectGenerationDirectory(realSourceGenerationPath);
  if (sourceAfter.state !== "complete" || sourceAfter.generation_sha256 !== sourceBefore.generation_sha256
    || !sourceAfter.indexBytes.equals(sourceBefore.indexBytes)) throw new Error("Source generation changed during cross-device copy");
  if (requiresCompositeExtractionVerification(sourceAfter.index)) {
    await runSemanticGenerationVerifier({ verifier: semanticVerifier, generationPath: realSourceGenerationPath, inspection: sourceAfter });
  }
  await inject(copyFaultInjector, "after_source_generation_reinspection", { sourceGenerationPath: realSourceGenerationPath });
  const receipt = createCrossDeviceReceipt({
    runId: sourceBefore.index.run_id, indexBytes: sourceBefore.indexBytes, sourceGenerationSha256: sourceBefore.generation_sha256,
    sourceHost, destinationHost, sourceCodeIdentity, transportedAt, transport, keyId, signature,
  });
  verifyCrossDeviceReceipt(receipt, {
    runId: sourceBefore.index.run_id, indexBytes: sourceBefore.indexBytes, sourceGenerationSha256: sourceBefore.generation_sha256,
    expectedSourceCodeIdentity: sourceCodeIdentity, trustedSignatureVerifier,
  });
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  retained.push(await writeVerifiedFile(stagingPath, {
    role: "source_generation_index", filename: "source-generation-index.v1.json", bytes: sourceBefore.indexBytes,
  }, publicationFaultInjector));
  retained.push(await writeVerifiedFile(stagingPath, {
    role: "transfer_receipt", filename: "cross-device-receipt.v1.json", bytes: receiptBytes,
  }, publicationFaultInjector));
  const receivedPrivacyAttestation = await buildGenerationPrivacyAttestation({
    stagingPath,
    artifacts: retained,
    policy: sourcePrivacyAttestation.policy,
    trustedProhibitedRoots: destinationTrustedProhibitedRoots,
  });
  retained.push(await writeVerifiedFile(stagingPath, {
    role: "received_privacy_attestation",
    filename: "received-generation-privacy.v1.json",
    bytes: Buffer.from(`${JSON.stringify(receivedPrivacyAttestation, null, 2)}\n`),
  }, publicationFaultInjector));
  retained.sort((a, b) => compareUnicodeCodePoints(a.role, b.role));
  await verifyRetainedArtifacts(stagingPath, retained);
  const index = {
    index_id: PHASE1_EXECUTION_INDEX_ID, index_version: 1, state: "complete", claim_ready: false,
    run_id: sourceBefore.index.run_id, kind: receivedKind, transaction_id: transactionId,
    source_generation_sha256: sourceBefore.generation_sha256, artifacts: retained, index_content_sha256: null,
  };
  index.index_content_sha256 = indexContentSha256(index);
  if (!validateIndex(index)) throw new Error("Received generation index failed its strict contract");
  const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`);
  await inject(publicationFaultInjector, "before_commit_marker", { stagingPath });
  await writeVerifiedFile(stagingPath, { role: "execution_index", filename: "execution-index.v1.json", bytes: indexBytes }, publicationFaultInjector, true);
  await inject(publicationFaultInjector, "after_commit_marker", { stagingPath });
  let published = false;
  try {
    const stagingInspection = await inspectGenerationDirectory(stagingPath, {
      allowStaging: true,
      activeClaimTransactionId: transactionId,
    });
    if (stagingInspection.state !== "complete" || stagingInspection.index.source_generation_sha256 !== sourceBefore.generation_sha256) {
      throw new Error("Received staging generation does not bind the verified source generation");
    }
    await verifyFinalGenerationPrivacy({
      generationPath: stagingPath,
      index: stagingInspection.index,
      privacyAttestation: receivedPrivacyAttestation,
      privacyRole: "received_privacy_attestation",
    });
    if (requiresCompositeExtractionVerification(stagingInspection.index)) await runSemanticGenerationVerifier({ verifier: semanticVerifier, generationPath: stagingPath, inspection: stagingInspection });
    for (const artifact of sourceBefore.index.artifacts) {
      const received = stagingInspection.index.artifacts.find(item => item.role === artifact.role);
      if (canonicalJson(received) !== canonicalJson(artifact)) throw new Error(`Received staging generation changed a source artifact record: ${artifact.role}`);
    }
    await inject(publicationFaultInjector, "before_final_rename", { stagingPath, generationPath });
    try {
      await fs.lstat(generationPath);
      throw new Error("Generation destination identity was precreated or reused");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fs.rename(stagingPath, generationPath);
    published = true;
    await inject(publicationFaultInjector, "after_final_rename", { generationPath });
    const destination = await inspectGenerationDirectory(generationPath, { activeClaimTransactionId: transactionId });
    if (destination.state !== "complete" || destination.index.source_generation_sha256 !== sourceBefore.generation_sha256) throw new Error("Received generation does not bind the verified source generation");
    await verifyFinalGenerationPrivacy({
      generationPath,
      index: destination.index,
      privacyAttestation: receivedPrivacyAttestation,
      privacyRole: "received_privacy_attestation",
    });
    if (requiresCompositeExtractionVerification(destination.index)) await runSemanticGenerationVerifier({ verifier: semanticVerifier, generationPath, inspection: destination });
    for (const artifact of sourceBefore.index.artifacts) {
      const received = destination.index.artifacts.find(item => item.role === artifact.role);
      if (canonicalJson(received) !== canonicalJson(artifact)) throw new Error(`Received generation changed a source artifact record: ${artifact.role}`);
    }
    await fsyncDirectory(destinationParentDirectory);
    await inject(publicationFaultInjector, "after_parent_fsync", { generationPath });
    const finalInspection = await inspectGenerationDirectory(generationPath, { activeClaimTransactionId: transactionId });
    if (finalInspection.state !== "complete" || finalInspection.generation_sha256 !== destination.generation_sha256) throw new Error("Received generation changed before claim cleanup");
    await verifyFinalGenerationPrivacy({
      generationPath,
      index: finalInspection.index,
      privacyAttestation: receivedPrivacyAttestation,
      privacyRole: "received_privacy_attestation",
    });
    if (requiresCompositeExtractionVerification(finalInspection.index)) await runSemanticGenerationVerifier({ verifier: semanticVerifier, generationPath, inspection: finalInspection });
    await fs.unlink(claimPath);
    await fsyncDirectory(destinationParentDirectory);
    const completedDestination = await inspectGenerationDirectory(generationPath);
    if (completedDestination.state !== "complete" || completedDestination.generation_sha256 !== destination.generation_sha256) {
      throw new Error("Received generation failed claim-free reinspection");
    }
    if (requiresCompositeExtractionVerification(completedDestination.index)) await runSemanticGenerationVerifier({ verifier: semanticVerifier, generationPath, inspection: completedDestination });
    return {
      state: "complete", generationPath, generationName, index, indexBytes, receipt, source: sourceBefore, destination: completedDestination,
      generation_sha256: completedDestination.generation_sha256,
    };
  } catch (error) {
    if (published) {
      error.publication_state = "durability_uncertain";
      error.generation_path = generationPath;
    }
    throw error;
  }
}

export async function recoverVerifiedStagingGeneration({ stagingPath, generationPath, faultInjector = null, semanticVerifier = null }) {
  const [stagingParent, generationParent] = await Promise.all([fs.realpath(path.dirname(stagingPath)), fs.realpath(path.dirname(generationPath))]);
  const [stagingParentStat, generationParentStat] = await Promise.all([fs.stat(stagingParent), fs.stat(generationParent)]);
  if (stagingParent !== generationParent || stagingParentStat.dev !== generationParentStat.dev || !path.basename(stagingPath).startsWith(".staging-")
    || path.basename(generationPath).startsWith(".staging-")) throw new Error("Recovery requires same-parent staging and final generation paths");
  const transactionId = path.basename(stagingPath).slice(-36);
  if (!UUID_V4.test(transactionId)) return { state: "corruption", reason: "recovery_transaction_identity_invalid" };
  const claimPath = path.join(stagingParent, `.claim-${path.basename(generationPath)}`);
  await acquireOrVerifyClaim(claimPath, transactionId, { adoptExisting: true });
  await fsyncDirectory(stagingParent);
  const inspection = await inspectGenerationDirectory(stagingPath, {
    allowStaging: true,
    activeClaimTransactionId: transactionId,
  });
  if (inspection.state !== "complete") return inspection;
  try {
    await fs.lstat(generationPath);
    return { state: "corruption", reason: "generation_name_reused" };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (path.basename(generationPath) !== `${inspection.index.kind}-${inspection.index.run_id}-${inspection.index.transaction_id}`) return { state: "corruption", reason: "recovery_directory_identity_mismatch" };
  if (requiresSemanticGenerationVerification(inspection.index) && typeof semanticVerifier !== "function") {
    return { state: "recovery_required", reason: "semantic_verifier_required", generationPath: stagingPath };
  }
  await runSemanticGenerationVerifier({ verifier: semanticVerifier, generationPath: stagingPath, inspection });
  const postClaimInspection = await inspectGenerationDirectory(stagingPath, {
    allowStaging: true,
    activeClaimTransactionId: inspection.index.transaction_id,
  });
  if (postClaimInspection.state !== "complete" || postClaimInspection.generation_sha256 !== inspection.generation_sha256) return { state: "corruption", reason: "staging_changed_after_claim" };
  await inject(faultInjector, "before_recovery_rename", { stagingPath, generationPath });
  await fs.rename(stagingPath, generationPath);
  try {
    const finalInspection = await inspectGenerationDirectory(generationPath, { activeClaimTransactionId: inspection.index.transaction_id });
    if (finalInspection.state !== "complete" || finalInspection.generation_sha256 !== inspection.generation_sha256) throw new Error("Recovered generation changed after rename");
    await runSemanticGenerationVerifier({ verifier: semanticVerifier, generationPath, inspection: finalInspection });
    await fsyncDirectory(stagingParent);
    await inject(faultInjector, "after_recovery_parent_fsync", { generationPath });
    const cleanupInspection = await inspectGenerationDirectory(generationPath, { activeClaimTransactionId: inspection.index.transaction_id });
    if (cleanupInspection.state !== "complete" || cleanupInspection.generation_sha256 !== inspection.generation_sha256) throw new Error("Recovered generation changed before claim cleanup");
    await fs.unlink(claimPath);
    await fsyncDirectory(stagingParent);
  } catch (error) {
    error.publication_state = "durability_uncertain";
    error.generation_path = generationPath;
    throw error;
  }
  const completedInspection = await inspectGenerationDirectory(generationPath);
  if (completedInspection.state !== "complete" || completedInspection.generation_sha256 !== inspection.generation_sha256) {
    return { state: "corruption", reason: "recovered_generation_failed_claim_free_reinspection" };
  }
  await runSemanticGenerationVerifier({ verifier: semanticVerifier, generationPath, inspection: completedInspection });
  return { ...completedInspection, state: "recovered_complete", generationPath };
}

export async function recoverPublishedGeneration({ generationPath, faultInjector = null, semanticVerifier = null }) {
  const parent = await fs.realpath(path.dirname(generationPath));
  const transactionId = path.basename(generationPath).slice(-36);
  if (!UUID_V4.test(transactionId)) return { state: "corruption", reason: "recovery_transaction_identity_invalid" };
  const claimPath = path.join(parent, `.claim-${path.basename(generationPath)}`);
  await acquireOrVerifyClaim(claimPath, transactionId, { adoptExisting: true });
  const inspection = await inspectGenerationDirectory(generationPath, { activeClaimTransactionId: transactionId });
  if (inspection.state !== "complete") return inspection;
  if (requiresSemanticGenerationVerification(inspection.index) && typeof semanticVerifier !== "function") {
    return { state: "recovery_required", reason: "semantic_verifier_required", generationPath };
  }
  try {
    await runSemanticGenerationVerifier({ verifier: semanticVerifier, generationPath, inspection });
    const postClaimInspection = await inspectGenerationDirectory(generationPath, { activeClaimTransactionId: inspection.index.transaction_id });
    if (postClaimInspection.state !== "complete" || postClaimInspection.generation_sha256 !== inspection.generation_sha256) throw new Error("Published generation changed after claim verification");
    await fsyncDirectory(parent);
    await inject(faultInjector, "after_published_recovery_parent_fsync", { generationPath });
    await runSemanticGenerationVerifier({ verifier: semanticVerifier, generationPath, inspection: postClaimInspection });
    await fs.unlink(claimPath);
    await fsyncDirectory(parent);
  } catch (error) {
    error.publication_state = "durability_uncertain";
    error.generation_path = generationPath;
    throw error;
  }
  const completedInspection = await inspectGenerationDirectory(generationPath);
  if (completedInspection.state !== "complete" || completedInspection.generation_sha256 !== inspection.generation_sha256) {
    return { state: "corruption", reason: "recovered_generation_failed_claim_free_reinspection" };
  }
  await runSemanticGenerationVerifier({ verifier: semanticVerifier, generationPath, inspection: completedInspection });
  return { ...completedInspection, state: "recovered_complete", generationPath };
}
