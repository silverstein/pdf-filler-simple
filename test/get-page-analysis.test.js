import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PDFDocument, degrees } from "pdf-lib";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { getPageDisplayMetrics } from "../server/helpers.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
let TMP_DIR;

// Reproduce the get_page_analysis logic for testing
// Uses pdf-lib for dimensions (fast) — pdfjs-dist text extraction tested separately
async function getPageAnalysis(inputPath, password) {
  const pdfBytes = await fs.readFile(inputPath);
  const pdfDoc = await PDFDocument.load(pdfBytes, password ? { password } : { ignoreEncryption: true });
  const pages = pdfDoc.getPages();

  const pageMeta = pages.map((page, i) => {
    const { width, height } = page.getSize();
    const metrics = getPageDisplayMetrics({ width, height, rotation: page.getRotation().angle });
    return {
      page: i + 1,
      width: metrics.width,
      height: metrics.height,
      display_width: metrics.display_width,
      display_height: metrics.display_height,
      rotation: metrics.rotation,
      orientation: metrics.orientation,
    };
  });

  const orientationCounts = { portrait: 0, landscape: 0 };
  for (const p of pageMeta) orientationCounts[p.orientation]++;
  const majorityOrientation = orientationCounts.portrait >= orientationCounts.landscape ? "portrait" : "landscape";

  return { total_pages: pages.length, majority_orientation: majorityOrientation, pages: pageMeta };
}

describe("get_page_analysis", () => {
  let result;

  beforeAll(async () => {
    TMP_DIR = await createTestTempDirectory(REPO_ROOT, "analysis");
    result = await getPageAnalysis(EXAMPLE_PDF);
  });

  afterAll(async () => {
    await removeTestTempDirectory(TMP_DIR);
  });

  it("returns correct total page count", () => {
    expect(result.total_pages).toBeGreaterThan(0);
  });

  it("returns per-page dimensions", () => {
    for (const page of result.pages) {
      expect(page.width).toBeGreaterThan(0);
      expect(page.height).toBeGreaterThan(0);
      expect(page.page).toBeGreaterThanOrEqual(1);
    }
  });

  it("detects orientation correctly", () => {
    for (const page of result.pages) {
      if (page.display_width > page.display_height) {
        expect(page.orientation).toBe("landscape");
      } else {
        expect(page.orientation).toBe("portrait");
      }
    }
  });

  it("determines majority orientation", () => {
    expect(["portrait", "landscape"]).toContain(result.majority_orientation);
  });

  it("page numbers are 1-indexed and sequential", () => {
    result.pages.forEach((p, i) => {
      expect(p.page).toBe(i + 1);
    });
  });

  it("example-fw9.pdf is portrait (standard letter size)", () => {
    // W-9 form is US letter: 612 x 792 points
    const page1 = result.pages[0];
    expect(page1.orientation).toBe("portrait");
    expect(page1.width).toBeLessThan(page1.height);
  });

  it("treats a 90-degree rotated portrait page as landscape for display", async () => {
    const rotatedPath = path.join(TMP_DIR, "rotated-analysis.pdf");
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const rotatedPage = doc.addPage([612, 792]);
    rotatedPage.setRotation(degrees(90));
    await fs.writeFile(rotatedPath, await doc.save());

    const rotatedResult = await getPageAnalysis(rotatedPath);
    expect(rotatedResult.pages[1].rotation).toBe(90);
    expect(rotatedResult.pages[1].orientation).toBe("landscape");
    expect(rotatedResult.pages[1].display_width).toBeGreaterThan(rotatedResult.pages[1].display_height);
  });
});
