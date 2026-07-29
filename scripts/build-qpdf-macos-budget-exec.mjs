#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  compileQpdfMacosBudgetExec,
} from "../test/eval/qpdf-macos-budget-exec.js";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function main() {
  if (process.platform !== "darwin" || process.argv.length !== 5) {
    throw new Error(
      "Usage: build-qpdf-macos-budget-exec.mjs "
      + "/canonical/source.c /canonical/output /canonical/build-receipt.json",
    );
  }
  const [, , requestedSource, requestedOutput, requestedReceipt] = process.argv;
  const sourcePath = path.resolve(requestedSource);
  const outputPath = path.resolve(requestedOutput);
  const receiptPath = path.resolve(requestedReceipt);
  if (sourcePath !== requestedSource || outputPath !== requestedOutput
      || receiptPath !== requestedReceipt
      || path.dirname(outputPath) !== path.dirname(receiptPath)) {
    throw new Error("Build paths must be canonical, absolute, and share an output parent.");
  }
  await fs.lstat(receiptPath).then(
    () => { throw new Error("Refusing to overwrite a qpdf budget build receipt."); },
    error => {
      if (error?.code !== "ENOENT") throw error;
    },
  );
  const receipt = await compileQpdfMacosBudgetExec({
    sourcePath,
    outputPath,
    testing: false,
  });
  const bytes = Buffer.from(`${canonicalJson(receipt)}\n`, "utf8");
  const handle = await fs.open(
    receiptPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  process.stdout.write(`${canonicalJson({
    protocol: "pdf-tools.macos-qpdf-budget-exec-built.v1",
    binary: receipt.binary,
    build_receipt: {
      path: receiptPath,
      bytes: bytes.length,
    },
  })}\n`);
}

main().catch(error => {
  process.stderr.write(`QPDF budget launcher build failed: ${error.message}\n`);
  process.exitCode = 1;
});
