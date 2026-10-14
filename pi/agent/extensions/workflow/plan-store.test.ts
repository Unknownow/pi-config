import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { type PlanStatus } from "./plan-doc.ts";
import { adoptHigher, commitRef, deleteLocal, deleteRef, fetchMirror, type Git, listRefs, plansDir, pushRef, readLocalStatuses, readPlanMd, refRev, remoteOf, writeLocal } from "./plan-store.ts";

const git: Git = async (cwd, args, env) => {
	try {
		const stdout = execFileSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { code: 0, stdout, stderr: "" };
	} catch (e: any) {
		return { code: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
	}
};

const ID = "20261015-0930-demo-a1b2";
const status: PlanStatus = { v: 1, flowId: ID, rev: 1, updated: "2026-10-15T09:30:00.000Z", title: "Demo", done: ["S1"], repos: [{ primary: true }] };

test("writeLocal and readLocalStatuses", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-store-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd: root });
		const dir = await plansDir(git, root, "/unused");
		const file = writeLocal(dir, ID, "# plan\n", status);
		assert.ok(file.replaceAll(path.sep, "/").endsWith(`/.git/pi/plans/${ID}/plan.md`));
		assert.equal(fs.readFileSync(file, "utf8"), "# plan\n");
		const list = readLocalStatuses(dir);
		assert.equal(list.length, 1);
		assert.deepEqual(list[0].status, status);
		assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "");
		deleteLocal(dir, ID);
		assert.deepEqual(readLocalStatuses(dir), []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("plansDir without a repo uses the agent folder; a broken status reads as null", async () => {
	const agent = fs.mkdtempSync(path.join(os.tmpdir(), "plan-agent-"));
	try {
		const dir = await plansDir(git, null, agent);
		assert.equal(dir, path.join(agent, "workflow", "plans"));
		fs.mkdirSync(path.join(dir, ID), { recursive: true });
		fs.writeFileSync(path.join(dir, ID, "status.json"), "{broken");
		const list = readLocalStatuses(dir);
		assert.equal(list[0].status, null);
		deleteLocal(dir, "not-an-id");
		assert.equal(readLocalStatuses(dir).length, 1);
	} finally {
		fs.rmSync(agent, { recursive: true, force: true });
	}
});

const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const statusJson = (rev: number, extra: Partial<PlanStatus> = {}) => JSON.stringify({ ...status, rev, ...extra });

/** A bare remote and two clones of it, each with one commit on master. */
function setup() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "plan-refs-"));
	const bare = path.join(base, "remote.git");
	execFileSync("git", ["init", "-q", "--bare", bare]);
	const a = path.join(base, "a");
	execFileSync("git", ["init", "-q", a]);
	run(a, "remote", "add", "origin", bare);
	run(a, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
	const b = path.join(base, "b");
	execFileSync("git", ["init", "-q", b]);
	run(b, "remote", "add", "origin", bare);
	return { base, bare, a, b };
}

test("commitRef creates a chain on refs/pi/plans", async () => {
	const { base, a } = setup();
	try {
		const head = run(a, "rev-parse", "HEAD");
		const c1 = await commitRef(git, a, ID, "# one\n", statusJson(1));
		const c2 = await commitRef(git, a, ID, "# two\n", statusJson(2));
		assert.ok(c1 && c2);
		assert.equal(run(a, "rev-parse", `${c2}^`), c1);
		assert.equal(run(a, "rev-parse", `refs/pi/plans/${ID}`), c2);
		assert.equal(JSON.parse(run(a, "show", `refs/pi/plans/${ID}:status.json`)).rev, 2);
		assert.equal(await readPlanMd(git, a, `refs/pi/plans/${ID}`), "# two\n");
		assert.equal(run(a, "rev-parse", "HEAD"), head);
		assert.equal(run(a, "status", "--porcelain"), "");
		assert.equal(await commitRef(git, a, "bad id", "x", statusJson(1)), null);
		const list = await listRefs(git, a, "plans");
		assert.equal(list.length, 1);
		assert.equal(list[0].status?.rev, 2);
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});

test("pushRef and fetchMirror round-trip through a bare remote", async () => {
	const { base, a, b } = setup();
	try {
		const remote = await remoteOf(git, a);
		assert.equal(remote?.name, "origin");
		await commitRef(git, a, ID, "# one\n", statusJson(3));
		assert.equal(await pushRef(git, a, "origin", ID), "ok");
		assert.equal(await fetchMirror(git, b, "origin"), true);
		const got = await adoptHigher(git, b, ID);
		assert.equal(got?.rev, 3);
		const list = await listRefs(git, b, "plans");
		assert.deepEqual(list.map((e) => [e.flowId, e.status?.rev]), [[ID, 3]]);
		assert.equal(await readPlanMd(git, b, `refs/pi/plans/${ID}`), "# one\n");
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});

test("pushRef reports rejected on non-fast-forward, and a re-commit on the remote's commit succeeds", async () => {
	const { base, a, b } = setup();
	try {
		await commitRef(git, a, ID, "# base\n", statusJson(1));
		assert.equal(await pushRef(git, a, "origin", ID), "ok");
		await fetchMirror(git, b, "origin");
		await adoptHigher(git, b, ID);
		await commitRef(git, a, ID, "# from a\n", statusJson(2));
		assert.equal(await pushRef(git, a, "origin", ID), "ok");
		await commitRef(git, b, ID, "# from b\n", statusJson(2));
		assert.equal(await pushRef(git, b, "origin", ID), "rejected");
		await fetchMirror(git, b, "origin");
		const remoteCommit = run(b, "rev-parse", `refs/pi/remote-plans/${ID}`);
		const top = await adoptHigher(git, b, ID);
		assert.equal(top?.rev, 2);
		await commitRef(git, b, ID, "# from b\n", statusJson(3), remoteCommit);
		assert.equal(await pushRef(git, b, "origin", ID), "ok");
		assert.equal(run(a, "ls-remote", "origin", `refs/pi/plans/${ID}`).split(/\s/)[0], run(b, "rev-parse", `refs/pi/plans/${ID}`));
		assert.equal(await pushRef(git, b, "nowhere", ID), "failed");
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});

test("deleteRef removes local and remote", async () => {
	const { base, a, bare } = setup();
	try {
		await commitRef(git, a, ID, "# one\n", statusJson(1));
		await pushRef(git, a, "origin", ID);
		assert.ok(run(bare, "for-each-ref", "refs/pi/plans"));
		await deleteRef(git, a, ID, "origin");
		assert.equal(run(a, "for-each-ref", "refs/pi/"), "");
		assert.equal(run(bare, "for-each-ref", "refs/pi/plans"), "");
		await deleteRef(git, a, ID, "origin");
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});

test("refRev reads the adopted rev, so an older snapshot can be recognised", async () => {
	const { base, a, b } = setup();
	try {
		assert.equal(await refRev(git, a, ID), null);
		await commitRef(git, b, ID, "# six\n", statusJson(6));
		assert.equal(await pushRef(git, b, "origin", ID), "ok");
		await fetchMirror(git, a, "origin");
		await adoptHigher(git, a, ID);
		assert.equal(await refRev(git, a, ID), 6);
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});
