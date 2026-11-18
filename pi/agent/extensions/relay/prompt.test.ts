// node --experimental-strip-types --import ../agents/test-hooks.ts --test prompt.test.ts
// The worker prompt's Workspace section: every repo of job.repos with worktree, branch, target, base and rules files.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { workerPrompt, workspaceSection } from "./steps/dispatch.ts";
import { cleanup, tmpDir } from "./test/helpers.ts";

const repo = (key: string, worktree: string, over = {}) => ({ key, main: worktree, worktree, target: "main", base: "abc123", branch: `wt/${key}`, ...over });

test("workspaceSection lists every repo with branch, target, base and rules files as path and size", () => {
	const root = tmpDir();
	const a = path.join(root, "a");
	const b = path.join(root, "b");
	fs.mkdirSync(a);
	fs.mkdirSync(b);
	fs.writeFileSync(path.join(a, "AGENTS.md"), "12345");
	fs.writeFileSync(path.join(a, "CLAUDE.md"), "12");
	const s = workspaceSection({ repos: [repo("a", a), repo("b", b, { target: "dev", base: "def456" })] } as any);
	assert.match(s, /^## Workspace/);
	assert.ok(s.includes(`- a: worktree ${a}, branch wt/a, target main, base abc123`));
	assert.match(s, /AGENTS\.md \(5 bytes\), .*CLAUDE\.md \(2 bytes\)/);
	assert.ok(s.includes("read them before changing this repo"));
	assert.ok(s.includes(`- b: worktree ${b}, branch wt/b, target dev, base def456`));
	assert.equal(s.split("rules files").length - 1, 1, "a repo without rules files has no rules line");
	cleanup(root);
});

test("workerPrompt includes the Workspace section for the start, a restart and a follow-up alike", () => {
	const root = tmpDir();
	const job: any = { cwd: root, briefVersion: 1, repos: [repo("a", root)] };
	const ctx = { relayDir: path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), ""), brief: () => "brief" };
	for (const extra of [undefined, "Restart: x", "Follow-up 1 on a finished job: y"]) assert.ok(workerPrompt(ctx, job, extra).includes("## Workspace"));
	cleanup(root);
});
