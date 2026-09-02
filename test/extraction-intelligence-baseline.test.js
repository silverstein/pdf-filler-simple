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

const TABLE_GRID_MARKDOWN_CORE = `<!-- PDF page 1 -->

| Region | Q1 | Q2 |
| --- | --- | --- |
| North | 1200 | 1450 |
| South | 980 | 1020 |
| West | 1500 | 1380 |

## Conversion gaps

- Page 1: Vector-painted content beyond reconstructed ruled or bounded solid-mask table grids was not interpreted as text or table structure.`;

const MERGED_MARKDOWN_CORE = `<!-- PDF page 1 -->

Status Merged Q1-Q2
North 1200 1450
South 980 1020
West 1500 1380

## Conversion gaps

- Page 1: Table-like content was detected but its column topology could not be reconstructed, so it remains reading-order text.
- Page 1: Vector-painted content beyond reconstructed ruled or bounded solid-mask table grids was not interpreted as text or table structure.`;

const PUA_MARKDOWN_CORE = `<!-- PDF page 1 -->

${PUA_TEXT}

## Conversion gaps

- Page 1: Text-layer integrity signals were detected (replacement\\_characters=14, private\\_use\\_runs=4); extracted text is retained but may require visual inspection.`;

const ROUTING_MARKDOWN_CORE = `<!-- PDF page 1 -->

MIXED ROUTING FIXTURE
Packet ID: ROUTE-77
Page one is born digital.

---

<!-- PDF page 2 -->

[No source-backed text was available on this page.]

## Conversion gaps

- Page 2: No source-backed text-layer content was available on this page.
- Page 2: The page appears image-only, and OCR was not performed.
- Page 2: Image content was not rendered into Markdown.`;

const COMPACT_TOC_MARKDOWN_CORE = `<!-- PDF page 1 -->

# CONTENTS
Preface ... ii
Chapter 1: Scope ... 1
Chapter 2: Inputs ... 7
Chapter 3: Methods ... 12
Chapter 4: Evidence ... 19
Chapter 5: Review ... 24
Chapter 6: Findings ... 31
Chapter 7: Limits ... 38
Chapter 8: Appendix ... 44
Chapter 9: Closing ... 51
Chapter 10: Index ... 58`;

function markdownCore(markdown) {
  return markdown.split("\n\n## Conversion limitations\n\n", 1)[0];
}

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
    expect(markdownCore(result.structuredContent.markdown)).toBe(TABLE_GRID_MARKDOWN_CORE);
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
    expect(markdownCore(result.structuredContent.markdown)).toBe(MERGED_MARKDOWN_CORE);
    expect(result.structuredContent.markdown).not.toMatch(/^\|.*\|$/m);
    expect(result.structuredContent.gaps.map(gap => gap.code)).toEqual([
      "TABLE_TOPOLOGY_UNKNOWN",
      "VECTOR_CONTENT_NOT_INTERPRETED",
    ]);
  }, 30_000);

  it("surfaces typed integrity evidence while retaining PUA and replacement-heavy text", async () => {
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
    expect(layout.structuredContent.pages[0].text_integrity).toEqual({
      status: "suspect",
      signals: [
        { kind: "replacement_characters", count: 14 },
        { kind: "private_use_runs", count: 4 },
      ],
    });
    expect(markdown.isError).not.toBe(true);
    expectCurrentConversion(markdown, fixture);
    expect(markdownCore(markdown.structuredContent.markdown)).toBe(PUA_MARKDOWN_CORE);
    expect(fixture.expected_current.text_integrity_signal).toBe("present");
    expect(markdown.structuredContent.pages[0]).toMatchObject({
      conversion_status: "partial",
      gaps: [{
        code: "TEXT_INTEGRITY_SUSPECT",
        message: expect.stringContaining("replacement_characters=14, private_use_runs=4"),
      }],
    });
    expect(markdown.structuredContent.pages_needing_vision).toEqual(
      fixture.expected_current.pages_needing_vision,
    );
    const content = await client.callTool({
      name: "read_pdf_content",
      arguments: { pdf_path: pdfPath },
    });
    expect(content.isError).not.toBe(true);
    expect(content.structuredContent.pages_with_suspected_text_integrity).toEqual([{
      page: 1,
      signals: [
        { kind: "replacement_characters", count: 14 },
        { kind: "private_use_runs", count: 4 },
      ],
    }]);
    const analysis = await client.callTool({
      name: "get_page_analysis",
      arguments: { pdf_path: pdfPath },
    });
    expect(analysis.isError).not.toBe(true);
    expect(analysis.structuredContent.classification.pages_needing_vision).toEqual([{
      page: 1,
      reasons: ["suspected_text_integrity"],
    }]);
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
    expect(markdownCore(markdown.structuredContent.markdown)).toBe(ROUTING_MARKDOWN_CORE);
    expect(markdown.structuredContent.pages_needing_vision).toEqual(
      fixture.expected_current.pages_needing_vision,
    );
    expect(markdown.structuredContent.gaps.map(gap => gap.code)).toEqual([
      "TEXT_LAYER_EMPTY",
      "OCR_NOT_PERFORMED",
      "IMAGE_CONTENT_NOT_RENDERED",
    ]);
  }, 30_000);

  it("flips compact-toc to the normalized compact output while retaining the default baseline contract", async () => {
    const fixture = expectedCurrentFor(manifest, "compact-toc.pdf");
    const defaultResult = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: {
        pdf_path: path.join(INTELLIGENCE_ROOT, fixture.path),
        max_markdown_bytes: 200000,
      },
    });
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: {
        pdf_path: path.join(INTELLIGENCE_ROOT, fixture.path),
        max_markdown_bytes: 200000,
        compact: true,
      },
    });
    expect(defaultResult.isError).not.toBe(true);
    expect(defaultResult.structuredContent.markdown).toContain("Chapter 1: Scope .................... 1");
    expect(defaultResult.structuredContent.normalizations).toEqual({
      dot_leaders_collapsed: 0,
      page_number_lines_removed: 0,
      running_header_lines_removed: 0,
      running_footer_lines_removed: 0,
      page_furniture_characters_removed: 0,
      page_furniture_pages: [],
      spaced_hyphens_joined: 0,
      normalized_pages: [],
    });
    expect(result.isError).not.toBe(true);
    expectCurrentConversion(result, fixture);
    expect(markdownCore(result.structuredContent.markdown)).toBe(COMPACT_TOC_MARKDOWN_CORE);
    expect(fixture.expected_current.default_output).toBe("verbatim");
    expect(fixture.expected_current.normalizations_field).toBe("present");
    expect(result.structuredContent.normalizations).toEqual({
      dot_leaders_collapsed: 10,
      page_number_lines_removed: 2,
      running_header_lines_removed: 0,
      running_footer_lines_removed: 0,
      page_furniture_characters_removed: 0,
      page_furniture_pages: [],
      spaced_hyphens_joined: 0,
      normalized_pages: [1],
    });
  }, 30_000);
});
