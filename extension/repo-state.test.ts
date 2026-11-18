// node --experimental-strip-types --test extension/repo-state.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { repoState, rebaseBlock } from "./repo-state.ts";
import { startupSync, type StartupDeps } from "./startup.ts";

function gitDir(head: string, markers: string[] = []): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-gitdir-"));
	fs.writeFileSync(path.join(dir, "HEAD"), head);
	for (const m of markers) {
		if (m.startsWith("rebase")) fs.mkdirSync(path.join(dir, m));
		else fs.writeFileSync(path.join(dir, m), "x");
	}
	return dir;
}

test("master with nothing in progress is ok", () => {
	assert.deepEqual(repoState(gitDir("ref: refs/heads/master\n")), { ok: true });
});

test("another branch or a detached HEAD blocks sync", () => {
	const feature = repoState(gitDir("ref: refs/heads/flow/merge-fixes\n"));
	assert.equal(feature.ok, false);
	assert.match((feature as { reason: string }).reason, /flow\/merge-fixes/);
	assert.equal(repoState(gitDir("0123456789abcdef0123456789abcdef01234567\n")).ok, false);
});

test("a rebase, merge, cherry-pick or revert in progress blocks sync, even on master", () => {
	for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
		const state = repoState(gitDir("ref: refs/heads/master\n", [marker]));
		assert.equal(state.ok, false, marker);
		assert.match((state as { reason: string }).reason, new RegExp(marker));
	}
});

test("a missing git dir blocks sync and does not throw", () => {
	assert.equal(repoState(path.join(os.tmpdir(), "pi-config-no-such-gitdir")).ok, false);
});

test("a rebase is allowed only when nothing tracked differs and every unpushed commit is a sync commit", () => {
	const sync = "chore(config): sync from HOST";
	assert.equal(rebaseBlock("", [sync, sync]), null);
	assert.deepEqual(rebaseBlock(" M pi/agent/a.json\n?? x\n", [sync]), { files: ["pi/agent/a.json", "x"], foreign: [] });
	assert.deepEqual(rebaseBlock("", [sync, "feat: mine"]), { files: [], foreign: ["feat: mine"] });
});

function fakeDeps(order: string[], over: Partial<StartupDeps> = {}): StartupDeps {
	return {
		guard: async () => (order.push("guard"), null),
		exportAndCommit: async () => (order.push("export"), "committed 1 change(s)"),
		pull: async () => (order.push("pull"), { ok: true, note: "pulled" }),
		importIfChanged: async () => (order.push("import"), { written: 2, note: "imported 2" }),
		restartNotice: (n) => void order.push(`notice:${n}`),
		log: () => {},
		...over,
	};
}

test("startup guards, exports unsynced machine changes before the pull, then imports and notifies", async () => {
	const order: string[] = [];
	const result = await startupSync(fakeDeps(order), { pullOnStart: true, autoImportOnStart: true });
	assert.deepEqual(order, ["guard", "export", "pull", "import", "notice:2"]);
	assert.equal(result.written, 2);
});

test("startup does no sync at all when the guard blocks (not master, rebase in progress)", async () => {
	const order: string[] = [];
	const result = await startupSync(fakeDeps(order, { guard: async () => (order.push("guard"), "on branch feature, not master") }), {
		pullOnStart: true,
		autoImportOnStart: true,
	});
	assert.deepEqual(order, ["guard"]);
	assert.equal(result.ran, false);
});

test("startup skips the import when the pull fails, and honours the config switches", async () => {
	let order: string[] = [];
	const failed = await startupSync(fakeDeps(order, { pull: async () => (order.push("pull"), { ok: false, note: "pull failed" }) }), { pullOnStart: true, autoImportOnStart: true });
	assert.deepEqual(order, ["guard", "export", "pull"]);
	assert.match(failed.importSkipped ?? "", /pull failed/);

	order = [];
	await startupSync(fakeDeps(order), { pullOnStart: false, autoImportOnStart: true });
	assert.deepEqual(order, ["guard", "export", "import", "notice:2"]);

	order = [];
	await startupSync(fakeDeps(order), { pullOnStart: true, autoImportOnStart: false });
	assert.deepEqual(order, ["guard", "export", "pull"]);

	order = [];
	await startupSync(fakeDeps(order, { importIfChanged: async () => (order.push("import"), { written: 0, note: "nothing" }) }), { pullOnStart: false, autoImportOnStart: true });
	assert.deepEqual(order, ["guard", "export", "import"]);
});
