<!-- pi-workflow plan v1 flow=20261029-1344-gate-a-merge-named-with-repo-in-the-flow-02e5 -->
## Plan: Gate a merge named with `--repo` in the flow repo it names, and log the prompt-capture finding

### 1. Goal and non-goals
**Goal.**
- In the workflow extension, a gated `gh pr merge … --repo owner/name` (or `-R`) with no `cd`/`git -C` is checked against the flow repo whose chosen remote is `owner/name`, not against the working folder.
- A `--repo` that matches no flow repo is refused with that real reason.
- A PR head commit that isn't in the repo being checked is refused with a message that says so, not "not judged".
- This holds in the main session (`index.ts`) and in the `git_task` subagent guard (`git-guard.ts`).
- The prompt-capture error is recorded in `docs/workflow-improvements.md` with its evidence, as an idea only.

**Non-goals:**
- Carrying judge passes from one flow into the next. Passes stay reset for each new flow.
- Any change to `pi-claude-bridge`, to pi, or to the workflow's `turn_start` refilter.
- A fix for the prompt-capture error. Its cause isn't confirmed.
- The game-studio plan (merging base PR #3, shipping the Unity fork). It resumes after this plan lands and pi restarts.
- Any change to `D:/personal/**`.

### 2. User decisions
- D1: Fix the merge gate in the workflow extension. Keep judge passes reset for each new flow.
- D2: For prompt-capture, first confirm the cause with a debug run. In this plan it is only a backlog row.
- D3: pi-config changes go through a branch and a pull request on `Unknownow/pi-config`, then a merge.
- D4: Use gh against Unknownow repos only through the temporary `GH_CONFIG_DIR=/tmp/ghcfg-unknownow`. Never run `gh auth switch` and never print the token. Keep the directory: the game-studio plan still needs it.
- D5: A repo's remote is chosen the way `remoteOf` does it: `origin`, else the first remote listed. Other remotes are never matched, so the Unity fork's `base` remote doesn't match `Unknownow/game-studio-base`.
- D6: PR #3 and the Unity fork resume after this fix is merged and pi has restarted. There is no `cd` workaround now.

### 3. Facts the executor needs
**Environment**
- Repo `D:/projects/pi-config`, branch `master` at `47f33d9`, working tree clean. Its remote normalises to `github-personal/Unknownow/pi-config`.
- Tests run from `pi/agent/extensions/workflow` with `node --experimental-strip-types --test <files>`. The full file list is in `pi/agent/extensions/workflow/README.md:211`. Node is v24.21.0.

**How the gate picks a repo today** (paths below are in `pi/agent/extensions/workflow/`)
- `push-guard.ts:154-164`: `ShellGuard` has `roots?`, `cwd`, `protectedBranches`, `branchOf`, `gate(kind, root, target, repo?)` and `isTag?`.
- `push-guard.ts:166-187`: `shellProblem`.
  - It splits the text into groups by `cd`/`git -C` (`repoTexts`), or uses `fallbackTexts` when `roots` is undefined. A group without either has `root === undefined`.
  - `:176` returns `ELSEWHERE` when a gated group without a root leaves the working folder.
  - `:183` calls `g.gate(req.kind, group.root, req.target, req.repo)`.
- `push-guard.ts:77-79`: the messages `ELSEWHERE`, `SWITCHED` and `CHAINED`. Model the new message on them: a plain lowercase clause, with no "Refused:" prefix.
- `push-guard.ts:286-295`: `repoOption` reads `-R x`, `--repo x`, `--repo=x` and `-Rx`. `GateRequest.repo` (`:20-21`) carries that value for merges.
- `index.ts:3141-3156`: the main-session gate.
  - `dir = root ?? ctx.cwd`, `key = repoKey(root ?? gitRoot(ctx.cwd))`.
  - `passedTrees: state.passedTrees?.[key]`.
  - On success it records `judgedMerges`.
- `index.ts:3159`: the `shellProblem(text, powershell, { roots: multi ? roots : undefined, cwd, protectedBranches, branchOf, gate, isTag })` call site.
- `git-guard.ts:62-75`: the subagent gate, with the same pattern; `key` comes from `gitOut(dir, ["rev-parse","--show-toplevel"])`. Its `shellProblem` call is at `:68-75`. `gitOut` (`:44-47`) is synchronous with `spawnSync` and returns `""` on failure.
- `merge-gate.ts:11-20`: `GateFacts`.
- `merge-gate.ts:29-34`: `gateProblem`. When `tree` is null it returns "… is not judged: run judge, then retry".
- `merge-gate.ts:67-96`: `gateCheck`. It reads `headRefOid` with `gh pr view … -R repo`, then runs `git rev-parse <commit>^{tree}` in `dir`. If the commit isn't in `dir`, `tree` is null.

**Helpers to reuse**
- `plan-store.ts:8`: `type Git = (cwd, args[], env?) => Promise<{code, stdout, stderr}>`.
- `plan-store.ts:61-70`: `remoteOf(git, root)` returns `{name, url}` with the url normalised, or null.
- `index.ts:1234`: `gitEnv: Git` is already used with `remoteOf` (`index.ts:1477`).
- `plan-doc.ts:271`: `normalizeRemote(url)` turns `git@github-personal:Unknownow/x.git` into `github-personal/Unknownow/x`, and strips `scheme://`, `user@` and `.git`. `plan-doc.ts` imports only `./stages.ts`.
- `index.ts:839-857`: `flowRepos(ctx)` returns `RepoRef[]` with `{root, dir}`: the working folder's repo first, then the added folders, then the touched repos.
- `repoKey` is in `repos.ts`.

**Why this was hit**
- The old flow's `.git/pi/plans/20261029-1132-…/status.json` has `passedTrees["d:/personal/game-studio-base"] = ["113d910…"]`, which equals `2dcc797^{tree}`.
- Yet `GH_CONFIG_DIR=… gh pr merge 3 --repo Unknownow/game-studio-base --merge --delete-branch`, run from `D:/projects/pi-config`, was refused as "not judged".

**Existing tests**
- `merge-gate.test.ts:9-33`: `gateProblem` cases.
- `merge-gate.test.ts:49-82`: `gateCheck` with a stub `Runner`. Line `:66` is "the pull request is read from the repo the command names".
- `push-guard.test.ts:160-168`: `shellProblem` with stub gates through a `single(...)` helper.
- `git-guard.test.ts:13-28`: only spec parsing and handler basics.

**Docs**
- `README.md:375-377` says a merge is gated on the repo "named by `git -C` or the last `cd`, otherwise the working folder's".
- `docs/workflow-improvements.md`:
  - `:7-9`: the rules for keeping it current.
  - `:5`: the Status line.
  - `:97`: section "D. Robustness and maintainability". The highest D id is D22.
  - `:124`: the "Effect measurement" table.

**Prompt-capture evidence (for D24)**
- `~/.pi/agent/claude-bridge-diag.log` has 30 `prompt_capture_unresolved` entries on 2026-10-29, all with prompts of about 14390 chars. The last is `04:53:00Z`: 14391 chars, 16 captures known, closest key 14041 chars, first difference at offset 13932.
- The bridge (pi-claude-bridge 0.9.3) stores its copy of the prompt at `before_agent_start`, `agent_start` and `turn_start` (`src/index.ts:2503-2532`) and throws at `src/prompt-capture.ts:195`.
- Candidate causes:
  - (a) The workflow's `turn_start` handler calls `refilterTools()` → `setActiveTools` (`index.ts:3073-3075`, `plan-tools.ts:6-18`), which can rebuild the prompt after the bridge has stored it.
  - (b) Workflow follow-up turns use `triggerTurn: true, deliverAs: "followUp"` (e.g. `index.ts:618`, `686`, `3302`) and skip `before_agent_start` (pi#5581).

### 4. Design
**Matcher (pure, `push-guard.ts`, exported)**
- Signature: `export function repoMatches(remoteUrl: string, repoArg: string): boolean`.
- It normalises both sides with `normalizeRemote`, takes the last two `/`-separated segments of each (owner and name), and compares them case-insensitively.
- The host is ignored (`github-personal` ≠ `github.com`).
- Either side with fewer than two segments → `false`.

**Shell guard contract (`push-guard.ts`)**
- `ShellGuard` gets `repoRoot?(repo: string): Promise<string | null>`. It returns the root of the flow repo whose chosen remote matches `repo`, or null.
- In `shellProblem`, for each request with `kind === "merge"`:
  - If `group.root === undefined`, `req.repo` is set and `g.repoRoot` exists: `root = await g.repoRoot(req.repo)`.
    - null → return `REPO_UNKNOWN`.
    - Otherwise call `g.gate("merge", root, req.target, req.repo)`.
  - If `group.root` is defined (`cd`/`git -C`): unchanged. The `cd` repo wins over `--repo`.
  - No `req.repo`, or no `g.repoRoot`: unchanged.
  - Protected pushes: unchanged.
- The `ELSEWHERE` check at `:176` stays where it is and runs first.
- Message format:
  `const REPO_UNKNOWN = "a merge with --repo must name a repo of this flow (its origin remote, else its first remote); run it in that repo's folder after the repo has joined the flow";`
  The text may differ, but it must contain `--repo` and `of this flow`, and it must not contain `not judged`.

**Implementations**
- `index.ts`: `repoRoot(repo)` loops over `await flowRepos(ctx)`. For each ref it calls `remoteOf(gitEnv, ref.root)` and returns the first `ref.root` where `repoMatches(remote.url, repo)`; otherwise null. Pass it in the `shellProblem` call at `:3159` in every case, single-repo included.
- `git-guard.ts`:
  - Candidates are `spec.roots`, or `[gitOut(ctx.cwd, ["rev-parse","--show-toplevel"])]` when `spec.roots` is empty. Skip empty strings.
  - Pick the remote with `gitOut(root, ["remote"])`: `origin` if listed, else the first listed. Then `gitOut(root, ["remote","get-url",name])`.
  - Return the first root whose url passes `repoMatches`; otherwise null. Model it on `remoteOf` (`plan-store.ts:61-70`) but keep it synchronous via `gitOut`, wrapped in an async function.

**Missing-commit message (`merge-gate.ts`)**
- `GateFacts` gets `commit?: string`.
- In `gateProblem`, after the `noMerge` branch: if `!f.tree && f.commit`, return
  `${f.what}: its head ${f.commit.slice(0, 7)} is not in this repo; run the merge in the repo it belongs to, or fetch that commit first`.
- `gateCheck` passes `commit` into the final `gateProblem` call (`:95`).
- The existing "unreadable tree" case with no commit keeps the old text.

**Failure handling**
- A `remoteOf` or `git` failure on a repo means that repo doesn't match. All repos failing gives `REPO_UNKNOWN`.
- A wrong match can only allow a tree that passed the judge in the matched repo, because `passedTrees` is still looked up for that repo and the tree is read there.

**Scale.** A flow has 1-5 repos, so each gated merge costs at most 5 × 2 git calls. This stops being cheap at around 50 repos, which is far beyond any flow.

**Rejected:**
- Carrying passes across flows: it weakens the gate (D1).
- Matching on any remote: the fork's `base` remote would match base (D5).
- Only rewording the refusal: the right merge would still be blocked.
- Mapping `--repo` inside `gateCheck`: `gateCheck` has no list of flow repos, and the key and dir are chosen in the callers.

### 5. Steps
**S1.** In `D:/projects/pi-config`, check `git status` and the branch: expect it clean on `master`. Create branch `fix/workflow-merge-gate-repo` from `master`.

**S2.** `pi/agent/extensions/workflow/push-guard.ts`:
- Add the exported `repoMatches`, importing `normalizeRemote` from `./plan-doc.ts`. Confirm this creates no import cycle: `plan-doc.ts` imports only `./stages.ts`.
- Add `repoRoot?` to `ShellGuard` (`:154-164`) with a one-line doc comment in the style of its neighbours.
- Add `REPO_UNKNOWN` next to `ELSEWHERE` (`:77`).
- In `shellProblem`'s request loop (`:177-185`), resolve the root for merges as in §4 before calling `g.gate`.

**S3.** `pi/agent/extensions/workflow/merge-gate.ts`:
- Add `commit?: string` with a doc comment to `GateFacts` (`:11-20`).
- Add the missing-commit branch to `gateProblem` (`:29-34`).
- Pass `commit` from `gateCheck` (`:95`).

**S4.** `pi/agent/extensions/workflow/index.ts`, execute-phase `tool_call` guard: define `repoRoot` next to `gate` (`:3141`), using `flowRepos(ctx)`, `remoteOf(gitEnv, …)` and `repoMatches`. Add it to the `shellProblem` options at `:3159`. Import `repoMatches` and, if it isn't imported yet, `remoteOf`.

**S5.** `pi/agent/extensions/workflow/git-guard.ts`: define `repoRoot` next to `gate` (`:62`) as in §4 and add it to the `shellProblem` options (`:68-75`).

**S6.** Add the tests in §6.

**S7.** Docs:
- `pi/agent/extensions/workflow/README.md:375-377`: extend the sentence so it says a merge with no `cd`/`git -C` that names `--repo owner/name` is gated on the flow repo whose origin remote (else its first remote) is that repo, and is refused when none matches.
- `docs/workflow-improvements.md`:
  - New row **D23** in section D, in the same column format as D22: "A merge gated with `gh pr merge --repo` and no `cd` was checked in the working folder, so a judged PR in another flow repo was refused as not judged." Add a **Done:** note naming `push-guard.ts` (`repoMatches`, `repoRoot`, `REPO_UNKNOWN`), `merge-gate.ts` (missing-commit message), `index.ts` and `git-guard.ts`.
  - New row **D24**, idea only: prompt-capture mismatches under pi-claude-bridge 0.9.3. Include the evidence and the two candidate causes from §3, and the confirmation method (`CLAUDE_BRIDGE_DEBUG=1`, then compare the two prompts where they first differ).
  - Status line (`:5`): add "D23 is implemented".
  - "Effect measurement" table (`:124`): add D23 and D24 rows in its format.

**S8.** Run the tests in §6. Call `judge(full=true)`. Fix every blocker and major finding with code changes and run `judge` again until it passes.

**S9.** Make the commit in §9.

**S10.** Deliver: merge — branch `fix/workflow-merge-gate-repo` into `master` of `Unknownow/pi-config`, as a pull request merged with a merge commit and delete-branch. Run gh through `GH_CONFIG_DIR=/tmp/ghcfg-unknownow` (D4). Don't delete that directory.

**S11.** Verify: restart pi so the new extension loads. In the resumed game-studio flow, after a judge pass on base `2dcc797`, run `gh pr merge 3 --repo Unknownow/game-studio-base --merge --delete-branch` from `D:/projects/pi-config` — look for: the merge is allowed. Before such a pass, the refusal is for the base repo, not a "not judged" for the working folder.

**S12.** Verify: run one pi session with `CLAUDE_BRIDGE_DEBUG=1` until `~/.pi/agent/claude-bridge-diag.log` gets a new `prompt_capture_unresolved` entry. Compare the stored prompt and the failing prompt where they first differ — look for: which candidate cause in D24 fits. Update D24 in a later change.

### 6. Tests
**`push-guard.test.ts`**
- `repoMatches: the owner/name of the remote, any host, any case`:
  - `repoMatches("github-personal/Unknownow/game-studio-base", "Unknownow/game-studio-base")` → true.
  - Same remote with `"github.com/Unknownow/game-studio-base"` → true.
  - Same remote with `"https://github.com/unknownow/Game-Studio-Base.git"` → true.
  - `repoMatches("git@github-personal:Unknownow/game-studio-base.git", "Unknownow/game-studio-base")` → true.
  - Against `"Unknownow/game-studio-unity"`, `"Other/game-studio-base"` and `"game-studio-base"` → false.
- `shellProblem: a merge named with --repo is gated in the repo it names`:
  - Setup: no `roots` (the `single` helper), `repoRoot` stub returning `"/r/base"` for `Unknownow/game-studio-base`, and a gate that records `root`.
  - `GH_CONFIG_DIR=/tmp/x gh pr merge 3 --repo Unknownow/game-studio-base --merge` → the gate is called once with root `"/r/base"` and target `"3"`.
  - Same with `-R Unknownow/game-studio-base` → same result.
- `shellProblem: a --repo outside the flow is refused before the gate`: the `repoRoot` stub returns null → the result contains `of this flow` and not `not judged`, and the gate isn't called.
- `shellProblem: cd wins over --repo`: `cd /r/x && gh pr merge 3 --repo Unknownow/game-studio-base --merge`, with `roots: ["/r/x", "/r/base"]` and `cwd` `/r/x` → the gate root is `/r/x`, and `repoRoot` isn't called. Use the same `roots`/`cwd` shape as the existing multi-repo `shellProblem` tests.
- `shellProblem: without --repo or repoRoot nothing changes`: `gh pr merge 12 --merge` with a `repoRoot` stub → the gate root is undefined and `repoRoot` isn't called. The existing `:160-168` cases still pass.

**`merge-gate.test.ts`**
- `gateProblem: a head missing from the repo is named, not called unjudged`: `{noMerge:false, passedTrees:["t1"], tree:null, commit:"2dcc797853495e13", what:"merging pull request 3"}` → contains `2dcc797` and `not in this repo`, and doesn't contain `run judge`.
- `gateCheck: a head that is not in the repo`: a stub runner returns `headRefOid` `"abc1234def"` for `gh pr view` and code 128 for `git rev-parse` → `problem` contains `abc1234` and `not in this repo`, and `tree` is null.
- The existing `gateProblem: an unreadable tree is refused` (`:23`) is unchanged and still passes.

**`git-guard.test.ts`:** no new test. The mapping logic is the pure `repoMatches` and the `shellProblem` contract, both tested above.

**Commands, from `pi/agent/extensions/workflow` (each fast, under 1 min):**
1. `node --experimental-strip-types --test push-guard.test.ts merge-gate.test.ts git-guard.test.ts` → all pass, 0 fail.
2. The full command from `README.md:211` → all pass, 0 fail.
3. From the repo root: `git diff --stat master` lists only `push-guard.ts`, `push-guard.test.ts`, `merge-gate.ts`, `merge-gate.test.ts`, `index.ts`, `git-guard.ts`, `README.md` (extension) and `docs/workflow-improvements.md`.

### 7. Done when
- A merge gated with `--repo owner/name` and no `cd`/`git -C` is checked against the flow repo whose chosen remote (origin, else first) matches. This holds in the main session and in `git_task`.
- `cd`/`git -C` still wins.
- A `--repo` that matches no flow repo is refused with the `REPO_UNKNOWN` text, before any gh call.
- A PR head that isn't in the checked repo is refused with the missing-commit message.
- Judge passes stay reset for each new flow.
- All workflow tests pass.
- The extension README sentence is updated.
- `docs/workflow-improvements.md` has D23 (done) and D24 (idea), plus the Status line and Effect measurement rows.
- The PR is merged into `master` of `Unknownow/pi-config`.
- `/tmp/ghcfg-unknownow` still exists.
- No change in `D:/personal/**`, `pi-claude-bridge` or the `turn_start` refilter.

### 8. Risks, rollback, and what not to touch
- **A wrong repo match:** limited to the chosen remote, and the tree still has to have passed in the matched repo. `cd` keeps priority.
- **Import cycle** from `push-guard.ts` → `plan-doc.ts`: check it in S2. If a cycle shows up, copy no code: move nothing and ask, since the design assumed there is none.
- **The running pi keeps the old gate until it restarts.** This plan's own merge in S10 runs in the working folder, so the old gate handles it correctly.
- **Rollback:** a revert PR of the merge commit.
- **Do not touch:**
  - `pi-claude-bridge`, pi, `index.ts:3073-3075`
  - `D:/personal/**`
  - `~/.ssh`, `~/.gitconfig*`, the active gh account
  - the contents of `/tmp/ghcfg-unknownow`
  - the plan files of other flows

### 9. Commits
1. `fix(workflow): gate a merge named with --repo in the flow repo it names`: `pi/agent/extensions/workflow/{push-guard.ts,push-guard.test.ts,merge-gate.ts,merge-gate.test.ts,index.ts,git-guard.ts,README.md}`, `docs/workflow-improvements.md`.

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 In `D:/projects/pi-config`, check `git status` and the branch: expect it clean on `master`. Create branch `fix/workflow-
- [ ] S2 `pi/agent/extensions/workflow/push-guard.ts`:
- [ ] S3 `pi/agent/extensions/workflow/merge-gate.ts`:
- [ ] S4 `pi/agent/extensions/workflow/index.ts`, execute-phase `tool_call` guard: define `repoRoot` next to `gate` (`:3141`), us
- [ ] S5 `pi/agent/extensions/workflow/git-guard.ts`: define `repoRoot` next to `gate` (`:62`) as in §4 and add it to the `shellP
- [ ] S6 Add the tests in §6.
- [ ] S7 Docs:
- [ ] S8 Run the tests in §6. Call `judge(full=true)`. Fix every blocker and major finding with code changes and run `judge` agai
- [ ] S9 Make the commit in §9.
- [ ] S10 Deliver: merge — branch `fix/workflow-merge-gate-repo` into `master` of `Unknownow/pi-config`, as a pull request merged 
## For you after the flow
- S11 Verify: restart pi so the new extension loads. In the resumed game-studio flow, after a judge pass on base `2dcc797`, ru
- S12 Verify: run one pi session with `CLAUDE_BRIDGE_DEBUG=1` until `~/.pi/agent/claude-bridge-diag.log` gets a new `prompt_ca
