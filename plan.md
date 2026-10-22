<!-- pi-workflow plan v1 flow=20261022-1746-human-checks-wait-until-the-flow-has-fin-3761 -->
## Plan: human checks wait until the flow has finished

### 1. Goal and non-goals

**Goal:** a workflow flow never pauses for a person to test or look at its result: playing in the Unity Editor, checking visuals, judging feel on a device. These human checks are collected while the flow runs and listed once, when the whole flow ends. That end is shown on the end-of-flow card, as a suffix on the outcome line, and in the plan file. If a check fails, the user starts a new flow for the fix. Rules by flow:
- **Execute flows:** a new `**S<n>.** Verify:` step type, and `wait_for_user {kind: "verify"}` for checks the executor finds on its own. Neither one pauses. Verify steps never count as open steps.
- **Test flows:** `[manual]` items are no longer asked between rounds. They are listed at the end instead.
- **`Wait:`** stays as it is, for steps a later step can't do without (publishing with `updates.bat`, opening the Editor so the `unity` CLI can run).

**Non-goals:**
- No keyword-based reclassification of existing `Wait:` steps.
- No automatic follow-up flow.
- No change to `[ask]`, `[blocked]`, refail or dispute questions, to real prerequisite waits, to wait polling, or to autopilot for `approve`/`act`.
- Human checks do not change a flow's `ok`.

### 2. User decisions

- **D1.** Everything that needs a person to test is left until after the flow has finished. The flow does not wait for it, and any fix comes in the next flow.
- **D2.** Test flows are included: `[manual]` items are fully deferred to the end of the flow. They are not asked between rounds, and they are not asked at the end of the flow either. The "ask once at the end" option was rejected.
- **D3.** Plans that already say "Wait: test in Unity" are handled by the executor's judgment: a test-only `Wait:` is treated as a Verify step. The workflow does no keyword matching.
- **D4.** Human checks are a new `Verify:` step type, separate from `Wait:`. `Wait:` stays for real prerequisites.

### 3. Facts the executor needs

- `plan-doc.ts:5-12` `ChecklistItem {id, text, stage?, done}`.
- `plan-doc.ts:60-83` `parseChecklist`. `text` is the step line after `**S<n>.**`, with `**` removed and cut to 120 characters, so a Verify step's text starts with `Verify:`.
- `plan-doc.ts:86-89` `mergeChecklist` re-parses the plan and keeps the done ticks.
- `plan-doc.ts:92-96` `openStepsReminder`.
- `plan-doc.ts:103-120` `planCard`: the open-steps list and the "done of total" count.
- `plan-doc.ts:175-181` `renderPlanFile` writes `## Checklist` after `STATUS_MARKER`. `splitPlanFile` cuts at that marker, so new sections after it are safe.
- `waits.ts:12-27` `parseWaitStep` (the line regex, which also allows a checkbox and list prefix) and `waits.ts:30-32` `waitAmendment`: the models for the new functions.
- `index.ts:2234-2288` the `wait_for_user` tool: kind union at 2244, check validation and first run at 2254-2262, autopilot branch at 2265, unplanned amendment at 2272-2275, `nextAmendmentNumber()`, `refreshChecklist()`, `persist()`, `planMilestone(ctx)`.
- `index.ts:2315` `plan_check` open list. `index.ts:451` plan-card progress `open`.
- `index.ts:2393` and `index.ts:2531` `openStepsReminder` callers. `index.ts:3159` `noChangeTurn` open count. `index.ts:3174` `flowWithoutChanges` "steps are still open" check.
- `index.ts:445` status bar `plan d/t`.
- `index.ts:389-413` `summarizeFlow(outcome, ok)`: it builds `steps` and `findings` and calls `view.endFlow`. It appends `SUMMARY_ENTRY` (`index.ts:201`, rendered at `index.ts:2806`). It returns false without a card when there is no usage, no steps and no findings.
- `index.ts:1870-1879` `finishTestFlow`.
- `index.ts:1926-1979` `askBatch`: the `manual` branch is at 1956.
- `flow-report.ts:22-27` `ReportStep`, `ReportLine` tones; `flow-report.ts:67-91` `reportLines(steps, findings)`.
- `view.ts:85-99` `FlowSummary`; `view.ts:225-226` tone map and `reportLines` call.
- `test-flow.ts:17-18` `Pending.kind` includes `"manual"`.
- `test-flow.ts:112-142` `recordReport`: the queue loop is at 136-138, and the filter at 140 keeps a pending entry only while the item still has that tag.
- `test-flow.ts:168-178` `testOutcome`; `test-flow.ts:217` `bodyField(body, name)`.
- `prompts.ts:25` `CHECKPOINTS` (planner); `prompts.ts:100` executor rule about `Wait:`/`wait_for_user`; `prompts.ts:118` `[manual]` triage line in `TEST_PHASE`.
- `prompts.test.ts:78` asserts that the planner text includes `Wait:`.
- README: "Wait points" at about line 150-160, test flow "When it asks the user" and "End" at about lines 259-260, and the Tests command at about line 228.
- `docs/workflow-improvements.md`: the Status line is line 5, the highest A ID is A24, and the rules are in "Keeping this file current" (line 7). The "Effect measurement" table starts at line 104.

### 4. Design

**Components**

- **`waits.ts`** gets new pure helpers:
  - `parseVerifyStep(plan: string, id: string): VerifySpec | null`, with `VerifySpec { steps: string; lookFor?: string }`. It matches the same line shapes as `parseWaitStep`, with `Verify:` in place of `Wait:`. The look-for part may be either `— look for: <what>` (an em dash or `-`) or a trailing `(look for: <what>)`, case-insensitive. An empty `steps` gives null.
  - `verifyAmendment(n: number, v: { steps: string; lookFor?: string; step?: string }): string`, in this exact format:
    ```
    ## Amendment <n> (executor: verify)
    <steps>[ — look for: <lookFor>][ (step <step>)]
    ```
  - `interface HumanCheck { id?: string; text: string }`.
  - `humanChecks(plan: string | undefined, checklist: ChecklistItem[] | undefined): HumanCheck[]` lists checks in this order, without duplicates:
    - first, every Verify step in the checklist, in plan order, as `{id, text}`, where `text` is the step text with the leading `Verify:` removed;
    - then each `## Amendment N (executor: verify)` block. Its `text` is the block's body lines joined with a space and trimmed, with the trailing ` (step Sx)` removed. Its `id` is that step when one is given; otherwise `id` is unset.
    - A verify amendment whose step is already listed as a Verify step is skipped.
    - Import `ChecklistItem` as a type only, so `waits.ts` stays pure.
- **`plan-doc.ts`**:
  - `ChecklistItem` gets `human?: true`. `parseChecklist` sets it when the text matches `/^verify\s*:/i`.
  - New `export function isHuman(i: ChecklistItem): boolean`, which returns `!!i.human || /^verify\s*:/i.test(i.text)`. This also covers checklists saved before the change.
  - `openStepsReminder` and `planCard` leave out human items: from the open list, and from both numbers in "done of total".
  - `renderPlanFile`: `## Checklist` lists only non-human items. Human items go in a new section `## For you after the flow` (`- S5 <text>`), after the checklist. A flow whose steps are all human checks gets that section only.
- **`index.ts`**:
  - Every open-step or progress count uses `!isHuman(i)`: the lines at 445, 451, 2315, 3159 and 3174, and the `plan_check` "N of M steps done" head line. A `plan_check` call that ticks a human item still works.
  - `wait_for_user` adds the `verify` kind (see below).
  - `summarizeFlow` gets the human-checks output (see below).
  - `askBatch` drops `manual` entries.
- **`flow-report.ts`**: `reportLines(steps, findings, human?: HumanCheck[])`.
  - New tone `"human"`.
  - The steps section lists only non-human steps. The caller already passes them filtered, so `reportLines` only adds the human section.
  - When `human` has entries, it adds a head line `Human checks (after the flow): N`, then one line per check: `  ☐ <id> <text>`, or `  ☐ <text>` when there is no id, with the text cut to 120 characters.
- **`view.ts`**:
  - `FlowSummary.humanChecks?: { id?: string; text: string }[]`.
  - The tone map gets `human: "accent"`.
  - The `reportLines` call passes `s.humanChecks`.
  - Old saved summaries have no field and render as before.
- **`test-flow.ts`**:
  - `recordReport` queues only `ask` and `blocked`. `"manual"` stays in the `Pending.kind` union, for saved state.
  - New `manualChecks(flow): HumanCheck[]` returns the `[manual]` items that are not skipped, in ID order. Its `text` is `<title> — do: <Steps> — look for: <Look for>`, using `bodyField`, and leaving out empty fields.
  - `testOutcome` leaves `manual` items out of `open:` and adds a part `human checks: S4, S7` after `open:` and before `skipped:` when there are any. `ok` keeps its current rule.

**`wait_for_user {kind: "verify"}` contract**

- The kind union is `approve | act | verify`.
- `verify` is handled right after the phase, plan and reason checks, before the check validation and before autopilot. `check` and `manual` are ignored, and nothing is run or polled.
- **Step handling:**
  - If `step` names a planned Verify step (`parseVerifyStep` is not null), the plan is not changed.
  - Otherwise `verifyAmendment(nextAmendmentNumber(), {steps: reason, step})` is appended, as in the existing unplanned-wait code.
  - If `step` names a checklist item that is not a Verify step (a test-only `Wait:`, per D3), that item is marked done.
  - Then `refreshChecklist()` (after the amendment), `persist()`, `updateStatus(ctx)`, `planMilestone(ctx)`.
- `state.waiting` is not set and no timer is started.
- **Reply text** (tests check the start): `Recorded as a human check for after the flow: <reason>. Don't wait; continue in this turn.`

**`summarizeFlow(outcome, ok, extra?: HumanCheck[])` contract**

- `fromPlan = humanChecks(state.approvedPlan, state.checklist)`; `all = [...fromPlan, ...(extra ?? [])]`.
- **Outcome suffix:** when `fromPlan.length > 0`, append ` · <n> human check(s) for you (see the card)`. Do this before the plan-flaw suffix line, or right after it; either is fine, as long as both suffixes appear.
  - The extra (test-flow) checks add no suffix, because `testOutcome` already names them.
- `steps` passed to the card is only the non-human items. It is undefined when that list is empty.
- `humanChecks: all` is put in the `SUMMARY_ENTRY` data next to `steps` and `findings`, when `all` has entries.
- The "no card" early return also needs `!all.length`.
- The plan-file outcome (`planMilestone` `text`) gets the suffixed outcome, as it does today.
- `finishTestFlow` calls `summarizeFlow(outcome.text, outcome.ok, manualChecks(flow))`.

**Compatibility**

- Old checklists are covered by `isHuman`.
- An old test-flow state with a `manual` pending entry: `askBatch` skips that entry with no prompt and no answer, and the item still shows in `manualChecks`.
- Old summaries render unchanged.
- `parseStatus` and the plan-status JSON are not changed.

**Scale**

Plans have about 5-40 steps and at most a few amendments, so every helper is a linear scan. The card shows at most 30 human checks; past that it adds a `+N more` line, the same as the findings section.

**Rejected alternatives**

- Keyword detection on `Wait:` text: rejected by D3, since it would also catch real prerequisites.
- Asking `[manual]` items once at the end of a test flow: rejected by D2.
- Auto-ticking Verify steps: it would make the card claim they were done.
- A separate tool: `wait_for_user` already has the `kind` field and the amendment mechanics.

### 5. Steps

**S1.** In `waits.ts`, add `VerifySpec`, `parseVerifyStep`, `verifyAmendment`, `HumanCheck` and `humanChecks`, exactly as in §4. Model them on `parseWaitStep` (`waits.ts:12-27`) and `waitAmendment` (`waits.ts:30-32`). Update the file's top comment to mention human checks.

**S2.** In `plan-doc.ts`:
- add `human?: true` to `ChecklistItem` and set it in `parseChecklist`;
- export `isHuman`;
- leave human items out of `openStepsReminder` and `planCard`, both the open list and the done/total counts;
- in `renderPlanFile`, split the checklist into `## Checklist` (non-human) and `## For you after the flow` (human), as in §4.

`mergeChecklist` needs no change beyond keeping the flag, which re-parsing already does.

**S3.** In `flow-report.ts`, extend `ReportLine.tone` with `"human"`, and give `reportLines` the optional third parameter and human section from §4. Model it on the findings section, including its cut and the `MAX_SHOWN` limit. In `view.ts`, add `humanChecks?` to `FlowSummary`, add `human: "accent"` to the tone map, and pass `s.humanChecks` to `reportLines` (`view.ts:225-226`).

**S4.** In `index.ts`:
- **Open-step counts:** import `isHuman`, and make every open-step and progress count ignore human items: lines 445 and 451; the `plan_check` reply at 2312-2318 (head count and Open list); `noChangeTurn` at 3159; `flowWithoutChanges` at 3174. The reminders at 2393 and 2531 are already covered by S2.
- **`wait_for_user`:** add `verify` to the `kind` union with the description `verify: a person must test or look at the result; nothing waits, it is listed for them after the flow`, and implement the verify branch from §4. Update the tool `description` to say:
  - "Pause the flow until a person has done something a later step needs (publish a package, open the Unity Editor so the unity CLI can run)."
  - "For a check only a person can do (play it in the Editor, look at visuals) use kind "verify": nothing pauses, the check is listed for the user after the flow."

  Keep the rest of the description.
- **Flow end:** change `summarizeFlow` as in §4, and pass `manualChecks(flow)` from `finishTestFlow`.
- **`askBatch`:** remove the `manual` prompt branch (1956-1957). A `manual` entry is skipped without a prompt, with no answer and no skip recorded.

**S5.** In `test-flow.ts`:
- change the `recordReport` queue loop (136-138) to queue only `ask` and `blocked`;
- add `manualChecks(flow): HumanCheck[]`, importing the type from `waits.ts`;
- change `testOutcome` as in §4;
- update the comment at `Pending` to say that `manual` is only kept for saved state.

**S6.** In `prompts.ts`:
- **`CHECKPOINTS`:** after the `Wait:` sentence, add: "A check only a person can do (play the scene in the Unity Editor and watch the animation, look at visuals, feel on a device) is `**S<n>.** Verify: <steps> — look for: <what>`, never a `Wait:`: the flow doesn't stop for it and lists it for the user at the end. Use `Wait:` only when a later step can't run until the person acts."
- **Executor rule (line 100):** add: "At a `Verify:` step don't stop and don't tick it: it is listed for the user after the flow. A `Wait:` step that only asks a person to test or look at the result is a Verify: call `wait_for_user` with `kind: "verify"` and its `step`, then continue in the same turn. Report an unplanned check only a person can do the same way, without `step`."
- **`TEST_PHASE` line 118:** change it to say that `[manual]` items are listed for the user after the flow, are not asked between rounds, and that the round goes on without them.

**S7.** In `pi/agent/extensions/workflow/README.md`:
- **"Wait points":** add a **Human checks** bullet. It covers the `Verify:` syntax; `wait_for_user {kind: "verify"}` (never pauses, adds `## Amendment N (executor: verify)`, ticks a named non-Verify step); that Verify steps are not open steps; the end card section "Human checks (after the flow)"; the outcome suffix; and the plan-file section "For you after the flow".
- **Tool line:** change it to `wait_for_user {reason, check?, step?, kind?, manual?}`.
- **Test flow "When it asks the user":** remove the `[manual]` clause.
- **"End":** add `; human checks: <IDs>` and say that `[manual]` items are listed on the card with their steps.

**S8.** In `docs/workflow-improvements.md`:
- **Section A table:** add row **A25** after A24. Problem: a flow paused until the user tested in Unity (a `Wait:` for testing, and test-flow `[manual]` questions between rounds). **Done:** human checks: `Verify:` steps, `wait_for_user {kind: "verify"}`, and `[manual]` deferred to the end card (`waits.ts`, `plan-doc.ts`, `flow-report.ts`, `view.ts`, `test-flow.ts`, `prompts.ts`, `index.ts`). Ratings: High (T), M, Low risk. Measure: pauses for human testing per flow.
- **Status line:** add A25 as implemented.
- **"Effect measurement":** add an A25 row: count `wait_for_user` calls without `kind: "verify"` whose reason mentions testing or looking, and test rounds ended only by `[manual]` answers, in session logs. Note "Implemented, not measured yet". Target: 0 pauses for human testing per flow.

### 6. Tests

All suites are fast. Run them from `pi/agent/extensions/workflow/` with the README's Tests command:
```
node --experimental-strip-types --test agent-end.test.ts folder-add.test.ts readonly-bash.test.ts readonly-tools.test.ts tokens.test.ts push-guard.test.ts knowledge.test.ts mcp-forward.test.ts subagent.test.ts delivery.test.ts notify.test.ts repos.test.ts stages.test.ts commit-guard.test.ts repo-diff.test.ts prompts.test.ts config.test.ts metrics.test.ts plan-store.test.ts boundary.test.ts plan-doc.test.ts runner-guard.test.ts test-report.test.ts test-run.test.ts test-flow.test.ts view.test.ts waits.test.ts checkpoints.test.ts tags.test.ts
```
Expected result: every test passes, with `fail 0`. Add `flow-report.test.ts` to this command (and to the README line) if it is not already listed.

**New or changed tests**

`waits.test.ts`:
- **verify step parse:**
  - `**S3.** Verify: play scene X — look for: no jitter` → `{steps: "play scene X", lookFor: "no jitter"}`;
  - `- [ ] **S4.** Verify: open menu (look for: icons)` → lookFor `icons`;
  - `**S5.** Verify: check it` → no lookFor;
  - `**S6.** Wait: publish` → null;
  - an unknown ID → null.
- **verifyAmendment format:** `verifyAmendment(2, {steps: "tap X", lookFor: "glow", step: "S4"})` equals `## Amendment 2 (executor: verify)\ntap X — look for: glow (step S4)`.
- **humanChecks order:** a plan with Verify step S2, a verify amendment without step, and a verify amendment with `(step S2)` → two entries: S2 first, then the amendment text without id. The S2 duplicate is dropped.

`plan-doc.test.ts`:
- **human flag:** `parseChecklist` on `**S1.** Edit\n**S2.** Verify: play` → S2 has `human: true`. After `mergeChecklist` it still does.
- **openStepsReminder ignores human:** with only S2 (human) open → undefined.
- **renderPlanFile human section:** the output has `## For you after the flow` with `- S2 Verify: play`, and `## Checklist` without S2.
- **planCard counts:** with S1 done and S2 human → `1 of 1 done` and `(none open)`.

`flow-report.test.ts`:
- **human lines:** `reportLines(undefined, undefined, [{id: "S5", text: "play it"}, {text: "look"}])` gives a head `Human checks (after the flow): 2` and lines `  ☐ S5 play it` and `  ☐ look`, with tone `human`.
- No third argument → output unchanged from today.

`test-flow.test.ts`:
- **manual not queued:** after `recordReport` with a `[manual]` item and an `[ask]` item, `pending` holds only the ask.
- **manual-only report ends clean:** a report with `[fixed]` plus `[manual]` → `pending` is empty, and `testOutcome` text has `human checks: S2` and no `S2 manual` under `open:`. `ok` is true.
- **manualChecks:** the text includes the title, `do: <Steps>` and `look for: <Look for>`; skipped items are left out.

`prompts.test.ts`:
- the planner text (`planPhase(true)`) includes `Verify:` and still includes `Wait:`;
- the execute prompt includes `kind: "verify"`;
- `TEST_PHASE` includes `after the flow`.

`view.test.ts`: if the summary rendering is covered there, add one case where `humanChecks` shows its head line. Otherwise skip it.

### 7. Done when

- An execute flow whose plan has `Verify:` steps never pauses at them. A stage or flow ends without "steps are still open" questions caused by them. The end card lists them under "Human checks (after the flow)", the outcome ends with `· N human check(s) for you (see the card)`, and the plan file shows them under "For you after the flow".
- `wait_for_user {kind: "verify"}` never pauses, never polls and never sets a wait, with or without autopilot. It records an amendment, or uses the planned Verify step, ticks a named non-Verify step, and replies with the "Recorded as a human check" text.
- A test flow never prompts for `[manual]` items. It ends when only `[manual]` items (plus fixed or skipped ones) remain. Its outcome contains `human checks: <IDs>`, and its card lists each item with its steps.
- `Wait:` steps, `approve`/`act` waits, `[ask]`/`[blocked]`/refail/dispute questions and `ok` behave as before.
- The planner, executor and test prompts say what §5 S6 says.
- The README and `docs/workflow-improvements.md` (A25 row, Status line, Effect-measurement row) are updated.
- All tests pass.

### 8. Risks, rollback, what not to touch

**Risks**
- Missing an open-step count in `index.ts` would still block a flow on a Verify step. Grep `!i.done` and `.done)` in `index.ts` and check each one.
- The double outcome suffix in test flows: the test-flow extras deliberately add no suffix.

**Rollback:** revert the commit. Saved state stays readable, because all new fields are optional.

**Do not touch:**
- the wait polling, timers and `state.waiting` logic;
- `parseStatus` and the plan status JSON;
- the stage parsing in `stages.ts`;
- the `approve`/`act` autopilot text in `waits.ts`;
- `test-report.ts`, where the `[manual]` tag and its fields stay valid;
- the public contract (K1-K6).

### 9. Commits

One commit:
- **Subject:** `workflow: defer human checks to the end of the flow (Verify steps, verify waits, [manual] items)`
- **Files** (all in `pi/agent/extensions/workflow/` unless noted):
  - `waits.ts`, `waits.test.ts`
  - `plan-doc.ts`, `plan-doc.test.ts`
  - `flow-report.ts`, `flow-report.test.ts`
  - `view.ts` (and `view.test.ts` if changed)
  - `test-flow.ts`, `test-flow.test.ts`
  - `prompts.ts`, `prompts.test.ts`
  - `index.ts`
  - `README.md`
  - `docs/workflow-improvements.md` (at the repo root)

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 In `waits.ts`, add `VerifySpec`, `parseVerifyStep`, `verifyAmendment`, `HumanCheck` and `humanChecks`, exactly as in §4.
- [ ] S2 In `plan-doc.ts`:
- [ ] S3 In `flow-report.ts`, extend `ReportLine.tone` with `"human"`, and give `reportLines` the optional third parameter and hu
- [ ] S4 In `index.ts`:
- [ ] S5 In `test-flow.ts`:
- [ ] S6 In `prompts.ts`:
- [ ] S7 In `pi/agent/extensions/workflow/README.md`:
- [ ] S8 In `docs/workflow-improvements.md`:
