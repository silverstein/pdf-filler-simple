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
