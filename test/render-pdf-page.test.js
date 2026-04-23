import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getPageRenderScale } from "../server/helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");

describe("getPageRenderScale", () => {
  it("bounds the scale to the requested dominant dimension", () => {
    expect(getPageRenderScale({ width: 612, height: 792, maxDimensionPx: 1584 })).toBe(2);
  });

  it("respects the configured maxScale ceiling", () => {
    expect(getPageRenderScale({ width: 100, height: 200, maxDimensionPx: 5000, maxScale: 2.5 })).toBe(2.5);
  });
});

describe("render_pdf_page MCP tool", () => {
  let client;
  let transport;

  beforeAll(async () => {
    client = new Client({ name: "pdf-tools-test-client", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server", "index.js")],
      cwd: REPO_ROOT,
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await transport?.close();
  });

  it("is listed and returns a rendered PNG plus structured metadata", async () => {
    const tools = await client.listTools();
    expect(tools.tools.some(tool => tool.name === "render_pdf_page")).toBe(true);

    const result = await client.callTool({
      name: "render_pdf_page",
      arguments: {
        pdf_path: EXAMPLE_PDF,
        page: 1,
        max_dimension_px: 1200,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content.some(item => item.type === "image" && item.mimeType === "image/png")).toBe(true);
    expect(result.structuredContent).toMatchObject({
      pdf_path: EXAMPLE_PDF,
      page: 1,
      total_pages: 4,
      mime_type: "image/png",
    });
    expect(result.structuredContent.rendered_width_px).toBeGreaterThan(0);
    expect(result.structuredContent.rendered_height_px).toBeGreaterThan(0);
    expect(result.structuredContent.scale).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
