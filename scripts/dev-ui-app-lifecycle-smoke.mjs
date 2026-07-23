import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {
  createAgentBrowserSessionRunner,
  evalJson,
} from "./dev-ui-smoke-helpers.mjs";

const repoRoot = process.cwd();
const port = Number(process.env.PDF_TOOLS_APP_LIFECYCLE_PORT || 4182);
const origin = `http://127.0.0.1:${port}`;
const session = `pdf-tools-app-lifecycle-${Date.now()}`;
const runAgentBrowser = createAgentBrowserSessionRunner(session);
const viewerHtml = await fs.readFile(path.join(repoRoot, "dist-ui", "index.html"));
const fixtureBytes = await fs.readFile(path.join(repoRoot, "example-fw9.pdf"));

function hostHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>PDF Tools MCP Apps lifecycle host</title>
  <style>
    html, body { margin: 0; min-height: 100%; background: #eee; }
    iframe { width: 1000px; height: 900px; border: 0; background: white; }
  </style>
</head>
<body>
  <main id="frame-root"></main>
  <script>
    (() => {
      const state = {
        resourceLoads: 0,
        initializeCount: 0,
        initializedCount: 0,
        initialToolResults: 0,
        readBytesCalls: 0,
        setActiveDocumentCalls: 0,
        modelContextCalls: 0,
        sizeChanges: [],
        displayModeRequests: [],
        teardownRequests: 0,
        teardownAcks: 0,
        protocolErrorsSent: 0,
      };
      let frame = null;
      let fixture = null;
      let nextHostRequestId = 10000;
      const pendingHostRequests = new Map();

      const fixturePromise = fetch("/fixture.pdf")
        .then(response => {
          if (!response.ok) throw new Error("Fixture fetch failed: " + response.status);
          state.resourceLoads++;
          return response.arrayBuffer();
        })
        .then(buffer => {
          fixture = new Uint8Array(buffer);
          return fixture;
        });

      function send(message) {
        frame?.contentWindow?.postMessage(message, "*");
      }

      function reply(id, result) {
        send({ jsonrpc: "2.0", id, result });
      }

      function replyError(id, code, message) {
        send({ jsonrpc: "2.0", id, error: { code, message } });
      }

      function encodeBase64(bytes) {
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return btoa(binary);
      }

      async function sendInitialToolResult() {
        const bytes = await fixturePromise;
        state.initialToolResults++;
        send({
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: {
            content: [{
              type: "text",
              text: "Opening lifecycle.pdf in the PDF Tools viewer.",
            }],
            structuredContent: {
              pdfPath: "/fixtures/lifecycle.pdf",
              totalBytes: bytes.length,
              initialPage: 1,
            },
            _meta: {
              ui: { resourceUri: "ui://pdf-toolkit/viewer" },
              pdfPath: "/fixtures/lifecycle.pdf",
              totalBytes: bytes.length,
              initialPage: 1,
            },
          },
        });
      }

      async function handleRequest(message) {
        switch (message.method) {
          case "ui/initialize":
            state.initializeCount++;
            reply(message.id, {
              protocolVersion: "2026-01-26",
              hostInfo: {
                name: "pdf-tools-built-lifecycle-host",
                version: "1.0.0",
              },
              hostCapabilities: {
                serverTools: {},
                serverResources: {},
                updateModelContext: { text: {} },
              },
              hostContext: {
                theme: "light",
                styles: {
                  variables: {
                    "--color-background-primary": "rgb(250, 250, 250)",
                  },
                },
                displayMode: "inline",
                availableDisplayModes: ["inline", "fullscreen"],
                platform: "desktop",
              },
            });
            return;
          case "tools/call": {
            const name = message.params.name;
            const args = message.params.arguments || {};
            if (name === "read_pdf_bytes") {
              const bytes = await fixturePromise;
              const begin = Math.max(0, Number(args.offset) || 0);
              const end = Math.min(bytes.length, begin + Math.max(0, Number(args.byteCount) || 0));
              state.readBytesCalls++;
              reply(message.id, {
                content: [{ type: "text", text: "Read PDF bytes." }],
                structuredContent: {
                  bytes: encodeBase64(bytes.subarray(begin, end)),
                  totalBytes: bytes.length,
                  offset: begin,
                  byteCount: end - begin,
                },
              });
              return;
            }
            if (name === "set_active_document") {
              state.setActiveDocumentCalls++;
              reply(message.id, {
                content: [{ type: "text", text: "Active document updated." }],
              });
              return;
            }
            replyError(message.id, -32601, "Unsupported test tool: " + name);
            return;
          }
          case "ui/update-model-context":
            state.modelContextCalls++;
            reply(message.id, {});
            return;
          case "ui/request-display-mode":
            state.displayModeRequests.push(message.params.mode);
            reply(message.id, { mode: message.params.mode });
            send({
              jsonrpc: "2.0",
              method: "ui/notifications/host-context-changed",
              params: { displayMode: message.params.mode },
            });
            return;
          default:
            replyError(message.id, -32601, "Unsupported host method: " + message.method);
        }
      }

      window.addEventListener("message", event => {
        if (!frame || event.source !== frame.contentWindow) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;

        if ("method" in message && "id" in message) {
          void handleRequest(message);
          return;
        }
        if ("method" in message) {
          if (message.method === "ui/notifications/initialized") {
            state.initializedCount++;
            void sendInitialToolResult();
          } else if (message.method === "ui/notifications/size-changed") {
            state.sizeChanges.push(message.params);
          }
          return;
        }

        const pending = pendingHostRequests.get(message.id);
        if (!pending) return;
        pendingHostRequests.delete(message.id);
        if ("error" in message) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      });

      function createFrame() {
        frame = document.createElement("iframe");
        frame.id = "viewer-frame";
        frame.src = "/viewer";
        document.getElementById("frame-root").replaceChildren(frame);
      }

      function request(method, params = {}) {
        const id = nextHostRequestId++;
        return new Promise((resolve, reject) => {
          pendingHostRequests.set(id, { resolve, reject });
          send({ jsonrpc: "2.0", id, method, params });
        });
      }

      async function teardown() {
        state.teardownRequests++;
        const result = await request("ui/resource-teardown");
        state.teardownAcks++;
        return result;
      }

      async function reopen() {
        await teardown();
        frame.remove();
        frame = null;
        await new Promise(resolve => setTimeout(resolve, 50));
        createFrame();
      }

      function changeTheme(theme) {
        send({
          jsonrpc: "2.0",
          method: "ui/notifications/host-context-changed",
          params: {
            theme,
            styles: {
              variables: {
                "--color-background-primary": theme === "dark"
                  ? "rgb(17, 17, 17)"
                  : "rgb(250, 250, 250)",
              },
            },
          },
        });
      }

      function sendProtocolError() {
        state.protocolErrorsSent++;
        send({ jsonrpc: "2.0", method: 42, params: {} });
      }

      function viewerSnapshot() {
        const doc = frame?.contentDocument;
        const canvas = doc?.getElementById("pdf-canvas");
        const error = doc?.getElementById("error");
        return {
          readyState: doc?.readyState || null,
          theme: doc?.documentElement.getAttribute("data-theme") || null,
          background: doc?.documentElement.style.getPropertyValue("--color-background-primary") || null,
          title: doc?.getElementById("pdf-title")?.textContent || null,
          canvasWidth: canvas?.width || 0,
          canvasHeight: canvas?.height || 0,
          errorVisible: error?.style.display === "block",
          errorText: doc?.getElementById("error-message")?.textContent || "",
        };
      }

      window.__hostApi = {
        snapshot: () => JSON.parse(JSON.stringify(state)),
        viewerSnapshot,
        clickFullscreen: () => frame.contentDocument.getElementById("fullscreen-btn").click(),
        changeTheme,
        teardown,
        reopen,
        sendProtocolError,
      };
      createFrame();
    })();
  </script>
</body>
</html>`;
}

const server = http.createServer((request, response) => {
  if (request.url === "/" || request.url === "/index.html") {
    const body = Buffer.from(hostHtml());
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": body.length,
      "cache-control": "no-store",
    });
    response.end(body);
    return;
  }
  if (request.url === "/viewer") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": viewerHtml.length,
      "cache-control": "no-store",
    });
    response.end(viewerHtml);
    return;
  }
  if (request.url === "/fixture.pdf") {
    response.writeHead(200, {
      "content-type": "application/pdf",
      "content-length": fixtureBytes.length,
      "cache-control": "no-store",
    });
    response.end(fixtureBytes);
    return;
  }
  response.writeHead(404);
  response.end();
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, message, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let value;
  while (Date.now() - startedAt < timeoutMs) {
    value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`${message}. Last value: ${JSON.stringify(value)}`);
}

async function closeBrowserSession() {
  try {
    await runAgentBrowser(["close"]);
  } catch {
    // Best-effort cleanup.
  }
}

async function main() {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  try {
    await runAgentBrowser(["open", origin]);

    const firstState = await waitFor(async () => {
      const state = await evalJson(runAgentBrowser, "JSON.stringify(window.__hostApi.snapshot())");
      return state.initializeCount === 1 &&
        state.initializedCount === 1 &&
        state.initialToolResults === 1 &&
        state.readBytesCalls > 0 &&
        state.setActiveDocumentCalls > 0 &&
        state.modelContextCalls > 0 &&
        state.sizeChanges.length > 0
        ? state
        : null;
    }, "The first built-viewer lifecycle did not become ready");

    const firstViewer = await evalJson(
      runAgentBrowser,
      "JSON.stringify(window.__hostApi.viewerSnapshot())",
    );
    assert(firstState.resourceLoads === 1, "The host did not fetch the PDF resource exactly once.");
    assert(firstViewer.readyState === "complete", "The built viewer iframe did not finish loading.");
    assert(firstViewer.theme === "light", "The initial host theme was not applied.");
    assert(
      firstViewer.background === "rgb(250, 250, 250)",
      "The initial host style variables were not applied.",
    );
    assert(firstViewer.title === "lifecycle.pdf", "The initial tool result did not load the target PDF.");
    assert(
      firstViewer.canvasWidth > 0 && firstViewer.canvasHeight > 0,
      "The built viewer did not produce a nonzero PDF canvas.",
    );
    assert(!firstViewer.errorVisible, `The built viewer showed an error: ${firstViewer.errorText}`);

    await runAgentBrowser(["eval", "window.__hostApi.clickFullscreen()"]);
    await waitFor(async () => {
      const state = await evalJson(runAgentBrowser, "JSON.stringify(window.__hostApi.snapshot())");
      return state.displayModeRequests.includes("fullscreen") ? state : null;
    }, "The fullscreen request did not reach the host");

    await runAgentBrowser(["eval", "window.__hostApi.changeTheme('dark')"]);
    const darkViewer = await waitFor(async () => {
      const snapshot = await evalJson(
        runAgentBrowser,
        "JSON.stringify(window.__hostApi.viewerSnapshot())",
      );
      return snapshot.theme === "dark" ? snapshot : null;
    }, "The changed host theme did not reach the viewer");
    assert(
      darkViewer.background === "rgb(17, 17, 17)",
      "Changed host style variables were not applied.",
    );

    await runAgentBrowser(["eval", "window.__hostApi.reopen()"]);
    await waitFor(async () => {
      const state = await evalJson(runAgentBrowser, "JSON.stringify(window.__hostApi.snapshot())");
      return state.teardownAcks === 1 &&
        state.initializeCount === 2 &&
        state.initializedCount === 2 &&
        state.initialToolResults === 2
        ? state
        : null;
    }, "The built viewer did not acknowledge teardown and reconnect after reopen");

    await runAgentBrowser(["eval", "window.__hostApi.sendProtocolError()"]);
    const errorViewer = await waitFor(async () => {
      const snapshot = await evalJson(
        runAgentBrowser,
        "JSON.stringify(window.__hostApi.viewerSnapshot())",
      );
      return snapshot.errorVisible ? snapshot : null;
    }, "A transport parse error did not propagate to the viewer");
    assert(
      errorViewer.errorText.includes("Invalid JSON-RPC message"),
      `Unexpected viewer transport error: ${errorViewer.errorText}`,
    );

    await runAgentBrowser(["eval", "window.__hostApi.teardown()"]);
    const finalState = await waitFor(async () => {
      const state = await evalJson(runAgentBrowser, "JSON.stringify(window.__hostApi.snapshot())");
      return state.teardownAcks === 2 ? state : null;
    }, "The final teardown was not acknowledged");

    console.log(JSON.stringify({
      status: "pass",
      host: process.platform,
      lifecycle: finalState,
      firstViewer,
      darkViewer,
      errorViewer,
    }, null, 2));
  } finally {
    await closeBrowserSession();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(`\n[ui-app-lifecycle-smoke] FAILED: ${error.message}`);
  process.exitCode = 1;
});
