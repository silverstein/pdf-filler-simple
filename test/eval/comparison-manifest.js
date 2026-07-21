import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const COMPARISON_SCHEMA_VERSION = 1;
export const COMPARISON_BENCHMARK_ID = "pdf-tools.comparison.v1";
export const COMPARISON_ROLES = Object.freeze([
  "identical",
  "material_text",
  "visual_only",
  "layout_noise",
  "metadata_only",
  "pages_reordered",
  "form_annotation",
]);
export const COMPARISON_CHANNELS = Object.freeze([
  "semantic",
  "text",
  "structure",
  "form_field",
  "annotation",
  "metadata",
  "visual",
]);

const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^v\d+\.\d+\.\d+$/;
const OPERATIONS = new Set(["added", "removed", "modified", "moved"]);
const SALIENCE = new Set(["material", "minor", "noise"]);
const DISPOSITIONS = new Set(["report", "suppress", "report_on_request"]);
const RELATIONS = new Set(["same", "moved", "inserted", "deleted"]);
const CHANNELS = new Set(COMPARISON_CHANNELS);
const ROLES = new Set(COMPARISON_ROLES);
const REQUIRED_BY_ROLE = Object.freeze({
  identical: ["semantic", "text", "structure", "form_field", "annotation", "metadata", "visual"],
  material_text: ["semantic", "text", "visual"],
  visual_only: ["text", "visual"],
  layout_noise: ["semantic", "text", "visual"],
  metadata_only: ["metadata"],
  pages_reordered: ["structure", "text"],
  form_annotation: ["form_field", "annotation", "visual"],
});
const EXPECTED_NORMALIZATION = Object.freeze({
  version: 1,
  unicode: "NFC",
  whitespace: "collapse-trim",
  case_sensitive: true,
  dates: "preserve-lexeme",
  currency: "preserve-code-symbol-and-digits",
  volatile_metadata_keys: ["CreationDate", "ModDate", "Producer", "Creator"],
});
const EXPECTED_RENDERER = Object.freeze({
  version: 1,
  pdfjs_dist: "5.4.624",
  canvas: "0.1.99",
  scale: 2,
  dpi: 144,
  page_box: "CropBox-or-MediaBox",
  rotation: "intrinsic-before-scale",
  canvas_rounding: "ceil",
  background_rgba: [255, 255, 255, 255],
  color_space: "sRGB",
  region_rounding: "floor-min-ceil-max-after-rotation-and-scale",
  is_eval_supported: false,
  use_worker_fetch: false,
  use_system_fonts: false,
  use_wasm: false,
  system_renderer_fallback: false,
  pixel_delta_threshold: 8,
  mask_dilation_pixels: 1,
  connected_components: 8,
  minimum_component_area_pixels: 4,
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value, required, optional, location, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${location} must be an object`);
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter(key => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (missing.length) errors.push(`${location} missing keys: ${missing.join(", ")}`);
  if (unknown.length) errors.push(`${location} unknown keys: ${unknown.join(", ")}`);
  return missing.length === 0 && unknown.length === 0;
}

function validString(value) {
  return typeof value === "string" && value.length > 0;
}

function validateAnchor(anchor, location, documentById, pair, role, errors) {
  if (anchor === null) return;
  if (!exactKeys(anchor, [
    "document_id", "document_sha256", "page", "page_box", "rotation", "region", "value_sha256",
  ], [], location, errors)) return;
  const document = documentById.get(anchor.document_id);
  if (!document) errors.push(`${location}.document_id is unknown`);
  if (document && document.sha256 !== anchor.document_sha256) {
    errors.push(`${location}.document_sha256 does not bind ${anchor.document_id}`);
  }
  const expectedDocumentId = role === "before" ? pair.before_document_id : pair.after_document_id;
  if (anchor.document_id !== expectedDocumentId) {
    errors.push(`${location}.document_id must equal pair.${role}_document_id`);
  }
  if (!SHA256.test(anchor.document_sha256 ?? "")) errors.push(`${location}.document_sha256 must be SHA-256`);
  if (!SHA256.test(anchor.value_sha256 ?? "")) errors.push(`${location}.value_sha256 must be SHA-256`);
  if (!Number.isInteger(anchor.page) || anchor.page < 1) errors.push(`${location}.page must be positive`);
  if (canonical(anchor.page_box) !== canonical([0, 0, 612, 792])) {
    errors.push(`${location}.page_box must bind the synthetic 612x792 page`);
  }
  if (![0, 90, 180, 270].includes(anchor.rotation)) errors.push(`${location}.rotation is invalid`);
  if (!Array.isArray(anchor.region) || anchor.region.length !== 4
    || !anchor.region.every(Number.isFinite) || anchor.region[2] <= 0 || anchor.region[3] <= 0) {
    errors.push(`${location}.region must be [x, y, positive width, positive height]`);
  }
}

function validateDocument(document, location, errors) {
  if (!exactKeys(document, [
    "id", "path", "sha256", "media_type", "provenance", "license", "privacy",
  ], [], location, errors)) return;
  if (!/^pdf-tools\.comparison\.document\.[a-z0-9-]+$/.test(document.id ?? "")) {
    errors.push(`${location}.id is invalid`);
  }
  if (!/^synthetic\/[a-z0-9-]+\.pdf$/.test(document.path ?? "")) errors.push(`${location}.path is invalid`);
  if (!SHA256.test(document.sha256 ?? "")) errors.push(`${location}.sha256 must be SHA-256`);
  if (document.media_type !== "application/pdf") errors.push(`${location}.media_type must be application/pdf`);
  if (!exactKeys(document.provenance, ["kind", "origin", "generator"], [], `${location}.provenance`, errors)) return;
  if (document.provenance.kind !== "synthetic"
    || document.provenance.origin !== "Open Document Alliance PDF Tools comparison corpus"
    || document.provenance.generator !== "scripts/eval-generate-comparison-fixtures.mjs") {
    errors.push(`${location}.provenance must bind the synthetic generator`);
  }
  if (!exactKeys(document.license, ["name", "spdx_id", "url", "redistribution"], [], `${location}.license`, errors)) return;
  if (document.license.spdx_id !== "MIT" || document.license.redistribution !== "allowed") {
    errors.push(`${location}.license must permit redistribution under MIT`);
  }
  if (!exactKeys(document.privacy, ["class", "contains_personal_data", "notes"], [], `${location}.privacy`, errors)) return;
  if (document.privacy.class !== "synthetic" || document.privacy.contains_personal_data !== false
    || !validString(document.privacy.notes)) {
    errors.push(`${location}.privacy must explicitly declare public-safe synthetic data`);
  }
}

function validatePair(pair, location, documentById, truthIds, errors) {
  if (!exactKeys(pair, [
    "id", "role", "partition", "before_document_id", "after_document_id",
    "required_channels", "alignments", "events",
  ], [], location, errors)) return;
  if (!/^pdf-tools\.comparison\.pair\.[a-z0-9-]+$/.test(pair.id ?? "")) errors.push(`${location}.id is invalid`);
  if (!ROLES.has(pair.role)) errors.push(`${location}.role is unsupported`);
  if (!["development", "held_out_release"].includes(pair.partition)) errors.push(`${location}.partition is invalid`);
  if (!documentById.has(pair.before_document_id)) errors.push(`${location}.before_document_id is unknown`);
  if (!documentById.has(pair.after_document_id)) errors.push(`${location}.after_document_id is unknown`);
  if (!Array.isArray(pair.required_channels) || pair.required_channels.some(channel => !CHANNELS.has(channel))
    || new Set(pair.required_channels).size !== pair.required_channels.length) {
    errors.push(`${location}.required_channels must be unique supported channels`);
  }
  if (!Array.isArray(pair.alignments) || pair.alignments.length === 0) {
    errors.push(`${location}.alignments must be non-empty`);
  } else {
    const beforePages = new Set();
    const afterPages = new Set();
    for (const [index, alignment] of pair.alignments.entries()) {
      const itemLocation = `${location}.alignments[${index}]`;
      if (!exactKeys(alignment, ["before_page", "after_page", "relation", "anchor"], [], itemLocation, errors)) continue;
      for (const [key, seen] of [["before_page", beforePages], ["after_page", afterPages]]) {
        const value = alignment[key];
        if (value !== null && (!Number.isInteger(value) || value < 1)) errors.push(`${itemLocation}.${key} is invalid`);
        if (value !== null && seen.has(value)) errors.push(`${itemLocation}.${key} duplicates a one-to-one page`);
        if (value !== null) seen.add(value);
      }
      if (!RELATIONS.has(alignment.relation)) errors.push(`${itemLocation}.relation is unsupported`);
      if (!validString(alignment.anchor)) errors.push(`${itemLocation}.anchor must be non-empty`);
      if (alignment.relation === "inserted" && alignment.before_page !== null) errors.push(`${itemLocation} inserted requires null before_page`);
      if (alignment.relation === "deleted" && alignment.after_page !== null) errors.push(`${itemLocation} deleted requires null after_page`);
      if (["same", "moved"].includes(alignment.relation)
        && (alignment.before_page === null || alignment.after_page === null)) {
        errors.push(`${itemLocation} ${alignment.relation} requires both pages`);
      }
    }
  }
  if (!Array.isArray(pair.events)) {
    errors.push(`${location}.events must be an array`);
    return;
  }
  const mandatoryChannels = new Set();
  for (const [eventIndex, event] of pair.events.entries()) {
    const eventLocation = `${location}.events[${eventIndex}]`;
    if (!exactKeys(event, ["id", "salience", "summary", "facets", "presentation"], [], eventLocation, errors)) continue;
    if (!/^truth\.[a-z0-9-]+$/.test(event.id ?? "")) errors.push(`${eventLocation}.id is invalid`);
    if (truthIds.has(event.id)) errors.push(`${eventLocation}.id duplicates ${event.id}`);
    truthIds.add(event.id);
    if (!SALIENCE.has(event.salience)) errors.push(`${eventLocation}.salience is invalid`);
    if (!validString(event.summary)) errors.push(`${eventLocation}.summary must be non-empty`);
    if (!exactKeys(event.presentation, ["default_material", "forensic"], [], `${eventLocation}.presentation`, errors)) continue;
    for (const mode of ["default_material", "forensic"]) {
      if (!DISPOSITIONS.has(event.presentation[mode])) errors.push(`${eventLocation}.presentation.${mode} is invalid`);
    }
    if (!Array.isArray(event.facets) || event.facets.length === 0) {
      errors.push(`${eventLocation}.facets must be non-empty`);
      continue;
    }
    const facetChannels = new Set();
    for (const [facetIndex, facet] of event.facets.entries()) {
      const facetLocation = `${eventLocation}.facets[${facetIndex}]`;
      if (!exactKeys(facet, ["channel", "mandatory", "operation", "before", "after"], [], facetLocation, errors)) continue;
      if (!CHANNELS.has(facet.channel)) errors.push(`${facetLocation}.channel is unsupported`);
      if (facetChannels.has(facet.channel)) errors.push(`${facetLocation}.channel duplicates ${facet.channel}`);
      facetChannels.add(facet.channel);
      if (typeof facet.mandatory !== "boolean") errors.push(`${facetLocation}.mandatory must be boolean`);
      if (!OPERATIONS.has(facet.operation)) errors.push(`${facetLocation}.operation is unsupported`);
      if (facet.operation === "added" && facet.before !== null) errors.push(`${facetLocation}.before must be null for added`);
      if (facet.operation === "removed" && facet.after !== null) errors.push(`${facetLocation}.after must be null for removed`);
      if (["modified", "moved"].includes(facet.operation) && (facet.before === null || facet.after === null)) {
        errors.push(`${facetLocation} ${facet.operation} requires before and after`);
      }
      validateAnchor(facet.before, `${facetLocation}.before`, documentById, pair, "before", errors);
      validateAnchor(facet.after, `${facetLocation}.after`, documentById, pair, "after", errors);
      if (facet.mandatory && !pair.required_channels.includes(facet.channel)) {
        errors.push(`${facetLocation}.channel must appear in pair.required_channels`);
      }
      if (facet.mandatory) mandatoryChannels.add(facet.channel);
    }
  }
  if (ROLES.has(pair.role)
    && canonical(pair.required_channels) !== canonical(REQUIRED_BY_ROLE[pair.role])) {
    errors.push(`${location}.required_channels differs from the ${pair.role} v1 contract`);
  }
  if (pair.role !== "identical") {
    for (const channel of pair.required_channels) {
      if (!mandatoryChannels.has(channel) && !(pair.role === "visual_only" && channel === "text")
        && !(pair.role === "layout_noise" && ["semantic", "text"].includes(channel))
        && !(pair.role === "pages_reordered" && channel === "text")
        && !(pair.role === "form_annotation" && channel === "visual")) {
        errors.push(`${location} has no mandatory truth facet for required channel ${channel}`);
      }
    }
  }
  if (pair.role === "material_text" && pair.events.length !== 2) {
    errors.push(`${location}.events must contain the amount and notice truth events`);
  }
  if (pair.role === "material_text") {
    for (const [index, event] of pair.events.entries()) {
      const mandatory = new Set((event.facets ?? []).filter(facet => facet.mandatory).map(facet => facet.channel));
      for (const channel of ["semantic", "text", "visual"]) {
        if (!mandatory.has(channel)) errors.push(`${location}.events[${index}] has no mandatory ${channel} facet`);
      }
    }
  }
  if (["visual_only", "layout_noise", "pages_reordered"].includes(pair.role) && pair.events.length !== 1) {
    errors.push(`${location}.events must contain exactly one ${pair.role} truth event`);
  }
  if (pair.role === "layout_noise" && pair.events.some(event => event.salience !== "noise"
    || event.presentation.default_material !== "suppress")) {
    errors.push(`${location} layout noise must be noise and suppressed in default_material mode`);
  }
  if (pair.role === "metadata_only" && pair.events.some(event => event.presentation.default_material !== "suppress")) {
    errors.push(`${location} metadata-only events must be suppressed in default_material mode`);
  }
}

export function validateComparisonManifest(manifest) {
  const errors = [];
  if (!exactKeys(manifest, [
    "schema_version", "benchmark_id", "benchmark_version", "generator",
    "normalization_profile", "canonical_renderer", "documents", "pairs",
  ], [], "manifest", errors)) return errors;
  if (manifest.schema_version !== COMPARISON_SCHEMA_VERSION) errors.push("manifest.schema_version must equal 1");
  if (manifest.benchmark_id !== COMPARISON_BENCHMARK_ID) errors.push(`manifest.benchmark_id must equal ${COMPARISON_BENCHMARK_ID}`);
  if (!VERSION.test(manifest.benchmark_version ?? "")) errors.push("manifest.benchmark_version must use vMAJOR.MINOR.PATCH");
  if (manifest.generator !== "scripts/eval-generate-comparison-fixtures.mjs") errors.push("manifest.generator is invalid");
  if (canonical(manifest.normalization_profile) !== canonical(EXPECTED_NORMALIZATION)) {
    errors.push("manifest.normalization_profile differs from canonical v1");
  }
  if (canonical(manifest.canonical_renderer) !== canonical(EXPECTED_RENDERER)) {
    errors.push("manifest.canonical_renderer differs from canonical v1");
  }
  if (!Array.isArray(manifest.documents) || manifest.documents.length !== 7) {
    errors.push("manifest.documents must contain exactly seven synthetic documents");
    return errors;
  }
  const documentById = new Map();
  for (const [index, document] of manifest.documents.entries()) {
    validateDocument(document, `manifest.documents[${index}]`, errors);
    if (documentById.has(document?.id)) errors.push(`manifest.documents[${index}].id is duplicated`);
    if (validString(document?.id)) documentById.set(document.id, document);
  }
  if (!Array.isArray(manifest.pairs) || manifest.pairs.length !== COMPARISON_ROLES.length) {
    errors.push("manifest.pairs must contain exactly the seven v1 roles");
    return errors;
  }
  const truthIds = new Set();
  const pairIds = new Set();
  const roleCounts = new Map(COMPARISON_ROLES.map(role => [role, 0]));
  for (const [index, pair] of manifest.pairs.entries()) {
    validatePair(pair, `manifest.pairs[${index}]`, documentById, truthIds, errors);
    if (pairIds.has(pair?.id)) errors.push(`manifest.pairs[${index}].id is duplicated`);
    if (validString(pair?.id)) pairIds.add(pair.id);
    if (ROLES.has(pair?.role)) roleCounts.set(pair.role, roleCounts.get(pair.role) + 1);
  }
  for (const [role, count] of roleCounts) {
    if (count !== 1) errors.push(`manifest must contain exactly one ${role} pair`);
  }
  if (!manifest.pairs.some(pair => pair.partition === "development")
    || !manifest.pairs.some(pair => pair.partition === "held_out_release")) {
    errors.push("manifest must include development and held_out_release partitions");
  }
  const identical = manifest.pairs.find(pair => pair.role === "identical");
  if (identical && (identical.before_document_id !== identical.after_document_id
    || !Array.isArray(identical.events) || identical.events.length !== 0)) {
    errors.push("identical pair must bind the same document and contain no events");
  }
  const formAnnotation = manifest.pairs.find(pair => pair.role === "form_annotation");
  if (formAnnotation && Array.isArray(formAnnotation.events)) {
    const eventChannelSets = formAnnotation.events.map(event => new Set(event.facets.map(facet => facet.channel)));
    if (!eventChannelSets.some(channels => channels.has("form_field") && !channels.has("annotation"))
      || !eventChannelSets.some(channels => channels.has("annotation") && !channels.has("form_field"))) {
      errors.push("form_annotation must contain separate field and annotation truth events");
    }
  }
  return errors;
}

export function resolveComparisonDocumentPath(manifestPath, document) {
  const root = path.dirname(path.resolve(manifestPath));
  const resolved = path.resolve(root, document.path);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Document path escapes manifest root: ${document.path}`);
  return resolved;
}

export async function loadComparisonManifest(manifestPath) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const errors = validateComparisonManifest(manifest);
  if (errors.length) throw new Error(`Invalid comparison manifest:\n- ${errors.join("\n- ")}`);
  return manifest;
}

export async function verifyComparisonDocuments(manifestPath, manifest) {
  const results = [];
  for (const document of manifest.documents) {
    const filename = resolveComparisonDocumentPath(manifestPath, document);
    const bytes = await fs.readFile(filename);
    const actual = createHash("sha256").update(bytes).digest("hex");
    results.push({ id: document.id, path: filename, expected: document.sha256, actual, passed: actual === document.sha256 });
  }
  return results;
}
