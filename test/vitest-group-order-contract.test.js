import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { terminateWindowsTree } from "../scripts/test-process-control.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vitestEntry = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const fixtureConfig = path.join(
  repoRoot,
  "test",
  "fixtures",
  "vitest-group-order",
  "vitest.fixture.config.mjs",
);
const temporaryRoots = [];
const activeChildren = new Set();
const MAX_OUTPUT_BYTES = 64 * 1024;
const WALL_TIMEOUT_MS = 15_000;
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all([...activeChildren].map(child =>
    terminateFixtureTree(child, process.env)));
  await Promise.all(temporaryRoots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })));
});

function boundedAppend(current, chunk) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  return combined.length > MAX_OUTPUT_BYTES
    ? combined.subarray(combined.length - MAX_OUTPUT_BYTES)
    : combined;
}

async function terminateFixtureTree(child, environment) {
  if (
    !child
    || child.exitCode !== null
    || child.signalCode !== null
    || !Number.isSafeInteger(child.pid)
  ) {
    return;
  }
  if (process.platform === "win32") {
    await terminateWindowsTree(child, {
      environment,
      timeoutMs: 1_000,
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function runFixture(control) {
  const stateRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-vitest-order-")),
  );
  temporaryRoots.push(stateRoot);
  const repositoryRoot = path.join(stateRoot, "repository");
  const templateRoot = path.join(stateRoot, "empty-template");
  await fs.mkdir(repositoryRoot);
  await fs.mkdir(templateRoot);
  const isolatedGitEnvironment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (...arguments_) => execFileAsync("git", [
    "-c",
    "commit.gpgSign=false",
    "-c",
    "core.autocrlf=false",
    "-C",
    repositoryRoot,
    ...arguments_,
  ], {
    encoding: "utf8",
    env: isolatedGitEnvironment,
  });
  await git("init", "--quiet", `--template=${templateRoot}`);
  await git("config", "user.name", "PDF Tools Test");
  await git("config", "user.email", "pdf-tools-test@example.invalid");
  await fs.writeFile(path.join(repositoryRoot, "tracked.txt"), "fixture\n");
  await git("add", "--", "tracked.txt");
  await git("commit", "--quiet", "-m", "fixture");
  const environment = {
    ...process.env,
    FORCE_COLOR: "0",
    OFFLINE: "1",
    PDF_TOOLS_VITEST_ORDER_REPOSITORY: repositoryRoot,
    PDF_TOOLS_VITEST_ORDER_STATE: stateRoot,
    VITEST_SKIP_INSTALL_CHECKS: "1",
  };
  delete environment.VITEST_MAX_WORKERS;
  delete environment.VITEST_POOL_ID;
  delete environment.VITEST_WORKER_ID;
  if (control) environment.PDF_TOOLS_VITEST_ORDER_CONTROL = control;
  else delete environment.PDF_TOOLS_VITEST_ORDER_CONTROL;

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      vitestEntry,
      "run",
      "--config",
      fixtureConfig,
      "--reporter=dot",
    ], {
      cwd: repoRoot,
      detached: process.platform !== "win32",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: process.platform === "win32",
    });
    activeChildren.add(child);
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    let timeout = null;
    const signalHandlers = new Map();
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
      activeChildren.delete(child);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code,
        signal,
        stderr: stderr.toString("utf8"),
        stdout: stdout.toString("utf8"),
        timedOut,
      });
    };
    child.stdout.on("data", chunk => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr.on("data", chunk => {
      stderr = boundedAppend(stderr, chunk);
    });
    child.once("error", fail);
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        void terminateFixtureTree(child, environment);
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
    timeout = setTimeout(async () => {
      timedOut = true;
      try {
        await terminateFixtureTree(child, environment);
      } catch (error) {
        fail(error);
      }
    }, WALL_TIMEOUT_MS);
    child.once("close", finish);
  });
  let observation;
  try {
    observation = JSON.parse(await fs.readFile(
      path.join(stateRoot, "source-observation.json"),
      "utf8",
    ));
  } catch (error) {
    throw new Error(
      `fixture did not write its observation `
      + `(code=${result.code}, signal=${result.signal}, timedOut=${result.timedOut}): `
      + `${error.message}\n${result.stdout}\n${result.stderr}`,
      { cause: error },
    );
  }
  return { ...result, observation };
}

describe("Vitest source-identity group barrier", () => {
  it("completes ordinary teardown before source identity and fails an inverted control", async () => {
    const positive = await runFixture(null);
    expect(positive).toMatchObject({
      code: 0,
      signal: null,
      timedOut: false,
      observation: {
        completeAtStart: true,
        activeAtStart: false,
        teardownStartedAtStart: true,
      },
    });

    const inverted = await runFixture("source-first");
    expect(inverted.code).not.toBe(0);
    expect(inverted.timedOut).toBe(false);
    expect(inverted.observation).toEqual({
      completeAtStart: false,
      activeAtStart: false,
      teardownStartedAtStart: false,
    });
    expect(`${inverted.stdout}\n${inverted.stderr}`).toContain(
      "VITEST_GROUP_ORDER_BARRIER_VIOLATION",
    );

    const overlap = await runFixture("overlap");
    expect(overlap.code).not.toBe(0);
    expect(overlap.timedOut).toBe(false);
    expect(overlap.observation).toEqual({
      completeAtStart: false,
      activeAtStart: true,
      teardownStartedAtStart: false,
    });
    expect(`${overlap.stdout}\n${overlap.stderr}`).toContain(
      "EXPECTED_GIT_VISIBLE_INTERFERENCE",
    );
  });
});
