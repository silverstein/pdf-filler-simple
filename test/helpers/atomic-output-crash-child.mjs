import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writePdfOutputsAtomic } from "../../server/helpers.js";

const [directoryPath, transition] = process.argv.slice(2);
if (!directoryPath || !transition) process.exit(64);

async function replacementEntry(targetPath, bytes) {
  try {
    const [canonicalPath, existingBytes, stats] = await Promise.all([
      fs.realpath(targetPath),
      fs.readFile(targetPath),
      fs.stat(targetPath),
    ]);
    return {
      targetPath,
      bytes,
      overwrite: true,
      expectedExistingIdentity: {
        canonicalPath,
        sizeBytes: stats.size,
        sha256: createHash("sha256").update(existingBytes).digest("hex"),
      },
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { targetPath, bytes };
  }
}

const entries = await Promise.all([
  replacementEntry(path.join(directoryPath, "first.pdf"), Buffer.from("first replacement")),
  replacementEntry(path.join(directoryPath, "second.pdf"), Buffer.from("second replacement")),
]);

await writePdfOutputsAtomic(entries, {
  token: `crash-${transition}`,
  async onTransition(observed) {
    if (observed === transition) process.exit(86);
  },
});

process.exit(0);
