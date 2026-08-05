#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { PDFDocument } from "pdf-lib";
import { TOOL_SUCCESS_OUTPUT_SCHEMAS } from "../server/output-schemas.js";
import {
  PHASE1_LAYOUT_EVIDENCE_CONTRACT_SHA256,
  buildCanonicalLayoutEvidenceInput,
  classifyLayoutFactOccurrence,
} from "../test/eval/extraction-phase1-layout-evidence.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTRACTION_ROOT = path.join(REPO_ROOT, "test", "fixtures", "eval", "extraction");
const PHASE1_ROOT = path.join(EXTRACTION_ROOT, "phase1");
const PATHS = Object.freeze({
  manifest: path.join(EXTRACTION_ROOT, "manifest.v1.json"),
  manifestSchema: path.join(EXTRACTION_ROOT, "manifest.schema.json"),
  scoringOracle: path.join(PHASE1_ROOT, "scoring-oracle.v1.json"),
  scoringOracleSchema: path.join(PHASE1_ROOT, "scoring-oracle.schema.json"),
  layoutOracleSchema: path.join(PHASE1_ROOT, "layout-occurrence-oracle.schema.json"),
});
const SOURCE_PATHS = Object.freeze({
  accessibility_inspection_module: "server/accessibility-inspection.js",
  generator_script: "scripts/eval-generate-extraction-layout-oracle.mjs",
  layout_evidence_module: "test/eval/extraction-phase1-layout-evidence.js",
  layout_extraction_module: "server/layout-extraction.js",
  type3_cm_reference_module: "server/type3-cm-reference.js",
  layout_oracle_schema: "test/fixtures/eval/extraction/phase1/layout-occurrence-oracle.schema.json",
  markdown_conversion_module: "server/markdown-conversion.js",
  output_schemas_module: "server/output-schemas.js",
  package_json: "package.json",
  package_lock: "package-lock.json",
  pdf_comparison_module: "server/pdf-comparison.js",
  pdf_observations_module: "server/pdf-observations.js",
  pdfjs_package: "node_modules/pdfjs-dist/package.json",
  scoring_oracle_schema: "test/fixtures/eval/extraction/phase1/scoring-oracle.schema.json",
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function jsonBinding(filename) {
  const bytes = await fs.readFile(filename);
  return {
    path: path.relative(REPO_ROOT, filename),
    bytes: bytes.length,
    raw_sha256: sha256(bytes),
    canonical_sha256: sha256(Buffer.from(canonicalJson(JSON.parse(bytes)))),
  };
}

function jsonBindingFromBytes(filename, bytes) {
  return {
    path: path.relative(REPO_ROOT, filename),
    bytes: bytes.length,
    raw_sha256: sha256(bytes),
    canonical_sha256: sha256(Buffer.from(canonicalJson(JSON.parse(bytes)))),
  };
}

function validateScoringOracleFacts(manifest, scoringOracle) {
  if (canonicalJson(scoringOracle.cases.map(item => item.case_id)) !== canonicalJson(manifest.fixtures.map(item => item.id))) {
    throw new Error("Scoring oracle case order differs from the manifest");
  }
  for (const [index, fixture] of manifest.fixtures.entries()) {
    const oracleCase = scoringOracle.cases[index];
    const factIds = new Set(fixture.expected.facts.map(item => item.id));
    const referenced = new Set();
    for (const leaf of oracleCase.truth_leaves) {
      const facts = leaf.fact_support.fact_ids;
      if ((leaf.fact_support.mode === "none") !== (facts.length === 0)) throw new Error(`Scoring oracle fact mode is vacuous for ${fixture.id}${leaf.field_path}`);
      if (facts.some(id => !factIds.has(id))) throw new Error(`Scoring oracle references an unknown fact for ${fixture.id}${leaf.field_path}`);
      facts.forEach(id => referenced.add(id));
    }
    if (canonicalJson([...referenced].sort()) !== canonicalJson([...factIds].sort())) {
      throw new Error(`Scoring oracle does not explicitly bind every manifest fact for ${fixture.id}`);
    }
  }
}

export async function generateLayoutOccurrenceOracle({ manifestBytes: retainedManifestBytes = null, manifestSchemaBytes: retainedManifestSchemaBytes = null, fixtureBytesById = null, caseIds = null } = {}) {
  const [diskManifestBytes, diskManifestSchemaBytes, scoringOracleBytes, scoringOracleSchemaBytes, layoutOracleSchemaBytes, packageLockBytes, pdfjsPackageBytes] = await Promise.all([
    fs.readFile(PATHS.manifest), fs.readFile(PATHS.manifestSchema), fs.readFile(PATHS.scoringOracle),
    fs.readFile(PATHS.scoringOracleSchema), fs.readFile(PATHS.layoutOracleSchema),
    fs.readFile(path.join(REPO_ROOT, "package-lock.json")), fs.readFile(path.join(REPO_ROOT, "node_modules", "pdfjs-dist", "package.json")),
  ]);
  const manifestBytes = retainedManifestBytes ?? diskManifestBytes;
  const manifestSchemaBytes = retainedManifestSchemaBytes ?? diskManifestSchemaBytes;
  const manifest = JSON.parse(manifestBytes);
  const manifestSchema = JSON.parse(manifestSchemaBytes);
  const scoringOracle = JSON.parse(scoringOracleBytes);
  const scoringOracleSchema = JSON.parse(scoringOracleSchemaBytes);
  const layoutOracleSchema = JSON.parse(layoutOracleSchemaBytes);
  for (const [value, schema, label] of [
    [manifest, manifestSchema, "manifest"],
    [scoringOracle, scoringOracleSchema, "scoring oracle"],
  ]) {
    const validation = new AjvJsonSchemaValidator().getValidator(schema)(value);
    if (!validation.valid) throw new Error(`${label} schema validation failed: ${validation.errorMessage}`);
  }
  validateScoringOracleFacts(manifest, scoringOracle);
  const packageLock = JSON.parse(packageLockBytes);
  const pdfjsPackage = JSON.parse(pdfjsPackageBytes);
  if (pdfjsPackage.version !== "5.4.624" || packageLock.packages?.["node_modules/pdfjs-dist"]?.version !== "5.4.624") {
    throw new Error("Layout occurrence oracle requires exact pdfjs-dist 5.4.624 in package and lock evidence");
  }
  const validatorSources = await Promise.all(Object.entries(SOURCE_PATHS).map(async ([role, relativePath]) => {
    const bytes = await fs.readFile(path.join(REPO_ROOT, relativePath));
    return { role, path: relativePath, bytes: bytes.length, sha256: sha256(bytes) };
  }));
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (String(pdfjs.version) !== "5.4.624") throw new Error("Loaded PDF.js version differs from the pinned oracle contract");
  const cases = [];
  const selectedCaseIds = caseIds ?? manifest.fixtures.map(item => item.id);
  if (!Array.isArray(selectedCaseIds) || new Set(selectedCaseIds).size !== selectedCaseIds.length
    || selectedCaseIds.some(id => !manifest.fixtures.some(item => item.id === id))) throw new Error("Layout oracle selected-case set is invalid");
  for (const fixture of selectedCaseIds.map(id => manifest.fixtures.find(item => item.id === id))) {
    const sourcePath = path.join(EXTRACTION_ROOT, fixture.path);
    const sourceBytes = fixtureBytesById ? fixtureBytesById[fixture.id] : await fs.readFile(sourcePath);
    if (!Buffer.isBuffer(sourceBytes)) throw new Error(`Retained layout oracle fixture bytes are missing for ${fixture.id}`);
    if (sha256(sourceBytes) !== fixture.sha256) throw new Error(`Fixture bytes drifted for ${fixture.id}`);
    const pageCount = (await PDFDocument.load(sourceBytes, { updateMetadata: false })).getPageCount();
    if (pageCount !== fixture.expected.page_geometry.length) throw new Error(`Fixture page-count truth drifted for ${fixture.id}`);
    const layout = await buildCanonicalLayoutEvidenceInput({ sourceBytes, sourceSha256: fixture.sha256, pageCount, pdfjsLib: pdfjs });
    const layoutValidation = new AjvJsonSchemaValidator().getValidator(TOOL_SUCCESS_OUTPUT_SCHEMAS.read_pdf_layout)(layout);
    if (!layoutValidation.valid) throw new Error(`Canonical layout output schema failed for ${fixture.id}: ${layoutValidation.errorMessage}`);
    if (layout.page_range.total_pages !== pageCount || layout.page_range.start_page !== 1 || layout.page_range.end_page !== pageCount) {
      throw new Error(`Canonical layout page denominator drifted for ${fixture.id}`);
    }
    const facts = fixture.expected.facts.map(fact => {
      const { coordinate, occurrences, approved, status, statusReason } = classifyLayoutFactOccurrence(layout, fact);
      return {
        fact_id: fact.id,
        field_path: fact.field_path,
        anchor_text: fact.anchor_text,
        page: fact.page,
        status,
        status_reason: statusReason,
        geometry_status: coordinate.eligible ? "eligible" : "unavailable",
        geometry_reason: coordinate.reason,
        observed_occurrence_sha256: occurrences.map(item => item.occurrence_sha256).sort(),
        approved_occurrence: status === "approved_unique" ? approved : null,
      };
    });
    cases.push({
      case_id: fixture.id,
      source_path: fixture.path,
      source_sha256: fixture.sha256,
      source_bytes: sourceBytes.length,
      page_count: pageCount,
      layout_ir_sha256: sha256(Buffer.from(canonicalJson(layout))),
      layout_id_scope_sha256: sha256(Buffer.from(canonicalJson(layout.id_scope))),
      layout_extraction_status: layout.extraction_status,
      facts,
    });
  }
  const oracle = {
    oracle_id: "pdf-tools.extraction-phase1-layout-occurrence-oracle.v1",
    oracle_version: 1,
    manifest_bindings: {
      document: jsonBindingFromBytes(PATHS.manifest, manifestBytes),
      schema: jsonBindingFromBytes(PATHS.manifestSchema, manifestSchemaBytes),
    },
    scoring_oracle_bindings: {
      document: await jsonBinding(PATHS.scoringOracle),
      schema: await jsonBinding(PATHS.scoringOracleSchema),
    },
    layout_contract_bindings: {
      layout_output_schema_sha256: sha256(Buffer.from(canonicalJson(TOOL_SUCCESS_OUTPUT_SCHEMAS.read_pdf_layout))),
      layout_evidence_contract_sha256: PHASE1_LAYOUT_EVIDENCE_CONTRACT_SHA256,
    },
    validator_sources: validatorSources,
    validator_source_set_sha256: sha256(Buffer.from(canonicalJson(validatorSources))),
    pdfjs_version: "5.4.624",
    generation_contract: {
      source_path: "source.pdf", source_file_name: "source.pdf", start_page: 1, end_page: "source_page_count",
      max_items: 5000, max_characters: 100000, max_output_characters: 200000, deadline_ms: 20000,
      occurrence_offsets: "unicode_code_point_half_open", bbox: "rounded_whole_oda_item_union",
    },
    cases,
  };
  const validation = new AjvJsonSchemaValidator().getValidator(layoutOracleSchema)(oracle);
  if (!validation.valid) throw new Error(`Generated layout occurrence oracle schema failed: ${validation.errorMessage}`);
  return oracle;
}

export async function verifyLayoutOccurrenceOracle(oracle, options = {}) {
  const regenerated = await generateLayoutOccurrenceOracle(options);
  const retainedById = new Map(oracle.cases.map(item => [item.case_id, item]));
  const projected = { ...oracle, cases: regenerated.cases.map(item => retainedById.get(item.case_id)) };
  if (canonicalJson(projected) !== canonicalJson(regenerated)) {
    throw new Error("Layout occurrence oracle differs from exact independent regeneration");
  }
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bytes = `${JSON.stringify(await generateLayoutOccurrenceOracle(), null, 2)}\n`;
  if (process.argv.includes("--write")) {
    await fs.writeFile(path.join(PHASE1_ROOT, "layout-occurrence-oracle.v1.json"), bytes);
  } else {
    process.stdout.write(bytes);
  }
}
