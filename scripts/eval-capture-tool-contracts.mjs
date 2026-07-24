#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = path.join(
  REPO_ROOT, "test", "fixtures", "eval", "trajectories", "tool-contracts.v3.json"
);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function captureTrajectoryToolContracts({ outputPath = DEFAULT_OUTPUT } = {}) {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-tools-trajectory-contract-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO_ROOT, "server", "index.js")],
    cwd: REPO_ROOT,
    env: {
      ALLOWED_DIRECTORIES: [REPO_ROOT, stateRoot].join(path.delimiter),
      DEFAULT_PROFILES_DIR: path.join(stateRoot, "profiles"),
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "pdf-tools-trajectory-contract-capture", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const projectedTools = tools
      .map(tool => ({ name: tool.name, input_schema: tool.inputSchema }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const serverVersion = client.getServerVersion();
    const contract = {
      contract_schema_version: 1,
      contract_id: "pdf-tools.trajectory.tool-contracts.v3",
      runtime: {
        name: serverVersion?.name,
        version: serverVersion?.version,
      },
      tools_sha256: digest(canonicalJson(projectedTools)),
      tools: projectedTools,
    };
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(contract, null, 2)}\n`);
    return contract;
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputIndex = process.argv.indexOf("--output");
  const outputPath = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : DEFAULT_OUTPUT;
  const contract = await captureTrajectoryToolContracts({ outputPath });
  process.stdout.write(`${contract.tools.length} runtime tool contracts written to ${outputPath}\n`);
}
