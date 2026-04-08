#!/bin/bash

echo "🚀 Installing PDF Tools MCP Server..."
npm install
echo "✅ Dependencies installed!"
echo ""

# Get the absolute path automatically
FULL_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/server/index.js"

echo "🎯 COPY THIS EXACT TEXT to your ~/.cursor/mcp.json:"
echo ""
echo "==============================================="
echo '{'
echo '  "mcpServers": {'
echo '    "pdf-tools": {'
echo '      "command": "node",'
echo "      \"args\": [\"$FULL_PATH\"]"
echo '    }'
echo '  }'
echo '}'
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
