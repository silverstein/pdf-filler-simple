import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { validateStructuredToolResult } from "../server/output-schemas.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
const ENCRYPTED_PDF = path.join(
  REPO_ROOT,
  "test/fixtures/eval/extraction/oracles/layout-encrypted-qpdf-r4.pdf",
);
const ENCRYPTED_PROVENANCE = path.join(
  REPO_ROOT,
  "test/fixtures/eval/extraction/oracles/layout-encrypted-qpdf-r4.provenance.json",
);

describe("get_pdf_info source-bound observations", () => {
  let client;
  let transport;

  beforeAll(async () => {
    client = new Client({ name: "pdf-observation-test", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: { ALLOWED_DIRECTORIES: REPO_ROOT },
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
  });

  it("returns deterministic source identity, geometry, form fields, and ordinary annotations", async () => {
    const bytes = await fs.readFile(EXAMPLE_PDF);
    const before = await fs.stat(EXAMPLE_PDF);
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    const first = await client.callTool({
      name: "get_pdf_info",
      arguments: { pdf_path: EXAMPLE_PDF },
    });
    const second = await client.callTool({
      name: "get_pdf_info",
      arguments: { pdf_path: EXAMPLE_PDF },
    });

    expect(first.isError).not.toBe(true);
    expect(validateStructuredToolResult("get_pdf_info", first)).toBe(first);
    expect(first.structuredContent).toEqual(second.structuredContent);
    expect(first.structuredContent).toMatchObject({
      schema_version: "1.0",
      source: {
        canonical_path: EXAMPLE_PDF,
        file_name: "example-fw9.pdf",
        size_bytes: bytes.length,
        sha256: expectedSha256,
        identity_method: "race_aware_descriptor_sha256",
      },
      parser: { name: "pdfjs-dist", version: "5.4.624" },
      pages: { total_count: 4, observed_count: 4, truncated: false },
    });
    expect(first.structuredContent.form_fields.observed_count).toBeGreaterThan(0);
    expect(first.structuredContent.form_fields.items.every(field => field.id.startsWith("field-")))
      .toBe(true);
    expect(first.structuredContent.annotations.items.every(annotation => annotation.subtype !== "Widget"))
      .toBe(true);
    expect(JSON.stringify(first.structuredContent).length).toBeLessThanOrEqual(50_000);
    expect(first.content[0].text).not.toContain(bytes.toString("base64").slice(0, 32));
    const afterBytes = await fs.readFile(EXAMPLE_PDF);
    const after = await fs.stat(EXAMPLE_PDF);
    expect(afterBytes).toEqual(bytes);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  }, 30_000);

  it("reports page-scoped partial coverage without misreporting a collection cap", async () => {
    const result = await client.callTool({
      name: "get_pdf_info",
      arguments: {
        pdf_path: EXAMPLE_PDF,
        max_pages: 1,
        max_output_characters: 20_000,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.pages).toMatchObject({
      total_count: 4,
      observed_count: 1,
      truncated: true,
    });
    expect(result.structuredContent.coverage.pages.reason_codes).toContain("PAGE_LIMIT_REACHED");
    expect(result.structuredContent.coverage.annotations.reason_codes)
      .toContain("ANNOTATION_PAGE_LIMIT_REACHED");
    expect(result.structuredContent.coverage.annotations.reason_codes)
      .not.toContain("ANNOTATION_LIMIT_REACHED");
    expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(20_000);
  }, 30_000);

  it("returns typed non-leaking password failures and authenticates the same source", async () => {
    const provenance = JSON.parse(await fs.readFile(ENCRYPTED_PROVENANCE, "utf8"));
    const missing = await client.callTool({
      name: "get_pdf_info",
      arguments: { pdf_path: ENCRYPTED_PDF },
    });
    const wrong = await client.callTool({
      name: "get_pdf_info",
      arguments: {
        pdf_path: ENCRYPTED_PDF,
        password: provenance.passwords.wrong_password_oracle,
      },
    });
    const correct = await client.callTool({
      name: "get_pdf_info",
      arguments: { pdf_path: ENCRYPTED_PDF, password: provenance.passwords.user },
    });

    expect(missing).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "PASSWORD_REQUIRED" } },
    });
    expect(wrong).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "PASSWORD_INCORRECT" } },
    });
    expect(JSON.stringify(missing)).not.toContain(provenance.passwords.user);
    expect(JSON.stringify(wrong)).not.toContain(provenance.passwords.wrong_password_oracle);
    expect(correct.isError).not.toBe(true);
    expect(correct.structuredContent.source.sha256).toBe(provenance.encrypted_fixture.sha256);
  }, 30_000);

  it("rejects unknown inputs at the exact discovery contract", async () => {
    const result = await client.callTool({
      name: "get_pdf_info",
      arguments: { pdf_path: EXAMPLE_PDF, execute_annotation_actions: true },
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "tool_execution_failed" } },
    });
    expect(result.content[0].text).toMatch(/execute_annotation_actions|invalid/i);
  });

  it("fails a disallowed path before returning any source observation", async () => {
    const deniedPath = path.join(path.parse(REPO_ROOT).root, "private", "outside.pdf");
    const result = await client.callTool({
      name: "get_pdf_info",
      arguments: { pdf_path: deniedPath },
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "path_policy_denied" } },
    });
    expect(result.structuredContent.source).toBeUndefined();
  });

  it("fails closed when a source-bound observation digest is changed", async () => {
    const result = await client.callTool({
      name: "get_pdf_info",
      arguments: { pdf_path: EXAMPLE_PDF },
    });
    const tampered = structuredClone(result);
    tampered.structuredContent.pages.items[0].width_points += 1;
    const rejected = validateStructuredToolResult("get_pdf_info", tampered);
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent.error.code).toBe("internal_validation_error");
  }, 30_000);
});
