import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

const SHA256 = /^[a-f0-9]{64}$/;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function loadExtractionManifest(manifestPath, schemaPath) {
  const [manifestText, schemaText] = await Promise.all([
    fs.readFile(manifestPath, "utf8"),
    fs.readFile(schemaPath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const schema = JSON.parse(schemaText);
  const validation = new AjvJsonSchemaValidator().getValidator(schema)(manifest);
  if (!validation.valid) throw new Error(`Invalid extraction manifest: ${validation.errorMessage}`);

  const ids = new Set();
  for (const fixture of manifest.fixtures) {
    if (ids.has(fixture.id)) throw new Error(`Duplicate extraction fixture ID: ${fixture.id}`);
    ids.add(fixture.id);
    const fixturePath = resolveExtractionFixture(manifestPath, fixture);
    const digest = sha256(await fs.readFile(fixturePath));
    if (!SHA256.test(fixture.sha256) || digest !== fixture.sha256) {
      throw new Error(`Extraction fixture hash mismatch for ${fixture.id}`);
    }
    const targetValidation = new AjvJsonSchemaValidator().getValidator(fixture.target_schema)(fixture.ground_truth);
    if (!targetValidation.valid) {
      throw new Error(`Ground truth violates target schema for ${fixture.id}: ${targetValidation.errorMessage}`);
    }
  }
  return {
    manifest,
    manifest_sha256: sha256(Buffer.from(canonicalJson(manifest))),
    schema_sha256: sha256(Buffer.from(canonicalJson(schema))),
  };
}

export function resolveExtractionFixture(manifestPath, fixture) {
  const resolved = path.resolve(path.dirname(manifestPath), fixture.path);
  const root = path.resolve(path.dirname(manifestPath));
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Fixture escapes extraction root: ${fixture.path}`);
  return resolved;
}
