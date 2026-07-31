// Diagnostic probe for the Windows packed read_pdf_layout contract failure.
//
// Boots the packed server exactly the way the smoke does (same extraction,
// same special fixture filename, same environment) and prints the complete
// read_pdf_layout response plus captured server stderr, so a CI run reveals
// WHICH contract condition fails on win32 rather than the smoke's terse
// error. Workflow-only tooling: no product or qualification-script changes.

import { mkdtempSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { spawnSync } from "child_process";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bundlePath = path.resolve(process.argv[2] || "pdf-toolkit-mcp.mcpb");
const tempRoot = mkdtempSync(path.join(tmpdir(), "pdf-tools-layout-probe-"));
const extensionDir = path.join(tempRoot, "extension");
const specialFilename = process.platform === "win32"
  ? "smoke # quarterly draft.pdf"
  : "smoke # quarterly ? draft.pdf";
const fixturePath = path.join(tempRoot, specialFilename);

const unzip = spawnSync("unzip", ["-q", bundlePath, "-d", extensionDir], { encoding: "utf8" });
if (unzip.status !== 0) {
  console.log("PROBE unzip failed:", unzip.status, unzip.stderr?.slice(0, 500));
  process.exit(1);
}

const doc = await PDFDocument.create();
const page = doc.addPage([612, 792]);
const font = await doc.embedFont(StandardFonts.Helvetica);
page.drawText("Windows layout probe", { x: 72, y: 700, size: 18, font });
writeFileSync(fixturePath, await doc.save());
console.log("PROBE fixture bytes:", statSync(fixturePath).size);
console.log("PROBE fixture path:", fixturePath);

const client = new Client({ name: "windows-layout-probe", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(extensionDir, "server", "index.js")],
  cwd: extensionDir,
  env: {
    ALLOWED_DIRECTORIES: tempRoot,
    PDF_TOOLS_DISABLE_SYSTEM_RENDERER: "1",
  },
  stderr: "pipe",
});
const stderrChunks = [];
transport.stderr?.on("data", chunk => stderrChunks.push(chunk));
await client.connect(transport);

const layout = await client.callTool({
  name: "read_pdf_layout",
  arguments: { pdf_path: fixturePath, max_output_characters: 200000 },
});
console.log("PROBE isError:", layout.isError === true);
console.log("PROBE ir.version:", layout.structuredContent?.ir?.version);
console.log("PROBE source.size_bytes:", layout.structuredContent?.source?.size_bytes);
console.log("PROBE local stat size:", statSync(fixturePath).size);
console.log("PROBE full structuredContent (first 3000 chars):");
console.log(JSON.stringify(layout.structuredContent ?? null).slice(0, 3000));
if (layout.isError) {
  console.log("PROBE error content:", JSON.stringify(layout.content ?? null).slice(0, 3000));
}
console.log("PROBE server stderr (first 4000 chars):");
console.log(Buffer.concat(stderrChunks).toString("utf8").slice(0, 4000));
await transport.close();
