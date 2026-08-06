import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseAllowedDirectoryArgs } from "../server/helpers.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

// These tests encode the allowed-directory boundary we intend to enforce on a
// host that supplies no user configuration, which is every Agent Plugins 1.0.0
// client. They are expected to fail against the current implementation; each
// failure is the evidence for one finding.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "server", "index.js");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");
const UNEXPANDED_TEMPLATE = "${user_config.allowed_directories}";

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
    env: {
      PATH: process.env.PATH ?? "",
      ...env,
    },
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, transport };
}

describe("sandbox boundary: unresolved host configuration", () => {
  let client;
  let transport;
  let tempDirectory;
  let fakeHome;
  let homeDocuments;

  beforeAll(async () => {
    tempDirectory = await createTestTempDirectory(REPO_ROOT, "sandbox-unresolved-config");
    fakeHome = path.join(tempDirectory, "home");
    homeDocuments = path.join(fakeHome, "Documents");
    await fs.mkdir(homeDocuments, { recursive: true });
    await fs.copyFile(EXAMPLE_PDF, path.join(homeDocuments, "private.pdf"));

    // Exactly what a conformant Agent Plugins host produces: the placeholders
    // are never expanded, so neither the argument nor the environment value
    // carries a real directory.
    ({ client, transport } = await connectServer({
      name: "pdf-tools-unresolved-config-client",
      args: ["--allowed-directories", UNEXPANDED_TEMPLATE],
      env: {
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        ALLOWED_DIRECTORIES: UNEXPANDED_TEMPLATE,
        DEFAULT_PROFILES_DIR: path.join(tempDirectory, "profiles"),
      },
    }));
  }, 30_000);

  afterAll(async () => {
    try {
      await transport?.close();
    } finally {
      await removeTestTempDirectory(tempDirectory);
    }
  });

  it("does not grant the home documents folder when no allowed set was configured", async () => {
    const result = await client.callTool({
      name: "list_pdfs",
      arguments: { directory: homeDocuments },
    });

    expect(structuredErrorCode(result)).toBe("path_policy_denied");
    expect(textFromToolResult(result)).not.toContain("private.pdf");
  }, 30_000);

  it("refuses a home-relative path rather than substituting a default", async () => {
    const result = await client.callTool({
      name: "display_pdf",
      arguments: { pdf_path: path.join(homeDocuments, "private.pdf") },
    });

    expect(structuredErrorCode(result)).toBe("path_policy_denied");
  }, 30_000);
});

describe("sandbox boundary: configured allowed set", () => {
  let client;
  let transport;
  let tempDirectory;
  let allowedDirectory;
  let profilesDirectory;

  beforeAll(async () => {
    tempDirectory = await createTestTempDirectory(REPO_ROOT, "sandbox-configured");
    allowedDirectory = path.join(tempDirectory, "allowed");
    profilesDirectory = path.join(tempDirectory, "profiles");
    await fs.mkdir(allowedDirectory, { recursive: true });
    await fs.mkdir(profilesDirectory, { recursive: true });
    await fs.copyFile(EXAMPLE_PDF, path.join(profilesDirectory, "store-side.pdf"));

    ({ client, transport } = await connectServer({
      name: "pdf-tools-configured-allowlist-client",
      env: {
        HOME: path.join(tempDirectory, "home"),
        ALLOWED_DIRECTORIES: allowedDirectory,
        DEFAULT_PROFILES_DIR: profilesDirectory,
      },
    }));
  }, 30_000);

  afterAll(async () => {
    try {
      await transport?.close();
    } finally {
      await removeTestTempDirectory(tempDirectory);
    }
  });

  it("does not name a specific host in a refusal message", async () => {
    const result = await client.callTool({
      name: "display_pdf",
      arguments: { pdf_path: EXAMPLE_PDF },
    });

    // The server runs under any MCP client, so the remedy must not be phrased
    // as one product's settings screen. What the message *includes* — the
    // configured set and the attempted path — is asserted in
    // test/allowed-directories.test.js, which owns the wording.
    expect(textFromToolResult(result)).not.toContain("Claude Desktop");
  }, 30_000);

  it("does not expose the private store as a general user-path allowance", async () => {
    // The profile and signature store must remain reachable by the tools that
    // own it, but it is not a directory the user chose to expose to ordinary
    // document reads.
    const result = await client.callTool({
      name: "list_pdfs",
      arguments: { directory: profilesDirectory },
    });

    expect(structuredErrorCode(result)).toBe("path_policy_denied");
    expect(textFromToolResult(result)).not.toContain("store-side.pdf");
  }, 30_000);
});

describe("sandbox boundary: allowed-set parsing", () => {
  let client;
  let transport;
  let tempDirectory;

  beforeAll(async () => {
    tempDirectory = await createTestTempDirectory(REPO_ROOT, "sandbox-empty-json-entry");

    // A JSON array carrying an empty string. path.resolve("") is the working
    // directory, so an empty entry must not become an allowed directory.
    ({ client, transport } = await connectServer({
      name: "pdf-tools-empty-entry-client",
      env: {
        HOME: path.join(tempDirectory, "home"),
        ALLOWED_DIRECTORIES: '[""]',
        DEFAULT_PROFILES_DIR: path.join(tempDirectory, "profiles"),
      },
    }));
  }, 30_000);

  afterAll(async () => {
    try {
      await transport?.close();
    } finally {
      await removeTestTempDirectory(tempDirectory);
    }
  });

  it("does not admit the working directory from an empty allowed-set entry", async () => {
    const result = await client.callTool({
      name: "list_pdfs",
      arguments: { directory: REPO_ROOT },
    });

    expect(structuredErrorCode(result)).toBe("path_policy_denied");
    expect(textFromToolResult(result)).not.toContain("example-fw9.pdf");
  }, 30_000);
});

describe("parseAllowedDirectoryArgs boundaries", () => {
  it("stops at the next flag instead of consuming it as a directory", () => {
    expect(parseAllowedDirectoryArgs([
      "--allowed-directories",
      "/srv/documents",
      "--cache-dir",
      "/var/tmp/cache",
    ])).toEqual(["/srv/documents"]);
  });

  it("treats an all-template argument list as unconfigured, not as empty", () => {
    // [] and null are handled identically downstream today, which is how an
    // unexpanded template silently reaches the built-in defaults.
    expect(parseAllowedDirectoryArgs([
      "--allowed-directories",
      UNEXPANDED_TEMPLATE,
    ])).toEqual([]);
  });
});
