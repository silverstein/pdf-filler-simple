import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PDFDocument, degrees as pdfDegrees } from "pdf-lib";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
let TMP_DIR;

// Dynamically import the tool handler by loading the full module isn't practical
// since server/index.js starts the MCP server. Instead, we test the logic directly
// by reproducing the apply_page_plan algorithm.

async function applyPagePlan(inputPath, outputPath, plan, password) {
  const { page_order, rotations = {} } = plan;

  if (!page_order || page_order.length === 0) {
    throw new Error("plan.page_order must be a non-empty array of page numbers.");
  }

  if (inputPath === outputPath) {
    throw new Error("output_path must be different from input_path to prevent file corruption.");
  }

  const pdfBytes = await fs.readFile(inputPath);
  const pdfDoc = await PDFDocument.load(pdfBytes, password ? { password } : {});
  const totalPages = pdfDoc.getPageCount();

  const seen = new Set();
  for (const p of page_order) {
    if (p < 1 || p > totalPages) throw new Error(`Page ${p} is out of range (1-${totalPages}).`);
    if (seen.has(p)) throw new Error(`Duplicate page number in page_order: ${p}`);
    seen.add(p);
  }

  const validDegrees = [90, 180, 270];
  for (const [pageStr, deg] of Object.entries(rotations)) {
    if (!validDegrees.includes(deg)) {
      throw new Error(`Invalid rotation ${deg}° for page ${pageStr}. Must be 90, 180, or 270.`);
    }
  }

  const newDoc = await PDFDocument.create();
  const pageIndices = page_order.map(p => p - 1);
  const copiedPages = await newDoc.copyPages(pdfDoc, pageIndices);

  for (let i = 0; i < copiedPages.length; i++) {
    const page = copiedPages[i];
    const originalPageNum = page_order[i];
    const rotationDeg = rotations[String(originalPageNum)];
    if (rotationDeg) {
      const currentRotation = page.getRotation().angle;
      page.setRotation(pdfDegrees((currentRotation + rotationDeg) % 360));
    }
    newDoc.addPage(page);
  }

  const newBytes = await newDoc.save();
  try {
    await fs.writeFile(outputPath, newBytes);
  } catch (writeErr) {
    throw new Error(`Failed to save PDF: ${writeErr.message}`);
  }
  return newDoc.getPageCount();
}

describe("apply_page_plan", () => {
  let originalPageCount;

  beforeAll(async () => {
    TMP_DIR = await createTestTempDirectory(REPO_ROOT, "page-plan");
    const pdfBytes = await fs.readFile(EXAMPLE_PDF);
    const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    originalPageCount = doc.getPageCount();
  });

  afterAll(async () => {
    await removeTestTempDirectory(TMP_DIR);
  });

  it("reorders pages correctly", async () => {
    const output = path.join(TMP_DIR, "reorder.pdf");
    const order = Array.from({ length: originalPageCount }, (_, i) => originalPageCount - i);
    const count = await applyPagePlan(EXAMPLE_PDF, output, { page_order: order });
    expect(count).toBe(originalPageCount);
    const stat = await fs.stat(output);
    expect(stat.size).toBeGreaterThan(0);
  });

  it("deletes pages by omitting from page_order", async () => {
    const output = path.join(TMP_DIR, "delete.pdf");
    // Keep only page 1
    const count = await applyPagePlan(EXAMPLE_PDF, output, { page_order: [1] });
    expect(count).toBe(1);
  });

  it("rotates specified pages", async () => {
    const output = path.join(TMP_DIR, "rotate.pdf");
    const order = Array.from({ length: originalPageCount }, (_, i) => i + 1);
    const count = await applyPagePlan(EXAMPLE_PDF, output, {
      page_order: order,
      rotations: { "1": 90 },
    });
    expect(count).toBe(originalPageCount);

    // Verify rotation was applied
    const resultBytes = await fs.readFile(output);
    const resultDoc = await PDFDocument.load(resultBytes);
    const page1 = resultDoc.getPages()[0];
    expect(page1.getRotation().angle).toBe(90);
  });

  it("combines reorder + rotate + delete", async () => {
    const output = path.join(TMP_DIR, "combined.pdf");
    // Reverse first 2 pages, rotate page 1, skip remaining
    const count = await applyPagePlan(EXAMPLE_PDF, output, {
      page_order: [2, 1],
      rotations: { "1": 180 },
    });
    expect(count).toBe(2);

    const resultBytes = await fs.readFile(output);
    const resultDoc = await PDFDocument.load(resultBytes);
    // Page 1 in the original (now at position 1 in output after reorder) should be rotated
    const secondPage = resultDoc.getPages()[1]; // original page 1 is now at index 1
    expect(secondPage.getRotation().angle).toBe(180);
  });

  it("silently ignores rotations for excluded pages", async () => {
    const output = path.join(TMP_DIR, "ignore-rotation.pdf");
    // Keep only page 1, but rotate page 2 (excluded)
    const count = await applyPagePlan(EXAMPLE_PDF, output, {
      page_order: [1],
      rotations: { "2": 90 },
    });
    expect(count).toBe(1);
  });

  it("throws on empty page_order", async () => {
    const output = path.join(TMP_DIR, "empty.pdf");
    await expect(applyPagePlan(EXAMPLE_PDF, output, { page_order: [] }))
      .rejects.toThrow("non-empty array");
  });

  it("throws on invalid page number", async () => {
    const output = path.join(TMP_DIR, "invalid.pdf");
    await expect(applyPagePlan(EXAMPLE_PDF, output, { page_order: [0] }))
      .rejects.toThrow("out of range");
    await expect(applyPagePlan(EXAMPLE_PDF, output, { page_order: [999] }))
      .rejects.toThrow("out of range");
  });

  it("throws on duplicate page numbers", async () => {
    const output = path.join(TMP_DIR, "dup.pdf");
    await expect(applyPagePlan(EXAMPLE_PDF, output, { page_order: [1, 1] }))
      .rejects.toThrow("Duplicate");
  });

  it("throws on invalid rotation degrees", async () => {
    const output = path.join(TMP_DIR, "bad-rotate.pdf");
    await expect(applyPagePlan(EXAMPLE_PDF, output, {
      page_order: [1],
      rotations: { "1": 45 },
    })).rejects.toThrow("Invalid rotation");
  });

  it("throws when input equals output", async () => {
    await expect(applyPagePlan(EXAMPLE_PDF, EXAMPLE_PDF, { page_order: [1] }))
      .rejects.toThrow("must be different");
  });
});
