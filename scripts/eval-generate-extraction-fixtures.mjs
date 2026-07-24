#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, "test", "fixtures", "eval", "extraction", "synthetic");
const RASTER_SOURCE_DIR = path.join(REPO_ROOT, "test", "fixtures", "eval", "extraction", "source-images");
const FIXED_DATE = new Date("2026-07-22T00:00:00.000Z");
const PAGE = [612, 792];
const RASTER_SOURCES = Object.freeze({
  clean: {
    filename: "raster-clean.png",
    sha256: "82fa870df9c515554c9f2a22db017b94e8d2d022cef95a4b1842b99bc0538413",
  },
  degraded: {
    filename: "raster-degraded.png",
    sha256: "f0a79f7ee2b009f85b10b28582dad6258bb0544055bb99c7377f71ce34aec4d1",
  },
});

function configureMetadata(pdf, title) {
  pdf.setTitle(title);
  pdf.setAuthor("Open Document Alliance PDF Tools maintainers");
  pdf.setSubject("Synthetic structured extraction evaluation fixture; contains no personal data");
  pdf.setCreator("scripts/eval-generate-extraction-fixtures.mjs");
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
    page.drawText(text, { x, y: y - index * leading, size, font, color: rgb(0.08, 0.08, 0.08) });
  }
}

async function flatInvoice() {
  return createTextPdf("Extraction fixture: flat invoice", async (pdf, fonts) => {
    const page = pdf.addPage(PAGE);
    page.drawText("SYNTHETIC INVOICE", { x: 72, y: 720, size: 22, font: fonts.bold });
    drawLines(page, fonts.regular, [
      "Invoice ID: INV-1001",
      "Vendor: Northwind Paper",
      "Invoice date: 2026-07-15",
      "Total: USD 42.50",
    ]);
  });
}

async function nestedProfile() {
  return createTextPdf("Extraction fixture: nested profile", async (pdf, fonts) => {
    const page = pdf.addPage(PAGE);
    page.drawText("SYNTHETIC CUSTOMER RECORD", { x: 72, y: 720, size: 20, font: fonts.bold });
    drawLines(page, fonts.regular, [
      "Customer ID: C-204",
      "Organization: Alpine Works",
      "Street: 77 Cedar Avenue",
      "City: Portland",
      "Region: OR",
      "Postal code: 97205",
      "Tags: renewal, priority",
      "Active: yes",
    ]);
  });
}

async function twoColumnOrder() {
  return createTextPdf("Extraction fixture: two column reading order", async (pdf, fonts) => {
    const page = pdf.addPage(PAGE);
    page.drawText("TWO COLUMN NOTICE", { x: 72, y: 730, size: 20, font: fonts.bold });
    page.drawText("LEFT-1 Coverage begins July 1.", { x: 72, y: 670, size: 13, font: fonts.regular });
    page.drawText("LEFT-2 Claims close July 31.", { x: 72, y: 630, size: 13, font: fonts.regular });
    page.drawText("RIGHT-1 Review starts August 2.", { x: 326, y: 670, size: 13, font: fonts.regular });
    page.drawText("RIGHT-2 Decision follows review.", { x: 326, y: 630, size: 13, font: fonts.regular });
    page.drawLine({ start: { x: 306, y: 600 }, end: { x: 306, y: 700 }, thickness: 1 });
  });
}

async function mergedBlankTable() {
  return createTextPdf("Extraction fixture: merged and blank table cells", async (pdf, fonts) => {
    const page = pdf.addPage(PAGE);
    const x = 72;
    const top = 690;
    const widths = [260, 90, 120];
    const rowHeight = 42;
    const totalWidth = widths.reduce((sum, value) => sum + value, 0);
    for (let row = 0; row <= 4; row++) {
      page.drawLine({ start: { x, y: top - row * rowHeight }, end: { x: x + totalWidth, y: top - row * rowHeight }, thickness: 1 });
    }
    page.drawLine({ start: { x, y: top }, end: { x, y: top - 4 * rowHeight }, thickness: 1 });
    page.drawLine({ start: { x: x + totalWidth, y: top }, end: { x: x + totalWidth, y: top - 4 * rowHeight }, thickness: 1 });
    for (const columnX of [x + widths[0], x + widths[0] + widths[1]]) {
      page.drawLine({ start: { x: columnX, y: top - rowHeight }, end: { x: columnX, y: top - 4 * rowHeight }, thickness: 1 });
    }
    page.drawText("Q3 PURCHASES", { x: 230, y: top - 28, size: 16, font: fonts.bold });
    const rows = [
      ["Item", "Qty", "Amount"],
      ["Paper", "2", "USD 20.00"],
      ["Delivery", "", "USD 5.00"],
    ];
    for (const [rowIndex, values] of rows.entries()) {
      let cellX = x;
      for (const [columnIndex, value] of values.entries()) {
        if (value) page.drawText(value, { x: cellX + 8, y: top - (rowIndex + 2) * rowHeight + 15, size: 12, font: rowIndex === 0 ? fonts.bold : fonts.regular });
        cellX += widths[columnIndex];
      }
    }
  });
}

async function rasterTruthPng({ degraded = false } = {}) {
  const source = RASTER_SOURCES[degraded ? "degraded" : "clean"];
  const bytes = await fs.readFile(path.join(RASTER_SOURCE_DIR, source.filename));
  const observed = createHash("sha256").update(bytes).digest("hex");
  if (observed !== source.sha256) {
    throw new Error(`Raster source image differs from its fixed identity: ${source.filename}`);
  }
  return bytes;
}

async function rasterReceipt(degraded) {
  return createTextPdf(`Extraction fixture: ${degraded ? "degraded" : "clean"} raster receipt`, async (pdf) => {
    const page = pdf.addPage(PAGE);
    const image = await pdf.embedPng(await rasterTruthPng({ degraded }));
    page.drawImage(image, { x: 0, y: 0, width: PAGE[0], height: PAGE[1] });
  });
}

async function mixedDocument() {
  return createTextPdf("Extraction fixture: mixed text and raster pages", async (pdf, fonts) => {
    const first = pdf.addPage(PAGE);
    first.drawText("MIXED DOCUMENT", { x: 72, y: 720, size: 22, font: fonts.bold });
    drawLines(first, fonts.regular, ["Packet ID: MIX-77", "Page one is born digital."]);
    const second = pdf.addPage(PAGE);
    const image = await pdf.embedPng(await rasterTruthPng());
    second.drawImage(image, { x: 0, y: 0, width: PAGE[0], height: PAGE[1] });
  });
}

async function contradiction() {
  return createTextPdf("Extraction fixture: contradictory and absent answer", async (pdf, fonts) => {
    const page = pdf.addPage(PAGE);
    page.drawText("SYNTHETIC REVIEW LOG", { x: 72, y: 720, size: 22, font: fonts.bold });
    drawLines(page, fonts.regular, [
      "Reviewer A status: APPROVED",
      "Reviewer B status: REJECTED",
      "Final status: not recorded",
      "Final settlement amount: not provided",
    ]);
  });
}

const BUILDERS = Object.freeze([
  ["born-digital-flat.pdf", flatInvoice],
  ["born-digital-nested.pdf", nestedProfile],
  ["two-column-order.pdf", twoColumnOrder],
  ["table-merged-blank.pdf", mergedBlankTable],
  ["raster-clean.pdf", () => rasterReceipt(false)],
  ["raster-degraded.pdf", () => rasterReceipt(true)],
  ["mixed-text-raster.pdf", mixedDocument],
  ["no-answer-contradiction.pdf", contradiction],
]);

export async function generateExtractionFixtures(outputDir = DEFAULT_OUTPUT_DIR) {
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
  const generated = await generateExtractionFixtures(outputDir);
  process.stdout.write(`${generated.map(name => path.join(outputDir, name)).join("\n")}\n`);
}
