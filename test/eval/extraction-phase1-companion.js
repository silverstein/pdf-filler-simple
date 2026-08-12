import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJson, reportAttemptKey, sha256 } from "./extraction-phase1-protocol.js";
import { hashTrustedRegularFile } from "./extraction-phase1-artifacts.js";

export const PHASE1_EXECUTION_COMPANION_ID = "pdf-tools.extraction-phase1-execution-companion.v1";
export const PHASE1_CROSS_DEVICE_RECEIPT_ID = "pdf-tools.extraction-phase1-cross-device-receipt.v1";
export const PHASE1_COMPANION_SOURCE_ROLES = Object.freeze([
  "accessibility_inspection_module",
  "artifact_config_schema",
  "artifact_inventory_schema",
  "artifact_module",
  "companion_module",
  "companion_schema",
  "corpus_module",
  "corpus_schema",
  "execution_generation_verifier_module",
  "execution_index_schema",
  "extraction_manifest_loader",
  "generation_privacy_schema",
  "generation_verifier_common_module",
  "layout_evidence_module",
  "layout_extraction_module",
  "layout_output_schemas_module",
  "markdown_conversion_module",
  "mcp_sdk_package",
  "package_json",
  "package_lock",
  "pdf_comparison_module",
  "pdf_lib_package",
  "pdf_observations_module",
  "pdfjs_package",
  "plan_schema",
  "protocol_module",
  "publisher_module",
  "receipt_schema",
  "registry_schema",
  "report_schema",
  "report_verifier_module",
  "request_schema",
  "response_schema",
  "runner_script",
  "table_proposal_verification_module",
  "type3_cm_pk_reference_module",
  "type3_cm_reference_module",
]);
export const PHASE1_COMPANION_SOURCE_PATHS = Object.freeze({
  accessibility_inspection_module: "server/accessibility-inspection.js",
  artifact_config_schema: "test/fixtures/eval/extraction/phase1/artifact-config.schema.json",
  artifact_inventory_schema: "test/fixtures/eval/extraction/phase1/artifact-inventory.schema.json",
  artifact_module: "test/eval/extraction-phase1-artifacts.js",
  companion_module: "test/eval/extraction-phase1-companion.js",
  companion_schema: "test/fixtures/eval/extraction/phase1/execution-companion.schema.json",
  corpus_module: "test/eval/extraction-phase1-corpus.js",
  corpus_schema: "test/fixtures/eval/extraction/phase1/corpus.schema.json",
  execution_generation_verifier_module: "test/eval/extraction-phase1-execution-generation-verifier.js",
  execution_index_schema: "test/fixtures/eval/extraction/phase1/execution-index.schema.json",
  extraction_manifest_loader: "test/eval/extraction-manifest.js",
  generation_privacy_schema: "test/fixtures/eval/extraction/phase1/generation-privacy.schema.json",
  generation_verifier_common_module: "test/eval/extraction-phase1-generation-verifier-common.js",
  layout_evidence_module: "test/eval/extraction-phase1-layout-evidence.js",
  layout_extraction_module: "server/layout-extraction.js",
  type3_cm_reference_module: "server/type3-cm-reference.js",
  type3_cm_pk_reference_module: "server/type3-cm-pk-reference.js",
  layout_output_schemas_module: "server/output-schemas.js",
  markdown_conversion_module: "server/markdown-conversion.js",
  mcp_sdk_package: "node_modules/@modelcontextprotocol/sdk/package.json",
  package_json: "package.json",
  package_lock: "package-lock.json",
  pdf_comparison_module: "server/pdf-comparison.js",
  pdf_observations_module: "server/pdf-observations.js",
  pdf_lib_package: "node_modules/pdf-lib/package.json",
  pdfjs_package: "node_modules/pdfjs-dist/package.json",
  plan_schema: "test/fixtures/eval/extraction/phase1/run-plan.schema.json",
  protocol_module: "test/eval/extraction-phase1-protocol.js",
  publisher_module: "test/eval/extraction-phase1-publisher.js",
  receipt_schema: "test/fixtures/eval/extraction/phase1/cross-device-receipt.schema.json",
  registry_schema: "test/fixtures/eval/extraction/phase1/candidate-registry.schema.json",
  report_schema: "test/fixtures/eval/extraction/phase1/report.schema.json",
  report_verifier_module: "test/eval/extraction-phase1-report-verifier.js",
  request_schema: "test/fixtures/eval/extraction/phase1/candidate-request.schema.json",
  response_schema: "test/fixtures/eval/extraction/phase1/candidate-response.schema.json",
  runner_script: "scripts/eval-run-extraction-candidates.mjs",
  table_proposal_verification_module: "server/table-proposal-verification.js",
});
export const PHASE1_UNAVAILABLE_RESOURCE_FACTS = Object.freeze([
  "continuous_immutability",
  "cost_usd",
  "cpu_time_ms",
  "energy_joules",
  "filesystem_bytes_read",
  "filesystem_bytes_written",
  "gpu_memory_peak_bytes",
  "network_egress_bytes",
  "process_count_peak",
  "process_tree_peak_rss_bytes",
]);

export function companionProhibitedRootSetSha256(trustedProhibitedRoots = []) {
  return sha256(Buffer.from(`pdf-tools.privacy-prohibited-roots.v1\0${canonicalJson(trustedProhibitedRoots.map(item => sha256(Buffer.from(path.resolve(item)))).sort())}`));
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} must contain exactly the trusted keys`);
  }
}

function decodedBytes(value) {
  if (value === null) return 0;
  if (typeof value !== "string" || value.length % 4 !== 0) {
    throw new Error("Runner capture is not canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("Runner capture is not canonical base64");
  return bytes.length;
}

function artifactBytes(inventory, roles) {
  if (inventory.state === "not_applicable") return 0;
  return inventory.artifacts.filter(item => roles.includes(item.artifact_role)).reduce((total, item) => total + item.bytes, 0);
}

function categorizedArtifactBytes(inventory, roles, category) {
  if (!inventory) return { bytes: null, unavailableReason: "artifact_precheck_failed" };
  const dispositionByRole = new Map(inventory.role_dispositions.map(item => [item.role, item]));
  for (const role of roles) {
    const disposition = dispositionByRole.get(role);
    if (disposition?.status === "pending") return { bytes: null, unavailableReason: `${category}_roles_pending` };
    if (disposition?.status === "required" && !inventory.artifacts.some(item => item.artifact_role === role)) {
      return { bytes: null, unavailableReason: `${category}_required_role_not_captured` };
    }
    if (!disposition || !["required", "not_applicable"].includes(disposition.status)) {
      return { bytes: null, unavailableReason: `${category}_role_disposition_incomplete` };
    }
  }
  return { bytes: artifactBytes(inventory, roles), unavailableReason: null };
}

export function deriveRunnerResourceFacts(report, artifactAttestationByCandidateId) {
  const result = {};
  for (const attempt of report.attempts) {
    const key = reportAttemptKey(attempt);
    const attestation = artifactAttestationByCandidateId[attempt.candidate_id];
    const inventory = attestation?.before;
    if (!attestation) throw new Error(`Missing runner-owned artifact attestation for ${attempt.candidate_id}`);
    const spawned = attempt.execution.spawned;
    const environment = categorizedArtifactBytes(inventory, ["environment_lock", "installed_distribution", "interpreter", "runtime_config", "system_component"], "environment");
    const model = categorizedArtifactBytes(inventory, ["model_config", "model_weights", "required_data", "tokenizer_preprocessor"], "model");
    const unavailable = Object.fromEntries(PHASE1_UNAVAILABLE_RESOURCE_FACTS.map(name => [name, null]));
    result[key] = {
      wall_elapsed_ms: spawned ? attempt.execution.elapsed_ms : null,
      source_bytes: attempt.source.size_bytes,
      request_payload_bytes: attempt.request === null ? null : Buffer.byteLength(canonicalJson(attempt.request)),
      stdout_observed_bytes: spawned ? attempt.execution.stdout_bytes : null,
      stdout_retained_bytes: spawned ? decodedBytes(attempt.captures.stdout_base64) : null,
      stderr_observed_bytes: spawned ? attempt.execution.stderr_bytes : null,
      stderr_retained_bytes: spawned ? decodedBytes(attempt.captures.stderr_base64) : null,
      artifact_logical_bytes: inventory?.logical_bytes ?? null,
      artifact_unique_content_bytes: inventory?.unique_content_bytes ?? null,
      environment_bytes: environment.bytes,
      environment_bytes_unavailable_reason: environment.unavailableReason,
      model_bytes: model.bytes,
      model_bytes_unavailable_reason: model.unavailableReason,
      unavailable,
    };
  }
  return result;
}

function pathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realDirectoryWithoutSymlinkAncestors(directory) {
  const resolved = path.resolve(directory);
  let cursor = path.parse(resolved).root;
  for (const segment of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error("Privacy boundary contains a symlinked ancestor");
  }
  const real = await fs.realpath(resolved);
  if (real !== resolved) throw new Error("Privacy boundary realpath differs from its trusted path");
  return real;
}

export async function buildPrivacyEvidence({
  trustedPrivacyClass,
  runRoot,
  trustedProhibitedRoots,
  publicationAuthorized = false,
  expectedRetainedFilePaths = null,
  policyOnly = false,
}) {
  if (!["public_synthetic", "private_local", "private_local_minimized"].includes(trustedPrivacyClass)) throw new Error("Unknown extraction privacy class");
  if (!path.isAbsolute(runRoot)) throw new Error("Extraction run root must be absolute");
  const privateRun = trustedPrivacyClass !== "public_synthetic";
  const realRunRoot = await realDirectoryWithoutSymlinkAncestors(runRoot);
  const rootStat = await fs.lstat(realRunRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Extraction run root must be a real directory");
  if (privateRun) {
    if (!Array.isArray(trustedProhibitedRoots) || trustedProhibitedRoots.length === 0
      || (!policyOnly && !Array.isArray(expectedRetainedFilePaths))) throw new Error("Private extraction privacy proof requires trusted prohibited roots and an exact retained-file set");
    if (publicationAuthorized) throw new Error("Private extraction runs cannot authorize publication");
    if ((rootStat.mode & 0o777) !== 0o700) throw new Error("Private extraction run roots must use mode 0700");
    for (const prohibited of trustedProhibitedRoots) {
      const realProhibited = await realDirectoryWithoutSymlinkAncestors(prohibited);
      if (pathInside(realProhibited, realRunRoot) || pathInside(realRunRoot, realProhibited)) throw new Error("Private extraction run root overlaps a prohibited repository, sync, share, or package root");
    }
    const discovered = [];
    const visit = async directory => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const filename = path.join(directory, entry.name);
        const stat = await fs.lstat(filename);
        if (stat.isSymbolicLink()) throw new Error("Private extraction run roots cannot contain symlinks");
        if (stat.isDirectory()) {
          if ((stat.mode & 0o777) !== 0o700) throw new Error("Private extraction subdirectories must use mode 0700");
          await visit(filename);
        } else if (stat.isFile()) {
          if ((stat.mode & 0o777) !== 0o600) throw new Error("Private extraction artifacts must use mode 0600");
          discovered.push(path.resolve(filename));
        } else {
          throw new Error("Private extraction run roots cannot contain special files");
        }
      }
    };
    if (!policyOnly) await visit(runRoot);
    const expected = (expectedRetainedFilePaths ?? []).map(item => path.resolve(item)).sort();
    discovered.sort();
    if (!policyOnly && canonicalJson(discovered) !== canonicalJson(expected)) throw new Error("Private extraction retained-file enumeration differs from the trusted bundle manifest");
    for (const filename of expected) {
      if (!pathInside(runRoot, filename)) throw new Error("Private extraction artifact is outside its run root");
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) throw new Error("Private extraction artifacts must be real mode 0600 files");
    }
  }
  return {
    policy: trustedPrivacyClass,
    private_run: privateRun,
    publication_authorized: publicationAuthorized,
    run_root_sha256: sha256(Buffer.from(`pdf-tools.privacy-run-root.v1\0${realRunRoot}`)),
    run_root_mode: rootStat.mode & 0o777,
    retained_file_mode: privateRun ? 0o600 : null,
    prohibited_root_set_sha256: companionProhibitedRootSetSha256(trustedProhibitedRoots ?? []),
    retained_file_set_sha256: sha256(Buffer.from(`pdf-tools.privacy-retained-files.v1\0${canonicalJson((expectedRetainedFilePaths ?? []).map(item => sha256(Buffer.from(path.resolve(item)))).sort())}`)),
    content_minimization_policy: trustedPrivacyClass === "private_local_minimized" ? "required" : "not_required",
    content_minimization_measured: null,
    capture_content_review: "unavailable",
    generation_file_proof: policyOnly ? "separate_indexed_privacy_attestation" : "local_root_enumeration",
    raw_path_values_retained: null,
    path_identity_hashes_retained: true,
    path_hash_secrecy_claim: false,
    environment_value_absence_measured: null,
  };
}

export async function buildRunnerEnvironmentAttestation({ nodeExecutable = process.execPath, sourceBytesByRole }) {
  const node = await hashTrustedRegularFile(nodeExecutable);
  const sdkPackage = JSON.parse(Buffer.from(sourceBytesByRole.mcp_sdk_package.bytes).toString("utf8"));
  return {
    authenticity: "unavailable",
    runtime_closure: "incomplete",
    node_executable: node,
    mcp_sdk: {
      version: sdkPackage.version,
      package_json_sha256: sha256(sourceBytesByRole.mcp_sdk_package.bytes),
    },
    pdf_lib: {
      version: JSON.parse(Buffer.from(sourceBytesByRole.pdf_lib_package.bytes).toString("utf8")).version,
      package_json_sha256: sha256(sourceBytesByRole.pdf_lib_package.bytes),
    },
    pdfjs: {
      version: JSON.parse(Buffer.from(sourceBytesByRole.pdfjs_package.bytes).toString("utf8")).version,
      package_json_sha256: sha256(sourceBytesByRole.pdfjs_package.bytes),
    },
    package_lock_sha256: sha256(sourceBytesByRole.package_lock.bytes),
  };
}

export async function buildGenerationPrivacyAttestation({ stagingPath, artifacts, policy, trustedProhibitedRoots = [] }) {
  const realStaging = await realDirectoryWithoutSymlinkAncestors(stagingPath);
  const stagingStat = await fs.lstat(realStaging);
  if ((stagingStat.mode & 0o777) !== 0o700) throw new Error("Generation privacy staging directory must use mode 0700");
  const privateRun = policy !== "public_synthetic";
  if (privateRun) {
    if (!Array.isArray(trustedProhibitedRoots) || trustedProhibitedRoots.length === 0) throw new Error("Private generation requires trusted prohibited roots");
    for (const prohibited of trustedProhibitedRoots) {
      const realProhibited = await realDirectoryWithoutSymlinkAncestors(prohibited);
      if (pathInside(realProhibited, realStaging) || pathInside(realStaging, realProhibited)) throw new Error("Private generation overlaps a prohibited root");
    }
  }
  const names = await fs.readdir(realStaging);
  const expected = artifacts.map(item => item.path).sort();
  if (canonicalJson([...names].sort()) !== canonicalJson(expected)) throw new Error("Generation staging file set differs from the publisher artifact set");
  for (const name of names) {
    const stat = await fs.lstat(path.join(realStaging, name));
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) throw new Error("Generation staging contains a symlink, special file, or unsafe mode");
  }
  const scoped = artifacts.map(item => ({ role: item.role, path: item.path, bytes: item.bytes, sha256: item.sha256 }));
  return {
    attestation_id: "pdf-tools.extraction-phase1-generation-privacy.v1",
    attestation_version: 1,
    policy,
    publication_authorized: false,
    scope: "ordinary_artifacts_before_privacy_attestation_and_index",
    directory_mode: 0o700,
    file_mode: 0o600,
    symlink_or_special_files_observed: false,
    ordinary_artifacts: scoped,
    ordinary_artifact_set_sha256: sha256(Buffer.from(`pdf-tools.generation-privacy-files.v1\0${canonicalJson(scoped)}`)),
    prohibited_root_set_sha256: generationProhibitedRootSetSha256(trustedProhibitedRoots),
    raw_absolute_paths_retained: null,
    relative_generation_paths_retained: true,
    path_identity_hashes_retained: true,
    path_hash_secrecy_claim: false,
  };
}

const GENERATION_PRIVACY_KEYS = Object.freeze([
  "attestation_id", "attestation_version", "directory_mode", "file_mode", "ordinary_artifact_set_sha256", "ordinary_artifacts",
  "path_hash_secrecy_claim", "path_identity_hashes_retained", "policy", "prohibited_root_set_sha256", "publication_authorized",
  "raw_absolute_paths_retained", "relative_generation_paths_retained", "scope", "symlink_or_special_files_observed",
]);

export function generationProhibitedRootSetSha256(trustedProhibitedRoots = []) {
  return sha256(Buffer.from(`pdf-tools.generation-privacy-prohibited.v1\0${canonicalJson(trustedProhibitedRoots.map(item => sha256(Buffer.from(path.resolve(item)))).sort())}`));
}

export function verifyIndexedGenerationPrivacy({ index, privacyAttestation, privacyRole = "privacy_attestation" }) {
  exactKeys(privacyAttestation, GENERATION_PRIVACY_KEYS, "Generation privacy attestation");
  if (privacyAttestation.attestation_id !== "pdf-tools.extraction-phase1-generation-privacy.v1"
    || privacyAttestation.attestation_version !== 1 || !["public_synthetic", "private_local", "private_local_minimized"].includes(privacyAttestation.policy)
    || privacyAttestation.publication_authorized !== false || privacyAttestation.scope !== "ordinary_artifacts_before_privacy_attestation_and_index"
    || privacyAttestation.directory_mode !== 0o700 || privacyAttestation.file_mode !== 0o600
    || privacyAttestation.symlink_or_special_files_observed !== false || privacyAttestation.raw_absolute_paths_retained !== null
    || privacyAttestation.relative_generation_paths_retained !== true || privacyAttestation.path_identity_hashes_retained !== true
    || privacyAttestation.path_hash_secrecy_claim !== false || !/^[a-f0-9]{64}$/.test(privacyAttestation.prohibited_root_set_sha256)) {
    throw new Error("Generation privacy attestation has invalid or overstated claims");
  }
  const ordinary = index.artifacts.filter(item => item.role !== privacyRole);
  if (canonicalJson(ordinary) !== canonicalJson(privacyAttestation.ordinary_artifacts)
    || privacyAttestation.ordinary_artifact_set_sha256 !== sha256(Buffer.from(`pdf-tools.generation-privacy-files.v1\0${canonicalJson(ordinary)}`))) {
    throw new Error("Generation ordinary artifacts differ from privacy attestation scope");
  }
  return true;
}

export async function verifyFinalGenerationPrivacy({ generationPath, index, privacyAttestation, privacyRole = "privacy_attestation" }) {
  verifyIndexedGenerationPrivacy({ index, privacyAttestation, privacyRole });
  const realGeneration = await realDirectoryWithoutSymlinkAncestors(generationPath);
  const directoryStat = await fs.lstat(realGeneration);
  if ((directoryStat.mode & 0o777) !== privacyAttestation.directory_mode) throw new Error("Final generation directory mode differs from privacy attestation");
  const names = await fs.readdir(realGeneration);
  const expected = [...index.artifacts.map(item => item.path), "execution-index.v1.json"].sort();
  if (canonicalJson([...names].sort()) !== canonicalJson(expected)) throw new Error("Final generation file set differs from its index");
  for (const name of names) {
    const stat = await fs.lstat(path.join(realGeneration, name));
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== privacyAttestation.file_mode) throw new Error("Final generation contains an unsafe file identity or mode");
  }
  return true;
}

function validateSourceRecords(sourceBytesByRole) {
  if (!sourceBytesByRole || canonicalJson(Object.keys(sourceBytesByRole).sort()) !== canonicalJson([...PHASE1_COMPANION_SOURCE_ROLES])) {
    throw new Error("Execution companion requires the exact direct source and schema roles");
  }
  return PHASE1_COMPANION_SOURCE_ROLES.map(role => {
    const source = sourceBytesByRole[role];
    exactKeys(source, ["bytes", "path"], `Execution companion source ${role}`);
    if (!Buffer.isBuffer(source.bytes) || source.path !== PHASE1_COMPANION_SOURCE_PATHS[role]
      || path.isAbsolute(source.path) || source.path.includes("\\") || source.path.split("/").includes("..")) {
      throw new Error(`Execution companion source ${role} is unsafe`);
    }
    return { role, path: source.path, bytes: source.bytes.length, sha256: sha256(source.bytes) };
  });
}

function validateCommandEvidence(candidateId, command, label) {
  exactKeys(command, ["arguments", "bound_adapter_entrypoints", "candidate_id", "closure", "executable"], label);
  exactKeys(command.executable, ["bytes", "device", "inode", "mode", "realpath_sha256", "sha256"], `${label} executable`);
  if (command.candidate_id !== candidateId || command.closure !== "incomplete_nonclaiming"
    || !Number.isInteger(command.executable.bytes) || command.executable.bytes < 1
    || !Number.isInteger(command.executable.mode) || typeof command.executable.device !== "string" || !command.executable.device
    || typeof command.executable.inode !== "string" || !command.executable.inode
    || !/^[a-f0-9]{64}$/.test(command.executable.sha256) || !/^[a-f0-9]{64}$/.test(command.executable.realpath_sha256)
    || !Array.isArray(command.arguments) || command.arguments.length === 0
    || command.bound_adapter_entrypoints !== 1) throw new Error(`${label} is invalid`);
  let adapterEntrypoints = 0;
  for (const [index, argument] of command.arguments.entries()) {
    if (argument.kind === "literal") {
      exactKeys(argument, ["index", "kind", "value_sha256"], `${label} literal argument`);
      if (argument.index !== index || !/^[a-f0-9]{64}$/.test(argument.value_sha256)) throw new Error(`${label} literal argument is invalid`);
    } else if (argument.kind === "artifact") {
      exactKeys(argument, ["artifact_id", "artifact_role", "index", "kind", "sha256"], `${label} artifact argument`);
      if (argument.index !== index || typeof argument.artifact_id !== "string" || !argument.artifact_id
        || typeof argument.artifact_role !== "string" || !argument.artifact_role
        || !/^[a-f0-9]{64}$/.test(argument.sha256)) throw new Error(`${label} artifact argument is invalid`);
      if (argument.artifact_role === "adapter_entrypoint") adapterEntrypoints += 1;
    } else throw new Error(`${label} argument kind is invalid`);
  }
  if (adapterEntrypoints !== 1) throw new Error(`${label} must bind exactly one adapter entrypoint`);
}

export function createExecutionCompanion({
  report,
  reportBytes,
  failureEvidenceByAttemptKey,
  resourceFactsByAttemptKey,
  artifactAttestationByCandidateId,
  artifactConfigBindingByCandidateId,
  commandRuntimeByCandidateId,
  privacyEvidence,
  sourceBytesByRole,
  runnerEnvironmentAttestation,
}) {
  const expectedReportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  if (!Buffer.isBuffer(reportBytes) || !reportBytes.equals(expectedReportBytes)) {
    throw new Error("Execution companion report bytes differ from the trusted report object");
  }
  const expectedAttemptKeys = report.attempts.map(reportAttemptKey).sort();
  if (canonicalJson(Object.keys(failureEvidenceByAttemptKey).sort()) !== canonicalJson(expectedAttemptKeys)) throw new Error("Execution companion failure evidence does not cover the exact report denominator");
  const candidateIds = [...new Set(report.attempts.map(item => item.candidate_id))].sort();
  if (canonicalJson(Object.keys(artifactAttestationByCandidateId).sort()) !== canonicalJson(candidateIds)) throw new Error("Execution companion artifact evidence does not cover the exact candidate set");
  if (canonicalJson(Object.keys(artifactConfigBindingByCandidateId).sort()) !== canonicalJson(candidateIds)) throw new Error("Execution companion artifact configuration bindings do not cover the exact candidate set");
  if (canonicalJson(Object.keys(commandRuntimeByCandidateId).sort()) !== canonicalJson(candidateIds)) throw new Error("Execution companion command runtime evidence does not cover the exact candidate set");
  for (const [candidateId, evidence] of Object.entries(commandRuntimeByCandidateId)) {
    exactKeys(evidence, ["after", "before", "status"], `Command runtime evidence ${candidateId}`);
    const equal = canonicalJson(evidence.before) === canonicalJson(evidence.after);
    const validUnavailable = evidence.status === "unavailable" && evidence.before === null && evidence.after === null;
    const validUnchanged = evidence.status === "unchanged_incomplete_nonclaiming" && evidence.before !== null && evidence.after !== null && equal;
    const validChanged = evidence.status === "changed" && evidence.before !== null && (evidence.after === null || !equal);
    if (!validUnavailable && !validUnchanged && !validChanged) {
      throw new Error(`Command runtime evidence is invalid for ${candidateId}`);
    }
    if (evidence.before !== null) validateCommandEvidence(candidateId, evidence.before, `Command runtime before evidence ${candidateId}`);
    if (evidence.after !== null) validateCommandEvidence(candidateId, evidence.after, `Command runtime after evidence ${candidateId}`);
  }
  for (const [candidateId, binding] of Object.entries(artifactConfigBindingByCandidateId)) {
    exactKeys(binding, ["canonical_sha256", "raw_bytes", "raw_sha256", "redacted_config", "redacted_config_sha256"], `Artifact configuration binding ${candidateId}`);
    if (binding.redacted_config.candidate_id !== candidateId || binding.redacted_config_sha256 !== sha256(Buffer.from(canonicalJson(binding.redacted_config)))
      || canonicalJson(binding.redacted_config).includes('"path":') || !Number.isInteger(binding.raw_bytes) || binding.raw_bytes < 1
      || !/^[a-f0-9]{64}$/.test(binding.raw_sha256) || !/^[a-f0-9]{64}$/.test(binding.canonical_sha256)) {
      throw new Error(`Artifact configuration binding is invalid for ${candidateId}`);
    }
  }
  for (const [candidateId, attestation] of Object.entries(artifactAttestationByCandidateId)) {
    exactKeys(attestation, ["after", "before", "drift", "postcheck", "precheck"], `Artifact attestation ${candidateId}`);
    exactKeys(attestation.drift, ["after_inventory_self_sha256", "before_inventory_self_sha256", "status"], `Artifact drift ${candidateId}`);
    exactKeys(attestation.postcheck, ["error_code", "error_message_sha256", "status"], `Artifact postcheck ${candidateId}`);
    exactKeys(attestation.precheck, ["error_code", "error_message_sha256", "status"], `Artifact precheck ${candidateId}`);
    const precheckFailed = attestation.precheck.status === "failed";
    const postcheckFailed = attestation.postcheck.status === "failed";
    const commandChanged = commandRuntimeByCandidateId[candidateId].status === "changed";
    const changed = postcheckFailed || commandChanged || canonicalJson(attestation.before) !== canonicalJson(attestation.after);
    if ((!precheckFailed && attestation.before?.candidate_id !== candidateId) || (!postcheckFailed && attestation.after?.candidate_id !== candidateId)
      || attestation.drift.before_inventory_self_sha256 !== (attestation.before?.digests.inventory_self_sha256 ?? null)
      || attestation.drift.after_inventory_self_sha256 !== (attestation.after?.digests.inventory_self_sha256 ?? null)
      || attestation.drift.status !== (precheckFailed ? "precheck_failed" : postcheckFailed ? "postcheck_failed" : changed ? "changed" : "unchanged")
      || (precheckFailed && (attestation.before !== null || attestation.precheck.error_code === null || attestation.precheck.error_message_sha256 === null))
      || (!precheckFailed && (attestation.before === null || attestation.precheck.error_code !== null || attestation.precheck.error_message_sha256 !== null))
      || (postcheckFailed && (attestation.after !== null || attestation.postcheck.error_code === null || attestation.postcheck.error_message_sha256 === null))
      || (!postcheckFailed && (attestation.after === null || attestation.postcheck.error_code !== null || attestation.postcheck.error_message_sha256 !== null))
      || (precheckFailed && report.attempts.filter(item => item.candidate_id === candidateId).some(item => item.outcome !== "not_run" || !item.unmet_requirements.includes("artifact_precheck_failed")))
      || (!precheckFailed && changed && report.attempts.filter(item => item.candidate_id === candidateId).some(item => item.error_code !== "ARTIFACT_DRIFT"))) {
      throw new Error(`Artifact before/after proof is invalid for ${candidateId}`);
    }
  }
  const sources = validateSourceRecords(sourceBytesByRole);
  exactKeys(runnerEnvironmentAttestation, ["authenticity", "mcp_sdk", "node_executable", "package_lock_sha256", "pdf_lib", "pdfjs", "runtime_closure"], "Runner environment attestation");
  exactKeys(runnerEnvironmentAttestation.node_executable, ["bytes", "device", "inode", "mode", "realpath_sha256", "sha256"], "Runner Node executable attestation");
  exactKeys(runnerEnvironmentAttestation.mcp_sdk, ["package_json_sha256", "version"], "Runner MCP SDK attestation");
  exactKeys(runnerEnvironmentAttestation.pdf_lib, ["package_json_sha256", "version"], "Runner PDF library attestation");
  exactKeys(runnerEnvironmentAttestation.pdfjs, ["package_json_sha256", "version"], "Runner PDF.js attestation");
  const sourceByRole = Object.fromEntries(sources.map(item => [item.role, item]));
  if (runnerEnvironmentAttestation.authenticity !== "unavailable" || runnerEnvironmentAttestation.runtime_closure !== "incomplete"
    || runnerEnvironmentAttestation.package_lock_sha256 !== sourceByRole.package_lock.sha256
    || runnerEnvironmentAttestation.mcp_sdk.package_json_sha256 !== sourceByRole.mcp_sdk_package.sha256
    || runnerEnvironmentAttestation.pdf_lib.package_json_sha256 !== sourceByRole.pdf_lib_package.sha256
    || runnerEnvironmentAttestation.pdfjs.version !== "5.4.624"
    || runnerEnvironmentAttestation.pdfjs.package_json_sha256 !== sourceByRole.pdfjs_package.sha256
    || typeof runnerEnvironmentAttestation.mcp_sdk.version !== "string" || !runnerEnvironmentAttestation.mcp_sdk.version
    || !/^[a-f0-9]{64}$/.test(runnerEnvironmentAttestation.node_executable.sha256)) {
    throw new Error("Runner environment attestation is inconsistent with direct runtime sources");
  }
  const derivedResourceFacts = deriveRunnerResourceFacts(report, artifactAttestationByCandidateId);
  if (canonicalJson(resourceFactsByAttemptKey) !== canonicalJson(derivedResourceFacts)
    || canonicalJson(Object.keys(resourceFactsByAttemptKey).sort()) !== canonicalJson(expectedAttemptKeys)) throw new Error("Execution companion resource facts differ from the independent runner map");
  return {
    companion_id: PHASE1_EXECUTION_COMPANION_ID,
    companion_version: 1,
    report: {
      report_id: report.report_id,
      run_id: report.run_id,
      canonical_sha256: sha256(Buffer.from(canonicalJson(report))),
      raw_bytes: reportBytes.length,
      raw_sha256: sha256(reportBytes),
    },
    failure_evidence_by_attempt_key: structuredClone(failureEvidenceByAttemptKey),
    resource_facts_by_attempt_key: structuredClone(resourceFactsByAttemptKey),
    artifact_attestation_by_candidate_id: structuredClone(artifactAttestationByCandidateId),
    artifact_config_binding_by_candidate_id: structuredClone(artifactConfigBindingByCandidateId),
    command_runtime_by_candidate_id: structuredClone(commandRuntimeByCandidateId),
    privacy: structuredClone(privacyEvidence),
    host: {
      platform: report.environment.platform,
      architecture: report.environment.architecture,
      node_version: report.environment.node_version,
    },
    runtime: structuredClone(report.environment),
    runner_environment: structuredClone(runnerEnvironmentAttestation),
    limitations: structuredClone(report.limitations),
    direct_sources: sources,
    direct_source_set_sha256: sha256(Buffer.from(canonicalJson(sources))),
  };
}

export function verifyExecutionCompanion(companion, trusted) {
  const expected = createExecutionCompanion(trusted);
  if (canonicalJson(companion) !== canonicalJson(expected)) throw new Error("Execution companion differs from independently derived runner facts");
  return true;
}

export function createCrossDeviceReceipt({
  runId,
  indexBytes,
  sourceGenerationSha256,
  sourceHost,
  destinationHost,
  sourceCodeIdentity,
  transportedAt,
  transport,
  keyId = null,
  signature = null,
}) {
  const index = verifyCrossDeviceSourceIndex(indexBytes, runId);
  if (!/^[a-f0-9]{64}$/.test(sourceGenerationSha256)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sourceHost) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(destinationHost)
    || sourceHost === destinationHost || !["tailscale_tailnet", "verified_local_copy"].includes(transport)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(transportedAt) || !Number.isFinite(Date.parse(transportedAt))
    || (keyId === null) !== (signature === null)
    || (keyId !== null && (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(keyId) || !/^[A-Za-z0-9+/=_-]{16,4096}$/.test(signature)))) {
    throw new Error("Cross-device receipt inputs are invalid");
  }
  exactKeys(sourceCodeIdentity, ["kind", "sha256", "source_artifact_role"], "Cross-device source code identity");
  if (![
    "execution_direct_source_set_sha256",
    "score_scorer_local_source_set_sha256",
  ].includes(sourceCodeIdentity.kind) || !/^[a-f0-9]{64}$/.test(sourceCodeIdentity.sha256)
    || (sourceCodeIdentity.kind === "execution_direct_source_set_sha256" && sourceCodeIdentity.source_artifact_role !== "execution_companion")
    || (sourceCodeIdentity.kind === "score_scorer_local_source_set_sha256" && sourceCodeIdentity.source_artifact_role !== "score_provenance")) {
    throw new Error("Cross-device source code identity is invalid");
  }
  const authentic = keyId !== null && signature !== null;
  const receipt = {
    receipt_id: PHASE1_CROSS_DEVICE_RECEIPT_ID,
    receipt_version: 1,
    run_id: runId,
    index_raw_bytes: indexBytes.length,
    index_raw_sha256: sha256(indexBytes),
    index_content_sha256: index.index_content_sha256,
    source_generation_sha256: sourceGenerationSha256,
    source_host: sourceHost,
    destination_host: destinationHost,
    source_code_identity: structuredClone(sourceCodeIdentity),
    transported_at: transportedAt,
    transport,
    key_id: keyId,
    signature,
    authenticity: authentic ? "trusted_signer_required" : "unavailable",
    signed_payload_sha256: null,
  };
  receipt.signed_payload_sha256 = crossDeviceSignedPayloadSha256(receipt);
  return receipt;
}

const CROSS_DEVICE_RECEIPT_KEYS = Object.freeze([
  "authenticity", "destination_host", "index_content_sha256", "index_raw_bytes", "index_raw_sha256", "key_id",
  "receipt_id", "receipt_version", "run_id", "signature", "signed_payload_sha256", "source_code_identity", "source_generation_sha256",
  "source_host", "transport", "transported_at",
]);
const CROSS_DEVICE_INDEX_KEYS = Object.freeze([
  "artifacts", "claim_ready", "index_content_sha256", "index_id", "index_version", "kind", "run_id", "source_generation_sha256", "state", "transaction_id",
]);

function crossDeviceIndexContentSha256(index) {
  const { index_content_sha256: ignored, ...content } = index;
  return sha256(Buffer.from(`pdf-tools.extraction-phase1-execution-index.v1\0${canonicalJson(content)}`));
}

export function verifyCrossDeviceSourceIndex(indexBytes, runId) {
  if (!Buffer.isBuffer(indexBytes) || indexBytes.length === 0 || !/^[a-f0-9]{64}$/.test(runId)) throw new Error("Cross-device source index inputs are invalid");
  let index;
  try {
    index = JSON.parse(indexBytes);
  } catch {
    throw new Error("Cross-device source index is not JSON");
  }
  if (canonicalJson(Object.keys(index).sort()) !== canonicalJson([...CROSS_DEVICE_INDEX_KEYS].sort())
    || !indexBytes.equals(Buffer.from(`${JSON.stringify(index, null, 2)}\n`))
    || index.index_id !== "pdf-tools.extraction-phase1-execution-index.v1" || index.index_version !== 1
    || index.state !== "complete" || index.claim_ready !== false || index.run_id !== runId
    || !["execution", "score"].includes(index.kind) || !Array.isArray(index.artifacts) || index.artifacts.length === 0
    || (index.kind === "execution" ? index.source_generation_sha256 !== null : !/^[a-f0-9]{64}$/.test(index.source_generation_sha256))
    || index.index_content_sha256 !== crossDeviceIndexContentSha256(index)) throw new Error("Cross-device source index contract is invalid");
  return index;
}

function crossDeviceSignedPayloadSha256(receipt) {
  const { authenticity: ignoredAuthenticity, key_id: ignoredKey, signature: ignoredSignature, signed_payload_sha256: ignoredDigest, ...payload } = receipt;
  return sha256(Buffer.from(`pdf-tools.cross-device-receipt-signed-payload.v1\0${canonicalJson(payload)}`));
}

export function verifyCrossDeviceReceipt(receipt, {
  runId,
  indexBytes,
  sourceGenerationSha256,
  expectedSourceCodeIdentity,
  trustedSignatureVerifier = null,
}) {
  const index = verifyCrossDeviceSourceIndex(indexBytes, runId);
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || canonicalJson(Object.keys(receipt).sort()) !== canonicalJson([...CROSS_DEVICE_RECEIPT_KEYS].sort())
    || receipt.receipt_id !== PHASE1_CROSS_DEVICE_RECEIPT_ID || receipt.receipt_version !== 1 || receipt.run_id !== runId
    || receipt.index_raw_bytes !== indexBytes.length || receipt.index_raw_sha256 !== sha256(indexBytes)
    || receipt.index_content_sha256 !== index.index_content_sha256 || receipt.source_generation_sha256 !== sourceGenerationSha256
    || canonicalJson(receipt.source_code_identity) !== canonicalJson(expectedSourceCodeIdentity)
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(receipt.source_host) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(receipt.destination_host)
    || receipt.source_host === receipt.destination_host || !["tailscale_tailnet", "verified_local_copy"].includes(receipt.transport)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(receipt.transported_at) || !Number.isFinite(Date.parse(receipt.transported_at))
    || receipt.signed_payload_sha256 !== crossDeviceSignedPayloadSha256(receipt)) {
    throw new Error("Cross-device receipt is internally inconsistent with the retained index");
  }
  if (receipt.authenticity === "unavailable") {
    if (receipt.key_id !== null || receipt.signature !== null) throw new Error("Unsigned cross-device receipt contains signer fields");
    return { internally_consistent: true, authentic: false };
  }
  if (receipt.authenticity !== "trusted_signer_required" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(receipt.key_id)
    || !/^[A-Za-z0-9+/=_-]{16,4096}$/.test(receipt.signature)
    || typeof trustedSignatureVerifier !== "function") {
    throw new Error("Cross-device receipt authenticity is unverified");
  }
  const signatureResult = trustedSignatureVerifier({
    keyId: receipt.key_id,
    signature: receipt.signature,
    payloadSha256: receipt.signed_payload_sha256,
    receipt,
  });
  if (typeof signatureResult !== "boolean" || signatureResult !== true) throw new Error("Cross-device receipt authenticity is unverified");
  return { internally_consistent: true, authentic: true };
}
