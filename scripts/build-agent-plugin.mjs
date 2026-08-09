// Build a self-contained Agent Plugins 1.0.0 plugin directory.
//
// The plugin is a directory that carries the server and its locked
// dependencies, launched with `command: "node"` and no npm, no npx, and no
// install step on the host. It reuses the MCPB build's staging verbatim —
// locked production deps, integrity-verified native canvas packages, a secret
// scan, and a symlink ban — so the two artifacts cannot drift. On top of that
// stage it drops a root `plugin.json`, an `mcp.json`, and the workflow skill,
// and removes the MCPB-only `manifest.json`.
//
// Usage: node scripts/build-agent-plugin.mjs [output-dir]
//   default output: dist-plugin/pdf-tools
//
// Coverage: this ships the same five native canvas platforms the MCPB ships,
// so rasterization works everywhere the MCPB does. A smaller no-render variant
// is a planned build flag, not yet implemented.

import { cpSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { prepareCleanStage } from "./build-mcpb.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const SKILLS_SOURCE = path.join(REPO_ROOT, "plugins", "pdf-tools-workflow", "skills");
const PACKAGE_JSON = JSON.parse(
  (await import("fs")).readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
);

const PLUGIN_MANIFEST_NAME = "pdf-tools";
const PLUGIN_DESCRIPTION =
  "Local PDF workflow: inspect, fill, sign, merge, split, extract, render, and validate PDFs on your machine. Bundles the server and its evidence-first workflow.";

const PLUGIN_MANIFEST = {
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: PLUGIN_MANIFEST_NAME,
  version: PACKAGE_JSON.version,
  description: PLUGIN_DESCRIPTION,
  author: {
    name: "Open Document Alliance",
    url: "https://www.opendocuments.ai",
  },
  // The install-facing page, not the source tree: this is what a plugin
  // browser links to, and the reader has just installed and needs the
  // first-run and troubleshooting notes.
  homepage: "https://github.com/Open-Document-Alliance/pdf-tools-plugin",
  repository: "https://github.com/Open-Document-Alliance/PDF-Tools",
  license: "MIT",
  keywords: ["pdf", "forms", "signature", "extraction", "accessibility", "mcp"],
};

// The Agent Plugins manifest schema is closed and carries no icon or
// presentation field, so a plugin shipping only `plugin.json` renders in a
// host's plugin browser with a placeholder icon, no description, and an empty
// website field. That metadata belongs in a namespaced sibling manifest.
// Measured against the 180 plugins in OpenAI's curated marketplace on
// 2026-08-09: 179 set `interface.logo` and 177 set `interface.composerIcon`,
// PNG in 167 and 150 cases. This follows that convention rather than inventing
// one, and it is emitted here so a release cannot silently drop it.
const CODEX_MANIFEST = {
  name: PLUGIN_MANIFEST_NAME,
  version: PACKAGE_JSON.version,
  description: PLUGIN_DESCRIPTION,
  author: { name: "Open Document Alliance", url: "https://www.opendocuments.ai" },
  homepage: "https://github.com/Open-Document-Alliance/pdf-tools-plugin",
  repository: "https://github.com/Open-Document-Alliance/PDF-Tools",
  license: "MIT",
  keywords: ["pdf", "forms", "signature", "extraction", "accessibility", "mcp"],
  skills: "./skills/",
  mcpServers: "./mcp.json",
  interface: {
    displayName: "PDF Tools",
    shortDescription: "Local PDF workstation: read, fill, sign, compare, convert.",
    longDescription:
      "Work with PDFs on your own machine. Read text and layout with real coordinates, convert to Markdown with evidence-backed tables, fill and validate forms, merge, split and reorder pages, compare two documents across several channels, place signatures, and inspect accessibility signals. Files are never uploaded, and the extension only opens folders you have listed.",
    developerName: "Open Document Alliance",
    category: "Productivity",
    capabilities: ["Document workflows", "Forms", "Extraction", "Safety checks"],
    websiteURL: "https://github.com/Open-Document-Alliance/pdf-tools-plugin",
    privacyPolicyURL: "https://www.opendocuments.ai/privacy-policy",
    termsOfServiceURL: "https://www.opendocuments.ai/terms-of-service",
    logo: "./assets/pdf-tools.png",
    composerIcon: "./assets/pdf-tools.png",
    defaultPrompt: [
      "Read this PDF and tell me what is in it.",
      "Fill this form from my saved profile, then read the fields back.",
      "Compare these two PDFs and state every coverage gap.",
    ],
  },
};

const MCP_CONFIG = {
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: {
    "pdf-tools": {
      type: "stdio",
      command: "node",
      // Spec expands only ${PLUGIN_ROOT} and ${PLUGIN_DATA}. Nothing here
      // depends on ${HOME} or a host user-config mechanism, which is why the
      // server was made to fail closed rather than grant home folders when it
      // is handed no configuration.
      args: ["${PLUGIN_ROOT}/server/index.js"],
      cwd: "${PLUGIN_ROOT}",
    },
  },
};

function directoryStats(root) {
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) { files += 1; bytes += statSync(full).size; }
    }
  };
  walk(root);
  return { files, bytes };
}

// Launch the built server over stdio and confirm it lists tools. This proves
// the bundle actually starts from its own directory — worker paths resolved by
// adjacency, packages resolved from the bundled node_modules — without a host.
function smokeLaunch(pluginDir) {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(pluginDir, "server", "index.js");
    const child = spawn(process.execPath, [serverPath], {
      cwd: pluginDir,
      // No allowed directories configured: the server starts and lists tools,
      // and refuses file operations until configured. That is the intended
      // fail-closed posture, and it is what a fresh install looks like.
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("smoke launch timed out")); }, 20000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes('"tools"')) {
        clearTimeout(timer);
        child.kill("SIGKILL");
        resolve({ ok: true });
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!stdout.includes('"tools"')) {
        reject(new Error(`server exited (code ${code}) without listing tools.\nstderr:\n${stderr.slice(0, 2000)}`));
      }
    });
    // JSON-RPC: initialize, then tools/list.
    const initialize = {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "plugin-smoke", version: "1.0.0" } },
    };
    child.stdin.write(JSON.stringify(initialize) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  });
}

async function main() {
  const outputDir = path.resolve(process.argv[2] || path.join(REPO_ROOT, "dist-plugin", "pdf-tools"));
  console.error(`[plugin] building Agent Plugins bundle → ${outputDir}`);

  if (!existsSync(SKILLS_SOURCE)) {
    throw new Error(`workflow skills not found at ${SKILLS_SOURCE}`);
  }

  const { stagingDir } = prepareCleanStage();
  try {
    // The stage is the verified MCPB payload. Convert it to a plugin:
    // drop the MCPB manifest, add the Agent Plugins manifests and the skill.
    rmSync(path.join(stagingDir, "manifest.json"), { force: true });
    writeFileSync(path.join(stagingDir, "plugin.json"), JSON.stringify(PLUGIN_MANIFEST, null, 2) + "\n");
    writeFileSync(path.join(stagingDir, "mcp.json"), JSON.stringify(MCP_CONFIG, null, 2) + "\n");
    cpSync(SKILLS_SOURCE, path.join(stagingDir, "skills"), { recursive: true });

    // Listing presentation for hosts that read a namespaced sibling manifest.
    const iconSource = path.join(REPO_ROOT, "icon.png");
    if (!existsSync(iconSource)) throw new Error(`plugin icon not found at ${iconSource}`);
    mkdirSync(path.join(stagingDir, "assets"), { recursive: true });
    cpSync(iconSource, path.join(stagingDir, "assets", "pdf-tools.png"));
    mkdirSync(path.join(stagingDir, ".codex-plugin"), { recursive: true });
    writeFileSync(
      path.join(stagingDir, ".codex-plugin", "plugin.json"),
      JSON.stringify(CODEX_MANIFEST, null, 2) + "\n",
    );

    console.error("[plugin] smoke-launching the staged server over stdio…");
    await smokeLaunch(stagingDir);
    console.error("[plugin] server listed tools from its own directory.");

    rmSync(outputDir, { recursive: true, force: true });
    mkdirSync(path.dirname(outputDir), { recursive: true });
    cpSync(stagingDir, outputDir, { recursive: true });

    const { files, bytes } = directoryStats(outputDir);
    console.error(`[plugin] done: ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB uncompressed`);
    console.error(`[plugin] layout: plugin.json, mcp.json, .codex-plugin/, assets/, server/, skills/, node_modules/, dist-ui/`);
    console.error(`[plugin] note: a fresh install allows no directories. On first run the server`);
    console.error(`[plugin]       writes \${PLUGIN_DATA}/config.json and every refusal names that`);
    console.error(`[plugin]       path; the user lists their folders there and restarts.`);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[plugin] build failed: ${error.message}`);
  process.exit(1);
});
