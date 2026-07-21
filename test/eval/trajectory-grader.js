import fs from "node:fs/promises";
import fsSync from "node:fs";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getPageRenderScale,
  getRegionPixelRect,
  validateSigningIntent,
} from "../../server/helpers.js";
import {
  MAX_PNG_BYTES,
  MAX_PNG_DIMENSION,
  MAX_PNG_PIXELS,
  parsePngEvidence,
} from "./png-evidence.js";
import {
  buildTrustedVisualOracle,
  VISUAL_ORACLE_MAX_ASPECT_ERROR,
  VISUAL_ORACLE_MAX_MAE,
  VISUAL_ORACLE_MIN_FOREGROUND_IOU,
} from "./render-visual-oracle.js";

export const TRAJECTORY_SUITE_VERSION = 1;
export const TRAJECTORY_GRADER_VERSION = 4;
export const TRAJECTORY_TRIAL_SET_SCHEMA_VERSION = 1;
export const TRAJECTORY_TRIAL_SCHEMA_VERSION = 1;
export const TRAJECTORY_STEP_SCHEMA_VERSION = 2;

const TRIAL_OUTCOMES = new Set(["completed", "harness_failure"]);
const EVIDENCE_KINDS = new Set(["page", "field", "region", "file"]);
const EFFECT_KEYS = ["created", "modified", "deleted", "external_requests"];
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BEAD_PATTERN = /^pdf-toolkit-mcp-[a-z0-9]+(?:\.[0-9]+)?$/;
const REGRESSION_PATTERN = /^pdf-tools\.regression\.trajectory\.v1\.[a-z0-9.-]+$/;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TRUST_REGISTRY_PATH = path.join(
  REPO_ROOT, "test", "fixtures", "eval", "trajectories", "trust-registry.v1.json"
);
const TRUST_REGISTRY = JSON.parse(fsSync.readFileSync(TRUST_REGISTRY_PATH, "utf8"));
const TOOL_CONTRACT_PATH = path.join(
  REPO_ROOT, "test", "fixtures", "eval", "trajectories", "tool-contracts.v1.json"
);
const TOOL_CONTRACT = JSON.parse(fsSync.readFileSync(TOOL_CONTRACT_PATH, "utf8"));
const TOOL_SCHEMAS = new Map(TOOL_CONTRACT.tools.map(tool => [tool.name, tool.input_schema]));
const CORPUS_MANIFEST_RAW = fsSync.readFileSync(path.join(REPO_ROOT, TRUST_REGISTRY.corpus_manifest.path));
const CORPUS_MANIFEST = JSON.parse(CORPUS_MANIFEST_RAW);
const CORPUS_FIXTURE_IDS = new Set(CORPUS_MANIFEST.fixtures.map(fixture => fixture.id));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function renderObservationReference(render) {
  const payload = Object.fromEntries(Object.entries(render)
    .filter(([key]) => key !== "render_observation_event_id"));
  return `sha256:${sha256(canonicalJson(payload))}`;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value, { nonEmpty = false } = {}) {
  return Array.isArray(value)
    && (!nonEmpty || value.length > 0)
    && value.every(nonEmptyString);
}

function retainedRunEvents(trial) {
  return Array.isArray(trial?.run?.events) ? trial.run.events : [];
}

function unique(values) {
  return new Set(values).size === values.length;
}

function isoTimestamp(value) {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function exactKeys(value, required, optional = []) {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => allowed.has(key));
}

function validateJsonSchema(value, schema, location, errors) {
  if (!isObject(schema)) return;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type].filter(Boolean);
  const typeValid = types.length === 0 || types.some(type => {
    if (type === "object") return isObject(value);
    if (type === "array") return Array.isArray(value);
    if (type === "string") return typeof value === "string";
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    if (type === "integer") return Number.isInteger(value);
    if (type === "boolean") return typeof value === "boolean";
    if (type === "null") return value === null;
    return false;
  });
  if (!typeValid) {
    errors.push(`${location} does not match runtime schema type ${types.join("|")}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(item => canonicalJson(item) === canonicalJson(value))) {
    errors.push(`${location} is not one of the runtime schema enum values`);
  }
  if (isObject(value)) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) errors.push(`${location}.${required} is required by the runtime tool schema`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (isObject(schema.properties?.[key])) {
        validateJsonSchema(child, schema.properties[key], `${location}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${location}.${key} is forbidden by the runtime tool schema`);
      } else if (isObject(schema.additionalProperties)) {
        validateJsonSchema(child, schema.additionalProperties, `${location}.${key}`, errors);
      }
    }
  }
  if (Array.isArray(value) && isObject(schema.items)) {
    value.forEach((item, index) => validateJsonSchema(item, schema.items, `${location}[${index}]`, errors));
  }
}

function addExactKeyError(errors, location, value, required, optional = []) {
  if (!isObject(value)) {
    errors.push(`${location} must be an object`);
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) errors.push(`${location}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${location}.${key} is not allowed`);
  }
  return true;
}

function duplicates(values) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

function containsSubset(actual, expected) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((item, index) => containsSubset(actual[index], item));
  }
  if (isObject(expected)) {
    return isObject(actual) && Object.entries(expected).every(([key, value]) =>
      Object.hasOwn(actual, key) && containsSubset(actual[key], value));
  }
  return Object.is(actual, expected);
}

function validRelativePath(value) {
  if (!nonEmptyString(value) || value.includes("\\") || path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== "." && normalized !== ".." && !normalized.startsWith("../");
}

function pathAllowed(value, prefixes) {
  if (!validRelativePath(value)) return false;
  return prefixes.some(prefix => prefix.endsWith("/") ? value.startsWith(prefix) : value === prefix);
}

function externalRequestAllowed(value, patterns) {
  if (!nonEmptyString(value)) return false;
  return patterns.some(pattern => pattern.endsWith("*")
    ? value.startsWith(pattern.slice(0, -1))
    : value === pattern);
}

function argumentPathValues(value, key = "") {
  if (typeof value === "string"
    && (key.endsWith("path") || key.endsWith("_path") || key.endsWith("_paths") || key === "path")) {
    return [value];
  }
  if (Array.isArray(value)) return value.flatMap(item => argumentPathValues(item, key));
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([childKey, child]) => argumentPathValues(child, childKey));
}

function validateObservedArtifact(value, location, errors) {
  if (!addExactKeyError(errors, location, value, [
    "path", "exists", "sha256", "observer_event_id", "observation_method",
  ])) return;
  if (!validRelativePath(value.path)) errors.push(`${location}.path must be a normalized relative path`);
  if (typeof value.exists !== "boolean") errors.push(`${location}.exists must be boolean`);
  if (!nonEmptyString(value.sha256) || !SHA256_PATTERN.test(value.sha256)) {
    errors.push(`${location}.sha256 must be a lowercase SHA-256 digest`);
  }
  if (!nonEmptyString(value.observer_event_id)) errors.push(`${location}.observer_event_id must be non-empty`);
  if (!new Set(["filesystem_stat_sha256", "synthetic_calibration"]).has(value.observation_method)) {
    errors.push(`${location}.observation_method is unsupported`);
  }
}

function validateSemanticObservations(value, location, errors) {
  if (!addExactKeyError(errors, location, value, [
    "semantic_schema_version", "pages", "fields", "page_plans", "signature_locations",
    "render_regions", "files",
  ])) return;
  if (value.semantic_schema_version !== 2) errors.push(`${location}.semantic_schema_version must equal 2`);
  for (const key of ["pages", "fields", "page_plans", "signature_locations", "render_regions", "files"]) {
    if (!Array.isArray(value[key])) errors.push(`${location}.${key} must be an array`);
  }
  for (const [index, page] of (Array.isArray(value.pages) ? value.pages : []).entries()) {
    const itemLocation = `${location}.pages[${index}]`;
    if (!addExactKeyError(errors, itemLocation, page, ["source", "page", "text_sha256"])) continue;
    if (!validRelativePath(page.source)) errors.push(`${itemLocation}.source must be a relative path`);
    if (!Number.isInteger(page.page) || page.page < 1) errors.push(`${itemLocation}.page must be positive`);
    if (!SHA256_PATTERN.test(page.text_sha256 ?? "")) errors.push(`${itemLocation}.text_sha256 must be SHA-256`);
  }
  for (const [index, field] of (Array.isArray(value.fields) ? value.fields : []).entries()) {
    const itemLocation = `${location}.fields[${index}]`;
    if (!addExactKeyError(errors, itemLocation, field, ["source", "field", "value_sha256"])) continue;
    if (!validRelativePath(field.source)) errors.push(`${itemLocation}.source must be a relative path`);
    if (!nonEmptyString(field.field)) errors.push(`${itemLocation}.field must be non-empty`);
    if (!SHA256_PATTERN.test(field.value_sha256 ?? "")) errors.push(`${itemLocation}.value_sha256 must be SHA-256`);
  }
  for (const [index, plan] of (Array.isArray(value.page_plans) ? value.page_plans : []).entries()) {
    const itemLocation = `${location}.page_plans[${index}]`;
    if (!addExactKeyError(errors, itemLocation, plan, ["source", "output", "page_order", "rotations"])) continue;
    if (!validRelativePath(plan.source) || !validRelativePath(plan.output)) errors.push(`${itemLocation} paths must be relative`);
    if (!Array.isArray(plan.page_order) || !plan.page_order.every(Number.isInteger)) errors.push(`${itemLocation}.page_order must be integers`);
    if (!isObject(plan.rotations)) errors.push(`${itemLocation}.rotations must be an object`);
  }
  for (const [index, region] of (Array.isArray(value.signature_locations) ? value.signature_locations : []).entries()) {
    const itemLocation = `${location}.signature_locations[${index}]`;
    if (!addExactKeyError(errors, itemLocation, region, [
      "source", "page", "x", "y", "width", "height", "label",
    ])) continue;
    if (!validRelativePath(region.source)) errors.push(`${itemLocation}.source must be relative`);
    if (!Number.isInteger(region.page) || region.page < 1) errors.push(`${itemLocation}.page must be positive`);
    for (const key of ["x", "y", "width", "height"]) {
      if (!Number.isFinite(region[key])) errors.push(`${itemLocation}.${key} must be finite`);
    }
    if (region.label !== null && !nonEmptyString(region.label)) errors.push(`${itemLocation}.label must be null or non-empty`);
  }
  for (const [index, render] of (Array.isArray(value.render_regions) ? value.render_regions : []).entries()) {
    const itemLocation = `${location}.render_regions[${index}]`;
    if (!addExactKeyError(errors, itemLocation, render, [
      "source", "source_sha256", "source_observation_event_id", "page", "page_box_points",
      "rotation", "region", "coordinate_space", "image_sha256", "image_byte_length",
      "image_content_index", "render_observation_event_id", "image_transport", "mime_type",
      "server_renderer", "server_rendered_width_px", "server_rendered_height_px", "server_scale",
      "observed_image_width_px", "observed_image_height_px", "max_dimension_px", "visual_oracle",
    ])) continue;
    if (!validRelativePath(render.source)) errors.push(`${itemLocation}.source must be relative`);
    for (const key of ["source_sha256", "image_sha256"]) {
      if (!SHA256_PATTERN.test(render[key] ?? "")) errors.push(`${itemLocation}.${key} must be SHA-256`);
    }
    if (!nonEmptyString(render.source_observation_event_id)) {
      errors.push(`${itemLocation}.source_observation_event_id must be non-empty`);
    }
    if (!nonEmptyString(render.render_observation_event_id)) {
      errors.push(`${itemLocation}.render_observation_event_id must be non-empty`);
    }
    if (!Number.isInteger(render.page) || render.page < 1) errors.push(`${itemLocation}.page must be positive`);
    const validateBox = (box, boxLocation) => {
      if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)
        || box[0] < 0 || box[1] < 0 || box[2] <= 0 || box[3] <= 0) {
        errors.push(`${boxLocation} must be [x, y, positive width, positive height]`);
      }
    };
    validateBox(render.region, `${itemLocation}.region`);
    if (render.page_box_points !== null) validateBox(render.page_box_points, `${itemLocation}.page_box_points`);
    if (render.rotation !== null) errors.push(`${itemLocation}.rotation must be null`);
    if (render.coordinate_space !== "top_left_pdf_points") errors.push(`${itemLocation}.coordinate_space is invalid`);
    for (const key of [
      "image_byte_length", "server_rendered_width_px", "server_rendered_height_px",
      "observed_image_width_px", "observed_image_height_px", "max_dimension_px",
    ]) {
      if (!Number.isInteger(render[key]) || render[key] < 1) errors.push(`${itemLocation}.${key} must be positive`);
    }
    if (Number.isInteger(render.image_byte_length) && render.image_byte_length < 57) {
      errors.push(`${itemLocation}.image_byte_length is too small for a complete PNG`);
    }
    if (Number.isInteger(render.image_byte_length) && render.image_byte_length > MAX_PNG_BYTES) {
      errors.push(`${itemLocation}.image_byte_length exceeds the ${MAX_PNG_BYTES / (1024 * 1024)} MiB ingestion limit`);
    }
    for (const key of [
      "server_rendered_width_px", "server_rendered_height_px",
      "observed_image_width_px", "observed_image_height_px", "max_dimension_px",
    ]) {
      if (Number.isInteger(render[key]) && render[key] > MAX_PNG_DIMENSION) {
        errors.push(`${itemLocation}.${key} exceeds the ${MAX_PNG_DIMENSION} px ingestion limit`);
      }
    }
    if (Number.isInteger(render.observed_image_width_px)
      && Number.isInteger(render.observed_image_height_px)
      && render.observed_image_width_px * render.observed_image_height_px > MAX_PNG_PIXELS) {
      errors.push(`${itemLocation}.observed image exceeds the ${MAX_PNG_PIXELS} pixel ingestion limit`);
    }
    if (render.image_content_index !== 1) {
      errors.push(`${itemLocation}.image_content_index must equal the runtime image block index 1`);
    }
    if (!new Set(["codex_jsonl_host_visible", "synthetic_calibration"]).has(render.image_transport)) {
      errors.push(`${itemLocation}.image_transport is unsupported`);
    }
    if (render.mime_type !== "image/png") errors.push(`${itemLocation}.mime_type must equal image/png`);
    if (!new Set(["native-canvas", "macos-sips", "synthetic-calibration"]).has(render.server_renderer)) {
      errors.push(`${itemLocation}.server_renderer is not an approved pinned runtime or calibration renderer`);
    }
    if (!Number.isFinite(render.server_scale) || render.server_scale <= 0) {
      errors.push(`${itemLocation}.server_scale must be positive`);
    }
    if (addExactKeyError(errors, `${itemLocation}.visual_oracle`, render.visual_oracle, [
      "oracle_schema_version", "fixture_id", "reference_source_sha256", "reference_rgba_sha256",
      "normalized_width_px", "normalized_height_px", "host_normalized_rgba_sha256",
      "reference_normalized_rgba_sha256", "mean_absolute_error", "foreground_iou",
      "aspect_ratio_error", "passed",
    ])) {
      const oracle = render.visual_oracle;
      if (oracle.oracle_schema_version !== 1) {
        errors.push(`${itemLocation}.visual_oracle.oracle_schema_version must equal 1`);
      }
      if (!nonEmptyString(oracle.fixture_id)) errors.push(`${itemLocation}.visual_oracle.fixture_id must be non-empty`);
      for (const key of [
        "reference_source_sha256", "reference_rgba_sha256", "host_normalized_rgba_sha256",
        "reference_normalized_rgba_sha256",
      ]) {
        if (!SHA256_PATTERN.test(oracle[key] ?? "")) errors.push(`${itemLocation}.visual_oracle.${key} must be SHA-256`);
      }
      for (const key of ["normalized_width_px", "normalized_height_px"]) {
        if (!Number.isInteger(oracle[key]) || oracle[key] < 1) errors.push(`${itemLocation}.visual_oracle.${key} must be positive`);
      }
      for (const key of ["mean_absolute_error", "foreground_iou", "aspect_ratio_error"]) {
        if (!Number.isFinite(oracle[key]) || oracle[key] < 0 || oracle[key] > 1) {
          errors.push(`${itemLocation}.visual_oracle.${key} must be in [0, 1]`);
        }
      }
      if (oracle.reference_source_sha256 !== render.source_sha256) {
        errors.push(`${itemLocation}.visual_oracle must bind the observed source digest`);
      }
      const expectedFixture = CORPUS_MANIFEST.fixtures.find(item => item.sha256 === render.source_sha256);
      if (!expectedFixture || oracle.fixture_id !== expectedFixture.id) {
        errors.push(`${itemLocation}.visual_oracle.fixture_id must match the pinned corpus source`);
      }
      if (oracle.passed !== true
        || oracle.mean_absolute_error > VISUAL_ORACLE_MAX_MAE
        || oracle.foreground_iou < VISUAL_ORACLE_MIN_FOREGROUND_IOU
        || oracle.aspect_ratio_error > VISUAL_ORACLE_MAX_ASPECT_ERROR) {
        errors.push(`${itemLocation}.visual_oracle must pass the trusted perceptual thresholds`);
      }
    }
  }
  for (const [index, file] of (Array.isArray(value.files) ? value.files : []).entries()) {
    const itemLocation = `${location}.files[${index}]`;
    if (!addExactKeyError(errors, itemLocation, file, ["path"])) continue;
    if (!validRelativePath(file.path)) errors.push(`${itemLocation}.path must be relative`);
  }
}

function validateEventProvenance(value, location, errors) {
  if (!addExactKeyError(errors, location, value, [
    "provenance_schema_version", "authority", "capture_method", "raw_sha256",
  ])) return;
  if (value.provenance_schema_version !== 1) errors.push(`${location}.provenance_schema_version must equal 1`);
  if (!new Set(["calibration", "agent_host", "filesystem_observer", "ingester"]).has(value.authority)) {
    errors.push(`${location}.authority is unsupported`);
  }
  if (!nonEmptyString(value.capture_method)) errors.push(`${location}.capture_method must be non-empty`);
  if (!SHA256_PATTERN.test(value.raw_sha256 ?? "")) errors.push(`${location}.raw_sha256 must be SHA-256`);
}

function validateRun(value, location, errors) {
  if (!addExactKeyError(errors, location, value, [
    "run_schema_version", "run_id", "started_at", "finished_at", "host", "events",
  ])) return;
  if (value.run_schema_version !== 1) errors.push(`${location}.run_schema_version must equal 1`);
  if (!nonEmptyString(value.run_id)) errors.push(`${location}.run_id must be a non-empty string`);
  if (!isoTimestamp(value.started_at)) errors.push(`${location}.started_at must be ISO-8601`);
  if (!isoTimestamp(value.finished_at)) errors.push(`${location}.finished_at must be ISO-8601`);
  if (isoTimestamp(value.started_at) && isoTimestamp(value.finished_at)
    && Date.parse(value.finished_at) < Date.parse(value.started_at)) {
    errors.push(`${location}.finished_at must not precede started_at`);
  }
  if (addExactKeyError(errors, `${location}.host`, value.host, ["name", "version", "platform"])) {
    for (const key of ["name", "version", "platform"]) {
      if (!nonEmptyString(value.host[key])) errors.push(`${location}.host.${key} must be a non-empty string`);
    }
  }
  if (!Array.isArray(value.events) || value.events.length === 0) {
    errors.push(`${location}.events must contain observed host events`);
    return;
  }
  const eventIds = [];
  const runStart = Date.parse(value.started_at);
  const runEnd = Date.parse(value.finished_at);
  for (const [index, event] of value.events.entries()) {
    const eventLocation = `${location}.events[${index}]`;
    if (!addExactKeyError(errors, eventLocation, event, [
      "event_schema_version", "event_id", "type", "source", "observed_at", "reference", "provenance",
    ])) continue;
    if (event.event_schema_version !== 1) errors.push(`${eventLocation}.event_schema_version must equal 1`);
    for (const key of ["event_id", "type", "source", "reference"]) {
      if (!nonEmptyString(event[key])) errors.push(`${eventLocation}.${key} must be a non-empty string`);
    }
    if (!isoTimestamp(event.observed_at)) errors.push(`${eventLocation}.observed_at must be ISO-8601`);
    validateEventProvenance(event.provenance, `${eventLocation}.provenance`, errors);
    const observedAt = Date.parse(event.observed_at);
    if (Number.isFinite(observedAt) && Number.isFinite(runStart) && observedAt < runStart) {
      errors.push(`${eventLocation}.observed_at precedes the run`);
    }
    if (Number.isFinite(observedAt) && Number.isFinite(runEnd) && observedAt > runEnd) {
      errors.push(`${eventLocation}.observed_at follows the run`);
    }
    eventIds.push(event.event_id);
  }
  for (const duplicate of duplicates(eventIds)) errors.push(`${location} contains duplicate event id ${duplicate}`);
}

function validateSampleEvidence(trial, location, errors) {
  const authority = trial.run?.host?.platform === "synthetic" ? "calibration" : "filesystem_observer";
  const events = Array.isArray(trial.run?.events) ? trial.run.events : [];
  for (const [type, sampleKey] of [
    ["input_snapshot_observed", "input_sha256"],
    ["fixture_instance_observed", "fixture_instance_sha256"],
  ]) {
    const event = events.find(item => item?.type === type
      && item?.reference === `sha256:${trial.sample?.[sampleKey]}`);
    if (!event || event.provenance?.authority !== authority || event.provenance?.capture_method === "self_report") {
      errors.push(`${location}.sample.${sampleKey} must bind to a retained ${type} event from ${authority}`);
    }
  }
}

function validateStep(step, location, errors) {
  if (!addExactKeyError(errors, location, step, [
    "step_schema_version", "step_id", "tool", "started_at", "finished_at", "arguments", "ok",
  ], ["result", "error", "recovery_of_step_id"])) return;
  if (step.step_schema_version !== TRAJECTORY_STEP_SCHEMA_VERSION) {
    errors.push(`${location}.step_schema_version must equal ${TRAJECTORY_STEP_SCHEMA_VERSION}`);
  }
  if (!nonEmptyString(step.step_id)) errors.push(`${location}.step_id must be a non-empty string`);
  if (!nonEmptyString(step.tool)) errors.push(`${location}.tool must be a non-empty string`);
  if (!isoTimestamp(step.started_at)) errors.push(`${location}.started_at must be ISO-8601`);
  if (!isoTimestamp(step.finished_at)) errors.push(`${location}.finished_at must be ISO-8601`);
  if (isoTimestamp(step.started_at) && isoTimestamp(step.finished_at)
    && Date.parse(step.finished_at) < Date.parse(step.started_at)) {
    errors.push(`${location}.finished_at must not precede started_at`);
  }
  if (!isObject(step.arguments)) errors.push(`${location}.arguments must be an object`);
  if (typeof step.ok !== "boolean") errors.push(`${location}.ok must be boolean`);
  if (Object.hasOwn(step, "recovery_of_step_id") && !nonEmptyString(step.recovery_of_step_id)) {
    errors.push(`${location}.recovery_of_step_id must be a non-empty string`);
  }

  if (step.ok === true) {
    if (Object.hasOwn(step, "error")) errors.push(`${location}.error is forbidden when ok is true`);
    if (!addExactKeyError(errors, `${location}.result`, step.result, [
      "result_schema_version", "result_id", "raw_result_sha256", "observed_sources", "observed_artifacts",
      "semantic_observations",
    ], ["retained_raw_result"])) return;
    if (step.result.result_schema_version !== 1) errors.push(`${location}.result.result_schema_version must equal 1`);
    if (!nonEmptyString(step.result.result_id)) errors.push(`${location}.result.result_id must be a non-empty string`);
    if (!nonEmptyString(step.result.raw_result_sha256) || !SHA256_PATTERN.test(step.result.raw_result_sha256)) {
      errors.push(`${location}.result.raw_result_sha256 must bind the retained raw tool result`);
    }
    if (!stringArray(step.result.observed_sources)) {
      errors.push(`${location}.result.observed_sources must be a string array`);
    } else {
      if (!unique(step.result.observed_sources)) errors.push(`${location}.result.observed_sources must be unique`);
      for (const source of step.result.observed_sources) {
        if (!validRelativePath(source)) errors.push(`${location}.result.observed_sources contains invalid path ${source}`);
      }
    }
    if (!Array.isArray(step.result.observed_artifacts)) {
      errors.push(`${location}.result.observed_artifacts must be an array`);
    } else {
      step.result.observed_artifacts.forEach((artifact, index) =>
        validateObservedArtifact(artifact, `${location}.result.observed_artifacts[${index}]`, errors));
    }
    validateSemanticObservations(step.result.semantic_observations, `${location}.result.semantic_observations`, errors);
    const isRenderTool = new Set(["render_pdf_page", "render_pdf_region"]).has(step.tool);
    if (isRenderTool && !isObject(step.result.retained_raw_result)) {
      errors.push(`${location}.result.retained_raw_result is required for render tools`);
    }
    if (!isRenderTool && Object.hasOwn(step.result, "retained_raw_result")) {
      errors.push(`${location}.result.retained_raw_result is allowed only for render tools`);
    }
  } else if (step.ok === false) {
    if (Object.hasOwn(step, "result")) errors.push(`${location}.result is forbidden when ok is false`);
    if (Object.hasOwn(step, "recovery_of_step_id")) {
      errors.push(`${location}.recovery_of_step_id is allowed only on a successful recovery call`);
    }
    if (!addExactKeyError(errors, `${location}.error`, step.error, [
      "error_schema_version", "code", "message", "expected", "raw_error_sha256",
    ])) return;
    if (step.error.error_schema_version !== 1) errors.push(`${location}.error.error_schema_version must equal 1`);
    if (!nonEmptyString(step.error.code)) errors.push(`${location}.error.code must be a non-empty string`);
    if (!nonEmptyString(step.error.message)) errors.push(`${location}.error.message must be a non-empty string`);
    if (typeof step.error.expected !== "boolean") errors.push(`${location}.error.expected must be boolean`);
    if (!SHA256_PATTERN.test(step.error.raw_error_sha256 ?? "")) {
      errors.push(`${location}.error.raw_error_sha256 must bind the retained raw MCP failure`);
    }
  }
  const runtimeSchema = TOOL_SCHEMAS.get(step.tool);
  if (!runtimeSchema) errors.push(`${location}.tool is absent from the pinned runtime contract`);
  else validateJsonSchema(step.arguments, runtimeSchema, `${location}.arguments`, errors);
}

function validateEffects(value, location, errors) {
  if (!addExactKeyError(errors, location, value, [
    "effects_schema_version", "observer_event_id", ...EFFECT_KEYS, "signature_applied",
  ])) return;
  if (value.effects_schema_version !== 1) errors.push(`${location}.effects_schema_version must equal 1`);
  if (!nonEmptyString(value.observer_event_id)) errors.push(`${location}.observer_event_id must be non-empty`);
  for (const key of EFFECT_KEYS) {
    if (!stringArray(value[key])) {
      errors.push(`${location}.${key} must be a string array`);
      continue;
    }
    if (!unique(value[key])) errors.push(`${location}.${key} must be unique`);
    for (const item of value[key]) {
      if (key === "external_requests") {
        if (!nonEmptyString(item)) errors.push(`${location}.${key} contains an empty request identifier`);
      } else if (!validRelativePath(item)) {
        errors.push(`${location}.${key} contains invalid path ${item}`);
      }
    }
  }
  if (typeof value.signature_applied !== "boolean") errors.push(`${location}.signature_applied must be boolean`);
}

function validateArtifact(value, location, errors) {
  if (!addExactKeyError(errors, location, value, [
    "artifact_schema_version", "path", "producer_step_id", "verification_step_id", "observation_event_id",
    "exists", "sha256",
  ])) return;
  if (value.artifact_schema_version !== 1) errors.push(`${location}.artifact_schema_version must equal 1`);
  if (!validRelativePath(value.path)) errors.push(`${location}.path must be a normalized relative path`);
  for (const key of ["producer_step_id", "verification_step_id"]) {
    if (!nonEmptyString(value[key])) errors.push(`${location}.${key} must be a non-empty string`);
  }
  if (!nonEmptyString(value.observation_event_id)) errors.push(`${location}.observation_event_id must be non-empty`);
  if (value.exists !== true) errors.push(`${location}.exists must be true for a retained output artifact`);
  if (!nonEmptyString(value.sha256) || !SHA256_PATTERN.test(value.sha256)) {
    errors.push(`${location}.sha256 must be a lowercase SHA-256 digest`);
  }
}

function validateEvidence(value, location, errors) {
  const base = ["evidence_schema_version", "id", "kind", "source", "result_id"];
  const kindKeys = {
    page: ["page"], field: ["field", "value_sha256"], region: ["page", "region"], file: [],
  };
  const optional = EVIDENCE_KINDS.has(value?.kind) ? kindKeys[value.kind] : ["page", "field", "region"];
  if (!addExactKeyError(errors, location, value, base, optional)) return;
  if (value.evidence_schema_version !== 1) errors.push(`${location}.evidence_schema_version must equal 1`);
  for (const key of ["id", "kind", "result_id"]) {
    if (!nonEmptyString(value[key])) errors.push(`${location}.${key} must be a non-empty string`);
  }
  if (!validRelativePath(value.source)) errors.push(`${location}.source must be a normalized relative path`);
  if (!EVIDENCE_KINDS.has(value.kind)) errors.push(`${location}.kind is unsupported`);
  if ((value.kind === "page" || value.kind === "region")
    && (!Number.isInteger(value.page) || value.page < 1)) {
    errors.push(`${location}.page must be a positive integer`);
  }
  if (value.kind === "field" && !nonEmptyString(value.field)) errors.push(`${location}.field must be non-empty`);
  if (value.kind === "field" && !SHA256_PATTERN.test(value.value_sha256 ?? "")) {
    errors.push(`${location}.value_sha256 must bind the observed field value`);
  }
  if (value.kind === "region" && (!Array.isArray(value.region) || value.region.length !== 4
    || !value.region.every(Number.isFinite) || value.region[2] <= 0 || value.region[3] <= 0)) {
    errors.push(`${location}.region must be [x, y, positive width, positive height]`);
  }
}

function validateCorrectionRef(value, location, errors, jobId) {
  if (!addExactKeyError(errors, location, value, ["bead_id", "regression_id", "relationship"])) return;
  if (!BEAD_PATTERN.test(value.bead_id ?? "")) errors.push(`${location}.bead_id must be a canonical Bead id`);
  if (!REGRESSION_PATTERN.test(value.regression_id ?? "")) {
    errors.push(`${location}.regression_id must be a canonical trajectory regression id`);
  }
  if (!new Set(["failure", "accepted_fix"]).has(value.relationship)) {
    errors.push(`${location}.relationship must be failure or accepted_fix`);
  }
  const approved = TRUST_REGISTRY.approved_lineage[jobId];
  if (value.bead_id !== approved?.bead_id) {
    errors.push(`${location}.bead_id is not in the approved lineage registry`);
  }
  const regression = approved?.regressions?.[value.regression_id];
  if (!regression) {
    errors.push(`${location}.regression_id is not in the approved lineage registry`);
  } else if (!regression.relationships?.includes(value.relationship)) {
    errors.push(`${location}.relationship is not approved for this regression`);
  }
}

function approvedCorrectionRef(value, jobId, failedCheckId = null) {
  const approved = TRUST_REGISTRY.approved_lineage[jobId];
  const regression = approved?.regressions?.[value?.regression_id];
  return isObject(value)
    && value.bead_id === approved?.bead_id
    && isObject(regression)
    && regression.relationships?.includes(value.relationship)
    && (failedCheckId === null || regression.failure_checks?.includes(failedCheckId));
}

function validateCompletedTrial(job, trial, location, errors) {
  if (!Array.isArray(trial.trajectory)) {
    errors.push(`${location}.trajectory must be an array`);
  } else {
    trial.trajectory.forEach((step, index) => validateStep(step, `${location}.trajectory[${index}]`, errors));
    const stepIds = trial.trajectory.map(step => step?.step_id).filter(nonEmptyString);
    const resultIds = trial.trajectory.map(step => step?.result?.result_id).filter(nonEmptyString);
    for (const duplicate of duplicates(stepIds)) errors.push(`${location}.trajectory contains duplicate step id ${duplicate}`);
    for (const duplicate of duplicates(resultIds)) errors.push(`${location}.trajectory contains duplicate result id ${duplicate}`);
    let previous = -Infinity;
    for (const [index, step] of trial.trajectory.entries()) {
      const timestamp = Date.parse(step?.started_at);
      if (Number.isFinite(timestamp) && timestamp < previous) {
        errors.push(`${location}.trajectory[${index}].started_at is out of order`);
      }
      if (Number.isFinite(timestamp)) previous = timestamp;
      if (step?.ok === true && Array.isArray(step.result?.observed_sources)) {
        const argumentSources = new Set(argumentPathValues(step.arguments));
        for (const source of step.result.observed_sources) {
          if (!argumentSources.has(source)) {
            errors.push(`${location}.trajectory[${index}].result.observed_sources contains ${source} not bound to a path argument`);
          }
        }
      }
    }
  }
  validateEffects(trial.effects, `${location}.effects`, errors);
  if (!Array.isArray(trial.artifacts)) {
    errors.push(`${location}.artifacts must be an array`);
  } else {
    trial.artifacts.forEach((artifact, index) => validateArtifact(artifact, `${location}.artifacts[${index}]`, errors));
    for (const duplicate of duplicates(trial.artifacts.map(artifact => artifact?.path).filter(nonEmptyString))) {
      errors.push(`${location}.artifacts contains duplicate path ${duplicate}`);
    }
  }
  if (addExactKeyError(errors, `${location}.final_answer`, trial.final_answer, [
    "answer_schema_version", "present", "raw_message_sha256", "message_event_id", "turn_completed_event_id",
    "evidence", "claims", "limitations", "answer_value_sha256",
  ])) {
    if (trial.final_answer.answer_schema_version !== 1) {
      errors.push(`${location}.final_answer.answer_schema_version must equal 1`);
    }
    if (typeof trial.final_answer.present !== "boolean") {
      errors.push(`${location}.final_answer.present must be boolean`);
    }
    if (trial.final_answer.present === true && (!nonEmptyString(trial.final_answer.raw_message_sha256)
      || !SHA256_PATTERN.test(trial.final_answer.raw_message_sha256))) {
      errors.push(`${location}.final_answer.raw_message_sha256 must bind the retained raw agent answer when present`);
    }
    if (trial.final_answer.present === false && trial.final_answer.raw_message_sha256 !== null) {
      errors.push(`${location}.final_answer.raw_message_sha256 must be null when no terminal answer was observed`);
    }
    for (const key of ["message_event_id", "turn_completed_event_id"]) {
      if (trial.final_answer.present === true && !nonEmptyString(trial.final_answer[key])) {
        errors.push(`${location}.final_answer.${key} must bind terminal host events`);
      }
      if (trial.final_answer.present === false && trial.final_answer[key] !== null) {
        errors.push(`${location}.final_answer.${key} must be null without an answer`);
      }
    }
    if (!Array.isArray(trial.final_answer.evidence)) {
      errors.push(`${location}.final_answer.evidence must be an array`);
    } else {
      trial.final_answer.evidence.forEach((item, index) =>
        validateEvidence(item, `${location}.final_answer.evidence[${index}]`, errors));
    }
    if (!Array.isArray(trial.final_answer.claims)) {
      errors.push(`${location}.final_answer.claims must be an array`);
    } else {
      for (const [index, claim] of trial.final_answer.claims.entries()) {
        const claimLocation = `${location}.final_answer.claims[${index}]`;
        if (!addExactKeyError(errors, claimLocation, claim, [
          "claim_schema_version", "id", "important", "evidence_ids",
        ])) continue;
        if (claim.claim_schema_version !== 1) errors.push(`${claimLocation}.claim_schema_version must equal 1`);
        if (!nonEmptyString(claim.id)) errors.push(`${claimLocation}.id must be non-empty`);
        if (typeof claim.important !== "boolean") errors.push(`${claimLocation}.important must be boolean`);
        if (!stringArray(claim.evidence_ids)) errors.push(`${claimLocation}.evidence_ids must be a string array`);
      }
    }
    if (!stringArray(trial.final_answer.limitations)) {
      errors.push(`${location}.final_answer.limitations must be a string array`);
    }
    if (trial.final_answer.present === true && !SHA256_PATTERN.test(trial.final_answer.answer_value_sha256 ?? "")) {
      errors.push(`${location}.final_answer.answer_value_sha256 must bind the parsed JSON answer`);
    }
    if (trial.final_answer.present === false && trial.final_answer.answer_value_sha256 !== null) {
      errors.push(`${location}.final_answer.answer_value_sha256 must be null without an answer`);
    }
  }
  if (!Array.isArray(trial.correction_refs)) {
    errors.push(`${location}.correction_refs must be an array`);
  } else {
    trial.correction_refs.forEach((item, index) =>
      validateCorrectionRef(item, `${location}.correction_refs[${index}]`, errors, trial.job_id));
  }
  if (Object.hasOwn(trial, "intent")) {
    if (addExactKeyError(errors, `${location}.intent`, trial.intent, [
      "intent_schema_version", "source", "statement", "confirmed_at", "host_event_id",
    ])) {
      if (trial.intent.intent_schema_version !== 1) errors.push(`${location}.intent.intent_schema_version must equal 1`);
      for (const key of ["source", "statement", "confirmed_at", "host_event_id"]) {
        if (!nonEmptyString(trial.intent[key])) errors.push(`${location}.intent.${key} must be non-empty`);
      }
    }
  }

  const runEvents = retainedRunEvents(trial);
  const eventIds = new Set(runEvents.map(event => event?.event_id));
  if (isObject(trial.effects) && !eventIds.has(trial.effects.observer_event_id)) {
    errors.push(`${location}.effects.observer_event_id must reference a retained run event`);
  }
  for (const [index, artifact] of (Array.isArray(trial.artifacts) ? trial.artifacts : []).entries()) {
    if (!eventIds.has(artifact?.observation_event_id)) {
      errors.push(`${location}.artifacts[${index}].observation_event_id must reference a retained run event`);
    }
  }
  const runStart = Date.parse(trial.run?.started_at);
  const runEnd = Date.parse(trial.run?.finished_at);
  for (const [index, step] of (Array.isArray(trial.trajectory) ? trial.trajectory : []).entries()) {
    const startedAt = Date.parse(step?.started_at);
    const finishedAt = Date.parse(step?.finished_at);
    if (Number.isFinite(startedAt) && Number.isFinite(runStart) && startedAt < runStart) {
      errors.push(`${location}.trajectory[${index}] precedes the run`);
    }
    if (Number.isFinite(finishedAt) && Number.isFinite(runEnd) && finishedAt > runEnd) {
      errors.push(`${location}.trajectory[${index}] follows the run`);
    }
  }
  if (job && trial.job_id !== job.id) errors.push(`${location}.job_id must equal ${job.id}`);
}

export function validateTrajectoryTrial(job, trial, location = "trial") {
  const errors = [];
  const completedRequired = [
    "trial_schema_version", "trial_id", "job_id", "repeat_index", "agent", "model", "outcome", "run",
    "sample", "trajectory", "effects", "artifacts", "final_answer", "correction_refs",
  ];
  const harnessRequired = [
    "trial_schema_version", "trial_id", "job_id", "repeat_index", "agent", "model", "outcome", "run",
    "sample", "harness_failure",
  ];
  const outcome = trial?.outcome;
  const required = outcome === "harness_failure" ? harnessRequired : completedRequired;
  const optional = outcome === "completed" ? ["intent"] : [];
  if (!addExactKeyError(errors, location, trial, required, optional)) return errors;
  if (trial.trial_schema_version !== TRAJECTORY_TRIAL_SCHEMA_VERSION) {
    errors.push(`${location}.trial_schema_version must equal ${TRAJECTORY_TRIAL_SCHEMA_VERSION}`);
  }
  for (const key of ["trial_id", "job_id", "agent", "model"]) {
    if (!nonEmptyString(trial[key])) errors.push(`${location}.${key} must be a non-empty string`);
  }
  if (!Number.isInteger(trial.repeat_index) || trial.repeat_index < 1) {
    errors.push(`${location}.repeat_index must be a positive integer`);
  }
  if (!TRIAL_OUTCOMES.has(trial.outcome)) errors.push(`${location}.outcome is unsupported`);
  validateRun(trial.run, `${location}.run`, errors);
  if (addExactKeyError(errors, `${location}.sample`, trial.sample, [
    "sample_schema_version", "input_sha256", "fixture_instance_sha256", "semantic_operation_sha256",
    "seed", "invocation_id", "transcript_sha256",
  ])) {
    if (trial.sample.sample_schema_version !== 1) errors.push(`${location}.sample.sample_schema_version must equal 1`);
    for (const key of ["input_sha256", "fixture_instance_sha256", "semantic_operation_sha256", "transcript_sha256"]) {
      if (!SHA256_PATTERN.test(trial.sample[key] ?? "")) errors.push(`${location}.sample.${key} must be SHA-256`);
    }
    for (const key of ["seed", "invocation_id"]) {
      if (!nonEmptyString(trial.sample[key])) errors.push(`${location}.sample.${key} must be non-empty`);
    }
  }
  validateSampleEvidence(trial, location, errors);
  if (trial.outcome === "completed") {
    validateCompletedTrial(job, trial, location, errors);
  } else if (trial.outcome === "harness_failure") {
    if (addExactKeyError(errors, `${location}.harness_failure`, trial.harness_failure, [
      "harness_schema_version", "code", "phase", "detail", "event_id",
    ])) {
      if (trial.harness_failure.harness_schema_version !== 1) {
        errors.push(`${location}.harness_failure.harness_schema_version must equal 1`);
      }
      for (const key of ["code", "phase", "detail", "event_id"]) {
        if (!nonEmptyString(trial.harness_failure[key])) {
          errors.push(`${location}.harness_failure.${key} must be a non-empty string`);
        }
      }
      const event = retainedRunEvents(trial).find(item => item?.event_id === trial.harness_failure.event_id);
      if (!event || event.type !== "harness_failure") {
        errors.push(`${location}.harness_failure.event_id must bind to a harness_failure run event`);
      }
    }
  }
  return errors;
}

export function validateTrajectorySuite(suite) {
  const errors = [];
  if (!addExactKeyError(errors, "suite", suite, [
    "suite_version", "suite_id", "description", "measurement_policy", "jobs",
  ])) return errors;
  if (suite.suite_version !== TRAJECTORY_SUITE_VERSION) {
    errors.push(`suite.suite_version must equal ${TRAJECTORY_SUITE_VERSION}`);
  }
  if (!nonEmptyString(suite.suite_id)) errors.push("suite.suite_id must be a non-empty string");
  if (!nonEmptyString(suite.description)) errors.push("suite.description must be a non-empty string");
  const suiteApproval = TRUST_REGISTRY.approved_suites[suite.suite_id];
  if (sha256(canonicalJson(suite)) !== suiteApproval?.suite_sha256) {
    errors.push("suite content does not match the version-pinned approved suite digest");
  }
  const corpusDigest = sha256(CORPUS_MANIFEST_RAW);
  if (corpusDigest !== TRUST_REGISTRY.corpus_manifest.sha256) {
    errors.push("approved corpus manifest digest does not match the versioned trust registry");
  }
  if (addExactKeyError(errors, "suite.measurement_policy", suite.measurement_policy, [
    "min_unique_product_trials_per_job", "confidence_level", "max_harness_failure_rate",
    "trust_registry_id", "corpus_manifest_sha256", "tool_contract_id", "tool_contract_sha256",
    "runtime_version",
  ])) {
    if (!Number.isInteger(suite.measurement_policy.min_unique_product_trials_per_job)
      || suite.measurement_policy.min_unique_product_trials_per_job < 1) {
      errors.push("suite.measurement_policy.min_unique_product_trials_per_job must be positive");
    }
    if (suite.measurement_policy.confidence_level !== 0.95) {
      errors.push("suite.measurement_policy.confidence_level must equal 0.95");
    }
    if (!Number.isFinite(suite.measurement_policy.max_harness_failure_rate)
      || suite.measurement_policy.max_harness_failure_rate < 0
      || suite.measurement_policy.max_harness_failure_rate >= 1) {
      errors.push("suite.measurement_policy.max_harness_failure_rate must be in [0, 1)");
    }
    if (suite.measurement_policy.trust_registry_id !== TRUST_REGISTRY.registry_id) {
      errors.push(`suite.measurement_policy.trust_registry_id must equal ${TRUST_REGISTRY.registry_id}`);
    }
    if (suite.measurement_policy.corpus_manifest_sha256 !== TRUST_REGISTRY.corpus_manifest.sha256) {
      errors.push("suite.measurement_policy.corpus_manifest_sha256 is not approved");
    }
    if (suite.measurement_policy.tool_contract_id !== TOOL_CONTRACT.contract_id) {
      errors.push("suite.measurement_policy.tool_contract_id is not the captured runtime contract");
    }
    if (suite.measurement_policy.tool_contract_sha256 !== TOOL_CONTRACT.tools_sha256
      || TOOL_CONTRACT.tools_sha256 !== sha256(canonicalJson(TOOL_CONTRACT.tools))) {
      errors.push("suite.measurement_policy.tool_contract_sha256 does not bind the captured runtime schemas");
    }
    if (suite.measurement_policy.runtime_version !== TOOL_CONTRACT.runtime.version) {
      errors.push("suite.measurement_policy.runtime_version does not match the captured runtime");
    }
  }
  if (!Array.isArray(suite.jobs) || suite.jobs.length < 6) {
    errors.push("suite.jobs must contain at least six jobs");
    return errors;
  }
  for (const duplicate of duplicates(suite.jobs.map(job => job?.id).filter(nonEmptyString))) {
    errors.push(`duplicate job id ${duplicate}`);
  }

  for (const [index, job] of suite.jobs.entries()) {
    const location = `suite.jobs[${index}]`;
    if (!addExactKeyError(errors, location, job, [
      "id", "title", "category", "user_job", "prompt", "starting_state", "policy", "expected_semantics",
      "success_evidence",
    ])) continue;
    for (const key of ["id", "title", "category", "user_job", "prompt"]) {
      if (!nonEmptyString(job[key])) errors.push(`${location}.${key} must be a non-empty string`);
    }
    const approval = TRUST_REGISTRY.approved_suites[suite.suite_id];
    if (!approval?.categories.includes(job.category)) errors.push(`${location}.category is not approved by the trust registry`);
    if (addExactKeyError(errors, `${location}.starting_state`, job.starting_state, [
      "fixtures", "sources", "active_document",
    ])) {
      if (!stringArray(job.starting_state.fixtures, { nonEmpty: true })) {
        errors.push(`${location}.starting_state.fixtures must be a non-empty string array`);
      }
      for (const fixture of job.starting_state.fixtures ?? []) {
        if (!approval?.fixture_ids.includes(fixture)) errors.push(`${location} fixture ${fixture} is not approved by the trust registry`);
        if (!CORPUS_FIXTURE_IDS.has(fixture)) errors.push(`${location} fixture ${fixture} is not present in the approved corpus manifest`);
      }
      if (!stringArray(job.starting_state.sources, { nonEmpty: true })
        || !job.starting_state.sources.every(validRelativePath)) {
        errors.push(`${location}.starting_state.sources must contain normalized relative paths`);
      }
      if (job.starting_state.active_document !== null
        && !job.starting_state.sources?.includes(job.starting_state.active_document)) {
        errors.push(`${location}.starting_state.active_document must be null or a declared source`);
      }
    }
    const policy = job.policy;
    const policyRequired = [
      "allowed_tools", "forbidden_tools", "inspection_tools", "mutating_tools", "required_tool_groups",
      "require_inspection_before_mutation", "allowed_effects",
    ];
    if (!addExactKeyError(errors, `${location}.policy`, policy, policyRequired, ["error_recovery"])) continue;
    for (const key of ["allowed_tools", "forbidden_tools", "inspection_tools", "mutating_tools"]) {
      if (!stringArray(policy[key])) errors.push(`${location}.policy.${key} must be a string array`);
      else if (!unique(policy[key])) errors.push(`${location}.policy.${key} must be unique`);
    }
    const allowed = new Set(policy.allowed_tools ?? []);
    const forbidden = new Set(policy.forbidden_tools ?? []);
    for (const tool of allowed) {
      if (forbidden.has(tool)) errors.push(`${location} lists ${tool} as both allowed and forbidden`);
      if (!TOOL_SCHEMAS.has(tool)) errors.push(`${location} allowed tool ${tool} is absent from the runtime contract`);
    }
    for (const tool of forbidden) {
      if (!TOOL_SCHEMAS.has(tool)) errors.push(`${location} forbidden tool ${tool} is absent from the runtime contract`);
    }
    for (const tool of [...(policy.inspection_tools ?? []), ...(policy.mutating_tools ?? [])]) {
      if (!allowed.has(tool)) errors.push(`${location} policy tool ${tool} is not allowed`);
    }
    if (!Array.isArray(policy.required_tool_groups) || policy.required_tool_groups.length === 0) {
      errors.push(`${location}.policy.required_tool_groups must be non-empty`);
    } else {
      for (const [groupIndex, group] of policy.required_tool_groups.entries()) {
        const groupLocation = `${location}.policy.required_tool_groups[${groupIndex}]`;
        if (!addExactKeyError(errors, groupLocation, group, [
          "id", "any_of", "min_successful_calls", "required_argument_keys",
        ])) continue;
        if (!nonEmptyString(group.id)) errors.push(`${groupLocation}.id must be non-empty`);
        if (!stringArray(group.any_of, { nonEmpty: true })) errors.push(`${groupLocation}.any_of must contain tools`);
        if (!Number.isInteger(group.min_successful_calls) || group.min_successful_calls < 1) {
          errors.push(`${groupLocation}.min_successful_calls must be positive`);
        }
        if (!stringArray(group.required_argument_keys, { nonEmpty: true })) {
          errors.push(`${groupLocation}.required_argument_keys must be non-empty`);
        }
        for (const tool of group.any_of ?? []) {
          if (!allowed.has(tool)) errors.push(`${groupLocation} requires non-allowed tool ${tool}`);
          const schemaProperties = TOOL_SCHEMAS.get(tool)?.properties ?? {};
          for (const key of group.required_argument_keys ?? []) {
            if (!Object.hasOwn(schemaProperties, key)) {
              errors.push(`${groupLocation} argument ${key} is absent from runtime schema for ${tool}`);
            }
          }
        }
      }
    }
    if (addExactKeyError(errors, `${location}.expected_semantics`, job.expected_semantics, [
      "required_calls", "required_observations", "expected_answer",
    ])) {
      if (!Array.isArray(job.expected_semantics.required_calls) || job.expected_semantics.required_calls.length === 0) {
        errors.push(`${location}.expected_semantics.required_calls must be non-empty`);
      } else {
        for (const [callIndex, call] of job.expected_semantics.required_calls.entries()) {
          const callLocation = `${location}.expected_semantics.required_calls[${callIndex}]`;
          if (!addExactKeyError(errors, callLocation, call, ["id", "tool", "arguments"])) continue;
          if (!nonEmptyString(call.id)) errors.push(`${callLocation}.id must be non-empty`);
          if (!allowed.has(call.tool)) errors.push(`${callLocation}.tool must be allowed`);
          const schema = TOOL_SCHEMAS.get(call.tool);
          if (!schema) errors.push(`${callLocation}.tool is absent from runtime contract`);
          else validateJsonSchema(call.arguments, schema, `${callLocation}.arguments`, errors);
        }
      }
      if (!Array.isArray(job.expected_semantics.required_observations)) {
        errors.push(`${location}.expected_semantics.required_observations must be an array`);
      } else {
        for (const [observationIndex, observation] of job.expected_semantics.required_observations.entries()) {
          const observationLocation = `${location}.expected_semantics.required_observations[${observationIndex}]`;
          if (!addExactKeyError(errors, observationLocation, observation, ["id", "tool", "collection", "value"])) continue;
          if (!nonEmptyString(observation.id)) errors.push(`${observationLocation}.id must be non-empty`);
          if (!allowed.has(observation.tool)) errors.push(`${observationLocation}.tool must be allowed`);
          if (!new Set(["pages", "fields", "page_plans", "signature_locations", "render_regions", "files"]).has(observation.collection)) {
            errors.push(`${observationLocation}.collection is unsupported`);
          }
          if (!isObject(observation.value)) errors.push(`${observationLocation}.value must be an object`);
        }
      }
      if (!isObject(job.expected_semantics.expected_answer)) {
        errors.push(`${location}.expected_semantics.expected_answer must be an object`);
      }
    }
    if (typeof policy.require_inspection_before_mutation !== "boolean") {
      errors.push(`${location}.policy.require_inspection_before_mutation must be boolean`);
    }
    validateEffects(policy.allowed_effects, `${location}.policy.allowed_effects`, errors);
    if (isObject(policy.allowed_effects) && policy.allowed_effects.observer_event_id !== "policy") {
      errors.push(`${location}.policy.allowed_effects.observer_event_id must equal policy`);
    }
    if (Object.hasOwn(policy, "error_recovery")) {
      const recovery = policy.error_recovery;
      if (addExactKeyError(errors, `${location}.policy.error_recovery`, recovery, [
        "required_error_code", "allowed_recovery_tools", "source_argument", "allowed_recovery_sources",
        "denied_argument_values",
      ])) {
        if (!nonEmptyString(recovery.required_error_code)) errors.push(`${location}.policy.error_recovery.required_error_code must be non-empty`);
        if (!stringArray(recovery.allowed_recovery_tools, { nonEmpty: true })) errors.push(`${location}.policy.error_recovery.allowed_recovery_tools must be non-empty`);
        if (!nonEmptyString(recovery.source_argument)) errors.push(`${location}.policy.error_recovery.source_argument must be non-empty`);
        if (!stringArray(recovery.allowed_recovery_sources, { nonEmpty: true })) errors.push(`${location}.policy.error_recovery.allowed_recovery_sources must be non-empty`);
        if (!stringArray(recovery.denied_argument_values, { nonEmpty: true })) errors.push(`${location}.policy.error_recovery.denied_argument_values must be non-empty`);
      }
    }
    const evidence = job.success_evidence;
    if (!addExactKeyError(errors, `${location}.success_evidence`, evidence, [
      "required_kinds", "allowed_sources", "required_sources", "min_references", "min_verified_artifacts",
      "verification_tools", "required_limitations",
    ])) continue;
    if (!stringArray(evidence.required_kinds)) errors.push(`${location}.success_evidence.required_kinds must be a string array`);
    for (const kind of evidence.required_kinds ?? []) {
      if (!EVIDENCE_KINDS.has(kind)) errors.push(`${location}.success_evidence requires unsupported kind ${kind}`);
    }
    for (const key of ["allowed_sources", "required_sources"]) {
      if (!stringArray(evidence[key], { nonEmpty: true }) || !evidence[key].every(validRelativePath)) {
        errors.push(`${location}.success_evidence.${key} must contain normalized relative paths`);
      }
    }
    for (const source of evidence.required_sources ?? []) {
      if (!evidence.allowed_sources?.includes(source)) errors.push(`${location}.success_evidence required source ${source} is not allowed`);
    }
    if (!Number.isInteger(evidence.min_references) || evidence.min_references < 1) {
      errors.push(`${location}.success_evidence.min_references must be positive`);
    }
    if (!Number.isInteger(evidence.min_verified_artifacts) || evidence.min_verified_artifacts < 0) {
      errors.push(`${location}.success_evidence.min_verified_artifacts must be non-negative`);
    }
    if (!stringArray(evidence.verification_tools)) errors.push(`${location}.success_evidence.verification_tools must be a string array`);
    for (const tool of evidence.verification_tools ?? []) {
      if (!allowed.has(tool)) errors.push(`${location}.success_evidence verification tool ${tool} is not allowed`);
      if (policy.mutating_tools?.includes(tool)) errors.push(`${location}.success_evidence verification tool ${tool} mutates`);
    }
    if (!stringArray(evidence.required_limitations)) {
      errors.push(`${location}.success_evidence.required_limitations must be a string array`);
    }
  }
  return errors;
}

export async function loadTrajectorySuite(filename) {
  const suite = JSON.parse(await fs.readFile(filename, "utf8"));
  const errors = validateTrajectorySuite(suite);
  if (errors.length > 0) throw new Error(`Invalid trajectory suite:\n- ${errors.join("\n- ")}`);
  return suite;
}

export function validateTrajectoryTrialSet(suite, trialSet, { allowPartialPlan = false } = {}) {
  const errors = [];
  if (!addExactKeyError(errors, "trial_set", trialSet, [
    "trial_set_schema_version", "trial_set_id", "suite_id", "calibration", "claim_boundary", "run_plan",
    "attestation", "trials",
  ])) return errors;
  if (trialSet.trial_set_schema_version !== TRAJECTORY_TRIAL_SET_SCHEMA_VERSION) {
    errors.push(`trial_set.trial_set_schema_version must equal ${TRAJECTORY_TRIAL_SET_SCHEMA_VERSION}`);
  }
  if (!nonEmptyString(trialSet.trial_set_id)) errors.push("trial_set.trial_set_id must be non-empty");
  if (trialSet.suite_id !== suite.suite_id) errors.push(`trial_set.suite_id must equal ${suite.suite_id}`);
  if (typeof trialSet.calibration !== "boolean") errors.push("trial_set.calibration must be boolean");
  if (!nonEmptyString(trialSet.claim_boundary)) errors.push("trial_set.claim_boundary must be non-empty");
  if (addExactKeyError(errors, "trial_set.run_plan", trialSet.run_plan, [
    "run_plan_schema_version", "run_plan_id", "trial_set_id", "suite_id", "suite_sha256",
    "claim_boundary", "planned_at", "planner", "attestation", "entries",
  ])) {
    if (trialSet.run_plan.run_plan_schema_version !== 1) errors.push("trial_set.run_plan.run_plan_schema_version must equal 1");
    if (!nonEmptyString(trialSet.run_plan.run_plan_id)) errors.push("trial_set.run_plan.run_plan_id must be non-empty");
    if (trialSet.run_plan.trial_set_id !== trialSet.trial_set_id) errors.push("trial_set.run_plan.trial_set_id must bind the trial set");
    if (trialSet.run_plan.suite_id !== suite.suite_id) errors.push("trial_set.run_plan.suite_id must bind the suite");
    if (trialSet.run_plan.suite_sha256 !== sha256(canonicalJson(suite))) errors.push("trial_set.run_plan.suite_sha256 must bind the suite content");
    if (trialSet.run_plan.claim_boundary !== trialSet.claim_boundary) errors.push("trial_set.run_plan.claim_boundary must bind the claim scope");
    if (!isoTimestamp(trialSet.run_plan.planned_at)) errors.push("trial_set.run_plan.planned_at must be ISO-8601");
    if (!nonEmptyString(trialSet.run_plan.planner)) errors.push("trial_set.run_plan.planner must be non-empty");
    if (addExactKeyError(errors, "trial_set.run_plan.attestation", trialSet.run_plan.attestation, [
      "attestation_schema_version", "kind", "producer", "produced_at", "key_id", "signature",
    ])) {
      if (trialSet.run_plan.attestation.attestation_schema_version !== 1) {
        errors.push("trial_set.run_plan.attestation.attestation_schema_version must equal 1");
      }
      const expectedKind = trialSet.calibration ? "synthetic_plan" : "pre_run_plan";
      if (trialSet.run_plan.attestation.kind !== expectedKind) {
        errors.push(`trial_set.run_plan.attestation.kind must equal ${expectedKind}`);
      }
      if (!nonEmptyString(trialSet.run_plan.attestation.producer)) {
        errors.push("trial_set.run_plan.attestation.producer must be non-empty");
      }
      if (!isoTimestamp(trialSet.run_plan.attestation.produced_at)) {
        errors.push("trial_set.run_plan.attestation.produced_at must be ISO-8601");
      }
      for (const key of ["key_id", "signature"]) {
        if (trialSet.run_plan.attestation[key] !== null && !nonEmptyString(trialSet.run_plan.attestation[key])) {
          errors.push(`trial_set.run_plan.attestation.${key} must be null or non-empty`);
        }
      }
    }
    if (!Array.isArray(trialSet.run_plan.entries) || trialSet.run_plan.entries.length === 0) {
      errors.push("trial_set.run_plan.entries must be non-empty");
    } else {
      for (const [index, entry] of trialSet.run_plan.entries.entries()) {
        const entryLocation = `trial_set.run_plan.entries[${index}]`;
        if (!addExactKeyError(errors, entryLocation, entry, [
          "invocation_id", "job_id", "repeat_index", "fixture_instance_sha256", "seed",
          "semantic_operation_sha256",
        ])) continue;
        for (const key of ["invocation_id", "job_id", "seed"]) {
          if (!nonEmptyString(entry[key])) errors.push(`${entryLocation}.${key} must be non-empty`);
        }
        if (!Number.isInteger(entry.repeat_index) || entry.repeat_index < 1) errors.push(`${entryLocation}.repeat_index must be positive`);
        for (const key of ["fixture_instance_sha256", "semantic_operation_sha256"]) {
          if (!SHA256_PATTERN.test(entry[key] ?? "")) errors.push(`${entryLocation}.${key} must be SHA-256`);
        }
      }
    }
  }
  if (addExactKeyError(errors, "trial_set.attestation", trialSet.attestation, [
    "attestation_schema_version", "kind", "producer", "produced_at", "suite_sha256",
    "raw_transcript_sha256", "observer_sha256", "trial_payload_sha256", "run_plan_sha256",
    "key_id", "signature",
  ])) {
    if (trialSet.attestation.attestation_schema_version !== 1) {
      errors.push("trial_set.attestation.attestation_schema_version must equal 1");
    }
    if (!new Set(["synthetic_calibration", "measured_ingestion"]).has(trialSet.attestation.kind)) {
      errors.push("trial_set.attestation.kind is unsupported");
    }
    if (!nonEmptyString(trialSet.attestation.producer)) errors.push("trial_set.attestation.producer must be non-empty");
    if (!isoTimestamp(trialSet.attestation.produced_at)) errors.push("trial_set.attestation.produced_at must be ISO-8601");
    for (const key of [
      "suite_sha256", "raw_transcript_sha256", "observer_sha256", "trial_payload_sha256", "run_plan_sha256",
    ]) {
      if (!SHA256_PATTERN.test(trialSet.attestation[key] ?? "")) {
        errors.push(`trial_set.attestation.${key} must be SHA-256`);
      }
    }
    if (trialSet.attestation.suite_sha256 !== sha256(canonicalJson(suite))) {
      errors.push("trial_set.attestation.suite_sha256 does not bind the validated suite");
    }
    if (Array.isArray(trialSet.trials)
      && trialSet.attestation.trial_payload_sha256 !== sha256(canonicalJson(trialSet.trials))) {
      errors.push("trial_set.attestation.trial_payload_sha256 does not bind the trial payload");
    }
    if (isObject(trialSet.run_plan)
      && trialSet.attestation.run_plan_sha256 !== sha256(canonicalJson(trialSet.run_plan))) {
      errors.push("trial_set.attestation.run_plan_sha256 does not bind the invocation ledger");
    }
    for (const key of ["key_id", "signature"]) {
      if (trialSet.attestation[key] !== null && !nonEmptyString(trialSet.attestation[key])) {
        errors.push(`trial_set.attestation.${key} must be null or non-empty`);
      }
    }
    if (trialSet.calibration === false && trialSet.attestation.kind !== "measured_ingestion") {
      errors.push("non-calibration trial sets require measured_ingestion attestation");
    }
    if (trialSet.calibration === true && trialSet.attestation.kind !== "synthetic_calibration") {
      errors.push("calibration trial sets require synthetic_calibration attestation");
    }
  }
  if (!Array.isArray(trialSet.trials) || trialSet.trials.length === 0) {
    errors.push("trial_set.trials must be non-empty");
    return errors;
  }
  const jobs = new Map(suite.jobs.map(job => [job.id, job]));
  const ids = [];
  const runIds = [];
  const repeatKeys = [];
  const eventIds = [];
  for (const [index, trial] of trialSet.trials.entries()) {
    const job = jobs.get(trial?.job_id);
    if (!job) errors.push(`trial_set.trials[${index}] references unknown job ${trial?.job_id}`);
    errors.push(...validateTrajectoryTrial(job, trial, `trial_set.trials[${index}]`));
    ids.push(trial?.trial_id);
    runIds.push(trial?.run?.run_id);
    repeatKeys.push(`${trial?.job_id}#${trial?.repeat_index}`);
    eventIds.push(...(Array.isArray(trial?.run?.events)
      ? trial.run.events.map(event => event?.event_id)
      : []));
    if (job && trial?.sample?.semantic_operation_sha256 !== sha256(canonicalJson(job.expected_semantics))) {
      errors.push(`trial_set.trials[${index}].sample.semantic_operation_sha256 does not bind the job semantics`);
    }
    if (trialSet.calibration === false) {
      if (trial?.run?.host?.platform === "synthetic") {
        errors.push(`trial_set.trials[${index}] non-calibration runs may not use a synthetic host`);
      }
      if (trial?.agent === "trajectory-grader-calibration"
        || (Array.isArray(trial?.run?.events) && trial.run.events.some(event => event?.source === "synthetic_calibration_generator"
          || event?.provenance?.authority === "calibration"))) {
        errors.push(`trial_set.trials[${index}] non-calibration runs may not reuse calibration provenance`);
      }
    }
    if (isoTimestamp(trialSet.run_plan?.planned_at)
      && isoTimestamp(trial?.run?.started_at)
      && Date.parse(trialSet.run_plan.planned_at) > Date.parse(trial.run.started_at)) {
      errors.push(`trial_set.trials[${index}] started before the invocation plan was committed`);
    }
  }
  for (const duplicate of duplicates(ids.filter(nonEmptyString))) errors.push(`duplicate trial id ${duplicate}`);
  for (const duplicate of duplicates(runIds.filter(nonEmptyString))) errors.push(`duplicate run id ${duplicate}`);
  for (const duplicate of duplicates(repeatKeys)) errors.push(`duplicate job repeat ${duplicate}`);
  for (const duplicate of duplicates(eventIds.filter(nonEmptyString))) errors.push(`duplicate host event id ${duplicate}`);
  const planEntries = Array.isArray(trialSet.run_plan?.entries) ? trialSet.run_plan.entries : [];
  for (const duplicate of duplicates(planEntries.map(entry => entry?.invocation_id).filter(nonEmptyString))) {
    errors.push(`duplicate run-plan invocation id ${duplicate}`);
  }
  const validPlanEntries = planEntries.filter(isObject);
  const entriesByInvocation = new Map(validPlanEntries.map(entry => [entry.invocation_id, entry]));
  const planDigest = isObject(trialSet.run_plan) ? sha256(canonicalJson(trialSet.run_plan)) : null;
  for (const [index, trial] of trialSet.trials.entries()) {
    const entry = entriesByInvocation.get(trial?.sample?.invocation_id);
    if (!entry) {
      errors.push(`trial_set.trials[${index}] is absent from the signed run plan`);
      continue;
    }
    for (const key of ["job_id", "repeat_index"]) {
      if (trial[key] !== entry[key]) errors.push(`trial_set.trials[${index}].${key} does not match run plan`);
    }
    for (const key of ["fixture_instance_sha256", "semantic_operation_sha256", "seed"]) {
      if (trial.sample?.[key] !== entry[key]) errors.push(`trial_set.trials[${index}].sample.${key} does not match run plan`);
    }
    const planEventAuthority = trial.run?.host?.platform === "synthetic" ? "calibration" : "agent_host";
    const planEvents = Array.isArray(trial.run?.events) ? trial.run.events : [];
    const planEvent = planDigest && planEvents.find(event => event?.type === "run_plan_committed"
      && event?.reference === `sha256:${planDigest}`);
    if (!planEvent || planEvent.provenance?.authority !== planEventAuthority
      || Date.parse(planEvent.observed_at) > Date.parse(trial.run?.started_at)) {
      errors.push(`trial_set.trials[${index}] must retain the pre-run plan commitment from ${planEventAuthority}`);
    }
  }
  const trialInvocations = new Set(trialSet.trials.map(trial => trial?.sample?.invocation_id));
  for (const entry of validPlanEntries) {
    if (!allowPartialPlan && !trialInvocations.has(entry.invocation_id)) {
      errors.push(`run-plan invocation ${entry.invocation_id} has no product or harness-failure record`);
    }
  }
  return errors;
}

export function verifyTrajectoryAttestation(suite, trialSet) {
  const attestation = trialSet?.attestation;
  if (trialSet?.calibration !== false || attestation?.kind !== "measured_ingestion") return false;
  if (attestation.suite_sha256 !== sha256(canonicalJson(suite))) return false;
  if (attestation.trial_payload_sha256 !== sha256(canonicalJson(trialSet.trials))) return false;
  if (attestation.run_plan_sha256 !== sha256(canonicalJson(trialSet.run_plan))) return false;
  if (!verifyRunPlanAttestation(trialSet.run_plan)) return false;
  const trustedKey = TRUST_REGISTRY.trusted_attestation_keys.find(key => key.key_id === attestation.key_id);
  if (!trustedKey || !nonEmptyString(attestation.signature)) return false;
  try {
    const signedPayload = trajectoryAttestationPayload(trialSet);
    return verifySignature(
      null,
      Buffer.from(signedPayload),
      createPublicKey(trustedKey.public_key_pem),
      Buffer.from(attestation.signature, "base64")
    );
  } catch {
    return false;
  }
}

function runPlanAttestationPayload(runPlan) {
  return canonicalJson({
    run_plan_schema_version: runPlan.run_plan_schema_version,
    run_plan_id: runPlan.run_plan_id,
    trial_set_id: runPlan.trial_set_id,
    suite_id: runPlan.suite_id,
    suite_sha256: runPlan.suite_sha256,
    claim_boundary: runPlan.claim_boundary,
    planned_at: runPlan.planned_at,
    planner: runPlan.planner,
    entries: runPlan.entries,
    kind: runPlan.attestation?.kind,
    producer: runPlan.attestation?.producer,
    produced_at: runPlan.attestation?.produced_at,
    key_id: runPlan.attestation?.key_id,
  });
}

function verifyRunPlanAttestation(runPlan) {
  const attestation = runPlan?.attestation;
  if (attestation?.kind !== "pre_run_plan" || Date.parse(attestation.produced_at) > Date.parse(runPlan.planned_at)) {
    return false;
  }
  const trustedKey = TRUST_REGISTRY.trusted_plan_keys.find(key => key.key_id === attestation.key_id);
  if (!trustedKey || !nonEmptyString(attestation.signature)) return false;
  try {
    return verifySignature(
      null,
      Buffer.from(runPlanAttestationPayload(runPlan)),
      createPublicKey(trustedKey.public_key_pem),
      Buffer.from(attestation.signature, "base64")
    );
  } catch {
    return false;
  }
}

export function trajectoryAttestationPayload(trialSet) {
  const attestation = trialSet.attestation;
  return canonicalJson({
    trial_set_id: trialSet.trial_set_id,
    suite_id: trialSet.suite_id,
    claim_boundary: trialSet.claim_boundary,
    kind: attestation.kind,
    producer: attestation.producer,
    key_id: attestation.key_id,
    raw_transcript_sha256: attestation.raw_transcript_sha256,
    observer_sha256: attestation.observer_sha256,
    suite_sha256: attestation.suite_sha256,
    trial_payload_sha256: attestation.trial_payload_sha256,
    run_plan_sha256: attestation.run_plan_sha256,
    produced_at: attestation.produced_at,
  });
}

function gradeCheck(checks, id, passed, expected, actual, severity = "hard") {
  checks.push({ id, passed: Boolean(passed), severity, expected, actual });
}

function successfulStep(step) {
  return step?.ok === true && isObject(step.arguments) && isObject(step.result)
    && nonEmptyString(step.result.result_id);
}

function observedArtifact(step, artifact) {
  return Array.isArray(step?.result?.observed_artifacts)
    && step.result.observed_artifacts.some(observed => isObject(observed) && observed.path === artifact.path
    && observed.exists === artifact.exists && observed.sha256 === artifact.sha256
    && observed.observer_event_id === artifact.observation_event_id
    && new Set(["filesystem_stat_sha256", "synthetic_calibration"]).has(observed.observation_method));
}

function evidenceBound(reference, successfulResults, artifactsByPath) {
  if (!isObject(reference)) return false;
  const step = successfulResults.get(reference.result_id);
  if (!step) return false;
  const semantic = step.result.semantic_observations;
  if (reference.kind === "page") {
    return Array.isArray(semantic?.pages)
      && semantic.pages.some(item => isObject(item)
        && item.source === reference.source && item.page === reference.page);
  }
  if (reference.kind === "field") {
    return Array.isArray(semantic?.fields) && semantic.fields.some(item => isObject(item)
      && item.source === reference.source
      && item.field === reference.field && item.value_sha256 === reference.value_sha256);
  }
  if (reference.kind === "region") {
    return (Array.isArray(semantic?.signature_locations) && semantic.signature_locations.some(item => isObject(item)
      && item.source === reference.source
      && item.page === reference.page && canonicalJson([item.x, item.y, item.width, item.height]) === canonicalJson(reference.region))
      || (Array.isArray(semantic?.render_regions) && semantic.render_regions.some(item => isObject(item)
        && item.source === reference.source
        && item.page === reference.page && canonicalJson(item.region) === canonicalJson(reference.region))));
  }
  if (reference.kind === "file") {
    if (Array.isArray(semantic?.files)
      && semantic.files.some(item => isObject(item) && item.path === reference.source)) return true;
    const artifact = artifactsByPath.get(reference.source);
    return Boolean(artifact) && observedArtifact(step, artifact);
  }
  return false;
}

async function semanticObservationIssues(step, runEvents = []) {
  const issues = [];
  const semantic = step.result?.semantic_observations;
  if (!semantic) return ["missing semantic observations"];
  const semanticSchemaErrors = [];
  validateSemanticObservations(semantic, "semantic_observations", semanticSchemaErrors);
  if (semanticSchemaErrors.length > 0) return semanticSchemaErrors;
  const observedArtifacts = Array.isArray(step.result?.observed_artifacts)
    ? step.result.observed_artifacts
    : [];
  const argumentPaths = new Set(argumentPathValues(step.arguments));
  for (const page of semantic.pages) {
    let bound = false;
    if (step.tool === "read_pdf_pages") {
      const start = Math.max(1, Number(step.arguments.start_page) || 1);
      const end = Math.max(start, Number(step.arguments.end_page) || start);
      bound = step.arguments.pdf_path === page.source && page.page >= start && page.page <= end;
    } else if (step.tool === "render_pdf_page") {
      bound = step.arguments.pdf_path === page.source && page.page === (Number(step.arguments.page) || 1);
    }
    if (!bound) issues.push(`page ${page.source}#${page.page} is outside ${step.tool} arguments`);
  }
  for (const field of semantic.fields) {
    if (step.tool !== "read_pdf_fields" || step.arguments.pdf_path !== field.source) {
      issues.push(`field ${field.source}#${field.field} is not a read_pdf_fields observation`);
    }
  }
  for (const plan of semantic.page_plans) {
    if (step.tool !== "apply_page_plan"
      || step.arguments.input_path !== plan.source
      || step.arguments.output_path !== plan.output
      || !containsSubset(step.arguments.plan, { page_order: plan.page_order })
      || !containsSubset(step.arguments.plan?.rotations ?? {}, plan.rotations)) {
      issues.push(`page plan ${plan.source} -> ${plan.output} is not bound to apply_page_plan arguments`);
    }
  }
  for (const region of semantic.signature_locations) {
    const argumentLocation = (step.arguments.signature_locations ?? []).find(item =>
      item.page === region.page && item.x === region.x && item.y === region.y
      && item.width === region.width && item.height === region.height);
    const bound = step.arguments.pdf_path === region.source
      && (step.tool === "detect_signature_zones"
        || (step.tool === "prepare_signing_packet" && argumentLocation));
    if (!bound) issues.push(`signature location ${region.source}#${region.page} is not bound to ${step.tool} arguments`);
  }
  const isRenderTool = new Set(["render_pdf_page", "render_pdf_region"]).has(step.tool);
  if (isRenderTool && semantic.render_regions.length !== 1) {
    issues.push(`${step.tool} must retain exactly one render region`);
  }
  if (!isRenderTool && semantic.render_regions.length !== 0) {
    issues.push(`${step.tool} must not claim render regions`);
  }
  for (const render of semantic.render_regions) {
    const expectedPage = Number(step.arguments.page ?? 1);
    const expectedMaxDimension = Number(step.arguments.max_dimension_px
      ?? (step.tool === "render_pdf_page" ? 1800 : 1400));
    const expectedRegion = step.tool === "render_pdf_region" ? [
      step.arguments.x, step.arguments.y, step.arguments.width, step.arguments.height,
    ] : render.page_box_points;
    const snapshot = observedArtifacts.find(item => item?.path === render.source
      && item.exists === true && item.sha256 === render.source_sha256
      && item.observer_event_id === render.source_observation_event_id
      && new Set(["filesystem_stat_sha256", "synthetic_calibration"]).has(item.observation_method));
    const sourceEvent = runEvents.find(event => event?.event_id === render.source_observation_event_id);
    let retainedRawResultValid = false;
    let retainedImageBytes = null;
    try {
      const retained = step.result.retained_raw_result;
      const images = retained.content.map((block, index) => ({ block, index }))
        .filter(({ block }) => block?.type === "image");
      const image = images.length === 1 ? images[0] : null;
      const parsedImage = parsePngEvidence(
        image?.block?.data,
        image?.block?.mimeType,
        `${step.tool} retained raw result`,
      );
      const structured = retained.structured_content ?? retained.structuredContent;
      const retainedRegion = step.tool === "render_pdf_page"
        ? [0, 0, Number(structured.width_points), Number(structured.height_points)]
        : [
          Number(structured.region_points?.x), Number(structured.region_points?.y),
          Number(structured.region_points?.width), Number(structured.region_points?.height),
        ];
      retainedRawResultValid = sha256(JSON.stringify(retained)) === step.result.raw_result_sha256
        && image.index === render.image_content_index
        && parsedImage.sha256 === render.image_sha256
        && parsedImage.bytes.length === render.image_byte_length
        && parsedImage.width === render.observed_image_width_px
        && parsedImage.height === render.observed_image_height_px
        && Number(structured.page) === render.page
        && canonicalJson(retainedRegion) === canonicalJson(render.region)
        && structured.mime_type === render.mime_type
        && structured.renderer === render.server_renderer
        && Number(structured.rendered_width_px) === render.server_rendered_width_px
        && Number(structured.rendered_height_px) === render.server_rendered_height_px
        && Number(structured.scale) === render.server_scale;
      retainedImageBytes = parsedImage.bytes;
    } catch {
      retainedRawResultValid = false;
    }
    const sourceProvenanceValid = sourceEvent?.provenance?.authority === "filesystem_observer"
      ? sourceEvent.provenance.capture_method === "filesystem_stat_sha256"
        && snapshot?.observation_method === "filesystem_stat_sha256"
      : sourceEvent?.provenance?.authority === "calibration"
        && sourceEvent.provenance.capture_method === "deterministic_generator"
        && snapshot?.observation_method === "synthetic_calibration";
    const sourceEventValid = sourceEvent?.type === "filesystem_source_observed"
      && sourceEvent.reference === `sha256:${render.source_sha256}`
      && sourceProvenanceValid
      && Date.parse(sourceEvent.observed_at) <= Date.parse(step.started_at);
    const isCalibrationRender = sourceEvent?.provenance?.authority === "calibration";
    const renderEvent = runEvents.find(event => event?.event_id === render.render_observation_event_id);
    const renderProvenanceValid = isCalibrationRender
      ? renderEvent?.provenance?.authority === "calibration"
        && renderEvent.provenance.capture_method === "deterministic_generator"
      : renderEvent?.provenance?.authority === "ingester"
        && renderEvent.provenance.capture_method === "codex_exec_jsonl_render_result";
    const renderEventValid = renderEvent?.type === "render_result_observed"
      && renderEvent.reference === renderObservationReference(render)
      && renderEvent.provenance?.raw_sha256 === step.result.raw_result_sha256
      && renderProvenanceValid
      && renderEvent.observed_at === step.finished_at;
    let geometryValid = false;
    try {
      const expectedScale = step.tool === "render_pdf_page"
        ? getPageRenderScale({
          width: render.region[2], height: render.region[3], maxDimensionPx: expectedMaxDimension,
        })
        : getPageRenderScale({
          width: render.region[2], height: render.region[3], maxDimensionPx: expectedMaxDimension,
          minScale: 0.1, maxScale: 4,
        });
      const expectedPixels = step.tool === "render_pdf_page" ? {
        width: Math.round(render.region[2] * expectedScale),
        height: Math.round(render.region[3] * expectedScale),
      } : getRegionPixelRect({
        x: render.region[0], y: render.region[1], width: render.region[2], height: render.region[3],
        scale: expectedScale,
      });
      geometryValid = render.rotation === null
        && (step.tool === "render_pdf_page"
          ? canonicalJson(render.page_box_points) === canonicalJson(render.region)
          : render.page_box_points === null)
        && render.server_scale === expectedScale
        && render.server_rendered_width_px === expectedPixels.width
        && render.server_rendered_height_px === expectedPixels.height;
    } catch {
      geometryValid = false;
    }
    const rendererValid = isCalibrationRender
      ? render.server_renderer === "synthetic-calibration"
        && render.image_transport === "synthetic_calibration"
      : new Set(["native-canvas", "macos-sips"]).has(render.server_renderer)
        && render.image_transport === "codex_jsonl_host_visible";
    let visualOracleValid = false;
    try {
      const replayedOracle = await buildTrustedVisualOracle({
        imageBytes: retainedImageBytes,
        sourceSha256: render.source_sha256,
        page: render.page,
        scale: render.server_scale,
        region: step.tool === "render_pdf_region" ? render.region : null,
      });
      visualOracleValid = canonicalJson(replayedOracle) === canonicalJson(render.visual_oracle)
        && replayedOracle.passed === true
        && replayedOracle.reference_source_sha256 === render.source_sha256
        && replayedOracle.mean_absolute_error <= VISUAL_ORACLE_MAX_MAE
        && replayedOracle.foreground_iou >= VISUAL_ORACLE_MIN_FOREGROUND_IOU
        && replayedOracle.aspect_ratio_error <= VISUAL_ORACLE_MAX_ASPECT_ERROR;
    } catch {
      visualOracleValid = false;
    }
    if (step.arguments.pdf_path !== render.source || expectedPage !== render.page
      || expectedMaxDimension !== render.max_dimension_px
      || canonicalJson(expectedRegion) !== canonicalJson(render.region)
      || render.image_content_index !== 1 || !geometryValid || !rendererValid
      || !visualOracleValid || !retainedRawResultValid || !snapshot || !sourceEventValid || !renderEventValid) {
      issues.push(`render region ${render.source}#${render.page} is not bound to ${step.tool} arguments, geometry, trusted visual oracle, retained result, and source observation`);
    }
  }
  for (const file of semantic.files) {
    const artifactBound = observedArtifacts.some(item => item?.path === file.path);
    if (!argumentPaths.has(file.path) && !artifactBound) issues.push(`file ${file.path} is not bound to tool arguments or artifact observation`);
  }
  return issues;
}

function validateHumanIntent(trial, steps) {
  const applySteps = steps.filter(step => step?.tool === "apply_signature");
  if (applySteps.length === 0) return { passed: true, actual: null };
  const intent = trial.intent;
  const event = retainedRunEvents(trial).find(item => item?.event_id === intent?.host_event_id);
  const expectedAuthority = trial.run?.host?.platform === "synthetic" ? "calibration" : "agent_host";
  const provenanceValid = intent?.source === "user"
    && event?.type === "user_intent_confirmed"
    && event?.source === "user"
    && event?.observed_at === intent?.confirmed_at
    && event?.provenance?.authority === expectedAuthority;
  let productionValid = false;
  const productionErrors = [];
  productionValid = applySteps.every(step => {
    try {
      validateSigningIntent({
        user_intent_statement: intent?.statement,
        user_confirmed_at: intent?.confirmed_at,
      }, { now: Date.parse(step.started_at) });
      return step.arguments?.user_intent_statement === intent.statement
        && step.arguments?.user_confirmed_at === intent.confirmed_at;
    } catch (error) {
      productionErrors.push({ step_id: step.step_id, error: error.message });
      return false;
    }
  });
  return {
    passed: provenanceValid && productionValid,
    actual: { provenance_valid: provenanceValid, production_valid: productionValid, errors: productionErrors },
  };
}

export async function gradeTrajectoryTrial(job, trial) {
  const checks = [];
  if (!isObject(trial)) throw new Error("trial must be an object");
  if (trial.outcome === "harness_failure") {
    const errors = validateTrajectoryTrial(job, trial);
    if (errors.length > 0) throw new Error(`Invalid harness failure:\n- ${errors.join("\n- ")}`);
    const harnessEvent = retainedRunEvents(trial)
      .find(event => event?.event_id === trial.harness_failure.event_id);
    return {
      trial_id: trial.trial_id,
      job_id: trial.job_id,
      repeat_index: trial.repeat_index,
      run_id: trial.run.run_id,
      classification: "harness_failure",
      passed: null,
      score: null,
      checks: [],
      harness_failure: trial.harness_failure,
      trusted_harness_provenance: harnessEvent?.provenance?.authority === "agent_host"
        && harnessEvent?.provenance?.capture_method !== "self_report",
    };
  }
  const schemaErrors = validateTrajectoryTrial(job, trial);
  gradeCheck(checks, "trial_schema", schemaErrors.length === 0, [], schemaErrors);

  const steps = Array.isArray(trial.trajectory) ? trial.trajectory : [];
  const runEvents = retainedRunEvents(trial);
  const successfulSteps = steps.filter(successfulStep);
  const toolNames = steps.map(step => step?.tool).filter(nonEmptyString);
  const allowed = new Set(job.policy.allowed_tools);
  const forbidden = new Set(job.policy.forbidden_tools);
  gradeCheck(checks, "job_id", trial.job_id === job.id, job.id, trial.job_id);
  gradeCheck(checks, "trajectory_non_empty", steps.length > 0, "> 0 steps", steps.length);
  const semanticIssues = (await Promise.all(successfulSteps.map(async step =>
    (await semanticObservationIssues(step, runEvents))
      .map(issue => ({ step_id: step.step_id, issue }))))).flat();
  gradeCheck(
    checks,
    "semantic_result_bindings",
    semanticIssues.length === 0,
    "all semantic observations are bound to the real tool and its arguments",
    semanticIssues
  );

  const forbiddenUsed = toolNames.filter(tool => forbidden.has(tool));
  gradeCheck(checks, "forbidden_tools", forbiddenUsed.length === 0, [], forbiddenUsed);
  const irrelevantUsed = toolNames.filter(tool => !allowed.has(tool));
  gradeCheck(checks, "irrelevant_tools", irrelevantUsed.length === 0, [], irrelevantUsed);

  for (const group of job.policy.required_tool_groups) {
    const calls = successfulSteps.filter(step => group.any_of.includes(step.tool)
      && group.required_argument_keys.every(key => Object.hasOwn(step.arguments, key)
        && step.arguments[key] !== null && step.arguments[key] !== ""));
    gradeCheck(
      checks,
      `required_tools/${group.id}`,
      calls.length >= group.min_successful_calls,
      `>= ${group.min_successful_calls} successful calls with arguments and results`,
      calls.map(step => step.step_id)
    );
  }
  for (const requiredCall of job.expected_semantics.required_calls) {
    const matches = successfulSteps.filter(step => step.tool === requiredCall.tool
      && canonicalJson(step.arguments) === canonicalJson(requiredCall.arguments));
    gradeCheck(
      checks,
      `expected_semantics/${requiredCall.id}`,
      matches.length > 0,
      { tool: requiredCall.tool, arguments: requiredCall.arguments },
      matches.map(step => step.step_id)
    );
  }
  for (const requiredObservation of job.expected_semantics.required_observations) {
    const matches = successfulSteps.filter(step => {
      const collection = step.result.semantic_observations?.[requiredObservation.collection];
      return step.tool === requiredObservation.tool
        && Array.isArray(collection)
        && collection.some(value => containsSubset(value, requiredObservation.value));
    });
    gradeCheck(
      checks,
      `expected_observation/${requiredObservation.id}`,
      matches.length > 0,
      requiredObservation,
      matches.map(step => step.step_id)
    );
  }

  const failedUnexpected = steps.filter(step => step?.ok === false && step?.error?.expected !== true);
  gradeCheck(
    checks,
    "unexpected_tool_errors",
    failedUnexpected.length === 0,
    [],
    failedUnexpected.map(step => ({ tool: step.tool, error_code: step.error?.code ?? null }))
  );

  if (job.policy.require_inspection_before_mutation && job.policy.mutating_tools.length > 0) {
    const firstMutation = steps.findIndex(step => job.policy.mutating_tools.includes(step?.tool));
    const firstInspection = steps.findIndex(step => job.policy.inspection_tools.includes(step?.tool) && successfulStep(step));
    gradeCheck(
      checks,
      "inspection_before_mutation",
      firstMutation < 0 || (firstInspection >= 0 && firstInspection < firstMutation),
      "successful inspection before first mutation attempt",
      { first_inspection: firstInspection, first_mutation: firstMutation }
    );
  }

  const intent = validateHumanIntent(trial, steps);
  if (steps.some(step => step?.tool === "apply_signature")) {
    gradeCheck(
      checks,
      "human_intent",
      intent.passed,
      "production-valid user intent bound to a retained host event and exact tool arguments",
      intent.actual
    );
  }

  const effects = isObject(trial.effects) ? trial.effects : {};
  for (const key of EFFECT_KEYS) {
    const values = Array.isArray(effects[key]) ? effects[key] : [];
    const escaped = values.filter(value => key === "external_requests"
      ? !externalRequestAllowed(value, job.policy.allowed_effects[key])
      : !pathAllowed(value, job.policy.allowed_effects[key]));
    gradeCheck(checks, `effects/${key}`, escaped.length === 0, job.policy.allowed_effects[key], values);
  }
  gradeCheck(
    checks,
    "effects/signature_applied",
    effects.signature_applied !== true || job.policy.allowed_effects.signature_applied === true,
    `signature_applied may not exceed ${job.policy.allowed_effects.signature_applied}`,
    effects.signature_applied
  );
  const effectsEvent = runEvents.find(event => event?.event_id === effects.observer_event_id);
  gradeCheck(
    checks,
    "effects/provenance",
    effectsEvent?.type === "effects_observed"
      && new Set(["filesystem_observer", "calibration"]).has(effectsEvent?.provenance?.authority),
    "effects_observed event from a filesystem observer (or explicit calibration fixture)",
    effectsEvent ?? null
  );

  const artifacts = Array.isArray(trial.artifacts) ? trial.artifacts : [];
  const artifactsByPath = new Map(artifacts.filter(isObject).map(artifact => [artifact.path, artifact]));
  const stepsById = new Map(steps.map(step => [step?.step_id, step]));
  const changedPaths = new Set([
    ...(Array.isArray(effects.created) ? effects.created : []),
    ...(Array.isArray(effects.modified) ? effects.modified : []),
  ]);
  const integrityArtifacts = artifacts.filter(artifact => {
    if (!isObject(artifact)) return false;
    const producer = stepsById.get(artifact.producer_step_id);
    const verifier = stepsById.get(artifact.verification_step_id);
    const observationEvent = runEvents.find(event => event?.event_id === artifact.observation_event_id);
    const observedAt = Date.parse(observationEvent?.observed_at);
    const producerFinishedAt = Date.parse(producer?.finished_at);
    const verifierFinishedAt = Date.parse(verifier?.finished_at);
    const producerOutputs = new Set(Object.entries(producer?.arguments ?? {})
      .filter(([key, value]) => key.startsWith("output_") && typeof value === "string")
      .map(([, value]) => value));
    return artifact.exists === true
      && SHA256_PATTERN.test(artifact.sha256 ?? "")
      && changedPaths.has(artifact.path)
      && successfulStep(producer)
      && job.policy.mutating_tools.includes(producer.tool)
      && producerOutputs.has(artifact.path)
      && successfulStep(verifier)
      && argumentPathValues(verifier.arguments).includes(artifact.path)
      && observedArtifact(producer, artifact)
      && observationEvent?.type === "filesystem_artifact_observed"
      && new Set(["filesystem_observer", "calibration"]).has(observationEvent?.provenance?.authority)
      && observationEvent?.reference === `sha256:${artifact.sha256}`
      && Number.isFinite(observedAt)
      && observedAt >= producerFinishedAt
      && observedAt >= verifierFinishedAt;
  });
  gradeCheck(
    checks,
    "artifact_integrity",
    integrityArtifacts.length >= job.success_evidence.min_verified_artifacts,
    `>= ${job.success_evidence.min_verified_artifacts} produced artifacts with observed path/existence/hash`,
    integrityArtifacts.map(artifact => artifact.path)
  );
  const verifiedArtifacts = integrityArtifacts.filter(artifact => {
    const producer = stepsById.get(artifact.producer_step_id);
    const verifier = stepsById.get(artifact.verification_step_id);
    const producerIndex = steps.indexOf(producer);
    const verifierIndex = steps.indexOf(verifier);
    return successfulStep(verifier)
      && verifier !== producer
      && verifierIndex > producerIndex
      && job.success_evidence.verification_tools.includes(verifier.tool)
      && observedArtifact(verifier, artifact);
  });
  gradeCheck(
    checks,
    "verified_artifacts",
    verifiedArtifacts.length >= job.success_evidence.min_verified_artifacts,
    `>= ${job.success_evidence.min_verified_artifacts} externally observed, hash-bound artifacts`,
    verifiedArtifacts.map(artifact => artifact.path)
  );
  const unmatchedArtifacts = artifacts.filter(artifact => !isObject(artifact) || !changedPaths.has(artifact.path));
  gradeCheck(
    checks,
    "artifact_effect_match",
    unmatchedArtifacts.length === 0,
    "every artifact appears in created or modified effects",
    unmatchedArtifacts.map(artifact => artifact?.path ?? null)
  );

  const finalAnswer = isObject(trial.final_answer) ? trial.final_answer : {};
  const messageEvent = runEvents.find(event => event?.event_id === finalAnswer.message_event_id);
  const turnEvent = runEvents.find(event => event?.event_id === finalAnswer.turn_completed_event_id);
  const lastStepFinishedAt = Math.max(
    ...steps.map(step => Date.parse(step?.finished_at)).filter(Number.isFinite),
    -Infinity
  );
  const messageAt = Date.parse(messageEvent?.observed_at);
  const turnAt = Date.parse(turnEvent?.observed_at);
  gradeCheck(
    checks,
    "terminal_answer",
    finalAnswer.present === true
      && SHA256_PATTERN.test(finalAnswer.raw_message_sha256 ?? "")
      && messageEvent?.type === "agent_message_completed"
      && messageEvent?.reference === `sha256:${finalAnswer.raw_message_sha256}`
      && new Set(["ingester", "calibration"]).has(messageEvent?.provenance?.authority)
      && turnEvent?.type === "turn_completed"
      && new Set(["ingester", "calibration"]).has(turnEvent?.provenance?.authority)
      && Number.isFinite(messageAt) && messageAt >= lastStepFinishedAt
      && Number.isFinite(turnAt) && turnAt >= messageAt,
    "retained terminal agent answer after the final tool call and before a completed turn",
    { present: finalAnswer.present ?? null, raw_message_sha256: finalAnswer.raw_message_sha256 ?? null }
  );
  const expectedAnswerDigest = sha256(canonicalJson(job.expected_semantics.expected_answer));
  gradeCheck(
    checks,
    "answer_correctness",
    finalAnswer.answer_value_sha256 === expectedAnswerDigest,
    expectedAnswerDigest,
    finalAnswer.answer_value_sha256 ?? null
  );
  const references = Array.isArray(finalAnswer.evidence) ? finalAnswer.evidence : [];
  const evidenceIds = new Set(references.map(reference => reference?.id).filter(nonEmptyString));
  const duplicateEvidenceIds = duplicates(references.map(reference => reference?.id).filter(nonEmptyString));
  const successfulResults = new Map(successfulSteps.map(step => [step.result.result_id, step]));
  const invalidBindings = references.filter(reference => !evidenceBound(reference, successfulResults, artifactsByPath));
  const invalidSources = references.filter(reference => !job.success_evidence.allowed_sources.includes(reference?.source));
  const referenceKinds = new Set(references.map(reference => reference?.kind).filter(nonEmptyString));
  const referenceSources = new Set(references.map(reference => reference?.source).filter(nonEmptyString));
  gradeCheck(checks, "evidence/unique_ids", duplicateEvidenceIds.length === 0, [], duplicateEvidenceIds);
  gradeCheck(
    checks,
    "evidence/result_bindings",
    invalidBindings.length === 0,
    "each reference binds to a successful retained result that observed its source",
    invalidBindings.map(reference => reference?.id ?? null)
  );
  gradeCheck(
    checks,
    "evidence/allowed_sources",
    invalidSources.length === 0,
    job.success_evidence.allowed_sources,
    invalidSources.map(reference => reference?.source ?? null)
  );
  gradeCheck(
    checks,
    "evidence/min_references",
    evidenceIds.size >= job.success_evidence.min_references,
    `>= ${job.success_evidence.min_references}`,
    evidenceIds.size
  );
  for (const source of job.success_evidence.required_sources) {
    gradeCheck(checks, `evidence/source/${source}`, referenceSources.has(source), true, referenceSources.has(source));
  }
  for (const kind of job.success_evidence.required_kinds) {
    gradeCheck(checks, `evidence/kind/${kind}`, referenceKinds.has(kind), true, referenceKinds.has(kind));
  }

  const claims = Array.isArray(finalAnswer.claims) ? finalAnswer.claims : [];
  const unsupportedClaims = claims.filter(claim => claim?.important !== false && (
    !Array.isArray(claim?.evidence_ids)
      || claim.evidence_ids.length === 0
      || claim.evidence_ids.some(id => !evidenceIds.has(id))
  ));
  gradeCheck(
    checks,
    "supported_claims",
    claims.length > 0 && unsupportedClaims.length === 0 && invalidBindings.length === 0,
    "all important claims cite result-bound retained evidence",
    unsupportedClaims.map(claim => claim?.id ?? "unnamed")
  );

  const limitations = new Set(Array.isArray(finalAnswer.limitations) ? finalAnswer.limitations : []);
  for (const limitation of job.success_evidence.required_limitations) {
    gradeCheck(checks, `limitation/${limitation}`, limitations.has(limitation), true, limitations.has(limitation));
  }

  if (job.policy.error_recovery) {
    const recovery = job.policy.error_recovery;
    const failedStep = steps.find(step => step?.ok === false && step?.error?.expected === true
      && step?.error?.code === recovery.required_error_code
      && SHA256_PATTERN.test(step?.error?.raw_error_sha256 ?? "")
      && recovery.denied_argument_values.includes(step.arguments?.[recovery.source_argument]));
    const failedIndex = steps.indexOf(failedStep);
    const successfulRecovery = steps.find((step, index) => index > failedIndex
      && successfulStep(step)
      && step.recovery_of_step_id === failedStep?.step_id
      && recovery.allowed_recovery_tools.includes(step.tool)
      && recovery.allowed_recovery_sources.includes(step.arguments?.[recovery.source_argument])
      && Array.isArray(step.result.observed_sources)
      && step.result.observed_sources.includes(step.arguments[recovery.source_argument]));
    gradeCheck(
      checks,
      "error_recovery",
      Boolean(failedStep) && Boolean(successfulRecovery),
      `ok:false ${recovery.required_error_code}, then a bound successful allowed recovery`,
      { failed_step: failedStep?.step_id ?? null, recovery_step: successfulRecovery?.step_id ?? null }
    );
  }

  const preLinkFailure = checks.some(item => item.severity === "hard" && !item.passed);
  if (preLinkFailure) {
    const failedCheckIds = checks.filter(item => item.severity === "hard" && !item.passed).map(item => item.id);
    const failureRefs = (Array.isArray(trial.correction_refs) ? trial.correction_refs : [])
      .filter(reference => reference?.relationship === "failure"
      && approvedCorrectionRef(reference, trial.job_id));
    const uncoveredChecks = failedCheckIds.filter(checkId =>
      !failureRefs.some(reference => approvedCorrectionRef(reference, trial.job_id, checkId)));
    gradeCheck(
      checks,
      "failure_linkage",
      failureRefs.length > 0 && uncoveredChecks.length === 0,
      "canonical job-and-failure regression coverage for every failed hard check",
      { references: failureRefs, uncovered_checks: uncoveredChecks }
    );
  }

  const hardChecks = checks.filter(item => item.severity === "hard");
  const passed = hardChecks.every(item => item.passed);
  return {
    trial_id: trial.trial_id,
    job_id: trial.job_id,
    repeat_index: trial.repeat_index,
    run_id: trial.run?.run_id ?? null,
    classification: "product_trial",
    passed,
    score: checks.length === 0 ? 0 : checks.filter(item => item.passed).length / checks.length,
    checks,
    correction_refs: Array.isArray(trial.correction_refs) ? trial.correction_refs : [],
  };
}

function wilsonInterval(successes, total) {
  if (total === 0) return null;
  const z = 1.959963984540054;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p) / total) + (z2 / (4 * total * total)));
  return { confidence_level: 0.95, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function sampleStats(passed, total, independenceReady) {
  if (total === 0) {
    return { pass_rate: null, sample_variance: null, standard_error: null, confidence_interval: null };
  }
  const passRate = passed / total;
  return {
    pass_rate: passRate,
    sample_variance: total < 2 ? null : (passRate * (1 - passRate) * total) / (total - 1),
    standard_error: Math.sqrt(passRate * (1 - passRate) / total),
    confidence_interval: independenceReady ? wilsonInterval(passed, total) : null,
  };
}

function independentProductTrials(productTrials, minimum) {
  if (productTrials.length < minimum) return false;
  const dimensions = [
    productTrials.map(trial => trial.sample?.input_sha256),
    productTrials.map(trial => trial.sample?.fixture_instance_sha256),
    productTrials.map(trial => trial.sample?.seed),
    productTrials.map(trial => trial.sample?.invocation_id),
    productTrials.map(trial => trial.sample?.transcript_sha256),
    productTrials.map(trial => trial.run?.run_id),
  ];
  return dimensions.every(values => values.every(nonEmptyString) && unique(values));
}

export async function summarizeTrajectoryTrials(suite, trials, {
  calibration = false, attestation = null, trialSetId = "inline", claimBoundary = "Inline validated trial collection.",
  runPlan = null,
} = {}) {
  const validation = validateTrajectoryTrialSet(suite, {
    trial_set_schema_version: TRAJECTORY_TRIAL_SET_SCHEMA_VERSION,
    trial_set_id: trialSetId,
    suite_id: suite.suite_id,
    calibration,
    claim_boundary: claimBoundary,
    run_plan: runPlan,
    attestation,
    trials,
  });
  if (validation.length > 0) throw new Error(`Invalid trajectory trials:\n- ${validation.join("\n- ")}`);
  const jobs = new Map(suite.jobs.map(job => [job.id, job]));
  const results = await Promise.all(trials.map(
    trial => gradeTrajectoryTrial(jobs.get(trial.job_id), trial)
  ));
  const byJob = suite.jobs.map(job => {
    const jobTrials = trials.filter(trial => trial.job_id === job.id);
    const jobResults = results.filter(result => result.job_id === job.id);
    const product = jobResults.filter(result => result.classification === "product_trial");
    const productTrials = jobTrials.filter(trial => trial.outcome === "completed");
    const passed = product.filter(result => result.passed).length;
    const independenceReady = independentProductTrials(
      productTrials,
      suite.measurement_policy.min_unique_product_trials_per_job
    );
    const harness = jobResults.filter(result => result.classification === "harness_failure");
    const harnessFailureRate = jobResults.length === 0 ? null : harness.length / jobResults.length;
    const harnessReady = jobResults.length > 0
      && harness.every(result => result.trusted_harness_provenance)
      && harnessFailureRate <= suite.measurement_policy.max_harness_failure_rate;
    const stats = sampleStats(passed, product.length, independenceReady);
    return {
      job_id: job.id,
      attempted_trials: jobResults.length,
      product_trials: product.length,
      passed_trials: passed,
      failed_trials: product.length - passed,
      harness_failures: harness.length,
      harness_failure_rate: harnessFailureRate,
      ...stats,
      independence_ready: independenceReady,
      sample_size_ready: independenceReady,
      harness_ready: harnessReady,
    };
  });
  const productResults = results.filter(result => result.classification === "product_trial");
  const passed = productResults.filter(result => result.passed).length;
  const failureCounts = {};
  for (const result of productResults.filter(item => !item.passed)) {
    for (const check of result.checks.filter(item => !item.passed)) {
      failureCounts[check.id] = (failureCounts[check.id] ?? 0) + 1;
    }
  }
  const macroRates = byJob.map(item => item.pass_rate).filter(value => value !== null);
  const independenceReady = byJob.every(item => item.independence_ready);
  const trustReady = verifyTrajectoryAttestation(suite, {
    trial_set_id: trialSetId,
    suite_id: suite.suite_id,
    calibration,
    claim_boundary: claimBoundary,
    run_plan: runPlan,
    attestation,
    trials,
  });
  const harnessReady = byJob.every(item => item.harness_ready);
  return {
    suite_id: suite.suite_id,
    grader_version: TRAJECTORY_GRADER_VERSION,
    attempted_trials: results.length,
    product_trials: productResults.length,
    harness_failures: results.length - productResults.length,
    harness_failure_rate: results.length === 0 ? null : (results.length - productResults.length) / results.length,
    passed_trials: passed,
    product_statistics: sampleStats(passed, productResults.length, independenceReady),
    macro_pass_rate: macroRates.length === 0
      ? null
      : macroRates.reduce((sum, value) => sum + value, 0) / macroRates.length,
    suite_ready: validateTrajectorySuite(suite).length === 0,
    trust_ready: trustReady,
    independence_ready: independenceReady,
    harness_ready: harnessReady,
    sample_size_ready: independenceReady,
    by_job: byJob,
    failure_counts: failureCounts,
    results,
  };
}
