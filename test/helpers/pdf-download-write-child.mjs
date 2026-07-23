import fs from "node:fs/promises";
import { writePdfDownloadAtomic } from "../../server/helpers.js";

const [targetPath, sourcePath, barrierPath] = process.argv.slice(2);
if (!targetPath || !sourcePath || !barrierPath) process.exit(64);

const bytes = await fs.readFile(sourcePath);
process.stdout.write("READY\n");
while (true) {
  try {
    await fs.access(barrierPath);
    break;
  } catch {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

const result = await writePdfDownloadAtomic(targetPath, bytes);
process.stdout.write(`${JSON.stringify(result)}\n`);
