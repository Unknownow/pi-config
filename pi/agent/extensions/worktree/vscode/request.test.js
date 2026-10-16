// node --test vscode/request.test.js
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseRequest } = require("./request.js");

const good = { name: "pi x", cwd: "D:/c", shellPath: "cmd.exe", shellArgs: ["/d", "/c", "pi.cmd"] };

test("valid request", () => {
	const r = parseRequest(JSON.stringify(good));
	assert.equal(r.ok, true);
	assert.deepEqual(r.req, good);
});
test("invalid json", () => assert.equal(parseRequest("{nope").ok, false));
test("null", () => assert.equal(parseRequest("null").ok, false));
test("missing name", () => {
	const r = parseRequest(JSON.stringify({ ...good, name: undefined }));
	assert.equal(r.ok, false);
	assert.match(r.error, /name/);
});
test("relative cwd", () => {
	const r = parseRequest(JSON.stringify({ ...good, cwd: "rel/dir" }));
	assert.equal(r.ok, false);
	assert.match(r.error, /cwd/);
});
test("bad shellArgs", () => {
	const r = parseRequest(JSON.stringify({ ...good, shellArgs: [1] }));
	assert.equal(r.ok, false);
	assert.match(r.error, /shellArgs/);
});
