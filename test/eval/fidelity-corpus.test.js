import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createComparisonAjv } from "./comparison-schema-ajv.js";
import {
  FIDELITY_CASE_IDS,
  loadFidelityManifest,
  resolveFidelityDocumentPath,
  validateFidelityManifest,
  verifyFidelityDocuments,
} from "./fidelity-manifest.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "fidelity", "manifest.v1.json");
const SCHEMA_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "fidelity", "manifest.schema.json");

function mutate(manifest, callback) {
  const copy = structuredClone(manifest);
  callback(copy);
  return copy;
}

describe("fidelity corpus contract", () => {
  it("passes strict JSON Schema and semantic validation", async () => {
    const [schema, manifest] = await Promise.all([SCHEMA_PATH, MANIFEST_PATH].map(async file => JSON.parse(await fs.readFile(file, "utf8"))));
    const validate = createComparisonAjv().compile(schema);
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(validateFidelityManifest(manifest)).toEqual([]);
  });

  it("binds exactly seven cases and every source fixture SHA-256", async () => {
    const manifest = await loadFidelityManifest(MANIFEST_PATH);
    expect(manifest.cases.map(item => item.id).sort()).toEqual([...FIDELITY_CASE_IDS].sort());
    const bindings = await verifyFidelityDocuments(MANIFEST_PATH, manifest);
    expect(bindings.every(item => item.passed), JSON.stringify(bindings)).toBe(true);
  });

  it("rejects denominator, engine, gate, metadata, mask, and fault weakening", async () => {
    const manifest = await loadFidelityManifest(MANIFEST_PATH);
    expect(validateFidelityManifest(mutate(manifest, copy => { copy.cases.pop(); })))
      .toContain("manifest.cases must contain exactly the seven v1 case ids");
    expect(validateFidelityManifest(mutate(manifest, copy => { copy.measurement_policy.repetitions = 1; })))
      .toContain("manifest.measurement_policy.repetitions must be 3");
    expect(validateFidelityManifest(mutate(manifest, copy => { copy.measurement_policy.required_engine_families[1] = "pdfjs"; }))[0])
      .toMatch(/independent pdfjs and poppler/);
    expect(validateFidelityManifest(mutate(manifest, copy => { copy.cases[0].required_gates.pop(); })).some(error => error.includes("required_gates differs"))).toBe(true);
    expect(validateFidelityManifest(mutate(manifest, copy => { copy.cases[0].semantics[0].metadata.allowed_change_keys.push("Title"); })).some(error => error.includes("classify every"))).toBe(true);
    expect(validateFidelityManifest(mutate(manifest, copy => { copy.cases[0].intended_regions[0].region = [0, 0, 612, 792]; })).some(error => error.includes("overbroad mask"))).toBe(true);
    expect(validateFidelityManifest(mutate(manifest, copy => { copy.cases.at(-1).fault_actions = []; })).some(error => error.includes("missing-backup"))).toBe(true);
  });

  it("rejects escaped fixture paths", async () => {
    const manifest = await loadFidelityManifest(MANIFEST_PATH);
    const escaped = { ...manifest.documents[0], path: "../../../private.pdf" };
    expect(() => resolveFidelityDocumentPath(MANIFEST_PATH, escaped)).toThrow(/escapes/);
  });
});
