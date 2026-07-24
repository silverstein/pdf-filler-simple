import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  recoverPdfOutputTransactions,
  writePdfOutputAtomic,
  writePdfOutputsAtomic,
} from "../server/helpers.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

let tempDir;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ANCHORED_CHILD = path.join(REPO_ROOT, "test/helpers/atomic-output-anchored-child.mjs");
const DIRECTORY_SWAP_CHILD = path.join(REPO_ROOT, "test/helpers/atomic-output-directory-swap-child.mjs");

function injectedError(code, operation) {
  const error = new Error(`Injected ${operation} failure`);
  error.code = code;
  return error;
}

function faultingFs({
  openAt = null,
  aroundOpen = null,
  writeAt = null,
  beforeWriteAt = null,
  syncAt = null,
  beforeSyncAt = null,
  beforeSync = null,
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
      const openedPath = args[0];
      const handle = aroundOpen
        ? await aroundOpen({
            count: counts.open,
            openedPath,
            open: async () => await fs.open(...args),
            openPath: async alternatePath => await fs.open(alternatePath, ...args.slice(1)),
          })
        : await fs.open(...args);
      return {
        async writeFile(...writeArgs) {
          counts.write += 1;
          if (counts.write === beforeWriteAt?.at) await beforeWriteAt.run();
          if (counts.write === writeAt) throw injectedError("ENOSPC", "write");
          return await handle.writeFile(...writeArgs);
        },
        async sync() {
          counts.sync += 1;
          if (beforeSync) await beforeSync({ count: counts.sync, path: openedPath });
          if (counts.sync === beforeSyncAt?.at) await beforeSyncAt.run();
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
        async stat(...statArgs) {
          return await handle.stat(...statArgs);
        },
      };
    },
    async readdir(...args) {
      return await fs.readdir(...args);
    },
    async lstat(...args) {
      if (args[1]?.bigint === true) return await fs.lstat(...args);
      counts.lstat += 1;
      if (counts.lstat === beforeLstatAt?.at) await beforeLstatAt.run();
      return await fs.lstat(...args);
    },
    async realpath(...args) {
      return await fs.realpath(...args);
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

async function expectedExistingIdentity(targetPath) {
  const [canonicalPath, bytes, stats] = await Promise.all([
    fs.realpath(targetPath),
    fs.readFile(targetPath),
    fs.stat(targetPath),
  ]);
  return {
    canonicalPath,
    sizeBytes: stats.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function replacementOptions(targetPath, options = {}) {
  return {
    overwrite: true,
    expectedExistingIdentity: await expectedExistingIdentity(targetPath),
    ...options,
  };
}

async function replacementEntry(targetPath, entry = {}) {
  return {
    targetPath,
    overwrite: true,
    expectedExistingIdentity: await expectedExistingIdentity(targetPath),
    ...entry,
  };
}

async function runAnchoredChild(original, moved, outside) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ANCHORED_CHILD, original, moved, outside], {
      cwd: original,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr = [];
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", code => resolve({
      code,
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

async function runDirectorySwapChild({
  outputDirectory,
  ancestorDirectory,
  movedAncestor,
  substitutedAncestor,
  swapPhase,
}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      DIRECTORY_SWAP_CHILD,
      outputDirectory,
      ancestorDirectory,
      movedAncestor,
      substitutedAncestor,
      swapPhase,
    ], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr = [];
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", code => resolve({
      code,
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

beforeEach(async () => {
  tempDir = await createTestTempDirectory(process.cwd(), "atomic-output");
});

afterEach(async () => {
  await removeTestTempDirectory(tempDir);
});

describe("atomic PDF output commits", () => {
  it("does not swallow a tagged EINVAL directory-guard failure as unsupported fsync", async () => {
    const target = path.join(tempDir, "guard-einval.pdf");
    await fs.writeFile(target, "original bytes");
    const guardError = injectedError("EINVAL", "directory guard");

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      async beforeDirectoryGuard(phase) {
        if (phase === "before_output_directory_sync_open") throw guardError;
      },
    })).rejects.toBe(guardError);

    await expect(fs.readFile(target, "utf8")).resolves.toBe("original bytes");
  });

  it.runIf(process.platform !== "win32")("rebases a final-component output-directory symlink to its stable canonical parent", async () => {
    const canonicalDirectory = path.join(tempDir, "canonical-output");
    const aliasDirectory = path.join(tempDir, "output-alias");
    await fs.mkdir(canonicalDirectory);
    await fs.symlink(canonicalDirectory, aliasDirectory, "dir");

    const committed = await writePdfOutputAtomic(
      path.join(aliasDirectory, "result.pdf"),
      Buffer.from("canonical bytes"),
    );

    expect(committed.targetPath).toBe(path.join(canonicalDirectory, "result.pdf"));
    await expect(fs.readFile(path.join(canonicalDirectory, "result.pdf"), "utf8"))
      .resolves.toBe("canonical bytes");
    await expect(fs.realpath(aliasDirectory)).resolves.toBe(canonicalDirectory);
    expect((await fs.readdir(canonicalDirectory))
      .filter(name => name.startsWith(".pdf-tools-"))).toEqual([]);
  });

  it("refuses to publish a lock whose owner record was substituted after descriptor close", async () => {
    const target = path.join(tempDir, "owner-substitution.pdf");
    await fs.writeFile(target, "original bytes");
    let substitutedOwnerPath = null;
    const substitutedBytes = `${JSON.stringify({
      schema_version: 1,
      pid: 999999999,
      token: "substituted-owner",
      created_at: new Date(0).toISOString(),
    })}\n`;

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      async beforeDirectoryGuard(phase) {
        if (phase !== "after_lock_owner_close" || substitutedOwnerPath) return;
        const candidate = (await fs.readdir(tempDir))
          .find(name => name.startsWith(".pdf-tools-output-transaction.lock.candidate-"));
        substitutedOwnerPath = path.join(tempDir, candidate, "owner.json");
        await fs.unlink(substitutedOwnerPath);
        await fs.writeFile(substitutedOwnerPath, substitutedBytes, { mode: 0o600 });
      },
    })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_LOCK_CLEANUP_FAILED" });

    expect(substitutedOwnerPath).not.toBeNull();
    await expect(fs.readFile(substitutedOwnerPath, "utf8")).resolves.toBe(substitutedBytes);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("original bytes");
    await expect(fs.stat(path.join(tempDir, ".pdf-tools-output-transaction.lock")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not unlink an owner from a substituted lock directory during release", async () => {
    const target = path.join(tempDir, "lock-directory-substitution.pdf");
    const lockPath = path.join(tempDir, ".pdf-tools-output-transaction.lock");
    const movedLockPath = path.join(tempDir, "moved-output-lock");
    const substitutedOwnerBytes = "substituted owner bytes";
    let swapped = false;

    await expect(writePdfOutputAtomic(target, Buffer.from("committed bytes"), {
      async beforeDirectoryGuard(phase) {
        if (swapped || phase !== "before_lock_owner_cleanup") return;
        await fs.rename(lockPath, movedLockPath);
        await fs.mkdir(lockPath, { mode: 0o700 });
        await fs.writeFile(
          path.join(lockPath, "owner.json"),
          substitutedOwnerBytes,
          { mode: 0o600 },
        );
        swapped = true;
      },
    })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_LOCK_CHANGED" });

    expect(swapped).toBe(true);
    await expect(fs.readFile(path.join(lockPath, "owner.json"), "utf8"))
      .resolves.toBe(substitutedOwnerBytes);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("committed bytes");
    expect((await fs.stat(path.join(movedLockPath, "owner.json"))).isFile()).toBe(true);
  });

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

  it.each(["write", "sync"])(
    "does not unlink a substituted lock owner when its descriptor %s fails",
    async operation => {
      const target = path.join(tempDir, `owner-${operation}-failure.pdf`);
      await fs.writeFile(target, "original bytes");
      const substitutedBytes = "substituted owner bytes";
      let substitutedOwnerPath = null;
      let substitutedIdentity = null;
      const beforeFailure = {
        at: 1,
        run: async () => {
          const candidate = (await fs.readdir(tempDir))
            .find(name => name.startsWith(".pdf-tools-output-transaction.lock.candidate-"));
          substitutedOwnerPath = path.join(tempDir, candidate, "owner.json");
          await fs.unlink(substitutedOwnerPath);
          await fs.writeFile(substitutedOwnerPath, substitutedBytes, { mode: 0o600 });
          const stats = await fs.lstat(substitutedOwnerPath);
          substitutedIdentity = { dev: stats.dev, ino: stats.ino };
        },
      };

      await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
        token: `lock-owner-${operation}-substitution`,
        fsOps: faultingFs(operation === "write"
          ? { writeAt: 1, beforeWriteAt: beforeFailure }
          : { syncAt: 1, beforeSyncAt: beforeFailure }),
      })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_LOCK_CLEANUP_FAILED" });

      const retained = await fs.lstat(substitutedOwnerPath);
      expect({ dev: retained.dev, ino: retained.ino }).toEqual(substitutedIdentity);
      await expect(fs.readFile(substitutedOwnerPath, "utf8")).resolves.toBe(substitutedBytes);
      await expect(fs.readFile(target, "utf8")).resolves.toBe("original bytes");
    },
  );

  it("preserves an existing output when the staged write runs out of space", async () => {
    const target = path.join(tempDir, "existing.pdf");
    await fs.writeFile(target, "original bytes");

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      ...await replacementOptions(target),
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

    const replacementIdentity = await expectedExistingIdentity(target);
    const replaced = await writePdfOutputAtomic(target, Buffer.from("third"), {
      overwrite: true,
      expectedExistingIdentity: replacementIdentity,
      token: "conditional-replace",
    });
    expect(replaced).toEqual({ targetPath: target, replacedExisting: true });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("third");
    await expectNoTransactionArtifacts();
  });

  it("rejects blind replacement and binds replacement to path, size, and SHA-256", async () => {
    const target = path.join(tempDir, "identity-bound.pdf");
    await fs.writeFile(target, "approved bytes");
    const identity = await expectedExistingIdentity(target);

    await expect(writePdfOutputAtomic(target, Buffer.from("blind"), {
      overwrite: true,
    })).rejects.toMatchObject({
      code: "ATOMIC_OUTPUT_EXPECTED_IDENTITY_REQUIRED",
    });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("approved bytes");

    for (const changed of [
      { ...identity, canonicalPath: path.join(tempDir, "other.pdf") },
      { ...identity, sizeBytes: identity.sizeBytes + 1 },
      { ...identity, sha256: "0".repeat(64) },
    ]) {
      await expect(writePdfOutputAtomic(target, Buffer.from("stale"), {
        overwrite: true,
        expectedExistingIdentity: changed,
      })).rejects.toMatchObject({
        code: "ATOMIC_OUTPUT_EXPECTED_IDENTITY_CHANGED",
      });
      await expect(fs.readFile(target, "utf8")).resolves.toBe("approved bytes");
      await expectNoTransactionArtifacts();
    }

    const committed = await writePdfOutputAtomic(
      target,
      Buffer.from("replacement"),
      {
        overwrite: true,
        expectedExistingIdentity: identity,
      },
    );
    expect(committed).toEqual({ targetPath: target, replacedExisting: true });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("replacement");
  });

  it("binds an approved digest to the exact pathname inode opened for hashing", async () => {
    const target = path.join(tempDir, "descriptor-bound-target.pdf");
    const approvedAlternate = path.join(tempDir, "descriptor-bound-approved.pdf");
    const unapprovedBytes = Buffer.alloc(64, 0x41);
    const approvedBytes = Buffer.alloc(64, 0x42);
    await fs.writeFile(target, unapprovedBytes);
    await fs.writeFile(approvedAlternate, approvedBytes);
    const identity = {
      canonicalPath: target,
      sizeBytes: approvedBytes.length,
      sha256: createHash("sha256").update(approvedBytes).digest("hex"),
    };
    const transitions = [];
    const fsOps = faultingFs({
      aroundOpen: async ({ openedPath, open, openPath }) => {
        if (openedPath !== target && !String(openedPath).endsWith("-rollback")) {
          return await open();
        }
        return await openPath(approvedAlternate);
      },
    });

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      overwrite: true,
      expectedExistingIdentity: identity,
      fsOps,
      token: "descriptor-bound-initial-hash",
      onTransition: async transition => transitions.push(transition),
    })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_ARTIFACT_CHANGED" });

    expect(transitions).toEqual(["lock_acquired"]);
    await expect(fs.readFile(target)).resolves.toEqual(unapprovedBytes);
    await expect(fs.readFile(approvedAlternate)).resolves.toEqual(approvedBytes);
    await expectNoTransactionArtifacts();
  });

  it("does not turn a disappeared approved replacement into file creation", async () => {
    const target = path.join(tempDir, "disappeared.pdf");
    await fs.writeFile(target, "approved bytes");
    const identity = await expectedExistingIdentity(target);
    await fs.unlink(target);

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      overwrite: true,
      expectedExistingIdentity: identity,
    })).rejects.toMatchObject({
      code: "ATOMIC_OUTPUT_EXPECTED_TARGET_MISSING",
    });
    await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
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
    let externalIdentity = null;
    await expect(writePdfOutputAtomic(target, Buffer.from("our bytes"), {
      overwrite: false,
      token: "late-no-overwrite",
      fsOps: faultingFs({
        beforeLinkAt: {
          at: 1,
          run: async () => {
            await fs.writeFile(target, "our bytes");
            const stats = await fs.lstat(target);
            externalIdentity = { dev: stats.dev, ino: stats.ino };
          },
        },
      }),
    })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_CONFLICT" });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("our bytes");
    const retainedStats = await fs.lstat(target);
    expect({ dev: retainedStats.dev, ino: retainedStats.ino }).toEqual(externalIdentity);
    await expectNoTransactionArtifacts();
  });

  it("preserves source bytes moved into an absent target at activation time", async () => {
    const source = path.join(tempDir, "protected-source.pdf");
    const target = path.join(tempDir, "late-source-alias.md");
    const sourceBytes = Buffer.from("Markdown bytes");
    await fs.writeFile(source, sourceBytes);
    const sourceStats = await fs.lstat(source);

    await expect(writePdfOutputAtomic(target, Buffer.from("Markdown bytes"), {
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
    const retainedStats = await fs.lstat(target);
    expect({ dev: retainedStats.dev, ino: retainedStats.ino }).toEqual({
      dev: sourceStats.dev,
      ino: sourceStats.ino,
    });
    await expectNoTransactionArtifacts();
  });

  it.runIf(process.platform !== "win32")("keeps every relative mutation anchored to the child cwd after a parent symlink swap", async () => {
    const original = path.join(tempDir, "anchored-parent");
    const moved = path.join(tempDir, "anchored-parent-moved");
    const outside = path.join(tempDir, "anchored-outside");
    await fs.mkdir(original);
    await fs.mkdir(outside);

    const result = await runAnchoredChild(original, moved, outside);
    expect(result.code, result.stderr).toBe(0);
    await expect(fs.readFile(path.join(moved, "anchored.md"), "utf8")).resolves.toBe("anchored Markdown bytes");
    await expect(fs.access(path.join(outside, "anchored.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.realpath(original)).resolves.toBe(outside);
    expect((await fs.readdir(moved)).filter(name => name.includes(".pdf-tools-"))).toEqual([]);
    expect((await fs.readdir(outside)).filter(name => name.includes(".pdf-tools-"))).toEqual([]);
  }, 30_000);

  for (const swapPhase of ["output_transaction_entry", "before_target_0_rollback"]) {
    it.runIf(process.platform !== "win32")(
      `rejects an ancestor substitution at ${swapPhase} without mutating it and leaves the original recoverable`,
      async () => {
        const ancestor = path.join(tempDir, `ancestor-${swapPhase}`);
        const outputDirectory = path.join(ancestor, "output");
        const movedAncestor = path.join(tempDir, `moved-${swapPhase}`);
        const substitutedAncestor = path.join(tempDir, `substituted-${swapPhase}`);
        await fs.mkdir(outputDirectory, { recursive: true });
        await fs.mkdir(path.join(substitutedAncestor, "output"), { recursive: true });
        await fs.writeFile(path.join(outputDirectory, "first.pdf"), "first original");
        await fs.writeFile(path.join(substitutedAncestor, "output", "first.pdf"), "substituted bytes");
        const substitutedBefore = await fs.readFile(
          path.join(substitutedAncestor, "output", "first.pdf"),
        );

        const result = await runDirectorySwapChild({
          outputDirectory,
          ancestorDirectory: ancestor,
          movedAncestor,
          substitutedAncestor,
          swapPhase,
        });
        expect(result.code, result.stderr).toBe(73);
        await expect(fs.readFile(path.join(substitutedAncestor, "output", "first.pdf")))
          .resolves.toEqual(substitutedBefore);
        expect((await fs.readdir(path.join(substitutedAncestor, "output")))
          .filter(name => name.startsWith(".pdf-tools-"))).toEqual([]);

        await recoverPdfOutputTransactions(path.join(movedAncestor, "output"));
        await expect(fs.readFile(path.join(movedAncestor, "output", "first.pdf"), "utf8"))
          .resolves.toBe("first original");
        expect((await fs.readdir(path.join(movedAncestor, "output")))
          .filter(name => name.startsWith(".pdf-tools-"))).toEqual([]);
      },
      30_000,
    );
  }

  it("exposes the locked initial target identity to validation before staging", async () => {
    const target = path.join(tempDir, "identity.pdf");
    await fs.writeFile(target, "original bytes");
    const stats = await fs.lstat(target);
    const validationError = new Error("target aliases protected input");

    const identity = await expectedExistingIdentity(target);
    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      overwrite: true,
      expectedExistingIdentity: identity,
      token: "identity-validation",
      validateInitialTargets: async targets => {
        expect(targets).toEqual([{
          targetPath: target,
          exists: true,
          sizeBytes: stats.size,
          sha256: identity.sha256,
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
      ...await replacementOptions(existing),
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

  it("does not commit a same-byte different-inode target substituted after verification", async () => {
    const target = path.join(tempDir, "same-byte-substitution.pdf");
    await fs.writeFile(target, "original bytes");
    let substitutedIdentity = null;

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement bytes"), {
      ...await replacementOptions(target),
      verifyActivatedTargets: async () => {
        await fs.unlink(target);
        await fs.writeFile(target, "replacement bytes");
        const stats = await fs.lstat(target);
        substitutedIdentity = { dev: stats.dev, ino: stats.ino };
      },
    })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_ROLLBACK_FAILED" });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("replacement bytes");
    const retained = await fs.lstat(target);
    expect({ dev: retained.dev, ino: retained.ino }).toEqual(substitutedIdentity);
  });

  it("preserves a same-byte different-inode journal substituted before committed cleanup", async () => {
    const target = path.join(tempDir, "journal-substitution.pdf");
    await fs.writeFile(target, "original bytes");
    let substitutedJournal = null;
    let substitutedIdentity = null;

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement bytes"), {
      ...await replacementOptions(target),
      async onTransition(transition) {
        if (transition !== "rollback_removed_0") return;
        const journalName = (await fs.readdir(tempDir))
          .find(name => name.endsWith("-transaction.json"));
        substitutedJournal = path.join(tempDir, journalName);
        const bytes = await fs.readFile(substitutedJournal);
        await fs.unlink(substitutedJournal);
        await fs.writeFile(substitutedJournal, bytes, { mode: 0o600 });
        const stats = await fs.lstat(substitutedJournal);
        substitutedIdentity = { dev: stats.dev, ino: stats.ino };
      },
    })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_COMMITTED_CLEANUP_FAILED" });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("replacement bytes");
    const retained = await fs.lstat(substitutedJournal);
    expect({ dev: retained.dev, ino: retained.ino }).toEqual(substitutedIdentity);
  });

  it("preserves a same-byte different-inode journal substituted between durable states", async () => {
    const target = path.join(tempDir, "journal-between-states.pdf");
    await fs.writeFile(target, "original bytes");
    let substitutedJournal = null;
    let substitutedIdentity = null;

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement bytes"), {
      ...await replacementOptions(target),
      async onTransition(transition) {
        if (transition !== "journal_staging") return;
        const journalName = (await fs.readdir(tempDir))
          .find(name => name.endsWith("-transaction.json"));
        substitutedJournal = path.join(tempDir, journalName);
        const bytes = await fs.readFile(substitutedJournal);
        await fs.unlink(substitutedJournal);
        await fs.writeFile(substitutedJournal, bytes, { mode: 0o600 });
        const stats = await fs.lstat(substitutedJournal);
        substitutedIdentity = { dev: stats.dev, ino: stats.ino };
      },
    })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_JOURNAL_CHANGED" });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("original bytes");
    const retained = await fs.lstat(substitutedJournal);
    expect({ dev: retained.dev, ino: retained.ino }).toEqual(substitutedIdentity);
  });

  it("does not rebind self-recovery to a substituted journal after a producer fails", async () => {
    const target = path.join(tempDir, "journal-producer-failure.pdf");
    await fs.writeFile(target, "original bytes");
    const producerError = injectedError("PDF_GENERATION_FAILED", "producer");
    let substitutedJournal = null;
    let substitutedIdentity = null;

    await expect(writePdfOutputsAtomic([await replacementEntry(target, {
      produceBytes: async () => {
        throw producerError;
      },
    })], {
      async onTransition(transition) {
        if (transition !== "journal_staging") return;
        const journalName = (await fs.readdir(tempDir))
          .find(name => name.endsWith("-transaction.json"));
        substitutedJournal = path.join(tempDir, journalName);
        const bytes = await fs.readFile(substitutedJournal);
        await fs.unlink(substitutedJournal);
        await fs.writeFile(substitutedJournal, bytes, { mode: 0o600 });
        const stats = await fs.lstat(substitutedJournal);
        substitutedIdentity = { dev: stats.dev, ino: stats.ino };
      },
    })).rejects.toMatchObject({
      code: "ATOMIC_OUTPUT_ROLLBACK_FAILED",
      cause: producerError,
      cleanup_errors: [{ code: "ATOMIC_OUTPUT_JOURNAL_CHANGED" }],
    });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("original bytes");
    const retained = await fs.lstat(substitutedJournal);
    expect({ dev: retained.dev, ino: retained.ino }).toEqual(substitutedIdentity);
  });

  it("preserves a target replaced between the last identity check and rollback move", async () => {
    const target = path.join(tempDir, "late-existing.pdf");
    const external = path.join(tempDir, "late-existing-external.pdf");
    await fs.writeFile(target, "original bytes");
    await fs.writeFile(external, "late external bytes");
    let injected = false;

    await expect(writePdfOutputAtomic(target, Buffer.from("our replacement"), {
      ...await replacementOptions(target),
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

  it("does not accept an approved digest from a different inode while verifying rollback", async () => {
    const target = path.join(tempDir, "rollback-descriptor-target.pdf");
    const approvedSpare = path.join(tempDir, "rollback-descriptor-approved.pdf");
    const approvedBytes = Buffer.alloc(64, 0x43);
    const unapprovedBytes = Buffer.alloc(64, 0x44);
    await fs.writeFile(target, approvedBytes);
    await fs.writeFile(approvedSpare, approvedBytes);
    const fixedTime = new Date("2026-07-24T05:00:00.000Z");
    await fs.utimes(target, fixedTime, fixedTime);
    const initialStats = await fs.lstat(target);
    const identity = await expectedExistingIdentity(target);
    let substituted = false;

    await expect(writePdfOutputAtomic(target, Buffer.from("our replacement"), {
      overwrite: true,
      expectedExistingIdentity: identity,
      token: "rollback-descriptor-binding",
      fsOps: faultingFs({
        beforeRename: async (from, to) => {
          if (substituted || from !== target || !String(to).endsWith("-rollback")) return;
          substituted = true;
          await fs.writeFile(target, unapprovedBytes);
          await fs.utimes(target, fixedTime, fixedTime);
          const mutatedStats = await fs.lstat(target);
          expect({ dev: mutatedStats.dev, ino: mutatedStats.ino }).toEqual({
            dev: initialStats.dev,
            ino: initialStats.ino,
          });
        },
        aroundOpen: async ({ openedPath, open, openPath }) => {
          if (!String(openedPath).endsWith("-rollback")) return await open();
          return await openPath(approvedSpare);
        },
      }),
    })).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_ROLLBACK_FAILED" });

    expect(substituted).toBe(true);
    await expect(fs.readFile(target)).resolves.toEqual(unapprovedBytes);
    await expect(fs.readFile(approvedSpare)).resolves.toEqual(approvedBytes);
    expect((await fs.readdir(tempDir)).some(name => name.endsWith("-transaction.json"))).toBe(true);
  });

  it("preserves an existing output when staging is denied", async () => {
    const target = path.join(tempDir, "existing.pdf");
    await fs.writeFile(target, "original bytes");

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      ...await replacementOptions(target),
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
      ...await replacementOptions(target),
      fsOps: faultingFs({ syncAt: 10 }),
      token: "directory-sync",
    })).rejects.toMatchObject({ code: "EIO" });

    await expect(fs.readFile(target, "utf8")).resolves.toBe("original bytes");
    await expectNoTransactionArtifacts();
  });

  it("uses a proven partially published journal to recover the original sync error", async () => {
    const target = path.join(tempDir, "published-journal-sync-failure.pdf");
    await fs.writeFile(target, "original bytes");
    const syncError = injectedError("EIO", "published journal directory sync");
    let injected = false;

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      ...await replacementOptions(target),
      token: "published-journal-sync-failure",
      fsOps: faultingFs({
        beforeSync: async ({ path: openedPath }) => {
          if (injected || openedPath !== tempDir) return;
          const journalName = (await fs.readdir(tempDir))
            .find(name => name.endsWith("-transaction.json"));
          if (!journalName) return;
          const envelope = JSON.parse(
            await fs.readFile(path.join(tempDir, journalName), "utf8"),
          );
          if (envelope.payload?.state !== "prepared") return;
          injected = true;
          throw syncError;
        },
      }),
    })).rejects.toBe(syncError);

    expect(injected).toBe(true);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("original bytes");
    await expectNoTransactionArtifacts();
  });

  it("commits when the filesystem explicitly does not support directory fsync", async () => {
    const target = path.join(tempDir, "existing.pdf");
    await fs.writeFile(target, "original bytes");

    await writePdfOutputAtomic(target, Buffer.from("replacement"), {
      ...await replacementOptions(target),
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
      await replacementEntry(first, { bytes: Buffer.from("first replacement") }),
      await replacementEntry(second, { bytes: Buffer.from("second replacement") }),
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
      await replacementEntry(first, { bytes: Buffer.from("first replacement") }),
      await replacementEntry(second, { bytes: Buffer.from("second replacement") }),
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
      await replacementEntry(first, {
        produceBytes: async () => Buffer.from("first replacement"),
      }),
      await replacementEntry(second, {
        produceBytes: async () => {
          throw injectedError("PDF_GENERATION_FAILED", "producer");
        },
      }),
    ], { token: "producer-failure" })).rejects.toMatchObject({ code: "PDF_GENERATION_FAILED" });

    await expect(fs.readFile(first, "utf8")).resolves.toBe("first original");
    await expect(fs.readFile(second, "utf8")).resolves.toBe("second original");
    await expectNoTransactionArtifacts();
  });

  it("retries a transient cleanup failure without leaving staged bytes", async () => {
    const target = path.join(tempDir, "existing.pdf");
    await fs.writeFile(target, "original bytes");

    await expect(writePdfOutputAtomic(target, Buffer.from("replacement"), {
      ...await replacementOptions(target),
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
      ...await replacementOptions(target),
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
      ...await replacementOptions(target),
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
      await replacementEntry(first, { bytes: Buffer.from("first replacement") }),
      await replacementEntry(second, { bytes: Buffer.from("second replacement") }),
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
      await replacementEntry(first, { bytes: Buffer.from("first replacement") }),
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
      ...await replacementOptions(target),
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
      ...await replacementOptions(target),
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
