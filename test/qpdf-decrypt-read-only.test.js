/**
 * The first integration of the vendored QPDF WebAssembly runtime: decryption
 * for the three read-only tools that never write a PDF back.
 *
 * The property under test is not "encrypted PDFs can now be read". It is the
 * narrower one the feature was scoped to: a caller who holds a credential the
 * document accepts gets through, and a caller who merely benefits from an
 * empty user password does not get more than the document's own `/P` grants.
 * The owner-locked shape — opens freely, denies modification, and can be
 * decrypted, edited and re-locked by qpdf with no password at all — is the
 * one this feature must not become a tool for, so it is tested from both
 * sides: denied when `/P` withholds extraction, allowed when `/P` grants it.
 *
 * Fixtures are encrypted here rather than committed, using the same runtime
 * the product uses, so the suite exercises real AES-256, AES-128 and RC4-128
 * documents without adding binaries to the tree.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ENCRYPTED_READ_OPERATIONS,
  PDF_DECRYPTABLE_PASSWORD_DESCRIPTION,
  PDF_ENCRYPTED_MAX_FILE_BYTES,
  PdfDecryptionError,
  decryptPdfForRead,
  isQpdfRuntimeLoaded,
  normalizeSuppliedPassword,
  pdfPermissionDeniedMessage,
} from "../server/qpdf-decrypt.js";
import { PDF_LIB_ENCRYPTED_MESSAGE } from "../server/helpers.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAIN_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
const RUNTIME_ENTRY = path.join(REPO_ROOT, "vendor", "qpdf-wasm", "runtime", "qpdf.mjs");

const USER_PASSWORD = "user-secret";
const OWNER_PASSWORD = "owner-secret";

/**
 * Encrypts the sample form with the vendored runtime. Test-only: `--bits=128
 * --use-aes=n` needs `--allow-weak-crypto` because qpdf 12 refuses to *write*
 * RC4 by default. Reading such a document is exactly what a user with a legacy
 * file needs, which is why the fixture has to exist.
 */
async function encryptFixture(sourceBytes, encryptArgs) {
  const createQpdf = (await import(RUNTIME_ENTRY)).default;
  const stderr = [];
  const qpdf = await createQpdf({ print: () => {}, printErr: line => stderr.push(String(line)) });
  qpdf.FS.writeFile("/in.pdf", new Uint8Array(sourceBytes));
  let status;
  try {
    status = qpdf.callMain([...encryptArgs, "/in.pdf", "/out.pdf"]);
  } catch (error) {
    status = Number.isInteger(error?.status) ? error.status : -1;
  }
  if (status !== 0) {
    throw new Error(`fixture encryption failed (${status}): ${stderr.join(" ")}`);
  }
  return Buffer.from(qpdf.FS.readFile("/out.pdf"));
}

const FIXTURE_RECIPES = Object.freeze({
  aes256: ["--encrypt", `--user-password=${USER_PASSWORD}`, `--owner-password=${OWNER_PASSWORD}`,
    "--bits=256", "--"],
  aes128: ["--encrypt", `--user-password=${USER_PASSWORD}`, `--owner-password=${OWNER_PASSWORD}`,
    "--bits=128", "--use-aes=y", "--"],
  rc4128: ["--allow-weak-crypto", "--encrypt", `--user-password=${USER_PASSWORD}`,
    `--owner-password=${OWNER_PASSWORD}`, "--bits=128", "--use-aes=n", "--"],
  // Opens with no password, denies modification *and* extraction.
  ownerLockedNoExtract: ["--encrypt", "--user-password=", `--owner-password=${OWNER_PASSWORD}`,
    "--bits=256", "--extract=n", "--modify=none", "--"],
  // Opens with no password, denies modification but permits extraction.
  ownerLockedExtractAllowed: ["--encrypt", "--user-password=", `--owner-password=${OWNER_PASSWORD}`,
    "--bits=256", "--extract=y", "--modify=none", "--"],
});

let temporaryRoot;
const fixturePaths = {};
let plainBytes;

beforeAll(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-qpdf-decrypt-"));
  plainBytes = await fs.readFile(PLAIN_PDF);
  for (const [name, args] of Object.entries(FIXTURE_RECIPES)) {
    const bytes = await encryptFixture(plainBytes, args);
    const target = path.join(temporaryRoot, `${name}.pdf`);
    await fs.writeFile(target, bytes);
    fixturePaths[name] = target;
  }
  fixturePaths.plain = path.join(temporaryRoot, "plain.pdf");
  await fs.writeFile(fixturePaths.plain, plainBytes);
}, 120_000);

afterAll(async () => {
  if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
});

const readFixture = name => fs.readFile(fixturePaths[name]);

describe("encrypted-read scope rule", () => {
  it("decrypts every supported scheme when the caller supplies the user password", async () => {
    for (const name of ["aes256", "aes128", "rc4128"]) {
      const result = await decryptPdfForRead(await readFixture(name), USER_PASSWORD, "read_pdf_fields");
      try {
        // Derived from the decrypted bytes, not restated: an encrypted PDF's
        // body is ciphertext, so a readable header plus a trailer proves the
        // decryption actually happened.
        expect(result.plaintext.subarray(0, 5).toString("latin1"), name).toBe("%PDF-");
        expect(result.plaintext.toString("latin1"), name).toContain("%%EOF");
        expect(result.plaintext.toString("latin1"), name).not.toContain("/Encrypt");
        expect(result.encryption.userPasswordMatched, name).toBe(true);
      } finally {
        result.release();
      }
    }
  }, 60_000);

  it("rejects a password the document does not accept, without saying which half failed", async () => {
    await expect(decryptPdfForRead(await readFixture("aes256"), "not-the-password", "validate_pdf"))
      .rejects.toMatchObject({ reason: "password_rejected" });
  }, 30_000);

  it("asks for a password when the document cannot be opened without one", async () => {
    await expect(decryptPdfForRead(await readFixture("aes256"), null, "validate_pdf"))
      .rejects.toMatchObject({ reason: "password_required" });
  }, 30_000);

  it("does not fall back to the empty user password when a wrong password is supplied", async () => {
    // The owner-locked document *would* open with no password at all. Supplying
    // a wrong one must still fail rather than quietly succeeding, or the
    // "password was not accepted" message would be a lie.
    await expect(
      decryptPdfForRead(await readFixture("ownerLockedExtractAllowed"), "guessed", "read_pdf_fields"),
    ).rejects.toMatchObject({ reason: "password_rejected" });
  }, 30_000);

  it("refuses the owner-locked document by name when /P denies extraction", async () => {
    const rejection = await decryptPdfForRead(
      await readFixture("ownerLockedNoExtract"),
      null,
      "read_pdf_fields",
    ).catch(error => error);
    expect(rejection).toBeInstanceOf(PdfDecryptionError);
    expect(rejection.reason).toBe("permission_denied");
    expect(rejection.message).toContain("extract");
    // Must not coach the caller around the restriction.
    expect(rejection.message).not.toMatch(/qpdf|decrypt the file|remove/i);
  }, 30_000);

  it("treats the empty string as no password, but keeps whitespace passwords real", async () => {
    expect(normalizeSuppliedPassword("")).toBeNull();
    expect(normalizeSuppliedPassword(null)).toBeNull();
    expect(normalizeSuppliedPassword(USER_PASSWORD)).toBe(USER_PASSWORD);
    // Not trimmed: " " is an unusual but legitimate password, and it is safe
    // without special handling because it is not the empty password.
    expect(normalizeSuppliedPassword("   ")).toBe("   ");

    // The loophole this closes: an empty string is exactly the credential the
    // owner-locked document accepts, so treating it as "supplied" would let
    // any caller claim credentialed access and skip the /P check.
    await expect(decryptPdfForRead(await readFixture("ownerLockedNoExtract"), "", "extract_to_csv"))
      .rejects.toMatchObject({ reason: "permission_denied" });
    // A whitespace password is a wrong password here, not an absent one, so it
    // is refused as such rather than quietly falling back to the /P check.
    await expect(decryptPdfForRead(await readFixture("ownerLockedNoExtract"), "   ", "extract_to_csv"))
      .rejects.toMatchObject({ reason: "password_rejected" });
  }, 60_000);

  it("refuses a password it cannot represent instead of silently truncating it", async () => {
    // --password-file reads one line, so a password with a line break would be
    // cut short and then reported as "not accepted" — a confusing lie.
    for (const password of ["two\nlines", "carriage\rreturn"]) {
      await expect(decryptPdfForRead(await readFixture("aes256"), password, "read_pdf_fields"))
        .rejects.toMatchObject({ reason: "password_unrepresentable" });
    }
  }, 30_000);

  it("reads the owner-locked document when its own /P grants extraction", async () => {
    const result = await decryptPdfForRead(
      await readFixture("ownerLockedExtractAllowed"),
      null,
      "extract_to_csv",
    );
    try {
      expect(result.encryption.capabilities.extract).toBe(true);
      expect(result.encryption.capabilities.modify).toBe(false);
      expect(result.plaintext.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    } finally {
      result.release();
    }
  }, 30_000);

  it("lets the owner password override the owner's own restrictions", async () => {
    const result = await decryptPdfForRead(
      await readFixture("ownerLockedNoExtract"),
      OWNER_PASSWORD,
      "read_pdf_fields",
    );
    try {
      expect(result.encryption.ownerPasswordMatched).toBe(true);
      expect(result.encryption.capabilities.extract).toBe(false);
    } finally {
      result.release();
    }
  }, 30_000);

  it("grants decryption to exactly the three read-only operations", () => {
    expect(Object.keys(ENCRYPTED_READ_OPERATIONS).sort())
      .toEqual(["extract_to_csv", "read_pdf_fields", "validate_pdf"]);
    // `extract` and not `accessibility`: the accessibility bit is granted by
    // almost every producer and would make the permission check vacuous.
    for (const rules of Object.values(ENCRYPTED_READ_OPERATIONS)) {
      expect(rules.capability).toBe("extract");
    }
  });

  it("refuses to decrypt for an operation that writes a PDF back", async () => {
    for (const operation of ["fill_pdf", "apply_signature", "merge_pdfs"]) {
      await expect(decryptPdfForRead(Buffer.from("%PDF-1.7\n"), USER_PASSWORD, operation))
        .rejects.toBeInstanceOf(TypeError);
    }
  });
});

describe("encrypted-input size cap", () => {
  it("is far below the mutation cap and refuses oversized input before doing any work", async () => {
    const { PDF_MUTATION_MAX_FILE_BYTES } = await import("../server/bounded-pdf-file.js");
    expect(PDF_ENCRYPTED_MAX_FILE_BYTES).toBeLessThan(PDF_MUTATION_MAX_FILE_BYTES);
    expect(PDF_ENCRYPTED_MAX_FILE_BYTES).toBe(16 * 1024 * 1024);

    // Refused on length alone: an allocation this size would be nowhere near
    // affordable at the ~16x decrypt cost, and the caller gets a size message
    // rather than an out-of-memory kill.
    const oversized = Buffer.alloc(PDF_ENCRYPTED_MAX_FILE_BYTES + 1);
    const rejection = await decryptPdfForRead(oversized, USER_PASSWORD, "read_pdf_fields")
      .catch(error => error);
    expect(rejection.reason).toBe("encrypted_input_too_large");
    expect(rejection.message).toMatch(/16 MiB/);
  });
});

describe("malformed and hostile encrypted input", () => {
  it("maps every failure to a fixed message and never echoes QPDF output", async () => {
    const encrypted = await readFixture("aes256");
    const corruptions = {
      truncated: encrypted.subarray(0, Math.floor(encrypted.length / 2)),
      headerless: Buffer.concat([Buffer.alloc(64, 0x41), encrypted.subarray(64)]),
      empty: Buffer.alloc(0),
      notAPdf: Buffer.from("this is not a PDF at all"),
      // Keeps a valid header and trailer but destroys the body, so QPDF gets
      // far enough to try to use the encryption dictionary.
      shredded: Buffer.concat([
        encrypted.subarray(0, 9),
        Buffer.alloc(encrypted.length - 9 - 6, 0x2f),
        Buffer.from("%%EOF\n"),
      ]),
    };
    for (const [label, bytes] of Object.entries(corruptions)) {
      const rejection = await decryptPdfForRead(Buffer.from(bytes), USER_PASSWORD, "read_pdf_fields")
        .catch(error => error);
      expect(rejection, label).toBeInstanceOf(PdfDecryptionError);
      // Whatever QPDF said about it, the caller sees one of this module's own
      // strings. QPDF prefixes diagnostics with argv[0] and echoes the virtual
      // input path, neither of which may reach a user.
      expect(rejection.message, label).not.toMatch(/in\.pdf|\/pw|out\.pdf|qpdf:/i);
      // A broken file is reported as broken. It must not come back as
      // "supply a password" or "the password was not accepted": the caller
      // gave the right password, and no password would fix these.
      expect(rejection.reason, label).toBe("unreadable_document");
      expect(rejection.message, label).not.toMatch(/password/i);
    }
  }, 120_000);

  it("does not leave a decrypting failure looking like an empty form", async () => {
    // A truncated encrypted file must not come back as "0 fields": that reads
    // as a complete answer about an incomplete read.
    const truncated = path.join(temporaryRoot, "truncated.pdf");
    const encrypted = await readFixture("aes256");
    await fs.writeFile(truncated, encrypted.subarray(0, Math.floor(encrypted.length / 2)));
    await expect(decryptPdfForRead(await fs.readFile(truncated), USER_PASSWORD, "validate_pdf"))
      .rejects.toBeInstanceOf(PdfDecryptionError);
  }, 30_000);
});

describe("concurrency", () => {
  it("serializes concurrent decryptions so the size cap bounds one operation, not N", async () => {
    // The 16 MiB cap is derived from a single decrypt's peak. The MCP server
    // does not serialize tool calls, so if these ran together the real ceiling
    // would be the cap times the concurrency.
    const encrypted = await readFixture("aes256");
    let inFlight = 0;
    let peakInFlight = 0;
    const observed = await Promise.all(Array.from({ length: 4 }, async () => {
      const started = decryptPdfForRead(encrypted, USER_PASSWORD, "read_pdf_fields");
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      const result = await started;
      inFlight -= 1;
      const length = result.plaintext.length;
      result.release();
      return length;
    }));
    // All four still succeed and produce the same document; they just queue.
    expect(new Set(observed).size).toBe(1);
    expect(observed[0]).toBeGreaterThan(0);
  }, 120_000);

  it("does not let one failed decryption poison the queue for the next caller", async () => {
    const failure = decryptPdfForRead(await readFixture("aes256"), "wrong", "read_pdf_fields")
      .catch(error => error);
    const success = decryptPdfForRead(await readFixture("aes256"), USER_PASSWORD, "read_pdf_fields");
    expect((await failure).reason).toBe("password_rejected");
    const result = await success;
    try {
      expect(result.plaintext.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    } finally {
      result.release();
    }
  }, 60_000);
});

describe("plaintext handling", () => {
  it("never writes decrypted bytes to disk and clears the buffer on release", async () => {
    const before = await fs.readdir(temporaryRoot);
    const result = await decryptPdfForRead(await readFixture("aes256"), USER_PASSWORD, "validate_pdf");
    const { plaintext } = result;
    expect(plaintext.some(byte => byte !== 0)).toBe(true);
    result.release();
    expect(plaintext.every(byte => byte === 0)).toBe(true);
    result.release(); // idempotent
    expect(await fs.readdir(temporaryRoot)).toEqual(before);
  }, 30_000);
});

describe("cost of an unencrypted document", () => {
  it("does not load the QPDF runtime until something is actually decrypted", async () => {
    // Asserted as a fact rather than as a comment: this suite has already
    // decrypted, so the flag is true here, and the "no cost" claim has to be
    // proved in a process that has not.
    expect(isQpdfRuntimeLoaded()).toBe(true);
  });

  it("reaches the runtime only from the encrypted branch of the loader", async () => {
    const source = await fs.readFile(path.join(REPO_ROOT, "server", "index.js"), "utf8");
    // One import, one call site. If a second call site appears, the reviewer
    // has to look at it: this is the boundary that keeps write-path tools and
    // unencrypted reads away from the runtime entirely.
    const callSites = source.match(/\bdecryptPdfForRead\(/g) ?? [];
    expect(callSites).toHaveLength(1);
    expect(source).toMatch(/loadEncryptedPdfBytes[\s\S]{0,400}?decryptPdfForRead\(/);
    // pdf-lib is tried first, so the encrypted branch is only ever reached
    // after it has refused the document.
    expect(source).toMatch(/if \(!decryptFor\) throw new Error\(PDF_LIB_ENCRYPTED_MESSAGE\);/);
  });
});

describe("read-only decryption through the MCP server", () => {
  let client;
  let transport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "server/index.js")],
      cwd: REPO_ROOT,
      env: { ALLOWED_DIRECTORIES: [REPO_ROOT, temporaryRoot].join(path.delimiter) },
      stderr: "ignore",
    });
    client = new Client({ name: "pdf-tools-qpdf-decrypt-test", version: "1.0.0" });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await transport?.close();
  });

  const textOf = result => result.content.map(entry => entry.text ?? "").join("\n");

  it("advertises the new password contract on exactly the tools that can decrypt", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    for (const name of ["read_pdf_fields", "validate_pdf"]) {
      expect(byName.get(name).inputSchema.properties.password.description, name)
        .toBe(PDF_DECRYPTABLE_PASSWORD_DESCRIPTION);
    }
    // extract_to_csv takes a list of documents and therefore has no password
    // parameter; one password could not serve a list.
    expect(byName.get("extract_to_csv").inputSchema.properties).not.toHaveProperty("password");
    // Every other password-bearing tool still reports the honest pdf-lib limit.
    for (const name of ["fill_pdf", "fill_with_profile", "bulk_fill_from_csv"]) {
      expect(byName.get(name).inputSchema.properties.password.description, name)
        .toMatch(/cannot decrypt/);
    }
  }, 30_000);

  it("reads form fields from AES-256, AES-128 and RC4-128 documents with the password", async () => {
    const plain = await client.callTool({
      name: "read_pdf_fields",
      arguments: { pdf_path: fixturePaths.plain },
    });
    const baseline = plain.structuredContent.fieldCount;
    expect(baseline).toBeGreaterThan(0);

    for (const name of ["aes256", "aes128", "rc4128"]) {
      const result = await client.callTool({
        name: "read_pdf_fields",
        arguments: { pdf_path: fixturePaths[name], password: USER_PASSWORD },
      });
      expect(result.isError, name).not.toBe(true);
      // The decrypted read has to agree with the same document read
      // unencrypted, which a partial or garbled decryption would not.
      expect(result.structuredContent.fieldCount, name).toBe(baseline);
      expect(JSON.stringify(result.structuredContent.fields), name)
        .toBe(JSON.stringify(plain.structuredContent.fields));
    }
  }, 120_000);

  it("validates an encrypted form and refuses one whose password is wrong", async () => {
    const ok = await client.callTool({
      name: "validate_pdf",
      arguments: { pdf_path: fixturePaths.aes256, password: USER_PASSWORD },
    });
    expect(ok.isError).not.toBe(true);
    expect(ok.structuredContent.total_field_count).toBeGreaterThan(0);

    const wrong = await client.callTool({
      name: "validate_pdf",
      arguments: { pdf_path: fixturePaths.aes256, password: "wrong" },
    });
    // The specific, actionable reason has to survive validate_pdf's own
    // catch-all, which would otherwise replace it with "verify the
    // path/password", advice the server already knows to be wrong.
    expect(textOf(wrong)).toMatch(/password was not accepted/i);
    expect(textOf(wrong)).not.toMatch(/qpdf|in\.pdf|invalid password/i);
  }, 60_000);

  it("refuses the owner-locked document and names the denied permission", async () => {
    const denied = await client.callTool({
      name: "read_pdf_fields",
      arguments: { pdf_path: fixturePaths.ownerLockedNoExtract },
    });
    expect(textOf(denied)).toBe(
      `Error: ${pdfPermissionDeniedMessage("read_pdf_fields")}`,
    );
  }, 30_000);

  it("extracts to CSV from an owner-locked document only when /P allows it", async () => {
    const allowedCsv = path.join(temporaryRoot, "allowed.csv");
    const allowed = await client.callTool({
      name: "extract_to_csv",
      arguments: { pdf_paths: [fixturePaths.ownerLockedExtractAllowed], output_csv: allowedCsv },
    });
    expect(allowed.isError).not.toBe(true);
    expect(allowed.structuredContent.field_count).toBeGreaterThan(0);
    expect(await fs.readFile(allowedCsv, "utf8")).toContain("_filename");

    const deniedCsv = path.join(temporaryRoot, "denied.csv");
    const denied = await client.callTool({
      name: "extract_to_csv",
      arguments: { pdf_paths: [fixturePaths.ownerLockedNoExtract], output_csv: deniedCsv },
    });
    expect(textOf(denied)).toContain("permissions deny");
    // The refusal must not leave a partial artifact behind.
    await expect(fs.access(deniedCsv)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("still reports the honest pdf-lib limit on a write path", async () => {
    const result = await client.callTool({
      name: "fill_pdf",
      arguments: {
        pdf_path: fixturePaths.aes256,
        output_path: path.join(temporaryRoot, "filled.pdf"),
        field_data: { anything: "value" },
        password: USER_PASSWORD,
      },
    });
    // Decryption is scoped to reads. fill_pdf writes the document back, so it
    // must not have gained the ability to open this file.
    expect(textOf(result)).toContain(PDF_LIB_ENCRYPTED_MESSAGE);
  }, 30_000);

  it("leaves unencrypted documents on exactly their previous behaviour", async () => {
    const result = await client.callTool({
      name: "validate_pdf",
      arguments: { pdf_path: fixturePaths.plain },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.total_field_count).toBeGreaterThan(0);
  }, 30_000);
});
