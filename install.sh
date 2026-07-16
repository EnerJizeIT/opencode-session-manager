#!/usr/bin/env bash
set -euo pipefail

# Resolve script directory for absolute paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$SCRIPT_DIR"

OPENCODE_CONFIG_DIR="${HOME}/.config/opencode"
OPENCODE_CACHE_DIR="${HOME}/.cache/opencode"
OPENCODE_JSON="$OPENCODE_CONFIG_DIR/opencode.json"
OPENCODE_PKG_JSON="$OPENCODE_CONFIG_DIR/package.json"
PLUGIN_NAME="@enerjizeit/opencode-session-manager"
CACHE_PKG_DIR="$OPENCODE_CACHE_DIR/packages/${PLUGIN_NAME}@latest/node_modules/$PLUGIN_NAME"

echo "=== OpenCode Session Manager Installer ==="
echo "Repo: $REPO_DIR"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Build the package
# ---------------------------------------------------------------------------
echo "[1/4] Building package..."
cd "$REPO_DIR"
bun install
bun run build

if [ ! -f "$REPO_DIR/dist/plugin.js" ]; then
  echo "ERROR: Build failed — dist/plugin.js not found."
  exit 1
fi
echo "  Build OK: dist/plugin.js exists ($(wc -c < "$REPO_DIR/dist/plugin.js") bytes)"
echo ""

# ---------------------------------------------------------------------------
# Step 2: Install package where opencode can resolve it
# ---------------------------------------------------------------------------
echo "[2/4] Installing package..."

# Strategy: opencode resolves plugin-array packages from an isolated install at
# ~/.cache/opencode/packages/<name>@latest/ — a wrapper package.json there declares
# the dependency, and node_modules/<name>/ holds the actual package. We mirror that
# layout exactly (verified against opencode-mem). Without the wrapper package.json,
# opencode does not recognise/load the package.
CACHE_PKG_ROOT="$OPENCODE_CACHE_DIR/packages/${PLUGIN_NAME}@latest"
CACHE_PKG_DIR="$CACHE_PKG_ROOT/node_modules/$PLUGIN_NAME"

mkdir -p "$CACHE_PKG_DIR"
cp -r "$REPO_DIR/dist" "$CACHE_PKG_DIR/dist"
cp "$REPO_DIR/package.json" "$CACHE_PKG_DIR/package.json"
if [ -d "$REPO_DIR/node_modules" ]; then
  cp -r "$REPO_DIR/node_modules" "$CACHE_PKG_DIR/node_modules"
fi
# Wrapper package.json at the <name>@latest/ level (mirrors opencode-mem's layout).
# file: dependency so it resolves locally without npm publishing.
cat > "$CACHE_PKG_ROOT/package.json" <<JSON
{
  "dependencies": {
    "$PLUGIN_NAME": "file:$REPO_DIR"
  }
}
JSON
echo "  Package + wrapper installed to $CACHE_PKG_ROOT"
echo ""

# ---------------------------------------------------------------------------
# Step 3: Add plugin to opencode.json (with backup)
# ---------------------------------------------------------------------------
echo "[3/4] Adding plugin to opencode.json..."

if [ ! -f "$OPENCODE_JSON" ]; then
  echo "ERROR: $OPENCODE_JSON not found."
  exit 1
fi

# Create backup
BACKUP_TS="$(date +%Y%m%d%H%M%S)"
BACKUP_FILE="${OPENCODE_JSON}.bak-${BACKUP_TS}"
cp "$OPENCODE_JSON" "$BACKUP_FILE"
echo "  Backup created: $BACKUP_FILE"

# Use python3 for safe JSON manipulation
python3 - "$OPENCODE_JSON" "$PLUGIN_NAME" <<'PYEOF'
import json, sys, os

opencode_json_path = sys.argv[1]
plugin_name = sys.argv[2]

try:
    with open(opencode_json_path, "r") as f:
        config = json.load(f)
except (json.JSONDecodeError, IOError) as e:
    print(f"ERROR: Cannot parse {opencode_json_path}: {e}", file=sys.stderr)
    sys.exit(1)

# Ensure 'plugin' key exists as a list
if "plugin" not in config or not isinstance(config["plugin"], list):
    config["plugin"] = []

# Idempotent: only add if not already present
if plugin_name not in config["plugin"]:
    config["plugin"].append(plugin_name)
    print(f"  Added '{plugin_name}' to plugin array")
else:
    print(f"  '{plugin_name}' already in plugin array (skipped)")

# Write back, preserving structure
with open(opencode_json_path, "w") as f:
    json.dump(config, f, indent=2, ensure_ascii=False)
    f.write("\n")

print("  opencode.json updated successfully")
PYEOF

if [ $? -ne 0 ]; then
  echo "ERROR: Failed to update opencode.json. Restoring backup..."
  cp "$BACKUP_FILE" "$OPENCODE_JSON"
  exit 1
fi
echo ""

# ---------------------------------------------------------------------------
# Step 4: Done
# ---------------------------------------------------------------------------
echo "[4/4] Installation complete!"
echo ""
echo "=== Next step ==="
echo "Restart opencode to load the plugin:"
echo "  1. Close the current opencode session"
echo "  2. Start opencode again"
echo "  3. The sm_* tools (sm_pin, sm_search, sm_backup, etc.) should now be available"
echo ""
echo "Backup of opencode.json: $BACKUP_FILE"
