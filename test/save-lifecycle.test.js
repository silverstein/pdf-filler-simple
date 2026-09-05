import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument } from "pdf-lib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
const SINGLE_CRASH_CHILD = path.join(REPO_ROOT, "test", "helpers", "atomic-output-single-crash-child.mjs");
const NAME_FIELD = "topmostSubform[0].Page1[0].f1_1[0]";

let TMP_DIR;
let PROFILE_DIR;
let client;
let transport;

async function connectClient(name = "pdf-tools-save-lifecycle-test-client", nodeArguments = []) {
  client = new Client({ name, version: "1.0.0" });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [...nodeArguments, path.join(REPO_ROOT, "server", "index.js")],
    cwd: REPO_ROOT,
    env: {
      ALLOWED_DIRECTORIES: TMP_DIR,
      DEFAULT_PROFILES_DIR: PROFILE_DIR,
    },
    stderr: "pipe",
  });
  await client.connect(transport);
}

async function restartServer(name, nodeArguments = []) {
  await transport.close();
  client = undefined;
  transport = undefined;
  await connectClient(name, nodeArguments);
}

async function sha256(filePath) {
  const bytes = await fs.readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

async function topLevelPdfs() {
  const entries = await fs.readdir(TMP_DIR);
  return entries.filter(entry => entry.endsWith(".pdf")).sort();
}

async function snapshotBackupState() {
  const backupsDirectory = path.join(PROFILE_DIR, "backups");
  let names;
  try {
    names = await fs.readdir(backupsDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return await Promise.all(names.sort().map(async name => {
    const entryPath = path.join(backupsDirectory, name);
    const stats = await fs.lstat(entryPath);
    if (stats.isSymbolicLink()) {
      return { name, type: "symlink", target: await fs.readlink(entryPath) };
    }
    if (stats.isDirectory()) return { name, type: "directory" };
    return { name, type: "file", sha256: await sha256(entryPath) };
  }));
}

async function runSingleOutputCrash(targetPath, replacementPath, transition) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SINGLE_CRASH_CHILD, targetPath, replacementPath, transition], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr = [];
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({
      code,
      signal,
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

async function exitedProcessId() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return pid;
}

async function mutationLockPaths(pdfPath) {
  const canonicalPath = await fs.realpath(pdfPath);
  const identity = createHash("sha256").update(Buffer.from(canonicalPath)).digest("hex");
  const backupsDirectory = path.join(PROFILE_DIR, "backups");
  return {
    canonicalPath,
    backupsDirectory,
    lockPath: path.join(backupsDirectory, `.mutation-${identity}.lock`),
    candidatePrefix: `.mutation-${identity}.candidate-`,
  };
}

describe("canonical save lifecycle", () => {
  beforeEach(async () => {
    TMP_DIR = await fs.realpath(
      await fs.mkdtemp(path.join(tmpdir(), "pdf-tools-save-lifecycle-")),
    );
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

  it("preserves legacy overwrite=true as a no-op for same-document text stamping", async () => {
    const pdfPath = path.join(TMP_DIR, "w9-working.pdf");
    const originalHash = await sha256(pdfPath);

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
        text: "Legacy compatibility",
        overwrite: true,
      },
    });

    expect(stamped.isError).not.toBe(true);
    expect(stamped.structuredContent).toMatchObject({
      pdfPath,
      active_path: pdfPath,
      last_mutation_tool: "apply_text",
    });
    expect(stamped.structuredContent.backup_path).toBeTruthy();
    expect(await sha256(pdfPath)).not.toBe(originalHash);
    expect(await sha256(stamped.structuredContent.backup_path)).toBe(originalHash);
  }, 30_000);

  it("preserves legacy overwrite=true as a no-op for a distinct new output", async () => {
    const inputPath = path.join(TMP_DIR, "w9-working.pdf");
    const outputPath = path.join(TMP_DIR, "legacy-new-output.pdf");
    const originalHash = await sha256(inputPath);

    const stamped = await client.callTool({
      name: "apply_text",
      arguments: {
        pdf_path: inputPath,
        output_path: outputPath,
        page: 1,
        x: 90,
        y: 720,
        width: 120,
        height: 24,
        text: "Legacy new output",
        overwrite: true,
      },
    });

    expect(stamped.isError).not.toBe(true);
    expect(stamped.structuredContent).toMatchObject({
      pdfPath: outputPath,
      active_path: outputPath,
      backup_path: null,
      last_mutation_tool: "apply_text",
    });
    await expect(sha256(inputPath)).resolves.toBe(originalHash);
    await expect(fs.stat(outputPath)).resolves.toBeTruthy();
  }, 30_000);

  it("keeps legacy signature overwrite compatible without authorizing a distinct replacement", async () => {
    const inputPath = path.join(TMP_DIR, "w9-working.pdf");
    const distinctOutputPath = path.join(TMP_DIR, "w9-managed-source.pdf");
    await client.callTool({
      name: "create_signature",
      arguments: {
        name: "legacy-overwrite-signature",
        display_name: "Legacy Signer",
      },
    });

    const canonicalAlias = `${TMP_DIR}${path.sep}not-created${path.sep}..${path.sep}w9-working.pdf`;
    const sameDocument = await client.callTool({
      name: "apply_signature",
      arguments: {
        pdf_path: inputPath,
        output_path: canonicalAlias,
        signature_name: "legacy-overwrite-signature",
        page: 1,
        x: 90,
        y: 690,
        width: 180,
        height: 28,
        force_xfa: true,
        overwrite: true,
        user_intent_statement: "I, Legacy Signer, sign this compatibility-test PDF.",
        user_confirmed_at: new Date().toISOString(),
      },
    });
    expect(sameDocument.isError).not.toBe(true);
    expect(sameDocument.structuredContent).toMatchObject({
      active_path: inputPath,
      last_mutation_tool: "apply_signature",
    });

    const distinctBefore = await sha256(distinctOutputPath);
    const distinctReplacement = await client.callTool({
      name: "apply_signature",
      arguments: {
        pdf_path: inputPath,
        output_path: distinctOutputPath,
        signature_name: "legacy-overwrite-signature",
        page: 1,
        x: 90,
        y: 650,
        width: 180,
        height: 28,
        force_xfa: true,
        overwrite: true,
        user_intent_statement: "I, Legacy Signer, sign this compatibility-test PDF.",
        user_confirmed_at: new Date().toISOString(),
      },
    });
    expect(distinctReplacement.isError).toBe(true);
    expect(distinctReplacement.content?.[0]?.text).toContain(
      "OUTPUT_IDENTITY_REQUIRED",
    );
    await expect(sha256(distinctOutputPath)).resolves.toBe(distinctBefore);
  }, 30_000);

  it("does not let legacy overwrite=true replace a distinct existing output", async () => {
    const inputPath = path.join(TMP_DIR, "w9-working.pdf");
    const outputPath = path.join(TMP_DIR, "w9-managed-source.pdf");
    await client.callTool({
      name: "set_active_document",
      arguments: { pdf_path: outputPath },
    });
    const [inputHash, outputHash, backupsBefore, activeBefore] = await Promise.all([
      sha256(inputPath),
      sha256(outputPath),
      snapshotBackupState(),
      client.callTool({ name: "get_active_document", arguments: {} }),
    ]);

    const result = await client.callTool({
      name: "apply_text",
      arguments: {
        pdf_path: inputPath,
        output_path: outputPath,
        page: 1,
        x: 90,
        y: 720,
        width: 120,
        height: 24,
        text: "Must not commit",
        overwrite: true,
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("OUTPUT_IDENTITY_REQUIRED");
    await expect(sha256(inputPath)).resolves.toBe(inputHash);
    await expect(sha256(outputPath)).resolves.toBe(outputHash);
    await expect(snapshotBackupState()).resolves.toEqual(backupsBefore);
    const activeAfter = await client.callTool({ name: "get_active_document", arguments: {} });
    expect(activeAfter.structuredContent).toEqual(activeBefore.structuredContent);
  }, 30_000);

  it("rejects a stale same-document identity before backup or active-state side effects", async () => {
    const pdfPath = path.join(TMP_DIR, "w9-working.pdf");
    const otherPath = path.join(TMP_DIR, "w9-managed-source.pdf");
    await client.callTool({
      name: "set_active_document",
      arguments: { pdf_path: otherPath },
    });
    const identity = await client.callTool({
      name: "get_pdf_identity",
      arguments: { pdf_path: pdfPath },
    });
    const [pdfHash, backupsBefore, activeBefore] = await Promise.all([
      sha256(pdfPath),
      snapshotBackupState(),
      client.callTool({ name: "get_active_document", arguments: {} }),
    ]);

    const result = await client.callTool({
      name: "apply_text",
      arguments: {
        pdf_path: pdfPath,
        output_path: pdfPath,
        page: 1,
        x: 90,
        y: 720,
        width: 120,
        height: 24,
        text: "Must not commit",
        expected_output_identity: {
          canonical_path: identity.structuredContent.canonical_path,
          size_bytes: identity.structuredContent.size_bytes,
          sha256: "0".repeat(64),
        },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain(
      "ATOMIC_OUTPUT_EXPECTED_IDENTITY_CHANGED",
    );
    await expect(sha256(pdfPath)).resolves.toBe(pdfHash);
    await expect(snapshotBackupState()).resolves.toEqual(backupsBefore);
    const activeAfter = await client.callTool({ name: "get_active_document", arguments: {} });
    expect(activeAfter.structuredContent).toEqual(activeBefore.structuredContent);
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

  for (const transition of ["rollback_0", "activate_0"]) {
  it(`recovers at ${transition} before loading and mutates only the restored committed PDF`, async () => {
    const pdfPath = path.join(TMP_DIR, "w9-working.pdf");
    const originalHash = await sha256(pdfPath);
    const replacementPath = path.join(TMP_DIR, "interrupted-replacement.bin");
    const replacement = await PDFDocument.load(await fs.readFile(pdfPath));
    replacement.setTitle("Interrupted uncommitted generation");
    await fs.writeFile(replacementPath, await replacement.save());

    const crashed = await runSingleOutputCrash(pdfPath, replacementPath, transition);
    expect(crashed).toMatchObject({ code: 86, signal: null, stderr: "" });
    if (transition === "rollback_0") {
      await expect(fs.stat(pdfPath)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(await sha256(pdfPath)).not.toBe(originalHash);
    }

    const result = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: pdfPath,
        output_path: pdfPath,
        force_xfa: true,
        field_data: { [NAME_FIELD]: "Must not derive from uncommitted bytes" },
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.backup_path).toBeTruthy();
    expect(await sha256(result.structuredContent.backup_path)).toBe(originalHash);
    expect(await sha256(pdfPath)).not.toBe(originalHash);
    expect((await fs.readdir(TMP_DIR)).filter(name => name.startsWith(".pdf-tools-"))).toEqual([]);
  }, 30_000);
  }

  it("reclaims a valid dead mutation lock and an incomplete dead candidate", async () => {
    const pdfPath = path.join(TMP_DIR, "w9-working.pdf");
    const { canonicalPath, backupsDirectory, lockPath, candidatePrefix } = await mutationLockPaths(pdfPath);
    const deadPid = await exitedProcessId();
    await fs.mkdir(backupsDirectory, { recursive: true, mode: 0o700 });
    await fs.writeFile(lockPath, `${JSON.stringify({
      schema_version: 1,
      canonical_path: canonicalPath,
      pid: deadPid,
      token: "00000000-0000-4000-8000-000000000000",
      created_at: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    await fs.writeFile(
      path.join(backupsDirectory, `${candidatePrefix}${deadPid}-11111111-1111-4111-8111-111111111111`),
      "{",
      { mode: 0o600 },
    );

    const result = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: pdfPath,
        output_path: pdfPath,
        force_xfa: true,
        field_data: { [NAME_FIELD]: "Recovered stale mutation lock" },
      },
    });

    expect(result.isError).not.toBe(true);
    expect((await fs.readdir(backupsDirectory)).filter(name => name.includes(".mutation-"))).toEqual([]);
  }, 30_000);

  it("preserves and rejects a live mutation lock", async () => {
    const pdfPath = path.join(TMP_DIR, "w9-working.pdf");
    const { canonicalPath, backupsDirectory, lockPath } = await mutationLockPaths(pdfPath);
    await fs.mkdir(backupsDirectory, { recursive: true, mode: 0o700 });
    await fs.writeFile(lockPath, `${JSON.stringify({
      schema_version: 1,
      canonical_path: canonicalPath,
      pid: process.pid,
      token: "22222222-2222-4222-8222-222222222222",
      created_at: new Date().toISOString(),
    })}\n`, { mode: 0o600 });

    const result = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: pdfPath,
        output_path: pdfPath,
        force_xfa: true,
        field_data: { [NAME_FIELD]: "Must not write through live lock" },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("CONCURRENT_MODIFICATION");
    await expect(fs.stat(lockPath)).resolves.toBeTruthy();
    await fs.unlink(lockPath);
  }, 30_000);

  it.each([
    ["ENOENT", "CONCURRENT_MODIFICATION"],
    ["ELOOP", "CONCURRENT_MODIFICATION"],
    ["ENOTDIR", "CONCURRENT_MODIFICATION"],
    ["ESTALE", "CONCURRENT_MODIFICATION"],
    ["EACCES", "injected-input-EACCES"],
    ["path_policy_denied", "injected-input-path_policy_denied"],
  ])("preserves the exact input-canonicalization refusal for %s", async (code, expected) => {
    const pdfPath = path.join(TMP_DIR, "w9-working.pdf");
    const originalHash = await sha256(pdfPath);
    const backupState = await snapshotBackupState();
    const markerPath = path.join(TMP_DIR, "input-fault-observed.json");
    const preloadPath = path.join(TMP_DIR, "input-path-fault.mjs");
    // Patch only the child process, after its isolated mutation has returned.
    // Earlier source reads and policy checks retain their real implementation.
    await fs.writeFile(preloadPath, `
import fs from "node:fs/promises";
const realpath = fs.realpath;
fs.realpath = async function (filename, ...args) {
  if (filename === ${JSON.stringify(pdfPath)}
      && new Error().stack.includes("persistPdfMutation")) {
    await fs.writeFile(${JSON.stringify(markerPath)}, JSON.stringify({ code: ${JSON.stringify(code)} }),
      { flag: "wx", mode: 0o600 });
    throw Object.assign(new Error(${JSON.stringify(`injected-input-${code}`)}),
      { code: ${JSON.stringify(code)} });
  }
  return realpath.call(this, filename, ...args);
};
`, { flag: "wx", mode: 0o600 });
    await restartServer("pdf-tools-input-canonicalization-fault", ["--import", preloadPath]);
    const result = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: pdfPath,
        output_path: pdfPath,
        force_xfa: true,
        field_data: { [NAME_FIELD]: "Must not commit after input failure" },
      },
    });
    expect(JSON.parse(await fs.readFile(markerPath, "utf8"))).toEqual({ code });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain(expected);
    if (expected !== "CONCURRENT_MODIFICATION") {
      expect(result.content?.[0]?.text).not.toContain("CONCURRENT_MODIFICATION");
    }
    expect(await sha256(pdfPath)).toBe(originalHash);
    expect(await snapshotBackupState()).toEqual(backupState);
    expect((await fs.readdir(TMP_DIR)).filter(name => name.startsWith(".pdf-tools-"))).toEqual([]);
  }, 30_000);

  /**
   * Two writers, one document. Exactly one may commit; the other must be
   * refused, must leave nothing behind, and must be told why.
   *
   * Two independent layers can notice the loser's document changed under it,
   * and which one notices first is a genuine race decided by machine load:
   *
   *   - `revalidateSources` in server/pdf-lib-subprocess.js, when the isolated
   *     worker returns and the bound input no longer hashes to what it bound.
   *     Reached when the winner commits while the loser is still in isolation,
   *     which is the common ordering on a slow or busy box.
   *   - the identity checks in `persistPdfMutation` and the mutation lock in
   *     server/index.js, reached when the loser gets past the first check and
   *     the winner commits during the commit sequence itself. The common
   *     ordering on an idle box, where both workers return together.
   *
   * This assertion used to pin the second ordering, so a two-core CI runner
   * failed it while the product was behaving correctly. The fix was not to
   * accept both messages -- that would let a real resource failure, a spawn
   * failure or a timeout pass as a concurrency refusal, and this test would
   * stop proving the loser was refused *for concurrency*. Instead the first
   * layer was corrected to report the refusal it is actually making, so both
   * orderings now produce one answer and the assertion holds on any hardware.
   * Regressing either layer back to a resource-budget message fails here.
   */
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
    // The loser is refused at one of two points, and neither may leave a
    // half-written document, an orphaned transaction directory or a second
    // lineage behind. Whichever layer refused it, the tree looks the same.
    expect((await fs.readdir(TMP_DIR)).filter(name => name.startsWith(".pdf-tools-"))).toEqual([]);
    expect(
      (await fs.readdir(path.join(PROFILE_DIR, "backups"))).filter(name => name.includes(".mutation-")),
    ).toEqual([]);
    expect(await topLevelPdfs()).toEqual(["w9-managed-source.pdf", "w9-working.pdf"]);
    const reopened = await PDFDocument.load(await fs.readFile(pdfPath));
    const value = reopened.getForm().getTextField(NAME_FIELD).getText();
    expect(value).toBe(left.isError === true ? "Concurrent right" : "Concurrent left");
    // The server answered the loser rather than dying with it.
    const active = await client.callTool({ name: "get_active_document", arguments: {} });
    expect(active.structuredContent).toMatchObject({
      active_path: pdfPath,
      backup_path: backupPath,
      last_mutation_tool: "fill_pdf",
    });
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
