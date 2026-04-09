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
    expect(payload?.totalBytes).toBe(4096);
  });
});
