import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { capOutput, runCode } from "./run-code.ts";

const cwd = os.tmpdir();
const tmpRuns = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("pi-run-"));

test("capOutput keeps first 6000, a note and last 2000", () => {
	const s = "a".repeat(6000) + "m".repeat(12000) + "z".repeat(2000);
	const out = capOutput(s);
	assert.equal(out, "a".repeat(6000) + "\n[output cut: 8000 of 20000 characters shown; print less]\n" + "z".repeat(2000));
	assert.equal(capOutput("short"), "short");
});

test("await works and output is returned", async () => {
	const r = await runCode({ code: "await Promise.resolve(); console.log(2)" }, { cwd });
	assert.equal(r.text.trim(), "2");
	assert.equal(r.exitCode, 0);
});

test("non-zero exit shows stderr and code", async () => {
	const r = await runCode({ code: 'console.error("e"); process.exit(3)' }, { cwd });
	assert.equal(r.exitCode, 3);
	assert.match(r.text, /\[stderr\]\ne/);
	assert.match(r.text, /\[exit code 3\]/);
});

test("rejected promise exits 1", async () => {
	const r = await runCode({ code: 'throw new Error("boom")' }, { cwd });
	assert.equal(r.exitCode, 1);
	assert.match(r.text, /boom/);
});

test("timeout kills the process tree and removes the temp file", async () => {
	const before = tmpRuns().length;
	const code = `const c = require("child_process").spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {stdio:"ignore"}); console.log("PID=" + c.pid); setInterval(()=>{},1000);`;
	const r = await runCode({ code, timeout: 1 }, { cwd });
	assert.equal(r.timedOut, true);
	assert.match(r.text, /timed out after 1 s/);
	const pid = Number(/PID=(\d+)/.exec(r.text)?.[1]);
	assert.ok(pid > 0);
	await new Promise((res) => setTimeout(res, 500));
	let alive = true;
	try {
		process.kill(pid, 0);
	} catch {
		alive = false;
	}
	assert.equal(alive, false);
	assert.equal(tmpRuns().length, before);
});

test("a runaway printer stays bounded and reports the full count", async () => {
	const r = await runCode({ code: "const l = 'x'.repeat(1000) + '\\n'; for (let i = 0; i < 20000; i++) process.stdout.write(l);" }, { cwd });
	assert.equal(r.exitCode, 0);
	assert.ok(r.text.length <= 8200, String(r.text.length));
	assert.match(r.text, /\[output cut: 8000 of 20020000 characters shown; print less\]/);
});

test("a long stderr after a long stdout keeps the result near the cap", async () => {
	const r = await runCode({ code: "console.log('a'.repeat(7000)); console.error('e'.repeat(20000));" }, { cwd });
	assert.ok(r.text.length <= 8100, String(r.text.length));
	assert.match(r.text, /\[output cut: 8000 of 27\d+ characters shown/);
});

test("a detached grandchild holding the pipes does not hang the call", async () => {
	const code = `const c = require("child_process").spawn(process.execPath, ["-e","setInterval(()=>{},1e3)"], {stdio:"inherit", detached:true}); console.log("PID=" + c.pid); c.unref();`;
	const t0 = Date.now();
	const r = await runCode({ code, timeout: 1 }, { cwd });
	const pid = Number(/PID=(\d+)/.exec(r.text)?.[1]);
	try {
		assert.ok(Date.now() - t0 < 6000, String(Date.now() - t0));
	} finally {
		try {
			process.kill(pid);
		} catch {
			// gone
		}
	}
});

test("a missing cwd is reported as such", async () => {
	const r = await runCode({ code: "1", cwd: "no-such-folder-xyz" }, { cwd });
	assert.match(r.text, /^cwd not found:/);
	assert.equal(r.exitCode, -1);
});

test("require resolves relative paths from cwd", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-req-"));
	try {
		fs.writeFileSync(path.join(dir, "x.js"), "module.exports = 42;");
		const r = await runCode({ code: "console.log(require('./x.js'))", cwd: dir }, { cwd });
		assert.equal(r.exitCode, 0);
		assert.equal(r.text.trim(), "42");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
