#!/usr/bin/env bash
# Shared prerequisite setup for install.sh — Node.js, Python, NVIDIA Riva client, PATH.
set -euo pipefail

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    major="$(node -v | sed 's/^v//' | cut -d. -f1)"
    if [ "$major" -ge 20 ] 2>/dev/null; then
      log "Node.js $(node -v) OK"
      return 0
    fi
    log "Node.js $(node -v) is too old — need 20+"
  else
    log "Node.js not found"
  fi

  log "Installing Node.js 20+..."
  if command -v brew >/dev/null 2>&1; then
    brew install node
  elif command -v winget >/dev/null 2>&1; then
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  else
    fail "Install Node.js 20+ from https://nodejs.org then re-run the installer."
  fi

  if ! command -v node >/dev/null 2>&1; then
    fail "Node.js install finished but node is not on PATH. Open a new terminal and re-run the installer."
  fi
}

detect_python_cmd() {
  if command -v python3 >/dev/null 2>&1; then
    echo "python3"
    return 0
  fi
  if command -v python >/dev/null 2>&1; then
    echo "python"
    return 0
  fi
  return 1
}

ensure_python() {
  local py=""
  if py="$(detect_python_cmd)"; then
    log "Python OK ($("$py" --version 2>&1))"
    echo "$py"
    return 0
  fi

  log "Installing Python 3..."
  if command -v brew >/dev/null 2>&1; then
    brew install python
  elif command -v winget >/dev/null 2>&1; then
    winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
  else
    fail "Install Python 3 from https://www.python.org/downloads/ then re-run the installer."
  fi

  py="$(detect_python_cmd)" || fail "Python install finished but python3 is not on PATH. Open a new terminal and re-run."
  log "Python OK ($("$py" --version 2>&1))"
  echo "$py"
}

ensure_riva_client() {
  local py="$1"
  if "$py" -c "import riva.client" >/dev/null 2>&1; then
    log "NVIDIA Riva Python client OK"
    return 0
  fi

  log "Installing NVIDIA Riva Python client..."
  if ! "$py" -m pip --version >/dev/null 2>&1; then
    log "Installing pip..."
    "$py" -m ensurepip --upgrade 2>/dev/null || true
  fi

  "$py" -m pip install --upgrade pip >/dev/null 2>&1 || true
  if ! "$py" -m pip install -U nvidia-riva-client; then
    log "Retrying pip install with --user flag..."
    "$py" -m pip install --user -U nvidia-riva-client
  fi

  if ! "$py" -c "import riva.client" >/dev/null 2>&1; then
    fail "Could not install nvidia-riva-client. Run: $py -m pip install -U nvidia-riva-client"
  fi
  log "NVIDIA Riva Python client ready"
}

ensure_path_entry() {
  local bin_dir="$1"
  local path_line="export PATH=\"$bin_dir:\$PATH\""

  if [[ ":$PATH:" == *":$bin_dir:"* ]]; then
    return 0
  fi

  local shell_rc=""
  case "${SHELL:-}" in
    */zsh)  shell_rc="$HOME/.zshrc" ;;
    */bash) shell_rc="$HOME/.bashrc" ;;
  esac

  if [ -n "$shell_rc" ]; then
    if ! grep -Fq "$bin_dir" "$shell_rc" 2>/dev/null; then
      log "Adding $bin_dir to $shell_rc"
      {
        echo ""
        echo "# Second Chair (scchair)"
        echo "$path_line"
      } >> "$shell_rc"
    fi
    export PATH="$bin_dir:$PATH"
  fi
}

run_prerequisite_setup() {
  ensure_node
  local py
  py="$(ensure_python)"
  ensure_riva_client "$py"
}
