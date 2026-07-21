import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFidelityManifest } from "./fidelity-manifest.js";
import { producerCallIndex } from "./fidelity-manifest.js";
import { digestCanonical, digestCell } from "./fidelity-integrity.js";
import { scoreFidelityReport } from "./fidelity-scorer.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "fidelity", "manifest.v1.json");

function page(marker, rotation = 0, textItems = []) {
  return {
    marker,
    text: [marker, ...textItems.map(item => item.text)].join(" "),
    text_items: textItems,
    media_box: [0, 0, 612, 792],
    crop_box: [0, 0, 612, 792],
    rotation,
    user_unit: 1,
  };
}

function cleanCell(item, repetition) {
  const sources = {};
  for (const input of item.inputs) {
    const lineages = item.page_lineage.filter(lineage => lineage.source_path === input.logical_path);
    const count = Math.max(...lineages.map(lineage => lineage.source_page));
    sources[input.logical_path] = {
      sha256: null,
      metadata: Object.fromEntries(["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"].map(key => [key, key])),
      pages: Array.from({ length: count }, (_, index) => {
        const lineage = lineages.find(value => value.source_page === index + 1);
        return page(lineage?.anchor ?? `PAGE ${index + 1}`);
      }),
    };
  }
  for (const input of item.inputs) {
    sources[input.logical_path].sha256 = cleanCell.manifestDocuments.get(input.document_id);
  }
  const outputs = {};
  for (const outputPath of item.expected_outputs) {
    const lineages = item.page_lineage.filter(lineage => lineage.output_path === outputPath);
    const semantic = item.semantics.find(value => value.output_path === outputPath);
    outputs[outputPath] = {
      exists: true,
      producer_call_index: producerCallIndex(item, outputPath),
      inspection: {
        sha256: "b".repeat(64), size: 100, page_count: lineages.length,
        pages: lineages.map(lineage => {
          const textItems = item.intended_regions.filter(region => region.output_path === outputPath
            && region.page === lineage.output_page && region.target_evidence.kind === "text_run")
            .map(region => ({ text: region.target_evidence.expected_text, region: region.region }));
          return page(lineage.anchor, lineage.rotation_delta, textItems);
        }),
        renders: lineages.map((_, index) => ({ page: index + 1 })),
        fields: (semantic?.fields ?? []).map(field => ({
          name: field.name, type: field.type, flags: field.flags, value: field.value,
          widgets: field.widgets.map(widget => ({
            pages: widget.page === null ? [] : [widget.page],
            region: widget.region,
            appearance_state: widget.appearance_state,
            has_normal_appearance: widget.has_normal_appearance,
          })),
        })),
        annotations: structuredClone(semantic?.annotations ?? []),
        widget_consistency: { passed: true },
        metadata: {
          ...sources[semantic?.metadata.preserve_from]?.metadata,
          ...Object.fromEntries(Object.entries(semantic?.metadata.required_patterns ?? {}).map(([key]) => {
            const targetText = item.intended_regions.find(region => region.target_evidence.kind === "text_run")?.target_evidence.expected_text;
            return [key, key === "Keywords" ? `stamped text via pdf-toolkit; text="${targetText}"; page=2` : "match"];
          })),
        },
      },
      poppler: { opened: true, page_count: lineages.length, render_count: lineages.length },
    };
  }
  const visual = item.page_lineage.flatMap(lineage => ["pdfjs", "poppler"].map(engine => ({
    engine, output_path: lineage.output_path, output_page: lineage.output_page,
    source_path: lineage.source_path, source_page: lineage.source_page, rotation_delta: lineage.rotation_delta,
    metrics: { dimension_mismatch: false, inside_counts: { 8: item.intended_regions.some(region => region.output_path === lineage.output_path && region.page === lineage.output_page) ? 1 : 0 }, outside_counts: { 8: 0 } },
    region_metrics: item.intended_regions.map((region, regionIndex) => ({ region, regionIndex }))
      .filter(itemRegion => itemRegion.region.output_path === lineage.output_path && itemRegion.region.page === lineage.output_page)
      .map(itemRegion => ({ region_index: itemRegion.regionIndex, region: itemRegion.region.region, metrics: { inside_counts: { 8: 1 } } })),
  })));
  const created = [...item.filesystem.created, ...item.filesystem.created_directories];
  for (const pattern of item.filesystem.dynamic_created_patterns) {
    if (pattern.includes("\\.original-")) created.push(`profiles/backups/.original-${"a".repeat(64)}.v1.json`);
    else if (pattern.includes("backups")) created.push("profiles/backups/working__original.pdf");
    else created.push("output/dynamic");
  }
  const active = { active_path: item.lifecycle.active_path, last_mutation_tool: item.lifecycle.last_mutation_tool, last_mutation_at: "2026-07-21T00:00:00.000Z", backup_path: null };
  const backup = item.lifecycle.backup_policy === "immutable-original"
    ? { original_sha256: "a".repeat(64), first_path: "profiles/backups/working__original.pdf", final_path: "profiles/backups/working__original.pdf", first_sha256: "a".repeat(64), final_sha256: "a".repeat(64), created_paths: ["profiles/backups/working__original.pdf"] }
    : item.lifecycle.backup_policy === "missing-original-fail-closed"
      ? { second_call_error: true, hash_before_second: "b".repeat(64), hash_after_second: "b".repeat(64), created_paths_after_fault: [] }
      : {};
  return {
    cell_schema_version: 2,
    cell_id: `pdf-tools.fidelity.cell.${item.id.replace("pdf-tools.fidelity.case.", "")}.r${repetition}`,
    case_id: item.id,
    case_contract_sha256: digestCanonical("case", item),
    repetition,
    outcome: "completed",
    provenance: { provenance_schema_version: 1, invocation_id: `${item.id}.r${repetition}`, started_at: "2026-07-21T00:00:00.000Z", finished_at: "2026-07-21T00:00:01.000Z" },
    artifact_ids: [],
    tool_calls: item.tool_calls.map(call => ({
      name: call.name,
      arguments_sha256: digestCanonical("tool-arguments", call.arguments),
      is_error: call.expect_error === true,
    })),
    engines: { poppler: { family: "poppler", available: true } },
    sources, outputs, visual_comparisons: visual,
    filesystem: { diff: { created, modified: [...item.filesystem.modified], deleted: [...item.filesystem.deleted] }, after: [] },
    lifecycle: { active, before_expected_failure: item.lifecycle.backup_policy === "missing-original-fail-closed" ? structuredClone(active) : null }, backup,
    failure_evidence: [],
    harness_failure: null,
  };
}

async function cleanReport() {
  const manifest = await loadFidelityManifest(MANIFEST_PATH);
  cleanCell.manifestDocuments = new Map(manifest.documents.map(document => [document.id, document.sha256]));
  const cells = manifest.cases.flatMap(item => [1, 2, 3].map(repetition => cleanCell(item, repetition)));
  return { manifest, report: {
    schema_version: 2, report_schema_version: 2, benchmark_id: manifest.benchmark_id, benchmark_version: manifest.benchmark_version,
    digests: { manifest_sha256: digestCanonical("manifest", manifest) },
    cells,
    cell_bindings: cells.map(cell => ({
      cell_id: cell.cell_id, case_id: cell.case_id, case_contract_sha256: cell.case_contract_sha256,
      repetition: cell.repetition, outcome: cell.outcome, cell_sha256: digestCell(cell), artifact_ids: cell.artifact_ids,
    })),
  } };
}

describe("fidelity conjunction scorer", () => {
  it("passes a complete clean denominator without averaging", async () => {
    const { manifest, report } = await cleanReport();
    const score = scoreFidelityReport(manifest, report);
    expect(score.valid, score.validation_errors.join("\n")).toBe(true);
    expect(score.passed, JSON.stringify(score.required_failures, null, 2)).toBe(true);
    expect(score.denominator).toEqual({ planned: 24, observed: 24, unique: 24, completed: 24, harness_failures: 0 });
  });

  it("rejects missing and duplicate attempts", async () => {
    const { manifest, report } = await cleanReport();
    report.cells.pop();
    expect(scoreFidelityReport(manifest, report).valid).toBe(false);
    report.cells.push(structuredClone(report.cells[0]));
    expect(scoreFidelityReport(manifest, report).validation_errors.some(error => error.includes("duplicate"))).toBe(true);
  });

  it("retains a planned harness failure in the denominator and fails closed", async () => {
    const { manifest, report } = await cleanReport();
    const original = report.cells[0];
    report.cells[0] = {
      cell_schema_version: 2, cell_id: original.cell_id, case_id: original.case_id,
      case_contract_sha256: original.case_contract_sha256, repetition: original.repetition,
      outcome: "harness_failure", provenance: original.provenance, artifact_ids: ["artifact.harness-log"],
      harness_failure: { harness_schema_version: 1, code: "source_inspection", phase: "source_inspection", detail: "fixture could not be opened", artifact_id: "artifact.harness-log" },
    };
    report.cell_bindings[0] = {
      cell_id: report.cells[0].cell_id, case_id: report.cells[0].case_id, case_contract_sha256: report.cells[0].case_contract_sha256,
      repetition: report.cells[0].repetition, outcome: report.cells[0].outcome, cell_sha256: digestCell(report.cells[0]), artifact_ids: report.cells[0].artifact_ids,
    };
    const score = scoreFidelityReport(manifest, report);
    expect(score.valid).toBe(true);
    expect(score.denominator).toEqual({ planned: 24, observed: 24, unique: 24, completed: 23, harness_failures: 1 });
    expect(score.passed).toBe(false);
    expect(score.required_failures.some(item => item.gate === "harness")).toBe(true);
  });

  it("rejects omitted, duplicate, and unplanned visual lineage cells", async () => {
    const { manifest, report } = await cleanReport();
    const cell = report.cells.find(item => item.case_id.endsWith("page-plan-reorder-rotate"));
    cell.visual_comparisons.pop();
    let score = scoreFidelityReport(manifest, report);
    expect(score.required_failures.some(item => item.case_id === cell.case_id && item.gate === "forbidden_visual"
      && item.reasons.some(reason => reason.includes("is missing")))).toBe(true);

    Object.assign(cell, cleanCell(manifest.cases.find(item => item.id === cell.case_id), cell.repetition));
    cell.visual_comparisons.push(structuredClone(cell.visual_comparisons[0]));
    score = scoreFidelityReport(manifest, report);
    expect(score.required_failures.some(item => item.gate === "forbidden_visual"
      && item.reasons.some(reason => reason.includes("duplicates")))).toBe(true);

    cell.visual_comparisons.pop();
    cell.visual_comparisons[0].source_page = 999;
    score = scoreFidelityReport(manifest, report);
    expect(score.required_failures.some(item => item.gate === "forbidden_visual"
      && item.reasons.some(reason => reason.includes("unplanned")))).toBe(true);
  });

  it("catches orphan widgets, outside drift, engine substitution, temp files, and H1 backup recreation", async () => {
    const { manifest, report } = await cleanReport();
    report.cells[0].outputs[manifest.cases[0].expected_outputs[0]].inspection.widget_consistency.passed = false;
    report.cells[1].visual_comparisons[0].metrics.outside_counts[8] = 1;
    report.cells[2].engines.poppler.family = "pdfjs";
    report.cells[3].filesystem.after.push({ path: "output/.tmp-partial", type: "file" });
    const backupCell = report.cells.find(cell => cell.case_id.endsWith("same-path-backup"));
    backupCell.backup.final_sha256 = "b".repeat(64);
    const score = scoreFidelityReport(manifest, report);
    expect(score.passed).toBe(false);
    expect(new Set(score.required_failures.map(failure => failure.gate))).toEqual(
      expect.objectContaining(new Set(["semantics", "forbidden_visual", "poppler_engine", "filesystem", "backup"]))
    );
  });

  it("catches a no-op intended edit and field loss independently", async () => {
    const { manifest, report } = await cleanReport();
    const fill = report.cells[0];
    fill.visual_comparisons.forEach(comparison => {
      comparison.metrics.inside_counts[8] = 0;
      comparison.region_metrics.forEach(region => { region.metrics.inside_counts[8] = 0; });
    });
    fill.outputs[manifest.cases[0].expected_outputs[0]].inspection.fields = [];
    const failures = scoreFidelityReport(manifest, report).required_failures.filter(item => item.repetition === 1 && item.case_id === fill.case_id);
    expect(failures.map(item => item.gate)).toEqual(expect.arrayContaining(["intended_visual", "semantics"]));
  });

  it("rejects extra widgets and annotation behavior drift", async () => {
    const { manifest, report } = await cleanReport();
    const fill = report.cells[0];
    const inspection = fill.outputs[manifest.cases[0].expected_outputs[0]].inspection;
    inspection.fields[0].widgets.push({
      pages: [2], region: [300, 300, 100, 20], appearance_state: null, has_normal_appearance: true,
    });
    inspection.annotations.push({
      page: 2, subtype: "/Link", region: [20, 20, 100, 20], flags: 4, contents: null,
      has_appearance: false, action: "<< /S /URI /URI (https://wrong.example) >>", destination: null,
    });
    const failures = scoreFidelityReport(manifest, report).required_failures
      .filter(item => item.repetition === 1 && item.case_id === fill.case_id);
    expect(failures.some(item => item.gate === "semantics"
      && item.reasons.some(reason => reason.includes("field inventory")))).toBe(true);
    expect(failures.some(item => item.gate === "semantics"
      && item.reasons.some(reason => reason.includes("annotation inventory")))).toBe(true);
  });

  it("rejects a wrong text target even when pixels changed inside the mask", async () => {
    const { manifest, report } = await cleanReport();
    const cell = report.cells.find(item => item.case_id.endsWith("apply-text") && item.repetition === 1);
    const outputPath = manifest.cases.find(item => item.id === cell.case_id).expected_outputs[0];
    const target = cell.outputs[outputPath].inspection.pages[1].text_items[0];
    target.text = "Approved by somebody else";
    const failures = scoreFidelityReport(manifest, report).required_failures
      .filter(item => item.repetition === 1 && item.case_id === cell.case_id);
    expect(failures.some(item => item.gate === "target_evidence")).toBe(true);
    expect(failures.some(item => item.gate === "intended_visual")).toBe(false);
  });
});
