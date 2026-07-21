#!/usr/bin/env node
import path from "node:path";
import { verifyFidelityRunBundle } from "../test/eval/fidelity-run-bundle.js";

const requestedRoot = process.argv[2];
if (!requestedRoot) throw new Error("Usage: node scripts/eval-verify-fidelity-run.mjs /path/to/private-output");
const result = await verifyFidelityRunBundle(path.resolve(requestedRoot));
if (!result.valid) {
  process.stderr.write(`${result.errors.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({ valid: true, passed: result.score.passed, denominator: result.score.denominator }, null, 2)}\n`);
}
