#!/usr/bin/env bash
# Install Second Chair from GitHub — no npm account, no GitHub login required.
set -euo pipefail

REPO="https://github.com/kashyaparun25/scchair.git"
BRANCH="main"
INSTALL_ROOT="${SCCHAIR_HOME:-$HOME/.scchair}"
APP_DIR="$INSTALL_ROOT/app"
BIN_DIR="${SCCHAIR_BIN_DIR:-$HOME/.local/bin}"
WRAPPER="$BIN_DIR/scchair"

log() { echo "[scchair] $*"; }
fail() { echo "[scchair] ERROR: $*" >&2; exit 1; }

# --- Node.js 20+ ---
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is not installed. Install Node.js 20+ from https://nodejs.org"
fi

NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
  fail "Node.js 20+ required (found $(node -v)). Install from https://nodejs.org"
fi

mkdir -p "$INSTALL_ROOT" "$BIN_DIR"

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

# --- Dependencies ---
log "Installing dependencies (first run can take a few minutes)..."
(cd "$APP_DIR" && npm install --no-fund --no-audit)

# --- CLI wrapper ---
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
exec node "$APP_DIR/bin/scchair.mjs" "\$@"
EOF
chmod +x "$WRAPPER"

log "Installed to $APP_DIR"
log "Command: scchair"

# --- PATH ---
if [[ ":$PATH:" == *":$BIN_DIR:"* ]]; then
  echo ""
  echo "Done! Open a new terminal and run:"
  echo "  scchair"
else
  SHELL_RC=""
  case "${SHELL:-}" in
    */zsh)  SHELL_RC="$HOME/.zshrc" ;;
    */bash) SHELL_RC="$HOME/.bashrc" ;;
  esac

  echo ""
  echo "Add scchair to your PATH. Run:"
  echo ""
  echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ${SHELL_RC:-your-shell-profile}"
  echo "  source ${SHELL_RC:-your-shell-profile}"
  echo ""
  echo "Then run:"
  echo "  scchair"
  echo ""
  echo "Or run directly now:"
  echo "  $WRAPPER"
fi
