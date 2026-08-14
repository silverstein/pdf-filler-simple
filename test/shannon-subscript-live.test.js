import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { hashBoundedPdfFileSafely } from "../server/bounded-pdf-file.js";
import { renderPdfLayoutToMarkdown } from "../server/markdown-conversion.js";
import {
  createPdfjsSubprocessRequest,
  runPdfjsSubprocess,
} from "../server/pdfjs-subprocess.js";

const SOURCE = process.env.PDF_TOOLS_SHANNON_SOURCE;
const SOURCE_SHA256 = "6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8";
const PAGE_COUNT = 55;
const PAGE_SPAN = 5;

// Both character maps, restated here only so this oracle can build and invert
// the same two alphabets. No assertion below names an expected token: every
// comparison has two computed sides, one read out of the emitted Markdown and
// one derived from the source geometry.
const SUBSCRIPT_FORMS = new Map(Object.entries({
  0: "₀",
  1: "₁",
  2: "₂",
  3: "₃",
  4: "₄",
  5: "₅",
  6: "₆",
  7: "₇",
  8: "₈",
  9: "₉",
  "+": "₊",
  "-": "₋",
  "−": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  a: "ₐ",
  e: "ₑ",
  h: "ₕ",
  i: "ᵢ",
  j: "ⱼ",
  k: "ₖ",
  l: "ₗ",
  m: "ₘ",
  n: "ₙ",
  o: "ₒ",
  p: "ₚ",
  r: "ᵣ",
  s: "ₛ",
  t: "ₜ",
  u: "ᵤ",
  v: "ᵥ",
  x: "ₓ",
}));
const SUPERSCRIPT_FORMS = new Map(Object.entries({
  0: "⁰",
  1: "¹",
  2: "²",
  3: "³",
  4: "⁴",
  5: "⁵",
  6: "⁶",
  7: "⁷",
  8: "⁸",
  9: "⁹",
  "+": "⁺",
  "-": "⁻",
  "−": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  n: "ⁿ",
  i: "ⁱ",
}));
const PLAIN_FORMS = new Map([...SUBSCRIPT_FORMS].map(([plain, form]) => [form, plain]));
const SUBSCRIPT_CHARACTERS = new Set(SUBSCRIPT_FORMS.values());
const SUPERSCRIPT_CHARACTERS = new Set(SUPERSCRIPT_FORMS.values());

function mappedForm(forms, text) {
  if (text.length === 0) return null;
  let mapped = "";
  for (const character of text) {
    const form = forms.get(character);
    if (form === undefined) return null;
    mapped += form;
  }
  return mapped;
}

function fold(text) {
  return [...text].map(character => PLAIN_FORMS.get(character) ?? character).join("");
}

/**
 * The source's own vertical scale for an item.
 *
 * pdf.js reports a glyph height for ordinary runs, and this prefers it. It
 * reports zero for a collapsed legacy Type-3 item, whose height therefore has
 * to come from the raw text-space transform instead. Both are numbers the
 * source supplied; neither is the IR's derived advance box, which is what the
 * renderer measures. Skipping the zero-height items instead would blind this
 * oracle to a whole population of bases that the renderer does judge, and an
 * oracle that cannot see what the renderer emits cannot constrain it.
 */
function rawHeight(item) {
  return item.raw_height > 0 ? item.raw_height : Math.abs(item.raw_transform[3]);
}

/**
 * Independent oracle for "smaller, displaced, attached", deliberately derived
 * from different IR fields than the renderer uses. The renderer recovers a
 * baseline from the published viewport quad and its ascent ratio, in a
 * coordinate space whose y grows downward. This reads the source text-space
 * transform, where the y translation is the baseline itself and grows upward.
 * The sign of the rise therefore comes out of the opposite subtraction in the
 * opposite space, so a renderer that inverted the direction would disagree with
 * this rather than agree with it, which a restatement of its arithmetic could
 * not detect.
 */
function rawScriptGeometry(base, script) {
  const baseHeight = rawHeight(base);
  if (!(baseHeight > 0) || !(rawHeight(script) > 0)) return null;
  // Unrotated, unskewed runs only. A sheared run has no y-axis baseline.
  for (const item of [base, script]) {
    if (item.raw_transform.length !== 6 || item.raw_transform[1] !== 0 || item.raw_transform[2] !== 0) {
      return null;
    }
  }
  return {
    ratio: rawHeight(script) / baseHeight,
    rise: (script.raw_transform[5] - base.raw_transform[5]) / baseHeight,
    gap: (script.bbox.x - (base.bbox.x + base.bbox.width)) / baseHeight,
  };
}

const RAISED = Object.freeze({
  forms: SUPERSCRIPT_FORMS,
  characters: SUPERSCRIPT_CHARACTERS,
  riseMin: 0.28,
  riseMax: 0.45,
  gapMin: -0.1,
  gapMax: 0.1,
});
const LOWERED = Object.freeze({
  forms: SUBSCRIPT_FORMS,
  characters: SUBSCRIPT_CHARACTERS,
  riseMin: -0.35,
  riseMax: -0.1,
  gapMin: -0.1,
  gapMax: 0.15,
});

function displacedKind(base, script) {
  const measured = rawScriptGeometry(base, script);
  if (measured === null) return null;
  if (!(measured.ratio >= 0.6 && measured.ratio <= 0.82)) return null;
  return [RAISED, LOWERED].find(kind => measured.rise >= kind.riseMin
    && measured.rise <= kind.riseMax
    && measured.gap >= kind.gapMin
    && measured.gap <= kind.gapMax) ?? null;
}

function paintedItems(page) {
  return page.raw_items.filter(item => item.is_whitespace !== true && item.text.trim().length > 0);
}

/**
 * Whether the renderer can splice anything into this line at all.
 *
 * It rewrites a line by locating each source item's exact text inside the
 * line's text, scanning forward, and replacing in place. Where the scan cannot
 * succeed the line keeps the text it had rather than being partly rewritten:
 * this document's case is a final source item carrying a trailing space that
 * the line text dropped. The condition is textual rather than geometric, so
 * restating it here leaves every geometric judgement above independently
 * derived.
 */
function lineAcceptsSplice(line, items) {
  let cursor = 0;
  for (const item of items) {
    if (typeof item.text !== "string" || item.text.length === 0) return false;
    const index = line.text.indexOf(item.text, cursor);
    if (index === -1) return false;
    cursor = index + item.text.length;
  }
  return true;
}

/**
 * Every displaced run the source painted on a page, in either direction,
 * representable or not. Attachment starts inside one line; the run is then
 * followed by raw text-space baseline equality wherever the source continued
 * it, including across the IR's line grouping.
 */
function displacedRuns(page) {
  const byId = new Map(page.raw_items.map(item => [item.id, item]));
  const painted = paintedItems(page);
  const runs = [];
  for (const line of page.lines) {
    const all = line.item_ids.map(id => byId.get(id)).filter(Boolean);
    const items = all.filter(item => item.is_whitespace !== true && item.text.trim().length > 0);
    const lineIds = new Set(items.map(item => item.id));
    const spliceable = lineAcceptsSplice(line, all.filter(item => item.text.length > 0));
    for (let index = 1; index < items.length; index += 1) {
      const kind = displacedKind(items[index - 1], items[index]);
      if (kind === null) continue;
      const run = [];
      const claimed = new Set();
      for (let tail = items[index]; tail;) {
        run.push(tail);
        claimed.add(tail.id);
        tail = painted.find(candidate => !claimed.has(candidate.id)
          && candidate.raw_transform[5] === tail.raw_transform[5]
          && candidate.bbox.x >= tail.bbox.x + tail.bbox.width - rawHeight(tail) * 0.35
          && candidate.bbox.x <= tail.bbox.x + tail.bbox.width + rawHeight(tail) * 0.6);
      }
      while (index + 1 < items.length && claimed.has(items[index + 1].id)) index += 1;
      const source = run.map(item => item.text).join("");
      const whole = run.every(item => lineIds.has(item.id));
      runs.push({
        page: page.page,
        kind,
        source,
        // Representable in this run's own direction, wholly on this line, and
        // on a line the renderer can rewrite: the conditions it promises are
        // jointly necessary before it writes anything.
        transcribable: whole && spliceable && mappedForm(kind.forms, source) !== null,
        // Whether the other alphabet could have written this run. Used to prove
        // the direction, not the alphabet, is what separates the two.
        representableEitherWay: mappedForm(SUBSCRIPT_FORMS, source) !== null
          && mappedForm(SUPERSCRIPT_FORMS, source) !== null,
      });
    }
  }
  return runs;
}

function runsOf(characters, text) {
  return text.match(new RegExp(`[${[...characters].join("")}]+`, "gu")) ?? [];
}

function pageBodies(chunks) {
  const bodies = new Map();
  for (const chunk of chunks) {
    const body = chunk.markdown.split("\n## Conversion limitations\n")[0];
    for (const section of body.split(/<!-- PDF page (\d+) -->/u).slice(1).reduce((pairs, value, index, all) => (
      index % 2 === 0 ? [...pairs, [Number(value), all[index + 1]]] : pairs
    ), [])) {
      bodies.set(section[0], section[1]);
    }
  }
  return bodies;
}

let converted = null;

async function convertShannon() {
  const sourceFile = await hashBoundedPdfFileSafely(SOURCE, 250 * 1024 * 1024, {
    assertPathAllowed: candidate => candidate,
  });
  expect(sourceFile.sha256).toBe(SOURCE_SHA256);
  const source = {
    canonical_path: sourceFile.canonicalPath,
    file_identity: sourceFile.fileIdentity,
    sha256: sourceFile.sha256,
    size_bytes: sourceFile.sizeBytes,
  };
  const pages = [];
  const chunks = [];
  for (let startPage = 1; startPage <= PAGE_COUNT; startPage += PAGE_SPAN) {
    const endPage = Math.min(PAGE_COUNT, startPage + PAGE_SPAN - 1);
    const response = await runPdfjsSubprocess(createPdfjsSubprocessRequest({
      operation: "extract_layout_for_markdown",
      source,
      password: null,
      allowedDirectories: [path.dirname(SOURCE)],
      options: {
        source_path: SOURCE,
        source_file_name: path.basename(SOURCE),
        start_page: startPage,
        end_page: endPage,
        max_items: 5000,
        max_characters: 100_000,
        max_output_characters: 200_000,
      },
    }), { timeoutMs: 60_000 });
    pages.push(...response.layout.pages);
    chunks.push(renderPdfLayoutToMarkdown(response.layout, {
      includePageBoundaries: true,
      maxMarkdownBytes: 200_000,
    }));
  }
  return { pages, chunks, bodies: pageBodies(chunks) };
}

describe("external Shannon lowered-glyph transcription", () => {
  beforeAll(async () => {
    if (SOURCE) converted = await convertShannon();
  }, 240_000);

  it.runIf(Boolean(SOURCE))("writes exactly the lowered runs the source painted and can represent", () => {
    const { pages, bodies } = converted;
    const runs = pages.flatMap(displacedRuns);
    const lowered = runs.filter(run => run.kind === LOWERED);
    const transcribable = lowered.filter(run => run.transcribable);

    // Both sides computed. The renderer must have written every lowered run an
    // independent reading of the source finds representable and whole, in
    // document order, and nothing else anywhere on any page.
    expect(transcribable.length).toBeGreaterThan(0);
    for (const page of pages) {
      const expected = transcribable.filter(run => run.page === page.page)
        .map(run => mappedForm(SUBSCRIPT_FORMS, run.source));
      expect(runsOf(SUBSCRIPT_CHARACTERS, bodies.get(page.page) ?? ""), `page ${page.page}`).toEqual(expected);
    }

    // The abstention path is genuinely exercised by this document, so the
    // equality above is a real constraint and not a vacuous one.
    expect(lowered.length - transcribable.length).toBeGreaterThan(0);
  });

  it.runIf(Boolean(SOURCE))("separates the two directions by sign, not by alphabet", () => {
    const { pages, bodies } = converted;
    const runs = pages.flatMap(displacedRuns);

    // The rule reads a signed displacement. If it read an absolute one, or
    // inverted it, these two populations would swap alphabets. Both directions
    // have to be present for that to mean anything, and the overlapping subset
    // has to be non-empty: those are the runs whose text both alphabets could
    // write, so only the measured sign can be choosing between them.
    const raised = runs.filter(run => run.kind === RAISED && run.transcribable);
    const lowered = runs.filter(run => run.kind === LOWERED && run.transcribable);
    expect(raised.length).toBeGreaterThan(0);
    expect(lowered.length).toBeGreaterThan(0);
    expect(lowered.filter(run => run.representableEitherWay).length).toBeGreaterThan(0);
    expect(raised.filter(run => run.representableEitherWay).length).toBeGreaterThan(0);

    for (const page of pages) {
      const body = bodies.get(page.page) ?? "";
      expect(runsOf(SUPERSCRIPT_CHARACTERS, body), `raised, page ${page.page}`)
        .toEqual(raised.filter(run => run.page === page.page)
          .map(run => mappedForm(SUPERSCRIPT_FORMS, run.source)));
    }

    // No run is claimed by both windows, so no page can be reported twice.
    expect(runs.filter(run => run.kind === RAISED).length
      + runs.filter(run => run.kind === LOWERED).length).toBe(runs.length);
  });

  it.runIf(Boolean(SOURCE))("only substitutes characters, and never inside the source IR", () => {
    const { pages, chunks } = converted;
    const rendered = chunks.map(chunk => chunk.markdown).join("");

    // Folding every subscript back to its plain character has to be total and
    // length-preserving. That is what makes this a substitution rather than a
    // rewrite: no character position moved, so nothing around a lowered run can
    // have been dropped, reordered, or invented.
    const folded = fold(rendered);
    expect(folded).not.toBe(rendered);
    expect(folded.length).toBe(rendered.length);
    expect(runsOf(SUBSCRIPT_CHARACTERS, folded)).toEqual([]);

    // Folding is total over the whole Unicode subscript repertoire, not just
    // over the map above. A renderer that invented a form this oracle does not
    // know would survive every comparison built from that map, and would be
    // left behind here instead.
    expect(folded.match(/[₀-ₜᵢ-ᵪⱼ]/gu)).toBeNull();

    // The projection is emission-only: the source Extraction IR the Markdown
    // was derived from still holds the flat characters the parser reported.
    const mutated = pages.flatMap(page => [
      ...page.lines.map(line => line.text),
      ...page.raw_items.map(item => item.text),
    ]).filter(text => runsOf(SUBSCRIPT_CHARACTERS, text).length > 0);
    expect(mutated).toEqual([]);
  });

  it.runIf(Boolean(SOURCE))("abstains on every character the subscript alphabet cannot write", () => {
    const { pages } = converted;
    const lowered = pages.flatMap(displacedRuns).filter(run => run.kind === LOWERED);
    const abstained = lowered.filter(run => mappedForm(SUBSCRIPT_FORMS, run.source) === null);

    // Every abstention is explained by a character with no subscript form, and
    // each such character really is absent from the map rather than merely
    // unused. This is the whole-run rule stated from the other side: the page
    // carries runs the alphabet cannot finish, and none of them was started.
    expect(abstained.length).toBeGreaterThan(0);
    const unwritable = new Set(abstained.flatMap(run => [...run.source]
      .filter(character => !SUBSCRIPT_FORMS.has(character))));
    expect(unwritable.size).toBeGreaterThan(0);
    for (const run of abstained) {
      expect([...run.source].some(character => unwritable.has(character)), run.source).toBe(true);
    }

    // Among them, at least one run is unwritable only because of a character
    // the map deliberately omits while the rest of the run maps cleanly, and at
    // least one because it carries a space. Both are the cases where emitting a
    // partial run would have been the tempting mistake.
    expect(abstained.some(run => [...run.source].filter(character => !SUBSCRIPT_FORMS.has(character)).length === 1
      && [...run.source].length > 1)).toBe(true);
    expect(abstained.some(run => run.source.includes(" "))).toBe(true);
  });

  it.runIf(Boolean(SOURCE))("reports the displaced-glyph rule in its limitations", () => {
    const [chunk] = converted.chunks;
    const limitation = chunk.limitations.find(value => value.includes("displaced from the baseline"));
    expect(limitation).toBeDefined();
    expect(limitation).toMatch(/subscript characters when it was lowered/i);
    expect(limitation).toMatch(/does not assert that a lowered one is an index/i);
    expect(limitation).toMatch(/no capital letters/i);
    // The two abstentions this document exercises beyond the alphabet are both
    // published rather than silent.
    expect(limitation).toMatch(/cannot all be located/i);
    expect(limitation).toMatch(/without changing font/i);
    expect(converted.chunks[0].limitations.some(value => value.includes("General equations, other fraction bars")))
      .toBe(true);
  });
});
