#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const extensionDirectory = path.resolve(process.argv[2] || "");
const sourceArgument = path.resolve(process.argv[3] || "");
if (!process.argv[2] || !process.argv[3]) {
  throw new Error("Usage: macos-claude-installed-shannon.mjs <installed-extension-dir> <shannon-pdf>");
}

const EXPECTED_SOURCE_SHA256 = "6e4e3411984f3edf99dbfe8b941cb5e8a321379ff0cae6ae5c1f592ad8882ca8";
const EXPECTED_MARKDOWN_SHA256 = "1f1abbc9a6d652c40b7295dc67a0640218d6287aa212a9f0743fd618ff18bd82";
const EXPECTED_TOOL_CONTRACT_SHA256 = "109df9e468513e07377804bff842ac9c398923d88dc07c0ffd68c12a8c075e82";
const EXPECTED_PAGE_COUNT = 55;
const PAGE_SPAN = 10;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sourcePath = await realpath(sourceArgument);
assert(sourcePath === sourceArgument, "Shannon PDF path must be canonical");
const sourceBytes = await readFile(sourcePath);
const sourceSha256 = sha256(sourceBytes);
assert(sourceSha256 === EXPECTED_SOURCE_SHA256, "Shannon PDF bytes differ from the reviewed source");

const sdkDirectory = path.join(extensionDirectory, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
const { Client } = await import(pathToFileURL(path.join(sdkDirectory, "client", "index.js")));
const { StdioClientTransport } = await import(pathToFileURL(path.join(sdkDirectory, "client", "stdio.js")));
const serverPath = path.join(extensionDirectory, "server", "index.js");
const sourceDirectory = path.dirname(sourcePath);
const client = new Client({ name: "installed-claude-shannon-proof", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath, "--allowed-directories", sourceDirectory],
  cwd: extensionDirectory,
  env: {
    ...process.env,
    ALLOWED_DIRECTORIES: JSON.stringify([sourceDirectory]),
    DEFAULT_PDF_DIR: sourceDirectory,
    DEFAULT_DOWNLOAD_DIR: sourceDirectory,
  },
  stderr: "pipe",
});

const started = process.hrtime.bigint();
const chunks = [];
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert(tools.tools.length === 41, `Expected 41 installed tools, received ${tools.tools.length}`);
  assert(
    sha256(Buffer.from(JSON.stringify(tools.tools))) === EXPECTED_TOOL_CONTRACT_SHA256,
    "Installed tool contract differs from the reviewed build",
  );

  for (let startPage = 1; startPage <= EXPECTED_PAGE_COUNT; startPage += PAGE_SPAN) {
    const endPage = Math.min(EXPECTED_PAGE_COUNT, startPage + PAGE_SPAN - 1);
    const result = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: {
        pdf_path: sourcePath,
        start_page: startPage,
        end_page: endPage,
        max_items: 5000,
        max_characters: 100000,
        max_markdown_bytes: 200000,
        include_page_boundaries: true,
      },
    });
    const value = result.structuredContent;
    assert(!result.isError && value, `Installed conversion failed for pages ${startPage}-${endPage}`);
    assert(value.renderer?.version === "1.10.0", "Installed Markdown renderer version differs");
    assert(value.provenance?.layout?.parser_version === "5.4.624", "Installed PDF parser version differs");
    assert(value.provenance?.source?.sha256 === sourceSha256, "Installed conversion source identity differs");
    assert(value.provenance?.layout?.page_range?.start_page === startPage, "Installed conversion start page differs");
    assert(value.provenance?.layout?.page_range?.end_page === endPage, "Installed conversion end page differs");
    assert(value.provenance?.layout?.page_range?.total_pages === EXPECTED_PAGE_COUNT, "Installed page count differs");
    assert(value.markdown_sha256 === sha256(Buffer.from(value.markdown, "utf8")), "Installed chunk digest differs");
    chunks.push(value);
  }
} finally {
  await transport.close();
}

const markdown = chunks.map(chunk => chunk.markdown).join("\n\n");
const markdownSha256 = sha256(Buffer.from(markdown, "utf8"));
assert(
  markdownSha256 === EXPECTED_MARKDOWN_SHA256,
  `Installed Shannon Markdown differs from the reviewed output: expected ${EXPECTED_MARKDOWN_SHA256}, received ${markdownSha256}`,
);

process.stdout.write(`${JSON.stringify({
  installed_extension: extensionDirectory,
  source_sha256: sourceSha256,
  page_count: EXPECTED_PAGE_COUNT,
  page_calls: chunks.map(chunk => chunk.provenance.layout.page_range),
  conversion_statuses: [...new Set(chunks.map(chunk => chunk.conversion_status))].sort(),
  total_gap_count: chunks.reduce((total, chunk) => total + chunk.gaps.length, 0),
  replacement_character_count: [...markdown].filter(character => character === "\uFFFD").length,
  markdown_bytes: Buffer.byteLength(markdown, "utf8"),
  markdown_sha256: markdownSha256,
  elapsed_ms: Number(process.hrtime.bigint() - started) / 1e6,
}, null, 2)}\n`);
