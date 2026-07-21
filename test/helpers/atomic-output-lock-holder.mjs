import path from "node:path";
import { writePdfOutputAtomic } from "../../server/helpers.js";

const [directoryPath] = process.argv.slice(2);
if (!directoryPath) process.exit(64);

await writePdfOutputAtomic(
  path.join(directoryPath, "held.pdf"),
  Buffer.from("held replacement"),
  {
    token: "lock-holder",
    async onTransition(observed) {
      if (observed !== "journal_staging") return;
      process.stdout.write("READY\n");
      process.stdin.resume();
      await new Promise(resolve => process.stdin.once("data", resolve));
    },
  },
);
