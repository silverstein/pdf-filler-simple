import http from "node:http";
import net from "node:net";

const META = Object.freeze({
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": Object.freeze({
    name: "pdf-tools-loopback-test",
    version: "1",
  }),
  "io.modelcontextprotocol/clientCapabilities": Object.freeze({}),
});

export function requestBody({
  id = "synthetic-request-1",
  method = "server/discover",
  name,
  uri,
  arguments: args = {},
  meta = META,
} = {}) {
  const params = { _meta: structuredClone(meta) };
  if (name !== undefined) params.name = name;
  if (uri !== undefined) params.uri = uri;
  if (method === "tools/call") params.arguments = structuredClone(args);
  return { jsonrpc: "2.0", id, method, params };
}

export async function requestMock(mock, {
  body = requestBody(),
  headers = {},
  omitHeaders = [],
  method = "POST",
  path = "/mcp",
  rawBody,
} = {}) {
  const encoded = rawBody ?? JSON.stringify(body);
  const defaults = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    "MCP-Protocol-Version":
      body?.params?._meta?.["io.modelcontextprotocol/protocolVersion"] ??
      "2026-07-28",
    "Mcp-Method": body?.method ?? "server/discover",
    Authorization: "Synthetic tenant_a_owner",
  };
  if (
    body?.method === "tools/call" ||
    body?.method === "resources/read" ||
    body?.method === "prompts/get"
  ) {
    defaults["Mcp-Name"] = body?.method === "resources/read"
      ? body?.params?.uri ?? ""
      : body?.params?.name ?? "";
  }
  for (const name of omitHeaders) {
    delete defaults[name];
    delete defaults[
      Object.keys(defaults).find(key => key.toLowerCase() === name.toLowerCase())
    ];
  }
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: mock.host,
      port: mock.port,
      method,
      path,
      headers: {
        ...defaults,
        ...headers,
        "Content-Length": Buffer.byteLength(encoded),
      },
      agent: false,
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const bytes = Buffer.concat(chunks);
        let parsed;
        try {
          parsed = JSON.parse(bytes.toString("utf8"));
        } catch {
          parsed = null;
        }
        resolve({
          status: response.statusCode,
          headers: response.headers,
          bytes,
          body: parsed,
        });
      });
    });
    request.once("error", reject);
    request.end(encoded);
  });
}

export async function rawHttpRequest(mock, rawHeaders, body) {
  const encoded = typeof body === "string" ? body : JSON.stringify(body);
  const lines = [
    "POST /mcp HTTP/1.1",
    `Host: ${mock.host}:${mock.port}`,
    ...rawHeaders,
    `Content-Length: ${Buffer.byteLength(encoded)}`,
    "Connection: close",
    "",
    encoded,
  ];
  return new Promise((resolve, reject) => {
    const socket = net.connect({
      host: mock.host,
      port: mock.port,
    });
    const chunks = [];
    socket.setTimeout(2_000);
    socket.once("connect", () => socket.end(lines.join("\r\n")));
    socket.on("data", chunk => chunks.push(chunk));
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("Raw HTTP response timed out"));
    });
    socket.once("error", reject);
    socket.once("end", () => {
      const response = Buffer.concat(chunks).toString("utf8");
      const [head, payload = ""] = response.split("\r\n\r\n");
      const match = /^HTTP\/1\.1 (\d+)/.exec(head);
      resolve({
        status: match ? Number(match[1]) : null,
        body: payload ? JSON.parse(payload) : null,
        raw: response,
      });
    });
  });
}

export const REMOTE_LOOPBACK_TEST_META = META;
