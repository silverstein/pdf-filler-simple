import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument } from "pdf-lib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
const NAME_FIELD = "topmostSubform[0].Page1[0].f1_1[0]";

let TMP_DIR;
let PROFILE_DIR;
let client;
let transport;

async function connectClient(name = "pdf-tools-save-lifecycle-test-client") {
  client = new Client({ name, version: "1.0.0" });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO_ROOT, "server", "index.js")],
    cwd: REPO_ROOT,
    env: {
      ALLOWED_DIRECTORIES: TMP_DIR,
      DEFAULT_PROFILES_DIR: PROFILE_DIR,
    },
    stderr: "pipe",
  });
  await client.connect(transport);
}

async function restartServer(name) {
  await transport.close();
  client = undefined;
  transport = undefined;
  await connectClient(name);
}

async function sha256(filePath) {
  const bytes = await fs.readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

async function topLevelPdfs() {
  const entries = await fs.readdir(TMP_DIR);
  return entries.filter(entry => entry.endsWith(".pdf")).sort();
}

describe("canonical save lifecycle", () => {
  beforeEach(async () => {
    TMP_DIR = await fs.mkdtemp(path.join(tmpdir(), "pdf-tools-save-lifecycle-"));
    PROFILE_DIR = path.join(TMP_DIR, "profiles");
    await fs.copyFile(EXAMPLE_PDF, path.join(TMP_DIR, "w9-working.pdf"));
    await fs.copyFile(EXAMPLE_PDF, path.join(TMP_DIR, "w9-managed-source.pdf"));

    await connectClient();
  }, 30_000);

  afterEach(async () => {
    await transport?.close();
    await fs.rm(TMP_DIR, { recursive: true, force: true });
    client = undefined;
    transport = undefined;
  });

  it("fills and signs the current PDF in place with one reusable backup", async () => {
    const pdfPath = path.join(TMP_DIR, "w9-working.pdf");
    const originalHash = await sha256(pdfPath);

    const filled = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: pdfPath,
        output_path: pdfPath,
        force_xfa: true,
        field_data: {
          [NAME_FIELD]: "Lifecycle Test LLC",
        },
      },
    });

    expect(filled.structuredContent).toMatchObject({
      pdfPath,
      active_path: pdfPath,
      last_mutation_tool: "fill_pdf",
    });
    expect(filled.structuredContent.backup_path).toBeTruthy();
    await expect(fs.stat(filled.structuredContent.backup_path)).resolves.toBeTruthy();
    expect(await sha256(filled.structuredContent.backup_path)).toBe(originalHash);
    expect(await sha256(pdfPath)).not.toBe(originalHash);

    await client.callTool({
      name: "create_signature",
      arguments: {
        name: "lifecycle-test",
        display_name: "Lifecycle Tester",
        overwrite: true,
      },
    });

    const signed = await client.callTool({
      name: "apply_signature",
      arguments: {
        pdf_path: pdfPath,
        output_path: pdfPath,
        signature_name: "lifecycle-test",
        page: 1,
        x: 90,
        y: 690,
        width: 180,
        height: 28,
        force_xfa: true,
        user_intent_statement: "I, Lifecycle Tester, sign this test PDF during automated verification.",
        user_confirmed_at: new Date().toISOString(),
      },
    });

    expect(signed.structuredContent).toMatchObject({
      pdfPath,
      active_path: pdfPath,
      backup_path: filled.structuredContent.backup_path,
      last_mutation_tool: "apply_signature",
    });

    const active = await client.callTool({ name: "get_active_document", arguments: {} });
    expect(active.structuredContent).toMatchObject({
      active_path: pdfPath,
      backup_path: filled.structuredContent.backup_path,
      last_mutation_tool: "apply_signature",
    });

    expect(await topLevelPdfs()).toEqual(["w9-managed-source.pdf", "w9-working.pdf"]);
  }, 30_000);

  it("fails closed when the recorded original backup disappears", async () => {
    const pdfPath = path.join(TMP_DIR, "w9-working.pdf");
    const originalHash = await sha256(pdfPath);
    const filled = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: pdfPath,
        output_path: pdfPath,
        force_xfa: true,
        field_data: { [NAME_FIELD]: "First mutation" },
      },
    });
    const firstMutationHash = await sha256(pdfPath);
    const backupPath = filled.structuredContent.backup_path;
    expect(await sha256(backupPath)).toBe(originalHash);

    const activeBefore = await client.callTool({ name: "get_active_document", arguments: {} });
    await fs.unlink(backupPath);

    const second = await client.callTool({
      name: "apply_text",
      arguments: {
        pdf_path: pdfPath,
        output_path: pdfPath,
        page: 1,
        x: 90,
        y: 720,
        width: 120,
        height: 24,
        text: "MUST NOT APPEAR",
      },
    });

    expect(second.isError).toBe(true);
    expect(second.content?.[0]?.text).toContain("ORIGINAL_BACKUP_MISSING");
    expect(await sha256(pdfPath)).toBe(firstMutationHash);
    await expect(fs.stat(backupPath)).rejects.toMatchObject({ code: "ENOENT" });
    const backupEntries = (await fs.readdir(path.join(PROFILE_DIR, "backups"))).filter(entry => entry.endsWith(".pdf"));
    expect(backupEntries).toEqual([]);

    const activeAfter = await client.callTool({ name: "get_active_document", arguments: {} });
    expect(activeAfter.structuredContent).toEqual(activeBefore.structuredContent);
  }, 30_000);

  it("retains the immutable original identity across a server restart", async () => {
    const pdfPath = path.join(TMP_DIR, "w9-working.pdf");
    const originalHash = await sha256(pdfPath);
    const filled = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: pdfPath,
        output_path: pdfPath,
        force_xfa: true,
        field_data: { [NAME_FIELD]: "Before restart" },
      },
    });
    const backupPath = filled.structuredContent.backup_path;
    expect(await sha256(backupPath)).toBe(originalHash);

    await restartServer("pdf-tools-save-lifecycle-restart-client");

    const stamped = await client.callTool({
      name: "apply_text",
      arguments: {
        pdf_path: pdfPath,
        output_path: pdfPath,
        page: 1,
        x: 90,
        y: 720,
        width: 120,
        height: 24,
        text: "After restart",
      },
    });
    expect(stamped.isError).not.toBe(true);
    expect(stamped.structuredContent.backup_path).toBe(backupPath);
    expect(await sha256(backupPath)).toBe(originalHash);
    expect((await fs.readdir(path.join(PROFILE_DIR, "backups"))).filter(entry => entry.endsWith(".pdf"))).toEqual([
      path.basename(backupPath),
    ]);
  }, 30_000);

  it("rehydrates only the backup bound by the durable identity record", async () => {
    const pdfPath = path.join(TMP_DIR, "w9-working.pdf");
    const filled = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: pdfPath,
        output_path: pdfPath,
        force_xfa: true,
        field_data: { [NAME_FIELD]: "Before active-state rehydration" },
      },
    });
    const forgedBackupPath = path.join(TMP_DIR, "forged-backup.pdf");
    await fs.copyFile(path.join(TMP_DIR, "w9-managed-source.pdf"), forgedBackupPath);
    await restartServer("pdf-tools-save-lifecycle-rehydrate-client");

    const forged = await client.callTool({
      name: "set_active_document",
      arguments: {
        pdf_path: pdfPath,
        backup_path: forgedBackupPath,
        last_mutation_tool: "fill_pdf",
        last_mutation_at: new Date().toISOString(),
      },
    });
    expect(forged.isError).toBe(true);
    expect(forged.content?.[0]?.text).toContain("BACKUP_IDENTITY_MISMATCH");

    const restored = await client.callTool({
      name: "set_active_document",
      arguments: {
        pdf_path: pdfPath,
        backup_path: filled.structuredContent.backup_path,
        last_mutation_tool: "fill_pdf",
        last_mutation_at: new Date().toISOString(),
      },
    });
    expect(restored.isError).not.toBe(true);
    expect(restored.structuredContent.backup_path).toBe(filled.structuredContent.backup_path);
  }, 30_000);

  it("fails closed when the immutable original backup is tampered with", async () => {
    const pdfPath = path.join(TMP_DIR, "w9-working.pdf");
    const filled = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: pdfPath,
        output_path: pdfPath,
        force_xfa: true,
        field_data: { [NAME_FIELD]: "Before tamper" },
      },
    });
    const workingHash = await sha256(pdfPath);
    await fs.appendFile(filled.structuredContent.backup_path, "tampered");

    const second = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: pdfPath,
        output_path: pdfPath,
        force_xfa: true,
        field_data: { [NAME_FIELD]: "Must not persist" },
      },
    });
    expect(second.isError).toBe(true);
    expect(second.content?.[0]?.text).toContain("ORIGINAL_BACKUP_MISMATCH");
    expect(await sha256(pdfPath)).toBe(workingHash);
  }, 30_000);

  it("fails closed after restart when an identity record is deleted but its backup remains", async () => {
    const pdfPath = path.join(TMP_DIR, "w9-working.pdf");
    const filled = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: pdfPath,
        output_path: pdfPath,
        force_xfa: true,
        field_data: { [NAME_FIELD]: "Before record deletion" },
      },
    });
    const workingHash = await sha256(pdfPath);
    const backupsDirectory = path.join(PROFILE_DIR, "backups");
    const recordName = (await fs.readdir(backupsDirectory)).find(entry => entry.startsWith(".original-") && entry.endsWith(".v1.json"));
    expect(recordName).toBeTruthy();
    await fs.unlink(path.join(backupsDirectory, recordName));
    await restartServer("pdf-tools-save-lifecycle-missing-record-client");

    const second = await client.callTool({
      name: "apply_text",
      arguments: {
        pdf_path: pdfPath,
        output_path: pdfPath,
        page: 1,
        x: 90,
        y: 720,
        width: 120,
        height: 24,
        text: "MUST NOT APPEAR",
      },
    });
    expect(second.isError).toBe(true);
    expect(second.content?.[0]?.text).toContain("BACKUP_RECORD_MISSING");
    expect(await sha256(pdfPath)).toBe(workingHash);
    expect(await sha256(filled.structuredContent.backup_path)).not.toBe(workingHash);
  }, 30_000);

  it("fails closed when legacy backup evidence has no durable identity record", async () => {
    const pdfPath = path.join(TMP_DIR, "w9-working.pdf");
    const originalHash = await sha256(pdfPath);
    const backupsDirectory = path.join(PROFILE_DIR, "backups");
    await fs.mkdir(backupsDirectory, { recursive: true });
    await fs.copyFile(pdfPath, path.join(backupsDirectory, "w9-working__2026-01-01T00-00-00-000Z.pdf"));

    const result = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: pdfPath,
        output_path: pdfPath,
        force_xfa: true,
        field_data: { [NAME_FIELD]: "Must not replace legacy lineage" },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("BACKUP_MIGRATION_REQUIRED");
    expect(await sha256(pdfPath)).toBe(originalHash);
    expect((await fs.readdir(backupsDirectory)).filter(entry => entry.endsWith(".pdf"))).toEqual([
      "w9-working__2026-01-01T00-00-00-000Z.pdf",
    ]);
  }, 30_000);

  it("uses one immutable identity through a symlinked directory alias", async () => {
    const pdfPath = path.join(TMP_DIR, "w9-working.pdf");
    const originalHash = await sha256(pdfPath);
    const filled = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: pdfPath,
        output_path: pdfPath,
        force_xfa: true,
        field_data: { [NAME_FIELD]: "Before alias restart" },
      },
    });
    await fs.symlink(TMP_DIR, path.join(TMP_DIR, "alias"), "dir");
    await restartServer("pdf-tools-save-lifecycle-alias-client");
    const aliasPath = path.join(TMP_DIR, "alias", "w9-working.pdf");
    const stamped = await client.callTool({
      name: "apply_text",
      arguments: {
        pdf_path: aliasPath,
        output_path: aliasPath,
        page: 1,
        x: 90,
        y: 720,
        width: 120,
        height: 24,
        text: "Alias mutation",
      },
    });
    expect(stamped.isError).not.toBe(true);
    expect(stamped.structuredContent.backup_path).toBe(filled.structuredContent.backup_path);
    expect(await sha256(stamped.structuredContent.backup_path)).toBe(originalHash);
    expect((await fs.readdir(path.join(PROFILE_DIR, "backups"))).filter(entry => entry.endsWith(".pdf"))).toEqual([
      path.basename(filled.structuredContent.backup_path),
    ]);
  }, 30_000);

  it("preserves a file symlink while mutating its canonical target with one original backup", async () => {
    const targetPath = path.join(TMP_DIR, "w9-working.pdf");
    const linkPath = path.join(TMP_DIR, "working-link.pdf");
    const originalHash = await sha256(targetPath);
    await fs.symlink(targetPath, linkPath, "file");

    const filled = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: linkPath,
        output_path: linkPath,
        force_xfa: true,
        field_data: { [NAME_FIELD]: "Through file symlink" },
      },
    });

    expect(filled.isError).not.toBe(true);
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await sha256(filled.structuredContent.backup_path)).toBe(originalHash);
    expect(await sha256(targetPath)).not.toBe(originalHash);

    await restartServer("pdf-tools-save-lifecycle-file-symlink-client");
    const stamped = await client.callTool({
      name: "apply_text",
      arguments: {
        pdf_path: linkPath,
        output_path: linkPath,
        page: 1,
        x: 90,
        y: 720,
        width: 120,
        height: 24,
        text: "After symlink restart",
      },
    });
    expect(stamped.isError).not.toBe(true);
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(stamped.structuredContent.backup_path).toBe(filled.structuredContent.backup_path);
    expect((await fs.readdir(path.join(PROFILE_DIR, "backups"))).filter(entry => entry.endsWith(".pdf"))).toEqual([
      path.basename(filled.structuredContent.backup_path),
    ]);
  }, 30_000);

  it("rejects an externally replaced working PDF instead of assigning it the old lineage", async () => {
    const pdfPath = path.join(TMP_DIR, "w9-working.pdf");
    await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: pdfPath,
        output_path: pdfPath,
        force_xfa: true,
        field_data: { [NAME_FIELD]: "Managed generation" },
      },
    });
    await fs.copyFile(path.join(TMP_DIR, "w9-managed-source.pdf"), pdfPath);
    const replacementHash = await sha256(pdfPath);
    const result = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: pdfPath,
        output_path: pdfPath,
        force_xfa: true,
        field_data: { [NAME_FIELD]: "Must not write" },
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("CONCURRENT_MODIFICATION");
    expect(await sha256(pdfPath)).toBe(replacementHash);
  }, 30_000);

  it("creates only one H0 backup under concurrent first mutations", async () => {
    const pdfPath = path.join(TMP_DIR, "w9-working.pdf");
    const originalHash = await sha256(pdfPath);
    const [left, right] = await Promise.all([
      client.callTool({
        name: "fill_pdf",
        arguments: {
          pdf_path: pdfPath,
          output_path: pdfPath,
          force_xfa: true,
          field_data: { [NAME_FIELD]: "Concurrent left" },
        },
      }),
      client.callTool({
        name: "fill_pdf",
        arguments: {
          pdf_path: pdfPath,
          output_path: pdfPath,
          force_xfa: true,
          field_data: { [NAME_FIELD]: "Concurrent right" },
        },
      }),
    ]);
    const succeeded = [left, right].filter(result => result.isError !== true);
    const rejected = [left, right].filter(result => result.isError === true);
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].content?.[0]?.text).toContain("CONCURRENT_MODIFICATION");
    const backupPath = succeeded[0].structuredContent.backup_path;
    expect(await sha256(backupPath)).toBe(originalHash);
    expect((await fs.readdir(path.join(PROFILE_DIR, "backups"))).filter(entry => entry.endsWith(".pdf"))).toEqual([
      path.basename(backupPath),
    ]);
    const reopened = await PDFDocument.load(await fs.readFile(pdfPath));
    const value = reopened.getForm().getTextField(NAME_FIELD).getText();
    expect(value).toBe(left.isError === true ? "Concurrent right" : "Concurrent left");
  }, 30_000);

  it("makes a managed page-edit output canonical, then mutates that output in place", async () => {
    const sourcePath = path.join(TMP_DIR, "w9-managed-source.pdf");
    const managedPath = path.join(TMP_DIR, "w9-managed-source_managed.pdf");

    const planned = await client.callTool({
      name: "apply_page_plan",
      arguments: {
        input_path: sourcePath,
        output_path: managedPath,
        force_xfa: true,
        plan: {
          page_order: [1],
          rotations: {},
        },
      },
    });

    expect(planned.structuredContent).toMatchObject({
      pdfPath: managedPath,
      active_path: managedPath,
      last_mutation_tool: "apply_page_plan",
    });

    const activeAfterPlan = await client.callTool({ name: "get_active_document", arguments: {} });
    expect(activeAfterPlan.structuredContent).toMatchObject({
      active_path: managedPath,
      last_mutation_tool: "apply_page_plan",
    });

    const managedHashBeforeStamp = await sha256(managedPath);
    const stamped = await client.callTool({
      name: "apply_text",
      arguments: {
        pdf_path: managedPath,
        output_path: managedPath,
        page: 1,
        x: 90,
        y: 720,
        width: 120,
        height: 24,
        text: "2026-04-23",
      },
    });

    expect(stamped.structuredContent).toMatchObject({
      pdfPath: managedPath,
      active_path: managedPath,
      last_mutation_tool: "apply_text",
    });
    expect(stamped.structuredContent.backup_path).toBeTruthy();
    await expect(fs.stat(stamped.structuredContent.backup_path)).resolves.toBeTruthy();
    expect(await sha256(stamped.structuredContent.backup_path)).toBe(managedHashBeforeStamp);

    const activeAfterStamp = await client.callTool({ name: "get_active_document", arguments: {} });
    expect(activeAfterStamp.structuredContent).toMatchObject({
      active_path: managedPath,
      backup_path: stamped.structuredContent.backup_path,
      last_mutation_tool: "apply_text",
    });

    expect(await topLevelPdfs()).toEqual([
      "w9-managed-source.pdf",
      "w9-managed-source_managed.pdf",
      "w9-working.pdf",
    ]);
  }, 30_000);

  it("keeps form metadata when a rotated output becomes canonical", async () => {
    const sourcePath = path.join(TMP_DIR, "w9-rotate-source.pdf");
    const rotatedPath = path.join(TMP_DIR, "w9-rotate-source_rotated.pdf");
    await fs.copyFile(EXAMPLE_PDF, sourcePath);

    const rotated = await client.callTool({
      name: "rotate_pdf_pages",
      arguments: {
        input_path: sourcePath,
        output_path: rotatedPath,
        pages: [1],
        degrees: 90,
      },
    });

    expect(rotated.structuredContent).toMatchObject({
      pdfPath: rotatedPath,
      active_path: rotatedPath,
      hasFormFields: true,
      fieldCount: 22,
      last_mutation_tool: "rotate_pdf_pages",
    });
    expect(rotated.structuredContent.fields.length).toBeGreaterThan(0);

    const activeAfterRotate = await client.callTool({ name: "get_active_document", arguments: {} });
    expect(activeAfterRotate.structuredContent).toMatchObject({
      active_path: rotatedPath,
      hasFormFields: true,
      fieldCount: 22,
      last_mutation_tool: "rotate_pdf_pages",
    });
  }, 30_000);
});
