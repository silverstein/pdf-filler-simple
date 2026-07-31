import path from "path";
import fs from "fs/promises";
import { fileURLToPath, pathToFileURL } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument, degrees, rgb } from "pdf-lib";
import {
  getPageRenderScale,
  getRegionPixelRect,
  validatePdfRegionBox,
} from "../server/helpers.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

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

  it("can downscale below 1 when a bounded render must honor a smaller maximum", () => {
    expect(getPageRenderScale({
      width: 3000,
      height: 500,
      maxDimensionPx: 1400,
      minScale: 0.1,
    })).toBeCloseTo(0.47, 2);
  });
});

describe("PDF region helpers", () => {
  it("validates an in-bounds region", () => {
    expect(() => validatePdfRegionBox({
      pageWidth: 612,
      pageHeight: 792,
      x: 72,
      y: 120,
      width: 180,
      height: 60,
    })).not.toThrow();
  });

  it("rejects an out-of-bounds region", () => {
    expect(() => validatePdfRegionBox({
      pageWidth: 612,
      pageHeight: 792,
      x: 500,
      y: 760,
      width: 200,
      height: 80,
    })).toThrow(/outside page bounds/);
  });

  it("converts point regions to cropped pixel rectangles", () => {
    expect(getRegionPixelRect({
      x: 72,
      y: 120,
      width: 180,
      height: 60,
      scale: 2,
    })).toEqual({
      left: 144,
      top: 240,
      width: 360,
      height: 120,
    });
  });
});

describe("render_pdf_page MCP tool", () => {
  let client;
  let transport;
  let tempDirectory;

  beforeAll(async () => {
    tempDirectory = await createTestTempDirectory(REPO_ROOT, "render");
    client = new Client({ name: "pdf-tools-test-client", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server", "index.js")],
      cwd: REPO_ROOT,
      env: {
        ALLOWED_DIRECTORIES: REPO_ROOT,
      },
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    try {
      await transport?.close();
    } finally {
      await removeTestTempDirectory(tempDirectory);
    }
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

  it("renders a bounded region using top-left point coordinates", async () => {
    const result = await client.callTool({
      name: "render_pdf_region",
      arguments: {
        pdf_path: EXAMPLE_PDF,
        page: 1,
        x: 72,
        y: 120,
        width: 180,
        height: 60,
        max_dimension_px: 1000,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content.some(item => item.type === "image" && item.mimeType === "image/png")).toBe(true);
    expect(result.structuredContent).toMatchObject({
      pdf_path: EXAMPLE_PDF,
      page: 1,
      total_pages: 4,
      region_points: {
        x: 72,
        y: 120,
        width: 180,
        height: 60,
      },
      mime_type: "image/png",
    });
    expect(result.structuredContent.rendered_width_px).toBeGreaterThan(0);
    expect(result.structuredContent.rendered_height_px).toBeGreaterThan(0);
  }, 30_000);

  it("keeps region coordinates aligned on rotated pages by rendering in native page space", async () => {
    const rotatedPdfPath = path.join(tempDirectory, "rotated-region.pdf");
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    page.drawRectangle({
      x: 30,
      y: 230,
      width: 80,
      height: 40,
      color: rgb(1, 0, 0),
    });
    page.setRotation(degrees(90));
    await fs.writeFile(rotatedPdfPath, await doc.save());

    const result = await client.callTool({
      name: "render_pdf_region",
      arguments: {
        pdf_path: rotatedPdfPath,
        page: 1,
        x: 30,
        y: 30,
        width: 80,
        height: 40,
        max_dimension_px: 400,
      },
    });

    expect(result.isError).not.toBe(true);
    const imageItem = result.content.find(item => item.type === "image");
    expect(imageItem?.mimeType).toBe("image/png");

    const image = await loadImage(Buffer.from(imageItem.data, "base64"));
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, image.width, image.height);
    const center = ctx.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data;

    expect(center[0]).toBeGreaterThan(200);
    expect(center[1]).toBeLessThan(80);
    expect(center[2]).toBeLessThan(80);
  }, 30_000);
});

describe("Claude Desktop Electron utility rendering", () => {
  let client;
  let transport;
  let imageOnlyPdfPath;
  let electronTempDirectory;

  beforeAll(async () => {
    electronTempDirectory = await createTestTempDirectory(REPO_ROOT, "electron-render");
    const sourceCanvas = createCanvas(200, 100);
    const sourceContext = sourceCanvas.getContext("2d");
    sourceContext.fillStyle = "#ffffff";
    sourceContext.fillRect(0, 0, 200, 100);
    sourceContext.fillStyle = "#d02020";
    sourceContext.fillRect(40, 20, 120, 60);

    const imageOnlyDoc = await PDFDocument.create();
    const imageOnlyPage = imageOnlyDoc.addPage([200, 100]);
    const image = await imageOnlyDoc.embedPng(sourceCanvas.toBuffer("image/png"));
    imageOnlyPage.drawImage(image, { x: 0, y: 0, width: 200, height: 100 });
    imageOnlyPdfPath = path.join(electronTempDirectory, "image-only.pdf");
    await fs.writeFile(imageOnlyPdfPath, await imageOnlyDoc.save());

    const serverUrl = pathToFileURL(path.join(REPO_ROOT, "server", "index.js")).href;
    const bootstrap = [
      'process.type = "utility";',
      'Object.defineProperty(process.versions, "electron", { value: "test", configurable: true });',
      `await import(${JSON.stringify(serverUrl)});`,
    ].join(" ");

    client = new Client({ name: "pdf-tools-electron-utility-test-client", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--input-type=module", "--eval", bootstrap],
      cwd: REPO_ROOT,
      env: {
        ALLOWED_DIRECTORIES: REPO_ROOT,
        PDF_TOOLS_DISABLE_SYSTEM_RENDERER: "1",
      },
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    try {
      await transport?.close();
    } finally {
      await removeTestTempDirectory(electronTempDirectory);
    }
  });

  // This describe runs an embedded Electron host with the system renderer
  // disabled, which models a host that has no macOS sips fallback. Embedded
  // hosts block the native canvas binding, so rendering is unavailable there
  // by design. These assert that the failure is explicit and truthful rather
  // than a misleading dependency-reinstall suggestion.
  it("reports an explicit unavailable renderer instead of a dependency error", async () => {
    const result = await client.callTool({
      name: "render_pdf_page",
      arguments: {
        pdf_path: EXAMPLE_PDF,
        page: 1,
        max_dimension_px: 1200,
      },
    });

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("No PDF page renderer is available in this host");
    expect(text).not.toContain("npm has a bug");
    expect(text).not.toContain("removing both package-lock.json");
  }, 30_000);

  it("reports the same explicit failure for bounded regions", async () => {
    const result = await client.callTool({
      name: "render_pdf_region",
      arguments: {
        pdf_path: EXAMPLE_PDF,
        page: 1,
        x: 72,
        y: 120,
        width: 180,
        height: 60,
        max_dimension_px: 1000,
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("No PDF page renderer is available in this host");
  }, 30_000);

  it("does not claim a rendered image when no renderer exists", async () => {
    const result = await client.callTool({
      name: "read_pdf_content",
      arguments: {
        pdf_path: imageOnlyPdfPath,
        max_pages: 1,
      },
    });

    // Without a renderer the image fallback cannot produce a page image, so
    // the text-layer result stands on its own rather than silently claiming a
    // rendered image.
    expect(result.structuredContent?.image_renderer).not.toBe("native-canvas");
  }, 30_000);
});

// Claude Desktop on macOS is an embedded Electron host WITH the system
// renderer available. That is the shipped path, so it is pinned separately
// from the no-fallback host above.
describe.runIf(process.platform === "darwin")("Claude Desktop Electron utility rendering with a system fallback", () => {
  let client;
  let transport;

  beforeAll(async () => {
    const serverUrl = pathToFileURL(path.join(REPO_ROOT, "server", "index.js")).href;
    const bootstrap = [
      'process.type = "utility";',
      'Object.defineProperty(process.versions, "electron", { value: "test", configurable: true });',
      `await import(${JSON.stringify(serverUrl)});`,
    ].join(" ");
    client = new Client({ name: "pdf-tools-electron-fallback-client", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--input-type=module", "--eval", bootstrap],
      cwd: REPO_ROOT,
      env: { ALLOWED_DIRECTORIES: REPO_ROOT },
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await transport?.close();
  });

  it("renders through the system renderer rather than the blocked native binding", async () => {
    const result = await client.callTool({
      name: "render_pdf_page",
      arguments: { pdf_path: EXAMPLE_PDF, page: 1, max_dimension_px: 800 },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ page: 1, renderer: "macos-sips" });
    expect(result.content.some(item => item.type === "image" && item.mimeType === "image/png")).toBe(true);
  }, 30_000);
});
