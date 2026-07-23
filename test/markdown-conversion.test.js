import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { extractPdfLayout } from "../server/layout-extraction.js";
import {
  renderPdfLayoutToMarkdown,
  validateMarkdownConversionSemantics,
} from "../server/markdown-conversion.js";

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

function textItem(text, { top, fontSize = 12 } = {}) {
  return {
    str: text,
    dir: "ltr",
    width: Math.max(20, text.length * fontSize * 0.5),
    height: fontSize,
    transform: [fontSize, 0, 0, fontSize, 50, 792 - top - fontSize],
    fontName: "f1",
    hasEOL: true,
  };
}

function fakePdfjs(pageConfigs) {
  const pages = pageConfigs.map(config => ({
    view: [0, 0, 612, 792],
    userUnit: 1,
    rotate: 0,
    getViewport: () => ({ scale: 1, width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
    getTextContent: async () => {
      if (config.textError) throw config.textError;
      return {
        items: config.items ?? [],
        styles: { f1: { fontFamily: "Test Sans", ascent: 0.8, descent: -0.2, vertical: false } },
      };
    },
    getOperatorList: async () => ({ fnArray: config.operations ?? [] }),
    cleanup: () => {},
  }));
  return {
    version: "5.4.624",
    OPS: { paintImageXObject: 1, constructPath: 2, fill: 3 },
    Util: { transform: multiply },
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: pages.length,
        getPage: async pageNumber => pages[pageNumber - 1],
        destroy: async () => {},
      }),
      destroy: async () => {},
    }),
  };
}

async function validatedSyntheticLayout(pageConfigs) {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageConfigs.length; index += 1) document.addPage([612, 792]);
  const bytes = await document.save({ useObjectStreams: false });
  return extractPdfLayout({
    pdfjsLib: fakePdfjs(pageConfigs),
    pdfBytes: bytes,
    sourcePath: "/validated/source.pdf",
    sourceFileName: "source.pdf",
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    sourceSizeBytes: bytes.length,
    requestedStartPage: 1,
    requestedEndPage: pageConfigs.length,
    maxOutputCharacters: 200000,
  });
}

describe("layout Markdown renderer", () => {
  it("renders deterministic source-backed headings, lists, links, escaping, and page boundaries", async () => {
    const layout = await validatedSyntheticLayout([
      {
        items: [
          textItem("Quarterly *Results*", { top: 50, fontSize: 24 }),
          textItem("Revenue & margin <plan>", { top: 100 }),
          textItem("• First [item]", { top: 130 }),
          textItem("2) Visit https://example.com/report.", { top: 160 }),
          textItem("Name | Total", { top: 190 }),
        ],
      },
      { items: [textItem("Second page", { top: 50 })] },
    ]);

    const first = renderPdfLayoutToMarkdown(layout);
    const second = renderPdfLayoutToMarkdown(layout);

    expect(second).toEqual(first);
    expect(first.conversion_status).toBe("complete");
    expect(first.markdown).toContain("<!-- PDF page 1 -->");
    expect(first.markdown).toContain("# Quarterly \\*Results\\*");
    expect(first.markdown).toContain("Revenue &amp; margin &lt;plan&gt;");
    expect(first.markdown).toContain("- First \\[item\\]");
    expect(first.markdown).toContain("2) Visit https&#58;//example&#46;com/report.");
    expect(first.markdown).not.toContain("<https://example.com/report>");
    expect(first.markdown).not.toMatch(/\[[^\]]*example\.com[^\]]*\]\([^)]*\)/u);
    expect(first.markdown).toContain("Name \\| Total");
    expect(first.markdown).toContain("\n\n---\n\n<!-- PDF page 2 -->");
    expect(first.markdown).not.toContain("Name | Total");
    expect(first.markdown_bytes).toBe(Buffer.byteLength(first.markdown, "utf8"));
    expect(first.markdown_sha256).toBe(createHash("sha256").update(first.markdown).digest("hex"));
    expect(validateMarkdownConversionSemantics(first, { layout })).toBe(first);
  });

  it("does not invent a heading without enough geometric evidence", async () => {
    const layout = await validatedSyntheticLayout([{
      items: [
        textItem("Large but unsupported", { top: 50, fontSize: 24 }),
        textItem("Second size", { top: 100, fontSize: 20 }),
        textItem("Third size", { top: 140, fontSize: 16 }),
        textItem("Fourth size", { top: 180, fontSize: 12 }),
      ],
    }]);
    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });
    expect(result.markdown).toContain("Large but unsupported\n");
    expect(result.markdown).not.toContain("# Large but unsupported");
    expect(result.options.include_page_boundaries).toBe(false);
  });

  it("neutralizes hostile Markdown, HTML, table, autolink, and control syntax", async () => {
    const layout = await validatedSyntheticLayout([{
      items: [
        textItem("# source heading marker", { top: 50 }),
        textItem("> source quote", { top: 80 }),
        textItem("---", { top: 110 }),
        textItem("===", { top: 140 }),
        textItem("~~~", { top: 170 }),
        textItem("~~~~javascript", { top: 200 }),
        textItem("`code` \\ path | [label] <b>tag</b>", { top: 230 }),
        textItem("https://example.com www.example.com user@example.com null\u0000byte lone\ud800surrogate", { top: 260 }),
      ],
    }]);
    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });
    expect(result.markdown).toContain("\\# source heading marker");
    expect(result.markdown).toContain("&gt; source quote");
    expect(result.markdown).toContain("\\---");
    expect(result.markdown).toContain("\\===");
    expect(result.markdown).toContain("\\~~~");
    expect(result.markdown).toContain("\\~~~~javascript");
    expect(result.markdown).toContain("\\`code\\` \\\\ path \\| \\[label\\] &lt;b&gt;tag&lt;/b&gt;");
    expect(result.markdown).toContain("https&#58;//example&#46;com www&#46;example.com user&#64;example&#46;com null\ufffdbyte lone\ufffdsurrogate");
    expect(result.gaps.map(gap => gap.code)).toContain("CONTROL_CHARACTERS_SANITIZED");
    expect(result.conversion_status).toBe("partial");
    expect(Buffer.from(result.markdown, "utf8").toString("utf8")).toBe(result.markdown);
  });

  it("reports mixed and image-only pages as partial with explicit no-OCR gaps", async () => {
    const layout = await validatedSyntheticLayout([
      { items: [textItem("Visible text", { top: 50 })], operations: [1] },
      { items: [], operations: [1] },
      { items: [textItem("Text with vector art", { top: 50 })], operations: [2] },
    ]);
    const result = renderPdfLayoutToMarkdown(layout);
    expect(result.conversion_status).toBe("partial");
    expect(result.pages.map(page => page.conversion_status)).toEqual(["partial", "partial", "partial"]);
    expect(result.gaps.map(gap => gap.code)).toEqual(expect.arrayContaining([
      "OCR_NOT_PERFORMED",
      "IMAGE_CONTENT_NOT_RENDERED",
      "TEXT_LAYER_EMPTY",
    ]));
    expect(result.pages[2].gaps.map(gap => gap.code)).toEqual(["VECTOR_CONTENT_NOT_INTERPRETED"]);
    expect(result.markdown).toContain("## Conversion gaps");
    expect(result.markdown).toContain("OCR is not performed");
    expect(result.limitations.some(value => value.includes("Table topology is not represented"))).toBe(true);
    expect(result.limitations.some(value => value.includes("links are not emitted"))).toBe(true);
  });

  it("fails closed against the exact UTF-8 Markdown byte limit", async () => {
    const layout = await validatedSyntheticLayout([{
      items: [textItem("Unicode 🙂 café", { top: 50 })],
    }]);
    const baseline = renderPdfLayoutToMarkdown(layout);
    expect(baseline.markdown_bytes).toBeGreaterThan(baseline.markdown.length);
    expect(() => renderPdfLayoutToMarkdown(layout, {
      maxMarkdownBytes: baseline.markdown_bytes - 1,
    })).toThrow(`Markdown output is ${baseline.markdown_bytes} UTF-8 bytes`);
  });

  it("returns failed only when every requested page has no renderable text after text-layer failure", async () => {
    const textError = new Error("Synthetic text failure");
    textError.name = "FormatError";
    const layout = await validatedSyntheticLayout([{ textError }]);
    const result = renderPdfLayoutToMarkdown(layout);
    expect(result.conversion_status).toBe("failed");
    expect(result.pages[0].conversion_status).toBe("failed");
    expect(result.gaps.map(gap => gap.code)).toContain("TEXT_LAYER_FAILED");
    expect(result.markdown).toContain("[No source-backed text was available on this page.]");
  });

  it("rejects semantically consistent but unsupported IR and parser identities", async () => {
    const layout = await validatedSyntheticLayout([{
      items: [textItem("Body text", { top: 50 })],
    }]);
    const unsupportedIr = structuredClone(layout);
    unsupportedIr.ir.version = "2.0.0";
    unsupportedIr.id_scope.ir_version = "2.0.0";
    expect(() => renderPdfLayoutToMarkdown(unsupportedIr)).toThrow("unsupported layout IR");

    const unsupportedParser = structuredClone(layout);
    unsupportedParser.parser.version = "5.5.0";
    unsupportedParser.id_scope.parser_version = "5.5.0";
    expect(() => renderPdfLayoutToMarkdown(unsupportedParser)).toThrow("expected pdfjs-dist 5.4.624");
  });

  it("rejects tampered hashes, statuses, gaps, provenance, and line counts", async () => {
    const layout = await validatedSyntheticLayout([{
      items: [textItem("Body text", { top: 50 })],
    }]);
    const result = renderPdfLayoutToMarkdown(layout);
    const cases = [
      ["markdown SHA-256", { ...result, markdown_sha256: "0".repeat(64) }],
      ["document conversion status", { ...result, conversion_status: "partial" }],
      ["document gaps", { ...result, gaps: [{ code: "UNKNOWN", page: 1, message: "no" }] }],
      ["unknown gap code", { ...result, pages: [{ ...result.pages[0], gaps: [{ code: "UNKNOWN", page: 1, message: "no" }] }], gaps: [{ code: "UNKNOWN", page: 1, message: "no" }], conversion_status: "partial" }],
      ["source or layout provenance", { ...result, provenance: { ...result.provenance, source: { ...result.provenance.source, sha256: "0".repeat(64) } } }],
      ["line count", { ...result, pages: [{ ...result.pages[0], line_count: 99 }] }],
    ];
    for (const [message, tampered] of cases) {
      expect(() => validateMarkdownConversionSemantics(tampered, { layout })).toThrow(message);
    }
  });
});
