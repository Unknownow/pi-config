// node --experimental-strip-types --test config.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { loadConfig } from "./config.ts";
import { rootProblem } from "./layout.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wtcfg-"));

test("defaults without file", () => {
	const { cfg, warning } = loadConfig(tmp(), "D:/projects");
	assert.equal(cfg.root, "D:/projects/wt");
	assert.equal(cfg.launch, "window");
	assert.equal(warning, undefined);
});

test("bad json warns and uses defaults", () => {
	const dir = tmp();
	fs.writeFileSync(path.join(dir, "worktree.json"), "{nope");
	const { cfg, warning } = loadConfig(dir, "D:/projects");
	assert.equal(cfg.root, "D:/projects/wt");
	assert.match(warning ?? "", /bad JSON/);
});

test("unknown launch falls back to window", () => {
	const dir = tmp();
	fs.writeFileSync(path.join(dir, "worktree.json"), JSON.stringify({ launch: "popup", branchPrefix: "x/" }));
	const { cfg, warning } = loadConfig(dir, "D:/projects");
	assert.equal(cfg.launch, "window");
	assert.equal(cfg.branchPrefix, "x/");
	assert.match(warning ?? "", /launch/);
});

test("relative root is kept and flagged", () => {
	const dir = tmp();
	fs.writeFileSync(path.join(dir, "worktree.json"), JSON.stringify({ root: "wt" }));
	const { cfg } = loadConfig(dir, "D:/projects");
	assert.equal(cfg.root, "wt");
	assert.ok(rootProblem(cfg.root));
});
