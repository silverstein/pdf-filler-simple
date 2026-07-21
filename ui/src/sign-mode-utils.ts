export type SignPanelStatusTone = "default" | "empty" | "error";

export interface SignPanelStatusInput {
  count: number;
  loading: boolean;
  detectionError: string | null;
  inspectArmed: boolean;
}

export function getSignPanelStatus({
  count,
  loading,
  detectionError,
  inspectArmed,
}: SignPanelStatusInput): { message: string; tone: SignPanelStatusTone } {
  if (loading) {
    return { message: "Detecting signature zones…", tone: "default" };
  }
  if (inspectArmed) {
    return {
      message: "Inspect mode armed. Drag a rectangle on the PDF to preview that region.",
      tone: "default",
    };
  }
  if (detectionError) {
    return { message: `Detection failed: ${detectionError}`, tone: "error" };
  }
  if (count === 0) {
    return {
      message: "No signature zones detected. The form may be flat/scanned, or use an unusual layout.",
      tone: "empty",
    };
  }
  return {
    message: "Click a zone to sign it. Unknown spot? Drag on the PDF to create a custom zone.",
    tone: "default",
  };
}

export function getCanvasBufferSize(cssWidth: number, cssHeight: number, rawDpr: number) {
  const dpr = Number.isFinite(rawDpr) && rawDpr > 0 ? rawDpr : 1;
  return {
    width: Math.max(1, Math.round(cssWidth * dpr)),
    height: Math.max(1, Math.round(cssHeight * dpr)),
    dpr,
  };
}

export function getWrappedFocusIndex(currentIndex: number, itemCount: number, backwards: boolean) {
  if (itemCount <= 0) return -1;
  if (currentIndex < 0) return backwards ? itemCount - 1 : 0;
  if (backwards && currentIndex === 0) return itemCount - 1;
  if (!backwards && currentIndex === itemCount - 1) return 0;
  return currentIndex + (backwards ? -1 : 1);
}
