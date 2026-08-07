import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

// Every prompt template tells the assistant to "start by listing the PDFs in my
// Documents folder", which calls list_pdfs with NO directory argument and relies
// on the DEFAULT_PDF_DIR fallback in server/index.js. Until this suite existed
// that fallback had zero coverage: every other test passes an explicit
// directory, so a regression there would break the first step of all 14 prompts
// while the suite stayed green. Reported by the packaging lane, which shipped
// exactly that regression into its own change and caught it only by hand.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");

let TMP_DIR;
let DEFAULT_DIR;
let OTHER_ALLOWED_DIR;
let client;
let transport;

function textFromToolResult(result) {
  return result.content?.map(item => (item.type === "text" ? item.text : "")).join(" ") || "";
}

describe("list_pdfs with no directory argument", () => {
  beforeAll(async () => {
    TMP_DIR = await createTestTempDirectory(REPO_ROOT, "list-pdfs-default");
    DEFAULT_DIR = path.join(TMP_DIR, "default-pdf-dir");
    OTHER_ALLOWED_DIR = path.join(TMP_DIR, "other-allowed");
    const profileDir = path.join(TMP_DIR, "profiles");
    await fs.mkdir(DEFAULT_DIR, { recursive: true });
    await fs.mkdir(OTHER_ALLOWED_DIR, { recursive: true });
    await fs.mkdir(profileDir, { recursive: true });
    await fs.mkdir(path.join(TMP_DIR, "home"), { recursive: true });

    await fs.copyFile(EXAMPLE_PDF, path.join(DEFAULT_DIR, "in-default-dir.pdf"));
    await fs.copyFile(EXAMPLE_PDF, path.join(OTHER_ALLOWED_DIR, "in-other-dir.pdf"));
    await fs.writeFile(path.join(DEFAULT_DIR, "not-a-pdf.txt"), "ignore me");

    client = new Client({ name: "pdf-tools-default-dir-test-client", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server", "index.js")],
      cwd: REPO_ROOT,
      env: {
        // Isolate HOME. DEFAULT_PDF_DIR falls back to `homedir()/Documents`, so
        // without this a regression that ignores the variable could still pass
        // by reading the operator's real Documents folder, and the suite would
        // touch a directory outside its temp root.
        HOME: path.join(TMP_DIR, "home"),
        USERPROFILE: path.join(TMP_DIR, "home"),
        // Both directories are allowed, so anything the default resolves to is
        // reachable. This isolates "which directory did it pick" from "was it
        // permitted", which would otherwise confound the assertion.
        ALLOWED_DIRECTORIES: [DEFAULT_DIR, OTHER_ALLOWED_DIR].join(path.delimiter),
        DEFAULT_PDF_DIR: DEFAULT_DIR,
        DEFAULT_PROFILES_DIR: profileDir,
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

  it("falls back to DEFAULT_PDF_DIR when called with no arguments at all", async () => {
    const result = await client.callTool({ name: "list_pdfs", arguments: {} });
    expect(result.isError).not.toBe(true);
    const text = textFromToolResult(result);
    expect(text).toContain("in-default-dir.pdf");
    // It must not silently widen to another allowed directory.
    expect(text).not.toContain("in-other-dir.pdf");
  }, 30_000);

  it("treats an omitted directory the same as an empty-string directory", async () => {
    // server/index.js uses `args.directory || DEFAULT_PDF_DIR`, so an empty
    // string must fall back rather than resolve to the process working directory.
    const result = await client.callTool({ name: "list_pdfs", arguments: { directory: "" } });
    expect(result.isError).not.toBe(true);
    expect(textFromToolResult(result)).toContain("in-default-dir.pdf");
  }, 30_000);

  it("lists only PDFs from the default directory", async () => {
    const result = await client.callTool({ name: "list_pdfs", arguments: {} });
    expect(textFromToolResult(result)).not.toContain("not-a-pdf.txt");
  }, 30_000);

  it("still honours an explicit directory, so the fallback is not applied blindly", async () => {
    const result = await client.callTool({
      name: "list_pdfs",
      arguments: { directory: OTHER_ALLOWED_DIR },
    });
    expect(result.isError).not.toBe(true);
    const text = textFromToolResult(result);
    expect(text).toContain("in-other-dir.pdf");
    expect(text).not.toContain("in-default-dir.pdf");
  }, 30_000);

  it("reports structured results the assistant can act on", async () => {
    // The prompts ask the user to pick a file from this listing, so the result
    // has to carry the filename in a usable form, not just prose.
    const result = await client.callTool({ name: "list_pdfs", arguments: {} });
    const structured = result.structuredContent;
    if (structured) {
      expect(JSON.stringify(structured)).toContain("in-default-dir.pdf");
    } else {
      expect(textFromToolResult(result)).toContain("in-default-dir.pdf");
    }
  }, 30_000);
});

describe("list_pdfs output is bounded", () => {
  // The prompts open by listing this directory, so an uncapped listing would be
  // the first thing in every conversation. Before the cap, 2,000 PDFs produced
  // roughly 153,000 characters (~38k tokens) and 10,000 produced ~768,000.
  let bigTmp;
  let bigClient;
  let bigTransport;
  const FILE_COUNT = 260;

  beforeAll(async () => {
    bigTmp = await createTestTempDirectory(REPO_ROOT, "list-pdfs-bounded");
    const big = path.join(bigTmp, "many");
    await fs.mkdir(big, { recursive: true });
    await fs.mkdir(path.join(bigTmp, "home"), { recursive: true });
    await Promise.all(
      Array.from({ length: FILE_COUNT }, (_, i) =>
        fs.writeFile(path.join(big, `scan-${String(i).padStart(4, "0")}.pdf`), "%PDF-1.7\n")),
    );

    bigClient = new Client({ name: "pdf-tools-bounded-list-client", version: "1.0.0" });
    bigTransport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server", "index.js")],
      cwd: REPO_ROOT,
      env: {
        HOME: path.join(bigTmp, "home"),
        USERPROFILE: path.join(bigTmp, "home"),
        ALLOWED_DIRECTORIES: big,
        DEFAULT_PDF_DIR: big,
        DEFAULT_PROFILES_DIR: path.join(bigTmp, "profiles"),
      },
      stderr: "pipe",
    });
    await bigClient.connect(bigTransport);
  }, 60_000);

  afterAll(async () => {
    try {
      await bigTransport?.close();
    } finally {
      await removeTestTempDirectory(bigTmp);
    }
  });

  it("caps the listing, reports the true total, and says how many are hidden", async () => {
    const result = await bigClient.callTool({ name: "list_pdfs", arguments: {} });
    const text = textFromToolResult(result);
    expect(result.isError).not.toBe(true);
    // The true total is reported even though it is not all shown.
    expect(text).toContain(`Found ${FILE_COUNT} PDF files`);
    expect(text).toContain("Showing the first 200");
    expect(text).toContain(`${FILE_COUNT - 200} not shown`);
    const listed = text.split("\n").filter(line => line.endsWith(".pdf"));
    expect(listed).toHaveLength(200);
  }, 60_000);

  it("keeps the response small enough not to dominate a conversation", async () => {
    const result = await bigClient.callTool({ name: "list_pdfs", arguments: {} });
    const text = textFromToolResult(result);
    // Uncapped, 260 entries alone would already exceed this; the guard is that
    // the size stops growing with the folder rather than tracking it.
    expect(text.length).toBeLessThan(40_000);
  }, 60_000);

  it("truncates deterministically by sorted name, not by filesystem order", async () => {
    const first = textFromToolResult(await bigClient.callTool({ name: "list_pdfs", arguments: {} }));
    const second = textFromToolResult(await bigClient.callTool({ name: "list_pdfs", arguments: {} }));
    expect(first).toBe(second);
    // Sorted ascending, so the first name is present and the last is not.
    expect(first).toContain("scan-0000.pdf");
    expect(first).not.toContain(`scan-${String(FILE_COUNT - 1).padStart(4, "0")}.pdf`);
  }, 60_000);
});
