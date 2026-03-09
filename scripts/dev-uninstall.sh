#!/usr/bin/env bash
set -euo pipefail

# Remove the local dev install of agent-stalker plugin

PLUGIN_NAME="agent-stalker"
MARKETPLACE_NAME="agent-stalker-dev"
CACHE_BASE="$HOME/.claude/plugins/cache/$MARKETPLACE_NAME"
PLUGIN_KEY="$PLUGIN_NAME@$MARKETPLACE_NAME"

echo "=== agent-stalker local dev uninstall ==="

# Step 1: Uninstall plugin
echo "[1/3] Uninstalling plugin..."
claude plugin uninstall "$PLUGIN_NAME" 2>/dev/null || true

# Step 2: Remove marketplace
echo "[2/3] Removing marketplace..."
claude plugin marketplace remove "$MARKETPLACE_NAME" 2>/dev/null || true

# Step 3: Remove cache symlink/directory
echo "[3/3] Removing cache entries..."
if [ -L "$CACHE_BASE/$PLUGIN_NAME" ] || [ -d "$CACHE_BASE" ]; then
  rm -rf "$CACHE_BASE"
  echo "  Removed cache."
else
  echo "  No cache entries found."
fi

echo ""
echo "Done. Run /reload-plugins or restart Claude Code to apply."
