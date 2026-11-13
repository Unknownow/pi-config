<!-- pi-workflow plan v1 flow=20261113-1316-orchestrated-runs-with-no-interaction-in-f360 -->
## Plan: Orchestrated runs with no interaction in sub-session windows

**Goal.** The orchestrator answers everything a sub-session asks or waits on: questions, plan approval, workflow menus and waits. You never type into a sub-session window and never click a trust prompt for a spawned worktree. Whatever the orchestrator can't or may not decide is escalated to you in the orchestrator session, along with the waits (which always need a person).

**Non-goals.**
- Prompts that only open from a command you type: `/flow resume`, `/flow model`, `/agents model`, `/wt …`.
- The cross-run overlap menu in `orch_run`, which shows in your own session.
- Reopening a crashed sub (backlog A49, idea only).
- Worktrees without `.pi` or `.agents/skills`, which never prompt for trust.
- Hostile sub-session agents. The file protocol stays trust-based.

**Stages:**
1. Workflow contracts: K12 `workflow:ask`, `ask-done`, K13 `workflow:idle`, the sub-friendly notices, the UI guard test, and `notifyCommand` moved to `shared/`.
2. Orchestrate foundations: the `spawning` state, `originTrusted`, the trust handler, the session identity with held claims, `confirmPlans: false`, and `ask_orchestrator` without a timeout.
3. Orchestrate decisions: `items.json`, K12/K13 handling, `orch_decide`, `orch_escalate`, caps, reminders and escalation, `idle`, the view, prompts and docs.

Each stage leaves the code working. After stage 1 alone nothing claims K12 or K13, so the menus show locally exactly as they do today.

### User decisions
- **D1.** The orchestrator reviews plans itself. `confirmPlans` defaults to `false`, and plans are rejected with concrete fixes.
- **D2.** Spawned worktrees are trusted automatically (`project_trust`, `remember: false`). This is only for runs whose origin was trusted; temporary and CLI trust count. A `/resume` into a sub worktree is trusted too.
- **D3.** You never use the sub-session windows. Every question, menu, wait and plain-text stop goes to the orchestrator. What it can't resolve is reported to you in the orchestrator session.
- **D4.** `ask_orchestrator` has no timeout and never falls back to `wait_for_user`.
- **D5.** Waits (K12 `kind: "wait"`) are escalated to you at once. Only a message you typed (`userQuote`) resumes one; a passing `check` still resumes it by itself.
- **D6.** In `plan-menu`, `orch_decide` refuses Approve, "Approve, arbiter solves plan flaws →", "Back to discussion" and "Full flow instead". Every Stop option needs your `userQuote`. "Wait" in `stage-empty` and `steps-open` needs `text`.
- **D7.** Caps:

  | Cap | Value and scope | Rule |
  |---|---|---|
  | `maxPlanRejections` | 3 | Consecutive rejections in one planning round. Only the review right after the cap is escalated. |
  | `maxReplans` | 2 per sub per run | Counts the orchestrator's "Back to planning" answers. It never resets, and every later one needs your quote. |
  | `maxAutoAnswers` | 2 per sub per `key` | The 3rd ask is escalated. **Loop keys** (`judge-cap`, `plan-flaw`, `accept`, `merge-early`) reset only when the stage changes; with no stages they count per run. **Other keys** count consecutive asks, and progress resets them. `plan-menu` also resets when a plan reaches K10 review. |
  | `maxIdleAnswers` | 3 per sub | Counts `idle` items without progress. |

  When you answer an escalated item, the count of that cap goes back to 0, except `maxReplans`.
- **D8.** Reminders go to the orchestrator at 60 s, 5 min and 10 min of orchestrator idle time. An item is escalated at 15 min of idle time or 30 min after it was posted, whichever comes first.
- **D9.** Escalation sends a desktop notification, puts a widget and board marker, and sends a follow-up to the orchestrator. An answer to an escalated item needs a `userQuote`: an exact piece of a message you typed after the escalation. It is saved as `byUser: true`; this is best effort. A capped choice that is refused because the quote is missing escalates the item automatically.
- **D10.** If the orchestrator session is closed, a sub sends one desktop notification ("orchestrator not running…") per item older than 30 min. It does this only when the run owner is on the same host and its pid is dead.
- **D11.** Acceptance A1–A6 are the tests (see Tests).
- **D12.** Docs change in the same commit: `workflow/README.md`, `orchestrate/README.md`, `docs/workflow-improvements.md` (A48, A49), `prompts.ts`, `brief.ts:202`.
- **D13.** The minor findings of the last review, settled:
  - a refused capped choice auto-escalates (D9);
  - the counter resets after your answer (D7);
  - `plan-menu` resets on K10 review (D7);
  - at `session_start` a saved menu ask is cleared, `ask-done {how:"withdrawn"}` is sent, and it is never sent again;
  - an unstaged plan makes the loop keys per-run caps (documented).

Merge points: none (merged at the end of the flow).

### Facts the executor needs

**Workflow (`pi/agent/extensions/workflow/index.ts`):**
- `askUser` (`:310-313`) calls `notifyUser` and then `ctx.ui.select`. Its callers:

  | Line | Menu |
  |---|---|
  | `:2529` | merge-early |
  | `:3199` | plan menu |
  | `:3221` | executor error |
  | `:3305` | stage-empty |
  | `:3317` | steps-open |
  | `:3467` | judge error |
  | `:3502` | judge cap |
  | `:3544` | plan flaw |

- Direct UI calls:
  - `:1680` and `:1735` are in `resumeFlow`, which is called only from `/flow resume` (`:4216`);
  - `:3006` is the wait input handler (`ui.select`);
  - `:3450` is `ui.confirm` "Run the judge?";
  - `:4226` is `/flow board` (`ui.custom`);
  - `:4329` is `/flow model`.
- The plan path is `:3155-3199`:
  - `:3166` and `:3196` are block notices;
  - `:3171` emits K10 with `emitClaims(..., 0)`;
  - `:3174` is "plan sent for review; type go to approve it yourself.";
  - `:3184` is "no verdict on the plan …; say go to approve it.";
  - `:3190` is the `planPrompt`-off notice;
  - `arbiterLabel` is defined at `:3196`;
  - "Back to discussion" calls `setPhase(..., "discuss")` (`:3205`).
- **Waits** are set at `:2122` (`wait_for_user`, `manual` param at `:2075`), `:2213` (held `publish_packages`), `:2694` (plan wait step) and `:3266` (stage-after wait). They resume only on text you type: `input` at `:2988` ignores `source: "extension"`.
- `FlowState` is at `:110`, `waiting` at `:175`, and `persist()` at `:353`.
- `scheduleIdleNotice` is at `:315-327` and is called from `agent_end` when `inAgentEnd === 0` (`:3119`). `idleTimer` is cleared at `:2973` and `:3999`.
- `handover(customType, content, ctx)` (`:3093`) defers a message until the run settles.
- `planReviewRoute` and `planReviewAction` are in `workflow/hooks.ts:23,58`.
- `notifyCommand` is in `workflow/notify.ts:9`.
- The tests command is `workflow/README.md:229`, and the K-contracts are at `workflow/README.md:243-252`.

**Orchestrate (`pi/agent/extensions/orchestrate/index.ts`):**

| Line | What |
|---|---|
| `:33` | `ACTIVE` |
| `:34` | `sameDir` |
| `:76-77` | `me` and `started` |
| `:160-180` | K10 claim, gated by `if (!me \|\| !started)` |
| `:181-215` | K11 claim; posts `accept-request` at `:209` |
| `:217-245` | `deliverInbox` |
| `:272-300` | `ask_orchestrator`, with the timeout at `:281`/`:291` and the `wait_for_user` text at `:299` |
| `:312` | `startSubSession` |
| `:376` | `input` handler in the orchestrator |
| `:551` | `readOutboxes` (every 5 s, `:763`) |
| `:564-570` | turns events into messages for the model |
| `:686` | `pollGit` (`pollSeconds`), with snapshot fields at `:715-728` (head, porcelainHash, phase, done, stalled) |
| `:802-835` | `confirmOverlaps` |
| `:837-880` | `orch_run`; writes `run.json` at `:879` |
| `:886-958` | `orch_spawn`: W1 at `:921`, `mutate` to `spawned` at `:941-947`, `catch` at `:950-956` |
| `:995-1019` | `orch_review_plan`, with the `confirmPlans` menu at `:1010-1014` |
| `:1026` | `orch_accept` |
| `:1096` | `/orch end` sets `ended` |
| `:1104-1110` | `/orch watch` owner liveness check (`host === os.hostname() && pidAlive`) |
| `:1199-1270` | `session_start`: early return without UI at `:1219`, `become()` at `:1227`, 15 s retry at `:1258-1270` |

- **Other orchestrate files:**
  - `config.ts:25` holds `DEFAULTS`; `config.ts:27` holds `INT_KEYS`.
  - `brief.ts`: `SubState` at `:5`, `Run` with `owner` at `:34`, `ACTIVE` at `:47`, `readyToSpawn` at `:116-119`, and the `wait_for_user` fallback line at `:202`.
  - `store.ts:34` has `norm`; `listActiveRuns` and `findSubByToplevel` are at `:177-182`; `status.json` already carries `stage`, `stages`, `done` and `phase` (`store.ts:25`).
  - `view.ts:117` and `:169` hold the inline active-state lists.
  - `boundary.test.ts` forbids imports from `../workflow` and `../worktree`.
- **Shared and pi:**
  - `shared/claims.ts` has `emitClaims` and `gatherClaims`.
  - The `project_trust` contract is in pi's `docs/extensions.md:429-444`: return `{ trusted: "yes"|"no"|"undecided", remember? }`; the first yes/no wins; the context is limited (`cwd`, `hasUI`, UI helpers; no `exec`).
  - `ctx.isProjectTrusted()` is at `extensions.md:1197`.
- **Docs:** the last backlog ID in section A is A47. `docs/workflow-improvements.md` has the Status line at `:5` and the Effect measurement section at `:153`.
- **Test commands:**
  - workflow: `workflow/README.md:229`;
  - shared: `shared/README.md:17`;
  - orchestrate: `orchestrate/README.md`, "Tests".

### Design

**Contracts (workflow → any listener), all claims through `shared/claims.ts` with no workflow-side timeout (like K10):**

**K12 `workflow:ask`**, payload:
```
{ v: 1, id: "<flowId>:<seq>", key, kind: "menu"|"wait", title, options?: string[],
  roles?: Record<string, "approve"|"discuss"|"stop"|"replan"|"wait"|"other">,
  detail?: string, wait?: { reason, check?, manual: boolean }, claim }
```
- **`roles`** tags each option's meaning, so orchestrate never matches label text.
- **Claim answers:**
  - `{ choice, text? }`;
  - `{ resume: true, text? }` (waits only);
  - `null`, meaning show it locally as today.
- An unclaimed ask behaves exactly as today. A claimed ask shows nothing locally: no `notifyUser`, and no notice that asks for input.
- A choice that isn't in `options` re-emits the same id.
- `text` is delivered after the choice has been applied, through `handover` as customType `workflow-orchestrator`. It is dropped if the choice ended the flow.

**`workflow:ask-done`** `{ v: 1, id, how: "answered"|"withdrawn" }` is emitted when:
- a claimed ask resolves (`answered`);
- a wait ends locally, for example its check passed or someone typed (`answered`);
- a saved menu ask is cleared at `session_start` (`withdrawn`).

**K13 `workflow:idle`** `{ v: 1, flowId, phase, lastText, claim }` answers `{ handled: true }` or `null`; `null` gives the local idle notification as today.

**Keys** (fixed):

| Key | Call site |
|---|---|
| `executor-error` | `:3221` |
| `judge-error` | `:3467` |
| `judge-cap` | `:3502` |
| `plan-flaw` | `:3544` |
| `merge-early` | `:2529` |
| `steps-open` | `:3317` |
| `stage-empty` | `:3305` |
| `run-judge` | `:3450` |
| `plan-menu` | `:3199` |

Waits use the key `wait`.

**Sub ↔ orchestrator messages** (append-only jsonl as today):

| Direction | Type | Data |
|---|---|---|
| outbox | `ask` | the K12 payload minus `claim`, plus `stage` |
| outbox | `ask-done` | `{id, how}` |
| outbox | `idle` | `{lastText}` |
| outbox | `idle-end` | — |
| outbox | `session-started` | `{instance}` (a random id per process) |
| inbox | `decision` | `{askId, choice?, resume?, text?}` |

**`items.json`** lives in the run directory. The orchestrator process is the only writer (tmp + rename), and a missing file means empty.
- **Per item:** `ref`, `sub`, `kind` (question|menu|wait|idle|plan-review|accept-request), `key`, `stage`, `postedAt`, `state` (open|answered|escalated|stale), `reminders`, `lastReminderAt`, `idleMs`, `escalatedAt`, `escalation` (the question shown to you), `userMsgs` (`{at, text}` of messages you typed after the escalation), `byUser`, `instance`.
- **Per sub:** `planRejections`, `replans`, `autoAnswers` (map key → `{count, stage}`), `idleNoProgress`, `fingerprint` (phase|stage|done|head|porcelainHash).

The pure logic lives in a new `orchestrate/items.ts` and `orchestrate/decide.ts`, so the timing and caps can be tested with an injected clock.

**Identity (orchestrate, per process):** `unknown` → `sub` | `not-sub`.
- While it is `unknown`, the K10, K11, K12 and K13 listeners claim and hold the event.
- **`sub`:** held events are handled.
- **`not-sub`:** held claims resolve to `null`.
- It becomes `not-sub` when:
  - the session has no UI or no git common dir;
  - there is no active run;
  - this session is the run owner or in orchestrator mode;
  - the 15 s retry ends with no match.
- K11's 30 s workflow timeout is longer than the worst hold (about 15 s plus one git call).

**Failure handling:**
- Unreadable `items.json` → reported once as a warning; start empty but don't overwrite it until the next successful write.
- A desktop notify that fails is ignored.
- A `decision` for an unknown or stale `askId` in the sub → warning in the sub log, ignored.
- An `orch_*` answer on a stale, answered or unknown item → refused with the reason.

**Scale:** 2–4 subs (`maxSubs`), a few items each, so `items.json` stays a few KB and is rewritten on every change. The poll every 5 s is enough for a minute-level reminder schedule. This stops working well at about 50+ open items, when the follow-up messages would flood the orchestrator; that is not expected at `maxSubs ≤ 4`.

**Rejected:**
- Passing `--approve` through W1, or writing `trust.json`: these change contracts or make trust permanent.
- A local menu fallback after a timeout: it breaks D3.
- Matching option labels: fragile; `roles` is used instead.

### Stage 1: Workflow contracts

**S1.** **Move `notifyCommand`** to `pi/agent/extensions/shared/notify.ts`, with its tests in `shared/notify.test.ts` (taken from `workflow/notify.test.ts`).
- `workflow/notify.ts:9` re-imports it from `../shared/notify.ts`; `idleReason` and `notifyDue` stay in workflow.
- Add the new test to the `shared/README.md:17` command.
- Model: the existing `shared/claims.ts` move.

**S2.** **New `workflow/asks.ts`**, pure, with:
- the key table (key → call site description);
- `nextAskId(flowId, seq)`;
- `isValidChoice(options, answer)`;
- `askAnswer(answer, options, kind)`, which classifies a claim answer into `choice | resume | invalid | local`.
- Model: `workflow/hooks.ts:23` `planReviewAction`.

**S3.** **`askUser` becomes `askUser(ctx, key, title, options, opts?: { detail?, roles? })`** (`index.ts:310`). It still returns the chosen label or `undefined`.
1. Bump `state.askSeq`.
2. Save `state.openAsk = { id, key, kind: "menu", title, options, detail }`, then `persist()`.
3. Emit K12 with `emitClaims(…, 0)`.
4. **When claimed:** await the answer. An invalid choice re-emits the same id. A `text` is queued through `handover("workflow-orchestrator", text, ctx)` after the function returns (a microtask after return is fine because `handover` defers while `inAgentEnd`). Emit `ask-done answered` and clear `openAsk`.
5. **When unclaimed or `null`:** `notifyUser` plus `ctx.ui.select` as today, then clear `openAsk`.

Update all 8 callers with their key and `roles`:
- Approve and the arbiter label → `approve`;
- "Back to discussion" and "Full flow instead" → `discuss`;
- Stop → `stop`;
- "Back to planning" → `replan`;
- "Wait" → `wait`.

Each caller passes `detail`:
- `plan-flaw` and `judge-cap`: the judge report;
- `merge-early`: the merge reason and the arbiter's view;
- `executor-error` and `judge-error`: the error text;
- `plan-menu`: the block reason and the planner's last reply.

Add `askSeq?: number` and `openAsk?` to `FlowState` (`:110`).

**S4.** **`:3450` "Run the judge?"** becomes `askUser(ctx, "run-judge", "Diff ready: run the judge …?", ["Run the judge", "Skip"])`. It keeps the existing `!run` behaviour on "Skip" or `undefined`, and the `notifyUser` before it moves inside `askUser`.

**S5.** **Plan path (`:3155-3199`).**
- The `plan-menu` ask is sent before the `if (!cfg.planPrompt)` return, so it is sent whatever `planPrompt` is set to. When it isn't claimed, the existing flow (notice at `:3190` or menu) runs unchanged.
- The notices at `:3166` and `:3196` are shown only when the ask isn't claimed; their texts go into `detail`.
- On the claimed K10 path:
  - `:3174` becomes "workflow: plan sent for review";
  - `:3184` drops "; say go to approve it".

  `workflow/README.md` keeps the "type go yourself" hint.

**S6.** **Waits.** A helper `askWait(ctx, w)` is called right after `state.waiting` is set at `:2122`, `:2213`, `:2694` and `:3266`. It:
- emits K12 `kind: "wait"`, `key: "wait"`, with `wait: { reason, check, manual }` and id `state.waiting.askId` (saved on the wait);
- **on `{resume, text}`:**
  - runs the wait's check if it has one;
  - if the check passes, or there is none, ends the wait the same way typed text does at `:2992` and later, with `text` (or "continue") as the resume message, then emits `ask-done answered`;
  - if the check fails, emits `ask-done answered` for the old id, saves a new id and sends a new K12 wait with the check result in `detail`;
- **on `null`:** does nothing (the wait stays local as today).

Every other local end of a wait (the poll check passes, someone types) emits `ask-done answered` for its `askId`.

Factor the existing "end the wait" code into one function that the input handler and `askWait` share.

**S7.** **Restart** (`session_start`, `:3898`):
- a saved `state.waiting` with an `askId` re-emits its K12 wait with the same id;
- a saved `state.openAsk` of kind `menu` is cleared, `ask-done withdrawn` is emitted, and it is never sent again;
- `askSeq` continues from the saved value.

**S8.** **K13.** New idle timer (`idle13Timer`), scheduled at the same place as `scheduleIdleNotice` (`:3119`) and cleared at the same places (`:2973`, `:3999`).
- After `cfg.notify.idleMs` it fires only when all hold:
  - the phase is `plan` or `execute`;
  - `ctx.isIdle()`;
  - no `compacting`, `compactPending` or `pendingHandover`.
- It doesn't depend on `notify.enabled`, `hasUI` or `notifiedSinceStart`.
- It emits K13 with `lastText` (the last assistant text, truncated to 4 000 characters).
- When claimed with `{handled: true}`, `scheduleIdleNotice`'s notification is suppressed for this idle period: set a flag that the notice timer checks.

**S9.** **Guard test `workflow/ui-guard.test.ts`.** It scans `workflow/*.ts` except tests for `ctx.ui.(select|confirm|input|custom)` and `ui.(select|confirm|input|custom)` calls. Each one must sit inside `function askUser`, `function resumeFlow`, the wait input handler (the `pi.on("input"` block), the `case "board"` block or the `case "model"` block. Find the enclosing block by scanning upward for these markers, not by line numbers. Model: `workflow/boundary.test.ts`.

**S10.** **Tests** in `workflow/asks.test.ts`, covering the pure parts and a small harness that drives `askUser`/`askWait` through fake `pi.events`/`ctx` objects, as in `workflow/hooks.test.ts`. Add both new files to the `workflow/README.md:229` command.

**S11.** **Docs.**
- `workflow/README.md`:
  - K12 (payload, `roles`, keys, answers, persisted id, "claimed → nothing local");
  - `ask-done`;
  - K13 as a claim;
  - the K10 notice text;
  - "unclaimed = as before".
- `docs/workflow-improvements.md`:
  - a new row **A48** "Orchestrated sub-sessions need no local interaction (K12/K13, orch_decide, escalation, auto-trust)", marked partly implemented (stage 1: workflow contracts);
  - a new row **A49** "Orchestrator reopens a crashed sub-session", idea only;
  - the Status line;
  - an Effect measurement row for A48: the metric is local prompts per orchestrated run (target 0) and escalations per run.

### Stage 2: Orchestrate foundations

**S12.** **Move `sameDir`** from `index.ts:34` to `store.ts` (exported, next to `norm`). Update its uses, and add cases to `store.test.ts`: mixed case on win32, backslashes, a trailing slash.

**S13.** **`spawning` state.**
- Add `"spawning"` to `SubState` (`brief.ts:5`), `spawningAt?: string` to `Sub`, and `originTrusted?: boolean` to `Run`.
- Add `spawning` to `ACTIVE` (`brief.ts:47`, `index.ts:33`) and to the lists at `view.ts:117,169`, so it counts toward `maxSubs` and shows as `spawning`.
- `orch_spawn` (`:907`): before W1, write `state: "spawning"` and `spawningAt` with `mutate`.
  - On success: `spawned`, and `spawningAt` is removed.
  - In the `catch` (`:950`): back to `planned`, and `spawningAt` is removed.
- New pure helper `staleSpawning(run, now, ownerAlive)` in `brief.ts`. A sub counts as stale when it is `spawning` and any of these holds: `spawningAt` is missing, `spawningAt` is more than 3 min old, or the owner is dead. `/orch watch` (`:1104`) and the orchestrator's `session_start` reset those subs to `planned` and report each one: "reset <id> to planned; if a worktree exists use /wt open or /wt remove".
- Tests in `brief.test.ts`.

**S14.** **`originTrusted`.** `orch_run` (`:879`) stores `run.originTrusted = ctx.isProjectTrusted()`. Wrap the call in try/catch; if it throws, store `false`.

**S15.** **Trust handler.**
- New `orchestrate/trust.ts`, pure: `trustStep(top, runs, now) → "yes" | "poll" | "undecided"`:
  - `yes`: some active run with `originTrusted === true` has a sub in `spawned`, `planning`, `executing` or `awaiting-acceptance` whose `cwd` matches `top` by `sameDir`;
  - `poll`: otherwise, while such a run has a `spawning` sub with `spawningAt` less than 3 min old;
  - `undecided`: otherwise.
- **Async wrapper `decideTrust(cwd)`:**
  1. Runs `execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], {cwd, timeout: 5000})`. An error or timeout means undecided.
  2. Calls `listActiveRuns(common)`.
  3. Loops on `trustStep`: on `poll` it re-reads every 500 ms, for at most 15 s in total.
- `index.ts` registers `pi.on("project_trust", …)`. It returns `{ trusted: "yes", remember: false }` on yes and `{ trusted: "undecided" }` otherwise. It never prompts.
- Tests in `trust.test.ts`, with injected runs and clock:
  - **yes:** a match at once; a `spawning` sub that turns `spawned` during the poll; a `/resume` into a sub worktree (the same as a match);
  - **undecided:** no repo or git timeout (inject the exec), no run, no match within 15 s, a stale `spawning` sub, `originTrusted` false or missing;
  - **paths:** mixed case, backslashes, a trailing slash.

**S16.** **Identity and held claims.**
- Add `identity: "unknown" | "sub" | "not-sub"` and a held queue for K10, K11, K12 and K13.
- The K10 and K11 listeners (`:160`, `:181`):
  - **`unknown`:** claim at once with a promise and queue the event;
  - **`sub`:** run today's logic (factor each body into a function);
  - **`not-sub`:** return without claiming.
- Set `sub` in `become()`, then replay the queue. Set `not-sub` in each case listed in Design, then resolve every held claim to `null` and clear the queue.
- Register the K12 and K13 listeners in this stage, but only to hold them. In `sub` they resolve to `null` until stage 3.
- Tests: a pure queue helper in `identity.ts` with `identity.test.ts`: hold, then replay as `sub`, or `null` as `not-sub`.

**S17.** **`confirmPlans` default `false`** (`config.ts:25`). The menu code at `:1010` stays for anyone who sets it to `true`. Update `config.test.ts`.

**S18.** **`ask_orchestrator` without a timeout** (`:272-300`).
- Remove the `setTimeout` and the `:299` text.
- The wait ends on:
  - an answer;
  - an abort, which returns "cancelled; the question stays open and a late answer arrives as a message";
  - run state `ended`: `deliverInbox` (3 s) also reads `run.json`, and when the run has ended it resolves every pending question with "the run ended; finish what you can without this answer" and every held K10, K11, K12 or K13 claim with `null`.
- Remove `askTimeoutMinutes` from `config.ts`. An old value is ignored with no warning: drop it from `INT_KEYS` and skip the key.
- `brief.ts:202` becomes: "Ask the orchestrator with the ask_orchestrator tool instead of guessing; it always answers. While you wait for an answer that was cancelled, continue with what is not blocked."
- Update `brief.test.ts` and `config.test.ts`.

**S19.** **Docs** (`orchestrate/README.md`):
- the `confirmPlans` default;
- `askTimeoutMinutes` removed;
- the `spawning` state;
- trust: how it decides, `remember: false`, `/resume`, "another extension's earlier yes/no wins", and the non-goal of worktrees without `.pi` or `.agents/skills`;
- identity and held claims;
- older runs: without `originTrusted` the trust prompt is shown.

  Add the new test files to the Tests command. Update the A48 row in `docs/workflow-improvements.md`: "stage 2: trust, spawning, identity".

### Stage 3: Orchestrate decisions and escalation

**S20.** **`orchestrate/items.ts`** (pure) and the store functions `readItems`/`writeItems` in `store.ts`. Model on `readView`/`writeView`: tmp + rename, and a missing file means empty.

The functions in `items.ts`:

- **`openItem(items, msg, now)`**: one item per outbox message of type question, `ask`, idle, `plan-review` or `accept-request`.
  - **Caps applied when the item opens:**
    - A `wait` is escalated at once.
    - A `plan-review` is escalated when `planRejections ≥ maxPlanRejections`.
    - A menu or `accept-request` is escalated when `autoAnswers[key].count ≥ maxAutoAnswers`.
      - **Loop keys** (`judge-cap`, `plan-flaw`, `accept`, `merge-early`): first reset the count to 0 if the stored stage differs from the ask's stage. An `undefined` stage equals `undefined`, so an unstaged plan gives a per-run cap.
      - **Other keys:** first reset to 0 if the sub's fingerprint changed since the count was taken.
    - An `idle`:
      - progress since the last idle (fingerprint changed) sets `idleNoProgress = 1`; otherwise it adds 1;
      - it is escalated when `idleNoProgress > maxIdleAnswers`.
  - **Replacements:**
    - A new `accept-request` for the same sub and repo makes the old one `stale`.
    - A `plan-review` sets `autoAnswers["plan-menu"]` to 0.
- **`tick(items, now, orchestratorIdle, elapsedMs)`**, for each open, non-escalated item:
  - adds `elapsedMs` to `idleMs` only when `orchestratorIdle`;
  - emits a reminder when `idleMs` crosses 60 s, 5 min or 10 min (`reminders` < 3);
  - escalates when `idleMs ≥ 15 min` or `now - postedAt ≥ 30 min`;
  - returns the actions (`remind`, `escalate`).
- **`close(items, ref, how, byUser)`**, which also updates the counters:
  - **orchestrator answers:**
    - a menu answer adds 1 to `autoAnswers[key]` and stores the current stage and fingerprint;
    - an accept refusal adds 1 to `autoAnswers.accept`;
    - a plan rejection adds 1 to `planRejections`;
    - a plan approval sets `planRejections` to 0;
    - a `replan` choice adds 1 to `replans`;
  - **your answers (`byUser`):** the count of that item's cap goes to 0 (`planRejections`, `autoAnswers[key]`, `idleNoProgress`), and `replans` is left as it is.
- **`markStale(items, sub, instance)`**: a `session-started` with a new instance marks that sub's open menu and plan-review items of earlier instances as stale.
- **`recordUserMessage(items, text, now)`**: appends the message to `userMsgs` of every escalated, open item.
- **`quoteOk(item, quote)`**: true when the trimmed quote is non-empty and an exact substring of one `userMsgs` entry.

Config: add `maxPlanRejections: 3`, `maxReplans: 2`, `maxAutoAnswers: 2` and `maxIdleAnswers: 3` to `config.ts` `DEFAULTS` and `INT_KEYS`.

**S21.** **`orchestrate/decide.ts`** (pure). `checkDecision(item, answer, sub counters, cfg) → ok | refuse(reason, escalate: boolean)`:
- **For menus:**
  - the choice must be in `options`;
  - **`plan-menu`:** refuse roles `approve` and `discuss` ("approve plans with orch_review_plan" / "not available in an orchestrated sub");
  - **`wait` role in `stage-empty`/`steps-open`:** refuse without `text`;
  - **`stop` role:** needs a valid `userQuote`; otherwise refuse with `escalate: true`;
  - **`replan` role:** when `replans ≥ maxReplans`, needs a quote; otherwise refuse with `escalate: true`;
- **For waits:** `resume` needs a quote; otherwise refuse with `escalate: true`.
- **For escalated items (any kind, any tool):** a valid `userQuote` is needed.
- **For stale, answered or unknown items:** refuse.

**S22.** **Sub side** (`index.ts`, in `sub` identity):
- **K12 claim:** post an `ask` (with `stage` from the last K4) and keep `askId → resolve`.
- **`deliverInbox`:** a `decision` resolves the matching claim with `{choice, text}` or `{resume: true, text}`. An unknown id gives a warning.
- **`workflow:ask-done`:** post it and drop the claim.
- **K13 claim:** resolve `{handled: true}`, then post `idle` after 20 s more, unless one of these happened first:
  - `agent_start` fired;
  - the run state of this sub isn't `spawned`, `planning` or `executing`;
  - a K10, K12, question or accept-request is open (track `requestedTrees` that have no verdict yet).

  Remember that an `idle` is open.
- **`agent_start` while an `idle` is open:** post `idle-end`.
- **At `become()`:** post `session-started {instance}`.
- **The 3 s poll (D10):** for each item older than 30 min (pending questions, K10 n, held K12, open accept requests; times kept in memory), if the run owner's host is this host and its pid is dead, send one desktop notification per item: "orchestrator not running: open it and run /orch watch". Use `shared/notify.ts`.

**S23.** **Orchestrator side.** The watcher, in `readOutboxes`, `pollGit` and its own timers:
- Load `items.json` in `startWatcher`. `/orch watch` reloads it. An item already past its ceiling is escalated on the first tick.
- **Outbox events:**
  - `ask`, `question`, `idle`, `plan-review` and `accept-request` open items (S20);
  - `ask-done` closes its item (`answered`/`withdrawn`);
  - `idle-end` closes the sub's open idle item;
  - `session-started` marks earlier items stale. Tell the agent: "<sub> restarted; its open menu and plan reviews are stale; send it a directive (orch_send) to continue".
- The events at `:564-570` gain text for `ask` (menu: title, options, roles, detail; wait: reason and check) and for `idle` (last text).
- **The sub's fingerprint** comes from the existing `pollGit` snapshot (phase, done, head, porcelainHash) plus `stage` from `status.json`.
- **Open items block `stalled`:** suppress `stalled` (`:728`) for a sub with an open item.
- **Busy tracking:** track `agent_start`/`agent_end` in the orchestrator session, and call `tick` every 5 s with `orchestratorIdle`.
  - A `remind` action sends a follow-up: "Still open: <ref> <summary>; answer it or call orch_escalate".
  - An `escalate` action:
    - sets the item to escalated;
    - sends a desktop notification;
    - sets the widget and board marker;
    - sends a follow-up to the agent: "Escalated to the user: <item>. Show it to them with its options and relay their answer with userQuote".
  - Caps that escalate on open do the same.
- **`input`** (`:376`): in run mode, text you type (not `/`, not `source: extension`) is passed to `recordUserMessage`. This happens before the existing `onTyped` logic and doesn't change it.
- Every change is written to `items.json` at once.

**S24.** **Tools.**
- **New `orch_decide {id, askId, choice?, resume?, text?, userQuote?}`.** It checks the answer with `checkDecision`.
  - **Refused:** it returns the reason. With `escalate: true` it also escalates the item, as in S23.
  - **Accepted:** it appends a `decision` to the sub inbox and closes the item (`byUser` when it had a quote).
- **New `orch_escalate {id, ref, question}`.** It escalates an open item, with the question shown to you.
- **Existing tools gain an optional `userQuote`** and refuse an answer on an escalated item without a valid one, or on a stale item: `orch_send` (with `replyTo`), `orch_review_plan` and `orch_accept`.
  - `orch_review_plan` and `orch_accept` close their item and update the counters (S20).
  - `orch_send` closes a question by `replyTo`, and any send to a sub closes that sub's open `idle` item.
- Add `orch_decide` and `orch_escalate` to the always-allowed tools in `mode.ts:39`, and update `mode.test.ts`.

**S25.** **View** (`view.ts`, built from `items.json`).
- The pending list gets a marker per item: `? question`, `menu <key>`, `wait`, `idle`, `plan n review`, `⚠ accept …`, and escalated items as `‼ you: <ref>`.
- The header shows "n waiting for you".
- The sub status line gains `waiting for orchestrator: decision`.
- `view.test.ts` cases for the escalated marker and the header count.

**S26.** **Prompts.** `prompts.ts` RUN:
- review each plan against the brief's goal, criteria, `owns`/`forbids` and decisions, and reject it with concrete fixes;
- answer every question, menu and idle report yourself from the brief, the agreed decisions and the code;
- never ask the user in plain chat;
- escalate with `orch_escalate` only what needs a person or a choice the brief doesn't settle;
- relay the user's answers with `userQuote`;
- waits come to the user.

**S27.** **Docs.**
- `orchestrate/README.md`:
  - message types and `items.json` in the file table;
  - config keys and defaults;
  - `orch_decide` (refused, text-only and quote-only choices) and `orch_escalate`;
  - escalation timing and `userQuote` (best effort);
  - the reset rules per cap, including "unstaged plans → loop keys are per run", "your answer resets the cap except maxReplans" and "plan-menu resets on review";
  - `idle` and `idle-end`;
  - stale items;
  - the "orchestrator not running" notification;
  - older runs (no `items.json` → empty).
- `docs/workflow-improvements.md`: A48 implemented, plus the Status line and the Effect measurement row.

### Tests

The tests are A1–A6 (D11). New test files: `shared/notify.test.ts`, `workflow/asks.test.ts`, `workflow/ui-guard.test.ts`, `orchestrate/trust.test.ts`, `orchestrate/identity.test.ts`, `orchestrate/items.test.ts`, `orchestrate/decide.test.ts`. They extend `store.test.ts`, `brief.test.ts`, `config.test.ts`, `mode.test.ts` and `view.test.ts`.

**A1 — `ui-guard.test.ts`:**
- passes on the changed code;
- a fixture string with a direct `ctx.ui.select` outside the allowlist fails it.

**A2 — `asks.test.ts` (workflow side):**
- **Menu answers:**
  - a choice without `text` → no `ui.select`, and that label is returned;
  - a choice with `text` → `handover` receives the text;
  - `null` → `ui.select` is called, and `notifyUser` only then;
  - an invalid choice → re-emitted with the same id;
  - `ask-done answered` on resolve;
  - `key` and `roles` are present.
- **Waits:**
  - resume with a passing check, or no check → the wait ends and `ask-done` is sent;
  - resume with a failing check → a new id with the check result in `detail`;
  - a local end → `ask-done answered`.
- **Persistence:**
  - `askSeq` and `openAsk` are saved;
  - restart: the wait is re-sent with the same id; a menu is cleared with `withdrawn`.
- **K13:**
  - sent with `notify.enabled: false`;
  - not sent outside plan or execute;
  - a claim suppresses the notification.

  **Plan menu (`plan-menu`):**
  - `plan-menu` is sent both when the plan is blocked and when there is no plan;
  - the `:3174` and `:3184` texts drop "go".

  **Orchestrate side** (in `decide.test.ts` and `identity.test.ts`):
  - `approve` (both labels) and `discuss` (both labels) are refused in `plan-menu`;
  - "Wait" without `text` is refused;
  - K10, K11, K12 and K13 are held while `unknown`, then replayed as `sub` or resolved `null` as `not-sub`;
  - no `idle` in `awaiting-acceptance`, `merged` or `stopped`, nor while an accept request is open (pure gate function in `items.ts`).

**A3 — `trust.test.ts`, `brief.test.ts`, `store.test.ts`:**
- the yes, undecided and path cases from S15;
- `spawning` reverts to `planned` on failure (a pure helper used by the `catch`);
- `staleSpawning` resets after 3 min, with a missing `spawningAt`, or with a dead owner.

**A4 — `items.test.ts` (timing), with an injected clock:**
- reminders at 60 s, 5 min and 10 min of idle time;
- escalation at 15 min idle;
- escalation at the 30 min ceiling while busy;
- nothing counted while busy;
- closing ends the counting;
- accept requests follow the same timing;
- an idle item is closed by an `orch_send` to its sub and by `idle-end`;
- restart: a saved `idleMs` continues, and an item past the ceiling is escalated on the first tick; a missing file means empty;
- the D10 decision helper: notify only when the owner's host is this host and its pid is dead, once per item.
- `ask_orchestrator` with no timeout is checked by the S18 run-ended resolution helper (pure) and by A6.

**A5 — `items.test.ts` and `decide.test.ts` (caps):**
- **plan rejections:** the 4th review is escalated; approval resets the count, and so does your answer.
- **`maxAutoAnswers`:**
  - a `judge-cap` loop with fingerprint changes in between escalates on the 3rd ask in the same stage;
  - the same for `accept` refusals;
  - a stage change resets the loop keys, and an approval doesn't;
  - an unstaged plan makes the loop keys per-run;
  - other keys escalate on 3 in a row, and progress resets them;
  - `plan-menu` is reset by a plan review.
- **`maxReplans`:**
  - the plan-flaw → replan → approve cycle refuses the 3rd replan without a quote and auto-escalates it;
  - your answer doesn't reset `replans`.
- **`maxIdleAnswers`:** the 4th no-progress idle is escalated.
- **Quotes:**
  - a wait is escalated at once, and a resume without a quote is refused;
  - Stop without a quote is refused and auto-escalated, and accepted with one;
  - a quote that matches no message typed after the escalation is refused;
  - an escalated item's answer without a quote is refused for every tool kind.
- **Restart:** the counters and the escalated state survive a write and a read.

**A6 — manual end-to-end.** S29.

**Commands:**
- `cd pi/agent/extensions/shared && node --experimental-strip-types --test claims.test.ts readonly-bash.test.ts readonly-tools.test.ts tokens.test.ts runs.test.ts roles.test.ts boundary.test.ts notify.test.ts`
- `cd pi/agent/extensions/workflow && node --experimental-strip-types --test <the list at README.md:229> asks.test.ts ui-guard.test.ts`
- `cd pi/agent/extensions/orchestrate && node --experimental-strip-types --test config.test.ts paths.test.ts brief.test.ts store.test.ts monitor.test.ts inbox.test.ts boundary.test.ts mode.test.ts repos.test.ts folders.test.ts view.test.ts trust.test.ts identity.test.ts items.test.ts decide.test.ts`

Expected result: every suite passes with 0 failures. All are fast (under 1 min). Each stage runs the suites it touched; stage 3 runs all three.

**S28.** **Run all three suites at each stage end, and fix any failures** before the stage commit.

**S29.** **Verify** (A6, manual), on a scratch GitHub repo with packages `a` and `b` (`b` depends on `a`):
- **Setup:**
  - `a`'s brief needs a `wait_for_user` with `manual: true`;
  - `maxJudgeRounds: 1` in that repo's flow;
  - one plan with a broken wait check;
  - restart `a`'s sub-session (`/wt open`) during the wait;
  - restart the orchestrator and run `/orch watch` while an item is escalated.

  **Look for:**
  - no keystroke goes into a sub window, and no trust prompt appears;
  - no desktop notification or input-asking notice comes from a sub (the only exception is "orchestrator not running" when the orchestrator is closed);
  - every item in `items.json` ends answered, escalated-then-answered or stale;
  - you only receive the escalations and the waits.

### Done when
- Stages 1–3 are committed, all three suites pass, and A1–A5 hold as listed.
- With an orchestrate run, no workflow menu, wait, notice that asks for input, or trust prompt needs input in a sub window (A6).
- Unorchestrated sessions behave exactly as before: an unclaimed K12 or K13 shows the same menus and notifications.
- Docs are updated as in D12, and A48 is marked implemented with A49 as an idea.

### Risks, rollback, what not to touch
- **Risk: a missed menu path.** A1 enforces it.
- **Risk: a held claim that never resolves.** Every hold ends on identity, run end or session shutdown: at `session_shutdown` resolve the held and pending claims to `null` (the existing K10 handling at `:1279` is the model).
- **Risk: a K11 hold longer than 30 s.** It refuses the merge, which is safe, and the merge is retried.
- **Rollback:** revert the stage commits. The contracts are additive, and old runs work (no `items.json`, no `originTrusted`).
- **Don't touch:**
  - worktree code and the W1 contract;
  - `shared/claims.ts` semantics;
  - K9 and the K10/K11 payloads;
  - the `/flow resume`, `/flow model` and `/flow board` UI;
  - `trust.json` (never written).
- **orchestrate never imports workflow or worktree** (`boundary.test.ts`).

### Commits
- **Stage 1:**
  - "shared: move notifyCommand to shared/notify.ts": `shared/notify.ts`, `shared/notify.test.ts`, `workflow/notify.ts`, `workflow/notify.test.ts`, `shared/README.md`.
  - "workflow: K12 workflow:ask, ask-done and K13 workflow:idle for orchestrated sessions": `workflow/index.ts`, `workflow/asks.ts`, `workflow/asks.test.ts`, `workflow/ui-guard.test.ts`, `workflow/README.md`, `docs/workflow-improvements.md`.
- **Stage 2:**
  - "orchestrate: spawning state, auto-trust for spawned worktrees and held claims until the sub is known": `brief.ts`, `store.ts`, `trust.ts`, `identity.ts`, `index.ts`, `view.ts`, the tests, `README.md`, `docs/workflow-improvements.md`.
  - "orchestrate: confirmPlans off by default and ask_orchestrator without a timeout": `config.ts`, `index.ts`, `brief.ts`, the tests, `README.md`.
- **Stage 3:**
  - "orchestrate: items.json, orch_decide, orch_escalate, caps and escalation to the user": `items.ts`, `decide.ts`, `store.ts`, `index.ts`, `mode.ts`, `view.ts`, `config.ts`, `prompts.ts`, the tests, `README.md`, `docs/workflow-improvements.md`.

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 Move `notifyCommand` to `pi/agent/extensions/shared/notify.ts`, with its tests in `shared/notify.test.ts` (taken from `w
- [ ] S2 New `workflow/asks.ts`, pure, with:
- [ ] S3 `askUser` becomes `askUser(ctx, key, title, options, opts?: { detail?, roles? })` (`index.ts:310`). It still returns the
- [ ] S4 `:3450` "Run the judge?" becomes `askUser(ctx, "run-judge", "Diff ready: run the judge …?", ["Run the judge", "Skip"])`.
- [ ] S5 Plan path (`:3155-3199`).
- [ ] S6 Waits. A helper `askWait(ctx, w)` is called right after `state.waiting` is set at `:2122`, `:2213`, `:2694` and `:3266`.
- [ ] S7 Restart (`session_start`, `:3898`):
- [ ] S8 K13. New idle timer (`idle13Timer`), scheduled at the same place as `scheduleIdleNotice` (`:3119`) and cleared at the sa
- [ ] S9 Guard test `workflow/ui-guard.test.ts`. It scans `workflow/*.ts` except tests for `ctx.ui.(select|confirm|input|custom)`
- [ ] S10 Tests in `workflow/asks.test.ts`, covering the pure parts and a small harness that drives `askUser`/`askWait` through fa
- [ ] S11 Docs.
- [ ] S12 Move `sameDir` from `index.ts:34` to `store.ts` (exported, next to `norm`). Update its uses, and add cases to `store.tes
- [ ] S13 `spawning` state.
- [ ] S14 `originTrusted`. `orch_run` (`:879`) stores `run.originTrusted = ctx.isProjectTrusted()`. Wrap the call in try/catch; if
- [ ] S15 Trust handler.
- [ ] S16 Identity and held claims.
- [ ] S17 `confirmPlans` default `false` (`config.ts:25`). The menu code at `:1010` stays for anyone who sets it to `true`. Update
- [ ] S18 `ask_orchestrator` without a timeout (`:272-300`).
- [ ] S19 Docs (`orchestrate/README.md`):
- [ ] S20 `orchestrate/items.ts` (pure) and the store functions `readItems`/`writeItems` in `store.ts`. Model on `readView`/`write
- [ ] S21 `orchestrate/decide.ts` (pure). `checkDecision(item, answer, sub counters, cfg) → ok | refuse(reason, escalate: boolean)
- [ ] S22 Sub side (`index.ts`, in `sub` identity):
- [ ] S23 Orchestrator side. The watcher, in `readOutboxes`, `pollGit` and its own timers:
- [ ] S24 Tools.
- [ ] S25 View (`view.ts`, built from `items.json`).
- [ ] S26 Prompts. `prompts.ts` RUN:
- [ ] S27 Docs.
- [ ] S28 Run all three suites at each stage end, and fix any failures before the stage commit.
- [ ] S29 Verify (A6, manual), on a scratch GitHub repo with packages `a` and `b` (`b` depends on `a`):
