#!/usr/bin/env node

/**
 * One-process-group campaign row for bead pdf-toolkit-mcp-33l.
 *
 * This runner intentionally executes exactly one generated fixture and one
 * product tool. A native parent supervisor owns the wall and physical-memory
 * ceilings for this process, the MCP server it starts, and all descendants.
 * The runner emits one byte-bounded canonical record only after the product
 * call, same-server canary, transport close, and filesystem inventory finish.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument } from "pdf-lib";
import { canonicalJson } from "../eval/docling-macos-supervisor.js";
import { makeCompressedContentFixture } from "./deep-malformed-fixtures.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REQUEST_PROTOCOL = "pdf-tools.deep-malformed-row-request.v1";
const RESULT_PROTOCOL = "pdf-tools.deep-malformed-row-result.v1";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_CANONICAL_BYTES = 1024 * 1024;
const MAX_INVENTORY_ENTRIES = 512;
const RAW_INTERNAL_PATTERN =
  /(?:node_modules[\\/]|(?:file|webpack):\/\/|\/Users\/|\/home\/|[A-Za-z]:\\|at\s+\S+\s+\([^)]*:\d+:\d+\)|\b(?:TypeError|ReferenceError|SyntaxError):)/;

const TOOL_ARGUMENTS = Object.freeze({
  get_pdf_info: pdfPath => ({ pdf_path: pdfPath }),
  read_pdf_content: pdfPath => ({ pdf_path: pdfPath }),
  get_page_analysis: pdfPath => ({ pdf_path: pdfPath }),
  render_pdf_page: pdfPath => ({ pdf_path: pdfPath, page_number: 1 }),
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort());
}

async function readRequest() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("Campaign row request exceeds its byte ceiling");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    throw new Error("Campaign row request must be valid JSON");
  }
  if (canonicalJson(request) !== text) throw new Error("Campaign row request must be canonical JSON");
  if (!exactKeys(request, [
    "call_timeout_ms",
    "expanded_bytes",
    "fixture",
    "protocol",
    "tool",
  ])
    || request.protocol !== REQUEST_PROTOCOL
    || request.fixture !== "contiguous-b"
    || !Object.hasOwn(TOOL_ARGUMENTS, request.tool)
    || !Number.isSafeInteger(request.expanded_bytes)
    || request.expanded_bytes < 1024
    || request.expanded_bytes > 16 << 20
    || !Number.isSafeInteger(request.call_timeout_ms)
    || request.call_timeout_ms < 1000
    || request.call_timeout_ms > 25_000) {
    throw new Error("Campaign row request violates its exact schema");
  }
  return Object.freeze(request);
}

async function privateWorkRoot() {
  const workRoot = process.env.PDF_TOOLS_CAMPAIGN_WORK_ROOT;
  if (typeof workRoot !== "string" || path.resolve(workRoot) !== workRoot
    || path.dirname(workRoot) !== process.cwd()) {
    throw new Error("Campaign work root must be a direct canonical child of cwd");
  }
  const metadata = await fs.lstat(workRoot, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || Number(metadata.mode & 0o777n) !== 0o700
    || await fs.realpath(workRoot) !== workRoot) {
    throw new Error("Campaign work root must be a real mode-0700 directory");
  }
  return workRoot;
}

async function inventory(root) {
  const rows = [];
  async function visit(directory, relativeDirectory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (rows.length >= MAX_INVENTORY_ENTRIES) {
        throw new Error("Campaign filesystem inventory exceeds its entry ceiling");
      }
      const relative = path.posix.join(relativeDirectory, entry.name);
      const filename = path.join(directory, entry.name);
      const metadata = await fs.lstat(filename, { bigint: true });
      if (metadata.isSymbolicLink()) throw new Error("Campaign filesystem contains a symbolic link");
      if (metadata.isDirectory()) {
        rows.push({
          path: `${relative}/`,
          kind: "directory",
          mode: Number(metadata.mode & 0o777n),
        });
        await visit(filename, relative);
      } else if (metadata.isFile() && metadata.nlink === 1n) {
        const bytes = await fs.readFile(filename);
        rows.push({
          path: relative,
          kind: "file",
          mode: Number(metadata.mode & 0o777n),
          bytes: bytes.length,
          sha256: sha256(bytes),
        });
      } else {
        throw new Error("Campaign filesystem contains a non-regular entry");
      }
    }
  }
  await visit(root, "");
  return rows;
}

function responseSummary(response) {
  const serialized = Buffer.from(canonicalJson(response), "utf8");
  if (serialized.length > MAX_RESPONSE_CANONICAL_BYTES) {
    throw new Error("Product response exceeds the campaign response ceiling");
  }
  const content = Array.isArray(response?.content) ? response.content : [];
  const contentSummary = content.map(item => {
    const serializedItem = Buffer.from(canonicalJson(item), "utf8");
    const text = typeof item?.text === "string" ? item.text : "";
    return {
      type: typeof item?.type === "string" ? item.type : null,
      canonical_bytes: serializedItem.length,
      sha256: sha256(serializedItem),
      raw_internal_leak: RAW_INTERNAL_PATTERN.test(text),
    };
  });
  return {
    canonical_bytes: serialized.length,
    sha256: sha256(serialized),
    is_error: response?.isError === true,
    content: contentSummary,
    raw_internal_leak: contentSummary.some(item => item.raw_internal_leak),
  };
}

function errorSummary(error) {
  const message = String(error?.message ?? error);
  return {
    name: typeof error?.name === "string" ? error.name : null,
    code: typeof error?.code === "string" || typeof error?.code === "number"
      ? String(error.code)
      : null,
    message_bytes: Buffer.byteLength(message),
    message_sha256: sha256(Buffer.from(message, "utf8")),
    timeout: /timed out|timeout/i.test(message),
    raw_internal_leak: RAW_INTERNAL_PATTERN.test(message),
  };
}

async function main() {
  const request = await readRequest();
  const workRoot = await privateWorkRoot();
  const stateRoot = path.join(workRoot, "state");
  const profilesRoot = path.join(workRoot, "profiles");
  await fs.mkdir(stateRoot, { mode: 0o700 });
  await fs.mkdir(profilesRoot, { mode: 0o700 });

  const fixture = makeCompressedContentFixture({
    name: `contiguous-b-${request.expanded_bytes}`,
    expandedBytes: request.expanded_bytes,
    pattern: "B",
    note: "Dose-response arm for PDF.js known-command recovery and retained path painting.",
  });
  const fixturePath = path.join(stateRoot, "candidate.pdf");
  await fs.writeFile(fixturePath, fixture.bytes, { mode: 0o600, flag: "wx" });

  const control = await PDFDocument.create();
  control.addPage([100, 100]);
  const controlPath = path.join(stateRoot, "control.pdf");
  await fs.writeFile(controlPath, await control.save(), { mode: 0o600, flag: "wx" });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO_ROOT, "server", "index.js")],
    cwd: REPO_ROOT,
    env: {
      ALLOWED_DIRECTORIES: workRoot,
      DEFAULT_PDF_DIR: stateRoot,
      DEFAULT_DOWNLOAD_DIR: stateRoot,
      DEFAULT_PROFILES_DIR: profilesRoot,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    },
    stderr: "inherit",
  });
  const client = new Client({ name: "pdf-tools-deep-malformed-row", version: "1.0.0" });
  let baseline;
  let product;
  let canary;
  let serverPid = null;
  const started = process.hrtime.bigint();
  let productElapsedNs = null;
  let before;
  try {
    await client.connect(transport);
    serverPid = transport.pid;
    try {
      const response = await client.callTool(
        {
          name: "get_pdf_info",
          arguments: { pdf_path: controlPath },
        },
        undefined,
        {
          timeout: request.call_timeout_ms,
          maxTotalTimeout: request.call_timeout_ms,
        },
      );
      baseline = { outcome: "response", response: responseSummary(response) };
    } catch (error) {
      baseline = { outcome: "transport_error", error: errorSummary(error) };
    }
    before = await inventory(workRoot);
    const productStarted = process.hrtime.bigint();
    try {
      const response = await client.callTool(
        {
          name: request.tool,
          arguments: TOOL_ARGUMENTS[request.tool](fixturePath),
        },
        undefined,
        {
          timeout: request.call_timeout_ms,
          maxTotalTimeout: request.call_timeout_ms,
        },
      );
      product = { outcome: "response", response: responseSummary(response) };
    } catch (error) {
      product = { outcome: "transport_error", error: errorSummary(error) };
    }
    productElapsedNs = Number(process.hrtime.bigint() - productStarted);
    try {
      const response = await client.callTool(
        {
          name: "get_pdf_info",
          arguments: { pdf_path: controlPath },
        },
        undefined,
        {
          timeout: request.call_timeout_ms,
          maxTotalTimeout: request.call_timeout_ms,
        },
      );
      canary = { outcome: "response", response: responseSummary(response) };
    } catch (error) {
      canary = { outcome: "transport_error", error: errorSummary(error) };
    }
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
  const elapsedNs = Number(process.hrtime.bigint() - started);
  const after = await inventory(workRoot);

  const result = {
    protocol: RESULT_PROTOCOL,
    request,
    fixture: {
      input_bytes: fixture.bytes.length,
      input_sha256: sha256(fixture.bytes),
      compressed_bytes: fixture.compressedLength,
      expanded_bytes: fixture.expandedLength,
      expansion_ratio: fixture.expansionRatio,
      pattern: fixture.pattern,
    },
    execution: {
      pid: process.pid,
      server_pid: serverPid,
      total_elapsed_ns: elapsedNs,
      product_elapsed_ns: productElapsedNs,
    },
    baseline_canary: baseline,
    product,
    same_server_canary: canary,
    filesystem: {
      before,
      after,
      unchanged: canonicalJson(before) === canonicalJson(after),
    },
  };
  const output = Buffer.from(`${canonicalJson(result)}\n`, "utf8");
  if (output.length > 64 * 1024) throw new Error("Campaign row result exceeds its byte ceiling");
  process.stdout.write(output);
}

main().catch(error => {
  const failure = {
    protocol: RESULT_PROTOCOL,
    harness_error: errorSummary(error),
  };
  process.stdout.write(`${canonicalJson(failure)}\n`);
  process.exitCode = 1;
});
