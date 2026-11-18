// node --experimental-strip-types --test added-folders.test.ts
// /folders, --add-dir, the prompt section and the session-folders entry with only this extension loaded (a fake pi; the pi
// packages are stubbed because they are not installed next to the tests).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { registerHooks } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const STUBS: Record<string, string> = {
	"@earendil-works/pi-coding-agent": `export const getAgentDir = () => ""; export const loadProjectContextFiles = ({ cwd }) => { try { return [{ path: cwd + "/AGENTS.md", content: require("node:fs").readFileSync(cwd + "/AGENTS.md", "utf8") }]; } catch { return []; } };`.replace(
		'require("node:fs")',
		"globalThis.__fs",
	),
	"@earendil-works/pi-tui": `export const truncateToWidth = (s) => s;`,
};
(globalThis as { __fs?: unknown }).__fs = fs;
registerHooks({
	resolve(specifier, context, next) {
		const stub = STUBS[specifier];
		if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
		return next(specifier, context);
	},
});
const { registerFolders } = await import("./added-folders.ts");

type Handler = (...a: unknown[]) => unknown;
const slash = (p: string) => p.replace(/\\/g, "/");

function setup(o: { flag?: string; branch?: unknown[]; rules?: "paths" | "full" } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-folders-"));
	const cwd = path.join(root, "work");
	const a = path.join(root, "a");
	const b = path.join(root, "b");
	for (const d of [cwd, a, b]) fs.mkdirSync(d);
	const branch: unknown[] = [...(o.branch ?? [])];
	const appended: { type: string; data: { v: number; cwd: string; folders: string[] } }[] = [];
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: Handler; getArgumentCompletions: (p: string) => unknown }>();
	const flags: string[] = [];
	const notes: string[] = [];
	const status = new Map<string, string | undefined>();
	let reloads = 0;
	const pi = {
		registerFlag: (name: string) => void flags.push(name),
		registerCommand: (name: string, c: { handler: Handler; getArgumentCompletions: (p: string) => unknown }) => void commands.set(name, c),
		on: (event: string, h: Handler) => void handlers.set(event, h),
		getFlag: (name: string) => (name === "add-dir" ? o.flag : undefined),
		appendEntry: (type: string, data: { v: number; cwd: string; folders: string[] }) => {
			appended.push({ type, data });
			branch.push({ type: "custom", customType: type, data });
		},
	};
	const ctx = {
		cwd,
		hasUI: true,
		sessionManager: { getBranch: () => branch },
		ui: { notify: (m: string) => void notes.push(m), setStatus: (k: string, v: string | undefined) => void status.set(k, v) },
		waitForIdle: async () => {},
		reload: async () => void reloads++,
	};
	const folders = registerFolders(pi as never, { git: () => async () => ({ code: 1, stdout: "", stderr: "" }), set: () => null, rules: () => o.rules ?? "paths" });
	const run = (args: string) => commands.get("folders")!.handler(args, ctx);
	return { root, cwd, a, b, branch, appended, handlers, commands, flags, notes, status, folders, ctx, run, reloads: () => reloads };
}

test("registers /folders and --add-dir, the prompt hook and resources_discover", () => {
	const s = setup();
	assert.deepEqual(s.flags, ["add-dir"]);
	assert.ok(s.commands.has("folders"));
	assert.ok(s.handlers.has("before_agent_start") && s.handlers.has("resources_discover"));
});

test("no folders, no entry; a missing --add-dir folder is skipped with a warning; a reload writes nothing", async () => {
	const t = setup();
	await t.folders.start("startup", t.ctx as never);
	assert.equal(t.appended.length, 0, "no folders, no entry");
	const s = setup({ flag: path.join(os.tmpdir(), "ws-nope-missing") });
	await s.folders.start("startup", s.ctx as never);
	assert.equal(s.appended.length, 0);
	assert.match(s.notes[0], /--add-dir .*: not a folder, skipped/);
	const base = setup();
	const r = setup({ flag: base.a });
	await r.folders.start("reload", r.ctx as never);
	assert.equal(r.appended.length, 0, "a reload never applies --add-dir");
});

test("/folders add, list and remove keep the list and write the entry; each change reloads", async () => {
	const s = setup();
	await s.folders.start("startup", s.ctx as never);
	await s.run(`add ${s.a}`);
	assert.deepEqual(s.appended.at(-1)!.data, { v: 1, cwd: slash(s.cwd), folders: [slash(s.a)] });
	assert.equal(s.appended.at(-1)!.type, "session-folders");
	await s.run(`add ${s.b}`);
	assert.deepEqual(s.folders.list(), [slash(s.a), slash(s.b)]);
	assert.equal(s.status.get("workspace-folders"), "+2 folders");
	await s.run(`add ${s.a}`);
	assert.match(s.notes.at(-1)!, /already added/);
	await s.run("add .");
	assert.match(s.notes.at(-1)!, /already the working folder/);
	await s.run("list");
	assert.match(s.notes.at(-1)!, /1\. .*\/a.*\n2\. .*\/b/);
	await s.run("remove 1");
	assert.deepEqual(s.appended.at(-1)!.data.folders, [slash(s.b)]);
	await s.run(`remove ${s.b}`);
	assert.deepEqual(s.appended.at(-1)!.data.folders, []);
	assert.equal(s.status.get("workspace-folders"), undefined);
	assert.equal(s.appended.length, 4);
	assert.equal(s.reloads(), 4);
	await s.run("remove 9");
	assert.match(s.notes.at(-1)!, /not in the folder list/);
});

test("--add-dir joins the list at startup, not on a resume", async () => {
	const base = setup();
	const s = setup({ flag: base.a });
	await s.folders.start("resume", s.ctx as never);
	assert.equal(s.appended.length, 0);
	await s.folders.start("startup", s.ctx as never);
	assert.deepEqual(s.appended.at(-1)!.data.folders, [slash(base.a)]);
});

test("the list is seeded from the session's entry and not written again; a session from before migrates once", async () => {
	const s = setup();
	const entry = { type: "custom", customType: "session-folders", data: { v: 1, cwd: slash(s.cwd), folders: [slash(s.a)] } };
	s.branch.push(entry);
	await s.folders.start("resume", s.ctx as never);
	assert.deepEqual(s.folders.list(), [slash(s.a)]);
	assert.equal(s.appended.length, 0);

	const old = setup();
	old.branch.push({ type: "custom", customType: "workflow-state", data: { phase: "off", folders: [slash(old.b)] } });
	await old.folders.start("resume", old.ctx as never);
	assert.deepEqual(old.appended.map((e) => e.data.folders), [[slash(old.b)]]);
	await old.folders.start("resume", old.ctx as never);
	assert.equal(old.appended.length, 1, "written once");
	assert.deepEqual(old.branch.filter((e) => (e as { customType?: string }).customType === "workflow-state").length, 1, "the workflow state is only read");
});

test("the workspace section is set on every turn, also without folders; rules files are listed or loaded", async () => {
	const s = setup();
	await s.folders.start("startup", s.ctx as never);
	const turn = async (rules?: "full") => {
		const opts = { sections: {} as Record<string, string>, contextFiles: [] as { path: string; content: string }[] };
		const t = rules ? setup({ rules }) : s;
		if (rules) {
			await t.folders.start("startup", t.ctx as never);
			fs.writeFileSync(path.join(t.a, "AGENTS.md"), "rules!");
			await t.run(`add ${t.a}`);
		}
		await t.handlers.get("before_agent_start")!({ systemPromptOptions: opts }, t.ctx);
		return opts;
	};
	const empty = await turn();
	assert.match(empty.sections.workspace, /^Working folder: /);
	assert.ok(!empty.sections.workspace.includes("Added folders"));
	fs.writeFileSync(path.join(s.a, "AGENTS.md"), "rules");
	await s.run(`add ${s.a}`);
	const listed = await turn();
	assert.match(listed.sections.workspace, /Added folders/);
	assert.match(listed.sections.workspace, /AGENTS\.md \(5 characters\)/);
	assert.equal(listed.contextFiles.length, 0);
	const full = await turn("full");
	assert.equal(full.contextFiles.length, 1);
	assert.ok(!full.sections.workspace.includes("Rules files"));
});

test("resources_discover gives the added folders' skills and prompts", async () => {
	const s = setup();
	await s.folders.start("startup", s.ctx as never);
	fs.mkdirSync(path.join(s.a, ".pi", "skills"), { recursive: true });
	fs.mkdirSync(path.join(s.a, ".pi", "prompts"), { recursive: true });
	await s.run(`add ${s.a}`);
	const r = (await s.handlers.get("resources_discover")!()) as { skillPaths: string[]; promptPaths: string[] };
	assert.deepEqual(r.skillPaths, [path.join(slash(s.a), ".pi", "skills")]);
	assert.deepEqual(r.promptPaths, [path.join(slash(s.a), ".pi", "prompts")]);
});

test("completions of /folders read the live list", async () => {
	const s = setup();
	await s.folders.start("startup", s.ctx as never);
	await s.run(`add ${s.a}`);
	const items = s.commands.get("folders")!.getArgumentCompletions("remove ") as { value: string }[];
	assert.deepEqual(items.map((i) => i.value), ["remove 1"]);
});
