// node --experimental-strip-types --test shared-guard.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { sharedProblem } from "./shared-guard.ts";

const o = { cwd: "D:/wt/w1/game", setRoot: "D:/wt/w1", linked: ["D:/wt/w1/game/node_modules", "D:/wt/w1/game/.pi/git"] };
const bash = (command: string) => sharedProblem("bash", { command }, o);

test("package installs are refused while node_modules is linked", () => {
	for (const c of ["npm install", "npm i left-pad", "cd x && npm ci", "pnpm add y", "yarn", "yarn add z", "npm update"]) assert.match(bash(c) ?? "", /\/wt unlink node_modules/, c);
	for (const c of ["npm run build", "npm test", "yarnpkg --version", "echo npm"]) assert.equal(bash(c), null, c);
	assert.equal(sharedProblem("bash", { command: "npm install" }, { ...o, linked: ["D:/wt/w1/game/.pi/git"] }), null);
	assert.equal(sharedProblem("bash", { command: "npm install" }, { ...o, linked: [] }), null);
});

test("recursive deletes of a link are refused", () => {
	assert.match(bash("rm -rf node_modules") ?? "", /unlink node_modules/);
	assert.match(bash("rm -r ./node_modules/") ?? "", /unlink node_modules/);
	assert.match(bash("rm -rf D:/wt/w1/game/.pi/git") ?? "", /unlink \.pi\/git/);
	assert.match(bash("rimraf node_modules") ?? "", /unlink/);
	assert.match(bash("Remove-Item -Recurse -Force node_modules") ?? "", /unlink/);
	assert.match(bash("rmdir /s /q node_modules") ?? "", /unlink/);
	assert.match(bash("rm -f -r node_modules") ?? "", /unlink/);
	assert.match(bash("rm --force --recursive node_modules") ?? "", /unlink/);
	assert.match(bash("rm -rf .") ?? "", /holds node_modules/);
	assert.match(bash("Remove-Item -Recurse -Force D:/wt/w1/game") ?? "", /holds/);
	assert.match(bash("rm -rf ../game") ?? "", /holds/);
	assert.match(bash("rm -rf *") ?? "", /holds/);
	assert.match(bash("rm -rf .pi") ?? "", /holds \.pi\/git/);
	assert.equal(bash("cd .. && rm -rf dist"), null);
	assert.equal(bash("find . -name x; rm -rf dist"), null);
	assert.equal(bash("cd D:/wt/w1/game && rm -rf dist"), null);
	assert.equal(bash("Remove-Item -Recurse build; Get-ChildItem ."), null);
	assert.match(bash("cd src && rm -rf .") ?? "", /holds/);
	assert.match(bash("rmdir /s /q .") ?? "", /holds/);
	assert.equal(bash("git rm -r --cached ."), null);
	assert.equal(bash("rm -rf src"), null);
	assert.equal(bash("rm -rf *.log"), null);
	assert.equal(bash("rm -rf dist"), null);
	assert.equal(bash("rm node_modules/.cache"), null);
	assert.equal(bash("ls node_modules"), null);
});

test("other tools", () => {
	assert.equal(sharedProblem("run_code", { code: "npm install" }, o), null);
	assert.equal(sharedProblem("mcp__x__run_code", { code: "console.log(1)" }, o), null);
	assert.match(sharedProblem("write", { path: "node_modules/x/y.js" }, o) ?? "", /unlink node_modules/);
	assert.match(sharedProblem("edit", { path: "D:/wt/w1/game/.pi/git/config" }, o) ?? "", /unlink \.pi\/git/);
	assert.equal(sharedProblem("write", { path: "src/a.ts" }, o), null);
	assert.equal(sharedProblem("read", { path: "node_modules/x" }, o), null);
});
