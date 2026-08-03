#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  StandardFonts,
  rgb,
} from "pdf-lib";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIR = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "extraction",
  "intelligence",
);
const RASTER_SOURCE = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "extraction",
  "source-images",
  "raster-clean.png",
);
const RASTER_SOURCE_SHA256 = "82fa870df9c515554c9f2a22db017b94e8d2d022cef95a4b1842b99bc0538413";
const FIXED_DATE = new Date("2026-08-03T00:00:00.000Z");
const PAGE = [612, 792];

function configureMetadata(pdf, title) {
  pdf.setTitle(title);
  pdf.setAuthor("Open Document Alliance PDF Tools maintainers");
  pdf.setSubject("Synthetic extraction-intelligence evaluation fixture; contains no personal data");
  pdf.setCreator("scripts/eval-generate-extraction-intelligence-fixtures.mjs");
  pdf.setProducer("pdf-lib 1.17.1 and @napi-rs/canvas 0.1.99");
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
}

async function createTextPdf(title, draw) {
  const pdf = await PDFDocument.create();
  configureMetadata(pdf, title);
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  await draw(pdf, fonts);
  return pdf.save({
    useObjectStreams: false,
    addDefaultPage: false,
    updateFieldAppearances: false,
    objectsPerTick: Number.POSITIVE_INFINITY,
  });
}

function drawLines(page, font, lines, { x = 72, y = 700, size = 14, leading = 28 } = {}) {
  for (const [index, text] of lines.entries()) {
    page.drawText(text, {
      x,
      y: y - index * leading,
      size,
      font,
      color: rgb(0.08, 0.08, 0.08),
    });
  }
}

export const TABLE_RULED_GRID_CELLS = Object.freeze([
  ["Region", "Q1", "Q2"],
  ["North", "1200", "1450"],
  ["South", "980", "1020"],
  ["West", "1500", "1380"],
]);

async function tableRuledGrid() {
  return createTextPdf("Extraction intelligence fixture: ruled grid", async (pdf, fonts) => {
    const page = pdf.addPage(PAGE);
    const x = 72;
    const top = 680;
    const columnWidth = 150;
    const rowHeight = 48;
    const [columns, ...rows] = TABLE_RULED_GRID_CELLS;
    const totalWidth = columns.length * columnWidth;
    const totalHeight = (rows.length + 1) * rowHeight;
    // Emit explicit row/cell rectangles so the B1 IR carries the closed
    // ruling evidence that the renderer is allowed to consume. The first-row
    // full-width band is header evidence; body cells remain one-cell rects.
    page.drawRectangle({
      x,
      y: top - rowHeight,
      width: totalWidth,
      height: rowHeight,
      borderColor: rgb(0.1, 0.1, 0.1),
      borderWidth: 1,
    });
    for (let row = 1; row < rows.length + 1; row += 1) {
      for (let column = 0; column < columns.length; column += 1) {
        page.drawRectangle({
          x: x + column * columnWidth,
          y: top - (row + 1) * rowHeight,
          width: columnWidth,
          height: rowHeight,
          borderColor: rgb(0.1, 0.1, 0.1),
          borderWidth: 1,
        });
      }
    }
    for (let column = 1; column < columns.length; column += 1) {
      page.drawLine({
        start: { x: x + column * columnWidth, y: top },
        end: { x: x + column * columnWidth, y: top - totalHeight },
        thickness: 1,
      });
    }
    for (let row = 1; row < rows.length + 1; row += 1) {
      page.drawLine({
        start: { x, y: top - row * rowHeight },
        end: { x: x + totalWidth, y: top - row * rowHeight },
        thickness: 1,
      });
    }
    for (const [rowIndex, values] of [columns, ...rows].entries()) {
      values.forEach((value, columnIndex) => {
        page.drawText(value, {
          x: x + columnIndex * columnWidth + 10,
          y: top - (rowIndex + 1) * rowHeight + 17,
          size: rowIndex === 0 ? 13 : 12,
          font: rowIndex === 0 ? fonts.bold : fonts.regular,
        });
      });
    }
  });
}

async function tableRuledMergedNegative() {
  return createTextPdf("Extraction intelligence fixture: merged ruled grid", async (pdf, fonts) => {
    const page = pdf.addPage(PAGE);
    const x = 72;
    const top = 680;
    const columnWidth = 150;
    const rowHeight = 48;
    const totalWidth = 3 * columnWidth;
    const totalHeight = 4 * rowHeight;
    page.drawRectangle({
      x,
      y: top - totalHeight,
      width: totalWidth,
      height: totalHeight,
      borderColor: rgb(0.1, 0.1, 0.1),
      borderWidth: 1,
    });
    page.drawLine({
      start: { x: x + columnWidth, y: top },
      end: { x: x + columnWidth, y: top - totalHeight },
      thickness: 1,
    });
    page.drawLine({
      start: { x: x + 2 * columnWidth, y: top - rowHeight },
      end: { x: x + 2 * columnWidth, y: top - totalHeight },
      thickness: 1,
    });
    for (let row = 1; row < 4; row += 1) {
      page.drawLine({
        start: { x, y: top - row * rowHeight },
        end: { x: x + totalWidth, y: top - row * rowHeight },
        thickness: 1,
      });
    }
    const values = [
      ["Status", "Merged Q1-Q2", ""],
      ["North", "1200", "1450"],
      ["South", "980", "1020"],
      ["West", "1500", "1380"],
    ];
    values.forEach((row, rowIndex) => {
      row.forEach((value, columnIndex) => {
        if (!value) return;
        page.drawText(value, {
          x: x + columnIndex * columnWidth + 10,
          y: top - (rowIndex + 1) * rowHeight + 17,
          size: rowIndex === 0 ? 13 : 12,
          font: rowIndex === 0 ? fonts.bold : fonts.regular,
        });
      });
    });
  });
}

function addRawStream(pdf, contents) {
  const bytes = Buffer.from(contents, "latin1");
  const stream = PDFRawStream.of(
    pdf.context.obj({ Length: PDFNumber.of(bytes.length) }),
    bytes,
  );
  return pdf.context.register(stream);
}

function puaToUnicodeCMap() {
  return [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<00> <FF>",
    "endcodespacerange",
    "10 beginbfchar",
    "<41> <E000>",
    "<42> <E001>",
    "<43> <FFFD>",
    "<44> <E002>",
    "<45> <FFFD>",
    "<46> <E003>",
    "<47> <E004>",
    "<48> <E005>",
    "<49> <E006>",
    "<4A> <FFFD>",
    "endbfchar",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
    "",
  ].join("\n");
}

async function textIntegrityPua() {
  const pdf = await PDFDocument.create();
  configureMetadata(pdf, "Extraction intelligence fixture: text integrity PUA");
  const page = pdf.addPage(PAGE);
  const cmapRef = addRawStream(pdf, puaToUnicodeCMap());
  const fontRef = pdf.context.register(pdf.context.obj({
    Type: PDFName.of("Font"),
    Subtype: PDFName.of("Type1"),
    BaseFont: PDFName.of("Helvetica"),
    Encoding: PDFName.of("WinAnsiEncoding"),
    ToUnicode: cmapRef,
  }));
  const resourceFont = pdf.context.obj({ F1: fontRef });
  page.node.set(PDFName.of("Resources"), pdf.context.obj({ Font: resourceFont }));
  const encodedRun = "4142434445464748494A".repeat(6);
  page.node.set(
    PDFName.of("Contents"),
    addRawStream(pdf, `BT /F1 18 Tf 72 700 Td <${encodedRun}> Tj ET\n`),
  );
  return pdf.save({
    useObjectStreams: false,
    addDefaultPage: false,
    updateFieldAppearances: false,
    objectsPerTick: Number.POSITIVE_INFINITY,
  });
}

async function rasterBytes() {
  const bytes = await fs.readFile(RASTER_SOURCE);
  const observed = createHash("sha256").update(bytes).digest("hex");
  if (observed !== RASTER_SOURCE_SHA256) {
    throw new Error(`Raster source image differs from its fixed identity: ${RASTER_SOURCE}`);
  }
  return bytes;
}

async function routingMixed() {
  return createTextPdf("Extraction intelligence fixture: mixed routing", async (pdf, fonts) => {
    const first = pdf.addPage(PAGE);
    first.drawText("MIXED ROUTING FIXTURE", { x: 72, y: 720, size: 22, font: fonts.bold });
    drawLines(first, fonts.regular, ["Packet ID: ROUTE-77", "Page one is born digital."]);
    const second = pdf.addPage(PAGE);
    const image = await pdf.embedPng(await rasterBytes());
    second.drawImage(image, { x: 0, y: 0, width: PAGE[0], height: PAGE[1] });
  });
}

async function compactToc() {
  return createTextPdf("Extraction intelligence fixture: compact table of contents", async (pdf, fonts) => {
    const page = pdf.addPage(PAGE);
    page.drawText("CONTENTS", { x: 72, y: 742, size: 20, font: fonts.bold });
    drawLines(page, fonts.regular, [
      "Preface ... ii",
      "Chapter 1: Scope .................... 1",
      "Chapter 2: Inputs ................... 7",
      "Chapter 3: Methods ................ 12",
      "Chapter 4: Evidence ............... 19",
      "Chapter 5: Review .................. 24",
      "Chapter 6: Findings ................ 31",
      "Chapter 7: Limits .................. 38",
      "Chapter 8: Appendix ................ 44",
      "Chapter 9: Closing ................. 51",
      "Chapter 10: Index .................. 58",
      "63",
      "71",
    ], { y: 700, size: 12, leading: 28 });
  });
}

const BUILDERS = Object.freeze([
  ["table-ruled-grid.pdf", tableRuledGrid],
  ["table-ruled-merged-negative.pdf", tableRuledMergedNegative],
  ["text-integrity-pua.pdf", textIntegrityPua],
  ["routing-mixed.pdf", routingMixed],
  ["compact-toc.pdf", compactToc],
]);

export async function generateExtractionIntelligenceFixtures(outputDir = DEFAULT_OUTPUT_DIR) {
  await fs.mkdir(outputDir, { recursive: true });
  const generated = [];
  for (const [filename, builder] of BUILDERS) {
    await fs.writeFile(path.join(outputDir, filename), await builder());
    generated.push(filename);
  }
  return generated;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputFlag = process.argv.indexOf("--output-dir");
  const outputDir = outputFlag >= 0 ? path.resolve(process.argv[outputFlag + 1]) : DEFAULT_OUTPUT_DIR;
  const generated = await generateExtractionIntelligenceFixtures(outputDir);
  process.stdout.write(`${generated.map(name => path.join(outputDir, name)).join("\n")}\n`);
}
