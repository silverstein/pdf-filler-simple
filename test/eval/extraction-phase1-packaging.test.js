import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isForbiddenArchivePath } from "../../scripts/build-mcpb.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PHASE1_EVALUATION_ASSETS = [
  "docs/EXTRACTION_CANDIDATE_PROTOCOL.md",
  "docs/evidence/extraction-phase1-generations/execution-example/execution-index.v1.json",
  "scripts/eval-run-extraction-candidates.mjs",
  "scripts/eval-score-extraction-candidates.mjs",
  "scripts/eval-generate-extraction-layout-oracle.mjs",
  "scripts/eval-prepare-docling-macos-handoff.mjs",
  "test/eval/candidates/docling/adapter.py",
  "test/eval/candidates/docling/fetch_pinned_layout.py",
  "test/eval/candidates/docling/README.md",
  "test/eval/extraction-docling-adapter.test.js",
  "test/eval/extraction-docling-handoff.js",
  "test/eval/extraction-docling-handoff.test.js",
  "test/eval/extraction-phase1-corpus.js",
  "test/eval/extraction-phase1-corpus.test.js",
  "test/eval/extraction-phase1-execution-generation-verifier.js",
  "test/eval/extraction-phase1-generation-verifier-common.js",
  "test/eval/extraction-phase1-score-generation-verifier.js",
  "test/eval/extraction-phase1-generation-verifiers.test.js",
  "test/eval/extraction-phase1-layout-evidence.js",
  "test/eval/extraction-phase1-layout-evidence.test.js",
  "test/eval/extraction-phase1-report-verifier.js",
  "test/eval/extraction-phase1-scorer.js",
  "test/eval/extraction-phase1-scorer.test.js",
  "test/eval/extraction-phase1-artifacts.js",
  "test/eval/extraction-phase1-artifacts.test.js",
  "test/eval/extraction-phase1-companion.js",
  "test/eval/extraction-phase1-companion.test.js",
  "test/eval/extraction-phase1-publisher.js",
  "test/eval/extraction-phase1-publisher.test.js",
  "test/eval/extraction-phase1-test-artifacts.js",
  "test/eval/extraction-phase1-protocol.js",
  "test/eval/extraction-phase1.test.js",
  "test/eval/extraction-phase1-packaging.test.js",
  "test/fixtures/eval/extraction/phase1/candidate-request.schema.json",
  "test/fixtures/eval/extraction/phase1/candidate-response.schema.json",
  "test/fixtures/eval/extraction/phase1/candidate-registry.schema.json",
  "test/fixtures/eval/extraction/phase1/candidate-registry.v1.json",
  "test/fixtures/eval/extraction/phase1/run-plan.schema.json",
  "test/fixtures/eval/extraction/phase1/run-plan.v1.json",
  "test/fixtures/eval/extraction/phase1/report.schema.json",
  "test/fixtures/eval/extraction/phase1/corpus.schema.json",
  "test/fixtures/eval/extraction/phase1/layout-occurrence-oracle.schema.json",
  "test/fixtures/eval/extraction/phase1/layout-occurrence-oracle.v1.json",
  "test/fixtures/eval/extraction/phase1/scoring-oracle.schema.json",
  "test/fixtures/eval/extraction/phase1/scoring-oracle.v1.json",
  "test/fixtures/eval/extraction/phase1/score-report.schema.json",
  "test/fixtures/eval/extraction/phase1/score-index.schema.json",
  "test/fixtures/eval/extraction/phase1/artifact-config.schema.json",
  "test/fixtures/eval/extraction/phase1/artifact-inventory.schema.json",
  "test/fixtures/eval/extraction/phase1/execution-companion.schema.json",
  "test/fixtures/eval/extraction/phase1/execution-index.schema.json",
  "test/fixtures/eval/extraction/phase1/cross-device-receipt.schema.json",
  "test/fixtures/eval/extraction/phase1/generation-privacy.schema.json",
  "test/fixtures/eval/extraction/phase1/docling-candidate-config.schema.json",
  "test/fixtures/eval/extraction/phase1/docling-candidate-config.v1.json",
  "test/fixtures/eval/extraction/phase1/docling-export.synthetic.v1.json",
  "test/fixtures/eval/extraction/phase1/docling-handoff.schema.json",
  "test/fixtures/eval/extraction/phase1/mock-candidate.mjs"
];

describe("Phase 1 extraction evaluation packaging boundary", () => {
  it("rejects every Phase 1 evaluation asset from an MCPB production archive", () => {
    for (const relativePath of PHASE1_EVALUATION_ASSETS) {
      expect(isForbiddenArchivePath(relativePath), relativePath).toBe(true);
    }
  });

  it("keeps every Phase 1 evaluation asset outside the share archive allowlist", async () => {
    const source = await fs.readFile(path.join(REPO_ROOT, "package-for-friend.js"), "utf8");
    const block = source.match(/const SHARE_FILES = \[([\s\S]*?)\n\];/);
    expect(block).not.toBeNull();
    const shareFiles = [...block[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
    for (const relativePath of PHASE1_EVALUATION_ASSETS) {
      expect(relativePath.startsWith("pdf-toolkit-mcp-share/")).toBe(false);
      expect(shareFiles).not.toContain(relativePath);
    }
  });

  it("forbids run bundles, inventories, models, environments, and caches from production packaging", async () => {
    const privateAssets = [
      "docs/evidence/extraction-phase1-generations/execution-run/execution-report.v1.json",
      "docs/evidence/extraction-phase1-generations/execution-run/artifact-before-candidate.json",
      ".pdf-tools-extraction-cache/models/model.safetensors",
      ".pdf-tools-extraction-cache/environments/uv.lock",
      ".pdf-tools-extraction-cache/corpora/private.pdf",
      ".pdf-tools-extraction-cache/runs/execution-companion.v1.json",
    ];
    for (const relativePath of privateAssets) expect(isForbiddenArchivePath(relativePath), relativePath).toBe(true);
    const shareSource = await fs.readFile(path.join(REPO_ROOT, "package-for-friend.js"), "utf8");
    for (const relativePath of privateAssets) expect(shareSource).not.toContain(relativePath);
  });
});
