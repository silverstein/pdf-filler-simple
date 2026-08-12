import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const OFFICIAL_SOURCE_HOSTS = new Set([
  "developers.openai.com",
  "learn.chatgpt.com",
  "modelcontextprotocol.io",
  "platform.claude.com",
  "support.claude.com",
  "tasks.extensions.modelcontextprotocol.io",
]);

const REQUIRED_MODES = new Set([
  "local_only",
  "remote_only",
  "hybrid_explicit_handoff",
  "cowork_host_folder_bridge",
  "cowork_host_desktop_brokered_local_connector",
]);

const REQUIRED_CONTROL_GROUPS = new Set([
  "authentication",
  "authorization",
  "tenancy",
  "upload",
  "storage_and_retention",
  "mutation",
  "async_jobs",
  "outputs",
  "operations",
]);

const REQUIRED_THREATS = new Set(
  Array.from(
    { length: 16 },
    (_, index) => `T${String(index + 1).padStart(2, "0")}`,
  ),
);

const REQUIRED_FLIP_GATES = new Set(
  Array.from(
    { length: 10 },
    (_, index) => `G${String(index + 1).padStart(2, "0")}`,
  ),
);

const REQUIRED_FORBIDDEN_CLAIMS = new Set([
  "the_current_mcpb_works_in_cowork_remote_sessions",
  "one_bundle_installs_across_all_hosts",
  "mcp_apps_or_tasks_are_supported_by_every_target_host",
  "remote_processing_keeps_document_bytes_on_device",
  "connected_folder_permission_is_pdf_tools_upload_consent",
  "architecture_or_local_mock_evidence_is_a_shipped_remote_service",
  "cancelled_task_means_document_bytes_are_deleted",
  "sha256_or_opaque_ids_replace_authorization",
  "host_approval_replaces_server_authorization",
]);

const REQUIRED_TRANCHE_PROHIBITIONS = new Set([
  "deployment",
  "public_listener",
  "provider_account_mutation",
  "production_storage_creation",
  "user_document_upload",
  "user_data_egress",
  "release",
  "tag",
  "public_compatibility_announcement",
]);

const REQUIRED_ALLOWED_OPERATIONS = new Set([
  "server/discover",
  "tools/list",
  "create_synthetic_workspace",
  "register_synthetic_document_identity",
  "simulate_identity_bound_mutation",
  "read_operation_receipt",
  "simulate_delete_lifecycle",
]);

const REQUIRED_EXCLUDED_OPERATIONS = new Set([
  "listen_on_public_interface",
  "provider_deployment",
  "oauth_provider_creation_or_mutation",
  "real_user_authentication",
  "user_document_upload",
  "user_document_processing",
  "external_download",
  "production_storage",
  "local_companion_installation",
]);

const REQUIRED_SUCCESS_CRITERIA = new Set([
  "every_request_is_identity_and_tenant_scoped",
  "missing_or_wrong_auth_context_fails_closed",
  "origin_present_invalid_fails_403_and_missing_reaches_authentication",
  "header_body_mismatch_fails_closed",
  "upload_without_explicit_event_fails_closed",
  "mutation_without_exact_source_identity_fails_closed",
  "retry_is_idempotent",
  "cross_tenant_access_fails_closed",
  "delete_state_is_distinct_from_physical_purge",
  "receipts_bind_source_and_output_identity",
  "no_network_egress",
]);

const REQUIRED_ARCHITECTURE_SECTIONS = [
  "## Decision",
  "## Protocol target",
  "## Principals and authority",
  "## Document identity and versioning",
  "## Data flows",
  "### Local only",
  "### Remote only",
  "### Hybrid explicit handoff",
  "### Cowork connected-folder bridge",
  "### Cowork Desktop-brokered local connector",
  "## Authentication and authorization",
  "## Storage, retention, and deletion",
  "## Upload, mutation, and export",
  "## Long-running work and Tasks",
  "## MCP Apps review and approval",
  "## Threat priorities",
  "## Smallest safe vertical slice",
  "## Production flip gates",
  "## Implementation ownership",
  "## Sources",
];

// Changing any digest requires an explicit verifier diff. The complete
// canonical JSON objects and exact Markdown bytes are frozen, so unknown
// authority-looking fields cannot bypass review.
const FROZEN_AUTHORITY_DIGESTS = Object.freeze({
  contract: "3783deb63beeb1fe48aa545ca58db861864ccb794a2c8fcc156f06a5b3999627",
  ledger: "ec610ad00ceabcee3625ba5483e676a55320001cec098f307e2dc078fc34b03e",
  architecture: "8be4894f05ad8bdeeb0fac1ed23d8aaf3801166bb0e8bbb5b6d2165122c6b46f",
});

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function sha256Json(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function computeAuthorityDigests(
  contract,
  ledger,
  architectureDocument,
) {
  return {
    contract: sha256Json(contract),
    ledger: sha256Json(ledger),
    architecture: sha256Text(architectureDocument),
  };
}

function exactSet(actual, expected, label) {
  assert(Array.isArray(actual), `${label} must be an array`);
  assert.equal(
    new Set(actual).size,
    actual.length,
    `${label} must not contain duplicates`,
  );
  assert.deepEqual(new Set(actual), expected, `${label} set mismatch`);
}

function includesAll(actual, expected, label) {
  assert(Array.isArray(actual), `${label} must be an array`);
  for (const value of expected) {
    assert(actual.includes(value), `${label} missing ${value}`);
  }
}

function nonemptyString(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert(value.trim().length > 0, `${label} must not be empty`);
}

function uniqueRecords(records, key, label) {
  assert(Array.isArray(records), `${label} must be an array`);
  const values = records.map(record => record[key]);
  assert(values.every(Boolean), `${label} entries must define ${key}`);
  assert.equal(
    new Set(values).size,
    values.length,
    `${label} entries must have unique ${key}`,
  );
  return new Map(records.map(record => [record[key], record]));
}

function verifyFrozenDigests(contract, ledger, architectureDocument) {
  const observed = computeAuthorityDigests(
    contract,
    ledger,
    architectureDocument,
  );
  assert.equal(
    observed.contract,
    FROZEN_AUTHORITY_DIGESTS.contract,
    "authority-sensitive contract digest mismatch",
  );
  assert.equal(
    observed.ledger,
    FROZEN_AUTHORITY_DIGESTS.ledger,
    "authority-sensitive ledger digest mismatch",
  );
  assert.equal(
    observed.architecture,
    FROZEN_AUTHORITY_DIGESTS.architecture,
    "architecture decision digest mismatch",
  );
  return observed;
}

function verifySourceLedger(ledger, contract) {
  assert.equal(
    ledger.schema_version,
    "pdf-tools.remote-hybrid-host-capabilities.v1",
  );
  assert.equal(ledger.as_of, contract.as_of);
  nonemptyString(ledger.claim_boundary, "ledger claim_boundary");
  assert.match(
    ledger.claim_boundary,
    /not evidence that this exact PDF Tools/i,
    "ledger must deny exact-artifact inference",
  );
  assert.match(
    ledger.claim_boundary,
    /Rows marked unverified remain unverified/i,
    "ledger must preserve unverified rows",
  );
  assert.equal(
    ledger.retrieval_receipt.observed_final_url_status,
    "18_of_18_http_200",
  );
  assert.match(
    ledger.retrieval_receipt.limitation,
    /do not.*automate source truth/i,
    "retrieval receipt must deny automated source truth",
  );

  const sources = uniqueRecords(ledger.sources, "id", "sources");
  assert.equal(sources.size, 18, "source ledger must retain 18 sources");
  for (const source of sources.values()) {
    nonemptyString(source.publisher, `source ${source.id} publisher`);
    nonemptyString(source.title, `source ${source.id} title`);
    const url = new URL(source.url);
    assert.equal(url.protocol, "https:", `source ${source.id} must use HTTPS`);
    assert(
      OFFICIAL_SOURCE_HOSTS.has(url.hostname),
      `source ${source.id} is not on an allowed official host`,
    );
    assert(
      Array.isArray(source.supports) && source.supports.length > 0,
      `source ${source.id} must declare supported claims`,
    );
    source.supports.forEach((claim, index) =>
      nonemptyString(claim, `source ${source.id} claim ${index}`));
  }

  const receipts = uniqueRecords(
    ledger.manual_review_receipts,
    "source_id",
    "manual_review_receipts",
  );
  exactSet(
    [...receipts.keys()],
    new Set(sources.keys()),
    "manual review source IDs",
  );
  for (const receipt of receipts.values()) {
    assert.equal(receipt.verdict, "supports_bounded_claims");
    assert(
      Array.isArray(receipt.relevant_sections) &&
        receipt.relevant_sections.length > 0,
      `manual review ${receipt.source_id} needs relevant sections`,
    );
  }

  const hosts = uniqueRecords(ledger.hosts, "id", "hosts");
  const requiredHosts = [
    "claude-desktop-local-chat",
    "claude-cowork-remote-session",
    "claude-custom-remote-connector",
    "chatgpt-web-work",
    "codex-local-host",
    "codex-cloud",
    "generic_mcp-2026-07-28-remote-client",
  ];
  requiredHosts.forEach(hostId =>
    assert(hosts.has(hostId), `missing required host ${hostId}`));
  for (const host of hosts.values()) {
    nonemptyString(host.connection, `host ${host.id} connection`);
    nonemptyString(host.document_custody, `host ${host.id} document_custody`);
    nonemptyString(host.status, `host ${host.id} status`);
    assert(
      Array.isArray(host.source_ids) && host.source_ids.length > 0,
      `host ${host.id} needs source_ids`,
    );
    host.source_ids.forEach(sourceId =>
      assert(
        sources.has(sourceId),
        `host ${host.id} has unknown source ${sourceId}`,
      ));
  }
  const cowork = hosts.get("claude-cowork-remote-session");
  assert.equal(cowork.local_mcp_directly_in_session, false);
  assert.equal(cowork.local_mcp_inside_remote_sandbox, false);
  assert.equal(
    cowork.desktop_brokered_local_connector_or_plugin_mcp,
    "documented_host_path_exact_pdf_tools_mcpb_requires_native_host_proof",
  );
  assert.equal(hosts.get("chatgpt-web-work").local_codex_config_available, false);
  assert.equal(
    hosts.get("codex-cloud").remote_mcp_for_exact_pdf_tools,
    "not_established_by_current_sources",
  );

  const conclusions = uniqueRecords(
    ledger.cross_host_conclusions,
    "id",
    "cross_host_conclusions",
  );
  exactSet(
    [...conclusions.keys()],
    new Set(["C01", "C02", "C03", "C04", "C05", "C06"]),
    "cross-host conclusion IDs",
  );
  for (const conclusion of conclusions.values()) {
    nonemptyString(conclusion.conclusion, `conclusion ${conclusion.id}`);
    assert(
      Array.isArray(conclusion.source_ids) &&
        conclusion.source_ids.length > 0,
      `conclusion ${conclusion.id} needs source IDs`,
    );
    conclusion.source_ids.forEach(sourceId =>
      assert(
        sources.has(sourceId),
        `conclusion ${conclusion.id} has unknown source ${sourceId}`,
      ));
  }
}

function verifyArchitectureDocument(documentText, contract, digests) {
  nonemptyString(documentText, "architecture document");
  assert(
    documentText.startsWith(
      "# Remote and hybrid PDF Tools architecture decision\n",
    ),
    "architecture document heading mismatch",
  );
  assert.match(documentText, /Bead `pdf-toolkit-mcp-22v\.2`/);
  assert.match(documentText, /\*\*GO CONTINUE\*\*/);
  assert.match(documentText, /\*\*WAIT\*\*/);
  assert.match(documentText, /\*\*GO, LOCAL MOCK ONLY\*\*/);
  assert.match(
    documentText,
    /not a deployed service, a native host\s+result/i,
    "architecture document must deny deployment and native-host evidence",
  );
  assert.match(
    documentText,
    /documented hosted ChatGPT\s+Work surface/i,
    "architecture document must qualify the hosted ChatGPT Work surface",
  );
  assert.match(
    documentText,
    /local MCP\s+executes on the desktop side and does not run inside the remote sandbox/i,
    "architecture document must preserve the brokered local MCP boundary",
  );
  assert.match(
    documentText,
    /Folder access does not imply upload consent/i,
    "architecture document must deny inferred upload consent",
  );
  assert.match(
    documentText,
    /Host tool approvals.*not the service authorization boundary/is,
    "architecture document must preserve server authorization",
  );
  assert.match(
    documentText,
    /JSON contract is normative for those slice choices/i,
    "architecture document must identify the machine contract as normative",
  );
  assert.match(
    documentText,
    /does not automate source truth/i,
    "architecture document must deny automated source truth",
  );
  assert.match(
    documentText,
    /It explicitly excludes a public listener, provider deployment, OAuth provider\s+mutation, real authentication, user files, production storage, external\s+downloads, or local companion installation\./,
    "architecture document must preserve the mock-only exclusion boundary",
  );
  assert.doesNotMatch(
    documentText,
    /deploy publicly|production service is ready|accept real user PDFs/i,
    "architecture document contains unsafe production language",
  );
  for (const section of REQUIRED_ARCHITECTURE_SECTIONS) {
    assert(
      documentText.includes(`${section}\n`),
      `architecture document missing section ${section}`,
    );
  }
  assert(
    documentText.includes(contract.source_ledger.split("/").at(-1)),
    "architecture document must link its source ledger",
  );
  assert(
    documentText.includes("config/remote-hybrid-trust-boundary.v1.json"),
    "architecture document must link its machine contract",
  );
  assert(
    documentText.includes(
      `Normative contract authority digest: \`sha256:${digests.contract}\`.`,
    ),
    "architecture document contract digest mismatch",
  );
  assert(
    !documentText.includes("\u2014"),
    "architecture document must not use an em dash",
  );
}

export function verifyRemoteHybridArchitecture(
  contract,
  ledger,
  architectureDocument,
) {
  assert.equal(
    contract.schema_version,
    "pdf-tools.remote-hybrid-trust-boundary.v1",
  );
  assert.equal(contract.as_of, "2026-07-30");
  nonemptyString(contract.claim_boundary, "contract claim_boundary");
  assert.match(contract.claim_boundary, /not a deployed service/i);
  assert.match(contract.claim_boundary, /not.*native-host result/i);
  assert.equal(
    contract.source_ledger,
    "docs/evidence/remote-hybrid-host-capabilities-2026-07-30.json",
  );
  assert.equal(
    contract.architecture_decision,
    "docs/REMOTE_HYBRID_ARCHITECTURE_2026-07-30.md",
  );

  const local = contract.protocol_baselines.local_mcpb;
  assert.equal(local.mcpb_version, "2.1.2");
  assert.equal(local.mcp_sdk_package, "@modelcontextprotocol/sdk");
  assert.equal(local.mcp_sdk_line, "v1");
  assert.equal(local.status, "continue_without_remote_conflation");

  const remote = contract.protocol_baselines.remote_target;
  assert.equal(remote.protocol_version, "2026-07-28");
  assert.equal(remote.transport, "streamable_http");
  assert.equal(remote.status, "architecture_target_not_implemented");
  assert.equal(remote.protocol_sessions, false);
  assert.equal(remote.initialize_handshake, false);
  exactSet(
    remote.required_request_headers,
    new Set(["MCP-Protocol-Version", "Mcp-Method"]),
    "remote required_request_headers",
  );
  exactSet(
    remote.conditional_request_headers,
    new Set(["Mcp-Name"]),
    "remote conditional_request_headers",
  );
  exactSet(
    remote.required_accept_media_types,
    new Set(["application/json", "text/event-stream"]),
    "remote required_accept_media_types",
  );
  exactSet(
    remote.required_body_meta_fields,
    new Set([
      "io.modelcontextprotocol/protocolVersion",
      "io.modelcontextprotocol/clientInfo.name",
      "io.modelcontextprotocol/clientInfo.version",
      "io.modelcontextprotocol/clientCapabilities",
    ]),
    "remote required_body_meta_fields",
  );
  includesAll(
    remote.server_validations,
    [
      "origin_when_present_validated_before_dispatch",
      "header_values_match_authoritative_body",
      "accept_includes_both_required_media_types",
      "authentication_before_application_operation",
    ],
    "remote server_validations",
  );
  assert.deepEqual(remote.origin_policy, {
    missing: "allow_then_continue_authentication_and_request_validation",
    present_invalid: "reject_403",
    present_null: "reject_403",
    present_multiple: "reject_403",
    present_allowed: "exact_allowlist_only",
    dns_rebinding_negative_tests: true,
  });

  const tasks = contract.protocol_baselines.tasks_extension;
  assert.equal(tasks.extension_id, "io.modelcontextprotocol/tasks");
  assert.equal(tasks.lifecycle_status, "experimental");
  assert.equal(
    tasks.specification_revision,
    "draft_at_git_commit_2c1425d9a288b9b1f489430fe1e00bb392b47e48",
  );
  assert.equal(
    tasks.retrieved_content_sha256,
    "47323a5cce67ffd0e366cf53cf4462260c647c05d850a30a9a6cec9a37b44a20",
  );
  assert.equal(
    tasks.fresh_revision_and_schema_review_required_before_implementation,
    true,
  );
  assert.equal(tasks.forbid_unscoped_list, true);
  exactSet(
    tasks.required_operations,
    new Set(["tasks/get", "tasks/update", "tasks/cancel"]),
    "tasks required_operations",
  );
  assert.equal(
    contract.protocol_baselines.apps_extension.fallback_required,
    "tool_workflow_without_ui",
  );

  assert.equal(contract.decisions.local_product.verdict, "GO_CONTINUE");
  assert.equal(contract.decisions.remote_production_service.verdict, "WAIT");
  assert.equal(
    contract.decisions.bounded_vertical_slice.verdict,
    "GO_LOCAL_MOCK_ONLY",
  );

  const principals = uniqueRecords(contract.principals, "id", "principals");
  exactSet(
    [...principals.keys()],
    new Set([
      "resource_owner",
      "host_mcp_client",
      "remote_resource_server",
      "authorization_server",
      "document_worker",
      "local_companion",
    ]),
    "principal IDs",
  );
  assert.equal(
    principals.get("local_companion").status,
    "not_selected_or_implemented",
  );
  assert(
    principals
      .get("local_companion")
      .must_not.includes("infer_upload_consent_from_folder_access"),
  );

  assert.equal(contract.document_identity.tenant_binding_required, true);
  assert.equal(contract.document_identity.path_is_not_remote_identity, true);
  includesAll(
    contract.document_identity.mutation_precondition,
    [
      "tenant",
      "workspace_id",
      "document_id",
      "input_byte_length",
      "input_sha256",
      "verified_actor_id",
      "tool_name",
      "tool_version",
      "canonical_arguments_sha256",
      "destination_and_effects",
      "authorization_or_approval_record_id",
      "policy_version",
      "operation_id",
      "idempotency_key",
      "explicit_current_authorization",
    ],
    "mutation_precondition",
  );
  includesAll(
    contract.document_identity.output_receipt,
    [
      "verified_actor_id",
      "source_identity",
      "output_sha256",
      "canonical_arguments_sha256",
      "authorization_or_approval_record_id",
      "policy_version",
      "policy_result",
    ],
    "output_receipt",
  );

  const modes = uniqueRecords(contract.modes, "id", "modes");
  exactSet([...modes.keys()], REQUIRED_MODES, "modes");
  assert.equal(modes.get("local_only").network_egress_of_document_bytes, false);
  for (const modeId of [
    "remote_only",
    "hybrid_explicit_handoff",
    "cowork_host_folder_bridge",
    "cowork_host_desktop_brokered_local_connector",
  ]) {
    assert.equal(
      modes.get(modeId).network_egress_of_document_bytes,
      true,
      `${modeId} must disclose document or result egress`,
    );
    nonemptyString(
      modes.get(modeId).required_consent_event,
      `${modeId} required_consent_event`,
    );
  }
  for (const modeId of ["remote_only", "hybrid_explicit_handoff"]) {
    const allowedInputs = modes.get(modeId).allowed_inputs;
    assert(
      Array.isArray(allowedInputs) && allowedInputs.length > 0,
      `${modeId} allowed_inputs must not be empty`,
    );
    assert(
      allowedInputs.every(value => value.includes("synthetic")),
      `${modeId} inputs must remain synthetic`,
    );
  }
  includesAll(
    modes.get("hybrid_explicit_handoff").forbidden_shortcuts,
    [
      "remote_connector_calls_local_mcp_directly",
      "folder_permission_implies_upload_permission",
      "ambient_shared_directory_sync",
    ],
    "hybrid forbidden_shortcuts",
  );
  assert(
    modes
      .get("cowork_host_folder_bridge")
      .must_not_be_described_as.includes("document_stays_on_device"),
  );
  assert.equal(
    modes.get("cowork_host_desktop_brokered_local_connector").status,
    "documented_host_path_exact_pdf_tools_mcpb_unverified",
  );

  exactSet(
    Object.keys(contract.required_controls),
    REQUIRED_CONTROL_GROUPS,
    "required_controls groups",
  );
  for (const [group, controls] of Object.entries(contract.required_controls)) {
    assert(
      Array.isArray(controls) && controls.length >= 3,
      `${group} must retain at least three controls`,
    );
    assert.equal(
      new Set(controls).size,
      controls.length,
      `${group} controls must be unique`,
    );
  }
  includesAll(
    contract.required_controls.authentication,
    [
      "origin_when_present_validated_with_non_browser_absence_allowed",
    ],
    "authentication controls",
  );
  includesAll(
    contract.required_controls.outputs,
    [
      "download_grant_single_use_nonce_atomically_consumed",
      "download_replay_concurrent_double_redeem_wrong_object_wrong_actor_and_wrong_audience_negative_tests",
    ],
    "output controls",
  );
  includesAll(
    contract.required_controls.mutation,
    [
      "same_key_different_arguments_rejected",
      "operation_and_canonical_arguments_bound_to_authorization_task_and_receipt",
      "membership_and_action_authorization_rechecked_at_dequeue_pre_activation_and_release",
    ],
    "mutation controls",
  );

  const threats = uniqueRecords(
    contract.threat_register,
    "id",
    "threat_register",
  );
  exactSet([...threats.keys()], REQUIRED_THREATS, "threat_register IDs");
  assert(
    [...threats.values()].filter(threat => threat.severity === "P0").length >=
      9,
    "threat register must retain at least nine P0 threats",
  );
  for (const threat of threats.values()) {
    assert(["P0", "P1"].includes(threat.severity));
    nonemptyString(threat.threat, `threat ${threat.id}`);
    nonemptyString(threat.required_gate, `threat ${threat.id} required_gate`);
  }

  const slice = contract.bounded_vertical_slice;
  assert.equal(slice.environment, "loopback_only_local_mock");
  assert.match(slice.data, /synthetic/i);
  exactSet(
    slice.allowed_operations,
    REQUIRED_ALLOWED_OPERATIONS,
    "vertical slice allowed_operations",
  );
  exactSet(
    slice.excluded_operations,
    REQUIRED_EXCLUDED_OPERATIONS,
    "vertical slice excluded_operations",
  );
  exactSet(
    slice.success_criteria,
    REQUIRED_SUCCESS_CRITERIA,
    "vertical slice success_criteria",
  );
  assert(
    slice.allowed_operations.every(
      operation => !slice.excluded_operations.includes(operation),
    ),
    "vertical slice allowed and excluded operations must be disjoint",
  );
  assert.deepEqual(slice.listener_enforcement, {
    bind_host: "127.0.0.1",
    port: "ephemeral_test_selected",
    bind_all_interfaces_forbidden: true,
    assert_observed_local_address: "127.0.0.1",
    assert_non_loopback_connection_refused: true,
  });
  assert.equal(
    slice.no_egress_enforcement.assert_attempted_external_connections,
    0,
  );
  assert.equal(slice.no_egress_enforcement.assert_imported_provider_sdks, 0);
  exactSet(
    slice.request_envelope.required_headers.Accept,
    new Set(["application/json", "text/event-stream"]),
    "mock Accept media types",
  );
  assert.equal(
    slice.request_envelope.required_headers.Origin,
    undefined,
    "Origin must not be required from non-browser clients",
  );
  assert.equal(
    slice.request_envelope.optional_headers.Origin,
    "when_present_must_match_exact_test_allowlist",
  );
  assert.deepEqual(slice.request_envelope.origin_test_cases, {
    missing: "continue_to_authentication_and_request_validation",
    allowed_exact: "continue_to_authentication_and_request_validation",
    invalid: "reject_403_before_json_rpc_dispatch",
    null: "reject_403_before_json_rpc_dispatch",
    multiple: "reject_403_before_json_rpc_dispatch",
  });
  exactSet(
    slice.request_envelope.required_body_meta,
    new Set([
      "io.modelcontextprotocol/protocolVersion",
      "io.modelcontextprotocol/clientInfo.name",
      "io.modelcontextprotocol/clientInfo.version",
      "io.modelcontextprotocol/clientCapabilities",
    ]),
    "mock request body metadata",
  );
  exactSet(
    slice.synthetic_auth_contexts.map(context => context.id),
    new Set([
      "anonymous",
      "tenant_a_owner",
      "tenant_a_collaborator",
      "tenant_b_owner",
      "tenant_b_same_actor",
      "tenant_a_revoked",
    ]),
    "synthetic auth contexts",
  );
  exactSet(
    Object.keys(slice.record_schemas),
    new Set([
      "workspace",
      "document",
      "version",
      "authorization_event",
      "operation",
      "receipt",
      "lifecycle_event",
    ]),
    "mock record schemas",
  );
  assert.equal(
    slice.idempotency_contract.same_key_different_request,
    "tool_error_IDEMPOTENCY_CONFLICT_with_no_effect",
  );
  assert.equal(
    slice.error_semantics.present_invalid_null_or_multiple_origin,
    "http_403_before_json_rpc_dispatch",
  );
  assert.equal(
    slice.error_semantics.missing_origin,
    "continue_to_authentication_and_request_validation",
  );

  const gates = uniqueRecords(
    contract.production_flip_gates,
    "id",
    "production_flip_gates",
  );
  exactSet([...gates.keys()], REQUIRED_FLIP_GATES, "production flip gate IDs");
  for (const gate of gates.values()) {
    nonemptyString(gate.gate, `gate ${gate.id}`);
    nonemptyString(gate.evidence, `gate ${gate.id} evidence`);
    assert.doesNotMatch(
      gate.evidence,
      /trust us|self-attested without tests/i,
      `gate ${gate.id} evidence is not objective`,
    );
  }

  exactSet(
    contract.forbidden_claims,
    REQUIRED_FORBIDDEN_CLAIMS,
    "forbidden_claims",
  );
  exactSet(
    contract.forbidden_actions_for_this_tranche,
    REQUIRED_TRANCHE_PROHIBITIONS,
    "forbidden_actions_for_this_tranche",
  );

  verifySourceLedger(ledger, contract);
  const observedDigests = computeAuthorityDigests(
    contract,
    ledger,
    architectureDocument,
  );
  verifyArchitectureDocument(
    architectureDocument,
    contract,
    observedDigests,
  );
  const digests = verifyFrozenDigests(
    contract,
    ledger,
    architectureDocument,
  );

  return {
    schema_version: "pdf-tools.remote-hybrid-architecture-verification.v1",
    as_of: contract.as_of,
    verdict: "GO_ARCHITECTURE_WAIT_PRODUCTION",
    verification_scope:
      "normative_contract_and_manually_reviewed_source_ledger_consistency",
    source_truth_automated: false,
    authority_digests: digests,
    inventory: {
      modes: modes.size,
      principals: principals.size,
      controls: Object.values(contract.required_controls).reduce(
        (sum, controls) => sum + controls.length,
        0,
      ),
      threats: threats.size,
      p0_threats: [...threats.values()].filter(
        threat => threat.severity === "P0",
      ).length,
      production_flip_gates: gates.size,
      official_sources: ledger.sources.length,
      hosts: ledger.hosts.length,
    },
    negative_claims: {
      deployed_service: false,
      native_host_evidence: false,
      user_document_processing: false,
      universal_host_compatibility: false,
    },
  };
}

async function readJson(relativePath) {
  return JSON.parse(
    await fs.readFile(path.join(repoRoot, relativePath), "utf8"),
  );
}

async function runSelfTest(contract, ledger, architectureDocument) {
  const contractMutants = [
    value => {
      value.production_authorized = true;
    },
    value => {
      value.protocol_baselines.remote_target.origin_policy.missing =
        "reject_403";
    },
    value => {
      value.claim_boundary +=
        " This is a deployed service and native-host result.";
    },
    value => {
      value.decisions.remote_production_service.verdict = "GO";
    },
    value => {
      value.required_controls.authentication = [];
    },
    value => {
      value.modes.find(mode => mode.id === "remote_only")
        .required_consent_event = "implicit";
    },
    value => {
      value.modes.find(mode => mode.id === "hybrid_explicit_handoff")
        .forbidden_shortcuts = [];
    },
    value => {
      value.principals.find(principal => principal.id === "local_companion")
        .must_not = [];
    },
    value => {
      value.required_controls.outputs = ["reusable_download_url"];
    },
    value => {
      value.document_identity.content_identity = [];
    },
    value => {
      value.document_identity.output_receipt = [];
    },
    value => {
      value.bounded_vertical_slice.allowed_operations.push(
        "user_document_upload",
      );
    },
    value => {
      value.threat_register.find(threat => threat.id === "T09")
        .required_gate = "log_the_download";
    },
    value => {
      value.production_flip_gates.find(gate => gate.id === "G05")
        .evidence = "trust us";
    },
    value => {
      value.protocol_baselines.tasks_extension.lifecycle_status = "universal";
    },
    value => {
      value.protocol_baselines.apps_extension.portable_bridge = "ambient_dom";
    },
    value => {
      value.bounded_vertical_slice.idempotency_contract
        .same_key_different_request = "reuse_prior_result";
    },
    value => {
      value.modes.find(mode => mode.id === "remote_only").allowed_inputs = [];
    },
  ];
  const ledgerMutants = [
    value => {
      value.authoritative_unreviewed_sources = true;
    },
    value => {
      value.claim_boundary +=
        " Exact PDF Tools works in every listed host.";
    },
    value => {
      value.source_policy =
        "Unreviewed blogs and social posts are authoritative.";
    },
    value => {
      value.sources[0].url = "https://example.com/not-primary";
    },
    value => {
      value.sources[0].supports = ["invented production compatibility"];
    },
    value => {
      value.hosts.find(host => host.id === "claude-cowork-remote-session")
        .status = "exact_pdf_tools_verified";
    },
    value => {
      value.cross_host_conclusions[0].conclusion =
        "One bundle works everywhere.";
    },
    value => {
      value.cross_host_conclusions[0].source_ids = [];
    },
    value => {
      value.manual_review_receipts.pop();
    },
  ];
  const documentMutants = [
    value =>
      `${value}\nThe team may launch an internet-accessible service and ingest customer documents in this tranche.\n`,
    value => value.replace(
      "Folder access does not imply upload consent.",
      "Folder access permits upload.",
    ),
    value => value.replace(
      "It explicitly excludes a public listener, provider deployment, OAuth provider\nmutation, real authentication, user files, production storage, external\ndownloads, or local companion installation.",
      "Deploy publicly and accept real user PDFs.",
    ),
  ];

  for (const mutate of contractMutants) {
    const candidate = structuredClone(contract);
    mutate(candidate);
    assert.throws(
      () =>
        verifyRemoteHybridArchitecture(
          candidate,
          ledger,
          architectureDocument,
        ),
      /./,
      "contract mutant unexpectedly passed",
    );
  }
  for (const mutate of ledgerMutants) {
    const candidate = structuredClone(ledger);
    mutate(candidate);
    assert.throws(
      () =>
        verifyRemoteHybridArchitecture(
          contract,
          candidate,
          architectureDocument,
        ),
      /./,
      "ledger mutant unexpectedly passed",
    );
  }
  for (const mutate of documentMutants) {
    assert.throws(
      () =>
        verifyRemoteHybridArchitecture(contract, ledger, mutate(
          architectureDocument,
        )),
      /./,
      "architecture-document mutant unexpectedly passed",
    );
  }
  return contractMutants.length + ledgerMutants.length + documentMutants.length;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  try {
    const contract = await readJson(
      "config/remote-hybrid-trust-boundary.v1.json",
    );
    const ledger = await readJson(contract.source_ledger);
    const architectureDocument = await fs.readFile(
      path.join(repoRoot, contract.architecture_decision),
      "utf8",
    );
    const report = verifyRemoteHybridArchitecture(
      contract,
      ledger,
      architectureDocument,
    );
    if (process.argv.includes("--self-test")) {
      report.adversarial_mutants_rejected = await runSelfTest(
        contract,
        ledger,
        architectureDocument,
      );
    }
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(`[verify-remote-hybrid-architecture] ${error.message}`);
    process.exitCode = 1;
  }
}
