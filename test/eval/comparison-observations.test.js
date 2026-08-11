import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  loadComparisonManifest,
  resolveComparisonDocumentPath,
} from "./comparison-manifest.js";
import {
  cropComparisonRgba,
  diffComparisonRgba,
  inspectComparisonDocument,
  rendererFingerprint,
} from "./comparison-observations.js";
import {
  assertComparisonBenchmarkBinding,
  assertComparisonManifestBinding,
  classifyComparisonRenderer,
  loadComparisonReferenceRenderer,
} from "./comparison-reference-renderer.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "comparison", "manifest.v1.json");

function intersects(left, right) {
  return left[0] < right[0] + right[2] && left[0] + left[2] > right[0]
    && left[1] < right[1] + right[3] && left[1] + left[3] > right[1];
}

describe("canonical comparison observations", () => {
  let manifest;
  let documents;
  let referenceRenderer;
  let rendererClassification;

  beforeAll(async () => {
    manifest = await loadComparisonManifest(MANIFEST_PATH);
    referenceRenderer = await loadComparisonReferenceRenderer();
    assertComparisonBenchmarkBinding(manifest, referenceRenderer);
    await assertComparisonManifestBinding(MANIFEST_PATH, referenceRenderer);
    rendererClassification = classifyComparisonRenderer(
      manifest.canonical_renderer,
      referenceRenderer,
    );
    documents = new Map();
    for (const document of manifest.documents) {
      const inspected = await inspectComparisonDocument(
        resolveComparisonDocumentPath(MANIFEST_PATH, document),
        manifest.canonical_renderer
      );
      expect(inspected.sha256, document.id).toBe(document.sha256);
      documents.set(document.id, inspected);
    }
  }, 30_000);

  it("binds the literal renderer profile and classifies the current host", () => {
    expect(rendererFingerprint(manifest.canonical_renderer)).toMatch(/^[a-f0-9]{64}$/);
    expect(rendererClassification.actual.renderer_fingerprint_sha256)
      .toBe(rendererFingerprint(manifest.canonical_renderer));
    expect(rendererClassification.exact_reference)
      .toBe(rendererClassification.mismatches.length === 0);
    expect(manifest.canonical_renderer).toMatchObject({
      pdfjs_dist: "5.4.624",
      canvas: "0.1.99",
      scale: 2,
      dpi: 144,
      pixel_delta_threshold: 8,
      mask_dilation_pixels: 1,
      connected_components: 8,
      minimum_component_area_pixels: 4,
    });
  });

  it("makes identical and metadata-only pages pixel-identical", () => {
    const base = documents.get("pdf-tools.comparison.document.base");
    const metadata = documents.get("pdf-tools.comparison.document.metadata-only-after");
    expect(diffComparisonRgba(base.renders[0], base.renders[0], manifest.canonical_renderer))
      .toMatchObject({ dimension_mismatch: false, changed_pixels: 0, bounds: null });
    expect(metadata.renders.map(render => render.rgba_sha256))
      .toEqual(base.renders.map(render => render.rgba_sha256));
  });

  it("keeps normalized layout-noise text equal while preserving the raw visual delta", () => {
    const base = documents.get("pdf-tools.comparison.document.base");
    const layout = documents.get("pdf-tools.comparison.document.layout-noise-after");
    expect(layout.pages.map(page => page.text)).toEqual(base.pages.map(page => page.text));
    const difference = diffComparisonRgba(base.renders[0], layout.renders[0], manifest.canonical_renderer);
    expect(difference.changed_pixels).toBeGreaterThan(10_000);
    expect(difference.changed_fraction).toBeLessThan(0.02);
    expect(difference.raw_changed_pixels).toBeLessThan(difference.changed_pixels);
    expect(difference.components.length).toBeGreaterThan(1);
    expect(layout.renders[1].rgba_sha256).toBe(base.renders[1].rgba_sha256);
  });

  it("localizes visual-only changes inside the declared status region", () => {
    const base = documents.get("pdf-tools.comparison.document.base");
    const visual = documents.get("pdf-tools.comparison.document.visual-status-after");
    expect(visual.pages.map(page => page.text)).toEqual(base.pages.map(page => page.text));
    const difference = diffComparisonRgba(base.renders[0], visual.renders[0], manifest.canonical_renderer);
    expect(difference.changed_pixels).toBeGreaterThan(15_000);
    expect(intersects(difference.bounds, [72, 236, 140, 36])).toBe(true);
    expect(difference.bounds[2]).toBeLessThanOrEqual(140);
    expect(difference.bounds[3]).toBeLessThanOrEqual(36);
    expect(difference.components).toEqual([expect.objectContaining({
      area_pixels: difference.changed_pixels,
      bounds: [72, 236, 140, 36],
    })]);
  });

  it("treats frozen raw-RGBA truth digests as authoritative only on the reference renderer", () => {
    const observations = [];
    for (const pair of manifest.pairs) {
      const before = documents.get(pair.before_document_id);
      const after = documents.get(pair.after_document_id);
      for (const event of pair.events) {
        for (const facet of event.facets.filter(item => item.channel === "visual")) {
          const beforeDigest = facet.before ? cropComparisonRgba(
            before.renders[facet.before.page - 1], facet.before.region, manifest.canonical_renderer
          ).rgba_sha256 : null;
          const afterDigest = facet.after ? cropComparisonRgba(
            after.renders[facet.after.page - 1], facet.after.region, manifest.canonical_renderer
          ).rgba_sha256 : null;
          observations.push({
            label: `${event.id} before`,
            actual: beforeDigest,
            frozen: facet.before?.value_sha256 ?? null,
          }, {
            label: `${event.id} after`,
            actual: afterDigest,
            frozen: facet.after?.value_sha256 ?? null,
          });
        }
      }
    }
    const present = observations.filter(item => item.actual !== null || item.frozen !== null);
    if (rendererClassification.exact_reference) {
      for (const item of present) expect(item.actual, item.label).toBe(item.frozen);
      return;
    }
    // Off the reference renderer the frozen digests carry no authority, and
    // that is the whole claim. Whether they happen to reproduce anyway is an
    // observation, not a guarantee in either direction: a Linux runner
    // reproduced every one of them byte for byte while its fingerprint
    // mismatched, because the fingerprint binds platform, Node and N-API
    // alongside the two library versions, and is therefore strictly narrower
    // than the rasterization it identifies. Asserting divergence here made
    // cross-platform determinism read as a failure. The sibling reference
    // baseline already branches on whether raw visuals reproduced rather than
    // requiring that they do not; this matches it.
    expect(rendererClassification.mismatches).toContain("renderer_fingerprint_sha256");
    // What does not depend on the renderer is which facets have a digest at
    // all, so that stays asserted: a renderer may move the pixels, it may not
    // change the shape of the evidence.
    for (const item of present) {
      expect(item.actual === null, `${item.label} observed presence`).toBe(item.frozen === null);
      if (item.actual !== null) {
        expect(item.actual, `${item.label} actual`).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it("extracts page alignment, form, annotation, and metadata independently", () => {
    const base = documents.get("pdf-tools.comparison.document.base");
    const reordered = documents.get("pdf-tools.comparison.document.pages-reordered-after");
    const formAnnotation = documents.get("pdf-tools.comparison.document.form-annotation-after");
    const metadata = documents.get("pdf-tools.comparison.document.metadata-only-after");
    expect(base.pages.map(page => page.marker)).toEqual(["PAGE-ID: SERVICE", "PAGE-ID: APPENDIX"]);
    expect(reordered.pages.map(page => page.marker)).toEqual(["PAGE-ID: APPENDIX", "PAGE-ID: SERVICE"]);
    expect(base.fields[0].value).toBe("");
    expect(base.fields[0]).toMatchObject({ page: 1, region: [71.5, 331.5, 221, 31] });
    expect(formAnnotation.fields[0].value).toBe("Approved");
    expect(formAnnotation.annotations).toEqual([expect.objectContaining({
      page: 1,
      subtype: "/Text",
      contents: "Synthetic reviewer note: verify status.",
      region: [360, 332, 30, 30],
    })]);
    expect(metadata.metadata.Title).toBe("Synthetic comparison agreement — reviewed");
    expect(metadata.metadata.ModDate).toBe("2026-07-22T00:00:00.000Z");
    expect(Object.keys(metadata.metadata).filter(key => metadata.metadata[key] !== base.metadata[key]).sort())
      .toEqual(["ModDate", "Title"]);
  });
});
