#!/bin/bash

function show_manual_method() {
    echo ""
    echo "📋 MANUAL METHOD:"
    echo "Copy this to ~/.cursor/mcp.json:"
    echo ""
    echo "{"
    echo '  "mcpServers": {'
    echo '    "pdf-tools": {'
    echo '      "command": "node",'
    echo "      \"args\": [\"$FULL_PATH\"]"
    echo '    }'
    echo '  }'
    echo "}"
    echo ""
}

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PERMANENT_DIR="$HOME/.pdf-tools-mcp"
cd "$HOME" || exit 1

echo "🚀 PDF Tools MCP Server Installer"
echo "==================================="
echo ""

if ! "$SOURCE_DIR/install-transactional.sh" "$SOURCE_DIR" "$PERMANENT_DIR"; then
    echo "❌ Installation failed. Node.js ^20.19.0 or >=22.12.0 is required."
    echo "Visit: https://nodejs.org to install Node.js"
    read -p "Press Enter to exit..."
    exit 1
fi

echo ""

# Get the absolute path automatically
FULL_PATH="$PERMANENT_DIR/server/index.js"
MCP_CONFIG="$HOME/.cursor/mcp.json"

echo "✨ Server installed at: $FULL_PATH"
echo ""

# Check if mcp.json exists
if [ -f "$MCP_CONFIG" ]; then
    echo "📂 Found existing MCP config"
    echo ""
    echo "🤖 Should I automatically add pdf-tools to your Cursor config?"
    echo "   Type 'y' for Yes, 'n' for No"
    read -r response
    
    if [[ "$response" =~ ^[Yy]$ ]]; then
        # Create backup
        cp "$MCP_CONFIG" "$MCP_CONFIG.backup"
        echo "💾 Backup created: $MCP_CONFIG.backup"
        
        # Check if pdf-tools already exists and remove old entry
        if grep -q '"pdf-tools"' "$MCP_CONFIG"; then
            echo "🔄 Updating existing pdf-tools configuration..."
        fi
        
        # Use python to safely update JSON
        python3 -c "
import json
import sys

try:
    with open('$MCP_CONFIG', 'r') as f:
        config = json.load(f)
    
    if 'mcpServers' not in config:
        config['mcpServers'] = {}
    
    # Update or add pdf-tools config
    config['mcpServers']['pdf-tools'] = {
        'command': 'node',
        'args': ['$FULL_PATH']
    }
    
    with open('$MCP_CONFIG', 'w') as f:
        json.dump(config, f, indent=2)
    
    print('✅ Successfully updated pdf-tools in MCP config!')
except Exception as e:
    print(f'❌ Error: {e}')
    sys.exit(1)
" 2>/dev/null
        
        if [ $? -eq 0 ]; then
            echo ""
            echo "🎉 SUCCESS! PDF Tools has been installed!"
            echo ""
            echo "📍 Permanent location: $FULL_PATH"
            echo ""
            echo "🔄 Final steps:"
            echo "1. Completely quit Cursor (Cmd+Q)"
            echo "2. Restart Cursor"
            echo "3. Look for 'pdf-tools' in Cursor's MCP servers"
            echo ""
            echo "✨ You're all set! Safe to delete Downloads folder now."
        else
            show_manual_method
        fi
    else
        show_manual_method
    fi
else
    echo "📂 Creating new MCP config..."
    mkdir -p "$(dirname "$MCP_CONFIG")"
    
    cat > "$MCP_CONFIG" << EOF
{
  "mcpServers": {
    "pdf-tools": {
      "command": "node",
      "args": ["$FULL_PATH"]
    }
  }
}
EOF
    
    echo "✅ Created MCP config with PDF Filler!"
    echo ""
    echo "📍 Permanent location: $FULL_PATH" 
    echo ""
    echo "🔄 Final steps:"
    echo "1. Completely quit Cursor (Cmd+Q)"
    echo "2. Restart Cursor"  
    echo "3. Look for 'pdf-tools' in Cursor's MCP servers"
    echo ""
    echo "✨ Safe to delete Downloads folder now!"
fi

echo ""
echo "🎯 Installation complete! This window will close in 15 seconds..."
echo "   Or press Enter to close now"

read -t 15 -r 
