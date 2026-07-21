import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LatestPathRequestState,
  getCanvasBufferSize,
  getSignPanelStatus,
  getWrappedFocusIndex,
  getZoneDescriptorKey,
} from "../ui/src/sign-mode-utils";

const viewerSource = readFileSync("ui/src/mcp-app.ts", "utf8");
const viewerMarkup = readFileSync("ui/index.html", "utf8");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settleZoneRequest<T>(
  state: LatestPathRequestState<T>,
  ticket: ReturnType<LatestPathRequestState<T>["begin"]>,
  result: Promise<T>,
  getCurrentPath: () => string,
  applyCurrent: (value: T | null) => void,
  renderCurrent: () => void,
) {
  try {
    const value = await result;
    if (state.succeedForCurrent(ticket, getCurrentPath(), value)) applyCurrent(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (state.failForCurrent(ticket, getCurrentPath(), message)) applyCurrent(null);
  } finally {
    if (state.finishForCurrent(ticket, getCurrentPath())) renderCurrent();
  }
}

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

  it("uses a stable path-aware descriptor for replacement zone-row focus", () => {
    const zone = { type: "signature", page: 2, x: 72.04, y: 181.06 };
    expect(getZoneDescriptorKey("/documents/a.pdf", zone))
      .toBe("/documents/a.pdf|signature|2|72.0|181.1");
    expect(getZoneDescriptorKey("/documents/b.pdf", zone))
      .not.toBe(getZoneDescriptorKey("/documents/a.pdf", zone));
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

  });

  it("does not let a stale A success populate B or clear B loading before B fails", async () => {
    const state = new LatestPathRequestState<string[]>();
    const a = deferred<string[]>();
    const b = deferred<string[]>();
    let currentPath = "A.pdf";
    let visibleZones: string[] | null = ["A-existing"];
    let renders = 0;

    const requestA = state.begin(currentPath);
    const taskA = settleZoneRequest(
      state,
      requestA,
      a.promise,
      () => currentPath,
      value => { visibleZones = value; },
      () => { renders++; },
    );

    currentPath = "B.pdf";
    visibleZones = ["B-existing"];
    const requestB = state.begin(currentPath);
    const taskB = settleZoneRequest(
      state,
      requestB,
      b.promise,
      () => currentPath,
      value => { visibleZones = value; },
      () => { renders++; },
    );

    a.resolve(["A-zone"]);
    await taskA;
    expect(state.getValue("A.pdf")).toEqual(["A-zone"]);
    expect(state.isLoading("B.pdf")).toBe(true);
    expect(state.getError("B.pdf")).toBeNull();
    expect(visibleZones).toEqual(["B-existing"]);
    expect(renders).toBe(0);

    b.reject(new Error("B detector failed"));
    await taskB;
    expect(state.isLoading("B.pdf")).toBe(false);
    expect(state.getError("B.pdf")).toBe("B detector failed");
    expect(visibleZones).toBeNull();
    expect(renders).toBe(1);
  });

  it("does not let a stale A failure clear or render B before B succeeds", async () => {
    const state = new LatestPathRequestState<string[]>();
    const a = deferred<string[]>();
    const b = deferred<string[]>();
    let currentPath = "A.pdf";
    let visibleZones: string[] | null = ["A-existing"];
    let renders = 0;

    const requestA = state.begin(currentPath);
    const taskA = settleZoneRequest(
      state,
      requestA,
      a.promise,
      () => currentPath,
      value => { visibleZones = value; },
      () => { renders++; },
    );

    currentPath = "B.pdf";
    visibleZones = ["B-existing"];
    const requestB = state.begin(currentPath);
    const taskB = settleZoneRequest(
      state,
      requestB,
      b.promise,
      () => currentPath,
      value => { visibleZones = value; },
      () => { renders++; },
    );

    a.reject(new Error("A detector failed"));
    await taskA;
    expect(state.getError("A.pdf")).toBe("A detector failed");
    expect(state.isLoading("B.pdf")).toBe(true);
    expect(state.getError("B.pdf")).toBeNull();
    expect(visibleZones).toEqual(["B-existing"]);
    expect(renders).toBe(0);

    b.resolve(["B-zone"]);
    await taskB;
    expect(state.isLoading("B.pdf")).toBe(false);
    expect(state.getValue("B.pdf")).toEqual(["B-zone"]);
    expect(state.getError("B.pdf")).toBeNull();
    expect(visibleZones).toEqual(["B-zone"]);
    expect(renders).toBe(1);
  });

  it("ignores an older token for the same path", () => {
    const state = new LatestPathRequestState<string[]>();
    const oldRequest = state.begin("A.pdf");
    const latestRequest = state.begin("A.pdf");

    expect(state.succeedForCurrent(oldRequest, "A.pdf", ["stale"])).toBe(false);
    expect(state.finishForCurrent(oldRequest, "A.pdf")).toBe(false);
    expect(state.isLoading("A.pdf")).toBe(true);
    expect(state.getValue("A.pdf")).toBeUndefined();

    expect(state.succeedForCurrent(latestRequest, "A.pdf", ["latest"])).toBe(true);
    expect(state.finishForCurrent(latestRequest, "A.pdf")).toBe(true);
    expect(state.getValue("A.pdf")).toEqual(["latest"]);
    expect(state.isLoading("A.pdf")).toBe(false);
  });
});
