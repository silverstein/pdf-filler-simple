import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  extractPdfLayout,
  validatePdfLayoutSemantics,
  validatePdfLayoutSourceEvidence,
} from "../server/layout-extraction.js";
import {
  TOOL_OUTPUT_SCHEMAS,
  TOOL_SUCCESS_OUTPUT_SCHEMAS,
  validateStructuredToolResult,
} from "../server/output-schemas.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TWO_COLUMN = path.join(REPO_ROOT, "test/fixtures/eval/extraction/synthetic/two-column-order.pdf");
const MIXED = path.join(REPO_ROOT, "test/fixtures/eval/extraction/synthetic/mixed-text-raster.pdf");
const ROTATED_CROP = path.join(REPO_ROOT, "test/fixtures/golden-forms/rotated-signature.pdf");
const ENCRYPTED_LAYOUT = path.join(REPO_ROOT, "test/fixtures/eval/extraction/oracles/layout-encrypted-qpdf-r4.pdf");
const ENCRYPTED_LAYOUT_PROVENANCE = path.join(REPO_ROOT, "test/fixtures/eval/extraction/oracles/layout-encrypted-qpdf-r4.provenance.json");
const STDERR_SENTINEL_HELPER = path.join(REPO_ROOT, "test/helpers/mcp-stderr-sentinel.mjs");
const RAW_PAGE_SPACE = { basis: "pdf_default_user_space", unit: "pdf_user_unit", stage: "before_user_unit_and_page_rotation" };
const ITEM_SPACE = { origin: "top_left", unit: "points_1_72_in_after_user_unit", reference_box: "pdfjs_display_viewport" };
const HORIZONTAL_GEOMETRY_PROVENANCE = {
  formula: "pdfjs_text_item_style_metric_advance_box_approximation",
  quad_order: "anchor_top_terminal_top_anchor_bottom_terminal_bottom",
  advance_source: "item_width",
  ascent_source: "style_ascent",
  ascent_ratio: 0.905,
};

function multiply(left, right) {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function textItem({ text, x, top, width = 60, direction = "ltr", hasEOL = true, transform = null }) {
  return {
    str: text,
    dir: direction,
    width,
    height: 12,
    transform: transform ?? [12, 0, 0, 12, x, 792 - top - 12],
    fontName: "f1",
    hasEOL,
  };
}

async function pdfBytes(pageCount = 1) {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) document.addPage([612, 792]);
  return document.save({ useObjectStreams: false });
}

function fakePdfjs(pageConfigs, { requiredPassword = null, neverLoad = false } = {}) {
  const state = { loading_destroyed: false, document_destroyed: false, page_cleanups: 0, document_options: null };
  const pages = pageConfigs.map(config => ({
    view: config.view ?? [0, 0, 612, 792],
    userUnit: config.userUnit ?? 1,
    rotate: config.rotate ?? 0,
    getViewport: () => config.viewport ?? { scale: 1, width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] },
    getTextContent: async () => {
      if (config.textError) throw config.textError;
      return {
        items: config.items ?? [],
        styles: config.styles ?? { f1: { fontFamily: "Test Sans", ascent: 0.8, descent: -0.2, vertical: false } },
      };
    },
    getOperatorList: async () => {
      if (config.operatorError) throw config.operatorError;
      return { fnArray: config.operations ?? [] };
    },
    cleanup: () => { state.page_cleanups += 1; },
  }));
  const pdfjs = {
    version: "5.4.624",
    PasswordResponses: { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 },
    OPS: { paintImageXObject: 1, constructPath: 2, fill: 3 },
    Util: { transform: multiply },
    getDocument: documentOptions => {
      state.document_options = documentOptions;
      const { password } = documentOptions;
      const loadingTask = {
        destroy: async () => { state.loading_destroyed = true; },
      };
      if (neverLoad) loadingTask.promise = new Promise(() => {});
      else if (requiredPassword !== null && password !== requiredPassword) {
        const error = new Error("Synthetic password failure");
        error.name = "PasswordException";
        error.code = password ? 2 : 1;
        loadingTask.promise = Promise.reject(error);
      } else {
        loadingTask.promise = Promise.resolve({
          numPages: pages.length,
          getPage: async pageNumber => pages[pageNumber - 1],
          destroy: async () => { state.document_destroyed = true; },
        });
      }
      return loadingTask;
    },
  };
  return { pdfjs, state };
}

function instrumentRealPdfjs(actualPdfjs) {
  const state = { loading_destroyed: 0, document_destroyed: 0, page_cleanups: 0 };
  const bind = (target, value) => typeof value === "function" ? value.bind(target) : value;
  const wrapPage = page => new Proxy(page, {
    get(target, property) {
      if (property === "cleanup") {
        return (...args) => {
          state.page_cleanups += 1;
          return target.cleanup(...args);
        };
      }
      return bind(target, Reflect.get(target, property, target));
    },
  });
  const wrapDocument = document => new Proxy(document, {
    get(target, property) {
      if (property === "getPage") return async pageNumber => wrapPage(await target.getPage(pageNumber));
      if (property === "destroy") {
        return async (...args) => {
          state.document_destroyed += 1;
          return target.destroy(...args);
        };
      }
      return bind(target, Reflect.get(target, property, target));
    },
  });
  return {
    state,
    pdfjs: {
      ...actualPdfjs,
      getDocument(options) {
        const loadingTask = actualPdfjs.getDocument(options);
        return new Proxy(loadingTask, {
          get(target, property) {
            if (property === "promise") return target.promise.then(wrapDocument);
            if (property === "destroy") {
              return async (...args) => {
                state.loading_destroyed += 1;
                return target.destroy(...args);
              };
            }
            return bind(target, Reflect.get(target, property, target));
          },
        });
      },
    },
  };
}

function completeErrorSurface(error) {
  if (!error) return null;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: error.code,
    data: error.data,
    cause: completeErrorSurface(error.cause),
    enumerable: { ...error },
  };
}

async function runFake(pageConfigs, options = {}) {
  const bytes = options.pdfBytes ?? await pdfBytes(pageConfigs.length);
  const { pdfjs, state } = fakePdfjs(pageConfigs, options.fakeOptions);
  const result = await extractPdfLayout({
    pdfjsLib: pdfjs,
    pdfBytes: bytes,
    sourcePath: "/synthetic/fake.pdf",
    sourceFileName: "fake.pdf",
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    requestedStartPage: options.startPage ?? 1,
    requestedEndPage: options.endPage ?? pageConfigs.length,
    maxItems: options.maxItems ?? 1000,
    maxCharacters: options.maxCharacters ?? 50000,
    maxOutputCharacters: options.maxOutputCharacters ?? 200000,
    deadlineMs: options.deadlineMs ?? 20000,
    password: options.password ?? null,
  });
  return { result, state, bytes };
}

function shiftPageGeometryX(page, delta) {
  for (const item of page.raw_items) {
    item.quad = item.quad.map(point => ({ ...point, x: point.x + delta }));
    item.bbox.x += delta;
    item.x += delta;
  }
  for (const line of page.lines) line.x += delta;
  page.spatial_text = page.lines
    .map(line => `[${line.id} x=${line.x} y=${line.y} w=${line.width} h=${line.height}] ${line.text}`)
    .join("\n");
}

describe("read_pdf_layout MCP tool", () => {
  let client;
  let transport;
  let temporaryRoot;

  beforeAll(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-layout-"));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: { ALLOWED_DIRECTORIES: [REPO_ROOT, temporaryRoot].join(path.delimiter) },
      stderr: "ignore",
    });
    client = new Client({ name: "pdf-layout-test", version: "1.0.0" });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  it("discovers a strict read-only v1 contract and returns deterministic bytes and IDs", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find(entry => entry.name === "read_pdf_layout");
    expect(tool).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: TOOL_OUTPUT_SCHEMAS.read_pdf_layout,
    });
    const request = { name: "read_pdf_layout", arguments: { pdf_path: TWO_COLUMN, max_output_characters: 200000 } };
    const first = await client.callTool(request);
    const second = await client.callTool(request);
    expect(first.isError).not.toBe(true);
    expect(JSON.stringify(first.structuredContent)).toBe(JSON.stringify(second.structuredContent));
    expect(first.structuredContent).toMatchObject({
      ir: { name: "pdf-tools.extraction-ir", version: "1.0.0" },
      parser: { name: "pdfjs-dist", version: "5.4.624" },
      source: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      id_scope: {
        kind: "source_parser_ir_options",
        source_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        parser_version: "5.4.624",
        ir_version: "1.0.0",
        max_output_characters: 200000,
      },
      page_range: { requested_start_page: 1, requested_end_page: 1, start_page: 1, end_page: 1, total_pages: 1 },
    });
    expect(first.structuredContent.source.size_bytes).toBe((await fs.stat(TWO_COLUMN)).size);
    expect(first.structuredContent.source.sha256).toBe(
      createHash("sha256").update(await fs.readFile(TWO_COLUMN)).digest("hex"),
    );
    const rawItems = first.structuredContent.pages[0].raw_items;
    expect(rawItems.map(item => item.source_index)).toEqual([...rawItems.keys()]);
    expect(new Set(rawItems.map(item => item.id)).size).toBe(rawItems.length);
    expect(first.content[0].text).toContain("not interchangeable with render_pdf_region or signing coordinates");
    expect(first.structuredContent.pages[0].flow_text.split("\n")).toEqual([
      "TWO COLUMN NOTICE",
      "LEFT-1 Coverage begins July 1.",
      "LEFT-2 Claims close July 31.",
      "RIGHT-1 Review starts August 2.",
      "RIGHT-2 Decision follows review.",
    ]);
  });

  it("keeps mixed image-only candidates and visual-inspection gaps explicit", async () => {
    const result = await client.callTool({
      name: "read_pdf_layout",
      arguments: { pdf_path: MIXED, start_page: 1, end_page: 2, max_output_characters: 200000 },
    });
    expect(result.structuredContent.extraction_status).toBe("partial");
    expect(result.structuredContent.pages[0]).toMatchObject({ text_layer_status: "present" });
    expect(result.structuredContent.pages[1]).toMatchObject({
      text_layer_status: "empty",
      modality_hint: "image-only-candidate",
      extraction_status: "partial",
      needs_visual_inspection: true,
    });
    expect(result.structuredContent.pages[1].limitations.join(" ")).toContain("not raster-content proof");
  });

  it("preserves rotated CropBox and PDF.js viewport geometry without coordinate aliasing", async () => {
    const result = await client.callTool({ name: "read_pdf_layout", arguments: { pdf_path: ROTATED_CROP, max_output_characters: 200000 } });
    const page = result.structuredContent.pages[0];
    expect(page.geometry).toEqual({
      page: 1,
      media_box: { x: 0, y: 0, width: 480, height: 360 },
      crop_box: { x: 20, y: 24, width: 430, height: 300 },
      pdfjs_view: [20, 24, 450, 324],
      user_unit: 1,
      raw_pdf_rotation: 90,
      display_rotation: 90,
      rotation_matches_raw: true,
      display_width: 300,
      display_height: 430,
      viewport_transform: [0, 1, 1, 0, -24, -20],
      raw_page_space: { basis: "pdf_default_user_space", unit: "pdf_user_unit", stage: "before_user_unit_and_page_rotation" },
      item_space: { origin: "top_left", unit: "points_1_72_in_after_user_unit", reference_box: "pdfjs_display_viewport" },
    });
    for (const point of page.raw_items[0].quad) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(page.geometry.display_width);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(page.geometry.display_height);
    }
  });

  it("binds hand-audited real-PDF item geometry across rotations, CropBox, and UserUnit", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (const rotation of [0, 90, 180, 270]) {
      const page = document.addPage([200, 300]);
      page.setRotation(degrees(rotation));
      page.drawText("X", { x: 72, y: 100, size: 12, font });
    }
    const offset = document.addPage([420, 540]);
    offset.setMediaBox(10, 20, 400, 500);
    offset.setCropBox(30, 40, 300, 400);
    offset.node.set(PDFName.of("UserUnit"), PDFNumber.of(2));
    offset.drawText("X", { x: 72, y: 100, size: 12, font });
    const offsetUnit1 = document.addPage([420, 540]);
    offsetUnit1.setMediaBox(10, 20, 400, 500);
    offsetUnit1.setCropBox(30, 40, 300, 400);
    offsetUnit1.drawText("X", { x: 72, y: 100, size: 12, font });
    for (const [rotation, userUnit] of [[0, 1], [90, 1.3335], [180, 1.9995], [270, 2]]) {
      const hostile = document.addPage([400, 500]);
      hostile.setMediaBox(-100.5, -50.75, 400.75, 500.5);
      hostile.setCropBox(-80.125, -30.375, 300.5, 400.25);
      hostile.setRotation(degrees(rotation));
      hostile.node.set(PDFName.of("UserUnit"), PDFNumber.of(userUnit));
      hostile.drawText("X", { x: 72, y: 100, size: 12, font });
    }
    const fixture = path.join(temporaryRoot, "rotations-userunit.pdf");
    await fs.writeFile(fixture, await document.save({ useObjectStreams: false }));

    const rotations = await client.callTool({ name: "read_pdf_layout", arguments: { pdf_path: fixture, start_page: 1, end_page: 4, max_output_characters: 200000 } });
    // Independent arithmetic oracle, not a snapshot of read_pdf_layout:
    // PDF.js supplies raw [12, 0, 0, 12, 72, 100], width 8.004, height 12,
    // and ascent 0.905 after the contract's three-decimal normalization. Each
    // literal quad below is viewport * raw, with top offset 12 * 0.905 = 10.86.
    const expectedRotationGeometry = [
      {
        page: 1,
        rotation: 0,
        display_width: 200,
        display_height: 300,
        viewport_transform: [1, 0, 0, -1, 0, 300],
        quad: [{ x: 72, y: 189.14 }, { x: 80.004, y: 189.14 }, { x: 72, y: 201.14 }, { x: 80.004, y: 201.14 }],
        bbox: { x: 72, y: 189.14, width: 8.004, height: 12 },
      },
      {
        page: 2,
        rotation: 90,
        display_width: 300,
        display_height: 200,
        viewport_transform: [0, 1, 1, 0, 0, 0],
        quad: [{ x: 110.86, y: 72 }, { x: 110.86, y: 80.004 }, { x: 98.86, y: 72 }, { x: 98.86, y: 80.004 }],
        bbox: { x: 98.86, y: 72, width: 12, height: 8.004 },
      },
      {
        page: 3,
        rotation: 180,
        display_width: 200,
        display_height: 300,
        viewport_transform: [-1, 0, 0, 1, 200, 0],
        quad: [{ x: 128, y: 110.86 }, { x: 119.996, y: 110.86 }, { x: 128, y: 98.86 }, { x: 119.996, y: 98.86 }],
        bbox: { x: 119.996, y: 98.86, width: 8.004, height: 12 },
      },
      {
        page: 4,
        rotation: 270,
        display_width: 300,
        display_height: 200,
        viewport_transform: [0, -1, -1, 0, 300, 200],
        quad: [{ x: 189.14, y: 128 }, { x: 189.14, y: 119.996 }, { x: 201.14, y: 128 }, { x: 201.14, y: 119.996 }],
        bbox: { x: 189.14, y: 119.996, width: 12, height: 8.004 },
      },
    ];
    expect(rotations.isError).not.toBe(true);
    expect(rotations.structuredContent.parser).toEqual({ name: "pdfjs-dist", version: "5.4.624" });
    expect(rotations.structuredContent.pages).toHaveLength(4);
    for (const expected of expectedRotationGeometry) {
      const page = rotations.structuredContent.pages[expected.page - 1];
      expect(page.geometry).toEqual({
        page: expected.page,
        media_box: { x: 0, y: 0, width: 200, height: 300 },
        crop_box: { x: 0, y: 0, width: 200, height: 300 },
        pdfjs_view: [0, 0, 200, 300],
        user_unit: 1,
        raw_pdf_rotation: expected.rotation,
        display_rotation: expected.rotation,
        rotation_matches_raw: true,
        display_width: expected.display_width,
        display_height: expected.display_height,
        viewport_transform: expected.viewport_transform,
        raw_page_space: RAW_PAGE_SPACE,
        item_space: ITEM_SPACE,
      });
      expect(page.raw_items).toHaveLength(1);
      expect(page.raw_items[0]).toEqual(expect.objectContaining({
        text: "X",
        raw_transform: [12, 0, 0, 12, 72, 100],
        raw_width: 8.004,
        raw_height: 12,
        font: { family: "sans-serif", ascent: 0.905, descent: -0.212, vertical: false },
        geometry_kind: "pdfjs_text_run_advance_box",
        geometry_valid: true,
        bbox_status: "valid",
        geometry_provenance: HORIZONTAL_GEOMETRY_PROVENANCE,
        quad: expected.quad,
        bbox: expected.bbox,
        x: expected.bbox.x,
        y: expected.bbox.y,
        width: expected.bbox.width,
        height: expected.bbox.height,
        line_height: 12,
        direction: "ltr",
      }));
    }
    expect(rotations.structuredContent.limitations.join(" ")).toContain("not DOM TextLayer or glyph ink bounds");
    expect(rotations.structuredContent.limitations.join(" ")).toContain("not interchangeable with render_pdf_region or signing coordinates");

    const units = await client.callTool({ name: "read_pdf_layout", arguments: { pdf_path: fixture, start_page: 5, end_page: 6, max_output_characters: 200000 } });
    // UserUnit 2 doubles the viewport matrix, advance, font size, and ascent
    // offset. The UserUnit 1 page is the exact offset-CropBox control.
    const expectedUnitGeometry = [
      {
        page: 5,
        user_unit: 2,
        display_width: 600,
        display_height: 800,
        viewport_transform: [2, 0, 0, -2, -60, 880],
        quad: [{ x: 84, y: 658.28 }, { x: 100.008, y: 658.28 }, { x: 84, y: 682.28 }, { x: 100.008, y: 682.28 }],
        bbox: { x: 84, y: 658.28, width: 16.008, height: 24 },
        line_height: 24,
      },
      {
        page: 6,
        user_unit: 1,
        display_width: 300,
        display_height: 400,
        viewport_transform: [1, 0, 0, -1, -30, 440],
        quad: [{ x: 42, y: 329.14 }, { x: 50.004, y: 329.14 }, { x: 42, y: 341.14 }, { x: 50.004, y: 341.14 }],
        bbox: { x: 42, y: 329.14, width: 8.004, height: 12 },
        line_height: 12,
      },
    ];
    expect(units.isError).not.toBe(true);
    for (const [index, expected] of expectedUnitGeometry.entries()) {
      const page = units.structuredContent.pages[index];
      expect(page.geometry).toEqual({
        page: expected.page,
        media_box: { x: 10, y: 20, width: 400, height: 500 },
        crop_box: { x: 30, y: 40, width: 300, height: 400 },
        pdfjs_view: [30, 40, 330, 440],
        user_unit: expected.user_unit,
        raw_pdf_rotation: 0,
        display_rotation: 0,
        rotation_matches_raw: true,
        display_width: expected.display_width,
        display_height: expected.display_height,
        viewport_transform: expected.viewport_transform,
        raw_page_space: RAW_PAGE_SPACE,
        item_space: ITEM_SPACE,
      });
      expect(page.raw_items).toHaveLength(1);
      expect(page.raw_items[0]).toEqual(expect.objectContaining({
        text: "X",
        raw_transform: [12, 0, 0, 12, 72, 100],
        raw_width: 8.004,
        raw_height: 12,
        font: { family: "sans-serif", ascent: 0.905, descent: -0.212, vertical: false },
        geometry_provenance: HORIZONTAL_GEOMETRY_PROVENANCE,
        quad: expected.quad,
        bbox: expected.bbox,
        x: expected.bbox.x,
        y: expected.bbox.y,
        width: expected.bbox.width,
        height: expected.bbox.height,
        line_height: expected.line_height,
      }));
    }

    const hostile = await client.callTool({ name: "read_pdf_layout", arguments: { pdf_path: fixture, start_page: 7, end_page: 10, max_output_characters: 200000 } });
    // Independent literals for CropBox [-80.125, -30.375, 220.375,
    // 369.875]. The PDF stores UserUnit 1.3335 and 1.9995; the public IR
    // rounds the parser values to 1.333 and 2 before its arithmetic checks.
    const hostileExpected = [
      {
        page: 7, rotation: 0, user_unit: 1,
        display_width: 300.5, display_height: 400.25,
        viewport_transform: [1, 0, 0, -1, 80.125, 369.875],
        quad: [{ x: 152.125, y: 259.015 }, { x: 160.129, y: 259.015 }, { x: 152.125, y: 271.015 }, { x: 160.129, y: 271.015 }],
        bbox: { x: 152.125, y: 259.015, width: 8.004, height: 12 }, line_height: 12,
      },
      {
        page: 8, rotation: 90, user_unit: 1.333,
        display_width: 533.733, display_height: 400.717,
        viewport_transform: [0, 1.333, 1.333, 0, 40.505, 106.847],
        quad: [{ x: 188.281, y: 202.823 }, { x: 188.281, y: 213.492 }, { x: 172.285, y: 202.823 }, { x: 172.285, y: 213.492 }],
        bbox: { x: 172.285, y: 202.823, width: 15.996, height: 10.669 }, line_height: 15.996,
      },
      {
        page: 9, rotation: 180, user_unit: 2,
        display_width: 600.85, display_height: 800.3,
        viewport_transform: [-2, 0, 0, 2, 440.64, 60.735],
        quad: [{ x: 296.64, y: 282.455 }, { x: 280.632, y: 282.455 }, { x: 296.64, y: 258.455 }, { x: 280.632, y: 258.455 }],
        bbox: { x: 280.632, y: 258.455, width: 16.008, height: 24 }, line_height: 24,
      },
      {
        page: 10, rotation: 270, user_unit: 2,
        display_width: 800.5, display_height: 601,
        viewport_transform: [0, -2, -2, 0, 739.75, 440.75],
        quad: [{ x: 518.03, y: 296.75 }, { x: 518.03, y: 280.742 }, { x: 542.03, y: 296.75 }, { x: 542.03, y: 280.742 }],
        bbox: { x: 518.03, y: 280.742, width: 24, height: 16.008 }, line_height: 24,
      },
    ];
    expect(hostile.isError).not.toBe(true);
    for (const [index, expected] of hostileExpected.entries()) {
      const page = hostile.structuredContent.pages[index];
      expect(page.geometry).toEqual({
        page: expected.page,
        media_box: { x: -100.5, y: -50.75, width: 400.75, height: 500.5 },
        crop_box: { x: -80.125, y: -30.375, width: 300.5, height: 400.25 },
        pdfjs_view: [-80.125, -30.375, 220.375, 369.875],
        user_unit: expected.user_unit,
        raw_pdf_rotation: expected.rotation,
        display_rotation: expected.rotation,
        rotation_matches_raw: true,
        display_width: expected.display_width,
        display_height: expected.display_height,
        viewport_transform: expected.viewport_transform,
        raw_page_space: RAW_PAGE_SPACE,
        item_space: ITEM_SPACE,
      });
      expect(page.raw_items[0]).toEqual(expect.objectContaining({
        text: "X",
        raw_transform: [12, 0, 0, 12, 72, 100],
        raw_width: 8.004,
        raw_height: 12,
        quad: expected.quad,
        bbox: expected.bbox,
        x: expected.bbox.x,
        y: expected.bbox.y,
        width: expected.bbox.width,
        height: expected.bbox.height,
        line_height: expected.line_height,
      }));
    }

    const roundedSpan = 369.875 - (-30.375);
    const roundedScale = 1.333;
    const roundedExpectedWidth = roundedSpan * roundedScale;
    const roundingTolerance = 0.001 + Math.abs(roundedSpan) * 0.0005
      + Math.abs(roundedScale) * 0.001 + 0.0000005;
    const justInside = structuredClone(hostile.structuredContent);
    justInside.pages[1].geometry.display_width = roundedExpectedWidth + roundingTolerance - 0.000001;
    expect(() => validatePdfLayoutSemantics(justInside)).not.toThrow();
    const justOutside = structuredClone(hostile.structuredContent);
    justOutside.pages[1].geometry.display_width = roundedExpectedWidth + roundingTolerance + 0.000001;
    expect(() => validatePdfLayoutSemantics(justOutside)).toThrow(/display size\/view mismatch/);

  });

  it("rejects coordinated page-view and raw-TextItem forgeries against reparsed source bytes", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([200, 300]);
    page.drawText("X", { x: 72, y: 100, size: 12, font });
    const bytes = await document.save({ useObjectStreams: false });
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const result = await extractPdfLayout({
      pdfjsLib: pdfjs,
      pdfBytes: bytes,
      sourcePath: "/synthetic/source-bound.pdf",
      sourceFileName: "source-bound.pdf",
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      requestedStartPage: 1,
      requestedEndPage: 1,
      maxOutputCharacters: 200000,
    });
    await expect(validatePdfLayoutSourceEvidence(result, { pdfjsLib: pdfjs, sourceBytes: bytes })).resolves.toBe(result);

    const translatedView = structuredClone(result);
    translatedView.pages[0].geometry.pdfjs_view[0] += 10;
    translatedView.pages[0].geometry.pdfjs_view[2] += 10;
    translatedView.pages[0].geometry.viewport_transform[4] -= 10;
    shiftPageGeometryX(translatedView.pages[0], -10);
    expect(() => validatePdfLayoutSemantics(translatedView, { sourceBytes: bytes })).not.toThrow();
    await expect(validatePdfLayoutSourceEvidence(translatedView, { pdfjsLib: pdfjs, sourceBytes: bytes }))
      .rejects.toThrow(/pdfjs_view differs from reparsed source/);

    const translatedRawItem = structuredClone(result);
    translatedRawItem.pages[0].raw_items[0].raw_transform[4] += 100;
    shiftPageGeometryX(translatedRawItem.pages[0], 100);
    expect(() => validatePdfLayoutSemantics(translatedRawItem, { sourceBytes: bytes })).not.toThrow();
    await expect(validatePdfLayoutSourceEvidence(translatedRawItem, { pdfjsLib: pdfjs, sourceBytes: bytes }))
      .rejects.toThrow(/raw_transform differs from reparsed source/);

    const forgedImageEvidence = structuredClone(result);
    forgedImageEvidence.pages[0].has_image_operations = true;
    forgedImageEvidence.pages[0].image_detection_status = "detected";
    forgedImageEvidence.pages[0].modality_hint = "mixed-content-candidate";
    forgedImageEvidence.pages[0].extraction_status = "partial";
    forgedImageEvidence.pages[0].needs_visual_inspection = true;
    forgedImageEvidence.extraction_status = "partial";
    expect(() => validatePdfLayoutSemantics(forgedImageEvidence, { sourceBytes: bytes })).not.toThrow();
    await expect(validatePdfLayoutSourceEvidence(forgedImageEvidence, { pdfjsLib: pdfjs, sourceBytes: bytes }))
      .rejects.toThrow(/operator evidence differs from reparsed source/);
  });

  it("fails closed on retention/output limits and keeps references non-dangling", async () => {
    const limited = await client.callTool({
      name: "read_pdf_layout",
      arguments: { pdf_path: TWO_COLUMN, max_items: 1, max_characters: 100000, max_output_characters: 200000 },
    });
    const page = limited.structuredContent.pages[0];
    expect(page.truncation).toMatchObject({ truncated: true, reasons: ["max_items"], first_omitted_source_index: 1 });
    expect(limited.structuredContent.truncation).toMatchObject({ truncated: true, first_omitted_page: 1, first_omitted_source_index: 1 });
    const itemIds = new Set(page.raw_items.map(item => item.id));
    expect(page.lines.flatMap(line => line.item_ids).every(id => itemIds.has(id))).toBe(true);
    const lineIds = new Set(page.lines.map(line => line.id));
    expect(page.blocks.flatMap(block => block.line_ids).every(id => lineIds.has(id))).toBe(true);

    const pressureDocument = await PDFDocument.create();
    const pressureFont = await pressureDocument.embedFont(StandardFonts.Helvetica);
    const pressurePage = pressureDocument.addPage([612, 4000]);
    pressurePage.drawText(Array.from({ length: 100 }, (_, index) => `Budget item ${index}`).join("\n"), {
      x: 40,
      y: 3950,
      size: 10,
      lineHeight: 30,
      font: pressureFont,
    });
    const pressureFixture = path.join(temporaryRoot, "output-pressure.pdf");
    await fs.writeFile(pressureFixture, await pressureDocument.save({ useObjectStreams: false }));
    const outputLimited = await client.callTool({
      name: "read_pdf_layout",
      arguments: { pdf_path: pressureFixture, max_items: 5000, max_output_characters: 20000 },
    });
    expect(JSON.stringify(outputLimited.structuredContent).length).toBeLessThanOrEqual(20000);
    expect(outputLimited.structuredContent.truncation.reasons).toContain("max_output_characters");
    expect(outputLimited.structuredContent.pages[0].reading_order).toMatchObject({
      strategy: "unavailable_output_omitted",
      column_count: 0,
    });
    expect(outputLimited.structuredContent.truncation.omitted_items).toBe(
      outputLimited.structuredContent.pages.reduce((sum, value) => sum + value.truncation.omitted_items, 0),
    );
    const pressureBytes = await fs.readFile(pressureFixture);
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const relabeledOutputBudget = structuredClone(outputLimited.structuredContent);
    relabeledOutputBudget.limits.max_output_characters = 200000;
    relabeledOutputBudget.id_scope.max_output_characters = 200000;
    expect(() => validatePdfLayoutSemantics(relabeledOutputBudget, { sourceBytes: pressureBytes })).not.toThrow();
    await expect(validatePdfLayoutSourceEvidence(relabeledOutputBudget, { pdfjsLib: pdfjs, sourceBytes: pressureBytes }))
      .rejects.toThrow(/output omission differs from independent budget replay/);
    const roomy = await client.callTool({
      name: "read_pdf_layout",
      arguments: { pdf_path: pressureFixture, max_items: 5000, max_output_characters: 200000 },
    });
    expect(roomy.structuredContent.pages[0].truncation.reasons).not.toContain("max_output_characters");
    expect(roomy.structuredContent.pages[0].raw_items.length).toBeGreaterThan(0);
    const understatedOutputBudget = structuredClone(roomy.structuredContent);
    understatedOutputBudget.limits.max_output_characters = 20000;
    understatedOutputBudget.id_scope.max_output_characters = 20000;
    expect(() => validatePdfLayoutSemantics(understatedOutputBudget, { sourceBytes: pressureBytes }))
      .toThrow(/serialized output exceeds its declared limit/);
  });

  it("bounds page count, high page selection, and source size before parsing", async () => {
    const document = await PDFDocument.create();
    for (let index = 0; index < 900; index += 1) document.addPage([72, 72]);
    const manyPages = path.join(temporaryRoot, "many-pages.pdf");
    await fs.writeFile(manyPages, await document.save());
    const page900 = await client.callTool({ name: "read_pdf_layout", arguments: { pdf_path: manyPages, start_page: 900, end_page: 900 } });
    expect(page900.structuredContent.page_range).toMatchObject({ start_page: 900, end_page: 900, total_pages: 900 });
    expect(page900.structuredContent.pages.map(page => page.page)).toEqual([900]);

    const tooMany = await client.callTool({ name: "read_pdf_layout", arguments: { pdf_path: manyPages, start_page: 1, end_page: 11 } });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.content[0].text).toContain("at most 10 pages");

    const oversized = path.join(temporaryRoot, "oversized.pdf");
    const handle = await fs.open(oversized, "w");
    await handle.truncate(250 * 1024 * 1024 + 1);
    await handle.close();
    const tooLarge = await client.callTool({ name: "read_pdf_layout", arguments: { pdf_path: oversized } });
    expect(tooLarge.isError).toBe(true);
    expect(tooLarge.content[0].text).toContain("up to 250 MiB");
  }, 30_000);

  it("proves missing, wrong, and correct passwords through MCP with the provenance-bound ODA QPDF fixture", async () => {
    const provenance = JSON.parse(await fs.readFile(ENCRYPTED_LAYOUT_PROVENANCE, "utf8"));
    const encryptedBytes = await fs.readFile(ENCRYPTED_LAYOUT);
    const sourceBytes = await fs.readFile(path.join(REPO_ROOT, provenance.source_fixture.path));
    expect(createHash("sha256").update(sourceBytes).digest("hex")).toBe(provenance.source_fixture.sha256);
    expect(createHash("sha256").update(encryptedBytes).digest("hex")).toBe(provenance.encrypted_fixture.sha256);
    expect(provenance).toMatchObject({
      schema_version: 1,
      ownership: "Open Document Alliance generated synthetic fixture",
      qpdf: { version: "12.3.2" },
      generation: { reproducible_across_two_runs: true, test_only_insecure_flags: ["--static-id", "--static-aes-iv"] },
    });
    const sentinel = "__PDF_TOOLS_ENCRYPTED_STDERR_FULLY_DRAINED__";
    const dedicatedStderr = [];
    const protocolLogs = [];
    const rawProtocol = [];
    const dedicatedTransport = new StdioClientTransport({
      command: process.execPath,
      args: [STDERR_SENTINEL_HELPER],
      cwd: REPO_ROOT,
      env: {
        ALLOWED_DIRECTORIES: [REPO_ROOT, temporaryRoot].join(path.delimiter),
        PDF_TOOLS_TEST_STDERR_SENTINEL: sentinel,
      },
      stderr: "pipe",
    });
    dedicatedTransport.stderr.on("data", chunk => dedicatedStderr.push(Buffer.from(chunk)));
    const stderrEnded = once(dedicatedTransport.stderr, "end");
    const dedicatedClient = new Client({ name: "pdf-layout-encrypted-leak-test", version: "1.0.0" });
    dedicatedClient.setNotificationHandler(LoggingMessageNotificationSchema, notification => {
      protocolLogs.push(structuredClone(notification));
    });
    let closed = false;
    const callTraced = async arguments_ => {
      const start = rawProtocol.length;
      let result = null;
      let error = null;
      try {
        result = await dedicatedClient.callTool({ name: "read_pdf_layout", arguments: arguments_ });
      } catch (caught) {
        error = caught;
      }
      return { result, error, rawProtocol: rawProtocol.slice(start) };
    };
    let missingTrace;
    let wrongTrace;
    let userTrace;
    let ownerTrace;
    try {
      await dedicatedClient.connect(dedicatedTransport);
      const receiveProtocolMessage = dedicatedTransport.onmessage;
      dedicatedTransport.onmessage = (message, extra) => {
        rawProtocol.push(structuredClone(message));
        receiveProtocolMessage?.(message, extra);
      };
      missingTrace = await callTraced({ pdf_path: ENCRYPTED_LAYOUT });
      wrongTrace = await callTraced({
        pdf_path: ENCRYPTED_LAYOUT,
        password: provenance.passwords.wrong_password_oracle,
      });
      userTrace = await callTraced({
        pdf_path: ENCRYPTED_LAYOUT,
        password: provenance.passwords.user,
        max_output_characters: 200000,
      });
      ownerTrace = await callTraced({
        pdf_path: ENCRYPTED_LAYOUT,
        password: provenance.passwords.owner,
        max_output_characters: 200000,
      });
      await dedicatedClient.listTools();
      await dedicatedClient.close();
      closed = true;
      await stderrEnded;
    } finally {
      if (!closed) await dedicatedClient.close().catch(() => {});
    }

    const missing = missingTrace.result;
    expect(missingTrace.error).toBeNull();
    expect(missing).toMatchObject({
      isError: true,
      structuredContent: { status: "failed", error: { error_schema_version: 1, code: "PASSWORD_REQUIRED" } },
    });
    expect(JSON.stringify(missing)).not.toContain(provenance.passwords.user);

    const wrong = wrongTrace.result;
    expect(wrongTrace.error).toBeNull();
    expect(wrong).toMatchObject({
      isError: true,
      structuredContent: { status: "failed", error: { error_schema_version: 1, code: "PASSWORD_INCORRECT" } },
    });
    const correctUser = userTrace.result;
    expect(userTrace.error).toBeNull();
    expect(correctUser.isError).not.toBe(true);
    expect(correctUser.structuredContent.source.sha256).toBe(provenance.encrypted_fixture.sha256);
    expect(correctUser.structuredContent.extraction_status).toBe("partial");
    expect(correctUser.structuredContent.pages[0]).toMatchObject({
      extraction_status: "partial",
      geometry: {
        media_box: null,
        crop_box: null,
        raw_pdf_rotation: null,
        pdfjs_view: [0, 0, 612, 792],
        display_width: 612,
        display_height: 792,
      },
      errors: [expect.objectContaining({ code: "RAW_PAGE_GEOMETRY_UNAVAILABLE" })],
    });
    expect(correctUser.structuredContent.pages[0].flow_text).toContain("TWO COLUMN NOTICE");

    const correctOwner = ownerTrace.result;
    expect(ownerTrace.error).toBeNull();
    expect(correctOwner.isError).not.toBe(true);
    expect(correctOwner.structuredContent.source.sha256).toBe(provenance.encrypted_fixture.sha256);
    expect(correctOwner.structuredContent.pages[0].flow_text).toContain("TWO COLUMN NOTICE");
    const completeStderr = Buffer.concat(dedicatedStderr).toString("utf8");
    const stderrLines = completeStderr.trimEnd().split(/\r?\n/);
    expect(stderrLines.at(-1)).toBe(sentinel);
    expect(stderrLines.filter(line => line === sentinel)).toHaveLength(1);
    for (const trace of [missingTrace, wrongTrace, userTrace, ownerTrace]) {
      expect(trace.rawProtocol.some(message => "result" in message || "error" in message)).toBe(true);
    }

    const leakSurfaces = {
      complete_result_objects: { missing, wrong, correctUser, correctOwner },
      result_content: [missing.content, wrong.content, correctUser.content, correctOwner.content],
      result_structured_content: [missing.structuredContent, wrong.structuredContent, correctUser.structuredContent, correctOwner.structuredContent],
      result_meta: [missing._meta, wrong._meta, correctUser._meta, correctOwner._meta],
      complete_error_objects: {
        missing: { call_error: completeErrorSurface(missingTrace.error), result_error: missing.structuredContent?.error },
        wrong: { call_error: completeErrorSurface(wrongTrace.error), result_error: wrong.structuredContent?.error },
        user: { call_error: completeErrorSurface(userTrace.error), result_error: correctUser.structuredContent?.error },
        owner: { call_error: completeErrorSurface(ownerTrace.error), result_error: correctOwner.structuredContent?.error },
      },
      complete_raw_protocol: {
        missing: missingTrace.rawProtocol,
        wrong: wrongTrace.rawProtocol,
        user: userTrace.rawProtocol,
        owner: ownerTrace.rawProtocol,
        all: rawProtocol,
      },
      protocol_logs: protocolLogs,
      complete_stderr: completeStderr,
    };
    for (const password of Object.values(provenance.passwords)) {
      for (const [surface, value] of Object.entries(leakSurfaces)) {
        expect(JSON.stringify(value), `${surface} exposed a test password`).not.toContain(password);
      }
    }
  });
});

describe("Extraction IR hostile reconstruction", () => {
  it("preserves whitespace, empty EOL, zero width, ligatures, repeats, styles, and source order", async () => {
    const items = [
      textItem({ text: " ", x: 10, top: 20, width: 4, hasEOL: false }),
      textItem({ text: "office ﬁ", x: 20, top: 20, width: 60, hasEOL: false }),
      textItem({ text: "", x: 85, top: 20, width: 0, hasEOL: true }),
      textItem({ text: "repeat", x: 10, top: 50, hasEOL: false }),
      textItem({ text: "repeat", x: 80, top: 50, hasEOL: true }),
    ];
    const { result } = await runFake([{ items }]);
    const raw = result.pages[0].raw_items;
    expect(raw.map(item => item.text)).toEqual([" ", "office ﬁ", "", "repeat", "repeat"]);
    expect(raw.map(item => item.source_index)).toEqual([0, 1, 2, 3, 4]);
    expect(raw[0].is_whitespace).toBe(true);
    expect(raw[0].text_kind).toBe("whitespace");
    expect(raw[2]).toMatchObject({ has_eol: true, text_kind: "empty", raw_width: 0, width: 0, bbox_status: "degenerate" });
    expect(raw[1].font).toEqual({ family: "Test Sans", ascent: 0.8, descent: -0.2, vertical: false });
    expect(result.pages[0].limitations.join(" ")).toContain("hidden, clipped, duplicated");
  });

  it("binds truncation to the exact parser-order TextItem prefix", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const page = document.addPage([300, 400]);
    page.drawText("A\nB\nC\nD\nE", { x: 40, y: 340, size: 12, lineHeight: 30, font });
    const bytes = await document.save({ useObjectStreams: false });
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const common = {
      pdfjsLib: pdfjs,
      pdfBytes: bytes,
      sourcePath: "/synthetic/five-entry-prefix.pdf",
      sourceFileName: "five-entry-prefix.pdf",
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      maxCharacters: 50000,
      maxOutputCharacters: 200000,
    };
    const full = await extractPdfLayout({ ...common, maxItems: 100 });
    const truncated = await extractPdfLayout({ ...common, maxItems: 2 });
    expect(full.pages[0].raw_items.map(item => item.text)).toEqual(["A", "B", "C", "D", "E"]);
    expect(truncated.pages[0].raw_items.map(item => item.source_index)).toEqual([0, 1]);
    expect(truncated.pages[0].truncation).toMatchObject({ omitted_items: 3, first_omitted_source_index: 2 });

    const understatedItems = structuredClone(full);
    understatedItems.limits.max_items = 1;
    understatedItems.id_scope.max_items = 1;
    expect(() => validatePdfLayoutSemantics(understatedItems, { sourceBytes: bytes })).not.toThrow();
    await expect(validatePdfLayoutSourceEvidence(understatedItems, { pdfjsLib: pdfjs, sourceBytes: bytes }))
      .rejects.toThrow(/independently replayed limits/);

    const understatedCharacters = structuredClone(full);
    understatedCharacters.limits.max_characters = 1;
    understatedCharacters.id_scope.max_characters = 1;
    expect(() => validatePdfLayoutSemantics(understatedCharacters, { sourceBytes: bytes })).not.toThrow();
    await expect(validatePdfLayoutSourceEvidence(understatedCharacters, { pdfjsLib: pdfjs, sourceBytes: bytes }))
      .rejects.toThrow(/independently replayed limits/);

    const relabeledTruncation = structuredClone(truncated);
    relabeledTruncation.limits.max_items = 5;
    relabeledTruncation.id_scope.max_items = 5;
    expect(() => validatePdfLayoutSemantics(relabeledTruncation, { sourceBytes: bytes })).not.toThrow();
    await expect(validatePdfLayoutSourceEvidence(relabeledTruncation, { pdfjsLib: pdfjs, sourceBytes: bytes }))
      .rejects.toThrow(/independently replayed limits/);

    const missing = structuredClone(truncated);
    missing.pages[0].raw_items.splice(1, 1);
    missing.pages[0].counts.returned_items = 1;
    missing.pages[0].counts.returned_non_whitespace_items = 1;
    missing.pages[0].counts.returned_characters = 1;
    missing.pages[0].truncation.omitted_items = 4;
    missing.pages[0].truncation.omitted_non_whitespace_items = 4;
    missing.pages[0].truncation.omitted_characters = 4;
    expect(() => validatePdfLayoutSemantics(missing)).toThrow(/prefix boundary|dangling/);

    const reordered = structuredClone(truncated);
    reordered.pages[0].raw_items.reverse();
    expect(() => validatePdfLayoutSemantics(reordered)).toThrow(/exact source prefix/);

    const duplicate = structuredClone(truncated);
    duplicate.pages[0].raw_items[1] = structuredClone(duplicate.pages[0].raw_items[0]);
    expect(() => validatePdfLayoutSemantics(duplicate)).toThrow(/exact source prefix|duplicate ID/);

    // Exact reproduction of the formerly accepted interior omission: retain
    // source entries [0, 3], keep observed=5/returned=2/omitted=3, and claim
    // the first omission is 4. The prefix contract now rejects it before any
    // derived line data can legitimize the omission.
    const laterSubstitution = structuredClone(truncated);
    laterSubstitution.pages[0].raw_items[1] = structuredClone(full.pages[0].raw_items[3]);
    laterSubstitution.pages[0].counts.returned_items = 2;
    laterSubstitution.pages[0].counts.returned_non_whitespace_items = 2;
    laterSubstitution.pages[0].counts.returned_characters = 2;
    laterSubstitution.pages[0].truncation.omitted_items = 3;
    laterSubstitution.pages[0].truncation.omitted_non_whitespace_items = 3;
    laterSubstitution.pages[0].truncation.omitted_characters = 3;
    laterSubstitution.pages[0].truncation.first_omitted_source_index = 4;
    laterSubstitution.truncation.first_omitted_source_index = 4;
    expect(() => validatePdfLayoutSemantics(laterSubstitution, { sourceBytes: bytes })).toThrow(/exact source prefix/);
    await expect(validatePdfLayoutSourceEvidence(laterSubstitution, { pdfjsLib: pdfjs, sourceBytes: bytes }))
      .rejects.toThrow(/exact source prefix/);
  });

  it("replays item and character retention globally across page order", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (const text of ["A\nB", "C\nD"]) {
      const page = document.addPage([300, 400]);
      page.drawText(text, { x: 40, y: 340, size: 12, lineHeight: 30, font });
    }
    const bytes = await document.save({ useObjectStreams: false });
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const common = {
      pdfjsLib: pdfjs,
      pdfBytes: bytes,
      sourcePath: "/synthetic/global-retention.pdf",
      sourceFileName: "global-retention.pdf",
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      requestedStartPage: 1,
      requestedEndPage: 2,
      maxOutputCharacters: 200000,
    };
    const itemLimited = await extractPdfLayout({ ...common, maxItems: 3, maxCharacters: 50000 });
    expect(itemLimited.pages.map(page => page.raw_items.map(item => item.text))).toEqual([["A", "B"], ["C"]]);
    expect(itemLimited.pages[1].truncation).toMatchObject({
      reasons: ["max_items"],
      omitted_items: 1,
      omitted_characters: 1,
      first_omitted_source_index: 1,
    });

    const characterLimited = await extractPdfLayout({ ...common, maxItems: 100, maxCharacters: 3 });
    expect(characterLimited.pages.map(page => page.raw_items.map(item => item.text))).toEqual([["A", "B"], ["C"]]);
    expect(characterLimited.pages[1].truncation.reasons).toEqual(["max_characters"]);

    const resetPerPageForgery = structuredClone(itemLimited);
    resetPerPageForgery.limits.max_items = 2;
    resetPerPageForgery.id_scope.max_items = 2;
    expect(() => validatePdfLayoutSemantics(resetPerPageForgery, { sourceBytes: bytes })).not.toThrow();
    await expect(validatePdfLayoutSourceEvidence(resetPerPageForgery, { pdfjsLib: pdfjs, sourceBytes: bytes }))
      .rejects.toThrow(/independently replayed limits/);
  });

  it("source-binds empty, Unicode whitespace, astral code units, and ranges beginning after page one", async () => {
    const boundaryItems = [
      textItem({ text: "", x: 10, top: 20, width: 0, hasEOL: true }),
      textItem({ text: "\u2003", x: 10, top: 50, width: 8, hasEOL: true }),
      textItem({ text: "😀", x: 10, top: 80, width: 20, hasEOL: true }),
      textItem({ text: "Z", x: 10, top: 110, width: 8, hasEOL: true }),
    ];
    const atThree = await runFake([{ items: boundaryItems }], { maxCharacters: 3 });
    expect(atThree.result.pages[0].raw_items.map(item => [item.text, item.text_kind, item.text.length])).toEqual([
      ["", "empty", 0],
      ["\u2003", "whitespace", 1],
      ["😀", "non_whitespace", 2],
    ]);
    expect(atThree.result.pages[0].truncation).toMatchObject({
      reasons: ["max_characters"],
      omitted_items: 1,
      omitted_characters: 1,
      first_omitted_source_index: 3,
    });
    const atTwo = await runFake([{ items: boundaryItems }], { maxCharacters: 2 });
    expect(atTwo.result.pages[0].raw_items.map(item => item.text)).toEqual(["", "\u2003"]);
    expect(atTwo.result.pages[0].truncation).toMatchObject({
      omitted_items: 2,
      omitted_characters: 3,
      first_omitted_source_index: 2,
    });

    const selected = await runFake([
      { items: [textItem({ text: "unselected", x: 10, top: 20 })] },
      { items: boundaryItems.slice(0, 2) },
      { items: boundaryItems.slice(2) },
    ], { startPage: 2, endPage: 3, maxCharacters: 3 });
    expect(selected.result.page_range).toMatchObject({ start_page: 2, end_page: 3, total_pages: 3 });
    expect(selected.result.pages.map(page => page.page)).toEqual([2, 3]);
    expect(selected.result.pages.map(page => page.raw_items.map(item => item.text))).toEqual([
      ["", "\u2003"],
      ["😀"],
    ]);
    expect(selected.result.pages[1].truncation).toMatchObject({
      reasons: ["max_characters"],
      omitted_items: 1,
      omitted_characters: 1,
      first_omitted_source_index: 1,
    });
  });

  it("handles RTL spacing and falls back for TTB, skew, and ambiguous indents", async () => {
    const rtl = await runFake([{ items: [
      textItem({ text: "A", x: 200, top: 20, width: 40, direction: "rtl", hasEOL: false }),
      textItem({ text: "B", x: 150, top: 20, width: 40, direction: "rtl", hasEOL: true }),
    ] }]);
    expect(rtl.result.pages[0].flow_text).toBe("A B");

    const ttb = await runFake([{ items: [textItem({ text: "vertical", x: 50, top: 20, direction: "ttb" })] }]);
    expect(ttb.result.pages[0].reading_order.strategy).toBe("source_order_fallback");
    const skew = await runFake([{ items: [textItem({ text: "skew", x: 50, top: 20, transform: [12, 2, 0, 12, 50, 760] })] }]);
    expect(skew.result.pages[0].reading_order.strategy).toBe("source_order_fallback");
    const skewItem = skew.result.pages[0].raw_items[0];
    expect(Math.abs(Math.hypot(
      skewItem.quad[1].x - skewItem.quad[0].x,
      skewItem.quad[1].y - skewItem.quad[0].y,
    ) - skewItem.raw_width)).toBeLessThan(0.002);

    const vertical = await runFake([{ items: [textItem({ text: "vertical", x: 50, top: 20, width: 12 })], styles: {
      f1: { fontFamily: "Vertical Test", ascent: 0.75, descent: -0.25, vertical: true },
    } }]);
    const verticalItem = vertical.result.pages[0].raw_items[0];
    expect(verticalItem.geometry_provenance).toEqual({
      formula: "pdfjs_text_item_style_metric_advance_box_approximation",
      quad_order: "anchor_top_terminal_top_anchor_bottom_terminal_bottom",
      advance_source: "item_height",
      ascent_source: "style_ascent",
      ascent_ratio: 0.75,
    });
    expect(Math.hypot(
      verticalItem.quad[1].x - verticalItem.quad[0].x,
      verticalItem.quad[1].y - verticalItem.quad[0].y,
    )).toBeCloseTo(12, 3);

    const indented = [];
    for (const top of [100, 130, 160]) indented.push(textItem({ text: `wide-${top}`, x: 50, top, width: 260 }));
    for (const top of [105, 135, 165]) indented.push(textItem({ text: `indent-${top}`, x: 200, top, width: 80 }));
    const ambiguous = await runFake([{ items: indented }]);
    expect(ambiguous.result.pages[0].reading_order.strategy).not.toBe("two_column_left_to_right");
  });

  it("does not bridge equal-baseline column gutters and makes source fallback truly source segmented", async () => {
    const equalBaseline = [];
    for (const top of [100, 130, 160]) {
      equalBaseline.push(textItem({ text: `L${top}`, x: 50, top, width: 80, hasEOL: false }));
      equalBaseline.push(textItem({ text: `R${top}`, x: 350, top, width: 80, hasEOL: false }));
    }
    const columns = await runFake([{ items: equalBaseline }]);
    expect(columns.result.pages[0].lines).toHaveLength(6);
    expect(columns.result.pages[0].reading_order.strategy).toBe("two_column_left_to_right");

    const tableLike = [
      textItem({ text: "TITLE", x: 200, top: 60, width: 80, hasEOL: true }),
    ];
    for (const top of [100, 130, 160]) {
      tableLike.push(textItem({ text: `A${top}`, x: 50, top, width: 40, hasEOL: false }));
      tableLike.push(textItem({ text: `B${top}`, x: 250, top, width: 40, hasEOL: false }));
      tableLike.push(textItem({ text: `C${top}`, x: 400, top, width: 40, hasEOL: true }));
    }
    const segmented = await runFake([{ items: tableLike }]);
    expect(segmented.result.pages[0].reading_order).toMatchObject({
      strategy: "source_order_fallback",
      column_count: 1,
    });
    expect(segmented.result.pages[0].reading_order.limitations[0]).toMatch(/table-like or segmented content/);
    expect(segmented.result.pages[0].flow_text).toBe(
      "TITLE\nA100 B100 C100\nA130 B130 C130\nA160 B160 C160",
    );

    const sourceFallback = await runFake([{ items: [
      textItem({ text: "A", x: 10, top: 300, width: 10, hasEOL: false, transform: [12, 2, 0, 12, 10, 480] }),
      textItem({ text: "B", x: 30, top: 100, width: 10, hasEOL: false }),
      textItem({ text: "C", x: 50, top: 200, width: 10, hasEOL: true }),
      textItem({ text: "D", x: 10, top: 20, width: 10, hasEOL: true }),
    ] }]);
    expect(sourceFallback.result.pages[0].reading_order.strategy).toBe("source_order_fallback");
    expect(sourceFallback.result.pages[0].flow_text).toBe("A\nB\nC\nD");

    const staircaseItems = [100, 105, 110, 115, 120].map((top, index) => textItem({
      text: `S${index + 1}`,
      x: 10 + index * 20,
      top,
      width: 12,
      hasEOL: index === 4,
      transform: [12, 2, 0, 12, 10 + index * 20, 792 - top - 12],
    }));
    const staircase = await runFake([{ items: staircaseItems }]);
    expect(staircase.result.pages[0].reading_order.strategy).toBe("source_order_fallback");
    expect(staircase.result.pages[0].lines.length).toBeGreaterThan(1);
    expect(Math.max(...staircase.result.pages[0].lines.map(line => line.item_ids.length))).toBeLessThanOrEqual(2);
    expect(staircase.result.pages[0].flow_text).toBe("S1 S2\nS3 S4\nS5");
  });

  it("accepts only persistent columns with a real gutter and an external spanning heading", async () => {
    const items = [textItem({ text: "SPANNING HEADER", x: 40, top: 20, width: 520 })];
    for (const top of [100, 130, 160]) items.push(textItem({ text: `L${top}`, x: 50, top, width: 100 }));
    for (const top of [100, 130, 160]) items.push(textItem({ text: `R${top}`, x: 350, top, width: 100 }));
    const { result } = await runFake([{ items }]);
    expect(result.pages[0].reading_order).toMatchObject({
      strategy: "two_column_left_to_right",
      confidence: "not_calibrated",
      column_count: 2,
    });
    expect(result.pages[0].flow_text.split("\n")[0]).toBe("SPANNING HEADER");
  });

  it("marks non-finite geometry and per-page failures without NaN or missing flow text", async () => {
    const invalid = textItem({ text: "bad", x: 10, top: 10, transform: [Number.NaN, 0, 0, 12, 10, 760] });
    const { result } = await runFake([
      { textError: new Error("synthetic page failure") },
      { items: [invalid], operations: [1, 2] },
    ]);
    expect(result.pages[0]).toMatchObject({ text_layer_status: "failed", extraction_status: "failed", flow_text: "" });
    expect(result.pages[1]).toMatchObject({ extraction_status: "partial", modality_hint: "mixed-content-candidate" });
    expect(result.pages[1].raw_items[0]).toMatchObject({ geometry_valid: false, quad: null, bbox: null, x: null });
    expect(JSON.stringify(result)).not.toContain("NaN");
  });

  it("fails raw pdf-lib box enrichment soft after PDF.js has authenticated the document", async () => {
    const invalidForPdfLib = Buffer.from("not-a-pdf-but-the-fake-pdfjs-parser-accepted-it");
    const { result } = await runFake([{ items: [textItem({ text: "authenticated", x: 10, top: 20 })] }], {
      pdfBytes: invalidForPdfLib,
    });
    expect(result.pages[0]).toMatchObject({
      extraction_status: "partial",
      geometry: {
        media_box: null,
        crop_box: null,
        raw_pdf_rotation: null,
        display_rotation: 0,
        rotation_matches_raw: null,
      },
      errors: [expect.objectContaining({ code: "RAW_PAGE_GEOMETRY_UNAVAILABLE" })],
    });
    expect(result.pages[0].flow_text).toBe("authenticated");

    const forgedRawGeometry = structuredClone(result);
    forgedRawGeometry.pages[0].geometry.media_box = { x: 0, y: 0, width: 612, height: 792 };
    forgedRawGeometry.pages[0].geometry.crop_box = { x: 0, y: 0, width: 612, height: 792 };
    forgedRawGeometry.pages[0].geometry.raw_pdf_rotation = 0;
    forgedRawGeometry.pages[0].geometry.rotation_matches_raw = true;
    expect(() => validatePdfLayoutSemantics(forgedRawGeometry, { sourceBytes: invalidForPdfLib }))
      .toThrow(/unavailable raw geometry contains claims/);
    await expect(validatePdfLayoutSourceEvidence(forgedRawGeometry, {
      pdfjsLib: fakePdfjs([{ items: [textItem({ text: "authenticated", x: 10, top: 20 })] }]).pdfjs,
      sourceBytes: invalidForPdfLib,
    })).rejects.toThrow(/unavailable raw geometry contains claims/);
  });

  it("fails closed and cleans every source-proof resource when TextItem reparse reaches its deadline", async () => {
    const { result, bytes } = await runFake([{ textError: new Error("synthetic page failure") }]);
    const cleanup = { page: 0, document: 0, loading: 0 };
    const neverResolvingPdfjs = {
      version: "5.4.624",
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({
            view: [0, 0, 612, 792],
            userUnit: 1,
            rotate: 0,
            getViewport: () => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
            getTextContent: () => new Promise(() => {}),
            cleanup: () => { cleanup.page += 1; },
          }),
          destroy: async () => { cleanup.document += 1; },
        }),
        destroy: async () => { cleanup.loading += 1; },
      }),
    };
    const startedAt = Date.now();
    await expect(validatePdfLayoutSourceEvidence(result, {
      pdfjsLib: neverResolvingPdfjs,
      sourceBytes: bytes,
      deadlineAt: startedAt + 40,
    })).rejects.toMatchObject({ code: "LAYOUT_DEADLINE" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30);
    expect(cleanup).toEqual({ page: 1, document: 1, loading: 1 });

    for (const fatalError of [
      Object.assign(new Error("source reparse cancelled"), { name: "AbortError" }),
      Object.assign(new Error("source reparse resource exhausted"), { code: "ENOMEM" }),
    ]) {
      const fatalCleanup = { page: 0, document: 0, loading: 0 };
      const fatalPdfjs = {
        version: "5.4.624",
        getDocument: () => ({
          promise: Promise.resolve({
            numPages: 1,
            getPage: async () => ({
              view: [0, 0, 612, 792],
              userUnit: 1,
              rotate: 0,
              getViewport: () => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
              getTextContent: async () => { throw fatalError; },
              cleanup: () => { fatalCleanup.page += 1; },
            }),
            destroy: async () => { fatalCleanup.document += 1; },
          }),
          destroy: async () => { fatalCleanup.loading += 1; },
        }),
      };
      await expect(validatePdfLayoutSourceEvidence(result, {
        pdfjsLib: fatalPdfjs,
        sourceBytes: bytes,
      })).rejects.toBe(fatalError);
      expect(fatalCleanup).toEqual({ page: 1, document: 1, loading: 1 });
    }
  });

  it("binds operator failures and propagates fatal operator-list errors with exact cleanup", async () => {
    const ordinaryFailure = await runFake([{ operatorError: new Error("synthetic operator failure") }]);
    expect(ordinaryFailure.result.pages[0]).toMatchObject({
      has_image_operations: null,
      has_vector_paint_operations: null,
      image_detection_status: "failed",
      modality_hint: "unknown",
      extraction_status: "partial",
      needs_visual_inspection: true,
      errors: [expect.objectContaining({ stage: "operators", message: "synthetic operator failure" })],
    });

    const successful = await runFake([{ items: [] }]);
    const cases = [
      { kind: "deadline", error: null },
      { kind: "abort", error: Object.assign(new Error("operator reparse cancelled"), { name: "AbortError" }) },
      { kind: "resource", error: Object.assign(new Error("operator reparse resource exhausted"), { code: "ENOMEM" }) },
    ];
    for (const testCase of cases) {
      const cleanup = { page: 0, document: 0, loading: 0 };
      const fatalPdfjs = {
        version: "5.4.624",
        OPS: { paintImageXObject: 1, constructPath: 2 },
        getDocument: () => ({
          promise: Promise.resolve({
            numPages: 1,
            getPage: async () => ({
              view: [0, 0, 612, 792],
              userUnit: 1,
              rotate: 0,
              getViewport: () => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
              getTextContent: async () => ({ items: [], styles: {} }),
              getOperatorList: testCase.kind === "deadline"
                ? () => new Promise(() => {})
                : async () => { throw testCase.error; },
              cleanup: () => { cleanup.page += 1; },
            }),
            destroy: async () => { cleanup.document += 1; },
          }),
          destroy: async () => { cleanup.loading += 1; },
        }),
      };
      const deadlineAt = Date.now() + (testCase.kind === "deadline" ? 40 : 20000);
      const rejection = expect(validatePdfLayoutSourceEvidence(successful.result, {
        pdfjsLib: fatalPdfjs,
        sourceBytes: successful.bytes,
        deadlineAt,
      })).rejects;
      if (testCase.kind === "deadline") await rejection.toMatchObject({ code: "LAYOUT_DEADLINE" });
      else await rejection.toBe(testCase.error);
      expect(cleanup).toEqual({ page: 1, document: 1, loading: 1 });
    }
  });

  it("replays ordinary getPage and getViewport failures as failed-page IR with balanced parse lifecycles", async () => {
    const bytes = await pdfBytes(1);
    for (const stage of ["getPage", "getViewport"]) {
      const cleanup = { page: 0, document: 0, loading: 0 };
      const ordinaryError = new Error(`synthetic ordinary ${stage} failure`);
      const pdfjs = {
        version: "5.4.624",
        OPS: {},
        getDocument: () => ({
          promise: Promise.resolve({
            numPages: 1,
            getPage: async () => {
              if (stage === "getPage") throw ordinaryError;
              return {
                view: [0, 0, 612, 792],
                userUnit: 1,
                rotate: 0,
                getViewport: () => { throw ordinaryError; },
                cleanup: () => { cleanup.page += 1; },
              };
            },
            destroy: async () => { cleanup.document += 1; },
          }),
          destroy: async () => { cleanup.loading += 1; },
        }),
      };
      const result = await extractPdfLayout({
        pdfjsLib: pdfjs,
        pdfBytes: bytes,
        sourcePath: `/synthetic/${stage}-failure.pdf`,
        sourceFileName: `${stage}-failure.pdf`,
        sourceSha256: createHash("sha256").update(bytes).digest("hex"),
        maxOutputCharacters: 200000,
      });
      expect(result.pages[0]).toMatchObject({
        text_layer_status: "failed",
        image_detection_status: "failed",
        modality_hint: "unknown",
        extraction_status: "failed",
        needs_visual_inspection: true,
        raw_items: [],
        has_image_operations: null,
        has_vector_paint_operations: null,
        errors: [{ stage: "page", code: "Error", message: ordinaryError.message }],
      });
      expect(cleanup).toEqual({
        page: stage === "getViewport" ? 2 : 0,
        document: 2,
        loading: 2,
      });

      if (stage === "getPage") {
        // Exact formerly accepted relabel: inject one observed/omitted UTF-16
        // code unit into an honest failed page and mirror document aggregates.
        const injectedCharacter = structuredClone(result);
        injectedCharacter.pages[0].counts.observed_characters = 1;
        injectedCharacter.pages[0].truncation = {
          truncated: true,
          reasons: ["max_characters"],
          omitted_items: 0,
          omitted_non_whitespace_items: 0,
          omitted_characters: 1,
          first_omitted_source_index: 0,
        };
        injectedCharacter.truncation = {
          truncated: true,
          reasons: ["max_characters"],
          omitted_items: 0,
          omitted_characters: 1,
          first_omitted_page: 1,
          first_omitted_source_index: 0,
        };
        expect(() => validatePdfLayoutSemantics(injectedCharacter, { sourceBytes: bytes })).not.toThrow();
        await expect(validatePdfLayoutSourceEvidence(injectedCharacter, { pdfjsLib: pdfjs, sourceBytes: bytes }))
          .rejects.toThrow(/ordinary page failure differs from reparsed source/);

        const injectedItemCount = structuredClone(result);
        injectedItemCount.pages[0].counts.observed_items = 1;
        injectedItemCount.pages[0].counts.observed_non_whitespace_items = 1;
        injectedItemCount.pages[0].truncation = {
          truncated: true,
          reasons: ["max_items"],
          omitted_items: 1,
          omitted_non_whitespace_items: 1,
          omitted_characters: 0,
          first_omitted_source_index: 0,
        };
        injectedItemCount.truncation = {
          truncated: true,
          reasons: ["max_items"],
          omitted_items: 1,
          omitted_characters: 0,
          first_omitted_page: 1,
          first_omitted_source_index: 0,
        };
        expect(() => validatePdfLayoutSemantics(injectedItemCount, { sourceBytes: bytes })).not.toThrow();
        await expect(validatePdfLayoutSourceEvidence(injectedItemCount, { pdfjsLib: pdfjs, sourceBytes: bytes }))
          .rejects.toThrow(/ordinary page failure differs from reparsed source/);

        const forgedKnownGeometry = structuredClone(result);
        forgedKnownGeometry.pages[0].geometry.pdfjs_view = [0, 0, 612, 792];
        forgedKnownGeometry.pages[0].geometry.user_unit = 1;
        forgedKnownGeometry.pages[0].geometry.display_rotation = 0;
        forgedKnownGeometry.pages[0].geometry.rotation_matches_raw = true;
        await expect(validatePdfLayoutSourceEvidence(forgedKnownGeometry, { pdfjsLib: pdfjs, sourceBytes: bytes }))
          .rejects.toThrow(/pdfjs_view differs from reparsed source/);
      } else {
        const forgedViewport = structuredClone(result);
        forgedViewport.pages[0].geometry.display_width = 612;
        forgedViewport.pages[0].geometry.display_height = 792;
        forgedViewport.pages[0].geometry.viewport_transform = [1, 0, 0, -1, 0, 792];
        expect(() => validatePdfLayoutSemantics(forgedViewport, { sourceBytes: bytes })).not.toThrow();
        await expect(validatePdfLayoutSourceEvidence(forgedViewport, { pdfjsLib: pdfjs, sourceBytes: bytes }))
          .rejects.toThrow(/display_width differs from reparsed source/);
      }
    }
  });

  it("uses PDF.js as password authority, never echoes passwords, and destroys tasks/documents", async () => {
    const bytes = await pdfBytes(1);
    const missingRuntime = fakePdfjs([{ items: [] }], { requiredPassword: "correct-secret" });
    let missingError;
    try {
      await extractPdfLayout({
        pdfjsLib: missingRuntime.pdfjs,
        pdfBytes: bytes,
        sourcePath: "/fake.pdf",
        sourceFileName: "fake.pdf",
        sourceSha256: "0".repeat(64),
      });
    } catch (error) {
      missingError = error;
    }
    expect(missingError).toBeInstanceOf(Error);
    expect(missingError.code).toBe("PASSWORD_REQUIRED");
    expect(missingError.message).not.toContain("correct-secret");
    expect(missingRuntime.state.loading_destroyed).toBe(true);

    const wrongRuntime = fakePdfjs([{ items: [] }], { requiredPassword: "correct-secret" });
    let wrongError;
    try {
      await extractPdfLayout({
        pdfjsLib: wrongRuntime.pdfjs,
        pdfBytes: bytes,
        sourcePath: "/fake.pdf",
        sourceFileName: "fake.pdf",
        sourceSha256: "0".repeat(64),
        password: "wrong-secret",
      });
    } catch (error) {
      wrongError = error;
    }
    expect(wrongError).toBeInstanceOf(Error);
    expect(wrongError.code).toBe("PASSWORD_INCORRECT");
    expect(wrongError.message).not.toContain("wrong-secret");
    expect(wrongRuntime.state.loading_destroyed).toBe(true);

    const correctRuntime = fakePdfjs([{ items: [] }], { requiredPassword: "correct-secret" });
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    await extractPdfLayout({
      pdfjsLib: correctRuntime.pdfjs,
      pdfBytes: bytes,
      sourcePath: "/fake.pdf",
      sourceFileName: "fake.pdf",
      sourceSha256: actualSha256,
      password: "correct-secret",
      maxOutputCharacters: 200000,
    });
    expect(correctRuntime.state).toMatchObject({ loading_destroyed: true, document_destroyed: true, page_cleanups: 2 });
    expect(correctRuntime.state.document_options).toMatchObject({
      cMapPacked: true,
      useWorkerFetch: false,
    });
    expect(correctRuntime.state.document_options.cMapUrl).toContain("pdfjs-dist/cmaps/");
    expect(correctRuntime.state.document_options.standardFontDataUrl).toContain("pdfjs-dist/standard_fonts/");
  });

  it("cleans up the real PDF.js task, authenticated document, and page for the encrypted fail-soft oracle", async () => {
    const actualPdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const bytes = await fs.readFile(ENCRYPTED_LAYOUT);
    const provenance = JSON.parse(await fs.readFile(ENCRYPTED_LAYOUT_PROVENANCE, "utf8"));
    for (const password of [provenance.passwords.user, provenance.passwords.owner]) {
      const { pdfjs, state } = instrumentRealPdfjs(actualPdfjs);
      const result = await extractPdfLayout({
        pdfjsLib: pdfjs,
        pdfBytes: bytes,
        sourcePath: ENCRYPTED_LAYOUT,
        sourceFileName: path.basename(ENCRYPTED_LAYOUT),
        sourceSha256: createHash("sha256").update(bytes).digest("hex"),
        password,
        requestedStartPage: 1,
        requestedEndPage: 1,
        maxOutputCharacters: 200000,
      });
      expect(state).toEqual({ loading_destroyed: 2, document_destroyed: 2, page_cleanups: 2 });
      expect(result.pages[0]).toMatchObject({
        extraction_status: "partial",
        geometry: { media_box: null, crop_box: null, pdfjs_view: [0, 0, 612, 792] },
        errors: [expect.objectContaining({ code: "RAW_PAGE_GEOMETRY_UNAVAILABLE" })],
      });
      expect(result.pages[0].flow_text).toContain("TWO COLUMN NOTICE");
      for (const testPassword of Object.values(provenance.passwords)) {
        expect(JSON.stringify(result)).not.toContain(testPassword);
      }
    }
  });

  it("destroys each real PDF.js password task exactly once on missing and wrong passwords", async () => {
    const actualPdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const bytes = await fs.readFile(ENCRYPTED_LAYOUT);
    const provenance = JSON.parse(await fs.readFile(ENCRYPTED_LAYOUT_PROVENANCE, "utf8"));
    for (const testCase of [
      { password: null, code: "PASSWORD_REQUIRED" },
      { password: provenance.passwords.wrong_password_oracle, code: "PASSWORD_INCORRECT" },
    ]) {
      const { pdfjs, state } = instrumentRealPdfjs(actualPdfjs);
      await expect(extractPdfLayout({
        pdfjsLib: pdfjs,
        pdfBytes: bytes,
        sourcePath: ENCRYPTED_LAYOUT,
        sourceFileName: path.basename(ENCRYPTED_LAYOUT),
        sourceSha256: createHash("sha256").update(bytes).digest("hex"),
        password: testCase.password,
        requestedStartPage: 1,
        requestedEndPage: 1,
        maxOutputCharacters: 200000,
      })).rejects.toMatchObject({ code: testCase.code });
      expect(state).toEqual({ loading_destroyed: 1, document_destroyed: 0, page_cleanups: 0 });
    }
  });

  it("destroys a loading task on deadline", async () => {
    const bytes = await pdfBytes(1);
    const runtime = fakePdfjs([{ items: [] }], { neverLoad: true });
    await expect(extractPdfLayout({
      pdfjsLib: runtime.pdfjs,
      pdfBytes: bytes,
      sourcePath: "/fake.pdf",
      sourceFileName: "fake.pdf",
      sourceSha256: "0".repeat(64),
      deadlineMs: 5,
    })).rejects.toThrow(/deadline/);
    expect(runtime.state.loading_destroyed).toBe(true);
  });

  it("rejects strict semantic output mutations", async () => {
    const { result, bytes } = await runFake([{ items: [textItem({ text: "one", x: 10, top: 20 })] }]);
    const validator = new AjvJsonSchemaValidator().getValidator(TOOL_SUCCESS_OUTPUT_SCHEMAS.read_pdf_layout);
    expect(validator(result).valid).toBe(true);
    const mutants = [
      value => { value.ir.version = "unversioned"; },
      value => { value.parser.version = "latest"; },
      value => { value.pages[0].geometry.item_space.reference_box = "signing"; },
      value => { value.pages[0].raw_items[0].unexpected = true; },
      value => { value.pages[0].raw_items[0].bbox_status = "probably"; },
      value => { value.pages[0].reading_order.confidence = 0.9; },
    ];
    for (const mutate of mutants) {
      const mutant = structuredClone(result);
      mutate(mutant);
      expect(validator(mutant).valid).toBe(false);
    }

    const semanticMutants = [
      value => { value.id_scope.source_sha256 = "f".repeat(64); },
      value => { value.page_range.end_page = 2; },
      value => { value.pages[0].id = "p9999"; },
      value => { value.pages[0].geometry.page = 2; },
      value => { value.pages[0].geometry.display_width = -1; },
      value => { value.pages[0].geometry.viewport_transform[0] = 9; },
      value => { value.pages[0].geometry.viewport_transform[4] += 1; },
      value => {
        value.pages[0].geometry.raw_pdf_rotation = 90;
        value.pages[0].geometry.display_rotation = 90;
      },
      value => { value.pages[0].geometry.rotation_matches_raw = false; },
      value => { value.pages[0].geometry.pdfjs_view[0] += 1; },
      value => { value.pages[0].raw_items[0].id = value.pages[0].id; },
      value => { value.pages[0].raw_items[0].raw_width += 100; },
      value => { value.pages[0].raw_items[0].raw_height += 100; },
      value => { value.pages[0].raw_items[0].raw_transform[1] += 1; },
      value => { value.pages[0].raw_items[0].raw_transform[4] += 100; },
      value => { value.pages[0].raw_items[0].font.vertical = true; },
      value => { value.pages[0].raw_items[0].font.ascent = 0.25; },
      value => { value.pages[0].lines[0].item_ids[0] = "p0001-i999999"; },
      value => { value.pages[0].counts.returned_items = 999999; },
      value => { value.pages[0].counts.returned_non_whitespace_items = 999999; },
      value => { value.pages[0].truncation.reasons = ["unknown_limit"]; },
      value => { value.pages[0].raw_items[0].geometry_provenance.quad_order = "terminal_first"; },
      value => { [value.pages[0].raw_items[0].quad[0], value.pages[0].raw_items[0].quad[1]] = [value.pages[0].raw_items[0].quad[1], value.pages[0].raw_items[0].quad[0]]; },
      value => { value.pages[0].raw_items[0].bbox.x += 1; },
      value => { value.pages[0].raw_items[0].bbox.width += 1; },
      value => { value.pages[0].raw_items[0].geometry_valid = false; },
      value => { value.pages[0].raw_items[0].geometry_provenance.advance_source = "item_height"; },
      value => { value.pages[0].raw_items[0].line_id = null; },
      value => { value.pages[0].raw_items[0].reading_order_index = 99; },
      value => { value.pages[0].lines[0].text = "mutated"; },
      value => { value.pages[0].lines[0].width += 1; },
      value => { value.pages[0].lines[0].direction = "rtl"; },
      value => { value.pages[0].blocks[0].line_ids[0] = "p0001-l999999"; },
      value => { value.pages[0].blocks[0].kind = "column_flow"; },
      value => { value.pages[0].reading_order.column_count = 2; },
      value => { value.pages[0].flow_text = "mutated"; },
      value => { value.pages[0].text_layer_status = "empty"; },
      value => { value.pages[0].image_detection_status = "detected"; },
      value => { value.pages[0].modality_hint = "image-only-candidate"; },
      value => { value.pages[0].needs_visual_inspection = true; },
      value => { value.pages[0].errors.push({ stage: "geometry", code: "X", message: "x".repeat(501) }); },
      value => { value.truncation.omitted_items = 1; },
      value => { value.limits.max_items = value.id_scope.max_items = 5001; },
      value => {
        value.pages[0].extraction_status = "complete";
        value.pages[0].truncation = {
          truncated: true,
          reasons: ["max_items"],
          omitted_items: 1,
          omitted_characters: 0,
          first_omitted_source_index: 1,
        };
      },
    ];
    for (const mutate of semanticMutants) {
      const mutant = structuredClone(result);
      mutate(mutant);
      expect(() => validatePdfLayoutSemantics(mutant)).toThrow(/Invalid Extraction IR semantics/);
    }
    const actualByteMutants = [
      value => { value.source.sha256 = value.id_scope.source_sha256 = "f".repeat(64); },
      value => { value.source.size_bytes += 1; },
    ];
    for (const mutate of actualByteMutants) {
      const mutant = structuredClone(result);
      mutate(mutant);
      expect(() => validatePdfLayoutSemantics(mutant, { sourceBytes: bytes })).toThrow(/Invalid Extraction IR semantics/);
    }
    const boundaryMutants = [
      value => { value.pages[0].counts.returned_items = 999999; },
      value => { value.pages[0].raw_items[0].raw_width += 100; },
      value => { value.pages[0].raw_items[0].raw_height += 100; },
      value => { value.pages[0].raw_items[0].raw_transform[1] += 1; },
      value => { value.pages[0].raw_items[0].raw_transform[4] += 100; },
      value => { value.pages[0].geometry.viewport_transform[0] = 9; },
      value => { value.pages[0].geometry.viewport_transform[4] += 1; },
      value => {
        value.pages[0].geometry.raw_pdf_rotation = 90;
        value.pages[0].geometry.display_rotation = 90;
      },
      value => { value.pages[0].geometry.pdfjs_view[0] += 1; },
      value => { value.pages[0].raw_items[0].font.vertical = true; },
      value => { value.pages[0].raw_items[0].font.ascent = 0.25; },
      value => { value.pages[0].raw_items[0].geometry_provenance.quad_order = "terminal_first"; },
      value => { [value.pages[0].raw_items[0].quad[0], value.pages[0].raw_items[0].quad[1]] = [value.pages[0].raw_items[0].quad[1], value.pages[0].raw_items[0].quad[0]]; },
      value => { value.pages[0].raw_items[0].bbox.x += 1; },
    ];
    for (const mutate of boundaryMutants) {
      const boundaryMutant = structuredClone(result);
      mutate(boundaryMutant);
      const rejected = validateStructuredToolResult("read_pdf_layout", {
        content: [{ type: "text", text: "mutant" }],
        structuredContent: boundaryMutant,
      });
      expect(rejected).toEqual({
        content: [{
          type: "text",
          text:
            "Internal output validation failed for read_pdf_layout. "
            + "No unvalidated structured result was returned.",
        }],
        structuredContent: {
          status: "failed",
          error: {
            error_schema_version: 1,
            code: "internal_validation_error",
          },
        },
        isError: true,
      });
    }
  });

  it("rejects an otherwise reconstructed line whose baseline staircase exceeds the stable spread", async () => {
    const staircaseItems = [100, 105, 110, 115, 120].map((top, index) => textItem({
      text: `S${index + 1}`,
      x: 10 + index * 20,
      top,
      width: 12,
      hasEOL: index === 4,
      transform: [12, 2, 0, 12, 10 + index * 20, 792 - top - 12],
    }));
    const { result } = await runFake([{ items: staircaseItems }]);
    const mutant = structuredClone(result);
    const page = mutant.pages[0];
    const items = page.raw_items;
    const left = Math.min(...items.map(item => item.x));
    const top = Math.min(...items.map(item => item.y));
    const right = Math.max(...items.map(item => item.x + item.width));
    const bottom = Math.max(...items.map(item => item.y + item.height));
    const merged = {
      ...page.lines[0],
      text: "S1 S2 S3 S4 S5",
      x: Number(left.toFixed(3)),
      y: Number(top.toFixed(3)),
      width: Number((right - left).toFixed(3)),
      height: Number((bottom - top).toFixed(3)),
      item_ids: items.map(item => item.id),
    };
    page.lines = [merged];
    items.forEach((item, index) => {
      item.line_id = merged.id;
      item.column_index = 0;
      item.reading_order_index = index;
    });
    page.blocks = [{ ...page.blocks[0], kind: "page_flow", column_index: 0, line_ids: [merged.id] }];
    page.flow_text = merged.text;
    page.spatial_text = `[${merged.id} x=${merged.x} y=${merged.y} w=${merged.width} h=${merged.height}] ${merged.text}`;
    expect(() => validatePdfLayoutSemantics(mutant)).toThrow(/baseline spread mismatch/);
  });
});
