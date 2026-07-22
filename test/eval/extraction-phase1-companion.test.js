import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runExtractionCandidates } from "../../scripts/eval-run-extraction-candidates.mjs";
import {
  PHASE1_COMPANION_SOURCE_PATHS,
  buildPrivacyEvidence,
  buildRunnerEnvironmentAttestation,
  createCrossDeviceReceipt,
  createExecutionCompanion,
  verifyCrossDeviceReceipt,
  verifyExecutionCompanion,
} from "./extraction-phase1-companion.js";
import { assertSchema } from "./extraction-phase1-protocol.js";
import { inspectGenerationDirectory, publishImmutableGeneration } from "./extraction-phase1-publisher.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "phase1-companion-"));
  temporaryRoots.push(root);
  return root;
}

async function context() {
  const verificationEvidence = {};
  const report = await runExtractionCandidates({ verificationEvidence });
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  const sourceBytesByRole = Object.fromEntries(await Promise.all(Object.entries(PHASE1_COMPANION_SOURCE_PATHS).map(async ([role, relativePath]) => [role, { path: relativePath, bytes: await fs.readFile(path.join(REPO_ROOT, relativePath)) }])));
  const root = await tempRoot();
  const privacyEvidence = await buildPrivacyEvidence({ trustedPrivacyClass: "public_synthetic", runRoot: root, trustedProhibitedRoots: [], publicationAuthorized: false });
  const runnerEnvironmentAttestation = await buildRunnerEnvironmentAttestation({ sourceBytesByRole });
  return {
    report,
    reportBytes,
    failureEvidenceByAttemptKey: verificationEvidence.failureEvidenceByAttemptKey,
    resourceFactsByAttemptKey: verificationEvidence.resourceFactsByAttemptKey,
    artifactAttestationByCandidateId: verificationEvidence.artifactAttestationByCandidateId,
    artifactConfigBindingByCandidateId: verificationEvidence.artifactConfigBindingByCandidateId,
    commandRuntimeByCandidateId: verificationEvidence.commandRuntimeByCandidateId,
    privacyEvidence,
    sourceBytesByRole,
    runnerEnvironmentAttestation,
  };
}

describe("Phase 1 execution companion and transfer receipt", () => {
  it("binds exact report bytes, runner maps, before/after artifacts, privacy, host, runtime, limitations, and sources", async () => {
    const trusted = await context();
    const companion = createExecutionCompanion(trusted);
    const schema = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "test/fixtures/eval/extraction/phase1/execution-companion.schema.json")));
    expect(assertSchema(companion, schema, "execution companion")).toBe(true);
    expect(verifyExecutionCompanion(companion, trusted)).toBe(true);
    expect(companion.report.raw_bytes).toBe(trusted.reportBytes.length);
    expect(Object.values(companion.resource_facts_by_attempt_key).every(item => item.wall_elapsed_ms === null && item.request_payload_bytes === null)).toBe(true);
    expect(Object.values(companion.resource_facts_by_attempt_key).every(item => item.environment_bytes === 0
      && item.environment_bytes_unavailable_reason === null && item.model_bytes === 0
      && item.model_bytes_unavailable_reason === null)).toBe(true);
    expect(Object.values(companion.artifact_attestation_by_candidate_id).every(item => item.before.state === "not_applicable" && item.drift.status === "unchanged")).toBe(true);
  }, 30_000);

  it("persists the default report only as an explicit out-of-repo immutable generation", async () => {
    const generationRoot = await tempRoot();
    const verificationEvidence = {};
    const report = await runExtractionCandidates({ generationRoot, verificationEvidence });
    const inspection = await inspectGenerationDirectory(verificationEvidence.generation.generationPath);
    expect(inspection.state).toBe("complete");
    expect(inspection.index.run_id).toBe(report.run_id);
    expect(inspection.index.artifacts.map(item => item.role)).toContain("privacy_attestation");
    expect(inspection.index.artifacts.filter(item => item.role.startsWith("artifact_config_")).length).toBe(5);
    await expect(runExtractionCandidates({ generationRoot: path.join(REPO_ROOT, "forbidden-generation") })).rejects.toThrow(/outside the repository/);
    await expect(runExtractionCandidates({ outputPath: path.join(generationRoot, "legacy.json") })).rejects.toThrow(/Direct report/);
  }, 30_000);

  it("rejects raw report, companion/report/run, resource, artifact, privacy, source path, and source-byte mutations", async () => {
    const trusted = await context();
    await expect(Promise.resolve().then(() => createExecutionCompanion({ ...trusted, reportBytes: Buffer.concat([trusted.reportBytes, Buffer.from(" ")]) }))).rejects.toThrow(/report bytes/);
    const companion = createExecutionCompanion(trusted);
    const mutations = [
      value => { value.report.run_id = "0".repeat(64); },
      value => { Object.values(value.resource_facts_by_attempt_key)[0].source_bytes += 1; },
      value => { Object.values(value.resource_facts_by_attempt_key)[0].environment_bytes_unavailable_reason = "environment_roles_pending"; },
      value => { Object.values(value.command_runtime_by_candidate_id)[0].status = "changed"; },
      value => { Object.values(value.command_runtime_by_candidate_id)[0].status = "unchanged_incomplete_nonclaiming"; },
      value => { Object.values(value.resource_facts_by_attempt_key)[0].unavailable.cpu_time_ms = 1; },
      value => { Object.values(value.artifact_attestation_by_candidate_id)[0].drift.status = "unchanged"; Object.values(value.artifact_attestation_by_candidate_id)[0].after.logical_bytes = 1; },
      value => { value.privacy.publication_authorized = true; },
      value => { value.direct_sources[0].path = "other.json"; },
      value => { value.direct_sources[0].sha256 = "f".repeat(64); },
      value => { value.unexpected = true; },
    ];
    for (const mutate of mutations) {
      const hostile = structuredClone(companion);
      mutate(hostile);
      expect(() => verifyExecutionCompanion(hostile, trusted)).toThrow();
    }
    const verifierTamper = {
      ...trusted,
      sourceBytesByRole: {
        ...trusted.sourceBytesByRole,
        execution_generation_verifier_module: {
          ...trusted.sourceBytesByRole.execution_generation_verifier_module,
          bytes: Buffer.from("changed execution verifier"),
        },
      },
    };
    expect(() => verifyExecutionCompanion(companion, verifierTamper)).toThrow(/differs|source/);
    const fakeResources = structuredClone(trusted.resourceFactsByAttemptKey);
    Object.values(fakeResources)[0].cost_usd = 0;
    expect(() => createExecutionCompanion({ ...trusted, resourceFactsByAttemptKey: fakeResources })).toThrow(/resource facts/);
  }, 30_000);

  it("enforces exact private roots, files, modes, nonpublication, and prohibited locations", async () => {
    const root = await tempRoot();
    await fs.chmod(root, 0o700);
    const retained = path.join(root, "retained.json");
    await fs.writeFile(retained, "{}\n", { mode: 0o600 });
    const proof = await buildPrivacyEvidence({
      trustedPrivacyClass: "private_local_minimized",
      runRoot: root,
      trustedProhibitedRoots: [REPO_ROOT],
      expectedRetainedFilePaths: [retained],
      publicationAuthorized: false,
    });
    expect(proof).toMatchObject({ private_run: true, publication_authorized: false, content_minimization_policy: "required", content_minimization_measured: null, raw_path_values_retained: null, path_identity_hashes_retained: true });
    await fs.writeFile(path.join(root, "omitted.json"), "{}\n", { mode: 0o600 });
    await expect(buildPrivacyEvidence({ trustedPrivacyClass: "private_local", runRoot: root, trustedProhibitedRoots: [REPO_ROOT], expectedRetainedFilePaths: [retained] })).rejects.toThrow(/enumeration/);
    await expect(buildPrivacyEvidence({ trustedPrivacyClass: "private_local", runRoot: REPO_ROOT, trustedProhibitedRoots: [REPO_ROOT], expectedRetainedFilePaths: [] })).rejects.toThrow(/mode 0700|overlaps/);
    await expect(buildPrivacyEvidence({ trustedPrivacyClass: "private_local", runRoot: root, trustedProhibitedRoots: [REPO_ROOT], expectedRetainedFilePaths: [retained], publicationAuthorized: true })).rejects.toThrow(/cannot authorize/);
  });

  it("proves transfer consistency without inventing origin authenticity", async () => {
    const sourceRoot = await tempRoot();
    const source = await publishImmutableGeneration({
      parentDirectory: sourceRoot,
      runId: "a".repeat(64),
      kind: "execution",
      artifacts: { execution_report: { filename: "execution-report.v1.json", bytes: Buffer.from("{}\n") } },
    });
    const indexBytes = source.indexBytes;
    const sourceCodeIdentity = {
      kind: "execution_direct_source_set_sha256",
      sha256: "b".repeat(64),
      source_artifact_role: "execution_companion",
    };
    const receipt = createCrossDeviceReceipt({
      runId: "a".repeat(64), indexBytes, sourceGenerationSha256: source.generation_sha256,
      sourceHost: "silverbook", destinationHost: "silvercloud", sourceCodeIdentity,
      transportedAt: "2026-07-22T00:00:00Z", transport: "tailscale_tailnet",
    });
    expect(verifyCrossDeviceReceipt(receipt, {
      runId: "a".repeat(64), indexBytes, sourceGenerationSha256: source.generation_sha256,
      expectedSourceCodeIdentity: sourceCodeIdentity,
    })).toEqual({ internally_consistent: true, authentic: false });
    expect(receipt.authenticity).toBe("unavailable");
    const schema = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "test/fixtures/eval/extraction/phase1/cross-device-receipt.schema.json")));
    expect(assertSchema(receipt, schema, "cross-device receipt")).toBe(true);
    const hostile = structuredClone(receipt);
    hostile.index_raw_bytes += 1;
    expect(() => verifyCrossDeviceReceipt(hostile, {
      runId: "a".repeat(64), indexBytes, sourceGenerationSha256: source.generation_sha256,
      expectedSourceCodeIdentity: sourceCodeIdentity,
    })).toThrow(/inconsistent/);

    expect(() => verifyCrossDeviceReceipt(receipt, {
      runId: "a".repeat(64), indexBytes, sourceGenerationSha256: source.generation_sha256,
      expectedSourceCodeIdentity: { ...sourceCodeIdentity, sha256: "c".repeat(64) },
    })).toThrow(/inconsistent/);

    const signed = createCrossDeviceReceipt({
      runId: "a".repeat(64), indexBytes, sourceGenerationSha256: source.generation_sha256,
      sourceHost: "silverbook", destinationHost: "silvercloud", sourceCodeIdentity,
      transportedAt: "2026-07-22T00:00:00Z", transport: "tailscale_tailnet",
      keyId: "test-key", signature: "a".repeat(16),
    });
    const signedContext = {
      runId: "a".repeat(64), indexBytes, sourceGenerationSha256: source.generation_sha256,
      expectedSourceCodeIdentity: sourceCodeIdentity,
    };
    expect(verifyCrossDeviceReceipt(signed, { ...signedContext, trustedSignatureVerifier: () => true })).toEqual({ internally_consistent: true, authentic: true });
    for (const verifier of [() => false, () => Promise.resolve(false), () => Promise.resolve(true), () => ({}), () => 1]) {
      expect(() => verifyCrossDeviceReceipt(signed, { ...signedContext, trustedSignatureVerifier: verifier })).toThrow(/unverified/);
    }
  });
});
