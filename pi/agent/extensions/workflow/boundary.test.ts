// node --experimental-strip-types --test boundary.test.ts
// The workflow extension never refers to other extensions; they depend on its public contract (README.md), not the other way round.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const dir = new URL(".", import.meta.url);

/** The workflow's .ts files (this folder and flow/), relative to this folder with `/` separators. */
function workflowFiles(withTests: boolean): string[] {
	const keep = (f: string) => f.endsWith(".ts") && (withTests || !f.endsWith(".test.ts"));
	const own = fs.readdirSync(dir).filter(keep);
	const flow = fs.readdirSync(new URL("flow/", dir)).filter(keep).map((f) => `flow/${f}`);
	return [...own, ...flow];
}

/** Every static and dynamic import spec of `text`, relative ones resolved against `file` to a path under the extensions folder (`agents/api.ts`). */
function importTargets(file: string, text: string): { spec: string; target: string }[] {
	const specs = [...text.matchAll(/from\s+["']([^"']+)["']/g), ...text.matchAll(/import\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
	return specs.map((spec) => ({ spec, target: spec.startsWith(".") ? path.posix.normalize(path.posix.join("workflow", path.posix.dirname(file), spec)) : spec }));
}

/** Why an import of `file` crosses the boundary, or undefined: agents only via agents/api.ts, never relay or workspace. */
function importProblem(file: string, text: string): string | undefined {
	for (const { spec, target } of importTargets(file, text)) {
		if (target.startsWith("agents/") && target !== "agents/api.ts") return `${file} imports ${spec}`;
		if (target.startsWith("relay/") || /(^|\/)relay\//.test(spec)) return `${file} imports ${spec}`;
		if (target.startsWith("workspace/")) return `${file} imports ${spec}`;
	}
	return undefined;
}

test("workflow never refers to the workspace extension", () => {
	const files = workflowFiles(false);
	assert.ok(files.length > 10 && files.includes("flow/context.ts"));
	const banned = [".pi-set.json", "agent/live", "wt-backup", "worktree.json", "workspace.json", '"wt/'];
	for (const f of files) {
		const text = fs.readFileSync(new URL(f, dir), "utf8");
		assert.ok(!importTargets(f, text).some((t) => t.target.startsWith("workspace/")), `${f} imports from ../workspace`);
		for (const b of banned) assert.ok(!text.includes(b), `${f} mentions ${b}`);
	}
});

test("workflow imports agents only through agents/api.ts and never imports relay", () => {
	// This file is skipped: its fixtures below import across the boundary on purpose.
	for (const f of workflowFiles(true).filter((f) => f !== "boundary.test.ts")) {
		const problem = importProblem(f, fs.readFileSync(new URL(f, dir), "utf8"));
		assert.equal(problem, undefined, problem);
	}
});

test("the import check resolves paths from flow/ files", () => {
	assert.equal(importProblem("flow/x.ts", 'import { runSubagent } from "../../agents/subagent.ts";'), 'flow/x.ts imports ../../agents/subagent.ts');
	assert.equal(importProblem("flow/x.ts", 'const m = await import("../../relay/api.ts");'), 'flow/x.ts imports ../../relay/api.ts');
	assert.equal(importProblem("flow/x.ts", 'import { a } from "../../workspace/index.ts";'), 'flow/x.ts imports ../../workspace/index.ts');
	assert.equal(importProblem("flow/x.ts", 'import { runJudge } from "../../agents/api.ts";'), undefined);
	assert.equal(importProblem("x.ts", 'import { runSubagent } from "../agents/subagent.ts";'), 'x.ts imports ../agents/subagent.ts');
	assert.equal(importProblem("x.ts", 'import { runJudge } from "../agents/api.ts";'), undefined);
});
