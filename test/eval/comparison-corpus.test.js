import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { PDFArray, PDFDocument, PDFName } from "pdf-lib";
import { afterEach, describe, expect, it } from "vitest";
import { generateComparisonFixtures } from "../../scripts/eval-generate-comparison-fixtures.mjs";
import {
  COMPARISON_ROLES,
  loadComparisonManifest,
  resolveComparisonDocumentPath,
  validateComparisonManifest,
  verifyComparisonDocuments,
} from "./comparison-manifest.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "comparison", "manifest.v1.json");
const SCHEMA_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "comparison", "manifest.schema.json");
const temporaryDirectories = [];

function mutate(manifest, callback) {
  const copy = structuredClone(manifest);
  callback(copy);
  return copy;
}

function pair(manifest, role) {
  return manifest.pairs.find(item => item.role === role);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true })));
});

describe("comparison corpus contract", () => {
  it("passes both the JSON Schema and independent fail-closed validator", async () => {
    const [schemaText, manifestText] = await Promise.all([
      fs.readFile(SCHEMA_PATH, "utf8"),
      fs.readFile(MANIFEST_PATH, "utf8"),
    ]);
    const schema = JSON.parse(schemaText);
    const manifest = JSON.parse(manifestText);
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validate = ajv.compile(schema);
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(validateComparisonManifest(manifest)).toEqual([]);
  });

  it("contains every required v1 role exactly once across both partitions", async () => {
    const manifest = await loadComparisonManifest(MANIFEST_PATH);
    expect(manifest.pairs.map(item => item.role).sort()).toEqual([...COMPARISON_ROLES].sort());
    expect(new Set(manifest.pairs.map(item => item.partition))).toEqual(
      new Set(["development", "held_out_release"])
    );
    expect(pair(manifest, "identical").events).toEqual([]);
    expect(pair(manifest, "form_annotation").events.map(event => event.facets[0].channel).sort())
      .toEqual(["annotation", "form_field"]);
  });

  it("binds every committed PDF to its exact SHA-256", async () => {
    const manifest = await loadComparisonManifest(MANIFEST_PATH);
    const results = await verifyComparisonDocuments(MANIFEST_PATH, manifest);
    expect(results).toHaveLength(7);
    expect(results.every(item => item.passed), JSON.stringify(results, null, 2)).toBe(true);
  });

  it("reproduces every fixture byte-for-byte in an isolated directory", async () => {
    const manifest = await loadComparisonManifest(MANIFEST_PATH);
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-comparison-"));
    temporaryDirectories.push(temporary);
    const generated = await generateComparisonFixtures(temporary);
    expect(generated).toHaveLength(7);
    for (const document of manifest.documents) {
      const committed = await fs.readFile(resolveComparisonDocumentPath(MANIFEST_PATH, document));
      const regenerated = await fs.readFile(path.join(temporary, path.basename(document.path)));
      expect(Buffer.compare(committed, regenerated), document.id).toBe(0);
    }
  });

  it("contains the intended form, annotation, metadata, and reorder signals", async () => {
    const manifest = await loadComparisonManifest(MANIFEST_PATH);
    const documentById = new Map(manifest.documents.map(document => [document.id, document]));
    const load = async id => PDFDocument.load(
      await fs.readFile(resolveComparisonDocumentPath(MANIFEST_PATH, documentById.get(id)))
    );
    const base = await load("pdf-tools.comparison.document.base");
    const formAnnotation = await load("pdf-tools.comparison.document.form-annotation-after");
    const metadata = await load("pdf-tools.comparison.document.metadata-only-after");
    const reordered = await load("pdf-tools.comparison.document.pages-reordered-after");

    expect(base.getForm().getTextField("ReviewStatus").getText() ?? "").toBe("");
    expect(formAnnotation.getForm().getTextField("ReviewStatus").getText()).toBe("Approved");
    const annotationSubtypes = formAnnotation.getPages().flatMap(page => {
      const annots = page.node.Annots();
      if (!(annots instanceof PDFArray)) return [];
      return annots.asArray().map(reference =>
        formAnnotation.context.lookup(reference).get(PDFName.of("Subtype"))?.toString()
      );
    });
    expect(annotationSubtypes).toContain("/Text");
    expect(metadata.getTitle()).toBe("Synthetic comparison agreement — reviewed");
    expect(reordered.getPageCount()).toBe(2);
    expect(reordered.getForm().getFields()).toHaveLength(1);
  });
});

describe("comparison manifest hostile mutations", () => {
  it("rejects unknown keys, missing roles, duplicate truth IDs, and escaped paths", async () => {
    const manifest = await loadComparisonManifest(MANIFEST_PATH);
    expect(validateComparisonManifest(mutate(manifest, copy => { copy.untrusted = true; })))
      .toContain("manifest unknown keys: untrusted");
    expect(validateComparisonManifest(mutate(manifest, copy => { copy.pairs.pop(); })))
      .toContain("manifest.pairs must contain exactly the seven v1 roles");
    expect(validateComparisonManifest(mutate(manifest, copy => {
      pair(copy, "material_text").events[1].id = pair(copy, "material_text").events[0].id;
    }))).toContain("manifest.pairs[1].events[1].id duplicates truth.monthly-fee");
    const escaped = mutate(manifest, copy => { copy.documents[0].path = "../private.pdf"; });
    expect(validateComparisonManifest(escaped).some(error => error.includes(".path is invalid"))).toBe(true);
    expect(() => resolveComparisonDocumentPath(MANIFEST_PATH, escaped.documents[0])).toThrow(/escapes/);
  });

  it("rejects answer-key weakening and candidate-friendly renderer drift", async () => {
    const manifest = await loadComparisonManifest(MANIFEST_PATH);
    const missingFacet = mutate(manifest, copy => {
      pair(copy, "material_text").events[0].facets = pair(copy, "material_text").events[0].facets
        .filter(facet => facet.channel !== "semantic");
    });
    expect(validateComparisonManifest(missingFacet).some(error => error.includes("no mandatory semantic facet"))).toBe(true);

    const wrongHash = mutate(manifest, copy => {
      pair(copy, "material_text").events[0].facets[0].before.document_sha256 = "0".repeat(64);
    });
    expect(validateComparisonManifest(wrongHash).some(error => error.includes("does not bind"))).toBe(true);

    const rendererDrift = mutate(manifest, copy => { copy.canonical_renderer.pixel_delta_threshold = 255; });
    expect(validateComparisonManifest(rendererDrift))
      .toContain("manifest.canonical_renderer differs from canonical v1");
  });

  it("rejects merging the form and annotation truths into one convenient event", async () => {
    const manifest = await loadComparisonManifest(MANIFEST_PATH);
    const collapsed = mutate(manifest, copy => {
      const target = pair(copy, "form_annotation");
      target.events[0].facets.push(target.events[1].facets[0]);
      target.events.pop();
    });
    expect(validateComparisonManifest(collapsed))
      .toContain("form_annotation must contain separate field and annotation truth events");
  });
});
