#!/usr/bin/env node

/*
 * Promotes an extracted QPDF WebAssembly build into the committed, shipped
 * runtime directory and derives its provenance record.
 *
 * Nothing here is hand-maintained. The artifact hashes come from the bytes
 * being promoted, the pinned source hashes and toolchain digest come from
 * `vendor/qpdf-wasm/sources.lock.json`, and the notice hashes come from
 * `vendor/qpdf-wasm/licenses/manifest.json`. The promotion refuses to run
 * unless the build directory already reproduces `expected-output.json`, so a
 * drifted or locally patched build cannot become the shipped artifact.
 *
 *   node scripts/vendor-qpdf-wasm-runtime.mjs <extracted-build-directory>
 *
 * The build directory is what `npm run qpdf-wasm:verify` extracts from the
 * pinned container: qpdf.mjs, qpdf.wasm, BUILD-INPUTS.json,
 * THIRD_PARTY_VERSIONS.txt and licenses/.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECIPE_DIR = path.join(REPO_ROOT, "vendor", "qpdf-wasm");
const RUNTIME_DIR = path.join(RECIPE_DIR, "runtime");
const PROVENANCE_PATH = path.join(RECIPE_DIR, "runtime.provenance.json");
const DEFAULT_BUILD_DIR = path.join(RECIPE_DIR, "dist");

/*
 * Exactly what the shipped runtime directory contains, relative to it. The
 * two generated files carry the `expected-output.json` hash contract; the
 * three metadata files and the notice directory are what a redistributor
 * needs in order to receive the runtime lawfully and identify it.
 */
export const QPDF_WASM_RUNTIME_GENERATED_FILES = Object.freeze([
  "qpdf.mjs",
  "qpdf.wasm",
]);
export const QPDF_WASM_RUNTIME_METADATA_FILES = Object.freeze([
  "BUILD-INPUTS.json",
  "THIRD_PARTY_VERSIONS.txt",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalLfSha256(bytes) {
  const canonical = Buffer.from(bytes).toString("utf8").replace(/\r\n?/g, "\n");
  return sha256(Buffer.from(canonical, "utf8"));
}

function posixRelative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function assertIdenticalBytes(label, firstPath, secondPath) {
  const [first, second] = await Promise.all([fs.readFile(firstPath), fs.readFile(secondPath)]);
  if (!first.equals(second)) {
    throw new Error(`${label} differs between ${posixRelative(REPO_ROOT, firstPath)} and ${secondPath}`);
  }
  return first;
}

async function main() {
  const buildDir = path.resolve(process.argv[2] || DEFAULT_BUILD_DIR);
  const sourcesLock = await readJson(path.join(RECIPE_DIR, "sources.lock.json"));
  const expectedOutput = await readJson(path.join(RECIPE_DIR, "expected-output.json"));
  const licenseManifest = await readJson(path.join(RECIPE_DIR, "licenses", "manifest.json"));

  // 1. The generated artifacts must already reproduce the recorded contract.
  const generated = new Map();
  for (const filename of QPDF_WASM_RUNTIME_GENERATED_FILES) {
    const bytes = await fs.readFile(path.join(buildDir, filename));
    const contract = expectedOutput.artifacts[filename];
    if (!contract) throw new Error(`expected-output.json does not describe ${filename}`);
    const digest = sha256(bytes);
    if (bytes.length !== contract.bytes || digest !== contract.sha256) {
      throw new Error(
        `${filename} does not reproduce expected-output.json: `
        + `expected ${contract.bytes}/${contract.sha256}, received ${bytes.length}/${digest}`,
      );
    }
    generated.set(filename, bytes);
  }
  const contractFilenames = Object.keys(expectedOutput.artifacts).sort();
  if (JSON.stringify(contractFilenames) !== JSON.stringify([...QPDF_WASM_RUNTIME_GENERATED_FILES].sort())) {
    throw new Error(`expected-output.json describes a different artifact set: ${contractFilenames.join(", ")}`);
  }

  // 2. The build's own copy of its inputs must be the pinned lock verbatim.
  await assertIdenticalBytes(
    "BUILD-INPUTS.json",
    path.join(RECIPE_DIR, "sources.lock.json"),
    path.join(buildDir, "BUILD-INPUTS.json"),
  );
  const versionsBytes = await fs.readFile(path.join(buildDir, "THIRD_PARTY_VERSIONS.txt"), "utf8");
  for (const source of sourcesLock.sources) {
    if (!versionsBytes.includes(`${source.name} ${source.version}`)) {
      throw new Error(`THIRD_PARTY_VERSIONS.txt omits the pinned ${source.name} ${source.version}`);
    }
  }
  if (!versionsBytes.includes(sourcesLock.toolchain.digest)) {
    throw new Error("THIRD_PARTY_VERSIONS.txt omits the pinned Emscripten image digest");
  }

  // 3. Every notice must match the recipe's manifest and the recipe's own copy.
  const recipeLicenseNames = (await fs.readdir(path.join(RECIPE_DIR, "licenses"))).sort();
  const manifestNames = [...licenseManifest.files.map(entry => entry.file), "manifest.json"].sort();
  if (JSON.stringify(recipeLicenseNames) !== JSON.stringify(manifestNames)) {
    throw new Error(`licenses/manifest.json does not describe the notice directory: ${recipeLicenseNames.join(", ")}`);
  }
  for (const entry of licenseManifest.files) {
    const bytes = await assertIdenticalBytes(
      `licenses/${entry.file}`,
      path.join(RECIPE_DIR, "licenses", entry.file),
      path.join(buildDir, "licenses", entry.file),
    );
    if (canonicalLfSha256(bytes) !== entry.sha256) {
      throw new Error(`licenses/${entry.file} does not match its manifest hash`);
    }
  }
  await assertIdenticalBytes(
    "licenses/manifest.json",
    path.join(RECIPE_DIR, "licenses", "manifest.json"),
    path.join(buildDir, "licenses", "manifest.json"),
  );

  // 4. Promote. The directory is rebuilt from scratch so a removed upstream
  //    file cannot survive as a stale shipped artifact.
  await fs.rm(RUNTIME_DIR, { recursive: true, force: true });
  await fs.mkdir(path.join(RUNTIME_DIR, "licenses"), { recursive: true });
  /*
   * Modes are normalised to 0o644. emcc leaves the executable bit on
   * `qpdf.wasm`, Docker's export preserves it, and Git would then record the
   * runtime as 100755 — a data file advertised as executable, which the share
   * package's mode review rejects outright. Content is untouched, so the hash
   * contract is unaffected.
   */
  const promote = async (source, destination) => {
    await fs.copyFile(source, destination);
    await fs.chmod(destination, 0o644);
  };
  for (const filename of [...QPDF_WASM_RUNTIME_GENERATED_FILES, ...QPDF_WASM_RUNTIME_METADATA_FILES]) {
    await promote(path.join(buildDir, filename), path.join(RUNTIME_DIR, filename));
  }
  for (const filename of recipeLicenseNames) {
    await promote(
      path.join(RECIPE_DIR, "licenses", filename),
      path.join(RUNTIME_DIR, "licenses", filename),
    );
  }

  // 5. Derive the provenance from the promoted bytes themselves.
  const shippedFiles = [];
  for (const relativePath of [
    ...QPDF_WASM_RUNTIME_GENERATED_FILES,
    ...QPDF_WASM_RUNTIME_METADATA_FILES,
    ...recipeLicenseNames.map(name => `licenses/${name}`),
  ].sort()) {
    const bytes = await fs.readFile(path.join(RUNTIME_DIR, ...relativePath.split("/")));
    shippedFiles.push({
      path: `vendor/qpdf-wasm/runtime/${relativePath}`,
      sha256: sha256(bytes),
      size_bytes: bytes.length,
    });
  }

  const generatorPath = fileURLToPath(import.meta.url);
  const provenance = {
    schema_version: 1,
    artifact_id: "pdf-tools.runtime.qpdf-wasm.v1",
    ownership: "Open Document Alliance reproducible build of pinned third-party sources",
    license: "Apache-2.0 (qpdf) plus the additional bundled notices in runtime/licenses/manifest.json",
    privacy: "Compiled third-party source only; no personal data and no PDF content",
    redistribution: "allowed while the complete notice directory travels with the runtime",
    integration_status:
      "Packaged into the MCPB and the share ZIP, and loaded by exactly one module: "
      + "server/qpdf-decrypt.js. It decrypts encrypted PDFs in memory for the read-only tools "
      + "read_pdf_fields, validate_pdf and extract_to_csv, which never write a PDF back. No write "
      + "path loads it, nothing re-encrypts or rewrites a document with it, and decrypted bytes "
      + "are never written to disk.",
    generator: {
      path: posixRelative(REPO_ROOT, generatorPath),
      sha256: canonicalLfSha256(await fs.readFile(generatorPath)),
      hash_contract: "SHA-256 of UTF-8 generator source after CRLF or CR line endings are normalized to LF",
      runtime: "Node.js standard library only",
      command: "node scripts/vendor-qpdf-wasm-runtime.mjs <extracted-build-directory>",
    },
    build: {
      recipe_directory: "vendor/qpdf-wasm",
      source_date_epoch: sourcesLock.source_date_epoch,
      network: "every Docker build stage runs with --network=none",
      crypto_provider: "qpdf native; neither OpenSSL nor GnuTLS is linked",
      toolchain: {
        name: sourcesLock.toolchain.name,
        version: sourcesLock.toolchain.version,
        platform: sourcesLock.toolchain.platform,
        image: sourcesLock.toolchain.image,
        digest: sourcesLock.toolchain.digest,
        upstream: sourcesLock.toolchain.upstream,
      },
      sources: sourcesLock.sources.map(source => ({
        name: source.name,
        version: source.version,
        filename: source.filename,
        url: source.url,
        sha256: source.sha256,
      })),
    },
    reproduction: {
      release_gate: {
        command: "npm run qpdf-wasm:verify",
        requires: "Docker",
        cost: "Two clean --no-cache --network=none linux/amd64 builds; roughly 45 minutes under "
          + "x86-64 emulation on Apple Silicon",
        scope: "Rebuilds from pinned sources, requires the two builds to be byte-identical, checks them "
          + "against expected-output.json, and runs the Node smoke",
        cadence: "Release and nightly only. Deliberately excluded from `npm test`.",
      },
      developer_gate: {
        command: "npm test -- test/qpdf-wasm-runtime-artifact.test.js",
        requires: "Nothing beyond Node",
        cost: "Sub-second",
        scope: "Binds the committed runtime bytes to expected-output.json and the notice manifest, "
          + "asserts both packager allow-lists cover the directory exactly, and instantiates the "
          + "committed module to encrypt, reject a wrong password, decrypt, and structurally check a PDF",
        cadence: "Every `npm test`.",
      },
      promotion: {
        command: "node scripts/vendor-qpdf-wasm-runtime.mjs <extracted-build-directory>",
        scope: "Re-derives this record; refuses any build that does not already reproduce expected-output.json",
      },
    },
    expected_output_contract: {
      path: "vendor/qpdf-wasm/expected-output.json",
      sha256: sha256(await fs.readFile(path.join(RECIPE_DIR, "expected-output.json"))),
      artifacts: expectedOutput.artifacts,
    },
    notices: {
      manifest_path: "vendor/qpdf-wasm/runtime/licenses/manifest.json",
      hash_contract: "SHA-256 of each notice after CRLF or CR line endings are normalized to LF",
      components: licenseManifest.files.map(entry => ({
        component: entry.component,
        spdx: entry.spdx,
        file: `licenses/${entry.file}`,
        sha256: entry.sha256,
      })),
    },
    runtime_assets: {
      directory: "vendor/qpdf-wasm/runtime",
      shipped_in: ["pdf-toolkit-mcp.mcpb", "pdf-toolkit-mcp.zip"],
      archive_path_note:
        "Both packagers stage this directory at the identical archive path, so the repository path, the "
        + "MCPB path, and the share ZIP path are the same string.",
      files: shippedFiles,
    },
  };

  await fs.writeFile(PROVENANCE_PATH, `${JSON.stringify(provenance, null, 2)}\n`);
  process.stdout.write(`${posixRelative(REPO_ROOT, RUNTIME_DIR)} <- ${buildDir}\n`);
  for (const file of shippedFiles) {
    process.stdout.write(`${file.path} ${file.size_bytes} ${file.sha256}\n`);
  }
  process.stdout.write(`${posixRelative(REPO_ROOT, PROVENANCE_PATH)} written\n`);
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`QPDF WASM runtime promotion failed: ${error.message}`);
    process.exitCode = 1;
  });
}
