import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { uniqueComputerModernFamily } from "../server/layout-extraction.js";

/**
 * Legacy dvips-era Computer Modern Type-3 corpus, bound as a pinned failing
 * baseline.
 *
 * Nothing in this file describes desired behaviour. Every recorded
 * `strict_recovery_count` here is zero, and that zero IS the defect this
 * corpus exists to track: PDF Tools recovers Computer Modern Type-3 bitmap
 * mathematics on the Shannon document and recovers none of it on any of these
 * five, even though they are the same fonts drawn by the same era of
 * toolchain. Three of the four cr.yp.to papers do not even resolve a font
 * family, and none of the four links a single glyph occurrence to a raw
 * Type-3 font. The numbers below are what the shipped code does today,
 * measured, not what it should do.
 *
 * Interface: one directory variable, `PDF_TOOLS_LEGACY_CORPUS_DIR`, holding
 * all five documents under the fixed basenames listed in DOCUMENTS. A single
 * variable was chosen over five because five separate variables permit a
 * partially configured run — three set, two unset — which would silently
 * characterize part of the corpus and look like a pass. With one variable the
 * suite is either fully skipped or fully measured: once the directory is
 * given, a missing or wrong-digest document is a hard failure, never a skip.
 *
 * The documents are third-party and are deliberately NOT committed. Sources:
 *   https://cr.yp.to/papers/pippenger.pdf
 *   https://cr.yp.to/papers/nfscircuit.pdf
 *   https://cr.yp.to/papers/m3.pdf
 *   https://cr.yp.to/papers/sf.pdf
 *   https://arxiv.org/pdf/astro-ph/9402001
 */

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY_SCRIPT = path.join(REPO_ROOT, "scripts", "inventory-type3-glyphs.mjs");
const CORPUS_DIR = process.env.PDF_TOOLS_LEGACY_CORPUS_DIR;

const DOCUMENTS = Object.freeze([
  Object.freeze({
    name: "pippenger",
    file: "pippenger.pdf",
    url: "https://cr.yp.to/papers/pippenger.pdf",
    sha256: "ec45c2193abf5acfb5adaaf71c4b4f7b487d90b21f80b7b6d48fd51fd655ccae",
  }),
  Object.freeze({
    name: "nfscircuit",
    file: "nfscircuit.pdf",
    url: "https://cr.yp.to/papers/nfscircuit.pdf",
    sha256: "eee46391621b5d5d2de5de93e7c34217c5c8a6b2db517a682e52d6fb336f6f46",
  }),
  Object.freeze({
    name: "m3",
    file: "m3.pdf",
    url: "https://cr.yp.to/papers/m3.pdf",
    sha256: "988189c6600a24b242c39cd617ea13307e2c3f9880bbafd4914c33ae20be5fc5",
  }),
  Object.freeze({
    name: "sf",
    file: "sf.pdf",
    url: "https://cr.yp.to/papers/sf.pdf",
    sha256: "5a094ee9709d51817b1184e9c01e2e3acf9e3fdc0153a5d876c9cbb138cf34d9",
  }),
  Object.freeze({
    name: "astro-ph-9402001",
    file: "astro-ph-9402001.pdf",
    url: "https://arxiv.org/pdf/astro-ph/9402001",
    sha256: "eb0f80aea9c3c359e3826866a9c8128d41862937f5002dbd016a6f6adbbc0041",
  }),
]);

/**
 * Recorded baseline. Captured programmatically: each object below is exactly
 * the `measured` object a real run of `measureDocument` printed, spliced back
 * in unedited. No figure here was typed by hand on both sides of an assertion.
 */
const BASELINE = Object.freeze({
  "pippenger": Object.freeze({
    producer: "GNU Ghostscript 6.52",
    creator: null,
    page_count: 21,
    size_bytes: 292684,
    type3_font_count: 22,
    layout_admissible_font_count: 19,
    computer_modern_family_font_count: 0,
    observed_type3_occurrence_count: 78175,
    linked_type3_occurrence_count: 0,
    omitted_type3_occurrence_count: 78175,
    classified_occurrence_count: 0,
    officially_named_occurrence_count: 0,
    registry_evidence_occurrence_count: 0,
    strict_recovery_count: 0,
    abstention_reasons: Object.freeze(["raw_type3_font_link_ambiguous_or_unavailable"]),
  }),
  "nfscircuit": Object.freeze({
    producer: "GNU Ghostscript 6.52",
    creator: null,
    page_count: 11,
    size_bytes: 186703,
    type3_font_count: 12,
    layout_admissible_font_count: 10,
    computer_modern_family_font_count: 0,
    observed_type3_occurrence_count: 40704,
    linked_type3_occurrence_count: 0,
    omitted_type3_occurrence_count: 40704,
    classified_occurrence_count: 0,
    officially_named_occurrence_count: 0,
    registry_evidence_occurrence_count: 0,
    strict_recovery_count: 0,
    abstention_reasons: Object.freeze(["raw_type3_font_link_ambiguous_or_unavailable"]),
  }),
  "m3": Object.freeze({
    producer: "GNU Ghostscript 6.52",
    creator: null,
    page_count: 19,
    size_bytes: 276417,
    type3_font_count: 20,
    layout_admissible_font_count: 18,
    computer_modern_family_font_count: 0,
    observed_type3_occurrence_count: 92502,
    linked_type3_occurrence_count: 0,
    omitted_type3_occurrence_count: 92502,
    classified_occurrence_count: 0,
    officially_named_occurrence_count: 0,
    registry_evidence_occurrence_count: 0,
    strict_recovery_count: 0,
    abstention_reasons: Object.freeze(["raw_type3_font_link_ambiguous_or_unavailable"]),
  }),
  "sf": Object.freeze({
    producer: "GNU Ghostscript 6.52",
    creator: null,
    page_count: 15,
    size_bytes: 268946,
    type3_font_count: 16,
    layout_admissible_font_count: 15,
    // Exactly one sf font does resolve a Computer Modern family, and it still
    // recovers nothing, because no occurrence in this document ever links to a
    // raw font in the first place. Family resolution is not the only block.
    computer_modern_family_font_count: 1,
    observed_type3_occurrence_count: 74271,
    linked_type3_occurrence_count: 0,
    omitted_type3_occurrence_count: 74271,
    classified_occurrence_count: 0,
    officially_named_occurrence_count: 0,
    registry_evidence_occurrence_count: 0,
    strict_recovery_count: 0,
    abstention_reasons: Object.freeze(["raw_type3_font_link_ambiguous_or_unavailable"]),
  }),
  "astro-ph-9402001": Object.freeze({
    producer: "GPL Ghostscript GIT PRERELEASE 9.22",
    creator: "dvips 5.518",
    page_count: 37,
    size_bytes: 929486,
    type3_font_count: 22,
    // 18 of the 22 fonts carry a /ToUnicode and are refused by the linker's
    // admission rules outright, so 10 fonts whose widths do fingerprint a
    // Computer Modern family never become link candidates.
    layout_admissible_font_count: 4,
    computer_modern_family_font_count: 10,
    observed_type3_occurrence_count: 100114,
    linked_type3_occurrence_count: 44,
    omitted_type3_occurrence_count: 100070,
    classified_occurrence_count: 12,
    officially_named_occurrence_count: 11,
    // The study's second cause, isolated: codes are preserved and 11
    // occurrences carry an official Unicode mapping, yet not one matches any
    // registry CharProc digest, so nothing is recovered.
    registry_evidence_occurrence_count: 0,
    strict_recovery_count: 0,
    abstention_reasons: Object.freeze(["raw_type3_font_link_ambiguous_or_unavailable"]),
  }),
});

function type3FontDictionaries(pdfLibDocument) {
  const seen = new Map();
  for (let index = 0; index < pdfLibDocument.getPageCount(); index += 1) {
    const page = pdfLibDocument.getPage(index);
    const context = page.doc.context;
    const fonts = page.node.Resources()?.lookup(PDFName.of("Font"), PDFDict);
    if (!fonts) continue;
    for (const [, reference] of fonts.entries()) {
      const font = context.lookup(reference, PDFDict);
      if (font?.get(PDFName.of("Subtype"))?.toString() !== "/Type3") continue;
      const key = String(reference);
      if (!seen.has(key)) seen.set(key, font);
    }
  }
  return { context: pdfLibDocument.context, fonts: [...seen.values()] };
}

/**
 * Positive-width slots of a Type-3 font, built the way the shipped
 * `rawType3Fonts` builds them — zero widths dropped, because
 * `metricScaleInterval` cannot fit a scale to an observed zero. Measured here
 * independently of that private helper so the baseline records a document
 * fact rather than a re-export of the code under study.
 */
function positiveWidthSlots(font) {
  const first = font.lookup(PDFName.of("FirstChar"), PDFNumber)?.asNumber();
  const last = font.lookup(PDFName.of("LastChar"), PDFNumber)?.asNumber();
  const widthsArray = font.lookup(PDFName.of("Widths"), PDFArray);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || !widthsArray) return null;
  if (first < 0 || last < first || widthsArray.size() !== last - first + 1) return null;
  const widths = new Map();
  for (let code = first; code <= last; code += 1) {
    const width = widthsArray.lookup(code - first, PDFNumber)?.asNumber();
    if (!Number.isSafeInteger(width) || width < 0) return null;
    if (width > 0) widths.set(code, width);
  }
  return widths.size > 0 ? { first, last, widths } : null;
}

/** Mirrors the admission rules `rawType3Fonts` applies before a font is even
 * a link candidate: no `/ToUnicode`, codes confined to 0..127, a well-formed
 * `/Widths`, and a present `/Encoding /Differences` array. This is a close
 * mirror rather than that private helper itself, so the figure it produces is
 * a readable document fact and not a re-export of the code under study. */
function layoutAdmissible(context, font, slots) {
  if (font.has(PDFName.of("ToUnicode"))) return false;
  if (!slots || slots.last > 127) return false;
  const encoding = context.lookup(font.get(PDFName.of("Encoding")), PDFDict);
  return Boolean(encoding?.lookup(PDFName.of("Differences"), PDFArray));
}

const measurements = new Map();

async function measureDocument(document) {
  if (measurements.has(document.name)) return measurements.get(document.name);
  const corpusDirectory = await fs.realpath(CORPUS_DIR);
  const sourcePath = path.join(corpusDirectory, document.file);
  const bytes = await fs.readFile(sourcePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const pdfLibDocument = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const { context, fonts } = type3FontDictionaries(pdfLibDocument);
  let admissible = 0;
  let familyResolving = 0;
  for (const font of fonts) {
    const slots = positiveWidthSlots(font);
    if (layoutAdmissible(context, font, slots)) admissible += 1;
    if (slots && uniqueComputerModernFamily(slots.widths)) familyResolving += 1;
  }

  const { stdout } = await execFileAsync(
    process.execPath,
    [INVENTORY_SCRIPT, "--source", sourcePath],
    { cwd: REPO_ROOT, maxBuffer: 16_000_000 },
  );
  const report = JSON.parse(stdout);

  const measured = {
    producer: pdfLibDocument.getProducer() ?? null,
    creator: pdfLibDocument.getCreator() ?? null,
    page_count: report.source.page_count,
    size_bytes: report.source.size_bytes,
    type3_font_count: fonts.length,
    layout_admissible_font_count: admissible,
    computer_modern_family_font_count: familyResolving,
    observed_type3_occurrence_count: report.coverage.observed_type3_occurrence_count,
    linked_type3_occurrence_count: report.coverage.linked_type3_occurrence_count,
    omitted_type3_occurrence_count: report.coverage.omitted_type3_occurrence_count,
    classified_occurrence_count: report.coverage.classified_occurrence_count,
    officially_named_occurrence_count: report.coverage.officially_named_occurrence_count,
    registry_evidence_occurrence_count: report.coverage.registry_evidence_occurrence_count,
    strict_recovery_count: report.coverage.strict_recovery_count,
    abstention_reasons: report.abstentions.map(entry => entry.reason).sort(),
  };
  const result = { sha256, measured, report };
  measurements.set(document.name, result);
  return result;
}

describe.runIf(Boolean(CORPUS_DIR))("legacy dvips-era Computer Modern Type-3 corpus", () => {
  for (const document of DOCUMENTS) {
    it(`characterizes today's behaviour on ${document.file}`, async () => {
      const { sha256, measured } = await measureDocument(document);
      expect(sha256, `${document.file} is not the pinned document from ${document.url}`)
        .toBe(document.sha256);

      // Harness guard. A broken measurement — an unreadable PDF, an inventory
      // run that produced an empty report, a document with no Type-3 content
      // at all — would otherwise satisfy every zero below and read as a pass.
      expect(measured.page_count).toBeGreaterThan(0);
      expect(measured.type3_font_count).toBeGreaterThan(0);
      expect(
        measured.observed_type3_occurrence_count,
        "no Type-3 glyph occurrences were observed at all; the measurement, not the document, is wrong",
      ).toBeGreaterThan(10_000);

      const expected = BASELINE[document.name];
      // Exact document facts. These are properties of the pinned bytes and of
      // a pinned pdfjs-dist; a change here is a real change in what the
      // pipeline sees, not an improvement in what it recovers.
      expect({
        producer: measured.producer,
        creator: measured.creator,
        page_count: measured.page_count,
        size_bytes: measured.size_bytes,
        type3_font_count: measured.type3_font_count,
        observed_type3_occurrence_count: measured.observed_type3_occurrence_count,
        abstention_reasons: measured.abstention_reasons,
      }).toEqual({
        producer: expected.producer,
        creator: expected.creator,
        page_count: expected.page_count,
        size_bytes: expected.size_bytes,
        type3_font_count: expected.type3_font_count,
        observed_type3_occurrence_count: expected.observed_type3_occurrence_count,
        abstention_reasons: [...expected.abstention_reasons],
      });

      // Directional. Each recovery-shaped count is fenced from both sides with
      // its own message, so a regression and an improvement fail differently
      // and neither can pass silently. Raising any recorded number here is a
      // deliberate, reviewable edit — and for strict_recovery_count it is the
      // point of the work this baseline exists to measure.
      const directional = [
        ["layout_admissible_font_count", "Type-3 fonts admitted by the layout font linker"],
        ["computer_modern_family_font_count", "Type-3 fonts resolving to a Computer Modern family"],
        ["linked_type3_occurrence_count", "Type-3 occurrences linked to a raw font"],
        ["classified_occurrence_count", "occurrences classified into a Computer Modern family"],
        ["officially_named_occurrence_count", "occurrences with an official Unicode mapping"],
        ["registry_evidence_occurrence_count", "occurrences matching a registry digest"],
        ["strict_recovery_count", "strictly recovered occurrences"],
      ];
      for (const [key, label] of directional) {
        expect(
          measured[key],
          `${label} regressed below the recorded baseline for ${document.file}`,
        ).toBeGreaterThanOrEqual(expected[key]);
        expect(
          measured[key],
          `${label} improved for ${document.file}: update the recorded baseline in this file deliberately`,
        ).toBeLessThanOrEqual(expected[key]);
      }
    }, 180_000);
  }

  /**
   * Corpus-level statement of the gap, so the headline claim is asserted once
   * rather than only implied by five per-document blocks.
   */
  it("recovers nothing at all across the whole corpus", async () => {
    const measured = [];
    for (const document of DOCUMENTS) measured.push((await measureDocument(document)).measured);
    expect(measured).toHaveLength(DOCUMENTS.length);
    const total = key => measured.reduce((sum, entry) => sum + entry[key], 0);

    // Guard: the corpus really is a large body of legacy Type-3 mathematics.
    expect(total("observed_type3_occurrence_count")).toBeGreaterThan(300_000);
    expect(total("type3_font_count")).toBeGreaterThan(50);

    expect(
      total("strict_recovery_count"),
      "the legacy corpus now recovers something: this is the tracked defect being fixed, so update the recorded baseline deliberately",
    ).toBe(0);

    // The four cr.yp.to papers are the hardest case: GNU Ghostscript 6.52
    // repacks glyph names to /a0 /a1 /a2..., and not one of their 285,652
    // observed occurrences even links to a raw Type-3 font, so the pipeline
    // never reaches the family fingerprint or any CharProc digest at all.
    const ghostscript652 = measured.filter(entry => entry.producer === "GNU Ghostscript 6.52");
    expect(ghostscript652).toHaveLength(4);
    expect(ghostscript652.reduce((sum, entry) => sum + entry.observed_type3_occurrence_count, 0))
      .toBeGreaterThan(200_000);
    for (const entry of ghostscript652) {
      expect(
        entry.linked_type3_occurrence_count,
        "a Ghostscript 6.52 paper now links Type-3 occurrences: update the recorded baseline deliberately",
      ).toBe(0);
      expect(entry.classified_occurrence_count).toBe(0);
    }
  }, 600_000);
});
