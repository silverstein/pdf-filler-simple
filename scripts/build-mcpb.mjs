#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { verifyInstalledBuildToolchain } from "./build-toolchain.mjs";
import {
  buildExpectedFileManifest,
  createCanonicalZip,
  sha256Bytes,
  verifyCanonicalZip,
  writeCanonicalBytesAtomic,
} from "./mcpb-archive.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT = path.join(REPO_ROOT, "pdf-toolkit-mcp.mcpb");
const MCPB_VERSION = "2.1.2";
const FFLATE_VERSION = "0.8.3";
const PROTECTED_PDFJS_VERSION = "5.4.624";
const SERVER_FILES = [
  "helpers.js",
  "index.js",
  "output-schemas.js",
  "resource-uri.js",
  "stderr-suppression.js",
];
const FIRST_PARTY_TEXT_FILES = [
  ...SERVER_FILES.map(filename => `server/${filename}`),
  "dist-ui/index.html",
  "LICENSE",
  "README.md",
  "manifest.mcpb.json",
];
const NATIVE_TARGETS = [
  { packageName: "@napi-rs/canvas-darwin-arm64", binary: "skia.darwin-arm64.node" },
  { packageName: "@napi-rs/canvas-darwin-x64", binary: "skia.darwin-x64.node" },
  { packageName: "@napi-rs/canvas-linux-x64-gnu", binary: "skia.linux-x64-gnu.node" },
  { packageName: "@napi-rs/canvas-win32-arm64-msvc", binary: "skia.win32-arm64-msvc.node" },
  { packageName: "@napi-rs/canvas-win32-x64-msvc", binary: "skia.win32-x64-msvc.node" },
];
const PDFJS_EXCLUDED_DIRECTORIES = [
  "build",
  "web",
  "types",
  "image_decoders",
  "cmaps",
  "wasm",
];
const FORBIDDEN_ARCHIVE_PREFIXES = [
  ...PDFJS_EXCLUDED_DIRECTORIES.map(name => `node_modules/pdfjs-dist/${name}/`),
  "node_modules/.vite/",
  "node_modules/.bin/",
  "node_modules/vite/",
  "node_modules/vite-plugin-singlefile/",
  "node_modules/vitest/",
  "node_modules/@vitest/",
  "node_modules/@modelcontextprotocol/ext-apps/",
  "node_modules/@esbuild/",
  "node_modules/@rollup/",
  "node_modules/rollup/",
  "node_modules/esbuild/",
  "test/",
  "scripts/",
  "docs/",
  ".git/",
  ".beads/",
];
const FORBIDDEN_ARCHIVE_FILES = new Set(["package-lock.json", "node_modules/.package-lock.json"]);
const DEVELOPMENT_FILE_SUFFIXES = [".map", ".d.ts", ".d.mts", ".d.cts", ".tsbuildinfo"];

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

export function assertRegularFirstPartyFile(rootDir, relativePath) {
  const absolutePath = path.join(rootDir, ...relativePath.split("/"));
  const metadata = lstatSync(absolutePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`First-party build input must be a regular file, not a link or special entry: ${relativePath}`);
  }
  return absolutePath;
}

export function scanFirstPartyInputs(rootDir = REPO_ROOT) {
  const inputs = [
    ...FIRST_PARTY_TEXT_FILES,
    "icon.png",
    "package.json",
    "package-lock.json",
  ];
  const secretFilename = /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|ecdsa|ed25519)|[^/]+\.(?:key|p12|pfx|pem))$/i;
  const secretContent = [
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"],
    [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
    [/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/, "Slack token"],
    [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "GitHub token"],
    [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
    [/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/, "API secret key"],
  ];
  for (const relativePath of inputs) {
    const absolutePath = assertRegularFirstPartyFile(rootDir, relativePath);
    if (secretFilename.test(relativePath)) throw new Error(`Secret-like first-party filename: ${relativePath}`);
    if (relativePath === "icon.png") continue;
    const content = readFileSync(absolutePath, "utf8");
    for (const [pattern, kind] of secretContent) {
      if (pattern.test(content)) throw new Error(`Possible ${kind} in first-party build input: ${relativePath}`);
    }
  }
}

function copyRegularFile(sourceRelativePath, destinationRelativePath, stagingDir) {
  const source = assertRegularFirstPartyFile(REPO_ROOT, sourceRelativePath);
  const destination = path.join(stagingDir, ...destinationRelativePath.split("/"));
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function copyRuntimeSource(stagingDir) {
  scanFirstPartyInputs();
  for (const filename of SERVER_FILES) copyRegularFile(`server/${filename}`, `server/${filename}`, stagingDir);
  copyRegularFile("dist-ui/index.html", "dist-ui/index.html", stagingDir);
  for (const filename of ["icon.png", "LICENSE", "README.md", "package-lock.json"]) {
    copyRegularFile(filename, filename, stagingDir);
  }
  const packageJson = JSON.parse(readFileSync(assertRegularFirstPartyFile(REPO_ROOT, "package.json"), "utf8"));
  const runtimePackageJson = {
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
    type: packageJson.type,
    main: packageJson.main,
    license: packageJson.license,
    dependencies: packageJson.dependencies,
  };
  writeFileSync(path.join(stagingDir, "package.json"), `${JSON.stringify(runtimePackageJson, null, 2)}\n`);
  copyRegularFile("manifest.mcpb.json", "manifest.json", stagingDir);
}

function verifyLockedTooling() {
  const lock = JSON.parse(readFileSync(path.join(REPO_ROOT, "package-lock.json"), "utf8"));
  const installedMcpb = JSON.parse(readFileSync(path.join(REPO_ROOT, "node_modules/@anthropic-ai/mcpb/package.json"), "utf8"));
  const installedFflate = JSON.parse(readFileSync(path.join(REPO_ROOT, "node_modules/fflate/package.json"), "utf8"));
  if (lock.packages?.["node_modules/@anthropic-ai/mcpb"]?.version !== MCPB_VERSION || installedMcpb.version !== MCPB_VERSION) {
    throw new Error(`Canonical build requires locked and installed @anthropic-ai/mcpb@${MCPB_VERSION}`);
  }
  if (
    lock.packages?.["node_modules/fflate"]?.version !== FFLATE_VERSION ||
    installedFflate.version !== FFLATE_VERSION ||
    installedMcpb.dependencies?.fflate !== "^0.8.2"
  ) {
    throw new Error(`Canonical build requires MCPB's locked and installed fflate@${FFLATE_VERSION}`);
  }
  if (lock.packages?.[""]?.dependencies?.["pdfjs-dist"] !== PROTECTED_PDFJS_VERSION) {
    throw new Error(`pdfjs-dist must remain exactly ${PROTECTED_PDFJS_VERSION}`);
  }
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
    if (entry.startsWith("canvas-")) rmSync(path.join(napiScope, entry), { recursive: true, force: true });
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
    run("tar", ["-xzf", path.join(downloadDir, packed.filename), "--strip-components=1", "-C", destination]);
  }
  return packages;
}

export function trimStagedProductionGraph(stagingDir) {
  const pdfjsDir = path.join(stagingDir, "node_modules", "pdfjs-dist");
  for (const directory of PDFJS_EXCLUDED_DIRECTORIES) {
    rmSync(path.join(pdfjsDir, directory), { recursive: true, force: true });
  }
  rmSync(path.join(stagingDir, "package-lock.json"), { force: true });
  rmSync(path.join(stagingDir, "node_modules", ".package-lock.json"), { force: true });
  // Production command shims are not used by the Node entry point and npm
  // creates them as symlinks, which are deliberately forbidden in an MCPB.
  rmSync(path.join(stagingDir, "node_modules", ".bin"), { recursive: true, force: true });

  // MCPB's walker historically omitted declarations, source maps, and common
  // package-manager/editor metadata. Remove them from the stage itself so the
  // expected manifest describes exactly what the canonical writer receives.
  const removeDevelopmentArtifacts = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const isExcludedDirectory = entry.isDirectory() && [".cache", ".npm", ".yarn"].includes(entry.name);
      const isExcludedFile = !entry.isDirectory() && (
        DEVELOPMENT_FILE_SUFFIXES.some(suffix => entry.name.endsWith(suffix)) ||
        [".DS_Store", "Thumbs.db", ".gitignore", ".npmrc", ".yarnrc", "yarn.lock", "tsconfig.json"].includes(entry.name) ||
        entry.name.endsWith(".log") ||
        entry.name === ".env" ||
        entry.name.startsWith(".env.")
      );
      if (isExcludedDirectory || isExcludedFile) {
        rmSync(absolutePath, { recursive: true, force: true });
      } else if (entry.isDirectory()) {
        removeDevelopmentArtifacts(absolutePath);
      }
    }
  };
  removeDevelopmentArtifacts(stagingDir);
}

function verifyStagedProductionGraph(stagingDir, packages) {
  const expected = buildExpectedFileManifest(stagingDir);
  const paths = expected.map(file => file.path);
  const archivedServerFiles = paths
    .filter(filename => filename.startsWith("server/"))
    .map(filename => filename.slice("server/".length));
  if (JSON.stringify(archivedServerFiles) !== JSON.stringify(SERVER_FILES)) {
    throw new Error(`Staged server inventory mismatch: ${archivedServerFiles.join(", ")}`);
  }
  const uiFiles = paths.filter(filename => filename.startsWith("dist-ui/"));
  if (JSON.stringify(uiFiles) !== JSON.stringify(["dist-ui/index.html"])) {
    throw new Error(`Staged UI inventory mismatch: ${uiFiles.join(", ")}`);
  }
  for (const required of [
    "manifest.json",
    "package.json",
    "server/index.js",
    "dist-ui/index.html",
    "node_modules/pdfjs-dist/legacy/build/pdf.mjs",
    "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  ]) {
    if (!paths.includes(required)) throw new Error(`Staged MCPB is missing required runtime file: ${required}`);
  }
  for (const filename of paths) {
    if (FORBIDDEN_ARCHIVE_FILES.has(filename) || FORBIDDEN_ARCHIVE_PREFIXES.some(prefix => filename.startsWith(prefix))) {
      throw new Error(`Staged MCPB contains forbidden entry: ${filename}`);
    }
    if (DEVELOPMENT_FILE_SUFFIXES.some(suffix => filename.endsWith(suffix))) {
      throw new Error(`Staged MCPB contains development-only metadata: ${filename}`);
    }
  }
  const nativePaths = packages.map(target =>
    `node_modules/${target.packageName}/${target.binary}`,
  );
  for (const nativePath of nativePaths) {
    const file = expected.find(entry => entry.path === nativePath);
    if (!file || file.size === 0) throw new Error(`Required native binding is missing or empty: ${nativePath}`);
  }
  const stagedNativePackages = readdirSync(path.join(stagingDir, "node_modules", "@napi-rs"))
    .filter(name => name.startsWith("canvas-"))
    .map(name => `@napi-rs/${name}`)
    .sort();
  const intendedNativePackages = packages.map(target => target.packageName).sort();
  if (JSON.stringify(stagedNativePackages) !== JSON.stringify(intendedNativePackages)) {
    throw new Error(`Unexpected native canvas package inventory: ${stagedNativePackages.join(", ")}`);
  }
  const runtimePackage = JSON.parse(readFileSync(path.join(stagingDir, "package.json"), "utf8"));
  if (runtimePackage.dependencies?.["pdfjs-dist"] !== PROTECTED_PDFJS_VERSION) {
    throw new Error(`Staged pdfjs-dist must remain exactly ${PROTECTED_PDFJS_VERSION}`);
  }
  return { expected, nativePaths };
}

function prepareCleanStage() {
  const stagingDir = mkdtempSync(path.join(tmpdir(), "pdf-tools-mcpb-"));
  const downloadDir = path.join(stagingDir, ".native-packages");
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const mcpbCommand = path.join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "mcpb.cmd" : "mcpb");
  try {
    run(npmCommand, ["run", "build:ui"]);
    copyRuntimeSource(stagingDir);
    run(npmCommand, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stagingDir });
    removeHostSelectedNativePackages(stagingDir);
    mkdirSync(downloadDir, { recursive: true });
    const packages = installLockedNativePackages(stagingDir, downloadDir);
    rmSync(downloadDir, { recursive: true, force: true });
    trimStagedProductionGraph(stagingDir);
    run(mcpbCommand, ["validate", path.join(stagingDir, "manifest.json")]);
    return { stagingDir, ...verifyStagedProductionGraph(stagingDir, packages) };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const outputPath = path.resolve(process.argv[2] || DEFAULT_OUTPUT);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  verifyInstalledBuildToolchain(REPO_ROOT);
  verifyLockedTooling();
  const builds = [];
  try {
    for (let buildNumber = 1; buildNumber <= 2; buildNumber += 1) {
      console.log(`\nPreparing clean MCPB build ${buildNumber}/2...`);
      const build = prepareCleanStage();
      build.archive = createCanonicalZip(build.expected);
      verifyCanonicalZip(build.archive, build.expected);
      build.sha256 = sha256Bytes(build.archive);
      console.log(`Canonical build ${buildNumber}: ${build.sha256}`);
      builds.push(build);
    }
    if (builds[0].sha256 !== builds[1].sha256 || !Buffer.from(builds[0].archive).equals(Buffer.from(builds[1].archive))) {
      throw new Error(`Clean MCPB builds were not byte-identical: ${builds[0].sha256} != ${builds[1].sha256}`);
    }
    const result = writeCanonicalBytesAtomic({
      bytes: builds[1].archive,
      expectedFiles: builds[1].expected,
      outputPath,
      beforeRename(candidatePath) {
        run("unzip", ["-tqq", candidatePath], { capture: true });
      },
    });
    console.log("\nVerified native bindings:");
    for (const nativePath of builds[1].nativePaths) console.log(`- ${nativePath}`);
    console.log(`\nArtifact: ${outputPath}`);
    console.log(`Files: ${result.files}`);
    console.log(`Bytes: ${result.bytes}`);
    console.log(`SHA-256: ${result.sha256}`);
    console.log("Reproducibility: two clean builds were byte-identical");
  } finally {
    for (const build of builds) rmSync(build.stagingDir, { recursive: true, force: true });
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`MCPB build failed: ${error.message}`);
    process.exitCode = 1;
  });
}
