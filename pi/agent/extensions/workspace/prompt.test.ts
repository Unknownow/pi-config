// node --experimental-strip-types --test prompt.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceSection } from "./prompt.ts";

test("workspaceSection with no folders still gives the working folder and the hints", () => {
	const text = workspaceSection("/w", []);
	assert.ok(text.startsWith("Working folder: /w"));
	assert.ok(!text.includes("Added folders"));
	assert.ok(text.includes("`git -C <folder>`"));
	assert.ok(text.includes("The judge reviews every git repo listed here"));
});

test("workspaceSection lists the added folders", () => {
	const lines = workspaceSection("/w", ["/a", "/b"]).split("\n");
	assert.deepEqual(lines.slice(0, 4), ["Working folder: /w", "Added folders (also part of this task):", "- /a", "- /b"]);
});

test("workspaceSection lists rules files sorted by path, after the rule line", () => {
	const rule = "Rules files of the added folders (not loaded): read a folder's files before you plan or change anything in it.";
	const lines = workspaceSection("/w", ["/a"], [{ path: "/b/AGENTS.md", size: 20 }, { path: "/a/AGENTS.md", size: 5 }]).split("\n");
	const i = lines.indexOf(rule);
	assert.ok(i > 0);
	assert.equal(lines[i + 1], "- /a/AGENTS.md (5 characters)");
	assert.equal(lines[i + 2], "- /b/AGENTS.md (20 characters)");
	assert.ok(!workspaceSection("/w", ["/a"]).includes("Rules files"));
});

test("workspaceSection never names the workflow's edited repos", () => {
	assert.ok(!workspaceSection("/w", ["/a"]).includes("edited in this flow"));
});
