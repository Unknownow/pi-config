// node --test runner-guard.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRunnerSpec, runnerProblem, type RunnerGuardSpec } from "./runner-guard.ts";

// The defaults of config.ts, written out so this test needs no pi package.
const spec: RunnerGuardSpec = {
	roots: ["D:/projects/game"],
	deny: [
		"^adb( -[sdetHP] \\S+)* (reboot|reboot-bootloader|sideload|root|unroot|remount|disable-verity|enable-verity)\\b",
		"^adb\\b.*\\bshell\\b.*(\\brm\\s+-[a-z]*r|\\bwipe\\b|\\brecovery\\b|\\bfactory\\b|\\bformat\\b|\\breboot\\b)",
		"^fastboot\\b",
	],
	pathFlags: ["--project-path", "-projectPath"],
	pathEnv: ["UNITY_PROJECT_PATH"],
};
const problem = (cmd: string) => runnerProblem(cmd, spec, "D:/projects/game", "win32");

test("git that changes things is refused, reading is not", () => {
	assert.match(problem("git commit -m x") ?? "", /runners may not change git/);
	assert.match(problem("timeout 5 git push") ?? "", /runners may not change git/);
	assert.match(problem("bash -c 'git push'") ?? "", /runners may not change git/);
	assert.equal(problem("git log --oneline"), null);
	assert.equal(problem("git status"), null);
});

test("device commands: deny list", () => {
	assert.match(problem("adb -s R58 reboot") ?? "", /runnerDeny/);
	assert.match(problem("adb shell rm -rf /sdcard/x") ?? "", /runnerDeny/);
	assert.match(problem("fastboot flash boot x") ?? "", /runnerDeny/);
	assert.equal(problem("adb install -r app.apk"), null);
	assert.equal(problem("adb uninstall com.x"), null);
	assert.equal(problem("adb logcat -d"), null);
});

test("project paths must lie inside the roots", () => {
	assert.match(problem("unity run-tests --project-path D:/other/proj") ?? "", /outside/);
	assert.equal(problem("unity run-tests --project-path=D:/projects/game/unity"), null);
	assert.equal(problem("unity run-tests --project-path unity"), null);
	assert.equal(problem("unity run-tests -projectPath D:/projects/game"), null);
	assert.match(problem("unity run-tests --project-path ../other") ?? "", /outside/);
	assert.match(problem("unity run-tests --project-path $P") ?? "", /write it out/);
	assert.match(problem("unity run-tests --project-path") ?? "", /outside/);
});

test("path env names are refused", () => {
	assert.match(problem("UNITY_PROJECT_PATH=x unity build") ?? "", /--project-path/);
});

test("parseRunnerSpec", () => {
	assert.equal(parseRunnerSpec("{"), null);
	assert.equal(parseRunnerSpec(undefined), null);
	assert.equal(parseRunnerSpec('{"roots":["a"]}'), null);
	assert.deepEqual(parseRunnerSpec(JSON.stringify(spec)), spec);
});

test("path env names are refused after export and env too", () => {
	assert.match(problem("export UNITY_PROJECT_PATH=x; unity build") ?? "", /--project-path/);
	assert.match(problem("env UNITY_PROJECT_PATH=x unity build") ?? "", /--project-path/);
	assert.equal(problem("export FOO=x; unity build"), null);
});

test("read-only git with redirected output is fine, a push is not", () => {
	assert.equal(problem("git log --oneline > D:/projects/game/runs/1/a.log"), null);
	assert.match(problem("git push > x.log") ?? "", /git or GitHub/);
});

test("deny patterns apply per command, not across a chain", () => {
	assert.equal(problem("adb shell ls && echo format"), null);
});
