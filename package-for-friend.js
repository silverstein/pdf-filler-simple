#!/usr/bin/env node

import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.dirname(SCRIPT_PATH);
const SOURCE_DIRNAME = "pdf-toolkit-mcp-share";
const SOURCE_DIR = path.join(PROJECT_ROOT, SOURCE_DIRNAME);
const OUTPUT_FILE = path.join(PROJECT_ROOT, "pdf-toolkit-mcp.zip");
const ARCHIVE_EPOCH = new Date("1980-01-01T00:00:00.000Z");
const SBOM_FILENAME = "SBOM.cdx.json";
const PROVENANCE_FILENAME = "SHARE-PROVENANCE.json";
const SHARE_FILES = [
  "README.md",
  "configure-cursor.sh",
  "dist-ui/index.html",
  "install-transactional.sh",
  "install.command",
  "install.sh",
  "package-lock.json",
  "package.json",
  "server/helpers.js",
  "server/index.js",
  "server/output-schemas.js",
  "server/resource-uri.js",
  "server/stderr-suppression.js",
  "smart-install.sh",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort(compareCodePoints).map(key => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function packageNameFromLockPath(packagePath) {
  const nestedMarker = "/node_modules/";
  const nestedIndex = packagePath.lastIndexOf(nestedMarker);
  return nestedIndex >= 0
    ? packagePath.slice(nestedIndex + nestedMarker.length)
    : packagePath.replace(/^node_modules\//, "");
}

function packagePurl(name, version) {
  const encodedName = name.split("/").map(segment => encodeURIComponent(segment)).join("/");
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function packageBomRef(packagePath) {
  return `urn:pdf-tools:npm-lock:${sha256(packagePath).slice(0, 32)}`;
}

function deterministicUuid(seed) {
  // RFC 4122 UUIDv5 using the standard URL namespace. The seed is the locked
  // graph digest, so identical reviewed graphs get identical SBOM identities.
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const bytes = createHash("sha1").update(namespace).update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function integrityHash(integrity) {
  const match = /^(sha(?:1|256|384|512))-([A-Za-z0-9+/=]+)$/.exec(integrity || "");
  if (!match) throw new Error(`Unsupported npm integrity value: ${integrity}`);
  const algorithm = match[1].toUpperCase().replace(/^SHA(\d+)$/, "SHA-$1");
  return { alg: algorithm, content: Buffer.from(match[2], "base64").toString("hex") };
}

function resolveDependencyPath(packages, packagePath, dependencyName) {
  let base = packagePath;
  while (base) {
    const candidate = `${base}/node_modules/${dependencyName}`;
    if (packages[candidate]) return candidate;
    const parentIndex = base.lastIndexOf("/node_modules/");
    if (parentIndex < 0) break;
    base = base.slice(0, parentIndex);
  }
  const rootCandidate = `node_modules/${dependencyName}`;
  return packages[rootCandidate] ? rootCandidate : null;
}

function dependencyPathsForPackage(lock, packagePath) {
  const lockedPackage = lock.packages[packagePath];
  const names = new Set([
    ...Object.keys(lockedPackage.dependencies || {}),
    ...Object.keys(lockedPackage.optionalDependencies || {}),
    ...Object.keys(lockedPackage.peerDependencies || {}),
  ]);
  const paths = [];
  for (const dependencyName of [...names].sort(compareCodePoints)) {
    const resolvedPath = resolveDependencyPath(lock.packages, packagePath, dependencyName);
    if (resolvedPath) {
      paths.push(resolvedPath);
      continue;
    }
    const isOptional = dependencyName in (lockedPackage.optionalDependencies || {}) ||
      lockedPackage.peerDependenciesMeta?.[dependencyName]?.optional === true;
    if (!isOptional) {
      throw new Error(`Locked dependency ${dependencyName} required by ${packagePath || "root"} is missing.`);
    }
  }
  return [...new Set(paths)].sort(compareCodePoints);
}

export function generateCycloneDxSbom(lock, sharePackage) {
  const rootRef = `pkg:npm/${encodeURIComponent(sharePackage.name)}@${encodeURIComponent(sharePackage.version)}`;
  const packageEntries = Object.entries(lock.packages)
    .filter(([packagePath]) => packagePath !== "")
    .sort(([left], [right]) => compareCodePoints(left, right));
  const components = packageEntries.map(([packagePath, lockedPackage]) => {
    const name = packageNameFromLockPath(packagePath);
    const component = {
      type: "library",
      "bom-ref": packageBomRef(packagePath),
      name,
      version: lockedPackage.version,
      scope: lockedPackage.optional ? "optional" : "required",
      hashes: [integrityHash(lockedPackage.integrity)],
      purl: packagePurl(name, lockedPackage.version),
      externalReferences: [{ type: "distribution", url: lockedPackage.resolved }],
      properties: [
        { name: "pdf-tools:npm-package-path", value: packagePath },
      ],
    };
    if (lockedPackage.license) component.licenses = [{ expression: lockedPackage.license }];
    if (lockedPackage.os) {
      component.properties.push({ name: "pdf-tools:npm-os", value: JSON.stringify(lockedPackage.os) });
    }
    if (lockedPackage.cpu) {
      component.properties.push({ name: "pdf-tools:npm-cpu", value: JSON.stringify(lockedPackage.cpu) });
    }
    return component;
  });
  const dependencies = [
    {
      ref: rootRef,
      dependsOn: dependencyPathsForPackage(lock, "").map(packageBomRef),
    },
    ...packageEntries.map(([packagePath]) => ({
      ref: packageBomRef(packagePath),
      dependsOn: dependencyPathsForPackage(lock, packagePath).map(packageBomRef),
    })),
  ];
  const lockDigest = sha256(`${JSON.stringify(lock)}\n`);
  const sbom = {
    $schema: "http://cyclonedx.org/schema/bom-1.6.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${deterministicUuid(lockDigest)}`,
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": rootRef,
        name: sharePackage.name,
        version: sharePackage.version,
        purl: rootRef,
        licenses: [{ expression: sharePackage.license }],
      },
      properties: [
        { name: "pdf-tools:evidence-validation", value: "deterministic structural and lock-coverage validation" },
      ],
    },
    components,
    dependencies,
  };
  validateCycloneDxSbom(sbom, lock, sharePackage);
  return sbom;
}

export function validateCycloneDxSbom(sbom, lock, sharePackage) {
  if (sbom.$schema !== "http://cyclonedx.org/schema/bom-1.6.schema.json" ||
      sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.6" || sbom.version !== 1) {
    throw new Error("SBOM is not structurally identified as CycloneDX 1.6 JSON.");
  }
  if (sbom.metadata?.component?.name !== sharePackage.name ||
      sbom.metadata?.component?.version !== sharePackage.version) {
    throw new Error("SBOM metadata component does not match the share package.");
  }

  const packagePaths = Object.keys(lock.packages)
    .filter(packagePath => packagePath !== "")
    .sort(compareCodePoints);
  if (sbom.components?.length !== packagePaths.length) {
    throw new Error(`SBOM component coverage mismatch: ${sbom.components?.length} != ${packagePaths.length}.`);
  }
  const componentsByRef = new Map(sbom.components.map(component => [component["bom-ref"], component]));
  if (componentsByRef.size !== packagePaths.length) throw new Error("SBOM contains duplicate component references.");

  for (const packagePath of packagePaths) {
    const lockedPackage = lock.packages[packagePath];
    const component = componentsByRef.get(packageBomRef(packagePath));
    const pathProperty = component?.properties?.find(property => property.name === "pdf-tools:npm-package-path")?.value;
    if (!component || pathProperty !== packagePath || component.version !== lockedPackage.version ||
        component.name !== packageNameFromLockPath(packagePath) ||
        component.externalReferences?.[0]?.url !== lockedPackage.resolved ||
        !sameJson(component.hashes, [integrityHash(lockedPackage.integrity)])) {
      throw new Error(`SBOM component does not exactly cover ${packagePath}.`);
    }
  }

  const rootRef = sbom.metadata.component["bom-ref"];
  const dependencyEntries = new Map((sbom.dependencies || []).map(entry => [entry.ref, entry.dependsOn]));
  if (dependencyEntries.size !== packagePaths.length + 1) {
    throw new Error("SBOM dependency graph does not cover the root and every locked component exactly once.");
  }
  for (const [packagePath, ref] of [["", rootRef], ...packagePaths.map(value => [value, packageBomRef(value)])]) {
    const actual = dependencyEntries.get(ref);
    const expected = dependencyPathsForPackage(lock, packagePath).map(packageBomRef);
    if (!actual || !sameJson(
      [...actual].sort(compareCodePoints),
      [...expected].sort(compareCodePoints),
    )) {
      throw new Error(`SBOM dependency edges do not exactly cover ${packagePath || "root"}.`);
    }
    for (const dependencyRef of actual) {
      if (!componentsByRef.has(dependencyRef)) {
        throw new Error(`SBOM dependency edge references an unknown component: ${dependencyRef}.`);
      }
    }
  }
  return true;
}

export async function verifyShareLock(sharePackage, rootLock, sourceDir = SOURCE_DIR) {
  const lockPath = path.join(sourceDir, "package-lock.json");
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

  for (const key of ["name", "version", "license", "engines", "dependencies"]) {
    if (!sameJson(lockedRoot[key], sharePackage[key])) {
      throw new Error(
        `${SOURCE_DIRNAME}/package-lock.json is stale at packages[\"\"].${key}. ` +
          "Seed it from the reviewed root lock and prune it to the share manifest.",
      );
    }
  }

  const sharePackagePaths = Object.keys(lock.packages)
    .filter(packagePath => packagePath !== "")
    .sort(compareCodePoints);
  const rootProductionPackagePaths = Object.entries(rootLock.packages || {})
    .filter(([packagePath, lockedPackage]) => packagePath !== "" && lockedPackage.dev !== true)
    .map(([packagePath]) => packagePath)
    .sort(compareCodePoints);
  if (!sameJson(sharePackagePaths, rootProductionPackagePaths)) {
    const shareSet = new Set(sharePackagePaths);
    const rootSet = new Set(rootProductionPackagePaths);
    const missing = rootProductionPackagePaths.filter(packagePath => !shareSet.has(packagePath));
    const extra = sharePackagePaths.filter(packagePath => !rootSet.has(packagePath));
    throw new Error(
      `Share lock package-path coverage differs from the reviewed root production graph; ` +
        `missing=${JSON.stringify(missing)}, extra=${JSON.stringify(extra)}.`,
    );
  }

  for (const [packagePath, lockedPackage] of Object.entries(lock.packages)) {
    if (packagePath === "") continue;
    if (lockedPackage.dev === true) {
      throw new Error(`Share production lock unexpectedly contains a dev-only package: ${packagePath}.`);
    }
    if (!lockedPackage.version || !lockedPackage.resolved || !lockedPackage.integrity) {
      throw new Error(`Share lock lacks complete registry provenance for ${packagePath}.`);
    }
    const rootLockedPackage = rootLock.packages?.[packagePath];
    if (!rootLockedPackage) throw new Error(`Share lock package is absent from the reviewed root lock: ${packagePath}.`);
    if (!sameJson(lockedPackage, rootLockedPackage)) {
      throw new Error(
        `Share lock record drifted from the reviewed root lock for ${packagePath}; ` +
          `share=${JSON.stringify(canonicalize(lockedPackage))}, ` +
          `root=${JSON.stringify(canonicalize(rootLockedPackage))}.`,
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
    fs.copyFile(
      path.join(PROJECT_ROOT, "server", "output-schemas.js"),
      path.join(shareServerDir, "output-schemas.js"),
    ),
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
  const shareLock = await verifyShareLock(sharePackage, rootLock);
  return { sharePackage, shareLock };
}

async function stageSharePackage(stageRoot, sharePackage, shareLock) {
  const stagedPackageRoot = path.join(stageRoot, SOURCE_DIRNAME);
  const fileHashes = {};
  for (const relativePath of SHARE_FILES) {
    const sourcePath = path.join(SOURCE_DIR, relativePath);
    const targetPath = path.join(stagedPackageRoot, relativePath);
    const sourceStat = await fs.stat(sourcePath);
    if (!sourceStat.isFile()) throw new Error(`Expected a regular share-package file: ${relativePath}`);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
    await fs.chmod(targetPath, sourceStat.mode & 0o777);
    fileHashes[relativePath] = sha256(await fs.readFile(targetPath));
  }

  const sbom = generateCycloneDxSbom(shareLock, sharePackage);
  const sbomPath = path.join(stagedPackageRoot, SBOM_FILENAME);
  await fs.writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);
  const sbomBytes = await fs.readFile(sbomPath);
  fileHashes[SBOM_FILENAME] = sha256(sbomBytes);

  const lockBytes = await fs.readFile(path.join(stagedPackageRoot, "package-lock.json"));
  const provenance = {
    schema_version: "1.1",
    package: { name: sharePackage.name, version: sharePackage.version },
    dependency_lock: {
      path: "package-lock.json",
      lockfile_version: 3,
      sha256: sha256(lockBytes),
    },
    sbom: {
      path: SBOM_FILENAME,
      format: "CycloneDX",
      spec_version: "1.6",
      validation: "deterministic structural and exact lock component/dependency coverage; not external schema validation",
      sha256: sha256(sbomBytes),
    },
    files: fileHashes,
  };
  const provenancePath = path.join(stagedPackageRoot, PROVENANCE_FILENAME);
  await fs.writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

  const archiveFiles = [...SHARE_FILES, SBOM_FILENAME, PROVENANCE_FILENAME]
    .map(relativePath => `${SOURCE_DIRNAME}/${relativePath}`)
    .sort(compareCodePoints);
  for (const archivePath of archiveFiles) {
    await fs.utimes(path.join(stageRoot, archivePath), ARCHIVE_EPOCH, ARCHIVE_EPOCH);
  }
  return { archiveFiles, provenance };
}

function validateArchive(candidatePath, archiveFiles, unzipCommand) {
  execFileSync(unzipCommand, ["-tqq", candidatePath], { stdio: "pipe" });
  const entries = execFileSync(unzipCommand, ["-Z1", candidatePath], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean)
    .sort(compareCodePoints);
  if (!sameJson(entries, [...archiveFiles].sort(compareCodePoints))) {
    throw new Error(`ZIP entry validation failed: ${JSON.stringify(entries)}.`);
  }
}

async function createArchive(stageRoot, archiveFiles, options) {
  const { outputFile, zipCommand, unzipCommand } = options;
  const candidateRoot = await fs.mkdtemp(
    path.join(path.dirname(outputFile), `.${path.basename(outputFile)}.candidate-`),
  );
  const candidatePath = path.join(candidateRoot, path.basename(outputFile));
  try {
    execFileSync(zipCommand, ["-X", "-q", candidatePath, "-@"], {
      cwd: stageRoot,
      env: { ...process.env, TZ: "UTC" },
      input: `${archiveFiles.join("\n")}\n`,
      stdio: ["pipe", "inherit", "inherit"],
    });
    validateArchive(candidatePath, archiveFiles, unzipCommand);
    await fs.rename(candidatePath, outputFile);
  } finally {
    await fs.rm(candidateRoot, { recursive: true, force: true });
  }
}

export async function createPackage(options = {}) {
  const outputFile = options.outputFile || OUTPUT_FILE;
  const zipCommand = options.zipCommand || "zip";
  const unzipCommand = options.unzipCommand || "unzip";
  console.log("📦 Creating reproducible share package for Cursor and other stdio MCP hosts...\n");
  try {
    await fs.access(SOURCE_DIR);
  } catch {
    throw new Error(`Directory '${SOURCE_DIRNAME}' not found at ${PROJECT_ROOT}.`);
  }

  const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-share-stage-"));
  try {
    console.log("🔄 Syncing runtime files, validating the full lock, and generating CycloneDX 1.6 SBOM...");
    const { sharePackage, shareLock } = await syncSharePackage();
    const { archiveFiles } = await stageSharePackage(stageRoot, sharePackage, shareLock);
    console.log(`📁 Building and validating atomic candidate for ${path.basename(outputFile)}...`);
    await createArchive(stageRoot, archiveFiles, { outputFile, zipCommand, unzipCommand });

    const bytes = await fs.readFile(outputFile);
    console.log("\n✅ Share package created successfully!");
    console.log(`📦 File: ${outputFile} (${(bytes.length / (1024 * 1024)).toFixed(2)} MB)`);
    console.log(`🔒 SHA-256: ${sha256(bytes)}`);
    console.log("🔁 Installers consume the shipped lock with `npm ci --omit=dev --engine-strict`.");
    return { outputFile, sha256: sha256(bytes), size: bytes.length, archiveFiles };
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  createPackage().catch(error => {
    console.error(`❌ Share-package build failed: ${error.message}`);
    process.exitCode = 1;
  });
}
