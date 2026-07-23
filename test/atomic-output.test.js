import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
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
  beforeRename = null,
  beforeLinkAt = null,
  unlinkAt = null,
  beforeLstatAt = null,
} = {}) {
  const counts = { open: 0, write: 0, sync: 0, rename: 0, link: 0, unlink: 0, lstat: 0 };
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
        async read(...readArgs) {
          return await handle.read(...readArgs);
        },
        async readFile(...readArgs) {
          return await handle.readFile(...readArgs);
        },
      };
    },
    async readdir(...args) {
      return await fs.readdir(...args);
    },
    async lstat(...args) {
      counts.lstat += 1;
      if (counts.lstat === beforeLstatAt?.at) await beforeLstatAt.run();
      return await fs.lstat(...args);
    },
    async mkdir(...args) {
      return await fs.mkdir(...args);
    },
    async rmdir(...args) {
      return await fs.rmdir(...args);
    },
    async rename(...args) {
      counts.rename += 1;
      if (beforeRename) await beforeRename(...args);
      if (counts.rename === renameAt) throw injectedError("EIO", "rename");
      return await fs.rename(...args);
    },
    async link(...args) {
      counts.link += 1;
      if (counts.link === beforeLinkAt?.at) await beforeLinkAt.run();
      return await fs.link(...args);
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
  it("cleans an output-lock candidate after metadata write or sync failure", async () => {
    const target = path.join(tempDir, "existing.pdf");
    await fs.writeFile(target, "original bytes");

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      fsOps: faultingFs({ writeAt: 1 }),
      token: "lock-write-failure",
    })).rejects.toMatchObject({ code: "ENOSPC" });
    await expectNoTransactionArtifacts();

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      fsOps: faultingFs({ syncAt: 1 }),
      token: "lock-sync-failure",
    })).rejects.toMatchObject({ code: "EIO" });
    await expectNoTransactionArtifacts();
    await expect(fs.readFile(target, "utf8")).resolves.toBe("original bytes");
  });

  it("preserves an existing output when the staged write runs out of space", async () => {
    const target = path.join(tempDir, "existing.pdf");
    await fs.writeFile(target, "original bytes");

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      fsOps: faultingFs({ writeAt: 3 }),
      token: "disk-full",
    })).rejects.toMatchObject({ code: "ENOSPC" });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("original bytes");
    await expectNoTransactionArtifacts();
  });

  it("enforces no-overwrite after the directory lock and reports the captured target state", async () => {
    const target = path.join(tempDir, "conditional.pdf");
    const created = await writePdfOutputAtomic(target, Buffer.from("first"), {
      overwrite: false,
      token: "conditional-create",
    });
    expect(created).toEqual({ targetPath: target, replacedExisting: false });

    await expect(writePdfOutputAtomic(target, Buffer.from("second"), {
      overwrite: false,
      token: "conditional-refuse",
    })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_TARGET_EXISTS" });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("first");

    const replaced = await writePdfOutputAtomic(target, Buffer.from("third"), {
      overwrite: true,
      token: "conditional-replace",
    });
    expect(replaced).toEqual({ targetPath: target, replacedExisting: true });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("third");
    await expectNoTransactionArtifacts();
  });

  it("refuses a target created inside the locked pre-transaction hook", async () => {
    const target = path.join(tempDir, "raced-into-place.pdf");
    await expect(writePdfOutputAtomic(target, Buffer.from("ours"), {
      overwrite: false,
      token: "conditional-race",
      beforeTransaction: async () => {
        await fs.writeFile(target, "external");
      },
    })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_TARGET_EXISTS" });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("external");
    await expectNoTransactionArtifacts();
  });

  it("does not clobber a target created after the final absence check", async () => {
    const target = path.join(tempDir, "late-no-overwrite.pdf");
    await expect(writePdfOutputAtomic(target, Buffer.from("our bytes"), {
      overwrite: false,
      token: "late-no-overwrite",
      fsOps: faultingFs({
        beforeLinkAt: {
          at: 1,
          run: async () => fs.writeFile(target, "external bytes"),
        },
      }),
    })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_CONFLICT" });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("external bytes");
    await expectNoTransactionArtifacts();
  });

  it("preserves source bytes moved into an absent target at activation time", async () => {
    const source = path.join(tempDir, "protected-source.pdf");
    const target = path.join(tempDir, "late-source-alias.md");
    const sourceBytes = Buffer.from("protected source bytes");
    await fs.writeFile(source, sourceBytes);

    await expect(writePdfOutputAtomic(target, Buffer.from("Markdown bytes"), {
      overwrite: true,
      token: "late-source-alias",
      fsOps: faultingFs({
        beforeLinkAt: {
          at: 1,
          run: async () => fs.rename(source, target),
        },
      }),
    })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_CONFLICT" });

    await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(target)).resolves.toEqual(sourceBytes);
    await expectNoTransactionArtifacts();
  });

  it("exposes the locked initial target identity to validation before staging", async () => {
    const target = path.join(tempDir, "identity.pdf");
    await fs.writeFile(target, "original bytes");
    const stats = await fs.lstat(target);
    const validationError = new Error("target aliases protected input");

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      overwrite: true,
      token: "identity-validation",
      validateInitialTargets: async targets => {
        expect(targets).toEqual([{
          targetPath: target,
          exists: true,
          fileIdentity: {
            device: String(stats.dev),
            inode: String(stats.ino),
          },
        }]);
        throw validationError;
      },
    })).rejects.toBe(validationError);

    await expect(fs.readFile(target, "utf8")).resolves.toBe("original bytes");
    await expectNoTransactionArtifacts();
  });

  it("rolls back activated output when in-transaction verification rejects it", async () => {
    const existing = path.join(tempDir, "verify-existing.pdf");
    const created = path.join(tempDir, "verify-created.pdf");
    await fs.writeFile(existing, "original bytes");
    const verificationError = new Error("verification rejected activated bytes");

    await expect(writePdfOutputAtomic(existing, Buffer.from("replacement"), {
      token: "verify-existing",
      verifyActivatedTargets: async targets => {
        await expect(fs.readFile(existing, "utf8")).resolves.toBe("replacement");
        expect(targets).toEqual([{ targetPath: existing, replacedExisting: true }]);
        throw verificationError;
      },
    })).rejects.toBe(verificationError);
    await expect(fs.readFile(existing, "utf8")).resolves.toBe("original bytes");
    await expectNoTransactionArtifacts();

    await expect(writePdfOutputAtomic(created, Buffer.from("new bytes"), {
      token: "verify-created",
      verifyActivatedTargets: async targets => {
        await expect(fs.readFile(created, "utf8")).resolves.toBe("new bytes");
        expect(targets).toEqual([{ targetPath: created, replacedExisting: false }]);
        throw verificationError;
      },
    })).rejects.toBe(verificationError);
    await expect(fs.stat(created)).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoTransactionArtifacts();
  });

  it("preserves a target replaced between the last identity check and rollback move", async () => {
    const target = path.join(tempDir, "late-existing.pdf");
    const external = path.join(tempDir, "late-existing-external.pdf");
    await fs.writeFile(target, "original bytes");
    await fs.writeFile(external, "late external bytes");
    let injected = false;

    await expect(writePdfOutputAtomic(target, Buffer.from("our replacement"), {
      token: "late-existing",
      fsOps: faultingFs({
        beforeRename: async (from, to) => {
          if (!injected && from === target && String(to).endsWith("-rollback")) {
            injected = true;
            await fs.rename(external, target);
          }
        },
      }),
    })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_ROLLBACK_FAILED" });

    expect(injected).toBe(true);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("late external bytes");
    expect((await fs.readdir(tempDir)).some(name => name.endsWith("-transaction.json"))).toBe(true);
  });

  it("preserves an existing output when staging is denied", async () => {
    const target = path.join(tempDir, "existing.pdf");
    await fs.writeFile(target, "original bytes");

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      fsOps: faultingFs({ openAt: 4 }),
      token: "permission",
    })).rejects.toMatchObject({ code: "EACCES" });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("original bytes");
    await expectNoTransactionArtifacts();
  });

  it("rolls back a replacement when the output directory cannot be synced", async () => {
    const target = path.join(tempDir, "existing.pdf");
    await fs.writeFile(target, "original bytes");

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      fsOps: faultingFs({ syncAt: 10 }),
      token: "directory-sync",
    })).rejects.toMatchObject({ code: "EIO" });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("original bytes");
    await expectNoTransactionArtifacts();
  });

  it("commits when the filesystem explicitly does not support directory fsync", async () => {
    const target = path.join(tempDir, "existing.pdf");
    await fs.writeFile(target, "original bytes");

    await writePdfOutputAtomic(target, Buffer.from("replacement"), {
      fsOps: faultingFs({ syncAt: 10, syncCode: "ENOTSUP" }),
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
      fsOps: faultingFs({ renameAt: 7 }),
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
      fsOps: faultingFs({ writeAt: 4 }),
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
      fsOps: faultingFs({ writeAt: 3, unlinkAt: 1 }),
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
      fsOps: faultingFs({ renameAt: 5 }),
      token: "new-outputs",
    })).rejects.toMatchObject({ code: "EIO" });

    await expect(fs.stat(first)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(second)).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoTransactionArtifacts();
  });

  it("rejects a concurrent target replacement without overwriting it", async () => {
    const target = path.join(tempDir, "existing.pdf");
    await fs.writeFile(target, "original bytes");

    await expect(writePdfOutputAtomic(target, Buffer.from("our replacement"), {
      token: "conflict",
      async onTransition(observed) {
        if (observed === "stage_0") {
          await fs.writeFile(target, "external replacement with different bytes");
        }
      },
    })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_CONFLICT" });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("external replacement with different bytes");
    await expectNoTransactionArtifacts();
  });

  it("fails closed when a target is replaced after the activating journal is durable", async () => {
    const target = path.join(tempDir, "existing.pdf");
    const externalPath = path.join(tempDir, "external.pdf");
    await fs.writeFile(target, "original bytes");

    await expect(writePdfOutputAtomic(target, Buffer.from("our replacement"), {
      token: "late-conflict",
      async onTransition(observed) {
        if (observed === "journal_activating") {
          await fs.writeFile(externalPath, "external replacement");
          await fs.rename(externalPath, target);
        }
      },
    })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_ROLLBACK_FAILED" });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("external replacement");
    expect((await fs.readdir(tempDir)).some(name => name.endsWith("-transaction.json"))).toBe(true);
  });

  it("preserves a second target replaced between batch activations", async () => {
    const first = path.join(tempDir, "first.pdf");
    const second = path.join(tempDir, "second.pdf");
    const externalPath = path.join(tempDir, "external.pdf");
    await fs.writeFile(first, "first original");
    await fs.writeFile(second, "second original");

    await expect(writePdfOutputsAtomic([
      { targetPath: first, bytes: Buffer.from("first replacement") },
      { targetPath: second, bytes: Buffer.from("second replacement") },
    ], {
      token: "between-activation-conflict",
      async onTransition(observed) {
        if (observed === "activate_0") {
          await fs.writeFile(externalPath, "external second");
          await fs.rename(externalPath, second);
        }
      },
    })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_ROLLBACK_FAILED" });

    await expect(fs.readFile(second, "utf8")).resolves.toBe("external second");
    expect((await fs.readdir(tempDir)).some(name => name.endsWith("-transaction.json"))).toBe(true);
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

  it("rejects portable case and Unicode aliases before creating staging files", async () => {
    await expect(writePdfOutputsAtomic([
      { targetPath: path.join(tempDir, "Alias.pdf"), bytes: Buffer.from("one") },
      { targetPath: path.join(tempDir, "alias.pdf"), bytes: Buffer.from("two") },
    ])).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_DUPLICATE_TARGET" });
    await expect(writePdfOutputsAtomic([
      { targetPath: path.join(tempDir, "caf\u00e9.pdf"), bytes: Buffer.from("one") },
      { targetPath: path.join(tempDir, "cafe\u0301.pdf"), bytes: Buffer.from("two") },
    ])).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_DUPLICATE_TARGET" });
    await expectNoTransactionArtifacts();
  });

  it("rejects a batch spanning multiple directories before creating artifacts", async () => {
    const otherDirectory = await fs.mkdtemp(path.join(tempDir, "other-"));
    await expect(writePdfOutputsAtomic([
      { targetPath: path.join(tempDir, "first.pdf"), bytes: Buffer.from("one") },
      { targetPath: path.join(otherDirectory, "second.pdf"), bytes: Buffer.from("two") },
    ])).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_MULTIPLE_DIRECTORIES" });
    await expectNoTransactionArtifacts();
    expect((await fs.readdir(otherDirectory)).filter(name => name.startsWith(".pdf-tools-"))).toEqual([]);
  });

  it("rejects output names reserved for transaction artifacts", async () => {
    const target = path.join(tempDir, ".pdf-tools-output-transaction.lock");
    await expect(writePdfOutputAtomic(target, Buffer.from("bytes"))).rejects.toMatchObject({
      code: "ATOMIC_OUTPUT_RESERVED_TARGET",
    });
    await expect(writePdfOutputAtomic(
      path.join(tempDir, ".PDF-TOOLS-output-transaction.lock"),
      Buffer.from("bytes"),
    )).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_RESERVED_TARGET" });
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never deletes or overwrites a colliding transaction artifact", async () => {
    const target = path.join(tempDir, "collision.pdf");
    const tokenId = createHash("sha256").update("collision").digest("hex");
    const collision = path.join(tempDir, `.pdf-tools-${tokenId}-0-rollback`);
    await fs.writeFile(target, "original");
    await fs.writeFile(collision, "unrelated artifact");

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      token: "collision",
    })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_ARTIFACT_COLLISION" });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("original");
    await expect(fs.readFile(collision, "utf8")).resolves.toBe("unrelated artifact");
  });

  it("preserves a colliding stage artifact before publishing a journal", async () => {
    const target = path.join(tempDir, "collision.pdf");
    const tokenId = createHash("sha256").update("stage-collision").digest("hex");
    const collision = path.join(tempDir, `.pdf-tools-${tokenId}-0-stage`);
    await fs.writeFile(target, "original");
    await fs.writeFile(collision, "unrelated stage artifact", { mode: 0o600 });

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      token: "stage-collision",
    })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_ARTIFACT_COLLISION" });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("original");
    await expect(fs.readFile(collision, "utf8")).resolves.toBe("unrelated stage artifact");
    expect((await fs.readdir(tempDir)).filter(name => name.endsWith("-transaction.json"))).toEqual([]);
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
