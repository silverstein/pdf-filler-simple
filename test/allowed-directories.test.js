import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseAllowedDirectoryArgs } from "../server/helpers.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
let TMP_DIR;
let ALLOWED_DIR;
let PROFILE_DIR;

describe("parseAllowedDirectoryArgs", () => {
  it("returns all MCPB-expanded directories after the explicit marker", () => {
    expect(parseAllowedDirectoryArgs([
      "--allowed-directories",
      "C:\\Users\\Example\\Documents",
      "G:\\Shared PDFs",
    ])).toEqual([
      "C:\\Users\\Example\\Documents",
      "G:\\Shared PDFs",
    ]);
  });

  it("rejects unresolved templates and ignores unrelated host arguments", () => {
    expect(parseAllowedDirectoryArgs([
      "--allowed-directories",
      "${user_config.allowed_directories}",
    ])).toEqual([]);
    expect(parseAllowedDirectoryArgs(["--inspect", "9229"])).toBeNull();
  });
});

function textFromToolResult(result) {
  return result.content?.map(item => item.type === "text" ? item.text : "").join(" ") || "";
}

describe("allowed_directories sandbox", () => {
  let client;
  let transport;
  let allowedPdfPath;

  beforeAll(async () => {
    TMP_DIR = await createTestTempDirectory(REPO_ROOT, "allowed-directories");
    ALLOWED_DIR = path.join(TMP_DIR, "allowed");
    PROFILE_DIR = path.join(TMP_DIR, "profiles");
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
    try {
      await transport?.close();
    } finally {
      await removeTestTempDirectory(TMP_DIR);
    }
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

describe("allowed_directories MCPB argument expansion", () => {
  let client;
  let transport;
  let argTempDirectory;
  let firstAllowedDirectory;
  let secondAllowedDirectory;
  let argumentProfileDirectory;

  beforeAll(async () => {
    argTempDirectory = await createTestTempDirectory(REPO_ROOT, "allowed-directory-args");
    firstAllowedDirectory = path.join(argTempDirectory, "first-allowed");
    secondAllowedDirectory = path.join(argTempDirectory, "second-allowed");
    argumentProfileDirectory = path.join(argTempDirectory, "profiles");
    await fs.mkdir(firstAllowedDirectory, { recursive: true });
    await fs.mkdir(secondAllowedDirectory, { recursive: true });
    await fs.copyFile(EXAMPLE_PDF, path.join(secondAllowedDirectory, "argument-example.pdf"));

    client = new Client({ name: "pdf-tools-argument-allowlist-test-client", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.join(REPO_ROOT, "server", "index.js"),
        "--allowed-directories",
        firstAllowedDirectory,
        secondAllowedDirectory,
      ],
      cwd: REPO_ROOT,
      env: {
        ALLOWED_DIRECTORIES: "${user_config.allowed_directories}",
        DEFAULT_PROFILES_DIR: argumentProfileDirectory,
      },
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    try {
      await transport?.close();
    } finally {
      await removeTestTempDirectory(argTempDirectory);
    }
  });

  it("prefers expanded arguments over an unresolved environment template", async () => {
    const result = await client.callTool({
      name: "list_pdfs",
      arguments: {
        directory: secondAllowedDirectory,
      },
    });

    const text = textFromToolResult(result);
    expect(text).toContain("Found 1 PDF files");
    expect(text).toContain("argument-example.pdf");
  }, 30_000);
});
