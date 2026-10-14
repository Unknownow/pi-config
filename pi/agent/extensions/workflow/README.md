# workflow

Each kind of work gets its own model. Every model and thinking level is set in `~/.pi/agent/workflow.json`.
The workflow is for software: system design, architecture and code. (The name stays `workflow`: the
pi-config sync never deletes, so renaming the folder would leave the old extension loaded beside the new one.)

```
you <-> plan (Opus 5.5, high) -> approve -> final plan (Opus) -> execute (Sonnet 5.5, medium) -> judge (Opus 5.5) -> commit
                                                              ^                          |-- explore (Haiku 5.5, parallel): answer + file:line
                                                              |                          `-- advisor (Opus 5.5): reads the full transcript
                                                              `-- fix findings <------- judge (separate session; sees the plan and the diff, not the discussion)
                                             judge says the plan is flawed -> you decide, or the arbiter (Fable 5.1) does
escalation (manual): /flow escalate -> Fable 5.1 (high), /flow back
context guard:       compacts at ~140k tokens on every model, after the run settles
plan is read-only:   bash refuses commands that change files, git or GitHub
```

| Role | Runs as | When |
|---|---|---|
| `plan` | main session model; edit/write off, bash read-only | new sessions start here (`startPhase`). Discuss, investigate, agree; after approval it writes the final execution plan (`finalizePlan`) |
| `execute` | main session model | after you approve the plan |
| `explore` | `explore` tool, parallel sub-`pi` processes | plan and execute send open questions and multi-file searches to it; it decides how much to read and answers with `Answer:` plus `Evidence:` (file:line). Known files are read directly. Judge and advisor do not use it |
| `advisor` | `advisor` tool, sub-`pi` with the whole transcript | choosing an approach, after an error repeats (auto-nudged after `repeatedErrorThreshold` failures), before "done" |
| `judge` | `judge` tool, sub-`pi` with the git diff | the diff is ready; when a run ends with an unreviewed diff it asks (`autoJudge`) |
| `arbiter` | sub-`pi` with the plan, the judge's report and the diff | the judge questions the plan and `planFlaw` is `auto` (or you pick "Let the arbiter decide") |
| `escalate` | main session model | `/flow escalate` |

## Hands-off run

You discuss the plan with the planner. After every finished planner reply, an **Approve** menu
pops up (`planPrompt`): one `Approve → <delivery>` entry per delivery (see below), the default first, then
Keep discussing. Right after such a reply you can also type a short approval
as the whole message (a second menu then asks for the delivery; Escape takes the default):
"go", "ok go", "lgtm", "do it", "do it for me", "yeah do that", "implement the plan", "ship it" and
the like; see `approvePattern`. Longer messages ("do it but skip step 3") keep planning, and so does "yes, do that" when the last
reply had no "Plan:" section or ended with a question (it answers a question). Everything
after approval runs on its own:

```
"go" -> final plan (Opus) -> execute (Sonnet) -> judge (auto) -> FAIL: fix and judge again (menu after 5 rounds)
                                                              -> PASS: commit, split by function [-> push -> pull request -> merge, as chosen at approval]
```

- **Delivery** (chosen for each flow at approval; `delivery` in workflow.json): `commit` only (default),
  `push`, `pr` (also opens a pull request, or reuses the branch's open one), `merge` (also waits for the
  checks with `gh pr checks --watch`, then `gh pr merge --merge --delete-branch`), or `off`. Commits are split by
  function (`splitCommits`): one per feature, fix, refactor, config or docs change, with its tests; the
  final plan lists them in its Commits section. In `pr`/`merge` mode on a protected branch or a detached
  HEAD the commits go on a new branch, `branchPrefix` + a slug of the plan title, and the pull request
  targets the branch the flow started on (`base` overrides it). It never approves a pull request and never
  uses `--admin` or `--auto`: a merge GitHub blocks (review required, conflict, failed check) stops and is
  reported. `/flow delivery <commit|push|pr|merge|off>` changes it for the current flow.
  `mergeMethod` (`merge`), `deleteBranch` (`true`), `ask` (`true`) and `default` (`commit`) are configurable.
- **Push guard:** it never pushes `protectedBranches` (`main`, `master`) or a detached HEAD. It
  commits there and tells you. It never force-pushes or uses `--no-verify`, and stops if a hook fails.
  This is enforced, not only asked for: while executing, a `git push` is refused unless it is the
  workflow's own commit-and-push step, and force pushes, deletes, `+refspec`s, pushes to a protected
  branch, `--no-verify` and changes to `core.hooksPath` / `GIT_CONFIG_*` are always refused (`push-guard.ts`).
  `gh pr create` and `gh pr merge` (and `gh api` calls that open or merge one) are refused unless the flow's
  delivery includes them and its commit step is running; `gh pr merge --admin` / `--auto` and `gh pr review --approve`
  are always refused.
  Like the plan-phase checks it reads the command text: a guard against a drifting executor, not a sandbox.
- **Minor findings:** a passed review with fixable minor findings goes back to the executor for up to `maxMinorRounds`
  (default 2, `0` commits at once) fix rounds, then commits anyway. Fix them, or dispute a wrong one. `[knowledge ...]` and
  `[plan-flaw]` findings never start a round.
- **Where it stops for you:** when the judge fails `maxJudgeRounds` (5; 0 means no limit) times in a
  row it asks: keep fixing, escalate and keep fixing, or stop. It also stops when something errors.
- **Judge rounds after the first** review only what changed since the last round: a fresh judge gets
  that round's findings, the changes since, and the names of every file in the change, at
  `judge.recheckThinking` (medium). Calling it again with no changes returns the last result. It
  falls back to a full review after a commit, rebase or branch switch, or when the changes since are
  over `judge.recheckMaxShare` (half) of the whole diff. A change over
  `judge.finalFullReviewOverChars` (80,000 characters) that passes a re-review gets one final full
  review; the judge tool's `full: true` forces one. `"judge": { "recheck": false }` turns it off.
- **Disputes:** if the executor thinks a finding is wrong it passes the finding and its file:line
  evidence in the judge tool's `disputes` parameter. The judge treats that as a claim, decides it from
  the code, and drops the finding only if the code shows the executor is right.
- **Turning steps back to manual:** set `"autoJudge": "ask"`, `"delivery": { "default": "off" }`
  (nothing is committed unless you pick it at approval), and `"planPrompt": false` for a "say go" hint instead of the Approve menu.

## The plan, the judge and the arbiter

- **Plan phase** is for discussion: investigate, answer questions, weigh options, agree. Replies end
  with a short `Plan:` section once the talk is heading toward a change. When you approve, the
  planner writes the **final plan** in one more reply (`finalizePlan`, default on): goal and
  non-goals, your decisions (D1, D2, ...), facts with file:line, a design section for changes that
  add or reshape components, steps, tests, "done when", risks. The execute model follows it literally
  and the judge checks the result against it. With `finalizePlan: false` the last `Plan:` reply is used.
- **Execute** follows the plan exactly, in order. It stops and says so when a step cannot be done as
  written. It never commits or pushes.
- **The judge** runs in its own session. It sees the approved plan and the diff, not the discussion,
  and assumes the change is wrong. What it trusts:

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
  The arbiter cannot change your decisions or the goal. A plan flaw blocks the commit until resolved.

## Plan phase is read-only

Only tools matching `planAllowedTools` (regexes over the tool name) can be called: read, grep, find,
ls, bash, codemode, explore, advisor, judge, read-only ctx_* tools and MCP tools named search/get/list/...
Everything else (AskClaude, `propose_entry`, `ctx_purge`, edit, write) is hidden and refused.
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
- Also allowed on purpose: `git fetch` (it only updates remote-tracking refs), and the knowledge-base tools
  `ctx_index` / `ctx_fetch_and_index`. `git help <topic>` is refused (it opens a viewer), as are `rg --pre`,
  `ag --pager`, `less -o`, `date -s`, `hostname <name>`, `git diff --ext-diff` / `--textconv`.
- A repository's own git config (`core.fsmonitor`, `diff.external`, textconv) can still run programs on a
  plain `git status` / `git diff`: plan an untrusted repo in a throwaway clone.
- **context-mode tools** (`readonly-tools.ts`) are checked too. `ctx_execute` and
  `ctx_execute_file` with `shell` language get the shell check. With `javascript` or `python`
  they are refused when the code writes, deletes, runs programs, `eval`s, or sends a POST, PUT,
  PATCH or DELETE request, or build names at runtime (`fs['wri'+'te']`, `require(x)`, `getattr`, a
  `open()` mode that is not a plain read literal). Other languages are refused. `ctx_batch_execute`
  checks each command. MCP tools are also refused when an argument holds a statement that changes data
  (`INSERT`, `UPDATE ... SET`, `DELETE FROM`, `DROP`, a GraphQL `mutation`, ...).
  `ctx_purge` is refused.
- Shell text on Windows: `ctx_execute` and `ctx_batch_execute` run PowerShell, so a command is
  checked as a shell command, and PowerShell-only cmdlets (`Set-Content`, `Remove-Item`, ...) are
  refused because they are not on the list.
- It is a guard against the planner drifting into execution, not a sandbox. The code checks are
  regexes: a determined disguise (a computed lookup on an alias of `require('fs')`, say) can still get
  past them.
- Tests: `node --experimental-strip-types --test agent-end.test.ts readonly-bash.test.ts readonly-tools.test.ts tokens.test.ts push-guard.test.ts knowledge.test.ts mcp-forward.test.ts subagent.test.ts delivery.test.ts`.

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
✓ flow done · committed and pushed · 1,202,224 (315,300) tokens · 12m04s
  plan     █░░░░░░░░░░░░░░░░░░░     48,120 (9,800)   4%  opus-5-5 48,120 (9,800)
  execute  █████████████████░░░  1,044,100 (280,000) 87%  sonnet-5 920,000 (250,000) · explore ×6 124,100 (30,000)
  judge    █░░░░░░░░░░░░░░░░░░░     90,004 (21,300)   7%  judge ×1 90,004 (21,300)
  commit   █░░░░░░░░░░░░░░░░░░░     20,000 (4,200)   2%  sonnet-5 20,000 (4,200)
```

The outcome says whether the commit really landed (HEAD moved), how many commits, whether it was pushed (nothing
ahead of upstream), and the pull request's state (`gh pr view`). `/flow tokens` shows the same card for the flow in progress.

When escalated, the phase's node turns yellow and shows `fable-5-1·high ↑`. The explore, advisor and
judge rows in the transcript stream the same rows while they run. Then they collapse to the result:
explore shows only its rows, advisor shows an 8-line preview, and judge shows its findings colored by
severity. Expand a row to see everything. Finished rows stay in the widget for 15 seconds after the
next run starts.

## Commands

| Command | Does |
|---|---|
| `/flow` | status: phase, the model for each role, config path |
| `/flow plan` / `execute` / `off` | switch phase (`off` leaves the model alone) |
| `/flow approve` | approve the plan: switch to execute and start (also offered when a plan ends) |
| `/flow delivery <commit\|push\|pr\|merge\|off>` | what happens after the judge passes, for the current flow |
| `/flow escalate` (`fable`) / `/flow back` (`opusplan`) | manual escalation and return |
| `/flow judge` | review the current diff now |
| `/flow tokens` | token breakdown of the current flow so far |
| `/flow model <role> <provider/id[:thinking]>` | set a role's model and save it to workflow.json |
| `/flow reload` | re-read workflow.json |
| `pi --flow execute` | start a session in a given phase |

## Prompt is too long

When pi compacts after a context overflow and retries, the claude-bridge provider can answer the
retry with an empty reply and the run stops. The workflow then sends a `workflow-resume` message
(at most 2 per prompt) telling the model to continue from the summary.

Subagents run `pi --no-extensions` and load only the extensions in `subagent.extensions` (the
claude-bridge provider). That way the pi-config sync and this extension don't run inside them. If a
role uses a provider from another extension, add it there.
