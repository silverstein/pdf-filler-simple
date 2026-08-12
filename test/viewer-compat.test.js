import { readFileSync } from "fs";
import { describe, it, expect } from "vitest";

/**
 * Guard against pdfjs-dist (or any dep) shipping ES2025+ APIs
 * that Claude Desktop's Electron/Chromium doesn't support.
 *
 * Background: pdfjs-dist 5.5+ introduced Map.prototype.getOrInsertComputed
 * (Chrome 134+) which silently broke the viewer in Claude Desktop's older
 * Chromium with "Failed to render page" errors. Server-side Node.js worked
 * fine, making the regression invisible without this check.
 */

const VIEWER_HTML = "dist-ui/index.html";

// ES2025+ APIs not yet available in Claude Desktop's Electron Chromium.
// Add new entries here as new incompatible APIs are discovered.
// NOTE: Math.sumPrecise is NOT listed because pdfjs-dist ships its own polyfill.
const BLOCKED_APIS = [
  { pattern: "getOrInsertComputed", spec: "ES2025 Map.getOrInsertComputed", chrome: "134+" },
];

describe("viewer Chromium compatibility", () => {
  let html;

  try {
    html = readFileSync(VIEWER_HTML, "utf-8");
  } catch {
    // dist-ui not built yet — skip gracefully
  }

  for (const { pattern, spec, chrome } of BLOCKED_APIS) {
    it(`must not use ${spec} (requires Chrome ${chrome})`, () => {
      if (!html) return; // skip if viewer not built
      expect(html).not.toContain(pattern);
    });
  }
});

/**
 * Guard against the viewer depending on a fetch the host may refuse.
 *
 * Background: the worker was imported with Vite's `?url`, which emitted it as a
 * ~2.7 MB `data:text/javascript` module and set it as GlobalWorkerOptions
 * .workerSrc. Claude Desktop allowed loading that secondary module; ChatGPT
 * desktop's component sandbox refused it, so `new Worker(dataUrl)` failed,
 * pdf.js fell back to its fake worker, and the fallback re-imported the same
 * rejected URL. The viewer showed "Setting up fake worker failed" and rendered
 * nothing, while the MCP tool call itself succeeded, so every server-side test
 * stayed green.
 *
 * The component must therefore carry its worker in-realm and fetch nothing.
 */
describe("viewer worker is self-contained", () => {
  let html;
  try {
    html = readFileSync(VIEWER_HTML, "utf-8");
  } catch {
    // dist-ui not built yet — skip gracefully
  }

  it("registers the worker in-realm rather than pointing at a URL", () => {
    if (!html) return;
    // pdf.js takes its no-fetch path only when this global is present.
    expect(html).toMatch(/globalThis\.pdfjsWorker\s*=/);
  });

  it("ships no data: script URL for the worker", () => {
    if (!html) return;
    // A data: module is a secondary load a sandboxed host may refuse.
    expect(html).not.toContain("data:text/javascript;base64");
  });

  it("does not set workerSrc to a fetchable URL", () => {
    if (!html) return;
    // Matches an assignment of a data:, blob:, http(s):, or ./ URL to
    // workerSrc. Any of those reintroduces a load the host can veto.
    expect(html).not.toMatch(/workerSrc\s*=\s*["'`](?:data:|blob:|https?:|\.\/)/);
  });
});

/**
 * A failing viewer must say enough to diagnose itself.
 *
 * When the `data:` worker was refused by a sandboxed host, the surfaced message
 * was only "Failed to fetch dynamically imported module" with no indication of
 * which asset, which scheme, or whether a worker was registered at all. That
 * cost hours. The error surface now reports the pdf.js version, the workerSrc
 * scheme and length, and whether the worker is registered in-realm.
 */
describe("viewer errors carry diagnostic context", () => {
  let html;
  try {
    html = readFileSync(VIEWER_HTML, "utf-8");
  } catch {
    // dist-ui not built yet — skip gracefully
  }

  it("reports whether the worker is registered in-realm", () => {
    if (!html) return;
    expect(html).toContain("worker NOT registered in-realm");
  });

  it("reports the workerSrc scheme rather than dumping the URL", () => {
    if (!html) return;
    // The URL itself can be megabytes of base64; the scheme and length are the
    // diagnostic parts.
    expect(html).toContain("workerSrc unset");
  });
});
