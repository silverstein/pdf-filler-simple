import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { validateStructuredToolResult } from "../server/output-schemas.js";
import { derivePdfComparisonCoverage } from "../server/pdf-comparison.js";

/*
 * Coverage-honesty regressions for compare_pdfs. Three shipped bugs let the
 * engine report `supported` coverage and zero changes on content it never
 * actually compared:
 *
 *   Bug 1 — a page whose IR text layer or extraction failed/was partial (a
 *           scanned/image-only page) was still reported as fully covered by the
 *           semantic and text channels.
 *   Bug 2 — repeated/template pages the aligner refuses to pair are excluded
 *           from text and structure comparison, yet coverage stayed supported
 *           and `no_reported_changes` came back trivially green.
 *   Bug 3 — a widget's displayed appearance state (/AS) is captured on the
 *           observation but was never compared, so a change in it went
 *           undetected.
 *
 * The fixtures are the deterministic ones written by
 * scripts/eval-generate-comparison-coverage-fixtures.mjs.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COVERAGE = path.join(REPO_ROOT, "test/fixtures/eval/comparison/coverage");
const fixture = name => path.join(COVERAGE, name);

describe("compare_pdfs coverage honesty", () => {
  let client;
  let transport;

  beforeAll(async () => {
    client = new Client({ name: "compare-pdfs-coverage-test", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: { ...process.env, ALLOWED_DIRECTORIES: REPO_ROOT },
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
  });

  const compare = async (before, after, extra = {}) => client.callTool({
    name: "compare_pdfs",
    arguments: {
      before_pdf_path: before,
      after_pdf_path: after,
      include_visual: false,
      max_output_characters: 200_000,
      ...extra,
    },
  });

  describe("Bug 1 — IR page status degrades semantic and text coverage", () => {
    it("degrades to not-supported when a compared page has no readable text layer", async () => {
      // coverage-nontext.pdf is a single vector-only page: no text items, so its
      // IR text_layer_status is "empty" and extraction_status is "partial". The
      // text channel cannot observe that page, so semantic and text coverage
      // must not claim "supported".
      const result = await compare(fixture("coverage-text-before.pdf"), fixture("coverage-nontext.pdf"));
      expect(result.isError).not.toBe(true);
      expect(validateStructuredToolResult("compare_pdfs", result)).toBe(result);
      const { coverage } = result.structuredContent;
      expect(coverage.semantic.status).not.toBe("supported");
      expect(coverage.text.status).not.toBe("supported");
      expect(coverage.semantic.reason_codes).toContain("AFTER_EXTRACTION_PARTIAL");
      expect(coverage.text.reason_codes).toContain("AFTER_EXTRACTION_PARTIAL");
      expect(result.structuredContent.status).toBe("partial");
      expect(result.structuredContent.summary.no_reported_changes).toBe(false);
      expect(result.structuredContent.summary.equivalence_claim).toBe(false);
    }, 30_000);

    it("keeps supported coverage for a clean text-to-text comparison", async () => {
      // Both documents are pure single-page text layers (extraction_status
      // "complete"), so the honest answer is fully supported semantic and text
      // coverage even though the text itself changed.
      const result = await compare(fixture("coverage-text-before.pdf"), fixture("coverage-text-after.pdf"));
      expect(result.isError).not.toBe(true);
      expect(validateStructuredToolResult("compare_pdfs", result)).toBe(result);
      const { coverage } = result.structuredContent;
      expect(coverage.semantic).toEqual({ status: "supported", reason_codes: [] });
      expect(coverage.text).toEqual({ status: "supported", reason_codes: [] });
      // A pure text change is still detected; this is not a "nothing happened".
      expect(result.structuredContent.changes.length).toBeGreaterThan(0);
    }, 30_000);

    it("propagates a failed text layer as unavailable (not partial) coverage", () => {
      // A genuinely failed text layer cannot be produced with pdf-lib (it needs
      // a parser error), so this exercises derivePdfComparisonCoverage directly.
      // A "failed" status means the page produced no observable text at all, so
      // it must contribute the strongest degradation, "unavailable", while a
      // "partial" page contributes "partial".
      const supported = { status: "supported", reason_codes: [] };
      const observationCoverage = {
        pages: supported,
        metadata: supported,
        form_fields: supported,
        annotations: supported,
      };
      const document = (side, textLayerStatus, extractionStatus) => ({
        side,
        observation: { coverage: observationCoverage },
        layout: {
          truncation: { truncated: false },
          pages: [{
            truncation: { truncated: false },
            text_layer_status: textLayerStatus,
            extraction_status: extractionStatus,
          }],
        },
        renders: [],
      });

      const failed = derivePdfComparisonCoverage(
        [document("before", "failed", "failed"), document("after", "present", "complete")],
        false,
      );
      expect(failed.semantic.status).toBe("unavailable");
      expect(failed.text.status).toBe("unavailable");
      expect(failed.semantic.reason_codes).toEqual(
        expect.arrayContaining(["BEFORE_TEXT_LAYER_FAILED", "BEFORE_EXTRACTION_FAILED"]),
      );

      const partial = derivePdfComparisonCoverage(
        [document("before", "partial", "partial"), document("after", "present", "complete")],
        false,
      );
      expect(partial.semantic.status).toBe("partial");
      expect(partial.text.status).toBe("partial");
      expect(partial.text.reason_codes).toEqual(
        expect.arrayContaining(["BEFORE_TEXT_LAYER_PARTIAL", "BEFORE_EXTRACTION_PARTIAL"]),
      );

      const clean = derivePdfComparisonCoverage(
        [document("before", "present", "complete"), document("after", "present", "complete")],
        false,
      );
      expect(clean.semantic).toEqual({ status: "supported", reason_codes: [] });
      expect(clean.text).toEqual({ status: "supported", reason_codes: [] });
    });
  });

  describe("Bug 2 — repeated-page ambiguity degrades the skipped channels", () => {
    it("reports partial coverage and is not trivially green when pages go uncompared", async () => {
      // Both documents are two pages of identical text, so every page is a
      // repeated/template page the aligner refuses to pair. Nothing is compared,
      // but the old engine returned supported coverage and no_reported_changes.
      const result = await compare(fixture("coverage-repeated-before.pdf"), fixture("coverage-repeated-after.pdf"));
      expect(result.isError).not.toBe(true);
      expect(validateStructuredToolResult("compare_pdfs", result)).toBe(result);
      const { coverage, page_alignments: alignments, summary, status } = result.structuredContent;
      expect(alignments.length).toBeGreaterThan(0);
      expect(alignments.every(item => item.match_basis === "repeated_ambiguous")).toBe(true);
      for (const channel of ["semantic", "text", "structure"]) {
        expect(coverage[channel].status, channel).toBe("partial");
        expect(coverage[channel].reason_codes, channel).toContain("REPEATED_PAGE_AMBIGUITY");
      }
      expect(status).toBe("partial");
      // The whole point: zero reported changes plus uncompared pages must NOT
      // read as "no reported changes".
      expect(summary.no_reported_changes).toBe(false);
      expect(summary.equivalence_claim).toBe(false);
    }, 30_000);
  });

  describe("Bug 3 — checkbox appearance state is redundant with value; radio /AS is a named gap", () => {
    // The fixtures share an identical checkbox logical value (/V = Yes) in the
    // file and differ only in the file-level displayed appearance state (/AS:
    // "Yes" before, "Off" after). This measures the redundancy that justifies
    // excluding appearance_state from the compared properties FOR CHECKBOXES:
    // the pinned pdfjs resolves the widget's observed `value` from its /AS, so
    // the displayed state change is already reported — through `value` — and
    // appearance_state would only duplicate it. Radio groups do NOT share this
    // redundancy (per-widget /AS is not exposed; fieldValue is the shared
    // group /V), which is a named coverage gap asserted below, not a claim.
    it("reports the displayed-state change through value and does not duplicate it", async () => {
      const result = await compare(
        fixture("coverage-appearance-before.pdf"),
        fixture("coverage-appearance-after.pdf"),
      );
      expect(result.isError).not.toBe(true);
      expect(validateStructuredToolResult("compare_pdfs", result)).toBe(result);
      const summaries = result.structuredContent.changes.map(change => change.summary);
      // The /AS change is NOT silently lost: it surfaces as a value change,
      // because pdfjs folds the widget's /AS into its observed fieldValue.
      expect(summaries.some(summary => summary.includes(" value modified"))).toBe(true);
      // And it is not double-reported: appearance_state is intentionally not a
      // separately compared property.
      expect(summaries.some(summary => summary.includes("appearance_state modified"))).toBe(false);
    }, 30_000);

    it("documents the intentional exclusion at the compared-properties list", async () => {
      // Resolve the schema-captured / comparison-ignored mismatch explicitly:
      // appearance_state is a captured observation field, so its absence from
      // the compared set must be a documented decision, not an oversight.
      const source = await readFile(path.join(REPO_ROOT, "server/pdf-comparison.js"), "utf8");
      const properties = source.slice(source.indexOf("const properties = ["));
      expect(source).toMatch(/appearance_state.*is NOT compared|deliberately NOT compared/s);
      // The checkbox redundancy rationale is documented...
      expect(source).toMatch(/For CHECKBOX widgets/);
      // ...and the radio gap is named honestly, not claimed as covered.
      expect(source).toMatch(/KNOWN GAP[\s\S]*RADIO/);
      // The compared list itself must not contain appearance_state.
      const list = properties.slice(0, properties.indexOf("]"));
      expect(list).not.toContain("appearance_state");
    });
  });
});
