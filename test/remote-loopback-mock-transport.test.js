import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  REMOTE_LOOPBACK_HTTP_CONSTANTS,
  startRemoteLoopbackMcpMock,
} from "./helpers/remote-loopback-mcp-mock.mjs";
import {
  rawHttpRequest,
  requestBody,
  requestMock,
} from "./helpers/remote-loopback-test-client.mjs";

const CONTRACT = JSON.parse(await fs.readFile(
  new URL("../config/remote-hybrid-trust-boundary.v1.json", import.meta.url),
  "utf8",
));

function probeUnavailable(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(1_000);
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`Unexpected listener on ${host}:${port}`));
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve("UNREACHABLE_TIMEOUT");
    });
    socket.once("error", error => {
      if (error.code === "ECONNREFUSED") resolve(error.code);
      else reject(error);
    });
  });
}

function assignedNonLoopbackAddress() {
  const entries = Object.entries(os.networkInterfaces());
  const preferred = entries.filter(([name]) =>
    !/^(?:lo|utun|tailscale)/i.test(name)
  );
  for (const [, interfaces] of [...preferred, ...entries]) {
    for (const entry of interfaces ?? []) {
      if (
        entry.family === "IPv4" &&
        entry.internal === false &&
        net.isIP(entry.address) === 4
      ) {
        return entry.address;
      }
    }
  }
  throw new Error("HARNESS_NO_NON_LOOPBACK_INTERFACE");
}

function validRawHeaders({ authorization = "Synthetic tenant_a_owner" } = {}) {
  return [
    "Accept: application/json, text/event-stream",
    "Content-Type: application/json",
    "MCP-Protocol-Version: 2026-07-28",
    "Mcp-Method: server/discover",
    `Authorization: ${authorization}`,
  ];
}

describe("remote loopback MCP mock transport", () => {
  let mock;

  beforeEach(async () => {
    mock = await startRemoteLoopbackMcpMock({ contract: CONTRACT });
  });

  afterEach(async () => {
    await mock?.close();
  });

  it("binds only an OS-selected exact IPv4 loopback endpoint", async () => {
    expect(mock).toMatchObject({
      host: "127.0.0.1",
      family: "IPv4",
      requested_port: 0,
    });
    expect(mock.port).toBeGreaterThan(0);
    expect(mock.port).toBeLessThanOrEqual(65_535);
    expect(mock.address()).toMatchObject({
      address: "127.0.0.1",
      family: "IPv4",
      port: mock.port,
    });

    const control = await requestMock(mock);
    expect(control.status).toBe(200);
    await expect(probeUnavailable("127.0.0.2", mock.port))
      .resolves.toMatch(/^(?:ECONNREFUSED|UNREACHABLE_TIMEOUT)$/);
    await expect(
      probeUnavailable(assignedNonLoopbackAddress(), mock.port),
    ).resolves.toBe("ECONNREFUSED");
  });

  it("advertises exactly the frozen seven logical operations and five tools", async () => {
    const discovery = await requestMock(mock);
    expect(discovery.status).toBe(200);
    expect(discovery.body.result).toEqual({
      resultType: "complete",
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: { listChanged: false } },
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "oda-pdf-tools-loopback-contract-mock",
          version: "1",
        },
      },
      instructions:
        "Test-only synthetic contract mock. It does not manipulate PDFs or authorize production use.",
      ttlMs: 0,
      cacheScope: "public",
    });
    expect(discovery.bytes.length).toBeLessThanOrEqual(
      REMOTE_LOOPBACK_HTTP_CONSTANTS.max_response_bytes,
    );

    const listBody = requestBody({ method: "tools/list" });
    const listing = await requestMock(mock, { body: listBody });
    expect(listing.status).toBe(200);
    expect(listing.body.result).toMatchObject({
      resultType: "complete",
      ttlMs: 0,
      cacheScope: "public",
    });
    expect(listing.body.result.tools.map(tool => tool.name)).toEqual(
      CONTRACT.bounded_vertical_slice.allowed_operations.slice(2),
    );
    expect(listing.body.result.tools).not.toContainEqual(
      expect.objectContaining({ name: "create_authorization_event" }),
    );
    for (const tool of listing.body.result.tools) {
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
  });

  it.each([
    ["unrelated", "https://attacker.example"],
    ["literal null", "null"],
    ["prefix", "http://127.0.0.1.attacker.example"],
    ["suffix", "http://attacker.example/127.0.0.1"],
    ["userinfo", "http://127.0.0.1@attacker.example"],
    ["trailing dot", "http://localhost."],
    ["wrong scheme", "https://localhost"],
    ["unexpected port", "http://localhost:80"],
    ["case variant", "http://LOCALHOST"],
    ["comma joined", "http://localhost, http://localhost"],
  ])("rejects %s Origin before dispatch", async (_label, origin) => {
    const before = mock.snapshot();
    const response = await requestMock(mock, {
      headers: { Origin: origin },
    });
    expect(response.status).toBe(403);
    expect(response.body.error.data.stable_code).toBe("ORIGIN_REJECTED");
    const after = mock.snapshot();
    expect(after.data_plane).toEqual(before.data_plane);
    expect(after.evidence_plane).toEqual(before.evidence_plane);
    expect(after.transport.dispatches).toBe(before.transport.dispatches);
  });

  it("rejects duplicate Origin lines, including identical allowed values", async () => {
    for (const origins of [
      ["Origin: http://localhost", "Origin: http://localhost"],
      ["Origin: http://localhost", "Origin: https://attacker.example"],
    ]) {
      const before = mock.snapshot();
      const response = await rawHttpRequest(
        mock,
        [...validRawHeaders(), ...origins],
        requestBody(),
      );
      expect(response.status).toBe(403);
      expect(response.body.error.data.stable_code).toBe("ORIGIN_REJECTED");
      const after = mock.snapshot();
      expect(after.data_plane).toEqual(before.data_plane);
      expect(after.evidence_plane).toEqual(before.evidence_plane);
      expect(after.transport.dispatches).toBe(before.transport.dispatches);
    }
  });

  it("rejects duplicate required routing and content headers before dispatch", async () => {
    const duplicateRows = [
      "Accept: application/json, text/event-stream",
      "Content-Type: application/json",
      "MCP-Protocol-Version: 2026-07-28",
      "Mcp-Method: server/discover",
    ];
    for (const duplicate of duplicateRows) {
      const before = mock.snapshot();
      const response = await rawHttpRequest(
        mock,
        [...validRawHeaders(), duplicate],
        requestBody(),
      );
      expect(response.status).toBe(400);
      expect(response.body.error.data.stable_code).toBe("HeaderMismatch");
      expect(mock.snapshot().transport.dispatches)
        .toBe(before.transport.dispatches);
      expect(mock.snapshot().data_plane).toEqual(before.data_plane);
    }
    const beforeDuplicateHost = mock.snapshot();
    const duplicateHost = await rawHttpRequest(
      mock,
      [
        ...validRawHeaders(),
        `Host: ${mock.host}:${mock.port}`,
      ],
      requestBody(),
    );
    expect(duplicateHost.status).toBe(400);
    if (duplicateHost.body) {
      expect(duplicateHost.body.error.data.stable_code)
        .toBe("HeaderMismatch");
    }
    const afterDuplicateHost = mock.snapshot();
    expect(afterDuplicateHost.data_plane)
      .toEqual(beforeDuplicateHost.data_plane);
    expect(afterDuplicateHost.evidence_plane)
      .toEqual(beforeDuplicateHost.evidence_plane);
    expect(afterDuplicateHost.transport.dispatches)
      .toBe(beforeDuplicateHost.transport.dispatches);

    const namedBody = requestBody({
      method: "tools/call",
      name: "create_synthetic_workspace",
      arguments: { workspace_id: "workspace_a" },
    });
    const beforeDuplicateName = mock.snapshot();
    const duplicateName = await rawHttpRequest(
      mock,
      [
        "Accept: application/json, text/event-stream",
        "Content-Type: application/json",
        "MCP-Protocol-Version: 2026-07-28",
        "Mcp-Method: tools/call",
        "Mcp-Name: create_synthetic_workspace",
        "Mcp-Name: create_synthetic_workspace",
        "Authorization: Synthetic tenant_a_owner",
      ],
      namedBody,
    );
    expect(duplicateName.status).toBe(400);
    expect(duplicateName.body.error.data.stable_code)
      .toBe("HeaderMismatch");
    const afterDuplicateName = mock.snapshot();
    expect(afterDuplicateName.data_plane)
      .toEqual(beforeDuplicateName.data_plane);
    expect(afterDuplicateName.evidence_plane)
      .toEqual(beforeDuplicateName.evidence_plane);
    expect(afterDuplicateName.transport.dispatches)
      .toBe(beforeDuplicateName.transport.dispatches);

    const beforeDuplicateAuth = mock.snapshot();
    const duplicateAuth = await rawHttpRequest(
      mock,
      [
        ...validRawHeaders(),
        "Authorization: Synthetic tenant_a_owner",
      ],
      requestBody(),
    );
    expect(duplicateAuth.status).toBe(401);
    expect(duplicateAuth.body.error.data.stable_code)
      .toBe("INVALID_SYNTHETIC_AUTH_CONTEXT");
    const afterDuplicateAuth = mock.snapshot();
    expect(afterDuplicateAuth.data_plane).toEqual(
      beforeDuplicateAuth.data_plane,
    );
    expect(afterDuplicateAuth.evidence_plane).toEqual(
      beforeDuplicateAuth.evidence_plane,
    );
    expect(afterDuplicateAuth.transport.dispatches)
      .toBe(beforeDuplicateAuth.transport.dispatches);
  });

  it("allows missing or exact allowlisted Origin to reach authentication", async () => {
    for (const headers of [
      {},
      { Origin: "http://localhost" },
      { Origin: "http://127.0.0.1" },
    ]) {
      const response = await requestMock(mock, {
        headers: { ...headers, Authorization: "Synthetic invalid" },
      });
      expect(response.status).toBe(401);
      expect(response.body.error.data.stable_code)
        .toBe("INVALID_SYNTHETIC_AUTH_CONTEXT");
    }
  });

  it.each([
    ["missing Accept", { omitHeaders: ["Accept"] }],
    ["JSON-only Accept", { headers: { Accept: "application/json" } }],
    ["SSE-only Accept", { headers: { Accept: "text/event-stream" } }],
    ["wildcard Accept", { headers: { Accept: "*/*" } }],
    ["JSON q=0", {
      headers: {
        Accept: "application/json;q=0, text/event-stream",
      },
    }],
    ["SSE q=0", {
      headers: {
        Accept: "application/json, text/event-stream;q=0",
      },
    }],
    ["malformed quality", {
      headers: {
        Accept: "application/json;q=banana, text/event-stream",
      },
    }],
    ["out-of-range quality", {
      headers: {
        Accept: "application/json;q=2, text/event-stream",
      },
    }],
    ["overprecise quality", {
      headers: {
        Accept: "application/json;q=1.001, text/event-stream",
      },
    }],
    ["negative quality", {
      headers: {
        Accept: "application/json;q=-0.1, text/event-stream",
      },
    }],
    ["duplicate quality", {
      headers: {
        Accept: "application/json;q=1;q=0.8, text/event-stream",
      },
    }],
    ["missing Content-Type", { omitHeaders: ["Content-Type"] }],
    ["Content-Type parameters", {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }],
    ["JSON suffix Content-Type", {
      headers: { "Content-Type": "application/json-patch+json" },
    }],
    ["missing protocol header", {
      omitHeaders: ["MCP-Protocol-Version"],
    }],
    ["missing method header", { omitHeaders: ["Mcp-Method"] }],
    ["wrong method header", {
      headers: { "Mcp-Method": "tools/list" },
    }],
  ])("rejects envelope mutant: %s", async (_label, options) => {
    const before = mock.snapshot();
    const response = await requestMock(mock, options);
    expect(response.status).toBe(400);
    expect(response.body.error.data.stable_code).toBe("HeaderMismatch");
    const after = mock.snapshot();
    expect(after.data_plane).toEqual(before.data_plane);
    expect(after.evidence_plane).toEqual(before.evidence_plane);
    expect(after.transport.dispatches).toBe(before.transport.dispatches);
  });

  it("accepts reversed and whitespace-separated required Accept media types", async () => {
    const response = await requestMock(mock, {
      headers: {
        Accept: " text/event-stream ; q=1 , application/json ; q=0.8 ",
      },
    });
    expect(response.status).toBe(200);
  });

  it("distinguishes unsupported matching protocol from header/body mismatch", async () => {
    const unsupported = requestBody();
    unsupported.params._meta["io.modelcontextprotocol/protocolVersion"] =
      "2025-11-25";
    const response = await requestMock(mock, {
      body: unsupported,
      headers: { "MCP-Protocol-Version": "2025-11-25" },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.data.stable_code)
      .toBe("UnsupportedProtocolVersion");

    const mismatch = await requestMock(mock, {
      headers: { "MCP-Protocol-Version": "2025-11-25" },
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.data.stable_code).toBe("HeaderMismatch");
  });

  it.each([
    ["missing meta", body => delete body.params._meta],
    ["null protocol", body => {
      body.params._meta["io.modelcontextprotocol/protocolVersion"] = null;
    }],
    ["flat clientInfo", body => {
      body.params._meta["io.modelcontextprotocol/clientInfo"] = "client";
    }],
    ["empty client name", body => {
      body.params._meta["io.modelcontextprotocol/clientInfo"].name = "";
    }],
    ["empty client version", body => {
      body.params._meta["io.modelcontextprotocol/clientInfo"].version = "";
    }],
    ["array capabilities", body => {
      body.params._meta[
        "io.modelcontextprotocol/clientCapabilities"
      ] = [];
    }],
  ])("rejects body metadata mutant: %s", async (_label, mutate) => {
    const body = requestBody();
    mutate(body);
    const before = mock.snapshot();
    const response = await requestMock(mock, { body });
    expect(response.status).toBe(400);
    expect(response.body.error.data.stable_code).toBe("HeaderMismatch");
    const after = mock.snapshot();
    expect(after.data_plane).toEqual(before.data_plane);
    expect(after.evidence_plane).toEqual(before.evidence_plane);
    expect(after.transport.dispatches).toBe(before.transport.dispatches);
  });

  it("enforces every declared JSON-domain boundary over the complete envelope", async () => {
    function discoveryWithCapabilities(capabilities) {
      const body = requestBody();
      body.params._meta[
        "io.modelcontextprotocol/clientCapabilities"
      ] = capabilities;
      return body;
    }
    function nestedCapabilities(levels) {
      let value = {};
      for (let index = 0; index < levels; index += 1) {
        value = { nested: value };
      }
      return value;
    }
    const exactMultibyte = "é".repeat(256);
    const acceptedBodies = [
      discoveryWithCapabilities({ value: "x".repeat(512) }),
      discoveryWithCapabilities({ value: exactMultibyte }),
      discoveryWithCapabilities(nestedCapabilities(5)),
      discoveryWithCapabilities(Object.fromEntries(
        Array.from({ length: 118 }, (_, index) => [`key_${index}`, index]),
      )),
      discoveryWithCapabilities({
        values: Array.from({ length: 128 }, (_, index) => index),
      }),
    ];
    for (const body of acceptedBodies) {
      const response = await requestMock(mock, { body });
      expect(response.status).toBe(200);
      expect(response.body.result.resultType).toBe("complete");
    }

    const rejectedBodies = [
      discoveryWithCapabilities({ value: "x".repeat(513) }),
      discoveryWithCapabilities({ value: `${exactMultibyte}x` }),
      discoveryWithCapabilities(nestedCapabilities(6)),
      discoveryWithCapabilities(Object.fromEntries(
        Array.from({ length: 119 }, (_, index) => [`key_${index}`, index]),
      )),
      discoveryWithCapabilities({
        values: Array.from({ length: 129 }, (_, index) => index),
      }),
    ];
    for (const body of rejectedBodies) {
      const before = mock.snapshot();
      const response = await requestMock(mock, { body });
      expect(response.status).toBe(400);
      expect(response.body.error.data.stable_code).toBe("INVALID_REQUEST");
      const after = mock.snapshot();
      expect(after.data_plane).toEqual(before.data_plane);
      expect(after.evidence_plane).toEqual(before.evidence_plane);
      expect(after.transport.dispatches).toBe(before.transport.dispatches);
    }

    const exactName = "n".repeat(512);
    const exactNameResponse = await requestMock(mock, {
      body: requestBody({
        method: "tools/call",
        name: exactName,
      }),
    });
    expect(exactNameResponse.status).toBe(200);
    expect(exactNameResponse.body.result.structuredContent.code)
      .toBe("UNKNOWN_SYNTHETIC_TOOL");

    const beforeLongName = mock.snapshot();
    const longNameResponse = await requestMock(mock, {
      body: requestBody({
        method: "tools/call",
        name: `${exactName}x`,
      }),
    });
    expect(longNameResponse.status).toBe(400);
    expect(longNameResponse.body.error.data.stable_code)
      .toBe("INVALID_REQUEST");
    const afterLongName = mock.snapshot();
    expect(afterLongName.data_plane).toEqual(beforeLongName.data_plane);
    expect(afterLongName.evidence_plane).toEqual(
      beforeLongName.evidence_plane,
    );
    expect(afterLongName.transport.dispatches)
      .toBe(beforeLongName.transport.dispatches);
  });

  it("requires exact Mcp-Name only for named operations", async () => {
    const toolBody = requestBody({
      method: "tools/call",
      name: "create_synthetic_workspace",
      arguments: { workspace_id: "workspace_a" },
    });
    for (const options of [
      { omitHeaders: ["Mcp-Name"] },
      { headers: { "Mcp-Name": "read_operation_receipt" } },
    ]) {
      const before = mock.snapshot();
      const response = await requestMock(mock, { body: toolBody, ...options });
      expect(response.status).toBe(400);
      expect(response.body.error.data.stable_code).toBe("HeaderMismatch");
      expect(mock.snapshot().transport.dispatches)
        .toBe(before.transport.dispatches);
    }
    const surplus = await requestMock(mock, {
      headers: { "Mcp-Name": "surplus" },
    });
    expect(surplus.status).toBe(400);
    expect(surplus.body.error.data.stable_code).toBe("HeaderMismatch");

    const resourceBody = requestBody({
      method: "resources/read",
      uri: "synthetic://document_a/version_1",
    });
    const resource = await requestMock(mock, { body: resourceBody });
    expect(resource.status).toBe(404);
    expect(resource.body.error.data.stable_code).toBe("METHOD_NOT_FOUND");
    const wrongResourceHeader = await requestMock(mock, {
      body: resourceBody,
      headers: { "Mcp-Name": "wrong-uri" },
    });
    expect(wrongResourceHeader.status).toBe(400);
    expect(wrongResourceHeader.body.error.data.stable_code)
      .toBe("HeaderMismatch");
  });

  it("returns stable method and tool errors without lifecycle effects", async () => {
    const before = mock.snapshot();
    const taskBody = requestBody({ method: "tasks/cancel" });
    const task = await requestMock(mock, { body: taskBody });
    expect(task.status).toBe(404);
    expect(task.body.error).toMatchObject({
      code: -32601,
      data: { stable_code: "METHOD_NOT_FOUND" },
    });
    expect(mock.snapshot().data_plane).toEqual(before.data_plane);

    const unknownBody = requestBody({
      method: "tools/call",
      name: "unknown_synthetic_tool",
    });
    const unknown = await requestMock(mock, { body: unknownBody });
    expect(unknown.status).toBe(200);
    expect(unknown.body.result).toMatchObject({
      isError: true,
      structuredContent: { code: "UNKNOWN_SYNTHETIC_TOOL" },
    });
    expect(mock.snapshot().data_plane).toEqual(before.data_plane);
  });

  it("rejects wrong path and method without dispatch", async () => {
    for (const options of [
      { path: "/other" },
      { method: "GET" },
    ]) {
      const before = mock.snapshot();
      const response = await requestMock(mock, options);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe(-32601);
      expect(mock.snapshot().transport.dispatches)
        .toBe(before.transport.dispatches);
    }
  });

  it.each([
    ["unknown authority", value => {
      value.bounded_vertical_slice.production_authorized = true;
    }],
    ["tenant B binding", value => {
      value.bounded_vertical_slice.synthetic_auth_contexts
        .find(context => context.id === "tenant_b_owner").tenant_id =
          "synthetic_tenant_a";
    }],
    ["revoked membership", value => {
      delete value.bounded_vertical_slice.synthetic_auth_contexts
        .find(context => context.id === "tenant_a_revoked").membership;
    }],
    ["transition graph", value => {
      value.bounded_vertical_slice.state_transitions.pop();
    }],
    ["idempotency scope", value => {
      value.bounded_vertical_slice.idempotency_contract.scope =
        "idempotency_key_only";
    }],
    ["error semantics", value => {
      value.bounded_vertical_slice.error_semantics
        .insufficient_scope = "http_200";
    }],
    ["operation inventory", value => {
      value.bounded_vertical_slice.allowed_operations.push(
        "create_authorization_event",
      );
    }],
  ])("rejects frozen architecture mutant before start: %s", async (_label, mutate) => {
    const candidate = structuredClone(CONTRACT);
    mutate(candidate);
    await expect(startRemoteLoopbackMcpMock({ contract: candidate }))
      .rejects.toThrow(/contract mismatch/i);
  });
});
