import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalLfSha256,
  generateLayoutCMapOracle,
  validateMinimalPdfStructure,
} from "../scripts/generate-layout-cmap-oracle.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PATH = path.join(REPO_ROOT, "test/fixtures/eval/extraction/oracles/layout-unijis-vertical.pdf");
const PROVENANCE_PATH = path.join(REPO_ROOT, "test/fixtures/eval/extraction/oracles/layout-unijis-vertical.provenance.json");
const GENERATOR_PATH = path.join(REPO_ROOT, "scripts/generate-layout-cmap-oracle.mjs");
const PDFJS_CMAP_DIRECTORY = path.join(REPO_ROOT, "node_modules/pdfjs-dist/cmaps");
const REQUIRED_CMAPS = ["UniJIS-UTF16-V.bcmap", "UniJIS-UTF16-H.bcmap", "Adobe-Japan1-UCS2.bcmap"];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function observePdfjsText(pdfjs, bytes, cMapDirectory) {
  let loadingTask;
  let document;
  try {
    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      cMapUrl: cMapDirectory ? `${cMapDirectory}${path.sep}` : undefined,
      cMapPacked: cMapDirectory ? true : undefined,
      useWorkerFetch: false,
      isEvalSupported: false,
    });
    document = await loadingTask.promise;
    const page = await document.getPage(1);
    const textContent = await page.getTextContent();
    page.cleanup();
    return {
      status: "loaded",
      text: textContent.items.map(item => item.str).join(""),
      items: textContent.items,
      styles: textContent.styles,
    };
  } catch (error) {
    return { status: "failed", error_name: error?.name ?? "Error", error_message: error?.message ?? String(error) };
  } finally {
    await document?.destroy().catch(() => {});
    await loadingTask?.destroy?.().catch(() => {});
  }
}

describe("ODA exact-Unicode named-CMap vertical oracle", () => {
  let client;
  let transport;
  let temporaryRoot;
  let fixtureBytes;
  let provenance;

  beforeAll(async () => {
    fixtureBytes = await fs.readFile(FIXTURE_PATH);
    provenance = JSON.parse(await fs.readFile(PROVENANCE_PATH, "utf8"));
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-cmap-oracle-"));
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: { ALLOWED_DIRECTORIES: path.dirname(FIXTURE_PATH) },
      stderr: "ignore",
    });
    client = new Client({ name: "pdf-layout-cmap-oracle-test", version: "1.0.0" });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  it("reproduces the committed ODA fixture and validates its minimal PDF structure independently", async () => {
    const generated = generateLayoutCMapOracle();
    const generatorBytes = await fs.readFile(GENERATOR_PATH);
    expect(generated).toEqual(fixtureBytes);
    expect(generateLayoutCMapOracle()).toEqual(generated);
    expect(sha256(generated)).toBe(provenance.fixture.sha256);
    expect(generated.length).toBe(provenance.fixture.size_bytes);
    expect(canonicalLfSha256(generatorBytes)).toBe(provenance.generator.sha256);
    expect(canonicalLfSha256(Buffer.from(generatorBytes.toString("utf8").replace(/\n/g, "\r\n"), "utf8"))).toBe(
      provenance.generator.sha256,
    );
    expect(validateMinimalPdfStructure(generated)).toEqual(provenance.independent_structure_check);
    expect(provenance).toMatchObject({
      schema_version: 1,
      ownership: "Open Document Alliance generated synthetic fixture",
      license: "CC0-1.0",
      privacy: "Synthetic text-only fixture; no personal data",
      redistribution: "allowed",
      font_program: { embedded: false, bytes: 0 },
      oracle: {
        exact_unicode_text: "日本語",
        named_encoding: "UniJIS-UTF16-V",
        descendant_collection: "Adobe-Japan1-7",
        requires_packaged_cmaps: REQUIRED_CMAPS,
      },
      runtime_assets: { pdfjs_dist_version: "5.4.624" },
    });
    expect(provenance.generator.command).toBe("node scripts/generate-layout-cmap-oracle.mjs");
    expect(provenance.generator.path).toBe("scripts/generate-layout-cmap-oracle.mjs");
    expect(provenance.generator.path).not.toContain("\\");
    expect(provenance.fixture.path).toBe("test/fixtures/eval/extraction/oracles/layout-unijis-vertical.pdf");
    expect(provenance.fixture.path).not.toContain("\\");
    expect(provenance.generator.hash_contract).toContain("normalized to LF");
    expect(provenance.oracle.geometry_claim).toContain("advance-box approximation only");
    expect(provenance.oracle.geometry_claim).toContain("not glyph ink bounds");
  });

  it("rejects fixture mutations that could create a provenance or causality false pass", () => {
    const replaceSameLength = (bytes, before, after) => {
      expect(Buffer.byteLength(after, "binary")).toBe(Buffer.byteLength(before, "binary"));
      const mutant = Buffer.from(bytes);
      const offset = mutant.indexOf(before, 0, "binary");
      expect(offset).toBeGreaterThanOrEqual(0);
      mutant.write(after, offset, "binary");
      return mutant;
    };
    expect(() => validateMinimalPdfStructure(
      replaceSameLength(fixtureBytes, "/Encoding /UniJIS-UTF16-V", "/Encoding /Identity-H    "),
    )).toThrow(/UniJIS-UTF16-V/);
    expect(() => validateMinimalPdfStructure(
      replaceSameLength(fixtureBytes, "/FontDescriptor 7 0 R", "/ToUnicode      7 0 R"),
    )).toThrow(/ToUnicode/);
    expect(() => validateMinimalPdfStructure(
      replaceSameLength(fixtureBytes, "/FontDescriptor 7 0 R", "/FontFile3      7 0 R"),
    )).toThrow(/font bytes/);
    const xrefMutant = Buffer.from(fixtureBytes);
    const xrefOffset = xrefMutant.indexOf("xref\n", 0, "binary");
    const firstObjectOffset = xrefOffset + "xref\n0 9\n0000000000 65535 f \n".length;
    xrefMutant[firstObjectOffset] = xrefMutant[firstObjectOffset] === 0x30 ? 0x31 : 0x30;
    expect(() => validateMinimalPdfStructure(xrefMutant)).toThrow(/xref mismatch/);
    expect(() => validateMinimalPdfStructure(
      replaceSameLength(fixtureBytes, "xref\n0 9\n", "xref\n0 8\n"),
    )).toThrow(/canonical 0 9 subsection/);
    expect(() => validateMinimalPdfStructure(
      replaceSameLength(fixtureBytes, "/Size 9 /Root", "/Size 8 /Root"),
    )).toThrow(/\/Size 9/);
    expect(() => validateMinimalPdfStructure(
      replaceSameLength(fixtureBytes, "0000000000 65535 f ", "0000000000 65535 n "),
    )).toThrow(/canonical free entry/);
    const source = fixtureBytes.toString("binary");
    const xrefLines = source.slice(source.indexOf("xref\n")).split("\n");
    const missingEntry = Buffer.from(source.replace(`${xrefLines[10]}\ntrailer\n`, "trailer\n"), "binary");
    expect(() => validateMinimalPdfStructure(missingEntry)).toThrow(/exactly nine fixed-format entries/);
    expect(() => validateMinimalPdfStructure(
      replaceSameLength(fixtureBytes, "1 0 obj\n", "9 0 obj\n"),
    )).toThrow(/numbered 1 with generation 0/);
    expect(() => validateMinimalPdfStructure(
      replaceSameLength(fixtureBytes, "1 0 obj\n", "1 1 obj\n"),
    )).toThrow(/numbered 1 with generation 0/);
    expect(() => validateMinimalPdfStructure(
      replaceSameLength(fixtureBytes, `${xrefLines[3].slice(0, 11)}00000 n `, `${xrefLines[3].slice(0, 11)}00001 n `),
    )).toThrow(/generation-0 in-use entry/);
    expect(() => validateMinimalPdfStructure(
      replaceSameLength(fixtureBytes, "/Root 1 0 R", "/Root 2 0 R"),
    )).toThrow(/\/Root 1 0 R/);
    expect(() => validateMinimalPdfStructure(
      replaceSameLength(fixtureBytes, "/Info 8 0 R", "/Info 7 0 R"),
    )).toThrow(/\/Info 8 0 R/);
  });

  it("binds every required CMap and retained PDF.js, CMap, Foxit, and Liberation license byte", async () => {
    for (const asset of provenance.runtime_assets.files) {
      const bytes = await fs.readFile(path.join(REPO_ROOT, asset.path));
      expect(bytes.length, asset.path).toBeGreaterThan(0);
      expect(bytes.length, asset.path).toBe(asset.size_bytes);
      expect(sha256(bytes), asset.path).toBe(asset.sha256);
    }
    expect(provenance.runtime_assets.files.map(asset => asset.path)).toEqual([
      "node_modules/pdfjs-dist/cmaps/UniJIS-UTF16-V.bcmap",
      "node_modules/pdfjs-dist/cmaps/UniJIS-UTF16-H.bcmap",
      "node_modules/pdfjs-dist/cmaps/Adobe-Japan1-UCS2.bcmap",
      "node_modules/pdfjs-dist/cmaps/LICENSE",
      "node_modules/pdfjs-dist/LICENSE",
      "node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf",
      "node_modules/pdfjs-dist/standard_fonts/LICENSE_FOXIT",
      "node_modules/pdfjs-dist/standard_fonts/LICENSE_LIBERATION",
    ]);
    expect(await fs.readFile(path.join(REPO_ROOT, "server/layout-extraction.js"))).toEqual(
      await fs.readFile(path.join(REPO_ROOT, "pdf-toolkit-mcp-share/server/layout-extraction.js")),
    );
  });

  it("causally requires all named packaged CMaps instead of passing on an embedded Unicode override", async () => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const completeDirectory = path.join(temporaryRoot, "complete");
    const missingEncodingDirectory = path.join(temporaryRoot, "missing-encoding");
    const missingParentDirectory = path.join(temporaryRoot, "missing-parent");
    const missingUnicodeDirectory = path.join(temporaryRoot, "missing-unicode");
    await Promise.all([
      completeDirectory,
      missingEncodingDirectory,
      missingParentDirectory,
      missingUnicodeDirectory,
    ].map(directory => fs.mkdir(directory)));
    for (const assetName of REQUIRED_CMAPS) {
      await fs.copyFile(path.join(PDFJS_CMAP_DIRECTORY, assetName), path.join(completeDirectory, assetName));
    }
    for (const assetName of ["UniJIS-UTF16-H.bcmap", "Adobe-Japan1-UCS2.bcmap"]) {
      await fs.copyFile(path.join(PDFJS_CMAP_DIRECTORY, assetName), path.join(missingEncodingDirectory, assetName));
    }
    for (const assetName of ["UniJIS-UTF16-V.bcmap", "Adobe-Japan1-UCS2.bcmap"]) {
      await fs.copyFile(path.join(PDFJS_CMAP_DIRECTORY, assetName), path.join(missingParentDirectory, assetName));
    }
    for (const assetName of ["UniJIS-UTF16-V.bcmap", "UniJIS-UTF16-H.bcmap"]) {
      await fs.copyFile(path.join(PDFJS_CMAP_DIRECTORY, assetName), path.join(missingUnicodeDirectory, assetName));
    }

    const complete = await observePdfjsText(pdfjs, fixtureBytes, completeDirectory);
    expect(complete).toMatchObject({
      status: "loaded",
      text: "日本語",
      items: [{ str: "日本語", dir: "ttb", width: 24, height: 72 }],
    });
    expect(Object.values(complete.styles)).toEqual([
      expect.objectContaining({ vertical: true, ascent: 0.88, descent: -0.12 }),
    ]);

    const controls = {
      no_cmap_configuration: await observePdfjsText(pdfjs, fixtureBytes, null),
      missing_UniJIS_UTF16_V: await observePdfjsText(pdfjs, fixtureBytes, missingEncodingDirectory),
      missing_UniJIS_UTF16_H: await observePdfjsText(pdfjs, fixtureBytes, missingParentDirectory),
      missing_Adobe_Japan1_UCS2: await observePdfjsText(pdfjs, fixtureBytes, missingUnicodeDirectory),
    };
    expect(controls).toEqual({
      no_cmap_configuration: { status: "loaded", text: "", items: [], styles: {} },
      missing_UniJIS_UTF16_V: { status: "loaded", text: "", items: [], styles: {} },
      missing_UniJIS_UTF16_H: { status: "loaded", text: "", items: [], styles: {} },
      missing_Adobe_Japan1_UCS2: { status: "loaded", text: "", items: [], styles: {} },
    });
    for (const [name, control] of Object.entries(controls)) {
      expect(
        control.status === "failed" || control.text !== provenance.oracle.exact_unicode_text,
        `${name} unexpectedly reproduced exact Unicode without all three named CMaps`,
      ).toBe(true);
    }
  });

  it("returns exact useful Unicode and numeric vertical item-height geometry through the real MCP tool", async () => {
    const result = await client.callTool({
      name: "read_pdf_layout",
      arguments: { pdf_path: FIXTURE_PATH, max_output_characters: 200000 },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      parser: { name: "pdfjs-dist", version: "5.4.624" },
      source: {
        sha256: provenance.fixture.sha256,
        size_bytes: provenance.fixture.size_bytes,
      },
      extraction_status: "complete",
    });
    const page = result.structuredContent.pages[0];
    expect(page).toMatchObject({
      flow_text: "日本語",
      text_layer_status: "present",
      modality_hint: "text-layer-candidate",
      reading_order: { strategy: "source_order_fallback", confidence: "not_calibrated" },
    });
    const item = page.raw_items[0];
    expect(item).toEqual(expect.objectContaining({
      text: "日本語",
      direction: "ttb",
      raw_transform: [24, 0, 0, 24, 150, 340],
      raw_width: 24,
      raw_height: 72,
      font: { family: "monospace", ascent: 0.88, descent: -0.12, vertical: true },
      geometry_kind: "pdfjs_text_run_advance_box",
      geometry_provenance: {
        formula: "pdfjs_text_item_style_metric_advance_box_approximation",
        quad_order: "anchor_top_terminal_top_anchor_bottom_terminal_bottom",
        advance_source: "item_height",
        ascent_source: "style_ascent",
        ascent_ratio: 0.88,
      },
      quad: [
        { x: 171.12, y: 60 },
        { x: 171.12, y: 132 },
        { x: 147.12, y: 60 },
        { x: 147.12, y: 132 },
      ],
      bbox: { x: 147.12, y: 60, width: 24, height: 72 },
      x: 147.12,
      y: 60,
      width: 24,
      height: 72,
      line_height: 24,
    }));
    expect(item.bbox.height).toBe(item.raw_height);
    expect(Math.hypot(item.quad[1].x - item.quad[0].x, item.quad[1].y - item.quad[0].y)).toBe(item.raw_height);
    expect(result.structuredContent.limitations.join(" ")).toContain("not DOM TextLayer or glyph ink bounds");
  });
});
