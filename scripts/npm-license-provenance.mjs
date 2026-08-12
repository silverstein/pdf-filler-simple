/*
 * The licence half of the npm bill of materials.
 *
 * `SBOM.cdx.json` used to attach a licence to a component only when
 * `package-lock.json` happened to carry a `license` field, which it does for
 * fewer than half of the locked packages. The other two thirds were named,
 * versioned, hashed — and silent about their terms. An inventory that cannot
 * say what most of its contents are licensed under is not an inventory anyone
 * can act on, and it shipped in both the MCPB and the share ZIP.
 *
 * WHY A COMMITTED RECORD RATHER THAN A LOOKUP AT PACKAGING TIME
 *
 * The obvious fix is to read `node_modules/<pkg>/package.json` while
 * packaging. It cannot work, for two independent reasons:
 *
 *   - The installed tree is a platform-dependent projection of the lock. Of
 *     the locked packages, the `@napi-rs/canvas-*` targets install only on
 *     their own `os`/`cpu`, so on any single machine roughly ten of them are
 *     absent. A bill derived from the installed tree would be missing
 *     different components depending on who built it, and would silently
 *     differ between a macOS release build and a Linux one.
 *
 *   - The share contract packages from an isolated build root that has no
 *     `node_modules` at all, deliberately: it proves the packager works from
 *     committed inputs. Reading an installed tree there is not incidental,
 *     it is the property the contract exists to establish.
 *
 * So the evidence is resolved once, from the exact registry tarballs the lock
 * pins — verified against their locked integrity digests before being read —
 * and committed to `vendor/npm-licenses/npm-license-provenance.json` by
 * `scripts/vendor-npm-license-provenance.mjs`. That record is keyed by
 * name and version and bound to the locked integrity, so it cannot describe a
 * different package than the one that ships. This is the same shape as the
 * native half of the bill, which derives from
 * `vendor/qpdf-wasm/runtime.provenance.json`.
 *
 * WHAT IS NEVER DONE
 *
 * A licence is never inferred. If a package declares one, that declaration is
 * reported and marked `acknowledgement: "declared"`. If it does not, the
 * component says `NOASSERTION` and a property states exactly what was looked
 * for and what was found — including any licence text that ships without
 * naming an identifier. Reading a LICENSE file and concluding "this looks like
 * MIT" is precisely the guess that makes a bill of materials worse than no
 * bill of materials, because a wrong licence will be believed.
 *
 * `license.id` is only ever used for a string that is in the pinned SPDX
 * licence list — the same enumeration the CycloneDX schema validates `id`
 * against. A compound declaration keeps its own operators as an `expression`;
 * anything that cannot be validated against the pinned list is reported as a
 * `license.name`, which asserts nothing about SPDX.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RECORD_DIR = path.join(SCRIPT_DIR, "..", "vendor", "npm-licenses");
export const SPDX_LICENSE_IDS_PATH = path.join(RECORD_DIR, "spdx-license-ids.json");
export const NPM_LICENSE_PROVENANCE_PATH = path.join(RECORD_DIR, "npm-license-provenance.json");

/** Filenames at a package root that carry licence text rather than declare it. */
export const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying|notice|unlicense)(\.[a-z0-9.-]+)?$/i;

/** The declaration shapes npm has used across its history. */
export const DECLARATION_LICENSE_STRING = "license-string";
export const DECLARATION_LICENSE_OBJECT = "license-object";
export const DECLARATION_LICENSES_ARRAY = "licenses-array";
export const DECLARATION_NONE = "none";

const SPDX_OPERATORS = new Set(["AND", "OR", "WITH"]);
const LICENSE_REF = /^(DocumentRef-[A-Za-z0-9.+-]+:)?LicenseRef-[A-Za-z0-9.+-]+$/;

/*
 * Loaded on first use rather than at import, because
 * `scripts/vendor-npm-license-provenance.mjs` imports the classifier below in
 * order to write these very files, and a module that cannot be imported until
 * its own output exists cannot generate it.
 */
const loaded = new Map();
function readJsonOnce(filename, describe) {
  if (!loaded.has(filename)) {
    try {
      loaded.set(filename, Object.freeze(JSON.parse(readFileSync(filename, "utf8"))));
    } catch (error) {
      throw new Error(`${describe} is unreadable at ${filename}: ${error.message}`);
    }
  }
  return loaded.get(filename);
}

export function spdxLicenseList() {
  const list = readJsonOnce(SPDX_LICENSE_IDS_PATH, "The pinned SPDX licence list");
  if (!Array.isArray(list.ids) || list.ids.length < 400) {
    throw new Error(`Pinned SPDX licence list is too small to be the real one: ${list.ids?.length}`);
  }
  return list;
}

export function npmLicenseProvenance() {
  const record = readJsonOnce(NPM_LICENSE_PROVENANCE_PATH, "The committed npm licence evidence");
  if (!record.packages || typeof record.packages !== "object") {
    throw new Error("Committed npm licence evidence carries no package records");
  }
  return record;
}

let spdxIds = null;
function spdxIdSet() {
  if (!spdxIds) spdxIds = new Set(spdxLicenseList().ids);
  return spdxIds;
}

export function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** `name@version`, the only key under which licence evidence is recorded. */
export function npmLicenseKey(name, version) {
  return `${name}@${version}`;
}

export function packageNameFromLockPath(packagePath) {
  const nestedMarker = "/node_modules/";
  const nestedIndex = packagePath.lastIndexOf(nestedMarker);
  return nestedIndex >= 0
    ? packagePath.slice(nestedIndex + nestedMarker.length)
    : packagePath.replace(/^node_modules\//, "");
}

/** A single SPDX licence identifier, with the `+` later-version suffix allowed. */
export function isSpdxLicenseId(value) {
  if (typeof value !== "string" || value === "") return false;
  if (LICENSE_REF.test(value)) return true;
  const bare = value.endsWith("+") ? value.slice(0, -1) : value;
  return spdxIdSet().has(bare);
}

/**
 * Whether a declared string is a well-formed SPDX expression over the pinned
 * licence list. Deliberately strict: a string this cannot prove is SPDX is
 * reported as a licence *name*, which claims nothing, rather than as an
 * identifier or expression, which claims a great deal.
 */
export function isSpdxLicenseExpression(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  const tokens = value.replace(/([()])/g, " $1 ").split(/\s+/).filter(Boolean);
  let index = 0;
  const parseExpression = () => {
    if (!parseOperand()) return false;
    while (index < tokens.length && SPDX_OPERATORS.has(tokens[index])) {
      index += 1;
      if (!parseOperand()) return false;
    }
    return true;
  };
  const parseOperand = () => {
    const token = tokens[index];
    if (token === undefined) return false;
    if (token === "(") {
      index += 1;
      if (!parseExpression()) return false;
      if (tokens[index] !== ")") return false;
      index += 1;
      return true;
    }
    if (token === ")" || SPDX_OPERATORS.has(token)) return false;
    if (!isSpdxLicenseId(token)) return false;
    index += 1;
    return true;
  };
  return parseExpression() && index === tokens.length;
}

/**
 * Reduces a package manifest to the licence declaration it actually makes.
 * Shared by the record generator, which reads the pinned tarball, and by the
 * test that re-reads the installed tree, so the two sides classify identically
 * and can only disagree about the underlying data.
 */
export function classifyLicenseDeclaration(packageJson) {
  // An empty legacy array declares nothing, so it is nothing — not an empty
  // `licenses` list in the bill, which would read as a generator that stopped
  // halfway.
  if (Array.isArray(packageJson?.licenses) && packageJson.licenses.length > 0) {
    return { declaration: DECLARATION_LICENSES_ARRAY, declared: packageJson.licenses };
  }
  const declared = packageJson?.license;
  if (typeof declared === "string" && declared.trim() !== "") {
    return { declaration: DECLARATION_LICENSE_STRING, declared: declared.trim() };
  }
  if (declared && typeof declared === "object" && typeof declared.type === "string") {
    return { declaration: DECLARATION_LICENSE_OBJECT, declared };
  }
  return { declaration: DECLARATION_NONE, declared: null };
}

function property(name, value) {
  return { name: `pdf-tools:${name}`, value };
}

function notSpdxSuffix() {
  return `could not be validated against the pinned SPDX licence list `
    + `${spdxLicenseList().license_list_version}, so it is recorded as a licence name and no SPDX `
    + "identity is asserted";
}

/**
 * One declared licence string to a CycloneDX licence entry. An identifier the
 * pinned list knows becomes `license.id`; a compound the pinned list can parse
 * keeps its own operators as an `expression`; anything else becomes
 * `license.name`, which claims nothing.
 */
export function licenseEntryForDeclaredString(value, url) {
  const licenseUrl = typeof url === "string" && /^https?:\/\//.test(url) ? { url } : {};
  if (isSpdxLicenseId(value)) {
    return {
      entry: { license: { id: value, acknowledgement: "declared", ...licenseUrl } },
      basis: `SPDX licence identifier ${value} declared by the package itself`,
    };
  }
  if (isSpdxLicenseExpression(value)) {
    return {
      entry: { expression: value, acknowledgement: "declared" },
      basis: `SPDX licence expression declared by the package itself; its own operators are preserved `
        + "rather than reduced to one side of the choice",
    };
  }
  return {
    entry: { license: { name: value, acknowledgement: "declared", ...licenseUrl } },
    basis: `declared licence string ${JSON.stringify(value)} ${notSpdxSuffix()}`,
  };
}

function licenseFileProperties(entry) {
  return (entry.license_files || []).map(file =>
    property("npm-license-file", `${file.path} sha256:${file.sha256}`));
}

/**
 * The `licenses` array and the supporting properties for one npm component,
 * derived entirely from the committed record. Always returns a licence entry:
 * a component that declares nothing says `NOASSERTION` explicitly rather than
 * leaving the field off, because an absent field cannot be told apart from a
 * generator that forgot to look.
 */
export function deriveNpmComponentLicensing(name, version, provenance = npmLicenseProvenance()) {
  const key = npmLicenseKey(name, version);
  const entry = provenance.packages[key];
  if (!entry) {
    throw new Error(
      `No licence evidence is recorded for ${key}. Run \`npm run vendor:npm-licenses\` so the `
      + "committed record covers every locked package, and review the result.",
    );
  }
  const properties = [
    property("npm-license-evidence", provenance.evidence_basis),
    ...licenseFileProperties(entry),
  ];
  if (entry.declaration === DECLARATION_LICENSE_STRING) {
    const { entry: licenseEntry, basis } = licenseEntryForDeclaredString(entry.declared);
    return { licenses: [licenseEntry], properties: [property("npm-license-basis", basis), ...properties] };
  }
  if (entry.declaration === DECLARATION_LICENSE_OBJECT) {
    const { entry: licenseEntry, basis } = licenseEntryForDeclaredString(entry.declared.type, entry.declared.url);
    return {
      licenses: [licenseEntry],
      properties: [
        property(
          "npm-license-basis",
          `${basis}; declared through the legacy \`license\` object form`,
        ),
        ...properties,
      ],
    };
  }
  if (entry.declaration === DECLARATION_LICENSES_ARRAY) {
    /*
     * The legacy `licenses` array states a set, never a relationship: it does
     * not say whether the terms apply together or as a choice. Emitting an
     * SPDX expression here would mean inventing an AND or an OR, and picking
     * one of them is picking someone's compliance obligation for them, so each
     * declared licence is listed on its own and the silence is reported.
     */
    const declaredEntries = entry.declared.map(declared =>
      licenseEntryForDeclaredString(
        typeof declared === "string" ? declared : declared.type,
        typeof declared === "string" ? undefined : declared.url,
      ));
    if (declaredEntries.some(({ entry: licenseEntry }) => licenseEntry.expression)) {
      throw new Error(
        `Legacy \`licenses\` array for ${key} contains a compound expression, which the array form `
        + "cannot express unambiguously. Resolve it by hand and review the result.",
      );
    }
    return {
      licenses: declaredEntries.map(({ entry: licenseEntry }) => licenseEntry),
      properties: [
        property(
          "npm-license-basis",
          "declared through the legacy `licenses` array, which lists licences without saying whether "
          + "they apply together or as a choice; each is listed separately and no SPDX expression is "
          + "asserted on the package's behalf",
        ),
        ...properties,
      ],
    };
  }
  const shipped = (entry.license_files || []).map(file => file.path);
  return {
    /*
     * CycloneDX validates `license.id` against the SPDX enumeration, and
     * NOASSERTION is not in it, so the explicit statement belongs in
     * `license.name`. Omitting `licenses` entirely would be the other way to
     * express this, but silence reads as an oversight and this does not.
     */
    licenses: [{ license: { name: "NOASSERTION" } }],
    properties: [
      property(
        "npm-license-basis",
        shipped.length > 0
          ? "the pinned registry tarball declares no licence in its own package.json; it ships licence "
            + `text at ${shipped.join(", ")}, but text does not name an identifier and one is not `
            + "inferred from it, so no licence is asserted"
          : "the pinned registry tarball declares no licence in its own package.json and ships no "
            + "licence file, so no licence is asserted",
      ),
      ...properties,
    ],
  };
}

/**
 * Fails unless the committed record covers exactly the locked graph, entry for
 * entry, each bound to the same tarball the lock pins. This is the check that
 * turns "a dependency was added, removed or bumped" into a build failure
 * rather than into a component with no licence.
 */
export function verifyNpmLicenseProvenanceCoverage(lock, provenance = npmLicenseProvenance()) {
  const expected = new Map();
  for (const [packagePath, lockedPackage] of Object.entries(lock.packages || {})) {
    if (packagePath === "") continue;
    const key = npmLicenseKey(packageNameFromLockPath(packagePath), lockedPackage.version);
    expected.set(key, lockedPackage);
  }
  const recorded = new Set(Object.keys(provenance.packages || {}));
  const missing = [...expected.keys()].filter(key => !recorded.has(key)).sort(compareCodePoints);
  const extra = [...recorded].filter(key => !expected.has(key)).sort(compareCodePoints);
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      "Committed npm licence evidence does not cover the locked graph; "
      + `missing=${JSON.stringify(missing)}, extra=${JSON.stringify(extra)}. `
      + "Run `npm run vendor:npm-licenses` and review the result.",
    );
  }
  for (const [key, lockedPackage] of expected) {
    const entry = provenance.packages[key];
    if (entry.integrity !== lockedPackage.integrity) {
      throw new Error(
        `Recorded npm licence evidence for ${key} was resolved from a different tarball than the lock `
        + `pins: ${entry.integrity} != ${lockedPackage.integrity}.`,
      );
    }
    if (lockedPackage.resolved && entry.tarball !== lockedPackage.resolved) {
      throw new Error(
        `Recorded npm licence evidence for ${key} names a different registry URL than the lock: `
        + `${entry.tarball} != ${lockedPackage.resolved}.`,
      );
    }
    if (lockedPackage.license && entry.declaration === DECLARATION_LICENSE_STRING
        && entry.declared !== lockedPackage.license) {
      throw new Error(
        `Recorded npm licence evidence for ${key} disagrees with the licence the lock itself records: `
        + `${JSON.stringify(entry.declared)} != ${JSON.stringify(lockedPackage.license)}.`,
      );
    }
  }
  return true;
}
