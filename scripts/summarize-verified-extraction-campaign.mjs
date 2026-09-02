#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { buildVerifiedExtractionCampaignCompletionSummary } from "./verified-extraction-response-controller.mjs";

function assertion(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(argv) {
  const options = {
    indexPath: null,
    indexSha256: null,
    expectedBindingsPath: null,
    expectedBindingsSha256: null,
    receiptPaths: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    assertion([
      "--index", "--index-sha256", "--expected-bindings",
      "--expected-bindings-sha256", "--receipt",
    ].includes(flag),
      `Unknown argument: ${flag}`);
    const value = argv[index + 1];
    assertion(typeof value === "string" && value.length > 0 && !value.startsWith("--"),
      `${flag} requires an explicit file path`);
    index += 1;
    if (flag === "--index") {
      assertion(options.indexPath === null, "--index may be supplied only once");
      options.indexPath = value;
    } else if (flag === "--index-sha256") {
      assertion(options.indexSha256 === null, "--index-sha256 may be supplied only once");
      options.indexSha256 = value;
    } else if (flag === "--expected-bindings") {
      assertion(options.expectedBindingsPath === null,
        "--expected-bindings may be supplied only once");
      options.expectedBindingsPath = value;
    } else if (flag === "--expected-bindings-sha256") {
      assertion(options.expectedBindingsSha256 === null,
        "--expected-bindings-sha256 may be supplied only once");
      options.expectedBindingsSha256 = value;
    } else {
      options.receiptPaths.push(value);
    }
  }
  assertion(options.indexPath !== null, "--index is required");
  assertion(options.indexSha256 !== null, "--index-sha256 is required");
  assertion(options.expectedBindingsPath !== null, "--expected-bindings is required");
  assertion(options.expectedBindingsSha256 !== null, "--expected-bindings-sha256 is required");
  assertion(options.receiptPaths.length > 0, "at least one --receipt is required");
  assertion(new Set(options.receiptPaths).size === options.receiptPaths.length,
    "--receipt paths must be unique");
  return options;
}

export async function summarizeVerifiedExtractionCampaignFiles(argv) {
  const options = parseArguments(argv);
  const [executionIndexBytes, expectedBindingBytes, ...retainedReceiptBytes] = await Promise.all([
    readFile(options.indexPath),
    readFile(options.expectedBindingsPath),
    ...options.receiptPaths.map(receiptPath => readFile(receiptPath)),
  ]);
  return buildVerifiedExtractionCampaignCompletionSummary({
    executionIndexBytes,
    executionIndexPhysicalSha256: options.indexSha256,
    expectedBindingBytes,
    expectedBindingPhysicalSha256: options.expectedBindingsSha256,
    retainedReceiptBytes,
  });
}

async function main() {
  try {
    const summary = await summarizeVerifiedExtractionCampaignFiles(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Campaign completion summary failed: ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
