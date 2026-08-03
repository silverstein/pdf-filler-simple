import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generateExtractionIntelligenceFixtures,
  TABLE_RULED_GRID_CELLS,
} from "../scripts/eval-generate-extraction-intelligence-fixtures.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTELLIGENCE_ROOT = path.join(REPO_ROOT, "test/fixtures/eval/extraction/intelligence");
const MANIFEST_PATH = path.join(INTELLIGENCE_ROOT, "manifest.v1.json");
const ROUTING_TRUTH_PATH = path.join(INTELLIGENCE_ROOT, "routing-truth.json");

const PUA_TEXT = [
  "\uE000\uE001\uFFFD\uE002\uFFFD\uE003\uE004\uE005\uE006\uFFFD",
  "\uE000\uE001\uFFFD\uE002\uFFFD\uE003\uE004\uE005\uE006\uFFFD",
  "\uE000\uE001\uFFFD\uE002\uFFFD\uE003\uE004\uE005\uE006\uFFFD",
  "\uE000\uE001\uFFFD\uE002\uFFFD\uE003\uE004\uE005\uE006\uFFFD",
  "\uE000\uE001\uFFFD\uE002\uFFFD\uE003\uE004",
].join("");

const FIXTURE_FILES = [
  "table-ruled-grid.pdf",
  "table-ruled-merged-negative.pdf",
  "table-ruled-lines.pdf",
  "text-integrity-pua.pdf",
  "routing-mixed.pdf",
  "compact-toc.pdf",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const TABLE_GRID_MARKDOWN = `<!-- PDF page 1 -->

| Region | Q1 | Q2 |
| --- | --- | --- |
| North | 1200 | 1450 |
| South | 980 | 1020 |
| West | 1500 | 1380 |

## Conversion gaps

- Page 1: Vector paint operations beyond any reconstructed table rulings were not interpreted.

## Conversion limitations

- Headings are emitted only when a short line has consistent font metrics and is at least 1.5 times the page's median line height.
- Lists are emitted only for literal bullet glyphs or decimal markers present in the source text.
- Links are emitted only for source-validated http or https annotation targets that map to exactly one contiguous run of text on one line. Internal destinations, actions, other schemes, ambiguous or partially covered labels, and links inside reconstructed tables remain escaped text reported as a conversion gap, and URL-looking source text is escaped to resist host autolinking.
- Tables are reconstructed only from text-item column geometry or clean ruled-rectangle grid evidence, and only when every row fills every detected column and the first row is typographically distinct enough to evidence a header (or has non-recurring first-row ruling evidence), because a Markdown table imposes header semantics. Merged or spanning cells are not interpreted, and table-like content that fails either test remains escaped reading-order text reported as a conversion gap.
- Vector paint operations beyond any reconstructed table rulings are not interpreted.
- OCR is not performed. Image-only text and text that exists only inside page images are omitted and reported as conversion gaps.
- Unsafe control characters and malformed UTF-16 surrogates are replaced with the Unicode replacement character and reported as conversion gaps.
`;

const MERGED_MARKDOWN = `<!-- PDF page 1 -->

Status Merged Q1-Q2
North 1200 1450
South 980 1020
West 1500 1380

## Conversion gaps

- Page 1: Table-like content was detected but its column topology could not be reconstructed, so it remains reading-order text.
- Page 1: Vector paint operations beyond any reconstructed table rulings were not interpreted.

## Conversion limitations

- Headings are emitted only when a short line has consistent font metrics and is at least 1.5 times the page's median line height.
- Lists are emitted only for literal bullet glyphs or decimal markers present in the source text.
- Links are emitted only for source-validated http or https annotation targets that map to exactly one contiguous run of text on one line. Internal destinations, actions, other schemes, ambiguous or partially covered labels, and links inside reconstructed tables remain escaped text reported as a conversion gap, and URL-looking source text is escaped to resist host autolinking.
- Tables are reconstructed only from text-item column geometry or clean ruled-rectangle grid evidence, and only when every row fills every detected column and the first row is typographically distinct enough to evidence a header (or has non-recurring first-row ruling evidence), because a Markdown table imposes header semantics. Merged or spanning cells are not interpreted, and table-like content that fails either test remains escaped reading-order text reported as a conversion gap.
- Vector paint operations beyond any reconstructed table rulings are not interpreted.
- OCR is not performed. Image-only text and text that exists only inside page images are omitted and reported as conversion gaps.
- Unsafe control characters and malformed UTF-16 surrogates are replaced with the Unicode replacement character and reported as conversion gaps.
`;

const PUA_MARKDOWN = `<!-- PDF page 1 -->

${PUA_TEXT}

## Conversion limitations

- Headings are emitted only when a short line has consistent font metrics and is at least 1.5 times the page's median line height.
- Lists are emitted only for literal bullet glyphs or decimal markers present in the source text.
- Links are emitted only for source-validated http or https annotation targets that map to exactly one contiguous run of text on one line. Internal destinations, actions, other schemes, ambiguous or partially covered labels, and links inside reconstructed tables remain escaped text reported as a conversion gap, and URL-looking source text is escaped to resist host autolinking.
- Tables are reconstructed only from text-item column geometry or clean ruled-rectangle grid evidence, and only when every row fills every detected column and the first row is typographically distinct enough to evidence a header (or has non-recurring first-row ruling evidence), because a Markdown table imposes header semantics. Merged or spanning cells are not interpreted, and table-like content that fails either test remains escaped reading-order text reported as a conversion gap.
- Vector paint operations beyond any reconstructed table rulings are not interpreted.
- OCR is not performed. Image-only text and text that exists only inside page images are omitted and reported as conversion gaps.
- Unsafe control characters and malformed UTF-16 surrogates are replaced with the Unicode replacement character and reported as conversion gaps.
`;

const ROUTING_MARKDOWN = `<!-- PDF page 1 -->

MIXED ROUTING FIXTURE
Packet ID: ROUTE-77
Page one is born digital.

---

<!-- PDF page 2 -->

[No source-backed text was available on this page.]

## Conversion gaps

- Page 2: No source-backed text-layer content was available on this page.
- Page 2: The page appears image-only, and OCR was not performed.
- Page 2: Image content was not rendered into Markdown.

## Conversion limitations

- Headings are emitted only when a short line has consistent font metrics and is at least 1.5 times the page's median line height.
- Lists are emitted only for literal bullet glyphs or decimal markers present in the source text.
- Links are emitted only for source-validated http or https annotation targets that map to exactly one contiguous run of text on one line. Internal destinations, actions, other schemes, ambiguous or partially covered labels, and links inside reconstructed tables remain escaped text reported as a conversion gap, and URL-looking source text is escaped to resist host autolinking.
- Tables are reconstructed only from text-item column geometry or clean ruled-rectangle grid evidence, and only when every row fills every detected column and the first row is typographically distinct enough to evidence a header (or has non-recurring first-row ruling evidence), because a Markdown table imposes header semantics. Merged or spanning cells are not interpreted, and table-like content that fails either test remains escaped reading-order text reported as a conversion gap.
- Vector paint operations beyond any reconstructed table rulings are not interpreted.
- OCR is not performed. Image-only text and text that exists only inside page images are omitted and reported as conversion gaps.
- Unsafe control characters and malformed UTF-16 surrogates are replaced with the Unicode replacement character and reported as conversion gaps.
`;

const COMPACT_TOC_MARKDOWN = `<!-- PDF page 1 -->

# CONTENTS
Preface ... ii
Chapter 1: Scope .................... 1
Chapter 2: Inputs ................... 7
Chapter 3: Methods ................ 12
Chapter 4: Evidence ............... 19
Chapter 5: Review .................. 24
Chapter 6: Findings ................ 31
Chapter 7: Limits .................. 38
Chapter 8: Appendix ................ 44
Chapter 9: Closing ................. 51
Chapter 10: Index .................. 58
63
71

## Conversion limitations

- Headings are emitted only when a short line has consistent font metrics and is at least 1.5 times the page's median line height.
- Lists are emitted only for literal bullet glyphs or decimal markers present in the source text.
- Links are emitted only for source-validated http or https annotation targets that map to exactly one contiguous run of text on one line. Internal destinations, actions, other schemes, ambiguous or partially covered labels, and links inside reconstructed tables remain escaped text reported as a conversion gap, and URL-looking source text is escaped to resist host autolinking.
- Tables are reconstructed only from text-item column geometry or clean ruled-rectangle grid evidence, and only when every row fills every detected column and the first row is typographically distinct enough to evidence a header (or has non-recurring first-row ruling evidence), because a Markdown table imposes header semantics. Merged or spanning cells are not interpreted, and table-like content that fails either test remains escaped reading-order text reported as a conversion gap.
- Vector paint operations beyond any reconstructed table rulings are not interpreted.
- OCR is not performed. Image-only text and text that exists only inside page images are omitted and reported as conversion gaps.
- Unsafe control characters and malformed UTF-16 surrogates are replaced with the Unicode replacement character and reported as conversion gaps.
`;

function expectedCurrentFor(manifest, filename) {
  const fixture = manifest.fixtures.find(item => item.path === filename);
  expect(fixture).toBeDefined();
  return fixture;
}

function expectCurrentConversion(result, fixture) {
  const expected = fixture.expected_current;
  expect(result.structuredContent.conversion_status).toBe(expected.conversion_status);
  expect(result.structuredContent.gaps.map(gap => gap.code)).toEqual(expected.gap_codes);
  if (Object.hasOwn(expected, "permanent_abstention")) {
    const hasMarkdownTable = result.structuredContent.markdown.split("\n").some(line => /^\|.*\|$/.test(line));
    expect(expected.permanent_abstention).toBe(!hasMarkdownTable);
  }
}

describe("extraction-intelligence current baseline", () => {
  let client;
  let transport;
  let manifest;

  beforeAll(async () => {
    manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: { ALLOWED_DIRECTORIES: REPO_ROOT },
      stderr: "ignore",
    });
    client = new Client({ name: "pdf-extraction-intelligence-baseline", version: "1.0.0" });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
  });

  it("validates the separate six-fixture mini-manifest and all provenance fields", async () => {
    expect(manifest.manifest_version).toBe(1);
    expect(manifest.suite_id).toBe("pdf-tools.extraction.intelligence.baseline");
    expect(manifest.generator).toBe("scripts/eval-generate-extraction-intelligence-fixtures.mjs");
    expect(manifest.fixtures).toHaveLength(6);
    expect(manifest.fixtures.map(fixture => fixture.path)).toEqual(FIXTURE_FILES);
    for (const fixture of manifest.fixtures) {
      expect(fixture.media_type).toBe("application/pdf");
      expect(fixture.provenance.kind).toBe("synthetic");
      expect(fixture.provenance.source_url).toBeNull();
      expect({ spdx_id: fixture.license.spdx_id, redistribution: fixture.license.redistribution }).toEqual({
        spdx_id: "MIT",
        redistribution: "allowed",
      });
      expect({ class: fixture.privacy.class, contains_personal_data: fixture.privacy.contains_personal_data }).toEqual({
        class: "synthetic",
        contains_personal_data: false,
      });
      expect(fixture.page_geometry.length).toBeGreaterThan(0);
      expect(sha256(await fs.readFile(path.join(INTELLIGENCE_ROOT, fixture.path)))).toBe(fixture.sha256);
    }
  });

  it("regenerates every intelligence fixture byte-identically twice", async () => {
    const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-intelligence-first-"));
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-intelligence-second-"));
    try {
      expect(await generateExtractionIntelligenceFixtures(firstRoot)).toEqual(FIXTURE_FILES);
      expect(await generateExtractionIntelligenceFixtures(secondRoot)).toEqual(FIXTURE_FILES);
      for (const filename of FIXTURE_FILES) {
        const committed = await fs.readFile(path.join(INTELLIGENCE_ROOT, filename));
        const first = await fs.readFile(path.join(firstRoot, filename));
        const second = await fs.readFile(path.join(secondRoot, filename));
        expect(first.equals(committed), filename).toBe(true);
        expect(second.equals(first), filename).toBe(true);
      }
    } finally {
      await Promise.all([
        fs.rm(firstRoot, { recursive: true, force: true }),
        fs.rm(secondRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it("freezes current ruled-grid reconstruction from cell-rect evidence", async () => {
    const fixture = expectedCurrentFor(manifest, "table-ruled-grid.pdf");
    const layout = await client.callTool({
      name: "read_pdf_layout",
      arguments: {
        pdf_path: path.join(INTELLIGENCE_ROOT, fixture.path),
        max_output_characters: 200000,
      },
    });
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: {
        pdf_path: path.join(INTELLIGENCE_ROOT, fixture.path),
        max_markdown_bytes: 200000,
      },
    });
    expect(fixture.truth.cells).toEqual(TABLE_RULED_GRID_CELLS);
    expect(layout.isError).not.toBe(true);
    expect(layout.structuredContent.pages[0].flow_text).toBe(
      fixture.truth.cells.map(row => row.join(" ")).join("\n"),
    );
    expect(result.isError).not.toBe(true);
    expectCurrentConversion(result, fixture);
    expect(result.structuredContent.markdown).toBe(TABLE_GRID_MARKDOWN);
    expect(result.structuredContent.markdown).toContain("| Region | Q1 | Q2 |");
    expect(result.structuredContent.markdown.split("\n").some(line => /^\|.*\|$/.test(line))).toBe(
      fixture.expected_current.table_reconstructed,
    );
    expect(result.structuredContent.markdown).toMatch(/^\|.*\|$/m);
    expect(result.structuredContent.gaps.map(gap => gap.code)).toEqual([
      "VECTOR_CONTENT_NOT_INTERPRETED",
    ]);
  }, 30_000);

  it("freezes line-ruled tables as truthful abstention pending line synthesis", async () => {
    const fixture = expectedCurrentFor(manifest, "table-ruled-lines.pdf");
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: {
        pdf_path: path.join(INTELLIGENCE_ROOT, fixture.path),
        max_markdown_bytes: 200000,
      },
    });
    expect(result.isError).not.toBe(true);
    expectCurrentConversion(result, fixture);
    expect(result.structuredContent.markdown).not.toMatch(/^\|.*\|$/m);
    expect(result.structuredContent.gaps.map(gap => gap.code)).toEqual([
      "TABLE_TOPOLOGY_UNKNOWN",
      "VECTOR_CONTENT_NOT_INTERPRETED",
    ]);
  }, 30_000);

  it("keeps the merged-span ruled fixture fail-closed and never reconstructs it", async () => {
    const fixture = expectedCurrentFor(manifest, "table-ruled-merged-negative.pdf");
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: {
        pdf_path: path.join(INTELLIGENCE_ROOT, fixture.path),
        max_markdown_bytes: 200000,
      },
    });
    expect(result.isError).not.toBe(true);
    expectCurrentConversion(result, fixture);
    expect(result.structuredContent.markdown).toBe(MERGED_MARKDOWN);
    expect(result.structuredContent.markdown).not.toMatch(/^\|.*\|$/m);
    expect(result.structuredContent.gaps.map(gap => gap.code)).toEqual([
      "TABLE_TOPOLOGY_UNKNOWN",
      "VECTOR_CONTENT_NOT_INTERPRETED",
    ]);
  }, 30_000);

  it("records the current silent-complete behavior for PUA and replacement-heavy text", async () => {
    const fixture = expectedCurrentFor(manifest, "text-integrity-pua.pdf");
    const pdfPath = path.join(INTELLIGENCE_ROOT, fixture.path);
    const layout = await client.callTool({
      name: "read_pdf_layout",
      arguments: { pdf_path: pdfPath, max_output_characters: 200000 },
    });
    const markdown = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: pdfPath, max_markdown_bytes: 200000 },
    });
    expect(layout.isError).not.toBe(true);
    expect(layout.structuredContent.extraction_status).toBe("complete");
    expect(layout.structuredContent.pages[0].flow_text).toBe(PUA_TEXT);
    expect(markdown.isError).not.toBe(true);
    expectCurrentConversion(markdown, fixture);
    expect(markdown.structuredContent.markdown).toBe(PUA_MARKDOWN);
    expect(fixture.expected_current.text_integrity_signal).toBe("absent");
    expect(Object.hasOwn(markdown.structuredContent, "text_integrity_signal")).toBe(false);
  }, 30_000);

  it("keeps routing truth in the sidecar and exposes Markdown routing metadata", async () => {
    const fixture = expectedCurrentFor(manifest, "routing-mixed.pdf");
    const routingTruth = JSON.parse(await fs.readFile(ROUTING_TRUTH_PATH, "utf8"));
    expect(fixture.expected_current.pages_needing_vision_field).toBe("present");
    expect(routingTruth).toEqual({
      fixture_id: fixture.id,
      truth_version: "v1",
      pages_needing_vision: [2],
      page_reasons: { "2": ["no_text_layer"] },
      baseline: {
        surface: "convert_pdf_to_markdown and read_pdf_layout structured results",
        field: "pages_needing_vision",
        status: "absent",
        note: "The exact routing truth is recorded before W1; the current baseline exposes no routing field.",
      },
    });
    const pdfPath = path.join(INTELLIGENCE_ROOT, fixture.path);
    const layout = await client.callTool({
      name: "read_pdf_layout",
      arguments: { pdf_path: pdfPath, start_page: 1, end_page: 2, max_output_characters: 200000 },
    });
    const markdown = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: pdfPath, start_page: 1, end_page: 2, max_markdown_bytes: 200000 },
    });
    expect(layout.isError).not.toBe(true);
    expect(layout.structuredContent.pages).toHaveLength(fixture.expected_current.page_count);
    expect({
      page: layout.structuredContent.pages[1].page,
      text_layer_status: layout.structuredContent.pages[1].text_layer_status,
      flow_text: layout.structuredContent.pages[1].flow_text,
    }).toEqual({ page: 2, text_layer_status: "empty", flow_text: "" });
    expect(layout.structuredContent.pages.filter(page => page.needs_visual_inspection).map(page => page.page)).toEqual(
      routingTruth.pages_needing_vision,
    );
    expect(Object.fromEntries(
      layout.structuredContent.pages
        .filter(page => page.needs_visual_inspection)
        .map(page => [String(page.page), [page.text_layer_status === "empty" ? "no_text_layer" : ""]]),
    )).toEqual(routingTruth.page_reasons);
    expect(Object.hasOwn(layout.structuredContent, "pages_needing_vision")).toBe(false);
    expect(markdown.isError).not.toBe(true);
    expectCurrentConversion(markdown, fixture);
    expect(markdown.structuredContent.markdown).toBe(ROUTING_MARKDOWN);
    expect(markdown.structuredContent.pages_needing_vision).toEqual(
      fixture.expected_current.pages_needing_vision,
    );
    expect(markdown.structuredContent.gaps.map(gap => gap.code)).toEqual([
      "TEXT_LAYER_EMPTY",
      "OCR_NOT_PERFORMED",
      "IMAGE_CONTENT_NOT_RENDERED",
    ]);
  }, 30_000);

  it("freezes compact-toc default conversion as verbatim output", async () => {
    const fixture = expectedCurrentFor(manifest, "compact-toc.pdf");
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: {
        pdf_path: path.join(INTELLIGENCE_ROOT, fixture.path),
        max_markdown_bytes: 200000,
      },
    });
    expect(result.isError).not.toBe(true);
    expectCurrentConversion(result, fixture);
    expect(result.structuredContent.markdown).toBe(COMPACT_TOC_MARKDOWN);
    expect(fixture.expected_current.default_output).toBe("verbatim");
    expect(fixture.expected_current.normalization_counts_field).toBe("absent");
    expect(Object.hasOwn(result.structuredContent, "normalization_counts")).toBe(false);
  }, 30_000);
});
