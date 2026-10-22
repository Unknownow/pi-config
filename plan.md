<!-- pi-workflow plan v1 flow=20261022-1202-wait-checks-that-run-on-windows-plus-a-w-a840 -->
## Plan: Wait checks that run on Windows, plus a workflow autopilot

### 1. Goal and non-goals

**Goal**
- A `wait_for_user` check runs on Windows even when pi was started outside Git Bash. This applies to the background poll, the check that runs when the user types, and a new first check when the wait starts.
- A check that can't run at all is reported as broken. It must not look like "not done yet".
- A new autopilot option (config `autopilot`, session toggle `/flow autopilot`) does the following:
  - The agent resolves approval waits itself and posts an approval comment where the person was asked to reply.
  - The agent performs action waits itself when a non-interactive command can do them and the repo's own rules allow it.
  - The routine workflow menus in judge, plan-flaw, stage and delivery handling are skipped. The full list is in S6.
- Autopilot is turned on in the user's `workflow.json`, and the result is deployed to this machine with `pi-config import`.

**Non-goals**
- No change to unity-packages, `updates.bat` or its `AGENTS.md`. Publishing there stays a person's step.
- Autopilot never scripts around a confirmation a person must type, and never overrides a repo's `AGENTS.md`/`CLAUDE.md`.
- Plan approval itself (plan phase) still needs the user.
- These menus still ask: judge failure, judge round cap, an arbiter result of "ask", "plan steps are still open", and the test-phase menus.
- Stage-start `(after: …; check: …)` waits get only the S2 check fix. They get no autopilot handling.
- No push or PR by autopilot beyond the flow's or the config's `delivery`. `delivery.default` stays `commit` in the user's config.

### 2. User decisions

- **D1:** It's a bug, and the fix should make the flow continue automatically once the condition holds.
- **D2:** Add an option so the agent resolves waits itself instead of waiting for the user.
- **D3:** When the agent approves on the user's behalf, it leaves a comment there (on the issue or PR where approval was asked).
- **D4:** The same automation applies to commit, publish and the other delivery steps: no prompts for them under autopilot. Publishing in a repo whose rules reserve it for a person stays a pause (agreed limit).
- **D5:** "Do it for me": turn autopilot on in the user's config and deploy it to this machine.

### 3. Facts the executor needs

Workflow extension, all under `pi/agent/extensions/workflow/`:
- `index.ts:2029-2035` `runWaitCheck` runs `pi.exec("bash", ["-c", check], { cwd: lastCtx?.cwd, timeout: cfg.wait.checkTimeoutMs })` and returns `code === 0`.
- pi's `exec` (`pi-coding-agent` `execCommand`) spawns with `shell: false`. A spawn error (ENOENT) resolves as `{stdout: "", stderr: "", code: 1, killed: false}`, so a missing `bash` looks like "not passed".
- This machine's Windows PATH (registry, user and system) has `C:\Program Files\Git\cmd` but no `Git\bin` and no `bash.exe`. pi pid 30144 runs `node.exe` with PPID 0.
- `@earendil-works/pi-coding-agent` exports `getShellConfig(customShellPath?)` (`dist/index.d.ts:44`, present in `dist/index.js`).
  - It returns `{ shell, args: ["-c"] }`, or `{ shell, args: ["-s"], commandTransport: "stdin" }` for legacy WSL bash.
  - It throws when no bash is found.
  - On Windows it tries `%ProgramFiles%\Git\bin\bash.exe` first.
  - `index.ts:30-36` already imports from this package.
- Wait polling: `index.ts:2009-2025` (`stopWaitTimer`, `startWaitTimer`) and `index.ts:2037-2043` (`clearWait`).
  - `waitTick` is at `index.ts:2047-2079`.
  - `wait_for_user` is at `index.ts:2081-2119`: parameters at :2089-2093, read-only validation at :2098-2102, amendment and state at :2103-2111.
- Typed-message wait path: `index.ts:2722-2753`. The select is at :2740 (`Check not passing: ${w.check}`, options "Continue anyway" / "Keep waiting").
- Wait state type: `index.ts:172`. Status bar: `index.ts:441` (`workflow-wait`).
- `notifyUser`: `index.ts:309`. `statusText`: `index.ts:3871-3880`. `/flow` subcommand list: `index.ts:3858-3869`.
  - The `/flow` handler switch is at `index.ts:4036`; `case "status"` is at :4039 and `case "delivery"` at :4077.
- Prompt sites autopilot affects:
  - `chooseDelivery`: `index.ts:629-639`. Line 632 returns the default when `!cfg.delivery.ask || !ctx.hasUI`.
  - Plan-end approval menu: `index.ts:2878` (`cfg.delivery.ask ? deliveryChoices(def) : [def]`).
  - `noChangeTurn` uses `cfg.stageAdvance` at `index.ts:2985`; the incomplete stage delivery uses it at `index.ts:3074`.
  - `autoJudge` at `index.ts:3196-3197`.
  - `arbiterFirst(state.planFlaw, cfg.planFlaw)` at `index.ts:3280`; the helper is at `agent-end.ts:124-126`.
  - Knowledge-unavailable menus at `index.ts:2372-2374` (`deliver` tool) and `index.ts:3557-3561` (commit step).
- Session-scoped override to model on: `FlowState.planFlaw?: "auto"` at `index.ts:135-136`, shown in `statusText` at :3877.
- Executor wait rule: `prompts.ts:100`. `prompts.test.ts:68-70` asserts `EXECUTE_PHASE` includes `wait_for_user`.
- `waits.ts` holds the pure wait helpers, covered by `waits.test.ts` (`parseWaitStep`, `waitAmendment`, `resumePrefix`, `pollDecision`).
- Config:
  - `config.ts:120-145` `WorkflowConfig`, with `planFlaw` at :137 and `stageAdvance` at :141.
  - `DEFAULTS` around `config.ts:218-240`.
  - Validation around `config.ts:330-345`.
  - Test style: `config.test.ts:22-26`, "missing file gives defaults" with `tmp()` and `loadConfig`.
- Test command: README `pi/agent/extensions/workflow/README.md:220`. It already lists `waits.test.ts`, `config.test.ts` and `prompts.test.ts`.
- README sections: "Wait points" at `README.md:149-159`; config notes at `README.md:110`; `planFlaw` at :138.
- Backlog `docs/workflow-improvements.md`:
  - Status line at :5; rules at :7-11; section A rows up to A19 at :49.
  - "Effect measurement" table from :99, with the A-rows at :150-159.
  - Next free IDs: A20 and A21.
- User config: `pi/agent/workflow.json` (repo copy, 2-space JSON, `"planFlaw": "ask"` at :52). The live copy `~/.pi/agent/workflow.json` differs only in formatting.
- Deploy: `./pi-config.sh preview` runs `node bin/import.js --dry-run`; `./pi-config.sh import` runs `node bin/import.js` (`pi-config.sh:30-31`).
  - The live `~/.pi/agent/extensions/workflow` equals the repo copy, apart from `.bak` files.
- Repo state: branch `flow/runnergate-test-covers-a-newcomer-arrivi`, 18 commits ahead of `origin/master`, clean tree.

### 4. Design

**Components**
- **`waits.ts` (pure):**
  - Classifies a check result.
  - Builds the select title for a failing check, the autopilot amendment and the autopilot tool replies.
  - No I/O, so tests cover it.
- **`index.ts`:**
  - Resolves pi's bash once and runs checks with it.
  - Callers act on the verdict.
  - `wait_for_user` runs the first check, then the autopilot branch.
  - One `autopilotOn()` helper is used at every prompt site.
  - `/flow autopilot` subcommand.
- **`config.ts`:** the `autopilot` key.
- **`prompts.ts`:** the executor learns `kind` and `manual`.

**Contracts**

`waits.ts`:
```ts
export type CheckRun = { code: number; stderr: string; killed: boolean } | { error: string };
export interface CheckVerdict { status: "pass" | "fail" | "broken"; detail?: string }
export function checkVerdict(r: CheckRun, timeoutMs: number): CheckVerdict;
export function checkTitle(v: CheckVerdict, check: string): string;
export function autopilotAmendment(n: number, w: { reason: string; step?: string; kind: "approve" | "act" }): string;
export function autopilotReply(kind: "approve" | "act", reason: string, check?: string): string;
```

`checkVerdict` rules, in this order:
1. `{error}` → `broken`, detail = the error.
2. `killed` → `fail`, detail `timed out after <timeoutMs/1000> s`.
3. `code === 0` → `pass`, no detail.
4. `code` 126 or 127, or stderr matching `/command not found/i` → `broken`, detail `exit <code>: <last line>`.
5. Anything else → `fail`, detail `exit <code>`, plus `: <last line>` when stderr has a non-empty line.

"Last line" is the last non-empty trimmed stderr line, cut to 200 characters. "No such file" is not broken.

`checkTitle`:
- broken → `Check can't run (<detail>): <check>`.
- otherwise → `Check not passing (<detail>): <check>`, or `Check not passing: <check>` when there is no detail.

`autopilotAmendment` returns exactly:
```
## Amendment <n> (executor: autopilot)
<reason> (step <step>, <kind>)
```
Without a step, the second line is `<reason> (<kind>)`.

`autopilotReply` starts with `Autopilot is on: ` and must contain these instructions.

For **approve**:
- Review the item against the plan and your findings.
- If it holds, post the approval as a comment where the person was asked to reply. Use the word the check looks for, and mark it as the autopilot's, for example:
  ```
  gh issue comment <n> -R <owner/repo> --body "approved (workflow autopilot): <one-line reason>"
  ```
  Without a check, post a comment only if the plan or the reason names an issue or PR.
- Then run the check (when there is one); it must pass.
- Tick the step with `plan_check` and continue in this turn.
- If the review finds something the user must decide, call `wait_for_user` again with `manual: true` and say why.

For **act**:
- If a non-interactive command can do it and the repo's `AGENTS.md`/`CLAUDE.md` allow the agent to run it, do it now.
- Then run the check, tick the step and continue.
- Otherwise call `wait_for_user` again with `manual: true`; the workflow polls the check and resumes you.
- Never script around a confirmation that a person must type.

`wait_for_user` parameters (added to the existing ones):
- `kind?: "approve" | "act"`, default `"act"`. `approve` means a person only reviews and agrees.
- `manual?: boolean`: pause even with autopilot on.

Config key: `autopilot: boolean`, default `false`.

Session override: `let autopilotOverride: boolean | undefined`, held in memory in the extension closure. It isn't persisted: it's lost on restart or extension reload, where the config value applies again. `autopilotOn() = autopilotOverride ?? cfg.autopilot`.

`/flow autopilot [on|off]`:
- `on` and `off` set the override; no argument toggles the current effective value.
- It always notifies `workflow: autopilot on|off (session|config)`.
- Status bar key `workflow-autopilot` shows `autopilot` when on and is cleared when off.
- `statusText` gets a line `autopilot ${on ? "on" : "off"} (${override set ? "session" : "config"})`.

**Data and compatibility**
- No persisted format changes. The `waiting` state is unchanged.
- Old configs without `autopilot` get `false`.
- `kind` and `manual` are optional, so existing plans and prompts keep working.

**Failure handling**
- Shell resolution: `getShellConfig()` throwing, or returning `commandTransport: "stdin"`, makes every check `{error: "no usable bash: <message>"}`. For the stdin case the message is `only a WSL bash that needs stdin was found`.
- The resolution is cached for the session. A failed resolution is cached too.
- `pi.exec` throwing gives `{error: <message>}`.

**Scale**
- One check run per poll (every 120 s, for up to 1 h) and at most one per typed message or `wait_for_user` call.
- Each run takes ≤ 30 s (`checkTimeoutMs`).
- No limit is in sight. A shell lookup per call would add about 5 s on Windows (`where bash.exe`), which is why it's cached.

**Rejected alternatives**
- Prepending `Git\bin` to the PATH like `gh-path.ts` does: duplicates pi's lookup, and misses a custom install.
- Running checks through `cmd`: the checks are bash syntax.
- A plan-syntax kind such as `Wait (approve):`: the executor knows the kind at call time; changing the parser is a larger change.
- Persisting the override: the config is the durable switch.
- Autopilot running `updates.bat publish` by piping `publish`: it breaks that repo's rule 5 and the D4 limit.

### 5. Steps

### Stage 1: Wait checks run with pi's bash and report broken checks

**S1.** Add the pure helpers to `waits.ts`, next to `pollDecision` (`waits.ts:42`):
- `CheckRun`, `CheckVerdict`, `checkVerdict` and `checkTitle`, exactly as in section 4.
- Follow the style of `resumePrefix`/`pollDecision`, with a one-line doc comment each.

**S2.** In `index.ts`, rewrite `runWaitCheck` (`index.ts:2029-2035`) to return a `CheckVerdict`:
- Add a cached shell resolver next to it. Import `getShellConfig` in the existing import block (`index.ts:30-36`). Failure rules are in section 4.
- Run `pi.exec(shell, [...args, check], { cwd: lastCtx?.cwd, timeout: cfg.wait.checkTimeoutMs })`.
- Map the result through `checkVerdict(..., cfg.wait.checkTimeoutMs)`.
- If `pi.exec` throws, return `checkVerdict({error})`.

**S3.** Update `waitTick` (`index.ts:2047-2079`):
- **pass:** behaves exactly as today's `true`.
- **broken:** `stopWaitTimer()`, then `ctx.ui.notify("workflow: wait check can't run (<detail>): <check>; fix it or send a message to continue", "warning")` and `notifyUser(ctx, "wait check can't run: <detail>")`. Leave `state.waiting` as it is.
- **fail:** returns as today.

Keep the `state.waiting !== w` guard.

**S4.** In the typed-message path (`index.ts:2731-2745`), branch on `status !== "pass"` instead of the boolean:
- Use `checkTitle(verdict, w.check)` as the select title. The options stay the same.
- Keep the behaviour without a UI, and keep "Keep waiting" (`startWaitTimer()`).

**S5.** In `wait_for_user` (`index.ts:2094-2114`), after the read-only validation and before any amendment or state change, run the check once when there is one:
- **pass:** return `The check passes already: "<reason>" is done. Tick the step with plan_check and continue in this turn. Nothing to wait for.` Don't set the wait or add an amendment.
- **broken:** return `The check can't run (<detail>). Fix the check (it runs in bash from <cwd>) and call wait_for_user again. Nothing changed.`
- **fail:** continue as today.

Also change the tool description (`index.ts:2085`) and the `check` parameter description to say the check runs once at once and then every few minutes.

**S6.** Tests for the Stage 1 helpers in `waits.ts`; the cases are in section 6.

**S7.** Docs:
- README "Wait points" (`README.md:153-158`):
  - The check runs in pi's bash, the one the bash tool uses (Git Bash on Windows), not in whatever `bash` is on PATH.
  - `wait_for_user` checks once at once.
  - A broken check (no bash, exit 126/127, `command not found`) stops polling with a warning, and the typed-message menu shows why.
- `docs/workflow-improvements.md`, new section-A row A20, after A19 at :49:
  - The problem: on Windows a check ran `bash` from PATH. Without Git Bash on PATH it always failed silently, so no wait ever resumed and a typed message offered only "Continue anyway".
  - **Done:** checks run with `getShellConfig()`; `checkVerdict` separates broken from not-yet; first check at `wait_for_user` (`waits.ts`, `index.ts`).
  - Columns as for the other rows: rating `High (T)`, effort `S`, risk `Low.`, and the measurement.
- Add the A20 row to the Effect measurement table: "Waits ended with 'Continue anyway' vs by a passing check". How: count `resumePrefix` "forced" vs "passed" texts in session logs; implemented, not measured yet. Target: no forced resume while the check would pass.
- Add A20 to the implemented list in the Status line (:5).

### Stage 2: Autopilot

**S8.** In `config.ts`:
- Add `autopilot: boolean` to `WorkflowConfig`, after `planFlaw` (`config.ts:137`). Doc comment: `The agent resolves waits itself (approves with a comment, acts when a non-interactive command may) and the workflow skips its routine menus; see README "Autopilot".`
- `DEFAULTS.autopilot = false`.
- Validation next to the `wait` checks (`config.ts:337-338`): a non-boolean value becomes the default.

**S9.** Add `autopilotAmendment` and `autopilotReply` to `waits.ts`, as in section 4. Model them on `waitAmendment` (`waits.ts:29-32`).

**S10.** In `index.ts`, add the session override and the switches:
- `autopilotOverride` and `autopilotOn()`, near the other closure state (e.g. near `resumes` at `index.ts:344`).
- `/flow autopilot [on|off]`: a `case "autopilot"` in the handler switch (`index.ts:4036`), modelled on `case "delivery"` at :4077. An invalid argument notifies `usage: /flow autopilot [on|off]` and changes nothing.
- A `SUBCOMMANDS` entry: `{ value: "autopilot", label: "autopilot [on|off] - resolve waits and routine menus without asking (no argument toggles)" }`.
- The `workflow-autopilot` status in `updateStatus` (`index.ts:441`, same `ctx.hasUI` guard).
- The `statusText` line after the `flaws` line (:3877).

**S11.** In `wait_for_user`:
- Add the `kind` and `manual` parameters (`Type.Optional(Type.Union([Type.Literal("approve"), Type.Literal("act")]))` and `Type.Optional(Type.Boolean())`, with descriptions).
- After the S5 first check (pass and broken handled as in S5), when `autopilotOn() && !params.manual`:
  1. Append `autopilotAmendment(nextAmendmentNumber(), {reason, step, kind})` to `state.approvedPlan`, then `refreshChecklist()`.
  2. Don't set `state.waiting`. `persist()`, `planMilestone(ctx)`.
  3. Return `autopilotReply(kind, reason, check)`.
- Otherwise the existing waiting path, unchanged.
- Update the tool description: with autopilot on, the tool tells you what to do instead of pausing, unless `manual: true`.

**S12.** Skip the routine prompts when `autopilotOn()`:
- `chooseDelivery` (`index.ts:632`): return `def` when `autopilotOn()` too.
- Plan-end approval menu (`index.ts:2878`): offer only `[def]` when `autopilotOn()`, as when `!cfg.delivery.ask`.
- `noChangeTurn` (`index.ts:2985`) and the incomplete stage delivery (`index.ts:3074`): treat `stageAdvance` as `"auto"` when `autopilotOn()`.
- `autoJudge` (`index.ts:3197`): `"ask"` acts as `"auto"` when `autopilotOn()`. `"off"` stays off.
- Plan flaw (`index.ts:3280`): `arbiterFirst(autopilotOn() ? "auto" : state.planFlaw, cfg.planFlaw)`.
- Knowledge unavailable (`index.ts:2372` and `index.ts:3557`): with `autopilotOn()`, don't ask. `ctx.ui.notify("workflow: autopilot commits without the knowledge check: <reason>", "warning")`, then continue as "Commit anyway".

Everything listed under non-goals stays unchanged.

**S13.** Extend the wait sentence in the executor rule in `prompts.ts:100`:
- Pass `kind: "approve"` when a person only has to review and agree, and `kind: "act"` when they must do something.
- With autopilot on, the tool replies with what to do instead of pausing; follow it, and use `manual: true` to pause anyway.

Keep the rest of the sentence. Run `prompts.test.ts` and adjust only an assertion that the new text breaks.

**S14.** Tests for S8 and S9, as in section 6.

**S15.** Docs:
- README: a new subsection `**Autopilot.**` at the end of "Wait points, checkpoints and tags" (after `README.md:159`). It covers:
  - the config key and `/flow autopilot`;
  - the approve and act behaviour, including the comment;
  - the skipped menus (S12);
  - what still asks (the non-goals list);
  - "never scripts around a confirmation a person must type, never overrides a repo's AGENTS.md/CLAUDE.md";
  - pushing needs `delivery.default` `push|pr|merge`.

  Add `"autopilot": true` to the config notes at `README.md:110`.
- `docs/workflow-improvements.md`:
  - New row A21, after A20. Problem: every approval wait and the routine menus needed the user, even when they would only say yes. **Done:** autopilot (`config.ts`, `waits.ts`, `index.ts`, `prompts.ts`); rating `Medium (T)`, effort `M`, risk: "Medium. The agent approves its own work; the judge still reviews, and the amendment and comment record it."
  - Effect-measurement row A21: "Autopilot amendments per flow; user prompts per flow with autopilot on vs off". How: count `executor: autopilot` amendments and `askUser` menus in session logs; implemented, not measured yet. Target: fewer prompts, and no judge FAIL caused by a self-approval.
  - Add A21 to the Status line.

**S16.** In `pi/agent/workflow.json`, add `"autopilot": true` after `"planFlaw": "ask",` (:52). Keep 2-space formatting and change nothing else.

**S17.** Deploy to this machine:
1. Run `./pi-config.sh preview` from the repo root.
2. If every change it lists is under `extensions/workflow/` or is `workflow.json`, run `./pi-config.sh import`, then `diff -rq pi/agent/extensions/workflow ~/.pi/agent/extensions/workflow | grep -v '\.bak-'`. That must print nothing.
3. If preview lists anything else, don't import. Report the list in the final reply.

If a judge round later changes files in this stage, repeat this step after the fix. Don't `/reload` any session yourself. The final reply tells the user to `/reload` the amazon-sdk session once it's idle.

### 6. Tests

All are in `pi/agent/extensions/workflow/`, using `node:test` and `assert/strict` like the existing tests.

`waits.test.ts`:
- **`checkVerdict pass, fail and timeout`:**
  - `{code:0,stderr:"",killed:false}` → `{status:"pass"}` with no detail.
  - `{code:1,stderr:"",killed:false}` → `fail`, detail `exit 1`.
  - `{code:1,stderr:"a\nlast line\n\n",killed:false}` → `fail`, detail `exit 1: last line`.
  - `{code:1,stderr:"",killed:true}` with timeout 30000 → `fail`, detail `timed out after 30 s`.
- **`checkVerdict broken`:**
  - `{error:"no usable bash: x"}` → `broken`, detail `no usable bash: x`.
  - Code 127 with stderr `bash: gh: command not found` → `broken`, detail `exit 127: bash: gh: command not found`.
  - Code 126 → `broken`.
  - Code 1 with stderr `foo: command not found` → `broken`.
- **`checkVerdict keeps "No such file" as not yet`:** code 2, stderr `ls: cannot access 'x': No such file or directory` → `fail`.
- **`checkVerdict cuts the stderr line to 200 characters`:** a 300-character line gives a detail whose part after `exit 1: ` has length 200.
- **`checkTitle`:**
  - broken → starts with `Check can't run (`.
  - fail with a detail → `Check not passing (exit 1): c`.
  - fail without a detail → `Check not passing: c`.
- **`autopilotAmendment text`:**
  - `(2, {reason:"R", step:"S3", kind:"approve"})` → `## Amendment 2 (executor: autopilot)\nR (step S3, approve)`.
  - Without a step → `...\nR (act)`.
- **`autopilotReply`:**
  - approve with a check: starts with `Autopilot is on: `, contains `(workflow autopilot)`, `manual: true` and `plan_check`.
  - act: contains `AGENTS.md`, `manual: true` and `Never script around a confirmation`.

`config.test.ts`:
- **`autopilot defaults to false`:** `loadConfig(tmp()).config.autopilot === false`.
- **`invalid autopilot falls back to false`:** a file `{"autopilot":"yes"}` → `false`; a file `{"autopilot":true}` → `true`.

`prompts.test.ts`: the existing tests pass. If one asserts the old wait sentence, update only that assertion to the new text.

**Commands** (run in `pi/agent/extensions/workflow`):
- The README test command (`README.md:220`): all tests pass, `# fail 0`.
- After Stage 1, also `node --experimental-strip-types --test waits.test.ts`: passes.

### 7. Done when

- With pi started from a Windows terminal (no `bash` on PATH):
  - A wait whose check exits 0 resumes the flow by itself within one poll.
  - A typed message ends the wait with "(check passed)" and no menu.
- A check that can't run is reported once as broken, with its reason, and never counts as "not done yet".
- `wait_for_user` doesn't pause when its check already passes, and refuses a broken check.
- With autopilot on:
  - An approve wait makes the agent review, post an `approved (workflow autopilot): …` comment where the approval was asked, and continue.
  - An act wait is done by the agent when a non-interactive command may do it, and pauses otherwise (`manual: true`).
  - The delivery menu, the `autoJudge` confirm, the plan-flaw menu, the stage-advance questions and the knowledge-unavailable question don't appear.
- With autopilot off, behaviour is unchanged except for the check fix (D1).
- `/flow autopilot` toggles and `/flow status` shows the state.
- The user's `workflow.json` has `"autopilot": true` and is deployed to `~/.pi/agent` (D5), or the final reply explains why the import was skipped.
- The README tests pass. README and `docs/workflow-improvements.md` (A20, A21, Status line, Effect rows) are updated.

### 8. Risks, rollback, what not to touch

**Risks**
- Autopilot approves the agent's own work. The judge still reviews every diff, and the amendment and comment make it visible.
- The comment is posted under the user's GitHub account. It's marked `(workflow autopilot)`.
- `getShellConfig()` may pick a different bash than PATH did on Linux or macOS. Expected to be the same there; on non-Windows it uses `/bin/bash`, `sh` or similar.
- Importing into `~/.pi` affects every session after its next `/reload`.

**Rollback**
- `/flow autopilot off`, or `"autopilot": false` in `workflow.json`.
- Revert the commits and run `./pi-config.sh import` again.

**Don't touch**
- `readonly-bash.ts`, which still validates checks.
- `delivery.ts`, the commit and push guards, and the stage `after:` wait logic beyond S2.
- `plan-doc.ts` formats.
- Other repos (unity-packages, the amazon-sdk worktrees).
- Any running session.

### 9. Commits

Stage 1:
- `fix(workflow): run wait checks with pi's bash and report broken checks`: `waits.ts`, `waits.test.ts`, `index.ts`, `README.md`, `docs/workflow-improvements.md`.

Stage 2:
- `feat(workflow): autopilot resolves waits and skips routine menus`: `config.ts`, `config.test.ts`, `waits.ts`, `waits.test.ts`, `index.ts`, `prompts.ts`, `prompts.test.ts` (only if changed), `README.md`, `docs/workflow-improvements.md`.
- `chore(config): turn on workflow autopilot`: `pi/agent/workflow.json`.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 Add the pure helpers to `waits.ts`, next to `pollDecision` (`waits.ts:42`):
- [x] S2 In `index.ts`, rewrite `runWaitCheck` (`index.ts:2029-2035`) to return a `CheckVerdict`:
- [x] S3 Update `waitTick` (`index.ts:2047-2079`):
- [x] S4 In the typed-message path (`index.ts:2731-2745`), branch on `status !== "pass"` instead of the boolean:
- [x] S5 In `wait_for_user` (`index.ts:2094-2114`), after the read-only validation and before any amendment or state change, run 
- [x] S6 Tests for the Stage 1 helpers in `waits.ts`; the cases are in section 6.
- [x] S7 Docs:
- [x] S8 In `config.ts`:
- [x] S9 Add `autopilotAmendment` and `autopilotReply` to `waits.ts`, as in section 4. Model them on `waitAmendment` (`waits.ts:2
- [x] S10 In `index.ts`, add the session override and the switches:
- [x] S11 In `wait_for_user`:
- [x] S12 Skip the routine prompts when `autopilotOn()`:
- [x] S13 Extend the wait sentence in the executor rule in `prompts.ts:100`:
- [x] S14 Tests for S8 and S9, as in section 6.
- [x] S15 Docs:
- [x] S16 In `pi/agent/workflow.json`, add `"autopilot": true` after `"planFlaw": "ask",` (:52). Keep 2-space formatting and chang
- [x] S17 Deploy to this machine:
## Outcome
2026-10-22T05:09:26.189Z — ok: stage 1: committed (1 commit), pushed; stage 2: committed (2 commits), pushed
