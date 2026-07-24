/**
 * Nonzero-origin MediaBox normalization (bead pdf-toolkit-mcp-vk8).
 *
 * Every public coordinate in this codebase is documented as top-left origin in
 * points relative to the page MediaBox. PDF user space is bottom-left origin AND
 * offset by the MediaBox origin, which is nonzero for a page whose MediaBox is
 * e.g. [40 60 652 852].
 *
 * The defect these tests pin: stamping flipped the y axis but drew at raw user
 * space, and detection read raw pdf.js transforms / widget rects, so both sides
 * were displaced by the MediaBox origin. A detect-then-stamp round trip hid it
 * because the two errors cancel exactly. These tests therefore assert ABSOLUTE
 * user-space placement, which is the only thing that distinguishes the two.
 *
 * All pre-existing fixtures have origin [0 0], so every assertion here is new
 * coverage rather than a restatement of the golden set.
 */

import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  stampSignatureOnPage,
  stampTextOnPage,
  drawSignatureFieldOnPage,
  extractPdfTextWithBounds,
  detectSignatureZones,
  getPageBoxGeometry,
} from "../server/helpers.js";

// Deliberately asymmetric so an x/y swap or a single-axis fix cannot pass.
const ORIGIN_X = 40;
const ORIGIN_Y = 60;
const PAGE_W = 612;
const PAGE_H = 792;

async function loadPdfjs() {
  return await import("pdfjs-dist/legacy/build/pdf.mjs");
}

async function makeOffsetPage({ originX = ORIGIN_X, originY = ORIGIN_Y, rotate = 0, cropBox = null } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.setMediaBox(originX, originY, PAGE_W, PAGE_H);
  if (cropBox) page.setCropBox(cropBox.x, cropBox.y, cropBox.width, cropBox.height);
  if (rotate) page.setRotation({ type: "degrees", angle: rotate });
  return { doc, page };
}

/** Raw pdf.js text items in ABSOLUTE user space — deliberately unnormalized. */
async function rawUserSpaceTextItems(pdfjsLib, bytes) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  try {
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    return content.items
      .filter(it => it?.str?.trim())
      .map(it => ({ text: it.str, userX: it.transform[4], userY: it.transform[5] }));
  } finally {
    await doc.destroy();
  }
}

describe("getPageBoxGeometry", () => {
  it("reports the MediaBox origin and dimensions", async () => {
    const { page } = await makeOffsetPage();
    expect(getPageBoxGeometry(page)).toEqual({
      originX: ORIGIN_X,
      originY: ORIGIN_Y,
      width: PAGE_W,
      height: PAGE_H,
    });
  });

  it("reports a zero origin for an ordinary page", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([PAGE_W, PAGE_H]);
    const geometry = getPageBoxGeometry(page);
    expect(geometry.originX).toBe(0);
    expect(geometry.originY).toBe(0);
  });
});

describe("stamping honors a nonzero MediaBox origin", () => {
  it("places stamped text at the requested box-relative point in absolute user space", async () => {
    const { doc } = await makeOffsetPage();
    const X = 100, Y = 200, W = 200, H = 20;
    await stampTextOnPage(doc, { page: 1, x: X, y: Y, width: W, height: H, text: "SIGNHERE" });

    const pdfjsLib = await loadPdfjs();
    const items = await rawUserSpaceTextItems(pdfjsLib, await doc.save());
    expect(items).toHaveLength(1);
    const { userX, userY } = items[0];

    // Box in absolute user space: left = originX + x, bottom = originY + (H - y - h)
    const boxLeft = ORIGIN_X + X;
    const boxBottom = ORIGIN_Y + (PAGE_H - Y - H);

    // Text is centered inside the box, so it must sit within the box span,
    // never at the un-offset position the defect produced.
    expect(userX).toBeGreaterThanOrEqual(boxLeft);
    expect(userX).toBeLessThanOrEqual(boxLeft + W);
    expect(userY).toBeGreaterThanOrEqual(boxBottom);
    expect(userY).toBeLessThanOrEqual(boxBottom + H);

    // Regression pin: the defect drew exactly originX/originY too low-left.
    expect(userX).toBeGreaterThan(boxLeft - ORIGIN_X + 1);
    expect(userY).toBeGreaterThan(boxBottom - ORIGIN_Y + 1);
  });

  it("keeps stamped content inside the visible page box", async () => {
    const { doc } = await makeOffsetPage();
    // Hug the top-left corner — under the defect this fell outside the MediaBox.
    await stampTextOnPage(doc, { page: 1, x: 0, y: 0, width: 120, height: 18, text: "CORNER" });

    const pdfjsLib = await loadPdfjs();
    const [item] = await rawUserSpaceTextItems(pdfjsLib, await doc.save());
    expect(item.userX).toBeGreaterThanOrEqual(ORIGIN_X);
    expect(item.userY).toBeGreaterThanOrEqual(ORIGIN_Y);
    expect(item.userX).toBeLessThanOrEqual(ORIGIN_X + PAGE_W);
    expect(item.userY).toBeLessThanOrEqual(ORIGIN_Y + PAGE_H);
  });

  it("places a typed signature inside the visible page box", async () => {
    const { doc } = await makeOffsetPage();
    await stampSignatureOnPage(
      doc,
      { style: "typed", display_name: "Mat Silverstein" },
      { page: 1, x: 0, y: 0, width: 220, height: 40 }
    );
    const pdfjsLib = await loadPdfjs();
    const [item] = await rawUserSpaceTextItems(pdfjsLib, await doc.save());
    expect(item.userX).toBeGreaterThanOrEqual(ORIGIN_X);
    expect(item.userY).toBeGreaterThanOrEqual(ORIGIN_Y);
  });

  it("places a sign-here placeholder label at the offset box position", async () => {
    const { doc } = await makeOffsetPage();
    const X = 90, Y = 150, W = 200, H = 40;
    await drawSignatureFieldOnPage(doc, { page: 1, x: X, y: Y, width: W, height: H, label: "Sign here" });
    const pdfjsLib = await loadPdfjs();
    const [item] = await rawUserSpaceTextItems(pdfjsLib, await doc.save());

    // Assert the absolute band, not merely "inside the page" — a mid-page box
    // stays inside the page even when displaced by the origin, so a containment
    // check alone would pass against the defect.
    const boxLeft = ORIGIN_X + X;
    const boxBottom = ORIGIN_Y + (PAGE_H - Y - H);
    expect(item.userX).toBeGreaterThanOrEqual(boxLeft);
    expect(item.userX).toBeLessThanOrEqual(boxLeft + W);
    expect(item.userY).toBeGreaterThanOrEqual(boxBottom);
    expect(item.userY).toBeLessThanOrEqual(boxBottom + H);
  });

  it("still validates bounds in box-relative space", async () => {
    const { doc } = await makeOffsetPage();
    await expect(
      stampTextOnPage({ ...doc, getPages: doc.getPages.bind(doc) }, {
        page: 1, x: PAGE_W - 10, y: 10, width: 100, height: 20, text: "OVERFLOW",
      })
    ).rejects.toThrow(/falls outside page bounds/);
    // A box that fits the visible page is accepted even though its absolute
    // user-space coordinates exceed the box dimensions.
    await expect(
      stampTextOnPage(doc, { page: 1, x: PAGE_W - 120, y: 10, width: 100, height: 20, text: "FITS" })
    ).resolves.toBeUndefined();
  });
});

describe("extraction reports box-relative coordinates", () => {
  it("subtracts the MediaBox origin from pdf.js text bounds", async () => {
    const { doc, page } = await makeOffsetPage();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    // Draw directly in absolute user space at a known point.
    const userX = ORIGIN_X + 150;
    const userY = ORIGIN_Y + 500;
    page.drawText("ANCHOR", { x: userX, y: userY, size: 12, font, color: rgb(0, 0, 0) });

    const pdfjsLib = await loadPdfjs();
    const pages = await extractPdfTextWithBounds(pdfjsLib, await doc.save(), {});
    const item = pages[0].items.find(i => i.text.includes("ANCHOR"));
    expect(item).toBeTruthy();

    // Box-relative x is the user-space x minus the origin.
    expect(item.x).toBeCloseTo(150, 1);
    // Box-relative top-left y measures down from the box top edge.
    const expectedTopLeftY = PAGE_H - 500 - item.fontSize * 0.75;
    expect(item.y).toBeCloseTo(expectedTopLeftY, 1);
  });

  it("reports AcroForm signature widgets in the same box-relative space", async () => {
    const { doc, page } = await makeOffsetPage();
    const form = doc.getForm();
    const field = form.createTextField("Signature1");
    // addToPage takes absolute user-space coordinates.
    field.addToPage(page, {
      x: ORIGIN_X + 120,
      y: ORIGIN_Y + 300,
      width: 200,
      height: 24,
    });

    const bytes = await doc.save();
    const reloaded = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pdfjsLib = await loadPdfjs();
    const zones = await detectSignatureZones({
      pdfDoc: reloaded,
      pdfBytes: bytes,
      pdfjsLib,
      scanAcroForm: true,
    });

    const zone = zones.find(z => z.source?.startsWith("acroform"));
    expect(zone).toBeTruthy();
    // pdf-lib insets the widget border by 0.5pt, so allow 1pt of slack. The
    // defect would have reported x off by +40 and y off by -60, far outside it.
    expect(Math.abs(zone.x - 120)).toBeLessThanOrEqual(1);
    expect(Math.abs(zone.y - (PAGE_H - 300 - 24))).toBeLessThanOrEqual(1);
  });
});

describe("detect-then-stamp round trip on offset pages", () => {
  // The round trip passed even while both sides were wrong, so it is a
  // consistency check, not the primary regression gate.
  it("stamps back onto the coordinates extraction reported", async () => {
    const { doc, page } = await makeOffsetPage();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("TARGET", { x: ORIGIN_X + 90, y: ORIGIN_Y + 400, size: 12, font });
    const bytes = await doc.save();

    const pdfjsLib = await loadPdfjs();
    const extracted = await extractPdfTextWithBounds(pdfjsLib, bytes, {});
    const target = extracted[0].items.find(i => i.text.includes("TARGET"));

    const reloaded = await PDFDocument.load(bytes, { ignoreEncryption: true });
    await stampTextOnPage(reloaded, {
      page: 1,
      x: target.x,
      y: target.y,
      width: 80,
      height: Math.max(12, target.height),
      text: "OK",
    });

    const boxHeight = Math.max(12, target.height);
    const after = await extractPdfTextWithBounds(pdfjsLib, await reloaded.save(), {});
    const stamped = after[0].items.find(i => i.text.includes("OK"));
    expect(stamped.x).toBeGreaterThan(target.x - 40);
    expect(stamped.x).toBeLessThan(target.x + 120);
    // Extraction approximates the glyph top as 0.75 * fontSize and stamping
    // centers text in the box, so the y round trip lands within the requested
    // box rather than exactly on its top edge. Assert containment, which is the
    // invariant that actually matters, with a small allowance for that ascent
    // approximation on both sides.
    expect(stamped.y).toBeGreaterThan(target.y - boxHeight);
    expect(stamped.y).toBeLessThan(target.y + boxHeight * 2);
  });

  it("holds with /Rotate 90 and a nonzero CropBox present", async () => {
    const { doc } = await makeOffsetPage({
      rotate: 90,
      cropBox: { x: ORIGIN_X + 20, y: ORIGIN_Y + 24, width: 400, height: 300 },
    });
    // Keep the stamp inside the CropBox: pdf.js extracts against the visible
    // view, so content outside it is legitimately absent from getTextContent.
    // CropBox spans user-space y [84, 384]; box-relative y 632 maps to ~200.
    await stampTextOnPage(doc, { page: 1, x: 60, y: 632, width: 160, height: 20, text: "ROTATED" });

    const pdfjsLib = await loadPdfjs();
    const [item] = await rawUserSpaceTextItems(pdfjsLib, await doc.save());
    // Rotation is a display transform; content coordinates stay in MediaBox space.
    expect(item.userX).toBeGreaterThanOrEqual(ORIGIN_X);
    expect(item.userY).toBeGreaterThanOrEqual(ORIGIN_Y);
    expect(item.userX).toBeLessThanOrEqual(ORIGIN_X + PAGE_W);
    expect(item.userY).toBeLessThanOrEqual(ORIGIN_Y + PAGE_H);
  });
});

describe("zero-origin pages are unaffected", () => {
  it("draws at identical coordinates when the origin is [0 0]", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([PAGE_W, PAGE_H]);
    await stampTextOnPage(doc, { page: 1, x: 100, y: 200, width: 200, height: 20, text: "BASELINE" });

    const pdfjsLib = await loadPdfjs();
    const [item] = await rawUserSpaceTextItems(pdfjsLib, await doc.save());
    // Pre-existing behavior: box-relative and user space coincide exactly.
    expect(item.userX).toBeGreaterThanOrEqual(100);
    expect(item.userX).toBeLessThanOrEqual(300);
    expect(item.userY).toBeCloseTo(PAGE_H - 200 - 20 + 5.63, 0);
  });
});
