import {
  PHASE1_COMPANION_SOURCE_PATHS,
  verifyExecutionCompanion,
} from "./extraction-phase1-companion.js";
import { loadRetainedPhase1Corpus, PHASE1_CORPUS_LIMITS } from "./extraction-phase1-corpus.js";
import {
  artifactEligibility,
  assertClosedSourceSetUnchanged,
  createTrustVerifier,
  loadClosedSourceSet,
  manifestAnchorsFromBytes,
  parseCanonicalJson,
  readArtifact,
  readBoundedNoFollow,
  schemaFromSource,
  verifyPrivacy,
  verifyReceivedSourceAnchor,
} from "./extraction-phase1-generation-verifier-common.js";
import {
  assertSchema,
  canonicalJson,
  sha256,
  validatePlan,
  validateRegistry,
} from "./extraction-phase1-protocol.js";
import { verifyRetainedPhase1Report } from "./extraction-phase1-report-verifier.js";

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

export async function createExecutionGenerationSemanticVerifier({
  repositoryRoot,
  manifestPath,
  manifestSchemaPath,
  trustedPrivacyClass,
  trustedProhibitedRoots = [],
  trustedSourceProhibitedRoots = null,
  trustedReceivedProhibitedRoots = null,
  trustedSignatureVerifier = null,
  trust,
} = {}) {
  if (!repositoryRoot || !manifestPath || !manifestSchemaPath
    || !["public_synthetic", "private_local"].includes(trustedPrivacyClass)
    || !(trustedSignatureVerifier === null || typeof trustedSignatureVerifier === "function")) {
    throw new Error("Execution verifier factory requires explicit trusted local paths, privacy policy, and optional signature verifier");
  }
  const [sourceSet, manifestBytes, manifestSchemaBytes] = await Promise.all([
    loadClosedSourceSet(repositoryRoot, PHASE1_COMPANION_SOURCE_PATHS),
    readBoundedNoFollow(manifestPath, PHASE1_CORPUS_LIMITS.max_manifest_bytes),
    readBoundedNoFollow(manifestSchemaPath, PHASE1_CORPUS_LIMITS.max_manifest_bytes),
  ]);
  const trustVerifier = createTrustVerifier(trust);
  const manifestAnchors = manifestAnchorsFromBytes(manifestBytes, manifestSchemaBytes);
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
    if (inspection.index.kind === "received_execution") {
      if (trust.kind === "local_claim_owned" && trust.expected_generation_sha256 === null) {
        throw new Error("Local recovery of a received execution requires its exact generation digest");
      }
      await verifyReceivedSourceAnchor(generationPath, inspection, {
        expectedSourceGenerationSha256: trust.kind === "out_of_band_source_generation_sha256"
          ? trust.expected_source_generation_sha256 : inspection.index.source_generation_sha256,
        expectedSourceKind: "execution",
        expectedSourceCodeIdentity: {
          kind: "execution_direct_source_set_sha256",
          sha256: companion.direct_source_set_sha256,
          source_artifact_role: "execution_companion",
        },
        trustedSignatureVerifier,
      });
    }
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
