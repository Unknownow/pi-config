/** fetch_url: GET a page, save it as markdown/json/text under the temp folder, return a short summary. */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { htmlToMarkdown } from "./html-to-md.ts";

const MAX_BYTES = 5 * 1024 * 1024;
const TTL_MS = 3_600_000;
const PREVIEW = 2000;

export interface FetchDeps {
	fetch?: typeof fetch;
	now?: () => number;
	dir?: string;
	signal?: AbortSignal;
}

interface Meta {
	finalUrl: string;
	status: number;
	contentType: string;
	size: number;
	title?: string;
	ext: "md" | "json" | "txt";
	savedAt: number;
}

async function readBody(res: Response): Promise<string> {
	const reader = res.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_BYTES) {
			await reader.cancel().catch(() => {});
			throw new Error("response body larger than 5 MB");
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function summary(meta: Meta, file: string, text: string, cached: boolean): string {
	const headings = text.split("\n").filter((l) => /^#{1,6} /.test(l)).slice(0, 40);
	const lines = [`URL: ${meta.finalUrl}${cached ? " (cached)" : ""}`, `Status: ${meta.status}`, `Type: ${meta.contentType}`, `Size: ${text.length} characters`];
	if (meta.title) lines.push(`Title: ${meta.title}`);
	if (headings.length) lines.push("Headings:", ...headings);
	lines.push("", text.slice(0, PREVIEW), `Saved: ${file}`, "Use grep or read on the file for more.");
	return lines.join("\n");
}

export async function fetchUrl(params: { url: string; force?: boolean }, deps: FetchDeps = {}): Promise<string> {
	let url: URL;
	try {
		url = new URL(params.url);
	} catch {
		throw new Error("only http and https URLs are allowed");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http and https URLs are allowed");

	const dir = deps.dir ?? path.join(os.tmpdir(), "pi-fetch");
	const now = deps.now ?? Date.now;
	const key = createHash("sha1").update(params.url).digest("hex");
	const metaFile = path.join(dir, `${key}.meta.json`);
	fs.mkdirSync(dir, { recursive: true });

	if (!params.force) {
		try {
			const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as Meta;
			const file = path.join(dir, `${key}.${meta.ext}`);
			if (!["md", "json", "txt"].includes(meta.ext) || typeof meta.savedAt !== "number") throw new Error("bad cache entry");
			if (now() - meta.savedAt < TTL_MS && fs.existsSync(file)) return summary(meta, file, fs.readFileSync(file, "utf8"), true);
		} catch {
			// no usable cache
		}
	}

	const res = await (deps.fetch ?? fetch)(url, { method: "GET", redirect: "follow", signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(deps.signal ? [deps.signal] : [])]) });
	const raw = await readBody(res);
	const contentType = res.headers.get("content-type") ?? "";
	let text = raw;
	let ext: Meta["ext"] = "txt";
	let title: string | undefined;
	if (/json/i.test(contentType)) {
		try {
			text = JSON.stringify(JSON.parse(raw), null, 2);
			ext = "json";
		} catch {
			// keep raw as txt
		}
	} else if (/html/i.test(contentType)) {
		const md = htmlToMarkdown(raw);
		text = md.markdown;
		title = md.title;
		ext = "md";
	}
	const file = path.join(dir, `${key}.${ext}`);
	fs.writeFileSync(file, text);
	const meta: Meta = { finalUrl: res.url || url.href, status: res.status, contentType, size: text.length, title, ext, savedAt: now() };
	fs.writeFileSync(metaFile, JSON.stringify(meta));
	return summary(meta, file, text, false);
}
