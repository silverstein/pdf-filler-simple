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
      "cmex-pk-raster-Big-left-parenthesis-1784be-v1": 13,
      "cmex-pk-raster-Big-left-parenthesis-e0188e-v1": 2,
      "cmex-pk-raster-Big-right-parenthesis-741b0e-v1": 2,
      "cmex-pk-raster-Big-right-parenthesis-fd720e-v1": 13,
      "cmex-pk-raster-big-left-bracket-24e2fb-v1": 1,
      "cmex-pk-raster-big-left-bracket-add929-v1": 11,
      "cmex-pk-raster-big-left-parenthesis-eeae0f-v1": 11,
      "cmex-pk-raster-big-right-bracket-2810f1-v1": 1,
      "cmex-pk-raster-big-right-bracket-a23d3c-v1": 11,
      "cmex-pk-raster-big-right-parenthesis-9a0788-v1": 11,
      "cmex-pk-raster-bigg-left-bracket-2daf02-v1": 5,
      "cmex-pk-raster-bigg-left-bracket-42ccb4-v1": 2,
      "cmex-pk-raster-bigg-left-parenthesis-d0c76f-v1": 9,
      "cmex-pk-raster-bigg-right-bracket-50dd65-v1": 4,
      "cmex-pk-raster-bigg-right-bracket-ebfd69-v1": 2,
      "cmex-pk-raster-bigg-right-parenthesis-4787f4-v1": 9,
      "cmex-pk-raster-displaystyle-integral-4a183f-v1": 92,
      "cmex-pk-raster-textstyle-integral-e5fa9e-v1": 2,
      "cmmi-pk-raster-Delta-762215-v1": 3,
      "cmmi-pk-raster-alpha-bab8ae-v1": 22,
      "cmmi-pk-raster-alpha-c3d175-v1": 1,
      "cmmi-pk-raster-alpha-e688a8-v1": 26,
      "cmmi-pk-raster-comma-42b5eb-v1": 315,
      "cmmi-pk-raster-comma-7c69e2-v1": 5,
      "cmmi-pk-raster-comma-dec7c4-v1": 26,
      "cmmi-pk-raster-delta-a5a76e-v1": 31,
      "cmmi-pk-raster-delta-b41124-v1": 2,
      "cmmi-pk-raster-epsilon-376b93-v1": 44,
      "cmmi-pk-raster-epsilon-7c6298-v1": 3,
      "cmmi-pk-raster-eta-2fd7e5-v1": 13,
      "cmmi-pk-raster-eta-a19a51-v1": 3,
      "cmmi-pk-raster-lambda-2023b7-v1": 19,
      "cmmi-pk-raster-lambda-25c0ac-v1": 26,
      "cmmi-pk-raster-mu-2c7d9c-v1": 22,
      "cmmi-pk-raster-nu-f46329-v1": 1,
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
      "cmmi-pk-raster-sigma-94bd43-v1": 2,
      "cmmi-pk-raster-sigma-dae3aa-v1": 15,
      "cmmi-pk-raster-slash-55447d-v1": 8,
      "cmmi-pk-raster-slash-f5b035-v1": 13,
      "cmmi-pk-raster-slash-v1": 2,
      "cmmi-pk-raster-tau-53992a-v1": 3,
      "cmmi-pk-raster-theta-194bcc-v1": 16,
      "cmmi-pk-raster-theta-700332-v1": 5,
      "cmmi-pk-raster-variant-phi-117a85-v1": 8,
      "cmsy-pk-raster-centered-dot-33077f-v1": 66,
      "cmsy-pk-raster-greater-equal-05b4a9-v1": 22,
      "cmsy-pk-raster-greater-equal-b57ae2-v1": 1,
      "cmsy-pk-raster-less-or-equal-90da52-v1": 36,
      "cmsy-pk-raster-minus-0c8b34-v1": 64,
      "cmsy-pk-raster-minus-fb1f6b-v1": 222,
      "cmsy-pk-raster-minus-v1": 14,
      "cmsy-pk-raster-plus-or-minus-4dedb5-v1": 4,
      "cmsy-pk-raster-plus-or-minus-b68b24-v1": 1,
      "cmsy-pk-raster-prime-352207-v1": 45,
      "cmsy-pk-raster-right-arrow-6ff1e0-v1": 16,
      "cmsy-pk-raster-right-arrow-7d300b-v1": 19,
      "cmsy-pk-raster-square-root-0c8ca6-v1": 1,
      "cmsy-pk-raster-square-root-772f49-v1": 28,
      "cmsy-pk-raster-vertical-6ab8a7-v1": 32,
    });
  }, 60_000);
});
