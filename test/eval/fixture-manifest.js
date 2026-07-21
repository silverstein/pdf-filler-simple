import fs from "node:fs/promises";
import path from "node:path";

export const MANIFEST_VERSION = 1;
export const PARTITIONS = Object.freeze(["development", "held_out_release"]);
export const PRIVACY_CLASSES = Object.freeze(["public", "synthetic"]);
export const CATEGORIES = Object.freeze([
  "public_golden_form",
  "page_order_regression",
  "page_geometry",
]);

const STABLE_ID = /^pdf-tools\.eval\.v1\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CORPUS_VERSION = /^v\d+\.\d+\.\d+$/;

function requireObject(value, location, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${location} must be an object`);
    return false;
  }
  return true;
}

function requireString(value, location, errors) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${location} must be a non-empty string`);
  }
}

function requireExplicitNullableString(object, key, location, errors) {
  if (!Object.hasOwn(object, key)) {
    errors.push(`${location}.${key} must be explicit (string or null)`);
  } else if (object[key] !== null && typeof object[key] !== "string") {
    errors.push(`${location}.${key} must be a string or null`);
  }
}

function requireHttpUrl(value, location, errors) {
  requireString(value, location, errors);
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported protocol");
  } catch {
    errors.push(`${location} must be an HTTP(S) URL`);
  }
}

function validateBox(box, location, errors) {
  if (!requireObject(box, location, errors)) return;
  for (const coordinate of ["x", "y", "width", "height"]) {
    if (typeof box[coordinate] !== "number" || !Number.isFinite(box[coordinate])) {
      errors.push(`${location}.${coordinate} must be a finite number`);
    }
  }
  if (!(box.width > 0) || !(box.height > 0)) {
    errors.push(`${location} width and height must be positive`);
  }
}

function validateExpected(expected, location, errors) {
  if (expected.document && requireObject(expected.document, `${location}.document`, errors)) {
    if (!Number.isInteger(expected.document.page_count) || expected.document.page_count < 1) {
      errors.push(`${location}.document.page_count must be a positive integer`);
    }
  }
  if (expected.geometry && requireObject(expected.geometry, `${location}.geometry`, errors)) {
    if (typeof expected.geometry.tolerance_points !== "number"
      || expected.geometry.tolerance_points < 0
      || expected.geometry.tolerance_points > 1) {
      errors.push(`${location}.geometry.tolerance_points must be between 0 and 1`);
    }
    if (!Array.isArray(expected.geometry.pages) || expected.geometry.pages.length === 0) {
      errors.push(`${location}.geometry.pages must be a non-empty array`);
    } else {
      for (const [index, page] of expected.geometry.pages.entries()) {
        const pageLocation = `${location}.geometry.pages[${index}]`;
        if (!requireObject(page, pageLocation, errors)) continue;
        if (!Number.isInteger(page.page) || page.page < 1) {
          errors.push(`${pageLocation}.page must be a positive integer`);
        }
        if (![0, 90, 180, 270].includes(page.rotation)) {
          errors.push(`${pageLocation}.rotation must be 0, 90, 180, or 270`);
        }
        validateBox(page.media_box, `${pageLocation}.media_box`, errors);
        validateBox(page.crop_box, `${pageLocation}.crop_box`, errors);
      }
    }
  }
  if (expected.extraction && requireObject(expected.extraction, `${location}.extraction`, errors)) {
    if (!Array.isArray(expected.extraction.pages) || expected.extraction.pages.length === 0) {
      errors.push(`${location}.extraction.pages must be a non-empty array`);
    } else {
      for (const [index, page] of expected.extraction.pages.entries()) {
        const pageLocation = `${location}.extraction.pages[${index}]`;
        if (!requireObject(page, pageLocation, errors)) continue;
        if (!Number.isInteger(page.page) || page.page < 1) {
          errors.push(`${pageLocation}.page must be a positive integer`);
        }
        if (!Array.isArray(page.required_text) || page.required_text.length === 0
          || page.required_text.some(value => typeof value !== "string" || value.length === 0)) {
          errors.push(`${pageLocation}.required_text must contain non-empty strings`);
        }
      }
    }
  }
  if (expected.file_side_effects
    && requireObject(expected.file_side_effects, `${location}.file_side_effects`, errors)) {
    for (const effect of ["created", "modified", "deleted", "unchanged"]) {
      const values = expected.file_side_effects[effect];
      if (!Array.isArray(values) || values.some(value => typeof value !== "string" || value.length === 0)) {
        errors.push(`${location}.file_side_effects.${effect} must be an array of non-empty paths`);
      }
    }
  }
}

export function validateFixtureManifest(manifest) {
  const errors = [];
  if (!requireObject(manifest, "manifest", errors)) return errors;
  if (manifest.manifest_version !== MANIFEST_VERSION) {
    errors.push(`manifest.manifest_version must equal ${MANIFEST_VERSION}`);
  }
  requireString(manifest.corpus_version, "manifest.corpus_version", errors);
  if (typeof manifest.corpus_version === "string" && !CORPUS_VERSION.test(manifest.corpus_version)) {
    errors.push("manifest.corpus_version must use vMAJOR.MINOR.PATCH format");
  }
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
    errors.push("manifest.fixtures must be a non-empty array");
    return errors;
  }

  const ids = new Set();
  const partitionCounts = new Map(PARTITIONS.map(partition => [partition, 0]));
  for (const [index, fixture] of manifest.fixtures.entries()) {
    const location = `manifest.fixtures[${index}]`;
    if (!requireObject(fixture, location, errors)) continue;
    requireString(fixture.id, `${location}.id`, errors);
    if (typeof fixture.id === "string" && !STABLE_ID.test(fixture.id)) {
      errors.push(`${location}.id is not a stable v1 fixture ID`);
    }
    if (ids.has(fixture.id)) errors.push(`${location}.id duplicates ${fixture.id}`);
    ids.add(fixture.id);

    requireString(fixture.path, `${location}.path`, errors);
    if (typeof fixture.path === "string" && path.isAbsolute(fixture.path)) {
      errors.push(`${location}.path must be manifest-relative`);
    }
    if (!SHA256.test(fixture.sha256 ?? "")) {
      errors.push(`${location}.sha256 must be a lowercase SHA-256 digest`);
    }
    if (fixture.media_type !== "application/pdf") {
      errors.push(`${location}.media_type must be application/pdf`);
    }
    requireString(fixture.description, `${location}.description`, errors);
    if (!PARTITIONS.includes(fixture.partition)) {
      errors.push(`${location}.partition must be one of ${PARTITIONS.join(", ")}`);
    } else {
      partitionCounts.set(fixture.partition, partitionCounts.get(fixture.partition) + 1);
    }
    if (!CATEGORIES.includes(fixture.category)) {
      errors.push(`${location}.category is not recognized`);
    }
    if (!["pass", "fail"].includes(fixture.expected_outcome)) {
      errors.push(`${location}.expected_outcome must be pass or fail`);
    }
    if (fixture.expected_outcome === "fail") {
      requireString(fixture.failure_class, `${location}.failure_class`, errors);
    }

    if (requireObject(fixture.provenance, `${location}.provenance`, errors)) {
      requireString(fixture.provenance.kind, `${location}.provenance.kind`, errors);
      if (!["public", "synthetic"].includes(fixture.provenance.kind)) {
        errors.push(`${location}.provenance.kind must be public or synthetic`);
      }
      requireString(fixture.provenance.origin, `${location}.provenance.origin`, errors);
      requireExplicitNullableString(fixture.provenance, "source_url", `${location}.provenance`, errors);
      requireExplicitNullableString(fixture.provenance, "generator", `${location}.provenance`, errors);
      requireExplicitNullableString(fixture.provenance, "reused_from", `${location}.provenance`, errors);
      if (typeof fixture.provenance.source_url === "string") {
        requireHttpUrl(fixture.provenance.source_url, `${location}.provenance.source_url`, errors);
      }
      if (fixture.provenance.kind === "synthetic") {
        requireString(fixture.provenance.generator, `${location}.provenance.generator`, errors);
      }
    }
    if (requireObject(fixture.license, `${location}.license`, errors)) {
      requireString(fixture.license.name, `${location}.license.name`, errors);
      requireString(fixture.license.spdx_id, `${location}.license.spdx_id`, errors);
      requireHttpUrl(fixture.license.url, `${location}.license.url`, errors);
      if (fixture.license.redistribution !== "allowed") {
        errors.push(`${location}.license.redistribution must be allowed for committed fixtures`);
      }
    }
    if (requireObject(fixture.privacy, `${location}.privacy`, errors)) {
      if (!PRIVACY_CLASSES.includes(fixture.privacy.class)) {
        errors.push(`${location}.privacy.class must be one of ${PRIVACY_CLASSES.join(", ")}`);
      }
      if (fixture.privacy.contains_personal_data !== false) {
        errors.push(`${location}.privacy.contains_personal_data must be false`);
      }
      requireString(fixture.privacy.notes, `${location}.privacy.notes`, errors);
    }
    if (requireObject(fixture.expected, `${location}.expected`, errors)) {
      if (!fixture.expected.document
        && !fixture.expected.geometry
        && !fixture.expected.extraction
        && !fixture.expected.file_side_effects) {
        errors.push(`${location}.expected must declare at least one scorer contract`);
      }
      validateExpected(fixture.expected, `${location}.expected`, errors);
    }
  }

  for (const [partition, count] of partitionCounts) {
    if (count === 0) errors.push(`manifest must contain at least one ${partition} fixture`);
  }
  return errors;
}

export async function loadFixtureManifest(manifestPath) {
  const text = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(text);
  const errors = validateFixtureManifest(manifest);
  if (errors.length > 0) {
    throw new Error(`Invalid evaluation fixture manifest:\n- ${errors.join("\n- ")}`);
  }
  return manifest;
}

export function selectFixtures(manifest, partition = "development") {
  if (!PARTITIONS.includes(partition)) {
    throw new Error(`Unknown partition ${partition}; expected one of ${PARTITIONS.join(", ")}`);
  }
  return manifest.fixtures.filter(fixture => fixture.partition === partition);
}

export function resolveFixturePath(manifestPath, fixture) {
  return path.resolve(path.dirname(manifestPath), fixture.path);
}
