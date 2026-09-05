import fs from "fs/promises";
import path from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { beforeAll, describe, expect, it } from "vitest";
import { expandHostPlaceholders, parseAllowedDirectoryArgs } from "../server/helpers.js";

// What our manifests promise, and what the host does with that promise.
//
// test/host-placeholder-expansion.test.js starts from an argv and proves the
// server handles it. Nothing proved the manifests actually produce that argv,
// so a manifest edit could silently hand every user an empty allowed set while
// the whole suite stayed green.
//
// PROVENANCE. The substitution below reproduces Claude Desktop 1.26832.0
// (macOS 26.6, arm64), read from
//   /Applications/Claude.app/Contents/Resources/app.asar
//   -> .vite/build/index2.chunk-CgwydJGa.js
// functions `Zt` (template substitution) and `Qt` (exported as `t`, the MCP
// config builder). `Qt` is what the installed-extension loader in
// .vite/build/index.chunk-BEV1w5Zk.js calls as `i.t({manifest, extensionPath,
// systemDirs, userConfig, pathSeparator})`, with systemDirs = {HOME, DESKTOP,
// DOCUMENTS, DOWNLOADS}. The expected values in this file were produced by
// lifting those functions out verbatim and running them against the installed
// packed manifest on that machine.
//
// Three host behaviours are load-bearing and none of them is documented by
// Anthropic:
//
//   1. A `multiple: true` value is substituted ONLY when its placeholder is a
//      standalone element of an array. There it is spread into N arguments.
//   2. In a string, an array value is refused outright — the host logs
//      "Cannot replace ... with array value in string context" and leaves the
//      literal `${user_config.*}` in place. That is why the ALLOWED_DIRECTORIES
//      env var can never carry anything, on any platform.
//   3. Substitution is a single ordered pass, and the systemDirs keys are
//      visited before the user_config keys. A `${HOME}` that arrives *inside* a
//      user_config value is therefore never expanded, while a `${HOME}` written
//      directly in the manifest is. This is the root cause of issue #101.
//
// LIMIT OF THIS TEST. It pins our side of the contract against one measured
// host version. If Claude Desktop changes its substitution rules, this test
// keeps passing while the product breaks. Re-measure against a new host before
// trusting it across a major desktop release; the method is in the vault
// receipt evidence/macos-host-user-config-argv-2026-08-09/.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

// Deliberately not the running user's home: it makes visible which side of the
// boundary expanded each value.
const HOST_HOME = "/host/home";
const EXTENSION_PATH = "/host/extensions/pdf-toolkit";

const HOST_SYSTEM_DIRS = Object.freeze({
  HOME: HOST_HOME,
  DESKTOP: `${HOST_HOME}/Desktop`,
  DOCUMENTS: `${HOST_HOME}/Documents`,
  DOWNLOADS: `${HOST_HOME}/Downloads`,
});

function substituteHostTemplates(node, context) {
  if (typeof node === "string") {
    let out = node;
    for (const [key, value] of Object.entries(context)) {
      const pattern = new RegExp(`\\$\\{${key}\\}`, "g");
      if (!out.match(pattern)) continue;
      // Behaviour 2: an array has no string form the host will guess at.
      if (Array.isArray(value)) continue;
      out = out.replace(pattern, value);
    }
    return out;
  }

  if (Array.isArray(node)) {
    const out = [];
    for (const entry of node) {
      // Behaviour 1: only an element that is *entirely* one user_config
      // placeholder is eligible. "--allowed-directories=${user_config.x}" is
      // not, and falls through to the string branch, which refuses arrays.
      if (typeof entry === "string" && /^\$\{user_config\.[^}]+\}$/.test(entry)) {
        const key = entry.match(/^\$\{([^}]+)\}$/)?.[1];
        const value = key ? context[key] : undefined;
        if (value) {
          if (Array.isArray(value)) out.push(...value);
          else out.push(value);
        } else {
          out.push(entry);
        }
        continue;
      }
      out.push(substituteHostTemplates(entry, context));
    }
    return out;
  }

  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = substituteHostTemplates(value, context);
    }
    return out;
  }

  return node;
}

function hasMissingRequiredConfig(manifest, userConfig) {
  if (!manifest.user_config) return false;
  const provided = userConfig ?? {};
  const empty = value => value == null || value === "";
  for (const [key, declaration] of Object.entries(manifest.user_config)) {
    if (!declaration.required) continue;
    const value = provided[key];
    if (empty(value) || (Array.isArray(value) && (value.length === 0 || value.some(empty)))) {
      return true;
    }
  }
  return false;
}

function buildHostMcpConfig(manifest, { userConfig = {}, pathSeparator = "/" } = {}) {
  const declared = manifest.server?.mcp_config;
  if (!declared) return undefined;

  const config = { ...declared };
  const overrides = config.platform_overrides?.[process.platform];
  if (overrides) {
    config.command = overrides.command || config.command;
    config.args = overrides.args || config.args;
    config.env = overrides.env || config.env;
  }

  // The host drops the server entirely rather than launching it under-configured.
  if (hasMissingRequiredConfig(manifest, userConfig)) return undefined;

  // Behaviour 3: insertion order decides what gets a second pass. systemDirs
  // first, user_config after, one pass over the whole set.
  const context = {
    __dirname: EXTENSION_PATH,
    pathSeparator,
    "/": pathSeparator,
    ...HOST_SYSTEM_DIRS,
  };

  const values = {};
  for (const [key, declaration] of Object.entries(manifest.user_config ?? {})) {
    if (declaration.default !== undefined) values[key] = declaration.default;
  }
  Object.assign(values, userConfig);

  for (const [key, value] of Object.entries(values)) {
    const contextKey = `user_config.${key}`;
    if (Array.isArray(value)) context[contextKey] = value.map(String);
    else if (typeof value === "boolean") context[contextKey] = value ? "true" : "false";
    else context[contextKey] = String(value);
  }

  return substituteHostTemplates(config, context);
}

let SOURCE_MANIFEST;
let PACKED_MANIFEST;

beforeAll(async () => {
  const read = async name =>
    JSON.parse(await fs.readFile(path.join(REPO_ROOT, name), "utf8"));
  SOURCE_MANIFEST = await read("manifest.json");
  PACKED_MANIFEST = await read("manifest.mcpb.json");
});

describe("the launch contract our manifests declare", () => {
  it("declares the same mcp_config in both manifests", () => {
    // The packed manifest is what ships. A drift here means the shape we test
    // is not the shape users run.
    expect(PACKED_MANIFEST.server.mcp_config).toEqual(SOURCE_MANIFEST.server.mcp_config);
  });

  it("keeps every multiple-valued placeholder in the one position the host expands", () => {
    for (const manifest of [SOURCE_MANIFEST, PACKED_MANIFEST]) {
      const multiple = Object.entries(manifest.user_config ?? {})
        .filter(([, declaration]) => declaration.multiple)
        .map(([key]) => key);
      expect(multiple).toEqual(["allowed_directories"]);

      for (const key of multiple) {
        const placeholder = `\${user_config.${key}}`;
        const args = manifest.server.mcp_config.args ?? [];
        // Standalone element, not embedded in a longer argument: an embedded
        // one is silently left as a literal and the user loses every folder.
        expect(args).toContain(placeholder);
      }
    }
  });

  it("asks for no required user configuration", () => {
    // A required value the user has not filled in makes the host skip the
    // whole server, which presents as the extension simply not working.
    for (const manifest of [SOURCE_MANIFEST, PACKED_MANIFEST]) {
      const required = Object.entries(manifest.user_config ?? {})
        .filter(([, declaration]) => declaration.required)
        .map(([key]) => key);
      expect(required).toEqual([]);
    }
  });

  it("pins the string-context references that can never carry a value", () => {
    // Behaviour 2. ALLOWED_DIRECTORIES is inert on this host by construction;
    // argv is the channel that works. Listing it here means a *new* inert
    // reference cannot be added without someone deciding to add it.
    const inert = [];
    for (const [name, value] of Object.entries(PACKED_MANIFEST.server.mcp_config.env ?? {})) {
      const match = typeof value === "string" && value.match(/\$\{user_config\.([^}]+)\}/);
      if (!match) continue;
      if (PACKED_MANIFEST.user_config?.[match[1]]?.multiple) inert.push(name);
    }
    expect(inert).toEqual(["ALLOWED_DIRECTORIES"]);
  });
});

describe("what Claude Desktop 1.26832.0 hands the server", () => {
  it("spreads the untouched defaults into argv, still templated", () => {
    // The measured case: a Mac whose stored settings are {"isEnabled": true}
    // with no userConfig at all, which is the state of a user who has never
    // opened the extension's configuration dialog.
    const config = buildHostMcpConfig(PACKED_MANIFEST);

    expect(config.args).toEqual([
      `${EXTENSION_PATH}/server/index.js`,
      "--allowed-directories",
      "${HOME}/Documents",
      "${HOME}/Downloads",
      "${HOME}/Desktop",
    ]);

    expect(config.env).toEqual({
      // Written as ${HOME} in the manifest, so the host expands it...
      DEFAULT_PROFILES_DIR: `${HOST_HOME}/.pdf-toolkit-files`,
      // ...but a ${HOME} that arrives through a user_config value does not get
      // a second pass, so these two stay templated.
      DEFAULT_PDF_DIR: "${HOME}/Documents",
      DEFAULT_DOWNLOAD_DIR: "${HOME}/Downloads",
      ALLOWED_DIRECTORIES: "${user_config.allowed_directories}",
      LUMIN_OAUTH_CLIENT_ID: "${user_config.lumin_oauth_client_id}",
    });
  });

  it("passes an optional Lumin public client ID through the host environment", () => {
    const config = buildHostMcpConfig(PACKED_MANIFEST, {
      userConfig: { lumin_oauth_client_id: "public-client-123" },
    });
    expect(config.env.LUMIN_OAUTH_CLIENT_ID).toBe("public-client-123");
  });

  it("spreads a configured folder list, one argument per folder", () => {
    // Issue #101's exact reported shape: the user added a fourth row and typed
    // it in the ${HOME}/... form the three built-in rows display.
    const config = buildHostMcpConfig(PACKED_MANIFEST, {
      userConfig: {
        allowed_directories: [
          "${HOME}/Documents",
          "${HOME}/Downloads",
          "${HOME}/Desktop",
          "${HOME}/Library/CloudStorage/Dropbox-Fonsdar/",
        ],
      },
    });

    expect(config.args).toEqual([
      `${EXTENSION_PATH}/server/index.js`,
      "--allowed-directories",
      "${HOME}/Documents",
      "${HOME}/Downloads",
      "${HOME}/Desktop",
      "${HOME}/Library/CloudStorage/Dropbox-Fonsdar/",
    ]);
  });

  it("passes absolute paths through unchanged", () => {
    const config = buildHostMcpConfig(PACKED_MANIFEST, {
      userConfig: {
        allowed_directories: ["/Users/qa/Documents", "/Volumes/Share/Contracts"],
        default_pdf_directory: "/Volumes/Share/Contracts",
      },
    });

    expect(config.args.slice(1)).toEqual([
      "--allowed-directories",
      "/Users/qa/Documents",
      "/Volumes/Share/Contracts",
    ]);
    expect(config.env.DEFAULT_PDF_DIR).toBe("/Volumes/Share/Contracts");
    // Untouched by the user, so still the templated default.
    expect(config.env.DEFAULT_DOWNLOAD_DIR).toBe("${HOME}/Downloads");
  });

  it("refuses to substitute a multiple-valued placeholder inside a longer argument", () => {
    // Guards the reason the standalone-element assertion above exists. If
    // someone rewrites the argument as a single --flag=value pair, the host
    // hands the server a literal and every configured folder is lost.
    const rewritten = {
      ...PACKED_MANIFEST,
      server: {
        ...PACKED_MANIFEST.server,
        mcp_config: {
          ...PACKED_MANIFEST.server.mcp_config,
          args: [
            "${__dirname}/server/index.js",
            "--allowed-directories=${user_config.allowed_directories}",
          ],
        },
      },
    };

    const config = buildHostMcpConfig(rewritten);
    expect(config.args[1]).toBe("--allowed-directories=${user_config.allowed_directories}");
    expect(parseAllowedDirectoryArgs(config.args)).toBeNull();
  });
});

describe("what the server then resolves, end to end from the manifest", () => {
  it("recovers all three default folders the host left templated", () => {
    const config = buildHostMcpConfig(PACKED_MANIFEST);

    // The separator stays the "/" the manifest wrote; only ${HOME} is replaced.
    expect(parseAllowedDirectoryArgs(config.args)).toEqual([
      `${homedir()}/Documents`,
      `${homedir()}/Downloads`,
      `${homedir()}/Desktop`,
    ]);
  });

  it("recovers the fourth folder from issue #101", () => {
    const config = buildHostMcpConfig(PACKED_MANIFEST, {
      userConfig: {
        allowed_directories: [
          "${HOME}/Documents",
          "${HOME}/Library/CloudStorage/Dropbox-Fonsdar/",
        ],
      },
    });

    expect(parseAllowedDirectoryArgs(config.args)).toEqual([
      `${homedir()}/Documents`,
      `${homedir()}/Library/CloudStorage/Dropbox-Fonsdar/`,
    ]);
  });

  it("still cannot read anything from the inert env channel", () => {
    const config = buildHostMcpConfig(PACKED_MANIFEST);
    expect(expandHostPlaceholders(config.env.ALLOWED_DIRECTORIES))
      .toBe("${user_config.allowed_directories}");
  });
});
