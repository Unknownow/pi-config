<!-- pi-workflow plan v1 flow=20261016-0048-wt-done-remove-this-session-s-worktree-s-7b90 -->
## Plan: `/wt done`: remove this session's worktree set, report, close pi

### 1. Goal and non-goals

**Goal:** In a pi session running inside a worktree set, `/wt done` removes the whole set: every repo worktree, its `wt/NAME` branch, its links (never their targets) and the set folder. It shows a report, then closes the pi session. It must use the same safety rules as `/wt remove` and must work on Windows, where the worktree folder pi was started in is locked by pi's parent processes.

**Non-goals:**
- No `--force` removal and no `git branch -D`.
- No change to how `/wt new`, `/wt list` or `/wt remove` behave.
- No change to the sync extension.
- No end-to-end run in a real Windows Terminal session; the user may do that afterwards with a disposable set.
- Don't touch the user's existing set `D:/projects/wt/sdks-migration`.

### 2. User decisions

- **D1.** First restore the worktree-session code that `c578b33` reverted (`detectSession`, `sessionConfig`, `mainParent`, `worktreePrompt`, the Unity guard wiring, the README section) exactly as in `76a42c0`, Unity guard included.
- **D2.** The command is `/wt done`, with no argument. It acts on the set the current session runs in.
- **D3.** Same safety checks as `/wt remove`: fetch, then refuse on uncommitted changes or unpushed commits. Also refuse when a Unity Editor is open inside the set. If `unity status` fails, show a warning in the confirm dialog and go on.
- **D4.** On any refusal or cancel, show the reason and keep the session open. Don't close.
- **D5.** Ask for confirmation (repo list, and which `Library/` folders get deleted) before removing anything.
- **D6.** pi `chdir`s out of the set before removing. The session's working repo is removed **last**.
- **D7.** If `git worktree remove` fails only because a folder is in use (worktree unregistered, only empty folders left), count it as removed and still delete the branch. A detached cleanup process deletes the leftover folders after pi exits, using non-recursive `rmdir` only, every 1 s for up to 120 tries.
- **D8.** Any other removal failure: stop, report, start the cleanup for leftovers already recorded, do **not** close the session.
- **D9.** Report: notify it, then show a final confirm dialog "… Close this pi session?". Yes → `ctx.shutdown()`. No → the session stays open.
- **D10.** Edit the repo copy under `D:/projects/pi-config/pi/agent/extensions/worktree/`; the sync imports it into `~/.pi/agent` at the next session start.
- **D11.** Delivery is in two stages: the restore, then the feature.

### 3. Facts the executor needs

Paths are relative to `pi/agent/extensions/worktree/`.

- **The revert.** `git diff 76a42c0 c578b33 --stat` touches only `README.md`, `index.ts` and `manage.ts`: the exact inverse of `76a42c0`. No later commit touches this folder (`git log -- pi/agent/extensions/worktree`). `manage.test.ts:96-141` still tests the removed functions, and `unity-guard.ts` / `unity-guard.test.ts` exist but aren't wired up.
- **Line anchors below refer to the files after Stage 1** (= `git show 76a42c0:<path>`):
  - `manage.ts:12`: `inside(p, dir)`, case-folded on win32.
  - `manage.ts:25`: `reposOf(cfg, name)`, returns sorted subfolders that contain `.git`.
  - `manage.ts:57-65`: `RemoveEnv`.
  - `manage.ts:67-82`: `removeSet` (checks → confirm → `removeAll`).
  - `manage.ts:84-106`: `removeAll`. It unlinks links, runs `git worktree remove` (line 96), `git branch -d` only if the worktree was on the branch (line 98), and `rmdir`s the set folder if empty (line 102). Report lines: `Removed set "${name}":` plus `${wt}` or `${wt} (branch X kept: reason)`.
  - `manage.ts:109-113`: `WtSession { setRoot; branch; unityProject }`.
  - `manage.ts:123`: `detectSession(git, cfg, cwd)` returns null outside a set.
  - `manage.ts:163`: `sessionConfig(git, agentDir, cwd)`, so the root resolves the same way inside a worktree.
  - `index.ts:19`: `SUBCOMMANDS`.
  - `index.ts:182-192`: `listCmd`, which has the `unity status --format json` call to factor out.
  - `index.ts:194-206`: `removeCmd`, the env construction to model `doneCmd` on.
  - `index.ts:232-256`: `registerCommand("wt")`, with the description at 233, completions at 234-243, and handler and usage at 244-250.
- `git-ops.ts:200` `removeChecks(git, wts)` returns `{problems, warnings}`. `git-ops.ts:217` `mainRepoOf(git, wt)`. `git-ops.ts:177` `repoStatus`.
- `files.ts:7` `isLink`, `files.ts:27` `unlinkLink` (throws when the path isn't a link).
- `layout.ts`: `checkName`, `branchOf`, `setRootOf`, `baseName`.
- **pi API** (`…/pi-coding-agent/dist/core/extensions/types.d.ts`): `ctx.shutdown(): void` (line 245), `ctx.waitForIdle(): Promise<void>` (line 290, command context), `ctx.ui.confirm(title, message): Promise<boolean>`, `ctx.ui.notify(msg, type)`, `ctx.hasUI`.
- **Launch chain on Windows:** `wt.exe → cmd.exe (~/.pi/agent/bin/pi.cmd) → node pi-launcher.js` (which calls `spawnSync(process.execPath, …)` at line 28) `→ node pi`. Both parent processes keep the start folder (`ctx.cwd`, which may be a subfolder of the working repo's worktree) as their current directory until pi exits.
- **Git behaviour when the folder is locked.** `builtin/worktree.c remove_worktree` deletes the work-tree contents. If the final `rmdir` fails it still deletes `.git/worktrees/<id>` (the worktree is then unregistered) and exits non-zero with `error: failed to delete '<path>'`.
- **Tests:** `manage.test.ts:13-38` has the `git` runner, `run`, and `fixture()`: a bare origin, `repo`, worktree `<d>/wt/s1/repo` on `wt/s1`, a linked `.pi/git`, and an `env` with `confirm: async () => true`. `manage.test.ts:56-64` is the removal test to model on.
- **Test command (from the restored README):** `node --experimental-strip-types --test config.test.ts layout.test.ts files.test.ts git-ops.test.ts manage.test.ts unity-guard.test.ts`.

### 4. Design

**Components**
- **`manage.ts`** (pure logic plus git/fs, testable): `finishSet`, an extended `removeAll`, and `SWEEP_SCRIPT`.
- **`index.ts`** (pi glue): `doneCmd`, a `unityEditors(pi)` helper, and starting the sweeper.

**Interfaces** (exact contracts)

```ts
export interface DoneEnv extends RemoveEnv {
	session: WtSession | null;
	editors: string[] | null;          // open Editor projects; null = unknown
	leave: (to: string) => void;       // index.ts: process.chdir(to)
}
export interface DoneResult { text: string; error: boolean; removed: boolean; leftovers: string[] }
export async function finishSet(env: DoneEnv): Promise<DoneResult>
export const SWEEP_SCRIPT: string;     // run as: node -e SWEEP_SCRIPT <tries> <intervalMs> <dir>...
```

`removeAll` becomes `removeAll(env, name, set, wts)` returning `{ text; error; leftovers: string[] }`. `wts` is processed in the order given. `removeSet` passes `reposOf` order and ignores `leftovers`.

**`finishSet` order** (each refusal returns `error: true, removed: false, leftovers: []`, and `leave` is not called):
1. If `session` is null, refuse with text containing `/wt done runs inside a worktree session` and `/wt remove NAME`.
2. Set `set = session.setRoot` and `name = baseName(set)`. Refuse if `checkName(name)` fails or the set folder is missing.
3. Refuse with `/wt done needs a UI to confirm.` if `!hasUI`.
4. `wts = reposOf(cfg, name)`. If empty, refuse with `No worktrees in <set>`.
5. If `editors` is non-null and one of them is `inside` the set, refuse with `Nothing removed:\nUnity Editor open for <project>; close it first`.
6. Run `removeChecks`; if there are problems, refuse with `Nothing removed:\n…` (the same format as `removeSet`).
7. Confirm with title `Finish worktree set "<name>"?`. The message has the check warnings, then `Unity Editor state unknown (unity status failed)` when `editors` is null, then the same per-repo lines as `removeSet` (the `Library/` note). On cancel return `{ text: "Cancelled.", error: false, removed: false, leftovers: [] }`.
8. Reorder `wts`: worktrees with `inside(env.cwd, wt)` go last; the others keep their order.
9. Call `env.leave(main)`, where `main = mainRepoOf(git, <last wt>)` or, if null, `path.posix.dirname(cfg.root)`.
10. Run `removeAll`. Return `removed = !error`.

**`removeAll` change.** When `git worktree remove` exits non-zero, run `git worktree list --porcelain` in `main`.
- If no line `worktree <path>` matches the worktree (compare with `norm`) **and** the folder is missing or contains only directories (recursively, no files or links), then:
  - push `wt` to `leftovers`;
  - continue with branch deletion;
  - report the line as `${wt} (folder in use: deleted after pi exits)`, followed by the branch-kept note if the branch was kept.
- Otherwise stop, as today: `Stopped at …\nRemoved: …`, `error: true`, with the `leftovers` collected so far.

At the end:
- if the set folder is empty, `rmdir` it (as today);
- otherwise, if `leftovers` is non-empty, append the set folder to `leftovers` and add the report line `<set> (deleted after pi exits)`.

**`SWEEP_SCRIPT`** is plain JS with no imports beyond `require("fs")` and `require("path")`. It takes `argv = process.argv.slice(1)` as `[tries, intervalMs, ...dirs]`. Each try removes, for every dir in order, empty directories bottom-up with non-recursive `fs.rmdirSync`, and ignores errors. It never deletes files or follows links: `lstat`, and skip anything that isn't a real directory. It stops when no dir exists any more or after `tries` tries, sleeping `intervalMs` between tries. A folder that contains a file is left alone.

**`doneCmd(pi, ctx)` in `index.ts`:**
1. `await ctx.waitForIdle()`.
2. `sessionConfig` (notify its warning), then a fresh `detectSession(git, cfg, ctx.cwd)`, then `editors = await unityEditors(pi)`.
3. Build the env as in `removeCmd`, plus `session`, `editors`, and `leave: (to) => process.chdir(to)`. Call `finishSet`.
4. If `leftovers.length`, spawn `process.execPath ["-e", SWEEP_SCRIPT, "120", "1000", ...leftovers]` with `{ detached: true, stdio: "ignore", cwd: cfg.root, windowsHide: true }`, then `unref()`. Its cwd must be outside the set. A spawn error is appended to the report as a warning.
5. If `!r.removed`: notify `r.text` (`"error"` if `r.error`, else `"info"`) and return.
6. Otherwise notify `r.text` as `"info"`, then `confirm(\`Worktree set "<name>" removed\`, r.text + "\n\nClose this pi session?")`. Yes → `ctx.shutdown()`. No → notify `The set is removed; exit pi when you are done.`

**Failure handling:** covered by D4, D7, D8. An exception in `doneCmd` is caught by the existing handler try/catch (`/wt done failed: …`).

**Scale:** one set with roughly 1-10 repos and serial git calls (seconds). The sweeper runs at most 120 s. If pi's parent processes outlive that, for example a second pi window inside the set, the empty folders stay and the user deletes them by hand. The README states this.

**Rejected alternatives:**
- Doing the whole removal in a detached process after pi exits: no report could be shown before the window closes.
- `--force` removal: violates the safety rules.
- Closing right after notify: the report would disappear with the window (D9).

### 5. Steps

### Stage 1: Restore the worktree-session code reverted by c578b33

**S1.** Run `git checkout 76a42c0 -- pi/agent/extensions/worktree/index.ts pi/agent/extensions/worktree/manage.ts pi/agent/extensions/worktree/README.md`. Make no other edits. Behaviour after this step: worktree sessions get the prompt section and the Unity guard again, and `configFor`/`newSet` use `sessionConfig`.

**S2.** Run the test command from §3 (from the worktree folder). All tests must pass, including `manage.test.ts:96-141`.

### Stage 2: `/wt done`

**S3.** In `manage.ts:84` (`removeAll`): add the ordered-`wts` contract, the "unregistered + only empty folders" handling, `leftovers`, and the set-folder leftover, all as in §4. Add a small non-exported helper `onlyEmptyDirs(p)` (true when `p` is missing or contains only real directories, recursively; it uses `lstat` and treats links and files as content) and a helper that checks registration via `git worktree list --porcelain`. Update `removeSet` (`manage.ts:67`) to destructure the new return. Its text and error behaviour stay unchanged for the normal path.

**S4.** In `manage.ts`, after `removeAll`, add `DoneEnv`, `DoneResult` and `finishSet` exactly as in §4. Reuse `removeChecks`, `reposOf`, `inside`, `checkName`, `baseName`, `mainRepoOf`, and the per-repo `Library/` line logic from `removeSet` (lines 75-79). Factor that logic into a shared helper rather than duplicating it.

**S5.** In `manage.ts`, add `export const SWEEP_SCRIPT` as in §4. It's one template string of plain CommonJS. Keep it short, and add a doc comment saying it only `rmdir`s empty folders.

**S6.** In `index.ts`:
- Add `"done"` to `SUBCOMMANDS` (line 19).
- Factor `unityEditors(pi): Promise<string[] | null>` out of `listCmd` (lines 184-190), and use it in both `listCmd` and `doneCmd`.
- Add `doneCmd` as in §4, modelled on `removeCmd` (lines 194-206). Use `spawn` (already imported) for the sweeper.
- In the handler (line 244), add `if (sub === "done") return await doneCmd(pi, ctx);`.
- Description: `"Parallel pi sessions on git worktrees: new NAME, list, remove NAME, done"`.
- Usage: `"Usage: /wt new NAME | /wt list | /wt remove NAME | /wt done"`.
- Update the file doc comment (lines 1-5) to mention `/wt done`.

**S7.** In `README.md`:
- Add a `/wt done` row to the Commands table. It runs inside a worktree session; covers the checks (incl. an open Unity Editor), the confirm dialog, working repo removed last, no `--force`, `branch -d`, the report, and the final "Close this pi session?" dialog; on refusal or failure the session stays open.
- Add a short paragraph under Limits: on Windows the folder pi was started in stays locked by its parent processes until pi exits; a detached cleanup deletes the empty leftovers (only empty folders) for up to 2 minutes; if it can't, delete them by hand.
- The test command stays as restored in S1.

**S8.** Add the tests from §6 to `manage.test.ts`, then run the test command.

### 6. Tests

All new tests go in `manage.test.ts` and use `fixture()` (lines 20-38). For `DoneEnv`, use `{ ...f.env, cwd: f.wt, session: await detectSession(git, f.cfg, f.wt), editors: [], leave: (to) => { left = to } }`.

1. **`finishSet removes the set it runs in, keeps link targets, chdir target is the main repo`**
   - Expect `error` false, `removed` true, `leftovers` `[]`.
   - `f.wt` and `${f.cfg.root}/s1` are gone, and `keep.txt` is intact.
   - `wt/s1` no longer appears in `git branch --list`.
   - `left` equals the main repo path (compare with `/` and case-insensitively on win32).
2. **`finishSet refuses outside a worktree session, without UI, with an open Editor, and with dirty or unpushed work`**
   - `session: null` → error, text matches `/\/wt remove/`.
   - `hasUI: false` → error.
   - `editors: [\`${f.wt}/unity\`]` → error, matches `/Unity Editor open/`.
   - A file written into `f.wt` → error, matches `/Nothing removed/`.
   - A commit in `f.wt` → error, matches `/not pushed/`.
   - In every case: `f.wt` still exists, `left` is still undefined, and `removed` is false.
3. **`finishSet: cancel keeps everything`**
   - `confirm: async () => false` → `error` false, `removed` false, text `Cancelled.`, `f.wt` exists, `left` undefined.
4. **`finishSet removes the working repo last`**
   - Add a second repo `zzz` (with origin, same steps as the fixture) and its worktree `${root}/s1/zzz` on `wt/s1`. The session cwd is `f.wt` (`repo`).
   - Wrap `git` to record the order of `worktree remove` calls.
   - Expected order: the `zzz` path first, then the `repo` path.
5. **`finishSet treats an in-use folder as removed and leaves it to the sweeper`**
   - Wrap `git`: for `worktree remove`, run the real command, then `fs.mkdirSync(\`${wt}/sub\`, { recursive: true })` and return `{ code: 1, stderr: "error: failed to delete" }`.
   - Expect `removed` true, `error` false, `leftovers` = `[f.wt, \`${f.cfg.root}/s1\`]`, text matches `/deleted after pi exits/`, and the branch is deleted.
   - Then `spawnSync(process.execPath, ["-e", SWEEP_SCRIPT, "1", "0", ...leftovers])` → both paths are gone.
6. **`finishSet stops when the worktree stays registered`**
   - Wrap `git` so that `worktree remove` returns code 1 without running.
   - Expect `error` true, `removed` false, text matches `/Stopped at/`; `f.wt` exists and the branch exists.
7. **`SWEEP_SCRIPT deletes only empty folders`**
   - Temp dir with `a/b/c` (empty) and `x/y/file.txt`. Run it with `1 0 <a> <x>`.
   - `a` is gone; `x/y/file.txt` exists.

**Existing tests:** all must still pass unchanged, in particular `removeSet …` (lines 56-94) and the restored session tests (96-141).

**Command** (from `pi/agent/extensions/worktree`):
`node --experimental-strip-types --test config.test.ts layout.test.ts files.test.ts git-ops.test.ts manage.test.ts unity-guard.test.ts`

Expected: `# fail 0`, and `# pass` equal to the total number of tests.

### 7. Done when

- `index.ts`, `manage.ts` and `README.md` contain everything from `76a42c0` again (Stage 1 diff = inverse of `c578b33`).
- `/wt done` exists, completes, and behaves as in D2-D9.
- `/wt remove` is unchanged for users: same refusals, same text on success.
- All tests in §6 pass with `# fail 0`.
- The README documents `/wt done` and the locked-folder cleanup.
- Only files under `pi/agent/extensions/worktree/` change.

### 8. Risks, rollback, what not to touch

**Risks:**
- The CuongPT-dev machine's sync may revert Stage 1 again; tell the user.
- The detached sweeper might not survive the terminal closing on some setups; worst case, empty folders stay behind (documented).
- `process.chdir` happens only after confirmation, so refusals never move pi.

**Rollback:** `git revert` the stage commits.

**Don't touch:**
- `git-ops.ts`, `files.ts`, `layout.ts`, `config.ts`, `unity-guard.ts`, the workflow extension, the sync extension (`extension/`, `bin/`, `local/`), and `~/.pi/agent` directly.
- `D:/projects/wt/sdks-migration`.
- Don't run `/wt done` or `git worktree` commands on real repos; tests use temp dirs only.

### 9. Commits

1. Stage 1: `fix(worktree): restore worktree-session detection and Unity guard reverted by sync`: `pi/agent/extensions/worktree/{index.ts,manage.ts,README.md}`.
2. Stage 2: `feat(worktree): /wt done removes this session's set, reports, and closes pi`: `pi/agent/extensions/worktree/{manage.ts,index.ts,README.md,manage.test.ts}`.

## Amendment 1 (arbiter)
**S3 (replaces the in-use part).** In `manage.ts`, change the signature to `removeAll(env: RemoveEnv, name: string, set: string, wts: string[], allowInUse: boolean)`.
- Only when `allowInUse` is true: a failed `git worktree remove` on an unregistered worktree whose folder holds only empty folders counts as removed, the path goes to `leftovers`, and the set folder is appended to `leftovers` at the end.
- When `allowInUse` is false: keep the old early return, `Stopped at ${wt}: …\nRemoved: …` with `error: true`.
- `removeSet` passes `false`, so its output is the same as before this plan in every case.
- `finishSet` passes `true`.
- `isRegistered` must return `true` when `git worktree list --porcelain` exits non-zero. An unknown state must stop the removal, not delete the branch.

**S4 addendum.** `finishSet` step 10 calls `removeAll(..., true)`.

**S6 (changes doneCmd step 4).**
- When `r.removed` is false and `leftovers` is non-empty (the D8 path), start the sweeper straight away, before the notify.
- When `r.removed` is true, start the sweeper only after the final "Close this pi session?" confirm returns, for either answer:
  - Yes: start it right before `ctx.shutdown()`.
  - No: start it, then show the "exit pi when you are done" notify.
- If the sweeper can't be started, show the spawn-error warning in a separate notify.

**S8 addendum (tests in `manage.test.ts`).**
- **`removeSet still stops when a folder is in use`**: use the `flaky` git wrapper from test 5 with `removeSet(f.env, "s1")`. Expect `error` true and text matching `/Stopped at/`. The text must not match `/deleted after pi exits/`.
- **`finishSet stops when worktree list fails`**: use a wrapper where `worktree remove` behaves as in `flaky` and `worktree list` returns `{ code: 1, stdout: "", stderr: "x" }`. Expect `error` true, text matching `/Stopped at/`, and branch `wt/s1` still exists.
- All existing tests and the §6 tests must still pass with `# fail 0`.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 Run `git checkout 76a42c0 -- pi/agent/extensions/worktree/index.ts pi/agent/extensions/worktree/manage.ts pi/agent/exten
- [x] S2 Run the test command from §3 (from the worktree folder). All tests must pass, including `manage.test.ts:96-141`.
- [x] S3 In `manage.ts:84` (`removeAll`): add the ordered-`wts` contract, the "unregistered + only empty folders" handling, `left
- [x] S4 In `manage.ts`, after `removeAll`, add `DoneEnv`, `DoneResult` and `finishSet` exactly as in §4. Reuse `removeChecks`, `
- [x] S5 In `manage.ts`, add `export const SWEEP_SCRIPT` as in §4. It's one template string of plain CommonJS. Keep it short, and
- [x] S6 In `index.ts`:
- [x] S7 In `README.md`:
- [x] S8 Add the tests from §6 to `manage.test.ts`, then run the test command.
## Outcome
2026-10-15T17:56:46.605Z — ok: stage 1: committed (1 commit); stage 2: committed (1 commit)
