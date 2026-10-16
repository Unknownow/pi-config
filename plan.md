<!-- pi-workflow plan v1 flow=20261016-2353-workflow-extension-speed-ups-plan-card-f-0754 -->
## Plan: Workflow extension speed-ups, plan-card fix, caches, subagent idle timeout and per-flow metrics

### 1. Goal and non-goals

**Goal:** implement backlog items A3, A5, B7, B9, C2, C4, D2 and D3 from `docs/workflow-improvements.md` in `pi/agent/extensions/workflow/`. Cut wall time and tokens without changing what any model sees, except that the plan card names the plan file more often (B7). Add an idle timeout for subagents (D2) and a per-flow metrics log (D3), which later items need for measurement.

**Non-goals:**
- A1 (rejected).
- Every other backlog item (A2, A4, A6–A9, B1–B6, B8, B10, B11, C1, C3, C5, C6, D1).
- Any change to prompts' wording, judge logic, delivery, push guard or plan-ref sync.
- No caching of plan statuses.
- No `/flow` command for metrics.

### 2. User decisions

- **D1:** Do A1, A3, A5, B7, B9, C2, C4, D2, D3 first. On approval the user accepted the recommendations below.
- **D2:** A1 is skipped. The knowledge pass is a fallback that needs the judge's result (`index.ts:1340-1343`). In the backlog doc, mark it "rejected" with that reason.
- **D3:** A5 is done as "run the independent git calls before the judge in parallel" (`snapshotRepos`, `reviewPlan`). No guard checks exist to overlap.
- **D4:** C2 and C4 are done in their cheap, safe form: config cache with explicit invalidation; one `flowRepos` call plus a `plansDir` cache in housekeeping. Plan statuses are not cached.
- **D5:** A3 must keep `collectRepoDiff`'s output byte-identical, proven by a test against a copy of the old algorithm.
- **D6:** The D2 idle timeout defaults to 5 minutes and `0` turns it off. The timer pauses while a tool runs. The 15-minute hard limit stays.
- **D7:** D3 writes `metrics.jsonl` next to the flow's `plan.md`. It is local only and never included in the plan ref.
- **D8:** The flow's delivery is commit + push.

### 3. Facts the executor needs

- **Tests:** run with `node --experimental-strip-types --test <file>` from `pi/agent/extensions/workflow/`. Each test file starts with a `// node --test x.test.ts` comment, uses `node:test` and `node:assert/strict` (model: `subagent.test.ts:1-4`). Node is v24.21. The README test command is at `README.md:185`. There is no tsconfig, so there is no type-check step.
- **`git` helper:** `index.ts:580-582`, `git(cwd, ...args)` calls `pi.exec("git", ["-C", cwd, ...args], { timeout: 30_000 })` and returns `{ code, stdout, ... }`.
- **`collectRepoDiff`:**
  - It is at `index.ts:584-620` and returns `RepoDiff` (interface at `index.ts:220-227`). Its callers are `collectDiff` (`index.ts:632-637`) and `collectFlowDiff` (`index.ts:695`).
  - Current git calls: `rev-parse --is-inside-work-tree`; `diff --no-color <base>` (retried without base on failure); `ls-files --others --exclude-standard -z`; `diff --name-only -z --diff-filter=d <base>` (retried without base on failure); `ls-files --others --exclude-standard --full-name -z` (only when there are untracked files).
- **`snapshotTree`:** `index.ts:742-762`.
- **`snapshotRepos`:** `index.ts:765-775`. It runs `snapshotTree` and then `rev-parse HEAD`, one after the other, per repo.
- **`reviewPlan`:** `index.ts:778-804`. The delta texts come from `Promise.all` (`787-792`), then a sequential `for` loop over repos collects the changed names (`796-801`).
- **Plan card:**
  - `planCardText()` is at `index.ts:856-862`, `planFilePath()` at `index.ts:1037-1045`.
  - `planChain` is the background chain of plan writes (`index.ts:883`, extended at `index.ts:1010-1016`). `writePlan` (`index.ts:899-931`) sets `planDirs` at line 917.
  - The callers that build a card right after a compaction are the handover `onComplete` (`index.ts:1767-1771`) and the guard `onComplete` (`index.ts:1787-1791`).
  - Resume (`index.ts:1237-1242`) already awaits `planChain`; leave it alone.
- **Prompts:** `BATCH` and `PLAN_BATCH` are at `prompts.ts:6-9`. `PLAN_BATCH` is used at `prompts.ts:34` (in `planPhase`), `BATCH` at `prompts.ts:75` (in `EXECUTE_PHASE`). The two differ only in the tool list in parentheses.
- **Config:**
  - `loadConfig` is at `config.ts:225-248`, `saveRole` at `config.ts:251-256`, and `CONFIG_PATH = path.join(getAgentDir(), "workflow.json")` at `config.ts:208`.
  - `loadConfig` callers: `index.ts:273`, `2701`, `2952`, `3004` (right after `saveRole`, `3003`). No code assigns to `cfg` fields.
  - The `subagent` type is at `config.ts:145`, its defaults at `config.ts:202-205`. The repo's own `pi/agent/workflow.json:147` sets `subagent.extensions` only.
- **Housekeeping:**
  - `planHousekeeping` is at `index.ts:1048-1065`. It calls `flowRepos(ctx)` at 1051 and again at 1060, and calls `plansDir` at 1050-1051.
  - `writePlan` calls `plansDir` at `index.ts:901`.
  - `plansDir` (`plan-store.ts:11-16`) runs `git rev-parse --git-common-dir`.
- **`runSubagent`:** `subagent.ts:144-255`. The hard timer is at `subagent.ts:222-225`, the `kill` function at `216-219`, the stdout handler at `207-212`, and the error mapping at `subagent.ts:247-249`. `RunResult` is at `subagent.ts:55-64`.
- **pi-claude-bridge** streams `thinking_delta` events (`~/.pi/agent/npm/node_modules/pi-claude-bridge/src/index.ts:1266-1268`), so a healthy model keeps writing `message_update` lines.
- **`runRole`:** `index.ts:536-561`. It is the only path to `runSubagent`. `RunView` (`view.ts:30-47`) has `role`, `stage` and `started`.
- **Flow summary:**
  - `summarizeFlow` is at `index.ts:324-341`. It calls `view.endFlow(outcome, ok)`, which returns `FlowSummary` (`view.ts:84-97`: `outcome`, `ok`, `started?`, `ended`, `stages: FlowUsage`), and calls `planMilestone(..., finished)` first.
  - `setPhase("plan")` clears `state.planDoc` (`index.ts:443`).
  - `session_start` is at `index.ts:2700`; it distinguishes `event.reason === "reload"`.
- **Plan files:** `writeLocal` writes only `plan.md` and `status.json` (`plan-store.ts:19-27`). `commitRef` commits explicit contents only, so an extra file in the folder never reaches the ref. `deleteLocal` removes the whole folder.

### 4. Design

**New `repo-diff.ts`** holds the diff collection, so it can be tested.

```ts
export interface RepoDiff { full: string; files: number; names: string[]; checkNames: string[]; rootNames: string[] }
export type RunGit = (cwd: string, ...args: string[]) => Promise<{ code: number; stdout: string }>;
export async function collectRepoDiff(git: RunGit, cwd: string, base?: string): Promise<RepoDiff | null>
```

- Move `RepoDiff` here. `index.ts` imports it and keeps a thin wrapper, `collectRepoDiff(cwd, base) => collectRepoDiffImpl(git, cwd, base)`.
- **First call:** `rev-parse --is-inside-work-tree --show-prefix`. A non-zero code returns `null`. The prefix is the second output line with only `\r` and `\n` removed (`""` at the root).
- **Then in parallel:** `diff --no-color <base>`, `diff --name-only -z --diff-filter=d <base>` and `ls-files --others --exclude-standard --full-name -z`. Each diff that fails is retried once without `<base>`, as now.
- `rootUntracked` is the `ls-files` output. `untracked` (relative to `cwd`) is each entry with the prefix removed from its start.
- Everything else (reading files, the numbering format, the order of `parts`, `names`, `checkNames`, `rootNames`, the `files` count) stays exactly as in `index.ts:592-619`.
- **Fallback:** if the subfolder fixture shows that `ls-files --others` from a subfolder lists anything outside it, keep the old separate `ls-files` call (relative to `cwd`) only when the prefix is non-empty.
- Calls in the common case drop from 5 to 4, and three of them run in parallel.

**Plan card (B7).** Add `async function planCardReady(): Promise<string>` in `index.ts`:
- If `planFilePath()` already returns a path, return `planCardText()` right away.
- Otherwise wait for `planChain`, but no longer than 10 000 ms (`Promise.race` with a timer), then return `planCardText()`.
- `planCardText()` already falls back to the trimmed full plan when there is still no file.

**Config cache (C2):**
- `loadConfig(file = CONFIG_PATH)` and `saveRole(role, spec, file = CONFIG_PATH)`.
- A module-level cache entry `{ file, key, result }` with `key = \`${mtimeMs}:${ctimeMs}:${size}\`` from `fs.statSync`. A matching key returns the cached result object, including a cached parse error.
- A missing file clears the cache and returns `{ config: DEFAULTS }`.
- `saveRole` clears the cache after writing.

**Plan dir cache (C4).** `index.ts` gets `const plansDirCache = new Map<string, string>()` and `async function planDirFor(root: string | null): Promise<string>`:
- `null` calls `plansDir` directly (no git).
- A root is keyed by `repoKey(root)`, and the cache is filled on first use.
- `writePlan` (901) and `planHousekeeping` (1050-1051) use it. Housekeeping computes `const repos = await flowRepos(ctx)` once and uses it for both loops.

**Idle timeout (D2):**
- Config: `subagent: { extensions: string[]; timeoutMs: number; idleTimeoutMs: number }`, default `idleTimeoutMs: 5 * 60_000`. `loadConfig` resets a value that is not a finite number ≥ 0 to the default (only when `config.subagent` is an object).
- `RunOptions.idleTimeoutMs?: number` (`0` or `undefined` means off).
- Pure helper exported from `subagent.ts`:

```ts
export function idleWatch(ms: number, onIdle: () => void): { activity(): void; toolStart(): void; toolEnd(): void; stop(): void }
```

- Arm it at spawn. Every stdout data chunk calls `activity()`. A parsed `tool_execution_start` calls `toolStart()` and `tool_execution_end` calls `toolEnd()`; the count never drops below 0.
- While the count is above 0 no timer runs. When it returns to 0 the timer restarts.
- `onIdle` sets `stalled = true` and calls `kill()`. `stop()` runs in the `close` handler.
- Error priority: `aborted` > `timed out after Ns` > `stalled: no output for Ns` (N = `Math.round(ms / 1000)`) > exit code.
- `runRole` passes `cfg.subagent.idleTimeoutMs`.

**Boot time.** `RunResult.bootMs?: number` is the ms from `spawn` to the first stdout data chunk, set once.

**Metrics (D3).** New `metrics.ts`. The file is `<planDir>/<flowId>/metrics.jsonl`, one `JSON.stringify(event)` per line, UTF-8, `\n` line endings, append only.

```ts
type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type MetricEvent =
  | { kind: "subagent"; at: string; flowId?: string; role: string; label: string; stage: string; model: string; ms: number; bootMs?: number; turns: number; tools: number; tokens: Tokens; cost: number; ok: boolean; error?: string }
  | { kind: "compaction"; at: string; flowId?: string; reason: "handover" | "guard"; tokensBefore: number | null; ms: number; ok: boolean; error?: string }
  | { kind: "flow"; at: string; flowId?: string; outcome: string; ok: boolean; started?: number; ended: number; stages: FlowUsage };
export function subagentMetric(role: string, label: string, stage: string, model: string, started: number, ended: number, r: RunResult): MetricEvent
export function appendMetrics(folder: string, events: MetricEvent[]): boolean
export class MetricsQueue { record(e: MetricEvent): void; flush(folderOf: (flowId: string) => string | undefined, activeFlowId?: string): void; clear(): void; get size(): number }
```

- `at` is an ISO time. `tokens` and `cost` come from `RunResult.usage` (`cost` = `usage.cost.total`), `tools` = `toolCalls.length`, `turns` = `RunResult.turns`.
- `appendMetrics` writes to `path.join(folder, "metrics.jsonl")` only if `folder` exists. It never creates folders and never throws. It returns false when it didn't write.
- `MetricsQueue` keeps at most 1000 events and drops the oldest. `flush` works as follows:
  - An event without `flowId` gets `activeFlowId` when one is given.
  - Each event that has a `flowId`: if `folderOf` returns `undefined`, keep it. If it returns a folder, append it (grouped per folder, in order); an event whose folder is missing or whose write failed is dropped.
  - Events still without `flowId` stay queued.
- **`index.ts` wiring:**
  - `folderOf = (id) => planDirs.get(id) && path.join(planDirs.get(id)!, id)`.
  - The active flow is `state.planDoc && !state.planDoc.finished ? state.planDoc.flowId : undefined`.
  - Record a `subagent` event in `runRole` after every run. Record a `compaction` event in both compaction `onComplete` and `onError` callbacks.
  - Record a `flow` event in `summarizeFlow` from `view.endFlow`'s result, with `flowId` set explicitly to `state.planDoc?.flowId`, and only when that exists.
  - Call `flush` after every `record` and in `writePlan` right after `planLast.set` (`index.ts:918`), before refs sync and before any keepCount deletion.
  - `queue.clear()` in `session_start` when `event.reason !== "reload"`.
- **Data compatibility:** a new file only; nothing reads it. Retention deletes it with its folder. Not synced.
- **Failure handling:** every metrics write is best-effort and silent. A dropped event never affects a flow.
- **Scale:** about 1 line per subagent run (roughly 10–100 per flow, about 400 bytes each), so files stay well under 100 KB. The 1000-event queue only matters when no flow is ever approved.

**Alternatives rejected:**
- One global metrics file: D7 says next to the plan.
- Making `planCardText` async everywhere: only two callers need it.
- Caching plan statuses: D4.
- Parsing names from the patch text: A3 must be byte-identical (D5).
- Waiting for `planChain` without a cap: plan-ref pushes can take seconds.

### 5. Steps

#### Stage 1: Diff and snapshot speed-ups (A3, A5)

**S1.** Create `repo-diff.ts` with `RepoDiff`, `RunGit` and `collectRepoDiff(git, cwd, base = "HEAD")` as in section 4.
- Move the body of `index.ts:584-620`, reshaped to the parallel calls. Keep the file-reading loop, the `200_000` byte or binary rule, the `+${i + 1}: ` numbering, the `=== new file: ... ===` texts and the result order exactly.
- In `index.ts`, delete the `RepoDiff` interface (220-227) and import it. Replace the inner `collectRepoDiff` with a wrapper that calls the new function with the existing `git` helper (`index.ts:580`). `collectDiff` and `collectFlowDiff` stay unchanged.

**S2.** Create `repo-diff.test.ts` with fixtures in `os.tmpdir()`, using a `RunGit` built on `execFile("git", ["-C", cwd, ...args])` that returns `{ code, stdout }` without throwing.
- Copy the old algorithm (`index.ts:585-619`, adapted to take `git`) into the test as `legacyCollectRepoDiff`.
- For each case, assert that `deepEqual(new, legacy)` holds. Cases are listed in section 6.
- Configure `user.name`, `user.email` and `core.autocrlf=false` per fixture repo.

**S3.** A5 in `snapshotRepos` (`index.ts:765-775`): for each repo, start `snapshotTree(r.dir)` and `git(r.dir, "rev-parse", "HEAD")` together (`Promise.all`). The result and the null rule stay the same.

**S4.** A5 in `reviewPlan` (`index.ts:787-801`): one `Promise.all` over `diff.repos`. Each item runs the delta `diff --no-color <before> <now>` and `diff --name-only -z --diff-filter=d <before> <now>` together and returns `{ root, text, names }`.
- Build `delta` from the texts exactly as now: `combineRepoTexts` for multi-repo, else `parts[0].text`.
- Apply the same empty or size check.
- Build `changed` by walking the results in `diff.repos` order and adding names not yet present (the same order and dedupe as now).

**S5.** Run every test file in the folder. All pass.

#### Stage 2: Plan card, shared prompt line, caches (B7, B9, C2, C4)

**S6.** B7: add `planCardReady()` (section 4) next to `planCardText` (`index.ts:856`).
- In the handover `onComplete` (`index.ts:1767-1771`): the commit path stays synchronous (`send(\`${msg.content}\n\n${commitExcerpt()}\`)`). The non-commit path calls `void planCardReady().then((card) => send(\`${msg.content}\n\n${card}\`))`.
- In the guard `onComplete` (`index.ts:1787-1791`): check the phase and plan condition first, then `void planCardReady().then((card) => pi.sendMessage(...same message...))`.
- `compacting = false` and `guardTokens = null` still run synchronously first.

**S7.** B9: create `prompts.test.ts` *before* editing `prompts.ts`. Copy today's exact `BATCH` and `PLAN_BATCH` strings from `prompts.ts:7` and `prompts.ts:9` into it, and assert that `planPhase(true)` and `planPhase(false, "onRequest", "always")` contain `PLAN_BATCH` and that `EXECUTE_PHASE` contains `BATCH`.
- Then replace both constants with `function batchLine(tools: string): string`, which returns the shared sentence with `tools` inside the parentheses. Call it with `"a codemode script, ctx_batch_execute, or one bash command joined with && or ;"` for execute and `"a codemode script, ctx_execute for read-only analysis, or one bash command joined with && or ;"` for plan.
- Keep both doc comments, merged above the function.
- The test must still pass with identical strings.

**S8.** C2 in `config.ts`: add the optional `file` parameter to `loadConfig` and `saveRole`, plus the cache from section 4. Validation behaviour stays identical. Callers in `index.ts` stay unchanged and use the default path.

**S9.** C2 tests in a new `config.test.ts`, using a temp file path (never the real `CONFIG_PATH`). Cases are listed in section 6.

**S10.** C4 in `index.ts`: add `plansDirCache` and `planDirFor` (section 4). Use `planDirFor` at `index.ts:901` and in `planHousekeeping`. In `planHousekeeping`, call `flowRepos(ctx)` once at the start and reuse the result for the dirs loop (1051) and for `pruneRefs` (1060-1061).

**S11.** Run every test file. All pass.

#### Stage 3: Subagent idle timeout (D2)

**S12.** `config.ts`:
- Add `idleTimeoutMs: number` to the `subagent` type (145), with default `5 * 60_000` (204-205) and a doc comment: "Ends a subagent that writes nothing this long while no tool runs; 0 turns it off."
- Add the validation line to `loadConfig`, modelled on the `handoverCompactTokens` line at `config.ts:233`.

**S13.** `subagent.ts`:
- Add `idleWatch` (section 4), `RunOptions.idleTimeoutMs?: number` and `RunResult.bootMs?: number`.
- Wire it in `runSubagent`: arm after `spawn`; `activity()` and the `bootMs` capture in the stdout `data` handler after the lines are processed; `toolStart` and `toolEnd` in `onLine` for the two tool event types; `stop()` in `close` and `error`; `onIdle` sets a `stalled` flag and calls `kill`.
- Error mapping as in section 4.
- `index.ts` `runRole` (`index.ts:553`) passes `idleTimeoutMs: cfg.subagent.idleTimeoutMs`.

**S14.** Tests in `subagent.test.ts` for `idleWatch`, using `mock.timers` from `node:test` (`mock.timers.enable({ apis: ["setTimeout"] })`). Cases are listed in section 6. Add a `config.test.ts` case for `idleTimeoutMs` validation.

**S15.** README: after the paragraph at `README.md:299-301`, add one paragraph on `subagent.timeoutMs` (hard limit, 15 minutes) and `subagent.idleTimeoutMs` (5 minutes; paused while a tool runs; `0` off; error `stalled: no output for Ns`). Add `repo-diff.test.ts`, `prompts.test.ts` and `config.test.ts` to the test command at `README.md:185`. Run every test file.

#### Stage 4: Per-flow metrics log and backlog status (D3)

**S16.** Create `metrics.ts` exactly as in section 4 (types, `subagentMetric`, `appendMetrics`, `MetricsQueue`). Use a type-only import for `FlowUsage` from `./view.ts` and for `RunResult` from `./subagent.ts`.

**S17.** Wire it into `index.ts`:
- One `const metrics = new MetricsQueue()` inside `workflow()`, and a helper `recordMetric(e)` that calls `record` then `flush(folderOf, activeFlowId())`.
- **`runRole`:** take `started = Date.now()` before `runSubagent` and record `subagentMetric(role, label, run.stage, result.model ?? cfg.roles[role].model, started, Date.now(), result)` after it, for both ok and failed runs.
- **Handover compaction** (`index.ts:1762-1777`): note the start time before `ctx.compact`. Record `{ kind: "compaction", reason: "handover", tokensBefore: held, ms, ok: true }` in `onComplete` and `ok: false, error: e.message` in `onError`.
- **Guard compaction** (`index.ts:1785-1796`): the same with `reason: "guard"` and `tokensBefore: tokens`.
- **`summarizeFlow`:** capture `const flowId = state.planDoc?.flowId` before `planMilestone`. Where `view.endFlow(outcome, ok)` is called, keep its result in a variable, use it for `appendEntry` as now, and if `flowId` exists record `{ kind: "flow", flowId, outcome, ok, started, ended, stages }`.
- **`writePlan`:** call `metrics.flush(folderOf, activeFlowId())` right after `planLast.set` (`index.ts:918`).
- **`session_start`:** `metrics.clear()` when `event.reason !== "reload"`.

**S18.** Create `metrics.test.ts`. Cases are listed in section 6.

**S19.** README: add a short "Metrics" paragraph after the plan-files bullets (near `README.md:57`). Cover `<plan folder>/metrics.jsonl`, the three line kinds and their fields, that it is local only and not in the plan ref, that it is deleted with the plan, and that runs before approval go into the next approved flow. Add `metrics.test.ts` to the test command at `README.md:185`.

**S20.** In `docs/workflow-improvements.md`:
- Update the Status line to say which items are implemented.
- Add a `Done` note to the Finding cell of A3, A5 (state the "parallel git calls" reinterpretation), B7, B9, C2, C4 (state the scope: one `flowRepos` call plus a `plansDir` cache; statuses not cached), D2 and D3.
- Mark A1 "Rejected: the knowledge pass runs only when the judge skipped its knowledge step and takes the judge's findings (`index.ts:1340-1343`); running it in parallel would add an Opus run to every review."
- Fix A3's text to "4-5 git calls".

**S21.** Run every test file. All pass.

### 6. Tests

**`repo-diff.test.ts`.** Each case checks that new and legacy return equal values (`deepEqual`):
- **"repo root: modified, deleted and untracked files":** one commit with `a.txt` and `b.txt`; modify `a.txt`, delete `b.txt`, add untracked `c.txt`; run from the root.
- **"subfolder cwd lists only its untracked files with cwd-relative names":** files under `sub/` and at the root, untracked in both; run with `cwd = <repo>/sub`. Also assert that `rootNames` includes `sub/` paths and `names` has untracked names without the `sub/` prefix.
- **"renamed file":** `git mv x.txt y.txt` plus an edit.
- **"binary and oversized untracked files are not shown":** an untracked file containing a NUL byte, and one of 200 001 bytes.
- **"repo with no commits yet":** `git init` and one untracked file plus one staged file (retry path).
- **"not a git work tree returns null":** a temp folder without git. Both return `null`.
- **"untracked file names with spaces and unicode":** `new file ü.txt`.

**`prompts.test.ts`:**
- **"plan prompt keeps the plan batch line":** `planPhase(true)` and `planPhase(false, "onRequest", "always")` include the exact old `PLAN_BATCH` string.
- **"execute prompt keeps the batch line":** `EXECUTE_PHASE` includes the exact old `BATCH` string.

**`config.test.ts`** (temp folder per test):
- **"missing file gives defaults":** `loadConfig(missing).config === DEFAULTS`.
- **"edit is picked up":** write `{"maxJudgeRounds":3}`, load (3); write `{"maxJudgeRounds":44}` (a different size); load (44).
- **"saveRole clears the cache even within the same millisecond":** load, `saveRole("judge", { model: "p/x" }, file)`, load. The judge model is `p/x`.
- **"unchanged file returns the cached result":** two loads return the same object (`strictEqual`).
- **"bad JSON reports an error and uses defaults":** `error` contains the file path.
- **Stage 3, "idleTimeoutMs: bad value falls back to the default, 0 is kept":** `-1` and `"x"` become `300000`; `0` stays `0`.

**`subagent.test.ts`** (Stage 3, `mock.timers`):
- **"idleWatch fires after ms of silence":** `ms = 1000`; tick 999, not fired; tick 1, fired once.
- **"activity restarts the timer":** tick 800, `activity()`, tick 800, not fired; tick 200, fired.
- **"no timer while a tool runs":** `toolStart()`, tick 10 000, not fired; `toolEnd()`, tick 1000, fired.
- **"nested tools and extra toolEnd":** two starts, one end, tick 5000, not fired; a second end, tick 1000, fired; an extra `toolEnd()` does not throw or re-arm into a negative count.
- **"0 disables":** `ms = 0`, tick 1e9, not fired.
- **"stop cancels":** `stop()`, tick past `ms`, not fired.

**`metrics.test.ts`** (temp folders):
- **"subagentMetric maps a RunResult":** given a usage of input 10, output 5, cacheRead 100, cacheWrite 2, cost.total 0.5, 3 turns, 2 tool calls, `bootMs` 1200, ok. The event has those fields, `ms = ended - started`, and `kind: "subagent"`.
- **"appendMetrics writes one JSON line per event and never creates folders":** an existing folder gets two lines that `JSON.parse` back equal; a missing folder returns `false` and the folder still doesn't exist.
- **"flush keeps events of an unknown flow and writes them once its folder is known".**
- **"events without a flow attach to the active flow on flush":** record without `flowId`, flush with no active flow (still queued), flush with active `F` (written to `F`'s folder, queue empty).
- **"an event whose flow folder is gone is dropped".**
- **"queue keeps at most 1000 events, dropping the oldest".**
- **"clear empties the queue".**

**Command:** run from `pi/agent/extensions/workflow/`:

```bash
for f in *.test.ts; do node --experimental-strip-types --test "$f" 2>&1 | grep -E "^# (pass|fail)"; done
```

Expected: every file reports `# fail 0`.

### 7. Done when

- A3, A5, B7, B9, C2, C4, D2 and D3 are implemented as described, and A1 is not.
- Every `*.test.ts` in the folder passes.
- `repo-diff.test.ts` shows the new `collectRepoDiff` matches the old algorithm byte for byte in every case.
- The prompt texts that models see are unchanged (`prompts.test.ts`).
- A subagent that writes nothing for `idleTimeoutMs` while no tool runs is ended with `stalled: no output for Ns`; a tool running longer than that is not killed; `0` turns it off; the default is 5 minutes.
- A flow writes `<plan folder>/metrics.jsonl` with a `subagent` line for each subagent role it ran, a `compaction` line per compaction, and a final `flow` line. The file is not in the plan ref.
- After a handover compaction the plan card names the plan file whenever the plan write finishes within 10 s.
- README and `docs/workflow-improvements.md` are updated as in S15, S19 and S20.

### 8. Risks, rollback, what not to touch

**Risks:**
- A3 changes the git calls behind the judge's input. The byte-identical test is the guard. The subfolder fallback is in section 4.
- B7 sends the handover message up to 10 s later.
- C2: a same-size external edit within the same mtime and ctime tick would be missed. This is accepted; `/flow reload` after an edit of the same length is rare.
- D2 could kill a model that is silent for 5 minutes. The bridge streams thinking, and the setting can be raised or set to 0.
- D3 writes are best-effort and must never throw into a flow.

**Rollback:** each stage is its own commit set; revert it with `git revert`. D2 can also be turned off at runtime with `subagent.idleTimeoutMs: 0`.

**Do not touch:**
- Judge prompts, `JUDGE_*` texts, `knowledgePass`, `judgeOnce` logic.
- `snapshotTree`'s algorithm.
- Delivery, `push-guard.ts`, `commit-guard.ts`.
- Plan-ref sync (`syncRoot`, `commitRef` contents).
- `planCardText` and `planCard` output.
- The resume path at `index.ts:1237-1242`.
- `pi/agent/workflow.json` (the default covers `idleTimeoutMs`).

### 9. Commits

1. Stage 1: `perf(workflow): run diff collection and judge snapshot git calls in parallel` (`repo-diff.ts`, `repo-diff.test.ts`, `index.ts`)
2. Stage 2: `perf(workflow): plan card waits briefly for the plan file; cache config and plan dirs` (`index.ts`, `config.ts`, `config.test.ts`)
3. Stage 2: `refactor(workflow): share the batch prompt line between plan and execute` (`prompts.ts`, `prompts.test.ts`)
4. Stage 3: `feat(workflow): idle timeout for subagents` (`subagent.ts`, `subagent.test.ts`, `config.ts`, `config.test.ts`, `index.ts`, `README.md`)
5. Stage 4: `feat(workflow): per-flow metrics log next to the plan` (`metrics.ts`, `metrics.test.ts`, `index.ts`, `README.md`)
6. Stage 4: `docs: workflow backlog status for the first batch` (`docs/workflow-improvements.md`)

<!-- pi-workflow:status -->
## Checklist
- [x] S1 Create `repo-diff.ts` with `RepoDiff`, `RunGit` and `collectRepoDiff(git, cwd, base = "HEAD")` as in section 4.
- [x] S2 Create `repo-diff.test.ts` with fixtures in `os.tmpdir()`, using a `RunGit` built on `execFile("git", ["-C", cwd, ...arg
- [x] S3 A5 in `snapshotRepos` (`index.ts:765-775`): for each repo, start `snapshotTree(r.dir)` and `git(r.dir, "rev-parse", "HEA
- [x] S4 A5 in `reviewPlan` (`index.ts:787-801`): one `Promise.all` over `diff.repos`. Each item runs the delta `diff --no-color 
- [x] S5 Run every test file in the folder. All pass.
- [ ] S6 B7: add `planCardReady()` (section 4) next to `planCardText` (`index.ts:856`).
- [ ] S7 B9: create `prompts.test.ts` *before* editing `prompts.ts`. Copy today's exact `BATCH` and `PLAN_BATCH` strings from `pr
- [ ] S8 C2 in `config.ts`: add the optional `file` parameter to `loadConfig` and `saveRole`, plus the cache from section 4. Vali
- [ ] S9 C2 tests in a new `config.test.ts`, using a temp file path (never the real `CONFIG_PATH`). Cases are listed in section 6
- [ ] S10 C4 in `index.ts`: add `plansDirCache` and `planDirFor` (section 4). Use `planDirFor` at `index.ts:901` and in `planHouse
- [ ] S11 Run every test file. All pass.
- [ ] S12 `config.ts`:
- [ ] S13 `subagent.ts`:
- [ ] S14 Tests in `subagent.test.ts` for `idleWatch`, using `mock.timers` from `node:test` (`mock.timers.enable({ apis: ["setTime
- [ ] S15 README: after the paragraph at `README.md:299-301`, add one paragraph on `subagent.timeoutMs` (hard limit, 15 minutes) a
- [ ] S16 Create `metrics.ts` exactly as in section 4 (types, `subagentMetric`, `appendMetrics`, `MetricsQueue`). Use a type-only 
- [ ] S17 Wire it into `index.ts`:
- [ ] S18 Create `metrics.test.ts`. Cases are listed in section 6.
- [ ] S19 README: add a short "Metrics" paragraph after the plan-files bullets (near `README.md:57`). Cover `<plan folder>/metrics
- [ ] S20 In `docs/workflow-improvements.md`:
- [ ] S21 Run every test file. All pass.
