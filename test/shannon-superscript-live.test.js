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

// The renderer's character map, restated here only so this oracle can build and
// invert the same alphabet. No assertion below names an expected token: both
// sides of every comparison are computed, one from the emitted Markdown and one
// from the source geometry.
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
const PLAIN_FORMS = new Map([...SUPERSCRIPT_FORMS].map(([plain, form]) => [form, plain]));
const SUPERSCRIPT_CHARACTERS = new Set(SUPERSCRIPT_FORMS.values());

function superscriptForm(text) {
  if (text.length === 0) return null;
  let mapped = "";
  for (const character of text) {
    const form = SUPERSCRIPT_FORMS.get(character);
    if (form === undefined) return null;
    mapped += form;
  }
  return mapped;
}

function fold(text) {
  return [...text].map(character => PLAIN_FORMS.get(character) ?? character).join("");
}

/**
 * Independent oracle for "raised, smaller, attached", deliberately derived from
 * different IR fields than the renderer uses. The renderer recovers a baseline
 * from the published viewport quad and its ascent ratio, in a coordinate space
 * whose y grows downward. This reads the source text-space transform, where the
 * y translation is the baseline itself and grows upward, and the parser's own
 * reported glyph height rather than the derived advance box. If either
 * derivation is wrong the two disagree, which a restatement of the renderer's
 * arithmetic could not detect.
 */
function rawScriptGeometry(base, script) {
  const baseHeight = base.raw_height;
  if (!(baseHeight > 0) || !(script.raw_height > 0)) return null;
  // Unrotated, unskewed runs only. A sheared run has no y-axis baseline.
  for (const item of [base, script]) {
    if (item.raw_transform.length !== 6 || item.raw_transform[1] !== 0 || item.raw_transform[2] !== 0) {
      return null;
    }
  }
  return {
    ratio: script.raw_height / baseHeight,
    rise: (script.raw_transform[5] - base.raw_transform[5]) / baseHeight,
    gap: (script.bbox.x - (base.bbox.x + base.bbox.width)) / baseHeight,
  };
}

function paintedItems(page) {
  return page.raw_items.filter(item => item.is_whitespace !== true && item.text.trim().length > 0);
}

/**
 * Every raised run the source painted on a page, representable or not.
 * Attachment starts inside one line; the run is then followed by raw text-space
 * baseline equality wherever the source continued it, including across the IR's
 * line grouping.
 */
function raisedRuns(page) {
  const byId = new Map(page.raw_items.map(item => [item.id, item]));
  const painted = paintedItems(page);
  const runs = [];
  for (const line of page.lines) {
    const items = line.item_ids.map(id => byId.get(id))
      .filter(item => item && item.is_whitespace !== true && item.text.trim().length > 0);
    const lineIds = new Set(items.map(item => item.id));
    for (let index = 1; index < items.length; index += 1) {
      const measured = rawScriptGeometry(items[index - 1], items[index]);
      if (measured === null) continue;
      if (!(measured.ratio >= 0.6 && measured.ratio <= 0.82
        && measured.rise >= 0.28 && measured.rise <= 0.45
        && measured.gap >= -0.1 && measured.gap <= 0.1)) continue;
      const run = [];
      const claimed = new Set();
      for (let tail = items[index]; tail;) {
        run.push(tail);
        claimed.add(tail.id);
        tail = painted.find(candidate => !claimed.has(candidate.id)
          && candidate.raw_transform[5] === tail.raw_transform[5]
          && candidate.bbox.x >= tail.bbox.x + tail.bbox.width - tail.raw_height * 0.35
          && candidate.bbox.x <= tail.bbox.x + tail.bbox.width + tail.raw_height * 0.6);
      }
      while (index + 1 < items.length && claimed.has(items[index + 1].id)) index += 1;
      const source = run.map(item => item.text).join("");
      runs.push({
        page: page.page,
        source,
        // Representable and wholly on this line: the two conditions the
        // renderer promises are jointly necessary before it writes anything.
        transcribable: run.every(item => lineIds.has(item.id)) && superscriptForm(source) !== null,
      });
    }
  }
  return runs;
}

function superscriptRuns(text) {
  return text.match(new RegExp(`[${[...SUPERSCRIPT_CHARACTERS].join("")}]+`, "gu")) ?? [];
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

describe("external Shannon raised-glyph transcription", () => {
  beforeAll(async () => {
    if (SOURCE) converted = await convertShannon();
  }, 240_000);

  it.runIf(Boolean(SOURCE))("writes exactly the raised runs the source painted and can represent", () => {
    const { pages, bodies } = converted;
    const runs = pages.flatMap(raisedRuns);
    const transcribable = runs.filter(run => run.transcribable);

    // Both sides computed. The renderer must have written every raised run an
    // independent reading of the source finds representable and whole, in
    // document order, and nothing else anywhere on any page.
    expect(transcribable.length).toBeGreaterThan(0);
    for (const page of pages) {
      const expected = transcribable.filter(run => run.page === page.page)
        .map(run => superscriptForm(run.source));
      expect(superscriptRuns(bodies.get(page.page) ?? ""), `page ${page.page}`).toEqual(expected);
    }

    // The abstention path is genuinely exercised by this document, so the
    // equality above is a real constraint and not a vacuous one.
    expect(runs.length - transcribable.length).toBeGreaterThan(0);
  });

  it.runIf(Boolean(SOURCE))("only substitutes characters, and never inside the source IR", () => {
    const { pages, chunks } = converted;
    const rendered = chunks.map(chunk => chunk.markdown).join("");

    // Folding every superscript back to its plain character has to be total and
    // length-preserving. That is what makes this a substitution rather than a
    // rewrite: no character position moved, so nothing around a raised run can
    // have been dropped, reordered, or invented.
    const folded = fold(rendered);
    expect(folded).not.toBe(rendered);
    expect(folded.length).toBe(rendered.length);
    expect(superscriptRuns(folded)).toEqual([]);

    // The projection is emission-only: the source Extraction IR the Markdown
    // was derived from still holds the flat characters the parser reported.
    const mutated = pages.flatMap(page => [
      ...page.lines.map(line => line.text),
      ...page.raw_items.map(item => item.text),
    ]).filter(text => superscriptRuns(text).length > 0);
    expect(mutated).toEqual([]);
  });

  it.runIf(Boolean(SOURCE))("reports the raised-glyph rule in its limitations", () => {
    const [chunk] = converted.chunks;
    const limitation = chunk.limitations.find(value => value.includes("raised above the baseline"));
    expect(limitation).toBeDefined();
    expect(limitation).toMatch(/footnote reference/i);
    expect(limitation).toMatch(/does not distinguish/i);
  });
});
