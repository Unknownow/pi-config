<!-- pi-workflow plan v1 flow=20261019-1612-send-the-phase-prompts-as-a-prompt-secti-0aa2 -->
## Plan: Send the phase prompts as a prompt section so the bridge forwards them (D6)

### 1. Goal and non-goals
**Goal:**
- Today the plan-phase and execute-phase instructions are returned as `systemPrompt` from `before_agent_start`, and `pi-claude-bridge` drops that route. Instead, send them through `systemPromptOptions.sections.workflow`, so every provider receives them.
- The planner then knows from the start that it may only read, and answers a "do it" with a plan instead of trying a blocked tool first.
- The executor receives its rules (no commit, no push) up front.

**Non-goals:**
- No change to the wording of `planPhase`, `EXECUTE_PHASE` or `stageLine`.
- No change to subagent prompts (`--append-system-prompt`), the `tool_call` guards, `planBlocked`, or the bridge's stale tool list.
- No D7 (splitting `prompts.ts`) and no Progress checklist in the docs.
- Nothing outside `pi/agent/extensions/workflow/` and `docs/workflow-improvements.md`.

### 2. User decisions
- D1: Implement D6 only; D7 is left for later.
- D2: The plan uses the section route (`systemPromptOptions.sections`), in place of the dropped `systemPrompt` return; the user approved this.

### 3. Facts the executor needs
- `index.ts:97`: `type Phase = "off" | "plan" | "execute";`
- `index.ts:1581-1604`, the `before_agent_start` handler:
  - It sets `opts.sections.workspace` at `:1586`, but only when folders or touched repos exist.
  - `:1600` returns `{ systemPrompt: \`${event.systemPrompt}\n\n${prompts.planPhase(cfg.finalizePlan, cfg.stagedPlans, cfg.planRecap)}\` }`.
  - `:1601-1604` returns `{ systemPrompt: \`${event.systemPrompt}\n\n${prompts.EXECUTE_PHASE}${staged ? \`\n${stageLine(staged.stages, staged.current)}\` : ""}\` }`, with `staged = currentStages()`.
- `index.ts:54` imports `* as prompts from "./prompts.ts"`; `:65` imports `stageLine` from `./stages.ts`.
- `prompts.ts:1-4`:
  - The header comment says "Main-session phases are appended".
  - It imports `PlanRecap` and `StagedPlans` from `./config.ts` (`config.ts:59`, `:62`).
  - It defines `planPhase(finalize, staging, recap)` at `:17` and `EXECUTE_PHASE` at `:73`.
- `stages.ts:64`: `stageLine(stages, current): string`. `prompts.ts` must not import `stages.ts`; pass the line in as a string.
- `prompts.test.ts`: two tests today, importing `EXECUTE_PHASE` and `planPhase`.
- `pi-claude-bridge/README.md` (`~/.pi/agent/npm/node_modules/pi-claude-bridge/`):
  - `:111`: sections are forwarded as `<name>` blocks.
  - `:112`: a `systemPrompt` return is dropped.
- Pi's own docs (`pi-coding-agent/docs/extensions.md:104`) recommend changing sections over returning `systemPrompt`. Sections are typed `Record<string, string | null>` (`docs/message-types.md:100`).
- `docs/workflow-improvements.md`:
  - `:5` is the Status line (`... D2, D3, D4 and D5 are implemented; ...`).
  - `:76` is the D5 row (last row of section D).
  - `:119` is the D5 row in the "Effect measurement" table.

### 4. Design
- **New pure helper** in `prompts.ts`, placed after `EXECUTE_PHASE`:
  ```ts
  export function phaseSection(phase: string, opts: { finalize: boolean; staging: StagedPlans; recap: PlanRecap; stage?: string }): string | null
  ```
  - `phase === "plan"`: returns `planPhase(opts.finalize, opts.staging, opts.recap)`.
  - `phase === "execute"`: returns `EXECUTE_PHASE`, plus `"\n" + opts.stage` when `opts.stage` is a non-empty string.
  - Any other phase: returns `null`.
- **Handler:** set `event.systemPromptOptions.sections.workflow = prompts.phaseSection(...)` on every run, whatever the phase. Setting `null` in `off` clears text left from an earlier phase. Remove both `return { systemPrompt }` statements; the handler returns nothing.
- **Section key:** `workflow`. The bridge renders it as `<workflow>…</workflow>`; plain pi renders it as a custom section.
- **Rejected alternatives:**
  - Returning a `message` per run: it adds a user-turn message every time and grows the transcript.
  - Keeping the `systemPrompt` return as well: pi says it replaces the whole prompt, and the text would appear twice on providers other than the bridge.

### 5. Steps
**S1.** `prompts.ts`:
- Add `phaseSection` exactly as specified in Design.
- Update the header comment (`:1`) to say that main-session phase prompts go in the `workflow` prompt section.

**S2.** `index.ts:1581-1604`:
- Take `const opts = event.systemPromptOptions` outside the folders `if`, so both sections use it.
- After the folders block, compute the stage line only in the execute phase when `currentStages()` returns stages, using `stageLine(staged.stages, staged.current)`.
- Set `opts.sections.workflow = prompts.phaseSection(state.phase, { finalize: cfg.finalizePlan, staging: cfg.stagedPlans, recap: cfg.planRecap, stage })`.
- Delete both `return { systemPrompt: ... }` statements.
- Model the section assignment on `:1586`.

**S3.** `prompts.test.ts`:
- Import `phaseSection`.
- Add the tests listed in section 6.

**S4.** `docs/workflow-improvements.md`:
- After the D5 row (`:76`), add the D6 row. Finding: "Phase prompts returned as `systemPrompt` from `before_agent_start` are dropped by `pi-claude-bridge` (its README); the planner learns it is in the plan phase only from refused tools, which costs a refused call and a recovery turn."
  - Done note: "**Done:** `phaseSection` in `prompts.ts`; `before_agent_start` sets `systemPromptOptions.sections.workflow`."
  - Ratings: Benefit `Medium (K, T)`, Effort `S`, Risk `Low. Same text, other route.`, Check first `None.`
- In the Status line (`:5`), change `D4 and D5` to `D4, D5 and D6`.
- In the measurement table, after the D5 row (`:119`), add: `| D6 | Refused tool calls per plan phase | Count `Plan phase is read-only` refusals in session logs before and after. Implemented, not measured yet. | Close to 0; plan quality unchanged |`
- Check the workflow `README.md` for any text saying phase prompts are "appended to the system prompt". If there is some, reword it to "sent as the `workflow` prompt section". If there is none, change nothing.

**S5.** Run the tests (section 6).

### 6. Tests
New tests in `prompts.test.ts`, all using `opts = { finalize: true, staging: "auto", recap: "changes" }` unless stated:
- `phaseSection gives the plan prompt in the plan phase`:
  - `phaseSection("plan", opts)` deep-equals `planPhase(true, "auto", "changes")` and contains `## Workflow: PLAN phase`.
- `phaseSection gives the execute prompt, with the stage line when staged`:
  - `phaseSection("execute", opts)` equals `EXECUTE_PHASE`.
  - `phaseSection("execute", { ...opts, stage: "- Current stage: 1 of 2" })` equals `EXECUTE_PHASE + "\n- Current stage: 1 of 2"`.
- `phaseSection is null outside plan and execute`:
  - `phaseSection("off", opts)` is `null`.

Command: run `node --experimental-strip-types --test *.test.ts` in `pi/agent/extensions/workflow`. Expect `ℹ fail 0`, and `ℹ pass` 3 higher than before.

Manual check (outside the executor, in a real pi session): with `CLAUDE_BRIDGE_DEBUG=1`, a plan-phase request to the bridge contains `<workflow>` and `## Workflow: PLAN phase`.

### 7. Done when
- In the plan and execute phases, the phase text is sent in `systemPromptOptions.sections.workflow`. In the `off` phase that section is `null`.
- `before_agent_start` no longer returns `systemPrompt`.
- The phase texts and the stage line are unchanged.
- All workflow tests pass with 0 failures.
- `docs/workflow-improvements.md` has the D6 row, the updated Status line and the D6 measurement row.

### 8. Risks, rollback, and what not to touch
- **Risk:** on providers other than the bridge, the text now sits in a section rather than at the very end of the system prompt. The wording is identical, and pi's docs recommend this route.
- **Risk:** if pi did not render a section in some version, the phase text would be missing. The manual check covers the bridge.
- **Rollback:** revert the commit.
- **Do not touch:**
  - the `tool_call` handler, `planBlocked`, `planToolRefused` or `setActiveTools`;
  - the wording of `planPhase`, `EXECUTE_PHASE` or `stageLine`;
  - the handling of the `workspace` section, apart from hoisting `opts`;
  - `subagent.ts`.

### 9. Commits
- `fix(workflow): send phase prompts as a prompt section so the bridge forwards them (D6)`, with these files:
  - `pi/agent/extensions/workflow/prompts.ts`
  - `pi/agent/extensions/workflow/prompts.test.ts`
  - `pi/agent/extensions/workflow/index.ts`
  - `docs/workflow-improvements.md`
  - the workflow `README.md`, only if S4 changed it

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 `prompts.ts`:
- [ ] S2 `index.ts:1581-1604`:
- [ ] S3 `prompts.test.ts`:
- [ ] S4 `docs/workflow-improvements.md`:
- [ ] S5 Run the tests (section 6).
