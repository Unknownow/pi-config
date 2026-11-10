import assert from "node:assert/strict";
import { test } from "node:test";
import { quietDefinition, summarizeArgs } from "./quiet.ts";

const EMPTY = { tag: "empty" } as any;
const RUN = { tag: "running" } as any;
const parts = { empty: () => EMPTY, running: () => RUN };
const rc = () => "call";
const rr = () => "result";
const mk = (extra: object = {}) => ({ name: "t", renderCall: rc, renderResult: rr, ...extra }) as any;

test("normal mode delegates", () => {
	const d = quietDefinition(mk(), () => false, parts, "t") as any;
	assert.equal(d.renderShell, "default");
	assert.equal(d.renderCall, rc);
	assert.equal(d.renderResult, rr);
	assert.equal(d.name, "t");
	const n = quietDefinition({ name: "x", renderCall: rc } as any, () => false, parts, "x") as any;
	assert.equal(n.renderResult, undefined);
});

test("first shell read keeps the base shell", () => {
	const d = quietDefinition(mk(), () => true, parts, "t") as any;
	assert.equal(d.renderShell, "default");
	assert.equal(d.renderShell, "self");
});

test("quiet hides finished rows and shows running ones", () => {
	const d = quietDefinition(mk(), () => true, parts, "t") as any;
	void d.renderShell;
	assert.equal(d.renderCall({}, {}, { isPartial: true }), RUN);
	assert.equal(d.renderCall({}, {}, { isPartial: false }), EMPTY);
	assert.equal(d.renderResult(), EMPTY);
});

test("export path always delegates", () => {
	const d = quietDefinition(mk(), () => true, parts, "t") as any;
	assert.equal(d.renderCall, rc);
	assert.equal(d.renderResult, rr);
});

test("toggling back restores", () => {
	let q = true;
	const d = quietDefinition(mk(), () => q, parts, "t") as any;
	void d.renderShell;
	assert.equal(d.renderShell, "self");
	q = false;
	assert.equal(d.renderShell, "default");
	assert.equal(d.renderCall, rc);
	assert.equal(d.renderResult, rr);
});

test("self-shell tools stay self and are hidden in the TUI", () => {
	for (const q of [true, false]) {
		const d = quietDefinition(mk({ renderShell: "self" }), () => q, parts, "t") as any;
		assert.equal(d.renderShell, "self");
		assert.equal(d.renderShell, "self");
	}
	const on = quietDefinition(mk({ renderShell: "self" }), () => true, parts, "t") as any;
	void on.renderShell;
	assert.equal(on.renderCall({}, {}, { isPartial: true }), RUN);
	assert.equal(on.renderCall({}, {}, { isPartial: false }), EMPTY);
	assert.equal(on.renderResult(), EMPTY);
	const off = quietDefinition(mk({ renderShell: "self" }), () => false, parts, "t") as any;
	void off.renderShell;
	assert.equal(off.renderCall, rc);
	assert.equal(off.renderResult, rr);
	const exp = quietDefinition(mk({ renderShell: "self" }), () => true, parts, "t") as any;
	assert.equal(exp.renderCall, rc);
	assert.equal(exp.renderResult, rr);
});

test("summarizeArgs", () => {
	assert.equal(summarizeArgs({ command: "git  status\n -s" }), "git status -s");
	assert.equal(summarizeArgs({ queries: ["a", "b", "c"] }), "a (+2)");
	assert.equal(summarizeArgs({ tasks: [{ id: "x" }, { id: "y" }] }), "x, y");
	const long = summarizeArgs({ command: "a".repeat(300) });
	assert.equal(long.length, 200);
	assert.ok(long.endsWith("…"));
	assert.equal(summarizeArgs({}), "{}");
});
