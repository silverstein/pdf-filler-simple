import fs from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument, rgb } from "pdf-lib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");

const RUNTIMES = [
  { name: "source runtime", root: REPO_ROOT },
  { name: "share runtime", root: path.join(REPO_ROOT, "pdf-toolkit-mcp-share") },
];

async function startRuntime(runtimeRoot, stateRoot, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(runtimeRoot, "server", "index.js")],
    cwd: runtimeRoot,
    env: {
      ALLOWED_DIRECTORIES: [REPO_ROOT, stateRoot].join(path.delimiter),
      DEFAULT_PROFILES_DIR: path.join(stateRoot, "profiles"),
      ...extraEnv,
    },
    stderr: "ignore",
  });
  const client = new Client({
    name: "pdf-tools-analysis-error-truth-test",
    version: "1.0.0",
  });
  await client.connect(transport);
  return { client, transport };
}

describe.each(RUNTIMES)("$name analysis truthfulness", ({ root }) => {
  let stateRoot;
  let textlessPdf;
  let normal;
  let forcedRenderFailure;

  beforeAll(async () => {
    stateRoot = await fs.mkdtemp(path.join(tmpdir(), "pdf-tools-analysis-truth-"));
    const document = await PDFDocument.create();
    const page = document.addPage([300, 200]);
    page.drawRectangle({ x: 40, y: 50, width: 120, height: 60, color: rgb(0.2, 0.4, 0.8) });
    textlessPdf = path.join(stateRoot, "textless.pdf");
    await fs.writeFile(textlessPdf, await document.save());

    normal = await startRuntime(root, stateRoot);
    forcedRenderFailure = await startRuntime(root, stateRoot, {
      PDF_TOOLS_FORCE_SYSTEM_RENDERER: "1",
      PDF_TOOLS_DISABLE_SYSTEM_RENDERER: "1",
    });
    // Cache advertised output validators before exercising both success and
    // structured isError branches, matching current MCP client behavior.
    await normal.client.listTools();
    await forcedRenderFailure.client.listTools();
  }, 30_000);

  afterAll(async () => {
    await normal?.client.close();
    await normal?.transport.close();
    await forcedRenderFailure?.client.close();
    await forcedRenderFailure?.transport.close();
    if (stateRoot) await fs.rm(stateRoot, { recursive: true, force: true });
  });

  it("reports complete and scope-limited text extraction distinctly", async () => {
    const complete = await normal.client.callTool({
      name: "read_pdf_content",
      arguments: { pdf_path: EXAMPLE_PDF },
    });
    expect(complete.isError).not.toBe(true);
    expect(complete.structuredContent).toMatchObject({
      extraction_status: "complete",
      extraction_mode: "text",
      content_available: true,
      text_found: true,
      error_codes: [],
      retry_guidance: null,
    });

    const partial = await normal.client.callTool({
      name: "read_pdf_content",
      arguments: { pdf_path: EXAMPLE_PDF, max_pages: 1 },
    });
    expect(partial.isError).not.toBe(true);
    expect(partial.structuredContent).toMatchObject({
      extraction_status: "partial",
      extraction_mode: "text",
      content_available: true,
      pages_read: 1,
      total_pages: 4,
      error_codes: [],
      retry_guidance: expect.stringContaining("partial result"),
    });
  }, 30_000);

  it("returns an MCP tool error plus safe structured state when all content paths fail", async () => {
    const result = await forcedRenderFailure.client.callTool({
      name: "read_pdf_content",
      arguments: { pdf_path: textlessPdf },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: "text",
      text: expect.stringMatching(/^Error: PDF content extraction failed/),
    }]);
    expect(result.content[0].text).not.toContain("System PDF renderer was forced");
    expect(result.structuredContent).toMatchObject({
      pdf_path: textlessPdf,
      total_pages: 1,
      pages_read: 1,
      text_length: 0,
      text_found: false,
      content_available: false,
      extraction_status: "failed",
      extraction_mode: "none",
      error_codes: ["NO_EXTRACTABLE_TEXT", "IMAGE_FALLBACK_FAILED"],
      retry_guidance: expect.stringContaining("Do not treat this PDF as empty"),
    });
    expect(result.structuredContent.page_previews).toEqual([expect.objectContaining({
      page: 1,
      char_count: 0,
      text: "",
    })]);
  }, 30_000);

  it("returns complete real-PDF page provenance with no unknown deletion candidates", async () => {
    const result = await normal.client.callTool({
      name: "get_page_analysis",
      arguments: { pdf_path: EXAMPLE_PDF },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      total_pages: 4,
      content_analysis_status: "complete",
      content_analysis_complete: true,
      unknown_pages: [],
      analysis_errors: [],
      retry_guidance: null,
    });
    for (const page of result.structuredContent.pages) {
      expect(page.content_analysis_status).toBe("complete");
      expect(["likely_blank", "not_blank"]).toContain(page.blank_status);
      expect(page.text_length).not.toBeNull();
      expect(page.has_images).not.toBeNull();
    }
  }, 30_000);

  it("does not call a textless page with painted vector content blank", async () => {
    const result = await normal.client.callTool({
      name: "get_page_analysis",
      arguments: { pdf_path: textlessPdf },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      likely_blank_pages: [],
      nonblank_pages: [1],
      unknown_pages: [],
      mutation_guidance: expect.stringContaining("not authorization"),
      pages: [expect.objectContaining({
        text_length: 0,
        has_images: false,
        has_graphics: true,
        blank_status: "not_blank",
      })],
    });
  }, 30_000);
});
