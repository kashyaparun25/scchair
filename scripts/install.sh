#!/usr/bin/env bash
# Install Second Chair from GitHub — no npm account, no GitHub login required.
set -euo pipefail

REPO="https://github.com/kashyaparun25/scchair.git"
BRANCH="main"
INSTALL_ROOT="${SCCHAIR_HOME:-$HOME/.scchair}"
APP_DIR="$INSTALL_ROOT/app"
BIN_DIR="${SCCHAIR_BIN_DIR:-$HOME/.local/bin}"
WRAPPER="$BIN_DIR/scchair"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { echo "[scchair] $*" >&2; }
fail() { echo "[scchair] ERROR: $*" >&2; exit 1; }

# When users install with `curl .../install.sh | bash`, there is no local
# sibling setup script yet. Fetch it in that case.
if [ -f "$SCRIPT_DIR/setup-prerequisites.sh" ]; then
  # shellcheck source=setup-prerequisites.sh
  source "$SCRIPT_DIR/setup-prerequisites.sh"
else
  # shellcheck source=/dev/null
  source <(curl -fsSL "https://raw.githubusercontent.com/kashyaparun25/scchair/main/scripts/setup-prerequisites.sh")
fi

mkdir -p "$INSTALL_ROOT" "$BIN_DIR"

# --- Node.js, Python, NVIDIA Riva client ---
run_prerequisite_setup

# --- Download or update ---
if [ -d "$APP_DIR/.git" ]; then
  log "Updating existing install..."
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
elif [ -d "$APP_DIR" ]; then
  log "Replacing existing install..."
  rm -rf "$APP_DIR"
fi

if [ ! -d "$APP_DIR" ]; then
  log "Downloading from GitHub..."
  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
  else
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    curl -fsSL "https://github.com/kashyaparun25/scchair/archive/refs/heads/main.tar.gz" \
      | tar xz -C "$TMP"
    mv "$TMP/scchair-main" "$APP_DIR"
  fi
fi

# --- npm dependencies ---
log "Installing app dependencies (first run can take a few minutes)..."
(cd "$APP_DIR" && npm install --no-fund --no-audit)

if [ ! -f "$APP_DIR/node_modules/electron/path.txt" ]; then
  log "Electron binary is missing; repairing Electron install..."
  (cd "$APP_DIR" && npm rebuild electron --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000) || true
  if [ ! -f "$APP_DIR/node_modules/electron/path.txt" ] && [ -f "$APP_DIR/node_modules/electron/install.js" ]; then
    log "Running Electron binary downloader..."
    (cd "$APP_DIR" && node node_modules/electron/install.js)
  fi

  if [ ! -f "$APP_DIR/node_modules/electron/path.txt" ]; then
    fail "Electron repair failed. Check your network connection, then run: cd \"$APP_DIR\" && npm rebuild electron"
  fi
  log "Electron binary ready."
fi

# --- CLI wrapper ---
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
exec node "$APP_DIR/bin/scchair.mjs" "\$@"
EOF
chmod +x "$WRAPPER"

ensure_path_entry "$BIN_DIR"

log "Installed to $APP_DIR"
echo ""
echo "Done! Run:"
echo "  scchair"
echo ""
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo "If scchair is not found, open a new terminal or run:"
  echo "  source ~/.zshrc   # or ~/.bashrc"
  echo "  $WRAPPER"
fi
