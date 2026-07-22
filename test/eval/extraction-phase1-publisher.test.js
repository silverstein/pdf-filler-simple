import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectGenerationDirectory,
  publishImmutableGeneration,
  receiveVerifiedGeneration,
  recoverPublishedGeneration,
  recoverVerifiedStagingGeneration,
} from "./extraction-phase1-publisher.js";
import {
  buildGenerationPrivacyAttestation,
  generationProhibitedRootSetSha256,
  verifyFinalGenerationPrivacy,
} from "./extraction-phase1-companion.js";

const temporaryRoots = [];
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUN_ID = "b".repeat(64);
const TX = "11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function root() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "phase1-publisher-"));
  temporaryRoots.push(value);
  return value;
}

function artifacts() {
  const companion = {
    companion_id: "pdf-tools.extraction-phase1-execution-companion.v1",
    companion_version: 1,
    report: {
      report_id: "pdf-tools.extraction-phase1-report.v1",
      run_id: RUN_ID,
    },
    direct_source_set_sha256: "d".repeat(64),
  };
  return {
    execution_companion: {
      filename: "execution-companion.v1.json",
      bytes: Buffer.from(`${JSON.stringify(companion, null, 2)}\n`),
    },
    execution_report: { filename: "execution-report.v1.json", bytes: Buffer.from("{\"report\":true}\n") },
  };
}

async function sourceGeneration({ policy = "public_synthetic", trustedProhibitedRoots = [] } = {}) {
  const parent = await root();
  let privacyAttestation;
  return publishImmutableGeneration({
    parentDirectory: parent,
    runId: RUN_ID,
    kind: "execution",
    artifacts: artifacts(),
    preIndexArtifactBuilder: async ({ stagingPath, artifacts: retained }) => {
      privacyAttestation = await buildGenerationPrivacyAttestation({
        stagingPath,
        artifacts: retained,
        policy,
        trustedProhibitedRoots,
      });
      return {
        role: "privacy_attestation",
        filename: "generation-privacy.v1.json",
        bytes: Buffer.from(`${JSON.stringify(privacyAttestation, null, 2)}\n`),
      };
    },
    finalGenerationVerifier: context => verifyFinalGenerationPrivacy({ ...context, privacyAttestation }),
  });
}

describe("Phase 1 immutable generation publisher", () => {
  it("publishes files with an index-last commit marker and verifies exact bytes, modes, and identity", async () => {
    const parent = await root();
    const published = await publishImmutableGeneration({ parentDirectory: parent, runId: RUN_ID, kind: "execution", artifacts: artifacts(), transactionId: TX });
    expect(published.state).toBe("complete");
    const inspection = await inspectGenerationDirectory(published.generationPath);
    expect(inspection).toMatchObject({ state: "complete", generation_sha256: published.generation_sha256 });
    expect(inspection.index.artifacts.map(item => item.role)).toEqual(["execution_companion", "execution_report"]);
    expect((await fs.stat(published.generationPath)).mode & 0o777).toBe(0o700);
    for (const item of [...inspection.index.artifacts.map(value => value.path), "execution-index.v1.json"]) {
      expect((await fs.stat(path.join(published.generationPath, item))).mode & 0o777).toBe(0o600);
    }
    await expect(publishImmutableGeneration({ parentDirectory: parent, runId: RUN_ID, kind: "execution", sourceGenerationSha256: "a".repeat(64), artifacts: artifacts() })).rejects.toThrow(/strict contract/);
    await expect(publishImmutableGeneration({ parentDirectory: parent, runId: RUN_ID, kind: "score", artifacts: artifacts() })).rejects.toThrow(/strict contract/);
    await expect(publishImmutableGeneration({ parentDirectory: parent, runId: RUN_ID, kind: "received_execution", artifacts: artifacts() })).rejects.toThrow(/strict contract/);
    await expect(publishImmutableGeneration({ parentDirectory: parent, runId: RUN_ID, kind: "received_score", artifacts: artifacts() })).rejects.toThrow(/strict contract/);
  });

  it("binds private-generation privacy evidence before the index and rechecks it after publication", async () => {
    const parent = await root();
    const prohibited = await root();
    let privacyAttestation;
    const published = await publishImmutableGeneration({
      parentDirectory: parent,
      runId: RUN_ID,
      kind: "execution",
      artifacts: artifacts(),
      transactionId: TX,
      preIndexArtifactBuilder: async ({ stagingPath, artifacts: retained }) => {
        privacyAttestation = await buildGenerationPrivacyAttestation({
          stagingPath,
          artifacts: retained,
          policy: "private_local_minimized",
          trustedProhibitedRoots: [prohibited],
        });
        return {
          role: "privacy_attestation",
          filename: "generation-privacy.v1.json",
          bytes: Buffer.from(`${JSON.stringify(privacyAttestation, null, 2)}\n`),
        };
      },
      finalGenerationVerifier: context => verifyFinalGenerationPrivacy({ ...context, privacyAttestation }),
    });
    const inspection = await inspectGenerationDirectory(published.generationPath);
    expect(inspection).toMatchObject({ state: "complete" });
    expect(inspection.index.artifacts.map(item => item.role)).toEqual([
      "execution_companion",
      "execution_report",
      "privacy_attestation",
    ]);
    expect(privacyAttestation).toMatchObject({
      policy: "private_local_minimized",
      publication_authorized: false,
      scope: "ordinary_artifacts_before_privacy_attestation_and_index",
    });
  });

  it("fails privacy publication closed on hostile pre-index and final-generation mutations", async () => {
    const preIndexParent = await root();
    const prohibited = await root();
    await expect(publishImmutableGeneration({
      parentDirectory: preIndexParent,
      runId: RUN_ID,
      kind: "execution",
      artifacts: artifacts(),
      transactionId: TX,
      preIndexArtifactBuilder: async ({ stagingPath, artifacts: retained }) => {
        await fs.writeFile(path.join(stagingPath, "unindexed.json"), "{}\n", { mode: 0o600 });
        return {
          role: "privacy_attestation",
          filename: "generation-privacy.v1.json",
          bytes: Buffer.from(`${JSON.stringify(await buildGenerationPrivacyAttestation({
            stagingPath,
            artifacts: retained,
            policy: "private_local",
            trustedProhibitedRoots: [prohibited],
          }), null, 2)}\n`),
        };
      },
    })).rejects.toThrow(/file set/);

    const finalParent = await root();
    let privacyAttestation;
    let caught;
    try {
      await publishImmutableGeneration({
        parentDirectory: finalParent,
        runId: RUN_ID,
        kind: "execution",
        artifacts: artifacts(),
        transactionId: TX,
        preIndexArtifactBuilder: async ({ stagingPath, artifacts: retained }) => {
          privacyAttestation = await buildGenerationPrivacyAttestation({
            stagingPath,
            artifacts: retained,
            policy: "private_local",
            trustedProhibitedRoots: [prohibited],
          });
          return {
            role: "privacy_attestation",
            filename: "generation-privacy.v1.json",
            bytes: Buffer.from(`${JSON.stringify(privacyAttestation, null, 2)}\n`),
          };
        },
        finalGenerationVerifier: async context => {
          await fs.chmod(path.join(context.generationPath, "execution-report.v1.json"), 0o640);
          return verifyFinalGenerationPrivacy({ ...context, privacyAttestation });
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught.publication_state).toBeUndefined();
    expect(caught.message).toMatch(/unsafe file identity or mode/);
    await expect(fs.lstat(path.join(finalParent, `execution-${RUN_ID}-${TX}`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("classifies absent commit markers as ignored incompleteness and indexed mismatches as corruption", async () => {
    const parent = await root();
    const incomplete = path.join(parent, "execution-incomplete");
    await fs.mkdir(incomplete, { mode: 0o700 });
    await fs.writeFile(path.join(incomplete, "execution-report.v1.json"), "{}\n", { mode: 0o600 });
    expect(await inspectGenerationDirectory(incomplete)).toEqual({ state: "incomplete_ignored", reason: "commit_marker_absent" });

    const published = await publishImmutableGeneration({ parentDirectory: parent, runId: RUN_ID, kind: "execution", artifacts: artifacts() });
    await fs.rm(path.join(published.generationPath, "execution-report.v1.json"));
    expect(await inspectGenerationDirectory(published.generationPath)).toMatchObject({ state: "corruption", reason: expect.stringContaining("artifact_unavailable") });
  });

  it("rejects byte, canonical-index, pathname, symlink, and directory-identity mutations", async () => {
    const parent = await root();
    const cases = [];
    for (let index = 0; index < 4; index += 1) cases.push(await publishImmutableGeneration({ parentDirectory: parent, runId: RUN_ID, kind: "execution", artifacts: artifacts() }));

    const reportPath = path.join(cases[0].generationPath, "execution-report.v1.json");
    const original = await fs.readFile(reportPath);
    await fs.writeFile(reportPath, Buffer.from(original.toString().replace("true", "null")), { mode: 0o600 });
    expect(await inspectGenerationDirectory(cases[0].generationPath)).toMatchObject({ state: "corruption", reason: expect.stringContaining("artifact_mismatch") });

    const indexPath = path.join(cases[1].generationPath, "execution-index.v1.json");
    await fs.appendFile(indexPath, " ");
    expect(await inspectGenerationDirectory(cases[1].generationPath)).toMatchObject({ state: "corruption", reason: "noncanonical_index_bytes" });

    const reportPath2 = path.join(cases[2].generationPath, "execution-report.v1.json");
    await fs.rm(reportPath2);
    await fs.symlink("execution-companion.v1.json", reportPath2);
    expect(await inspectGenerationDirectory(cases[2].generationPath)).toMatchObject({ state: "corruption", reason: expect.stringContaining("artifact_unavailable") });

    const renamed = `${cases[3].generationPath}-renamed`;
    await fs.rename(cases[3].generationPath, renamed);
    expect(await inspectGenerationDirectory(renamed)).toMatchObject({ state: "corruption", reason: "directory_identity_mismatch" });
  });

  it("rejects a precreated destination and serializes concurrent same-transaction writers", async () => {
    const parent = await root();
    const destination = path.join(parent, `execution-${RUN_ID}-${TX}`);
    await fs.mkdir(destination, { mode: 0o700 });
    await expect(publishImmutableGeneration({ parentDirectory: parent, runId: RUN_ID, kind: "execution", artifacts: artifacts(), transactionId: TX })).rejects.toThrow(/precreated or reused/);

    const concurrentParent = await root();
    const settled = await Promise.allSettled([1, 2].map(() => publishImmutableGeneration({ parentDirectory: concurrentParent, runId: RUN_ID, kind: "execution", artifacts: artifacts(), transactionId: TX })));
    expect(settled.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter(item => item.status === "rejected")).toHaveLength(1);
  });

  it("recovers complete staging with an existing claim and rejects mismatched or symlink claims", async () => {
    const parent = await root();
    await expect(publishImmutableGeneration({
      parentDirectory: parent, runId: RUN_ID, kind: "execution", artifacts: artifacts(), transactionId: TX,
      faultInjector: phase => { if (phase === "before_final_rename") throw new Error("crash"); },
    })).rejects.toThrow("crash");
    const stagingPath = path.join(parent, `.staging-execution-${RUN_ID}-${TX}`);
    const generationPath = path.join(parent, `execution-${RUN_ID}-${TX}`);
    const recovered = await recoverVerifiedStagingGeneration({ stagingPath, generationPath });
    expect(recovered.state).toBe("recovered_complete");
    expect(await inspectGenerationDirectory(generationPath)).toMatchObject({ state: "complete" });

    const hostileParent = await root();
    await expect(publishImmutableGeneration({
      parentDirectory: hostileParent, runId: RUN_ID, kind: "execution", artifacts: artifacts(), transactionId: TX,
      faultInjector: phase => { if (phase === "before_final_rename") throw new Error("crash"); },
    })).rejects.toThrow("crash");
    const claim = path.join(hostileParent, `.claim-execution-${RUN_ID}-${TX}`);
    await fs.writeFile(claim, "wrong\n", { mode: 0o600 });
    await expect(recoverVerifiedStagingGeneration({
      stagingPath: path.join(hostileParent, `.staging-execution-${RUN_ID}-${TX}`),
      generationPath: path.join(hostileParent, `execution-${RUN_ID}-${TX}`),
    })).rejects.toThrow(/claim is invalid/);
  });

  it("marks every post-rename fault durability-uncertain and revalidates before final recovery", async () => {
    for (const phase of ["after_final_rename", "after_parent_fsync"]) {
      const parent = await root();
      let caught;
      try {
        await publishImmutableGeneration({
          parentDirectory: parent, runId: RUN_ID, kind: "execution", artifacts: artifacts(), transactionId: TX,
          faultInjector: current => { if (current === phase) throw new Error(phase); },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ publication_state: "durability_uncertain", generation_path: expect.any(String) });
      expect(await inspectGenerationDirectory(caught.generation_path)).toEqual({
        state: "durability_uncertain",
        reason: "active_transaction_claim",
      });
      expect(await recoverPublishedGeneration({ generationPath: caught.generation_path })).toMatchObject({ state: "recovered_complete" });
    }
  });

  it("keeps transaction claims until privacy-semantic recovery succeeds", async () => {
    for (const phase of ["before_final_rename", "after_final_rename"]) {
      const parent = await root();
      let privacyAttestation;
      await expect(publishImmutableGeneration({
        parentDirectory: parent,
        runId: RUN_ID,
        kind: "execution",
        artifacts: artifacts(),
        transactionId: TX,
        preIndexArtifactBuilder: async ({ stagingPath, artifacts: retained }) => {
          privacyAttestation = await buildGenerationPrivacyAttestation({
            stagingPath,
            artifacts: retained,
            policy: "public_synthetic",
            trustedProhibitedRoots: [],
          });
          return {
            role: "privacy_attestation",
            filename: "generation-privacy.v1.json",
            bytes: Buffer.from(`${JSON.stringify(privacyAttestation, null, 2)}\n`),
          };
        },
        finalGenerationVerifier: context => verifyFinalGenerationPrivacy({ ...context, privacyAttestation }),
        faultInjector: current => { if (current === phase) throw new Error(phase); },
      })).rejects.toThrow(phase);

      const stagingPath = path.join(parent, `.staging-execution-${RUN_ID}-${TX}`);
      const generationPath = path.join(parent, `execution-${RUN_ID}-${TX}`);
      const recovery = phase === "before_final_rename"
        ? options => recoverVerifiedStagingGeneration({ stagingPath, generationPath, ...options })
        : options => recoverPublishedGeneration({ generationPath, ...options });
      const activePath = phase === "before_final_rename" ? stagingPath : generationPath;
      expect(await recovery({})).toMatchObject({ state: "recovery_required", reason: "semantic_verifier_required" });
      expect(await inspectGenerationDirectory(activePath, { allowStaging: phase === "before_final_rename" })).toEqual({
        state: "durability_uncertain",
        reason: "active_transaction_claim",
      });
      await expect(recovery({ semanticVerifier: () => { throw new Error("semantic recovery rejection"); } })).rejects.toThrow("semantic recovery rejection");
      expect(await inspectGenerationDirectory(activePath, { allowStaging: phase === "before_final_rename" })).toEqual({
        state: "durability_uncertain",
        reason: "active_transaction_claim",
      });
      const recovered = await recovery({
        semanticVerifier: context => verifyFinalGenerationPrivacy({ ...context, privacyAttestation }),
      });
      expect(recovered.state).toBe("recovered_complete");
      expect(await inspectGenerationDirectory(generationPath)).toMatchObject({ state: "complete" });
      await expect(fs.lstat(path.join(parent, `.claim-execution-${RUN_ID}-${TX}`))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("receives a fully rehashed source generation into a destination-local immutable generation", async () => {
    const source = await sourceGeneration();
    const destinationParent = await root();
    const received = await receiveVerifiedGeneration({
      sourceGenerationPath: source.generationPath,
      destinationParentDirectory: destinationParent,
      sourceHost: "silverbook",
      destinationHost: "silvercloud",
      transportedAt: "2026-07-22T00:00:00Z",
      transport: "tailscale_tailnet",
      transactionId: TX,
    });
    expect(received.destination).toMatchObject({
      state: "complete",
      index: {
        kind: "received_execution",
        run_id: RUN_ID,
        source_generation_sha256: source.generation_sha256,
      },
    });
    expect(received.receipt).toMatchObject({ authenticity: "unavailable", key_id: null, signature: null });
    expect(received.destination.index.artifacts.map(item => item.role)).toEqual([
      "execution_companion",
      "execution_report",
      "privacy_attestation",
      "received_privacy_attestation",
      "source_generation_index",
      "transfer_receipt",
    ]);
    expect((await fs.lstat(received.generationPath)).mode & 0o777).toBe(0o700);
    for (const name of [...received.destination.index.artifacts.map(item => item.path), "execution-index.v1.json"]) {
      const stat = await fs.lstat(path.join(received.generationPath, name));
      expect(stat.isFile() && !stat.isSymbolicLink()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("keeps private source and destination prohibited-root evidence distinct", async () => {
    const sourceSyncRoot = await root();
    const destinationSyncRoot = await root();
    const sourceTrustedProhibitedRoots = [REPO_ROOT, sourceSyncRoot];
    const destinationTrustedProhibitedRoots = [REPO_ROOT, destinationSyncRoot];
    const trustedSourceProhibitedRootSetSha256 = generationProhibitedRootSetSha256(sourceTrustedProhibitedRoots);
    const source = await sourceGeneration({ policy: "private_local", trustedProhibitedRoots: sourceTrustedProhibitedRoots });
    const validDestination = await root();
    const valid = await receiveVerifiedGeneration({
      sourceGenerationPath: source.generationPath,
      destinationParentDirectory: validDestination,
      sourceHost: "silverbook",
      destinationHost: "silvercloud",
      transportedAt: "2026-07-22T00:00:00Z",
      transport: "tailscale_tailnet",
      trustedSourceProhibitedRootSetSha256,
      destinationTrustedProhibitedRoots,
    });
    expect(valid.destination.state).toBe("complete");

    const copiedSourcePath = path.join(sourceSyncRoot, "copied-private-generation");
    await fs.cp(source.generationPath, copiedSourcePath, { recursive: true, preserveTimestamps: true });
    await fs.chmod(copiedSourcePath, 0o700);
    await Promise.all((await fs.readdir(copiedSourcePath)).map(filename => fs.chmod(path.join(copiedSourcePath, filename), 0o600)));
    await expect(receiveVerifiedGeneration({
      sourceGenerationPath: copiedSourcePath,
      destinationParentDirectory: await root(),
      sourceHost: "silverbook",
      destinationHost: "silvercloud",
      transportedAt: "2026-07-22T00:00:00Z",
      transport: "tailscale_tailnet",
      trustedSourceProhibitedRootSetSha256,
      destinationTrustedProhibitedRoots,
    })).rejects.toThrow(/complete original|source or destination overlaps/);

    await expect(receiveVerifiedGeneration({
      sourceGenerationPath: source.generationPath,
      destinationParentDirectory: destinationSyncRoot,
      sourceHost: "silverbook",
      destinationHost: "silvercloud",
      transportedAt: "2026-07-22T00:00:00Z",
      transport: "tailscale_tailnet",
      trustedSourceProhibitedRootSetSha256,
      destinationTrustedProhibitedRoots,
    })).rejects.toThrow(/source or destination overlaps/);
    expect(await fs.readdir(destinationSyncRoot)).toEqual([]);

    await expect(receiveVerifiedGeneration({
      sourceGenerationPath: source.generationPath,
      destinationParentDirectory: await root(),
      sourceHost: "silverbook",
      destinationHost: "silvercloud",
      transportedAt: "2026-07-22T00:00:00Z",
      transport: "tailscale_tailnet",
      trustedSourceProhibitedRootSetSha256: "0".repeat(64),
      destinationTrustedProhibitedRoots,
    })).rejects.toThrow(/do not match source/);
  });

  it("rejects hostile source generations and copy faults before destination publication", async () => {
    const mutateCases = [
      ["partial", async source => fs.rm(path.join(source.generationPath, "execution-index.v1.json"))],
      ["extra", async source => fs.writeFile(path.join(source.generationPath, "extra.json"), "{}\n", { mode: 0o600 })],
      ["symlink", async source => {
        const target = path.join(source.generationPath, "execution-report.v1.json");
        await fs.rm(target);
        await fs.symlink("execution-companion.v1.json", target);
      }],
      ["mode", async source => fs.chmod(path.join(source.generationPath, "execution-report.v1.json"), 0o640)],
      ["index", async source => fs.appendFile(path.join(source.generationPath, "execution-index.v1.json"), " ")],
      ["run", async source => {
        const filename = path.join(source.generationPath, "execution-index.v1.json");
        const index = JSON.parse(await fs.readFile(filename));
        index.run_id = "d".repeat(64);
        await fs.writeFile(filename, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
      }],
      ["role", async source => {
        const filename = path.join(source.generationPath, "execution-index.v1.json");
        const index = JSON.parse(await fs.readFile(filename));
        index.artifacts[0].role = "InvalidRole";
        await fs.writeFile(filename, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
      }],
      ["hash", async source => fs.writeFile(path.join(source.generationPath, "execution-report.v1.json"), "{\"changed\":true}\n", { mode: 0o600 })],
      ["source-generation", async source => {
        const filename = path.join(source.generationPath, "execution-index.v1.json");
        const index = JSON.parse(await fs.readFile(filename));
        index.source_generation_sha256 = "e".repeat(64);
        await fs.writeFile(filename, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
      }],
    ];
    for (const [label, mutate] of mutateCases) {
      const source = await sourceGeneration();
      const destinationParent = await root();
      await mutate(source);
      await expect(receiveVerifiedGeneration({
        sourceGenerationPath: source.generationPath,
        destinationParentDirectory: destinationParent,
        sourceHost: "silverbook",
        destinationHost: "silvercloud",
        transportedAt: "2026-07-22T00:00:00Z",
        transport: "tailscale_tailnet",
      }), label).rejects.toThrow();
      expect(await fs.readdir(destinationParent), label).toEqual([]);
    }

    const source = await sourceGeneration();
    const destinationParent = await root();
    await expect(receiveVerifiedGeneration({
      sourceGenerationPath: source.generationPath,
      destinationParentDirectory: destinationParent,
      sourceHost: "silverbook",
      destinationHost: "silvercloud",
      transportedAt: "2026-07-22T00:00:00Z",
      transport: "tailscale_tailnet",
      copyFaultInjector: phase => { if (phase === "after_source_artifact_copy") throw new Error("copy fault"); },
    })).rejects.toThrow("copy fault");
    const partialNames = await fs.readdir(destinationParent);
    expect(partialNames.every(name => name.startsWith(".claim-") || name.startsWith(".staging-"))).toBe(true);
    const partialStaging = partialNames.find(name => name.startsWith(".staging-"));
    expect(await inspectGenerationDirectory(path.join(destinationParent, partialStaging), { allowStaging: true })).toEqual({
      state: "incomplete_ignored",
      reason: "commit_marker_absent",
    });
  });

  it("streams multi-chunk artifacts with bounded buffers and rejects source or destination mutation", async () => {
    const largeParent = await root();
    const largeBytes = Buffer.alloc((3 * 1024 * 1024) + 73, 0x61);
    let largePrivacy;
    const largeSource = await publishImmutableGeneration({
      parentDirectory: largeParent,
      runId: RUN_ID,
      kind: "execution",
      artifacts: { ...artifacts(), large_payload: { filename: "large-payload.json", bytes: largeBytes } },
      preIndexArtifactBuilder: async ({ stagingPath, artifacts: retained }) => {
        largePrivacy = await buildGenerationPrivacyAttestation({ stagingPath, artifacts: retained, policy: "public_synthetic", trustedProhibitedRoots: [] });
        return { role: "privacy_attestation", filename: "generation-privacy.v1.json", bytes: Buffer.from(`${JSON.stringify(largePrivacy, null, 2)}\n`) };
      },
      finalGenerationVerifier: context => verifyFinalGenerationPrivacy({ ...context, privacyAttestation: largePrivacy }),
    });
    const destinationParent = await root();
    const sourceChunkSizes = [];
    const destinationChunkSizes = [];
    const received = await receiveVerifiedGeneration({
      sourceGenerationPath: largeSource.generationPath,
      destinationParentDirectory: destinationParent,
      sourceHost: "stonebook",
      destinationHost: "silvercloud",
      transportedAt: "2026-07-22T00:00:00Z",
      transport: "tailscale_tailnet",
      copyFaultInjector: (phase, context) => {
        if (phase === "source_chunk") sourceChunkSizes.push(context.chunk_bytes);
        if (phase === "destination_verify_chunk") destinationChunkSizes.push(context.chunk_bytes);
      },
    });
    expect(received.state).toBe("complete");
    expect(sourceChunkSizes.length).toBeGreaterThan(3);
    expect(destinationChunkSizes.length).toBeGreaterThan(3);
    expect(Math.max(...sourceChunkSizes, ...destinationChunkSizes)).toBeLessThanOrEqual(1024 * 1024);

    const changingSource = await sourceGeneration();
    const changingDestination = await root();
    let changed = false;
    await expect(receiveVerifiedGeneration({
      sourceGenerationPath: changingSource.generationPath,
      destinationParentDirectory: changingDestination,
      sourceHost: "silverbook",
      destinationHost: "silvercloud",
      transportedAt: "2026-07-22T00:00:00Z",
      transport: "tailscale_tailnet",
      copyFaultInjector: async phase => {
        if (phase === "after_source_artifact_copy" && !changed) {
          changed = true;
          await fs.writeFile(path.join(changingSource.generationPath, "execution-companion.v1.json"), "{\"mutated\":true}\n", { mode: 0o600 });
        }
      },
    })).rejects.toThrow(/changed during cross-device copy/);

    const stableSource = await sourceGeneration();
    const tamperedDestination = await root();
    let tampered = false;
    await expect(receiveVerifiedGeneration({
      sourceGenerationPath: stableSource.generationPath,
      destinationParentDirectory: tamperedDestination,
      sourceHost: "silverbook",
      destinationHost: "silvercloud",
      transportedAt: "2026-07-22T00:00:00Z",
      transport: "tailscale_tailnet",
      publicationFaultInjector: async (phase, context) => {
        if (phase === "after_destination_artifact_copy" && !tampered) {
          tampered = true;
          await fs.chmod(path.join(context.stagingPath, context.path), 0o640);
        }
      },
    })).rejects.toThrow(/mode-0600|unsafe mode|changed before commit/);

    const raceSource = await sourceGeneration();
    const raceDestination = await root();
    await expect(receiveVerifiedGeneration({
      sourceGenerationPath: raceSource.generationPath,
      destinationParentDirectory: raceDestination,
      sourceHost: "silverbook",
      destinationHost: "silvercloud",
      transportedAt: "2026-07-22T00:00:00Z",
      transport: "tailscale_tailnet",
      transactionId: TX,
      publicationFaultInjector: async (phase, context) => {
        if (phase === "before_final_rename") await fs.mkdir(context.generationPath, { mode: 0o700 });
      },
    })).rejects.toThrow(/precreated or reused/);
    const racedPath = path.join(raceDestination, `received_execution-${RUN_ID}-${TX}`);
    expect(await fs.readdir(racedPath)).toEqual([]);
  });
});
