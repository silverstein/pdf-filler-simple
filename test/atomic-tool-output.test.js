import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument } from "pdf-lib";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let tempDir;
let sourcePath;
let client;
let transport;

async function transactionArtifacts() {
  return (await fs.readdir(tempDir)).filter(name => name.includes(".pdf-tools-")).sort();
}

describe("PDF tool output transactions", () => {
  beforeAll(async () => {
    tempDir = await createTestTempDirectory(REPO_ROOT, "atomic-tool-output");
    sourcePath = path.join(tempDir, "source.pdf");
    const document = await PDFDocument.create();
    document.addPage([400, 500]);
    document.addPage([400, 500]);
    await fs.writeFile(sourcePath, await document.save());

    client = new Client({ name: "pdf-tools-atomic-output-client", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server", "index.js")],
      cwd: REPO_ROOT,
      env: { ALLOWED_DIRECTORIES: tempDir },
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    try {
      await transport?.close();
    } finally {
      await removeTestTempDirectory(tempDir);
    }
  });

  it("does not partially replace split outputs when any target is invalid", async () => {
    const firstOutput = path.join(tempDir, "source_pages_1-1_1.pdf");
    const blockedOutput = path.join(tempDir, "source_pages_2-2_2.pdf");
    await fs.writeFile(firstOutput, "existing first output");
    await fs.mkdir(blockedOutput);

    const result = await client.callTool({
      name: "split_pdf",
      arguments: {
        input_path: sourcePath,
        page_ranges: "1,2",
        output_directory: tempDir,
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("Atomic PDF output target is a directory");
    await expect(fs.readFile(firstOutput, "utf8")).resolves.toBe("existing first output");
    expect((await fs.stat(blockedOutput)).isDirectory()).toBe(true);
    await expect(transactionArtifacts()).resolves.toEqual([]);
  }, 30_000);

  it("does not write an earlier bulk row when later filenames collide", async () => {
    const csvPath = path.join(tempDir, "duplicate-names.csv");
    const existingOutput = path.join(tempDir, "same.pdf");
    await fs.writeFile(csvPath, "filename,Value\nsame,first\nsame,second\n");
    await fs.writeFile(existingOutput, "existing bulk output");

    const result = await client.callTool({
      name: "bulk_fill_from_csv",
      arguments: {
        pdf_path: sourcePath,
        csv_path: csvPath,
        output_directory: tempDir,
        filename_column: "filename",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("duplicate filename");
    await expect(fs.readFile(existingOutput, "utf8")).resolves.toBe("existing bulk output");
    await expect(transactionArtifacts()).resolves.toEqual([]);
  }, 30_000);

  it("updates active-document state only after a page-plan output commits", async () => {
    await client.callTool({
      name: "set_active_document",
      arguments: { pdf_path: sourcePath },
    });
    const blockedOutput = path.join(tempDir, "blocked-plan.pdf");
    await fs.mkdir(blockedOutput);

    const result = await client.callTool({
      name: "apply_page_plan",
      arguments: {
        input_path: sourcePath,
        output_path: blockedOutput,
        plan: { page_order: [2, 1], rotations: {} },
      },
    });
    expect(result.isError).toBe(true);

    const active = await client.callTool({ name: "get_active_document", arguments: {} });
    expect(active.structuredContent).toMatchObject({
      active_path: sourcePath,
      last_mutation_tool: null,
    });
    await expect(transactionArtifacts()).resolves.toEqual([]);
  }, 30_000);
});
