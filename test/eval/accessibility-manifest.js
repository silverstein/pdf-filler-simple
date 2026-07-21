import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^v\d+\.\d+\.\d+$/;
const ID = /^pdf-tools\.accessibility\.v1\.[a-z0-9-]+$/;
const PARTITIONS = ["development", "adversarial"];
const CLAIM_STATES = ["structural_failures_detected", "no_structural_failures_detected"];

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function validateAccessibilityManifest(manifest) {
  const errors = [];
  if (!object(manifest)) return ["manifest must be an object"];
  if (manifest.manifest_version !== 1) errors.push("manifest.manifest_version must equal 1");
  if (!VERSION.test(manifest.corpus_version ?? "")) {
    errors.push("manifest.corpus_version must use vMAJOR.MINOR.PATCH format");
  }
  if (manifest.taxonomy_path !== "claim-taxonomy.v1.json") {
    errors.push("manifest.taxonomy_path must equal claim-taxonomy.v1.json");
  }
  if (!SHA256.test(manifest.taxonomy_sha256 ?? "")) {
    errors.push("manifest.taxonomy_sha256 must be a lowercase SHA-256 digest");
  }
  if (!Array.isArray(manifest.fixtures) || manifest.fixtures.length === 0) {
    return [...errors, "manifest.fixtures must be a non-empty array"];
  }

  const ids = new Set();
  for (const [index, fixture] of manifest.fixtures.entries()) {
    const at = `manifest.fixtures[${index}]`;
    if (!object(fixture)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    if (!ID.test(fixture.id ?? "")) errors.push(`${at}.id must be a stable v1 ID`);
    if (ids.has(fixture.id)) errors.push(`${at}.id duplicates ${fixture.id}`);
    ids.add(fixture.id);
    const normalizedPath = nonEmptyString(fixture.path) ? path.normalize(fixture.path) : "";
    if (!nonEmptyString(fixture.path) || path.isAbsolute(fixture.path)
      || normalizedPath === ".." || normalizedPath.startsWith(`..${path.sep}`)) {
      errors.push(`${at}.path must be a non-empty manifest-relative path`);
    }
    if (!SHA256.test(fixture.sha256 ?? "")) errors.push(`${at}.sha256 must be a lowercase SHA-256 digest`);
    if (fixture.media_type !== "application/pdf") errors.push(`${at}.media_type must be application/pdf`);
    if (!PARTITIONS.includes(fixture.partition)) errors.push(`${at}.partition is not recognized`);
    if (!nonEmptyString(fixture.description)) errors.push(`${at}.description must be non-empty`);

    if (!object(fixture.provenance)) {
      errors.push(`${at}.provenance must be an object`);
    } else {
      if (!["public", "synthetic"].includes(fixture.provenance.kind)) errors.push(`${at}.provenance.kind is not recognized`);
      if (!nonEmptyString(fixture.provenance.origin)) errors.push(`${at}.provenance.origin must be non-empty`);
      if (!Object.hasOwn(fixture.provenance, "source_url")) errors.push(`${at}.provenance.source_url must be explicit`);
      if (!Object.hasOwn(fixture.provenance, "generator")) errors.push(`${at}.provenance.generator must be explicit`);
      if (fixture.provenance.kind === "synthetic" && !nonEmptyString(fixture.provenance.generator)) {
        errors.push(`${at}.provenance.generator is required for synthetic fixtures`);
      }
    }
    if (!object(fixture.license) || fixture.license.redistribution !== "allowed"
      || !nonEmptyString(fixture.license.name) || !nonEmptyString(fixture.license.spdx_id)
      || !nonEmptyString(fixture.license.url)) {
      errors.push(`${at}.license must explicitly permit redistribution`);
    }
    if (!object(fixture.privacy) || fixture.privacy.contains_personal_data !== false
      || !["public", "synthetic"].includes(fixture.privacy.class)
      || !nonEmptyString(fixture.privacy.notes)) {
      errors.push(`${at}.privacy must explicitly exclude personal data`);
    }
    if (!object(fixture.expected)) {
      errors.push(`${at}.expected must be an object`);
    } else {
      if (!["pass", "fail"].includes(fixture.expected.screen_status)) errors.push(`${at}.expected.screen_status is invalid`);
      if (!Array.isArray(fixture.expected.required_failure_ids)
        || fixture.expected.required_failure_ids.some(id => !nonEmptyString(id))) {
        errors.push(`${at}.expected.required_failure_ids must be an array of IDs`);
      }
      if (fixture.expected.declared_pdfua_part !== null
        && (!Number.isInteger(fixture.expected.declared_pdfua_part) || fixture.expected.declared_pdfua_part < 1)) {
        errors.push(`${at}.expected.declared_pdfua_part must be a positive integer or null`);
      }
      if (!CLAIM_STATES.includes(fixture.expected.maximum_claim_state)) {
        errors.push(`${at}.expected.maximum_claim_state exceeds this lane's capability`);
      }
    }
  }
  if (!manifest.fixtures.some(item => item.partition === "development")) errors.push("manifest needs a development fixture");
  if (!manifest.fixtures.some(item => item.partition === "adversarial")) errors.push("manifest needs an adversarial fixture");
  return errors;
}

export async function loadAccessibilityManifest(manifestPath) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const errors = validateAccessibilityManifest(manifest);
  if (errors.length > 0) throw new Error(`Invalid accessibility manifest:\n- ${errors.join("\n- ")}`);
  const taxonomyPath = path.resolve(path.dirname(manifestPath), manifest.taxonomy_path);
  const taxonomyBytes = await fs.readFile(taxonomyPath);
  const taxonomyDigest = createHash("sha256").update(taxonomyBytes).digest("hex");
  if (taxonomyDigest !== manifest.taxonomy_sha256) {
    throw new Error(`Accessibility taxonomy SHA-256 mismatch: expected ${manifest.taxonomy_sha256}, received ${taxonomyDigest}`);
  }
  return manifest;
}

export function resolveAccessibilityFixturePath(manifestPath, fixture) {
  return path.resolve(path.dirname(manifestPath), fixture.path);
}
