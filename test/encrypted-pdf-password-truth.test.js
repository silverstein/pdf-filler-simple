// Truthfulness guard for encrypted PDFs.
//
// pdf-lib 1.17.1 has no decryption at all, so every tool whose reader is
// pdf-lib fails on an encrypted document no matter what password the caller
// sends. PDF.js does decrypt. This suite builds a real AES-256 PDF with qpdf at
// run time (no encrypted binary is committed for it), then proves three things
// that keep the product honest:
//
//   1. the two libraries really do behave that way, so the claim is measured
//      here rather than asserted from documentation;
//   2. a pdf-lib path reports that it cannot decrypt, and never tells the
//      caller to supply a password it cannot use;
//   3. every tool the honest message points at genuinely opens the same
//      document with the same password.
//
// (3) is what stops the message from drifting into naming a tool that does not
// work, and (2) is what stops the old "please provide the correct password"
// advice from coming back.

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument } from "pdf-lib";
import { PDF_LIB_ENCRYPTED_MESSAGE } from "../server/helpers.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAINTEXT_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
const USER_PASSWORD = "encrypted-truth-user-2026";
const WRONG_PASSWORD = "encrypted-truth-wrong-2026";

// Every tool that advertises a `password` argument and reads only through
// PDF.js. The honest pdf-lib message is allowed to name these and nothing else.
const PDFJS_PASSWORD_TOOLS = Object.freeze(["convert_pdf_to_markdown", "get_pdf_info", "read_pdf_layout"]);

function probeQpdf() {
  try {
    const probe = spawnSync("qpdf", ["--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      return { available: false, reason: probe.error ? probe.error.message : `qpdf --version exited ${probe.status}` };
    }
    return { available: true, version: probe.stdout.split("\n")[0].trim() };
  } catch (error) {
    return { available: false, reason: error.message };
  }
}

const QPDF = probeQpdf();

describe("encrypted PDF password truthfulness", () => {
  // Always runs, so the report states the guard's status instead of quietly
  // omitting it. A skipped encryption guard must be loud: a silent skip is how
  // a truthfulness regression reaches a release unnoticed.
  it("reports whether the qpdf-backed encryption guard could run", () => {
    expect(typeof QPDF.available).toBe("boolean");
    if (QPDF.available) return;
    expect(QPDF.reason, "a skip must carry its reason").toEqual(expect.any(String));
    expect(QPDF.reason.length).toBeGreaterThan(0);
    const banner = `[encrypted-pdf-password-truth] SKIPPED: qpdf is unavailable (${QPDF.reason}). `
      + "The encrypted-PDF password-truthfulness guard did NOT run. Install qpdf to enforce it.";
    process.stderr.write(`\n${"!".repeat(78)}\n${banner}\n${"!".repeat(78)}\n\n`);
    console.warn(banner);
  });
});

describe.skipIf(!QPDF.available)("encrypted PDF password truthfulness (qpdf present)", () => {
  let client;
  let transport;
  let tempDirectory;
  let encryptedPath;
  let encryptedBytes;

  const callTool = async (name, args) => await client.callTool({ name, arguments: args });
  const toolText = result => result.content?.map(part => part.text ?? "").join("\n") ?? "";

  beforeAll(async () => {
    tempDirectory = await createTestTempDirectory(REPO_ROOT, "encrypted-password-truth");
    encryptedPath = path.join(tempDirectory, "aes256-encrypted.pdf");
    const encrypt = spawnSync("qpdf", [
      "--encrypt",
      `--user-password=${USER_PASSWORD}`,
      `--owner-password=${USER_PASSWORD}`,
      "--bits=256",
      "--",
      PLAINTEXT_PDF,
      encryptedPath,
    ], { encoding: "utf8" });
    if (encrypt.status !== 0) {
      throw new Error(`qpdf encryption failed (${encrypt.status}): ${encrypt.stderr}`);
    }
    encryptedBytes = await fs.readFile(encryptedPath);

    client = new Client({ name: "encrypted-password-truth-test", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: { ALLOWED_DIRECTORIES: [REPO_ROOT, tempDirectory].join(path.delimiter) },
      stderr: "ignore",
    });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    try {
      await client?.close();
      await transport?.close();
    } finally {
      await removeTestTempDirectory(tempDirectory);
    }
  });

  it("measures that pdf-lib cannot decrypt and PDF.js can", async () => {
    // The premise of every other assertion in this file, checked against the
    // pinned libraries instead of taken on trust.
    await expect(PDFDocument.load(encryptedBytes, { password: USER_PASSWORD }))
      .rejects.toThrow(/encrypted/i);
    await expect(PDFDocument.load(encryptedBytes)).rejects.toThrow(/encrypted/i);
    // pdf-lib's own suggested escape hatch produces a document that cannot be
    // used, which is why the error must not repeat that advice either.
    let ignoredEncryptionFailure = null;
    try {
      const ignored = await PDFDocument.load(encryptedBytes, { ignoreEncryption: true });
      ignored.getPages();
    } catch (error) {
      ignoredEncryptionFailure = error;
    }
    expect(ignoredEncryptionFailure, "ignoreEncryption must not yield a usable document").not.toBeNull();

    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({
      data: new Uint8Array(encryptedBytes),
      password: USER_PASSWORD,
      isEvalSupported: false,
      useSystemFonts: false,
    });
    const document = await task.promise;
    try {
      expect(document.numPages).toBeGreaterThan(0);
    } finally {
      await task.destroy();
    }
  }, 60_000);

  it("states the pdf-lib limit instead of asking for a password it cannot use", () => {
    // Derived from the message itself, so rewording it cannot smuggle the old
    // instruction back in.
    const message = PDF_LIB_ENCRYPTED_MESSAGE;
    expect(message).toMatch(/cannot decrypt|no decryption/i);
    expect(message).toMatch(/pdf-lib/);
    expect(message).not.toMatch(/provide the correct password/i);
    expect(message).not.toMatch(/using the '?password'? parameter/i);
    expect(message).not.toMatch(/ignoreEncryption/);
    // It must direct the caller somewhere that works, and only there.
    const namedTools = PDFJS_PASSWORD_TOOLS.filter(tool => message.includes(tool));
    expect(namedTools).toEqual([...PDFJS_PASSWORD_TOOLS]);
  });

  it("fails every pdf-lib reader identically whether or not a password is sent", async () => {
    // read_pdf_fields loads in-process; fill_pdf loads inside the pdf-lib
    // worker subprocess. Both copies of the loader must tell the same truth.
    const attempts = [
      { name: "read_pdf_fields", base: { pdf_path: encryptedPath } },
      {
        name: "fill_pdf",
        base: { pdf_path: encryptedPath, field_data: {}, output_path: path.join(tempDirectory, "filled.pdf") },
      },
    ];
    for (const attempt of attempts) {
      for (const password of [undefined, WRONG_PASSWORD, USER_PASSWORD]) {
        const result = await callTool(attempt.name, {
          ...attempt.base,
          ...(password === undefined ? {} : { password }),
        });
        const label = `${attempt.name} password=${password ?? "(omitted)"}`;
        expect(result.isError, label).toBe(true);
        expect(toolText(result), label).toBe(`Error: ${PDF_LIB_ENCRYPTED_MESSAGE}`);
        if (password !== undefined) {
          expect(toolText(result), label).not.toContain(password);
        }
      }
    }
    // The correct password must not have produced an output file either.
    await expect(fs.access(path.join(tempDirectory, "filled.pdf"))).rejects.toThrow();
  }, 90_000);

  it("opens the same document with the same password on every tool the message names", async () => {
    // Binds the advice to behavior: if one of these stops working, the message
    // is no longer true and this test fails.
    const invocations = {
      convert_pdf_to_markdown: { pdf_path: encryptedPath, password: USER_PASSWORD, start_page: 1, end_page: 1 },
      get_pdf_info: { pdf_path: encryptedPath, password: USER_PASSWORD },
      read_pdf_layout: { pdf_path: encryptedPath, password: USER_PASSWORD, start_page: 1, end_page: 1 },
    };
    expect(Object.keys(invocations).sort()).toEqual([...PDFJS_PASSWORD_TOOLS].sort());
    for (const tool of PDFJS_PASSWORD_TOOLS) {
      const result = await callTool(tool, invocations[tool]);
      expect(result.isError, `${tool} with the correct password`).not.toBe(true);
      expect(toolText(result), `${tool} must not echo the password`).not.toContain(USER_PASSWORD);
    }
  }, 120_000);

  it("does not point a password-less read tool at a password parameter it lacks", async () => {
    // read_pdf_content and its siblings decrypt through PDF.js but expose no
    // password argument, so the advice must name tools that do accept one.
    const { tools } = await client.listTools();
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    for (const tool of ["read_pdf_content", "read_pdf_pages", "search_pdf_text"]) {
      expect(Object.keys(byName.get(tool).inputSchema.properties), `${tool} schema`)
        .not.toContain("password");
    }
    const readArguments = {
      read_pdf_content: { pdf_path: encryptedPath },
      read_pdf_pages: { pdf_path: encryptedPath, start_page: 1, end_page: 1 },
      search_pdf_text: { pdf_path: encryptedPath, query: "name" },
    };
    for (const [tool, args] of Object.entries(readArguments)) {
      const result = await callTool(tool, args);
      const text = toolText(result);
      expect(result.isError, tool).toBe(true);
      expect(text, tool).not.toMatch(/provide it with the password parameter/i);
      expect(PDFJS_PASSWORD_TOOLS.filter(named => text.includes(named)), tool)
        .toEqual([...PDFJS_PASSWORD_TOOLS]);
    }
  }, 90_000);

  it("never advertises a usable password on a pdf-lib-backed tool", async () => {
    // The schema text is the other place the claim can drift.
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const description = tool.inputSchema?.properties?.password?.description;
      if (typeof description !== "string") continue;
      if (PDFJS_PASSWORD_TOOLS.includes(tool.name)) {
        expect(description, `${tool.name} password description`).not.toMatch(/pdf-lib/);
        continue;
      }
      expect(description, `${tool.name} password description`).toMatch(/pdf-lib/);
      expect(description, `${tool.name} password description`).toMatch(/cannot decrypt/i);
    }
  }, 30_000);
});
