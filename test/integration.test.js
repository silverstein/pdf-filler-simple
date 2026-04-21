/**
 * End-to-end integration test for the v0.8.0 value prop:
 *   fetch_pdf_from_url -> fill_pdf -> apply_signature -> verify audit trail
 *
 * Requires network access. Set OFFLINE=1 to skip.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { PDFDocument } from "pdf-lib";
import {
  downloadPdfFromUrl,
  stampSignatureOnPage,
  formatSigningAuditLine,
  validateSigningIntent,
} from "../server/helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = path.join(__dirname, "..", ".test-tmp-integration");

const OFFLINE = process.env.OFFLINE === "1";
const IRS_W9_URL = "https://www.irs.gov/pub/irs-pdf/fw9.pdf";

describe.skipIf(OFFLINE)("v0.8.0 end-to-end: fetch → fill → sign → verify", () => {
  beforeAll(async () => {
    await fs.mkdir(TMP_DIR, { recursive: true });
  }, 30_000);

  afterAll(async () => {
    await fs.rm(TMP_DIR, { recursive: true, force: true });
  });

  it("completes the full chain on a real IRS W-9", async () => {
    // ── 1. Fetch ──
    const fetchResult = await downloadPdfFromUrl(IRS_W9_URL, {
      destinationDir: TMP_DIR,
      filename: "fw9-integration.pdf",
      overwrite: true,
    });
    expect(fetchResult.bytes).toBeGreaterThan(50_000);
    expect(fetchResult.contentType).toContain("pdf");
    expect(fetchResult.path).toBe(path.join(TMP_DIR, "fw9-integration.pdf"));
    const fetched = await fs.readFile(fetchResult.path);
    expect(fetched.subarray(0, 5).toString("ascii")).toBe("%PDF-");

    // ── 2. Open + sanity-check form fields ──
    const pdfDoc = await PDFDocument.load(fetched, { ignoreEncryption: true });
    const pageCount = pdfDoc.getPageCount();
    expect(pageCount).toBeGreaterThanOrEqual(1);
    const form = pdfDoc.getForm();
    const fields = form.getFields();
    expect(fields.length).toBeGreaterThan(0);

    // ── 3. Fill a text field (first one is usually the name line) ──
    const firstTextField = fields.find(f => f.constructor.name.includes("TextField"));
    expect(firstTextField, "W-9 should contain at least one text field").toBeTruthy();
    firstTextField.setText("Mat Silverstein — Integration Test");

    // ── 4. Validate signing intent (enforced by validateSigningIntent in real handler) ──
    const now = new Date();
    const { statement, confirmedAt } = validateSigningIntent({
      user_intent_statement: "I, Mat Silverstein, sign this W-9 on 2026-04-16 for an integration test.",
      user_confirmed_at: now.toISOString(),
    });
    expect(statement).toContain("Mat Silverstein");
    expect(confirmedAt).toBeInstanceOf(Date);

    // ── 5. Stamp the signature ──
    await stampSignatureOnPage(pdfDoc, {
      style: "typed",
      display_name: "Mat Silverstein",
    }, {
      page: 1,
      x: 100,
      y: 700,
      width: 200,
      height: 32,
      drawAuditLine: true,
      auditText: `Signed by Mat Silverstein at ${confirmedAt.toISOString()}`,
    });

    // ── 6. Write audit trail to Keywords metadata ──
    const auditLine = formatSigningAuditLine({
      display_name: "Mat Silverstein",
      statement,
      confirmedAt,
    });
    const existingKeywords = pdfDoc.getKeywords() || "";
    pdfDoc.setKeywords([existingKeywords ? `${existingKeywords}\n${auditLine}` : auditLine]);
    pdfDoc.setModificationDate(now);

    const signedPath = path.join(TMP_DIR, "fw9-integration-signed.pdf");
    await fs.writeFile(signedPath, await pdfDoc.save());

    // ── 7. Re-open the signed output and verify ──
    const verifyBytes = await fs.readFile(signedPath);
    const verifyDoc = await PDFDocument.load(verifyBytes, { ignoreEncryption: true });
    expect(verifyDoc.getPageCount()).toBe(pageCount); // page count preserved
    const keywords = verifyDoc.getKeywords() || "";
    expect(keywords).toContain("signed via pdf-toolkit");
    expect(keywords).toContain("Mat Silverstein");
    expect(keywords).toContain("integration test");

    // ── 8. Confirm the filled text survives the round-trip ──
    const verifyForm = verifyDoc.getForm();
    const verifyFields = verifyForm.getFields();
    const verifyTextField = verifyFields.find(f => f.constructor.name.includes("TextField") && f.getName() === firstTextField.getName());
    expect(verifyTextField).toBeTruthy();
    expect(verifyTextField.getText()).toBe("Mat Silverstein — Integration Test");

    // ── 9. File size sanity ──
    const stat = await fs.stat(signedPath);
    expect(stat.size).toBeGreaterThan(50_000);
    expect(stat.size).toBeLessThan(2_000_000); // shouldn't balloon
  }, 30_000); // allow up to 30s for network + pdf-lib

  it("rejects the demo URL that defeated Lumin (Sandy Springs) only if its content is not a PDF", async () => {
    // The Sandy Springs URL was the motivating case. We don't need to fill it —
    // just prove fetch works where Claude's WebFetch fails.
    const SANDY_URL = "https://up.sandyspringsga.gov/sites/default/files/2024-06/New%20Business%20License%20Application.pdf";
    const result = await downloadPdfFromUrl(SANDY_URL, {
      destinationDir: TMP_DIR,
      filename: "sandy-springs-integration.pdf",
      overwrite: true,
    });
    expect(result.bytes).toBeGreaterThan(100_000);
    expect(result.contentType).toContain("pdf");
    const bytes = await fs.readFile(result.path);
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  }, 30_000);
});
