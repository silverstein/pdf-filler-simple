import fs from "node:fs/promises";
import path from "node:path";
import { PHASE1_ARTIFACT_CONFIG_ID, PHASE1_ARTIFACT_ROLES } from "./extraction-phase1-artifacts.js";
import { sha256 } from "./extraction-phase1-protocol.js";

export async function createPhase1TestDeployment({ root, candidateId, sourceBytes, filename = "candidate.mjs" }) {
  const deployment = path.join(root, "candidate-deployment");
  const adapterRoot = path.join(deployment, "adapter");
  const sourceRoot = path.join(deployment, "source");
  const reviewRoot = path.join(deployment, "review");
  const termsRoot = path.join(deployment, "terms");
  await Promise.all([adapterRoot, sourceRoot, reviewRoot, termsRoot].map(directory => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
  const candidatePath = path.join(adapterRoot, filename);
  const reviewBytes = Buffer.from("Synthetic test deployment license review\n");
  await Promise.all([
    fs.writeFile(candidatePath, sourceBytes, { mode: 0o600 }),
    fs.writeFile(path.join(sourceRoot, filename), sourceBytes, { mode: 0o600 }),
    fs.writeFile(path.join(reviewRoot, "review.txt"), reviewBytes, { mode: 0o600 }),
    fs.writeFile(path.join(termsRoot, "LICENSE.txt"), "MIT synthetic test deployment\n", { mode: 0o600 }),
  ]);
  const componentId = "phase1-test-adapter";
  const licenseId = "phase1-test-license";
  const rootSpec = (root_role, artifact_role, rootPath) => ({
    root_role, artifact_role, component_id: componentId, license_ids: [licenseId], path: rootPath,
    required: true, allow_symlinks: {}, allow_hardlink_groups: [],
  });
  return {
    candidatePath,
    artifactConfiguration: {
      config_id: PHASE1_ARTIFACT_CONFIG_ID,
      candidate_id: candidateId,
      configured: true,
      root_specs: [
        rootSpec("adapter", "adapter_entrypoint", adapterRoot),
        rootSpec("review", "license_review", reviewRoot),
        rootSpec("source", "adapter_source", sourceRoot),
        rootSpec("terms", "license_text", termsRoot),
      ],
      role_dispositions: PHASE1_ARTIFACT_ROLES.map(role => {
        if (["adapter_entrypoint", "adapter_source", "license_review", "license_text"].includes(role)) return { role, status: "required", reason: null };
        if (["candidate_config", "environment_lock", "installed_distribution", "interpreter", "runtime_config"].includes(role)) {
          return { role, status: "pending", reason: "synthetic_test_double_nonclaiming" };
        }
        return { role, status: "not_applicable", reason: "not_used_by_candidate" };
      }),
      components: [{
        component_id: componentId,
        version: "1.0.0-test",
        source_reference: "local:synthetic-test-deployment",
        source_revision: "fixture-v1",
        license_ids: [licenseId],
        artifact_roles: ["adapter_entrypoint", "adapter_source", "license_review", "license_text"],
      }],
      licenses: [{
        component_id: componentId,
        license_id: licenseId,
        license_name: "MIT synthetic test deployment",
        license_text_artifact_id: "terms:LICENSE.txt",
        review_record_artifact_id: "review:review.txt",
        review_record_sha256: sha256(reviewBytes),
        review_scope: "Phase 1 test doubles only",
        reviewed_at: "2026-07-22T00:00:00Z",
        status: "reviewed_license",
      }],
    },
  };
}
