<!-- pi-workflow plan v1 flow=20261016-1017-wt-new-opens-a-vs-code-integrated-termin-cc7b -->
## Plan: `/wt new` opens a VS Code integrated terminal when pi runs inside VS Code

### 1. Goal and non-goals

**Goal:** When `/wt new NAME` runs in a pi session that was started in a VS Code integrated terminal, it opens the new pi session in a **new VS Code integrated terminal in that same VS Code window**, not in a Windows Terminal window. Outside VS Code, behaviour stays as it is now. This needs a small companion VS Code extension, kept in this repo and installed on this machine.

**Non-goals:**
- No change to `/wt list`, `/wt remove`, `/wt done`, worktree creation, file linking or the Unity guard.
- No `vscode://` URI handler, and no publishing to the VS Code Marketplace.
- No change to the pi-config sync scripts (`bin/`).
- No end-to-end `/wt new` run by the executor. The user does that.
- Outside VS Code, no change to the macOS/Linux "print the command" behaviour.

### 2. User decisions

- **D1.** Use a companion VS Code extension (`pi-terminal-bridge`). It opens the terminal when pi asks over a local named pipe. pi finds the pipe through the env var `PI_VSCODE_TERMINAL`, which the extension sets for every terminal in its own window, so the request reaches exactly the window pi runs in.
- **D2.** The new terminal opens as a new tab in the terminal panel and is focused (shown).
- **D3.** If the bridge fails, fall back to the existing Windows Terminal / `cmd start` launch and tell the user why. Don't stop with an error.
- **D4.** If pi runs in VS Code (`TERM_PROGRAM=vscode`) but `PI_VSCODE_TERMINAL` is missing, use the existing launch and add a hint: install the bridge, or open a new terminal.
- **D5.** New config key `vscode` (boolean, default `true`). With `false`, the bridge is never used. `launch: "none"` still only prints the command and never uses the bridge.
- **D6.** With the bridge available, this works on macOS/Linux too. Outside VS Code they still only print the command.
- **D7.** The new terminal runs pi directly and closes when pi exits, like the `wt` tab does now.
- **D8.** Install the extension on this machine: package a `.vsix` with `npx @vscode/vsce`, written to the temp dir (never into the repo), then `code --install-extension`.
- **D9.** Edit the repo copy under `D:/projects/pi-config/pi/agent/extensions/worktree/`. The sync extension mirrors it to `~/.pi/agent`.

### 3. Facts the executor needs

- `pi/agent/extensions/worktree/index.ts:93-112` is `launch(cfg, name, cwd, folders)`. It builds `launchSpec(...)` with `findWt()` and `piCommandOf(cfg)`, spawns detached, and returns `{ text, error? }`. Its only caller is `index.ts:162` (`newCmd`), which joins `l.error ?? l.text` into the notify (`warning` level if `error` is set).
- `index.ts:62-66` `piCommandOf(cfg)` returns forward-slash `~/.pi/agent/bin/pi.cmd` on Windows if it exists, otherwise `"pi"` (or `cfg.piCommand`).
- `pi/agent/extensions/worktree/layout.ts:30-57` holds `LaunchSpec`, `LaunchOpts` and `launchSpec()`. `addDirValue(folders, platform)` is at `layout.ts:25` (`;` on win32, `:` elsewhere). The private `backslashes()` is at `layout.ts:28`. The file is pure: no I/O.
- `layout.test.ts:31` has a `base` LaunchOpts object to reuse in new tests.
- `config.ts:6-14` is the `WtConfig` interface, `config.ts:21-31` is `defaults()`, and `config.ts:37-58` is `mergeConfig()`. The `unityGuard` boolean handling at `config.ts:45` is the pattern for the new boolean key.
- `config.test.ts` writes `worktree.json` into a temp dir and calls `loadConfig`. Model new tests on `config.test.ts:27-34`.
- The worktree README: config table at lines ~36-46, "## Launching" at ~48-51, "## Limits", and "## Tests" with the test command at the end.
- Root `README.md:60` has the `pi/agent/extensions/` row that describes `worktree`.
- pi loads `extensions/<dir>/index.ts|js` only (pi docs `extensions.md:46`). A nested `worktree/vscode/` folder without `index.*` is not loaded by pi. **Don't name any file there `index.js`/`index.ts`.**
- The sync mirrors all of `pi/agent/extensions/` (`bin/lib.js:42`). `.gitignore` has no `*.vsix` rule, so the `.vsix` must go to `$TEMP`.
- Environment: Node v24.21.0, `code` CLI on PATH (`C:/Users/IEC-WW/AppData/Local/Programs/Microsoft VS Code/bin/code`), `npx` available. The current terminal is a VS Code terminal (`TERM_PROGRAM=vscode`).

### 4. Design

**Components**
1. **VS Code extension** `pi/agent/extensions/worktree/vscode/` (plain CommonJS JS, no build, no dependencies):
   - `package.json`: `name: "pi-terminal-bridge"`, `publisher: "pi-config"`, `version: "0.1.0"`, `displayName`, `description`, `engines.vscode: "^1.85.0"`, `activationEvents: ["onStartupFinished"]`, `main: "./extension.js"`, no `dependencies`.
   - `extension.js`: `activate(context)` and `deactivate()`.
   - `request.js`: pure `parseRequest(line)`, with no `vscode` import, so it is testable in Node.
   - `request.test.js`: node:test tests for `parseRequest`.
   - `.vscodeignore`: excludes `*.test.js`.
2. **pi side**
   - `layout.ts`: new pure `vscodeTerminalSpec(o: LaunchOpts): VscodeRequest`.
   - New `vscode-bridge.ts`: `sendToVscode(pipe, req, timeoutMs)`, a Node `net` client.
   - `index.ts` `launch()`: picks the bridge first, with fallback.
   - `config.ts`: `vscode` key.

**Contracts**
- Env var: `PI_VSCODE_TERMINAL` = pipe path. Windows: `\\.\pipe\pi-vscode-<process.pid>-<8 random hex>`. Elsewhere: `path.join(os.tmpdir(), "pi-vscode-<pid>-<hex>.sock")`.
- Request: one JSON object on one line, terminated by `\n`, from pi to the extension. Type, exported from `layout.ts`:
  ```ts
  export interface VscodeRequest { name: string; cwd: string; shellPath: string; shellArgs: string[] }
  ```
- Reply: one JSON line from the extension, then it ends the connection: `{"ok":true}\n` or `{"ok":false,"error":"<text>"}\n`.
- `parseRequest(line: string): { ok: true, req: VscodeRequest } | { ok: false, error: string }`. It rejects:
  - invalid JSON;
  - a non-object;
  - `name`, `cwd` or `shellPath` that is not a non-empty string;
  - `shellArgs` that is not an array of strings;
  - `cwd` that is not absolute (`/^([a-zA-Z]:)?[\\/]/`).
  Error strings name the bad field, for example `"bad request: cwd must be an absolute path"`.
- `vscodeTerminalSpec(o)`:
  - `name` = `pi <o.name>`, `cwd` = `o.cwd`.
  - win32: `shellPath: "cmd.exe"`, `shellArgs: ["/d", "/c", backslashes(o.piCommand), ...flag]`.
  - Other platforms: `shellPath: o.piCommand || "pi"`, `shellArgs: flag`.
  - `flag` = `["--add-dir", addDirValue(o.folders, o.platform)]`, or `[]` when there are no folders. No `\;` escaping: that is only for wt.
- `sendToVscode(pipe: string, req: VscodeRequest, timeoutMs = 3000): Promise<string | null>`. It returns `null` on `{ok:true}`. Otherwise it returns an error string:
  - connect error → `"cannot reach VS Code (<err.message>)"`;
  - timeout → `"VS Code did not answer in <n> ms"`;
  - reply `ok:false` → the reply's `error`;
  - invalid reply, or the connection closed without a line → `"bad reply from VS Code"`.
  It never throws. It resolves exactly once, destroys the socket on every path, and clears the timer.
- `WtConfig.vscode: boolean`, default `true`. In `mergeConfig`: if `typeof o.vscode === "boolean"`, use it. A non-boolean value that isn't `undefined` adds the warning `vscode must be true or false` and keeps the default.

**Extension behaviour (`extension.js`)**
- `activate`: create a `net.Server` and listen on the pipe path. On `listening`:
  - set `context.environmentVariableCollection.persistent = false`;
  - set `context.environmentVariableCollection.description = "pi: lets /wt new open a terminal in this window"`;
  - call `context.environmentVariableCollection.replace("PI_VSCODE_TERMINAL", pipePath)`.
- On server `error`: log it with `console.error` and don't set the env var.
- Push a disposable that closes the server, and on non-Windows also unlinks the socket file (ignore errors).
- Per connection:
  - Buffer data until the first `\n`, capped at 64 KB (beyond that, reply with an error and end).
  - `parseRequest`. If it's bad, reply with the error.
  - Otherwise call `vscode.window.createTerminal({ name, cwd, shellPath, shellArgs, location: vscode.TerminalLocation.Panel })`, then `.show(false)` (takes focus), and reply `{ok:true}`.
  - If `createTerminal` throws, reply `ok:false` with the message.
  - Ignore socket errors.

**`launch()` selection order (index.ts)**
1. Compute `spec = launchSpec(...)` as now.
2. Bridge path, taken if `cfg.vscode && cfg.launch !== "none" && process.env.PI_VSCODE_TERMINAL`. Call `sendToVscode(env, vscodeTerminalSpec(sameOpts))`.
   - On `null`, return `{ text: "Opened a new VS Code terminal running pi in <cwd>" }`.
   - On an error string, keep `note = "VS Code terminal failed (<err>), used the fallback. "` and continue with the existing path.
3. Existing path, unchanged. If `"print" in spec`, return the print text.
4. Hint, added only when the bridge was **not** tried, `cfg.vscode` is true, `cfg.launch !== "none"`, and `process.env.TERM_PROGRAM === "vscode"`. Append to the success text: ` (install the pi-terminal-bridge VS Code extension, or open a new VS Code terminal, to get a VS Code terminal instead; see README)`.
5. `note` is prefixed to whatever text/error the existing path returns.
6. On the non-win32 print path, step 2 is also tried first (D6).

**Failure handling**
- A stale pipe (VS Code reloaded, old terminal), a missing extension, or a VS Code that hangs: timeout or connect error → fallback (D3).
- The pipe name is random per activation and the env collection is non-persistent, so restored or old terminals never point at a live pipe of another window.

**Scale:** one request per `/wt new`, a reply in under 100 ms. The 3 s timeout is the limit: a VS Code extension host blocked longer than 3 s causes a fallback, and a terminal may then still open late, giving two sessions. That is acceptable and documented under Limits.

**Security:** the Windows default named-pipe DACL gives write access only to the creator, SYSTEM and admins. Same-user processes can already run anything. The request runs whatever `shellPath` it names. This goes in the README Limits.

**Alternatives rejected**
- `vscode://` URI handler: it shows a confirmation prompt, goes to the last active window, and the scheme differs for Insiders/Cursor.
- A watched request folder: every window would see the file, with no clean targeting.
- `sendText` into a default-shell terminal: quoting depends on the shell (bash/pwsh/cmd).
- Copying an unpacked folder into `~/.vscode/extensions`: unreliable with the `extensions.json` profile manifest.

### 5. Steps

**S1.** `config.ts:6-31,37-58`: add `vscode: boolean` to `WtConfig`, `vscode: true` to `defaults()`, and the merge plus warning in `mergeConfig()` as described in §4. Model it on `unityGuard` at `config.ts:45` and the `launch` warning at `config.ts:46-49`.

**S2.** `layout.ts` (after `launchSpec`, `layout.ts:43`): export `interface VscodeRequest` and `function vscodeTerminalSpec(o: LaunchOpts): VscodeRequest` exactly per §4. Reuse `addDirValue` and `backslashes`. Update the file's header comment to mention the VS Code request.

**S3.** Create `pi/agent/extensions/worktree/vscode-bridge.ts`: a header doc comment, and `export function sendToVscode(pipe: string, req: VscodeRequest, timeoutMs = 3000): Promise<string | null>` per §4. Use `net.createConnection(pipe)`, write `JSON.stringify(req) + "\n"` on connect, read up to the first `\n`, and use a single `finish(result)` guard. Import the type from `./layout.ts`.

**S4.** `index.ts:93-112` `launch()`: implement the selection order from §4. Build the `LaunchOpts` object once and pass it to both `launchSpec` and `vscodeTerminalSpec`. Import `sendToVscode` and `vscodeTerminalSpec`. Update the module header comment at `index.ts:1-5` ("opens a new terminal window or VS Code terminal"). Don't change `newCmd` at `index.ts:162`.

**S5.** Create `vscode/request.js`: CommonJS, `module.exports = { parseRequest }`, per §4.

**S6.** Create `vscode/extension.js` per §4 (CommonJS: `require("vscode")`, `require("net")`, `require("os")`, `require("path")`, `require("crypto")` for the hex, `require("./request.js")`; `module.exports = { activate, deactivate }`). Create `vscode/package.json` per §4 and `vscode/.vscodeignore` containing `*.test.js`.

**S7.** Create `vscode/request.test.js` (node:test, CommonJS) with the cases in §6.

**S8.** Add tests to `layout.test.ts`, `config.test.ts`, and the new `vscode-bridge.test.ts` (see §6).

**S9.** Worktree `README.md`:
- In the `/wt new` row, say "a new Windows Terminal window (or a new VS Code terminal when pi runs in one, see VS Code)".
- Add a `vscode` row to the config table: default `true`, "Open the new session in a VS Code terminal when pi runs in a VS Code terminal with the bridge installed. `false` always uses Windows Terminal."
- New `## VS Code` section after `## Launching`:
  - how it works (the extension sets `PI_VSCODE_TERMINAL` per window, and pi sends a one-line JSON request over the pipe);
  - the install commands from S11;
  - "reload the window, then open a new terminal";
  - the fallback and hint behaviour.
- Add to `## Limits`:
  - terminals opened before the extension activated use Windows Terminal;
  - after a 3 s timeout the fallback opens, and a late VS Code terminal can still appear;
  - any same-user process can ask the bridge to open a terminal running any program.
- Update the `## Tests` command to add `vscode-bridge.test.ts`, plus a second line `node --test vscode/request.test.js`.

Root `README.md:60`: add "(in VS Code: a new VS Code terminal via the bundled `pi-terminal-bridge` extension)" to the worktree description.

**S10.** Run the tests from §6. All must pass.

**S11.** Install on this machine, from the repo copy, in bash:
```
cd /d/projects/pi-config/pi/agent/extensions/worktree/vscode
npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository --skip-license -o "$TEMP/pi-terminal-bridge.vsix"
code --install-extension "$TEMP/pi-terminal-bridge.vsix" --force
code --list-extensions | grep -i pi-terminal-bridge
```
- If vsce stops at an interactive prompt (for example about a missing README or LICENSE), add a short `vscode/README.md`, and an MIT `LICENSE` only if it is still needed, then rerun.
- Don't commit the `.vsix`.
- Report the outcome. The user reloads the VS Code windows; the executor can't.

**S12.** `git status` must show no `.vsix` or other build output inside the repo.

### 6. Tests

**`layout.test.ts`** (reuse `base` from `layout.test.ts:31`):
- `vscodeTerminalSpec win32`: with `base`, expect `{ name: "pi x", cwd: "D:/c", shellPath: "cmd.exe", shellArgs: ["/d", "/c", "pi.cmd", "--add-dir", "A;B"] }`.
- `vscodeTerminalSpec win32 backslashes piCommand`: `piCommand: "C:/u/pi.cmd"` → `shellArgs[2] === "C:\\u\\pi.cmd"`.
- `vscodeTerminalSpec no folders`: `folders: []` → `shellArgs` is `["/d", "/c", "pi.cmd"]`.
- `vscodeTerminalSpec linux`: `platform: "linux", piCommand: ""` → `shellPath: "pi"`, `shellArgs: ["--add-dir", "A:B"]`.

**`config.test.ts`:**
- `defaults without file`: also `assert.equal(cfg.vscode, true)`.
- `vscode false is read`: `{ vscode: false }` → `cfg.vscode === false`, no warning.
- `bad vscode warns`: `{ vscode: "no" }` → `cfg.vscode === true`, warning matches `/vscode/`.

**`vscode-bridge.test.ts`** (new; header comment with its run command; start a `net.Server` on a unique pipe: `\\.\pipe\pi-test-<pid>-<n>` on win32, a socket in `os.tmpdir()` elsewhere):
- `ok reply`: the server reads a line, checks the parsed JSON equals the sent req, and writes `{"ok":true}\n` → resolves `null`.
- `error reply`: the server writes `{"ok":false,"error":"boom"}\n` → resolves `"boom"`.
- `bad reply`: the server writes `nope\n` → resolves `"bad reply from VS Code"`.
- `nothing listening`: an unused pipe name → resolves a string matching `/cannot reach VS Code/`.
- `timeout`: the server never answers, `timeoutMs: 200` → resolves `"VS Code did not answer in 200 ms"`.
- Close every server after each test so the process exits.

**`vscode/request.test.js`:**
- A valid request → `ok: true` and the same object.
- Invalid JSON → `ok: false`.
- A missing `name` → error mentions `name`.
- `cwd: "rel/dir"` → error mentions `cwd`.
- `shellArgs: [1]` → error mentions `shellArgs`.
- `"null"` → `ok: false`.

**Commands** (from `pi/agent/extensions/worktree`):
```
node --experimental-strip-types --test config.test.ts layout.test.ts files.test.ts git-ops.test.ts manage.test.ts unity-guard.test.ts vscode-bridge.test.ts
node --test vscode/request.test.js
```
Expected: `# fail 0` in both, and the pass count goes up by the new tests.

### 7. Done when

- `/wt new NAME` from pi in a VS Code terminal of a window with the bridge active opens a new focused terminal tab in that window's panel. The tab is titled `pi NAME`, runs pi in the worktree cwd with the correct `--add-dir`, and closes when pi exits. The notify says "Opened a new VS Code terminal running pi in …".
- If the bridge is unreachable, it errors, or it times out, the old Windows Terminal / `cmd` launch runs, and the notify starts with "VS Code terminal failed (…), used the fallback."
- In a VS Code terminal without `PI_VSCODE_TERMINAL`, the old launch runs and the notify carries the install/new-terminal hint.
- Outside VS Code, behaviour is byte-for-byte the same as before.
- `vscode: false` in `worktree.json` disables the bridge and the hint. `launch: "none"` still only prints the command.
- All tests in §6 pass.
- The extension is installed on this machine (`code --list-extensions` shows `pi-config.pi-terminal-bridge`), and no `.vsix` is in the repo.
- The README documents the behaviour, the `vscode` key, the install steps and the limits.

### 8. Risks, rollback, what not to touch

**Risks**
- `createTerminal` with `cmd.exe /d /c` joins args with node-pty quoting. Paths with spaces are already unsupported (README Limits).
- vsce may need network access or prompt. Handle it as in S11.
- The env var only reaches terminals opened after activation. This is documented.

**Rollback**
- `code --uninstall-extension pi-config.pi-terminal-bridge`.
- Set `"vscode": false` in `~/.pi/agent/worktree.json`, or revert the commits.

**Don't touch**
- `manage.ts`, `git-ops.ts`, `files.ts`, `unity-guard.ts`, `bin/`, the `workflow` extension, the live `~/.pi/agent` copy (the sync handles it), and the user's existing sets under `D:/projects/wt/`.
- Don't remove the `.bak` files in `~/.pi/agent/extensions/worktree`.

### 9. Commits

1. `feat(worktree): pi-terminal-bridge VS Code extension that opens a terminal on request`: `pi/agent/extensions/worktree/vscode/package.json`, `extension.js`, `request.js`, `request.test.js`, `.vscodeignore` (plus `README.md`/`LICENSE` only if S11 needed them).
2. `feat(worktree): /wt new opens a VS Code terminal through the bridge when run in VS Code`: `config.ts`, `config.test.ts`, `layout.ts`, `layout.test.ts`, `vscode-bridge.ts`, `vscode-bridge.test.ts`, `index.ts`, `pi/agent/extensions/worktree/README.md`, root `README.md`.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 `config.ts:6-31,37-58`: add `vscode: boolean` to `WtConfig`, `vscode: true` to `defaults()`, and the merge plus warning 
- [x] S2 `layout.ts` (after `launchSpec`, `layout.ts:43`): export `interface VscodeRequest` and `function vscodeTerminalSpec(o: L
- [x] S3 Create `pi/agent/extensions/worktree/vscode-bridge.ts`: a header doc comment, and `export function sendToVscode(pipe: st
- [x] S4 `index.ts:93-112` `launch()`: implement the selection order from §4. Build the `LaunchOpts` object once and pass it to b
- [x] S5 Create `vscode/request.js`: CommonJS, `module.exports = { parseRequest }`, per §4.
- [x] S6 Create `vscode/extension.js` per §4 (CommonJS: `require("vscode")`, `require("net")`, `require("os")`, `require("path")`
- [x] S7 Create `vscode/request.test.js` (node:test, CommonJS) with the cases in §6.
- [x] S8 Add tests to `layout.test.ts`, `config.test.ts`, and the new `vscode-bridge.test.ts` (see §6).
- [x] S9 Worktree `README.md`:
- [x] S10 Run the tests from §6. All must pass.
- [x] S11 Install on this machine, from the repo copy, in bash:
- [x] S12 `git status` must show no `.vsix` or other build output inside the repo.
## Outcome
2026-10-16T03:23:06.960Z — ok: committed (2 commits)
