import fs from "node:fs/promises";
import { writePdfOutputAtomic } from "../../server/helpers.js";

const [originalDirectory, movedDirectory, outsideDirectory] = process.argv.slice(2);
if (!originalDirectory || !movedDirectory || !outsideDirectory) {
  throw new Error("Expected original, moved, and outside directory arguments.");
}

await writePdfOutputAtomic("anchored.md", Buffer.from("anchored Markdown bytes"), {
  anchoredDirectory: true,
  overwrite: false,
  token: "anchored-directory-child",
  async onTransition(transition) {
    if (transition === "journal_staging") {
      await fs.rename(originalDirectory, movedDirectory);
      await fs.symlink(outsideDirectory, originalDirectory);
    }
  },
});
