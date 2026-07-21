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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "comparison", "manifest.v1.json");

function intersects(left, right) {
  return left[0] < right[0] + right[2] && left[0] + left[2] > right[0]
    && left[1] < right[1] + right[3] && left[1] + left[3] > right[1];
}

describe("canonical comparison observations", () => {
  let manifest;
  let documents;

  beforeAll(async () => {
    manifest = await loadComparisonManifest(MANIFEST_PATH);
    documents = new Map();
    for (const document of manifest.documents) {
      documents.set(document.id, await inspectComparisonDocument(
        resolveComparisonDocumentPath(MANIFEST_PATH, document),
        manifest.canonical_renderer
      ));
    }
  }, 30_000);

  it("binds the literal canonical renderer profile", () => {
    expect(rendererFingerprint(manifest.canonical_renderer)).toMatch(/^[a-f0-9]{64}$/);
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

  it("reproduces every truth-bound visual crop digest from raw RGBA", () => {
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
          expect(beforeDigest, `${event.id} before`).toBe(facet.before?.value_sha256 ?? null);
          expect(afterDigest, `${event.id} after`).toBe(facet.after?.value_sha256 ?? null);
        }
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
  });
});
