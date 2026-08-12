import { describe, expect, it } from "vitest";
import {
  editDistance,
  projectMarkdownPages,
  projectMarkdownTable,
  scoreDistinctFragments,
  scoreExtractionBakeoff,
  scoreTable,
} from "./extraction-bakeoff-scorer.js";

function fixture() {
  return {
    id: "case.one",
    category: "mixed_modality",
    sha256: "a".repeat(64),
    expected: {
      pages: [
        { page: 1, modality: "born_digital", transcript: "TITLE Alpha beta", ordered_fragments: ["Alpha", "beta"] },
        { page: 2, modality: "raster", transcript: "Raster truth", ordered_fragments: ["Raster", "truth"] },
      ],
      table: null,
    },
  };
}

function runs(payloadKey, hashKey, payload, basePid = 100) {
  return [0, 1, 2].map(index => ({
    repetition: index + 1,
    pid: basePid + index,
    elapsed_ms: 10 + index,
    [payloadKey]: index === 0 ? payload : null,
    [hashKey]: "b".repeat(64),
  }));
}

function reports() {
  const source = fixture();
  const sourceBindings = {
    manifest_sha256: "c".repeat(64),
    handoff_id: "d".repeat(64),
    receipt_sha256: "e".repeat(64),
    receipt_schema_sha256: "f".repeat(64),
  };
  return {
    manifest: { fixtures: [source] },
    markdownReport: {
      protocol: "pdf-tools.markdown-bakeoff.v1",
      repetitions_per_case: 3,
      runtime: { architecture: "arm64", node: "v26.3.1", platform: "darwin" },
      source_bindings: sourceBindings,
      cases: [{
        case_id: source.id,
        category: source.category,
        page_count: 2,
        source_sha256: source.sha256,
        stable: true,
        source_reopened_verified: true,
        runs: runs("result", "result_sha256", {
          markdown: "<!-- PDF page 1 -->\n\n# TITLE\nAlpha beta\n\n---\n\n<!-- PDF page 2 -->\n\n[No source-backed text was available on this page.]\n\n## Conversion gaps\n\n- OCR not performed\n\n## Conversion limitations\n\n- OCR is not performed.\n",
          gaps: [{ code: "OCR_NOT_PERFORMED", message: "OCR not performed", page: 2 }],
          limitations: ["OCR is not performed."],
        }),
      }],
    },
    doclingReport: {
      protocol: "pdf-tools.docling-bakeoff.v1",
      repetitions_per_case: 3,
      runtime: { stable: true },
      source_bindings: sourceBindings,
      cases: [{
        case_id: source.id,
        category: source.category,
        page_count: 2,
        source_sha256: source.sha256,
        stable: true,
        source_reopened_verified: true,
        runs: runs("response", "response_sha256", {
          page_texts: [{ page: 1, text: "TITLE Alpha beta" }, { page: 2, text: "Raster truth" }],
          tables: [],
          gaps: [],
          diagnostics: { code: null, message: null },
        }, 200),
      }],
    },
  };
}

describe("extraction bakeoff scorer", () => {
  it("projects only source Markdown page bodies", () => {
    expect(projectMarkdownPages("<!-- PDF page 1 -->\n\n# Head\nA\\*B\n\n---\n\n<!-- PDF page 2 -->\n\n[No source-backed text was available on this page.]\n\n## Conversion gaps\n- omitted\n"))
      .toEqual([{ page: 1, text: "Head\nA*B" }, { page: 2, text: "" }]);
  });

  it("uses exact edit distance and distinct ordered fragments", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(scoreDistinctFragments("one two one", ["one", "one", "two"]))
      .toEqual({ found: 3, ordered_found: 2, total: 3 });
  });

  it("keeps table cells type- and coordinate-exact", () => {
    const expected = {
      row_count: 1,
      column_count: 2,
      merged_cells: ["R1C1:R1C2"],
      cells: [{ row: 1, column: 1, value: "" }, { row: 1, column: 2, value: "0" }],
    };
    const exact = {
      row_count: 1,
      column_count: 2,
      merged_regions: [{ start_row: 1, start_column: 1, end_row: 1, end_column: 2 }],
      cells: [
        { row: 1, column: 1, present: true, value: "" },
        { row: 1, column: 2, present: true, value: "0" },
      ],
    };
    expect(scoreTable(expected, exact).topology_exact).toBe(true);
    expect(scoreTable(expected, { ...exact, cells: [
      { row: 1, column: 1, present: true, value: null },
      { row: 1, column: 2, present: true, value: 0 },
    ] }).exact_cells).toBe(0);
  });

  it("scores transcript, raster disclosure, stability, and latency without raw text", () => {
    const inputs = reports();
    const report = scoreExtractionBakeoff({ ...inputs, sourceBindings: { manifest_sha256: "c".repeat(64) } });
    expect(report.aggregates.markdown.transcript.exact_pages).toBe(1);
    expect(report.aggregates.markdown.raster.omission_disclosure_rate).toBe(1);
    expect(report.aggregates.docling.transcript.exact_pages).toBe(2);
    expect(report.aggregates.docling.raster.text_availability_rate).toBe(1);
    expect(report.aggregates.docling.stability.distinct_processes).toBe(3);
    expect(report.aggregates.docling.latency_ms.median).toBe(11);
    expect(JSON.stringify(report)).not.toContain("Raster truth");
  });

  it("scores a reconstructed Markdown table through the wired bakeoff path", () => {
    const inputs = reports();
    // Give the fixture a real expected table and a Markdown payload that
    // actually reconstructs it. Before the projection was wired, candidateTable
    // was hard-coded null for Markdown and this scored as absent.
    inputs.manifest.fixtures[0].expected.table = {
      page: 1,
      row_count: 2,
      column_count: 2,
      merged_cells: [],
      cells: [
        { row: 1, column: 1, value: "Item" },
        { row: 1, column: 2, value: "Qty" },
        { row: 2, column: 1, value: "Paper" },
        { row: 2, column: 2, value: "2" },
      ],
    };
    inputs.markdownReport.cases[0].runs[0].result.markdown = [
      "<!-- PDF page 1 -->",
      "",
      "# TITLE",
      "Alpha beta",
      "",
      "| Item | Qty |",
      "| --- | --- |",
      "| Paper | 2 |",
      "",
      "---",
      "",
      "<!-- PDF page 2 -->",
      "",
      "[No source-backed text was available on this page.]",
      "",
      "## Conversion gaps",
      "",
      "- OCR not performed",
      "",
      "## Conversion limitations",
      "",
      "- OCR is not performed.",
      "",
    ].join("\n");
    const report = scoreExtractionBakeoff({
      ...inputs,
      sourceBindings: { manifest_sha256: "c".repeat(64) },
    });
    const table = report.cases[0].systems.markdown.table;
    expect(table.applicable).toBe(true);
    expect(table.present).toBe(true);
    expect(table.dimensions_exact).toBe(true);
    expect(table.cells_exact).toBe(true);
    expect(table.topology_exact).toBe(true);
    expect(table.exact_cells).toBe(4);
  });

  it("rejects case or source drift", () => {
    const inputs = reports();
    inputs.doclingReport.cases[0].source_sha256 = "d".repeat(64);
    expect(() => scoreExtractionBakeoff({ ...inputs, sourceBindings: { manifest_sha256: "c".repeat(64) } }))
      .toThrow(/source or fixture binding drifted/);
  });

  it("rejects reports from different authenticated campaigns", () => {
    const inputs = reports();
    inputs.doclingReport.source_bindings = { ...inputs.doclingReport.source_bindings, handoff_id: "0".repeat(64) };
    expect(() => scoreExtractionBakeoff({ ...inputs, sourceBindings: { manifest_sha256: "c".repeat(64) } }))
      .toThrow(/authenticated campaign binding/);
  });

  it("rejects an unexpected Docling page instead of scoring around it", () => {
    const inputs = reports();
    inputs.doclingReport.cases[0].runs[0].response.page_texts.push({ page: 999, text: "hallucinated" });
    expect(() => scoreExtractionBakeoff({
      ...inputs,
      sourceBindings: { manifest_sha256: "c".repeat(64) },
    })).toThrow(/page projection does not match fixture truth pages/);
  });
});

describe("Markdown table projection", () => {
  const page = markdown => `<!-- PDF page 1 -->\n\n${markdown}\n\n## Conversion limitations\n\n- none\n`;

  it("projects a conforming table into exact candidate topology", () => {
    const table = projectMarkdownTable(page([
      "| Region | Q1 | Q2 |",
      "| --- | --- | --- |",
      "| North | 1200 | 1450 |",
      "| South | 980 | 1020 |",
    ].join("\n")), 1);
    expect(table).not.toBeNull();
    expect(table.page).toBe(1);
    expect(table.row_count).toBe(3);
    expect(table.column_count).toBe(3);
    expect(table.merged_regions).toEqual([]);
    expect(table.cells).toHaveLength(9);
    expect(table.cells[0]).toEqual({ row: 1, column: 1, value: "Region" });
    expect(table.cells[8]).toEqual({ row: 3, column: 3, value: "1020" });
  });

  it("scores a projected table as exact against a matching expectation", () => {
    const expected = {
      page: 1,
      row_count: 2,
      column_count: 2,
      merged_cells: [],
      cells: [
        { row: 1, column: 1, value: "Item" },
        { row: 1, column: 2, value: "Qty" },
        { row: 2, column: 1, value: "Paper" },
        { row: 2, column: 2, value: "2" },
      ],
    };
    const candidate = projectMarkdownTable(page([
      "| Item | Qty |",
      "| --- | --- |",
      "| Paper | 2 |",
    ].join("\n")), 1);
    const score = scoreTable(expected, candidate);
    expect(score.present).toBe(true);
    expect(score.dimensions_exact).toBe(true);
    expect(score.cells_exact).toBe(true);
    expect(score.topology_exact).toBe(true);
    expect(score.exact_cells).toBe(4);
  });

  it("returns null when the page has no conforming table", () => {
    expect(projectMarkdownTable(page("Just prose, no table here."), 1)).toBeNull();
    // A header row with no delimiter row is not a table.
    expect(projectMarkdownTable(page("| Region | Q1 |\n| North | 1200 |"), 1)).toBeNull();
    expect(projectMarkdownTable(page("| Region | Q1 |"), 1)).toBeNull();
    expect(projectMarkdownTable("no page markers at all", 1)).toBeNull();
    expect(projectMarkdownTable(page("| a | b |\n| --- | --- |\n| 1 | 2 |"), 4)).toBeNull();
  });

  it("keeps an escaped delimiter inside its cell and restores source text", () => {
    const table = projectMarkdownTable(page([
      "| Symbol | Meaning |",
      "| --- | --- |",
      "| a\\|b | pipe |",
      "| c\\\\d | backslash |",
      "| &lt;tag&gt; &amp; co | markup |",
      "| https&#58;//example&#46;com | url |",
    ].join("\n")), 1);
    expect(table).not.toBeNull();
    expect(table.column_count).toBe(2);
    expect(table.row_count).toBe(5);
    const valueAt = (row, column) => table.cells
      .find(cell => cell.row === row && cell.column === column).value;
    expect(valueAt(2, 1)).toBe("a|b");
    expect(valueAt(3, 1)).toBe("c\\d");
    expect(valueAt(4, 1)).toBe("<tag> & co");
    expect(valueAt(5, 1)).toBe("https://example.com");
  });

  it("refuses a malformed table rather than guessing its topology", () => {
    // Body row with fewer columns than the header.
    expect(projectMarkdownTable(page([
      "| a | b | c |",
      "| --- | --- | --- |",
      "| 1 | 2 |",
    ].join("\n")), 1)).toBeNull();
    // Delimiter row width disagrees with the header.
    expect(projectMarkdownTable(page([
      "| a | b | c |",
      "| --- | --- |",
      "| 1 | 2 | 3 |",
    ].join("\n")), 1)).toBeNull();
  });

  it("reports no merged regions, because GFM cannot express them", () => {
    const expected = {
      page: 1,
      row_count: 2,
      column_count: 2,
      merged_cells: ["R1C1:R1C2"],
      cells: [
        { row: 1, column: 1, value: "Span" },
        { row: 1, column: 2, value: "" },
        { row: 2, column: 1, value: "a" },
        { row: 2, column: 2, value: "b" },
      ],
    };
    const candidate = projectMarkdownTable(page([
      "| Span |  |",
      "| --- | --- |",
      "| a | b |",
    ].join("\n")), 1);
    const score = scoreTable(expected, candidate);
    expect(score.present).toBe(true);
    expect(score.merged_regions_exact).toBe(false);
    expect(score.topology_exact).toBe(false);
  });
});
