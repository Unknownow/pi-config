import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { type PlanStatus } from "./plan-doc.ts";
import { deleteLocal, type Git, plansDir, readLocalStatuses, writeLocal } from "./plan-store.ts";

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
