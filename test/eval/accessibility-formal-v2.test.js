import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  FORMAL_EVIDENCE_V2_OFFICIAL,
  FormalEvidenceV2Error,
  assertPrivateGenerationIdentity,
  assertByteIdentity,
  assertPublicProjectionSafe,
  buildPublicProjection,
  closePrivateGeneration,
  executionIdentityMatches,
  loadAndVerifySourceReceipt,
  loadFormalAccessibilityV2Contract,
  parseGpgvStatus,
  preparePrivateGeneration,
  runBoundedProcess,
  runFormalAccessibilityV2Evaluation,
  stageVerifiedFixture,
  verifyStagedFixture,
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
const CLI_PATH = path.join(REPO_ROOT, "scripts", "eval-run-accessibility-formal-v2.mjs");
const temporaryDirectories = [];
const SOURCE_PATHS = Object.freeze({
  cli: "scripts/eval-run-accessibility-formal-v2.mjs",
  runner: "test/eval/accessibility-formal-v2.js",
  v1_helper: "test/eval/accessibility-formal.js",
  contract: "test/fixtures/eval/accessibility/formal-corpus.v2.json",
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function temporaryDirectory(prefix) {
  // Canonical: generation roots are rejected when an ancestor is a symlink,
  // and on macOS os.tmpdir() resolves under a symlinked /var.
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

function boundedOptions(overrides = {}) {
  return {
    timeoutMs: 5_000,
    stdoutMaxBytes: 1_024,
    stderrMaxBytes: 1_024,
    aggregateMaxBytes: 2_048,
    termGraceMs: 50,
    groupEmptyTimeoutMs: 2_000,
    ...overrides,
  };
}

async function createSourceReceipt(directory) {
  const files = {};
  for (const [name, relativePath] of Object.entries(SOURCE_PATHS)) {
    const bytes = await fs.readFile(path.join(REPO_ROOT, relativePath));
    files[name] = {
      relative_path: relativePath,
      sha256: sha256(bytes),
      size: bytes.length,
    };
  }
  const nodeRealpath = await fs.realpath(process.execPath);
  const nodeBytes = await fs.readFile(nodeRealpath);
  const receipt = {
    receipt_version: 1,
    receipt_kind: "pdf_tools_accessibility_formal_v2_source_runtime",
    publication_authorized: false,
    captured_at: "2026-07-30T00:00:00.000Z",
    capture_method: "external_supervisor_git_sha256_node_identity_v1",
    repository: {
      commit: "1".repeat(40),
      tree: "2".repeat(40),
      clean_attested: true,
    },
    files,
    node: {
      executable_realpath: nodeRealpath,
      executable_sha256: sha256(nodeBytes),
      executable_size: nodeBytes.length,
      version: process.version,
    },
  };
  const receiptPath = path.join(directory, "source-receipt.json");
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(receiptPath, 0o600);
  return { receipt, receiptPath };
}

function completeCliArguments(value) {
  return [
    "--source-receipt", value,
    "--corpus-dir", value,
    "--public-key", value,
    "--signature", value,
    "--verifier", value,
    "--validator", value,
    "--validator-artifact", value,
    "--runtime-archive", value,
    "--java-home", value,
    "--generation-root", value,
  ];
}

function expectErrorCode(callback, expectedCode) {
  try {
    callback();
  } catch (error) {
    expect(error).toMatchObject({ code: expectedCode });
    return;
  }
  throw new Error(`expected error code ${expectedCode}`);
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
      execution_limits: {
        signature_verifier: {
          version_preflight: {
            timeout_ms: 30_000,
            term_grace_ms: 500,
          },
        },
        validator: {
          fixture: {
            stdout_max_bytes: 16_777_216,
            stderr_max_bytes: 1_048_576,
            aggregate_max_bytes: 17_825_792,
          },
        },
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

  it("rejects changed, fractional, and recursively extended execution limits", async () => {
    const root = await temporaryDirectory("pdf-tools-igr5-limits-contract-");
    for (const [name, mutate] of [
      ["changed", contract => {
        contract.execution_limits.validator.fixture.timeout_ms += 1;
      }],
      ["fractional", contract => {
        contract.execution_limits.validator.fixture.term_grace_ms = 1.5;
      }],
      ["extended", contract => {
        contract.execution_limits.validator.fixture.kill_wait_ms = 1;
      }],
    ]) {
      const contract = JSON.parse(await fs.readFile(CONTRACT_PATH, "utf8"));
      mutate(contract);
      const candidate = path.join(root, `${name}.json`);
      await fs.writeFile(candidate, JSON.stringify(contract));
      await expect(loadFormalAccessibilityV2Contract(candidate)).rejects.toMatchObject({
        code: name === "extended"
          ? "CONTRACT_SHAPE_INVALID"
          : "CONTRACT_IDENTITY_INVALID",
      });
    }
  });

  it("exact-matches an external source/runtime receipt and rejects source drift", async () => {
    const root = await temporaryDirectory("pdf-tools-igr5-source-receipt-");
    const { receipt, receiptPath } = await createSourceReceipt(root);
    const contractBytes = await fs.readFile(CONTRACT_PATH);
    const verified = await loadAndVerifySourceReceipt(
      receiptPath,
      CONTRACT_PATH,
      sha256(contractBytes)
    );
    expect(verified).toMatchObject({
      receipt_sha256: sha256(await fs.readFile(receiptPath)),
      receipt_size: (await fs.stat(receiptPath)).size,
      verified_files: {
        runner: receipt.files.runner,
        v1_helper: receipt.files.v1_helper,
      },
      verified_node: {
        sha256: receipt.node.executable_sha256,
        size: receipt.node.executable_size,
        version: process.version,
      },
    });

    receipt.files.runner.sha256 = "0".repeat(64);
    const driftedPath = path.join(root, "drifted-source-receipt.json");
    await fs.writeFile(driftedPath, JSON.stringify(receipt), { mode: 0o600 });
    await fs.chmod(driftedPath, 0o600);
    await expect(loadAndVerifySourceReceipt(
      driftedPath,
      CONTRACT_PATH,
      sha256(contractBytes)
    )).rejects.toMatchObject({ code: "INPUT_HASH_MISMATCH" });
  });

  it("fails closed on one-byte key, signature, and installer mutations", () => {
    for (const label of ["public key", "signature", "installer"]) {
      const reviewed = Buffer.from(`${label} reviewed bytes`);
      const digest = sha256(reviewed);
      expect(assertByteIdentity(reviewed, digest, reviewed.length, label)).toBe(true);
      const mutated = Buffer.from(reviewed);
      mutated[0] ^= 1;
      expectErrorCode(
        () => assertByteIdentity(mutated, digest, reviewed.length, label),
        "INPUT_HASH_MISMATCH"
      );
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
    expectErrorCode(() => parseGpgvStatus(status, 0, contract), code);
  });

  it("rejects a different signer, signature time, algorithm, and nonzero exit", async () => {
    const { contract } = await loadFormalAccessibilityV2Contract(CONTRACT_PATH);
    const otherFingerprint = `0${FORMAL_EVIDENCE_V2_OFFICIAL.primaryFingerprint.slice(1)}`;
    expectErrorCode(
      () => parseGpgvStatus(canonicalStatus({ fingerprint: otherFingerprint }), 0, contract),
      "GPG_FINGERPRINT_MISMATCH"
    );
    expectErrorCode(
      () => parseGpgvStatus(canonicalStatus({ timestamp: 1780484181 }), 0, contract),
      "GPG_SIGNATURE_TIME_MISMATCH"
    );

    const weakHash = canonicalStatus().toString("utf8").replace(" 1 10 00 ", " 1 2 00 ");
    expectErrorCode(
      () => parseGpgvStatus(Buffer.from(weakHash), 0, contract),
      "GPG_VALIDSIG_MISMATCH"
    );
    expectErrorCode(
      () => parseGpgvStatus(canonicalStatus(), 1, contract),
      "GPG_EXIT_NONZERO"
    );
  });
});

describe.sequential("bounded process groups", () => {
  it("terminates and closes a timed-out process group", async () => {
    const result = await runBoundedProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      ...boundedOptions({ timeoutMs: 50 }),
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
      ...boundedOptions(),
    });
    expect(result).toMatchObject({
      output_limit_exceeded: true,
      stdout_limit_exceeded: true,
      stderr_limit_exceeded: false,
      termination_attempted: true,
      process_group_empty_after_cleanup: true,
    });
    expect(result.stdout.length).toBeLessThanOrEqual(1024);
  });

  it("kills and reports a stubborn descendant after its leader exits", async () => {
    const script = [
      "const {spawn}=require('node:child_process');",
      "spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});",
      "setTimeout(()=>process.exit(0),200);",
    ].join("");
    const result = await runBoundedProcess(process.execPath, ["-e", script], {
      ...boundedOptions(),
    });
    expect(result).toMatchObject({
      descendant_observed_after_leader_close: true,
      termination_attempted: true,
      term_signal_sent: true,
      kill_signal_sent: true,
      process_group_empty_after_cleanup: true,
    });
  });

  it("enforces stderr and aggregate bounds independently", async () => {
    const stderrFlood = await runBoundedProcess(process.execPath, [
      "-e",
      "process.stderr.write('e'.repeat(4096)); setInterval(() => {}, 1000)",
    ], boundedOptions());
    expect(stderrFlood).toMatchObject({
      stdout_limit_exceeded: false,
      stderr_limit_exceeded: true,
      output_limit_exceeded: true,
      process_group_empty_after_cleanup: true,
    });

    const aggregateFlood = await runBoundedProcess(process.execPath, [
      "-e",
      "process.stdout.write('o'.repeat(800)); process.stderr.write('e'.repeat(800)); setInterval(() => {}, 1000)",
    ], boundedOptions({
      stdoutMaxBytes: 1_024,
      stderrMaxBytes: 1_024,
      aggregateMaxBytes: 1_200,
    }));
    expect(aggregateFlood).toMatchObject({
      stdout_limit_exceeded: false,
      stderr_limit_exceeded: false,
      aggregate_output_limit_exceeded: true,
      output_limit_exceeded: true,
      process_group_empty_after_cleanup: true,
    });
  });
});

describe.sequential("private evidence durability", () => {
  it("creates mode-0700 generations and mode-0600 files under a permissive umask", async () => {
    const root = await temporaryDirectory("pdf-tools-igr5-generation-");
    await fs.chmod(root, 0o700);
    const previousUmask = process.umask(0o000);
    let generation;
    try {
      generation = await preparePrivateGeneration(root);
      expect(await assertPrivateGenerationIdentity(generation)).toBe(true);
      expect((await fs.stat(generation.generation_path)).mode & 0o777).toBe(0o700);
      const receipt = await writePrivateFile(
        generation,
        "evidence.json",
        Buffer.from("private")
      );
      expect(receipt).toMatchObject({
        sha256: sha256(Buffer.from("private")),
        size: 7,
        identity: {
          mode: 0o600,
          nlink: 1,
        },
      });
      expect((await fs.stat(
        path.join(generation.generation_path, "evidence.json")
      )).mode & 0o777).toBe(0o600);
    } finally {
      await closePrivateGeneration(generation);
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
    await fs.chmod(root, 0o700);
    const generation = await preparePrivateGeneration(root);
    try {
      await writePrivateFile(generation, "evidence.json", Buffer.from("existing"));
      await expect(writePrivateFile(
        generation,
        "evidence.json",
        Buffer.from("replacement")
      )).rejects.toMatchObject({ code: "PRIVATE_WRITE_FAILED" });
      expect(await fs.readFile(
        path.join(generation.generation_path, "evidence.json"),
        "utf8"
      )).toBe("existing");

      const outside = path.join(root, "outside");
      await fs.writeFile(outside, "outside");
      await fs.symlink(
        outside,
        path.join(generation.generation_path, "linked.json")
      );
      await expect(writePrivateFile(
        generation,
        "linked.json",
        Buffer.from("replacement")
      )).rejects.toMatchObject({ code: "PRIVATE_WRITE_FAILED" });
      expect(await fs.readFile(outside, "utf8")).toBe("outside");
    } finally {
      await closePrivateGeneration(generation);
    }
  });

  it("detects persistent generation-root retargeting through the retained handle", async () => {
    const base = await temporaryDirectory("pdf-tools-igr5-root-retarget-");
    const root = path.join(base, "root");
    const moved = path.join(base, "root-moved");
    await fs.mkdir(root, { mode: 0o700 });
    const generation = await preparePrivateGeneration(root);
    try {
      await fs.rename(root, moved);
      await fs.mkdir(root, { mode: 0o700 });
      await expect(writePrivateFile(
        generation,
        "must-not-write.json",
        Buffer.from("blocked")
      ))
        .rejects.toMatchObject({ code: "PRIVATE_GENERATION_IDENTITY_DRIFT" });
      expect(await fs.readdir(root)).toEqual([]);
    } finally {
      await closePrivateGeneration(generation);
    }
  });

  it("detects persistent generation-directory replacement through the retained handle", async () => {
    const base = await temporaryDirectory("pdf-tools-igr5-generation-retarget-");
    const root = path.join(base, "root");
    await fs.mkdir(root, { mode: 0o700 });
    const generation = await preparePrivateGeneration(root);
    const moved = `${generation.generation_path}-moved`;
    try {
      await fs.rename(generation.generation_path, moved);
      await fs.mkdir(generation.generation_path, { mode: 0o700 });
      await expect(writePrivateFile(
        generation,
        "must-not-write.json",
        Buffer.from("blocked")
      ))
        .rejects.toMatchObject({ code: "PRIVATE_GENERATION_IDENTITY_DRIFT" });
      expect(await fs.readdir(generation.generation_path)).toEqual([]);
    } finally {
      await closePrivateGeneration(generation);
    }
  });
});

describe("staged fixture attribution", () => {
  it("keeps validator attribution on staged verified bytes after a source-path swap", async () => {
    const root = await temporaryDirectory("pdf-tools-igr5-fixture-stage-");
    const corpus = path.join(root, "corpus");
    const runtimeFixtures = path.join(root, "runtime-fixtures");
    await Promise.all([
      fs.mkdir(corpus, { mode: 0o700 }),
      fs.mkdir(runtimeFixtures, { mode: 0o700 }),
    ]);
    const reviewedBytes = Buffer.from("reviewed fixture bytes");
    const replacementBytes = Buffer.from("replacement source bytes");
    const fixture = {
      id: "synthetic.swap-proof",
      filename: "source.pdf",
      sha256: sha256(reviewedBytes),
      size: reviewedBytes.length,
    };
    const sourcePath = path.join(corpus, fixture.filename);
    await fs.writeFile(sourcePath, reviewedBytes);
    const staged = await stageVerifiedFixture(corpus, runtimeFixtures, fixture);

    await fs.rename(sourcePath, path.join(corpus, "source-original.pdf"));
    await fs.writeFile(sourcePath, replacementBytes);
    expect(await verifyStagedFixture(staged.staged_path, staged.receipt)).toBe(true);
    expect(staged.staged_path).not.toBe(sourcePath);

    const validatorObservation = await runBoundedProcess(
      process.execPath,
      [
        "-e",
        "const fs=require('node:fs');const c=require('node:crypto');const b=fs.readFileSync(process.argv[1]);process.stdout.write(c.createHash('sha256').update(b).digest('hex'));",
        staged.staged_path,
      ],
      boundedOptions()
    );
    expect(validatorObservation.code).toBe(0);
    expect(validatorObservation.stdout.toString("utf8")).toBe(sha256(reviewedBytes));
    expect(sha256(await fs.readFile(sourcePath))).toBe(sha256(replacementBytes));

    await fs.writeFile(staged.staged_path, replacementBytes);
    await expect(verifyStagedFixture(staged.staged_path, staged.receipt))
      .rejects.toMatchObject({ code: "STAGED_FIXTURE_DRIFT" });
  });
});

describe("authenticity sequencing and public projection", () => {
  const linuxX64 = process.platform === "linux" && process.arch === "x64";

  it.runIf(linuxX64)("runs no validator and creates no generation after public-key identity failure", async () => {
    const root = await temporaryDirectory("pdf-tools-igr5-auth-order-");
    const generationRoot = path.join(root, "generations");
    await fs.mkdir(generationRoot, { mode: 0o700 });
    const wrongKey = path.join(root, "wrong-key.asc");
    await fs.writeFile(wrongKey, Buffer.alloc(FORMAL_EVIDENCE_V2_OFFICIAL.publicKeySize));
    const validatorMarker = path.join(root, "validator-called");
    const validator = path.join(root, "validator");
    await fs.writeFile(validator, `#!/bin/sh\n: > '${validatorMarker}'\n`, { mode: 0o755 });
    const { receiptPath: sourceReceiptPath } = await createSourceReceipt(root);

    await expect(runFormalAccessibilityV2Evaluation({
      contractPath: CONTRACT_PATH,
      sourceReceiptPath,
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

  it("orders post-input authenticity before generation creation and validator execution", async () => {
    const source = await fs.readFile(
      path.join(REPO_ROOT, "test", "eval", "accessibility-formal-v2.js"),
      "utf8"
    );
    const orchestration = source.slice(
      source.indexOf("export async function runFormalAccessibilityV2Evaluation")
    );
    const inputIdentity = orchestration.indexOf(
      "const initialIdentity = await captureExecutionIdentity"
    );
    const authenticity = orchestration.indexOf(
      "const authenticity = await verifyInstallerAuthenticity"
    );
    const generation = orchestration.indexOf(
      "const generation = await preparePrivateGeneration"
    );
    const validator = orchestration.indexOf(
      "authenticatedIdentity.validator.resolved"
    );
    expect(inputIdentity).toBeGreaterThan(-1);
    expect(authenticity).toBeGreaterThan(inputIdentity);
    expect(generation).toBeGreaterThan(authenticity);
    expect(validator).toBeGreaterThan(generation);
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

describe("CLI failure privacy", () => {
  const privateMaterial = [
    "/home/operator/accessibility-formal-v2-private-generation",
    "Carl Wilson <techlead@verapdf.org>",
    "[GNUPG:] VALIDSIG RAW-DIAGNOSTIC",
    "BLUEHARBOR-PRIVATE-CANARY",
  ].join(" ");

  function expectClosedFailure(result, expectedCode = null) {
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    const envelope = JSON.parse(result.stderr);
    expect(Object.keys(envelope).sort()).toEqual([
      "code",
      "failure_envelope_version",
      "publication_authorized",
      "result",
    ]);
    expect(envelope).toMatchObject({
      failure_envelope_version: 1,
      publication_authorized: false,
      result: "failed",
      ...(expectedCode ? { code: expectedCode } : {}),
    });
    const combined = `${result.stdout}${result.stderr}`;
    for (const forbidden of [
      "/home/operator",
      "accessibility-formal-v2-private-generation",
      "Carl Wilson",
      "techlead@verapdf.org",
      "[GNUPG:]",
      "RAW-DIAGNOSTIC",
      "BLUEHARBOR-PRIVATE-CANARY",
    ]) {
      expect(combined).not.toContain(forbidden);
    }
  }

  it("maps argument failures to an exact path-free reviewed envelope", () => {
    const result = spawnSync(process.execPath, [CLI_PATH, "--unknown", privateMaterial], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expectClosedFailure(result, "ARGUMENT_INVALID");
  });

  it("does not expose private inputs through a known runtime failure", () => {
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, ...completeCliArguments(privateMaterial)],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
    expectClosedFailure(result);
  });

  it("maps an unknown dynamic-import failure to the generic code without details", async () => {
    const root = await temporaryDirectory("pdf-tools-igr5-cli-unknown-");
    const scripts = path.join(root, "scripts");
    await fs.mkdir(scripts, { mode: 0o700 });
    const copiedCli = path.join(scripts, "copied-cli.mjs");
    await fs.copyFile(CLI_PATH, copiedCli);
    const result = spawnSync(
      process.execPath,
      [copiedCli, ...completeCliArguments(privateMaterial)],
      { cwd: root, encoding: "utf8" }
    );
    expectClosedFailure(result, "EVALUATION_FAILED");
  });
});
