// node --experimental-strip-types --test layout.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaults } from "./config.ts";
import { addDirValue, branchOf, checkName, launchSpec, rootProblem, targetOf, vscodeTerminalSpec } from "./layout.ts";

const cfg = { ...defaults("D:/projects") };

test("checkName", () => {
	assert.equal(checkName("ads-fix"), null);
	for (const bad of ["Ads", "-x", "a b", "a;b", "a".repeat(41), ""]) assert.ok(checkName(bad), bad);
});

test("paths", () => {
	assert.equal(targetOf(cfg, "x", "D:/projects/game-template"), "D:/projects/wt/x/game-template");
	assert.equal(branchOf(cfg, "x"), "wt/x");
});

test("rootProblem", () => {
	assert.equal(rootProblem("D:/projects/wt"), null);
	assert.ok(rootProblem("wt"));
	assert.ok(rootProblem("D:/my projects/wt"));
});

test("addDirValue", () => {
	assert.equal(addDirValue(["A", "B"], "win32"), "A;B");
	assert.equal(addDirValue(["A", "B"], "linux"), "A:B");
});

const base = { platform: "win32" as const, launch: "window" as const, wtPath: "C:/wt.exe", piCommand: "pi.cmd", cwd: "D:/c", name: "x", folders: ["A", "B"] };

test("launchSpec window", () => {
	assert.deepEqual(launchSpec(base), {
		file: "C:/wt.exe",
		args: ["-w", "new", "new-tab", "-d", "D:/c", "--title", "pi x", "pi.cmd", "--add-dir", "A\\;B"],
	});
});

test("launchSpec tab", () => {
	const s = launchSpec({ ...base, launch: "tab" }) as { args: string[] };
	assert.deepEqual(s.args.slice(0, 2), ["-w", "0"]);
});

test("launchSpec no folders", () => {
	const s = launchSpec({ ...base, folders: [] }) as { args: string[] };
	assert.ok(!s.args.includes("--add-dir"));
});

test("launchSpec cmd fallback", () => {
	assert.deepEqual(launchSpec({ ...base, wtPath: null }), {
		file: "cmd.exe",
		args: ["/c", "start", "pi x", "/D", "D:" + String.fromCharCode(92) + "c", "pi.cmd", "--add-dir", "A;B"],
	});
});

test("launchSpec linux and none print", () => {
	const l = launchSpec({ ...base, platform: "linux", piCommand: "" }) as { print: string };
	assert.match(l.print, /--add-dir 'A:B'/);
	assert.ok("print" in launchSpec({ ...base, launch: "none" }));
});

test("vscodeTerminalSpec win32", () => {
	assert.deepEqual(vscodeTerminalSpec(base), { name: "pi x", cwd: "D:/c", shellPath: "cmd.exe", shellArgs: ["/d", "/c", "pi.cmd", "--add-dir", "A;B"] });
});

test("vscodeTerminalSpec win32 backslashes piCommand", () => {
	assert.equal(vscodeTerminalSpec({ ...base, piCommand: "C:/u/pi.cmd" }).shellArgs[2], "C:\\u\\pi.cmd");
});

test("vscodeTerminalSpec no folders", () => {
	assert.deepEqual(vscodeTerminalSpec({ ...base, folders: [] }).shellArgs, ["/d", "/c", "pi.cmd"]);
});

test("vscodeTerminalSpec linux", () => {
	const s = vscodeTerminalSpec({ ...base, platform: "linux", piCommand: "" });
	assert.equal(s.shellPath, "pi");
	assert.deepEqual(s.shellArgs, ["--add-dir", "A:B"]);
});

test("launchSpec piArgs window", () => {
	const s = launchSpec({ ...base, piArgs: ["--continue"] }) as { args: string[] };
	assert.deepEqual(s.args.slice(-3), ["--continue", "--add-dir", "A\\;B"]);
});

test("launchSpec piArgs cmd fallback", () => {
	const s = launchSpec({ ...base, wtPath: null, piArgs: ["--continue"] }) as { args: string[] };
	assert.deepEqual(s.args.slice(-4), ["pi.cmd", "--continue", "--add-dir", "A;B"]);
});

test("launchSpec piArgs print", () => {
	const s = launchSpec({ ...base, platform: "linux", piCommand: "", piArgs: ["--continue"] }) as { print: string };
	assert.equal(s.print, "cd D:/c && pi --continue --add-dir 'A:B'");
});

test("vscodeTerminalSpec piArgs", () => {
	assert.deepEqual(vscodeTerminalSpec({ ...base, piArgs: ["--continue"] }).shellArgs, ["/d", "/c", "pi.cmd", "--continue", "--add-dir", "A\;B"]);
	assert.deepEqual(vscodeTerminalSpec({ ...base, platform: "linux", piCommand: "", piArgs: ["--continue"] }).shellArgs, ["--continue", "--add-dir", "A:B"]);
});

test("sessionFile becomes --session before the other pi arguments", () => {
	const o = { platform: "win32" as const, launch: "window" as const, wtPath: "C:/wt.exe", piCommand: "pi", cwd: "D:/p/game", name: "w1", folders: ["D:/wt/w1/docs"], sessionFile: "C:/s/a.jsonl" };
	const spec = launchSpec(o);
	assert.ok("args" in spec);
	if ("args" in spec) {
		const i = spec.args.indexOf("--session");
		assert.equal(spec.args[i + 1], "C:/s/a.jsonl");
		assert.ok(i < spec.args.indexOf("--add-dir"));
		assert.ok(!spec.args.includes("--continue"));
	}
	assert.deepEqual(vscodeTerminalSpec(o).shellArgs.slice(3, 5), ["--session", "C:/s/a.jsonl"]);
	assert.match((launchSpec({ ...o, platform: "linux" }) as { print: string }).print, /pi --session C:\/s\/a\.jsonl --add-dir/);
});
