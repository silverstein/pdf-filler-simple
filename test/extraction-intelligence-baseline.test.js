import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateExtractionIntelligenceFixtures } from "../scripts/eval-generate-extraction-intelligence-fixtures.mjs";

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
  "text-integrity-pua.pdf",
  "routing-mixed.pdf",
  "compact-toc.pdf",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function markdownWithoutTail(markdown, marker) {
  const index = markdown.indexOf(marker);
  return index < 0 ? markdown : markdown.slice(0, index);
}

function expectedMarkdown(pageText, { page = 1, gaps = [] } = {}) {
  const pageBoundary = `<!-- PDF page ${page} -->\n\n`;
  const body = `${pageBoundary}${pageText}`;
  if (gaps.length === 0) return body;
  return `${body}\n\n## Conversion gaps\n\n${gaps.map(gap => `- ${gap}`).join("\n")}`;
}

describe("extraction-intelligence current baseline", () => {
  let client;
  let transport;

  beforeAll(async () => {
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

  it("validates the separate five-fixture mini-manifest and all provenance fields", async () => {
    const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
    expect(manifest).toMatchObject({
      manifest_version: 1,
      suite_id: "pdf-tools.extraction.intelligence.baseline",
      generator: "scripts/eval-generate-extraction-intelligence-fixtures.mjs",
    });
    expect(manifest.fixtures).toHaveLength(5);
    expect(manifest.fixtures.map(fixture => fixture.path)).toEqual(FIXTURE_FILES);
    for (const fixture of manifest.fixtures) {
      expect(fixture.media_type).toBe("application/pdf");
      expect(fixture.provenance.kind).toBe("synthetic");
      expect(fixture.provenance.source_url).toBeNull();
      expect(fixture.license).toMatchObject({ spdx_id: "MIT", redistribution: "allowed" });
      expect(fixture.privacy).toMatchObject({ class: "synthetic", contains_personal_data: false });
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

  it("freezes current ruled-grid abstention as plain text with TABLE_TOPOLOGY_UNKNOWN", async () => {
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: {
        pdf_path: path.join(INTELLIGENCE_ROOT, "table-ruled-grid.pdf"),
        max_markdown_bytes: 200000,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.conversion_status).toBe("partial");
    expect(markdownWithoutTail(result.structuredContent.markdown, "\n\n## Conversion gaps")).toBe(
      expectedMarkdown("Region Q1 Q2\nNorth 1200 1450\nSouth 980 1020\nWest 1500 1380"),
    );
    expect(result.structuredContent.markdown).not.toMatch(/^\|.*\|$/m);
    expect(result.structuredContent.gaps.map(gap => gap.code)).toEqual([
      "TABLE_TOPOLOGY_UNKNOWN",
      "VECTOR_CONTENT_NOT_INTERPRETED",
    ]);
  }, 30_000);

  it("keeps the merged-span ruled fixture fail-closed and never reconstructs it", async () => {
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: {
        pdf_path: path.join(INTELLIGENCE_ROOT, "table-ruled-merged-negative.pdf"),
        max_markdown_bytes: 200000,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.conversion_status).toBe("partial");
    expect(markdownWithoutTail(result.structuredContent.markdown, "\n\n## Conversion gaps")).toBe(
      expectedMarkdown("Status Merged Q1-Q2\nNorth 1200 1450\nSouth 980 1020\nWest 1500 1380"),
    );
    expect(result.structuredContent.markdown).not.toMatch(/^\|.*\|$/m);
    expect(result.structuredContent.gaps.map(gap => gap.code)).toEqual([
      "TABLE_TOPOLOGY_UNKNOWN",
      "VECTOR_CONTENT_NOT_INTERPRETED",
    ]);
  }, 30_000);

  it("records the current silent-complete behavior for PUA and replacement-heavy text", async () => {
    const pdfPath = path.join(INTELLIGENCE_ROOT, "text-integrity-pua.pdf");
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
    expect(markdown.structuredContent.conversion_status).toBe("complete");
    expect(markdown.structuredContent.gaps).toEqual([]);
    expect(markdownWithoutTail(markdown.structuredContent.markdown, "\n\n## Conversion limitations")).toBe(
      `<!-- PDF page 1 -->\n\n${PUA_TEXT}`,
    );
  }, 30_000);

  it("keeps routing truth in the sidecar while asserting the current field is absent", async () => {
    const routingTruth = JSON.parse(await fs.readFile(ROUTING_TRUTH_PATH, "utf8"));
    expect(routingTruth.pages_needing_vision).toEqual([2]);
    const pdfPath = path.join(INTELLIGENCE_ROOT, "routing-mixed.pdf");
    const layout = await client.callTool({
      name: "read_pdf_layout",
      arguments: { pdf_path: pdfPath, start_page: 1, end_page: 2, max_output_characters: 200000 },
    });
    const markdown = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: pdfPath, start_page: 1, end_page: 2, max_markdown_bytes: 200000 },
    });
    expect(layout.isError).not.toBe(true);
    expect(layout.structuredContent.pages).toHaveLength(2);
    expect(layout.structuredContent.pages[1]).toMatchObject({ page: 2, text_layer_status: "empty", flow_text: "" });
    expect(Object.hasOwn(layout.structuredContent, "pages_needing_vision")).toBe(false);
    expect(markdown.isError).not.toBe(true);
    expect(markdown.structuredContent.conversion_status).toBe("partial");
    expect(Object.hasOwn(markdown.structuredContent, "pages_needing_vision")).toBe(false);
    expect(markdown.structuredContent.gaps.map(gap => gap.code)).toEqual([
      "TEXT_LAYER_EMPTY",
      "OCR_NOT_PERFORMED",
      "IMAGE_CONTENT_NOT_RENDERED",
    ]);
  }, 30_000);

  it("freezes compact-toc default conversion as verbatim output", async () => {
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: {
        pdf_path: path.join(INTELLIGENCE_ROOT, "compact-toc.pdf"),
        max_markdown_bytes: 200000,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.conversion_status).toBe("complete");
    expect(markdownWithoutTail(result.structuredContent.markdown, "\n\n## Conversion limitations")).toBe(
      "<!-- PDF page 1 -->\n\n# CONTENTS\nChapter 1: Scope .................... 1\nChapter 2: Inputs ................... 7\nChapter 3: Methods ................ 12\nChapter 4: Evidence ............... 19\nChapter 5: Review .................. 24\nChapter 6: Findings ................ 31\nChapter 7: Limits .................. 38\nChapter 8: Appendix ................ 44\nChapter 9: Closing ................. 51\nChapter 10: Index .................. 58\n63\n71",
    );
    expect(result.structuredContent.markdown).toContain("Chapter 1: Scope .................... 1");
    expect(result.structuredContent.markdown).toContain("\n63\n71\n");
    expect(Object.hasOwn(result.structuredContent, "normalization_counts")).toBe(false);
  }, 30_000);
});
