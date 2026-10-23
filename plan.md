<!-- pi-workflow plan v1 flow=20261023-0923-agents-publish-and-mirror-unity-packages-764a -->
## Plan: Agents publish and mirror unity-packages from approved plans

### 1. Goal and non-goals
**Goal:** during a flow, the executor publishes unity-packages versions and mirrors vendor packages itself. It does this on the person's computer with their registry token, and only for the packages named in the approved plan's `Publish:` / `Mirror:` steps. Nobody has to type `publish` or wait for a person.

**Non-goals:**
- No publishing or mirroring from VMs, Macs or CI.
- `npm publish` by hand, running `publish-package.mjs` directly, and pushing release tags by hand stay forbidden.
- No change to how versions are chosen (`edit-package.mjs`, `check-packages`).
- No change to `publish-package.mjs`'s publish logic or to the tag-push code.
- No lock across machines.
- The interactive `updates.bat` menus keep working exactly as they do today.

### 2. User decisions
- **D1:** An agent may publish and mirror, but only through the publish tool. It runs on the person's computer with their token. `npm publish` by hand and pushing tags by hand stay forbidden.
- **D2:** Approval covers packages, not versions. The version published is the one this flow merged to `main`, so a renumber by another session needs no plan change.
- **D3:** Before publishing, the agent waits until older unpublished versions of the same package, and the `com.iecgames.*` versions it pins, are published. It never publishes another session's version.
- **D4:** Plan approval alone is the consent. There is no extra menu before publishing.
- **D5:** Autopilot may approve plans that contain `Publish:` / `Mirror:` steps. No special rule.
- **D6:** Vendor mirroring follows the same rules as publishing.

### 3. Facts
- **`unity-packages/scripts/update-packages.mjs`:**
  - `parseFlags` (`:195-204`) accepts only `--no-push`, `--dry-run` and `--template`.
  - `publish()` (`:301-338`):
    - fetches origin;
    - builds `missing` (tagged but not on the registry, via `findMissing` `:227-238`) and `fresh` (origin/main versions without a tag, at commit `origin/main`);
    - orders them with `orderItems` and prints them;
    - refuses without a token;
    - asks two readline questions (`:329-334`);
    - runs `publishItems` (`:277-289`), which stops at the first failure.
  - `USAGE` is at `:340`; the header comment is at `:1-14`.
- **`scripts/lib/sdk-updates.mjs`:**
  - Functions: `unpublished` `:151`, `supersededTags` `:156`, `missingFromRegistry` `:169`, `orderForPublish` `:178`, `orderItems` `:192`.
  - `supersededTags` skips an older tag for good once the registry has a newer version; that is why D3 is needed.
  - The tests in `scripts/update-packages.test.mjs` import from both files.
- `remotePackages()` (`update-packages.mjs:53`) returns `{name, version, dependencies}` from origin/main.
- `getPackument(IEC_REGISTRY, name, {token})` comes from `scripts/lib/registry.mjs`.
- The registry already refuses the same version from another commit (`publish-package.mjs:126-131`) and the same version with different content (`lib/registry.mjs:145-150`).
- **`scripts/maintenance.mjs`:**
  - `mirrorFlow` (`:28-52`) asks three questions, then calls `mirror({dirs, extras, dryRun, token})`.
  - `parseExtras` is exported at `:20`; `main` is at `:94-99`.
  - Its tests are in `scripts/maintenance.test.mjs`.
- **`pi-config/pi/agent/extensions/workflow/index.ts`:**
  - The execute-phase guard (`:2778-2801`) checks only text that mentions git or gh, plus `codePublishProblem` (`push-guard.ts:233`) for `run_code`.
  - The `wait_for_user` tool is at `:2318-2400`.
  - Its autopilot shortcut (`:2362-2368`) resolves an "act" wait without waiting.
  - At `:2380-2385` it sets `state.waiting = {reason, check, step, stage, since, planned}` and calls `startWaitTimer()`.
  - `runWaitCheck` is at `:2265`.
  - `recordJudgedHeads` is at `:3927-3950`; a merge that deleted the branch drops the judged head at `:3936`.
  - `judgedHeads` is persisted at `:1299`, `:1399` and `:1674`, and reset at `:580`.
- `delivery.mergeMethod` can be `merge`, `rebase` or `squash` (`config.ts:246`, `delivery.ts:98`). A merged branch head is therefore not always an ancestor of `origin/main`.
- `readOnlyProblem` (`readonly-bash.ts:289`) allows `test` and `git ls-remote`.
- These places say publishing is a person's job: `prompts.ts:25`, the `wait_for_user` description at `index.ts:2322`, `waits.ts:1`, and `README.md:155`. The execute rules are at `prompts.ts:100`. The README test command is at `:226`.
- **Rules to change:**
  - `unity-packages/AGENTS.md` rule 5, and the README "Publish" section (`:149-171`).
  - Knowledge `entries/eng/playbook/unity-packages-updates-menu.md` (`:39`, `:56`) and `entries/eng/playbook/release-code-packages.md` (step 4, `:31`). Existing entries are edited with a normal PR (knowledge AGENTS.md rule 2).
- pi-config `docs/workflow-improvements.md`: the last A row is A33; the Status line is `:5`; the rules for editing the file are at `:7-11`.

### 4. Design

**Script contract (unity-packages)**
- `update-packages.mjs publish --only <name@version[,name@version…]> --confirm publish`:
  - Non-interactive: it never opens readline.
  - Every `--only` item must be a current candidate, from the same `missing` + `fresh` list the menu shows. If one isn't, it exits 1 with `<name>@<version>: not a publishable version on origin/main` and publishes nothing.
  - It publishes the chosen items in `orderItems` order through the existing `publishItems`.
  - `--only` without `--confirm publish` (and without `--dry-run`) exits 2 with usage. `--confirm` with any other value exits 2.
- **Blockers** (D3), for the `--only` items:
  - `older`: a candidate of the same package with a lower version that is not in `--only`.
  - `dependency`: a `com.iecgames.*` dependency of an `--only` package, at its pinned version, that is not on the registry and not in `--only`.
  - A real run with blockers exits 3, prints `blocked: <tag> (<reason>)` per blocker, and publishes nothing.
- `publish --dry-run --only … --json` prints exactly one JSON object on stdout and sends all human text to stderr. It exits 0. Without a token it prints `{"error":"no-token"}` and exits 1. The object:
  ```json
  {"items":[{"name":"","version":"","tag":""}],"blockedBy":[{"name":"","version":"","tag":"","reason":"older|dependency"}],"notCandidates":["name@version"]}
  ```
- **Exit codes:** 0 done, 1 failure or refusal, 2 usage, 3 blocked.
- `maintenance.mjs mirror (--package <folder> | --all) [--extras <a@1,b@2>] [--confirm mirror]`:
  - Without `--confirm mirror` it is a dry run.
  - Any flag switches to this flag form. Both `--package` and `--all`, or neither, exits 2.
  - No arguments means today's prompts.

**Extension (pi-config)**
- **Plan step syntax**, parsed like `parseDeliverStep` (`checkpoints.ts:14`):
  - `**S<n>.** Publish: <package>[, <package>…]`: package names only. A token that contains `@` makes the step invalid.
  - `**S<n>.** Mirror: <folder>|all[; extras <name@version,…>]`.
- **State:** a new `state.mergedHeads?: Record<repoKey, string>`.
  - Persisted and restored next to `judgedHeads` (`:1299`, `:1399`, `:1674`) and cleared with them at `:580`.
  - In `recordJudgedHeads`, for every target with `mode === "merge"`, set `mergedHeads[key] = t.head` before the deletion at `:3936`. A later merge in the same flow overwrites it.
- **Tool `publish_packages {step: string}`** (execute phase, with an approved plan only):
  1. Refuse (`… Nothing changed.`) unless `step` is an open `Publish:` or `Mirror:` step of the plan.
  2. Find the repo: the first flow repo whose root contains `scripts/update-packages.mjs`. If there is none, refuse.
  3. **Publish step:**
     - Without `mergedHeads[repo]`, refuse with "no merged work in this flow: put the Publish step after a Deliver: merge step".
     - For each named package, read `version` from `git show <mergedHead>:<package>/package.json`. A missing package there is a refusal.
     - Take the lock, then run the `--dry-run --only … --json` command. The script fetches origin itself.
     - Items whose tag `<name>/v<version>` already exists on origin are reported as "already published" and dropped. If none are left, release the lock and reply "already published; tick the step".
     - Any `notCandidates` entry fails the step with "superseded or not on origin/main; nothing published". The agent never renumbers.
     - If `blockedBy` is not empty, release the lock and start a wait:
       - reason `waiting for <tags> to be published`;
       - check: one `git -C '<root>' ls-remote --exit-code --tags origin '<tag>'` per blocker, joined with ` && `;
       - `step` set, `planned: true`, then `startWaitTimer()`.
     - Otherwise run the real command (`--only … --confirm publish`), release the lock, and reply with the exit code and the last 40 lines of output.
       - Exit 0: tell the agent to tick the step.
       - Any other exit: say the step failed, give the output, and tell the agent not to retry with another version.
  4. **Mirror step:** take the lock, run `node scripts/maintenance.mjs mirror --package <folder>|--all [--extras …] --confirm mirror`, release the lock, and reply the same way.
  5. The tool spawns `node` with `cwd` set to the repo root, stdin closed, and a 30-minute timeout. A timeout counts as a failure.
- **Waits from this tool never take autopilot's shortcut**, because another session's tag can't be "acted on". It is the existing wait: polled every 2 minutes, for up to 1 hour, with auto-resume. On resume the agent calls `publish_packages` again with the same step, which recomputes the blockers; the resume text says so.
- **Lock:** the file `<git rev-parse --git-common-dir>/iec-publish.lock`, JSON `{session, pid, startedAt}`, created exclusively (`wx`).
  - If the file exists and is younger than 30 minutes, or its pid is alive (`process.kill(pid, 0)`), the lock is held. The tool then starts a wait with reason `another session is publishing` and check `test ! -e '<lock path with forward slashes>'`.
  - Otherwise the lock is stale and is replaced.
  - The lock is always released in a `finally`.
- **Guard:** a new pure `registryPublishProblem(text: string): string | null` in `push-guard.ts`. In execute phase it runs on every bash command text (before the git/gh filter) and on every `run_code` code at `index.ts:2778-2801`.
  - It refuses:
    - `npm|pnpm|yarn publish` (including `npm.cmd`);
    - `updates.bat|updates.command|updates.mjs` followed by `publish` or `mirror`;
    - `update-packages.mjs publish` without `--dry-run`;
    - `maintenance.mjs mirror` with `--confirm`;
    - `publish-package.mjs`.
  - Refusal text: `<what>: publishing and mirroring run only through publish_packages with the plan's Publish:/Mirror: step`.
  - The tool's own spawn doesn't go through tool_call, so the guard doesn't apply to it.

**Failure handling**
- No token: the script exits 1 and the step fails ("run get-upm-token").
- The registry refuses, or the version clashes: the step fails with the script's message.
- A wait goes 1 hour without progress: the normal wait timeout notifies the user.
- A crash while holding the lock: the lock goes stale after 30 minutes.

**Scale**
- About 1-5 packages per step, a few sessions on one computer, and publishes of a few minutes each.
- One lock per clone's git-common-dir serializes publishes on one computer; worktrees share it.
- Two separate clones, or two computers, are ordered only by tags and by the registry's refusals. The design stops being safe if parallel publishes of the same package from separate clones become common.

**Rejected**
- Exact versions in the plan: they break when another session renumbers.
- The agent running the scripts through bash: no control over versions, waits or the lock.
- Reading the version from `origin/main`: it might be another session's version, which breaks D2 and D3.
- A remote lock: tags and the registry already order publishes across machines.

### 5. Steps

### Stage 1: Non-interactive publish and mirror, and the rules
**S1.** In `unity-packages/scripts/lib/sdk-updates.mjs`, next to `orderItems` (`:192`), add the pure exported function `publishSelection(candidates, only, packages, registryVersions)`.
- It returns `{items, blockedBy, notCandidates}` as in the design.
- Inputs:
  - `candidates`: the ordered items from `publish()`.
  - `only`: `[{name, version}]`.
  - `packages`: from `remotePackages()`.
  - `registryVersions`: `{name: [version]}` for the `com.iecgames.*` dependencies of the `only` packages.
- Use `compareVersions` as `supersededTags` does.

**S2.** In `scripts/update-packages.mjs`:
- Export `parseFlags` and add:
  - `--only <list>`, parsed into `{name, version}`; an item without `@` throws;
  - `--confirm <word>`;
  - `--json`.
- In `publish()`, when `--only` is set:
  - fetch the registry versions of the needed dependencies with `getPackument`;
  - call `publishSelection` and follow the contract and exit codes;
  - skip readline entirely;
  - in `--json` mode, send the existing `console.log` lines (`findMissing`, `printCandidates`, the token message) to stderr.
- Update `USAGE`, the header comment (`:1-14`) and the help output that `updates.mjs` shows.

**S3.** In `scripts/maintenance.mjs`:
- Add the exported pure function `parseMirrorFlags(argv)`. It returns `{dirs, extras, dryRun}` or throws a usage error.
- In `main`, pass the arguments after `mirror` on:
  - no arguments: today's `mirrorFlow`;
  - any arguments: the flag form, with the same token check, the same `mirror()` call, and the same summary line and return codes.
- Update the usage line and the header comment (`:4-8`).

**S4.** Tests (section 6) in `scripts/update-packages.test.mjs` and `scripts/maintenance.test.mjs`.

**S5.** `unity-packages/AGENTS.md`, rule 5. Replace it with:
- Never publish by hand: no `npm publish`, no running `publish-package.mjs` directly.
- Never push release tags by hand.
- A person publishes with `updates.bat publish`.
- An agent publishes or mirrors only with the pi workflow's `publish_packages` tool, for packages named in an approved plan's `Publish:` / `Mirror:` step.
- Either way it runs on the person's computer with their token (no VM or workflow), and the tool pushes the tags.
- The agent waits for older versions and pinned dependencies to be published.

Also update the `scripts/` layout line that mentions `publish-package.mjs`. In `README.md` `:149-171`, document the `--only`, `--confirm` and `--json` flags and the mirror flags.

**S6.** Knowledge:
- `entries/eng/playbook/unity-packages-updates-menu.md`:
  - step 3 (`:39`) and the pitfall line (`:56`): add the flag forms and the agent rule, worded as in S5;
  - `sources`: add `iecgames/pi-config pi/agent/extensions/workflow`.
- `entries/eng/playbook/release-code-packages.md`, step 4 (`:31`): add one sentence saying an agent in a pi flow publishes with a `Publish:` step (`publish_packages`) and waits for the dependency order itself.
- Don't change IDs, and keep `summary` within the schema limits.

**S7.** Run the stage 1 tests (section 6).

### Stage 2: The extension's Publish and Mirror steps
**S8.** Add a new pure module, `pi-config/pi/agent/extensions/workflow/registry-publish.ts`, modelled on `checkpoints.ts` and `waits.ts`. It exports:
```ts
parsePublishStep(plan: string, id: string): { packages: string[] } | null
parseMirrorStep(plan: string, id: string): { target: string; extras: string[] } | null   // target: folder or "all"
tagWaitCheck(root: string, tags: string[]): string
lockDecision(lock: { pid: number; startedAt: string } | null, now: number, pidAlive: (pid: number) => boolean): "free" | "held" | "stale"
publishArgs(items: { name: string; version: string }[], dryRun: boolean): string[]
mirrorArgs(step: { target: string; extras: string[] }): string[]
```
Add `registryPublishProblem` to `push-guard.ts` as described in the design.

**S9.** In `index.ts`:
- `mergedHeads`: its type next to `judgedHeads` (`:182`, `:1167`), persistence at `:1299` / `:1399` / `:1674`, reset at `:580`, and set in `recordJudgedHeads` (`:3927-3950`).
- Register `publish_packages` after `wait_for_user` (`:2318-2400`), following the design. It reuses `state.waiting` and `startWaitTimer`, and has no autopilot branch.
- Add the `registryPublishProblem` calls to the guard (`:2778-2801`).

**S10.** Prompts and docs:
- `prompts.ts:25`: add the planner sentence below, and remove "publish with `updates.bat`" from the `Wait:` examples (keep "open an Editor"):
  > "Publishing unity-packages versions is `**S<n>.** Publish: <package>[, <package>…]` after the `Deliver: merge` step that lands them; vendor mirroring is `**S<n>.** Mirror: <folder>|all[; extras <name@version,…>]`. Name packages, never versions. The executor runs them with `publish_packages` and waits for earlier versions itself."
- Execute rules at `prompts.ts:100`, add:
  > "At a `Publish:` or `Mirror:` step call `publish_packages {step}`; after a publish wait resumes, call it again. Never run `updates.bat`, `update-packages.mjs publish`, `maintenance.mjs mirror --confirm`, `publish-package.mjs` or `npm publish` yourself."
- The `wait_for_user` description (`index.ts:2322`) and `waits.ts:1`: replace "publish a package" with "open the Unity Editor".
- README: update `:155`, add a "Publish and Mirror steps" paragraph to the "Wait points, checkpoints and tags" section, and add `registry-publish.test.ts` to the test command at `:226`.

**S11.** Tests (section 6):
- the new `registry-publish.test.ts`;
- additions to `push-guard.test.ts` and `prompts.test.ts`;
- any existing test in `checkpoints.test.ts` or `waits.test.ts` that asserts the old "updates.bat" wording.

**S12.** `docs/workflow-improvements.md`:
- New row A34: "Problem: a flow waited for a person to publish with `updates.bat`. **Done:** `Publish:` / `Mirror:` steps and `publish_packages` (`registry-publish.ts`, `index.ts`, `prompts.ts`, `push-guard.ts`): it publishes this flow's merged versions with the person's token, waits for older versions and pinned dependencies, uses a lock per clone."
- Add A34 to the Status line.
- Effect-measurement row A34: "Waits for a person to publish per flow | count `wait_for_user` reasons mentioning publish in session logs | zero".

**S13.** Run the stage 2 tests (section 6).

**S14.** Verify: after both stages are merged, run a `Publish:` step in the next real package release flow. Look for:
- the version published and its tag pushed without anyone typing `publish`;
- a step blocked by another session's unpublished version waiting, then resuming on its own.

### 6. Tests
**`unity-packages/scripts/update-packages.test.mjs`:**
- `publishSelection lists an older candidate of the same package as a blocker`: candidates `core@0.24.0` and `core@0.24.1`, only `core@0.24.1`. Expect `blockedBy` = `[core@0.24.0 older]`.
- `publishSelection lists an unpublished pinned dependency`: `ads.applovin` pins `core 0.25.0`, which is not in `registryVersions`. Expect a `dependency` blocker. With `core@0.25.0` also in `only`, expect no blocker.
- `publishSelection reports a version that is not a candidate`: only `core@9.9.9`. Expect it in `notCandidates`.
- `publishSelection keeps publish order`: expect dependencies first.
- `parseFlags reads --only, --confirm and --json`, and throws on an `--only` item without `@`.

**`unity-packages/scripts/maintenance.test.mjs`, `parseMirrorFlags`:**
- `--package com.iecgames.core` gives `dirs ["com.iecgames.core"]` and `dryRun true`.
- `--all --confirm mirror` gives `dirs undefined` and `dryRun false`.
- `--extras a@1,b@2` is parsed into two extras.
- `--package x --all` throws.
- `--confirm yes` throws.

**`pi-config/.../registry-publish.test.ts`:**
- Step parsers: a valid step; a version token makes the step invalid; a step that isn't Publish returns null.
- `tagWaitCheck`: quoting, and the result passes `readOnlyProblem`.
- `lockDecision`: free; held (young); held (old, pid alive); stale.
- `publishArgs` and `mirrorArgs`.

**`push-guard.test.ts`:**
- Refused:
  - `npm publish`
  - `npm.cmd publish --registry x`
  - `updates.bat publish`
  - `node scripts/update-packages.mjs publish --only a@1 --confirm publish`
  - `node scripts/publish-package.mjs …`
  - `node scripts/maintenance.mjs mirror --all --confirm mirror`
- Allowed:
  - `node scripts/update-packages.mjs publish --dry-run`
  - `node scripts/maintenance.mjs mirror --all`
  - `git status`

**`prompts.test.ts`:** the planner prompt contains `Publish: <package>` and no longer lists `updates.bat` as a Wait example; the execute prompt names `publish_packages`.

**Commands** (all fast, under 2 minutes):
- unity-packages: `node scripts/package.mjs check`. Expect all tests to pass and check-packages to be clean.
- knowledge: `npm run check`. Expect validation and tests to pass.
- pi-config: `cd pi/agent/extensions/workflow && node --experimental-strip-types --test <README list> registry-publish.test.ts`. Expect 0 failures.

### 7. Done when
- In an approved plan, `**S<n>.** Publish: com.iecgames.core` placed after a `Deliver: merge` publishes the version this flow merged and pushes its tag, without anyone typing `publish`.
- While an older version of that package or a pinned `com.iecgames.*` dependency is unpublished, the step waits, then resumes on its own once the tag appears. It never publishes another session's version.
- A version that is superseded or not on origin/main fails the step, with nothing published.
- These are refused:
  - a package the plan doesn't name;
  - the executor calling `npm publish`, `updates.bat publish`, `update-packages.mjs publish` or `maintenance.mjs mirror --confirm` directly.
- `Mirror:` steps mirror through the same tool and lock.
- The interactive `updates.bat publish` and `mirror` behave as before.
- `unity-packages/AGENTS.md`, the README and both knowledge playbooks state the new rule.
- All test commands in section 6 pass.

### 8. Risks, rollback and what not to touch
- **Risk: a published version can't be withdrawn.** The safeguards are the candidate check, the package names in the plan, the guard, and the registry's own refusals.
- **Risk: squash or rebase merges.** With these, `mergedHead` is not on main. That is why the version is checked against the candidate list, not by ancestry.
- **Rollback:** revert the stage 2 PR, and agents fall back to `Wait:` steps. Stage 1's flags are harmless without it.
- **Don't touch:**
  - `publish-package.mjs`, except doc comments;
  - the tag-push block in `publishLocal` (`update-packages.mjs:252-274`);
  - the vendored Unity skills;
  - any package `version` or `CHANGELOG.md`. These are script-only changes, so no package bump.

### 9. Commits
- unity-packages: `publish, mirror: non-interactive --only/--confirm forms for agents`. Files: `scripts/update-packages.mjs`, `scripts/lib/sdk-updates.mjs`, `scripts/maintenance.mjs`, both test files, `AGENTS.md`, `README.md`.
- knowledge: `playbooks: agents publish and mirror from approved plans`. Files: `entries/eng/playbook/unity-packages-updates-menu.md`, `entries/eng/playbook/release-code-packages.md`.
- pi-config: `workflow: Publish and Mirror steps with publish_packages`. Files: `registry-publish.ts`, `registry-publish.test.ts`, `index.ts`, `push-guard.ts`, `push-guard.test.ts`, `prompts.ts`, `prompts.test.ts`, `waits.ts`, `README.md`, `docs/workflow-improvements.md`.

## Amendment 1 (arbiter)
**S1 (amended).** `publishSelection` in `scripts/lib/sdk-updates.mjs`:
- Add a `kind` field to every `blockedBy` entry: `"missing"` (tagged, not on the registry) or `"new"` (no tag). Take it from the candidate. For a `dependency` blocker that is not a candidate, use `"new"`.
- JSON contract: `blockedBy: [{name, version, tag, reason: "older"|"dependency", kind: "missing"|"new"}]`.
- Tests:
  - the `older` blocker test expects `kind: "missing"` when the older candidate has `kind: "missing"`;
  - the dependency test checks `kind` as well.

**S2 (amended).** In `scripts/update-packages.mjs`, add a check form: `publish --only <list> --dry-run --unblocked`.
- It prints nothing on stdout.
- Exit codes: 0 when `blockedBy` is empty (and `notCandidates` is empty); 3 while blocked; 1 on a missing token or a registry error.
- It reuses the same `publishOnly` path, so the registry decides when the wait ends, not the tags.
- Document it in `USAGE`, the header and the README next to `--json`.
- `--unblocked` without `--dry-run` and `--only` is a usage error (exit 2).

**S8 (amended).** In `registry-publish.ts`, replace `tagWaitCheck(root, tags)` with `blockedWaitCheck(root: string, items: {name: string; version: string}[]): string`.
- It returns `node '<root>/scripts/update-packages.mjs' publish --only '<list>' --dry-run --unblocked`, with forward slashes and the same quoting rules.
- `registryPublishProblem` must keep allowing it, since it is a `--dry-run` form. Test that.
- Tests: quoting, and the guard allows the result. Drop the `readOnlyProblem` assertion, because the tool sets `state.waiting` itself and does not go through `wait_for_user`.

**S9 (amended).** In `publish_packages`:
- The blocked wait uses `blockedWaitCheck` with the step's items.
- When it is called again for the same step while it is still blocked, the new wait keeps the earlier wait's `since`. Store it per step, for example in `state.waiting.since` carried over, or in a `publishWaitSince[step]` value that is persisted and cleared when the step finishes. This way the existing 1-hour timeout counts across re-blocks and notifies the user instead of looping.
- Tests: the second blocked call for the same step keeps the first `since`.

## Amendment 2 (arbiter)
**S9 (amended, Publish step "already published" rule).** In `index.ts` `runPublish`:
- **What changes:** stop dropping an item just because its tag is on origin before the dry run.
- **Dry run:** pass every item read from the merged head to the `--dry-run --only … --json` run.
- **Reading the result:**
  - An item in the result's `items`, including `kind: "missing"`, is published normally. The tag is already there, so the script only re-uploads it.
  - An item in `notCandidates` whose tag `<name>/v<version>` exists on origin (`git ls-remote --tags origin <tag>` is not empty) counts as "already published". It is dropped from the run and listed in the reply. The script leaves a tagged version out of the candidates only when the registry already has it, or a newer version, so there is nothing left to publish.
  - An item in `notCandidates` without a tag on origin fails the step as now: "superseded or not on origin/main; nothing published".
  - If every item is "already published", the reply is "already published; tick the step", and `publishWaitSince` for the step is cleared.
  - Blockers and the real run then use only the remaining items.
- **Why:** a tag on origin is not proof that the registry has the version. The script's candidate list, which comes from the registry, is the proof.
- **Tests:**
  - Move the decision into a pure helper in `registry-publish.ts`: `classifyPublish(items, dryResult, taggedOnOrigin: Set<string>): { publish: Item[]; alreadyPublished: Item[]; notPublishable: string[] }`.
  - Case 1: a tagged item that is in the dry run's `items` goes to `publish`.
  - Case 2: a tagged item in `notCandidates` goes to `alreadyPublished`.
  - Case 3: an untagged item in `notCandidates` goes to `notPublishable`.
- **README:** in the "Publish and Mirror steps" paragraph, replace "drops versions whose tag is already on origin" with "skips versions the registry already has (tagged and no longer a candidate)".

<!-- pi-workflow:status -->
## Checklist
- [x] S1 In `unity-packages/scripts/lib/sdk-updates.mjs`, next to `orderItems` (`:192`), add the pure exported function `publishS
- [x] S2 In `scripts/update-packages.mjs`:
- [x] S3 In `scripts/maintenance.mjs`:
- [x] S4 Tests (section 6) in `scripts/update-packages.test.mjs` and `scripts/maintenance.test.mjs`.
- [x] S5 `unity-packages/AGENTS.md`, rule 5. Replace it with:
- [x] S6 Knowledge:
- [x] S7 Run the stage 1 tests (section 6).
- [x] S8 Add a new pure module, `pi-config/pi/agent/extensions/workflow/registry-publish.ts`, modelled on `checkpoints.ts` and `w
- [x] S9 In `index.ts`:
- [x] S10 Prompts and docs:
- [x] S11 Tests (section 6):
- [x] S12 `docs/workflow-improvements.md`:
- [x] S13 Run the stage 2 tests (section 6).
## For you after the flow
- S14 Verify: after both stages are merged, run a `Publish:` step in the next real package release flow. Look for:
## Outcome
2026-10-23T02:47:31.480Z — failed: stage 1: unity-packages: committed, PR #289 merged; knowledge: committed, PR #163 merged; stage 2: pi-config: committed (1 commit), pushed, no open pull request · 1 human check(s) for you (see the card)
