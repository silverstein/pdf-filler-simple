import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { writePdfOutputAtomic } from "../../server/helpers.js";

const [
  outputDirectory,
  ancestorDirectory,
  movedAncestor,
  substitutedAncestor,
  swapPhase,
] = process.argv.slice(2);
if (
  !outputDirectory
  || !ancestorDirectory
  || !movedAncestor
  || !substitutedAncestor
  || !swapPhase
) {
  process.exit(64);
}

let swapped = false;
try {
  const targetPath = path.join(outputDirectory, "first.pdf");
  const [canonicalPath, targetBytes, targetStats] = await Promise.all([
    fs.realpath(targetPath),
    fs.readFile(targetPath),
    fs.stat(targetPath),
  ]);
  await writePdfOutputAtomic(
    targetPath,
    Buffer.from("first replacement"),
    {
      overwrite: true,
      expectedExistingIdentity: {
        canonicalPath,
        sizeBytes: targetStats.size,
        sha256: createHash("sha256").update(targetBytes).digest("hex"),
      },
      token: `directory-swap-${swapPhase}`,
      async beforeDirectoryGuard(phase) {
        if (swapped || phase !== swapPhase) return;
        await fs.rename(ancestorDirectory, movedAncestor);
        await fs.symlink(substitutedAncestor, ancestorDirectory);
        swapped = true;
      },
    },
  );
  process.exit(65);
} catch (error) {
  if (swapped && error?.code === "ATOMIC_OUTPUT_DIRECTORY_CHANGED") {
    process.exit(73);
  }
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(74);
}
