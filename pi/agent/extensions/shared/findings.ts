/** Pure helpers for judge findings, shared by the workflow and orchestrate gates: parse a judge reply, hash a text, find the agreed list. */

import { createHash } from "node:crypto";

export type Severity = "blocker" | "major" | "minor";

/** One finding of a judge reply. `route`: "auto" can be fixed by the model alone, "user" needs a person's decision. */
export interface Finding {
	severity: Severity;
	category: string;
	route: "auto" | "user";
	/** The head line as written, without its leading "- ". */
	head: string;
	/** The `Why:` and `Fix:` lines that follow it. */
	body: string;
}

const HEAD = /^-\s+(blocker|major|minor)\s+-\s+\[([^\]]+)\]/i;
const ROUTE = /\bfix:\s*(auto|user)\b/i;

/** The findings of a judge reply. A missing `fix:` tag means "user"; text outside finding blocks is ignored. */
export function parseFindings(text: string): Finding[] {
	const out: Finding[] = [];
	let cur: { f: Finding; body: string[] } | undefined;
	const flush = (): void => {
		if (cur) out.push({ ...cur.f, body: cur.body.join("\n") });
		cur = undefined;
	};
	for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
		const line = raw.trimEnd();
		const m = HEAD.exec(line.trimStart());
		if (m && !/^\s/.test(line)) {
			flush();
			const route = ROUTE.exec(line)?.[1].toLowerCase() === "auto" ? "auto" : "user";
			cur = { f: { severity: m[1].toLowerCase() as Severity, category: m[2].trim(), route, head: line.replace(/^-\s+/, ""), body: "" }, body: [] };
			continue;
		}
		if (/^\s*VERDICT:/i.test(line)) {
			flush();
			continue;
		}
		if (cur && (/^\s+\S/.test(line) || /^(Why|Fix):/i.test(line))) cur.body.push(line.trim());
		else flush();
	}
	flush();
	return out;
}

/** A clean result: PASS and nothing left to report. */
export function isClean(verdict: string | undefined, findings: Finding[]): boolean {
	return verdict === "PASS" && findings.length === 0;
}

/** A finding as one string: its head line plus its body. */
export function findingText(f: Finding): string {
	return f.body ? `${f.head}\n${f.body}` : f.head;
}

/** Hash of a text, ignoring CRLF and outer whitespace. */
export function textHash(s: string): string {
	return createHash("sha1").update(s.replace(/\r\n/g, "\n").trim()).digest("hex");
}

/** A bare Escape key press, in the legacy and the kitty encodings. */
export function isEscKey(data: string): boolean {
	return data === "\x1b" || data === "\x1b[27u";
}

export function findingsBlock(fs: Finding[]): string {
	return fs.length ? fs.map((f) => `- ${findingText(f).replace(/\n/g, "\n  ")}`).join("\n") : "(none)";
}

const AGREED = /^[ \t]*\**Agreed so far:?\**:?/im;

/** The newest `Agreed so far:` list, from its line to the end of that text; undefined when no text has one. */
export function lastAgreedList(assistantTexts: string[]): string | undefined {
	for (let i = assistantTexts.length - 1; i >= 0; i--) {
		const m = AGREED.exec(assistantTexts[i]);
		if (m) return assistantTexts[i].slice(m.index).trim();
	}
	return undefined;
}

/** PASS only when the reply says `VERDICT: PASS` and never `VERDICT: FAIL`. */
export function judgeVerdict(text: string): "PASS" | "FAIL" {
	return /VERDICT:\s*PASS/i.test(text) && !/VERDICT:\s*FAIL/i.test(text) ? "PASS" : "FAIL";
}
