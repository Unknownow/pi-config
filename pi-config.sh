#!/usr/bin/env bash
# pi-config.sh — the macOS/Linux twin of pi-config.bat.
#
#   ./pi-config.sh              no args: interactive menu
#   ./pi-config.sh status       what differs between this machine and the repo
#   ./pi-config.sh preview      dry-run import, writes nothing
#   ./pi-config.sh import       apply repo config to this machine (extra args go to import.js)
#   ./pi-config.sh export       capture this machine's config into the repo
#   ./pi-config.sh sync         export + commit + push
#   ./pi-config.sh install      npm install the extensions
#   ./pi-config.sh vscode       build and install the VS Code terminal bridge
#   ./pi-config.sh node         install the latest Node LTS (via nvm)
#   ./pi-config.sh pi           install Pi, or update it when already installed
#   ./pi-config.sh setup [--yes]  install Node and Pi if needed, import, install, VS Code bridge
#   ./pi-config.sh help         show this help
set -euo pipefail

cd "$(dirname "$0")"
NPMDIR="$HOME/.pi/agent/npm"
NVM_VERSION="v0.40.3"
ASSUME_YES=0

usage() {
  sed -n '2,/^set -e/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "ERROR: $1 is not on PATH."; return 1; }
}

# True when node runs and is at least 22.19 (what Pi requires).
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  [ "$(node -p "const [a,b]=process.versions.node.split('.').map(Number);(a>22||(a===22&&b>=19))?'ok':'old'" 2>/dev/null)" = "ok" ]
}

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  local answer
  read -r -p "$1 [y/N] " answer || return 1
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# nvm is not safe under `set -u`, so it is loaded with the check switched off.
load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    set +u
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    set -u
  fi
  return 0
}

install_node() {
  need curl
  load_nvm
  if ! type nvm >/dev/null 2>&1; then
    echo "Installing nvm $NVM_VERSION ..."
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | bash
    load_nvm
  fi
  type nvm >/dev/null 2>&1 || { echo "ERROR: nvm could not be loaded from $NVM_DIR."; return 1; }
  set +u
  nvm install --lts
  nvm alias default 'lts/*'
  nvm use default
  set -u
  echo "Node $(node -v) is ready."
  echo "Open a new terminal (or source your shell rc) to use node outside this script."
}

install_pi() {
  if command -v pi >/dev/null 2>&1; then
    pi update
  else
    need curl
    curl -fsSL https://pi.dev/install.sh | sh
  fi
}

install_extensions() {
  need npm
  [ -d "$NPMDIR" ] || { echo "ERROR: $NPMDIR does not exist. Run 'import' first."; return 1; }
  (cd "$NPMDIR" && npm install)
}

do_setup() {
  local arg
  for arg in "$@"; do
    [ "$arg" = "--yes" ] && ASSUME_YES=1
  done
  load_nvm

  echo "=== Step 1 of 5: Node ==="
  if ! node_ok; then
    if confirm "Node >= 22.19 not found. Install the latest LTS via nvm?"; then
      install_node
    else
      echo "ERROR: Node >= 22.19 is required."
      return 1
    fi
  fi

  echo; echo "=== Step 2 of 5: Pi ==="
  if ! command -v pi >/dev/null 2>&1; then
    if confirm "Pi not found. Install it?"; then
      install_pi
    else
      echo "WARNING: Pi was not installed. Run './pi-config.sh pi' later."
    fi
  fi

  echo; echo "=== Step 3 of 5: import config ==="
  node bin/import.js

  echo; echo "=== Step 4 of 5: install extensions ==="
  install_extensions

  echo; echo "=== Step 5 of 5: VS Code terminal bridge ==="
  node bin/vscode-bridge.js --if-available || echo "WARNING: the VS Code bridge was not installed. Run './pi-config.sh vscode' to retry."
  echo
  echo "Setup complete. Restart Pi and log in (auth is deliberately not synced)."
}

run_command() {
  local cmd="$1"
  shift
  case "$cmd" in
    status)
      need node
      echo "[ repo -> machine ]"; node bin/import.js --dry-run
      echo; echo "[ machine -> repo ]"; node bin/export.js --dry-run
      echo; echo "[ uncommitted ]"; git status --short
      ;;
    preview|dry-run) need node; node bin/import.js --dry-run ;;
    import)          need node; node bin/import.js ${1+"$@"} ;;
    export)          need node; node bin/export.js ;;
    sync)
      need node; need git
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
    vscode)  need node; node bin/vscode-bridge.js ;;
    node)    install_node ;;
    pi)      install_pi ;;
    setup)   need git; do_setup ${1+"$@"} ;;
    help|-h|--help) usage ;;
    *)
      echo "Unknown command: $cmd"
      usage
      return 1
      ;;
  esac
}

menu() {
  local choice
  PS3="Choose: "
  while true; do
    echo
    select choice in "Status" "Preview" "Import" "Export" "Sync" "Install extensions" "Setup" "VS Code bridge" "Install Node" "Install Pi" "Quit"; do
      case "$choice" in
        Status)               bash "$0" status || true ;;
        Preview)              bash "$0" preview || true ;;
        Import)               bash "$0" import || true ;;
        Export)               bash "$0" export || true ;;
        Sync)                 bash "$0" sync || true ;;
        "Install extensions") bash "$0" install || true ;;
        Setup)                bash "$0" setup || true ;;
        "VS Code bridge")     bash "$0" vscode || true ;;
        "Install Node")       bash "$0" node || true ;;
        "Install Pi")         bash "$0" pi || true ;;
        Quit)                 exit 0 ;;
        *)                    echo "Not a valid choice."; continue ;;
      esac
      break
    done
    echo
    read -r -p "Press Enter to continue " _ || exit 0
  done
}

if [ $# -eq 0 ]; then
  menu
else
  run_command "$@"
fi
