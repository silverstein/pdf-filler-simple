#!/usr/bin/env node

import { createHash } from "crypto";
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PROTECTED_DIRECT_DEPENDENCIES = {
  "@modelcontextprotocol/sdk": "1.29.0",
  "@napi-rs/canvas": "0.1.99",
  "pdf-lib": "1.17.1",
  "pdfjs-dist": "5.4.624",
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function expectFailure(command, args, cwd, pattern) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.error) throw result.error;
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status === 0 || !pattern.test(output)) {
    throw new Error(
      `${command} ${args.join(" ")} did not fail closed as expected: ${output}`,
    );
  }
}

function walkFiles(root, relativeRoot = "") {
  const files = [];
  for (const entry of readdirSync(path.join(root, relativeRoot)).sort()) {
    const relativePath = path.posix.join(relativeRoot.split(path.sep).join(path.posix.sep), entry);
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      files.push(...walkFiles(root, relativePath));
    } else if (stat.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Unexpected non-file archive entry at ${relativePath}`);
    }
  }
  return files;
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
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
    for (const filename of ["package-for-friend.js", "package.json", "package-lock.json"]) {
      copyFileSync(path.join(REPO_ROOT, filename), path.join(buildRoot, filename));
    }
    for (const directory of ["server", "dist-ui", "pdf-toolkit-mcp-share"]) {
      cpSync(path.join(REPO_ROOT, directory), path.join(buildRoot, directory), { recursive: true });
    }

    // Build twice from identical sources. A timestamp, file-order, or metadata
    // regression must change the bytes and fail this contract.
    run(process.execPath, ["package-for-friend.js"], buildRoot);
    const firstArchiveBytes = readFileSync(archivePath);
    run(process.execPath, ["package-for-friend.js"], buildRoot);
    const secondArchiveBytes = readFileSync(archivePath);
    const archiveSha256 = sha256(secondArchiveBytes);
    assertEqual(sha256(firstArchiveBytes), archiveSha256, "Share ZIP is not byte-reproducible");

    // Adversarially change a protected locked version while leaving its semver
    // manifest range valid. Packaging must reject the drift before overwriting
    // the last good artifact.
    const disposableShareLockPath = path.join(buildRoot, "pdf-toolkit-mcp-share", "package-lock.json");
    const tamperedLock = JSON.parse(readFileSync(disposableShareLockPath, "utf8"));
    tamperedLock.packages["node_modules/@napi-rs/canvas"].version = "0.1.100";
    writeFileSync(disposableShareLockPath, `${JSON.stringify(tamperedLock, null, 2)}\n`);
    expectFailure(
      process.execPath,
      ["package-for-friend.js"],
      buildRoot,
      /Share lock drifted from the reviewed root lock for @napi-rs\/canvas/,
    );
    assertEqual(sha256(readFileSync(archivePath)), archiveSha256, "Rejected build overwrote the last good ZIP");

    run("unzip", ["-q", archivePath, "-d", extractedRoot], buildRoot);
    copyFileSync(path.join(REPO_ROOT, "example-fw9.pdf"), fixturePath);

    // The archive is an explicit allowlist with an embedded digest manifest.
    // Verify the manifest against bytes from the final extracted artifact.
    const provenancePath = path.join(packageRoot, "SHARE-PROVENANCE.json");
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
    assertEqual(provenance.schema_version, "1.0", "Unexpected share provenance schema");
    assertEqual(provenance.dependency_lock.lockfile_version, 3, "Unexpected npm lockfile version");
    const extractedFiles = walkFiles(packageRoot);
    const manifestedFiles = Object.keys(provenance.files).sort();
    const expectedFiles = [...manifestedFiles, "SHARE-PROVENANCE.json"].sort();
    assertEqual(JSON.stringify(extractedFiles), JSON.stringify(expectedFiles), "Archive file allowlist drifted");
    for (const relativePath of manifestedFiles) {
      const digest = sha256(readFileSync(path.join(packageRoot, ...relativePath.split("/"))));
      assertEqual(digest, provenance.files[relativePath], `Provenance mismatch for ${relativePath}`);
    }
    if (process.platform !== "win32") {
      for (const installer of ["install.command", "install.sh", "smart-install.sh"]) {
        if ((statSync(path.join(packageRoot, installer)).mode & 0o111) === 0) {
          throw new Error(`Archive lost executable mode for ${installer}`);
        }
      }
    }

    const lockPath = path.join(packageRoot, "package-lock.json");
    const lockBytesBeforeInstall = readFileSync(lockPath);
    assertEqual(
      sha256(lockBytesBeforeInstall),
      provenance.dependency_lock.sha256,
      "Provenance does not bind the shipped dependency lock",
    );

    // Runtime and UI bytes in the archive must be identical to their canonical
    // source counterparts, not merely self-consistent with the manifest.
    for (const relativePath of [
      "server/helpers.js",
      "server/index.js",
      "server/resource-uri.js",
      "server/stderr-suppression.js",
      "dist-ui/index.html",
    ]) {
      const canonicalPath = path.join(REPO_ROOT, relativePath);
      assertEqual(
        sha256(readFileSync(path.join(packageRoot, ...relativePath.split("/")))),
        sha256(readFileSync(canonicalPath)),
        `Archive/source parity failed for ${relativePath}`,
      );
    }

    const sharePackage = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    const shareLock = JSON.parse(lockBytesBeforeInstall.toString("utf8"));
    assertEqual(sharePackage.dependencies["pdfjs-dist"], "5.4.624", "pdfjs-dist manifest pin changed");
    for (const [dependencyName, expectedVersion] of Object.entries(PROTECTED_DIRECT_DEPENDENCIES)) {
      assertEqual(
        shareLock.packages[`node_modules/${dependencyName}`]?.version,
        expectedVersion,
        `Protected locked dependency ${dependencyName} changed`,
      );
    }

    // Install only the reviewed graph shipped inside the ZIP. The cache is
    // isolated under this disposable proof root and cannot resolve packages
    // through the source checkout.
    run(npmCommand, [
      "ci",
      "--omit=dev",
      "--engine-strict",
      "--no-audit",
      "--no-fund",
      "--cache",
      path.join(tempRoot, "npm-cache"),
    ], packageRoot);
    assertEqual(
      sha256(readFileSync(lockPath)),
      sha256(lockBytesBeforeInstall),
      "npm ci mutated the shipped lockfile",
    );

    const installedGraph = JSON.parse(run(npmCommand, ["ls", "--omit=dev", "--json"], packageRoot));
    for (const [dependencyName, expectedVersion] of Object.entries(PROTECTED_DIRECT_DEPENDENCIES)) {
      assertEqual(
        installedGraph.dependencies?.[dependencyName]?.version,
        expectedVersion,
        `Installed dependency ${dependencyName} drifted from the reviewed lock`,
      );
    }

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

    const render = await client.callTool({
      name: "render_pdf_page",
      arguments: { pdf_path: fixturePath, page: 1, max_dimension_px: 800 },
    });
    const image = render.content?.find(item => item.type === "image" && item.mimeType === "image/png");
    if (render.isError || !image || Buffer.from(image.data, "base64").subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error("Share package native render_pdf_page did not return a valid PNG");
    }

    await client.close();
    console.log(
      `Reproducible isolated share contract passed on ${process.platform}/${process.arch}: ` +
        `${tools.length} tools, ${prompts.length} prompts, native raster image, SHA-256 ${archiveSha256}.`,
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
