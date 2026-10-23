<!-- pi-workflow plan v1 flow=20261023-0907-discuss-phase-before-planning-4a62 -->
## Plan: Discuss phase before planning

### 1. Goal and non-goals
**Goal:**
- Add a read-only `discuss` phase, where the user and the agent talk the problem through without writing `Plan:` sections and without approval menus.
- Refocus the `plan` phase on turning the discussion into a plan, checking it and fixing it.
- New sessions and finished flows land in `discuss`.

**Non-goals:**
- No change to execute, test, judge, arbiter, finalize, stages or delivery behaviour.
- No new phrase config to leave discuss (no `planPattern`).
- No menu after discuss replies.
- No change to the tool allow and block lists themselves.

### 2. User decisions
- **D1:** New sessions start in `discuss` (`startPhase` default `"discuss"`).
- **D2:** When a flow ends, the session goes back to `discuss`.
- **D3:** Leaving discuss is by command (`/flow plan`). There is no menu after discuss replies and no separate phrase config.
- **D4:** In discuss, a typed approval phrase ("go", matched by `approvePattern`) works like `/flow plan`: it switches to plan and asks for the plan. It never approves or executes anything.
- **D5:** Discuss uses the same model as plan (its own `discuss` role, with the same model and thinking as `plan`, in both DEFAULTS and the user's `workflow.json`).
- **D6:** Discuss is read-only, with exactly the plan phase's tool rules.
- **D7:** From plan you can go back to discuss with `/flow discuss` and with a "Back to discussion" entry in the plan menu. The transcript is kept.
- **D8:** `returnToPlan` is replaced by `returnTo: "discuss" | "plan" | "off"`. The old boolean is still read when `returnTo` is not set (`true` = `"plan"`, `false` = `"off"`).
- **D9:** One commit, no stages.

### 3. Facts (paths relative to `pi/agent/extensions/workflow/`)
**Phases and tool rules**
- `index.ts:111`: `type Phase = "off" | "plan" | "execute" | "test"`.
- `index.ts:364-366`: the `--flow` flag and its description.
- `index.ts:4228`: valid start values for the flag.
- `index.ts:446-450`: `updateStatus` maps the phase to `view.stage`.
- `index.ts:542-544`: `phaseStage()`.
- `index.ts:511-520`: `blockPlanTools(phase: "plan"|"test")` and `planToolRefusedIn`.
- `index.ts:524`: tools registered late are re-filtered only in plan or test.
- `index.ts:4211`: re-blocks tools on reload for plan or test.

**`setPhase` (`index.ts:553-595`)**
- `readOnly()` at 560.
- Plan-state reset when `phase === "plan"` at 584.
- The `stoppedSummary` text at 556.

**Plan-phase hooks and approval**
- `index.ts:2814`: plan-phase `tool_call` guard, `if (state.phase !== "plan") return;`.
- `index.ts:3055-3070`: input handler for approval in plan. The model for transforming a message after `setPhase` is the existing approve path at 3067-3069.
- `index.ts:3159-3190`: plan menu after each reply, including "Keep discussing" at 3179.
- `index.ts:664`: `approve()`.

**Flow end, commands and status**
- `index.ts:425-439`: `endFlow` uses `phaseAfterFlow(cfg.returnToPlan, state.phase)`.
- `agent-end.ts:92-95`: `phaseAfterFlow`. Its tests are at `agent-end.test.ts:152-156`.
- `index.ts:4263-4275`: `SUBCOMMANDS` list.
- `index.ts:4456-4480`: `/flow` subcommand switch (plan, execute and off share a case, then `approve`).
- `index.ts:4281`: `statusText()`.

**Config (`config.ts`)**
- `config.ts:17`: `ROLES` list.
- `config.ts:123`: `startPhase` type. `config.ts:135`: `returnToPlan`. Defaults at 215-236.
- `config.ts:340+`: `parseConfig` validation block. Model new checks on the lines there.

**Prompts (`prompts.ts`)**
- `planPhase()` returns the plan text. The first lines of the text come from `prompts.ts:43-46`.
- `phaseSection` is at `prompts.ts:162`.
- `SHOW_PLAN` is the model for a short exported message constant.

**View (`view.ts`)**
- `view.ts:28`: `Stage` type. `view.ts:81`: `STAGES`.
- `view.ts:95-96` and `view.ts:124`: per-stage records.
- `view.ts:323`: phase union. `view.ts:570`: flow strip.

**Other**
- `notify.ts:35`: `idleReason`.
- `pi/agent/workflow.json`: the user's config. It has `roles.plan` (opus-5-5, thinking `medium`) at line 4, `"startPhase": "plan"` at line 45 and `"returnToPlan": true` at line 51.
- `README.md`: the role table at lines 19-21, the "Plan phase is read-only" section at line 189, Commands at line 362, the `returnToPlan` mentions at lines 22, 112 and 124, and the test command at line 226.
- `docs/workflow-improvements.md`: Status line at line 5. The last D row is D18 (line 116), with its Effect measurement row at line 172. The next free ID is D19.

### 4. Design
**Phase:**
- `Phase = "off" | "discuss" | "plan" | "execute" | "test"`.
- Discuss is read-only exactly like plan. Wherever the code tests "plan or test" for tool filtering, discuss uses the **plan** rules: `blockPlanTools("plan")`, `planAllowedTools()`, `cfg.planBlockedTools`, `planReadOnlyBash`.
- When switching between discuss and plan, the tool snapshot is kept: no restore and re-block. Both are read-only with the same rules, so `toolsBeforePlan` stays as it is.

**Role:** `ROLES` gains `"discuss"`, and `applyRole(ctx, "discuss")` runs on entry.
- DEFAULTS: `discuss: { model: "claude-bridge/claude-opus-5-5", thinking: "high" }`, the same as `plan`.
- `workflow.json`: `discuss` copies its `plan` entry (opus-5-5, `medium`).

**Config contract:**
- `startPhase: "discuss" | "plan" | "execute" | "off"`, default `"discuss"`.
- New `returnTo: "discuss" | "plan" | "off"`, default `"discuss"`.
- Keep `returnToPlan?: boolean` as an optional legacy key, with no default value in DEFAULTS.
- `parseConfig` handles the migration:
  - The user file sets `returnTo` to a valid value: use it.
  - Else the file sets a boolean `returnToPlan`: `true` becomes `"plan"`, `false` becomes `"off"`.
  - Else: the default.
  - An invalid `returnTo` falls back to the same rules.
  - An invalid `startPhase` (also accept `"test"`, which the flag already accepts) falls back to the default.
- Because `merge` copies DEFAULTS, the migration must check what the *raw* parsed JSON contained, not the merged object.

**`phaseAfterFlow(returnTo, phase)`:**
- New signature: `(returnTo: "discuss" | "plan" | "off", phase: Phase-like): "discuss" | "plan" | undefined`.
- Returns `returnTo` when `phase` is execute or test and `returnTo !== "off"`. Otherwise it returns `undefined`.
- `endFlow` switches to the returned phase and notifies "back to discussion on <model>" or "back to planning on <model>".

**Discuss → plan (kickoff):**
- New exported constant `PLAN_KICKOFF` in `prompts.ts`. It tells the planner: the discussion is over, write the `Plan:` now from the discussion and its last `Agreed so far:` list, follow the plan-phase rules, and ask only about what blocks the plan.
- Triggers:
  - (a) `/flow plan` while in discuss: `setPhase(ctx, "plan")`, then `pi.sendMessage({ customType: "workflow-plan-kickoff", content: PLAN_KICKOFF, display: true }, { triggerTurn: true, deliverAs: "followUp" })`.
  - (b) A typed message (not from an extension, not streaming, not a `/` command) in discuss that matches `approveRe()`: `setPhase(ctx, "plan")` and return `{ action: "transform", text: "<typed text>\n\n" + PLAN_KICKOFF }`. Nothing is approved, `chooseDelivery` is not called, and nothing executes. A message that doesn't match passes through unchanged.
  - `/flow approve` in discuss behaves exactly like (a) and notifies "workflow: discuss phase; moving to planning first".
  - `/flow plan` from off, execute or test switches without a kickoff, as today.
  - `/flow plan` while already in plan only notifies the phase. No kickoff, and no reset of plan state: keep today's behaviour, which calls `setPhase` and so resets plan state.

**Plan → discuss:**
- `/flow discuss` calls `setPhase(ctx, "discuss")`. That clears plan-only state (`planReady`, `planProposed`, `finalizing`, `approvedPlan`, `delivery` and so on) in the same way the `phase === "plan"` branch at `index.ts:584` does. Extend that condition to discuss.
- From execute or test, `/flow discuss` works like `/flow plan` today: it ends the running flow with the "back to planning" summary. The text becomes "back to discussion" for discuss.
- The plan menu gets a "Back to discussion" entry just before "Keep discussing". Choosing it switches to discuss, notifies, and sends no message.

**Discuss reply handling:**
- No menu, no `planReady`, and no "go" approval.
- On `agent_end` in discuss, show nothing besides the existing idle notification.
- `idleReason` returns `"discuss reply ready"` for discuss.

**View:**
- `Stage` gains `"discuss"`, placed first in `STAGES`. The per-stage records gain a `discuss` key.
- The flow strip shows a `discuss` node before `plan`, with the `discuss` role model.
- `updateStatus`/`phaseStage` map discuss to the `"discuss"` stage. The fallback line at 450 must also treat `"discuss"` like `"plan"`.
- Persisted or restored stage-token records without a `discuss` key read as zero and must not crash. Fill missing keys from `emptyStageTokens()` wherever usage records are restored or summed.

**Prompt (discuss):** new `DISCUSS_PHASE`, built from the plan prompt's reusable pieces (`batchLine`, `PACE`, the read-only line, the investigating line, the design-topics line). Its content:
- You are the user's partner for exploring the problem before planning, and you change nothing.
- Investigate, answer, push back, recommend one option, and ask about anything unclear.
- Don't write `Plan:` sections or step lists.
- When the discussion settles, end with a short `Agreed so far:` list (decisions, constraints, open questions) and mention that `/flow plan` or "go" moves to planning.

`phaseSection("discuss", …)` returns it.

**Prompt (plan):** replace "You are the planner and the user's partner in discussion. Investigate, answer questions, weigh options and agree on a plan." with wording like this: you are the planner. The discussion happened in the discuss phase. Turn it into a plan, check it against the code (explore, advisor at real decision points), and fix it with the user. Ask only about what blocks the plan. The rest of `planPhase` stays exactly as it is.

**Failure handling:** if `applyRole` fails (model not found), it already notifies. The phase still switches, as today.

**Scale:** single session, no new I/O.

**Rejected:**
- A menu after discuss replies (D3).
- A phrase config (D3).
- Reusing the `plan` role for discuss (D5 asked for the same model; a separate role keeps it tunable).
- A new session per phase: it would lose the context.

### 5. Steps

**S1.** `config.ts`:
- `ROLES` (line 17): add `"discuss"` as the first entry.
- `WorkflowConfig` (lines 123 and 135): `startPhase` gets the type from §4. Replace `returnToPlan: boolean` with `returnTo: "discuss" | "plan" | "off"`, plus the legacy optional `returnToPlan?: boolean` with a doc comment saying it is used only when `returnTo` is unset.
- DEFAULTS: add the `discuss` role, `startPhase: "discuss"` and `returnTo: "discuss"`. Remove `returnToPlan` from DEFAULTS.
- `parseConfig`: add the `returnTo` migration and the `startPhase` validation from §4. Read the raw JSON object for "was it set" (parse it once and pass it to both `merge` and the checks). Model these on the existing validation lines at 340+.

**S2.** `agent-end.ts:92-95`: change `phaseAfterFlow` to the §4 signature and update its doc comment. The phase parameter type includes `"discuss"`.

**S3.** `prompts.ts`:
- Add the `DISCUSS_PHASE` text (exported, like `EXECUTE_PHASE`) and `PLAN_KICKOFF` (like `SHOW_PLAN`). Contents as in §4.
- Edit the first lines of the `planPhase` text as in §4.
- `phaseSection`: handle `"discuss"`.

**S4.** `view.ts`:
- `Stage` and `STAGES`: add `"discuss"` first.
- Both per-stage record builders (lines 96 and 124): add a `discuss` key.
- Phase union (line 323): add `"discuss"`.
- Flow strip (line 570): put `node("discuss", "discuss")` and a separator before the plan node.
- Make any code that reads a stage key from a restored record tolerate a missing `discuss` key (zero).
- `notify.ts:35`: return `"discuss reply ready"` for discuss.

**S5.** `index.ts`, the phase plumbing:
- `Phase` at line 111. The `--flow` flag description at 365 lists `discuss`. The start-value list at 4228 includes `"discuss"`.
- `updateStatus` at 446-450 and `phaseStage` at 542: map discuss to `"discuss"`.
- In `setPhase`, `readOnly` covers discuss. The restore and block calls must skip both when going between two read-only phases with the same rules (discuss ↔ plan). Test ↔ plan or discuss still restores and re-blocks, because test has different lists. `blockPlanTools` is called with `"plan"` for discuss.
- The `stoppedSummary` text becomes `"back to discussion"` when the target is discuss.
- The plan-state reset at 584 also runs for discuss.
- Line 524 (`refilterPlanTools` guard) and line 4211 (reload re-block): include discuss, with plan rules.
- Line 2814: the plan-phase `tool_call` guard runs for discuss too.

**S6.** `index.ts`, the behaviour:
- **Input handler** (before line 3055): add the discuss branch from §4, trigger (b).
- **`agent_end`:** make sure the plan-only branches (3141, 3159) don't run for discuss. In discuss, return after the idle handling, with no menu.
- **Plan menu** (3179): add "Back to discussion" before "Keep discussing", and handle it as in §4.
- **`endFlow`** (425-439): use `phaseAfterFlow(cfg.returnTo, state.phase)` and switch to the result. The notify text names the phase and `describeRole(cfg.roles[<phase>])`.
- **`/flow` commands:**
  - Add a `SUBCOMMANDS` entry `discuss - discuss phase (read-only, talk before planning)` before `plan`.
  - In the subcommand switch, `discuss` behaves like `plan`, `execute` and `off`.
  - `plan` sends `PLAN_KICKOFF` when the phase before the switch was discuss.
  - `approve` in discuss behaves as §4 says.
- **`statusText`:** unchanged apart from the phase name, which comes out automatically.
- **Other `"plan"` checks:** grep `index.ts` for each one and decide per site whether discuss belongs (tool rules: yes; approval, finalize, `planReady` and menus: no).

**S7.** `pi/agent/workflow.json`:
- Add `roles.discuss` as a copy of `roles.plan`.
- Set `"startPhase": "discuss"`.
- Replace `"returnToPlan": true` with `"returnTo": "discuss"`.
- If the `_comment` lists keys, keep it accurate.

**S8.** `README.md`:
- Add a `discuss` row to the role table before `plan`: "new sessions start here (`startPhase`); read-only talk, no plans or menus; `/flow plan` or "go" moves to plan".
- Edit the `plan` row: it starts from the discussion and writes the `Plan:`.
- In the `execute` row and at lines 112 and 124, `returnToPlan` becomes `returnTo` (default `"discuss"`). Mention the legacy key.
- Rename the line 189 section to cover discuss and plan.
- Commands: add `/flow discuss`, and note the behaviour of `/flow plan` and `/flow approve` in discuss.

**S9.** `docs/workflow-improvements.md`:
- Add row D19 to section D after D18, in the existing format: "The plan phase mixed open discussion with plan writing and offered the approve menu after every reply. **Done:** discuss phase (`prompts.ts` `DISCUSS_PHASE`/`PLAN_KICKOFF`, `index.ts`, `config.ts` `discuss` role, `startPhase`, `returnTo`, `view.ts`, `agent-end.ts`)". Fill in ratings consistent with the D rows.
- Add "D19" to the Status line's list of implemented items.
- Add an Effect measurement row after D18: what = approve menus dismissed with "Keep discussing" per flow; how = "Count them in flow transcripts. Implemented, not measured yet."; target = "Fewer than before".

**S10.** Tests (see §6), then run the full workflow suite.

### 6. Tests
- **`config.test.ts`:**
  - "discuss defaults": no file → `startPhase === "discuss"`, `returnTo === "discuss"`, `roles.discuss` equals `roles.plan`.
  - "legacy returnToPlan": `{returnToPlan:false}` → `returnTo === "off"`. `{returnToPlan:true}` → `"plan"`. `{returnTo:"plan", returnToPlan:false}` → `"plan"`. `{returnTo:"bogus"}` → `"discuss"`.
  - "invalid startPhase": `{startPhase:"x"}` → `"discuss"`.
- **`agent-end.test.ts`:** replace lines 152-156 with:
  - `phaseAfterFlow("discuss","execute") → "discuss"`
  - `("plan","test") → "plan"`
  - `("off","execute") → undefined`
  - `("discuss","plan") → undefined`
  - `("discuss","discuss") → undefined`
- **`prompts.test.ts`:**
  - `phaseSection("discuss", …)` contains "## Workflow: DISCUSS phase" and "Agreed so far". It contains no "propose the plan" or `Plan:` section instruction: assert it does not match `/end the reply with a short \`Plan:\`|propose the plan in a short/`.
  - The plan section still contains "## Workflow: PLAN phase" and the staged-delivery text, and no longer contains "partner in discussion".
  - `PLAN_KICKOFF` mentions `Plan:`.
- **`view.test.ts`:**
  - `STAGES[0] === "discuss"`.
  - `emptyStageTokens()` has a `discuss` key.
  - If a test renders the strip, it shows a discuss node. Update existing expectations that list the stages.
- **`notify.test.ts`:** `idleReason({phase:"discuss"}) === "discuss reply ready"`.

**Command** (from `pi/agent/extensions/workflow/`; fast, well under 2 minutes): `node --experimental-strip-types --test agent-end.test.ts folder-add.test.ts readonly-bash.test.ts readonly-tools.test.ts plan-tools.test.ts tokens.test.ts push-guard.test.ts knowledge.test.ts mcp-forward.test.ts subagent.test.ts delivery.test.ts notify.test.ts repos.test.ts stages.test.ts commit-guard.test.ts repo-diff.test.ts prompts.test.ts config.test.ts metrics.test.ts plan-store.test.ts boundary.test.ts plan-doc.test.ts runner-guard.test.ts test-report.test.ts test-run.test.ts test-flow.test.ts flow-report.test.ts view.test.ts waits.test.ts checkpoints.test.ts tags.test.ts board.test.ts gh-path.test.ts pickers.test.ts publish.test.ts`

**Expected:** all pass, 0 failures. Also run `npx tsc --noEmit -p .` only if a tsconfig exists there. Otherwise rely on the strip-types run.

**S11.** Verify: start `pi` in this repo and check:
- The status strip shows `● DISCUSS`, and a reply ends with no menu.
- Type "go": the phase switches to plan and the reply is a `Plan:`.
- In the plan menu, pick "Back to discussion".
- Look for the right phase in the strip, no approve menu in discuss, and a `Plan:` after the kickoff.

### 7. Done when
- A new session starts in discuss on the `discuss` role model. It is read-only with the plan tool rules, has no menu after replies, and never approves or executes.
- `/flow plan` or a typed "go" in discuss switches to plan and produces a `Plan:` reply. `/flow approve` in discuss does the same.
- `/flow discuss` and the "Back to discussion" menu entry return to discuss with the transcript kept.
- A finished flow returns to the phase set by `returnTo` (default discuss). Legacy `returnToPlan` still works.
- The plan prompt no longer calls the planner the "partner in discussion". All other plan behaviour is unchanged.
- README, `workflow.json` and `docs/workflow-improvements.md` (D19, Status, Effect measurement) are updated.
- The full test command passes.

### 8. Risks, rollback, what not to touch
**Risk 1:** tool-snapshot handling when switching discuss ↔ plan or test. A double block or a missed restore would lose tools. Covered by the S5 rule. Check `toolsBeforePlan` stays a single snapshot.

**Risk 2:** missed `"plan"` checks that should include discuss, which would leave discuss writable. The executor must check every one.

**Risk 3:** persisted sessions saved with phase `"plan"` still load fine. Stage records without `discuss` must not crash.

**Rollback:** revert the commit.

**Don't touch:**
- Execute, test, judge, arbiter, finalize and delivery logic.
- `approvePattern`'s value.
- The tool allow and block lists.
- `finalize()` text.

### 9. Commits
One commit:
- **Subject:** `workflow: add discuss phase before planning`
- **Files:** `pi/agent/extensions/workflow/{config.ts,config.test.ts,agent-end.ts,agent-end.test.ts,prompts.ts,prompts.test.ts,view.ts,view.test.ts,notify.ts,notify.test.ts,index.ts,README.md}`, `pi/agent/workflow.json`, `docs/workflow-improvements.md`

<!-- pi-workflow:status -->
## Checklist
- [x] S1 `config.ts`:
- [x] S2 `agent-end.ts:92-95`: change `phaseAfterFlow` to the §4 signature and update its doc comment. The phase parameter type i
- [x] S3 `prompts.ts`:
- [x] S4 `view.ts`:
- [x] S5 `index.ts`, the phase plumbing:
- [x] S6 `index.ts`, the behaviour:
- [x] S7 `pi/agent/workflow.json`:
- [x] S8 `README.md`:
- [x] S9 `docs/workflow-improvements.md`:
- [x] S10 Tests (see §6), then run the full workflow suite.
## Outcome
2026-10-23T02:14:53.356Z — failed: committed (1 commit), pushed, no open pull request
