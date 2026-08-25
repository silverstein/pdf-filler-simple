import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractPdfLayoutForMarkdown } from "../server/layout-extraction.js";
import {
  buildSourceBoundDocumentMap,
  DEFAULT_DOCUMENT_MAP_CHUNK_POLICY,
  readSourceBoundDocumentChunk,
  validateSourceBoundDocumentMap,
} from "../server/document-map.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(
  REPO_ROOT,
  "test/fixtures/eval/extraction/synthetic/mixed-text-raster.pdf",
);
const SCHEMA = Buffer.from(JSON.stringify({
  type: "object",
  additionalProperties: false,
  properties: { agency: { type: "string" } },
  required: ["agency"],
}), "utf8");

function clone(value) {
  return structuredClone(value);
}

describe("source-bound document map and chunk contract", () => {
  let sourceBytes;
  let layouts;
  let furnitureSourceBytes;
  let furnitureLayouts;
  let headingSourceBytes;
  let headingLayouts;

  beforeAll(async () => {
    sourceBytes = await fs.readFile(SOURCE);
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    layouts = [];
    for (const page of [1, 2]) {
      layouts.push(await extractPdfLayoutForMarkdown({
        pdfjsLib,
        pdfBytes: sourceBytes,
        sourcePath: SOURCE,
        sourceFileName: path.basename(SOURCE),
        sourceSha256,
        requestedStartPage: page,
        requestedEndPage: page,
        maxItems: 5000,
        maxCharacters: 100000,
        maxOutputCharacters: 200000,
        deadlineMs: 20000,
      }));
    }

    const furnitureDocument = await PDFDocument.create();
    const regular = await furnitureDocument.embedFont(StandardFonts.Helvetica);
    const bold = await furnitureDocument.embedFont(StandardFonts.HelveticaBold);
    for (const pageNumber of [1, 2, 3]) {
      const page = furnitureDocument.addPage([612, 792]);
      page.drawText("Annual Report 2026", { x: 72, y: 772, size: 9, font: regular });
      page.drawText(`${pageNumber}. OPERATING RESULTS`, { x: 72, y: 700, size: 18, font: bold });
      page.drawText("The department completed the first measured objective.", {
        x: 72, y: 650, size: 11, font: regular,
      });
      page.drawText("The source record remains available for deterministic replay.", {
        x: 72, y: 630, size: 11, font: regular,
      });
      page.drawText("Every admitted value is reported with its page evidence.", {
        x: 72, y: 610, size: 11, font: regular,
      });
      page.drawText(`Page ${pageNumber}`, { x: 285, y: 16, size: 9, font: regular });
    }
    furnitureSourceBytes = Buffer.from(await furnitureDocument.save({
      useObjectStreams: false,
      addDefaultPage: false,
      updateFieldAppearances: false,
    }));
    const furnitureSha256 = createHash("sha256").update(furnitureSourceBytes).digest("hex");
    furnitureLayouts = [await extractPdfLayoutForMarkdown({
      pdfjsLib,
      pdfBytes: furnitureSourceBytes,
      sourcePath: "/synthetic/document-map-furniture.pdf",
      sourceFileName: "document-map-furniture.pdf",
      sourceSha256: furnitureSha256,
      requestedStartPage: 1,
      requestedEndPage: 3,
      maxItems: 5000,
      maxCharacters: 100000,
      maxOutputCharacters: 200000,
      deadlineMs: 20000,
    })];
    const headingSource = path.join(
      REPO_ROOT,
      "test/fixtures/eval/extraction/intelligence/compact-toc.pdf",
    );
    headingSourceBytes = await fs.readFile(headingSource);
    headingLayouts = [await extractPdfLayoutForMarkdown({
      pdfjsLib,
      pdfBytes: headingSourceBytes,
      sourcePath: headingSource,
      sourceFileName: path.basename(headingSource),
      sourceSha256: createHash("sha256").update(headingSourceBytes).digest("hex"),
      requestedStartPage: 1,
      requestedEndPage: 1,
      maxItems: 5000,
      maxCharacters: 100000,
      maxOutputCharacters: 200000,
      deadlineMs: 20000,
    })];
  }, 60000);

  it("is deterministic across unrelated extraction-call order and replays returned chunks", () => {
    const first = buildSourceBoundDocumentMap({
      sourceBytes,
      schemaBytes: SCHEMA,
      layouts,
    });
    const second = buildSourceBoundDocumentMap({
      sourceBytes,
      schemaBytes: SCHEMA,
      layouts: [...layouts].reverse(),
    });

    expect(second).toEqual(first);
    expect(first.page_count).toBe(2);
    expect(first.coverage.accounted).toBe(true);
    expect(first.coverage.observed_pages).toBe(first.coverage.accounted_pages);
    expect(first.coverage.observed_items).toBe(
      first.coverage.chunk_admitted_items
      + first.coverage.layout_omitted_items
      + first.coverage.furniture_omitted_items
      + first.coverage.empty_line_omitted_items
      + first.coverage.unassigned_omitted_items,
    );
    expect(first.coverage.observed_characters).toBe(
      first.coverage.chunk_admitted_characters
      + first.coverage.layout_omitted_characters
      + first.coverage.furniture_omitted_characters
      + first.coverage.empty_line_omitted_characters
      + first.coverage.unassigned_omitted_characters,
    );
    expect(first.chunks.observed).toBeGreaterThan(0);
    expect(first.chunks.returned).toBe(first.chunks.observed);

    const descriptor = first.chunks.descriptors[0];
    const chunk = readSourceBoundDocumentChunk({
      documentMap: first,
      chunkId: descriptor.chunk_id,
      sourceBytes,
      schemaBytes: SCHEMA,
      layouts,
    });
    expect(chunk.document_map_sha256).toBe(first.document_map_sha256);
    expect(chunk.content_sha256).toBe(descriptor.content_sha256);
    expect(Buffer.byteLength(chunk.content, "utf8")).toBe(descriptor.content_utf8_bytes);
    expect(chunk.admitted_item_count).toBe(descriptor.admitted_item_count);
    expect(chunk.omitted_item_count).toBe(0);
    expect(validateSourceBoundDocumentMap(first, {
      sourceBytes,
      schemaBytes: SCHEMA,
      layouts,
    })).toBe(first);
  });

  it("reports every bounded omission while binding the complete hidden inventory", () => {
    const chunkPolicy = {
      ...DEFAULT_DOCUMENT_MAP_CHUNK_POLICY,
      max_chunk_utf8_bytes: 256,
      max_lines_per_chunk: 1,
      max_returned_chunks: 1,
      max_returned_headings: 0,
      max_returned_table_regions: 0,
      max_returned_gaps: 0,
    };
    const map = buildSourceBoundDocumentMap({
      sourceBytes,
      schemaBytes: SCHEMA,
      layouts,
      chunkPolicy,
    });

    expect(map.chunks.observed).toBeGreaterThan(1);
    expect(map.chunks.returned).toBe(1);
    expect(map.chunks.omitted).toBe(map.chunks.observed - 1);
    expect(map.headings.returned).toBe(0);
    expect(map.headings.omitted).toBe(map.headings.observed);
    expect(map.table_regions.returned).toBe(0);
    expect(map.table_regions.omitted).toBe(map.table_regions.observed);
    expect(map.gaps.returned).toBe(0);
    expect(map.gaps.omitted).toBe(map.gaps.observed);
    expect(map.chunks.all_descriptors_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(map.pages.reduce((sum, page) => sum + page.chunk_counts.omitted, 0))
      .toBe(map.chunks.omitted);
    expect(map.pages.reduce((sum, page) => (
      sum + page.chunk_counts.omitted_content_utf8_bytes
    ), 0)).toBe(map.chunks.omitted_content_utf8_bytes);
    expect(map.chunks.omitted_content_utf8_bytes).toBeGreaterThan(0);
    expect(map.chunks.omitted_admitted_item_references).toBeGreaterThan(0);
    expect(() => readSourceBoundDocumentChunk({
      documentMap: map,
      chunkId: `chunk.${"f".repeat(64)}`,
      sourceBytes,
      schemaBytes: SCHEMA,
      layouts,
      chunkPolicy,
    })).toThrow(/unknown or omitted/u);
  });

  it("fails closed on source, schema, renderer, parser, policy, page, and chunk drift", () => {
    const map = buildSourceBoundDocumentMap({
      sourceBytes,
      schemaBytes: SCHEMA,
      layouts,
    });
    const validate = (documentMap = map, overrides = {}) => validateSourceBoundDocumentMap(
      documentMap,
      {
        sourceBytes,
        schemaBytes: SCHEMA,
        layouts,
        ...overrides,
      },
    );

    expect(() => validate(map, {
      sourceBytes: Buffer.concat([sourceBytes, Buffer.from("drift")]),
    })).toThrow(/source identity/u);
    expect(() => validate(map, {
      schemaBytes: Buffer.concat([SCHEMA, Buffer.from(" ")]),
    })).toThrow(/stale, drifted/u);

    const rendererDrift = clone(map);
    rendererDrift.bindings.renderer.version = "99.0.0";
    expect(() => validate(rendererDrift)).toThrow(/stale, drifted/u);
    const contractDrift = clone(map);
    contractDrift.contract.version = "99.0.0";
    expect(() => validate(contractDrift)).toThrow(/stale, drifted/u);

    const parserDrift = clone(layouts);
    parserDrift[0].parser.version = "99.0.0";
    expect(() => validate(map, { layouts: parserDrift })).toThrow(/parser/u);
    const irDrift = clone(layouts);
    irDrift[0].ir.version = "99.0.0";
    expect(() => validate(map, { layouts: irDrift })).toThrow(/Extraction IR/u);

    const policyDrift = {
      ...DEFAULT_DOCUMENT_MAP_CHUNK_POLICY,
      max_lines_per_chunk: DEFAULT_DOCUMENT_MAP_CHUNK_POLICY.max_lines_per_chunk - 1,
    };
    expect(() => validate(map, { chunkPolicy: policyDrift })).toThrow(/stale, drifted/u);

    const omittedPage = [layouts[0]];
    expect(() => validate(map, { layouts: omittedPage })).toThrow(/every source page/u);
    const duplicatePage = [layouts[0], layouts[0]];
    expect(() => validate(map, { layouts: duplicatePage })).toThrow(/duplicated/u);

    const chunkDrift = clone(map);
    chunkDrift.chunks.descriptors[0].content_sha256 = "f".repeat(64);
    expect(() => validate(chunkDrift)).toThrow(/stale, drifted/u);
  });

  it("uses heading and byte bounds without splitting Unicode code points", () => {
    const chunkPolicy = {
      ...DEFAULT_DOCUMENT_MAP_CHUNK_POLICY,
      max_chunk_utf8_bytes: 256,
      max_lines_per_chunk: 2,
    };
    const map = buildSourceBoundDocumentMap({
      sourceBytes,
      schemaBytes: SCHEMA,
      layouts,
      chunkPolicy,
    });
    expect(map.chunks.descriptors.every(chunk => (
      chunk.content_utf8_bytes <= chunkPolicy.max_chunk_utf8_bytes
      && chunk.line_fragments <= chunkPolicy.max_lines_per_chunk
    ))).toBe(true);
    for (const descriptor of map.chunks.descriptors) {
      const chunk = readSourceBoundDocumentChunk({
        documentMap: map,
        chunkId: descriptor.chunk_id,
        sourceBytes,
        schemaBytes: SCHEMA,
        layouts,
        chunkPolicy,
      });
      expect(Buffer.from(chunk.content, "utf8").toString("utf8")).toBe(chunk.content);
    }
  });

  it("reuses the active heading and cross-page furniture evidence rules", () => {
    const map = buildSourceBoundDocumentMap({
      sourceBytes: furnitureSourceBytes,
      schemaBytes: SCHEMA,
      layouts: furnitureLayouts,
    });
    expect(map.coverage.furniture_omitted_items).toBeGreaterThanOrEqual(4);
    expect(map.gaps.items.filter(gap => gap.code === "PAGE_FURNITURE_REMOVED"))
      .toHaveLength(2);
    const chunks = map.chunks.descriptors.map(descriptor => readSourceBoundDocumentChunk({
      documentMap: map,
      chunkId: descriptor.chunk_id,
      sourceBytes: furnitureSourceBytes,
      schemaBytes: SCHEMA,
      layouts: furnitureLayouts,
    }));
    const contents = chunks.map(chunk => chunk.content).join("\n");
    expect(chunks.filter(chunk => chunk.page_range.start_page === 1)
      .map(chunk => chunk.content).join("\n")).toContain("Annual Report 2026");
    expect(chunks.filter(chunk => chunk.page_range.start_page > 1)
      .map(chunk => chunk.content).join("\n")).not.toContain("Annual Report 2026");
    expect(contents).toContain("Page 1");
    expect(contents).not.toMatch(/Page [23]/u);
    expect(contents).toContain("OPERATING RESULTS");
  });

  it("prefers an active renderer heading as a stable chunk boundary", () => {
    const map = buildSourceBoundDocumentMap({
      sourceBytes: headingSourceBytes,
      schemaBytes: SCHEMA,
      layouts: headingLayouts,
    });
    expect(map.headings.items.map(heading => heading.text)).toContain("CONTENTS");
    expect(map.chunks.descriptors[0].starts_at_heading).toBe(true);
    expect(map.chunks.descriptors[0].line_range.first_line_id)
      .toBe(map.headings.items[0].line_id);
  });
});
