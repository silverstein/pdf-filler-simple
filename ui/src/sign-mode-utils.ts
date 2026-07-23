export type SignPanelStatusTone = "default" | "empty" | "error";

export interface SignPanelStatusInput {
  count: number;
  loading: boolean;
  detectionError: string | null;
  inspectArmed: boolean;
}

export interface PathRequestTicket {
  path: string;
  token: number;
}

export class LatestPathRequestState<T> {
  #nextToken = 0;
  #activeTokens = new Map<string, number>();
  #values = new Map<string, T>();
  #errors = new Map<string, string>();

  begin(path: string): PathRequestTicket {
    const ticket = { path, token: ++this.#nextToken };
    this.#activeTokens.set(path, ticket.token);
    return ticket;
  }

  isLatest(ticket: PathRequestTicket) {
    return this.#activeTokens.get(ticket.path) === ticket.token;
  }

  isLoading(path: string) {
    return this.#activeTokens.has(path);
  }

  hasValue(path: string) {
    return this.#values.has(path);
  }

  getValue(path: string) {
    return this.#values.get(path);
  }

  getError(path: string) {
    return this.#errors.get(path) ?? null;
  }

  succeed(ticket: PathRequestTicket, value: T) {
    if (!this.isLatest(ticket)) return false;
    this.#values.set(ticket.path, value);
    this.#errors.delete(ticket.path);
    return true;
  }

  succeedForCurrent(ticket: PathRequestTicket, currentPath: string, value: T) {
    return this.succeed(ticket, value) && currentPath === ticket.path;
  }

  fail(ticket: PathRequestTicket, error: string) {
    if (!this.isLatest(ticket)) return false;
    this.#errors.set(ticket.path, error);
    return true;
  }

  failForCurrent(ticket: PathRequestTicket, currentPath: string, error: string) {
    return this.fail(ticket, error) && currentPath === ticket.path;
  }

  finish(ticket: PathRequestTicket) {
    if (!this.isLatest(ticket)) return false;
    this.#activeTokens.delete(ticket.path);
    return true;
  }

  finishForCurrent(ticket: PathRequestTicket, currentPath: string) {
    return this.finish(ticket) && currentPath === ticket.path;
  }

  deletePath(path: string) {
    this.#activeTokens.delete(path);
    this.#values.delete(path);
    this.#errors.delete(path);
  }

  clear() {
    this.#activeTokens.clear();
    this.#values.clear();
    this.#errors.clear();
  }
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

export function getZoneDescriptorKey(
  pdfPath: string,
  zone: { type: string; page: number; x: number; y: number },
) {
  return `${pdfPath}|${zone.type}|${zone.page}|${zone.x.toFixed(1)}|${zone.y.toFixed(1)}`;
}
