#!/usr/bin/env bash
set -euo pipefail

# Local dev install for agent-stalker plugin
# Registers this repo as a marketplace via CLI, installs the plugin,
# then symlinks the cache so edits take effect immediately.

PLUGIN_NAME="agent-stalker"
MARKETPLACE_NAME="agent-stalker-dev"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CACHE_BASE="$HOME/.claude/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME"

# Read version from plugin.json
PLUGIN_VERSION=$(python3 -c "import json; print(json.load(open('$PLUGIN_DIR/.claude-plugin/plugin.json'))['version'])")
CACHE_DIR="$CACHE_BASE/$PLUGIN_VERSION"
PLUGIN_KEY="$PLUGIN_NAME@$MARKETPLACE_NAME"

echo "=== agent-stalker local dev install ==="
echo "  Plugin:    $PLUGIN_DIR"
echo "  Version:   $PLUGIN_VERSION"
echo "  Cache:     $CACHE_DIR -> $PLUGIN_DIR"
echo ""

# Step 1: Add marketplace (this repo) via CLI
echo "[1/3] Adding marketplace..."
if claude plugin marketplace list 2>/dev/null | grep -q "$MARKETPLACE_NAME"; then
  echo "  Marketplace already registered."
else
  claude plugin marketplace add "$PLUGIN_DIR" 2>/dev/null
  echo "  Added marketplace: $MARKETPLACE_NAME"
fi

# Step 2: Install plugin via CLI
echo "[2/3] Installing plugin..."
claude plugin install "$PLUGIN_KEY" 2>/dev/null || true
echo "  Installed: $PLUGIN_KEY"

# Step 3: Replace cache copy with symlink for live editing
echo "[3/3] Symlinking cache to project directory..."
if [ -L "$CACHE_DIR" ]; then
  CURRENT_TARGET=$(readlink "$CACHE_DIR")
  if [ "$CURRENT_TARGET" = "$PLUGIN_DIR" ]; then
    echo "  Already symlinked correctly."
  else
    rm "$CACHE_DIR"
    ln -s "$PLUGIN_DIR" "$CACHE_DIR"
    echo "  Updated symlink (was: $CURRENT_TARGET)."
  fi
elif [ -d "$CACHE_DIR" ]; then
  rm -rf "$CACHE_DIR"
  ln -s "$PLUGIN_DIR" "$CACHE_DIR"
  echo "  Replaced cache copy with symlink."
else
  mkdir -p "$CACHE_BASE"
  ln -s "$PLUGIN_DIR" "$CACHE_DIR"
  echo "  Created symlink."
fi

# Verify
echo ""
if [ -L "$CACHE_DIR" ] && [ "$(readlink "$CACHE_DIR")" = "$PLUGIN_DIR" ]; then
  echo "SUCCESS: agent-stalker installed in dev mode."
  echo ""
  echo "  Edit files, then /reload-plugins to pick up changes."
  echo "  Run tests:   bun test"
  echo "  Uninstall:   ./scripts/dev-uninstall.sh"
else
  echo "FAILED: Symlink verification failed. Check $CACHE_DIR manually."
  exit 1
fi
