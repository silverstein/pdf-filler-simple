import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
const TMP_DIR = path.join(REPO_ROOT, ".test-tmp-detect-zones-tool");

function textFromToolResult(result) {
  return result.content
    .filter(item => item.type === "text")
    .map(item => item.text)
    .join("\n");
}

describe("detect_signature_zones tool result", () => {
  let client;
  let transport;

  beforeAll(async () => {
    await fs.rm(TMP_DIR, { recursive: true, force: true });
    await fs.mkdir(TMP_DIR, { recursive: true });

    client = new Client({ name: "pdf-tools-detect-zones-tool-test-client", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server", "index.js")],
      cwd: REPO_ROOT,
      env: {
        ALLOWED_DIRECTORIES: `${TMP_DIR}${path.delimiter}${REPO_ROOT}`,
        DEFAULT_PROFILES_DIR: path.join(TMP_DIR, "profiles"),
      },
      stderr: "pipe",
    });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await transport?.close();
    await fs.rm(TMP_DIR, { recursive: true, force: true });
  });

  it("includes exact model-readable coordinates in the visible text response", async () => {
    const result = await client.callTool({
      name: "detect_signature_zones",
      arguments: {
        pdf_path: EXAMPLE_PDF,
      },
    });

    const text = textFromToolResult(result);
    expect(text).toContain("Detected zones (top-left origin, points; use these exact coordinates, do not guess):");
    expect(text).toMatch(/SIGNATURE p1 x=130\.7 y=513\.8 width=244\.9 height=16\.0/);
    expect(text).toMatch(/DATE p1 x=410\.2 y=513\.8 width=110\.0 height=16\.0/);
    expect(text).toContain("For dates, use apply_text at a returned DATE zone.");
    expect(result.structuredContent.zones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "signature",
          page: 1,
          x: expect.closeTo(130.7, 1),
          y: expect.closeTo(513.8, 1),
          width: expect.closeTo(244.9, 1),
          height: 16,
        }),
        expect.objectContaining({
          type: "date",
          page: 1,
          x: expect.closeTo(410.2, 1),
          y: expect.closeTo(513.8, 1),
          width: 110,
          height: 16,
        }),
      ])
    );
  }, 30_000);
});
