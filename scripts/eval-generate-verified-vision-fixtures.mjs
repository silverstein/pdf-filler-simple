#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { generateExtractionIntelligenceFixtures } from "./eval-generate-extraction-intelligence-fixtures.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, "test", "fixtures", "eval", "verified-vision");
const FIXED_DATE = new Date("2026-08-11T00:00:00.000Z");
const PAGE = [612, 792];

export const VERIFIED_VISION_FIXTURE_FILES = Object.freeze([
  "table-ruled-lines.pdf",
  "table-ruled-merged-negative.pdf",
  "table-borderless-ambiguous.pdf",
]);

export const BORDERLESS_AMBIGUOUS_ROWS = Object.freeze([
  ["Alpha", "Beta", "Gamma"],
  ["10", "20", "30"],
  ["40", "50", "60"],
  ["70", "80", "90"],
]);

async function createBorderlessAmbiguousPdf() {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Verified vision fixture: borderless ambiguous table-like region");
  pdf.setAuthor("Open Document Alliance PDF Tools maintainers");
  pdf.setSubject("Synthetic verified-vision evaluation fixture; contains no personal data");
  pdf.setCreator("scripts/eval-generate-verified-vision-fixtures.mjs");
  pdf.setProducer("pdf-lib 1.17.1");
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);

  const page = pdf.addPage(PAGE);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const [rowIndex, row] of BORDERLESS_AMBIGUOUS_ROWS.entries()) {
    for (const [columnIndex, text] of row.entries()) {
      page.drawText(text, {
        x: 82 + columnIndex * 150,
        y: 632 - rowIndex * 48,
        size: 12,
        font,
        color: rgb(0.08, 0.08, 0.08),
      });
    }
  }

  return pdf.save({
    useObjectStreams: false,
    addDefaultPage: false,
    updateFieldAppearances: false,
    objectsPerTick: Number.POSITIVE_INFINITY,
  });
}

export async function generateVerifiedVisionFixtures(outputDir = DEFAULT_OUTPUT_DIR) {
  await fs.mkdir(outputDir, { recursive: true });
  const intelligenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-verified-vision-source-"));
  try {
    await generateExtractionIntelligenceFixtures(intelligenceRoot);
    for (const filename of VERIFIED_VISION_FIXTURE_FILES.slice(0, 2)) {
      await fs.copyFile(path.join(intelligenceRoot, filename), path.join(outputDir, filename));
    }
    await fs.writeFile(
      path.join(outputDir, VERIFIED_VISION_FIXTURE_FILES[2]),
      await createBorderlessAmbiguousPdf(),
    );
    await Promise.all(VERIFIED_VISION_FIXTURE_FILES.map(
      filename => fs.chmod(path.join(outputDir, filename), 0o644),
    ));
  } finally {
    await fs.rm(intelligenceRoot, { recursive: true, force: true });
  }
  return [...VERIFIED_VISION_FIXTURE_FILES];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputFlag = process.argv.indexOf("--output-dir");
  const outputDir = outputFlag >= 0 ? path.resolve(process.argv[outputFlag + 1]) : DEFAULT_OUTPUT_DIR;
  const generated = await generateVerifiedVisionFixtures(outputDir);
  process.stdout.write(`${generated.map(name => path.join(outputDir, name)).join("\n")}\n`);
}
