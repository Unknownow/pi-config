<!-- pi-workflow plan v1 flow=20261015-1035-worktree-pi-extension-parallel-pi-sessio-3516 -->
## Plan: `worktree` pi extension, parallel pi sessions on git worktrees (`/wt new|list|remove` + Unity guard)

### 1. Goal and non-goals

**Goal.** Several pi sessions can work on the same repos at the same time without copying them. `/wt new <name>`, run from any pi session:
- creates a git worktree for the working repo and for every added folder;
- sets up the gitignored files: big folders are linked, small configs are copied;
- opens a new Windows Terminal window in the new worktree, running `pi` with all the matching folders as added folders.

`/wt list` shows the worktree sets. `/wt remove <name>` deletes a set safely. In a session that runs inside a worktree, a guard stops the agent from driving the Unity Editor that belongs to the main session.

**Non-goals.**
- No per-worktree Unity `Library/`, and no `--unity` / `unity vcs git worktree --seed` option. The user chose one Editor, in the original folder.
- No moving the current session into a worktree (`switchSession`).
- No change to the `workflow` extension, game-template, knowledge or unity-packages.
- No automatic cleanup or `git worktree prune`.
- No support for paths that contain spaces or `;`.
- On macOS/Linux there is no terminal launch: the extension prints the command to run.

### 2. User decisions

- D1. Use git worktrees, which share the `.git` object store, instead of duplicating the folders (the disk is low).
- D2. Build it as a pi extension.
- D3. `/wt new` does everything in one go: create the worktrees for the working folder and all added folders, copy and link the gitignored files, and open another shell window running `pi` with all the folders set.
- D4. A new window, not a tab. A tab is available only as a config option (`launch: "tab"`).
- D5. Big gitignored folders are linked with a junction, small configs are copied, and Unity `Library/` is never touched.
- D6. Layout: `D:/projects/wt/<name>/<repo>`, branch `wt/<name>`, started from `origin/<default branch>` (`main`, or `master` for pi-config).
- D7. Only the session in the original folder uses the Unity Editor. Worktree sessions may use the Unity CLI but must not drive that Editor:
  - a guard refuses Editor-driving and project-running `unity` commands unless `--project-path` points inside the session's own worktree set;
  - the system prompt tells the agent that the Editor belongs to another session;
  - sessions in the original folder are not restricted.
- D8. `/wt list` shows each set and its repos: branch, uncommitted changes, ahead/behind, whether a `Library/` exists, and which Unity Editors are open for it.
- D9. `/wt remove` refuses when there are uncommitted changes or unpushed commits. Otherwise it asks for confirmation, removes the junctions first (never their targets), never uses `--force`, and deletes the branch only if it is merged.

### 3. Facts the executor needs

- **Extension location.** `~/.pi/agent/extensions/<name>/index.ts` is loaded automatically: `workflow` is in that folder and is not listed in `settings.json` (`pi/agent/settings.json:25-27` lists only the sync extension).
  - The repo mirrors `~/.pi/agent` under `pi/agent` (`README.md:60`), so the new code goes in `D:/projects/pi-config/pi/agent/extensions/worktree/`.
  - The sync extension imports it at session start.
- **Extension entry point.** Model on `export default function workflow(pi: ExtensionAPI)` at `pi/agent/extensions/workflow/index.ts:265`, with types imported from `@earendil-works/pi-coding-agent` (`extension/index.ts:19`).
- **Command API.**
  - `pi.registerCommand(name, { description, handler, getArgumentCompletions? })` (`types.d.ts:1231`, `:1175`).
  - `ctx.ui.notify(message, "info"|"warning"|"error")` (`types.d.ts:80`), `ctx.ui.confirm(title, message)` (`:76`), `ctx.hasUI` (`:219`), `ctx.cwd` (`:221`).
  - `pi.exec(cmd, args, { cwd, timeout })` (`types.d.ts:1280`, `exec.d.ts:11-13`).
  - The `/folders` command is the model for a subcommand-style command: `workflow/index.ts:2623-2708`.
- **Added folders of the current session.** The workflow saves them in custom session entries with `customType === "workflow-state"` (`index.ts:170`) and `data.folders: string[]` (absolute, forward slashes; `index.ts:146-147`). Read the last such entry from `ctx.sessionManager.getBranch()` as `index.ts:2548-2550` does. No entry means no added folders.
- **Starting pi with folders.** `pi --add-dir "<a>;<b>"` on Windows, `:` elsewhere (`index.ts:292-295`; `workflow/README.md:259`).
- **pi executable.** `C:/Users/IEC-WW/.pi/agent/bin/pi.cmd` exists, alongside `pi.ps1`, `pi` and `pi-launcher.js`. `wt.exe` is at `%LOCALAPPDATA%/Microsoft/WindowsApps/wt.exe`.
  - Windows Terminal treats `;` in its command line as a separator between its own commands. A literal `;` must be written as `\;`.
- **Shell guard pattern.**
  - The `tool_call` handler inspects `bash`, `ctx_execute(_file)` (shell languages plus a regex on other code) and `ctx_batch_execute` (`workflow/index.ts:1580-1600`), and returns `{ block: true, reason }`.
  - `parseCommands(text): ParsedCommand[]` with `.words` / `.env` is at `workflow/readonly-bash.ts:248` (interface at `:17-23`). Wrappers come from `WRAPPERS`/`KEYWORDS` (`:269-281`), and `push-guard.ts:76-100` shows how to unwrap them and `bash -c` (`commandName` at `:72-74`).
  - Import `parseCommands`, `WRAPPERS` and `KEYWORDS` from `../workflow/readonly-bash.ts`. Do not copy the lexer.
- **System prompt section.** In `before_agent_start`, set `event.systemPromptOptions.sections.<key> = text` (`workflow/index.ts:1553-1556`).
- **Workflow and worktrees.** The workflow already works with worktrees: plans go under `git rev-parse --git-common-dir` (`plan-store.ts:13`), and repo detection uses `existsSync(".git")` (`index.ts:1153`). No change is needed there.
- **Gitignored files in game-template.**
  - `.pi/git/` and `.pi/npm/` (`.gitignore:68-69`). `.pi/git` is 405 MB, which is pi's project package install.
  - `/unity/[Aa]ssets/IecGenerated/` and `IecGenerated.meta` (`.gitignore:96-97`); this folder is absent today.
  - `.pi/settings.json` is tracked.
- **Unity CLI.**
  - Without `--project-path`, the CLI targets the Editor whose project contains the current folder; when none does, it fails with `AMBIGUOUS_EDITOR` (`game-template/.agents/skills/unity-cli/references/integration-advanced.md`, "Targeting one of several running Editors").
  - `unity status --format json` lists `data.instances[].project`.
- **Tests.** `node --experimental-strip-types --test <files>` with `node:test` and `node:assert/strict` (`workflow/README.md:181`; `workflow/repos.test.ts:1-5`).
- **pi-config auto-sync.** The sync extension commits exported paths by itself (`extension/index.ts:262-267`, commits named `chore(config): sync from ...`). It can pick up new files under `pi/agent/` before the executor commits them.

### 4. Design

**Components.** All under `pi/agent/extensions/worktree/`. Keep every function at 50 lines or fewer.

| File | Responsibility |
|---|---|
| `config.ts` | `loadConfig(agentDir, workingRepoParent): WtConfig`. Reads `~/.pi/agent/worktree.json` if present and fills defaults; a bad JSON file gives a warning and the defaults. |
| `layout.ts` (pure) | Name check, set and repo paths, branch name, `--add-dir` value, launch argv, the link/copy plan for a repo. |
| `git-ops.ts` | Every git step, behind an injected runner `type Git = (cwd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>`. Index passes a wrapper around `pi.exec("git", ...)`; tests pass a fake. |
| `files.ts` | `linkDir(target, at)`, `copyPath(src, dst)`, `unlinkLink(at)`. Real `fs`, tested in temp folders. |
| `unity-guard.ts` (pure) | `unityProblem(text, { cwd, setRoot, platform }): string \| null`. |
| `index.ts` | Registers `/wt` and the `session_start`, `before_agent_start` and `tool_call` handlers; wires the modules together and launches the terminal. |
| `README.md` | Usage, config, the Unity rule, limits. |

**Config (`worktree.json`, every key optional).**

```json
{ "root": "D:/projects/wt", "branchPrefix": "wt/", "launch": "window",
  "piCommand": "", "link": [".pi/git", ".pi/npm", "node_modules"],
  "copy": ["unity/Assets/IecGenerated", "unity/Assets/IecGenerated.meta"], "unityGuard": true }
```

- `root`: default `<parent folder of the working repo>/wt`. For this machine that is `D:/projects/wt`.
- `launch`: `"window" | "tab" | "none"`, default `"window"`.
- `piCommand`: an empty value means `~/.pi/agent/bin/pi.cmd` on Windows if it exists, otherwise `pi`.
- `link` / `copy`: paths relative to each repo's root, applied to every repo. A source that is missing is skipped silently.
- No config file is committed; the defaults live in code.

**Paths.**
- Set root: `<root>/<name>`. Repo worktree: `<root>/<name>/<basename of repo top level>`. Branch: `<branchPrefix><name>`.
- Name rule: `^[a-z0-9][a-z0-9._-]{0,39}$`, and `git check-ref-format --branch <branch>` must succeed.
- `root` must be absolute and contain no space or `;`. Paths are always stored with forward slashes.

**`/wt new <name>`.**

1. **Collect repos.** First `ctx.cwd`, then the folders from the last `workflow-state` entry, in order.
   - For each, `git rev-parse --show-toplevel`. A non-git folder is passed through unchanged as an added folder.
   - Two repos with the same basename → error.
   - The working folder not being a git repo → error ("run /wt new from a git repo").
2. **Preflight every repo before changing anything.**
   - Remote: `origin`, else the first line of `git remote`, else error.
   - `git fetch <remote> --quiet` with a 60 s timeout. On failure, warn and continue.
   - Base ref: `git rev-parse --abbrev-ref <remote>/HEAD`. If that fails, the first of `<remote>/main` or `<remote>/master` that passes `rev-parse --verify`. None → error.
   - The target path must not exist (error), and the branch must not exist (`git show-ref --verify refs/heads/<branch>` succeeds → error).
3. **Create.** For each repo: `git -C <repo> worktree add --no-track -b <branch> <target> <baseRef>`.
   - `--no-track` keeps the upstream unset until the first `git push -u`. The unpushed check depends on that.
4. **Files.** For each created worktree:
   - Each `link` entry whose source is a directory in the original repo and whose destination does not exist: create parent folders, then a junction on Windows or a `dir` symlink elsewhere, with an absolute target.
   - A `link` source that is a file → warning, skipped.
   - Each `copy` entry: recursive copy, never overwriting an existing destination.
5. **Rollback.** If any step from 3 onward fails:
   - for each worktree created in this run, remove the links (`unlinkLink`), then `git worktree remove --force <target>`, then `git branch -D <branch>`;
   - remove `<root>/<name>` if it is now empty;
   - report the original error.

   `--force` and `-D` are allowed only here, on worktrees and branches this same run just created.
6. **Launch** (Windows):
   - `window`: `wt.exe -w new new-tab -d <wtCwd> --title "pi <name>" <piCommand> [--add-dir <folders joined with "\;">]`.
   - `tab`: the same with `-w 0` in place of `-w new`.
   - `--add-dir` is left out when there are no folders. The folders are the new worktrees of the added folders plus the non-git folders as they are, in the original order.
   - If `wt.exe` is not found on PATH or in `%LOCALAPPDATA%/Microsoft/WindowsApps`: `cmd.exe /c start "pi <name>" /D <wtCwd> <piCommand> [--add-dir <folders joined with ";">]`.
   - Spawn detached with `stdio: "ignore"`, then `unref()`.
   - Non-Windows or `launch: "none"`: no spawn; the notify shows `cd <wtCwd> && pi --add-dir '<a>:<b>'`.
7. **Notify.** One message listing each repo → path and branch, the links and copies made, and what was launched.

**`/wt list`.** Sets are the folders in `<root>`; repos are the subfolders that contain a `.git` file. For each repo, one line:
- branch;
- dirty count (`git status --porcelain`);
- ahead/behind: against the upstream if set, otherwise "not pushed: N commits" against the base ref;
- `Library: yes/no` (does `unity/Library` exist; never compute its size);
- `Editor open: yes/no/unknown`, from one `unity status --format json` call with a 10 s timeout, matching `instances[].project` under that repo. `unknown` if the call fails.

No root or no sets → "No worktree sets in <root>".

**`/wt remove <name>`.**

1. Refuse if `ctx.cwd` or any current added folder is inside `<root>/<name>`.
2. Refuse without a UI (`!ctx.hasUI`).
3. For each repo: `git fetch` (warn on failure). Then refuse if:
   - `status --porcelain` is not empty; or
   - an upstream exists and `rev-list --count @{u}..HEAD` > 0; or
   - there is no upstream (or it is gone) and `rev-list --count <baseRef>..HEAD` > 0.

   Squash merges therefore count as unpushed; the README says to delete those by hand. Any refusal lists all problems and changes nothing.
4. Confirm. The message lists every path and, for each repo that has one, notes that its `Library/` will be deleted.
5. For each repo:
   - unlink each configured `link` path only if `lstat` says it is a symbolic link or junction;
   - `git -C <main repo> worktree remove <path>` without `--force` (the main repo is the parent of the absolute `--git-common-dir`);
   - `git -C <main repo> branch -d <branch>`. If that refuses, keep the branch and say so.

   On the first failed `worktree remove`, stop and report what was removed.
6. `rmdir <root>/<name>` only if it is empty.

**Worktree session detection** (at `session_start`, cached). The session is a worktree session when both hold:
- `git rev-parse --show-toplevel` of `ctx.cwd` is under `<root>/` (case-insensitive on Windows);
- `--absolute-git-dir` ≠ the absolute `--git-common-dir`.

`setRoot = <root>/<first path segment below root>`.

**System prompt** (worktree sessions only, `before_agent_start`). Set `sections.worktree` to:

> This session runs in the git worktree set `<setRoot>` (branch `<branch>`). The open Unity Editor belongs to another session: do not drive it. Unity commands that drive an Editor or run a project are refused unless `--project-path` is an absolute path inside `<setRoot>`. For Unity checks, commit and ask the user to run them in the Editor session.

If a repo in the set has `unity/ProjectSettings`, add: "This set's Unity project: `<path>/unity`."

**Unity guard** (worktree sessions with `unityGuard` on). The `tool_call` handler covers the same tools as `workflow/index.ts:1584-1600`.

- **Shell text:** `parseCommands`, then unwrap keywords, `NAME=value`, `WRAPPERS` and `bash|sh -c` (recurse into the `-c` text). A command counts when `commandName(words[0])` is `unity`.
- **Its subcommand:** the first argument that does not start with `-` and is not the value of `--project-path`, `--format`, `--timeout`, `--runtime` or `--runtime-path`.
- **Guarded subcommands:** `command`, `cmd`, `recompile`, `list`, `job`, `mcp`, `run`, `test`, `build`, `pipeline`. Others (`status`, `install`, `auth`, `vcs`, `projects`, `doctor`, ...) pass.
- **A guarded command passes only if** its `--project-path <p>` or `--project-path=<p>`, resolved against `ctx.cwd`, normalised and compared case-insensitively on Windows, is `setRoot` or below it.
  - Missing, outside, or any `UNITY_PROJECT_PATH` assignment in the text → refuse with the reason `Refused (worktree): <why>. The Unity Editor belongs to another session; pass --project-path <absolute path inside setRoot> or ask the user to run it in the Editor session.`
- **Non-shell `ctx_execute` code:** refuse when it matches `/\bunity(\.exe)?\b/` and `/\b(command|cmd|recompile|list|job|mcp|run|test|build|pipeline)\b/`.
- **Limit:** `cd` inside the text is ignored for path resolution. The guard reads command text; it is not a sandbox.

**Failure handling.** Every user-facing error goes through `ctx.ui.notify(..., "error")`, and no exception escapes a handler. Git failures quote the repo and the first line of stderr.

**Scale.** About 2–6 repos per set and up to about 20 sets. `/wt list` makes about 4 git calls per repo, in sequence, so roughly 1–3 s for 20 repos. Past about 50 sets, `list` gets slow; acceptable.

**Alternatives rejected.**
- `switchSession` into the worktree: not verified across folders, and the user wanted a separate window.
- Copying `.pi/git`: 405 MB, which defeats the purpose.
- `unity vcs git worktree add`: makes a `Library/`, against D7.
- A per-repo config table: not needed, because missing sources are skipped.

### 5. Steps

#### Stage 1: `/wt new`: create worktrees, set up files, launch pi

**S1.** Create `pi/agent/extensions/worktree/config.ts` with:
- `WtConfig` (the keys in §4);
- `DEFAULTS`;
- `loadConfig(agentDir: string, workingRepoParent: string): { cfg: WtConfig; warning?: string }`.

Behaviour: a missing file gives the defaults. Bad JSON gives the defaults plus a warning. An unknown `launch` value becomes `"window"` with a warning. `root` is resolved to an absolute path with forward slashes.

**S2.** Create `layout.ts` (pure):
- `checkName(name): string | null`: the error text, or null.
- `setRootOf(cfg, name)`, `targetOf(cfg, name, repoTop)`, `branchOf(cfg, name)`.
- `addDirValue(folders, platform)`: joins with `;` on Windows, `:` elsewhere.
- `launchSpec(opts): { file: string; args: string[] } | { print: string }`. Inputs: platform, `launch`, `wtPath | null`, `piCommand`, `cwd`, `name`, `folders`. It follows §4 step 6 exactly, including `\;` for `wt.exe` and plain `;` for `cmd start`.
- `rootProblem(root): string | null`: not absolute, or contains a space or `;`.

Model the pure-module style on `workflow/repos.ts`.

**S3.** Create `files.ts`:
- `linkDir(target, at)`: makes parent folders; junction on win32, `"dir"` symlink elsewhere.
- `copyPath(src, dst)`: `fs.cpSync` with `recursive: true`, `force: false`, `errorOnExist: false`.
- `isLink(at)`: `lstat().isSymbolicLink()`.
- `unlinkLink(at)`: removes only the link, never following it. Try `fs.unlinkSync`; on `EPERM`/`EISDIR` use `fs.rmdirSync`. It throws if `at` is not a link.
- `setupFiles(repoTop, wt, cfg): { linked: string[]; copied: string[]; warnings: string[] }`.

**S4.** Create `git-ops.ts` with the `Git` type (§4) and:
- `repoInfo(git, dir)`: `{ top, remote, baseRef, mainRepo, isLinked } | { error }`;
- `preflight(git, repos, cfg, name)`: all checks of §4 step 2, returning every error found, not only the first;
- `createAll(git, plan, onCreated)` and `rollback(git, created, cfg)`.

The `worktree add` argv must be exactly `["worktree", "add", "--no-track", "-b", branch, target, baseRef]`.

**S5.** Create `index.ts`:
- `export default function worktree(pi: ExtensionAPI)`;
- registers `/wt` with the subcommands `new <name>`, `list`, `remove <name>`, and argument completion for the subcommand names;
- `list` and `remove` reply "not yet available" until Stage 2;
- `new` follows §4 steps 1–7, reading the folders from `workflow-state` as at `workflow/index.ts:2548-2550`;
- the spawn for the launch uses `child_process.spawn(file, args, { detached: true, stdio: "ignore", cwd })` then `.unref()`;
- the `wt.exe` lookup walks the PATH entries, then `%LOCALAPPDATA%/Microsoft/WindowsApps`.

**S6.** Create `README.md` (sections: what it does, commands, config keys and defaults, the links and copies, Windows Terminal details, limits). Add one line to the root `README.md` near the `pi/agent/extensions/` row (`README.md:60`) naming the extension and `/wt`.

**S7.** Manual check, then clean up:
- In a pi session in `D:/projects/pi-config` (pi-config only, to keep it small), after the sync import or a pi restart, run `/wt new smoke`.
- Confirm: the worktree exists at `D:/projects/wt/smoke/pi-config` on `wt/smoke`, and a new window opened running pi there.
- Close that window. Remove the test worktree by hand: `git -C D:/projects/pi-config worktree remove D:/projects/wt/smoke/pi-config`, then `git branch -d wt/smoke`, then delete the empty folders.
- Report the result. If the sync extension is not active in this session, say the manual check was skipped and why.

#### Stage 2: `/wt list` and `/wt remove`

**S8.** In `git-ops.ts` add:
- `repoStatus(git, wt, baseRef)`: `{ branch, dirty, upstream | null, ahead, behind, unpushed }`. "Upstream gone" (rev-parse `@{u}` fails) is treated as no upstream.
- `removeChecks(git, wts)`: all refusal reasons of §4 `/wt remove` step 3.

**S9.** In `index.ts`, implement `list` as described in §4. The Unity status comes from one `pi.exec("unity", ["status", "--format", "json"], { timeout: 10000 })`; any error or bad JSON → `unknown`.

**S10.** Implement `remove` exactly as §4 `/wt remove` steps 1–6, using `files.unlinkLink` only on paths where `isLink` is true. Add completion of set names after `remove`. Update the README.

#### Stage 3: Unity guard and the system prompt in worktree sessions

**S11.** Create `unity-guard.ts`:
- `unityProblem(text, o: { cwd: string; setRoot: string; platform: NodeJS.Platform }): string | null`, following §4 "Unity guard"; reuse `parseCommands`, `WRAPPERS` and `KEYWORDS` from `../workflow/readonly-bash.ts`;
- `codeProblem(code): string | null` for non-shell code.

The reason strings start with `Refused (worktree): `.

**S12.** In `index.ts`:
- **Detection:** at `session_start`, the worktree-session check of §4, cached as `{ setRoot, branch } | null`.
- **`before_agent_start`:** set `sections.worktree` to the §4 text when detected.
- **`tool_call`:** when detected and `unityGuard` is on, collect texts the way `workflow/index.ts:1584-1600` does and return `{ block: true, reason }` on the first problem.

Update the README with the Unity rule (a worktree session never drives the original Editor) and the guard's limits.

### 6. Tests

Run from `pi/agent/extensions/worktree`:

```
node --experimental-strip-types --test config.test.ts layout.test.ts files.test.ts git-ops.test.ts unity-guard.test.ts
```

Expected: every test passes, 0 fail. Also run the workflow suite (`workflow/README.md:181` command) unchanged: everything passes.

- **`config.test.ts`** (Stage 1):
  - "defaults without file": root = `<parent>/wt`, launch `window`;
  - "bad json warns and uses defaults";
  - "unknown launch falls back to window".
- **`layout.test.ts`** (Stage 1):
  - "checkName": `ads-fix` passes; `Ads`, `-x`, `a b`, `a;b` and a 41-character name each give an error.
  - "paths": with root `D:/projects/wt`, name `x` and repo top `D:/projects/game-template`, the target is `D:/projects/wt/x/game-template` and the branch `wt/x`.
  - "rootProblem": relative paths and paths with a space give an error.
  - "addDirValue": `;` on win32, `:` on linux.
  - "launchSpec window": args equal `["-w","new","new-tab","-d",cwd,"--title","pi x",pi,"--add-dir","A\\;B"]`.
  - "launchSpec tab": uses `-w 0`.
  - "launchSpec no folders": no `--add-dir`.
  - "launchSpec cmd fallback": plain `;` and the `start` title.
  - "launchSpec linux/none": `{ print }` containing `--add-dir 'A:B'`.
- **`files.test.ts`** (Stage 1; junction cases run on win32 only, otherwise skipped):
  - "linkDir then unlinkLink keeps target": the target folder and its file still exist after unlinking.
  - "unlinkLink refuses a real folder": throws, and the folder remains.
  - "setupFiles skips missing sources and existing destinations".
  - "copy does not overwrite".
- **`git-ops.test.ts`** (fake `Git` that records calls; Stages 1–2):
  - "preflight collects all errors": an existing branch and an existing target both reported.
  - "baseRef falls back to origin/master".
  - "worktree add argv uses --no-track".
  - "rollback removes only created worktrees, links first".
  - "removeChecks dirty", "removeChecks ahead of upstream", "removeChecks no upstream with commits", "removeChecks upstream gone → base check", "removeChecks clean passes".
- **`unity-guard.test.ts`** (Stage 3), with setRoot `D:/projects/wt/x` and cwd `D:/projects/wt/x/game-template`:
  - `unity status` passes;
  - `unity cmd console_status` (no path) is refused;
  - `unity cmd x --project-path D:/projects/game-template/unity` is refused;
  - `unity --project-path=D:/projects/wt/x/game-template/unity recompile` passes;
  - the relative `--project-path unity` passes (it resolves inside the set);
  - `env A=1 unity recompile` is refused;
  - `bash -c "unity test --project-path D:/projects/game-template/unity"` is refused;
  - `UNITY_PROJECT_PATH=D:/x unity status` is refused;
  - `unity install 6000.3.25f1` passes;
  - a case-insensitive path on win32 passes;
  - `codeProblem` refuses `spawn('unity',['recompile'])` and passes `const community = 1`.

Stage 3 manual check, if a worktree session can be started: in a worktree session, ask the agent to run `unity cmd console_status`. Expected: refused with the `Refused (worktree):` text.

### 7. Done when

- `/wt new <name>` in a session with added folders creates one worktree per git repo under `<root>/<name>/<repo>` on `wt/<name>`, starting from `origin/<default>` with no upstream. It links `.pi/git`, `.pi/npm` and `node_modules` where they exist, copies `IecGenerated` where it exists, and opens a new Windows Terminal window running pi in the working repo's worktree with `--add-dir` set to the matching worktrees.
- Any failure leaves no partial set behind.
- `/wt list` shows the D8 columns. `/wt remove` behaves as D9, and its tests prove junction targets survive.
- In a worktree session, Editor-driving `unity` commands without a `--project-path` inside the set are refused, and the system prompt carries the worktree section. Sessions outside `<root>` are unaffected.
- All new tests and the existing workflow tests pass. The README documents commands, config and limits.

### 8. Risks, rollback, what not to touch

**Risks.**
- **Removal following a junction.** `git worktree remove` or `rmSync` could follow a junction into the original `.pi/git`. Mitigation: links are removed only with `unlinkLink` before any removal, and there is a test for it.
- **Windows Terminal quoting.** Mitigated by refusing spaces and `;` in paths; covered by the `launchSpec` tests and the S7 manual check.
- **A shared `node_modules`.** The worktree uses the original's packages, which can be wrong if the worktree changes `package.json`; noted in the README.
- **Auto-sync commits.** The pi-config sync extension may commit new files as `chore(config): sync` before the planned commits. Check `git log` and report it; do not rewrite history.
- **Text-level guard.** Disguised commands get past it; stated in the README.

**Rollback.** Delete the `pi/agent/extensions/worktree/` folder in the repo and in `~/.pi/agent/extensions/`, then restart pi.

**Do not touch.**
- `workflow/*`: import from it only.
- The game-template, knowledge and unity-packages repos.
- Existing worktrees or branches not created by the current `/wt new` run.
- Never `git worktree prune`, `--force` (except the rollback in §4 step 5), or `branch -D` outside that rollback.

### 9. Commits

All in `D:/projects/pi-config`.

1. `feat(worktree): /wt new creates worktrees and opens pi in a new window`: `pi/agent/extensions/worktree/{config,layout,files,git-ops,index}.ts`, `{config,layout,files,git-ops}.test.ts`, `worktree/README.md`, `README.md`.
2. `feat(worktree): /wt list and /wt remove`: `git-ops.ts`, `git-ops.test.ts`, `index.ts`, `worktree/README.md`.
3. `feat(worktree): guard Unity Editor commands in worktree sessions`: `unity-guard.ts`, `unity-guard.test.ts`, `index.ts`, `worktree/README.md`.

## Plan choices upheld by the user
pi/agent/extensions/worktree/unity-guard.ts:116 - minor - [plan-flaw] The check for non-shell code produces false refusals in Unity repos.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 Create `pi/agent/extensions/worktree/config.ts` with:
- [x] S2 Create `layout.ts` (pure):
- [x] S3 Create `files.ts`:
- [x] S4 Create `git-ops.ts` with the `Git` type (§4) and:
- [x] S5 Create `index.ts`:
- [x] S6 Create `README.md` (sections: what it does, commands, config keys and defaults, the links and copies, Windows Terminal d
- [x] S7 Manual check, then clean up:
- [x] S8 In `git-ops.ts` add:
- [x] S9 In `index.ts`, implement `list` as described in §4. The Unity status comes from one `pi.exec("unity", ["status", "--form
- [x] S10 Implement `remove` exactly as §4 `/wt remove` steps 1–6, using `files.unlinkLink` only on paths where `isLink` is true. 
- [ ] S11 Create `unity-guard.ts`:
- [ ] S12 In `index.ts`:
