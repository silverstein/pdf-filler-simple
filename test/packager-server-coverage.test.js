/**
 * The packagers' server allow-lists against the real contents of `server/`.
 *
 * Both packagers name the server modules they ship explicitly, which is the
 * right default — a directory walk would let an untracked scratch file reach a
 * shipped artifact. The failure mode of an allow-list is the opposite one, and
 * it is silent: a module added to `server/` and imported by another module,
 * but never added to the list, is simply absent from the archive. Every
 * structural check downstream still passes, because each of them compares the
 * staged tree against the same short list, and the omission only surfaces when
 * a host starts the extension and Node cannot resolve the import.
 *
 * That is exactly what happened to `server/type3-cm-pk-reference.js`: three
 * separate allow-lists and one hand-written copy step never gained it, the
 * MCPB build reported success, and `npm run test:contract:share` died at
 * connection setup. These assertions make the lists derivable facts rather
 * than remembered ones.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVER_FILES } from "../scripts/build-mcpb.mjs";
import { SHARE_FILES, SHARE_MIRRORED_FILES, SHARE_SERVER_FILES } from "../package-for-friend.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_DIR = path.join(REPO_ROOT, "server");
const SHARE_SERVER_DIR = path.join(REPO_ROOT, "pdf-toolkit-mcp-share", "server");

async function serverDirectoryFilenames(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    expect(entry.isFile(), `${entry.name} under ${directory} is not a regular file`).toBe(true);
  }
  const names = entries.map(entry => entry.name).sort();
  // Guard against a readdir that silently returned nothing useful, which would
  // turn every equality below into a vacuous pass.
  expect(names.length).toBeGreaterThan(15);
  return names;
}

const serverFilenames = await serverDirectoryFilenames(SERVER_DIR);

describe("production packager server coverage", () => {
  it("stages exactly the modules that exist under server/", () => {
    expect([...SERVER_FILES].sort()).toEqual(serverFilenames);
  });

  it("names each module once", () => {
    expect(new Set(SERVER_FILES).size).toBe(SERVER_FILES.length);
  });
});

describe("share packager server coverage", () => {
  it("mirrors exactly the modules that exist under server/", () => {
    expect([...SHARE_SERVER_FILES].sort()).toEqual(serverFilenames.map(name => `server/${name}`));
  });

  it("mirrors the same modules the checked-in share tree carries", async () => {
    expect(await serverDirectoryFilenames(SHARE_SERVER_DIR)).toEqual(serverFilenames);
  });

  it("copies every mirrored path and nothing else", () => {
    // The copy step and the archive manifest are the same list, so a module
    // can no longer be archived without being copied or copied without being
    // archived.
    expect(SHARE_MIRRORED_FILES).toEqual([...SHARE_SERVER_FILES, "dist-ui/index.html"]);
    for (const relativePath of SHARE_MIRRORED_FILES) expect(SHARE_FILES).toContain(relativePath);
  });

  it("names each path once", () => {
    expect(new Set(SHARE_FILES).size).toBe(SHARE_FILES.length);
  });
});

/**
 * The property the allow-lists exist to protect: a staged tree that can
 * actually resolve its own imports. Checked against the import graph rather
 * than against another list, so a module reachable from the entry point has to
 * be shipped whatever any list happens to say.
 */
describe("staged server import graph", () => {
  it("resolves every relative import of every shipped module inside the shipped set", async () => {
    let relativeImports = 0;
    for (const filename of serverFilenames) {
      const source = await fs.readFile(path.join(SERVER_DIR, filename), "utf8");
      const specifiers = [...source.matchAll(/(?:^|[^\w$])(?:import|export)[^;'"]*?from\s*"(\.[^"]*)"/gmu)]
        .map(match => match[1]);
      for (const specifier of specifiers) {
        relativeImports += 1;
        const resolved = path.relative(SERVER_DIR, path.resolve(SERVER_DIR, specifier));
        expect(
          SERVER_FILES,
          `${filename} imports ${specifier}, which the production packager does not stage`,
        ).toContain(resolved);
        expect(
          SHARE_SERVER_FILES,
          `${filename} imports ${specifier}, which the share packager does not mirror`,
        ).toContain(`server/${resolved}`);
      }
    }
    expect(relativeImports).toBeGreaterThan(5);
  });
});
