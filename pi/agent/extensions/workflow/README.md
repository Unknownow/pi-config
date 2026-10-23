# workflow

Each kind of work gets its own model. Every model and thinking level is set in `~/.pi/agent/workflow.json`.
The workflow is for software: system design, architecture and code. (The name stays `workflow`: the
pi-config sync never deletes, so renaming the folder would leave the old extension loaded beside the new one.)

```
you <-> plan (Opus 5.5, high) -> approve -> final plan (Opus) -> execute (Sonnet 5.5, medium) -> judge (Opus 5.5) -> commit (subagent, Sonnet 5.5 low)
                                                              ^                          |-- explore (Haiku 5.5, parallel): answer + file:line
                                                              |                          `-- advisor (Opus 5.5): reads the full transcript
                                                              `-- fix findings <------- judge (separate session; sees the plan and the diff, not the discussion)
                                             judge says the plan is flawed -> you decide, or the arbiter (Fable 5.1) does
escalation (manual): /flow escalate -> Fable 5.1 (high), /flow back
context guard:       compacts at ~140k tokens on every model, after the run settles
handover:            compacts (and sends a short plan card) when handing over to execute, a fix round, the next stage or the commit step, above 30k tokens
plan is read-only:   bash refuses commands that change files, git or GitHub
```

| Role | Runs as | When |
|---|---|---|
| `discuss` | main session model; same read-only rules as `plan` | new sessions start here (`startPhase`). Open talk before a plan: investigate, answer, agree; no `Plan:` sections and no menus. `/flow plan` or a typed "go" moves to `plan` (it never executes) |
| `plan` | main session model; edit/write off, bash read-only | turns the discussion into a `Plan:`, checks it and fixes it with you; `/flow discuss` or "Back to discussion" in the menu returns to talk; after approval it writes the final execution plan (`finalizePlan`) |
| `execute` | main session model | after you approve the plan; when the flow ends (delivered, passed without a commit, or stopped) it goes back to `discuss` (`returnTo`: `discuss`, `plan` or `off`) |
| `explore` | `explore` tool, parallel sub-`pi` processes | plan and execute send open questions and multi-file searches to it; it decides how much to read and answers with `Answer:` plus `Evidence:` (file:line). Known files are read directly. Judge and advisor do not use it. It runs with thinking low, without `AGENTS.md`/`CLAUDE.md` files (`explore.contextFiles: true` loads them) and with a budget of about 10 tool calls per question, after which it answers with what it has and says what it did not verify |
| `advisor` | `advisor` tool, sub-`pi` with the whole transcript | choosing an approach, after an error repeats (auto-nudged after `repeatedErrorThreshold` failures), before "done" |
| `judge` | `judge` tool, sub-`pi` with the git diff | the diff is ready; when a run ends with an unreviewed diff it asks (`autoJudge`) |
| `arbiter` | sub-`pi` with the plan, the judge's report and the diff | the judge questions the plan and `planFlaw` is `auto`, or a passed review has a major plan flaw (whatever `planFlaw` is) (or you pick "Let the arbiter decide", or you picked *Approve, arbiter solves plan flaws* for this flow) |
| `commit` | sub-`pi` with bash only, the plan's goal and Commits section and the delivery instruction, and its own push guard (`commit-guard.ts`) | after the judge passes; `delivery.runner: "main"` runs it in the main session instead (compacted first at the handover) |
| `escalate` | main session model | `/flow escalate` |
| `test` | main session model; edit/write/judge off, bash read-only plus `test.supervisorBashAllow`, plus `test_run` | `/flow test <scope>`: plans tests, sends runners, writes the test report (see Test and fix) |
| `runner` | `test_run` tool, parallel sub-`pi` processes with `bash, read, grep, find, ls` and their own guard (`runner-guard.ts`) | one per test task card; reports facts only |

## Hands-off run

You discuss the plan with the planner. After every finished planner reply, an **Approve** menu
pops up (`planPrompt`): one `Approve → <delivery>` entry per delivery (see below), the default first, then
Show the full plan (prints the whole current plan, approves nothing; with `planRecap: "changes"`), Keep discussing. With `planFlaw: "ask"` the menu also has `Approve, arbiter solves plan flaws →`: it opens the
delivery menu, and in that flow plan flaws go straight to the arbiter. A typed approval uses the config. Right after such a reply you can also type a short approval
as the whole message (a second menu then asks for the delivery; Escape takes the default):
"go", "ok go", "lgtm", "do it", "do it for me", "yeah do that", "implement the plan", "ship it" and
the like; see `approvePattern`. Longer messages ("do it but skip step 3") keep planning, and so does "yes, do that" when the last
reply ended with a question (it answers a question). With `planRecap: "changes"` (default, needs `finalizePlan`) an approval works after any finished reply once a plan was proposed in this discussion; with `"always"` or `finalizePlan: false` the last reply needs a "Plan:" section. Everything
after approval runs on its own:

```
"go" -> final plan (Opus) -> execute (Sonnet) -> judge (auto) -> FAIL: fix and judge again (menu after 5 rounds)
                                                              -> PASS: commit, split by function [-> push -> pull request -> merge, as chosen at approval]
```

- **Plan files:** every flow writes its approved plan to `<repo>/.git/pi/plans/<flowId>/plan.md` (plus `status.json`) at approval, after each amendment, at each stage end and when the flow ends. It lives inside the git folder (the first repo's, or `~/.pi/agent/workflow/plans/` without git), so it never shows in `git status`, diffs, branches or PRs. The plan card after a compaction names this file; a missing file is rewritten before its path is given out. Below the plan the file lists the checklist, and a finished flow gets an `## Outcome` footer (`ok` or `failed: ...`; a flow left by switching phase is `abandoned`).
- **Plan retention:** the `plans` config block (`sync`, `localOnly`, `keepDays`, `keepCount`; defaults `remote`, `[]`, 14, 50). At session start, finished plans beyond the newest `keepCount` and any plan not updated for `keepDays` days are deleted (never the active flow's). `keepDays: 0` means no age limit; `keepCount: 0` deletes a plan as soon as its flow ends. `sync` and `localOnly` control pushing plan refs (below).
- **Plan refs:** each milestone also commits the plan (`plan.md`, `status.json`) to `refs/pi/plans/<flowId>` in every repo of the flow, built with a temporary index so the work tree, index and branches are untouched. The ref is pushed to the repo's `origin` (else its first remote) without force and without `--no-verify`; a rejected push is redone on top of the remote's commit. `plans.sync: "local"` turns pushing off everywhere; a `plans.localOnly` entry (case-insensitive substring of the normalised remote URL, e.g. `"github.com/Org/private"`) turns it off for matching repos. A host that refuses custom refs, or a failed push, leaves the plan local and warns once per flow. Retention also deletes pruned refs on the remote.
- **`/flow resume [flowId]`:** picks up an unfinished flow from its plan ref, e.g. on another device. It fetches the plan refs of the working folder's repo and added folders, and lists the unfinished flows (one match is used directly). The flow's other repos are found by remote URL: the working folder and added folders first, then sibling folders of the working repo, then you are asked for a path (empty skips it); found repos are added as folders. Each repo with a clean tree fetches the branch the flow used, switches to it, and fast-forwards it to the remote's commit (so work pushed from the other device is there); a branch that cannot be brought up (diverged local commits) stays as it is with a warning, and a dirty repo stays untouched with a warning. A plan ref never overwrites a newer one: an older snapshot from a restored session is skipped with a warning. The plan, stage, delivery and ticked steps are restored and a plan card is sent without starting a turn; send a message to continue. Limits: the code must be on the remote (switch devices at a stage boundary or after a push), and two devices cannot work on one flow at the same time (the last writer wins).
- **Claims:** while a flow is unfinished, the session writes `claim.json` (pid, host, working folder, time) next to the plan file in the repo's `.git/pi/plans/<flowId>/` and refreshes it every 60 s; it is removed when the flow finishes, is left, or the session ends. `/flow resume` marks flows claimed by another live session in its list (a claim is live when it is from this host, the pid is alive and it is under 180 s old) and refuses to resume one; a stale claim is taken over with a notice. Claims only work on one machine.
- **Step checklist:** the final plan numbers its steps `**S1.**`, `**S2.**`, ... across the whole plan. The executor ticks finished steps with the `plan_check` tool (execute phase only); the status bar shows `plan done/total`, the judge and the arbiter see the ticks as claims, and the plan card lists only the open steps (of the current stage). A plan without step IDs has no checklist and the card shows none. When `judge` runs with steps of the current stage still unticked, its result ends with a reminder naming them; the verdict is unaffected.
- **Metrics:** each flow appends to `<plan folder>/metrics.jsonl`, one JSON line per event: `subagent` (role, label, stage, model, `ms`, `bootMs`, turns, tools, tokens, cost, ok, error), `compaction` (reason `handover` or `guard`, `tokensBefore`, `ms`, ok) and a final `flow` line (outcome, ok, per-stage usage). It is local only: not in the plan ref, and deleted with the plan folder. Events from before approval are kept in memory and written to the next approved flow.
- **Staged plans:** when the planner proposes them (`stagedPlans: "auto"`, default: parts that build on each other,
  a large change, separate features; with `stageAdvance: "auto"`, default, the next stage starts at once, even after an incomplete delivery or a stage with no changes, with a warning, while `"ask"` asks first) or you ask for delivery between parts, the planner lists the stages in its
  `Plan:` section before you approve, and the final plan groups its steps under
  `### Stage N: <title>` headings (numbers 1, 2, 3, ... in order, at least two). The flow then loops: execute
  stage 1, judge, deliver it (commit, push, pull request, merge), then the executor gets stage 2, and so on. The
  flow ends after the last stage. A heading may end in `(delivery: commit|push|pr|merge)` to deliver that stage
  differently; otherwise the flow's delivery applies, and `off` for the flow wins (nothing is delivered, the
  stages still follow one another after each judge pass). If a stage's delivery is incomplete (push failed, merge
  blocked, no commit), a menu asks to continue with the next stage or stop; without a UI it stops. The judge is told
  which stage it reviews. A stage heading may also end in `(after: <what>; check: <command>)`: the stage then starts
  with a wait point (see below). Both tags work in either order.
- **Delivery** (chosen for each flow at approval; `delivery` in workflow.json): `commit` only (default),
  `push`, `pr` (also opens a pull request, or reuses the branch's open one), `merge` (also waits for the
  checks with `gh pr checks --watch`, then `gh pr merge --merge --delete-branch`), or `off`. Commits are split by
  function (`splitCommits`): one per feature, fix, refactor, config or docs change, with its tests; the
  final plan lists them in its Commits section. In `pr`/`merge` mode on a protected branch or a detached
  HEAD the commits go on a new branch, `branchPrefix` + a slug of the plan title, and the pull request
  targets the branch the flow started on (`base` overrides it). In `push` mode on a protected branch or a detached HEAD it only commits, and the commit instruction and the final report say why ("push skipped: master is protected"). It never approves a pull request and never
  uses `--admin` or `--auto`: a merge GitHub blocks (review required, conflict, failed check) stops and is
  reported. `/flow delivery <commit|push|pr|merge|off>` changes it for the current flow.
  `mergeMethod` (`merge`), `deleteBranch` (`true`), `ask` (`true`) and `default` (`commit`) are configurable.
  With several repositories, the commit step opens their pull requests and waits for their checks in parallel, then merges them in order and stops at the first failure.
  `runner` (`subagent`) says where the commit step runs: a fresh `commit`-role subagent that does not carry the session's context, or `main` (the main session, compacted first at the handover).
- **Push guard:** it never pushes `protectedBranches` (`main`, `master`) or a detached HEAD. It
  commits there and tells you. It never force-pushes or uses `--no-verify`, and stops if a hook fails.
  This is enforced, not only asked for: while executing, a `git push` is refused unless it is the
  workflow's own commit-and-push step, a plain `git commit` is refused unless it is the workflow's commit step, and force pushes, deletes, `+refspec`s, pushes to a protected
  branch, `--no-verify` and changes to `core.hooksPath` / `GIT_CONFIG_*` are always refused (`push-guard.ts`).
  `gh pr create` and `gh pr merge` (and `gh api` calls that open or merge one) are refused unless the flow's
  delivery includes them and its commit step is running; `gh pr merge --admin` / `--auto` and `gh pr review --approve`
  are always refused.
  `git merge`, `cherry-pick`, `revert`, `pull`, `rebase` and `am` create commits no judge has seen, so they are refused too
  unless told not to commit (`merge --no-commit`/`--squash`, `cherry-pick -n`, `revert -n`, `pull --ff-only`, or `--abort`); `rebase` and `am` only to abort. The workflow's commit step may use them, never with `--no-verify`.
  Like the plan-phase checks it reads the command text: a guard against a drifting executor, not a sandbox.
- **Minor findings:** a passed review with fixable minor findings goes back to the executor for up to `maxMinorRounds`
  (default 1, `0` commits at once) fix rounds, then commits anyway. Fix them, or dispute a wrong one. `[knowledge ...]` and
  `[plan-flaw]` findings never start a round.
- **Where it stops for you:** when the judge fails `maxJudgeRounds` (5; 0 means no limit) times in a
  row it asks: keep fixing, escalate and keep fixing, or stop. It also stops when something errors.
- **Judge rounds after the first** review only what changed since the last round: a fresh judge gets
  that round's findings, the changes since, and the names of every file in the change, at
  `judge.recheckThinking` (medium). Calling it again with no changes returns the last result. It
  falls back to a full review after a commit, rebase or branch switch, or when the changes since are
  over `judge.recheckMaxShare` (half) of the whole diff. A change over
  `judge.finalFullReviewOverChars` (80,000 characters) that passes a re-review gets one final full
  review only when the changes since the last round touched a file its findings did not cite
  (`judge.finalFullReviewNewFilesOnly: false` runs it every time); the judge tool's `full: true` forces one. That final review is skipped when a full review already passed in this stage and the changes since are at most `judge.finalFullReviewRepeatMaxShare` (10%) of the whole diff; `0` turns the skip off. `"judge": { "recheck": false }` turns it off.
- **Knowledge on re-reviews:** when the last round's knowledge check passed, a re-review runs `get_rule_pack` only for the files changed since that round and carries over the other files' deviation notes. Otherwise it checks the whole change. Full reviews always check everything.
- **Judge read budget:** the judge prompts ask for about 15 read/grep/find/ls calls on a full review and about 8 on a re-review (knowledge calls excluded). A soft aim, not a limit.
- **Commit calls:** the commit instruction asks the model to chain dependent steps with `&&` to keep the call count low.
- **Handover compaction:** when a run hands over to the next step (final plan to execute, a minor-fix round, the next stage, the commit step) and the context is over `handoverCompactTokens` (30,000; `0` turns it off), the session is compacted first and the handover message carries a plan card (goal, user decisions, done-when, amendments and the open steps) instead of the full plan. The 140k context guard sends the same card after its compaction. A failed compaction still sends the message. An aborted run holds the handover: nothing is sent, except the commit step, which is sent without compaction so the pending commit is not lost.
- **Disputes:** if the executor thinks a finding is wrong it passes the finding and its file:line
  evidence in the judge tool's `disputes` parameter. The judge treats that as a claim, decides it from
  the code, and drops the finding only if the code shows the executor is right.
- **Turning steps back to manual:** set `"autoJudge": "ask"`, `"delivery": { "default": "off" }`
  (nothing is committed unless you pick it at approval), and `"planPrompt": false` for a "say go" hint instead of the Approve menu.
  `"autopilot": true` skips the routine menus and lets the agent resolve waits itself (see "Autopilot"). `"handoverCompactTokens": 0` turns off compaction at handovers. `"addedFolderRules": "full"` loads the rules files of added folders into the prompt (default `"paths"`: only their paths and sizes are listed). `"explore": { "contextFiles": true }` gives explore subagents the context files. `"returnToPlan": false` stays in execute after a flow ends. `"planRecap": "always"` makes every planner reply repeat the plan. `"stageAdvance": "auto"` (default) starts the next stage at once, even after an incomplete delivery or a stage with no changes, with a warning (not after a run you aborted, and never while the stage has open steps, no changes and no judge call); `"ask"` asks first. When `gh` is not on PATH, the workflow looks in the standard GitHub CLI install folders and adds the one it finds to pi's PATH; when there is none, outcomes say the PR state is unknown. `"stagedPlans": "onRequest"` makes the planner use stages only when you ask for delivery in parts.

## The plan, the judge and the arbiter

- **Plan phase** is for discussion: investigate, answer questions, weigh options, agree. The planner proposes the plan in a short `Plan:` section once the talk is heading toward a change, then continues from the context: later replies carry a `Plan:` section only for what changed (`planRecap: "changes"`, default; `"always"` repeats the plan in every reply). When you approve, the
  planner writes the **final plan** in one more reply (`finalizePlan`, default on): goal and
  non-goals, your decisions (D1, D2, ...), facts with file:line, a design section for changes that
  add or reshape components, steps, tests, "done when", risks. The plan gives direction and
  contracts, not code: what to change, why and how it must behave. The execute model writes the code
  and the judge checks the result against it. With `finalizePlan: false` the last `Plan:` reply is used.
- **Execute** follows the plan in order and writes the code within its contracts.
  It stops and says so when a step cannot be done as written. It never runs `git commit` or `git push` itself (the push guard refuses them): at a delivery point it ends its turn after the judge passes, or it calls `deliver` (see Checkpoints).
  When the flow ends it switches to the phase `returnTo` names (default `"discuss"`; `"plan"` or `"off"`). The old boolean `returnToPlan` is still read when `returnTo` is not set (`true` = `"plan"`, `false` = `"off"`).
- **The judge** runs in its own session. It sees the approved plan and the diff, not the discussion,
  and assumes the change is wrong. It is asked to stay within about 15 read/grep/find/ls calls on a full review and about 8 on a re-review (knowledge calls excluded), a soft aim, not a limit. What it trusts:

  | Input | Trust |
  |---|---|
  | Goal, non-goals, your decisions, "done when" | **Trusted** as the target. It does not reopen them (unless unsafe or self-contradicting: `[plan-flaw]`) |
  | The plan's steps, file:line facts, design reasoning | **Claims to verify** against the code. "The plan says so" is never evidence. Code that follows the plan but misses the target is a finding |
  | The diff, comments, test names, "tests pass", the executor's disputes, the `focus` line | **Assumed wrong / framing only** |
  | The previous judge round | **Untrusted too**: re-checked, dropped when the code disproves it |

  Without a plan it cannot see work that was never done, and it may contradict decisions you made.
  It checks correctness, the plan, security, the long run (scale, drift, platforms), and design
  (coupling, interfaces, migrations), and each finding has a `Why:` and a `Fix:` a weaker model can follow.
  Limits: it reads but cannot run code, and it shares a model with the planner by default.
- **`[plan-flaw]`** findings mean the approved plan itself is wrong. They do not count toward FAIL and
  are never fixed by the executor. `planFlaw: "ask"` (default) shows a menu: back to planning, let the
  arbiter decide, ignore and continue, stop. `"auto"` lets the **arbiter** (Fable 5.1 by default, a
  different model from the planner) decide from the code: `REVISE` appends a numbered amendment to the
  plan (at most `maxPlanRevisions`, 2), `KEEP` records why the plan stands, `ASK_USER` shows the menu.
  Picking *Approve, arbiter solves plan flaws* in the plan menu gives `auto` for that flow only.
  The arbiter cannot change your decisions or the goal. On a **pass**, minor plan flaws are noted in the
  plan under "Plan choices upheld at a pass" and the commit goes ahead. Major ones go to the arbiter first,
  whatever `planFlaw` is: `KEEP` commits, `REVISE` reworks before the commit. If the arbiter cannot decide,
  the flaws are noted, the commit goes ahead and the flow summary says "N plan flaw(s) not settled". A
  blocker plan flaw, or one in a FAIL, blocks the commit until resolved.

## Wait points, checkpoints and tags

These let one plan deliver or pause partway through, without replanning and without changing step or stage numbers. Without the tools below, flows behave as before.

**Wait points.** Some steps need a person (open the Unity Editor).
- **Plan syntax:** a step `**S7.** Wait: <what> (check: <read-only command>)`, or a stage heading ending in `(after: <what>; check: <command>)` that holds the stage back until the wait is over.
- **Tool:** `wait_for_user {reason, check?, step?, kind?, manual?}` (execute phase only). The check must pass the read-only bash filter. An unplanned wait adds `## Amendment N (executor: wait)` to the plan.
- **Shell:** the check runs in pi's own bash, the one the bash tool uses (Git Bash on Windows), not whatever `bash` is on PATH. `wait_for_user` runs it once at once: if it passes there is nothing to wait for. A broken check (no bash, exit 126/127, `command not found`) stops polling with a warning, and the typed-message menu shows why.
- **Polling:** with a `check`, the workflow runs it every 2 minutes for up to 1 hour. When it exits 0 and the session is idle, the flow resumes by itself with a message naming the wait; `wait.autoResume: false` only notifies. Without a check, or after the hour, your next typed message ends the wait ("Continue anyway" / "Keep waiting" when you type while a check still fails).
- **State:** the plan card, the status bar (`workflow-wait`) and the plan file show the wait; plan, stage and ticks stay. It survives `/flow resume`.
- **Config:** `wait: { pollMs: 120000, maxMs: 3600000, checkTimeoutMs: 30000, autoResume: true }`.
- **Human checks:** a check only a person can do (play it in the Editor, look at visuals) is a step `**S7.** Verify: <steps> — look for: <what>` (or `(look for: <what>)`). It never pauses the flow and is not an open step. `wait_for_user {kind: "verify"}` records one the executor finds on its own: it never pauses or polls, adds `## Amendment N (executor: verify)` (or uses the planned Verify step) and ticks a named non-Verify step. A test-only `Wait:` in an older plan is treated as a Verify by the executor; there is no keyword matching. The end card lists them under "Human checks (after the flow)", the outcome ends with `· N human check(s) for you (see the card)` and the plan file shows them under "For you after the flow". A failed check is fixed in the next flow.
- **No-change stages:** a stage that ends with no changes, no judge call and open steps waits instead of counting as "delivered: no changes".

**Autopilot.** `"autopilot": true` (default `false`) or `/flow autopilot [on|off]` for the session (no argument toggles; `/flow status` and the `workflow-autopilot` status show it; a restart falls back to the config).
- **Approve waits:** `wait_for_user {kind: "approve"}` doesn't pause. The tool tells the agent to review the item and, if it holds, post a comment where approval was asked (`gh issue comment <n> -R <repo> --body "approved (workflow autopilot): <reason>"`), run the check, and continue. The plan gets an `## Amendment N (executor: autopilot)`.
- **Act waits:** the agent does the step when a non-interactive command can and the repo's `AGENTS.md`/`CLAUDE.md` allow it; otherwise it calls `wait_for_user` with `manual: true`, which pauses and polls as usual.
- **Menus skipped:** the delivery menu (the config's `delivery.default` applies), the plan-end approval's delivery choices (it shows only the mode that applies, labelled with why; `/flow delivery <mode>` changes it), `autoJudge: "ask"` (runs the judge), the plan-flaw menu (the arbiter decides), the stage-advance questions, and the "knowledge not checked" question (a warning, then commit).
- **Still asks:** plan approval, judge failure, the judge round cap, an arbiter result of "ask", open plan steps, the test-phase menus and stage-start `(after: …)` waits.
- **Limits:** it never scripts around a confirmation a person must type and never overrides a repo's `AGENTS.md`/`CLAUDE.md`. It pushes or opens a PR only if `delivery.default` says `push`, `pr` or `merge`.

**Checkpoints.** `deliver {mode?, tag?, step?, reason?}` delivers inside the executor's turn and then continues the same stage.
- **Limit:** `mode` (`commit`, `push`, `pr`, `merge`) may not go beyond the stage's delivery (the flow's, or the heading's `(delivery: …)`); `off` allows none.
- **Gate:** the diff must pass the judge first (an unchanged passed diff is reused). The commit subagent does the delivery; the executor's own shell still cannot commit or push.
- **Plan:** a step `**S4.** Deliver: <mode> — <what>` (mode commit, push, pr or merge) is a planned checkpoint. Plans contain no raw `git push`, `gh pr create`, `gh pr merge` or `git push --delete`; a merge is `git merge --no-commit` plus a `Deliver: commit` step. The workflow shows each open Deliver step as `→ call deliver {mode, step}` (in `plan_check`, the start and stage messages and the judge reminders), warns when the plan is accepted if a step is beyond the delivery or spells out a raw publish command, and every publish refusal names the next Deliver call (or says to end the turn) and tells the executor never to ask the user to run it. A call without one adds `## Amendment N (executor: checkpoint)`; a retried call adds no second amendment.
- **Publishing:** a later `deliver` with `push`, `pr` or `merge` publishes commits an earlier commit step made (recorded per repo, kept over `/flow resume`), without a new judge run; so does the end of a flow or stage with nothing left to review. A repo whose HEAD no longer descends from the recorded head, or is on another branch, is refused with a `git switch` hint. Judged commits in repos with no uncommitted changes go out in the same commit step as the changed repos. Commits after the recorded head that the commit step did not make and that are on no remote are refused, with the `git reset --soft <head>` that sends them through the judge.
- **Outcomes:** each checkpoint is recorded (kept over `/flow resume`) and listed in the stage and flow outcome (`checkpoint S4: …`); the judge is told which checkpoints were delivered earlier. An unstaged flow whose remaining changes were all delivered at checkpoints ends with that outcome.

**Publish and Mirror steps.** `**S<n>.** Publish: <package>[, <package>…]` (after the `Deliver: merge` step that lands the packages) and `**S<n>.** Mirror: <folder>|all[; extras <name@version,…>]` are run with `publish_packages {step}` (execute phase only), on this computer with the person's registry token, so nobody types `publish`. Plans name packages, never versions: the version is the one this flow merged (read from the merged head, recorded per repo in `mergedHeads`). The tool refuses a step the plan doesn't name, skips versions the registry already has (tagged and no longer a candidate), records the merged head only when the merge delivery succeeded, fails the step when a version is superseded or not on origin/main (nothing published), and waits (`waiting for <tags> to be published`, check `update-packages.mjs publish --only … --dry-run --unblocked`) while an older version of the package or a pinned `com.iecgames.*` dependency is unpublished; call it again after the wait resumes. The wait's time limit counts from the first block of the step. A lock file `iec-publish.lock` in the clone's git common dir keeps two sessions from publishing at once (stale after 30 minutes with a dead pid). The guard refuses `npm publish`, `updates.bat publish|mirror`, `update-packages.mjs publish` (without `--dry-run`), `maintenance.mjs mirror --confirm` and `publish-package.mjs` in bash and `run_code`.

**Tags.** Tags are made only when the plan has a `Deliver:` step for them or the executor asks through `deliver {tag}`; the workflow never tags on its own, and never publishes packages.
- **Create:** a plain push of a new tag; an existing tag is never overwritten.
- **Move:** needs a plan step that names the tag and says "move"; pushed with `--force-with-lease=refs/tags/<name>:<sha>` on the recorded SHA, and only forward (the old commit must be an ancestor of the new one).
- **Target:** defaults to the tip of the remote default branch and must be on it. `--no-verify` and a bare `--force` are never used.
- **Several sessions:** a lost race, a refused move or a failed push waits for a person instead of overwriting.

## Desktop notifications

A session shows a desktop notification (Windows toast, `osascript` on macOS, `notify-send` on Linux) when it needs you: a workflow menu opens (the plan is waiting for approval, a question, a failure), the session stays idle for `idleMs` after a turn, a wait's check passes without `autoResume` or its polling stops, or a flow finishes. Turns the workflow continues by itself (judge, commit step, next stage, auto-resume) never notify, and one session notifies at most every 15 s. There is no focus check. Config: `notify: { enabled: true, idleMs: 10000 }`; `enabled: false` turns it off.

## Discuss and plan phases are read-only

The discuss phase uses exactly the same rules as plan.

Only tools matching `planAllowedTools` (regexes over the tool name) can be called: read, grep, find,
ls, bash, codemode, explore, advisor, judge, `run_code`, `fetch_url` and MCP tools named search/get/list/...
Everything else (AskClaude, `propose_entry`, edit, write) is hidden and refused.
MCP tools whose name has a write word (create, update, delete, set, add, run, save, post, ...) are refused even when they start with a read verb
(`get_or_create`, `get_post`); `planAllowedTools` cannot override this.

The planner (Opus, high thinking) is the most expensive model per call, so it only plans. Edit and
write are off, and `bash` refuses commands that can change files, git or GitHub
(`readonly-bash.ts`), including `bash` calls from codemode scripts. The planner then has to finish
its plan and hand over, even when you said "fix it" or "do it for me".

- **Allowed:** reading commands (`ls`, `cat`, `grep`, `find`, `sed -n`, `jq`, ...), `git`
  status/log/diff/show/fetch and listing branches or tags, `gh ... view/list/checks/status`,
  `gh api` GETs, `curl` GETs to stdout, `npm view/ls`, redirection to `/dev/null`.
- **Refused:** output redirection to a file, `tee`, `sed -i`, `rm`/`mv`/`cp`/`mkdir`, git
  commands that change the repo (`commit`, `push`, `checkout`, `tag v1`, ...), `gh` commands that
  change GitHub (`pr create/merge`, `issue edit/close/comment`, `gh api -X POST` or `-f`), scripts
  (`node -e`, `python`), and any command not on the list.
- **More commands:** add regexes over the command's words to `planBashAllow` (default: `unity cmd
  editor_status` / `console_status`). `"planReadOnlyBash": false` turns the check off.
- Also allowed on purpose: `git fetch` (it only updates remote-tracking refs). `git help <topic>` is refused (it opens a viewer), as are `rg --pre`,
  `ag --pager`, `less -o`, `date -s`, `hostname <name>`, `git diff --ext-diff` / `--textconv`.
- A repository's own git config (`core.fsmonitor`, `diff.external`, textconv) can still run programs on a
  plain `git status` / `git diff`: plan an untrusted repo in a throwaway clone.
- **`run_code`** (the sandbox extension, `readonly-tools.ts`) is checked too: its JavaScript is refused
  when the code writes, deletes, runs programs, `eval`s, or sends a POST, PUT, PATCH or DELETE
  request, or builds names at runtime (`fs['wri'+'te']`, `require(x)`). `fetch_url` only reads. MCP tools
  are also refused when an argument holds a statement that changes data (`INSERT`, `UPDATE ... SET`,
  `DELETE FROM`, `DROP`, a GraphQL `mutation`, ...).
- **Tools that register later** (an MCP server that connects after the phase began) get the same filter:
  it runs again before each prompt and at each turn start (`plan-tools.ts`) and calls `setActiveTools`
  only when the set changes.
- It is a guard against the planner drifting into execution, not a sandbox. The code checks are
  regexes: a determined disguise (a computed lookup on an alias of `require('fs')`, say) can still get
  past them.
- Tests: `node --experimental-strip-types --test agent-end.test.ts folder-add.test.ts readonly-bash.test.ts readonly-tools.test.ts plan-tools.test.ts tokens.test.ts push-guard.test.ts knowledge.test.ts registry-publish.test.ts mcp-forward.test.ts subagent.test.ts delivery.test.ts notify.test.ts repos.test.ts stages.test.ts commit-guard.test.ts repo-diff.test.ts prompts.test.ts config.test.ts metrics.test.ts plan-store.test.ts boundary.test.ts plan-doc.test.ts runner-guard.test.ts test-report.test.ts test-run.test.ts test-flow.test.ts flow-report.test.ts view.test.ts waits.test.ts checkpoints.test.ts tags.test.ts`.

## Test and fix

A flow for testing and fixing, next to plan → execute → judge → commit. `/flow test <scope>` (or `/flow test` and then typing the scope, or `pi --flow test`) starts the **test phase**.

- **Supervisor** (role `test`, Opus medium): runs in the main session. Reads like the plan phase (edit, write, judge and plan_check are off; bash is read-only plus `test.supervisorBashAllow`, by default `adb devices`, `adb shell getprop` and `unity status`). It plans the tests, sends task cards to runners with the `test_run` tool, triages the results, diagnoses bugs and ends each round with a test report.
- **Runners** (role `runner`, Haiku low): one sub-`pi` per task card, with `bash, read, grep, find, ls` (`test.runnerTools`; edit and write are always removed). A runner runs exactly the card and replies `RESULT: PASS | FAIL | ERROR`, the command, the exit code, at most 40 lines of output and artifact paths.
- **`test_run`**: up to `test.maxTasks` (8) tasks per call, each with `id`, `run`, `observe`, `pass` and `resource`. Tasks with the same resource (`unity:<project folder>`, `device:<serial>`) run one after another; the other groups run in parallel, up to `test.concurrency` (4; 1 runs one task at a time). Each runner has `test.runnerTimeoutMs` (45 minutes). A record per task (card, reply, every bash command with the start of its result) is written to `runs/<round>/<call>/<id>.md` in the plan's folder (the temp folder when there is no plan file); each `test_run` call gets its own numbered folder. The resource order and `test.concurrency` also hold across `test_run` calls that run at the same time in one session (not across separate pi sessions).
- **Runner results are claims.** The tool result lists the commands the runner actually ran (read from its tool calls). A PASS or FAIL with no bash call, or a PASS with a failed command, is marked `unverified`, and the supervisor reruns it.
- **Runner guard** (`runner-guard.ts`, loaded only in runner sub-processes): refuses git and gh commands that change anything, commands matching `test.runnerDeny` (by default `adb reboot` and friends, `adb shell rm -r`, wipe, recovery, format, `fastboot`), a project path after a flag in `test.runnerPathFlags` (`--project-path`, `-projectPath`) that lies outside the flow's folders or cannot be checked (`$`, backticks, `%`), and assigning a name from `test.runnerPathEnv` (`UNITY_PROJECT_PATH`). `adb install -r`, `uninstall` and `pm clear` stay allowed; add patterns to `runnerDeny` when a device is not a dedicated test phone. Commands are checked behind wrappers too (`timeout`, `env`, `xargs`, `nice`, …), so `timeout 60 adb reboot` is refused and only a real `git`/`gh` command counts as git. It is a guard against drift, not a sandbox: a `cd` inside a command does not move the base of relative paths.
- **Test report**: the supervisor's last reply of a round, parsed by `test-report.ts`:

```
## Test report: <scope>
Ran: <command or scenario> → <result counts>
**S1.** [bug] <title>      (Repro, Expected (source: ...), Actual, Suspect, Root cause, Fix direction)
**S2.** [ask] <title>      (Question, Options)
**S3.** [blocked] <title>  (Needs)
**S4.** [manual] <title>   (Steps, Look for)
**S5.** [fixed] <title>    (Evidence)
VERDICT: CLEAN | BUGS
```

  A reply with no valid report gets one automatic request to fix it, then a Retry / Stop menu.
- **Fix loop** (`test-flow.ts`, pure; `index.ts` drives it). After a valid report:
  1. Open `[bug]` items start a **fix round** by themselves, with no approval and no delivery menu: the plan is regenerated from the bugs (steps S<n> with Repro, Expected, Fix direction; arbiter amendments are kept), the session switches to the execute model, and the executor gets the fix-round rules (root cause, regression test, never weaken an existing test, only the listed steps).
  2. The judge reviews it with the test-flow addendum (weakened tests, special-cased repro input and changes beyond the steps are major). The arbiter decides plan flaws; when it hands one to the user, the flow does not stop: the question is queued and the plan notes the choice as upheld.
  3. The commit step commits (`test.delivery`, default `commit`), then the supervisor tests again: it re-runs the fixed items' repros and the `Ran:` checks and reports each as `[fixed]` or `[bug]`, then continues with the rest of the scope.
  4. A bug that fails again after its fix makes the next fix round run on the escalate model. After `test.refails` (2) failed fixes it becomes a question.
  5. At most `test.maxRounds` (3) fix rounds; then a menu offers that many more or Stop (`maxRounds: 0` = no limit).
- **When it asks the user**, in one batch at the end of a test round, one prompt per question; Escape skips a question: an `[ask]` item (its Options, "Other", Skip), a `[blocked]` item ("It's available now", Skip, Stop), a bug that failed `test.refails` times (keep trying escalated, skip it, stop) and a plan question the arbiter could not settle (the test's Expected is right, the fix is right, skip). Skipped items are never asked or fixed again. Any other answer is recorded as a decision (`D2…`) and the supervisor tests again with it.
- **End**: the flow ends when no bug and no question is open, or on Stop. The card says `test: <n> fixed in <r> fix round(s)`, then `; open: <ID tag, …>` and `; human checks: <IDs>` (the `[manual]` items, listed on the end card with their steps and what to look for, never asked) and `; skipped: <IDs>` when there are any; it is ok when no `[bug]` item remains.
- **Not supported**: `/flow resume` for test flows (they are refused).
- Config: the `test` block of workflow.json (`concurrency`, `maxTasks`, `runnerTimeoutMs`, `maxRounds`, `refails`, `delivery`, `runnerTools`, `supervisorBashAllow`, `runnerDeny`, `runnerPathFlags`, `runnerPathEnv`) and the roles `test` and `runner`.

## Public contract for other extensions

Other extensions (the worktree extension in this repo) may rely on exactly these, and on nothing else of the workflow. The workflow never refers to other extensions: it has no import of them and no knowledge of their files (`boundary.test.ts` checks this).

- **K1. `session-folders` entry.** `customType: "session-folders"`, data `{ "v": 1, "cwd": "<working folder, forward slashes>", "folders": ["<absolute, forward slashes>", ...] }`. The workflow is the only writer. It appends one whenever the added folders change, and at every session start (not reload) when the newest one is missing or differs. Readers use the newest entry on the branch; none means no added folders.
- **K1b. Folder follow rule.** At session start (not reload), when saved state exists and the newest `session-folders` entry names another working folder than the current one, each added folder inside a git repo is replaced by the same path in the one worktree of that repo that sits next to the working folder's repo (same parent folder), if it exists. Plain folders, folders without exactly one such worktree and missing targets stay. A result equal to the working folder is dropped. A notice lists the moves.
- **K2. Switch guard.** `session_before_switch` (`new` and `resume`) is cancelled while the phase is execute and a plan is approved, or the phase is test and a test flow is active, with the notice "a flow is executing; finish it or leave it with /flow off before switching sessions".
- **K3. CLI flags.** `--add-dir` takes absolute folders joined by `;` on Windows and `:` elsewhere (applied at startup only, not again after a session switch); `--flow plan|execute|test|off` sets the start phase.
- **K4. `workflow:status` event.** `pi.events.emit("workflow:status", { v: 1, phase: "off"|"plan"|"execute"|"test", flowId?, title?, stage?, stages? })`, emitted when the payload changes.
- **K5. Shell parser.** `readonly-bash.ts` exports `parseCommands`, `KEYWORDS` and `WRAPPERS`. Other extensions may import these three; changing their names, signatures or meaning is a contract change.
- **K6. `workflow:folder-add` event.** `/folders add` emits `pi.events.emit("workflow:folder-add", { v: 1, cwd, folder, claim })` after its checks (`cwd` and `folder` absolute, forward slashes). A listener calls `claim(promise)` synchronously during the emit; the promise resolves to `{ folder }` (use this path instead), `{ error }` (cancel the add) or `null` (no opinion). Late claims are ignored. The workflow waits for all claims for at most 300 s; an error, a rejection or the timeout cancels the add, otherwise the first `{ folder }` replaces the path (and passes the same checks again). No listener means the path is used as given.

## Team knowledge

When a pi package registers the MCP server named by `knowledge.server` (IEC game repos: `knowledge`),
the subagents in `knowledge.roles` get its read tools (`knowledge.tools`; never `propose_entry`). Each
subagent starts its own copy through `mcp-forward.ts`, with `knowledge.env` added
(`KNOWLEDGE_OFFLINE=1`: use the team index the main session fetched).

With `knowledge.judgeCheck`, the judge's last step is the knowledge check: `get_rule_pack` for every
changed file, then each rule. The workflow verifies the judge's tool calls; a skipped check gets a
separate knowledge pass. Broken required rules are major (security: blocker). Deviations from
recommended rules are minor, documented (Rule, Code, Reason, Impact, To follow it) and listed in the
commit message under `Knowledge deviations:`. When the server is unavailable the result ends with
"Knowledge: not checked" and the commit asks first. Elsewhere nothing changes; `"server": ""` turns
it off.

## What you see

A widget above the editor shows the pipeline with the active stage, its model and the tokens each
stage has used, and one live row per subagent: what it's doing right now, how many tools it has run,
its tokens and the elapsed time.

```
flow  plan opus-5-5·high 48,120 (9,800) ▸ ● EXECUTE sonnet-5-5·medium 1,204,331 (310,200) ▸ judge opus-5-5·high ▸ commit · Σ 1,342,455 (341,300)
  ├ ⠇ explore  haiku-5-5  [location_unknown] where is the save system serialized?  grep /Serialize/ in Scripts · 1 tool · 12,004 (2,100) tok · 4s
  ├ ✓ explore  haiku-5-5  [location_unknown] which scenes load the HUD prefab?  3 refs · 1 tool · 7s
  └ ⠇ advisor  opus-5-5   [error] NullReferenceException in SaveM…  read Scripts/SaveManager.cs:40-80 · 0s
```

While a plan executes, one more line sits under the pipeline: the stage, a step bar, the current step,
the judge round and the wait reason. Parts with nothing to show are left out.

```
  stage 2/3 · ███████░░░ 7/10 · now S8 Add the board · judge round 1 · waiting: approval
```

The session also writes `live.json` into the flow's plan folder (next to `status.json`, local only,
never committed): phase, stage, steps, judge round, wait reason, running subagents and the last 20
events. It is written when something changes and at least every 60 s. The plan folders sessions have
written to are listed in `<agent dir>/workflow/board.json` (50 newest), so a board can find flows
across repos. Sessions started before this existed write neither file.

`/flow board` opens an overlay of every flow on this machine (the registry plus this session's repos),
refreshed every 2 s. Classes, in this order: `●` running, `⏸` waiting, `○` stalled (unfinished, no live
session, changed within 7 days), `✓`/`✗` finished within 24 h; at most 30 rows. Each row shows title,
repo, phase, stage, a step bar, the current step or wait, and the age. Flows from sessions without
`live.json` show `no live data`. Keys: ↑↓ select, enter for the checklist, running subagents and the last
10 events, esc back or close. Without a TUI the list is sent as a notification. The board is read-only.

Token counts update in real time, including the message still streaming. A stage counts the main
session's messages sent while it was active plus the subagents run during it (explore and advisor
count toward the stage that called them, judge runs toward `judge`). Each count is the **exact raw
total**, cache reads and writes included in full, with the **cost-weighted** figure in brackets
(`tokenWeights`): uncached input 1, output 5, cache write 1.25, cache read 0.1, Claude's prices
relative to input. So `1,204,331 (310,200)` means 1,204,331 tokens of volume that cost what 310,200
uncached input tokens would. Every tool call re-sends the whole conversation, mostly as cache reads,
so the bracketed figure shows what that re-sending costs. Set all weights to 1 and the two figures
are equal. Counts saved by an older version are dropped when a session is resumed. The widget
counts the current flow; `/flow status` lists the whole session. Both survive a restart.

When a flow ends, a summary card goes into the transcript. It is display-only and never sent to the
model. A flow ends when the commit step finishes, when the judge passes and nothing gets committed, or
when you stop at the judge-rounds or plan-flaw menu. Then the widget starts again
from zero:

```
✓ flow done · committed and pushed · 12m04s
  opus-5-5 1,000,000 (260,000) · in 12,000 · out 30,000 · cache read 900,000 · cache write 58,000
  haiku-5-5 202,224 (55,300) · in 4,000 · out 8,000 · cache read 190,000 · cache write 224
  plan     █░░░░░░░░░░░░░░░░░░░     48,120 (9,800)   4%  opus-5-5 48,120 (9,800)
  execute  █████████████████░░░  1,044,100 (280,000) 87%  sonnet-5 920,000 (250,000) · explore haiku-5-5 ×6 124,100 (30,000)
  judge    █░░░░░░░░░░░░░░░░░░░     90,004 (21,300)   7%  judge opus-5-5 ×1 90,004 (21,300)
  commit   █░░░░░░░░░░░░░░░░░░░     20,000 (4,200)   2%  sonnet-5 20,000 (4,200)
```

The outcome says whether the commit really landed (HEAD moved), how many commits, whether it was pushed (nothing
ahead of upstream), and the pull request's state (`gh pr view`). `/flow tokens` shows the same card for the flow in progress. The header no longer sums across models: one line per model follows it (most expensive first, with its input, output, cache read and cache write counts), and each stage row names the model of every part. Summaries saved before this show the old card.

Every flow, finished or stopped, ends with this card, followed by the plan steps (done or open) and all
findings of the flow (open, fixed or noted). Both are built from the workflow state, so they cost no
model tokens. If a compaction hides the card, it is shown again once. When the judge fails to run or the
executor's reply ends in an error, a menu offers Retry, Back to planning and Stop (Escape stops).

When escalated, the phase's node turns yellow and shows `fable-5-1·high ↑`. The explore, advisor and
judge rows in the transcript stream the same rows while they run. Then they collapse to the result:
explore shows only its rows, advisor shows an 8-line preview, and judge shows its findings colored by
severity. Expand a row to see everything. Finished rows stay in the widget for 15 seconds after the
next run starts.

## Commands

| Command | Does |
|---|---|
| `/flow` | status: phase, the model for each role, config path |
| `/flow board` | live view of every flow on this machine (overlay, read-only) |
| `/flow discuss` / `plan` / `execute` / `off` | switch phase (`off` leaves the model alone). `/flow plan` from discuss also asks the planner for the `Plan:`; `/flow approve` in discuss does the same |
| `/flow test [scope]` | test phase: a strong supervisor plans tests, cheap runners run them, the report lists the bugs (without a scope, type it as the next message) |
| `/flow approve` | approve the plan: switch to execute and start (also offered when a plan ends) |
| `/flow delivery <commit\|push\|pr\|merge\|off>` | what happens after the judge passes, for the current flow |
| `/flow escalate` (`fable`) / `/flow back` (`opusplan`) | manual escalation and return |
| `/flow judge` | review the current diff now |
| `/flow tokens` | token breakdown of the current flow so far |
| `/flow model [role] [provider/id[:thinking]]` | set a role's model and save it to workflow.json; left out, it lists the roles, the models with auth and the thinking levels (Tab completes model IDs) |
| `/flow reload` | re-read workflow.json |
| `pi --flow execute` (`plan`, `test`, `off`) | start a session in a given phase |
| `/folders add <path>` / `remove <path\|n>` / `list` | folders that are part of this session (reloads Pi); Tab completes folder paths after `add` and folder numbers after `remove`; other extensions may replace or refuse the folder on `add` (K6) |
| `pi --add-dir <path>` | start a session with extra folders (`;` separates several on Windows, `:` elsewhere) |

## Several repos

A session has one working folder, but a flow can span more repos. The flow's repos are the working
folder's repo, the repos of the folders you add (`/folders add`, `--add-dir`; saved with the session),
and any repo where the executor changed a file with `edit` or `write`.

- The agent's prompt lists the extra folders and says to use absolute paths there. Their
  `AGENTS.md`/`CLAUDE.md` files are not loaded: the prompt lists their paths and sizes and tells the agent to read a folder's files before it plans or changes anything there (`addedFolderRules: "full"` loads them as before). Skills and prompts are loaded.
- The judge reviews every repo of the flow in one diff, each part headed `=== repo: <root> ===`, and
  re-reviews compare each repo with its last round.
- After a pass, each repo with changes gets its own commits and its own push/PR/merge. Each command
  is checked against the branch of the repo it runs in: the one named by `git -C` or the last `cd`,
  otherwise the working folder's.
- With only the working folder's repo, nothing changes.

Limits: `cd` does not move the guard when the command text has `$(…)`, backticks, or parentheses
outside quotes (such commands are checked against the working folder's branch); changes made
only through `bash` in an unlisted repo are not noticed (add the folder);
extensions in the added folders' `.pi/extensions` are not loaded; after `/resume`, run `/reload`
to pick up that session's folder skills.

## Prompt is too long

When pi compacts after a context overflow and retries, the claude-bridge provider can answer the
retry with an empty reply and the run stops. The workflow then sends a `workflow-resume` message
(at most 2 per prompt) telling the model to continue from the summary.

Subagents run `pi --no-extensions` and load only the extensions in `subagent.extensions` (the
claude-bridge provider). That way the pi-config sync and this extension don't run inside them. If a
role uses a provider from another extension, add it there.

`subagent.timeoutMs` (default 15 minutes) is a hard limit on one subagent run. `subagent.idleTimeoutMs`
(default 5 minutes) ends a run that writes nothing for that long, with the error `stalled: no output for
Ns`. The idle timer pauses while a tool runs, so a long build is not cut off. `0` turns it off.
