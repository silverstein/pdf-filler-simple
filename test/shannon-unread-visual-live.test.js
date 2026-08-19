import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Point PDF_TOOLS_SHANNON_SOURCE at a local copy of the paper to run this.
// The digest below is the identity check the other Shannon lanes use, not an
// expectation about content.
const SOURCE = process.env.PDF_TOOLS_SHANNON_SOURCE;
const SOURCE_SHA256 = "6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8";
const PAGE_COUNT = 55;
const PAGE_SPAN = 10;
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/**
 * Independent oracle. The routing projection is built from emitted Markdown
 * gap codes; this reads the extractor's own per-page paint evidence out of
 * read_pdf_layout. A projection that lost a page, shifted a page, or kept a
 * page the strong field already claims disagrees with this.
 */
function projectionFromSource(layoutPages, pagesNeedingVision) {
  const routed = new Set(pagesNeedingVision.map(entry => entry.page));
  return layoutPages
    .filter(page => page.modality_hint !== "unknown" && !routed.has(page.page))
    .map(page => ({
      page: page.page,
      gap_codes: [
        ...page.has_image_operations ? ["IMAGE_CONTENT_NOT_RENDERED"] : [],
        ...page.has_vector_paint_operations ? ["VECTOR_CONTENT_NOT_INTERPRETED"] : [],
      ],
    }))
    .filter(entry => entry.gap_codes.length > 0);
}

describe("external Shannon unread-visual-content routing", () => {
  let client = null;
  let transport = null;
  let chunks = null;

  beforeAll(async () => {
    if (!SOURCE) return;
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: { ALLOWED_DIRECTORIES: path.dirname(SOURCE) },
      stderr: "ignore",
    });
    client = new Client({ name: "shannon-unread-visual", version: "1.0.0" });
    await client.connect(transport);
    chunks = [];
    for (let startPage = 1; startPage <= PAGE_COUNT; startPage += PAGE_SPAN) {
      const endPage = Math.min(PAGE_COUNT, startPage + PAGE_SPAN - 1);
      const range = { pdf_path: SOURCE, start_page: startPage, end_page: endPage };
      const [layout, markdown] = await Promise.all([
        client.callTool({
          name: "read_pdf_layout",
          arguments: { ...range, max_items: 5000, max_characters: 100000, max_output_characters: 200000 },
        }),
        client.callTool({
          name: "convert_pdf_to_markdown",
          arguments: { ...range, max_items: 5000, max_characters: 100000, max_markdown_bytes: 200000 },
        }),
      ]);
      expect(layout.isError, `pages ${startPage}-${endPage}`).not.toBe(true);
      expect(markdown.isError, `pages ${startPage}-${endPage}`).not.toBe(true);
      chunks.push({ layout: layout.structuredContent, markdown: markdown.structuredContent });
    }
    expect(chunks[0].markdown.provenance.source.sha256).toBe(SOURCE_SHA256);
  }, 300_000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
  });

  it.runIf(Boolean(SOURCE))("lists every readable page the source paints and no other", () => {
    for (const chunk of chunks) {
      const expected = projectionFromSource(
        chunk.layout.pages,
        chunk.markdown.pages_needing_vision,
      );
      const emitted = chunk.markdown.pages_with_unread_visual_content;
      if (expected.length === 0) expect(emitted).toBeUndefined();
      else expect(emitted).toEqual(expected);
    }
    // The paper does carry painted pages, so the loop above is not vacuous.
    const listed = chunks.flatMap(chunk => chunk.markdown.pages_with_unread_visual_content ?? []);
    expect(listed.length).toBeGreaterThan(0);
  });

  it.runIf(Boolean(SOURCE))("routes the plotted table page that reads fine as text", () => {
    // Locate the page by what it is rather than by its number: the one page
    // whose converted text carries the paper's Table I heading. Its plots are
    // painted, so it reports unread visual content, and its text read
    // successfully, so it is correctly absent from pages_needing_vision.
    const tablePages = chunks.flatMap(chunk => chunk.markdown.pages
      .map(page => ({ page: page.page, chunk }))
      .filter(({ page }) => {
        const body = pageBody(chunk.markdown.markdown, page);
        return /^TABLE I$/mu.test(body);
      }));
    expect(tablePages).toHaveLength(1);
    const [{ page, chunk }] = tablePages;

    const body = pageBody(chunk.markdown.markdown, page);
    // "Reads fine as text" has to mean something measurable, or the claim that
    // this page does not need vision is untested.
    expect(body.replace(/<!-- PDF page \d+ -->/u, "").trim().length).toBeGreaterThan(100);
    expect(chunk.markdown.pages_needing_vision.map(entry => entry.page)).not.toContain(page);

    const entry = chunk.markdown.pages_with_unread_visual_content
      .find(candidate => candidate.page === page);
    const sourcePage = chunk.layout.pages.find(candidate => candidate.page === page);
    expect(sourcePage.has_vector_paint_operations).toBe(true);
    expect(entry).toEqual({ page, gap_codes: ["VECTOR_CONTENT_NOT_INTERPRETED"] });
    // Every code is a gap the same result already reported for that page.
    expect(chunk.markdown.gaps.filter(gap => gap.page === page).map(gap => gap.code))
      .toEqual(expect.arrayContaining(entry.gap_codes));
  });
});

function pageBody(markdown, page) {
  const start = markdown.indexOf(`<!-- PDF page ${page} -->`);
  if (start === -1) return "";
  const next = markdown.indexOf(`<!-- PDF page ${page + 1} -->`, start);
  return markdown.slice(start, next === -1 ? undefined : next);
}
