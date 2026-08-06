import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  validateAccessibilitySmokeResult,
  validatePackedDiscovery,
} from "../scripts/smoke-mcpb.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("packed MCPB discovery binding", () => {
  const currentTools = [
    ...Array.from({ length: 39 }, (_, index) => ({ name: `fixture_tool_${index}` })),
    { name: "render_pdf_page" },
    { name: "compare_pdfs" },
    { name: "inspect_pdf_accessibility" },
  ];

  it("accepts only the current 42-tool discovery", () => {
    expect(() => validatePackedDiscovery(currentTools)).not.toThrow();
    expect(() => validatePackedDiscovery(currentTools.slice(1))).toThrow(/42-tool contract/);
  });

  it("requires every smoke-critical tool", () => {
    for (const required of ["render_pdf_page", "compare_pdfs", "inspect_pdf_accessibility"]) {
      expect(() => validatePackedDiscovery(
        currentTools.map(tool => tool.name === required ? { name: "stale_tool" } : tool),
      )).toThrow(/42-tool contract/);
    }
  });
});

describe("packed MCPB accessibility proof wiring", () => {
  const requiredWiring = [
    "const accessibility = await client.callTool({",
    'name: "inspect_pdf_accessibility"',
    "const accessibilityReceipt = validateAccessibilitySmokeResult(accessibility, {",
    "file_name: path.basename(fixturePath)",
    "size_bytes: fixtureBytes.length",
    "sha256: sha256(fixtureBytes)",
    "accessibility_receipt: accessibilityReceipt",
  ];
  const expectedSource = {
    file_name: "smoke.pdf",
    size_bytes: 1234,
    sha256: "a".repeat(64),
  };
  const validResult = () => ({
    isError: false,
    structuredContent: {
      source: { ...expectedSource },
      checks: Array.from({ length: 8 }, (_, index) => ({ id: `check-${index}` })),
      summary: { total: 8 },
      machine_profile_validation: { status: "not_run" },
      human_review: { status: "required" },
      conclusions: {
        pdfua_conformance: "not_established",
        wcag_conformance: "not_established",
        certification: "not_established",
        legal_compliance: "not_established",
        document_accessibility: "not_established",
      },
    },
  });

  function assertPackedSmokeWiring(smoke) {
    for (const required of requiredWiring) {
      if (!smoke.includes(required)) throw new Error(`Packed smoke omitted required wiring: ${required}`);
    }
  }

  it("returns one bounded path-free receipt for an exact result", () => {
    const receipt = validateAccessibilitySmokeResult(validResult(), expectedSource);
    expect(receipt).toEqual({
      schema_version: "pdf-tools.accessibility-smoke-receipt/1.0.0",
      tool: "inspect_pdf_accessibility",
      source: expectedSource,
      check_count: 8,
      summary_total: 8,
      machine_profile_validation: "not_run",
      human_review: "required",
      conclusions: {
        certification: "not_established",
        document_accessibility: "not_established",
        legal_compliance: "not_established",
        pdfua_conformance: "not_established",
        wcag_conformance: "not_established",
      },
    });
    expect(receipt.source.file_name).toBe(path.basename(receipt.source.file_name));
    expect(receipt.source).not.toHaveProperty("canonical_path");
  });

  it("rejects every mutated proof field", () => {
    const mutations = [
      value => { value.isError = true; },
      value => { value.structuredContent.source.file_name = "other.pdf"; },
      value => { value.structuredContent.source.size_bytes += 1; },
      value => { value.structuredContent.source.sha256 = "b".repeat(64); },
      value => { value.structuredContent.checks.pop(); },
      value => { value.structuredContent.summary.total = 7; },
      value => { value.structuredContent.machine_profile_validation.status = "passed"; },
      value => { value.structuredContent.human_review.status = "optional"; },
      value => { delete value.structuredContent.conclusions.certification; },
      value => { value.structuredContent.conclusions.wcag_conformance = "established"; },
    ];
    for (const mutate of mutations) {
      const changed = validResult();
      mutate(changed);
      expect(() => validateAccessibilitySmokeResult(changed, expectedSource))
        .toThrow(/Packed accessibility smoke/);
    }
  });

  it("keeps the packed main path wired to the call, validator, and stdout receipt", async () => {
    const smoke = await fs.readFile(path.join(REPO_ROOT, "scripts/smoke-mcpb.mjs"), "utf8");
    expect(() => assertPackedSmokeWiring(smoke)).not.toThrow();
    for (const required of requiredWiring) {
      const mutated = smoke.replace(required, "REMOVED_WIRING");
      expect(mutated).not.toBe(smoke);
      expect(() => assertPackedSmokeWiring(mutated)).toThrow(/omitted required wiring/);
    }
  });
});
