import { describe, expect, it } from "vitest";
import { getPdfToolLoadData } from "../ui/src/tool-result";

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

  it("prefers structuredContent when both payload styles are present", () => {
    const payload = getPdfToolLoadData({
      content: [],
      structuredContent: {
        pdfPath: "/tmp/from-structured.pdf",
        totalBytes: 4096,
        initialPage: 1,
      },
      _meta: {
        pdfPath: "/tmp/from-meta.pdf",
        totalBytes: 1024,
      },
    } as any);

    expect(payload?.pdfPath).toBe("/tmp/from-structured.pdf");
    expect(payload?.backupPath).toBeNull();
    expect(payload?.totalBytes).toBe(4096);
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
});
