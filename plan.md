<!-- pi-workflow plan v1 flow=20261016-1046-pi-config-vscode-a-command-that-builds-a-6273 -->
## Plan: `pi-config vscode`, a command that builds and installs the VS Code terminal bridge, also run by `setup`

### 1. Goal and non-goals

**Goal:** The repo's own tool builds and installs the `pi-terminal-bridge` VS Code extension on the current machine.
- It is a new `pi-config vscode` command in both `pi-config.bat` and `pi-config.sh`.
- It is also an optional third step of `pi-config setup`.
- A new machine gets the bridge without anyone typing the `npx` / `code` commands by hand.

**Non-goals:**
- No `/wt vscode` subcommand in the worktree extension. The user chose the pi-config tool instead.
- No change to the sync extension (`extension/index.ts`). The bridge is never installed automatically at Pi session start.
- No change to `bin/import.js`, `bin/export.js`, `bin/lib.js` or `bin/check-secrets.js`.
- No change to the bridge extension itself (`pi/agent/extensions/worktree/vscode/*`) or to any worktree `.ts` file.
- No `.vsix` in the repo, and no Marketplace publishing.
- No uninstall command.

### 2. User decisions

- D1. The bridge install lives in the pi-config tool in the repo, not in the worktree extension.
- D2. It is a cross-platform node script `bin/vscode-bridge.js`, called by both `pi-config.bat` and `pi-config.sh` as a new command `pi-config vscode`.
- D3. `pi-config setup` runs it as step 3. When `code` is not on PATH, that step is skipped with a note and does not fail.
- D4. If the step fails during `setup`, it only prints a warning, and setup still succeeds.
- D5. The sync extension's automatic import at session start does not run it.
- D6. The `.vsix` is written to the OS temp folder, never into the repo.
- D7. Delivery is commit + push.

### 3. Facts the executor needs

**Repo and existing scripts**
- Repo: `D:/projects/pi-config`. `git status` was clean before this work, and `master` is in sync with `origin/master`.
- `bin/*.js` are CommonJS. They start with `'use strict';` and `require`, and have a top doc comment. Model the new script on `bin/import.js:1-17`.
- `bin/lib.js:23`: `const REPO = path.resolve(__dirname, '..');` is exported as `lib.REPO` (`bin/lib.js:381-382`).
- Bridge source in the repo: `pi/agent/extensions/worktree/vscode/`. It holds `package.json`, `extension.js`, `request.js`, `request.test.js` and `.vscodeignore`.
- The manual commands that work, verified earlier this session from that folder:
  - `npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license -o <tmp>/pi-terminal-bridge.vsix`
  - `code --install-extension <vsix> --force`

**Running `npx` and `code` on Windows**
- On Windows, `npx` and `code` are `.cmd` shims. Node 24 cannot spawn `.cmd` files without a shell.
- So on win32 run `cmd.exe` with args `["/d", "/c", <cmd>, ...args]`. On other platforms spawn `<cmd>` directly.
- `code --install-extension` prints a harmless `DEP0169 DeprecationWarning` on stderr.

**`pi-config.sh`**
- `set -euo pipefail` is at line 11.
- The help block is the header comment printed by `sed -n '2,12p' "$0"` (line 50). The header command lines are 4-10.
- `install)` is at line 42, and the `setup)` branch is at lines 43-48.

**`pi-config.bat`**
- Header help: lines 3-13.
- Menu: lines 46-70. Item `7. Setup` is at line 55, `8. Quit` at 56, `Choose [1-8]` at 59, and the choice lines at 61-68.
- Dispatch: lines 74-86.
- `:do_install` is at line 157 and `:do_setup` at line 174. Setup's steps are labelled "Step 1 of 2" (line 176) and "Step 2 of 2" (line 181), and the "Setup complete" message is at line 192.
- `:print_help` is at line 200, with its command lines at 204-210.
- `goto failed` / `goto done` are the exit paths.

**READMEs**
- Root `README.md`:
  - The new-machine block is at lines 10-27, with the `pi-config setup` line at 15.
  - The Day to day table is at lines 35-44, with the `pi-config install` row at 44.
  - The tests line is at 152: ``Tests for the sync rules: `node --test bin/sync.test.js`.``
- `pi/agent/extensions/worktree/README.md`: `## VS Code` is at line 54. The "Install:" block is at lines 58-64, followed by "Reload the VS Code window…" at line 66.

### 4. Design

**Component:** a new `bin/vscode-bridge.js`, which is both a CLI and a module.

**Module exports**
```js
module.exports = { installCommands, codeAvailable };
// installCommands(platform: string, vsix: string): Array<{ file: string, args: string[] }>
// codeAvailable(platform: string): boolean
```

`installCommands` is pure. It returns exactly two entries in this order:
1. Package: `npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license -o <vsix>`
2. Install: `code --install-extension <vsix> --force`

On `win32`, each entry is `{ file: "cmd.exe", args: ["/d", "/c", <cmd>, ...rest] }`. Otherwise it is `{ file: <cmd>, args: rest }`.

`codeAvailable` runs `code --version` (on win32 through `cmd.exe /d /c`) with `spawnSync`, `stdio: "ignore"` and `timeout: 30000`. It returns `true` only when there is no spawn error and the status is 0.

**CLI:** `node bin/vscode-bridge.js [--if-available]`. Run the CLI only when `require.main === module`.

1. `src = path.join(lib.REPO, "pi", "agent", "extensions", "worktree", "vscode")`. If `src/package.json` is missing, print `ERROR: bridge source not found in <src>` and exit 1.
2. If `codeAvailable(process.platform)` is false:
   - with `--if-available`: print `Skipped: the VS Code 'code' command is not on PATH. Run 'pi-config vscode' after installing VS Code.` and exit 0.
   - without it: print `ERROR: the VS Code 'code' command is not on PATH.` and exit 1.
3. `vsix = path.join(os.tmpdir(), "pi-terminal-bridge.vsix")`.
4. Run each entry of `installCommands` in order with `spawnSync(file, args, { cwd: src, stdio: "inherit", timeout: 180000 })`.
   - If the result has an error or a non-zero status, print `ERROR: packaging the bridge failed (exit <status or error message>).` for the first entry, or `ERROR: installing the bridge failed (...)` for the second, and exit 1.
   - Don't run the second entry after the first one fails.
5. On success, print `Installed pi-terminal-bridge. Reload each VS Code window, then open a new terminal.` and exit 0.
6. The `.vsix` is left in the temp folder.

**Wrappers**
- `pi-config vscode` runs `node bin/vscode-bridge.js` (strict). A non-zero exit means the command failed (`goto failed` in bat, and the non-zero exit propagates in sh).
- `pi-config setup` becomes three steps: import, then npm install, then `node bin/vscode-bridge.js --if-available`.
  - If step 3 exits non-zero, print `WARNING: the VS Code bridge was not installed. Run 'pi-config vscode' to retry.` and continue to the "Setup complete" message.
  - In sh, use `|| echo …` so `set -e` doesn't abort.
  - Steps 1 and 2 keep their current failure behaviour.

**Scale and limits**
- One run takes roughly 10-60 s, mostly the `npx` download of `@vscode/vsce`, and needs network access.
- It breaks if the temp path contains characters that `cmd.exe /c` misreads (`&`, `^`, `%`). Normal Windows temp paths are fine.

**Alternatives rejected**
- A `/wt vscode` pi command: the user chose the repo tool (D1).
- Installing in `import.js` or in the sync extension: that would run at every session start or import, slowly and needing the network (D5).
- Duplicating the logic in `.bat` and `.sh`: one node script keeps a single source of truth (D2).

### 5. Steps

**S1.** Create `bin/vscode-bridge.js` per §4, modelled on `bin/import.js:1-17`.
- Top doc comment listing both usages, then `'use strict'`, then `require('./lib')` for `REPO`.
- Use `child_process.spawnSync`, not `execFileSync`, so you can read the status without try/catch.
- Export `installCommands` and `codeAvailable`, and run the CLI only under `require.main === module`.
- The exact messages are as in §4.

**S2.** Create `bin/vscode-bridge.test.js`, modelled on `bin/sync.test.js:1-11`: a `// node --test bin/vscode-bridge.test.js` header, `node:test`, and `node:assert/strict`. It contains the tests in §6. It must not spawn `npx` or `code`.

**S3.** `pi-config.sh`:
- Header: add `#   ./pi-config.sh vscode    build and install the VS Code terminal bridge` after the `install` line (line 9). Change the `setup` header line to `import + install + VS Code bridge, for a fresh machine`. Update the help `sed -n '2,12p'` to `'2,13p'` so the help still prints the whole header, then check that the printed help ends with the `setup` line.
- Add a `vscode) node bin/vscode-bridge.js ;;` branch next to `install)` (line 42).
- In `setup)` (lines 43-48), after `install_extensions`, run `node bin/vscode-bridge.js --if-available || echo "WARNING: the VS Code bridge was not installed. Run './pi-config.sh vscode' to retry."`. Keep the final echo lines.

**S4.** `pi-config.bat`:
- Header (lines 11-12): add `REM    pi-config vscode       build and install the VS Code terminal bridge`, and change the setup line to `import + install + VS Code bridge, for a fresh machine`.
- Menu (lines 55-68):
  - Add `echo     8.  VS Code   - install the VS Code terminal bridge`.
  - Renumber Quit to `9`.
  - The prompt becomes `Choose [1-9]`.
  - Add `if "%choice%"=="8" set "CMD=vscode"  & goto dispatch`, and make Quit `if "%choice%"=="9" exit /b 0`.
- Dispatch (line 81 area): add `if /i "%CMD%"=="vscode"  goto do_vscode`.
- Add a `:do_vscode` label modelled on `:do_export` (just before `:do_install`, line 157): echo a header line, run `node bin\vscode-bridge.js`, then `if errorlevel 1 goto failed`, then `goto done`.
- `:do_setup` (lines 174-194):
  - Relabel the two steps "Step 1 of 3" and "Step 2 of 3".
  - After the npm install succeeds, add an `=== Step 3 of 3: VS Code terminal bridge ===` echo and run `node bin\vscode-bridge.js --if-available`.
  - On `errorlevel 1`, echo `  WARNING: the VS Code bridge was not installed. Run "pi-config vscode" to retry.` and do **not** `goto failed`.
  - Then show the existing "Setup complete" lines.
- `:print_help` (lines 204-210): add `echo     vscode     build and install the VS Code terminal bridge`, and change the setup line to `import + install + VS Code bridge, for a fresh machine`.

**S5.** Root `README.md`:
- Line 15 comment: `:: import the config, npm install the extensions, install the VS Code bridge`.
- In the macOS/Linux direct-script block (lines 23-27), add `node bin/vscode-bridge.js      # optional: VS Code terminal bridge for /wt new`.
- In the Day to day table, after line 44, add the row ``| — | `pi-config vscode` | build and install the VS Code terminal bridge used by `/wt new` (skipped by `setup` when `code` is not on PATH) |``.
- Line 152: ``Tests: `node --test bin/sync.test.js bin/vscode-bridge.test.js`.``

**S6.** `pi/agent/extensions/worktree/README.md`, "Install:" block (lines 58-64):
- Replace it with: run `pi-config vscode` from the pi-config repo (or `./pi-config.sh vscode`). `pi-config setup` does it too when `code` is on PATH.
- Keep the two manual commands below it as "or by hand:".
- Leave line 66 ("Reload the VS Code window…") unchanged.

**S7.** Run the tests in §6.
- Then run `node bin/vscode-bridge.js` once for real on this machine. It must end with the `Installed pi-terminal-bridge…` line and exit 0.
- Then `code --list-extensions | grep -i pi-terminal-bridge` must print `pi-config.pi-terminal-bridge`.
- `git status --short` must show no `.vsix` and no `node_modules` or other output under the bridge folder.

### 6. Tests

New `bin/vscode-bridge.test.js`:
- **`installCommands win32 goes through cmd.exe`**: input `installCommands("win32", "C:/t/b.vsix")` must deep-equal:
  ```
  [{ file: "cmd.exe", args: ["/d","/c","npx","--yes","@vscode/vsce","package","--no-dependencies","--allow-missing-repository","--skip-license","-o","C:/t/b.vsix"] },
   { file: "cmd.exe", args: ["/d","/c","code","--install-extension","C:/t/b.vsix","--force"] }]
  ```
- **`installCommands linux runs directly`**: input `installCommands("linux", "/tmp/b.vsix")` must deep-equal:
  ```
  [{ file: "npx", args: ["--yes","@vscode/vsce","package","--no-dependencies","--allow-missing-repository","--skip-license","-o","/tmp/b.vsix"] },
   { file: "code", args: ["--install-extension","/tmp/b.vsix","--force"] }]
  ```
- **`requiring the module runs nothing`**: `require("./vscode-bridge")` returns an object whose `installCommands` and `codeAvailable` are functions, and nothing is printed or spawned. This proves the `require.main` guard.

**Commands, from the repo root:**
- `node --test bin/vscode-bridge.test.js`: expect `ℹ fail 0`, with 3 passing.
- `node --test bin/sync.test.js`: expect `ℹ fail 0`, unchanged.
- `bash pi-config.sh help`: the printed help includes the `vscode` line and ends with the `setup` line.
- `cmd.exe //c "pi-config.bat help"`: the help includes `vscode`.
- The manual end-to-end check from S7.

### 7. Done when

- `pi-config vscode` (bat) and `./pi-config.sh vscode` build the `.vsix` in the OS temp folder and install it into VS Code, ending with `Installed pi-terminal-bridge. Reload each VS Code window, then open a new terminal.`
- When `code` is not on PATH, `pi-config vscode` fails with `ERROR: the VS Code 'code' command is not on PATH.`
- `pi-config setup` runs the bridge install as step 3:
  - It prints `Skipped: …` and continues when `code` is missing.
  - On any other failure it prints the `WARNING: the VS Code bridge was not installed…` line and still finishes with "Setup complete".
- The bat menu offers `8. VS Code`, and Quit moves to 9.
- The sync extension and `bin/import.js`, `bin/export.js`, `bin/lib.js` are unchanged.
- No `.vsix` is in the repo.
- Both READMEs document `pi-config vscode` and the setup step.
- All tests in §6 pass, and `code --list-extensions` shows `pi-config.pi-terminal-bridge` after the S7 run.

### 8. Risks, rollback, and what not to touch

**Risks**
- `npx` needs network access, so `setup` can be slower or warn when offline. That is accepted (D4).
- `cmd.exe /c` quoting breaks if the temp path contains `&`, `^` or `%`. This is documented as the limit in §4.
- Renumbering the bat menu changes muscle memory for "Quit" (8 → 9).
- In `pi-config.sh`, the sed range must match the new header length or the help gets cut off.

**Rollback:** revert the commit. The installed VS Code extension stays and is harmless. Remove it with `code --uninstall-extension pi-config.pi-terminal-bridge` only if the user asks.

**Do not touch:**
- `extension/index.ts`
- `bin/import.js`, `bin/export.js`, `bin/lib.js`, `bin/check-secrets.js`, `bin/sync.test.js`
- `config/`, `local/`
- `pi/agent/extensions/worktree/*.ts`
- `pi/agent/extensions/worktree/vscode/*`
- the live copy under `~/.pi/agent`

### 9. Commits

One function, so one commit:

- `feat(pi-config): pi-config vscode builds and installs the VS Code terminal bridge, run by setup`
  - `bin/vscode-bridge.js`
  - `bin/vscode-bridge.test.js`
  - `pi-config.bat`
  - `pi-config.sh`
  - `README.md`
  - `pi/agent/extensions/worktree/README.md`

<!-- pi-workflow:status -->
## Checklist
- [x] S1 Create `bin/vscode-bridge.js` per §4, modelled on `bin/import.js:1-17`.
- [x] S2 Create `bin/vscode-bridge.test.js`, modelled on `bin/sync.test.js:1-11`: a `// node --test bin/vscode-bridge.test.js` he
- [x] S3 `pi-config.sh`:
- [x] S4 `pi-config.bat`:
- [x] S5 Root `README.md`:
- [x] S6 `pi/agent/extensions/worktree/README.md`, "Install:" block (lines 58-64):
- [x] S7 Run the tests in §6.
## Outcome
2026-10-16T03:48:31.894Z — ok: committed (1 commit)
