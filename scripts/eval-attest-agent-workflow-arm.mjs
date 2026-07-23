#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function listFiles(root, relativeRoot = "") {
  const entries = await fs.readdir(path.join(root, relativeRoot), { withFileTypes: true });
  entries.sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ));
  const files = [];
  for (const entry of entries) {
    if (relativeRoot === "" && entry.name === ".git") continue;
    const relative = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, relative));
    else if (entry.isFile()) files.push(relative.split(path.sep).join("/"));
    else throw new Error(`Unsupported participant entry: ${relative}`);
  }
  return files;
}

async function inventory(root) {
  const entries = [];
  for (const relative of await listFiles(root)) {
    const bytes = await fs.readFile(path.join(root, relative));
    entries.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return {
    file_count: entries.length,
    total_bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    tree_sha256: sha256(canonicalJson(entries)),
    entries,
  };
}

async function git(root, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
  });
  return stdout.trim();
}

export async function attestAgentWorkflowArm({
  armRoot,
  expectedCommitSha1,
  expectedTreeSha1,
  expectedContentTreeSha256,
}) {
  if (!path.isAbsolute(armRoot)) throw new Error("armRoot must be absolute");
  const contentInventory = await inventory(armRoot);
  const trackedFiles = (await git(armRoot, ["ls-files", "-z"]))
    .split("\0")
    .filter(Boolean);
  const head = await git(armRoot, ["rev-parse", "HEAD"]);
  const headTree = await git(armRoot, ["rev-parse", "HEAD^{tree}"]);
  const commitLine = (await git(armRoot, ["rev-list", "--parents", "-n", "1", "HEAD"]))
    .split(/\s+/);
  const commitCount = Number(await git(armRoot, ["rev-list", "--count", "HEAD"]));
  const status = await git(armRoot, ["status", "--porcelain", "--untracked-files=all"]);
  const errors = [];

  if (contentInventory.tree_sha256 !== expectedContentTreeSha256) {
    errors.push("participant content tree does not match the trusted preparation manifest");
  }
  if (head !== expectedCommitSha1) {
    errors.push("synthetic commit does not match the trusted preparation manifest");
  }
  if (headTree !== expectedTreeSha1) {
    errors.push("synthetic Git tree does not match the trusted preparation manifest");
  }
  if (commitLine.length !== 1 || commitCount !== 1) {
    errors.push("synthetic repository must contain exactly one parentless commit");
  }
  if (status) errors.push("synthetic participant repository must be clean");
  if (
    canonicalJson([...trackedFiles].sort())
    !== canonicalJson(contentInventory.entries.map(entry => entry.path).sort())
  ) {
    errors.push("tracked-file inventory must equal the participant content inventory");
  }

  return {
    schema_version: "pdf-tools.agent-workflow-arm-attestation.v1",
    arm_root: armRoot,
    pass: errors.length === 0,
    errors,
    commit_sha1: head,
    commit_count: commitCount,
    parent_count: commitLine.length - 1,
    git_tree_sha1: headTree,
    content_inventory: contentInventory,
    tracked_files: trackedFiles,
    clean: status === "",
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    values[argv[index]] = argv[index + 1];
  }
  for (const required of [
    "--arm-root",
    "--expected-commit-sha1",
    "--expected-tree-sha1",
    "--expected-content-tree-sha256",
  ]) {
    if (!values[required]) throw new Error(`Missing required argument: ${required}`);
  }
  return {
    armRoot: values["--arm-root"],
    expectedCommitSha1: values["--expected-commit-sha1"],
    expectedTreeSha1: values["--expected-tree-sha1"],
    expectedContentTreeSha256: values["--expected-content-tree-sha256"],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await attestAgentWorkflowArm(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.pass) process.exitCode = 1;
}
