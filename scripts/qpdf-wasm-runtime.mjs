/*
 * The single description of the QPDF WebAssembly runtime that both packagers
 * ship, derived from the committed provenance record rather than from a list
 * anyone maintains by hand.
 *
 * `vendor/qpdf-wasm/` holds the reproducible build recipe. `npm run
 * qpdf-wasm:verify` rebuilds it twice from pinned sources inside a pinned
 * container with networking disabled and requires the results to be
 * byte-identical to `expected-output.json`; that takes about 45 minutes and is
 * a release gate, not a developer-inner-loop gate. What ships is the promoted
 * copy under `vendor/qpdf-wasm/runtime/`, produced by
 * `scripts/vendor-qpdf-wasm-runtime.mjs`, which refuses to promote any build
 * that does not already reproduce that contract.
 *
 * Every entry below carries the size and SHA-256 of the bytes that were
 * promoted, so a packager can assert that what it staged is what was reviewed
 * instead of merely asserting that a file of the right name exists. That is
 * the check that distinguishes a shipped artifact from a present one.
 *
 * Exactly one module imports this runtime: `server/qpdf-decrypt.js`, which
 * decrypts encrypted PDFs in memory for the read-only tools `read_pdf_fields`,
 * `validate_pdf` and `extract_to_csv`. That single-importer property is
 * asserted by `test/qpdf-wasm-runtime-artifact.test.js`, because the wrapper is
 * where the password, permission and size rules live; a second importer would
 * bypass all of them. No write path loads it.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

export const QPDF_WASM_RECIPE_DIRECTORY = "vendor/qpdf-wasm";
export const QPDF_WASM_RUNTIME_DIRECTORY = "vendor/qpdf-wasm/runtime";
export const QPDF_WASM_RUNTIME_PROVENANCE_PATH = "vendor/qpdf-wasm/runtime.provenance.json";

export const QPDF_WASM_RUNTIME_PROVENANCE = Object.freeze(JSON.parse(readFileSync(
  path.join(REPO_ROOT, ...QPDF_WASM_RUNTIME_PROVENANCE_PATH.split("/")),
  "utf8",
)));

/*
 * Repository-relative paths, which are also the archive-relative paths in both
 * the MCPB and the share ZIP. Keeping the three identical means a load path
 * that works in the checkout works in the packaged tree unchanged.
 */
export const QPDF_WASM_RUNTIME_ASSETS = Object.freeze(
  QPDF_WASM_RUNTIME_PROVENANCE.runtime_assets.files.map(asset => Object.freeze({
    path: asset.path,
    sha256: asset.sha256,
    size_bytes: asset.size_bytes,
  })),
);

export const QPDF_WASM_RUNTIME_FILES = Object.freeze(
  QPDF_WASM_RUNTIME_ASSETS.map(asset => asset.path),
);

/** The two files a consumer actually loads; the rest are notices and inputs. */
export const QPDF_WASM_RUNTIME_ENTRY_POINT = `${QPDF_WASM_RUNTIME_DIRECTORY}/qpdf.mjs`;
export const QPDF_WASM_RUNTIME_BINARY = `${QPDF_WASM_RUNTIME_DIRECTORY}/qpdf.wasm`;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Reads the runtime directory of `rootDir` and returns its inventory as
 * `{ path, sha256, size_bytes }` records using the same archive-relative paths
 * as the provenance. Used against the checkout, against a staged tree, and
 * against an unpacked archive.
 */
export function readQpdfWasmRuntimeInventory(rootDir) {
  const runtimeRoot = path.join(rootDir, ...QPDF_WASM_RUNTIME_DIRECTORY.split("/"));
  const inventory = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`QPDF WASM runtime contains a non-regular entry: ${absolutePath}`);
      }
      const bytes = readFileSync(absolutePath);
      inventory.push({
        path: `${QPDF_WASM_RUNTIME_DIRECTORY}/${
          path.relative(runtimeRoot, absolutePath).split(path.sep).join("/")
        }`,
        sha256: sha256(bytes),
        size_bytes: bytes.length,
      });
    }
  };
  walk(runtimeRoot);
  return inventory.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/**
 * Asserts that the QPDF WASM runtime under `rootDir` is exactly the reviewed
 * set of bytes: no missing file, no extra file, no drifted content. Throws
 * with the offending path rather than returning a boolean, because every
 * caller treats a mismatch as fatal.
 */
export function verifyQpdfWasmRuntime(rootDir = REPO_ROOT, label = "checkout") {
  const actual = readQpdfWasmRuntimeInventory(rootDir);
  const expected = [...QPDF_WASM_RUNTIME_ASSETS].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const actualByPath = new Map(actual.map(asset => [asset.path, asset]));
  for (const asset of expected) {
    const found = actualByPath.get(asset.path);
    if (!found) {
      throw new Error(`QPDF WASM runtime in the ${label} is missing ${asset.path}`);
    }
    if (found.size_bytes !== asset.size_bytes || found.sha256 !== asset.sha256) {
      throw new Error(
        `QPDF WASM runtime in the ${label} drifted at ${asset.path}: `
        + `expected ${asset.size_bytes}/${asset.sha256}, found ${found.size_bytes}/${found.sha256}`,
      );
    }
  }
  const expectedPaths = new Set(expected.map(asset => asset.path));
  const unexpected = actual.filter(asset => !expectedPaths.has(asset.path)).map(asset => asset.path);
  if (unexpected.length > 0) {
    throw new Error(`QPDF WASM runtime in the ${label} carries unreviewed files: ${unexpected.join(", ")}`);
  }
  return actual;
}
