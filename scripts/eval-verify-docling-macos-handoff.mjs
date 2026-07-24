#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

const selfPath = fileURLToPath(import.meta.url);
const sealedVerifier = new URL("./extraction-docling-handoff-verifier.js", import.meta.url);
const repositoryVerifier = new URL("../test/eval/extraction-docling-handoff-verifier.js", import.meta.url);
const isSealedBootstrap = path.basename(path.dirname(selfPath)).startsWith(".bootstrap-seal.");
const verifierUrl = isSealedBootstrap ? sealedVerifier : repositoryVerifier;
const { runDoclingAuthority } = await import(verifierUrl);

function option(name, required = true) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    if (!required) return null;
    throw new Error(`${name} is required`);
  }
  return process.argv[index + 1];
}

async function main() {
  const action = option("--action", false) ?? "verify";
  if (!["verify", "setup"].includes(action)) {
    throw new Error("Candidate execution is retained-bakeoff-capture-only");
  }
  const result = await runDoclingAuthority({
    receiptPath: option("--receipt"),
    expectedReceiptSha256: option("--expected-receipt-sha256"),
    protectedRootsJson: option("--protected-roots-json"),
    action,
    additionalArgs: [],
    input: null,
    launcherPath: fileURLToPath(import.meta.url),
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}

main().catch(error => {
  process.stderr.write(`Docling handoff launcher failed: ${error.message}\n`);
  process.exitCode = 1;
});
