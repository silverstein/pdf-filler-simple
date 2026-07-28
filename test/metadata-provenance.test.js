/**
 * Metadata provenance through merge and split (bead pdf-toolkit-mcp-igr.17).
 *
 * These tests enforce the omission-over-misattribution contract selected in
 * docs/METADATA_PROVENANCE.md.
 *
 * The motivating case is splitting a merged document whose old Info dictionary
 * described only its first input. A range consisting entirely of the second
 * input's pages then positively asserted the first input's author. That is
 * misattribution, not merely lost metadata, and it matters for a tool used on
 * contracts and forms.
 *
 * Single-source operations remain lossless. Multi-input merge metadata is
 * field-wise: a descriptive claim survives only when every input asserts the
 * exact same value.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFNumber } from "pdf-lib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createTestTempDirectory,
  removeTestTempDirectory,
} from "./helpers/temp-directory.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALL_TIMEOUT_MS = 20_000;

async function writeTaggedPdf(directory, tag, pageCount, filename = tag) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) doc.addPage([200, 200]);
  doc.setTitle(`Title ${tag}`);
  doc.setAuthor(`Author ${tag}`);
  doc.setSubject(`Subject ${tag}`);
  doc.setKeywords([`kw-${tag}`]);
  doc.setCreator(`Creator ${tag}`);
  const target = path.join(directory, `${filename}.pdf`);
  await fs.writeFile(target, await doc.save(), { mode: 0o600 });
  return target;
}

async function writeUntaggedPdf(directory, filename, pageCount = 1) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) doc.addPage([200, 200]);
  const target = path.join(directory, `${filename}.pdf`);
  await fs.writeFile(target, await doc.save(), { mode: 0o600 });
  return target;
}

async function writeMalformedTitlePdf(directory, filename) {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  info.set(PDFName.Title, PDFNumber.of(42));
  const target = path.join(directory, `${filename}.pdf`);
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
    creator: doc.getCreator(),
  };
}

describe("document metadata through merge and split", () => {
  let stateRoot;
  let client;
  let transport;
  let inputA;
  let inputB;
  let mergedPath;
  let mergeResult;

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

    mergeResult = await client.callTool(
      { name: "merge_pdfs", arguments: { input_paths: [inputA, inputB], output_path: mergedPath } },
      undefined,
      { timeout: CALL_TIMEOUT_MS, maxTotalTimeout: CALL_TIMEOUT_MS },
    );
    expect(mergeResult.isError).not.toBe(true);
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

  it("omits descriptive claims that disagree across merge inputs", async () => {
    const merged = await readInfo(mergedPath);
    expect(merged.title).toBeUndefined();
    expect(merged.author).toBeUndefined();
    expect(merged.subject).toBeUndefined();
    expect(merged.keywords).toBeUndefined();
    expect(merged.creator).not.toBe("Creator A");
    expect(merged.creator).not.toBe("Creator B");

    expect(mergeResult.structuredContent.metadata_fields_omitted.sort()).toEqual([
      "author",
      "keywords",
      "subject",
      "title",
    ]);
    expect(mergeResult.content[0].text).toContain(
      "Omitted unverified metadata: title, author, subject, keywords",
    );
  });

  it("does not reintroduce a discarded claim when splitting merged output", async () => {
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
    expect(secondRange.title).toBeUndefined();
    expect(secondRange.author).toBeUndefined();
    expect(secondRange.subject).toBeUndefined();
    expect(secondRange.keywords).toBeUndefined();
    expect(secondRange.author).not.toBe("Author B");
  });

  it("preserves all ordinary Info metadata for a single-input merge", async () => {
    const outputPath = path.join(stateRoot, "single-input-merge.pdf");
    const result = await client.callTool(
      { name: "merge_pdfs", arguments: { input_paths: [inputA], output_path: outputPath } },
      undefined,
      { timeout: CALL_TIMEOUT_MS, maxTotalTimeout: CALL_TIMEOUT_MS },
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.metadata_fields_omitted).toEqual([]);
    expect(await readInfo(outputPath)).toMatchObject({
      pages: 2,
      title: "Title A",
      author: "Author A",
      subject: "Subject A",
      keywords: "kw-A",
    });
  });

  it("preserves metadata when splitting an ordinary unmerged document", async () => {
    const outputDirectory = path.join(stateRoot, "ordinary-split");
    await fs.mkdir(outputDirectory, { recursive: true });
    const result = await client.callTool(
      {
        name: "split_pdf",
        arguments: {
          input_path: inputB,
          page_ranges: "1",
          output_directory: outputDirectory,
        },
      },
      undefined,
      { timeout: CALL_TIMEOUT_MS, maxTotalTimeout: CALL_TIMEOUT_MS },
    );
    expect(result.isError).not.toBe(true);
    const [filename] = await fs.readdir(outputDirectory);
    expect(await readInfo(path.join(outputDirectory, filename))).toMatchObject({
      pages: 1,
      title: "Title B",
      author: "Author B",
      subject: "Subject B",
      keywords: "kw-B",
    });
  });

  it("preserves a claim asserted identically by every merge input", async () => {
    const sameA = await writeTaggedPdf(stateRoot, "SAME", 1, "same-a");
    const sameB = await writeTaggedPdf(stateRoot, "SAME", 1, "same-b");
    const outputPath = path.join(stateRoot, "same-metadata.pdf");
    const result = await client.callTool(
      {
        name: "merge_pdfs",
        arguments: { input_paths: [sameA, sameB], output_path: outputPath },
      },
      undefined,
      { timeout: CALL_TIMEOUT_MS, maxTotalTimeout: CALL_TIMEOUT_MS },
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.metadata_fields_omitted).toEqual([]);
    expect(await readInfo(outputPath)).toMatchObject({
      title: "Title SAME",
      author: "Author SAME",
      subject: "Subject SAME",
      keywords: "kw-SAME",
    });
  });

  it("treats a present claim versus absence as unverified", async () => {
    const untagged = await writeUntaggedPdf(stateRoot, "untagged");
    const outputPath = path.join(stateRoot, "partial-metadata.pdf");
    const result = await client.callTool(
      {
        name: "merge_pdfs",
        arguments: { input_paths: [inputA, untagged], output_path: outputPath },
      },
      undefined,
      { timeout: CALL_TIMEOUT_MS, maxTotalTimeout: CALL_TIMEOUT_MS },
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.metadata_fields_omitted.sort()).toEqual([
      "author",
      "keywords",
      "subject",
      "title",
    ]);
    expect(await readInfo(outputPath)).toMatchObject({
      title: undefined,
      author: undefined,
      subject: undefined,
      keywords: undefined,
    });
  });

  it("omits malformed descriptive metadata without failing the merge", async () => {
    const malformed = await writeMalformedTitlePdf(stateRoot, "malformed-title");
    const outputPath = path.join(stateRoot, "malformed-metadata.pdf");
    const result = await client.callTool(
      {
        name: "merge_pdfs",
        arguments: { input_paths: [malformed, malformed], output_path: outputPath },
      },
      undefined,
      { timeout: CALL_TIMEOUT_MS, maxTotalTimeout: CALL_TIMEOUT_MS },
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.metadata_fields_omitted).toContain("title");
    expect((await readInfo(outputPath)).title).toBeUndefined();
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
