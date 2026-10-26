<!-- pi-workflow plan v1 flow=20261027-0011-cross-platform-bootstrap-node-pi-install-2c25 -->
## Plan: Cross-platform bootstrap: Node + Pi install and interactive menu in pi-config.sh/.bat, OS-neutral extension paths

### 1. Goal and non-goals
**Goal:**
- A fresh Windows, Linux or macOS machine can be set up with one script:
  - `pi-config.bat` on Windows.
  - `pi-config.sh` on Linux and macOS.
- Each script can install or update the latest Node LTS and Pi.
- Each script shows an interactive menu when run with no arguments.
- `setup` installs Node and Pi when they are missing.
- `pi-config.sh` is executable straight after a clone.
- Relative extension paths in the synced `settings.json` use `/`, so they load on every OS.

**Non-goals:**
- Homebrew.
- nvm-windows.
- Node's Current release line.
- A `curl | bash` bootstrap for this repo.
- A global `pi-config` command.
- Any change to `pi/agent/extensions/workflow/` or `docs/workflow-improvements.md`.

### 2. User decisions
- D1: Extend the existing `pi-config.sh` (Linux + macOS) and `pi-config.bat` (Windows); no new script.
- D2: Both scripts get an interactive menu when run with no arguments.
- D3: Both scripts get options to install the latest Node and to install Pi.
- D4: The change covers all three OSes: Windows, Linux and macOS.
- D5: Node means the latest LTS (the default stated in the discussion; the user didn't object).
- D6: Linux/macOS install Node via nvm from a pinned tag (v0.40.3). Windows uses winget `OpenJS.NodeJS.LTS`; when winget is missing, the script stops with a nodejs.org link.
- D7: Pi is installed with its official installer (`https://pi.dev/install.sh` or `https://pi.dev/install.ps1`), or updated with `pi update` when already installed.
- D8: `setup` installs Node (when missing or older than 22.19) and Pi (when missing). It asks first unless `--yes` is given, then runs import → npm install → VS Code bridge.
- D9: Mark `pi-config.sh` executable in git. Convert extension paths to forward slashes on both import and export. Update the README. Pass `import` arguments through. Add the help aliases. Check for npm, git and curl.

### 3. Facts
- `pi-config.sh`:
  - Line 17 exits at the top when `node` is missing.
  - Line 29 (`import`) doesn't forward arguments.
  - Lines 52–54 print the help with `sed -n '2,11p' "$0"`: the line range is tied to the header comment.
  - The git mode is `100644`.
- `pi-config.bat`:
  - Lines 22–29: the top-level `where node` check.
  - Line 43: the `:menu` label; line 58 is the `9. Quit` entry; line 71 handles choice 9.
  - Line 77: `:dispatch`.
  - Line 186: `:do_setup`.
  - Line 216: `:print_help`.
  - Pattern to follow for a call plus an error check: `pushd`/`call npm install`/`set NPMRC=%ERRORLEVEL%` at lines 193–200.
- `bin/lib.js`:
  - Line 136: `PATH_ARRAYS = ['extensions','skills','prompts','themes']`.
  - Line 146: `scrubSettings` (export). Line 159: `resolveSettings` (import).
  - Both handle only the top-level arrays, and only placeholder or absolute entries. `packages[]` objects are never touched.
  - Lines 213/226: `scrub` and `resolvePlaceholders` call them for `settings.json`.
  - Line 406: `module.exports`.
- `pi/agent/settings.json:13-19`: `packages[0].extensions = ["+src\\index.ts"]`.
- `bin/sync.test.js` uses `node:test` and `assert/strict`. `setup()`/`run()` at lines 12–33 build a temp repo and home folder for end-to-end runs.
- `README.md`:
  - Line 21: the macOS/Linux line.
  - Lines 38–46: the command table.
  - Line 153: the test command `node --test bin/sync.test.js bin/vscode-bridge.test.js`.
  - Line 188: the "Cross-platform caveat" section.
- Pi requires Node `>=22.19.0` (the engines field in Pi's own `package.json`).
- Current branch: `master`, with a clean working tree.

### 4. Design
- **`normalizeSettingsPaths(json)` in `bin/lib.js`:**
  - What it does: in every string entry of the `PATH_ARRAYS` keys, it replaces `\` with `/`. That covers the top-level arrays and the same keys inside every object of `json.packages`.
  - It skips:
    - Entries that are absolute paths, judged after stripping one leading `+`, `-` or `!`. Check both `path.isAbsolute` and the regex `/^[A-Za-z]:[\\/]|^\\\\/`, so Windows absolute paths are recognised on POSIX too.
    - Entries that start with `__PI_CONFIG_REPO__`.
    - Non-string entries.
  - It returns nothing and changes `json` in place. It must be idempotent.
  - Called first in `scrubSettings` and first in `resolveSettings`, and exported.
- **Shell script contract (`pi-config.sh`, bash 3.2):**
  - Subcommands: `status|preview|dry-run|import [args…]|export|sync|install|vscode|node|pi|setup [--yes]|help|-h|--help`.
  - No arguments → menu.
  - Exit codes: 0 on success; 1 on failure or an unknown command.
  - Helpers:
    - `need <cmd>`: prints `ERROR: <cmd> is not on PATH.` and fails.
    - `node_ok`: true when `node` runs and its version is ≥ 22.19, checked with `node -p` comparing the major and minor parts of `process.versions.node`.
    - `confirm <question>`: always yes when `--yes` was given; otherwise reads `[y/N]`.
- **Batch contract (`pi-config.bat`):**
  - The same subcommands.
  - Menu entries 1–9 keep their commands, except 9 becomes Quit's old slot as follows: 9 Install Node, 10 Install Pi, 11 Quit.
    - (Correction to the earlier plan: entries 1–8 are unchanged and Quit moves to 11, so nothing gets renumbered.)
- **Failure handling:**
  - The nvm, winget and Pi installers are external. Any non-zero exit → the error-and-fail path in the `.sh` script, or `goto failed` in the `.bat`.
  - Missing curl or winget → a clear error.
  - After installing with winget, the current cmd session doesn't see the new PATH. So prepend `%ProgramFiles%\nodejs` to the session PATH.
  - The `.sh` script loads `$NVM_DIR/nvm.sh` itself, so `setup` can continue in the same run.
- **Scale:** not applicable (one machine, a handful of files).
- **Rejected alternatives:**
  - apt or NodeSource: sudo, varies by distro, and versions can be older than 22.19.
  - Homebrew: it may not be installed.
  - nvm-windows: a separate tool that behaves differently from nvm.
  - `npm -g` install of Pi: doesn't pin dependencies.
  - `sort -V`: missing on older macOS versions.

### 5. Steps

**S1.** Create the branch `feat/bootstrap-node-pi` from `master`.

**S2.** In `bin/lib.js`, near `scrubSettings` (line 146), add `normalizeSettingsPaths(json)` as described in §4.
- Call it at the top of `scrubSettings` and at the top of `resolveSettings` (line 159).
- Add it to `module.exports` (line 406).
- Model it on the existing `PATH_ARRAYS` loop at lines 148–157.

**S3.** In `pi/agent/settings.json:17`, change `"+src\\index.ts"` to `"+src/index.ts"`.

**S4.** Add the tests from §6 to `bin/sync.test.js`, then run them.

**S5.** Rewrite `pi-config.sh`, keeping the existing commands' behaviour.
- **Header comment:**
  - List every subcommand, including `node`, `pi`, `setup [--yes]`, and "no args: interactive menu".
  - Rewrite the help so it no longer depends on fixed line numbers: use a `usage()` function with a heredoc.
- **Top of the script:** remove the global Node check (line 17). Keep `set -euo pipefail` and the `cd` into the script's folder.
- **`need`, `node_ok`, `confirm` helpers.** Commands that use Node call `need node` first: status, preview, import, export, sync, vscode and setup's import step. `install` calls `need npm`, `sync` calls `need git`, and `node`/`pi` call `need curl` when they need to download.
- **`load_nvm`:** `export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"`, then source `$NVM_DIR/nvm.sh` if it exists. Turn `set -u` off around the source and around the `nvm` calls, because nvm isn't `-u`-safe.
- **`install_node`:**
  - Call `load_nvm`.
  - If `nvm` is still not available, run `curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash`, then `load_nvm` again.
  - Run `nvm install --lts`, `nvm alias default 'lts/*'` and `nvm use default`.
  - Print `node -v`.
  - Print: "Open a new terminal (or source your shell rc) to use node outside this script."
- **`install_pi`:**
  - If `command -v pi` finds it, run `pi update`.
  - Otherwise `need curl` and run `curl -fsSL https://pi.dev/install.sh | sh`.
- **`import`:** `node bin/import.js "${@:2}"`; under `set -u`, write it so an empty argument list is safe.
- **`setup`:**
  - Parse `--yes`.
  - Step 1: `load_nvm` silently. If `node_ok` fails, then `confirm "Node >= 22.19 not found. Install the latest LTS via nvm?"` → `install_node`. When the user says no, stop with the error "Node >= 22.19 is required" (exit 1).
  - Step 2: if `pi` is missing, `confirm "Pi not found. Install it?"` → `install_pi`. A no here is a warning only; setup continues.
  - Step 3: then the existing import → `install_extensions` → VS Code bridge (`--if-available`, warning on failure) and the closing message.
  - Print step headers "Step n of 5".
- **`help|-h|--help`:** call `usage`, exit 0. Any other unknown command: print "Unknown command: X", call `usage`, exit 1.
- **No arguments → menu:**
  - A `while true` loop around `PS3="Choose: "` and `select` over these entries: Status, Preview, Import, Export, Sync, Install extensions, Setup, VS Code bridge, Install Node, Install Pi, Quit.
  - Each choice runs the script itself as `bash "$0" <cmd>`, so a failure under `set -e` doesn't kill the menu. Then print "Press Enter to continue" and show the menu again.
  - Quit exits 0. An invalid choice prints "Not a valid choice."
  - The menu passes `setup` without `--yes`, so the questions are asked.
- **bash 3.2 compatibility:** no associative arrays, `mapfile`, `${x,,}`, `|&`, or `declare -n`.

**S6.** Run `git update-index --chmod=+x pi-config.sh`.

**S7.** Edit `pi-config.bat`.
- **Header (lines 2–14):** add `node`, `pi` and `setup [--yes]`.
- **Remove the top-level `where node` block (lines 22–29).** Add `:need_node` as a `call` subroutine that does the same check and returns `exit /b 1` on failure. Each Node-using `:do_*` label does `call :need_node` followed by `if errorlevel 1 goto failed`.
- **Menu (lines 43–75):** add `9. Install Node` and `10. Install Pi`, make Quit `11.`, make the prompt `Choose [1-11]`, and add the matching `if` dispatch lines.
- **`:dispatch` (line 77):** add `node` → `:do_node` and `pi` → `:do_pi`.
- **`:do_node`:**
  - `where winget`. If it's missing: print "ERROR: winget not found. Install Node LTS from https://nodejs.org/" and `goto failed`.
  - If `where node` succeeds, run `winget upgrade --exact --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements`. Otherwise run `winget install` with the same arguments.
  - Treat winget's "no applicable upgrade" exit as success: when upgrading, a non-zero code with Node still present only prints a note, not a failure. A failed install → `goto failed`.
  - Then `set "PATH=%ProgramFiles%\nodejs;%PATH%"` and print `node -v`.
  - Write the body as `:install_node` so `setup` can `call` it, and have `:do_node` call it.
- **`:do_pi` / `:install_pi`:**
  - `where pi` → `call pi update`.
  - Otherwise `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://pi.dev/install.ps1 | iex"`.
  - A non-zero exit → fail.
- **`:do_setup` (line 186):**
  - Set `YES=1` when `%ARGS%` contains `--yes`.
  - Step 1: Node. When `where node` fails, or `node -p "const [a,b]=process.versions.node.split('.').map(Number);a>22||(a===22&&b>=19)?0:1"` doesn't print 0, it's missing or too old. In that case, unless `YES` is set, ask with `choice /c YN /m "Install the latest Node LTS via winget?"`; N → print the error "Node >= 22.19 is required" and `goto failed`. Then `call :install_node`.
  - Step 2: Pi. When `where pi` fails, ask the same way; N → warning only. Then `call :install_pi`.
  - Steps 3–5: the existing import, npm install and VS Code bridge. Header lines read "Step n of 5".
- **`:print_help` (line 216):** add the new commands and the `--yes` note.

**S8.** Update `README.md`.
- Line 21: say that `./pi-config.sh setup` (macOS/Linux) and `pi-config setup` (Windows) install Node LTS and Pi first when they're missing, asking before each one, with `--yes` to skip the questions.
- Command table, lines 38–46: add `pi-config node` (Node LTS via nvm on macOS/Linux, winget on Windows) and `pi-config pi` (official Pi installer, or `pi update`).
- Mention the menu runs with no arguments on both scripts.
- Line 188: replace the caveat with a note that import and export convert relative extension paths to `/` automatically.

**S9.** Run all the checks in §6.

**S10.** Deliver: merge — the whole change, after a judge pass.

### 6. Tests
**New tests in `bin/sync.test.js`** (these are unit tests that call `require('./lib.js')` directly):
- `normalizeSettingsPaths converts package extension paths`:
  - Input: `{packages:[{source:'npm:x',extensions:['+src\\index.ts','-a\\b.ts','!c\\d']}]}`.
  - Expected: `['+src/index.ts','-a/b.ts','!c/d']`.
- `normalizeSettingsPaths leaves absolute, placeholder and non-string entries`:
  - Input: `extensions:['C:\\x\\y','+C:\\x\\y','__PI_CONFIG_REPO__/extension',42,'rel\\p']`.
  - Expected: unchanged, except `'rel/p'`.
  - Also: `packages` entries that are strings (not objects) are left untouched.
- `normalizeSettingsPaths is idempotent`: running it twice gives the same result as running it once.
- `export writes forward-slash package extension paths`:
  - Use `setup()`/`run()`. Write a machine `settings.json` with `packages[0].extensions=['+src\\index.ts']` and run `export.js`.
  - Expected: the repo `pi/agent/settings.json` contains `+src/index.ts`.
  - Model it on the export tests at line 38.

**Commands:**
- `node --test bin/sync.test.js bin/vscode-bridge.test.js` → every test passes, 0 failures (fast).
- `bash -n pi-config.sh` → no output, exit 0.
- `command -v shellcheck && shellcheck pi-config.sh` → no errors. Warnings are allowed only when explained in a comment.
- In Git Bash:
  - `./pi-config.sh help` → usage, exit 0.
  - `./pi-config.sh bogus; echo $?` → "Unknown command", then `1`.
  - `./pi-config.sh preview` → the dry-run output.
- In cmd:
  - `pi-config.bat help` → the help text with `node` and `pi`.
  - `pi-config.bat preview` → the dry-run output, exit 0.
- `git ls-files -s pi-config.sh` → starts with `100755`.
- `grep -n 'src\\\\index' pi/agent/settings.json` → no match.

**S11.** Verify: on a Linux machine and on a Mac, run `./pi-config.sh` with no arguments, then Setup. Look for: the menu shows up and comes back after each command; nvm and Node LTS install when missing; Pi installs; import and npm install finish.

**S12.** Verify: on Windows, run `pi-config` with no arguments, then 9 (Install Node) and 10 (Install Pi). Look for: winget installs or upgrades Node; Pi installs or updates; the menu comes back.

### 7. Done when
- `pi-config.sh` and `pi-config.bat` both:
  - show an interactive menu when run with no arguments, with Install Node and Install Pi entries;
  - support the `node`, `pi` and `setup [--yes]` subcommands.
- `setup` installs Node LTS (when missing or below 22.19) and Pi (when missing) before import, npm install and the VS Code bridge, asking first unless `--yes` is given.
- Linux and macOS use nvm v0.40.3 and the LTS release. Windows uses winget `OpenJS.NodeJS.LTS`, and stops with a nodejs.org link when winget is missing.
- Pi is installed with the official `install.sh`/`install.ps1`, or updated with `pi update` when already present.
- `pi-config.sh` is mode 100755 in git and is bash 3.2 compatible.
- Export and import write relative extension paths with `/`; the repo `settings.json` has `+src/index.ts`.
- `import` forwards its arguments; `help`, `-h` and `--help` work; npm, git and curl are checked.
- The README reflects all of this.
- All tests in §6 pass.

### 8. Risks, rollback, do not touch
- **Risks:**
  - The real nvm, winget and Pi installs can't be tested here (covered by S11/S12).
  - winget's exit code when there's no upgrade varies.
  - nvm under `set -u`.
  - `choice` isn't available in non-interactive runs, but `--yes` skips it.
- **Rollback:** revert the merge commit. Machines that already imported keep `+src/index.ts`, which works on every OS.
- **Do not touch:** `bin/import.js` and `bin/export.js` logic beyond what goes through lib; `local/`; `pi/agent/extensions/**`; `docs/workflow-improvements.md`; auth files.

### 9. Commits
1. `fix(sync): normalize relative extension paths to forward slashes`: `bin/lib.js`, `bin/sync.test.js`, `pi/agent/settings.json`, README cross-platform section.
2. `feat(cli): interactive menu and Node/Pi install in pi-config.sh for Linux and macOS`: `pi-config.sh` (including the mode change), README lines for the `.sh` script.
3. `feat(cli): Node/Pi install and setup --yes in pi-config.bat`: `pi-config.bat`, README command table.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 Create the branch `feat/bootstrap-node-pi` from `master`.
- [x] S2 In `bin/lib.js`, near `scrubSettings` (line 146), add `normalizeSettingsPaths(json)` as described in §4.
- [x] S3 In `pi/agent/settings.json:17`, change `"+src\\index.ts"` to `"+src/index.ts"`.
- [x] S4 Add the tests from §6 to `bin/sync.test.js`, then run them.
- [x] S5 Rewrite `pi-config.sh`, keeping the existing commands' behaviour.
- [x] S6 Run `git update-index --chmod=+x pi-config.sh`.
- [x] S7 Edit `pi-config.bat`.
- [x] S8 Update `README.md`.
- [x] S9 Run all the checks in §6.
- [ ] S10 Deliver: merge — the whole change, after a judge pass.
## Outcome
2026-10-26T17:20:16.700Z — ok: feat/bootstrap-node-pi, 4 commits since the review base
