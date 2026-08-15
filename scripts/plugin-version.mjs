// The one place that knows how a plugin version encodes the tree it was built
// from.
//
// This grammar has two readers with opposite jobs: the builder writes a version
// into `plugin.json`, and the publisher has to decide from that string alone
// whether the built bytes belong to the tree it is about to stamp them with. A
// second, independent reading of the grammar is how the two drift apart, so
// there is one reading and both import it.
//
// The shape matters as much as the string. `0.11.0` is produced by a build made
// exactly at a tag, by a build in a checkout with no tags reachable, and by a
// build where `git describe` could not run at all — three different amounts of
// knowledge wearing one version number. A caller that needs to know which one it
// is asks for the shape, not for the string.

import { execFileSync } from "child_process";

// `git describe --tags --always --dirty` output, when at least one tag is
// reachable and HEAD is not that tag.
const DESCRIBE_SUFFIX = /-(\d+)-g([0-9a-f]+)(-dirty)?$/;
// `--always` falls back to a bare abbreviated object name when no tag is
// reachable. That has no commit count, so it reads exactly like sitting on a tag
// and must be told apart by shape rather than by the version it produces.
const BARE_OBJECT_NAME = /^[0-9a-f]{7,40}(-dirty)?$/;

/**
 * Run `git describe` in a working tree. Returns null when it cannot run at all
 * (no git binary, not a repository, a depth-1 CI clone with no history).
 */
export function describeTree(cwd) {
  try {
    return execFileSync("git", ["describe", "--tags", "--always", "--dirty"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Interpret one `git describe` output against a package version.
 *
 * `shape` is the field a caller should branch on:
 *   "post-tag"     - N commits past a tag; the version carries the commit.
 *   "tagged-exact" - HEAD is the tag; the version is bare but HEAD identifies it.
 *   "untagged"     - no tag reachable; the version is bare and identifies nothing.
 *   "unavailable"  - describe did not run; the version is bare and identifies nothing.
 */
export function pluginVersionFor(packageVersion, described) {
  if (described === null || described === undefined || described === "") {
    return { version: packageVersion, shape: "unavailable", dirty: false, commit: null };
  }
  const match = DESCRIBE_SUFFIX.exec(described);
  if (match) {
    const [, commitsSinceTag, sha, dirty] = match;
    return {
      version: `${packageVersion}+${commitsSinceTag}.g${sha}${dirty ? ".dirty" : ""}`,
      shape: "post-tag",
      dirty: Boolean(dirty),
      commit: sha,
    };
  }
  const dirty = described.endsWith("-dirty");
  return {
    version: dirty ? `${packageVersion}+dirty` : packageVersion,
    shape: BARE_OBJECT_NAME.test(described) ? "untagged" : "tagged-exact",
    dirty,
    commit: null,
  };
}

/**
 * The version the builder would write into `plugin.json` for the tree at `cwd`,
 * with the shape that produced it.
 *
 * `onUnavailable` is called instead of swallowing the failure, because a
 * depth-1 CI clone silently restoring the pre-build-metadata behaviour is the
 * regression this grammar exists to prevent.
 */
export function derivePluginVersion(packageVersion, { cwd, onUnavailable } = {}) {
  const described = describeTree(cwd);
  if (described === null && onUnavailable) onUnavailable();
  return { ...pluginVersionFor(packageVersion, described), described };
}
