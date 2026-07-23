import { describe, expect, it, vi } from "vitest";
import { App } from "@modelcontextprotocol/ext-apps";

const JSONRPC = "2.0";
const APP_PROTOCOL_VERSION = "2026-01-26";

function toolResult(text, structuredContent) {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

class TestHostTransport {
  constructor({ failInitialize = false, initialResult = true } = {}) {
    this.failInitialize = failInitialize;
    this.initialResult = initialResult;
    this.sent = [];
    this.requests = [];
    this.notifications = [];
    this.pendingHostRequests = new Map();
    this.nextHostRequestId = 10_000;
    this.started = false;
    this.closed = false;
  }

  async start() {
    this.started = true;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  async send(message) {
    this.sent.push(message);

    if ("method" in message && "id" in message) {
      this.requests.push(message);
      queueMicrotask(() => this.#respondToAppRequest(message));
      return;
    }

    if ("method" in message) {
      this.notifications.push(message);
      if (message.method === "ui/notifications/initialized" && this.initialResult) {
        queueMicrotask(() => {
          this.notify("ui/notifications/tool-result", toolResult(
            "Opening lifecycle.pdf in the PDF Tools viewer.",
            {
              pdfPath: "/fixtures/lifecycle.pdf",
              totalBytes: 5,
              initialPage: 1,
            },
          ));
        });
      }
      return;
    }

    const pending = this.pendingHostRequests.get(message.id);
    if (pending) {
      this.pendingHostRequests.delete(message.id);
      if ("error" in message) pending.reject(message.error);
      else pending.resolve(message.result);
    }
  }

  notify(method, params) {
    this.onmessage?.({ jsonrpc: JSONRPC, method, params });
  }

  emitError(error) {
    this.onerror?.(error);
  }

  request(method, params = {}) {
    const id = this.nextHostRequestId++;
    return new Promise((resolve, reject) => {
      this.pendingHostRequests.set(id, { resolve, reject });
      this.onmessage?.({ jsonrpc: JSONRPC, id, method, params });
    });
  }

  #reply(id, result) {
    this.onmessage?.({ jsonrpc: JSONRPC, id, result });
  }

  #replyError(id, code, message) {
    this.onmessage?.({
      jsonrpc: JSONRPC,
      id,
      error: { code, message },
    });
  }

  #respondToAppRequest(message) {
    switch (message.method) {
      case "ui/initialize":
        if (this.failInitialize) {
          this.#replyError(message.id, -32603, "Host initialization failed");
          return;
        }
        this.#reply(message.id, {
          protocolVersion: APP_PROTOCOL_VERSION,
          hostInfo: { name: "pdf-tools-test-host", version: "1.0.0" },
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
        if (name === "explode") {
          this.#replyError(message.id, -32603, "Synthetic tool failure");
          return;
        }
        if (name === "read_pdf_bytes") {
          this.#reply(message.id, toolResult("Read 5 bytes.", {
            bytes: Buffer.from("%PDF-").toString("base64"),
            totalBytes: 5,
            offset: 0,
            byteCount: 5,
          }));
          return;
        }
        this.#reply(message.id, toolResult(`${name} completed.`));
        return;
      }
      case "resources/read":
        this.#reply(message.id, {
          contents: [{
            uri: message.params.uri,
            mimeType: "application/pdf",
            blob: Buffer.from("%PDF-").toString("base64"),
          }],
        });
        return;
      case "ui/update-model-context":
        this.#reply(message.id, {});
        return;
      case "ui/request-display-mode":
        this.#reply(message.id, { mode: message.params.mode });
        return;
      default:
        this.#replyError(message.id, -32601, `Unsupported host method: ${message.method}`);
    }
  }
}

function createApp() {
  return new App(
    { name: "PDF Tools lifecycle test", version: "1.0.0" },
    {},
    { autoResize: false, strict: true },
  );
}

describe("@modelcontextprotocol/ext-apps lifecycle", () => {
  it("covers initialization, initial result, server access, context, resize, display, and teardown", async () => {
    const app = createApp();
    const host = new TestHostTransport();
    const toolResults = [];
    const hostContexts = [];
    const teardown = vi.fn(async () => ({}));

    app.ontoolresult = result => {
      toolResults.push(result);
    };
    app.onhostcontextchanged = context => {
      hostContexts.push(context);
    };
    app.onteardown = teardown;

    await expect(app.callServerTool({
      name: "read_pdf_bytes",
      arguments: { pdf_path: "/fixtures/lifecycle.pdf", offset: 0, byteCount: 5 },
    })).rejects.toThrow(/before connect\(\) completed/);

    await app.connect(host);
    await vi.waitFor(() => expect(toolResults).toHaveLength(1));

    expect(host.started).toBe(true);
    expect(app.getHostVersion()).toEqual({
      name: "pdf-tools-test-host",
      version: "1.0.0",
    });
    expect(app.getHostContext()).toMatchObject({
      theme: "light",
      displayMode: "inline",
      platform: "desktop",
    });
    expect(toolResults[0].structuredContent).toMatchObject({
      pdfPath: "/fixtures/lifecycle.pdf",
      totalBytes: 5,
    });

    const bytes = await app.callServerTool({
      name: "read_pdf_bytes",
      arguments: { pdf_path: "/fixtures/lifecycle.pdf", offset: 0, byteCount: 5 },
    });
    expect(bytes.structuredContent).toMatchObject({
      bytes: Buffer.from("%PDF-").toString("base64"),
      totalBytes: 5,
    });

    const resource = await app.readServerResource({
      uri: "pdf://local/fixtures/lifecycle.pdf",
    });
    expect(resource.contents[0]).toMatchObject({
      mimeType: "application/pdf",
      blob: Buffer.from("%PDF-").toString("base64"),
    });

    await app.updateModelContext({
      content: [{ type: "text", text: "Lifecycle context" }],
    });
    await app.sendSizeChanged({ width: 800, height: 600 });
    await expect(app.requestDisplayMode({ mode: "fullscreen" })).resolves.toMatchObject({
      mode: "fullscreen",
    });

    host.notify("ui/notifications/host-context-changed", {
      theme: "dark",
      displayMode: "fullscreen",
    });
    await vi.waitFor(() => expect(hostContexts).toHaveLength(1));
    expect(app.getHostContext()).toMatchObject({
      theme: "dark",
      displayMode: "fullscreen",
      availableDisplayModes: ["inline", "fullscreen"],
    });

    await expect(host.request("ui/resource-teardown")).resolves.toEqual({});
    expect(teardown).toHaveBeenCalledOnce();

    expect(host.notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "ui/notifications/initialized" }),
      expect.objectContaining({
        method: "ui/notifications/size-changed",
        params: { width: 800, height: 600 },
      }),
    ]));
    expect(host.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "ui/initialize" }),
      expect.objectContaining({ method: "tools/call" }),
      expect.objectContaining({ method: "resources/read" }),
      expect.objectContaining({ method: "ui/update-model-context" }),
      expect.objectContaining({ method: "ui/request-display-mode" }),
    ]));

    await app.close();
    expect(host.closed).toBe(true);
  });

  it("closes and reconnects the same app without losing handlers", async () => {
    const app = createApp();
    const toolResults = [];
    app.ontoolresult = result => {
      toolResults.push(result);
    };

    const firstHost = new TestHostTransport();
    await app.connect(firstHost);
    await vi.waitFor(() => expect(toolResults).toHaveLength(1));
    await app.close();

    const secondHost = new TestHostTransport();
    await app.connect(secondHost);
    await vi.waitFor(() => expect(toolResults).toHaveLength(2));

    expect(firstHost.requests.filter(request => request.method === "ui/initialize")).toHaveLength(1);
    expect(secondHost.requests.filter(request => request.method === "ui/initialize")).toHaveLength(1);
    await app.close();
  });

  it("propagates request, transport, and initialization failures", async () => {
    const app = createApp();
    const host = new TestHostTransport({ initialResult: false });
    const errors = [];
    app.onerror = error => {
      errors.push(error);
    };

    await app.connect(host);
    await expect(app.callServerTool({ name: "explode", arguments: {} }))
      .rejects.toMatchObject({ code: -32603 });

    const transportError = new Error("Synthetic transport failure");
    host.emitError(transportError);
    expect(errors).toEqual([transportError]);
    await app.close();

    const failingApp = createApp();
    const failingHost = new TestHostTransport({ failInitialize: true });
    await expect(failingApp.connect(failingHost)).rejects.toMatchObject({
      code: -32603,
    });
    expect(failingHost.closed).toBe(true);
  });
});
