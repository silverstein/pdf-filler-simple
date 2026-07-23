import fs from "node:fs/promises";
import path from "node:path";
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
  await writePdfOutputAtomic(
    path.join(outputDirectory, "first.pdf"),
    Buffer.from("first replacement"),
    {
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
