<!-- pi-workflow plan v1 flow=20261113-2312-automatic-judge-gates-for-the-discussion-ba4c -->
## Plan: Automatic judge gates for the discussion and the plan

### Goal and non-goals
**Goal**
- **Discussion gate.** When you move from discuss to plan ("go", `/flow plan`, `/flow approve`), the judge checks the last `Agreed so far:` list first.
  - The discuss model fixes the `fix: auto` findings, with up to 2 judge runs.
  - A `fix: user` finding pauses the gate and comes to you.
- **Plan judge.** Before the approval menu or `workflow:plan-ready`, the judge checks the plan against its spec and the code.
  - The planner fixes the `fix: auto` findings, with up to 3 runs.
  - The `fix: user` findings and whatever is still open at the cap go to the menu, or to the orchestrator in a sub.
- **Orchestra.** The orchestrator sees the sub's plan-judge result in the plan file and in the `plan-review` text. Its board shows "(judging plan)".

**Non-goals**
- No judge at `orch_accept`.
- No advisor gates.
- No change to the execute judge loop, `workflow/merge-gate.ts`, the drift and diff-base code, or the stage-empty and wait code (D42, D43).
- No gates in the quick profile.

### User decisions
- **D1.** The gates use the judge, not the advisor. Both reuse the `judge` role.
- **D2.** Every finding keeps its category tag and gets a second tag, `fix: auto|user`. A finding without it counts as `user`. Both judges use the same output format.
- **D3. The discussion gate runs automatically** on "go", `/flow plan` and `/flow approve` (from discuss) when an `Agreed so far:` list exists. Without a list it warns and moves on.
  - **Skip:** it is skipped only when the last review was a clean PASS on the same list hash. Clean means PASS with no findings, the same definition the queued "go" uses.
  - **Recheck instead of a full pass:** used when an earlier review exists.
- **D4. Discussion loop:**
  - Findings of every severity are sent to the discuss model (`triggerTurn: true`).
  - At the next `agent_end`, a new list (a different hash) starts a recheck. No new list, or a reply that ends in a question, pauses the gate.
  - Any `fix: user` finding pauses the gate, also at the cap.
  - The cap is 2 runs. It moves to plan only when every open finding is `fix: auto`, and those findings go into the kickoff.
  - A second "go" during a run only shows a notice. Other typed text cancels the gate.
- **D5. Plan judge:**
  - **Spec:** the agreed list, else the brief (sub), else none (`spec: none`).
  - **Loop:** `fix: auto` findings of every severity are sent to the planner, with up to 3 runs. `fix: user` findings are held. A round with only `fix: user` findings ends the loop.
  - **Recheck input:** the previous findings, the planner's `Disputes:` section and a plan text diff.
  - **Stale verdicts:** a verdict counts only for the plan hash it judged.
  - **After the cap:** a changed plan gets one confirm run, with no fix loop.
- **D6. "go" during the plan judge waits for the loop.** A clean PASS approves. Anything else opens the menu with the open findings. Without a running gate, "go" approves as today.
- **D7. Cancel:**
  - Three ways: Esc (`ctx.ui.onTerminalInput`, registered only during a run), a typed message, and `/flow judge cancel`.
  - All three abort through `runRole`'s `signal`. An aborted run counts no round and drops a queued "go".
- **D8. Persistence:**
  - Rounds, hashes and findings are kept in the state entry.
  - A run in progress, a queued "go" and the `awaiting-fix` flag are dropped on restart.
- **D9. Idle:**
  - While a judge runs, `idleDue` and the local idle notice are held back.
  - K4 gets an optional `judging`.
  - The sub's status file and the board show "(judging plan)".
- **D10. Orchestra:**
  - The brief is the sub's spec.
  - K10 gets an optional `judge` field.
  - Open findings go to the orchestrator: a section in the plan file and a line in `plan-review`.
- **D11. Config:**

  | Key | Values | Default |
  |---|---|---|
  | `autoJudgeDiscussion` | `"off"` / `"auto"` | `"auto"` |
  | `autoJudgePlan` | `"off"` / `"auto"` | `"auto"` |
  | `maxDiscussionJudgeRounds` | integer | 2 |
  | `maxPlanJudgeRounds` | integer | 3 |

  The quick profile turns both gates off.
- **D12. A judge failure never blocks.** The flow goes on with a note, and K10 gets `ran: false`.
- **D13. Backlog rows** in `docs/workflow-improvements.md`:
  - D45: discussion gate.
  - D46: plan judge.
  - D47: K10 `judge`, K4 `judging` and the board.
- **D14. Tests:**
  - the pure `gates.ts` cases listed below;
  - `idleDue`;
  - source-scan wiring tests in both extensions;
  - the orchestrate view and plan-review helpers;
  - your end-to-end run (Verify steps).

Merge points: none. The single PR is merged at the end of the flow.

Stages:
1. **Plan judge (workflow):** the pure gate core, the plan prompts, config, idle and K4/K10 fields, cancel and `/flow judge` in plan.
2. **Discussion gate (workflow):** the discussion gate state machine and its wiring, the `fix:` tag in the discussion prompt, skip and recheck.
3. **Orchestra side:** K10 `judge` in the plan file and `plan-review`, `judging` in the status file and board.

### Facts the executor needs (paths under `pi/agent/extensions/`)
**Workflow, `workflow/index.ts`:**
- State interface `FlowState` at :111. `persist()` at :419 writes it with `appendEntry(STATE_ENTRY, state)` (:424).
- `emitStatus()` builds the K4 payload at :543-560 and emits only when the payload changed.
- Idle:
  - `scheduleIdleClaim` at :345-354 calls `idleDue(...)`.
  - `scheduleIdleNotice` at :380-392 holds the local notice check at :387.
- `setPhase` at :626-689 resets `planReady`, `planDraft` and the rest at :632-635. `sendPlanKickoff()` is at :691-693.
- `runRole(role, label, opts)` at :818 already accepts `signal` and `thinking`. Rechecks use `cfg.judge.recheckThinking` (see :1990).
- Input handler, `pi.on("input")` at :3183:
  - The discuss "go" is at :3217-3221.
  - The plan "go" is at :3222-3227.
  - It returns `{ action: "handled" | "continue" | "transform" }`.
- `agent_end`:
  - `onAgentEnd` returns at :3338 when `!ctx.hasUI`.
  - The plan branch is :3341-3413.
    - `addPlanReply` is at :3346 and `canApprove` at :3349.
    - `approvalBlock` is at :3362.
    - The K10 emit and the review route are at :3364-3383. The orchestrator-reject branch is at :3375-3376.
    - The menu, built with `askUser` (:315), is at :3384-3412.
- `reviewDiscussion` is at :3585-3621:
  - it uses `branchTranscript` (:3596), `lastAgreedList` and `discussionReviewPrompts`;
  - it posts customType `workflow-discussion-review` with `triggerTurn: false`.
- Start-plan sends `START_PLAN_PREFACE + req.brief` at :4180-4184, and no state holds the brief.
- `/flow` handler at :4392:
  - it splits `sub, ...rest` at :4393;
  - `plan`/`discuss` are at :4401-4413, `approve` at :4415-4422, and `judge` at :4511-4514.

**Workflow, other files:**
- `workflow/agent-end.ts`:
  - `canApprove`, with the private `ENDS_IN_QUESTION`, is at :74-76.
  - `addPlanReply` (:88-94) keeps only the text from `## Plan:` or `## Plan changes` onwards, so text before the heading never enters the plan.
  - `composePlan` is at :104.
- `workflow/asks.ts:131`: `idleDue(o)`.
- `workflow/discussion-review.ts`: `lastAgreedList` :8, `discussionVerdict` :16 (PASS whenever there is no FAIL), `discussionReviewPrompts` :20.
- `workflow/prompts.ts`: `JUDGE_DISCUSSION` :161-181 (finding format at :176), `PLAN_KICKOFF` :103.
- `workflow/config.ts`: the interface is at ~:70-160 and `DEFAULTS` at ~:165-225. Validation follows the pattern at :278 and :302-304, and the judge config is at :138-142 / :206-211.
- pi API: `ctx.ui.onTerminalInput(handler)` returns an unsubscribe function, and the handler may return `{ consume: true }` (`pi-coding-agent/dist/core/extensions/types.d.ts:54-57,93`).

**Orchestrate:**
- `orchestrate/index.ts`:
  - `writeMyStatus` :179-195 copies K4 into `Status`.
  - The K4 listener is at :213.
  - `handlePlanReady` :238-251 writes `plan-<n>.md` and posts `plan-review` with `{ file, n }`.
  - The `plan-review` event text is at :953.
  - The `orch_review_plan` parameters are around :1600-1610.
  - `table()` is at :1319-1328.
- `orchestrate/store.ts:21-31`: `Status` has no `judging`.
- `orchestrate/view.ts`: `ViewSub` :31-40, `buildView` sets `phase` at :144, the board row is at :210 and `detailOf` at :227.
- Orchestrate must not import from `workflow/` (`orchestrate/boundary.test.ts`).
- Next free backlog ID: D45. The doc has the Status line (:5), the D table ending at :159, and Effect measurement (:161, rows up to :241).

### Design
**Components:**
- **`workflow/gates.ts` (new, pure, no I/O)** holds every decision. `index.ts` only runs judges, sends messages and keeps runtime handles.
- **The runtime handle in `index.ts`** (not persisted) is `gateRun?: { kind: "discussion" | "plan"; controller: AbortController; offEsc?: () => void; queuedGo: boolean; judgedHash: string; reason?: "esc" | "command" | "message" | "phase" | "restart" }`. Only one runs at a time.
- **Persisted in `FlowState`:**
  - `discussionReview?: { listHash: string; verdict: "PASS" | "FAIL"; findings: Finding[]; afterEntryId?: string; rounds: number; status: "idle" | "awaiting-fix" | "paused" }`. On restore, `awaiting-fix` becomes `idle`.
  - `planGate?: { planHash: string; rounds: number; verdict?: "PASS" | "FAIL" | "cancelled" | "error"; autoFindings: Finding[]; userFindings: Finding[]; judgedPlan?: string; cappedHash?: string; spec: "agreed" | "brief" | "none" }`.
  - `planSpec?: { kind: "brief"; text: string }`.

**Contracts:**
- **Finding line** (both judges):

  ```
  - blocker|major|minor - [category] fix: auto|user - text
    Why: …
    Fix: …
  ```

  The text ends with `VERDICT: PASS|FAIL`.

  ```ts
  type Finding = { severity: "blocker"|"major"|"minor"; category: string; route: "auto"|"user"; head: string; body: string }
  ```

  A clean result is `verdict === "PASS" && findings.length === 0`.
- **K4:** adds optional `judging?: "discussion" | "plan"`.
- **K10:** adds optional `judge?: { ran: boolean; verdict: "PASS"|"FAIL"|"cancelled"|"error"; rounds: number; spec: "agreed"|"brief"|"none"; findings: string[]; userFindings: string[] }`.
  - The version stays 1.
  - Leave the field out when `autoJudgePlan` is `off`, in quick, or when the plan is blocked.
  - Each string is a finding's head line plus its body.
- **K13:** is not emitted while `gateRun` is set.
- **New customTypes:**
  - `workflow-plan-fix` and `workflow-discussion-fix` (both `triggerTurn: true`);
  - `workflow-plan-judge` (display only, `triggerTurn: false`), the report of each plan-judge run.
- **Planner disputes:** a `Disputes:` block placed *before* the `## Plan` heading of the reply, so `addPlanReply` leaves it out of the plan.

**Failure handling:**
- **Judge error:** it counts no round.
  - In the plan judge: the plan is offered with `ran: false, verdict: "error"` and the note "plan judge did not run: <error>".
  - In the discussion gate: it moves to plan with a note.
- **Stale verdict:** the phase changed, or the hash of the current plan or list differs from `judgedHash`. The verdict is thrown away silently and counts no round.
- **Phase change during a run:** `setPhase` aborts with reason `phase`. No menu and no message.

**Scale:**
- **Plan diff:** an LCS line diff. Plans are about 100-600 lines, so up to about 360k cells.
  - Above 4M cells, or a diff output over 400 lines, it falls back to a full plan run.
- **Discussion recheck input** is about 15-45k chars: the previous findings, the transcript since the last review (capped at 30k chars), and the list. Over the cap it does a full pass.
- **Time per judge run:**

  | Run | Time |
  |---|---|
  | Full pass | 1-3 min |
  | Recheck | 30-90 s |

- **Limit:** a plan over about 2,000 lines makes every recheck a full run. That only costs time.

**Rejected:**
- the advisor as a gate (no verdict);
- the orchestrator judging sub plans itself (its context grows, and it is a hop away from the planner);
- auto-resolving `fix: user` findings;
- a second diff judge at accept;
- awaiting the judge inside the `input` hook or `agent_end`: the gates run as detached promises (`void run…()`), like the K10 answer at :3369, so input keeps flowing.

### Stage 1: Plan judge (workflow)

**S1. Create the pure helpers in `workflow/gates.ts` (new file).** Export:
- **`parseFindings(text): Finding[]`.**
  - It reads finding head lines matching `^- (blocker|major|minor) - \[([^\]]+)\]`. A `fix: auto|user` tag anywhere on the head line is case-insensitive.
  - A missing tag means `user`.
  - A finding's body is the following indented or `Why:`/`Fix:` lines, up to the next head line or `VERDICT:`.
  - Other text is ignored.
- **`isClean(verdict, findings)`.**
- **`textHash(s)`:** sha1 of the trimmed text, with CRLF normalised to LF.
- **`planTextDiff(prev, next, cap = 400): string | null`.**
  - A line LCS with 2 lines of context, marked with `+`, `-` and ` ` prefixes, and `@@` separators between hunks.
  - It returns null when `prev.lines × next.lines > 4_000_000` or the output exceeds `cap` lines.
- **`planDisputes(reply): string | undefined`:** the text from a line that starts with `Disputes:` up to the first `## Plan` heading or the end.
- **`isEscKey(data)`:** true only for `"\x1b"` and the kitty form `"\x1b[27u"`.
- **`planGateDecide(o: { mode: "off"|"auto"; quick: boolean; planHash: string; gate?: PlanGate }): "off" | "reuse" | "confirm" | "recheck" | "full"`.**

  | Case | Result |
  |---|---|
  | Mode off, or quick | `off` |
  | `gate.planHash === planHash` with a verdict other than `cancelled` | `reuse` |
  | `gate.cappedHash` is set and differs from the plan hash | `confirm` |
  | `gate.judgedPlan` is set | `recheck` |
  | Otherwise | `full` |

- **`planGateAfterVerdict(o: { verdict; findings; rounds; max; confirm: boolean }): { action: "offer" | "fix"; auto: Finding[]; user: Finding[]; capped: boolean }`.**
  - `rounds` already includes this run.
  - A clean result offers.
  - `fix` when the run is not a confirm run, there are auto findings and `rounds < max`.
  - Otherwise it offers. `capped` is `rounds >= max`.
- **`planOfferAction(o: { clean: boolean; queuedGo: boolean }): "approve" | "offer"`.**
- **`planReadyJudge(gate, ran): K10Judge`:** builds the K10 field from the gate, using the D10 shape.
- **`planGateReset(gate, why: "enter-plan" | "rejected"): PlanGate | undefined`.**
  - `enter-plan` returns undefined.
  - `rejected` keeps `judgedPlan` and the findings, and sets `rounds = 0` and `cappedHash = undefined`.
- **`menuJudgeLines(gate, note?): string[]`:** the menu detail lines.
  - "Plan judge: PASS (N runs)";
  - "Plan judge: K open findings after the cap", then the heads;
  - "Needs your decision:", then the user heads;
  - "spec: none" when there is no spec;
  - the note text, for "plan judge cancelled" and "did not run: …".

Model the style on `workflow/hooks.ts` (small pure exports, with doc comments).

**S2. Add the plan prompts and the `fix:` tag in `workflow/prompts.ts`.**
- **`JUDGE_PLAN`** (modelled on `JUDGE_DISCUSSION` :161) is an adversarial plan reviewer with read-only tools and a budget of about 15 tool calls. It checks that:
  - every spec item is covered by a step (skip this check when told "no agreed spec");
  - file:line references and claims about the code are true;
  - every caller or user of a changed interface is listed;
  - each change has a test or a check;
  - no step contradicts another;
  - the order works, with dependencies first;
  - migration and rollback are covered where data changes;
  - nothing is out of scope.

  Its output is exactly the contract format. It tags `fix: user` only when a finding needs a decision the spec does not settle.
- **`JUDGE_PLAN_RECHECK`:** for each previous finding the judge reports fixed, still open or disputed (it judges whether the dispute holds). It also reports new problems, but only in the changed lines. It uses the same output format.
- **`PLAN_FIX`:** tells the planner to fix the listed findings, reply with the whole `## Plan:` or `## Plan changes` sections, and put any `Disputes:` block (finding and evidence) *before* the plan heading.
- **`NO_SPEC_NOTE`:** "No agreed spec: judge the plan against the code and for internal consistency; do not report a missing spec."

Add exported `planReviewPrompts(o: { plan, spec?: { kind, text }, folders, recheck?: { findings: Finding[]; disputes?: string; diff: string } }): string[]` to `gates.ts`. The full form returns `[JUDGE_PLAN, spec section or NO_SPEC_NOTE, folders, "## Plan under review", plan]`. The recheck form uses `JUDGE_PLAN_RECHECK` with the previous findings, the disputes, the diff and the whole plan. Model it on `discussionReviewPrompts` (`discussion-review.ts:20`).

**S3. Add the config keys in `workflow/config.ts`.**
- Add `autoJudgeDiscussion` and `autoJudgePlan` (`"off" | "auto"`, default `"auto"`), `maxDiscussionJudgeRounds` (2) and `maxPlanJudgeRounds` (3) to the interface and `DEFAULTS`.
- Validation:
  - an unknown mode falls back to the default;
  - a round count must be an integer of at least 1, or it falls back to the default (pattern at :278 and :303).

**S4. Hold back idle while a judge runs (`workflow/asks.ts:131`).**
- `idleDue` gets `judging: boolean` and returns false when it is set.
- In `index.ts`:
  - pass `judging: !!gateRun` at :350;
  - in `scheduleIdleNotice` at :387, return while `gateRun` is set.
- When a gate run ends and the session is idle, call `scheduleIdleNotice(ctx)`. This is model of the existing reschedule at :388.

**S5. Add K4 `judging` (`index.ts` `emitStatus` :546-554).**
- Add `...(gateRun ? { judging: gateRun.kind } : {})`.
- Call `emitStatus()` when a run starts and ends.
- The footer (`updateStatus`) shows "judging plan (run N/max)" or "judging discussion (run N/max)" while a run is active.

**S6. Add the state fields and resets (`index.ts`).**
- Add `planGate` and `planSpec` (and, in Stage 2, `discussionReview`) to `FlowState` (:111) with doc comments.
- In `setPhase` (:626):
  - when a gate run is active and its phase is being left, abort it with reason `phase`;
  - when `phase === "plan"` and the previous phase was not plan, set `state.planGate = planGateReset(state.planGate, "enter-plan")` and `state.planSpec = undefined`.
- At start-plan (:4180-4182), set `state.planSpec = { kind: "brief", text: req.brief }` after `setPhase` and before `persist()`.
- On restore of the saved state, nothing else is needed: `gateRun` is runtime only.

**S7. Wire the plan gate (`index.ts`).**
- **Extract `offerPlan(ctx, text, blocked, judge?: { gate?: PlanGate; note?: string; ran: boolean })`.** It holds today's :3364-3412 unchanged in behaviour.
  - The K10 payload gets `judge: planReadyJudge(...)` only when `judge` is given.
  - The menu `detail` gets `menuJudgeLines` before the existing text.
- **In the plan branch, after :3363**, when `planReady && !blocked`, compute `planGateDecide`:
  - `off`: call `offerPlan` as today.
  - `reuse`: offer with the stored gate.
  - Otherwise: `void runPlanGate(ctx, text, emitted, decision)` and return.
- **`runPlanGate`:**
  1. Abort any running gate (`restart`).
  2. Create `gateRun` with an `AbortController`.
  3. If `ctx.hasUI`, register `ctx.ui.onTerminalInput(d => isEscKey(d) ? (abort("esc"), { consume: true }) : undefined)`.
  4. Resolve the spec: `planSpec`, else `lastAgreedList` over the branch's assistant texts (same extraction as :3586-3595), else none.
  5. Build the prompts with `planReviewPrompts`. A recheck uses `planTextDiff(gate.judgedPlan, plan)`, and a null diff falls back to a full run. Disputes come from `planDisputes(lastReplyText)`.
  6. Run `runRole("judge", "plan review", { systemPrompts, tools: cfg.judge.tools, task: "Review the plan as described in your system prompt.", cwd: ctx.cwd, signal, thinking: recheck ? cfg.judge.recheckThinking : undefined })`.
  7. Show it in the flow view like :3604-3615, and post `workflow-plan-judge`.
  8. In `finally`: call `offEsc`, clear `gateRun`, `emitStatus()`, and reschedule idle.
- **After the run:**
  - **Aborted:**
    - with reason `message` or `phase`: do nothing more;
    - with reason `esc` or `command`: the gate gets `verdict: "cancelled"` and the plan is offered with note "plan judge cancelled" and `ran: false`. In a sub, `offerPlan` emits K10 `judge { ran: false, verdict: "cancelled" }` through the same path.
  - **Stale** (the phase is not plan, or `textHash(composePlan(planDraft)) !== judgedHash`): discard.
  - **Error:** offer with `ran: false`, `verdict: "error"`.
  - **Otherwise:**
    1. Increment `rounds`, except on a confirm run.
    2. Store `planHash`, `verdict`, the findings, `judgedPlan` and the spec, and persist.
    3. Apply `planGateAfterVerdict`:
       - `fix`: send `workflow-plan-fix` (PLAN_FIX plus the auto findings only), `{ triggerTurn: true, deliverAs: "followUp" }`.
       - `offer`: set `cappedHash` when `capped`. Then apply `planOfferAction`: `approve` calls `approve(lastCtx ?? ctx)` with the same notify as :3373, and `offer` calls `offerPlan`.
- **Orchestrator reject (:3375):** set `state.planGate = planGateReset(state.planGate, "rejected")` and persist before sending the revise message.

**S8. Input and commands (`index.ts`).**
- **Input handler,** before :3224, in plan with a `gateRun` of kind `plan` and typed (non-extension, non-streaming) input:
  - `approveRe()` matches: set `queuedGo = true`, notify "approval queued: plan judge running (run N/max)", return `handled`.
  - Any other non-`/` text: abort with reason `message` and return `continue`.
- **`/flow judge` (:4511):**
  - First, `rest[0] === "cancel"`: abort the running gate with reason `command`. If no gate is running, notify "workflow: no judge running".
  - In plan:
    - with `planDraft.full` set: start `runPlanGate` with a `recheck` or `full` decision (a `reuse` hash is judged again with `full`). Rounds are unchanged; a manual run counts as a normal run.
    - without a plan: notify "no plan to judge yet".
  - Discuss and execute stay as they are.
  - Add `judge cancel` to `SUBCOMMANDS` completions if that list holds descriptions.

**S9. Tests for Stage 1.**
- **New `workflow/gates.test.ts`:**
  - `parseFindings`:
    - auto and user tags;
    - a missing tag gives user;
    - the category is kept;
    - a body with Why and Fix;
    - non-finding text is ignored.
  - `isClean`: a PASS with findings is not clean.
  - `planTextDiff`:
    - added, removed and changed lines;
    - identical input gives an empty diff;
    - over the cap or the cell limit gives null.
  - `planDisputes`: a block before `## Plan`; none present.
  - `isEscKey`: `\x1b` is true; `\x1b[A` and `a` are false.
  - `planGateDecide`: off and quick; reuse on the same hash; a cancelled hash is not reused; confirm after the cap; recheck; full.
  - `planGateAfterVerdict`:
    - clean offers;
    - auto findings fix while under max;
    - only user findings offer;
    - mixed findings fix with auto only and keep the user ones;
    - at the cap it offers with `capped`;
    - a confirm run never fixes.
  - `planOfferAction`: queued with clean approves; queued with findings offers; not queued offers.
  - `planReadyJudge`: the shape, including `ran: false` with cancelled and error, and `spec: none`.
  - `planGateReset`: enter-plan clears; rejected resets rounds and cap and keeps the findings.
  - `planReviewPrompts`: the no-spec note; the brief section; recheck carries the findings, disputes and diff.
  - `menuJudgeLines`.
- **`asks.test.ts`:** `idleDue` is false with `judging: true` in plan and in execute.
- **`config.test.ts`:** the defaults, an invalid mode and an invalid count fall back.
- **New `workflow/gate-wiring.test.ts`** (source scan of `index.ts`, modelled on `orchestrate/wiring.test.ts`):
  - `runPlanGate` passes `signal` to `runRole`;
  - `offEsc` is called in a `finally`;
  - `idleDue({` gets `judging`;
  - the `judge` case handles `cancel` before the phase dispatch;
  - the plan branch calls `planGateDecide` before `offerPlan`;
  - the reject branch calls `planGateReset(`;
  - start-plan sets `planSpec`.

**S10. Docs for Stage 1.**
- **`workflow/README.md`:**
  - "The plan, the judge and the arbiter" (:108) gets a "Plan judge" subsection: behaviour, cancel, queued "go", config keys.
  - K4 (:243) gets `judging`.
  - K10 (:249) gets the `judge` field.
  - K13 (:253) gets "not emitted while a judge gate runs".
  - "Commands" (:346) gets `/flow judge` in plan and `/flow judge cancel`.
- **`docs/workflow-improvements.md`:**
  - add rows D45 (discussion gate, "planned, Stage 2"), D46 (plan judge, **Done:** `gates.ts`, `index.ts`) and D47 (K10 `judge` and K4 `judging`; "workflow side done, orchestrate side Stage 3");
  - add matching Effect measurement rows. D46: count `workflow-plan-judge` runs per flow and the open findings at the cap, compared with arbiter amendments per flow. D45: count discussion-gate pauses and fix rounds. D47: count plan-review items with open findings that the orchestrator rejected.
  - update the Status line.

**S11. Run the Stage 1 tests** (see Tests). The full suite may only fail in the known `publish.test.ts`.

### Stage 2: Discussion gate (workflow)

**S12. Add to `gates.ts`:**
- **`discussionGateStart(o: { mode; quick; listHash?: string; last?: DiscussionReview; sinceChars: number; cap: number }): "move" | "warn-move" | "full" | "recheck"`.**

  | Case | Result |
  |---|---|
  | Mode off, or quick | `move` |
  | No list | `warn-move` |
  | `last` was clean on the same hash | `move` |
  | `last` exists, `last.afterEntryId` was found, and `sinceChars <= cap` | `recheck` |
  | Otherwise | `full` |

- **`discussionGateAfterVerdict(o: { verdict; findings; rounds; max }): "move" | "fix" | "pause" | "move-open"`.**

  | Case | Result |
  |---|---|
  | Clean | `move` |
  | Any user finding | `pause` (also at the cap) |
  | Auto only, `rounds < max` | `fix` |
  | Auto only, at the cap | `move-open` |

- **`discussionGateAfterFixReply(o: { prevListHash; replyListHash?: string; reply: string }): "recheck" | "pause"`.**
  - It is `pause` when there is no list, the list is unchanged, or the reply ends in a question.
  - Export `ENDS_IN_QUESTION` from `agent-end.ts` (or add `endsInQuestion(text)` there) and reuse it. Don't copy the regex.
- **`discussionGateOnInput(o: { running: boolean; isGo: boolean }): "notice" | "cancel" | "pass"`.**
- **`discussionRecheckPrompts(findings, since, list, folders)`:** uses a new `JUDGE_DISCUSSION_RECHECK` prompt (in `prompts.ts`) that reports each previous finding as fixed, still open or disputed, plus new problems in the new list. Same output format.

**S13. Prompts (`workflow/prompts.ts`).**
- In `JUDGE_DISCUSSION`, change the format line at :176 to the contract head line with `fix: auto|user`. Add the rule: `auto` when the model can settle the finding by checking the code or the transcript; `user` when only the user can decide it.
- Add `DISCUSSION_FIX`: fix the listed findings by checking the code, reply with a revised `Agreed so far:` list, and ask the user only when a finding needs their decision.
- `sendPlanKickoff(open?: Finding[])` appends "Open discussion-judge findings the plan must address:" plus the heads when `open` is given.

**S14. Wire the discussion gate (`index.ts`).**
- **`startDiscussionGate(ctx)`** replaces the direct move at the discuss "go" (:3217-3221), at `/flow plan` from discuss (:4409-4412) and at `/flow approve` in discuss (:4416-4420).
  1. Find the list with `lastAgreedList`.
  2. Find the turns since the last review: the branch entries after `discussionReview.afterEntryId`. Use the entry `id` field. If the id is missing from the branch, do a full pass.
  3. Apply `discussionGateStart`:
     - `move`: as today, `setPhase(plan)`, `sendPlanKickoff()` and notify.
     - `warn-move`: the same, plus the warning "no Agreed so far: list: discussion judge skipped".
     - `full` / `recheck`: reset `rounds` to 0 (each new gate starts fresh) and `void runDiscussionGate(...)`.
  - The input handler returns `handled` for "go". The user's "go" text is not forwarded; the kickoff message replaces it.
- **`runDiscussionGate`:**
  - The `gateRun` handling, Esc, `signal`, view, `finally` and stale check are the same as S7. The stale check compares the list hash.
  - A full pass reuses `discussionReviewPrompts`; a recheck uses `discussionRecheckPrompts` with the since-transcript (`branchTranscript` over those entries, 30k cap).
  - Post `workflow-discussion-review` (`triggerTurn: false`) as today.
  - Store `discussionReview`: hash, verdict, findings, `afterEntryId` = the id of the last branch entry after posting, `rounds + 1`.
  - Then apply `discussionGateAfterVerdict`:
    - `move`: `setPhase(plan)` and `sendPlanKickoff()`.
    - `move-open`: the same, with `sendPlanKickoff(open)`.
    - `fix`: set status `awaiting-fix` and send `workflow-discussion-fix` (DISCUSSION_FIX + all findings, `triggerTurn: true`).
    - `pause`: set status `paused` and notify "discussion judge: N findings need your decision". The findings are already in the posted review.
  - **Error:** move to plan with the note "discussion judge did not run: …".
  - **Abort:** you stay in discuss. A `message` abort passes the text on.
- **`agent_end` in discuss:** add a branch before :3341. When `discussionReview.status === "awaiting-fix"` and the turn stopped normally, apply `discussionGateAfterFixReply`:
  - `recheck`: `void runDiscussionGate(ctx, "recheck")`, rounds not reset.
  - `pause`: set status `paused` and notify.
- **Input in discuss** while `gateRun?.kind === "discussion"`: apply `discussionGateOnInput`:
  - `notice`: notify "discussion judge running", `handled`.
  - `cancel`: abort with reason `message`, `continue`.
- **Manual `/flow judge` in discuss:** it calls the same full pass but never starts the loop. It stores `discussionReview` (status `idle`) so a later "go" can skip or recheck. Refactor `reviewDiscussion` (:3585) into this shared runner and keep its current output.
- **Persist and restore:** `discussionReview` is in `FlowState`. On restore, `awaiting-fix` becomes `idle`; add this to `migrateSavedState` (`agent-end.ts:159`) or to the restore point next to it.
- **`/flow judge cancel`** also aborts a discussion run.

**S15. Tests for Stage 2.**
- **`gates.test.ts` adds:**
  - `discussionGateStart`:
    - off and quick move;
    - no list gives warn-move;
    - a clean PASS on the same hash moves;
    - **a PASS with one `fix: auto` minor on the same hash does not skip** (recheck);
    - a FAIL on an older hash rechecks;
    - an over-cap since-text or a missing entry id gives full.
  - `discussionGateAfterVerdict`:
    - clean moves;
    - auto findings under max fix;
    - user findings pause;
    - user findings at the cap pause;
    - auto findings at the cap give move-open.
  - `discussionGateAfterFixReply`: a new list rechecks; no list pauses; the same list pauses; a question pauses.
  - `discussionGateOnInput`: go while running gives a notice; text while running cancels; not running passes.
  - `discussionRecheckPrompts` carries the findings, the since-text and the list.
  - `JUDGE_DISCUSSION` contains `fix: auto|user`.
- **`gate-wiring.test.ts` adds:**
  - the three discuss-to-plan paths call `startDiscussionGate(`;
  - `runDiscussionGate` passes `signal`;
  - the discuss `agent_end` branch calls `discussionGateAfterFixReply(`.
- **`discussion-review.test.ts`:** update any assertion on the old format line.

**S16. Docs for Stage 2.**
- **README:** a "Discussion gate" subsection next to the plan judge, plus the config keys.
- **Backlog:** D45 marked **Done** (`gates.ts`, `index.ts`, `prompts.ts`), the Status line and the Effect measurement row.

### Stage 3: Orchestra side

**S17. Create the pure helpers in `orchestrate/plan-judge.ts` (new file; no imports from `workflow/`).**
- **`parsePlanJudge(data): PlanJudge | undefined`:** validates the K10 `judge` shape. Anything malformed gives undefined.
- **`judgeSection(j?): string`:**
  - It returns `""` when there is no judge result or when the result is clean.
  - Otherwise it returns `\n\n## Open judge findings\n\n` with "Needs a decision:" and "Open after the cap:" lists, followed by the status line from `planReviewJudgeLine(j)`.
- **`planReviewJudgeLine(j?): string`:**

  | Judge result | Line |
  |---|---|
  | No `judge` field | `""` |
  | Clean | `judge: PASS (N runs)` |
  | Did not run | `judge: did not run (cancelled\|error)` |
  | Otherwise | `judge: K open findings (U need a decision) after N runs, see the plan file` |

- **`phaseLabel(phase, judging?)`:** returns `"plan (judging plan)"` or `"discuss (judging discussion)"` when `judging` is set, else the phase.

**S18. Wire `orchestrate/index.ts`.**
- **`handlePlanReady` (:240-247):**
  - write `d.plan + judgeSection(j)`;
  - post `{ file, n, judgeLine }`.
- **The plan-review event (:953)** appends `\n${judgeLine}` when it is non-empty.
- **The `orch_review_plan` description** (~:1600) gets one line: if the plan file ends in `## Open judge findings`, weigh them. Reject with instructions for the ones to fix, and settle the "needs a decision" ones in the reject text, or approve.
- **`writeMyStatus` (:183)** copies `judging` when it is `"discussion"` or `"plan"`.
- **`table()` (:1325)** uses `phaseLabel(st?.phase ?? "-", st?.judging)`.

**S19. Board.**
- In `orchestrate/store.ts:21`, `Status` gets `judging?: "discussion" | "plan"`.
- In `orchestrate/view.ts`:
  - `ViewSub` gets `judging?`;
  - `buildView` (:144) sets it from the status;
  - the board row (:210) and `detailOf` (:227) use `phaseLabel`.

**S20. Tests for Stage 3.**
- **New `orchestrate/plan-judge.test.ts`:**
  - parse: valid; malformed gives undefined; missing gives undefined.
  - `judgeSection`: clean gives empty; open and user findings render the lists; cancelled.
  - `planReviewJudgeLine`: each row of the S17 table.
  - `phaseLabel`.
- **`view.test.ts`:** the board row and the detail with `judging: "plan"` and without it.
- **`wiring.test.ts`:**
  - `handlePlanReady` uses `judgeSection(` and `planReviewJudgeLine(`;
  - `writeMyStatus` copies `judging`;
  - `table()` uses `phaseLabel(`.
- **`boundary.test.ts`** still passes.

**S21. Docs for Stage 3.**
- The orchestrate README gets the plan-review judge line, the plan-file section and the board label.
- The backlog marks D47 **Done**, with the Status line and Effect measurement updates.

**S22. Verify:** a local flow — look for:
- "go" with a stale list runs the discussion judge, and a `fix: auto` finding is fixed and rechecked;
- a `fix: user` finding pauses;
- the plan judge posts `workflow-plan-judge`, sends a `workflow-plan-fix` and rechecks;
- the menu shows the judge lines;
- "go" during a plan-judge run shows "approval queued" and approves after a clean PASS;
- Esc during a run gives "plan judge cancelled" and the menu;
- no idle notice appears during a run.

**S23. Verify:** an orchestra run with 2 packages — look for:
- the board shows "plan (judging plan)" while the sub judges;
- no idle item appears in `items.json` during the judge;
- the `plan-review` event has the judge line;
- after the cap, `plan-<n>.md` ends in `## Open judge findings`.

### Tests
Commands run from `pi/agent/extensions/workflow` and `pi/agent/extensions/orchestrate`.

| Suite | Command | Expected |
|---|---|---|
| Workflow fast (Stages 1-2) | `node --experimental-strip-types --test gates.test.ts gate-wiring.test.ts asks.test.ts config.test.ts discussion-review.test.ts prompts.test.ts hooks.test.ts agent-end.test.ts` | All pass |
| Workflow full (slow, more than 2 min, run once per stage) | `node --experimental-strip-types --test *.test.ts` | Only the known `publish.test.ts` failure (`pushSkipReason` export) |
| Orchestrate (Stage 3) | `node --experimental-strip-types --test *.test.ts` | All pass (147 + new) |

### Done when
- Every test in S9, S15 and S20 exists and passes. The full workflow suite shows only the known `publish.test.ts` failure.
- With default config, moving from discuss to plan runs the discussion gate, and every complete plan goes through the plan judge before the menu or K10.
- `fix: user` findings never reach the fix loop, and always reach you or the orchestrator.
- Esc, a typed message and `/flow judge cancel` abort a run without counting a round. A queued "go" approves only after a clean PASS.
- No K13 idle event is emitted and no local idle notice is shown while a judge runs. K4 carries `judging`.
- The orchestrator's plan file and `plan-review` text carry the judge result, and its board shows "(judging plan)".
- Quick flows and `autoJudge*: "off"` behave exactly as before.
- The README files and backlog rows D45-D47 are updated, with the Status line and Effect measurement.
- S22 and S23 are listed for you at the end.

### Risks, rollback, do-not-touch
- **Risk: an old `Agreed so far:` list from an earlier discussion in the same session becomes the spec.** It is acceptable: the judge flags mismatches as findings.
- **Risk: extra time per flow.** About 2-6 min for the discussion gate and 2-8 min for the plan judge. Either gate can be switched off in config.
- **Risk: a detached gate promise racing a phase change.** This is covered by the abort in `setPhase` and the hash check.
- **Rollback:** set both `autoJudge*` keys to `"off"`, or revert the stage commits. The persisted fields are optional, and old states load unchanged.
- **Don't touch:**
  - `gitRaw`, `diffBase`, `pickDiffBase`;
  - `addAccepted` ordering;
  - `workflow/merge-gate.ts`;
  - the execute judge loop;
  - the stage-empty and wait code (D42, D43).

### Commits
- **Stage 1:** `workflow: automatic plan judge before approval` — `workflow/gates.ts`, `gates.test.ts`, `gate-wiring.test.ts`, `prompts.ts`, `config.ts`, `config.test.ts`, `asks.ts`, `asks.test.ts`, `index.ts`, `README.md`, `docs/workflow-improvements.md`.
- **Stage 2:** `workflow: automatic discussion judge gate` — `workflow/gates.ts`, `gates.test.ts`, `gate-wiring.test.ts`, `prompts.ts`, `agent-end.ts`, `discussion-review.ts` (if touched), `discussion-review.test.ts`, `index.ts`, `README.md`, `docs/workflow-improvements.md`.
- **Stage 3:** `orchestrate: show sub plan-judge results and judging state` — `orchestrate/plan-judge.ts`, `plan-judge.test.ts`, `index.ts`, `store.ts`, `view.ts`, `view.test.ts`, `wiring.test.ts`, `README.md`, `docs/workflow-improvements.md`.

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 Create the pure helpers in `workflow/gates.ts` (new file). Export:
- [ ] S2 Add the plan prompts and the `fix:` tag in `workflow/prompts.ts`.
- [ ] S3 Add the config keys in `workflow/config.ts`.
- [ ] S4 Hold back idle while a judge runs (`workflow/asks.ts:131`).
- [ ] S5 Add K4 `judging` (`index.ts` `emitStatus` :546-554).
- [ ] S6 Add the state fields and resets (`index.ts`).
- [ ] S7 Wire the plan gate (`index.ts`).
- [ ] S8 Input and commands (`index.ts`).
- [ ] S9 Tests for Stage 1.
- [ ] S10 Docs for Stage 1.
- [ ] S11 Run the Stage 1 tests (see Tests). The full suite may only fail in the known `publish.test.ts`.
- [ ] S12 Add to `gates.ts`:
- [ ] S13 Prompts (`workflow/prompts.ts`).
- [ ] S14 Wire the discussion gate (`index.ts`).
- [ ] S15 Tests for Stage 2.
- [ ] S16 Docs for Stage 2.
- [ ] S17 Create the pure helpers in `orchestrate/plan-judge.ts` (new file; no imports from `workflow/`).
- [ ] S18 Wire `orchestrate/index.ts`.
- [ ] S19 Board.
- [ ] S20 Tests for Stage 3.
- [ ] S21 Docs for Stage 3.
## For you after the flow
- S22 Verify: a local flow — look for:
- S23 Verify: an orchestra run with 2 packages — look for:
