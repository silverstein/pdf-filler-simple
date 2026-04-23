import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
const TMP_DIR = path.join(REPO_ROOT, ".test-tmp-render");

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

  beforeAll(async () => {
    await fs.mkdir(TMP_DIR, { recursive: true });
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
    await fs.rm(TMP_DIR, { recursive: true, force: true });
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
    const rotatedPdfPath = path.join(TMP_DIR, "rotated-region.pdf");
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
