import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runExtractionCandidates } from "../../scripts/eval-run-extraction-candidates.mjs";
import { scoreExtractionCandidateReport } from "../../scripts/eval-score-extraction-candidates.mjs";
import {
  computeGenerationSha256,
  inspectGenerationDirectory,
  readVerifiedGenerationArtifact,
  receiveVerifiedGeneration,
  recoverPublishedGeneration,
  recoverVerifiedStagingGeneration,
} from "./extraction-phase1-publisher.js";
import {
  PHASE1_COMPANION_SOURCE_PATHS,
  createCrossDeviceReceipt,
} from "./extraction-phase1-companion.js";
import { PHASE1_SCORER_LOCAL_SOURCE_PATHS } from "./extraction-phase1-scorer.js";
import { verifyReceivedGenerationAncestry } from "./extraction-phase1-generation-verifier-common.js";
import { createExecutionGenerationSemanticVerifier } from "./extraction-phase1-execution-generation-verifier.js";
import { createScoreGenerationSemanticVerifier } from "./extraction-phase1-score-generation-verifier.js";
import { canonicalJson, sha256 } from "./extraction-phase1-protocol.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTRACTION_ROOT = path.join(REPO_ROOT, "test", "fixtures", "eval", "extraction");
const PHASE1_ROOT = path.join(EXTRACTION_ROOT, "phase1");
const EXECUTION_FACTORY_MODULE = new URL("./extraction-phase1-execution-generation-verifier.js", import.meta.url).href;
const SCORE_FACTORY_MODULE = new URL("./extraction-phase1-score-generation-verifier.js", import.meta.url).href;
const PUBLISHER_MODULE = new URL("./extraction-phase1-publisher.js", import.meta.url).href;
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function temporaryRoot() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "phase1-fresh-verifier-")));
  temporaryRoots.push(root);
  return root;
}

async function exactStaticModuleGraph(sourcePaths, rootRole) {
  const modulePaths = new Set(Object.values(sourcePaths).filter(value => /\.(?:m?js)$/.test(value)));
  const adjacency = new Map();
  const importPattern = /(?:import|export)\s+(?:[^;]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const relativePath of modulePaths) {
    const imports = new Set();
    const source = await fs.readFile(path.join(REPO_ROOT, relativePath), "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2];
      if (!specifier.startsWith(".")) continue;
      const resolved = path.relative(REPO_ROOT, path.resolve(path.dirname(path.join(REPO_ROOT, relativePath)), specifier));
      expect(modulePaths.has(resolved), `${relativePath} imports unbound local module ${resolved}`).toBe(true);
      imports.add(resolved);
    }
    adjacency.set(relativePath, imports);
  }
  const rootPath = sourcePaths[rootRole];
  const reached = new Set();
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop();
    if (reached.has(current)) continue;
    reached.add(current);
    for (const dependency of adjacency.get(current) ?? []) pending.push(dependency);
  }
  expect([...reached].sort()).toEqual([...modulePaths].sort());
  return reached;
}

function withIndexContentDigest(index) {
  const value = structuredClone(index);
  const { index_content_sha256: ignored, ...content } = value;
  value.index_content_sha256 = sha256(Buffer.from(`pdf-tools.extraction-phase1-execution-index.v1\0${canonicalJson(content)}`));
  return value;
}

const CHILD_SOURCE = `
const config = JSON.parse(process.argv[1]);
const factories = await import(config.factory_module);
const publisher = await import(config.publisher_module);
const createFactory = config.factory_kind === "execution"
  ? factories.createExecutionGenerationSemanticVerifier
  : factories.createScoreGenerationSemanticVerifier;
const semanticVerifier = await createFactory({
  repositoryRoot: config.repository_root,
  manifestPath: config.manifest_path,
  manifestSchemaPath: config.manifest_schema_path,
  trustedPrivacyClass: "public_synthetic",
  trust: config.trust,
});
let result;
if (config.action === "receive") {
  result = await publisher.receiveVerifiedGeneration({
    sourceGenerationPath: config.source_generation_path,
    destinationParentDirectory: config.destination_parent,
    sourceHost: "silverbook",
    destinationHost: "silvercloud",
    transportedAt: "2026-07-22T00:00:00Z",
    transport: "tailscale_tailnet",
    trustedSourceGenerationSha256: config.trust.expected_source_generation_sha256,
    semanticVerifier,
  });
} else {
  result = await publisher.recoverPublishedGeneration({
    generationPath: config.source_generation_path,
    expectedGenerationSha256: config.expected_generation_sha256 ?? null,
    semanticVerifier,
  });
}
process.stdout.write(JSON.stringify({ state: result.state, generation_path: result.generationPath, generation_sha256: result.generation_sha256 }));
`;

async function runFreshProcess(config) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    CHILD_SOURCE,
    JSON.stringify({
      factory_module: config.factory_kind === "execution" ? EXECUTION_FACTORY_MODULE : SCORE_FACTORY_MODULE,
      publisher_module: PUBLISHER_MODULE,
      repository_root: REPO_ROOT,
      manifest_path: path.join(EXTRACTION_ROOT, "manifest.v1.json"),
      manifest_schema_path: path.join(EXTRACTION_ROOT, "manifest.schema.json"),
      ...config,
    }),
  ], { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 });
  expect(stderr).toBe("");
  return JSON.parse(stdout);
}

async function createFaultedReceivedGeneration({
  sourceGenerationPath,
  destinationParent,
  trustedSourceGenerationSha256,
  semanticVerifier,
  faultPhase,
}) {
  await fs.mkdir(destinationParent, { mode: 0o700 });
  let fault;
  try {
    await receiveVerifiedGeneration({
      sourceGenerationPath,
      destinationParentDirectory: destinationParent,
      sourceHost: "silverbook",
      destinationHost: "silvercloud",
      transportedAt: "2026-07-22T00:00:00Z",
      transport: "tailscale_tailnet",
      trustedSourceGenerationSha256,
      semanticVerifier,
      publicationFaultInjector: phase => {
        if (phase === faultPhase) throw new Error(`received recovery fixture fault: ${phase}`);
      },
    });
  } catch (error) {
    fault = error;
  }
  expect(fault).toMatchObject({ message: `received recovery fixture fault: ${faultPhase}` });
  const entries = await fs.readdir(destinationParent);
  const activeName = entries.find(name => name.startsWith(".staging-received_") || name.startsWith("received_"));
  expect(activeName).toBeTruthy();
  const staging = activeName.startsWith(".staging-");
  const activePath = path.join(destinationParent, activeName);
  const generationPath = staging
    ? path.join(destinationParent, activeName.slice(".staging-".length))
    : activePath;
  const transactionId = activeName.slice(-36);
  const inspection = await inspectGenerationDirectory(activePath, {
    allowStaging: staging,
    activeClaimTransactionId: transactionId,
  });
  expect(inspection.state).toBe("complete");
  return {
    activePath,
    generationPath,
    inspection,
    recover: options => staging
      ? recoverVerifiedStagingGeneration({ stagingPath: activePath, generationPath, semanticVerifier, ...options })
      : recoverPublishedGeneration({ generationPath, semanticVerifier, ...options }),
    staging,
  };
}

async function exerciseReceivedRecoveryDigestBoundary({
  sourceGenerationPath,
  sourceGenerationSha256,
  semanticVerifier,
  root,
  label,
}) {
  const [staging, published] = await Promise.all([
    createFaultedReceivedGeneration({
      sourceGenerationPath,
      destinationParent: path.join(root, `${label}-staging-recovery`),
      trustedSourceGenerationSha256: sourceGenerationSha256,
      semanticVerifier,
      faultPhase: "before_final_rename",
    }),
    createFaultedReceivedGeneration({
      sourceGenerationPath,
      destinationParent: path.join(root, `${label}-published-recovery`),
      trustedSourceGenerationSha256: sourceGenerationSha256,
      semanticVerifier,
      faultPhase: "after_final_rename",
    }),
  ]);
  expect(staging.staging).toBe(true);
  expect(published.staging).toBe(false);
  expect(staging.inspection.index.source_generation_sha256).toBe(sourceGenerationSha256);
  expect(published.inspection.index.source_generation_sha256).toBe(sourceGenerationSha256);
  expect(staging.inspection.generation_sha256).not.toBe(published.inspection.generation_sha256);

  for (const [subject, other] of [[staging, published], [published, staging]]) {
    await expect(subject.recover({})).rejects.toThrow(/exact received-generation digest/);
    await expect(subject.recover({ expectedGenerationSha256: "invalid" })).rejects.toThrow(/digest is invalid/);
    await expect(subject.recover({ expectedGenerationSha256: other.inspection.generation_sha256 })).rejects.toThrow(/differs from its exact expected/);
    const recovered = await subject.recover({ expectedGenerationSha256: subject.inspection.generation_sha256 });
    expect(recovered).toMatchObject({
      state: "recovered_complete",
      generation_sha256: subject.inspection.generation_sha256,
    });
  }
}

describe("fresh-process extraction generation semantic verifier factories", () => {
  it("closes role-exact execution and score static module graphs without cross-importing verifier surfaces", async () => {
    const executionGraph = await exactStaticModuleGraph(PHASE1_COMPANION_SOURCE_PATHS, "runner_script");
    expect(executionGraph).not.toContain("test/eval/extraction-phase1-scorer.js");
    expect(executionGraph).not.toContain("scripts/eval-generate-extraction-layout-oracle.mjs");
    const scoreGraph = await exactStaticModuleGraph(PHASE1_SCORER_LOCAL_SOURCE_PATHS, "orchestration_script");
    expect(scoreGraph).not.toContain("test/eval/extraction-phase1-execution-generation-verifier.js");
    expect(scoreGraph).not.toContain("scripts/eval-run-extraction-candidates.mjs");
  });

  it("receives execution and score generations and recovers a terminal publication fault without a source-process closure", async () => {
    const root = await temporaryRoot();
    const [registry, plan, manifest] = await Promise.all([
      fs.readFile(path.join(PHASE1_ROOT, "candidate-registry.v1.json"), "utf8").then(JSON.parse),
      fs.readFile(path.join(PHASE1_ROOT, "run-plan.v1.json"), "utf8").then(JSON.parse),
      fs.readFile(path.join(EXTRACTION_ROOT, "manifest.v1.json"), "utf8").then(JSON.parse),
    ]);
    registry.candidates[0].notes = "Fresh-process custom registry binding.";
    plan.case_ids = [manifest.fixtures[0].id];
    const registryPath = path.join(root, "custom-registry.json");
    const planPath = path.join(root, "custom-plan.json");
    await Promise.all([
      fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`),
      fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`),
    ]);

    const executionEvidence = {};
    await runExtractionCandidates({
      registryPath,
      planPath,
      generationRoot: path.join(root, "executions"),
      verificationEvidence: executionEvidence,
    });
    const execution = executionEvidence.generation;
    const receivedExecutionRoot = path.join(root, "received-executions");
    await fs.mkdir(receivedExecutionRoot, { mode: 0o700 });
    const receivedExecution = await runFreshProcess({
      action: "receive",
      factory_kind: "execution",
      source_generation_path: execution.generationPath,
      destination_parent: receivedExecutionRoot,
      trust: { kind: "out_of_band_source_generation_sha256", expected_source_generation_sha256: execution.generation_sha256 },
    });
    expect(receivedExecution.state).toBe("complete");
    const executionOobVerifier = await createExecutionGenerationSemanticVerifier({
      repositoryRoot: REPO_ROOT,
      manifestPath: path.join(EXTRACTION_ROOT, "manifest.v1.json"),
      manifestSchemaPath: path.join(EXTRACTION_ROOT, "manifest.schema.json"),
      trustedPrivacyClass: "public_synthetic",
      trust: { kind: "out_of_band_source_generation_sha256", expected_source_generation_sha256: execution.generation_sha256 },
    });
    await exerciseReceivedRecoveryDigestBoundary({
      sourceGenerationPath: execution.generationPath,
      sourceGenerationSha256: execution.generation_sha256,
      semanticVerifier: executionOobVerifier,
      root,
      label: "execution",
    });
    const receivedExecutionInspection = await inspectGenerationDirectory(receivedExecution.generation_path);
    const [sourceIndexArtifact, receiptArtifact, companionArtifact] = await Promise.all([
      readVerifiedGenerationArtifact(receivedExecution.generation_path, receivedExecutionInspection, "source_generation_index"),
      readVerifiedGenerationArtifact(receivedExecution.generation_path, receivedExecutionInspection, "transfer_receipt"),
      readVerifiedGenerationArtifact(receivedExecution.generation_path, receivedExecutionInspection, "execution_companion"),
    ]);
    const sourceIndex = JSON.parse(sourceIndexArtifact.bytes);
    const companion = JSON.parse(companionArtifact.bytes);
    const expectedIdentity = {
      kind: "execution_direct_source_set_sha256",
      sha256: companion.direct_source_set_sha256,
      source_artifact_role: "execution_companion",
    };
    const ancestryInputs = {
      inspection: receivedExecutionInspection,
      sourceIndexBytes: sourceIndexArtifact.bytes,
      receiptBytes: receiptArtifact.bytes,
      expectedSourceGenerationSha256: execution.generation_sha256,
      expectedSourceKind: "execution",
      expectedSourceCodeIdentity: expectedIdentity,
    };
    let unsignedVerifierCalls = 0;
    const unsigned = verifyReceivedGenerationAncestry({
      ...ancestryInputs,
      trustedSignatureVerifier: () => { unsignedVerifierCalls += 1; return true; },
    });
    expect(unsigned.receiptVerification).toEqual({ internally_consistent: true, authentic: false });
    expect(unsignedVerifierCalls).toBe(0);

    const wrongReceivedKind = { state: "complete", index: structuredClone(receivedExecutionInspection.index) };
    wrongReceivedKind.index.kind = "received_score";
    expect(() => verifyReceivedGenerationAncestry({ ...ancestryInputs, inspection: wrongReceivedKind })).toThrow(/kind/);
    const wrongSourceKindIndex = withIndexContentDigest({
      ...structuredClone(sourceIndex),
      kind: "score",
      source_generation_sha256: "1".repeat(64),
    });
    const wrongSourceKindBytes = Buffer.from(`${JSON.stringify(wrongSourceKindIndex, null, 2)}\n`);
    const wrongSourceKindSha256 = computeGenerationSha256(wrongSourceKindIndex, wrongSourceKindBytes);
    const wrongSourceKindReceipt = createCrossDeviceReceipt({
      runId: wrongSourceKindIndex.run_id,
      indexBytes: wrongSourceKindBytes,
      sourceGenerationSha256: wrongSourceKindSha256,
      sourceHost: "silverbook",
      destinationHost: "silvercloud",
      sourceCodeIdentity: expectedIdentity,
      transportedAt: "2026-07-22T00:00:00Z",
      transport: "tailscale_tailnet",
    });
    const wrongSourceKindInspection = { state: "complete", index: structuredClone(receivedExecutionInspection.index) };
    wrongSourceKindInspection.index.source_generation_sha256 = wrongSourceKindSha256;
    expect(() => verifyReceivedGenerationAncestry({
      ...ancestryInputs,
      inspection: wrongSourceKindInspection,
      sourceIndexBytes: wrongSourceKindBytes,
      receiptBytes: Buffer.from(`${JSON.stringify(wrongSourceKindReceipt, null, 2)}\n`),
      expectedSourceGenerationSha256: wrongSourceKindSha256,
    })).toThrow(/source anchor/);
    expect(() => verifyReceivedGenerationAncestry({
      ...ancestryInputs,
      expectedSourceCodeIdentity: { ...expectedIdentity, sha256: "0".repeat(64) },
    })).toThrow(/receipt|inconsistent/);

    const copiedRole = sourceIndex.artifacts[0].role;
    for (const mutate of [
      index => { index.artifacts.find(item => item.role === copiedRole).sha256 = "0".repeat(64); },
      index => { index.artifacts = index.artifacts.filter(item => item.role !== copiedRole); },
      index => { index.artifacts.push({ role: "unexpected", path: "unexpected.json", bytes: 1, sha256: "0".repeat(64) }); },
    ]) {
      const hostile = { state: "complete", index: structuredClone(receivedExecutionInspection.index) };
      mutate(hostile.index);
      expect(() => verifyReceivedGenerationAncestry({ ...ancestryInputs, inspection: hostile })).toThrow(/copied source records|source artifact record/);
    }

    const collisionIndex = structuredClone(sourceIndex);
    collisionIndex.artifacts.push({
      role: "received_privacy_attestation",
      path: "source-collision.json",
      bytes: 3,
      sha256: sha256(Buffer.from("{}\n")),
    });
    collisionIndex.artifacts.sort((left, right) => left.role < right.role ? -1 : left.role > right.role ? 1 : 0);
    const signedCollisionIndex = withIndexContentDigest(collisionIndex);
    const collisionIndexBytes = Buffer.from(`${JSON.stringify(signedCollisionIndex, null, 2)}\n`);
    const collisionGenerationSha256 = computeGenerationSha256(signedCollisionIndex, collisionIndexBytes);
    const collisionReceipt = createCrossDeviceReceipt({
      runId: signedCollisionIndex.run_id,
      indexBytes: collisionIndexBytes,
      sourceGenerationSha256: collisionGenerationSha256,
      sourceHost: "silverbook",
      destinationHost: "silvercloud",
      sourceCodeIdentity: expectedIdentity,
      transportedAt: "2026-07-22T00:00:00Z",
      transport: "tailscale_tailnet",
    });
    const collisionInspection = { state: "complete", index: structuredClone(receivedExecutionInspection.index) };
    collisionInspection.index.source_generation_sha256 = collisionGenerationSha256;
    expect(() => verifyReceivedGenerationAncestry({
      ...ancestryInputs,
      inspection: collisionInspection,
      sourceIndexBytes: collisionIndexBytes,
      receiptBytes: Buffer.from(`${JSON.stringify(collisionReceipt, null, 2)}\n`),
      expectedSourceGenerationSha256: collisionGenerationSha256,
    })).toThrow(/transfer-local/);

    const signedReceipt = createCrossDeviceReceipt({
      runId: sourceIndex.run_id,
      indexBytes: sourceIndexArtifact.bytes,
      sourceGenerationSha256: execution.generation_sha256,
      sourceHost: "silverbook",
      destinationHost: "silvercloud",
      sourceCodeIdentity: expectedIdentity,
      transportedAt: "2026-07-22T00:00:00Z",
      transport: "tailscale_tailnet",
      keyId: "test:key",
      signature: "A".repeat(16),
    });
    const signedReceiptBytes = Buffer.from(`${JSON.stringify(signedReceipt, null, 2)}\n`);
    const signedInspection = { state: "complete", index: structuredClone(receivedExecutionInspection.index) };
    const signedReceiptRecord = signedInspection.index.artifacts.find(item => item.role === "transfer_receipt");
    Object.assign(signedReceiptRecord, { bytes: signedReceiptBytes.length, sha256: sha256(signedReceiptBytes) });
    expect(() => verifyReceivedGenerationAncestry({
      ...ancestryInputs,
      inspection: signedInspection,
      receiptBytes: signedReceiptBytes,
    })).toThrow(/authenticity/);
    let authenticatedInput = null;
    const signed = verifyReceivedGenerationAncestry({
      ...ancestryInputs,
      inspection: signedInspection,
      receiptBytes: signedReceiptBytes,
      trustedSignatureVerifier: input => { authenticatedInput = input; return true; },
    });
    expect(signed.receiptVerification).toEqual({ internally_consistent: true, authentic: true });
    expect(authenticatedInput).toMatchObject({ keyId: "test:key", signature: "A".repeat(16), payloadSha256: signedReceipt.signed_payload_sha256 });

    const scored = await scoreExtractionCandidateReport({
      executionGenerationPath: execution.generationPath,
      generationRoot: path.join(root, "scores"),
    });
    const receivedScoreRoot = path.join(root, "received-scores");
    await fs.mkdir(receivedScoreRoot, { mode: 0o700 });
    const receivedScore = await runFreshProcess({
      action: "receive",
      factory_kind: "score",
      source_generation_path: scored.generation.generationPath,
      destination_parent: receivedScoreRoot,
      trust: { kind: "out_of_band_source_generation_sha256", expected_source_generation_sha256: scored.generation.generation_sha256 },
    });
    expect(receivedScore.state).toBe("complete");
    const scoreOobVerifier = await createScoreGenerationSemanticVerifier({
      repositoryRoot: REPO_ROOT,
      manifestPath: path.join(EXTRACTION_ROOT, "manifest.v1.json"),
      manifestSchemaPath: path.join(EXTRACTION_ROOT, "manifest.schema.json"),
      trustedPrivacyClass: "public_synthetic",
      trust: { kind: "out_of_band_source_generation_sha256", expected_source_generation_sha256: scored.generation.generation_sha256 },
    });
    await exerciseReceivedRecoveryDigestBoundary({
      sourceGenerationPath: scored.generation.generationPath,
      sourceGenerationSha256: scored.generation.generation_sha256,
      semanticVerifier: scoreOobVerifier,
      root,
      label: "score",
    });

    let publicationError;
    try {
      await runExtractionCandidates({
        registryPath,
        planPath,
        generationRoot: path.join(root, "faulted-executions"),
        testOnlyPublicationFaultInjector: phase => {
          if (phase === "after_terminal_semantic_verification") throw new Error("terminal crash");
        },
      });
    } catch (error) {
      publicationError = error;
    }
    expect(publicationError).toMatchObject({ publication_state: "durability_uncertain", generation_path: expect.any(String) });
    const faultedInspection = await inspectGenerationDirectory(publicationError.generation_path);
    expect(faultedInspection.state).toBe("complete");
    const recovered = await runFreshProcess({
      action: "recover",
      factory_kind: "execution",
      source_generation_path: publicationError.generation_path,
      destination_parent: null,
      trust: {
        kind: "local_claim_owned",
        expected_transaction_id: faultedInspection.index.transaction_id,
        expected_generation_sha256: faultedInspection.generation_sha256,
      },
    });
    expect(recovered).toMatchObject({ state: "recovered_complete", generation_sha256: faultedInspection.generation_sha256 });
  }, 120_000);
});
