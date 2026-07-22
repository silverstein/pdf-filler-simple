import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isForbiddenArchivePath } from "../../scripts/build-mcpb.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PHASE1_EVALUATION_ASSETS = [
  "docs/EXTRACTION_CANDIDATE_PROTOCOL.md",
  "docs/evidence/extraction-phase1-sidecars.v1.json.preflight.json",
  "scripts/eval-run-extraction-candidates.mjs",
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
});
