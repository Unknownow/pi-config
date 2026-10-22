import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fetchUrl } from "./fetch-url.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-fetch-test-"));
const fake = (body: string | Uint8Array, type: string, counter = { n: 0 }) =>
	((async () => {
		counter.n++;
		return new Response(body, { status: 200, headers: { "content-type": type } });
	}) as unknown as typeof fetch);

test("rejects non-http schemes", async () => {
	await assert.rejects(fetchUrl({ url: "file:///x" }), /only http and https/);
	await assert.rejects(fetchUrl({ url: "ftp://x" }), /only http and https/);
	await assert.rejects(fetchUrl({ url: "nonsense" }), /only http and https/);
});

test("caches for an hour, force and expiry refetch", async () => {
	const dir = tmp();
	const c = { n: 0 };
	let t = 1_000_000;
	const deps = { fetch: fake("<title>T</title><h1>H</h1><p>body</p>", "text/html", c), now: () => t, dir };
	const first = await fetchUrl({ url: "https://e.com/a" }, deps);
	assert.equal(c.n, 1);
	assert.match(first, /^URL: https:\/\/e\.com\/a\n/);
	assert.match(first, /Title: T/);
	assert.match(first, /Headings:\n# H/);
	assert.match(first, /Saved: .*\.md/);
	const second = await fetchUrl({ url: "https://e.com/a" }, deps);
	assert.equal(c.n, 1);
	assert.match(second.split("\n")[0], /\(cached\)$/);
	await fetchUrl({ url: "https://e.com/a", force: true }, deps);
	assert.equal(c.n, 2);
	t += 2 * 3_600_000;
	await fetchUrl({ url: "https://e.com/a" }, deps);
	assert.equal(c.n, 3);
});

test("json is pretty-printed", async () => {
	const dir = tmp();
	const out = await fetchUrl({ url: "https://e.com/j" }, { fetch: fake('{"a":[1,2]}', "application/json"), dir });
	assert.match(out, /Saved: (.*\.json)/);
	const file = /Saved: (.*)/.exec(out)![1];
	assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify({ a: [1, 2] }, null, 2));
});

test("a body over 5 MB throws", async () => {
	const big = new Uint8Array(6 * 1024 * 1024).fill(97);
	await assert.rejects(fetchUrl({ url: "https://e.com/b" }, { fetch: fake(big, "text/plain"), dir: tmp() }), /larger than 5 MB/);
});

test("a sidecar naming a path outside the cache is a miss", async () => {
	const dir = tmp();
	const c = { n: 0 };
	const key = (await import("node:crypto")).createHash("sha1").update("https://e.com/s").digest("hex");
	fs.writeFileSync(path.join(dir, key + ".meta.json"), JSON.stringify({ ext: "../x", savedAt: Date.now() }));
	await fetchUrl({ url: "https://e.com/s" }, { fetch: fake("hi", "text/plain", c), dir });
	assert.equal(c.n, 1);
});
