#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const extensionDirectory = path.resolve(process.argv[2] || "");
const fixtureDirectory = path.resolve(process.argv[3] || "");
if (!process.argv[2] || !process.argv[3]) {
  throw new Error("Usage: macos-claude-installed-smoke.mjs <installed-extension-dir> <fixture-dir>");
}

const sdkDirectory = path.join(
  extensionDirectory,
  "node_modules",
  "@modelcontextprotocol",
  "sdk",
  "dist",
  "esm",
);
const { Client } = await import(pathToFileURL(path.join(sdkDirectory, "client", "index.js")));
const { StdioClientTransport } = await import(
  pathToFileURL(path.join(sdkDirectory, "client", "stdio.js"))
);

const serverPath = path.join(extensionDirectory, "server", "index.js");
const textFixture = path.join(fixtureDirectory, "synthetic-text-two-page.pdf");
const rasterFixture = path.join(fixtureDirectory, "synthetic-raster-only.pdf");
const mutationDirectory = path.join(fixtureDirectory, "mutation-output");
const toolNames = [];
const EXPECTED_TOOL_CONTRACT_SHA256 = "cf39bf8b35d8946153f2d1fc309813c72380bc0bb48bee6da531615576963e09";
let toolContractSha256;
let structuredToolCount;
let markdownHash;

function textContent(result) {
  return (result.content || [])
    .filter(item => item.type === "text")
    .map(item => item.text)
    .join("\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function connect(label) {
  const client = new Client({ name: `blueharbor-${label}`, version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--allowed-directories", fixtureDirectory],
    cwd: extensionDirectory,
    env: {
      ...process.env,
      ALLOWED_DIRECTORIES: JSON.stringify([fixtureDirectory]),
      DEFAULT_PDF_DIR: fixtureDirectory,
      DEFAULT_DOWNLOAD_DIR: fixtureDirectory,
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, transport };
}

const first = await connect("same-session");
let rasterHash;
try {
  const tools = await first.client.listTools();
  toolNames.push(...tools.tools.map(tool => tool.name).sort());
  assert(toolNames.length === 39, `Expected 39 tools, received ${toolNames.length}`);
  assert(new Set(toolNames).size === 39, "Tool names were not unique");
  toolContractSha256 = createHash("sha256")
    .update(JSON.stringify(tools.tools))
    .digest("hex");
  assert(
    toolContractSha256 === EXPECTED_TOOL_CONTRACT_SHA256,
    `Tool contract digest drifted: ${toolContractSha256}`,
  );
  structuredToolCount = tools.tools.filter(tool => tool.outputSchema).length;
  assert(structuredToolCount === 33, `Expected 33 structured tools, received ${structuredToolCount}`);

  const listed = await first.client.callTool({
    name: "list_pdfs",
    arguments: { directory: fixtureDirectory },
  });
  const listedText = textContent(listed);
  assert(!listed.isError, "list_pdfs failed in configured directory");
  assert(listedText.includes("synthetic-text-two-page.pdf"), "Text fixture was not listed");
  assert(listedText.includes("synthetic-raster-only.pdf"), "Raster fixture was not listed");

  const info = await first.client.callTool({
    name: "get_pdf_info",
    arguments: { pdf_path: textFixture },
  });
  assert(!info.isError, "get_pdf_info failed for the text fixture");
  assert(/Pages:\s*2\b/.test(textContent(info)), "get_pdf_info did not report two pages");

  const textRead = await first.client.callTool({
    name: "read_pdf_content",
    arguments: { pdf_path: textFixture },
  });
  assert(!textRead.isError, "read_pdf_content failed for the text fixture");
  assert(
    textContent(textRead).includes("BLUEHARBOR-TEXT-20260721"),
    "Text marker was not extracted",
  );

  const markdown = await first.client.callTool({
    name: "convert_pdf_to_markdown",
    arguments: { pdf_path: textFixture, max_markdown_bytes: 200000 },
  });
  assert(!markdown.isError, "convert_pdf_to_markdown failed for the text fixture");
  const markdownText = markdown.structuredContent?.markdown || "";
  markdownHash = createHash("sha256").update(markdownText, "utf8").digest("hex");
  assert(
    markdownText.includes("BLUEHARBOR-TEXT-20260721")
      && markdown.structuredContent?.markdown_sha256 === markdownHash,
    "Markdown conversion did not preserve and bind the text marker",
  );

  const rasterRender = await first.client.callTool({
    name: "render_pdf_page",
    arguments: { pdf_path: rasterFixture, page: 1, max_dimension_px: 900 },
  });
  const rasterImage = (rasterRender.content || []).find(item => item.type === "image");
  assert(!rasterRender.isError && rasterImage?.data, "Raster fixture did not return an image");
  rasterHash = createHash("sha256").update(Buffer.from(rasterImage.data, "base64")).digest("hex");

  const denied = await first.client.callTool({
    name: "get_pdf_info",
    arguments: {
      pdf_path: path.join(path.dirname(fixtureDirectory), "outside-policy-check.pdf"),
    },
  });
  assert(
    textContent(denied).includes("only allowed to access"),
    "Path outside the configured directory was not denied with the policy error",
  );

  const split = await first.client.callTool({
    name: "split_pdf",
    arguments: {
      input_path: textFixture,
      page_ranges: "1,2",
      output_directory: mutationDirectory,
    },
  });
  assert(!split.isError, `split_pdf failed: ${textContent(split)}`);
} finally {
  await first.transport.close();
}

const mutationFiles = (await readdir(mutationDirectory))
  .filter(filename => filename.endsWith(".pdf"))
  .sort();
assert(mutationFiles.length === 2, `Expected two mutation outputs, received ${mutationFiles.length}`);

const fresh = await connect("fresh-session");
try {
  const tools = await fresh.client.listTools();
  assert(tools.tools.length === 39, "Fresh session did not discover 39 tools");
  const info = await fresh.client.callTool({
    name: "get_pdf_info",
    arguments: { pdf_path: path.join(mutationDirectory, mutationFiles[1]) },
  });
  assert(!info.isError, "Fresh-session get_pdf_info call failed");
  assert(/Pages:\s*1\b/.test(textContent(info)), "Fresh-session mutation output was not one page");
} finally {
  await fresh.transport.close();
}

process.stdout.write(`${JSON.stringify({
  tool_count: toolNames.length,
  tool_names: toolNames,
  tool_contract_sha256: toolContractSha256,
  structured_tool_count: structuredToolCount,
  text_only_tool_count: toolNames.length - structuredToolCount,
  same_session_calls: 7,
  fresh_session_calls: 1,
  configured_directory_allowed: true,
  outside_directory_denied: true,
  text_marker_extracted: true,
  markdown_sha256: markdownHash,
  raster_png_sha256: rasterHash,
  mutation_files: mutationFiles,
}, null, 2)}\n`);
