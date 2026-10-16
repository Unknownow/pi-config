#!/usr/bin/env bash
# pi-config.sh — the macOS/Linux twin of pi-config.bat.
#
#   ./pi-config.sh status    what differs between this machine and the repo
#   ./pi-config.sh preview   dry-run import, writes nothing
#   ./pi-config.sh import    apply repo config to this machine
#   ./pi-config.sh export    capture this machine's config into the repo
#   ./pi-config.sh sync      export + commit + push
#   ./pi-config.sh install   npm install the extensions
#   ./pi-config.sh vscode    build and install the VS Code terminal bridge
#   ./pi-config.sh setup     import + install + VS Code bridge, for a fresh machine
set -euo pipefail

cd "$(dirname "$0")"
NPMDIR="$HOME/.pi/agent/npm"

command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js is not on PATH."; exit 1; }

install_extensions() {
  [ -d "$NPMDIR" ] || { echo "ERROR: $NPMDIR does not exist. Run 'import' first."; exit 1; }
  (cd "$NPMDIR" && npm install)
}

case "${1:-help}" in
  status)
    echo "[ repo -> machine ]"; node bin/import.js --dry-run
    echo; echo "[ machine -> repo ]"; node bin/export.js --dry-run
    echo; echo "[ uncommitted ]"; git status --short
    ;;
  preview|dry-run) node bin/import.js --dry-run ;;
  import)          node bin/import.js ;;
  export)          node bin/export.js ;;
  sync)
    node bin/export.js
    git add -- pi
    if git diff --cached --quiet; then
      echo "Nothing to commit — the repo is already current."
    else
      git commit -m "chore(config): sync from $(hostname)"
      git push
    fi
    ;;
  install) install_extensions ;;
  vscode)  node bin/vscode-bridge.js ;;
  setup)
    node bin/import.js
    install_extensions
    node bin/vscode-bridge.js --if-available || echo "WARNING: the VS Code bridge was not installed. Run './pi-config.sh vscode' to retry."
    echo
    echo "Setup complete. Restart Pi and log in (auth is deliberately not synced)."
    ;;
  *)
    sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
