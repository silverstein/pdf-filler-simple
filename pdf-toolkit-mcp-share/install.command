#!/bin/bash

function show_manual_method() {
    echo ""
    echo "📋 MANUAL METHOD:"
    echo "Copy this to ~/.cursor/mcp.json:"
    echo ""
    "$SOURCE_DIR/configure-cursor.sh" print "$FULL_PATH"
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
        
        if "$SOURCE_DIR/configure-cursor.sh" update "$MCP_CONFIG" "$FULL_PATH"; then
            echo "✅ Successfully updated pdf-tools in MCP config!"
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
    if ! "$SOURCE_DIR/configure-cursor.sh" update "$MCP_CONFIG" "$FULL_PATH"; then
        show_manual_method
        exit 1
    fi
    echo "✅ Created MCP config with PDF Tools!"
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
