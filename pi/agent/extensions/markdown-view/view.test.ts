import assert from "node:assert/strict";
import { test } from "node:test";
import { CDN, buildHtml, parseViewArgs, replyTexts, viewFileName } from "./view.ts";

test("parseViewArgs", () => {
	assert.deepEqual(parseViewArgs(""), { kind: "reply", index: 1 });
	assert.deepEqual(parseViewArgs("  "), { kind: "reply", index: 1 });
	assert.deepEqual(parseViewArgs("3"), { kind: "reply", index: 3 });
	assert.ok("error" in parseViewArgs("0"));
	assert.deepEqual(parseViewArgs("docs/a.md"), { kind: "file", path: "docs/a.md" });
	assert.deepEqual(parseViewArgs('"my notes.md"'), { kind: "file", path: "my notes.md" });
});

const msg = (role: string, content: unknown) => ({ type: "message", message: { role, content } });

test("replyTexts picks assistant text blocks only", () => {
	const entries = [
		msg("user", [{ type: "text", text: "hi" }]),
		msg("assistant", [{ type: "thinking", thinking: "t" }, { type: "text", text: "A" }, { type: "toolCall", name: "x" }]),
		msg("assistant", [{ type: "toolCall", name: "y" }]),
		{ type: "custom", customType: "z" },
		{},
		{ type: "message" },
		null,
		msg("assistant", [{ type: "text", text: "B" }, { type: "text", text: "C" }]),
	];
	assert.deepEqual(replyTexts(entries), ["A", "B\n\nC"]);
	assert.deepEqual(replyTexts([]), []);
});

test("buildHtml cannot break out of the data script", () => {
	const md = "</script><script>alert(1)</script>";
	const html = buildHtml(md, "t");
	const start = html.indexOf('id="md">') + 'id="md">'.length;
	const end = html.indexOf("</script>", start);
	assert.equal(JSON.parse(html.slice(start, end)), md);
	assert.equal(html.slice(start, end).includes("</script"), false);
});

test("buildHtml escapes the title and pins the CDN", () => {
	const html = buildHtml("x", 'a<b & "c"');
	assert.ok(html.includes("<title>a&lt;b &amp; &quot;c&quot;</title>"));
	for (const url of Object.values(CDN)) assert.ok(html.includes(url), url);
	assert.ok(html.includes('securityLevel: "strict"'));
});

test("viewFileName", () => {
	const n = viewFileName(new Date(2026, 10, 7, 9, 8, 7, 6));
	assert.equal(n, "view-20261107-090807-006.html");
	assert.match(n, /^view-\d{8}-\d{6}-\d{3}\.html$/);
});
