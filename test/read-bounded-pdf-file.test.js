import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PDF_MERGE_AGGREGATE_LIMIT_MESSAGE,
  PDF_MERGE_MAX_TOTAL_BYTES,
  PDF_MUTATION_FILE_LIMIT_MESSAGE,
  PDF_MUTATION_MAX_FILE_BYTES,
  readBoundedPdfFileSafely,
  readPdfMutationInputsWithinMergeLimit,
} from "../server/bounded-pdf-file.js";

const CHANGED_MESSAGE = "PDF changed while it was being read. Retry the request.";

function createRaceFileSystem(hooks = {}) {
  const state = {
    beforeOpenRuns: 0,
    beforeReadRuns: 0,
    afterReadRuns: 0,
    beforeFinalRealpathRuns: 0,
    beforeFinalLstatRuns: 0,
    closeCount: 0,
    openFlags: [],
    openCount: 0,
    readCount: 0,
    realpathCount: 0,
    lstatCount: 0,
  };
  let readStarted = false;

  const fileSystem = {
    async realpath(filePath) {
      state.realpathCount += 1;
      if (state.realpathCount === 2 && hooks.beforeFinalRealpath) {
        state.beforeFinalRealpathRuns += 1;
        await hooks.beforeFinalRealpath(filePath);
      }
      return fs.realpath(filePath);
    },
    async lstat(filePath, options) {
      state.lstatCount += 1;
      if (state.lstatCount === 2 && hooks.beforeFinalLstat) {
        state.beforeFinalLstatRuns += 1;
        await hooks.beforeFinalLstat(filePath);
      }
      return fs.lstat(filePath, options);
    },
    async open(filePath, flags) {
      state.openCount += 1;
      state.openFlags.push(flags);
      if (hooks.beforeOpen) {
        state.beforeOpenRuns += 1;
        await hooks.beforeOpen(filePath);
      }
      const handle = await fs.open(filePath, flags);
      return {
        stat: options => handle.stat(options),
        async read(buffer, offset, length, position) {
          state.readCount += 1;
          if (!readStarted && hooks.beforeRead) {
            state.beforeReadRuns += 1;
            await hooks.beforeRead(filePath);
          }
          const boundedLength = hooks.maxReadBytes ? Math.min(length, hooks.maxReadBytes) : length;
          const result = await handle.read(buffer, offset, boundedLength, position);
          if (!readStarted) {
            readStarted = true;
            if (hooks.afterRead) {
              state.afterReadRuns += 1;
              await hooks.afterRead(filePath, result);
            }
          }
          return result;
        },
        async close() {
          state.closeCount += 1;
          return handle.close();
        },
      };
    },
  };
  return { fileSystem, state };
}

async function expectChanged(readPromise) {
  await expect(readPromise).rejects.toMatchObject({
    code: "PDF_CHANGED_DURING_READ",
    message: CHANGED_MESSAGE,
  });
}

describe("readBoundedPdfFileSafely", () => {
  let temporaryRoot;
  let pdfPath;
  let allowedPaths;

  beforeEach(async () => {
    temporaryRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-bounded-read-")),
    );
    pdfPath = path.join(temporaryRoot, "source.pdf");
    await fs.writeFile(pdfPath, Buffer.from("%PDF-stable-fixture"));
    allowedPaths = [];
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  const pathPolicy = canonicalPath => {
    allowedPaths.push(canonicalPath);
    if (!canonicalPath.startsWith(temporaryRoot + path.sep)) throw new Error("Path is outside the test root.");
  };

  it("returns the exact stable descriptor bytes and rechecks the canonical allowed path", async () => {
    const expected = await fs.readFile(pdfPath);
    const { fileSystem, state } = createRaceFileSystem();
    const result = await readBoundedPdfFileSafely(pdfPath, 1024, {
      fileSystem,
      constants: fsConstants,
      assertPathAllowed: pathPolicy,
    });

    expect(result.bytes.equals(expected)).toBe(true);
    expect(result.sizeBytes).toBe(expected.length);
    expect(result.canonicalPath).toBe(pdfPath);
    const sourceStats = await fs.stat(pdfPath, { bigint: true });
    expect(result.fileIdentity).toEqual({
      device: String(sourceStats.dev),
      inode: String(sourceStats.ino),
    });
    expect(allowedPaths).toEqual([pdfPath, pdfPath]);
    expect(state).toMatchObject({ openCount: 1, realpathCount: 2, lstatCount: 2, closeCount: 1 });
    if (Number.isInteger(fsConstants.O_NOFOLLOW)) {
      expect(state.openFlags[0] & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW);
    }
  });

  it("assembles an exact stable result across deterministic partial descriptor reads", async () => {
    const expected = await fs.readFile(pdfPath);
    const { fileSystem, state } = createRaceFileSystem({ maxReadBytes: 3 });
    const result = await readBoundedPdfFileSafely(pdfPath, 1024, {
      fileSystem,
      constants: fsConstants,
      assertPathAllowed: pathPolicy,
    });
    expect(result.bytes.equals(expected)).toBe(true);
    expect(state.readCount).toBe(Math.ceil(expected.length / 3));
    expect(state.closeCount).toBe(1);
  });

  it("does not open a file when the canonical allowed-path policy rejects it", async () => {
    const { fileSystem, state } = createRaceFileSystem();
    await expect(readBoundedPdfFileSafely(pdfPath, 1024, {
      fileSystem,
      constants: fsConstants,
      assertPathAllowed: () => { throw new Error("denied by policy"); },
    })).rejects.toThrow("denied by policy");
    expect(state.openCount).toBe(0);
  });

  it("uses only O_RDONLY when the host does not expose O_NOFOLLOW", async () => {
    const { fileSystem, state } = createRaceFileSystem();
    const result = await readBoundedPdfFileSafely(pdfPath, 1024, {
      fileSystem,
      constants: { O_RDONLY: fsConstants.O_RDONLY },
      assertPathAllowed: pathPolicy,
    });
    expect(result.bytes.toString()).toBe("%PDF-stable-fixture");
    expect(state.openFlags).toEqual([fsConstants.O_RDONLY]);
    expect(state.closeCount).toBe(1);
  });

  it("rejects growth after the descriptor read and closes the descriptor", async () => {
    const { fileSystem, state } = createRaceFileSystem({
      afterRead: async filePath => fs.appendFile(filePath, "-growth"),
    });
    await expectChanged(readBoundedPdfFileSafely(pdfPath, 1024, {
      fileSystem,
      constants: fsConstants,
      assertPathAllowed: pathPolicy,
    }));
    expect(state.afterReadRuns).toBe(1);
    expect((await fs.stat(pdfPath)).size).toBeGreaterThan(Buffer.byteLength("%PDF-stable-fixture"));
    expect(state.closeCount).toBe(1);
  });

  it("rejects truncation before the descriptor read and closes the descriptor", async () => {
    const { fileSystem, state } = createRaceFileSystem({
      beforeRead: async filePath => fs.truncate(filePath, 0),
    });
    await expectChanged(readBoundedPdfFileSafely(pdfPath, 1024, {
      fileSystem,
      constants: fsConstants,
      assertPathAllowed: pathPolicy,
    }));
    expect(state.beforeReadRuns).toBe(1);
    expect((await fs.stat(pdfPath)).size).toBe(0);
    expect(state.closeCount).toBe(1);
  });

  it("rejects same-inode timestamp drift and closes the descriptor", async () => {
    const future = new Date("2040-01-02T03:04:05.000Z");
    const { fileSystem, state } = createRaceFileSystem({
      afterRead: async filePath => fs.utimes(filePath, future, future),
    });
    await expectChanged(readBoundedPdfFileSafely(pdfPath, 1024, {
      fileSystem,
      constants: fsConstants,
      assertPathAllowed: pathPolicy,
    }));
    expect(state.afterReadRuns).toBe(1);
    expect((await fs.stat(pdfPath)).mtimeMs).toBe(future.getTime());
    expect(state.closeCount).toBe(1);
  });

  it.runIf(process.platform !== "win32")("rejects a same-size final pathname replacement by inode identity", async () => {
    const original = await fs.readFile(pdfPath);
    const { fileSystem, state } = createRaceFileSystem({
      afterRead: async filePath => {
        const replacement = path.join(temporaryRoot, "replacement.pdf");
        await fs.writeFile(replacement, Buffer.from(original).fill(0x58));
        await fs.rename(replacement, filePath);
      },
    });
    await expectChanged(readBoundedPdfFileSafely(pdfPath, 1024, {
      fileSystem,
      constants: fsConstants,
      assertPathAllowed: pathPolicy,
    }));
    expect(state.afterReadRuns).toBe(1);
    expect((await fs.readFile(pdfPath)).equals(original)).toBe(false);
    expect(state.closeCount).toBe(1);
  });

  it.runIf(process.platform === "linux")("uses O_NOFOLLOW to reject a final-component symlink inserted before open", async () => {
    expect(Number.isInteger(fsConstants.O_NOFOLLOW)).toBe(true);
    const movedPath = path.join(temporaryRoot, "moved.pdf");
    const { fileSystem, state } = createRaceFileSystem({
      beforeOpen: async filePath => {
        await fs.rename(filePath, movedPath);
        await fs.symlink(movedPath, filePath);
      },
    });
    await expectChanged(readBoundedPdfFileSafely(pdfPath, 1024, {
      fileSystem,
      constants: fsConstants,
      assertPathAllowed: pathPolicy,
    }));
    expect(state.beforeOpenRuns).toBe(1);
    expect(state.openFlags[0] & fsConstants.O_NOFOLLOW).toBe(fsConstants.O_NOFOLLOW);
    expect(state.closeCount).toBe(0);
  });

  it.runIf(process.platform === "linux")("falls back to O_RDONLY without O_NOFOLLOW and still detects a final symlink race", async () => {
    const movedPath = path.join(temporaryRoot, "moved-fallback.pdf");
    const { fileSystem, state } = createRaceFileSystem({
      beforeOpen: async filePath => {
        await fs.rename(filePath, movedPath);
        await fs.symlink(movedPath, filePath);
      },
    });
    await expectChanged(readBoundedPdfFileSafely(pdfPath, 1024, {
      fileSystem,
      constants: { O_RDONLY: fsConstants.O_RDONLY },
      assertPathAllowed: pathPolicy,
    }));
    expect(state.beforeOpenRuns).toBe(1);
    expect(state.openFlags).toEqual([fsConstants.O_RDONLY]);
    expect(state.closeCount).toBe(1);
  });

  it.runIf(process.platform === "linux")("rejects a final symlink inserted after the descriptor identity check", async () => {
    const movedPath = path.join(temporaryRoot, "moved-after-read.pdf");
    const { fileSystem, state } = createRaceFileSystem({
      beforeFinalLstat: async filePath => {
        await fs.rename(filePath, movedPath);
        await fs.symlink(movedPath, filePath);
      },
    });
    await expectChanged(readBoundedPdfFileSafely(pdfPath, 1024, {
      fileSystem,
      constants: fsConstants,
      assertPathAllowed: pathPolicy,
    }));
    expect(state.beforeFinalLstatRuns).toBe(1);
    expect((await fs.lstat(pdfPath)).isSymbolicLink()).toBe(true);
    expect(state.closeCount).toBe(1);
  });

  it.runIf(process.platform === "linux")("rejects an ancestor-directory symlink swap on the final canonical check", async () => {
    const ancestor = path.join(temporaryRoot, "ancestor");
    const movedAncestor = path.join(temporaryRoot, "ancestor-moved");
    await fs.mkdir(ancestor);
    pdfPath = path.join(ancestor, "source.pdf");
    await fs.writeFile(pdfPath, "%PDF-ancestor-fixture");
    const { fileSystem, state } = createRaceFileSystem({
      beforeFinalRealpath: async () => {
        await fs.rename(ancestor, movedAncestor);
        await fs.symlink(movedAncestor, ancestor);
      },
    });
    await expectChanged(readBoundedPdfFileSafely(pdfPath, 1024, {
      fileSystem,
      constants: fsConstants,
      assertPathAllowed: pathPolicy,
    }));
    expect(state.beforeFinalRealpathRuns).toBe(1);
    expect(await fs.realpath(ancestor)).toBe(movedAncestor);
    expect(state.closeCount).toBe(1);
  });

  it("closes the descriptor when the bound check rejects the file", async () => {
    const { fileSystem, state } = createRaceFileSystem();
    await expect(readBoundedPdfFileSafely(pdfPath, 3, {
      fileSystem,
      constants: fsConstants,
      assertPathAllowed: pathPolicy,
    })).rejects.toThrow("read_pdf_layout accepts source PDFs up to 250 MiB.");
    expect(state.closeCount).toBe(1);
  });

  it("uses the caller's stable typed resource-limit error and still closes the descriptor", async () => {
    const { fileSystem, state } = createRaceFileSystem();
    await expect(readBoundedPdfFileSafely(pdfPath, 3, {
      fileSystem,
      constants: fsConstants,
      assertPathAllowed: pathPolicy,
      createSizeLimitError() {
        const error = new Error(PDF_MUTATION_FILE_LIMIT_MESSAGE);
        error.code = "PDF_INPUT_TOO_LARGE";
        return error;
      },
    })).rejects.toMatchObject({
      code: "PDF_INPUT_TOO_LARGE",
      message: PDF_MUTATION_FILE_LIMIT_MESSAGE,
    });
    expect(state.closeCount).toBe(1);
  });
});

describe("merge PDF input allocation budget", () => {
  const TEST_MAX_FILE_BYTES = 250;
  const TEST_MAX_TOTAL_BYTES = 500;

  function budgetedReader(sizes, calls) {
    let index = 0;
    return async (resolvedPath, maxBytes, createSizeLimitError) => {
      const sizeBytes = sizes[index];
      index += 1;
      calls.push({ resolvedPath, maxBytes });
      if (sizeBytes > maxBytes) throw createSizeLimitError();
      return { resolvedPath, sizeBytes, pdfBytes: Buffer.alloc(sizeBytes) };
    };
  }

  it("allows the exact 250 MiB per-file and 500 MiB aggregate boundaries", async () => {
    expect(PDF_MUTATION_MAX_FILE_BYTES).toBe(250 * 1024 * 1024);
    expect(PDF_MERGE_MAX_TOTAL_BYTES).toBe(500 * 1024 * 1024);
    const calls = [];
    const result = await readPdfMutationInputsWithinMergeLimit(["first.pdf", "second.pdf"], {
      readInput: budgetedReader(
        [TEST_MAX_FILE_BYTES, TEST_MAX_FILE_BYTES],
        calls,
      ),
      maxFileBytes: TEST_MAX_FILE_BYTES,
      maxTotalBytes: TEST_MAX_TOTAL_BYTES,
    });
    expect(result.totalSizeBytes).toBe(TEST_MAX_TOTAL_BYTES);
    expect(result.inputs).toHaveLength(2);
    expect(calls).toEqual([
      { resolvedPath: "first.pdf", maxBytes: TEST_MAX_FILE_BYTES },
      { resolvedPath: "second.pdf", maxBytes: TEST_MAX_FILE_BYTES },
    ]);
  });

  it("rejects 250 MiB plus one byte with the per-file resource error", async () => {
    await expect(readPdfMutationInputsWithinMergeLimit(["oversize.pdf"], {
      readInput: budgetedReader([TEST_MAX_FILE_BYTES + 1], []),
      maxFileBytes: TEST_MAX_FILE_BYTES,
      maxTotalBytes: TEST_MAX_TOTAL_BYTES,
    })).rejects.toMatchObject({
      code: "PDF_INPUT_TOO_LARGE",
      message: PDF_MUTATION_FILE_LIMIT_MESSAGE,
    });
  });

  it("passes only the remaining aggregate budget to the reader before rejecting 500 MiB plus one byte", async () => {
    const calls = [];
    await expect(readPdfMutationInputsWithinMergeLimit(
      ["first.pdf", "second.pdf", "one-byte-too-many.pdf"],
      {
        readInput: budgetedReader(
          [TEST_MAX_FILE_BYTES, TEST_MAX_FILE_BYTES, 1],
          calls,
        ),
        maxFileBytes: TEST_MAX_FILE_BYTES,
        maxTotalBytes: TEST_MAX_TOTAL_BYTES,
      },
    )).rejects.toMatchObject({
      code: "PDF_MERGE_INPUTS_TOO_LARGE",
      message: PDF_MERGE_AGGREGATE_LIMIT_MESSAGE,
    });
    expect(calls).toEqual([
      { resolvedPath: "first.pdf", maxBytes: TEST_MAX_FILE_BYTES },
      { resolvedPath: "second.pdf", maxBytes: TEST_MAX_FILE_BYTES },
      { resolvedPath: "one-byte-too-many.pdf", maxBytes: 0 },
    ]);
  });

  it("uses the exact remaining allowance when the aggregate is tighter than the per-file limit", async () => {
    const calls = [];
    const firstSize = TEST_MAX_FILE_BYTES;
    const secondSize = TEST_MAX_FILE_BYTES - 10;
    const result = await readPdfMutationInputsWithinMergeLimit(
      ["first.pdf", "second.pdf", "final.pdf"],
      {
        readInput: budgetedReader([firstSize, secondSize, 10], calls),
        maxFileBytes: TEST_MAX_FILE_BYTES,
        maxTotalBytes: TEST_MAX_TOTAL_BYTES,
      },
    );
    expect(result.totalSizeBytes).toBe(TEST_MAX_TOTAL_BYTES);
    expect(calls.at(-1)).toEqual({ resolvedPath: "final.pdf", maxBytes: 10 });
  });
});
