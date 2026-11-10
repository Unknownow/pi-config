import assert from "node:assert/strict";
import test from "node:test";
import gitGuard, { parseGuardSpec } from "./git-guard.ts";

type Handler = (event: { toolName: string; input: { command: string } }, ctx: { cwd: string }) => Promise<{ block: boolean; reason: string } | undefined>;

function handler(): Handler {
	let h: Handler | undefined;
	gitGuard({ on: (_name: string, fn: Handler) => (h = fn) } as never);
	return h as Handler;
}

test("parseGuardSpec round-trips a valid spec", () => {
	const spec = { roots: ["/a", "/b"], protectedBranches: ["main"], passedTrees: { "/a": ["t1"] }, noMerge: false };
	assert.deepEqual(parseGuardSpec(JSON.stringify(spec)), spec);
});

test("parseGuardSpec keeps the ungated flag and rejects a non-boolean one", () => {
	const base = { roots: [], protectedBranches: ["main"], passedTrees: {}, noMerge: false };
	assert.equal(parseGuardSpec(JSON.stringify({ ...base, ungated: true }))?.ungated, true);
	assert.equal(parseGuardSpec(JSON.stringify({ ...base, ungated: "yes" })), null);
});

test("parseGuardSpec rejects missing or malformed specs", () => {
	assert.equal(parseGuardSpec(undefined), null);
	assert.equal(parseGuardSpec(""), null);
	assert.equal(parseGuardSpec("{}"), null);
	assert.equal(parseGuardSpec("not json"), null);
	assert.equal(parseGuardSpec(JSON.stringify({ roots: "x", protectedBranches: [], passedTrees: {}, noMerge: false })), null);
	assert.equal(parseGuardSpec(JSON.stringify({ roots: [], protectedBranches: [], passedTrees: { a: "t" }, noMerge: false })), null);
	assert.equal(parseGuardSpec(JSON.stringify({ roots: [], protectedBranches: [], passedTrees: {}, noMerge: "no" })), null);
});

test("the handler blocks registry publishing, git without settings, and lets other commands through", async () => {
	delete process.env.PI_WORKFLOW_GIT_GUARD;
	const h = handler();
	const run = (command: string) => h({ toolName: "bash", input: { command } }, { cwd: process.cwd() });
	assert.equal((await run("npm " + "publish"))?.block, true);
	assert.match((await run("git status"))?.reason ?? "", /settings are missing/);
	assert.equal(await run("ls"), undefined);
});

test("parseGuardSpec keeps midFlow as a string, rejects other types, and omits it when absent", () => {
	const base = { roots: [], protectedBranches: ["main"], passedTrees: {}, noMerge: false };
	assert.equal(parseGuardSpec(JSON.stringify({ ...base, midFlow: "not planned" }))?.midFlow, "not planned");
	assert.equal(parseGuardSpec(JSON.stringify({ ...base, midFlow: 3 })), null);
	assert.equal("midFlow" in (parseGuardSpec(JSON.stringify(base)) ?? {}), false);
});

test("parseGuardSpec keeps acceptance as a string and rejects other types", () => {
	const base = { roots: [], protectedBranches: ["main"], passedTrees: {}, noMerge: false };
	assert.equal(parseGuardSpec(JSON.stringify({ ...base, acceptance: "not accepted" }))?.acceptance, "not accepted");
	assert.equal(parseGuardSpec(JSON.stringify({ ...base, acceptance: 3 })), null);
	assert.equal("acceptance" in (parseGuardSpec(JSON.stringify(base)) ?? {}), false);
});

test("acceptance refuses a merge, and ungated overrides it", async () => {
	const base = { roots: [], protectedBranches: ["main"], passedTrees: {}, noMerge: false, acceptance: "ACCEPT-FIRST" };
	process.env.PI_WORKFLOW_GIT_GUARD = JSON.stringify(base);
	try {
		const r = await handler()({ toolName: "bash", input: { command: "gh pr merge 5 --merge" } }, { cwd: process.cwd() });
		assert.equal(r?.block, true);
		assert.match(r?.reason ?? "", /ACCEPT-FIRST/);
		process.env.PI_WORKFLOW_GIT_GUARD = JSON.stringify({ ...base, ungated: true });
		const u = await handler()({ toolName: "bash", input: { command: "gh pr merge 5 --merge" } }, { cwd: process.cwd() });
		assert.equal(u, undefined);
	} finally {
		delete process.env.PI_WORKFLOW_GIT_GUARD;
	}
});
