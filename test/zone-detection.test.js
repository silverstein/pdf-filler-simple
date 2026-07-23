import { describe, it, expect, beforeAll } from "vitest";
import { EncryptedPDFError, PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  computeIoU,
  dedupeOverlappingZones,
  extractPdfTextWithBounds,
  detectSignatureZones,
  scanPageForLabels,
  isPdfLibEncryptedError,
} from "../server/helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_PDF = path.join(__dirname, "..", "example-fw9.pdf");
const ROTATED_CROPPED_PDF = path.join(__dirname, "fixtures", "golden-forms", "rotated-signature.pdf");

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

describe("pdf-lib encrypted error classification", () => {
  it("accepts only pdf-lib's exact canonical encryption error", () => {
    const canonicalMessage = new EncryptedPDFError().message;
    expect(isPdfLibEncryptedError(new EncryptedPDFError())).toBe(true);
    expect(isPdfLibEncryptedError(new Error(canonicalMessage))).toBe(true);
    expect(isPdfLibEncryptedError(new Error(`${canonicalMessage} `))).toBe(false);
    expect(isPdfLibEncryptedError(new Error("Input document is encrypted"))).toBe(false);
    expect(isPdfLibEncryptedError(null)).toBe(false);
  });
});

describe("signature-zone label taxonomy", () => {
  function scanLabels(labels) {
    return scanPageForLabels({
      page: 1,
      width: 612,
      height: 792,
      items: labels.map((text, index) => ({
        text,
        x: 72,
        y: 100 + index * 50,
        width: Math.max(40, text.length * 6),
        height: 10,
      })),
    });
  }

  it("recognizes the bounded signature, printed-name, witness, and date labels", () => {
    const zones = scanLabels([
      "Signatures",
      "Print Name:",
      "Printed Name",
      "Witness",
      "Authorized Signature",
      "Borrower's Signature",
      "Borrower’s Signature",
      "Dated:",
    ]);
    expect(zones.map(zone => [zone.label, zone.type])).toEqual([
      ["Signatures", "signature"],
      ["Print Name:", "name"],
      ["Printed Name", "name"],
      ["Witness", "signature"],
      ["Authorized Signature", "signature"],
      ["Borrower's Signature", "signature"],
      ["Borrower’s Signature", "signature"],
      ["Dated:", "date"],
    ]);
  });

  it("rejects populated values and instructional prose", () => {
    expect(scanLabels([
      "Print Name: Jane",
      "Dated: 2026",
      "Witness statements",
      "Authorized Signature Requirements",
      "Signature: Jane Doe",
      "Date: July 23, 2026",
      "Signatures are required",
      "Borrower's Signature on file",
    ])).toEqual([]);
  });
});

describe("type-aware signature-zone deduplication", () => {
  it("drops lower-confidence same-type duplicates while preserving overlapping semantic fields", () => {
    const base = { page: 1, x: 100, y: 200, width: 200, height: 30, label: "zone", source: "text-heuristic" };
    const zones = dedupeOverlappingZones([
      { ...base, type: "signature", confidence: 0.90, label: "high signature" },
      { ...base, type: "signature", confidence: 0.70, label: "low signature" },
      { ...base, type: "date", confidence: 0.80, label: "date" },
      { ...base, type: "name", confidence: 0.75, label: "name" },
    ]);

    expect(zones).toHaveLength(3);
    expect(zones.map(zone => zone.type).sort()).toEqual(["date", "name", "signature"]);
    expect(zones.find(zone => zone.type === "signature")?.label).toBe("high signature");
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

  it("reports rotated CropBox text in native MediaBox coordinates", async () => {
    const rotatedBytes = await fs.readFile(ROTATED_CROPPED_PDF);
    const [page] = await extractPdfTextWithBounds(pdfjsLib, rotatedBytes);
    const signature = page.items.find(item => item.text === "Signature");

    expect(page.width).toBe(480);
    expect(page.height).toBe(360);
    expect(signature).toMatchObject({ x: 72, y: 201, width: 51.36, height: 12 });
  });

  it("fails closed when a caller supplies incomplete MediaBox geometry", async () => {
    await expect(extractPdfTextWithBounds(pdfjsLib, pdfBytes, { mediaBoxes: [] }))
      .rejects.toThrow(/MediaBox geometry for page 1/);
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
      expect(["signature", "initials", "name", "date"]).toContain(zone.type);
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

  it("places the IRS W-9 signature/date zones on the signing row after the arrow markers", async () => {
    const zones = await detectSignatureZones({ pdfDoc, pdfBytes, pdfjsLib });
    const sig = zones.find(z => z.page === 1 && z.type === "signature" && /signature/i.test(z.label));
    const date = zones.find(z => z.page === 1 && z.type === "date" && /^date$/i.test(z.label));

    expect(sig).toBeDefined();
    expect(date).toBeDefined();
    // Regression guard: the old marker-baseline heuristic emitted y=524.3,
    // which was in-bounds but visibly covered the label text in Sign mode.
    expect(sig.x).toBeGreaterThanOrEqual(120);
    expect(sig.x).toBeLessThanOrEqual(140);
    expect(sig.y).toBeGreaterThanOrEqual(512);
    expect(sig.y).toBeLessThanOrEqual(516);
    expect(sig.height).toBe(16);
    expect(sig.x + sig.width).toBeLessThan(date.x - 20);

    expect(date.x).toBeGreaterThanOrEqual(400);
    expect(date.x).toBeLessThanOrEqual(420);
    expect(date.y).toBeGreaterThanOrEqual(512);
    expect(date.y).toBeLessThanOrEqual(516);
    expect(date.height).toBe(16);
    // The signing boxes should start on the blank signing row above the
    // captions, not down on the marker/label baseline.
    expect(sig.y).toBeLessThan(522);
    expect(sig.y + sig.height).toBeLessThanOrEqual(530);
    expect(date.y).toBeLessThan(522);
    expect(date.y + date.height).toBeLessThanOrEqual(530);
  });

  it("does not treat non-arrow decorative bullets as signature-row anchors", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("Signature", { x: 72, y: 500, size: 10, font });
    page.drawText(String.fromCharCode(0x2022), { x: 150, y: 500, size: 10, font });

    const bytes = await doc.save();
    const reloaded = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const zones = await detectSignatureZones({ pdfDoc: reloaded, pdfBytes: bytes, pdfjsLib });
    const sig = zones.find(z => z.type === "signature" && z.label === "Signature");

    expect(sig).toBeDefined();
    expect(sig.x).toBeLessThan(100);
  });

  it("keeps same-baseline Signature-of arrow layouts on the marker row", async () => {
    const zones = scanPageForLabels({
      page: 1,
      width: 612,
      height: 792,
      items: [
        { text: "Signature of Applicant", x: 72, y: 282, width: 104, height: 10 },
        { text: String.fromCharCode(0x25B6), x: 180, y: 282, width: 5, height: 5 },
      ],
    });
    const sig = zones.find(z => z.type === "signature" && z.label === "Signature of Applicant");

    expect(sig).toBeDefined();
    expect(sig.x).toBeGreaterThan(180);
    // If the W-9 captioned-row fix were applied to every direct arrow marker,
    // this same-baseline form would be shifted roughly 20pt too high.
    expect(sig.y).toBeGreaterThan(270);
  });

  it("places a fully corroborated split Signature-of caption inside its signing cell", () => {
    const zones = scanPageForLabels({
      page: 1,
      width: 612,
      height: 792,
      items: [
        { text: "Sign", x: 36, y: 578.9, width: 21.1, height: 10 },
        { text: "Here", x: 36, y: 588.9, width: 22.8, height: 10 },
        { text: "Signature of", x: 76, y: 582.3, width: 40.7, height: 7 },
        { text: "U.S. person", x: 76, y: 590.7, width: 38.8, height: 7 },
        { text: "Date", x: 385.6, y: 590.7, width: 15.7, height: 7 },
      ],
    });
    const sig = zones.find(z => z.type === "signature" && z.label === "Signature of");

    expect(sig).toMatchObject({
      x: 122.7,
      y: 576.8,
      width: 256.9,
      height: 18,
    });
    expect(sig.x).toBeGreaterThanOrEqual(72);
    expect(sig.y).toBeGreaterThanOrEqual(576);
    expect(sig.x + sig.width).toBeLessThanOrEqual(384);
    expect(sig.y + sig.height).toBeLessThanOrEqual(600);
  });

  it.each([
    {
      name: "the stacked Sign and Here heading is absent",
      items: [
        { text: "Signature of", x: 76, y: 582.3, width: 40.7, height: 7 },
        { text: "U.S. person", x: 76, y: 590.7, width: 38.8, height: 7 },
        { text: "Date", x: 385.6, y: 590.7, width: 15.7, height: 7 },
      ],
    },
    {
      name: "the continuation is absent",
      items: [
        { text: "Sign", x: 36, y: 578.9, width: 21.1, height: 10 },
        { text: "Here", x: 36, y: 588.9, width: 22.8, height: 10 },
        { text: "Signature of", x: 76, y: 582.3, width: 40.7, height: 7 },
        { text: "Date", x: 385.6, y: 590.7, width: 15.7, height: 7 },
      ],
    },
    {
      name: "the Date label is absent",
      items: [
        { text: "Sign", x: 36, y: 578.9, width: 21.1, height: 10 },
        { text: "Here", x: 36, y: 588.9, width: 22.8, height: 10 },
        { text: "Signature of", x: 76, y: 582.3, width: 40.7, height: 7 },
        { text: "U.S. person", x: 76, y: 590.7, width: 38.8, height: 7 },
      ],
    },
    {
      name: "the caption is a complete one-line label",
      items: [
        { text: "Sign", x: 36, y: 578.9, width: 21.1, height: 10 },
        { text: "Here", x: 36, y: 588.9, width: 22.8, height: 10 },
        { text: "Signature of Authorized Officer", x: 76, y: 582.3, width: 120, height: 7 },
        { text: "Date", x: 385.6, y: 590.7, width: 15.7, height: 7 },
      ],
    },
  ])("keeps line-above placement when $name", ({ items }) => {
    const zones = scanPageForLabels({
      page: 1,
      width: 612,
      height: 792,
      items,
    });
    const sig = zones.find(z => z.type === "signature");

    expect(sig).toBeDefined();
    expect(sig.x).toBe(76);
    expect(sig.y).toBe(562.3);
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
        if (zones[i].type === zones[j].type) {
          const iou = computeIoU(zones[i], zones[j]);
          expect(iou).toBeLessThan(0.4);
        }
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

  it("returns a name zone for an explicitly printed-name AcroForm field", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const field = doc.getForm().createTextField("printed_name");
    field.addToPage(doc.getPages()[0], { x: 50, y: 100, width: 180, height: 20 });
    const bytes = await doc.save();
    const reloaded = await PDFDocument.load(bytes);
    const zones = await detectSignatureZones({ pdfDoc: reloaded, pdfBytes: bytes, pdfjsLib: null });
    expect(zones).toEqual([
      expect.objectContaining({
        type: "name",
        label: "printed_name",
        page: 1,
        source: "acroform-named-field",
      }),
    ]);
  });

  it("skips a widget with no resolvable page and emits only a bounded warning", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const field = doc.getForm().createTextField("Signature1");
    field.addToPage(page, { x: 100, y: 100, width: 200, height: 30 });
    const [widget] = field.acroField.getWidgets();
    widget.dict.delete(PDFName.of("P"));
    page.node.delete(PDFName.of("Annots"));

    const warnings = [];
    const zones = await detectSignatureZones({
      pdfDoc: doc,
      pdfBytes: await doc.save(),
      pdfjsLib: null,
      onWarning: warning => warnings.push(warning),
    });

    expect(zones).toEqual([]);
    expect(warnings).toEqual([{
      code: "ACROFORM_WIDGET_PAGE_UNRESOLVED",
      message: "Skipped an AcroForm signing widget because its page could not be resolved. No page location was guessed.",
    }]);
    expect(JSON.stringify(warnings)).not.toContain("Signature1");
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
