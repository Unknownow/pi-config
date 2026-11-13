# Shared code

Code that more than one extension uses. The folder has no `index.ts`, so pi does not load it as an extension; the extensions import its files directly. It imports nothing from any extension (`boundary.test.ts`), so the agents, workflow and worktree extensions can each work without the others.

| File | What | Used by |
|---|---|---|
| `readonly-bash.ts` | Shell parser (`parseCommands`, `KEYWORDS`, `WRAPPERS`, `unwrapCommand`) and the read-only command policy (`commandReadOnlyProblem`, `readOnlyProblem`, `UNITY_PLAN_ALLOW`). | workflow, agents (runner guard), worktree (Unity guard) |
| `readonly-tools.ts` | Read-only tool gate: `PLAN_TOOLS` (reading tools by name), `planToolRefused`, `phaseToolRefusal`, `planToolProblem` (bash text and run_code JavaScript checks). | workflow (discuss and plan phase), orchestrate (orchestrator mode) |
| `repos.ts` | Repo roots of a command (`repoTexts`, `repoKey`, `uniqueRoots`, worktree and `--add-dir` parsing). Tested with the push guard in `workflow/repos.test.ts`. | workflow, agents |
| `tokens.ts` | Token counts: raw and cost-weighted (`countTokens`, `DEFAULT_TOKEN_WEIGHTS`), the per-kind counts and their formatting. | workflow, agents |
| `runs.ts` | Run cards: one row per sub-agent run (`newRun`, `applyEvent`, `endRun`, `runLine`, `shortModel`). | agents (tool rows), workflow (widget, via `FlowRun`) |
| `roles.ts` | Role specs `provider/id[:thinking]` (`parseRoleSpec`, `describeRole`, `THINKING_LEVELS`), the model list, Tab completions and the model picker. | `/agents model`, `/flow model` |
| `notify.ts` | Desktop notification command per platform (`notifyCommand`). | workflow, orchestrate |
| `claims.ts` | The claim pattern over the event bus (`emitClaims`, `gatherClaims`): listeners call `claim(promise)` during the emit; the first non-null answer wins. | workflow K9-K11, orchestrate |

Changing an export's name, signature or meaning changes every extension that uses it; run all their tests.

Tests: `node --experimental-strip-types --test claims.test.ts readonly-bash.test.ts readonly-tools.test.ts tokens.test.ts runs.test.ts roles.test.ts boundary.test.ts notify.test.ts`
