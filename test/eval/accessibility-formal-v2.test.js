import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  FORMAL_EVIDENCE_V2_OFFICIAL,
  FormalEvidenceV2Error,
  assertByteIdentity,
  assertPublicProjectionSafe,
  buildPublicProjection,
  executionIdentityMatches,
  loadFormalAccessibilityV2Contract,
  parseGpgvStatus,
  preparePrivateGeneration,
  runBoundedProcess,
  runFormalAccessibilityV2Evaluation,
  writePrivateFile,
} from "./accessibility-formal-v2.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONTRACT_PATH = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "accessibility",
  "formal-corpus.v2.json"
);
const temporaryDirectories = [];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function temporaryDirectory(prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function canonicalStatus({
  fingerprint = FORMAL_EVIDENCE_V2_OFFICIAL.primaryFingerprint,
  date = FORMAL_EVIDENCE_V2_OFFICIAL.signatureDate,
  timestamp = FORMAL_EVIDENCE_V2_OFFICIAL.signatureTimestampEpoch,
} = {}) {
  const keyId = fingerprint.slice(-16);
  return Buffer.from([
    "[GNUPG:] NEWSIG",
    `[GNUPG:] KEY_CONSIDERED ${fingerprint} 0`,
    `[GNUPG:] SIG_ID syntheticSignatureId ${date} ${timestamp}`,
    `[GNUPG:] GOODSIG ${keyId} Synthetic Test Signer <signer@example.invalid>`,
    `[GNUPG:] VALIDSIG ${fingerprint} ${date} ${timestamp} 0 4 0 1 10 00 ${fingerprint}`,
    "",
  ].join("\n"));
}

function fakeIdentity() {
  const file = { sha256: "a".repeat(64), size: 1 };
  return {
    publicKey: { ...file },
    signature: { ...file },
    verifier: { ...file },
    installer: { ...file },
    validator: { ...file },
    cliJar: { ...file },
    runtimeArchive: { ...file },
    java: { ...file },
    validatorTree: { digest: "b".repeat(64) },
    runtimeTree: { digest: "c".repeat(64) },
  };
}

function safeProjectionShape() {
  return {
    projection_version: 1,
    publication_authorized: false,
    bounded_installer_claim: "bounded",
    authenticity: {
      result: "verified",
      primary_fingerprint: FORMAL_EVIDENCE_V2_OFFICIAL.primaryFingerprint,
      public_key_sha256: FORMAL_EVIDENCE_V2_OFFICIAL.publicKeySha256,
      signature_sha256: FORMAL_EVIDENCE_V2_OFFICIAL.signatureSha256,
      installer_sha256: FORMAL_EVIDENCE_V2_OFFICIAL.installerSha256,
      signature_date: FORMAL_EVIDENCE_V2_OFFICIAL.signatureDate,
      verifier: {
        name: "gpgv",
        version: FORMAL_EVIDENCE_V2_OFFICIAL.gpgvVersionLine,
        executable_sha256: FORMAL_EVIDENCE_V2_OFFICIAL.gpgvSha256,
      },
    },
    validator: {
      name: "veraPDF",
      version: "1.30.2",
      profile: "ua1",
      bundled: false,
    },
    pilot: {
      scope: "two files",
      fixture_count: 0,
      passed: false,
      confusion: {
        version_identification: {
          true_positives: 0,
          true_negatives: 0,
          false_positives: 0,
          false_negatives: 0,
          harness_failures: 0,
        },
      },
      results: [],
    },
    claim_boundary: {
      pdfua_conformance: "not_established",
      wcag_conformance: "not_established",
      legal_compliance: "not_established",
      certification: "not_established",
    },
    private_evidence: {
      retained: true,
      qualification_index_required: true,
    },
    limitations: ["one", "two", "three", "four", "five", "six"],
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

describe("formal accessibility v2 identity contract", () => {
  it("loads a closed v2 contract without changing the frozen v1 contract", async () => {
    const { contract } = await loadFormalAccessibilityV2Contract(CONTRACT_PATH);
    expect(contract).toMatchObject({
      contract_version: 2,
      corpus_version: "v0.1.0",
      evidence_runner_version: 3,
      provenance: {
        public_key_url: FORMAL_EVIDENCE_V2_OFFICIAL.publicKeyUrl,
        public_key_sha256: FORMAL_EVIDENCE_V2_OFFICIAL.publicKeySha256,
        public_key_size: FORMAL_EVIDENCE_V2_OFFICIAL.publicKeySize,
        primary_fingerprint: FORMAL_EVIDENCE_V2_OFFICIAL.primaryFingerprint,
      },
      signature_verifier: {
        executable_path: "/usr/bin/gpgv",
        executable_sha256: FORMAL_EVIDENCE_V2_OFFICIAL.gpgvSha256,
        bundled: false,
      },
      claim_boundary: {
        pdfua_conformance: "not_established",
        wcag_conformance: "not_established",
        legal_compliance: "not_established",
        certification: "not_established",
        publication_authorized: false,
      },
    });

    const v1 = await fs.readFile(path.join(
      REPO_ROOT,
      "test",
      "fixtures",
      "eval",
      "accessibility",
      "formal-corpus.v1.json"
    ));
    expect(sha256(v1)).toBe("fff4ff2bb2a67f1a9267e9561f39547288ffdf56cb4e6b6869c6224ddb932c64");
  });

  it("rejects a changed official fingerprint and an extra contract field", async () => {
    const root = await temporaryDirectory("pdf-tools-igr5-contract-");
    const contract = JSON.parse(await fs.readFile(CONTRACT_PATH, "utf8"));
    contract.provenance.primary_fingerprint = `0${contract.provenance.primary_fingerprint.slice(1)}`;
    const wrongFingerprint = path.join(root, "wrong-fingerprint.json");
    await fs.writeFile(wrongFingerprint, JSON.stringify(contract));
    await expect(loadFormalAccessibilityV2Contract(wrongFingerprint))
      .rejects.toMatchObject({ code: "CONTRACT_IDENTITY_INVALID" });

    const extra = JSON.parse(await fs.readFile(CONTRACT_PATH, "utf8"));
    extra.unreviewed = true;
    const extraPath = path.join(root, "extra.json");
    await fs.writeFile(extraPath, JSON.stringify(extra));
    await expect(loadFormalAccessibilityV2Contract(extraPath))
      .rejects.toMatchObject({ code: "CONTRACT_SHAPE_INVALID" });
  });

  it("fails closed on one-byte key, signature, and installer mutations", () => {
    for (const label of ["public key", "signature", "installer"]) {
      const reviewed = Buffer.from(`${label} reviewed bytes`);
      const digest = sha256(reviewed);
      expect(assertByteIdentity(reviewed, digest, reviewed.length, label)).toBe(true);
      const mutated = Buffer.from(reviewed);
      mutated[0] ^= 1;
      expect(() => assertByteIdentity(mutated, digest, reviewed.length, label))
        .toThrowError(expect.objectContaining({ code: "INPUT_HASH_MISMATCH" }));
    }
  });

  it("detects persistent execution identity and tree drift", () => {
    const initial = fakeIdentity();
    expect(executionIdentityMatches(initial, structuredClone(initial))).toBe(true);

    const fileDrift = structuredClone(initial);
    fileDrift.installer.sha256 = "d".repeat(64);
    expect(executionIdentityMatches(initial, fileDrift)).toBe(false);

    const treeDrift = structuredClone(initial);
    treeDrift.validatorTree.digest = "e".repeat(64);
    expect(executionIdentityMatches(initial, treeDrift)).toBe(false);
  });
});

describe("strict gpgv status evidence", () => {
  it("accepts only the reviewed signer, signature time, RSA, and SHA-512 status", async () => {
    const { contract } = await loadFormalAccessibilityV2Contract(CONTRACT_PATH);
    expect(parseGpgvStatus(canonicalStatus(), 0, contract)).toEqual({
      verified: true,
      primary_fingerprint: FORMAL_EVIDENCE_V2_OFFICIAL.primaryFingerprint,
      signature_date: FORMAL_EVIDENCE_V2_OFFICIAL.signatureDate,
      signature_timestamp_epoch: FORMAL_EVIDENCE_V2_OFFICIAL.signatureTimestampEpoch,
      public_key_algorithm: "RSA",
      digest_algorithm: "SHA-512",
      signature_class: "00",
    });
  });

  it.each([
    ["malformed line", Buffer.from("not a status line\n"), "GPG_STATUS_MALFORMED"],
    ["exit-zero without status", Buffer.alloc(0), "GPG_STATUS_MALFORMED"],
    ["missing newline", canonicalStatus().subarray(0, canonicalStatus().length - 1), "GPG_STATUS_MALFORMED"],
    ["duplicate valid status", Buffer.concat([
      canonicalStatus(),
      Buffer.from(`[GNUPG:] VALIDSIG ${FORMAL_EVIDENCE_V2_OFFICIAL.primaryFingerprint} 2026-06-03 1780484180 0 4 0 1 10 00 ${FORMAL_EVIDENCE_V2_OFFICIAL.primaryFingerprint}\n`),
    ]), "GPG_STATUS_SEQUENCE_INVALID"],
    ["fatal status", Buffer.concat([canonicalStatus(), Buffer.from("[GNUPG:] BADSIG 78B17FE7\n")]),
      "GPG_FATAL_STATUS"],
  ])("rejects %s", async (_label, status, code) => {
    const { contract } = await loadFormalAccessibilityV2Contract(CONTRACT_PATH);
    expect(() => parseGpgvStatus(status, 0, contract))
      .toThrowError(expect.objectContaining({ code }));
  });

  it("rejects a different signer, signature time, algorithm, and nonzero exit", async () => {
    const { contract } = await loadFormalAccessibilityV2Contract(CONTRACT_PATH);
    const otherFingerprint = `0${FORMAL_EVIDENCE_V2_OFFICIAL.primaryFingerprint.slice(1)}`;
    expect(() => parseGpgvStatus(canonicalStatus({ fingerprint: otherFingerprint }), 0, contract))
      .toThrowError(expect.objectContaining({ code: "GPG_FINGERPRINT_MISMATCH" }));
    expect(() => parseGpgvStatus(canonicalStatus({ timestamp: 1780484181 }), 0, contract))
      .toThrowError(expect.objectContaining({ code: "GPG_SIGNATURE_TIME_MISMATCH" }));

    const weakHash = canonicalStatus().toString("utf8").replace(" 1 10 00 ", " 1 2 00 ");
    expect(() => parseGpgvStatus(Buffer.from(weakHash), 0, contract))
      .toThrowError(expect.objectContaining({ code: "GPG_VALIDSIG_MISMATCH" }));
    expect(() => parseGpgvStatus(canonicalStatus(), 1, contract))
      .toThrowError(expect.objectContaining({ code: "GPG_EXIT_NONZERO" }));
  });
});

describe.sequential("bounded process groups", () => {
  it("terminates and closes a timed-out process group", async () => {
    const result = await runBoundedProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 50,
      maxOutputBytes: 1024,
    });
    expect(result).toMatchObject({
      timed_out: true,
      termination_attempted: true,
      process_group_empty_after_cleanup: true,
    });
  });

  it("terminates an output flood without retaining over-limit bytes", async () => {
    const result = await runBoundedProcess(process.execPath, [
      "-e",
      "process.stdout.write('x'.repeat(1024 * 1024)); setInterval(() => {}, 1000)",
    ], {
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
    });
    expect(result).toMatchObject({
      output_limit_exceeded: true,
      termination_attempted: true,
      process_group_empty_after_cleanup: true,
    });
    expect(result.stdout.length).toBeLessThanOrEqual(1024);
  });

  it("kills and reports a stubborn descendant after its leader exits", async () => {
    const script = [
      "const {spawn}=require('node:child_process');",
      "spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{stdio:'ignore'});",
      "process.exit(0);",
    ].join("");
    const result = await runBoundedProcess(process.execPath, ["-e", script], {
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
    });
    expect(result).toMatchObject({
      descendant_observed_after_leader_close: true,
      termination_attempted: true,
      process_group_empty_after_cleanup: true,
    });
  });
});

describe.sequential("private evidence durability", () => {
  it("creates mode-0700 generations and mode-0600 files under a permissive umask", async () => {
    const root = await temporaryDirectory("pdf-tools-igr5-generation-");
    await fs.chmod(root, 0o700);
    const previousUmask = process.umask(0o000);
    try {
      const generation = await preparePrivateGeneration(root);
      expect((await fs.stat(generation)).mode & 0o777).toBe(0o700);
      const receipt = await writePrivateFile(path.join(generation, "evidence.json"), Buffer.from("private"));
      expect(receipt).toEqual({
        sha256: sha256(Buffer.from("private")),
        size: 7,
      });
      expect((await fs.stat(path.join(generation, "evidence.json"))).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("rejects permissive, symlinked, and non-directory generation roots", async () => {
    const root = await temporaryDirectory("pdf-tools-igr5-unsafe-");
    const permissive = path.join(root, "permissive");
    await fs.mkdir(permissive, { mode: 0o755 });
    await fs.chmod(permissive, 0o755);
    await expect(preparePrivateGeneration(permissive))
      .rejects.toMatchObject({ code: "PRIVATE_GENERATION_ROOT_UNSAFE" });

    const safe = path.join(root, "safe");
    await fs.mkdir(safe, { mode: 0o700 });
    const linked = path.join(root, "linked");
    await fs.symlink(safe, linked);
    await expect(preparePrivateGeneration(linked))
      .rejects.toMatchObject({ code: "INPUT_SYMLINK_REJECTED" });

    const regular = path.join(root, "file");
    await fs.writeFile(regular, "not a directory");
    await expect(preparePrivateGeneration(regular))
      .rejects.toMatchObject({ code: "INPUT_TYPE_INVALID" });
  });

  it("never overwrites an existing evidence file or follows its symlink", async () => {
    const root = await temporaryDirectory("pdf-tools-igr5-exclusive-");
    const target = path.join(root, "evidence.json");
    await fs.writeFile(target, "existing");
    await expect(writePrivateFile(target, Buffer.from("replacement")))
      .rejects.toMatchObject({ code: "PRIVATE_WRITE_FAILED" });
    expect(await fs.readFile(target, "utf8")).toBe("existing");

    const outside = path.join(root, "outside");
    await fs.writeFile(outside, "outside");
    const linked = path.join(root, "linked.json");
    await fs.symlink(outside, linked);
    await expect(writePrivateFile(linked, Buffer.from("replacement")))
      .rejects.toMatchObject({ code: "PRIVATE_WRITE_FAILED" });
    expect(await fs.readFile(outside, "utf8")).toBe("outside");
  });
});

describe("authenticity sequencing and public projection", () => {
  const linuxX64 = process.platform === "linux" && process.arch === "x64";

  it.runIf(linuxX64)("runs no validator and creates no generation after public-key authenticity failure", async () => {
    const root = await temporaryDirectory("pdf-tools-igr5-auth-order-");
    const generationRoot = path.join(root, "generations");
    await fs.mkdir(generationRoot, { mode: 0o700 });
    const wrongKey = path.join(root, "wrong-key.asc");
    await fs.writeFile(wrongKey, Buffer.alloc(FORMAL_EVIDENCE_V2_OFFICIAL.publicKeySize));
    const validatorMarker = path.join(root, "validator-called");
    const validator = path.join(root, "validator");
    await fs.writeFile(validator, `#!/bin/sh\n: > '${validatorMarker}'\n`, { mode: 0o755 });

    await expect(runFormalAccessibilityV2Evaluation({
      contractPath: CONTRACT_PATH,
      corpusDirectory: path.join(root, "missing-corpus"),
      publicKeyPath: wrongKey,
      signaturePath: path.join(root, "missing-signature"),
      verifierPath: "/usr/bin/gpgv",
      validatorPath: validator,
      validatorArtifactPath: path.join(root, "missing-installer"),
      runtimeArchivePath: path.join(root, "missing-runtime"),
      javaHome: path.join(root, "missing-java"),
      generationRoot,
    })).rejects.toMatchObject({ code: "INPUT_HASH_MISMATCH" });
    await expect(fs.lstat(validatorMarker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(generationRoot)).toEqual([]);
  });

  it("builds a closed non-publishable projection without paths, raw status, output, or signer UID", async () => {
    const { contract } = await loadFormalAccessibilityV2Contract(CONTRACT_PATH);
    const authenticity = {
      primary_fingerprint: FORMAL_EVIDENCE_V2_OFFICIAL.primaryFingerprint,
      public_key_sha256: FORMAL_EVIDENCE_V2_OFFICIAL.publicKeySha256,
      signature_sha256: FORMAL_EVIDENCE_V2_OFFICIAL.signatureSha256,
      installer_sha256: FORMAL_EVIDENCE_V2_OFFICIAL.installerSha256,
      signature_date: FORMAL_EVIDENCE_V2_OFFICIAL.signatureDate,
      verifier_name: "gpgv",
      verifier_version: FORMAL_EVIDENCE_V2_OFFICIAL.gpgvVersionLine,
      verifier_executable_sha256: FORMAL_EVIDENCE_V2_OFFICIAL.gpgvSha256,
    };
    const results = contract.fixtures.map(fixture => ({
      id: fixture.id,
      expected_machine_compliant: fixture.expected_machine_compliant,
      fixture_sha256: fixture.sha256,
      evidence: { machine_compliant: fixture.expected_machine_compliant },
      harness_error_code: null,
      expectation_met: true,
    }));
    const projection = buildPublicProjection({
      contract,
      authenticity,
      results,
      passed: true,
    });
    expect(assertPublicProjectionSafe(projection)).toBe(true);
    const serialized = JSON.stringify(projection);
    for (const forbidden of [
      "/home/",
      "/Users/",
      "[GNUPG:]",
      "Synthetic Test Signer",
      "signer@example.invalid",
      "Carl Wilson",
      "techlead@verapdf.org",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it.each([
    ["absolute path", projection => {
      projection.limitations[0] = "/home/operator/private";
    }],
    ["raw status", projection => {
      projection.authenticity.debug_status = "[GNUPG:] VALIDSIG";
    }],
    ["private canary", projection => {
      projection.limitations[0] = "BLUEHARBOR-PRIVATE-CANARY";
    }],
    ["publication authorization", projection => {
      projection.publication_authorized = true;
    }],
    ["unreviewed top-level field", projection => {
      projection.unreviewed = true;
    }],
  ])("rejects public projection mutation: %s", (_label, mutate) => {
    const projection = safeProjectionShape();
    mutate(projection);
    expect(() => assertPublicProjectionSafe(projection))
      .toThrowError(FormalEvidenceV2Error);
  });
});
