/**
 * The write half of encrypted-PDF support: a mutation tool may open a
 * protected document, and the document it writes back carries exactly the
 * protection it arrived with.
 *
 * The property under test is not "encrypted PDFs can now be filled". It is the
 * one whose failure is silent: a document that opens fine afterwards but is
 * quietly protected differently than its owner intended. So every case asserts
 * against the source rather than against a remembered constant — the output
 * must reject a password the source rejected, accept both passwords the source
 * accepted, and carry a byte-identical `/Encrypt` dictionary.
 *
 * The second property is the permission rule, which is deliberately stricter
 * here than on the read path: holding the *user* password proves you may open
 * the document, not that you may override a restriction its owner set. Only
 * the owner password authorises a change the document's `/P` denies.
 *
 * Fixtures are encrypted here rather than committed, using the same runtime the
 * product uses, so the suite exercises real AES-256, AES-128, RC4-128 and
 * owner-locked documents without adding binaries to the tree.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashBoundedPdfFileSafely } from "../server/bounded-pdf-file.js";
import {
  PDF_LIB_MUTATION_TOOL_NAMES,
  runPdfLibMutation,
} from "../server/pdf-lib-subprocess.js";
import {
  ENCRYPTED_WRITE_OPERATIONS,
  PDF_MERGE_MIXED_ENCRYPTION_MESSAGE,
  mergeProtectionRefusal,
  sameProtection,
  usesWeakCrypto,
  writePermissionRefusal,
} from "../server/qpdf-decrypt.js";
import {
  createTestTempDirectory,
  removeTestTempDirectory,
} from "./helpers/temp-directory.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAIN_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
const RUNTIME_ENTRY = path.join(REPO_ROOT, "vendor", "qpdf-wasm", "runtime", "qpdf.mjs");
const LINE_FEED = String.fromCharCode(10);

const USER_PASSWORD = "user-secret";
const OWNER_PASSWORD = "owner-secret";
const FIELD = "topmostSubform[0].Page1[0].f1_1[0]";

let runtimeFactory = null;
async function qpdf(argv, inputs, outputPath = null) {
  runtimeFactory ??= (await import(RUNTIME_ENTRY)).default;
  const stdout = [];
  const runtime = await runtimeFactory({ print: line => stdout.push(String(line)), printErr: () => {} });
  for (const [virtualPath, bytes] of Object.entries(inputs)) runtime.FS.writeFile(virtualPath, bytes);
  let status;
  try {
    status = runtime.callMain([...argv]);
  } catch (error) {
    status = Number.isInteger(error?.status) ? error.status : -1;
  }
  let output = null;
  if (outputPath) {
    try { output = Buffer.from(runtime.FS.readFile(outputPath)); } catch { output = null; }
  }
  return { status, stdout: stdout.join(LINE_FEED), output };
}

const passwordFile = password => Buffer.from(`${password ?? ""}${LINE_FEED}`, "utf8");

async function encryptFixture(sourceBytes, encryptArgs) {
  const made = await qpdf(
    [...encryptArgs, "/in.pdf", "/out.pdf"],
    { "/in.pdf": new Uint8Array(sourceBytes) },
    "/out.pdf",
  );
  if (!made.output?.length) throw new Error("fixture encryption failed");
  return made.output;
}

/** Whether a document opens at all with the given password. */
async function opensWith(bytes, password) {
  const checked = await qpdf(
    ["--password-file=/pw", "--check", "/in.pdf"],
    { "/in.pdf": new Uint8Array(bytes), "/pw": passwordFile(password) },
  );
  return checked.status === 0 || checked.status === 3;
}

/** QPDF's own report of a document's encryption, read with a given password. */
async function encryptionOf(bytes, password) {
  const inspected = await qpdf(
    ["--json=latest", "--json-key=encrypt", "--password-file=/pw", "/in.pdf"],
    { "/in.pdf": new Uint8Array(bytes), "/pw": passwordFile(password) },
  );
  if (inspected.status !== 0 && inspected.status !== 3) return null;
  try { return JSON.parse(inspected.stdout).encrypt; } catch { return null; }
}

/**
 * The literal `/Encrypt` dictionary, extracted independently of the product's
 * own extractor so the byte-identity claim is not proved by the code that
 * makes it.
 */
function encryptDictionary(bytes) {
  const text = Buffer.from(bytes).toString("latin1");
  const references = [...text.matchAll(/\/Encrypt\s+(\d+)\s+(\d+)\s+R/g)];
  if (references.length === 0) return null;
  const [, objectNumber, generation] = references[references.length - 1];
  const pattern = new RegExp(`(?:^|[^0-9])${objectNumber}\\s+${generation}\\s+obj\\b`, "g");
  let dictionary = null;
  for (const match of text.matchAll(pattern)) {
    const start = text.indexOf("<<", match.index);
    const end = text.indexOf("endobj", match.index);
    if (start < 0 || end < 0 || start > end) continue;
    const body = text.slice(start, end).trim();
    if (body.includes("/Standard")) dictionary = body;
  }
  return dictionary;
}

const RECIPES = Object.freeze({
  aes256: ["--encrypt", `--user-password=${USER_PASSWORD}`, `--owner-password=${OWNER_PASSWORD}`,
    "--bits=256", "--"],
  aes128: ["--encrypt", `--user-password=${USER_PASSWORD}`, `--owner-password=${OWNER_PASSWORD}`,
    "--bits=128", "--use-aes=y", "--"],
  rc4128: ["--allow-weak-crypto", "--encrypt", `--user-password=${USER_PASSWORD}`,
    `--owner-password=${OWNER_PASSWORD}`, "--bits=128", "--use-aes=n", "--"],
  // Opens with no password at all, and permits form filling.
  ownerLockedFormAllowed: ["--encrypt", "--user-password=", `--owner-password=${OWNER_PASSWORD}`,
    "--bits=256", "--modify=form", "--"],
  // Opens with no password at all, and denies every kind of modification.
  ownerLockedFormDenied: ["--encrypt", "--user-password=", `--owner-password=${OWNER_PASSWORD}`,
    "--bits=256", "--modify=none", "--"],
  // Has a real user password, and still denies modification.
  userPasswordFormDenied: ["--encrypt", `--user-password=${USER_PASSWORD}`,
    `--owner-password=${OWNER_PASSWORD}`, "--bits=256", "--modify=none", "--"],
});

let temporaryRoot;
const fixtures = {};

beforeAll(async () => {
  temporaryRoot = await createTestTempDirectory(REPO_ROOT, "qpdf-reprotect");
  const plain = await fs.readFile(PLAIN_PDF);
  for (const [name, args] of Object.entries(RECIPES)) {
    fixtures[name] = await encryptFixture(plain, args);
  }
  fixtures.plain = plain;
}, 180_000);

afterAll(async () => {
  await removeTestTempDirectory(temporaryRoot);
});

let bindings = 0;
async function bindSource(bytes) {
  const filePath = path.join(temporaryRoot, `source-${++bindings}.pdf`);
  await fs.writeFile(filePath, bytes);
  const bound = await hashBoundedPdfFileSafely(filePath, 250 * 1024 * 1024, {
    assertPathAllowed() {},
  });
  return {
    canonical_path: bound.canonicalPath,
    file_identity: bound.fileIdentity,
    sha256: bound.sha256,
    size_bytes: bound.sizeBytes,
  };
}

async function mutate(operation, sources, password, options) {
  return runPdfLibMutation(
    { operation, sources, password, options },
    async ({ outputs }) => Promise.all(outputs.map(output => output.readBytes())),
  );
}

const fillOptions = value => ({ field_data: { [FIELD]: value } });

/**
 * The assertion this whole phase exists for. Compares the output against the
 * *source* on every axis that describes protection, rather than against a
 * value written into the test.
 */
async function expectProtectionPreserved(sourceBytes, outputBytes, password, label) {
  const before = await encryptionOf(sourceBytes, password);
  const after = await encryptionOf(outputBytes, password);
  expect(before, `${label}: source must be encrypted`).not.toBeNull();
  expect(after, `${label}: output must still be encrypted`).not.toBeNull();

  expect(after.parameters.P, `${label}: /P`).toBe(before.parameters.P);
  expect(after.parameters.R, `${label}: /R`).toBe(before.parameters.R);
  expect(after.parameters.V, `${label}: /V`).toBe(before.parameters.V);
  expect(after.parameters.bits, `${label}: key length`).toBe(before.parameters.bits);
  expect(after.parameters.filemethod, `${label}: crypt filter`).toBe(before.parameters.filemethod);
  expect(after.capabilities, `${label}: capabilities`).toEqual(before.capabilities);

  // The strongest form of the claim: the stored dictionary, which is where
  // /O, /U, /OE and /UE live, is byte-for-byte what it was.
  const sourceDictionary = encryptDictionary(sourceBytes);
  expect(sourceDictionary, `${label}: source /Encrypt is locatable`).not.toBeNull();
  expect(encryptDictionary(outputBytes), `${label}: /Encrypt bytes`).toBe(sourceDictionary);

  // And the behavioural form, which does not depend on parsing anything.
  expect(await opensWith(outputBytes, "definitely-not-the-password"), `${label}: junk password`)
    .toBe(false);
  expect(await opensWith(outputBytes, OWNER_PASSWORD), `${label}: owner password`).toBe(true);
  expect(await opensWith(outputBytes, password), `${label}: supplied password`).toBe(true);
}

describe("encrypted write paths restore the document's own protection", () => {
  for (const scheme of ["aes256", "aes128", "rc4128"]) {
    it(`fills a ${scheme} document and writes it back identically protected`, async () => {
      const source = fixtures[scheme];
      const [output] = await mutate(
        "fill_pdf",
        [await bindSource(source)],
        USER_PASSWORD,
        fillOptions(`filled ${scheme}`),
      );
      await expectProtectionPreserved(source, output, USER_PASSWORD, scheme);
    }, 120_000);
  }

  it("keeps protection through a rebuild-style operation, which carries a fresh /ID", async () => {
    // split_pdf, reorder_pdf_pages, apply_page_plan and merge_pdfs build a new
    // document with pdf-lib rather than saving the loaded one, so the bytes
    // handed back for re-protection have a different /ID — or none. For /R 4
    // and below the /U string is derived from /ID[0], so this only works
    // because --copy-encryption restores the reference's /ID as well. An
    // AES-128 (R4) source is used deliberately: on R6 a lost /ID would not be
    // noticed here.
    const source = fixtures.aes128;
    const [output] = await mutate(
      "split_pdf",
      [await bindSource(source)],
      USER_PASSWORD,
      { page_ranges: "1" },
    );
    await expectProtectionPreserved(source, output, USER_PASSWORD, "split R4");
  }, 120_000);

  it("protects every output of a multi-output mutation", async () => {
    const source = fixtures.aes256;
    const outputs = await mutate(
      "bulk_fill_from_csv",
      [await bindSource(source)],
      USER_PASSWORD,
      { records: [{ [FIELD]: "row one" }, { [FIELD]: "row two" }] },
    );
    expect(outputs).toHaveLength(2);
    for (const [index, output] of outputs.entries()) {
      await expectProtectionPreserved(source, output, USER_PASSWORD, `bulk row ${index + 1}`);
    }
  }, 120_000);

  it("leaves an unencrypted document unencrypted", async () => {
    const [output] = await mutate(
      "fill_pdf",
      [await bindSource(fixtures.plain)],
      null,
      fillOptions("still plain"),
    );
    expect(encryptDictionary(output)).toBeNull();
    expect(await opensWith(output, null)).toBe(true);
  }, 120_000);
});

describe("the owner password is what authorises a denied change", () => {
  it("fills an owner-locked document whose /P permits form filling", async () => {
    const source = fixtures.ownerLockedFormAllowed;
    const [output] = await mutate(
      "fill_pdf",
      [await bindSource(source)],
      null,
      fillOptions("permitted"),
    );
    await expectProtectionPreserved(source, output, null, "owner-locked, filling allowed");
  }, 120_000);

  it("refuses when /P denies the change and no password was supplied", async () => {
    const failure = await mutate(
      "fill_pdf",
      [await bindSource(fixtures.ownerLockedFormDenied)],
      null,
      fillOptions("denied"),
    ).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("modifyforms");
    expect(failure.message).toContain("owner password");
    // Must name the restriction without coaching the caller around it.
    expect(failure.message).not.toMatch(/qpdf|decrypt the file first|remove the/i);
  }, 120_000);

  it("still refuses when the USER password is supplied and /P denies the change", async () => {
    // The read path would let this caller through: they hold a credential the
    // document accepts. The write path must not, because the restriction is
    // about what may be done to the document, not who may open it.
    const failure = await mutate(
      "fill_pdf",
      [await bindSource(fixtures.userPasswordFormDenied)],
      USER_PASSWORD,
      fillOptions("denied"),
    ).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("modifyforms");
  }, 120_000);

  it("allows the same change when the OWNER password is supplied", async () => {
    const source = fixtures.userPasswordFormDenied;
    const [output] = await mutate(
      "fill_pdf",
      [await bindSource(source)],
      OWNER_PASSWORD,
      fillOptions("authorised"),
    );
    await expectProtectionPreserved(source, output, OWNER_PASSWORD, "owner override");
    // The restriction itself survives the override: the saved document still
    // denies form filling to a caller holding only the user password. An owner
    // override changes this document, not what this document permits.
    const after = await encryptionOf(output, USER_PASSWORD);
    expect(after.userpasswordmatched).toBe(true);
    expect(after.capabilities.modifyforms).toBe(false);
  }, 120_000);
});

describe("merge_pdfs refuses when the sources' protection is not one protection", () => {
  it("merges sources that carry identical protection", async () => {
    const source = fixtures.aes256;
    const [output] = await mutate(
      "merge_pdfs",
      [await bindSource(source), await bindSource(source)],
      USER_PASSWORD,
      {},
    );
    await expectProtectionPreserved(source, output, USER_PASSWORD, "merge identical");
  }, 120_000);

  it("refuses to merge an encrypted source with an unencrypted one", async () => {
    const failure = await mutate(
      "merge_pdfs",
      [await bindSource(fixtures.aes256), await bindSource(fixtures.plain)],
      USER_PASSWORD,
      {},
    ).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("not all protected the same way");
  }, 120_000);

  it("refuses to merge documents encrypted separately, even with the same password", async () => {
    // Two documents encrypted in separate operations have different /O and /U
    // even when the passwords match, because the salts and /ID differ. They
    // are therefore not one protection, and picking either one's would give
    // the merged document security its other source never had.
    const other = await encryptFixture(fixtures.plain, RECIPES.aes256);
    const failure = await mutate(
      "merge_pdfs",
      [await bindSource(fixtures.aes256), await bindSource(other)],
      USER_PASSWORD,
      {},
    ).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("not all protected the same way");
    // And this is precisely the trap the refusal has to name, because the
    // caller did supply one password for both documents and will otherwise
    // read "the same encryption" as "the same password" and retry.
    expect(failure.message).toContain(
      "Encrypting each source separately with the same password is not enough",
    );
  }, 120_000);

  /*
   * The rule above is not negotiable; what a caller can do about it is. These
   * cases pin the guidance itself, and then prove each named route works, so
   * the message can never drift into advice that cannot be followed.
   */
  describe("the refusal tells the caller what would work", () => {
    it("names why, what is wrong, and both routes that succeed", () => {
      const message = PDF_MERGE_MIXED_ENCRYPTION_MESSAGE;
      // What was wrong, and why it stops rather than choosing for the caller.
      expect(message).toContain("not all protected the same way");
      expect(message).toMatch(/will not choose one source's protection over another's or drop it/);
      // Route one: sources whose stored protection really is one protection.
      expect(message).toMatch(/byte-identical/);
      expect(message).toMatch(/copies of one protected document/);
      expect(message).toMatch(/split_pdf/);
      // Route two: take the protection off first, and put it back yourself.
      expect(message).toMatch(/decrypt every source first \(for example with qpdf\)/i);
      expect(message).toMatch(/protect the merged file yourself/);
      // The trap, with the reason it is a trap rather than a bare warning.
      expect(message).toMatch(/same password is not enough/);
      expect(message).toMatch(/\/R 6/);
      expect(message).toMatch(/\/ID/);
      expect(message).toMatch(/\/O and \/U/);
      // It must not offer the one thing PDF Tools will never do.
      expect(message).not.toMatch(/remove the password/i);
    });

    it("merges the pieces split_pdf makes of one protected document", async () => {
      // Route one, as the message states it. split_pdf re-protects each part
      // with --copy-encryption, so the parts carry the source's exact /Encrypt
      // dictionary and are therefore one protection.
      const source = fixtures.aes256;
      const parts = await mutate(
        "split_pdf",
        [await bindSource(source)],
        USER_PASSWORD,
        { page_ranges: "1-2,3-4" },
      );
      expect(parts).toHaveLength(2);
      expect(encryptDictionary(parts[0])).toBe(encryptDictionary(source));
      expect(encryptDictionary(parts[1])).toBe(encryptDictionary(source));
      const [merged] = await mutate(
        "merge_pdfs",
        [await bindSource(parts[0]), await bindSource(parts[1])],
        USER_PASSWORD,
        {},
      );
      await expectProtectionPreserved(source, merged, USER_PASSWORD, "merge split parts");
    }, 180_000);

    it("merges unprotected copies, which the caller may then protect", async () => {
      // Route two. Decryption is the caller's step, so this stands in for it
      // with the plaintext the fixtures were built from: the merge itself must
      // succeed and produce an unprotected document, which is what leaves the
      // caller free to protect the result however they choose.
      const [merged] = await mutate(
        "merge_pdfs",
        [await bindSource(fixtures.plain), await bindSource(fixtures.plain)],
        null,
        {},
      );
      expect(encryptDictionary(merged)).toBeNull();
      expect(await opensWith(merged, null)).toBe(true);
    }, 120_000);
  });
});

describe("the rules, without a worker", () => {
  const encryption = (capabilities, overrides = {}) => ({
    encrypted: true,
    ownerPasswordMatched: false,
    userPasswordMatched: true,
    capabilities,
    parameters: { P: -4, R: 6, V: 5, bits: 256, method: "AESv3", filemethod: "AESv3",
      streammethod: "AESv3", stringmethod: "AESv3" },
    encryptDictionary: "a".repeat(64),
    ...overrides,
  });

  it("maps every mutation tool to a capability, and no others", () => {
    // A mutation tool missing from the map cannot decrypt at all, and an entry
    // that is not a mutation tool would be granting decryption to something
    // that never asked for it. Both are silent failures, so both are asserted.
    expect(Object.keys(ENCRYPTED_WRITE_OPERATIONS).sort())
      .toEqual([...PDF_LIB_MUTATION_TOOL_NAMES].sort());
    for (const [name, rules] of Object.entries(ENCRYPTED_WRITE_OPERATIONS)) {
      expect(rules.capabilities.length, name).toBeGreaterThan(0);
      for (const capability of rules.capabilities) {
        expect(["modify", "modifyforms", "modifyassembly"], name).toContain(capability);
      }
    }
  });

  it("requires the bit that matches what each tool does to the file", () => {
    // Stamping draws into the page content stream, so it is /P bit 4 and not
    // the annotation bit: a document that permits only commenting must not be
    // content-stamped.
    for (const name of ["apply_signature", "apply_text", "add_signature_field"]) {
      expect(ENCRYPTED_WRITE_OPERATIONS[name].capabilities, name).toEqual(["modify"]);
    }
    for (const name of ["fill_pdf", "fill_with_profile", "bulk_fill_from_csv"]) {
      expect(ENCRYPTED_WRITE_OPERATIONS[name].capabilities, name).toEqual(["modifyforms"]);
    }
    for (const name of ["split_pdf", "merge_pdfs", "rotate_pdf_pages", "reorder_pdf_pages",
      "apply_page_plan"]) {
      expect(ENCRYPTED_WRITE_OPERATIONS[name].capabilities, name).toEqual(["modifyassembly"]);
    }
    // It both fills fields and draws boxes, so it needs both.
    expect([...ENCRYPTED_WRITE_OPERATIONS.prepare_signing_packet.capabilities].sort())
      .toEqual(["modify", "modifyforms"]);
  });

  it("does not let a user password satisfy a denied permission, but lets an owner password", () => {
    const rules = ENCRYPTED_WRITE_OPERATIONS.fill_pdf;
    const denied = encryption({ modifyforms: false });
    expect(writePermissionRefusal(denied, USER_PASSWORD, "fill_pdf", rules)).not.toBeNull();
    expect(writePermissionRefusal(denied, null, "fill_pdf", rules)).not.toBeNull();
    // QPDF keeps reporting the declared capability as false under the owner
    // password, so the owner check must not be read out of the capabilities.
    const asOwner = encryption({ modifyforms: false }, { ownerPasswordMatched: true });
    expect(writePermissionRefusal(asOwner, OWNER_PASSWORD, "fill_pdf", rules)).toBeNull();
    expect(writePermissionRefusal(encryption({ modifyforms: true }), null, "fill_pdf", rules))
      .toBeNull();
  });

  it("refuses a multi-capability tool when either capability is denied", () => {
    const rules = ENCRYPTED_WRITE_OPERATIONS.prepare_signing_packet;
    for (const capabilities of [
      { modify: false, modifyforms: true },
      { modify: true, modifyforms: false },
      { modify: false, modifyforms: false },
    ]) {
      expect(writePermissionRefusal(encryption(capabilities), null, "prepare_signing_packet", rules))
        .not.toBeNull();
    }
    expect(writePermissionRefusal(
      encryption({ modify: true, modifyforms: true }), null, "prepare_signing_packet", rules,
    )).toBeNull();
  });

  it("treats a protection as unchanged only when nothing that describes it moved", () => {
    const source = encryption({ modify: true });
    expect(sameProtection(source, encryption({ modify: true }))).toBe(true);
    for (const drift of [
      { parameters: { ...source.parameters, P: -44 } },
      { parameters: { ...source.parameters, R: 4 } },
      { parameters: { ...source.parameters, bits: 128 } },
      { parameters: { ...source.parameters, filemethod: "RC4" } },
      { encryptDictionary: "b".repeat(64) },
      { encrypted: false },
      { userPasswordMatched: false },
    ]) {
      expect(sameProtection(source, encryption({ modify: true }, drift)), JSON.stringify(drift))
        .toBe(false);
    }
    // An /Encrypt dictionary that could not be resolved never compares equal,
    // so an unreadable or non-standard handler refuses rather than passes.
    expect(sameProtection(
      encryption({ modify: true }, { encryptDictionary: null }),
      encryption({ modify: true }, { encryptDictionary: null }),
    )).toBe(false);
  });

  it("asks for weak-crypto permission only for a document that is already RC4", () => {
    const rc4 = { parameters: { P: -4, R: 3, V: 2, bits: 128, method: "RC4", filemethod: "RC4",
      streammethod: "RC4", stringmethod: "RC4" } };
    expect(usesWeakCrypto(rc4)).toBe(true);
    expect(usesWeakCrypto(encryption({}))).toBe(false);
    expect(usesWeakCrypto(null)).toBe(false);
  });

  it("permits a merge only when every source shares one protection", () => {
    const one = encryption({ modify: true });
    expect(mergeProtectionRefusal([null, null])).toBeNull();
    expect(mergeProtectionRefusal([one, one])).toBeNull();
    expect(mergeProtectionRefusal([one, null])).not.toBeNull();
    expect(mergeProtectionRefusal([one, encryption({ modify: true }, {
      encryptDictionary: "c".repeat(64),
    })])).not.toBeNull();
  });
});
