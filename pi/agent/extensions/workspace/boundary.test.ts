// node --experimental-strip-types --test boundary.test.ts
// Workspace stands alone: it imports only its own files and ../shared, never another extension. It is the only writer of the
// public `session-folders` entry, and it reads the workflow's old state only to migrate a session's folder list.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensions = path.dirname(here);

function tsFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) return e.name === "node_modules" ? [] : tsFiles(p);
		return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [p] : [];
	});
}

const own = tsFiles(here);
const importsOf = (text: string) => [...text.matchAll(/(?:from|import)\s*\(?\s*["'](\.\.?\/[^"']*)["']/g)].map((m) => m[1]);

test("workspace imports nothing of another extension but ../shared", () => {
	assert.ok(own.length > 10 && own.some((f) => f.endsWith("added-folders.ts")));
	for (const f of own) {
		const bad = importsOf(fs.readFileSync(f, "utf8")).filter((i) => {
			const rel = path.relative(extensions, path.resolve(path.dirname(f), i)).replace(/\\/g, "/");
			return !rel.startsWith("workspace/") && !rel.startsWith("shared/");
		});
		assert.deepEqual(bad, [], `${path.relative(here, f)} imports ${bad.join(", ")}`);
	}
});

test("the workflow's state is read in folders.ts only, for the one-time migration, and never written", () => {
	for (const f of own) {
		const text = fs.readFileSync(f, "utf8");
		if (path.basename(f) !== "folders.ts") assert.ok(!text.includes("workflow-state"), `${path.relative(here, f)} mentions workflow-state`);
		assert.ok(!/appendEntry\([^)]*workflow-state/.test(text), `${path.relative(here, f)} writes workflow-state`);
	}
});

/** The files of `files` that call `appendEntry` with the `session-folders` entry (by name or through FOLDERS_ENTRY). */
export function foldersWriters(files: { name: string; text: string }[]): string[] {
	return files.filter((f) => /appendEntry\(\s*(FOLDERS_ENTRY|["']session-folders["'])/.test(f.text)).map((f) => f.name);
}

test("workspace is the only writer of the session-folders entry, among all extensions", () => {
	const all = tsFiles(extensions).map((f) => ({ name: path.relative(extensions, f).replace(/\\/g, "/"), text: fs.readFileSync(f, "utf8") }));
	assert.ok(all.some((f) => f.name.startsWith("workflow/")) && all.some((f) => f.name.startsWith("agents/")), "every extension is scanned");
	assert.deepEqual(foldersWriters(all), ["workspace/added-folders.ts"]);
});

test("foldersWriters finds both spellings", () => {
	assert.deepEqual(foldersWriters([{ name: "a", text: 'pi.appendEntry("session-folders", d)' }, { name: "b", text: "fl.pi.appendEntry(FOLDERS_ENTRY, data)" }, { name: "c", text: 'pi.appendEntry("other", d)' }]), ["a", "b"]);
});
