import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runExtractionCandidates } from "../../scripts/eval-run-extraction-candidates.mjs";
import { scoreExtractionCandidateReport } from "../../scripts/eval-score-extraction-candidates.mjs";
import { inspectGenerationDirectory } from "./extraction-phase1-publisher.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTRACTION_ROOT = path.join(REPO_ROOT, "test", "fixtures", "eval", "extraction");
const PHASE1_ROOT = path.join(EXTRACTION_ROOT, "phase1");
const FACTORY_MODULE = new URL("./extraction-phase1-generation-verifiers.js", import.meta.url).href;
const PUBLISHER_MODULE = new URL("./extraction-phase1-publisher.js", import.meta.url).href;
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "phase1-fresh-verifier-"));
  temporaryRoots.push(root);
  return root;
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
      factory_module: FACTORY_MODULE,
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

describe("fresh-process extraction generation semantic verifier factories", () => {
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
