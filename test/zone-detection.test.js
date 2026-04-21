import { describe, it, expect, beforeAll } from "vitest";
import { PDFDocument } from "pdf-lib";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  computeIoU,
  extractPdfTextWithBounds,
  detectSignatureZones,
} from "../server/helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_PDF = path.join(__dirname, "..", "example-fw9.pdf");

// Polyfills for pdfjs-dist v5 (match server/index.js init)
if (typeof globalThis.DOMMatrix === "undefined") {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor(init) {
      const v = Array.isArray(init) ? init : [1, 0, 0, 1, 0, 0];
      this.a = v[0]; this.b = v[1]; this.c = v[2];
      this.d = v[3]; this.e = v[4]; this.f = v[5];
      this.is2D = true; this.isIdentity = v[0] === 1 && v[1] === 0 && v[2] === 0 && v[3] === 1 && v[4] === 0 && v[5] === 0;
    }
    multiplySelf() { return this; } preMultiplySelf() { return this; } translateSelf() { return this; }
    scaleSelf() { return this; } rotateSelf() { return this; } invertSelf() { return this; }
    static fromMatrix(m) { return new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]); }
    static fromFloat32Array(a) { return new DOMMatrix(Array.from(a)); }
    static fromFloat64Array(a) { return new DOMMatrix(Array.from(a)); }
  };
}
if (typeof globalThis.Path2D === "undefined") {
  globalThis.Path2D = class Path2D { constructor() {} addPath() {} closePath() {} moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} arcTo() {} ellipse() {} rect() {} };
}
if (typeof globalThis.ImageData === "undefined") {
  globalThis.ImageData = class ImageData { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } };
}

async function loadPdfjsForTest() {
  const mod = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const lib = mod.default || mod;
  lib.GlobalWorkerOptions.workerSrc = new URL(
    "../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    import.meta.url
  ).href;
  lib.GlobalWorkerOptions.isEvalSupported = false;
  return lib;
}

describe("computeIoU", () => {
  it("returns 1.0 for identical rects", () => {
    const a = { x: 10, y: 10, width: 100, height: 50 };
    expect(computeIoU(a, a)).toBe(1);
  });
  it("returns 0 for non-overlapping rects", () => {
    expect(computeIoU(
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 100, y: 100, width: 10, height: 10 }
    )).toBe(0);
  });
  it("returns 0 for touching-only rects (edge contact)", () => {
    expect(computeIoU(
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 10, y: 0, width: 10, height: 10 }
    )).toBe(0);
  });
  it("computes 1/3 for two 10x10 rects offset by 5 on one axis", () => {
    // intersection 5*10=50, areaA=100, areaB=100, union=100+100-50=150, IoU=50/150=1/3
    const iou = computeIoU(
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 5, y: 0, width: 10, height: 10 }
    );
    expect(iou).toBeCloseTo(1/3, 6);
  });
  it("handles one rect fully inside another", () => {
    // A is 100x100, B is 10x10 inside A. Intersection=100, union=10000+100-100=10000. IoU=0.01
    const iou = computeIoU(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 10, y: 10, width: 10, height: 10 }
    );
    expect(iou).toBeCloseTo(0.01, 6);
  });
});

describe("extractPdfTextWithBounds", () => {
  let pdfjsLib;
  let pdfBytes;

  beforeAll(async () => {
    pdfjsLib = await loadPdfjsForTest();
    pdfBytes = await fs.readFile(EXAMPLE_PDF);
  }, 20_000);

  it("returns one page object per PDF page", async () => {
    const pages = await extractPdfTextWithBounds(pdfjsLib, pdfBytes);
    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0]).toHaveProperty("items");
    expect(pages[0]).toHaveProperty("width");
    expect(pages[0]).toHaveProperty("height");
    expect(pages[0].width).toBeGreaterThan(0);
    expect(pages[0].height).toBeGreaterThan(0);
  });

  it("each item has top-left origin coords within page bounds", async () => {
    const pages = await extractPdfTextWithBounds(pdfjsLib, pdfBytes);
    const { items, width, height } = pages[0];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.x).toBeGreaterThanOrEqual(-5); // small tolerance for edge glyphs
      expect(item.y).toBeGreaterThanOrEqual(-5);
      expect(item.x).toBeLessThan(width + 5);
      expect(item.y).toBeLessThan(height + 5);
      expect(item.width).toBeGreaterThan(0);
      expect(item.height).toBeGreaterThan(0);
    }
  });

  it("filters out pure-whitespace items", async () => {
    const pages = await extractPdfTextWithBounds(pdfjsLib, pdfBytes);
    const allItems = pages.flatMap(p => p.items);
    expect(allItems.every(it => it.text.trim().length > 0)).toBe(true);
  });

  it("respects maxPages", async () => {
    const pages = await extractPdfTextWithBounds(pdfjsLib, pdfBytes, { maxPages: 1 });
    expect(pages.length).toBe(1);
  });
});

describe("detectSignatureZones — AcroForm layer", () => {
  let pdfjsLib;
  let pdfBytes;
  let pdfDoc;

  beforeAll(async () => {
    pdfjsLib = await loadPdfjsForTest();
    pdfBytes = await fs.readFile(EXAMPLE_PDF);
    pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  }, 20_000);

  it("returns an array (possibly empty) even with no pdfjs module", async () => {
    const zones = await detectSignatureZones({ pdfDoc, pdfBytes, pdfjsLib: null });
    expect(Array.isArray(zones)).toBe(true);
  });

  it("returns an array when called with full inputs", async () => {
    const zones = await detectSignatureZones({ pdfDoc, pdfBytes, pdfjsLib });
    expect(Array.isArray(zones)).toBe(true);
  });

  it("zones use top-left origin with valid bounds", async () => {
    const zones = await detectSignatureZones({ pdfDoc, pdfBytes, pdfjsLib });
    const pages = pdfDoc.getPages();
    for (const zone of zones) {
      expect(zone.page).toBeGreaterThanOrEqual(1);
      expect(zone.page).toBeLessThanOrEqual(pages.length);
      const { width: pageW, height: pageH } = pages[zone.page - 1].getSize();
      expect(zone.x).toBeGreaterThanOrEqual(-5);
      expect(zone.y).toBeGreaterThanOrEqual(-5);
      expect(zone.x + zone.width).toBeLessThanOrEqual(pageW + 5);
      expect(zone.y + zone.height).toBeLessThanOrEqual(pageH + 5);
      expect(["signature", "initials", "date"]).toContain(zone.type);
      expect(zone.confidence).toBeGreaterThan(0);
      expect(zone.confidence).toBeLessThanOrEqual(1);
      expect(zone.source).toMatch(/^(acroform-|text-heuristic)/);
    }
  });

  it("detects the Signature-of-U.S.-person label on IRS W-9", async () => {
    const zones = await detectSignatureZones({ pdfDoc, pdfBytes, pdfjsLib });
    // W-9 has "Signature of U.S. person" near the bottom of page 1
    const sigZones = zones.filter(z => z.type === "signature");
    expect(sigZones.length).toBeGreaterThan(0);
    // At least one should be on page 1 and reference "Signature" in its label
    expect(sigZones.some(z => z.page === 1 && /signature/i.test(z.label))).toBe(true);
  });

  it("detects a Date zone on IRS W-9", async () => {
    const zones = await detectSignatureZones({ pdfDoc, pdfBytes, pdfjsLib });
    const dateZones = zones.filter(z => z.type === "date");
    expect(dateZones.length).toBeGreaterThan(0);
  });

  it("returns deduped zones (no near-identical duplicates)", async () => {
    const zones = await detectSignatureZones({ pdfDoc, pdfBytes, pdfjsLib });
    for (let i = 0; i < zones.length; i++) {
      for (let j = i + 1; j < zones.length; j++) {
        if (zones[i].page !== zones[j].page) continue;
        const iou = computeIoU(zones[i], zones[j]);
        expect(iou).toBeLessThan(0.4);
      }
    }
  });

  it("orders zones by page then top-to-bottom", async () => {
    const zones = await detectSignatureZones({ pdfDoc, pdfBytes, pdfjsLib });
    for (let i = 1; i < zones.length; i++) {
      const prev = zones[i - 1];
      const cur = zones[i];
      if (prev.page === cur.page) {
        // Within a page, should be roughly top-to-bottom
        expect(cur.y).toBeGreaterThanOrEqual(prev.y - 5); // small tolerance
      } else {
        expect(cur.page).toBeGreaterThan(prev.page);
      }
    }
  });
});

describe("detectSignatureZones — synthetic AcroForm signature field", () => {
  it("returns a signature zone when form has a PDFSignature-typed field", async () => {
    // Build a minimal PDF with one signature field.
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    // Inject a signature annotation by hand via the low-level API.
    // Simpler path: mock detectSignatureZones internals. But we want a real end-to-end test.
    // Use pdf-lib's form.createSignature if available; otherwise skip this case.
    // Actually pdf-lib doesn't expose createSignature. Use a named text field as a stand-in.
    const form = doc.getForm();
    const sigLookingField = form.createTextField("Signature1");
    sigLookingField.addToPage(doc.getPages()[0], { x: 100, y: 100, width: 200, height: 30 });
    const bytes = await doc.save();
    const reloaded = await PDFDocument.load(bytes);
    const zones = await detectSignatureZones({ pdfDoc: reloaded, pdfBytes: bytes, pdfjsLib: null });
    // Should catch the signature-named text field
    expect(zones.length).toBeGreaterThanOrEqual(1);
    expect(zones[0].type).toBe("signature");
    expect(zones[0].source).toBe("acroform-named-field");
    expect(zones[0].confidence).toBeCloseTo(0.85, 2);
  });

  it("returns an initials zone when form has an initials-named text field", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const form = doc.getForm();
    const initialsField = form.createTextField("initials_p1");
    initialsField.addToPage(doc.getPages()[0], { x: 50, y: 100, width: 60, height: 20 });
    const bytes = await doc.save();
    const reloaded = await PDFDocument.load(bytes);
    const zones = await detectSignatureZones({ pdfDoc: reloaded, pdfBytes: bytes, pdfjsLib: null });
    expect(zones.length).toBeGreaterThanOrEqual(1);
    expect(zones[0].type).toBe("initials");
  });

  it("does NOT detect unrelated text fields as signatures", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const form = doc.getForm();
    const nameField = form.createTextField("FullName");
    nameField.addToPage(doc.getPages()[0], { x: 50, y: 100, width: 200, height: 20 });
    const bytes = await doc.save();
    const reloaded = await PDFDocument.load(bytes);
    const zones = await detectSignatureZones({ pdfDoc: reloaded, pdfBytes: bytes, pdfjsLib: null });
    // AcroForm layer should return zero; text layer won't run without pdfjsLib
    expect(zones.length).toBe(0);
  });
});
