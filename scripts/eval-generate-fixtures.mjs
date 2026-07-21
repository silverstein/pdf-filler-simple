#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, "test", "fixtures", "eval", "synthetic");
const FIXED_DATE = new Date("2026-07-21T00:00:00.000Z");

function configureMetadata(pdf, title) {
  pdf.setTitle(title);
  pdf.setAuthor("Open Document Alliance PDF Tools maintainers");
  pdf.setSubject("Synthetic evaluation fixture; contains no personal data");
  pdf.setCreator("scripts/eval-generate-fixtures.mjs");
  pdf.setProducer("pdf-lib 1.17.1");
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
}

async function createPageOrderSource() {
  const pdf = await PDFDocument.create();
  configureMetadata(pdf, "Development page-order source");
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);

  const first = pdf.addPage([360, 480]);
  first.setCropBox(12, 18, 330, 444);
  first.drawRectangle({
    x: 36,
    y: 300,
    width: 288,
    height: 96,
    borderWidth: 4,
    borderColor: rgb(0.1, 0.3, 0.8),
  });
  first.drawText("PAGE ONE - PORTRAIT", {
    x: 55,
    y: 340,
    size: 20,
    font,
    color: rgb(0.1, 0.2, 0.6),
  });

  const second = pdf.addPage([480, 360]);
  second.setCropBox(20, 24, 430, 300);
  second.setRotation(degrees(90));
  second.drawRectangle({
    x: 42,
    y: 164,
    width: 390,
    height: 110,
    borderWidth: 4,
    borderColor: rgb(0.75, 0.15, 0.1),
  });
  second.drawText("PAGE TWO - ROTATED", {
    x: 72,
    y: 210,
    size: 24,
    font,
    color: rgb(0.65, 0.1, 0.08),
  });

  return pdf.save({ useObjectStreams: false });
}

async function createWrongPageOrder(sourceBytes) {
  const source = await PDFDocument.load(sourceBytes);
  const pdf = await PDFDocument.create();
  configureMetadata(pdf, "Regression candidate with visibly swapped pages");
  const [second, first] = await pdf.copyPages(source, [1, 0]);
  pdf.addPage(second);
  pdf.addPage(first);
  return pdf.save({ useObjectStreams: false });
}

async function createHeldOutGeometry() {
  const pdf = await PDFDocument.create();
  configureMetadata(pdf, "Held-out release geometry source");
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([420, 594]);
  page.setCropBox(18, 24, 384, 546);
  page.setRotation(degrees(270));
  page.drawRectangle({
    x: 48,
    y: 120,
    width: 324,
    height: 330,
    borderWidth: 6,
    borderColor: rgb(0.1, 0.55, 0.25),
  });
  page.drawText("HELD-OUT RELEASE GEOMETRY", {
    x: 62,
    y: 280,
    size: 16,
    font,
    color: rgb(0.05, 0.35, 0.15),
  });
  return pdf.save({ useObjectStreams: false });
}

export async function generateFixtures(outputDir = DEFAULT_OUTPUT_DIR) {
  await fs.mkdir(outputDir, { recursive: true });
  const source = await createPageOrderSource();
  const fixtures = new Map([
    ["dev-page-order-source.pdf", source],
    ["dev-page-order-visibly-wrong.pdf", await createWrongPageOrder(source)],
    ["release-geometry-source.pdf", await createHeldOutGeometry()],
  ]);

  for (const [filename, bytes] of fixtures) {
    await fs.writeFile(path.join(outputDir, filename), bytes);
  }
  return [...fixtures.keys()];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputFlag = process.argv.indexOf("--output-dir");
  const outputDir = outputFlag >= 0
    ? path.resolve(process.argv[outputFlag + 1])
    : DEFAULT_OUTPUT_DIR;
  const generated = await generateFixtures(outputDir);
  process.stdout.write(`${generated.map(name => path.join(outputDir, name)).join("\n")}\n`);
}
