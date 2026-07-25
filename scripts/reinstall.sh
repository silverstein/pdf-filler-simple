#!/bin/bash
# Reinstall PDF Tools extension into Claude Desktop (macOS).
# Usage: ./scripts/reinstall.sh [--remove-legacy]
#
# Claude Desktop assigns the installation directory name, and this project has
# had more than one identity over its life. Installing the current MCPB creates
# local.mcpb.open-document-alliance.pdf-toolkit; it does NOT replace the older
# Directory install ant.dir.gh.silverstein.pdf-filler-simple. Both are then
# announced to the host until the legacy one is disabled, which looks like a
# working upgrade while two copies of the extension are live.
#
# This script therefore discovers every install belonging to the project rather
# than assuming one hard-coded path, and refuses to describe a duplicate state
# as a clean install. See docs/MAINTAINERS.md for the migration path.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MCPB_FILE="pdf-toolkit-mcp.mcpb"
REMOVE_LEGACY=0
[ "${1:-}" = "--remove-legacy" ] && REMOVE_LEGACY=1

cd "$REPO_ROOT"

echo "=== PDF Tools Extension Reinstall ==="
echo ""

# Derive the log path from the manifest rather than hard-coding a display name
# that has already changed once.
DISPLAY_NAME="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync("manifest.json","utf8")).display_name)')"
LOG_FILE="$HOME/Library/Logs/Claude/mcp-server-${DISPLAY_NAME}.log"

echo "[1/5] Discovering installed extension identities..."
STATE_JSON="$(node scripts/claude-extension-identity.mjs)"
EXPECTED_ID="$(printf '%s' "$STATE_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).expected_id))')"
echo "      Expected identity: $EXPECTED_ID"
printf '%s' "$STATE_JSON" | node -e '
let s = "";
process.stdin.on("data", d => (s += d)).on("end", () => {
  const state = JSON.parse(s);
  if (!state.present) { console.log("      Claude Extensions directory not present."); return; }
  if (state.installs.length === 0) { console.log("      No existing install found."); return; }
  for (const i of state.installs) console.log(`      ${i.classification.padEnd(12)} ${i.id}`);
  if (!state.summary.clean) {
    console.log("      WARNING: multiple identities installed. This is NOT a clean upgrade state.");
  }
});'

echo "[2/5] Building UI..."
npm run build:ui 2>&1 | tail -1

echo "[3/5] Packing MCPB..."
mcpb pack 2>&1 | tail -1

echo "[4/5] Removing the current-identity install so the new build replaces it..."
CURRENT_PATH="$HOME/Library/Application Support/Claude/Claude Extensions/$EXPECTED_ID"
if [ -d "$CURRENT_PATH" ]; then
  rm -rf "$CURRENT_PATH"
  echo "      Removed: $EXPECTED_ID"
else
  echo "      Not installed under the current identity."
fi

# Other identities are only removed on request. Silently deleting a Directory
# install would destroy the very state a migration test needs to observe.
OTHER_IDS="$(printf '%s' "$STATE_JSON" | node -e '
let s = "";
process.stdin.on("data", d => (s += d)).on("end", () => {
  const state = JSON.parse(s);
  process.stdout.write(state.installs.filter(i => i.classification !== "current").map(i => i.id).join("\n"));
});')"
if [ -n "$OTHER_IDS" ]; then
  if [ "$REMOVE_LEGACY" = "1" ]; then
    while IFS= read -r id; do
      [ -z "$id" ] && continue
      rm -rf "$HOME/Library/Application Support/Claude/Claude Extensions/$id"
      echo "      Removed legacy: $id"
    done <<< "$OTHER_IDS"
  else
    echo ""
    echo "      Other identities are still installed:"
    while IFS= read -r id; do [ -n "$id" ] && echo "        - $id"; done <<< "$OTHER_IDS"
    echo "      Disable them in Claude Desktop settings, or rerun with --remove-legacy."
    echo "      Leaving them in place: a duplicate install is not a clean upgrade test."
  fi
fi

echo "[5/5] Installing new extension..."
open "$MCPB_FILE"

echo ""
echo "=== Done ==="
echo "Claude Desktop should prompt to install the extension."
echo ""
echo "Verify the resulting identity state with:"
echo "  node scripts/claude-extension-identity.mjs"
echo ""
echo "To tail logs after testing:"
echo "  tail -f '$LOG_FILE'"
