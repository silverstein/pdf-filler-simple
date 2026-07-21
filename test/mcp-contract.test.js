import fs from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const SOURCE_MANIFEST = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "manifest.json"), "utf8"));
const MCPB_MANIFEST = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "manifest.mcpb.json"), "utf8"));
const EXAMPLE_PDF = path.join(REPO_ROOT, "example-fw9.pdf");

const RUNTIMES = [
  { name: "source/MCPB", root: REPO_ROOT },
  { name: "share package", root: path.join(REPO_ROOT, "pdf-toolkit-mcp-share") },
];

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function names(entries) {
  return entries.map(entry => entry.name);
}

function renderManifestPrompt(prompt, suppliedArguments) {
  let text = prompt.text;
  for (const argumentName of prompt.arguments ?? []) {
    text = text.split(`\${arguments.${argumentName}}`).join(suppliedArguments[argumentName]);
  }
  return text;
}

async function captureMcpError(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected MCP operation to fail");
}

async function startRuntime(runtime) {
  const stateRoot = await fs.mkdtemp(path.join(tmpdir(), "pdf-tools-contract-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(runtime.root, "server", "index.js")],
    cwd: runtime.root,
    env: {
      ALLOWED_DIRECTORIES: REPO_ROOT,
      DEFAULT_PROFILES_DIR: path.join(stateRoot, "profiles"),
    },
    stderr: "ignore",
  });
  const client = new Client({
    name: "pdf-tools-contract-test",
    version: "1.0.0",
  });
  await client.connect(transport);
  return { client, stateRoot };
}

describe("MCPB static declarations", () => {
  it("keeps source and packed prompt declarations identical", () => {
    expect(MCPB_MANIFEST.prompts).toEqual(SOURCE_MANIFEST.prompts);
    expect(MCPB_MANIFEST.prompts_generated).toBeUndefined();
  });

  it("declares the packed manifest's intentional app-only tool exception", () => {
    expect(MCPB_MANIFEST.tools_generated).toBe(true);
    expect(names(SOURCE_MANIFEST.tools)).toContain("read_pdf_bytes");
    expect(names(MCPB_MANIFEST.tools)).not.toContain("read_pdf_bytes");
    expect(sorted(names(SOURCE_MANIFEST.tools))).toEqual(
      sorted([...names(MCPB_MANIFEST.tools), "read_pdf_bytes"]),
    );
  });

  it("uses a valid stdio entry point for both distribution modes", async () => {
    const sharePackage = JSON.parse(
      await fs.readFile(path.join(REPO_ROOT, "pdf-toolkit-mcp-share", "package.json"), "utf8"),
    );
    expect(MCPB_MANIFEST.server).toMatchObject({
      type: "node",
      entry_point: "server/index.js",
    });
    expect(sharePackage).toMatchObject({
      type: "module",
      main: "server/index.js",
    });
    await expect(fs.access(path.join(REPO_ROOT, MCPB_MANIFEST.server.entry_point))).resolves.toBeUndefined();
    await expect(fs.access(path.join(REPO_ROOT, "pdf-toolkit-mcp-share", sharePackage.main))).resolves.toBeUndefined();
  });
});

describe.each(RUNTIMES)("$name runtime discovery", runtime => {
  let client;
  let stateRoot;
  let tools;

  beforeAll(async () => {
    ({ client, stateRoot } = await startRuntime(runtime));
    ({ tools } = await client.listTools());
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await fs.rm(stateRoot, { recursive: true, force: true });
  });

  it("advertises only discovery surfaces it implements", () => {
    expect(client.getServerVersion()).toEqual({
      name: "pdf-tools",
      version: SOURCE_MANIFEST.version,
    });
    expect(client.getServerCapabilities()).toEqual({
      prompts: {},
      resources: {},
      tools: {},
    });
  });

  it("exposes the same uniquely named, fully annotated tool contract", () => {
    expect(tools).toHaveLength(37);
    expect(new Set(names(tools)).size).toBe(tools.length);
    expect(sorted(names(tools))).toEqual(sorted(names(SOURCE_MANIFEST.tools)));

    for (const tool of tools) {
      expect(tool.description, `${tool.name} description`).toEqual(expect.any(String));
      expect(tool.inputSchema, `${tool.name} input schema`).toMatchObject({ type: "object" });
      expect(tool.annotations, `${tool.name} annotations`).toMatchObject({
        title: expect.any(String),
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
    }

    const appOnlyTools = tools.filter(tool => tool._meta?.ui?.visibility?.includes("app"));
    expect(names(appOnlyTools)).toEqual(["read_pdf_bytes"]);
    expect(sorted(names(tools.filter(tool => !appOnlyTools.includes(tool))))).toEqual(
      sorted(names(MCPB_MANIFEST.tools)),
    );
  });

  it("lists and renders every manifest-declared prompt", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts).toEqual(SOURCE_MANIFEST.prompts.map(prompt => ({
      name: prompt.name,
      description: prompt.description,
      ...(prompt.arguments ? {
        arguments: prompt.arguments.map(name => ({ name, required: true })),
      } : {}),
    })));

    for (const prompt of SOURCE_MANIFEST.prompts) {
      const suppliedArguments = Object.fromEntries(
        (prompt.arguments ?? []).map(name => [name, `value-$&-${name}`]),
      );
      const result = await client.getPrompt({
        name: prompt.name,
        arguments: suppliedArguments,
      });
      expect(result).toEqual({
        description: prompt.description,
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: renderManifestPrompt(prompt, suppliedArguments),
          },
        }],
      });
    }
  });

  it("rejects invalid prompt discovery deterministically", async () => {
    const missingArgument = await captureMcpError(() => client.getPrompt({
      name: "view_and_analyze_pdf",
    }));
    expect(missingArgument).toMatchObject({ code: -32602 });
    expect(missingArgument.message).toContain("Missing required argument");

    const unknownArgument = await captureMcpError(() => client.getPrompt({
      name: "fill_w9_business",
      arguments: { unexpected: "value" },
    }));
    expect(unknownArgument).toMatchObject({ code: -32602 });
    expect(unknownArgument.message).toContain("Unknown argument");

    const unknownPrompt = await captureMcpError(() => client.getPrompt({
      name: "not_a_pdf_tools_prompt",
    }));
    expect(unknownPrompt).toMatchObject({ code: -32602 });
    expect(unknownPrompt.message).toContain("Unknown prompt");
  });

  it("lists and reads the static MCP Apps resource", async () => {
    const { resources } = await client.listResources();
    expect(resources).toEqual([{
      uri: "ui://pdf-toolkit/viewer",
      name: "PDF Form Viewer",
      mimeType: "text/html;profile=mcp-app",
    }]);

    const result = await client.readResource({ uri: "ui://pdf-toolkit/viewer" });
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]).toMatchObject({
      uri: "ui://pdf-toolkit/viewer",
      mimeType: "text/html;profile=mcp-app",
      text: expect.stringContaining("<!DOCTYPE html>"),
    });
  });

  it("calls the resource-URI tool and reads the dynamic PDF resource", async () => {
    const uriResult = await client.callTool({
      name: "get_pdf_resource_uri",
      arguments: { pdf_path: EXAMPLE_PDF },
    });
    expect(uriResult.isError).not.toBe(true);
    const text = uriResult.content.find(item => item.type === "text")?.text ?? "";
    const expectedUri = `pdf://${EXAMPLE_PDF}`;
    expect(text).toContain(expectedUri);

    const resource = await client.readResource({ uri: expectedUri });
    expect(resource.contents).toHaveLength(1);
    expect(resource.contents[0]).toMatchObject({
      uri: expectedUri,
      mimeType: "application/pdf",
      blob: expect.any(String),
    });
    expect(Buffer.from(resource.contents[0].blob, "base64").subarray(0, 5).toString("ascii"))
      .toBe("%PDF-");
  });

  it("returns structured content with a text fallback for non-Apps clients", async () => {
    const result = await client.callTool({
      name: "get_active_document",
      arguments: {},
    });
    expect(result.structuredContent).toEqual({
      active_path: null,
      backup_path: null,
      last_mutation_tool: null,
      last_mutation_at: null,
    });
    expect(result.content).toEqual([{
      type: "text",
      text: expect.stringContaining("No active document yet"),
    }]);
  });

  it("returns method-not-found for unsupported resource-template discovery", async () => {
    const error = await captureMcpError(() => client.listResourceTemplates());
    expect(error).toMatchObject({ code: -32601 });
    expect(error.message).toContain("Method not found");
  });
});
