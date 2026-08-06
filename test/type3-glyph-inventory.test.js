import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CM_CODEPOINTS } from "../server/type3-cm-reference.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "inventory-type3-glyphs.mjs");
const FIXTURE = path.join(REPO_ROOT, "test", "fixtures", "eval", "extraction", "type3-cm-reference.pdf");
const PROVENANCE = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "extraction",
  "type3-cm-reference.provenance.json",
);

let report = null;
let provenance = null;

beforeAll(async () => {
  const { stdout } = await execFileAsync(process.execPath, [SCRIPT, "--source", FIXTURE], {
    cwd: REPO_ROOT,
    maxBuffer: 1_000_000,
  });
  report = JSON.parse(stdout);
  provenance = JSON.parse(await fs.readFile(PROVENANCE, "utf8"));
});

describe("Type-3 maintainer inventory", () => {
  it("keeps whitespace-like legacy glyph controls and reports explicit omissions", () => {
    expect(report).toMatchObject({
      schema: "pdf-tools.type3-glyph-inventory.v1",
      occurrence_count: 41,
      abstentions: [],
      // Page 1 is the original single-page reference, unchanged. Page 2 carries
      // the further embedded fonts that let the remaining enrolled slots be
      // drawn without widening the metric tolerance.
      source: { page_count: 2 },
    });
    expect(report.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        original_char_code: 11,
        source_unicode_codepoints: "U+000B",
        count: 1,
      }),
      expect.objectContaining({
        family: "computer-modern-math-symbol",
        original_char_code: 0,
        intended_unicode: "−",
        // The ps-type3 CharProc bytes this fixture carries are what qualified
        // this entry, so regenerating it must keep the digest match alive.
        registry_evidence_match_ids: expect.arrayContaining(["cmsy-ctan-type3-minus-v1"]),
        count: 1,
      }),
      expect.objectContaining({
        family: "computer-modern-math-symbol",
        original_char_code: 6,
        intended_unicode: "±",
        count: 1,
      }),
      expect.objectContaining({
        family: "computer-modern-math-extension",
        original_char_code: 82,
        intended_unicode: "∫",
        count: 1,
      }),
    ]));
  });

  /**
   * The provenance slot lists used to be hand-written, and a wrong literal
   * passed vacuously because nothing re-derived them. This measures the
   * fixture through the real pipeline and requires the recorded lists to be
   * exactly what came back, so the record cannot drift from the artifact.
   */
  it("resolves a family for every drawn glyph and matches the recorded slot lists", () => {
    const measured = {};
    for (const group of report.groups) {
      expect(
        group.family,
        `char code ${group.original_char_code} did not resolve to a family`,
      ).not.toBeNull();
      measured[group.family] ??= [];
      measured[group.family].push(group.original_char_code);
    }
    for (const codes of Object.values(measured)) codes.sort((left, right) => left - right);
    // Guard the derivation itself: an empty or single-family reading would
    // otherwise let both comparisons below pass without proving anything.
    expect(Object.keys(measured).sort()).toEqual([
      "computer-modern-math-extension",
      "computer-modern-math-italic",
      "computer-modern-math-symbol",
    ]);
    expect(Object.values(measured).flat()).toHaveLength(report.occurrence_count);
    expect(report.coverage).toMatchObject({
      unclassified_occurrence_count: 0,
      officially_unnamed_occurrence_count: 0,
      omitted_type3_occurrence_count: 0,
      classified_occurrence_count: report.occurrence_count,
    });
    expect(measured).toEqual(provenance.fixture_drawn_slots);
    expect(measured).toEqual(provenance.fixture_family_resolving_slots);
    // The headline claim of the artifact: every enrolled slot of every enrolled
    // family is demonstrated here, measured out of the PDF rather than read
    // back out of the provenance record that the same run wrote.
    for (const [family, codepoints] of Object.entries(CM_CODEPOINTS)) {
      expect(measured[family], `${family} is not demonstrated at all`).toEqual(
        Object.keys(codepoints).map(Number).sort((left, right) => left - right),
      );
    }
    expect(Object.keys(measured).sort()).toEqual(Object.keys(CM_CODEPOINTS).sort());
  });

  it("rejects ambiguous command-line input", async () => {
    await expect(execFileAsync(process.execPath, [SCRIPT, FIXTURE], { cwd: REPO_ROOT }))
      .rejects.toMatchObject({ code: 1 });
  });
});
