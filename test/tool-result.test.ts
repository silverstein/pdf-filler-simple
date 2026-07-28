import { describe, expect, it } from "vitest";
import {
  getPdfToolInputData,
  getPdfToolLoadData,
  isDisplayPdfTextResult,
  parsePdfToolLoadData,
} from "../ui/src/tool-result";

describe("getPdfToolLoadData", () => {
  it("reads PDF load metadata from tool _meta payloads", () => {
    const payload = getPdfToolLoadData({
      content: [],
      _meta: {
        pdfPath: "C:\\Users\\alice\\Documents\\filled.pdf",
        totalBytes: 2048,
        initialPage: 2,
        viewUUID: "view-123",
      },
    } as any);

    expect(payload).toMatchObject({
      pdfPath: "C:\\Users\\alice\\Documents\\filled.pdf",
      activePath: undefined,
      backupPath: null,
      totalBytes: 2048,
      initialPage: 2,
      viewUUID: "view-123",
    });
  });

  it("accepts identical redundant payloads", () => {
    const payload = getPdfToolLoadData({
      content: [],
      structuredContent: {
        pdfPath: "/tmp/same.pdf",
        totalBytes: 4096,
        initialPage: 1,
      },
      _meta: {
        pdfPath: "/tmp/same.pdf",
        totalBytes: 4096,
        initialPage: 1,
      },
    } as any);

    expect(payload?.pdfPath).toBe("/tmp/same.pdf");
    expect(payload?.backupPath).toBeNull();
    expect(payload?.totalBytes).toBe(4096);
  });

  it("fails closed when redundant payloads conflict", () => {
    const result = {
      content: [],
      structuredContent: {
        pdfPath: "/tmp/from-structured.pdf",
        totalBytes: 4096,
        initialPage: 1,
      },
      _meta: {
        pdfPath: "/tmp/from-meta.pdf",
        totalBytes: 1024,
        initialPage: 1,
      },
    } as any;

    expect(getPdfToolLoadData(result)).toBeNull();
    expect(parsePdfToolLoadData(result)).toMatchObject({
      ok: false,
      kind: "conflict",
      message: expect.stringContaining("pdfPath"),
    });
  });

  it("accepts signing-tool payloads that include viewer reload metadata plus extra fields", () => {
    const payload = getPdfToolLoadData({
      content: [],
      structuredContent: {
        pdfPath: "/tmp/form-signed.pdf",
        totalBytes: 8192,
        initialPage: 3,
        pdf_path: "/tmp/form-signed.pdf",
        page: 3,
        signer: "Mat Silverstein",
      },
      _meta: {
        ui: { resourceUri: "ui://pdf-toolkit/viewer" },
        pdfPath: "/tmp/form-signed.pdf",
        totalBytes: 8192,
        initialPage: 3,
      },
    } as any);

    expect(payload).toMatchObject({
      pdfPath: "/tmp/form-signed.pdf",
      totalBytes: 8192,
      initialPage: 3,
    });
  });

  it("captures canonical active_path and backup_path when present", () => {
    const payload = getPdfToolLoadData({
      content: [],
      structuredContent: {
        pdfPath: "/tmp/form.pdf",
        active_path: "/tmp/form.pdf",
        backup_path: "/tmp/backups/form__2026-04-21.pdf",
        totalBytes: 1024,
        initialPage: 1,
      },
    } as any);

    expect(payload).toMatchObject({
      pdfPath: "/tmp/form.pdf",
      activePath: "/tmp/form.pdf",
      backupPath: "/tmp/backups/form__2026-04-21.pdf",
    });
  });

  it.each([
    {
      name: "zero byte length",
      result: { content: [], structuredContent: { pdfPath: "/tmp/a.pdf", totalBytes: 0 } },
      kind: "invalid",
    },
    {
      name: "non-integer byte length",
      result: { content: [], structuredContent: { pdfPath: "/tmp/a.pdf", totalBytes: 2.5 } },
      kind: "invalid",
    },
    {
      name: "blank path",
      result: { content: [], structuredContent: { pdfPath: " ", totalBytes: 20 } },
      kind: "invalid",
    },
    {
      name: "path without byte length",
      result: { content: [], _meta: { pdfPath: "/tmp/a.pdf" } },
      kind: "incomplete",
    },
    {
      name: "content only",
      result: { content: [{ type: "text", text: "Displaying: a.pdf (1 KB)" }] },
      kind: "missing",
    },
  ])("rejects $name rather than exposing a zero-page viewer", ({ result, kind }) => {
    expect(parsePdfToolLoadData(result as any)).toMatchObject({
      ok: false,
      kind,
    });
  });

  it("rejects conflicting form-field payloads", () => {
    expect(parsePdfToolLoadData({
      content: [],
      structuredContent: {
        pdfPath: "/tmp/form.pdf",
        totalBytes: 1024,
        fields: [{ name: "A" }],
      },
      _meta: {
        pdfPath: "/tmp/form.pdf",
        totalBytes: 1024,
        fields: [{ name: "B" }],
      },
    } as any)).toMatchObject({
      ok: false,
      kind: "conflict",
      message: expect.stringContaining("fields"),
    });
  });
});

describe("getPdfToolInputData", () => {
  it.each([
    {
      params: {
        arguments: {
          pdf_path: "/Users/alice/Documents/form.pdf",
          page: 2.9,
        },
      },
      expected: {
        pdfPath: "/Users/alice/Documents/form.pdf",
        initialPage: 2,
      },
    },
    {
      params: {
        arguments: {
          pdf_path: "C:\\Users\\alice\\Documents\\form.pdf",
          page: -10,
        },
      },
      expected: {
        pdfPath: "C:\\Users\\alice\\Documents\\form.pdf",
        initialPage: 1,
      },
    },
  ])("captures complete cross-platform tool input", ({ params, expected }) => {
    expect(getPdfToolInputData(params)).toEqual(expected);
  });

  it.each([
    undefined,
    {},
    { arguments: null },
    { arguments: { pdf_path: "" } },
    { arguments: { pdf_path: 123 } },
  ])("rejects unusable input %#", params => {
    expect(getPdfToolInputData(params)).toBeNull();
  });
});

describe("isDisplayPdfTextResult", () => {
  it("recognizes the server's stable display_pdf text fallback", () => {
    expect(isDisplayPdfTextResult({
      content: [{ type: "text", text: "Displaying: agreement.pdf (48 KB)" }],
    } as any)).toBe(true);
  });

  it("does not classify mutation or error text as a display result", () => {
    expect(isDisplayPdfTextResult({
      content: [{ type: "text", text: "Saved signed PDF to /tmp/output.pdf" }],
    } as any)).toBe(false);
    expect(isDisplayPdfTextResult({
      content: [{ type: "text", text: "Displaying failed" }],
      isError: true,
    } as any)).toBe(false);
  });
});
