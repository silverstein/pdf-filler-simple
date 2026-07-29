import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hashBoundedPdfFileSafely,
} from "../server/bounded-pdf-file.js";
import {
  createPdfjsSubprocessRequest,
  runPdfjsSubprocess,
} from "../server/pdfjs-subprocess.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");

async function sourceBinding(pdfPath = EXAMPLE_PDF) {
  const source = await hashBoundedPdfFileSafely(pdfPath, 250 * 1024 * 1024, {
    assertPathAllowed: candidate => candidate,
  });
  return {
    canonical_path: source.canonicalPath,
    file_identity: source.fileIdentity,
    sha256: source.sha256,
    size_bytes: source.sizeBytes,
  };
}

async function run(operation, options, password = null, source = null) {
  return await runPdfjsSubprocess(createPdfjsSubprocessRequest({
    operation,
    source: source || await sourceBinding(),
    options,
    password,
    allowedDirectories: [REPO_ROOT],
  }), { timeoutMs: 30_000 });
}

describe.sequential("one-shot PDF.js worker contracts", () => {
  it("projects text extraction without returning an unbounded page-text graph", async () => {
    const content = await run("read_content", { max_pages: 1 });
    expect(content).toMatchObject({
      total_pages: expect.any(Number),
      pages_read: 1,
      source_length: expect.any(Number),
      output_text: expect.any(String),
      page_previews: expect.any(Array),
    });
    expect(content.output_text.length).toBeLessThanOrEqual(50_000);
    expect(content.page_previews[0].text.length).toBeLessThanOrEqual(2000);

    const pages = await run("read_pages", {
      start_page: 1,
      end_page: 1,
      max_chars_per_page: 1000,
    });
    expect(pages.pages).toHaveLength(1);
    expect(pages.pages[0].text.length).toBeLessThanOrEqual(1000);

    const search = await run("search_text", {
      query: "a",
      max_results: 3,
      context_chars: 40,
    });
    expect(search.matches.length).toBeLessThanOrEqual(3);
    expect(search).toMatchObject({
      query: "a",
      match_count: search.matches.length,
      total_pages: expect.any(Number),
    });
  });

  it("keeps complete layout replay inside one worker operation", async () => {
    const common = {
      source_path: EXAMPLE_PDF,
      source_file_name: path.basename(EXAMPLE_PDF),
      start_page: 1,
      end_page: 1,
      max_items: 200,
      max_characters: 20_000,
      max_output_characters: 50_000,
    };
    const layout = await run("extract_layout", common);
    expect(layout.layout).toMatchObject({
      ir: { name: "pdf-tools.extraction-ir", version: "1.0.0" },
      parser: { name: "pdfjs-dist", version: "5.4.624" },
      pages: expect.any(Array),
    });
    const markdownLayout = await run("extract_layout_for_markdown", common);
    expect(markdownLayout.layout.parser.version).toBe("5.4.624");
    expect(markdownLayout.layout.page_range.start_page).toBe(1);
  });

  it("returns PNG bytes only on the separately bounded binary channel", async () => {
    const page = await run("render_page", {
      page: 1,
      max_dimension_px: 256,
      scale_override: null,
    });
    expect(Buffer.isBuffer(page.binary)).toBe(true);
    expect(page.binary.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(page).toMatchObject({
      renderer: "native-canvas",
      width: expect.any(Number),
      height: expect.any(Number),
      width_points: expect.any(Number),
      height_points: expect.any(Number),
      scale: expect.any(Number),
    });

    const region = await run("render_region", {
      page: 1,
      x: 0,
      y: 0,
      width: 72,
      height: 72,
      max_dimension_px: 144,
    });
    expect(Buffer.isBuffer(region.binary)).toBe(true);
    expect(region.width).toBeLessThanOrEqual(144);
    expect(region.height).toBeLessThanOrEqual(144);
  });

  it("runs page operators and signature text heuristics inside the worker", async () => {
    const analysis = await run("analyze_pages", { max_pages: 200 });
    expect(analysis.analysis).toMatchObject({
      total_pages: expect.any(Number),
      pages: expect.any(Array),
      content_analysis_status: expect.stringMatching(/complete|partial|degraded/),
    });
    const zones = await run("detect_signature_zones", {});
    expect(zones).toMatchObject({
      zones: expect.any(Array),
      warning_counts: expect.any(Array),
      page_geometry: expect.any(Array),
    });
  });

  it("rejects a mismatched byte binding before semantic evaluation", async () => {
    const source = await sourceBinding();
    source.sha256 = "0".repeat(64);
    await expect(run("read_content", { max_pages: 1 }, null, source)).rejects.toMatchObject({
      code: "PDF_CHANGED_DURING_READ",
    });
  });

  it("keeps both committed runtimes free of direct PDF.js semantic evaluation", async () => {
    const forbidden = [
      /pdfjs-dist/,
      /\.getDocument\s*\(/,
      /\.getTextContent\s*\(/,
      /\.getOperatorList\s*\(/,
      /\.render\s*\(/,
    ];
    for (const relativePath of [
      "server/index.js",
      "pdf-toolkit-mcp-share/server/index.js",
    ]) {
      const source = await fs.readFile(path.join(REPO_ROOT, relativePath), "utf8");
      for (const pattern of forbidden) expect(source, `${relativePath}: ${pattern}`).not.toMatch(pattern);
    }
  });
});
