import fs from "fs/promises";
import path from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expandHostPlaceholders, parseAllowedDirectoryArgs } from "../server/helpers.js";
import { createTestTempDirectory, removeTestTempDirectory } from "./helpers/temp-directory.js";

// Measured on Windows Claude Desktop 1.26832.0 with an MCPB install whose
// allowed-directories setting the user had never opened:
//
//   argv = [..., "--allowed-directories",
//           "${HOME}/Documents", "${HOME}/Downloads", "${HOME}/Desktop"]
//   ALLOWED_DIRECTORIES = "${user_config.allowed_directories}"
//   DEFAULT_PROFILES_DIR = "C:\Users\qa/.pdf-toolkit-files"
//
// The host expands ${HOME} in a manifest-authored env string but not inside a
// user_config default value, so those three arrive literal. Rejecting them as
// "unresolved" left the allowed set empty and refused every path, while the
// removed home-folder fallback had been coincidentally reproducing the same
// three directories and hiding it.
//
// ${HOME} is resolvable by this process. ${user_config.*} is not, and must stay
// rejected: guessing a boundary the user never chose is the fail-open this
// whole line of work removed.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "server", "index.js");
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");

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

describe("expandHostPlaceholders", () => {
  it("resolves ${HOME} and ${USERPROFILE} to the running user's home", () => {
    expect(expandHostPlaceholders("${HOME}/Documents")).toBe(`${homedir()}/Documents`);
    expect(expandHostPlaceholders("${USERPROFILE}/Desktop")).toBe(`${homedir()}/Desktop`);
  });

  it("leaves an unresolvable host template alone", () => {
    // We do not know what the user configured, so this must remain templated
    // and be rejected downstream rather than guessed at.
    expect(expandHostPlaceholders("${user_config.allowed_directories}"))
      .toBe("${user_config.allowed_directories}");
  });

  it("passes ordinary paths through untouched", () => {
    expect(expandHostPlaceholders("/srv/documents")).toBe("/srv/documents");
    expect(expandHostPlaceholders("C:\\Users\\qa\\Documents")).toBe("C:\\Users\\qa\\Documents");
  });
});

describe("parseAllowedDirectoryArgs with the argv Windows actually sends", () => {
  it("accepts the unexpanded user_config defaults the host passes through", () => {
    expect(parseAllowedDirectoryArgs([
      "--allowed-directories",
      "${HOME}/Documents",
      "${HOME}/Downloads",
      "${HOME}/Desktop",
    ])).toEqual([
      `${homedir()}/Documents`,
      `${homedir()}/Downloads`,
      `${homedir()}/Desktop`,
    ]);
  });

  it("still rejects a template it cannot resolve", () => {
    expect(parseAllowedDirectoryArgs([
      "--allowed-directories",
      "${user_config.allowed_directories}",
    ])).toEqual([]);
  });
});

describe("end to end: the Windows MCPB launch shape", () => {
  let tempDirectory;
  let fakeHome;
  let documents;

  beforeAll(async () => {
    tempDirectory = await createTestTempDirectory(REPO_ROOT, "host-placeholder");
    fakeHome = path.join(tempDirectory, "home");
    documents = path.join(fakeHome, "Documents");
    await fs.mkdir(documents, { recursive: true });
    await fs.copyFile(EXAMPLE_PDF, path.join(documents, "w9.pdf"));
  }, 30_000);

  afterAll(async () => {
    await removeTestTempDirectory(tempDirectory);
  });

  it("grants the folders the host named, reproducing the exact failing launch", async () => {
    // Exactly what Claude Desktop passed on Windows: literal ${HOME} in argv,
    // and an env var the host never substituted at all.
    const text = await withServer({
      name: "windows-launch-shape",
      args: ["--allowed-directories", "${HOME}/Documents"],
      env: {
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        ALLOWED_DIRECTORIES: "${user_config.allowed_directories}",
        DEFAULT_PROFILES_DIR: path.join(tempDirectory, "profiles"),
      },
    }, client => client
      .callTool({ name: "list_pdfs", arguments: { directory: documents } })
      .then(r => r.content?.map(i => i.text).join(" ") ?? ""));

    expect(text).toContain("w9.pdf");
  }, 30_000);

  it("reports the resolved directory, not the template it was handed", async () => {
    const structured = await withServer({
      name: "windows-launch-reported",
      args: ["--allowed-directories", "${HOME}/Documents"],
      env: {
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        DEFAULT_PROFILES_DIR: path.join(tempDirectory, "profiles"),
      },
    }, client => client
      .callTool({ name: "get_allowed_directories", arguments: {} })
      .then(r => r.structuredContent));

    expect(structured.configured).toBe(true);
    expect(structured.source).toBe("argument");
    expect(structured.directories).toEqual([documents]);
  }, 30_000);

  it("still refuses when the host resolved nothing at all", async () => {
    // Both channels unresolvable: this is genuinely unconfigured and must
    // refuse rather than invent a boundary.
    const result = await withServer({
      name: "windows-unresolvable",
      args: ["--allowed-directories", "${user_config.allowed_directories}"],
      env: {
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        ALLOWED_DIRECTORIES: "${user_config.allowed_directories}",
        DEFAULT_PROFILES_DIR: path.join(tempDirectory, "profiles"),
      },
    }, client => client.callTool({ name: "list_pdfs", arguments: { directory: documents } }));

    expect(structuredErrorCode(result)).toBe("path_policy_denied");
  }, 30_000);
});
