<!-- pi-workflow plan v1 flow=20261111-0322-orchestrate-extension-where-one-orchestr-f007 -->
## Plan: orchestrate extension, where one orchestrator session runs 2–4 workflow sub-sessions in wt worktrees

**Goal:** a new `orchestrate` extension.
- The orchestrator session discusses the work with you and splits it into work packages, ordered by their dependencies.
- It opens each package as a sub-session in its own `wt` worktree, in a visible terminal.
- Each sub-session starts the workflow at the **plan** phase from a brief, so it skips discuss.
- The orchestrator reviews each sub-session's plan, checks progress and owned paths through git, and answers questions.
- It accepts the result before the sub-session merges its own PR.

**Non-goals (v1):**
- An integration branch with one final merge.
- Several repos in one run.
- Automatic restart of a crashed sub-session; v1 only reports it, and it's reopened with `/wt open`.
- Copying Unity `Library/` (becomes backlog idea A42).
- Sub-sessions talking to each other directly.
- More than one active run per repo.

### User decisions
- D1: a new `orchestrate` extension. The orchestrator talks with you, and sub-sessions run the workflow without the discuss phase.
- D2: 2–4 sub-sessions, configurable, with a default limit of 4 running at once.
- D3: one `wt` worktree per sub-session (each its own Unity project), opened in a visible terminal.
- D4: sub-sessions start from a brief at the plan phase, and the orchestrator reviews their plans. With `confirmPlans` on (the default), you confirm each approval from a one-line summary.
- D5: monitoring has three parts: plan review before any code; git-based checks during execution (owned paths, progress, heartbeat); acceptance against the brief before merging.
- D6: communication goes through per-run files under `<git common dir>/pi/orchestra/<run>/`. Inbox and outbox files are only ever appended to, they are delivered with `pi.sendMessage`, and every message passes through the orchestrator.
- D7: each sub-session opens and merges its own PR. That merge needs the judge PASS **and** the orchestrator's acceptance of the same tree.
- D8: workflow and worktree get only small hooks, as public contracts. Orchestrate never imports from them.
- D9: no Unity `Library/` copy in v1. The backlog row is updated in the same commit as the workflow change (repo AGENTS.md).

Stages:
1. **Hooks:** workflow contracts K9–K11, the extra K4 fields, the worktree W1 event, and the shared claim helper, with tests.
2. **Orchestrate core:** the pure modules (store, brief, paths, monitor, config), with tests.
3. **Orchestrate wiring:** tools, watchers, commands, README, backlog marked Done, and applying it to this machine.

### Facts the executor needs
- Extensions live at `pi/agent/extensions/<name>/index.ts` and are loaded automatically. Tests run with `node --experimental-strip-types --test <files>` (`quiet-tools/README.md`).
- Each extension has a `boundary.test.ts` that bans imports between extensions (`workflow/boundary.test.ts:6-15`). Shared code goes in `extensions/shared/`, as for K5, K7 and K8 in `workflow/README.md:242-245`.
- **The claim pattern over the event bus:**
  - Emitter: `workflow/folder-add.ts:1-30`.
  - Listener: `worktree/index.ts:835-856`. It registers in `session_start` and calls `claim(promise)` synchronously.
  - The contract text is K6 in `workflow/README.md:243`.
- **Workflow:**
  - `lastCtx` is kept at `index.ts:345` and set at `index.ts:423`.
  - `emitStatus` (K4) is at `index.ts:457-472`. The step counts are computed at `index.ts:440-446` (`view.progress`).
  - `setPhase` is at `index.ts:537`; `approve(ctx)` at `index.ts:676-688`.
  - The plan-phase branch of agent_end is at `index.ts:3124-3171`: `canApprove` at 3132, `blocked` at 3145, the `cfg.planPrompt` check at 3147 and the menu at 3156.
  - Typed "go" is handled at `index.ts:3007`.
  - In `session_start` (`index.ts:3816-3869`), a new session uses `--flow` or `cfg.startPhase`. Your `pi/agent/workflow.json:41` sets `startPhase: "off"`.
  - The plan-phase tool allowlist is `planAllowedTools` (`config.ts:122,196`, `workflow.json:75`), checked by `phaseToolRefusal` (`readonly-tools.ts:40`). An `ask_orchestrator` tool would be refused in the plan phase unless it is allowed.
  - Merge gate: the closure in the tool_call guard is at `index.ts:2772-2789`; `res.tree` exists after `gateCheck` passes, at 2778-2780. The `git_task` spec is built at `index.ts:2244-2251` (the `midFlow` field). `git-guard.ts:20-47,70-74` parses and applies that spec.
  - Publishing also goes through `gateCheck`/`gateProblem`. Find every call site with `grep -n "gateCheck\|gateProblem" workflow/*.ts`.
- **Worktree:**
  - `createSet` (`index.ts:196-246`) asks for a name only when none is given (210-220).
  - `newSet` (`index.ts:248-257`) creates the set, then runs `launch(...)` and `notify`.
  - `createSet`, `collect` and `addedFolders` are typed `ExtensionCommandContext`, but they only use `cwd`, `ui`, `hasUI` and `sessionManager`. A normal `ExtensionContext` has those too (workflow reads `ctx.sessionManager.getBranch()` at `workflow/index.ts:3824`).
  - The set's branch is `wt/<name>`, and `checkName` (`layout.ts:7-11`) allows a-z, 0-9, `.`, `_` and `-`, up to 40 characters.
  - Set worktrees are `git worktree add` of the main repo (`add-folder.test.ts:43`), so they share its git common dir.
- **pi API** (`docs/extensions.md:1627-1667`):
  - `pi.sendMessage(msg, { deliverAs: "steer" | "followUp", triggerTurn: true })` delivers into a running or idle session.
  - `pi.sendUserMessage(text)` starts a user turn.
- **Backlog doc:** `docs/workflow-improvements.md`. The rules are at lines 7-11 and the Status line is line 5. The last IDs are A40 and D38. The effect table starts at line 146.

### Design

**Components**
- `shared/claims.ts`: a generic version of the K6 claim pattern, `gatherClaims(emit, data, timeoutMs)`. It returns the first non-null answer, or `{ error }` on a rejection or timeout. Used by workflow K9–K11 and by orchestrate for W1. K6 itself is not refactored.
- **workflow:**
  - **K4+:** the status payload also carries `done?`, `total?` (non-human steps) and `waiting?: true`.
  - **K9 `workflow:start-plan`:** `{ v:1, title, brief, allowTools?: string[], claim }`.
    - Only when the phase is off or discuss and no plan is approved, workflow does the following: `setPhase(lastCtx, "plan")`; stores `allowTools` in the flow state (persisted) as extra plan- and discuss-phase tools; then `pi.sendUserMessage` with a fixed preface ("The discussion is done; its result is this brief. Write the plan.") followed by the brief.
    - It answers `{ ok: true }` or `{ error }`.
  - **K10 `workflow:plan-ready`:** `{ v:1, title, plan, claim }` is emitted in the plan branch of agent_end when the plan can be approved and nothing blocks it. It comes before the `cfg.planPrompt` check, so it works with either setting.
    - A listener that claims means no menu. Workflow notifies "plan sent for review; type go to approve it yourself".
    - The claimed promise resolves later to one of:
      - `{ approve: true }`: workflow calls `approve(lastCtx)`, but only if the phase is still plan and the composed plan is unchanged.
      - `{ reject: string }`: workflow sends `pi.sendMessage({ customType: "workflow-plan-review", content: reasons + "revise the plan" }, { triggerTurn: true })`.
      - `null`, or no claim: the normal menu.
    - There is no timeout, because typed "go" still approves. A late answer after the phase has changed is ignored.
  - **K11 `workflow:merge-gate`:** `{ v:1, kind: "merge"|"protected-push"|"publish", cwd, tree: string|null, claim }` is asked after the judge gate has passed.
    - An answer `{ problem }` refuses the merge with that text. `null` or no listener allows it. A timeout of 30 s or a rejection refuses with "the acceptance check did not answer".
    - It covers three paths:
      - The tool_call gate asks with `res.tree`.
      - The publish gate sites ask with the tree they gate, or `null`.
      - The `git_task` spec asks with `tree: null` before it spawns, and stores any problem in a new `acceptance?: string` field of `GitGuardSpec`. `git-guard.ts` then refuses merges, protected pushes and publishes with it, the same way it handles `midFlow`.
- **worktree, W1 `worktree:create`:** `{ v:1, name, claim }` resolves to `{ name, branch, cwd, setRoot, launched: boolean, text }` or `{ error }`.
  - The listener is registered in `session_start` (same pattern as at 835).
  - It runs the same code as `/wt new <name>`: the existing body is extracted into a helper shared by `newSet` and the listener, with no name prompt.
  - It refuses when the session is not in a git repo.
- **orchestrate:**
  - `config.ts`
  - `store.ts`: files, the append-only message log, atomic `run.json` writes
  - `brief.ts`: package validation, waves, brief and kickoff text, set names
  - `paths.ts`: glob matching for owned and forbidden paths
  - `monitor.ts`: a pure function from snapshots to events
  - `index.ts`, which has two roles:
    - **Orchestrator side:** the tools `orch_run`, `orch_spawn`, `orch_status`, `orch_send`, `orch_review_plan` and `orch_accept`; the `/orch status|watch|end` command; and the watcher.
    - **Sub-session side:** it recognises that it is a sub-session, starts the flow, writes status and heartbeat, delivers the inbox, provides the `ask_orchestrator` tool, and listens to K10 and K11.
  - The orchestrator session runs with the workflow **off** (your default `startPhase`), because the workflow refuses non-reading tools in discuss and plan. The `orch_*` tools write only under `<common>/pi/orchestra/`.

**Files** (single writer per file; `<common>` = `git rev-parse --git-common-dir`, absolute, forward slashes):
```
<common>/pi/orchestra/<runId>/run.json          orchestrator only (tmp + rename)
  { v:1, id, title, created, owner:{pid,host,session}, state:"active"|"ended",
    subs:[{ id, goal, criteria[], owns[], forbids[], dependsOn[], decisions[], notes?,
            name, branch?, cwd?, base?, state:"planned"|"spawned"|"planning"|"executing"|"awaiting-acceptance"|"merged"|"stopped" }] }
<runId>/<sub>/brief.md        orchestrator only
<runId>/<sub>/status.json     sub-session only: { v:1, phase, flowId?, title?, stage?, stages?, done?, total?, waiting?, heartbeat, pid }
<runId>/<sub>/outbox.jsonl    sub-session only;  inbox.jsonl: orchestrator only
<runId>/<sub>/accepted.json   orchestrator only: { trees: string[] }
<runId>/<sub>/plan-<n>.md     sub-session only (plan text for review)
<runId>/<sub>/inbox.read, <runId>/outbox.read.json   cursors (line counts), owned by the reader
```
- **Message line:** `{ "v":1, "id":"<sub|orch>-<n>", "ts":ISO, "type":..., "replyTo"?, "text", "data"? }`.
  - Sub-session to orchestrator types: `question`, `plan-review` (`data.file`), `accept-request` (`data.tree`), `flow-ended` (`data.flowId`), `note`.
  - Orchestrator to sub-session types: `answer`, `plan-verdict` (`data.approve`), `accept-verdict` (`data.accept`, `data.tree`), `directive` (`data.urgent`), `info`.
- A reader ignores a last line that has no trailing newline (it may be half written). Long texts such as plans go into separate files.
- **IDs:**
  - `runId` = `o` + `MMDDHHmm` + `-` + a title slug, cut so the whole ID is ≤ 30 characters.
  - The sub ID is a slug `[a-z0-9][a-z0-9-]{0,15}`.
  - The set name is `<o+MMDDHHmm>-<sub>`, which must pass the same rules as `checkName`.

**Behaviour**
- **`orch_run`:** validates the packages:
  - IDs are unique, `dependsOn` names only known packages, and there are no cycles.
  - `owns` is not empty, and no two packages own the same glob.
  - It writes `run.json` and the briefs.
  - It refuses when another active run exists in this repo.
- **Waves:** a sub-session can be spawned only when every package in its `dependsOn` is `merged`. `orch_spawn({ ids })` also refuses when it would put more than `maxSubs` sub-sessions in spawned, planning, executing or awaiting-acceptance.
- **Spawn:** W1 with the set name. The tool then records `cwd`, `branch` and `base` (`git -C cwd rev-parse HEAD`), and sets the state to `spawned`.
- **Sub-session start:**
  - Only interactive sessions (`ctx.hasUI`) take part.
  - At `session_start` the sub-session compares its `git rev-parse --show-toplevel` (case-insensitive on Windows, forward slashes) with the `cwd` of each sub in each active `run.json`.
  - When it matches and there is no `status.json` yet, it waits for the first K4 event plus 500 ms, then emits K9 with `allowTools: ["ask_orchestrator"]` and the kickoff text: the brief plus these rules:
    - stay inside `owns`;
    - never touch `forbids`;
    - ask with `ask_orchestrator`;
    - deliver with one PR merged at the end.
  - If K9 has no answer after 10 s, it notifies with an error.
  - When the sub-session is reopened, it doesn't start the flow again.
- **Status:** the sub-session writes `status.json` on every K4 event and every 60 s (heartbeat). When K4 goes from execute to anything else, it appends `flow-ended`.
- **K10 in a sub-session:** it writes `plan-<n>.md`, appends `plan-review`, and claims with a promise. A later `plan-verdict` from the inbox resolves that promise to approve or reject (with the reasons).
- **K11 in a sub-session:** the tree is `payload.tree`, or `git -C cwd rev-parse HEAD^{tree}` when it is null.
  - If `accepted.json` contains it, the answer is `null`.
  - Otherwise the sub-session appends `accept-request`, once per tree, and answers with a problem: "The orchestrator has not accepted tree `<t>` yet. An acceptance request was sent; end your turn. You get a message when it answers; then retry the merge."
  - A session that isn't a sub-session doesn't claim.
- **Inbox delivery in a sub-session:** it polls every 3 s.
  - An `answer` that matches a pending `ask_orchestrator` is consumed by that tool.
  - A `plan-verdict` resolves the K10 claim and also notifies.
  - `directive` uses `deliverAs: "steer"` when urgent, `"followUp"` otherwise. `info` and `accept-verdict` use `"followUp"`. All are sent with `triggerTurn: true` and `customType: "orchestrate-message"`.
- **`ask_orchestrator({ question })`:** appends a `question`, then waits for a matching answer, polling every 3 s and respecting the abort signal.
  - It times out after `askTimeoutMinutes`. Then it returns: "No answer in N min. Call wait_for_user with this question; the user answers."
  - In a session that isn't a sub-session, it refuses.
- **Orchestrator watcher:** it runs while this session owns an active run. The owner is set by `orch_run` or `/orch watch`, which takes over when the recorded owner's pid is dead or it's on another host.
  - Every 5 s it reads new outbox lines.
  - Every `pollSeconds` it reads each running sub-session's `status.json` and git state:
    - `git -C cwd rev-parse HEAD`;
    - `git -C cwd diff --name-only <base>...HEAD`;
    - `git -C cwd status --porcelain`.
  - It passes these snapshots to `monitor.ts`. The events are:
    - `question`, `plan-review`, `accept-request`, `flow-ended`;
    - `drift`: a changed file outside `owns` or inside `forbids`, reported once per new file;
    - `overlap`: two sub-sessions changed the same file;
    - `offline`: the heartbeat is older than 180 s;
    - `stalled`: execute phase, not waiting, and no change in HEAD, porcelain hash or `done` for `stallMinutes`.
  - On `flow-ended` it checks `gh pr list --head <branch> --state merged --json number` in the main repo, and sets `merged` or reports "ended without merge". When a package becomes merged, it reports which packages are now ready to spawn and which running sub-session worktrees should rebase.
  - Events from one tick are batched into one `pi.sendMessage({ customType: "orchestrate-events", content }, { deliverAs: "followUp", triggerTurn: true })`. The content includes file paths, such as the brief and the plan, for the model to read.
  - Plain checks cost no model tokens. The watcher only wakes the model when there are events.
  - It also updates `run.json` states:
    - `planning`: the sub-session's phase is plan;
    - `executing`: its phase is execute;
    - `awaiting-acceptance`: an `accept-request` arrived;
    - `merged`: the merge was confirmed.
- **`orch_review_plan({ id, approve, summary, reasons? })`:**
  - If `approve` and `confirmPlans` is on, it asks you with `ctx.ui.select("Approve plan of <id>? <summary>", ["Approve", "Reject"])`. If you reject, it asks for the reason with `ctx.ui.input`.
  - It appends a `plan-verdict`.
- **`orch_accept({ id, accept, reasons? })`:** works on the tree of the latest `accept-request`. It refuses if `git -C cwd rev-parse HEAD^{tree}` differs from that tree ("the sub-session changed since its request").
  - When accepting, it adds the tree to `accepted.json`.
  - It always appends an `accept-verdict`.
- **`orch_send`** appends an `answer`, `directive` or `info`. **`orch_status`** returns a compact table. **`/orch end`** marks the run `ended` and stops the watcher.
- **Config** `~/.pi/agent/orchestrate.json` (optional; defaults apply):
  `{ "maxSubs": 4, "pollSeconds": 60, "stallMinutes": 20, "askTimeoutMinutes": 15, "confirmPlans": true }`
  Model it on `agents/config.ts`. A bad value falls back to the default with a warning.

**Failures:**
- W1 or K9 not answering: a clear error, nothing half-written. In `run.json` the sub stays `planned` until W1 succeeds.
- Corrupt JSON in a file: skip it and report it once.
- A crashed sub-session: `offline` is reported, and you reopen it with `/wt open <name>`.
- An orchestrator restart: `/orch watch` resumes from the cursors.

**Scale:** 2–4 sub-sessions. Each 5 s tick stats about 4 files, and each 60 s tick runs 3 git commands per sub-session, which is trivial. Beyond about 8 sub-sessions, or long runs, the orchestrator's context fills up with event messages; that's the limit of this design. File appends assume one writer per file on a local disk.

**Rejected:**
- **Headless subagents:** they run without extensions, menus or `wait_for_user`.
- **Passing a prompt through `piArgs`:** looking the sub-session up in `run.json` also works after a reopen and needs no change to the CLI.
- **`fs.watch`:** unreliable on Windows, while polling is simple.
- **Sub-sessions messaging each other directly:** decided against (D6).
- **Orchestrate importing workflow internals:** rejected by D8.

### Steps

### Stage 1: workflow and worktree hooks

**S1.** Create `shared/claims.ts`: `gatherClaims(emit: (data: unknown) => void, data: object, timeoutMs: number): Promise<unknown>`.
- It adds `claim` to the payload and collects claims only during the synchronous emit; later claims are ignored.
- It returns the first non-null resolved answer, or null when there are none or all are null. A rejection or timeout returns `{ error: "..." }`.
- Model it on `workflow/folder-add.ts:10-60`. Leave K6 unchanged.

**S2.** In workflow `emitStatus` (`index.ts:457-472`), add `done`, `total` and `waiting`, taken from the same counts as `view.progress` (`index.ts:440-446`). Add them only during execute with an approved plan. The "emit only when changed" rule stays.

**S3.** Add workflow K9: register a `pi.events.on("workflow:start-plan")` listener once in the extension factory, using `lastCtx`.
- It validates `v === 1` and that `brief` and `title` are strings.
- It refuses (`{ error }`) when the phase is execute or plan, when a plan is approved, or when `lastCtx` is unset.
- Otherwise it stores `state.extraPlanTools = allowTools` (persisted), runs `setPhase(lastCtx, "plan")`, then `pi.sendUserMessage(preface + brief)` and answers `{ ok: true }`.
- Change the call sites of `phaseToolRefusal`/`planToolRefused` so the allowed set also includes `state.extraPlanTools` as exact names. Clear the field when the flow ends (`phaseAfterFlow` path) and in `startExecution`'s reset? No: keep it for execute and clear it only at the end of the flow.
- Put the payload validation and the preface text in a new pure module `workflow/hooks.ts` (`parseStartPlan`, `START_PLAN_PREFACE`).

**S4.** Add workflow K10 in the agent_end plan branch (`index.ts:3145-3156`), after `blocked` is computed and before the `cfg.planPrompt` check.
- When `planReady && !blocked`, emit through `gatherClaims` with no timeout. Add `timeoutMs: 0` meaning none, and document it in S1.
- Keep the sequence synchronous: first collect whether anyone claimed (the emit returns that synchronously; expose `claimed: boolean` from a variant `emitClaims(emit, data)` → `{ claimed, answer: Promise }` in `shared/claims.ts`).
- When claimed, notify and return without the menu. When the answer settles:
  - approve: if `state.phase === "plan"`, `planReady` holds and `composePlan(planDraft)` still equals the emitted plan, then `approve(lastCtx)`;
  - reject: `sendMessage` with `customType "workflow-plan-review"` and `triggerTurn: true`;
  - null or error: notify and leave it to typed "go" or the menu on the next reply.
- Put `planReviewAction(answer, stillCurrent): "approve"|"reject"|"ignore"` in `hooks.ts`.

**S5.** Add workflow K11:
- After the judge gate passes in the tool_call gate closure (`index.ts:2779-2788`, before it records and returns null), call `acceptanceProblem(kind, dir, res.tree ?? null)`. That function emits `workflow:merge-gate` through `gatherClaims` (30 s) and maps:
  - `{ problem }` to the problem;
  - an error or timeout to "the acceptance check did not answer";
  - null to allowed.
- Apply the same at every publish gate site (find them with grep).
- For `git_task` (`index.ts:2244-2251`), call it with `tree: null` and set `spec.acceptance` when there is a problem.
- In `git-guard.ts`, parse `acceptance?: string` (validated like `midFlow` at 43) and return it as the refusal for merge, protected-push and publish, unless the spec is `ungated`.
- The mapping goes in `hooks.ts`.

**S6.** Workflow docs and boundary test:
- In `workflow/README.md`, update K4 and add K9, K10 and K11 under the contracts (exact payloads as in the Design).
- In `workflow/boundary.test.ts`, also refuse imports from `../orchestrate` and the text `pi/orchestra`.

**S7.** Add worktree W1:
- Extract the body of `newSet` (`index.ts:248-257`) into a helper that returns `{ name, branch, cwd, setRoot, launched, text } | { error }`. `newSet` keeps its notify behaviour.
- Widen the context type of `createSet`, `collect` and `addedFolders` to the fields they use.
- In `session_start` (beside 835), register `pi.events.on("worktree:create")`, unsubscribing on the next start like `unsubFolderAdd`. It validates `v === 1` and that `name` is a string, then claims the helper's promise. A name is required, so there is no prompt.
- Add a "Contracts" section with W1 to `worktree/README.md`.

**S8.** Backlog, in the same commit as S2–S6 (required by AGENTS.md):
- Add row **A41**: an orchestrator with plan-phase sub-sessions in worktrees, marked **Partly done:** with the hooks K4+, K9–K11 and W1 and their files.
- Add an effect-measurement row for A41: wall time of a multi-package job compared with one flow, and orchestrator interventions per run.
- Add row **A42** as an idea: copy Unity `Library/` into new worktrees to skip the first import.
- Leave the Status line's implemented list unchanged; A41 and A42 fall under "the rest are ideas only" until Stage 3.

### Stage 2: orchestrate core (pure modules)

**S9.** Add `orchestrate/config.ts`: `loadConfig()` reads `<agentDir>/orchestrate.json` with the defaults above and validates integers ≥ 1 and the boolean, returning `{ config, warning? }`. Model it on `agents/config.ts`.

**S10.** Add `orchestrate/paths.ts`: `globToRegExp(glob)` (supports `**`, `*`, `?`, forward slashes, case-insensitive) and `outsideOwned(files, owns, forbids) → string[]`.

**S11.** Add `orchestrate/brief.ts`:
- `validatePackages(pkgs, maxSubs)` returns the errors as a list of strings, using the rules in the Design.
- `readyToSpawn(run)` returns the ids whose dependencies are merged and that are still `planned`.
- `makeRunId(title, now)`, `setName(runId, subId)` (checked against the `checkName` rule, copied as a regex with a comment pointing to `worktree/layout.ts:7`), `renderBrief(sub, run)` (markdown: goal, acceptance criteria, owned paths, forbidden paths, decisions, other packages and what they own), and `kickoffText(sub, run, briefPath)`.

**S12.** Add `orchestrate/store.ts`:
- `commonDir(cwd)`, using `execFile git rev-parse --git-common-dir` through the `pi.exec` that the caller passes in.
- `runDir(common, id)`, `listActiveRuns(common)`, `readRun`/`writeRun` (atomic: tmp + rename), `appendMessage(file, msg)` (adds a sequential id and ts, one `appendFileSync` of `JSON.stringify + "\n"`).
- `readNew(file, cursor) → { msgs, cursor }` (ignores an unterminated last line), `readStatus`/`writeStatus`, `readAccepted`/`addAccepted`, `findSubByToplevel(runs, toplevel)`.
- Paths are normalised to forward slashes, and compared lowercase on Windows.

**S13.** Add `orchestrate/monitor.ts`:
- `check(prev: Snapshot | undefined, cur: Snapshot, ctx: { now, owns, forbids, otherFiles: Map<sub, string[]>, cfg }) → { events, next }`.
- A `Snapshot` is `{ head, porcelainHash, done, files, heartbeat, phase, waiting, changedAt, reported: { drift: string[], offline: boolean, stalled: boolean } }`.
- It produces `drift`, `overlap`, `offline` and `stalled` without repeating an event until its condition clears and comes back.

### Stage 3: orchestrate wiring, docs, apply

**S14.** Add `orchestrate/index.ts` with the orchestrator side:
- **The tools** `orch_run`, `orch_spawn`, `orch_status`, `orch_send`, `orch_review_plan` and `orch_accept`, with the parameters in the Design. Use TypeBox schemas modelled on `agents/index.ts:145-226`.
- **W1 through `emitClaims`** from `shared/claims.ts` (120 s timeout, because creating a set fetches). If there is no claim, the error is "worktree extension not loaded".
- **The `/orch` command** with `status`, `watch` and `end`.
- **The watcher**, with the 5 s and `pollSeconds` timers. Start it on `orch_run` or `/orch watch`, and at `session_start` when an active run's `owner.session` equals this session file. Stop it on `/orch end` and `session_shutdown`.
- **The `gh` merged check.**
- **Event batching** through `sendMessage`.
- Tool replies are short.

**S15.** In `orchestrate/index.ts`, the sub-session side:
- recognition at `session_start` (`ctx.hasUI` only);
- the start through K9, after a K4 event and the 10 s fail-safe;
- the `status.json` heartbeat every 60 s and on every K4 event, plus `flow-ended`;
- the 3 s inbox poll with the delivery rules;
- the `ask_orchestrator` tool;
- the K10 listener (plan file, `plan-review`, pending claim resolved by `plan-verdict`);
- the K11 listener (accepted tree check, `accept-request` once per tree, the problem text).

**S16.** Add `orchestrate/boundary.test.ts`. It checks that no file imports `../workflow` or `../worktree`; importing `../shared` is allowed. Model it on `workflow/boundary.test.ts`.

**S17.** Add `orchestrate/README.md`:
- usage (start pi with the workflow off, discuss, the agent calls `orch_run` and `orch_spawn`), the file layout, the message types and the config;
- the contracts it uses (K4, K9–K11, W1);
- the Unity note: each worktree is its own project, its first import is slow, and A42 tracks that;
- the test command.

**S18.** In `docs/workflow-improvements.md`:
- mark A41 **Done:** with the orchestrate files;
- add A41 to the Status line's implemented list;
- set the A41 effect row to "Implemented, not measured yet".

**S19.** Apply to this machine: run `node bin/import.js` from the repo root and check that its output lists the new `extensions/orchestrate` files and `extensions/shared/claims.ts` as applied.

**S20.** Verify: in a scratch GitHub repo:
1. Start `pi` (the workflow is off) and ask for two packages: `a` (create `src/a.txt`) and `b` (depends on `a`, creates `src/b.txt`).
2. Let the agent run `orch_run` and `orch_spawn a`.

Look for:
- a terminal opens in the `wt` worktree, and the sub-session starts at the plan phase from the brief;
- its plan reaches the orchestrator, and you get the confirm prompt;
- `ask_orchestrator` round-trips;
- an edit outside `owns` produces a `drift` event;
- the merge is refused until `orch_accept`, then the PR merges;
- `flow-ended` arrives and `merged` is set;
- `b` becomes spawnable only after that.

### Tests
Commands:
- workflow: `cd pi/agent/extensions/workflow && node --experimental-strip-types --test hooks.test.ts git-guard.test.ts boundary.test.ts`, then the full list from `README.md:227` plus `hooks.test.ts`. Expected: all pass.
- shared: `cd pi/agent/extensions/shared && node --experimental-strip-types --test claims.test.ts`
- worktree: the list from `worktree/README.md:178` plus `node --test vscode/request.test.js`. Expected: all pass.
- orchestrate: `cd pi/agent/extensions/orchestrate && node --experimental-strip-types --test config.test.ts paths.test.ts brief.test.ts store.test.ts monitor.test.ts boundary.test.ts`

New or changed tests:
- `shared/claims.test.ts`:
  - no listener gives null;
  - the first non-null answer wins over null;
  - a rejection gives `{ error }`;
  - a timeout gives `{ error }`;
  - `timeoutMs: 0` waits;
  - a late claim is ignored;
  - `emitClaims` reports `claimed` synchronously.
- `workflow/hooks.test.ts`:
  - `parseStartPlan` rejects a wrong `v`, a missing brief, and an `allowTools` that isn't a list of strings;
  - `planReviewAction`: approve with the plan still current gives "approve", approve with a stale plan gives "ignore", reject gives "reject", null gives "ignore";
  - the acceptance mapping: `{ problem }` gives the text, an error gives "did not answer", null gives null.
- `workflow/git-guard.test.ts`:
  - a spec with `acceptance` refuses `gh pr merge`, and `ungated` overrides it;
  - a bad `acceptance` type makes the spec invalid.
- `workflow/boundary.test.ts`: the new bans.
- `worktree/index.test.ts`, or a new `create-event.test.ts` if the helper is testable: name validation rejects a bad name with the `checkName` message. The full git and launch path is covered by S20.
- `orchestrate/paths.test.ts`:
  - `src/**` matches `src/a/b.ts`;
  - `*.md` doesn't match `docs/x.md`;
  - forbids win over owns;
  - matching is case-insensitive.
- `orchestrate/brief.test.ts`:
  - duplicate ids, an unknown dependency, a cycle, empty `owns` and the same glob owned twice are each reported;
  - `readyToSpawn` follows the dependencies;
  - `setName` is ≤ 40 characters and matches the name rule;
  - `renderBrief` contains every criterion and the owned and forbidden paths;
  - `kickoffText` contains the brief path and `ask_orchestrator`.
- `orchestrate/store.test.ts` (temp dir):
  - `appendMessage` and `readNew` with cursors;
  - an unterminated last line is skipped, then read after it's completed;
  - the atomic write of `run.json` round-trips;
  - `findSubByToplevel` matches a path differing only in case and slashes;
  - `addAccepted` doesn't add duplicates.
- `orchestrate/monitor.test.ts`:
  - drift is reported once and again only for new files;
  - overlap between two sub-sessions;
  - offline at more than 180 s;
  - stalled after `stallMinutes` without a change, and not while waiting or outside execute;
  - a change resets the stall.
- `orchestrate/config.test.ts`: the defaults, and a bad value falls back with a warning.
- `orchestrate/boundary.test.ts`.

### Done when
- All the test commands above pass.
- The workflow and worktree hooks are documented as contracts (K4+, K9–K11, W1). With no orchestrate listener, the workflow and worktree behave exactly as before: menus, gates and `/wt new` are unchanged, and the existing tests pass.
- A sub-session in a run's worktree starts at the plan phase from its brief. Its plan goes to the orchestrator, with your confirmation when `confirmPlans` is on.
- A sub-session can't merge until both the judge PASS and the orchestrator's acceptance cover the same tree.
- The orchestrator reports drift, overlap, offline, stalled, questions, plan reviews, acceptance requests and flow ends without polling with the model.
- `docs/workflow-improvements.md` has A41 (Done) and A42 (idea) with their effect rows and an updated Status line.
- S19 applied the files to `~/.pi/agent`.
- S20 is listed for you.

### Risks, rollback, what not to touch
- **The menu (K10):** a bug there could leave a normal flow without its plan menu. The emit only happens when a listener exists, so without orchestrate nothing claims and the existing path runs. A test covers null → menu.
- **The merge gate (K11):** a bug could block merges. With no listener the answer is null, which allows the merge. Only orchestrate sub-sessions claim.
- **Timing at sub-session start:** the order in which extensions start up isn't fixed, so the start waits for a K4 event and has a 10 s fail-safe.
- **Rollback:** delete `extensions/orchestrate`; the hooks stay inert.
- **Don't touch:** the K6 code (`folder-add.ts`), the merge-gate judge logic in `merge-gate.ts`, `plan-store.ts` claims, or the subagent runner.

### Commits
- Stage 1:
  - `workflow, worktree: hooks K9–K11, K4 step counts and worktree:create for orchestration`: `shared/claims.ts`, `shared/claims.test.ts`, `workflow/index.ts`, `workflow/hooks.ts`, `workflow/hooks.test.ts`, `workflow/git-guard.ts`, `workflow/git-guard.test.ts`, `workflow/boundary.test.ts`, `workflow/README.md`, `worktree/index.ts`, `worktree/README.md`, the worktree test, `docs/workflow-improvements.md`
- Stage 2:
  - `orchestrate: run store, briefs, path rules and monitor`: `orchestrate/config.ts`, `paths.ts`, `brief.ts`, `store.ts`, `monitor.ts` and their tests
- Stage 3:
  - `orchestrate: orchestrator and sub-session wiring`: `orchestrate/index.ts`, `boundary.test.ts`, `README.md`, `docs/workflow-improvements.md`

<!-- pi-workflow:status -->
## Checklist
- [x] S1 Create `shared/claims.ts`: `gatherClaims(emit: (data: unknown) => void, data: object, timeoutMs: number): Promise<unknow
- [x] S2 In workflow `emitStatus` (`index.ts:457-472`), add `done`, `total` and `waiting`, taken from the same counts as `view.pr
- [x] S3 Add workflow K9: register a `pi.events.on("workflow:start-plan")` listener once in the extension factory, using `lastCtx
- [x] S4 Add workflow K10 in the agent_end plan branch (`index.ts:3145-3156`), after `blocked` is computed and before the `cfg.pl
- [x] S5 Add workflow K11:
- [x] S6 Workflow docs and boundary test:
- [x] S7 Add worktree W1:
- [x] S8 Backlog, in the same commit as S2–S6 (required by AGENTS.md):
- [x] S9 Add `orchestrate/config.ts`: `loadConfig()` reads `<agentDir>/orchestrate.json` with the defaults above and validates in
- [x] S10 Add `orchestrate/paths.ts`: `globToRegExp(glob)` (supports ``, `*`, `?`, forward slashes, case-insensitive) and `outside
- [x] S11 Add `orchestrate/brief.ts`:
- [x] S12 Add `orchestrate/store.ts`:
- [x] S13 Add `orchestrate/monitor.ts`:
- [ ] S14 Add `orchestrate/index.ts` with the orchestrator side:
- [ ] S15 In `orchestrate/index.ts`, the sub-session side:
- [ ] S16 Add `orchestrate/boundary.test.ts`. It checks that no file imports `../workflow` or `../worktree`; importing `../shared`
- [ ] S17 Add `orchestrate/README.md`:
- [ ] S18 In `docs/workflow-improvements.md`:
- [ ] S19 Apply to this machine: run `node bin/import.js` from the repo root and check that its output lists the new `extensions/o
## For you after the flow
- S20 Verify: in a scratch GitHub repo:
