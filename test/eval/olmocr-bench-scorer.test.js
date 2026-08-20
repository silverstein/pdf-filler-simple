import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  fuzzyIncludes,
  scoreOlmocrBench,
  scoreOlmocrTest,
  typedGapCoversFailure,
} from "./olmocr-bench-scorer.js";

const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "eval",
  "olmocr",
);

describe("olmOCR-bench retained scorer profile", () => {
  it("keeps the pinned external manifest schema-valid and arithmetically complete", async () => {
    const [manifest, schema] = await Promise.all([
      fs.readFile(path.join(FIXTURE_ROOT, "manifest.v1.json"), "utf8").then(JSON.parse),
      fs.readFile(path.join(FIXTURE_ROOT, "manifest.schema.json"), "utf8").then(JSON.parse),
    ]);
    const validate = new Ajv2020({ strict: false }).compile(schema);
    expect(validate(manifest), validate.errors?.map(error => error.message).join("; ")).toBe(true);
    expect(manifest.source.categories.reduce((total, category) => total + category.test_count, 0))
      .toBe(manifest.execution.required_test_count);
    expect(manifest.reference_run.expected.overall).toEqual({
      pass: 921,
      failed_flagged: 2922,
      failed_silent: 3176,
    });
    expect(Object.values(manifest.reference_run.expected.overall).reduce((left, right) => left + right, 0))
      .toBe(manifest.execution.required_test_count);
    expect(manifest.benchmark_claim_ready).toBe(false);
    expect(manifest.claim_boundary.public_benchmark_claim).toBe("prohibited");
  });

  it("applies bounded edit distance without turning unrelated text into a match", () => {
    expect(fuzzyIncludes("fidelity", "high fidel1ty output", 1)).toBe(true);
    expect(fuzzyIncludes("fidelity", "high facility output", 1)).toBe(false);
  });

  it("keeps presence and order case-sensitive while absence is case-insensitive", () => {
    const record = { markdown: "Alpha then Omega", gaps: [] };
    expect(scoreOlmocrTest({ type: "present", text: "alpha", max_diffs: 0 }, record)).toBe("failed_silent");
    expect(scoreOlmocrTest({ type: "absent", text: "alpha", max_diffs: 0 }, record)).toBe("failed_silent");
    expect(scoreOlmocrTest({ type: "order", before: "Alpha", after: "Omega", max_diffs: 0 }, record)).toBe("pass");
  });

  it("applies first_n and last_n to normalized output", () => {
    expect(scoreOlmocrTest(
      { type: "present", text: "start", first_n: 5, max_diffs: 0 },
      { markdown: " start   middle end ", gaps: [] },
    )).toBe("pass");
    expect(scoreOlmocrTest(
      { type: "present", text: "end", last_n: 3, max_diffs: 0 },
      { markdown: " start   middle end ", gaps: [] },
    )).toBe("pass");
  });

  it("scores retained Markdown table adjacency and headings", () => {
    const record = { markdown: "| Region | Q1 |\n| --- | --- |\n| North | 42 |", gaps: [] };
    expect(scoreOlmocrTest({
      type: "table",
      cell: "42",
      left: "North",
      top_heading: "Q1",
      max_diffs: 0,
    }, record)).toBe("pass");
  });

  it("attributes only evidence-relevant typed gaps", () => {
    expect(typedGapCoversFailure("math", new Set(["MATH_NOT_RECONSTRUCTED"]))).toBe(true);
    expect(typedGapCoversFailure("present", new Set(["MATH_NOT_RECONSTRUCTED"]))).toBe(false);
    expect(typedGapCoversFailure("table", new Set(["TABLE_TOPOLOGY_UNKNOWN"]))).toBe(true);
    expect(typedGapCoversFailure("absent", new Set(["PAGE_FURNITURE_REMOVED"]))).toBe(false);
  });

  it("makes the three buckets exhaustive and keeps math separate", () => {
    const report = scoreOlmocrBench({
      tests: [
        { id: "p", category: "text", pdf: "a.pdf", type: "present", text: "yes" },
        { id: "a", category: "text", pdf: "a.pdf", type: "absent", text: "bad" },
        { id: "m", category: "math", pdf: "b.pdf", type: "math", math: "x=y" },
      ],
      records: [
        { pdf: "a.pdf", ok: true, markdown: "yes bad", gaps: [] },
        { pdf: "b.pdf", ok: true, markdown: "x", gaps: [{ code: "MATH_NOT_RECONSTRUCTED" }] },
      ],
      runQualifying: true,
    });
    expect(report.headline_excluding_math_proxy).toMatchObject({ n: 2, pass: 1, failed_silent: 1 });
    expect(report.math_proxy).toMatchObject({ n: 1, failed_flagged: 1 });
    expect(report.overall_including_math_proxy).toMatchObject({ n: 3, pass: 1, failed_flagged: 1, failed_silent: 1 });
    expect(report.qualifying).toBe(true);
    expect(report.benchmark_claim_ready).toBe(false);
    expect(report.claim_boundary.public_benchmark_claim).toBe("prohibited");
  });

  it("does not qualify incomplete or failed conversion runs", () => {
    const report = scoreOlmocrBench({
      tests: [{ id: "p", category: "text", pdf: "a.pdf", type: "present", text: "yes" }],
      records: [{ pdf: "a.pdf", ok: false, markdown: "", gaps: [] }],
      runQualifying: true,
    });
    expect(report.qualifying).toBe(false);
    expect(report.overall_including_math_proxy.not_run).toBe(1);
  });
});
