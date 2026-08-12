import crypto from "node:crypto";

export const SYNTHETIC_AUTH_CONTEXTS = Object.freeze({
  anonymous: Object.freeze({
    id: "anonymous",
    verified_actor_id: null,
    tenant_id: null,
    scopes: Object.freeze([]),
    membership: "active",
  }),
  tenant_a_owner: Object.freeze({
    id: "tenant_a_owner",
    verified_actor_id: "synthetic_actor_a",
    tenant_id: "synthetic_tenant_a",
    scopes: Object.freeze([
      "workspace:create",
      "document:register",
      "document:mutate",
      "document:read",
      "document:delete",
    ]),
    membership: "active",
  }),
  tenant_a_collaborator: Object.freeze({
    id: "tenant_a_collaborator",
    verified_actor_id: "synthetic_actor_b",
    tenant_id: "synthetic_tenant_a",
    scopes: Object.freeze([
      "workspace:create",
      "document:register",
      "document:mutate",
      "document:read",
      "document:delete",
    ]),
    membership: "active",
  }),
  tenant_b_owner: Object.freeze({
    id: "tenant_b_owner",
    verified_actor_id: "synthetic_actor_b",
    tenant_id: "synthetic_tenant_b",
    scopes: Object.freeze([
      "workspace:create",
      "document:register",
      "document:mutate",
      "document:read",
      "document:delete",
    ]),
    membership: "active",
  }),
  tenant_b_same_actor: Object.freeze({
    id: "tenant_b_same_actor",
    verified_actor_id: "synthetic_actor_a",
    tenant_id: "synthetic_tenant_b",
    scopes: Object.freeze([
      "workspace:create",
      "document:register",
      "document:mutate",
      "document:read",
      "document:delete",
    ]),
    membership: "active",
  }),
  tenant_a_revoked: Object.freeze({
    id: "tenant_a_revoked",
    verified_actor_id: "synthetic_actor_revoked",
    tenant_id: "synthetic_tenant_a",
    scopes: Object.freeze([]),
    membership: "revoked",
  }),
});

export const STATE_LIMITS = Object.freeze({
  max_string_bytes: 512,
  max_json_depth: 8,
  max_json_keys: 128,
  max_json_array_items: 128,
  max_records_per_type: 256,
});

const RECORD_FIELDS = Object.freeze({
  workspace: Object.freeze([
    "tenant_id",
    "workspace_id",
    "created_by_verified_actor_id",
    "status",
    "created_at",
  ]),
  document: Object.freeze([
    "tenant_id",
    "workspace_id",
    "document_id",
    "immutable_source_version_id",
    "current_version_id",
    "lifecycle_state",
  ]),
  version: Object.freeze([
    "tenant_id",
    "workspace_id",
    "document_id",
    "version_id",
    "byte_length",
    "sha256",
    "parent_version_id",
    "created_by_operation_id",
    "created_at",
  ]),
  authorization_event: Object.freeze([
    "authorization_event_id",
    "verified_actor_id",
    "tenant_id",
    "workspace_id",
    "document_id",
    "source_version_id",
    "source_byte_length",
    "source_sha256",
    "tool_name",
    "tool_version",
    "canonical_arguments_sha256",
    "destination_and_effects",
    "policy_version",
    "single_use_nonce",
    "expires_at",
    "consumed_at",
  ]),
  operation: Object.freeze([
    "operation_id",
    "verified_actor_id",
    "tenant_id",
    "workspace_id",
    "document_id",
    "source_version_id",
    "source_byte_length",
    "source_sha256",
    "tool_name",
    "tool_version",
    "canonical_arguments_sha256",
    "authorization_event_id",
    "policy_version",
    "policy_result",
    "idempotency_key",
    "request_identity_sha256",
    "status",
    "output_version_id",
  ]),
  receipt: Object.freeze([
    "operation_id",
    "verified_actor_id",
    "tenant_id",
    "workspace_id",
    "document_id",
    "source_version_id",
    "source_byte_length",
    "source_sha256",
    "output_version_id",
    "output_byte_length",
    "output_sha256",
    "tool_name",
    "tool_version",
    "canonical_arguments_sha256",
    "authorization_event_id",
    "policy_version",
    "policy_result",
    "idempotency_key",
    "completed_at",
  ]),
  lifecycle_event: Object.freeze([
    "event_id",
    "verified_actor_id",
    "tenant_id",
    "workspace_id",
    "document_id",
    "prior_state",
    "next_state",
    "policy_version",
    "created_at",
  ]),
});

const REQUIRED_POLICY_VERSION = "synthetic-policy-v1";
const REGISTRATION_TOOL = "register_synthetic_document_identity";
const MUTATION_TOOL = "synthetic_identity_mutator";
const MUTATION_TOOL_VERSION = "1";
const REGISTRATION_TOOL_VERSION = "1";
const REGISTRATION_DESTINATION = "synthetic_remote_identity";
const MUTATION_DESTINATION = "synthetic_output_version";

function nullRecord(input) {
  const output = Object.create(null);
  for (const key of Object.keys(input)) {
    Object.defineProperty(output, key, {
      value: input[key],
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return output;
}

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalize(value[key])}`
  ).join(",")}}`;
}

export function syntheticSha256(value) {
  return crypto.createHash("sha256").update(
    typeof value === "string" ? value : canonicalize(value),
  ).digest("hex");
}

export function syntheticByteSha256(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError("Byte SHA-256 input must be bytes");
  }
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertSafeJson(value, depth = 0, budget = { keys: 0 }) {
  if (depth > STATE_LIMITS.max_json_depth) {
    throw new StateError("INVALID_ARGUMENTS");
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > STATE_LIMITS.max_string_bytes) {
      throw new StateError("INVALID_ARGUMENTS");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new StateError("INVALID_ARGUMENTS");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > STATE_LIMITS.max_json_array_items) {
      throw new StateError("INVALID_ARGUMENTS");
    }
    for (const item of value) assertSafeJson(item, depth + 1, budget);
    return;
  }
  if (
    value === undefined ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new StateError("INVALID_ARGUMENTS");
  }
  const keys = Object.keys(value);
  budget.keys += keys.length;
  if (
    budget.keys > STATE_LIMITS.max_json_keys ||
    keys.some(key =>
      key === "__proto__" ||
      key === "prototype" ||
      key === "constructor" ||
      Buffer.byteLength(key) > STATE_LIMITS.max_string_bytes
    )
  ) {
    throw new StateError("INVALID_ARGUMENTS");
  }
  for (const key of keys) assertSafeJson(value[key], depth + 1, budget);
}

function assertSafeArgumentsObject(value) {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new StateError("INVALID_ARGUMENTS");
  }
  assertSafeJson(value);
}

function isIdentifier(value) {
  return typeof value === "string" &&
    /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function exactRecord(kind, input) {
  const expected = RECORD_FIELDS[kind];
  const keys = Object.keys(input);
  if (
    !expected ||
    keys.length !== expected.length ||
    expected.some(key => !Object.hasOwn(input, key)) ||
    keys.some(key => !expected.includes(key))
  ) {
    throw new Error(`Invalid ${kind} record shape`);
  }
  return deepFreeze(nullRecord(clone(input)));
}

function compositeKey(...values) {
  return canonicalize(values);
}

function hasScope(context, scope) {
  return context?.membership === "active" && context.scopes.includes(scope);
}

export class StateError extends Error {
  constructor(code, { httpStatus = 200, details = null } = {}) {
    super(code);
    this.name = "StateError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

function assertCapacity(map) {
  if (map.size >= STATE_LIMITS.max_records_per_type) {
    throw new StateError("SYNTHETIC_CAPACITY_EXCEEDED");
  }
}

function assertContractAlignment(contract) {
  const slice = contract?.bounded_vertical_slice;
  const normalizedSchemas = Object.fromEntries(
    Object.entries(RECORD_FIELDS).map(([key, fields]) => [key, [...fields]]),
  );
  if (
    contract?.schema_version !==
      "pdf-tools.remote-hybrid-trust-boundary.v1" ||
    canonicalize(slice?.record_schemas) !== canonicalize(normalizedSchemas) ||
    slice?.idempotency_contract?.scope !==
      "tenant_id_plus_verified_actor_id_plus_idempotency_key"
  ) {
    throw new Error("Frozen state contract mismatch");
  }
}

function defaultIdFactory(kind, sequence) {
  return `synthetic_${kind}_${sequence}`;
}

export function createRemoteLoopbackState({
  contract,
  fixtures,
  now = () => "2026-07-30T03:00:00.000Z",
  idFactory = defaultIdFactory,
  beforeActivation = async () => {},
} = {}) {
  assertContractAlignment(contract);
  if (!(fixtures instanceof Map) || fixtures.size === 0) {
    throw new Error("Trusted synthetic fixture catalog required");
  }
  for (const [fixtureId, fixture] of fixtures) {
    if (
      !isIdentifier(fixtureId) ||
      !Number.isSafeInteger(fixture.byte_length) ||
      fixture.byte_length < 1 ||
      !isSha256(fixture.sha256)
    ) {
      throw new Error("Invalid trusted synthetic fixture");
    }
  }

  const maps = {
    workspaces: new Map(),
    documents: new Map(),
    versions: new Map(),
    authorization_events: new Map(),
    operations: new Map(),
    receipts: new Map(),
    lifecycle_events: new Map(),
  };
  const idempotency = new Map();
  const eventReservations = new Map();
  const sourceReservations = new Map();
  const lifecycleInventory = new Set();
  const currentMembership = new Map(
    Object.values(SYNTHETIC_AUTH_CONTEXTS).map(context => [
      context.id,
      context.membership,
    ]),
  );
  const counters = {
    authorization: 0,
    operation: 0,
    version: 0,
    lifecycle: 0,
    effect: 0,
  };

  function workspaceKey(tenantId, workspaceId) {
    return compositeKey(tenantId, workspaceId);
  }
  function documentKey(tenantId, workspaceId, documentId) {
    return compositeKey(tenantId, workspaceId, documentId);
  }
  function versionKey(tenantId, workspaceId, documentId, versionId) {
    return compositeKey(tenantId, workspaceId, documentId, versionId);
  }
  function authorizationKey(
    tenantId,
    workspaceId,
    documentId,
    authorizationEventId,
  ) {
    return compositeKey(
      tenantId,
      workspaceId,
      documentId,
      authorizationEventId,
    );
  }
  function receiptKey(
    tenantId,
    workspaceId,
    documentId,
    operationId,
  ) {
    return compositeKey(tenantId, workspaceId, documentId, operationId);
  }
  function idempotencyKey(context, key) {
    return compositeKey(
      context.tenant_id,
      context.verified_actor_id,
      key,
    );
  }

  function getWorkspace(context, workspaceId) {
    return maps.workspaces.get(workspaceKey(context.tenant_id, workspaceId));
  }
  function getDocument(context, workspaceId, documentId) {
    return maps.documents.get(documentKey(
      context.tenant_id,
      workspaceId,
      documentId,
    ));
  }
  function getVersion(context, workspaceId, documentId, versionId) {
    return maps.versions.get(versionKey(
      context.tenant_id,
      workspaceId,
      documentId,
      versionId,
    ));
  }
  function getAuthorization(
    context,
    workspaceId,
    documentId,
    authorizationEventId,
  ) {
    return maps.authorization_events.get(authorizationKey(
      context.tenant_id,
      workspaceId,
      documentId,
      authorizationEventId,
    ));
  }

  function validateCommonArguments(args, names) {
    assertSafeJson(args);
    if (
      !args ||
      names.some(name => !isIdentifier(args[name]))
    ) {
      throw new StateError("INVALID_ARGUMENTS");
    }
  }

  function assertExactArgumentKeys(args, expected) {
    const keys = Object.keys(args ?? {});
    if (
      keys.length !== expected.length ||
      expected.some(key => !Object.hasOwn(args, key)) ||
      keys.some(key => !expected.includes(key))
    ) {
      throw new StateError("INVALID_ARGUMENTS");
    }
  }

  function nextId(kind) {
    counters[kind] += 1;
    const value = idFactory(kind, counters[kind]);
    if (!isIdentifier(value)) throw new Error("Unsafe injected ID");
    return value;
  }

  function nextUnusedVersionId(context, workspaceId, documentId) {
    for (
      let attempt = 0;
      attempt <= STATE_LIMITS.max_records_per_type;
      attempt += 1
    ) {
      const candidate = nextId("version");
      if (
        !maps.versions.has(versionKey(
          context.tenant_id,
          workspaceId,
          documentId,
          candidate,
        ))
      ) {
        return candidate;
      }
    }
    throw new StateError("SYNTHETIC_CAPACITY_EXCEEDED");
  }

  function assertCurrentScope(context, scope) {
    if (
      !hasScope(context, scope) ||
      currentMembership.get(context.id) !== "active"
    ) {
      throw new StateError("INSUFFICIENT_SCOPE", { httpStatus: 403 });
    }
  }

  function matchingAuthorization(event, expected) {
    return event &&
      event.consumed_at === null &&
      Date.parse(event.expires_at) > Date.parse(now()) &&
      Object.entries(expected).every(([key, value]) => event[key] === value);
  }

  function consumeAuthorization(event) {
    const consumed = exactRecord("authorization_event", {
      ...event,
      consumed_at: now(),
    });
    maps.authorization_events.set(authorizationKey(
      consumed.tenant_id,
      consumed.workspace_id,
      consumed.document_id,
      consumed.authorization_event_id,
    ), consumed);
    return consumed;
  }

  function createWorkspace(context, args) {
    assertCurrentScope(context, "workspace:create");
    validateCommonArguments(args, ["workspace_id"]);
    assertExactArgumentKeys(args, ["workspace_id"]);
    const key = workspaceKey(context.tenant_id, args.workspace_id);
    const existing = maps.workspaces.get(key);
    if (existing) return { workspace: clone(existing), replayed: true };
    assertCapacity(maps.workspaces);
    const workspace = exactRecord("workspace", {
      tenant_id: context.tenant_id,
      workspace_id: args.workspace_id,
      created_by_verified_actor_id: context.verified_actor_id,
      status: "active",
      created_at: now(),
    });
    maps.workspaces.set(key, workspace);
    return { workspace: clone(workspace), replayed: false };
  }

  function registrationArguments(args, fixture) {
    return {
      document_id: args.document_id,
      fixture_id: args.fixture_id,
      source_byte_length: fixture.byte_length,
      source_sha256: fixture.sha256,
      source_version_id: args.source_version_id,
      workspace_id: args.workspace_id,
    };
  }

  function registerDocument(context, args) {
    assertCurrentScope(context, "document:register");
    validateCommonArguments(args, [
      "workspace_id",
      "document_id",
      "fixture_id",
      "source_version_id",
      "authorization_event_id",
    ]);
    assertExactArgumentKeys(args, [
      "workspace_id",
      "document_id",
      "fixture_id",
      "source_version_id",
      "authorization_event_id",
    ]);
    const fixture = fixtures.get(args.fixture_id);
    if (!fixture) throw new StateError("SYNTHETIC_FIXTURE_NOT_ALLOWED");
    const workspace = getWorkspace(context, args.workspace_id);
    if (!workspace || workspace.status !== "active") {
      throw new StateError("AUTHORIZATION_OR_IDENTITY_FAILED");
    }
    const docKey = documentKey(
      context.tenant_id,
      args.workspace_id,
      args.document_id,
    );
    if (maps.documents.has(docKey)) {
      throw new StateError("AUTHORIZATION_OR_IDENTITY_FAILED");
    }
    const argumentsSha256 = syntheticSha256(
      registrationArguments(args, fixture),
    );
    const event = getAuthorization(
      context,
      args.workspace_id,
      args.document_id,
      args.authorization_event_id,
    );
    if (!matchingAuthorization(event, {
      verified_actor_id: context.verified_actor_id,
      tenant_id: context.tenant_id,
      workspace_id: args.workspace_id,
      document_id: args.document_id,
      source_version_id: args.source_version_id,
      source_byte_length: fixture.byte_length,
      source_sha256: fixture.sha256,
      tool_name: REGISTRATION_TOOL,
      tool_version: REGISTRATION_TOOL_VERSION,
      canonical_arguments_sha256: argumentsSha256,
      destination_and_effects: REGISTRATION_DESTINATION,
      policy_version: REQUIRED_POLICY_VERSION,
    })) {
      throw new StateError("AUTHORIZATION_OR_IDENTITY_FAILED");
    }
    assertCapacity(maps.documents);
    assertCapacity(maps.versions);
    const sourceVersion = exactRecord("version", {
      tenant_id: context.tenant_id,
      workspace_id: args.workspace_id,
      document_id: args.document_id,
      version_id: args.source_version_id,
      byte_length: fixture.byte_length,
      sha256: fixture.sha256,
      parent_version_id: null,
      created_by_operation_id: null,
      created_at: now(),
    });
    const document = exactRecord("document", {
      tenant_id: context.tenant_id,
      workspace_id: args.workspace_id,
      document_id: args.document_id,
      immutable_source_version_id: args.source_version_id,
      current_version_id: args.source_version_id,
      lifecycle_state: "active",
    });
    consumeAuthorization(event);
    maps.versions.set(versionKey(
      context.tenant_id,
      args.workspace_id,
      args.document_id,
      args.source_version_id,
    ), sourceVersion);
    maps.documents.set(docKey, document);
    return {
      document: clone(document),
      source_version: clone(sourceVersion),
    };
  }

  function mutationIdentity(context, args, canonicalArgumentsSha256) {
    return syntheticSha256({
      source_identity: {
        tenant_id: context.tenant_id,
        workspace_id: args.workspace_id,
        document_id: args.document_id,
        version_id: args.source_version_id,
        byte_length: args.source_byte_length,
        sha256: args.source_sha256,
      },
      tool_name: MUTATION_TOOL,
      tool_version: MUTATION_TOOL_VERSION,
      canonical_arguments_sha256: canonicalArgumentsSha256,
      destination_and_effects: MUTATION_DESTINATION,
    });
  }

  function exactMutationAuthorization({
    event,
    context,
    args,
    source,
    canonicalArgumentsSha256,
  }) {
    return matchingAuthorization(event, {
      verified_actor_id: context.verified_actor_id,
      tenant_id: context.tenant_id,
      workspace_id: args.workspace_id,
      document_id: args.document_id,
      source_version_id: source.version_id,
      source_byte_length: source.byte_length,
      source_sha256: source.sha256,
      tool_name: MUTATION_TOOL,
      tool_version: MUTATION_TOOL_VERSION,
      canonical_arguments_sha256: canonicalArgumentsSha256,
      destination_and_effects: MUTATION_DESTINATION,
      policy_version: REQUIRED_POLICY_VERSION,
    });
  }

  async function mutationReplay(entry) {
    await entry.settled;
    if (entry.terminal_error) {
      throw new StateError(entry.terminal_error.code, {
        httpStatus: entry.terminal_error.httpStatus,
        details: {
          operation: clone(maps.operations.get(entry.operation_id)),
          receipt: null,
          replayed: true,
        },
      });
    }
    const operation = maps.operations.get(entry.operation_id);
    const receipt = maps.receipts.get(entry.receipt_key);
    return {
      operation: clone(operation),
      receipt: receipt ? clone(receipt) : null,
      replayed: true,
    };
  }

  async function mutateDocument(context, args) {
    assertCurrentScope(context, "document:mutate");
    validateCommonArguments(args, [
      "workspace_id",
      "document_id",
      "source_version_id",
      "authorization_event_id",
      "idempotency_key",
    ]);
    assertExactArgumentKeys(args, [
      "workspace_id",
      "document_id",
      "source_version_id",
      "source_byte_length",
      "source_sha256",
      "tool_name",
      "tool_version",
      "arguments",
      "destination_and_effects",
      "authorization_event_id",
      "policy_version",
      "idempotency_key",
    ]);
    if (
      !Object.hasOwn(args, "arguments") ||
      !Number.isSafeInteger(args.source_byte_length) ||
      args.source_byte_length < 1 ||
      !isSha256(args.source_sha256) ||
      args.tool_name !== MUTATION_TOOL ||
      args.tool_version !== MUTATION_TOOL_VERSION ||
      args.destination_and_effects !== MUTATION_DESTINATION ||
      args.policy_version !== REQUIRED_POLICY_VERSION
    ) {
      throw new StateError("INVALID_ARGUMENTS");
    }
    assertSafeArgumentsObject(args.arguments);
    const docKey = documentKey(
      context.tenant_id,
      args.workspace_id,
      args.document_id,
    );
    const document = maps.documents.get(docKey);
    if (!document || document.lifecycle_state !== "active") {
      throw new StateError("AUTHORIZATION_OR_IDENTITY_FAILED");
    }
    const requestedSource = getVersion(
      context,
      args.workspace_id,
      args.document_id,
      args.source_version_id,
    );
    if (!requestedSource) {
      throw new StateError("AUTHORIZATION_OR_IDENTITY_FAILED");
    }
    const canonicalArgumentsSha256 = syntheticSha256(args.arguments);
    const requestIdentitySha256 = mutationIdentity(
      context,
      args,
      canonicalArgumentsSha256,
    );
    const idemKey = idempotencyKey(context, args.idempotency_key);

    /*
     * Fresh caller and object authorization happens above. The cache lookup is
     * deliberately before current-source and consumed-event checks so an exact
     * authorized retry can receive the prior terminal result.
     */
    const prior = idempotency.get(idemKey);
    if (prior) {
      if (prior.request_identity_sha256 !== requestIdentitySha256) {
        throw new StateError("IDEMPOTENCY_CONFLICT");
      }
      return mutationReplay(prior);
    }
    if (
      document.current_version_id !== requestedSource.version_id ||
      requestedSource.byte_length !== args.source_byte_length ||
      requestedSource.sha256 !== args.source_sha256
    ) {
      throw new StateError("AUTHORIZATION_OR_IDENTITY_FAILED");
    }
    const event = getAuthorization(
      context,
      args.workspace_id,
      args.document_id,
      args.authorization_event_id,
    );
    if (!exactMutationAuthorization({
      event,
      context,
      args,
      source: requestedSource,
      canonicalArgumentsSha256,
    })) {
      throw new StateError("AUTHORIZATION_OR_IDENTITY_FAILED");
    }
    const authKey = authorizationKey(
      context.tenant_id,
      args.workspace_id,
      args.document_id,
      args.authorization_event_id,
    );
    const sourceKey = versionKey(
      context.tenant_id,
      args.workspace_id,
      args.document_id,
      args.source_version_id,
    );
    if (
      eventReservations.has(authKey) ||
      sourceReservations.has(sourceKey)
    ) {
      throw new StateError("AUTHORIZATION_OR_IDENTITY_FAILED");
    }
    assertCapacity(maps.operations);
    assertCapacity(maps.versions);
    assertCapacity(maps.receipts);
    const outputVersionId = nextUnusedVersionId(
      context,
      args.workspace_id,
      args.document_id,
    );

    /*
     * This synchronous block is the linearization point. It reserves the
     * tenant/actor/key tuple, the single-use event, and the current source
     * before the first await. Running permanently consumes its approval.
     */
    const operationId = nextId("operation");
    const receiptCompositeKey = receiptKey(
      context.tenant_id,
      args.workspace_id,
      args.document_id,
      operationId,
    );
    let settle;
    const settled = new Promise(resolve => {
      settle = resolve;
    });
    const reservation = {
      request_identity_sha256: requestIdentitySha256,
      operation_id: operationId,
      receipt_key: receiptCompositeKey,
      settled,
      terminal_error: null,
    };
    idempotency.set(idemKey, reservation);
    eventReservations.set(authKey, operationId);
    sourceReservations.set(sourceKey, operationId);
    consumeAuthorization(event);
    const runningOperation = exactRecord("operation", {
      operation_id: operationId,
      verified_actor_id: context.verified_actor_id,
      tenant_id: context.tenant_id,
      workspace_id: args.workspace_id,
      document_id: args.document_id,
      source_version_id: requestedSource.version_id,
      source_byte_length: requestedSource.byte_length,
      source_sha256: requestedSource.sha256,
      tool_name: MUTATION_TOOL,
      tool_version: MUTATION_TOOL_VERSION,
      canonical_arguments_sha256: canonicalArgumentsSha256,
      authorization_event_id: args.authorization_event_id,
      policy_version: REQUIRED_POLICY_VERSION,
      policy_result: "allow",
      idempotency_key: args.idempotency_key,
      request_identity_sha256: requestIdentitySha256,
      status: "running",
      output_version_id: null,
    });
    maps.operations.set(operationId, runningOperation);

    try {
      await beforeActivation({
        operation_id: operationId,
        source_version: clone(requestedSource),
      });
      if (
        currentMembership.get(context.id) !== "active" ||
        !hasScope(context, "document:mutate")
      ) {
        throw new StateError("AUTHORITY_REVOKED_BEFORE_ACTIVATION");
      }
      const currentDocument = maps.documents.get(docKey);
      if (
        !currentDocument ||
        currentDocument.lifecycle_state !== "active" ||
        currentDocument.current_version_id !== requestedSource.version_id
      ) {
        throw new StateError("ATOMIC_ACTIVATION_PRECONDITION_FAILED");
      }
      const outputByteLength = requestedSource.byte_length +
        (parseInt(canonicalArgumentsSha256.slice(0, 2), 16) % 17) + 1;
      const outputSha256 = syntheticSha256({
        source_sha256: requestedSource.sha256,
        operation_id: operationId,
        canonical_arguments_sha256: canonicalArgumentsSha256,
        destination_and_effects: MUTATION_DESTINATION,
      });
      const outputVersion = exactRecord("version", {
        tenant_id: context.tenant_id,
        workspace_id: args.workspace_id,
        document_id: args.document_id,
        version_id: outputVersionId,
        byte_length: outputByteLength,
        sha256: outputSha256,
        parent_version_id: requestedSource.version_id,
        created_by_operation_id: operationId,
        created_at: now(),
      });
      const completedOperation = exactRecord("operation", {
        ...runningOperation,
        status: "completed",
        output_version_id: outputVersionId,
      });
      const receipt = exactRecord("receipt", {
        operation_id: operationId,
        verified_actor_id: context.verified_actor_id,
        tenant_id: context.tenant_id,
        workspace_id: args.workspace_id,
        document_id: args.document_id,
        source_version_id: requestedSource.version_id,
        source_byte_length: requestedSource.byte_length,
        source_sha256: requestedSource.sha256,
        output_version_id: outputVersionId,
        output_byte_length: outputByteLength,
        output_sha256: outputSha256,
        tool_name: MUTATION_TOOL,
        tool_version: MUTATION_TOOL_VERSION,
        canonical_arguments_sha256: canonicalArgumentsSha256,
        authorization_event_id: args.authorization_event_id,
        policy_version: REQUIRED_POLICY_VERSION,
        policy_result: "allow",
        idempotency_key: args.idempotency_key,
        completed_at: now(),
      });
      const advancedDocument = exactRecord("document", {
        ...currentDocument,
        current_version_id: outputVersionId,
      });
      /*
       * No await occurs inside this activation tuple. Readers can observe
       * either the running evidence or the complete version/pointer/receipt
       * activation, never a partial success.
       */
      maps.versions.set(versionKey(
        context.tenant_id,
        args.workspace_id,
        args.document_id,
        outputVersionId,
      ), outputVersion);
      maps.operations.set(operationId, completedOperation);
      maps.receipts.set(receiptCompositeKey, receipt);
      maps.documents.set(docKey, advancedDocument);
      counters.effect += 1;
      return {
        operation: clone(completedOperation),
        receipt: clone(receipt),
        replayed: false,
      };
    } catch (error) {
      const failedOperation = exactRecord("operation", {
        ...runningOperation,
        status: "failed",
        output_version_id: null,
      });
      maps.operations.set(operationId, failedOperation);
      reservation.terminal_error = {
        code: error instanceof StateError
          ? error.code
          : "SYNTHETIC_EFFECT_FAILED",
        httpStatus: 200,
      };
      throw new StateError(reservation.terminal_error.code, {
        details: {
          operation: clone(failedOperation),
          receipt: null,
          replayed: false,
        },
      });
    } finally {
      eventReservations.delete(authKey);
      sourceReservations.delete(sourceKey);
      settle();
    }
  }

  function readReceipt(context, args) {
    assertCurrentScope(context, "document:read");
    validateCommonArguments(args, [
      "workspace_id",
      "document_id",
      "operation_id",
    ]);
    assertExactArgumentKeys(args, [
      "workspace_id",
      "document_id",
      "operation_id",
    ]);
    const document = getDocument(
      context,
      args.workspace_id,
      args.document_id,
    );
    if (!document || document.lifecycle_state === "physically_purged") {
      throw new StateError("AUTHORIZATION_OR_IDENTITY_FAILED");
    }
    const receipt = maps.receipts.get(receiptKey(
      context.tenant_id,
      args.workspace_id,
      args.document_id,
      args.operation_id,
    ));
    if (
      !receipt ||
      receipt.verified_actor_id !== context.verified_actor_id
    ) {
      throw new StateError("AUTHORIZATION_OR_IDENTITY_FAILED");
    }
    return { receipt: clone(receipt) };
  }

  function transitionLifecycle(context, args) {
    assertCurrentScope(context, "document:delete");
    validateCommonArguments(args, [
      "workspace_id",
      "document_id",
      "next_state",
    ]);
    assertExactArgumentKeys(args, [
      "workspace_id",
      "document_id",
      "next_state",
      "policy_version",
    ]);
    if (args.policy_version !== REQUIRED_POLICY_VERSION) {
      throw new StateError("INVALID_ARGUMENTS");
    }
    const docKey = documentKey(
      context.tenant_id,
      args.workspace_id,
      args.document_id,
    );
    const document = maps.documents.get(docKey);
    if (!document) throw new StateError("AUTHORIZATION_OR_IDENTITY_FAILED");
    if (sourceReservations.has(versionKey(
      context.tenant_id,
      args.workspace_id,
      args.document_id,
      document.current_version_id,
    ))) {
      throw new StateError("AUTHORIZATION_OR_IDENTITY_FAILED");
    }
    const expected = {
      active: "tombstoned",
      tombstoned: "purge_pending",
      purge_pending: "physically_purged",
    }[document.lifecycle_state];
    if (args.next_state !== expected) {
      throw new StateError("AUTHORIZATION_OR_IDENTITY_FAILED");
    }
    if (
      args.next_state === "physically_purged" &&
      !lifecycleInventory.has(docKey)
    ) {
      throw new StateError("AUTHORIZATION_OR_IDENTITY_FAILED");
    }
    assertCapacity(maps.lifecycle_events);
    const event = exactRecord("lifecycle_event", {
      event_id: nextId("lifecycle"),
      verified_actor_id: context.verified_actor_id,
      tenant_id: context.tenant_id,
      workspace_id: args.workspace_id,
      document_id: args.document_id,
      prior_state: document.lifecycle_state,
      next_state: args.next_state,
      policy_version: REQUIRED_POLICY_VERSION,
      created_at: now(),
    });
    const nextDocument = exactRecord("document", {
      ...document,
      lifecycle_state: args.next_state,
    });
    maps.documents.set(docKey, nextDocument);
    maps.lifecycle_events.set(event.event_id, event);
    return {
      document: clone(nextDocument),
      lifecycle_event: clone(event),
    };
  }

  function provisionAuthorizationEvent({
    authContextId,
    workspaceId,
    documentId,
    sourceVersionId,
    sourceByteLength,
    sourceSha256,
    toolName,
    toolVersion,
    canonicalArgumentsSha256,
    destinationAndEffects,
    expiresInMs = 60_000,
  }) {
    const context = SYNTHETIC_AUTH_CONTEXTS[authContextId];
    if (
      !context ||
      context.membership !== "active" ||
      !context.verified_actor_id ||
      !isIdentifier(workspaceId) ||
      !isIdentifier(documentId) ||
      !isIdentifier(sourceVersionId) ||
      !Number.isSafeInteger(sourceByteLength) ||
      sourceByteLength < 1 ||
      !isSha256(sourceSha256) ||
      !isIdentifier(toolName) ||
      !isIdentifier(toolVersion) ||
      !isSha256(canonicalArgumentsSha256) ||
      !isIdentifier(destinationAndEffects) ||
      !Number.isSafeInteger(expiresInMs)
    ) {
      throw new Error("Invalid trusted fixture authorization intent");
    }
    assertCapacity(maps.authorization_events);
    const authorizationEventId = nextId("authorization");
    const event = exactRecord("authorization_event", {
      authorization_event_id: authorizationEventId,
      verified_actor_id: context.verified_actor_id,
      tenant_id: context.tenant_id,
      workspace_id: workspaceId,
      document_id: documentId,
      source_version_id: sourceVersionId,
      source_byte_length: sourceByteLength,
      source_sha256: sourceSha256,
      tool_name: toolName,
      tool_version: toolVersion,
      canonical_arguments_sha256: canonicalArgumentsSha256,
      destination_and_effects: destinationAndEffects,
      policy_version: REQUIRED_POLICY_VERSION,
      single_use_nonce: `nonce_${authorizationEventId}`,
      expires_at: new Date(Date.parse(now()) + expiresInMs).toISOString(),
      consumed_at: null,
    });
    maps.authorization_events.set(authorizationKey(
      context.tenant_id,
      workspaceId,
      documentId,
      authorizationEventId,
    ), event);
    return clone(event);
  }

  const trustedFixtureSetup = Object.freeze({
    provisionRegistrationAuthorization({
      authContextId,
      workspaceId,
      documentId,
      fixtureId,
      sourceVersionId,
      expiresInMs,
    }) {
      const fixture = fixtures.get(fixtureId);
      if (!fixture) throw new Error("Fixture is not allowlisted");
      const args = {
        workspace_id: workspaceId,
        document_id: documentId,
        fixture_id: fixtureId,
        source_version_id: sourceVersionId,
      };
      return provisionAuthorizationEvent({
        authContextId,
        workspaceId,
        documentId,
        sourceVersionId,
        sourceByteLength: fixture.byte_length,
        sourceSha256: fixture.sha256,
        toolName: REGISTRATION_TOOL,
        toolVersion: REGISTRATION_TOOL_VERSION,
        canonicalArgumentsSha256: syntheticSha256(
          registrationArguments(args, fixture),
        ),
        destinationAndEffects: REGISTRATION_DESTINATION,
        expiresInMs,
      });
    },
    provisionMutationAuthorization({
      authContextId,
      workspaceId,
      documentId,
      arguments: operationArguments,
      expiresInMs,
    }) {
      const context = SYNTHETIC_AUTH_CONTEXTS[authContextId];
      const document = context && getDocument(
        context,
        workspaceId,
        documentId,
      );
      if (!document) throw new Error("Synthetic document not found");
      const source = getVersion(
        context,
        workspaceId,
        documentId,
        document.current_version_id,
      );
      assertSafeArgumentsObject(operationArguments);
      return provisionAuthorizationEvent({
        authContextId,
        workspaceId,
        documentId,
        sourceVersionId: source.version_id,
        sourceByteLength: source.byte_length,
        sourceSha256: source.sha256,
        toolName: MUTATION_TOOL,
        toolVersion: MUTATION_TOOL_VERSION,
        canonicalArgumentsSha256: syntheticSha256(operationArguments),
        destinationAndEffects: MUTATION_DESTINATION,
        expiresInMs,
      });
    },
    attestLifecycleInventoryComplete({
      authContextId,
      workspaceId,
      documentId,
    }) {
      const context = SYNTHETIC_AUTH_CONTEXTS[authContextId];
      const document = context && getDocument(
        context,
        workspaceId,
        documentId,
      );
      if (!document || document.lifecycle_state !== "purge_pending") {
        throw new Error("Purge-pending synthetic document required");
      }
      lifecycleInventory.add(documentKey(
        context.tenant_id,
        workspaceId,
        documentId,
      ));
    },
    revokeSyntheticMembership({ authContextId }) {
      const context = SYNTHETIC_AUTH_CONTEXTS[authContextId];
      if (!context || !context.verified_actor_id) {
        throw new Error("Active synthetic actor context required");
      }
      currentMembership.set(authContextId, "revoked");
    },
  });

  return Object.freeze({
    trustedFixtureSetup,
    async callTool(context, name, args) {
      try {
        let value;
        switch (name) {
          case "create_synthetic_workspace":
            value = createWorkspace(context, args);
            break;
          case "register_synthetic_document_identity":
            value = registerDocument(context, args);
            break;
          case "simulate_identity_bound_mutation":
            value = await mutateDocument(context, args);
            break;
          case "read_operation_receipt":
            value = readReceipt(context, args);
            break;
          case "simulate_delete_lifecycle":
            value = transitionLifecycle(context, args);
            break;
          default:
            throw new StateError("UNKNOWN_SYNTHETIC_TOOL");
        }
        return { ok: true, value };
      } catch (error) {
        if (!(error instanceof StateError)) throw error;
        return {
          ok: false,
          code: error.code,
          httpStatus: error.httpStatus,
          details: error.details,
        };
      }
    },
    snapshot() {
      const records = Object.fromEntries(
        Object.entries(maps).map(([name, map]) => [
          name,
          [...map.values()].map(clone),
        ]),
      );
      return {
        data_plane: {
          workspaces: records.workspaces,
          documents: records.documents,
          versions: records.versions,
          receipts: records.receipts,
          lifecycle_events: records.lifecycle_events,
          effects: counters.effect,
        },
        evidence_plane: {
          authorization_events: records.authorization_events,
          operations: records.operations,
          control_state: {
            idempotency_reservations: [...idempotency.entries()].map(
              ([key, value]) => ({
                key_sha256: syntheticSha256(key),
                request_identity_sha256: value.request_identity_sha256,
                operation_id: value.operation_id,
                terminal_error: value.terminal_error
                  ? clone(value.terminal_error)
                  : null,
              }),
            ).sort((left, right) =>
              left.key_sha256.localeCompare(right.key_sha256)
            ),
            event_reservations: [...eventReservations.entries()].map(
              ([key, operationId]) => ({
                key_sha256: syntheticSha256(key),
                operation_id: operationId,
              }),
            ).sort((left, right) =>
              left.key_sha256.localeCompare(right.key_sha256)
            ),
            source_reservations: [...sourceReservations.entries()].map(
              ([key, operationId]) => ({
                key_sha256: syntheticSha256(key),
                operation_id: operationId,
              }),
            ).sort((left, right) =>
              left.key_sha256.localeCompare(right.key_sha256)
            ),
            lifecycle_inventory_attestations: [...lifecycleInventory]
              .map(syntheticSha256).sort(),
            current_membership: [...currentMembership.entries()]
              .map(([context_id, membership]) => ({
                context_id,
                membership,
              }))
              .sort((left, right) =>
                left.context_id.localeCompare(right.context_id)
              ),
          },
          counters: clone(counters),
        },
      };
    },
  });
}

export const REMOTE_LOOPBACK_STATE_CONSTANTS = Object.freeze({
  record_fields: RECORD_FIELDS,
  policy_version: REQUIRED_POLICY_VERSION,
  registration_tool: REGISTRATION_TOOL,
  registration_tool_version: REGISTRATION_TOOL_VERSION,
  registration_destination: REGISTRATION_DESTINATION,
  mutation_tool: MUTATION_TOOL,
  mutation_tool_version: MUTATION_TOOL_VERSION,
  mutation_destination: MUTATION_DESTINATION,
});
