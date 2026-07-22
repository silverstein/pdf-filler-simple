#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultDoclingMacRoots,
  phase0PdfPaths,
  prepareDoclingMacHandoff,
} from "../test/eval/extraction-docling-handoff.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

function parseArgs(argv) {
  const values = { cacheRoot: null, sidecarRoot: null, fixtures: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (["--cache-root", "--sidecar-root", "--fixture"].includes(argument) && !value) throw new Error(`${argument} requires a value`);
    if (argument === "--cache-root") values.cacheRoot = path.resolve(value);
    else if (argument === "--sidecar-root") values.sidecarRoot = path.resolve(value);
    else if (argument === "--fixture") values.fixtures.push(path.resolve(value));
    else throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const defaults = defaultDoclingMacRoots();
  const result = await prepareDoclingMacHandoff({
    repoRoot: REPO_ROOT,
    cacheRoot: args.cacheRoot ?? defaults.cacheRoot,
    sidecarRoot: args.sidecarRoot ?? defaults.sidecarRoot,
    protectedRoots: defaults.protectedRoots,
    fixturePaths: args.fixtures.length ? args.fixtures : await phase0PdfPaths(REPO_ROOT),
  });
  process.stdout.write(`${JSON.stringify({
    handoff_id: result.receipt.handoff_id,
    receipt_path: result.receiptPath,
    receipt_sha256: result.receipt_sha256,
    protected_roots_json: result.protected_roots_json,
    execution_state: result.receipt.execution_state,
  })}\n`);
}

main().catch(error => {
  process.stderr.write(`Docling handoff failed: ${error.message}\n`);
  process.exitCode = 1;
});
