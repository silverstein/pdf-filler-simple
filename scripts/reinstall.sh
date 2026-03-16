#!/bin/bash
# Reinstall PDF Tools extension into Claude Desktop
# Usage: ./scripts/reinstall.sh

set -e

EXT_DIR="$HOME/Library/Application Support/Claude/Claude Extensions/local.mcpb.mat-silverstein.pdf-toolkit"
MCPB_FILE="pdf-toolkit-mcp.mcpb"
LOG_FILE="$HOME/Library/Logs/Claude/mcp-server-PDF Tools - View, Analyze, Extract, Fill.log"

echo "=== PDF Tools Extension Reinstall ==="
echo ""

# Step 1: Build UI
echo "[1/4] Building UI..."
npm run build:ui 2>&1 | tail -1

# Step 2: Pack MCPB
echo "[2/4] Packing MCPB..."
mcpb pack 2>&1 | tail -1

# Step 3: Remove old extension
if [ -d "$EXT_DIR" ]; then
  echo "[3/4] Removing old extension..."
  rm -rf "$EXT_DIR"
  echo "      Removed: $(basename "$EXT_DIR")"
else
  echo "[3/4] No existing extension found (clean install)"
fi

# Step 4: Install new extension by opening the .mcpb file
echo "[4/4] Installing new extension..."
open "$MCPB_FILE"

echo ""
echo "=== Done ==="
echo "Claude Desktop should prompt to install the extension."
echo ""
echo "To tail logs after testing:"
echo "  tail -f '$LOG_FILE'"
