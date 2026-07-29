import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const MAX_OUTPUT_BYTES = 64 * 1024;
const WALL_TIMEOUT_MS = 15_000;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })));
});

function boundedAppend(current, chunk) {
  const combined = `${current}${chunk}`;
  return combined.length > MAX_OUTPUT_BYTES
    ? combined.slice(combined.length - MAX_OUTPUT_BYTES)
    : combined;
}

async function runFixture(control) {
  const stateRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-vitest-order-")),
  );
  temporaryRoots.push(stateRoot);
  const environment = {
    ...process.env,
    FORCE_COLOR: "0",
    OFFLINE: "1",
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
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", chunk => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr.on("data", chunk => {
      stderr = boundedAppend(stderr, chunk);
    });
    child.once("error", reject);
    const timeout = setTimeout(async () => {
      timedOut = true;
      if (process.platform === "win32") {
        await terminateWindowsTree(child, {
          environment,
          timeoutMs: 1_000,
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") reject(error);
        }
      }
    }, WALL_TIMEOUT_MS);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stderr, stdout, timedOut });
    });
  });
  const observation = JSON.parse(await fs.readFile(
    path.join(stateRoot, "source-observation.json"),
    "utf8",
  ));
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
  });
});
