#!/bin/bash

function show_manual_instructions() {
    echo ""
    echo "📋 MANUAL METHOD - Copy this exact text to ~/.cursor/mcp.json:"
    echo ""
    echo "==============================================="
    "$SOURCE_DIR/configure-cursor.sh" print "$FULL_PATH"
    echo "==============================================="
    echo ""
    echo "💡 To open the file: open ~/.cursor/mcp.json"
}

echo "🚀 Installing PDF Tools MCP Server..."

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PERMANENT_DIR="$HOME/.pdf-tools-mcp"
cd "$HOME" || exit 1

if ! "$SOURCE_DIR/install-transactional.sh" "$SOURCE_DIR" "$PERMANENT_DIR"; then
    echo "❌ Installation failed. Node.js ^20.19.0 or >=22.12.0 is required."
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
    echo "📂 Found existing MCP config at: $MCP_CONFIG"
    echo ""
    echo "🤖 Would you like me to automatically add pdf-tools to your config? (y/n)"
    read -r response
    
    if [[ "$response" =~ ^[Yy]$ ]]; then
        # Create and fsync an atomic backup before changing the config.
        if ! "$SOURCE_DIR/configure-cursor.sh" backup "$MCP_CONFIG" "$MCP_CONFIG.backup"; then
            echo "❌ Could not create a safe config backup. Configuration was not changed."
            show_manual_instructions
            exit 1
        fi
        echo "💾 Backup created: $MCP_CONFIG.backup"
        
        # Check if pdf-tools already exists and remove old entry
        if grep -q '"pdf-tools"' "$MCP_CONFIG"; then
            echo "🔄 Updating existing pdf-tools configuration..."
        fi
        
        if "$SOURCE_DIR/configure-cursor.sh" update "$MCP_CONFIG" "$FULL_PATH"; then
            echo "✅ Successfully updated pdf-tools in MCP config!"
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
    if ! "$SOURCE_DIR/configure-cursor.sh" update "$MCP_CONFIG" "$FULL_PATH"; then
        show_manual_instructions
        exit 1
    fi
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
