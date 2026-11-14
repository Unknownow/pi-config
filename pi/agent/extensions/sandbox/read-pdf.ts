/** read_pdf: text of a PDF with pdftotext, or page images with pdftoppm, in the temp folder. */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findBinary, runProgram, type RunResult } from "./video-frames.ts";

const MAX_IMAGE_PAGES = 8;
const DEFAULT_WIDTH = 900;
const MIN_CHARS_PER_PAGE = 20;
const SUMMARY_CHARS = 2000;

export interface PdfParams {
	path: string;
	/** "A-B" or "A" (1-based). Default: all pages (text) or the first 8 (images). */
	pages?: string;
	images?: boolean;
	/** Image width in pixels (default 900, 64..1920). */
	width?: number;
}

export interface PdfDeps {
	cwd?: string;
	dir?: string;
	signal?: AbortSignal;
	run?: (bin: string, args: string[], signal?: AbortSignal) => Promise<RunResult>;
	find?: (name: string) => string | undefined;
}

export interface PdfImage {
	page: number;
	file: string;
	data: string;
	mimeType: "image/png";
}

/** "3", "2-5" or undefined -> a 1-based range; an error string for anything else. */
export function parsePages(spec: string | undefined, count: number): { from: number; to: number } | { error: string } {
	if (spec === undefined || !spec.trim()) return { from: 1, to: count };
	const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(spec);
	if (!m) return { error: `bad pages "${spec}": use "A" or "A-B"` };
	const from = Number(m[1]);
	const to = m[2] === undefined ? from : Number(m[2]);
	if (from < 1 || to < from) return { error: `bad page range "${spec}"` };
	if (from > count) return { error: `page ${from} is past the end: the file has ${count} page${count === 1 ? "" : "s"}` };
	return { from, to: Math.min(to, count) };
}

export function parsePageCount(pdfinfoOut: string): number | undefined {
	const m = /^Pages:\s+(\d+)/m.exec(pdfinfoOut);
	return m ? Number(m[1]) : undefined;
}

const missing = (name: string) => `${name} not found; install poppler (MSYS2: pacman -S mingw-w64-ucrt-x86_64-poppler, or MiKTeX) and try again`;

export async function readPdf(params: PdfParams, deps: PdfDeps = {}): Promise<{ text: string; images: PdfImage[] }> {
	const file = path.resolve(deps.cwd ?? process.cwd(), params.path);
	if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`no such file: ${file}`);
	const find = deps.find ?? findBinary;
	const run = deps.run ?? runProgram;
	let count: number | undefined;
	const pdfinfo = find("pdfinfo");
	if (pdfinfo) {
		const info = await run(pdfinfo, [file], deps.signal);
		if (info.code === 0) count = parsePageCount(info.stdout);
	}
	// Without pdfinfo (or a count), pdftotext on the whole file gives one form feed per page.
	if (!count) {
		const text = find("pdftotext");
		if (!text) throw new Error(missing("pdfinfo"));
		const tmp = path.join(os.tmpdir(), `pi-read-pdf-count-${process.pid}-${Date.now()}.txt`);
		try {
			const r = await run(text, ["-layout", file, tmp], deps.signal);
			if (r.code !== 0 || !fs.existsSync(tmp)) throw new Error(`pdftotext failed: ${r.stderr.trim().slice(0, 500)}`);
			count = fs.readFileSync(tmp, "utf8").split("\f").length - 1;
		} finally {
			fs.rmSync(tmp, { force: true });
		}
		if (!count) throw new Error("could not get the page count");
	}
	const range = parsePages(params.pages, count);
	if ("error" in range) throw new Error(range.error);

	const stat = fs.statSync(file);
	const key = createHash("sha1").update(`${file}|${stat.size}|${stat.mtimeMs}`).digest("hex").slice(0, 16);
	const dir = path.join(deps.dir ?? path.join(os.tmpdir(), "pi-read-pdf"), key);
	fs.mkdirSync(dir, { recursive: true });
	const head = `PDF: ${file}\nPages: ${count}, size ${stat.size} bytes`;

	if (params.images) {
		const bin = find("pdftoppm");
		if (!bin) throw new Error(missing("pdftoppm"));
		const to = Math.min(range.to, range.from + MAX_IMAGE_PAGES - 1);
		const width = Math.min(1920, Math.max(64, Math.round(params.width ?? DEFAULT_WIDTH)));
		const prefix = path.join(dir, `w${width}-p`);
		const r = await run(bin, ["-png", "-scale-to", String(width), "-f", String(range.from), "-l", String(to), file, prefix], deps.signal);
		if (r.code !== 0) throw new Error(`pdftoppm failed: ${r.stderr.trim().slice(0, 500)}`);
		const images: PdfImage[] = [];
		for (const name of fs.readdirSync(dir).sort()) {
			const m = new RegExp(`^w${width}-p-0*(\\d+)\\.png$`).exec(name);
			if (!m) continue;
			const page = Number(m[1]);
			if (page < range.from || page > to) continue;
			const f = path.join(dir, name);
			images.push({ page, file: f, data: fs.readFileSync(f).toString("base64"), mimeType: "image/png" });
		}
		images.sort((a, b) => a.page - b.page);
		const lines = [head, `Images (${images.length}, pages ${range.from}-${to}, saved in ${dir}):`, ...images.map((i) => `- page ${i.page}: ${path.basename(i.file)}`)];
		if (to < range.to) lines.push(`Clipped: at most ${MAX_IMAGE_PAGES} pages per call; asked for ${range.from}-${range.to}. Call again with pages: "${to + 1}-${range.to}".`);
		if (!images.length) lines.push("No image could be made.");
		return { text: lines.join("\n"), images };
	}

	const bin = find("pdftotext");
	if (!bin) throw new Error(missing("pdftotext"));
	const out = path.join(dir, `text-${range.from}-${range.to}.txt`);
	const r = await run(bin, ["-layout", "-f", String(range.from), "-l", String(range.to), file, out], deps.signal);
	if (r.code !== 0 || !fs.existsSync(out)) throw new Error(`pdftotext failed: ${r.stderr.trim().slice(0, 500)}`);
	const body = fs.readFileSync(out, "utf8");
	const pages = range.to - range.from + 1;
	const chars = body.replace(/\s/g, "").length;
	const lines = [head, `Text of pages ${range.from}-${range.to}: ${body.length} characters, saved in ${out}`];
	if (chars < MIN_CHARS_PER_PAGE * pages) lines.push("No text layer (scanned?): use images: true to look at the pages.");
	lines.push("", body.slice(0, SUMMARY_CHARS) + (body.length > SUMMARY_CHARS ? "\n[... cut; grep or read the saved file for the rest]" : ""));
	return { text: lines.join("\n"), images: [] };
}
