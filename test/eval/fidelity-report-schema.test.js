import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createComparisonAjv } from "./comparison-schema-ajv.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPORT_SCHEMA_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "fidelity", "report.schema.json");
const RUN_INDEX_SCHEMA_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "fidelity", "run-index.schema.json");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const REVISION = "d".repeat(40);
const STARTED_AT = "2026-07-21T01:02:03.000Z";
const FINISHED_AT = "2026-07-21T01:03:04.000Z";
const CASE_ID = "pdf-tools.fidelity.case.fill-new-output";
const COMPLETED_CELL_ID = "pdf-tools.fidelity.cell.fill-new-output.r1";
const HARNESS_CELL_ID = "pdf-tools.fidelity.cell.fill-new-output.r2";

let reportSchema;
let runIndexSchema;
let validateReport;
let validateRunIndex;

function clone(value) {
  return structuredClone(value);
}

function provenance() {
  return {
    provenance_schema_version: 1,
    producer: "scripts/eval-run-fidelity-campaign.mjs",
    capture_mode: "source_server",
    started_at: STARTED_AT,
    finished_at: FINISHED_AT,
    host: {
      platform: "linux",
      arch: "x64",
      node_version: "v24.4.1",
      hostname_sha256: SHA_A,
    },
  };
}

function cellProvenance(repetition) {
  return {
    provenance_schema_version: 1,
    invocation_id: `fidelity-fill-r${repetition}`,
    started_at: STARTED_AT,
    finished_at: FINISHED_AT,
  };
}

function popplerFingerprint() {
  return {
    family: "poppler",
    available: true,
    version: "pdftoppm version 26.07.0",
    binary_sha256: SHA_B,
  };
}

function inspection() {
  return {
    path: null,
    sha256: SHA_A,
    size: 1024,
    page_count: 1,
    pages: [{
      page: 1,
      media_box: [0, 0, 612, 792],
      crop_box: [0, 0, 612, 792],
      rotation: 0,
      marker: "PAGE-ID: SERVICE",
      text: "PAGE-ID: SERVICE",
      text_sha256: SHA_B,
    }],
    fields: [{
      name: "ReviewStatus",
      type: "PDFTextField",
      value: "Approved",
      flags: 0,
      widgets: [{
        ref: "12 0 R",
        pages: [1],
        region: [71.5, 331.5, 221, 31],
        appearance_state: "/Off",
        has_normal_appearance: true,
      }],
    }],
    annotations: [],
    raw_annotations: [{
      ref: "12 0 R",
      page: 1,
      subtype: "/Widget",
      region: [71.5, 331.5, 221, 31],
      flags: 0,
      contents: null,
      has_appearance: true,
      action: null,
      destination: null,
    }],
    widget_consistency: {
      passed: true,
      orphan_raw_widget_refs: [],
      missing_field_widget_refs: [],
      multiply_placed_field_widget_refs: [],
      duplicate_page_widget_refs: [],
    },
    metadata: {
      Title: "Synthetic fidelity fixture",
      Author: "Open Document Alliance",
      Subject: null,
      Keywords: null,
      Creator: "fixture generator",
      Producer: "pdf-lib",
      CreationDate: null,
      ModDate: null,
    },
    catalog: {
      AcroForm: true,
      Metadata: false,
      Names: false,
      Outlines: false,
      StructTreeRoot: false,
      MarkInfo: false,
      PageLabels: false,
      ViewerPreferences: false,
      OpenAction: false,
    },
    renders: [{ page: 1, width: 1224, height: 1584, scale: 2, rgba_sha256: SHA_C }],
  };
}

function completedCell() {
  return {
    cell_schema_version: 2,
    cell_id: COMPLETED_CELL_ID,
    case_id: CASE_ID,
    repetition: 1,
    outcome: "completed",
    provenance: cellProvenance(1),
    artifact_ids: ["artifact.completed-diagnostic"],
    tool_calls: [{
      name: "fill_pdf",
      arguments_sha256: SHA_A,
      is_error: false,
      error_text: null,
    }],
    engines: { poppler: popplerFingerprint() },
    sources: { "input/source.pdf": inspection() },
    outputs: {
      "output/filled.pdf": {
        exists: true,
        inspection: { ...inspection(), sha256: SHA_B },
        poppler: { opened: true, page_count: 1, render_count: 1 },
      },
    },
    visual_comparisons: [{
      engine: "pdfjs",
      output_path: "output/filled.pdf",
      output_page: 1,
      source_path: "input/source.pdf",
      source_page: 1,
      rotation_delta: 0,
      metrics: {
        dimension_mismatch: false,
        thresholds: [0, 2, 8],
        raw_counts: { 0: 100, 2: 40, 8: 10 },
        inside_counts: { 0: 100, 2: 40, 8: 10 },
        outside_counts: { 0: 0, 2: 0, 8: 0 },
        intended_pixels: 1000,
        total_pixels: 1938816,
      },
    }],
    filesystem: {
      before: [{ path: "input/source.pdf", type: "file", mode: 420, size: 1024, sha256: SHA_A }],
      after: [
        { path: "input/source.pdf", type: "file", mode: 420, size: 1024, sha256: SHA_A },
        { path: "output/filled.pdf", type: "file", mode: 420, size: 2048, sha256: SHA_B },
      ],
      diff: { created: ["output/filled.pdf"], modified: [], deleted: [] },
    },
    lifecycle: {
      active: {
        active_path: "output/filled.pdf",
        backup_path: null,
        last_mutation_tool: "fill_pdf",
      },
    },
    backup: {
      original_sha256: null,
      first_path: null,
      first_sha256: null,
      final_path: null,
      final_sha256: null,
      created_paths: [],
      second_call_error: null,
      hash_before_second: null,
      hash_after_second: null,
      created_paths_after_fault: [],
    },
    failure_evidence: [],
    harness_failure: null,
  };
}

function harnessFailureCell() {
  return {
    cell_schema_version: 2,
    cell_id: HARNESS_CELL_ID,
    case_id: CASE_ID,
    repetition: 2,
    outcome: "harness_failure",
    provenance: cellProvenance(2),
    artifact_ids: ["artifact.harness-log"],
    harness_failure: {
      harness_schema_version: 1,
      code: "server_launch_timeout",
      phase: "host_session",
      detail: "The MCP server did not initialize before the bounded timeout.",
      artifact_id: "artifact.harness-log",
    },
  };
}

function artifact(artifactId, role, artifactPath, cellId) {
  return {
    artifact_id: artifactId,
    role,
    path: artifactPath,
    media_type: role === "harness_log" ? "text/plain" : "application/json",
    sha256: SHA_C,
    byte_length: 123,
    cell_id: cellId,
  };
}

function binding(cell, digest) {
  return {
    cell_id: cell.cell_id,
    case_id: cell.case_id,
    repetition: cell.repetition,
    outcome: cell.outcome,
    cell_sha256: digest,
    artifact_ids: [...cell.artifact_ids],
  };
}

function validReport() {
  const completed = completedCell();
  const harness = harnessFailureCell();
  return {
    schema_version: 2,
    report_schema_version: 2,
    benchmark_id: "pdf-tools.mutation-fidelity.v1",
    benchmark_version: 1,
    claim_boundary: "Synthetic schema fixture only; no product claim.",
    generated_at: FINISHED_AT,
    digests: {
      manifest_sha256: SHA_A,
      runner_sha256: SHA_B,
      source_revision: REVISION,
      source_tree_sha256: SHA_C,
    },
    provenance: provenance(),
    fixture_bindings: [{
      id: "pdf-tools.fidelity.document.comparison-base",
      path: "../comparison/synthetic/comparison-base.pdf",
      expected_sha256: SHA_A,
      observed_sha256: SHA_A,
      passed: true,
    }],
    engine_fingerprints: {
      pdfjs_canvas_runtime_sha256: SHA_A,
      poppler: popplerFingerprint(),
    },
    failure_evidence_integrity: true,
    artifacts: [
      artifact("artifact.completed-diagnostic", "other", "runs/fill/r1/diagnostic.json", COMPLETED_CELL_ID),
      artifact("artifact.harness-log", "harness_log", "runs/fill/r2/harness.log", HARNESS_CELL_ID),
    ],
    cell_bindings: [binding(completed, SHA_A), binding(harness, SHA_B)],
    cells: [completed, harness],
  };
}

function validRunIndex() {
  const report = validReport();
  return {
    schema_version: 2,
    run_index_schema_version: 2,
    benchmark_id: "pdf-tools.mutation-fidelity.v1",
    benchmark_version: 1,
    generated_at: FINISHED_AT,
    benchmark_claim_ready: false,
    claim_boundary: report.claim_boundary,
    digests: {
      manifest_sha256: SHA_A,
      runner_sha256: SHA_B,
      source_revision: REVISION,
      report_sha256: SHA_C,
      score_sha256: SHA_A,
      cell_set_sha256: SHA_B,
    },
    provenance: provenance(),
    denominator: { planned: 21, observed: 2, unique: 2, completed: 1, harness_failures: 1 },
    result: { valid: false, passed: false, product_failures: 0, harness_failures: 1 },
    artifacts: [
      artifact("artifact.report", "report", "fidelity-report.v2.json", null),
      artifact("artifact.score", "score", "fidelity-score.v2.json", null),
      ...report.artifacts,
    ],
    cell_bindings: report.cell_bindings,
    run_sha256: SHA_C,
  };
}

beforeAll(async () => {
  [reportSchema, runIndexSchema] = await Promise.all(
    [REPORT_SCHEMA_PATH, RUN_INDEX_SCHEMA_PATH].map(async file => JSON.parse(await fs.readFile(file, "utf8"))),
  );
  validateReport = createComparisonAjv().compile(reportSchema);
  validateRunIndex = createComparisonAjv().compile(runIndexSchema);
});

describe("fidelity report and run-index v2 schemas", () => {
  it("compile in strict mode and accept completed plus harness-failure evidence", () => {
    const report = validReport();
    const runIndex = validRunIndex();
    expect(validateReport(report), JSON.stringify(validateReport.errors, null, 2)).toBe(true);
    expect(validateRunIndex(runIndex), JSON.stringify(validateRunIndex.errors, null, 2)).toBe(true);
  });

  it("rejects v1 headers and unrecognized fields at every tested boundary", () => {
    const v1 = validReport();
    v1.schema_version = 1;
    expect(validateReport(v1)).toBe(false);

    const topLevelExtra = validReport();
    topLevelExtra.legacy_manifest_sha256 = SHA_A;
    expect(validateReport(topLevelExtra)).toBe(false);

    const nestedExtra = validReport();
    nestedExtra.provenance.host.kernel = "unbound";
    expect(validateReport(nestedExtra)).toBe(false);

    const observationExtra = validReport();
    observationExtra.cells[0].outputs["output/filled.pdf"].inspection.pages[0].untrusted = true;
    expect(validateReport(observationExtra)).toBe(false);

    const indexExtra = validRunIndex();
    indexExtra.denominator.averaged = true;
    expect(validateRunIndex(indexExtra)).toBe(false);
  });

  it("keeps completed and harness-failure cells mutually exclusive", () => {
    const relabeledCompleted = validReport();
    relabeledCompleted.cells[0].outcome = "harness_failure";
    expect(validateReport(relabeledCompleted)).toBe(false);

    const forgedCompleted = validReport();
    forgedCompleted.cells[0].harness_failure = clone(forgedCompleted.cells[1].harness_failure);
    expect(validateReport(forgedCompleted)).toBe(false);

    const harnessWithProductPayload = validReport();
    harnessWithProductPayload.cells[1].tool_calls = [];
    expect(validateReport(harnessWithProductPayload)).toBe(false);

    const unboundHarnessFailure = validReport();
    delete unboundHarnessFailure.cells[1].harness_failure.artifact_id;
    expect(validateReport(unboundHarnessFailure)).toBe(false);

    const missingRequiredEngine = validReport();
    missingRequiredEngine.cells[0].engines.poppler = {
      family: "poppler",
      available: false,
      error: "pdftoppm was not found",
    };
    expect(validateReport(missingRequiredEngine)).toBe(false);
  });

  it("rejects malformed digests, revisions, artifact paths, and bindings", () => {
    const badDigest = validReport();
    badDigest.digests.runner_sha256 = "not-a-digest";
    expect(validateReport(badDigest)).toBe(false);

    const badRevision = validRunIndex();
    badRevision.digests.source_revision = SHA_A;
    expect(validateRunIndex(badRevision)).toBe(false);

    const absoluteArtifact = validReport();
    absoluteArtifact.artifacts[0].path = "/tmp/private.json";
    expect(validateReport(absoluteArtifact)).toBe(false);

    const escapedArtifact = validRunIndex();
    escapedArtifact.artifacts[0].path = "runs/../../private.json";
    expect(validateRunIndex(escapedArtifact)).toBe(false);

    const badBinding = validRunIndex();
    badBinding.cell_bindings[0].cell_sha256 = "a".repeat(63);
    expect(validateRunIndex(badBinding)).toBe(false);
  });

  it("requires independently bound report and score artifacts in the run index", () => {
    const missingScore = validRunIndex();
    missingScore.artifacts = missingScore.artifacts.filter(item => item.role !== "score");
    expect(validateRunIndex(missingScore)).toBe(false);

    const missingReport = validRunIndex();
    missingReport.artifacts = missingReport.artifacts.filter(item => item.role !== "report");
    expect(validateRunIndex(missingReport)).toBe(false);

    const missingCellBindings = validReport();
    delete missingCellBindings.cell_bindings;
    expect(validateReport(missingCellBindings)).toBe(false);

    const downgradedIndex = validRunIndex();
    downgradedIndex.run_index_schema_version = 1;
    expect(validateRunIndex(downgradedIndex)).toBe(false);
  });
});
