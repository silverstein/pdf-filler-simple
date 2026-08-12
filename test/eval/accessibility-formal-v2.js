import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fileConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFormalRunnerEnvironment,
  computeInstalledTreeDigest,
  parseVeraPdfEvidence,
} from "./accessibility-formal.js";

export const FORMAL_EVIDENCE_V2_RUNNER_VERSION = 3;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const V2_SOURCE_PATHS = Object.freeze({
  cli: "scripts/eval-run-accessibility-formal-v2.mjs",
  runner: "test/eval/accessibility-formal-v2.js",
  v1_helper: "test/eval/accessibility-formal.js",
  contract: "test/fixtures/eval/accessibility/formal-corpus.v2.json",
});
const SOURCE_RECEIPT_CAPTURE_METHOD = "external_supervisor_git_sha256_node_identity_v1";
const PROCESS_LIMIT_KEYS = Object.freeze([
  "timeout_ms",
  "stdout_max_bytes",
  "stderr_max_bytes",
  "aggregate_max_bytes",
  "term_grace_ms",
  "group_empty_timeout_ms",
]);
const REVIEWED_EXECUTION_LIMITS = Object.freeze({
  signature_verifier: Object.freeze({
    version_preflight: Object.freeze({
      timeout_ms: 30_000,
      stdout_max_bytes: 65_536,
      stderr_max_bytes: 65_536,
      aggregate_max_bytes: 131_072,
      term_grace_ms: 500,
      group_empty_timeout_ms: 2_000,
    }),
    signature_verification: Object.freeze({
      timeout_ms: 30_000,
      stdout_max_bytes: 1_048_576,
      stderr_max_bytes: 1_048_576,
      aggregate_max_bytes: 2_097_152,
      term_grace_ms: 500,
      group_empty_timeout_ms: 2_000,
    }),
  }),
  validator: Object.freeze({
    version_preflight: Object.freeze({
      timeout_ms: 60_000,
      stdout_max_bytes: 1_048_576,
      stderr_max_bytes: 1_048_576,
      aggregate_max_bytes: 2_097_152,
      term_grace_ms: 1_000,
      group_empty_timeout_ms: 2_000,
    }),
    fixture: Object.freeze({
      timeout_ms: 60_000,
      stdout_max_bytes: 16_777_216,
      stderr_max_bytes: 1_048_576,
      aggregate_max_bytes: 17_825_792,
      term_grace_ms: 1_000,
      group_empty_timeout_ms: 2_000,
    }),
  }),
});
export const FORMAL_EVIDENCE_V2_OFFICIAL = Object.freeze({
  documentationUrl: "https://docs.verapdf.org/install/",
  publicKeyUrl: "https://software.verapdf.org/keys/KEY",
  publicKeySha256: "30f1dc7fb7c9f3d9796dd9f9dd5d344ebbcf45bef9632d9c47c39cdf254249f2",
  publicKeySize: 5613,
  primaryFingerprint: "13DD102B4DD69354D12DE5A83184863278B17FE7",
  signatureUrl: "https://software.verapdf.org/releases/1.30/verapdf-greenfield-1.30.2-installer.zip.asc",
  signatureSha256: "f33175e402f28c42e80866aa62aa337c5d7d7a16a4ea1ae4ff50b0f13343ff26",
  signatureSize: 659,
  signatureDate: "2026-06-03",
  signatureTimestampEpoch: 1780484180,
  installerUrl: "https://software.verapdf.org/releases/1.30/verapdf-greenfield-1.30.2-installer.zip",
  installerSha256: "6cc6341cb1af644044054b81f00a6590a7918abb18f762243de115258bcad838",
  wrapperSha256: "ea4d7949a4c9e5939e3419d03f9610920f1d7b761bc5599a38facbddea28ae09",
  cliJarSha256: "889075253fb9df4db5482efb8f8208fb3b4f2e00f5f7e1b1e31edf6fb4b69bb6",
  validatorTreeSha256: "1913b10b5c221183bb77bb607359cc7ab454e11d05fcea2d5e34e7d294fd7c6c",
  runtimeArchiveSha256: "e5038aae3ca9ff670bc696496b0728dbd23d280026bad30291cb919221ecfdcb",
  javaSha256: "fd85538801d8ca61d3558c87a57a600e1868d8ac9e918d0860dd64281b548643",
  runtimeTreeSha256: "2007f90798f2de64526e2e6f31a4cc43afab042477f1cacc643cbf13d00372d4",
  corpusCommit: "49de56cd987929932c9e4fbbbe67d052bf44ef83",
  gpgvPath: "/usr/bin/gpgv",
  gpgvSha256: "097b577cdf8b51dcc1fb42417d5ef3ca2e22b36a8ad16c9df4bd083a38fe476c",
  gpgvVersionLine: "gpgv (GnuPG) 2.4.4",
});

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9.-]+$/;
const REVIEWED_FIXTURES = Object.freeze({
  "verapdf.ua1.5-t01-pass-a": Object.freeze({
    filename: "5-t01-pass-a.pdf",
    sourcePath: "PDF_UA-1/5 Version identification/5-t01-pass-a.pdf",
    sourceUrl: "https://raw.githubusercontent.com/veraPDF/veraPDF-corpus/49de56cd987929932c9e4fbbbe67d052bf44ef83/PDF_UA-1/5%20Version%20identification/5-t01-pass-a.pdf",
    sha256: "853fc52f5dca32dd257cac1da4ca9c1702623e357b48a361f835c4f271bd2c68",
    size: 42497,
    expectedMachineCompliant: true,
    expectedFailedRuleKeys: Object.freeze([]),
  }),
  "verapdf.ua1.5-t01-fail-a": Object.freeze({
    filename: "5-t01-fail-a.pdf",
    sourcePath: "PDF_UA-1/5 Version identification/5-t01-fail-a.pdf",
    sourceUrl: "https://raw.githubusercontent.com/veraPDF/veraPDF-corpus/49de56cd987929932c9e4fbbbe67d052bf44ef83/PDF_UA-1/5%20Version%20identification/5-t01-fail-a.pdf",
    sha256: "33d9008d84746cb8cf7cf11f50d8e67a97b3640978d845050e18ee47bfb95310",
    size: 38394,
    expectedMachineCompliant: false,
    expectedFailedRuleKeys: Object.freeze(["ISO 14289-1:2014#5#1"]),
  }),
});
const REVIEWED_REPAIR_GUIDANCE = Object.freeze({
  safeGuidance: "Inspect whether the document metadata contains the PDF/UA identification schema required for the intended PDF/UA edition, correct it with a standards-aware workflow, then rerun complete machine and human review on the new document hash.",
  limitations: Object.freeze([
    "Adding identification metadata alone does not make a document conformant or accessible.",
    "The pilot does not attempt repair and does not copy normative standards text.",
    "Evidence for the original document hash cannot transfer to a repaired file.",
  ]),
});
const FATAL_GPG_STATUS = new Set([
  "BADSIG",
  "ERRSIG",
  "EXPSIG",
  "EXPKEYSIG",
  "REVKEYSIG",
  "NO_PUBKEY",
  "NODATA",
  "FAILURE",
  "ERROR",
]);
const EXPECTED_GPG_STATUS_SEQUENCE = Object.freeze([
  "NEWSIG",
  "KEY_CONSIDERED",
  "SIG_ID",
  "GOODSIG",
  "VALIDSIG",
]);
const PUBLIC_PROJECTION_KEYS = Object.freeze([
  "projection_version",
  "publication_authorized",
  "bounded_installer_claim",
  "authenticity",
  "validator",
  "pilot",
  "claim_boundary",
  "private_evidence",
  "limitations",
]);

export class FormalEvidenceV2Error extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FormalEvidenceV2Error";
    this.code = code;
  }
}

function fail(code, message) {
  throw new FormalEvidenceV2Error(code, message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertByteIdentity(bytes, expectedSha256, expectedSize, label = "input") {
  if (expectedSize !== null && bytes.length !== expectedSize) {
    fail("INPUT_SIZE_MISMATCH", `${label} size does not match the reviewed identity`);
  }
  if (sha256(bytes) !== expectedSha256) {
    fail("INPUT_HASH_MISMATCH", `${label} SHA-256 does not match the reviewed identity`);
  }
  return true;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("CONTRACT_SHAPE_INVALID", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("CONTRACT_SHAPE_INVALID", `${label} must contain exactly the reviewed keys`);
  }
}

function exactValue(actual, expected, label) {
  if (actual !== expected) {
    fail("CONTRACT_IDENTITY_INVALID", `${label} does not match the reviewed v2 identity`);
  }
}

function validateV2Contract(contract) {
  exactKeys(contract, [
    "contract_version",
    "corpus_version",
    "evidence_runner_version",
    "provenance",
    "signature_verifier",
    "execution_limits",
    "validator",
    "runtime",
    "corpus",
    "fixtures",
    "repair_guidance_assessment",
    "claim_boundary",
  ], "formal v2 contract");
  exactValue(contract.contract_version, 2, "contract_version");
  exactValue(contract.corpus_version, "v0.1.0", "corpus_version");
  exactValue(contract.evidence_runner_version, FORMAL_EVIDENCE_V2_RUNNER_VERSION, "evidence_runner_version");

  const provenance = contract.provenance;
  exactKeys(provenance, [
    "official_verification_documentation_url",
    "public_key_url",
    "public_key_sha256",
    "public_key_size",
    "primary_fingerprint",
    "signature_url",
    "signature_sha256",
    "signature_size",
    "signature_date",
    "signature_timestamp_epoch",
    "authenticity_requirement",
  ], "provenance");
  exactValue(provenance.official_verification_documentation_url, FORMAL_EVIDENCE_V2_OFFICIAL.documentationUrl,
    "official verification documentation URL");
  exactValue(provenance.public_key_url, FORMAL_EVIDENCE_V2_OFFICIAL.publicKeyUrl, "public key URL");
  exactValue(provenance.public_key_sha256, FORMAL_EVIDENCE_V2_OFFICIAL.publicKeySha256, "public key SHA-256");
  exactValue(provenance.public_key_size, FORMAL_EVIDENCE_V2_OFFICIAL.publicKeySize, "public key size");
  exactValue(provenance.primary_fingerprint, FORMAL_EVIDENCE_V2_OFFICIAL.primaryFingerprint,
    "primary fingerprint");
  exactValue(provenance.signature_url, FORMAL_EVIDENCE_V2_OFFICIAL.signatureUrl, "signature URL");
  exactValue(provenance.signature_sha256, FORMAL_EVIDENCE_V2_OFFICIAL.signatureSha256, "signature SHA-256");
  exactValue(provenance.signature_size, FORMAL_EVIDENCE_V2_OFFICIAL.signatureSize, "signature size");
  exactValue(provenance.signature_date, FORMAL_EVIDENCE_V2_OFFICIAL.signatureDate, "signature date");
  exactValue(provenance.signature_timestamp_epoch, FORMAL_EVIDENCE_V2_OFFICIAL.signatureTimestampEpoch,
    "signature timestamp");
  exactValue(provenance.authenticity_requirement,
    "verified_against_exact_officially_published_key_before_validator_execution",
    "authenticity requirement");
  const verifier = contract.signature_verifier;
  exactKeys(verifier, [
    "name",
    "version_line",
    "executable_path",
    "executable_sha256",
    "license_spdx_id",
    "bundled",
  ], "signature_verifier");
  exactValue(verifier.name, "gpgv", "signature verifier name");
  exactValue(verifier.version_line, FORMAL_EVIDENCE_V2_OFFICIAL.gpgvVersionLine, "signature verifier version");
  exactValue(verifier.executable_path, FORMAL_EVIDENCE_V2_OFFICIAL.gpgvPath, "signature verifier path");
  exactValue(verifier.executable_sha256, FORMAL_EVIDENCE_V2_OFFICIAL.gpgvSha256,
    "signature verifier SHA-256");
  exactValue(verifier.license_spdx_id, "GPL-3.0-or-later", "signature verifier license");
  exactValue(verifier.bundled, false, "signature verifier bundled state");

  const limits = contract.execution_limits;
  exactKeys(limits, ["signature_verifier", "validator"], "execution_limits");
  exactKeys(limits.signature_verifier, ["version_preflight", "signature_verification"],
    "execution_limits.signature_verifier");
  exactKeys(limits.validator, ["version_preflight", "fixture"], "execution_limits.validator");
  for (const [family, operations] of Object.entries(REVIEWED_EXECUTION_LIMITS)) {
    for (const [operation, reviewed] of Object.entries(operations)) {
      const actual = limits[family][operation];
      exactKeys(actual, PROCESS_LIMIT_KEYS, `execution_limits.${family}.${operation}`);
      for (const key of PROCESS_LIMIT_KEYS) {
        if (!Number.isSafeInteger(actual[key]) || actual[key] < 1 || actual[key] > 60_000_000) {
          fail("CONTRACT_IDENTITY_INVALID",
            `execution_limits.${family}.${operation}.${key} must be a bounded positive integer`);
        }
        exactValue(actual[key], reviewed[key],
          `execution_limits.${family}.${operation}.${key}`);
      }
      if (actual.aggregate_max_bytes < actual.stdout_max_bytes
        || actual.aggregate_max_bytes < actual.stderr_max_bytes) {
        fail("CONTRACT_IDENTITY_INVALID",
          `execution_limits.${family}.${operation} aggregate limit is inconsistent`);
      }
    }
  }

  const validator = contract.validator;
  exactKeys(validator, [
    "name",
    "version",
    "profile",
    "profile_name",
    "release_date",
    "release_page",
    "installer_url",
    "installer_sha256",
    "installed_wrapper_sha256",
    "installed_cli_jar_sha256",
    "installed_tree_sha256",
    "expected_exit_codes",
    "license_options",
    "bundled",
  ], "validator");
  exactValue(validator.name, "veraPDF Greenfield CLI", "validator name");
  exactValue(validator.version, "1.30.2", "validator version");
  exactValue(validator.profile, "ua1", "validator profile");
  exactValue(validator.profile_name, "PDF/UA-1 validation profile", "validator profile name");
  exactValue(validator.release_date, "2026-06-03", "validator release date");
  exactValue(validator.release_page, "https://software.verapdf.org/releases/1.30",
    "validator release page");
  exactValue(validator.installer_url, FORMAL_EVIDENCE_V2_OFFICIAL.installerUrl, "installer URL");
  exactValue(validator.installer_sha256, FORMAL_EVIDENCE_V2_OFFICIAL.installerSha256, "installer SHA-256");
  exactValue(validator.installed_wrapper_sha256, FORMAL_EVIDENCE_V2_OFFICIAL.wrapperSha256,
    "installed wrapper SHA-256");
  exactValue(validator.installed_cli_jar_sha256, FORMAL_EVIDENCE_V2_OFFICIAL.cliJarSha256,
    "installed CLI JAR SHA-256");
  exactValue(validator.installed_tree_sha256, FORMAL_EVIDENCE_V2_OFFICIAL.validatorTreeSha256,
    "installed validator tree SHA-256");
  exactKeys(validator.expected_exit_codes, ["compliant", "non_compliant"], "validator expected_exit_codes");
  exactValue(validator.expected_exit_codes.compliant, 0, "compliant exit code");
  exactValue(validator.expected_exit_codes.non_compliant, 1, "non-compliant exit code");
  if (JSON.stringify(validator.license_options) !== JSON.stringify(["GPL-3.0-or-later", "MPL-2.0-or-later"])) {
    fail("CONTRACT_IDENTITY_INVALID", "validator license options must remain reviewed and ordered");
  }
  exactValue(validator.bundled, false, "validator bundled state");

  const runtime = contract.runtime;
  exactKeys(runtime, [
    "name",
    "version",
    "platform",
    "source_url",
    "archive_sha256",
    "java_binary_sha256",
    "installed_tree_sha256",
    "bundled",
  ], "runtime");
  exactValue(runtime.name, "Eclipse Temurin JRE", "runtime name");
  exactValue(runtime.version, "21.0.11+10", "runtime version");
  exactValue(runtime.platform, "linux-x64", "runtime platform");
  exactValue(runtime.source_url,
    "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.11%2B10/OpenJDK21U-jre_x64_linux_hotspot_21.0.11_10.tar.gz",
    "runtime source URL");
  exactValue(runtime.archive_sha256, FORMAL_EVIDENCE_V2_OFFICIAL.runtimeArchiveSha256,
    "runtime archive SHA-256");
  exactValue(runtime.java_binary_sha256, FORMAL_EVIDENCE_V2_OFFICIAL.javaSha256,
    "Java binary SHA-256");
  exactValue(runtime.installed_tree_sha256, FORMAL_EVIDENCE_V2_OFFICIAL.runtimeTreeSha256,
    "installed runtime tree SHA-256");
  exactValue(runtime.bundled, false, "runtime bundled state");

  const corpus = contract.corpus;
  exactKeys(corpus, [
    "name",
    "repository",
    "commit",
    "commit_url",
    "license_name",
    "license_spdx_id",
    "license_url",
    "redistribution",
    "privacy",
    "committed",
  ], "corpus");
  exactValue(corpus.license_spdx_id, "CC-BY-4.0", "corpus license");
  exactValue(corpus.name, "veraPDF PDF/UA-1 atomic test corpus", "corpus name");
  exactValue(corpus.repository, "https://github.com/veraPDF/veraPDF-corpus", "corpus repository");
  exactValue(corpus.redistribution, "allowed", "corpus redistribution");
  exactValue(corpus.privacy, "public_test_fixture_no_personal_data", "corpus privacy");
  exactValue(corpus.committed, false, "corpus committed state");
  exactValue(corpus.commit, FORMAL_EVIDENCE_V2_OFFICIAL.corpusCommit, "corpus commit");
  exactValue(corpus.commit_url,
    `https://github.com/veraPDF/veraPDF-corpus/commit/${FORMAL_EVIDENCE_V2_OFFICIAL.corpusCommit}`,
    "corpus commit URL");
  exactValue(corpus.license_name, "Creative Commons Attribution 4.0 International",
    "corpus license name");
  exactValue(corpus.license_url,
    `https://github.com/veraPDF/veraPDF-corpus/blob/${FORMAL_EVIDENCE_V2_OFFICIAL.corpusCommit}/README.md`,
    "corpus license URL");

  if (!Array.isArray(contract.fixtures) || contract.fixtures.length !== 2) {
    fail("CONTRACT_SHAPE_INVALID", "v2 must retain exactly the reviewed two-file pilot");
  }
  const fixtureIds = new Set();
  for (const fixture of contract.fixtures) {
    exactKeys(fixture, [
      "id",
      "filename",
      "source_path",
      "source_url",
      "sha256",
      "size",
      "expected_machine_compliant",
      "expected_failed_rule_keys",
      "rule_family",
    ], "formal fixture");
    if (!SAFE_ID.test(fixture.id ?? "") || fixtureIds.has(fixture.id)) {
      fail("CONTRACT_SHAPE_INVALID", "fixture IDs must be unique and path-safe");
    }
    fixtureIds.add(fixture.id);
    if (typeof fixture.filename !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.pdf$/.test(fixture.filename)
      || path.posix.basename(fixture.filename) !== fixture.filename
      || path.win32.basename(fixture.filename) !== fixture.filename) {
      fail("CONTRACT_SHAPE_INVALID", `${fixture.id} filename must be a safe PDF basename`);
    }
    if (!SHA256.test(fixture.sha256 ?? "") || !Number.isInteger(fixture.size) || fixture.size < 1) {
      fail("CONTRACT_IDENTITY_INVALID", `${fixture.id} must pin byte identity`);
    }
    if (!/^https:\/\/raw\.githubusercontent\.com\/veraPDF\/veraPDF-corpus\//.test(fixture.source_url ?? "")) {
      fail("CONTRACT_IDENTITY_INVALID", `${fixture.id} must use the reviewed veraPDF corpus source`);
    }
    if (!Array.isArray(fixture.expected_failed_rule_keys)
      || new Set(fixture.expected_failed_rule_keys).size !== fixture.expected_failed_rule_keys.length) {
      fail("CONTRACT_SHAPE_INVALID", `${fixture.id} failed-rule keys must be a unique array`);
    }
    if (fixture.rule_family !== "version_identification"
      || (fixture.expected_machine_compliant && fixture.expected_failed_rule_keys.length !== 0)
      || (!fixture.expected_machine_compliant && fixture.expected_failed_rule_keys.length === 0)) {
      fail("CONTRACT_IDENTITY_INVALID", `${fixture.id} expectation is outside the reviewed pilot`);
    }
    const reviewed = REVIEWED_FIXTURES[fixture.id];
    if (!reviewed
      || fixture.filename !== reviewed.filename
      || fixture.source_path !== reviewed.sourcePath
      || fixture.source_url !== reviewed.sourceUrl
      || fixture.sha256 !== reviewed.sha256
      || fixture.size !== reviewed.size
      || fixture.expected_machine_compliant !== reviewed.expectedMachineCompliant
      || JSON.stringify(fixture.expected_failed_rule_keys) !== JSON.stringify(reviewed.expectedFailedRuleKeys)) {
      fail("CONTRACT_IDENTITY_INVALID", `${fixture.id} does not match the frozen v1 fixture identity`);
    }
  }
  if (!contract.fixtures.some(fixture => fixture.expected_machine_compliant)
    || !contract.fixtures.some(fixture => !fixture.expected_machine_compliant)) {
    fail("CONTRACT_IDENTITY_INVALID", "v2 pilot must retain one known-good and one known-defect fixture");
  }

  exactKeys(contract.repair_guidance_assessment, [
    "rule_family",
    "status",
    "safe_guidance",
    "limitations",
  ], "repair_guidance_assessment");
  exactValue(contract.repair_guidance_assessment.rule_family, "version_identification",
    "repair guidance rule family");
  exactValue(contract.repair_guidance_assessment.status, "bounded_diagnostic_only",
    "repair guidance status");
  exactValue(contract.repair_guidance_assessment.safe_guidance, REVIEWED_REPAIR_GUIDANCE.safeGuidance,
    "repair safe guidance");
  if (JSON.stringify(contract.repair_guidance_assessment.limitations)
    !== JSON.stringify(REVIEWED_REPAIR_GUIDANCE.limitations)) {
    fail("CONTRACT_IDENTITY_INVALID", "repair guidance limitations must remain reviewed and ordered");
  }

  const claims = contract.claim_boundary;
  exactKeys(claims, [
    "bounded_installer_claim",
    "machine_validation_scope",
    "pdfua_conformance",
    "wcag_conformance",
    "legal_compliance",
    "certification",
    "publication_authorized",
  ], "claim_boundary");
  exactValue(claims.bounded_installer_claim,
    "The pinned veraPDF installer signature was verified against the exact OpenPGP key and fingerprint published by veraPDF's official installation documentation.",
    "bounded installer claim");
  exactValue(claims.machine_validation_scope, "two_file_pdfua1_version_identification_pilot_only",
    "machine validation scope");
  for (const field of ["pdfua_conformance", "wcag_conformance", "legal_compliance", "certification"]) {
    exactValue(claims[field], "not_established", `claim_boundary.${field}`);
  }
  exactValue(claims.publication_authorized, false, "claim publication authorization");
}

async function regularFile(filePath, label) {
  let entry;
  try {
    entry = await fs.lstat(filePath);
  } catch {
    fail("INPUT_IDENTITY_UNAVAILABLE", `${label} is unavailable`);
  }
  if (entry.isSymbolicLink()) fail("INPUT_SYMLINK_REJECTED", `${label} must not be a symbolic link`);
  const resolved = await fs.realpath(filePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) fail("INPUT_NOT_REGULAR", `${label} must be a regular file`);
  return resolved;
}

async function readExactFile(filePath, label, expectedSha256, expectedSize = null, retainBytes = false) {
  const resolved = await regularFile(filePath, label);
  const handle = await fs.open(resolved, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
  let size;
  let digest;
  let retained;
  try {
    const stat = await handle.stat();
    size = stat.size;
    if (expectedSize !== null && size !== expectedSize) {
      fail("INPUT_SIZE_MISMATCH", `${label} size does not match the reviewed identity`);
    }
    const hash = createHash("sha256");
    if (retainBytes) {
      retained = await handle.readFile();
      hash.update(retained);
    } else {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let bytesRead;
      do {
        ({ bytesRead } = await handle.read(buffer, 0, buffer.length, null));
        if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
      } while (bytesRead > 0);
    }
    digest = hash.digest("hex");
  } finally {
    await handle.close();
  }
  if (retainBytes) {
    assertByteIdentity(retained, expectedSha256, expectedSize, label);
  } else if (digest !== expectedSha256) {
    fail("INPUT_HASH_MISMATCH", `${label} SHA-256 does not match the reviewed identity`);
  }
  return { bytes: retained, resolved, sha256: expectedSha256, size };
}

export async function loadFormalAccessibilityV2Contract(contractPath) {
  const resolved = await regularFile(contractPath, "formal accessibility v2 contract");
  const bytes = await fs.readFile(resolved);
  let contract;
  try {
    contract = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("CONTRACT_JSON_INVALID", "formal accessibility v2 contract is not valid JSON");
  }
  validateV2Contract(contract);
  return {
    contract,
    contract_path: resolved,
    contract_sha256: sha256(bytes),
  };
}

function validateSourceFileReceipt(entry, expectedRelativePath, label) {
  exactKeys(entry, ["relative_path", "sha256", "size"], label);
  exactValue(entry.relative_path, expectedRelativePath, `${label}.relative_path`);
  if (!SHA256.test(entry.sha256 ?? "")
    || !Number.isSafeInteger(entry.size)
    || entry.size < 1) {
    fail("SOURCE_RECEIPT_INVALID", `${label} must contain an exact SHA-256 and size`);
  }
}

export async function loadAndVerifySourceReceipt(sourceReceiptPath, contractPath, contractSha256) {
  const resolvedReceipt = await regularFile(sourceReceiptPath, "external source receipt");
  const receiptHandle = await fs.open(
    resolvedReceipt,
    fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW
  );
  let receiptBytes;
  let receiptIdentity;
  try {
    const receiptStat = await receiptHandle.stat();
    if (!receiptStat.isFile()
      || receiptStat.nlink !== 1
      || (receiptStat.mode & 0o777) !== 0o600
      || receiptStat.size < 1
      || receiptStat.size > 65_536
      || (typeof process.geteuid === "function" && receiptStat.uid !== process.geteuid())) {
      fail("SOURCE_RECEIPT_INVALID",
        "external source receipt must be an owned mode-0600 single-link file");
    }
    receiptIdentity = filesystemIdentity(receiptStat);
    receiptBytes = await receiptHandle.readFile();
  } finally {
    await receiptHandle.close();
  }
  const receiptPathStat = await fs.lstat(resolvedReceipt);
  if (receiptPathStat.isSymbolicLink()
    || !receiptPathStat.isFile()
    || !sameFilesystemIdentity(receiptPathStat, receiptIdentity)) {
    fail("SOURCE_RECEIPT_INVALID", "external source receipt identity changed while reading");
  }
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes.toString("utf8"));
  } catch {
    fail("SOURCE_RECEIPT_INVALID", "external source receipt is not valid JSON");
  }
  exactKeys(receipt, [
    "receipt_version",
    "receipt_kind",
    "publication_authorized",
    "captured_at",
    "capture_method",
    "repository",
    "files",
    "node",
  ], "external source receipt");
  exactValue(receipt.receipt_version, 1, "source receipt version");
  exactValue(receipt.receipt_kind, "pdf_tools_accessibility_formal_v2_source_runtime",
    "source receipt kind");
  exactValue(receipt.publication_authorized, false, "source receipt publication authorization");
  exactValue(receipt.capture_method, SOURCE_RECEIPT_CAPTURE_METHOD, "source receipt capture method");
  if (typeof receipt.captured_at !== "string"
    || !Number.isFinite(Date.parse(receipt.captured_at))
    || new Date(receipt.captured_at).toISOString() !== receipt.captured_at) {
    fail("SOURCE_RECEIPT_INVALID", "source receipt captured_at must be canonical UTC ISO-8601");
  }

  exactKeys(receipt.repository, ["commit", "tree", "clean_attested"],
    "source receipt repository");
  if (!/^[a-f0-9]{40}$/.test(receipt.repository.commit ?? "")
    || !/^[a-f0-9]{40}$/.test(receipt.repository.tree ?? "")
    || receipt.repository.clean_attested !== true) {
    fail("SOURCE_RECEIPT_INVALID",
      "source receipt must attest an exact Git commit, tree, and clean worktree");
  }

  exactKeys(receipt.files, Object.keys(V2_SOURCE_PATHS), "source receipt files");
  for (const [name, relativePath] of Object.entries(V2_SOURCE_PATHS)) {
    validateSourceFileReceipt(receipt.files[name], relativePath, `source receipt files.${name}`);
  }
  exactKeys(receipt.node, [
    "executable_realpath",
    "executable_sha256",
    "executable_size",
    "version",
  ], "source receipt Node runtime");
  if (typeof receipt.node.executable_realpath !== "string"
    || !path.isAbsolute(receipt.node.executable_realpath)
    || !SHA256.test(receipt.node.executable_sha256 ?? "")
    || !Number.isSafeInteger(receipt.node.executable_size)
    || receipt.node.executable_size < 1
    || !/^v\d+\.\d+\.\d+$/.test(receipt.node.version ?? "")) {
    fail("SOURCE_RECEIPT_INVALID", "source receipt Node runtime identity is invalid");
  }

  const expectedContractPath = path.join(REPO_ROOT, V2_SOURCE_PATHS.contract);
  const resolvedContractPath = await regularFile(contractPath, "formal accessibility v2 contract");
  exactValue(resolvedContractPath, expectedContractPath, "qualification contract path");
  exactValue(receipt.files.contract.sha256, contractSha256, "source receipt contract SHA-256");

  const verifiedFiles = {};
  for (const [name, relativePath] of Object.entries(V2_SOURCE_PATHS)) {
    const entry = receipt.files[name];
    const current = await readExactFile(
      path.join(REPO_ROOT, relativePath),
      `source receipt ${name}`,
      entry.sha256,
      entry.size
    );
    verifiedFiles[name] = {
      relative_path: relativePath,
      sha256: current.sha256,
      size: current.size,
    };
  }
  const nodeRealpath = await fs.realpath(process.execPath);
  exactValue(nodeRealpath, receipt.node.executable_realpath, "source receipt Node executable realpath");
  exactValue(process.version, receipt.node.version, "source receipt Node version");
  const verifiedNode = await readExactFile(
    nodeRealpath,
    "source receipt Node executable",
    receipt.node.executable_sha256,
    receipt.node.executable_size
  );

  return {
    receipt,
    receipt_bytes: receiptBytes,
    receipt_path: resolvedReceipt,
    receipt_sha256: sha256(receiptBytes),
    receipt_size: receiptBytes.length,
    verified_files: verifiedFiles,
    verified_node: {
      sha256: verifiedNode.sha256,
      size: verifiedNode.size,
      version: process.version,
    },
  };
}

function crc24(bytes) {
  let crc = 0xB704CE;
  for (const byte of bytes) {
    crc ^= byte << 16;
    for (let bit = 0; bit < 8; bit += 1) {
      crc <<= 1;
      if (crc & 0x1000000) crc ^= 0x1864CFB;
    }
  }
  return crc & 0xFFFFFF;
}

export function dearmorPublicKey(publicKeyBytes) {
  const text = publicKeyBytes.toString("ascii");
  if (!Buffer.from(text, "ascii").equals(publicKeyBytes)) {
    fail("PUBLIC_KEY_ARMOR_INVALID", "public key armor must be ASCII");
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== "-----BEGIN PGP PUBLIC KEY BLOCK-----"
    || lines.at(-1) !== "-----END PGP PUBLIC KEY BLOCK-----"
    || lines[1] !== "") {
    fail("PUBLIC_KEY_ARMOR_INVALID", "public key armor boundaries are invalid");
  }
  const crcLine = lines.at(-2);
  const bodyLines = lines.slice(2, -2);
  if (!/^=[A-Za-z0-9+/]{4}$/.test(crcLine ?? "")
    || bodyLines.length === 0
    || bodyLines.some(line => !/^[A-Za-z0-9+/]+={0,2}$/.test(line))) {
    fail("PUBLIC_KEY_ARMOR_INVALID", "public key armor body or checksum is malformed");
  }
  const body = bodyLines.join("");
  const decoded = Buffer.from(body, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== body) {
    fail("PUBLIC_KEY_ARMOR_INVALID", "public key armor is not canonical base64");
  }
  const expectedCrc = Buffer.from(crcLine.slice(1), "base64");
  if (expectedCrc.length !== 3 || expectedCrc.readUIntBE(0, 3) !== crc24(decoded)) {
    fail("PUBLIC_KEY_ARMOR_INVALID", "public key armor checksum does not match");
  }
  return decoded;
}

function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    fail("PROCESS_GROUP_INSPECTION_FAILED", "child process group could not be inspected");
  }
}

function signalProcessGroup(processGroupId, signal) {
  if (!Number.isInteger(processGroupId) || processGroupId < 1) {
    return "invalid_process_group";
  }
  try {
    process.kill(-processGroupId, signal);
    return null;
  } catch (error) {
    return error.code === "ESRCH" ? null : (error.code ?? "unknown");
  }
}

async function waitForEmptyProcessGroup(processGroupId, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (processGroupExists(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return true;
}

export function runBoundedProcess(command, args, {
  env,
  cwd,
  timeoutMs = 60_000,
  stdoutMaxBytes = 16 * 1024 * 1024,
  stderrMaxBytes = 1024 * 1024,
  aggregateMaxBytes = 17 * 1024 * 1024,
  termGraceMs = 1_000,
  groupEmptyTimeoutMs = 2_000,
} = {}) {
  for (const [label, value] of Object.entries({
    timeoutMs,
    stdoutMaxBytes,
    stderrMaxBytes,
    aggregateMaxBytes,
    termGraceMs,
    groupEmptyTimeoutMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 60_000_000) {
      fail("PROCESS_LIMIT_INVALID", `${label} must be a bounded positive integer`);
    }
  }
  if (aggregateMaxBytes < stdoutMaxBytes || aggregateMaxBytes < stderrMaxBytes) {
    fail("PROCESS_LIMIT_INVALID", "aggregate output limit must cover each channel limit");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const processGroupId = child.pid;
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let aggregateBytes = 0;
    let timedOut = false;
    let stdoutLimitExceeded = false;
    let stderrLimitExceeded = false;
    let aggregateLimitExceeded = false;
    let terminationAttempted = false;
    let termSignalFailure = null;
    let killSignalFailure = null;
    let termSignalSent = false;
    let killSignalSent = false;
    let termDeadline = null;
    let escalationTimer = null;
    let settled = false;

    const sendKill = () => {
      if (killSignalSent) return;
      killSignalSent = true;
      killSignalFailure = signalProcessGroup(processGroupId, "SIGKILL");
    };
    const terminate = reason => {
      if (terminationAttempted) return;
      terminationAttempted = true;
      if (reason === "timeout") timedOut = true;
      termSignalSent = true;
      termSignalFailure = signalProcessGroup(processGroupId, "SIGTERM");
      termDeadline = Date.now() + termGraceMs;
      escalationTimer = setTimeout(sendKill, termGraceMs);
    };
    const timer = setTimeout(() => terminate("timeout"), timeoutMs);
    const collect = (target, channel) => chunk => {
      if (channel === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      aggregateBytes += chunk.length;
      if (stdoutBytes > stdoutMaxBytes) stdoutLimitExceeded = true;
      if (stderrBytes > stderrMaxBytes) stderrLimitExceeded = true;
      if (aggregateBytes > aggregateMaxBytes) aggregateLimitExceeded = true;
      if (stdoutLimitExceeded || stderrLimitExceeded || aggregateLimitExceeded) {
        terminate("output_limit");
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", collect(stdout, "stdout"));
    child.stderr.on("data", collect(stderr, "stderr"));
    child.on("error", error => {
      clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (!settled) {
        settled = true;
        reject(new FormalEvidenceV2Error("PROCESS_SPAWN_FAILED", `bounded child failed to spawn: ${error.code ?? "unknown"}`));
      }
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      try {
        const descendantObserved = processGroupExists(processGroupId);
        if (descendantObserved) {
          if (!terminationAttempted) terminate("descendant");
          const graceRemaining = Math.max(1, (termDeadline ?? Date.now()) - Date.now());
          const emptiedDuringGrace = await waitForEmptyProcessGroup(processGroupId, graceRemaining);
          if (!emptiedDuringGrace) sendKill();
        }
        if (escalationTimer) clearTimeout(escalationTimer);
        if (termSignalFailure || killSignalFailure) {
          fail("PROCESS_GROUP_TERMINATION_FAILED", "child process group could not be terminated");
        }
        const processGroupEmpty = await waitForEmptyProcessGroup(
          processGroupId,
          groupEmptyTimeoutMs
        );
        if (!processGroupEmpty) {
          fail("PROCESS_GROUP_NOT_EMPTY", "child process group remained populated after cleanup");
        }
        settled = true;
        resolve({
          code,
          signal,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          timed_out: timedOut,
          output_limit_exceeded:
            stdoutLimitExceeded || stderrLimitExceeded || aggregateLimitExceeded,
          stdout_limit_exceeded: stdoutLimitExceeded,
          stderr_limit_exceeded: stderrLimitExceeded,
          aggregate_output_limit_exceeded: aggregateLimitExceeded,
          termination_attempted: terminationAttempted,
          term_signal_sent: termSignalSent,
          kill_signal_sent: killSignalSent,
          descendant_observed_after_leader_close: descendantObserved,
          process_group_empty_after_cleanup: processGroupEmpty,
        });
      } catch (error) {
        settled = true;
        reject(error);
      }
    });
  });
}

function parseStatusLine(line) {
  if (!line.startsWith("[GNUPG:] ")) {
    fail("GPG_STATUS_MALFORMED", "gpgv emitted a non-status line on the status channel");
  }
  const content = line.slice("[GNUPG:] ".length);
  const separator = content.indexOf(" ");
  return separator === -1
    ? { tag: content, arguments: "" }
    : { tag: content.slice(0, separator), arguments: content.slice(separator + 1) };
}

export function parseGpgvStatus(statusBytes, exitCode, contract) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(statusBytes);
  } catch {
    fail("GPG_STATUS_MALFORMED", "gpgv status is not valid UTF-8");
  }
  if (!text.endsWith("\n")) fail("GPG_STATUS_MALFORMED", "gpgv status must end with a newline");
  const entries = text.slice(0, -1).split("\n").map(parseStatusLine);
  if (entries.some(entry => FATAL_GPG_STATUS.has(entry.tag))) {
    fail("GPG_FATAL_STATUS", "gpgv emitted a fatal signature status");
  }
  if (JSON.stringify(entries.map(entry => entry.tag)) !== JSON.stringify(EXPECTED_GPG_STATUS_SEQUENCE)) {
    fail("GPG_STATUS_SEQUENCE_INVALID", "gpgv status sequence is incomplete, duplicated, or unexpected");
  }
  if (exitCode !== 0) fail("GPG_EXIT_NONZERO", "gpgv did not verify the signature");

  const fingerprint = contract.provenance.primary_fingerprint;
  const keyId = fingerprint.slice(-16);
  if (entries[0].arguments !== "") fail("GPG_STATUS_MALFORMED", "NEWSIG status must not contain arguments");
  if (entries[1].arguments !== `${fingerprint} 0`) {
    fail("GPG_FINGERPRINT_MISMATCH", "KEY_CONSIDERED does not match the reviewed primary fingerprint");
  }
  const sigId = entries[2].arguments.split(" ");
  if (sigId.length !== 3
    || !/^[A-Za-z0-9+/]+$/.test(sigId[0])
    || sigId[1] !== contract.provenance.signature_date
    || sigId[2] !== String(contract.provenance.signature_timestamp_epoch)) {
    fail("GPG_SIGNATURE_TIME_MISMATCH", "SIG_ID does not match the reviewed signature timestamp");
  }
  const goodSigSeparator = entries[3].arguments.indexOf(" ");
  if (goodSigSeparator < 1 || entries[3].arguments.slice(0, goodSigSeparator) !== keyId) {
    fail("GPG_FINGERPRINT_MISMATCH", "GOODSIG key ID does not match the reviewed primary fingerprint");
  }
  const validSig = entries[4].arguments.split(" ");
  if (validSig.length !== 10
    || validSig[0] !== fingerprint
    || validSig[1] !== contract.provenance.signature_date
    || validSig[2] !== String(contract.provenance.signature_timestamp_epoch)
    || validSig[3] !== "0"
    || validSig[4] !== "4"
    || validSig[5] !== "0"
    || validSig[6] !== "1"
    || validSig[7] !== "10"
    || validSig[8] !== "00"
    || validSig[9] !== fingerprint) {
    fail("GPG_VALIDSIG_MISMATCH", "VALIDSIG does not match the reviewed signer, time, RSA, SHA-512, and primary fingerprint");
  }
  return {
    verified: true,
    primary_fingerprint: fingerprint,
    signature_date: contract.provenance.signature_date,
    signature_timestamp_epoch: contract.provenance.signature_timestamp_epoch,
    public_key_algorithm: "RSA",
    digest_algorithm: "SHA-512",
    signature_class: "00",
  };
}

function signatureVerifierEnvironment(runtimeHome) {
  return {
    HOME: runtimeHome,
    GNUPGHOME: runtimeHome,
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
  };
}

function boundedProcessOptions(limits, { cwd, env }) {
  return {
    cwd,
    env,
    timeoutMs: limits.timeout_ms,
    stdoutMaxBytes: limits.stdout_max_bytes,
    stderrMaxBytes: limits.stderr_max_bytes,
    aggregateMaxBytes: limits.aggregate_max_bytes,
    termGraceMs: limits.term_grace_ms,
    groupEmptyTimeoutMs: limits.group_empty_timeout_ms,
  };
}

function filesystemIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: stat.mode & 0o7777,
    uid: stat.uid,
    nlink: stat.nlink,
  };
}

function sameFilesystemIdentity(stat, identity, includeNlink = true) {
  return String(stat.dev) === identity.dev
    && String(stat.ino) === identity.ino
    && (stat.mode & 0o7777) === identity.mode
    && stat.uid === identity.uid
    && (!includeNlink || stat.nlink === identity.nlink);
}

async function writeExclusivePrivatePath(filePath, bytes, before = null, after = null) {
  if (!Buffer.isBuffer(bytes)) {
    fail("PRIVATE_WRITE_FAILED", "private evidence bytes must be a Buffer");
  }
  await before?.();
  let handle;
  let writtenStat;
  try {
    handle = await fs.open(
      filePath,
      fileConstants.O_WRONLY
        | fileConstants.O_CREAT
        | fileConstants.O_EXCL
        | fileConstants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
    writtenStat = await handle.stat();
    if (!writtenStat.isFile()
      || writtenStat.nlink !== 1
      || (writtenStat.mode & 0o777) !== 0o600
      || (typeof process.geteuid === "function" && writtenStat.uid !== process.geteuid())
      || writtenStat.size !== bytes.length) {
      fail("PRIVATE_FILE_IDENTITY_INVALID",
        "private evidence handle is not the reviewed mode-0600 single-link file");
    }
  } catch (error) {
    if (error instanceof FormalEvidenceV2Error) throw error;
    fail("PRIVATE_WRITE_FAILED", `private evidence write failed: ${error.code ?? "unknown"}`);
  } finally {
    await handle?.close();
  }
  const writtenIdentity = filesystemIdentity(writtenStat);
  let receipt;
  try {
    const entry = await fs.lstat(filePath);
    if (entry.isSymbolicLink()
      || !entry.isFile()
      || entry.nlink !== 1
      || entry.size !== bytes.length
      || !sameFilesystemIdentity(entry, writtenIdentity)) {
      fail("PRIVATE_FILE_IDENTITY_INVALID",
        "private evidence path does not retain the written file identity");
    }
    const reopened = await fs.open(
      filePath,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW
    );
    let reopenedBytes;
    try {
      const reopenedStat = await reopened.stat();
      if (!reopenedStat.isFile()
        || reopenedStat.nlink !== 1
        || reopenedStat.size !== bytes.length
        || !sameFilesystemIdentity(reopenedStat, writtenIdentity)) {
        fail("PRIVATE_FILE_IDENTITY_INVALID",
          "reopened private evidence does not retain the written file identity");
      }
      reopenedBytes = await reopened.readFile();
    } finally {
      await reopened.close();
    }
    if (!reopenedBytes.equals(bytes)) {
      fail("PRIVATE_REOPEN_MISMATCH",
        "private evidence bytes changed after fsync and reopen");
    }
    receipt = {
      sha256: sha256(reopenedBytes),
      size: reopenedBytes.length,
      identity: writtenIdentity,
    };
  } catch (error) {
    if (error instanceof FormalEvidenceV2Error) throw error;
    fail("PRIVATE_REOPEN_FAILED",
      `private evidence reopen failed: ${error.code ?? "unknown"}`);
  } finally {
    await after?.();
  }
  return receipt;
}

function safePrivateBasename(basename) {
  return typeof basename === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(basename)
    && path.posix.basename(basename) === basename
    && path.win32.basename(basename) === basename;
}

async function assertDirectoryPathAndHandle(pathname, handle, identity, label) {
  let pathStat;
  let handleStat;
  try {
    pathStat = await fs.lstat(pathname);
    handleStat = await handle.stat();
  } catch {
    fail("PRIVATE_GENERATION_IDENTITY_DRIFT", `${label} identity is unavailable`);
  }
  if (pathStat.isSymbolicLink()
    || !pathStat.isDirectory()
    || !handleStat.isDirectory()
    || !sameFilesystemIdentity(pathStat, identity, false)
    || !sameFilesystemIdentity(handleStat, identity, false)) {
    fail("PRIVATE_GENERATION_IDENTITY_DRIFT", `${label} path or handle identity changed`);
  }
}

export async function assertPrivateGenerationIdentity(generation) {
  await assertDirectoryPathAndHandle(
    generation.root_path,
    generation.root_handle,
    generation.root_identity,
    "private generation root"
  );
  await assertDirectoryPathAndHandle(
    generation.generation_path,
    generation.generation_handle,
    generation.generation_identity,
    "private generation directory"
  );
  return true;
}

export async function writePrivateFile(generation, basename, bytes) {
  if (!safePrivateBasename(basename)) {
    fail("PRIVATE_BASENAME_INVALID", "private evidence writes require a safe basename");
  }
  return writeExclusivePrivatePath(
    path.join(generation.generation_path, basename),
    bytes,
    () => assertPrivateGenerationIdentity(generation),
    () => assertPrivateGenerationIdentity(generation)
  );
}

export async function syncPrivateGeneration(generation) {
  await assertPrivateGenerationIdentity(generation);
  await generation.generation_handle.sync();
  await assertPrivateGenerationIdentity(generation);
}

export async function closePrivateGeneration(generation) {
  const failures = [];
  for (const handle of [generation?.generation_handle, generation?.root_handle]) {
    try {
      await handle?.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    fail("PRIVATE_GENERATION_CLOSE_FAILED", "private generation handles could not be closed");
  }
}

export async function preparePrivateGeneration(generationRoot) {
  await assertNoSymlinkComponents(generationRoot, "private generation root");
  const root = await regularFileOrDirectory(generationRoot, "private generation root", "directory");
  let rootHandle;
  let generationHandle;
  rootHandle = await fs.open(
    root,
    fileConstants.O_RDONLY | fileConstants.O_DIRECTORY | fileConstants.O_NOFOLLOW
  );
  try {
    const rootStat = await rootHandle.stat();
    if ((rootStat.mode & 0o077) !== 0
      || (typeof process.geteuid === "function" && rootStat.uid !== process.geteuid())) {
      fail("PRIVATE_GENERATION_ROOT_UNSAFE",
        "private generation root must be owned by the runner and deny group and other access");
    }
    const generationPath = await fs.mkdtemp(path.join(root, "accessibility-formal-v2-"));
    generationHandle = await fs.open(
      generationPath,
      fileConstants.O_RDONLY | fileConstants.O_DIRECTORY | fileConstants.O_NOFOLLOW
    );
    await generationHandle.chmod(0o700);
    await generationHandle.sync();
    await rootHandle.sync();
    const stableRootStat = await rootHandle.stat();
    const generationStat = await generationHandle.stat();
    if (!generationStat.isDirectory()
      || (generationStat.mode & 0o777) !== 0o700
      || (typeof process.geteuid === "function" && generationStat.uid !== process.geteuid())) {
      fail("PRIVATE_GENERATION_MODE_INVALID",
        "private evidence generation is not an owned mode-0700 directory");
    }
    const generation = {
      root_path: root,
      root_handle: rootHandle,
      root_identity: filesystemIdentity(stableRootStat),
      generation_path: generationPath,
      generation_handle: generationHandle,
      generation_identity: filesystemIdentity(generationStat),
    };
    await assertPrivateGenerationIdentity(generation);
    return generation;
  } catch (error) {
    await generationHandle?.close();
    await rootHandle.close();
    throw error;
  }
}

async function assertNoSymlinkComponents(inputPath, label) {
  const absolute = path.resolve(inputPath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let entry;
    try {
      entry = await fs.lstat(current);
    } catch {
      fail("INPUT_IDENTITY_UNAVAILABLE", `${label} contains an unavailable path component`);
    }
    if (entry.isSymbolicLink()) {
      fail("INPUT_SYMLINK_REJECTED", `${label} must not contain symbolic links`);
    }
  }
}

async function regularFileOrDirectory(inputPath, label, expectedType) {
  let entry;
  try {
    entry = await fs.lstat(inputPath);
  } catch {
    fail("INPUT_IDENTITY_UNAVAILABLE", `${label} is unavailable`);
  }
  if (entry.isSymbolicLink()) fail("INPUT_SYMLINK_REJECTED", `${label} must not be a symbolic link`);
  const resolved = await fs.realpath(inputPath);
  const stat = await fs.stat(resolved);
  if ((expectedType === "directory" && !stat.isDirectory())
    || (expectedType === "file" && !stat.isFile())) {
    fail("INPUT_TYPE_INVALID", `${label} has the wrong type`);
  }
  return resolved;
}

async function containedFixture(corpusDirectory, filename, label) {
  const root = await regularFileOrDirectory(corpusDirectory, "formal corpus directory", "directory");
  const candidate = path.join(root, filename);
  const resolved = await regularFile(candidate, label);
  if (path.dirname(resolved) !== root) fail("FIXTURE_ESCAPE_REJECTED", `${label} resolves outside the corpus directory`);
  return resolved;
}

export async function verifyStagedFixture(stagedPath, receipt) {
  let entry;
  try {
    entry = await fs.lstat(stagedPath);
  } catch {
    fail("STAGED_FIXTURE_DRIFT", "staged fixture is unavailable");
  }
  if (entry.isSymbolicLink()
    || !entry.isFile()
    || entry.nlink !== 1
    || entry.size !== receipt.size
    || !sameFilesystemIdentity(entry, receipt.identity)) {
    fail("STAGED_FIXTURE_DRIFT", "staged fixture path identity changed");
  }
  const reopened = await fs.open(stagedPath, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
  let bytes;
  try {
    const reopenedStat = await reopened.stat();
    if (!reopenedStat.isFile()
      || reopenedStat.nlink !== 1
      || reopenedStat.size !== receipt.size
      || !sameFilesystemIdentity(reopenedStat, receipt.identity)) {
      fail("STAGED_FIXTURE_DRIFT", "staged fixture reopened identity changed");
    }
    bytes = await reopened.readFile();
  } finally {
    await reopened.close();
  }
  if (bytes.length !== receipt.size || sha256(bytes) !== receipt.sha256) {
    fail("STAGED_FIXTURE_DRIFT", "staged fixture bytes changed");
  }
  return true;
}

export async function stageVerifiedFixture(corpusDirectory, runtimeFixtureDirectory, fixture) {
  const sourcePath = await containedFixture(corpusDirectory, fixture.filename, fixture.id);
  const source = await readExactFile(
    sourcePath,
    `source fixture ${fixture.id}`,
    fixture.sha256,
    fixture.size,
    true
  );
  // Preserve the reviewed basename because parseVeraPdfEvidence binds the
  // validator report's item identity to fixture.filename. The private runtime
  // directory, not a renamed basename, supplies isolation from the source path.
  const stagedBasename = fixture.filename;
  if (!safePrivateBasename(stagedBasename)) {
    fail("PRIVATE_BASENAME_INVALID", "staged fixture basename is unsafe");
  }
  const stagedPath = path.join(runtimeFixtureDirectory, stagedBasename);
  const receipt = await writeExclusivePrivatePath(stagedPath, source.bytes);
  await verifyStagedFixture(stagedPath, receipt);
  return {
    source_path: source.resolved,
    staged_path: stagedPath,
    receipt,
  };
}

async function captureExecutionIdentity({
  contract,
  publicKeyPath,
  signaturePath,
  verifierPath,
  validatorPath,
  installerPath,
  runtimeArchivePath,
  javaHome,
}) {
  const publicKey = await readExactFile(publicKeyPath, "veraPDF public key",
    contract.provenance.public_key_sha256, contract.provenance.public_key_size, true);
  const signature = await readExactFile(signaturePath, "veraPDF detached signature",
    contract.provenance.signature_sha256, contract.provenance.signature_size);
  const verifier = await readExactFile(verifierPath, "gpgv executable",
    contract.signature_verifier.executable_sha256);
  const installer = await readExactFile(installerPath, "veraPDF installer",
    contract.validator.installer_sha256);
  const validator = await readExactFile(validatorPath, "veraPDF wrapper",
    contract.validator.installed_wrapper_sha256);
  const validatorRoot = path.dirname(validator.resolved);
  const cliJarPath = path.join(validatorRoot, "bin", `cli-${contract.validator.version}.jar`);
  const cliJar = await readExactFile(cliJarPath, "veraPDF CLI jar",
    contract.validator.installed_cli_jar_sha256);
  const runtimeArchive = await readExactFile(runtimeArchivePath, "Temurin runtime archive",
    contract.runtime.archive_sha256);
  const resolvedJavaHome = await regularFileOrDirectory(javaHome, "Java home", "directory");
  const java = await readExactFile(path.join(resolvedJavaHome, "bin", "java"), "Java binary",
    contract.runtime.java_binary_sha256);
  const [validatorTree, runtimeTree] = await Promise.all([
    computeInstalledTreeDigest(validatorRoot),
    computeInstalledTreeDigest(resolvedJavaHome),
  ]);
  if (validatorTree.digest !== contract.validator.installed_tree_sha256) {
    fail("VALIDATOR_TREE_MISMATCH", "installed validator tree does not match the reviewed digest");
  }
  if (runtimeTree.digest !== contract.runtime.installed_tree_sha256) {
    fail("RUNTIME_TREE_MISMATCH", "installed runtime tree does not match the reviewed digest");
  }
  return {
    publicKey,
    signature,
    verifier,
    installer,
    validator,
    cliJar,
    runtimeArchive,
    java,
    javaHome: resolvedJavaHome,
    validatorTree,
    runtimeTree,
  };
}

export function executionIdentityMatches(left, right) {
  const files = ["publicKey", "signature", "verifier", "installer", "validator", "cliJar", "runtimeArchive", "java"];
  return files.every(name => left[name].sha256 === right[name].sha256 && left[name].size === right[name].size)
    && left.validatorTree.digest === right.validatorTree.digest
    && left.runtimeTree.digest === right.runtimeTree.digest;
}

function assertProcessQualified(execution, label) {
  if (execution.timed_out) fail("CHILD_TIMEOUT", `${label} timed out`);
  if (execution.output_limit_exceeded) fail("CHILD_OUTPUT_LIMIT", `${label} exceeded its output limit`);
  if (execution.signal) fail("CHILD_SIGNAL", `${label} terminated by signal`);
  if (execution.descendant_observed_after_leader_close) {
    fail("CHILD_DESCENDANT_OBSERVED", `${label} left a descendant after its leader closed`);
  }
  if (!execution.process_group_empty_after_cleanup) {
    fail("PROCESS_GROUP_NOT_EMPTY", `${label} process group cleanup is unproven`);
  }
}

async function verifyInstallerAuthenticity({
  contract,
  identity,
  runtimeHome,
}) {
  const keyringPath = path.join(runtimeHome, "trustedkeys.gpg");
  const keyringBytes = dearmorPublicKey(identity.publicKey.bytes);
  await writeExclusivePrivatePath(keyringPath, keyringBytes);
  const version = await runBoundedProcess(
    identity.verifier.resolved,
    ["--version"],
    boundedProcessOptions(
      contract.execution_limits.signature_verifier.version_preflight,
      { cwd: runtimeHome, env: signatureVerifierEnvironment(runtimeHome) }
    )
  );
  assertProcessQualified(version, "gpgv version preflight");
  if (version.code !== 0
    || version.stderr.length !== 0
    || version.stdout.toString("utf8").split("\n")[0] !== contract.signature_verifier.version_line) {
    fail("GPG_VERSION_MISMATCH", "gpgv version preflight does not match the reviewed identity");
  }
  const verification = await runBoundedProcess(identity.verifier.resolved, [
    "--homedir",
    runtimeHome,
    "--keyring",
    keyringPath,
    "--status-fd",
    "1",
    identity.signature.resolved,
    identity.installer.resolved,
  ], boundedProcessOptions(
    contract.execution_limits.signature_verifier.signature_verification,
    { cwd: runtimeHome, env: signatureVerifierEnvironment(runtimeHome) }
  ));
  assertProcessQualified(verification, "gpgv signature verification");
  const parsed = parseGpgvStatus(verification.stdout, verification.code, contract);
  return {
    ...parsed,
    verifier_name: contract.signature_verifier.name,
    verifier_version: contract.signature_verifier.version_line,
    verifier_executable_sha256: contract.signature_verifier.executable_sha256,
    public_key_sha256: contract.provenance.public_key_sha256,
    signature_sha256: contract.provenance.signature_sha256,
    installer_sha256: contract.validator.installer_sha256,
    status_sha256: sha256(verification.stdout),
    diagnostic_sha256: sha256(verification.stderr),
    raw_status: verification.stdout,
    raw_diagnostic: verification.stderr,
  };
}

function confusion(results) {
  const family = {
    true_positives: 0,
    true_negatives: 0,
    false_positives: 0,
    false_negatives: 0,
    harness_failures: 0,
  };
  for (const result of results) {
    if (result.harness_error_code) {
      family.harness_failures += 1;
    } else if (!result.expected_machine_compliant && !result.evidence.machine_compliant) {
      family.true_positives += 1;
    } else if (result.expected_machine_compliant && result.evidence.machine_compliant) {
      family.true_negatives += 1;
    } else if (result.expected_machine_compliant) {
      family.false_positives += 1;
    } else {
      family.false_negatives += 1;
    }
  }
  return { version_identification: family };
}

export function buildPublicProjection({ contract, authenticity, results, passed }) {
  const projection = {
    projection_version: 1,
    publication_authorized: false,
    bounded_installer_claim: contract.claim_boundary.bounded_installer_claim,
    authenticity: {
      result: "verified_against_exact_officially_published_key",
      primary_fingerprint: authenticity.primary_fingerprint,
      public_key_sha256: authenticity.public_key_sha256,
      signature_sha256: authenticity.signature_sha256,
      installer_sha256: authenticity.installer_sha256,
      signature_date: authenticity.signature_date,
      verifier: {
        name: authenticity.verifier_name,
        version: authenticity.verifier_version,
        executable_sha256: authenticity.verifier_executable_sha256,
      },
    },
    validator: {
      name: contract.validator.name,
      version: contract.validator.version,
      profile: contract.validator.profile,
      bundled: false,
    },
    pilot: {
      scope: contract.claim_boundary.machine_validation_scope,
      fixture_count: results.length,
      passed,
      confusion: confusion(results),
      results: results.map(result => ({
        id: result.id,
        expected_machine_compliant: result.expected_machine_compliant,
        machine_compliant: result.evidence?.machine_compliant ?? null,
        expectation_met: result.expectation_met,
        fixture_sha256: result.fixture_sha256,
        harness_error_code: result.harness_error_code,
      })),
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
    limitations: [
      "The signer key is pinned from veraPDF's HTTPS documentation; independent public-key infrastructure trust is not established.",
      "Key revocation status is not refreshed during the offline verification run.",
      "The evidence host kernel, operating system, loader, dynamic libraries, and Node runtime remain in the trusted computing base; the source receipt pins only the Node executable.",
      "Identity checks detect persistent drift but Node lacks openat, so transient same-user substitution and restore, including the proof-to-open micro-race, is not resisted.",
      "The machine pilot covers only two PDF/UA-1 version-identification files and no human-verifiable requirements.",
      "PDF/UA conformance, WCAG conformance, legal compliance, certification, and document accessibility are not established.",
    ],
  };
  assertPublicProjectionSafe(projection);
  return projection;
}

function hasAbsoluteLocalPath(value) {
  return typeof value === "string"
    && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\"));
}

export function assertPublicProjectionSafe(projection) {
  function publicExactKeys(value, keys, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
      fail("PUBLIC_PROJECTION_UNSAFE", `${label} contains a field outside the public whitelist`);
    }
  }
  publicExactKeys(projection, PUBLIC_PROJECTION_KEYS, "public projection");
  publicExactKeys(projection.authenticity, [
    "result",
    "primary_fingerprint",
    "public_key_sha256",
    "signature_sha256",
    "installer_sha256",
    "signature_date",
    "verifier",
  ], "public authenticity projection");
  publicExactKeys(projection.authenticity.verifier, [
    "name",
    "version",
    "executable_sha256",
  ], "public verifier projection");
  publicExactKeys(projection.validator, ["name", "version", "profile", "bundled"],
    "public validator projection");
  publicExactKeys(projection.pilot, [
    "scope",
    "fixture_count",
    "passed",
    "confusion",
    "results",
  ], "public pilot projection");
  publicExactKeys(projection.pilot.confusion, ["version_identification"],
    "public confusion projection");
  publicExactKeys(projection.pilot.confusion.version_identification, [
    "true_positives",
    "true_negatives",
    "false_positives",
    "false_negatives",
    "harness_failures",
  ], "public family confusion projection");
  if (!Array.isArray(projection.pilot.results)) {
    fail("PUBLIC_PROJECTION_UNSAFE", "public pilot results must be an array");
  }
  for (const result of projection.pilot.results) {
    publicExactKeys(result, [
      "id",
      "expected_machine_compliant",
      "machine_compliant",
      "expectation_met",
      "fixture_sha256",
      "harness_error_code",
    ], "public pilot result projection");
  }
  publicExactKeys(projection.claim_boundary, [
    "pdfua_conformance",
    "wcag_conformance",
    "legal_compliance",
    "certification",
  ], "public claim-boundary projection");
  publicExactKeys(projection.private_evidence, ["retained", "qualification_index_required"],
    "public private-evidence projection");
  if (!Array.isArray(projection.limitations) || projection.limitations.length !== 6
    || projection.limitations.some(limitation => typeof limitation !== "string")) {
    fail("PUBLIC_PROJECTION_UNSAFE", "public limitations must be the reviewed six-item array");
  }
  if (projection.publication_authorized !== false) {
    fail("PUBLIC_PROJECTION_UNSAFE", "public projection must remain non-publishable");
  }
  const forbiddenKey = /(^|_)(path|stdout|stderr|status|uid|raw_output|raw_status)($|_)/i;
  const canaries = ["Carl Wilson", "techlead@verapdf.org", "[GNUPG:]", "BLUEHARBOR-PRIVATE-CANARY"];
  function walk(value, key = "") {
    if (forbiddenKey.test(key)) fail("PUBLIC_PROJECTION_UNSAFE", "public projection contains a forbidden field");
    if (hasAbsoluteLocalPath(value)) fail("PUBLIC_PROJECTION_UNSAFE", "public projection contains an absolute local path");
    if (typeof value === "string" && canaries.some(canary => value.includes(canary))) {
      fail("PUBLIC_PROJECTION_UNSAFE", "public projection contains private or raw diagnostic material");
    }
    if (Array.isArray(value)) value.forEach(item => walk(item));
    else if (value && typeof value === "object") Object.entries(value).forEach(([childKey, child]) => walk(child, childKey));
  }
  walk(projection);
  return true;
}

function safePrivateResult(result) {
  return {
    id: result.id,
    expected_machine_compliant: result.expected_machine_compliant,
    fixture_sha256: result.fixture_sha256,
    raw_report_filename: result.raw_report_filename,
    raw_report_sha256: result.raw_report_sha256,
    raw_report_size: result.raw_report_size,
    raw_report_identity: result.raw_report_identity,
    staged_fixture_receipt: result.staged_fixture_receipt,
    stderr_sha256: result.stderr_sha256,
    evidence: result.evidence,
    harness_error_code: result.harness_error_code,
    expectation_met: result.expectation_met,
  };
}

function safeAuthenticityResult(authenticity) {
  return {
    verified: authenticity.verified,
    primary_fingerprint: authenticity.primary_fingerprint,
    signature_date: authenticity.signature_date,
    signature_timestamp_epoch: authenticity.signature_timestamp_epoch,
    public_key_algorithm: authenticity.public_key_algorithm,
    digest_algorithm: authenticity.digest_algorithm,
    signature_class: authenticity.signature_class,
    verifier_name: authenticity.verifier_name,
    verifier_version: authenticity.verifier_version,
    verifier_executable_sha256: authenticity.verifier_executable_sha256,
    public_key_sha256: authenticity.public_key_sha256,
    signature_sha256: authenticity.signature_sha256,
    installer_sha256: authenticity.installer_sha256,
    status_sha256: authenticity.status_sha256,
    diagnostic_sha256: authenticity.diagnostic_sha256,
  };
}

export async function runFormalAccessibilityV2Evaluation({
  contractPath,
  sourceReceiptPath,
  corpusDirectory,
  publicKeyPath,
  signaturePath,
  verifierPath,
  validatorPath,
  validatorArtifactPath,
  runtimeArchivePath,
  javaHome,
  generationRoot,
}) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    fail("PLATFORM_MISMATCH", "formal accessibility v2 evidence requires Linux x64");
  }
  const { contract, contract_sha256: contractSha256 } =
    await loadFormalAccessibilityV2Contract(contractPath);
  const sourceIdentity = await loadAndVerifySourceReceipt(
    sourceReceiptPath,
    contractPath,
    contractSha256
  );
  exactValue(verifierPath, contract.signature_verifier.executable_path, "requested verifier path");
  const identityArguments = {
    contract,
    publicKeyPath,
    signaturePath,
    verifierPath,
    validatorPath,
    installerPath: validatorArtifactPath,
    runtimeArchivePath,
    javaHome,
  };
  const initialIdentity = await captureExecutionIdentity(identityArguments);
  const runtimeHome = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-verapdf-v2-home-"));
  await fs.chmod(runtimeHome, 0o700);
  try {
    const runtimeDirectories = ["cache", "config", "tmp", "fixtures"]
      .map(name => path.join(runtimeHome, name));
    await Promise.all(runtimeDirectories.map(directory =>
      fs.mkdir(directory, { mode: 0o700 })
    ));
    await Promise.all(runtimeDirectories.map(directory => fs.chmod(directory, 0o700)));
    const authenticity = await verifyInstallerAuthenticity({
      contract,
      identity: initialIdentity,
      runtimeHome,
    });
    const authenticatedIdentity = await captureExecutionIdentity(identityArguments);
    if (!executionIdentityMatches(initialIdentity, authenticatedIdentity)) {
      fail("AUTHENTICATED_IDENTITY_DRIFT", "execution identity changed during authenticity verification");
    }

    const generation = await preparePrivateGeneration(generationRoot);
    try {
      const sourceReceiptCopy = await writePrivateFile(
        generation,
        "external-source-receipt.v1.json",
        sourceIdentity.receipt_bytes
      );
      if (sourceReceiptCopy.sha256 !== sourceIdentity.receipt_sha256
        || sourceReceiptCopy.size !== sourceIdentity.receipt_size) {
        fail("SOURCE_RECEIPT_COPY_MISMATCH",
          "private source receipt copy does not match the externally retained receipt");
      }
      const signatureStatusReceipt = await writePrivateFile(
        generation,
        "gpgv-signature-status.txt",
        authenticity.raw_status
      );
      const signatureDiagnosticReceipt = await writePrivateFile(
        generation,
        "gpgv-signature-diagnostic.txt",
        authenticity.raw_diagnostic
      );
      const environment = buildFormalRunnerEnvironment({
        javaHome: authenticatedIdentity.javaHome,
        runtimeHome,
      });
      const version = await runBoundedProcess(
        authenticatedIdentity.validator.resolved,
        ["--version"],
        boundedProcessOptions(
          contract.execution_limits.validator.version_preflight,
          { cwd: runtimeHome, env: environment }
        )
      );
      assertProcessQualified(version, "veraPDF version preflight");
      if (version.code !== 0
        || !version.stdout.toString("utf8").includes(`veraPDF ${contract.validator.version}`)) {
        fail("VALIDATOR_VERSION_MISMATCH",
          "veraPDF version preflight does not match the reviewed identity");
      }
      const postVersionIdentity = await captureExecutionIdentity(identityArguments);
      if (!executionIdentityMatches(authenticatedIdentity, postVersionIdentity)) {
        fail("MID_RUN_IDENTITY_DRIFT",
          "execution identity changed during validator version preflight");
      }

      const results = [];
      for (const fixture of contract.fixtures) {
        const staged = await stageVerifiedFixture(
          corpusDirectory,
          path.join(runtimeHome, "fixtures"),
          fixture
        );
        const execution = await runBoundedProcess(
          authenticatedIdentity.validator.resolved,
          [
            "--format",
            "json",
            "--flavour",
            contract.validator.profile,
            staged.staged_path,
          ],
          boundedProcessOptions(
            contract.execution_limits.validator.fixture,
            { cwd: runtimeHome, env: environment }
          )
        );
        await verifyStagedFixture(staged.staged_path, staged.receipt);
        const rawReportFilename = `${fixture.id}.raw.json`;
        const rawReportReceipt = await writePrivateFile(
          generation,
          rawReportFilename,
          execution.stdout
        );
        let evidence = null;
        let harnessErrorCode = null;
        try {
          assertProcessQualified(execution, `veraPDF fixture ${fixture.id}`);
          evidence = parseVeraPdfEvidence(execution.stdout, execution.code, fixture, contract);
        } catch (error) {
          harnessErrorCode = error.code ?? "VALIDATOR_EVIDENCE_INVALID";
        }
        results.push({
          id: fixture.id,
          expected_machine_compliant: fixture.expected_machine_compliant,
          fixture_sha256: fixture.sha256,
          staged_fixture_receipt: staged.receipt,
          raw_report_filename: rawReportFilename,
          raw_report_sha256: rawReportReceipt.sha256,
          raw_report_size: rawReportReceipt.size,
          raw_report_identity: rawReportReceipt.identity,
          stderr_sha256: sha256(execution.stderr),
          evidence,
          harness_error_code: harnessErrorCode,
          expectation_met: harnessErrorCode === null && evidence.expectation_met,
        });
        const postFixtureIdentity = await captureExecutionIdentity(identityArguments);
        if (!executionIdentityMatches(authenticatedIdentity, postFixtureIdentity)) {
          fail("MID_RUN_IDENTITY_DRIFT",
            "execution identity changed during a validator fixture job");
        }
      }

      const finalIdentity = await captureExecutionIdentity(identityArguments);
      if (!executionIdentityMatches(authenticatedIdentity, finalIdentity)) {
        fail("POST_RUN_IDENTITY_DRIFT",
          "execution identity changed while validator jobs ran");
      }
      const postSourceIdentity = await loadAndVerifySourceReceipt(
        sourceReceiptPath,
        contractPath,
        contractSha256
      );
      if (postSourceIdentity.receipt_sha256 !== sourceIdentity.receipt_sha256
        || postSourceIdentity.receipt_size !== sourceIdentity.receipt_size) {
        fail("SOURCE_IDENTITY_DRIFT",
          "source receipt or bound source/runtime identity changed during execution");
      }
      await assertPrivateGenerationIdentity(generation);
      const passed = results.every(result => result.expectation_met);
      const privateIndexWithoutSelf = {
        index_version: 1,
        evidence_runner_version: FORMAL_EVIDENCE_V2_RUNNER_VERSION,
        contract_sha256: contractSha256,
        publication_authorized: false,
        execution_limits: contract.execution_limits,
        source_runtime: {
          external_receipt: {
            filename: "external-source-receipt.v1.json",
            sha256: sourceReceiptCopy.sha256,
            size: sourceReceiptCopy.size,
            identity: sourceReceiptCopy.identity,
          },
          captured_at: sourceIdentity.receipt.captured_at,
          capture_method: sourceIdentity.receipt.capture_method,
          repository: sourceIdentity.receipt.repository,
          files: sourceIdentity.verified_files,
          node: sourceIdentity.verified_node,
        },
        private_generation_identity: {
          root: generation.root_identity,
          generation: generation.generation_identity,
        },
        authenticity: {
          verified: authenticity.verified,
          primary_fingerprint: authenticity.primary_fingerprint,
          public_key_sha256: authenticity.public_key_sha256,
          signature_sha256: authenticity.signature_sha256,
          installer_sha256: authenticity.installer_sha256,
          verifier_executable_sha256: authenticity.verifier_executable_sha256,
          status_sha256: authenticity.status_sha256,
          diagnostic_sha256: authenticity.diagnostic_sha256,
          raw_status: {
            filename: "gpgv-signature-status.txt",
            ...signatureStatusReceipt,
          },
          raw_diagnostic: {
            filename: "gpgv-signature-diagnostic.txt",
            ...signatureDiagnosticReceipt,
          },
        },
        identity: {
          validator_tree_sha256: finalIdentity.validatorTree.digest,
          runtime_tree_sha256: finalIdentity.runtimeTree.digest,
        },
        passed,
        results: results.map(safePrivateResult),
      };
      const projection = buildPublicProjection({
        contract,
        authenticity,
        results,
        passed,
      });
      const projectionBytes = Buffer.from(
        `${JSON.stringify(projection, null, 2)}\n`,
        "utf8"
      );
      const projectionReceipt = await writePrivateFile(
        generation,
        "public-projection.v1.json",
        projectionBytes
      );
      await assertPrivateGenerationIdentity(generation);
      const finalIndex = {
        ...privateIndexWithoutSelf,
        public_projection: {
          filename: "public-projection.v1.json",
          ...projectionReceipt,
        },
      };
      const finalIndexBytes = Buffer.from(
        `${JSON.stringify(finalIndex, null, 2)}\n`,
        "utf8"
      );
      const finalIndexReceipt = await writePrivateFile(
        generation,
        "qualification-index.v1.json",
        finalIndexBytes
      );
      await syncPrivateGeneration(generation);
      await assertPrivateGenerationIdentity(generation);
      const qualificationIndexPath =
        path.join(generation.generation_path, "qualification-index.v1.json");
      const result = {
        evidence_runner_version: FORMAL_EVIDENCE_V2_RUNNER_VERSION,
        passed,
        authenticity: safeAuthenticityResult(authenticity),
        results,
        public_projection: projection,
        private_generation_path: generation.generation_path,
        qualification_index_path: qualificationIndexPath,
        qualification_index_sha256: finalIndexReceipt.sha256,
        qualification_index_identity: finalIndexReceipt.identity,
      };
      await assertPrivateGenerationIdentity(generation);
      return result;
    } finally {
      await closePrivateGeneration(generation);
    }
  } finally {
    await fs.rm(runtimeHome, { recursive: true, force: true });
  }
}
