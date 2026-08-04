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

function positionedTextItem(text, {
  top,
  left,
  width,
  fontSize = 10,
  fontName = "f1",
  eol = false,
} = {}) {
  return {
    str: text,
    dir: "ltr",
    width,
    height: fontSize,
    transform: [fontSize, 0, 0, fontSize, left, 792 - top - fontSize],
    fontName,
    hasEOL: eol,
  };
}

function centeredTextItem(text, { top, fontSize = 12 } = {}) {
  const width = Math.max(20, text.length * fontSize * 0.5);
  return textItem(text, { top, fontSize, left: (612 - width) / 2 });
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
        styles: {
          f1: { fontFamily: "Test Sans", ascent: 0.8, descent: -0.2, vertical: false },
          f2: { fontFamily: "Test Sans", ascent: 0.8, descent: -0.2, vertical: false },
        },
      };
    },
    getOperatorList: async () => ({
      fnArray: config.operations ?? [],
      argsArray: config.operatorArgs ?? (config.operations ?? []).map(() => null),
    }),
    getAnnotations: async () => {
      if (config.annotationError) throw config.annotationError;
      return config.annotations ?? [];
    },
    cleanup: () => {},
  }));
  return {
    version: "5.4.624",
    OPS: {
      paintImageXObject: 1,
      constructPath: 2,
      fill: 3,
      save: 4,
      restore: 5,
      transform: 6,
      paintSolidColorImageMask: 7,
    },
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

function paintedGridOperations({ xs, ys, missingVertical = null, extraRectangles = [] }) {
  const rectangles = [
    ...ys.map(y => ({ x: xs[0], y, width: xs[xs.length - 1] - xs[0], height: 0.5 })),
    ...xs.filter(x => x !== missingVertical).map(x => ({
      x,
      y: ys[0],
      width: 0.5,
      height: ys[ys.length - 1] - ys[0],
    })),
    ...extraRectangles,
  ];
  const operations = [];
  const operatorArgs = [];
  for (const rectangle of rectangles) {
    operations.push(4, 6, 7, 5);
    operatorArgs.push(
      null,
      [rectangle.width, 0, 0, -rectangle.height, rectangle.x, 792 - rectangle.y],
      [],
      null,
    );
  }
  return { operations, operatorArgs };
}

function combinePaintedOperations(...groups) {
  return {
    operations: groups.flatMap(group => group.operations),
    operatorArgs: groups.flatMap(group => group.operatorArgs),
  };
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

  it("uses a complete painted grid to recover multi-line table cells", async () => {
    const rules = paintedGridOperations({ xs: [100, 250, 400], ys: [100, 130, 200, 270] });
    const layout = await validatedSyntheticLayout([{
      ...rules,
      items: [
        centeredTextItem("TABLE 1", { top: 70, fontSize: 10 }),
        positionedTextItem("FIRST", { top: 105, left: 120, width: 30 }),
        positionedTextItem("SECOND", { top: 105, left: 270, width: 40, eol: true }),
        positionedTextItem("alpha", { top: 145, left: 120, width: 30 }),
        positionedTextItem("one", { top: 155, left: 120, width: 20, eol: true }),
        positionedTextItem("10", { top: 150, left: 270, width: 12, eol: true }),
        positionedTextItem("beta", { top: 215, left: 120, width: 25, eol: true }),
        positionedTextItem("20", { top: 220, left: 270, width: 12, eol: true }),
        textItem("Following prose remains outside the table.", { top: 300 }),
      ],
    }]);
    expect(layout.pages[0].painted_rectangles).toMatchObject({
      status: "available",
      truncated: false,
      observed_count: 7,
      returned_count: 7,
    });
    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });
    expect(result.markdown).toContain("| FIRST | SECOND |\n| --- | --- |\n| alpha<br>one | 10 |\n| beta | 20 |");
    expect(result.markdown).toContain("Following prose remains outside the table.");
    expect(result.gaps.map(gap => gap.code)).not.toContain("TABLE_TOPOLOGY_UNKNOWN");
  });

  it("refuses incomplete grids and closed grids without header evidence", async () => {
    const incomplete = paintedGridOperations({
      xs: [100, 250, 400],
      ys: [100, 130, 200, 270],
      missingVertical: 250,
    });
    const items = [
      centeredTextItem("TABLE 1", { top: 70, fontSize: 10 }),
      positionedTextItem("FIRST", { top: 105, left: 120, width: 30 }),
      positionedTextItem("SECOND", { top: 105, left: 270, width: 40, eol: true }),
      positionedTextItem("alpha", { top: 150, left: 120, width: 30 }),
      positionedTextItem("10", { top: 150, left: 270, width: 12, eol: true }),
      positionedTextItem("beta", { top: 220, left: 120, width: 25 }),
      positionedTextItem("20", { top: 220, left: 270, width: 12, eol: true }),
    ];
    const closed = paintedGridOperations({ xs: [100, 250, 400], ys: [100, 130, 200, 270] });
    const crossing = [
      centeredTextItem("TABLE 2", { top: 70, fontSize: 10 }),
      positionedTextItem("CROSSING HEADER", { top: 105, left: 225, width: 80, eol: true }),
      ...items.slice(3),
    ];
    const layout = await validatedSyntheticLayout([
      { ...incomplete, items },
      { ...closed, items: items.slice(1) },
      { ...closed, items: crossing },
    ]);
    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });
    expect(result.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TABLE_TOPOLOGY_UNKNOWN", page: 2 }),
      expect.objectContaining({ code: "TABLE_TOPOLOGY_UNKNOWN", page: 3 }),
    ]));
    expect(result.markdown.match(/\| --- \| --- \|/gu)).toBeNull();
  });

  it("refuses partial dividers that evidence merged columns or rows", async () => {
    const mergedHeader = paintedGridOperations({
      xs: [100, 300, 400],
      ys: [100, 130, 200, 270],
      extraRectangles: [{ x: 200, y: 130, width: 0.5, height: 140 }],
    });
    const rowSpan = paintedGridOperations({
      xs: [100, 250, 400],
      ys: [100, 130, 270, 340],
      extraRectangles: [{ x: 250, y: 200, width: 150, height: 0.5 }],
    });
    const mergedItems = [
      centeredTextItem("TABLE 1", { top: 70, fontSize: 10 }),
      positionedTextItem("FIRST", { top: 105, left: 120, width: 30 }),
      positionedTextItem("SECOND", { top: 105, left: 210, width: 40 }),
      positionedTextItem("THIRD", { top: 105, left: 320, width: 30, eol: true }),
      positionedTextItem("a", { top: 150, left: 120, width: 8 }),
      positionedTextItem("b", { top: 150, left: 220, width: 8 }),
      positionedTextItem("1", { top: 150, left: 320, width: 8, eol: true }),
      positionedTextItem("c", { top: 220, left: 120, width: 8 }),
      positionedTextItem("d", { top: 220, left: 220, width: 8 }),
      positionedTextItem("2", { top: 220, left: 320, width: 8, eol: true }),
    ];
    const rowSpanItems = [
      centeredTextItem("TABLE 2", { top: 70, fontSize: 10 }),
      positionedTextItem("FIRST", { top: 105, left: 120, width: 30 }),
      positionedTextItem("SECOND", { top: 105, left: 270, width: 40, eol: true }),
      positionedTextItem("span", { top: 155, left: 120, width: 25 }),
      positionedTextItem("upper", { top: 155, left: 270, width: 30, eol: true }),
      positionedTextItem("lower", { top: 220, left: 270, width: 30, eol: true }),
      positionedTextItem("left", { top: 290, left: 120, width: 20 }),
      positionedTextItem("right", { top: 290, left: 270, width: 25, eol: true }),
    ];
    const layout = await validatedSyntheticLayout([
      { ...mergedHeader, items: mergedItems },
      { ...rowSpan, items: rowSpanItems },
    ]);
    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });
    expect(result.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TABLE_TOPOLOGY_UNKNOWN", page: 1 }),
      expect.objectContaining({ code: "TABLE_TOPOLOGY_UNKNOWN", page: 2 }),
    ]));
    expect(result.markdown).not.toContain("| --- |");
  });

  it("refuses ambiguous multiple grids and source-order cell interleaving", async () => {
    const firstGrid = paintedGridOperations({ xs: [40, 110, 180], ys: [100, 130, 200, 270] });
    const secondGrid = paintedGridOperations({ xs: [300, 370, 440], ys: [100, 130, 200, 270] });
    const closed = paintedGridOperations({ xs: [100, 150, 200], ys: [100, 130, 200, 270] });
    const interleavedItems = [
      positionedTextItem("TABLE 3", { top: 70, left: 130, width: 40, eol: true }),
      positionedTextItem("FIRST", { top: 105, left: 105, width: 30 }),
      positionedTextItem("SECOND", { top: 105, left: 155, width: 40, eol: true }),
      positionedTextItem("a", { top: 150, left: 110, width: 8 }),
      positionedTextItem("1", { top: 150, left: 160, width: 8 }),
      positionedTextItem("b", { top: 150, left: 130, width: 8 }),
      positionedTextItem("2", { top: 150, left: 180, width: 8, eol: true }),
      positionedTextItem("c", { top: 220, left: 110, width: 8 }),
      positionedTextItem("3", { top: 220, left: 160, width: 8, eol: true }),
    ];
    const layout = await validatedSyntheticLayout([
      { ...combinePaintedOperations(firstGrid, secondGrid), items: [] },
      { ...closed, items: interleavedItems },
    ]);
    const interleavedLine = layout.pages[1].lines.find(line => line.text.includes("a") && line.text.includes("1"));
    expect(interleavedLine?.text).toMatch(/a.*1.*b.*2/u);
    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });
    expect(result.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TABLE_TOPOLOGY_UNKNOWN", page: 1 }),
      expect.objectContaining({ code: "TABLE_TOPOLOGY_UNKNOWN", page: 2 }),
    ]));
    expect(result.markdown).not.toContain("| --- |");
  });

  it("bounds ruled-grid rows, columns, and cells before allocating cell content", async () => {
    const tooManyColumns = paintedGridOperations({
      xs: Array.from({ length: 52 }, (_value, index) => index * 12),
      ys: [100, 110, 200, 300],
    });
    const tooManyCells = paintedGridOperations({
      xs: Array.from({ length: 41 }, (_value, index) => 50 + index * 12),
      ys: [100, 108, ...Array.from({ length: 29 }, (_value, index) => 116 + index * 8)],
    });
    const layout = await validatedSyntheticLayout([
      { ...tooManyColumns, items: [] },
      { ...tooManyCells, items: [] },
    ]);
    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });
    expect(result.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TABLE_TOPOLOGY_UNKNOWN", page: 1 }),
      expect.objectContaining({ code: "TABLE_TOPOLOGY_UNKNOWN", page: 2 }),
    ]));
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

  it("keeps unreadable glyphs, lone characters, and equation fragments out of headings", async () => {
    const page = candidate => ({
      items: [
        textItem(candidate, { top: 50, fontSize: 24 }),
        textItem("First body line", { top: 100 }),
        textItem("Second body line", { top: 130 }),
        textItem("Third body line", { top: 160 }),
        textItem("Fourth body line", { top: 190 }),
      ],
    });
    const layout = await validatedSyntheticLayout([
      page("�"),
      page("T"),
      page("H = p log p"),
    ]);
    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });

    expect(result.markdown).toContain("�\n");
    expect(result.markdown).toContain("T\n");
    expect(result.markdown).toContain("H = p log p\n");
    expect(result.markdown).not.toMatch(/^#{1,6}\s+(?:�|T|H = p log p)$/gmu);
  });

  it("restores only a geometrically proven space after a separate log operator", async () => {
    const layout = await validatedSyntheticLayout([
      { items: [
        positionedTextItem("C", { top: 80, left: 60, width: 6.67, fontName: "f2" }),
        positionedTextItem("=", { top: 80, left: 68.5, width: 7.8 }),
        positionedTextItem("Lim", { top: 80, left: 78.5, width: 16.65, eol: true }),
        positionedTextItem("log", { top: 100, left: 100, width: 12.8 }),
        positionedTextItem("N", { top: 100, left: 113.8, width: 6.67, fontName: "f2" }),
        positionedTextItem("(", { top: 100, left: 120.9, width: 3.84 }),
        positionedTextItem("T", { top: 100, left: 124.74, width: 5.56, fontName: "f2" }),
        positionedTextItem(")", { top: 100, left: 131, width: 3.84, eol: true }),
      ] },
      { items: [
        positionedTextItem("p", { top: 100, left: 100, width: 5, fontName: "f2" }),
        positionedTextItem("i", { top: 103.52, left: 105.04, width: 2.057, fontSize: 7.4, fontName: "f2" }),
        positionedTextItem(" ", { top: 100, left: 107.1, width: 1.7 }),
        positionedTextItem("log", { top: 100, left: 108.8, width: 12.8 }),
        positionedTextItem("p", { top: 100, left: 123.319, width: 5, fontName: "f2" }),
        positionedTextItem("i", { top: 103.52, left: 128.36, width: 2.057, fontSize: 7.4, fontName: "f2", eol: true }),
      ] },
      { items: [
        positionedTextItem("cata", { top: 100, left: 100, width: 16 }),
        positionedTextItem("log", { top: 100, left: 116, width: 12.8 }),
        positionedTextItem("N", { top: 100, left: 129.8, width: 6.67, fontName: "f2", eol: true }),
      ] },
      { items: [
        positionedTextItem("log", { top: 100, left: 100, width: 12.8 }),
        positionedTextItem("N", { top: 100, left: 113.8, width: 6.67, eol: true }),
      ] },
      { items: [
        positionedTextItem("log", { top: 100, left: 100, width: 12.8 }),
        positionedTextItem("N", { top: 100, left: 113.8, width: 6.67, fontName: "f2", eol: true }),
      ] },
      { items: [
        positionedTextItem("s", { top: 100, left: 100, width: 5 }),
        positionedTextItem("log", { top: 100, left: 105, width: 12.8 }),
        positionedTextItem("a", { top: 100, left: 118.8, width: 5, fontName: "f2" }),
        positionedTextItem("n", { top: 100, left: 123.8, width: 5, fontName: "f2", eol: true }),
      ] },
      { items: [
        positionedTextItem("logN", { top: 100, left: 100, width: 20, fontName: "f2", eol: true }),
      ] },
      { items: [
        positionedTextItem("log", { top: 100, left: 100, width: 12.8 }),
        positionedTextItem("Noise", { top: 100, left: 113.8, width: 22, fontName: "f2", eol: true }),
      ] },
      { items: [
        positionedTextItem("log", { top: 100, left: 100, width: 12.8 }),
        positionedTextItem("N", { top: 100, left: 113.8, width: 6.67, fontName: "f2" }),
        positionedTextItem("=", { top: 100, left: 121, width: 7.8 }),
        positionedTextItem("5", { top: 100, left: 130, width: 5, eol: true }),
      ] },
      { items: [
        positionedTextItem("x", { top: 80, left: 100, width: 5, fontName: "f2" }),
        positionedTextItem("=", { top: 80, left: 106, width: 7.8 }),
        positionedTextItem("1", { top: 80, left: 115, width: 5, eol: true }),
        positionedTextItem("log", { top: 100, left: 100, width: 12.8 }),
        positionedTextItem("N", { top: 100, left: 113.8, width: 6.67, fontName: "f2" }),
        positionedTextItem("(", { top: 100, left: 120.9, width: 3.84 }),
        positionedTextItem(")", { top: 100, left: 124.74, width: 3.84, eol: true }),
      ] },
    ]);
    const originalLines = layout.pages.map(page => page.lines.map(line => line.text));
    const result = renderPdfLayoutToMarkdown(layout);

    expect(result.markdown).toContain("log N(T)");
    expect(result.markdown).toContain("pi log pi");
    expect(result.markdown).toContain("catalogN");
    expect(result.markdown).toContain("logN\n");
    expect(result.markdown.split("\n").filter(line => line === "logN")).toHaveLength(3);
    expect(result.markdown).toContain("slogan");
    expect(result.markdown).toContain("logNoise");
    expect(result.markdown).toContain("logN=5");
    expect(result.markdown).toContain("x=1\nlogN()");
    expect(layout.pages.map(page => page.lines.map(line => line.text))).toEqual(originalLines);
    expect(originalLines[0]).toContain("logN(T)");
    expect(validateMarkdownConversionSemantics(result, { layout })).toBe(result);
  });

  it("does not rewrite math-like lists, ambiguous tables, or unsupported link pages", async () => {
    const compactScript = top => [
      positionedTextItem("p", { top, left: 100, width: 5, fontName: "f2" }),
      positionedTextItem("i", { top: top + 3.52, left: 105.04, width: 2.057, fontSize: 7.4, fontName: "f2" }),
      positionedTextItem(" ", { top, left: 107.1, width: 1.7 }),
      positionedTextItem("log", { top, left: 108.8, width: 12.8 }),
      positionedTextItem("p", { top, left: 123.319, width: 5, fontName: "f2" }),
      positionedTextItem("i", { top: top + 3.52, left: 128.36, width: 2.057, fontSize: 7.4, fontName: "f2", eol: true }),
    ];
    const layout = await validatedSyntheticLayout([
      { items: [
        positionedTextItem("• ", { top: 100, left: 90, width: 8 }),
        positionedTextItem("log", { top: 100, left: 100, width: 12.8 }),
        positionedTextItem("N", { top: 100, left: 113.8, width: 6.67, fontName: "f2" }),
        positionedTextItem("(", { top: 100, left: 120.9, width: 3.84 }),
        positionedTextItem("T", { top: 100, left: 124.74, width: 5.56, fontName: "f2" }),
        positionedTextItem(")", { top: 100, left: 131, width: 3.84, eol: true }),
      ] },
      { items: [
        positionedTextItem("A", { top: 60, left: 50, width: 5 }),
        positionedTextItem("B", { top: 60, left: 80, width: 5, eol: true }),
        positionedTextItem("1", { top: 80, left: 50, width: 5 }),
        positionedTextItem("2", { top: 80, left: 80, width: 5, eol: true }),
        textItem("separator", { top: 110, left: 50 }),
        ...compactScript(140),
      ] },
      {
        items: compactScript(100),
        annotations: [{ subtype: "Link", rect: [99, 677, 150, 690], dest: ["XYZ"] }],
      },
    ]);
    const result = renderPdfLayoutToMarkdown(layout);

    expect(result.markdown).toMatch(/^- logN\(T\)$/mu);
    expect(result.markdown.split("\n").filter(line => line === "pi logpi")).toHaveLength(2);
    expect(result.gaps.map(gap => gap.code)).toContain("TABLE_TOPOLOGY_UNKNOWN");
    expect(result.gaps.map(gap => gap.code)).toContain("UNSUPPORTED_LINK_TARGET");
  });

  it("recognizes conservative document structure without promoting lookalike equations", async () => {
    const body = top => [
      textItem("First body line", { top }),
      textItem("Second body line", { top: top + 30 }),
      textItem("Third body line", { top: top + 60 }),
      textItem("Fourth body line", { top: top + 90 }),
    ];
    const layout = await validatedSyntheticLayout([
      { items: [
        textItem("Reprinted with corrections from the journal", { top: 20 }),
        textItem("Volume 27, July 1948", { top: 35 }),
        centeredTextItem("A Mathematical Theory of Communication", { top: 50, fontSize: 16 }),
        centeredTextItem("INTRODUCTION", { top: 90 }),
        ...body(130),
      ] },
      { items: [centeredTextItem("PART IV: THE CONTINUOUS CHANNEL", { top: 60 }), ...body(100)] },
      { items: [centeredTextItem("APPENDIX 7", { top: 60 }), ...body(100)] },
      { items: [
        textItem("PART I = H", { top: 50, fontSize: 24 }),
        textItem("INTRODUCTION = H", { top: 90, fontSize: 24 }),
        ...body(130),
      ] },
    ]);
    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });

    expect(result.markdown).toMatch(/^# A Mathematical Theory of Communication$/mu);
    expect(result.markdown).toMatch(/^## INTRODUCTION$/mu);
    expect(result.markdown).toMatch(/^## PART IV: THE CONTINUOUS CHANNEL$/mu);
    expect(result.markdown).toMatch(/^## APPENDIX 7$/mu);
    expect(result.markdown).not.toMatch(/^#{1,6}\s+(?:PART I = H|INTRODUCTION = H)$/gmu);
  });

  it("emits at most one first-page H1 when a title and subtitle share the strongest style", async () => {
    const layout = await validatedSyntheticLayout([{
      items: [
        centeredTextItem("Annual Financial Report", { top: 30, fontSize: 18 }),
        centeredTextItem("For Shareholders and Partners", { top: 60, fontSize: 18 }),
        textItem("First body line", { top: 100 }),
        textItem("Second body line", { top: 130 }),
        textItem("Third body line", { top: 160 }),
        textItem("Fourth body line", { top: 190 }),
      ],
    }]);
    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });

    expect(result.markdown.match(/^#\s+/gmu)).toHaveLength(1);
    expect(result.markdown).toMatch(/^## (?:Annual Financial Report|For Shareholders and Partners)$/mu);
  });

  it("does not promote repeated page labels or contents-like entries without layout support", async () => {
    const body = top => [
      textItem("First body line", { top }),
      textItem("Second body line", { top: top + 30 }),
      textItem("Third body line", { top: top + 60 }),
      textItem("Fourth body line", { top: top + 90 }),
    ];
    const layout = await validatedSyntheticLayout([
      { items: [centeredTextItem("INTRODUCTION", { top: 20 }), ...body(50)] },
      { items: [
        textItem("Contents entry", { top: 80 }),
        centeredTextItem("APPENDIX 1", { top: 98 }),
        ...body(120),
      ] },
      { items: [textItem("PART I: REPEATED PAGE LABEL", { top: 20 }), ...body(50)] },
    ]);
    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });

    expect(result.markdown).not.toMatch(/^#{1,6}\s+(?:INTRODUCTION|APPENDIX 1|PART I: REPEATED PAGE LABEL)$/gmu);
  });

  it("joins a geometrically supported drop cap without deleting ambiguous line-end hyphens", async () => {
    const layout = await validatedSyntheticLayout([{
      items: [
        textItem("T", { top: 50, left: 40, fontSize: 30 }),
        textItem("HE recent development was rapid and ap-", { top: 62, left: 67 }),
        textItem("proximately correct.", { top: 90, left: 67 }),
        centeredTextItem("PART I: BODY", { top: 140 }),
        textItem("state-", { top: 180 }),
        textItem("2) of the art", { top: 210 }),
        textItem("three-", { top: 250 }),
        textItem("dimensional sound", { top: 280 }),
        textItem("Ordinary context", { top: 320 }),
        textItem("A", { top: 360, left: 40, fontSize: 30 }),
        textItem("BC Corporation provides ordinary business services", { top: 372, left: 67 }),
      ],
    }]);
    const result = renderPdfLayoutToMarkdown(layout, { includePageBoundaries: false });

    expect(result.markdown).toContain("THE recent development was rapid and ap-\nproximately correct.");
    expect(result.markdown).toContain("## PART I: BODY");
    expect(result.markdown).toContain("state-\n2) of the art");
    expect(result.markdown).toContain("three-\ndimensional sound");
    expect(result.markdown).toContain("Ordinary context\nA\nBC Corporation provides ordinary business services");
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
    expect(result.limitations.some(value => value.includes("Cell artwork is omitted and reported as a vector-content gap"))).toBe(true);
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
    for (const name of ["markdown-conversion.js", "output-schemas.js", "layout-extraction.js", "type3-cm-reference.js"]) {
      const [a, b] = await Promise.all([
        readSource(`server/${name}`),
        readSource(`pdf-toolkit-mcp-share/server/${name}`),
      ]);
      expect(b, name).toBe(a);
    }
  });
});
