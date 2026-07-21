import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, describe, expect, it } from "vitest";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories = [];

afterAll(async () => {
  await Promise.all(temporaryDirectories.map(removeTestTempDirectory));
});

describe("test temp directories", () => {
  it("allocates distinct checkout-local roots and removes them idempotently", async () => {
    const first = await createTestTempDirectory(repoRoot, "helper-proof");
    const second = await createTestTempDirectory(repoRoot, "helper-proof");
    temporaryDirectories.push(first, second);

    expect(first).not.toBe(second);
    expect(path.dirname(first)).toBe(repoRoot);
    expect(path.basename(first)).toMatch(/^\.test-tmp-helper-proof-/);

    await removeTestTempDirectory(first);
    await removeTestTempDirectory(first);
    await expect(fs.access(first)).rejects.toThrow();
    await expect(fs.access(second)).resolves.toBeUndefined();
  });

  it("rejects labels that could escape or collapse the unique prefix", async () => {
    await expect(createTestTempDirectory(repoRoot, "../escape")).rejects.toThrow(
      "Invalid test temp directory label"
    );
  });
});
