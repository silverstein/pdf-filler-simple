#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, "test", "fixtures", "golden-forms");
const FIXED_DATE = new Date("2026-07-21T00:00:00.000Z");

async function createRotatedSignatureFixture() {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Rotated and cropped signature-zone fixture");
  pdf.setAuthor("Open Document Alliance PDF Tools maintainers");
  pdf.setSubject("Synthetic golden fixture; contains no personal data");
  pdf.setCreator("scripts/generate-golden-fixtures.mjs");
  pdf.setProducer("pdf-lib 1.17.1");
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([480, 360]);
  page.setCropBox(20, 24, 430, 300);
  page.setRotation(degrees(90));
  page.drawLine({
    start: { x: 72, y: 170 },
    end: { x: 332, y: 170 },
    thickness: 1,
    color: rgb(0, 0, 0),
  });
  page.drawText("Signature", {
    x: 72,
    y: 150,
    size: 12,
    font,
    color: rgb(0, 0, 0),
  });

  return pdf.save({ useObjectStreams: false });
}

export async function generateGoldenFixtures(outputDir = DEFAULT_OUTPUT_DIR) {
  await fs.mkdir(outputDir, { recursive: true });
  const fixtures = new Map([
    ["rotated-signature.pdf", await createRotatedSignatureFixture()],
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
  const generated = await generateGoldenFixtures(outputDir);
  process.stdout.write(`${generated.map(name => path.join(outputDir, name)).join("\n")}\n`);
}
