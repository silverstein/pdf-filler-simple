import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractPdfLayout, validatePdfLayoutSemantics } from "../server/layout-extraction.js";
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

  it("applies rotations once and preserves offset boxes plus UserUnit", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (const rotation of [0, 90, 180, 270]) {
      const page = document.addPage([200, 300]);
      page.setRotation(degrees(rotation));
      page.drawText(`R${rotation}`, { x: 72, y: 100, size: 12, font });
    }
    const offset = document.addPage([420, 540]);
    offset.setMediaBox(10, 20, 400, 500);
    offset.setCropBox(30, 40, 300, 400);
    offset.node.set(PDFName.of("UserUnit"), PDFNumber.of(2));
    offset.drawText("UNIT2", { x: 72, y: 100, size: 12, font });
    const offsetUnit1 = document.addPage([420, 540]);
    offsetUnit1.setMediaBox(10, 20, 400, 500);
    offsetUnit1.setCropBox(30, 40, 300, 400);
    offsetUnit1.drawText("UNIT2", { x: 72, y: 100, size: 12, font });
    const fixture = path.join(temporaryRoot, "rotations-userunit.pdf");
    await fs.writeFile(fixture, await document.save({ useObjectStreams: false }));

    const rotations = await client.callTool({ name: "read_pdf_layout", arguments: { pdf_path: fixture, start_page: 1, end_page: 4, max_output_characters: 200000 } });
    expect(rotations.structuredContent.pages.map(page => page.geometry.viewport_transform)).toEqual([
      [1, 0, 0, -1, 0, 300],
      [0, 1, 1, 0, 0, 0],
      [-1, 0, 0, 1, 200, 0],
      [0, -1, -1, 0, 300, 200],
    ]);
    expect(rotations.structuredContent.pages.map(page => page.geometry.display_rotation)).toEqual([0, 90, 180, 270]);

    const unit = await client.callTool({ name: "read_pdf_layout", arguments: { pdf_path: fixture, start_page: 5, end_page: 6, max_output_characters: 200000 } });
    expect(unit.structuredContent.pages[0].geometry).toMatchObject({
      media_box: { x: 10, y: 20, width: 400, height: 500 },
      crop_box: { x: 30, y: 40, width: 300, height: 400 },
      pdfjs_view: [30, 40, 330, 440],
      user_unit: 2,
      display_width: 600,
      display_height: 800,
    });
    const unit2Item = unit.structuredContent.pages[0].raw_items.find(item => item.text === "UNIT2");
    const unit1Item = unit.structuredContent.pages[1].raw_items.find(item => item.text === "UNIT2");
    expect(unit2Item.raw_width).toBe(unit1Item.raw_width);
    expect(unit1Item.bbox.width).toBeCloseTo(unit1Item.raw_width, 3);
    expect(unit2Item.bbox.width).toBeCloseTo(unit2Item.raw_width * 2, 3);
    expect(unit2Item.bbox.width).toBeCloseTo(unit1Item.bbox.width * 2, 3);
    expect(unit2Item.quad[1].x - unit2Item.quad[0].x).toBeCloseTo(
      (unit1Item.quad[1].x - unit1Item.quad[0].x) * 2,
      3,
    );
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
    for (let index = 0; index < 120; index += 1) {
      pressurePage.drawText(`Pressure line ${index}: ${"bounded layout content ".repeat(3)}`, {
        x: 40,
        y: 3950 - index * 30,
        size: 10,
        font: pressureFont,
      });
    }
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

    const missing = await client.callTool({ name: "read_pdf_layout", arguments: { pdf_path: ENCRYPTED_LAYOUT } });
    expect(missing).toMatchObject({
      isError: true,
      structuredContent: { status: "failed", error: { error_schema_version: 1, code: "PASSWORD_REQUIRED" } },
    });
    expect(JSON.stringify(missing)).not.toContain(provenance.passwords.user);

    const wrong = await client.callTool({
      name: "read_pdf_layout",
      arguments: { pdf_path: ENCRYPTED_LAYOUT, password: "definitely-wrong-layout-password" },
    });
    expect(wrong).toMatchObject({
      isError: true,
      structuredContent: { status: "failed", error: { error_schema_version: 1, code: "PASSWORD_INCORRECT" } },
    });
    expect(JSON.stringify(wrong)).not.toContain("definitely-wrong-layout-password");
    expect(JSON.stringify(wrong)).not.toContain(provenance.passwords.user);

    const correct = await client.callTool({
      name: "read_pdf_layout",
      arguments: { pdf_path: ENCRYPTED_LAYOUT, password: provenance.passwords.user, max_output_characters: 200000 },
    });
    expect(correct.isError).not.toBe(true);
    expect(correct.structuredContent.source.sha256).toBe(provenance.encrypted_fixture.sha256);
    expect(correct.structuredContent.extraction_status).toBe("partial");
    expect(correct.structuredContent.pages[0]).toMatchObject({
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
    expect(correct.structuredContent.pages[0].flow_text).toContain("TWO COLUMN NOTICE");
    expect(JSON.stringify(correct)).not.toContain(provenance.passwords.user);
    expect(JSON.stringify(correct)).not.toContain(provenance.passwords.owner);
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
    expect(correctRuntime.state).toMatchObject({ loading_destroyed: true, document_destroyed: true, page_cleanups: 1 });
    expect(correctRuntime.state.document_options).toMatchObject({
      cMapPacked: true,
      useWorkerFetch: false,
    });
    expect(correctRuntime.state.document_options.cMapUrl).toContain("pdfjs-dist/cmaps/");
    expect(correctRuntime.state.document_options.standardFontDataUrl).toContain("pdfjs-dist/standard_fonts/");
  });

  it("cleans up the real PDF.js task, authenticated document, and page for the encrypted fail-soft oracle", async () => {
    const actualPdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const { pdfjs, state } = instrumentRealPdfjs(actualPdfjs);
    const bytes = await fs.readFile(ENCRYPTED_LAYOUT);
    const provenance = JSON.parse(await fs.readFile(ENCRYPTED_LAYOUT_PROVENANCE, "utf8"));
    const result = await extractPdfLayout({
      pdfjsLib: pdfjs,
      pdfBytes: bytes,
      sourcePath: ENCRYPTED_LAYOUT,
      sourceFileName: path.basename(ENCRYPTED_LAYOUT),
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      password: provenance.passwords.user,
      requestedStartPage: 1,
      requestedEndPage: 1,
      maxOutputCharacters: 200000,
    });
    expect(state).toEqual({ loading_destroyed: 1, document_destroyed: 1, page_cleanups: 1 });
    expect(result.pages[0]).toMatchObject({
      extraction_status: "partial",
      geometry: { media_box: null, crop_box: null, pdfjs_view: [0, 0, 612, 792] },
      errors: [expect.objectContaining({ code: "RAW_PAGE_GEOMETRY_UNAVAILABLE" })],
    });
    expect(result.pages[0].flow_text).toContain("TWO COLUMN NOTICE");
    expect(JSON.stringify(result)).not.toContain(provenance.passwords.user);
    expect(JSON.stringify(result)).not.toContain(provenance.passwords.owner);
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
      value => { value.pages[0].raw_items[0].id = value.pages[0].id; },
      value => { value.pages[0].raw_items[0].raw_width += 100; },
      value => { value.pages[0].raw_items[0].raw_height += 100; },
      value => { value.pages[0].raw_items[0].raw_transform[4] += 100; },
      value => { value.pages[0].raw_items[0].font.vertical = true; },
      value => { value.pages[0].raw_items[0].font.ascent = 0.25; },
      value => { value.pages[0].lines[0].item_ids[0] = "p0001-i999999"; },
      value => { value.pages[0].counts.returned_items = 999999; },
      value => { value.pages[0].counts.returned_non_whitespace_items = 999999; },
      value => { value.pages[0].truncation.reasons = ["unknown_limit"]; },
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
      value => { value.pages[0].raw_items[0].raw_transform[4] += 100; },
      value => { value.pages[0].geometry.viewport_transform[0] = 9; },
      value => { value.pages[0].raw_items[0].font.vertical = true; },
      value => { value.pages[0].raw_items[0].font.ascent = 0.25; },
    ];
    for (const mutate of boundaryMutants) {
      const boundaryMutant = structuredClone(result);
      mutate(boundaryMutant);
      const rejected = validateStructuredToolResult("read_pdf_layout", {
        content: [{ type: "text", text: "mutant" }],
        structuredContent: boundaryMutant,
      });
      expect(rejected).toMatchObject({ isError: true });
      expect(rejected.structuredContent).toBeUndefined();
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
