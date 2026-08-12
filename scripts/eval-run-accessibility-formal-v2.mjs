#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONTRACT = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "accessibility",
  "formal-corpus.v2.json"
);
const OPTION_NAMES = Object.freeze({
  "--contract": "contractPath",
  "--source-receipt": "sourceReceiptPath",
  "--corpus-dir": "corpusDirectory",
  "--public-key": "publicKeyPath",
  "--signature": "signaturePath",
  "--verifier": "verifierPath",
  "--validator": "validatorPath",
  "--validator-artifact": "validatorArtifactPath",
  "--runtime-archive": "runtimeArchivePath",
  "--java-home": "javaHome",
  "--generation-root": "generationRoot",
});
const REQUIRED_OPTIONS = Object.freeze(
  Object.keys(OPTION_NAMES).filter(option => option !== "--contract")
);
const REVIEWED_FAILURE_CODES = new Set([
  "ARGUMENT_INVALID",
  "AUTHENTICATED_IDENTITY_DRIFT",
  "CHILD_DESCENDANT_OBSERVED",
  "CHILD_OUTPUT_LIMIT",
  "CHILD_SIGNAL",
  "CHILD_TIMEOUT",
  "CONTRACT_IDENTITY_INVALID",
  "CONTRACT_JSON_INVALID",
  "CONTRACT_SHAPE_INVALID",
  "FIXTURE_ESCAPE_REJECTED",
  "FIXTURE_IDENTITY_MISMATCH",
  "GPG_EXIT_NONZERO",
  "GPG_FATAL_STATUS",
  "GPG_FINGERPRINT_MISMATCH",
  "GPG_SIGNATURE_TIME_MISMATCH",
  "GPG_STATUS_MALFORMED",
  "GPG_STATUS_SEQUENCE_INVALID",
  "GPG_VALIDSIG_MISMATCH",
  "GPG_VERSION_MISMATCH",
  "INPUT_HASH_MISMATCH",
  "INPUT_IDENTITY_UNAVAILABLE",
  "INPUT_NOT_REGULAR",
  "INPUT_SIZE_MISMATCH",
  "INPUT_SYMLINK_REJECTED",
  "INPUT_TYPE_INVALID",
  "MID_RUN_IDENTITY_DRIFT",
  "PLATFORM_MISMATCH",
  "POST_RUN_IDENTITY_DRIFT",
  "PRIVATE_BASENAME_INVALID",
  "PRIVATE_FILE_IDENTITY_INVALID",
  "PRIVATE_GENERATION_CLOSE_FAILED",
  "PRIVATE_GENERATION_IDENTITY_DRIFT",
  "PRIVATE_GENERATION_MODE_INVALID",
  "PRIVATE_GENERATION_ROOT_UNSAFE",
  "PRIVATE_REOPEN_FAILED",
  "PRIVATE_REOPEN_MISMATCH",
  "PRIVATE_WRITE_FAILED",
  "PROCESS_GROUP_INSPECTION_FAILED",
  "PROCESS_GROUP_NOT_EMPTY",
  "PROCESS_GROUP_TERMINATION_FAILED",
  "PROCESS_LIMIT_INVALID",
  "PROCESS_SPAWN_FAILED",
  "PUBLIC_KEY_ARMOR_INVALID",
  "PUBLIC_PROJECTION_UNSAFE",
  "RUNTIME_TREE_MISMATCH",
  "SOURCE_IDENTITY_DRIFT",
  "SOURCE_RECEIPT_COPY_MISMATCH",
  "SOURCE_RECEIPT_INVALID",
  "STAGED_FIXTURE_DRIFT",
  "VALIDATOR_TREE_MISMATCH",
  "VALIDATOR_VERSION_MISMATCH",
]);

function argumentFailure() {
  const error = new Error("invalid arguments");
  error.code = "ARGUMENT_INVALID";
  return error;
}

function parseArguments(argv) {
  const options = { contractPath: DEFAULT_CONTRACT };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!(option in OPTION_NAMES)
      || seen.has(option)
      || typeof value !== "string"
      || value.length === 0
      || value.startsWith("--")) {
      throw argumentFailure();
    }
    seen.add(option);
    options[OPTION_NAMES[option]] = value;
  }
  if (REQUIRED_OPTIONS.some(option => !seen.has(option))) {
    throw argumentFailure();
  }
  return options;
}

function failureEnvelope(error) {
  return {
    failure_envelope_version: 1,
    publication_authorized: false,
    result: "failed",
    code: REVIEWED_FAILURE_CODES.has(error?.code)
      ? error.code
      : "EVALUATION_FAILED",
  };
}

function writeStream(stream, bytes) {
  return new Promise((resolve, reject) => {
    stream.write(bytes, error => error ? reject(error) : resolve());
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { runFormalAccessibilityV2Evaluation } =
    await import("../test/eval/accessibility-formal-v2.js");
  const result = await runFormalAccessibilityV2Evaluation(options);
  await writeStream(
    process.stdout,
    `${JSON.stringify(result.public_projection, null, 2)}\n`
  );
  if (!result.passed) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  const envelope = failureEnvelope(error);
  try {
    await writeStream(process.stderr, `${JSON.stringify(envelope)}\n`);
  } catch {
    // The failure channel itself is unavailable. Do not fall back to raw errors.
  }
}
