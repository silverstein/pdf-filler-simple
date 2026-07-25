/**
 * Metadata provenance through merge and split (bead pdf-toolkit-mcp-igr.17).
 *
 * These tests pin the CURRENT contract, including a behavior the decision
 * record in docs/METADATA_PROVENANCE.md identifies as wrong and slates for
 * change. They exist so the behavior is measured rather than assumed, and so
 * the fix in pdf-toolkit-mcp-igr.17.1 has a precise starting point.
 *
 * The important case is the last one. Splitting a merged document stamps the
 * merged file's Info onto every output, so a range consisting entirely of the
 * second input's pages positively asserts the first input's author. That is
 * misattribution, not merely lost metadata, and it matters for a tool used on
 * contracts and forms.
 *
 * When igr.17.1 lands, the assertions marked CURRENT are expected to change.
 * Read the decision record before editing them.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createTestTempDirectory,
  removeTestTempDirectory,
} from "./helpers/temp-directory.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALL_TIMEOUT_MS = 20_000;

async function writeTaggedPdf(directory, tag, pageCount) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) doc.addPage([200, 200]);
  doc.setTitle(`Title ${tag}`);
  doc.setAuthor(`Author ${tag}`);
  doc.setSubject(`Subject ${tag}`);
  doc.setKeywords([`kw-${tag}`]);
  doc.setCreator(`Creator ${tag}`);
  const target = path.join(directory, `${tag}.pdf`);
  await fs.writeFile(target, await doc.save(), { mode: 0o600 });
  return target;
}

async function readInfo(file) {
  const doc = await PDFDocument.load(await fs.readFile(file), { ignoreEncryption: true });
  return {
    pages: doc.getPageCount(),
    title: doc.getTitle(),
    author: doc.getAuthor(),
    subject: doc.getSubject(),
    keywords: doc.getKeywords(),
  };
}

describe("document metadata through merge and split", () => {
  let stateRoot;
  let client;
  let transport;
  let inputA;
  let inputB;
  let mergedPath;

  beforeAll(async () => {
    stateRoot = await createTestTempDirectory(REPO_ROOT, "metadata-provenance");
    inputA = await writeTaggedPdf(stateRoot, "A", 2);
    inputB = await writeTaggedPdf(stateRoot, "B", 2);
    mergedPath = path.join(stateRoot, "merged.pdf");

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server", "index.js")],
      cwd: REPO_ROOT,
      env: {
        ALLOWED_DIRECTORIES: stateRoot,
        DEFAULT_PDF_DIR: stateRoot,
        DEFAULT_DOWNLOAD_DIR: stateRoot,
        DEFAULT_PROFILES_DIR: stateRoot,
      },
      stderr: "pipe",
    });
    client = new Client({ name: "pdf-tools-metadata-provenance", version: "1.0.0" });
    await client.connect(transport);

    const merge = await client.callTool(
      { name: "merge_pdfs", arguments: { input_paths: [inputA, inputB], output_path: mergedPath } },
      undefined,
      { timeout: CALL_TIMEOUT_MS, maxTotalTimeout: CALL_TIMEOUT_MS },
    );
    expect(merge.isError).not.toBe(true);
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    await removeTestTempDirectory(stateRoot);
  });

  it("keeps every page from both inputs", async () => {
    const merged = await readInfo(mergedPath);
    expect(merged.pages).toBe(4);
  });

  it("CURRENT: merge inherits the first input's Info and discards the rest", async () => {
    // Slated to change in igr.17.1: where inputs disagree the field should be
    // omitted rather than resolved in favour of whichever was listed first.
    const merged = await readInfo(mergedPath);
    expect(merged.title).toBe("Title A");
    expect(merged.author).toBe("Author A");
    expect(merged.subject).toBe("Subject A");
    expect(merged.keywords).toBe("kw-A");
  });

  it("CURRENT: split misattributes authorship of pages that came from another document", async () => {
    // The measured defect. pages 3-4 are entirely input B's, yet the output
    // asserts input A's author. Absence would be honest; this is a false claim.
    const outputDirectory = path.join(stateRoot, "split");
    await fs.mkdir(outputDirectory, { recursive: true });
    const split = await client.callTool(
      {
        name: "split_pdf",
        arguments: { input_path: mergedPath, page_ranges: "1-2,3-4", output_directory: outputDirectory },
      },
      undefined,
      { timeout: CALL_TIMEOUT_MS, maxTotalTimeout: CALL_TIMEOUT_MS },
    );
    expect(split.isError).not.toBe(true);

    const produced = (await fs.readdir(outputDirectory)).sort();
    expect(produced).toHaveLength(2);
    const secondRange = await readInfo(path.join(outputDirectory, produced[1]));

    expect(secondRange.pages).toBe(2);
    // Pages sourced from B...
    expect(secondRange.author).toBe("Author A"); // ...labelled as A.
    expect(secondRange.author).not.toBe("Author B");
  });

  it("adds no private page-piece dictionaries to merged output", async () => {
    // The decision record rejects PieceInfo permanently, not just by default:
    // general viewers ignore it and Acrobat actively discards foreign private
    // data, so provenance stored there is invisible and unreliable, while still
    // carrying one party's metadata into another party's file.
    const bytes = await fs.readFile(mergedPath);
    expect(bytes.includes(Buffer.from("/PieceInfo", "latin1"))).toBe(false);
  });

  it("does not carry a source XMP block forward into the merged document", async () => {
    // Copying source XMP wholesale would import claims that are true only of the
    // original, including standards-conformance assertions the merged file does
    // not satisfy.
    const bytes = await fs.readFile(mergedPath);
    expect(bytes.includes(Buffer.from("pdfaid:conformance", "latin1"))).toBe(false);
  });
});
