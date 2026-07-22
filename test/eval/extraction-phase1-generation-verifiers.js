import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  PHASE1_COMPANION_SOURCE_PATHS,
  generationProhibitedRootSetSha256,
  verifyCrossDeviceReceipt,
  verifyExecutionCompanion,
  verifyFinalGenerationPrivacy,
} from "./extraction-phase1-companion.js";
import { loadRetainedPhase1Corpus, PHASE1_CORPUS_LIMITS } from "./extraction-phase1-corpus.js";
import {
  computeGenerationSha256,
  readVerifiedGenerationArtifact,
} from "./extraction-phase1-publisher.js";
import {
  PHASE1_SCORER_LOCAL_SOURCE_PATHS,
  verifyPhase1ScoreBundle,
} from "./extraction-phase1-scorer.js";
import {
  assertSchema,
  canonicalJson,
  sha256,
  validatePlan,
  validateRegistry,
} from "./extraction-phase1-protocol.js";
import { verifyRetainedPhase1Report } from "./extraction-phase1-report-verifier.js";

const SHA256 = /^[a-f0-9]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const JSON_LIMIT = 16 * 1024 * 1024;

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} has unexpected keys`);
  }
}

async function readBoundedNoFollow(filename, maxBytes = JSON_LIMIT) {
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

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes);
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function parseCanonicalJson(bytes, label) {
  const value = parseJson(bytes, label);
  if (!bytes.equals(Buffer.from(`${JSON.stringify(value, null, 2)}\n`))) throw new Error(`${label} is not canonical`);
  return value;
}

async function loadClosedSourceSet(repositoryRoot, sourcePaths) {
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

async function assertClosedSourceSetUnchanged(repositoryRoot, sourcePaths, expected) {
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

function createTrustVerifier(trust) {
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

async function readArtifact(generationPath, inspection, role, options = {}) {
  return (await readVerifiedGenerationArtifact(generationPath, inspection, role, options)).bytes;
}

async function verifyReceivedSourceAnchor(generationPath, inspection, expectedSourceGenerationSha256) {
  if (!["received_execution", "received_score"].includes(inspection.index.kind)) return;
  const [sourceIndexBytes, receiptBytes] = await Promise.all([
    readArtifact(generationPath, inspection, "source_generation_index"),
    readArtifact(generationPath, inspection, "transfer_receipt"),
  ]);
  const sourceIndex = parseCanonicalJson(sourceIndexBytes, "Received source generation index");
  const receipt = parseCanonicalJson(receiptBytes, "Received transfer receipt");
  const sourceGenerationSha256 = computeGenerationSha256(sourceIndex, sourceIndexBytes);
  if (sourceGenerationSha256 !== expectedSourceGenerationSha256
    || inspection.index.source_generation_sha256 !== expectedSourceGenerationSha256
    || receipt.source_generation_sha256 !== expectedSourceGenerationSha256) {
    throw new Error("Received generation source anchor differs from the out-of-band trusted digest");
  }
  verifyCrossDeviceReceipt(receipt, {
    runId: sourceIndex.run_id,
    indexBytes: sourceIndexBytes,
    sourceGenerationSha256,
    expectedSourceCodeIdentity: receipt.source_code_identity,
  });
}

function schemaFromSource(sourceSet, role) {
  return parseJson(sourceSet.sources[role].bytes, `Trusted ${role}`);
}

function artifactEligibility(companion) {
  return Object.fromEntries(Object.entries(companion.artifact_attestation_by_candidate_id).map(([candidateId, evidence]) => [
    candidateId,
    evidence.precheck.status === "failed" ? "precheck_failed" : evidence.before.state,
  ]));
}

function expectedExecutionRoles(companion, received) {
  const roles = new Set(["candidate_registry", "execution_companion", "execution_report", "phase0_corpus", "privacy_attestation", "run_plan"]);
  for (const [candidateId, evidence] of Object.entries(companion.artifact_attestation_by_candidate_id)) {
    const safeId = candidateId.replace(/[^a-z0-9]+/g, "_");
    roles.add(`artifact_config_${safeId}`);
    if (evidence.before) roles.add(`artifact_before_${safeId}`);
    if (evidence.after) roles.add(`artifact_after_${safeId}`);
  }
  if (received) ["received_privacy_attestation", "source_generation_index", "transfer_receipt"].forEach(role => roles.add(role));
  return [...roles].sort();
}

async function verifyPrivacy({ generationPath, inspection, trustedPrivacyClass, trustedProhibitedRoots }) {
  const privacyRole = inspection.index.artifacts.some(item => item.role === "received_privacy_attestation")
    ? "received_privacy_attestation" : "privacy_attestation";
  const privacyAttestation = parseCanonicalJson(await readArtifact(generationPath, inspection, privacyRole), "Generation privacy attestation");
  if (privacyAttestation.policy !== trustedPrivacyClass
    || privacyAttestation.prohibited_root_set_sha256 !== generationProhibitedRootSetSha256(trustedProhibitedRoots)) {
    throw new Error("Generation privacy evidence differs from explicit fresh-verifier trust inputs");
  }
  await verifyFinalGenerationPrivacy({ generationPath, index: inspection.index, privacyAttestation, privacyRole });
}

export async function createExecutionGenerationSemanticVerifier({
  repositoryRoot,
  manifestPath,
  manifestSchemaPath,
  trustedPrivacyClass,
  trustedProhibitedRoots = [],
  trustedSourceProhibitedRoots = null,
  trustedReceivedProhibitedRoots = null,
  trust,
} = {}) {
  if (!repositoryRoot || !manifestPath || !manifestSchemaPath
    || !["public_synthetic", "private_local"].includes(trustedPrivacyClass)) {
    throw new Error("Execution verifier factory requires explicit trusted local paths and privacy policy");
  }
  const [sourceSet, manifestBytes, manifestSchemaBytes] = await Promise.all([
    loadClosedSourceSet(repositoryRoot, PHASE1_COMPANION_SOURCE_PATHS),
    readBoundedNoFollow(manifestPath, PHASE1_CORPUS_LIMITS.max_manifest_bytes),
    readBoundedNoFollow(manifestSchemaPath, PHASE1_CORPUS_LIMITS.max_manifest_bytes),
  ]);
  const trustVerifier = createTrustVerifier(trust);
  const manifestAnchors = {
    expectedManifestRawSha256: sha256(manifestBytes),
    expectedManifestCanonicalSha256: sha256(Buffer.from(canonicalJson(parseJson(manifestBytes, "Trusted manifest")))),
    expectedManifestSchemaRawSha256: sha256(manifestSchemaBytes),
    expectedManifestSchemaCanonicalSha256: sha256(Buffer.from(canonicalJson(parseJson(manifestSchemaBytes, "Trusted manifest schema")))),
  };
  const schemas = {
    registry: schemaFromSource(sourceSet, "registry_schema"),
    plan: schemaFromSource(sourceSet, "plan_schema"),
    request: schemaFromSource(sourceSet, "request_schema"),
    response: schemaFromSource(sourceSet, "response_schema"),
    report: schemaFromSource(sourceSet, "report_schema"),
    companion: schemaFromSource(sourceSet, "companion_schema"),
    corpus: schemaFromSource(sourceSet, "corpus_schema"),
  };
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (String(pdfjsLib.version) !== "5.4.624") throw new Error("Execution verifier factory requires PDF.js 5.4.624");
  return async ({ generationPath, index, inspection: suppliedInspection = null }) => {
    const inspection = suppliedInspection ?? { state: "complete", index };
    await trustVerifier({ generationPath, inspection });
    await assertClosedSourceSetUnchanged(repositoryRoot, PHASE1_COMPANION_SOURCE_PATHS, sourceSet);
    if (trust.kind === "out_of_band_source_generation_sha256") {
      await verifyReceivedSourceAnchor(generationPath, inspection, trust.expected_source_generation_sha256);
    }
    const [reportBytes, companionBytes, registryBytes, planBytes] = await Promise.all([
      readArtifact(generationPath, inspection, "execution_report", { maxBytes: 256 * 1024 * 1024 }),
      readArtifact(generationPath, inspection, "execution_companion"),
      readArtifact(generationPath, inspection, "candidate_registry"),
      readArtifact(generationPath, inspection, "run_plan"),
    ]);
    const report = parseCanonicalJson(reportBytes, "Execution report");
    const companion = parseCanonicalJson(companionBytes, "Execution companion");
    const registry = parseCanonicalJson(registryBytes, "Retained candidate registry");
    const plan = parseCanonicalJson(planBytes, "Retained run plan");
    assertSchema(companion, schemas.companion, "fresh execution companion");
    assertSchema(registry, schemas.registry, "fresh candidate registry");
    assertSchema(plan, schemas.plan, "fresh run plan");
    validateRegistry(registry);
    validatePlan(plan, registry);
    if (report.registry_sha256 !== sha256(Buffer.from(canonicalJson(registry)))
      || report.plan_sha256 !== sha256(Buffer.from(canonicalJson(plan)))) {
      throw new Error("Retained custom registry or plan differs from the execution report bindings");
    }
    if (companion.direct_source_set_sha256 !== sourceSet.digest) throw new Error("Execution companion differs from the closed local verifier source set");
    verifyExecutionCompanion(companion, {
      report,
      reportBytes,
      failureEvidenceByAttemptKey: companion.failure_evidence_by_attempt_key,
      resourceFactsByAttemptKey: companion.resource_facts_by_attempt_key,
      artifactAttestationByCandidateId: companion.artifact_attestation_by_candidate_id,
      artifactConfigBindingByCandidateId: companion.artifact_config_binding_by_candidate_id,
      commandRuntimeByCandidateId: companion.command_runtime_by_candidate_id,
      privacyEvidence: companion.privacy,
      sourceBytesByRole: sourceSet.sources,
      runnerEnvironmentAttestation: companion.runner_environment,
    });
    const observedRoles = inspection.index.artifacts.map(item => item.role).sort();
    const expectedRoles = expectedExecutionRoles(companion, inspection.index.kind === "received_execution");
    if (canonicalJson(observedRoles) !== canonicalJson(expectedRoles)) throw new Error("Execution generation semantic roles are missing or unexpected");
    const corpus = await loadRetainedPhase1Corpus({
      readArtifact: role => readArtifact(generationPath, inspection, role),
      corpusSchema: schemas.corpus,
      trustedPrivacyClass,
      ...manifestAnchors,
    });
    await verifyRetainedPhase1Report({
      reportBytes,
      verification: {
        registry,
        registrySchema: schemas.registry,
        plan,
        planSchema: schemas.plan,
        manifest: corpus.manifest,
        manifestSchema: corpus.manifestSchema,
        manifestBytesSha256: sha256(corpus.manifestBytes),
        manifestSchemaBytesSha256: sha256(corpus.manifestSchemaBytes),
        requestSchema: schemas.request,
        responseSchema: schemas.response,
        reportSchema: schemas.report,
        adapterAvailability: companion.runtime.input_adapters,
        artifactEligibilityByCandidateId: artifactEligibility(companion),
        repositoryRoot,
      },
      corpus,
      pdfjsLib,
      validatorSourceBytesByRole: sourceSet.sources,
      trustedFailureEvidenceByAttemptKey: companion.failure_evidence_by_attempt_key,
    });
    const privacyRoots = inspection.index.kind === "received_execution"
      ? (trustedReceivedProhibitedRoots ?? trustedProhibitedRoots)
      : (trustedSourceProhibitedRoots ?? trustedProhibitedRoots);
    await verifyPrivacy({ generationPath, inspection, trustedPrivacyClass, trustedProhibitedRoots: privacyRoots });
  };
}

function expectedScoreRoles(received) {
  const roles = [
    "candidate_registry", "phase0_corpus", "privacy_attestation", "run_plan", "score_provenance", "score_report",
    "source_execution_companion", "source_execution_report",
  ];
  if (received) roles.push("received_privacy_attestation", "source_generation_index", "transfer_receipt");
  return roles.sort();
}

export async function createScoreGenerationSemanticVerifier({
  repositoryRoot,
  manifestPath,
  manifestSchemaPath,
  trustedPrivacyClass,
  trustedProhibitedRoots = [],
  trustedSourceProhibitedRoots = null,
  trustedReceivedProhibitedRoots = null,
  trust,
} = {}) {
  if (!repositoryRoot || !manifestPath || !manifestSchemaPath
    || !["public_synthetic", "private_local"].includes(trustedPrivacyClass)) {
    throw new Error("Score verifier factory requires explicit trusted local paths and privacy policy");
  }
  const [runnerSourceSet, scorerSourceSet, manifestBytes, manifestSchemaBytes] = await Promise.all([
    loadClosedSourceSet(repositoryRoot, PHASE1_COMPANION_SOURCE_PATHS),
    loadClosedSourceSet(repositoryRoot, PHASE1_SCORER_LOCAL_SOURCE_PATHS),
    readBoundedNoFollow(manifestPath, PHASE1_CORPUS_LIMITS.max_manifest_bytes),
    readBoundedNoFollow(manifestSchemaPath, PHASE1_CORPUS_LIMITS.max_manifest_bytes),
  ]);
  const trustVerifier = createTrustVerifier(trust);
  const scorerJson = Object.fromEntries(Object.entries(scorerSourceSet.sources)
    .filter(([, source]) => source.path.endsWith(".json"))
    .map(([role, source]) => [role, parseJson(source.bytes, `Trusted scorer ${role}`)]));
  const manifestAnchors = {
    expectedManifestRawSha256: sha256(manifestBytes),
    expectedManifestCanonicalSha256: sha256(Buffer.from(canonicalJson(parseJson(manifestBytes, "Trusted manifest")))),
    expectedManifestSchemaRawSha256: sha256(manifestSchemaBytes),
    expectedManifestSchemaCanonicalSha256: sha256(Buffer.from(canonicalJson(parseJson(manifestSchemaBytes, "Trusted manifest schema")))),
  };
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (String(pdfjsLib.version) !== "5.4.624") throw new Error("Score verifier factory requires PDF.js 5.4.624");
  return async ({ generationPath, index, inspection: suppliedInspection = null }) => {
    const inspection = suppliedInspection ?? { state: "complete", index };
    await trustVerifier({ generationPath, inspection });
    await Promise.all([
      assertClosedSourceSetUnchanged(repositoryRoot, PHASE1_COMPANION_SOURCE_PATHS, runnerSourceSet),
      assertClosedSourceSetUnchanged(repositoryRoot, PHASE1_SCORER_LOCAL_SOURCE_PATHS, scorerSourceSet),
    ]);
    if (trust.kind === "out_of_band_source_generation_sha256") {
      await verifyReceivedSourceAnchor(generationPath, inspection, trust.expected_source_generation_sha256);
    }
    const observedRoles = inspection.index.artifacts.map(item => item.role).sort();
    if (canonicalJson(observedRoles) !== canonicalJson(expectedScoreRoles(inspection.index.kind === "received_score"))) {
      throw new Error("Score generation semantic roles are missing or unexpected");
    }
    const [scoreBytes, provenanceBytes, reportBytes, companionBytes, registryBytes, planBytes] = await Promise.all([
      readArtifact(generationPath, inspection, "score_report"),
      readArtifact(generationPath, inspection, "score_provenance"),
      readArtifact(generationPath, inspection, "source_execution_report", { maxBytes: 256 * 1024 * 1024 }),
      readArtifact(generationPath, inspection, "source_execution_companion"),
      readArtifact(generationPath, inspection, "candidate_registry"),
      readArtifact(generationPath, inspection, "run_plan"),
    ]);
    const report = parseCanonicalJson(reportBytes, "Score source execution report");
    const companion = parseCanonicalJson(companionBytes, "Score source execution companion");
    const registry = parseCanonicalJson(registryBytes, "Score candidate registry");
    const plan = parseCanonicalJson(planBytes, "Score run plan");
    assertSchema(companion, scorerJson.companion_schema, "fresh score source companion");
    assertSchema(registry, scorerJson.registry_schema, "fresh score candidate registry");
    assertSchema(plan, scorerJson.plan_schema, "fresh score run plan");
    validateRegistry(registry);
    validatePlan(plan, registry);
    if (report.registry_sha256 !== sha256(Buffer.from(canonicalJson(registry)))
      || report.plan_sha256 !== sha256(Buffer.from(canonicalJson(plan)))) {
      throw new Error("Score retained custom registry or plan differs from report bindings");
    }
    if (companion.direct_source_set_sha256 !== runnerSourceSet.digest) throw new Error("Score source companion differs from the closed runner source set");
    verifyExecutionCompanion(companion, {
      report,
      reportBytes,
      failureEvidenceByAttemptKey: companion.failure_evidence_by_attempt_key,
      resourceFactsByAttemptKey: companion.resource_facts_by_attempt_key,
      artifactAttestationByCandidateId: companion.artifact_attestation_by_candidate_id,
      artifactConfigBindingByCandidateId: companion.artifact_config_binding_by_candidate_id,
      commandRuntimeByCandidateId: companion.command_runtime_by_candidate_id,
      privacyEvidence: companion.privacy,
      sourceBytesByRole: runnerSourceSet.sources,
      runnerEnvironmentAttestation: companion.runner_environment,
    });
    const corpus = await loadRetainedPhase1Corpus({
      readArtifact: role => readArtifact(generationPath, inspection, role),
      corpusSchema: scorerJson.corpus_schema,
      trustedPrivacyClass,
      ...manifestAnchors,
    });
    const preflightEvidenceBytes = Buffer.from(`${JSON.stringify({
      report_id: report.report_id,
      run_id: report.run_id,
      preflight_evidence_sha256: report.preflight_evidence_sha256,
      failure_evidence_by_attempt_key: companion.failure_evidence_by_attempt_key,
    }, null, 2)}\n`);
    const scorerParsedJsonByRole = { ...scorerJson };
    const context = {
      verification: {
        registry,
        registrySchema: scorerJson.registry_schema,
        plan,
        planSchema: scorerJson.plan_schema,
        manifest: corpus.manifest,
        manifestSchema: corpus.manifestSchema,
        manifestBytesSha256: sha256(corpus.manifestBytes),
        manifestSchemaBytesSha256: sha256(corpus.manifestSchemaBytes),
        requestSchema: scorerJson.request_schema,
        responseSchema: scorerJson.response_schema,
        reportSchema: scorerJson.report_schema,
        adapterAvailability: companion.runtime.input_adapters,
        failureEvidenceByAttemptKey: companion.failure_evidence_by_attempt_key,
        artifactEligibilityByCandidateId: artifactEligibility(companion),
        repositoryRoot,
      },
      oracle: scorerJson.scoring_oracle,
      oracleBytes: scorerSourceSet.sources.scoring_oracle.bytes,
      oracleSchema: scorerJson.oracle_schema,
      layoutOracle: scorerJson.layout_oracle,
      layoutOracleBytes: scorerSourceSet.sources.layout_oracle.bytes,
      layoutOracleSchema: scorerJson.layout_oracle_schema,
      corpus,
      pdfjsLib,
      validatorSourceBytesByRole: runnerSourceSet.sources,
      scoreSchema: scorerJson.score_schema,
      indexSchema: scorerJson.index_schema,
      scorerSourceBytesByRole: scorerSourceSet.sources,
      scorerParsedJsonByRole,
      reportBytes,
      preflightEvidenceBytes,
    };
    const provenance = parseCanonicalJson(provenanceBytes, "Score provenance");
    if (provenance.bindings.scorer_local_source_set_sha256 !== scorerSourceSet.digest) {
      throw new Error("Score provenance differs from the closed local scorer source set");
    }
    await verifyPhase1ScoreBundle({
      scoreText: scoreBytes.toString("utf8"),
      index: provenance,
      report,
      scorePath: "phase1-score-report.v1.json",
      indexPath: "phase1-score-provenance.v1.json",
    }, context);
    const privacyRoots = inspection.index.kind === "received_score"
      ? (trustedReceivedProhibitedRoots ?? trustedProhibitedRoots)
      : (trustedSourceProhibitedRoots ?? trustedProhibitedRoots);
    await verifyPrivacy({ generationPath, inspection, trustedPrivacyClass, trustedProhibitedRoots: privacyRoots });
  };
}
