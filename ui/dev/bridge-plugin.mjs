import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

function jsonResponse(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
}

export function createMcpBridgePlugin() {
  let client = null;
  let transport = null;
  let starting = null;

  async function ensureClient() {
    if (client) return client;
    if (starting) return starting;

    starting = (async () => {
      client = new Client({ name: "pdf-tools-dev-bridge", version: "1.0.0" });
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(repoRoot, "server", "index.js")],
        cwd: repoRoot,
        stderr: "pipe",
      });

      const stderr = transport.stderr;
      if (stderr) {
        stderr.on("data", (chunk) => {
          process.stderr.write(chunk);
        });
      }

      await client.connect(transport);
      return client;
    })();

    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  return {
    name: "pdf-tools-dev-mcp-bridge",
    apply: "serve",
    async configureServer(server) {
      await ensureClient();

      server.middlewares.use("/__dev__/tool", async (req, res) => {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { error: "Method Not Allowed" });
          return;
        }

        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", async () => {
          try {
            const parsed = JSON.parse(body || "{}");
            const activeClient = await ensureClient();
            const result = await activeClient.callTool({
              name: parsed.name,
              arguments: parsed.arguments || {},
            });
            jsonResponse(res, 200, result);
          } catch (error) {
            jsonResponse(res, 500, {
              content: [{ type: "text", text: `Dev bridge error: ${error.message}` }],
              isError: true,
            });
          }
        });
      });

      server.httpServer?.on("close", async () => {
        try {
          await transport?.close();
        } catch {}
        client = null;
        transport = null;
      });
    },
  };
}
