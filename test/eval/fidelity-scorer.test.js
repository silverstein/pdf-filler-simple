import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFidelityManifest } from "./fidelity-manifest.js";
import { scoreFidelityReport } from "./fidelity-scorer.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "fidelity", "manifest.v1.json");

function page(marker, rotation = 0) {
  return { marker, text: marker, media_box: [0, 0, 612, 792], crop_box: [0, 0, 612, 792], rotation };
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
      inspection: {
        sha256: "b".repeat(64), size: 100, page_count: lineages.length,
        pages: lineages.map(lineage => page(lineage.anchor, lineage.rotation_delta)),
        renders: lineages.map((_, index) => ({ page: index + 1 })),
        fields: (semantic?.fields ?? []).map(field => ({
          name: field.name, type: field.type, flags: field.flags, value: field.value,
          widgets: [{ pages: field.page === null ? [] : [field.page], region: field.region }],
        })),
        annotations: semantic?.annotations ?? [],
        widget_consistency: { passed: true },
        metadata: {
          ...sources[semantic?.metadata.preserve_from]?.metadata,
          ...Object.fromEntries(Object.entries(semantic?.metadata.required_patterns ?? {}).map(([key]) => [key, key === "Keywords" ? "stamped text via pdf-toolkit; text=\"Reviewed 2026-07-21\"; page=2" : "match"])),
        },
      },
      poppler: { opened: true, page_count: lineages.length, render_count: lineages.length },
    };
  }
  const visual = item.page_lineage.flatMap(lineage => ["pdfjs", "poppler"].map(engine => ({
    engine, output_path: lineage.output_path, output_page: lineage.output_page,
    source_path: lineage.source_path, source_page: lineage.source_page, rotation_delta: lineage.rotation_delta,
    metrics: { dimension_mismatch: false, inside_counts: { 8: item.intended_regions.some(region => region.output_path === lineage.output_path && region.page === lineage.output_page) ? 1 : 0 }, outside_counts: { 8: 0 } },
  })));
  const created = [...item.filesystem.created, ...item.filesystem.created_directories];
  for (const pattern of item.filesystem.dynamic_created_patterns) created.push(pattern.includes("backups") ? "profiles/backups/working__original.pdf" : "output/dynamic");
  const active = { active_path: item.lifecycle.active_path, last_mutation_tool: item.lifecycle.last_mutation_tool, backup_path: null };
  const backup = item.lifecycle.backup_policy === "immutable-original"
    ? { original_sha256: "a".repeat(64), first_path: "profiles/backups/working__original.pdf", final_path: "profiles/backups/working__original.pdf", first_sha256: "a".repeat(64), final_sha256: "a".repeat(64), created_paths: ["profiles/backups/working__original.pdf"] }
    : item.lifecycle.backup_policy === "missing-original-fail-closed"
      ? { second_call_error: true, hash_before_second: "b".repeat(64), hash_after_second: "b".repeat(64), created_paths_after_fault: [] }
      : {};
  return {
    case_id: item.id, repetition,
    tool_calls: item.tool_calls.map(call => ({
      name: call.name,
      arguments_sha256: createHash("sha256").update(JSON.stringify(call.arguments)).digest("hex"),
      is_error: call.expect_error === true,
    })),
    engines: { poppler: { family: "poppler", available: true } },
    sources, outputs, visual_comparisons: visual,
    filesystem: { diff: { created, modified: [...item.filesystem.modified], deleted: [...item.filesystem.deleted] }, after: [] },
    lifecycle: { active }, backup,
  };
}

async function cleanReport() {
  const manifest = await loadFidelityManifest(MANIFEST_PATH);
  cleanCell.manifestDocuments = new Map(manifest.documents.map(document => [document.id, document.sha256]));
  return {
    manifest,
    report: {
      schema_version: 1, benchmark_id: manifest.benchmark_id, benchmark_version: manifest.benchmark_version,
      failure_evidence_integrity: true,
      cells: manifest.cases.flatMap(item => [1, 2, 3].map(repetition => cleanCell(item, repetition))),
    },
  };
}

describe("fidelity conjunction scorer", () => {
  it("passes a complete clean denominator without averaging", async () => {
    const { manifest, report } = await cleanReport();
    const score = scoreFidelityReport(manifest, report);
    expect(score.valid, score.validation_errors.join("\n")).toBe(true);
    expect(score.passed, JSON.stringify(score.required_failures, null, 2)).toBe(true);
    expect(score.denominator).toEqual({ planned: 21, observed: 21, unique: 21 });
  });

  it("rejects missing and duplicate attempts", async () => {
    const { manifest, report } = await cleanReport();
    report.cells.pop();
    expect(scoreFidelityReport(manifest, report).valid).toBe(false);
    report.cells.push(structuredClone(report.cells[0]));
    expect(scoreFidelityReport(manifest, report).validation_errors.some(error => error.includes("duplicate"))).toBe(true);
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
    fill.visual_comparisons.forEach(comparison => { comparison.metrics.inside_counts[8] = 0; });
    fill.outputs[manifest.cases[0].expected_outputs[0]].inspection.fields = [];
    const failures = scoreFidelityReport(manifest, report).required_failures.filter(item => item.repetition === 1 && item.case_id === fill.case_id);
    expect(failures.map(item => item.gate)).toEqual(expect.arrayContaining(["intended_visual", "semantics"]));
  });
});
