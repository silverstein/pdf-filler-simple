import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { recoverPdfOutputTransactions, writePdfOutputAtomic } from "../server/helpers.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CRASH_CHILD = path.join(REPO_ROOT, "test", "helpers", "atomic-output-crash-child.mjs");
const LOCK_HOLDER = path.join(REPO_ROOT, "test", "helpers", "atomic-output-lock-holder.mjs");
const PRECOMMIT_TRANSITIONS = [
  "lock_acquired",
  "journal_staging",
  "stage_0",
  "stage_1",
  "journal_prepared",
  "journal_activating",
  "rollback_0",
  "activate_0",
  "rollback_1",
  "activate_1",
  "activation_synced",
  "activation_verified",
];
const COMMITTED_TRANSITIONS = [
  "journal_committed",
  "stage_removed_0",
  "rollback_removed_0",
  "stage_removed_1",
  "rollback_removed_1",
  "journal_removed",
];
const tempDirectories = [];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function makeTransactionDirectory(label) {
  const directoryPath = await createTestTempDirectory(REPO_ROOT, `atomic-recovery-${label.replaceAll("_", "-")}`);
  tempDirectories.push(directoryPath);
  await fs.writeFile(path.join(directoryPath, "first.pdf"), "first original");
  await fs.writeFile(path.join(directoryPath, "second.pdf"), "second original");
  return directoryPath;
}

async function runCrashChild(directoryPath, transition) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CRASH_CHILD, directoryPath, transition], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr = [];
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({
      code,
      signal,
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

async function startLockHolder(directoryPath) {
  const child = spawn(process.execPath, [LOCK_HOLDER, directoryPath], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for transaction lock holder")), 10_000);
    child.once("error", reject);
    child.stdout.on("data", chunk => {
      output += chunk.toString("utf8");
      if (output.includes("READY\n")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  return child;
}

async function stopChildAbruptly(child) {
  const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  child.kill("SIGKILL");
  return await closed;
}

async function exitedProcessId() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return pid;
}

async function expectNoTransactionArtifacts(directoryPath) {
  const names = await fs.readdir(directoryPath);
  expect(names.filter(name => name.startsWith(".pdf-tools-")).sort()).toEqual([]);
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(removeTestTempDirectory));
});

describe("durable PDF output transaction recovery", () => {
  for (const transition of PRECOMMIT_TRANSITIONS) {
    it(`restores the exact prior set after termination at ${transition}`, async () => {
      const directoryPath = await makeTransactionDirectory(transition);
      const child = await runCrashChild(directoryPath, transition);
      expect(child).toMatchObject({ code: 86, signal: null, stderr: "" });

      const recovered = await recoverPdfOutputTransactions(directoryPath);
      expect(recovered).toHaveLength(transition === "lock_acquired" ? 0 : 1);
      await expect(fs.readFile(path.join(directoryPath, "first.pdf"), "utf8")).resolves.toBe("first original");
      await expect(fs.readFile(path.join(directoryPath, "second.pdf"), "utf8")).resolves.toBe("second original");
      await expectNoTransactionArtifacts(directoryPath);
      await expect(recoverPdfOutputTransactions(directoryPath)).resolves.toEqual([]);
    }, 30_000);
  }

  for (const transition of COMMITTED_TRANSITIONS) {
    it(`finishes the exact new set after termination at ${transition}`, async () => {
      const directoryPath = await makeTransactionDirectory(transition);
      const child = await runCrashChild(directoryPath, transition);
      expect(child).toMatchObject({ code: 86, signal: null, stderr: "" });

      await recoverPdfOutputTransactions(directoryPath);
      await expect(fs.readFile(path.join(directoryPath, "first.pdf"), "utf8")).resolves.toBe("first replacement");
      await expect(fs.readFile(path.join(directoryPath, "second.pdf"), "utf8")).resolves.toBe("second replacement");
      await expectNoTransactionArtifacts(directoryPath);
      await expect(recoverPdfOutputTransactions(directoryPath)).resolves.toEqual([]);
    }, 30_000);
  }

  it("rejects a symlinked journal without touching its target", async () => {
    const directoryPath = await makeTransactionDirectory("symlink-journal");
    const externalPath = path.join(directoryPath, "external.json");
    const journalPath = path.join(directoryPath, `.pdf-tools-${"a".repeat(64)}-transaction.json`);
    await fs.writeFile(externalPath, "external bytes");
    await fs.symlink(externalPath, journalPath);

    await expect(recoverPdfOutputTransactions(directoryPath)).rejects.toMatchObject({
      code: "ATOMIC_OUTPUT_ARTIFACT_INVALID",
    });
    await expect(fs.readFile(externalPath, "utf8")).resolves.toBe("external bytes");
    await expect(fs.readlink(journalPath)).resolves.toBe(externalPath);
  });

  it("serializes same-directory writers and reclaims a dead process lock", async () => {
    const directoryPath = await makeTransactionDirectory("directory-lock");
    const holder = await startLockHolder(directoryPath);

    await expect(writePdfOutputAtomic(
      path.join(directoryPath, "competing.pdf"),
      Buffer.from("competing bytes"),
    )).rejects.toMatchObject({ code: "ATOMIC_OUTPUT_CONCURRENT" });

    const stopped = await stopChildAbruptly(holder);
    expect(stopped.signal).toBe("SIGKILL");
    await recoverPdfOutputTransactions(directoryPath);
    await expectNoTransactionArtifacts(directoryPath);

    await writePdfOutputAtomic(
      path.join(directoryPath, "competing.pdf"),
      Buffer.from("competing bytes"),
    );
    await expect(fs.readFile(path.join(directoryPath, "competing.pdf"), "utf8")).resolves.toBe("competing bytes");
    await expectNoTransactionArtifacts(directoryPath);
  }, 30_000);

  it("runs the pre-transaction guard after recovery while holding the directory lock", async () => {
    const directoryPath = await makeTransactionDirectory("guard-after-recovery");
    const child = await runCrashChild(directoryPath, "activate_0");
    expect(child.code).toBe(86);

    const guardError = new Error("guard observed recovered inputs");
    guardError.code = "TEST_RECOVERY_GUARD";
    await expect(writePdfOutputAtomic(
      path.join(directoryPath, "first.pdf"),
      Buffer.from("must not commit"),
      {
        async beforeTransaction() {
          await expect(fs.readFile(path.join(directoryPath, "first.pdf"), "utf8")).resolves.toBe("first original");
          await expect(fs.readFile(path.join(directoryPath, "second.pdf"), "utf8")).resolves.toBe("second original");
          throw guardError;
        },
      },
    )).rejects.toBe(guardError);

    await expect(fs.readFile(path.join(directoryPath, "first.pdf"), "utf8")).resolves.toBe("first original");
    await expect(fs.readFile(path.join(directoryPath, "second.pdf"), "utf8")).resolves.toBe("second original");
    await expectNoTransactionArtifacts(directoryPath);
  }, 30_000);

  it("recovers all-new and mixed output sets on both sides of commit", async () => {
    const allNewPrecommit = await makeTransactionDirectory("all-new-precommit");
    await fs.unlink(path.join(allNewPrecommit, "first.pdf"));
    await fs.unlink(path.join(allNewPrecommit, "second.pdf"));
    expect((await runCrashChild(allNewPrecommit, "activate_0")).code).toBe(86);
    await recoverPdfOutputTransactions(allNewPrecommit);
    await expect(fs.stat(path.join(allNewPrecommit, "first.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(allNewPrecommit, "second.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoTransactionArtifacts(allNewPrecommit);

    const mixedPrecommit = await makeTransactionDirectory("mixed-precommit");
    await fs.unlink(path.join(mixedPrecommit, "second.pdf"));
    expect((await runCrashChild(mixedPrecommit, "activate_1")).code).toBe(86);
    await recoverPdfOutputTransactions(mixedPrecommit);
    await expect(fs.readFile(path.join(mixedPrecommit, "first.pdf"), "utf8")).resolves.toBe("first original");
    await expect(fs.stat(path.join(mixedPrecommit, "second.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoTransactionArtifacts(mixedPrecommit);

    const allNewCommitted = await makeTransactionDirectory("all-new-committed");
    await fs.unlink(path.join(allNewCommitted, "first.pdf"));
    await fs.unlink(path.join(allNewCommitted, "second.pdf"));
    expect((await runCrashChild(allNewCommitted, "journal_committed")).code).toBe(86);
    await recoverPdfOutputTransactions(allNewCommitted);
    await expect(fs.readFile(path.join(allNewCommitted, "first.pdf"), "utf8")).resolves.toBe("first replacement");
    await expect(fs.readFile(path.join(allNewCommitted, "second.pdf"), "utf8")).resolves.toBe("second replacement");
    await expectNoTransactionArtifacts(allNewCommitted);
  }, 30_000);

  it("recovers a legacy v1 activating journal whose activated stage was renamed away", async () => {
    const directoryPath = await makeTransactionDirectory("legacy-v1-activating");
    expect((await runCrashChild(directoryPath, "activate_0")).code).toBe(86);
    const journalName = (await fs.readdir(directoryPath)).find(name => name.endsWith("-transaction.json"));
    expect(journalName).toEqual(expect.any(String));
    const journalPath = path.join(directoryPath, journalName);
    const envelope = JSON.parse(await fs.readFile(journalPath, "utf8"));
    envelope.payload.schema_version = 1;
    envelope.payload_sha256 = sha256(JSON.stringify(envelope.payload));
    await fs.unlink(path.join(directoryPath, envelope.payload.entries[0].stage));
    await fs.writeFile(journalPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });

    await recoverPdfOutputTransactions(directoryPath);
    await expect(fs.readFile(path.join(directoryPath, "first.pdf"), "utf8")).resolves.toBe("first original");
    await expect(fs.readFile(path.join(directoryPath, "second.pdf"), "utf8")).resolves.toBe("second original");
    await expectNoTransactionArtifacts(directoryPath);
  }, 30_000);

  it("preserves a different-inode same-byte target while recovering a v1 journal with its stage present", async () => {
    const directoryPath = await makeTransactionDirectory("legacy-v1-staged-identity");
    await fs.unlink(path.join(directoryPath, "first.pdf"));
    await fs.unlink(path.join(directoryPath, "second.pdf"));
    expect((await runCrashChild(directoryPath, "journal_activating")).code).toBe(86);
    const journalName = (await fs.readdir(directoryPath)).find(name => name.endsWith("-transaction.json"));
    expect(journalName).toEqual(expect.any(String));
    const journalPath = path.join(directoryPath, journalName);
    const envelope = JSON.parse(await fs.readFile(journalPath, "utf8"));
    envelope.payload.schema_version = 1;
    envelope.payload_sha256 = sha256(JSON.stringify(envelope.payload));
    await fs.writeFile(journalPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });

    const targetPath = path.join(directoryPath, "first.pdf");
    await fs.writeFile(targetPath, "first replacement");
    const externalStats = await fs.lstat(targetPath);
    await recoverPdfOutputTransactions(directoryPath);

    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("first replacement");
    const retainedStats = await fs.lstat(targetPath);
    expect({ dev: retainedStats.dev, ino: retainedStats.ino }).toEqual({
      dev: externalStats.dev,
      ino: externalStats.ino,
    });
    await expect(fs.stat(path.join(directoryPath, "second.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
    await expectNoTransactionArtifacts(directoryPath);
  }, 30_000);

  it("cleans an incomplete dead-process output-lock candidate", async () => {
    const directoryPath = await makeTransactionDirectory("partial-lock-candidate");
    const deadPid = await exitedProcessId();
    const candidatePath = path.join(
      directoryPath,
      `.pdf-tools-output-transaction.lock.candidate-${deadPid}-00000000-0000-4000-8000-000000000000`,
    );
    await fs.mkdir(candidatePath, { mode: 0o700 });
    await fs.writeFile(path.join(candidatePath, "owner.json"), "{", { mode: 0o600 });

    await expect(recoverPdfOutputTransactions(directoryPath)).resolves.toEqual([]);
    await expectNoTransactionArtifacts(directoryPath);
  });

  it("rejects both stale and re-signed path traversal without touching outside files", async () => {
    const directoryPath = await makeTransactionDirectory("forged-path");
    const child = await runCrashChild(directoryPath, "journal_prepared");
    expect(child.code).toBe(86);
    const journalName = (await fs.readdir(directoryPath)).find(name => name.endsWith("-transaction.json"));
    const journalPath = path.join(directoryPath, journalName);
    const outsidePath = `${directoryPath}-outside.pdf`;
    await fs.writeFile(outsidePath, "outside bytes");
    tempDirectories.push(outsidePath);

    const envelope = JSON.parse(await fs.readFile(journalPath, "utf8"));
    envelope.payload.entries[0].target = `../${path.basename(outsidePath)}`;
    await fs.writeFile(journalPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    await expect(recoverPdfOutputTransactions(directoryPath)).rejects.toMatchObject({
      code: "ATOMIC_OUTPUT_JOURNAL_DIGEST_INVALID",
    });
    await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("outside bytes");

    envelope.payload_sha256 = sha256(JSON.stringify(envelope.payload));
    await fs.writeFile(journalPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    await expect(recoverPdfOutputTransactions(directoryPath)).rejects.toMatchObject({
      code: "ATOMIC_OUTPUT_JOURNAL_PATH_INVALID",
    });
    await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe("outside bytes");

    envelope.payload.entries[0].target = ".PDF-TOOLS-forged.pdf";
    envelope.payload_sha256 = sha256(JSON.stringify(envelope.payload));
    await fs.writeFile(journalPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    await expect(recoverPdfOutputTransactions(directoryPath)).rejects.toMatchObject({
      code: "ATOMIC_OUTPUT_JOURNAL_PATH_INVALID",
    });
  });

  it("rejects a re-signed journal with portable target aliases", async () => {
    const directoryPath = await makeTransactionDirectory("journal-target-alias");
    expect((await runCrashChild(directoryPath, "journal_prepared")).code).toBe(86);
    const journalName = (await fs.readdir(directoryPath)).find(name => name.endsWith("-transaction.json"));
    const journalPath = path.join(directoryPath, journalName);
    const envelope = JSON.parse(await fs.readFile(journalPath, "utf8"));
    envelope.payload.entries[1].target = envelope.payload.entries[0].target.toUpperCase();
    envelope.payload_sha256 = sha256(JSON.stringify(envelope.payload));
    await fs.writeFile(journalPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });

    await expect(recoverPdfOutputTransactions(directoryPath)).rejects.toMatchObject({
      code: "ATOMIC_OUTPUT_JOURNAL_PATH_INVALID",
    });
  });

  it("rejects a symlinked stage without following or deleting its target", async () => {
    const directoryPath = await makeTransactionDirectory("symlink-stage");
    const child = await runCrashChild(directoryPath, "journal_prepared");
    expect(child.code).toBe(86);
    const journalName = (await fs.readdir(directoryPath)).find(name => name.endsWith("-transaction.json"));
    const envelope = JSON.parse(await fs.readFile(path.join(directoryPath, journalName), "utf8"));
    const stagePath = path.join(directoryPath, envelope.payload.entries[0].stage);
    const externalPath = `${directoryPath}-external-stage.pdf`;
    tempDirectories.push(externalPath);
    await fs.writeFile(externalPath, "external stage bytes");
    await fs.unlink(stagePath);
    await fs.symlink(externalPath, stagePath);

    await expect(recoverPdfOutputTransactions(directoryPath)).rejects.toMatchObject({
      code: "ATOMIC_OUTPUT_ARTIFACT_INVALID",
    });
    await expect(fs.readFile(externalPath, "utf8")).resolves.toBe("external stage bytes");
    await expect(fs.readFile(path.join(directoryPath, "first.pdf"), "utf8")).resolves.toBe("first original");
    await expect(fs.readFile(path.join(directoryPath, "second.pdf"), "utf8")).resolves.toBe("second original");
  });

  it("rejects a symlinked rollback without following or deleting its target", async () => {
    const directoryPath = await makeTransactionDirectory("symlink-rollback");
    expect((await runCrashChild(directoryPath, "rollback_0")).code).toBe(86);
    const journalName = (await fs.readdir(directoryPath)).find(name => name.endsWith("-transaction.json"));
    const envelope = JSON.parse(await fs.readFile(path.join(directoryPath, journalName), "utf8"));
    const rollbackPath = path.join(directoryPath, envelope.payload.entries[0].rollback);
    const externalPath = `${directoryPath}-external-rollback.pdf`;
    tempDirectories.push(externalPath);
    await fs.writeFile(externalPath, "external rollback bytes");
    await fs.unlink(rollbackPath);
    await fs.symlink(externalPath, rollbackPath);

    await expect(recoverPdfOutputTransactions(directoryPath)).rejects.toMatchObject({
      code: "ATOMIC_OUTPUT_ARTIFACT_INVALID",
    });
    await expect(fs.readFile(externalPath, "utf8")).resolves.toBe("external rollback bytes");
  });

  it("fails closed when a committed target is missing", async () => {
    const directoryPath = await makeTransactionDirectory("missing-committed");
    const child = await runCrashChild(directoryPath, "journal_committed");
    expect(child.code).toBe(86);
    await fs.unlink(path.join(directoryPath, "first.pdf"));

    await expect(recoverPdfOutputTransactions(directoryPath)).rejects.toMatchObject({
      code: "ATOMIC_OUTPUT_RECOVERY_CONFLICT",
    });
    await expect(fs.readFile(path.join(directoryPath, "second.pdf"), "utf8")).resolves.toBe("second replacement");
    expect((await fs.readdir(directoryPath)).some(name => name.endsWith("-transaction.json"))).toBe(true);
  });
});
