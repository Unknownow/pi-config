<!-- pi-workflow plan v1 flow=20261114-0108-proposal-judge-orchestrator-role-and-for-29c5 -->
## Plan: Proposal judge, orchestrator role and forced moves for orchestrate

**Goal**
- **Proposal judge.** In orchestrate propose mode, an automatic judge checks the `## Packages:` proposal before the run starts. `fix: auto` findings go back to the orchestrator for a fix and a recheck. A `fix: user` finding pauses the gate.
- **Orchestrator role.** The orchestrator session switches to its own model (`roles.orchestrator`) when orchestrator mode turns on, and switches back when it turns off.
- **`confirmPlans` prompt.** The prompt shows the sub's plan-judge line.
- **Forced moves.** `/orch go force` and `/flow plan force` move on past a stuck gate.
- **Shared helpers.** The finding helpers move to `shared/findings.ts`.
- **Config file.** `pi/agent/orchestrate.json` is added to the repo and installed.

**Non-goals**
- A Claude Code plugin port.
- Changing the subs' judge: `workflow.json` `roles.judge` stays on Opus 5.5 medium.
- Removing the stale `workflow/subagent.ts` and `workflow/mcp-forward.ts`. D51 records this as an idea only.
- Touching any of these: `gitRaw`, `diffBase`, `pickDiffBase`, the `addAccepted` ordering, `workflow/merge-gate.ts`, the execute judge loop, the D42/D43 code.

**User decisions**
- **D1. `orchestrate.json` contents.** The file goes in the repo and is installed, with:
  - `confirmPlans: true`;
  - `roles.orchestrator` and `roles.judge` both set to `{ "model": "claude-bridge/claude-opus-5-5", "thinking": "high" }`;
  - `autoJudgeProposal: "auto"`;
  - `maxProposalJudgeRounds: 2`;
  - `judge.tools` `["read","grep","find","ls"]`, `judge.timeoutMs` 900000 and `judge.idleTimeoutMs` 300000;
  - `judge.extensions` `["~/.pi/agent/npm/node_modules/pi-claude-bridge/src/index.ts"]`.
- **D2. Code defaults when a key is missing.**
  - No orchestrator model switch.
  - The judge uses the session's current model with thinking `high`.
  - `judge.extensions` is the `~` bridge path only when that file exists after `~` expansion; otherwise `[]`.
  - A bad value counts as missing and is named in the warning.
- **D3. Code placement.** The finding helpers move to `shared/findings.ts`, and the workflow re-exports them. Orchestrate's judge calls `runSubagent` from `../agents/subagent.ts`; the runner doesn't move. The stale workflow copies are left alone.
- **D4. What the proposal judge checks.**
  - Every agreed item is covered by exactly one package.
  - The `owns` globs match real files in the named repos and don't overlap.
  - `forbids` is consistent.
  - `dependsOn` has no cycles, and the order works.
  - Each package can be tested on its own.
  - The criteria can be checked.
  - Shared interfaces are settled in `decisions`.
  - `fix: user` is used only for decisions the discussion didn't make.
  - The output uses the same finding format and ends with `VERDICT: PASS|FAIL`.
- **D5. Judge input.** The proposal, the last `Agreed so far:` list (or a "no agreed list" note), and the repo table with absolute paths. A recheck also gets the earlier findings. The judge runs in the orchestrator's `ctx.cwd`.
- **D6. Proposal gate behaviour.**
  - **Start:** a typed "go" on the newest ready proposal starts the gate in the background, and the `input` hook returns `handled`.
  - **Rounds:** a typed "go" resets `rounds` to 0. A recheck counts a round and doesn't reset.
  - **Which proposal:** `lastProposal` is cleared by any `agent_end` in propose that isn't ready, and by `setMode`.
  - **Move to run:** a clean PASS, or the cap reached with only `fix: auto` findings left, moves to run and sends the kickoff with the open findings.
  - **Fix loop:** `fix: auto` findings start a fix round. The next ready proposal with a new hash is rechecked; anything else pauses. A `fix: user` finding pauses, even at the cap.
  - **Interruptions:** a second "go" only shows a notice. Other typed text, Esc or `/orch judge cancel` aborts the gate without counting a round. `setMode` aborts it silently.
  - **Errors:** a judge error never blocks; the gate moves to run with a note.
  - **Stale verdicts:** a verdict for an older proposal is dropped. A clean PASS on the same hash skips the judge.
  - **Saved state:** the gate state is saved in an `orchestrate-proposal-gate` entry. On restart, `awaiting-fix` becomes `idle`.
  - **Widget:** it shows `propose (judging proposal)` while the judge runs.
- **D7. Orchestrate commands.**
  - `/orch go force` works only in propose with a ready proposal; otherwise it shows a notice.
  - `/orch judge cancel` aborts a running judge; with none running it says "no judge running".
  - Both are added to the command completions.
- **D8. `/flow plan force`.** It works only in discuss, moves to plan, and carries the open findings only when they belong to the current list.
- **D9. Model switch.**
  - It happens in `setMode` (with an optional `ctx`), only when the mode changes between off and on, and runs in the background.
  - `prevModel` is copied forward in every `MODE_ENTRY` while the mode is on.
  - A restart switches nothing (pi restores the model); it only reads `prevModel` back.
  - It never switches in a sub. While the workflow is in a phase, it warns and doesn't switch.
  - When the model can't be found, it warns and keeps the current model.
- **D10. `confirmPlans` prompt.** It shows the sub's `judgeLine`, and is unchanged when there is none.
- **D11. Expected times.** About 1–3 min for a full pass, and under 90 s for a recheck.
- **D12. Checks.** Tests, "Done when" and the live checks are as agreed (listed below).
- **D13. Backlog rows.**
  - D48: findings in `shared/`.
  - D49: the proposal judge, `/orch go force` and `/flow plan force`.
  - D50: the orchestrator role and the `confirmPlans` judge line.
  - D51: the stale copies, as an idea only.

Merge points: S27 (the install in S28 copies the merged `master`).

Stages: 1. Shared finding helpers and `/flow plan force` (shared and workflow); 2. Orchestrate config, `orchestrate.json`, the orchestrator role and the `confirmPlans` judge line; 3. The proposal gate, `/orch go force`, `/orch judge cancel`, and the install.

### Facts
Paths are relative to `pi/agent/extensions/`.

**Workflow and shared**
- **`workflow/gates.ts`**
  - The `createHash` import is at :3; its only use is :91 (`textHash`).
  - `Severity` and `Finding` are at :7-18.
  - `HEAD` and `ROUTE` are at :48-49, used by `parseFindings` at :52.
  - `isClean` :80, `findingText` :85, `textHash` :90, `isEscKey` :141, `findingsBlock` :197.
  - `DiscussionReview` (with `listHash`) is at :219. The discussion gate helpers at :230-256 are the model for the orchestrate gate helpers.
- **`workflow/discussion-review.ts:5-18`** holds `AGREED`, `lastAgreedList` and `discussionVerdict`. Its importers are `workflow/index.ts:52,54`, `gates.test.ts:4,155` and `discussion-review.test.ts:4`.
- **`workflow/index.ts`**
  - The `/flow` handler is at :4728. `rest` is at :4737, `case "plan"` at :4746-4758, and the completions live in `SUBCOMMANDS`.
  - `moveToPlan(ctx, open?)` :3834, `startDiscussionGate` :3842, `sendPlanKickoff(open?)` :722.
  - `listHash = list ? textHash(list) : ""` is at :3869.
  - `setPhase` aborts a running gate with reason `"phase"`, and the run then returns silently (:652, :3917).
  - `branchAssistantTexts` is at :3813.
  - `applyRole` (:586-600) and `restorePreFlowModel` (:603-611) use `ctx.modelRegistry.find`, `pi.setModel` and `pi.setThinkingLevel`.
  - The current model is read as `${ctx.model.provider}/${ctx.model.id}` plus `pi.getThinkingLevel()` (:678).
  - Pi restores the model on restart (:4454).
- **`agents/subagent.ts`**
  - `RunOptions` is at :19-40. Required fields: `role`, `systemPrompts`, `tools`, `task`, `cwd`, `extensions`, `timeoutMs`. Optional: `idleTimeoutMs`, `signal`.
  - `runSubagent` is at :198 and returns `RunResult {ok, text, error?}` (:77).
  - `expandHome` is at :180.
- **`shared/roles.ts`**: `THINKING_LEVELS` :6, `RoleSpec {model, thinking?}` :9, `parseRoleSpec("provider/id[:thinking]")` :16.

**Orchestrate**
- **`orchestrate/boundary.test.ts:13`** forbids imports from `../workflow/` and `../worktree/` only.
- **`orchestrate/config.ts`**: the interface is at :6-25, `DEFAULTS` :31, `INT_KEYS` :33, `parseConfig` :36-66, `loadConfig` :69.
- **`orchestrate/mode.ts`**: `MODE_ENTRY` :8, `modeFromEntries` :12-20 (reads the newest custom entry), `onTyped` :23-27, `isProposalReady` :33.
- **`orchestrate/prompts.ts`**: `PROPOSE` :12, `PROPOSE_KICKOFF` :26, `RUN_KICKOFF` :29, `repoTableText` :32.
- **`orchestrate/index.ts`**
  - State: `uiCtx` :70, `lastK4` :218, `mode`/`proposalReady`/`k4Warned` :527-529, `goRe` :530.
  - `setMode` is at :537-548 and is called at :591, :1754, :1761, :1774, :1782 and :1793. `assistantText` is at :549.
  - The repo table cache is at :557-566 (`sessionRepos` :1341). The `input` hook is at :579-593, and the `agent_end` hook at :595-601.
  - `sendMessage` pattern: :217.
  - The widget: `updateWidget` :826, the render closure at :840 (`widgetLines(currentView, mode, …)`), and `widgetTui?.requestRender()` already called at :849.
  - `orch_review_plan` takes `n: number`. Its `confirmPlans` select is at :1626-1627, and it reads the outbox the same way as :1650.
  - The sub posts `plan-review` with `data {file, n, judgeLine}` (:250).
  - The `/orch` command is at :1738-1800 (completions :1741, usage :1800).
  - `session_start` is at :1882. The mode is restored at :1896 and `cfg` is loaded at :1906; `become` sets `mode = "off"` later.
- **`orchestrate/view.ts`**
  - `:6` already imports `phaseLabel` from `./plan-judge.ts`.
  - The `widgetLines` signature is at :198.
  - With no view, :200-202 renders only when `mode` is `discuss`, `propose` or `run`.
  - :205 compares `mode === "off"`.
  - Existing tests are in `view.test.ts:39-48`.
- **`orchestrate/plan-judge.ts`**: `planReviewJudgeLine` (:29) returns `""` when no judge ran; `phaseLabel(phase, judging?)` is at :54.

**Repo and docs**
- **`docs/workflow-improvements.md`**: the Status line is at :5, rows D45-D47 at :160-162, and the Effect measurement section at :164 (rows :245-247). The next free ID is D48.
- **`pi/agent/workflow.json`** role format: `{ "model", "thinking" }`.
- **`bin/import.js`** installs `pi/agent/*`.

### Design
**`shared/findings.ts`** is pure. It exports `Severity`, `Finding`, `parseFindings` (with `HEAD` and `ROUTE`), `isClean`, `findingText`, `textHash` (importing `createHash` from `node:crypto`), `findingsBlock`, `isEscKey`, `lastAgreedList` (with `AGREED`), and `judgeVerdict(text): "PASS"|"FAIL"`, which is the old body of `discussionVerdict`.
- `workflow/gates.ts` re-exports all of these except `lastAgreedList` and `judgeVerdict`.
- `workflow/discussion-review.ts` re-exports `lastAgreedList` and keeps `discussionVerdict` as an alias of `judgeVerdict`.

**`orchestrate/proposal-gate.ts`** is pure and imports only from `shared/`:
```ts
export interface ProposalReview { hash: string; verdict: "PASS" | "FAIL"; findings: Finding[]; rounds: number; status: "idle" | "awaiting-fix" | "paused" }
export const GATE_ENTRY = "orchestrate-proposal-gate"; // data: { v: 1, ...ProposalReview }
export type SavedModel = { model: string; thinking?: string };
```
- **`proposalGateStart({mode, hash, last})`** returns `"move" | "full" | "recheck"`:
  - `"move"` when the mode is off, or `last` has the same hash and a clean verdict;
  - `"recheck"` when `last` has findings;
  - otherwise `"full"`.
- **`proposalGateAfterVerdict({verdict, findings, rounds, max})`** returns `"move" | "fix" | "pause" | "move-open"`. It follows the same rules as `discussionGateAfterVerdict`, where `rounds` is the count after this run.
- **`proposalGateAfterFixReply({prevHash, ready, replyHash})`** returns `"recheck"` only when `ready` is true and `replyHash !== prevHash`; otherwise `"pause"`.
- **`proposalGateOnInput({running, isGo})`** returns `"notice" | "cancel" | "pass"`.
- **`proposalReviewPrompts({proposal, list, repoTable, recheck?: Finding[]})`** returns `string[]`.
- **`proposalGateFromEntries(entries)`** returns the newest `GATE_ENTRY` as a `ProposalReview`, with `awaiting-fix` mapped to `idle`. Bad data gives `undefined`.
- **`nextLastProposal(mode, body, stoppedNormally)`** returns `{text, hash} | undefined`.
- **`roleSwitch({from, to, isSub, workflowPhase, hasRole, hasPrev})`** returns `"apply" | "restore" | "warn" | "none"`:
  - off→on with a role: `apply`;
  - on→off with `hasPrev`: `restore`;
  - either of those while a workflow phase is not off: `warn`;
  - a sub, or anything else: `none`.
- **`roleWarnText(direction: "on" | "off", phase, saved?)`** returns the warning text (S9).
- **`roleOnRestore(entries)`** returns the newest `MODE_ENTRY`'s `prevModel`, only when that entry's mode isn't `off`.

**Runtime state in `index.ts`**: `lastProposal?: {text, hash}`, `proposalReview?: ProposalReview`, `proposalRun?: {controller, offEsc?, hash, reason?: "esc" | "command" | "message" | "mode" | "restart"}`, `orchPrevModel?: SavedModel`.

**`MODE_ENTRY` data** becomes `{v: 1, mode, prevModel?}`. Old entries still parse.

**Messages**
- `orchestrate-proposal-review`: display only.
- `orchestrate-proposal-fix`: `triggerTurn: true`.
- `orchestrate-run-kickoff`: `triggerTurn: true`.

**Failure handling.** A judge error, an empty result or a missing model never blocks: the gate moves to run with the note `proposal judge did not run: <error>`.

**Scale.** Proposals are 50–300 lines. One judge runs per session at a time, and the timeout is 15 min.

**Rejected alternatives**
- Moving `agents/subagent.ts`: not needed.
- A cross-extension event to reuse `runRole`: it is a closure over workflow state.
- Re-applying the role at `session_start`: that runs before the config is loaded and before the sub check, and it would undo a model the workflow set.

### Stage 1: Shared finding helpers and `/flow plan force`

**S1.** Create `shared/findings.ts` as in the Design, moving the code out of `workflow/gates.ts` and `workflow/discussion-review.ts`:
- **From `gates.ts`:** lines :7-18, :48-94 (including `HEAD` and `ROUTE`), :141-143 and :197-200, plus the `node:crypto` `createHash` import. Then drop `createHash` from `gates.ts`; nothing else there uses it.
- **From `discussion-review.ts`:** lines :5-18.
- **Re-exports:** `gates.ts` uses `export { … } from "../shared/findings.ts"` and imports what it uses internally. `discussion-review.ts` re-exports `lastAgreedList` and defines `discussionVerdict = judgeVerdict`.
- No other workflow importer changes.

Add `shared/findings.test.ts`:
- `parseFindings` on a reply with two findings, checking severity, route and body;
- `isClean` for a PASS with no findings, and for a PASS with findings;
- `textHash` ignores CRLF and leading/trailing whitespace;
- `lastAgreedList` returns the newest list;
- `judgeVerdict` for PASS text and for FAIL text.

**S2.** In `workflow/gates.ts`, add `forcedOpenFindings(review: DiscussionReview | undefined, listHash: string): Finding[]`. It returns `review.findings` only when the review is set, `listHash !== ""` and `review.listHash === listHash`; otherwise `[]`. Add `gates.test.ts` cases:
- a matching list;
- an older list;
- no review;
- `listHash` `""` (a review with `listHash` `"abc"` gives `[]`).

**S3.** In the `/flow` handler (`workflow/index.ts:4746`), add `/flow plan force` (`sub` is `plan` and `rest[0] === "force"`), handled before the existing `plan` logic.
- **Outside discuss:** notify "workflow: /flow plan force works only in discuss" and return.
- **In discuss:**
  1. `const list = lastAgreedList(branchAssistantTexts(ctx.sessionManager.getBranch()))`.
  2. `const hash = list ? textHash(list) : ""`, the same as :3869.
  3. `await moveToPlan(ctx, forcedOpenFindings(state.discussionReview, hash))`. `setPhase` aborts a running discussion judge silently with reason `"phase"`. Never call `startDiscussionGate`.

Add `force` to the `plan` completion text in `SUBCOMMANDS`, following the existing entries. In `gate-wiring.test.ts`, add a source scan: the `"force"` branch contains `moveToPlan(ctx, forcedOpenFindings(` and no `startDiscussionGate(`.

**S4.** In `workflow/README.md`:
- **Commands** (:375): add `/flow plan force`.
- **Discussion gate** (:144): add that the force variant skips the judge and carries the matching open findings, and that it is the way out of a repeated `fix: user` pause.

**S5.** In `docs/workflow-improvements.md`, add these rows:
- **D48** "Finding helpers in `shared/findings.ts`": **Done**, naming the files.
- **D49** "Proposal judge, `/orch go force`, `/flow plan force`": **In progress**. `/flow plan force` is done and closes the D45 "stuck in discuss" flaw; the proposal judge comes later.
- **D50** "Orchestrator role and `confirmPlans` judge line": **Planned**.
- **D51** "Remove the stale `workflow/subagent.ts`/`mcp-forward.ts` copies; point `test-run.ts` at `agents/`": an idea only.

Also update the Status line and add Effect measurement rows:
- D48: no behaviour change; the suites pass.
- D49: proposal-judge findings per run, compared with drift and overlap events per run, plus the count of forced moves.
- D50: orchestrator turns on the role model, and `confirmPlans` rejections that cite the judge line.
- D51: none.

### Stage 2: Orchestrate config, orchestrator role, `confirmPlans` judge line

**S6.** Extend `OrchestrateConfig` in `orchestrate/config.ts`:
- `roles: { orchestrator?: RoleSpec; judge?: RoleSpec }`
- `autoJudgeProposal: "off" | "auto"`
- `maxProposalJudgeRounds: number` (added to `INT_KEYS`)
- `judge: { tools: string[]; timeoutMs: number; idleTimeoutMs: number; extensions: string[] }`

`DEFAULTS` gets `roles: {}`, `"auto"`, `2`, and `judge` = `{["read","grep","find","ls"], 900000, 300000, []}`.

The signature becomes `parseConfig(raw, exists: (p: string) => boolean = fs.existsSync)`.
- **Default for `judge.extensions`:** `[BRIDGE]` when `exists(expandHome(BRIDGE))`, otherwise `[]`. `BRIDGE` is the `~` path from D1, and `expandHome` comes from `../agents/subagent.ts`. The `raw === undefined` path and the missing-file path in `loadConfig` also use this computed default.
- **Validation:**
  - A role is an object `{model, thinking?}` where `parseRoleSpec(model)` is valid and `thinking` is in `THINKING_LEVELS`. `roles.orchestrator: false` means none. Anything else is bad.
  - `autoJudgeProposal` must be `"off"` or `"auto"`.
  - `judge.tools` must be a non-empty array of strings.
  - `judge.timeoutMs` must be an integer ≥ 1, and `judge.idleTimeoutMs` an integer ≥ 0.
  - `judge.extensions` must be an array of strings.
- **A bad value** counts as missing, and its key path (for example `roles.judge`) is added to `bad`.

Add `config.test.ts` cases:
- the defaults, once with `exists` returning true and once returning false (which gives `[]`);
- the full D1 object;
- each of these falls back with a warning: a bad role, a bad thinking level, a bad `autoJudgeProposal`, `maxProposalJudgeRounds` of 0, and bad `judge.tools`;
- `roles.orchestrator: false`.

**S7.** Create `pi/agent/orchestrate.json` with exactly the D1 values, plus a `_comment` string modeled on `pi/agent/agents.json:2` that names the keys and says it is synced by pi-config.

**S8.** Create `orchestrate/proposal-gate.ts` with `SavedModel`, `roleSwitch`, `roleWarnText` and `roleOnRestore` from the Design. The gate helpers come in Stage 3. Add `proposal-gate.test.ts`:
- **`roleSwitch`:**
  - off→discuss with a role: `apply`;
  - discuss→propose: `none`;
  - run→off with `hasPrev`: `restore`;
  - run→off without `hasPrev`: `none`;
  - a sub: `none`;
  - off→discuss with `workflowPhase` `"plan"`: `warn`;
  - off→discuss with no role: `none`.
- **`roleWarnText`:**
  - `"on"` contains "was not switched";
  - `"off"` with a saved model contains `/model <model>` and the thinking level.
- **`roleOnRestore`:**
  - off→discuss(prevModel P)→propose(prevModel P) gives P;
  - a final `off` entry gives `undefined`;
  - an old entry without `prevModel` gives `undefined`.

**S9.** Change `setMode` (`orchestrate/index.ts:537`) to `setMode(m, announce = true, ctx?: ExtensionContext)`:
1. Compute the action: `roleSwitch({from: mode, to: m, isSub: !!me, workflowPhase: typeof lastK4?.phase === "string" ? lastK4.phase : undefined, hasRole: !!cfg.roles.orchestrator, hasPrev: !!orchPrevModel})`.
2. On `apply`, when `ctx?.model` is set, save `orchPrevModel` from the current model and thinking level (as `workflow/index.ts:678` does).
3. Write `MODE_ENTRY` as `{v: 1, mode: m, prevModel: m === "off" ? undefined : orchPrevModel}`.
4. Act on the result:
   - **`apply`:** `void applyOrchestratorRole(ctx)`.
   - **`restore`:** `void restoreModel(ctx, saved)`.
   - **`warn`:** warn with `roleWarnText`. For off→on the text is "orchestrate: the workflow is in phase X; the model was not switched". For on→off it is "orchestrate: the workflow is in phase X; the model was not restored. Set it back with /model `<orchPrevModel.model>`", plus " and thinking `<thinking>`" when one was saved. Build the text before `orchPrevModel` is cleared.
   - **Entering `off`:** clear `orchPrevModel` after the action above.

Both new functions are modeled on `workflow/index.ts:586-611`. When the model is not found or has no credentials, they warn and keep the current model. They never throw: wrap them in try/catch and warn. Without a `ctx`, nothing is switched.

Pass `ctx` at every call site:
- :1754, :1761, :1774, :1782 and :1793 use the `/orch` handler's `ctx`;
- :591: change the hook to `pi.on("input", async (event, ctx) => …)`.

In `session_start`, after :1896, set `orchPrevModel = roleOnRestore(branch)` and switch nothing. In `become`, also clear `orchPrevModel`.

**S10.** Add `confirmPlanTitle(id, summary, judgeLine?)` to `orchestrate/plan-judge.ts`. With a non-empty `judgeLine` it returns `` `Approve plan of ${id}? ${summary}\n${judgeLine}` ``; otherwise exactly `` `Approve plan of ${id}? ${summary}` ``.

At `index.ts:1627`, find the newest outbox message of type `plan-review` with `data.n === params.n`, take its `data.judgeLine` when it is a string, and use `confirmPlanTitle` for the select title. Add tests in `plan-judge.test.ts` for a judge line, for `undefined`, and for `""`.

**S11.** Add scans to `orchestrate/wiring.test.ts`:
- `setMode` contains `roleSwitch(`, and `appendEntry(MODE_ENTRY` with `prevModel`;
- the `session_start` body contains `roleOnRestore(` and no `setModel(`;
- the `input` hook takes `ctx`;
- `orch_review_plan` contains `confirmPlanTitle(` and `judgeLine`.

**S12.** Update the docs:
- **`orchestrate/README.md`, Config** (:93): document every new key, the D2 defaults, and the role switch rules:
  - off↔on only, never in a sub;
  - while a workflow phase runs it warns, and the warning names the model to set back;
  - `/orch off` restores `prevModel`, which survives a restart.
- **`docs/workflow-improvements.md`:** mark D50 **Done** and update the Status line.

### Stage 3: Proposal gate and `/orch go force`, `/orch judge cancel`

**S13.** Add four prompts to `orchestrate/prompts.ts`:
- **`JUDGE_PROPOSAL`:** "you review a `## Packages:` proposal against the agreed list and the code (read-only tools; the repo table gives absolute paths)". It lists the D4 checks and the finding format: `- <blocker|major|minor> - [<category>] fix: <auto|user> - <head>`, then `Why:` and `Fix:` lines, matching what `parseFindings` reads. It says to use `fix: user` only for a decision the discussion didn't make, and to end with `VERDICT: PASS` or `VERDICT: FAIL`. Model it on the workflow's `JUDGE_PLAN` text, but write it new; don't import from `workflow/`.
- **`JUDGE_PROPOSAL_RECHECK`:** report each earlier finding as fixed, open or disputed, then any new problems, in the same format.
- **`PROPOSAL_FIX`:** "The proposal judge found problems. Revise the `## Packages:` proposal to fix the findings below and reply with the full revised proposal; ask only when a finding needs the user's decision."
- **`NO_AGREED_NOTE`:** "No `Agreed so far:` list was found; judge the proposal against itself and the code."

**S14.** Add the gate helpers from the Design to `orchestrate/proposal-gate.ts`. `proposalReviewPrompts` returns:
- **Full pass:** `[JUDGE_PROPOSAL, "## Agreed list\n"+(list ?? NO_AGREED_NOTE), "## Repos\n"+(repoTable ?? "single repo: the working folder"), "## Proposal\n"+proposal]`.
- **Recheck:** `JUDGE_PROPOSAL_RECHECK` with the same parts plus `"## Previous findings\n"+findingsBlock(recheck)`.

Add tests to `proposal-gate.test.ts`:
- **`proposalGateStart`:** off gives `move`; a clean review on the same hash gives `move`; a review with findings gives `recheck`; no review gives `full`.
- **`proposalGateAfterVerdict`:**
  - PASS with no findings: `move`;
  - an auto finding at rounds 1 of max 2: `fix`;
  - an auto finding at rounds 2: `move-open`;
  - a user finding at rounds 2: `pause`;
  - rounds 1 then 2 count up to the cap.
- **`proposalGateAfterFixReply`:** ready with a new hash gives `recheck`; ready with the same hash gives `pause`; not ready gives `pause`.
- **`proposalGateOnInput`:** all three results.
- **`proposalReviewPrompts`:** a full pass contains the list, or the note when there is no list, plus the repo table and the proposal; a recheck contains the earlier findings.
- **`proposalGateFromEntries`:** `awaiting-fix` becomes `idle`; bad data gives `undefined`.
- **`nextLastProposal`:** a ready reply sets it; a reply that isn't ready gives `undefined`; any mode other than propose gives `undefined`.

The rounds reset on "go" is checked by the wiring scans in S22.

**S15.** Show the judging label in the widget without changing the mode argument:
- **`orchestrate/view.ts:198`:** the signature becomes `widgetLines(view, mode, _now, paint = plain, width = 120, judging?: string)`. All mode checks (:200, :201, :205) keep comparing the raw `mode`. Only the displayed text uses `phaseLabel(mode, judging)` (already imported at `view.ts:6`):
  - with no view: `` `orch ▸ ${phaseLabel(mode, judging)}` ``;
  - with a view and a mode other than `off`: `phaseLabel(mode, judging)`.
- **`orchestrate/plan-judge.ts`:** extend `phaseLabel` so that `judging === "proposal"` gives `` `${phase} (judging proposal)` ``. Add a `plan-judge.test.ts` case.
- **`orchestrate/index.ts:840`:** the render closure passes `mode` unchanged and adds `proposalRun ? "proposal" : undefined` as the last argument, read at render time. `runProposalGate` calls `updateWidget()` after it sets `proposalRun` and after it clears it. That triggers `widgetTui?.requestRender()` (:849).

Add `view.test.ts` cases:
- `widgetLines(null, "propose", 0, undefined, 120, "proposal")[0]` contains `orch ▸ propose (judging proposal)`;
- `widgetLines(null, "propose", 0)[0]` contains `orch ▸ propose` and not `judging`.

**S16.** Add `runJudge(ctx, systemPrompts, signal)` to `orchestrate/index.ts`. It calls `runSubagent` from `../agents/subagent.ts` with:
- `role`: `cfg.roles.judge`, or when that is missing, `{model: "<provider>/<id>" of ctx.model, thinking: "high"}`;
- `tools: cfg.judge.tools`, `extensions: cfg.judge.extensions`, `timeoutMs: cfg.judge.timeoutMs`, `idleTimeoutMs: cfg.judge.idleTimeoutMs`;
- `cwd: ctx.cwd`, `signal`;
- `task`: "Review the package proposal as described in your system prompt."

When there is no role and no `ctx.model`, it returns `{ok: false, error: "no model for the judge"}`.

**S17.** Add `runProposalGate(ctx, decision: "full" | "recheck", resetRounds: boolean)` to `orchestrate/index.ts`, modeled on `workflow/index.ts:3864-3960`.

1. **Prepare.**
   - Abort any running `proposalRun` with reason `restart`.
   - Without `lastProposal`, notify "nothing to judge" and return.
   - `rounds = resetRounds ? 0 : proposalReview?.rounds ?? 0`.
   - Build the prompts:
     - the list comes from `lastAgreedList` over the assistant texts of `ctx.sessionManager.getBranch()`, built with the existing `assistantText` (:549);
     - the repo table is `repoTableCache?.text`, or `repoTableText` of `await sessionRepos(ctx)`;
     - a recheck also passes `proposalReview.findings`.
2. **Run.**
   - Create `proposalRun` with an `AbortController` and `hash = lastProposal.hash`.
   - When `ctx.hasUI`, register Esc: `ctx.ui.onTerminalInput((d) => isEscKey(d) ? (abortProposal("esc"), {consume: true}) : undefined)`.
   - Call `updateWidget()` and `ctx.ui.setWorkingMessage("judge reviewing the proposal…")`, then `await runJudge(…)`.
   - In a `finally`: call `offEsc`, clear `proposalRun` if it is still this run, clear the working message, and call `updateWidget()`.
3. **Handle the outcome.**
   - **Aborted:** reason `esc` or `command` notifies "orchestrate: proposal judge cancelled; still in propose" and sets the review status to `idle`. Reasons `message`, `mode` and `restart` are silent. No round is counted.
   - **Stale:** when `mode !== "propose"` or `lastProposal?.hash !== run.hash`, return.
   - **Error:** warn "orchestrate: proposal judge did not run: <error>", then `moveToRun(ctx, [])`.
   - **Result:**
     1. Parse it: `findings = parseFindings(text)`, `verdict = judgeVerdict(text)`, `rounds += 1`.
     2. Store `proposalReview = {hash, verdict, findings, rounds, status: "idle"}` and save it with `pi.appendEntry(GATE_ENTRY, {v: 1, ...})` inside a try/catch that warns on failure.
     3. Post `orchestrate-proposal-review` (display only) with the verdict and the `findingsBlock`.
     4. Act on `proposalGateAfterVerdict(..., max: cfg.maxProposalJudgeRounds)`:
        - `move`: `moveToRun(ctx, [])`;
        - `move-open`: `moveToRun(ctx, findings)`;
        - `fix`: set the status to `awaiting-fix`, save, and send `orchestrate-proposal-fix` with `PROPOSAL_FIX` and the auto findings (`triggerTurn: true`, the :217 pattern);
        - `pause`: set the status to `paused`, save, and notify "orchestrate: the proposal judge needs your decision; answer, then say \"go\" (or /orch go force)".

`moveToRun(ctx, open)`:
1. Set the review status to `idle`.
2. Call `setMode("run", true, ctx)`.
3. Send `orchestrate-run-kickoff` with `RUN_KICKOFF` (`triggerTurn: true`). When `open` is non-empty, also include "\n\nOpen proposal-judge findings; settle them in the briefs' decisions:\n" followed by `findingsBlock(open)`.

`abortProposal(reason)` sets the reason once and aborts, modeled on `workflow/index.ts:355`. `setMode` calls `abortProposal("mode")` and clears `lastProposal`. Going from off to discuss also clears `proposalReview`.

**S18.** Rework the `input` hook (`index.ts:579`). Keep the user-message recording (:581-584) and the early return (:585). Slash commands still pass through before the gate logic.
1. **While `proposalRun` is running:** `proposalGateOnInput` gives `notice` (notify "orchestrate: proposal judge running (Esc or any other message cancels it)", return `handled`) or `cancel` (`abortProposal("message")`, then continue).
2. **In propose, when the text matches `goRe()` and `lastProposal` is set:** compute `d = proposalGateStart({mode: cfg.autoJudgeProposal, hash: lastProposal.hash, last: proposalReview})`.
   - `move`: today's path, `setMode("run", true, ctx)` and return `transform` with `RUN_KICKOFF`.
   - Otherwise: `void runProposalGate(ctx, d, true)` and return `handled`.
3. **Everything else, including discuss→propose:** `onTyped` runs as today, with `!!lastProposal` as `proposalReady`. A typed message that isn't "go" clears `lastProposal`, the same as `proposalReady = false` does today.

Replace `proposalReady` with `lastProposal` everywhere.

**S19.** Change the `agent_end` hook (`index.ts:595`) to `async (event, ctx)`.
1. In propose, set `lastProposal = nextLastProposal(mode, body, stoppedNormally)`.
2. Then, when `proposalReview?.status === "awaiting-fix"` and no run is active, call `proposalGateAfterFixReply({prevHash: proposalReview.hash, ready: !!lastProposal, replyHash: lastProposal?.hash})`:
   - `recheck`: `void runProposalGate(ctx, "recheck", false)`;
   - `pause`: set the status to `paused`, save, and notify as in S17.

**S20.** In `session_start`, next to :1896: set `proposalReview = proposalGateFromEntries(branch)` and `lastProposal = undefined`, and abort any `proposalRun` with reason `restart`.

**S21.** Add two subcommands to the `/orch` handler (`index.ts:1742-1800`):
- **`go force`:**
  - outside propose: notify "orchestrate: /orch go force works only in propose";
  - with no `lastProposal`: notify "orchestrate: no finished proposal to run";
  - otherwise: `abortProposal("command")`, then `moveToRun(ctx, proposalReview?.hash === lastProposal.hash ? proposalReview.findings : [])`;
  - `go` without `force`: notify the usage.
- **`judge cancel`:** when `proposalRun` is running, `abortProposal("command")`; otherwise notify "orchestrate: no judge running".

Also:
- add `go` and `judge` to the completions (:1741) and the usage line (:1800);
- in the `/orch` description and the propose `mode` notice (:1759), mention that "go" runs the proposal judge first.

**S22.** Add scans to `orchestrate/wiring.test.ts`:
- the propose "go" branch matches `runProposalGate(ctx, <identifier>, true)` and returns `"handled"`;
- the `agent_end` hook signature has `ctx`, and its body contains `nextLastProposal(`, `proposalGateAfterFixReply(` and `runProposalGate(ctx, "recheck", false)`;
- the `runProposalGate` body contains `resetRounds ? 0 :`, passes `signal:` to `runJudge`, and calls `offEsc` inside a `finally`;
- `setMode` calls `abortProposal(`;
- the render closure passes `proposalRun ? "proposal" : undefined` to `widgetLines(`;
- the completions include `"go"` and `"judge"`;
- `runSubagent` is imported from `"../agents/subagent.ts"`.

`boundary.test.ts` is unchanged and must pass.

**S23.** Add to `orchestrate/README.md`:
- **Usage:**
  - the proposal gate: what it checks, the times (about 1–3 min for a full pass, under 90 s for a recheck), Esc and typed-text cancels, the pause on `fix: user`;
  - `/orch go force` and `/orch judge cancel`;
  - the `confirmPlans` judge line.

**S24.** In `docs/workflow-improvements.md`, mark D49 **Done** (naming the files) and update the Status line.

**S25.** Run all the suites (see Tests) and fix failures until the expected results hold.

**S26.** Verify these by hand; they are listed for you:
- **Overlapping `owns`:** a 2-package orchestra run where the proposal has an overlapping `owns` glob. Look for the judge finding it, the orchestrator fixing it before the run, the `propose (judging proposal)` label clearing, and the fix or kickoff message within about 3 min (90 s for a recheck).
- **Esc:** press Esc while the proposal judge runs. Look for "cancelled; still in propose".
- **Role switch:** `/orch start`. Look for the model becoming Opus 5.5 high; `/orch off` restores the earlier model.
- **Restart:** restart while in propose, then `/orch off`. Look for the earlier model coming back.
- **`confirmPlans` prompt:** look for the sub's `judge:` line in it.

**S27.** Deliver: merge — the install in S28 copies the merged `master`.

**S28.** On `master` after the merge:
1. Run `node bin/import.js --dry-run`. Check that it lists `orchestrate.json` and the changed extension files, and nothing unexpected.
2. Run `node bin/import.js`.
3. Tell the user to restart running pi sessions.

### Tests
- **Stage 1:**
  - `cd pi/agent/extensions/shared && node --experimental-strip-types --test *.test.ts`: all pass, including `findings.test.ts`.
  - Fast workflow check: `cd pi/agent/extensions/workflow && node --experimental-strip-types --test gates.test.ts discussion-review.test.ts gate-wiring.test.ts`: all pass.
  - Full workflow suite, slow (over 2 min); run it once per stage that touches the workflow: `cd pi/agent/extensions/workflow && timeout 580 node --experimental-strip-types --test *.test.ts`. The only failure allowed is the known one in `publish.test.ts`.
- **Stages 2 and 3:** `cd pi/agent/extensions/orchestrate && node --experimental-strip-types --test *.test.ts`: all pass, including `boundary.test.ts`, `config.test.ts`, `proposal-gate.test.ts`, `plan-judge.test.ts`, `view.test.ts` and `wiring.test.ts`.
- **Syntax:** run `stripTypeScriptTypes` checks on the new and changed `.ts` files. There is no `tsc`.

### Done when
- The shared and orchestrate suites pass, including `boundary.test.ts`. The workflow suite fails only on the known `publish.test.ts`.
- With the installed config, "go" on a proposal runs the proposal judge. The `propose (judging proposal)` label clears, and the kickoff or fix message arrives within about 3 min for a full pass, or 90 s for a recheck.
- `/orch go force` and `/flow plan force` move on, carrying the matching open findings.
- Orchestrator mode runs on Opus 5.5 high. After a restart it is still on Opus 5.5 high with `prevModel` kept, and `/orch off` brings back the earlier model.
- The `confirmPlans` prompt shows the sub's judge line, and is unchanged when there is none.
- Without `orchestrate.json`, no model is switched.
- The READMEs and backlog rows D48–D51 are updated, and `orchestrate.json` is installed.

### Risks, rollback, what not to touch
- **Risks**
  - The `input` and `agent_end` changes could break the discuss→propose step. The wiring scans and the unchanged `onTyped` path cover this.
  - The role switch could fight a workflow phase. The `warn` path, which names the model to set back, covers this.
  - A missing bridge extension makes every judge run fail. That never blocks, and the `[]` default avoids it.
- **Rollback**
  - `autoJudgeProposal: "off"` turns the proposal gate off.
  - Removing `roles.orchestrator` stops the model switch.
  - Revert the commits.
- **Don't touch:** `gitRaw`, `diffBase`, `pickDiffBase`, the `addAccepted` ordering, `workflow/merge-gate.ts`, the execute judge loop, the D42/D43 code, `workflow/subagent.ts`, `workflow/mcp-forward.ts`, `agents/*`, and `pi/agent/orchestrate-spawned.json` (never commit it).

### Commits
1. `shared: finding helpers in shared/findings.ts`: S1 and the D48 row from S5. Files: `shared/findings.ts`, `shared/findings.test.ts`, `workflow/gates.ts`, `workflow/discussion-review.ts`, `docs/workflow-improvements.md`.
2. `workflow: /flow plan force`: S2–S4, plus the D49/D50/D51 rows and the Status line from S5. Files: `workflow/gates.ts`, `workflow/gates.test.ts`, `workflow/index.ts`, `workflow/gate-wiring.test.ts`, `workflow/README.md`, `docs/workflow-improvements.md`.
3. `orchestrate: config keys for roles, the proposal judge and judge runs; orchestrate.json`: S6–S7. Files: `orchestrate/config.ts`, `orchestrate/config.test.ts`, `pi/agent/orchestrate.json`.
4. `orchestrate: orchestrator role switch and confirmPlans judge line`: S8–S12. Files: `orchestrate/proposal-gate.ts` (with `roleSwitch`, `roleWarnText`, `roleOnRestore`), `orchestrate/proposal-gate.test.ts`, `orchestrate/index.ts`, `orchestrate/plan-judge.ts`, `orchestrate/plan-judge.test.ts`, `orchestrate/wiring.test.ts`, `orchestrate/README.md`, `docs/workflow-improvements.md`.
5. `orchestrate: proposal judge gate, /orch go force, /orch judge cancel`: S13–S24. Files: `orchestrate/prompts.ts`, `orchestrate/proposal-gate.ts`, `orchestrate/proposal-gate.test.ts`, `orchestrate/plan-judge.ts`, `orchestrate/plan-judge.test.ts`, `orchestrate/view.ts`, `orchestrate/view.test.ts`, `orchestrate/index.ts`, `orchestrate/wiring.test.ts`, `orchestrate/README.md`, `docs/workflow-improvements.md`.

## Amendment 1 (executor: verify)
Hand checks (S26): overlapping owns caught by the proposal judge; Esc during the judge; /orch start and /orch off model switch; restart in propose then /orch off; confirmPlans judge line. (step S26)


<!-- pi-workflow:status -->
## Checklist
- [x] S1 Create `shared/findings.ts` as in the Design, moving the code out of `workflow/gates.ts` and `workflow/discussion-review
- [x] S2 In `workflow/gates.ts`, add `forcedOpenFindings(review: DiscussionReview | undefined, listHash: string): Finding[]`. It 
- [x] S3 In the `/flow` handler (`workflow/index.ts:4746`), add `/flow plan force` (`sub` is `plan` and `rest[0] === "force"`), h
- [x] S4 In `workflow/README.md`:
- [x] S5 In `docs/workflow-improvements.md`, add these rows:
- [x] S6 Extend `OrchestrateConfig` in `orchestrate/config.ts`:
- [x] S7 Create `pi/agent/orchestrate.json` with exactly the D1 values, plus a `_comment` string modeled on `pi/agent/agents.json
- [x] S8 Create `orchestrate/proposal-gate.ts` with `SavedModel`, `roleSwitch`, `roleWarnText` and `roleOnRestore` from the Desig
- [x] S9 Change `setMode` (`orchestrate/index.ts:537`) to `setMode(m, announce = true, ctx?: ExtensionContext)`:
- [x] S10 Add `confirmPlanTitle(id, summary, judgeLine?)` to `orchestrate/plan-judge.ts`. With a non-empty `judgeLine` it returns 
- [x] S11 Add scans to `orchestrate/wiring.test.ts`:
- [x] S12 Update the docs:
- [x] S13 Add four prompts to `orchestrate/prompts.ts`:
- [x] S14 Add the gate helpers from the Design to `orchestrate/proposal-gate.ts`. `proposalReviewPrompts` returns:
- [x] S15 Show the judging label in the widget without changing the mode argument:
- [x] S16 Add `runJudge(ctx, systemPrompts, signal)` to `orchestrate/index.ts`. It calls `runSubagent` from `../agents/subagent.ts
- [x] S17 Add `runProposalGate(ctx, decision: "full" | "recheck", resetRounds: boolean)` to `orchestrate/index.ts`, modeled on `wo
- [x] S18 Rework the `input` hook (`index.ts:579`). Keep the user-message recording (:581-584) and the early return (:585). Slash 
- [x] S19 Change the `agent_end` hook (`index.ts:595`) to `async (event, ctx)`.
- [x] S20 In `session_start`, next to :1896: set `proposalReview = proposalGateFromEntries(branch)` and `lastProposal = undefined`
- [x] S21 Add two subcommands to the `/orch` handler (`index.ts:1742-1800`):
- [x] S22 Add scans to `orchestrate/wiring.test.ts`:
- [x] S23 Add to `orchestrate/README.md`:
- [x] S24 In `docs/workflow-improvements.md`, mark D49 Done (naming the files) and update the Status line.
- [x] S25 Run all the suites (see Tests) and fix failures until the expected results hold.
- [x] S26 Verify these by hand; they are listed for you:
- [x] S27 Deliver: merge — the install in S28 copies the merged `master`.
- [x] S28 On `master` after the merge:
## Outcome
2026-11-13T18:20:47.667Z — ok: stage 1: flow/orch-proposal-judge, 2 commits since the review base, PR #42 OPEN https://github.com/Unknownow/pi-config/pull/42; stage 2: flow/orch-proposal-judge, 3 commits since the review base, PR #42 OPEN https://github.com/Unknownow/pi-config/pull/42; stage 3: master, 3 commits since the review base, PR #42 MERGED https://github.com/Unknownow/pi-config/pull/42 · 1 human check(s) for you (see the card)
