<!-- pi-workflow plan v1 flow=20261022-1402-flow-visualizer-a-progress-line-in-the-w-d9cf -->
## Plan: Flow visualizer: a progress line in the widget and a `/flow board` overlay for all flows

### 1. Goal and non-goals
**Goal**
- In the current session, the workflow widget shows a progress line:
  - the stage (`stage 2/3`)
  - a step bar with `done/total`
  - the current step
  - the judge round
  - the wait reason
- `/flow board` opens an overlay listing every recent flow across all repos and worktrees this machine's pi sessions have worked in. For each flow it shows phase, stage, step progress, whether a live session owns it, and how long ago it changed. Picking a flow shows its checklist, the subagents running now and a short timeline of recent events.
- Each running flow writes a small `live.json` into its plan folder so other sessions can follow it. It is written only when something changes, plus a 60 s heartbeat.

**Non-goals**
- No web page and no separate process.
- No change to the formats of `status.json`, `plan.md`, `claim.json`, `metrics.jsonl`, the plan refs or their sync.
- The board is read-only: no resume, stop or delete actions.
- No new config keys.
- No change to running sessions. They show up on the board after their next `/reload`. Before that they appear from `status.json` alone, marked `no live data`.

### 2. User decisions
- **D1:** Add a visualizer so the user can follow what flows are doing and how far they've got.
- **D2:** It lives inside pi: a richer in-session widget plus a `/flow board` overlay. No web dashboard.
- **D3:** The board covers flows from all repos the user works in, not only the current session or repo.

### 3. Facts the executor needs
`W` = `D:/projects/pi-config/pi/agent/extensions/workflow/`. The Git root is `D:/projects/pi-config`. Code uses tab indentation.

**Widget**
- `W/view.ts:236` `runs: RunView[]` is public on `FlowView`.
- `W/view.ts:24-42` `RunView` has `role`, `label`, `status: "running"|"ok"|"fail"`, `activity`, `started` and `ended?`.
- `W/view.ts:256-270` `FlowView.mount()` calls `ui.setWidget("workflow", …)` once. After that, `changed()` re-renders.
- `W/view.ts:430-459` `render(theme)` draws the pipeline line, then one line per run. It returns `[]` when `phase === "off"` and there are no runs.
- `W/view.ts:43` `STAGES`. Colours go through `theme.fg(<name>, text)` and `theme.bold`.

**State**
- `W/index.ts:108` `type Phase = "off" | "plan" | "execute" | "test"`.
- `W/index.ts:110-140` `FlowState` has `phase`, `judgeRounds`, `checklist`, `waiting` (`.reason`), `stage`, `planDoc` (`.flowId`, `.finished`) and `approvedPlan`.
- `W/index.ts:288` is the initial state.

**Status updates**
- `W/index.ts:432-449` `updateStatus(ctx)` sets the view fields and the status keys. It is called from 22 places.
- `W/index.ts:451-468` `emitStatus()` is the change-only JSON dedupe pattern to copy (`lastStatusEvent`).
- `W/index.ts:586-589` `currentStages()` returns `{ stages, current } | null`.

**Repos and plan folders**
- `W/index.ts:762` `flowRepos(ctx): Promise<RepoRef[]>` gives `RepoRef` values with `.root`.
- `W/index.ts:1022` `planDirFor(root: string | null)`.
- `planDirs: Map<flowId, dir>` is filled in `writePlan` (`W/index.ts:1072-1110`).

**Claim pattern**
- `W/index.ts:1055-1070`: `claimedFlow`, `claimTimer`, `claimCwd`, `refreshClaim()` and `stopClaimTimer()`. It runs every 60 s with `unref`. Copy it.
- `W/index.ts:1096-1104`: `writePlan` drops the claim when `snap.finished` is set.

**Shutdown and autopilot**
- `W/index.ts:3890-3897` `session_shutdown` stops the timers and drops the claim.
- `autopilotOn()` is defined next to `let resumes` (about `W/index.ts:346`).

**`/flow` command**
- `W/index.ts:3903` `SUBCOMMANDS`.
- The `/flow` switch is at about `W/index.ts:4088-4140`, with `case "status"` at `:4090`.
- `getAgentDir` is already imported in `W/index.ts` at `:32`, and `os` is already used there.

**Plan files and claims (`W/plan-store.ts`)**
- `:35-55` `readLocalStatuses(dir)` returns `{flowId, status, mtime}[]`.
- `:229-237` `Claim`, `CLAIM_LIVE_MS = 180_000`.
- `:265-280` `claimLive` and `pidAlive`.

**Plan data (`W/plan-doc.ts`)**
- `:5-12` `ChecklistItem {id, text, stage?, done}`.
- `:140-156` `PlanStatus`, which has `title`, `done`, `finished?: {at, ok, text}`, `waiting?: {reason, …}`, `stage?` and `updated`.
- `:197-222` `parseStatus` is the parser pattern to copy.
- `isFlowId` is also in `plan-doc.ts`.

**Overlay API**
- `ctx.ui.custom` isn't used in the extension yet. Copy the example at `C:/Users/IEC-WW/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent/docs/tui.md:70-130`.
- Signature: `ctx.ui.custom<T>((tui, theme, keybindings, done) => component, { overlay: true })`.
- Keys: `keybindings.matches(data, "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel")`.
- In RPC mode `custom()` resolves `undefined`. Check `ctx.mode !== "tui" || !ctx.hasUI` first.

**Tests and docs**
- `W/view.test.ts:1-15` stubs `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` with `registerHooks`. Any test importing `view.ts`, or a `board.ts` that imports pi packages, must stub them the same way.
- Tests use `node:test` and `assert/strict`.
- The test command, run in `W`, is `node --experimental-strip-types --test *.test.ts`. The baseline is `ℹ pass 588`, `ℹ fail 0`.
- `W/README.md:291` is "What you see" and `W/README.md:342` is "Commands".
- In `D:/projects/pi-config/docs/workflow-improvements.md` the next free ID is A22. Per the repo `AGENTS.md`, update the row, the Status line and the "Effect measurement" row in the same commit.

### 4. Design
**Components**
- **`W/board.ts` (new).** Pure logic plus registry and live-file I/O. It doesn't import pi packages; only `node:fs`, `node:path` and types from `./plan-doc.ts` are allowed. It provides:
  - the `LiveInfo` type and `parseLive`
  - `liveEvents`
  - `progressBar`
  - `ago`
  - `readRegistry` and `addToRegistry`
  - `readLive`
  - `boardRows`, `boardLines` and `detailLines` (stage 2)
- **`W/view.ts`.** An optional `progress` field and an exported pure `progressLine(p, theme)`. `render()` inserts that line after the pipeline line.
- **`W/index.ts`.**
  - Fills `view.progress`.
  - The live writer: `liveSnapshot`, `liveTick` and a 5 s timer.
  - Registry registration.
  - `/flow board` (stage 2).

**`live.json` contract** (`<planDir>/<flowId>/live.json`, written whole as `JSON.stringify(x, null, 2) + "\n"`, local only, never committed to refs):
```ts
export interface LiveInfo {
  v: 1; flowId: string; title: string;
  pid: number; host: string; cwd: string; updated: string; // ISO
  phase: string; stage?: number; stages?: number;
  steps: { id: string; text: string; done: boolean }[];   // text ≤ 80 chars
  judgeRound: number; autopilot: boolean;
  waiting?: string;                                        // ≤ 120 chars
  runs: { role: string; label: string; activity: string }[]; // running only, ≤ 6, strings ≤ 80
  events: { at: string; text: string }[];                  // newest last, ≤ 20
}
```

**Functions in `board.ts`**
- **`parseLive(json: string): LiveInfo | null`.** Returns `null` for non-JSON or `v !== 1`. It also returns `null` when a field has the wrong type:
  - `flowId` fails `isFlowId`
  - `title`, `host`, `cwd`, `updated` or `phase` isn't a string
  - `pid` or `judgeRound` isn't a number
  - `autopilot` isn't a boolean
  - `steps`, `runs` or `events` isn't an array with well-typed elements
  - `stage`, `stages` or `waiting` is present with the wrong type
- **`readLive(dir, flowId): LiveInfo | null`.** Reads and parses the file. Any error gives `null`.
- **`liveEvents(prev: LiveInfo | undefined, next: LiveInfo): string[]`.**
  - When `prev` is undefined it returns `["flow started"]`.
  - Otherwise it returns these texts in this order:
    1. `phase <old> → <new>` when the phase changed
    2. `stage <n>/<m>` when the stage changed
    3. `<id> done` for each step done in `next` but not in `prev`, in step order
    4. `judge round <n>` when `judgeRound` grew
    5. `waiting: <reason>` when a wait starts or its reason changes
    6. `wait over` when a wait ends
    7. `<role> started: <label>` for each run newly present
    8. `<role> finished: <label>` for each run no longer present
  - Runs are keyed by `role + "\n" + label`.
  - `updated`, `pid`, `events` and `activity` never produce events.
- **`progressBar(done, total, width): string`.** Filled cells are `floor(width * done / total)` of `█`, and the rest are `░`. A `total` of 0 gives all `░`.
- **`ago(ms): string`.**

  | Range | Output |
  |---|---|
  | under 60 s | `<n>s` |
  | under 60 min | `<n>m` |
  | under 48 h | `<n>h` |
  | otherwise | `<n>d` |

  Values are floored.
- **Registry: `<agentDir>/workflow/board.json` = `{ "v": 1, "dirs": [{ "dir": "<abs, forward slashes>", "updated": "<ISO>" }] }`.**
  - `readRegistry(file): string[]` returns the dirs, newest first. A missing or broken file gives `[]`.
  - `addToRegistry(file, dir, now: Date): void` normalises `\` to `/`, puts the dir first with `now`, removes duplicates of the same dir, and keeps 50.
  - It creates the parent folder, writes `<file>.<pid>.tmp`, then renames that over `file`.
  - It never throws.

**In-session writer (`index.ts`)**
- **`liveSnapshot(): LiveInfo | undefined`.**
  - Returns undefined when there is no `state.planDoc?.flowId` or no `planDirs` entry for it. A flow has no dir until its plan is first written.
  - Otherwise it builds the fields from the sources below. `updated` is now, and `events` is carried over from the previous snapshot.

  | Field | Source |
  |---|---|
  | `title` | `planTitle(state.approvedPlan)` |
  | `pid` | `process.pid` |
  | `host` | `os.hostname()` |
  | `cwd` | `claimCwd \|\| process.cwd()` |
  | `phase` | `state.phase` |
  | `stage`, `stages` | `currentStages()` |
  | `steps` | `state.checklist` |
  | `judgeRound` | `state.judgeRounds` |
  | `autopilot` | `autopilotOn()` |
  | `waiting` | `state.waiting?.reason` |
  | `runs` | `view.runs` with status `running` |

- **`liveTick(extra?: string)`.**
  1. Computes the snapshot and the events from `liveEvents(last, snap)`, plus `extra` if given.
  2. Stamps each event's `at`, appends it, and keeps the last 20.
  3. Writes only if the JSON with `updated` set to `""` differs from the last written one, or the last write is 60 s or more ago.
  4. On the first write to a dir in this session, it calls `addToRegistry(path.join(getAgentDir(), "workflow", "board.json"), dir, new Date())`.
  5. Everything is wrapped in try/catch and fails silently.
- **Timer.**
  - A 5 s `setInterval` (`unref`) calls `liveTick()`. It starts when a snapshot first exists and the flow isn't finished.
  - It stops when the flow finishes, on `session_shutdown`, and when `liveSnapshot()` returns undefined.
- **Finish.**
  - Where `writePlan` drops the claim for a finished flow (`:1096-1100`), call `liveTick("finished: <finished.text>")` once, then stop the timer.
  - The file stays on disk.

**Widget progress line**
- `FlowView.progress?: { stage?: number; stages?: number; done: number; total: number; current?: string; judgeRound: number; waiting?: string }`.
- `progressLine(p, theme)` joins the parts below with ` · `, prefixed by two spaces. Parts with no data are omitted.

  | Part | Shown when |
  |---|---|
  | `stage <stage>/<stages>` | staged |
  | `<bar 10> <done>/<total>` | always |
  | `now <current ≤ 50 chars>` | there is an open step |
  | `all steps done` | `done === total && total > 0` |
  | `judge round <n>` | `n > 0` |
  | `waiting: <≤ 40 chars>` | waiting |

- The bar uses `theme.fg("accent", …)`, and labels use `theme.fg("muted", …)`.
- `updateStatus` sets `view.progress` only when `state.approvedPlan` exists, `phase` is `"execute"` or `"test"`, and the checklist is non-empty. Otherwise it sets `undefined`. `current` is `"<id> <text>"` of the first open step.
- `render()` adds the line only when `progress` is set and `phase !== "off"`.

**Board (stage 2)**
- **Types.**
  - `BoardEntry = { flowId: string; dir: string; status: PlanStatus | null; live: LiveInfo | null; mtime: number }`.
  - `BoardRow = BoardEntry & { cls: "running" | "waiting" | "stalled" | "finished"; at: number }`, where `at` is the epoch ms of the newest of `live.updated`, `status.updated` and `mtime`.
- **`boardRows(entries, now, host, isAlive): BoardRow[]`.**
  - A live entry is one where `live` is set, `now - Date.parse(live.updated) < CLAIM_LIVE_MS`, `live.host === host` and `isAlive(live.pid)`.
  - `finished` means `status?.finished` is set.
  - Classification:
    - **running:** live and not finished, without `live.waiting`.
    - **waiting:** live and not finished, with `live.waiting`.
    - **stalled:** not live, not finished, and `now - at ≤ 7 days`.
    - **finished:** finished, and `now - Date.parse(finished.at) ≤ 24 h`.
    - **dropped:** anything else, and entries with neither `status` nor `live`.
  - Order: running, waiting, stalled, finished. Within a class, the newest `at` comes first.
  - The result is capped at 30.
- **`boardLines(rows, selected, width, now): string[]`.**
  - Empty input gives `["No flows in the last 7 days."]`.
  - Otherwise one line per row, starting with `▶ ` for the selected row and two spaces for the others, then:
    - the marker: `●` running, `⏸` waiting, `○` stalled, `✓` finished ok, `✗` finished failed
    - the title, truncated to 40
    - the repo folder name: the basename of `live.cwd`, otherwise of the dir's repo
    - the phase: `live.phase`, or `done`/`?`
    - `stage n/m` if known
    - `progressBar(done, total, 10)` and `done/total`
    - a `now` part: the current step id, or `waiting: <reason ≤ 30>`, or the finished text (≤ 30)
    - `ago(now - at)`
  - Without live data, done comes from `status.done.length`, total is `?`, the bar is omitted, and the `now` part is `no live data`.
  - Every line is truncated to `width`.
- **`detailLines(row, width, now): string[]`.** In order:
  1. The title.
  2. `flowId`.
  3. `cwd`.
  4. `phase · stage n/m · judge round n · autopilot on|off`.
  5. One line per step: `[x]` or `[ ]`, then id and text, with `▶` before the first open step.
  6. `waiting: <reason>` if set.
  7. `running:`, then one line per run: `<role> <label> — <activity>`.
  8. `recent:`, then the last 10 events as `HH:MM <text>` in local time.

  Without live data it shows the title, flowId, `done: <ids>`, the waiting reason from `status.waiting` and `no live data`.
- **`collectBoard(ctx)` in `index.ts`.**
  - The dir set is the union, without duplicates, of `readRegistry(...)`, `await planDirFor(null)` and `await planDirFor(r.root)` for each `flowRepos(ctx)` entry. Dirs that don't exist are skipped.
  - For each dir and each item of `readLocalStatuses(dir)`, it builds an entry with `live: readLive(dir, flowId)`.
  - It returns `boardRows(entries, Date.now(), os.hostname(), pidAlive)`.
- **`/flow board`.**
  - With `ctx.mode !== "tui" || !ctx.hasUI`, it calls `ctx.ui.notify(boardLines(rows, -1, 200, Date.now()).join("\n"), "info")` and returns.
  - Otherwise it opens `ctx.ui.custom(..., { overlay: true })`.
  - The component state is `rows`, `selected` (clamped) and `detail: boolean`.
  - `render(width)` shows a header `flow board · <n> flows`, then `boardLines` or `detailLines`, then a dim footer: `↑↓ select · enter details · esc back/close · refreshes every 2s`.
  - Keys:
    - up and down move `selected`
    - confirm opens the detail when rows exist
    - cancel in the detail goes back to the list
    - cancel in the list calls `done(undefined)`
  - Every 2 s an interval re-runs `collectBoard` and calls `tui.requestRender()`. A refresh still in flight is skipped. The interval is cleared before `done` and also when the promise resolves.

**Failure handling**
- Every read or write of `live.json` and `board.json` is in try/catch. Failures are silent and never block the flow or throw out of a command.
- Unreadable entries are skipped.

**Compatibility**
- Older sessions write no `live.json`. Their flows show from `status.json` as `no live data`.
- Retention (`deleteLocal`) removes whole flow folders, `live.json` included.

**Scale**
- Up to 50 dirs times at most 50 flows (`keepCount`) gives 2,500 flows at most. Each refresh reads 2 small files per flow, and only while the board is open.
- Writers: each session writes 1 file, at most every 5 s and only on change. It is about 10 KB at most, since it holds ≤ 20 events and the step texts.
- The design stops working at roughly 5,000+ flow folders, when the 2 s refresh outgrows its interval. Retention keeps it far below that.

**Rejected alternatives**
- **Adding fields to `status.json`:** it is committed to refs and synced remotely at each write.
- **Parsing `plan.md` for progress:** it is written only at milestones.
- **Wrapping `ui.notify` to capture events:** hacky and incomplete.
- **A web dashboard:** D2 rules it out.
- **Scanning `D:/projects` for repos:** slow and guesses. The registry records exactly the dirs sessions used.

### 5. Steps

### Stage 1: Live snapshot and widget progress line

**S1.** Create `W/board.ts` with the stage 1 functions from Design: `LiveInfo`, `parseLive`, `readLive`, `liveEvents`, `progressBar`, `ago`, `readRegistry` and `addToRegistry`.
- Start the file with a one-paragraph doc comment like `W/plan-store.ts:1`, saying what `live.json` and `board.json` are.
- Model `parseLive` on `parseStatus` (`W/plan-doc.ts:197-222`). Model the file reads on `readClaim` (`W/plan-store.ts:245-253`).

**S2.** `W/view.ts`:
- Add the `progress` field to `FlowView` (near `:236`).
- Add an exported pure `progressLine(p, theme)` as specified. It uses `progressBar` from `./board.ts`.
- In `render()` (`:430-459`), push the progress line right after the pipeline line, inside the `phase !== "off"` block, when `this.progress` is set.

**S3.** `W/index.ts` `updateStatus()` (`:432`): set `view.progress` per Design. Then call `liveTick()` as the last statement.

**S4.** `W/index.ts`: add the live writer next to the claim code (`:1055-1070`).
- Add `liveSnapshot`, `liveTick`, the timer, the last-snapshot, last-JSON and last-write-time variables, and the set of dirs registered in this session.
- Hook the finish into `writePlan` (`:1096-1100`).
- Stop the timer in `session_shutdown` (`:3890`).
- All of it follows the Design.

**S5.** Tests: create `W/board.test.ts` and extend `W/view.test.ts`, as in §6. Run the full suite and expect `fail 0`.

**S6.** Docs:
- `W/README.md` "What you see" (`:291`): add the progress line with one example line, and a short paragraph on `live.json` (where it is, its fields, change-only plus the 60 s heartbeat, local only) and the `board.json` registry.
- `docs/workflow-improvements.md`:
  - Add row A22 ("Flow visualizer: widget progress line, live.json, /flow board"), marked stage 1 done and the board pending.
  - Add an A22 Effect row ("Not measured yet").
  - Update the Status line.

### Stage 2: `/flow board` overlay

**S7.** `W/board.ts`: add `BoardEntry`, `BoardRow`, `boardRows`, `boardLines` and `detailLines` exactly as specified. Import `CLAIM_LIVE_MS` from `./plan-store.ts`, which has no pi imports.

**S8.** `W/index.ts`:
- Add `collectBoard(ctx)` and `case "board"` in the `/flow` switch (`:4088-4140`), per the Design.
- Add `{ value: "board", label: "board - live view of every flow on this machine" }` to `SUBCOMMANDS` (`:3903`).
- Import `pidAlive` from `./plan-store.ts`. It is already imported at `:70`, so check before adding.

**S9.** Tests: extend `W/board.test.ts` as in §6. Run the full suite and expect `fail 0`.

**S10.** Docs:
- `W/README.md`: add `/flow board` to "Commands" (`:342`), and a paragraph in "What you see" on the classes, markers, keys and refresh.
- `docs/workflow-improvements.md`: mark A22 fully done and update the Status line and the Effect row.

**S11.** Deploy:
1. In `D:/projects/pi-config`, run `./pi-config.sh preview`.
2. If every listed file is under `extensions/workflow/`:
   - run `./pi-config.sh import`
   - then check that `diff -rq pi/agent/extensions/workflow ~/.pi/agent/extensions/workflow | grep -v '\.bak-'` prints nothing
3. Otherwise don't import, and report the list.

Don't `/reload` any session.

### 6. Tests
**Command**, in `W`: `node --experimental-strip-types --test *.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)|^✖"`.
- Expected: `ℹ fail 0` and `pass` greater than 588.
- No `✖` lines.

**Stage 1, in `W/board.test.ts`.** No pi stubs are needed, because `board.ts` imports none.
- **"parseLive accepts a full snapshot and rejects broken ones"**
  - A full valid `LiveInfo` comes back `deepEqual`.
  - `"{"` gives `null`.
  - `v: 2` gives `null`.
  - A missing `steps` gives `null`.
  - `pid: "1"` gives `null`.
  - A bad `flowId` gives `null`.
- **"liveEvents reports changes in order"**
  - `prev`: phase `execute`, steps `[S1 open, S2 open]`, judgeRound 0, no runs.
  - `next`: S1 done, judgeRound 1, waiting `"review"`, runs `[{judge, "round 1"}]`.
  - Expect `["S1 done", "judge round 1", "waiting: review", "judge started: round 1"]`.
- **"liveEvents: first snapshot, no-op and endings"**
  - `undefined` → `["flow started"]`.
  - The same snapshot with only `updated` changed gives `[]`.
  - Going back to no waiting and no runs gives `["wait over", "judge finished: round 1"]`.
  - A phase change gives `phase execute → test` first.
- **"progressBar"**

  | Input | Expected |
  |---|---|
  | `(7, 10, 10)` | `"███████░░░"` |
  | `(0, 0, 10)` | `"░░░░░░░░░░"` |
  | `(10, 10, 10)` | `"██████████"` |

- **"ago"**

  | Input | Expected |
  |---|---|
  | `12_000` | `"12s"` |
  | `300_000` | `"5m"` |
  | `3 * 3_600_000` | `"3h"` |
  | `2 * 86_400_000` | `"2d"` |

- **"registry keeps newest first, dedupes, caps at 50, survives a broken file"** (use a temp dir)
  - Adding A, B, A gives `[A, B]`.
  - 55 distinct adds give length 50, with the newest first.
  - A file containing `x` gives `[]`.
  - A missing file gives `[]`.
  - A backslash path is stored with `/`.

**Stage 1, in `W/view.test.ts`.** Import `progressLine` next to `summaryLines` and use the identity theme as in `:19`.
- **"progressLine shows stage, bar, current step, judge round and wait":** `{stage: 2, stages: 3, done: 7, total: 10, current: "S8 Add x", judgeRound: 1, waiting: "approval"}` gives a line containing `stage 2/3`, `███████░░░ 7/10`, `now S8 Add x`, `judge round 1` and `waiting: approval`.
- **"progressLine omits empty parts and says all steps done":**
  - `{done: 3, total: 3, judgeRound: 0}` contains `all steps done`.
  - It doesn't contain `stage`, `judge round` or `waiting`.

**Stage 2, in `W/board.test.ts`.**
- **"boardRows classifies and sorts"**, with `now` fixed, `host "h"` and `isAlive = () => true`. Entries:
  - a fresh live entry → running
  - a fresh live entry with waiting → waiting
  - a stale live entry (updated 10 min ago), unfinished → stalled
  - a status-only unfinished entry updated 1 day ago → stalled
  - finished 1 h ago → finished
  - finished 2 days ago → dropped
  - unfinished, updated 8 days ago → dropped
  - a live entry on another host → stalled
  - a live entry with `isAlive` false for its pid → stalled

  Expect the classes in order running, waiting, stalled, stalled, stalled, stalled, finished. Within the stalled class, newest first.
- **"boardRows caps at 30":** 40 running entries give 30 rows.
- **"boardLines marks the selection and shows progress"**
  - Rows: one live with 7 of 10 steps done, one status-only.
  - `selected = 0`: line 0 starts with `▶ `, and the other line starts with two spaces.
  - Line 0 contains `7/10`.
  - The status-only line contains `no live data`.
  - `[]` gives `["No flows in the last 7 days."]`.
- **"detailLines lists the checklist with the current step and the last 10 events"**
  - A live row with S1 done, S2 and S3 open, 15 events, a wait and one run.
  - The S2 line has `▶`, and S3 doesn't.
  - Exactly 10 event lines appear after `recent:`.
  - `waiting:` and `running:` lines are present.

### 7. Done when
- In an executing flow, the widget shows the progress line with stage, step bar, `done/total`, the current step, the judge round and the wait reason (D1, D2).
- `/flow board` lists flows from every repo in the registry and the current session's repos, and refreshes every 2 s. Picking one shows its checklist, running subagents and recent events (D1, D2, D3).
- `live.json` follows the §4 contract and is written only on change or as a 60 s heartbeat.
- The formats of `status.json`, `plan.md`, `claim.json` and the plan refs are unchanged.
- All tests pass (`fail 0`).
- The README and `docs/workflow-improvements.md` A22 (row, Status line and Effect row) are updated.
- The installed extension matches the repo, or the reason it doesn't is reported.

### 8. Risks, rollback, and what not to touch
**Risks**
- At worst one small file write every 5 s while a flow changes. It is change-only and about 10 KB.
- Concurrent registry writes can lose an entry. The rename keeps the file valid, and that session's next first write re-adds it.
- `ctx.ui.custom` is new to this extension. Keep the key handling minimal, and always clear the refresh interval.
- Old sessions show as `no live data` until reloaded.

**Rollback:** revert the stage commits. Leftover `live.json` and `board.json` files are ignored.

**Don't touch:**
- `plan-store.ts` write functions and formats, `plan-doc.ts` `PlanStatus`/`parseStatus`, and ref sync
- `delivery.ts`, `readonly-bash.ts`, and the commit and push guards
- waits and autopilot behaviour, and config keys
- unity-packages, amazon-sdk worktrees and running sessions

### 9. Commits
- Stage 1: `feat(workflow): live flow snapshot and widget progress line`: `W/board.ts`, `W/board.test.ts`, `W/view.ts`, `W/view.test.ts`, `W/index.ts`, `W/README.md`, `docs/workflow-improvements.md`.
- Stage 2: `feat(workflow): /flow board overlay across repos`: `W/board.ts`, `W/board.test.ts`, `W/index.ts`, `W/README.md`, `docs/workflow-improvements.md`.

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 Create `W/board.ts` with the stage 1 functions from Design: `LiveInfo`, `parseLive`, `readLive`, `liveEvents`, `progress
- [ ] S2 `W/view.ts`:
- [ ] S3 `W/index.ts` `updateStatus()` (`:432`): set `view.progress` per Design. Then call `liveTick()` as the last statement.
- [ ] S4 `W/index.ts`: add the live writer next to the claim code (`:1055-1070`).
- [ ] S5 Tests: create `W/board.test.ts` and extend `W/view.test.ts`, as in §6. Run the full suite and expect `fail 0`.
- [ ] S6 Docs:
- [ ] S7 `W/board.ts`: add `BoardEntry`, `BoardRow`, `boardRows`, `boardLines` and `detailLines` exactly as specified. Import `CL
- [ ] S8 `W/index.ts`:
- [ ] S9 Tests: extend `W/board.test.ts` as in §6. Run the full suite and expect `fail 0`.
- [ ] S10 Docs:
- [ ] S11 Deploy:
