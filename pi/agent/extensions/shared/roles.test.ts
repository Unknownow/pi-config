// node --experimental-strip-types --test roles.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeRole, modelChoices, parseRoleSpec, pickRoleSpec, roleCompletions } from "./roles.ts";

test("parseRoleSpec reads provider/id with an optional thinking level", () => {
	assert.deepEqual(parseRoleSpec("claude-bridge/claude-opus-5-5:high"), { model: "claude-bridge/claude-opus-5-5", thinking: "high" });
	assert.deepEqual(parseRoleSpec(" a/b "), { model: "a/b" });
	assert.match(parseRoleSpec("opus") as string, /expected provider/);
	assert.match(parseRoleSpec("a/b:loud") as string, /thinking must be one of/);
	assert.equal(describeRole({ model: "a/b", thinking: "low" }), "a/b:low");
	assert.equal(describeRole({ model: "a/b" }), "a/b");
});

test("modelChoices sorts and labels", () => {
	const r = modelChoices([{ provider: "b", id: "m1", name: "m1" }, { provider: "a", id: "z", name: "Zed" }, { provider: "a", id: "c" }], "a/z");
	assert.deepEqual(r.map((c) => c.value), ["a/c", "a/z", "b/m1"]);
	assert.deepEqual(r.map((c) => c.label), ["a/c", "a/z — Zed (current)", "b/m1"]);
});

test("roleCompletions offers the roles, then the models of a known role", () => {
	const specOf = (r: string) => ({ model: r === "explore" ? "a/c" : "b/m1" });
	const models = () => [{ provider: "a", id: "c" }, { provider: "b", id: "m1" }];
	assert.deepEqual(roleCompletions("model", ["model", "ex"], ["explore", "advisor"], specOf, models), [{ value: "model explore ", label: "explore (a/c)" }]);
	assert.deepEqual(roleCompletions("model", ["model", "explore", "b"], ["explore"], specOf, models), [{ value: "model explore b/m1", label: "b/m1" }]);
	assert.equal(roleCompletions("model", ["model", "judge", ""], ["explore"], specOf, models), null);
	assert.equal(roleCompletions("model", ["model", "explore", ""], ["explore"], specOf, () => { throw new Error("no registry"); }), null);
});

test("pickRoleSpec keeps or changes the thinking level, and reads a typed ID", async () => {
	const ui = (answers: (string | undefined)[]) => ({ select: async () => answers.shift(), input: async () => answers.shift() });
	const models = () => [{ provider: "a", id: "c" }];
	assert.deepEqual(await pickRoleSpec(ui(["a/c (current)", "keep (medium)"]), "explore", { model: "a/c", thinking: "medium" }, models), { model: "a/c", thinking: "medium" });
	assert.deepEqual(await pickRoleSpec(ui(["a/c", "low"]), "explore", { model: "x/y" }, models), { model: "a/c", thinking: "low" });
	assert.deepEqual(await pickRoleSpec(ui(["Type a model ID…", "p/q:max"]), "explore", undefined, models), { model: "p/q", thinking: "max" });
	assert.equal(await pickRoleSpec(ui([undefined]), "explore", undefined, models), undefined);
	assert.deepEqual(await pickRoleSpec(ui(["p/q"]), "explore", undefined, () => []), { model: "p/q" });
});
