/**
 * Viewer page-box coordinate conversion (bead pdf-toolkit-mcp-vk8.1).
 *
 * The viewer receives zones as top-left origin points relative to a page's
 * MediaBox, but PDF.js works in absolute user space and only exposes the view
 * (CropBox intersected with MediaBox). The viewer previously flipped the y axis
 * using the view height and passed the result straight to
 * `convertToViewportRectangle`, which expects absolute coordinates. On any page
 * where the two boxes differ, every overlay was displaced by the difference.
 *
 * The accepted rotated/cropped golden fixture is exactly such a page: MediaBox
 * [0 0 480 360] with CropBox [20 24 430 300]. The viewer computed against a
 * height of 276 while the server emitted against 360.
 *
 * The existing browser smoke lanes cannot catch this. They build their fixture
 * from example-fw9.pdf with only a rotation applied, so the MediaBox origin is
 * (0,0) and no CropBox exists, which is why reverting the fix produced
 * byte-identical smoke output. These assertions are the actual gate.
 */

import { describe, expect, it } from "vitest";
import {
  type PageBox,
  pdfPointToZonePoint,
  resolvePageBox,
  zoneToPdfRect,
} from "../ui/src/page-box.js";

// The accepted golden fixture's geometry.
const GOLDEN_MEDIA_BOX: PageBox = { originX: 0, originY: 0, height: 360 };
const GOLDEN_VIEW_BOX = [20, 24, 430, 300];

// A page whose MediaBox itself is offset, the case a viewer cannot reconstruct.
const OFFSET_MEDIA_BOX: PageBox = { originX: 40, originY: 60, height: 792 };

describe("zone to absolute user space", () => {
  it("adds the page box origin", () => {
    const rect = { x: 100, y: 200, width: 180, height: 20 };
    const [x1, y1, x2, y2] = zoneToPdfRect(rect, OFFSET_MEDIA_BOX);
    expect(x1).toBe(40 + 100);
    expect(y1).toBe(60 + (792 - 200 - 20));
    expect(x2).toBe(40 + 280);
    expect(y2).toBe(60 + (792 - 200));
    // The defect produced the un-offset rectangle.
    expect(x1).not.toBe(100);
    expect(y1).not.toBe(792 - 200 - 20);
  });

  it("is unchanged for a page whose box origin is zero", () => {
    const rect = { x: 72, y: 181, width: 240, height: 18 };
    expect(zoneToPdfRect(rect, GOLDEN_MEDIA_BOX)).toEqual([72, 360 - 181 - 18, 312, 360 - 181]);
  });

  it("uses the MediaBox height, not the cropped view height", () => {
    // This is the golden fixture's real discrepancy: 360 versus 276.
    const rect = { x: 72, y: 181, width: 240, height: 18 };
    const viaMediaBox = zoneToPdfRect(rect, GOLDEN_MEDIA_BOX);
    const viaViewBox = zoneToPdfRect(rect, resolvePageBox(undefined, GOLDEN_VIEW_BOX, 0));
    expect(viaMediaBox[1]).toBe(161);
    expect(viaViewBox[1]).not.toBe(viaMediaBox[1]);
    // 84 points of vertical displacement, plus the 20-point horizontal inset.
    expect(viaViewBox[1] - viaMediaBox[1]).toBe(-84 + 24);
    expect(viaViewBox[0] - viaMediaBox[0]).toBe(20);
  });
});

describe("absolute user space back to zone space", () => {
  it("removes the page box origin", () => {
    expect(pdfPointToZonePoint(140, 632, OFFSET_MEDIA_BOX)).toEqual([100, 220]);
  });

  it("round trips with zoneToPdfRect on an offset page", () => {
    // The two must be exact inverses. Fixing only one direction leaves drawing
    // and pointer reading disagreeing.
    const rect = { x: 100, y: 200, width: 180, height: 20 };
    const [x1, , , y2] = zoneToPdfRect(rect, OFFSET_MEDIA_BOX);
    expect(pdfPointToZonePoint(x1, y2, OFFSET_MEDIA_BOX)).toEqual([rect.x, rect.y]);
  });

  it("round trips on a zero-origin page too", () => {
    const rect = { x: 72, y: 181, width: 240, height: 18 };
    const [x1, , , y2] = zoneToPdfRect(rect, GOLDEN_MEDIA_BOX);
    expect(pdfPointToZonePoint(x1, y2, GOLDEN_MEDIA_BOX)).toEqual([rect.x, rect.y]);
  });
});

describe("page box resolution", () => {
  it("prefers server-supplied geometry over the cropped view", () => {
    const box = resolvePageBox(
      { origin_x: 0, origin_y: 0, height: 360 },
      GOLDEN_VIEW_BOX,
      0,
    );
    expect(box).toEqual({ originX: 0, originY: 0, height: 360 });
  });

  it("falls back to the view box when geometry has not arrived", () => {
    expect(resolvePageBox(undefined, GOLDEN_VIEW_BOX, 0)).toEqual({
      originX: 20,
      originY: 24,
      height: 276,
    });
  });

  it("normalizes a view box given in either corner order", () => {
    expect(resolvePageBox(undefined, [430, 300, 20, 24], 0)).toEqual({
      originX: 20,
      originY: 24,
      height: 276,
    });
  });

  it("falls back to the canvas height when nothing else is known", () => {
    expect(resolvePageBox(undefined, undefined, 500)).toEqual({
      originX: 0,
      originY: 0,
      height: 500,
    });
  });
});
