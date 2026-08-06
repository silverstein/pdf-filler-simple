import fs from "node:fs/promises";
import path from "node:path";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uniqueComputerModernFamily } from "../server/layout-extraction.js";
import {
  CM_CODEPOINTS,
  CM_TFM_METRICS,
  CM_WITNESS_CODEPOINTS,
} from "../server/type3-cm-reference.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAYOUT_MODULE = path.join(REPO_ROOT, "server", "layout-extraction.js");
const CM_REFERENCE_MODULE = path.join(REPO_ROOT, "server", "type3-cm-reference.js");
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
      witness_codes: [...tail.matchAll(/original_char_code: (\d+)/g)].map(match => Number(match[1])),
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
    layoutSource,
    "\"./type3-cm-reference.js\"",
    JSON.stringify(pathToFileURL(CM_REFERENCE_MODULE).href),
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
