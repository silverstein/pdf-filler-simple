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
import {
  ACCESSIBILITY_ALLOWED_STATEMENTS,
  ACCESSIBILITY_PROHIBITED_CLAIMS,
  applyAccessibilityClaimGate,
  screenPdfAccessibility,
  validateAccessibilityTaxonomyContract,
} from "./accessibility-scorer.js";

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
    ({ manifest, taxonomy } = await loadAccessibilityManifest(MANIFEST_PATH));
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

  it("uses Ajv only through the repository's locked MCP SDK dependency graph", async () => {
    const lock = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package-lock.json"), "utf8"));
    expect(lock.packages["node_modules/@modelcontextprotocol/sdk"].dependencies).toMatchObject({
      ajv: "^8.17.1",
      "ajv-formats": "^3.0.1",
    });
    expect(lock.packages["node_modules/ajv"].version).toBe("8.18.0");
    expect(lock.packages["node_modules/ajv-formats"].version).toBe("3.0.1");
    expect(lock.packages[""].dependencies).not.toHaveProperty("ajv");
    expect(lock.packages[""].dependencies).not.toHaveProperty("ajv-formats");
  });

  it("enforces the published JSON Schema, including closed objects, formats, types, and uniqueness", () => {
    const cases = [];

    const extra = structuredClone(manifest);
    extra.fixtures[0].unexpected = true;
    cases.push(validateAccessibilityManifest(extra));

    const badUri = structuredClone(manifest);
    badUri.fixtures[0].license.url = "not a URI";
    cases.push(validateAccessibilityManifest(badUri));

    const badType = structuredClone(manifest);
    badType.fixtures[0].privacy.contains_personal_data = "false";
    cases.push(validateAccessibilityManifest(badType));

    const duplicate = structuredClone(manifest);
    duplicate.fixtures[0].expected.expected_failure_ids.push("catalog_marked");
    cases.push(validateAccessibilityManifest(duplicate));

    expect(cases.every(errors => errors.length > 0)).toBe(true);
    expect(cases.flat()).toEqual(expect.arrayContaining([
      expect.stringContaining("additional properties"),
      expect.stringContaining("format \"uri\""),
      expect.stringContaining("must be equal to constant"),
      expect.stringContaining("duplicate items"),
    ]));
  });

  it("rejects semantic contradictions that JSON Schema alone cannot express", () => {
    const invalid = structuredClone(manifest);
    invalid.fixtures[0].path = "../../private.pdf";
    invalid.fixtures[0].expected.expected_failure_ids = ["unknown_rule"];
    invalid.fixtures[0].expected.expected_rule_families = [];
    expect(validateAccessibilityManifest(invalid)).toEqual(expect.arrayContaining([
      expect.stringContaining("stay within the manifest directory"),
      expect.stringContaining("unknown rules"),
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

  it("mechanically binds every executable state, statement, prohibited term, rule, and version", () => {
    expect(validateAccessibilityTaxonomyContract(taxonomy)).toEqual([]);
    const mutations = [
      value => { value.automated_lane_capability.scorer_version += 1; },
      value => { value.automated_lane_capability.claim_gate_version += 1; },
      value => { value.automated_lane_capability.executable_claim_states.reverse(); },
      value => { value.claim_states.structural_failures_detected.allowed_statement = "Everything is accessible."; },
      value => { value.prohibited_unqualified_terms.pop(); },
      value => { value.automated_lane_capability.structural_rules[0].family = "wrong_family"; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(taxonomy);
      mutate(changed);
      expect(validateAccessibilityTaxonomyContract(changed).length).toBeGreaterThan(0);
    }
    expect(taxonomy.claim_states.structural_failures_detected.allowed_statement)
      .toBe(ACCESSIBILITY_ALLOWED_STATEMENTS.structural_failures_detected);
    expect(taxonomy.prohibited_unqualified_terms).toEqual(ACCESSIBILITY_PROHIBITED_CLAIMS);
  });

  it("rejects fixture symlinks, parent symlinks, escapes, and non-regular files", async () => {
    const root = await temporaryDirectory("pdf-tools-accessibility-paths-");
    const outside = await temporaryDirectory("pdf-tools-accessibility-outside-");
    const manifestPath = path.join(root, "manifest.json");
    const outsidePdf = path.join(outside, "outside.pdf");
    await fs.writeFile(manifestPath, "{}");
    await fs.writeFile(outsidePdf, "PDF bytes");
    await fs.symlink(outsidePdf, path.join(root, "fixture.pdf"));
    await fs.symlink(outside, path.join(root, "linked-directory"));
    await fs.mkdir(path.join(root, "directory.pdf"));

    await expect(resolveAccessibilityFixturePath(manifestPath, {
      id: "symlink",
      path: "fixture.pdf",
    })).rejects.toThrow("must not contain symbolic links");
    await expect(resolveAccessibilityFixturePath(manifestPath, {
      id: "parent-symlink",
      path: "linked-directory/outside.pdf",
    })).rejects.toThrow("must not contain symbolic links");
    await expect(resolveAccessibilityFixturePath(manifestPath, {
      id: "escape",
      path: "../outside.pdf",
    })).rejects.toThrow("escapes its declared root");
    await expect(resolveAccessibilityFixturePath(manifestPath, {
      id: "directory",
      path: "directory.pdf",
    })).rejects.toThrow("must be a regular file");
  });

  it("regenerates every synthetic fixture byte-for-byte", async () => {
    const outputDirectory = await temporaryDirectory("pdf-tools-accessibility-generate-");
    await generateAccessibilityFixtures(outputDirectory);
    for (const fixture of manifest.fixtures) {
      const generated = await fs.readFile(path.join(outputDirectory, path.basename(fixture.path)));
      expect(sha256(generated), fixture.id).toBe(fixture.sha256);
    }
  });

  it("fails evaluation when the exact expected set omits an extra detected failure", async () => {
    const directory = await temporaryDirectory("pdf-tools-accessibility-exact-failures-");
    await fs.copyFile(TAXONOMY_PATH, path.join(directory, "claim-taxonomy.v1.json"));
    await fs.cp(
      path.join(path.dirname(MANIFEST_PATH), "synthetic"),
      path.join(directory, "synthetic"),
      { recursive: true }
    );
    const underSpecified = structuredClone(manifest);
    underSpecified.fixtures[0].expected.expected_failure_ids = underSpecified.fixtures[0]
      .expected.expected_failure_ids.filter(id => id !== "display_document_title");
    const copiedManifestPath = path.join(directory, "manifest.v1.json");
    await fs.writeFile(copiedManifestPath, JSON.stringify(underSpecified));

    const report = await runAccessibilityEvaluation({ manifestPath: copiedManifestPath });
    const fixture = report.results.find(result => result.id.endsWith(".untagged"));
    expect(report.passed).toBe(false);
    expect(fixture.exact_failures_match).toBe(false);
    expect(fixture.expectation_met).toBe(false);
  });

  it("detects missing structural signals without calling that a complete defect inventory", async () => {
    const fixture = manifest.fixtures.find(item => item.id.endsWith(".untagged"));
    const assessment = await screenPdfAccessibility(await resolveAccessibilityFixturePath(MANIFEST_PATH, fixture));
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
    const assessment = await screenPdfAccessibility(await resolveAccessibilityFixturePath(MANIFEST_PATH, fixture));
    expect(assessment.screen.observations.pdfua_identification).toMatchObject({ declared: true, part: 1 });
    expect(assessment.screen.status).toBe("fail");
    expect(assessment.screen.failures).toContain("structure_parent_tree");
    expect(assessment.claims.pdfua_identification_is_self_declared).toBe(true);
    expect(assessment.claims.pdfua_conformance.status).toBe("not_established");
  });

  it("never turns a superficial screen pass into accessibility, conformance, or certification", async () => {
    const fixture = manifest.fixtures.find(item => item.id.endsWith(".screen-pass-not-conformance"));
    const assessment = await screenPdfAccessibility(await resolveAccessibilityFixturePath(MANIFEST_PATH, fixture));
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
    const basic = await screenPdfAccessibility(await resolveAccessibilityFixturePath(MANIFEST_PATH, fixture));
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
    expect(report.results.every(result => result.exact_failures_match)).toBe(true);
    expect(report.rule_family_confusion).toMatchObject({
      document_metadata: { false_positives: 0, false_negatives: 0 },
      file_integrity: { false_positives: 0, false_negatives: 0 },
      tagged_pdf_structure: { false_positives: 0, false_negatives: 0 },
    });
    expect(report.results.every(result => result.assessment.claims.pdfua_conformance.status === "not_established")).toBe(true);
  });
});
