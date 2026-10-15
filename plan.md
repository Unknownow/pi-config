<!-- pi-workflow plan v1 flow=20261015-1126-fast-forward-pi-config-master-to-the-wor-da35 -->
## Plan: Fast-forward pi-config `master` to the worktree extension and push

1. **Goal and non-goals**
   - **Goal:** put the three worktree-extension commits on pi-config's `master` and on `origin/master`, then leave the local checkout on `master`. The commits are `64eda7d` (`/wt new`), `f8c4f25` (`/wt list` and `/wt remove`) and `76a42c0` (Unity guard and worktree prompt).
   - **Non-goals:**
     - No code changes and no new commits: no merge commits, no rebase, no squash.
     - No pull request.
     - The game-template, knowledge and unity-packages repos are not touched.
     - The `feat/worktree-extension` branch is not deleted, locally or on origin.

2. **User decisions**
   - D1. Push the work to `master` in pi-config ("push to master for me").
   - D2. Don't use separate branches ("no need for different branches"), so the checkout ends on `master`.

3. **Facts the executor needs**
   - Repo: `D:/projects/pi-config` (bash path `/d/projects/pi-config`). The current branch is `feat/worktree-extension` at `76a42c0`, and it tracks `origin/feat/worktree-extension`. The working tree is clean.
   - Local `master` and `origin/master` are both at `95c9c13` (`chore(config): sync from CuongPT-dev`).
   - `git merge-base --is-ancestor origin/master feat/worktree-extension` succeeds, so the update is a pure fast-forward.
   - `core.hooksPath` is `.githooks`, which holds only `pre-commit` and no `pre-push`. Nothing blocks a push to `master` in this repo.
   - The pi-config sync extension may auto-commit to `master` (`chore(config): sync from ...`). That can move `origin/master` before the push.

4. **Design:** not applicable; there are no component changes.

5. **Steps**
   - **S1.** In `/d/projects/pi-config`:
     - Run `git status --short` and `git fetch origin`.
     - Stop and report if any of these fail: the status output is not empty; `git merge-base --is-ancestor origin/master feat/worktree-extension` does not succeed (origin moved and is no longer a fast-forward); or `git rev-parse feat/worktree-extension` is not `76a42c0…`.
     - Do not rebase, merge, stash or force anything to get past a stop.
   - **S2.** Run `git push origin feat/worktree-extension:master`.
     - It must be a fast-forward push. Never use `--force`, `--force-with-lease` or `--no-verify`.
     - If the remote rejects it (non-fast-forward), stop and report.
   - **S3.** Run `git checkout master`, then `git merge --ff-only origin/master`. Local `master` must end at `76a42c0` (or at the same commit as `origin/master`), and `git status -sb` must show `## master...origin/master` with no ahead/behind counts.
   - **S4.** Report the final `git log --oneline -4` on `master`. Also say that the `feat/worktree-extension` branch still exists locally and on origin, and that it will only be deleted if the user asks.

6. **Tests:** there are no code changes, so no test suites are needed. The checks are commands:
   - `git rev-parse --short master origin/master` prints the same hash twice, and it is `76a42c0` unless origin moved by a fast-forward in S1.
   - `git log --oneline origin/master -4` lists `76a42c0`, `f8c4f25`, `64eda7d` and `95c9c13` in that order.
   - `git status --short` prints nothing, and `git branch --show-current` prints `master`.

7. **Done when**
   - `origin/master` contains `64eda7d`, `f8c4f25` and `76a42c0`, reached by a fast-forward with no force push.
   - The local checkout is on `master`, level with `origin/master`, with a clean working tree.
   - No other repo and no other branch has changed.

8. **Risks, rollback, and what not to touch**
   - **Risk:** an auto-sync commit lands on `origin/master` between S1 and S2. The push is then rejected; stop and report, and never force.
   - **Rollback:** do not rewrite `master`. Revert with `git revert 76a42c0 f8c4f25 64eda7d` on `master`, and only if the user asks. The feature can also be switched off by deleting `~/.pi/agent/extensions/worktree/` and restarting pi.
   - **Do not touch:** the game-template, knowledge and unity-packages repos; any `workflow/*` files; the `feat/worktree-extension` branch.

9. **Commits:** none. S2 publishes the three existing commits unchanged:
   - `feat(worktree): /wt new creates worktrees and opens pi in a new window` (`64eda7d`)
   - `feat(worktree): /wt list and /wt remove` (`f8c4f25`)
   - `feat(worktree): guard Unity Editor and set the prompt in worktree sessions` (`76a42c0`)

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 In `/d/projects/pi-config`:
- [ ] S2 Run `git push origin feat/worktree-extension:master`.
- [ ] S3 Run `git checkout master`, then `git merge --ff-only origin/master`. Local `master` must end at `76a42c0` (or at the sam
- [ ] S4 Report the final `git log --oneline -4` on `master`. Also say that the `feat/worktree-extension` branch still exists loc
