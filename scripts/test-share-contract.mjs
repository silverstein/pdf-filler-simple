#!/usr/bin/env node

import { cpSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
}

async function expectMcpError(operation, code) {
  try {
    await operation();
  } catch (error) {
    if (error?.code === code) return;
    throw new Error(`Expected MCP error ${code}, received ${error?.code}: ${error?.message}`);
  }
  throw new Error(`Expected MCP error ${code}, but operation succeeded`);
}

async function main() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pdf-tools-share-contract-"));
  const buildRoot = path.join(tempRoot, "package-build");
  const extractedRoot = path.join(tempRoot, "extracted");
  const archivePath = path.join(buildRoot, "pdf-toolkit-mcp.zip");
  const packageRoot = path.join(extractedRoot, "pdf-toolkit-mcp-share");
  const specialFilename = process.platform === "win32"
    ? "quarterly #1 draft.pdf"
    : "quarterly #1 ? draft.pdf";
  const fixturePath = path.join(tempRoot, specialFilename);
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  let transport;

  try {
    mkdirSync(buildRoot, { recursive: true });
    for (const filename of ["package-for-friend.js", "package.json"]) {
      copyFileSync(path.join(REPO_ROOT, filename), path.join(buildRoot, filename));
    }
    for (const directory of ["server", "dist-ui", "pdf-toolkit-mcp-share"]) {
      cpSync(path.join(REPO_ROOT, directory), path.join(buildRoot, directory), { recursive: true });
    }

    // Exercise the real share packager, then install only what its extracted
    // archive contains. No dependency can resolve through the source checkout.
    run(process.execPath, ["package-for-friend.js"], buildRoot);
    run("unzip", ["-q", archivePath, "-d", extractedRoot], buildRoot);
    copyFileSync(path.join(REPO_ROOT, "example-fw9.pdf"), fixturePath);

    // Generate a lock from only the shipped package manifest, then prove that
    // exact isolated graph can be recreated with npm ci.
    run(npmCommand, [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ], packageRoot);
    run(npmCommand, [
      "ci",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ], packageRoot);

    const client = new Client({ name: "pdf-tools-isolated-share-contract", version: "1.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(packageRoot, "server", "index.js")],
      cwd: packageRoot,
      env: { ALLOWED_DIRECTORIES: tempRoot },
      stderr: "ignore",
    });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const { prompts } = await client.listPrompts();
    const { resources } = await client.listResources();
    if (tools.length !== 37 || prompts.length !== 14 || resources.length !== 1) {
      throw new Error(
        `Unexpected discovery counts: ${tools.length} tools, ${prompts.length} prompts, ` +
          `${resources.length} resources`,
      );
    }

    await expectMcpError(() => client.listTools({ cursor: "never-issued" }), -32602);

    const byteResult = await client.callTool({
      name: "read_pdf_bytes",
      arguments: { pdf_path: fixturePath, offset: 0, byteCount: 8 },
    });
    if (byteResult.isError || byteResult.structuredContent?.byteCount !== 8) {
      throw new Error("Generic-client read_pdf_bytes compatibility check failed");
    }

    const uriResult = await client.callTool({
      name: "get_pdf_resource_uri",
      arguments: { pdf_path: fixturePath },
    });
    const uri = uriResult.structuredContent?.uri;
    if (!uri || uri.includes(" ") || uri.includes("#") || uri.includes("?")) {
      throw new Error(`Share package returned a non-canonical resource URI: ${uri}`);
    }
    const resource = await client.readResource({ uri });
    if (Buffer.from(resource.contents?.[0]?.blob || "", "base64").subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new Error("Share package dynamic resource read failed");
    }

    await client.close();
    console.log(
      `Isolated share contract passed on ${process.platform}/${process.arch}: ` +
        `${tools.length} tools, ${prompts.length} prompts, canonical PDF resource round-trip.`,
    );
  } finally {
    await transport?.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`Isolated share contract failed: ${error.message}`);
  process.exitCode = 1;
});
