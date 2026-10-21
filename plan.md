<!-- pi-workflow plan v1 flow=20261021-1626-worktree-for-folders-added-with-folders-cb2f -->
## Plan: worktree for folders added with `/folders add` inside a worktree set

### 1. Goal and non-goals

**Goal.** When a session runs inside a worktree set and you run `/folders add PATH` for a git repo, the session gets that repo's worktree inside the set, not the original checkout. The worktree is either created (on the set's branch, from the remote's default branch, with gitignored files linked or copied as `/wt new` does) or reused if one already exists. Outside a set, or for non-git folders, `/folders add` behaves exactly as today.

**Non-goals.**
- `--add-dir` at startup is not changed.
- `/folders remove` is not changed.
- An existing set's branch is not reused when it exists without a worktree (that case is refused).
- The workflow gains no knowledge of the worktree extension.
- No prompt asks each time whether to use a worktree.

### 2. User decisions

- D1: A generic workflow hook (new public contract K6, event `workflow:folder-add`) lets other extensions replace or refuse a folder before `/folders add` saves it. The worktree extension answers it. The two extensions stay decoupled, and both `boundary.test.ts` files stay green.
- D2: Inside a set, the worktree is created or reused automatically, with no question. The only opt-out is the `worktree.json` key `addFolderWorktree` (default `true`).
- D3: Delivered in two stages: 1. the workflow hook; 2. the worktree extension's answer.
- D4: A subfolder of a repo maps to the same subfolder in the worktree if it exists there, otherwise to the worktree root.
- D5: If an existing worktree of the same original repo is already under the set root, it is reused.
- D6: If the worktree can't be created (target folder taken, branch already exists, no remote or base, git failure), nothing is added and the error is shown.
- D7: Updating `docs/workflow-improvements.md` is part of this change: new row D13 marked Done, its Effect-measurement row and the Status line.

### 3. Facts the executor needs

- The `/folders` command is at `pi/agent/extensions/workflow/index.ts:3371`.
- The `add` branch is at `index.ts:3421-3446`. It checks, in order: the path is a folder, it isn't the working folder, it isn't already added (`repoKey`). Then it sets `state.folders`, calls `persist()`, `publishFolders(ctx)` and `updateStatus(ctx)`, and notifies `workflow: added ${abs}; reloading`. After `index.ts:3460` it calls `ctx.waitForIdle()` and then `ctx.reload()`.
- Existing workflow event: `pi.events.emit("workflow:status", payload)` at `index.ts:411`.
- The public contract list (K1–K5) is in `workflow/README.md:226-235`. The `/folders` row is at `README.md:318`. The workflow test command is at `README.md:190`.
- `workflow/boundary.test.ts` bans these strings in workflow non-test files: `.pi-set.json`, `agent/live`, `wt-backup`, `worktree.json`, `"wt/`. It also bans imports from `../worktree`.
- `pi.events` is a Node `EventEmitter` wrapper. `emit` is synchronous, and each handler runs synchronously up to its first `await`. Handler errors are only logged. (Source: the pi package's `dist/core/event-bus.js`.)
- `worktree/index.ts:756` is the extension factory.
  - `session_start` is at `:828`. It computes `cfg` via `sessionConfig` and sets `session = await detectSession(...)` and `setBranch = branchOf(cfg, basename(session.setRoot))` at `:839`.
  - `session_shutdown` is at `:870`. It calls `stopLive()`.
  - The listener pattern to copy is `unsubStatus = pi.events.on("workflow:status", ...)` at `:813`, unsubscribed at `:798`.
- `build(git, plan, cfg, name, progress)` is at `worktree/index.ts:172-198` and is not exported. It runs `createAll`, then `setupFiles` and `excludeLinks` per repo, and calls `rollback` on failure. `createSet` uses it at `:219-269` (preflight `:244`, `writeMeta` `:258-263`).
- `preflight(git, dirs, cfg, name)` is at `worktree/git-ops.ts:82`. It fetches and returns an error when the target `${cfg.root}/${name}/${basename(top)}` exists or the branch `branchOf(cfg, name)` exists. `mainRepoOf` is at `git-ops.ts:279`.
- `readMeta` and `writeMeta` are in `worktree/meta.ts`. `SetMeta.repos` is `{ main, dir }[]`.
- Path helpers in `worktree/index.ts:33-34`: `slash` and `fold` (case-folded on win32).
- `Progress(ui | null, title, fit)` is at `worktree/progress.ts:50`, with methods `stage`, `wrap(git)` and `done`. A `null` ui is allowed, which tests use.
- Config:
  - `WtConfig` is at `worktree/config.ts:6`; defaults at `:26-38`.
  - `mergeConfig` validates booleans at `:55-62` (copy the `autoUpdate` pattern).
  - The config table is at `worktree/README.md:57-71`.
  - The section "Relationship to the workflow extension" is at `README.md:145`.
  - The test command is at `README.md:169-174`.
- Git test fixtures with a bare origin and `wt/s1` worktree: `worktree/manage.test.ts:14-40`.
- Backlog file: `docs/workflow-improvements.md`.
  - Status line `:5`. Rules `:7-11`.
  - Section D rows end with D12 at `:86`.
  - Effect-measurement D rows are at `:134-136`.

### 4. Design

**Components**
- **Workflow `folder-add.ts`** (new, pure apart from a timer): emits K6, collects the claims and resolves them to a single result.
- **Workflow `/folders add`**: calls that helper between its existing checks and saving, then checks the resulting path again.
- **Worktree `add-folder.ts`** (new): decides, for one folder and the current set, whether to answer null, reuse a worktree, create one, or return an error. It also takes over `build` from `index.ts`.
- **Worktree `index.ts`**: subscribes and unsubscribes the K6 listener for each session, and shows the progress widget and the result notice.

**Contract K6** (exact):
```ts
pi.events.emit("workflow:folder-add", { v: 1, cwd: string, folder: string, claim: (answer: Promise<FolderAddAnswer>) => void });
type FolderAddAnswer = { folder: string } | { error: string } | null;
```
- `cwd` and `folder` are absolute paths with forward slashes.
- `claim` counts only when called synchronously during `emit`. Calls after `emit` returns are ignored.
- The workflow waits for every claimed promise, for at most 300 000 ms in total.
- Resolution rules:
  - Any `{ error }` (non-empty string), any rejection (message = the rejection's `message`, or `String(reason)`) or the timeout cancels the add. If there are several errors, the first in claim order is shown.
  - Otherwise the first `{ folder }` (non-empty string) in claim order replaces the path.
  - Anything else counts as `null`.
  - No claims, or only nulls, keeps the original path.

**Workflow helper signature:**
```ts
export async function askFolderAdd(emit: (data: unknown) => void, cwd: string, folder: string, timeoutMs = 300_000): Promise<{ folder: string } | { error: string }>
```
- The timer is cleared when the claims settle, so tests don't hang.
- The timeout error text is `no answer from a folder-add listener within <N> s`.

**Worktree module signature:**
```ts
export async function worktreeForFolder(git: Git, o: { cfg: WtConfig; setRoot: string; folder: string }, progress: Progress): Promise<{ folder: string; lines: string[] } | { error: string } | null>
```
- Set name = `basename(setRoot)`. Branch = `branchOf(cfg, name)`, as at `index.ts:839`.

**Data.** `.pi-set.json` gains one more `{ main, dir }` entry, and only if the file exists and has no entry with that `dir`. There's no migration: older sets without meta stay without it. The session folder list (K1) is unchanged in format.

**Failure handling**
- A worktree creation failure is rolled back by `build` (links, `worktree remove --force`, `branch -D`, only for what this run made). The answer is then `{ error }`, so the workflow adds nothing.
- An unexpected exception inside the listener's promise also becomes `{ error }`.
- A hung listener hits the 300 s timeout and the add is cancelled. Adding the same folder again later then reuses the worktree if it was created in the meantime (D5).

**Scale.** One folder per command, 1 repo, one fetch (seconds), no concurrency. Creating worktrees for the same set from two sessions at once isn't guarded: a set has one live session in normal use.

**Alternatives rejected**
- The worktree extension acting after the reload: it needs a second "replace" message and a second reload, and the session points at the original repo in between.
- The workflow calling the worktree extension directly: breaks the one-way contract (D11 boundary).
- A prompt on every add: rejected in D2.

### 5. Steps

### Stage 1: Workflow K6 hook in `/folders add`

**S1.** Create `pi/agent/extensions/workflow/folder-add.ts` with `askFolderAdd` exactly as in Design.
- Export the `FolderAddAnswer` type.
- Build the payload `{ v: 1, cwd, folder, claim }`. `claim` pushes onto a local list only while a `collecting` flag is true, and the flag is set to false right after `emit` returns.
- Wrap each claim with `Promise.resolve(p).then(...)` so a non-promise or a rejection is handled. Race all the claims together against a timeout. Clear the timer afterwards.
- Apply the resolution rules from Design. The returned `folder` is the answer string unchanged; normalisation happens in S2.
- Add a short file header comment like the one in `repos.ts:1-4`.
- The file must not contain any string banned by `workflow/boundary.test.ts`.

**S2.** `workflow/index.ts`, `/folders add` branch (`:3421-3446`):
- After the three existing checks pass, call `askFolderAdd((d) => pi.events.emit("workflow:folder-add", d), slashed ctx.cwd, abs)`.
- On `{ error }`: notify `workflow: ${abs} not added: ${error}` with level `"error"`, then return (no persist, no reload).
- On `{ folder }` that differs from `abs` (compare with `repoKey`): resolve it against `ctx.cwd`, convert to forward slashes, and run the same three checks on it with the same messages. A failure notifies and returns without adding.
- Then save the final path as today. When it was replaced, the notice is `workflow: added ${final} (for ${abs}); reloading`; otherwise it stays as today.

**S3.** `workflow/folder-add.test.ts`: the tests listed in section 6. Add `folder-add.test.ts` to the test command at `workflow/README.md:190`.

**S4.** `workflow/README.md`:
- Add the K6 bullet after K5 (`:235`), with the event name, payload, claim rules, the 300 s timeout and "no listener means the path is used as given".
- In the `/folders` row (`:318`), add that other extensions may replace or refuse the folder (K6).

**S5.** `docs/workflow-improvements.md`:
- New row **D13** in section D after D12. Finding: "`/folders add` inside a worktree set attached the original checkout, so edits went outside the set." **Done:** K6 hook `workflow:folder-add` (`folder-add.ts`, `/folders add` in `index.ts`); the worktree extension answers it. Benefit Medium (T), Effort M, Risk Low ("no listener: unchanged"), Check first "None".
- Effect-measurement row `| D13 | n/a | Added folders inside a set are worktrees | n/a |`.
- Add D13 to the implemented list in the Status line (`:5`).

### Stage 2: Worktree extension answers K6

**S6.** `worktree/config.ts`:
- Add `addFolderWorktree: boolean` to `WtConfig`, default `true` in `defaults`.
- Validate it in `mergeConfig` exactly like `autoUpdate` (`:55-58`), with the warning `addFolderWorktree must be true or false`.

**S7.** Create `worktree/add-folder.ts`.
- Move `build` (and the `Planned` usage it needs) from `index.ts:172-198` into it and export it. `index.ts` `createSet` imports it from there, with behaviour unchanged.
- Implement `worktreeForFolder`:
  1. Get `top` with `git rev-parse --show-toplevel` in `folder`. If that fails, return `null` (plain folder).
  2. If `fold(top)` equals `fold(setRoot)` or starts with `fold(setRoot) + "/"`, return `null` (already in the set). Use the `slash`/`fold` style from `index.ts:33-34`, defined locally.
  3. `main = (await mainRepoOf(git, top)) ?? top`. Compute `rel` = `folder` relative to `top`, with forward slashes; it is empty for the root.
  4. Run `git worktree list --porcelain` in `main` and parse the `worktree ` lines, as in `clean.ts:75` or `manage.ts:135`. If one path is under `setRoot/`, return `{ folder: within(thatPath, rel), lines: ["reusing worktree " + thatPath] }`.
  5. Otherwise call `progress.stage("checking repo (fetching)")` and `preflight(git, [main], cfg, name)`. If there are errors, return `{ error: "Nothing created:\n" + errors.join("\n") }`. Warnings go into `lines`.
  6. Call `build(git, pre.plan, cfg, name, progress)` and add its lines. On a thrown error, return `{ error: message }`.
  7. Update `.pi-set.json` with `readMeta`/`writeMeta` as described in Design.
  8. Return `{ folder: within(target, rel), lines }`.
- `within(root, rel)` is `${root}/${rel}` when `rel` is non-empty, does not start with `..` and exists on disk; otherwise it is `root`.

**S8.** `worktree/index.ts` factory (`:756`):
- Add a variable `unsubFolderAdd` and a variable holding the last `WtConfig` from `session_start`.
- In `session_start`, after `session` is set and also when `ctx.hasUI` is false: drop any old subscription, then subscribe `pi.events.on("workflow:folder-add", handler)`. The handler:
  - ignores payloads with `v !== 1`, a non-string `folder` or a non-function `claim`;
  - returns without claiming when there is no `session`, no config, or `addFolderWorktree` is false;
  - otherwise calls `claim(...)` synchronously, before any `await`, with an async function that:
    - creates `new Progress(ctx.hasUI ? ctx.ui : null, \`worktree add (${basename(setRoot)})\`, truncateToWidth)`;
    - runs `worktreeForFolder(progress.wrap(makeGit(pi)), { cfg, setRoot: session.setRoot, folder }, progress)`;
    - always calls `progress.done()` in `finally`;
    - on success with a folder, notifies `Worktree set "<name>": <folder>` plus the lines (`"info"`) and returns `{ folder }`;
    - passes `null` and `{ error }` through;
    - turns a caught exception into `{ error: message }`.
- In `session_shutdown`, unsubscribe it (for every reason) and set it to `undefined`.

**S9.** `worktree/README.md`:
- In "Commands" or a new short section "Adding folders inside a set", describe the behaviour: create or reuse, subfolder rule, refusal cases, the progress widget, `.pi-set.json` update, opt-out key.
- Add the config row `addFolderWorktree` (`true`): "`/folders add` inside a set attaches the repo's worktree in the set (created on the set's branch if missing). `false` attaches the folder as given."
- In "Relationship to the workflow extension", add that it listens to `workflow:folder-add` (K6).
- Add `add-folder.test.ts` to the test command.
- Add a Limits line: "If `wt/<name>` already exists in a newly added repo without a worktree, `/folders add` refuses; remove or rename that branch first."

**S10.** `worktree/add-folder.test.ts` and `worktree/config.test.ts`: the tests listed in section 6.

### 6. Tests

**Workflow** (`folder-add.test.ts`). The `emit` stub calls a list of fake listeners.

| Test | Input | Expected result |
|---|---|---|
| "no listener keeps the folder" | emit does nothing | `{ folder: original }` |
| "null answers keep the folder" | one claim resolves `null` | original folder |
| "a replacement is used" | resolves `{ folder: "D:/wt/w1/x" }` | that folder |
| "the first replacement wins" | two replacements | the first in claim order |
| "an error wins over a replacement" | one `{ error: "boom" }`, one replacement | `{ error: "boom" }` |
| "a rejected claim is an error" | rejects with `new Error("bad")` | `{ error: "bad" }` |
| "a claim that never settles times out" | `timeoutMs: 20` | error text contains `within` |
| "late claims are ignored" | listener stores `claim` and calls it after emit | original folder |
| "invalid answers count as null" | resolves `{ folder: "" }` or `42` | original folder |

**Worktree** (`add-folder.test.ts`). Fixture modelled on `manage.test.ts:14-40`: a temp dir with two repos (`repo`, `other`), each with a bare origin and `origin/HEAD` set; set `s1` with `repo`'s worktree and a `.pi-set.json` from `writeMeta`; `other` has a linked `.pi/git` folder and a subfolder `sub`. The `Progress` gets a `null` ui.

| Test | Input | Expected result |
|---|---|---|
| "a plain folder is left alone" | non-git dir | `null` |
| "a folder inside the set is left alone" | `<root>/s1/repo` | `null` |
| "a new repo gets a worktree on the set branch" | `other` | returns `<root>/s1/other`. The worktree exists with branch `wt/s1` at `origin/main`, `.pi/git` is a link, and `.pi-set.json` lists `{ main: other, dir: "other" }` |
| "a subfolder maps to the worktree subfolder" | `other/sub` (committed) | returns `<root>/s1/other/sub` |
| "an existing worktree in the set is reused" | `other` after it was created once | same path; `git worktree list` count unchanged |
| "a taken target folder is refused" | plain dir `<root>/s1/other` exists first | `{ error }` containing `already exists`; no `wt/s1` branch in `other` |
| "an existing set branch is refused and nothing is left" | `wt/s1` created in `other` without a worktree | `{ error }` containing `already exists`; no worktree added |

**Config** (`config.test.ts`): `addFolderWorktree` defaults to `true`, `false` is accepted, and `"no"` gives the warning `addFolderWorktree must be true or false`.

**Commands**
- In `pi/agent/extensions/workflow`: the README test command (S3), now including `folder-add.test.ts`. Expected: all tests pass, `fail 0`.
- In `pi/agent/extensions/worktree`: the README test command (S9), now including `add-folder.test.ts`. Expected: `fail 0`.
- `boundary.test.ts` passes in both extensions.

### 7. Done when

- Inside a worktree set, `/folders add <original repo or subfolder>` attaches the matching path inside the set's worktree of that repo. It creates the worktree on the set's branch (from the remote's default branch, with links and copies) or reuses an existing one, and records it in `.pi-set.json`.
- Outside a set, for non-git folders, for folders already in the set, or with `addFolderWorktree: false`, `/folders add` behaves exactly as before.
- When creation fails, nothing is added, nothing is left behind, and the error is shown.
- K6 is documented in the workflow README, and the worktree README describes the behaviour and the config key.
- The workflow never refers to the worktree extension: both boundary tests pass.
- `docs/workflow-improvements.md` has D13 Done, its measurement row, and the updated Status line.
- All tests of both extensions pass.

### 8. Risks, rollback, what not to touch

**Risks**
- `claim` called after an `await` in the listener would be ignored. S8 must call it synchronously, and the late-claim test covers the workflow side.
- Moving `build` must not change `/wt new` behaviour; the existing tests for `createSet` paths have to stay green.
- Listener leaks across reloads: the handler is unsubscribed on every `session_shutdown`.

**Rollback.** Revert the stage-2 commit, and `/folders add` behaves as before (no listener). Stage 1 alone changes nothing visible.

**Do not touch**
- `followFolders`/K1b, `applyAddDir`, `/folders remove`.
- `preflight`/`createAll`/`rollback` semantics.
- The `workflow:status` listener.
- The banned-string lists in the boundary tests.

### 9. Commits

1. `workflow: K6 folder-add hook lets extensions replace or refuse /folders add` — `workflow/folder-add.ts`, `workflow/folder-add.test.ts`, `workflow/index.ts`, `workflow/README.md`, `docs/workflow-improvements.md` (stage 1).
2. `worktree: /folders add inside a set attaches the repo's worktree` — `worktree/add-folder.ts`, `worktree/add-folder.test.ts`, `worktree/index.ts`, `worktree/config.ts`, `worktree/config.test.ts`, `worktree/README.md` (stage 2).

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 Create `pi/agent/extensions/workflow/folder-add.ts` with `askFolderAdd` exactly as in Design.
- [ ] S2 `workflow/index.ts`, `/folders add` branch (`:3421-3446`):
- [ ] S3 `workflow/folder-add.test.ts`: the tests listed in section 6. Add `folder-add.test.ts` to the test command at `workflow/
- [ ] S4 `workflow/README.md`:
- [ ] S5 `docs/workflow-improvements.md`:
- [ ] S6 `worktree/config.ts`:
- [ ] S7 Create `worktree/add-folder.ts`.
- [ ] S8 `worktree/index.ts` factory (`:756`):
- [ ] S9 `worktree/README.md`:
- [ ] S10 `worktree/add-folder.test.ts` and `worktree/config.test.ts`: the tests listed in section 6.
