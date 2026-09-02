#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyVerifiedExtractionContract } from "../test/eval/verified-extraction-contract.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootFlag = process.argv.indexOf("--benchmark-root");
const benchmarkRoot = rootFlag >= 0
  ? path.resolve(process.argv[rootFlag + 1])
  : path.join(repoRoot, "test", "fixtures", "eval", "verified-extraction");
const result = await verifyVerifiedExtractionContract({ benchmarkRoot, repoRoot });
process.stdout.write(`${JSON.stringify({
  benchmark_id: result.manifest.benchmark_id,
  manifest_sha256: result.manifest_sha256,
  deterministic_denominators: result.totals,
  benchmark_claim_ready: result.manifest.claim_boundary.benchmark_claim_ready,
})}\n`);
