// Publish the built Agent Plugin to its distribution repository.
//
// The plugin is distributed by cloning a Git repository, because the Agent
// Plugins standard defines no registry and no install lifecycle. That makes
// publishing a separate act from building, and a separate act that someone has
// to remember is one that eventually gets skipped: the distribution repo would
// keep serving an old version while the source repo moved on, with nothing
// failing to say so.
//
// Usage:
//   node scripts/publish-agent-plugin.mjs <path-to-pdf-tools-plugin-checkout> [--push]
//
// Without --push it stages and commits nothing; it reports what would change.
// The push is opt-in so this can run in a release rehearsal without publishing.

import { cpSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { derivePluginVersion } from "./plugin-version.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const BUILT_PLUGIN = path.join(REPO_ROOT, "dist-plugin", "pdf-tools");

const target = process.argv[2];
const shouldPush = process.argv.includes("--push");

if (!target) {
  console.error("usage: node scripts/publish-agent-plugin.mjs <plugin-repo-checkout> [--push]");
  process.exit(2);
}

const repo = path.resolve(target);
const destination = path.join(repo, "plugins", "pdf-tools");

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", ...options }).trim();
}

if (!existsSync(path.join(repo, ".git"))) {
  console.error(`[publish] not a git checkout: ${repo}`);
  process.exit(1);
}
if (!existsSync(BUILT_PLUGIN)) {
  console.error(`[publish] no built plugin at ${BUILT_PLUGIN}. Run: npm run build:plugin`);
  process.exit(1);
}

// Refuse to publish a build whose version disagrees with this source tree.
// A stale dist-plugin is the exact failure this script exists to prevent, so it
// must not be the thing that quietly ships.
const sourceVersion = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version;
const builtVersion = JSON.parse(readFileSync(path.join(BUILT_PLUGIN, "plugin.json"), "utf8")).version;

// Derive the version the builder would write *right now*, from this tree, and
// require the built plugin to carry exactly that.
//
// Checking the parts separately looks stricter and is not. Comparing only the
// release component and then the embedded commit leaves every version that
// carries no embedded commit unchecked, and three different trees produce one:
// a build made at a tag, a build in a checkout with no tags, and a build where
// `git describe` could not run. Measured on 2026-08-15 against this script at
// dc90e75: a `dist-plugin` built at v0.11.0 and published from master two
// commits later was accepted, and PROVENANCE.md recorded those tag-built bytes
// as "Built from dc90e753…". That record is the only thing identifying what the
// distribution repo serves, and check-plugin-freshness.mjs reads the same
// commit back to decide whether the publish is current — so one unchecked shape
// makes both of them confidently wrong.
//
// Equality against the derived version subsumes both old checks: a release
// mismatch, a foreign commit, a truncated commit and a bare version all differ
// from what this tree would produce. It does not reintroduce the equality bug
// that made this refuse every publish hourly, because the comparison is against
// the derived version and not against package.json: a freshly built plugin
// matches by construction.
const expected = derivePluginVersion(sourceVersion, { cwd: REPO_ROOT });

// Fail closed where the version cannot identify a commit at all. Publishing
// under one of these writes a PROVENANCE.md that claims a commit the bytes are
// not known to come from.
if (expected.shape === "unavailable") {
  console.error(
    `[publish] cannot verify what this tree is: git describe did not run here. ` +
      `A depth-1 clone needs fetch-depth: 0.`,
  );
  process.exit(1);
}
if (expected.shape === "untagged") {
  console.error(
    `[publish] no tag is reachable from HEAD (git describe says ${expected.described}), so a ` +
      `plugin version cannot identify the build. Fetch tags with: git fetch --tags`,
  );
  process.exit(1);
}
if (expected.dirty) {
  console.error(
    `[publish] this tree has uncommitted changes (git describe says ${expected.described}), so ` +
      `the published bytes would belong to no commit while PROVENANCE.md names one. ` +
      `Commit or stash first.`,
  );
  process.exit(1);
}

if (builtVersion !== expected.version) {
  console.error(
    `[publish] built plugin is ${builtVersion} but this tree builds ${expected.version}. ` +
      `Rebuild with: npm run build:plugin`,
  );
  process.exit(1);
}

const dirty = git(["status", "--porcelain"]);
if (dirty) {
  console.error(`[publish] the plugin repo has uncommitted changes; resolve them first:\n${dirty}`);
  process.exit(1);
}

console.error(`[publish] syncing ${builtVersion} into ${destination}`);
rmSync(destination, { recursive: true, force: true });
cpSync(BUILT_PLUGIN, destination, { recursive: true });

// Record which source commit produced these bytes.
//
// The plugin's version comes from package.json, so a packaging fix landing
// after a release republishes under an unchanged version number. Both QA hosts
// were caught this week running an extension whose manifest read the shipping
// version while lacking a module the shipping artifact contained, so a version
// check reported success and was wrong. A version string cannot identify bytes
// that can be rebuilt beneath it; this file can.
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const sourceDescribe = execFileSync("git", ["describe", "--tags", "--always", "--dirty"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).trim();
writeFileSync(
  path.join(repo, "PROVENANCE.md"),
  `# Provenance\n\nThe contents of \`plugins/pdf-tools\` are generated. Do not edit them here.\n\n` +
    `| | |\n|---|---|\n` +
    `| Plugin version | \`${builtVersion}\` |\n` +
    `| Built from | [\`${sourceCommit}\`](https://github.com/Open-Document-Alliance/PDF-Tools/commit/${sourceCommit}) |\n` +
    `| Source describes as | \`${sourceDescribe}\` |\n\n` +
    `The version field comes from the source \`package.json\`, so a packaging fix that lands after a ` +
    `release is republished under an unchanged version number. **Identify a build by the commit above, ` +
    `not by its version string.** If \`Source describes as\` is not exactly a tag, this build contains ` +
    `work that came after that release.\n\n` +
    `Regenerate with \`npm run build:plugin\` and publish with \`npm run publish:plugin -- <checkout> --push\`.\n`,
);

git(["add", "-A"]);
const staged = git(["status", "--porcelain"]);
if (!staged) {
  console.error(`[publish] distribution repo already matches ${builtVersion}; nothing to publish.`);
  process.exit(0);
}

const changedFiles = git(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean).length;
console.error(`[publish] ${changedFiles} file(s) changed`);

if (!shouldPush) {
  // `git reset` alone unstages but leaves the synced files in the working tree,
  // which makes the next run refuse on a dirty repo. A hard reset is safe here
  // only because the clean check above already refused to start on a dirty one.
  git(["reset", "--hard"]);
  git(["clean", "-fd"]);
  console.error("[publish] dry run: working tree restored. Re-run with --push to publish.");
  process.exit(0);
}

git([
  "commit",
  "-m",
  `Publish v${builtVersion}\n\nGenerated by npm run build:plugin in Open-Document-Alliance/PDF-Tools.\nThis repository is a distribution channel; do not edit plugins/ by hand.`,
]);
git(["push", "origin", "HEAD"]);

// Repack before leaving. This repository is cloned in full every time a client
// adds the marketplace, and its objects are large: an unpacked history reached
// 89 MB of loose objects after 13 publishes, and a Codex CLI marketplace add
// timed out twice against it while a fast-forward pull took seconds. Packing
// cut that to 64 MB. Doing it here keeps the cost on the publisher rather than
// on every person installing.
try {
  git(["gc", "--quiet", "--prune=now"]);
} catch {
  // Repacking is an optimisation, not part of publishing. A failure here must
  // never make a successful publish look failed.
}
console.error(`[publish] published v${builtVersion} to ${git(["remote", "get-url", "origin"])}`);
