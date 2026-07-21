#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
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

async function assertNoSymlinkComponents(targetPath, label) {
  const absolute = path.resolve(targetPath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const entry = await fs.lstat(current);
      if (entry.isSymbolicLink()) throw new Error(`${label} must not contain symbolic links`);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
  return absolute;
}

function containedTarget(root, filename, label) {
  const target = path.resolve(root, filename);
  const relative = path.relative(root, target);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error(`${label} output path escapes the corpus directory`);
  }
  return target;
}

async function writeNewRegularFile(target, bytes, label) {
  try {
    const existing = await fs.lstat(target);
    if (existing.isSymbolicLink()) throw new Error(`${label} output target must not be a symbolic link`);
    throw new Error(`${label} output target already exists`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const flags = fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | fsConstants.O_WRONLY
    | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(target, flags, 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  const entry = await fs.lstat(target);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`${label} output must be a regular non-symlink file`);
  }
}

export async function fetchFormalAccessibilityCorpus({
  contractPath = DEFAULT_CONTRACT,
  outputDirectory,
  fetchImpl = fetch,
}) {
  if (!outputDirectory) throw new Error("outputDirectory is required");
  const { contract } = await loadFormalAccessibilityContract(contractPath);
  const requestedRoot = await assertNoSymlinkComponents(outputDirectory, "Formal corpus output directory");
  await fs.mkdir(requestedRoot, { recursive: true });
  await assertNoSymlinkComponents(requestedRoot, "Formal corpus output directory");
  const root = await fs.realpath(requestedRoot);
  const results = [];
  for (const fixture of contract.fixtures) {
    const target = containedTarget(root, fixture.filename, fixture.id);
    await assertNoSymlinkComponents(path.dirname(target), `${fixture.id} output parent`);
    try {
      const existing = await fs.lstat(target);
      if (existing.isSymbolicLink()) {
        throw new Error(`${fixture.id} output target must not be a symbolic link`);
      }
      throw new Error(`${fixture.id} output target already exists`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const response = await fetchImpl(fixture.source_url, { redirect: "follow" });
    if (!response.ok) throw new Error(`${fixture.id} download failed with HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = sha256(bytes);
    if (digest !== fixture.sha256) {
      throw new Error(`${fixture.id} downloaded SHA-256 mismatch`);
    }
    await writeNewRegularFile(target, bytes, fixture.id);
    const resolvedTarget = await fs.realpath(target);
    if (path.dirname(resolvedTarget) !== root) {
      throw new Error(`${fixture.id} output resolved outside the corpus directory`);
    }
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
