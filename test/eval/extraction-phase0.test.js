import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { generateExtractionFixtures } from "../../scripts/eval-generate-extraction-fixtures.mjs";
import { runExtractionBaseline } from "../../scripts/eval-run-extraction-baseline.mjs";
import {
  loadExtractionManifest,
  resolveExtractionFixture,
  sha256,
} from "./extraction-manifest.js";
import { scoreExtractionCase } from "./extraction-scorer.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTRACTION_ROOT = path.join(REPO_ROOT, "test", "fixtures", "eval", "extraction");
const MANIFEST_PATH = path.join(EXTRACTION_ROOT, "manifest.v1.json");
const MANIFEST_SCHEMA_PATH = path.join(EXTRACTION_ROOT, "manifest.schema.json");
const REPORT_SCHEMA_PATH = path.join(EXTRACTION_ROOT, "report.schema.json");
const temporaryDirectories = [];

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-extraction-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("structured extraction Phase 0", () => {
  it("validates eight exact licensed and private-safe fixture contracts", async () => {
    const { manifest } = await loadExtractionManifest(MANIFEST_PATH, MANIFEST_SCHEMA_PATH);
    expect(manifest.fixtures).toHaveLength(8);
    expect(new Set(manifest.fixtures.map(fixture => fixture.id)).size).toBe(8);
    expect(new Set(manifest.fixtures.map(fixture => fixture.category))).toEqual(new Set([
      "flat_schema",
      "nested_schema",
      "layout_order",
      "table",
      "ocr_clean",
      "ocr_degraded",
      "mixed_modality",
      "no_answer_contradiction",
    ]));
    for (const fixture of manifest.fixtures) {
      expect(fixture.license.redistribution).toBe("allowed");
      expect(fixture.privacy.contains_personal_data).toBe(false);
      expect(fixture.expected.page_geometry.every(page => page.media_box && page.crop_box)).toBe(true);
      expect(sha256(await fs.readFile(resolveExtractionFixture(MANIFEST_PATH, fixture)))).toBe(fixture.sha256);
    }
  });

  it("regenerates all eight synthetic PDFs byte for byte", async () => {
    const output = await temporaryDirectory();
    const { manifest } = await loadExtractionManifest(MANIFEST_PATH, MANIFEST_SCHEMA_PATH);
    expect(await generateExtractionFixtures(output)).toHaveLength(8);
    for (const fixture of manifest.fixtures) {
      const generated = await fs.readFile(path.join(output, path.basename(fixture.path)));
      expect(sha256(generated), fixture.id).toBe(fixture.sha256);
    }
  });

  it("rejects manifest license, privacy, hash, schema, and denominator mutations", async () => {
    const [manifest, schema] = await Promise.all([
      fs.readFile(MANIFEST_PATH, "utf8").then(JSON.parse),
      fs.readFile(MANIFEST_SCHEMA_PATH, "utf8").then(JSON.parse),
    ]);
    const validator = new AjvJsonSchemaValidator().getValidator(schema);
    const mutants = [
      value => { value.fixtures[0].license.redistribution = "unknown"; },
      value => { value.fixtures[0].privacy.contains_personal_data = true; },
      value => { value.fixtures[0].sha256 = "not-a-digest"; },
      value => { delete value.fixtures[0].target_schema; },
      value => { value.fixtures.pop(); },
    ];
    for (const mutate of mutants) {
      const mutant = structuredClone(manifest);
      mutate(mutant);
      expect(validator(mutant).valid).toBe(false);
    }
  });

  it("rejects a schema-shaped manifest whose fixture digest is forged", async () => {
    const root = await temporaryDirectory();
    await fs.cp(path.join(EXTRACTION_ROOT, "synthetic"), path.join(root, "synthetic"), { recursive: true });
    const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
    manifest.fixtures[0].sha256 = "0".repeat(64);
    const manifestPath = path.join(root, "manifest.json");
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(loadExtractionManifest(manifestPath, MANIFEST_SCHEMA_PATH)).rejects.toThrow(/hash mismatch/);
  });

  it("reports unconditional field precision, recall, F1, missing, and spurious counts", async () => {
    const { manifest } = await loadExtractionManifest(MANIFEST_PATH, MANIFEST_SCHEMA_PATH);
    const fixture = manifest.fixtures[0];
    const exact = scoreExtractionCase(fixture, {
      structured_candidate: fixture.ground_truth,
      page_texts: [{ page: 1, text: fixture.expected.pages[0].transcript }],
      page_result_sha256: "a".repeat(64),
      evidence: [],
    });
    expect(exact.field_correctness).toMatchObject({
      true_positive: 5,
      missing: 0,
      spurious: 0,
      precision: 1,
      recall: 1,
      f1: 1,
    });

    const hostile = structuredClone(fixture.ground_truth);
    delete hostile.vendor;
    hostile.unplanned = "invented";
    const scored = scoreExtractionCase(fixture, { structured_candidate: hostile });
    expect(scored.schema_validity.score).toBe(0);
    expect(scored.field_correctness.missing).toBe(1);
    expect(scored.field_correctness.spurious).toBe(1);
    expect(scored.field_correctness.f1).toBeLessThan(1);
  });

  it("requires evidence source and result digests and bounds any claimed box", async () => {
    const { manifest } = await loadExtractionManifest(MANIFEST_PATH, MANIFEST_SCHEMA_PATH);
    const fixture = manifest.fixtures[0];
    const fact = fixture.expected.facts[0];
    const resultDigest = "a".repeat(64);
    const base = {
      structured_candidate: fixture.ground_truth,
      page_result_sha256: resultDigest,
      evidence: [{
        id: "evidence.bound",
        kind: "page",
        source_sha256: fixture.sha256,
        result_sha256: resultDigest,
        page: fact.page,
        text: fact.anchor_text,
        bbox: fact.bbox,
        fact_ids: [fact.id],
      }],
    };
    const valid = scoreExtractionCase(fixture, base);
    expect(valid.evidence_page.numerator).toBe(1);
    expect(valid.evidence_fact.numerator).toBe(1);
    expect(valid.evidence_bbox.numerator).toBe(1);

    const pageOnly = structuredClone(base);
    pageOnly.evidence[0].fact_ids = [];
    expect(scoreExtractionCase(fixture, pageOnly)).toMatchObject({
      evidence_page: { numerator: 1, availability: "measured" },
      evidence_fact: { numerator: 0, availability: "unavailable" },
      evidence_bbox: { numerator: 0, availability: "unavailable" },
    });

    const forged = structuredClone(base);
    forged.evidence[0].source_sha256 = "0".repeat(64);
    expect(scoreExtractionCase(fixture, forged).evidence_page.numerator).toBe(0);

    const outOfBounds = structuredClone(base);
    outOfBounds.evidence[0].bbox.x = 700;
    expect(scoreExtractionCase(fixture, outOfBounds).evidence_bbox.numerator).toBe(0);
  });

  it("retains the full attempted denominator and counts unavailable required extraction as product failure", async () => {
    const output = path.join(await temporaryDirectory(), "report.json");
    const report = await runExtractionBaseline({
      manifestPath: MANIFEST_PATH,
      manifestSchemaPath: MANIFEST_SCHEMA_PATH,
      reportSchemaPath: REPORT_SCHEMA_PATH,
      outputPath: output,
    });
    expect(report.benchmark_claim_ready).toBe(false);
    expect(report.calibration_claim_ready).toBe(false);
    expect(report.denominator).toMatchObject({
      planned: 8,
      attempted: 8,
      completed: 0,
      product_failures: 8,
      product_timeouts: 0,
      invalid_outputs: 0,
      harness_failures: 0,
    });
    expect(report.cases).toHaveLength(8);
    expect(report.cases.every(item => item.outcome === "product_failure")).toBe(true);
    expect(report.aggregate_metrics.ocr).toMatchObject({
      applicable_cases: 3,
      measured_cases: 0,
      unavailable_cases: 3,
      scored_cases: 3,
      mean_score_over_applicable: 0,
    });
    expect(report.aggregate_metrics.raster_render).toMatchObject({
      applicable_cases: 3,
      measured_cases: 3,
      mean_score_over_applicable: 1,
    });
    expect(report.aggregate_metrics.table_topology.unavailable_cases).toBe(1);
    expect(report.aggregate_metrics.field_correctness.unavailable_cases).toBe(8);
    expect(report.aggregate_metrics.evidence_fact).toMatchObject({
      applicable_cases: 8,
      measured_cases: 0,
      unavailable_cases: 8,
      mean_score_over_applicable: 0,
    });
  }, 30_000);

  it("schema prevents either readiness flag from being promoted", async () => {
    const report = await runExtractionBaseline({
      manifestPath: MANIFEST_PATH,
      manifestSchemaPath: MANIFEST_SCHEMA_PATH,
      reportSchemaPath: REPORT_SCHEMA_PATH,
    });
    const schema = JSON.parse(await fs.readFile(REPORT_SCHEMA_PATH, "utf8"));
    const validator = new AjvJsonSchemaValidator().getValidator(schema);
    for (const key of ["benchmark_claim_ready", "calibration_claim_ready"]) {
      const mutant = structuredClone(report);
      mutant[key] = true;
      expect(validator(mutant).valid).toBe(false);
    }
  }, 30_000);
});
