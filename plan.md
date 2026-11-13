<!-- pi-workflow plan v1 flow=20261113-2145-orchestrate-merge-confirmation-by-delive-50b4 -->
## Plan: Orchestrate merge confirmation by delivered trees (bug 3) plus watcher fixes

### Goal and non-goals
**Goal.** The orchestrator should confirm a package as merged when its last delivered tree in each repo it changed is merged into the run's target. That covers packages that deliver through several `flow/*` PRs into a non-default branch, in repos where `gh` would resolve to a different repo by default. The two workflow events this needs are added, the smaller watcher issues agreed in the discussion are fixed, and the result is installed.

**Non-goals.**
- Bugs 1 and 2 are already fixed and installed. Nothing changes for them; your live run checks them.
- The false "stage ended with no changes" menu (D42), duplicate wait reminders (D43) and pinning the merge to the gate's head commit (D44) are backlog ideas only.
- No fake-`pi` test harness.

### User decisions
- **D1.** The rule uses the **last** delivered tree per repo, not every accepted tree.
- **D2.** You check bugs 1, 2 and 3 yourself in a new orchestra run after the install. The flow does unit tests, the read-only check on `o11131503`, and the install.
- **D3.** The design is the last "Agreed so far" list of the discussion (review PASS), plus its three PASS minors:
  - the `/flow plan` limit names K13 idle, not the stall monitor;
  - subs that ended before the upgrade get one check;
  - the `@{u}` used at check time is written down as a limit.
- **D4.** One flow per package, enforced by the brief and the plan review. A stopped or abandoned flow may be resumed.
- **D5.** Only a `finished` end merges a sub on its own. `/orch merged <id>` merges on a positive check for any end, and `--force` merges anyway.
- **D6.** Uncommitted files, and a `HEAD` that differs from the last delivery, never block. Each only adds a note.
- **D7.** Every gh call gets `-R owner/name`, taken from the target's remote, else the `@{u}` remote, else `origin`. gh's own repo resolution is never used.
- **D8.** Install `workflow/`, `orchestrate/` and `shared/` together, and restart every session afterwards.

Merge points: S17 (the install copies the merged `master`).

Stages:
1. **Workflow contracts:** K11 `ask` and K14 `workflow:flow-end`, their tests, the README and the backlog rows.
2. **Orchestrate delivery check:** `delivery.ts`, the wiring, the brief and prompts, the README, the read-only check, the merge and the install.

### Facts the executor needs
- **Workflow K11.**
  - The gate: `acceptanceProblem` at `workflow/index.ts:3013`. Its calls are the publish gate at `:2382`, the `git_task` advance check at `:2433` and the merge/protected-push gate at `:2973`.
  - `gateCheck` returns `tree: null` only together with a problem (`merge-gate.ts:69-93`).
- **Workflow flow end.**
  - `endFlow` is at `workflow/index.ts:470`. It calls `setPhase` at `483`, `489` and `492`.
  - Its callers: `3512`, `3533` and `4025` are normal ends (`finished`); `3418`, `3661`, `3698`, `3726` and `3747` are Stop choices (`stopped`). Confirm each by reading its context.
  - `setPhase` starts at `:614`. `leavingFlow` is at `:615` and the `summarizeFlow` for a replan or abandon at `:616-617`. `planDoc` is cleared at `:661-665`.
  - The status emitter (`emitStatus`, `:531`) is the pattern to copy for a guarded emit.
  - The manual `/flow <phase>` is at `:4388-4400`.
- **Workflow tests** import pure modules (`hooks.test.ts:3`). The precedent for a source-scan test is `workflow/ui-guard.test.ts`, which reads `index.ts` as text.
- **Orchestrate, sub side.**
  - `post` is at `orchestrate/index.ts:204-211` and writes only when `me` is set.
  - The phase-change `flow-ended` post is at `:227`.
  - `handleMergeGate` is at `:360-392`: an ended run passes at `:366`, the tree falls back to `HEAD^{tree}` at `:378`, the verdict and acceptance check is at `:383-384`, and the request is sent at `:385-390`.
- **Orchestrate, orchestrator side.**
  - `ghMerged` is at `:893` (no `-R`).
  - In `readOutboxes` (`:903-984`): `accept-request` at `:950-954`, `flow-ended` at `:955`, the catch-all at `:956`, `endedAt` set once at `:964-969`, and the arrival check at `:980`.
  - `checkEnded` is at `:990-1027`: the single-repo `ghMerged` at `:999`, `setPr` at `:1000`, the "rebase on the updated default branch" message at `:1023`, and the in-memory `reportedUnmerged` at `:986`.
  - `mergedPerRepo` is at `:1031-1052`, `diffBase` at `:1055`, and the default-branch lookup at `:1065` (no `-R`).
  - `pollGit` calls `checkEnded(false)` at `:1145`. The timers are at `:1161-1163`: outboxes every 5 s, git every `pollSeconds` (60 s).
  - `startWatcher` is at `:1150`, `table()` at `:1168`, `orch_review_plan` at `:1451`, `orch_accept` at `:1486-1522`, and `/orch merged` at `:1612-1616`.
  - At run creation, `targets` come from the given value (always `origin/…`, `:1276`), else from `@{u}` (`:1279-1286`).
- **Orchestrate helpers.**
  - `readAccepted` and `addAccepted` are at `store.ts:169-180`, with `writeAtomic` as the model for `merges.json`. `appendMessage` stamps `ts` (`store.ts:124`).
  - `worktreesOf` (`repos.ts:72`) returns key `""` for single-repo runs.
  - The `Sub` type is in `brief.ts:7-29` (`endedAt` at `:25`) and `Run.targets` at `brief.ts:43`. The brief's delivery line is at `brief.ts:229`.
  - `boundary.test.ts` forbids imports from `../workflow/`.
- **Tests** run with `node --experimental-strip-types --test <files>` inside each extension folder (header comments, for example `boundary.test.ts:1`).
- **Install.** `node bin/import.js --dry-run`, then `node bin/import.js`, copies `pi/agent/*` to `~/.pi/agent/*` and backs up overwritten files as `.bak-<stamp>`. The repo's default branch is `master`.
- **Read-only check data.**
  - The run folder of `o11131503` is gone.
  - The full trees are in the session logs, in `C:\Users\unkno\.pi\agent\sessions\`:
    - the sub logs `--D--works-annamites-wt-o11131503-{core,view}-city-bus-flow--\*.jsonl` contain "Tree <40 hex> … accepted";
    - the orchestrator log `--D--works-annamites-city-bus-flow--\2026-11-13T07-51-51-951Z_*.jsonl` contains "accepted tree <40 hex> of <core|view>".
  - The run was created at `2026-11-13T08:03:08.824Z`.
  - `city-bus-flow` is on `feat/new-gameplay`, whose `@{u}` is `origin/feat/new-gameplay`. Its remotes are `origin` (Annamites/city-bus-flow) and `upstream` (game-template, with `gh-resolved = base`).

### Design
**Event and message formats.** All are version 1; new fields are optional.
- **K11** `workflow:merge-gate`: `{ v: 1, kind, cwd, tree, ask: "gate" | "pre" }`. A payload without `ask` is treated as `"pre"`.
- **K14** `workflow:flow-end`: `{ v: 1, flowId?: string, how: "finished" | "stopped" | "abandoned" }`. It is emitted before the phase changes.
- **Outbox `flow-ended`:** data `{ flowId?, how }`. A missing or unknown `how` is read as `"unknown"`.
- **Outbox `merge-pass`:** data `{ tree, repo, kind }`, where `kind` is `merge` or `protected-push`. The message `ts` is the time of the delivery.
- **`accept-request` data:** `{ tree, repo, kind, ask }`. **`accept-verdict` data:** `{ accept, tree, repo, kind?, ask? }`, both copied from the request.
- **`<sub>/merges.json`:** `{ "merges": [{ "key", "tree", "kind", "at" }] }`, appended in order and written atomically.
- **`Sub` fields added:** `endHow?: "finished" | "stopped" | "abandoned" | "unknown"`, `endChecks?: number` (capped at 2), `endReported?: boolean`, `forced?: boolean` and `forcedCheck?: string`.

**Workflow** (`workflow/hooks.ts`, pure):
- `type K11Site = "merge" | "protected-push" | "publish" | "git-task"`.
- `K11_SITES`: `git-task` maps to `"pre"`, the other three to `"gate"`.
- `k11Payload(site, cwd, tree)`: the kind for `git-task` is `"merge"`.
- `flowEndKind({ from, to, viaEndFlow })`: returns `"abandoned"` when `from === "execute"`, `to` is `discuss` or `off`, and `!viaEndFlow`. Otherwise `null`, which includes a move to `plan` (a replan or a manual `/flow plan`).
- `flowEndPayload(flowId, how)`.
- `withEndFlow(flag, how, emit, body)`: emits first, then sets `flag.on` and runs `body`, and resets `flag.on` in `finally`.

**Orchestrate** (`orchestrate/delivery.ts`, new and pure, with no workflow imports). Signatures are the contract; types go in the file.
- `mergeGateDecision({ ask, kind, tree, treeGiven, key, accepted, verdictOk, requested, runEnded })` returns `{ pass: boolean, refusal?: string, request?: data, mergePass?: data }`.
  - `runEnded`: pass, nothing posted.
  - Accepted with a verdict: pass. A `mergePass` is posted only when `ask === "gate"`, `kind` is `merge` or `protected-push`, and `treeGiven`.
  - Not accepted, `ask !== "gate"`: refused with the "pre" text from the discussion ("Tree <t> is not accepted by the orchestrator yet. `git_task` can't ask for acceptance: merge with `gh pr merge` in the main session, so the gate asks the orchestrator."), and no request.
  - Not accepted, `ask === "gate"`: a request unless it was already requested, plus today's refusal text (`:390`).
- `applyOutbox(msgs)` returns `{ merges, end?: { at, how }, rest }`.
  - `merge-pass` messages become records with `at = msg.ts`.
  - The last `flow-ended` in message order gives `end`.
  - `rest` holds every other message. `merge-pass` and `flow-ended` are never in it.
- `lastDelivery({ merges, verdicts, accepted, key, workingKey })` returns `{ tree, kind, at? } | null`.
  - The newest by `at`/`ts` among: merge records for `key`, and accepted verdicts for `key` with either no `ask` (an old run, counted as `merge`) or `ask === "gate"` with kind `merge` or `protected-push`.
  - With none of those, the last `accepted.json` entry for `key`. Its token is `key:tree`, or a plain tree for key `""`.
- `deliveryMerged({ key, delivery, prTrees, prUnknown, targetTrees, commitsSinceBase, dirtyFiles, headTree, branchMerged })` returns `{ changed, ok: boolean | null, missing: string[], notes: string[] }`.
  - The repo counts as changed when it has a delivery, or `commitsSinceBase !== 0` (a null count counts as changed).
  - A `merge` delivery is `ok` when the tree is in `prTrees`. When it isn't, the result is `null` if `prUnknown`, else `false`.
  - A `protected-push` delivery is checked against `targetTrees`.
  - Changed with no delivery: `branchMerged`, and on false or a missing branch, "no accepted tree in <key>".
  - Notes: uncommitted files ("uncommitted files left in <key> (<n> files)"), and a `headTree` that differs from the delivered tree ("HEAD of <key> differs from its last delivered tree; check for undelivered work").
  - Missing texts name the tree (first 12 characters) and the base. None of them says "without a merged pull request".
- `combineRepos(results)`: no changed repo gives `false` with "no repo has changes". Otherwise any `false` gives `false`, else any `null` gives `null`, else `true`. Notes are concatenated.
- `endDecision({ endHow, ok, manual, force, checks })` returns `"merge" | "wait" | "report"`.
  - `force` → `merge`.
  - `manual` → `merge` when `ok === true`, else `report`.
  - `finished`: `ok` gives `merge`; `false` with `checks === 0` gives `wait`; anything else gives `report`.
  - Any other end gives `report`.
- `shouldPoll(sub)`: the state is not `merged` or `stopped`, `endedAt` is set, and either `endHow === "finished"` or `(endChecks ?? 0) === 0`.
- `parseMergedArgs(args)` returns `{ id, force } | { error }`. `--force` may come before or after the id.
- `verdictPayload(request, accept, reasons?)` and `stateAfterVerdict(state)`: `awaiting-acceptance` becomes `executing` on both accept and refuse.
- `parseRemoteUrl(url)` returns `owner/name | null`. It handles `https://github.com/o/r(.git)`, `git@github.com:o/r(.git)` and `ssh://git@github.com/o/r(.git)`.
- `pickGhRepo(remotes, ref)` returns `{ remote, slug } | null`. It uses the longest remote name that, followed by `/`, starts `ref`, else `origin`. A remote's `gh-resolved` is never read.
- `pickBase(ref, remote)` returns the branch, or `null` when there is no ref.
- `needsBiggerPage(n, limit)`.
- `listingAction(cached, round)`: `"use"` only when the listing was fetched in this same check round, else `"refresh"`.
- `prTreeIndex(prs, createdAt, treeOf)` returns `{ trees: Map<tree, number>, unknown: number }`. It filters `mergedAt >= createdAt`, and `treeOf` is injected.

**Orchestrator I/O glue** (`orchestrate/index.ts`):
- **Check rounds.** Each `checkEnded` call is one round, serialised on a promise chain so a poll and an arrival check never overlap.
- **Listing.** A round lists each repo it needs at most once: `gh pr list -R <slug> --state merged [--base <b>] --limit 200 --json number,headRefOid,mergedAt`, retried once at 1000 when full. Still full gives `null` with "too many merged PRs to check". Every poll and every arrival is a new round, so a listing is always fresh. That is stricter than the agreed "refresh when older than the last delivery" rule and covers it.
- **Tree lookup.** Trees come from `git -C <top> rev-parse <sha>^{tree}`, else `gh api repos/<slug>/commits/<sha> --jq .commit.tree.sha`, else `null`. They are cached in a session `Map`.
- **Target ref per key.** `run.targets[key]`, else `@{u}` of the orchestrator checkout at check time, a written limit that matters only for runs created before this change.
- **Protected-push.** Only while a sub's last delivery is an unconfirmed `protected-push`: `git fetch <remote> <branch>`, then `git log <ref> --since=<run.created> --format=%T`. Confirmed tokens are kept in a session `Set`.
- **Scale.** At most one listing (two with a retry) per repo per 60 s, while a finished sub is unmerged, plus one per arrival batch. Trees are looked up once per PR head. The design stops working when more than 1000 PRs were merged into the target since the run was created; that gives "unknown" and the fix is `--force`.

**Rejected alternatives.**
- Recording PR numbers would need a K11 change plus parsing `gh pr merge`.
- Checking every accepted tree warns forever after a replaced tree.
- `gh --search` lags behind merges.
- A fake-`pi` harness is too large for what it covers.

### Stage 1: Workflow contracts (K11 `ask`, K14 `flow-end`)

**S1.** `workflow/hooks.ts`: add `K11Site`, `K11_SITES`, `k11Payload`, `flowEndKind`, `flowEndPayload` and `withEndFlow` as in the Design. Model them on the existing pure helpers in `hooks.ts` (`acceptanceRefusal`, `keepExtraTools`). `withEndFlow` must reset the flag in `finally` even when `body` throws.

**S2.** `workflow/index.ts`, `acceptanceProblem` (`:3013`):
- Change the first parameter to `site: K11Site` and build the payload with `k11Payload`.
- Call sites: `:2382` passes `"publish"`, `:2433` passes `"git-task"`, and `:2973` passes `kind` (still `"merge"` or `"protected-push"`).
- Keep the 30 s claim timeout.

**S3.** `workflow/index.ts`, K14:
- Add a module-level `endFlowFlag = { on: false }`.
- Change `endFlow(ctx)` to `endFlow(ctx, how: "finished" | "stopped")`. Its whole body runs inside `withEndFlow(endFlowFlag, how, emitFlowEnd, …)`.
- `emitFlowEnd(how)` emits `workflow:flow-end` with `flowEndPayload(state.planDoc?.flowId, how)` inside `try/catch` (model: `emitStatus`, `:531-549`). It runs before any `setPhase`, so `planDoc` and `flowId` are still set.
- Update the 8 callers as listed in Facts.
- In `setPhase` (`:614`), before the `leavingFlow` summary at `:616`: compute `flowEndKind({ from: state.phase, to: phase, viaEndFlow: endFlowFlag.on })` and emit `abandoned` when it returns that.

**S4.** `workflow/README.md`:
- K11 (`:250`): add `ask` with its meaning, which site sends which value, and that a missing `ask` means `"pre"`.
- Add **K14** after K13 (`:253`): the payload, when it fires (normal end and Stop through `endFlow`; `abandoned` on `/flow off` or `/flow discuss` out of `execute`; nothing on a replan or `/flow plan`), and that it comes before the phase change.

**S5.** Tests:
- `workflow/hooks.test.ts`:
  - the `flowEndKind` table: execute→discuss and execute→off give `abandoned`; execute→plan gives `null`; any move with `viaEndFlow` gives `null`; non-execute moves give `null`;
  - `withEndFlow` emits before the body runs, the body's `setPhase` sees `on = true`, and the flag is `false` afterwards, also on the quick-flow path (a body that calls `setPhase` back to its start phase) and when the body throws;
  - `k11Payload` and `K11_SITES` (`git-task` gives `pre` with kind `merge`, the others give `gate`);
  - `flowEndPayload`.
- New `workflow/k11-sites.test.ts`, reading `index.ts` as text the way `ui-guard.test.ts` does: exactly 3 `acceptanceProblem(` calls besides the definition, with first arguments `"publish"`, `"git-task"` and `kind`; and every `endFlow(ctx` call passes `"finished"` or `"stopped"`.

**S6.** `docs/workflow-improvements.md`, following its section "Keeping this file current":
- Add **D41**: confirming merges by delivered trees, K11 `ask`, K14 `flow-end`, gh calls pinned with `-R`. **Done (stage 1):** the workflow contracts.
- Add idea rows **D42** (the false "stage ended with no changes" menu after a merge note), **D43** (duplicate wait reminders escalated; check against f452a88 first) and **D44** (pin `gh pr merge` to the gate's head with `--match-head-commit`).
- Update the Status line and add Effect measurement rows for D41 to D44.

**S7.** Run the workflow tests (see Tests), then commit and push. The stage ends here.

### Stage 2: Orchestrate delivery check, wiring, docs, install

**S8.** New `orchestrate/delivery.ts` with every function from the Design. Model the pure style on `repos.ts` and `monitor.ts`.

**S9.** `orchestrate/store.ts`: add `readMerges(file)` and `appendMerges(file, records)`, modelled on `readAccepted` and `addAccepted` (`:169-180`, `writeAtomic`). `brief.ts` `Sub`: add the new fields with doc comments, and update the `endedAt` comment.

**S10.** `orchestrate/index.ts`, sub side:
- Delete the phase-change post at `:227`, along with `prevPhase` and `prevFlowId` if they become unused, but keep `writeMyStatus()`.
- Add `pi.events.on("workflow:flow-end", …)`. It starts with `if (!me || !started) return;` and then calls `post("flow-ended", \`flow ${how}\`, { flowId, how })`.
- In `handleMergeGate`, read `d.ask` and `d.kind`, record whether `d.tree` was given, and delegate to `mergeGateDecision`. Post `merge-pass` or `accept-request` from its result. The worktree-key logic and the `requestedTrees` token stay as they are.

**S11.** `orchestrate/index.ts`, `readOutboxes`:
- For each sub, run `applyOutbox(r.msgs)`. Append its `merges` to `<sub>/merges.json` right away, inside the loop and before any check. Push `end` into `ended`, de-duplicated per sub.
- Handle `rest` with the existing branches, minus the `flow-ended` branch. The `accept-request` event names the kind when it isn't `merge`.
- In the `ended` mutate, overwrite `endedAt = end.at` and `endHow`, and set `endChecks = 0` and `endReported = false`.
- Run `checkEnded(false)` when anything ended.

**S12.** `orchestrate/index.ts`, `checkEnded`, `mergedPerRepo`, `ghMerged`:
- Rewrite `checkEnded(manual, only?, force?)` as one serialised round. A sub is checked when it is in `only` (manual) or when `shouldPoll(sub)`.
- Per worktree from `worktreesOf`, which gives key `""` for single-repo runs: gather the I/O inputs (count since base, dirty count from `gitRaw status --porcelain=v1 -z`, `HEAD^{tree}`), plus `lastDelivery` from `merges.json`, the inbox verdicts and `accepted.json`. Then run `deliveryMerged`, then `combineRepos`, then `endDecision`.
- This replaces the `ghMerged(o.repoCwd, …)` path at `:999` and `mergedPerRepo`. `setPr` takes each repo's result.
- `ghMerged(slug, branch)` gets `-R` and is used only as the fallback when a repo has no delivery and `sub.branch` is set.
- Actions:
  - `merge`: today's merged block (`:1009-1024`). Add the notes, set `forced` and `forcedCheck` when forced, and name the target branch in place of "the updated default branch" at `:1023`.
  - `report`: emit when `manual || !endReported`, then set `endReported`. The text is "`[id] flow <how>, not confirmed merged: <missing>`", or "could not be checked" for `null`, followed by the hint `/orch merged <id>` (`--force`).
  - `wait`: emit nothing.
- After an automatic check, set `endChecks = min(endChecks + 1, 2)`, writing only when it changes.
- Remove `reportedUnmerged`.
- Add `-R <slug>` to the default-branch lookup at `:1065`.

**S13.** `orchestrate/index.ts`, other places:
- `startWatcher`: in one mutate, give subs that have `endedAt` but no `endHow` the values `endHow = "unknown"`, `endChecks = 0` and `endReported = false`. Each such sub then gets one check.
- `/orch merged`: use `parseMergedArgs`, and pass `force` to `checkEnded(true, [id], force)`.
- `table()`: show "merged (forced)".
- `orch_accept`:
  - copy `kind` and `ask` into the verdict with `verdictPayload`;
  - apply `stateAfterVerdict` on both accept and refuse;
  - change the "has not asked" error to: "…yet: a question asking for acceptance is not a request. Tell it (orch_send) to retry its merge with gh pr merge; the merge gate sends the request."
- `orch_review_plan` description and the plan-review event text (`:949`): "refuse a plan that does not cover every stage the brief asks for".

**S14.** `orchestrate/brief.ts:229`: replace the delivery line with:
- deliver into the run's target branch;
- plan every stage of the package in one flow, and don't start a second flow unless the orchestrator tells you to resume a stopped one;
- when the brief asks for a PR per stage, merge each at that stage's `Deliver: merge` step, otherwise one PR at the end of the flow;
- the merge attempt sends the accept request, so never ask for acceptance in a question; end your turn when refused and retry after the verdict.

Update `brief.test.ts` if it asserts the old text.

**S15.** `orchestrate/README.md`:
- the outbox types (`:72`): `merge-pass`, and `how` on `flow-ended`;
- `<sub>/merges.json` in the file list;
- the new `Sub` fields;
- `kind` and `ask` on requests and verdicts (`:28`);
- `/orch merged <id> [--force]`;
- the merge rule (D1, D5, D6, D7);
- the limits:
  - one flow per package;
  - a `git_task` merge of an earlier tree is not recorded;
  - old runs: a verdict without `ask` counts as a merge, and ended subs get one check;
  - a manual `/flow plan` that never returns only surfaces through K13 idle, and `/orch merged` or `--force` closes it;
  - a head pushed after the gate needs `--force`;
  - undelivered later commits and dirty files are notes only;
  - runs without `targets` use the checkout's `@{u}` at check time;
- after an install, restart every session, subs included.

Also update the D41 row in `docs/workflow-improvements.md` to **Done** with both stages, with matching Status and Effect measurement rows.

**S16.** Tests:
- New `orchestrate/delivery.test.ts`, one test per case:
  - `mergeGateDecision`: the `"pre"` text and no request; a payload without `ask` acts as `"pre"`; a publish gate sends a request with `kind` and `ask`; a gate merge pass with a tree gives `mergePass`; a publish pass with `treeGiven: false` gives no `mergePass`; an ended run passes and posts nothing.
  - `applyOutbox`: `merge-pass` and `flow-ended` in one read; three `flow-ended` (the last wins); `merge-pass` is not in `rest`; an old `flow-ended` gives `unknown`.
  - `lastDelivery`: a newer verdict against a newer `merge-pass`, both ways; publish and `"pre"` verdicts don't count; an old verdict without `ask` counts; the `accepted.json` fallback, both single-repo and with a key; a revert to an earlier tree; a failed merge followed by a retry; `protected-push`.
  - `deliveryMerged` and `combineRepos`: merged by PR head tree; the last delivery not merged; `prUnknown` gives `null`; `protected-push`; dirty files give a note and still `ok`; a delivery with 0 commits counts as changed; dirty-only with no delivery is not changed and gets a note; a different `headTree` gives a note; no delivery with the branch fallback true, false, or no branch; multi-repo with one repo missing; key `""`.
  - `endDecision`: `finished` with `true` merges; `finished` with `false` gives `wait` at checks 0 and `report` at 1; `stopped` with `true` gives `report`; a manual check with `true` on `stopped` merges; manual `false` reports; `force` merges.
  - `shouldPoll`: finished, unmerged subs only; other ends only at `endChecks` 0.
  - `parseMergedArgs`, `verdictPayload` with `stateAfterVerdict` (accepting gives `executing`), and `parseRemoteUrl` in its three forms.
  - `pickGhRepo`: an `origin/feat/x` ref with `origin` and `upstream` remotes gives `origin`'s slug; no ref gives `origin`.
  - `pickBase` and `needsBiggerPage`.
  - `listingAction`: the same round gives `use`, another round gives `refresh`.
  - `prTreeIndex`: the `mergedAt` filter; a missing tree counts as unknown; one listing shared by two subs' lookups.
- `store.test.ts`: `readMerges` and `appendMerges` round-trip.
- New `orchestrate/wiring.test.ts`, a source scan of `index.ts`: `post("flow-ended"` appears exactly once, inside the `workflow:flow-end` handler, after `if (!me || !started) return`.
- `boundary.test.ts` passes unchanged and covers `delivery.ts`.

**S17.** Deliver: merge — the install in S19 copies the merged `master`.

**S18.** The read-only check on `o11131503`. Run it before S17's merge and record its output; it changes nothing.
- Write a throwaway script in a temp folder outside the repo, run with `node --experimental-strip-types`, that imports `delivery.ts` from the repo.
- Pull the full 40-hex trees, in order, from the orchestrator log and from both sub logs (paths in Facts). Fail when the per-package order differs between the two sources.
- Get the slug from `git -C D:/works/annamites/city-bus-flow remote -v` plus `@{u}` through `pickGhRepo` and `pickBase`.
- List with `gh pr list -R <slug> --state merged --base feat/new-gameplay --limit 200 --json number,headRefOid,mergedAt` and filter `mergedAt >= 2026-11-13T08:03:08.824Z`.
- Look up trees with `git -C … rev-parse <sha>^{tree}`.
- Feed the trees as verdicts without `ask` to `lastDelivery` and `deliveryMerged`.

Expected:
- slug `Annamites/city-bus-flow`;
- core's last delivery is the head tree of #235 and view's is the head tree of #236, each with `ok: true`;
- all 16 trees match PRs #221 to #236 on full hashes.

**S19.** The install, from the updated `master` checkout:
- Run `node bin/import.js --dry-run` and list any files it would change outside `pi/agent/extensions/{workflow,orchestrate,shared}` in the final report. Then run `node bin/import.js`.
- Check with `diff -rq pi/agent/extensions/<f> C:/Users/unkno/.pi/agent/extensions/<f>` for `workflow`, `orchestrate` and `shared`, ignoring `.bak-*`. Expect no differences.
- Tell the user to restart every pi session, the orchestrator and any running subs.

**S20.** Verify: start a new orchestra run after the restart, with a non-default target branch, in a repo where gh resolves elsewhere by default (`city-bus-flow`), and two packages, at least one delivering several `flow/*` PRs. Look for:
- **bug 2:** `run.json` has `targets`;
- **bug 1:** a worktree whose first dirty file is ` M path` shows its full path in the drift warning;
- **bug 2:** after a sub merges the target into its branch, it shows no drift or overlap for the other package's merged files;
- **bug 3:** the package stays active after its stage 1 PR merges, and shows "`[id] merged`" within about 5 s of the flow ending, or at the latest within one 60 s poll. It never shows a "not confirmed merged" or "without a merged pull request" warning, even with uncommitted files left in the worktree;
- `orch_status` shows `executing` right after you accept.

### Tests
- **Workflow:**
  - fast: `cd pi/agent/extensions/workflow && node --experimental-strip-types --test hooks.test.ts k11-sites.test.ts`;
  - full: `node --experimental-strip-types --test *.test.ts` in the same folder. It may be slow (more than 2 min); run it once per stage end.
  - Expected: 0 failures.
- **Orchestrate:** `cd pi/agent/extensions/orchestrate && node --experimental-strip-types --test *.test.ts`. Expected: 0 failures, including the new `delivery.test.ts` and `wiring.test.ts`.
- **Read-only check (S18):** the expected output is stated in S18.

### Done when
- `master` contains K11 `ask`, K14, the delivery check, the wiring, the brief and prompt wording, both READMEs and the backlog rows D41 to D44, and both test suites pass.
- The read-only check matches #235 and #236 as the last deliveries and all 16 trees to #221 to #236.
- `workflow/`, `orchestrate/` and `shared/` are installed, and `diff -rq` shows no differences.
- Your live run (S20) shows no clipped paths, no false drift or overlap, a package that stays active after stage 1, and "merged" once all its deliveries are merged, with no false "not merged" warning.

### Risks, rollback, what not to touch
- **Risk: installing only part of the change.** If only orchestrate is updated, every merge gate is refused, because a payload without `ask` counts as `"pre"`. S19 installs all three folders together, and the README says so.
- **Risk: old sub sessions.** They post `flow-ended` without `how` and are only reported. Every session must restart.
- **Rollback:** revert the PR and run `node bin/import.js` again, or restore the `.bak-*` files.
- **Don't touch:**
  - the drift and diff-base code (bugs 1 and 2: `gitRaw`, `diffBase`, `pickDiffBase`);
  - `addAccepted` (no reordering);
  - the merge-gate judge logic in `workflow/merge-gate.ts`;
  - the stage-empty and wait code (D42, D43).

### Commits
- Stage 1: `workflow: K11 ask field and K14 flow-end event`: `workflow/hooks.ts`, `hooks.test.ts`, `k11-sites.test.ts`, `index.ts`, `README.md`, `docs/workflow-improvements.md`.
- Stage 2:
  - `orchestrate: confirm merges by delivered trees, pinned to the target repo`: `orchestrate/delivery.ts`, `delivery.test.ts`, `wiring.test.ts`, `store.ts`, `store.test.ts`, `brief.ts` (the `Sub` type), `index.ts`, `README.md`, `docs/workflow-improvements.md`.
  - `orchestrate: state after accept, one-flow brief, review and accept hints`: `brief.ts` (`:229`), `brief.test.ts`, `index.ts` (`orch_accept`, `orch_review_plan`).

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 `workflow/hooks.ts`: add `K11Site`, `K11_SITES`, `k11Payload`, `flowEndKind`, `flowEndPayload` and `withEndFlow` as in t
- [ ] S2 `workflow/index.ts`, `acceptanceProblem` (`:3013`):
- [ ] S3 `workflow/index.ts`, K14:
- [ ] S4 `workflow/README.md`:
- [ ] S5 Tests:
- [ ] S6 `docs/workflow-improvements.md`, following its section "Keeping this file current":
- [ ] S7 Run the workflow tests (see Tests), then commit and push. The stage ends here.
- [ ] S8 New `orchestrate/delivery.ts` with every function from the Design. Model the pure style on `repos.ts` and `monitor.ts`.
- [ ] S9 `orchestrate/store.ts`: add `readMerges(file)` and `appendMerges(file, records)`, modelled on `readAccepted` and `addAcc
- [ ] S10 `orchestrate/index.ts`, sub side:
- [ ] S11 `orchestrate/index.ts`, `readOutboxes`:
- [ ] S12 `orchestrate/index.ts`, `checkEnded`, `mergedPerRepo`, `ghMerged`:
- [ ] S13 `orchestrate/index.ts`, other places:
- [ ] S14 `orchestrate/brief.ts:229`: replace the delivery line with:
- [ ] S15 `orchestrate/README.md`:
- [ ] S16 Tests:
- [ ] S17 Deliver: merge — the install in S19 copies the merged `master`.
- [ ] S18 The read-only check on `o11131503`. Run it before S17's merge and record its output; it changes nothing.
- [ ] S19 The install, from the updated `master` checkout:
## For you after the flow
- S20 Verify: start a new orchestra run after the restart, with a non-default target branch, in a repo where gh resolves elsew
