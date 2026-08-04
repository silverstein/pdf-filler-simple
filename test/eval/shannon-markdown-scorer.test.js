import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeShannonText, scoreShannonMarkdown } from "./shannon-markdown-scorer.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST = path.join(REPO_ROOT, "test/fixtures/eval/shannon/manifest.v1.json");

async function oracle() {
  return JSON.parse(await fs.readFile(MANIFEST, "utf8")).oracle;
}

describe("Shannon Markdown adversarial scorer", () => {
  it("normalizes presentation punctuation without repairing displaced text", () => {
    expect(normalizeShannonText("A—B  *C*\nD")).toBe("a-b c d");
    expect(normalizeShannonText("ENTROPY<br>POWER GAIN<br />IN DECIBELS")).toBe("entropy power gain in decibels");
    expect(normalizeShannonText("HE recent T bandwidth")).not.toContain("the recent");
  });

  it("keeps metric families separate and exposes equation-like false headings", async () => {
    const result = scoreShannonMarkdown({
      markdown: [
        "# A Mathematical Theory of Communication",
        "## PART I: DISCRETE NOISELESS SYSTEMS",
        "### H = pi log pi",
        "# �",
        "# X",
        "The recent development of various methods of modulation such as PCM and PPM which exchange bandwidth for signal-to-noise ratio.",
        "The fundamental problem of communication is that of reproducing at one point either exactly or approximately a message selected at another point.",
        "Certain Factors Affecting Telegraph Speed. Transmission of Information.",
        "TABLE I",
      ].join("\n\n"),
      oracle: await oracle(),
      evidence: { page_identity: true, typed_coverage_gaps: true },
    });
    expect(result).not.toHaveProperty("overall_score");
    expect(result.heading_hierarchy.equation_like_false_positive_count).toBe(1);
    expect(result.heading_hierarchy.malformed_or_fragmentary_false_positive_count).toBe(2);
    expect(result.paragraph_continuity.found).toBeGreaterThanOrEqual(2);
    expect(result.evidence).toEqual({
      page_identity: true,
      typed_coverage_gaps: true,
      canonical_coordinates: false,
      engine_native_coordinates: false,
    });
  });

  it("does not award reading-order or table credit to mere token presence", async () => {
    const result = scoreShannonMarkdown({
      markdown: [
        "Theorem 12",
        "Representation of a noisy discrete channel",
        "PART II: THE DISCRETE CHANNEL WITH NOISE",
        "TABLE I",
        "entropy power gain in decibels impulse response gain entropy power factor",
        "| value | value |",
        "|---|---|",
        "| 1 | 2 |",
      ].join("\n"),
      oracle: await oracle(),
      evidence: {},
    });
    expect(result.reading_order.complete_groups).toBe(0);
    expect(result.table_topology.qualifying_table_count).toBe(0);
    expect(result.table_topology.topology_present).toBe(false);
  });

  it("does not award equation credit to scattered prose or header terms in table data rows", async () => {
    const result = scoreShannonMarkdown({
      markdown: [
        "<!-- PDF page 1 -->",
        "C appears in prose.",
        "x".repeat(250),
        "W log P N appear much later.",
        "| junk | header |",
        "|---|---|",
        "| impulse response | gain |",
        "| entropy power factor | entropy power gain in decibels |",
        "| value | value |",
        "| value | value |",
        "| value | value |",
      ].join("\n"),
      oracle: await oracle(),
      evidence: {},
    });
    expect(result.equations.found).toBe(0);
    expect(result.table_topology.qualifying_table_count).toBe(0);
    expect(result.table_topology.topology_present).toBe(false);
  });

  it("awards topology credit to the source-faithful four-column Table I header and five data rows", async () => {
    const result = scoreShannonMarkdown({
      markdown: [
        "TABLE I",
        "| GAIN | ENTROPY POWER FACTOR | ENTROPY POWER GAIN IN DECIBELS | IMPULSE RESPONSE |",
        "|---|---|---|---|",
        "| 1 | a | b | c |",
        "| 2 | a | b | c |",
        "| 3 | a | b | c |",
        "| 4 | a | b | c |",
        "| 5 | a | b | c |",
      ].join("\n"),
      oracle: await oracle(),
      evidence: {},
    });
    expect(result.table_topology.qualifying_table_count).toBe(1);
    expect(result.table_topology.topology_present).toBe(true);
  });

  it("reports omissions and duplications independently", async () => {
    const manifestOracle = await oracle();
    const repeated = manifestOracle.exactly_once_anchors[0];
    const result = scoreShannonMarkdown({
      markdown: `${repeated}\n${repeated}\n`,
      oracle: manifestOracle,
      evidence: {},
    });
    expect(result.omissions_and_duplication.duplicated).toEqual([{ anchor: repeated, count: 2 }]);
    expect(result.omissions_and_duplication.omitted.length).toBe(manifestOracle.exactly_once_anchors.length - 1);
  });

  it("does not count a shorter Roman-numeral label inside a longer one", async () => {
    const manifestOracle = await oracle();
    const result = scoreShannonMarkdown({
      markdown: "TABLE I\nTABLE II\nTABLE III\n",
      oracle: manifestOracle,
      evidence: {},
    });
    const table = result.omissions_and_duplication.details.find(item => item.anchor === "TABLE I");
    expect(table.count).toBe(1);
  });
});
