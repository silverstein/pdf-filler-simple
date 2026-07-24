import { createHash } from "node:crypto";
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

async function exactIdentity(outputPath) {
  const identity = await client.callTool({
    name: "get_pdf_identity",
    arguments: { pdf_path: outputPath },
  });
  expect(identity.isError).not.toBe(true);
  return {
    canonical_path: identity.structuredContent.canonical_path,
    size_bytes: identity.structuredContent.size_bytes,
    sha256: identity.structuredContent.sha256,
  };
}

async function exactFileIdentity(outputPath) {
  const [canonicalPath, bytes, stats] = await Promise.all([
    fs.realpath(outputPath),
    fs.readFile(outputPath),
    fs.stat(outputPath),
  ]);
  return {
    canonical_path: canonicalPath,
    size_bytes: stats.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
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
    const existing = await PDFDocument.create();
    existing.addPage([200, 200]);
    const existingBytes = Buffer.from(await existing.save());
    await fs.writeFile(firstOutput, existingBytes);
    await fs.mkdir(blockedOutput);
    const identity = await client.callTool({
      name: "get_pdf_identity",
      arguments: { pdf_path: firstOutput },
    });

    const result = await client.callTool({
      name: "split_pdf",
      arguments: {
        input_path: sourcePath,
        page_ranges: "1,2",
        output_directory: tempDir,
        expected_output_identities: [{
          output_path: firstOutput,
          canonical_path: identity.structuredContent.canonical_path,
          size_bytes: identity.structuredContent.size_bytes,
          sha256: identity.structuredContent.sha256,
        }],
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("Atomic PDF output target is a directory");
    await expect(fs.readFile(firstOutput)).resolves.toEqual(existingBytes);
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

  it("fails closed across missing, stale, duplicate, unrelated, and disappeared bulk identities", async () => {
    const missingCsv = path.join(tempDir, "bulk-missing-identity.csv");
    const missingOutput = path.join(tempDir, "bulk-missing-identity.pdf");
    await fs.writeFile(missingCsv, "filename,Value\nbulk-missing-identity,one\n");
    await fs.writeFile(missingOutput, "existing missing-identity output");
    const missingBefore = await fs.readFile(missingOutput);
    const missing = await client.callTool({
      name: "bulk_fill_from_csv",
      arguments: {
        pdf_path: sourcePath,
        csv_path: missingCsv,
        output_directory: tempDir,
        filename_column: "filename",
      },
    });
    expect(missing.isError).toBe(true);
    expect(missing.content?.[0]?.text).toContain("ATOMIC_OUTPUT_TARGET_EXISTS");
    await expect(fs.readFile(missingOutput)).resolves.toEqual(missingBefore);

    const staleCsv = path.join(tempDir, "bulk-stale-identity.csv");
    const staleOutput = path.join(tempDir, "bulk-stale-identity.pdf");
    await fs.writeFile(staleCsv, "filename,Value\nbulk-stale-identity,two\n");
    await fs.copyFile(sourcePath, staleOutput);
    const staleIdentity = await exactIdentity(staleOutput);
    await fs.appendFile(staleOutput, " drift");
    const staleBefore = await fs.readFile(staleOutput);
    const stale = await client.callTool({
      name: "bulk_fill_from_csv",
      arguments: {
        pdf_path: sourcePath,
        csv_path: staleCsv,
        output_directory: tempDir,
        filename_column: "filename",
        expected_output_identities: [{
          output_path: staleOutput,
          ...staleIdentity,
        }],
      },
    });
    expect(stale.isError).toBe(true);
    expect(stale.content?.[0]?.text).toContain(
      "ATOMIC_OUTPUT_EXPECTED_IDENTITY_CHANGED",
    );
    await expect(fs.readFile(staleOutput)).resolves.toEqual(staleBefore);

    const duplicateCsv = path.join(tempDir, "bulk-duplicate-identity.csv");
    const duplicateOutput = path.join(tempDir, "bulk-duplicate-identity.pdf");
    await fs.writeFile(duplicateCsv, "filename,Value\nbulk-duplicate-identity,three\n");
    await fs.copyFile(sourcePath, duplicateOutput);
    const duplicateIdentity = await exactIdentity(duplicateOutput);
    const duplicateBefore = await fs.readFile(duplicateOutput);
    const duplicate = await client.callTool({
      name: "bulk_fill_from_csv",
      arguments: {
        pdf_path: sourcePath,
        csv_path: duplicateCsv,
        output_directory: tempDir,
        filename_column: "filename",
        expected_output_identities: [
          { output_path: duplicateOutput, ...duplicateIdentity },
          { output_path: duplicateOutput, ...duplicateIdentity },
        ],
      },
    });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content?.[0]?.text).toContain(
      "Duplicate expected output identity",
    );
    await expect(fs.readFile(duplicateOutput)).resolves.toEqual(duplicateBefore);

    const unrelatedCsv = path.join(tempDir, "bulk-unrelated-identity.csv");
    const unrelatedOutput = path.join(tempDir, "bulk-unrelated-target.pdf");
    const unrelatedManifestPath = path.join(tempDir, "not-a-bulk-output.pdf");
    await fs.writeFile(unrelatedCsv, "filename,Value\nbulk-unrelated-target,four\n");
    await fs.copyFile(sourcePath, unrelatedManifestPath);
    const unrelatedIdentity = await exactIdentity(unrelatedManifestPath);
    const unrelated = await client.callTool({
      name: "bulk_fill_from_csv",
      arguments: {
        pdf_path: sourcePath,
        csv_path: unrelatedCsv,
        output_directory: tempDir,
        filename_column: "filename",
        expected_output_identities: [{
          output_path: unrelatedManifestPath,
          ...unrelatedIdentity,
        }],
      },
    });
    expect(unrelated.isError).toBe(true);
    expect(unrelated.content?.[0]?.text).toContain(
      "OUTPUT_BATCH_IDENTITY_MISMATCH",
    );
    await expect(fs.stat(unrelatedOutput)).rejects.toMatchObject({ code: "ENOENT" });

    const disappearedCsv = path.join(tempDir, "bulk-disappeared-identity.csv");
    const disappearedOutput = path.join(tempDir, "bulk-disappeared-identity.pdf");
    await fs.writeFile(disappearedCsv, "filename,Value\nbulk-disappeared-identity,five\n");
    await fs.copyFile(sourcePath, disappearedOutput);
    const disappearedIdentity = await exactIdentity(disappearedOutput);
    await fs.unlink(disappearedOutput);
    const disappeared = await client.callTool({
      name: "bulk_fill_from_csv",
      arguments: {
        pdf_path: sourcePath,
        csv_path: disappearedCsv,
        output_directory: tempDir,
        filename_column: "filename",
        expected_output_identities: [{
          output_path: disappearedOutput,
          ...disappearedIdentity,
        }],
      },
    });
    expect(disappeared.isError).toBe(true);
    expect(disappeared.content?.[0]?.text).toContain(
      "ATOMIC_OUTPUT_EXPECTED_TARGET_MISSING",
    );
    await expect(fs.stat(disappearedOutput)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(transactionArtifacts()).resolves.toEqual([]);
  }, 30_000);

  it.runIf(process.platform !== "win32")(
    "rejects bulk destinations that alias the template, CSV, or one another",
    async () => {
      const templateCsv = path.join(tempDir, "bulk-template-alias.csv");
      await fs.writeFile(templateCsv, "filename,Value\nsource,template\n");
      const sourceBefore = await fs.readFile(sourcePath);
      const templateAlias = await client.callTool({
        name: "bulk_fill_from_csv",
        arguments: {
          pdf_path: sourcePath,
          csv_path: templateCsv,
          output_directory: tempDir,
          filename_column: "filename",
          expected_output_identities: [{
            output_path: sourcePath,
            ...await exactIdentity(sourcePath),
          }],
        },
      });
      expect(templateAlias.isError).toBe(true);
      expect(templateAlias.content?.[0]?.text).toContain("OUTPUT_ALIASES_INPUT");
      await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBefore);

      const csvPath = path.join(tempDir, "bulk-csv-alias.csv");
      const csvAliasPath = path.join(tempDir, "bulk-csv-alias-output.pdf");
      await fs.writeFile(csvPath, "filename,Value\nbulk-csv-alias-output,csv\n");
      await fs.link(csvPath, csvAliasPath);
      const csvBefore = await fs.readFile(csvPath);
      const csvAlias = await client.callTool({
        name: "bulk_fill_from_csv",
        arguments: {
          pdf_path: sourcePath,
          csv_path: csvPath,
          output_directory: tempDir,
          filename_column: "filename",
          expected_output_identities: [{
            output_path: csvAliasPath,
            ...await exactFileIdentity(csvAliasPath),
          }],
        },
      });
      expect(csvAlias.isError).toBe(true);
      expect(csvAlias.content?.[0]?.text).toContain("OUTPUT_ALIASES_INPUT");
      await expect(fs.readFile(csvPath)).resolves.toEqual(csvBefore);
      await expect(fs.readFile(csvAliasPath)).resolves.toEqual(csvBefore);

      const duplicateAliasCsv = path.join(tempDir, "bulk-output-alias.csv");
      const firstAlias = path.join(tempDir, "bulk-output-alias-a.pdf");
      const secondAlias = path.join(tempDir, "bulk-output-alias-b.pdf");
      await fs.writeFile(
        duplicateAliasCsv,
        "filename,Value\nbulk-output-alias-a,a\nbulk-output-alias-b,b\n",
      );
      await fs.copyFile(sourcePath, firstAlias);
      await fs.link(firstAlias, secondAlias);
      const sharedBefore = await fs.readFile(firstAlias);
      const duplicateAliases = await client.callTool({
        name: "bulk_fill_from_csv",
        arguments: {
          pdf_path: sourcePath,
          csv_path: duplicateAliasCsv,
          output_directory: tempDir,
          filename_column: "filename",
          expected_output_identities: [
            { output_path: firstAlias, ...await exactIdentity(firstAlias) },
            { output_path: secondAlias, ...await exactIdentity(secondAlias) },
          ],
        },
      });
      expect(duplicateAliases.isError).toBe(true);
      expect(duplicateAliases.content?.[0]?.text).toContain("OUTPUT_TARGETS_ALIAS");
      await expect(fs.readFile(firstAlias)).resolves.toEqual(sharedBefore);
      await expect(fs.readFile(secondAlias)).resolves.toEqual(sharedBefore);
      await expect(transactionArtifacts()).resolves.toEqual([]);
    },
    30_000,
  );

  it.runIf(process.platform !== "win32")(
    "rejects a merge destination that aliases any one of multiple inputs",
    async () => {
      const secondInput = path.join(tempDir, "merge-second-input.pdf");
      const outputPath = path.join(tempDir, "merge-second-input-alias.pdf");
      await fs.copyFile(sourcePath, secondInput);
      await fs.link(secondInput, outputPath);
      const [sourceBefore, secondBefore] = await Promise.all([
        fs.readFile(sourcePath),
        fs.readFile(secondInput),
      ]);

      const result = await client.callTool({
        name: "merge_pdfs",
        arguments: {
          input_paths: [sourcePath, secondInput],
          output_path: outputPath,
          expected_output_identity: await exactIdentity(outputPath),
        },
      });

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("OUTPUT_ALIASES_INPUT");
      await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBefore);
      await expect(fs.readFile(secondInput)).resolves.toEqual(secondBefore);
      await expect(fs.readFile(outputPath)).resolves.toEqual(secondBefore);
      await expect(transactionArtifacts()).resolves.toEqual([]);
    },
    30_000,
  );

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

  it("requires and revalidates exact identity before replacing a distinct output", async () => {
    const outputPath = path.join(tempDir, "approved-plan-output.pdf");
    const existing = await PDFDocument.create();
    existing.addPage([300, 300]);
    await fs.writeFile(outputPath, await existing.save());
    const before = await fs.readFile(outputPath);

    const blind = await client.callTool({
      name: "apply_page_plan",
      arguments: {
        input_path: sourcePath,
        output_path: outputPath,
        plan: { page_order: [2, 1], rotations: {} },
      },
    });
    expect(blind.isError).toBe(true);
    expect(blind.content?.[0]?.text).toContain("ATOMIC_OUTPUT_TARGET_EXISTS");
    await expect(fs.readFile(outputPath)).resolves.toEqual(before);

    const identity = await client.callTool({
      name: "get_pdf_identity",
      arguments: { pdf_path: outputPath },
    });
    expect(identity.isError).not.toBe(true);

    await fs.appendFile(outputPath, Buffer.from("\n"));
    const stale = await client.callTool({
      name: "apply_page_plan",
      arguments: {
        input_path: sourcePath,
        output_path: outputPath,
        plan: { page_order: [2, 1], rotations: {} },
        expected_output_identity: {
          canonical_path: identity.structuredContent.canonical_path,
          size_bytes: identity.structuredContent.size_bytes,
          sha256: identity.structuredContent.sha256,
        },
      },
    });
    expect(stale.isError).toBe(true);
    expect(stale.content?.[0]?.text).toContain(
      "ATOMIC_OUTPUT_EXPECTED_IDENTITY_CHANGED",
    );

    const current = await client.callTool({
      name: "get_pdf_identity",
      arguments: { pdf_path: outputPath },
    });
    const replaced = await client.callTool({
      name: "apply_page_plan",
      arguments: {
        input_path: sourcePath,
        output_path: outputPath,
        plan: { page_order: [2, 1], rotations: {} },
        expected_output_identity: {
          canonical_path: current.structuredContent.canonical_path,
          size_bytes: current.structuredContent.size_bytes,
          sha256: current.structuredContent.sha256,
        },
      },
    });
    expect(replaced.isError).not.toBe(true);
    expect(replaced.structuredContent.page_order).toEqual([2, 1]);
    await expect(transactionArtifacts()).resolves.toEqual([]);
  }, 30_000);

  it.runIf(process.platform !== "win32")(
    "rejects an approved output that is a hardlink alias to the input",
    async () => {
      const outputPath = path.join(tempDir, "source-hardlink-output.pdf");
      await fs.link(sourcePath, outputPath);
      const sourceBefore = await fs.readFile(sourcePath);
      const identity = await client.callTool({
        name: "get_pdf_identity",
        arguments: { pdf_path: outputPath },
      });

      const result = await client.callTool({
        name: "apply_page_plan",
        arguments: {
          input_path: sourcePath,
          output_path: outputPath,
          plan: { page_order: [2, 1], rotations: {} },
          expected_output_identity: {
            canonical_path: identity.structuredContent.canonical_path,
            size_bytes: identity.structuredContent.size_bytes,
            sha256: identity.structuredContent.sha256,
          },
        },
      });

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toContain("OUTPUT_ALIASES_INPUT");
      await expect(fs.readFile(sourcePath)).resolves.toEqual(sourceBefore);
      await expect(fs.readFile(outputPath)).resolves.toEqual(sourceBefore);
      await expect(transactionArtifacts()).resolves.toEqual([]);
    },
    30_000,
  );

  it("allows an all-or-nothing split batch with one exact replacement identity", async () => {
    const firstOutput = path.join(tempDir, "source_pages_1-1_1.pdf");
    const secondOutput = path.join(tempDir, "source_pages_2-2_2.pdf");
    await fs.rm(firstOutput, { force: true });
    await fs.rm(secondOutput, { recursive: true, force: true });
    const existing = await PDFDocument.create();
    existing.addPage([200, 200]);
    await fs.writeFile(firstOutput, await existing.save());
    const identity = await client.callTool({
      name: "get_pdf_identity",
      arguments: { pdf_path: firstOutput },
    });

    const result = await client.callTool({
      name: "split_pdf",
      arguments: {
        input_path: sourcePath,
        page_ranges: "1,2",
        output_directory: tempDir,
        expected_output_identities: [{
          output_path: firstOutput,
          canonical_path: identity.structuredContent.canonical_path,
          size_bytes: identity.structuredContent.size_bytes,
          sha256: identity.structuredContent.sha256,
        }],
      },
    });

    expect(result.isError).not.toBe(true);
    await expect(fs.stat(firstOutput)).resolves.toBeTruthy();
    await expect(fs.stat(secondOutput)).resolves.toBeTruthy();
    await expect(transactionArtifacts()).resolves.toEqual([]);
  }, 30_000);
});
