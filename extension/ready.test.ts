// node --test extension/ready.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { committableMirror } from "./ready.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function repoWith(files: Record<string, string>, record: Record<string, string>): string {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-ready-"));
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(repo, "pi", "agent", rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content);
	}
	fs.mkdirSync(path.join(repo, "local"), { recursive: true });
	fs.writeFileSync(path.join(repo, "local", "sync-state.json"), JSON.stringify(record));
	return repo;
}

test("a file that matches its sync record is ready to commit", () => {
	const repo = repoWith({ "extensions/a.ts": "one\n" }, { "extensions/a.ts": sha("one\n") });
	assert.deepEqual(committableMirror(repo, ["pi/agent/extensions/a.ts"]), {
		ready: ["pi/agent/extensions/a.ts"],
		kept: [],
	});
});

test("a file edited after its record is kept, not committed", () => {
	const repo = repoWith({ "extensions/a.ts": "hand edit\n" }, { "extensions/a.ts": sha("one\n") });
	assert.deepEqual(committableMirror(repo, ["pi/agent/extensions/a.ts"]), {
		ready: [],
		kept: ["pi/agent/extensions/a.ts"],
	});
});

test("a file with no record is kept", () => {
	const repo = repoWith({ "skills/new.md": "x\n" }, {});
	assert.deepEqual(committableMirror(repo, ["pi/agent/skills/new.md"]).kept, ["pi/agent/skills/new.md"]);
});

test("a deleted file is kept, never committed as a deletion", () => {
	const repo = repoWith({}, { "extensions/gone.ts": sha("x") });
	assert.deepEqual(committableMirror(repo, ["pi/agent/extensions/gone.ts"]).kept, ["pi/agent/extensions/gone.ts"]);
});

test("ready and kept split a mixed list", () => {
	const repo = repoWith(
		{ "extensions/a.ts": "a\n", "extensions/b.ts": "hand\n" },
		{ "extensions/a.ts": sha("a\n"), "extensions/b.ts": sha("b\n") },
	);
	assert.deepEqual(committableMirror(repo, ["pi/agent/extensions/a.ts", "pi/agent/extensions/b.ts"]), {
		ready: ["pi/agent/extensions/a.ts"],
		kept: ["pi/agent/extensions/b.ts"],
	});
});

test("a missing file is committable only when its record is marked deleted", () => {
	const repo = repoWith({}, { "extensions/gone.ts": { deleted: true } as never, "extensions/lost.ts": sha("x") });
	assert.deepEqual(committableMirror(repo, ["pi/agent/extensions/gone.ts", "pi/agent/extensions/lost.ts", "pi/agent/extensions/none.ts"]), {
		ready: ["pi/agent/extensions/gone.ts"],
		kept: ["pi/agent/extensions/lost.ts", "pi/agent/extensions/none.ts"],
	});
});

test("a pending machine export (differs from HEAD, matches its record) is ready; bin/import.js leaves it alone", () => {
	const repo = repoWith({ "extensions/a.ts": "v1\n" }, {});
	const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
	git("init", "-q");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	git("config", "core.autocrlf", "false");
	git("add", "pi");
	git("commit", "-qm", "base");
	// Export wrote v2 and recorded it; the commit has not happened.
	fs.writeFileSync(path.join(repo, "pi", "agent", "extensions", "a.ts"), "v2\n");
	fs.writeFileSync(path.join(repo, "local", "sync-state.json"), JSON.stringify({ "extensions/a.ts": sha("v2\n") }));
	assert.deepEqual(committableMirror(repo, ["pi/agent/extensions/a.ts"]), { ready: ["pi/agent/extensions/a.ts"], kept: [] });

	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-ready-home-"));
	const agentFile = path.join(home, ".pi", "agent", "extensions", "a.ts");
	fs.mkdirSync(path.dirname(agentFile), { recursive: true });
	fs.writeFileSync(agentFile, "v2\n");
	fs.mkdirSync(path.join(repo, "bin"), { recursive: true });
	for (const f of ["lib.js", "import.js"]) fs.copyFileSync(path.join(import.meta.dirname, "..", "bin", f), path.join(repo, "bin", f));
	execFileSync(process.execPath, [path.join(repo, "bin", "import.js")], { cwd: repo, env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: "pipe" });
	assert.equal(fs.readFileSync(agentFile, "utf8"), "v2\n");
});
