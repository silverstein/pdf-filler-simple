import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  validateSignatureName,
  parseImageDataUrl,
  validateSigningIntent,
  stampSignatureOnPage,
  stampTextOnPage,
  drawSignatureFieldOnPage,
  formatSigningAuditLine,
  detectExistingSignatures,
  detectXfaForm,
} from "../server/helpers.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");

// A tiny 2×2 transparent PNG — enough to exercise the embed path
const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVQIW2NgYGD4z8DAwMAAAAwAAwH1oUt1AAAAAElFTkSuQmCC";

describe("validateSignatureName", () => {
  it("accepts normal names", () => {
    expect(validateSignatureName("mat-default")).toBe("mat-default");
    expect(validateSignatureName("Mat Silverstein")).toBe("Mat Silverstein");
    expect(validateSignatureName("business_2026")).toBe("business_2026");
  });
  it("trims whitespace", () => {
    expect(validateSignatureName("  mat  ")).toBe("mat");
  });
  it("rejects path traversal attempts", () => {
    expect(() => validateSignatureName("../escape")).toThrow(/may only contain/);
    expect(() => validateSignatureName("a/b")).toThrow(/may only contain/);
  });
  it("rejects special chars", () => {
    expect(() => validateSignatureName("name;rm -rf")).toThrow();
    expect(() => validateSignatureName("name<script>")).toThrow();
  });
  it("rejects empty / non-string", () => {
    expect(() => validateSignatureName("")).toThrow(/required/);
    expect(() => validateSignatureName(null)).toThrow(/required/);
    expect(() => validateSignatureName(undefined)).toThrow(/required/);
  });
});

describe("parseImageDataUrl", () => {
  it("decodes a PNG data URL", () => {
    const { mime, bytes } = parseImageDataUrl(`data:image/png;base64,${TINY_PNG_B64}`);
    expect(mime).toBe("image/png");
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });
  it("accepts image/jpeg", () => {
    const jpegHeader = Buffer.from("/9j/4AAQSkZJRgA=", "base64").toString("base64");
    const { mime } = parseImageDataUrl(`data:image/jpeg;base64,${jpegHeader}`);
    expect(mime).toBe("image/jpeg");
  });
  it("rejects malformed data URLs", () => {
    expect(() => parseImageDataUrl("not a data url")).toThrow();
    expect(() => parseImageDataUrl("data:image/png,abc")).toThrow();
  });
  it("rejects unsupported mime types", () => {
    expect(() => parseImageDataUrl("data:image/webp;base64,AAAA")).toThrow(/Unsupported/);
    expect(() => parseImageDataUrl("data:text/plain;base64,AAAA")).toThrow(/Unsupported/);
  });
  it("rejects empty payloads", () => {
    expect(() => parseImageDataUrl("data:image/png;base64,")).toThrow();
  });
});

describe("validateSigningIntent", () => {
  const fixedNow = new Date("2026-04-16T20:00:00Z").getTime();

  it("accepts a recent, substantive intent", () => {
    const res = validateSigningIntent({
      user_intent_statement: "I, Mat Silverstein, sign this W-9 on 2026-04-16.",
      user_confirmed_at: "2026-04-16T19:30:00Z",
    }, { now: fixedNow });
    expect(res.statement).toContain("Mat Silverstein");
    expect(res.confirmedAt.toISOString()).toBe("2026-04-16T19:30:00.000Z");
  });

  it("rejects missing statement", () => {
    expect(() => validateSigningIntent({
      user_confirmed_at: "2026-04-16T19:30:00Z",
    }, { now: fixedNow })).toThrow(/intent_statement/);
  });

  it("rejects a too-short statement (agent fabrication smell)", () => {
    expect(() => validateSigningIntent({
      user_intent_statement: "sign",
      user_confirmed_at: "2026-04-16T19:30:00Z",
    }, { now: fixedNow })).toThrow(/too short/);
  });

  it("rejects missing timestamp", () => {
    expect(() => validateSigningIntent({
      user_intent_statement: "I, Mat Silverstein, sign this W-9 on 2026-04-16.",
    }, { now: fixedNow })).toThrow(/confirmed_at/);
  });

  it("rejects invalid ISO timestamp", () => {
    expect(() => validateSigningIntent({
      user_intent_statement: "I, Mat Silverstein, sign this W-9 on 2026-04-16.",
      user_confirmed_at: "yesterday",
    }, { now: fixedNow })).toThrow(/valid ISO-8601/);
  });

  it("rejects timestamps more than 24h old (stale intent)", () => {
    expect(() => validateSigningIntent({
      user_intent_statement: "I, Mat Silverstein, sign this W-9 on 2026-04-15.",
      user_confirmed_at: "2026-04-15T00:00:00Z",
    }, { now: fixedNow })).toThrow(/more than 24 hours/);
  });

  it("rejects timestamps in the future (beyond 5min drift)", () => {
    expect(() => validateSigningIntent({
      user_intent_statement: "I, Mat Silverstein, sign this W-9 on 2026-04-16.",
      user_confirmed_at: "2026-04-16T21:00:00Z",
    }, { now: fixedNow })).toThrow(/in the future/);
  });

  it("allows small future drift (clock skew)", () => {
    const res = validateSigningIntent({
      user_intent_statement: "I, Mat Silverstein, sign this W-9 on 2026-04-16.",
      user_confirmed_at: "2026-04-16T20:02:00Z",
    }, { now: fixedNow });
    expect(res.confirmedAt).toBeInstanceOf(Date);
  });

  it("rejects overly long statements", () => {
    expect(() => validateSigningIntent({
      user_intent_statement: "x".repeat(600),
      user_confirmed_at: "2026-04-16T19:30:00Z",
    }, { now: fixedNow })).toThrow(/too long/);
  });
});

describe("formatSigningAuditLine", () => {
  it("flattens whitespace and produces a single line", () => {
    const line = formatSigningAuditLine({
      display_name: "Mat Silverstein",
      statement: "I,  Mat\n  sign this.",
      confirmedAt: new Date("2026-04-16T19:30:00Z"),
    });
    expect(line).toBe(
      `signed via pdf-toolkit; signer="Mat Silverstein"; at=2026-04-16T19:30:00.000Z; intent="I, Mat sign this."`
    );
  });

  it("supports alternate action verbs for initials flows", () => {
    const line = formatSigningAuditLine({
      display_name: "Mat Silverstein",
      statement: "I, Mat, initial this.",
      confirmedAt: new Date("2026-04-16T19:30:00Z"),
      action: "initialed",
    });
    expect(line).toBe(
      `initialed via pdf-toolkit; signer="Mat Silverstein"; at=2026-04-16T19:30:00.000Z; intent="I, Mat, initial this."`
    );
  });
});

describe("stampSignatureOnPage + drawSignatureFieldOnPage", () => {
  let pdfBytes;
  let tempDirectory;

  beforeAll(async () => {
    tempDirectory = await createTestTempDirectory(REPO_ROOT, "signatures");
    pdfBytes = await fs.readFile(EXAMPLE_PDF);
  });
  afterAll(async () => {
    await removeTestTempDirectory(tempDirectory);
  });

  it("stamps a typed signature and preserves original page count", async () => {
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const origCount = pdfDoc.getPageCount();
    await stampSignatureOnPage(pdfDoc, {
      style: "typed",
      display_name: "Mat Silverstein",
    }, { page: 1, x: 100, y: 700, width: 180, height: 36 });
    expect(pdfDoc.getPageCount()).toBe(origCount);
    const out = await pdfDoc.save();
    expect(out.length).toBeGreaterThan(0);
  });

  it("stamps an image signature", async () => {
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    await stampSignatureOnPage(pdfDoc, {
      style: "image",
      image_mime: "image/png",
      image_data_b64: TINY_PNG_B64,
    }, { page: 1, x: 100, y: 700, width: 100, height: 40 });
    const out = await pdfDoc.save();
    expect(out.length).toBeGreaterThan(0);
  });

  it("rejects out-of-bounds coordinates", async () => {
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    await expect(stampSignatureOnPage(pdfDoc, {
      style: "typed", display_name: "x",
    }, { page: 1, x: -10, y: 100, width: 100, height: 40 })).rejects.toThrow(/outside page bounds/);

    await expect(stampSignatureOnPage(pdfDoc, {
      style: "typed", display_name: "x",
    }, { page: 1, x: 100, y: 100, width: 10000, height: 40 })).rejects.toThrow(/outside page bounds/);
  });

  it("rejects invalid page number", async () => {
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    await expect(stampSignatureOnPage(pdfDoc, {
      style: "typed", display_name: "x",
    }, { page: 999, x: 100, y: 100, width: 100, height: 40 })).rejects.toThrow(/out of range/);

    await expect(stampSignatureOnPage(pdfDoc, {
      style: "typed", display_name: "x",
    }, { page: 0, x: 100, y: 100, width: 100, height: 40 })).rejects.toThrow(/out of range/);
  });

  it("rejects zero or negative dimensions", async () => {
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    await expect(stampSignatureOnPage(pdfDoc, {
      style: "typed", display_name: "x",
    }, { page: 1, x: 100, y: 100, width: 0, height: 40 })).rejects.toThrow(/positive/);

    await expect(stampSignatureOnPage(pdfDoc, {
      style: "typed", display_name: "x",
    }, { page: 1, x: 100, y: 100, width: 100, height: -5 })).rejects.toThrow(/positive/);
  });

  it("rejects NaN / non-finite inputs", async () => {
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    await expect(stampSignatureOnPage(pdfDoc, {
      style: "typed", display_name: "x",
    }, { page: 1, x: NaN, y: 100, width: 100, height: 40 })).rejects.toThrow(/finite/);
  });

  it("rejects unknown signature style", async () => {
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    await expect(stampSignatureOnPage(pdfDoc, {
      style: "crypto", display_name: "x",
    }, { page: 1, x: 100, y: 100, width: 100, height: 40 })).rejects.toThrow(/Unknown signature style/);
  });

  it("stampTextOnPage stamps a date string and preserves page count", async () => {
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const origCount = pdfDoc.getPageCount();
    await stampTextOnPage(pdfDoc, {
      page: 1, x: 400, y: 700, width: 120, height: 20, text: "2026-04-20",
    });
    expect(pdfDoc.getPageCount()).toBe(origCount);
    const out = await pdfDoc.save();
    expect(out.length).toBeGreaterThan(0);
  });

  it("stampTextOnPage rejects empty text", async () => {
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    await expect(stampTextOnPage(pdfDoc, {
      page: 1, x: 100, y: 100, width: 100, height: 20, text: "",
    })).rejects.toThrow(/non-empty string/);
  });

  it("stampTextOnPage rejects absurdly long text", async () => {
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    await expect(stampTextOnPage(pdfDoc, {
      page: 1, x: 100, y: 100, width: 100, height: 20, text: "x".repeat(300),
    })).rejects.toThrow(/200 chars/);
  });

  it("stampTextOnPage rejects out-of-bounds coordinates", async () => {
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    await expect(stampTextOnPage(pdfDoc, {
      page: 1, x: -10, y: 100, width: 100, height: 20, text: "hi",
    })).rejects.toThrow(/outside page bounds/);
  });

  it("stampTextOnPage supports italic font style", async () => {
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    await stampTextOnPage(pdfDoc, {
      page: 1, x: 100, y: 100, width: 100, height: 20, text: "italic text", fontStyle: "italic",
    });
    const out = await pdfDoc.save();
    expect(out.length).toBeGreaterThan(0);
  });

  it("draws a sign-here field without error", async () => {
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    await drawSignatureFieldOnPage(pdfDoc, {
      page: 1, x: 100, y: 700, width: 180, height: 36,
      label: "Signature (Applicant)",
    });
    const out = await pdfDoc.save();
    expect(out.length).toBeGreaterThan(0);
  });

  it("detectExistingSignatures returns false for an unsigned PDF", async () => {
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const result = detectExistingSignatures(pdfDoc);
    expect(result.present).toBe(false);
    expect(result.fieldNames).toEqual([]);
  });

  it("detectExistingSignatures returns true when a signature field exists (mock)", () => {
    // Mock a pdfDoc with one signature field — simpler than building a real signed fixture.
    const mockDoc = {
      getForm: () => ({
        getFields: () => [
          { constructor: { name: "PDFTextField" }, getName: () => "f1" },
          { constructor: { name: "PDFSignature" }, getName: () => "sig1" },
          { constructor: { name: "PDFSignature" }, getName: () => "sig2" },
        ],
      }),
    };
    const result = detectExistingSignatures(mockDoc);
    expect(result.present).toBe(true);
    expect(result.fieldNames).toEqual(["sig1", "sig2"]);
  });

  it("detectExistingSignatures handles a PDF with no form gracefully", () => {
    const mockDoc = {
      getForm: () => { throw new Error("No form"); },
    };
    const result = detectExistingSignatures(mockDoc);
    expect(result.present).toBe(false);
    expect(result.fieldNames).toEqual([]);
  });

  it("detectXfaForm returns false for an AcroForm PDF (example-fw9.pdf)", () => {
    expect(detectXfaForm(pdfBytes)).toBe(false);
  });

  it("detectXfaForm returns true when /XFA is present in the raw bytes", () => {
    // Synthesize a minimal PDF-looking buffer with an /XFA dict reference.
    const synthetic = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.from("1 0 obj\n<< /Type /Catalog /AcroForm << /XFA [ (datasets) 2 0 R ] >> >>\nendobj\n"),
      Buffer.from("%%EOF\n"),
    ]);
    expect(detectXfaForm(synthetic)).toBe(true);
  });

  it("detectXfaForm handles empty / tiny inputs", () => {
    expect(detectXfaForm(null)).toBe(false);
    expect(detectXfaForm(Buffer.from(""))).toBe(false);
    expect(detectXfaForm(Buffer.from("abc"))).toBe(false);
  });

  it("detectXfaForm does NOT false-positive on unrelated '/X' patterns", () => {
    const synthetic = Buffer.concat([
      Buffer.from("%PDF-1.7\n"),
      Buffer.from("1 0 obj\n<< /XYZ 100 200 0 /XObject 3 0 R >>\nendobj\n"),
      Buffer.from("%%EOF\n"),
    ]);
    expect(detectXfaForm(synthetic)).toBe(false);
  });

  it("converts top-left coordinates to bottom-left correctly", async () => {
    // Sanity check: stamping at top-left (0, 0, 50, 20) should draw NEAR the top of the page
    // We test this indirectly by ensuring no out-of-bounds error on a valid box at the very top.
    const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const page = pdfDoc.getPages()[0];
    const { height } = page.getSize();
    await stampSignatureOnPage(pdfDoc, {
      style: "typed", display_name: "x",
    }, { page: 1, x: 10, y: 0, width: 50, height: 20 });
    // If we botched the conversion, pdfY = height - 0 - 20 = height - 20 (near top in PDF space, which is correct).
    // Conversely, stamping at y = height (bottom in top-left) should be at pdfY = 0 (bottom in PDF space).
    await stampSignatureOnPage(pdfDoc, {
      style: "typed", display_name: "x",
    }, { page: 1, x: 10, y: height - 20, width: 50, height: 20 });
    const out = await pdfDoc.save();
    expect(out.length).toBeGreaterThan(0);
  });
});
