#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PDFDocument,
  PDFName,
  PDFString,
  StandardFonts,
  rgb,
} from "pdf-lib";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIR = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "comparison",
  "synthetic"
);
const FIXED_DATE = new Date("2026-07-21T00:00:00.000Z");
const PAGE_SIZE = [612, 792];

const VARIANTS = Object.freeze([
  ["comparison-base.pdf", "base"],
  ["comparison-material-text-after.pdf", "material_text"],
  ["comparison-visual-status-after.pdf", "visual_status"],
  ["comparison-layout-noise-after.pdf", "layout_noise"],
  ["comparison-metadata-only-after.pdf", "metadata_only"],
  ["comparison-pages-reordered-after.pdf", "pages_reordered"],
  ["comparison-form-annotation-after.pdf", "form_annotation"],
]);

function configureMetadata(pdf, variant) {
  const metadataOnly = variant === "metadata_only";
  pdf.setTitle(metadataOnly ? "Synthetic comparison agreement — reviewed" : "Synthetic comparison agreement");
  pdf.setAuthor("Open Document Alliance PDF Tools maintainers");
  pdf.setSubject("Synthetic PDF comparison evaluation fixture; contains no personal data");
  pdf.setKeywords(["synthetic", "comparison"]);
  pdf.setCreator("scripts/eval-generate-comparison-fixtures.mjs");
  pdf.setProducer("pdf-lib 1.17.1");
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(metadataOnly
    ? new Date("2026-07-22T00:00:00.000Z")
    : FIXED_DATE);
}

function drawServicePage(page, { bodyFont, headingFont, variant }) {
  const layoutNoise = variant === "layout_noise";
  const materialText = variant === "material_text";
  const visualStatus = variant === "visual_status";
  const dx = layoutNoise ? 0.75 : 0;
  const headingSize = layoutNoise ? 20.25 : 20;

  page.drawText("SERVICE AGREEMENT", {
    x: 72 + dx,
    y: 700,
    size: headingSize,
    font: headingFont,
    color: rgb(0.08, 0.16, 0.32),
  });
  page.drawText(materialText ? "Monthly fee: USD 12,500" : "Monthly fee: USD 10,000", {
    x: 72 + dx,
    y: 650,
    size: 14,
    font: bodyFont,
    color: rgb(0.08, 0.08, 0.08),
  });
  page.drawText(materialText ? "Termination notice: 15 days" : "Termination notice: 30 days", {
    x: 72 + dx,
    y: 620,
    size: 14,
    font: bodyFont,
    color: rgb(0.08, 0.08, 0.08),
  });
  page.drawText("Status indicator", {
    x: 72 + dx,
    y: 570,
    size: 12,
    font: bodyFont,
    color: rgb(0.12, 0.12, 0.12),
  });
  page.drawRectangle({
    x: 72,
    y: 520,
    width: 140,
    height: 36,
    color: visualStatus ? rgb(0.78, 0.12, 0.12) : rgb(0.12, 0.62, 0.28),
    borderColor: rgb(0.05, 0.05, 0.05),
    borderWidth: 1,
  });
  page.drawText("ACTIVE", {
    x: 116,
    y: 532,
    size: 12,
    font: headingFont,
    color: rgb(1, 1, 1),
  });
  page.drawText("Review status", {
    x: 72 + dx,
    y: 475,
    size: 12,
    font: bodyFont,
    color: rgb(0.12, 0.12, 0.12),
  });
  page.drawText("PAGE-ID: SERVICE", {
    x: 72,
    y: 54,
    size: 9,
    font: bodyFont,
    color: rgb(0.35, 0.35, 0.35),
  });
}

function drawAppendixPage(page, { bodyFont, headingFont, variant }) {
  const dx = variant === "layout_noise" ? 0.75 : 0;
  page.drawText("APPENDIX A", {
    x: 72 + dx,
    y: 700,
    size: variant === "layout_noise" ? 20.25 : 20,
    font: headingFont,
    color: rgb(0.08, 0.16, 0.32),
  });
  page.drawText("Support coverage: Business days", {
    x: 72 + dx,
    y: 650,
    size: 14,
    font: bodyFont,
    color: rgb(0.08, 0.08, 0.08),
  });
  page.drawText("Escalation window: Four hours", {
    x: 72 + dx,
    y: 620,
    size: 14,
    font: bodyFont,
    color: rgb(0.08, 0.08, 0.08),
  });
  page.drawText("PAGE-ID: APPENDIX", {
    x: 72,
    y: 54,
    size: 9,
    font: bodyFont,
    color: rgb(0.35, 0.35, 0.35),
  });
}

function addSyntheticComment(pdf, page) {
  const annotation = pdf.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Text"),
    Rect: [360, 430, 390, 460],
    Contents: PDFString.of("Synthetic reviewer note: verify status."),
    T: PDFString.of("Synthetic Reviewer"),
    Name: PDFName.of("Comment"),
    C: [1, 0.82, 0.16],
    F: 4,
    P: page.ref,
  });
  page.node.addAnnot(pdf.context.register(annotation));
}

async function buildDocument(variant) {
  const pdf = await PDFDocument.create();
  configureMetadata(pdf, variant);
  const baseBodyFont = await pdf.embedFont(StandardFonts.Helvetica);
  const bodyFont = variant === "layout_noise"
    ? await pdf.embedFont(StandardFonts.HelveticaOblique)
    : baseBodyFont;
  const headingFont = await pdf.embedFont(StandardFonts.HelveticaBold);
  const roles = variant === "pages_reordered"
    ? ["appendix", "service"]
    : ["service", "appendix"];
  let servicePage;

  for (const role of roles) {
    const page = pdf.addPage(PAGE_SIZE);
    if (role === "service") {
      servicePage = page;
      drawServicePage(page, { bodyFont, headingFont, variant });
    } else {
      drawAppendixPage(page, { bodyFont: baseBodyFont, headingFont, variant: "base" });
    }
  }

  const form = pdf.getForm();
  const reviewStatus = form.createTextField("ReviewStatus");
  reviewStatus.addToPage(servicePage, {
    x: 72,
    y: 430,
    width: 220,
    height: 30,
    font: bodyFont,
    textColor: rgb(0.05, 0.05, 0.05),
    backgroundColor: rgb(0.97, 0.97, 0.97),
    borderColor: rgb(0.25, 0.25, 0.25),
    borderWidth: 1,
  });
  if (variant === "form_annotation") {
    reviewStatus.setText("Approved");
    addSyntheticComment(pdf, servicePage);
  }
  form.updateFieldAppearances(bodyFont);

  return pdf.save({
    useObjectStreams: false,
    addDefaultPage: false,
    updateFieldAppearances: false,
    objectsPerTick: Number.POSITIVE_INFINITY,
  });
}

export async function generateComparisonFixtures(outputDir = DEFAULT_OUTPUT_DIR) {
  await fs.mkdir(outputDir, { recursive: true });
  const generated = [];
  for (const [filename, variant] of VARIANTS) {
    const bytes = await buildDocument(variant);
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
  const generated = await generateComparisonFixtures(outputDir);
  process.stdout.write(`${generated.map(name => path.join(outputDir, name)).join("\n")}\n`);
}
