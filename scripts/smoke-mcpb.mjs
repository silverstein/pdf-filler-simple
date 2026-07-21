#!/usr/bin/env node

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

function extract(bundlePath, destination) {
  const result = spawnSync("unzip", ["-q", bundlePath, "-d", destination], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`unzip exited with status ${result.status}: ${result.stderr || result.stdout}`);
  }
}

async function createFixture(filename) {
  const document = await PDFDocument.create();
  const page = document.addPage([300, 180]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Packaged PDF Tools smoke test", { x: 30, y: 100, size: 18, font });
  writeFileSync(filename, await document.save());
}

async function main() {
  const bundlePath = path.resolve(process.argv[2] || path.join(REPO_ROOT, "pdf-toolkit-mcp.mcpb"));
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pdf-tools-mcpb-smoke-"));
  const extensionDir = path.join(tempRoot, "extension");
  const fixturePath = path.join(tempRoot, "smoke.pdf");
  let transport;

  try {
    extract(bundlePath, extensionDir);
    await createFixture(fixturePath);

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

    const tools = await client.listTools();
    if (!tools.tools.some(tool => tool.name === "render_pdf_page")) {
      throw new Error("Packed server did not expose render_pdf_page");
    }

    const result = await client.callTool({
      name: "render_pdf_page",
      arguments: { pdf_path: fixturePath, page: 1, max_dimension_px: 800 },
    });
    if (result.isError || !result.content?.some(item => item.type === "image")) {
      throw new Error("Packed render_pdf_page did not return an image");
    }

    console.log(
      `Packed MCPB smoke passed on ${process.platform}/${process.arch}: ${tools.tools.length} tools; native rasterization returned an image.`,
    );
  } finally {
    await transport?.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`Packed MCPB smoke failed: ${error.message}`);
  process.exitCode = 1;
});
