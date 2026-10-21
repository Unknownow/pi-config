<!-- pi-workflow plan v1 flow=20261022-0130-mid-plan-delivery-wait-points-and-tag-pu-8dd4 -->
## Plan: Mid-plan delivery, wait points and tag pushes in the workflow extension

### 1. Goal and non-goals

**Goal.** A flow can do three things partway through a plan, inside the executor's turn and without replanning:
- deliver (commit, push, pull request, merge);
- wait for a person (publish a package, open an Editor) and then continue the same plan, with the same stage and step numbers;
- create or move a git tag safely while several sessions run at once.

A stage that is blocked must no longer count as "delivered: no changes". A commit step that lands its commits on a new branch must be reported correctly.

**Non-goals.**
- Automating `updates.bat publish` or any registry publish. It stays with a person.
- Deleting tags.
- Changing what the executor's own shell may run. The push guard still refuses the executor's own `git push` and `git commit`.
- Changing the K4 `workflow:status` event payload.
- Cross-session claim files.
- Any change to the worktree extension or to the unity-packages, game-template, knowledge or shiny-loop repos.
- Parallel stages.

### 2. User decisions

- **D1.** Commit, push, PR and merge must be possible during execution, not only at the end of the flow or a stage. Stages alone are not enough.
- **D2.** The executor may deliver at checkpoints the plan does not name, as long as it stays within the approved delivery. Each such checkpoint updates the plan with an amendment. The same rule applies to unplanned waits.
- **D3.** Tag moves are allowed when the plan says so, and they must be safe when several sessions work at once.
- **D4.** Tags are made only when the plan states it or the executor requests it; the workflow never tags on its own. The target commit defaults to the tip of the remote default branch.
- **D5.** Publishing through `updates.bat` stays with a person, because of unity-packages rule 5. The flow waits for it. Approved with the plan.
- **D6.** The wait check is polled (every 2 min, up to 1 h), and the flow resumes by itself when the session is idle. `wait.autoResume: false` only notifies. Approved with the plan.
- **D7.** Delivery in 4 stages: delivery core and bug fixes; wait points; checkpoints and tags; docs and backlog. Approved with the plan.

### 3. Facts the executor needs

All paths are under `pi/agent/extensions/workflow/` unless stated.

**Flow state and delivery code (`index.ts`)**
- **Flow state:** `FlowState` at 104-163. The fields used here: `passedDiff` 114, `lastJudge` 116, `commitPending` 127, `delivery` 129, `approvedPlan` 135, `checklist` 137, `planRevisions` 147, `stage` 155, `stageJudged` 157, `stageOutcomes` 159. `persist()` is at 319.
- **Delivery:**
  - `prepareDelivery` 2980-3007; `finishPassed` 3010-3065; `sendCommitStep` 3068-3080.
  - `deliverSelfCommit` 3083-3154; `commitInSubagent` 3157-3195.
  - `summarizeCommit` 2561-2605; `repoOutcome` 2608-2626.
- **Stages:** `startNextStage` 2500-2515; `noChangeTurn` 2518-2528; `stageWithoutChanges` 2531-2550.
- **Turn end and review:** `onAgentEnd` 2375-2497. In the execute phase it reaches `summarizeCommit` and then `reviewDiff` at 2493-2497. `reviewDiff` is at 2664-2749 and calls `noChangeTurn` at 2678.
- **Tools:**
  - `judge` tool 1974-2018: it sets `stageJudged` at 1990 and handles a pending plan flaw at 2003-2006. `judge()` itself is at 851.
  - `plan_check` tool 1899-1935 is the model for new tools (TypeBox parameters, `reply` helper, phase check).
- **Arbiter amendments:** appended at 2894 as `## Amendment ${done + 1} (arbiter)`, where `done = state.planRevisions`. After that: `refreshChecklist()`, `planMilestone(ctx)`, `persist()`.
- **Plan file:**
  - `writePlan` 995 builds the `PlanStatus` at 1001-1012;
  - `planMilestone` is at 1101 and `rewritePlanFile` is called at 1925;
  - `/flow resume` reads `status` at 1276.
- **Status bar and events:**
  - `updateStatus` 380, with the `setStatus("workflow-plan", …)` pattern at 392;
  - tools blocked in the plan phase at 446: `[...cfg.planBlockedTools, "judge", "plan_check"]`;
  - `pi.on("input")` 2304 (actions `continue`, `transform` and `handled` exist in pi's `InputEventResult`);
  - `session_before_switch` 3321, `session_shutdown` 3327;
  - `setPhase` 461 (`leavingFlow` at 462), `endFlow` 367, `summarizeFlow` 339;
  - `git()` helper 651: `pi.exec("git", ["-C", cwd, …], { timeout: 30_000 })`;
  - the stage note for the judge is added at 883 and 893.

**Other modules**
- **`agent-end.ts:158-160`** `noChangeStage(judged, hasUI, auto)` returns `"advance"` when `judged || auto`. Tested at `agent-end.test.ts:159-170`.
- **`stages.ts`:**
  - `HEADING` and `TAG` regexes at 13-14 (TAG only matches a trailing `(delivery: x)`);
  - `parseStages` 22-46, `stageDelivery` 49, `stageStart` 54, `nextStage` 61, `stageNote` 72, `stagesOutcome` 78.
- **`plan-doc.ts`:**
  - `ChecklistItem` 5-12 (its text is cut to 120 characters at 80);
  - `AMENDMENT = /^## (?:Amendment \d+|Plan choices upheld)/` at 23, so `## Amendment N (executor: …)` is already treated as an amendment;
  - `parseChecklist` 60, `planCard` 103-121, `PlanStatus` 139-153, `renderPlanFile` 170, `parseStatus` 191-210.
- **`delivery.ts`:** `DeliveryOptions` 43-61, `deliveryInstruction` 80-114, `deliveryOutcome` 127, `combineOutcomes` 150, `pushSkipReason` 75.
- **`push-guard.ts:110`:** only `push` and `commit` are checked for the executor, so its `git merge origin/main` and local `git tag` are not refused. The workflow's own `git()` calls are not subject to the shell guard.
- **`readonly-bash.ts:289`:** `readOnlyProblem(command, allow?)` returns null when a command is read-only.
- **`config.ts`:**
  - `WorkflowConfig` 102-140;
  - `DEFAULTS` around 190-230 (`stageAdvance: "auto"` 205, `delivery` 208);
  - validation pattern at 303-313.
- **`prompts.ts`:**
  - `planPhase` 17-43 (the stages bullet is at 26-29);
  - `finalize` 45-69;
  - `EXECUTE_PHASE` 73-86. Line 84 says "Never commit, push, or open or merge a pull request yourself, even when the plan says to …". This must change.
- **`README.md:190`:** the test command. Staged plans are at 56-65, delivery at 66-75, the push guard at 77-83.

**Outside this extension**
- **`unity-packages`:** `AGENTS.md:36-40` (rule 5) and `scripts/update-packages.mjs:264-272`. The tag `<name>/v<version>` is pushed only after a successful upload, so `git ls-remote --exit-code --tags origin <name>/v<version>` proves a publish happened.
- **`docs/workflow-improvements.md`:** the Status line is at 5, section A rows go up to A12 (line 42), section D rows go up to D13 (line 87), and the Effect measurement table starts at about 99. Next free IDs: A13, A14, D14. Follow the rules at 9-11.

### 4. Design

**Components**

| Component | Responsibility |
|---|---|
| Delivery core (`index.ts`, split from existing code) | Prepare each repo, run the commit subagent, read the outcome. It never advances a stage, ends a flow, or sets `commitPending` on its own. |
| `waits.ts` (new, pure) | Wait types, parsing of wait steps and stage `after` tags, decisions on resume and polling, amendment text for waits. |
| `checkpoints.ts` (new, pure) | Mode limit, parsing of Deliver steps, whether a call is planned, amendment text for checkpoints, the checkpoint note for the judge, and combining checkpoint text with outcomes. |
| `tags.ts` (new, pure) | Decides what a tag request does from git facts (create, move, refuse or wait), and builds the push arguments. `index.ts` runs the git calls. |
| `wait_for_user` tool, wait timer, input hook (`index.ts`) | The waiting state, polling, and resuming. |
| `deliver` tool (`index.ts`) | The judge gate, the delivery core, the tag action, recording checkpoints. |

**Interfaces and contracts**

- **New `FlowState` fields:**
  ```ts
  waiting?: { reason: string; check?: string; step?: string; stage?: number; since: string; planned: boolean; atStageStart?: boolean; checkPassed?: boolean };
  checkpoints?: { step?: string; stage?: number; text: string; ok: boolean }[];
  ```
- **`PlanStatus` gets two optional fields.** `waiting?: { reason: string; check?: string; since: string }` and `checkpoints?: { step?: string; text: string; ok: boolean }[]`. `parseStatus` accepts and validates them. A status without them stays valid, and older readers ignore them.
- **Tool `wait_for_user`** (execute phase only; blocked in the plan and test phases):
  ```ts
  { reason: string; check?: string; step?: string }
  ```
- **Tool `deliver`** (execute phase only; blocked in the plan and test phases). At least one of `mode` and `tag` is required:
  ```ts
  { mode?: "commit"|"push"|"pr"|"merge"; reason: string; step?: string; tag?: { name: string; repo?: string; commit?: string; move?: boolean } }
  ```
- **Plan syntax:**
  - **Wait step.** The full line starts `**S<n>.** Wait: <what the person does>` and may end in `(check: <command>)`.
  - **Deliver step.** The full line starts `**S<n>.** Deliver: <mode and/or tag>`, e.g. `Deliver: push`, `Deliver: tag unity-build/v1.0.9 in unity-packages`, `Deliver: move tag unity-build/v1.0.8 in unity-packages`.
  - **Stage heading.** It may end in tags in either order: `(delivery: <mode>)` and `(after: <what>; check: <command>)`. A check command must not contain `)`.
- **Amendment formats** (exact headings; N = number of `^## Amendment \d+` lines in `approvedPlan` + 1, shared with the arbiter):
  - `## Amendment N (executor: wait)`, then the line `<reason>` + ` (step <S>)` when a step was named + ` (check: <check>)` when one was given;
  - `## Amendment N (executor: checkpoint)`, then the line `Deliver <mode>` and/or `tag <name>`, then ` — <reason>`.
- **Config block** `wait`, defaults `{ pollMs: 120000, maxMs: 3600000, checkTimeoutMs: 30000, autoResume: true }`. Non-positive or non-number values fall back to the defaults; `autoResume` must be a boolean.
- **Messages:**
  - customType `workflow-wait` for the automatic resume. Its content starts `The wait for "<reason>" is over (check passed).`
  - On a typed resume, your message is transformed to start with one of:
    - `The wait for "<reason>" is over (check passed).`
    - `The wait for "<reason>" is over (you continued without the check passing).`
    - `The wait for "<reason>" is over.`

    This prefix is followed by a blank line, then your text.
- **Outcome text:**
  - a checkpoint renders as `checkpoint <S|"unplanned">: <outcome>`;
  - a stage or flow outcome is the checkpoints' texts joined with `; `, then the end-of-stage delivery text;
  - with no changes after checkpoints, the last part reads `no further changes`.

**Data model and compatibility.** All new state is optional, so old sessions load unchanged. `/flow resume` restores `waiting` and `checkpoints` from `status.json` when present. A resumed flow that waits on a check restarts the timer.

**Failure handling**
- **A check fails, errors or times out:** it counts as "not yet", never as passed.
- **A check is not read-only:** the tool call is refused (`readOnlyProblem`).
- **The tag remote cannot be reached:** the tool result reports the error and does not wait.
- **A tag lease or ancestry check fails:** the flow waits.
- **A planned tag create finds the name taken:** the flow waits.
- **An unplanned tag create finds the name taken:** the tool result says so and the executor may choose the next free name. That is a new unplanned call, so it amends the plan.
- **A commit subagent fails mid-checkpoint:** the outcome is still read from git and reported, and the stage continues.
- **The tool's signal aborts:** the judge and the commit step stop; the outcome so far is reported.

**Scale.**
- **Polling:** one `ls-remote` is about 1 s. At 30 polls per waiting flow per hour, 8 waiting sessions make about 240 calls an hour.
- **Waits:** one wait per flow at a time. Two prerequisites go into one check joined with `&&`.
- **Tag races:** settled by git's atomic ref update (plain push for a create, lease for a move).
- **Where it stops working:** a host that refuses or ignores `--force-with-lease` on tags (then the move waits and a person does it), and sessions that need more than one pending wait each.

**Alternatives rejected**
- **Step tags turned into hidden stages.** The turn still ends and hands over, which is the friction.
- **Resume only on your message.** You'd still have to return to every session.
- **Notify-only by default.** One extra message per wait for nothing; it stays available as a setting.
- **Cross-session claim files for tags.** They would break boundary D11, and git is already atomic.
- **Tag pushes by the commit model.** That would need the guard relaxed and gives unpredictable commands.
- **Automating `updates.bat`.** Rule 5 forbids it.

### 5. Steps

### Stage 1: Delivery core and bug fixes

**S1. Split delivery into three reusable functions in `index.ts`** (anchors `finishPassed` 3010, `commitInSubagent` 3157, `summarizeCommit` 2561). Behaviour must stay byte-for-byte the same for stage and flow delivery.
- **`prepareAllRepos(ctx, diff, chosen, seed)`** returns `{ pending, instruction }`. This is the single-repo and multi-repo preparation now at 3046-3063, without assigning `state.commitPending`.
- **`runCommitSubagent(ctx, instruction, chosen, pending, signal?)`** returns the subagent's report text. This is the body of `commitInSubagent` from the guard-extension check to the `workflow-commit` message, without `summarizeCommit` and `resetCommitStage`. `signal` is passed to `runRole`.
- **`readOutcome(ctx, pending)`** returns `{ text, ok }`, the outcome reading at 2567-2573.

`finishPassed`, `commitInSubagent` and `summarizeCommit` are rewritten to call these three and keep their current side effects in the same order. Pure helpers live in `delivery.ts`.

**S2. Read commits from the branch they landed on (D14).**
- **Where:** `repoOutcome` (`index.ts:2608`). Add a pure helper to `delivery.ts`:
  ```ts
  export function outcomeRef(o: { recorded?: string; recordedMoved: boolean; current: string; currentAhead: boolean }): string | undefined
  ```
- **Rule:** it returns `current` when the recorded branch exists but did not move, `current` is a named branch other than `recorded`, and `currentAhead` is true. `currentAhead` means HEAD differs from `head` and `git merge-base --is-ancestor <head> HEAD` succeeds. Otherwise it returns `undefined`, meaning keep today's logic.
- **Effect:** when it returns a branch, `repoOutcome` counts commits, checks push state and looks up the PR on that branch.

**S3. Commit-only instruction** (`deliveryInstruction`, `delivery.ts:80`).
- In `mode === "commit"`, add this sentence before `CHAIN`: ``Don't run `git push` in any command, not even chained after a commit: the guard refuses the whole command and nothing is committed.``
- Add `mergeInProgress?: boolean` to `DeliveryOptions`. When true and not `committed`, use this text instead of SPLIT/SINGLE: ``A merge is in progress: stage all reviewed files by path and conclude it with one `git commit --no-edit`; don't split it.``
- `prepareDelivery` (`index.ts:2980`) sets the flag when `git rev-parse -q --verify MERGE_HEAD` succeeds in that repo.

### Stage 2: Wait points

**S4. Add `waits.ts` (pure).** It exports:
- **`parseWaitStep(plan: string, id: string)`** returns `{ reason: string; check?: string } | null`. It reads the step's full line in the plan, not the 120-character checklist text. It returns non-null only when the text after `**S<n>.**` starts with `Wait:` (case-insensitive). The trailing `(check: …)` is split off.
- **`waitAmendment(n: number, w: { reason: string; step?: string; check?: string })`** returns the exact heading and line of section 4.
- **`resumePrefix(reason: string, how: "passed" | "forced" | "plain")`** returns the three exact prefixes of section 4.
- **`pollDecision(o: { waiting: boolean; hasCheck: boolean; idle: boolean; elapsedMs: number; maxMs: number })`** returns `"run" | "hold" | "stop"`:
  - `"stop"` when not waiting, there is no check, or `elapsedMs >= maxMs`;
  - `"hold"` when not idle;
  - else `"run"`.

**S5. Stage `after` tag** (`stages.ts:13-46`).
- Extend the tag parsing so a heading may end in `(delivery: …)` and/or `(after: <what>; check: <command>)`, in either order.
- `PlanStage` gets `after?: { reason: string; check?: string }`. `check` is optional. The title excludes both tags.
- Invalid modes are ignored, as today.

**S6. Waiting state, status and plan card.**
- **State:** add `waiting` and `checkpoints` to `FlowState` (`index.ts:104`) and to `PlanStatus`, `parseStatus` and `writePlan` (`plan-doc.ts:139`, `191`; `index.ts:1001`). `/flow resume` restores them and restarts the timer (S8) when the wait has a check.
- **Status bar:** `updateStatus` sets `setStatus("workflow-wait", "waiting: <reason, first 40 chars>")` while waiting, and clears it otherwise.
- **Plan card and file:** `planCard` gets an optional last parameter `waiting?: string` and adds `### Waiting for\n<reason>` after the open steps. `renderPlanFile` gets the same optional parameter and writes a line `**Waiting for:** <reason>` below the checklist.
- **Callers:** pass `state.waiting?.reason`.

**S7. The `wait_for_user` tool** (`index.ts`, modelled on `plan_check` 1899).
- **Refused:** outside the execute phase or without an approved plan. Also refused, with the problem text, when `check` is given and `readOnlyProblem(check)` is not null.
- **Planned or not:** a wait is planned when `step` is given and `parseWaitStep(approvedPlan, step)` is non-null.
- **Unplanned:** append `waitAmendment` to `approvedPlan`. N counts the existing amendments; `planRevisions` is not touched. Then `refreshChecklist()` and `planMilestone(ctx)`.
- **Set** `state.waiting` with `since` = now, `stage` = current stage, then `persist()` and `updateStatus`. If there is a check, start the timer.
- **Result:** ``Waiting for: <reason>. End your turn now; the workflow resumes you when <the check passes | the user replies>.``
- **Plan-phase blocking:** add `"wait_for_user"` and `"deliver"` to the list at `index.ts:446`.

**S8. Polling and resume.**
- **Turn end:** in `onAgentEnd`, right after `if (state.phase !== "execute") return;` (2442), return when `state.waiting` is set. No judge, no delivery, no stage advance.
- **The timer** is one `setInterval` of `cfg.wait.pollMs`. It is cleared when `waiting` clears, in `setPhase` when leaving the flow, in `endFlow` and in `session_shutdown`.
- **Each tick** asks `pollDecision` (`idle` = `lastCtx.isIdle()` and `lastCtx.ui.getEditorText().trim() === ""`):
  - `"stop"` clears the timer. If the cause is `maxMs`, it notifies `workflow: stopped polling "<check>" after <minutes> min; your next message checks again`.
  - `"run"` runs the check.
- **Running the check:** `pi.exec("bash", ["-c", check], { cwd: ctx.cwd, timeout: cfg.wait.checkTimeoutMs })`. It passes only on exit code 0.
- **When the check passes:**
  - With `autoResume`: clear `waiting`, `persist()`, `planMilestone`, then send `workflow-wait` (content: the `resumePrefix(…, "passed")` + "Continue with the open steps of the plan.") with `{ triggerTurn: true, deliverAs: "followUp" }`.
  - Without it: set `waiting.checkPassed = true`, notify `workflow: "<check>" passed; send any message to continue`, and stop the timer.
- **A wait entered at a stage start** (`atStageStart`): the message is the held `stageStart` text with the prefix in front.
- **Typed resume:** in `pi.on("input")` (2304), handle the execute phase while `state.waiting` is set, for user-typed input that is not streaming and not a slash command:
  - Already `checkPassed`, or no check: clear the wait and transform the text with `"passed"` or `"plain"`.
  - Otherwise run the check once:
    - it passes: transform with `"passed"`;
    - it fails, with a UI: `select("Check not passing: <check>", ["Continue anyway", "Keep waiting"])`. "Continue anyway" transforms with `"forced"`. "Keep waiting" notifies, restarts the timer and returns `{ action: "handled" }`;
    - it fails, without a UI: return `handled`.
  - With `atStageStart`, the held stage-start text goes between the prefix and your text.
  - Whenever the wait clears: `persist()`, `planMilestone`, and clear the status.

**S9. Stage-start waits** (`startNextStage`, `index.ts:2500`, and the first stage's start in `startExecution`).
- When the stage starting has `after`, set `state.waiting` (`planned: true`, `atStageStart: true`, `stage`) and keep the stage-start text instead of handing it over.
- Show `workflow: stage <n> waits for: <reason>`.
- Start the timer when there is a check. Resume is as in S8.

**S10. A stage that ends with no changes** (`noChangeStage`, `agent-end.ts:158`).
- New signature: `noChangeStage(judged, hasUI, auto = false, openSteps = 0)`.
- When `!judged && openSteps > 0`, it returns `"ask"` with a UI and `"wait"` without one, even when `auto` is set. Otherwise the behaviour is unchanged.
- `noChangeTurn` (`index.ts:2518`) passes the number of unticked checklist items of the current stage (0 when there is no checklist).

### Stage 3: `deliver` checkpoints and the tag action

**S11. Add `checkpoints.ts` (pure).** It exports:
- **`modeAllowed(mode, cap: Delivery): boolean`**, with the order commit < push < pr < merge; `cap === "off"` gives false.
- **`parseDeliverStep(plan, id)`** returns the step's full line text after `Deliver:`, or null.
- **`isPlannedTag(stepText: string | null, name: string, move: boolean): boolean`**. True when the step text contains `name`. For `move`, it must also contain the word `move` (case-insensitive).
- **`checkpointAmendment(n, { mode?, tag?, reason })`** returns the exact format of section 4.
- **`checkpointText(step | undefined, outcome)`** returns `checkpoint <S|unplanned>: <outcome>`.
- **`withCheckpoints(parts: string[], end: string)`** joins with `; `.
- **`checkpointNote(cps)`** returns `## Checkpoints already delivered\n\n<list>. Their code is committed and is not in this diff; its absence is not a finding.`, or `""` when empty.

**S12. Add `tags.ts` (pure).** It exports:
```ts
tagDecision(o: { planned: boolean; move: boolean; remoteSha?: string; target: string; onDefault: boolean; oldIsAncestor?: boolean })
```
It returns one of:
- `{ action: "create" }`
- `{ action: "move", lease: string }`
- `{ action: "refuse", text: string }`: the result goes to the executor, no wait
- `{ action: "wait", reason: string }`

The rules, in order:
1. `!onDefault` → wait, `commit <target> is not on the remote default branch`.
2. `move && !planned` → refuse, `moving a tag needs a plan step that names it`.
3. Create, no `remoteSha` → create.
4. Create, `remoteSha === target` → refuse, `tag <name> already points at <target>; nothing to do`. This one is reported as ok.
5. Create, `remoteSha` set: planned → wait, `tag <name> taken (points at <sha>)`; unplanned → refuse with the same text plus `pick the next free name`.
6. Move, no `remoteSha` → treated as create.
7. Move, `remoteSha === target` → refuse, `nothing to do`, reported as ok.
8. Move, `!oldIsAncestor` → wait, `moving <name> from <old> to <target> would drop commits`.
9. Otherwise → move with `lease = remoteSha`.

It also exports `pushArgs(remote, name, target, lease?)` returning `["push", remote, "<target>:refs/tags/<name>"]`, or with lease `["push", "--force-with-lease=refs/tags/<name>:<lease>", remote, "<target>:refs/tags/<name>"]`. There is never `--no-verify` or `--force`.

**S13. The `deliver` tool** (`index.ts`, next to `judge` 1974).
- **Refusals:**
  - outside the execute phase;
  - when `stageDelivery(state.delivery ?? default, current stage)` is `off`;
  - when neither `mode` nor `tag` is given;
  - when `mode` is beyond the stage's delivery: ``mode <m> is beyond this stage's delivery (<cap>)``.
- **Planned or not:** a call is planned when `step` is given and `parseDeliverStep` is non-null. An unplanned call appends `checkpointAmendment` (N as in S7) with `refreshChecklist`, `planMilestone` and `persist` before it does anything else.
- **Mode part:**
  1. Collect the flow diff (`collectFlowDiff`). If it is empty, the part reports `no changes to deliver`.
  2. **Gate.** If `state.lastJudge?.hash === diff.hash` and its verdict is PASS, reuse it. Otherwise run `judge()` as the judge tool does (same `stageJudged`, FAIL count, `openStepsReminder`, plan-flaw handling).
  3. A FAIL returns the report and `Not delivered: fix the findings and call deliver again.`
  4. A plan flaw returns the report and the "end your turn" sentence of 2005, without delivering.
  5. On a PASS (minor findings included; no minor-fix round at a checkpoint): ask about unavailable knowledge exactly as `finishPassed` 3019-3026, then `prepareAllRepos`, `runCommitSubagent` (always the subagent, whatever `delivery.runner` says, with the tool's signal) and `readOutcome`.
  6. Afterwards: `committedDiffs.add(hash)`, `state.lastJudge = undefined`, `state.passedDiff = undefined`, `state.stageJudged = false`, and set the view stage back to execute.
- **Tag part** (after the mode part, so a merge lands first):
  1. Find the repo: `tag.repo` matched against the flow repos' roots or basenames; the default is the working folder's repo.
  2. Remote: `origin`, else the first remote.
  3. Read the remote default branch with `git ls-remote --symref <remote> HEAD`, then `git fetch <remote> <branch>`.
  4. Target: `tag.commit` resolved with `rev-parse`, else `<remote>/<branch>`.
  5. `onDefault` comes from `merge-base --is-ancestor <target> <remote>/<branch>`.
  6. `remoteSha` comes from `ls-remote --tags <remote> refs/tags/<name>` (peeled when annotated).
  7. `oldIsAncestor` comes from `merge-base --is-ancestor <remoteSha> <target>`, after fetching that SHA when it is missing locally.
  8. Act on `tagDecision`:
     - **create or move:** run `pushArgs` through `git()`, then best-effort `git fetch <remote> +refs/tags/<name>:refs/tags/<name>` (a failure only adds a note). The text is `tag <name> created at <short>` or `moved <name> from <old> to <new>`.
     - **refuse:** goes into the result.
     - **wait:** sets `state.waiting` (`planned` per the step, no check). The result then says to end the turn, using the S7 wording.
     - **A failed push** (lease rejected, hook failed): treated as a wait with the git error's first line.
- **Recording:** append `{ step, stage, text: checkpointText(...), ok }` to `state.checkpoints`, then `persist()`, `planMilestone(ctx)` and `updateStatus`.
- **Result:** the outcome text, each repo's current branch (`rev-parse --abbrev-ref HEAD`), and `Continue with the next steps in this turn.`

**S14. Outcomes and the judge note.**
- In `summarizeCommit` and `stageWithoutChanges`, build the stage outcome text with `withCheckpoints(<this stage's checkpoint texts>, <delivery text, or "no further changes" when checkpoints exist and nothing else changed>)`. Unstaged flows do the same at flow end. This rule applies everywhere a stage or flow outcome is recorded, including `stageWithoutChanges`.
- At `index.ts:883` and `893`, add `checkpointNote` for the checkpoints of the current stage (all of them in an unstaged flow).
- Arbiter numbering at 2894 uses the shared amendment count; its limit still uses `planRevisions`.

**S15. Prompts** (`prompts.ts`).
- **`EXECUTE_PHASE` line 84** is replaced. The executor still never commits, pushes or opens or merges a PR through its own shell. When the plan has a `Deliver:` step, or it must publish to continue, it calls `deliver` (within the approved delivery; unplanned calls amend the plan). At a `Wait:` step, or when a person must act, it calls `wait_for_user` with a read-only check that proves the step is finished, then ends its turn. At a stage end it still gets the judge's pass and ends its turn.
- **`planPhase` and `finalize`** get one bullet or sentence each:
  - use a checkpoint (`**S<n>.** Deliver: …`) to publish and then continue the same change; use a stage for a separate part;
  - a step a person must do (publish with `updates.bat`, open an Editor) is `**S<n>.** Wait: … (check: …)`, with a check that proves it is finished, for example `git ls-remote --exit-code --tags origin <name>/v<version>` and not `npm view`;
  - a stage that needs one first ends its heading in `(after: …; check: …)`;
  - shared tags such as `unity-build/v*` are created or moved only as a named Deliver step.

### Stage 4: Docs and backlog

**S16. `README.md`.**
- Add sections for wait points (tool, plan syntax, polling, `wait` config, resume, the no-change-stage rule), checkpoints (`deliver`, limit, gate, amendments, outcome text) and the tag action (create, lease and forward-only moves, multi-session behaviour, and that tags only happen when the plan or the executor asks).
- Update the staged-plans bullet (56-65), the `stageAdvance` text (108), the execute-phase rule (119) and the test command (190) with the new test files.

**S17. `docs/workflow-improvements.md`.**
- Add rows A13 (checkpoints), A14 (wait points and stage-start waits) and D14 (the outcome-branch bug, plus the commit-only push instruction), each with a **Done:** note naming its files.
- Update the Status line.
- Add Effect measurement rows:
  - A13: checkpoints per flow and stage counts.
  - A14: replans per original plan; stages ending "no changes" with open steps; how many times you asked "have all stages finished?".
  - D14: "commit step ended without a commit" outcomes where commits exist.

### 6. Tests

New files go into the README test command. The full command runs the existing list from `README.md:190` plus `waits.test.ts checkpoints.test.ts tags.test.ts`, with `node --experimental-strip-types --test …`. Expected: `# fail 0` and every new test passing.

**`delivery.test.ts`**

| Test | Input | Expected |
|---|---|---|
| `outcomeRef uses the branch the commits landed on` | `{ recorded: "master", recordedMoved: false, current: "feat/x", currentAhead: true }` | `"feat/x"` |
| `outcomeRef keeps the recorded branch` | `recordedMoved: true`; or `current === recorded`; or `currentAhead: false`; or `current: "HEAD"` | `undefined` in each case |
| `commit-only instruction forbids chained push` | `deliveryInstruction({ mode: "commit", … })` | contains ``Don't run `git push` in any command`` |
| (same) | mode `push` | does not contain that sentence |
| `merge in progress concludes with one commit` | `mergeInProgress: true` | contains `git commit --no-edit` and no SPLIT text |

**`stages.test.ts`**

| Test | Input | Expected |
|---|---|---|
| `after tag` | `### Stage 2: game-template (after: publish core 0.15.0; check: git ls-remote --exit-code --tags origin com.iecgames.core/v0.15.0)` | title `game-template`; `after.reason` and `after.check` set |
| (same) | with `(delivery: merge)` before or after it | both parsed |
| (same) | `(after: x)` with no check | `check` undefined |

**`agent-end.test.ts`**: `noChangeStage keeps a stage with open steps`.

| Input | Expected |
|---|---|
| `(false, true, true, 2)` | `"ask"` |
| `(false, false, true, 2)` | `"wait"` |
| `(true, true, true, 2)` | `"advance"` |
| `(false, true, true, 0)` | `"advance"` |

The existing cases keep their results.

**`waits.test.ts`**

| Test | Input | Expected |
|---|---|---|
| `parseWaitStep` | `**S7.** Wait: publish core 0.17.0 (check: git ls-remote --exit-code --tags origin com.iecgames.core/v0.17.0)` | the reason and the check |
| (same) | a step whose line is not `Wait:` | null |
| (same) | an unknown ID | null |
| (same) | a step line longer than 120 characters | the full check |
| `waitAmendment` | n = 3 | exact text `## Amendment 3 (executor: wait)\npublish core (step S7) (check: git ls-remote …)` |
| `resumePrefix` | each of the three modes | the exact strings of section 4 |
| `pollDecision` | the stop, hold and run combinations | `stop` when `elapsed >= max`, `hold` when not idle, `run` otherwise |

**`checkpoints.test.ts`**

| Test | Input | Expected |
|---|---|---|
| `modeAllowed` | `push` within `pr` | true |
| (same) | `merge` within `push` | false |
| (same) | any mode within `off` | false |
| `parseDeliverStep` | a `Deliver:` step | its text |
| (same) | any other step | null |
| `isPlannedTag` | create, step text names the tag | true |
| (same) | move without the word `move` in the step text | false |
| (same) | move with `move` in the step text | true |
| `checkpointAmendment` | — | exact text |
| `withCheckpoints` | `["checkpoint S4: pushed"]`, `committed (2 commits)` | `checkpoint S4: pushed; committed (2 commits)` |
| `checkpointNote` | `[]` | `""` |

**`tags.test.ts`**

| Test | Input | Expected |
|---|---|---|
| `tagDecision` | not on the default branch | wait |
| (same) | an unplanned move | refuse |
| (same) | create with a free name | create |
| (same) | create, name taken, planned | wait |
| (same) | create, name taken, unplanned | refuse, with `pick the next free name` |
| (same) | create when the tag already equals the target | refuse, ok text `nothing to do` |
| (same) | move with a non-ancestor old commit | wait |
| (same) | move, forward | move with `lease = remoteSha` |
| `pushArgs` | with and without a lease | the exact arrays of S12; none contains `--no-verify` or `--force` alone |

**`plan-doc.test.ts`**

| Test | Input | Expected |
|---|---|---|
| `planCard shows the wait` | `waiting: "publish core"` | the card contains `### Waiting for\npublish core` |
| `parseStatus waiting and checkpoints` | a status with valid fields | accepted |
| (same) | `waiting.reason` not a string | null |
| (same) | old status without the new fields | still valid |

**`config.test.ts`**

| Test | Input | Expected |
|---|---|---|
| `wait defaults` | missing block | the defaults |
| (same) | `pollMs: -1` | the default |
| (same) | `autoResume: "x"` | `true` |

**`prompts.test.ts`**

| Test | Input | Expected |
|---|---|---|
| `execute prompt names deliver and wait_for_user` | `EXECUTE_PHASE` | contains `deliver` and `wait_for_user`; no longer contains `even when the plan says to` |
| (same) | `planPhase("auto")` and `finalize(...)` | contain `Deliver:` and `Wait:` |

### 7. Done when

- The executor can deliver (commit, push, PR, merge) inside its turn through `deliver`. The delivery is gated by a judge PASS, never goes beyond the approved stage delivery, and continues the same stage. Unplanned checkpoints amend the plan.
- The executor can wait for a person through `wait_for_user`, and a stage heading can declare a wait. The flow keeps its plan, stage and ticks, and resumes when the check passes (polled, auto-resume when idle) or when you reply. Unplanned waits amend the plan. The wait survives `/flow resume`.
- A stage with no changes, no judge call and open steps never auto-advances.
- Tags are pushed only for a plan step or an executor request:
  - a create never overwrites;
  - a move needs a named plan step, a lease on the recorded SHA and an old commit that is an ancestor of the new one;
  - the target is on the remote default branch;
  - `--no-verify` is never used;
  - a lost race waits instead of overwriting.
- A commit step that commits on a new branch is reported with its commits. A commit-only instruction forbids a chained `git push`.
- Stage and flow outcomes list the checkpoints. The judge is told which checkpoints were delivered earlier.
- Behaviour without the new tools is unchanged. All existing and new tests pass, and the README and the backlog match the code.

### 8. Risks, rollback, and what not to touch

**Risks**
- **S1 touches the main delivery path.** Keep side effects and their order identical, and run the full suite after Stage 1.
- **A checkpoint commit subagent runs inside a tool call.** Make sure `commitSubagentRunning` is set while it runs, so `onAgentEnd` doesn't summarize.
- **Polling while you type.** It is guarded by `isIdle` and the editor-text check.
- **Lease semantics on tags differ per host.** A rejected lease only waits.

**Rollback**
- Revert the stage commits. `wait.autoResume: false` turns automatic resume off without a code change.

**Do not touch**
- The push guard's executor rules; `commit-guard.ts` rules apply unchanged.
- The K4 event payload.
- The worktree extension (`boundary.test.ts`).
- Other repos, and `updates.bat`.

### 9. Commits

Tests go with the code they test.

1. **`workflow: split delivery into prepare, commit step and outcome`** — `index.ts`
2. **`workflow: report commits on the branch they landed on; commit-only forbids chained push`** — `delivery.ts`, `delivery.test.ts`, `index.ts` (`repoOutcome`, `prepareDelivery`)
3. **`workflow: wait points with polled checks and resume`** — `waits.ts`, `waits.test.ts`, `stages.ts`, `stages.test.ts`, `plan-doc.ts`, `plan-doc.test.ts`, `config.ts`, `config.test.ts`, `index.ts`
4. **`workflow: keep stages with open steps from auto-advancing`** — `agent-end.ts`, `agent-end.test.ts`, `index.ts` (`noChangeTurn`)
5. **`workflow: deliver checkpoints inside the executor's turn`** — `checkpoints.ts`, `checkpoints.test.ts`, `index.ts`
6. **`workflow: tag create and lease-guarded forward moves`** — `tags.ts`, `tags.test.ts`, `index.ts`
7. **`workflow: prompts for checkpoints, waits and tags`** — `prompts.ts`, `prompts.test.ts`
8. **`docs: workflow wait points, checkpoints and tags`** — `pi/agent/extensions/workflow/README.md`, `docs/workflow-improvements.md`

<!-- pi-workflow:status -->
## Checklist
- [x] S1 Split delivery into three reusable functions in `index.ts` (anchors `finishPassed` 3010, `commitInSubagent` 3157, `summa
- [x] S2 Read commits from the branch they landed on (D14).
- [x] S3 Commit-only instruction (`deliveryInstruction`, `delivery.ts:80`).
- [x] S4 Add `waits.ts` (pure). It exports:
- [x] S5 Stage `after` tag (`stages.ts:13-46`).
- [x] S6 Waiting state, status and plan card.
- [x] S7 The `wait_for_user` tool (`index.ts`, modelled on `plan_check` 1899).
- [x] S8 Polling and resume.
- [x] S9 Stage-start waits (`startNextStage`, `index.ts:2500`, and the first stage's start in `startExecution`).
- [x] S10 A stage that ends with no changes (`noChangeStage`, `agent-end.ts:158`).
- [x] S11 Add `checkpoints.ts` (pure). It exports:
- [x] S12 Add `tags.ts` (pure). It exports:
- [x] S13 The `deliver` tool (`index.ts`, next to `judge` 1974).
- [x] S14 Outcomes and the judge note.
- [x] S15 Prompts (`prompts.ts`).
- [x] S16 `README.md`.
- [x] S17 `docs/workflow-improvements.md`.
## Outcome
2026-10-21T18:57:47.316Z — ok: stage 1: committed (2 commits), pushed; stage 2: committed (2 commits), pushed; stage 3: committed (5 commits), pushed; stage 4: committed (1 commit), pushed
