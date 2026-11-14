// node --experimental-strip-types --test read-pdf.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { parsePageCount, parsePages, readPdf } from "./read-pdf.ts";
import { findBinary } from "./video-frames.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-pdf-test-"));
const have = !!(findBinary("pdfinfo") && findBinary("pdftotext") && findBinary("pdftoppm"));
const skip = have ? false : "poppler binaries (pdfinfo, pdftotext, pdftoppm) not installed";

/** A minimal PDF with `pages` pages; each holds the text "Page N hello world" unless `blank`. */
function makePdf(file: string, pages: number, blank = false): void {
	const objs: string[] = [];
	const kids = Array.from({ length: pages }, (_, i) => 4 + i * 2);
	objs.push("<< /Type /Catalog /Pages 2 0 R >>");
	objs.push(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${pages} >>`);
	objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	for (let i = 0; i < pages; i++) {
		const content = blank ? "" : `BT /F1 24 Tf 72 700 Td (Page ${i + 1} hello world and some more words here) Tj ET`;
		objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
		objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
	}
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objs.forEach((o, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	fs.writeFileSync(file, out);
}

test("parsePages handles one page, a range, clamping and errors", () => {
	assert.deepEqual(parsePages(undefined, 5), { from: 1, to: 5 });
	assert.deepEqual(parsePages("3", 5), { from: 3, to: 3 });
	assert.deepEqual(parsePages("2-9", 5), { from: 2, to: 5 });
	assert.ok("error" in parsePages("x", 5));
	assert.ok("error" in parsePages("4-2", 5));
	assert.ok("error" in parsePages("7", 5));
	assert.equal(parsePageCount("Title: x\nPages:           12\n"), 12);
});
test("text mode returns the page count, size, a summary and the saved path", { skip }, async () => {
	const d = tmp();
	const file = path.join(d, "a.pdf");
	makePdf(file, 3);
	const r = await readPdf({ path: file }, { cwd: d, dir: path.join(d, "out") });
	assert.match(r.text, /Pages: 3/);
	assert.match(r.text, /Page 2 hello world/);
	assert.match(r.text, /saved in .*text-1-3\.txt/);
	assert.equal(r.images.length, 0);
	const one = await readPdf({ path: file, pages: "2" }, { cwd: d, dir: path.join(d, "out") });
	assert.match(one.text, /Page 2 hello/);
	assert.doesNotMatch(one.text, /Page 1 hello/);
});

test("a PDF without a text layer says so", { skip }, async () => {
	const d = tmp();
	const file = path.join(d, "b.pdf");
	makePdf(file, 2, true);
	const r = await readPdf({ path: file }, { cwd: d, dir: path.join(d, "out") });
	assert.match(r.text, /No text layer/);
});

test("image mode clips 12 pages to 8 and says so", { skip }, async () => {
	const d = tmp();
	const file = path.join(d, "c.pdf");
	makePdf(file, 12);
	const r = await readPdf({ path: file, images: true }, { cwd: d, dir: path.join(d, "out") });
	assert.equal(r.images.length, 8);
	assert.deepEqual(r.images.map((i) => i.page), [1, 2, 3, 4, 5, 6, 7, 8]);
	assert.match(r.text, /Clipped/);
	assert.ok(r.images.every((i) => i.data.length > 100 && fs.existsSync(i.file)));
});

test("a missing binary, a missing file and a bad range are errors", async () => {
	const d = tmp();
	const file = path.join(d, "d.pdf");
	makePdf(file, 2);
	await assert.rejects(readPdf({ path: file }, { cwd: d, find: () => undefined }), /pdfinfo not found.*install/);
	await assert.rejects(readPdf({ path: path.join(d, "nope.pdf") }, { cwd: d }), /no such file/);
	const run = async () => ({ code: 0, stdout: "Pages: 2\n", stderr: "" });
	await assert.rejects(readPdf({ path: file, pages: "5" }, { cwd: d, find: (n) => n, run }), /past the end/);
	await assert.rejects(readPdf({ path: file, images: true }, { cwd: d, find: (n) => (n === "pdftoppm" ? undefined : n), run }), /pdftoppm not found/);
});

test("without pdfinfo the page count comes from pdftotext form feeds", { skip }, async () => {
	const d = tmp();
	const file = path.join(d, "e.pdf");
	makePdf(file, 3);
	const r = await readPdf({ path: file }, { cwd: d, dir: path.join(d, "out"), find: (n) => (n === "pdfinfo" ? undefined : findBinary(n)) });
	assert.match(r.text, /Pages: 3/);
});
