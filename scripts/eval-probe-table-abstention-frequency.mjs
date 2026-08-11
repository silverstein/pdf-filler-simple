// Aggregate-only operational probe for verified-vision table abstention.
// It reports counts and gap histograms only: never filenames or PDF content.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(process.argv[2] || path.join(os.homedir(), "Documents"));
const maxDocuments = Number(process.argv[3] || 90);
const maxPages = Number(process.argv[4] || 6);
const server = path.resolve("server/index.js");

if (!Number.isSafeInteger(maxDocuments) || maxDocuments < 1) {
  throw new Error("max_documents must be a positive integer");
}
if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
  throw new Error("max_pages must be a positive integer");
}

function walk(directory, paths) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return paths;
  }
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (paths.length < 20000) walk(candidate, paths);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
      paths.push(candidate);
    }
  }
  return paths;
}

const allDocuments = walk(root, []).sort();
const step = Math.max(1, Math.floor(allDocuments.length / maxDocuments));
const sample = [];
for (let index = 0; index < allDocuments.length && sample.length < maxDocuments; index += step) {
  sample.push(allDocuments[index]);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [server],
  env: {
    ...process.env,
    ALLOWED_DIRECTORIES: root,
    PDF_TOOLS_ALLOWED_DIRECTORIES: root,
  },
  stderr: "ignore",
});
const client = new Client(
  { name: "table-abstention-frequency-probe", version: "1.0.0" },
  { capabilities: {} },
);
await client.connect(transport);

const tally = {
  sampled: sample.length,
  corpus_total: allDocuments.length,
  pages_per_document_cap: maxPages,
  ok: 0,
  errored: 0,
  err_encrypted: 0,
  err_toolarge: 0,
  err_other: 0,
  docs_with_reconstructed_table: 0,
  docs_with_table_abstention: 0,
  docs_with_table_signal: 0,
  docs_no_table_signal: 0,
  gap_hist: {},
  topology_reason: {},
};

function structured(result) {
  return result.structuredContent || null;
}

function textOf(result) {
  const content = (result.content || []).find(part => part.type === "text");
  return content ? content.text : "";
}

function recordError(error) {
  tally.errored++;
  const message = String(error?.message || error).toLowerCase();
  if (message.includes("encrypt") || message.includes("password")) tally.err_encrypted++;
  else if (message.includes("too large") || message.includes("exceeds") || message.includes("size")) tally.err_toolarge++;
  else tally.err_other++;
}

try {
  for (const pdfPath of sample) {
    let info;
    try {
      const result = await client.callTool({ name: "get_pdf_info", arguments: { pdf_path: pdfPath } });
      info = structured(result) || {};
    } catch (error) {
      recordError(error);
      continue;
    }

    const reportedPages = info.page_count || info.pages?.count || info.geometry?.page_count;
    const pageCount = Number.isFinite(reportedPages) && reportedPages > 0 ? reportedPages : 1;
    try {
      const result = await client.callTool({
        name: "convert_pdf_to_markdown",
        arguments: { pdf_path: pdfPath, start_page: 1, end_page: Math.min(pageCount, maxPages) },
      });
      const resultData = structured(result);
      const markdown = resultData?.markdown || textOf(result) || "";
      const gaps = resultData?.gaps || [];
      tally.ok++;
      const codes = new Set();
      for (const gap of gaps) {
        const code = typeof gap === "string" ? gap : gap?.code;
        if (!code) continue;
        tally.gap_hist[code] = (tally.gap_hist[code] || 0) + 1;
        codes.add(code);
        if (code === "TABLE_TOPOLOGY_UNKNOWN") {
          const message = gap?.message || "";
          const reason = /header/i.test(message)
            ? "no_header_evidence"
            : /column topology/i.test(message)
              ? "topology_unreconstructable"
              : /ruled rectangle/i.test(message)
                ? "ruling_topology"
                : "other";
          tally.topology_reason[reason] = (tally.topology_reason[reason] || 0) + 1;
        }
      }
      const abstained = codes.has("TABLE_TOPOLOGY_UNKNOWN") || codes.has("TABLE_RULING_UNSUPPORTED");
      const reconstructed = /\n\|[^\n]*\n\|[ :-]+\|/.test(`\n${markdown}`) || /\|\s*---\s*\|/.test(markdown);
      if (reconstructed) tally.docs_with_reconstructed_table++;
      if (abstained) tally.docs_with_table_abstention++;
      if (reconstructed || abstained) tally.docs_with_table_signal++;
      else tally.docs_no_table_signal++;
    } catch (error) {
      recordError(error);
    }
  }
} finally {
  await client.close();
}

const signal = tally.docs_with_table_signal;
tally.abstention_rate_among_table_docs = signal
  ? Number((tally.docs_with_table_abstention / signal).toFixed(3))
  : null;
tally.reconstruction_rate_among_table_docs = signal
  ? Number((tally.docs_with_reconstructed_table / signal).toFixed(3))
  : null;
console.log(JSON.stringify(tally, null, 2));
