import { execFile } from "node:child_process";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  DIRECT_CHECKOUT_LOCAL_SCRATCH_ALLOCATORS,
} from "../scripts/test-suite-classification.mjs";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories = [];
const execFileAsync = promisify(execFile);
const checkoutLocalMkdtempPattern =
  /(?:\bfs\.)?mkdtemp\s*\(\s*path\.join\s*\(\s*(?:REPO_ROOT|repoRoot|repositoryRoot|process\.cwd\(\))\s*,\s*(["'`])([^"'`]+)\1/gs;

afterAll(async () => {
  await Promise.all(temporaryDirectories.map(removeTestTempDirectory));
});

describe("test temp directories", () => {
  it("keeps every direct checkout-local scratch allocator in the reviewed inventory", async () => {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoRoot, "ls-files", "-z", "--", "test", "scripts"],
      { encoding: "utf8" },
    );
    const sourceFiles = stdout
      .split("\0")
      .filter(filename => /\.(?:[cm]?[jt]s)$/.test(filename));
    const observed = [];

    for (const filename of sourceFiles) {
      const source = await fs.readFile(path.join(repoRoot, filename), "utf8");
      for (const match of source.matchAll(checkoutLocalMkdtempPattern)) {
        observed.push({
          file: filename,
          prefix: match[2],
          reason: DIRECT_CHECKOUT_LOCAL_SCRATCH_ALLOCATORS.find(
            allocation => allocation.file === filename && allocation.prefix === match[2],
          )?.reason,
        });
      }
    }

    expect(observed.sort((left, right) => left.file.localeCompare(right.file))).toEqual(
      [...DIRECT_CHECKOUT_LOCAL_SCRATCH_ALLOCATORS],
    );
  });

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
