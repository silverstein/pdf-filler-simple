import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  extractPdfLayout,
  validatePdfLayoutSemantics,
  validatePdfLayoutSourceEvidence,
} from "../server/layout-extraction.js";
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

function textItem(text, { top, fontSize = 12, left = 50, eol = true } = {}) {
  return {
    str: text,
    dir: "ltr",
    width: Math.max(20, text.length * fontSize * 0.5),
    height: fontSize,
    transform: [fontSize, 0, 0, fontSize, left, 792 - top - fontSize],
    fontName: "f1",
    hasEOL: eol,
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
    getAnnotations: async () => {
      if (config.annotationError) throw config.annotationError;
      return config.annotations ?? [];
    },
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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    expect(result.limitations.some(value => value.includes("Ruling lines and merged or spanning cells are not interpreted"))).toBe(true);
    expect(result.limitations.some(value => value.includes("Links are emitted only for source-validated http or https annotation targets"))).toBe(true);
  });

  it("escapes block syntax at every physical line start, not just the first", async () => {
    for (const [label, newline] of [["LF", "\n"], ["CR", "\r"]]) {
      const layout = await validatedSyntheticLayout([{
        items: [
          textItem(`safe${newline}# injected heading`, { top: 50 }),
          textItem(`safe${newline}> injected quote`, { top: 80 }),
          textItem(`safe${newline}- injected item`, { top: 110 }),
          textItem(`safe${newline}~~~ injected fence`, { top: 140 }),
          textItem(`safe${newline}1. injected ordered`, { top: 170 }),
        ],
        operations: [],
      }]);
      const { markdown } = renderPdfLayoutToMarkdown(layout);
      const body = markdown.split(/\n## /u)[0];
      for (const physicalLine of body.split(/\r\n|\r|\n/u)) {
        expect(physicalLine, `${label} ${physicalLine}`).not.toMatch(/^[^\S\r\n]*#\s/u);
        expect(physicalLine, `${label} ${physicalLine}`).not.toMatch(/^[^\S\r\n]*>\s/u);
        expect(physicalLine, `${label} ${physicalLine}`).not.toMatch(/^[^\S\r\n]*-\s/u);
        expect(physicalLine, `${label} ${physicalLine}`).not.toMatch(/^[^\S\r\n]*~{3,}/u);
        expect(physicalLine, `${label} ${physicalLine}`).not.toMatch(/^[^\S\r\n]*\d{1,9}[.)]\s/u);
      }
      expect(body).toContain("injected heading");
    }
  });

  // Viewport transform is [1,0,0,-1,0,792], so a PDF-space rect [x1,y1,x2,y2]
  // maps to viewport y = 792 - y. Line one items occupy viewport y 52.4..64.4,
  // i.e. PDF y 727.6..739.6, at x 50..74 ("Open"), 90..114 ("docs"),
  // 140..160 ("now").
  const LINE_ONE = { top: 50 };
  const linkPage = (annotations, items) => ({
    items: items ?? [
      textItem("Open", { ...LINE_ONE, left: 50, eol: false }),
      textItem("docs", { ...LINE_ONE, left: 90, eol: false }),
      textItem("now", { ...LINE_ONE, left: 140 }),
      textItem("Second line here", { top: 90, left: 50 }),
    ],
    annotations,
  });
  const linkAnnotation = (rect, extra = {}) => ({ subtype: "Link", rect, ...extra });
  const renderLinks = async (annotations, items) => renderPdfLayoutToMarkdown(
    await validatedSyntheticLayout([linkPage(annotations, items)]),
    { includePageBoundaries: false },
  );
  const codesOf = result => result.gaps.map(gap => gap.code);

  it("emits a link only for a supported target mapped to one contiguous run", async () => {
    const result = await renderLinks([
      linkAnnotation([49, 727, 115, 740], { url: "https://example.com/docs" }),
    ]);
    expect(result.markdown).toContain("[Open docs](https://example.com/docs)");
    expect(codesOf(result)).not.toContain("LINK_MAPPING_AMBIGUOUS");
    expect(codesOf(result)).not.toContain("UNSUPPORTED_LINK_TARGET");
    expect(codesOf(result)).not.toContain("LINK_ANNOTATIONS_UNAVAILABLE");
  });

  it("refuses a rect spanning two lines instead of emitting twice", async () => {
    const result = await renderLinks([
      linkAnnotation([49, 687, 115, 740], { url: "https://example.com/span" }),
    ]);
    expect(result.markdown).not.toContain("](https://example.com/span)");
    expect(result.markdown.match(/\]\(/gu)).toBeNull();
    expect(codesOf(result)).toContain("LINK_MAPPING_AMBIGUOUS");
  });

  it("refuses a rect that only partially covers a text item", async () => {
    // Covers "Open" fully but clips "docs" well below full containment.
    const result = await renderLinks([
      linkAnnotation([49, 727, 100, 740], { url: "https://example.com/partial" }),
    ]);
    expect(result.markdown).not.toContain("](https://example.com/partial)");
    expect(codesOf(result)).toContain("LINK_MAPPING_AMBIGUOUS");
  });

  it("refuses two supported links claiming the same text", async () => {
    const result = await renderLinks([
      linkAnnotation([49, 727, 75, 740], { url: "https://example.com/one" }),
      linkAnnotation([49, 727, 75, 740], { url: "https://example.com/two" }),
    ]);
    expect(result.markdown).not.toContain("](https://example.com/one)");
    expect(result.markdown).not.toContain("](https://example.com/two)");
    expect(codesOf(result)).toContain("LINK_MAPPING_AMBIGUOUS");
  });

  it("lets an unsupported annotation suppress an overlapping supported one", async () => {
    const result = await renderLinks([
      linkAnnotation([49, 727, 75, 740], { url: "https://example.com/safe" }),
      linkAnnotation([49, 727, 75, 740], { dest: ["XYZ"] }),
    ]);
    expect(result.markdown).not.toContain("](https://example.com/safe)");
    expect(codesOf(result)).toContain("UNSUPPORTED_LINK_TARGET");
    expect(codesOf(result)).toContain("LINK_MAPPING_AMBIGUOUS");
  });

  it("reports a supported link that maps to no text at all", async () => {
    const result = await renderLinks([
      linkAnnotation([500, 100, 560, 130], { url: "https://example.com/orphan" }),
    ]);
    expect(result.markdown).not.toContain("](https://example.com/orphan)");
    expect(codesOf(result)).toContain("LINK_MAPPING_AMBIGUOUS");
  });

  it("refuses internal destinations, actions, foreign schemes, and mixed targets", async () => {
    for (const extra of [
      { dest: ["XYZ"] },
      { action: "NextPage" },
      { url: "javascript:alert(1)" },
      { url: "file:///etc/passwd" },
      { unsafeUrl: "javascript:alert(1)" },
      { url: "https://example.com/ok", dest: ["XYZ"] },
    ]) {
      const result = await renderLinks([linkAnnotation([49, 727, 115, 740], extra)]);
      expect(result.markdown, JSON.stringify(extra)).not.toMatch(/\]\(/u);
      expect(codesOf(result), JSON.stringify(extra)).toContain("UNSUPPORTED_LINK_TARGET");
    }
  });

  it("preserves punctuation and scripts without word separators outside the link", async () => {
    const result = await renderLinks(
      [linkAnnotation([89, 727, 115, 740], { url: "https://example.com/jp" })],
      [
        textItem("契約書、", { ...LINE_ONE, left: 50, eol: false }),
        textItem("詳細", { ...LINE_ONE, left: 90 }),
      ],
    );
    expect(result.markdown).toContain("契約書、 [詳細](https://example.com/jp)");
  });

  it("percent-encodes destination characters that would break link grammar", async () => {
    const result = await renderLinks([
      linkAnnotation([49, 727, 75, 740], { url: "https://example.com/a(b)c" }),
    ]);
    expect(result.markdown).toContain("[Open](https://example.com/a%28b%29c)");
    expect(result.markdown).not.toContain("(https://example.com/a(b)c)");
  });

  it("reports unavailable link evidence when annotations cannot be read", async () => {
    const layout = await validatedSyntheticLayout([{
      items: [textItem("Text", { top: 50 })],
      annotationError: new Error("annotations unavailable"),
    }]);
    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });
    expect(codesOf(result)).toContain("LINK_ANNOTATIONS_UNAVAILABLE");
    expect(result.conversion_status).toBe("partial");
  });

  it("omits link items with page detail under the output budget", async () => {
    const annotations = Array.from({ length: 400 }, (unused, index) => ({
      subtype: "Link",
      rect: [49, 727, 115, 740],
      url: `https://example.com/${"padding".repeat(8)}/${index}`,
    }));
    const document = await PDFDocument.create();
    document.addPage([612, 792]);
    const bytes = await document.save({ useObjectStreams: false });
    const layout = await extractPdfLayout({
      pdfjsLib: fakePdfjs([{
        items: [textItem("Open", { top: 50 })],
        annotations,
      }]),
      pdfBytes: bytes,
      sourcePath: "/validated/source.pdf",
      sourceFileName: "source.pdf",
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      sourceSizeBytes: bytes.length,
      requestedStartPage: 1,
      requestedEndPage: 1,
      maxOutputCharacters: 20000,
    });
    expect(JSON.stringify(layout).length).toBeLessThanOrEqual(20000);
    expect(layout.pages[0].link_annotations.items).toEqual([]);
    expect(layout.pages[0].link_annotations.status).toBe("unavailable");
    expect(layout.pages[0].link_annotations.truncated).toBe(true);
    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });
    expect(result.gaps.map(gap => gap.code)).toContain("LINK_ANNOTATIONS_UNAVAILABLE");
  });

  it("keeps the per-page link cap source-bound", async () => {
    const annotations = Array.from({ length: 260 }, () => ({
      subtype: "Link",
      rect: [49, 727, 115, 740],
      url: "https://example.com/x",
    }));
    const layout = await validatedSyntheticLayout([{
      items: [textItem("Open", { top: 50 })],
      annotations,
    }]);
    expect(layout.pages[0].link_annotations.items.length).toBe(200);
    expect(layout.pages[0].link_annotations.truncated).toBe(true);
    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });
    expect(result.gaps.map(gap => gap.code)).toContain("LINK_ANNOTATIONS_UNAVAILABLE");
  });

  it("suppresses retained links when omitted annotations could overlap them", async () => {
    const annotations = [
      linkAnnotation([49, 727, 75, 740], { url: "https://example.com/retained" }),
      ...Array.from({ length: 199 }, (_unused, index) => (
        linkAnnotation([500, 100, 560, 130], { url: `https://example.com/orphan-${index}` })
      )),
      // This unsupported overlap falls beyond the retained 200-item prefix.
      // Emitting the first link would therefore evade the overlap rule.
      linkAnnotation([49, 727, 75, 740], { dest: ["XYZ"] }),
    ];
    const layout = await validatedSyntheticLayout([linkPage(annotations)]);
    expect(layout.pages[0].link_annotations.items).toHaveLength(200);
    expect(layout.pages[0].link_annotations.truncated).toBe(true);

    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });
    expect(result.markdown).not.toContain("](https://example.com/retained)");
    expect(result.markdown).not.toMatch(/\]\(/u);
    expect(codesOf(result)).toContain("LINK_ANNOTATIONS_UNAVAILABLE");
  });

  it("rejects downgrading available link evidence to unavailable", async () => {
    const layout = await validatedSyntheticLayout([linkPage([
      linkAnnotation([49, 727, 115, 740], { url: "https://example.com/docs" }),
    ])]);
    expect(layout.pages[0].link_annotations.status).toBe("available");
    const mutated = JSON.parse(JSON.stringify(layout));
    mutated.pages[0].link_annotations = { status: "unavailable", truncated: false, items: [] };
    expect(() => validatePdfLayoutSemantics(mutated))
      .toThrow(/unavailable link annotations without supporting evidence/u);
  });

  it("rejects a complete page whose link evidence hit the cap", async () => {
    const layout = await validatedSyntheticLayout([linkPage([
      linkAnnotation([49, 727, 115, 740], { url: "https://example.com/docs" }),
    ])]);
    const mutated = JSON.parse(JSON.stringify(layout));
    mutated.pages[0].link_annotations.truncated = true;
    expect(mutated.pages[0].extraction_status).toBe("complete");
    expect(() => validatePdfLayoutSemantics(mutated))
      .toThrow(/extraction status mismatch/u);
  });

  it("demotes a page whose link annotations hit the per-page cap", async () => {
    const layout = await validatedSyntheticLayout([{
      items: [textItem("Open", { top: 50 })],
      annotations: Array.from({ length: 260 }, () => ({
        subtype: "Link",
        rect: [49, 727, 115, 740],
        url: "https://example.com/x",
      })),
    }]);
    expect(layout.pages[0].link_annotations.truncated).toBe(true);
    expect(layout.pages[0].extraction_status).toBe("partial");
  });

  it("refuses to authenticate available link evidence a replay could not read", async () => {
    const configs = [linkPage([
      linkAnnotation([49, 727, 115, 740], { url: "https://example.com/docs" }),
    ])];
    const document = await PDFDocument.create();
    document.addPage([612, 792]);
    const bytes = await document.save({ useObjectStreams: false });
    const layout = await extractPdfLayout({
      pdfjsLib: fakePdfjs(configs),
      pdfBytes: bytes,
      sourcePath: "/validated/source.pdf",
      sourceFileName: "source.pdf",
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      sourceSizeBytes: bytes.length,
      requestedStartPage: 1,
      requestedEndPage: 1,
      maxOutputCharacters: 200000,
    });
    expect(layout.pages[0].link_annotations.items.length).toBe(1);

    // Replay parser cannot read annotations at all.
    const missing = fakePdfjs(configs);
    const withoutAnnotations = { ...missing };
    const innerMissing = missing.getDocument();
    withoutAnnotations.getDocument = () => ({
      promise: innerMissing.promise.then(document_ => ({
        ...document_,
        getPage: async pageNumber => {
          const page = await document_.getPage(pageNumber);
          const { getAnnotations, ...rest } = page;
          return rest;
        },
      })),
      destroy: async () => {},
    });
    await expect(validatePdfLayoutSourceEvidence(layout, {
      pdfjsLib: withoutAnnotations,
      sourceBytes: bytes,
    })).rejects.toThrow(/available link evidence that was not independently reparsed/u);

    // Replay parser throws while reading annotations.
    const throwing = fakePdfjs([{ ...configs[0], annotationError: new Error("no annotations") }]);
    await expect(validatePdfLayoutSourceEvidence(layout, {
      pdfjsLib: throwing,
      sourceBytes: bytes,
    })).rejects.toThrow(/available link evidence that was not independently reparsed/u);
  });

  it("refuses to splice a link whose source item carries LF or CR", async () => {
    // The IR normalizes line.text (LF becomes a space), so the item text is no
    // longer locatable verbatim and the offsets proof rejects the line. The
    // label newline guard sits behind that as defense in depth.
    for (const newline of ["\n", "\r"]) {
      const result = await renderLinks(
        [linkAnnotation([89, 727, 121, 740], { url: "https://example.com/nl" })],
        [
          textItem("Open", { ...LINE_ONE, left: 50, eol: false }),
          textItem(`do${newline}cs`, { ...LINE_ONE, left: 90 }),
        ],
      );
      expect(result.markdown).not.toContain("](https://example.com/nl)");
      expect(result.markdown).not.toMatch(/\]\(/u);
      expect(codesOf(result)).toContain("LINK_MAPPING_AMBIGUOUS");
    }
  });

  it("refuses to splice a link whose source item is not locatable in line text", async () => {
    // The item carries a leading space that line.text does not preserve, so no
    // provable offset exists and the line fails closed rather than emitting a
    // link against a reconstructed label.
    const result = await renderLinks(
      [linkAnnotation([49, 727, 81, 740], { url: "https://example.com/trim" })],
      [
        textItem(" Open", { ...LINE_ONE, left: 50, eol: false }),
        textItem("docs", { ...LINE_ONE, left: 90 }),
      ],
    );
    expect(result.markdown).not.toContain("](https://example.com/trim)");
    expect(result.markdown).not.toMatch(/\]\(/u);
    expect(codesOf(result)).toContain("LINK_MAPPING_AMBIGUOUS");
  });

  it("neutralizes a blockquote marker at every physical line start", async () => {
    // ">" is neutralized by HTML escaping rather than by the block guard, and
    // blockquote markers do not require a following space. Lock both in.
    const layout = await validatedSyntheticLayout([{
      items: [
        textItem("safe\n>quote", { top: 50 }),
        textItem("safe\r>quote", { top: 80 }),
        textItem(">quote", { top: 110 }),
      ],
    }]);
    const { markdown } = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });
    const body = markdown.split(/\n## /u)[0];
    for (const physicalLine of body.split(/\r\n|\r|\n/u)) {
      expect(physicalLine).not.toMatch(/^[^\S\r\n]*>/u);
    }
    expect(body).toContain("&gt;quote");
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
    const savedOutput = {
      path: "/allowed/result.md",
      encoding: "utf-8",
      bytes: result.markdown_bytes,
      sha256: result.markdown_sha256,
      commit_method: "same_directory_atomic",
      reopened_verified: true,
      overwritten: false,
    };
    const cases = [
      ["markdown SHA-256", { ...result, markdown_sha256: "0".repeat(64) }],
      ["saved output UTF-8 byte count", { ...result, saved_output: { ...savedOutput, bytes: result.markdown_bytes + 1 } }],
      ["saved output SHA-256", { ...result, saved_output: { ...savedOutput, sha256: "0".repeat(64) } }],
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

describe("Markdown gap-code contract", () => {
  // Every code this renderer declares must be reachable. Four codes were
  // declared but unreachable before this lane, so a page that was entirely a
  // flattened table or a dropped link reported complete coverage. This test
  // fails the whole class rather than one instance: it reads the shipped
  // sources and requires each declared code to have at least one emit site,
  // and requires the runtime set and the published schema enum to agree.
  const readSource = name => fs.readFile(
    path.join(REPO_ROOT, name),
    "utf8",
  );

  it("declares no gap code the renderer cannot emit", async () => {
    const source = await readSource("server/markdown-conversion.js");
    const declared = source
      .slice(source.indexOf("const GAP_CODES"), source.indexOf("const LIMITATIONS"))
      .match(/"[A-Z_]+"/gu)
      .map(value => value.replaceAll('"', ""));
    expect(declared.length).toBeGreaterThan(0);
    const unreachable = declared.filter(code => !source.includes(`add("${code}"`));
    expect(unreachable, `declared but never emitted: ${unreachable.join(", ")}`)
      .toEqual([]);
  });

  it("keeps the runtime gap set and the published schema enum identical", async () => {
    const [source, schema] = await Promise.all([
      readSource("server/markdown-conversion.js"),
      readSource("server/output-schemas.js"),
    ]);
    const declared = source
      .slice(source.indexOf("const GAP_CODES"), source.indexOf("const LIMITATIONS"))
      .match(/"[A-Z_]+"/gu)
      .map(value => value.replaceAll('"', ""))
      .sort();
    const published = schema
      .slice(schema.indexOf("const markdownGapCode"), schema.indexOf("const markdownPage"))
      .match(/"[A-Z_]+"/gu)
      .map(value => value.replaceAll('"', ""))
      .sort();
    expect(published).toEqual(declared);
  });

  it("keeps the share runtime byte-identical to its source", async () => {
    for (const name of ["markdown-conversion.js", "output-schemas.js", "layout-extraction.js"]) {
      const [a, b] = await Promise.all([
        readSource(`server/${name}`),
        readSource(`pdf-toolkit-mcp-share/server/${name}`),
      ]);
      expect(b, name).toBe(a);
    }
  });
});
