import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  writePdfOutputAtomic,
  writePdfOutputsAtomic,
} from "../server/helpers.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

let tempDir;

function injectedError(code, operation) {
  const error = new Error(`Injected ${operation} failure`);
  error.code = code;
  return error;
}

function faultingFs({
  openAt = null,
  writeAt = null,
  syncAt = null,
  syncCode = "EIO",
  renameAt = null,
  unlinkAt = null,
  beforeLstatAt = null,
} = {}) {
  const counts = { open: 0, write: 0, sync: 0, rename: 0, unlink: 0, lstat: 0 };
  return {
    async open(...args) {
      counts.open += 1;
      if (counts.open === openAt) throw injectedError("EACCES", "open");
      const handle = await fs.open(...args);
      return {
        async writeFile(...writeArgs) {
          counts.write += 1;
          if (counts.write === writeAt) throw injectedError("ENOSPC", "write");
          return await handle.writeFile(...writeArgs);
        },
        async sync() {
          counts.sync += 1;
          if (counts.sync === syncAt) throw injectedError(syncCode, "sync");
          return await handle.sync();
        },
        async close() {
          return await handle.close();
        },
      };
    },
    async lstat(...args) {
      counts.lstat += 1;
      if (counts.lstat === beforeLstatAt?.at) await beforeLstatAt.run();
      return await fs.lstat(...args);
    },
    async rename(...args) {
      counts.rename += 1;
      if (counts.rename === renameAt) throw injectedError("EIO", "rename");
      return await fs.rename(...args);
    },
    async unlink(...args) {
      counts.unlink += 1;
      if (counts.unlink === unlinkAt) throw injectedError("EBUSY", "unlink");
      return await fs.unlink(...args);
    },
  };
}

async function expectNoTransactionArtifacts() {
  const entries = await fs.readdir(tempDir);
  expect(entries.filter(name => name.includes(".pdf-tools-")).sort()).toEqual([]);
}

beforeEach(async () => {
  tempDir = await createTestTempDirectory(process.cwd(), "atomic-output");
});

afterEach(async () => {
  await removeTestTempDirectory(tempDir);
});

describe("atomic PDF output commits", () => {
  it("preserves an existing output when the staged write runs out of space", async () => {
    const target = path.join(tempDir, "existing.pdf");
    await fs.writeFile(target, "original bytes");

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      fsOps: faultingFs({ writeAt: 1 }),
      token: "disk-full",
    })).rejects.toMatchObject({ code: "ENOSPC" });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("original bytes");
    await expectNoTransactionArtifacts();
  });

  it("preserves an existing output when staging is denied", async () => {
    const target = path.join(tempDir, "existing.pdf");
    await fs.writeFile(target, "original bytes");

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      fsOps: faultingFs({ openAt: 1 }),
      token: "permission",
    })).rejects.toMatchObject({ code: "EACCES" });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("original bytes");
    await expectNoTransactionArtifacts();
  });

  it("rolls back a replacement when the output directory cannot be synced", async () => {
    const target = path.join(tempDir, "existing.pdf");
    await fs.writeFile(target, "original bytes");

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      fsOps: faultingFs({ syncAt: 2 }),
      token: "directory-sync",
    })).rejects.toMatchObject({ code: "EIO" });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("original bytes");
    await expectNoTransactionArtifacts();
  });

  it("commits when the filesystem explicitly does not support directory fsync", async () => {
    const target = path.join(tempDir, "existing.pdf");
    await fs.writeFile(target, "original bytes");

    await writePdfOutputAtomic(target, Buffer.from("replacement"), {
      fsOps: faultingFs({ syncAt: 2, syncCode: "ENOTSUP" }),
      token: "unsupported-directory-sync",
    });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("replacement");
    await expectNoTransactionArtifacts();
  });

  it("rolls every output back after a mid-batch rename failure", async () => {
    const first = path.join(tempDir, "first.pdf");
    const second = path.join(tempDir, "second.pdf");
    await fs.writeFile(first, "first original");
    await fs.writeFile(second, "second original");

    await expect(writePdfOutputsAtomic([
      { targetPath: first, bytes: Buffer.from("first replacement") },
      { targetPath: second, bytes: Buffer.from("second replacement") },
    ], {
      fsOps: faultingFs({ renameAt: 4 }),
      token: "mid-rename",
    })).rejects.toMatchObject({ code: "EIO" });

    await expect(fs.readFile(first, "utf8")).resolves.toBe("first original");
    await expect(fs.readFile(second, "utf8")).resolves.toBe("second original");
    await expectNoTransactionArtifacts();
  });

  it("does not commit the first output when staging the second output fails", async () => {
    const first = path.join(tempDir, "first.pdf");
    const second = path.join(tempDir, "second.pdf");
    await fs.writeFile(first, "first original");
    await fs.writeFile(second, "second original");

    await expect(writePdfOutputsAtomic([
      { targetPath: first, bytes: Buffer.from("first replacement") },
      { targetPath: second, bytes: Buffer.from("second replacement") },
    ], {
      fsOps: faultingFs({ writeAt: 2 }),
      token: "second-stage",
    })).rejects.toMatchObject({ code: "ENOSPC" });

    await expect(fs.readFile(first, "utf8")).resolves.toBe("first original");
    await expect(fs.readFile(second, "utf8")).resolves.toBe("second original");
    await expectNoTransactionArtifacts();
  });

  it("cleans earlier stages when a later lazy PDF producer fails", async () => {
    const first = path.join(tempDir, "first.pdf");
    const second = path.join(tempDir, "second.pdf");
    await fs.writeFile(first, "first original");
    await fs.writeFile(second, "second original");

    await expect(writePdfOutputsAtomic([
      { targetPath: first, produceBytes: async () => Buffer.from("first replacement") },
      {
        targetPath: second,
        produceBytes: async () => {
          throw injectedError("PDF_GENERATION_FAILED", "producer");
        },
      },
    ], { token: "producer-failure" })).rejects.toMatchObject({ code: "PDF_GENERATION_FAILED" });

    await expect(fs.readFile(first, "utf8")).resolves.toBe("first original");
    await expect(fs.readFile(second, "utf8")).resolves.toBe("second original");
    await expectNoTransactionArtifacts();
  });

  it("retries a transient cleanup failure without leaving staged bytes", async () => {
    const target = path.join(tempDir, "existing.pdf");
    await fs.writeFile(target, "original bytes");

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      fsOps: faultingFs({ writeAt: 1, unlinkAt: 1 }),
      token: "cleanup-retry",
    })).rejects.toMatchObject({ code: "ENOSPC" });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("original bytes");
    await expectNoTransactionArtifacts();
  });

  it("removes newly activated files when a later new output cannot commit", async () => {
    const first = path.join(tempDir, "first.pdf");
    const second = path.join(tempDir, "second.pdf");

    await expect(writePdfOutputsAtomic([
      { targetPath: first, bytes: Buffer.from("first replacement") },
      { targetPath: second, bytes: Buffer.from("second replacement") },
    ], {
      fsOps: faultingFs({ renameAt: 2 }),
      token: "new-outputs",
    })).rejects.toMatchObject({ code: "EIO" });

    await expect(fs.stat(first)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(second)).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoTransactionArtifacts();
  });

  it("rejects a concurrent target replacement without overwriting it", async () => {
    const target = path.join(tempDir, "existing.pdf");
    await fs.writeFile(target, "original bytes");
    const fsOps = faultingFs({
      beforeLstatAt: {
        at: 3,
        run: async () => await fs.writeFile(target, "external replacement with different bytes"),
      },
    });

    await expect(writePdfOutputAtomic(target, Buffer.from("our replacement"), {
      fsOps,
      token: "conflict",
    })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_CONFLICT" });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("external replacement with different bytes");
    await expectNoTransactionArtifacts();
  });

  it("commits a complete batch and removes rollback artifacts", async () => {
    const first = path.join(tempDir, "first.pdf");
    const second = path.join(tempDir, "second.pdf");
    await fs.writeFile(first, "first original");

    await writePdfOutputsAtomic([
      { targetPath: first, bytes: Buffer.from("first replacement") },
      { targetPath: second, bytes: Buffer.from("second replacement") },
    ], { token: "success" });

    await expect(fs.readFile(first, "utf8")).resolves.toBe("first replacement");
    await expect(fs.readFile(second, "utf8")).resolves.toBe("second replacement");
    await expectNoTransactionArtifacts();
  });

  it("rejects duplicate batch targets before creating staging files", async () => {
    const target = path.join(tempDir, "duplicate.pdf");
    await expect(writePdfOutputsAtomic([
      { targetPath: target, bytes: Buffer.from("one") },
      { targetPath: target, bytes: Buffer.from("two") },
    ], { token: "duplicate" })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_DUPLICATE_TARGET" });
    await expectNoTransactionArtifacts();
  });

  it("never deletes or overwrites a colliding transaction artifact", async () => {
    const target = path.join(tempDir, "collision.pdf");
    const collision = path.join(tempDir, ".collision.pdf.pdf-tools-collision-rollback-0");
    await fs.writeFile(target, "original");
    await fs.writeFile(collision, "unrelated artifact");

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      token: "collision",
    })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_ARTIFACT_COLLISION" });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("original");
    await expect(fs.readFile(collision, "utf8")).resolves.toBe("unrelated artifact");
  });

  it("rejects a symlink output instead of replacing the link entry", async () => {
    const linkedFile = path.join(tempDir, "linked-file.pdf");
    const target = path.join(tempDir, "output-link.pdf");
    await fs.writeFile(linkedFile, "linked bytes");
    await fs.symlink(linkedFile, target);

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      token: "symlink",
    })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_TARGET_NOT_REGULAR" });

    await expect(fs.readlink(target)).resolves.toBe(linkedFile);
    await expect(fs.readFile(linkedFile, "utf8")).resolves.toBe("linked bytes");
    await expectNoTransactionArtifacts();
  });
});
