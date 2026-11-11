<!-- pi-workflow plan v1 flow=20261111-1014-orchestrator-mode-multi-repo-packages-an-109e -->
## Plan: Orchestrator mode, multi-repo packages and a run visualizer for `orchestrate`

Stages: 1. Orchestrator mode: `/orch` starts a read-only discussion, `go` asks for a package proposal, and a second `go` creates the run. 2. Multi-repo: packages can span the session's added folders, and drift, overlap, acceptance and PR checks run per repo, using a W1 extension in worktree. 3. Visualizer: `view.json`, a live widget, the `/orch board` overlay and a status line in sub-sessions.

### Goal
- `/orch` works like `/flow`. It opens a read-only discussion. A typed `go` makes the agent propose packages. A second `go` on a finished proposal creates and spawns the run. The orchestrator never edits code itself unless the user lifts the guard with `/orch off`.
- One run can cover the working repo and the repos added with `/folders`. Each package names its repos. Each package gets worktrees only for those repos. Drift, overlap, acceptance and merge checks run per repo.
- The run's state is visible live: a widget in the orchestrator session, an `/orch board` overlay, and a status line in each sub-session.

### Non-goals
- No HTML or browser view, and no dependency graph drawing.
- No lock across runs. Overlap across runs is only warned about, once, at `orch_run`.
- No change to how the workflow handles phases. Orchestrate does not drive the workflow's discuss phase.
- No `Library/` copy for Unity (A42 stays an idea).
- No continuous detection across runs while polling.

### User decisions
- D1: `/orch` enters a read-only discussion. That is bare `/orch` when there is no run and the mode is off, or `/orch start`. Nothing is implemented unless the user explicitly says so. `/orch off` is that explicit step: it leaves the mode. (Recommended in the discussion and accepted with "ok go".)
- D2: The first typed `go` moves on to the package proposal, which is still read-only. A second `go` on a finished proposal unlocks `orch_run` and `orch_spawn`.
- D3: The orchestrator session stays read-only for the whole run. This is enforced by code, not only by the prompt. `workflow/readonly-tools.ts` moves to `shared/` so both extensions use the same checks.
- D4: `/orch start` is refused unless the workflow phase is `off`.
- D5: Multi-repo:
  - paths are prefixed with a repo key (`api:src/**`); a path with no prefix means the working repo;
  - drift, overlap, acceptance and the PR merged check run per repo;
  - W1 reports the worktree of each repo.
- D6: Packages choose their repos, and W1 accepts a subset of the added folders. The user accepted the worktree cost.
- D7: Runs that share a repo are not locked against each other. At `orch_run`, the session warns about owned paths that overlap with active runs found in any repo of the session. The user can continue anyway.
- D8: The visualizer is a live TUI widget in the orchestrator session plus an `/orch board` overlay. The watcher writes `view.json`. No HTML.
- D9: Sub-sessions show a status line naming their package and what they wait for. (Offered in the discussion and accepted with "ok go".)

Merge points: none. The flow ends in one merged PR.

### Facts the executor needs
- **Orchestrate extension:**
  - `orchestrate/index.ts` holds both roles (sub-session and orchestrator).
  - `orch_run` is at `:533-570`. It needs a git repo, allows one active run per common dir (`:541-544`), and starts the watcher with `repoCwd: ctx.cwd` (`:567`).
  - `orch_spawn` is at `:572-620`. It emits W1 at `:597` and stores `cwd`, `branch` and `base` at `:603-608`.
  - The `/orch` command is at `:715-757`. `session_start` is at `:770-827`. The sub-session finds itself by its git top level at `:790` and `:801`.
- **Single-repo assumptions to replace:**
  - `ghMerged` uses `repoCwd` (`index.ts:326-335`).
  - `checkEnded` is at `:387-420`.
  - `diffBase` takes one `defaultBranch` for the whole run (`:420-440`).
  - `pollGit` uses only `sub.cwd` (`:442-500`).
  - K11 `workflow:merge-gate` uses one tree per sub (`:168-190`).
  - `orch_accept` compares against `sub.cwd` (`:684-713`).
  - The accept-request event text is at `:352-354`.
- **Package model:**
  - `brief.ts:5-31` defines `Sub` and `Run`.
  - `validatePackages` is at `:41-64`. Its owned-glob duplicate check is at `:53-61`.
  - `renderBrief` is at `:119-146` and `kickoffText` at `:148-161`.
  - `SET_NAME_RE` at `:37-38` is a precedent for copying a worktree regex with a comment.
- **Paths and monitoring:**
  - `paths.ts` has `globToRegExp`, `matchesAny` and `outsideOwned`. A literal `:` in a glob is matched literally.
  - `monitor.ts` is pure. Its `check()` compares file strings, so `key:path` canonical strings work without changes.
- **Store and config:**
  - `store.ts`: `readAccepted` and `addAccepted` store strings (`:162-175`); `norm` is at `:33`; `findSubByToplevel` is at `:176`.
  - `config.ts:6-53` has `DEFAULTS` and `parseConfig`, with the bad-value-falls-back-with-warning pattern.
- **Read-only checks (`workflow/readonly-tools.ts`):**
  - Exports `PLAN_TOOLS`, `planToolRefused`, `phaseToolRefusal` and `planToolProblem`.
  - Its only import is `../shared/readonly-bash.ts`.
  - It is imported by `workflow/config.ts:11`, `workflow/index.ts:71`, `workflow/plan-tools.test.ts:5` and `workflow/readonly-tools.test.ts:4`.
  - It is mentioned in `workflow/README.md:216`, `:227` (test command) and `sandbox/README.md:12`.
  - `shared/boundary.test.ts` forbids `../` imports from shared files.
  - `orchestrate/boundary.test.ts` forbids imports from `../workflow/` or `../worktree/`.
- **Workflow patterns to model on (copy, never import):**
  - The tool gate: `workflow/index.ts:2812-2818`, including the `powershell` refusal.
  - The `input` hook for "go": `:2986`, `:3020-3025`. It skips `event.source === "extension"` and `event.streamingBehavior`.
  - `approveRe`: `:2977-2983`. The default `approvePattern` is at `workflow/config.ts:191`.
  - `agent_end` with the last assistant message and `stopReason === "stop"`: `:3121-3145`.
  - `ENDS_IN_QUESTION`: `workflow/agent-end.ts:71`.
  - Prompt sections: `event.systemPromptOptions.sections` is a `Record<string,string>` (pi `system-prompt.d.ts:44`). The workflow always sets its sections so pi's patch replay stays stable (`workflow/index.ts:2741-2754`).
  - The text of the discuss prompt: `workflow/prompts.ts:92-103`.
- **TUI patterns:**
  - The widget mount: `workflow/view.ts:224-246` (`ui.setWidget(key, (tui, theme) => component)`).
  - The overlay with a 2 s refresh and up/down/confirm/cancel keys: `workflow/index.ts:4183-4230` (`/flow board`).
- **K1 `session-folders` entry:**
  - Read the newest custom entry from `ctx.sessionManager.getBranch()`. It must have `v === 1`; folders are absolute, with forward slashes.
  - Reference implementation: `worktree/folders.ts:1-12`.
- **Worktree, W1:**
  - `worktree/create-event.ts:5-12` parses `{ v, name }`.
  - `collect()` at `worktree/index.ts:120-136` builds the repos from the working top plus `addedFolders(ctx)`.
  - `createSet` at `:200-250` builds `pre.plan`, whose items carry `info.top` and `target`. It returns `Created` (`:176-189`).
  - The W1 listener answers at `:882-913`, with the answer built at `:906`.
  - The contract text is at `worktree/README.md:152`.
- **Backlog doc:** orchestrate is backlog item A41 in `docs/workflow-improvements.md:71` (effect row `:254`). The last A id is A42. The doc has a Status line (`:5`) and an Effect measurement table (`:148+`).
- **Test commands:** each README lists its test command (orchestrate README "Tests", `workflow/README.md:227`, `worktree/README.md:182`, `shared/README.md:16`). Tests run with `node --experimental-strip-types --test <files>` from the extension folder.

### Design
**Mode (stage 1):**
- **The mode value:** `type Mode = "off" | "discuss" | "propose" | "run"`, held in the orchestrator session only.
- **Persistence:** the mode is persisted as a custom entry `orchestrate-mode` `{ v: 1, mode }` with `pi.appendEntry`, written on every change. It is restored at `session_start` from the newest entry. A sub-session always uses `off`.
- **Transitions:**
  - `off` → `discuss`: bare `/orch` (no watched run, mode off) or `/orch start`.
  - `discuss` → `propose`: a typed go (the go pattern). The input is transformed to append `PROPOSE_KICKOFF`.
  - `propose` → `run`: a typed go when `proposalReady` is set. The input is transformed to append `RUN_KICKOFF`.
  - Any mode → `off`: `/orch off`, or `/orch end`.
  - `/orch watch` sets `run`.
  - Other typed text in `propose` keeps `propose`, and the model revises the proposal.
- **`proposalReady`** is set at `agent_end`. The last assistant reply must have stopped normally, contain a heading line matching `^#+\s*Packages\b`, and not end on a question (copy of `ENDS_IN_QUESTION`). Any new typed message resets it.
- **The go pattern:** the new config key `approvePattern` in `orchestrate.json`. Its default is a copy of the workflow's default string, with a comment naming `workflow/config.ts`. A bad regex falls back to the default with a warning.
- **Enforcement:** a `tool_call` hook. The refusal reason says the mode and that `/orch off` lifts the guard.
  - Mode `off`: nothing is refused.
  - Otherwise, `orch_run` and `orch_spawn` are refused unless the mode is `run`.
  - `orch_status`, `orch_send`, `orch_review_plan`, `orch_accept` and `ask_orchestrator` are allowed by name.
  - `powershell` is refused.
  - Every other tool goes through `planToolRefused(name, PLAN_TOOLS regexes, [])` and then `planToolProblem(name, input, [])` from `shared/readonly-tools.ts`.
  - Orchestrate does **not** call `setActiveTools`, so it cannot fight the workflow over the tool list.
- **Conflict with the workflow:** `/orch start` is refused when the last K4 phase is not `off`. If K4 later reports a phase other than `off` while the mode is on, notify a warning once and keep the guard.
- **Prompt:** `before_agent_start` always sets `sections.orchestrate`, to an empty string when the mode is off. In the other modes it holds the stage text from a new `orchestrate/prompts.ts`:
  - **discuss:** read only; discuss and push back; end each reply with `Agreed so far:`; a typed `go` moves to the package proposal; `/orch off` is the only way to change things yourself.
  - **propose:** write `## Packages: <title>` with one `### <id>` per package (goal, criteria, repos, owns with repo keys, forbids, dependsOn, decisions). No tool calls that change things. A typed `go` approves.
  - **run:** call `orch_run` with exactly the approved packages, then `orch_spawn` the ready ones. How to handle each watcher event. Stay read-only.
  - From stage 2 on, the propose and run texts include the repo-key table (key → path).

**Multi-repo (stage 2):**
- **Repo keys:**
  - The working repo top (git `--show-toplevel` of `ctx.cwd`) plus the top of every K1 added folder that is a git repo, with duplicates removed.
  - key = lowercased basename with characters outside `[a-z0-9._-]` replaced by `-`.
  - A key collision is an `orch_run` error that names both paths.
- **Run data:** `Run.repos?: Array<{ key: string; top: string }>`, working repo first. `v` stays 1, and the field is optional.
  - A legacy run without `repos` has working key `""`.
  - Canonical path form: `${key}:${path}` when the key is not empty, else `path`. Legacy runs keep their exact behaviour.
- **Package input:**
  - `owns` and `forbids` entries are `key:glob` or `glob` (a glob with no prefix means the working repo).
  - The optional new field `repos?: string[]` lists extra repo keys to include for reading.
  - Validation: an unknown key is an error. The duplicate-owner check uses the canonical form.
- **Sub data:**
  - `Sub.repos: string[]` = working key ∪ keys used in owns ∪ extra keys.
  - `Sub.worktrees?: Array<{ key: string; cwd: string; base?: string }>`.
  - `sub.cwd` and `sub.base` stay for the working repo, because `findSubByToplevel` uses them.
  - A helper `worktreesOf(sub, run)` returns `worktrees`, or `[{ key: workingKey, cwd: sub.cwd, base: sub.base }]` for a legacy sub.
- **W1, compatible change (stays `v: 1`):**
  - The payload gains `folders?: string[]`. When it is present, only the session's added folders that are in it go into the set. Comparison uses forward slashes, no trailing slash, and is case-insensitive on Windows. The working repo is always included. Unknown entries are ignored.
  - The answer gains `repos: Array<{ top: string; cwd: string }>` for every git repo in the set: `top` is the original checkout's top level, `cwd` is its worktree root, both with forward slashes.
  - Orchestrate sends `folders`: the K1 added folders that are plain folders, plus those whose repo key is in `sub.repos`.
  - If the answer has no `repos` (old worktree extension), only the working repo is watched and the spawn line says so. A needed repo missing from the answer adds a warning line to the spawn result.
- **Acceptance per repo:**
  - K11 maps `d.cwd` to its git top level, then to the matching worktree key. An unknown repo returns `{ problem }`, telling the sub-session that this repo is not in its package.
  - accept-request data is `{ tree, repo }`. The dedupe key is `repo:tree`.
  - `orch_accept` takes the optional param `repo`; the default is the repo of the latest accept-request. It checks against `HEAD^{tree}` of that repo's worktree and stores `"<key>:<tree>"` in `accepted.json` (a key of `""` stores the bare tree).
  - The accept-verdict data is `{ accept, tree, repo }`.
  - The sub-session accepts a verdict whose tree matches and whose `repo` matches. A missing `repo` counts as the working key, so legacy verdicts still match.
- **Drift and overlap:**
  - `pollGit` goes over every worktree of a sub and collects canonical files. The snapshot `head` is all worktree heads joined, and `porcelainHash` covers all porcelain output.
  - `diffBase` works per worktree. The default-branch cache is keyed by repo, and `gh repo view` runs in that repo's `Run.repos[].top`.
- **Merged:**
  - A repo is *touched* when its worktree has commits since its spawn `base` (`rev-list --count base..HEAD > 0`) or is dirty.
  - A sub is merged when at least one repo is touched and every touched repo has a merged PR for `branch`. `gh pr list` runs in that repo's top.
  - Report lines name the repos that are missing a merge. A touched repo that is only dirty is reported as "uncommitted changes in <key>".
- **Warning across runs:**
  - At `orch_run`, for every repo in `Run.repos` other than the working one, read `listActiveRuns(commonDir(top))`.
  - For each such run's subs that are not merged or stopped, resolve their owns to repos: their key → their `repos[].top`; for a legacy run, key `""` → the repo being scanned. Compare those with the new packages' owns in the same repo (`norm` of the tops) using a pure `globsMayOverlap(a, b)` in `paths.ts`. Two globs may overlap when their literal prefixes up to the first wildcard are equal, or one is a path-segment prefix of the other.
  - If any overlap is found, `ctx.ui.select("…overlaps…", ["Create anyway", "Cancel"])`. Cancel throws an error listing the overlaps.
  - The limit is one-sided detection, as discussed.

**Visualizer (stage 3):**
- **`view.json`:** `<run>/view.json` is written by the watcher (the only writer) after each `readOutboxes` and `pollGit` cycle, with tmp + rename, and only when the content changed.
  - Shape: `{ v: 1, runId, title, updated, subs: [{ id, state, phase, done?, total?, waiting, heartbeat?, dependsOn, repos: [{ key, files: number, drift: string[], pr?: "merged"|"not merged"|"unknown" }], overlap: string[], pending: [{ kind: "question"|"plan"|"accept", ref, text }], recent: [{ dir: "in"|"out", type, text, ts }] }] }`.
  - `pending` is computed from the full outbox and inbox:
    - a question is pending until an `answer` with that `replyTo` arrives;
    - plan n until a `plan-verdict` with `n` arrives;
    - an accept-request tree until an `accept-verdict` with that tree (and repo) arrives.
  - `recent` holds the last 5 messages each way.
  - PR state is the last known result per sub and repo from `checkEnded`, kept in memory.
- **Pure module `orchestrate/view.ts`:** `buildView(...)`, `pendingOf(outbox, inbox)`, `widgetLines(view|null, mode, now, paint)` and `boardLines(view, selected, detail, width, now, paint)`, where `paint(kind, text)` adds color. These are the pure pieces under test.
- **Widget `orchestrate`:**
  - In modes `discuss` and `propose`, one header line: `orch ▸ discuss` or `▸ propose`.
  - In `run`, the header `orch <runId> ▸ run  n/maxSubs running`, then one row per package: id, repos, state, phase and done/total, a pending marker (`? question`, `plan n review`, `⚠ accept <repo> <tree7>`), changed files per repo, drift and overlap flags, `offline`/`stalled`, and `(after a,b)`.
  - The widget is removed (`setWidget(key, undefined)`) when the mode is off and no run is watched. It re-renders when `view.json` is written.
- **`/orch board`:**
  - An overlay that re-reads `view.json` every 2 s: a list on the left, details of the selected package on the right (goal, criteria, owns per repo, recent messages, files per repo, PR per repo, accepted trees).
  - It works in any session of the repo that has an active run.
  - Without a TUI it falls back to `notify` with the board lines.
- **Sub-session status line:** `ctx.ui.setStatus("orchestrate", …)`. The text is `orch <runId>/<subId>` plus ` · waiting for orchestrator: plan review | answer | acceptance` when a K10 promise is open, an ask is pending, or an accept-request was sent without a verdict. It is updated whenever any of these change.

**Scale:** 2–4 subs × up to about 3 repos is about 12 worktrees. Each poll runs about 5 git calls per worktree (about 60 per minute), and `gh` runs only after a flow ended. `view.json` is a few KB and written at most every 5 s. The design stops working well at about 10 repos per sub: a poll cycle then takes several seconds, but the `every()` busy guard keeps cycles from overlapping.

**Rejected alternatives:**
- Driving the workflow's discuss phase: two owners for phase changes and for "go".
- Gating with `setActiveTools`: it conflicts with the workflow's tool filtering.
- Having orchestrate read `.pi-set.json`: that is a private worktree file.
- An explicit `repos` field required on every package: redundant with the owns prefixes, so it stays optional and only for reading.
- An HTML view: it is static and needs a CDN.

**Failure handling:**
- A missing worktree for a repo, or an unreadable `view.json`: notify, and render "-" in the view.
- An old worktree extension: the run works for the working repo only.
- A corrupt `orchestrate-mode` entry: the mode falls back to off.

### Steps

### Stage 1: Orchestrator mode
**S1.** Move `workflow/readonly-tools.ts` to `shared/readonly-tools.ts`, and `workflow/readonly-tools.test.ts` to `shared/readonly-tools.test.ts`.
- Change its import to `./readonly-bash.ts`.
- Update the imports in `workflow/config.ts:11`, `workflow/index.ts:71` and `workflow/plan-tools.test.ts:5` to `../shared/readonly-tools.ts`.
- Update the test commands in `workflow/README.md:227` and `shared/README.md:16`, the mentions in `workflow/README.md:216` and `sandbox/README.md:12`, and add a row to the file table in `shared/README.md` (users: workflow, orchestrate).
- The behaviour must not change.

**S2.** Add `orchestrate/mode.ts`, pure, with:
- `Mode`
- `modeFromEntries(entries)` (newest `orchestrate-mode` entry, `v: 1`, a valid mode, else `"off"`)
- `onTyped(mode, text, proposalReady, goRe): { mode: Mode; append: string } | null`: the transitions above. Returns null for no change.
- `isProposalReady(text, stoppedNormally)`
- `toolRefusal(mode, name, input): string | null`: the rules above, using `shared/readonly-tools.ts`.

**S3.** Add `orchestrate/prompts.ts` with `DISCUSS`, `PROPOSE`, `RUN`, `PROPOSE_KICKOFF` and `RUN_KICKOFF`, and `section(mode, repoTable?)`. Model the wording on `workflow/prompts.ts:92-103`.
- `PROPOSE_KICKOFF`: "The discussion is over. Propose the work packages now as `## Packages: <title>` …; change nothing."
- `RUN_KICKOFF`: "The user approved these packages. Call orch_run with exactly them, then orch_spawn the ready ones."

**S4.** In `config.ts`, add `approvePattern` (the default copied from the workflow, with a comment). A regex that does not compile is a bad value: fall back to the default with a warning.

**S5.** Wire the mode in `orchestrate/index.ts`:
- State: `mode` and `proposalReady`. Restore at `session_start` through `modeFromEntries`.
- `setMode(m)` persists the entry and notifies the user.
- `before_agent_start` always sets `sections.orchestrate`.
- The `tool_call` hook uses `toolRefusal`. It does nothing in a sub-session.
- The `input` hook uses `onTyped` with the same source and streaming guards as `workflow/index.ts:3021`, then returns `{ action: "transform", text: typed + "\n\n" + append }`.
- `agent_end` sets `proposalReady` (model on `workflow/index.ts:3121-3145`).
- A K4 warning once when the workflow leaves `off` while the mode is on.
- `/orch`:
  - bare: status when a run is watched; start when the mode is off and no run is watched; else a notify naming the mode and the next step.
  - `start [title]`: refused in a sub-session, when the K4 phase is not `off`, or when an active run exists in this repo (suggest `/orch watch`).
  - `off`: the mode becomes off; the watcher keeps running and the notify says so.
  - `end` also sets the mode off; `watch` sets `run`.
  - Update the completions and the usage text.
- `orch_run` throws "approve the packages first (/orch, then go)" unless the mode is `run`. This is enforced in the hook; also check inside `execute`.

**S6.** Update `orchestrate/README.md` (Usage: `/orch` → discuss → go → propose → go → run, `/orch off`, the `approvePattern` config, the read-only rule) and its test command.

**S7.** In `docs/workflow-improvements.md`, add row A43 (orchestrator mode with a read-only discussion and proposal; readonly-tools moved to `shared/`) as **Done**, add it to the Status line, and add its Effect measurement row. Per the AGENTS.md rule, this goes in the same commit as S1.

### Stage 2: Multi-repo packages
**S8.** In worktree W1:
- `create-event.ts` `parseCreate` accepts an optional `folders` array of strings. A non-array is an error.
- Add a pure `keepFolders(added, only)` (in `folders.ts`) with the normalisation rules above.
- `collect()` (`index.ts:120`) takes an optional `only`, filtering `addedFolders(ctx)` through it.
- `createSet` passes it on, and `Created` gains `repos: {top, cwd}[]` from `pre.plan` (`info.top`, `target`, forward slashes).
- `createAndLaunch` passes it through, and the W1 answer (`index.ts:906`) includes `repos`.
- `/wt new` behaviour does not change.
- Update the W1 text in `worktree/README.md:152`.

**S9.** Add `orchestrate/folders.ts`, which reads K1 (a copy of `worktree/folders.ts` logic with a comment), and `orchestrate/repos.ts` (pure):
- `repoKey(top)`
- `buildRepos(workingTop, addedTops) → { repos, error? }`, which reports collisions
- `canonical(glob, repos, workingKey) → { value } | { error }`
- `split(canonical) → { key, path }`
- `subRepos(pkg, workingKey)`
- `foldersFor(sub, added, keyOfFolder)`
- `worktreesOf(sub, run)`

**S10.** In `brief.ts`:
- Add `Run.repos?`, `Sub.repos`, `Sub.worktrees?`, and `PackageInput.repos?`.
- `validatePackages(pkgs, repos?)` canonicalises owns and forbids, rejects unknown keys and unknown extra repos, and runs the duplicate check on canonical values. It returns errors or the canonical packages. Keep its error-list style.
- `renderBrief` gets a `## Repos` section (key → orchestrator checkout path; "your worktree of each is in your session's folders").
- `kickoffText` lists `key → worktree path` when `sub.worktrees` is set.

**S11.** In `paths.ts`, add `globsMayOverlap(a, b)` (pure, case-insensitive, canonical globs).

**S12.** Orchestrate `index.ts` multi-repo:
- `orch_run` builds `Run.repos` (via K1 + `rev-parse --show-toplevel`), validates with them, and runs the cross-run warning (D7).
- `orch_spawn` sends W1 `folders` and maps the answer's `repos` to `Sub.worktrees`. Each worktree gets `cwd` = normalised git top level and `base` = its HEAD.
- `pollGit` works per worktree with canonical files.
- `diffBase(sub, wt)` caches the default branch per key.
- `ghMerged(cwd, branch)` and `checkEnded` follow the "touched repos" rule.
- The accept-request event text points at the requested repo's worktree.
- K11 and `orch_accept` work per repo, per the acceptance contract above.
- The `orch_accept` schema gains `repo?`.
- Legacy runs (no `repos`) behave exactly as before.

**S13.** Update the orchestrate README: the `key:glob` format, the `repos` field, per-repo checks, the W1 fields used, cross-run warnings and their one-sided limit, and the limit that a repo added inside a sub-session with `/folders add` is not watched. In `docs/workflow-improvements.md`, add A44 (multi-repo runs) as Done, plus the Status line and Effect row.

### Stage 3: Visualizer
**S14.** Add `orchestrate/view.ts` (pure) as designed: `buildView`, `pendingOf`, `widgetLines` and `boardLines`.

**S15.** In `store.ts`, add `viewPath(common, runId)` and `writeView` / `readView` (tmp + rename via `writeAtomic`; reading returns `{ view?, corrupt? }`).

**S16.** In orchestrate `index.ts`:
- The watcher builds the view after `readOutboxes` and `pollGit` and writes it when it changed. Snapshots keep per-repo file lists, so derive them from canonical files by key. PR states go into a map filled by `checkEnded`.
- Mount the widget like `workflow/view.ts:224-246` and re-render on every change of mode or view.
- `/orch board` follows `workflow/index.ts:4183-4230`, with the same keys and a non-TUI fallback.
- Add `board` to the completions and usage.
- Sub-session `setStatus("orchestrate", …)` is updated when `k10`, `pendingAsk` or the accept-request state changes, and at `become`.

**S17.** Update the orchestrate README (Visualizer section, the `view.json` row in Files). In `docs/workflow-improvements.md`, add A45 (run visualizer) as Done, plus the Status line and Effect row.

### Tests
Run from each extension folder:
- shared: `node --experimental-strip-types --test claims.test.ts readonly-bash.test.ts readonly-tools.test.ts tokens.test.ts runs.test.ts roles.test.ts boundary.test.ts`
- workflow: the README:227 command, with `readonly-tools.test.ts` removed from it.
- worktree: the README:182 command.
- orchestrate: `node --experimental-strip-types --test config.test.ts paths.test.ts brief.test.ts store.test.ts monitor.test.ts inbox.test.ts boundary.test.ts mode.test.ts repos.test.ts folders.test.ts view.test.ts`. List only the files that exist at each stage.

Every command must pass with 0 failures.

New and changed tests:
- **Moved readonly-tools tests:** `shared/readonly-tools.test.ts` contains the moved tests, unchanged. `shared/boundary.test.ts` still passes.
- **`orchestrate/mode.test.ts`:**
  - `onTyped`:
    - off + "go" → null.
    - discuss + "go" → propose, with `PROPOSE_KICKOFF` appended.
    - discuss + "ok go" → propose.
    - propose + "go" with `proposalReady` false → null.
    - propose + "go" with `proposalReady` true → run, with `RUN_KICKOFF` appended.
    - run + "go" → null.
    - discuss + "fix it" → null.
  - `isProposalReady`:
    - `"## Packages: x\n### a"` stopped → true.
    - The same text ending with "?" → false.
    - Without a heading → false.
    - Not stopped → false.
  - `toolRefusal`:
    - off + edit → null.
    - discuss + edit → refused.
    - discuss + bash `git commit -m x` → refused.
    - discuss + bash `git status` → null.
    - discuss + `orch_run` → refused.
    - run + `orch_run` → null.
    - run + write → refused.
    - propose + `orch_status` → null.
    - powershell → refused in any mode except off.
  - `modeFromEntries`: newest entry wins, a bad payload → off.
- **`config.test.ts`:** a bad `approvePattern` → the default and a warning.
- **`orchestrate/boundary.test.ts`:** unchanged, must pass. The new files import only `../shared/`.
- **Worktree:**
  - `create-event.test.ts`: `folders` accepted, a non-array `folders` → error, absent → no field.
  - `folders.test.ts`, `keepFolders`: Windows case and trailing slashes; unknown entries ignored; `only` undefined keeps all.
- **`orchestrate/repos.test.ts`:**
  - `repoKey("D:/w/My Api")` → `my-api`.
  - A collision → error.
  - `canonical`:
    - `"src/**"` with working key `api` → `api:src/**`.
    - `"web:src/**"` → kept.
    - `"zzz:x"` → error.
    - legacy working key `""` → `src/**`.
  - `subRepos` unions owns keys, the working key and extras.
  - `worktreesOf` handles a legacy sub.
  - `foldersFor` keeps plain folders and needed repos and drops the others.
- **`brief.test.ts`:**
  - Canonical duplicate across forms (`src/**` vs `api:src/**`, working key api) → a "both own" error.
  - Unknown repo key → error.
  - `renderBrief` has `## Repos`.
  - `kickoffText` lists worktrees.
  - Existing tests still pass with the no-repos (legacy) call.
- **`paths.test.ts`, `globsMayOverlap`:**
  - `api:src/**` vs `api:src/a/*.ts` → true.
  - `api:src/**` vs `api:docs/**` → false.
  - `api:src/**` vs `web:src/**` → false.
  - `api:**` vs anything in `api` → true.
  - `api:src` vs `api:srcx/**` → false.
- **`monitor.test.ts`:** add a case with canonical files: drift on `web:package.json` when owns are `api:**`, and overlap between subs on the same canonical file.
- **`store.test.ts`:** `writeView` / `readView` round trip, corrupt file → `corrupt`.
- **`orchestrate/view.test.ts`:**
  - `pendingOf`: a question answered or unanswered; plan 2 pending after a verdict for plan 1; accept pending until a verdict with the same tree and repo.
  - `buildView` groups canonical files per repo.
  - `widgetLines`:
    - mode discuss → 1 line containing `discuss`.
    - run with 2 subs → header + 2 rows, the row with an accept request contains `accept`, `(after a)` is shown for dependencies.
    - Lines are not wider than the width given.
  - `boardLines` detail contains the goal and owns.

Manual end-to-end (Verify step S18).

### Stage-end checks
- After stage 1, all four suites pass.
- After stages 2 and 3, the orchestrate and worktree suites pass (plus shared and workflow, unchanged).

**S18.** Verify:
- In a scratch repo with an added second repo (`/folders add`), run `/orch`, discuss, type `go` and check that a `## Packages` proposal appears and that edit and `git commit` were refused during discussion. Type `go` again and check that `orch_run` and `orch_spawn` create two packages, one per repo.
- Check that the widget shows both rows and that `/orch board` opens.
- Check that a sub-session's status line shows "waiting for orchestrator: plan review".
- Check that an accept in the second repo works.
- Check that `/orch off` lifts the guard.
- Look for: the refusals in the discuss stage, the subset of worktrees per package, the per-repo accept request, and the live widget updates.

### Done when
- `/orch` and `/orch start` enter a read-only discussion. The first `go` gives a package proposal, still read-only. A second `go` on a finished proposal unlocks `orch_run` and `orch_spawn`. Edits and writing bash commands are refused by code in every mode except `off`. `/orch off` lifts the guard. `/orch start` is refused while the workflow is not off.
- A run can own paths in the working repo and in the added repos with `key:` prefixes. Each package gets worktrees only for its repos. Drift, overlap, acceptance and the PR merged check work per repo. Legacy single-repo runs behave as before.
- `orch_run` warns about overlapping owned paths with active runs found in the session's other repos and lets the user continue or cancel.
- The orchestrator session shows a live widget. `/orch board` shows package details from `view.json`. Sub-sessions show a status line.
- All test suites listed pass. The READMEs and `docs/workflow-improvements.md` (A43–A45, Status line, Effect rows) are updated.

### Risks, rollback, what not to touch
- **Risk:** the `input` hooks of the workflow and orchestrate both see "go". This is safe because orchestrate's mode needs the workflow to be off, and the workflow ignores "go" when off. Check this order of events in S18.
- **Risk:** the `sections` patch replay. Always set `sections.orchestrate`, even when empty.
- **Risk:** a W1 field mismatch between the extensions. Both sides tolerate a missing field.
- **Rollback:** revert per stage commit. The data changes are additive and optional (`Run.repos`, `Sub.worktrees`, `view.json`), so old runs stay readable.
- **Do not touch:** workflow phase logic, the K1–K11 semantics, `shared/readonly-bash.ts`, and `/wt new` behaviour. Do not import workflow or worktree code from orchestrate.

### Commits
- Stage 1: `orchestrate: read-only orchestrator mode (/orch, go, /orch off); move readonly-tools to shared`. Files: shared/readonly-tools(.test).ts, workflow/{config,index,plan-tools.test}.ts, workflow/README.md, shared/README.md, sandbox/README.md, orchestrate/{mode,mode.test,prompts,config,config.test,index}.ts, orchestrate/README.md, docs/workflow-improvements.md.
- Stage 2:
  - `worktree: W1 folders subset and repos in the answer`. Files: worktree/{create-event,create-event.test,folders,folders.test,index}.ts, worktree/README.md.
  - `orchestrate: multi-repo packages with per-repo drift, acceptance and merge checks`. Files: orchestrate/{folders,folders.test,repos,repos.test,brief,brief.test,paths,paths.test,monitor.test,index}.ts, orchestrate/README.md, docs/workflow-improvements.md.
- Stage 3: `orchestrate: run widget, /orch board, view.json and sub-session status line`. Files: orchestrate/{view,view.test,store,store.test,index}.ts, orchestrate/README.md, docs/workflow-improvements.md.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 Move `workflow/readonly-tools.ts` to `shared/readonly-tools.ts`, and `workflow/readonly-tools.test.ts` to `shared/readon
- [x] S2 Add `orchestrate/mode.ts`, pure, with:
- [x] S3 Add `orchestrate/prompts.ts` with `DISCUSS`, `PROPOSE`, `RUN`, `PROPOSE_KICKOFF` and `RUN_KICKOFF`, and `section(mode, r
- [x] S4 In `config.ts`, add `approvePattern` (the default copied from the workflow, with a comment). A regex that does not compi
- [x] S5 Wire the mode in `orchestrate/index.ts`:
- [x] S6 Update `orchestrate/README.md` (Usage: `/orch` → discuss → go → propose → go → run, `/orch off`, the `approvePattern` co
- [x] S7 In `docs/workflow-improvements.md`, add row A43 (orchestrator mode with a read-only discussion and proposal; readonly-to
- [ ] S8 In worktree W1:
- [ ] S9 Add `orchestrate/folders.ts`, which reads K1 (a copy of `worktree/folders.ts` logic with a comment), and `orchestrate/re
- [ ] S10 In `brief.ts`:
- [ ] S11 In `paths.ts`, add `globsMayOverlap(a, b)` (pure, case-insensitive, canonical globs).
- [ ] S12 Orchestrate `index.ts` multi-repo:
- [ ] S13 Update the orchestrate README: the `key:glob` format, the `repos` field, per-repo checks, the W1 fields used, cross-run 
- [ ] S14 Add `orchestrate/view.ts` (pure) as designed: `buildView`, `pendingOf`, `widgetLines` and `boardLines`.
- [ ] S15 In `store.ts`, add `viewPath(common, runId)` and `writeView` / `readView` (tmp + rename via `writeAtomic`; reading retur
- [ ] S16 In orchestrate `index.ts`:
- [ ] S17 Update the orchestrate README (Visualizer section, the `view.json` row in Files). In `docs/workflow-improvements.md`, ad
## For you after the flow
- S18 Verify:
