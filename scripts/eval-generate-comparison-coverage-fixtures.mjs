#!/usr/bin/env node

/*
 * Deterministic fixtures for the compare_pdfs coverage-honesty bugs. Same
 * discipline as scripts/eval-generate-comparison-fixtures.mjs: frozen dates,
 * fixed geometry, no personal data, byte-reproducible output. These feed
 * test/compare-pdfs-coverage.test.js.
 *
 *   coverage-text-before.pdf / coverage-text-after.pdf
 *     Two clean single-page text-layer documents (a pure text change between
 *     them). Their IR extraction_status is "complete", so semantic and text
 *     coverage must stay "supported" — the control for Bug 1.
 *   coverage-nontext.pdf
 *     A single page with no text at all, only a filled rectangle. Its IR
 *     text_layer_status is "empty" and extraction_status is "partial"
 *     (vector-only, not a text-layer candidate), the scanned/image-only shape
 *     Bug 1 must degrade semantic/text coverage for.
 *   coverage-repeated-before.pdf / coverage-repeated-after.pdf
 *     Two pages of identical text, in identical documents. Every page is a
 *     repeated/template page the aligner refuses to pair, so the comparison
 *     compares nothing — Bug 2 must surface that as partial coverage rather
 *     than trivially-green "no reported changes".
 *   coverage-appearance-before.pdf / coverage-appearance-after.pdf
 *     A checkbox whose logical value (/V = Yes) is identical in both, but whose
 *     displayed appearance state (/AS) is "Yes" before and "Off" after. The two
 *     differ only in appearance_state — Bug 3 must report a form_field change.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, StandardFonts, rgb } from "pdf-lib";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIR = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "comparison",
  "coverage",
);
const FIXED_DATE = new Date("2026-07-21T00:00:00.000Z");
const PAGE_SIZE = [612, 792];

function freezeMetadata(pdf) {
  pdf.setTitle("Synthetic comparison coverage fixture");
  pdf.setAuthor("Open Document Alliance PDF Tools maintainers");
  pdf.setSubject("Synthetic PDF comparison coverage fixture; contains no personal data");
  pdf.setKeywords(["synthetic", "comparison", "coverage"]);
  pdf.setCreator("scripts/eval-generate-comparison-coverage-fixtures.mjs");
  pdf.setProducer("pdf-lib 1.17.1");
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
}

const SAVE_OPTIONS = Object.freeze({
  useObjectStreams: false,
  addDefaultPage: false,
  updateFieldAppearances: false,
  objectsPerTick: Number.POSITIVE_INFINITY,
});

async function buildTextDocument(sentence) {
  const pdf = await PDFDocument.create();
  freezeMetadata(pdf);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage(PAGE_SIZE);
  page.drawText(sentence, { x: 72, y: 700, size: 16, font, color: rgb(0.08, 0.08, 0.08) });
  return pdf.save(SAVE_OPTIONS);
}

async function buildNonTextDocument() {
  const pdf = await PDFDocument.create();
  freezeMetadata(pdf);
  // No text is drawn: only a filled rectangle, so the page has a vector paint
  // operation and no text items at all.
  const page = pdf.addPage(PAGE_SIZE);
  page.drawRectangle({ x: 120, y: 320, width: 372, height: 160, color: rgb(0.2, 0.2, 0.2) });
  return pdf.save(SAVE_OPTIONS);
}

async function buildRepeatedDocument() {
  const pdf = await PDFDocument.create();
  freezeMetadata(pdf);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 2; index += 1) {
    const page = pdf.addPage(PAGE_SIZE);
    page.drawText("Repeated template page", { x: 72, y: 700, size: 16, font, color: rgb(0.08, 0.08, 0.08) });
  }
  return pdf.save(SAVE_OPTIONS);
}

async function buildAppearanceDocument(displayedState) {
  const pdf = await PDFDocument.create();
  freezeMetadata(pdf);
  const page = pdf.addPage(PAGE_SIZE);
  const form = pdf.getForm();
  const checkbox = form.createCheckBox("Agree");
  checkbox.addToPage(page, { x: 72, y: 680, width: 24, height: 24 });
  // Logical value is checked (/V = Yes) in both documents.
  checkbox.check();
  form.updateFieldAppearances();
  // Force only the displayed appearance state (/AS) to differ between the two
  // documents, leaving /V = Yes unchanged.
  for (const widget of checkbox.acroField.getWidgets()) {
    widget.dict.set(PDFName.of("AS"), PDFName.of(displayedState));
  }
  return pdf.save({ ...SAVE_OPTIONS, updateFieldAppearances: false });
}

const VARIANTS = Object.freeze([
  ["coverage-text-before.pdf", () => buildTextDocument("Coverage sentinel alpha remains text.")],
  ["coverage-text-after.pdf", () => buildTextDocument("Coverage sentinel bravo remains text.")],
  ["coverage-nontext.pdf", () => buildNonTextDocument()],
  ["coverage-repeated-before.pdf", () => buildRepeatedDocument()],
  ["coverage-repeated-after.pdf", () => buildRepeatedDocument()],
  ["coverage-appearance-before.pdf", () => buildAppearanceDocument("Yes")],
  ["coverage-appearance-after.pdf", () => buildAppearanceDocument("Off")],
]);

export async function generateComparisonCoverageFixtures(outputDir = DEFAULT_OUTPUT_DIR) {
  await fs.mkdir(outputDir, { recursive: true });
  const generated = [];
  for (const [filename, build] of VARIANTS) {
    const bytes = await build();
    await fs.writeFile(path.join(outputDir, filename), bytes);
    generated.push(filename);
  }
  return generated;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputIndex = process.argv.indexOf("--output-dir");
  const outputDir = outputIndex >= 0
    ? path.resolve(process.argv[outputIndex + 1])
    : DEFAULT_OUTPUT_DIR;
  const generated = await generateComparisonCoverageFixtures(outputDir);
  process.stdout.write(`${generated.map(name => path.join(outputDir, name)).join("\n")}\n`);
}
