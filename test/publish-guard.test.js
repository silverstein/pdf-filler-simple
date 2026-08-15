// The publisher's staleness guard is the only thing standing between a stale
// `dist-plugin` and the distribution repository, and until this file it was read
// by no test on any platform.
//
// It is not enough to check that a correct publish succeeds. The guard's whole
// job is to refuse, so every case here drives the real script and asserts which
// way it went, and the negative cases carry version strings written out by hand
// rather than derived — a derivation would agree with the code under test by
// construction (L42's shape).
//
// Measured before the guard was repaired, at dc90e75: a `dist-plugin` built at
// v0.11.0 and published from master two commits later was accepted, and the
// PROVENANCE.md it wrote recorded those tag-built bytes as "Built from
// dc90e753…". check-plugin-freshness.mjs reads that same commit back to decide
// whether the published plugin is current, so the false record satisfied the
// only gate watching the distribution repo. Those cases are `refuses a build
// made at the tag …` and `records the commit it publishes from` below.

import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import { createHash } from "crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { pluginVersionFor } from "../scripts/plugin-version.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISHER = path.join(REPO_ROOT, "scripts", "publish-agent-plugin.mjs");
// The fixture source tree needs its own tags, commits and dirty states, so the
// scripts are copied into it rather than run from this checkout. That copy is
// the fidelity risk, so it is checked: a divergence here means these cases stop
// describing the script that ships.
const COPIED_SCRIPTS = ["publish-agent-plugin.mjs", "plugin-version.mjs"];
const FIXTURE_VERSION = "9.9.0";

const temporaryDirectories = [];

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  }).trim();
}

function temporaryDirectory(prefix) {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * A source tree that looks like this repository to the publisher: a package.json,
 * the two scripts, a reachable tag, and whatever history the case needs.
 *
 * `commitsPastTag` moves HEAD past the tag; `dirty` leaves a tracked file
 * modified; `tagged: false` builds a repository with no tag at all; `git: false`
 * removes the repository entirely.
 */
function sourceTree({ commitsPastTag = 0, dirty = false, tagged = true, git: withGit = true } = {}) {
  const root = temporaryDirectory("pdf-tools-publish-source-");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  for (const script of COPIED_SCRIPTS) {
    cpSync(path.join(REPO_ROOT, "scripts", script), path.join(root, "scripts", script));
    expect(sha256(path.join(root, "scripts", script))).toBe(sha256(path.join(REPO_ROOT, "scripts", script)));
  }
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: FIXTURE_VERSION }) + "\n");
  writeFileSync(path.join(root, "CHANGES.md"), "one\n");

  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "initial"]);
  if (tagged) git(root, ["tag", `v${FIXTURE_VERSION}`]);
  for (let i = 0; i < commitsPastTag; i += 1) {
    writeFileSync(path.join(root, "CHANGES.md"), `one\nlater ${i}\n`);
    git(root, ["commit", "-qam", `later ${i}`]);
  }
  if (dirty) writeFileSync(path.join(root, "CHANGES.md"), "edited but not committed\n");
  if (!withGit) rmSync(path.join(root, ".git"), { recursive: true, force: true });
  return root;
}

/** The version string this tree's build would write, read from the tree itself. */
function versionBuiltHere(root) {
  const described = git(root, ["describe", "--tags", "--always", "--dirty"]);
  return pluginVersionFor(FIXTURE_VERSION, described).version;
}

/** A fabricated `dist-plugin` carrying exactly the version under test. */
function builtPlugin(root, version) {
  const built = path.join(root, "dist-plugin", "pdf-tools");
  mkdirSync(built, { recursive: true });
  writeFileSync(path.join(built, "plugin.json"), JSON.stringify({ name: "pdf-tools", version }, null, 2) + "\n");
  writeFileSync(path.join(built, "PAYLOAD.txt"), `bytes for ${version}\n`);
  expect(JSON.parse(readFileSync(path.join(built, "plugin.json"), "utf8")).version).toBe(version);
}

/** A distribution repository seeded with content a sync would have to replace. */
function distributionRepo() {
  const root = temporaryDirectory("pdf-tools-publish-dist-");
  mkdirSync(path.join(root, "plugins", "pdf-tools"), { recursive: true });
  writeFileSync(path.join(root, "plugins", "pdf-tools", "STALE.txt"), "previously published\n");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "seed"]);
  return root;
}

/**
 * Run the real publisher. Never with --push: every case here is decided before
 * the push, and a dry run still performs the sync, so "would publish" is
 * observable without one.
 */
function publishOutcome(sourceRoot, distRoot) {
  // The publisher reports everything on stderr, including its successes.
  // spawnSync rather than execFileSync so a zero exit still yields stderr — the
  // success cases below are asserted on it, and execFileSync returns stdout only.
  const result = spawnSync(
    process.execPath,
    [path.join(sourceRoot, "scripts", "publish-agent-plugin.mjs"), distRoot],
    { cwd: sourceRoot, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  // A signal death has a null status and must not read as a clean exit.
  expect(result.signal, "publisher was killed by a signal").toBeNull();
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("agent plugin publish guard", () => {
  it("publishes a build made from this exact tree", () => {
    const source = sourceTree({ commitsPastTag: 2 });
    builtPlugin(source, versionBuiltHere(source));
    const outcome = publishOutcome(source, distributionRepo());

    // The control. Without it a guard that refused everything would pass every
    // other case in this file. It is also the regression that made this script
    // refuse every publish hourly until #163: a build correctly made past a tag
    // differs from package.json and must still be accepted.
    expect(outcome.code).toBe(0);
    expect(outcome.stderr).toContain("file(s) changed");
    expect(outcome.stderr).toContain("dry run: working tree restored");
  });

  it("publishes a build made at the tag from a tree still on that tag", () => {
    const source = sourceTree({ commitsPastTag: 0 });
    expect(versionBuiltHere(source)).toBe(FIXTURE_VERSION);
    builtPlugin(source, FIXTURE_VERSION);
    const outcome = publishOutcome(source, distributionRepo());

    // The release publish. A bare version is legitimate here precisely because
    // HEAD is the tag, which is what the case below does not have.
    expect(outcome.code).toBe(0);
    expect(outcome.stderr).toContain("dry run: working tree restored");
  });

  it("refuses a build made at the tag once the tree has moved past it", () => {
    const source = sourceTree({ commitsPastTag: 2 });
    builtPlugin(source, FIXTURE_VERSION);
    const outcome = publishOutcome(source, distributionRepo());

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain(`built plugin is ${FIXTURE_VERSION} but this tree builds`);
    expect(outcome.stderr).toContain("npm run build:plugin");
  });

  it("refuses a build whose embedded commit is not this tree's", () => {
    const source = sourceTree({ commitsPastTag: 2 });
    builtPlugin(source, `${FIXTURE_VERSION}+2.gdeadbee`);
    const outcome = publishOutcome(source, distributionRepo());

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("gdeadbee");
  });

  it("refuses a build whose embedded commit is a shorter prefix of this tree's", () => {
    const source = sourceTree({ commitsPastTag: 2 });
    const head = git(source, ["rev-parse", "HEAD"]);
    builtPlugin(source, `${FIXTURE_VERSION}+2.g${head.slice(0, 3)}`);
    const outcome = publishOutcome(source, distributionRepo());

    // A prefix comparison accepts this. The build it names cannot be identified
    // from three characters, so equality against the derived version is the
    // check, not `startsWith`.
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("this tree builds");
  });

  it("refuses a build from a different release", () => {
    const source = sourceTree({ commitsPastTag: 2 });
    builtPlugin(source, "9.8.0+2.gdeadbee");
    const outcome = publishOutcome(source, distributionRepo());

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("9.8.0+2.gdeadbee");
  });

  it("refuses to publish from a tree with uncommitted changes", () => {
    const source = sourceTree({ commitsPastTag: 2, dirty: true });
    // Even the version this dirty tree would itself build is refused: the bytes
    // belong to no commit, while PROVENANCE.md would name one.
    builtPlugin(source, versionBuiltHere(source));
    const outcome = publishOutcome(source, distributionRepo());

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("uncommitted changes");
    expect(outcome.stderr).toContain("PROVENANCE.md");
  });

  it("refuses to publish from a tree with no tag reachable", () => {
    const source = sourceTree({ tagged: false });
    // git describe --always falls back to a bare object name, which produces the
    // same bare version as sitting on a tag and identifies nothing.
    expect(versionBuiltHere(source)).toBe(FIXTURE_VERSION);
    builtPlugin(source, FIXTURE_VERSION);
    const outcome = publishOutcome(source, distributionRepo());

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("no tag is reachable");
  });

  it("refuses to publish from a tree where git describe cannot run", () => {
    const source = sourceTree({ git: false });
    builtPlugin(source, FIXTURE_VERSION);
    const outcome = publishOutcome(source, distributionRepo());

    // A depth-1 CI checkout lands here. The builder announces the fallback and
    // still writes a bare version; the publisher must not accept one.
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("git describe did not run");
  });

  it("refuses to publish into a distribution repo with uncommitted changes", () => {
    const source = sourceTree({ commitsPastTag: 2 });
    builtPlugin(source, versionBuiltHere(source));
    const dist = distributionRepo();
    writeFileSync(path.join(dist, "plugins", "pdf-tools", "STALE.txt"), "edited by hand\n");
    const outcome = publishOutcome(source, dist);

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("uncommitted changes");
  });

  it("records the commit it publishes from, and restores the dry-run tree", () => {
    const source = sourceTree({ commitsPastTag: 2 });
    builtPlugin(source, versionBuiltHere(source));
    const dist = distributionRepo();
    const outcome = publishOutcome(source, dist);
    expect(outcome.code).toBe(0);

    // A dry run restores, so PROVENANCE.md is gone again — the assertion that it
    // was written has to come from the run rather than from the tree.
    expect(outcome.stderr).toContain("file(s) changed");
    expect(git(dist, ["status", "--porcelain"])).toBe("");

    // The bytes it would have stamped: HEAD, which the cases above are what make
    // true. Without them a stale build reaches this line and the commit recorded
    // here belongs to a tree those bytes never came from.
    const head = git(source, ["rev-parse", "HEAD"]);
    expect(versionBuiltHere(source)).toContain(head.slice(0, 7));
  });
});

describe("plugin version grammar", () => {
  // The builder writes these strings and the publisher reads them back. One
  // grammar, imported by both, so the shapes are pinned here rather than in two
  // places that can drift.
  it("distinguishes the four trees that produce a bare version", () => {
    expect(pluginVersionFor("1.2.3", "v1.2.3")).toMatchObject({
      version: "1.2.3", shape: "tagged-exact", dirty: false, commit: null,
    });
    expect(pluginVersionFor("1.2.3", "v1.2.3-dirty")).toMatchObject({
      version: "1.2.3+dirty", shape: "tagged-exact", dirty: true,
    });
    expect(pluginVersionFor("1.2.3", "abc1234")).toMatchObject({
      version: "1.2.3", shape: "untagged", commit: null,
    });
    expect(pluginVersionFor("1.2.3", null)).toMatchObject({
      version: "1.2.3", shape: "unavailable", commit: null,
    });
  });

  it("carries the commit and the dirty marker past a tag", () => {
    expect(pluginVersionFor("1.2.3", "v1.2.3-94-g4953297")).toMatchObject({
      version: "1.2.3+94.g4953297", shape: "post-tag", dirty: false, commit: "4953297",
    });
    expect(pluginVersionFor("1.2.3", "v1.2.3-94-g4953297-dirty")).toMatchObject({
      version: "1.2.3+94.g4953297.dirty", shape: "post-tag", dirty: true, commit: "4953297",
    });
  });

  it("is the only reading of the grammar in the build and publish scripts", () => {
    // Two independent readings is how the builder and the publisher disagree
    // about what a version means, which is the defect this file was written for.
    for (const script of ["build-agent-plugin.mjs", "publish-agent-plugin.mjs"]) {
      const source = readFileSync(path.join(REPO_ROOT, "scripts", script), "utf8");
      const imports = source.match(/^import \{[^}]*\} from "\.\/plugin-version\.mjs";$/m);
      expect(imports, `${script} must import the shared version grammar`).not.toBeNull();
      expect(source, `${script} must not parse git describe output itself`)
        .not.toMatch(/-\(\\d\+\)-g/);
      expect(source, `${script} must not re-derive the version metadata separator`)
        .not.toMatch(/\\\+\\d\+\\\.g/);
    }
  });
});
