/**
 * Claude Desktop extension identity and legacy-install discovery.
 *
 * Claude Desktop derives an installation directory name for each extension. Two
 * forms have been observed for this project on a real macOS host:
 *
 *   local.mcpb.<author-slug>.<manifest-name>   a locally installed .mcpb
 *   ant.dir.gh.<publisher>.<listing-name>      a Directory installation
 *
 * These identities are assigned by the host, not by us, so the derivation below
 * is an inference from observed installs rather than a documented contract.
 * Everything that matters operationally therefore works by *discovery*: we glob
 * for installed directories that belong to this project and report all of them.
 * The derived identity is used to label the expected one, never to assume the
 * others do not exist.
 *
 * That distinction is the whole point of this module. Installing the current
 * MCPB created `local.mcpb.open-document-alliance.pdf-toolkit` alongside the
 * pre-existing Directory install `ant.dir.gh.silverstein.pdf-filler-simple`
 * rather than replacing it, and both were announced to the host until the
 * legacy settings entry was disabled. Tooling that hard-codes a single expected
 * identity silently reports "clean install" while a second copy of the
 * extension is still live, which makes a duplicate mixed-ID state look like a
 * successful upgrade.
 */

import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Host directory holding installed Claude Desktop extensions (macOS). */
export function claudeExtensionsDirectory(home = os.homedir()) {
  return path.join(home, "Library", "Application Support", "Claude", "Claude Extensions");
}

/**
 * Slugify an author name the way the observed local install ID does.
 * "Open Document Alliance" -> "open-document-alliance"
 */
export function authorSlug(authorName) {
  return String(authorName ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Expected local-MCPB installation identity for a manifest. */
export function expectedLocalExtensionId(manifest) {
  const slug = authorSlug(manifest?.author?.name);
  if (!slug) throw new Error("manifest.author.name is required to derive the extension identity");
  if (!manifest?.name) throw new Error("manifest.name is required to derive the extension identity");
  return `local.mcpb.${slug}.${manifest.name}`;
}

/**
 * Identities known to belong to this project but no longer current.
 *
 * `ant.dir.gh.silverstein.pdf-filler-simple` is the original Directory listing,
 * published before the Open Document Alliance stewardship and under the earlier
 * product name. `local.mcpb.mat-silverstein.pdf-toolkit` is a local install
 * produced while the manifest still carried the previous author, and it is the
 * identity this repository's reinstall helper hard-coded until 2026-07-25.
 */
export const KNOWN_LEGACY_EXTENSION_IDS = Object.freeze([
  "ant.dir.gh.silverstein.pdf-filler-simple",
  "local.mcpb.mat-silverstein.pdf-toolkit",
]);

/**
 * Does an installed directory name plausibly belong to this project?
 *
 * Matches the current identity, any known legacy identity, and anything whose
 * final segment equals the manifest name, so a host identity scheme we have not
 * seen still surfaces instead of hiding.
 */
export function belongsToProject(directoryName, manifest, legacyIds = KNOWN_LEGACY_EXTENSION_IDS) {
  if (legacyIds.includes(directoryName)) return true;
  let expected = null;
  try {
    expected = expectedLocalExtensionId(manifest);
  } catch {
    expected = null;
  }
  if (expected && directoryName === expected) return true;
  return Boolean(manifest?.name) && directoryName.endsWith(`.${manifest.name}`);
}

/** Classify one installed directory name relative to the current manifest. */
export function classifyInstall(directoryName, manifest) {
  let expected = null;
  try {
    expected = expectedLocalExtensionId(manifest);
  } catch {
    expected = null;
  }
  if (expected && directoryName === expected) return "current";
  if (KNOWN_LEGACY_EXTENSION_IDS.includes(directoryName)) return "legacy";
  return "unrecognized";
}

/**
 * Discover every installed directory belonging to this project.
 *
 * Returns all of them, deliberately. A caller that wants a clean-upgrade check
 * must decide what to do about extras rather than being handed only the one it
 * expected.
 */
export async function discoverInstalls({ manifest, extensionsDirectory } = {}) {
  const root = extensionsDirectory ?? claudeExtensionsDirectory();
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { extensions_directory: root, present: false, installs: [] };
    throw error;
  }
  const installs = entries
    .filter(entry => entry.isDirectory() && belongsToProject(entry.name, manifest))
    .map(entry => ({
      id: entry.name,
      path: path.join(root, entry.name),
      classification: classifyInstall(entry.name, manifest),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return { extensions_directory: root, present: true, installs };
}

/**
 * Is this a clean single-identity state?
 *
 * False whenever a legacy or unrecognized install coexists with the current
 * one, which is precisely the condition that must not be reported as a
 * successful upgrade.
 */
export function summarizeUpgradeState(installs) {
  const current = installs.filter(i => i.classification === "current");
  const legacy = installs.filter(i => i.classification === "legacy");
  const unrecognized = installs.filter(i => i.classification === "unrecognized");
  return {
    current_count: current.length,
    legacy_count: legacy.length,
    unrecognized_count: unrecognized.length,
    duplicate_identities: installs.length > 1,
    clean: installs.length <= 1 && legacy.length === 0 && unrecognized.length === 0,
  };
}

// CLI: print discovered installs as JSON so shell tooling can consume it.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const manifestPath = process.argv.includes("--manifest")
    ? process.argv[process.argv.indexOf("--manifest") + 1]
    : path.join(path.dirname(new URL(import.meta.url).pathname), "..", "manifest.json");
  const manifest = JSON.parse(fsSync.readFileSync(manifestPath, "utf8"));
  const discovered = await discoverInstalls({ manifest });
  process.stdout.write(`${JSON.stringify({
    expected_id: expectedLocalExtensionId(manifest),
    ...discovered,
    summary: summarizeUpgradeState(discovered.installs),
  }, null, 2)}\n`);
}
