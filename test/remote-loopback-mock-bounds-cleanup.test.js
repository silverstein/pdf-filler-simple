import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  REMOTE_LOOPBACK_HTTP_CONSTANTS as LIMITS,
  startRemoteLoopbackMcpMock,
} from "./helpers/remote-loopback-mcp-mock.mjs";
import {
  requestBody,
  requestMock,
} from "./helpers/remote-loopback-test-client.mjs";

const CONTRACT = JSON.parse(await fs.readFile(
  new URL("../config/remote-hybrid-trust-boundary.v1.json", import.meta.url),
  "utf8",
));

function connectFormerPort(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(1_000);
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("Former mock port remained reachable"));
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("Former mock port refusal timed out"));
    });
    socket.once("error", error => {
      if (error.code === "ECONNREFUSED") resolve(error.code);
      else reject(error);
    });
  });
}

function chunkedOversizeRequest(mock) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: mock.host,
      port: mock.port,
      method: "POST",
      path: "/mcp",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "server/discover",
        Authorization: "Synthetic tenant_a_owner",
        "Transfer-Encoding": "chunked",
      },
      agent: false,
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        bytes: Buffer.concat(chunks),
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    request.once("error", reject);
    const chunk = Buffer.alloc(8_192, 0x20);
    for (let bytes = 0; bytes <= LIMITS.max_request_bytes; bytes += chunk.length) {
      request.write(chunk);
    }
    request.end();
  });
}

async function callTool(mock, name, args, id) {
  return requestMock(mock, {
    body: requestBody({
      id,
      method: "tools/call",
      name,
      arguments: args,
    }),
  });
}

async function deterministicTranscript(mock) {
  const responses = [];
  responses.push(await callTool(
    mock,
    "create_synthetic_workspace",
    { workspace_id: "workspace_a" },
    "create",
  ));
  const registration = mock.trustedFixtureSetup
    .provisionRegistrationAuthorization({
      authContextId: "tenant_a_owner",
      workspaceId: "workspace_a",
      documentId: "document_a",
      fixtureId: "comparison_base_v1",
      sourceVersionId: "source_v1",
    });
  responses.push(await callTool(
    mock,
    "register_synthetic_document_identity",
    {
      workspace_id: "workspace_a",
      document_id: "document_a",
      fixture_id: "comparison_base_v1",
      source_version_id: "source_v1",
      authorization_event_id: registration.authorization_event_id,
    },
    "register",
  ));
  const source = responses.at(-1).body.result.structuredContent.source_version;
  const operationArguments = { deterministic: true, page: 1 };
  const mutation = mock.trustedFixtureSetup.provisionMutationAuthorization({
    authContextId: "tenant_a_owner",
    workspaceId: "workspace_a",
    documentId: "document_a",
    arguments: operationArguments,
  });
  responses.push(await callTool(
    mock,
    "simulate_identity_bound_mutation",
    {
      workspace_id: "workspace_a",
      document_id: "document_a",
      source_version_id: source.version_id,
      source_byte_length: source.byte_length,
      source_sha256: source.sha256,
      tool_name: LIMITS.state_contract.mutation_tool,
      tool_version: LIMITS.state_contract.mutation_tool_version,
      arguments: operationArguments,
      destination_and_effects: LIMITS.state_contract.mutation_destination,
      authorization_event_id: mutation.authorization_event_id,
      policy_version: LIMITS.state_contract.policy_version,
      idempotency_key: "deterministic_key",
    },
    "mutate",
  ));
  const operation = responses.at(-1).body.result.structuredContent.operation;
  responses.push(await callTool(
    mock,
    "read_operation_receipt",
    {
      workspace_id: "workspace_a",
      document_id: "document_a",
      operation_id: operation.operation_id,
    },
    "receipt",
  ));
  responses.push(await callTool(
    mock,
    "simulate_delete_lifecycle",
    {
      workspace_id: "workspace_a",
      document_id: "document_a",
      next_state: "tombstoned",
      policy_version: LIMITS.state_contract.policy_version,
    },
    "delete",
  ));
  return {
    bytes: responses.map(response => response.bytes),
    snapshot: mock.snapshot(),
  };
}

describe("remote loopback MCP mock bounds and cleanup", () => {
  const liveMocks = new Set();

  async function start(options = {}) {
    const mock = await startRemoteLoopbackMcpMock({
      contract: CONTRACT,
      ...options,
    });
    liveMocks.add(mock);
    return mock;
  }

  afterEach(async () => {
    for (const mock of liveMocks) await mock.close();
    liveMocks.clear();
  });

  it("rejects declared and chunked bodies above the exported byte ceiling", async () => {
    const mock = await start();
    const oversized = " ".repeat(LIMITS.max_request_bytes + 1);
    const declared = await requestMock(mock, { rawBody: oversized });
    expect(declared.status).toBe(413);
    expect(declared.body.error.data.stable_code).toBe("REQUEST_TOO_LARGE");
    expect(declared.bytes.length).toBeLessThanOrEqual(
      LIMITS.max_response_bytes,
    );

    const chunked = await chunkedOversizeRequest(mock);
    expect(chunked.status).toBe(413);
    expect(chunked.body.error.data.stable_code).toBe("REQUEST_TOO_LARGE");
    expect(chunked.bytes.length).toBeLessThanOrEqual(
      LIMITS.max_response_bytes,
    );
  });

  it("returns bounded stable errors without echoing oversized attacker fields", async () => {
    const mock = await start();
    const attackerValue = "x".repeat(
      LIMITS.state_limits.max_string_bytes + 1,
    );
    const body = requestBody({
      method: "tools/call",
      name: "create_synthetic_workspace",
      arguments: { workspace_id: attackerValue },
    });
    const response = await requestMock(mock, { body });
    expect(response.status).toBe(400);
    expect(response.body.error.data.stable_code).toBe("INVALID_REQUEST");
    expect(response.bytes.length).toBeLessThanOrEqual(
      LIMITS.max_response_bytes,
    );
    expect(response.bytes.toString("utf8")).not.toContain(attackerValue);
    expect(mock.snapshot().data_plane.workspaces).toEqual([]);
  });

  it("bounds an invalid JSON-RPC id before using it in an error response", async () => {
    const mock = await start();
    const body = requestBody({
      id: "i".repeat(LIMITS.state_limits.max_string_bytes + 1),
    });
    const response = await requestMock(mock, { body });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      id: null,
      error: { data: { stable_code: "INVALID_REQUEST" } },
    });
    expect(response.bytes.length).toBeLessThanOrEqual(
      LIMITS.max_response_bytes,
    );
    expect(response.bytes.toString("utf8")).not.toContain(body.id);
  });

  it("produces byte-identical deterministic bodies across fresh instances and ports", async () => {
    const first = await start();
    const firstResponse = await requestMock(first);
    const firstPort = first.port;
    const second = await start();
    const secondResponse = await requestMock(second);
    expect(second.port).not.toBe(firstPort);
    expect(secondResponse.bytes).toEqual(firstResponse.bytes);
    expect(secondResponse.bytes.toString("utf8"))
      .not.toContain(String(second.port));
    expect(firstResponse.headers.date).toBeUndefined();
    expect(secondResponse.headers.date).toBeUndefined();
  });

  it("produces an exact deterministic stateful transcript with injected time and IDs", async () => {
    const first = await start();
    const second = await start();
    expect(first.port).not.toBe(second.port);
    const [firstTranscript, secondTranscript] = await Promise.all([
      deterministicTranscript(first),
      deterministicTranscript(second),
    ]);
    expect(secondTranscript.bytes).toEqual(firstTranscript.bytes);
    expect(secondTranscript.snapshot).toEqual(firstTranscript.snapshot);
    for (const bytes of firstTranscript.bytes) {
      expect(bytes.length).toBeLessThanOrEqual(LIMITS.max_response_bytes);
      expect(bytes.toString("utf8")).not.toContain(String(first.port));
      expect(bytes.toString("utf8")).not.toContain(String(second.port));
    }
  });

  it("closes ordinary, keep-alive, and stalled-body sockets within its deadline", async () => {
    const mock = await start();
    const heldKeepAlive = net.connect({ host: mock.host, port: mock.port });
    await new Promise((resolve, reject) => {
      heldKeepAlive.once("connect", resolve);
      heldKeepAlive.once("error", reject);
    });
    heldKeepAlive.write([
      "GET /mcp HTTP/1.1",
      `Host: ${mock.host}:${mock.port}`,
      "Connection: keep-alive",
      "",
      "",
    ].join("\r\n"));

    const stalledBody = net.connect({ host: mock.host, port: mock.port });
    await new Promise((resolve, reject) => {
      stalledBody.once("connect", resolve);
      stalledBody.once("error", reject);
    });
    stalledBody.write([
      "POST /mcp HTTP/1.1",
      `Host: ${mock.host}:${mock.port}`,
      "Accept: application/json, text/event-stream",
      "Content-Type: application/json",
      "MCP-Protocol-Version: 2026-07-28",
      "Mcp-Method: server/discover",
      "Authorization: Synthetic tenant_a_owner",
      "Content-Length: 100",
      "",
      "{",
    ].join("\r\n"));

    const formerPort = mock.port;
    const started = performance.now();
    await mock.close();
    const elapsed = performance.now() - started;
    liveMocks.delete(mock);
    expect(elapsed).toBeLessThan(LIMITS.shutdown_deadline_ms);
    expect(mock.address()).toBeNull();
    await expect(connectFormerPort(mock.host, formerPort))
      .resolves.toBe("ECONNREFUSED");
    heldKeepAlive.destroy();
    stalledBody.destroy();
  });

  it("destroys a stalled request body at the body deadline and stays healthy", async () => {
    const mock = await start();
    const stalledBody = net.connect({ host: mock.host, port: mock.port });
    await new Promise((resolve, reject) => {
      stalledBody.once("connect", resolve);
      stalledBody.once("error", reject);
    });
    stalledBody.write([
      "POST /mcp HTTP/1.1",
      `Host: ${mock.host}:${mock.port}`,
      "Accept: application/json, text/event-stream",
      "Content-Type: application/json",
      "MCP-Protocol-Version: 2026-07-28",
      "Mcp-Method: server/discover",
      "Authorization: Synthetic tenant_a_owner",
      "Content-Length: 100",
      "",
      "{",
    ].join("\r\n"));

    const started = performance.now();
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        stalledBody.destroy();
        reject(new Error("Stalled body remained connected past its deadline"));
      }, LIMITS.body_deadline_ms * 3);
      deadline.unref();
      stalledBody.once("close", () => {
        clearTimeout(deadline);
        resolve();
      });
      stalledBody.once("error", error => {
        clearTimeout(deadline);
        reject(error);
      });
    });
    expect(performance.now() - started)
      .toBeLessThan(LIMITS.body_deadline_ms * 3);

    const healthy = await requestMock(mock);
    expect(healthy.status).toBe(200);
    expect(healthy.body.result.resultType).toBe("complete");
  });

  it("makes repeated shutdown idempotent", async () => {
    const mock = await start();
    await Promise.all(Array.from({ length: 32 }, () => mock.close()));
    await mock.close();
    liveMocks.delete(mock);
    expect(mock.address()).toBeNull();
  });
});
