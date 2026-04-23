import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
const TMP_DIR = path.join(REPO_ROOT, ".test-tmp-allowed-directories");
const ALLOWED_DIR = path.join(TMP_DIR, "allowed");
const PROFILE_DIR = path.join(TMP_DIR, "profiles");

function textFromToolResult(result) {
  return result.content?.map(item => item.type === "text" ? item.text : "").join(" ") || "";
}

describe("allowed_directories sandbox", () => {
  let client;
  let transport;
  let allowedPdfPath;

  beforeAll(async () => {
    await fs.mkdir(ALLOWED_DIR, { recursive: true });
    await fs.mkdir(PROFILE_DIR, { recursive: true });
    allowedPdfPath = path.join(ALLOWED_DIR, "example-fw9.pdf");
    await fs.copyFile(EXAMPLE_PDF, allowedPdfPath);

    client = new Client({ name: "pdf-tools-allowlist-test-client", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server", "index.js")],
      cwd: REPO_ROOT,
      env: {
        ALLOWED_DIRECTORIES: ALLOWED_DIR,
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

  it("rejects a user path outside the configured allowlist", async () => {
    const result = await client.callTool({
      name: "display_pdf",
      arguments: {
        pdf_path: EXAMPLE_PDF,
      },
    });

    const text = textFromToolResult(result);
    expect(text).toContain("This extension is only allowed to access");
    expect(text).toContain(ALLOWED_DIR);
    expect(text).toContain(EXAMPLE_PDF);
  }, 30_000);

  it("allows tools to read from an allowed directory", async () => {
    const result = await client.callTool({
      name: "list_pdfs",
      arguments: {
        directory: ALLOWED_DIR,
      },
    });

    const text = textFromToolResult(result);
    expect(text).toContain("Found 1 PDF files");
    expect(text).toContain(allowedPdfPath);
  }, 30_000);

  it("keeps the internal profile store usable outside the user path allowlist", async () => {
    const saved = await client.callTool({
      name: "save_profile",
      arguments: {
        profile_name: "sandbox-smoke",
        field_data: {
          full_name: "Sandbox Smoke",
        },
      },
    });
    expect(textFromToolResult(saved)).toContain("saved successfully");

    const loaded = await client.callTool({
      name: "load_profile",
      arguments: {
        profile_name: "sandbox-smoke",
      },
    });
    expect(textFromToolResult(loaded)).toContain("Sandbox Smoke");
  }, 30_000);
});
