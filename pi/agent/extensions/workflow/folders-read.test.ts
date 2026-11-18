// node --experimental-strip-types --test folders-read.test.ts
// The workflow only reads the session's folders (the workspace extension's `session-folders` entry): it never writes the entry
// or the `workspace` prompt section, and repos it learns of later (a resumed plan, a folder added mid-flow) still reach the judge.
await import("./test-hooks.ts");
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const { createFlow } = await import("./flow/context.ts");
const { collectFlowDiff, existingFolders, flowRepos } = await import("./flow/diff.ts");
const { resumedRepos } = await import("./flow/resume.ts");

const dir = new URL(".", import.meta.url);
const sources = [...fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")), ...fs.readdirSync(new URL("flow/", dir)).filter((f) => f.endsWith(".ts")).map((f) => `flow/${f}`)].map((f) => ({ f, text: fs.readFileSync(new URL(f, dir), "utf8") }));

test("the workflow never assigns the workspace prompt section and keeps no folder list of its own", () => {
	assert.ok(sources.length > 10);
	for (const { f, text } of sources) {
		assert.ok(!/sections\s*(\.\s*workspace|\[\s*["']workspace["']\s*\])\s*=[^=]/.test(text), `${f} assigns sections.workspace`);
		assert.ok(!/state\.folders\b/.test(text), `${f} uses fl.state.folders`);
		assert.ok(!text.includes('registerCommand("folders"') && !text.includes('registerFlag("add-dir"'), `${f} registers /folders or --add-dir`);
	}
});

test("workflowRepos is set on every turn just before the workflow section", () => {
	const hooks = sources.find((s) => s.f === "flow/hooks.ts")!.text;
	const i = hooks.indexOf("opts.sections.workflowRepos = ");
	const j = hooks.indexOf("opts.sections.workflow = ");
	assert.ok(i > 0 && j > i, "workflowRepos comes first");
	assert.ok(!/\n\s*(if|else)[^\n]*\n?\s*opts\.sections\.workflowRepos/.test(hooks), "it is not conditional");
	assert.equal(hooks.slice(i, j).split("\n").length, 2, "nothing between the two assignments");
});

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function repo(name: string): string {
	const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wf-folders-")), name);
	fs.mkdirSync(d);
	sh(d, "init", "-q", "-b", "main");
	sh(d, "config", "user.email", "t@t");
	sh(d, "config", "user.name", "t");
	fs.writeFileSync(path.join(d, "a.txt"), "a\n");
	sh(d, "add", ".");
	sh(d, "commit", "-qm", "init");
	return sh(d, "rev-parse", "--show-toplevel").trim();
}
const entry = (cwd: string, folders: string[]) => ({ type: "custom", customType: "session-folders", data: { v: 1, cwd: cwd.replace(/\\/g, "/"), folders } });
const ctxOf = (cwd: string, branch: unknown[] = []) => ({ cwd, sessionManager: { getBranch: () => branch }, ui: { notify: () => {}, setStatus: () => {} }, hasUI: false }) as never;
const fakePi = new Proxy(
	{
		exec: async (cmd: string, args: string[]) => {
			try {
				return { code: 0, stdout: execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 }), stderr: "" };
			} catch (e) {
				const x = e as { status?: number; stdout?: string; stderr?: string };
				return { code: x.status ?? 1, stdout: x.stdout ?? "", stderr: x.stderr ?? "" };
			}
		},
	},
	{ get: (t, k) => (k in t ? (t as Record<PropertyKey, unknown>)[k] : () => undefined) },
) as never;

test("existingFolders reads the session-folders entry for this working folder and skips missing folders", () => {
	const a = repo("work");
	const b = repo("other");
	assert.deepEqual(existingFolders(ctxOf(a, [entry(a, [b, `${b}/missing`])])), [b]);
	assert.deepEqual(existingFolders(ctxOf(a, [entry("D:/elsewhere", [b])])), [], "an entry for another working folder does not count");
});

test("resumedRepos keeps the plan's other repos, not the working folder, added folders or repos already in the flow", () => {
	const p = (s: string) => path.resolve(s).replace(/\\/g, "/");
	const r = resumedRepos([p("/w"), p("/x"), p("/y"), p("/z"), p("/x")], { cwd: p("/w/sub"), cwdRoot: p("/w"), folders: [p("/y")], touched: [p("/z")] });
	assert.deepEqual(r, [p("/x")]);
});

test("a resumed plan's repo and a folder added mid-flow join the judge diff, each from a lazy review base", async () => {
	const a = repo("work");
	const b = repo("other");
	const c = repo("third");
	fs.writeFileSync(path.join(b, "b.txt"), "changed in b\n");
	fs.writeFileSync(path.join(c, "c.txt"), "changed in c\n");
	const fl = createFlow(fakePi);
	fl.state = { phase: "execute", escalated: false, judgeRounds: 0, touchedRepos: resumedRepos([a, b], { cwd: a, cwdRoot: a, folders: [], touched: [] }) };
	const branch: unknown[] = [];
	const ctx = ctxOf(a, branch);
	branch.push(entry(a, [c]));
	assert.deepEqual((await flowRepos(fl, ctx)).map((r) => r.root), [a, c, b]);
	const diff = await collectFlowDiff(fl, ctx);
	assert.ok(diff, "a diff");
	assert.ok(diff.names.some((n) => n.endsWith("b.txt")), "the resumed plan's repo is reviewed");
	assert.ok(diff.names.some((n) => n.endsWith("c.txt")), "the added folder's repo is reviewed");
	for (const r of [b, c]) assert.ok(fl.state.reviewBase?.[Object.keys(fl.state.reviewBase).find((k) => k.toLowerCase() === r.toLowerCase()) ?? r], `${r} got a review base`);
});
