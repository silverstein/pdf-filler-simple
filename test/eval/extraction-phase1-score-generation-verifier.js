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
  parseJson,
  readArtifact,
  readBoundedNoFollow,
  verifyPrivacy,
  verifyReceivedSourceAnchor,
} from "./extraction-phase1-generation-verifier-common.js";
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
  trustedSignatureVerifier = null,
  trust,
} = {}) {
  if (!repositoryRoot || !manifestPath || !manifestSchemaPath
    || !["public_synthetic", "private_local"].includes(trustedPrivacyClass)
    || !(trustedSignatureVerifier === null || typeof trustedSignatureVerifier === "function")) {
    throw new Error("Score verifier factory requires explicit trusted local paths, privacy policy, and optional signature verifier");
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
  const manifestAnchors = manifestAnchorsFromBytes(manifestBytes, manifestSchemaBytes);
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (String(pdfjsLib.version) !== "5.4.624") throw new Error("Score verifier factory requires PDF.js 5.4.624");
  return async ({ generationPath, index, inspection: suppliedInspection = null }) => {
    const inspection = suppliedInspection ?? { state: "complete", index };
    await trustVerifier({ generationPath, inspection });
    await Promise.all([
      assertClosedSourceSetUnchanged(repositoryRoot, PHASE1_COMPANION_SOURCE_PATHS, runnerSourceSet),
      assertClosedSourceSetUnchanged(repositoryRoot, PHASE1_SCORER_LOCAL_SOURCE_PATHS, scorerSourceSet),
    ]);
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
    if (inspection.index.kind === "received_score") {
      if (trust.kind === "local_claim_owned" && trust.expected_generation_sha256 === null) {
        throw new Error("Local recovery of a received score requires its exact generation digest");
      }
      await verifyReceivedSourceAnchor(generationPath, inspection, {
        expectedSourceGenerationSha256: trust.kind === "out_of_band_source_generation_sha256"
          ? trust.expected_source_generation_sha256 : inspection.index.source_generation_sha256,
        expectedSourceKind: "score",
        expectedSourceCodeIdentity: {
          kind: "score_scorer_local_source_set_sha256",
          sha256: provenance.bindings.scorer_local_source_set_sha256,
          source_artifact_role: "score_provenance",
        },
        trustedSignatureVerifier,
      });
    }
    const privacyRoots = inspection.index.kind === "received_score"
      ? (trustedReceivedProhibitedRoots ?? trustedProhibitedRoots)
      : (trustedSourceProhibitedRoots ?? trustedProhibitedRoots);
    await verifyPrivacy({ generationPath, inspection, trustedPrivacyClass, trustedProhibitedRoots: privacyRoots });
  };
}
