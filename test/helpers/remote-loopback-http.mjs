import fs from "node:fs/promises";
import http from "node:http";

import {
  createRemoteLoopbackState,
  REMOTE_LOOPBACK_STATE_CONSTANTS,
  STATE_LIMITS,
  SYNTHETIC_AUTH_CONTEXTS,
  syntheticByteSha256,
  syntheticSha256,
} from "./remote-loopback-state.mjs";

const LOOPBACK_HOST = "127.0.0.1";
const MCP_PATH = "/mcp";
const PROTOCOL_VERSION = "2026-07-28";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const BODY_DEADLINE_MS = 1_000;
const SHUTDOWN_DEADLINE_MS = 1_000;
const IMPLEMENTATION_CONTRACT_SHA256 =
  "621a862f1aa3bfba144becd73b73a4eb25d2b00d888b647606ebb1b0c6b4a1d9";
const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1",
  "http://localhost",
]);
const DIRECT_METHODS = Object.freeze(["server/discover", "tools/list"]);
const TOOL_NAMES = Object.freeze([
  "create_synthetic_workspace",
  "register_synthetic_document_identity",
  "simulate_identity_bound_mutation",
  "read_operation_receipt",
  "simulate_delete_lifecycle",
]);
const EXPOSED_OPERATIONS = Object.freeze([
  ...DIRECT_METHODS,
  ...TOOL_NAMES,
]);
const SERVER_INFO = Object.freeze({
  name: "oda-pdf-tools-loopback-contract-mock",
  version: "1",
});
const RESULT_META = Object.freeze({
  "io.modelcontextprotocol/serverInfo": SERVER_INFO,
});
const IDENTIFIER_SCHEMA = Object.freeze({
  type: "string",
  pattern: "^[a-z0-9][a-z0-9._-]{0,127}$",
});
const SHA256_SCHEMA = Object.freeze({
  type: "string",
  pattern: "^[a-f0-9]{64}$",
});
const TOOL_DESCRIPTORS = deepFreezeDescriptors([
  {
    name: "create_synthetic_workspace",
    description: "Create one tenant-scoped synthetic contract workspace.",
    inputSchema: {
      type: "object",
      properties: { workspace_id: IDENTIFIER_SCHEMA },
      required: ["workspace_id"],
      additionalProperties: false,
    },
  },
  {
    name: "register_synthetic_document_identity",
    description:
      "Register the identity of one allowlisted repository-synthetic fixture.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: IDENTIFIER_SCHEMA,
        document_id: IDENTIFIER_SCHEMA,
        fixture_id: {
          type: "string",
          enum: ["comparison_base_v1"],
        },
        source_version_id: IDENTIFIER_SCHEMA,
        authorization_event_id: IDENTIFIER_SCHEMA,
      },
      required: [
        "workspace_id",
        "document_id",
        "fixture_id",
        "source_version_id",
        "authorization_event_id",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "simulate_identity_bound_mutation",
    description:
      "Simulate one approved mutation by creating synthetic identity metadata only.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: IDENTIFIER_SCHEMA,
        document_id: IDENTIFIER_SCHEMA,
        source_version_id: IDENTIFIER_SCHEMA,
        source_byte_length: {
          type: "integer",
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        source_sha256: SHA256_SCHEMA,
        tool_name: {
          type: "string",
          const: "synthetic_identity_mutator",
        },
        tool_version: { type: "string", const: "1" },
        arguments: { type: "object" },
        destination_and_effects: {
          type: "string",
          const: "synthetic_output_version",
        },
        authorization_event_id: IDENTIFIER_SCHEMA,
        policy_version: {
          type: "string",
          const: "synthetic-policy-v1",
        },
        idempotency_key: IDENTIFIER_SCHEMA,
      },
      required: [
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
      ],
      additionalProperties: false,
    },
  },
  {
    name: "read_operation_receipt",
    description:
      "Read one actor- and object-bound synthetic operation receipt.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: IDENTIFIER_SCHEMA,
        document_id: IDENTIFIER_SCHEMA,
        operation_id: IDENTIFIER_SCHEMA,
      },
      required: ["workspace_id", "document_id", "operation_id"],
      additionalProperties: false,
    },
  },
  {
    name: "simulate_delete_lifecycle",
    description:
      "Advance one synthetic document through exactly one deletion lifecycle state.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: IDENTIFIER_SCHEMA,
        document_id: IDENTIFIER_SCHEMA,
        next_state: {
          type: "string",
          enum: ["tombstoned", "purge_pending", "physically_purged"],
        },
        policy_version: {
          type: "string",
          const: "synthetic-policy-v1",
        },
      },
      required: [
        "workspace_id",
        "document_id",
        "next_state",
        "policy_version",
      ],
      additionalProperties: false,
    },
  },
]);
const FIXTURE_CATALOG = Object.freeze({
  comparison_base_v1: new URL(
    "../fixtures/eval/comparison/synthetic/comparison-base.pdf",
    import.meta.url,
  ),
});
const ARCHITECTURE_CONTRACT_URL = new URL(
  "../../config/remote-hybrid-trust-boundary.v1.json",
  import.meta.url,
);
const IMPLEMENTATION_CONTRACT_URL = new URL(
  "../../config/remote-loopback-mock.v1.json",
  import.meta.url,
);

function deepFreezeDescriptors(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreezeDescriptors(value[key]);
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

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeResponseId(body) {
  const id = body?.id;
  if (
    id === null ||
    (typeof id === "number" && Number.isSafeInteger(id)) ||
    (
      typeof id === "string" &&
      Buffer.byteLength(id) <= STATE_LIMITS.max_string_bytes
    )
  ) {
    return id;
  }
  return null;
}

function jsonRpcError(id, stableCode, rpcCode = -32000) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code: rpcCode,
      message: stableCode,
      data: { stable_code: stableCode },
    },
  };
}

function toolResult(id, result) {
  if (!result.ok) {
    return {
      jsonrpc: "2.0",
      id: id ?? null,
      result: {
        resultType: "complete",
        _meta: RESULT_META,
        isError: true,
        content: [{ type: "text", text: result.code }],
        structuredContent: {
          code: result.code,
          ...(result.details ? structuredClone(result.details) : {}),
        },
      },
    };
  }
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result: {
      resultType: "complete",
      _meta: RESULT_META,
      isError: false,
      content: [{ type: "text", text: canonicalize(result.value) }],
      structuredContent: structuredClone(result.value),
    },
  };
}

function sendJson(response, status, body) {
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES) {
    throw new Error("Bounded synthetic response exceeded limit");
  }
  response.sendDate = false;
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(encoded),
    "X-Content-Type-Options": "nosniff",
  });
  response.end(encoded);
}

function headerValues(request, name) {
  const target = name.toLowerCase();
  const values = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === target) {
      values.push(request.rawHeaders[index + 1]);
    }
  }
  return values;
}

function singleHeader(request, name) {
  const values = headerValues(request, name);
  return values.length === 1 && values[0].length > 0 ? values[0] : null;
}

function parseAccept(value) {
  if (typeof value !== "string") return new Map();
  const parsed = new Map();
  for (const item of value.split(",")) {
    const [rawType, ...parameters] = item.trim().split(";");
    const type = rawType.trim().toLowerCase();
    if (!type) continue;
    let quality = 1;
    let qualitySeen = false;
    for (const parameter of parameters) {
      const match =
        /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/i.exec(parameter);
      if (match) {
        if (qualitySeen) return null;
        qualitySeen = true;
        quality = Number(match[1]);
      } else if (/^\s*q\s*=/i.test(parameter)) {
        return null;
      }
    }
    parsed.set(type, Math.max(parsed.get(type) ?? 0, quality));
  }
  return parsed;
}

function acceptIsValid(value) {
  const parsed = parseAccept(value);
  if (parsed === null) return false;
  return (parsed.get("application/json") ?? 0) > 0 &&
    (parsed.get("text/event-stream") ?? 0) > 0;
}

function parseSyntheticAuth(request) {
  const value = singleHeader(request, "authorization");
  const match = /^Synthetic ([a-z_]+)$/.exec(value ?? "");
  return match ? SYNTHETIC_AUTH_CONTEXTS[match[1]] ?? null : null;
}

function validateOrigin(request) {
  const origins = headerValues(request, "origin");
  if (origins.length === 0) return null;
  if (
    origins.length !== 1 ||
    origins[0].includes(",") ||
    !ALLOWED_ORIGINS.has(origins[0])
  ) {
    return { status: 403, code: "ORIGIN_REJECTED" };
  }
  return null;
}

function validateTransport(request, expectedHost) {
  if (request.method !== "POST" || request.url !== MCP_PATH) {
    return { status: 404, code: "METHOD_NOT_FOUND", rpcCode: -32601 };
  }
  if (
    singleHeader(request, "host") !== expectedHost ||
    !acceptIsValid(singleHeader(request, "accept")) ||
    singleHeader(request, "content-type") !== "application/json" ||
    singleHeader(request, "mcp-protocol-version") === null ||
    singleHeader(request, "mcp-method") === null
  ) {
    return { status: 400, code: "HeaderMismatch" };
  }
  return null;
}

function validateBody(request, body) {
  if (
    !isObject(body) ||
    body.jsonrpc !== "2.0" ||
    !(
      body.id === null ||
      (
        typeof body.id === "string" &&
        Buffer.byteLength(body.id) <= STATE_LIMITS.max_string_bytes
      ) ||
      (typeof body.id === "number" && Number.isSafeInteger(body.id))
    ) ||
    typeof body.method !== "string" ||
    body.method.length === 0 ||
    Buffer.byteLength(body.method) > STATE_LIMITS.max_string_bytes ||
    !isObject(body.params) ||
    !isObject(body.params._meta)
  ) {
    return { code: "HeaderMismatch" };
  }
  const meta = body.params._meta;
  const clientInfo = meta["io.modelcontextprotocol/clientInfo"];
  if (
    typeof meta["io.modelcontextprotocol/protocolVersion"] !== "string" ||
    !isObject(clientInfo) ||
    typeof clientInfo.name !== "string" ||
    clientInfo.name.length === 0 ||
    Buffer.byteLength(clientInfo.name) > STATE_LIMITS.max_string_bytes ||
    typeof clientInfo.version !== "string" ||
    clientInfo.version.length === 0 ||
    Buffer.byteLength(clientInfo.version) > STATE_LIMITS.max_string_bytes ||
    !isObject(meta["io.modelcontextprotocol/clientCapabilities"])
  ) {
    return { code: "HeaderMismatch" };
  }
  const protocolHeader = singleHeader(request, "mcp-protocol-version");
  if (
    singleHeader(request, "mcp-method") !== body.method ||
    protocolHeader !== meta["io.modelcontextprotocol/protocolVersion"]
  ) {
    return { code: "HeaderMismatch" };
  }
  const namedValue = body.method === "resources/read"
    ? body.params.uri
    : body.params.name;
  const needsName = body.method === "tools/call" ||
    body.method === "resources/read" ||
    body.method === "prompts/get";
  if (
    needsName &&
    (
      typeof namedValue !== "string" ||
      namedValue.length === 0 ||
      singleHeader(request, "mcp-name") !== namedValue
    )
  ) {
    return { code: "HeaderMismatch" };
  }
  if (!needsName && headerValues(request, "mcp-name").length > 0) {
    return { code: "HeaderMismatch" };
  }
  if (protocolHeader !== PROTOCOL_VERSION) {
    return { code: "UnsupportedProtocolVersion" };
  }
  return null;
}

function readBoundedJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let complete = false;
    function fail(error) {
      if (complete) return;
      complete = true;
      clearTimeout(deadline);
      reject(error);
    }
    const deadline = setTimeout(() => {
      if (!complete) {
        const error = new Error("body deadline");
        error.code = "BODY_DEADLINE_EXCEEDED";
        fail(error);
        request.destroy();
      }
    }, BODY_DEADLINE_MS);
    deadline.unref();
    request.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BYTES) {
        const error = new Error("request too large");
        error.code = "REQUEST_TOO_LARGE";
        fail(error);
        request.removeAllListeners("data");
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (complete) return;
      complete = true;
      clearTimeout(deadline);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        const error = new Error("invalid JSON");
        error.code = "INVALID_JSON";
        reject(error);
      }
    });
    request.on("error", error => {
      fail(error);
    });
  });
}

function isBoundedJson(value, depth = 0, budget = { keys: 0 }) {
  if (depth > STATE_LIMITS.max_json_depth) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") {
    return Buffer.byteLength(value) <= STATE_LIMITS.max_string_bytes;
  }
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (Array.isArray(value)) {
    return value.length <= STATE_LIMITS.max_json_array_items &&
      value.every(item => isBoundedJson(item, depth + 1, budget));
  }
  if (
    value === undefined ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const keys = Object.keys(value);
  budget.keys += keys.length;
  return budget.keys <= STATE_LIMITS.max_json_keys &&
    keys.every(key =>
      key !== "__proto__" &&
      key !== "prototype" &&
      key !== "constructor" &&
      Buffer.byteLength(key) <= STATE_LIMITS.max_string_bytes &&
      isBoundedJson(value[key], depth + 1, budget)
    );
}

function assertContractAlignment(
  contract,
  implementationContract,
  architectureBytes,
  implementationBytes,
) {
  const slice = contract?.bounded_vertical_slice;
  const constants = implementationContract?.synthetic_constants;
  const bounds = implementationContract?.bounds;
  const responses = implementationContract?.response_contract;
  const expectedAuthContexts = Object.values(SYNTHETIC_AUTH_CONTEXTS).map(
    context => {
      const normalized = {
        id: context.id,
        verified_actor_id: context.verified_actor_id,
        tenant_id: context.tenant_id,
        scopes: [...context.scopes],
      };
      if (context.membership !== "active") {
        normalized.membership = context.membership;
      }
      return normalized;
    },
  );
  if (
    syntheticByteSha256(implementationBytes) !==
      IMPLEMENTATION_CONTRACT_SHA256 ||
    implementationContract?.schema_version !==
      "pdf-tools.remote-loopback-mock.v1" ||
    syntheticByteSha256(architectureBytes) !==
      implementationContract?.architecture_file_sha256 ||
    canonicalize(JSON.parse(architectureBytes.toString("utf8"))) !==
      canonicalize(contract) ||
    contract?.schema_version !==
      "pdf-tools.remote-hybrid-trust-boundary.v1" ||
    slice?.environment !== "loopback_only_local_mock" ||
    slice?.listener_enforcement?.bind_host !== LOOPBACK_HOST ||
    slice?.listener_enforcement?.port !== "ephemeral_test_selected" ||
    slice?.listener_enforcement?.bind_all_interfaces_forbidden !== true ||
    canonicalize(slice?.allowed_operations) !==
      canonicalize(EXPOSED_OPERATIONS) ||
    canonicalize(slice?.synthetic_auth_contexts) !==
      canonicalize(expectedAuthContexts) ||
    canonicalize(slice?.state_transitions) !== canonicalize(
      implementationContract?.architecture_state_transitions,
    ) ||
    canonicalize(slice?.idempotency_contract) !== canonicalize(
      implementationContract?.architecture_idempotency_contract,
    ) ||
    canonicalize(slice?.error_semantics) !== canonicalize(
      implementationContract?.architecture_error_semantics,
    ) ||
    slice?.request_envelope?.path !== MCP_PATH ||
    slice?.request_envelope?.method !== "POST" ||
    canonicalize(
      implementationContract?.operation_mapping?.direct_json_rpc_methods,
    ) !== canonicalize(DIRECT_METHODS) ||
    canonicalize(
      implementationContract?.operation_mapping?.tools_call_names,
    ) !== canonicalize(TOOL_NAMES) ||
    implementationContract?.operation_mapping
      ?.fixture_authority_network_reachable !== false ||
    constants?.policy_version !==
      REMOTE_LOOPBACK_STATE_CONSTANTS.policy_version ||
    constants?.registration_tool !==
      REMOTE_LOOPBACK_STATE_CONSTANTS.registration_tool ||
    constants?.registration_tool_version !==
      REMOTE_LOOPBACK_STATE_CONSTANTS.registration_tool_version ||
    constants?.registration_destination_and_effects !==
      REMOTE_LOOPBACK_STATE_CONSTANTS.registration_destination ||
    constants?.mutation_tool !==
      REMOTE_LOOPBACK_STATE_CONSTANTS.mutation_tool ||
    constants?.mutation_tool_version !==
      REMOTE_LOOPBACK_STATE_CONSTANTS.mutation_tool_version ||
    constants?.mutation_destination_and_effects !==
      REMOTE_LOOPBACK_STATE_CONSTANTS.mutation_destination ||
    bounds?.max_request_bytes !== MAX_REQUEST_BYTES ||
    bounds?.max_response_bytes !== MAX_RESPONSE_BYTES ||
    bounds?.max_string_bytes !== STATE_LIMITS.max_string_bytes ||
    bounds?.max_json_depth !== STATE_LIMITS.max_json_depth ||
    bounds?.max_json_keys !== STATE_LIMITS.max_json_keys ||
    bounds?.max_json_array_items !== STATE_LIMITS.max_json_array_items ||
    bounds?.max_records_per_type !== STATE_LIMITS.max_records_per_type ||
    bounds?.body_deadline_ms !== BODY_DEADLINE_MS ||
    bounds?.shutdown_deadline_ms !== SHUTDOWN_DEADLINE_MS ||
    responses?.result_type !== "complete" ||
    canonicalize(responses?.server_info_meta) !== canonicalize(SERVER_INFO) ||
    canonicalize(responses?.discover_supported_versions) !==
      canonicalize([PROTOCOL_VERSION]) ||
    canonicalize(responses?.discover_capabilities) !== canonicalize({
      tools: { listChanged: false },
    }) ||
    responses?.discover_ttl_ms !== 0 ||
    responses?.discover_cache_scope !== "public" ||
    responses?.tools_list_ttl_ms !== 0 ||
    responses?.tools_list_cache_scope !== "public" ||
    responses?.tool_descriptors_require_input_schema !== true
  ) {
    throw new Error("Frozen HTTP mock contract mismatch");
  }
}

async function loadTrustedFixtureCatalog() {
  const entries = await Promise.all(
    Object.entries(FIXTURE_CATALOG).map(async ([fixtureId, url]) => {
      const bytes = await fs.readFile(url);
      return [fixtureId, Object.freeze({
        byte_length: bytes.length,
        sha256: syntheticByteSha256(bytes),
      })];
    }),
  );
  return new Map(entries);
}

export async function startRemoteLoopbackMcpMock({
  contract,
  now,
  idFactory,
  beforeActivation,
} = {}) {
  const [
    architectureBytes,
    implementationBytes,
  ] = await Promise.all([
    fs.readFile(ARCHITECTURE_CONTRACT_URL),
    fs.readFile(IMPLEMENTATION_CONTRACT_URL),
  ]);
  const implementationContract = JSON.parse(
    implementationBytes.toString("utf8"),
  );
  assertContractAlignment(
    contract,
    implementationContract,
    architectureBytes,
    implementationBytes,
  );
  const fixtures = await loadTrustedFixtureCatalog();
  const state = createRemoteLoopbackState({
    contract,
    fixtures,
    now,
    idFactory,
    beforeActivation,
  });
  const sockets = new Set();
  const transportCounters = {
    requests: 0,
    dispatches: 0,
  };
  let expectedHost = null;
  let closed = false;
  let closing = null;

  const server = http.createServer(async (request, response) => {
    transportCounters.requests += 1;
    const originError = validateOrigin(request);
    if (originError) {
      sendJson(response, originError.status, jsonRpcError(null, originError.code));
      return;
    }
    const transportError = validateTransport(request, expectedHost);
    if (transportError) {
      sendJson(
        response,
        transportError.status,
        jsonRpcError(null, transportError.code, transportError.rpcCode),
      );
      return;
    }
    const declaredLength = singleHeader(request, "content-length");
    if (
      declaredLength !== null &&
      (
        !/^\d+$/.test(declaredLength) ||
        Number(declaredLength) > MAX_REQUEST_BYTES
      )
    ) {
      sendJson(response, 413, jsonRpcError(null, "REQUEST_TOO_LARGE"));
      request.resume();
      return;
    }
    let body;
    try {
      body = await readBoundedJson(request);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        sendJson(
          response,
          error.code === "REQUEST_TOO_LARGE" ? 413 : 400,
          jsonRpcError(null, error.code ?? "INVALID_REQUEST"),
        );
      }
      return;
    }
    if (!isBoundedJson(body)) {
      sendJson(response, 400, jsonRpcError(null, "INVALID_REQUEST"));
      return;
    }
    const bodyError = validateBody(request, body);
    if (bodyError) {
      sendJson(
        response,
        400,
        jsonRpcError(safeResponseId(body), bodyError.code),
      );
      return;
    }
    const context = parseSyntheticAuth(request);
    if (!context) {
      sendJson(
        response,
        401,
        jsonRpcError(body.id, "INVALID_SYNTHETIC_AUTH_CONTEXT"),
      );
      return;
    }
    transportCounters.dispatches += 1;
    if (body.method === "server/discover") {
      sendJson(response, 200, {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: {
          resultType: "complete",
          supportedVersions: [PROTOCOL_VERSION],
          capabilities: {
            tools: { listChanged: false },
          },
          _meta: RESULT_META,
          instructions:
            "Test-only synthetic contract mock. It does not manipulate PDFs or authorize production use.",
          ttlMs: 0,
          cacheScope: "public",
        },
      });
      return;
    }
    if (body.method === "tools/list") {
      sendJson(response, 200, {
        jsonrpc: "2.0",
        id: body.id ?? null,
        result: {
          resultType: "complete",
          _meta: RESULT_META,
          tools: TOOL_DESCRIPTORS,
          ttlMs: 0,
          cacheScope: "public",
        },
      });
      return;
    }
    if (body.method !== "tools/call") {
      sendJson(
        response,
        404,
        jsonRpcError(body.id, "METHOD_NOT_FOUND", -32601),
      );
      return;
    }
    const result = await state.callTool(
      context,
      body.params.name,
      body.params.arguments,
    );
    if (result.httpStatus && result.httpStatus !== 200) {
      sendJson(
        response,
        result.httpStatus,
        jsonRpcError(body.id, result.code),
      );
    } else {
      sendJson(response, 200, toolResult(body.id, result));
    }
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.requestTimeout = BODY_DEADLINE_MS;
  server.headersTimeout = BODY_DEADLINE_MS;
  server.keepAliveTimeout = 250;
  server.maxHeadersCount = 32;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({
      host: LOOPBACK_HOST,
      port: 0,
      exclusive: true,
    }, resolve);
  });
  const address = server.address();
  if (
    !address ||
    typeof address === "string" ||
    address.address !== LOOPBACK_HOST ||
    address.family !== "IPv4" ||
    !Number.isInteger(address.port) ||
    address.port < 1 ||
    address.port > 65_535
  ) {
    await new Promise(resolve => server.close(resolve));
    throw new Error("Mock listener did not bind exact IPv4 loopback");
  }
  expectedHost = `${LOOPBACK_HOST}:${address.port}`;

  async function close() {
    if (closed) return;
    if (closing) return closing;
    closing = (async () => {
      const closePromise = new Promise((resolve, reject) => {
        server.close(error => {
          if (!error || error.code === "ERR_SERVER_NOT_RUNNING") resolve();
          else reject(error);
        });
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
        for (const socket of sockets) socket.destroy();
      });
      let timer;
      try {
        await Promise.race([
          closePromise,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(
                new Error("Bounded mock shutdown exceeded deadline"),
              ),
              SHUTDOWN_DEADLINE_MS,
            );
            timer.unref();
          }),
        ]);
        closed = true;
      } finally {
        clearTimeout(timer);
      }
    })();
    try {
      await closing;
    } finally {
      closing = null;
    }
  }

  return Object.freeze({
    host: LOOPBACK_HOST,
    port: address.port,
    family: address.family,
    requested_port: 0,
    url: `http://${expectedHost}${MCP_PATH}`,
    exposedOperations: EXPOSED_OPERATIONS,
    fixtureIds: Object.freeze([...fixtures.keys()]),
    trustedFixtureSetup: state.trustedFixtureSetup,
    snapshot() {
      return {
        ...state.snapshot(),
        transport: structuredClone(transportCounters),
      };
    },
    address: () => server.address(),
    close,
  });
}

export const REMOTE_LOOPBACK_HTTP_CONSTANTS = Object.freeze({
  host: LOOPBACK_HOST,
  path: MCP_PATH,
  protocol_version: PROTOCOL_VERSION,
  max_request_bytes: MAX_REQUEST_BYTES,
  max_response_bytes: MAX_RESPONSE_BYTES,
  body_deadline_ms: BODY_DEADLINE_MS,
  shutdown_deadline_ms: SHUTDOWN_DEADLINE_MS,
  allowed_origins: Object.freeze([...ALLOWED_ORIGINS]),
  exposed_operations: EXPOSED_OPERATIONS,
  tool_names: TOOL_NAMES,
  state_limits: STATE_LIMITS,
  state_contract: REMOTE_LOOPBACK_STATE_CONSTANTS,
  implementation_contract_sha256: IMPLEMENTATION_CONTRACT_SHA256,
  server_info: SERVER_INFO,
  tool_descriptors: TOOL_DESCRIPTORS,
});
