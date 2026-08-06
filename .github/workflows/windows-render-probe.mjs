// Measures the Claude Desktop shape on Windows: an embedded Electron host with
// no macOS system renderer. Writes a machine-readable result so the workflow
// artifact carries evidence rather than only console output.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = process.cwd();
const serverUrl = pathToFileURL(path.join(root, "server", "index.js")).href;
const bootstrap = [
  'process.type = "utility";',
  'Object.defineProperty(process.versions, "electron", { value: "test", configurable: true });',
  `await import(${JSON.stringify(serverUrl)});`,
].join(" ");

async function probe(label, extraEnv) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--input-type=module", "--eval", bootstrap],
    cwd: root,
    env: {
      ALLOWED_DIRECTORIES: root,
      PDF_TOOLS_DISABLE_SYSTEM_RENDERER: "1",
      ...extraEnv,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "windows-render-probe", version: "1.0.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "render_pdf_page",
      arguments: {
        pdf_path: path.join(root, "example-fw9.pdf"),
        page: 1,
        max_dimension_px: 800,
      },
    });
    return {
      label,
      is_error: result.isError === true,
      renderer: result.structuredContent?.renderer ?? null,
      detail: result.isError ? JSON.stringify(result.content).slice(0, 400) : null,
    };
  } finally {
    await transport.close();
  }
}

const optIn = process.env.PDF_TOOLS_EMBEDDED_NATIVE_CANVAS === "1";
const results = [
  // "0", not "". Native canvas now defaults ON for win32, so an empty value
  // means allowed here and this arm would stop being a control.
  await probe("embedded host, block in force", {
    PDF_TOOLS_EMBEDDED_NATIVE_CANVAS: "0",
  }),
  // The win32 default with no override at all. This is what a real user gets.
  await probe("embedded host, platform default", {
    PDF_TOOLS_EMBEDDED_NATIVE_CANVAS: "",
  }),
];
if (optIn) {
  results.push(await probe("embedded host, block lifted", {
    PDF_TOOLS_EMBEDDED_NATIVE_CANVAS: "1",
  }));
}

const summary = {
  platform: process.platform,
  architecture: process.arch,
  node_version: process.version,
  opt_in_exercised: optIn,
  results,
};
await writeFile(
  path.join(root, "windows-render-probe.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
for (const entry of results) {
  console.log(`${entry.label}: is_error=${entry.is_error} renderer=${entry.renderer ?? "(none)"}`);
  if (entry.detail) console.log(`  detail: ${entry.detail}`);
}

// Assert every arm, not just the opt-in. A control that is recorded but never
// checked is not a control: this job previously would have stayed green if the
// kill switch had silently stopped blocking.
const failures = [];

const blocked = results.find(entry => entry.label.endsWith("block in force"));
if (!blocked || !blocked.is_error) {
  failures.push("PDF_TOOLS_EMBEDDED_NATIVE_CANVAS=0 did not block native canvas.");
}

const platformDefault = results.find(entry => entry.label.endsWith("platform default"));
if (process.platform === "win32") {
  if (!platformDefault || platformDefault.is_error) {
    failures.push("Native canvas is expected to be ON by default on win32, but the default arm failed.");
  } else if (platformDefault.renderer !== "native-canvas") {
    failures.push(`win32 default rendered via "${platformDefault.renderer}", expected "native-canvas".`);
  }
} else if (platformDefault && !platformDefault.is_error) {
  failures.push(`Native canvas is expected to stay OFF by default on ${process.platform}, but it rendered.`);
}

if (optIn) {
  const lifted = results.find(entry => entry.label.endsWith("block lifted"));
  if (!lifted || lifted.is_error) {
    failures.push("Windows render remains unavailable with the block lifted.");
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
