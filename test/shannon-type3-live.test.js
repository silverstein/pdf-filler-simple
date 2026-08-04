import path from "node:path";
import { describe, expect, it } from "vitest";
import { hashBoundedPdfFileSafely } from "../server/bounded-pdf-file.js";
import {
  createPdfjsSubprocessRequest,
  runPdfjsSubprocess,
} from "../server/pdfjs-subprocess.js";

const SOURCE = process.env.PDF_TOOLS_SHANNON_SOURCE;
const SOURCE_SHA256 = "6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8";

describe("external Shannon Type-3 recovery", () => {
  it.runIf(Boolean(SOURCE))("recovers only the exact registered glyph groups through the isolated worker", async () => {
    const sourceFile = await hashBoundedPdfFileSafely(SOURCE, 250 * 1024 * 1024, {
      assertPathAllowed: candidate => candidate,
    });
    expect(sourceFile.sha256).toBe(SOURCE_SHA256);
    const source = {
      canonical_path: sourceFile.canonicalPath,
      file_identity: sourceFile.fileIdentity,
      sha256: sourceFile.sha256,
      size_bytes: sourceFile.sizeBytes,
    };
    const counts = new Map();
    for (let startPage = 1; startPage <= 55; startPage += 10) {
      const endPage = Math.min(55, startPage + 9);
      const response = await runPdfjsSubprocess(createPdfjsSubprocessRequest({
        operation: "extract_layout_for_markdown",
        source,
        password: null,
        allowedDirectories: [path.dirname(SOURCE)],
        options: {
          source_path: SOURCE,
          source_file_name: path.basename(SOURCE),
          start_page: startPage,
          end_page: endPage,
          max_items: 5000,
          max_characters: 100_000,
          max_output_characters: 200_000,
        },
      }), { timeoutMs: 30_000 });
      for (const page of response.layout.pages) {
        for (const item of page.raw_items) {
          for (const recovery of item.glyph_recoveries ?? []) {
            counts.set(recovery.registry_id, (counts.get(recovery.registry_id) ?? 0) + 1);
          }
        }
      }
    }
    expect(Object.fromEntries([...counts].sort())).toEqual({
      "cmmi-pk-raster-comma-42b5eb-v1": 315,
      "cmmi-pk-raster-comma-dec7c4-v1": 26,
      "cmmi-pk-raster-omega-81b411-v1": 6,
      "cmmi-pk-raster-omega-v1": 9,
      "cmmi-pk-raster-period-2df559-v1": 345,
      "cmmi-pk-raster-period-bd8a8b-v1": 6,
      "cmmi-pk-raster-period-v1": 6,
      "cmmi-pk-raster-pi-3d439e-v1": 2,
      "cmmi-pk-raster-pi-780b04-v1": 55,
      "cmmi-pk-raster-pi-994283-v1": 1,
      "cmmi-pk-raster-rho-1500df-v1": 27,
      "cmmi-pk-raster-rho-ee4042-v1": 5,
      "cmmi-pk-raster-rho-fa4a3d-v1": 4,
      "cmmi-pk-raster-slash-55447d-v1": 8,
      "cmmi-pk-raster-slash-f5b035-v1": 13,
      "cmmi-pk-raster-slash-v1": 2,
      "cmsy-pk-raster-greater-equal-05b4a9-v1": 22,
      "cmsy-pk-raster-greater-equal-b57ae2-v1": 1,
      "cmsy-pk-raster-minus-fb1f6b-v1": 216,
      "cmsy-pk-raster-minus-v1": 14,
      "cmsy-pk-raster-square-root-0c8ca6-v1": 1,
      "cmsy-pk-raster-square-root-772f49-v1": 27,
    });
  }, 60_000);
});
