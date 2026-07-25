/**
 * Viewer page-box coordinate conversion.
 *
 * Zones cross the MCP boundary as top-left origin points relative to a page's
 * MediaBox. PDF.js works in absolute user space and exposes only the view
 * (CropBox intersected with MediaBox) through `viewport.viewBox`, so on a page
 * whose CropBox differs from its MediaBox the viewer cannot reconstruct the
 * right box unaided. `detect_signature_zones` therefore returns `page_geometry`
 * alongside the zones.
 *
 * These two functions are exact inverses and must always change together.
 * Fixing only one leaves overlay drawing and pointer reading disagreeing, which
 * is the same trap the server-side normalization hit: a detect-then-place round
 * trip looks correct while both halves are wrong.
 */

export interface PageBox {
  originX: number;
  originY: number;
  height: number;
}

export interface ZoneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Box-relative top-left zone -> absolute user-space rectangle
 * `[x1, y1, x2, y2]`, which is what `convertToViewportRectangle` expects.
 */
export function zoneToPdfRect(rect: ZoneRect, box: PageBox): [number, number, number, number] {
  const bottom = box.originY + (box.height - rect.y - rect.height);
  const left = box.originX + rect.x;
  return [left, bottom, left + rect.width, bottom + rect.height];
}

/**
 * Absolute user-space point (as returned by `convertToPdfPoint`) -> box-relative
 * top-left point, the space zones are expressed in.
 */
export function pdfPointToZonePoint(
  pdfX: number,
  pdfY: number,
  box: PageBox,
): [number, number] {
  return [pdfX - box.originX, (box.originY + box.height) - pdfY];
}

/**
 * Resolve the page box, preferring server-supplied geometry.
 *
 * The viewBox fallback covers early-load states before geometry arrives. It is
 * correct only when the CropBox and MediaBox coincide, which is why it is a
 * fallback rather than the source of truth.
 */
export function resolvePageBox(
  geometry: { origin_x: number; origin_y: number; height: number } | undefined,
  viewBox: number[] | undefined,
  fallbackHeight: number,
): PageBox {
  if (geometry) {
    return { originX: geometry.origin_x, originY: geometry.origin_y, height: geometry.height };
  }
  if (Array.isArray(viewBox) && viewBox.length >= 4) {
    return {
      originX: Math.min(viewBox[0], viewBox[2]),
      originY: Math.min(viewBox[1], viewBox[3]),
      height: Math.abs(viewBox[3] - viewBox[1]),
    };
  }
  return { originX: 0, originY: 0, height: fallbackHeight };
}
