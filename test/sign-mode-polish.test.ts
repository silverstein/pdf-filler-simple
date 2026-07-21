import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getCanvasBufferSize,
  getSignPanelStatus,
  getWrappedFocusIndex,
} from "../ui/src/sign-mode-utils";

const viewerSource = readFileSync("ui/src/mcp-app.ts", "utf8");
const viewerMarkup = readFileSync("ui/index.html", "utf8");

describe("sign mode polish", () => {
  it("sizes the drawing buffer for the device pixel ratio", () => {
    expect(getCanvasBufferSize(560, 200, 2)).toEqual({ width: 1120, height: 400, dpr: 2 });
    expect(getCanvasBufferSize(279.5, 99.5, 1.5)).toEqual({ width: 419, height: 149, dpr: 1.5 });
    expect(getCanvasBufferSize(560, 200, 0.8)).toEqual({ width: 448, height: 160, dpr: 0.8 });
    expect(getCanvasBufferSize(560, 200, Number.NaN)).toEqual({ width: 560, height: 200, dpr: 1 });
    expect(viewerSource).toContain("resizeDrawCanvasForDpr();");
  });

  it("wraps modal focus in both directions and makes the canvas focusable", () => {
    expect(getWrappedFocusIndex(2, 3, false)).toBe(0);
    expect(getWrappedFocusIndex(0, 3, true)).toBe(2);
    expect(getWrappedFocusIndex(-1, 3, false)).toBe(0);
    expect(getWrappedFocusIndex(-1, 3, true)).toBe(2);
    expect(viewerMarkup).toMatch(/id="draw-canvas"[^>]*tabindex="0"[^>]*aria-label=/);
    expect(viewerSource).toContain("viewerEl.toggleAttribute(\"inert\"");
    expect(viewerSource).toContain("trapModalFocus(signModalEl, keyEvent)");
    expect(viewerSource).toContain("trapModalFocus(drawModalEl, keyEvent)");
    expect(viewerSource).toContain("trapModalFocus(regionPreviewModalEl, keyEvent)");
  });

  it("keeps a captured stroke alive when the pointer leaves the canvas", () => {
    expect(viewerSource).toContain("drawCanvasEl.setPointerCapture(e.pointerId)");
    expect(viewerSource).not.toContain("drawCanvasEl.addEventListener(\"pointerleave\"");
    expect(viewerSource).toContain("e.pointerId !== drawPointerId");
  });

  it("keeps sign-panel rows keyboard accessible", () => {
    expect(viewerSource).toContain("item.setAttribute(\"role\", \"button\")");
    expect(viewerSource).toContain("item.tabIndex = 0");
    expect(viewerSource).toMatch(/e\.key === "Enter" \|\| e\.key === " "/);
  });

  it("caches detected zones by PDF path", () => {
    expect(viewerSource).toContain("zoneCacheByPath.has(pdfPath)");
    expect(viewerSource).toContain("zoneCacheByPath.get(pdfPath)");
    expect(viewerSource).toContain("zoneCacheByPath.set(pdfPath, zones)");
  });

  it("preserves a detection error through later panel renders", () => {
    const errorStatus = getSignPanelStatus({
      count: 0,
      loading: false,
      detectionError: "simulated detector outage",
      inspectArmed: false,
    });
    expect(errorStatus).toEqual({
      message: "Detection failed: simulated detector outage",
      tone: "error",
    });

    expect(getSignPanelStatus({
      count: 2,
      loading: false,
      detectionError: "simulated detector outage",
      inspectArmed: false,
    })).toEqual(errorStatus);

    expect(getSignPanelStatus({
      count: 0,
      loading: false,
      detectionError: null,
      inspectArmed: false,
    }).tone).toBe("empty");

    expect(viewerSource).toContain("zoneDetectionErrorByPath.set(pdfPath");
    expect(viewerSource).toContain("zoneDetectionErrorByPath.delete(pdfPath)");
  });
});
