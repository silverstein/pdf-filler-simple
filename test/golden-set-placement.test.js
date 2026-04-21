/**
 * Golden-set signature-zone placement eval.
 *
 * Mirrors Shopify's autoresearch pattern at small scale: for each fixture,
 * run detectSignatureZones and score each detected zone against hand-labeled
 * ground-truth regions. A detected zone "hits" an expected zone if:
 *   - Same type
 *   - Same page
 *   - Detected box overlaps the expected region with IoU >= expected.min_iou
 *   OR the detected box is fully contained inside the expected region
 *
 * Ship gate: each fixture's score must meet its `min_score` threshold
 * (hit rate = hits / expected_zones.length).
 *
 * Run with OFFLINE=1 to skip URL-based fixtures.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { PDFDocument } from "pdf-lib";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  detectSignatureZones,
  downloadPdfFromUrl,
  computeIoU,
} from "../server/helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures", "golden-forms");
const CACHE_DIR = path.join(__dirname, "..", ".test-tmp-golden");
const OFFLINE = process.env.OFFLINE === "1";

if (typeof globalThis.DOMMatrix === "undefined") {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor(init) {
      const v = Array.isArray(init) ? init : [1, 0, 0, 1, 0, 0];
      this.a = v[0]; this.b = v[1]; this.c = v[2];
      this.d = v[3]; this.e = v[4]; this.f = v[5];
      this.is2D = true;
    }
    multiplySelf() { return this; } preMultiplySelf() { return this; } translateSelf() { return this; }
    scaleSelf() { return this; } rotateSelf() { return this; } invertSelf() { return this; }
    static fromMatrix(m) { return new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]); }
    static fromFloat32Array(a) { return new DOMMatrix(Array.from(a)); }
    static fromFloat64Array(a) { return new DOMMatrix(Array.from(a)); }
  };
}
if (typeof globalThis.Path2D === "undefined") {
  globalThis.Path2D = class Path2D { constructor() {} addPath() {} closePath() {} moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} arcTo() {} ellipse() {} rect() {} };
}
if (typeof globalThis.ImageData === "undefined") {
  globalThis.ImageData = class ImageData { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } };
}

let pdfjsLib;

async function loadPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  const mod = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjsLib = mod.default || mod;
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    import.meta.url
  ).href;
  pdfjsLib.GlobalWorkerOptions.isEvalSupported = false;
  return pdfjsLib;
}

async function resolveFixturePath(fixture) {
  if (fixture.source === "local") {
    return path.resolve(FIXTURES_DIR, fixture.path);
  }
  if (fixture.source === "url") {
    if (OFFLINE) return null;
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const cached = path.join(CACHE_DIR, `${fixture.id}.pdf`);
    try {
      await fs.access(cached);
      return cached;
    } catch {
      // not cached — download
    }
    const result = await downloadPdfFromUrl(fixture.url, {
      destinationDir: CACHE_DIR,
      filename: `${fixture.id}.pdf`,
      overwrite: true,
    });
    return result.path;
  }
  throw new Error(`Unknown fixture source: ${fixture.source}`);
}

// An expected zone is a region (x_min/x_max, y_min/y_max) rather than an exact box.
// Treat it as a rectangle when computing overlap with a detected box.
function expectedAsRect(expected) {
  return {
    x: expected.x_min,
    y: expected.y_min,
    width: expected.x_max - expected.x_min,
    height: expected.y_max - expected.y_min,
  };
}

// Score one detected zone against one expected region.
// Hit if: type matches AND page matches AND (IoU >= threshold OR fully contained).
function scoreZone(detected, expected) {
  if (detected.type !== expected.type) return { hit: false, iou: 0, reason: "type mismatch" };
  if (detected.page !== expected.page) return { hit: false, iou: 0, reason: "page mismatch" };
  const rect = expectedAsRect(expected);
  const iou = computeIoU(detected, rect);
  const fullyContained =
    detected.x >= rect.x &&
    detected.y >= rect.y &&
    detected.x + detected.width <= rect.x + rect.width + 0.5 &&
    detected.y + detected.height <= rect.y + rect.height + 0.5;
  const iouThreshold = expected.min_iou ?? 0.25;
  const hit = iou >= iouThreshold || fullyContained;
  return {
    hit,
    iou,
    fullyContained,
    reason: hit ? "match" : `IoU ${iou.toFixed(3)} < ${iouThreshold} and not contained`,
  };
}

describe("Golden-set signature-zone placement", () => {
  let expected;

  beforeAll(async () => {
    const raw = await fs.readFile(path.join(FIXTURES_DIR, "expected.json"), "utf8");
    expected = JSON.parse(raw);
    await loadPdfjs();
  }, 30_000);

  it("expected.json is well-formed", () => {
    expect(expected.fixtures).toBeDefined();
    expect(Array.isArray(expected.fixtures)).toBe(true);
    expect(expected.fixtures.length).toBeGreaterThan(0);
    for (const fx of expected.fixtures) {
      expect(fx.id).toBeTruthy();
      expect(fx.source).toMatch(/^(local|url)$/);
      expect(fx.expected_zones).toBeDefined();
      for (const z of fx.expected_zones) {
        expect(["signature", "initials", "date"]).toContain(z.type);
        expect(z.page).toBeGreaterThanOrEqual(1);
        expect(z.x_min).toBeLessThan(z.x_max);
        expect(z.y_min).toBeLessThan(z.y_max);
      }
    }
  });

  // Generate one test per fixture. Vitest handles async `it.each`-style
  // via dynamic describe; here we use explicit loops after load.
  it("evaluates every fixture and meets min_score", async () => {
    const results = [];
    for (const fixture of expected.fixtures) {
      const pdfPath = await resolveFixturePath(fixture);
      if (!pdfPath) {
        results.push({
          id: fixture.id,
          skipped: true,
          reason: "OFFLINE=1 — skipping URL fixture",
        });
        continue;
      }

      const pdfBytes = await fs.readFile(pdfPath);
      const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      const zones = await detectSignatureZones({ pdfDoc, pdfBytes, pdfjsLib });

      let hits = 0;
      const perZone = [];
      for (const expZone of fixture.expected_zones) {
        let bestScore = null;
        for (const detected of zones) {
          const s = scoreZone(detected, expZone);
          if (!bestScore || s.iou > bestScore.iou || (s.hit && !bestScore.hit)) {
            bestScore = { detected, score: s };
          }
        }
        const matched = bestScore && bestScore.score.hit;
        if (matched) hits++;
        perZone.push({
          expected: { type: expZone.type, page: expZone.page, note: expZone.note },
          matched,
          bestIou: bestScore ? bestScore.score.iou : 0,
          detectedLabel: matched ? bestScore.detected.label : null,
          reason: bestScore ? bestScore.score.reason : "no detected zones on this page",
        });
      }
      const score = fixture.expected_zones.length > 0
        ? hits / fixture.expected_zones.length
        : 1;
      results.push({
        id: fixture.id,
        score,
        hits,
        total: fixture.expected_zones.length,
        min_score: fixture.min_score ?? 0.5,
        detectedCount: zones.length,
        perZone,
      });
    }

    // Pretty-print a report — visible in test output on failure.
    const ran = results.filter(r => !r.skipped);
    const skipped = results.filter(r => r.skipped);
    const summary = ran.map(r =>
      `  ${r.id}: ${r.hits}/${r.total} hit (score=${r.score.toFixed(2)}, min=${r.min_score}, detected=${r.detectedCount})`
    ).join("\n");
    console.log(`\n[golden-set report]\n${summary}${skipped.length ? `\n  (skipped: ${skipped.map(s => s.id).join(", ")})` : ""}\n`);

    // Ship gate: every non-skipped fixture meets its min_score
    for (const r of ran) {
      if (r.score < r.min_score) {
        const failing = r.perZone.filter(z => !z.matched).map(z =>
          `    - ${z.expected.type} on page ${z.expected.page} (${z.expected.note}): ${z.reason}`
        ).join("\n");
        expect.fail(
          `Fixture ${r.id} scored ${r.score.toFixed(2)} < min ${r.min_score}. Misses:\n${failing}`
        );
      }
      expect(r.score).toBeGreaterThanOrEqual(r.min_score);
    }

    // At least one fixture should have run
    if (!OFFLINE) expect(ran.length).toBeGreaterThan(0);
  }, 60_000);
});
