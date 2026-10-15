<!-- pi-workflow plan v1 flow=20261015-1808-let-a-passed-review-with-plan-flaws-cont-1430 -->
## Plan: Let a passed review with plan flaws continue to commit; major plan flaws go to the arbiter

### 1. Goal and non-goals
**Goal:** a judge PASS that contains `[plan-flaw]` findings no longer stops the flow at the "Judge questions the plan" menu, unless one of those flaws is a blocker.
- If every plan flaw is minor, it is noted in the approved plan and the flow continues to the minor-fix round and then the commit step.
- If the worst plan flaw is major, the arbiter decides automatically, whatever `planFlaw` is set to:
  - KEEP: commit.
  - REVISE: the executor reworks the amendment before the commit, and the judge runs again.
  - The arbiter can't decide (ASK_USER, revision cap reached, or arbiter error): the flaws are noted, the flow continues, and the flow summary flags them.
- A FAIL with any plan flaw, or a PASS with a blocker plan flaw, behaves exactly as today.
- When the executor's own `judge` call reported a plan flaw and the diff changed before its turn ended, the stale report is dropped and the current diff is always judged again.

**Non-goals:**
- No change to the judge prompt, the arbiter prompt, `parseArbiter`, `fixableFindings`, the minor-round logic, the commit step, staged-plan advancing, or the `planFlaw` config key and its values.
- No new config keys.
- No commit-first-then-amend flow.
- No carrying flaws into the next stage's start message.

### 2. User decisions
- **D1** A PASS with plan flaws continues to the commit step without asking the user, except as listed in D4.
- **D2** A PASS whose plan flaws are all minor: note them in the approved plan and continue. No arbiter, no menu.
- **D3** A PASS whose worst plan flaw is major: the arbiter runs automatically, even when `planFlaw` is `"ask"`.
  - KEEP: continue to commit.
  - REVISE: rework before the commit.
  - ASK_USER, cap or error: note the flaws, continue, and flag them in the flow summary.
- **D4** A blocker plan flaw on a PASS, or any plan flaw in a FAIL, keeps today's behaviour: `resolvePlanFlaw`, which runs the arbiter or the menu depending on `planFlaw`.
- **D5** Rejected: commit first and amend in a follow-up; carry the flaw into the next stage's start message.
- **D6** In the executor's own judge-call path: if the diff changed since that review, drop the stale report and judge the current diff again, instead of asking about the old report. The re-judge must actually run, regardless of `autoJudge` (arbiter amendment).
- **D7** The three judge findings are fixed as discussed:
  - the stale report always leads to a re-judge;
  - at the revision cap on the pass route, the message says "noting the flaws instead", not "asking you instead";
  - a flaw already noted in the plan is not appended or counted again.

### 3. Facts the executor needs
**The work is already in the working tree, uncommitted.** Five files are modified: `README.md`, `agent-end.ts`, `agent-end.test.ts`, `index.ts`, `plan-doc.test.ts`. Check each step against the existing diff (`git diff`). Complete or correct only what doesn't match; don't rewrite code that already matches.

Paths are relative to `pi/agent/extensions/workflow/`.

`agent-end.ts`:
- `:89-92` `hasPlanFlaw`.
- `:94` `PLAN_FLAW_LINE`.
- `:97` `planFlawLines`.
- `:102` `planFlawOnPass`.

`index.ts`:
- `:52` imports from `./agent-end.ts`.
- `:139` `unresolvedPlanFlaws` field.
- `:319-321` `summarizeFlow` flag.
- `:403` reset in `setPhase`.
- `:1928-1957` agent_end pending-flaw path:
  - `let rejudge`;
  - `planFlawOnPass` routing at `:1937`;
  - `rejudge = true` at `:1948`;
  - `reviewDiff(ctx, rejudge)` at `:1957`.
- `:2121` `reviewDiff(ctx, manual)`:
  - `manual = true` skips the `autoJudge` "off" and "ask" gates.
  - Its only other effect is the "no changes" notice, which can't fire when there is a diff.
- `:2173` routing in `reviewDiff`.
- `:2221` `resolvePlanFlaw`; its "Ignore and continue" branch at `:2250` calls `notePlanFlaws(..., "Plan choices upheld by the user")`.
- `:2261` `notePlanFlaws`.
- `:2272` `settlePlanFlawOnPass`.
- `:2289` `runArbiter(ctx, report, diff, canAsk = true)`; cap message at `:2325`.
- `:810-812` `judge()` marks a diff passed only when the verdict is PASS and there is no plan flaw. Callers mark the pass themselves after settling the flaw.

`plan-doc.ts:23`: `AMENDMENT = /^## (?:Amendment \d+|Plan choices upheld)/`. Both headings below already count as amendments.

Tests run with Node's built-in runner. Baseline before this change: 398 tests. With the new tests: 414 tests, 0 failing.

Watch for line endings: the files are LF. Earlier, a raw `\r` got into `agent-end.ts:98` and was fixed. Verify `grep -c $'\r' agent-end.ts index.ts` prints 0 for both files.

### 4. Design
**Pure helpers in `agent-end.ts`:**
- `const PLAN_FLAW_LINE = /^\S.*\s-\s*(blocker|major|minor)\s*-\s*\[plan-flaw\]/i;`
- `export function planFlawLines(text: string): string[]` returns the lines of `text`, split on `\r?\n`, that match `PLAN_FLAW_LINE`.
- `export function planFlawOnPass(text: string, verdict: "PASS" | "FAIL"): "stop" | "arbiter" | "note"`, decided in this order:
  1. `"stop"` if the verdict is not PASS, or any plan-flaw line is a blocker;
  2. `"arbiter"` if any plan-flaw line is major;
  3. `"note"` otherwise.

  Severity is matched case-insensitively. Only `[plan-flaw]` lines count.

**State:** `FlowState.unresolvedPlanFlaws?: number` holds the plan flaws the arbiter couldn't settle at a pass in this flow.
- `setPhase` resets it.
- `summarizeFlow` reads and clears it: when it is above 0, `` · ${n} plan flaw(s) not settled (see the plan)`` is appended to `outcome` before `outcome` is used. `ok` is unchanged.
- Older saved state without the field reads as 0, so no migration is needed.

**`notePlanFlaws(ctx, report: string, heading: string): number`:**
- Takes `planFlawLines(report)` and drops lines already contained in `state.approvedPlan`.
- If no line is left, returns 0 and writes nothing.
- Otherwise appends `\n\n## ${heading}\n<lines joined by \n>` to `state.approvedPlan`, calls `refreshChecklist()`, `planMilestone(ctx)` and `persist()`, and returns the number of lines written.

**Headings (exact text):**
- `Plan choices upheld by the user`: the existing "Ignore and continue" branch.
- `Plan choices upheld at a pass`: both pass routes.

**`settlePlanFlawOnPass(ctx, report, diff, route: "arbiter" | "note"): Promise<"continue" | "amended">`:**
- Never shows a menu.
- `"note"`: `n = notePlanFlaws(..., "Plan choices upheld at a pass")`. If `n > 0`, an info notify with exactly `` workflow: the judge passed but questions the plan (${n} plan flaw(s)); noted in the plan, continuing ``. Returns `"continue"`.
- `"arbiter"`: calls `runArbiter(ctx, report, diff, false)`.
  - `"continue"` or `"amended"`: returned as is.
  - `"ask"`: `n = notePlanFlaws(...)`, `state.unresolvedPlanFlaws += n`, `persist()`. If `n > 0`, a warning notify with exactly `` workflow: the arbiter did not settle ${n} plan flaw(s); noted in the plan, continuing ``. Returns `"continue"`.

**`runArbiter`'s `canAsk` parameter (default `true`)** only changes the revision-cap message:
- `true`: `asking you instead`;
- `false`: `noting the flaws instead`.

**Failure handling:** an arbiter error already returns `"ask"`, which here means the flaws are noted and the flow continues.

**Scale:** at most one extra arbiter run per PASS that has a major plan flaw. REVISE is capped by `cfg.maxPlanRevisions` (2) per flow.
- Duplicate detection is exact-line. If the judge rewords the same flaw, it counts as new. This is accepted.

**Rejected:** a new config key, because D3 overrides `"ask"` only for this case. Also D5.

### 5. Steps
**S1.** `agent-end.ts`, after `hasPlanFlaw` (`:89-92`): `PLAN_FLAW_LINE`, `planFlawLines` and `planFlawOnPass` exactly as in §4. Each function gets a one-line doc comment, following `hasPlanFlaw`.

**S2.** `index.ts`:
- `FlowState` (`:139`): add `unresolvedPlanFlaws?: number` with a one-line doc comment.
- `setPhase` (`:403`): reset it next to `state.pendingPlanFlaw = undefined;`.
- `:52`: import `planFlawLines` and `planFlawOnPass`.

**S3.** `index.ts` `notePlanFlaws` (`:2261`), as in §4, including the duplicate filter and the early return of 0.
- The "Ignore and continue" branch of `resolvePlanFlaw` (`:2250`) calls it with `"Plan choices upheld by the user"` and returns `"continue"`.
- The duplicate filter applies there too. That is intended.

**S4.**
- `index.ts` `runArbiter` (`:2289`): add the `canAsk = true` parameter and the cap message in §4 (`:2325`). Make no other change to `runArbiter`.
- `settlePlanFlawOnPass` (`:2272`): as in §4. It calls `runArbiter(..., false)`, and each notify is guarded by `n > 0`.

**S5.** `index.ts` `reviewDiff` (`:2172-2177`), when `hasPlanFlaw(r.text)`:
- `route = planFlawOnPass(r.text, r.verdict)`.
- `"stop"`: `resolvePlanFlaw`, as before.
- Otherwise: `settlePlanFlawOnPass(ctx, report, diff, route)`.
- If the outcome is not `"continue"`, return. Otherwise mark the pass on PASS (`markPassed(diff.hash)`) and fall through unchanged: minor round, then `finishPassed`.

**S6.** `index.ts` agent_end pending path (`:1928-1957`):
- **Declare `let rejudge = false;` before the `state.pendingPlanFlaw` block.**
- **No diff:** unchanged.
- **`state.lastJudge?.hash === flawed.hash`:**
  - Route with `planFlawOnPass(report, lastJudge.verdict === "PASS" ? "PASS" : "FAIL")`: `"stop"` goes to `resolvePlanFlaw`, otherwise to `settlePlanFlawOnPass`.
  - If the outcome is not `"continue"`, return.
  - On PASS, `markPassed(flawed.hash)`. On FAIL, `await fixOrAsk(ctx, undefined); return;`.
- **Diff changed (D6):** don't call `resolvePlanFlaw`; call `seenDiffs.delete(flawed.hash)` and set `rejudge = true`.
- **Commit checks:** the `commitHandoverInFlight` / `commitSubagentRunning` / `commitPending` checks stay as they are.
- **End of the handler:** `await reviewDiff(ctx, rejudge);`. Every other path still passes `false`.

**S7.** `index.ts` `summarizeFlow` (`:319`): apply the flag at the top, before `planMilestone` uses `outcome`, then clear the field (§4).

**S8.** `README.md`:
- **Arbiter row (`:26`):** add "or a passed review has a major plan flaw (whatever `planFlaw` is)".
- **`[plan-flaw]` paragraph (`:130-140`):** keep the existing text, but replace "A plan flaw blocks the commit until resolved." with the rule:
  - On a pass, minor plan flaws are noted under "Plan choices upheld at a pass" and the commit goes ahead.
  - Major plan flaws go to the arbiter first, whatever `planFlaw` is. `KEEP` commits, `REVISE` reworks before the commit.
  - If the arbiter cannot decide, the flaws are noted, the commit goes ahead, and the flow summary says "N plan flaw(s) not settled".
  - A blocker plan flaw, or one in a FAIL, still blocks the commit until resolved.

### 6. Tests
**`agent-end.test.ts`:** import `planFlawLines` and `planFlawOnPass`.

- **`planFlawOnPass routes plan flaws on a pass`:**

  | Input | Verdict | Expected |
  |---|---|---|
  | `"a.ts:3 - minor - [plan-flaw] x\nVERDICT: PASS"` | PASS | `"note"` |
  | `"a.ts:3 - major - [plan-flaw] x"` | PASS | `"arbiter"` |
  | `"a.ts:3 - major - [plan-flaw] x\nb.ts:1 - minor - [plan-flaw] y"` | PASS | `"arbiter"` |
  | `"a.ts:3 - blocker - [plan-flaw] x"` | PASS | `"stop"` |
  | `"a.ts:3 - minor - [plan-flaw] x"` | FAIL | `"stop"` |
  | `"a.ts:3 - Major - [plan-flaw] x"` | PASS | `"arbiter"` |
  | `"a.ts:3 - blocker - [bug] y\na.ts:4 - minor - [plan-flaw] x"` | PASS | `"note"` |

- **`planFlawLines keeps plan-flaw finding lines only`:** `"a.ts:3 - major - [plan-flaw] x\n  Why: [plan-flaw] mention\nb.ts:1 - minor - [bug] y"` gives `["a.ts:3 - major - [plan-flaw] x"]`.

**`plan-doc.test.ts`, `planCard lists a pass-upheld plan flaw as an amendment`:** `planCard(`${PLAN}\n\n## Plan choices upheld at a pass\na.ts:3 - minor - [plan-flaw] x`, [], undefined, undefined, "/p")` includes `"### Amendments"`.

The wiring in S3-S7 lives inside `index.ts` closures and gets no new unit tests.

**Commands:** run these in `pi/agent/extensions/workflow`:
- `node --test *.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)"` should print `ℹ tests 414`, `ℹ pass 414`, `ℹ fail 0`.
- `grep -c $'\r' agent-end.ts index.ts` should print 0 for both files.

### 7. Done when
- A PASS whose plan flaws are all minor reaches the minor-fix round or the commit step with no menu and no arbiter run. The flaw lines appear in the approved plan under `## Plan choices upheld at a pass`.
- A PASS whose worst plan flaw is major runs the arbiter, with `planFlaw` set to either `"ask"` or `"auto"`, and never shows the menu.
  - KEEP: commit.
  - REVISE: an amendment message goes to the executor, and nothing is committed yet.
  - ASK_USER, error or cap: the flaws are noted, the flow commits, and the flow summary ends with `· N plan flaw(s) not settled (see the plan)`. At the cap, the message says "noting the flaws instead".
- A flaw line already in the approved plan is not appended again and not counted again.
- A FAIL with a plan flaw, or a PASS with a blocker plan flaw, behaves exactly as before.
- The executor's own judge-call path follows the same routing. When the diff changed after that call, no menu is shown for the old report, and the current diff is judged again even with `autoJudge` set to `"off"` or `"ask"`.
- All workflow node tests pass, the new ones included. The README describes the new rule.

### 8. Risks, rollback, what not to touch
**Risks:**
- The arbiter may KEEP a real major flaw. This is accepted (D3), and its reason is recorded in the plan.
- There is an extra arbiter cost per PASS with a major plan flaw.
- In the changed-diff case, the re-judge costs one judge run and bypasses the `autoJudge` gate. This is intended by D6.
- Exact-line duplicate detection misses reworded flaws.

**Rollback:** revert the single commit.

**Don't touch:** `prompts.ts`, `parseArbiter`, `fixableFindings`, `config.ts`, `plan-doc.ts`, `finishPassed`, and the menu and arbiter-first logic of `resolvePlanFlaw`. The one exception is the S3 refactor of its "Ignore and continue" branch.

**Before you finish:** don't run the judge and an edit command in parallel, or the judge reviews a stale diff.

### 9. Commits
- `feat(workflow): let a passed review with plan flaws go on, arbiter for major ones` (files: `pi/agent/extensions/workflow/agent-end.ts`, `agent-end.test.ts`, `index.ts`, `plan-doc.test.ts`, `README.md`)

<!-- pi-workflow:status -->
## Checklist
- [x] S1 `agent-end.ts`, after `hasPlanFlaw` (`:89-92`): `PLAN_FLAW_LINE`, `planFlawLines` and `planFlawOnPass` exactly as in §4.
- [x] S2 `index.ts`:
- [x] S3 `index.ts` `notePlanFlaws` (`:2261`), as in §4, including the duplicate filter and the early return of 0.
- [x] S4 
- [x] S5 `index.ts` `reviewDiff` (`:2172-2177`), when `hasPlanFlaw(r.text)`:
- [x] S6 `index.ts` agent_end pending path (`:1928-1957`):
- [x] S7 `index.ts` `summarizeFlow` (`:319`): apply the flag at the top, before `planMilestone` uses `outcome`, then clear the fi
- [x] S8 `README.md`:
## Outcome
2026-10-15T11:10:26.245Z — ok: committed (1 commit)
