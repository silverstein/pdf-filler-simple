import fs from "fs/promises";
import path from "path";

export async function createTestTempDirectory(repoRoot, label) {
  if (!/^[a-z0-9-]+$/i.test(label)) {
    throw new Error(`Invalid test temp directory label: ${label}`);
  }
  return fs.mkdtemp(path.join(repoRoot, `.test-tmp-${label}-`));
}

export async function removeTestTempDirectory(directory) {
  if (directory) {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
