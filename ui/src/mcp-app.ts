/**
 * PDF Tools Viewer — MCP App
 *
 * Interactive PDF viewer with form field sidebar.
 * Uses ext-apps SDK for host communication.
 * PDF.js for rendering with TextLayer for text selection.
 */

import {
  App,
  type McpUiHostContext,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as pdfjsLib from "pdfjs-dist";
import { TextLayer } from "pdfjs-dist";
import "./mcp-app.css";

// PDF.js worker — inline as blob URL for single-file build
import PdfWorker from "pdfjs-dist/build/pdf.worker.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorker;

const MAX_CHUNK_BYTES = 524288; // 512KB — must match server
const MAX_MODEL_CONTEXT_LENGTH = 15000;
const MAX_ZOOM = 3.0;
const MIN_ZOOM = 0.5;
const ZOOM_STEP = 0.25;

// ─── State ───────────────────────────────────────────────────────────────────

let pdfDocument: pdfjsLib.PDFDocumentProxy | null = null;
let currentPage = 1;
let totalPages = 0;
let scale = 1.0;
let pdfPath = "";
let viewUUID: string | undefined;
let currentRenderTask: { cancel: () => void } | null = null;
let isRendering = false;
let pendingPage: number | null = null;
let currentDisplayMode: "inline" | "fullscreen" = "inline";

// Form fields
interface FieldInfo {
  name: string;
  type: string;
  options: string[];
  currentValue: string | boolean;
}
let fields: FieldInfo[] = [];
let selectedField: string | null = null;
let sidebarVisible = false;

// Search
let searchOpen = false;
let searchQuery = "";
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const pageTextCache = new Map<number, string>();
let allMatches: { pageNum: number; index: number; length: number }[] = [];
let currentMatchIndex = -1;
let fieldMatches: { fieldName: string; fieldIndex: number }[] = [];

// Preloading
let preloadPaused = false;
let pagesLoaded = 0;

// ─── DOM ─────────────────────────────────────────────────────────────────────

const $ = (id: string) => document.getElementById(id)!;

const mainEl = document.querySelector(".main") as HTMLElement;
const loadingEl = $("loading");
const loadingTextEl = $("loading-text");
const progressBar = $("progress-bar");
const errorEl = $("error");
const errorMessageEl = $("error-message");
const viewerEl = $("viewer");
const canvasContainerEl = document.querySelector(".canvas-container") as HTMLElement;
const canvasEl = $("pdf-canvas") as HTMLCanvasElement;
const textLayerEl = $("text-layer");
const highlightLayerEl = $("highlight-layer");
const titleEl = $("pdf-title");
const pageInputEl = $("page-input") as HTMLInputElement;
const totalPagesEl = $("total-pages");
const prevBtn = $("prev-btn") as HTMLButtonElement;
const nextBtn = $("next-btn") as HTMLButtonElement;
const zoomOutBtn = $("zoom-out-btn") as HTMLButtonElement;
const zoomInBtn = $("zoom-in-btn") as HTMLButtonElement;
const zoomLevelEl = $("zoom-level");
const searchBtn = $("search-btn") as HTMLButtonElement;
const fullscreenBtn = $("fullscreen-btn") as HTMLButtonElement;
const loadingIndicatorEl = $("loading-indicator");
const loadingIndicatorArc = loadingIndicatorEl.querySelector(".loading-indicator-arc") as SVGCircleElement;
const sidebarToggleBtn = $("sidebar-toggle-btn") as HTMLButtonElement;
const searchBarEl = $("search-bar");
const searchInputEl = $("search-input") as HTMLInputElement;
const searchMatchCountEl = $("search-match-count");
const searchPrevBtn = $("search-prev-btn") as HTMLButtonElement;
const searchNextBtn = $("search-next-btn") as HTMLButtonElement;
const searchCloseBtn = $("search-close-btn") as HTMLButtonElement;
const sidebarEl = $("sidebar");
const fieldsListEl = $("fields-list");
const fieldCountEl = $("field-count");
const fieldFilterEl = $("field-filter") as HTMLInputElement;
const fillProgressEl = $("fill-progress");
const fillProgressValueEl = $("fill-progress-value");
const fillProgressTextEl = $("fill-progress-text");

// ─── App ─────────────────────────────────────────────────────────────────────

const app = new App(
  { name: "PDF Tools Viewer", version: "1.0.0" },
  {},
  { autoResize: false },
);

// ─── UI State ────────────────────────────────────────────────────────────────

function showLoading(text: string) {
  loadingTextEl.textContent = text;
  loadingEl.style.display = "flex";
  errorEl.style.display = "none";
  viewerEl.style.display = "none";
}

function showError(message: string) {
  errorMessageEl.textContent = message;
  loadingEl.style.display = "none";
  errorEl.style.display = "block";
  viewerEl.style.display = "none";
}

function showViewer() {
  loadingEl.style.display = "none";
  errorEl.style.display = "none";
  viewerEl.style.display = "flex";
}

function updateControls() {
  titleEl.textContent = pdfPath.split("/").pop() || pdfPath;
  titleEl.title = pdfPath;
  pageInputEl.value = String(currentPage);
  pageInputEl.max = String(totalPages);
  totalPagesEl.textContent = `of ${totalPages}`;
  prevBtn.disabled = currentPage <= 1;
  nextBtn.disabled = currentPage >= totalPages;
  zoomLevelEl.textContent = `${Math.round(scale * 100)}%`;
}

// ─── DOM Helpers ─────────────────────────────────────────────────────────────

function clearChildren(el: HTMLElement) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// ─── Chunked Loading ─────────────────────────────────────────────────────────

const rangeCache = new Map<string, { bytes: Uint8Array; totalBytes: number }>();
const inflightRequests = new Map<string, Promise<{ bytes: Uint8Array; totalBytes: number }>>();

async function fetchChunk(path: string, begin: number, end: number) {
  const key = `${path}:${begin}-${end}`;
  if (rangeCache.has(key)) return rangeCache.get(key)!;
  if (inflightRequests.has(key)) return inflightRequests.get(key)!;

  const request = (async () => {
    try {
      const result = await app.callServerTool({
        name: "read_pdf_bytes",
        arguments: { pdf_path: path, offset: begin, byteCount: end - begin },
      });

      if (result.isError) {
        const text = result.content?.map((c: any) => ("text" in c ? c.text : "")).join(" ") || "";
        throw new Error(text);
      }

      const sc = result.structuredContent as any;
      if (!sc?.bytes) throw new Error("No bytes in response");

      const raw = atob(sc.bytes);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

      const entry = { bytes, totalBytes: sc.totalBytes };
      rangeCache.set(key, entry);
      return entry;
    } finally {
      inflightRequests.delete(key);
    }
  })();

  inflightRequests.set(key, request);
  return request;
}

async function fetchRange(path: string, begin: number, end: number) {
  const size = end - begin;
  if (size <= MAX_CHUNK_BYTES) return fetchChunk(path, begin, end);

  const chunks: { begin: number; end: number }[] = [];
  for (let off = begin; off < end; off += MAX_CHUNK_BYTES) {
    chunks.push({ begin: off, end: Math.min(off + MAX_CHUNK_BYTES, end) });
  }

  const results = await Promise.all(chunks.map(c => fetchChunk(path, c.begin, c.end)));
  const totalLen = results.reduce((s, r) => s + r.bytes.length, 0);
  const combined = new Uint8Array(totalLen);
  let pos = 0;
  for (const r of results) { combined.set(r.bytes, pos); pos += r.bytes.length; }
  return { bytes: combined, totalBytes: results[0].totalBytes };
}

async function loadPdfProgressively(filePath: string, fileSize: number) {
  class AppRangeTransport extends pdfjsLib.PDFDataRangeTransport {
    requestDataRange(begin: number, end: number) {
      fetchRange(filePath, begin, end)
        .then(r => this.onDataRange(begin, r.bytes))
        .catch(err => console.error("[viewer] Range fetch error:", err));
    }
  }

  const transport = new AppRangeTransport(fileSize, null);
  const doc = await pdfjsLib.getDocument({ range: transport }).promise;
  return doc;
}

// ─── Page Rendering ──────────────────────────────────────────────────────────

async function renderPage() {
  if (!pdfDocument) return;

  if (isRendering) {
    pendingPage = currentPage;
    if (currentRenderTask) currentRenderTask.cancel();
    return;
  }

  isRendering = true;
  pendingPage = null;

  try {
    const pageNum = currentPage;
    const page = await pdfDocument.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvasEl.getContext("2d")!;

    canvasEl.width = viewport.width * dpr;
    canvasEl.height = viewport.height * dpr;
    canvasEl.style.width = `${viewport.width}px`;
    canvasEl.style.height = `${viewport.height}px`;
    ctx.scale(dpr, dpr);

    clearChildren(textLayerEl);
    textLayerEl.style.setProperty("--scale-factor", `${scale}`);

    const renderTask = (page as any).render({ canvasContext: ctx, viewport });
    currentRenderTask = renderTask;

    try {
      await renderTask.promise;
    } catch (err: any) {
      if (err?.name === "RenderingCancelledException") return;
      throw err;
    } finally {
      currentRenderTask = null;
    }

    if (pageNum !== currentPage) return;

    // TextLayer for selection
    const textContent = await page.getTextContent();
    const textLayer = new TextLayer({
      textContentSource: textContent,
      container: textLayerEl,
      viewport,
    });
    await textLayer.render();

    // Cache page text
    if (!pageTextCache.has(pageNum)) {
      const items = (textContent.items as { str?: string }[]).map(i => i.str || "");
      pageTextCache.set(pageNum, items.join(""));
    }

    // Highlight layer
    highlightLayerEl.style.width = `${viewport.width}px`;
    highlightLayerEl.style.height = `${viewport.height}px`;

    if (searchOpen && searchQuery) renderHighlights();

    updateControls();
    updatePageContext();
    requestFitToContent();
  } catch (err: any) {
    console.error("[viewer] Render error:", err);
    showError(`Failed to render page ${currentPage}`);
  } finally {
    preloadPaused = false;
    isRendering = false;

    if (pendingPage !== null) {
      const next = pendingPage;
      pendingPage = null;
      currentPage = next;
      renderPage();
    }
  }
}

function requestFitToContent() {
  if (currentDisplayMode === "fullscreen") return;

  // Defer to next frame so the browser has reflowed after canvas resize
  requestAnimationFrame(() => {
    const toolbarEl = document.querySelector(".toolbar") as HTMLElement;
    const pageWrapperEl = document.querySelector(".page-wrapper") as HTMLElement;
    if (!toolbarEl || !pageWrapperEl) return;

    const containerStyle = getComputedStyle(canvasContainerEl);
    const paddingTop = parseFloat(containerStyle.paddingTop);
    const paddingBottom = parseFloat(containerStyle.paddingBottom);
    const searchBarHeight = searchOpen ? (document.getElementById("search-bar")?.offsetHeight || 0) : 0;

    // Use the actual canvas CSS height as the most reliable measurement
    const canvasHeight = parseFloat(canvasEl.style.height) || pageWrapperEl.offsetHeight;
    const total = toolbarEl.offsetHeight + searchBarHeight + paddingTop + canvasHeight + paddingBottom + 16;

    // Minimum 400px so the viewer is always usable
    const height = Math.max(400, Math.min(total, 900));
    app.sendSizeChanged({ height });
  });
}

// ─── Navigation ──────────────────────────────────────────────────────────────

function goToPage(page: number) {
  const target = Math.max(1, Math.min(page, totalPages));
  if (target !== currentPage) {
    preloadPaused = true;
    currentPage = target;
    saveCurrentPage();
    renderPage();
  }
  pageInputEl.value = String(currentPage);
}

function saveCurrentPage() {
  if (viewUUID) {
    try { localStorage.setItem(viewUUID, String(currentPage)); } catch {}
  }
}

function loadSavedPage(): number | null {
  if (!viewUUID) return null;
  try {
    const v = localStorage.getItem(viewUUID);
    if (v) { const p = parseInt(v, 10); if (!isNaN(p) && p >= 1) return p; }
  } catch {}
  return null;
}

// ─── Zoom ────────────────────────────────────────────────────────────────────

function zoomIn() { scale = Math.min(scale + ZOOM_STEP, MAX_ZOOM); renderPage(); }
function zoomOut() { scale = Math.max(scale - ZOOM_STEP, MIN_ZOOM); renderPage(); }
function resetZoom() { scale = 1.0; renderPage(); }

// ─── Fullscreen ──────────────────────────────────────────────────────────────

async function toggleFullscreen() {
  const ctx = app.getHostContext();
  if (!ctx?.availableDisplayModes?.includes("fullscreen")) return;
  const newMode = currentDisplayMode === "fullscreen" ? "inline" : "fullscreen";
  try {
    const result = await app.requestDisplayMode({ mode: newMode });
    currentDisplayMode = result.mode as "inline" | "fullscreen";
    mainEl.classList.toggle("fullscreen", currentDisplayMode === "fullscreen");
    fullscreenBtn.title = currentDisplayMode === "fullscreen" ? "Exit fullscreen" : "Fullscreen";
  } catch {}
}

// ─── Model Context ───────────────────────────────────────────────────────────

async function updatePageContext() {
  if (!pdfDocument) return;
  try {
    const pageText = pageTextCache.get(currentPage) || "";
    const sel = window.getSelection();
    const selectedText = sel?.toString().trim();
    let content = pageText.slice(0, MAX_MODEL_CONTEXT_LENGTH);
    if (pageText.length > MAX_MODEL_CONTEXT_LENGTH) content += "\n<truncated-content/>";

    if (selectedText && selectedText.length > 2) {
      const idx = content.indexOf(selectedText);
      if (idx >= 0) {
        content = content.slice(0, idx) + `<pdf-selection>${selectedText}</pdf-selection>` + content.slice(idx + selectedText.length);
      }
    }

    const fileName = pdfPath.split("/").pop() || pdfPath;
    const header = `PDF Tools Viewer | "${fileName}" | Page ${currentPage}/${totalPages}`;
    let contextText = `${header}\n\nPage content:\n${content}`;

    if (selectedField) {
      contextText += `\n\nSelected form field: ${selectedField}`;
    }

    app.updateModelContext({ content: [{ type: "text", text: contextText }] });
  } catch {}
}

// ─── Search ──────────────────────────────────────────────────────────────────

function performSearch(query: string) {
  allMatches = [];
  currentMatchIndex = -1;
  searchQuery = query;

  if (!query) {
    updateSearchUI();
    clearHighlights();
    fieldMatches = [];
    if (fields.length > 0) renderFields();
    return;
  }

  const lower = query.toLowerCase();
  for (let p = 1; p <= totalPages; p++) {
    const text = pageTextCache.get(p);
    if (!text) continue;
    const lt = text.toLowerCase();
    let idx = 0;
    while (true) {
      const found = lt.indexOf(lower, idx);
      if (found === -1) break;
      allMatches.push({ pageNum: p, index: found, length: query.length });
      idx = found + 1;
    }
  }

  // Also search form field names and values
  fieldMatches = [];
  if (fields.length > 0) {
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const val = String(f.currentValue || "").toLowerCase();
      const name = f.name.toLowerCase();
      if ((val && val.includes(lower)) || name.includes(lower)) {
        fieldMatches.push({ fieldName: f.name, fieldIndex: i });
      }
    }
    if (fieldMatches.length > 0) {
      renderFields();
      if (!sidebarVisible) showSidebar();
    }
  }

  if (allMatches.length > 0) {
    const i = allMatches.findIndex(m => m.pageNum >= currentPage);
    currentMatchIndex = i >= 0 ? i : 0;
  }

  updateSearchUI();
  renderHighlights();

  if (allMatches.length > 0 && currentMatchIndex >= 0) {
    const m = allMatches[currentMatchIndex];
    if (m.pageNum !== currentPage) goToPage(m.pageNum);
  }
}

function renderHighlights() {
  clearHighlights();
  if (!searchQuery || allMatches.length === 0) return;

  const spans = Array.from(textLayerEl.querySelectorAll("span")) as HTMLElement[];
  if (spans.length === 0) return;

  const pageMatches = allMatches.filter(m => m.pageNum === currentPage);
  if (pageMatches.length === 0) return;

  const lower = searchQuery.toLowerCase();
  const wrapperEl = textLayerEl.parentElement!;
  const wrapperRect = wrapperEl.getBoundingClientRect();
  let matchOrd = 0;

  for (const span of spans) {
    const text = span.textContent || "";
    if (!text) continue;
    const lt = text.toLowerCase();
    if (!lt.includes(lower)) continue;

    const textNode = span.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue;

    let pos = 0;
    while (true) {
      const idx = lt.indexOf(lower, pos);
      if (idx === -1) break;

      const isCurrent = matchOrd < pageMatches.length &&
        allMatches.indexOf(pageMatches[matchOrd]) === currentMatchIndex;

      try {
        const range = document.createRange();
        range.setStart(textNode, idx);
        range.setEnd(textNode, Math.min(idx + lower.length, text.length));
        const rects = range.getClientRects();
        for (let r = 0; r < rects.length; r++) {
          const rect = rects[r];
          const div = document.createElement("div");
          div.className = "search-highlight" + (isCurrent ? " current" : "");
          div.style.position = "absolute";
          div.style.left = `${rect.left - wrapperRect.left}px`;
          div.style.top = `${rect.top - wrapperRect.top}px`;
          div.style.width = `${rect.width}px`;
          div.style.height = `${rect.height}px`;
          highlightLayerEl.appendChild(div);
        }
      } catch {}

      matchOrd++;
      pos = idx + 1;
    }
  }

  const currentHL = highlightLayerEl.querySelector(".search-highlight.current") as HTMLElement;
  if (currentHL) currentHL.scrollIntoView({ block: "center", behavior: "smooth" });
}

function clearHighlights() {
  clearChildren(highlightLayerEl);
}

function updateSearchUI() {
  const hasQuery = searchQuery.length > 0;
  const loading = totalPages > 0 && pagesLoaded < totalPages;
  const suffix = loading ? " (loading\u2026)" : "";
  const textCount = allMatches.length;
  const fCount = fieldMatches.length;

  if (textCount === 0 && fCount === 0) {
    searchMatchCountEl.textContent = hasQuery ? `No matches${suffix}` : "";
  } else {
    const parts: string[] = [];
    if (textCount > 0) parts.push(`${currentMatchIndex + 1} of ${textCount}`);
    if (fCount > 0) parts.push(`${fCount} field${fCount !== 1 ? "s" : ""}`);
    searchMatchCountEl.textContent = parts.join(", ") + suffix;
  }
  searchPrevBtn.disabled = allMatches.length === 0;
  searchNextBtn.disabled = allMatches.length === 0;
}

function openSearch() {
  if (searchOpen) { searchInputEl.focus(); searchInputEl.select(); return; }
  searchOpen = true;
  searchBarEl.style.display = "flex";
  updateSearchUI();
  searchInputEl.focus();
}

function closeSearch() {
  if (!searchOpen) return;
  searchOpen = false;
  searchBarEl.style.display = "none";
  searchQuery = "";
  searchInputEl.value = "";
  allMatches = [];
  currentMatchIndex = -1;
  fieldMatches = [];
  clearHighlights();
  if (fields.length > 0) renderFields();
}

function goToNextMatch() {
  if (allMatches.length === 0) return;
  currentMatchIndex = (currentMatchIndex + 1) % allMatches.length;
  updateSearchUI();
  const m = allMatches[currentMatchIndex];
  if (m.pageNum !== currentPage) goToPage(m.pageNum); else renderHighlights();
}

function goToPrevMatch() {
  if (allMatches.length === 0) return;
  currentMatchIndex = (currentMatchIndex - 1 + allMatches.length) % allMatches.length;
  updateSearchUI();
  const m = allMatches[currentMatchIndex];
  if (m.pageNum !== currentPage) goToPage(m.pageNum); else renderHighlights();
}

// ─── Form Field Sidebar ─────────────────────────────────────────────────────

function showSidebar() {
  sidebarVisible = true;
  sidebarEl.style.display = "flex";
  sidebarToggleBtn.textContent = "Hide Fields";
}

function hideSidebar() {
  sidebarVisible = false;
  sidebarEl.style.display = "none";
  sidebarToggleBtn.textContent = "Fields";
}

function toggleSidebar() {
  if (sidebarVisible) hideSidebar(); else showSidebar();
}

function renderFields() {
  clearChildren(fieldsListEl);

  if (fields.length === 0) {
    const el = document.createElement("div");
    el.className = "empty-state";
    el.textContent = "No form fields found";
    fieldsListEl.appendChild(el);
    fieldCountEl.textContent = "0 fields";
    return;
  }

  fieldCountEl.textContent = `${fields.length} field${fields.length !== 1 ? "s" : ""}`;

  const filled = fields.filter(f => f.currentValue !== "" && f.currentValue !== false).length;
  if (filled > 0 || fields.length > 0) {
    fillProgressEl.style.display = "flex";
    fillProgressValueEl.style.width = `${(filled / fields.length) * 100}%`;
    fillProgressTextEl.textContent = `${filled} of ${fields.length} filled`;
  }

  for (const field of fields) {
    const icons: Record<string, string> = { text: "T", checkbox: "\u2611", radio: "\u25C9", dropdown: "\u25BE", unknown: "?" };

    const item = document.createElement("div");
    const isSearchMatch = fieldMatches.some(fm => fm.fieldName === field.name);
    item.className = `field-item${selectedField === field.name ? " selected" : ""}${isSearchMatch ? " search-match" : ""}`;

    const header = document.createElement("div");
    header.className = "field-header";

    const badge = document.createElement("span");
    badge.className = `field-type-badge type-${field.type}`;
    badge.textContent = icons[field.type] || "?";

    const name = document.createElement("span");
    name.className = "field-name";
    name.title = field.name;
    name.textContent = field.name;

    header.append(badge, name);

    const details = document.createElement("div");
    details.className = "field-details";

    const typeLabel = document.createElement("span");
    typeLabel.className = "field-type-label";
    typeLabel.textContent = field.type;
    details.appendChild(typeLabel);

    if (field.currentValue !== "" && field.currentValue !== false) {
      const val = document.createElement("span");
      val.className = "field-value";
      val.title = String(field.currentValue);
      val.textContent = `= ${String(field.currentValue)}`;
      details.appendChild(val);
    } else {
      const empty = document.createElement("span");
      empty.className = "field-empty";
      empty.textContent = "empty";
      details.appendChild(empty);
    }

    item.append(header, details);

    if (field.options.length > 0) {
      const opts = document.createElement("div");
      opts.className = "field-options";
      opts.textContent = `Options: ${field.options.join(", ")}`;
      item.appendChild(opts);
    }

    item.addEventListener("click", () => {
      selectedField = field.name;
      renderFields();
      updatePageContext();
    });

    fieldsListEl.appendChild(item);
  }
}

// ─── Background Preloader ────────────────────────────────────────────────────

const CIRCLE_CIRCUMFERENCE = 2 * Math.PI * 8;

function updateLoadingIndicator() {
  if (totalPages <= 0) return;
  const pct = pagesLoaded / totalPages;
  loadingIndicatorArc.style.strokeDashoffset = String(CIRCLE_CIRCUMFERENCE * (1 - pct));
  loadingIndicatorEl.style.display = "inline-flex";
  loadingIndicatorEl.title = `${pagesLoaded}/${totalPages} pages indexed`;
}

async function startPreloading() {
  if (!pdfDocument) return;
  for (let i = 1; i <= totalPages; i++) {
    if (pageTextCache.has(i)) { pagesLoaded++; updateLoadingIndicator(); continue; }
    while (preloadPaused) await new Promise(r => setTimeout(r, 50));
    try {
      const page = await pdfDocument.getPage(i);
      const tc = await page.getTextContent();
      const items = (tc.items as { str?: string }[]).map(it => it.str || "");
      pageTextCache.set(i, items.join(""));
      pagesLoaded++;
      updateLoadingIndicator();
    } catch (err) {
      console.error("[viewer] Preload error page", i, err);
    }
  }

  // Done — fade out indicator
  setTimeout(() => {
    loadingIndicatorEl.style.opacity = "0";
    setTimeout(() => { loadingIndicatorEl.style.display = "none"; loadingIndicatorEl.style.opacity = ""; }, 300);
  }, 500);

  // Refresh search if active
  if (searchOpen && searchQuery) performSearch(searchQuery);
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

prevBtn.addEventListener("click", () => goToPage(currentPage - 1));
nextBtn.addEventListener("click", () => goToPage(currentPage + 1));
zoomOutBtn.addEventListener("click", zoomOut);
zoomInBtn.addEventListener("click", zoomIn);
searchBtn.addEventListener("click", () => { if (searchOpen) closeSearch(); else openSearch(); });
searchCloseBtn.addEventListener("click", closeSearch);
searchPrevBtn.addEventListener("click", goToPrevMatch);
searchNextBtn.addEventListener("click", goToNextMatch);
fullscreenBtn.addEventListener("click", toggleFullscreen);
sidebarToggleBtn.addEventListener("click", toggleSidebar);

searchInputEl.addEventListener("input", () => {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => performSearch(searchInputEl.value), 300);
});

searchInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? goToPrevMatch() : goToNextMatch(); }
  else if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
});

pageInputEl.addEventListener("change", () => {
  const p = parseInt(pageInputEl.value, 10);
  if (!isNaN(p)) goToPage(p); else pageInputEl.value = String(currentPage);
});

pageInputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") pageInputEl.blur(); });

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    if (!searchOpen) { e.preventDefault(); openSearch(); }
    else if (document.activeElement === searchInputEl) { closeSearch(); }
    else { e.preventDefault(); searchInputEl.focus(); searchInputEl.select(); }
    return;
  }

  if (document.activeElement === searchInputEl || document.activeElement === pageInputEl) return;

  if ((e.ctrlKey || e.metaKey) && e.key === "0") { resetZoom(); e.preventDefault(); return; }

  switch (e.key) {
    case "Escape":
      if (searchOpen) { closeSearch(); e.preventDefault(); }
      else if (currentDisplayMode === "fullscreen") { toggleFullscreen(); e.preventDefault(); }
      break;
    case "ArrowLeft": case "PageUp": goToPage(currentPage - 1); e.preventDefault(); break;
    case "ArrowRight": case "PageDown": case " ": goToPage(currentPage + 1); e.preventDefault(); break;
    case "+": case "=": zoomIn(); e.preventDefault(); break;
    case "-": zoomOut(); e.preventDefault(); break;
  }
});

// Text selection → update context
let selectionTimer: ReturnType<typeof setTimeout> | null = null;
document.addEventListener("selectionchange", () => {
  if (selectionTimer) clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    const sel = window.getSelection();
    if (sel?.toString().trim()?.length && sel.toString().trim().length > 2) updatePageContext();
  }, 300);
});

// Horizontal scroll/swipe for page navigation (at 1x zoom)
let hScrollAcc = 0;
canvasContainerEl.addEventListener("wheel", (e) => {
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
  if (scale > 1.0) return;
  e.preventDefault();
  hScrollAcc += e.deltaX;
  if (hScrollAcc > 50) { goToPage(currentPage + 1); hScrollAcc = 0; }
  else if (hScrollAcc < -50) { goToPage(currentPage - 1); hScrollAcc = 0; }
}, { passive: false });

// Field filter
fieldFilterEl.addEventListener("input", () => {
  const q = fieldFilterEl.value.toLowerCase();
  document.querySelectorAll(".field-item").forEach(el => {
    const name = el.querySelector(".field-name")?.textContent?.toLowerCase() || "";
    (el as HTMLElement).style.display = name.includes(q) ? "" : "none";
  });
});

// ─── Tool Result Handler ─────────────────────────────────────────────────────

app.ontoolresult = async (result: CallToolResult) => {
  console.log("[viewer] Tool result:", result);

  // Check if this is a display_pdf result
  // Try structuredContent first, fall back to _meta (host may not forward structuredContent to apps)
  const sc = result.structuredContent as any;
  const meta = result._meta as any;
  const data = (sc?.pdfPath && sc?.totalBytes) ? sc : (meta?.pdfPath && meta?.totalBytes) ? meta : null;

  if (data) {
    pdfPath = data.pdfPath;
    const totalBytes = data.totalBytes;
    const initialPage = data.initialPage || 1;
    viewUUID = meta?.viewUUID ? String(meta.viewUUID) : undefined;

    // Load form field data — check all possible sources
    const fieldData = (Array.isArray(data.fields) && data.fields.length > 0) ? data.fields
      : (Array.isArray(meta?.fields) && meta.fields.length > 0) ? meta.fields
      : (Array.isArray(sc?.fields) && sc.fields.length > 0) ? sc.fields
      : null;
    const fCount = data.fieldCount || meta?.fieldCount || sc?.fieldCount || 0;
    const hasFields = data.hasFormFields || meta?.hasFormFields || sc?.hasFormFields || false;

    if (hasFields && fCount > 0) {
      sidebarToggleBtn.style.display = "";
      sidebarToggleBtn.textContent = `Fields (${fCount})`;

      if (fieldData && Array.isArray(fieldData) && fieldData.length > 0) {
        fields = fieldData;
        renderFields();
      }
    }

    showLoading("Loading PDF...");

    try {
      pdfDocument = await loadPdfProgressively(pdfPath, totalBytes);
      totalPages = pdfDocument.numPages;

      // Restore saved page or use initial
      const saved = loadSavedPage();
      currentPage = (saved && saved <= totalPages) ? saved : initialPage;

      pagesLoaded = 0;
      pageTextCache.clear();

      showViewer();
      renderPage();
      startPreloading();
    } catch (err: any) {
      console.error("[viewer] Load error:", err);
      showError(err.message || "Failed to load PDF");
    }
    return;
  }

  // Otherwise, try to parse as read_pdf_fields result (has field JSON in text)
  try {
    const textContent = result.content?.find((c: any) => c.type === "text");
    if (textContent) {
      const jsonMatch = ((textContent as any).text as string).match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        fields = JSON.parse(jsonMatch[0]);
        renderFields();
        showSidebar();
        sidebarToggleBtn.style.display = "";
      }
    }

    // If we got a pdfPath in _meta, load the PDF for viewing alongside fields
    const meta = result._meta as any;
    if (meta?.pdfPath && !pdfDocument) {
      pdfPath = meta.pdfPath;
      viewUUID = meta.viewUUID ? String(meta.viewUUID) : undefined;

      // Probe file size with a 1-byte read
      try {
        const probe = await app.callServerTool({
          name: "read_pdf_bytes",
          arguments: { pdf_path: pdfPath, offset: 0, byteCount: 1 },
        });
        const probeSc = probe.structuredContent as any;
        if (probeSc?.totalBytes) {
          showLoading("Loading PDF...");
          pdfDocument = await loadPdfProgressively(pdfPath, probeSc.totalBytes);
          totalPages = pdfDocument.numPages;
          currentPage = 1;
          pagesLoaded = 0;
          pageTextCache.clear();
          showViewer();
          renderPage();
          startPreloading();
        }
      } catch (err: any) {
        console.error("[viewer] Failed to load PDF for field view:", err);
        showViewer();
      }
    } else if (!pdfDocument) {
      showViewer();
    }

    updatePageContext();
  } catch (err: any) {
    console.error("[viewer] Error processing tool result:", err);
    showError(err.message || "Error processing result");
  }
};

app.onerror = (err: unknown) => {
  console.error("[viewer] App error:", err);
  showError(err instanceof Error ? err.message : String(err));
};

// ─── Host Context ────────────────────────────────────────────────────────────

function handleHostContext(ctx: McpUiHostContext) {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.displayMode) {
    currentDisplayMode = ctx.displayMode as "inline" | "fullscreen";
    mainEl.classList.toggle("fullscreen", currentDisplayMode === "fullscreen");
    fullscreenBtn.title = currentDisplayMode === "fullscreen" ? "Exit fullscreen" : "Fullscreen";
    if (currentDisplayMode === "inline" && pdfDocument) requestFitToContent();
  }
}

app.onhostcontextchanged = handleHostContext;

// ─── Connect ─────────────────────────────────────────────────────────────────

app.connect().then(() => {
  console.log("[viewer] Connected");
  const ctx = app.getHostContext();
  if (ctx) handleHostContext(ctx);
});
