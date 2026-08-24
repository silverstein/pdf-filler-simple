import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

// Agent Plugins 1.0.0 supplies no user-configuration mechanism and expands only
// ${PLUGIN_ROOT} and ${PLUGIN_DATA}, so a plugin install has no way to reach the
// CLI flag or the environment variable a host would otherwise set. PLUGIN_DATA
// is the one location the specification guarantees exists, is writable, and
// survives updates, so it is where a plugin's allowed set is configured.

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

async function connectServer({ args = [], env = {}, name }) {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY, ...args],
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? "", ...env },
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, transport };
}

async function withServer(options, run) {
  const { client, transport } = await connectServer(options);
  try {
    return await run(client);
  } finally {
    await transport.close();
  }
}

describe("PLUGIN_DATA config file supplies the allowed set", () => {
  let tempDirectory;
  let pluginData;
  let allowedDirectory;

  beforeAll(async () => {
    tempDirectory = await createTestTempDirectory(REPO_ROOT, "plugin-data-config");
    pluginData = path.join(tempDirectory, "plugin-data");
    allowedDirectory = path.join(tempDirectory, "documents");
    await fs.mkdir(pluginData, { recursive: true });
    await fs.mkdir(allowedDirectory, { recursive: true });
    await fs.copyFile(EXAMPLE_PDF, path.join(allowedDirectory, "in-config.pdf"));
  }, 30_000);

  afterAll(async () => {
    await removeTestTempDirectory(tempDirectory);
  });

  it("grants directories listed in the config file", async () => {
    await fs.writeFile(
      path.join(pluginData, "config.json"),
      JSON.stringify({ allowedDirectories: [allowedDirectory] }),
    );

    const text = await withServer({
      name: "plugin-data-config-grants",
      env: { HOME: path.join(tempDirectory, "home"), PLUGIN_DATA: pluginData },
    }, client => client
      .callTool({ name: "list_pdfs", arguments: { directory: allowedDirectory } })
      .then(textFromToolResult));

    expect(text).toContain("in-config.pdf");
  }, 30_000);

  it("still refuses a directory the config file does not list", async () => {
    await fs.writeFile(
      path.join(pluginData, "config.json"),
      JSON.stringify({ allowedDirectories: [allowedDirectory] }),
    );

    const result = await withServer({
      name: "plugin-data-config-refuses",
      env: { HOME: path.join(tempDirectory, "home"), PLUGIN_DATA: pluginData },
    }, client => client.callTool({
      name: "list_pdfs",
      arguments: { directory: tempDirectory },
    }));

    expect(structuredErrorCode(result)).toBe("path_policy_denied");
  }, 30_000);
});

describe("config file precedence", () => {
  let tempDirectory;
  let pluginData;
  let configDirectory;
  let envDirectory;

  beforeAll(async () => {
    tempDirectory = await createTestTempDirectory(REPO_ROOT, "plugin-data-precedence");
    pluginData = path.join(tempDirectory, "plugin-data");
    configDirectory = path.join(tempDirectory, "from-config");
    envDirectory = path.join(tempDirectory, "from-env");
    await fs.mkdir(pluginData, { recursive: true });
    await fs.mkdir(configDirectory, { recursive: true });
    await fs.mkdir(envDirectory, { recursive: true });
    await fs.copyFile(EXAMPLE_PDF, path.join(configDirectory, "config-side.pdf"));
    await fs.copyFile(EXAMPLE_PDF, path.join(envDirectory, "env-side.pdf"));
    await fs.writeFile(
      path.join(pluginData, "config.json"),
      JSON.stringify({ allowedDirectories: [configDirectory] }),
    );
  }, 30_000);

  afterAll(async () => {
    await removeTestTempDirectory(tempDirectory);
  });

  it("lets the environment variable win over the config file", async () => {
    // A host-supplied value outranks stored configuration.
    const result = await withServer({
      name: "plugin-data-env-wins",
      env: {
        HOME: path.join(tempDirectory, "home"),
        PLUGIN_DATA: pluginData,
        ALLOWED_DIRECTORIES: envDirectory,
      },
    }, client => client.callTool({
      name: "list_pdfs",
      arguments: { directory: configDirectory },
    }));

    expect(structuredErrorCode(result)).toBe("path_policy_denied");
  }, 30_000);

  it("does not merge the config file into a higher layer", async () => {
    const text = await withServer({
      name: "plugin-data-no-merge",
      env: {
        HOME: path.join(tempDirectory, "home"),
        PLUGIN_DATA: pluginData,
        ALLOWED_DIRECTORIES: envDirectory,
      },
    }, client => client
      .callTool({ name: "list_pdfs", arguments: { directory: envDirectory } })
      .then(textFromToolResult));

    // A union across layers produces a boundary nobody chose.
    expect(text).toContain("env-side.pdf");
  }, 30_000);
});

describe("config file safety", () => {
  let tempDirectory;

  beforeAll(async () => {
    tempDirectory = await createTestTempDirectory(REPO_ROOT, "plugin-data-safety");
  }, 30_000);

  afterAll(async () => {
    await removeTestTempDirectory(tempDirectory);
  });

  it("refuses a config that would grant access to itself", async () => {
    // If the allowed set contains the config file's own directory, an agent
    // with a write tool can rewrite its own sandbox. That is escalation, and
    // the right response is to refuse loudly rather than drop the entry.
    const pluginData = path.join(tempDirectory, "self-granting");
    await fs.mkdir(pluginData, { recursive: true });
    await fs.writeFile(
      path.join(pluginData, "config.json"),
      JSON.stringify({ allowedDirectories: [pluginData] }),
    );
    await fs.copyFile(EXAMPLE_PDF, path.join(pluginData, "bait.pdf"));

    const result = await withServer({
      name: "plugin-data-self-grant",
      env: { HOME: path.join(tempDirectory, "home"), PLUGIN_DATA: pluginData },
    }, client => client.callTool({
      name: "list_pdfs",
      arguments: { directory: pluginData },
    }));

    expect(structuredErrorCode(result)).toBe("path_policy_denied");
  }, 30_000);

  it("fails closed on a malformed config rather than ignoring it", async () => {
    const pluginData = path.join(tempDirectory, "malformed");
    const documents = path.join(tempDirectory, "malformed-docs");
    await fs.mkdir(pluginData, { recursive: true });
    await fs.mkdir(documents, { recursive: true });
    await fs.copyFile(EXAMPLE_PDF, path.join(documents, "doc.pdf"));
    await fs.writeFile(path.join(pluginData, "config.json"), "{ this is not json");

    const result = await withServer({
      name: "plugin-data-malformed",
      env: { HOME: path.join(tempDirectory, "home"), PLUGIN_DATA: pluginData },
    }, client => client.callTool({
      name: "list_pdfs",
      arguments: { directory: documents },
    }));

    // Silently treating a broken config as "no configuration" is the same
    // failure mode as the implicit home-folder grant that preceded it.
    expect(structuredErrorCode(result)).toBe("path_policy_denied");
  }, 30_000);

  it("ignores a config entry that is an unexpanded placeholder", async () => {
    const pluginData = path.join(tempDirectory, "placeholder");
    await fs.mkdir(pluginData, { recursive: true });
    await fs.writeFile(
      path.join(pluginData, "config.json"),
      JSON.stringify({ allowedDirectories: ["${user_config.allowed_directories}"] }),
    );

    const result = await withServer({
      name: "plugin-data-placeholder",
      env: { HOME: path.join(tempDirectory, "home"), PLUGIN_DATA: pluginData },
    }, client => client.callTool({
      name: "list_pdfs",
      arguments: { directory: tempDirectory },
    }));

    expect(structuredErrorCode(result)).toBe("path_policy_denied");
  }, 30_000);
});

describe("first-run bootstrap", () => {
  let tempDirectory;

  beforeAll(async () => {
    tempDirectory = await createTestTempDirectory(REPO_ROOT, "plugin-data-bootstrap");
  }, 30_000);

  afterAll(async () => {
    await removeTestTempDirectory(tempDirectory);
  });

  it("creates a private workspace and an optional direct-folder template on first run", async () => {
    const pluginData = path.join(tempDirectory, "fresh-install");
    const home = path.join(tempDirectory, "home");
    await fs.mkdir(pluginData, { recursive: true });
    const pluginConfigPath = path.join(pluginData, "config.json");
    const workspace = path.join(pluginData, "workspace");
    await fs.copyFile(EXAMPLE_PDF, path.join(pluginData, "to-import.pdf"));

    const observed = await withServer({
      name: "plugin-data-bootstrap",
      env: { HOME: home, PLUGIN_DATA: pluginData },
    }, async client => ({
      boundary: await client.callTool({ name: "get_allowed_directories", arguments: {} }),
      outside: await client.callTool({ name: "list_pdfs", arguments: { directory: pluginData } }),
      workspace: await client.callTool({ name: "list_pdfs", arguments: { directory: workspace } }),
    }));

    expect(observed.boundary.structuredContent).toMatchObject({
      directories: [workspace],
      configured: true,
      source: "plugin_workspace",
      config_path: pluginConfigPath,
    });
    expect(structuredErrorCode(observed.outside)).toBe("path_policy_denied");
    expect(structuredErrorCode(observed.workspace)).toBeUndefined();

    const written = JSON.parse(await fs.readFile(pluginConfigPath, "utf8"));
    expect(written.allowedDirectories).toEqual([]);
    if (process.platform !== "win32") {
      expect((await fs.stat(workspace)).mode & 0o777).toBe(0o700);
    }
    await expect(fs.stat(path.join(home, ".pdf-tools", "config.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("fails closed when the workspace path is a symlink outside plugin data", async () => {
    const pluginData = path.join(tempDirectory, "symlinked-workspace");
    const outside = path.join(tempDirectory, "outside-workspace");
    await fs.mkdir(pluginData, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.copyFile(EXAMPLE_PDF, path.join(outside, "must-stay-hidden.pdf"));
    await fs.symlink(outside, path.join(pluginData, "workspace"), process.platform === "win32" ? "junction" : "dir");

    const observed = await withServer({
      name: "plugin-data-workspace-symlink",
      env: { HOME: path.join(tempDirectory, "symlink-home"), PLUGIN_DATA: pluginData },
    }, async client => ({
      boundary: await client.callTool({ name: "get_allowed_directories", arguments: {} }),
      listing: await client.callTool({ name: "list_pdfs", arguments: { directory: outside } }),
    }));

    expect(observed.boundary.structuredContent).toMatchObject({
      directories: [],
      configured: false,
      source: "none",
    });
    expect(structuredErrorCode(observed.listing)).toBe("path_policy_denied");
    expect(textFromToolResult(observed.listing)).not.toContain("must-stay-hidden.pdf");
  }, 30_000);

  it("can process a host-imported copy without gaining direct access to its source folder", async () => {
    const pluginData = path.join(tempDirectory, "host-import");
    const workspace = path.join(pluginData, "workspace");
    const source = path.join(tempDirectory, "host-import-source");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(source, { recursive: true });
    await fs.copyFile(EXAMPLE_PDF, path.join(source, "source.pdf"));
    // This copy represents a separate action by a host that has permission to
    // read the source. PDF Tools receives authority only over the destination.
    await fs.copyFile(path.join(source, "source.pdf"), path.join(workspace, "imported.pdf"));

    const observed = await withServer({
      name: "plugin-data-host-import",
      env: { HOME: path.join(tempDirectory, "import-home"), PLUGIN_DATA: pluginData },
    }, async client => ({
      imported: await client.callTool({ name: "list_pdfs", arguments: { directory: workspace } }),
      source: await client.callTool({ name: "list_pdfs", arguments: { directory: source } }),
    }));

    expect(textFromToolResult(observed.imported)).toContain("imported.pdf");
    expect(structuredErrorCode(observed.source)).toBe("path_policy_denied");
    expect(textFromToolResult(observed.source)).not.toContain("source.pdf");
  }, 30_000);

  it("does not overwrite a config that already exists", async () => {
    const pluginData = path.join(tempDirectory, "existing");
    const documents = path.join(tempDirectory, "existing-docs");
    await fs.mkdir(pluginData, { recursive: true });
    await fs.mkdir(documents, { recursive: true });
    await fs.copyFile(EXAMPLE_PDF, path.join(documents, "keep.pdf"));
    const configPath = path.join(pluginData, "config.json");
    await fs.writeFile(configPath, JSON.stringify({ allowedDirectories: [documents] }));

    const text = await withServer({
      name: "plugin-data-no-clobber",
      env: { HOME: path.join(tempDirectory, "home"), PLUGIN_DATA: pluginData },
    }, client => client
      .callTool({ name: "list_pdfs", arguments: { directory: documents } })
      .then(textFromToolResult));

    expect(text).toContain("keep.pdf");
    const after = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(after.allowedDirectories).toEqual([documents]);
  }, 30_000);
});
