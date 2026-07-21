#!/bin/bash

set -u

MODE="${1:-}"
CONFIG_PATH=""
SERVER_PATH=""
BACKUP_PATH=""

case "$MODE" in
    print)
        SERVER_PATH="${2:-}"
        ;;
    update)
        CONFIG_PATH="${2:-}"
        SERVER_PATH="${3:-}"
        ;;
    backup)
        CONFIG_PATH="${2:-}"
        BACKUP_PATH="${3:-}"
        ;;
    *)
        echo "Usage: configure-cursor.sh print <server-path> | update <config-path> <server-path> | backup <config-path> <backup-path>" >&2
        exit 2
        ;;
esac

if { [ "$MODE" = "print" ] && [ -z "$SERVER_PATH" ]; } ||
   { [ "$MODE" = "update" ] && { [ -z "$CONFIG_PATH" ] || [ -z "$SERVER_PATH" ]; }; } ||
   { [ "$MODE" = "backup" ] && { [ -z "$CONFIG_PATH" ] || [ -z "$BACKUP_PATH" ]; }; }; then
    echo "❌ Cursor configuration paths must not be empty." >&2
    exit 2
fi

node --input-type=commonjs - "$MODE" "$CONFIG_PATH" "$SERVER_PATH" "$BACKUP_PATH" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [mode, configPath, serverPath, backupPath] = process.argv.slice(2);

function configuredDocument(existing = undefined) {
  const document = existing === undefined ? {} : existing;
  if (!document || Array.isArray(document) || typeof document !== "object") {
    throw new Error("Cursor config root must be a JSON object");
  }
  if (document.mcpServers === undefined) document.mcpServers = {};
  if (!document.mcpServers || Array.isArray(document.mcpServers) || typeof document.mcpServers !== "object") {
    throw new Error("Cursor config mcpServers must be a JSON object");
  }
  document.mcpServers["pdf-tools"] = {
    command: "node",
    args: [serverPath],
  };
  return document;
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Some supported filesystems do not allow directory fsync. File fsync and
    // same-directory rename still provide the portable atomic-write boundary.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function atomicWrite(filename, contents) {
  const absolutePath = path.resolve(filename);
  const parent = path.dirname(absolutePath);
  fs.mkdirSync(parent, { recursive: true });
  const temporaryPath = path.join(
    parent,
    `.mcp.json.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, absolutePath);
    fsyncDirectory(parent);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

try {
  if (mode === "print") {
    process.stdout.write(`${JSON.stringify(configuredDocument(), null, 2)}\n`);
  } else if (mode === "backup") {
    atomicWrite(backupPath, fs.readFileSync(configPath));
  } else {
    const existing = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, "utf8"))
      : undefined;
    atomicWrite(configPath, `${JSON.stringify(configuredDocument(existing), null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`❌ Cursor configuration failed: ${error.message}\n`);
  process.exitCode = 1;
}
NODE
