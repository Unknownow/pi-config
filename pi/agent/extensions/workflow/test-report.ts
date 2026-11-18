/**
 * The test supervisor's final reply: a `## Test report` with items S<n> tagged bug, ask, blocked,
 * manual or fixed, ending in a VERDICT line. Pure; test-report.test.ts covers it.
 */

export type TestTag = "bug" | "ask" | "blocked" | "manual" | "fixed";
const TAGS: readonly string[] = ["bug", "ask", "blocked", "manual", "fixed"];

export interface TestItem {
	id: string;
	tag: TestTag;
	title: string;
	/** Lowercase field names (repro, expected, ...) with their text. */
	fields: Record<string, string>;
	/** The item's lines after its heading line, verbatim. */
	body: string;
}

export interface TestReport {
	title: string;
	ran: string[];
	items: TestItem[];
	verdict: "CLEAN" | "BUGS" | null;
	problems: string[];
}

export interface TestReportExpect {
	/** The first ID number a new item may have. */
	nextId: number;
	/** IDs from earlier rounds; they may be reported again. */
	known: string[];
	/** IDs the report must mention (the fixed ones of the last fix round). */
	mustReport: string[];
}

const HEADING = /^\s*#{1,4}\s*Test report:?\s*(.*)$/i;
const ITEM = /^\s*(?:[-*]\s+|\d+[.)]\s+)?\*{0,2}S(\d+)\s*[.:)]\s*\*{0,2}\s*(?:\[([A-Za-z]+)\]\s*)?(.*)$/;
const VERDICT = /^\s*\**\s*VERDICT:\s*(CLEAN|BUGS)\b/i;
const RAN = /^\s*Ran:\s*(.+)$/i;
const FIELD = /^\s+([A-Za-z][A-Za-z ]{0,24}):\s*(.*)$/;
const OTHER_HEADING = /^\s*#{1,6}\s/;

const REQUIRED: Record<string, string[]> = {
	bug: ["repro", "expected", "actual", "root cause", "fix direction"],
	ask: ["question"],
	blocked: ["needs"],
	manual: ["steps"],
	fixed: [],
};

/** The report in `text` (the last `## Test report` heading on), or null when the heading or the VERDICT line is missing. */
export function parseTestReport(text: string, expect: TestReportExpect): TestReport | null {
	const all = text.split(/\r?\n/);
	let start = -1;
	for (let i = all.length - 1; i >= 0; i--) {
		if (HEADING.test(all[i])) {
			start = i;
			break;
		}
	}
	if (start < 0) return null;
	const lines = all.slice(start);
	const title = (HEADING.exec(lines[0])?.[1] ?? "").trim();
	const problems: string[] = [];
	const ran: string[] = [];
	const items: TestItem[] = [];
	let verdict: TestReport["verdict"] = null;
	let cur: { item: TestItem; lines: string[] } | null = null;

	const finish = () => {
		if (!cur) return;
		cur.item.body = cur.lines.join("\n").replace(/\s+$/, "");
		let field: string | null = null;
		for (const l of cur.lines) {
			const m = FIELD.exec(l);
			if (m) {
				field = m[1].trim().toLowerCase();
				cur.item.fields[field] = m[2].trim();
			} else if (field && l.trim()) cur.item.fields[field] = `${cur.item.fields[field]}\n${l.trim()}`.trim();
		}
		cur = null;
	};

	for (const line of lines.slice(1)) {
		const v = VERDICT.exec(line);
		if (v) {
			finish();
			verdict = v[1].toUpperCase() as "CLEAN" | "BUGS";
			continue;
		}
		const r = RAN.exec(line);
		if (r && !/^\s{2,}/.test(line)) {
			finish();
			ran.push(r[1].trim());
			continue;
		}
		const m = ITEM.exec(line);
		if (m && !/^\s{3,}/.test(line)) {
			finish();
			const id = `S${m[1]}`;
			const tag = (m[2] ?? "").toLowerCase();
			if (!m[2]) {
				problems.push(`${id}: no [tag]; use bug, ask, blocked, manual or fixed`);
				continue;
			}
			if (!TAGS.includes(tag)) {
				problems.push(`${id}: unknown tag [${m[2]}]; use bug, ask, blocked, manual or fixed`);
				continue;
			}
			if (items.some((i) => i.id === id)) {
				problems.push(`${id}: listed twice; the first one is kept`);
				continue;
			}
			const item: TestItem = { id, tag: tag as TestTag, title: m[3].trim(), fields: {}, body: "" };
			items.push(item);
			cur = { item, lines: [] };
			continue;
		}
		if (OTHER_HEADING.test(line)) {
			finish();
			continue;
		}
		cur?.lines.push(line);
	}
	finish();
	if (verdict === null) return null;

	for (const it of items) {
		for (const f of REQUIRED[it.tag]) if (!it.fields[f]) problems.push(`${it.id}: [${it.tag}] is missing ${f[0].toUpperCase()}${f.slice(1)}`);
		if (it.tag === "bug" && it.fields.expected && !/source:/i.test(it.fields.expected)) problems.push(`${it.id}: Expected must name its source, e.g. (source: file:line)`);
	}
	if (verdict === "CLEAN" && items.some((i) => i.tag === "bug")) problems.push("VERDICT: CLEAN while a [bug] item is listed");
	if (!ran.length) problems.push("no Ran: line");
	for (const id of expect.mustReport) if (!items.some((i) => i.id === id)) problems.push(`${id}: fixed in the last round, so report it as [fixed] or [bug]`);
	for (const it of items) {
		const n = Number(it.id.slice(1));
		if (n < expect.nextId && !expect.known.includes(it.id)) problems.push(`${it.id}: new items start at S${expect.nextId}`);
	}
	return { title, ran, items, verdict, problems };
}
