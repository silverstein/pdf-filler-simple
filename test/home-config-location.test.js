import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "server", "index.js");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");

function textFromToolResult(result) {
  return result.content?.map(item => item.type === "text" ? item.text : "").join(" ") || "";
}

function structuredErrorCode(result) {
  return result.structuredContent?.error?.code;
}

async function withServer({ args = [], env = {}, name }, run) {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY, ...args],
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? "", ...env },
    stderr: "pipe",
  });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await transport.close();
  }
}

function homeConfigPath(home) {
  return path.join(home, ".pdf-tools", "config.json");
}

async function writeHomeConfig(home, allowedDirectories) {
  const configPath = homeConfigPath(home);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ allowedDirectories }));
  return configPath;
}

describe("well-known home allowed-directories configuration", () => {
  let tempDirectory;

  beforeAll(async () => {
    tempDirectory = await createTestTempDirectory(REPO_ROOT, "home-config-location");
  }, 30_000);

  afterAll(async () => {
    await removeTestTempDirectory(tempDirectory);
  });

  it("uses the home file and reports that layer and exact path", async () => {
    const home = path.join(tempDirectory, "reported-home");
    const documents = path.join(tempDirectory, "reported-documents");
    await fs.mkdir(documents, { recursive: true });
    await fs.copyFile(EXAMPLE_PDF, path.join(documents, "from-home.pdf"));
    const configPath = await writeHomeConfig(home, [documents]);

    const { listing, boundary } = await withServer({
      name: "home-config-reported",
      env: { HOME: home },
    }, async client => ({
      listing: await client.callTool({ name: "list_pdfs", arguments: { directory: documents } }),
      boundary: await client.callTool({ name: "get_allowed_directories", arguments: {} }),
    }));

    expect(textFromToolResult(listing)).toContain("from-home.pdf");
    expect(boundary.structuredContent).toMatchObject({
      directories: [documents],
      configured: true,
      source: "home_config_file",
      config_path: configPath,
    });
  }, 30_000);

  it.each([
    ["argument", ["--allowed-directories", "WINNER"], {}],
    ["environment", [], { ALLOWED_DIRECTORIES: "WINNER" }],
  ])("keeps the %s layer above the home file without merging it", async (source, rawArgs, rawEnv) => {
    const home = path.join(tempDirectory, `${source}-home`);
    const homeDocuments = path.join(tempDirectory, `${source}-home-documents`);
    const winner = path.join(tempDirectory, `${source}-winner`);
    await fs.mkdir(homeDocuments, { recursive: true });
    await fs.mkdir(winner, { recursive: true });
    await fs.copyFile(EXAMPLE_PDF, path.join(homeDocuments, "lower-layer.pdf"));
    await fs.copyFile(EXAMPLE_PDF, path.join(winner, "winner.pdf"));
    await writeHomeConfig(home, [homeDocuments]);
    const args = rawArgs.map(value => value === "WINNER" ? winner : value);
    const env = Object.fromEntries(Object.entries(rawEnv).map(([key, value]) => [
      key,
      value === "WINNER" ? winner : value,
    ]));

    const observed = await withServer({
      name: `home-config-${source}-precedence`,
      args,
      env: { HOME: home, ...env },
    }, async client => ({
      winner: await client.callTool({ name: "list_pdfs", arguments: { directory: winner } }),
      lower: await client.callTool({ name: "list_pdfs", arguments: { directory: homeDocuments } }),
      boundary: await client.callTool({ name: "get_allowed_directories", arguments: {} }),
    }));

    expect(textFromToolResult(observed.winner)).toContain("winner.pdf");
    expect(structuredErrorCode(observed.lower)).toBe("path_policy_denied");
    expect(observed.boundary.structuredContent.source).toBe(source);
    expect(observed.boundary.structuredContent.directories).toEqual([winner]);
  }, 30_000);

  it("keeps an existing plugin data file above the home file", async () => {
    const home = path.join(tempDirectory, "plugin-precedence-home");
    const pluginData = path.join(tempDirectory, "plugin-precedence-data");
    const homeDocuments = path.join(tempDirectory, "plugin-precedence-home-documents");
    const pluginDocuments = path.join(tempDirectory, "plugin-precedence-plugin-documents");
    await fs.mkdir(pluginData, { recursive: true });
    await fs.mkdir(homeDocuments, { recursive: true });
    await fs.mkdir(pluginDocuments, { recursive: true });
    await fs.copyFile(EXAMPLE_PDF, path.join(homeDocuments, "lower-layer.pdf"));
    await fs.copyFile(EXAMPLE_PDF, path.join(pluginDocuments, "plugin-layer.pdf"));
    await writeHomeConfig(home, [homeDocuments]);
    await fs.writeFile(
      path.join(pluginData, "config.json"),
      JSON.stringify({ allowedDirectories: [pluginDocuments] }),
    );

    const observed = await withServer({
      name: "home-config-plugin-precedence",
      env: { HOME: home, PLUGIN_DATA: pluginData },
    }, async client => ({
      plugin: await client.callTool({ name: "list_pdfs", arguments: { directory: pluginDocuments } }),
      lower: await client.callTool({ name: "list_pdfs", arguments: { directory: homeDocuments } }),
      boundary: await client.callTool({ name: "get_allowed_directories", arguments: {} }),
    }));

    expect(textFromToolResult(observed.plugin)).toContain("plugin-layer.pdf");
    expect(structuredErrorCode(observed.lower)).toBe("path_policy_denied");
    expect(observed.boundary.structuredContent.source).toBe("config_file");
    expect(observed.boundary.structuredContent.config_path).toBe(path.join(pluginData, "config.json"));
  }, 30_000);

  // Only a malformed plugin file blocks the home file. A valid but empty one
  // must fall through: versions up to 0.10.0 wrote exactly that empty template
  // on first run, so treating it as authoritative would mean everyone upgrading
  // edits the friendlier home file and silently sees nothing happen. A file
  // that configures nothing is not a configuration; a file nobody can parse is
  // a problem the user has to see.
  it.each([
    ["malformed", "{ not json"],
  ])("does not fall through a %s plugin data file to the home file", async (kind, pluginContents) => {
    const home = path.join(tempDirectory, `plugin-${kind}-home`);
    const pluginData = path.join(tempDirectory, `plugin-${kind}-data`);
    const homeDocuments = path.join(home, "Documents");
    await fs.mkdir(pluginData, { recursive: true });
    await fs.mkdir(homeDocuments, { recursive: true });
    await fs.copyFile(EXAMPLE_PDF, path.join(homeDocuments, "must-stay-hidden.pdf"));
    await writeHomeConfig(home, [homeDocuments]);
    await fs.writeFile(path.join(pluginData, "config.json"), pluginContents);

    const observed = await withServer({
      name: `home-config-plugin-${kind}`,
      env: { HOME: home, PLUGIN_DATA: pluginData },
    }, async client => ({
      listing: await client.callTool({ name: "list_pdfs", arguments: { directory: homeDocuments } }),
      boundary: await client.callTool({ name: "get_allowed_directories", arguments: {} }),
    }));

    expect(structuredErrorCode(observed.listing)).toBe("path_policy_denied");
    expect(textFromToolResult(observed.listing)).not.toContain("must-stay-hidden.pdf");
    expect(observed.boundary.structuredContent).toMatchObject({
      directories: [],
      configured: false,
      source: "none",
      config_path: path.join(pluginData, "config.json"),
    });
  }, 30_000);

  it("falls through an empty plugin data file so an upgraded install still works", async () => {
    const home = path.join(tempDirectory, "plugin-empty-falls-through-home");
    const pluginData = path.join(tempDirectory, "plugin-empty-falls-through-data");
    const homeDocuments = path.join(home, "Documents");
    await fs.mkdir(pluginData, { recursive: true });
    await fs.mkdir(homeDocuments, { recursive: true });
    await fs.copyFile(EXAMPLE_PDF, path.join(homeDocuments, "reachable.pdf"));
    await writeHomeConfig(home, [homeDocuments]);
    // Exactly what 0.10.0 wrote on first run.
    await fs.writeFile(path.join(pluginData, "config.json"), JSON.stringify({ allowedDirectories: [] }));

    const observed = await withServer({
      name: "home-config-plugin-empty-falls-through",
      env: { HOME: home, PLUGIN_DATA: pluginData },
    }, async client => ({
      listing: await client.callTool({ name: "list_pdfs", arguments: { directory: homeDocuments } }),
      boundary: await client.callTool({ name: "get_allowed_directories", arguments: {} }),
    }));

    expect(structuredErrorCode(observed.listing)).toBeUndefined();
    expect(textFromToolResult(observed.listing)).toContain("reachable.pdf");
    expect(observed.boundary.structuredContent).toMatchObject({
      configured: true,
      source: "home_config_file",
      config_path: path.join(home, ".pdf-tools", "config.json"),
    });
  }, 30_000);

  it.each([
    ["missing", null],
    ["malformed", "{ not json"],
    ["empty-file", ""],
    ["empty-list", JSON.stringify({ allowedDirectories: [] })],
  ])("fails closed when the home file is %s", async (kind, contents) => {
    const home = path.join(tempDirectory, `${kind}-home`);
    const documents = path.join(home, "Documents");
    const configPath = homeConfigPath(home);
    await fs.mkdir(documents, { recursive: true });
    await fs.copyFile(EXAMPLE_PDF, path.join(documents, "must-stay-hidden.pdf"));
    if (contents !== null) {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, contents);
    }

    const observed = await withServer({
      name: `home-config-${kind}`,
      env: { HOME: home },
    }, async client => ({
      listing: await client.callTool({ name: "list_pdfs", arguments: { directory: documents } }),
      boundary: await client.callTool({ name: "get_allowed_directories", arguments: {} }),
    }));

    expect(structuredErrorCode(observed.listing)).toBe("path_policy_denied");
    expect(textFromToolResult(observed.listing)).not.toContain("must-stay-hidden.pdf");
    expect(observed.boundary.structuredContent).toMatchObject({
      directories: [],
      configured: false,
      source: "none",
      config_path: configPath,
    });
    if (kind === "missing") {
      const template = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(template.allowedDirectories).toEqual([]);
    }
  }, 30_000);

  it("refuses a home configuration that reaches its own file", async () => {
    const home = path.join(tempDirectory, "self-grant-home");
    const configDirectory = path.join(home, ".pdf-tools");
    await fs.mkdir(configDirectory, { recursive: true });
    await fs.copyFile(EXAMPLE_PDF, path.join(configDirectory, "bait.pdf"));
    await writeHomeConfig(home, [configDirectory]);

    const observed = await withServer({
      name: "home-config-self-grant",
      env: { HOME: home },
    }, async client => ({
      listing: await client.callTool({ name: "list_pdfs", arguments: { directory: configDirectory } }),
      boundary: await client.callTool({ name: "get_allowed_directories", arguments: {} }),
    }));

    expect(structuredErrorCode(observed.listing)).toBe("path_policy_denied");
    expect(textFromToolResult(observed.listing)).not.toContain("bait.pdf");
    expect(observed.boundary.structuredContent.source).toBe("refused_self_granting");
    expect(observed.boundary.structuredContent.directories).toEqual([]);
    expect(observed.boundary.structuredContent.config_path).toBe(homeConfigPath(home));
  }, 30_000);

  it("expands ${HOME} and rejects unresolved placeholders like the existing layers", async () => {
    const expandedHome = path.join(tempDirectory, "expanded-placeholder-home");
    const documents = path.join(expandedHome, "Documents");
    await fs.mkdir(documents, { recursive: true });
    await fs.copyFile(EXAMPLE_PDF, path.join(documents, "expanded.pdf"));
    await writeHomeConfig(expandedHome, ["${HOME}/Documents"]);

    const expanded = await withServer({
      name: "home-config-expanded-placeholder",
      env: { HOME: expandedHome },
    }, client => client.callTool({ name: "get_allowed_directories", arguments: {} }));
    expect(expanded.structuredContent.source).toBe("home_config_file");
    expect(expanded.structuredContent.directories).toEqual([documents]);

    const unresolvedHome = path.join(tempDirectory, "unresolved-placeholder-home");
    await writeHomeConfig(unresolvedHome, ["${user_config.allowed_directories}"]);
    const unresolved = await withServer({
      name: "home-config-unresolved-placeholder",
      env: { HOME: unresolvedHome },
    }, client => client.callTool({ name: "get_allowed_directories", arguments: {} }));
    expect(unresolved.structuredContent.source).toBe("none");
    expect(unresolved.structuredContent.directories).toEqual([]);
  }, 30_000);

  it("does not create the home template when a higher layer supplied directories", async () => {
    const home = path.join(tempDirectory, "no-template-home");
    const documents = path.join(tempDirectory, "no-template-documents");
    await fs.mkdir(documents, { recursive: true });

    await withServer({
      name: "home-config-no-template",
      env: { HOME: home, ALLOWED_DIRECTORIES: documents },
    }, client => client.callTool({ name: "get_allowed_directories", arguments: {} }));

    await expect(fs.stat(homeConfigPath(home))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("fails closed when the home config path cannot be read as a file", async () => {
    const home = path.join(tempDirectory, "unreadable-home");
    const documents = path.join(home, "Documents");
    const configPath = homeConfigPath(home);
    await fs.mkdir(documents, { recursive: true });
    await fs.mkdir(configPath, { recursive: true });
    await fs.copyFile(EXAMPLE_PDF, path.join(documents, "must-stay-hidden.pdf"));

    const result = await withServer({
      name: "home-config-unreadable",
      env: { HOME: home },
    }, client => client.callTool({ name: "list_pdfs", arguments: { directory: documents } }));

    expect(structuredErrorCode(result)).toBe("path_policy_denied");
    expect(textFromToolResult(result)).not.toContain("must-stay-hidden.pdf");
  }, 30_000);

  it("does not follow a home config-directory symlink outside the home when creating a template", async () => {
    const home = path.join(tempDirectory, "symlink-home");
    const outside = path.join(tempDirectory, "symlink-outside");
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(
      outside,
      path.join(home, ".pdf-tools"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const boundary = await withServer({
      name: "home-config-symlink-template",
      env: { HOME: home },
    }, client => client.callTool({ name: "get_allowed_directories", arguments: {} }));

    expect(boundary.structuredContent.configured).toBe(false);
    expect(boundary.structuredContent.config_path).toBe(homeConfigPath(home));
    await expect(fs.stat(path.join(outside, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("names the private workspace on a plugin denial and emits no shell recipe", async () => {
    const home = path.join(tempDirectory, "refusal-home");
    const pluginData = path.join(tempDirectory, "refusal-plugin-data");
    await fs.mkdir(pluginData, { recursive: true });

    const refusal = await withServer({
      name: "home-config-refusal",
      env: { HOME: home, PLUGIN_DATA: pluginData },
    }, client => client.callTool({ name: "list_pdfs", arguments: { directory: tempDirectory } }));

    const text = textFromToolResult(refusal);
    expect(text).toContain(path.join(pluginData, "workspace"));
    expect(text).not.toContain(homeConfigPath(home));
    expect(text).not.toMatch(/(?:^|\s)(?:cat|echo|printf|mkdir|tee)\s/);
  }, 30_000);
});
