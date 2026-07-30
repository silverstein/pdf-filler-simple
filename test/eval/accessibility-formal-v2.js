import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fileConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildFormalRunnerEnvironment,
  computeInstalledTreeDigest,
  parseVeraPdfEvidence,
} from "./accessibility-formal.js";

export const FORMAL_EVIDENCE_V2_RUNNER_VERSION = 3;
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

function killProcessGroup(processGroupId) {
  if (!Number.isInteger(processGroupId) || processGroupId < 1) {
    return "invalid_process_group";
  }
  try {
    process.kill(-processGroupId, "SIGKILL");
    return null;
  } catch (error) {
    return error.code === "ESRCH" ? null : (error.code ?? "unknown");
  }
}

async function waitForEmptyProcessGroup(processGroupId, deadlineMs = 2_000) {
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
  maxOutputBytes = 16 * 1024 * 1024,
} = {}) {
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
    let outputBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let terminationAttempted = false;
    let terminationFailure = null;
    let settled = false;

    const terminate = reason => {
      if (terminationAttempted) return;
      terminationAttempted = true;
      if (reason === "timeout") timedOut = true;
      if (reason === "output_limit") outputLimitExceeded = true;
      terminationFailure = killProcessGroup(processGroupId);
    };
    const timer = setTimeout(() => terminate("timeout"), timeoutMs);
    const collect = target => chunk => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        terminate("output_limit");
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", error => {
      clearTimeout(timer);
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
          terminationAttempted = true;
          terminationFailure = killProcessGroup(processGroupId);
        }
        if (terminationFailure) {
          fail("PROCESS_GROUP_TERMINATION_FAILED", "child process group could not be terminated");
        }
        const processGroupEmpty = await waitForEmptyProcessGroup(processGroupId);
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
          output_limit_exceeded: outputLimitExceeded,
          termination_attempted: terminationAttempted,
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

export async function writePrivateFile(filePath, bytes) {
  let handle;
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
    await handle.sync();
  } catch (error) {
    if (error instanceof FormalEvidenceV2Error) throw error;
    fail("PRIVATE_WRITE_FAILED", `private evidence write failed: ${error.code ?? "unknown"}`);
  } finally {
    await handle?.close();
  }
  await fs.chmod(filePath, 0o600);
  const entry = await fs.lstat(filePath);
  if (entry.isSymbolicLink() || !entry.isFile() || (entry.mode & 0o777) !== 0o600) {
    fail("PRIVATE_FILE_MODE_INVALID", "private evidence file is not a mode-0600 regular file");
  }
  const reopened = await fs.open(filePath, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
  let reopenedBytes;
  try {
    reopenedBytes = await reopened.readFile();
  } finally {
    await reopened.close();
  }
  if (!reopenedBytes.equals(bytes)) fail("PRIVATE_REOPEN_MISMATCH", "private evidence bytes changed after fsync and reopen");
  return {
    sha256: sha256(reopenedBytes),
    size: reopenedBytes.length,
  };
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, fileConstants.O_RDONLY | fileConstants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function preparePrivateGeneration(generationRoot) {
  await assertNoSymlinkComponents(generationRoot, "private generation root");
  const root = await regularFileOrDirectory(generationRoot, "private generation root", "directory");
  const rootStat = await fs.stat(root);
  if ((rootStat.mode & 0o077) !== 0
    || (typeof process.geteuid === "function" && rootStat.uid !== process.geteuid())) {
    fail("PRIVATE_GENERATION_ROOT_UNSAFE",
      "private generation root must be owned by the runner and deny group and other access");
  }
  const generationPath = await fs.mkdtemp(path.join(root, "accessibility-formal-v2-"));
  await fs.chmod(generationPath, 0o700);
  const entry = await fs.lstat(generationPath);
  if (entry.isSymbolicLink() || !entry.isDirectory() || (entry.mode & 0o777) !== 0o700) {
    fail("PRIVATE_GENERATION_MODE_INVALID", "private evidence generation is not a mode-0700 directory");
  }
  await syncDirectory(root);
  return generationPath;
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
  signatureTimeoutMs,
  signatureMaxOutputBytes,
}) {
  const keyringPath = path.join(runtimeHome, "trustedkeys.gpg");
  const keyringBytes = dearmorPublicKey(identity.publicKey.bytes);
  await writePrivateFile(keyringPath, keyringBytes);
  const version = await runBoundedProcess(identity.verifier.resolved, ["--version"], {
    cwd: runtimeHome,
    env: signatureVerifierEnvironment(runtimeHome),
    timeoutMs: signatureTimeoutMs,
    maxOutputBytes: signatureMaxOutputBytes,
  });
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
  ], {
    cwd: runtimeHome,
    env: signatureVerifierEnvironment(runtimeHome),
    timeoutMs: signatureTimeoutMs,
    maxOutputBytes: signatureMaxOutputBytes,
  });
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
      "The Linux loader and dynamic libraries used by gpgv remain part of the evidence host's trusted computing base.",
      "Pre-run and post-run identity checks do not resist a same-user actor that can substitute and restore bytes during execution.",
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
  corpusDirectory,
  publicKeyPath,
  signaturePath,
  verifierPath,
  validatorPath,
  validatorArtifactPath,
  runtimeArchivePath,
  javaHome,
  generationRoot,
  signatureTimeoutMs = 30_000,
  signatureMaxOutputBytes = 1024 * 1024,
  validatorTimeoutMs = 60_000,
  validatorMaxOutputBytes = 16 * 1024 * 1024,
}) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    fail("PLATFORM_MISMATCH", "formal accessibility v2 evidence requires Linux x64");
  }
  const { contract, contract_sha256: contractSha256 } = await loadFormalAccessibilityV2Contract(contractPath);
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
    await Promise.all([
      fs.mkdir(path.join(runtimeHome, "cache"), { mode: 0o700 }),
      fs.mkdir(path.join(runtimeHome, "config"), { mode: 0o700 }),
      fs.mkdir(path.join(runtimeHome, "tmp"), { mode: 0o700 }),
    ]);
    const authenticity = await verifyInstallerAuthenticity({
      contract,
      identity: initialIdentity,
      runtimeHome,
      signatureTimeoutMs,
      signatureMaxOutputBytes,
    });
    const authenticatedIdentity = await captureExecutionIdentity(identityArguments);
    if (!executionIdentityMatches(initialIdentity, authenticatedIdentity)) {
      fail("AUTHENTICATED_IDENTITY_DRIFT", "execution identity changed during authenticity verification");
    }

    const generationPath = await preparePrivateGeneration(generationRoot);
    const signatureStatusReceipt = await writePrivateFile(
      path.join(generationPath, "gpgv-signature-status.txt"),
      authenticity.raw_status
    );
    const signatureDiagnosticReceipt = await writePrivateFile(
      path.join(generationPath, "gpgv-signature-diagnostic.txt"),
      authenticity.raw_diagnostic
    );
    const environment = buildFormalRunnerEnvironment({
      javaHome: authenticatedIdentity.javaHome,
      runtimeHome,
    });
    const version = await runBoundedProcess(authenticatedIdentity.validator.resolved, ["--version"], {
      cwd: runtimeHome,
      env: environment,
      timeoutMs: validatorTimeoutMs,
      maxOutputBytes: validatorMaxOutputBytes,
    });
    assertProcessQualified(version, "veraPDF version preflight");
    if (version.code !== 0
      || !version.stdout.toString("utf8").includes(`veraPDF ${contract.validator.version}`)) {
      fail("VALIDATOR_VERSION_MISMATCH", "veraPDF version preflight does not match the reviewed identity");
    }
    const postVersionIdentity = await captureExecutionIdentity(identityArguments);
    if (!executionIdentityMatches(authenticatedIdentity, postVersionIdentity)) {
      fail("MID_RUN_IDENTITY_DRIFT", "execution identity changed during validator version preflight");
    }

    const results = [];
    for (const fixture of contract.fixtures) {
      const fixturePath = await containedFixture(corpusDirectory, fixture.filename, fixture.id);
      const fixtureBytes = await fs.readFile(fixturePath);
      if (fixtureBytes.length !== fixture.size || sha256(fixtureBytes) !== fixture.sha256) {
        fail("FIXTURE_IDENTITY_MISMATCH", `${fixture.id} byte identity does not match the contract`);
      }
      const execution = await runBoundedProcess(authenticatedIdentity.validator.resolved, [
        "--format",
        "json",
        "--flavour",
        contract.validator.profile,
        fixturePath,
      ], {
        cwd: runtimeHome,
        env: environment,
        timeoutMs: validatorTimeoutMs,
        maxOutputBytes: validatorMaxOutputBytes,
      });
      const rawReportFilename = `${fixture.id}.raw.json`;
      const rawReportReceipt = await writePrivateFile(path.join(generationPath, rawReportFilename), execution.stdout);
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
        raw_report_filename: rawReportFilename,
        raw_report_sha256: rawReportReceipt.sha256,
        stderr_sha256: sha256(execution.stderr),
        evidence,
        harness_error_code: harnessErrorCode,
        expectation_met: harnessErrorCode === null && evidence.expectation_met,
      });
      const postFixtureIdentity = await captureExecutionIdentity(identityArguments);
      if (!executionIdentityMatches(authenticatedIdentity, postFixtureIdentity)) {
        fail("MID_RUN_IDENTITY_DRIFT", "execution identity changed during a validator fixture job");
      }
    }

    const finalIdentity = await captureExecutionIdentity(identityArguments);
    if (!executionIdentityMatches(authenticatedIdentity, finalIdentity)) {
      fail("POST_RUN_IDENTITY_DRIFT", "execution identity changed while validator jobs ran");
    }
    const passed = results.every(result => result.expectation_met);
    const privateIndexWithoutSelf = {
      index_version: 1,
      evidence_runner_version: FORMAL_EVIDENCE_V2_RUNNER_VERSION,
      contract_sha256: contractSha256,
      publication_authorized: false,
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
          sha256: signatureStatusReceipt.sha256,
          size: signatureStatusReceipt.size,
        },
        raw_diagnostic: {
          filename: "gpgv-signature-diagnostic.txt",
          sha256: signatureDiagnosticReceipt.sha256,
          size: signatureDiagnosticReceipt.size,
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
    const projectionBytes = Buffer.from(`${JSON.stringify(projection, null, 2)}\n`, "utf8");
    const projectionReceipt = await writePrivateFile(path.join(generationPath, "public-projection.v1.json"), projectionBytes);
    const finalIndex = {
      ...privateIndexWithoutSelf,
      public_projection: {
        filename: "public-projection.v1.json",
        sha256: projectionReceipt.sha256,
        size: projectionReceipt.size,
      },
    };
    const finalIndexBytes = Buffer.from(`${JSON.stringify(finalIndex, null, 2)}\n`, "utf8");
    const finalIndexReceipt = await writePrivateFile(path.join(generationPath, "qualification-index.v1.json"), finalIndexBytes);
    await syncDirectory(generationPath);
    return {
      evidence_runner_version: FORMAL_EVIDENCE_V2_RUNNER_VERSION,
      passed,
      authenticity: safeAuthenticityResult(authenticity),
      results,
      public_projection: projection,
      private_generation_path: generationPath,
      qualification_index_path: path.join(generationPath, "qualification-index.v1.json"),
      qualification_index_sha256: finalIndexReceipt.sha256,
    };
  } finally {
    await fs.rm(runtimeHome, { recursive: true, force: true });
  }
}
