// node --experimental-strip-types --test extension/index.test.ts
// Loads the extension against a throwaway repo, a bare remote and a fake home, with a fake pi.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const SRC = path.resolve(import.meta.dirname, "..");

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-ext-"));
	const repo = path.join(root, "repo");
	const home = path.join(root, "home");
	const bare = path.join(root, "remote.git");
	fs.mkdirSync(path.join(repo, "bin"), { recursive: true });
	fs.mkdirSync(path.join(repo, "extension"), { recursive: true });
	fs.mkdirSync(path.join(repo, "config"), { recursive: true });
	fs.mkdirSync(path.join(repo, "local"), { recursive: true });
	for (const f of ["lib.js", "export.js", "import.js", "check-secrets.js"]) fs.copyFileSync(path.join(SRC, "bin", f), path.join(repo, "bin", f));
	for (const f of fs.readdirSync(path.join(SRC, "extension"))) {
		if (f.endsWith(".ts") && !f.includes(".test.") && !f.includes("-child")) fs.copyFileSync(path.join(SRC, "extension", f), path.join(repo, "extension", f));
	}
	fs.writeFileSync(path.join(repo, "local", "sync.json"), JSON.stringify({ autoSyncOnChange: false, notify: false }));
	fs.writeFileSync(path.join(repo, ".gitignore"), "local/\n");
	execFileSync("git", ["init", "-q", "--bare", bare]);
	git(repo, "init", "-q", "-b", "master");
	git(repo, "config", "user.email", "t@example.com");
	git(repo, "config", "user.name", "t");
	git(repo, "config", "core.autocrlf", "false");
	const mirrorFile = path.join(repo, "pi", "agent", "extensions", "demo", "a.ts");
	fs.mkdirSync(path.dirname(mirrorFile), { recursive: true });
	fs.writeFileSync(mirrorFile, "v1\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "base");
	git(repo, "remote", "add", "origin", bare);
	git(repo, "push", "-q", "-u", "origin", "master");
	const agentFile = path.join(home, ".pi", "agent", "extensions", "demo", "a.ts");
	fs.mkdirSync(path.dirname(agentFile), { recursive: true });
	fs.writeFileSync(agentFile, "v1\n");
	return { root, repo, home, bare, mirrorFile, agentFile };
}

let instance = 0;

/** Load a fresh copy of the extension for `env` and return its handlers. */
async function load(env: ReturnType<typeof setup>) {
	process.env.PI_CONFIG_REPO = env.repo;
	process.env.HOME = env.home;
	process.env.USERPROFILE = env.home;
	const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {};
	const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
	const pi = {
		on: (name: string, h: (event: unknown, ctx: unknown) => Promise<void>) => void (handlers[name] = h),
		registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => void (commands[name] = def),
		exec: (cmd: string, args: string[], opts: { cwd?: string } = {}) =>
			new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
				const p = spawn(cmd, args, { cwd: opts.cwd, env: process.env });
				let stdout = "";
				let stderr = "";
				p.stdout.on("data", (d) => (stdout += d));
				p.stderr.on("data", (d) => (stderr += d));
				p.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
			}),
	};
	const mod = await import(`${pathToFileURL(path.join(env.repo, "extension", "index.ts")).href}?n=${++instance}`);
	mod.default(pi);
	return { handlers, commands };
}

const readLog = (env: ReturnType<typeof setup>) => fs.readFileSync(path.join(env.repo, "local", "sync.log"), "utf8");
const subjects = (env: ReturnType<typeof setup>) => git(env.repo, "log", "--format=%s").trim().split(/\r?\n/);

/** A stale ctx: every property access throws, like pi's ctx after a session replacement. */
const staleCtx = new Proxy({}, { get: () => { throw new Error("ctx is stale after session replacement or reload"); } });

test("on master: startup exports an unsynced machine change, commits and pushes it", async () => {
	const env = setup();
	fs.writeFileSync(env.agentFile, "v2\n");
	const { handlers } = await load(env);
	await handlers.session_start({ reason: "startup" }, { hasUI: false });
	assert.equal(subjects(env)[0].startsWith("chore(config): sync from"), true);
	assert.equal(fs.readFileSync(env.mirrorFile, "utf8"), "v2\n");
	assert.equal(git(env.bare, "log", "master", "--format=%s", "-1").startsWith("chore(config): sync from"), true);
	// A second run finds nothing to do and makes no commit.
	const before = subjects(env).length;
	await handlers.session_shutdown({}, { hasUI: false });
	assert.equal(subjects(env).length, before);
	assert.match(readLog(env), /already up to date/);
});

test("not on master: no commit, no import, the reason is logged once", async () => {
	const env = setup();
	git(env.repo, "checkout", "-q", "-b", "flow/merge-fixes");
	fs.writeFileSync(env.agentFile, "v2\n");
	const { handlers } = await load(env);
	await handlers.session_start({ reason: "startup" }, { hasUI: false });
	await handlers.session_shutdown({}, { hasUI: false });
	console.log(subjects(env), readLog(env));
	assert.equal(subjects(env).length, 1);
	assert.equal(fs.readFileSync(env.mirrorFile, "utf8"), "v1\n");
	assert.equal(fs.readFileSync(env.agentFile, "utf8"), "v2\n");
	const reasons = readLog(env).match(/no automatic sync: on branch flow\/merge-fixes/g) ?? [];
	assert.equal(reasons.length, 1);
});

test("a rebase in progress: no commit", async () => {
	const env = setup();
	fs.mkdirSync(path.join(env.repo, ".git", "rebase-merge"));
	fs.writeFileSync(env.agentFile, "v2\n");
	const { handlers } = await load(env);
	await handlers.session_start({ reason: "startup" }, { hasUI: false });
	await handlers.session_shutdown({}, { hasUI: false });
	assert.equal(subjects(env).length, 1);
	assert.match(readLog(env), /no automatic sync: a rebase is in progress/);
});

test("status shows the repo-state guard and the lock", async () => {
	const env = setup();
	git(env.repo, "checkout", "-q", "-b", "feature");
	const { commands } = await load(env);
	const shown: string[] = [];
	await commands["pi-config"].handler("status", { hasUI: true, ui: { notify: (m: string) => void shown.push(m) } });
	assert.match(shown[0], /repo state\s+NO AUTOMATIC SYNC: on branch feature, not master/);
	assert.match(shown[0], /lock\s+free/);
});

test("a stale ctx never stops the shutdown export", async () => {
	const env = setup();
	fs.writeFileSync(env.agentFile, "v2\n");
	const { handlers } = await load(env);
	await handlers.session_shutdown({}, staleCtx);
	assert.equal(subjects(env)[0].startsWith("chore(config): sync from"), true);
	assert.doesNotMatch(readLog(env), /session_shutdown failed/);
});

test("a busy lock skips the shutdown run after its wait", async () => {
	const env = setup();
	fs.writeFileSync(path.join(env.repo, "local", "sync.lock"), JSON.stringify({ pid: process.pid, token: "other window" }));
	fs.writeFileSync(env.agentFile, "v2\n");
	const { handlers } = await load(env);
	const t0 = Date.now();
	await handlers.session_shutdown({}, { hasUI: false });
	assert.ok(Date.now() - t0 >= 9000, "waits about 10 s");
	assert.match(readLog(env), /session_shutdown: skipped, lock busy/);
	assert.equal(subjects(env).length, 1);
});

/** Another PC pushes a sync commit that adds b.ts. */
function otherPcPushes(env: ReturnType<typeof setup>) {
	const other = path.join(env.root, "other");
	execFileSync("git", ["clone", "-q", env.bare, other]);
	git(other, "config", "user.email", "o@example.com");
	git(other, "config", "user.name", "o");
	fs.writeFileSync(path.join(other, "pi", "agent", "extensions", "demo", "b.ts"), "from other\n");
	git(other, "add", "-A");
	git(other, "commit", "-qm", "chore(config): sync from OTHER");
	git(other, "push", "-q", "origin", "master");
}

const remoteCount = (env: ReturnType<typeof setup>) => git(env.bare, "log", "master", "--format=%s").trim().split(/\r?\n/).length;

test("a rejected push is rebased onto origin/master, pushed again, then imported", async () => {
	const env = setup();
	otherPcPushes(env);
	fs.writeFileSync(env.agentFile, "v2\n");
	const { handlers } = await load(env);
	await handlers.session_start({ reason: "startup" }, { hasUI: false });
	assert.equal(remoteCount(env), 3);
	assert.equal(git(env.repo, "status", "--porcelain", "--untracked-files=no").trim(), "");
	assert.equal(fs.readFileSync(path.join(env.home, ".pi", "agent", "extensions", "demo", "b.ts"), "utf8"), "from other\n");
	await handlers.session_shutdown({}, { hasUI: false });
});

test("a rebase is skipped while a tracked file differs from HEAD, and status says what blocks it", async () => {
	const env = setup();
	otherPcPushes(env);
	// The user edits a tracked file by hand (outside the mirror): the sync commit cannot be rebased.
	fs.writeFileSync(path.join(env.repo, ".gitignore"), "local/\n# edited\n");
	fs.writeFileSync(env.agentFile, "v2\n");
	const { handlers, commands } = await load(env);
	await handlers.session_start({ reason: "startup" }, { hasUI: false });
	assert.match(readLog(env), /rebase skipped: tracked file\(s\) differ from HEAD: \.gitignore/);
	assert.equal(git(env.repo, "rev-list", "--count", "origin/master..HEAD").trim(), "1");
	assert.equal(fs.existsSync(path.join(env.home, ".pi", "agent", "extensions", "demo", "b.ts")), false);
	const shown: string[] = [];
	await commands["pi-config"].handler("status", { hasUI: true, ui: { notify: (m: string) => void shown.push(m) } });
	assert.match(shown[0], /sync paused\s+blocking files: \.gitignore; 1 unpushed sync commit/);
	assert.match(shown[0], /commit or discard your edits to resume sync/);
	await handlers.session_shutdown({}, { hasUI: false });
});
