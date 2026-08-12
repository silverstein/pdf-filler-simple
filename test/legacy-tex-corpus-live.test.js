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
 * Legacy dvips-era Computer Modern Type-3 corpus, bound as a pinned baseline.
 *
 * Nothing in this file describes desired behaviour. Four of the five documents
 * still record `strict_recovery_count: 0`, and those zeros ARE the defect this
 * corpus exists to track: PDF Tools recovers Computer Modern Type-3 bitmap
 * mathematics on the Shannon document and recovers almost none of it here,
 * even though they are the same fonts drawn by the same era of toolchain. The
 * numbers below are what the shipped code does today, measured, not what it
 * should do.
 *
 * The fifth, astro-ph-9402001, now recovers eleven occurrences. That is the
 * first non-zero figure this corpus has ever carried and it came from closing
 * finding (a): see that document's baseline entry, and the "generated PK
 * ground truth" paragraph after finding (d).
 *
 * Three of the four stacked causes have since been removed, and the baseline
 * was raised to record that:
 *
 *   1. The linker used to drop zero-width slots from a font's width map while
 *      still demanding an exact width match for every drawn glyph, so a single
 *      legitimately zero-width glyph voided the whole font. All four
 *      Ghostscript 6.52 papers linked exactly nothing; they now link 52,493
 *      occurrences between them.
 *   2. The recovery key used to be the CharProc operator list, which folds in
 *      the producer's idiom and the per-glyph placement matrix. It is now the
 *      decoded image mask.
 *   3. Enrolled shapes used to come only from reviewed rasters of one document,
 *      so a document rasterised at any other setting matched nothing. There is
 *      now a generated reference as well; see below.
 *
 * What is left is the fourth cause, and it is why four of these five counts
 * are still zero: those four documents resolve no Computer Modern family at
 * all for the fonts that carry their mathematics. astro-ph does resolve
 * families for ten fonts, and it is the one document here that recovers.
 *
 * Both routes past that fourth cause have been investigated to a conclusion.
 * Findings (a)-(d) below were the shape route; (a) has since been closed by
 * building the missing reference, and (b)-(d) still stand as reasons not to
 * bridge outline to bitmap or to identify a family from shapes. Findings
 * (e)-(g) close every metric-derived route. Read them before attempting
 * anything here.
 *
 * Identifying the family from the set of matched glyph SHAPES, rather than
 * from `widths[code]`, was investigated as the way through and was measured to
 * be a dead end. It is recorded here so it is not attempted again blind. Four
 * findings, each measured on these exact documents:
 *
 *   a. CLOSED. There used to be no bitmap reference to match against. The
 *      pinned official CTAN `cm/ps-type3` fonts are cubic-Bézier OUTLINE
 *      programs: all 41 glyph programs of the labeled reference fixture take
 *      the exact-operator evidence lane and none takes the image-mask lane.
 *      `cm/mf.zip` is METAFONT source, and turning it into the PK rasters
 *      these documents actually carry needs a METAFONT run at a resolution
 *      and device setting that no document here records. What was missing was
 *      the setting, not the capability, and the setting is recoverable by
 *      search rather than by reading it out of the file: there are only 83
 *      distinct (blacker, fillin, o_correction) triples in all of `modes.mf`,
 *      and a candidate is accepted only when its output is BIT-IDENTICAL to a
 *      real document's raster under the shipped mask key. Two settings pass
 *      that test — 600 dpi with (.25, 0, 1) for the Shannon reference and 300
 *      dpi with (0, .2, .6) for astro-ph — and both are pinned in
 *      `scripts/generate-type3-cm-pk-reference.mjs`. Note that this is the
 *      opposite of finding (b): nothing here is scored for similarity, a
 *      setting either reproduces a document's bytes exactly or it is not used.
 *   b. Bridging outline to bitmap is never exact, and no threshold separates
 *      right from wrong. Rasterising the official CTAN outline for cmmi alpha
 *      across 225,225 combinations of resolution (60-110 px/em in 0.05 steps),
 *      alpha threshold, and sub-pixel offset reproduced the Shannon document's
 *      reviewed alpha raster's ink box 241 times and its bits ZERO times; the
 *      closest was 72 of 1748 pixels wrong, 4.1%. Repeating that against three
 *      Shannon rasters of known identity, scoring every one of the 41 reference
 *      slots that could reproduce the target's ink box at any resolution, the
 *      correct slot's best agreement was 4.3% wrong for alpha, 2.1% for omega
 *      and 14.5% for sigma, while the best WRONG slot reached 20.1% for alpha
 *      and 24.5% for sigma. So a threshold has to admit 14.5% to identify
 *      sigma and reject 20.1% to not misread alpha — a 1.4x window, already
 *      that narrow against a reference holding 41 of the roughly 9,600 (font,
 *      slot) pairs Computer Modern actually has. Widening the reference can
 *      only close the window further. That is a similarity threshold that
 *      could misfire, which is the guess this pipeline abstains rather than
 *      make.
 *   c. Even an exact matcher would not determine a family. One digest in the
 *      shipped registry already stands at two different (family, slot) pairs:
 *      the same bitmap is `cmmi-pk-raster-period-2df559-v1` (math-italic slot
 *      58, ".") and `cmsy-pk-raster-centered-dot-33077f-v1` (math-symbol slot
 *      1, "⋅"). Shape identifies a code only once the family is already known,
 *      which is the direction the shipped matcher runs in and the opposite of
 *      the direction proposed.
 *   d. There is no cross-document anchor either. The mask key is genuinely
 *      producer-independent — the four cr.yp.to papers share 387 to 440 of
 *      their 451 to 581 distinct inked shapes with each other, being one PK
 *      library at 720 dpi — but they share exactly ONE shape with Shannon
 *      (600 dpi) and none at all with astro-ph (300 dpi), and that one shared
 *      shape is a 41x3 solid rectangle, a fraction rule rather than a
 *      character.
 *
 * GENERATED PK GROUND TRUTH, which is what (a) turned into. The reference is
 * `server/type3-cm-pk-reference.js`: 470 mask digests covering all 41 enrolled
 * slots of all 17 Computer Modern math faces at both pinned settings, built by
 * `scripts/generate-type3-cm-pk-reference.mjs` from the pinned CTAN
 * `cm/mf.zip` and recorded in
 * `test/fixtures/eval/extraction/type3-cm-pk-reference.provenance.json`. It
 * enrolls under its own qualification string,
 * `ctan-cm-metafont-generated-pk-v1`, because it is a different class of
 * evidence from the reviewed rasters: nobody looked at a picture, and the
 * whole chain from archive digest to emitted digest is reproducible. Two
 * independent checks on it, both measured:
 *
 *   - It reproduces 48 of the 69 mask-lane (family, slot, digest) triples the
 *     reviewed lane holds, bit for bit, having never seen them. The other 21
 *     are Shannon's magnified font instances; sweeping 500, 657, 720, 864 and
 *     1037 dpi at the same three scalars reproduces 5 more, so extra pinned
 *     resolutions are the obvious next increment and each would carry the same
 *     exact-reproduction justification. The 70th reviewed triple is
 *     `cmsy-ctan-type3-minus-v1`, which is an OUTLINE program on the
 *     exact-operator lane and can never be reproduced from a PK raster.
 *   - Within a family, not one of its 447 distinct digests stands at two
 *     different slots. Eight stand in two families at once, and all eight are
 *     the pair finding (c) already names — math-italic "." against math-symbol
 *     "⋅" — which is harmless because the matcher pins the family from the TFM
 *     fingerprint before it ever looks at a shape.
 *
 * Independently of all of that, the four Ghostscript 6.52 papers could not
 * recover through the shipped safeguards even given a perfect shape matcher.
 * That producer splits every character into TWO Type-3 glyphs: an inked glyph
 * declaring `0 0 llx lly urx ury d1`, advance zero, and a separate ink-free
 * advance glyph declaring `w 0 0 0 0 0 d1`. Read straight out of the bytes the
 * split is total — 584/457/537/530 inked CharProcs, every one of them zero
 * advance, against 98/99/102/106 advance-only CharProcs, no exceptions — so
 * the inked codes and the positive-width codes are disjoint sets. Positive
 * width pinning therefore rejects every inked code in these four documents by
 * construction, and the family fingerprint can only ever see spacer advances
 * at renumbered codes. That is what `sf` demonstrates: its one family-resolving
 * font pins `cmsy5` off just two such advances, and the two occurrences it
 * officially names mean nothing. Only the missing digest match keeps that
 * coincidence out of the output.
 *
 * The obvious way around THAT — reconstruct each inked glyph's advance from
 * the spacer that follows it, then fingerprint as usual — was also measured,
 * and it closes the last metric-derived route to these four documents. Three
 * findings, all measured on these exact documents and recorded in full in
 * `docs/evidence/legacy-tex-metric-routes-closed-2026-08.md`:
 *
 *   e. The spacer does not carry a per-character advance. It carries an
 *      inter-glyph DISPLACEMENT — advance plus interword space plus kern plus
 *      grid rounding — which is not a function of the inked glyph. Only
 *      53.0/77.4/59.1/51.3% of inked occurrences are followed by a spacer at
 *      all; in pippenger 7,725 of 15,010 show operations (51.5%) hold one
 *      inked glyph and no spacer, the run-final displacement having been
 *      folded into the following `Td`. Where a spacer does follow, the map is
 *      many-to-many: 222 of pippenger's 333 inked codes with a spacer partner
 *      take more than one spacer code, and the modal displacement for a code
 *      accounts for only 43.7-46.8% of its observations. Ground truth from a
 *      decoded page-1 line settles it: in ONE fourteen-glyph show operation
 *      the letter `t` takes displacements 33, 54, 29 and 30, while `.`, `I`
 *      and `w` each report exactly 51 because they only ever occur before a
 *      word space. That is the word space, not the letter.
 *   f. Granting a perfect solution to both blockers at once still fits
 *      nothing. Taking the 15 ground-truth roman characters read off page 1 of
 *      pippenger and placing them at their TRUE OT1 slots with their best-case
 *      reconstructed advances, ZERO Computer Modern metrics fit at ±0.5, ±1,
 *      ±2, ±3, ±5, ±8 or ±12 — out to 24x the shipped ±0.5 tolerance, under
 *      both the min and the mode statistic. The per-character implied scale
 *      against cmr10 ranges 66.6 px/em (`n`) to 183.6 px/em (`.`), and one
 *      font cannot be drawn at two scales, so there is no signal to loosen a
 *      tolerance toward.
 *   g. The category error, which would have defeated both of the above
 *      anyway. Ghostscript 6.52 does not emit one Type-3 font per TeX font; it
 *      emits GLYPH CACHE PAGES. Each of the four documents contains one Type-3
 *      font — `9 0 R` in all four — carrying 171/168/168/164 inked glyphs,
 *      more than the 128 slots any Computer Modern font has. In pippenger's
 *      `9 0 R`, code 10 is the small roman `I` (mask 21x41) and code 49 is the
 *      large bold `I` (mask 39x69), same object. "This font's family" has no
 *      answer, so no font-level identification of any kind — metric or shape —
 *      can work for this producer.
 *
 * And the abstention is demonstrably right rather than merely cautious. The
 * one stable metric candidate in the whole corpus, m3's `408 0 R`, fits cmmi7
 * under min, mode AND max, at a scale that puts a 7 pt metric at 10.4 pt. Its
 * seven unique width-pins predict `L`, `M`, `i`, `w`, `l`, `psi` and `varphi`.
 * Rendered, the mask pinned to capital `L` is an x-height box with no
 * ascender; the one pinned to `M` is 47 px wide against a 113-unit advance
 * (0.42, where pippenger's real bold `M` is 0.94) and descends below the
 * baseline; the one pinned to `l` is a superscript raster drawn entirely above
 * the baseline. The line that font helps draw is
 * `4x² + 1x³ + 5x⁴ + 9x⁵ ∈ R[x] → R[x][y]/(x²−y)`, set by five different
 * Type-3 fonts — one per raster size the cache needed, which is finding (g)
 * again. Shipping the metric route would have emitted those seven letters in
 * place of digits and exponents.
 *
 * So the four Ghostscript 6.52 figures below are zero because every
 * metric-derived route and every shape route into them is closed, and the
 * closure is a property of what GNU Ghostscript 6.52 wrote into these files
 * rather than a limit on effort. The generated PK reference does not help them
 * and was never going to: those four re-rasterised from Type 1 outlines rather
 * than passing PK through, which is directly visible in the bytes. 253 of
 * pippenger's 584 decodable single-mask glyph programs carry a blank outer
 * edge — equivalently, an ink box strictly smaller than the declared mask; the
 * two counts coincide exactly, and no mask in the corpus is blank on all four
 * edges. The same census over the other three is 184/457, 220/537 and 231/530.
 * That is not something GFtoPK's output can have: GFtoPK writes each
 * character's ink box as its bounding box, so a PK-derived raster is tight on
 * all four sides. (The PK container itself would happily carry a padded box;
 * the constraint is the producer's, not the format's.) The counter-examples
 * agree — 0 of astro-ph's 588 masks, 0 of the Shannon document's 125, and 0 of
 * the 4,352 PK rasters `scripts/generate-type3-cm-pk-reference.mjs` decodes,
 * that last one asserted by the generator itself and recorded as
 * `metafont.decoded_pk_rasters_with_blank_border`. On top of that the ink runs
 * one to three pixels wider than the Computer Modern design. Even a perfect
 * reference would then meet finding (g), which has no answer at all. None of
 * this makes the zeros acceptable; it records why they are here.
 *
 * And none of it applies to astro-ph-9402001.pdf, which preserves its TeX
 * codes, fingerprints ten fonts correctly, and used to fail only for the
 * reason in (a). With (a) closed it recovers, and its remaining ceiling is
 * the /ToUnicode deferral rather than any shortage of enrolled shapes.
 *
 *   h. Extending the reference past the three math families to the OT1 text
 *      encoding was measured and refused. At 17,597 generated digests over 76
 *      faces it would gain 72 characters across this corpus and the Shannon
 *      document together, and 0.25% of eligible occurrences over 110 harvested
 *      wild documents, because the producers whose rasters match are the ones
 *      that also kept their encoding. See
 *      `docs/evidence/legacy-tex-ot1-text-no-go-2026-08.md`.
 *   i. astro-ph's own figures below rose from 44 linked / 11 recovered when
 *      the linker learned to read a lowercase `#hh` PDF name escape that
 *      pdf-lib's `decodeText()` leaves undecoded. That is a linking fix, not a
 *      new evidence class; the recovered characters are still only cmsy7's
 *      minus and prime. The defect it exposes underneath — a producer
 *      /ToUnicode that maps ligature glyphs into C0 — is recorded with its
 *      measurements in `docs/evidence/legacy-tex-ligature-tounicode-2026-08.md`
 *      and is NOT fixed.
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
    linked_type3_occurrence_count: 5440,
    omitted_type3_occurrence_count: 72735,
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
    linked_type3_occurrence_count: 7484,
    omitted_type3_occurrence_count: 33220,
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
    linked_type3_occurrence_count: 17335,
    omitted_type3_occurrence_count: 75167,
    classified_occurrence_count: 0,
    officially_named_occurrence_count: 0,
    registry_evidence_occurrence_count: 0,
    strict_recovery_count: 0,
    abstention_reasons: Object.freeze(["raw_type3_font_link_ambiguous_or_unavailable"]),
  }),
  "sf": Object.freeze({
    // Exactly one sf font resolves a Computer Modern family, and the ten
    // occurrences it now classifies still recover nothing: their rasters are
    // this document's own PK resolution and match no enrolled shape.
    producer: "GNU Ghostscript 6.52",
    creator: null,
    page_count: 15,
    size_bytes: 268946,
    type3_font_count: 16,
    layout_admissible_font_count: 15,
    computer_modern_family_font_count: 1,
    observed_type3_occurrence_count: 74271,
    linked_type3_occurrence_count: 22234,
    omitted_type3_occurrence_count: 52037,
    classified_occurrence_count: 10,
    officially_named_occurrence_count: 2,
    registry_evidence_occurrence_count: 0,
    strict_recovery_count: 0,
    abstention_reasons: Object.freeze(["raw_type3_font_link_ambiguous_or_unavailable"]),
  }),
  "astro-ph-9402001": Object.freeze({
    // 18 of the 22 fonts carry a /ToUnicode and are deliberately left to
    // PDF.js, so 10 fonts whose widths do fingerprint a Computer Modern
    // family never become link candidates. This document is unaffected by
    // the zero-width linker fix: its drawn glyphs all had positive widths.
    //
    // This is the one document in the corpus that recovers. Its single
    // linkable Computer Modern font, `247 0 R`, draws exactly two officially
    // enrolled math-symbol slots — code 0 and code 48 — and both are bit-exact
    // to cmsy7 as METAFONT builds it from the pinned CTAN sources at 300 dpi
    // with blacker 0, fillin .2, o_correction .6. That is finding (a) below
    // being answered rather than worked around: the external labelled bitmap
    // reference now exists, generated and pinned, so the minus signs and
    // primes recover through the ordinary two-glyph corroboration rule under
    // `ctan-cm-metafont-generated-pk-v1`.
    //
    // The figures below rose from 44 linked / 11 recovered when
    // `type3GlyphNameCandidates` taught the linker to read a lowercase `#hh`
    // PDF name escape that pdf-lib's `decodeText()` leaves undecoded. This
    // producer names each glyph after its own raw encoding byte, so `247 0 R`
    // writes `/#00` and `/#30`; the linker used to compare pdf-lib's literal
    // `#00` against PDF.js's one-character name and reject the font on every
    // page where a glyph with such a name was drawn. Nothing about the
    // evidence changed — the same font, the same two bit-exact cmsy7 rasters,
    // the same registry entries — only how many of the document's pages the
    // font could be identified on. The recovered characters are still only
    // `−` and `′`.
    //
    // The remaining 100,022 omitted occurrences are the /ToUnicode deferral,
    // which is a safeguard rather than a gap, and no amount of reference
    // coverage will change it.
    producer: "GPL Ghostscript GIT PRERELEASE 9.22",
    creator: "dvips 5.518",
    page_count: 37,
    size_bytes: 929486,
    type3_font_count: 22,
    layout_admissible_font_count: 4,
    computer_modern_family_font_count: 10,
    observed_type3_occurrence_count: 100114,
    linked_type3_occurrence_count: 92,
    omitted_type3_occurrence_count: 100022,
    classified_occurrence_count: 60,
    officially_named_occurrence_count: 32,
    registry_evidence_occurrence_count: 32,
    strict_recovery_count: 32,
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
 * Positive-width slots of a Type-3 font: the view the shipped `rawType3Fonts`
 * hands to the family fingerprint, with zero widths dropped because
 * `metricScaleInterval` cannot fit a scale to an observed zero. The linker
 * keeps those zeros — that is the fix this baseline records — but the
 * fingerprint must not see them. Measured here independently of that private
 * helper so the baseline records a document fact rather than a re-export of
 * the code under study.
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

/** Mirrors the rules that decide whether a font can be the *answer* the
 * linker returns: no `/ToUnicode`, codes confined to 0..127, a well-formed
 * `/Widths`, and a present `/Encoding /Differences` array. Every other Type-3
 * font on the page is still parsed and still competes for the link, so a
 * glyph set matching two fonts abstains rather than picking the recoverable
 * one; only the winner has to clear this bar. This is a close mirror rather
 * than that private helper itself, so the figure it produces is a readable
 * document fact and not a re-export of the code under study. */
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
  it("recovers only astro-ph's cmsy7 minus signs and primes across the whole corpus", async () => {
    const measured = [];
    for (const document of DOCUMENTS) measured.push((await measureDocument(document)).measured);
    expect(measured).toHaveLength(DOCUMENTS.length);
    const total = key => measured.reduce((sum, entry) => sum + entry[key], 0);

    // Guard: the corpus really is a large body of legacy Type-3 mathematics.
    expect(total("observed_type3_occurrence_count")).toBeGreaterThan(300_000);
    expect(total("type3_font_count")).toBeGreaterThan(50);

    /*
     * Thirty-two, and all thirty-two from one document: 29 minus signs and 3
     * primes, all from astro-ph's `247 0 R`. Every other recovery-shaped
     * figure in this corpus is still zero, so the corpus remains a record of
     * the gap rather than of the fix. Moving this number in either direction
     * is a deliberate, reviewable edit: down is a regression in the generated
     * PK lane, up is either more coverage or a coincidence getting through,
     * and the per-document blocks above say which.
     */
    expect(
      total("strict_recovery_count"),
      "the legacy corpus recovery total moved: this is the tracked defect being fixed, so update the recorded baseline deliberately",
    ).toBe(32);
    expect(
      measured.filter(entry => entry.strict_recovery_count > 0),
      "more than one corpus document now recovers: update the recorded baseline deliberately",
    ).toHaveLength(1);

    // The four cr.yp.to papers are the hardest case: GNU Ghostscript 6.52
    // repacks glyph names to /a0 /a1 /a2.... Their 285,652 observed
    // occurrences used to link to a raw Type-3 font exactly zero times,
    // because every one of these fonts declares at least one zero-width slot
    // and the linker treated a declared zero as a missing width. They now
    // link, which is the whole of what the linker fix bought; what they still
    // cannot do is put a Computer Modern family behind the link.
    const ghostscript652 = measured.filter(entry => entry.producer === "GNU Ghostscript 6.52");
    expect(ghostscript652).toHaveLength(4);
    expect(ghostscript652.reduce((sum, entry) => sum + entry.observed_type3_occurrence_count, 0))
      .toBeGreaterThan(200_000);
    for (const entry of ghostscript652) {
      expect(
        entry.linked_type3_occurrence_count,
        "a Ghostscript 6.52 paper stopped linking Type-3 occurrences: the zero-width linker fix regressed",
      ).toBeGreaterThan(0);
    }
    // Family resolution, not linking, is what now blocks the four papers, and
    // it blocks all but ten of their linked occurrences. It blocks them
    // permanently: their Type-3 objects are glyph cache pages holding more
    // inked glyphs than any Computer Modern font has slots, so no font-level
    // family answer exists to be found. See findings (e)-(g) in this file's
    // header and docs/evidence/legacy-tex-metric-routes-closed-2026-08.md.
    // Raising this number would mean a coincidence got through, not a fix.
    expect(
      ghostscript652.reduce((sum, entry) => sum + entry.classified_occurrence_count, 0),
      "a Ghostscript 6.52 paper now classifies more occurrences into a Computer Modern family: update the recorded baseline deliberately",
    ).toBe(10);
  }, 600_000);
});
