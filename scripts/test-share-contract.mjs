#!/usr/bin/env node

import { createHash } from "crypto";
import {
  chmodSync,
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { spawnSync } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readCentralDirectory } from "./mcpb-archive.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const CMAP_ORACLE_SOURCE = path.join(REPO_ROOT, "test/fixtures/eval/extraction/oracles/layout-unijis-vertical.pdf");
const CMAP_ORACLE_PROVENANCE = JSON.parse(readFileSync(
  path.join(REPO_ROOT, "test/fixtures/eval/extraction/oracles/layout-unijis-vertical.provenance.json"),
  "utf8",
));
const PROTECTED_DIRECT_DEPENDENCIES = {
  "@modelcontextprotocol/sdk": "1.30.0",
  "@napi-rs/canvas": "0.1.99",
  "pdf-lib": "1.17.1",
  "pdfjs-dist": "5.4.624",
};
const EXPECTED_SHARE_EXECUTABLES = new Set([
  "configure-cursor.sh",
  "install-transactional.sh",
  "install.command",
  "install.sh",
  "server/index.js",
  "smart-install.sh",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function expectFailure(command, args, cwd, pattern, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status === 0 || !pattern.test(output)) {
    throw new Error(`${command} ${args.join(" ")} did not fail closed as expected: ${output}`);
  }
  return result;
}

function walkFiles(root, relativeRoot = "") {
  const files = [];
  for (const entry of readdirSync(path.join(root, relativeRoot)).sort()) {
    const relativePath = path.posix.join(relativeRoot.split(path.sep).join(path.posix.sep), entry);
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) files.push(...walkFiles(root, relativePath));
    else if (stat.isFile()) files.push(relativePath);
    else throw new Error(`Unexpected non-file archive entry at ${relativePath}`);
  }
  return files;
}

function regularTreeFingerprint(root, relativeRoot = "") {
  const files = [];
  for (const entry of readdirSync(path.join(root, relativeRoot)).sort()) {
    const relativePath = path.posix.join(
      relativeRoot.split(path.sep).join(path.posix.sep),
      entry,
    );
    const filename = path.join(root, ...relativePath.split("/"));
    const stat = lstatSync(filename);
    if (stat.isDirectory()) {
      files.push(...regularTreeFingerprint(root, relativePath));
    } else if (stat.isFile() && stat.nlink === 1) {
      files.push({
        path: relativePath,
        executable: process.platform === "win32"
          ? null
          : (stat.mode & 0o111) !== 0,
        bytes: stat.size,
        sha256: sha256(readFileSync(filename)),
      });
    } else {
      throw new Error(
        `Reviewed share source contains a non-regular or multiply-linked entry: ${relativePath}`,
      );
    }
  }
  return files;
}

function populatePackageBuildRoot(buildRoot) {
  mkdirSync(buildRoot, { recursive: true });
  for (const filename of ["package-for-friend.js", "package.json", "package-lock.json"]) {
    copyFileSync(path.join(REPO_ROOT, filename), path.join(buildRoot, filename));
  }
  for (const directory of ["server", "dist-ui", "pdf-toolkit-mcp-share"]) {
    cpSync(path.join(REPO_ROOT, directory), path.join(buildRoot, directory), { recursive: true });
  }
}

function forceTreeModeProfile(root, {
  directoryMode,
  executableMode,
  regularMode,
}) {
  const visit = directory => {
    for (const entry of readdirSync(directory).sort()) {
      const filename = path.join(directory, entry);
      const stat = lstatSync(filename);
      if (stat.isDirectory()) {
        visit(filename);
        chmodSync(filename, directoryMode);
      } else if (stat.isFile() && stat.nlink === 1) {
        chmodSync(
          filename,
          (stat.mode & 0o111) !== 0 ? executableMode : regularMode,
        );
      } else {
        throw new Error(
          `Package build root contains a non-regular or multiply-linked entry: ${filename}`,
        );
      }
    }
  };
  visit(root);
  chmodSync(root, directoryMode);
}

function assertShareModeProfile(root, {
  directoryMode,
  executableMode,
  regularMode,
}) {
  const visit = (directory, relativeRoot = "") => {
    assertEqual(
      lstatSync(directory).mode & 0o777,
      directoryMode,
      `Reviewed source directory mode drifted for ${relativeRoot || "."}`,
    );
    for (const entry of readdirSync(directory).sort()) {
      const relativePath = path.posix.join(
        relativeRoot.split(path.sep).join(path.posix.sep),
        entry,
      );
      const filename = path.join(directory, entry);
      const stat = lstatSync(filename);
      if (stat.isDirectory()) {
        visit(filename, relativePath);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error(
          `Reviewed share source contains a non-regular or multiply-linked entry: ${relativePath}`,
        );
      }
      const expectedExecutable = EXPECTED_SHARE_EXECUTABLES.has(relativePath);
      assertEqual(
        (stat.mode & 0o111) !== 0,
        expectedExecutable,
        `Reviewed executable classification drifted for ${relativePath}`,
      );
      assertEqual(
        stat.mode & 0o777,
        expectedExecutable ? executableMode : regularMode,
        `Reviewed source mode drifted for ${relativePath}`,
      );
    }
  };
  visit(root);
}

function runPackager(buildRoot, invocationUmask) {
  if (process.platform === "win32") {
    return run(process.execPath, ["package-for-friend.js"], buildRoot);
  }
  const previousUmask = process.umask(invocationUmask);
  try {
    return run(process.execPath, ["package-for-friend.js"], buildRoot);
  } finally {
    process.umask(previousUmask);
  }
}

function assertCanonicalArchiveModes(bytes) {
  if (process.platform === "win32") return;
  const prefix = "pdf-toolkit-mcp-share/";
  const entries = readCentralDirectory(bytes);
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) {
      throw new Error(`Share ZIP contains an unexpected path: ${entry.path}`);
    }
    const relativePath = entry.path.slice(prefix.length);
    const expectedMode = EXPECTED_SHARE_EXECUTABLES.has(relativePath)
      ? 0o755
      : 0o644;
    assertEqual(entry.os, 3, `Share ZIP host metadata drifted for ${relativePath}`);
    assertEqual(
      entry.unixMode,
      0o100000 | expectedMode,
      `Share ZIP Unix mode drifted for ${relativePath}`,
    );
    assertEqual(
      entry.mode,
      expectedMode,
      `Share ZIP permission mode drifted for ${relativePath}`,
    );
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, received ${actual}`);
}

function expectThrow(operation, pattern, message) {
  try {
    operation();
  } catch (error) {
    if (pattern.test(error.message)) return;
    throw new Error(`${message}: unexpected error: ${error.message}`);
  }
  throw new Error(`${message}: operation unexpectedly succeeded`);
}

function writeExecutable(filename, contents) {
  writeFileSync(filename, contents);
  chmodSync(filename, 0o755);
}

function populateNodeOnlyInstallerPath(directory, cwd) {
  mkdirSync(directory, { recursive: true });
  for (const command of ["bash", "basename", "chmod", "cp", "dirname", "grep", "mkdir", "mktemp", "mv", "node", "rm"]) {
    const executable = run("sh", ["-c", `command -v ${command}`], cwd).trim();
    symlinkSync(executable, path.join(directory, command));
  }
  writeExecutable(path.join(directory, "npm"), "#!/bin/bash\nexit 0\n");
  const pythonProbe = spawnSync("/bin/sh", ["-c", "command -v python3"], {
    env: { ...process.env, PATH: directory },
    encoding: "utf8",
  });
  if (pythonProbe.status === 0) throw new Error("Node-only installer PATH unexpectedly exposes python3");
}

function assertNoInstallerTemps(parent, targetName) {
  const leftovers = readdirSync(parent).filter(name =>
    name.startsWith(`${targetName}.stage.`) || name.startsWith(`${targetName}.backup.`));
  assertEqual(JSON.stringify(leftovers), "[]", "Transactional installer left temporary directories");
}

function testTransactionalFailurePaths(sourcePackageRoot, tempRoot) {
  if (process.platform === "win32") return;
  const installer = path.join(sourcePackageRoot, "install-transactional.sh");
  const realMv = run("sh", ["-c", "command -v mv"], tempRoot).trim();

  const failureHome = path.join(tempRoot, "installer-failure-home");
  const failureTarget = path.join(failureHome, ".pdf-tools-mcp");
  const failureBin = path.join(failureHome, "bin");
  mkdirSync(failureTarget, { recursive: true });
  mkdirSync(failureBin, { recursive: true });
  writeFileSync(path.join(failureTarget, "working-install.txt"), "known-good-before-npm-failure\n");
  writeExecutable(path.join(failureBin, "npm"), "#!/bin/bash\nexit 42\n");
  const failureEnvironment = {
    ...process.env,
    HOME: failureHome,
    PATH: `${failureBin}:${process.env.PATH}`,
  };
  expectFailure("bash", [path.join(sourcePackageRoot, "smart-install.sh")], tempRoot, /existing installation was not changed/, {
    env: failureEnvironment,
  });
  expectFailure("bash", [path.join(sourcePackageRoot, "install.command")], tempRoot, /existing installation was not changed/, {
    env: failureEnvironment,
    input: "\n",
  });
  expectFailure("bash", [installer, sourcePackageRoot, failureTarget], tempRoot, /existing installation was not changed/, {
    env: failureEnvironment,
  });
  assertEqual(
    readFileSync(path.join(failureTarget, "working-install.txt"), "utf8"),
    "known-good-before-npm-failure\n",
    "npm failure damaged the working installation",
  );
  assertNoInstallerTemps(failureHome, ".pdf-tools-mcp");

  const rollbackHome = path.join(tempRoot, "installer-rollback-home");
  const rollbackTarget = path.join(rollbackHome, ".pdf-tools-mcp");
  const rollbackBin = path.join(rollbackHome, "bin");
  const mvState = path.join(rollbackHome, "mv-state");
  mkdirSync(rollbackTarget, { recursive: true });
  mkdirSync(rollbackBin, { recursive: true });
  writeFileSync(path.join(rollbackTarget, "working-install.txt"), "known-good-before-swap-failure\n");
  writeExecutable(path.join(rollbackBin, "npm"), "#!/bin/bash\nexit 0\n");
  writeExecutable(path.join(rollbackBin, "mv"), `#!/bin/bash
count=0
if [ -f "$MV_TEST_STATE" ]; then count=$(<"$MV_TEST_STATE"); fi
count=$((count + 1))
echo "$count" > "$MV_TEST_STATE"
if [ "$count" -eq 2 ]; then exit 73; fi
exec ${JSON.stringify(realMv)} "$@"
`);
  expectFailure("bash", [installer, sourcePackageRoot, rollbackTarget], tempRoot, /attempting rollback/, {
    env: {
      ...process.env,
      HOME: rollbackHome,
      PATH: `${rollbackBin}:${process.env.PATH}`,
      MV_TEST_STATE: mvState,
    },
  });
  assertEqual(readFileSync(mvState, "utf8").trim(), "3", "Swap-failure proof did not execute rollback move");
  assertEqual(
    readFileSync(path.join(rollbackTarget, "working-install.txt"), "utf8"),
    "known-good-before-swap-failure\n",
    "Swap failure did not restore the working installation",
  );
  assertNoInstallerTemps(rollbackHome, ".pdf-tools-mcp");

  const termHome = path.join(tempRoot, "installer-term-home");
  const termTarget = path.join(termHome, ".pdf-tools-mcp");
  const termBin = path.join(termHome, "bin");
  const termMvState = path.join(termHome, "mv-state");
  mkdirSync(termTarget, { recursive: true });
  mkdirSync(termBin, { recursive: true });
  writeFileSync(path.join(termTarget, "working-install.txt"), "known-good-before-term\n");
  writeExecutable(path.join(termBin, "npm"), "#!/bin/bash\nexit 0\n");
  writeExecutable(path.join(termBin, "mv"), `#!/bin/bash
count=0
if [ -f "$MV_TEST_STATE" ]; then count=$(<"$MV_TEST_STATE"); fi
count=$((count + 1))
echo "$count" > "$MV_TEST_STATE"
if [ "$count" -eq 1 ]; then
  ${JSON.stringify(realMv)} "$@"
  status=$?
  if [ "$status" -eq 0 ]; then kill -TERM "$PPID"; fi
  exit "$status"
fi
exec ${JSON.stringify(realMv)} "$@"
`);
  expectFailure("bash", [installer, sourcePackageRoot, termTarget], tempRoot, /Restoring the previous installation/, {
    env: {
      ...process.env,
      HOME: termHome,
      PATH: `${termBin}:${process.env.PATH}`,
      MV_TEST_STATE: termMvState,
    },
  });
  assertEqual(readFileSync(termMvState, "utf8").trim(), "2", "TERM proof did not execute rollback move");
  assertEqual(
    readFileSync(path.join(termTarget, "working-install.txt"), "utf8"),
    "known-good-before-term\n",
    "TERM after backup did not restore the working installation",
  );
  assertNoInstallerTemps(termHome, ".pdf-tools-mcp");
}

function assertConfiguredServer(configPath, expectedServerPath, expectedSentinel) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  assertEqual(config.mcpServers?.["pdf-tools"]?.command, "node", "Cursor command was not JSON encoded");
  assertEqual(
    config.mcpServers?.["pdf-tools"]?.args?.[0],
    expectedServerPath,
    "Cursor server path did not round-trip exactly through JSON",
  );
  if (expectedSentinel !== undefined) {
    assertEqual(config.sentinel, expectedSentinel, "Existing Cursor config data was not preserved");
  }
}

function testSuccessfulWrapperConfigs(sourcePackageRoot, tempRoot) {
  if (process.platform === "win32") return;
  const hostileHome = path.join(tempRoot, "home space'apostrophe\"double\\backslash");
  const hostileBin = path.join(hostileHome, "bin");
  const hostileConfig = path.join(hostileHome, ".cursor", "mcp.json");
  mkdirSync(path.dirname(hostileConfig), { recursive: true });
  populateNodeOnlyInstallerPath(hostileBin, tempRoot);
  writeFileSync(hostileConfig, `${JSON.stringify({ sentinel: "preserve-me", mcpServers: { existing: { command: "ok" } } }, null, 2)}\n`);
  const hostileEnvironment = {
    ...process.env,
    HOME: hostileHome,
    PATH: hostileBin,
  };
  run("bash", [path.join(sourcePackageRoot, "smart-install.sh")], tempRoot, {
    env: hostileEnvironment,
    input: "y\n",
  });
  assertConfiguredServer(
    hostileConfig,
    path.join(hostileHome, ".pdf-tools-mcp", "server", "index.js"),
    "preserve-me",
  );
  if (!existsSync(`${hostileConfig}.backup`)) throw new Error("Existing Cursor config backup was not created");

  const newHome = path.join(tempRoot, "new home 'apostrophe \"double\" \\backslash");
  const newBin = path.join(newHome, "bin");
  populateNodeOnlyInstallerPath(newBin, tempRoot);
  run("bash", [path.join(sourcePackageRoot, "install.command")], tempRoot, {
    env: { ...process.env, HOME: newHome, PATH: newBin },
    input: "\n",
  });
  assertConfiguredServer(
    path.join(newHome, ".cursor", "mcp.json"),
    path.join(newHome, ".pdf-tools-mcp", "server", "index.js"),
  );

  const hostileManualSource = path.join(tempRoot, "manual source 'apostrophe \"double\" \\backslash");
  const manualBin = path.join(tempRoot, "manual-node-only-bin");
  cpSync(sourcePackageRoot, hostileManualSource, { recursive: true });
  populateNodeOnlyInstallerPath(manualBin, tempRoot);
  const manualOutput = run("bash", [path.join(hostileManualSource, "install.sh")], tempRoot, {
    env: { ...process.env, HOME: newHome, PATH: manualBin },
  });
  const separator = "===============================================";
  const outputLines = manualOutput.split(/\r?\n/);
  const firstSeparator = outputLines.indexOf(separator);
  const secondSeparator = outputLines.indexOf(separator, firstSeparator + 1);
  if (firstSeparator < 0 || secondSeparator < 0) throw new Error("Manual installer did not emit a JSON block");
  const printedConfig = JSON.parse(outputLines.slice(firstSeparator + 1, secondSeparator).join("\n"));
  assertEqual(
    printedConfig.mcpServers?.["pdf-tools"]?.args?.[0],
    path.join(realpathSync(hostileManualSource), "server", "index.js"),
    "Manual installer path did not round-trip exactly through JSON",
  );
}

async function expectMcpError(operation, code) {
  try {
    await operation();
  } catch (error) {
    if (error?.code === code) return;
    throw new Error(`Expected MCP error ${code}, received ${error?.code}: ${error?.message}`);
  }
  throw new Error(`Expected MCP error ${code}, but operation succeeded`);
}

async function main() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pdf-tools-share-contract-"));
  const buildRoot = path.join(tempRoot, "package-build");
  const restrictiveBuildRoot = path.join(tempRoot, "package-build-umask-077");
  const extractedRoot = path.join(tempRoot, "extracted");
  const archivePath = path.join(buildRoot, "pdf-toolkit-mcp.zip");
  const restrictiveArchivePath = path.join(restrictiveBuildRoot, "pdf-toolkit-mcp.zip");
  const sourcePackageRoot = path.join(extractedRoot, "pdf-toolkit-mcp-share");
  const installHome = path.join(tempRoot, "real-install-home");
  let packageRoot = sourcePackageRoot;
  const specialFilename = process.platform === "win32" ? "quarterly #1 draft.pdf" : "quarterly #1 ? draft.pdf";
  const fixturePath = path.join(tempRoot, specialFilename);
  const cMapOraclePath = path.join(tempRoot, "layout-unijis-vertical.pdf");
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  let transport;

  try {
    populatePackageBuildRoot(buildRoot);
    if (process.platform !== "win32") {
      populatePackageBuildRoot(restrictiveBuildRoot);
      forceTreeModeProfile(buildRoot, {
        directoryMode: 0o755,
        executableMode: 0o755,
        regularMode: 0o644,
      });
      forceTreeModeProfile(restrictiveBuildRoot, {
        directoryMode: 0o700,
        executableMode: 0o700,
        regularMode: 0o600,
      });
      assertShareModeProfile(path.join(buildRoot, "pdf-toolkit-mcp-share"), {
        directoryMode: 0o755,
        executableMode: 0o755,
        regularMode: 0o644,
      });
      assertShareModeProfile(
        path.join(restrictiveBuildRoot, "pdf-toolkit-mcp-share"),
        {
          directoryMode: 0o700,
          executableMode: 0o700,
          regularMode: 0o600,
        },
      );
    }

    const shareTreeBeforeBuild = JSON.stringify(
      regularTreeFingerprint(path.join(buildRoot, "pdf-toolkit-mcp-share")),
    );
    runPackager(buildRoot, 0o022);
    assertEqual(
      JSON.stringify(regularTreeFingerprint(path.join(buildRoot, "pdf-toolkit-mcp-share"))),
      shareTreeBeforeBuild,
      "Share package generation mutated its reviewed source tree",
    );
    if (process.platform !== "win32") {
      assertShareModeProfile(path.join(buildRoot, "pdf-toolkit-mcp-share"), {
        directoryMode: 0o755,
        executableMode: 0o755,
        regularMode: 0o644,
      });
    }
    const firstArchiveBytes = readFileSync(archivePath);
    assertCanonicalArchiveModes(firstArchiveBytes);
    if (process.platform !== "win32") {
      const restrictiveShareTreeBeforeBuild = JSON.stringify(
        regularTreeFingerprint(path.join(restrictiveBuildRoot, "pdf-toolkit-mcp-share")),
      );
      runPackager(restrictiveBuildRoot, 0o077);
      assertEqual(
        JSON.stringify(regularTreeFingerprint(
          path.join(restrictiveBuildRoot, "pdf-toolkit-mcp-share"),
        )),
        restrictiveShareTreeBeforeBuild,
        "Restrictive-umask package generation mutated its reviewed source tree",
      );
      assertShareModeProfile(
        path.join(restrictiveBuildRoot, "pdf-toolkit-mcp-share"),
        {
          directoryMode: 0o700,
          executableMode: 0o700,
          regularMode: 0o600,
        },
      );
      const restrictiveArchiveBytes = readFileSync(restrictiveArchivePath);
      assertCanonicalArchiveModes(restrictiveArchiveBytes);
      assertEqual(
        sha256(restrictiveArchiveBytes),
        sha256(firstArchiveBytes),
        "Share ZIP differs between explicit 0644/0755 and 0600/0700 source trees",
      );
    }
    runPackager(buildRoot, 0o022);
    assertEqual(
      JSON.stringify(regularTreeFingerprint(path.join(buildRoot, "pdf-toolkit-mcp-share"))),
      shareTreeBeforeBuild,
      "Repeated share package generation mutated its reviewed source tree",
    );
    if (process.platform !== "win32") {
      assertShareModeProfile(path.join(buildRoot, "pdf-toolkit-mcp-share"), {
        directoryMode: 0o755,
        executableMode: 0o755,
        regularMode: 0o644,
      });
    }
    const secondArchiveBytes = readFileSync(archivePath);
    const archiveSha256 = sha256(secondArchiveBytes);
    assertEqual(sha256(firstArchiveBytes), archiveSha256, "Share ZIP is not byte-reproducible");

    const packager = await import(`${pathToFileURL(path.join(buildRoot, "package-for-friend.js")).href}?proof=1`);
    let forcedOutputFailure = false;
    try {
      await packager.createPackage({ zipCommand: path.join(tempRoot, "missing-zip-command") });
    } catch {
      forcedOutputFailure = true;
    }
    if (!forcedOutputFailure) throw new Error("Forced archive-output failure unexpectedly succeeded");
    assertEqual(sha256(readFileSync(archivePath)), archiveSha256, "Archive-output failure replaced the good ZIP");
    const candidateLeftovers = readdirSync(buildRoot).filter(name => name.startsWith(".pdf-toolkit-mcp.zip.candidate-"));
    assertEqual(JSON.stringify(candidateLeftovers), "[]", "Failed archive build left a candidate directory");

    const disposableShareLockPath = path.join(buildRoot, "pdf-toolkit-mcp-share", "package-lock.json");
    const originalShareLockText = readFileSync(disposableShareLockPath, "utf8");
    const directTamper = JSON.parse(originalShareLockText);
    directTamper.packages["node_modules/@napi-rs/canvas"].version = "0.1.100";
    writeFileSync(disposableShareLockPath, `${JSON.stringify(directTamper, null, 2)}\n`);
    expectFailure(
      process.execPath,
      ["package-for-friend.js"],
      buildRoot,
      /record drifted.*node_modules\/@napi-rs\/canvas/,
    );
    assertEqual(sha256(readFileSync(archivePath)), archiveSha256, "Direct lock drift overwrote the good ZIP");

    const transitiveTamper = JSON.parse(originalShareLockText);
    transitiveTamper.packages["node_modules/accepts"].integrity = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    writeFileSync(disposableShareLockPath, `${JSON.stringify(transitiveTamper, null, 2)}\n`);
    expectFailure(
      process.execPath,
      ["package-for-friend.js"],
      buildRoot,
      /record drifted.*node_modules\/accepts/,
    );
    assertEqual(sha256(readFileSync(archivePath)), archiveSha256, "Transitive lock drift overwrote the good ZIP");

    const dependencyEdgeTamper = JSON.parse(originalShareLockText);
    dependencyEdgeTamper.packages["node_modules/accepts"].dependencies.negotiator = "9.9.9";
    writeFileSync(disposableShareLockPath, `${JSON.stringify(dependencyEdgeTamper, null, 2)}\n`);
    expectFailure(
      process.execPath,
      ["package-for-friend.js"],
      buildRoot,
      /record drifted.*node_modules\/accepts/,
    );
    assertEqual(sha256(readFileSync(archivePath)), archiveSha256, "Dependency-edge drift overwrote the good ZIP");

    const platformMetadataTamper = JSON.parse(originalShareLockText);
    platformMetadataTamper.packages["node_modules/@napi-rs/canvas-win32-x64-msvc"].os = ["darwin"];
    writeFileSync(disposableShareLockPath, `${JSON.stringify(platformMetadataTamper, null, 2)}\n`);
    expectFailure(
      process.execPath,
      ["package-for-friend.js"],
      buildRoot,
      /record drifted.*canvas-win32-x64-msvc/,
    );
    assertEqual(sha256(readFileSync(archivePath)), archiveSha256, "Platform-metadata drift overwrote the good ZIP");

    const optionalOmission = JSON.parse(originalShareLockText);
    delete optionalOmission.packages["node_modules/@napi-rs/canvas-win32-x64-msvc"];
    writeFileSync(disposableShareLockPath, `${JSON.stringify(optionalOmission, null, 2)}\n`);
    expectFailure(
      process.execPath,
      ["package-for-friend.js"],
      buildRoot,
      /package-path coverage.*canvas-win32-x64-msvc/,
    );
    assertEqual(sha256(readFileSync(archivePath)), archiveSha256, "Optional-package omission overwrote the good ZIP");
    writeFileSync(disposableShareLockPath, originalShareLockText);

    run("unzip", ["-q", archivePath, "-d", extractedRoot], buildRoot);
    copyFileSync(path.join(REPO_ROOT, "example-fw9.pdf"), fixturePath);
    copyFileSync(CMAP_ORACLE_SOURCE, cMapOraclePath);

    const provenance = JSON.parse(readFileSync(path.join(sourcePackageRoot, "SHARE-PROVENANCE.json"), "utf8"));
    assertEqual(provenance.schema_version, "1.1", "Unexpected share provenance schema");
    assertEqual(provenance.dependency_lock.lockfile_version, 3, "Unexpected npm lockfile version");
    const extractedFiles = walkFiles(sourcePackageRoot);
    const manifestedFiles = Object.keys(provenance.files).sort();
    const expectedFiles = [...manifestedFiles, "SHARE-PROVENANCE.json"].sort();
    assertEqual(JSON.stringify(extractedFiles), JSON.stringify(expectedFiles), "Archive file allowlist drifted");
    for (const relativePath of manifestedFiles) {
      const digest = sha256(readFileSync(path.join(sourcePackageRoot, ...relativePath.split("/"))));
      assertEqual(digest, provenance.files[relativePath], `Provenance mismatch for ${relativePath}`);
    }
    if (process.platform !== "win32") {
      for (const installer of [
        "configure-cursor.sh",
        "install-transactional.sh",
        "install.command",
        "install.sh",
        "smart-install.sh",
      ]) {
        if ((statSync(path.join(sourcePackageRoot, installer)).mode & 0o111) === 0) {
          throw new Error(`Archive lost executable mode for ${installer}`);
        }
      }
    }

    const lockBytesBeforeInstall = readFileSync(path.join(sourcePackageRoot, "package-lock.json"));
    const sharePackage = JSON.parse(readFileSync(path.join(sourcePackageRoot, "package.json"), "utf8"));
    const shareLock = JSON.parse(lockBytesBeforeInstall.toString("utf8"));
    const rootLock = JSON.parse(readFileSync(path.join(buildRoot, "package-lock.json"), "utf8"));
    assertEqual(sha256(lockBytesBeforeInstall), provenance.dependency_lock.sha256, "Provenance does not bind the lock");
    const sharePackagePaths = Object.keys(shareLock.packages).filter(Boolean).sort();
    const rootProductionPackagePaths = Object.entries(rootLock.packages)
      .filter(([packagePath, lockedPackage]) => packagePath && lockedPackage.dev !== true)
      .map(([packagePath]) => packagePath)
      .sort();
    assertEqual(
      JSON.stringify(sharePackagePaths),
      JSON.stringify(rootProductionPackagePaths),
      "Full lock package-path coverage differs",
    );
    for (const [packagePath, lockedPackage] of Object.entries(shareLock.packages)) {
      if (packagePath === "") continue;
      assertEqual(
        JSON.stringify(lockedPackage),
        JSON.stringify(rootLock.packages[packagePath]),
        `Complete lock-record parity failed for ${packagePath}`,
      );
    }

    const sbomBytes = readFileSync(path.join(sourcePackageRoot, "SBOM.cdx.json"));
    const sbom = JSON.parse(sbomBytes.toString("utf8"));
    assertEqual(sha256(sbomBytes), provenance.sbom.sha256, "Provenance does not bind the SBOM");
    assertEqual(provenance.sbom.format, "CycloneDX", "Unexpected SBOM format claim");
    assertEqual(provenance.sbom.spec_version, "1.6", "Unexpected SBOM version claim");
    if (!/not external schema validation/.test(provenance.sbom.validation)) {
      throw new Error("SBOM evidence overstates its validation level");
    }
    packager.validateCycloneDxSbom(sbom, shareLock, sharePackage);
    assertEqual(sbom.components.length, Object.keys(shareLock.packages).length - 1, "SBOM component coverage drifted");
    assertEqual(sbom.dependencies.length, Object.keys(shareLock.packages).length, "SBOM dependency coverage drifted");
    const missingComponentSbom = structuredClone(sbom);
    missingComponentSbom.components.pop();
    expectThrow(
      () => packager.validateCycloneDxSbom(missingComponentSbom, shareLock, sharePackage),
      /component coverage mismatch/,
      "SBOM component omission was not rejected",
    );
    const missingEdgeSbom = structuredClone(sbom);
    missingEdgeSbom.dependencies[0].dependsOn.pop();
    expectThrow(
      () => packager.validateCycloneDxSbom(missingEdgeSbom, shareLock, sharePackage),
      /dependency edges do not exactly cover root/,
      "SBOM dependency-edge omission was not rejected",
    );

    for (const relativePath of [
      "server/bounded-pdf-file.js",
      "server/helpers.js",
      "server/index.js",
      "server/layout-extraction.js",
      "server/type3-cm-reference.js",
      "server/markdown-conversion.js",
      "server/markdown-output-transaction.js",
      "server/output-schemas.js",
      "server/pdf-comparison.js",
      "server/pdf-observations.js",
      "server/pdf-lib-rss-monitor.js",
      "server/pdf-lib-subprocess.js",
      "server/pdf-lib-worker.js",
      "server/pdfjs-subprocess.js",
      "server/pdfjs-worker.js",
      "server/resource-uri.js",
      "server/stderr-suppression.js",
      "dist-ui/index.html",
    ]) {
      assertEqual(
        sha256(readFileSync(path.join(sourcePackageRoot, ...relativePath.split("/")))),
        sha256(readFileSync(path.join(REPO_ROOT, relativePath))),
        `Archive/source parity failed for ${relativePath}`,
      );
    }

    assertEqual(sharePackage.dependencies["pdfjs-dist"], "5.4.624", "pdfjs-dist manifest pin changed");
    for (const [dependencyName, expectedVersion] of Object.entries(PROTECTED_DIRECT_DEPENDENCIES)) {
      assertEqual(
        shareLock.packages[`node_modules/${dependencyName}`]?.version,
        expectedVersion,
        `Protected locked dependency ${dependencyName} changed`,
      );
    }

    testTransactionalFailurePaths(sourcePackageRoot, tempRoot);
    testSuccessfulWrapperConfigs(sourcePackageRoot, tempRoot);
    if (process.platform === "win32") {
      run(npmCommand, [
        "ci", "--omit=dev", "--engine-strict", "--no-audit", "--no-fund",
        "--cache", path.join(tempRoot, "npm-cache"),
      ], sourcePackageRoot);
    } else {
      mkdirSync(installHome, { recursive: true });
      packageRoot = path.join(installHome, ".pdf-tools-mcp");
      run("bash", [
        path.join(sourcePackageRoot, "install-transactional.sh"),
        sourcePackageRoot,
        packageRoot,
      ], tempRoot, {
        env: { ...process.env, HOME: installHome, npm_config_cache: path.join(tempRoot, "npm-cache") },
      });
      assertNoInstallerTemps(installHome, ".pdf-tools-mcp");
    }
    assertEqual(
      sha256(readFileSync(path.join(packageRoot, "package-lock.json"))),
      sha256(lockBytesBeforeInstall),
      "Transactional npm ci mutated the shipped lockfile",
    );

    const installedGraph = JSON.parse(run(npmCommand, ["ls", "--omit=dev", "--json"], packageRoot));
    for (const [dependencyName, expectedVersion] of Object.entries(PROTECTED_DIRECT_DEPENDENCIES)) {
      assertEqual(
        installedGraph.dependencies?.[dependencyName]?.version,
        expectedVersion,
        `Installed dependency ${dependencyName} drifted from the reviewed lock`,
      );
    }

    const client = new Client({ name: "pdf-tools-isolated-share-contract", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(packageRoot, "server", "index.js")],
      cwd: packageRoot,
      env: { ALLOWED_DIRECTORIES: tempRoot },
      stderr: "ignore",
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    const { prompts } = await client.listPrompts();
    const { resources } = await client.listResources();
    if (tools.length !== 41 || prompts.length !== 14 || resources.length !== 1) {
      throw new Error(
        `Unexpected discovery counts: ${tools.length} tools, ${prompts.length} prompts, ${resources.length} resources`,
      );
    }
    await expectMcpError(() => client.listTools({ cursor: "never-issued" }), -32602);

    const byteResult = await client.callTool({
      name: "read_pdf_bytes",
      arguments: { pdf_path: fixturePath, offset: 0, byteCount: 8 },
    });
    if (byteResult.isError || byteResult.structuredContent?.byteCount !== 8) {
      throw new Error("Generic-client read_pdf_bytes compatibility check failed");
    }
    for (const asset of CMAP_ORACLE_PROVENANCE.runtime_assets.files) {
      const assetPath = path.join(packageRoot, ...asset.path.split("/"));
      if (!existsSync(assetPath) || !statSync(assetPath).isFile()) {
        throw new Error(`Share runtime is missing provenance-bound PDF.js asset ${asset.path}`);
      }
      const bytes = readFileSync(assetPath);
      if (bytes.length !== asset.size_bytes || sha256(bytes) !== asset.sha256) {
        throw new Error(`Share runtime PDF.js asset does not match oracle provenance: ${asset.path}`);
      }
    }
    const layout = await client.callTool({
      name: "read_pdf_layout",
      arguments: { pdf_path: fixturePath, max_output_characters: 200000 },
    });
    if (layout.isError
      || layout.structuredContent?.ir?.version !== "1.4.0"
      || layout.structuredContent?.source?.size_bytes !== statSync(fixturePath).size) {
      throw new Error("Share read_pdf_layout contract smoke failed");
    }
    const markdown = await client.callTool({
      name: "convert_pdf_to_markdown",
      arguments: { pdf_path: fixturePath, max_markdown_bytes: 200000 },
    });
    if (markdown.isError
      || markdown.structuredContent?.renderer?.version !== "1.11.0"
      || markdown.structuredContent?.markdown_bytes !== Buffer.byteLength(markdown.structuredContent?.markdown || "", "utf8")
      || markdown.structuredContent?.markdown_sha256 !== sha256(Buffer.from(markdown.structuredContent?.markdown || "", "utf8"))) {
      throw new Error("Share convert_pdf_to_markdown contract smoke failed");
    }
    const cMapLayout = await client.callTool({
      name: "read_pdf_layout",
      arguments: { pdf_path: cMapOraclePath, max_output_characters: 200000 },
    });
    const cMapItem = cMapLayout.structuredContent?.pages?.[0]?.raw_items?.[0];
    if (cMapLayout.isError
      || cMapLayout.structuredContent?.source?.sha256 !== CMAP_ORACLE_PROVENANCE.fixture.sha256
      || cMapLayout.structuredContent?.source?.size_bytes !== CMAP_ORACLE_PROVENANCE.fixture.size_bytes
      || cMapLayout.structuredContent?.pages?.[0]?.flow_text !== "日本語"
      || cMapItem?.font?.vertical !== true
      || cMapItem?.raw_height !== 72
      || cMapItem?.geometry_provenance?.advance_source !== "item_height"
      || cMapItem?.bbox?.height !== 72) {
      throw new Error("Share read_pdf_layout named-CMap vertical oracle failed");
    }
    const uriResult = await client.callTool({ name: "get_pdf_resource_uri", arguments: { pdf_path: fixturePath } });
    const uri = uriResult.structuredContent?.uri;
    if (!uri || uri.includes(" ") || uri.includes("#") || uri.includes("?")) {
      throw new Error(`Share package returned a non-canonical resource URI: ${uri}`);
    }
    const resource = await client.readResource({ uri });
    if (Buffer.from(resource.contents?.[0]?.blob || "", "base64").subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new Error("Share package dynamic resource read failed");
    }
    const render = await client.callTool({
      name: "render_pdf_page",
      arguments: { pdf_path: fixturePath, page: 1, max_dimension_px: 800 },
    });
    const image = render.content?.find(item => item.type === "image" && item.mimeType === "image/png");
    if (render.isError || !image || Buffer.from(image.data, "base64").subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error("Share package native render_pdf_page did not return a valid PNG");
    }

    await client.close();
    console.log(
      `Reproducible transactional share contract passed on ${process.platform}/${process.arch}: ` +
        `${tools.length} tools, ${prompts.length} prompts, ${sbom.components.length} SBOM components, ` +
        `native raster image, SHA-256 ${archiveSha256}.`,
    );
  } finally {
    await transport?.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`Isolated share contract failed: ${error.message}`);
  process.exitCode = 1;
});
