import path from "node:path";
import { writePdfOutputsAtomic } from "../../server/helpers.js";

const [directoryPath, transition] = process.argv.slice(2);
if (!directoryPath || !transition) process.exit(64);

const entries = [
  { targetPath: path.join(directoryPath, "first.pdf"), bytes: Buffer.from("first replacement") },
  { targetPath: path.join(directoryPath, "second.pdf"), bytes: Buffer.from("second replacement") },
];

await writePdfOutputsAtomic(entries, {
  token: `crash-${transition}`,
  async onTransition(observed) {
    if (observed === transition) process.exit(86);
  },
});

process.exit(0);
