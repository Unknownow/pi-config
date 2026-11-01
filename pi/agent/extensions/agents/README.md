# agents extension

Helpers that run as separate `pi` processes, usable in every session — with or without a flow.
`~/.pi/agent/extensions/agents/index.ts` loads on its own; settings are in `~/.pi/agent/agents.json`
(missing keys use the defaults in `config.ts`, unknown keys are ignored).

| Tool / role | What it does |
|---|---|
| `explore` (role `explore`, Haiku, thinking medium) | Parallel sub-`pi` processes answer open questions and multi-file searches with `Answer:` plus `Evidence:` (file:line). Known files are read directly. They run without `AGENTS.md`/`CLAUDE.md` files (`explore.contextFiles: true` loads them) and with a budget of about 10 tool calls per question. Up to `explore.maxQueries` (8) queries per call, `explore.concurrency` (8) at once. |
| `advisor` (role `advisor`, Opus) | A sub-`pi` reads the whole session transcript (`advisor.maxTranscriptChars`) and returns guidance: choosing an approach, after an error repeats, before "done". Use it sparingly. |
| `test_run` (role `runner`, Haiku low) | Runs test task cards (`id`, `run`, `observe`, `pass`, `resource`) on runner sub-processes. Tasks with the same resource (`unity:<project folder>`, `device:<serial>`) run one after another; the rest in parallel, up to `test.concurrency` (4), `test.maxTasks` (8) per call, `test.runnerTimeoutMs` each. A record per task (card, reply, every bash command with the start of its result) goes to `<temp>/pi-test-runs/session-<pid>/runs/1/<call>/<id>.md`; the tool result names the artifacts folder. |

- **Not while planning.** `test_run` is refused in the workflow's discuss and plan phases (runner bash is not read-only); it works in normal mode, execute and the test phase.
- **Runner results are claims.** The tool result lists the commands the runner actually ran (from its tool calls). A PASS or FAIL with no bash call, or a PASS with a failed command, is marked `unverified`: rerun it.
- **Runner guard** (`runner-guard.ts`, loaded only in runner sub-processes): refuses git and gh commands that change anything, commands matching `test.runnerDeny` (`adb reboot` and friends, `adb shell rm -r`, wipe, recovery, format, `fastboot`), a project path after a flag in `test.runnerPathFlags` that lies outside the session's folders (the working folder, its repo, the folders added with `/folders`) or cannot be checked, and assigning a name from `test.runnerPathEnv`. It is a guard against drift, not a sandbox.
- **Team knowledge**: the roles in `knowledge.roles` (`explore`, `advisor`) get the knowledge server's read tools, each sub-process starting its own copy through `mcp-forward.ts`.
- **Models**: `/flow model explore|advisor|runner <provider/id[:thinking]>` edits `agents.json`.
- **Flow tracking**: after every run the extension emits `pi.events.emit("agents:subagent-finished", { role, label, ms, usage, model, ok, error, bootMs, turns, tools })`. The workflow extension listens while a flow is active: it adds the usage to the stage's tokens, writes a `subagent` line to `metrics.jsonl` and, for the advisor, resets the repeated-error counter. Outside a flow nothing listens.
- **Files**: `subagent.ts` (the sub-`pi` runner), `mcp-forward.ts` and `runner-guard.ts` (loaded by the sub-processes), `test-run.ts` (pure parts of `test_run`), `render.ts` (live rows and result rendering, shared with the workflow's judge), `prompts.ts`, `config.ts`, `types.ts`. `runner-guard.ts` imports `../workflow/readonly-bash.ts` and `../workflow/repos.ts`; `index.ts` imports `../workflow/view.ts`, `knowledge.ts` and `prompts.ts`.

Tests: `node --experimental-strip-types --test config.test.ts subagent.test.ts mcp-forward.test.ts test-run.test.ts runner-guard.test.ts`
