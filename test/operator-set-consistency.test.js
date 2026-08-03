import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function opNames(source, start, end) {
  return [...source.slice(start, end).matchAll(/pdfjsLib\.OPS\?\.(\w+)/g)].map(match => match[1]);
}

function setDifference(left, right) {
  return [...left].filter(value => !right.has(value)).sort();
}

describe("classification operator-set consistency", () => {
  it("keeps image and path/vector members aligned with layout extraction", async () => {
    const helpers = await fs.readFile(path.join(REPO_ROOT, "server/helpers.js"), "utf8");
    const layout = await fs.readFile(path.join(REPO_ROOT, "server/layout-extraction.js"), "utf8");

    const helperImageStart = helpers.indexOf("const imageOps = [");
    const helperGraphicsStart = helpers.indexOf("const graphicsOps = [", helperImageStart);
    const helperGraphicsEnd = helpers.indexOf("].filter", helperGraphicsStart);
    const layoutImageStart = layout.indexOf("function imageOperationSet");
    const layoutVectorStart = layout.indexOf("function vectorOperationSet", layoutImageStart);
    const layoutVectorEnd = layout.indexOf("].filter", layoutVectorStart);

    const helperImages = new Set(opNames(helpers, helperImageStart, helperGraphicsStart));
    const layoutImages = new Set(opNames(layout, layoutImageStart, layoutVectorStart));
    const helperVectors = new Set(opNames(helpers, helperGraphicsStart, helperGraphicsEnd));
    const layoutVectors = new Set(opNames(layout, layoutVectorStart, layoutVectorEnd));

    expect(setDifference(helperImages, layoutImages)).toEqual(["paintSolidColorImageMask"]);
    expect(setDifference(layoutImages, helperImages)).toEqual([]);
    // These helper-only operations preserve the existing broad graphics/blank
    // status contract; path/vector routing uses the shared intersection.
    expect(setDifference(helperVectors, layoutVectors)).toEqual([
      "beginAnnotation",
      "paintFormXObjectBegin",
      "paintXObject",
    ]);
    expect(setDifference(layoutVectors, helperVectors)).toEqual([]);
    expect([...helperImages].filter(name => layoutImages.has(name)).sort()).toEqual([
      "paintImageMaskXObject",
      "paintImageMaskXObjectGroup",
      "paintImageMaskXObjectRepeat",
      "paintImageXObject",
      "paintImageXObjectRepeat",
      "paintInlineImageXObject",
      "paintInlineImageXObjectGroup",
      "paintJpegXObject",
    ]);
    expect([...helperVectors].filter(name => layoutVectors.has(name)).sort()).toEqual([
      "closeEOFillStroke",
      "closeFillStroke",
      "closeStroke",
      "constructPath",
      "eoFill",
      "eoFillStroke",
      "fill",
      "fillStroke",
      "rawFillPath",
      "shadingFill",
      "stroke",
    ]);
  });
});
