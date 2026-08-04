import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateShannonManifest } from "../../scripts/eval-run-shannon-markdown-bakeoff.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST = path.join(REPO_ROOT, "test/fixtures/eval/shannon/manifest.v1.json");

async function manifest() {
  return JSON.parse(await fs.readFile(MANIFEST, "utf8"));
}

describe("Shannon Markdown bakeoff manifest", () => {
  it("accepts the committed external-only source and exact candidate pins", async () => {
    expect(validateShannonManifest(await manifest())).toMatchObject({
      benchmark_claim_ready: false,
      calibration_claim_ready: false,
      source: { redistribution: "external_only", page_count: 55 },
      candidates: {
        pdf_inspector: { slot: "candidate.direct_pdf.v1" },
        layout_reference: { status: "not_run" },
      },
    });
  });

  it("rejects a non-Git revision or a public benchmark claim", async () => {
    const badRevision = await manifest();
    badRevision.candidates.pdf_inspector.revision = "a".repeat(64);
    expect(() => validateShannonManifest(badRevision)).toThrow("pdf-inspector candidate binding is invalid");

    const publicClaim = await manifest();
    publicClaim.benchmark_claim_ready = true;
    expect(() => validateShannonManifest(publicClaim)).toThrow("Shannon manifest claim boundary is invalid");
  });

  it("rejects redistribution and layout-reference overclaims", async () => {
    const redistributed = await manifest();
    redistributed.source.redistribution = "repository_fixture";
    expect(() => validateShannonManifest(redistributed)).toThrow("Shannon external source binding is invalid");

    const inventedReference = await manifest();
    inventedReference.candidates.layout_reference.status = "complete";
    expect(() => validateShannonManifest(inventedReference)).toThrow("Candidate slot projection is invalid");
  });

  it("rejects equation anchors without bounded page-local evidence", async () => {
    const missingPage = await manifest();
    delete missingPage.oracle.equation_anchors[0].page;
    expect(() => validateShannonManifest(missingPage)).toThrow("Shannon sampled oracle is invalid");

    const unbounded = await manifest();
    unbounded.oracle.equation_max_span_characters = 10000;
    expect(() => validateShannonManifest(unbounded)).toThrow("Shannon sampled oracle is invalid");
  });
});
