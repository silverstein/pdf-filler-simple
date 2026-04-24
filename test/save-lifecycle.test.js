import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
const TMP_DIR = path.join(REPO_ROOT, ".test-tmp-save-lifecycle");
const PROFILE_DIR = path.join(TMP_DIR, "profiles");
const NAME_FIELD = "topmostSubform[0].Page1[0].f1_1[0]";

async function sha1(filePath) {
  const bytes = await fs.readFile(filePath);
  return createHash("sha1").update(bytes).digest("hex");
}

async function topLevelPdfs() {
  const entries = await fs.readdir(TMP_DIR);
  return entries.filter(entry => entry.endsWith(".pdf")).sort();
}

describe("canonical save lifecycle", () => {
  let client;
  let transport;

  beforeAll(async () => {
    await fs.rm(TMP_DIR, { recursive: true, force: true });
    await fs.mkdir(TMP_DIR, { recursive: true });
    await fs.copyFile(EXAMPLE_PDF, path.join(TMP_DIR, "w9-working.pdf"));
    await fs.copyFile(EXAMPLE_PDF, path.join(TMP_DIR, "w9-managed-source.pdf"));

    client = new Client({ name: "pdf-tools-save-lifecycle-test-client", version: "1.0.0" });
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
  }, 30_000);

  afterAll(async () => {
    await transport?.close();
    await fs.rm(TMP_DIR, { recursive: true, force: true });
  });

  it("fills and signs the current PDF in place with one reusable backup", async () => {
    const pdfPath = path.join(TMP_DIR, "w9-working.pdf");
    const originalHash = await sha1(pdfPath);

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
    expect(await sha1(filled.structuredContent.backup_path)).toBe(originalHash);
    expect(await sha1(pdfPath)).not.toBe(originalHash);

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

    const managedHashBeforeStamp = await sha1(managedPath);
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
    expect(await sha1(stamped.structuredContent.backup_path)).toBe(managedHashBeforeStamp);

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
