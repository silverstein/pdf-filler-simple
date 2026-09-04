import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { extractPdfLayout } from "../server/layout-extraction.js";
import {
  renderPdfLayoutToMarkdown,
  validateMarkdownConversionSemantics,
} from "../server/markdown-conversion.js";
import { TOOL_OUTPUT_SCHEMAS } from "../server/output-schemas.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

const CODE = "MATH_NOT_RECONSTRUCTED";

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

function textItem(text, { top, fontSize = 12, left = 50, fontName = "f1", eol = true } = {}) {
  return {
    str: text,
    dir: "ltr",
    width: Math.max(20, text.length * fontSize * 0.5),
    height: fontSize,
    transform: [fontSize, 0, 0, fontSize, left, 792 - top - fontSize],
    fontName,
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

function fakePdfjs(pageConfigs) {
  const pages = pageConfigs.map(config => ({
    view: [0, 0, 612, 792],
    userUnit: 1,
    rotate: 0,
    getViewport: () => ({ scale: 1, width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
    getTextContent: async () => ({
      items: config.items ?? [],
      styles: {
        f1: { fontFamily: "Test Sans", ascent: 0.8, descent: -0.2, vertical: false },
        f2: { fontFamily: "Test Sans", ascent: 0.8, descent: -0.2, vertical: false },
      },
    }),
    getOperatorList: async () => ({
      fnArray: config.operations ?? [],
      argsArray: config.operatorArgs ?? (config.operations ?? []).map(() => null),
    }),
    getAnnotations: async () => config.annotations ?? [],
    cleanup: () => {},
  }));
  return {
    version: "5.4.624",
    OPS: {
      save: 10,
      restore: 11,
      transform: 12,
      clip: 29,
      eoClip: 30,
      paintFormXObjectBegin: 74,
      paintFormXObjectEnd: 75,
      paintImageXObject: 1,
      paintJpegXObject: 5,
      paintImageMaskXObject: 6,
      paintImageMaskXObjectGroup: 7,
      paintInlineImageXObject: 8,
      paintInlineImageXObjectGroup: 9,
      paintImageXObjectRepeat: 13,
      paintImageMaskXObjectRepeat: 14,
      constructPath: 2,
      stroke: 4,
      closeStroke: 15,
      fill: 3,
      eoFill: 16,
      fillStroke: 17,
      eoFillStroke: 18,
      closeFillStroke: 19,
      closeEOFillStroke: 20,
      endPath: 21,
      paintSolidColorImageMask: 76,
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

function ruledGridRects() {
  const rects = [{ x: 72, y: 112, width: 450, height: 48, verb: "stroke" }];
  for (let row = 1; row < 4; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      rects.push({ x: 72 + column * 150, y: 112 + row * 48, width: 150, height: 48, verb: "stroke" });
    }
  }
  return rects;
}

function ruledGridItems() {
  const values = [
    ["Region", "Q1", "Q2"],
    ["North", "1200", "1450"],
    ["South", "980", "1020"],
    ["West", "1500", "1380"],
  ];
  return values.flatMap((row, rowIndex) => row.map((value, columnIndex) => textItem(value, {
    top: 130 + rowIndex * 48,
    left: 82 + columnIndex * 150,
    fontSize: rowIndex === 0 ? 13 : 12,
    eol: columnIndex === row.length - 1,
  })));
}

/**
 * The conversion corpus this lane is measured against. Each entry is one
 * document; the array index is its page number.
 *
 * `footnoteMarker` is the load-bearing negative: its raised "2" is a real
 * attached superscript that the renderer transcribes as U+00B2, which is
 * exactly the geometry a mathematical exponent has. The renderer's own
 * limitation prose says the two cannot be told apart, so a raised run must not
 * be enough on its own to declare mathematics.
 */
const CORPUS = {
  prose: [{
    items: [
      textItem("Introduction to the quarterly report", { top: 50, fontSize: 18 }),
      textItem("This section explains the method in ordinary prose without any", { top: 90 }),
      textItem("mathematical content at all, so nothing here is an equation.", { top: 110 }),
    ],
  }],
  footnoteMarker: [{
    items: [
      positionedTextItem("The measured throughput was stable", { top: 100, left: 100, width: 150 }),
      positionedTextItem("2", { top: 99.1, left: 250.4, width: 2.6, fontSize: 7.4, eol: true }),
      positionedTextItem("across every observed trial in the study.", { top: 130, left: 100, width: 170, eol: true }),
    ],
  }],
  namedOperatorEquation: [{
    items: [
      positionedTextItem("C", { top: 80, left: 60, width: 6.67, fontName: "f2" }),
      positionedTextItem("=", { top: 80, left: 68.5, width: 7.8 }),
      positionedTextItem("Lim", { top: 80, left: 78.5, width: 16.65, eol: true }),
      positionedTextItem("log", { top: 100, left: 100, width: 12.8 }),
      positionedTextItem("N", { top: 100, left: 113.8, width: 6.67, fontName: "f2" }),
      positionedTextItem("(", { top: 100, left: 120.9, width: 3.84 }),
      positionedTextItem("T", { top: 100, left: 124.74, width: 5.56, fontName: "f2" }),
      positionedTextItem(")", { top: 100, left: 131, width: 3.84, eol: true }),
    ],
  }],
  lowercaseOperatorEquation: [{
    items: [
      positionedTextItem("x", { top: 100, left: 100, width: 6, fontName: "f2" }),
      positionedTextItem("=", { top: 100, left: 107, width: 7 }),
      positionedTextItem("lim", { top: 100, left: 115, width: 15, eol: true }),
    ],
  }],
  mergedNamedOperatorEquation: [{
    items: [textItem("lim x=0", { top: 100 })],
  }],
  mergedFunctionOperatorEquation: [{
    items: [textItem("max(x)=5", { top: 100 })],
  }],
  mergedSymbolEquation: [{
    items: [textItem("x ∈ X", { top: 100 })],
  }],
  mergedInlineMath: [{
    items: [textItem("For any x ∈ X, choose y.", { top: 100 })],
  }],
  relationEquation: [{
    items: [
      positionedTextItem("log", { top: 100, left: 100, width: 12.8 }),
      positionedTextItem("N", { top: 100, left: 113.8, width: 6.67, fontName: "f2" }),
      positionedTextItem("=", { top: 100, left: 121, width: 7.8 }),
      positionedTextItem("5", { top: 100, left: 130, width: 5, eol: true }),
    ],
  }],
  compactRunWithoutMarker: [{
    items: [
      positionedTextItem("log", { top: 100, left: 100, width: 12.8 }),
      positionedTextItem("N", { top: 100, left: 113.8, width: 6.67, eol: true }),
    ],
  }],
  namedOperatorWithoutRelation: [{
    items: [
      positionedTextItem("Max", { top: 100, left: 100, width: 18 }),
      positionedTextItem("5", { top: 100, left: 119, width: 5, eol: true }),
    ],
  }],
  sameFontNamedRelation: [{
    items: [
      positionedTextItem("Max", { top: 100, left: 100, width: 18 }),
      positionedTextItem("=", { top: 100, left: 119, width: 7 }),
      positionedTextItem("5", { top: 100, left: 127, width: 5, eol: true }),
    ],
  }],
  mergedAmbiguousNamedRelation: [{
    items: [textItem("max=5", { top: 100 })],
  }],
  mergedAmbiguousNamedVariable: [{
    items: [textItem("max x=5", { top: 100 })],
  }],
  mergedProgrammingDeclaration: [{
    items: [textItem("int x=5", { top: 100 })],
  }],
  mergedOperatorSubstring: [{
    items: [textItem("maximum(x)=5", { top: 100 })],
  }],
  mergedConfiguration: [{
    items: [textItem("PATH=/tmp", { top: 100 })],
  }],
  loneMergedSymbol: [{
    items: [textItem("∑", { top: 100 })],
  }],
  checkmarkStatus: [{
    items: [textItem("A2 ≥ 80% √", { top: 100 })],
  }],
  genericCrossFontRelation: [{
    items: [
      positionedTextItem("A", { top: 100, left: 100, width: 6, fontName: "f2" }),
      positionedTextItem("=", { top: 100, left: 107, width: 7 }),
      positionedTextItem("B", { top: 100, left: 115, width: 6, eol: true }),
    ],
  }],
  symbolicOperatorEquation: [{
    items: [
      positionedTextItem("κ", { top: 100, left: 100, width: 6, fontName: "f2" }),
      positionedTextItem("∑", { top: 100, left: 107, width: 12, eol: true }),
    ],
  }],
  proseThenEquation: [
    {
      items: [
        textItem("Channel capacity", { top: 50, fontSize: 18 }),
        textItem("The capacity of a discrete noiseless channel is defined below.", { top: 90 }),
      ],
    },
    {
      items: [
        positionedTextItem("C", { top: 80, left: 60, width: 6.67, fontName: "f2" }),
        positionedTextItem("=", { top: 80, left: 68.5, width: 7.8 }),
        positionedTextItem("Lim", { top: 80, left: 78.5, width: 16.65, eol: true }),
      ],
    },
    {
      items: [
        textItem("The remainder of the paper discusses the practical consequences.", { top: 90 }),
      ],
    },
  ],
  ruledTable: [{ items: ruledGridItems(), ruledRects: ruledGridRects() }],
};

/**
 * The Markdown body every corpus entry rendered to **before** this lane existed,
 * captured from the renderer at dd2d922 (v0.11.0) and pasted here verbatim.
 *
 * This is the safety property of the whole lane: MATH_NOT_RECONSTRUCTED only
 * declares, so the body must stay byte-identical and only the trailing
 * `## Conversion gaps` section may move. Every entry is checked in both default
 * and compact mode. If a change to the renderer makes one of these fail, the
 * change reconstructed, removed, or reordered something and does not belong in
 * this lane.
 */
const PRE_CHANGE_BODIES = {
  prose: "<!-- PDF page 1 -->\n\nIntroduction to the quarterly report\nThis section explains the method in ordinary prose without any\nmathematical content at all, so nothing here is an equation.",
  "prose:compact": "<!-- PDF page 1 -->\n\nIntroduction to the quarterly report\nThis section explains the method in ordinary prose without any\nmathematical content at all, so nothing here is an equation.",
  footnoteMarker: "<!-- PDF page 1 -->\n\nThe measured throughput was stable²\nacross every observed trial in the study.",
  "footnoteMarker:compact": "<!-- PDF page 1 -->\n\nThe measured throughput was stable²\nacross every observed trial in the study.",
  namedOperatorEquation: "<!-- PDF page 1 -->\n\nC= Lim\nlog N(T)",
  "namedOperatorEquation:compact": "<!-- PDF page 1 -->\n\nC= Lim\nlog N(T)",
  lowercaseOperatorEquation: "<!-- PDF page 1 -->\n\nx=lim",
  "lowercaseOperatorEquation:compact": "<!-- PDF page 1 -->\n\nx=lim",
  mergedNamedOperatorEquation: "<!-- PDF page 1 -->\n\nlim x=0",
  "mergedNamedOperatorEquation:compact": "<!-- PDF page 1 -->\n\nlim x=0",
  mergedFunctionOperatorEquation: "<!-- PDF page 1 -->\n\nmax(x)=5",
  "mergedFunctionOperatorEquation:compact": "<!-- PDF page 1 -->\n\nmax(x)=5",
  mergedSymbolEquation: "<!-- PDF page 1 -->\n\nx ∈ X",
  "mergedSymbolEquation:compact": "<!-- PDF page 1 -->\n\nx ∈ X",
  mergedInlineMath: "<!-- PDF page 1 -->\n\nFor any x ∈ X, choose y.",
  "mergedInlineMath:compact": "<!-- PDF page 1 -->\n\nFor any x ∈ X, choose y.",
  relationEquation: "<!-- PDF page 1 -->\n\nlogN=5",
  "relationEquation:compact": "<!-- PDF page 1 -->\n\nlogN=5",
  compactRunWithoutMarker: "<!-- PDF page 1 -->\n\nlogN",
  "compactRunWithoutMarker:compact": "<!-- PDF page 1 -->\n\nlogN",
  namedOperatorWithoutRelation: "<!-- PDF page 1 -->\n\nMax5",
  "namedOperatorWithoutRelation:compact": "<!-- PDF page 1 -->\n\nMax5",
  sameFontNamedRelation: "<!-- PDF page 1 -->\n\nMax=5",
  "sameFontNamedRelation:compact": "<!-- PDF page 1 -->\n\nMax=5",
  mergedAmbiguousNamedRelation: "<!-- PDF page 1 -->\n\nmax=5",
  "mergedAmbiguousNamedRelation:compact": "<!-- PDF page 1 -->\n\nmax=5",
  mergedAmbiguousNamedVariable: "<!-- PDF page 1 -->\n\nmax x=5",
  "mergedAmbiguousNamedVariable:compact": "<!-- PDF page 1 -->\n\nmax x=5",
  mergedProgrammingDeclaration: "<!-- PDF page 1 -->\n\nint x=5",
  "mergedProgrammingDeclaration:compact": "<!-- PDF page 1 -->\n\nint x=5",
  mergedOperatorSubstring: "<!-- PDF page 1 -->\n\nmaximum(x)=5",
  "mergedOperatorSubstring:compact": "<!-- PDF page 1 -->\n\nmaximum(x)=5",
  mergedConfiguration: "<!-- PDF page 1 -->\n\nPATH=/tmp",
  "mergedConfiguration:compact": "<!-- PDF page 1 -->\n\nPATH=/tmp",
  loneMergedSymbol: "<!-- PDF page 1 -->\n\n∑",
  "loneMergedSymbol:compact": "<!-- PDF page 1 -->\n\n∑",
  checkmarkStatus: "<!-- PDF page 1 -->\n\nA2 ≥ 80% √",
  "checkmarkStatus:compact": "<!-- PDF page 1 -->\n\nA2 ≥ 80% √",
  genericCrossFontRelation: "<!-- PDF page 1 -->\n\nA=B",
  "genericCrossFontRelation:compact": "<!-- PDF page 1 -->\n\nA=B",
  symbolicOperatorEquation: "<!-- PDF page 1 -->\n\nκ∑",
  "symbolicOperatorEquation:compact": "<!-- PDF page 1 -->\n\nκ∑",
  proseThenEquation: "<!-- PDF page 1 -->\n\nChannel capacity\nThe capacity of a discrete noiseless channel is defined below.\n\n---\n\n<!-- PDF page 2 -->\n\nC= Lim\n\n---\n\n<!-- PDF page 3 -->\n\nThe remainder of the paper discusses the practical consequences.",
  "proseThenEquation:compact": "<!-- PDF page 1 -->\n\nChannel capacity\nThe capacity of a discrete noiseless channel is defined below.\n\n---\n\n<!-- PDF page 2 -->\n\nC= Lim\n\n---\n\n<!-- PDF page 3 -->\n\nThe remainder of the paper discusses the practical consequences.",
  ruledTable: "<!-- PDF page 1 -->\n\n| Region | Q1 | Q2 |\n| --- | --- | --- |\n| North | 1200 | 1450 |\n| South | 980 | 1020 |\n| West | 1500 | 1380 |",
  "ruledTable:compact": "<!-- PDF page 1 -->\n\n| Region | Q1 | Q2 |\n| --- | --- | --- |\n| North | 1200 | 1450 |\n| South | 980 | 1020 |\n| West | 1500 | 1380 |",
};

async function layoutFor(name) {
  const pageConfigs = CORPUS[name];
  const layout = await validatedSyntheticLayout(pageConfigs);
  pageConfigs.forEach((config, index) => {
    if (!config.ruledRects) return;
    layout.pages[index].ruled_rects = {
      status: "available",
      observed_count: config.ruledRects.length,
      returned_count: config.ruledRects.length,
      items: config.ruledRects,
    };
  });
  return layout;
}

/**
 * The document body: everything the renderer emitted before its trailing
 * declaration sections. `renderDocumentMarkdown` appends `## Conversion gaps`
 * (when any exist) and then always `## Conversion limitations`, each after a
 * blank line, so the first of those markers ends the body.
 */
function markdownBody(markdown) {
  for (const marker of ["\n\n## Conversion gaps\n", "\n\n## Conversion limitations\n"]) {
    const index = markdown.indexOf(marker);
    if (index !== -1) return markdown.slice(0, index);
  }
  throw new Error("rendered Markdown carried no trailing declaration section");
}

function codesByPage(result) {
  return result.gaps.map(gap => `${gap.page}:${gap.code}`);
}

describe("MATH_NOT_RECONSTRUCTED typed gap", () => {
  it("declares unreconstructed mathematics on the page that carries it", async () => {
    const layout = await layoutFor("proseThenEquation");
    const result = renderPdfLayoutToMarkdown(layout);

    // Page-scoped, not document-scoped: the prose pages must stay clean.
    expect(codesByPage(result)).toEqual([`2:${CODE}`]);
    expect(result.pages.map(page => page.conversion_status))
      .toEqual(["complete", "partial", "complete"]);
    expect(result.pages[1].gaps).toEqual([{
      code: CODE,
      page: 2,
      message: "Source-evidenced mathematical content was present on this page and was not reconstructed as mathematics; it remains source reading-order text.",
    }]);
    // The declaration reaches the human-readable output too.
    expect(result.markdown).toContain(`## Conversion gaps\n\n- Page 2: Source-evidenced mathematical content`);
  });

  it("declares compact runs proven by a math symbol or a cross-font relation", async () => {
    for (const name of [
      "namedOperatorEquation",
      "lowercaseOperatorEquation",
      "mergedNamedOperatorEquation",
      "mergedFunctionOperatorEquation",
      "mergedSymbolEquation",
      "mergedInlineMath",
      "relationEquation",
      "genericCrossFontRelation",
      "symbolicOperatorEquation",
    ]) {
      const result = renderPdfLayoutToMarkdown(await layoutFor(name));
      expect(codesByPage(result), name).toEqual([`1:${CODE}`]);
    }
  });

  it("declares nothing without positive evidence of mathematics", async () => {
    for (const name of [
      "prose",
      "footnoteMarker",
      "compactRunWithoutMarker",
      "namedOperatorWithoutRelation",
      "sameFontNamedRelation",
      "mergedAmbiguousNamedRelation",
      "mergedAmbiguousNamedVariable",
      "mergedProgrammingDeclaration",
      "mergedOperatorSubstring",
      "mergedConfiguration",
      "loneMergedSymbol",
      "checkmarkStatus",
      "ruledTable",
    ]) {
      const result = renderPdfLayoutToMarkdown(await layoutFor(name));
      expect(result.gaps.map(gap => gap.code), name).not.toContain(CODE);
      // `footnoteMarker` really did raise its marker; a raised run is not math.
      if (name === "footnoteMarker") expect(result.markdown).toContain("stable²");
    }
  });

  it("leaves the rendered Markdown body byte-identical for every corpus fixture", async () => {
    for (const name of Object.keys(CORPUS)) {
      const layout = await layoutFor(name);
      for (const compact of [false, true]) {
        const key = compact ? `${name}:compact` : name;
        const result = renderPdfLayoutToMarkdown(layout, {
          includePageBoundaries: true,
          compact,
        });
        expect(markdownBody(result.markdown), key).toBe(PRE_CHANGE_BODIES[key]);
      }
    }
  });

  it("emits a code the published schema and the semantic validator both accept", async () => {
    const successSchema = TOOL_OUTPUT_SCHEMAS.convert_pdf_to_markdown.anyOf[0];
    expect(successSchema.properties.gaps.items.properties.code.enum).toContain(CODE);

    const validate = new AjvJsonSchemaValidator().getValidator({
      type: "object",
      properties: {
        gaps: successSchema.properties.gaps,
        pages: successSchema.properties.pages,
      },
      required: ["gaps", "pages"],
      additionalProperties: false,
    });

    const layout = await layoutFor("proseThenEquation");
    const result = renderPdfLayoutToMarkdown(layout);
    expect(result.gaps.map(gap => gap.code)).toContain(CODE);
    expect(await validate({ gaps: result.gaps, pages: result.pages }))
      .toMatchObject({ valid: true });

    // The enum is what does the work, not the array shape.
    const forged = result.gaps.map(gap => ({ ...gap, code: "MATH_RECONSTRUCTED" }));
    expect(await validate({ gaps: forged, pages: result.pages }))
      .toMatchObject({ valid: false });

    // renderPdfLayoutToMarkdown already returns through the semantic validator,
    // whose GAP_CODES membership assertion the new code has to satisfy.
    expect(validateMarkdownConversionSemantics(result, { layout })).toBe(result);
  });

  it("renders identically across two runs", async () => {
    for (const name of Object.keys(CORPUS)) {
      const first = renderPdfLayoutToMarkdown(await layoutFor(name));
      const second = renderPdfLayoutToMarkdown(await layoutFor(name));
      expect(second.markdown, name).toBe(first.markdown);
      expect(second.markdown_sha256, name).toBe(first.markdown_sha256);
      expect(second.gaps, name).toEqual(first.gaps);
    }
  });
});
