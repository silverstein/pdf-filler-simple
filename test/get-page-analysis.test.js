import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PDFDocument, degrees } from "pdf-lib";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  PAGE_ANALYSIS_RETRY_GUIDANCE,
  PAGE_ANALYSIS_MUTATION_GUIDANCE,
  analyzePdfPages,
  getPageDisplayMetrics,
} from "../server/helpers.js";
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

function fakePdfLibPages(count) {
  return Array.from({ length: count }, () => ({
    getSize: () => ({ width: 612, height: 792 }),
    getRotation: () => ({ angle: 0 }),
  }));
}

function fakePdfjs(pageBehaviors, { documentFailure = false } = {}) {
  const OPS = {
    paintImageXObject: 1,
    paintJpegXObject: 2,
    paintImageMaskXObject: 3,
    fill: 4,
  };
  const document = {
    async getPage(pageNumber) {
      const behavior = pageBehaviors[pageNumber - 1] ?? {};
      if (behavior.pageFailure) throw new Error("forced page load failure");
      return {
        async getTextContent() {
          if (behavior.textFailure) throw new Error("forced text failure");
          return { items: [{ str: behavior.text ?? "" }] };
        },
        async getOperatorList() {
          if (behavior.imageFailure) throw new Error("forced image failure");
          return {
            fnArray: [
              ...(behavior.hasImages ? [OPS.paintImageXObject] : []),
              ...(behavior.hasGraphics ? [OPS.fill] : []),
            ],
          };
        },
      };
    },
    async destroy() {},
  };
  return {
    OPS,
    getDocument() {
      return {
        promise: documentFailure
          ? Promise.reject(new Error("forced document load failure"))
          : Promise.resolve(document),
      };
    },
  };
}

describe("get_page_analysis content provenance", () => {
  it("makes a whole-document PDF.js failure explicitly unavailable, never blank", async () => {
    const result = await analyzePdfPages({
      pdfLibPages: fakePdfLibPages(2),
      pdfBytes: new Uint8Array([1]),
      pdfjsLib: fakePdfjs([], { documentFailure: true }),
    });

    expect(result).toMatchObject({
      content_analysis_status: "degraded",
      content_analysis_complete: false,
      likely_blank_pages: [],
      unknown_pages: [1, 2],
      retry_guidance: PAGE_ANALYSIS_RETRY_GUIDANCE,
      mutation_guidance: PAGE_ANALYSIS_MUTATION_GUIDANCE,
      analysis_errors: [{ scope: "document", code: "PDFJS_DOCUMENT_LOAD_FAILED" }],
    });
    for (const page of result.pages) {
      expect(page).toMatchObject({
        text_length: null,
        text_snippet: null,
        has_images: null,
        has_graphics: null,
        content_analysis_status: "unavailable",
        blank_status: "unknown",
      });
      expect(page.analysis_error_codes).toEqual(["PDFJS_DOCUMENT_LOAD_FAILED"]);
    }
  });

  it("keeps successful and positive partial evidence while isolating unknown pages", async () => {
    const result = await analyzePdfPages({
      pdfLibPages: fakePdfLibPages(6),
      pdfBytes: new Uint8Array([1]),
      pdfjsLib: fakePdfjs([
        { text: "", hasImages: false },
        { text: "Revenue", imageFailure: true },
        { textFailure: true, hasImages: false },
        { textFailure: true, hasImages: true },
        { textFailure: true, hasGraphics: true },
        { pageFailure: true },
      ]),
    });

    expect(result).toMatchObject({
      content_analysis_status: "degraded",
      content_analysis_complete: false,
      likely_blank_pages: [1],
      nonblank_pages: [2, 4, 5],
      unknown_pages: [3, 6],
      retry_guidance: PAGE_ANALYSIS_RETRY_GUIDANCE,
    });
    expect(result.pages[0]).toMatchObject({
      content_analysis_status: "complete",
      text_length: 0,
      has_images: false,
      has_graphics: false,
      blank_status: "likely_blank",
    });
    expect(result.pages[1]).toMatchObject({
      content_analysis_status: "degraded",
      text_length: 7,
      has_images: null,
      has_graphics: null,
      blank_status: "not_blank",
      analysis_error_codes: ["PDFJS_OPERATOR_ANALYSIS_FAILED"],
    });
    expect(result.pages[2]).toMatchObject({
      content_analysis_status: "degraded",
      text_length: null,
      has_images: false,
      has_graphics: false,
      blank_status: "unknown",
      analysis_error_codes: ["PDFJS_TEXT_EXTRACTION_FAILED"],
    });
    expect(result.pages[3]).toMatchObject({
      content_analysis_status: "degraded",
      text_length: null,
      has_images: true,
      has_graphics: false,
      blank_status: "not_blank",
    });
    expect(result.pages[4]).toMatchObject({
      content_analysis_status: "degraded",
      text_length: null,
      has_images: false,
      has_graphics: true,
      blank_status: "not_blank",
    });
    expect(result.pages[5]).toMatchObject({
      content_analysis_status: "unavailable",
      text_length: null,
      has_images: null,
      has_graphics: null,
      blank_status: "unknown",
      analysis_error_codes: ["PDFJS_PAGE_LOAD_FAILED"],
    });
  });

  it("marks pages beyond the analysis cap unknown instead of blank", async () => {
    const result = await analyzePdfPages({
      pdfLibPages: fakePdfLibPages(2),
      pdfBytes: new Uint8Array([1]),
      pdfjsLib: fakePdfjs([{ text: "", hasImages: false }]),
      maxPages: 1,
    });

    expect(result).toMatchObject({
      content_analysis_status: "partial",
      likely_blank_pages: [1],
      unknown_pages: [2],
      retry_guidance: PAGE_ANALYSIS_RETRY_GUIDANCE,
    });
    expect(result.pages[1]).toMatchObject({
      content_analysis_status: "not_analyzed",
      text_length: null,
      has_images: null,
      has_graphics: null,
      blank_status: "unknown",
    });
  });
});
