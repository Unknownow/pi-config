// node --test readonly-tools.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { planToolProblem } from "./readonly-tools.ts";

const allow: RegExp[] = [];
const check = (name: string, input: Record<string, unknown>, platform = "linux") =>
	planToolProblem(name, input, allow, platform);

test("bash goes through the shell check", () => {
	assert.equal(check("bash", { command: "ls -la" }), null);
	assert.match(check("bash", { command: "touch x" }) ?? "", /not on the read-only list/);
});

test("shell code in ctx tools goes through the shell check, with or without an MCP prefix", () => {
	assert.equal(check("ctx_execute", { language: "shell", code: "git status" }), null);
	assert.match(check("mcp__custom-tools__ctx_execute", { language: "shell", code: "rm -rf build" }) ?? "", /rm/);
	assert.equal(check("ctx_execute_file", { path: "a.md", language: "shell", code: "grep -c x FILE_CONTENT" }), null);
});

test("on Windows, shell code with escapes PowerShell reads differently is refused", () => {
	const code = 'echo "a\\" ; Remove-Item x ; echo "b\\""';
	const refused = (c: string) => check("ctx_execute", { language: "shell", code: c }, "win32") ?? "allowed";
	assert.match(refused(code), /characters/);
	assert.match(refused("echo `rm x`"), /characters/);
	assert.match(refused("echo a <# x #>"), /characters/);
	assert.match(refused("echo \\; Remove-Item -Recurse x"), /characters/);
	assert.match(refused('echo "\\$(Remove-Item x)"'), /characters/);
	assert.match(refused("echo a \\\nRemove-Item x"), /characters/);
	assert.equal(refused("git status"), "allowed");
	assert.match(refused("ls D:\\projects\\x"), /characters/);
});

test("PowerShell code is refused while planning", () => {
	assert.match(check("ctx_execute", { language: "powershell", code: "Get-ChildItem" }) ?? "", /PowerShell/);
	assert.match(check("ctx_execute", { language: "pwsh", code: "Get-ChildItem" }) ?? "", /PowerShell/);
});

test("batch commands are each checked", () => {
	assert.equal(check("ctx_batch_execute", { commands: [{ label: "a", command: "ls" }, { label: "b", command: "git log -1" }] }), null);
	assert.match(
		check("ctx_batch_execute", { commands: [{ label: "a", command: "ls" }, { label: "b", command: "echo x > out.txt" }] }) ?? "",
		/writes to out.txt/,
	);
	assert.match(
		check("ctx_batch_execute", { commands: [{ label: "a", command: 'echo "a\\" x' }] }, "win32") ?? "allowed",
		/characters/,
	);
});

test("purge and upgrade are refused", () => {
	assert.match(check("ctx_purge", { confirm: true, scope: "project" }) ?? "", /knowledge base/);
	assert.match(check("mcp__custom-tools__ctx_upgrade", {}) ?? "", /installed tool/);
});

test("javascript reads pass, writes and programs are refused", () => {
	assert.equal(check("ctx_execute", { language: "javascript", code: "console.log(FILE_CONTENT.split('\\n').length)" }), null);
	assert.equal(check("ctx_execute", { language: "javascript", code: "process.stdout.write('x')" }), null);
	assert.match(check("ctx_execute", { language: "javascript", code: "require('fs').writeFileSync('x', 'y')" }) ?? "", /writes/);
	assert.match(check("ctx_execute", { language: "javascript", code: "fs.rmSync('build', { recursive: true })" }) ?? "", /writes/);
	assert.match(check("ctx_execute", { language: "javascript", code: "fs.writeSync(1, 'x')" }) ?? "", /writes or opens/);
	assert.match(check("ctx_execute", { language: "javascript", code: "fs.openSync(p, 'w')" }) ?? "", /writes or opens/);
	assert.match(check("ctx_execute", { language: "javascript", code: "Bun.write('x', 'y')" }) ?? "", /writes files/);
	assert.match(check("ctx_execute_file", { path: "a", language: "typescript", code: "require('child_process').execSync('ls')" }) ?? "", /other programs/);
	assert.match(check("ctx_execute", { language: "javascript", code: "eval(s)" }) ?? "", /runtime/);
	assert.match(check("ctx_execute", { language: "js", code: "fetch(u, { method: 'POST' })" }) ?? "", /changes data/);
});

test("python reads pass, writes and programs are refused", () => {
	assert.equal(check("ctx_execute", { language: "python", code: "print(open('a.txt').read()[:10])" }), null);
	assert.equal(check("ctx_execute", { language: "python", code: "with open('a.txt', 'rb') as f: f.read()" }), null);
	assert.match(check("ctx_execute", { language: "python", code: "open('out.txt', 'w').write('x')" }) ?? "", /writing/);
	assert.match(check("ctx_execute", { language: "python", code: "open('out.txt', mode='a')" }) ?? "", /writing/);
	assert.match(check("ctx_execute", { language: "python", code: "open(os.path.join(d, 'x'), 'w')" }) ?? "", /writing/);
	assert.match(check("ctx_execute", { language: "python", code: "open(Path(d) / 'x', 'w')" }) ?? "", /writing/);
	assert.match(check("ctx_execute", { language: "python", code: "Path('x').open('w')" }) ?? "", /writing/);
	assert.match(check("ctx_execute", { language: "python", code: "os.write(fd, b'x')" }) ?? "", /os/);
	assert.match(check("ctx_execute", { language: "python", code: "import os\nos.remove('x')" }) ?? "", /os/);
	assert.match(check("ctx_execute", { language: "python", code: "import subprocess" }) ?? "", /programs/);
	assert.match(check("ctx_execute", { language: "python", code: "from pathlib import Path\nPath('x').write_text('y')" }) ?? "", /writes/);
	assert.equal(check("ctx_execute", { language: "python", code: "s = 'a'.replace('a', 'b')" }), null);
});

test("other languages are refused while planning", () => {
	assert.match(check("ctx_execute", { language: "ruby", code: "puts 1" }) ?? "", /not checked/);
	assert.match(check("ctx_execute", { language: "go", code: "package main" }) ?? "", /not checked/);
});

test("tools outside the list are not checked here", () => {
	assert.equal(check("ctx_search", { queries: ["x"] }), null);
	assert.equal(check("read", { path: "a" }), null);
});

test("on Windows, arithmetic substitution, Unicode quotes and any $ or brackets are refused", () => {
	const refused = (c: string) => check("ctx_execute", { language: "shell", code: c }, "win32") ?? "allowed";
	assert.match(refused("echo $((Remove-Item -Recurse src))"), /characters/);
	assert.match(refused("echo 'a\u2019 ; Remove-Item x ; \u2018b'"), /characters/);
	assert.match(refused('echo "a\u201d ; Remove-Item x ; \u201cb"'), /characters/);
	assert.match(refused("echo (Remove-Item x)"), /characters/);
	assert.match(refused("echo [x]"), /characters/);
	assert.equal(refused("ls D:/projects/x | wc -l"), "allowed");
});

test("python: open with nested path arguments and mode= is caught, reads are not", () => {
	assert.match(check("ctx_execute", { language: "python", code: "open(os.path.join(d, 'x'), 'w')" }) ?? "", /writing/);
	assert.match(check("ctx_execute", { language: "python", code: "open(Path(d) / 'x', mode='wb')" }) ?? "", /writing/);
	assert.match(check("ctx_execute", { language: "python", code: "Path('x').open('w')" }) ?? "", /writing/);
	assert.equal(check("ctx_execute", { language: "python", code: "open('a.txt').read().count('a')" }), null);
	assert.equal(check("ctx_execute", { language: "python", code: "s = ''.join(open('a.txt').read().split('x'))" }), null);
});

test("python: names imported from os, shutil or subprocess are refused", () => {
	assert.match(check("ctx_execute", { language: "python", code: "from os import system, remove" }) ?? "", /by name/);
	assert.equal(check("ctx_execute", { language: "python", code: "import os\nprint(os.getcwd())" }), null);
});

test("on Windows, a bare carriage return and PowerShell web aliases are refused", () => {
	const refused = (c: string) => check("ctx_execute", { language: "shell", code: c }, "win32") ?? "allowed";
	assert.match(refused("ls\rRemove-Item -Recurse -Force src"), /carriage/);
	assert.equal(refused("ls\r\nwc -l"), "allowed");
	assert.match(refused("curl -Method Delete http://x"), /alias/);
	assert.match(refused("iwr http://x -OutFile y"), /alias/);
	assert.equal(refused("curl.exe -sL https://x"), "allowed");
});

test("python: parentheses inside quoted strings do not end the open( match", () => {
	assert.match(check("ctx_execute", { language: "python", code: "open('a)b.txt', 'w')" }) ?? "", /writing/);
	assert.match(check("ctx_execute", { language: "python", code: 'open(f"{x})", "w")' }) ?? "", /writing/);
});

test("quoted PowerShell aliases are refused on Windows; a stray CR is refused everywhere", () => {
	const refused = (c: string, p = "win32") => check("ctx_execute", { language: "shell", code: c }, p) ?? "allowed";
	assert.match(refused("& 'curl' -Method Delete -Uri http://x"), /alias/);
	assert.match(refused("c'url' -Method Delete -Uri http://x"), /alias/);
	assert.match(refused("git config a.b \r\n", "linux"), /carriage/);
	assert.match(refused("git config a.b \r\n", "linux"), /carriage/);
});
