<!-- pi-workflow plan v1 flow=20261022-0924-session-list-in-rows-desktop-notificatio-cab8 -->
## Plan: Session list in rows, desktop notifications, keep-working prompts and faster multi-repo delivery

### 1. Goal and non-goals
**Goal.**
- The worktree extension shows the other running sessions one per line, below the editor.
- The workflow sends a desktop notification whenever a session needs you.
- Every agent prompt tells the model to keep working until it needs input, and to send independent tool calls in one reply so they run in parallel.
- The executor and test supervisor stop using fixed long sleeps.
- A delivery that spans several repositories runs the repositories in parallel, up to the pull request and the CI wait, and then merges them in order.
- The backlog records all of this.

**Non-goals.**
- Detecting whether the terminal window is focused.
- Changing `judge.recheckThinking` or adding `finalizeThinking`. They are logged as ideas only.
- `--auto` or `--admin` merges.
- Changing the order of steps inside one repository's delivery.
- Changing the K4 `workflow:status` payload.
- Any workflow → worktree reference (`boundary.test.ts` in both extensions).
- Changes in other repos (unity-packages, game-template, knowledge, shiny-loop).
- Stage headings: this is one delivery, commit + push.

### 2. User decisions
- D1. The session list is vertical, one session per line.
- D2. The list sits below the editor.
- D3. Desktop notification whenever a session needs you.
- D4. Always notify; no focus check.
- D5. `recheckThinking` and `finalizeThinking` are not changed now; they are backlog ideas only.
- D6. In every phase, agents only stop when they need input (the user, a tool's result, an explorer's answer) and send independent tool calls in parallel.
- D7. Delivery to several repos runs in parallel up to the CI wait, then merges in the listed order. `gh pr checks` uses `--interval 5`.
- D8. Fixed long sleeps are replaced by a rule: run in the foreground with a timeout, or poll in the same call.
- D9. Everything is delivered in one stage, commit + push.

### 3. Facts the executor needs
- **Worktree session list:**
  - `pi/agent/extensions/worktree/live.ts:74-88`: `footerText(entries, ownPid)` builds labels with `base(e.set ?? e.repo ?? e.cwd)`. State is `working[ execute N/M]`, `needs you` or `idle`. It joins at most 4 entries with ` · `, then ` +N`.
  - `worktree/index.ts:15` imports it; `index.ts:769-773` `pollFooter` calls `liveCtx?.ui.setStatus("wt-sessions", footerText(sessionsInUse(), process.pid))` every 5 s (`index.ts:790`). `sessionsInUse` is at `index.ts:37`.
  - `worktree/live.test.ts:38-50`: test `footerText`.
  - `worktree/README.md:76` documents the `wt-sessions` footer.
- **pi widget API:** `setWidget(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" })`, default `aboveEditor` (pi `dist/core/extensions/types.d.ts:49-52,101`). Tool calls from one assistant message can run in parallel (pi `docs/extensions.md:124`).
- **Workflow `index.ts` (re-grep before editing; lines drift):**
  - `import { execFile } from "node:child_process"` at `:20`.
  - `endFlow` at `:375`.
  - Menus open with `ctx.ui.select` (23 calls), at `:597`, 1309, 1645, 1666, 1693, 1786, 1792, 1798, 1804, 2331, 2694, 2836, 2858, 2946, 2958, 3033, 3169, 3207, 3254, 3511, 4077, 4099 and 4108. There is also `ctx.ui.confirm` ("Diff ready") at `:3152`.
  - The plan-phase hint when `planPrompt` is off is at `:2827-2829`.
  - `pi.on("agent_start")` at `:2664`. `pi.on("agent_end")` at `:2766-2777` increments `inAgentEnd`, calls `onAgentEnd` (`:2779`), then decrements.
  - Wait polling is `waitTick` at `:2008-2035`: stop branch at `:2016-2019` (maxMs notice at `:2018`), auto-resume at `:2025-2028`, "passed; send any message" at `:2029-2032`.
- **Config:**
  - `config.ts:64-75` is `WaitConfig`; `config.ts:224` holds the `wait` defaults; `config.ts:326-328` is the `wait` validation (model `notify` on it).
  - The shipped `pi/agent/workflow.json` doesn't list `wait`, and won't list `notify` either.
- **Prompts (`prompts.ts`):**
  - `batchLine` at `:8-10`, used at `:38` (plan), `:81` (execute) and `:95` (test).
  - Constants: `EXECUTE_PHASE` `:78`, `TEST_PHASE` `:93`, `RUNNER` `:133`, `EXPLORE` `:155`, `ADVISOR` `:165`, `JUDGE` `:222`, `COMMIT` `:255`, `ARBITER` `:261`, `JUDGE_KNOWLEDGE_ONLY` `:297`.
  - `delivery.test.ts:110` requires `finalize(...)` to end with "How to write the code is the executor's job.", so don't append to `finalize`.
- **Delivery (`delivery.ts`):**
  - `:76-80` hold `CHAIN`, `CHAIN_REMOTE` and `RULES`.
  - `:110-112` is the merge text with `gh pr checks <number> --watch --fail-fast`.
  - `:170-178` is `repoDeliveryInstruction`, whose head says "deliver each one below, one after the other."
  - `delivery.test.ts:64-70` pins the checks and merge strings.
- **Commit step:** runs as a sub-`pi` with the `bash` tool only (`index.ts:3617-3638`), so parallel bash tool calls in one reply are available to it. Don't rely on shell `&`/`wait`: the commit guard's shell check may refuse it.
- **Global agent instructions:** `pi/agent/AGENTS.md`, synced to `~/.pi/agent/AGENTS.md`. Its tool-output section is at `:10-24`.
- **Backlog (`docs/workflow-improvements.md`):** the next free IDs are A15, B12, C7 and D15. The Status line is at `:5` and currently ends "…D12, D13 and D14 are implemented; A13 and A14 are implemented; …". Its "Keeping this file current" rules are at `:7-11`.

### 4. Design
**Components.**
- `worktree/live.ts` `sessionLines()` (pure) and `worktree/index.ts` `pollFooter` (widget).
- `workflow/notify.ts` (pure): command builder, idle reason and debounce rule.
- `workflow/index.ts`:
  - `notifyUser(ctx, why)` spawns the command detached.
  - `askUser(ctx, title, options)` notifies, then opens `ctx.ui.select`.
  - An idle timer, scheduled after the outermost `agent_end` handling finishes.
- `prompts.ts` exports `PACE` and `NO_SLEEP`.
- `delivery.ts` `repoDeliveryInstruction` gets the new three-phase text.

**Interfaces.**
```ts
export function sessionLines(entries: LiveEntry[], ownPid: number): string[]          // live.ts, replaces footerText
export function notifyCommand(platform: NodeJS.Platform, title: string, body: string): { command: string; args: string[] } | null
export function idleReason(o: { phase: string; waiting?: string }): string
export function notifyDue(o: { enabled: boolean; hasUI: boolean; now: number; last?: number }): boolean  // gap 15_000 ms
export interface NotifyConfig { enabled: boolean; idleMs: number }                     // cfg.notify, defaults { enabled: true, idleMs: 10_000 }
```

**`sessionLines`.**
- One `label: state` line per other session, with the same label and state rules as `footerText`.
- At most 8 lines. When there are more than 8 others, the 8th line is replaced by `+N more`, where N = others − 7, so the widget is never taller than 8 lines.
- Returns `[]` when there are no others.
- `pollFooter` calls `setWidget("wt-sessions", lines.length ? lines : undefined, { placement: "belowEditor" })` and no longer calls `setStatus("wt-sessions", …)`. Call `setStatus("wt-sessions", undefined)` once in `startLive`, so a status left over from the old version is cleared after `/reload`.

**`notifyCommand`.**
- **`win32`:** `powershell.exe` with args `-NoProfile -NonInteractive -WindowStyle Hidden -Command <script>`. The script:
  - loads `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]`;
  - builds a `ToastText02` template;
  - sets the title and body as XML-escaped text;
  - shows it with `CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe')`.

  Inside the PowerShell single-quoted strings, title and body are XML-escaped (`& < > " '`) and single quotes are doubled.
- **`darwin`:** `osascript` with `-e`, `display notification "<body>" with title "<title>"`, with `\` and `"` escaped.
- **`linux`:** `notify-send` with args `[title, body]`.
- **Anything else:** `null`.

**Firing (`notifyUser`).**
- `notifyUser(ctx, why)` returns at once unless `notifyDue({ enabled: cfg.notify.enabled, hasUI: ctx.hasUI, now, last: lastNotifyAt })` holds.
- It then sets `lastNotifyAt = now` and `notifiedSinceStart = true`, and spawns `notifyCommand(process.platform, "pi", \`${basename(ctx.cwd)}: ${why}\`)` with `{ detached: true, stdio: "ignore", windowsHide: true }`. Use `spawn` from `node:child_process` and call `.unref()`.
- Spawn errors (the `error` event) and a null command are ignored silently.
- `notifyDue` is true when enabled, `hasUI`, and `last` is undefined or `now - last >= 15000`.

**Triggers.**
1. **Menus.** `askUser` (`notifyUser(ctx, title)`, then `ctx.ui.select(title, options)`) replaces `ctx.ui.select` at every call except the six that answer the user's own input. The excluded ones are `:597` (delivery choice after an approval), `:1309` (`/flow resume` picker), `:2694` (a typed message during a wait) and `:4077`, `:4099`, `:4108` (`/flow model`). Before `ctx.ui.confirm` at `:3152`, call `notifyUser(ctx, "diff ready for the judge")`.
2. **Idle after a turn.**
   - In the `agent_end` handler's `finally`, after `inAgentEnd--`, when `inAgentEnd === 0`, (re)start `idleTimer = setTimeout(cfg.notify.idleMs)`.
   - `agent_start` clears `idleTimer` and sets `notifiedSinceStart = false`.
   - When the timer fires, it calls `notifyUser(ctx, idleReason({ phase: state.phase, waiting: state.waiting?.reason }))` only if `ctx.isIdle()` and `!notifiedSinceStart`.
   - `idleReason` returns `waiting for you: <reason>` when waiting is set, `plan reply ready` in phase `plan`, and `turn finished` otherwise.
   - Because a new turn cancels the timer, this never fires for turns the workflow continues by itself (judge, commit step, next stage, auto-resume).
3. **Wait events in `waitTick`.** In the stop branch, when the check timed out (the `:2018` condition), call `notifyUser(ctx, \`stopped waiting for "<check>" after N min\`)`. In the non-auto-resume pass branch, call `notifyUser(ctx, \`"<check>" passed; send any message to continue\`)`. The auto-resume branch never notifies.
4. **Flow end.** `endFlow` calls `notifyUser(ctx, "flow finished")`. It runs inside `agent_end`, so `notifiedSinceStart` keeps the idle timer from notifying twice.

**Config.** `notify: { enabled: boolean; idleMs: number }`.
- A missing `notify` or a non-object takes the defaults.
- A non-boolean `enabled` takes the default.
- An `idleMs` that is not a finite positive number takes the default.

**Prompts.**
- `PACE` is exactly:

  > Don't stop between steps: keep going until you need the user's input, a tool's result or an explorer's answer. Put independent tool calls in the same reply so they run in parallel (several reads, a test run next to an explore, several explore queries or test tasks in one call); wait only for results the next step needs.

- `NO_SLEEP` is exactly:

  > Run long commands in the foreground with a timeout. To wait for a background job or the Unity Editor, poll in the same call every few seconds until it is done; never sleep for minutes.

- **Where they go:**
  - **List lines (`- ` + constant):** in `planPhase` and `EXECUTE_PHASE` next to their `batchLine`, and in `TEST_PHASE`.
  - **Final rule line:** in `JUDGE`, `ARBITER`, `EXPLORE`, `ADVISOR`, `RUNNER` and `JUDGE_KNOWLEDGE_ONLY`; use `- ` where the prompt has a rule list, a plain line otherwise.
  - **`NO_SLEEP`:** as a list line in `EXECUTE_PHASE` and `TEST_PHASE`.
  - **`pi/agent/AGENTS.md`:** both as bullets, in the "Tool output" section.
  - **`COMMIT`:** unchanged.

**Multi-repo delivery.**
- `repoDeliveryInstruction` keeps its per-repository sections. The head becomes:

  > "The judge passed. The change spans N repositories. Deliver them in three phases:
  > (1) in every repository, run its steps up to and including the pull request (or up to its last step if it has no pull request), sending one bash call per repository in the same reply so they run in parallel;
  > (2) for the repositories that merge, wait for their checks with one `gh pr checks <number> --watch --fail-fast --interval 5` bash call per repository, all in the same reply;
  > (3) merge them one at a time in the order listed below, and stop at the first repository whose checks failed or whose merge failed: don't merge the ones after it. Report each repository's result."

- The phrases the tests check are `in the same reply`, `in the order listed`, `stop at the first repository whose checks failed`, and `Report each repository's result`.
- Single-repo `deliveryInstruction` changes only the checks command, to `gh pr checks <number> --watch --fail-fast --interval 5`.

**Failure handling.**
- Notification failures are invisible and never block or throw.
- A timer firing after session shutdown is harmless: guard with `ctx.hasUI`, and clear the timer on `session_shutdown` if that hook exists in `index.ts`, otherwise `unref()` it.
- A merge failure in phase 3 leaves the later repos with open PRs, and the outcome reports that through the existing `readOutcome`/`combineOutcomes`.

**Scale.**
- The widget shows up to 8 lines, so a 9+ session machine shows `+N more`.
- Notifications are at most one per 15 s per session.
- Parallel delivery works for the usual 2–4 repos. GitHub asks for about 1 s between write requests from one user; serial merges keep that, and 2–4 parallel PR creates are far below any limit. Above about 10 repos in one flow, parallel PR creation could hit secondary rate limits; that is out of scope.

**Alternatives rejected.**
- A separate notify extension: it can't tell the workflow's automatic turns from real waits.
- Notifying on every `agent_end`: that spams during judge and commit steps.
- Shell `&`/`wait` in the commit step: it may be refused by the commit guard's shell check.
- A focus check: D4.
- A config switch for `recheckThinking`/`finalizeThinking`: D5.

### 5. Steps
**S1. Session list in rows** (`worktree/live.ts:74-88`, `worktree/index.ts:15,769-773`, startLive near `:777`, `worktree/live.test.ts:38-50`, `worktree/README.md:76`).
- Replace `footerText` with `sessionLines` as in the Design section, keeping the label and state code.
- `pollFooter` shows the widget below the editor; `startLive` clears the old status once.
- Update the import. Update the README sentence to "a list below the editor, one line per other session (at most 8)".
- Model it on the existing `footerText`, and on `progress.ts:102`, which uses `setWidget`.

**S2. Desktop notifications** (new `workflow/notify.ts` and `notify.test.ts`; `config.ts` interface near `:64`, defaults near `:224`, validation near `:326`; `config.test.ts`; `index.ts` as listed in Facts; `README.md`).
- Implement the pure functions in `notify.ts`.
- Add `NotifyConfig`, the defaults and the validation.
- In `index.ts`, add `notifyUser`, `askUser`, the idle timer (`agent_end` finally / `agent_start`), the `waitTick` and `endFlow` calls, and the confirm notice. Replace the 17 listed `ctx.ui.select` calls with `askUser`; keep the 6 excluded ones.
- **README:** a short "Desktop notifications" paragraph covering the triggers, the platforms, `notify.enabled` and `notify.idleMs`, and that automatic turns never notify. Add `notify.test.ts` to the test command.
- Model the config on the `wait` block, and the spawn on `execFile` use in `index.ts`.

**S3. Keep-working, parallel rule** (`prompts.ts`, `prompts.test.ts`, `pi/agent/AGENTS.md`).
- Export `PACE` with the exact text and insert it where the Design section says.
- Add the same text as a bullet in `pi/agent/AGENTS.md` "Tool output".

**S4. No fixed long sleeps** (`prompts.ts`, `prompts.test.ts`, `pi/agent/AGENTS.md`). Export `NO_SLEEP` with the exact text and insert it into `EXECUTE_PHASE`, `TEST_PHASE` and AGENTS.md.

**S5. Faster multi-repo delivery** (`delivery.ts:110-112,170-178`, `delivery.test.ts:64-70`, `README.md`).
- Add `--interval 5` to the checks command.
- Write the new three-phase head of `repoDeliveryInstruction`.
- **README:** in the Delivery section, one sentence: "With several repositories, the commit step opens their pull requests and waits for their checks in parallel, then merges them in order and stops at the first failure."

**S6. Backlog** (`docs/workflow-improvements.md`). Add new rows, following the "Keeping this file current" rules:
- **Done rows** (a **Done:** note naming the files):
  - A15 desktop notifications (S2);
  - A16 keep-working and parallel tool calls in all prompts (S3);
  - A17 no fixed long sleeps (S4; from ab-test, 34 min of `sleep 270-285`);
  - A18 parallel multi-repo delivery and `--interval 5` (S5).
- **Idea-only rows:**
  - A19 deliver a PR mid-plan and merge once at the end, so CI waits happen once;
  - B12 `finalizeThinking` for the final-plan reply (3–7 min Opus `high` replies, 23k–46k output tokens);
  - B13 cheaper judge rechecks (`recheckThinking: "low"` or a cheaper recheck model; 16–22 judge calls per flow at 15 s–3.5 min each).
- Add an Effect measurement row for each:
  - A15: menus answered within 1 min after a notification;
  - A16: tool calls per assistant message;
  - A17: total `sleep` seconds per session;
  - A18: commit-step duration on multi-repo merge stages;
  - A19: CI waits per flow;
  - B12: final-plan reply duration and output tokens;
  - B13: judge minutes per flow.
- Update the Status line to add "A15, A16, A17 and A18 are implemented".

### 6. Tests
- **`worktree/live.test.ts`, test `sessionLines`** (replaces `footerText`):
  - only own pid → `[]`;
  - a repo-labelled entry → `["game: idle"]`;
  - the existing 4-entry list → `["w1: working execute 2/5", "game: needs you", "w3: idle"]`;
  - 6 others → 6 lines;
  - 10 others → 8 lines, the last being `+3 more`.
- **`workflow/notify.test.ts`:**
  - **`notifyCommand`:**
    - `win32` → command `powershell.exe`, args include `-NoProfile` and a script containing `ToastNotificationManager` and the escaped text;
    - a title with `'` and `<` → `''` and `&lt;` appear, and no raw `<` from the input;
    - `darwin` → `osascript` with `display notification`, `"` escaped;
    - `linux` → `notify-send` with `[title, body]`;
    - `aix` → `null`.
  - **`idleReason`:** waiting → `waiting for you: publish core`; `plan` → `plan reply ready`; `execute` and `off` → `turn finished`.
  - **`notifyDue`:** disabled → false; no UI → false; `last` undefined → true; `now - last` = 14 999 → false; 15 000 → true.
- **`workflow/config.test.ts`:** defaults are `{ enabled: true, idleMs: 10000 }`; `notify: { enabled: "x", idleMs: -1 }` falls back to both defaults; `notify: 5` falls back to the defaults.
- **`workflow/prompts.test.ts`:**
  - `planPhase(true)`, `EXECUTE_PHASE`, `TEST_PHASE`, `JUDGE`, `ARBITER`, `EXPLORE`, `ADVISOR`, `RUNNER` and `JUDGE_KNOWLEDGE_ONLY` each include `PACE`;
  - `COMMIT` does not;
  - `EXECUTE_PHASE` and `TEST_PHASE` include `NO_SLEEP`;
  - `finalize(true)` still ends with "How to write the code is the executor's job."
- **`workflow/delivery.test.ts`:**
  - "merge deletes the branch by default" also asserts `gh pr checks <number> --watch --fail-fast --interval 5`;
  - new test `repoDeliveryInstruction runs repos in parallel then merges in order`: two merge-mode repos → the text includes `in the same reply`, `--interval 5`, `in the order listed`, `stop at the first repository whose checks failed` and `Report each repository's result`, and no longer includes `one after the other`.
- **Commands:**
  - in `pi/agent/extensions/workflow`: `node --experimental-strip-types --test *.test.ts`;
  - in `pi/agent/extensions/worktree`: `node --experimental-strip-types --test *.test.ts`.

  Expected: `ℹ fail 0` in both. `boundary.test.ts` passes in both.
- Syntax-check `workflow/index.ts` and `worktree/index.ts` with `node --no-warnings -e "require('node:module').stripTypeScriptTypes(require('fs').readFileSync('index.ts','utf8'))"`.

### 7. Done when
- Other sessions appear one per line below the editor, with at most 8 lines (the last one `+N more`), and no longer in the status bar.
- A desktop notification appears when any of these happens:
  - a workflow menu opens (except the six excluded ones);
  - a session stays idle 10 s after a turn;
  - a wait check passes without auto-resume, or polling stops;
  - a flow finishes.
- No notification appears for turns the workflow continues by itself. Notifications can be turned off with `notify.enabled: false`.
- All agent prompts (plan, execute, test, judge, arbiter, explorer, advisor, runner, knowledge check) and `pi/agent/AGENTS.md` carry the keep-working and parallel rule. Execute, test and AGENTS.md carry the no-long-sleep rule.
- Multi-repo delivery opens the PRs and waits for checks in parallel, merges in order and stops at the first failure. All checks watches use `--interval 5`.
- `docs/workflow-improvements.md` has rows A15–A19, B12 and B13 with their measurement rows and the updated Status line.
- `recheckThinking` and `finalizeThinking` are unchanged.
- All tests pass in both extensions.

### 8. Risks, rollback, what not to touch
- **Risks:**
  - The PowerShell toast could fail on locked-down machines. It fails silently, so the only effect is no notification.
  - The idle timer could fire during a long workflow step if `ctx.isIdle()` is true while a subagent runs. This is mitigated because the timer only starts after the outermost `agent_end` handler finishes.
  - A parallel merge could change the order in which commits land. Merges stay serial, in the listed order.
- **Rollback:** revert the commits; `notify.enabled: false` turns notifications off without a revert.
- **Don't touch:**
  - the push and commit guards;
  - the single-repo step order;
  - the K4 payload;
  - the `finalize` ending;
  - `judge` config values;
  - other repos;
  - workflow → worktree imports.

### 9. Commits
- `feat(worktree): list other sessions one per line below the editor`: `worktree/live.ts`, `worktree/live.test.ts`, `worktree/index.ts`, `worktree/README.md`
- `feat(workflow): desktop notification when a session needs you`: `workflow/notify.ts`, `workflow/notify.test.ts`, `workflow/config.ts`, `workflow/config.test.ts`, `workflow/index.ts`, `workflow/README.md` (notifications paragraph and test command)
- `feat(workflow): prompts keep working, call tools in parallel and avoid long sleeps`: `workflow/prompts.ts`, `workflow/prompts.test.ts`, `pi/agent/AGENTS.md`
- `feat(workflow): deliver several repos in parallel up to the CI wait`: `workflow/delivery.ts`, `workflow/delivery.test.ts`, `workflow/README.md` (delivery sentence)
- `docs(workflow): backlog A15-A19, B12, B13`: `docs/workflow-improvements.md`

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 Session list in rows (`worktree/live.ts:74-88`, `worktree/index.ts:15,769-773`, startLive near `:777`, `worktree/live.te
- [ ] S2 Desktop notifications (new `workflow/notify.ts` and `notify.test.ts`; `config.ts` interface near `:64`, defaults near `:
- [ ] S3 Keep-working, parallel rule (`prompts.ts`, `prompts.test.ts`, `pi/agent/AGENTS.md`).
- [ ] S4 No fixed long sleeps (`prompts.ts`, `prompts.test.ts`, `pi/agent/AGENTS.md`). Export `NO_SLEEP` with the exact text and 
- [ ] S5 Faster multi-repo delivery (`delivery.ts:110-112,170-178`, `delivery.test.ts:64-70`, `README.md`).
- [ ] S6 Backlog (`docs/workflow-improvements.md`). Add new rows, following the "Keeping this file current" rules:
