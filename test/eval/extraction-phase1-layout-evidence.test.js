import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { describe, expect, it } from "vitest";
import {
  canonicalEvidenceValueSha256,
  buildCanonicalLayoutEvidenceInput,
  classifyLayoutFactOccurrence,
  enumerateExactLayoutOccurrences,
  phase0CoordinateEquivalence,
  reconcileLayoutIrEvidence,
  scoreLayoutCanonicalEvidence,
} from "./extraction-phase1-layout-evidence.js";
import {
  generateLayoutOccurrenceOracle,
  verifyLayoutOccurrenceOracle,
} from "../../scripts/eval-generate-extraction-layout-oracle.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PHASE1_ROOT = path.join(REPO_ROOT, "test", "fixtures", "eval", "extraction", "phase1");
const EXTRACTION_ROOT = path.dirname(PHASE1_ROOT);

function rawItem(id, text, x) {
  return {
    id,
    text,
    text_kind: "non_whitespace",
    geometry_valid: true,
    bbox_status: "valid",
    bbox: { x, y: 20, width: text.length * 6, height: 10 },
    x,
    y: 20,
    width: text.length * 6,
    height: 10,
    line_height: 10,
    direction: "ltr",
  };
}

function syntheticLayout(items) {
  return {
    source: { sha256: "a".repeat(64) },
    truncation: { truncated: false },
    pages: [{
      page: 1,
      geometry: {
        item_space: { origin: "top_left", unit: "points_1_72_in_after_user_unit", reference_box: "pdfjs_display_viewport" },
        media_box: { x: 0, y: 0, width: 200, height: 100 },
        crop_box: { x: 0, y: 0, width: 200, height: 100 },
        raw_pdf_rotation: 0,
        display_rotation: 0,
        rotation_matches_raw: true,
        user_unit: 1,
        pdfjs_view: [0, 0, 200, 100],
        display_width: 200,
        display_height: 100,
        viewport_transform: [1, 0, 0, -1, 0, 100],
      },
      truncation: { truncated: false },
      errors: [],
      raw_items: items,
      lines: [{ id: "p0001-l000001", direction: "ltr", item_ids: items.map(item => item.id) }],
    }],
  };
}

describe("Phase 1 scorer-only layout occurrence oracle", () => {
  it("regenerates byte-identically with exact source, schema, package-lock, and PDF.js bindings", async () => {
    const [retainedBytes, schema] = await Promise.all([
      fs.readFile(path.join(PHASE1_ROOT, "layout-occurrence-oracle.v1.json")),
      fs.readFile(path.join(PHASE1_ROOT, "layout-occurrence-oracle.schema.json"), "utf8").then(JSON.parse),
    ]);
    const retained = JSON.parse(retainedBytes);
    const first = await generateLayoutOccurrenceOracle();
    const second = await generateLayoutOccurrenceOracle();
    expect(`${JSON.stringify(first, null, 2)}\n`).toBe(retainedBytes.toString("utf8"));
    expect(second).toEqual(first);
    expect(new AjvJsonSchemaValidator().getValidator(schema)(retained)).toMatchObject({ valid: true });
    expect(retained.pdfjs_version).toBe("5.4.624");
    expect(retained.validator_sources.map(item => item.role)).toEqual([
      "accessibility_inspection_module", "generator_script", "layout_evidence_module", "layout_extraction_module", "type3_cm_reference_module", "type3_cm_pk_reference_module",
      "layout_oracle_schema",
      "markdown_conversion_module", "output_schemas_module", "package_json", "package_lock",
      "pdf_comparison_module", "pdf_observations_module", "pdfjs_package", "scoring_oracle_schema",
      "table_proposal_verification_module",
    ]);
    await expect(verifyLayoutOccurrenceOracle(retained)).resolves.toBe(true);
    const hostile = structuredClone(retained);
    hostile.cases[0].facts[0].approved_occurrence.source_spans[0].start_code_point += 1;
    await expect(verifyLayoutOccurrenceOracle(hostile)).rejects.toThrow(/independent regeneration/);
  }, 10_000);

  it("enumerates repeated Unicode code-point occurrences and refuses an indistinguishable same-item first match", () => {
    const item = rawItem("p0001-i000001", "DUP 😀 DUP 😀", 10);
    const layout = syntheticLayout([item]);
    const occurrences = enumerateExactLayoutOccurrences(layout, { page: 1, quote: "DUP 😀" });
    expect(occurrences).toHaveLength(2);
    expect(occurrences.map(item_ => item_.source_spans[0])).toEqual([
      { source_item_id: item.id, start_code_point: 0, end_code_point: 5 },
      { source_item_id: item.id, start_code_point: 6, end_code_point: 11 },
    ]);
    expect(new Set(occurrences.map(item_ => JSON.stringify(item_.bbox))).size).toBe(1);
    const classified = classifyLayoutFactOccurrence(layout, {
      page: 1,
      anchor_text: "DUP 😀",
      bbox: { x: 10, y: 20, width: item.width, height: 10 },
    });
    expect(classified).toMatchObject({ status: "ambiguous", approved: null });
  });

  it("retains exhaustive different-item repeats while approving only a uniquely reviewed occurrence", () => {
    const left = rawItem("p0001-i000001", "DUP", 10);
    const right = rawItem("p0001-i000002", "DUP", 80);
    const layout = syntheticLayout([left, right]);
    const classified = classifyLayoutFactOccurrence(layout, {
      page: 1,
      anchor_text: "DUP",
      bbox: { x: 75, y: 15, width: 30, height: 20 },
    });
    expect(classified.occurrences).toHaveLength(2);
    expect(classified.status).toBe("approved_unique");
    expect(classified.approved.source_item_ids).toEqual([right.id]);
  });

  it("domain-binds exact flattened field paths and canonical typed values", () => {
    expect(canonicalEvidenceValueSha256("/a", 1)).not.toBe(canonicalEvidenceValueSha256("/b", 1));
    expect(canonicalEvidenceValueSha256("/a", 1)).not.toBe(canonicalEvidenceValueSha256("/a", "1"));
  });

  it("fails the coordinate gate independently for crop, origin, rotation, UserUnit, view, display, viewport, truncation, and geometry drift", () => {
    const base = syntheticLayout([rawItem("p0001-i000001", "anchor", 10)]).pages[0];
    expect(phase0CoordinateEquivalence(base)).toEqual({ eligible: true, reason: null });
    const mutants = [
      [page => { page.geometry.crop_box.width -= 1; }, "media_crop_box_mismatch"],
      [page => { page.geometry.media_box.x = 1; page.geometry.crop_box.x = 1; }, "nonzero_page_origin"],
      [page => { page.geometry.raw_pdf_rotation = 90; }, "nonzero_or_unverified_rotation"],
      [page => { page.geometry.user_unit = 2; }, "unsupported_user_unit"],
      [page => { page.geometry.pdfjs_view[2] -= 1; }, "unsupported_pdfjs_view"],
      [page => { page.geometry.display_width -= 1; }, "display_dimensions_mismatch"],
      [page => { page.geometry.viewport_transform[0] = 0.999; }, "unsupported_viewport_transform"],
      [page => { page.truncation.truncated = true; }, "partial_truncated_or_invalid_page_geometry"],
      [page => { page.raw_items[0].bbox.width = 0; }, "partial_truncated_or_invalid_page_geometry"],
    ];
    for (const [mutate, reason] of mutants) {
      const page = structuredClone(base);
      mutate(page);
      expect(phase0CoordinateEquivalence(page), reason).toEqual({ eligible: false, reason });
    }
  });

  it("keeps occurrence matching linear, bounded, line-local, page-local, and Unicode-code-point exact", () => {
    const repeated = rawItem("p0001-i000001", `${"a".repeat(100_000)}😀tail`, 10);
    const layout = syntheticLayout([repeated]);
    const started = performance.now();
    const occurrences = enumerateExactLayoutOccurrences(layout, { page: 1, quote: `${"a".repeat(9_999)}b` });
    expect(occurrences).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(() => enumerateExactLayoutOccurrences(layout, { page: 1, quote: "a".repeat(10_001) })).toThrow(/bounded Unicode/);
    expect(enumerateExactLayoutOccurrences(layout, { page: 2, quote: "tail" })).toEqual([]);
    const split = syntheticLayout([rawItem("p0001-i000001", "left", 10), rawItem("p0001-i000002", "right", 80)]);
    split.pages[0].lines = [
      { id: "p0001-l000001", direction: "ltr", item_ids: ["p0001-i000001"] },
      { id: "p0001-l000002", direction: "ltr", item_ids: ["p0001-i000002"] },
    ];
    expect(enumerateExactLayoutOccurrences(split, { page: 1, quote: "leftright" })).toEqual([]);

    const manyItems = Array.from({ length: 5_000 }, (_, index) => rawItem(`p0001-i${String(index + 1).padStart(6, "0")}`, "match", 10));
    const manyLines = syntheticLayout(manyItems);
    manyLines.pages[0].lines = manyItems.map((item, index) => ({
      id: `p0001-l${String(index + 1).padStart(6, "0")}`,
      direction: "ltr",
      item_ids: [item.id],
    }));
    const manyStarted = performance.now();
    expect(() => enumerateExactLayoutOccurrences(manyLines, { page: 1, quote: "match" })).toThrow(/too many exact occurrences/);
    expect(performance.now() - manyStarted).toBeLessThan(1_000);
  });

  it("projects valid layout-oracle subsets in requested plan order", async () => {
    const retained = await fs.readFile(path.join(PHASE1_ROOT, "layout-occurrence-oracle.v1.json"), "utf8").then(JSON.parse);
    const caseIds = retained.cases.slice(0, 2).map(item => item.case_id).reverse();
    await expect(verifyLayoutOccurrenceOracle(retained, { caseIds })).resolves.toBe(true);
  });

  it("reconciles exact source evidence and scores page, bbox, fact, and answer independently", async () => {
    const [manifest, scoringOracle, layoutOracle] = await Promise.all([
      fs.readFile(path.join(EXTRACTION_ROOT, "manifest.v1.json"), "utf8").then(JSON.parse),
      fs.readFile(path.join(PHASE1_ROOT, "scoring-oracle.v1.json"), "utf8").then(JSON.parse),
      fs.readFile(path.join(PHASE1_ROOT, "layout-occurrence-oracle.v1.json"), "utf8").then(JSON.parse),
    ]);
    const fixture = manifest.fixtures[0];
    const oracleCase = scoringOracle.cases.find(item => item.case_id === fixture.id);
    const layoutOracleCase = layoutOracle.cases.find(item => item.case_id === fixture.id);
    const sourceBytes = await fs.readFile(path.join(EXTRACTION_ROOT, fixture.path));
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const layout = await buildCanonicalLayoutEvidenceInput({ sourceBytes, sourceSha256: fixture.sha256, pageCount: 1, pdfjsLib });
    const valueAt = pointer => pointer.slice(1).split("/").reduce((value, key) => value[key.replace(/~1/g, "/").replace(/~0/g, "~")], fixture.ground_truth);
    const approvedFacts = layoutOracleCase.facts.filter(item => item.status === "approved_unique");
    const evidence = approvedFacts.map((fact, index) => ({
      id: `evidence-${index + 1}`,
      page: fact.approved_occurrence.page,
      source_spans: fact.approved_occurrence.source_spans,
      quote: fact.approved_occurrence.quote,
      bbox: fact.approved_occurrence.bbox,
      coordinate_space: "pdf-tools.display-top-left-points.v1",
    }));
    const response = {
      structured_candidate: structuredClone(fixture.ground_truth),
      gaps: [],
      evidence,
      field_evidence: oracleCase.truth_leaves.filter(leaf => leaf.disposition === "answer" && leaf.fact_support.mode !== "none").map(leaf => ({
        field_path: leaf.field_path,
        disposition: "answer",
        value_sha256: canonicalEvidenceValueSha256(leaf.field_path, valueAt(leaf.field_path)),
        evidence_ids: leaf.fact_support.fact_ids.map(factId => evidence[approvedFacts.findIndex(fact => fact.fact_id === factId)].id),
      })),
    };
    const request = {
      input_mode: "layout_ir",
      source: { sha256: fixture.sha256, size_bytes: sourceBytes.length, page_count: 1 },
      inputs: { layout_ir: layout },
    };
    const reconciliation = await reconcileLayoutIrEvidence({ request, response, sourceBytes, pdfjsLib, validatorSourceSetSha256: "f".repeat(64) });
    const score = scoreLayoutCanonicalEvidence({ fixture, oracleCase, layoutOracleCase, response, reconciliation, layout });
    expect(score.page).toMatchObject({ matched: 2, missing: 0, score: 1 });
    expect(score.bbox).toMatchObject({ matched: 2, missing: 0, score: 1 });
    expect(score.fact).toMatchObject({ matched: 2, missing: 0, score: 1 });
    expect(score.answer).toMatchObject({ matched: 3, missing: 0, score: 1 });

    const wrong = structuredClone(response);
    wrong.structured_candidate.total.amount = 0;
    wrong.field_evidence.find(item => item.field_path === "/total/amount").value_sha256 = canonicalEvidenceValueSha256("/total/amount", 0);
    const wrongReconciliation = await reconcileLayoutIrEvidence({ request, response: wrong, sourceBytes, pdfjsLib, validatorSourceSetSha256: "f".repeat(64) });
    const wrongScore = scoreLayoutCanonicalEvidence({ fixture, oracleCase, layoutOracleCase, response: wrong, reconciliation: wrongReconciliation, layout });
    expect(wrongScore.page.matched).toBe(2);
    expect(wrongScore.bbox.matched).toBe(2);
    expect(wrongScore.fact.matched).toBe(2);
    expect(wrongScore.answer).toMatchObject({ matched: 2, missing: 1 });

    const shifted = structuredClone(response);
    shifted.evidence[0].bbox.x += 0.001;
    await expect(reconcileLayoutIrEvidence({ request, response: shifted, sourceBytes, pdfjsLib, validatorSourceSetSha256: "f".repeat(64) })).rejects.toThrow(/exact source-item union/);
  });

  it("does not let one broad evidence record credit noncontiguous fact assignments", () => {
    const left = rawItem("p0001-i000001", "LEFT", 10);
    const middle = rawItem("p0001-i000002", "gap", 45);
    const right = rawItem("p0001-i000003", "RIGHT", 80);
    const layout = syntheticLayout([left, middle, right]);
    const facts = [
      { id: "fact.left", field_path: "/left", page: 1, anchor_text: "LEFT", bbox: left.bbox },
      { id: "fact.right", field_path: "/right", page: 1, anchor_text: "RIGHT", bbox: right.bbox },
    ];
    const classified = facts.map(fact => classifyLayoutFactOccurrence(layout, fact));
    const layoutOracleCase = {
      case_id: "case.noncontiguous",
      source_sha256: layout.source.sha256,
      layout_ir_sha256: classified[0].approved.layout_ir_sha256,
      facts: facts.map((fact, index) => ({
        fact_id: fact.id,
        field_path: fact.field_path,
        anchor_text: fact.anchor_text,
        page: fact.page,
        status: classified[index].status,
        status_reason: classified[index].statusReason,
        geometry_status: "eligible",
        geometry_reason: null,
        observed_occurrence_sha256: classified[index].occurrences.map(item => item.occurrence_sha256),
        approved_occurrence: classified[index].approved,
      })),
    };
    const fixture = {
      id: "case.noncontiguous",
      sha256: layout.source.sha256,
      ground_truth: { left: "LEFT", right: "RIGHT" },
      expected: { facts },
    };
    const oracleCase = {
      truth_leaves: facts.map(fact => ({
        field_path: fact.field_path,
        value: fixture.ground_truth[fact.field_path.slice(1)],
        disposition: "answer",
        fact_support: { mode: "all", fact_ids: [fact.id] },
      })),
    };
    const broadRecord = {
      evidence_id: "broad",
      source_sha256: layout.source.sha256,
      layout_ir_sha256: layoutOracleCase.layout_ir_sha256,
      page: 1,
      line_id: "p0001-l000001",
      line_start_code_point: 0,
      line_end_code_point: 14,
      occurrence_sha256: "c".repeat(64),
      phase0_coordinate_equivalent: true,
      bbox: { x: 10, y: 20, width: 100, height: 10 },
    };
    const response = { structured_candidate: structuredClone(fixture.ground_truth) };
    const reconciliation = {
      mode: "layout_ir",
      availability: "measured",
      layout_ir_sha256: layoutOracleCase.layout_ir_sha256,
      records: [broadRecord],
      field_bindings: facts.map(fact => ({
        field_path: fact.field_path,
        disposition: "answer",
        value_sha256: canonicalEvidenceValueSha256(fact.field_path, fixture.ground_truth[fact.field_path.slice(1)]),
        evidence_ids: ["broad"],
      })),
    };
    const score = scoreLayoutCanonicalEvidence({ fixture, oracleCase, layoutOracleCase, response, reconciliation, layout });
    expect(score.page.matched).toBe(1);
    expect(score.fact.matched).toBe(1);
    expect(score.answer.matched).toBe(1);
  });
});
