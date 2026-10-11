# workflow

Each kind of work gets its own model. Every model and thinking level is set in `~/.pi/agent/workflow.json`.

```
you -> plan (Opus 5.5, high) -> approve -> execute (Sonnet 5.5, medium) -> judge (Opus 5.5) -> commit
                                              |-- explore (Haiku 5.5, parallel): file:line only
                                              `-- advisor (Opus 5.5): reads the full transcript
escalation (manual): /flow escalate -> Fable 5.1 (high), /flow back
context guard:       compacts at ~140k tokens on every model
```

| Role | Runs as | When |
|---|---|---|
| `plan` | main session model; edit/write off | new sessions start here (`startPhase`) |
| `execute` | main session model | after you approve the plan |
| `explore` | `explore` tool, parallel sub-`pi` processes | the executor fans out reads/greps |
| `advisor` | `advisor` tool, sub-`pi` with the whole transcript | choosing an approach, after an error repeats (auto-nudged after `repeatedErrorThreshold` failures), before "done" |
| `judge` | `judge` tool, sub-`pi` with the git diff | the diff is ready; when a run ends with an unreviewed diff it asks (`autoJudge`) |
| `escalate` | main session model | `/flow escalate` |

## Commands

| Command | Does |
|---|---|
| `/flow` | status: phase, the model for each role, config path |
| `/flow plan` / `execute` / `off` | switch phase (`off` leaves the model alone) |
| `/flow approve` | approve the plan: switch to execute and start (also offered when a plan ends) |
| `/flow escalate` (`fable`) / `/flow back` (`opusplan`) | manual escalation and return |
| `/flow judge` | review the current diff now |
| `/flow model <role> <provider/id[:thinking]>` | set a role's model and save it to workflow.json |
| `/flow reload` | re-read workflow.json |
| `pi --flow execute` | start a session in a given phase |

Subagents run `pi --no-extensions` and load only the extensions in `subagent.extensions` (the
claude-bridge provider). That way the pi-config sync and this extension don't run inside them. If a
role uses a provider from another extension, add it there.
