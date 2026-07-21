import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { loadComparisonManifest } from "./comparison-manifest.js";
import {
  buildOracleCalibrationReport,
  scoreComparisonReport,
  validateComparisonReport,
} from "./comparison-scorer.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "comparison", "manifest.v1.json");
const REPORT_SCHEMA_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "comparison", "report.schema.json");

function mutate(report, callback) {
  const copy = structuredClone(report);
  callback(copy);
  return copy;
}

function reportPair(report, role) {
  return report.pairs.find(pair => pair.pair_id.endsWith(role.replaceAll("_", "-")));
}

describe("comparison scorer calibration", () => {
  it("accepts the explicitly non-evidentiary oracle calibration and scores every facet", async () => {
    const manifest = await loadComparisonManifest(MANIFEST_PATH);
    const report = buildOracleCalibrationReport(manifest);
    const schema = JSON.parse(await fs.readFile(REPORT_SCHEMA_PATH, "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    const validateSchema = ajv.compile(schema);
    expect(validateSchema(report), JSON.stringify(validateSchema.errors)).toBe(true);
    expect(validateComparisonReport(manifest, report)).toEqual([]);
    const scored = scoreComparisonReport(manifest, report);
    expect(scored.valid).toBe(true);
    expect(scored.passed).toBe(true);
    expect(scored.benchmark_claim_ready).toBe(false);
    expect(scored.aggregate.event_metrics).toMatchObject({ tp: 9, fp: 0, fn: 0, precision: 1, recall: 1, f1: 1 });
    expect(scored.aggregate.evidence_metrics).toMatchObject({
      expected_anchors: 27,
      matched_anchors: 27,
      completeness: 1,
      two_sided_citation_rate: 1,
      unsupported_candidate_facets: 0,
      unsupported_evidence_references: 0,
      orphan_observations: 0,
    });
    for (const channel of Object.values(scored.aggregate.channel_metrics)) {
      if (channel.tp + channel.fn > 0) expect(channel.recall).toBe(1);
    }
  });

  it("keeps undefined metric denominators null instead of inventing perfect scores", async () => {
    const manifest = await loadComparisonManifest(MANIFEST_PATH);
    const scored = scoreComparisonReport(manifest, buildOracleCalibrationReport(manifest));
    const identical = scored.pairs.find(pair => pair.role === "identical");
    expect(identical.event_metrics).toMatchObject({ tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null });
    expect(identical.material_event_recall).toBeNull();
  });
});

describe("comparison scorer hostile reports", () => {
  it("rejects answer-key event IDs and observations not bound to exact inputs", async () => {
    const manifest = await loadComparisonManifest(MANIFEST_PATH);
    const base = buildOracleCalibrationReport(manifest);
    const truthId = mutate(base, report => {
      reportPair(report, "material_text").detected_events[0].id = "truth.monthly-fee";
      reportPair(report, "material_text").presentation_decisions[0].event_id = "truth.monthly-fee";
    });
    expect(validateComparisonReport(manifest, truthId).some(error => error.includes("truth event ID"))).toBe(true);

    const wrongSource = mutate(base, report => {
      reportPair(report, "material_text").observations[0].document_sha256 = "0".repeat(64);
    });
    expect(validateComparisonReport(manifest, wrongSource).some(error => error.includes("exact pair inputs"))).toBe(true);
  });

  it("scores a partial multi-facet event as both an event miss and a semantic facet false negative", async () => {
    const manifest = await loadComparisonManifest(MANIFEST_PATH);
    const report = mutate(buildOracleCalibrationReport(manifest), copy => {
      const target = reportPair(copy, "material_text");
      target.detected_events[0].facets = target.detected_events[0].facets
        .filter(facet => facet.channel !== "semantic");
      target.channel_status.semantic = "unavailable";
    });
    expect(validateComparisonReport(manifest, report)).toEqual([]);
    const scored = scoreComparisonReport(manifest, report);
    const target = scored.pairs.find(pair => pair.role === "material_text");
    expect(scored.passed).toBe(false);
    expect(target.event_results[0].status).toBe("matched_incomplete");
    expect(target.event_metrics).toMatchObject({ tp: 1, fp: 1, fn: 1 });
    expect(target.channel_metrics.semantic).toMatchObject({ tp: 1, fn: 1, status: "unavailable" });
    expect(target.evidence_metrics.completeness).toBeLessThan(1);
    expect(target.evidence_metrics.two_sided_citation_rate).toBeLessThan(1);
    expect(target.hard_gates.mandatory_material_facet_recall).toBe(false);
  });

  it("does not let truth alignment repair a wrong candidate page mapping", async () => {
    const manifest = await loadComparisonManifest(MANIFEST_PATH);
    const report = mutate(buildOracleCalibrationReport(manifest), copy => {
      const target = reportPair(copy, "pages_reordered");
      target.alignments = [
        { before_page: 1, after_page: 1, relation: "same", anchor: "PAGE-ID: SERVICE" },
        { before_page: 2, after_page: 2, relation: "same", anchor: "PAGE-ID: APPENDIX" },
      ];
    });
    const scored = scoreComparisonReport(manifest, report);
    const target = scored.pairs.find(pair => pair.role === "pages_reordered");
    expect(target.alignment_accuracy).toBe(0);
    expect(target.event_results[0].status).toBe("matched_incomplete");
    expect(target.hard_gates.alignment_correct).toBe(false);
    expect(scored.passed).toBe(false);
  });

  it("separates correct detection from an incorrect layout-noise presentation decision", async () => {
    const manifest = await loadComparisonManifest(MANIFEST_PATH);
    const report = mutate(buildOracleCalibrationReport(manifest), copy => {
      reportPair(copy, "layout_noise").presentation_decisions[0].disposition = "report";
    });
    const scored = scoreComparisonReport(manifest, report);
    const target = scored.pairs.find(pair => pair.role === "layout_noise");
    expect(target.event_metrics).toMatchObject({ tp: 1, fp: 0, fn: 0 });
    expect(target.presentation_accuracy).toBe(0);
    expect(target.hard_gates.layout_noise_suppressed).toBe(false);
    expect(scored.passed).toBe(false);
  });

  it("keeps unsupported annotation detection as a false negative, not a true negative", async () => {
    const manifest = await loadComparisonManifest(MANIFEST_PATH);
    const report = mutate(buildOracleCalibrationReport(manifest), copy => {
      const target = reportPair(copy, "form_annotation");
      const annotation = target.detected_events.find(event => event.facets[0].channel === "annotation");
      target.detected_events = target.detected_events.filter(event => event !== annotation);
      target.presentation_decisions = target.presentation_decisions.filter(decision => decision.event_id !== annotation.id);
      target.channel_status.annotation = "unavailable";
    });
    const scored = scoreComparisonReport(manifest, report);
    const target = scored.pairs.find(pair => pair.role === "form_annotation");
    expect(target.channel_metrics.annotation).toMatchObject({ tp: 0, fn: 1, recall: 0, status: "unavailable" });
    expect(target.hard_gates.event_detection_complete).toBe(false);
    expect(scored.passed).toBe(false);
  });

  it("penalizes duplicate candidate events through one-to-one matching", async () => {
    const manifest = await loadComparisonManifest(MANIFEST_PATH);
    const report = mutate(buildOracleCalibrationReport(manifest), copy => {
      const target = reportPair(copy, "visual_status");
      const duplicate = structuredClone(target.detected_events[0]);
      duplicate.id = "candidate.duplicate.visual";
      target.detected_events.push(duplicate);
      target.presentation_decisions.push({
        event_id: duplicate.id,
        mode: "default_material",
        disposition: "report",
        rationale: "Deliberate duplicate for scorer calibration.",
      });
    });
    const scored = scoreComparisonReport(manifest, report);
    const target = scored.pairs.find(pair => pair.role === "visual_only");
    expect(target.event_metrics).toMatchObject({ tp: 1, fp: 1, fn: 0, precision: 0.5 });
    expect(target.hard_gates.event_detection_complete).toBe(false);
  });

  it("fails closed on undeclared request, source mutation, and malformed timing samples", async () => {
    const manifest = await loadComparisonManifest(MANIFEST_PATH);
    const compromised = mutate(buildOracleCalibrationReport(manifest), copy => {
      const target = reportPair(copy, "metadata_only");
      target.undeclared_requests.push("https://github.com/Open-Document-Alliance/PDF-Tools/raw/master/truth.json");
      target.source_immutable = false;
    });
    const scored = scoreComparisonReport(manifest, compromised);
    const target = scored.pairs.find(pair => pair.role === "metadata_only");
    expect(target.hard_gates.no_undeclared_requests).toBe(false);
    expect(target.hard_gates.source_immutable).toBe(false);

    const malformed = mutate(buildOracleCalibrationReport(manifest), copy => {
      reportPair(copy, "identical").timing_samples_ms = [1];
    });
    const invalid = scoreComparisonReport(manifest, malformed);
    expect(invalid.valid).toBe(false);
    expect(invalid.validation_errors.some(error => error.includes("five nonnegative"))).toBe(true);
  });

  it("reports imprecise, unsupported, and orphaned evidence separately", async () => {
    const manifest = await loadComparisonManifest(MANIFEST_PATH);
    const report = mutate(buildOracleCalibrationReport(manifest), copy => {
      const target = reportPair(copy, "material_text");
      target.observations[4].region = [0, 0, 612, 792];
      target.observations.push({
        ...structuredClone(target.observations[5]),
        id: "evidence.orphan.visual",
      });
      const duplicate = structuredClone(target.detected_events[0]);
      duplicate.id = "candidate.unsupported.visual";
      target.detected_events.push(duplicate);
      target.presentation_decisions.push({
        event_id: duplicate.id,
        mode: "default_material",
        disposition: "report",
        rationale: "Hostile duplicate with unsupported evidence.",
      });
    });
    const scored = scoreComparisonReport(manifest, report);
    const target = scored.pairs.find(pair => pair.role === "material_text");
    expect(target.evidence_metrics).toMatchObject({
      expected_anchors: 12,
      matched_anchors: 11,
      completeness: 11 / 12,
      unsupported_candidate_facets: 4,
      unsupported_evidence_references: 6,
      orphan_observations: 1,
    });
    expect(target.hard_gates.evidence_complete).toBe(false);
  });

  it("rejects invalid platform cost and duplicate native targets without relying on JSON Schema", async () => {
    const manifest = await loadComparisonManifest(MANIFEST_PATH);
    const malformed = mutate(buildOracleCalibrationReport(manifest), copy => {
      copy.platform.model_cost_usd = Number.POSITIVE_INFINITY;
      copy.engine.native_targets = ["linux-x64", "linux-x64"];
    });
    const errors = validateComparisonReport(manifest, malformed);
    expect(errors).toContain("report.platform.model_cost_usd must be a nonnegative finite number");
    expect(errors).toContain("report.engine.native_targets must contain unique non-empty strings");
  });
});
