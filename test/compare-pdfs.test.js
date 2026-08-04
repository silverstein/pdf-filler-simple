import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees } from "pdf-lib";
import { validateStructuredToolResult } from "../server/output-schemas.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(REPO_ROOT, "test/fixtures/eval/comparison/synthetic");
const BASE = path.join(FIXTURES, "comparison-base.pdf");
const ENCRYPTED = path.join(
  REPO_ROOT,
  "test/fixtures/eval/extraction/oracles/layout-encrypted-qpdf-r4.pdf",
);

const PAIRS = Object.freeze({
  identical: ["comparison-base.pdf", []],
  material_text: ["comparison-material-text-after.pdf", ["semantic_text", "semantic_text"]],
  visual_only: ["comparison-visual-status-after.pdf", ["visual"]],
  layout_noise: ["comparison-layout-noise-after.pdf", ["visual"]],
  metadata_only: ["comparison-metadata-only-after.pdf", ["metadata", "metadata"]],
  pages_reordered: ["comparison-pages-reordered-after.pdf", ["structure"]],
  form_annotation: ["comparison-form-annotation-after.pdf", ["form_field", "annotation"]],
});

describe("compare_pdfs deterministic product", () => {
  let client;
  let transport;
  let materialResult;
  let tempDirectory;

  beforeAll(async () => {
    tempDirectory = await createTestTempDirectory(REPO_ROOT, "compare-pdfs");
    client = new Client({ name: "compare-pdfs-test", version: "1.0.0" });
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
    try {
      await client?.close();
      await transport?.close();
    } finally {
      await removeTestTempDirectory(tempDirectory);
    }
  });

  it("publishes the exact closed-world whole-document input contract", async () => {
    const tools = (await client.listTools()).tools;
    const tool = tools.find(item => item.name === "compare_pdfs");
    expect(tool).toMatchObject({
      annotations: {
        title: "Compare PDFs",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["before_pdf_path", "after_pdf_path"],
      },
    });
    expect(tool.inputSchema.properties).toEqual(expect.objectContaining({
      before_password: expect.objectContaining({ maxLength: 4096 }),
      after_password: expect.objectContaining({ maxLength: 4096 }),
      mode: expect.objectContaining({ enum: ["default_material", "forensic"] }),
      max_pages: expect.objectContaining({ minimum: 1, maximum: 20 }),
      max_output_characters: expect.objectContaining({ minimum: 20000, maximum: 200000 }),
    }));
  });

  it("discriminates all seven public synthetic comparison roles", async () => {
    for (const [role, [afterName, expectedKinds]] of Object.entries(PAIRS)) {
      const result = await client.callTool({
        name: "compare_pdfs",
        arguments: {
          before_pdf_path: BASE,
          after_pdf_path: path.join(FIXTURES, afterName),
          max_output_characters: 200_000,
        },
      });
      expect(result.isError, role).not.toBe(true);
      expect(validateStructuredToolResult("compare_pdfs", result), role).toBe(result);
      expect(result.structuredContent.changes.map(change => change.kind), role).toEqual(expectedKinds);
      expect(result.structuredContent.summary.equivalence_claim, role).toBe(false);
      if (role === "material_text") materialResult = result;
      if (role === "layout_noise") {
        expect(result.structuredContent.changes[0].presentation).toMatchObject({
          disposition: "suppress",
          reversible_reason_code: "CALIBRATED_LAYOUT_NOISE",
        });
      }
      if (role === "visual_only") {
        expect(result.structuredContent.changes[0]).toMatchObject({
          salience: "minor",
          presentation: {
            disposition: "report",
            reversible_reason_code: null,
          },
        });
      }
      if (role === "metadata_only") {
        expect(result.structuredContent.changes.every(change =>
          change.presentation.disposition === "suppress")).toBe(true);
        expect(result.structuredContent.changes.map(change =>
          change.presentation.reversible_reason_code).sort())
          .toEqual(["METADATA_ONLY_DEFAULT", "VOLATILE_METADATA"]);
      }
      if (role === "pages_reordered") {
        expect(result.structuredContent.page_alignments.map(item => item.relation)).toEqual(["moved", "moved"]);
      }
      if (role === "form_annotation") {
        expect(result.structuredContent.changes[0].facets.map(facet => facet.channel))
          .toEqual(["form_field", "visual"]);
        const annotationChange = result.structuredContent.changes.find(change => change.kind === "annotation");
        expect(annotationChange.facets).toEqual([expect.objectContaining({
          channel: "annotation",
          operation: "added",
          before_evidence_id: null,
        })]);
        const annotationEvidence = result.structuredContent.observations.find(observation =>
          observation.id === annotationChange.facets[0].after_evidence_id);
        expect(annotationEvidence).toMatchObject({
          channel: "annotation",
          page: 1,
          canonical_value: "Synthetic reviewer note: verify status.",
        });
        expect(annotationEvidence.native_region).not.toBeNull();
        expect(annotationEvidence.display_region).toEqual([360, 332, 22, 22]);
        expect(result.structuredContent.resource_usage).toMatchObject({
          network_requests: 0,
          external_persistence_writes: 0,
        });
      }
    }
  }, 60_000);

  it("keeps visual-not-requested outside status while preserving typed coverage", async () => {
    const beforeBytes = await fs.readFile(BASE);
    const beforeStats = await fs.stat(BASE);
    const result = await client.callTool({
      name: "compare_pdfs",
      arguments: { before_pdf_path: BASE, after_pdf_path: BASE, include_visual: false },
    });
    const repeated = await client.callTool({
      name: "compare_pdfs",
      arguments: { before_pdf_path: BASE, after_pdf_path: BASE, include_visual: false },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "complete",
      coverage: { visual: { status: "unavailable", reason_codes: ["VISUAL_NOT_REQUESTED"] } },
      summary: { no_reported_changes: true, equivalence_claim: false },
    });
    const afterBytes = await fs.readFile(BASE);
    const afterStats = await fs.stat(BASE);
    expect(afterBytes).toEqual(beforeBytes);
    expect(afterStats.size).toBe(beforeStats.size);
    expect(afterStats.mtimeMs).toBe(beforeStats.mtimeMs);
    expect(result.structuredContent.before_source.sha256)
      .toBe(createHash("sha256").update(beforeBytes).digest("hex"));
    expect(result.structuredContent.source_immutability).toMatchObject({
      before: { unchanged: true },
      after: { unchanged: true },
    });
    expect(repeated.structuredContent.comparison_sha256)
      .toBe(result.structuredContent.comparison_sha256);
  });

  it("fails whole-document comparison instead of comparing prefixes", async () => {
    const result = await client.callTool({
      name: "compare_pdfs",
      arguments: { before_pdf_path: BASE, after_pdf_path: BASE, max_pages: 1 },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe("COMPARISON_PAGE_LIMIT_EXCEEDED");
  });

  it("compares all pages through bounded Extraction IR chunks up to the advertised limit", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let pageNumber = 1; pageNumber <= 11; pageNumber += 1) {
      const page = pdf.addPage([612, 792]);
      page.drawText(`Unique comparison page ${pageNumber}`, { x: 72, y: 700, size: 14, font });
    }
    const filename = path.join(tempDirectory, "eleven-pages.pdf");
    await fs.writeFile(filename, await pdf.save());
    const result = await client.callTool({
      name: "compare_pdfs",
      arguments: {
        before_pdf_path: filename,
        after_pdf_path: filename,
        max_pages: 20,
        include_visual: false,
        max_output_characters: 200_000,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.page_alignments).toHaveLength(11);
    expect(result.structuredContent.changes).toEqual([]);
    expect(result.structuredContent.summary).toMatchObject({
      no_reported_changes: true,
      equivalence_claim: false,
    });
  }, 30_000);

  it("detects aligned CropBox origin, rotation, and UserUnit geometry changes", async () => {
    async function makeGeometryPdf(fileName, { cropX, rotation, userUnit }) {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([400, 400]);
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      page.setCropBox(cropX, 100, 200, 200);
      page.setRotation(degrees(rotation));
      page.node.set(PDFName.of("UserUnit"), PDFNumber.of(userUnit));
      page.drawText("Stable geometry page", { x: 120, y: 260, size: 12, font });
      const filename = path.join(tempDirectory, fileName);
      await fs.writeFile(filename, await pdf.save());
      return filename;
    }
    const before = await makeGeometryPdf("geometry-before.pdf", { cropX: 100, rotation: 0, userUnit: 1 });
    const after = await makeGeometryPdf("geometry-after.pdf", { cropX: 80, rotation: 90, userUnit: 2 });
    const result = await client.callTool({
      name: "compare_pdfs",
      arguments: {
        before_pdf_path: before,
        after_pdf_path: after,
        include_visual: false,
        max_output_characters: 200_000,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.changes.map(change => change.kind)).toContain("structure");
    const structure = result.structuredContent.changes.find(change => change.kind === "structure");
    expect(structure.facets).toEqual([expect.objectContaining({
      channel: "structure",
      operation: "modified",
    })]);
  }, 30_000);

  it("preserves truthful clipped or off-page PDF.js evidence coordinates", async () => {
    async function makeOffPagePdf(fileName, text) {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([300, 180]);
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      page.drawText(text, { x: 30, y: 100, size: 18, font });
      const filename = path.join(tempDirectory, fileName);
      await fs.writeFile(filename, await pdf.save());
      return filename;
    }
    const before = await makeOffPagePdf("off-page-before.pdf", "Packaged PDF Tools smoke test");
    const after = await makeOffPagePdf("off-page-after.pdf", "Packaged PDF Tools revised smoke test");
    const result = await client.callTool({
      name: "compare_pdfs",
      arguments: {
        before_pdf_path: before,
        after_pdf_path: after,
        include_visual: false,
        max_output_characters: 200_000,
      },
    });
    expect(result.isError).not.toBe(true);
    const evidence = result.structuredContent.observations.find(item => item.channel === "text"
      && item.display_region[0] + item.display_region[2] > item.page_box[2]);
    expect(evidence).toBeTruthy();
    expect(evidence.display_region[0] + evidence.display_region[2])
      .toBeGreaterThan(evidence.page_box[2]);
  }, 30_000);

  it("rejects unknown input and scrubs path and password sentinels", async () => {
    const inputSentinel = "SECRET_UNKNOWN_INPUT_SENTINEL";
    const unknown = await client.callTool({
      name: "compare_pdfs",
      arguments: { before_pdf_path: BASE, after_pdf_path: BASE, [inputSentinel]: true },
    });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown)).not.toContain(inputSentinel);

    const pathSentinel = "PRIVATE_INTERNAL_PATH_SENTINEL";
    const missing = await client.callTool({
      name: "compare_pdfs",
      arguments: {
        before_pdf_path: path.join(REPO_ROOT, `${pathSentinel}.pdf`),
        after_pdf_path: BASE,
      },
    });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent.error.code).toBe("PDF_UNAVAILABLE");
    expect(JSON.stringify(missing)).not.toContain(pathSentinel);

    const parserSentinel = "PRIVATE_PARSER_MESSAGE_SENTINEL";
    const malformedPath = path.join(tempDirectory, `${parserSentinel}.pdf`);
    await fs.writeFile(malformedPath, `%PDF-1.7\n${parserSentinel}\n%%EOF\n`);
    const malformed = await client.callTool({
      name: "compare_pdfs",
      arguments: {
        before_pdf_path: malformedPath,
        after_pdf_path: BASE,
        include_visual: false,
      },
    });
    expect(malformed.isError).toBe(true);
    expect(malformed.structuredContent.error.code).toBe("PDF_PARSE_FAILED");
    expect(JSON.stringify(malformed)).not.toContain(parserSentinel);

    const passwordSentinel = "PASSWORD_DO_NOT_ECHO_SENTINEL";
    const protectedResult = await client.callTool({
      name: "compare_pdfs",
      arguments: {
        before_pdf_path: ENCRYPTED,
        after_pdf_path: ENCRYPTED,
        before_password: passwordSentinel,
        after_password: passwordSentinel,
      },
    });
    expect(protectedResult.isError).toBe(true);
    expect(protectedResult.structuredContent.error.code).toBe("PASSWORD_INCORRECT");
    expect(JSON.stringify(protectedResult)).not.toContain(passwordSentinel);
  });

  it("fails rather than dropping raw changes at the structured-output cap", async () => {
    async function makeFormPdf(fileName, valuePrefix) {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([612, 792]);
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const form = pdf.getForm();
      for (let index = 0; index < 60; index += 1) {
        const field = form.createTextField(`Field-${String(index).padStart(3, "0")}`);
        field.setText(`${valuePrefix}-${index}-${"x".repeat(80)}`);
        field.addToPage(page, {
          x: 36 + (index % 3) * 190,
          y: 750 - Math.floor(index / 3) * 34,
          width: 175,
          height: 20,
          font,
        });
      }
      const filename = path.join(tempDirectory, fileName);
      await fs.writeFile(filename, await pdf.save({ updateFieldAppearances: true }));
      return filename;
    }
    const before = await makeFormPdf("many-before.pdf", "before");
    const after = await makeFormPdf("many-after.pdf", "after");
    const result = await client.callTool({
      name: "compare_pdfs",
      arguments: {
        before_pdf_path: before,
        after_pdf_path: after,
        include_visual: false,
        max_output_characters: 20_000,
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe("COMPARISON_OUTPUT_LIMIT_EXCEEDED");
  }, 30_000);

  it("keeps field type, options, flags, page, and widget geometry as independent changes", async () => {
    async function makeFieldPdf(fileName, {
      kind = "text",
      options = ["Alpha", "Beta"],
      required = false,
      readOnly = false,
      fieldPage = 1,
      x = 72,
    } = {}) {
      const pdf = await PDFDocument.create();
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const pages = [pdf.addPage([612, 792]), pdf.addPage([612, 792])];
      pages[0].drawText("Logical first page", { x: 72, y: 720, size: 14, font });
      pages[1].drawText("Logical second page", { x: 72, y: 720, size: 14, font });
      const form = pdf.getForm();
      let field;
      if (kind === "checkbox") {
        field = form.createCheckBox("AccountField");
        field.addToPage(pages[fieldPage - 1], { x, y: 650, width: 20, height: 20 });
      } else if (kind === "dropdown") {
        field = form.createDropdown("AccountField");
        field.addOptions(options);
        field.select(options[0]);
        field.addToPage(pages[fieldPage - 1], { x, y: 650, width: 180, height: 22, font });
      } else {
        field = form.createTextField("AccountField");
        field.setText("Stable value");
        field.addToPage(pages[fieldPage - 1], { x, y: 650, width: 180, height: 22, font });
      }
      if (required) field.enableRequired();
      if (readOnly) field.enableReadOnly();
      const filename = path.join(tempDirectory, fileName);
      await fs.writeFile(filename, await pdf.save({ updateFieldAppearances: true }));
      return filename;
    }
    const compare = async (before, after) => {
      const result = await client.callTool({
        name: "compare_pdfs",
        arguments: {
          before_pdf_path: before,
          after_pdf_path: after,
          include_visual: false,
          max_output_characters: 200_000,
        },
      });
      expect(result.isError).not.toBe(true);
      return result.structuredContent.changes.map(change => change.summary);
    };

    const text = await makeFieldPdf("field-text.pdf");
    const checkbox = await makeFieldPdf("field-checkbox.pdf", { kind: "checkbox" });
    expect((await compare(text, checkbox)).some(summary => summary.includes(" type modified"))).toBe(true);

    const optionsBefore = await makeFieldPdf("field-options-before.pdf", { kind: "dropdown" });
    const optionsAfter = await makeFieldPdf("field-options-after.pdf", { kind: "dropdown", options: ["Alpha", "Gamma"] });
    expect((await compare(optionsBefore, optionsAfter)).some(summary => summary.includes(" options modified"))).toBe(true);

    const flagsAfter = await makeFieldPdf("field-flags-after.pdf", { required: true, readOnly: true });
    expect((await compare(text, flagsAfter)).some(summary => summary.includes(" flags modified"))).toBe(true);

    const geometryAfter = await makeFieldPdf("field-geometry-after.pdf", { x: 180 });
    expect((await compare(text, geometryAfter)).some(summary => summary.includes("widget_display_region modified"))).toBe(true);

    const pageAfter = await makeFieldPdf("field-page-after.pdf", { fieldPage: 2 });
    expect((await compare(text, pageAfter)).some(summary => summary.includes(" widget_page modified"))).toBe(true);
  }, 60_000);

  it("fails closed on every reproduced envelope mutation", () => {
    expect(materialResult).toBeTruthy();
    const mutations = [
      value => { value.status = "partial"; },
      value => { value.coverage.text.status = "partial"; },
      value => { value.coverage.text.reason_codes.push("MUTATED"); },
      value => { value.coverage.text = { status: "unavailable", reason_codes: [] }; },
      value => { value.coverage.text = { status: "supported", reason_codes: ["MUTATED"] }; },
      value => { value.limitations.push("text:MUTATED"); },
      value => { value.before_source.size_bytes += 1; },
      value => { value.before_source.file_name = "mutated.pdf"; },
      value => { value.before_source.canonical_path += ".mutated"; },
      value => { value.source_immutability.before.final_sha256 = "0".repeat(64); },
      value => { value.before_source.observation_sha256 = "0".repeat(64); },
      value => { value.before_source.page_count += 1; },
      value => { value.page_alignments.pop(); },
      value => { value.page_alignments[0].before_page = value.before_source.page_count + 1; },
      value => { value.summary.reported_change_count = 0; },
      value => { value.summary.no_reported_changes = true; },
      value => { value.resource_usage.network_requests = 1; },
      value => { value.observations[0].document_sha256 = "0".repeat(64); },
      value => { value.observations[0].page = value.before_source.page_count + 1; },
      value => { value.observations[0].native_region = [0, 0, -1, 1]; },
      value => { value.changes[0].facets.push(structuredClone(value.changes[0].facets[0])); },
      value => { value.changes[0].facets[0].operation = "added"; },
      value => { value.comparison_sha256 = "0".repeat(64); },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(materialResult);
      mutate(candidate.structuredContent);
      const validated = validateStructuredToolResult("compare_pdfs", candidate);
      expect(validated.isError).toBe(true);
      expect(validated.structuredContent.error.code).toBe("internal_validation_error");
    }
  });
});
