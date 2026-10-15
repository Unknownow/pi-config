// node --experimental-strip-types --test files.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { copyPath, isLink, linkDir, setupFiles, unlinkLink } from "./files.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wtfiles-"));

test("linkDir then unlinkLink keeps target", () => {
	const d = tmp();
	fs.mkdirSync(path.join(d, "real"));
	fs.writeFileSync(path.join(d, "real", "f.txt"), "x");
	linkDir(path.join(d, "real"), path.join(d, "sub", "lnk"));
	assert.ok(isLink(path.join(d, "sub", "lnk")));
	assert.ok(fs.existsSync(path.join(d, "sub", "lnk", "f.txt")));
	unlinkLink(path.join(d, "sub", "lnk"));
	assert.ok(!fs.existsSync(path.join(d, "sub", "lnk")));
	assert.ok(fs.existsSync(path.join(d, "real", "f.txt")));
});

test("unlinkLink refuses a real folder", () => {
	const d = tmp();
	fs.mkdirSync(path.join(d, "real"));
	fs.writeFileSync(path.join(d, "real", "f.txt"), "x");
	assert.throws(() => unlinkLink(path.join(d, "real")));
	assert.ok(fs.existsSync(path.join(d, "real", "f.txt")));
});

test("setupFiles links, copies, skips missing sources and existing destinations", () => {
	const d = tmp();
	const repo = path.join(d, "repo");
	const wt = path.join(d, "wt");
	fs.mkdirSync(path.join(repo, ".pi", "git"), { recursive: true });
	fs.writeFileSync(path.join(repo, ".pi", "git", "a"), "1");
	fs.mkdirSync(path.join(repo, "cfg"), { recursive: true });
	fs.writeFileSync(path.join(repo, "cfg", "k.json"), "secret");
	fs.writeFileSync(path.join(repo, "file-link"), "x");
	fs.mkdirSync(path.join(wt, "cfg"), { recursive: true });
	fs.writeFileSync(path.join(wt, "cfg", "k.json"), "mine");
	const r = setupFiles(repo, wt, { link: [".pi/git", ".pi/npm", "file-link"], copy: ["cfg", "nothing"] });
	assert.deepEqual(r.linked, [".pi/git"]);
	assert.deepEqual(r.copied, []);
	assert.equal(r.warnings.length, 1);
	assert.ok(isLink(path.join(wt, ".pi", "git")));
	assert.equal(fs.readFileSync(path.join(wt, "cfg", "k.json"), "utf8"), "mine");
});

test("copy does not overwrite and copies new", () => {
	const d = tmp();
	fs.writeFileSync(path.join(d, "a.txt"), "new");
	fs.writeFileSync(path.join(d, "b.txt"), "old");
	copyPath(path.join(d, "a.txt"), path.join(d, "b.txt"));
	assert.equal(fs.readFileSync(path.join(d, "b.txt"), "utf8"), "old");
	copyPath(path.join(d, "a.txt"), path.join(d, "x", "c.txt"));
	assert.equal(fs.readFileSync(path.join(d, "x", "c.txt"), "utf8"), "new");
});
