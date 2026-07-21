import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { generateFixtures } from "../../scripts/eval-generate-fixtures.mjs";
import { runEvaluation } from "../../scripts/eval-run.mjs";
import {
  loadFixtureManifest,
  resolveFixturePath,
  selectFixtures,
  validateFixtureManifest,
} from "./fixture-manifest.js";
import {
  scoreDocumentStructure,
  scoreFileSideEffects,
  scorePageGeometry,
  scoreTextExtraction,
  snapshotFilesystem,
} from "./scorers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "manifest.v1.json");
const SCHEMA_PATH = path.join(REPO_ROOT, "test", "fixtures", "eval", "manifest.schema.json");
const temporaryDirectories = [];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function temporaryDirectory(prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe("evaluation corpus v0.1.0", () => {
  let manifest;

  beforeAll(async () => {
    manifest = await loadFixtureManifest(MANIFEST_PATH);
  });

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory =>
      fs.rm(directory, { recursive: true, force: true })
    ));
  });

  it("publishes a schema requiring provenance, license, privacy, partition, category, and expectations", async () => {
    const schema = JSON.parse(await fs.readFile(SCHEMA_PATH, "utf8"));
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$defs.fixture.required).toEqual(expect.arrayContaining([
      "id",
      "provenance",
      "license",
      "privacy",
      "partition",
      "category",
      "expected",
    ]));

    expect(validateFixtureManifest(manifest)).toEqual([]);
    expect(new Set(manifest.fixtures.map(fixture => fixture.id)).size).toBe(manifest.fixtures.length);
    expect(new Set(manifest.fixtures.map(fixture => fixture.partition))).toEqual(
      new Set(["development", "held_out_release"])
    );
  });

  it("rejects ambiguous license, privacy, and partition metadata", () => {
    const invalid = structuredClone(manifest);
    delete invalid.fixtures[0].license;
    invalid.fixtures[1].privacy.contains_personal_data = true;
    invalid.fixtures[2].partition = "train";
    delete invalid.fixtures[3].provenance.source_url;
    invalid.fixtures[1].expected.geometry.pages = [];
    const errors = validateFixtureManifest(invalid);

    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("license must be an object"),
      expect.stringContaining("contains_personal_data must be false"),
      expect.stringContaining("partition must be one of"),
      expect.stringContaining("source_url must be explicit"),
      expect.stringContaining("geometry.pages must be a non-empty array"),
    ]));
  });

  it("references the existing public golden fixture instead of copying it", async () => {
    const fixture = manifest.fixtures.find(item => item.id === "pdf-tools.eval.v1.irs-w9-2014");
    const fixturePath = resolveFixturePath(MANIFEST_PATH, fixture);
    expect(fixturePath).toBe(path.join(REPO_ROOT, "example-fw9.pdf"));
    expect(fixture.provenance.reused_from).toBe("test/fixtures/golden-forms/expected.json#example-fw9");
    expect(sha256(await fs.readFile(fixturePath))).toBe(fixture.sha256);
  });

  it("keeps held-out release fixtures out of the default development selection", () => {
    const development = selectFixtures(manifest);
    const heldOut = selectFixtures(manifest, "held_out_release");
    expect(development.length).toBeGreaterThan(0);
    expect(heldOut.length).toBeGreaterThan(0);
    expect(development.every(fixture => fixture.partition === "development")).toBe(true);
    expect(heldOut.every(fixture => fixture.partition === "held_out_release")).toBe(true);
    expect(development.map(fixture => fixture.id)).not.toEqual(expect.arrayContaining(
      heldOut.map(fixture => fixture.id)
    ));
  });

  it("regenerates every synthetic fixture byte-for-byte", async () => {
    const outputDirectory = await temporaryDirectory("pdf-tools-eval-generate-");
    await generateFixtures(outputDirectory);

    for (const fixture of manifest.fixtures.filter(item => item.provenance.kind === "synthetic")) {
      const generatedPath = path.join(outputDirectory, path.basename(fixture.path));
      expect(sha256(await fs.readFile(generatedPath)), fixture.id).toBe(fixture.sha256);
    }
  });

  it("catches a visibly reversed document that passes superficial structure checks", async () => {
    const correct = manifest.fixtures.find(item => item.id === "pdf-tools.eval.v1.dev-page-order-source");
    const wrong = manifest.fixtures.find(item => item.id === "pdf-tools.eval.v1.dev-page-order-visibly-wrong");
    const wrongPath = resolveFixturePath(MANIFEST_PATH, wrong);

    const structure = await scoreDocumentStructure(wrongPath, correct.expected.document);
    const geometry = await scorePageGeometry(wrongPath, correct.expected.geometry);
    const extraction = await scoreTextExtraction(wrongPath, correct.expected.extraction);

    expect(structure.passed).toBe(true);
    expect(structure.checks.find(item => item.id === "page_count")).toMatchObject({
      passed: true,
      expected: 2,
      actual: 2,
    });
    expect(geometry.passed).toBe(false);
    expect(geometry.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "page_1_media_box_width", passed: false, expected: 360, actual: 480 }),
      expect.objectContaining({ id: "page_1_rotation", passed: false, expected: 0, actual: 90 }),
    ]));
    expect(extraction.passed).toBe(false);
    expect(extraction.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "page_1_contains_PAGE ONE - PORTRAIT",
        passed: false,
        actual: "PAGE TWO - ROTATED",
      }),
    ]));
  });

  it("rejects unexpected files and mutation of an input file", async () => {
    const root = await temporaryDirectory("pdf-tools-eval-effects-");
    await fs.mkdir(path.join(root, "input"), { recursive: true });
    await fs.writeFile(path.join(root, "input", "source.pdf"), "fixed input bytes");
    const before = await snapshotFilesystem(root);
    await fs.mkdir(path.join(root, "output"), { recursive: true });
    await fs.writeFile(path.join(root, "output", "page-plan.pdf"), "candidate output bytes");

    const expected = manifest.fixtures.find(
      item => item.id === "pdf-tools.eval.v1.dev-page-order-source"
    ).expected.file_side_effects;
    const valid = scoreFileSideEffects(before, await snapshotFilesystem(root), expected);
    expect(valid.passed).toBe(true);

    await fs.writeFile(path.join(root, "output", "unexpected.tmp"), "partial output");
    const unexpected = scoreFileSideEffects(before, await snapshotFilesystem(root), expected);
    expect(unexpected.passed).toBe(false);
    expect(unexpected.checks.find(item => item.id === "created_files").actual).toEqual([
      "output/page-plan.pdf",
      "output/unexpected.tmp",
    ]);

    await fs.rm(path.join(root, "output", "unexpected.tmp"));
    await fs.writeFile(path.join(root, "input", "source.pdf"), "mutated input bytes");
    const mutated = scoreFileSideEffects(before, await snapshotFilesystem(root), expected);
    expect(mutated.passed).toBe(false);
    expect(mutated.checks.find(item => item.id === "unchanged_input/source.pdf").passed).toBe(false);
  });

  it("runs only the development partition by default", async () => {
    const development = await runEvaluation({ manifestPath: MANIFEST_PATH });
    expect(development.passed).toBe(true);
    expect(development.partition).toBe("development");
    expect(development.results.some(item => item.expected_outcome === "fail")).toBe(true);
    expect(development.results.every(item => item.partition === "development")).toBe(true);
    expect(development.results.every(item => item.sha256_matches)).toBe(true);
    expect(development.results.some(item => item.id === "pdf-tools.eval.v1.release-geometry")).toBe(false);
  });
});
