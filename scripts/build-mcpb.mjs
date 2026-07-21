#!/usr/bin/env node

import { createHash } from "crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT = path.join(REPO_ROOT, "pdf-toolkit-mcp.mcpb");

const NATIVE_TARGETS = [
  { packageName: "@napi-rs/canvas-darwin-arm64", binary: "skia.darwin-arm64.node" },
  { packageName: "@napi-rs/canvas-darwin-x64", binary: "skia.darwin-x64.node" },
  { packageName: "@napi-rs/canvas-linux-x64-gnu", binary: "skia.linux-x64-gnu.node" },
  { packageName: "@napi-rs/canvas-win32-arm64-msvc", binary: "skia.win32-arm64-msvc.node" },
  { packageName: "@napi-rs/canvas-win32-x64-msvc", binary: "skia.win32-x64-msvc.node" },
];

function run(command, args, { cwd = REPO_ROOT, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? `\n${result.stderr || result.stdout}` : "";
    throw new Error(`${command} exited with status ${result.status}${detail}`);
  }
  return result.stdout;
}

function copyRuntimeSource(stagingDir) {
  for (const directory of ["server", "dist-ui"]) {
    const source = path.join(REPO_ROOT, directory);
    if (!existsSync(source)) throw new Error(`Required build input is missing: ${source}`);
    cpSync(source, path.join(stagingDir, directory), { recursive: true });
  }

  for (const filename of ["icon.png", "LICENSE", "README.md", "package-lock.json"]) {
    copyFileSync(path.join(REPO_ROOT, filename), path.join(stagingDir, filename));
  }
  const packageJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const runtimePackageJson = {
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
    type: packageJson.type,
    main: packageJson.main,
    license: packageJson.license,
    dependencies: packageJson.dependencies,
  };
  writeFileSync(
    path.join(stagingDir, "package.json"),
    `${JSON.stringify(runtimePackageJson, null, 2)}\n`,
  );
  copyFileSync(path.join(REPO_ROOT, "manifest.mcpb.json"), path.join(stagingDir, "manifest.json"));
}

function lockedNativePackages() {
  const lock = JSON.parse(readFileSync(path.join(REPO_ROOT, "package-lock.json"), "utf8"));
  const canvas = lock.packages?.["node_modules/@napi-rs/canvas"];
  if (!canvas?.version || !canvas.optionalDependencies) {
    throw new Error("package-lock.json does not contain the locked @napi-rs/canvas package");
  }

  return NATIVE_TARGETS.map(target => {
    const entry = lock.packages?.[`node_modules/${target.packageName}`];
    const expectedVersion = canvas.optionalDependencies[target.packageName];
    if (!entry?.version || !entry.resolved || !entry.integrity || !expectedVersion) {
      throw new Error(`package-lock.json is missing complete metadata for ${target.packageName}`);
    }
    if (entry.version !== expectedVersion) {
      throw new Error(`${target.packageName} lock mismatch: ${entry.version} != ${expectedVersion}`);
    }
    return { ...target, ...entry };
  });
}

function removeHostSelectedNativePackages(stagingDir) {
  const napiScope = path.join(stagingDir, "node_modules", "@napi-rs");
  if (!existsSync(napiScope)) return;
  for (const entry of readdirSync(napiScope)) {
    if (entry.startsWith("canvas-")) {
      rmSync(path.join(napiScope, entry), { recursive: true, force: true });
    }
  }
}

function installLockedNativePackages(stagingDir, downloadDir) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const packages = lockedNativePackages();

  for (const target of packages) {
    const output = run(
      npmCommand,
      ["pack", `${target.packageName}@${target.version}`, "--json", "--pack-destination", downloadDir],
      { capture: true },
    );
    const [packed] = JSON.parse(output);
    if (!packed?.filename || packed.integrity !== target.integrity) {
      throw new Error(`Registry tarball integrity did not match package-lock.json for ${target.packageName}`);
    }

    const destination = path.join(stagingDir, "node_modules", ...target.packageName.split("/"));
    mkdirSync(destination, { recursive: true });
    run("tar", [
      "-xzf",
      path.join(downloadDir, packed.filename),
      "--strip-components=1",
      "-C",
      destination,
    ]);
  }

  return packages;
}

function verifyNativeFiles(rootDir, packages) {
  return packages.map(target => {
    const relativePath = path.join("node_modules", ...target.packageName.split("/"), target.binary);
    const absolutePath = path.join(rootDir, relativePath);
    if (!existsSync(absolutePath) || statSync(absolutePath).size === 0) {
      throw new Error(`Required native binding is missing or empty: ${relativePath}`);
    }
    return relativePath.split(path.sep).join("/");
  });
}

function verifyArchive(outputPath, expectedPaths) {
  const listing = run("unzip", ["-Z1", outputPath], { capture: true })
    .split(/\r?\n/)
    .filter(Boolean);
  const archived = new Set(listing);

  for (const required of ["manifest.json", "server/index.js", "dist-ui/index.html", ...expectedPaths]) {
    if (!archived.has(required)) throw new Error(`Packed MCPB is missing required file: ${required}`);
  }
  return listing.length;
}

function sha256(filename) {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

async function main() {
  const outputPath = path.resolve(process.argv[2] || DEFAULT_OUTPUT);
  const stagingDir = mkdtempSync(path.join(tmpdir(), "pdf-tools-mcpb-"));
  const downloadDir = path.join(stagingDir, ".native-packages");
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const mcpbCommand = path.join(
    REPO_ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "mcpb.cmd" : "mcpb",
  );

  try {
    run(npmCommand, ["run", "build:ui"]);
    copyRuntimeSource(stagingDir);
    run(
      npmCommand,
      ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: stagingDir },
    );

    removeHostSelectedNativePackages(stagingDir);
    mkdirSync(downloadDir, { recursive: true });
    const packages = installLockedNativePackages(stagingDir, downloadDir);
    rmSync(downloadDir, { recursive: true, force: true });
    const nativePaths = verifyNativeFiles(stagingDir, packages);

    mkdirSync(path.dirname(outputPath), { recursive: true });
    run(mcpbCommand, ["pack", stagingDir, outputPath]);
    const fileCount = verifyArchive(outputPath, nativePaths);

    console.log("\nVerified native bindings:");
    for (const nativePath of nativePaths) console.log(`- ${nativePath}`);
    console.log(`\nArtifact: ${outputPath}`);
    console.log(`Files: ${fileCount}`);
    console.log(`Bytes: ${statSync(outputPath).size}`);
    console.log(`SHA-256: ${sha256(outputPath)}`);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`MCPB build failed: ${error.message}`);
  process.exitCode = 1;
});
