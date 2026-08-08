import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TYPE3_RECOVERY_ENTRIES, uniqueComputerModernFamily } from "../server/layout-extraction.js";
import {
  CM_CODEPOINTS,
  CM_TFM_METRICS,
  CM_WITNESS_CODEPOINTS,
} from "../server/type3-cm-reference.js";
import {
  CM_PK_REFERENCE_DIGEST_COUNT,
  CM_PK_REFERENCE_FACE_COUNT,
  CM_PK_REFERENCE_FACES,
  CM_PK_REFERENCE_QUALIFICATION,
} from "../server/type3-cm-pk-reference.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAYOUT_MODULE = path.join(REPO_ROOT, "server", "layout-extraction.js");
const CM_REFERENCE_MODULE = path.join(REPO_ROOT, "server", "type3-cm-reference.js");
const CM_PK_REFERENCE_MODULE = path.join(REPO_ROOT, "server", "type3-cm-pk-reference.js");
const CMEX_FAMILY = "computer-modern-math-extension";
// TFM widths are fix-word values: the design-size-relative width is width / 2^20.
const TFM_FIX_WORD = 1048576;

let layoutSource = "";
let registryEntries = [];
let scratchDirectory = "";

/**
 * TYPE3_RECOVERY_REGISTRY is a module-private frozen constant, so its shape
 * cannot be reached through a real export. These tests therefore derive the
 * same facts by parsing server/layout-extraction.js, and every derivation
 * asserts that it actually found something so a silent parse failure cannot
 * turn a registry check into a vacuous pass.
 */
function parseRegistryEntries(source) {
  const blockStart = source.indexOf("const TYPE3_RECOVERY_REGISTRY = Object.freeze([");
  expect(blockStart).toBeGreaterThan(-1);
  const blockEnd = source.indexOf("\n]);\n", blockStart);
  expect(blockEnd).toBeGreaterThan(blockStart);
  const block = source.slice(blockStart, blockEnd);

  const openers = [...block.matchAll(/\n {2}Object\.freeze\(\{\n/g)].map(match => match.index);
  expect(openers.length).toBeGreaterThan(0);
  return openers.map((start, index) => {
    const text = block.slice(start, openers[index + 1] ?? block.length);
    const witnessStart = text.indexOf("witnesses:");
    expect(witnessStart).toBeGreaterThan(-1);
    const head = text.slice(0, witnessStart);
    const tail = text.slice(witnessStart);
    const footprint = /complete_font_enrollment: Object\.freeze\(\[([^\]]*)\]\)/.exec(head);
    return {
      id: /id: "([^"]+)"/.exec(head)?.[1] ?? null,
      family: /family: "([^"]+)"/.exec(head)?.[1] ?? null,
      original_char_code: Number(/original_char_code: (\d+)/.exec(head)?.[1]),
      complete_font_enrollment: footprint
        ? footprint[1].split(",").map(value => Number(value.trim()))
        : null,
      glyph_sha256: /glyph_sha256: "([0-9a-f]{64})"/.exec(head)?.[1] ?? null,
      witness_codes: [...tail.matchAll(/original_char_code: (\d+)/g)].map(match => Number(match[1])),
      witnesses: [...tail.matchAll(/original_char_code: (\d+), glyph_sha256: "([0-9a-f]{64})"/g)]
        .map(match => ({ original_char_code: Number(match[1]), glyph_sha256: match[2] })),
      source: text,
    };
  });
}

function registryEntryById(id) {
  const entry = registryEntries.find(candidate => candidate.id === id);
  expect(entry, `registry entry ${id} is missing`).toBeTruthy();
  return entry;
}

function replaceOnce(source, needle, replacement) {
  expect(source.split(needle)).toHaveLength(2);
  return source.replace(needle, replacement);
}

/**
 * Writes a copy of server/layout-extraction.js with one deliberately malformed
 * registry entry and imports it. The copy lives under test/ so bare specifiers
 * such as "pdf-lib" still resolve from the repository's node_modules, and its
 * only relative import is rebased onto the real reference module.
 */
async function importMutatedLayoutModule(name, mutate) {
  const rebased = replaceOnce(
    replaceOnce(
      layoutSource,
      "\"./type3-cm-reference.js\"",
      JSON.stringify(pathToFileURL(CM_REFERENCE_MODULE).href),
    ),
    "\"./type3-cm-pk-reference.js\"",
    JSON.stringify(pathToFileURL(CM_PK_REFERENCE_MODULE).href),
  );
  const mutated = mutate(rebased);
  expect(mutated, "mutation did not change the module source").not.toBe(rebased);
  const file = path.join(scratchDirectory, `${name}.mjs`);
  await fs.writeFile(file, mutated);
  return import(pathToFileURL(file).href);
}

function mutateEntry(source, id, mutateEntrySource) {
  const entry = registryEntryById(id);
  return replaceOnce(source, entry.source, mutateEntrySource(entry.source));
}

beforeAll(async () => {
  layoutSource = await fs.readFile(LAYOUT_MODULE, "utf8");
  registryEntries = parseRegistryEntries(layoutSource);
  // Use the repo's central allocator rather than a private mkdtemp, so this
  // suite stays out of the reviewed scratch-allocator inventory. The copies
  // must live inside the checkout for Node to resolve node_modules.
  scratchDirectory = await createTestTempDirectory(REPO_ROOT, "type3-gate");
});

afterAll(async () => {
  if (scratchDirectory) await removeTestTempDirectory(scratchDirectory);
});

describe("Computer Modern math-extension enrollment", () => {
  it("enrolls every reviewed cmex slot officially and keeps no witness-only codepoint", () => {
    expect(CM_CODEPOINTS[CMEX_FAMILY]).toEqual({
      0: "(",
      1: ")",
      2: "[",
      3: "]",
      16: "(",
      17: ")",
      18: "(",
      19: ")",
      20: "[",
      21: "]",
      // The two \bigg curly braces from bigdel.mf. They are self-contained
      // delimiters of the class already enrolled here, and they are also the
      // only cmex10 codes whose as-shipped ps-type3 widths pin the family
      // alongside the two \Big parentheses, so enrolling them is what lets the
      // labeled fixture demonstrate slots 16 and 17.
      26: "{",
      27: "}",
      82: "∫",
      90: "∫",
    });
    // Every enrolled slot is usable as a witness, so the separate witness-only
    // table is now empty rather than merely missing this family.
    expect(CM_WITNESS_CODEPOINTS).toEqual({});
    expect(CM_WITNESS_CODEPOINTS[CMEX_FAMILY]).toBeUndefined();
  });

  it("resolves a genuine cmex10 width vector to the math-extension family", () => {
    const cmex10 = CM_TFM_METRICS.find(metric => metric.name === "cmex10");
    expect(cmex10).toBeTruthy();
    expect(cmex10.family).toBe(CMEX_FAMILY);
    const scaled = (codes, scale) => codes.map(code => {
      const fixWord = cmex10.widths[code];
      expect(Number.isSafeInteger(fixWord) && fixWord > 0).toBe(true);
      return [code, Math.round((scale * fixWord) / TFM_FIX_WORD)];
    });

    const everySlot = Object.keys(CM_CODEPOINTS[CMEX_FAMILY]).map(Number);
    expect(uniqueComputerModernFamily(scaled(everySlot, 100))).toBe(CMEX_FAMILY);
    // The dvips subset that motivates the relaxed witness rule: an
    // integrals-only cmex font carries exactly the two integral slots and must
    // still resolve to one family.
    expect(uniqueComputerModernFamily(scaled([82, 90], 72))).toBe(CMEX_FAMILY);
    expect(uniqueComputerModernFamily(new Map(scaled([82, 90], 72)))).toBe(CMEX_FAMILY);
  });

  it("refuses an ambiguous or unmatched width vector", () => {
    const cmex10 = CM_TFM_METRICS.find(metric => metric.name === "cmex10");
    // Genuine cmex10 widths, but slots 0 and 1 are equal-width and also fit the
    // monospaced cm faces, so the family is not unique evidence.
    const ambiguous = [0, 1].map(code => [code, Math.round((100 * cmex10.widths[code]) / TFM_FIX_WORD)]);
    expect(ambiguous[0][1]).toBe(ambiguous[1][1]);
    expect(uniqueComputerModernFamily(ambiguous)).toBeNull();
    // No consistent scale exists for these, so nothing matches at all.
    expect(uniqueComputerModernFamily([[0, 7], [1, 999]])).toBeNull();
    expect(uniqueComputerModernFamily([[82, 47]])).toBeNull();
  });
});

describe("shipped Type-3 recovery registry consistency", () => {
  it("parses a registry that actually exercises the relaxed witness rule", () => {
    expect(registryEntries.length).toBeGreaterThan(60);
    expect(registryEntries.every(entry => entry.id && entry.family)).toBe(true);
    expect(registryEntries.every(entry => Number.isSafeInteger(entry.original_char_code))).toBe(true);
    expect(registryEntries.every(entry => entry.witness_codes.length >= 1)).toBe(true);
    const singleWitness = registryEntries.filter(entry => entry.witness_codes.length === 1);
    expect(singleWitness.length).toBeGreaterThan(0);
    expect(singleWitness.every(entry => entry.family === CMEX_FAMILY)).toBe(true);
  });

  it("gives every single-witness entry a complete_font_enrollment footprint", () => {
    for (const entry of registryEntries.filter(candidate => candidate.witness_codes.length === 1)) {
      expect(entry.complete_font_enrollment, `${entry.id} declares no footprint`).toBeTruthy();
    }
  });

  it("declares each footprint as exactly its own code plus its witness codes", () => {
    const declared = registryEntries.filter(entry => entry.complete_font_enrollment);
    expect(declared.length).toBeGreaterThan(0);
    for (const entry of declared) {
      expect(
        [...new Set(entry.complete_font_enrollment)].sort((left, right) => left - right),
        `${entry.id} footprint is not {own code} union {witness codes}`,
      ).toEqual(
        [...new Set([entry.original_char_code, ...entry.witness_codes])].sort((left, right) => left - right),
      );
    }
  });

  it("enrolls every footprint code in the official encoding for its family", () => {
    for (const entry of registryEntries.filter(candidate => candidate.complete_font_enrollment)) {
      for (const code of entry.complete_font_enrollment) {
        expect(
          CM_CODEPOINTS[entry.family]?.[code],
          `${entry.id} footprint code ${code} is not enrolled for ${entry.family}`,
        ).toBeDefined();
      }
    }
  });

  it("never puts a footprint on an entry that already has two witnesses", () => {
    for (const entry of registryEntries.filter(candidate => candidate.witness_codes.length >= 2)) {
      expect(
        entry.complete_font_enrollment,
        `${entry.id} has two witnesses and does not need a footprint`,
      ).toBeNull();
    }
  });
});

/**
 * The generated Computer Modern PK lane.
 *
 * These entries are not written by hand and are not reviewed one at a time, so
 * what has to be checked is the construction rather than the contents: that
 * every enrolled slot is an official one, that no digest in the table stands
 * for two characters of the same family, and above all that the expansion
 * cannot make two entries match the same code. That last property is what
 * keeps the reviewed lane intact — `matchingRegistryEntries` DROPS a code two
 * entries both match, so a careless expansion would silently delete recoveries
 * instead of adding them.
 */
describe("generated Computer Modern PK enrollment", () => {
  const generated = TYPE3_RECOVERY_ENTRIES.filter(
    entry => entry.qualification === CM_PK_REFERENCE_QUALIFICATION,
  );

  it("is a real second lane under its own qualification string", () => {
    expect(CM_PK_REFERENCE_QUALIFICATION).toBe("ctan-cm-metafont-generated-pk-v1");
    expect(generated.length).toBeGreaterThan(1000);
    // The reviewed lane is untouched and still says what it always said.
    const reviewed = TYPE3_RECOVERY_ENTRIES.filter(
      entry => entry.qualification !== CM_PK_REFERENCE_QUALIFICATION,
    );
    expect(reviewed).toHaveLength(registryEntries.length);
    expect(new Set(reviewed.map(entry => entry.qualification))).toEqual(new Set([
      "ctan-cm-encoding-plus-reviewed-pk-raster-v1",
      "ctan-cm-type3-labeled-reference-2026-08",
    ]));
  });

  it("keys only officially enrolled slots of the three supported families", () => {
    expect(CM_PK_REFERENCE_FACES).toHaveLength(CM_PK_REFERENCE_FACE_COUNT);
    let digests = 0;
    for (const record of CM_PK_REFERENCE_FACES) {
      expect(CM_CODEPOINTS[record.family], `${record.face} has no official encoding`).toBeDefined();
      const codes = Object.keys(record.codes).map(Number);
      // Two slots is the floor: one slot could never meet the matcher's
      // requirement for a second, independent, agreeing glyph.
      expect(codes.length, `${record.face}@${record.profile} carries too few slots`).toBeGreaterThanOrEqual(2);
      for (const code of codes) {
        expect(
          CM_CODEPOINTS[record.family][code],
          `${record.face} slot ${code} is not enrolled for ${record.family}`,
        ).toBeDefined();
        expect(record.codes[code]).toMatch(/^[0-9a-f]{64}$/u);
        digests += 1;
      }
    }
    expect(digests).toBe(CM_PK_REFERENCE_DIGEST_COUNT);
  });

  it("never lets one digest stand for two slots of the same family", () => {
    const slotsByDigest = new Map();
    for (const record of CM_PK_REFERENCE_FACES) {
      for (const [code, digest] of Object.entries(record.codes)) {
        const key = `${record.family}:${digest}`;
        if (!slotsByDigest.has(key)) slotsByDigest.set(key, new Set());
        slotsByDigest.get(key).add(Number(code));
      }
    }
    expect(slotsByDigest.size).toBeGreaterThan(0);
    for (const [key, codes] of slotsByDigest) {
      expect([...codes], `${key} stands at more than one slot`).toHaveLength(1);
    }
  });

  it("cannot make two enrollment records match the same code", () => {
    /*
     * Two records can only both match one drawn code if they carry the same
     * `glyph_sha256`, because each is compared against the single digest the
     * font has at that code. Within such a group, every pair has to be
     * unsatisfiable together, and there are exactly two ways for that to be
     * true of a font that has one digest per code:
     *
     *   - Footprints. `complete_font_enrollment` demands the font's set of
     *     drawn enrolled slots be exactly that set, so two different
     *     footprints can never both hold, and a footprint can never hold
     *     alongside a record that needs a slot the footprint excludes.
     *   - Witness disagreement. If the two records name a common witness code
     *     and expect different digests there, at most one can be satisfied.
     *
     * Anything else in a group is a latent double match, which
     * `matchingRegistryEntries` resolves by dropping the code — that is, by
     * losing a recovery. The check is pairwise over the whole shipped
     * registry, so it constrains the reviewed lane too.
     */
    const footprintOf = entry => (entry.complete_font_enrollment
      ? [...entry.complete_font_enrollment].sort((left, right) => left - right)
      : null);
    const requiredCodes = entry => [
      entry.original_char_code,
      ...entry.witnesses.map(witness => witness.original_char_code),
    ];
    const mutuallyExclusive = (left, right) => {
      const leftFootprint = footprintOf(left);
      const rightFootprint = footprintOf(right);
      if (leftFootprint && rightFootprint && leftFootprint.join("+") !== rightFootprint.join("+")) return true;
      if (leftFootprint && requiredCodes(right).some(code => !leftFootprint.includes(code))) return true;
      if (rightFootprint && requiredCodes(left).some(code => !rightFootprint.includes(code))) return true;
      const byCode = new Map(left.witnesses.map(witness => [witness.original_char_code, witness.glyph_sha256]));
      return right.witnesses.some(witness => byCode.has(witness.original_char_code)
        && byCode.get(witness.original_char_code) !== witness.glyph_sha256);
    };

    const groups = new Map();
    for (const entry of TYPE3_RECOVERY_ENTRIES) {
      const key = `${entry.family}:${entry.original_char_code}:${entry.glyph_sha256}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    // Guard: a registry with no colliding group at all would satisfy the loop
    // below vacuously, and the shipped one does have them.
    expect([...groups.values()].filter(entries => entries.length > 1).length).toBeGreaterThan(10);
    for (const entries of groups.values()) {
      for (let left = 0; left < entries.length; left += 1) {
        for (let right = left + 1; right < entries.length; right += 1) {
          expect(
            mutuallyExclusive(entries[left], entries[right]),
            `${entries[left].id} and ${entries[right].id} can both match the same drawn code`,
          ).toBe(true);
        }
      }
    }
  });

  it("yields to the reviewed lane wherever the two agree", () => {
    const reviewedTriples = new Set(TYPE3_RECOVERY_ENTRIES
      .filter(entry => entry.qualification !== CM_PK_REFERENCE_QUALIFICATION)
      .map(entry => `${entry.family}:${entry.original_char_code}:${entry.glyph_sha256}`));
    for (const entry of generated) {
      expect(
        reviewedTriples.has(`${entry.family}:${entry.original_char_code}:${entry.glyph_sha256}`),
        `${entry.id} duplicates a reviewed enrollment instead of deferring to it`,
      ).toBe(false);
    }
    /*
     * The generated reference was built without ever seeing the reviewed
     * digests, so the slots it does reproduce are independent corroboration of
     * both lanes at once. Recorded as a floor rather than an equality: adding a
     * pinned resolution should raise it.
     */
    const generatedTriples = new Set(CM_PK_REFERENCE_FACES.flatMap(record => Object
      .entries(record.codes)
      .map(([code, digest]) => `${record.family}:${code}:${digest}`)));
    const reproduced = [...reviewedTriples].filter(triple => generatedTriples.has(triple));
    expect(reproduced.length).toBeGreaterThanOrEqual(48);
  });

  it("binds the generated reference to its checked-in provenance", async () => {
    const provenance = JSON.parse(await fs.readFile(
      path.join(REPO_ROOT, "test/fixtures/eval/extraction/type3-cm-pk-reference.provenance.json"),
      "utf8",
    ));
    const digest = async file => createHash("sha256").update(await fs.readFile(file)).digest("hex");
    expect(await digest(CM_PK_REFERENCE_MODULE))
      .toBe(provenance.outputs["server/type3-cm-pk-reference.js"]);
    expect(await digest(path.join(REPO_ROOT, "pdf-toolkit-mcp-share/server/type3-cm-pk-reference.js")))
      .toBe(provenance.outputs["pdf-toolkit-mcp-share/server/type3-cm-pk-reference.js"]);
    expect(provenance.qualification).toBe(CM_PK_REFERENCE_QUALIFICATION);
    expect(provenance.reference.emitted_digest_count).toBe(CM_PK_REFERENCE_DIGEST_COUNT);
    expect(provenance.reference.enrolled_face_records).toBe(CM_PK_REFERENCE_FACE_COUNT);
    expect(provenance.sources[0].sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.keys(provenance.metafont.face_source_sha256)).toHaveLength(provenance.metafont.face_count);
    expect(provenance.metafont.rasterisations_failed).toEqual([]);
    /*
     * The pin is four numbers per profile, and the mode name beside them is a
     * label rather than evidence. The generator proves that by building one
     * face from two unrelated base modes with the same four numbers and
     * requiring identical DECODED RASTERS; this asserts the proof was recorded
     * and that the numbers themselves did not drift.
     *
     * Decoded rasters, not file bytes, and the distinction is load-bearing:
     * METAFONT stamps the run's date and time into the generic font's
     * preamble and GFtoPK carries it through, so a byte comparison of two
     * runs straddling a second boundary would fail on the clock while the
     * rasters were identical. A reproducibility claim that fails at a second
     * boundary is worse than no claim.
     */
    for (const profile of provenance.profiles) {
      expect(profile.mode_independence_base_modes).toHaveLength(2);
      expect(new Set(profile.mode_independence_base_modes).size).toBe(2);
      expect(profile.mode_independence_face_raster_sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(Number.isFinite(profile.blacker)).toBe(true);
      expect(Number.isFinite(profile.fillin)).toBe(true);
      expect(Number.isFinite(profile.o_correction)).toBe(true);
    }
    expect(provenance.profiles.map(profile => [
      profile.resolution, profile.blacker, profile.fillin, profile.o_correction,
    ])).toEqual([[600, 0.25, 0, 1], [300, 0, 0.2, 0.6]]);
    expect(new Set(CM_PK_REFERENCE_FACES.map(record => record.profile)))
      .toEqual(new Set(provenance.profiles.map(profile => profile.id)));
  });

  it("keeps every generated record inside the shipped enrollment schema", () => {
    for (const entry of generated) {
      expect(entry.target_unicode).toBe(CM_CODEPOINTS[entry.family][entry.original_char_code]);
      expect(entry.source_unicode).toBe(String.fromCharCode(entry.original_char_code));
      expect(entry.glyph_sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(entry.witnesses.length === 1 || entry.witnesses.length === 2).toBe(true);
      expect(Boolean(entry.complete_font_enrollment)).toBe(entry.witnesses.length === 1);
      for (const witness of entry.witnesses) {
        expect(witness.original_char_code).not.toBe(entry.original_char_code);
        expect(CM_CODEPOINTS[entry.family][witness.original_char_code]).toBeDefined();
      }
    }
  });
});

describe("Type-3 registry startup invariants", () => {
  const SINGLE_WITNESS_ID = "cmex-pk-raster-textstyle-integral-e5fa9e-v1";
  const TWO_WITNESS_ID = "cmsy-pk-raster-plus-or-minus-b68b24-v1";

  it("loads an unmutated copy of the module cleanly", async () => {
    const module = await importMutatedLayoutModule(
      "control",
      source => `${source}\nexport const MUTATION_CONTROL = true;\n`,
    );
    expect(module.MUTATION_CONTROL).toBe(true);
    expect(typeof module.uniqueComputerModernFamily).toBe("function");
  });

  it("rejects a single-witness entry that declares no footprint", async () => {
    await expect(importMutatedLayoutModule("single-witness-no-footprint", source => mutateEntry(
      source,
      SINGLE_WITNESS_ID,
      entrySource => replaceOnce(entrySource, /* strip the footprint line */
        "    complete_font_enrollment: Object.freeze([82, 90]),\n", ""),
    ))).rejects.toThrow(`Type-3 registry ${SINGLE_WITNESS_ID} lacks two official Computer Modern witnesses`);
  });

  it("rejects a footprint that is not exactly its own code plus its witnesses", async () => {
    await expect(importMutatedLayoutModule("footprint-wrong-set", source => mutateEntry(
      source,
      SINGLE_WITNESS_ID,
      entrySource => replaceOnce(
        entrySource,
        "complete_font_enrollment: Object.freeze([82, 90])",
        "complete_font_enrollment: Object.freeze([82])",
      ),
    ))).rejects.toThrow(`Type-3 registry ${SINGLE_WITNESS_ID} lacks two official Computer Modern witnesses`);
  });

  it("rejects a footprint that names a code the family does not enroll", async () => {
    expect(CM_CODEPOINTS[CMEX_FAMILY][91]).toBeUndefined();
    await expect(importMutatedLayoutModule("footprint-unenrolled-code", source => mutateEntry(
      source,
      SINGLE_WITNESS_ID,
      entrySource => replaceOnce(
        entrySource,
        "complete_font_enrollment: Object.freeze([82, 90])",
        "complete_font_enrollment: Object.freeze([82, 90, 91])",
      ),
    ))).rejects.toThrow(`Type-3 registry ${SINGLE_WITNESS_ID} declares an unenrolled code in its font footprint`);
  });

  it("rejects a footprint on an entry that already has two witnesses", async () => {
    await expect(importMutatedLayoutModule("footprint-on-two-witnesses", source => mutateEntry(
      source,
      TWO_WITNESS_ID,
      entrySource => replaceOnce(
        entrySource,
        "    witnesses: Object.freeze([\n",
        "    complete_font_enrollment: Object.freeze([6, 0, 33]),\n    witnesses: Object.freeze([\n",
      ),
    ))).rejects.toThrow(`Type-3 registry ${TWO_WITNESS_ID} declares a font footprint it does not need`);
  });
});

/**
 * The two corroboration rules the matcher applies to every registry entry
 * before it recovers anything.
 *
 * Both are module-private, and both sit behind `collectType3GlyphRecoveries`,
 * which needs a real page carrying real enrolled Computer Modern rasters to
 * reach — rasters this repository deliberately does not vendor. So these drive
 * `matchingRegistryEntries` directly, through the same source-copy import the
 * startup-invariant tests above use, with one test-only export appended. The
 * module under test is still the shipped source text: delete either rule from
 * server/layout-extraction.js and the copy loses it too.
 *
 * `enrolled` is what `enrolledGlyphEvidence` builds — every officially
 * enrolled code the font actually draws, mapped to its glyph digest — and
 * `rawFont` is consulted only for `metricWidths`, so a Map is the whole of it.
 */
describe("Type-3 registry match corroboration", () => {
  // Two witnesses, so no complete_font_enrollment footprint to satisfy and the
  // fixture below is the entry's whole evidence.
  const ENTRY_ID = "cmmi-pk-raster-alpha-e688a8-v1";
  const FAMILY = "computer-modern-math-italic";
  let matchingRegistryEntries = null;
  let entry = null;

  const fixture = () => {
    const enrolled = new Map([[entry.original_char_code, entry.glyph_sha256]]);
    const metricWidths = new Map([[entry.original_char_code, 45]]);
    for (const witness of entry.witnesses) {
      enrolled.set(witness.original_char_code, witness.glyph_sha256);
      metricWidths.set(witness.original_char_code, 41);
    }
    return { enrolled, rawFont: { metricWidths } };
  };

  const matchedIds = ({ enrolled, rawFont }) =>
    matchingRegistryEntries(enrolled, rawFont, FAMILY).map(match => match.id);

  beforeAll(async () => {
    ({ matchingRegistryEntries } = await importMutatedLayoutModule(
      "matcher-exposed",
      source => `${source}\nexport { matchingRegistryEntries };\n`,
    ));
    entry = registryEntryById(ENTRY_ID);
    expect(entry.glyph_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.witnesses).toHaveLength(2);
    expect(entry.complete_font_enrollment).toBeNull();
    // The positive control every case below is measured against. Without it a
    // safeguard could look enforced while the fixture simply never matched.
    expect(matchedIds(fixture())).toContain(ENTRY_ID);
  });

  /**
   * Shape-code injectivity. The grid key drops the placement matrix, and
   * placement is what tells a Computer Modern period from a centred dot — the
   * same nine-by-nine blob at two heights. So the shape has to identify the
   * code on its own within its own font.
   */
  it("recovers nothing when one shape stands at two enrolled codes of the font", () => {
    const contested = fixture();
    // Code 12 is an officially enrolled math-italic slot that this entry does
    // not name, now carrying the entry's own shape. Pinned with a positive
    // width so nothing but injectivity can be doing the refusing.
    expect(contested.enrolled.has(12)).toBe(false);
    contested.enrolled.set(12, entry.glyph_sha256);
    contested.rawFont.metricWidths.set(12, 45);
    expect(matchedIds(contested)).not.toContain(ENTRY_ID);
  });

  it("recovers nothing when a witness shape stands at two enrolled codes", () => {
    const contested = fixture();
    contested.enrolled.set(12, entry.witnesses[0].glyph_sha256);
    contested.rawFont.metricWidths.set(12, 41);
    expect(matchedIds(contested)).not.toContain(ENTRY_ID);
  });

  /**
   * Positive-width pinning. Keeping zero-width slots in the linker's width map
   * is what lets a legacy font link at all, but it also lets a drawn glyph
   * reach the registry with no advance behind it, and a zero advance is
   * invisible to the TFM fingerprint that qualified the family. Every code the
   * match rests on must be one the fingerprint could actually see.
   */
  it("recovers nothing when the recovered code carries no positive declared width", () => {
    const unpinned = fixture();
    // Still drawn, still the right shape — only its declared advance is zero,
    // so `metricWidths` never held it.
    unpinned.rawFont.metricWidths.delete(entry.original_char_code);
    expect(unpinned.enrolled.get(entry.original_char_code)).toBe(entry.glyph_sha256);
    expect(matchedIds(unpinned)).not.toContain(ENTRY_ID);
  });

  it("recovers nothing when a witness carries no positive declared width", () => {
    for (const witness of entry.witnesses) {
      const unpinned = fixture();
      unpinned.rawFont.metricWidths.delete(witness.original_char_code);
      expect(unpinned.enrolled.get(witness.original_char_code)).toBe(witness.glyph_sha256);
      expect(matchedIds(unpinned)).not.toContain(ENTRY_ID);
    }
  });
});
