// node --test gh-path.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { ghCandidates, withPathDir } from "./gh-path.ts";

test("ghCandidates on Windows", () => {
	assert.deepEqual(ghCandidates({ ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32"), [
		"C:\\Program Files\\GitHub CLI\\gh.exe",
		"C:\\Users\\u\\AppData\\Local\\Programs\\GitHub CLI\\gh.exe",
	]);
	assert.deepEqual(ghCandidates({ ProgramFiles: "C:\\Program Files", ProgramW6432: "C:\\Program Files" }, "win32"), ["C:\\Program Files\\GitHub CLI\\gh.exe"]);
	assert.deepEqual(ghCandidates({}, "win32"), ["C:\\Program Files\\GitHub CLI\\gh.exe"]);
	assert.deepEqual(ghCandidates({ ProgramFiles: "C:\\Program Files" }, "linux"), []);
});

test("withPathDir", () => {
	assert.deepEqual(withPathDir({ Path: "C:\\a;C:\\b" }, "C:\\gh", ";"), { key: "Path", value: "C:\\gh;C:\\a;C:\\b" });
	assert.deepEqual(withPathDir({ Path: "C:\\a;C:\\b" }, "c:\\A", ";"), { key: "Path", value: "C:\\a;C:\\b" });
	assert.deepEqual(withPathDir({}, "C:\\gh", ";"), { key: "PATH", value: "C:\\gh" });
});
