import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  benchmarkMarkdownBody,
  evaluateOlmocrRegressionGate,
  fuzzyIncludes,
  scoreOlmocrBench,
  scoreOlmocrTest,
  typedGapCoversFailure,
} from "./olmocr-bench-scorer.js";
import {
  canonicalJson,
  validateRunReport,
} from "../../scripts/eval-olmocr-bench.mjs";

const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "eval",
  "olmocr",
);

describe("olmOCR-bench directional scorer and retained compatibility profile", () => {
  const runReport = () => {
    const runtimeSources = [
      { path: "package.json", size_bytes: 1, sha256: "a".repeat(64) },
      { path: "server/index.js", size_bytes: 1, sha256: "b".repeat(64) },
    ].sort((left, right) => left.path.localeCompare(right.path));
    const runtime = {
      node: "v22.0.0",
      v8: "12.0",
      icu: "75.1",
      unicode: "15.1",
      modules: "127",
      napi: "9",
      platform: "linux",
      architecture: "x64",
      locale: "en-US",
      time_zone: "UTC",
      node_executable_size_bytes: 1,
      node_executable_sha256: "e".repeat(64),
    };
    const packages = [{
      name: "@modelcontextprotocol/sdk",
      version: "1.30.0",
      package_json_size_bytes: 1,
      package_json_sha256: "f".repeat(64),
    }];
    const dependencies = {
      package_lock_sha256: "1".repeat(64),
      packages,
      installed_tree: { entry_count: 1, file_bytes: 1, sha256: "2".repeat(64) },
      sha256: createHash("sha256").update(Buffer.from(canonicalJson(packages))).digest("hex"),
    };
    const evaluatorFiles = [
      "package-lock.json",
      "package.json",
      "scripts/eval-no-network.cjs",
      "scripts/eval-olmocr-bench.mjs",
      "test/eval/olmocr-bench-scorer.js",
      "test/fixtures/eval/olmocr/manifest.schema.json",
    ].sort().map((file, index) => ({
      path: file,
      size_bytes: 1,
      sha256: String(index + 2).repeat(64),
    }));
    const evaluatorIdentity = { files: evaluatorFiles, runtime, dependencies };
    const isolationPolicy = [
      "--unshare-net", "--die-with-parent", "--new-session", "--ro-bind", "/", "/",
      "--dev", "/dev", "--proc", "/proc", "--bind", "$ISOLATED_HOME", "$ISOLATED_HOME",
    ];
    return {
      schema: "pdf-tools.olmocr-bench-run.v1",
      manifest_sha256: "c".repeat(64),
      manifest_size_bytes: 1,
      corpus: {},
      evaluator: {
        ...evaluatorIdentity,
        sha256: createHash("sha256").update(Buffer.from(canonicalJson(evaluatorIdentity))).digest("hex"),
        candidate_network_policy: {
          mode: "os-process-tree-no-network-v1",
          environment: "minimal-allowlist-v1",
          preload_sha256: evaluatorFiles.find(file => file.path === "scripts/eval-no-network.cjs").sha256,
          isolation: {
            mechanism: "bubblewrap-unshare-net-v1",
            scope: "candidate-and-descendants",
            binary_path: "/usr/bin/bwrap",
            binary_size_bytes: 1,
            binary_sha256: "3".repeat(64),
            policy_sha256: createHash("sha256")
              .update(Buffer.from(canonicalJson(isolationPolicy))).digest("hex"),
          },
        },
      },
      candidate: {
        git_revision: "d".repeat(40),
        git_clean: true,
        git_tree_verified: true,
        runtime_source_sha256: createHash("sha256")
          .update(Buffer.from(canonicalJson(runtimeSources))).digest("hex"),
        runtime_sources: runtimeSources,
        runtime,
        dependencies,
      },
      selection: { full: true, pdf_count: 1 },
      qualifying: true,
      records: [{
        pdf: "a.pdf",
        ok: true,
        outcome: "converted",
        markdown: "text",
        gaps: [],
        status: "complete",
        pages: [{ page: 1, conversion_status: "complete", line_count: 1, rendered_line_count: 1 }],
      }],
    };
  };

  it("keeps the pinned external manifest schema-valid and arithmetically complete", async () => {
    const [manifest, schema] = await Promise.all([
      fs.readFile(path.join(FIXTURE_ROOT, "manifest.v1.json"), "utf8").then(JSON.parse),
      fs.readFile(path.join(FIXTURE_ROOT, "manifest.schema.json"), "utf8").then(JSON.parse),
    ]);
    const validate = new Ajv2020({ strict: false }).compile(schema);
    expect(validate(manifest), validate.errors?.map(error => error.message).join("; ")).toBe(true);
    expect(manifest.source.categories.reduce((total, category) => total + category.test_count, 0))
      .toBe(manifest.execution.required_test_count);
    expect(manifest.reference_run.historical_compatibility_expected.overall).toEqual({
      pass: 921,
      failed_flagged: 2922,
      failed_silent: 3176,
    });
    expect(Object.values(manifest.reference_run.historical_compatibility_expected.overall)
      .reduce((left, right) => left + right, 0))
      .toBe(manifest.execution.required_test_count);
    expect(manifest.benchmark_claim_ready).toBe(false);
    expect(manifest.claim_boundary.public_benchmark_claim).toBe("prohibited");
  });

  it("applies bounded edit distance without turning unrelated text into a match", () => {
    expect(fuzzyIncludes("fidelity", "high fidel1ty output", 1)).toBe(true);
    expect(fuzzyIncludes("fidelity", "high facility output", 1)).toBe(false);
    expect(fuzzyIncludes("𝑥=1", "we set 𝑥=2 here", 1)).toBe(true);
    expect(fuzzyIncludes("𝑥=1", "we set 𝑦=1 here", 1)).toBe(true);
  });

  it("rejects self-asserted qualification and failed structured conversions", () => {
    expect(validateRunReport(runReport()).qualifying).toBe(true);
    const failed = runReport();
    failed.records[0] = {
      ...failed.records[0],
      ok: false,
      outcome: "product_failure",
      status: "failed",
      error: "conversion_status=failed",
    };
    expect(() => validateRunReport(failed)).toThrow(/qualifying flag contradicts/u);
    const contradictory = runReport();
    contradictory.records[0].status = "failed";
    contradictory.records[0].pages[0].conversion_status = "failed";
    expect(() => validateRunReport(contradictory)).toThrow(/contradictory conversion state/u);
    const inventedGap = runReport();
    inventedGap.records[0].status = "partial";
    inventedGap.records[0].pages[0].conversion_status = "partial";
    inventedGap.records[0].gaps = [{ code: "NOT_A_REAL_GAP", message: "invented", page: 1 }];
    expect(() => validateRunReport(inventedGap)).toThrow(/invalid typed-gap evidence/u);
    const impossibleGap = runReport();
    impossibleGap.records[0].gaps = [{ code: "TEXT_LAYER_FAILED", message: "impossible", page: 1 }];
    expect(() => validateRunReport(impossibleGap)).toThrow(/contradictory conversion state/u);
  });

  it("honors explicit case sensitivity for both presence and absence", () => {
    const record = { markdown: "Alpha then Omega", gaps: [] };
    expect(scoreOlmocrTest({ type: "present", text: "alpha", max_diffs: 0 }, record)).toBe("failed_silent");
    expect(scoreOlmocrTest({ type: "absent", text: "alpha", case_sensitive: true, max_diffs: 0 }, record)).toBe("pass");
    expect(scoreOlmocrTest({ type: "absent", text: "alpha", case_sensitive: false, max_diffs: 0 }, record)).toBe("failed_silent");
    expect(scoreOlmocrTest({ type: "order", before: "Alpha", after: "Omega", max_diffs: 0 }, record)).toBe("pass");
  });

  it("applies and concatenates first_n and last_n windows for presence and absence", () => {
    expect(scoreOlmocrTest(
      { type: "present", text: "start", first_n: 5, max_diffs: 0 },
      { markdown: " start   middle end ", gaps: [] },
    )).toBe("pass");
    expect(scoreOlmocrTest(
      { type: "present", text: "end", last_n: 3, max_diffs: 0 },
      { markdown: " start   middle end ", gaps: [] },
    )).toBe("pass");
    expect(scoreOlmocrTest(
      { type: "present", text: "end", first_n: 5, last_n: 3, max_diffs: 0 },
      { markdown: "start middle end", gaps: [] },
    )).toBe("pass");
    expect(scoreOlmocrTest(
      { type: "absent", text: "footer", first_n: 5, case_sensitive: false, max_diffs: 0 },
      { markdown: "start middle footer", gaps: [] },
    )).toBe("pass");
  });

  it("accepts any ordered pair rather than only the first occurrences", () => {
    expect(scoreOlmocrTest(
      { type: "order", before: "Alpha", after: "Omega", max_diffs: 0 },
      { markdown: "Omega then Alpha then Omega", gaps: [] },
    )).toBe("pass");
    expect(scoreOlmocrTest(
      { type: "order", before: "abc", after: "bc", max_diffs: 1 },
      { markdown: "bc", gaps: [] },
    )).toBe("failed_silent");
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
    expect(typedGapCoversFailure("absent", new Set(["TEXT_LAYER_FAILED"]))).toBe(false);
    expect(typedGapCoversFailure("present", new Set(["OCR_NOT_PERFORMED", "IMAGE_CONTENT_NOT_RENDERED"]))).toBe(false);
    expect(typedGapCoversFailure("present", new Set(["SOURCE_CHARACTER_LIMIT_REACHED"]))).toBe(true);
    expect(typedGapCoversFailure("present", new Set(["TEXT_LAYER_FAILED"]))).toBe(true);
    expect(typedGapCoversFailure("present", new Set(["PAGE_RANGE_INCOMPLETE"]))).toBe(true);
  });

  it("credits OCR gaps only when the scored page body is actually empty", () => {
    const gaps = [{ code: "OCR_NOT_PERFORMED" }, { code: "IMAGE_CONTENT_NOT_RENDERED" }];
    expect(scoreOlmocrTest(
      { type: "present", text: "missing", max_diffs: 0 },
      { markdown: "ordinary extracted text", gaps },
    )).toBe("failed_silent");
    expect(scoreOlmocrTest(
      { type: "present", text: "missing", max_diffs: 0 },
      { markdown: "[No source-backed text was available on this page.]", gaps },
    )).toBe("failed_flagged");
    expect(scoreOlmocrTest(
      { type: "absent", text: "forbidden", max_diffs: 0 },
      { markdown: "forbidden", gaps },
    )).toBe("failed_silent");
  });

  it("removes toolkit-authored page markers and diagnostics from the scored body", () => {
    const markdown = "<!-- PDF page 1 -->\n\nSource text\n\n## Conversion gaps\n\n- Page 1: diagnostic\n\n## Conversion limitations\n\n- boilerplate";
    expect(benchmarkMarkdownBody(markdown)).toBe("Source text");
    expect(scoreOlmocrTest(
      { type: "baseline" },
      { markdown: "<!-- PDF page 1 -->\n\n[No source-backed text was available on this page.]\n\n## Conversion limitations\n\n- boilerplate", gaps: [] },
    )).toBe("failed_silent");
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
      gatePolicy: {
        id: "test-policy",
        reference: {
          headline_excluding_math_proxy: { pass: 1, failed_silent: 1 },
          math_proxy: { failed_silent: 0 },
          by_category: {},
        },
      },
    });
    expect(report.headline_excluding_math_proxy).toMatchObject({ n: 2, pass: 1, failed_silent: 1 });
    expect(report.math_proxy).toMatchObject({ n: 1, failed_flagged: 1 });
    expect(report.overall_including_math_proxy).toMatchObject({ n: 3, pass: 1, failed_flagged: 1, failed_silent: 1 });
    expect(report.qualifying).toBe(true);
    expect(report.benchmark_claim_ready).toBe(false);
    expect(report.claim_boundary.public_benchmark_claim).toBe("prohibited");
    expect(report.release_regression_gate.passed).toBe(true);
  });

  it("does not qualify incomplete or failed conversion runs", () => {
    const report = scoreOlmocrBench({
      tests: [{ id: "p", category: "text", pdf: "a.pdf", type: "present", text: "yes" }],
      records: [{ pdf: "a.pdf", ok: false, markdown: "", gaps: [] }],
      runQualifying: true,
    });
    expect(report.qualifying).toBe(false);
    expect(report.overall_including_math_proxy.not_run).toBe(1);
    expect(report.overall_including_math_proxy.attempted).toBe(0);
    expect(report.overall_including_math_proxy.pass_pct).toBeNull();
    expect(report.release_regression_gate.passed).toBe(false);
  });

  it("fails the release gate on a pass regression or silent-failure increase", () => {
    const gate = evaluateOlmocrRegressionGate({
      qualifying: true,
      headline_excluding_math_proxy: { pass: 9, failed_silent: 4 },
      math_proxy: { failed_silent: 2 },
      by_category: { text: { pass: 9, failed_silent: 4 } },
    }, {
      id: "test-policy",
      reference: {
        headline_excluding_math_proxy: { pass: 10, failed_silent: 3 },
        math_proxy: { failed_silent: 2 },
        by_category: { text: { pass: 10, failed_silent: 3 } },
      },
    });
    expect(gate.passed).toBe(false);
    expect(gate.checks.filter(check => !check.pass).map(check => check.id)).toEqual([
      "headline_pass",
      "headline_failed_silent",
      "category_text_pass",
      "category_text_failed_silent",
    ]);
  });
});
