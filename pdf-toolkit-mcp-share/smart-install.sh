#!/bin/bash

function show_manual_instructions() {
    echo ""
    echo "📋 MANUAL METHOD - Copy this exact text to ~/.cursor/mcp.json:"
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
    echo "💡 To open the file: open ~/.cursor/mcp.json"
}

echo "🚀 Installing PDF Tools MCP Server..."

# Navigate to the script's directory
cd "$(dirname "$0")"

# Check if we're in Downloads folder
CURRENT_DIR="$(pwd)"
if [[ "$CURRENT_DIR" == *"/Downloads/"* ]]; then
    echo "⚠️  Installing from Downloads folder"
    echo "📂 Moving to permanent location for safety..."
    echo ""
    
    # Create permanent location
    PERMANENT_DIR="$HOME/.pdf-tools-mcp"
    
    if [ -d "$PERMANENT_DIR" ]; then
        echo "🔄 Updating existing installation at $PERMANENT_DIR"
        rm -rf "$PERMANENT_DIR"
    else
        echo "📁 Creating permanent installation at $PERMANENT_DIR"
    fi
    
    # Create directory and copy files
    mkdir -p "$PERMANENT_DIR"
    cp -r * "$PERMANENT_DIR/"
    
    echo "✅ Files moved to permanent location"
    echo "💡 You can now safely delete the Downloads folder contents"
    echo ""
    
    # Switch to the permanent directory
    cd "$PERMANENT_DIR"
    chmod +x *.sh *.command
fi

npm install
echo "✅ Dependencies installed!"
echo ""

# Get the absolute path automatically
FULL_PATH="$(pwd)/server/index.js"
MCP_CONFIG="$HOME/.cursor/mcp.json"

echo "✨ Server installed at: $FULL_PATH"
echo ""

# Check if mcp.json exists
if [ -f "$MCP_CONFIG" ]; then
    echo "📂 Found existing MCP config at: $MCP_CONFIG"
    echo ""
    echo "🤖 Would you like me to automatically add pdf-tools to your config? (y/n)"
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
"
        if [ $? -eq 0 ]; then
            echo ""
            echo "🎉 DONE! pdf-tools has been added to your MCP config!"
            echo ""
            echo "📍 Permanent location: $FULL_PATH"
            echo ""
            echo "🔄 Next steps:"
            echo "1. Completely quit Cursor"
            echo "2. Restart Cursor"
            echo "3. Look for 'pdf-tools' in Cursor's MCP servers"
            echo ""
            echo "🎯 You're all set! Safe to delete Downloads folder now."
        else
            echo "⚠️  Auto-update failed. Please use manual method below."
            show_manual_instructions
        fi
    else
        show_manual_instructions
    fi
else
    echo "📂 No existing MCP config found. Creating new one..."
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
    
    echo "✅ Created new MCP config with pdf-tools!"
    echo ""
    echo "📍 Permanent location: $FULL_PATH"
    echo ""
    echo "🔄 Next steps:"
    echo "1. Completely quit Cursor"
    echo "2. Restart Cursor"
    echo "3. Look for 'pdf-tools' in Cursor's MCP servers"
    echo ""
    echo "✨ Safe to delete Downloads folder now!"
fi 
