<!-- pi-workflow plan v1 flow=20261023-0054-cheaper-workflow-tokens-and-an-own-sandb-97be -->
## Plan: Cheaper workflow tokens, and an own sandbox extension in place of context-mode

### 1. Goal and non-goals

**Goal:** lower the token cost per call and per flow of the pi workflow, mainly in the plan phase.
- Explore subagents cost less: no AGENTS.md files, thinking low, a budget of tool calls.
- Added folders' rules files no longer go out with every call. Only their paths are listed.
- The end-of-flow card and `/flow tokens` show tokens per model.
- context-mode is replaced by a small extension of our own (`run_code`, `fetch_url`). The plan phase never declares a tool that its allow-list refuses, including tools registered later.

**Non-goals:**
- No change to the working folder's context files or the global AGENTS.md loading.
- No change to bash's read-only checks.
- No session token report, judge-input trimming, finalize de-duplication, 1-hour cache or fresh-context-per-flow. These are backlog ideas only.
- No replacement for context-mode's session memory (`<session_resume>`, `<session_state>`, search across sessions) or `/ctx-stats`.
- No push in either stage.

### 2. User decisions

- **D1:** Work in this worktree, `D:\works\wt\reduce-context\pi-config` (branch `wt/reduce-context`).
- **D2:** Two stages. Stage 1 covers explore cost, the per-model token report and added-folder rules as paths. Stage 2 is the own sandbox extension that replaces context-mode.
- **D3:** Each stage is delivered as a commit only, after the judge passes. No push.
- **D4:** Explore runs with `--no-context-files` through a new config key `explore.contextFiles: boolean`, default `false`. Other roles are unchanged.
- **D5:** Explore thinking is `"low"` in `pi/agent/workflow.json`. The code default stays `"off"`.
- **D6:** The explore prompt gets a budget of about 10 tool calls per question. After that it answers with what it has and says in "Answer" what was not verified. The reply format is unchanged.
- **D7:** Added folders' rules files are listed as paths with sizes, not loaded. The config switch is `addedFolderRules: "paths" | "full"`, default `"paths"`. `"full"` keeps today's behaviour.
- **D8:** The rule text is exactly: `Rules files of the added folders (not loaded): read a folder's files before you plan or change anything in it.`
- **D9:** The list order is stable, so the section changes only when the folders change.
- **D10:** Per-model token breakdown:
  - The data covers the four counts per model, per-model records for the main session and for each sub role, and per-model stage totals.
  - All new fields are optional. `models: string[]` is kept so old data still loads.
- **D11:** The card header no longer sums across models. It is followed by one "by model" line per model, sorted by cost (highest first). Stage rows name the model of each part. Old summaries render exactly as now. `/flow tokens` shows the same view. The `/flow status` per-stage session line is unchanged.
- **D12:** The new extension is `pi/agent/extensions/sandbox/`, with no npm dependencies and tool descriptions of about 600 characters each.
- **D13:** `run_code` takes `{code, cwd?, timeout?}` and runs JavaScript only:
  - The code runs in a temporary `.cjs` file wrapped in an async function.
  - Timeout: default 60 s, maximum 10 min. On timeout or abort, the whole process tree is killed.
  - Output is capped at 8,000 characters: the first 6,000, the last 2,000, and the cut-note line.
- **D14:** `fetch_url` takes `{url, force?}`:
  - GET only, http and https only, redirects followed, 30 s timeout, 5 MB body limit.
  - HTML is converted to markdown, JSON is pretty-printed, other text is saved as it is.
  - The result is cached at `<os.tmpdir()>/pi-fetch/<sha1(url)>.<md|json|txt>` and reused for 1 hour unless `force` is set.
- **D15:** The plan-phase allow-list gains `run_code` and `fetch_url` and loses every `ctx_*` entry:
  - `run_code`'s code is checked with the existing JS_CHECKS.
  - CODE_TOOL, BATCH_TOOL, CHANGE_TOOL and the code only they reach are removed.
- **D16:** In the plan and test phases, the tool filter is run again before each prompt and at each turn start:
  - New tools are added to `toolsBeforePlan`.
  - `setActiveTools` is called only when the set changes.
- **D17:** context-mode is removed from settings.json and npm/package.json, along with its allowScripts entry. `better-sqlite3` leaves allowScripts too, but only if pi-claude-bridge doesn't need it.
- **D18:** The loss of context-mode's session memory and `/ctx-stats` is accepted.
- **D19:** Backlog: new IDs continue at A26, B14, C7 and D18. Each stage updates its rows, the Status line and the "Effect measurement" rows in that stage's commit. An existing row on the same idea is updated instead of adding a duplicate.

### 3. Facts the executor needs

All paths are relative to the repo root. W = `pi/agent/extensions/workflow`.

**Config:**
- `W/config.ts:180`: the explore config type is `{ maxQueries; concurrency; tools }`.
- `W/config.ts:264`: the explore defaults.
- `W/config.ts:210`: the explore role default is `thinking: "off"`.
- `W/config.ts:168` and `:243`: `planAllowedTools` defaults to `PLAN_TOOLS`, imported from `readonly-tools.ts` (`config.ts:10`).
- `pi/agent/workflow.json`:
  - `:12-14` is the explore role, with `"thinking": "medium"` at `:14`.
  - `:85-89` is `planAllowedTools`; the ctx regex is at `:87`.
  - `:131` is the `explore` block.

**Subagents:**
- `W/subagent.ts:179`: `runSubagent(opts)`. It builds `args` at about lines 189-203 (`--mode json -p --no-session --no-extensions --no-skills --no-prompt-templates`, then `--model`, `--thinking`, `--tools`).
- `W/index.ts:718`: `runRole(role, …)`.
- `W/index.ts:2081`: the `runRole("explore", …)` call inside the explore tool.

**Plan-phase tool filter:**
- `W/index.ts:508`: `blockPlanTools(phase)` takes a snapshot with `state.toolsBeforePlan ??= pi.getActiveTools()` and calls `setActiveTools` with the snapshot filtered by `planToolRefused`.
- `W/index.ts:528`: `restorePlanTools`.
- `W/index.ts:126`: the `toolsBeforePlan` field.
- `blockPlanTools` is called at `:544`, `:1931` and `:4176`.
- There is no `turn_start` handler today.

**System prompt:**
- `W/index.ts:2696-2715`: `before_agent_start`. It sets `opts.sections.workspace = prompts.workspaceSection(ctx.cwd, folders, touched)` before the loop that pushes added folders' `loadProjectContextFiles` results into `opts.contextFiles`. The loop skips paths already in `have`, using `repoKey`.

**Execute-phase push guard:**
- `W/index.ts:2729-2752`: the `tool_call` handler.
- `:2737-2748`: `ctx_execute`. Shell languages push shell text. Other languages are blocked on three checks:
  - a git push/commit/hooks regex;
  - `codeCommitProblem(code)`, from `W/push-guard.ts:222`;
  - `gh pr|api`.
- `:2749-2751`: `ctx_batch_execute`.

**Prompts:**
- `W/prompts.ts:12-16`: the `batchLine` comment that mentions `ctx_batch_execute`.
- `W/prompts.ts:46`, `:90`, `:106`: the plan, execute and test batch lines.
- `W/prompts.ts:169-178`: `EXPLORE`.
- `W/prompts.ts:330`: `workspaceSection(cwd, folders, touched)`. It writes "Added folders (also part of this task):" followed by `- <folder>` lines.

**readonly-tools.ts:**
- `:22`: the ctx regex in PLAN_TOOLS.
- `:34`: the mcp write-word check, which has a `__ctx_` exemption.
- `:40-42`: CODE_TOOL, BATCH_TOOL, CHANGE_TOOL.
- `:52`: JS_CHECKS.
- `:162`: the PowerShell comment.
- `:196`: `JS_LANGUAGES` in the code check.
- `:206`: `planToolProblem`. The branches at `:213-222` cover CHANGE, BATCH and CODE. `:223` is the mcp SQL/GraphQL check, which also has a `__ctx_` exemption.

**Tokens and view:**
- `W/tokens.ts:17`: `Tok { raw: number; cost: number }`. `TokenWeights` has `input`, `output`, `cacheRead` and `cacheWrite`.
- `W/view.ts:69-77`: `StageUsage { tokens; main; models: string[]; subs: Partial<Record<SubRole, { tokens: Tok; runs: number }>> }`. Other `view.ts` lines:
  - `:85`: `FlowSummary`.
  - `:117`: `shortModel`.
  - `:196-230`: `summaryLines`. Line `:220` joins the models of the main part; `:221` writes the sub parts.
  - `:313`: `start(role, label)`.
  - `:328`: the sub runs counter.
  - `:337`: `event`.
  - `:374`: main-session add with `model`.
  - `:389-400`: the private `add(stage, tokens, source, model?)`.
  - `:430-441`: `peekFlow`.
- `W/flow-report.ts` and `W/metrics.ts` don't name `StageUsage`, `models` or `subs` directly. They are still the files to check for consumers of `FlowSummary`.
- `W/index.ts:4559`: the `/flow tokens` case.
- `W/index.ts:4201`: the `/flow status` per-stage line.

**Worktree guards:**
- `pi/agent/extensions/worktree/shared-guard.ts:22-26`: ctx branches.
- `pi/agent/extensions/worktree/unity-guard.ts:145-151`: ctx branches.
- `pi/agent/extensions/worktree/README.md:137-138` and `:168`: mention ctx tools and context-mode.
- Neither `workflow/` nor `worktree/` has a `package.json`.

**Docs and settings:**
- `W/README.md:192-193` and `:212-224`: plan tools and the context-mode section.
- `W/README.md:232`: the full test command.
- `pi/agent/AGENTS.md:9-28`: context-mode lines at 11-12, 23 and 28.
- `pi/agent/settings.json:20`: `"npm:context-mode"`.
- `pi/agent/npm/package.json`:
  - `:5`: the `context-mode` dependency.
  - `:9-10`: allowScripts entries for `better-sqlite3` and `context-mode`.
  - `:6`: `pi-claude-bridge`.

**Backlog:**
- `docs/workflow-improvements.md:5`: the Status line.
- The section "Keeping this file current" has the rules.
- The last IDs are A25, B13, C6 and D17.
- B2 and B13 cover judge input and rechecks. B12 covers the finalize reply.

### 4. Design

**Components:**
- **Stage 1, `W/view.ts`:** per-model data and card rendering.
- **Stage 2, `sandbox/index.ts`:** registers `run_code` and `fetch_url` with `pi.registerTool`, modelled on `W/index.ts:2061`. The other sandbox modules:
  - `run-code.ts` exports `runCode(params, { cwd, signal })` → `{ text: string; exitCode: number; timedOut: boolean }`, and `capOutput(s: string): string`.
  - `fetch-url.ts` exports `fetchUrl(params, deps?: { fetch?: typeof fetch; now?: () => number; dir?: string }): Promise<string>`.
  - `html-to-md.ts` exports `htmlToMarkdown(html: string): { markdown: string; title?: string }`.
  - No `package.json` and no dependencies.
- **Stage 2, new `W/plan-tools.ts`:** exports `refilterPlanTools(pi: { getActiveTools(): string[]; setActiveTools(t: string[]): void }, before: string[], refused: (name: string) => boolean): boolean`. It returns whether `setActiveTools` was called.
- **Stage 2, `W/push-guard.ts`:** gains `codePublishProblem(code: string): string | null`. It holds the three non-shell checks moved from `index.ts:2741-2746`, with their reasons unchanged.

**run_code contract:**
- Wrapper: the code is placed inside `(async () => { … })()`. A rejected promise prints its stack to stderr and sets the exit code to 1. `require` works because the file is `.cjs`.
- Temporary file: `<os.tmpdir()>/pi-run-<random>.cjs`, deleted in `finally`.
- Node: `process.execPath` if its basename is `node` or `node.exe` (case-insensitive), else `node` from PATH. stdin is ignored. cwd is `params.cwd` resolved against the session cwd, else the session cwd.
- Process-tree kill:
  - Windows: `taskkill /pid <pid> /T /F`.
  - Elsewhere: spawn `detached` and `process.kill(-pid, "SIGKILL")`.
- Output layout:
  - stdout first;
  - then, if stderr is not empty, `\n[stderr]\n<stderr>`;
  - then `\n[exit code N]` when N ≠ 0;
  - then `\n[timed out after <s> s; process tree killed]` or `\n[aborted]` when that applies.
- Cap: when the combined text is longer than 8,000 characters, the result is the first 6,000 characters, then the line `[output cut: 8000 of <M> characters shown; print less]`, then the last 2,000. M is the full length.
- Timeout: `timeout` is in seconds, defaults to 60 and is clamped to the range 1-600.
- Spawn failure: returns the error text with exit code -1.

**fetch_url contract:**
- An invalid URL or a scheme other than `http:` or `https:` throws `only http and https URLs are allowed`.
- Requests use GET with `redirect: "follow"` and a 30 s `AbortSignal.timeout`.
- The body is read as a stream. Past 5 × 1024 × 1024 bytes, reading stops with the error `response body larger than 5 MB`.
- Content type and saved format:
  - content-type contains `json`: parse and pretty-print with 2 spaces into `.json`. If parsing fails, save the raw text as `.txt`.
  - content-type contains `html`: convert with `htmlToMarkdown` into `.md`.
  - anything else: save as it is into `.txt`.
- Files:
  - Content: `<dir>/<sha1(url)>.<ext>`. `dir` defaults to `<os.tmpdir()>/pi-fetch` and is created when missing.
  - Sidecar: `<dir>/<sha1(url)>.meta.json`, holding `{ finalUrl, status, contentType, size, title, ext, savedAt }`.
- Cache: if the sidecar and content exist, `now() - savedAt < 3_600_000` and `force` is not set, they are reused without a fetch, and the summary's first line ends with ` (cached)`.
- Summary lines, in this order:
  1. `URL: <finalUrl>`
  2. `Status: <status>`
  3. `Type: <contentType>`
  4. `Size: <n> characters`
  5. `Title: <title>`, when there is one
  6. `Headings:`, followed by up to 40 markdown heading lines
  7. a blank line, then the first 2,000 characters of the saved text
  8. `Saved: <path>`
  9. `Use grep or read on the file for more.`
- A non-2xx status is still saved and returned, with the status shown.

**html-to-md behaviour:**
- Drop `script`, `style`, `nav`, `header`, `footer`, `svg` and `noscript` together with their contents, and drop comments.
- Conversions:
  - `h1`–`h6` → `#`…`######`
  - `p` → a paragraph
  - `a[href]` → `[text](href)`
  - `ul`/`ol` `li` → `- ` or `1. `
  - `pre` → a fenced code block with its text kept verbatim
  - inline `code` → backticks
  - `table` → pipe rows, with a `| --- |` separator after the first row
  - `br` → a newline
- Any other tag is stripped and its text kept.
- Entities: named (at least amp, lt, gt, quot, apos and nbsp) and numeric (decimal and hex).
- Runs of 3 or more newlines are collapsed to 2, and the result is trimmed.
- `title` comes from `<title>`, else the first `h1`.

**Data model (stage 1):** these additions go in `view.ts`.
```ts
export interface ModelCounts { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface ModelTotal extends ModelCounts { tokens: Tok }
// StageUsage, all optional:
mainByModel?: Record<string, Tok>;
byModel?: Record<string, ModelTotal>;          // main + subagents
// subs[role], optional:
byModel?: Record<string, { tokens: Tok; runs: number }>;
```
- `models: string[]` is still filled.
- A usage without a model is keyed `"unknown"`.
- Compatibility: readers treat missing fields as absent. A stage without `byModel` renders with today's part format. If no stage has `byModel`, the whole card equals today's output, byte for byte.
- `metrics.jsonl` lines are the serialised `FlowSummary`. Old lines still parse.

**Card format (new data):**
- Header: the existing header, without the cross-model total.
- Then one line per model from the flow-wide merge of `byModel`, sorted by `tokens.cost` descending:
  `  <shortModel> <fmtTok(tokens)> · in <exact(input)> · out <exact(output)> · cache read <exact(cacheRead)> · cache write <exact(cacheWrite)>`
- Stage rows keep the stage total and its %. The parts are:
  - main session: `<shortModel> <fmtTok>` for each model in `mainByModel`;
  - subagents: `<role> <shortModel> ×<runs> <fmtTok>` for each model in `subs[role].byModel`.

**Failure handling:**
- `fetch_url`: network, timeout, size and scheme errors throw, and pi shows them as tool errors.
- The temporary-file delete failure in `run_code` is ignored.
- `refilterPlanTools`: an error from `getActiveTools` is caught by the caller, and the turn goes on.

**Scale:**
- `run_code` output above 8,000 characters is cut, and the process is bounded only by the timeout of at most 600 s.
- `fetch_url` is limited to 5 MB per page. The cache directory is never pruned; at about 100 fetches a day of under 1 MB each, it grows by under 100 MB a day until the OS cleans tmp.
- The refilter compares fewer than 100 tool names per turn.

**Alternatives rejected:**
- Keeping context-mode: its prompt blocks and tool descriptions cost tokens on every call.
- Shell or Python in `run_code`: they would need the separate check paths that we are removing.
- Summing usage events: the events are cumulative, so a sum would double-count.
- Full rules files by default: they cost tokens on every call. That mode stays available as `"full"`.

### 5. Steps

### Stage 1: Explore cost, per-model token report, added-folder rules as paths (delivery: commit)

**S1.** Explore without context files.
- `W/config.ts:180`: add `contextFiles: boolean` to the explore type. At `:264`, default it to `false`. Config loading must accept a JSON boolean and ignore other types, like the other explore keys.
- `pi/agent/workflow.json:131`: add `"contextFiles": false` to the explore block.
- `W/subagent.ts`: add the optional `noContextFiles?: boolean` to `RunOptions`. When it is true, push `--no-context-files` right after `--no-prompt-templates`.
- `runRole` (`W/index.ts:718`): pass `noContextFiles: true` only when `role === "explore" && !cfg.explore.contextFiles`.

**S2.** In `pi/agent/workflow.json:14`, change explore `"thinking": "medium"` to `"low"`. Leave `config.ts:210` unchanged.

**S3.** Add one rule to `prompts.EXPLORE` (`W/prompts.ts:169-178`). It must contain the phrase `about 10 tool calls`:

> Use about 10 tool calls per question; then answer with what you have and say in the Answer part what you did not verify.

Keep the format text unchanged.

**S4.** Added folders' rules files as paths.
- `W/config.ts`: add `addedFolderRules: "paths" | "full"`, default `"paths"`. Any other value falls back to `"paths"`.
- `pi/agent/workflow.json`: add `"addedFolderRules": "paths"`.
- `W/index.ts:2696-2715`:
  - First collect the added folders' files with today's `have` de-duplication.
  - `"full"` pushes them into `opts.contextFiles` as today.
  - `"paths"` doesn't push them. It passes them to `workspaceSection` as `{ path, size }`, where `size` is the file content's length.
  - Only then set `opts.sections.workspace`.
- `workspaceSection(cwd, folders, touched, rules: { path: string; size: number }[] = [])` (`W/prompts.ts:330`): when `rules` is not empty, add after the added-folders lines:
  - the D8 line;
  - one `- <path> (<size> characters)` line per file, sorted by path.

  With no files, the output is identical to today's.

**S5.** Per-model token breakdown (Design §4).
- `view.ts`: add the types.
- `FlowView.add` (`:389`) gains `model?: string` and `counts?: ModelCounts`. It updates:
  - `mainByModel` for main, or `subs[role].byModel[model].tokens` for a sub;
  - `byModel[model]` (Tok plus the four counts).
- `start(role, label, model?)` (`:313`) stores the model on the `RunView` and increments `subs[role].byModel[model].runs` next to the existing counter at `:328`.
- `runRole` (`W/index.ts:718`) passes `cfg.roles[role].model`.
- `event()` (`:337`):
  - Usage events are cumulative. The run keeps the latest counts of the current message.
  - When the message finishes, those final counts go to `add` with the Tok.
  - Counts are never summed across one message's events.
- `:374` passes the main message's four counts with the model.
- `peekFlow` (`:430-441`) adds live tokens and counts under the run's model.
- `summaryLines` (`:196-230`) renders per Design §4. `/flow tokens` (`W/index.ts:4559`) already uses it, so check it shows the new view. Leave `:4201` unchanged.
- Grep `W/` for `.stages`, `.subs` and `.models`. Check that every reader of `FlowSummary` or `StageUsage` (`flow-report.ts`, `metrics.ts` and others) still works.

**S6.** Backlog, `docs/workflow-improvements.md`, per "Keeping this file current":
- **A26:** explore cost (S1–S3). Done:, with files `subagent.ts`, `config.ts`, `index.ts`, `prompts.ts`, `workflow.json`.
- **A27:** added-folder rules as paths. Done:, with files `index.ts`, `prompts.ts`, `config.ts`, `workflow.json`.
- **A28:** per-model token report. Done:, with files `view.ts`, `index.ts`.
- **A29:** idea, a session token report `/flow tokens --sessions [N]`.
- **Judge idea:** add "only the current stage's section" to B2, and "Sonnet does re-reviews" to B13, as idea text. Add B14 only for a half that neither row covers.
- **B12:** add "no double plan at finalize" as idea text if it isn't already there.
- **A30:** idea, a 1-hour cache through the bridge (`PI_CACHE_RETENTION=long`).
- **A31:** idea, a fresh context per flow.
- Update the Status line, and add or update "Effect measurement" rows for A26–A31.

**S7.** `W/README.md`: describe `explore.contextFiles`, thinking low and the budget of tool calls, the per-model flow card, and the `addedFolderRules` switch.

**S8.** Run the stage 1 tests (§6) and the judge. The flow then delivers the commit.

### Stage 2: Own sandbox extension replaces context-mode (delivery: commit)

**S9.** Create `pi/agent/extensions/sandbox/`:
- `index.ts`, `run-code.ts`, `fetch-url.ts`, `html-to-md.ts`;
- `run-code.test.ts`, `fetch-url.test.ts`, `html-to-md.test.ts`;
- `README.md`.

Behaviour follows Design §4. Tool names are `run_code` and `fetch_url`. Descriptions are about 600 characters each.
- `run_code`: JavaScript only, await works, require is available, print only the answer, the 8,000-character cap.
- `fetch_url`: the saved file, then grep or read.

`run_code` passes the tool's abort signal through for the abort kill.

**S10.** Plan-phase checks, `W/readonly-tools.ts`:
- PLAN_TOOLS (`:22`): replace the ctx regex with `"(^|__)run_code$"` and `"(^|__)fetch_url$"`. Do the same at `pi/agent/workflow.json:87`.
- `planToolProblem` (`:206`):
  - `run_code`: return `firstMatch(String(input.code ?? ""), JS_CHECKS)`.
  - `fetch_url`: return null.
- Remove CODE_TOOL, BATCH_TOOL and CHANGE_TOOL and the branches at `:213-222`. Also remove:
  - the shell, PowerShell and Python language handling, and `JS_LANGUAGES` if nothing else uses it;
  - the PowerShell check and its comment at `:162`;
  - the `__ctx_` exemptions at `:34` and `:223`.
- Keep JS_CHECKS and all bash checks.
- Move the non-shell checks from `W/index.ts:2741-2746` into `codePublishProblem` in `W/push-guard.ts`. In the `tool_call` handler (`:2737-2751`), replace both ctx branches with one `run_code` branch that blocks with `publishRefuse(codePublishProblem(code))` when that returns a reason. `run_code` adds no shell text.

**S11.** Tool filter for tools registered later.
- Add `W/plan-tools.ts` with `refilterPlanTools` (Design §4). It:
  1. reads the active tools;
  2. appends each name not in `before` to `before`, in place;
  3. computes `before.filter((t) => !refused(t))`;
  4. calls `setActiveTools` only when that set differs from the active set as sets.
- In `W/index.ts`, call it when the phase is plan or test and `state.toolsBeforePlan` is set:
  - at the start of `before_agent_start` (`:2696`);
  - in a new `pi.on("turn_start", …)` handler.

  `refused` is the same `planToolRefused(t, allowed, blocked)` closure that `blockPlanTools` (`:508`) uses, so factor out its allowed and blocked lists.
- Add `plan-tools.test.ts` to the README test list.

**S12.** Worktree guards:
- `shared-guard.ts:22-26`: replace both ctx branches. `run_code` yields no shell texts.
- `unity-guard.ts:145-151`: `run_code` sends `String(input.code ?? "")` through the existing `codeProblem(code)`. Drop the batch branch.
- Update both tests.
- `worktree/README.md`: rewrite `:137-138` to name `bash` and `run_code`. At `:168`, drop the context-mode example and keep the `process.cwd()` warning.

**S13.** Prompts and rules:
- `W/prompts.ts`:
  - `:46` and `:106`: `a codemode script, run_code for read-only analysis, or one bash command joined with && or ;`.
  - `:90`: `a codemode script, run_code, or one bash command joined with && or ;`.
  - `:12-16`: drop the ctx_batch_execute sentence.
- `pi/agent/AGENTS.md:9-28`: rewrite the context-mode lines.
  - Filter in the command (grep, tail, counts), or use `run_code` to run JavaScript over output or a file and print only the result.
  - Use `fetch_url` for web pages, then grep or read the saved file.
  - Use codemode to chain several calls.
  - Drop the PowerShell line (`:23`). At `:28`, list `run_code`, `grep` and `read`.

**S14.** Remove context-mode:
- Remove `"npm:context-mode"` from `pi/agent/settings.json:20` and fix the JSON commas.
- In `pi/agent/npm/package.json`, remove the `context-mode` dependency and allowScripts entry.
- Before removing the `better-sqlite3` allowScripts entry, check read-only whether pi-claude-bridge needs it: run `npm ls better-sqlite3` in `~/.pi/agent/npm` and read the installed bridge's `package.json`. Remove the entry only if nothing besides context-mode depends on it; otherwise keep it and say so in the commit body.
- `W/README.md:192-193` and `:212-224`: describe `run_code`/`fetch_url` and the `run_code` JS check instead of context-mode.
- Run `grep -rn "ctx_\|context-mode" --exclude-dir=node_modules .`. Only history lines in `docs/workflow-improvements.md` may remain.

**S15.** Backlog:
- **A32:** own sandbox extension replaces context-mode. Done:, with its files.
- **D18:** plan-phase filter for tools registered later. Done: `plan-tools.ts`, `index.ts`.
- **A33:** idea, a bytes-saved report for `run_code`, like `/ctx-stats`.
- Update the Status line and the "Effect measurement" rows.

**S16.** Run all tests (§6) and the judge. The flow then delivers the commit.

**S17.** Verify:
1. Run `pi-config install` and restart pi.
2. In a plan phase:
   - run `run_code` on a session `.jsonl`;
   - run `fetch_url` on a docs page;
   - check the tool list;
   - after a flow, check `/flow tokens`.

Look for:
- correct output, with the cut note on large output;
- the saved file's path;
- no `ctx_*` tools and no `mcp__knowledge__propose_entry` in the tool list;
- a smaller first-call cacheWrite.

### 6. Tests

| File | Test | Input → expected |
|---|---|---|
| `W/subagent.test.ts` | context-files flag | `noContextFiles: true` → args contain `--no-context-files`; unset → absent |
| `W/subagent.test.ts` | flag per role | runRole's option for explore with `contextFiles` false → set; judge → unset; explore with `contextFiles` true → unset. Test the decision through an exported helper if runRole can't be called directly. |
| `W/config.test.ts` | explore.contextFiles | default `false`; `true` → `true`; `"yes"` → `false` |
| `W/config.test.ts` | addedFolderRules | default `"paths"`; `"full"` → `"full"`; `"x"` → `"paths"` |
| `W/prompts.test.ts` | EXPLORE budget | contains `about 10 tool calls` |
| `W/prompts.test.ts` | workspaceSection with rules | contains the D8 line, then path lines sorted by path, whatever the input order |
| `W/prompts.test.ts` | workspaceSection without rules | equals the 3-argument output |
| `W/prompts.test.ts` (stage 2) | batch lines | plan, test and execute lines name `run_code`; no `ctx_` |
| `W/view.test.ts` | two models | main on A and explore on B, with B costing more → B's "by model" line first; stage parts `<A> <tok>` and `explore <B> ×1 <tok>` |
| `W/view.test.ts` | one role, two models | judge on A then B in one stage → two judge parts |
| `W/view.test.ts` | legacy summary | a summary without the new fields → lines equal today's rendering |
| `W/view.test.ts` | cumulative usage | three cumulative usage events of one message → counts equal the last one |
| `W/view.test.ts` | live tokens | peekFlow during a run → live tokens under that run's model |
| `W/metrics.test.ts` | old and new lines | an old line and a new line both load and aggregate |
| `W/readonly-tools.test.ts` | run_code | a JS_CHECKS write case → problem; `console.log(1)` → null; fetch_url → null; `ctx_execute` refused by the allow-list; the removed-tool tests deleted |
| `W/plan-tools.test.ts` | late tool | fake pi; `mcp__knowledge__propose_entry` registered after the plan starts → refilter makes it inactive and adds it to `before`; a second refilter → no `setActiveTools` call; restore → active again |
| `W/push-guard.test.ts` | codePublishProblem | `git push` → reason; `gh pr create` → reason; `console.log(1)` → null |
| `worktree/shared-guard.test.ts` | run_code | no shell texts |
| `worktree/unity-guard.test.ts` | run_code | code that drives Unity → refused |
| `sandbox/run-code.test.ts` | cap | 20,000 characters → first 6,000 + `[output cut: 8000 of 20000 characters shown; print less]` + last 2,000 |
| `sandbox/run-code.test.ts` | timeout kill | a script that spawns a looping child, timeout 1 s → `timedOut`, child PID gone, temporary file deleted |
| `sandbox/run-code.test.ts` | non-zero exit | `console.error("e"); process.exit(3)` → `[stderr]`, `e` and `[exit code 3]` |
| `sandbox/run-code.test.ts` | await | `await Promise.resolve(); console.log(2)` → `2` |
| `sandbox/html-to-md.test.ts` | converter | sample with nav, script, h1, p, a, ul, pre, table, entities and br → the expected markdown and title |
| `sandbox/fetch-url.test.ts` | scheme | `file:///x` and `ftp://x` → throw |
| `sandbox/fetch-url.test.ts` | cache | injected fetch counter, temporary dir: second call → no fetch and `(cached)`; `force` → fetch; `now` + 2 h → fetch |
| `sandbox/fetch-url.test.ts` | json and size | JSON is pretty-printed into `.json`; a 6 MB body → throws |

Commands:
- Workflow, from `pi/agent/extensions/workflow`: the full command at `README.md:232`. Add `plan-tools.test.ts` to it in stage 2. Expected: 0 fail.
- Worktree: `cd pi/agent/extensions/worktree && node --experimental-strip-types --test *.test.ts`. Expected: 0 fail.
- Sandbox: `cd pi/agent/extensions/sandbox && node --experimental-strip-types --test *.test.ts`. Expected: 0 fail.

None of these is expected to take over 2 minutes. While fixing, run the single changed files; at the end, run the full lists once.

### 7. Done when

- All tests pass.
- Explore runs carry `--no-context-files`, with thinking low.
- Added folders show only their rules files' paths.
- The card shows tokens per model.
- context-mode is gone, and `run_code` and `fetch_url` work in every phase.
- The plan phase never declares a tool that its allow-list refuses.
- The backlog is updated per D19 in each stage's commit.

### 8. Risks, rollback, and what not to touch

**Risks:**
- **S3:** explore answers may be less complete.
- **S4:** the model may skip reading an added folder's rules. `addedFolderRules: "full"` is the fallback.
- **S11:** each tool-set change costs one cache rewrite. That's why the set is changed only when it differs.
- **Stage 2:** context-mode's session memory and `/ctx-stats` are lost (accepted, D18).
- **Windows process-tree kill:** it depends on `taskkill`, a Windows system tool.

**Rollback:** revert the stage's commit.
- Stage 1 also has config fallbacks: `explore.contextFiles: true` and `addedFolderRules: "full"`.

**Don't touch:**
- bash read-only checks and JS_CHECKS content;
- the working folder's context files and the global AGENTS.md loading;
- `/flow status` (`index.ts:4201`);
- other roles' subagent args;
- backlog rows other than the ones named.

### 9. Commits

- Stage 1: `workflow: cheaper explore, added-folder rules as paths, per-model token report`. Files: `W/config.ts`, `W/subagent.ts`, `W/index.ts`, `W/prompts.ts`, `W/view.ts`, any touched readers, their tests, `pi/agent/workflow.json`, `W/README.md`, `docs/workflow-improvements.md`.
- Stage 2: `sandbox: own run_code/fetch_url extension replaces context-mode; refilter plan tools`. Files:
  - `pi/agent/extensions/sandbox/*`;
  - in the workflow extension: `W/readonly-tools.ts`, `W/plan-tools.ts`, `W/push-guard.ts`, `W/index.ts`, `W/prompts.ts`, their tests, `W/README.md`;
  - `worktree/shared-guard.ts`, `worktree/unity-guard.ts`, their tests, `worktree/README.md`;
  - `pi/agent/AGENTS.md`, `pi/agent/settings.json`, `pi/agent/npm/package.json`, `pi/agent/workflow.json`, `docs/workflow-improvements.md`.

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 Explore without context files.
- [ ] S2 In `pi/agent/workflow.json:14`, change explore `"thinking": "medium"` to `"low"`. Leave `config.ts:210` unchanged.
- [ ] S3 Add one rule to `prompts.EXPLORE` (`W/prompts.ts:169-178`). It must contain the phrase `about 10 tool calls`:
- [ ] S4 Added folders' rules files as paths.
- [ ] S5 Per-model token breakdown (Design §4).
- [ ] S6 Backlog, `docs/workflow-improvements.md`, per "Keeping this file current":
- [ ] S7 `W/README.md`: describe `explore.contextFiles`, thinking low and the budget of tool calls, the per-model flow card, and 
- [ ] S8 Run the stage 1 tests (§6) and the judge. The flow then delivers the commit.
- [ ] S9 Create `pi/agent/extensions/sandbox/`:
- [ ] S10 Plan-phase checks, `W/readonly-tools.ts`:
- [ ] S11 Tool filter for tools registered later.
- [ ] S12 Worktree guards:
- [ ] S13 Prompts and rules:
- [ ] S14 Remove context-mode:
- [ ] S15 Backlog:
- [ ] S16 Run all tests (§6) and the judge. The flow then delivers the commit.
## For you after the flow
- S17 Verify:
