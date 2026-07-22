import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runExtractionCandidates } from "../../scripts/eval-run-extraction-candidates.mjs";
import { scoreExtractionCandidateReport } from "../../scripts/eval-score-extraction-candidates.mjs";
import {
  computeGenerationSha256,
  inspectGenerationDirectory,
  publishImmutableGeneration,
  readVerifiedGenerationArtifact,
  receiveVerifiedGeneration,
} from "./extraction-phase1-publisher.js";
import {
  canonicalJson,
  sha256,
} from "./extraction-phase1-protocol.js";
import {
  createPhase1ScoreBundle,
  exactEditDistance,
  flattenScoringLeaves,
  PHASE1_SCORER_LOCAL_SOURCE_PATHS,
  scorePhase1Report,
  scoreDistinctFragmentSequence,
  scoreRawTableValueClass,
  validatePhase1ScoringOracle,
  verifyPhase1ScoreBundle,
} from "./extraction-phase1-scorer.js";
import { createPhase1TestDeployment } from "./extraction-phase1-test-artifacts.js";
import {
  buildGenerationPrivacyAttestation,
  companionProhibitedRootSetSha256,
  createCrossDeviceReceipt,
  generationProhibitedRootSetSha256,
  verifyFinalGenerationPrivacy,
} from "./extraction-phase1-companion.js";
import { PHASE1_COMPANION_SOURCE_PATHS } from "./extraction-phase1-companion.js";
import { buildRetainedPhase1Corpus } from "./extraction-phase1-corpus.js";
import {
  createExecutionGenerationSemanticVerifier,
  createScoreGenerationSemanticVerifier,
} from "./extraction-phase1-generation-verifiers.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTRACTION_ROOT = path.join(REPO_ROOT, "test", "fixtures", "eval", "extraction");
const PHASE1_ROOT = path.join(EXTRACTION_ROOT, "phase1");
const PATHS = {
  manifest: path.join(EXTRACTION_ROOT, "manifest.v1.json"),
  manifestSchema: path.join(EXTRACTION_ROOT, "manifest.schema.json"),
  registry: path.join(PHASE1_ROOT, "candidate-registry.v1.json"),
  registrySchema: path.join(PHASE1_ROOT, "candidate-registry.schema.json"),
  plan: path.join(PHASE1_ROOT, "run-plan.v1.json"),
  planSchema: path.join(PHASE1_ROOT, "run-plan.schema.json"),
  requestSchema: path.join(PHASE1_ROOT, "candidate-request.schema.json"),
  responseSchema: path.join(PHASE1_ROOT, "candidate-response.schema.json"),
  reportSchema: path.join(PHASE1_ROOT, "report.schema.json"),
  oracle: path.join(PHASE1_ROOT, "scoring-oracle.v1.json"),
  oracleSchema: path.join(PHASE1_ROOT, "scoring-oracle.schema.json"),
  layoutOracle: path.join(PHASE1_ROOT, "layout-occurrence-oracle.v1.json"),
  layoutOracleSchema: path.join(PHASE1_ROOT, "layout-occurrence-oracle.schema.json"),
  corpusSchema: path.join(PHASE1_ROOT, "corpus.schema.json"),
  scoreSchema: path.join(PHASE1_ROOT, "score-report.schema.json"),
  indexSchema: path.join(PHASE1_ROOT, "score-index.schema.json"),
  scorerSource: path.join(REPO_ROOT, "test", "eval", "extraction-phase1-scorer.js"),
  orchestration: path.join(REPO_ROOT, "scripts", "eval-score-extraction-candidates.mjs"),
};
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, "utf8"));
}

async function scoringContext(report, verificationEvidence, { registryPath = PATHS.registry, planPath = PATHS.plan } = {}) {
  const [manifestBytes, manifestSchemaBytes, registry, registrySchema, plan, planSchema, requestSchema, responseSchema, reportSchema, oracleBytes, oracleSchema, layoutOracleBytes, layoutOracleSchema, corpusSchema, scoreSchema, indexSchema] = await Promise.all([
    fs.readFile(PATHS.manifest), fs.readFile(PATHS.manifestSchema), readJson(registryPath), readJson(PATHS.registrySchema), readJson(planPath), readJson(PATHS.planSchema),
    readJson(PATHS.requestSchema), readJson(PATHS.responseSchema), readJson(PATHS.reportSchema), fs.readFile(PATHS.oracle), readJson(PATHS.oracleSchema), fs.readFile(PATHS.layoutOracle), readJson(PATHS.layoutOracleSchema), readJson(PATHS.corpusSchema), readJson(PATHS.scoreSchema), readJson(PATHS.indexSchema),
  ]);
  const manifest = JSON.parse(manifestBytes);
  const fixtureBytesById = Object.fromEntries(await Promise.all(report.denominator.planned_case_ids.map(async caseId => {
    const fixture = manifest.fixtures.find(item => item.id === caseId);
    return [caseId, await fs.readFile(path.join(EXTRACTION_ROOT, fixture.path))];
  })));
  const corpus = await buildRetainedPhase1Corpus({ manifestBytes, manifestSchemaBytes, selectedCaseIds: report.denominator.planned_case_ids, fixtureBytesById, trustedPrivacyClass: "public_synthetic", corpusSchema });
  const validatorSourceBytesByRole = Object.fromEntries(await Promise.all(Object.entries(PHASE1_COMPANION_SOURCE_PATHS).map(async ([role, relativePath]) => [role, { path: relativePath, bytes: await fs.readFile(path.join(REPO_ROOT, relativePath)) }])));
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const scorerSourceBytesByRole = Object.fromEntries(await Promise.all(Object.entries(PHASE1_SCORER_LOCAL_SOURCE_PATHS).map(async ([role, relativePath]) => [role, { path: relativePath, bytes: await fs.readFile(path.join(REPO_ROOT, relativePath)) }])));
  const scorerParsedJsonByRole = Object.fromEntries(Object.entries(scorerSourceBytesByRole)
    .filter(([, source]) => source.path.endsWith(".json"))
    .map(([role, source]) => [role, JSON.parse(source.bytes)]));
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  const preflightEvidenceBytes = Buffer.from(`${JSON.stringify({ report_id: report.report_id, run_id: report.run_id, preflight_evidence_sha256: report.preflight_evidence_sha256, failure_evidence_by_attempt_key: verificationEvidence.failureEvidenceByAttemptKey }, null, 2)}\n`);
  return {
    verification: {
      registry, registrySchema, plan, planSchema, manifest, manifestSchema: JSON.parse(manifestSchemaBytes),
      manifestBytesSha256: sha256(manifestBytes), manifestSchemaBytesSha256: sha256(manifestSchemaBytes),
      requestSchema, responseSchema, reportSchema,
      adapterAvailability: verificationEvidence.adapterAvailability,
      failureEvidenceByAttemptKey: verificationEvidence.failureEvidenceByAttemptKey,
      repositoryRoot: REPO_ROOT,
    },
    oracle: JSON.parse(oracleBytes), oracleBytes, oracleSchema,
    layoutOracle: JSON.parse(layoutOracleBytes), layoutOracleBytes, layoutOracleSchema,
    corpus, pdfjsLib, validatorSourceBytesByRole,
    scoreSchema, indexSchema, scorerSourceBytesByRole, scorerParsedJsonByRole, reportBytes, preflightEvidenceBytes,
  };
}

const CANDIDATE_SOURCE = `
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const mode = process.argv[2];
if (mode === "error") { process.stdout.write("not-json"); process.exit(0); }
const properties = request.task.target_schema.properties;
let structured;
let gaps = [];
let tables = [];
let text = "";
let abstainAll = false;
if (properties.tags) {
  structured = { customer_id: "C-204", organization: "Alpine Works", address: { street: "77 Cedar Avenue", city: "Portland", region: "OR", postal_code: "97205" }, tags: mode === "hostile" ? ["priority", "renewal", "extra"] : ["renewal", "priority"], active: true };
  text = "SYNTHETIC CUSTOMER RECORD Customer ID: C-204 Organization: Alpine Works Street: 77 Cedar Avenue City: Portland Region: OR Postal code: 97205 Tags: renewal, priority Active: yes";
  if (mode === "partial-one") { structured = { customer_id: "C-204" }; gaps = ["/active","/address/city","/address/postal_code","/address/region","/address/street","/organization","/tags"].map(field_path => ({ field_path, reason: "insufficient_evidence", detail: "Test selective answer" })); }
  if (mode === "hostile") tables = [{ id: "extra", pages: [1], row_count: 1, column_count: 2, merged_regions: [{ start_row: 1, start_column: 1, end_row: 1, end_column: 2 }], cells: [{ row: 1, column: 1, row_span: 1, column_span: 2, present: true, value: null }] }];
} else if (properties.events) {
  structured = { events: mode === "reverse" ? ["Decision follows review.", "Review starts August 2.", "Claims close July 31.", "Coverage begins July 1."] : ["Coverage begins July 1.", "Claims close July 31.", "Review starts August 2.", "Decision follows review."] };
  text = "TWO COLUMN NOTICE LEFT-1 Coverage begins July 1. LEFT-2 Claims close July 31. RIGHT-1 Review starts August 2. RIGHT-2 Decision follows review.";
} else if (properties.rows) {
  structured = { title: "Q3 PURCHASES", headers: ["Item", "Qty", "Amount"], rows: [{ item: "Paper", qty: 2, amount: 20 }, { item: "Delivery", qty: null, amount: 5 }] };
  text = "Q3 PURCHASES Item Qty Amount Paper 2 USD 20.00 Delivery USD 5.00";
  tables = [{ id: "table.1", pages: [1], row_count: 4, column_count: 3, merged_regions: [{ start_row: 1, start_column: 1, end_row: 1, end_column: 3 }], cells: [
    { row: 1, column: 1, row_span: 1, column_span: 3, present: true, value: "Q3 PURCHASES" },
    ...[[2,1,"Item"],[2,2,"Qty"],[2,3,"Amount"],[3,1,"Paper"],[3,2,"2"],[3,3,"USD 20.00"],[4,1,"Delivery"],[4,2,""],[4,3,"USD 5.00"]].map(([row,column,value]) => ({ row, column, row_span: 1, column_span: 1, present: true, value }))
  ] }];
  if (mode === "duplicate-table") tables.push({ ...structuredClone(tables[0]), id: "table.2" });
  const wrongTable = { id: "wrong", pages: [1], row_count: 4, column_count: 3, merged_regions: [], cells: [{ row: 1, column: 1, row_span: 1, column_span: 1, present: true, value: "WRONG" }] };
  if (mode === "correct-wrong") tables.push(wrongTable);
  if (mode === "wrong-correct") tables.unshift(wrongTable);
  if (mode === "alt-table") tables = [{ ...tables[0], merged_regions: [{ start_row: 1, start_column: 1, end_row: 1, end_column: 2 }], cells: [{ row: 1, column: 1, row_span: 1, column_span: 2, present: true, value: "Q3 PURCHASES" }, { row: 1, column: 3, row_span: 1, column_span: 1, present: true, value: "" }, ...tables[0].cells.slice(1)] }];
  if (mode === "covered-cell") tables[0].cells.push({ row: 1, column: 2, row_span: 1, column_span: 1, present: true, value: "covered" });
} else {
  structured = { answer_state: "contradictory_and_absent" };
  gaps = [{ field_path: "/final_status", reason: "contradictory_source", detail: "No final status" }, { field_path: "/settlement_amount", reason: mode === "wrong-gap" ? "contradictory_source" : "absent_in_source", detail: "No settlement amount" }];
  text = "SYNTHETIC REVIEW LOG Reviewer A status: APPROVED Reviewer B status: REJECTED Final status: not recorded Final settlement amount: not provided";
  if (mode === "completed-null") { structured = { answer_state: "contradictory_and_absent", final_status: null, settlement_amount: null }; gaps = []; }
  if (mode === "abstain-all") { structured = null; abstainAll = true; gaps = [{ field_path: "/answer_state", reason: "insufficient_evidence", detail: "No answer" }, { field_path: "/final_status", reason: "contradictory_source", detail: "No final status" }, { field_path: "/settlement_amount", reason: "absent_in_source", detail: "No settlement" }]; }
}
const partial = gaps.length > 0;
if (mode === "large-valid") text = "x".repeat(7 * 1024 * 1024);
const page = { page: 1, text, text_kind: "visual_parser", source_item_ids: [], origin: { engine_id: "phase1-score-test", engine_version: "1.0.0" } };
process.stdout.write(JSON.stringify({ protocol: request.protocol, request_id: request.request_id, status: abstainAll ? "abstained" : partial ? "partial" : "completed", decision: abstainAll ? "abstain" : "answer", structured_candidate: structured, page_texts: mode === "hostile" ? [page, page] : abstainAll ? [] : [page], tables, native_evidence: [], evidence: [], field_evidence: [], gaps, diagnostics: { code: null, message: null } }));
`;

async function configuredReport(caseIds, mode = "ideal", {
  persist = false,
  repetitions = null,
  maxStdoutBytes = null,
  maxReportBytes = null,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-phase1-score-"));
  temporaryRoots.push(root);
  const [registry, plan] = await Promise.all([readJson(PATHS.registry), readJson(PATHS.plan)]);
  const candidate = registry.candidates.find(item => item.id === "candidate.direct_pdf.v1");
  const deployment = await createPhase1TestDeployment({
    root,
    candidateId: candidate.id,
    sourceBytes: Buffer.from(CANDIDATE_SOURCE),
    filename: "candidate.mjs",
  });
  Object.assign(candidate, {
    configured: true,
    version: "score-test-1.0.0",
    license: { framework_spdx: "MIT", model_license: null, reviewed: true },
    command: { executable: process.execPath, args: [deployment.candidatePath, mode] },
  });
  plan.case_ids = caseIds;
  plan.candidates = [{ candidate_id: candidate.id, input_mode: "direct_pdf" }];
  plan.limits.deadline_ms = 2000;
  plan.limits.max_stdout_bytes = 1024 * 1024;
  plan.limits.max_stderr_bytes = 64 * 1024;
  plan.limits.max_request_bytes = 256 * 1024;
  if (repetitions !== null) plan.repetitions = repetitions;
  if (maxStdoutBytes !== null) plan.limits.max_stdout_bytes = maxStdoutBytes;
  if (maxReportBytes !== null) plan.limits.max_report_bytes = maxReportBytes;
  const registryPath = path.join(root, "registry.json");
  const planPath = path.join(root, "plan.json");
  await Promise.all([fs.writeFile(registryPath, JSON.stringify(registry)), fs.writeFile(planPath, JSON.stringify(plan))]);
  const verificationEvidence = {};
  const generationRoot = persist ? path.join(root, "execution-generations") : null;
  const report = await runExtractionCandidates({
    registryPath,
    planPath,
    verificationEvidence,
    artifactConfigurations: { [candidate.id]: deployment.artifactConfiguration },
    generationRoot,
  });
  return {
    report,
    context: await scoringContext(report, verificationEvidence, { registryPath, planPath }),
    generation: verificationEvidence.generation ?? null,
    registryPath,
    planPath,
    root,
  };
}

describe("structured extraction Phase 1 pure scorer", () => {
  it("computes exact Unicode edit distance in time linear in candidate length", () => {
    const reference = (actual, expected) => {
      const left = [...actual];
      const right = [...expected];
      let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
      for (let row = 1; row <= left.length; row += 1) {
        const current = [row];
        for (let column = 1; column <= right.length; column += 1) current[column] = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + Number(left[row - 1] !== right[column - 1]));
        previous = current;
      }
      return previous[right.length];
    };
    for (const [actual, expected] of [["", ""], ["abc", ""], ["", "abc"], ["kitten", "sitting"], ["Saturday", "Sunday"], ["A😀B", "A😃B"], ["😀😀", "😀"]]) {
      expect(exactEditDistance(actual, expected), `${actual} -> ${expected}`).toBe(reference(actual, expected));
      expect(exactEditDistance(expected, actual), `${expected} -> ${actual}`).toBe(reference(expected, actual));
    }
    const hostile = "x".repeat(1_000_000);
    expect(exactEditDistance(hostile, "x")).toBe(999_999);
  }, 5_000);

  it("executes, persists, reloads, and independently rescores the all-not-run report", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-phase1-score-cli-"));
    temporaryRoots.push(root);
    const executionRoot = path.join(root, "executions");
    const scoreRoot = path.join(root, "scores");
    const verificationEvidence = {};
    await runExtractionCandidates({ generationRoot: executionRoot, verificationEvidence });
    const executionGenerationPath = verificationEvidence.generation.generationPath;
    const result = await scoreExtractionCandidateReport({ executionGenerationPath, generationRoot: scoreRoot });
    expect(result.score.aggregate.denominator).toMatchObject({ planned: 120, quality_available: 0, outcomes: { not_run: 120 } });
    expect(result.score.stability.every(group => group.stable === null)).toBe(true);
    const inspection = await inspectGenerationDirectory(result.generation.generationPath);
    expect(inspection).toMatchObject({
      state: "complete",
      index: { kind: "score", source_generation_sha256: verificationEvidence.generation.generation_sha256 },
    });
    expect(inspection.index.artifacts.map(item => item.role)).toEqual([
      "candidate_registry", "phase0_corpus", "privacy_attestation", "run_plan", "score_provenance", "score_report",
      "source_execution_companion", "source_execution_report",
    ]);
    const receivedScoreRoot = path.join(root, "received-score-generation");
    await fs.mkdir(receivedScoreRoot, { mode: 0o700 });
    await expect(receiveVerifiedGeneration({
      sourceGenerationPath: result.generation.generationPath,
      destinationParentDirectory: receivedScoreRoot,
      sourceHost: "silverbook",
      destinationHost: "silvercloud",
      transportedAt: "2026-07-22T00:00:00Z",
      transport: "tailscale_tailnet",
      trustedSourceGenerationSha256: result.generation.generation_sha256,
    })).rejects.toThrow(/composite extraction semantic verifier/);
    const scoreTransferVerifier = await createScoreGenerationSemanticVerifier({
      repositoryRoot: REPO_ROOT,
      manifestPath: PATHS.manifest,
      manifestSchemaPath: PATHS.manifestSchema,
      trustedPrivacyClass: "public_synthetic",
      trust: { kind: "out_of_band_source_generation_sha256", expected_source_generation_sha256: result.generation.generation_sha256 },
    });
    const receivedScoreGeneration = await receiveVerifiedGeneration({
      sourceGenerationPath: result.generation.generationPath,
      destinationParentDirectory: receivedScoreRoot,
      sourceHost: "silverbook",
      destinationHost: "silvercloud",
      transportedAt: "2026-07-22T00:00:00Z",
      transport: "tailscale_tailnet",
      trustedSourceGenerationSha256: result.generation.generation_sha256,
      semanticVerifier: scoreTransferVerifier,
    });
    expect(receivedScoreGeneration.destination.index.kind).toBe("received_score");
    expect(receivedScoreGeneration.receipt.source_code_identity).toEqual({
      kind: "score_scorer_local_source_set_sha256",
      sha256: result.provenance.bindings.scorer_local_source_set_sha256,
      source_artifact_role: "score_provenance",
    });
    const receivedRoot = path.join(root, "received");
    await fs.mkdir(receivedRoot, { mode: 0o700 });
    const executionTransferVerifier = await createExecutionGenerationSemanticVerifier({
      repositoryRoot: REPO_ROOT,
      manifestPath: PATHS.manifest,
      manifestSchemaPath: PATHS.manifestSchema,
      trustedPrivacyClass: "public_synthetic",
      trust: { kind: "out_of_band_source_generation_sha256", expected_source_generation_sha256: verificationEvidence.generation.generation_sha256 },
    });
    const received = await receiveVerifiedGeneration({
      sourceGenerationPath: executionGenerationPath,
      destinationParentDirectory: receivedRoot,
      sourceHost: "silverbook",
      destinationHost: "silvercloud",
      transportedAt: "2026-07-22T00:00:00Z",
      transport: "tailscale_tailnet",
      trustedSourceGenerationSha256: verificationEvidence.generation.generation_sha256,
      semanticVerifier: executionTransferVerifier,
    });
    const receivedScore = await scoreExtractionCandidateReport({
      executionGenerationPath: received.generationPath,
      generationRoot: path.join(root, "received-scores"),
    });
    expect(receivedScore.generation.index.source_generation_sha256).toBe(received.generation_sha256);

    const receivedInspection = await inspectGenerationDirectory(received.generationPath);
    const receivedArtifacts = Object.fromEntries(await Promise.all(receivedInspection.index.artifacts.map(async record => [
      record.role,
      { filename: record.path, bytes: (await readVerifiedGenerationArtifact(received.generationPath, receivedInspection, record.role)).bytes },
    ])));
    const wrongKindArtifacts = Object.fromEntries(Object.entries(receivedArtifacts)
      .filter(([role]) => role !== "received_privacy_attestation")
      .map(([role, artifact]) => [role, { filename: artifact.filename, bytes: Buffer.from(artifact.bytes) }]));
    const wrongKindSourceIndex = JSON.parse(wrongKindArtifacts.source_generation_index.bytes);
    wrongKindSourceIndex.kind = "score";
    wrongKindSourceIndex.source_generation_sha256 = "1".repeat(64);
    const { index_content_sha256: ignoredIndexDigest, ...wrongKindIndexContent } = wrongKindSourceIndex;
    wrongKindSourceIndex.index_content_sha256 = sha256(Buffer.from(
      `pdf-tools.extraction-phase1-execution-index.v1\0${canonicalJson(wrongKindIndexContent)}`,
    ));
    wrongKindArtifacts.source_generation_index.bytes = Buffer.from(`${JSON.stringify(wrongKindSourceIndex, null, 2)}\n`);
    const wrongKindSourceGenerationSha256 = computeGenerationSha256(
      wrongKindSourceIndex,
      wrongKindArtifacts.source_generation_index.bytes,
    );
    const originalReceipt = JSON.parse(wrongKindArtifacts.transfer_receipt.bytes);
    const wrongKindReceipt = createCrossDeviceReceipt({
      runId: wrongKindSourceIndex.run_id,
      indexBytes: wrongKindArtifacts.source_generation_index.bytes,
      sourceGenerationSha256: wrongKindSourceGenerationSha256,
      sourceHost: originalReceipt.source_host,
      destinationHost: originalReceipt.destination_host,
      sourceCodeIdentity: originalReceipt.source_code_identity,
      transportedAt: originalReceipt.transported_at,
      transport: originalReceipt.transport,
    });
    wrongKindArtifacts.transfer_receipt.bytes = Buffer.from(`${JSON.stringify(wrongKindReceipt, null, 2)}\n`);
    const wrongKindRoot = path.join(root, "hostile-wrong-source-kind");
    await fs.mkdir(wrongKindRoot, { mode: 0o700 });
    let wrongKindPrivacy;
    const wrongKindGeneration = await publishImmutableGeneration({
      parentDirectory: wrongKindRoot,
      runId: receivedInspection.index.run_id,
      kind: "received_execution",
      sourceGenerationSha256: wrongKindSourceGenerationSha256,
      artifacts: wrongKindArtifacts,
      preIndexArtifactBuilder: async ({ stagingPath, artifacts }) => {
        wrongKindPrivacy = await buildGenerationPrivacyAttestation({
          stagingPath,
          artifacts,
          policy: "public_synthetic",
          trustedProhibitedRoots: [],
        });
        return {
          role: "received_privacy_attestation",
          filename: "received-generation-privacy.v1.json",
          bytes: Buffer.from(`${JSON.stringify(wrongKindPrivacy, null, 2)}\n`),
        };
      },
      finalGenerationVerifier: context => verifyFinalGenerationPrivacy({
        ...context,
        privacyAttestation: wrongKindPrivacy,
        privacyRole: "received_privacy_attestation",
      }),
    });
    await expect(scoreExtractionCandidateReport({
      executionGenerationPath: wrongKindGeneration.generationPath,
      generationRoot: path.join(root, "hostile-score-wrong-source-kind"),
    })).rejects.toThrow(/source generation digest is inconsistent/);
    const hostileCases = [
      ["source-index-bytes", artifacts => { artifacts.source_generation_index.bytes = Buffer.from("{}\n"); }, receivedInspection.index.source_generation_sha256],
      ["receipt-index-mismatch", artifacts => {
        const receipt = JSON.parse(artifacts.transfer_receipt.bytes);
        receipt.index_raw_sha256 = "0".repeat(64);
        artifacts.transfer_receipt.bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
      }, receivedInspection.index.source_generation_sha256],
      ["source-generation-digest", () => {}, "0".repeat(64)],
      ["missing-transfer-metadata", artifacts => { delete artifacts.source_generation_index; }, receivedInspection.index.source_generation_sha256],
      ["extra-transfer-metadata", artifacts => {
        artifacts.unexpected_transfer_metadata = { filename: "unexpected-transfer.json", bytes: Buffer.from("{}\n") };
      }, receivedInspection.index.source_generation_sha256],
    ];
    for (const [label, mutate, sourceGenerationSha256] of hostileCases) {
      const hostileArtifacts = Object.fromEntries(Object.entries(receivedArtifacts).map(([role, artifact]) => [role, {
        filename: artifact.filename,
        bytes: Buffer.from(artifact.bytes),
      }]));
      mutate(hostileArtifacts);
      delete hostileArtifacts.received_privacy_attestation;
      const hostileRoot = path.join(root, `hostile-${label}`);
      await fs.mkdir(hostileRoot, { mode: 0o700 });
      let hostileReceivedPrivacy;
      const hostile = await publishImmutableGeneration({
        parentDirectory: hostileRoot,
        runId: receivedInspection.index.run_id,
        kind: "received_execution",
        sourceGenerationSha256,
        artifacts: hostileArtifacts,
        preIndexArtifactBuilder: async ({ stagingPath, artifacts }) => {
          hostileReceivedPrivacy = await buildGenerationPrivacyAttestation({
            stagingPath,
            artifacts,
            policy: "public_synthetic",
            trustedProhibitedRoots: [],
          });
          return {
            role: "received_privacy_attestation",
            filename: "received-generation-privacy.v1.json",
            bytes: Buffer.from(`${JSON.stringify(hostileReceivedPrivacy, null, 2)}\n`),
          };
        },
        finalGenerationVerifier: context => verifyFinalGenerationPrivacy({
          ...context,
          privacyAttestation: hostileReceivedPrivacy,
          privacyRole: "received_privacy_attestation",
        }),
      });
      await expect(scoreExtractionCandidateReport({
        executionGenerationPath: hostile.generationPath,
        generationRoot: path.join(root, `hostile-score-${label}`),
      }), label).rejects.toThrow();
    }
    const forgedArtifacts = Object.fromEntries(Object.entries(receivedArtifacts)
      .filter(([role]) => role !== "received_privacy_attestation")
      .map(([role, artifact]) => [role, { filename: artifact.filename, bytes: Buffer.from(artifact.bytes) }]));
    const forgedCompanion = JSON.parse(forgedArtifacts.execution_companion.bytes);
    forgedCompanion.privacy.run_root_sha256 = "f".repeat(64);
    forgedArtifacts.execution_companion.bytes = Buffer.from(`${JSON.stringify(forgedCompanion, null, 2)}\n`);
    const forgedRoot = path.join(root, "hostile-ordinary-companion-swap");
    await fs.mkdir(forgedRoot, { mode: 0o700 });
    let forgedReceivedPrivacy;
    const forged = await publishImmutableGeneration({
      parentDirectory: forgedRoot,
      runId: receivedInspection.index.run_id,
      kind: "received_execution",
      sourceGenerationSha256: receivedInspection.index.source_generation_sha256,
      artifacts: forgedArtifacts,
      preIndexArtifactBuilder: async ({ stagingPath, artifacts }) => {
        forgedReceivedPrivacy = await buildGenerationPrivacyAttestation({
          stagingPath,
          artifacts,
          policy: "public_synthetic",
          trustedProhibitedRoots: [],
        });
        return {
          role: "received_privacy_attestation",
          filename: "received-generation-privacy.v1.json",
          bytes: Buffer.from(`${JSON.stringify(forgedReceivedPrivacy, null, 2)}\n`),
        };
      },
      finalGenerationVerifier: context => verifyFinalGenerationPrivacy({
        ...context,
        privacyAttestation: forgedReceivedPrivacy,
        privacyRole: "received_privacy_attestation",
      }),
    });
    await expect(scoreExtractionCandidateReport({
      executionGenerationPath: forged.generationPath,
      generationRoot: path.join(root, "hostile-score-ordinary-companion-swap"),
    })).rejects.toThrow(/changed an original source artifact record/);
    await expect(scoreExtractionCandidateReport({
      executionGenerationPath,
      generationRoot: path.join(REPO_ROOT, "forbidden-score-generation"),
    })).rejects.toThrow(/outside the repository/);
    const repoExecutionRoot = await fs.mkdtemp(path.join(REPO_ROOT, ".phase1-score-input-test-"));
    temporaryRoots.push(repoExecutionRoot);
    const repoExecutionPath = path.join(repoExecutionRoot, "copied-generation");
    await fs.cp(executionGenerationPath, repoExecutionPath, { recursive: true, preserveTimestamps: true });
    await fs.chmod(repoExecutionPath, 0o700);
    await Promise.all((await fs.readdir(repoExecutionPath)).map(filename => fs.chmod(path.join(repoExecutionPath, filename), 0o600)));
    await expect(scoreExtractionCandidateReport({
      executionGenerationPath: repoExecutionPath,
      generationRoot: path.join(root, "forbidden-input-score"),
    })).rejects.toThrow(/input generations must remain outside/);
    await expect(scoreExtractionCandidateReport({ reportPath: path.join(root, "legacy.json"), scorePath: path.join(root, "legacy-score.json") })).rejects.toThrow(/executionGenerationPath/);

    const privateExecutionRoot = path.join(root, "private-executions");
    const sourceSyncRoot = path.join(root, "simulated-source-sync-root");
    const destinationSyncRoot = path.join(root, "simulated-destination-sync-root");
    await Promise.all([fs.mkdir(sourceSyncRoot, { mode: 0o700 }), fs.mkdir(destinationSyncRoot, { mode: 0o700 })]);
    const sourceProhibitedRoots = [REPO_ROOT, sourceSyncRoot];
    const destinationProhibitedRoots = [REPO_ROOT, destinationSyncRoot];
    const trustedSourcePrivacyDigests = {
      companion_prohibited_root_set_sha256: companionProhibitedRootSetSha256(sourceProhibitedRoots),
      generation_prohibited_root_set_sha256: generationProhibitedRootSetSha256(sourceProhibitedRoots),
    };
    const privateEvidence = {};
    await runExtractionCandidates({
      generationRoot: privateExecutionRoot,
      verificationEvidence: privateEvidence,
      trustedPrivacyClass: "private_local",
      trustedProhibitedRoots: sourceProhibitedRoots,
    });
    await expect(scoreExtractionCandidateReport({
      executionGenerationPath: privateEvidence.generation.generationPath,
      generationRoot: path.join(root, "private-scores-missing-policy"),
    })).rejects.toThrow(/trusted prohibited roots/);
    const privateScore = await scoreExtractionCandidateReport({
      executionGenerationPath: privateEvidence.generation.generationPath,
      generationRoot: path.join(root, "private-scores"),
      trustedSourcePrivacyDigests,
      destinationTrustedProhibitedRoots: destinationProhibitedRoots,
    });
    expect(privateScore.generation.index.artifacts.map(item => item.role)).toContain("privacy_attestation");
    await expect(scoreExtractionCandidateReport({
      executionGenerationPath: privateEvidence.generation.generationPath,
      generationRoot: path.join(destinationSyncRoot, "score-output"),
      trustedSourcePrivacyDigests,
      destinationTrustedProhibitedRoots: destinationProhibitedRoots,
    })).rejects.toThrow(/trusted prohibited/);
    expect(await fs.readdir(destinationSyncRoot)).toEqual([]);

    const privateReceivedRoot = path.join(root, "private-received");
    await fs.mkdir(privateReceivedRoot, { mode: 0o700 });
    const privateTransferVerifier = await createExecutionGenerationSemanticVerifier({
      repositoryRoot: REPO_ROOT,
      manifestPath: PATHS.manifest,
      manifestSchemaPath: PATHS.manifestSchema,
      trustedPrivacyClass: "private_local",
      trustedSourceProhibitedRoots: sourceProhibitedRoots,
      trustedReceivedProhibitedRoots: destinationProhibitedRoots,
      trust: { kind: "out_of_band_source_generation_sha256", expected_source_generation_sha256: privateEvidence.generation.generation_sha256 },
    });
    const privateReceived = await receiveVerifiedGeneration({
      sourceGenerationPath: privateEvidence.generation.generationPath,
      destinationParentDirectory: privateReceivedRoot,
      sourceHost: "silverbook",
      destinationHost: "silvercloud",
      transportedAt: "2026-07-22T00:00:00Z",
      transport: "tailscale_tailnet",
      trustedSourceGenerationSha256: privateEvidence.generation.generation_sha256,
      trustedSourceProhibitedRootSetSha256: trustedSourcePrivacyDigests.generation_prohibited_root_set_sha256,
      destinationTrustedProhibitedRoots: destinationProhibitedRoots,
      semanticVerifier: privateTransferVerifier,
    });
    const privateReceivedScore = await scoreExtractionCandidateReport({
      executionGenerationPath: privateReceived.generationPath,
      generationRoot: path.join(root, "private-received-scores"),
      trustedSourcePrivacyDigests,
      destinationTrustedProhibitedRoots: destinationProhibitedRoots,
    });
    expect(privateReceivedScore.generation.index.kind).toBe("score");
  }, 60_000);

  it("scores a valid report larger than 16 MiB within its explicit plan cap", async () => {
    const nestedId = "pdf-tools.extraction.phase0.born-digital-nested";
    const large = await configuredReport([nestedId], "large-valid", {
      persist: true,
      repetitions: 1,
      maxStdoutBytes: 16 * 1024 * 1024,
      maxReportBytes: 64 * 1024 * 1024,
    });
    const inspection = await inspectGenerationDirectory(large.generation.generationPath);
    const reportRecord = inspection.index.artifacts.find(item => item.role === "execution_report");
    expect(reportRecord.bytes).toBeGreaterThan(16 * 1024 * 1024);
    expect(reportRecord.bytes).toBeLessThanOrEqual(64 * 1024 * 1024);

    const scored = await scoreExtractionCandidateReport({
      executionGenerationPath: large.generation.generationPath,
      generationRoot: path.join(large.root, "score-generations"),
      registryPath: large.registryPath,
      planPath: large.planPath,
    });
    expect(scored.generation.index).toMatchObject({ kind: "score", state: "complete" });
    const scoredInspection = await inspectGenerationDirectory(scored.generation.generationPath);
    const retainedPlan = await readVerifiedGenerationArtifact(scored.generation.generationPath, scoredInspection, "run_plan");
    expect(JSON.parse(retainedPlan.bytes)).toEqual(await readJson(large.planPath));
  }, 60_000);

  it("keeps every all-not-run attempt operationally visible without inventing quality", async () => {
    const verificationEvidence = {};
    const report = await runExtractionCandidates({ verificationEvidence });
    const context = await scoringContext(report, verificationEvidence);
    const score = await scorePhase1Report(report, context);
    expect(score.aggregate.denominator).toMatchObject({ planned: 120, retained: 120, configured: 0, spawned: 0, quality_available: 0, outcomes: { not_run: 120 } });
    expect(score.aggregate.structured).toMatchObject({ truth_data_leaves: 0, correct: 0, missing: 0, false_answers: 0, false_abstentions: 0 });
    expect(score.aggregate.text).toMatchObject({ pages: 0, fragments: 0, character_distance: 0 });
    expect(score.stability.every(group => group.stable === null && group.outcome_consistent && !group.quality_credit)).toBe(true);
    expect(score.benchmark_claim_ready).toBe(false);

    const bundle = createPhase1ScoreBundle(score, context);
    expect(() => createPhase1ScoreBundle(score, { ...context, scorePath: "same.json", indexPath: "same.json" })).toThrow(/must be distinct/);
    await expect(verifyPhase1ScoreBundle({ scoreText: bundle.scoreText, index: bundle.index, report }, context)).resolves.toBe(true);
    const hostileScore = JSON.parse(bundle.scoreText);
    hostileScore.aggregate.denominator.quality_available = 120;
    const hostileText = `${JSON.stringify(hostileScore, null, 2)}\n`;
    const hostileIndex = structuredClone(bundle.index);
    hostileIndex.score_report.bytes = Buffer.byteLength(hostileText);
    hostileIndex.score_report.sha256 = sha256(Buffer.from(hostileText));
    await expect(verifyPhase1ScoreBundle({ scoreText: hostileText, index: hostileIndex, report }, context)).rejects.toThrow(/independent rescore/);
  }, 30_000);

  it("scores array leaves, typed abstention, text, raw tables, and three-run stability independently", async () => {
    const ids = [
      "pdf-tools.extraction.phase0.born-digital-nested",
      "pdf-tools.extraction.phase0.table-merged-blank",
      "pdf-tools.extraction.phase0.no-answer-contradiction",
    ];
    const { report, context } = await configuredReport(ids);
    const score = await scorePhase1Report(report, context);
    expect(score.aggregate.denominator).toMatchObject({ planned: 9, configured: 9, spawned: 9, quality_available: 9 });
    const nested = score.attempts.find(item => item.case_id.endsWith("born-digital-nested"));
    expect(nested.structured.data_leaves).toMatchObject({ truth: 9, candidate: 9, correct: 9, wrong: 0, spurious: 0, shifted_array: 0 });
    const table = score.attempts.find(item => item.case_id.endsWith("table-merged-blank"));
    expect(table.table).toMatchObject({ expected_tables: 1, observed_tables: 1, missing_tables: 0, spurious_tables: 0, detected: true, cells: { correct: 10, missing: 0, wrong: 0, spurious: 0 }, blank: { expected: 1, correct: 1 } });
    const selective = score.attempts.find(item => item.case_id.endsWith("no-answer-contradiction"));
    expect(selective.structured).toMatchObject({ schema_valid: true, schema_scope: "answered_projection" });
    expect(selective.structured.data_leaves).toMatchObject({ truth: 1, candidate: 1, correct: 1, missing: 0 });
    expect(selective.structured.contract_leaves).toMatchObject({ correctly_abstained: 2, false_answers: 0, false_abstentions: 0, typed_gap_correct: 2 });
    expect(score.stability.every(group => group.stable === true && group.quality_credit)).toBe(true);
    expect(score.aggregate.resources).toMatchObject({ process_tree_peak_rss_bytes: null, network_egress_bytes: null });
  }, 30_000);

  it("fails closed on shifted arrays, duplicate pages, extra tables, false null answers, and wrong gap reasons", async () => {
    const nestedId = "pdf-tools.extraction.phase0.born-digital-nested";
    const hostile = await configuredReport([nestedId], "hostile");
    const hostileScore = (await scorePhase1Report(hostile.report, hostile.context)).attempts[0];
    expect(hostileScore.structured.data_leaves).toMatchObject({ wrong: 2, spurious: 1, shifted_array: 2 });
    expect(hostileScore.text).toMatchObject({ duplicate_pages: 1, pages_present: 1, fragments_found: 0, ordered_pages: 0 });
    expect(hostileScore.table).toMatchObject({ applicable: false, expected_tables: 0, observed_tables: 1, spurious_tables: 1, spans: { spurious: 1 }, cells: { spurious: 1 } });

    const partialOne = await configuredReport([nestedId], "partial-one");
    const partialOneScore = (await scorePhase1Report(partialOne.report, partialOne.context)).attempts[0];
    expect(partialOneScore.structured.data_leaves).toMatchObject({ correct: 1, missing: 8, precision: 1, recall: 1 / 9 });
    expect(partialOneScore.structured.data_leaves.f1).toBeLessThan(0.25);

    const eventsId = "pdf-tools.extraction.phase0.two-column-order";
    const reversed = await configuredReport([eventsId], "reverse");
    expect((await scorePhase1Report(reversed.report, reversed.context)).attempts[0].structured.data_leaves).toMatchObject({ wrong: 4, shifted_array: 4, correct: 0 });

    const noAnswerId = "pdf-tools.extraction.phase0.no-answer-contradiction";
    const completed = await configuredReport([noAnswerId], "completed-null");
    const completedScore = (await scorePhase1Report(completed.report, completed.context)).attempts[0];
    expect(completedScore.structured).toMatchObject({ schema_valid: true, schema_scope: "complete_target" });
    expect(completedScore.structured.contract_leaves).toMatchObject({ false_answers: 2, correctly_abstained: 0 });
    expect(completedScore.structured.data_leaves).toMatchObject({ truth: 1, correct: 1, missing: 0 });

    const wrongGap = await configuredReport([noAnswerId], "wrong-gap");
    const wrongGapScore = (await scorePhase1Report(wrongGap.report, wrongGap.context)).attempts[0];
    expect(wrongGapScore.structured.contract_leaves).toMatchObject({ correctly_abstained: 1, typed_gap_correct: 1, typed_gap_wrong_reason: 1 });
    const abstainAll = await configuredReport([noAnswerId], "abstain-all");
    expect((await scorePhase1Report(abstainAll.report, abstainAll.context)).attempts[0].structured.contract_leaves).toMatchObject({ false_abstentions: 1, correctly_abstained: 2, false_answers: 0 });

    const tableId = "pdf-tools.extraction.phase0.table-merged-blank";
    const duplicateTable = await configuredReport([tableId], "duplicate-table");
    expect((await scorePhase1Report(duplicateTable.report, duplicateTable.context)).attempts[0].table).toMatchObject({ missing_tables: 0, spurious_tables: 1, spans: { correct: 1, spurious: 1 }, cells: { correct: 10, spurious: 10 } });
    const alternateTable = await configuredReport([tableId], "alt-table");
    const alternateScore = (await scorePhase1Report(alternateTable.report, alternateTable.context)).attempts[0].table;
    expect(alternateScore.topology.accuracy).toBeLessThan(1);
    expect(alternateScore.cells).toMatchObject({ wrong: 0, spurious: 1 });
    const correctWrong = await configuredReport([tableId], "correct-wrong");
    const wrongCorrect = await configuredReport([tableId], "wrong-correct");
    expect((await scorePhase1Report(correctWrong.report, correctWrong.context)).attempts[0].table).toEqual((await scorePhase1Report(wrongCorrect.report, wrongCorrect.context)).attempts[0].table);
    const coveredCell = await configuredReport([tableId], "covered-cell");
    expect(coveredCell.report.denominator.outcomes.error).toBe(3);
    expect((await scorePhase1Report(coveredCell.report, coveredCell.context)).aggregate.denominator).toMatchObject({ configured: 3, quality_available: 0, configured_quality_coverage: 0 });

    const configuredError = await configuredReport([nestedId], "error");
    const errorAggregate = (await scorePhase1Report(configuredError.report, configuredError.context)).aggregate;
    expect(errorAggregate.denominator).toMatchObject({ configured: 3, quality_available: 0, configured_quality_coverage: 0 });
    expect(errorAggregate.structured).toMatchObject({ truth_data_leaves: 0, precision: null, recall: null });
  }, 30_000);

  it("rejects hostile byte, source-role, score, aggregate, stability, and index mutations", async () => {
    const verificationEvidence = {};
    const report = await runExtractionCandidates({ verificationEvidence });
    const context = await scoringContext(report, verificationEvidence);
    const score = await scorePhase1Report(report, context);
    const bundle = createPhase1ScoreBundle(score, context);
    const resignScore = mutate => {
      const retained = JSON.parse(bundle.scoreText);
      mutate(retained);
      const scoreText = `${JSON.stringify(retained, null, 2)}\n`;
      const index = structuredClone(bundle.index);
      index.score_report.bytes = Buffer.byteLength(scoreText);
      index.score_report.sha256 = sha256(Buffer.from(scoreText));
      return { scoreText, index };
    };
    for (const mutate of [
      value => { value.attempts[0].quality_available = true; },
      value => { value.aggregate.denominator.quality_available = 120; },
      value => { value.stability[0].stable = true; },
      value => { value.aggregate.resources.network_egress_bytes = 0; },
    ]) {
      const hostile = resignScore(mutate);
      await expect(verifyPhase1ScoreBundle({ ...hostile, report }, context)).rejects.toThrow();
    }
    for (const mutateContext of [
      value => { value.reportBytes = Buffer.concat([value.reportBytes, Buffer.from(" ")]); },
      value => { value.preflightEvidenceBytes = Buffer.concat([value.preflightEvidenceBytes, Buffer.from(" ")]); },
      value => { value.oracleBytes = Buffer.concat([value.oracleBytes, Buffer.from(" ")]); },
      value => { delete value.scorerSourceBytesByRole.oracle_schema; },
      value => { value.scorerSourceBytesByRole.score_schema.path = "wrong.json"; },
      value => { value.scorerSourceBytesByRole.scorer_module.bytes = Buffer.from("changed"); },
      value => { value.scorerSourceBytesByRole.protocol_module.bytes = Buffer.from("changed"); },
      value => { value.scorerSourceBytesByRole.report_schema.bytes = Buffer.from("{}"); },
    ]) {
      const { pdfjsLib, ...cloneableContext } = context;
      const hostileContext = { ...structuredClone(cloneableContext), pdfjsLib };
      mutateContext(hostileContext);
      await expect(verifyPhase1ScoreBundle({ scoreText: bundle.scoreText, index: bundle.index, report }, hostileContext)).rejects.toThrow();
    }
    const hostilePreflight = { ...context, preflightEvidenceBytes: Buffer.from(context.preflightEvidenceBytes) };
    const failureEvidenceMap = JSON.parse(Buffer.from(hostilePreflight.preflightEvidenceBytes).toString("utf8"));
    failureEvidenceMap.failure_evidence_by_attempt_key[Object.keys(failureEvidenceMap.failure_evidence_by_attempt_key)[0]].outcome_reason = "changed";
    hostilePreflight.preflightEvidenceBytes = Buffer.from(JSON.stringify(failureEvidenceMap));
    await expect(scorePhase1Report(report, hostilePreflight)).rejects.toThrow(/trusted failure evidence map bytes/);
    const hostileIndex = structuredClone(bundle.index);
    hostileIndex.bindings.score_schema_sha256 = "0".repeat(64);
    await expect(verifyPhase1ScoreBundle({ scoreText: bundle.scoreText, index: hostileIndex, report }, context)).rejects.toThrow(/index input bindings/);
    const pathIndex = structuredClone(bundle.index);
    pathIndex.score_report.path = "wrong.json";
    await expect(verifyPhase1ScoreBundle({ scoreText: bundle.scoreText, index: pathIndex, report }, context)).rejects.toThrow(/byte binding/);
    const lengthIndex = structuredClone(bundle.index);
    lengthIndex.score_report.bytes += 1;
    await expect(verifyPhase1ScoreBundle({ scoreText: bundle.scoreText, index: lengthIndex, report }, context)).rejects.toThrow(/byte binding/);
  }, 30_000);

  it("binds raw and canonical oracle inputs and separates contract from indexed scoring leaves", async () => {
    const verificationEvidence = {};
    const report = await runExtractionCandidates({ verificationEvidence });
    const context = await scoringContext(report, verificationEvidence);
    expect(flattenScoringLeaves({ tags: ["renewal", "priority"] }).map(([pointer]) => pointer)).toEqual(["/tags/0", "/tags/1"]);
    expect(scoreDistinctFragmentSequence("X", ["X", "X"])).toEqual({ found: 1, ordered_found: 1, ordered: false });
    const expectedRaw = [{ row: 1, column: 1, value: "" }, { row: 1, column: 2, value: null }, { row: 1, column: 3, value: 0 }, { row: 1, column: 4, value: "2" }];
    const hostileRaw = [{ row: 1, column: 1, value: null }, { row: 1, column: 2, value: 0 }, { row: 1, column: 3, value: "" }, { row: 1, column: 4, value: 2 }];
    expect(scoreRawTableValueClass(expectedRaw, hostileRaw, () => true)).toEqual({ expected: 4, correct: 0, wrong: 4, missing: 0 });
    expect(scoreRawTableValueClass(expectedRaw, hostileRaw.slice(1), value => value === "")).toEqual({ expected: 1, correct: 0, wrong: 0, missing: 1 });
    expect(validatePhase1ScoringOracle(context.oracle, context.oracleSchema, context.verification.manifest, {
      manifestBytesSha256: context.verification.manifestBytesSha256,
      manifestSchema: context.verification.manifestSchema,
      manifestSchemaBytesSha256: context.verification.manifestSchemaBytesSha256,
    })).toBe(true);
    const validateOracle = oracle => validatePhase1ScoringOracle(oracle, context.oracleSchema, context.verification.manifest, {
      manifestBytesSha256: context.verification.manifestBytesSha256,
      manifestSchema: context.verification.manifestSchema,
      manifestSchemaBytesSha256: context.verification.manifestSchemaBytesSha256,
    });
    const crossContract = structuredClone(context.oracle);
    crossContract.cases[1].truth_leaves.find(leaf => leaf.field_path === "/tags/0").contract_path = "/customer_id";
    expect(() => validateOracle(crossContract)).toThrow(/truth leaf/);
    const crossFact = structuredClone(context.oracle);
    crossFact.cases[0].truth_leaves.find(leaf => leaf.field_path === "/total/amount").fact_support = { mode: "any", fact_ids: ["fact.flat.invoice-id"] };
    expect(() => validateOracle(crossFact)).toThrow(/truth leaf/);
    for (const mutate of [
      value => { value.manifest_bytes_sha256 = "0".repeat(64); },
      value => { value.cases[1].truth_leaves[7].field_path = "/tags"; },
      value => { value.cases[7].truth_leaves[0].fact_support.mode = "any"; },
      value => { value.cases[7].contract_leaf_policies[2].allowed_gap_reasons = ["contradictory_source"]; },
    ]) {
      const mutant = structuredClone(context.oracle);
      mutate(mutant);
      await expect(scorePhase1Report(report, { ...context, oracle: mutant })).rejects.toThrow();
    }
    const score = await scorePhase1Report(report, context);
    expect(score.scorer_sources.map(item => item.role)).toEqual([...score.scorer_sources.map(item => item.role)].sort());
    expect(score.unavailable_claims.join(" ")).toMatch(/CPU|memory|Network|artifact/);
    expect(canonicalJson(score).includes("canonical_evidence_claim_ready\":false")).toBe(true);
  }, 30_000);
});
