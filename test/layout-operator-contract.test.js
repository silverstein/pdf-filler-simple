import { createHash } from "node:crypto";
import { PDFDocument, rgb, clip, closePath, concatTransformationMatrix, endPath, lineTo, moveTo, popGraphicsState, pushGraphicsState } from "pdf-lib";
import { describe, expect, it } from "vitest";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractPdfLayout } from "../server/layout-extraction.js";

async function operatorList(bytes, pageNumber = 1) {
  const loadingTask = pdfjs.getDocument({ data: bytes.slice(), useWorkerFetch: false, isEvalSupported: false });
  const document = await loadingTask.promise;
  try {
    return await (await document.getPage(pageNumber)).getOperatorList();
  } finally {
    await document.destroy();
    await loadingTask.destroy();
  }
}

async function layoutFor(bytes, startPage = 1, endPage = startPage) {
  return extractPdfLayout({
    pdfjsLib: pdfjs,
    pdfBytes: bytes,
    sourcePath: "/synthetic/operator-contract.pdf",
    sourceFileName: "operator-contract.pdf",
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    requestedStartPage: startPage,
    requestedEndPage: endPage,
    maxOutputCharacters: 200000,
  });
}

describe("vendored PDF.js operator-list contract", () => {
  it("pins constructPath DrawOPS encoding for rectangles, lines, and clips", async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([300, 300]);
    page.drawRectangle({ x: 20, y: 30, width: 100, height: 50, color: rgb(1, 0, 0) });
    page.drawLine({ start: { x: 20, y: 150 }, end: { x: 120, y: 150 }, thickness: 2 });
    page.pushOperators(
      pushGraphicsState(),
      moveTo(10, 10),
      lineTo(100, 10),
      lineTo(100, 80),
      lineTo(10, 80),
      closePath(),
      clip(),
      endPath(),
      popGraphicsState(),
    );
    const bytes = await document.save({ useObjectStreams: false });
    const operators = await operatorList(bytes);
    const constructPaths = operators.fnArray
      .map((operation, index) => operation === pdfjs.OPS.constructPath ? index : -1)
      .filter(index => index >= 0);
    expect(constructPaths.length).toBeGreaterThanOrEqual(3);
    const rectangleIndex = constructPaths.find(index => operators.argsArray[index][0] === pdfjs.OPS.fill);
    expect(rectangleIndex).toBeDefined();
    expect(Array.from(operators.argsArray[rectangleIndex][1][0])).toEqual([
      0, 0, 0, 1, 0, 50, 1, 100, 50, 1, 100, 0, 4,
    ]);
    expect(Array.from(operators.argsArray[rectangleIndex][2])).toEqual([0, 0, 100, 50]);
    const lineIndex = constructPaths.find(index => operators.argsArray[index][0] === pdfjs.OPS.stroke);
    expect(lineIndex).toBeDefined();
    expect(Array.from(operators.argsArray[lineIndex][1][0])).toEqual([0, 20, 150, 0, 20, 150, 1, 120, 150]);
    const clipIndex = operators.fnArray.indexOf(pdfjs.OPS.clip);
    const clipPathIndex = operators.fnArray.indexOf(pdfjs.OPS.constructPath, clipIndex);
    expect(clipIndex).toBeGreaterThanOrEqual(0);
    expect(clipPathIndex).toBe(clipIndex + 1);
    expect(operators.argsArray[clipPathIndex][0]).toBe(pdfjs.OPS.endPath);
    expect(Array.from(operators.argsArray[clipPathIndex][1][0])).toEqual([
      0, 10, 10, 1, 100, 10, 1, 100, 80, 1, 10, 80, 4,
    ]);
  });

  it("covers transformed Form XObjects, composite paints, empty paths, and image paints", async () => {
    const document = await PDFDocument.create();
    const sourcePage = document.addPage([100, 100]);
    sourcePage.drawRectangle({ x: 10, y: 20, width: 30, height: 40, color: rgb(1, 0, 0) });
    const targetPage = document.addPage([300, 300]);
    const embedded = await document.embedPage(sourcePage);
    targetPage.drawPage(embedded, { x: 100, y: 120, width: 60, height: 80 });
    targetPage.drawRectangle({
      x: 10,
      y: 10,
      width: 30,
      height: 20,
      color: rgb(0, 1, 0),
      borderColor: rgb(0, 0, 0),
      borderWidth: 2,
    });
    const image = await document.embedPng(Uint8Array.from(Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    )));
    targetPage.drawImage(image, { x: 60, y: 200, width: 20, height: 20 });
    targetPage.drawImage(image, { x: 85, y: 200, width: 20, height: 20 });
    targetPage.pushOperators(endPath());
    const bytes = await document.save({ useObjectStreams: false });
    const operators = await operatorList(bytes, 2);
    const formStart = operators.fnArray.indexOf(pdfjs.OPS.paintFormXObjectBegin);
    const formEnd = operators.fnArray.indexOf(pdfjs.OPS.paintFormXObjectEnd);
    expect(formStart).toBeGreaterThanOrEqual(0);
    expect(formEnd).toBeGreaterThan(formStart);
    const compositePath = operators.fnArray
      .map((operation, index) => operation === pdfjs.OPS.constructPath && operators.argsArray[index][0] === pdfjs.OPS.fillStroke ? index : -1)
      .find(index => index >= 0);
    expect(compositePath).toBeDefined();
    const emptyPath = operators.fnArray
      .map((operation, index) => operation === pdfjs.OPS.constructPath && operators.argsArray[index][0] === pdfjs.OPS.endPath ? index : -1)
      .find(index => index >= 0);
    expect(emptyPath).toBeDefined();
    expect(operators.argsArray[emptyPath][1][0]).toBeNull();

    const layout = await layoutFor(bytes, 2);
    expect(layout.pages[0].ruled_rects.items).toEqual(expect.arrayContaining([
      { x: 106, y: 132, width: 18, height: 32, verb: "fill" },
      { x: 10, y: 270, width: 30, height: 20, verb: "fill" },
    ]));
    expect(layout.pages[0].operator_counts.path_construct_ops).toBeGreaterThanOrEqual(3);
    expect(layout.pages[0].operator_counts.path_segments).toBeGreaterThanOrEqual(10);
    expect(layout.pages[0].operator_counts.image_paint_ops).toBeGreaterThanOrEqual(1);
  });
});
