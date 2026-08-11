#!/usr/bin/env node

/*
 * Regenerates the two committed records the npm half of the bill's licence
 * data is derived from:
 *
 *   vendor/npm-licenses/spdx-license-ids.json
 *     The SPDX licence identifiers CycloneDX validates `license.id` against,
 *     taken from the CycloneDX SPDX subschema itself. Using CycloneDX's own
 *     enumeration rather than the upstream SPDX list means every `license.id`
 *     this repository emits is valid against the schema by construction, and
 *     never merely valid against a newer list the schema has not caught up to.
 *
 *   vendor/npm-licenses/npm-license-provenance.json
 *     What each locked package declares about its own licence, read out of the
 *     exact registry tarball `package-lock.json` pins, after that tarball's
 *     bytes have been checked against the locked integrity digest. The
 *     installed tree is not consulted: it is a platform-dependent projection
 *     of the lock and is missing about a dozen packages on any one machine.
 *
 * Both files are generated, committed and verified — never hand-edited. The
 * verification lives in three places, on purpose:
 *
 *   - `verifyNpmLicenseProvenanceCoverage` runs inside the SBOM generator, so
 *     both shipped artifacts fail closed if the record does not cover the lock
 *     exactly, entry for entry, bound to the same tarballs.
 *   - `test/sbom-npm-licenses.test.js` re-reads the installed tree and
 *     re-derives what every present package declares, so a record that
 *     disagrees with the code on disk fails the gate.
 *   - The MCPB smoke and the share contract check the licences in the shipped
 *     artifact against the packages that shipped beside them.
 *
 * Usage: npm run vendor:npm-licenses
 */

import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyLicenseDeclaration,
  compareCodePoints,
  LICENSE_FILE_PATTERN,
  npmLicenseKey,
  packageNameFromLockPath,
} from "./npm-license-provenance.mjs";
import { fetchLockedTarballFiles } from "./npm-tarball.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const RECORD_DIR = path.join(REPO_ROOT, "vendor", "npm-licenses");
const SPDX_SUBSCHEMA_URL = "https://cyclonedx.org/schema/spdx.schema.json";
const EVIDENCE_BASIS =
  "Declared in the package.json inside the registry tarball that package-lock.json pins, after the "
  + "tarball bytes were verified against the locked integrity digest.";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeRecord(filename, value) {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote ${path.relative(REPO_ROOT, filename)}`);
}

async function vendorSpdxLicenseIds() {
  const response = await fetch(SPDX_SUBSCHEMA_URL);
  if (!response.ok) throw new Error(`SPDX subschema fetch failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const schema = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(schema.enum) || schema.enum.length < 400) {
    throw new Error("CycloneDX SPDX subschema did not supply a plausible licence enumeration");
  }
  const listVersion = typeof schema.$comment === "string" ? schema.$comment : null;
  if (!listVersion) throw new Error("CycloneDX SPDX subschema carries no version comment");
  writeRecord(path.join(RECORD_DIR, "spdx-license-ids.json"), {
    schema_version: "1.0",
    purpose:
      "The SPDX licence identifiers CycloneDX validates component `license.id` values against. Pinned "
      + "here so a `license.id` this repository emits is schema-valid by construction, and so the "
      + "gate can re-check that claim offline.",
    generated_by: "scripts/vendor-npm-license-provenance.mjs",
    source: {
      url: SPDX_SUBSCHEMA_URL,
      sha256: sha256(bytes),
      schema_id: schema.$id ?? null,
    },
    license_list_version: listVersion,
    ids: [...schema.enum].sort(compareCodePoints),
  });
}

/** Licence texts at the package root, which are evidence but never a licence. */
function licenseFilesFromTarball(files) {
  const found = [];
  for (const [entryPath, bytes] of files) {
    const parts = entryPath.split("/");
    if (parts.length !== 2 || parts[0] !== "package") continue;
    if (!LICENSE_FILE_PATTERN.test(parts[1])) continue;
    found.push({ path: parts[1], sha256: sha256(bytes) });
  }
  return found.sort((left, right) => compareCodePoints(left.path, right.path));
}

async function vendorNpmLicenseProvenance() {
  const lock = JSON.parse(readFileSync(path.join(REPO_ROOT, "package-lock.json"), "utf8"));
  /*
   * The production graph only. Development dependencies are never inside
   * either shipped artifact, so they owe no component and no licence entry;
   * a dev dependency that becomes a runtime one shows up here as a missing
   * entry and fails the coverage check until it is resolved.
   */
  const productionPackages = Object.entries(lock.packages)
    .filter(([packagePath, lockedPackage]) => packagePath !== "" && lockedPackage.dev !== true)
    .sort(([left], [right]) => compareCodePoints(left, right));

  const packages = {};
  for (const [packagePath, lockedPackage] of productionPackages) {
    const name = packageNameFromLockPath(packagePath);
    const key = npmLicenseKey(name, lockedPackage.version);
    if (packages[key]) continue;
    if (!lockedPackage.resolved || !lockedPackage.integrity) {
      throw new Error(`Locked package ${packagePath} has no registry tarball to read a licence from`);
    }
    const { files } = await fetchLockedTarballFiles(lockedPackage.resolved, lockedPackage.integrity);
    const manifestBytes = files.get("package/package.json");
    if (!manifestBytes) throw new Error(`Registry tarball for ${key} contains no package.json`);
    const { declaration, declared } = classifyLicenseDeclaration(JSON.parse(manifestBytes.toString("utf8")));
    packages[key] = {
      integrity: lockedPackage.integrity,
      tarball: lockedPackage.resolved,
      declaration,
      declared,
      license_files: licenseFilesFromTarball(files),
    };
    console.log(`  ${key}: ${declaration} ${JSON.stringify(declared)}`);
  }

  writeRecord(path.join(RECORD_DIR, "npm-license-provenance.json"), {
    schema_version: "1.0",
    purpose:
      "What every locked production package declares about its own licence, so the bill of materials "
      + "can state terms for all of them instead of only the ones package-lock.json happens to record "
      + "a `license` field for. Never hand-edited: regenerate with `npm run vendor:npm-licenses`.",
    generated_by: "scripts/vendor-npm-license-provenance.mjs",
    evidence_basis: EVIDENCE_BASIS,
    packages: Object.fromEntries(
      Object.keys(packages).sort(compareCodePoints).map(key => [key, packages[key]]),
    ),
  });
}

async function main() {
  await vendorSpdxLicenseIds();
  await vendorNpmLicenseProvenance();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`npm licence provenance generation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
