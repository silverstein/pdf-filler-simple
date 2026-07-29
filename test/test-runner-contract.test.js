import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { configDefaults } from "vitest/config";
import viteConfigFactory from "../vite.config.mjs";
import {
  NODE_TEST_FILES,
  NODE_TEST_SUITES,
  nodeTestFilesForPlatform,
  nodeTestOmissionsForPlatform,
} from "../scripts/node-test-files.mjs";
import { validateAggregateArguments } from "../scripts/run-all-test-suites.mjs";
import { parseNodeTestArguments } from "../scripts/run-node-test-suites.mjs";
import {
  terminateWindowsTree,
  windowsTaskkillPath,
} from "../scripts/test-process-control.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function waitForProcessToDisappear(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`cancelled fixture process ${pid} is still alive`);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function findNodeTestFiles(directory = path.join(repoRoot, "test")) {
  const matches = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...await findNodeTestFiles(absolutePath));
      continue;
    }
    if (!entry.isFile() || !/\.test\.(?:[cm]?[jt]s)$/.test(entry.name)) continue;
    const source = await fs.readFile(absolutePath, "utf8");
    if (!/(?:from\s+|require\(\s*)["']node:test["']/.test(source)) continue;
    matches.push(path.relative(repoRoot, absolutePath).split(path.sep).join("/"));
  }
  return matches.sort();
}

describe("aggregate test-runner contract", () => {
  it("classifies every node:test suite exactly once", async () => {
    expect([...NODE_TEST_FILES].sort()).toEqual(await findNodeTestFiles());
    expect(new Set(NODE_TEST_FILES).size).toBe(NODE_TEST_FILES.length);
    expect(Object.isFrozen(NODE_TEST_SUITES)).toBe(true);
    expect(NODE_TEST_SUITES.every(suite => suite.platforms.length > 0)).toBe(true);
    expect(NODE_TEST_SUITES.every(suite => Object.isFrozen(suite))).toBe(true);
    for (const platform of ["darwin", "linux", "win32"]) {
      for (const omission of nodeTestOmissionsForPlatform(platform)) {
        expect(omission.reason).toEqual(expect.any(String));
        expect(omission.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it("uses exact, explicit native-suite partitions on each release platform", () => {
    expect(nodeTestFilesForPlatform("win32")).toEqual([
      "test/deep-malformed-native-v2-contract.test.js",
      "test/deep-malformed-native-v3-contract.test.js",
      "test/deep-malformed-native-v4-contract.test.js",
      "test/qpdf-macos-budget-exec.test.js",
      "test/deep-malformed-native-windows-portable.test.js",
    ]);
    const posixFiles = [
      "test/deep-malformed-native-v2-contract.test.js",
      "test/deep-malformed-native-v2-mechanisms.test.js",
      "test/deep-malformed-native-v3-contract.test.js",
      "test/deep-malformed-native-v3-mechanisms.test.js",
      "test/deep-malformed-native-v4-contract.test.js",
      "test/deep-malformed-native-v4-mechanisms.test.js",
      "test/qpdf-macos-budget-exec.test.js",
    ];
    expect(nodeTestFilesForPlatform("darwin")).toEqual(posixFiles);
    expect(nodeTestFilesForPlatform("linux")).toEqual(posixFiles);
    expect(NODE_TEST_FILES).toEqual([
      ...posixFiles,
      "test/deep-malformed-native-windows-portable.test.js",
    ]);
    expect(() => nodeTestFilesForPlatform("android")).toThrow(
      "Unsupported native test platform",
    );
  });

  it("excludes only the classified native suites in addition to Vitest defaults", () => {
    const config = viteConfigFactory({ command: "build", mode: "test" });
    expect(config.test.exclude).toEqual([
      ...configDefaults.exclude,
      ...NODE_TEST_FILES,
    ]);
  });

  it("exposes explicit aggregate and native runner scripts", async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(repoRoot, "package.json"), "utf8"),
    );
    expect(packageJson.scripts["test:node-native"]).toBe(
      "node scripts/run-node-test-suites.mjs",
    );
    expect(packageJson.scripts["test:all"]).toBe(
      "node scripts/run-all-test-suites.mjs",
    );
  });

  it("rejects coverage-changing aggregate and native-runner arguments", () => {
    expect(parseNodeTestArguments([])).toEqual({ reporter: "spec" });
    expect(parseNodeTestArguments(["--reporter=tap"])).toEqual({
      reporter: "tap",
    });
    expect(() => parseNodeTestArguments(["--test-shard=1/2"])).toThrow(
      "Unsupported native-test argument",
    );
    expect(() => parseNodeTestArguments([
      "--reporter=tap",
      "--reporter=spec",
    ])).toThrow("only once");
    expect(() => validateAggregateArguments(["--reporter=tap"])).toThrow(
      "does not accept",
    );
  });

  it("resolves Windows tree termination through the system directory", () => {
    expect(windowsTaskkillPath({ SystemRoot: "C:\\Windows" })).toBe(
      "C:\\Windows\\System32\\taskkill.exe",
    );
    expect(windowsTaskkillPath({})).toBe("taskkill.exe");
  });

  it("bounds Windows taskkill and treats only exit zero as verified", async () => {
    const successfulChild = { pid: 321, kill: vi.fn(() => true) };
    const successfulKiller = new EventEmitter();
    successfulKiller.kill = vi.fn();
    const successfulSpawn = vi.fn(() => successfulKiller);
    const successfulTermination = terminateWindowsTree(successfulChild, {
      environment: { SystemRoot: "C:\\Windows" },
      timeoutMs: 100,
      spawnProcess: successfulSpawn,
    });
    successfulKiller.emit("close", 0, null);
    await expect(successfulTermination).resolves.toEqual({
      verified: true,
      reason: null,
    });
    expect(successfulChild.kill).not.toHaveBeenCalled();
    expect(successfulSpawn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/PID", "321", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
    );

    const failedChild = { pid: 654, kill: vi.fn(() => true) };
    const failedKiller = new EventEmitter();
    failedKiller.kill = vi.fn();
    const failedTermination = terminateWindowsTree(failedChild, {
      environment: {},
      timeoutMs: 100,
      spawnProcess: () => failedKiller,
    });
    failedKiller.emit("close", 1, null);
    await expect(failedTermination).resolves.toEqual({
      verified: false,
      reason:
        "taskkill did not verify tree termination (code=1, signal=null)",
    });
    expect(failedChild.kill).toHaveBeenCalledWith("SIGKILL");

    const hungChild = { pid: 987, kill: vi.fn(() => true) };
    const hungKiller = new EventEmitter();
    hungKiller.kill = vi.fn();
    await expect(terminateWindowsTree(hungChild, {
      environment: {},
      timeoutMs: 10,
      spawnProcess: () => hungKiller,
    })).resolves.toEqual({
      verified: false,
      reason: "taskkill exceeded 10 ms",
    });
    expect(hungKiller.kill).toHaveBeenCalledWith("SIGKILL");
    expect(hungChild.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it.skipIf(process.platform === "win32")(
    "forwards cancellation and reaps the complete POSIX test process group",
    async () => {
      const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "node-runner-signal-"));
      const pidFile = path.join(root, "fixture.pid");
      const helper = spawn(process.execPath, [
        path.join(repoRoot, "test/fixtures/run-node-test-suites-signal-helper.mjs"),
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PDF_TOOLS_NODE_RUNNER_FIXTURE_PID_FILE: pidFile,
        },
        stdio: "ignore",
      });
      let fixturePid = null;
      try {
        const deadline = Date.now() + 5_000;
        while (true) {
          try {
            await fs.access(pidFile);
            break;
          } catch {
            if (Date.now() >= deadline) throw new Error("signal fixture did not start");
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        }
        fixturePid = Number(await fs.readFile(pidFile, "utf8"));
        expect(Number.isSafeInteger(fixturePid)).toBe(true);
        helper.kill("SIGTERM");
        const exit = await Promise.race([
          new Promise(resolve => helper.once("close", (code, signal) => resolve({ code, signal }))),
          new Promise((_, reject) => setTimeout(
            () => reject(new Error("test runner did not terminate")),
            5_000,
          )),
        ]);
        expect(exit).toEqual({ code: 143, signal: null });
        await waitForProcessToDisappear(fixturePid);
      } finally {
        if (helper.exitCode === null && helper.signalCode === null) helper.kill("SIGKILL");
        if (fixturePid !== null) {
          try {
            process.kill(fixturePid, "SIGKILL");
          } catch {}
        }
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
