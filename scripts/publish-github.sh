#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required."
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required. Install: https://cli.github.com"
  exit 1
fi

if [ ! -d .git ]; then
  git init
  git branch -M main
fi

git add -A
git status --short

if git diff --cached --quiet; then
  echo "Nothing to commit."
else
  git commit -m "$(cat <<'EOF'
Prepare Second Chair as a standalone npx-installable package.

Rename from interview-copilot, add the second-chair CLI, bootstrap installer,
cross-platform docs, and publish metadata for npm and GitHub.
EOF
)"
fi

if gh auth status >/dev/null 2>&1; then
  if gh repo view "kashyaparun25/second-chair" >/dev/null 2>&1; then
    git remote remove origin 2>/dev/null || true
    git remote add origin "https://github.com/kashyaparun25/second-chair.git"
    git push -u origin main
  else
    gh repo create "kashyaparun25/second-chair" --public --source=. --remote=origin --push
  fi
  echo ""
  echo "Repository: https://github.com/kashyaparun25/second-chair"
  echo "Publish to npm: npm login && npm publish --access public"
else
  echo ""
  echo "GitHub CLI is not authenticated. Run: gh auth login"
  echo "Then re-run: ./scripts/publish-github.sh"
fi
