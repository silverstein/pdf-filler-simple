import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { generateAccessibilityFixtures } from "../../scripts/eval-generate-accessibility-fixtures.mjs";
import { runAccessibilityEvaluation } from "../../scripts/eval-run-accessibility.mjs";
import {
  loadAccessibilityManifest,
  resolveAccessibilityFixturePath,
  validateAccessibilityManifest,
} from "./accessibility-manifest.js";
import { applyAccessibilityClaimGate, screenPdfAccessibility } from "./accessibility-scorer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "accessibility", "manifest.v1.json");
const SCHEMA_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "accessibility", "manifest.schema.json");
const TAXONOMY_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "accessibility", "claim-taxonomy.v1.json");
const temporaryDirectories = [];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function temporaryDirectory(prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe("accessibility structural screen and claim gate v1", () => {
  let manifest;
  let taxonomy;

  beforeAll(async () => {
    manifest = await loadAccessibilityManifest(MANIFEST_PATH);
    taxonomy = JSON.parse(await fs.readFile(TAXONOMY_PATH, "utf8"));
  });

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory =>
      fs.rm(directory, { recursive: true, force: true })
    ));
  });

  it("versions the claims and requires provenance, license, privacy, and bounded expectations", async () => {
    const schema = JSON.parse(await fs.readFile(SCHEMA_PATH, "utf8"));
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$defs.fixture.required).toEqual(expect.arrayContaining([
      "provenance",
      "license",
      "privacy",
      "expected",
    ]));
    expect(validateAccessibilityManifest(manifest)).toEqual([]);
    expect(taxonomy.taxonomy_version).toBe(1);
    expect(taxonomy.automated_lane_capability.maximum_emittable_state).toBe("no_structural_failures_detected");
    expect(taxonomy.never_infer).toEqual(expect.arrayContaining([
      { from: "pdfua_identification_metadata", to: "PDF/UA conformance" },
      { from: "PDF/UA conformance", to: "WCAG conformance" },
    ]));
  });

  it("rejects ambiguous fixture provenance and any personal or non-redistributable data", () => {
    const invalid = structuredClone(manifest);
    delete invalid.fixtures[0].provenance.source_url;
    invalid.fixtures[1].privacy.contains_personal_data = true;
    invalid.fixtures[2].license.redistribution = "unknown";
    invalid.fixtures[0].expected.maximum_claim_state = "certified_conformance";
    invalid.fixtures[0].path = "../../private.pdf";
    expect(validateAccessibilityManifest(invalid)).toEqual(expect.arrayContaining([
      expect.stringContaining("source_url must be explicit"),
      expect.stringContaining("privacy must explicitly exclude personal data"),
      expect.stringContaining("license must explicitly permit redistribution"),
      expect.stringContaining("exceeds this lane's capability"),
      expect.stringContaining("manifest-relative path"),
    ]));
  });

  it("hash-binds the manifest to the exact claim taxonomy", async () => {
    const directory = await temporaryDirectory("pdf-tools-accessibility-taxonomy-");
    const copiedManifest = structuredClone(manifest);
    copiedManifest.taxonomy_sha256 = "0".repeat(64);
    await fs.writeFile(path.join(directory, "manifest.v1.json"), JSON.stringify(copiedManifest));
    await fs.copyFile(TAXONOMY_PATH, path.join(directory, "claim-taxonomy.v1.json"));
    await expect(loadAccessibilityManifest(path.join(directory, "manifest.v1.json")))
      .rejects.toThrow("taxonomy SHA-256 mismatch");
  });

  it("regenerates every synthetic fixture byte-for-byte", async () => {
    const outputDirectory = await temporaryDirectory("pdf-tools-accessibility-generate-");
    await generateAccessibilityFixtures(outputDirectory);
    for (const fixture of manifest.fixtures) {
      const generated = await fs.readFile(path.join(outputDirectory, path.basename(fixture.path)));
      expect(sha256(generated), fixture.id).toBe(fixture.sha256);
    }
  });

  it("detects missing structural signals without calling that a complete defect inventory", async () => {
    const fixture = manifest.fixtures.find(item => item.id.endsWith(".untagged"));
    const assessment = await screenPdfAccessibility(resolveAccessibilityFixturePath(MANIFEST_PATH, fixture));
    expect(assessment.screen.status).toBe("fail");
    expect(assessment.screen.failures).toEqual(expect.arrayContaining([
      "catalog_marked",
      "document_language",
      "structure_tree_root",
    ]));
    expect(assessment.claims.maximum_claim_state).toBe("structural_failures_detected");
    expect(assessment.claims.pdfua_conformance.status).toBe("not_established");
  });

  it("does not treat a self-declared PDF/UA identifier as proof", async () => {
    const fixture = manifest.fixtures.find(item => item.id.endsWith(".claim-only"));
    const assessment = await screenPdfAccessibility(resolveAccessibilityFixturePath(MANIFEST_PATH, fixture));
    expect(assessment.screen.observations.pdfua_identification).toMatchObject({ declared: true, part: 1 });
    expect(assessment.screen.status).toBe("fail");
    expect(assessment.screen.failures).toContain("structure_parent_tree");
    expect(assessment.claims.pdfua_identification_is_self_declared).toBe(true);
    expect(assessment.claims.pdfua_conformance.status).toBe("not_established");
  });

  it("never turns a superficial screen pass into accessibility, conformance, or certification", async () => {
    const fixture = manifest.fixtures.find(item => item.id.endsWith(".screen-pass-not-conformance"));
    const assessment = await screenPdfAccessibility(resolveAccessibilityFixturePath(MANIFEST_PATH, fixture));
    expect(assessment.screen.status).toBe("pass");
    expect(assessment.claims.maximum_claim_state).toBe("no_structural_failures_detected");
    expect(assessment.claims.prohibited_claims).toEqual(expect.arrayContaining([
      "accessible PDF",
      "PDF/UA compliant",
      "WCAG compliant",
      "certified accessible",
    ]));
    expect(assessment.claims.pdfua_conformance.status).toBe("not_established");
    expect(assessment.claims.wcag_conformance.status).toBe("not_established");
    expect(assessment.claims.certified_conformance.status).toBe("not_established");
  });

  it("rejects forged validator, human-review, and certificate evidence instead of false-passing", async () => {
    const fixture = manifest.fixtures.find(item => item.id.endsWith(".screen-pass-not-conformance"));
    const basic = await screenPdfAccessibility(resolveAccessibilityFixturePath(MANIFEST_PATH, fixture));
    const claims = applyAccessibilityClaimGate(basic.screen, {
      machine_validation: { tool: "definitely-real-validator", passed: true },
      human_review: { reviewer: "self-asserted", completed: true },
      certification: { authority: "self-asserted", certified: true },
    });
    expect(claims.maximum_claim_state).toBe("no_structural_failures_detected");
    expect(claims.machine_validation).toMatchObject({
      status: "not_established",
      evidence_received: true,
      evidence_disposition: "rejected_no_trusted_v1_ingestion_adapter",
    });
    expect(claims.human_review.status).toBe("not_established");
    expect(claims.pdfua_conformance.status).toBe("not_established");
    expect(claims.certified_conformance.status).toBe("not_established");
  });

  it("fails closed on a non-PDF and runs the complete public-safe corpus", async () => {
    const directory = await temporaryDirectory("pdf-tools-accessibility-invalid-");
    const invalidPath = path.join(directory, "not-a-pdf.pdf");
    await fs.writeFile(invalidPath, "not a PDF");
    const invalid = await screenPdfAccessibility(invalidPath);
    expect(invalid.screen.status).toBe("fail");
    expect(invalid.screen.failures).toEqual(["parseable_pdf"]);
    expect(invalid.claims.pdfua_conformance.status).toBe("not_established");

    const report = await runAccessibilityEvaluation({ manifestPath: MANIFEST_PATH });
    expect(report.passed).toBe(true);
    expect(report.results).toHaveLength(3);
    expect(report.results.every(result => result.sha256_matches)).toBe(true);
    expect(report.results.every(result => result.assessment.claims.pdfua_conformance.status === "not_established")).toBe(true);
  });
});
