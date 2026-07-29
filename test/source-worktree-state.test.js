import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectSourceIdentitySnapshot,
  openVerifiedSourceSnapshot,
  sanitizedGitEnvironment,
  validateRepositoryRelativePath,
  validateSourceIdentitySnapshot,
  verifiedCleanSourceCommit,
} from "../scripts/source-worktree-state.mjs";

const execFileAsync = promisify(execFile);
const temporaryRoots = [];
const isolatedGitEnvironment = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_TERMINAL_PROMPT: "0",
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })));
});

async function git(repoRoot, ...arguments_) {
  return execFileAsync("git", [
    "-c",
    "commit.gpgSign=false",
    "-c",
    "core.autocrlf=false",
    "-C",
    repoRoot,
    ...arguments_,
  ], {
    encoding: "utf8",
    env: isolatedGitEnvironment,
  });
}

async function createSyntheticRepository(content = "original\n") {
  const fixtureRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-source-state-")),
  );
  temporaryRoots.push(fixtureRoot);
  const repoRoot = path.join(fixtureRoot, "repo");
  const templateRoot = path.join(fixtureRoot, "empty-template");
  await fs.mkdir(repoRoot);
  await fs.mkdir(templateRoot);
  await git(repoRoot, "init", "--quiet", `--template=${templateRoot}`);
  await git(repoRoot, "config", "user.name", "PDF Tools Test");
  await git(repoRoot, "config", "user.email", "pdf-tools-test@example.invalid");
  await fs.writeFile(path.join(repoRoot, ".gitignore"), ".test-tmp*/\n");
  await fs.writeFile(path.join(repoRoot, "tracked.txt"), content);
  await git(repoRoot, "add", "--", ".gitignore", "tracked.txt");
  await git(repoRoot, "commit", "--quiet", "-m", "fixture");
  return repoRoot;
}

describe("source worktree identity", () => {
  it("requires one unchanged HEAD and an empty porcelain status", () => {
    const head = "a".repeat(40);
    expect(validateSourceIdentitySnapshot({
      headBefore: `${head}\n`,
      status: "",
      headAfter: `${head}\n`,
    })).toBe(head);
    for (const status of [
      "?? arbitrary.txt\0",
      " M tracked.txt\0",
      "M  tracked.txt\0",
      "A  staged-new.txt\0",
    ]) {
      expect(() => validateSourceIdentitySnapshot({
        headBefore: head,
        status,
        headAfter: head,
      }, "campaign source worktree")).toThrow(
        "campaign source worktree must be clean at its exact HEAD",
      );
    }
    expect(() => validateSourceIdentitySnapshot({
      headBefore: "a".repeat(40),
      status: "",
      headAfter: "b".repeat(40),
    })).toThrow("source worktree HEAD changed during verification");
    expect(() => validateSourceIdentitySnapshot({
      headBefore: "not-an-object-id",
      status: "",
      headAfter: "not-an-object-id",
    })).toThrow("did not resolve one full commit object ID");
  });

  it("passes ignored harness scratch but rejects real untracked, modified, and staged state", async () => {
    const repoRoot = await createSyntheticRepository();
    const { stdout: head } = await git(repoRoot, "rev-parse", "HEAD");
    const ignoredRoot = path.join(repoRoot, ".test-tmp-proof-1");
    await fs.mkdir(ignoredRoot);
    await fs.writeFile(path.join(ignoredRoot, "output.pdf"), "ignored\n");
    await expect(verifiedCleanSourceCommit(repoRoot)).resolves.toBe(head.trim());

    const arbitrary = path.join(repoRoot, "arbitrary.txt");
    await fs.writeFile(arbitrary, "untracked\n");
    await expect(verifiedCleanSourceCommit(repoRoot)).rejects.toThrow(
      "source worktree must be clean at its exact HEAD",
    );
    await fs.rm(arbitrary);

    const tracked = path.join(repoRoot, "tracked.txt");
    await fs.writeFile(tracked, "modified\n");
    await expect(verifiedCleanSourceCommit(repoRoot)).rejects.toThrow(
      "source worktree must be clean at its exact HEAD",
    );
    await git(repoRoot, "add", "--", "tracked.txt");
    await expect(verifiedCleanSourceCommit(repoRoot)).rejects.toThrow(
      "source worktree must be clean at its exact HEAD",
    );
    await fs.writeFile(tracked, "original\n");
    await git(repoRoot, "add", "--", "tracked.txt");
    await expect(verifiedCleanSourceCommit(repoRoot)).resolves.toBe(head.trim());

    const stagedNew = path.join(repoRoot, "staged-new.txt");
    await fs.writeFile(stagedNew, "staged\n");
    await git(repoRoot, "add", "--", "staged-new.txt");
    await expect(verifiedCleanSourceCommit(repoRoot)).rejects.toThrow(
      "source worktree must be clean at its exact HEAD",
    );
  });

  it("removes every inherited Git override and installs controlled defaults", () => {
    const environment = {
      PATH: process.env.PATH,
      GIT_DIR: "/alternate/git",
      GIT_WORK_TREE: "/alternate/worktree",
      GIT_INDEX_FILE: "/alternate/index",
      GIT_COMMON_DIR: "/alternate/common",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.excludesFile",
      GIT_CONFIG_VALUE_0: "/alternate/excludes",
      GIT_OBJECT_DIRECTORY: "/alternate/objects",
      git_work_tree: "/mixed-case/alternate",
    };
    const sanitized = sanitizedGitEnvironment(environment);
    expect(sanitized.PATH).toBe(environment.PATH);
    for (const name of Object.keys(environment).filter(name => name.startsWith("GIT_"))) {
      expect(sanitized[name]).not.toBe(environment[name]);
    }
    expect(sanitized).toMatchObject({
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  it("cannot be redirected to an alternate repository, worktree, index, or ignore config", async () => {
    const requestedRoot = await createSyntheticRepository("requested\n");
    const alternateRoot = await createSyntheticRepository("alternate\n");
    const { stdout: requestedHead } = await git(requestedRoot, "rev-parse", "HEAD");
    const excludesPath = path.join(path.dirname(requestedRoot), "injected-excludes");
    await fs.writeFile(excludesPath, "arbitrary.txt\n");

    await expect(verifiedCleanSourceCommit(requestedRoot, {
      environment: {
        ...process.env,
        GIT_COMMON_DIR: path.join(alternateRoot, ".git"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.excludesFile",
        GIT_CONFIG_VALUE_0: excludesPath,
        GIT_DIR: path.join(alternateRoot, ".git"),
        GIT_INDEX_FILE: path.join(alternateRoot, ".git", "index"),
        GIT_WORK_TREE: alternateRoot,
      },
    })).resolves.toBe(requestedHead.trim());

    await fs.writeFile(path.join(requestedRoot, "arbitrary.txt"), "visible\n");
    await expect(verifiedCleanSourceCommit(requestedRoot, {
      environment: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.excludesFile",
        GIT_CONFIG_VALUE_0: excludesPath,
      },
    })).rejects.toThrow("must be clean at its exact HEAD");
  });

  it("detects a real HEAD change between its status and final commit probes", async () => {
    const repoRoot = await createSyntheticRepository();
    let changedHead = false;
    const runGit = async (root, arguments_, options) => {
      const result = await execFileAsync(
        "git",
        ["-C", root, ...arguments_],
        options,
      );
      if (arguments_[0] === "status" && !changedHead) {
        changedHead = true;
        await fs.writeFile(path.join(root, "second.txt"), "second\n");
        await git(root, "add", "--", "second.txt");
        await git(root, "commit", "--quiet", "-m", "second");
      }
      return result;
    };
    await expect(verifiedCleanSourceCommit(repoRoot, { runGit })).rejects.toThrow(
      "source worktree HEAD changed during verification",
    );
    expect(changedHead).toBe(true);
  });

  it("binds the requested repository root and records its metadata identities", async () => {
    const repoRoot = await createSyntheticRepository();
    const snapshot = await collectSourceIdentitySnapshot(repoRoot);
    expect(snapshot.repositoryIdentity).toMatchObject({
      topLevel: repoRoot,
      gitDirectory: path.join(repoRoot, ".git"),
      indexPath: path.join(repoRoot, ".git", "index"),
    });
    await fs.mkdir(path.join(repoRoot, "nested"));
    await expect(verifiedCleanSourceCommit(path.join(repoRoot, "nested"))).rejects.toThrow(
      "resolved outside its requested repository root",
    );
  });

  it("reads a sealed tracked tree from commit objects and excludes later ignored or untracked files", async () => {
    const repoRoot = await createSyntheticRepository();
    const pluginRoot = path.join(repoRoot, "plugin");
    await fs.mkdir(pluginRoot);
    await fs.writeFile(path.join(pluginRoot, "tracked.txt"), "commit-a\n");
    await fs.appendFile(path.join(repoRoot, ".gitignore"), "plugin/ignored.txt\n");
    await git(repoRoot, "add", "--", ".gitignore", "plugin/tracked.txt");
    await git(repoRoot, "commit", "--quiet", "-m", "plugin fixture");

    const snapshot = await openVerifiedSourceSnapshot(repoRoot);
    const commitA = snapshot.commit;
    await expect(snapshot.readFile("plugin/tracked.txt")).resolves.toEqual(
      Buffer.from("commit-a\n"),
    );

    await fs.writeFile(path.join(pluginRoot, "ignored.txt"), "must-not-copy\n");
    await fs.writeFile(path.join(pluginRoot, "untracked.txt"), "must-not-copy\n");
    const tree = await snapshot.readTree("plugin");
    expect(tree.map(entry => entry.path)).toEqual(["tracked.txt"]);
    expect(tree[0].bytes).toEqual(Buffer.from("commit-a\n"));
    await fs.rm(path.join(pluginRoot, "untracked.txt"));
    await expect(snapshot.verifyUnchanged()).resolves.toBe(commitA);

    await fs.writeFile(path.join(pluginRoot, "tracked.txt"), "commit-b\n");
    await git(repoRoot, "add", "--", "plugin/tracked.txt");
    await git(repoRoot, "commit", "--quiet", "-m", "changed plugin");
    await expect(snapshot.readFile("plugin/tracked.txt")).resolves.toEqual(
      Buffer.from("commit-a\n"),
    );
    await expect(snapshot.verifyUnchanged()).rejects.toThrow(
      "source worktree changed after its commit snapshot was opened",
    );
  });

  it("disables repository replacement refs for commit-object reads", async () => {
    const repoRoot = await createSyntheticRepository("commit-a\n");
    const { stdout: commitAOutput } = await git(repoRoot, "rev-parse", "HEAD");
    const commitA = commitAOutput.trim();
    await fs.writeFile(path.join(repoRoot, "tracked.txt"), "commit-b\n");
    await git(repoRoot, "add", "--", "tracked.txt");
    await git(repoRoot, "commit", "--quiet", "-m", "replacement target");
    const { stdout: commitBOutput } = await git(repoRoot, "rev-parse", "HEAD");
    const commitB = commitBOutput.trim();

    await git(repoRoot, "update-ref", "HEAD", commitA);
    await fs.writeFile(path.join(repoRoot, "tracked.txt"), "commit-a\n");
    await git(repoRoot, "add", "--", "tracked.txt");
    await git(repoRoot, "replace", commitA, commitB);

    const snapshot = await openVerifiedSourceSnapshot(repoRoot);
    expect(snapshot.commit).toBe(commitA);
    await expect(snapshot.readFile("tracked.txt")).resolves.toEqual(
      Buffer.from("commit-a\n"),
    );
    await expect(snapshot.verifyUnchanged()).resolves.toBe(commitA);
  });

  it("rejects unsafe snapshot paths, missing blobs, and unsupported limits", async () => {
    for (const unsafePath of [
      "",
      "../escape",
      "./relative",
      "/absolute",
      "folder\\windows",
      "commit:path",
      "nul\0path",
    ]) {
      expect(() => validateRepositoryRelativePath(unsafePath)).toThrow(
        "must be a normalized repository-relative POSIX path",
      );
    }
    const repoRoot = await createSyntheticRepository();
    const snapshot = await openVerifiedSourceSnapshot(repoRoot);
    await expect(snapshot.readFile("missing.txt")).rejects.toThrow();
    await expect(openVerifiedSourceSnapshot(repoRoot, {
      maxFileBytes: 0,
    })).rejects.toThrow("per-file byte limit");
    await expect(openVerifiedSourceSnapshot(repoRoot, {
      maxFileBytes: 2,
      maxTotalBytes: 1,
    })).rejects.toThrow("total byte limit");
    const limited = await openVerifiedSourceSnapshot(repoRoot, {
      maxFileBytes: 2,
      maxTotalBytes: 4,
    });
    await expect(limited.readFile("tracked.txt")).rejects.toThrow(
      "file exceeds its byte limit",
    );
  });
});
