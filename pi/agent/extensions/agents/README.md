# agents extension

Subagent roles that run as separate `pi` processes: a toolbox in every session and the library other
extensions use for their reviews and helpers. `~/.pi/agent/extensions/agents/index.ts` loads on its own;
settings are in `~/.pi/agent/agents.json` (missing keys use the defaults in `config.ts`, unknown keys are
ignored; `modelCost` keeps every key).

| Tool / role | What it does |
|---|---|
| `explore` (role `explore`, Haiku, thinking medium) | Parallel sub-`pi` processes answer open questions and multi-file searches with `Answer:` plus `Evidence:` (file:line). Known files are read directly. They run without `AGENTS.md`/`CLAUDE.md` files (`explore.contextFiles: true` loads them) and with a budget of about 10 tool calls per question. Up to `explore.maxQueries` (8) queries per call, `explore.concurrency` (8) at once. |
| `advisor` (role `advisor`, Opus, thinking medium) | A sub-`pi` reads the whole session transcript (`advisor.maxTranscriptChars`) and returns guidance: choosing an approach, after an error repeats, before "done". Use it sparingly. |
| `test_run` (role `runner`, Haiku low) | Runs test task cards (`id`, `run`, `observe`, `pass`, `resource`) on runner sub-processes. Tasks with the same resource (`unity:<project folder>`, `device:<serial>`) run one after another, across processes too (see "Resource lock"); the rest in parallel, up to `test.concurrency` (4), `test.maxTasks` (8) per call, `test.runnerTimeoutMs` each. A record per task (card, reply, every bash command with the start of its result) goes to `<temp>/pi-test-runs/session-<pid>/runs/1/<call>/<id>.md`; the tool result names the artifacts folder. |
| `judge` (role `judge`, Opus, thinking medium) | Adversarial read-only review of the session's change: for the working folder's git repo and every repo of the newest `session-folders` entry for this working folder, the diff against `git merge-base HEAD <origin default branch>` (`refs/remotes/origin/HEAD`, else `origin/main`, else `origin/master`, else `HEAD`) plus uncommitted and untracked files; `base` overrides. Every call is a full review; the previous call's findings in this session are passed in. Params `base?`, `focus?`, `disputes?`, `full?`. Another extension can take the call over (`agents:judge-call`). |
| `critic` (role `critic`, Opus, thinking medium) | Adversarial read-only review of a document against the code. Params `document` (text or a file path), `about` (one line), `criteria?`, `output?`. |

Both reviewer tools say when to use them: when the user asks for a review, or when the current instructions
(e.g. an active workflow) require it. Nothing gates on them in a normal session.

## Contract

**Agents runs subagent roles:** the process (`runSubagent`), the model and thinking level (`agents.json`
`roles`), the base prompt, the tools, read-only enforcement for reviewers (`reviewer.ts`), team knowledge
(forwarding and the judge's knowledge step), usage and cost (`costOf`, `agents:subagent-finished`, the
usage file) and findings parsing (`../shared/findings.ts`).

**Callers decide** when a role runs, how many rounds, caps, the spec / criteria / extra-output text, and
what a verdict means for them (a gate, a fix round, nothing).

Generic roles (`explore`, `advisor`, `runner`, `judge`, `critic`) live here. An extension-specific role
starts its process through `runSubagent` with its own prompt. The one exception is a long-lived
interactive session (relay's RPC worker), which is not a one-shot subagent.

Used by: workflow (sub-agent runner, rendering, prompts, knowledge, the `agents:judge-call` takeover),
relay (next: `runJudge`, `runCritic`, its workers load agents).

### API (`api.ts`, the only file to import)

| Export | What |
|---|---|
| `runSubagent`, `RunOptions`, `RunResult`, `ToolCall`, `SubagentEvent`, `addUsage`, `emptyUsage`, `mapLimit`, `expandHome` | One `pi` process in JSON print mode with its own model, tools and prompts. |
| `runRole`, `RoleRun`, `knowledgeFor`, `EventSink`, `McpServer` | Runs an agents role: config model, knowledge tools, run row, finished event, usage file. |
| `runJudge(req)`, `JudgeRequest`, `DiffPart`, `fitDiffs`, `judgePrompt`, `collectDiffParts` | Code review, read-only. `req`: `diff` (text, or `DiffPart[]` `{ key, base, full, names }` fitted to `judge.maxDiffChars`), `files?` (knowledge step; default the parts' names), `spec?`, `criteria?`, `output?`, `previousFindings?`, `disputes?`, `focus?`, `mode: "full" \| "incremental"`, `cwd`, `signal?`, `onUpdate?` (a tool's update callback), `onRun?`, `runId?`, `events?`, `mcpServers?` (`pi.getMcpServers()`; without it no knowledge). Incremental: the diff is only the change since the last round; the judge rechecks each previous finding and tags a problem it could have found earlier `[late]`. |
| `runCritic(req)`, `CriticRequest`, `criticPrompt` | Document review, read-only. `req`: `document`, `about`, `criteria?`, `output?`, `previousFindings?`, `disputes?`, `cwd`, `signal?`, `onUpdate?`, `onRun?`, `runId?`, `events?`, `mcpServers?`. |
| `ReviewResult`, `reviewVerdict` | Both return `{ ok, text, findings, verdict, usage, weightedCost, model, error? }`. Verdict: `isClean(judgeVerdict(text), parseFindings(text))` (a late major does not block). |
| `parseFindings`, `judgeVerdict`, `isClean`, `Finding` | Re-exported from `../shared/findings.ts`. |
| `costOf(usage, model)`, `modelMultiplier` | `countTokens(usage, DEFAULT_TOKEN_WEIGHTS).cost × modelCost multiplier`. |
| `AGENT_ROLES`, `AgentRole`, `AgentsConfig`, `DEFAULTS`, `CONFIG_PATH`, `loadConfig`, `saveRole`, `parseModelCost`, `KnowledgeConfig` | Role config. |
| `renderRuns`, `toolProgress`, `ToolDetails` | Live run rows of a tool and its result rendering. |
| `PACE`, `ADVISOR`, `EXPLORE`, `RUNNER`, `JUDGE`, `CRITIC`, `JUDGE_INCREMENTAL`, `judgeKnowledgeStep`, `knowledgeTools` | Prompts. |
| `toolPrefix`, `forwardedServers`, `roleTools` | Team knowledge tool names and the forwarded MCP server config. |
| `acquireLock`, `HeldLock`, `LockOptions` | The cross-process resource lock. |

Reviewer prompts (`prompts.ts`): the findings format is fixed,
`- blocker|major|minor - [category] \`path:line\` - title fix: auto|user` with `Why:` and `Fix:` body lines,
`[plan]` for a problem with the spec or document itself, and a last `VERDICT: PASS|FAIL` line. A caller's
`criteria` and `output` are appended as sections; `output` only adds sections after the findings.
With knowledge on (`mcpServers` given, `knowledge.server` set, the role in `knowledge.roles`) and
`knowledge.judgeCheck`, the judge ends with a knowledge step over `files`; a deviation from a recommended
rule is `- minor - [knowledge <rule-id>] \`path:line\` - … fix: user` with Rule / Code / Reason / Impact /
To follow it lines.

### Events

- `agents:subagent-finished` `{ role, label, ms, usage, model, ok, error, bootMs, turns, tools, weightedCost }`
  after every run of a tool or of `runJudge`/`runCritic` (given `events`). `weightedCost` is cost-weighted
  input-token equivalents × the model's `modelCost` multiplier, a unit across models; it is not pi's dollar
  `usage.cost`. The workflow counts these while a flow is active.
- `agents:judge-call` `{ v: 1, params, ctx, signal, onUpdate, claim }`, emitted by the `judge` tool before it
  runs its own review (`emitClaims` of `../shared/claims.ts`, no timeout). A listener calls `claim(promise)`
  synchronously. A non-null answer has the tool-result shape `{ content, details?, usage? }` and is returned
  unchanged; an answer `{ error }` (or a rejected claim) becomes a thrown tool error; null or undefined falls
  back to the agents judge. The workflow claims it while a flow is on (`workflow/judge-claim.ts`).

### Environment

| Variable | Set by | Effect |
|---|---|---|
| `PI_AGENTS_TOOLS` | a parent loading agents into a worker | Comma list; only these agents tools are registered. |
| `PI_AGENTS_ADVISOR_CAP` | same | The advisor refuses after that many calls in the process, with a message saying so. |
| `PI_AGENTS_USAGE_FILE` | same | Every finished subagent run of the process (tools and `runJudge`/`runCritic`) appends `{ role, model, usage, weightedCost, ok, at }` as one JSON line. |
| `PI_AGENTS_MCP` | agents, in a subagent | The forwarded MCP servers (`mcp-forward.ts`). |
| `PI_AGENTS_RUNNER_GUARD` | agents, in a runner | The runner guard's settings (`runner-guard.ts`). |
| `PI_AGENTS_REVIEW_ALLOW` | agents, in a judge or critic | Tools `reviewer.ts` lets through besides read, grep, find and ls (the knowledge tools). |

## Details

- **Not while planning.** `test_run` is refused in the workflow's discuss and plan phases (runner bash is not read-only); it works in normal mode, execute and the test phase. `critic` is read-only and kept in every phase.
- **Runner results are claims.** The tool result lists the commands the runner actually ran (from its tool calls). A PASS or FAIL with no bash call, or a PASS with a failed command, is marked `unverified`: rerun it.
- **Runner guard** (`runner-guard.ts`, loaded only in runner sub-processes): refuses git and gh commands that change anything, commands matching `test.runnerDeny` (`adb reboot` and friends, `adb shell rm -r`, wipe, recovery, format, `fastboot`), a project path after a flag in `test.runnerPathFlags` that lies outside the session's folders (the working folder, its repo, the added folders, counted only from the `session-folders` entry for the current working folder) or cannot be checked, and assigning a name from `test.runnerPathEnv`. It is a guard against drift, not a sandbox.
- **Resource lock** (`lock.ts`): `runnerGate`'s `hold(resource, fn, signal?)` waits for the resource in this process, then for its lock file under `<temp>/pi-agents-locks/` (named by a hash of the normalised resource), then for a runner slot; every wait stops on abort. The lock file is created with `wx` and holds the owner token and a heartbeat (refreshed every 30 s); a lock whose owner pid is dead or whose heartbeat is over 2 min old is taken over under a `<name>.takeover` guard file.
- **Read-only reviewers** (`reviewer.ts`, loaded only in judge and critic sub-processes): refuses every tool but read, grep, find, ls and the tools in `PI_AGENTS_REVIEW_ALLOW`.
- **Team knowledge**: the roles in `knowledge.roles` (`explore`, `advisor`, `judge`, `critic`) get the knowledge server's read tools, each sub-process starting its own copy through `mcp-forward.ts`.
- **Cost**: `modelCost` maps parts of a model id to a multiplier (`haiku` 0.2, `sonnet` 0.6, `opus` 1.0); the longest key that is a case-insensitive substring of the id wins, no match is 1.0. An invalid map falls back to the defaults with a warning.
- **Models**: `/agents model [explore|advisor|runner|judge|critic] [provider/id[:thinking]]` edits `agents.json` (left out, it asks for the role, then the model and thinking level; Tab completes both). `/agents status` (or `/agents`) lists each role's model and the config path. A change applies from the next call. Until the workflow uses the agents reviewers, `/flow model judge` sets the workflow's own judge role, used for flow reviews.
- **Files**: `api.ts` (public API), `subagent.ts` (the sub-`pi` runner), `run-role.ts` (a role run: config, knowledge, event, usage file), `review.ts` (`runJudge`, `runCritic`, `fitDiffs`, prompt assembly), `cost.ts`, `lock.ts`, `env.ts` (the `PI_AGENTS_*` options), `mcp-forward.ts`, `runner-guard.ts` and `reviewer.ts` (loaded by the sub-processes), `test-run.ts` (pure parts of `test_run`), `render.ts`, `prompts.ts`, `config.ts`, `types.ts`. Shared code (shell parser, repo helpers, git diff, session folders, token counts, run cards, role specs, findings, claims) comes from `../shared/`; nothing is imported from workflow, relay or worktree (`boundary.test.ts` checks this).

Tests: `node --experimental-strip-types --test *.test.ts` (`test-hooks.ts` stubs the pi packages for the tests that load the extension).

## Completions

`/agents ` offers `status` and `model`; `model` walks role → models with auth → thinking level (`provider/id:<level>`). The subcommand table is in `commands.ts`.
