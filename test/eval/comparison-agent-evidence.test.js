import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  assertEvidenceOnlyDescendant,
  assertPrivacySafeProjection,
} from "../../scripts/eval-comparison-evidence-integrity.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE_ROOT = path.join(REPO_ROOT, "docs", "evidence", "comparison-v1");
const SUMMARY_PATH = path.join(EVIDENCE_ROOT, "codex-agent-evidence-summary.v1.json");
const REPORT_PATH = path.join(EVIDENCE_ROOT, "codex-trajectory-report.v1.json");
const SCHEMA_PATH = path.join(
  REPO_ROOT, "test", "fixtures", "eval", "comparison", "agent-evidence-summary.schema.json",
);

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("privacy-minimized Codex comparison evidence", () => {
  it("validates the projection schema and exact private-source bindings", async () => {
    const [summary, schema, reportBytes] = await Promise.all([
      readJson(SUMMARY_PATH),
      readJson(SCHEMA_PATH),
      fs.readFile(REPORT_PATH),
    ]);
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    ajv.addFormat("date-time", value => Number.isFinite(Date.parse(value)));
    expect(ajv.compile(schema)(summary)).toBe(true);
    expect(() => assertPrivacySafeProjection(summary)).not.toThrow();
    expect(summary.source_digests.trajectory_report_sha256).toBe(sha256(reportBytes));
    expect(summary.privacy_boundary).toMatchObject({
      projection: true,
      raw_evidence_published: false,
      raw_evidence_retention: "maintainer_private",
      external_replay_ready: false,
    });
  });

  it("preserves the complete three-run denominator and conservative gates", async () => {
    const [summary, report] = await Promise.all([readJson(SUMMARY_PATH), readJson(REPORT_PATH)]);
    expect(summary.denominator).toEqual({
      planned: 3,
      attempted: 3,
      product_trials: 3,
      harness_failures: 0,
    });
    expect(summary.runs.map(run => run.repeat_index)).toEqual([1, 2, 3]);
    expect(report.results.map(result => result.repeat_index)).toEqual([1, 2, 3]);
    expect(report.results.every(result => result.classification === "product_trial" && result.passed)).toBe(true);
    expect(summary.result).toEqual({ passed_trials: 3, pass_rate: 1, sample_variance: 0 });
    expect(Object.values(summary.claim_gates).every(value => value === false)).toBe(true);
  });

  it("retains evidence identities, exact required calls, and zero side effects", async () => {
    const summary = await readJson(SUMMARY_PATH);
    for (const run of summary.runs) {
      expect(run.tool_calls.map(step => step.tool)).toEqual([
        "read_pdf_pages",
        "read_pdf_pages",
        "render_pdf_page",
        "render_pdf_page",
      ]);
      expect(run.answer_value_sha256)
        .toBe("8f636ff257e0083d6e51c87fc0c60c50c928a342bc5f53b0ef28003ae54fa223");
      expect(run.render_evidence).toHaveLength(2);
      expect(run.render_evidence.every(item => item.visual_oracle.passed === true)).toBe(true);
      expect(run.effects).toEqual({
        created: 0,
        modified: 0,
        deleted: 0,
        external_requests: 0,
        signature_applied: false,
      });
    }
  });

  it("rejects host detail from a public projection", () => {
    for (const leaked of [
      { path: "/home/maintainer/private" },
      { host: "silvercloud" },
      { environment: { HOME: "/private" } },
      { transcript: "codex.jsonl" },
    ]) {
      expect(() => assertPrivacySafeProjection(leaked)).toThrow("forbidden host detail");
    }
  });

  it("allows only generated evidence after the measured source revision", () => {
    const base = "a".repeat(40);
    const head = "b".repeat(40);
    expect(() => assertEvidenceOnlyDescendant({
      sourceRevision: base,
      headRevision: head,
      changedPaths: [
        "docs/evidence/comparison-v1/comparison-decision.v1.json",
        "docs/evidence/comparison-v1/comparison-decision.v1.md",
      ],
    })).not.toThrow();

    for (const changedPath of [
      "server/index.js",
      "scripts/eval-run-codex-comparison.mjs",
      "scripts/eval-build-comparison-decision.mjs",
      "test/fixtures/eval/comparison/decision.schema.json",
      "test/eval/comparison-agent-evidence.test.js",
    ]) {
      expect(() => assertEvidenceOnlyDescendant({
        sourceRevision: base,
        headRevision: head,
        changedPaths: [changedPath],
      })).toThrow("non-evidence descendants");
    }
  });
});
