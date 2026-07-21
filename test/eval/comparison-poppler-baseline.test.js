import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadComparisonManifest, resolveComparisonDocumentPath } from "./comparison-manifest.js";
import { buildPopplerComparisonSensor } from "./comparison-poppler-baseline.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "comparison", "manifest.v1.json");

describe("optional independent Poppler comparison sensor", () => {
  it("records absence explicitly or observes the material-text pair without metadata noise", async () => {
    const manifest = await loadComparisonManifest(MANIFEST_PATH);
    const documents = new Map(manifest.documents.map(document => [document.id, document]));
    const pair = manifest.pairs.find(item => item.role === "material_text");
    const sensor = await buildPopplerComparisonSensor({
      benchmarkId: manifest.benchmark_id,
      benchmarkVersion: manifest.benchmark_version,
      pairs: [{
        pairId: pair.id,
        beforePath: resolveComparisonDocumentPath(MANIFEST_PATH, documents.get(pair.before_document_id)),
        afterPath: resolveComparisonDocumentPath(MANIFEST_PATH, documents.get(pair.after_document_id)),
      }],
    });
    expect(sensor.benchmark_claim_ready).toBe(false);
    if (sensor.engine_status === "engine_unavailable") {
      expect(sensor.pairs).toEqual([]);
      return;
    }
    expect(sensor.engine.kind).toBe("external_cli");
    expect(sensor.engine.bundled).toBe(false);
    expect(sensor.pairs[0].observations).toEqual({
      normalized_text_equal: false,
      page_marker_order_equal: true,
      metadata_equal: true,
      same_position_raster_equal: false,
    });
  }, 30_000);
});
