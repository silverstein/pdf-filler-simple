import { describe, expect, it } from "vitest";
import {
  editDistance,
  projectMarkdownPages,
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
});
