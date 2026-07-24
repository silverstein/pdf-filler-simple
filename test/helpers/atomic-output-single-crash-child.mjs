import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { writePdfOutputAtomic } from "../../server/helpers.js";

const [targetPath, replacementPath, transition] = process.argv.slice(2);
if (!targetPath || !replacementPath || !transition) process.exit(64);

const [canonicalPath, targetBytes, targetStats, replacementBytes] = await Promise.all([
  fs.realpath(targetPath),
  fs.readFile(targetPath),
  fs.stat(targetPath),
  fs.readFile(replacementPath),
]);

await writePdfOutputAtomic(targetPath, replacementBytes, {
  overwrite: true,
  expectedExistingIdentity: {
    canonicalPath,
    sizeBytes: targetStats.size,
    sha256: createHash("sha256").update(targetBytes).digest("hex"),
  },
  token: `single-crash-${transition}`,
  async onTransition(observed) {
    if (observed === transition) process.exit(86);
  },
});

process.exit(0);
