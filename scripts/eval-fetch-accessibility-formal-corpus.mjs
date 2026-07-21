#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadFormalAccessibilityContract } from "../test/eval/accessibility-formal.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONTRACT = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "eval",
  "accessibility",
  "formal-corpus.v1.json"
);

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a value`);
  return process.argv[index + 1];
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function fetchFormalAccessibilityCorpus({
  contractPath = DEFAULT_CONTRACT,
  outputDirectory,
  fetchImpl = fetch,
}) {
  if (!outputDirectory) throw new Error("outputDirectory is required");
  const { contract } = await loadFormalAccessibilityContract(contractPath);
  await fs.mkdir(outputDirectory, { recursive: true });
  const root = await fs.realpath(outputDirectory);
  const results = [];
  for (const fixture of contract.fixtures) {
    const response = await fetchImpl(fixture.source_url, { redirect: "follow" });
    if (!response.ok) throw new Error(`${fixture.id} download failed with HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = sha256(bytes);
    if (digest !== fixture.sha256) {
      throw new Error(`${fixture.id} downloaded SHA-256 mismatch`);
    }
    const target = path.join(root, fixture.filename);
    await fs.writeFile(target, bytes, { flag: "wx" });
    results.push({ id: fixture.id, path: target, sha256: digest });
  }
  return {
    corpus: contract.corpus.name,
    corpus_commit: contract.corpus.commit,
    license: contract.corpus.license_spdx_id,
    output_directory: root,
    results,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await fetchFormalAccessibilityCorpus({
    contractPath: option("--contract", DEFAULT_CONTRACT),
    outputDirectory: option("--output-dir", null),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
