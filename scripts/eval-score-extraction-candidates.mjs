#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PHASE1_SCORER_LOCAL_SOURCE_PATHS,
  createPhase1ScoreBundle,
  scorePhase1Report,
  verifyPhase1ScoreBundle,
} from "../test/eval/extraction-phase1-scorer.js";
import { assertSchema, canonicalJson, loadJsonWithSchema, sha256, validatePhase1ReportByteContract } from "../test/eval/extraction-phase1-protocol.js";
import {
  PHASE1_COMPANION_SOURCE_PATHS,
  buildGenerationPrivacyAttestation,
  companionProhibitedRootSetSha256,
  generationProhibitedRootSetSha256,
  verifyCrossDeviceReceipt,
  verifyExecutionCompanion,
  verifyFinalGenerationPrivacy,
  verifyIndexedGenerationPrivacy,
} from "../test/eval/extraction-phase1-companion.js";
import {
  computeGenerationSha256,
  inspectGenerationDirectory,
  publishImmutableGeneration,
  readVerifiedGenerationArtifact,
} from "../test/eval/extraction-phase1-publisher.js";
import { loadRetainedPhase1Corpus } from "../test/eval/extraction-phase1-corpus.js";
import { createScoreGenerationSemanticVerifier } from "../test/eval/extraction-phase1-score-generation-verifier.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTRACTION_ROOT = path.join(REPO_ROOT, "test", "fixtures", "eval", "extraction");
const PHASE1_ROOT = path.join(EXTRACTION_ROOT, "phase1");

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a value`);
  return process.argv[index + 1];
}

async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, "utf8"));
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function prospectiveRealPath(target) {
  let cursor = path.resolve(target);
  const missingSegments = [];
  while (true) {
    try {
      const realAncestor = await fs.realpath(cursor);
      return path.join(realAncestor, ...missingSegments.reverse());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export async function scoreExtractionCandidateReport({
  executionGenerationPath,
  generationRoot,
  manifestPath = path.join(EXTRACTION_ROOT, "manifest.v1.json"),
  manifestSchemaPath = path.join(EXTRACTION_ROOT, "manifest.schema.json"),
  registryPath = path.join(PHASE1_ROOT, "candidate-registry.v1.json"),
  registrySchemaPath = path.join(PHASE1_ROOT, "candidate-registry.schema.json"),
  planPath = path.join(PHASE1_ROOT, "run-plan.v1.json"),
  planSchemaPath = path.join(PHASE1_ROOT, "run-plan.schema.json"),
  requestSchemaPath = path.join(PHASE1_ROOT, "candidate-request.schema.json"),
  responseSchemaPath = path.join(PHASE1_ROOT, "candidate-response.schema.json"),
  reportSchemaPath = path.join(PHASE1_ROOT, "report.schema.json"),
  oraclePath = path.join(PHASE1_ROOT, "scoring-oracle.v1.json"),
  oracleSchemaPath = path.join(PHASE1_ROOT, "scoring-oracle.schema.json"),
  layoutOraclePath = path.join(PHASE1_ROOT, "layout-occurrence-oracle.v1.json"),
  layoutOracleSchemaPath = path.join(PHASE1_ROOT, "layout-occurrence-oracle.schema.json"),
  corpusSchemaPath = path.join(PHASE1_ROOT, "corpus.schema.json"),
  scoreSchemaPath = path.join(PHASE1_ROOT, "score-report.schema.json"),
  indexSchemaPath = path.join(PHASE1_ROOT, "score-index.schema.json"),
  trustedSignatureVerifier = null,
  trustedSourcePrivacyDigests = null,
  destinationTrustedProhibitedRoots = [],
} = {}) {
  if (!executionGenerationPath || !generationRoot) throw new Error("Scoring requires executionGenerationPath and generationRoot");
  const [realExecutionGenerationPath, realRepoRoot] = await Promise.all([
    fs.realpath(path.resolve(executionGenerationPath)),
    fs.realpath(REPO_ROOT),
  ]);
  if (pathInside(realRepoRoot, realExecutionGenerationPath)) {
    throw new Error("Score input generations must remain outside the repository and package root");
  }
  const resolvedGenerationRoot = path.resolve(generationRoot);
  const [prospectiveGenerationRoot, realTrustedProhibitedRoots] = await Promise.all([
    prospectiveRealPath(resolvedGenerationRoot),
    Promise.all((destinationTrustedProhibitedRoots ?? []).map(item => fs.realpath(item))),
  ]);
  if (pathInside(realRepoRoot, prospectiveGenerationRoot)) throw new Error("Score generations must be persisted outside the repository and package root");
  for (const prohibited of realTrustedProhibitedRoots) {
    if (pathInside(prohibited, realExecutionGenerationPath) || pathInside(prohibited, prospectiveGenerationRoot)) {
      throw new Error("Score input or output overlaps a trusted prohibited repository, sync, share, or package root");
    }
  }
  await fs.mkdir(resolvedGenerationRoot, { recursive: true, mode: 0o700 });
  const realGenerationRoot = await fs.realpath(resolvedGenerationRoot);
  if (realGenerationRoot !== prospectiveGenerationRoot) throw new Error("Score generation root changed while establishing its privacy boundary");
  const sourceGeneration = await inspectGenerationDirectory(realExecutionGenerationPath);
  if (sourceGeneration.state !== "complete" || !["execution", "received_execution"].includes(sourceGeneration.index.kind)) throw new Error("Scoring requires a complete local execution generation");
  const [retainedPlanArtifact, retainedRegistryArtifact, reportLimitManifestLoaded] = await Promise.all([
    readVerifiedGenerationArtifact(realExecutionGenerationPath, sourceGeneration, "run_plan"),
    readVerifiedGenerationArtifact(realExecutionGenerationPath, sourceGeneration, "candidate_registry"),
    loadJsonWithSchema(manifestPath, manifestSchemaPath, "extraction Phase 0 manifest"),
  ]);
  const reportLimitPlan = JSON.parse(retainedPlanArtifact.bytes);
  const retainedRegistry = JSON.parse(retainedRegistryArtifact.bytes);
  if (!retainedPlanArtifact.bytes.equals(Buffer.from(`${JSON.stringify(reportLimitPlan, null, 2)}\n`))
    || !retainedRegistryArtifact.bytes.equals(Buffer.from(`${JSON.stringify(retainedRegistry, null, 2)}\n`))) {
    throw new Error("Execution generation custom registry or plan is not canonical");
  }
  const reportLimitManifest = reportLimitManifestLoaded.value;
  if (reportLimitPlan.limits.max_report_bytes > 256 * 1024 * 1024) throw new Error("Phase 1 max_report_bytes exceeds the scorer hard allocation ceiling");
  const reportRecord = sourceGeneration.index.artifacts.find(item => item.role === "execution_report");
  if (!reportRecord) throw new Error("Execution generation is missing its report role");
  const reportPlannedAttempts = reportLimitPlan.candidates.length
    * (reportLimitPlan.case_ids ?? reportLimitManifest.fixtures.map(item => item.id)).length
    * reportLimitPlan.repetitions;
  validatePhase1ReportByteContract({
    limits: reportLimitPlan.limits,
    plannedAttempts: reportPlannedAttempts,
    observedBytes: reportRecord.bytes,
  });
  const [{ bytes: reportBytes }, { bytes: executionCompanionBytes }] = await Promise.all([
    readVerifiedGenerationArtifact(realExecutionGenerationPath, sourceGeneration, "execution_report", { maxBytes: reportLimitPlan.limits.max_report_bytes }),
    readVerifiedGenerationArtifact(realExecutionGenerationPath, sourceGeneration, "execution_companion"),
  ]);
  const [manifestBytes, manifestSchemaBytes, registry, registrySchema, plan, planSchema, requestSchema, responseSchema, reportSchema, oracleBytes, oracleSchema, layoutOracleBytes, layoutOracleSchema, corpusSchema, scoreSchema, indexSchema, companionSchema, generationPrivacySchema] = await Promise.all([
    fs.readFile(manifestPath), fs.readFile(manifestSchemaPath),
    Promise.resolve(retainedRegistry), readJson(registrySchemaPath), Promise.resolve(reportLimitPlan), readJson(planSchemaPath), readJson(requestSchemaPath), readJson(responseSchemaPath), readJson(reportSchemaPath),
    fs.readFile(oraclePath), readJson(oracleSchemaPath), fs.readFile(layoutOraclePath), readJson(layoutOracleSchemaPath), readJson(corpusSchemaPath), readJson(scoreSchemaPath), readJson(indexSchemaPath), readJson(path.join(PHASE1_ROOT, "execution-companion.schema.json")), readJson(path.join(PHASE1_ROOT, "generation-privacy.schema.json")),
  ]);
  const report = JSON.parse(reportBytes);
  const companion = JSON.parse(executionCompanionBytes);
  const parsedLayoutOracle = JSON.parse(layoutOracleBytes);
  const corpusManifestAnchors = {
    expectedManifestRawSha256: parsedLayoutOracle.manifest_bindings.document.raw_sha256,
    expectedManifestCanonicalSha256: parsedLayoutOracle.manifest_bindings.document.canonical_sha256,
    expectedManifestSchemaRawSha256: parsedLayoutOracle.manifest_bindings.schema.raw_sha256,
    expectedManifestSchemaCanonicalSha256: parsedLayoutOracle.manifest_bindings.schema.canonical_sha256,
  };
  if (!executionCompanionBytes.equals(Buffer.from(`${JSON.stringify(companion, null, 2)}\n`))) throw new Error("Execution companion bytes are not canonical");
  assertSchema(companion, companionSchema, "execution companion scoring input");
  const expectedSourcePrivacyDigests = trustedSourcePrivacyDigests ?? {
    companion_prohibited_root_set_sha256: companionProhibitedRootSetSha256([]),
    generation_prohibited_root_set_sha256: generationProhibitedRootSetSha256([]),
  };
  if (!expectedSourcePrivacyDigests || typeof expectedSourcePrivacyDigests !== "object" || Array.isArray(expectedSourcePrivacyDigests)
    || canonicalJson(Object.keys(expectedSourcePrivacyDigests).sort()) !== canonicalJson(["companion_prohibited_root_set_sha256", "generation_prohibited_root_set_sha256"])
    || !/^[a-f0-9]{64}$/.test(expectedSourcePrivacyDigests.companion_prohibited_root_set_sha256)
    || !/^[a-f0-9]{64}$/.test(expectedSourcePrivacyDigests.generation_prohibited_root_set_sha256)
    || companion.privacy.prohibited_root_set_sha256 !== expectedSourcePrivacyDigests.companion_prohibited_root_set_sha256
    || (companion.privacy.policy !== "public_synthetic" && trustedSourcePrivacyDigests === null)) {
    throw new Error("Score generation trusted prohibited roots do not match the execution privacy policy");
  }
  if (companion.privacy.policy !== "public_synthetic") {
    if (!realTrustedProhibitedRoots.some(root => pathInside(root, realRepoRoot))) {
      throw new Error("Private score prohibited roots must cover the repository and package root");
    }
  }
  if (companion.report.report_id !== report.report_id || companion.report.run_id !== report.run_id
    || sourceGeneration.index.run_id !== report.run_id
    || companion.report.raw_bytes !== reportBytes.length || companion.report.raw_sha256 !== sha256(reportBytes)
    || companion.report.canonical_sha256 !== sha256(Buffer.from(canonicalJson(report)))) throw new Error("Execution companion does not bind the retained execution report");
  const companionSourceBytesByRole = Object.fromEntries(await Promise.all(Object.entries(PHASE1_COMPANION_SOURCE_PATHS).map(async ([role, relativeSourcePath]) => [
    role,
    { path: relativeSourcePath, bytes: await fs.readFile(path.join(REPO_ROOT, relativeSourcePath)) },
  ])));
  verifyExecutionCompanion(companion, {
    report,
    reportBytes,
    failureEvidenceByAttemptKey: companion.failure_evidence_by_attempt_key,
    resourceFactsByAttemptKey: companion.resource_facts_by_attempt_key,
    artifactAttestationByCandidateId: companion.artifact_attestation_by_candidate_id,
    artifactConfigBindingByCandidateId: companion.artifact_config_binding_by_candidate_id,
    commandRuntimeByCandidateId: companion.command_runtime_by_candidate_id,
    privacyEvidence: companion.privacy,
    sourceBytesByRole: companionSourceBytesByRole,
    runnerEnvironmentAttestation: companion.runner_environment,
  });
  const expectedSemanticRoles = new Set(["candidate_registry", "execution_companion", "execution_report", "phase0_corpus", "privacy_attestation", "run_plan"]);
  const sourcePrivacyArtifact = await readVerifiedGenerationArtifact(realExecutionGenerationPath, sourceGeneration, "privacy_attestation");
  const sourcePrivacyAttestation = JSON.parse(sourcePrivacyArtifact.bytes);
  if (!sourcePrivacyArtifact.bytes.equals(Buffer.from(`${JSON.stringify(sourcePrivacyAttestation, null, 2)}\n`))) throw new Error("Execution privacy evidence is not canonical");
  if (sourcePrivacyAttestation.policy !== companion.privacy.policy
    || sourcePrivacyAttestation.prohibited_root_set_sha256 !== expectedSourcePrivacyDigests.generation_prohibited_root_set_sha256) {
    throw new Error("Execution indexed privacy evidence differs from companion policy or trusted roots");
  }
  for (const [candidateId, evidence] of Object.entries(companion.artifact_attestation_by_candidate_id)) {
    const safeId = candidateId.replace(/[^a-z0-9]+/g, "_");
    const configRole = `artifact_config_${safeId}`;
    expectedSemanticRoles.add(configRole);
    const configArtifact = await readVerifiedGenerationArtifact(realExecutionGenerationPath, sourceGeneration, configRole);
    if (canonicalJson(JSON.parse(configArtifact.bytes)) !== canonicalJson(companion.artifact_config_binding_by_candidate_id[candidateId])) throw new Error(`Execution artifact config differs from companion: ${candidateId}`);
    for (const phase of ["before", "after"]) {
      if (!evidence[phase]) continue;
      const inventoryRole = `artifact_${phase}_${safeId}`;
      expectedSemanticRoles.add(inventoryRole);
      const inventoryArtifact = await readVerifiedGenerationArtifact(realExecutionGenerationPath, sourceGeneration, inventoryRole);
      if (canonicalJson(JSON.parse(inventoryArtifact.bytes)) !== canonicalJson(evidence[phase])) throw new Error(`Execution artifact inventory differs from companion: ${candidateId} ${phase}`);
    }
  }
  if (sourceGeneration.index.kind === "received_execution") {
    expectedSemanticRoles.add("source_generation_index");
    expectedSemanticRoles.add("transfer_receipt");
    expectedSemanticRoles.add("received_privacy_attestation");
    const [{ bytes: sourceIndexBytes }, { bytes: receiptBytes }, { bytes: receivedPrivacyBytes }] = await Promise.all([
      readVerifiedGenerationArtifact(realExecutionGenerationPath, sourceGeneration, "source_generation_index"),
      readVerifiedGenerationArtifact(realExecutionGenerationPath, sourceGeneration, "transfer_receipt"),
      readVerifiedGenerationArtifact(realExecutionGenerationPath, sourceGeneration, "received_privacy_attestation"),
    ]);
    const sourceIndex = JSON.parse(sourceIndexBytes);
    const receipt = JSON.parse(receiptBytes);
    const receivedPrivacyAttestation = JSON.parse(receivedPrivacyBytes);
    const sourceGenerationSha256 = computeGenerationSha256(sourceIndex, sourceIndexBytes);
    if (sourceIndex.kind !== "execution"
      || sourceGenerationSha256 !== sourceGeneration.index.source_generation_sha256
      || sourceGenerationSha256 !== receipt.source_generation_sha256) throw new Error("Received execution source generation digest is inconsistent");
    const expectedSourceCodeIdentity = {
      kind: "execution_direct_source_set_sha256",
      sha256: companion.direct_source_set_sha256,
      source_artifact_role: "execution_companion",
    };
    const receiptVerification = verifyCrossDeviceReceipt(receipt, {
      runId: report.run_id,
      indexBytes: sourceIndexBytes,
      sourceGenerationSha256,
      expectedSourceCodeIdentity,
      trustedSignatureVerifier,
    });
    if ((receipt.authenticity === "unavailable" && receiptVerification.authentic !== false)
      || (receipt.authenticity === "trusted_signer_required" && receiptVerification.authentic !== true)) throw new Error("Received execution receipt authenticity result is inconsistent");
    verifyIndexedGenerationPrivacy({ index: sourceIndex, privacyAttestation: sourcePrivacyAttestation });
    await verifyFinalGenerationPrivacy({
      generationPath: realExecutionGenerationPath,
      index: sourceGeneration.index,
      privacyAttestation: receivedPrivacyAttestation,
      privacyRole: "received_privacy_attestation",
    });
    if (receivedPrivacyAttestation.policy !== sourcePrivacyAttestation.policy
      || receivedPrivacyAttestation.prohibited_root_set_sha256 !== generationProhibitedRootSetSha256(destinationTrustedProhibitedRoots)) {
      throw new Error("Received execution source and destination privacy policies differ");
    }
    const transferAddedRoles = ["received_privacy_attestation", "source_generation_index", "transfer_receipt"];
    const sourceArtifactByRole = new Map(sourceIndex.artifacts.map(item => [item.role, item]));
    if (transferAddedRoles.some(role => sourceArtifactByRole.has(role))) throw new Error("Original execution index contains a transfer-local artifact role");
    for (const sourceArtifact of sourceIndex.artifacts) {
      const receivedArtifact = sourceGeneration.index.artifacts.find(item => item.role === sourceArtifact.role);
      if (canonicalJson(receivedArtifact) !== canonicalJson(sourceArtifact)) {
        throw new Error(`Received execution changed an original source artifact record: ${sourceArtifact.role}`);
      }
    }
    const observedTransferAddedRoles = sourceGeneration.index.artifacts
      .filter(item => !sourceArtifactByRole.has(item.role))
      .map(item => item.role)
      .sort();
    if (canonicalJson(observedTransferAddedRoles) !== canonicalJson(transferAddedRoles)) {
      throw new Error("Received execution transfer-local artifact roles are missing or unexpected");
    }
  } else {
    await verifyFinalGenerationPrivacy({
      generationPath: realExecutionGenerationPath,
      index: sourceGeneration.index,
      privacyAttestation: sourcePrivacyAttestation,
    });
  }
  const observedSemanticRoles = sourceGeneration.index.artifacts.map(item => item.role);
  if (canonicalJson([...expectedSemanticRoles].sort()) !== canonicalJson([...observedSemanticRoles].sort())) throw new Error("Execution generation has missing or extra semantic artifact roles");
  const failureEvidenceByAttemptKey = companion.failure_evidence_by_attempt_key;
  const preflightEvidenceBytes = Buffer.from(`${JSON.stringify({
    report_id: report.report_id,
    run_id: report.run_id,
    preflight_evidence_sha256: report.preflight_evidence_sha256,
    failure_evidence_by_attempt_key: failureEvidenceByAttemptKey,
  }, null, 2)}\n`);
  const corpus = await loadRetainedPhase1Corpus({
    readArtifact: async role => (await readVerifiedGenerationArtifact(realExecutionGenerationPath, sourceGeneration, role)).bytes,
    corpusSchema,
    trustedPrivacyClass: companion.privacy.policy,
    ...corpusManifestAnchors,
  });
  const manifestLoaded = { manifest: corpus.manifest };
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const scorerSourceBytesByRole = Object.fromEntries(await Promise.all(Object.entries(PHASE1_SCORER_LOCAL_SOURCE_PATHS).map(async ([role, relativePath]) => [
    role,
    { path: relativePath, bytes: await fs.readFile(path.join(REPO_ROOT, relativePath)) },
  ])));
  const scorerParsedJsonByRole = Object.fromEntries(Object.entries(scorerSourceBytesByRole)
    .filter(([, source]) => source.path.endsWith(".json"))
    .map(([role, source]) => [role, JSON.parse(source.bytes)]));
  Object.assign(scorerParsedJsonByRole, {
    companion_schema: companionSchema,
    corpus_schema: corpusSchema,
    index_schema: indexSchema,
    layout_oracle: parsedLayoutOracle,
    layout_oracle_schema: layoutOracleSchema,
    manifest_schema: JSON.parse(manifestSchemaBytes),
    oracle_schema: oracleSchema,
    plan_schema: planSchema,
    registry_schema: registrySchema,
    report_schema: reportSchema,
    request_schema: requestSchema,
    response_schema: responseSchema,
    score_schema: scoreSchema,
    scoring_oracle: JSON.parse(oracleBytes),
    generation_privacy_schema: generationPrivacySchema,
  });
  const context = {
    verification: {
      registry, registrySchema, plan, planSchema, manifest: manifestLoaded.manifest,
      manifestSchema: JSON.parse(manifestSchemaBytes), manifestBytesSha256: sha256(manifestBytes), manifestSchemaBytesSha256: sha256(manifestSchemaBytes),
      requestSchema, responseSchema, reportSchema,
      adapterAvailability: companion.runtime.input_adapters,
      failureEvidenceByAttemptKey,
      artifactEligibilityByCandidateId: Object.fromEntries(Object.entries(companion.artifact_attestation_by_candidate_id).map(([candidateId, evidence]) => [
        candidateId,
        evidence.precheck.status === "failed" ? "precheck_failed" : evidence.before.state,
      ])),
      repositoryRoot: REPO_ROOT,
    },
    oracle: JSON.parse(oracleBytes), oracleBytes, oracleSchema,
    layoutOracle: parsedLayoutOracle, layoutOracleBytes, layoutOracleSchema,
    corpus, pdfjsLib, validatorSourceBytesByRole: companionSourceBytesByRole,
    scoreSchema, indexSchema, scorerSourceBytesByRole, scorerParsedJsonByRole, reportBytes, preflightEvidenceBytes,
  };
  const score = await scorePhase1Report(report, context);
  const scoreFilename = "phase1-score-report.v1.json";
  const provenanceFilename = "phase1-score-provenance.v1.json";
  const bundle = createPhase1ScoreBundle(score, { ...context, scorePath: scoreFilename, indexPath: provenanceFilename });
  await verifyPhase1ScoreBundle({ scoreText: bundle.scoreText, index: bundle.index, report, scorePath: scoreFilename, indexPath: provenanceFilename }, context);
  let scorePrivacyAttestation = null;
  const publicationTransactionId = randomUUID();
  const scoreSemanticVerifier = await createScoreGenerationSemanticVerifier({
    repositoryRoot: REPO_ROOT,
    manifestPath,
    manifestSchemaPath,
    trustedPrivacyClass: companion.privacy.policy,
    trustedProhibitedRoots: destinationTrustedProhibitedRoots,
    trust: { kind: "local_claim_owned", expected_transaction_id: publicationTransactionId, expected_generation_sha256: null },
  });
  const generation = await publishImmutableGeneration({
    parentDirectory: realGenerationRoot,
    runId: report.run_id,
    kind: "score",
    sourceGenerationSha256: sourceGeneration.generation_sha256,
    transactionId: publicationTransactionId,
    artifacts: {
      candidate_registry: { filename: "candidate-registry.v1.json", bytes: retainedRegistryArtifact.bytes },
      phase0_corpus: { filename: "phase0-corpus.v1.json", bytes: (await readVerifiedGenerationArtifact(realExecutionGenerationPath, sourceGeneration, "phase0_corpus")).bytes },
      run_plan: { filename: "run-plan.v1.json", bytes: retainedPlanArtifact.bytes },
      source_execution_companion: { filename: "source-execution-companion.v1.json", bytes: executionCompanionBytes },
      source_execution_report: { filename: "source-execution-report.v1.json", bytes: reportBytes },
      score_provenance: { filename: provenanceFilename, bytes: Buffer.from(bundle.indexText) },
      score_report: { filename: scoreFilename, bytes: Buffer.from(bundle.scoreText) },
    },
    preIndexArtifactBuilder: async ({ stagingPath, artifacts }) => {
      scorePrivacyAttestation = await buildGenerationPrivacyAttestation({
        stagingPath,
        artifacts,
        policy: companion.privacy.policy,
        trustedProhibitedRoots: destinationTrustedProhibitedRoots,
      });
      assertSchema(scorePrivacyAttestation, generationPrivacySchema, "score generation privacy attestation");
      return {
        role: "privacy_attestation",
        filename: "generation-privacy.v1.json",
        bytes: Buffer.from(`${JSON.stringify(scorePrivacyAttestation, null, 2)}\n`),
      };
    },
    finalGenerationVerifier: scoreSemanticVerifier,
  });
  const retained = await inspectGenerationDirectory(generation.generationPath);
  if (retained.state !== "complete" || retained.index.source_generation_sha256 !== sourceGeneration.generation_sha256) throw new Error("Score generation does not bind its execution generation");
  const [{ bytes: retainedScoreBytes }, { bytes: retainedProvenanceBytes }] = await Promise.all([
    readVerifiedGenerationArtifact(generation.generationPath, retained, "score_report"),
    readVerifiedGenerationArtifact(generation.generationPath, retained, "score_provenance"),
  ]);
  const retainedSourceReport = await readVerifiedGenerationArtifact(generation.generationPath, retained, "source_execution_report", { maxBytes: reportLimitPlan.limits.max_report_bytes });
  const retainedCorpus = await loadRetainedPhase1Corpus({
    readArtifact: async role => (await readVerifiedGenerationArtifact(generation.generationPath, retained, role)).bytes,
    corpusSchema,
    trustedPrivacyClass: companion.privacy.policy,
    ...corpusManifestAnchors,
  });
  await verifyPhase1ScoreBundle({
    scoreText: retainedScoreBytes.toString("utf8"), index: JSON.parse(retainedProvenanceBytes), report: JSON.parse(retainedSourceReport.bytes),
    scorePath: scoreFilename, indexPath: provenanceFilename,
  }, { ...context, corpus: retainedCorpus, reportBytes: retainedSourceReport.bytes });
  return { score, provenance: bundle.index, generation, sourceGeneration, semanticVerifier: scoreSemanticVerifier };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const executionGenerationOption = option("--execution-generation", null);
  const generationRootOption = option("--generation-root", null);
  if (!executionGenerationOption || !generationRootOption) throw new Error("Usage: node scripts/eval-score-extraction-candidates.mjs --execution-generation <generation-dir> --generation-root <out-of-repo-dir>");
  const result = await scoreExtractionCandidateReport({
    executionGenerationPath: path.resolve(executionGenerationOption),
    generationRoot: path.resolve(generationRootOption),
    registryPath: path.resolve(option("--registry", path.join(PHASE1_ROOT, "candidate-registry.v1.json"))),
    planPath: path.resolve(option("--plan", path.join(PHASE1_ROOT, "run-plan.v1.json"))),
  });
  process.stdout.write(`${JSON.stringify({ score_generation: result.generation.generationPath, source_generation_sha256: result.sourceGeneration.generation_sha256, denominator: result.score.aggregate.denominator, claim_ready: false }, null, 2)}\n`);
}
