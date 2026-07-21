import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const FIDELITY_BENCHMARK_ID = "pdf-tools.mutation-fidelity.v1";
export const FIDELITY_CASE_IDS = Object.freeze([
  "pdf-tools.fidelity.case.fill-new-output",
  "pdf-tools.fidelity.case.apply-text",
  "pdf-tools.fidelity.case.prepare-signing-packet",
  "pdf-tools.fidelity.case.page-plan-reorder-rotate",
  "pdf-tools.fidelity.case.merge-split-roundtrip",
  "pdf-tools.fidelity.case.same-path-backup",
  "pdf-tools.fidelity.case.missing-backup-fail-closed",
]);
export const FIDELITY_METADATA_KEYS = Object.freeze([
  "Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate",
]);
export const FIDELITY_GATES = Object.freeze([
  "tool_execution", "artifact", "pdfjs_engine", "poppler_engine", "lineage", "geometry",
  "semantics", "target_evidence", "intended_visual", "forbidden_visual", "filesystem", "lifecycle", "backup",
]);

const SHA256 = /^[a-f0-9]{64}$/;
const LOGICAL_PATH = /^(input|output|profiles)\/[A-Za-z0-9._/-]+$/;
const TEMP_PATH = /(^|\/)(?:\.tmp|tmp-|.*\.tmp(?:-|$)|.*\.partial(?:-|$))/i;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameSet(left, right) {
  return left.length === right.length && left.every(value => right.includes(value));
}

function unique(values) {
  return new Set(values).size === values.length;
}

function safeLogicalPath(value) {
  if (typeof value !== "string" || !LOGICAL_PATH.test(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && !normalized.split("/").includes("..");
}

function collectLogicalPaths(value, found = []) {
  if (typeof value === "string" && LOGICAL_PATH.test(value)) found.push(value);
  if (Array.isArray(value)) value.forEach(item => collectLogicalPaths(item, found));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    Object.values(value).forEach(item => collectLogicalPaths(item, found));
  }
  return found;
}

function expectedGates(caseDefinition) {
  const gates = [
    "tool_execution", "artifact", "pdfjs_engine", "poppler_engine", "lineage", "geometry",
    "semantics", "forbidden_visual", "filesystem", "lifecycle",
  ];
  if (caseDefinition.intended_regions.length > 0) gates.push("intended_visual");
  if (caseDefinition.intended_regions.length > 0) gates.push("target_evidence");
  if (caseDefinition.lifecycle.backup_policy !== "none") gates.push("backup");
  return gates;
}

export function producerCallIndex(caseDefinition, outputPath) {
  let producer = null;
  for (const [index, call] of (caseDefinition.tool_calls ?? []).entries()) {
    if (call.expect_error === true) continue;
    if (call.arguments?.output_path === outputPath
      || (typeof call.arguments?.output_directory === "string" && outputPath.startsWith(`${call.arguments.output_directory}/`))) {
      producer = index + 1;
    }
  }
  return producer;
}

function consumedPaths(call) {
  if (call.name === "merge_pdfs") return call.arguments?.input_paths ?? [];
  const pathValue = call.arguments?.pdf_path ?? call.arguments?.input_path;
  return pathValue ? [pathValue] : [];
}

export function validateFidelityManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return ["manifest must be an object"];
  if (manifest.schema_version !== 1) errors.push("manifest.schema_version must be 1");
  if (manifest.benchmark_id !== FIDELITY_BENCHMARK_ID) errors.push(`manifest.benchmark_id must be ${FIDELITY_BENCHMARK_ID}`);
  if (manifest.benchmark_version !== 1) errors.push("manifest.benchmark_version must be 1");
  const policy = manifest.measurement_policy;
  if (policy?.repetitions !== 3) errors.push("manifest.measurement_policy.repetitions must be 3");
  if (JSON.stringify(policy?.required_engine_families) !== JSON.stringify(["pdfjs", "poppler"])) {
    errors.push("manifest.measurement_policy.required_engine_families must bind independent pdfjs and poppler families");
  }
  if (policy?.no_gate_averaging !== true) errors.push("manifest.measurement_policy.no_gate_averaging must be true");
  if (policy?.renderer?.unexpected_delta_threshold !== 8
    || JSON.stringify(policy?.renderer?.pixel_delta_thresholds) !== JSON.stringify([0, 2, 8])
    || policy?.renderer?.intended_region_halo_pixels !== 2) {
    errors.push("manifest.measurement_policy.renderer differs from the v1 hard-gate policy");
  }

  const documents = Array.isArray(manifest.documents) ? manifest.documents : [];
  if (!unique(documents.map(document => document.id))) errors.push("manifest.documents contains duplicate ids");
  const documentIds = new Set(documents.map(document => document.id));
  for (const [index, document] of documents.entries()) {
    if (!SHA256.test(document?.sha256 ?? "")) errors.push(`manifest.documents[${index}].sha256 must be SHA-256`);
    if (typeof document?.path !== "string" || path.isAbsolute(document.path)
      || !document.path.endsWith(".pdf") || document.path.split(/[\\/]/).includes("..") === false) {
      errors.push(`manifest.documents[${index}].path must be a fixture-relative PDF path`);
    }
  }

  const cases = Array.isArray(manifest.cases) ? manifest.cases : [];
  const caseIds = cases.map(item => item.id);
  if (!sameSet(caseIds, [...FIDELITY_CASE_IDS])) errors.push("manifest.cases must contain exactly the seven v1 case ids");
  if (!unique(caseIds)) errors.push("manifest.cases contains duplicate ids");
  for (const [caseIndex, item] of cases.entries()) {
    const location = `manifest.cases[${caseIndex}]`;
    const inputPaths = new Set();
    for (const [inputIndex, input] of (item.inputs ?? []).entries()) {
      if (!safeLogicalPath(input.logical_path)) errors.push(`${location}.inputs[${inputIndex}].logical_path is unsafe`);
      if (!documentIds.has(input.document_id)) errors.push(`${location}.inputs[${inputIndex}].document_id is unknown`);
      if (inputPaths.has(input.logical_path)) errors.push(`${location}.inputs duplicates ${input.logical_path}`);
      inputPaths.add(input.logical_path);
    }
    for (const logicalPath of collectLogicalPaths(item.tool_calls)) {
      if (!safeLogicalPath(logicalPath)) errors.push(`${location}.tool_calls contains unsafe path ${logicalPath}`);
    }
    const outputs = item.expected_outputs ?? [];
    if (!unique(outputs) || outputs.some(output => !safeLogicalPath(output))) {
      errors.push(`${location}.expected_outputs must contain unique safe logical paths`);
    }
    const outputSet = new Set(outputs);
    const availablePaths = new Set(inputPaths);
    for (const [callIndex, call] of (item.tool_calls ?? []).entries()) {
      for (const consumed of consumedPaths(call)) {
        if (!availablePaths.has(consumed)) errors.push(`${location}.tool_calls[${callIndex}] consumes unavailable path ${consumed}`);
      }
      for (const output of outputs.filter(outputPath => producerCallIndex({ tool_calls: [call] }, outputPath) === 1)) {
        if (call.expect_error !== true) availablePaths.add(output);
      }
    }
    for (const output of outputs) {
      if (producerCallIndex(item, output) === null) errors.push(`${location}.expected_outputs has no successful producer for ${output}`);
    }
    const lineageKeys = new Set();
    for (const [lineageIndex, lineage] of (item.page_lineage ?? []).entries()) {
      const key = `${lineage.output_path}#${lineage.output_page}`;
      if (!outputSet.has(lineage.output_path)) errors.push(`${location}.page_lineage[${lineageIndex}] references an undeclared output`);
      if (!inputPaths.has(lineage.source_path)) errors.push(`${location}.page_lineage[${lineageIndex}] references an undeclared source`);
      if (lineageKeys.has(key)) errors.push(`${location}.page_lineage duplicates ${key}`);
      lineageKeys.add(key);
    }
    for (const output of outputs) {
      if (![...lineageKeys].some(key => key.startsWith(`${output}#`))) errors.push(`${location} has no lineage for ${output}`);
    }
    for (const [regionIndex, intended] of (item.intended_regions ?? []).entries()) {
      const region = intended.region;
      if (!outputSet.has(intended.output_path)) errors.push(`${location}.intended_regions[${regionIndex}] references an undeclared output`);
      if (!Array.isArray(region) || region.length !== 4 || !region.every(Number.isFinite)
        || region[0] < 0 || region[1] < 0 || region[2] <= 0 || region[3] <= 0
        || region[0] + region[2] > 612 || region[1] + region[3] > 792) {
        errors.push(`${location}.intended_regions[${regionIndex}] must remain inside the bound 612x792 page`);
      } else if (region[2] * region[3] >= 612 * 792 * 0.5) {
        errors.push(`${location}.intended_regions[${regionIndex}] is an overbroad mask`);
      }
      const evidence = intended.target_evidence;
      if (evidence?.kind === "field_appearance") {
        if (typeof evidence.field_name !== "string" || !Object.hasOwn(evidence, "expected_value")) {
          errors.push(`${location}.intended_regions[${regionIndex}] has incomplete field appearance evidence`);
        }
      } else if (evidence?.kind === "text_run") {
        if (typeof evidence.expected_text !== "string" || evidence.expected_text.length === 0) {
          errors.push(`${location}.intended_regions[${regionIndex}] has incomplete text evidence`);
        }
      } else {
        errors.push(`${location}.intended_regions[${regionIndex}] must bind supported target evidence`);
      }
    }
    for (const [semanticIndex, semantic] of (item.semantics ?? []).entries()) {
      if (!outputSet.has(semantic.output_path)) errors.push(`${location}.semantics[${semanticIndex}] references an undeclared output`);
      const metadata = semantic.metadata ?? {};
      if (!inputPaths.has(metadata.preserve_from)) errors.push(`${location}.semantics[${semanticIndex}].metadata.preserve_from is unknown`);
      const preserve = metadata.preserve_keys ?? [];
      const allowed = metadata.allowed_change_keys ?? [];
      if (!unique(preserve) || !unique(allowed) || preserve.some(key => allowed.includes(key))
        || !sameSet([...preserve, ...allowed], [...FIDELITY_METADATA_KEYS])) {
        errors.push(`${location}.semantics[${semanticIndex}].metadata must classify every v1 metadata key exactly once`);
      }
    }
    const expected = expectedGates(item);
    if (!unique(item.required_gates ?? []) || !sameSet(item.required_gates ?? [], expected)) {
      errors.push(`${location}.required_gates differs from the exact ${item.family} contract`);
    }
    if ((item.required_gates ?? []).some(gate => !FIDELITY_GATES.includes(gate))) errors.push(`${location}.required_gates contains an unknown gate`);
    const faultActions = item.fault_actions ?? [];
    if (item.id.endsWith("missing-backup-fail-closed")) {
      if (faultActions.length !== 1 || faultActions[0].action !== "delete_reported_backup"
        || item.tool_calls?.[1]?.expect_error !== true
        || item.lifecycle?.backup_policy !== "missing-original-fail-closed") {
        errors.push(`${location} must bind the missing-backup fail-closed fault sequence`);
      }
    } else if (faultActions.length > 0) {
      errors.push(`${location}.fault_actions are not permitted for this v1 case`);
    }
    for (const collection of [item.filesystem?.created, item.filesystem?.created_directories,
      item.filesystem?.modified, item.filesystem?.deleted]) {
      if ((collection ?? []).some(value => !safeLogicalPath(value) || TEMP_PATH.test(value))) {
        errors.push(`${location}.filesystem contains an unsafe or temporary path`);
      }
    }
  }
  return errors;
}

export async function loadFidelityManifest(manifestPath) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const errors = validateFidelityManifest(manifest);
  if (errors.length) throw new Error(`Invalid fidelity manifest:\n${errors.join("\n")}`);
  return manifest;
}

export function resolveFidelityDocumentPath(manifestPath, document) {
  const base = path.dirname(manifestPath);
  const resolved = path.resolve(base, document.path);
  const fixtureRoot = path.resolve(base, "..");
  if (!(resolved === fixtureRoot || resolved.startsWith(`${fixtureRoot}${path.sep}`))) {
    throw new Error(`Fidelity fixture path escapes corpus root: ${document.path}`);
  }
  return resolved;
}

export async function verifyFidelityDocuments(manifestPath, manifest) {
  return Promise.all(manifest.documents.map(async document => {
    const resolved = resolveFidelityDocumentPath(manifestPath, document);
    const bytes = await fs.readFile(resolved);
    const observed = digest(bytes);
    return { id: document.id, path: document.path, expected_sha256: document.sha256, observed_sha256: observed, passed: observed === document.sha256 };
  }));
}
