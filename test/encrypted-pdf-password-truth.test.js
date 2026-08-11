// Truthfulness guard for encrypted PDFs.
//
// pdf-lib 1.17.1 has no decryption at all. PDF.js does decrypt, and the
// vendored qpdf runtime now decrypts for the pdf-lib paths that opted into it.
// So there are three honest stories a tool can tell about a password, and the
// only untruthful thing a tool can do is tell the wrong one. This suite builds
// a real AES-256 PDF with qpdf at run time (no encrypted binary is committed
// for it), then proves:
//
//   1. the libraries really do behave that way, so the claim is measured here
//      rather than asserted from documentation;
//   2. a tool that cannot decrypt says so, and never tells the caller to supply
//      a password it cannot use;
//   3. a tool that can decrypt does not carry the "cannot decrypt" text, and
//      says what it actually does — including, on a write path, that the
//      document's protection is put back rather than removed;
//   4. every tool the honest message points at genuinely opens the same
//      document with the same password.
//
// (4) is what stops the message from drifting into naming a tool that does not
// work, (2) is what stops the old "please provide the correct password" advice
// from coming back, and (3) is the same guard pointing the other way: it stops
// a tool that gained decryption from keeping a refusal it no longer means.

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

// Tools that read through pdf-lib but decrypt first, via the vendored qpdf
// runtime in server/qpdf-decrypt.js. They are read-only — none writes a PDF
// back — which is why they are allowed to decrypt at all. Their password
// argument is genuinely usable, so the "cannot decrypt" text would be a lie on
// them and this suite must not require it.
const DECRYPTING_PASSWORD_TOOLS = Object.freeze(["read_pdf_fields", "validate_pdf"]);

// Tools that decrypt, change the document, and then restore the document's own
// encryption before saving. Their password argument is usable too, so the
// "cannot decrypt" text would be a lie on them as well. What they must say
// instead is what they actually do to the protection, because a caller's real
// question on a write path is whether the file comes back protected.
const REPROTECTING_PASSWORD_TOOLS = Object.freeze([
  "add_signature_field", "apply_page_plan", "apply_signature", "apply_text",
  "bulk_fill_from_csv", "fill_pdf", "fill_with_profile", "merge_pdfs",
  "prepare_signing_packet", "reorder_pdf_pages", "rotate_pdf_pages", "split_pdf",
]);

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

  it("tells the truth on a WRITE path, and writes nothing without a usable password", async () => {
    // fill_pdf loads inside the pdf-lib worker subprocess and writes the
    // document back. It decrypts now — and re-protects afterwards — so the
    // truthfulness requirement moves rather than disappears: a missing or
    // wrong password must say which of the two it was, produce no file, and
    // never quote the password back.
    const filled = path.join(tempDirectory, "filled.pdf");
    const attempt = async password => callTool("fill_pdf", {
      pdf_path: encryptedPath,
      field_data: {},
      output_path: filled,
      ...(password === undefined ? {} : { password }),
    });

    const omitted = await attempt(undefined);
    expect(omitted.isError, "fill_pdf with no password").toBe(true);
    expect(toolText(omitted)).toMatch(/cannot be opened without a password/i);

    const wrong = await attempt(WRONG_PASSWORD);
    expect(wrong.isError, "fill_pdf with a wrong password").toBe(true);
    expect(toolText(wrong)).toMatch(/password was not accepted/i);
    expect(toolText(wrong), "must not echo the password").not.toContain(WRONG_PASSWORD);
    // The pdf-lib limit is no longer the truth on this path, so citing it
    // would be the new lie.
    expect(toolText(wrong)).not.toContain(PDF_LIB_ENCRYPTED_MESSAGE);

    // Neither failure may have produced a file.
    await expect(fs.access(filled)).rejects.toThrow();

    const accepted = await attempt(USER_PASSWORD);
    expect(accepted.isError, "fill_pdf with the correct password").not.toBe(true);
    expect(toolText(accepted), "must not echo the password").not.toContain(USER_PASSWORD);
    // And what it wrote is still an encrypted document: a write path that
    // silently produced plaintext would be the worst possible outcome here.
    const written = await fs.readFile(filled);
    expect(written.toString("latin1")).toContain("/Encrypt");
    await expect(PDFDocument.load(written)).rejects.toThrow(/encrypted/i);
  }, 120_000);

  it("tells the truth on the read paths that now decrypt, and never echoes the password", async () => {
    // These used to be covered by the blanket "every pdf-lib reader fails"
    // assertion above. They decrypt now, so the truthfulness requirement moves
    // rather than disappears: each outcome must describe what actually
    // happened, and no outcome may contain the password.
    for (const tool of DECRYPTING_PASSWORD_TOOLS) {
      const accepted = await callTool(tool, { pdf_path: encryptedPath, password: USER_PASSWORD });
      expect(accepted.isError, `${tool} with the correct password`).not.toBe(true);
      expect(toolText(accepted), `${tool} must not echo the password`).not.toContain(USER_PASSWORD);

      const rejected = await callTool(tool, { pdf_path: encryptedPath, password: WRONG_PASSWORD });
      expect(toolText(rejected), `${tool} with a wrong password`).toMatch(/password was not accepted/i);
      expect(toolText(rejected), `${tool} must not echo the password`).not.toContain(WRONG_PASSWORD);
      // The old "supply the correct password" advice must not come back in the
      // one case where it is still wrong to imply pdf-lib could use it.
      expect(toolText(rejected), `${tool} must not cite the pdf-lib limit`)
        .not.toContain(PDF_LIB_ENCRYPTED_MESSAGE);

      const omitted = await callTool(tool, { pdf_path: encryptedPath });
      expect(toolText(omitted), `${tool} with no password`).toMatch(/cannot be opened without a password/i);
    }
  }, 120_000);

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
      if (REPROTECTING_PASSWORD_TOOLS.includes(tool.name)) {
        expect(description, `${tool.name} password description`).not.toMatch(/cannot decrypt/i);
        expect(description, `${tool.name} password description`).not.toMatch(/never used/i);
        // It must state the one thing a write path has to promise.
        expect(description, `${tool.name} password description`)
          .toMatch(/never removed, changed, or added/i);
        continue;
      }
      if (DECRYPTING_PASSWORD_TOOLS.includes(tool.name)) {
        // These decrypt, so they must NOT carry the "cannot decrypt" text —
        // the same drift guard, pointing the other way.
        expect(description, `${tool.name} password description`).not.toMatch(/cannot decrypt/i);
        expect(description, `${tool.name} password description`).not.toMatch(/never used/i);
        // This used to require the text "permissions allow", back when these
        // three refused an owner-locked document whose `/P` denied extraction.
        // They no longer do — `/P` governs writes only — so advertising that
        // caveat would now be the drift, and the assertion is inverted to catch
        // it coming back.
        expect(description, `${tool.name} password description`)
          .not.toMatch(/permissions allow|permissions deny/i);
        // What has to stay true is the size bound and the promise that this is
        // not a way to take a document's protection off.
        expect(description, `${tool.name} password description`).toMatch(/16 MiB/);
        expect(description, `${tool.name} password description`)
          .toMatch(/never removes or weakens/i);
        continue;
      }
      expect(description, `${tool.name} password description`).toMatch(/pdf-lib/);
      expect(description, `${tool.name} password description`).toMatch(/cannot decrypt/i);
    }
  }, 30_000);
});
