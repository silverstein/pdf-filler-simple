#!/bin/bash

set -u

MODE="${1:-}"
if [ "$MODE" = "print" ]; then
    CONFIG_PATH=""
    SERVER_PATH="${2:-}"
elif [ "$MODE" = "update" ]; then
    CONFIG_PATH="${2:-}"
    SERVER_PATH="${3:-}"
else
    echo "Usage: configure-cursor.sh print <server-path> | update <config-path> <server-path>" >&2
    exit 2
fi

if [ -z "$SERVER_PATH" ] || { [ "$MODE" = "update" ] && [ -z "$CONFIG_PATH" ]; }; then
    echo "❌ Cursor configuration paths must not be empty." >&2
    exit 2
fi

python3 - "$MODE" "$CONFIG_PATH" "$SERVER_PATH" <<'PY'
import json
import os
import sys
import tempfile

mode, config_path, server_path = sys.argv[1:4]


def configured_document(existing=None):
    document = {} if existing is None else existing
    if not isinstance(document, dict):
        raise ValueError("Cursor config root must be a JSON object")
    servers = document.setdefault("mcpServers", {})
    if not isinstance(servers, dict):
        raise ValueError("Cursor config mcpServers must be a JSON object")
    servers["pdf-tools"] = {
        "command": "node",
        "args": [server_path],
    }
    return document


try:
    if mode == "print":
        json.dump(configured_document(), sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
        raise SystemExit(0)

    existing = None
    if os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as source:
            existing = json.load(source)
    document = configured_document(existing)
    parent = os.path.dirname(os.path.abspath(config_path))
    os.makedirs(parent, exist_ok=True)
    descriptor, temporary_path = tempfile.mkstemp(prefix=".mcp.json.tmp.", dir=parent, text=True)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as destination:
            json.dump(document, destination, indent=2, ensure_ascii=False)
            destination.write("\n")
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(temporary_path, config_path)
    except BaseException:
        try:
            os.unlink(temporary_path)
        except FileNotFoundError:
            pass
        raise
except Exception as error:
    print(f"❌ Cursor configuration failed: {error}", file=sys.stderr)
    raise SystemExit(1)
PY
