// Report whether the published Agent Plugin is missing changes that ship in it.
//
// Publishing is a manual step (`npm run publish:plugin`), so the distribution
// repository silently lags this one until someone remembers. That is not
// hypothetical: #125 bounded decoded object-stream size, merged, and the
// published plugin kept serving the unfixed server until the drift was noticed
// by chance while checking something unrelated.
//
// The naive check, "is the published commit equal to HEAD", would fail after
// every merge and teach everyone to ignore it. So this compares only the paths
// that actually end up inside the plugin. A test-only commit leaves the
// published bytes correct and this stays quiet; a change under server/ or
// dist-ui/ does not, and this says so.
//
// The set of shipped paths is the whole discriminating power of this check, so
// it lives in scripts/plugin-shipped-paths.mjs where a test can bind it to what
// the builders actually copy. Do not reintroduce a private copy here.
//
// Usage: node scripts/check-plugin-freshness.mjs
// Exit 0 when the published plugin carries every shipped change, 1 when it does
// not, 2 when the answer could not be determined.

import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

import { shipsInPlugin } from "./plugin-shipped-paths.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Read through the API rather than raw.githubusercontent.com. The raw host is
// CDN-cached and served a commit five behind for minutes after a correct
// publish, so the first version of this check called a freshly published plugin
// stale. A checker that cries wolf right after the action it is meant to
// confirm is worse than no checker.
const PROVENANCE_API =
  "https://api.github.com/repos/Open-Document-Alliance/pdf-tools-plugin/contents/PROVENANCE.md";
const PROVENANCE_RAW =
  "https://raw.githubusercontent.com/Open-Document-Alliance/pdf-tools-plugin/main/PROVENANCE.md";

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

async function readPublishedProvenance() {
  try {
    const response = await fetch(PROVENANCE_API, {
      headers: { accept: "application/vnd.github.raw", "user-agent": "pdf-tools-freshness" },
    });
    if (response.ok) return await response.text();
    console.error(`[freshness] API returned ${response.status}; falling back to the raw host.`);
  } catch (error) {
    console.error(`[freshness] API unreachable (${error.message}); falling back to the raw host.`);
  }
  // The fallback may be stale by minutes. Say so rather than reporting a
  // confident wrong answer.
  console.error("[freshness] NOTE: the raw host is CDN-cached; a very recent publish may still read as stale.");
  return await (await fetch(PROVENANCE_RAW)).text();
}

let provenance;
try {
  provenance = await readPublishedProvenance();
} catch (error) {
  console.error(`[freshness] could not read published provenance: ${error.message}`);
  console.error("[freshness] cannot determine freshness; not treating that as fresh.");
  process.exit(2);
}

const published = /\/commit\/([0-9a-f]{40})/.exec(provenance)?.[1];
if (!published) {
  console.error("[freshness] published PROVENANCE.md has no source commit; cannot compare.");
  process.exit(2);
}

const head = git(["rev-parse", "HEAD"]);
if (published === head) {
  console.error(`[freshness] published plugin is built from HEAD (${head.slice(0, 8)}).`);
  process.exit(0);
}

// The published commit must be an ancestor, otherwise the comparison below is
// meaningless and the plugin may be built from something not in this history.
try {
  git(["merge-base", "--is-ancestor", published, head]);
} catch {
  console.error(
    `[freshness] published commit ${published.slice(0, 8)} is not an ancestor of HEAD. `
    + "The plugin may be built from a different history; check manually.",
  );
  process.exit(2);
}

const changed = git(["diff", "--name-only", `${published}..${head}`])
  .split("\n")
  .filter(Boolean)
  .filter(shipsInPlugin);

if (changed.length === 0) {
  const behind = git(["rev-list", "--count", `${published}..${head}`]);
  console.error(
    `[freshness] published plugin is ${behind} commit(s) behind, but none of them `
    + "change files that ship in it. Nothing to publish.",
  );
  process.exit(0);
}

console.error(
  `[freshness] STALE: the published plugin is missing ${changed.length} shipped file change(s) `
  + `since ${published.slice(0, 8)}:`,
);
for (const file of changed.slice(0, 20)) console.error(`  ${file}`);
if (changed.length > 20) console.error(`  ... and ${changed.length - 20} more`);
console.error("");
console.error("Anyone installing the plugin right now receives the older build.");
console.error("Publish with: npm run publish:plugin -- <plugin-repo-checkout> --push");
process.exit(1);
