<!-- pi-workflow plan v1 flow=20261015-1755-let-a-passed-review-with-plan-flaws-go-o-46b5 -->
## Plan: Let a passed review with plan flaws go on to commit, and send major plan flaws to the arbiter

### 1. Goal and non-goals
**Goal:** a judge PASS that contains `[plan-flaw]` findings no longer stops the flow at the "Judge questions the plan" menu, unless one of the flaws is a blocker.
- If every plan flaw is minor, it is noted in the plan and the flow carries on: minor-fix round, then the commit step.
- If the worst plan flaw is major, the arbiter decides automatically, whatever `planFlaw` is set to:
  - KEEP: commit.
  - REVISE: the executor implements the amendment before the commit, and the judge runs again.
  - The arbiter can't decide (ASK_USER, the revision cap is reached, or the arbiter errors): the flaws are noted, the flow carries on, and the flow summary flags them.
- A FAIL with any plan flaw, or a PASS with a blocker plan flaw, behaves exactly as today.

**Non-goals:**
- No change to the judge prompt, the arbiter prompt, `parseArbiter`, `fixableFindings`, minor-round logic, the commit step, staged-plan advancing, or the `planFlaw` config key and its values.
- No new config keys.
- No committing first and amending afterwards.
- No carrying flaws into the next stage's start message.

### 2. User decisions
- **D1** A PASS with plan flaws should continue to the commit step without asking the user, except as listed in D4.
- **D2** If every plan flaw on a PASS is minor, it is noted in the approved plan and the flow continues. No arbiter, no menu.
- **D3** If the worst plan flaw on a PASS is major, the arbiter runs automatically, even when `planFlaw` is `"ask"`:
  - KEEP: the flow continues to commit.
  - REVISE: the amendment is reworked before the commit.
  - ASK_USER, revision cap reached, or arbiter error: the flaws are noted, the flow continues, and the flow summary flags them.
- **D4** A blocker plan flaw on a PASS, or any plan flaw in a FAIL, keeps today's behaviour: `resolvePlanFlaw`, so arbiter or menu depending on `planFlaw`.
- **D5** Rejected: commit first and amend in a follow-up; carry the flaw into the next stage's start message.
- **D6** In the executor's own judge-call path: if the diff changed since that review, drop the stale report and judge the diff again, instead of asking about the old report.

### 3. Facts the executor needs
- `agent-end.ts:89-92`: `hasPlanFlaw(text)` uses this pattern, case-insensitive and multiline: `^\S.*\s-\s*(blocker|major|minor)\s*-\s*\[plan-flaw\]`.
- `agent-end.ts:103-107`: `fixableFindings` already leaves `[plan-flaw]` lines out, so minor rounds never fire for them.
- `index.ts:792-809`: `judge()` marks a diff as passed only when the verdict is PASS and `hasPlanFlaw` is false. The caller must call `markPassed(hash)` itself after the plan flaw is settled. `markPassed` is at `index.ts:813`.
- `index.ts:1531-1538`: the executor's `judge` tool stores `state.pendingPlanFlaw = r.text` when the report has a plan flaw. The verdict is not stored with it; the verdict lives in `state.lastJudge` (`{hash, verdict, text}`).
- `index.ts:1923-1945` (agent_end, execute phase), when `state.pendingPlanFlaw` is set:
  - It always calls `resolvePlanFlaw`.
  - Then: if `state.lastJudge?.hash === flawed.hash`, it calls `markPassed` on PASS, or `fixOrAsk` on FAIL.
  - Otherwise it calls `seenDiffs.delete(flawed.hash)`.
  - Then it falls through to `reviewDiff`.
- `index.ts:2112-2181` (`reviewDiff`), at `:2164-2168`: `if (hasPlanFlaw(r.text)) { outcome = await resolvePlanFlaw(...); if (outcome !== "continue") return; if (r.verdict === "PASS") markPassed(diff.hash); }`. After that come the FAIL branch, `fixMinorFindings`, then `finishPassed(ctx, diff, report)`, which displays `report`.
- `index.ts:2212-2253` (`resolvePlanFlaw`): its "Ignore and continue" branch (`:2239-2247`) keeps the lines that contain `[plan-flaw]` and appends `\n\n## Plan choices upheld by the user\n<lines>` to `state.approvedPlan`. It then calls `refreshChecklist()`, `planMilestone(ctx)` and `persist()`.
- `index.ts:2256-2312` (`runArbiter(ctx, report, diff)`) returns `"continue" | "amended" | "ask"`:
  - It does not read the `planFlaw` config.
  - KEEP: it records the reason and returns `"continue"`.
  - REVISE: it returns `"amended"`, after sending a follow-up message. When `planRevisions >= cfg.maxPlanRevisions`, it returns `"ask"` instead.
  - Errors, no decision, or ASK_USER: it notifies the user and returns `"ask"`.
- `index.ts:317-330`: `summarizeFlow(outcome, ok)` writes the plan-doc milestone and the token summary using the `outcome` text.
- `index.ts:390-410`: `setPhase` resets per-flow state fields, `pendingPlanFlaw` among them.
- `index.ts:96-150` (`FlowState`): `pendingPlanFlaw?: string` is at about `:137`.
- `plan-doc.ts:23`: `AMENDMENT = /^## (?:Amendment \d+|Plan choices upheld)/`. A heading that starts with `## Plan choices upheld` is already treated as an amendment.
- Test models: `agent-end.test.ts:90-94` (hasPlanFlaw) and `plan-doc.test.ts:72-73` (planCard shows "### Amendments").
- Docs: `README.md:26` (when the arbiter runs) and `README.md:130-136` (the `[plan-flaw]` paragraph, ending "A plan flaw blocks the commit until resolved.").

### 4. Design
- **New pure helpers in `agent-end.ts`:**
  - `export function planFlawLines(text: string): string[]` returns the finding lines that match `hasPlanFlaw`'s pattern, using the same severity and tag regex, line by line.
  - `export function planFlawOnPass(text: string, verdict: "PASS" | "FAIL"): "stop" | "arbiter" | "note"`, decided in this order:
    - `"stop"` when the verdict is not `"PASS"`, or any plan-flaw line has severity `blocker`;
    - `"arbiter"` when any plan-flaw line is `major`;
    - otherwise `"note"`.

    Callers use it only when `hasPlanFlaw(text)` is true. Severity is matched case-insensitively.
- **New state field** `unresolvedPlanFlaws?: number` in `FlowState`: the number of plan-flaw lines noted after the arbiter could not decide during this flow.
  - Reset to `undefined` in `setPhase`'s reset block.
  - Read and cleared in `summarizeFlow`.
  - Older saved states lack the field, which reads as 0, so no migration is needed.
- **New `index.ts` function** `notePlanFlaws(ctx, report: string, heading: string): number`:
  - Appends `\n\n## ${heading}\n${planFlawLines(report).join("\n")}` to `state.approvedPlan`.
  - Calls `refreshChecklist()`, `planMilestone(ctx)` and `persist()`.
  - Returns the number of lines.
- **Headings (exact text):**
  - `Plan choices upheld by the user`: the existing heading, used by the "Ignore and continue" branch.
  - `Plan choices upheld at a pass`: used for both the note route and the arbiter-could-not-decide route.

  Both start with `Plan choices upheld`, so `plan-doc.ts:23` needs no change.
- **New `index.ts` function** `settlePlanFlawOnPass(ctx, report, diff, route: "arbiter" | "note"): Promise<"continue" | "amended">`:
  - `"note"`: call `notePlanFlaws(..., "Plan choices upheld at a pass")`, notify info with exactly `workflow: the judge passed but questions the plan (${n} plan flaw(s)); noted in the plan, continuing`, and return `"continue"`.
  - `"arbiter"`: call `runArbiter(ctx, report, diff)`.
    - `"continue"`: return `"continue"`.
    - `"amended"`: return `"amended"`.
    - `"ask"`: call `notePlanFlaws(..., "Plan choices upheld at a pass")`, add n to `state.unresolvedPlanFlaws`, call `persist()`, notify a warning with exactly `workflow: the arbiter did not settle ${n} plan flaw(s); noted in the plan, continuing`, and return `"continue"`.
  - It never calls `ctx.ui.select` and works without a UI.
- **Summary flag:** in `summarizeFlow`, when `state.unresolvedPlanFlaws` is greater than 0, append `` · ${n} plan flaw(s) not settled (see the plan)`` to `outcome` before it is used (the milestone and `view.endFlow`). Then set the field to `undefined`. `ok` is unchanged.
- **Failure handling:** an arbiter failure already returns `"ask"`, which here means note and continue. Nothing new can throw.
- **Scale:** one extra arbiter run per PASS with a major plan flaw. REVISE rounds are capped by `cfg.maxPlanRevisions` (2) per flow; after that the flaws are noted.
- **Rejected:** see D5. A new config key was rejected as unneeded (D3 overrides `"ask"` only for this case).

### 5. Steps
**S1.** `agent-end.ts`, after `hasPlanFlaw` (`:89-92`):
- Add `planFlawLines` and `planFlawOnPass` with the signatures and rules in §4.
- Give `planFlawLines` its own copy of the same pattern so the two can't drift: an exported constant or a local regex used by both is fine.
- Give each function a one-line doc comment, matching the file's style.

**S2.** `index.ts` `FlowState` (about `:137`): add `unresolvedPlanFlaws?: number` with a one-line doc comment, and add `state.unresolvedPlanFlaws = undefined;` to the `setPhase` reset block (`:390-410`) next to `state.pendingPlanFlaw = undefined;`.

**S3.** `index.ts`:
- Add `notePlanFlaws` (§4) near `resolvePlanFlaw`, modelled on `:2239-2247`.
- Rewrite the "Ignore and continue" branch to call `notePlanFlaws(ctx, report, "Plan choices upheld by the user")` and return `"continue"`. Its behaviour doesn't change, apart from keeping only finding lines.

**S4.** `index.ts`: add `settlePlanFlawOnPass` (§4) after `runArbiter`. Import `planFlawLines` and `planFlawOnPass` in the `./agent-end.ts` import at `:52`.

**S5.** `index.ts` `reviewDiff` (`:2164-2168`): replace the plan-flaw block with this:
- `route = planFlawOnPass(r.text, r.verdict)`, where `r.verdict` is `"PASS"` or `"FAIL"` here because ERROR has already returned.
- If `route === "stop"`: today's code, unchanged.
- Otherwise: `outcome = await settlePlanFlawOnPass(ctx, report, diff, route)`. If `outcome === "amended"`, return. Otherwise call `markPassed(diff.hash)` and fall through.

Everything after this point is unchanged: the FAIL branch is skipped, then `fixMinorFindings`, then `finishPassed` with `report`.

**S6.** `index.ts` agent_end pending path (`:1923-1945`): after taking `report` and `flawed`:
- **No diff (`flawed` is falsy):** unchanged.
- **`state.lastJudge?.hash === flawed.hash`:** `route = planFlawOnPass(report, state.lastJudge.verdict)`.
  - `"stop"`: today's code, unchanged (`resolvePlanFlaw`, then `markPassed` or `fixOrAsk`).
  - Otherwise: call `settlePlanFlawOnPass(ctx, report, flawed, route)`. If it returns `"amended"`, return. Otherwise call `markPassed(flawed.hash)` and fall through to the commit-pending check and `reviewDiff`. `reviewDiff` will see `diff.hash === state.passedDiff` and go straight to the minor round or the commit (`:2129-2140`).
- **Diff changed since that review (D6):** do not call `resolvePlanFlaw`. Call `seenDiffs.delete(flawed.hash)` and fall through, so `reviewDiff` judges the current diff and routes any plan flaw as S5 does.

Confirm that `state.lastJudge.verdict`'s type is `"PASS" | "FAIL"`. If its type also includes another value, treat anything other than `"PASS"` as `"FAIL"` when calling `planFlawOnPass`.

**S7.** `index.ts` `summarizeFlow` (`:317`): apply the summary flag from §4 at the top of the function, before `planMilestone` uses `outcome`.

**S8.** `README.md`:
- **`:26` arbiter row:** also say that the arbiter runs automatically when a passed review has a major plan flaw (whatever `planFlaw` is set to).
- **`:130-136` `[plan-flaw]` paragraph:** keep the current text for FAIL and blocker. Replace "A plan flaw blocks the commit until resolved." with the new rule:
  - On a PASS, minor plan flaws are noted under "Plan choices upheld at a pass" and the commit goes ahead.
  - Major plan flaws go to the arbiter first. KEEP commits; REVISE reworks before the commit. If the arbiter can't decide, the flaws are noted, the commit goes ahead, and the flow summary says "N plan flaw(s) not settled".
  - A blocker plan flaw, or one in a FAIL, blocks the commit until resolved, as before.

  Keep the README's plain style.

### 6. Tests
- `agent-end.test.ts`: add `planFlawOnPass` and `planFlawLines` to the import at `:4`.
- **`planFlawOnPass routes plan flaws on a pass`:**
  - `"a.ts:3 - minor - [plan-flaw] x\nVERDICT: PASS"` with `"PASS"` gives `"note"`.
  - `"a.ts:3 - major - [plan-flaw] x"` with `"PASS"` gives `"arbiter"`.
  - Major and minor plan flaws together, with `"PASS"`, give `"arbiter"`.
  - `"a.ts:3 - blocker - [plan-flaw] x"` with `"PASS"` gives `"stop"`.
  - A minor plan flaw with `"FAIL"` gives `"stop"`.
  - `"a.ts:3 - Major - [plan-flaw] x"` with `"PASS"` gives `"arbiter"` (case-insensitive).
  - `"a.ts:3 - blocker - [bug] y\na.ts:4 - minor - [plan-flaw] x"` with `"PASS"` gives `"note"`: only plan-flaw lines count toward the route.
- **`planFlawLines keeps plan-flaw finding lines only`:** for `"a.ts:3 - major - [plan-flaw] x\n  Why: [plan-flaw] mention\nb.ts:1 - minor - [bug] y"`, the result is `["a.ts:3 - major - [plan-flaw] x"]`.
- **`plan-doc.test.ts`: `planCard lists a pass-upheld plan flaw as an amendment`:** `planCard(`${PLAN}\n\n## Plan choices upheld at a pass\na.ts:3 - minor - [plan-flaw] x`, [], undefined, undefined, "/p")` includes `"### Amendments"`. Model it on `:72-73`.
- **Commands:** in `pi/agent/extensions/workflow`, run `node --test *.test.ts`. Expected: `ℹ fail 0`, and the test count goes up by 3 from the current total.

### 7. Done when
- A PASS whose plan flaws are all minor reaches the minor-fix round or the commit step with no menu and no arbiter run. The flaw lines appear in the approved plan under `## Plan choices upheld at a pass`.
- A PASS whose worst plan flaw is major runs the arbiter, with `planFlaw` set to either `"ask"` or `"auto"`, and never shows the menu:
  - KEEP: commit.
  - REVISE: an amendment message goes to the executor and nothing is committed yet.
  - ASK_USER, error or cap: the flaws are noted, the flow commits, and the flow summary ends with `· N plan flaw(s) not settled (see the plan)`.
- A FAIL with a plan flaw, or a PASS with a blocker plan flaw, behaves exactly as before.
- The executor's own judge-call path follows the same routing. When the diff changed after that call, no menu is shown for the old report; the diff is judged again.
- All workflow node tests pass, the new tests included. The README describes the new rule.

### 8. Risks, rollback, what not to touch
- **Risk:** the arbiter may say KEEP to a real major flaw. That is accepted (D3); the arbiter's reason is recorded in the plan.
- **Risk:** extra arbiter cost on a PASS that has major plan flaws.
- **Risk:** in S6, judging a changed diff again costs one judge run. That is what reviewDiff does today after the menu anyway.
- **Rollback:** revert the single commit.
- **Do not touch:** `prompts.ts`, `parseArbiter`, `fixableFindings`, `resolvePlanFlaw`'s menu and its arbiter-first logic (other than the S3 refactor), `finishPassed`, `config.ts`, `plan-doc.ts`.

### 9. Commits
- `feat(workflow): let a passed review with plan flaws go on, arbiter for major ones` (`agent-end.ts`, `agent-end.test.ts`, `index.ts`, `plan-doc.test.ts`, `README.md`)

## Amendment 1 (arbiter)
**S6 (amended), `index.ts` agent_end pending path, "Diff changed since that review (D6)" branch:**
- Keep the current behaviour: don't call `resolvePlanFlaw`, and call `seenDiffs.delete(flawed.hash)`.
- Also set a local flag (e.g. `rejudge = true`).
- At the end of the handler, call `await reviewDiff(ctx, rejudge)` instead of `reviewDiff(ctx, false)`. `rejudge` defaults to `false`, so every other path is unchanged.
- Leave the commit-handover and `commitPending` checks between them as they are.
- Why: the executor itself asked for this review. D6 says the current diff is judged again, so the `autoJudge` "off"/"ask" gates must not drop it silently. With `manual = true`, `reviewDiff` judges the current diff, and S5 then routes any plan flaw (stop, arbiter or note).
- Required behaviour: with `autoJudge` set to `"off"` or `"ask"`, a pending plan-flaw report whose diff has since changed always leads to a fresh judge run on the current diff, with no confirm prompt and no menu for the old report.
- Tests: none new, because this is wiring inside the agent_end handler with no pure helper. Existing `node --test *.test.ts` must stay at `ℹ fail 0`.

**S8 addendum, `README.md`:** none needed.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 `agent-end.ts`, after `hasPlanFlaw` (`:89-92`):
- [x] S2 `index.ts` `FlowState` (about `:137`): add `unresolvedPlanFlaws?: number` with a one-line doc comment, and add `state.un
- [x] S3 `index.ts`:
- [x] S4 `index.ts`: add `settlePlanFlawOnPass` (§4) after `runArbiter`. Import `planFlawLines` and `planFlawOnPass` in the `./ag
- [x] S5 `index.ts` `reviewDiff` (`:2164-2168`): replace the plan-flaw block with this:
- [x] S6 `index.ts` agent_end pending path (`:1923-1945`): after taking `report` and `flawed`:
- [x] S7 `index.ts` `summarizeFlow` (`:317`): apply the summary flag from §4 at the top of the function, before `planMilestone` u
- [x] S8 `README.md`:
