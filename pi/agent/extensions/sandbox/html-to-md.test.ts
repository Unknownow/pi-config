import assert from "node:assert/strict";
import { test } from "node:test";
import { htmlToMarkdown } from "./html-to-md.ts";

test("converts a sample page", () => {
	const html = `<html><head><title>My &amp; Doc</title><style>p{}</style></head><body>
<nav><a href="/x">menu</a></nav><script>var a=1;</script><!-- hidden -->
<h1>Intro</h1><p>Hello <a href="https://e.com/a">link</a> and <code>x&lt;y</code>.<br>Next&nbsp;line &#65;&#x42;</p>
<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>
<pre>a &lt; b
  c</pre>
<table><tr><th>K</th><th>V</th></tr><tr><td>a</td><td>1</td></tr></table>
<footer>foot</footer></body></html>`;
	const { markdown, title } = htmlToMarkdown(html);
	assert.equal(title, "My & Doc");
	assert.ok(!/menu|var a|hidden|foot/.test(markdown));
	assert.match(markdown, /^# Intro$/m);
	assert.match(markdown, /Hello \[link\]\(https:\/\/e\.com\/a\) and `x<y`\.\nNext line AB/);
	assert.match(markdown, /^- one\n- two$/m);
	assert.match(markdown, /^1\. first\n2\. second$/m);
	assert.match(markdown, /```\na < b\n  c\n```/);
	assert.match(markdown, /\| K \| V \|\n\| --- \| --- \|\n\| a \| 1 \|/);
	assert.ok(!/\n{3,}/.test(markdown));
});

test("title falls back to the first h1", () => {
	assert.equal(htmlToMarkdown("<h1>Top</h1><p>x</p>").title, "Top");
});

test("a NUL entity does not collide with block placeholders", () => {
	const out = htmlToMarkdown("<p>&#0;0&#0;</p><pre>code</pre>").markdown;
	assert.ok(!out.includes("\u0000"));
	assert.match(out, /code/);
});
