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

async function boundedStdin(maxBytes) {
  const chunks = []; let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("Docling launcher stdin exceeds its ceiling");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function main() {
  const action = option("--action", false) ?? "verify";
  const additionalArgs = [];
  for (const name of action === "execute" ? ["--finalization", "--expected-finalization-sha256"]
    : action === "probe" ? ["--finalization", "--expected-finalization-sha256", "--attempt-dir", "--request"] : []) {
    additionalArgs.push(name, option(name));
  }
  const result = await runDoclingAuthority({
    receiptPath: option("--receipt"),
    expectedReceiptSha256: option("--expected-receipt-sha256"),
    protectedRootsJson: option("--protected-roots-json"),
    action,
    additionalArgs,
    input: action === "execute" ? await boundedStdin(16 * 1024 * 1024) : null,
    launcherPath: fileURLToPath(import.meta.url),
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}

main().catch(error => {
  process.stderr.write(`Docling handoff launcher failed: ${error.message}\n`);
  process.exitCode = 1;
});
