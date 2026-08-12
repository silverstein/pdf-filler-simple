import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { recoverPdfOutputTransactions } from "../server/helpers.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

// Three handlers resolved a path and then stat/open/spawned that same string,
// without the O_NOFOLLOW open and identity rebind that server/bounded-pdf-file.js
// applies everywhere else. The policy check therefore validated one file while
// the operation could reach another (CWE-367). These assert the boundary holds
// on the paths those handlers take, and that legitimate symlinks keep working.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "server", "index.js");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");

function textFromToolResult(result) {
  return result.content?.map(item => item.type === "text" ? item.text : "").join(" ") || "";
}

function structuredErrorCode(result) {
  return result.structuredContent?.error?.code;
}

describe("path handler symlink containment", () => {
  let client;
  let transport;
  let tempDirectory;
  let allowedDirectory;
  let outsideDirectory;
  let secretPath;
  let escapingLink;
  let internalLink;
  let realPdfPath;

  beforeAll(async () => {
    tempDirectory = await createTestTempDirectory(REPO_ROOT, "path-handler-toctou");
    allowedDirectory = path.join(tempDirectory, "allowed");
    outsideDirectory = path.join(tempDirectory, "outside");
    await fs.mkdir(allowedDirectory, { recursive: true });
    await fs.mkdir(outsideDirectory, { recursive: true });

    // A document the user never allowed this server to reach.
    secretPath = path.join(outsideDirectory, "secret.pdf");
    await fs.copyFile(EXAMPLE_PDF, secretPath);

    // A real document inside the allowed set, and a symlink to it. The symlink
    // is legitimate: it resolves to a permitted file, so it must keep working.
    realPdfPath = path.join(allowedDirectory, "real.pdf");
    await fs.copyFile(EXAMPLE_PDF, realPdfPath);
    internalLink = path.join(allowedDirectory, "link-to-real.pdf");
    await fs.symlink(realPdfPath, internalLink);

    // A symlink that lives inside the allowed set but points out of it. The
    // name passes a prefix test; the file it reaches does not.
    escapingLink = path.join(allowedDirectory, "innocent.pdf");
    await fs.symlink(secretPath, escapingLink);

    client = new Client({ name: "pdf-tools-toctou-client", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: path.join(tempDirectory, "home"),
        ALLOWED_DIRECTORIES: allowedDirectory,
        DEFAULT_PROFILES_DIR: path.join(tempDirectory, "profiles"),
      },
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    try {
      await transport?.close();
    } finally {
      await removeTestTempDirectory(tempDirectory);
    }
  });

  it("refuses read_pdf_bytes through a symlink that leaves the allowed set", async () => {
    const result = await client.callTool({
      name: "read_pdf_bytes",
      arguments: { pdf_path: escapingLink, offset: 0, byteCount: 64 },
    });

    expect(structuredErrorCode(result)).toBe("path_policy_denied");
    expect(result.structuredContent?.bytes).toBeUndefined();
  }, 30_000);

  it("still reads a symlink that resolves inside the allowed set", async () => {
    const result = await client.callTool({
      name: "read_pdf_bytes",
      arguments: { pdf_path: internalLink, offset: 0, byteCount: 64 },
    });

    // Containment must not be bought by refusing every symlink; a link to a
    // permitted file is an ordinary way to organise documents.
    expect(structuredErrorCode(result)).toBeUndefined();
    expect(result.structuredContent?.bytes).toBeTruthy();
  }, 30_000);

  it("reports the canonical path it actually read, not the name it was given", async () => {
    const result = await client.callTool({
      name: "read_pdf_bytes",
      arguments: { pdf_path: internalLink, offset: 0, byteCount: 64 },
    });

    // The caller uses this path for follow-up calls. Echoing the symlink name
    // back leaves a second window in which that name can be repointed.
    expect(result.structuredContent?.pdfPath).toBe(await fs.realpath(realPdfPath));
  }, 30_000);

  it("refuses get_pdf_resource_uri through an escaping symlink", async () => {
    const result = await client.callTool({
      name: "get_pdf_resource_uri",
      arguments: { pdf_path: escapingLink },
    });

    expect(structuredErrorCode(result)).toBe("path_policy_denied");
    expect(result.structuredContent?.uri).toBeUndefined();
  }, 30_000);

  it("binds a resource URI to the canonical file", async () => {
    const result = await client.callTool({
      name: "get_pdf_resource_uri",
      arguments: { pdf_path: internalLink },
    });

    // A resource URI outlives the call that produced it, so it must name the
    // file that was checked rather than a link that can be retargeted later.
    expect(result.structuredContent?.pdf_path).toBe(await fs.realpath(realPdfPath));
  }, 30_000);

  it("refuses reveal_in_finder through an escaping symlink", async () => {
    const result = await client.callTool({
      name: "reveal_in_finder",
      arguments: { path: escapingLink },
    });

    // This one hands a path to a platform process, so a denial must happen
    // before the spawn rather than being reported after it.
    expect(structuredErrorCode(result)).toBe("path_policy_denied");
    expect(textFromToolResult(result)).not.toContain("Revealed");
  }, 30_000);

  it.skipIf(process.platform === "win32")(
    "refuses read_pdf_bytes on a named pipe inside the allowed set",
    async () => {
      // A FIFO passes an existence check and lives at a permitted path, but
      // reading it is not reading a document: the open can block on a writer
      // that never arrives. The guard is "regular file", not "exists".
      const fifoPath = path.join(allowedDirectory, "pipe.pdf");
      const { spawnSync } = await import("child_process");
      const made = spawnSync("mkfifo", [fifoPath]);
      if (made.status !== 0) return; // mkfifo unavailable; nothing to assert

      const result = await client.callTool({
        name: "read_pdf_bytes",
        arguments: { pdf_path: fifoPath, offset: 0, byteCount: 16 },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent?.bytes).toBeUndefined();
      await fs.rm(fifoPath, { force: true });
    },
    30_000,
  );

  it("refuses read_pdf_bytes on a directory rather than failing obscurely", async () => {
    const result = await client.callTool({
      name: "read_pdf_bytes",
      arguments: { pdf_path: allowedDirectory, offset: 0, byteCount: 64 },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.bytes).toBeUndefined();
  }, 30_000);
});

describe("atomic output recovery error classification", () => {
  let tempDirectory;
  let outputDirectory;

  beforeAll(async () => {
    tempDirectory = await createTestTempDirectory(REPO_ROOT, "toctou-error-classification");
    outputDirectory = path.join(tempDirectory, "output");
    await fs.mkdir(outputDirectory, { recursive: true });
  }, 30_000);

  afterAll(async () => {
    await removeTestTempDirectory(tempDirectory);
  });

  it("surfaces a policy denial as a denial, not as a retryable directory change", async () => {
    const denial = new Error("The requested path is outside the configured allowed directories.");
    denial.code = "path_policy_denied";

    const failure = await recoverPdfOutputTransactions(outputDirectory, {
      assertPathAllowed: async () => { throw denial; },
    }).then(() => null, error => error);

    // Rewrapping a refusal as ATOMIC_OUTPUT_DIRECTORY_CHANGED tells the caller
    // to retry an operation that cannot succeed, and hides the real reason.
    expect(failure).not.toBeNull();
    expect(failure.code).toBe("path_policy_denied");
  }, 30_000);

  it("still reports a genuine directory change as a directory change", async () => {
    const missingDirectory = path.join(tempDirectory, "not-there");

    const failure = await recoverPdfOutputTransactions(missingDirectory, {
      assertPathAllowed: async () => {},
    }).then(() => null, error => error);

    expect(failure).not.toBeNull();
    expect(failure.code).toBe("ATOMIC_OUTPUT_DIRECTORY_CHANGED");
  }, 30_000);
});
