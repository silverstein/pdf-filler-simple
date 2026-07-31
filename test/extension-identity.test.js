/**
 * Claude Desktop extension identity and legacy-install discovery
 * (bead pdf-toolkit-mcp-dwk.12).
 *
 * Installing the current MCPB does not replace the older Directory install, so
 * a host can end up announcing two copies of this extension at once. Tooling
 * that hard-codes one expected identity reports "clean install" while the other
 * copy is still live, which is how a duplicate mixed-ID state gets mistaken for
 * a successful upgrade.
 *
 * Verified against a real macOS host on 2026-07-25, which had exactly that
 * state: ant.dir.gh.silverstein.pdf-filler-simple alongside
 * local.mcpb.open-document-alliance.pdf-toolkit.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  KNOWN_LEGACY_EXTENSION_IDS,
  authorSlug,
  belongsToProject,
  classifyInstall,
  discoverInstalls,
  expectedLocalExtensionId,
  readExtensionEnabled,
  summarizeUpgradeState,
} from "../scripts/claude-extension-identity.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = JSON.parse(
  await fs.readFile(path.join(REPO_ROOT, "manifest.json"), "utf8"),
);

const temporaryRoots = [];
async function makeExtensionsDirectory(ids) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-extensions-")));
  temporaryRoots.push(root);
  for (const id of ids) await fs.mkdir(path.join(root, id), { recursive: true });
  return root;
}

afterEach(async () => {
  while (temporaryRoots.length) {
    await fs.rm(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

describe("extension identity derivation", () => {
  it("derives the identity observed on the real host", () => {
    // Ground truth: this exact directory exists on the maintainer's Mac.
    expect(expectedLocalExtensionId(MANIFEST)).toBe(
      "local.mcpb.open-document-alliance.pdf-toolkit",
    );
  });

  it("slugifies author names the way the host does", () => {
    expect(authorSlug("Open Document Alliance")).toBe("open-document-alliance");
    expect(authorSlug("Mat Silverstein")).toBe("mat-silverstein");
    expect(authorSlug("  Mixed   Case & Punctuation!  ")).toBe("mixed-case-punctuation");
  });

  it("refuses to guess an identity without the fields it is derived from", () => {
    expect(() => expectedLocalExtensionId({ name: "pdf-toolkit" })).toThrow(/author\.name/);
    expect(() => expectedLocalExtensionId({ author: { name: "X" } })).toThrow(/manifest\.name/);
  });

  it("tracks the identity the reinstall helper used to hard-code", () => {
    // scripts/reinstall.sh targeted this until 2026-07-25, so its removal step
    // silently no-opped and reported a clean install.
    expect(KNOWN_LEGACY_EXTENSION_IDS).toContain("local.mcpb.mat-silverstein.pdf-toolkit");
    expect(KNOWN_LEGACY_EXTENSION_IDS).toContain("ant.dir.gh.silverstein.pdf-filler-simple");
  });
});

describe("install classification", () => {
  it("separates current, legacy, and unrecognized identities", () => {
    expect(classifyInstall("local.mcpb.open-document-alliance.pdf-toolkit", MANIFEST)).toBe("current");
    expect(classifyInstall("ant.dir.gh.silverstein.pdf-filler-simple", MANIFEST)).toBe("legacy");
    expect(classifyInstall("local.mcpb.someone-else.pdf-toolkit", MANIFEST)).toBe("unrecognized");
  });

  it("claims an unknown identity that still ends in the manifest name", () => {
    // A host identity scheme we have not seen must surface rather than hide.
    expect(belongsToProject("future.scheme.whoever.pdf-toolkit", MANIFEST)).toBe(true);
  });

  it("does not claim unrelated extensions", () => {
    for (const other of [
      "ant.dir.ant.anthropic.filesystem",
      "ant.dir.gh.anthropic.pdf-server-mcp",
      "ant.dir.ant.anthropic.ms_office_word",
    ]) {
      expect(belongsToProject(other, MANIFEST)).toBe(false);
    }
  });
});

describe("upgrade state discovery", () => {
  it("reports the real host's duplicate state as not clean", async () => {
    const root = await makeExtensionsDirectory([
      "ant.dir.ant.anthropic.filesystem",
      "ant.dir.gh.anthropic.pdf-server-mcp",
      "ant.dir.gh.silverstein.pdf-filler-simple",
      "local.mcpb.open-document-alliance.pdf-toolkit",
    ]);
    const { installs } = await discoverInstalls({ manifest: MANIFEST, extensionsDirectory: root });
    expect(installs.map(i => i.id)).toEqual([
      "ant.dir.gh.silverstein.pdf-filler-simple",
      "local.mcpb.open-document-alliance.pdf-toolkit",
    ]);
    const summary = summarizeUpgradeState(installs);
    expect(summary).toMatchObject({
      current_count: 1,
      legacy_count: 1,
      duplicate_identities: true,
      clean: false,
    });
  });

  it("reports a single current install as clean", async () => {
    const root = await makeExtensionsDirectory([
      "ant.dir.ant.anthropic.filesystem",
      "local.mcpb.open-document-alliance.pdf-toolkit",
    ]);
    const { installs } = await discoverInstalls({ manifest: MANIFEST, extensionsDirectory: root });
    expect(summarizeUpgradeState(installs).clean).toBe(true);
  });

  it("treats a lone legacy install as not clean", async () => {
    // Pre-upgrade state: the Directory install alone still needs migrating.
    const root = await makeExtensionsDirectory(["ant.dir.gh.silverstein.pdf-filler-simple"]);
    const { installs } = await discoverInstalls({ manifest: MANIFEST, extensionsDirectory: root });
    expect(summarizeUpgradeState(installs)).toMatchObject({ legacy_count: 1, clean: false });
  });

  it("handles a host with no extensions directory", async () => {
    const result = await discoverInstalls({
      manifest: MANIFEST,
      extensionsDirectory: path.join(os.tmpdir(), "pdf-tools-absent-extensions-dir"),
    });
    expect(result).toMatchObject({ present: false, installs: [] });
  });
});

describe("reinstall helper", () => {
  it("no longer hard-codes a stale identity or display name", async () => {
    const script = await fs.readFile(path.join(REPO_ROOT, "scripts", "reinstall.sh"), "utf8");
    // The two values that silently broke it: an author slug that no longer
    // exists, and the retired long display name in the log path.
    expect(script).not.toMatch(/Claude Extensions\/local\.mcpb\.mat-silverstein/);
    expect(script).not.toMatch(/PDF Tools - View, Analyze, Extract, Fill/);
    expect(script).toContain("claude-extension-identity.mjs");
  });
});

describe("enablement state", () => {
  async function makeSettingsDirectory(entries) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-ext-settings-"));
    temporaryRoots.push(root);
    for (const [id, value] of Object.entries(entries)) {
      await fs.writeFile(path.join(root, `${id}.json`), JSON.stringify(value));
    }
    return root;
  }

  it("reads the host enablement flag", async () => {
    const settings = await makeSettingsDirectory({
      "ant.dir.gh.silverstein.pdf-filler-simple": { isEnabled: false },
      "local.mcpb.open-document-alliance.pdf-toolkit": { isEnabled: true },
    });
    expect(await readExtensionEnabled("ant.dir.gh.silverstein.pdf-filler-simple", settings)).toBe(false);
    expect(await readExtensionEnabled("local.mcpb.open-document-alliance.pdf-toolkit", settings)).toBe(true);
  });

  it("reports unknown rather than guessing when the flag is absent", async () => {
    const settings = await makeSettingsDirectory({ "some.ext": { other: 1 } });
    expect(await readExtensionEnabled("some.ext", settings)).toBe(null);
    expect(await readExtensionEnabled("never.written", settings)).toBe(null);
  });

  it("treats a disabled legacy install as clean residue, not a live duplicate", async () => {
    // The maintainer Mac's state after disabling the legacy Directory install:
    // still present on disk, no longer competing for tool announcements.
    const root = await makeExtensionsDirectory([
      "ant.dir.gh.silverstein.pdf-filler-simple",
      "local.mcpb.open-document-alliance.pdf-toolkit",
    ]);
    const settings = await makeSettingsDirectory({
      "ant.dir.gh.silverstein.pdf-filler-simple": { isEnabled: false },
      "local.mcpb.open-document-alliance.pdf-toolkit": { isEnabled: true },
    });
    const { installs } = await discoverInstalls({
      manifest: MANIFEST, extensionsDirectory: root, settingsDirectory: settings,
    });
    expect(summarizeUpgradeState(installs)).toMatchObject({
      duplicate_identities: true,
      live_duplicate: false,
      disabled_residue_count: 1,
      clean: true,
    });
  });

  it("still reports a live duplicate when both are enabled", async () => {
    const root = await makeExtensionsDirectory([
      "ant.dir.gh.silverstein.pdf-filler-simple",
      "local.mcpb.open-document-alliance.pdf-toolkit",
    ]);
    const settings = await makeSettingsDirectory({
      "ant.dir.gh.silverstein.pdf-filler-simple": { isEnabled: true },
      "local.mcpb.open-document-alliance.pdf-toolkit": { isEnabled: true },
    });
    const { installs } = await discoverInstalls({
      manifest: MANIFEST, extensionsDirectory: root, settingsDirectory: settings,
    });
    expect(summarizeUpgradeState(installs)).toMatchObject({ live_duplicate: true, clean: false });
  });

  it("treats unreadable enablement as live rather than assuming dormant", async () => {
    // Assuming a copy is dormant is the assumption that produces a false clean.
    const root = await makeExtensionsDirectory([
      "ant.dir.gh.silverstein.pdf-filler-simple",
      "local.mcpb.open-document-alliance.pdf-toolkit",
    ]);
    const settings = await makeSettingsDirectory({});
    const { installs } = await discoverInstalls({
      manifest: MANIFEST, extensionsDirectory: root, settingsDirectory: settings,
    });
    expect(summarizeUpgradeState(installs)).toMatchObject({
      unknown_enablement_count: 2, live_duplicate: true, clean: false,
    });
  });
});
