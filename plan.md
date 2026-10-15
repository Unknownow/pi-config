<!-- pi-workflow plan v1 flow=20261015-2309-end-of-flow-report-card-for-every-flow-m-baec -->
## Plan: End-of-flow report card for every flow; menus instead of silent stalls

### 1. Goal and non-goals
**Goal:** every workflow flow ends with an end-of-flow report card, whether it succeeds or fails. The card stays visible after compaction, and a flow never stalls in the execute phase without a menu.
- **What the card shows:** the token bars as today, the outcome (with the stop reason when the flow failed), the plan steps marked done or open, and every finding raised during the flow, marked open, fixed or noted.
- **Model-token cost:** zero. The card is a display-only session entry with its own renderer, never sent to the model.

**Non-goals:**
- No change to:
  - prompts;
  - the judge or arbiter logic;
  - the "Diff ready, judge it?" confirm, or what happens when the user declines it;
  - the "Stage ended with no changes" prompt, or what happens when the user declines it;
  - the commit step;
  - config keys.
- No LLM-written summary.
- No parallel executors (left for later).

### 2. User decisions
- **D1** At the end of a flow, show a checklist of what was done, plus the findings.
- **D2** The report must survive the compaction that often happens at the end of a flow.
- **D3** Use as few tokens as possible. The report is built by code from workflow state and costs zero model tokens.
- **D4** List every finding raised during the flow (open, fixed, noted), because it costs no model tokens. Findings are deduplicated per stage, and the stored list is bounded.
- **D5** Every flow gets the report, whether it succeeded or failed, including "Back to planning" and `/flow plan`/`/flow off` during a flow.
- **D6** No silent stalls in execute. When the judge fails to run, or the executor's reply ends in an error, show a menu: Retry, Back to planning, Stop. Escape means Stop, as in the existing menus.
- **D7** The two stalls the user chose themselves stay as they are: declining "Diff ready, judge it?" and declining "Stage ended with no changes".
- **D8** Accepted limit: a reworded finding shows as one fixed finding and one new one.

### 3. Facts the executor needs
All paths are in `pi/agent/extensions/workflow/`.

`index.ts`:
- `:96` `interface FlowState`.
- `:174` `SUMMARY_ENTRY = "workflow-summary"`. It is display-only, never sent to the model.
- `:1728` its renderer: `new Text(summaryLines(entry.data, theme).join("\n"), 1, 0)`.
- `:319-333` `summarizeFlow(outcome, ok)`:
  - It returns `false` and writes no card when `!view.hasFlowUsage()` (`:326`). Callers use the return value as `if (!shown) persist()`.
  - It writes the plan milestone with `finished` at `:323`; `planMilestone` sets `doc.finished` at `:989`.
- `:336` `endFlow(ctx)` calls `setPhase(ctx, "plan")` when `returnToPlan` says so.
- `:388-416` `setPhase`:
  - `:393` writes an "abandoned" milestone when leaving execute with an unfinished plan doc.
  - `:405-416` clears the flow state when the target is the plan phase.
- `:428` `startExecution(ctx, plan)`: the start of a new flow, called at `:462` and `:1820`.
- `:797` `judge(...)`:
  - `:1331` returns `"ERROR"` when the subagent fails.
  - `:1350` computes `verdict`.
  - `:1357` sets `state.lastJudge`.
- `:1826` `pi.on("session_compact", async (event) => {...})`. Only the overflow line is there today. The event has `compactionEntry` with `id` and `firstKeptEntryId`. pi awaits this handler before it redraws the chat.
- `:1855` `onAgentEnd`:
  - `:1860` overflow resume, handled first.
  - `:1891` returns when there is no UI.
  - `:1927` `if (skipJudge(last)) return;` is a silent stall.
- `:2012` `stoppedSummary(text)` builds a stop outcome that includes the stages already delivered, and clears the stage state.
- `:2166-2169` in `reviewDiff`, `if (r.verdict === "ERROR") { notify; return; }` is a silent stall.
- `:2193-2212` `fixOrAsk`. This is the menu pattern to model on: `ctx.ui.select`, then `summarizeFlow(stoppedSummary(...), false)` and `endFlow(ctx)` on Stop.
- `:2239-2242` the "Back to planning" branch of `resolvePlanFlaw` calls `setPhase(ctx, "plan")` with no summary.
- `:2779-2783` `/flow plan|execute|off` calls `setPhase`.
- `:2822` a mid-flow peek entry with `title: "flow so far"`. It must never be re-posted.

`view.ts`:
- `:83` `interface FlowSummary`.
- `:186` `summaryLines(s, theme)`.
- `view.ts` imports `@earendil-works/pi-tui` at runtime, so tests can't import it. Put pure logic in a new module with no imports.

`plan-doc.ts:5` `ChecklistItem {id, text, stage?, done}`. `state.checklist` holds the ticks.

`agent-end.ts:118-121`: the finding headline pattern is `/^\S.*\s-\s*(blocker|major|minor)\s*-/i`.

`SessionEntryBase` has `type` and `id`. Custom entries are `{type: "custom", customType, data}`. Read them with `ctx.sessionManager.getEntries()`.

Tests: `node --test *.test.ts` in the workflow directory. Baseline: 414 tests, 0 failing.

### 4. Design
**New pure module `flow-report.ts`**, with no imports (type-only imports allowed):
```ts
export type FindingStatus = "open" | "fixed" | "noted";
export interface FlowFinding { line: string; stage?: number; open: boolean }
export interface ReportFinding { line: string; stage?: number; status: FindingStatus }
export interface ReportStep { id: string; text: string; done: boolean }
export interface ReportLine { text: string; tone: "head" | "done" | "open" | "fixed" | "noted" }
export function recordFindings(list: FlowFinding[] | undefined, stage: number | undefined, report: string): FlowFinding[];
export function reportFindings(list: FlowFinding[] | undefined, plan: string | undefined): ReportFinding[];
export function reportLines(steps: ReportStep[] | undefined, findings: ReportFinding[] | undefined): ReportLine[];
```

**`recordFindings`** returns a new array and never mutates its input.
- **Headlines:** the lines of `report` (split on `\r?\n`) that match the headline pattern in §3, trimmed.
- **Previous findings:** every entry with the same `stage` (`undefined` equals `undefined`) gets `open: false`. Entries of other stages are kept unchanged.
- **This report's findings:** an existing same-stage entry with an identical `line` becomes `open: true`; otherwise a new `{line, stage, open: true}` is appended.
- **Cap:** at most 50 entries. Over the cap, drop the oldest `open: false` entries first, then the oldest entries.

**`reportFindings`** gives each entry a status:
- `open: false` becomes `"fixed"`;
- `open: true` becomes `"noted"` when the line contains `[plan-flaw]` (case-insensitive) and `plan` includes the line;
- otherwise `"open"`.

**`reportLines`**, exact formats (the tests check them):
- **Steps:** when `steps` has items:
  - a head line `` `Steps ${done}/${total} done` ``;
  - one line per step: `` `  ✓ ${id} ${text}` `` when done (tone `done`), `` `  ○ ${id} ${text}` `` when open (tone `open`).
  - `text` is the first line of the step text. When it is longer than 100 characters, cut it to 99 characters plus `…`.
- **Findings:** when `findings` has items:
  - a head line `` `Findings: ${open} open · ${fixed} fixed · ${noted} noted` ``;
  - the findings ordered open, then noted, then fixed (stable within each group);
  - at most 30 finding lines, each `` `  ${status.padEnd(5)} ${stage !== undefined ? `[stage ${stage}] ` : ""}${line}` ``, with tone equal to the status;
  - `line` is cut at 120 characters the same way (119 characters plus `…`);
  - when more than 30 remain, a last line `` `  +${rest} more` `` with tone `fixed`.
- **Nothing to show:** when both lists are empty or missing, return `[]`.

**`FlowSummary` (`view.ts:83`)** gets three optional fields:
- `steps?: ReportStep[]`;
- `findings?: ReportFinding[]`;
- `reposted?: boolean`.

Older entries without these fields render as today.

**`summaryLines`** appends `reportLines(s.steps, s.findings)` after the token bars. Tone colours:
- `head`: `text`, bold;
- `done`: `success`;
- `open`: `warning`;
- `fixed`: `dim`;
- `noted`: `muted`.

**`FlowState`** gets two optional fields:
- `flowFindings?: FlowFinding[]` (the findings log of the current flow);
- `flowSummarized?: boolean` (the card for the current flow has been written).

Older saved state without them reads as empty or false, so no migration is needed.

**Card written once per flow:**
- `summarizeFlow` sets `flowSummarized = true`.
- `startExecution` resets `flowSummarized` and `flowFindings`.
- `setPhase` writes a failed card only when `flowSummarized` is not set.

**Compaction re-post rule**, in the `session_compact` handler:
1. With `entries = ctx.sessionManager.getEntries()`, find:
   - `c`, the index of `event.compactionEntry.id`;
   - `k`, the index of `firstKeptEntryId` (-1 if not found);
   - `p`, the index of the last `type === "compaction"` entry before `c` (-1 if none);
   - `s`, the index of the last entry before `c` with `type === "custom"`, `customType === SUMMARY_ENTRY`, `data.title === undefined` and `!data.reposted`.
2. Re-post when `s > p` and (`k === -1` or `s < k`): `pi.appendEntry(SUMMARY_ENTRY, { ...data, reposted: true })`.
3. A reposted card is never re-posted again. A newer flow's card supersedes an older one, because the rule looks only at the latest card.

**Failure handling:** if entry lookup throws, the handler catches the error and skips the re-post. It never breaks compaction.

**Scale:**
- A findings log has at most 50 entries of about 200 bytes, about 10 KB in each `persist()` snapshot.
- 30 findings are shown.
- The design stops being complete above 50 distinct findings per flow. The oldest fixed findings are dropped first.

**Rejected:**
- An LLM summary: it costs tokens (D3).
- A `sendMessage` card: it enters the model's context.
- Keeping only the last report's findings: the user chose all (D4).

### 5. Steps
**S1.** Create `flow-report.ts` exactly as in §4 (`recordFindings`, `reportFindings`, `reportLines`, and the types).
- Write a one-line doc comment per export, modelled on `agent-end.ts:89-121`.
- Use the headline regex from `agent-end.ts:121`, copied into this module.

**S2.** `view.ts`: extend `FlowSummary` (`:83`) and `summaryLines` (`:186`) as in §4. Import the types and `reportLines` from `./flow-report.ts`. Colour lines through `theme.fg` and `theme.bold`, as in `view.ts:190-195`.

**S3.** `index.ts` `FlowState` (`:96`): add `flowFindings?: FlowFinding[]` and `flowSummarized?: boolean`, each with a one-line doc comment. In `startExecution` (`:428`), set both to `undefined`.

**S4.** `index.ts` `judge()`, right after `verdict` is computed (`:1350`):
- Only when `state.phase === "execute"`: `state.flowFindings = recordFindings(state.flowFindings, state.stage, text)`.
- The existing `persist()` at `:1359` saves it.
- `ERROR` results return earlier (`:1331`), so they are never recorded.

**S5.** `index.ts` `summarizeFlow` (`:319`):
- Build `steps` from `state.checklist`, mapping `{id, text, done}`, or `undefined` when there is no checklist.
- Build `findings` with `reportFindings(state.flowFindings, state.approvedPlan)`, or `undefined` when empty.
- Do this before anything is cleared, and after the `unresolvedPlanFlaws` outcome suffix is added.
- Write the card when `view.hasFlowUsage()`, or when `steps` or `findings` has items: `pi.appendEntry(SUMMARY_ENTRY, { ...view.endFlow(outcome, ok), steps, findings })`, then `persist()`, then return `true`.
- Otherwise keep today's early-return path.
- In all cases set `state.flowSummarized = true` and `state.flowFindings = undefined`.
- Keep the other existing behaviour: the plan milestone, `touchedRepos`, `settleMain`.

**S6.** `index.ts` `setPhase` (`:388`), first statement:
- Condition: `state.phase === "execute" && phase !== "execute" && state.approvedPlan && !state.flowSummarized`.
- Action: call `summarizeFlow(stoppedSummary(phase === "plan" ? "back to planning" : "abandoned"), false)`.
- It must run before the `:393` "abandoned" milestone. That milestone is then skipped, because `summarizeFlow` has finished the plan doc.
- This covers "Back to planning" in `resolvePlanFlaw` (`:2239-2242`) and in the S7/S8 menus, and `/flow plan`/`/flow off` (`:2779-2783`).
- A normal end (`summarizeFlow` then `endFlow` then `setPhase`) writes no second card.

**S7.** `index.ts` `reviewDiff` judge-ERROR branch (`:2166-2169`). Keep the error notify, then show the menu `ctx.ui.select("The judge failed to run", ["Retry the judge", "Back to planning", "Stop"])`:
- **Retry the judge:** `await reviewDiff(ctx, true)`, then return.
- **Back to planning:** `await setPhase(ctx, "plan")` (S6 writes the card), then return.
- **Anything else, including Escape:** notify `workflow: stopped: the judge failed to run` (warning), then `summarizeFlow(stoppedSummary("stopped: the judge failed to run"), false)` and `await endFlow(ctx)`.

Model it on `fixOrAsk` (`:2193-2212`). When `!ctx.hasUI`, keep today's notify-and-return.

**S8.** `index.ts` `onAgentEnd`, replacing `if (skipJudge(last)) return;` (`:1927`): when `skipJudge(last)`, show `ctx.ui.select("The executor's last reply ended in an error", ["Retry", "Back to planning", "Stop"])`:
- **Retry:** `pi.sendMessage({ customType: "workflow-retry", content: "Your last reply ended in an error. Continue with the open steps of the approved plan.", display: true }, { triggerTurn: true, deliverAs: "followUp" })`.
- **Back to planning:** `await setPhase(ctx, "plan")`.
- **Anything else, including Escape:** notify `workflow: stopped: the executor's reply failed` (warning), then `summarizeFlow(stoppedSummary("stopped: the executor's reply failed"), false)` and `await endFlow(ctx)`.

Return after each branch. The `:1891` no-UI return and the `:1860` overflow resume keep running first, unchanged.

**S9.** `index.ts` `session_compact` handler (`:1826`):
- Change the signature to `async (event, ctx)`.
- Keep the overflow line.
- Add the re-post rule from §4, wrapped in `try`/`catch` that ignores errors.

**S10.** `README.md`: in the section that describes the end-of-flow summary or token breakdown (find it with `grep -n "flow done\|token breakdown\|summary" README.md`), add one short paragraph:
- every flow, successful or stopped, ends with a card of token bars, plan steps (done/open) and all findings of the flow (open/fixed/noted);
- the card is never sent to the model;
- it is shown again once if a compaction hides it;
- the judge-failed and executor-error menus offer Retry, Back to planning and Stop.

### 6. Tests
New file **`flow-report.test.ts`**, using `node:test` and `node:assert/strict` (model on `tokens.test.ts:1-4`):
1. **`recordFindings marks findings missing from the next report as fixed`:**
   - Report A: `"a.ts:1 - major - [bug] x\na.ts:2 - minor - [bug] y\nVERDICT: FAIL"`. Then report B: `"a.ts:2 - minor - [bug] y\nVERDICT: PASS"`. Both with stage `undefined`.
   - Expected: `[{line:"a.ts:1 - major - [bug] x", open:false}, {line:"a.ts:2 - minor - [bug] y", open:true}]`, with the `stage` key undefined. Use `deepEqual` after mapping to `{line, open}`.
   - The input array is unchanged after the call.
2. **`recordFindings keeps other stages untouched and caps at 50`:**
   - Stage 1 report with one line, then a stage 2 report with another line: the stage 1 entry is still `open: true`.
   - Then 60 distinct lines recorded one per report, in stage 3: the length is 50, and the last entry is the 60th line.
3. **`reportFindings marks noted plan flaws`:**
   - `[{line:"a.ts:1 - minor - [plan-flaw] p", open:true}, {line:"b.ts:1 - minor - [bug] q", open:true}, {line:"c.ts:1 - major - [bug] r", open:false}]` with the plan `"...\na.ts:1 - minor - [plan-flaw] p"`.
   - Expected statuses: `noted`, `open`, `fixed`.
   - Without the plan, the first one is `open`.
4. **`reportLines formats steps and findings`:**
   - Steps `[{id:"S1",text:"do x\nmore",done:true},{id:"S2",text:"do y",done:false}]`; findings with one each of open, fixed and noted.
   - Expected texts in order:
     - `"Steps 1/2 done"`;
     - `"  ✓ S1 do x"`;
     - `"  ○ S2 do y"`;
     - `"Findings: 1 open · 1 fixed · 1 noted"`;
     - the open line, then the noted line, then the fixed line, each starting `"  open  "`, `"  noted "`, `"  fixed "`.
   - Tones are `head, done, open, head, open, noted, fixed`.
5. **`reportLines caps findings at 30 and is empty with nothing to show`:**
   - 35 open findings give the head line, 30 finding lines and `"  +5 more"`.
   - `reportLines(undefined, [])` returns `[]`.
   - A 150-character finding line is cut to 119 characters plus `…`.

The menu, `setPhase` and compaction wiring live in `index.ts` closures; they get no unit tests.

Commands, in `pi/agent/extensions/workflow`:
- `node --test *.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)"` should print `ℹ tests 419`, `ℹ pass 419`, `ℹ fail 0`.
- `grep -c $'\r' flow-report.ts flow-report.test.ts view.ts index.ts` should print 0 for each file.

### 7. Done when
- Every flow that ends writes exactly one end-of-flow card, success or failure. That includes:
  - commit done or failed;
  - a stop from any menu;
  - "Back to planning" from any menu;
  - `/flow plan` and `/flow off` during a flow.
- **Card contents:**
  - the token bars and the outcome, with the stop reason on failure;
  - the plan steps with done/open marks;
  - all findings raised in the flow, marked open, fixed or noted, with the formats in §4.
- The card costs zero model tokens: it is written only with `pi.appendEntry` and never with `sendMessage`.
- When a compaction pushes the latest flow card out of view, the card appears again once after the compaction. A card still in view, a reposted card, and a "flow so far" peek are not re-posted.
- **No silent stalls:**
  - when the judge fails to run, the menu Retry the judge / Back to planning / Stop appears;
  - when the executor's reply ends in an error, the menu Retry / Back to planning / Stop appears;
  - Escape acts as Stop.
- Declining "Diff ready, judge it?" and "Stage ended with no changes" behaves as today.
- All workflow tests pass, including the 5 new ones. The README describes the card and the menus.

### 8. Risks, rollback, what not to touch
**Risks:**
- Escape on the new menus ends the flow. This follows the convention of the existing menus.
- Retry after an API error may fail again; the menu then shows again.
- A reworded finding appears as fixed plus new (D8).
- Writing the card from `setPhase` depends on `stoppedSummary` clearing the stage state before `setPhase` clears the rest. Both run in the same synchronous order.

**Rollback:** revert the single commit.

**Don't touch:** `prompts.ts`, `config.ts`, `plan-doc.ts`, `agent-end.ts`, the judge and arbiter logic, `resolvePlanFlaw`'s options, the commit step, the "Diff ready" confirm and the "Stage ended with no changes" prompt.

**Before you finish:** don't run the judge and an edit in parallel.

### 9. Commits
- `feat(workflow): end-of-flow report card with steps and findings for every flow` (files: `pi/agent/extensions/workflow/flow-report.ts`, `flow-report.test.ts`, `view.ts`, `index.ts`, `README.md`)

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 Create `flow-report.ts` exactly as in §4 (`recordFindings`, `reportFindings`, `reportLines`, and the types).
- [ ] S2 `view.ts`: extend `FlowSummary` (`:83`) and `summaryLines` (`:186`) as in §4. Import the types and `reportLines` from `.
- [ ] S3 `index.ts` `FlowState` (`:96`): add `flowFindings?: FlowFinding[]` and `flowSummarized?: boolean`, each with a one-line 
- [ ] S4 `index.ts` `judge()`, right after `verdict` is computed (`:1350`):
- [ ] S5 `index.ts` `summarizeFlow` (`:319`):
- [ ] S6 `index.ts` `setPhase` (`:388`), first statement:
- [ ] S7 `index.ts` `reviewDiff` judge-ERROR branch (`:2166-2169`). Keep the error notify, then show the menu `ctx.ui.select("The
- [ ] S8 `index.ts` `onAgentEnd`, replacing `if (skipJudge(last)) return;` (`:1927`): when `skipJudge(last)`, show `ctx.ui.select
- [ ] S9 `index.ts` `session_compact` handler (`:1826`):
- [ ] S10 `README.md`: in the section that describes the end-of-flow summary or token breakdown (find it with `grep -n "flow done\
