<!-- pi-workflow plan v1 flow=20261019-1134-live-progress-widget-for-wt-commands-and-832f -->
## Plan: Live progress widget for `/wt` commands and the worktree auto-update

### 1. Goal and non-goals
**Goal**
- While any `/wt` sub-command (`new`, `open`, `list`, `update`, `remove`, `done`) or the session-start auto-update runs in an interactive pi, show a widget above the editor:
  - line 1: an animated spinner, the command title, the current stage and the total elapsed time
  - line 2: the git (or `unity status`) call running right now, with its folder name and how long it has run.
- The widget is hidden while a confirm or select dialog is open, and removed when the command ends (success, refusal or exception).

**Non-goals**
- No change to what the commands do, their checks, or their final `notify` texts.
- No edits to `git-ops.ts`, `manage.ts`, `update.ts`, `files.ts`, `layout.ts`, `config.ts`.
- No percentages, no parsing of git's own progress output, no cancel button.
- No widget when `ctx.hasUI` is false. Calls pass through unchanged.
- No changes to the workflow extension or `docs/workflow-improvements.md`.

### 2. User decisions
- D1: Add a progress visualization to the worktree (`/wt`) commands, so the user can see what a long-running command is doing instead of a UI that looks stuck.
- D2: The approved approach is a spinner widget above the editor showing the stage, the running git command with its folder and the elapsed time. It works by wrapping the injected `Git` runner, without changing the helper modules.

### 3. Facts the executor needs
All paths are under `pi/agent/extensions/worktree/`.

**`index.ts`**
- Imports at `index.ts:8-19`. There is no import of `@earendil-works/pi-tui` yet.
- `makeGit(pi, timeout = 60000): Git` is at `index.ts:26-31`.
- Command functions and where they call git:
  - `newSet` (`:155`) creates `git = makeGit(pi)` at `:158`, calls `collect`, `sessionConfig`, `preflight`, then `build(git, pre.plan, cfg, name)`, then `launch(...)` at `:181`.
  - `build` (`:134-153`) calls `createAll` at `:138`, then `setupFiles` per repo at `:140`. `setupFiles` is synchronous (`fs.cpSync`).
  - `configFor` (`:187-192`) uses its own `makeGit(pi)`.
  - `unityEditors(pi)` (`:201-208`) runs `pi.exec("unity", ["status","--format","json"])`.
  - `listCmd` (`:210-213`) calls `listText(makeGit(pi), cfg, await unityEditors(pi))`.
- Dialogs:
  - `pickSet` (`:215-226`) uses `ctx.ui.select` at `:225`.
  - `removeCmd` (`:228-245`) builds `env` with `git: makeGit(pi)` (`:236`) and `confirm: (t, m) => ctx.ui.confirm(t, m)` (`:241`).
  - `openCmd` (`:247-272`) has `git = makeGit(pi)` at `:254`, `ctx.ui.select` at `:261` and `launch` at `:269`.
- `updateCmd` (`:274-290`) has `git = makeGit(pi)` at `:276` and calls `updateSet(git, wts, true)`.
- `doneCmd` (`:292-331`):
  - `git = makeGit(pi)` at `:295`, env `confirm` at `:302`, `editors: await unityEditors(pi)` at `:304`
  - the final `ctx.ui.confirm("Worktree set … removed", …)` at `:325`, followed by `ctx.shutdown()`.
- `session_start` handler (`:337-…`):
  - `short = makeGit(pi, 15000)` at `:355`, `fetchGit` built from `short`
  - `updateSet(makeGit(pi), repoDirsIn(session.setRoot), false, fetchGit)` at `:357`, inside a `try`.
- The command `handler: async (args, ctx)` is at `:392`. It splits `sub` and `rest` and dispatches inside a `try/catch` that notifies `/wt <sub> failed: …`.

**Helper modules (unchanged)**
- `Git` type: `(cwd: string, args: string[]) => Promise<GitResult>` (`git-ops.ts:14`).
- Long git calls inside them:
  - `git fetch` in `repoInfo` (`git-ops.ts:40`) and in `removeChecks` (`git-ops.ts:196`)
  - `git worktree add` (`git-ops.ts:90`)
  - `git worktree remove` (`manage.ts:145`)
  - fetch and merge in `updateRepo` (`update.ts:29,43`)
- `removeSet` and `finishSet` call `env.confirm` (`manage.ts:106,205`).

**pi API**
- `ctx.ui.setWidget(key, content: string[] | undefined | ((tui, theme) => Component & {dispose?()}), options?)` (`types.d.ts:101-104`). `WidgetPlacement = "aboveEditor" | "belowEditor"` (`types.d.ts:47`).
- `setWorkingMessage` only shows during streaming (`types.d.ts:85`), so it can't be used here.
- Model for the widget: `workflow/view.ts:254-275`:
  - factory `(tui, theme) => ({ render: (w) => lines.map(l => truncateToWidth(l, w)), invalidate, dispose })`
  - ticker `setInterval(() => tui.requestRender(), 100)` started while running and stopped in `dispose`
  - spinner coloring `theme.fg("accent", …)` and `theme.fg("dim", …)` (`view.ts:170-180`).

**Tests**
- Run with `node --experimental-strip-types --test …` (`README.md:110-114`).
- There is no `node_modules`, so a test-loaded module must not import `@earendil-works/*` at runtime (`import type` only).

### 4. Design
**Components**
- New `progress.ts`. It owns the widget state, rendering, the ticker, the git wrapper, pausing and cleanup. Its only runtime import is `node:path`.
- `index.ts` creates one `Progress` per command run (and one for the auto-update), passes it to the sub-command functions, sets stages, and wraps the git runners and dialogs.

**Interfaces (exact)**
```ts
export const WIDGET_KEY = "worktree-progress";
export interface ProgressUI { setWidget(key: string, content: any, options?: any): void }
export interface Running { text: string; cwd: string; at: number }
export function formatElapsed(ms: number): string;
export function progressLines(s: { title: string; stage: string; startedAt: number; running?: Running }, now: number, frame: string): string[];
export class Progress {
  constructor(ui: ProgressUI | null, title: string, fit: (line: string, width: number) => string, now?: () => number);
  stage(text: string): void;
  wrap(git: Git): Git;
  track<T>(text: string, cwd: string, p: Promise<T>): Promise<T>;
  pause<T>(f: () => Promise<T>): Promise<T>;
  done(): void;
}
```
- **`formatElapsed`**:
  - under 60 s: whole seconds, `"0s"`, `"12s"` (floor)
  - otherwise `` `${m}m ${ss}s` `` with ss zero-padded to 2 digits, e.g. 65000 → `"1m 05s"`.
- **`progressLines`**:
  - line 1 is exactly `` `${frame} ${title} · ${stage} · ${formatElapsed(now - startedAt)}` ``
  - when `running` is set, line 2 is `` `  ${running.text} · ${path.basename(running.cwd)} · ${formatElapsed(now - running.at)}` ``
  - otherwise there is only one line
  - the output is uncolored.
- **Spinner frames**: `["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]`. The frame index is `Math.floor((now - startedAt) / 100) % 10`.
- **`stage(text)`**: stores the stage. The first call records `startedAt` (via `now()`) and mounts the widget. Later calls only request a re-render. When `ui` is null it only stores.
- **Mount**: `ui.setWidget(WIDGET_KEY, factory)`, no options, so the default placement is above the editor.
  - The factory stores `tui` and starts the ticker: a 100 ms interval calling `tui.requestRender()`, then `.unref()` on it.
  - It returns `render(width)`: `progressLines(...)` colored and then passed through `fit(line, width)`. The spinner is colored `theme.fg("accent", …)` and line 2 is wrapped whole in `theme.fg("dim", …)`.
  - It also returns `invalidate()` (no-op) and `dispose()`, which stops the ticker and drops `tui`.
- **`wrap(git)`** returns a `Git` that:
  - pushes `{ text: "git " + args.join(" "), cwd, at: now() }` onto an internal running list and requests a render
  - awaits `git(cwd, args)`
  - removes that exact entry in `finally` and requests a render
  - returns or rethrows the inner result unchanged.
  - The widget shows the last entry of the list.
- **`track(text, cwd, p)`** does the same bookkeeping around an existing promise.
- **`pause(f)`**:
  - If mounted, it clears the widget (`setWidget(WIDGET_KEY, undefined)`), stops the ticker and marks itself unmounted.
  - It awaits `f()` in `try/finally`. Afterwards it remounts only if it was mounted before and `done()` has not been called.
  - If nothing was mounted, it just awaits `f()`.
- **`done()`**: idempotent. It sets a finished flag, stops the ticker, and calls `setWidget(WIDGET_KEY, undefined)` if mounted. After `done()`, `stage()` does nothing.
- **Re-render requests** go to `tui?.requestRender()`. With no `tui`, nothing happens.

**Concurrency**
- Calls are sequential today. The running list still copes with overlapping calls; it shows the most recent one.
- One widget key is shared. A second command started while one runs takes over the key; that is acceptable.

**Failure handling**
- Every `Progress` user calls `done()` in `finally`.
- Rendering never throws on long lines because of `fit`.
- The ticker is `unref()`'d, so it never keeps node alive.

**Scale**
- One render every 100 ms for 1–3 lines is negligible.
- The spinner freezes during the synchronous `fs.cpSync` in `setupFiles`, because the event loop is blocked. Accepted; it is documented in the README limits.

**Alternatives rejected**
- Callbacks threaded into `git-ops`, `manage` and `update`: more files changed and test churn, for no extra information.
- `setWorkingMessage`: it does not show outside streaming.
- `setStatus` in the footer: no animation and easy to miss.

### 5. Steps
**S1.** Create `progress.ts` exactly per the Design interfaces:
- Use `import type { Git } from "./git-ops.ts"` and `import type` for `TUI`/`Component` (`@earendil-works/pi-tui`) and `Theme` (`@earendil-works/pi-coding-agent`). The only runtime import is `node:path`.
- Start with a one-line header comment in the style of `update.ts:1`.
- Model the factory and ticker on `workflow/view.ts:254-275`.
- The `now` constructor parameter defaults to `Date.now` (it exists for tests).

**S2.** In `index.ts`, add the imports:
- `import { truncateToWidth } from "@earendil-works/pi-tui";`
- `import { Progress } from "./progress.ts";`

**S3.** In the `handler` (`index.ts:392`):
- Before the `try`, create `const progress = new Progress(ctx.hasUI ? ctx.ui : null, \`/wt ${args.trim()}\`, truncateToWidth);`.
- Add `finally { progress.done(); }` to the existing `try/catch`.
- Pass `progress` as an extra last parameter to `newSet`, `openCmd`, `listCmd`, `updateCmd`, `removeCmd` and `doneCmd`, and add that parameter to each signature.
- The usage notify path needs no progress.

**S4.** `pickSet` (`:215`): add a `progress: Progress` parameter and run `ctx.ui.select` via `progress.pause(() => ctx.ui.select(title, sets))`. Update its three callers.

**S5.** `newSet` (`:155`):
- `git = progress.wrap(makeGit(pi))`, and call `progress.stage("checking repos (fetching)")` before `collect`.
- Pass `progress` into `build`, which gets a new parameter:
  - `progress.stage("creating worktrees")` before `createAll`
  - `progress.stage(\`linking/copying files: ${path.basename(p.info.top)}\`)` at the top of each loop iteration, before `setupFiles`.
- `progress.stage("opening terminal")` before `launch`.

**S6.** `openCmd` (`:247`):
- `progress.stage("finding the set")` after the name is known (after `pickSet`).
- `git = progress.wrap(makeGit(pi))`.
- The select at `:261` goes through `progress.pause`.
- `progress.stage("opening terminal")` before `launch` (`:269`).

**S7.** `listCmd` (`:210`):
- `progress.stage("reading repo status")`, then `listText(progress.wrap(makeGit(pi)), …)`.
- Before the Unity call, `progress.stage("asking Unity for open editors")` and use `await progress.track("unity status", ctx.cwd, unityEditors(pi))`.
- Compute the list text and the editors in separate statements: editors first (stage and track), then `listText`, so each stage label matches the work being done. Order: editors, then list.

**S8.** `updateCmd` (`:274`):
- `git = progress.wrap(makeGit(pi))`.
- After the name is resolved and checked, `progress.stage(\`updating ${name}\`)`.

**S9.** `removeCmd` (`:228`):
- After the name is known, `progress.stage(\`checking ${name} (fetching)\`)`.
- Env `git: progress.wrap(makeGit(pi))`.
- `confirm: async (t, m) => { const ok = await progress.pause(() => ctx.ui.confirm(t, m)); if (ok) progress.stage(\`removing ${name}\`); return ok; }`.

**S10.** `doneCmd` (`:292`):
- After `ctx.waitForIdle()`, `progress.stage("checking the set (fetching)")`.
- `git = progress.wrap(makeGit(pi))`.
- `editors: await progress.track("unity status", ctx.cwd, unityEditors(pi))`.
- Env `confirm` the same as S9, with stage `"removing the set"`.
- Call `progress.done()` right after `finishSet` returns, before any notify, sweep or the final confirm at `:325`.

**S11.** `session_start` auto-update (around `index.ts:352-363`):
- Inside the `try`, create `const progress = new Progress(ctx.hasUI ? ctx.ui : null, \`worktree update (${path.basename(session.setRoot)})\`, truncateToWidth);` and call `progress.stage("fetching and fast-forwarding")`.
- `short = progress.wrap(makeGit(pi, 15000))`, and pass `progress.wrap(makeGit(pi))` to `updateSet`.
- Call `progress.done()` in a `finally` attached to that `try`, so it runs before any notify of the result. Either restructure into `try { … } finally { progress.done(); }` around the `updateSet` call, or call `done()` right after `updateSet` resolves and also in the `catch`.
- `progress` must be declared where the `finally` can see it.

**S12.** `README.md`:
- Under `## Commands`, after the table (before `## Automatic update`), add one paragraph: while a `/wt` command or the automatic update runs, a widget above the editor shows a spinner, the stage, the git command running now with its folder, and the elapsed time. It is hidden while a dialog is open.
- Under `## Limits`, add a bullet: the spinner pauses while gitignored files are copied (a synchronous copy).
- In `## Tests` (`:113`), append `progress.test.ts` to the command.

### 6. Tests
New `progress.test.ts`, starting with the comment `// node --experimental-strip-types --test progress.test.ts`, using `node:test` and `assert/strict` like `update.test.ts:1-9`.

**Fakes**
- `ui`: records every `setWidget(key, content)` call into an array.
- `tui = { renders: 0, requestRender() { this.renders++ } }`
- `theme = { fg: (_c, s) => s }`
- `fit = (s, w) => s.slice(0, w)`
- a controllable clock `let t = 1000; const now = () => t`.

To render: take the last factory passed to `setWidget`, call it with `(tui, theme)`, then call `.render(200)`.

**Test cases**

| Test | Input | Expected |
|---|---|---|
| `formatElapsed formats seconds and minutes` | 0, 12999, 65000 | `"0s"`, `"12s"`, `"1m 05s"` |
| `progressLines without a running call` | `{title:"/wt update a", stage:"updating a", startedAt:0}`, now 3000, frame `"⠋"` | `["⠋ /wt update a · updating a · 3s"]` |
| `progressLines with a running call` | as above plus `running:{text:"git fetch origin", cwd:"D:/x/repo", at:1000}` | 2nd line `"  git fetch origin · repo · 2s"` |
| `stage mounts once and renders the stage` | `stage("a")`, `stage("b")` | exactly one `setWidget` call with a function; rendered line 1 contains `"b"` |
| `wrap shows the running git call and removes it after` | inner git returns a promise you resolve by hand, with `{code:0, stdout:"ok", stderr:""}`; render while pending | while pending, 2 lines and line 2 contains `"git fetch --quiet"` and the cwd basename; after resolving, the result is passed through and there is 1 line |
| `wrap removes the call when git rejects` | inner git rejects with `Error("boom")` | the wrapper rejects with `"boom"`; afterwards 1 line |
| `pause hides the widget and restores it` | `stage("s")`, then `pause(async () => 42)` | returns 42; the `setWidget` calls are mount (fn), clear (`undefined`), remount (fn) |
| `pause before any stage does not mount` | `pause(async () => 1)` with no stage | no `setWidget` calls |
| `done clears and later stage does nothing` | `stage("s")`, `done()`, `done()`, `stage("t")` | one clear (`undefined`) call after the mount, no further calls |
| `null ui is a no-op` | `new Progress(null, …)`: stage, wrap(git) call, pause, done | no throws, and wrap passes the result through |
| `render fits lines to the width` | `render(10)` | every line has length ≤ 10 |

The test process must exit on its own, which shows the ticker is `unref()`'d and stopped.

**Command** (in `pi/agent/extensions/worktree`):
```
node --experimental-strip-types --test config.test.ts layout.test.ts files.test.ts git-ops.test.ts manage.test.ts unity-guard.test.ts vscode-bridge.test.ts update.test.ts progress.test.ts
```
Expected: all tests pass, `fail 0`.

**Manual check** (cannot be run by the executor): in pi, `/wt list` and `/wt update <name>` show the widget with a running git command and remove it at the end.

### 7. Done when
- `progress.ts` exists with the exact exports and behaviour in section 4, and `progress.test.ts` covers the cases in section 6.
- Every `/wt` sub-command and the session-start auto-update create a `Progress`, set the stages from S5–S11, route their git runner through `progress.wrap`, and call `done()` on every exit path. Confirm and select dialogs run inside `progress.pause`.
- `doneCmd` removes the widget before its final "Close this pi session?" confirm.
- No file other than `progress.ts`, `progress.test.ts`, `index.ts` and `README.md` changes.
- The full test command passes with 0 failures.
- The README documents the widget, the copy limitation and the new test file.

### 8. Risks, rollback, what not to touch
- **Widget left on screen** after an exception: prevented by `finally { progress.done() }` in the handler and in `session_start`.
- **Line wider than the terminal** (pi-tui can throw): every line goes through `truncateToWidth`.
- **Runtime import of pi packages in `progress.ts`** would break the tests: only `import type` is allowed there.
- **Spinner freezes** during the synchronous copy: accepted and documented.
- **Rollback**: revert the commit. There is no data or config change.
- **Do not touch**:
  - `git-ops.ts`, `manage.ts`, `update.ts`, `files.ts`, `layout.ts`, `config.ts`, `unity-guard.ts`, `vscode-bridge.ts`
  - the notify texts
  - the `configFor` / `sessionConfig` git calls (they stay unwrapped)
  - the workflow extension.

### 9. Commits
- `worktree: show a progress widget while /wt commands and the auto-update run`: `pi/agent/extensions/worktree/progress.ts`, `progress.test.ts`, `index.ts`, `README.md`.

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 Create `progress.ts` exactly per the Design interfaces:
- [ ] S2 In `index.ts`, add the imports:
- [ ] S3 In the `handler` (`index.ts:392`):
- [ ] S4 `pickSet` (`:215`): add a `progress: Progress` parameter and run `ctx.ui.select` via `progress.pause(() => ctx.ui.select
- [ ] S5 `newSet` (`:155`):
- [ ] S6 `openCmd` (`:247`):
- [ ] S7 `listCmd` (`:210`):
- [ ] S8 `updateCmd` (`:274`):
- [ ] S9 `removeCmd` (`:228`):
- [ ] S10 `doneCmd` (`:292`):
- [ ] S11 `session_start` auto-update (around `index.ts:352-363`):
- [ ] S12 `README.md`:
