#!/bin/bash

set -e
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SOURCE_DIR"

echo "🚀 Installing PDF Tools MCP Server..."
echo "📦 Installing the reviewed production dependency graph..."
npm ci --omit=dev --engine-strict --no-audit --no-fund
echo "✅ Locked dependencies installed!"
echo ""

# Get the absolute path automatically
FULL_PATH="$(pwd)/server/index.js"

echo "🎯 COPY THIS EXACT TEXT to your ~/.cursor/mcp.json:"
echo ""
echo "==============================================="
"$SOURCE_DIR/configure-cursor.sh" print "$FULL_PATH"
echo "==============================================="
echo ""
echo "📂 Your MCP config file is located at:"
echo "   ~/.cursor/mcp.json"
echo ""
echo "💡 To open it quickly:"
echo "   Mac/Linux: open ~/.cursor/mcp.json"
echo "   Or: code ~/.cursor/mcp.json"
echo ""
echo "📝 If you already have other MCP servers, just add the pdf-tools part inside your existing mcpServers section!"
echo ""
echo "🔄 After saving the file:"
echo "1. Completely quit Cursor"
echo "2. Restart Cursor" 
echo "3. Look for 'pdf-tools' in Cursor's MCP servers"
echo ""
echo "✨ The full server path detected: $FULL_PATH"
