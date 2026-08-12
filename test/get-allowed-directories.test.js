import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

// Before this tool the only way to discover the boundary was to trip it: the
// refusal message was the sole place the allowed set and the config path
// appeared. Asking should not require failing first.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "server", "index.js");

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

describe("get_allowed_directories", () => {
  let tempDirectory;
  let pluginData;
  let firstDirectory;
  let secondDirectory;

  beforeAll(async () => {
    tempDirectory = await createTestTempDirectory(REPO_ROOT, "get-allowed-directories");
    pluginData = path.join(tempDirectory, "plugin-data");
    firstDirectory = path.join(tempDirectory, "first");
    secondDirectory = path.join(tempDirectory, "second");
    await fs.mkdir(pluginData, { recursive: true });
    await fs.mkdir(firstDirectory, { recursive: true });
    await fs.mkdir(secondDirectory, { recursive: true });
  }, 30_000);

  afterAll(async () => {
    await removeTestTempDirectory(tempDirectory);
  });

  it("reports the configured directories and the layer that supplied them", async () => {
    const result = await withServer({
      name: "allowed-dirs-env",
      env: {
        HOME: path.join(tempDirectory, "home"),
        ALLOWED_DIRECTORIES: [firstDirectory, secondDirectory].join(path.delimiter),
        DEFAULT_PROFILES_DIR: path.join(tempDirectory, "profiles"),
      },
    }, client => client.callTool({ name: "get_allowed_directories", arguments: {} }));

    const structured = result.structuredContent;
    expect(structured.source).toBe("environment");
    expect(structured.directories).toEqual([firstDirectory, secondDirectory]);
    expect(structured.configured).toBe(true);
  }, 30_000);

  it("names the argument layer when the argument supplied the set", async () => {
    const result = await withServer({
      name: "allowed-dirs-argv",
      args: ["--allowed-directories", firstDirectory],
      env: {
        HOME: path.join(tempDirectory, "home"),
        ALLOWED_DIRECTORIES: secondDirectory,
        DEFAULT_PROFILES_DIR: path.join(tempDirectory, "profiles"),
      },
    }, client => client.callTool({ name: "get_allowed_directories", arguments: {} }));

    // The argument outranks the environment, and the report must say which one
    // actually took effect rather than listing both.
    expect(result.structuredContent.source).toBe("argument");
    expect(result.structuredContent.directories).toEqual([firstDirectory]);
  }, 30_000);

  it("reports the config file and its path on a plugin install", async () => {
    await fs.writeFile(
      path.join(pluginData, "config.json"),
      JSON.stringify({ allowedDirectories: [firstDirectory] }),
    );

    const result = await withServer({
      name: "allowed-dirs-config",
      env: { HOME: path.join(tempDirectory, "home"), PLUGIN_DATA: pluginData },
    }, client => client.callTool({ name: "get_allowed_directories", arguments: {} }));

    const structured = result.structuredContent;
    expect(structured.source).toBe("config_file");
    expect(structured.config_path).toBe(path.join(pluginData, "config.json"));
    expect(structured.directories).toEqual([firstDirectory]);
  }, 30_000);

  it("answers without a refusal when nothing is configured", async () => {
    const emptyPluginData = path.join(tempDirectory, "empty-plugin-data");
    await fs.mkdir(emptyPluginData, { recursive: true });

    const result = await withServer({
      name: "allowed-dirs-empty",
      env: { HOME: path.join(tempDirectory, "home"), PLUGIN_DATA: emptyPluginData },
    }, client => client.callTool({ name: "get_allowed_directories", arguments: {} }));

    // Reporting the boundary is not reaching past it, so an unconfigured
    // server must still answer this question rather than deny it.
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.configured).toBe(false);
    expect(result.structuredContent.directories).toEqual([]);
    expect(result.structuredContent.config_path).toBe(
      path.join(tempDirectory, "home", ".pdf-tools", "config.json"),
    );
  }, 30_000);

  it("is annotated read-only and takes no arguments", async () => {
    const tool = await withServer({
      name: "allowed-dirs-annotations",
      env: { HOME: path.join(tempDirectory, "home"), ALLOWED_DIRECTORIES: firstDirectory },
    }, async client => (await client.listTools()).tools.find(t => t.name === "get_allowed_directories"));

    expect(tool).toBeTruthy();
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.annotations.destructiveHint).toBe(false);
    // No arguments means nothing to point somewhere it should not go.
    expect(tool.inputSchema.properties).toEqual({});
  }, 30_000);
});
