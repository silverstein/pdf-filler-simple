import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_TOTAL_BYTES = 32 * 1024 * 1024;
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function sanitizedGitEnvironment(environment = process.env) {
  const sanitized = { ...environment };
  for (const name of Object.keys(sanitized)) {
    if (name.toUpperCase().startsWith("GIT_")) delete sanitized[name];
  }
  return {
    ...sanitized,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export function validateSourceIdentitySnapshot({
  headBefore,
  status,
  headAfter,
}, label = "source worktree") {
  const before = headBefore.trim();
  const after = headAfter.trim();
  if (!FULL_OBJECT_ID.test(before) || !FULL_OBJECT_ID.test(after)) {
    throw new Error(`${label} did not resolve one full commit object ID`);
  }
  if (before !== after) {
    throw new Error(`${label} HEAD changed during verification`);
  }
  if (status.length > 0) {
    throw new Error(`${label} must be clean at its exact HEAD`);
  }
  return before;
}

async function defaultRunGit(repoRoot, arguments_, options) {
  return execFileAsync("git", ["-C", repoRoot, ...arguments_], options);
}

function gitExecutionOptions(environment, encoding = "utf8") {
  return {
    encoding,
    env: sanitizedGitEnvironment(environment),
    killSignal: "SIGKILL",
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  };
}

export function validateRepositoryRelativePath(
  relativePath,
  label = "repository path",
) {
  if (
    typeof relativePath !== "string"
    || relativePath.length === 0
    || relativePath.includes("\0")
    || relativePath.includes(":")
    || relativePath.includes("\\")
    || path.posix.isAbsolute(relativePath)
  ) {
    throw new Error(`${label} must be a normalized repository-relative POSIX path`);
  }
  const normalized = path.posix.normalize(relativePath);
  if (
    normalized !== relativePath
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    throw new Error(`${label} must be a normalized repository-relative POSIX path`);
  }
  return relativePath;
}

async function canonicalRepositoryIdentity(repoRoot, runGit, options, label) {
  const canonicalRoot = await fs.realpath(repoRoot);
  const { stdout: topLevel } = await runGit(
    repoRoot,
    ["rev-parse", "--show-toplevel"],
    options,
  );
  const canonicalTopLevel = await fs.realpath(topLevel.trim());
  if (canonicalTopLevel !== canonicalRoot) {
    throw new Error(`${label} resolved outside its requested repository root`);
  }
  const { stdout: gitDirectory } = await runGit(
    repoRoot,
    ["rev-parse", "--absolute-git-dir"],
    options,
  );
  const { stdout: indexPath } = await runGit(
    repoRoot,
    ["rev-parse", "--path-format=absolute", "--git-path", "index"],
    options,
  );
  return {
    topLevel: canonicalTopLevel,
    gitDirectory: path.resolve(gitDirectory.trim()),
    indexPath: path.resolve(indexPath.trim()),
  };
}

export async function collectSourceIdentitySnapshot(
  repoRoot,
  {
    environment = process.env,
    label = "source worktree",
    runGit = defaultRunGit,
  } = {},
) {
  const options = gitExecutionOptions(environment);
  const repositoryIdentity = await canonicalRepositoryIdentity(
    repoRoot,
    runGit,
    options,
    label,
  );
  const { stdout: headBefore } = await runGit(
    repoRoot,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    options,
  );
  const { stdout: status } = await runGit(
    repoRoot,
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ],
    options,
  );
  const { stdout: headAfter } = await runGit(
    repoRoot,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    options,
  );
  return {
    headBefore,
    status,
    headAfter,
    repositoryIdentity,
  };
}

export async function verifiedCleanSourceCommit(
  repoRoot,
  options = {},
) {
  const { label = "source worktree" } = options;
  const snapshot = await collectSourceIdentitySnapshot(repoRoot, options);
  return validateSourceIdentitySnapshot(
    snapshot,
    label,
  );
}

function validateSnapshotLimits(maxFileBytes, maxTotalBytes) {
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new Error("snapshot per-file byte limit must be a positive integer");
  }
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < maxFileBytes) {
    throw new Error("snapshot total byte limit must cover at least one file");
  }
}

function validateSnapshotBytes(bytes, relativePath, limits) {
  if (!Buffer.isBuffer(bytes)) {
    throw new Error(`commit snapshot returned non-binary data for ${relativePath}`);
  }
  if (bytes.length > limits.maxFileBytes) {
    throw new Error(`commit snapshot file exceeds its byte limit: ${relativePath}`);
  }
  limits.totalBytes += bytes.length;
  if (limits.totalBytes > limits.maxTotalBytes) {
    throw new Error("commit snapshot exceeds its aggregate byte limit");
  }
  return bytes;
}

export async function openVerifiedSourceSnapshot(
  repoRoot,
  {
    environment = process.env,
    label = "source worktree",
    maxFileBytes = DEFAULT_MAX_SNAPSHOT_FILE_BYTES,
    maxTotalBytes = DEFAULT_MAX_SNAPSHOT_TOTAL_BYTES,
    runGit = defaultRunGit,
  } = {},
) {
  validateSnapshotLimits(maxFileBytes, maxTotalBytes);
  const commit = await verifiedCleanSourceCommit(repoRoot, {
    environment,
    label,
    runGit,
  });
  const textOptions = gitExecutionOptions(environment);
  const binaryOptions = gitExecutionOptions(environment, null);
  const limits = { maxFileBytes, maxTotalBytes, totalBytes: 0 };

  const readObject = async (objectId, relativePath) => {
    if (!FULL_OBJECT_ID.test(objectId)) {
      throw new Error(`commit snapshot tree has an invalid object ID: ${relativePath}`);
    }
    const { stdout } = await runGit(
      repoRoot,
      ["cat-file", "blob", objectId],
      binaryOptions,
    );
    return validateSnapshotBytes(stdout, relativePath, limits);
  };

  const readFile = async relativePath => {
    validateRepositoryRelativePath(relativePath, "commit snapshot file");
    const { stdout } = await runGit(
      repoRoot,
      ["cat-file", "blob", `${commit}:${relativePath}`],
      binaryOptions,
    );
    return validateSnapshotBytes(stdout, relativePath, limits);
  };

  const readTree = async relativeRoot => {
    validateRepositoryRelativePath(relativeRoot, "commit snapshot tree");
    const { stdout } = await runGit(
      repoRoot,
      [
        "ls-tree",
        "-r",
        "-z",
        "--full-tree",
        commit,
        "--",
        relativeRoot,
      ],
      textOptions,
    );
    const entries = [];
    const seen = new Set();
    const prefix = `${relativeRoot}/`;
    for (const record of stdout.split("\0").filter(Boolean)) {
      const match = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(record);
      if (!match) {
        throw new Error(`commit snapshot tree has an unsupported entry: ${relativeRoot}`);
      }
      const [, mode, objectId, fullPath] = match;
      validateRepositoryRelativePath(fullPath, "commit snapshot tree entry");
      if (!fullPath.startsWith(prefix)) {
        throw new Error(`commit snapshot tree entry escaped its requested root: ${fullPath}`);
      }
      const relativePath = fullPath.slice(prefix.length);
      validateRepositoryRelativePath(relativePath, "commit snapshot relative entry");
      if (seen.has(relativePath)) {
        throw new Error(`commit snapshot tree contains a duplicate path: ${relativePath}`);
      }
      seen.add(relativePath);
      entries.push(Object.freeze({
        bytes: await readObject(objectId, fullPath),
        mode,
        path: relativePath,
      }));
    }
    if (entries.length === 0) {
      throw new Error(`commit snapshot tree is empty or missing: ${relativeRoot}`);
    }
    entries.sort((left, right) => (
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    ));
    return Object.freeze(entries);
  };

  const verifyUnchanged = async () => {
    const verifiedCommit = await verifiedCleanSourceCommit(repoRoot, {
      environment,
      label,
      runGit,
    });
    if (verifiedCommit !== commit) {
      throw new Error(`${label} changed after its commit snapshot was opened`);
    }
    return verifiedCommit;
  };

  return Object.freeze({
    commit,
    readFile,
    readTree,
    verifyUnchanged,
  });
}
