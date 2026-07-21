import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  ACCESSIBILITY_CLAIM_GATE_VERSION,
  ACCESSIBILITY_RULES,
  ACCESSIBILITY_SCORER_ID,
  ACCESSIBILITY_SCORER_VERSION,
  validateAccessibilityTaxonomyContract,
} from "./accessibility-scorer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "eval",
  "accessibility",
  "manifest.schema.json"
);
const schema = JSON.parse(fsSync.readFileSync(SCHEMA_PATH, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateSchema = ajv.compile(schema);
const RULE_FAMILY_BY_ID = new Map(ACCESSIBILITY_RULES.map(rule => [rule.id, rule.family]));

function schemaErrors() {
  return (validateSchema.errors ?? []).map(error => {
    const location = error.instancePath ? `manifest${error.instancePath}` : "manifest";
    return `${location} ${error.message}`;
  });
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameValues(left, right) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function pathEscapes(relativePath) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) return true;
  const normalized = path.normalize(relativePath);
  return normalized === ".." || normalized.startsWith(`..${path.sep}`);
}

export function validateAccessibilityManifest(manifest) {
  if (!validateSchema(manifest)) return schemaErrors();
  const errors = [];
  const ids = new Set();
  for (const [index, fixture] of manifest.fixtures.entries()) {
    const at = `manifest.fixtures[${index}]`;
    if (ids.has(fixture.id)) errors.push(`${at}.id duplicates ${fixture.id}`);
    ids.add(fixture.id);
    if (pathEscapes(fixture.path)) errors.push(`${at}.path must stay within the manifest directory`);
    if (fixture.provenance.kind === "synthetic" && fixture.provenance.generator === null) {
      errors.push(`${at}.provenance.generator is required for synthetic fixtures`);
    }

    const unknownFailures = fixture.expected.expected_failure_ids.filter(id => !RULE_FAMILY_BY_ID.has(id));
    if (unknownFailures.length > 0) {
      errors.push(`${at}.expected.expected_failure_ids contain unknown rules: ${unknownFailures.join(", ")}`);
    }
    const derivedFamilies = [...new Set(fixture.expected.expected_failure_ids
      .map(id => RULE_FAMILY_BY_ID.get(id))
      .filter(Boolean))];
    if (!sameValues(derivedFamilies, fixture.expected.expected_rule_families)) {
      errors.push(`${at}.expected.expected_rule_families must exactly match expected_failure_ids`);
    }
    if (fixture.expected.screen_status === "pass" && fixture.expected.expected_failure_ids.length !== 0) {
      errors.push(`${at}.expected pass status cannot declare failures`);
    }
    if (fixture.expected.screen_status === "fail" && fixture.expected.expected_failure_ids.length === 0) {
      errors.push(`${at}.expected fail status must declare at least one failure`);
    }
    const expectedClaim = fixture.expected.screen_status === "pass"
      ? "no_structural_failures_detected"
      : "structural_failures_detected";
    if (fixture.expected.maximum_claim_state !== expectedClaim) {
      errors.push(`${at}.expected.maximum_claim_state conflicts with screen_status`);
    }
  }
  if (!manifest.fixtures.some(item => item.partition === "development")) {
    errors.push("manifest needs a development fixture");
  }
  if (!manifest.fixtures.some(item => item.partition === "adversarial")) {
    errors.push("manifest needs an adversarial fixture");
  }
  return errors;
}

async function resolveContainedRegularFile(rootPath, relativePath, label) {
  if (pathEscapes(relativePath)) throw new Error(`${label} path escapes its declared root`);
  const root = await fs.realpath(rootPath);
  const segments = path.normalize(relativePath).split(path.sep).filter(Boolean);
  let candidate = root;
  for (const segment of segments) {
    candidate = path.join(candidate, segment);
    const entry = await fs.lstat(candidate);
    if (entry.isSymbolicLink()) throw new Error(`${label} must not contain symbolic links`);
  }
  const resolved = await fs.realpath(candidate);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} resolves outside its declared root`);
  }
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  return resolved;
}

export async function loadAccessibilityManifest(manifestPath) {
  const resolvedManifest = await fs.realpath(manifestPath);
  const manifest = JSON.parse(await fs.readFile(resolvedManifest, "utf8"));
  const errors = validateAccessibilityManifest(manifest);
  if (errors.length > 0) throw new Error(`Invalid accessibility manifest:\n- ${errors.join("\n- ")}`);
  if (manifest.scorer_id !== ACCESSIBILITY_SCORER_ID
    || manifest.scorer_version !== ACCESSIBILITY_SCORER_VERSION
    || manifest.claim_gate_version !== ACCESSIBILITY_CLAIM_GATE_VERSION) {
    throw new Error("Accessibility manifest scorer/gate versions do not match executable versions");
  }

  const manifestDirectory = path.dirname(resolvedManifest);
  const taxonomyPath = await resolveContainedRegularFile(
    manifestDirectory,
    manifest.taxonomy_path,
    "Accessibility taxonomy"
  );
  const taxonomyBytes = await fs.readFile(taxonomyPath);
  const taxonomyDigest = createHash("sha256").update(taxonomyBytes).digest("hex");
  if (taxonomyDigest !== manifest.taxonomy_sha256) {
    throw new Error(`Accessibility taxonomy SHA-256 mismatch: expected ${manifest.taxonomy_sha256}, received ${taxonomyDigest}`);
  }
  const taxonomy = JSON.parse(taxonomyBytes.toString("utf8"));
  const taxonomyErrors = validateAccessibilityTaxonomyContract(taxonomy);
  if (taxonomyErrors.length > 0) {
    throw new Error(`Accessibility taxonomy/executable mismatch:\n- ${taxonomyErrors.join("\n- ")}`);
  }
  return { manifest, taxonomy, manifest_path: resolvedManifest };
}

export async function resolveAccessibilityFixturePath(manifestPath, fixture) {
  return resolveContainedRegularFile(
    path.dirname(await fs.realpath(manifestPath)),
    fixture.path,
    `Accessibility fixture ${fixture.id}`
  );
}
