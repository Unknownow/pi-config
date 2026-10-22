// node --experimental-strip-types --test unity-guard.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { codeProblem, guardProblem, unityProblem } from "./unity-guard.ts";

const o = { cwd: "D:/projects/wt/x/game-template", setRoot: "D:/projects/wt/x", platform: "win32" as NodeJS.Platform };
const refused = (t: string, platform = o.platform) => assert.match(unityProblem(t, { ...o, platform }) ?? "", /^Refused \(worktree\): /, t);
const passes = (t: string) => assert.equal(unityProblem(t, o), null, t);

test("unity guard", () => {
	passes("unity status");
	refused("unity cmd console_status");
	refused("unity cmd x --project-path D:/projects/game-template/unity");
	passes("unity --project-path=D:/projects/wt/x/game-template/unity recompile");
	passes("unity cmd x --project-path unity");
	refused("env A=1 unity recompile");
	refused('bash -c "unity test --project-path D:/projects/game-template/unity"');
	refused("UNITY_PROJECT_PATH=D:/x unity status");
	passes("unity install 6000.3.25f1");
	passes("unity recompile --project-path D:/PROJECTS/WT/X/game-template/unity");
	refused("unity recompile --project-path D:/PROJECTS/GAME-TEMPLATE/unity");
	refused("unity recompile --project-path D:/projects/wt/xy/a");
	refused("cd a && unity list");
	passes("unity --format json status");
});

test("codeProblem", () => {
	assert.match(codeProblem("spawn('unity',['recompile'])") ?? "", /^Refused \(worktree\)/);
	assert.equal(codeProblem("const community = 1"), null);
});

test("unity guard: several paths and Windows shells", () => {
	refused("unity cmd x --project-path D:/projects/wt/x/a --project-path D:/projects/game-template/unity");
	refused("unity cmd x --project-path=");
	refused("cmd /c unity cmd x");
	refused('pwsh -Command "unity recompile"');
	passes("cmd /c unity recompile --project-path D:/projects/wt/x/a");
});

test("guardProblem dispatches by tool", () => {
	const g = (tool: string, input: Record<string, unknown>) => guardProblem(tool, input, { cwd: o.cwd, setRoot: o.setRoot });
	assert.match(g("bash", { command: "unity cmd x" }) ?? "", /Refused/);
	assert.match(g("run_code", { code: "run('unity recompile')" }) ?? "", /Refused/);
	assert.match(g("mcp__x__run_code", { code: "run('unity cmd x')" }) ?? "", /Refused/);
	assert.equal(g("run_code", { code: "console.log(1)" }), null);
	assert.equal(g("read", { path: "x" }), null);
});

test("unity guard: launcher spelling, shell options, global options", () => {
	refused("Unity cmd x", "win32");
	refused("unity.cmd recompile", "win32");
	refused('bash -x -c "unity cmd x"');
	refused("unity --log-level debug cmd x");
});

test("unity guard: Windows backslashes and unresolved paths", () => {
	const B = String.fromCharCode(92);
	const main = `D:${B}projects${B}game-template${B}unity`;
	assert.match(guardProblem("bash", { command: `unity cmd x --project-path ${main}` }, { cwd: o.cwd, setRoot: o.setRoot, platform: "win32" }) ?? "", /Refused/);
	refused(`cmd /c unity cmd x --project-path ${main}`);
	passes(`unity cmd x --project-path D:${B}projects${B}wt${B}x${B}game-template${B}unity`);
	refused("export P=D:/projects/game-template/unity; unity cmd x --project-path $P");
	refused("unity cmd x --project-path ~/x");
});

test("unity guard: quotes in paths and line continuations", () => {
	const B = String.fromCharCode(92);
	refused(`unity cmd x --project-path ..${B}"..${B}"${B}..${B}game-template${B}unity`);
	passes(`unity cmd x ${B}${String.fromCharCode(10)}  --project-path D:/projects/wt/x/game-template/unity`);
});
