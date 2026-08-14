import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import nodeVersionChecker from "../scripts/agent-plugin-launchers/check-node-version.cjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POSIX_LAUNCHER = path.join(
  REPO_ROOT,
  "scripts",
  "agent-plugin-launchers",
  "pdf-tools-launch",
);
const WINDOWS_LAUNCHER = `${POSIX_LAUNCHER}.cmd`;
const NODE_VERSION_CHECKER = path.join(path.dirname(POSIX_LAUNCHER), "check-node-version.cjs");
const { isSupportedNodeVersion } = nodeVersionChecker;
const temporaryRoots = [];

function temporaryRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "pdf-tools-plugin-launcher-"));
  temporaryRoots.push(root);
  return root;
}

function pluginFixture() {
  const root = temporaryRoot();
  mkdirSync(path.join(root, "bin"), { recursive: true });
  mkdirSync(path.join(root, "server"), { recursive: true });
  copyFileSync(POSIX_LAUNCHER, path.join(root, "bin", "pdf-tools-launch"));
  copyFileSync(NODE_VERSION_CHECKER, path.join(root, "bin", "check-node-version.cjs"));
  chmodSync(path.join(root, "bin", "pdf-tools-launch"), 0o755);
  writeFileSync(
    path.join(root, "server", "index.js"),
    "process.stdout.write(JSON.stringify({ execPath: process.execPath, argv: process.argv.slice(2) }));\n",
  );
  return root;
}

function linkNode(destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  symlinkSync(process.execPath, destination);
}

function runLauncher(pluginRoot, env = {}, args = []) {
  return spawnSync(path.join(pluginRoot, "bin", "pdf-tools-launch"), args, {
    cwd: pluginRoot,
    encoding: "utf8",
    env,
  });
}

function expectSuccessfulLaunch(result, expectedNode = process.execPath) {
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  const output = JSON.parse(result.stdout);
  expect(output.execPath).toBe(expectedNode);
  return output;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe.runIf(process.platform !== "win32")("Agent Plugin POSIX launcher", () => {
  it("uses a compatible Node already on PATH and forwards arguments", () => {
    const pluginRoot = pluginFixture();
    const pathBin = path.join(temporaryRoot(), "bin");
    linkNode(path.join(pathBin, "node"));

    const result = runLauncher(pluginRoot, {
      HOME: temporaryRoot(),
      PATH: pathBin,
    }, ["--fixture", "value with spaces"]);

    const output = expectSuccessfulLaunch(result);
    expect(output.argv).toEqual(["--fixture", "value with spaces"]);
  });

  it("uses NVM_BIN when PATH does not contain Node", () => {
    const pluginRoot = pluginFixture();
    const nvmBin = path.join(temporaryRoot(), "nvm-bin");
    linkNode(path.join(nvmBin, "node"));

    const result = runLauncher(pluginRoot, {
      HOME: temporaryRoot(),
      NVM_BIN: nvmBin,
      PATH: temporaryRoot(),
    });

    expectSuccessfulLaunch(result);
  });

  it("finds an installed NVM version from HOME in a sanitized environment", () => {
    const pluginRoot = pluginFixture();
    const home = temporaryRoot();
    linkNode(path.join(home, ".nvm", "versions", "node", "v22.12.0", "bin", "node"));

    const result = runLauncher(pluginRoot, {
      HOME: home,
      PATH: temporaryRoot(),
    });

    expectSuccessfulLaunch(result);
  });

  it("honors an explicit custom NVM_DIR", () => {
    const pluginRoot = pluginFixture();
    const nvmDirectory = path.join(temporaryRoot(), "custom-nvm-root");
    linkNode(path.join(nvmDirectory, "versions", "node", "v22.12.0", "bin", "node"));

    const result = runLauncher(pluginRoot, {
      HOME: temporaryRoot(),
      NVM_DIR: nvmDirectory,
      PATH: temporaryRoot(),
    });

    expectSuccessfulLaunch(result);
  });

  it("uses the NVM default selected by nvm.sh without loading a shell profile", () => {
    const pluginRoot = pluginFixture();
    const home = temporaryRoot();
    const nvmDirectory = path.join(home, ".nvm");
    const defaultNode = path.join(nvmDirectory, "selected", "node");
    linkNode(defaultNode);
    writeFileSync(
      path.join(nvmDirectory, "nvm.sh"),
      `nvm() {\n  if [ "$1" = "which" ] && [ "$2" = "default" ]; then\n    printf '%s\\n' ${JSON.stringify(defaultNode)}\n    return 0\n  fi\n  return 1\n}\n`,
    );

    const result = runLauncher(pluginRoot, {
      HOME: home,
      PATH: temporaryRoot(),
    });

    expectSuccessfulLaunch(result);
  });

  it("skips an incompatible PATH runtime when NVM has a compatible one", () => {
    const pluginRoot = pluginFixture();
    const pathBin = temporaryRoot();
    const incompatibleNode = path.join(pathBin, "node");
    writeFileSync(incompatibleNode, "#!/bin/sh\nexit 1\n");
    chmodSync(incompatibleNode, 0o755);
    const home = temporaryRoot();
    linkNode(path.join(home, ".nvm", "versions", "node", "v23.0.0", "bin", "node"));

    const result = runLauncher(pluginRoot, { HOME: home, PATH: pathBin });

    expectSuccessfulLaunch(result);
  });

  it("fails clearly and keeps stdout clean when Node is missing", () => {
    const pluginRoot = pluginFixture();
    const result = runLauncher(pluginRoot, {
      HOME: temporaryRoot(),
      PATH: temporaryRoot(),
    });

    expect(result.status).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("could not find Node.js in PATH or your NVM installation");
    expect(result.stderr).toContain("nvm alias default <version>");
  });

  it("fails clearly when it finds only an incompatible runtime", () => {
    const pluginRoot = pluginFixture();
    const pathBin = temporaryRoot();
    const incompatibleNode = path.join(pathBin, "node");
    writeFileSync(incompatibleNode, "#!/bin/sh\nexit 1\n");
    chmodSync(incompatibleNode, 0o755);

    const result = runLauncher(pluginRoot, {
      HOME: temporaryRoot(),
      PATH: pathBin,
    });

    expect(result.status).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("found Node.js, but not a supported version");
    expect(result.stderr).toContain("Node.js 20.19+ or 22.12+");
  });
});

describe("Agent Plugin launcher package pair", () => {
  it("enforces the package's exact Node compatibility boundaries", () => {
    const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    expect(packageJson.engines.node).toBe("^20.19.0 || >=22.12.0");
    const cases = [
      ["20.18.9", false],
      ["20.19.0", true],
      ["21.7.3", false],
      ["22.11.0", false],
      ["22.12.0", true],
      ["23.0.0", true],
      ["not-a-version", false],
    ];
    for (const [version, expected] of cases) {
      expect(isSupportedNodeVersion(version), version).toBe(expected);
    }
  });

  it("ships one logical command with POSIX and Windows implementations", () => {
    expect(readFileSync(POSIX_LAUNCHER, "utf8")).toMatch(/^#!\/bin\/sh\n/);
    expect(readFileSync(WINDOWS_LAUNCHER, "utf8")).toMatch(/^@echo off\r?\n/);
    expect(readFileSync(WINDOWS_LAUNCHER, "utf8")).toContain("%APPDATA%\\nvm");
  });
});
