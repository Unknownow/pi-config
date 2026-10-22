<!-- pi-workflow plan v1 flow=20261023-0237-sandbox-fixes-for-table-cell-entities-an-4ed8 -->
## Plan: Sandbox fixes for table-cell entities and require from cwd

### 1. Goal and non-goals
**Goal:** fix the two findings the judge left open after Stage 2 in `pi/agent/extensions/sandbox/`:
- HTML entities inside table cells are decoded in the markdown output.
- `require` inside `run_code` resolves relative paths and packages from the run's `cwd`, not from the temp folder that holds the script.

**Non-goals:**
- No other sandbox, workflow or worktree changes.
- No change to the tool description in `index.ts:18`.
- No push, pull request or merge.

### 2. User decisions
- **D1:** Fix both remaining judge findings: table-cell entities, and `require` resolving from `cwd`.
- **D2:** Delivery is one commit only, with no push (the same as Stage 2, D3 of the earlier plan).
- **D3:** For `require`, use the `createRequire(process.cwd() + "/")` approach (option 2 of the judge's finding). Inject it as the wrapper's `require` parameter.

### 3. Facts the executor needs
- **`pi/agent/extensions/sandbox/html-to-md.ts:43`** builds each table cell as `stripTags(inline(c[1])).replace(/\s+/g, " ").trim().replace(/\|/g, "\\|")`. It never decodes entities.
  - Table blocks are swapped for `\u0000N\u0000` placeholders at :41-50.
  - The global `decodeEntities(s)` at :62 runs while the placeholders are still in place, so cell text is skipped.
  - The `<pre>` blocks already decode their own text at :38. Use that as the model.
- **`decodeEntities`** is defined at `html-to-md.ts:5`. It maps code point 0 to `\uFFFD`, which was fixed in the last round.
- **`htmlToMarkdown(html)`** returns `{ markdown: string; title?: string }` (`html-to-md.ts:31`). Tests read `.markdown`.
- **`pi/agent/extensions/sandbox/run-code.ts:81`** writes the script file to `os.tmpdir()` (:80) with this wrapper:
  `(async () => {\n${params.code}\n})().catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exitCode = 1; });\n`
  - The child is spawned with `cwd` set to the resolved `cwd`.
  - CommonJS `require` resolves relative to the script file's own folder, which is the temp folder.
- **`run-code.test.ts`** imports `fs`, `os`, `test`, `assert`, `capOutput` and `runCode`. It sets `const cwd = os.tmpdir()`. Calls look like `runCode({ code, cwd?, timeout? }, { cwd })`.
- **`README.md:8`** in the sandbox already says `require` works. It needs no change.
- **Test command:** `cd pi/agent/extensions/sandbox && node --experimental-strip-types --test *.test.ts`. The last result was 17/17 pass, in a few seconds.
- **Environment:**
  - Windows with bash. Use `cd /d/works/wt/reduce-context/pi-config`.
  - Python is not installed.
  - The `edit` tool is the most reliable way to patch files. Don't use `sed` on lines that contain backslashes.

### 4. Design
Not needed. These are two local fixes with no new component or interface. The only contract is the wrapper text in S2.

### 5. Steps
**S1.** Decode entities in table cells (`html-to-md.ts:43`).
- Wrap the cell text in `decodeEntities(...)` right after `stripTags(inline(c[1]))`. The whitespace collapse, the `trim` and the `|` escaping must then run on the decoded text. A decoded `&#124;` must still end up escaped as `\|`.
- Model it on the `<pre>` handling at :38.
- Add the test from §6 to `html-to-md.test.ts`.

**S2.** Make `require` resolve from `cwd` (`run-code.ts:81`).
- Change the wrapper so the user's code gets a `require` created for the run's working folder:
  `((require) => (async () => {\n${params.code}\n})())(require("node:module").createRequire(process.cwd() + "/")).catch(...)`
  The `.catch(...)` handler stays exactly as it is now.
- The user's code must still start on line 2 of the file, so stack-trace line offsets don't change.
- Add a one-line comment above the write: require resolves from cwd, not from the temp folder the script lives in.
- Add the test from §6 to `run-code.test.ts`.

**S3.** Run the sandbox tests (§6). Then call `judge` with the focus "Sandbox fixes for table-cell entities and require from cwd". Fix any blocker or major finding.

**S4.** Deliver: commit — the four sandbox files from §9, with no push.

### 6. Tests
**`html-to-md.test.ts`**, test `"entities in table cells are decoded"`:
- Input: `htmlToMarkdown("<table><tr><th>h</th></tr><tr><td>a &amp; b</td></tr></table>").markdown`
- Expected: it matches `/\| a & b \|/` and does not contain `&amp;`.

**`run-code.test.ts`**, test `"require resolves relative paths from cwd"`:
- Setup: make a temp folder with `fs.mkdtempSync` that holds `x.js` with the content `module.exports = 42;`.
- Input: `runCode({ code: "console.log(require('./x.js'))", cwd: dir }, { cwd })`
- Expected: `r.exitCode === 0` and `r.text.trim() === "42"`.
- Cleanup: remove the folder in a `finally` block.

**Command:** `cd pi/agent/extensions/sandbox && node --experimental-strip-types --test *.test.ts`
- Expected: `tests 19`, `pass 19`, `fail 0`.
- This suite is fast, so there is no slow variant.

### 7. Done when
- Table cells with entities come out decoded in markdown.
- `require('./x')` and package names inside `run_code` resolve from the run's `cwd`.
- The sandbox suite passes 19/19.
- The judge passes.
- One commit is made, with no push.

### 8. Risks, rollback, and what not to touch
**Risks:**
- `createRequire` resolves packages from `cwd`'s `node_modules` chain. Built-ins like `require("fs")` still work.
- Code that relied on resolving from the temp folder is not a real use case.
- Decoding before the `|` escape is deliberate, so a decoded pipe can't break the table.

**Rollback:** revert the single commit.

**Do not touch:**
- `run-code.ts` output capping, the grace timer or `killTree`.
- `fetch-url.ts`.
- The workflow and worktree extensions.
- `docs/workflow-improvements.md`. These are bug fixes in an implemented item, so no backlog row changes.

### 9. Commits
- `fix(sandbox): decode table-cell entities and resolve require from cwd`. Files:
  - `pi/agent/extensions/sandbox/html-to-md.ts`
  - `pi/agent/extensions/sandbox/html-to-md.test.ts`
  - `pi/agent/extensions/sandbox/run-code.ts`
  - `pi/agent/extensions/sandbox/run-code.test.ts`

<!-- pi-workflow:status -->
## Checklist
- [x] S1 Decode entities in table cells (`html-to-md.ts:43`).
- [x] S2 Make `require` resolve from `cwd` (`run-code.ts:81`).
- [x] S3 Run the sandbox tests (§6). Then call `judge` with the focus "Sandbox fixes for table-cell entities and require from cwd
- [ ] S4 Deliver: commit — the four sandbox files from §9, with no push.
