# workflow

Each kind of work gets its own model. Every model and thinking level is set in `~/.pi/agent/workflow.json`.

```
you -> plan (Opus 5.5, high) -> approve -> execute (Sonnet 5.5, medium) -> judge (Opus 5.5) -> commit
                                              |-- explore (Haiku 5.5, parallel): file:line only
                                              `-- advisor (Opus 5.5): reads the full transcript
escalation (manual): /flow escalate -> Fable 5.1 (high), /flow back
context guard:       compacts at ~140k tokens on every model, after the run settles
plan is read-only:   bash refuses commands that change files, git or GitHub
```

| Role | Runs as | When |
|---|---|---|
| `plan` | main session model; edit/write off, bash read-only | new sessions start here (`startPhase`) |
| `execute` | main session model | after you approve the plan |
| `explore` | `explore` tool, parallel sub-`pi` processes | fallback when normal search is not enough; every call names its `reason` |
| `advisor` | `advisor` tool, sub-`pi` with the whole transcript | choosing an approach, after an error repeats (auto-nudged after `repeatedErrorThreshold` failures), before "done" |
| `judge` | `judge` tool, sub-`pi` with the git diff | the diff is ready; when a run ends with an unreviewed diff it asks (`autoJudge`) |
| `escalate` | main session model | `/flow escalate` |

## Hands-off run

You discuss the plan with the planner. When a reply ends with a numbered plan, an **Approve / Keep
planning** menu pops up (`planPrompt`). Right after such a reply you can also type a short approval
as the whole message:
"go", "ok go", "lgtm", "do it", "do it for me", "yeah do that", "implement the plan", "ship it" and
the like; see `approvePattern`. Longer messages ("do it but skip step 3") keep planning, and so does
"yes, do that" when the last reply had no plan (it answers a question). Everything
after approval runs on its own:

```
"go" -> execute (Sonnet) -> judge (auto) -> FAIL: fix and judge again (max 3 rounds)
                                         -> PASS: commit -> push the current branch
```

- **Push guard:** it never pushes `protectedBranches` (`main`, `master`) or a detached HEAD. It
  commits there and tells you. It never force-pushes or uses `--no-verify`, and stops if a hook fails.
- **Where it stops for you:** when the judge fails `maxJudgeRounds` times in a row, or something errors.
- **Judge rounds after the first** review only what changed since the last round: a fresh judge gets
  that round's findings, the changes since, and the names of every file in the change, at
  `judge.recheckThinking` (medium). Calling it again with no changes returns the last result. It
  falls back to a full review after a commit, rebase or branch switch, or when the changes since are
  over `judge.recheckMaxShare` (half) of the whole diff. A change over
  `judge.finalFullReviewOverChars` (80,000 characters) that passes a re-review gets one final full
  review; the judge tool's `full: true` forces one. `"judge": { "recheck": false }` turns it off.
- **Turning steps back to manual:** set `"autoJudge": "ask"`, `"autoCommit": "ask"` (or `"commit"` /
  `"off"`), and `"planPrompt": false` for a "say go" hint instead of the Approve menu.

## Plan phase is read-only

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
- **context-mode tools** (`readonly-tools.ts`) are checked too. `ctx_execute` and
  `ctx_execute_file` with `shell` language get the shell check. With `javascript` or `python`
  they are refused when the code writes, deletes, runs programs, `eval`s, or sends a POST, PUT,
  PATCH or DELETE request. Other languages are refused. `ctx_batch_execute` checks each command.
  `ctx_purge` is refused.
- Shell text on Windows: `ctx_execute` and `ctx_batch_execute` run PowerShell, so a command is
  checked as a shell command, and PowerShell-only cmdlets (`Set-Content`, `Remove-Item`, ...) are
  refused because they are not on the list.
- It is a guard against the planner drifting into execution, not a sandbox. Code built at runtime
  (`eval` of a string, an aliased import) can get past the word checks.
- Tests: `node --test readonly-bash.test.ts readonly-tools.test.ts`.

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
when the automatic judge loop stops after `maxJudgeRounds` failures. Then the widget starts again
from zero:

```
✓ flow done · committed and pushed · 1,202,224 (315,300) tokens · 12m04s
  plan     █░░░░░░░░░░░░░░░░░░░     48,120 (9,800)   4%  opus-5-5 48,120 (9,800)
  execute  █████████████████░░░  1,044,100 (280,000) 87%  sonnet-5 920,000 (250,000) · explore ×6 124,100 (30,000)
  judge    █░░░░░░░░░░░░░░░░░░░     90,004 (21,300)   7%  judge ×1 90,004 (21,300)
  commit   █░░░░░░░░░░░░░░░░░░░     20,000 (4,200)   2%  sonnet-5 20,000 (4,200)
```

The outcome says whether the commit really landed (HEAD moved) and whether it was pushed (nothing
ahead of upstream). `/flow tokens` shows the same card for the flow in progress.

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
| `/flow escalate` (`fable`) / `/flow back` (`opusplan`) | manual escalation and return |
| `/flow judge` | review the current diff now |
| `/flow tokens` | token breakdown of the current flow so far |
| `/flow model <role> <provider/id[:thinking]>` | set a role's model and save it to workflow.json |
| `/flow reload` | re-read workflow.json |
| `pi --flow execute` | start a session in a given phase |

Subagents run `pi --no-extensions` and load only the extensions in `subagent.extensions` (the
claude-bridge provider). That way the pi-config sync and this extension don't run inside them. If a
role uses a provider from another extension, add it there.
