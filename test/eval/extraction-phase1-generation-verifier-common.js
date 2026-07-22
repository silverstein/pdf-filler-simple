import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  generationProhibitedRootSetSha256,
  verifyCrossDeviceReceipt,
  verifyFinalGenerationPrivacy,
} from "./extraction-phase1-companion.js";
import { PHASE1_CORPUS_LIMITS } from "./extraction-phase1-corpus.js";
import {
  computeGenerationSha256,
  readVerifiedGenerationArtifact,
  verifyReceivedArtifactRecordMapping,
} from "./extraction-phase1-publisher.js";
import { canonicalJson, sha256 } from "./extraction-phase1-protocol.js";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const JSON_LIMIT = 16 * 1024 * 1024;

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} has unexpected keys`);
  }
}

export async function readBoundedNoFollow(filename, maxBytes = JSON_LIMIT) {
  if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("Fresh verifier loading requires O_NOFOLLOW support");
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maxBytes)) {
      throw new Error(`Fresh verifier input is not a bounded regular file: ${filename}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (String(before.dev) !== String(after.dev) || String(before.ino) !== String(after.ino)
      || String(before.size) !== String(after.size) || String(before.mtimeNs) !== String(after.mtimeNs)
      || String(before.ctimeNs) !== String(after.ctimeNs) || BigInt(bytes.length) !== before.size) {
      throw new Error(`Fresh verifier input changed while read: ${filename}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes);
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

export function parseCanonicalJson(bytes, label) {
  const value = parseJson(bytes, label);
  if (!bytes.equals(Buffer.from(`${JSON.stringify(value, null, 2)}\n`))) throw new Error(`${label} is not canonical`);
  return value;
}

export async function loadClosedSourceSet(repositoryRoot, sourcePaths) {
  const sources = Object.fromEntries(await Promise.all(Object.entries(sourcePaths).map(async ([role, relativePath]) => [
    role,
    { path: relativePath, bytes: await readBoundedNoFollow(path.join(repositoryRoot, relativePath)) },
  ])));
  const projection = Object.keys(sources).sort().map(role => ({
    role,
    path: sources[role].path,
    bytes: sources[role].bytes.length,
    sha256: sha256(sources[role].bytes),
  }));
  return { sources, digest: sha256(Buffer.from(canonicalJson(projection))) };
}

export async function assertClosedSourceSetUnchanged(repositoryRoot, sourcePaths, expected) {
  const current = await loadClosedSourceSet(repositoryRoot, sourcePaths);
  if (current.digest !== expected.digest) throw new Error("Fresh verifier local source set changed after factory creation");
}

function claimName(generationPath) {
  const base = path.basename(generationPath);
  return `.claim-${base.startsWith(".staging-") ? base.slice(".staging-".length) : base}`;
}

async function exactClaimPresent(generationPath, transactionId) {
  const filename = path.join(path.dirname(generationPath), claimName(generationPath));
  let handle;
  try {
    handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!before.isFile() || Number(before.mode & 0o777n) !== 0o600
      || !bytes.equals(Buffer.from(`${transactionId}\n`))
      || String(before.dev) !== String(after.dev) || String(before.ino) !== String(after.ino)
      || String(before.size) !== String(after.size) || String(before.mtimeNs) !== String(after.mtimeNs)
      || String(before.ctimeNs) !== String(after.ctimeNs)) throw new Error("Local recovery transaction claim is invalid");
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

export function createTrustVerifier(trust) {
  const localKeys = ["expected_generation_sha256", "expected_transaction_id", "kind"];
  exactKeys(trust, trust?.kind === "local_claim_owned" ? localKeys : ["expected_source_generation_sha256", "kind"], "Fresh verifier trust configuration");
  if (!["local_claim_owned", "out_of_band_source_generation_sha256"].includes(trust.kind)) {
    throw new Error("Fresh verifier trust mode is invalid");
  }
  if (trust.kind === "out_of_band_source_generation_sha256" && !SHA256.test(trust.expected_source_generation_sha256)) {
    throw new Error("Fresh verifier requires an exact out-of-band source generation digest");
  }
  if (trust.kind === "local_claim_owned"
    && (!UUID_V4.test(trust.expected_transaction_id ?? "")
      || !(trust.expected_generation_sha256 === null || SHA256.test(trust.expected_generation_sha256 ?? "")))) {
    throw new Error("Local claim-owned trust requires an explicit transaction ID and optional exact generation digest");
  }
  let claimEstablished = false;
  let claimFreeUseConsumed = false;
  return async ({ generationPath, inspection }) => {
    if (trust.kind === "out_of_band_source_generation_sha256") {
      if (["execution", "score"].includes(inspection.index.kind)) {
        if (inspection.generation_sha256 !== trust.expected_source_generation_sha256) {
          throw new Error("Original generation differs from the out-of-band trusted digest");
        }
      } else if (inspection.index.source_generation_sha256 !== trust.expected_source_generation_sha256) {
        throw new Error("Received generation does not bind the out-of-band trusted source digest");
      }
      return;
    }
    if (inspection.index.transaction_id !== trust.expected_transaction_id
      || (trust.expected_generation_sha256 !== null && inspection.generation_sha256 !== trust.expected_generation_sha256)) {
      throw new Error("Local recovery generation differs from its explicit transaction trust input");
    }
    const present = await exactClaimPresent(generationPath, inspection.index.transaction_id);
    if (present) {
      if (claimFreeUseConsumed) throw new Error("Local claim-owned verifier was already consumed");
      claimEstablished = true;
      return;
    }
    if (!claimEstablished || claimFreeUseConsumed) {
      throw new Error("Local claim-owned verifier cannot authenticate a claim-free generation");
    }
    claimFreeUseConsumed = true;
  };
}

export async function readArtifact(generationPath, inspection, role, options = {}) {
  return (await readVerifiedGenerationArtifact(generationPath, inspection, role, options)).bytes;
}

export function verifyReceivedGenerationAncestry({
  inspection,
  sourceIndexBytes,
  receiptBytes,
  expectedSourceGenerationSha256,
  expectedSourceKind,
  expectedSourceCodeIdentity,
  trustedSignatureVerifier = null,
} = {}) {
  if (!inspection || inspection.state !== "complete" || !["execution", "score"].includes(expectedSourceKind)
    || !SHA256.test(expectedSourceGenerationSha256 ?? "")
    || !(trustedSignatureVerifier === null || typeof trustedSignatureVerifier === "function")) {
    throw new Error("Received generation ancestry requires exact trusted inputs");
  }
  const expectedReceivedKind = expectedSourceKind === "execution" ? "received_execution" : "received_score";
  if (inspection.index.kind !== expectedReceivedKind) throw new Error("Received generation kind does not match its expected source kind");
  const sourceIndex = parseCanonicalJson(sourceIndexBytes, "Received source generation index");
  const receipt = parseCanonicalJson(receiptBytes, "Received transfer receipt");
  const sourceGenerationSha256 = computeGenerationSha256(sourceIndex, sourceIndexBytes);
  if (sourceIndex.kind !== expectedSourceKind
    || sourceIndex.run_id !== inspection.index.run_id
    || sourceGenerationSha256 !== expectedSourceGenerationSha256
    || inspection.index.source_generation_sha256 !== expectedSourceGenerationSha256
    || receipt.source_generation_sha256 !== expectedSourceGenerationSha256) {
    throw new Error("Received generation source anchor differs from the out-of-band trusted source");
  }
  verifyReceivedArtifactRecordMapping({
    sourceIndex,
    sourceIndexBytes,
    receiptBytes,
    destinationIndex: inspection.index,
  });
  const receiptVerification = verifyCrossDeviceReceipt(receipt, {
    runId: sourceIndex.run_id,
    indexBytes: sourceIndexBytes,
    sourceGenerationSha256,
    expectedSourceCodeIdentity,
    trustedSignatureVerifier,
  });
  return { sourceIndex, receipt, receiptVerification };
}

export async function verifyReceivedSourceAnchor(generationPath, inspection, options) {
  if (!["received_execution", "received_score"].includes(inspection.index.kind)) return null;
  const [sourceIndexBytes, receiptBytes] = await Promise.all([
    readArtifact(generationPath, inspection, "source_generation_index"),
    readArtifact(generationPath, inspection, "transfer_receipt"),
  ]);
  return verifyReceivedGenerationAncestry({ inspection, sourceIndexBytes, receiptBytes, ...options });
}

export function schemaFromSource(sourceSet, role) {
  return parseJson(sourceSet.sources[role].bytes, `Trusted ${role}`);
}

export function artifactEligibility(companion) {
  return Object.fromEntries(Object.entries(companion.artifact_attestation_by_candidate_id).map(([candidateId, evidence]) => [
    candidateId,
    evidence.precheck.status === "failed" ? "precheck_failed" : evidence.before.state,
  ]));
}

export async function verifyPrivacy({ generationPath, inspection, trustedPrivacyClass, trustedProhibitedRoots }) {
  const privacyRole = inspection.index.artifacts.some(item => item.role === "received_privacy_attestation")
    ? "received_privacy_attestation" : "privacy_attestation";
  const privacyAttestation = parseCanonicalJson(await readArtifact(generationPath, inspection, privacyRole), "Generation privacy attestation");
  if (privacyAttestation.policy !== trustedPrivacyClass
    || privacyAttestation.prohibited_root_set_sha256 !== generationProhibitedRootSetSha256(trustedProhibitedRoots)) {
    throw new Error("Generation privacy evidence differs from explicit fresh-verifier trust inputs");
  }
  await verifyFinalGenerationPrivacy({ generationPath, index: inspection.index, privacyAttestation, privacyRole });
}

export function manifestAnchorsFromBytes(manifestBytes, manifestSchemaBytes) {
  if (manifestBytes.length > PHASE1_CORPUS_LIMITS.max_manifest_bytes
    || manifestSchemaBytes.length > PHASE1_CORPUS_LIMITS.max_manifest_bytes) {
    throw new Error("Fresh verifier manifest inputs exceed their byte ceilings");
  }
  return {
    expectedManifestRawSha256: sha256(manifestBytes),
    expectedManifestCanonicalSha256: sha256(Buffer.from(canonicalJson(parseJson(manifestBytes, "Trusted manifest")))),
    expectedManifestSchemaRawSha256: sha256(manifestSchemaBytes),
    expectedManifestSchemaCanonicalSha256: sha256(Buffer.from(canonicalJson(parseJson(manifestSchemaBytes, "Trusted manifest schema")))),
  };
}
