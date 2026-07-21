#!/usr/bin/env node

import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIRNAME = "pdf-toolkit-mcp-share";
const SOURCE_DIR = path.join(PROJECT_ROOT, SOURCE_DIRNAME);
const OUTPUT_FILE = path.join(PROJECT_ROOT, "pdf-toolkit-mcp.zip");
const ARCHIVE_EPOCH = new Date("1980-01-01T00:00:00.000Z");
const SHARE_FILES = [
  "README.md",
  "dist-ui/index.html",
  "install.command",
  "install.sh",
  "package-lock.json",
  "package.json",
  "server/helpers.js",
  "server/index.js",
  "server/resource-uri.js",
  "server/stderr-suppression.js",
  "smart-install.sh",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function verifyShareLock(sharePackage, rootLock) {
  const lockPath = path.join(SOURCE_DIR, "package-lock.json");
  let lock;
  try {
    lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch (error) {
    throw new Error(
      `A valid ${SOURCE_DIRNAME}/package-lock.json is required for reproducible installs: ${error.message}`,
    );
  }

  const lockedRoot = lock.packages?.[""];
  if (lock.lockfileVersion !== 3 || !lockedRoot) {
    throw new Error("Share package lock must use npm lockfileVersion 3 and include its root package record.");
  }

  for (const [packagePath, lockedPackage] of Object.entries(lock.packages)) {
    if (packagePath === "") continue;
    if (!lockedPackage.version || !lockedPackage.resolved || !lockedPackage.integrity) {
      throw new Error(`Share lock lacks complete registry provenance for ${packagePath}.`);
    }
  }

  for (const key of ["name", "version", "license", "engines", "dependencies"]) {
    if (!sameJson(lockedRoot[key], sharePackage[key])) {
      throw new Error(
        `${SOURCE_DIRNAME}/package-lock.json is stale at packages[\"\"].${key}. ` +
          "Regenerate it with `npm install --package-lock-only --ignore-scripts` in the share directory.",
      );
    }
  }

  for (const dependencyName of Object.keys(sharePackage.dependencies)) {
    const lockedPackage = lock.packages[`node_modules/${dependencyName}`];
    if (!lockedPackage?.version || !lockedPackage?.resolved || !lockedPackage?.integrity) {
      throw new Error(`Share lock is missing version/resolved/integrity provenance for ${dependencyName}.`);
    }
    const rootLockedVersion = rootLock.packages?.[`node_modules/${dependencyName}`]?.version;
    if (lockedPackage.version !== rootLockedVersion) {
      throw new Error(
        `Share lock drifted from the reviewed root lock for ${dependencyName}: ` +
          `${lockedPackage.version} != ${rootLockedVersion}.`,
      );
    }
  }

  if (lock.packages["node_modules/pdfjs-dist"]?.version !== "5.4.624") {
    throw new Error("Share lock does not preserve pdfjs-dist@5.4.624.");
  }

  return lock;
}

async function syncSharePackage() {
  const rootPackage = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  const rootLock = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package-lock.json"), "utf8"));
  const sharePackagePath = path.join(SOURCE_DIR, "package.json");
  const shareServerDir = path.join(SOURCE_DIR, "server");
  const shareUiDir = path.join(SOURCE_DIR, "dist-ui");

  await fs.mkdir(shareServerDir, { recursive: true });
  await fs.mkdir(shareUiDir, { recursive: true });

  try {
    await fs.access(path.join(PROJECT_ROOT, "dist-ui", "index.html"));
  } catch {
    throw new Error("dist-ui/index.html is missing. Run `npm run build:ui` before packaging the share bundle.");
  }

  await Promise.all([
    fs.copyFile(path.join(PROJECT_ROOT, "server", "index.js"), path.join(shareServerDir, "index.js")),
    fs.copyFile(path.join(PROJECT_ROOT, "server", "helpers.js"), path.join(shareServerDir, "helpers.js")),
    fs.copyFile(path.join(PROJECT_ROOT, "server", "resource-uri.js"), path.join(shareServerDir, "resource-uri.js")),
    fs.copyFile(
      path.join(PROJECT_ROOT, "server", "stderr-suppression.js"),
      path.join(shareServerDir, "stderr-suppression.js"),
    ),
    fs.copyFile(path.join(PROJECT_ROOT, "dist-ui", "index.html"), path.join(shareUiDir, "index.html")),
  ]);

  const sharePackage = {
    name: rootPackage.name,
    version: rootPackage.version,
    description: "PDF Tools MCP server for Cursor and other stdio MCP hosts",
    type: "module",
    main: "server/index.js",
    license: rootPackage.license,
    engines: rootPackage.engines,
    dependencies: {
      "@modelcontextprotocol/sdk": rootPackage.dependencies["@modelcontextprotocol/sdk"],
      "@napi-rs/canvas": rootPackage.dependencies["@napi-rs/canvas"],
      "pdf-lib": rootPackage.dependencies["pdf-lib"],
      "pdfjs-dist": rootPackage.dependencies["pdfjs-dist"],
    },
  };

  if (sharePackage.dependencies["pdfjs-dist"] !== "5.4.624") {
    throw new Error("Refusing to package an unreviewed pdfjs-dist version; expected exact pin 5.4.624.");
  }

  await fs.writeFile(sharePackagePath, `${JSON.stringify(sharePackage, null, 2)}\n`);
  await verifyShareLock(sharePackage, rootLock);

  return sharePackage;
}

async function stageSharePackage(stageRoot, sharePackage) {
  const stagedPackageRoot = path.join(stageRoot, SOURCE_DIRNAME);
  const fileHashes = {};

  for (const relativePath of SHARE_FILES) {
    const sourcePath = path.join(SOURCE_DIR, relativePath);
    const targetPath = path.join(stagedPackageRoot, relativePath);
    const sourceStat = await fs.stat(sourcePath);
    if (!sourceStat.isFile()) {
      throw new Error(`Expected a regular share-package file: ${relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
    await fs.chmod(targetPath, sourceStat.mode & 0o777);
    const bytes = await fs.readFile(targetPath);
    fileHashes[relativePath] = sha256(bytes);
  }

  const lockBytes = await fs.readFile(path.join(stagedPackageRoot, "package-lock.json"));
  const provenance = {
    schema_version: "1.0",
    package: {
      name: sharePackage.name,
      version: sharePackage.version,
    },
    dependency_lock: {
      path: "package-lock.json",
      lockfile_version: 3,
      sha256: sha256(lockBytes),
    },
    files: fileHashes,
  };
  const provenancePath = path.join(stagedPackageRoot, "SHARE-PROVENANCE.json");
  await fs.writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

  const archiveFiles = [...SHARE_FILES, "SHARE-PROVENANCE.json"]
    .map(relativePath => `${SOURCE_DIRNAME}/${relativePath}`)
    .sort();
  for (const archivePath of archiveFiles) {
    await fs.utimes(path.join(stageRoot, archivePath), ARCHIVE_EPOCH, ARCHIVE_EPOCH);
  }

  return { archiveFiles, provenance };
}

async function createArchive(stageRoot, archiveFiles) {
  await fs.rm(OUTPUT_FILE, { force: true });
  execFileSync("zip", ["-X", "-q", OUTPUT_FILE, "-@"], {
    cwd: stageRoot,
    env: { ...process.env, TZ: "UTC" },
    input: `${archiveFiles.join("\n")}\n`,
    stdio: ["pipe", "inherit", "inherit"],
  });
}

async function createPackage() {
  console.log("📦 Creating reproducible share package for Cursor and other stdio MCP hosts...\n");

  try {
    await fs.access(SOURCE_DIR);
  } catch {
    throw new Error(`Directory '${SOURCE_DIRNAME}' not found at ${PROJECT_ROOT}.`);
  }

  const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-share-stage-"));
  try {
    console.log("🔄 Syncing share-package runtime files and validating the reviewed dependency lock...");
    const sharePackage = await syncSharePackage();
    const { archiveFiles } = await stageSharePackage(stageRoot, sharePackage);

    console.log(`📁 Writing deterministic ${path.basename(OUTPUT_FILE)}...`);
    await createArchive(stageRoot, archiveFiles);

    const bytes = await fs.readFile(OUTPUT_FILE);
    const fileSizeInMB = (bytes.length / (1024 * 1024)).toFixed(2);
    console.log("\n✅ Share package created successfully!");
    console.log(`📦 File: ${OUTPUT_FILE} (${fileSizeInMB} MB)`);
    console.log(`🔒 SHA-256: ${sha256(bytes)}`);
    console.log("🔁 Installers consume the shipped lock with `npm ci --omit=dev --engine-strict`.");
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true });
  }
}

createPackage().catch(error => {
  console.error(`❌ Share-package build failed: ${error.message}`);
  process.exitCode = 1;
});
