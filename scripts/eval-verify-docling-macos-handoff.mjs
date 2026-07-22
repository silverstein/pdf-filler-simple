#!/usr/bin/env node

import { verifyDoclingHandoff } from "../test/eval/extraction-docling-handoff-verifier.js";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

verifyDoclingHandoff({
  receiptPath: option("--receipt"),
  expectedReceiptSha256: option("--expected-receipt-sha256"),
  protectedRootsJson: option("--protected-roots-json"),
}).then(result => {
  process.stdout.write(`${JSON.stringify({ verified: true, handoff_id: result.receipt.handoff_id, receipt_sha256: result.receipt_sha256 })}\n`);
}).catch(error => {
  process.stderr.write(`Docling handoff verification failed: ${error.message}\n`);
  process.exitCode = 1;
});
