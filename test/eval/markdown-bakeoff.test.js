import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  runMarkdownBakeoff,
  validateFixtureBindings,
  validateMarkdownResult,
} from "../../scripts/eval-run-markdown-bakeoff.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_MANIFEST = path.join(REPO_ROOT, "test/fixtures/eval/extraction/manifest.v1.json");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function resultFor(binding) {
  const markdown = "<!-- PDF page 1 -->\n\nFixture text\n";
  return {
    structuredContent: {
      renderer: { name: "pdf-tools.layout-markdown-renderer", version: "1.0.0" },
      conversion_status: "complete",
      markdown,
      markdown_sha256: sha256(Buffer.from(markdown)),
      markdown_bytes: Buffer.byteLength(markdown),
      options: { include_page_boundaries: true },
      limits: { max_markdown_bytes: 200000 },
      pages: [{
        page: 1,
        conversion_status: "complete",
        markdown_bytes: Buffer.byteLength(markdown),
        line_count: 1,
        rendered_line_count: 1,
        gaps: [],
      }],
      gaps: [],
      limitations: [],
      provenance: {
        source: {
          file_name: binding.retained.filename,
          sha256: binding.retained.sha256,
          size_bytes: binding.retained.bytes,
        },
        layout: {
          name: "pdf-tools.extraction-ir",
          version: "1.0.0",
          parser_name: "pdfjs-dist",
          parser_version: "5.4.624",
          page_range: { start_page: 1, end_page: 1, total_pages: 1 },
        },
      },
      saved_output: null,
    },
  };
}

describe("packed Markdown bakeoff runner", () => {
  let root;
  let bindings;
  let manifest;
  let receipt;
  let options;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-markdown-bakeoff-"));
    await fs.chmod(root, 0o700);
    const fixtureRoot = path.join(root, "fixtures");
    const outputRoot = path.join(root, "output");
    await Promise.all([
      fs.mkdir(fixtureRoot, { mode: 0o700 }),
      fs.mkdir(outputRoot, { mode: 0o700 }),
    ]);

    const sourceManifest = JSON.parse(await fs.readFile(SOURCE_MANIFEST, "utf8"));
    manifest = structuredClone(sourceManifest);
    const retainedFixtures = [];
    for (const [index, fixture] of manifest.fixtures.entries()) {
      const source = path.resolve(path.dirname(SOURCE_MANIFEST), fixture.path);
      const sourceBytes = await fs.readFile(source);
      const retainedName = `source-${String(index + 1).padStart(3, "0")}-${fixture.sha256.slice(0, 12)}.pdf`;
      await fs.writeFile(path.join(fixtureRoot, retainedName), sourceBytes, { mode: 0o600, flag: "wx" });
      retainedFixtures.push({
        ordinal: index + 1,
        filename: retainedName,
        sha256: fixture.sha256,
        bytes: sourceBytes.length,
      });
    }
    receipt = {
      protocol: "pdf-tools.docling-macos-handoff.v1",
      handoff_id: "a".repeat(64),
      fixtures: retainedFixtures,
    };
    bindings = validateFixtureBindings(manifest, receipt);
    const manifestPath = path.join(root, "manifest.json");
    const receiptPath = path.join(root, "receipt.json");
    const artifactPath = path.join(root, "approved.mcpb");
    const artifactBytes = Buffer.from("test-only packed artifact binding\n");
    await Promise.all([
      fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: "wx" }),
      fs.writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: "wx" }),
      fs.writeFile(artifactPath, artifactBytes, { mode: 0o600, flag: "wx" }),
    ]);
    options = {
      "--artifact": artifactPath,
      "--artifact-sha256": sha256(artifactBytes),
      "--extension-root": REPO_ROOT,
      "--manifest": manifestPath,
      "--output": path.join(outputRoot, "report.json"),
      "--receipt": receiptPath,
    };
  });

  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("rejects receipt drift and malformed Markdown evidence", () => {
    const [binding] = bindings;
    const drifted = structuredClone(receipt);
    drifted.fixtures[0].sha256 = "b".repeat(64);
    expect(() => validateFixtureBindings(manifest, drifted)).toThrow(/differ/);

    expect(validateMarkdownResult(resultFor(binding), binding).markdown).toContain("Fixture text");
    const duplicatePage = resultFor(binding);
    duplicatePage.structuredContent.pages[0].page = 2;
    expect(() => validateMarkdownResult(duplicatePage, binding)).toThrow(/evidence is invalid/);
  });

  it("rejects an artifact whose bytes differ from the approved digest", async () => {
    await expect(runMarkdownBakeoff({
      ...options,
      "--artifact-sha256": "c".repeat(64),
    })).rejects.toThrow(/differs from the expected SHA-256/);
  });

  it("runs three distinct packed server processes and writes private canonical evidence", async () => {
    const summary = await runMarkdownBakeoff(options);
    expect(summary).toMatchObject({ cases: 8, output: options["--output"] });
    const bytes = await fs.readFile(options["--output"]);
    expect(summary.sha256).toBe(sha256(bytes));
    expect(bytes.at(-1)).toBe(0x0a);

    const report = JSON.parse(bytes.toString("utf8"));
    expect(report).toMatchObject({
      protocol: "pdf-tools.markdown-bakeoff.v1",
      repetitions_per_case: 3,
      artifact: { sha256: options["--artifact-sha256"], pdfjs_dist: "5.4.624" },
    });
    expect(report.cases).toHaveLength(8);
    for (const reportCase of report.cases) {
      expect(new Set(reportCase.runs.map(run => run.pid)).size).toBe(3);
      expect(new Set(reportCase.runs.map(run => run.result_sha256)).size).toBe(1);
    }
    expect(report.cases[0].runs[0].result.markdown).toContain("INV-1001");
    expect((await fs.lstat(options["--output"])).mode & 0o777).toBe(0o600);
    expect((await fs.readdir(path.join(root, "fixtures"))).sort()).toEqual(
      receipt.fixtures.map(item => item.filename).sort(),
    );
    expect((await fs.readdir(path.dirname(options["--output"]))).sort()).toEqual(["report.json"]);
  }, 120000);
});
