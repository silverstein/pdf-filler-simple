import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOOL_OUTPUT_SCHEMAS } from "../server/output-schemas.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIXED = path.join(REPO_ROOT, "test/fixtures/eval/extraction/synthetic/mixed-text-raster.pdf");
const RASTER = path.join(REPO_ROOT, "test/fixtures/eval/extraction/synthetic/raster-clean.pdf");
const TABLE = path.join(REPO_ROOT, "test/fixtures/eval/extraction/synthetic/table-merged-blank.pdf");
const ROTATED_CROP = path.join(REPO_ROOT, "test/fixtures/golden-forms/rotated-signature.pdf");
const VERTICAL_UNICODE = path.join(REPO_ROOT, "test/fixtures/eval/extraction/oracles/layout-unijis-vertical.pdf");
const ENCRYPTED = path.join(REPO_ROOT, "test/fixtures/eval/extraction/oracles/layout-encrypted-qpdf-r4.pdf");

async function makeStructureFixture(targetPath) {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Quarterly Results", { x: 50, y: 720, size: 24, font });
  page.drawText("Revenue & margin <plan>", { x: 50, y: 670, size: 12, font });
  page.drawText("1. First [item]", { x: 50, y: 640, size: 12, font });
  page.drawText("2. Visit https://example.com/report", { x: 50, y: 610, size: 12, font });
  page.drawText("Repeated text", { x: 50, y: 580, size: 12, font });
  page.drawText("Repeated text", { x: 50, y: 550, size: 12, font });
  page.drawText("Resume cafe", { x: 50, y: 520, size: 12, font });
  await fs.writeFile(targetPath, await document.save({ useObjectStreams: false }));
}

async function makeDenseFixture(targetPath) {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 450; index += 1) {
    page.drawText(`Dense item ${String(index).padStart(4, "0")}`, {
      x: 40,
      y: 760 - index * 1.5,
      size: 10,
      font,
    });
  }
  await fs.writeFile(targetPath, await document.save({ useObjectStreams: false }));
}

async function makeGeometryFixture(targetPath) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const rotation of [0, 90, 180, 270]) {
    const page = document.addPage([420, 520]);
    page.setCropBox(20, 30, 360, 440);
    page.setRotation(degrees(rotation));
    page.node.set(PDFName.of("UserUnit"), PDFNumber.of(1.5));
    page.drawText(`Rotation ${rotation}`, { x: 60, y: 100, size: 12, font });
  }
  await fs.writeFile(targetPath, await document.save({ useObjectStreams: false }));
}

async function expectedOutputIdentity(filePath) {
  const [canonicalPath, bytes, stats] = await Promise.all([
    fs.realpath(filePath),
    fs.readFile(filePath),
    fs.stat(filePath),
  ]);
  return {
    canonical_path: canonicalPath,
    size_bytes: stats.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

describe("convert_pdf_to_markdown MCP tool", () => {
  let client;
  let transport;
  let temporaryRoot;
  let structureFixture;
  let denseFixture;
  let geometryFixture;

  beforeAll(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-markdown-"));
    structureFixture = path.join(temporaryRoot, "structure.pdf");
    denseFixture = path.join(temporaryRoot, "dense.pdf");
    geometryFixture = path.join(temporaryRoot, "geometry.pdf");
    await makeStructureFixture(structureFixture);
    await makeDenseFixture(denseFixture);
    await makeGeometryFixture(geometryFixture);
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: { ALLOWED_DIRECTORIES: [REPO_ROOT, temporaryRoot].join(path.delimiter) },
      stderr: "ignore",
    });
    client = new Client({ name: "pdf-markdown-test", version: "1.0.0" });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
    if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  it("discovers the exact local, write-capable, closed-world contract", async () => {
    const { tools } = await client.listTools();
    expect(tools.find(tool => tool.name === "convert_pdf_to_markdown")).toMatchObject({
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["pdf_path"],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS.convert_pdf_to_markdown,
    });
  });

  it("renders deterministic heading, list, repeated text, escaped syntax, and plain URL evidence", async () => {
    const request = {
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: structureFixture, max_markdown_bytes: 100000 },
    };
    const first = await client.callTool(request);
    const second = await client.callTool(request);
    expect(first.isError).not.toBe(true);
    expect(second.structuredContent).toEqual(first.structuredContent);
    expect(first.structuredContent).toMatchObject({
      renderer: { name: "pdf-tools.layout-markdown-renderer", version: "1.0.0" },
      conversion_status: "complete",
      saved_output: null,
      provenance: {
        layout: { name: "pdf-tools.extraction-ir", version: "1.0.0", parser_version: "5.4.624" },
      },
    });
    const { markdown } = first.structuredContent;
    expect(markdown).toContain("<!-- PDF page 1 -->");
    expect(markdown).toMatch(/^<!-- PDF page 1 -->[\s\S]*# Quarterly Results/m);
    expect(markdown).toContain("Revenue &amp; margin &lt;plan&gt;");
    expect(markdown).toContain("1. First \\[item\\]");
    expect(markdown).toContain("https&#58;//example&#46;com/report");
    expect(markdown).not.toContain("<https://example.com/report>");
    expect(markdown.match(/Repeated text/g)).toHaveLength(2);
    expect(first.structuredContent.markdown_bytes).toBe(Buffer.byteLength(markdown, "utf8"));
    expect(first.structuredContent.markdown_sha256).toBe(
      createHash("sha256").update(markdown).digest("hex"),
    );
  }, 30_000);

  it("reports mixed, raster-only, and table-like visual structure without OCR or topology claims", async () => {
    const cases = [
      [MIXED, { end_page: 2 }, ["OCR_NOT_PERFORMED", "IMAGE_CONTENT_NOT_RENDERED"]],
      [RASTER, {}, ["TEXT_LAYER_EMPTY", "OCR_NOT_PERFORMED", "IMAGE_CONTENT_NOT_RENDERED"]],
    ];
    for (const [pdfPath, range, expectedCodes] of cases) {
      const result = await client.callTool({
        name: "convert_pdf_to_markdown",
        arguments: { pdf_path: pdfPath, max_markdown_bytes: 100000, ...range },
      });
      expect(result.isError, pdfPath).not.toBe(true);
      expect(result.structuredContent.conversion_status, pdfPath).toBe("partial");
      const codes = result.structuredContent.gaps.map(gap => gap.code);
      expect(codes, pdfPath).toEqual(expect.arrayContaining(expectedCodes));
      expect(result.structuredContent.limitations.join("\n")).toMatch(/OCR is not performed/);
      expect(result.structuredContent.limitations.join("\n")).toMatch(/Table topology is not represented/);
    }

    const table = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: TABLE, max_markdown_bytes: 100000 },
    });
    expect(table.isError).not.toBe(true);
    expect(table.structuredContent.limitations.join("\n")).toMatch(/Table topology is not represented/);
    expect(table.structuredContent.markdown).not.toMatch(/^\|.*\|$/m);
    const orderedFragments = [
      "Q3 PURCHASES",
      "Item",
      "Qty",
      "Amount",
      "Paper",
      "2",
      "USD 20.00",
      "Delivery",
      "USD 5.00",
    ];
    let cursor = 0;
    for (const fragment of orderedFragments) {
      const index = table.structuredContent.markdown.indexOf(fragment, cursor);
      expect(index, fragment).toBeGreaterThanOrEqual(cursor);
      cursor = index + fragment.length;
    }
  }, 30_000);

  it("keeps rotated and cropped geometry bounded and deterministic", async () => {
    const request = {
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: ROTATED_CROP, max_markdown_bytes: 100000 },
    };
    const first = await client.callTool(request);
    const second = await client.callTool(request);
    expect(first.isError).not.toBe(true);
    expect(second.structuredContent).toEqual(first.structuredContent);
    expect(first.structuredContent.provenance.layout.page_range).toMatchObject({
      start_page: 1,
      end_page: 1,
      total_pages: 1,
    });
  }, 30_000);

  it("preserves text across rotated, offset-CropBox, non-unit-UserUnit pages", async () => {
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: {
        pdf_path: geometryFixture,
        start_page: 1,
        end_page: 4,
        max_markdown_bytes: 100000,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.provenance.layout.page_range).toMatchObject({
      start_page: 1,
      end_page: 4,
      total_pages: 4,
    });
    for (const rotation of [0, 90, 180, 270]) {
      expect(result.structuredContent.markdown).toContain(`Rotation ${rotation}`);
    }
  }, 30_000);

  it("preserves provenance-bound vertical Unicode text without byte drift", async () => {
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: VERTICAL_UNICODE, max_markdown_bytes: 100000 },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.markdown).toContain("日本語");
    expect(result.structuredContent.markdown_bytes).toBe(
      Buffer.byteLength(result.structuredContent.markdown, "utf8"),
    );
  }, 30_000);

  it("returns exact password errors and converts authenticated encrypted bytes", async () => {
    const missing = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: ENCRYPTED },
    });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toEqual({
      status: "failed",
      error: { error_schema_version: 1, code: "PASSWORD_REQUIRED" },
    });

    const wrong = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: ENCRYPTED, password: "definitely-wrong-layout-password" },
    });
    expect(wrong.isError).toBe(true);
    expect(wrong.structuredContent).toEqual({
      status: "failed",
      error: { error_schema_version: 1, code: "PASSWORD_INCORRECT" },
    });

    const correct = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: ENCRYPTED, password: "oda-layout-user-2026" },
    });
    expect(correct.isError).not.toBe(true);
    expect(correct.structuredContent.provenance.source.sha256).toBe(
      createHash("sha256").update(await fs.readFile(ENCRYPTED)).digest("hex"),
    );
  }, 30_000);

  it("renders source-validated retained evidence before the public layout response projection", async () => {
    const publicLayout = await client.callTool({
      name: "read_pdf_layout",
      arguments: {
        pdf_path: denseFixture,
        max_items: 5000,
        max_characters: 100000,
        max_output_characters: 200000,
      },
    });
    expect(publicLayout.isError).not.toBe(true);
    expect(publicLayout.structuredContent.truncation.reasons).toContain("max_output_characters");
    expect(publicLayout.structuredContent.pages[0].lines).toEqual([]);

    const markdown = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: {
        pdf_path: denseFixture,
        max_items: 5000,
        max_characters: 100000,
        max_markdown_bytes: 200000,
      },
    });
    expect(markdown.isError).not.toBe(true);
    expect(markdown.structuredContent.gaps.map(gap => gap.code)).not.toContain("PAGE_RANGE_INCOMPLETE");
    expect(markdown.structuredContent.markdown).toContain("Dense item 0000");
    expect(markdown.structuredContent.markdown).toContain("Dense item 0449");
  }, 30_000);

  it("transactionally saves exact UTF-8 bytes, preserves the source, and requires explicit overwrite", async () => {
    const outputPath = path.join(temporaryRoot, "structure.md");
    const sourceBefore = await fs.readFile(structureFixture);
    const first = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: structureFixture, output_path: outputPath },
    });
    expect(first.isError).not.toBe(true);
    const saved = await fs.readFile(outputPath);
    const canonicalOutputPath = await fs.realpath(outputPath);
    expect(saved.toString("utf8")).toBe(first.structuredContent.markdown);
    expect(first.structuredContent.saved_output).toEqual({
      path: canonicalOutputPath,
      encoding: "utf-8",
      bytes: saved.length,
      sha256: createHash("sha256").update(saved).digest("hex"),
      commit_method: "same_directory_atomic",
      reopened_verified: true,
      overwritten: false,
    });
    expect(await fs.readFile(structureFixture)).toEqual(sourceBefore);

    const refused = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: structureFixture, output_path: outputPath },
    });
    expect(refused.isError).toBe(true);
    expect(await fs.readFile(outputPath)).toEqual(saved);
    expect(await fs.readFile(structureFixture)).toEqual(sourceBefore);

    const replaced = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: {
        pdf_path: structureFixture,
        output_path: outputPath,
        overwrite: true,
        expected_output_identity: await expectedOutputIdentity(outputPath),
      },
    });
    expect(replaced.isError).not.toBe(true);
    expect(replaced.structuredContent.saved_output.overwritten).toBe(true);
    expect(await fs.readFile(structureFixture)).toEqual(sourceBefore);
  }, 30_000);

  it.runIf(process.platform !== "win32")("refuses symlink and hardlink output aliases without changing source bytes", async () => {
    const symlinkTarget = path.join(temporaryRoot, "aliased-source.md");
    const symlinkSource = path.join(temporaryRoot, "aliased-source.pdf");
    const originalBytes = await fs.readFile(structureFixture);
    await fs.writeFile(symlinkTarget, originalBytes);
    await fs.symlink(symlinkTarget, symlinkSource);

    const symlinkResult = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: {
        pdf_path: symlinkSource,
        output_path: symlinkTarget,
        overwrite: true,
        expected_output_identity: await expectedOutputIdentity(symlinkTarget),
      },
    });
    expect(symlinkResult.isError).toBe(true);
    expect(symlinkResult.content[0].text).toContain("output_path resolves to the same file as the source PDF");
    expect(await fs.readFile(symlinkTarget)).toEqual(originalBytes);
    expect(await fs.readlink(symlinkSource)).toBe(symlinkTarget);

    const hardlinkSource = path.join(temporaryRoot, "hardlink-source.pdf");
    const hardlinkOutput = path.join(temporaryRoot, "hardlink-output.md");
    await fs.writeFile(hardlinkSource, originalBytes);
    await fs.link(hardlinkSource, hardlinkOutput);

    const hardlinkResult = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: {
        pdf_path: hardlinkSource,
        output_path: hardlinkOutput,
        overwrite: true,
        expected_output_identity: await expectedOutputIdentity(hardlinkOutput),
      },
    });
    expect(hardlinkResult.isError).toBe(true);
    expect(hardlinkResult.content[0].text).toContain("output_path resolves to the same file as the source PDF");
    expect(await fs.readFile(hardlinkSource)).toEqual(originalBytes);
    expect(await fs.readFile(hardlinkOutput)).toEqual(originalBytes);
  }, 30_000);

  it.runIf(process.platform !== "win32")("binds the canonical output parent and does not follow a late outside retarget", async () => {
    const inside = path.join(temporaryRoot, "inside-output-parent");
    const routedParent = path.join(temporaryRoot, "routed-output-parent");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-outside-output-"));
    const outputPath = path.join(routedParent, "late-retarget.md");
    await fs.mkdir(inside);
    await fs.symlink(inside, routedParent);

    try {
      const pending = client.callTool({
        name: "convert_pdf_to_markdown",
        arguments: {
          pdf_path: denseFixture,
          output_path: outputPath,
          max_items: 5000,
          max_characters: 100000,
          max_markdown_bytes: 200000,
        },
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      await fs.unlink(routedParent);
      await fs.symlink(outside, routedParent);

      const result = await pending;
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent.saved_output.path).toBe(
        path.join(await fs.realpath(inside), "late-retarget.md"),
      );
      await expect(fs.readFile(path.join(inside, "late-retarget.md"), "utf8")).resolves.toBe(
        result.structuredContent.markdown,
      );
      await expect(fs.access(path.join(outside, "late-retarget.md"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(routedParent, { force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  }, 30_000);

  it.runIf(process.platform !== "win32")("refuses a bound output parent replaced by an outside symlink before commit", async () => {
    const parent = path.join(temporaryRoot, "bound-output-parent");
    const movedParent = path.join(temporaryRoot, "bound-output-parent-moved");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-outside-bound-output-"));
    const outputPath = path.join(parent, "late-parent-swap.md");
    await fs.mkdir(parent);

    try {
      const pending = client.callTool({
        name: "convert_pdf_to_markdown",
        arguments: {
          pdf_path: denseFixture,
          output_path: outputPath,
          max_items: 5000,
          max_characters: 100000,
          max_markdown_bytes: 200000,
        },
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      await fs.rename(parent, movedParent);
      await fs.symlink(outside, parent);

      const result = await pending;
      expect(result.isError).toBe(true);
      await expect(fs.access(path.join(movedParent, "late-parent-swap.md"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(path.join(outside, "late-parent-swap.md"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(parent, { force: true });
      await fs.rm(movedParent, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed on byte limits and invalid output paths without creating files", async () => {
    const tooSmall = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: structureFixture, max_markdown_bytes: 256 },
    });
    expect(tooSmall.isError).toBe(true);
    expect(tooSmall.structuredContent).toMatchObject({
      status: "failed",
      error: { error_schema_version: 1, code: "tool_execution_failed" },
    });

    const wrongExtension = path.join(temporaryRoot, "not-markdown.txt");
    const invalid = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: structureFixture, output_path: wrongExtension },
    });
    expect(invalid.isError).toBe(true);
    await expect(fs.access(wrongExtension)).rejects.toMatchObject({ code: "ENOENT" });

    const protectedTarget = path.join(temporaryRoot, "protected-target.txt");
    const symlinkOutput = path.join(temporaryRoot, "linked.md");
    await fs.writeFile(protectedTarget, "keep me");
    await fs.symlink(protectedTarget, symlinkOutput);
    const symlinkResult = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: structureFixture, output_path: symlinkOutput },
    });
    expect(symlinkResult.isError).toBe(true);
    await expect(fs.readFile(protectedTarget, "utf8")).resolves.toBe("keep me");

    const directoryOutput = path.join(temporaryRoot, "directory.md");
    await fs.mkdir(directoryOutput);
    const directoryResult = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: structureFixture, output_path: directoryOutput },
    });
    expect(directoryResult.isError).toBe(true);

    const reservedOutput = path.join(temporaryRoot, ".pdf-tools-user.md");
    const reservedResult = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: structureFixture, output_path: reservedOutput },
    });
    expect(reservedResult.isError).toBe(true);
    await expect(fs.access(reservedOutput)).rejects.toMatchObject({ code: "ENOENT" });

    const missingParentOutput = path.join(temporaryRoot, "missing", "output.md");
    const missingParent = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: structureFixture, output_path: missingParentOutput },
    });
    expect(missingParent.isError).toBe(true);
    await expect(fs.access(missingParentOutput)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
});
