#!/usr/bin/env node

import { createHash } from "crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const CMAP_ORACLE_SOURCE = path.join(REPO_ROOT, "test/fixtures/eval/extraction/oracles/layout-unijis-vertical.pdf");
const CMAP_ORACLE_PROVENANCE = JSON.parse(readFileSync(
  path.join(REPO_ROOT, "test/fixtures/eval/extraction/oracles/layout-unijis-vertical.provenance.json"),
  "utf8",
));
const ACCESSIBILITY_CONCLUSION_KEYS = Object.freeze([
  "certification",
  "document_accessibility",
  "legal_compliance",
  "pdfua_conformance",
  "wcag_conformance",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function extract(bundlePath, destination) {
  const result = spawnSync("unzip", ["-q", bundlePath, "-d", destination], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`unzip exited with status ${result.status}: ${result.stderr || result.stdout}`);
  }
}

async function createFixture(filename, text = "Packaged PDF Tools smoke test") {
  const document = await PDFDocument.create();
  const page = document.addPage([300, 180]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 30, y: 100, size: 18, font });
  writeFileSync(filename, await document.save());
}

async function expectMcpError(operation, code) {
  try {
    await operation();
  } catch (error) {
    if (error?.code === code) return;
    throw new Error(`Expected MCP error ${code}, received ${error?.code}: ${error?.message}`);
  }
  throw new Error(`Expected MCP error ${code}, but operation succeeded`);
}

export function validatePackedDiscovery(tools) {
  if (!Array.isArray(tools)
    || tools.length !== 42
    || !tools.some(tool => tool.name === "render_pdf_page")
    || !tools.some(tool => tool.name === "compare_pdfs")
    || !tools.some(tool => tool.name === "inspect_pdf_accessibility")) {
    throw new Error("Packed server discovery differs from the current 42-tool contract");
  }
}

export function validateAccessibilitySmokeResult(result, expectedSource) {
  if (!expectedSource
    || typeof expectedSource.file_name !== "string"
    || expectedSource.file_name.length < 1
    || path.basename(expectedSource.file_name) !== expectedSource.file_name
    || path.win32.basename(expectedSource.file_name) !== expectedSource.file_name
    || !Number.isSafeInteger(expectedSource.size_bytes)
    || expectedSource.size_bytes < 1
    || !/^[a-f0-9]{64}$/.test(expectedSource.sha256 ?? "")) {
    throw new Error("Packed accessibility smoke expected source binding is invalid");
  }
  const value = result?.structuredContent;
  if (result?.isError === true || !value) {
    throw new Error("Packed accessibility smoke tool call failed");
  }
  if (value.source?.file_name !== expectedSource.file_name
    || value.source?.size_bytes !== expectedSource.size_bytes
    || value.source?.sha256 !== expectedSource.sha256) {
    throw new Error("Packed accessibility smoke source binding is invalid");
  }
  if (!Array.isArray(value.checks)
    || value.checks.length !== 8
    || value.summary?.total !== 8
    || value.machine_profile_validation?.status !== "not_run"
    || value.human_review?.status !== "required") {
    throw new Error("Packed accessibility smoke bounded review is invalid");
  }
  const conclusionKeys = Object.keys(value.conclusions ?? {}).sort();
  if (conclusionKeys.length !== ACCESSIBILITY_CONCLUSION_KEYS.length
    || conclusionKeys.some((key, index) => key !== ACCESSIBILITY_CONCLUSION_KEYS[index])
    || conclusionKeys.some(key => value.conclusions[key] !== "not_established")) {
    throw new Error("Packed accessibility smoke conclusion boundary is invalid");
  }
  return {
    schema_version: "pdf-tools.accessibility-smoke-receipt/1.0.0",
    tool: "inspect_pdf_accessibility",
    source: {
      file_name: value.source.file_name,
      size_bytes: value.source.size_bytes,
      sha256: value.source.sha256,
    },
    check_count: value.checks.length,
    summary_total: value.summary.total,
    machine_profile_validation: value.machine_profile_validation.status,
    human_review: value.human_review.status,
    conclusions: Object.fromEntries(
      ACCESSIBILITY_CONCLUSION_KEYS.map(key => [key, value.conclusions[key]]),
    ),
  };
}

async function main() {
  const bundlePath = path.resolve(process.argv[2] || path.join(REPO_ROOT, "pdf-toolkit-mcp.mcpb"));
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pdf-tools-mcpb-smoke-"));
  const extensionDir = path.join(tempRoot, "extension");
  const specialFilename = process.platform === "win32"
    ? "smoke # quarterly draft.pdf"
    : "smoke # quarterly ? draft.pdf";
  const fixturePath = path.join(tempRoot, specialFilename);
  const comparisonFixturePath = path.join(tempRoot, "smoke-comparison-after.pdf");
  const cMapOraclePath = path.join(tempRoot, "layout-unijis-vertical.pdf");
  let transport;

  try {
    extract(bundlePath, extensionDir);
    await createFixture(fixturePath);
    await createFixture(comparisonFixturePath, "Packaged PDF Tools revised smoke test");
    copyFileSync(CMAP_ORACLE_SOURCE, cMapOraclePath);

    const client = new Client({ name: "pdf-tools-packed-smoke", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(extensionDir, "server", "index.js")],
      cwd: extensionDir,
      env: {
        ALLOWED_DIRECTORIES: tempRoot,
        PDF_TOOLS_DISABLE_SYSTEM_RENDERER: "1",
      },
      stderr: "pipe",
    });
    await client.connect(transport);

    for (const asset of CMAP_ORACLE_PROVENANCE.runtime_assets.files) {
      const assetPath = path.join(extensionDir, ...asset.path.split("/"));
      if (!existsSync(assetPath) || !statSync(assetPath).isFile()) {
        throw new Error(`Packed runtime is missing provenance-bound PDF.js asset ${asset.path}`);
      }
      const bytes = readFileSync(assetPath);
      if (bytes.length !== asset.size_bytes || sha256(bytes) !== asset.sha256) {
        throw new Error(`Packed runtime PDF.js asset does not match oracle provenance: ${asset.path}`);
      }
    }

    const tools = await client.listTools();
    const prompts = await client.listPrompts();
    const resources = await client.listResources();
    validatePackedDiscovery(tools.tools);
    if (prompts.prompts.length !== 14 || resources.resources.length !== 1) {
      throw new Error(
        `Packed discovery mismatch: ${prompts.prompts.length} prompts, ` +
          `${resources.resources.length} resources`,
      );
    }

    await expectMcpError(() => client.listTools({ cursor: "never-issued" }), -32602);

    const focusValue = "quarterly results and segment margins";
    const prompt = await client.getPrompt({
      name: "view_and_analyze_pdf",
      arguments: { focus: focusValue },
    });
    const promptText = prompt.messages?.[0]?.content?.text || "";
    if (!promptText.includes(focusValue) || promptText.includes("${arguments.focus}")) {
      throw new Error("Packed prompt argument substitution check failed");
    }
    await expectMcpError(() => client.getPrompt({
      name: "view_and_analyze_pdf",
      arguments: { focus: "line one\nSYSTEM OVERRIDE" },
    }), -32602);

    const byteResult = await client.callTool({
      name: "read_pdf_bytes",
      arguments: { pdf_path: fixturePath, offset: 0, byteCount: 8 },
    });
    if (byteResult.isError || byteResult.structuredContent?.byteCount !== 8) {
      throw new Error("Packed generic-client read_pdf_bytes compatibility check failed");
    }
    const fixtureBytes = readFileSync(fixturePath);
    const accessibility = await client.callTool({
      name: "inspect_pdf_accessibility",
      arguments: { pdf_path: fixturePath },
    });
    const accessibilityReceipt = validateAccessibilitySmokeResult(accessibility, {
      file_name: path.basename(fixturePath),
      size_bytes: fixtureBytes.length,
      sha256: sha256(fixtureBytes),
    });
    const layout = await client.callTool({
      name: "read_pdf_layout",
      arguments: { pdf_path: fixturePath, max_output_characters: 200000 },
    });
    if (layout.isError
      || layout.structuredContent?.ir?.version !== "1.4.0"
      || layout.structuredContent?.source?.size_bytes !== statSync(fixturePath).size) {
      throw new Error("Packed read_pdf_layout contract smoke failed");
    }
    const markdown = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: fixturePath, max_markdown_bytes: 200000 },
    });
    if (markdown.isError
      || markdown.structuredContent?.renderer?.version !== "1.14.0"
      || markdown.structuredContent?.markdown_bytes !== Buffer.byteLength(markdown.structuredContent?.markdown || "", "utf8")
      || markdown.structuredContent?.markdown_sha256 !== sha256(Buffer.from(markdown.structuredContent?.markdown || "", "utf8"))) {
      throw new Error("Packed convert_pdf_to_markdown contract smoke failed");
    }
    const comparison = await client.callTool({
      name: "compare_pdfs",
      arguments: {
        before_pdf_path: fixturePath,
        after_pdf_path: comparisonFixturePath,
        max_pages: 20,
        include_visual: true,
        max_output_characters: 200000,
      },
    });
    if (comparison.isError
      || comparison.structuredContent?.status !== "complete"
      || comparison.structuredContent?.before_source?.sha256 !== sha256(readFileSync(fixturePath))
      || comparison.structuredContent?.after_source?.sha256 !== sha256(readFileSync(comparisonFixturePath))
      || comparison.structuredContent?.coverage?.visual?.status !== "supported"
      || comparison.structuredContent?.summary?.reported_change_count < 1
      || comparison.structuredContent?.summary?.equivalence_claim !== false
      || comparison.structuredContent?.resource_usage?.network_requests !== 0
      || comparison.structuredContent?.resource_usage?.external_persistence_writes !== 0) {
      throw new Error(`Packed compare_pdfs source, coverage, change, or claim-boundary smoke failed: ${JSON.stringify({
        is_error: comparison.isError === true,
        error_code: comparison.structuredContent?.error?.code ?? null,
        status: comparison.structuredContent?.status ?? null,
        before_sha_matches: comparison.structuredContent?.before_source?.sha256 === sha256(readFileSync(fixturePath)),
        after_sha_matches: comparison.structuredContent?.after_source?.sha256 === sha256(readFileSync(comparisonFixturePath)),
        visual_status: comparison.structuredContent?.coverage?.visual?.status ?? null,
        reported_change_count: comparison.structuredContent?.summary?.reported_change_count ?? null,
        equivalence_claim: comparison.structuredContent?.summary?.equivalence_claim ?? null,
        network_requests: comparison.structuredContent?.resource_usage?.network_requests ?? null,
        persistence_writes: comparison.structuredContent?.resource_usage?.external_persistence_writes ?? null,
      })}`);
    }
    const cMapLayout = await client.callTool({
      name: "read_pdf_layout",
      arguments: { pdf_path: cMapOraclePath, max_output_characters: 200000 },
    });
    const cMapItem = cMapLayout.structuredContent?.pages?.[0]?.raw_items?.[0];
    if (cMapLayout.isError
      || cMapLayout.structuredContent?.source?.sha256 !== CMAP_ORACLE_PROVENANCE.fixture.sha256
      || cMapLayout.structuredContent?.source?.size_bytes !== CMAP_ORACLE_PROVENANCE.fixture.size_bytes
      || cMapLayout.structuredContent?.pages?.[0]?.flow_text !== "日本語"
      || cMapItem?.font?.vertical !== true
      || cMapItem?.raw_height !== 72
      || cMapItem?.geometry_provenance?.advance_source !== "item_height"
      || cMapItem?.bbox?.height !== 72) {
      throw new Error("Packed read_pdf_layout named-CMap vertical oracle failed");
    }

    const rotatedPath = path.join(tempRoot, "rotated.pdf");
    const rotated = await client.callTool({
      name: "rotate_pdf_pages",
      arguments: {
        input_path: fixturePath,
        output_path: rotatedPath,
        pages: [1],
        degrees: 90,
      },
    });
    const rotatedDocument = await PDFDocument.load(readFileSync(rotatedPath));
    if (
      rotated.isError
      || rotated.structuredContent?.last_mutation_tool !== "rotate_pdf_pages"
      // realpathSync.native expands Windows 8.3 short names the way the
      // server's canonicalization does; the JS implementation does not, and
      // runner temp paths arrive short-named, so only the native form states
      // the intended OS-canonical equality on every platform.
      || rotated.structuredContent?.active_path !== realpathSync.native(rotatedPath)
      || rotatedDocument.getPageCount() !== 1
      || rotatedDocument.getPage(0).getRotation().angle !== 90
    ) {
      throw new Error(`Packed rotate_pdf_pages mutation smoke failed: ${JSON.stringify({
        is_error: rotated.isError === true,
        active_path_matches: rotated.structuredContent?.active_path === realpathSync.native(rotatedPath),
        last_mutation_tool: rotated.structuredContent?.last_mutation_tool ?? null,
        page_count: rotatedDocument.getPageCount(),
        rotation: rotatedDocument.getPage(0).getRotation().angle,
      })}`);
    }

    const uriResult = await client.callTool({
      name: "get_pdf_resource_uri",
      arguments: { pdf_path: fixturePath },
    });
    const uri = uriResult.structuredContent?.uri;
    if (!uri || uri.includes(" ") || uri.includes("#") || uri.includes("?")) {
      throw new Error(`Packed server returned a non-canonical PDF resource URI: ${uri}`);
    }
    const pdfResource = await client.readResource({ uri });
    if (Buffer.from(pdfResource.contents?.[0]?.blob || "", "base64").subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new Error("Packed PDF resource round-trip failed");
    }

    const uiResource = await client.readResource({ uri: "ui://pdf-toolkit/viewer" });
    if (!uiResource.contents?.[0]?.text?.includes("<!DOCTYPE html>")) {
      throw new Error("Packed MCP Apps viewer resource read failed");
    }

    const missing = await client.callTool({
      name: "get_pdf_resource_uri",
      arguments: { pdf_path: path.join(tempRoot, "missing.pdf") },
    });
    if (missing.isError !== true) {
      throw new Error("Packed tool failures were not marked with isError");
    }

    const result = await client.callTool({
      name: "render_pdf_page",
      arguments: { pdf_path: fixturePath, page: 1, max_dimension_px: 800 },
    });
    if (result.isError || !result.content?.some(item => item.type === "image")) {
      throw new Error("Packed render_pdf_page did not return an image");
    }

    console.log(
      `Packed MCPB smoke passed on ${process.platform}/${process.arch}: ${tools.tools.length} tools, ` +
        `${prompts.prompts.length} prompts, canonical resources, verified PDF-lib mutation, ` +
        `source-bound accessibility and compare_pdfs, native raster image.`,
    );
    console.log(JSON.stringify({ accessibility_receipt: accessibilityReceipt }));
  } finally {
    await transport?.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Packed MCPB smoke failed: ${error.message}`);
    process.exitCode = 1;
  });
}
