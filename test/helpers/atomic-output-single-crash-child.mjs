import fs from "node:fs/promises";
import { writePdfOutputAtomic } from "../../server/helpers.js";

const [targetPath, replacementPath, transition] = process.argv.slice(2);
if (!targetPath || !replacementPath || !transition) process.exit(64);

await writePdfOutputAtomic(targetPath, await fs.readFile(replacementPath), {
  token: `single-crash-${transition}`,
  async onTransition(observed) {
    if (observed === transition) process.exit(86);
  },
});

process.exit(0);
