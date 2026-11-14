/** The brief: a markdown document with `##` sections. Parse, validate, version and amend. */

import { CATEGORIES, type Category, type Size } from "./config.ts";

export const REQUIRED_SECTIONS = ["Goal", "Done when", "Non-goals", "Constraints", "Decisions (locked)", "Design", "Scale", "Verify"] as const;
/** A `yes` here needs specifics. */
export const NEEDS_SPECIFICS: Category[] = ["merge", "publish", "delete", "formats"];

export interface AuthorityItem {
	value: "yes" | "no" | "n/a";
	specifics?: string;
}
export interface Target {
	repo: string;
	branch: string;
}
export interface Amendment {
	n: number;
	by: "lead" | "user" | "approval";
	text: string;
}
export interface Brief {
	sections: Record<string, string>;
	authority: Partial<Record<Category, AuthorityItem>>;
	targets: Target[];
	budget?: { wallMin?: number; tokens?: number; size?: Size };
	files?: string[];
	dependsOn?: string;
	publish?: string[];
	amendments: Amendment[];
	/** 1 plus the number of amendments. */
	version: number;
}

const AMEND = /^Amendment (\d+) \((lead|user|approval)\)\s*:?\s*(.*)$/i;

/** Splits into `##` sections (the text before the first one is the title). */
function split(text: string): { title: string; parts: { name: string; body: string }[] } {
	const lines = text.split(/\r?\n/);
	const parts: { name: string; body: string[] }[] = [];
	const head: string[] = [];
	for (const l of lines) {
		const m = /^##\s+(.+?)\s*$/.exec(l);
		if (m) parts.push({ name: m[1], body: [] });
		else if (parts.length) parts[parts.length - 1].body.push(l);
		else head.push(l);
	}
	return { title: head.join("\n").trim(), parts: parts.map((p) => ({ name: p.name, body: p.body.join("\n").trim() })) };
}

const bullet = (l: string) => l.replace(/^\s*[-*]\s+/, "").trim();
const lines = (body: string) => body.split(/\r?\n/).map(bullet).filter(Boolean);

function parseTokens(s: string): number | undefined {
	const m = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(s.trim());
	if (!m) return undefined;
	return Math.round(Number(m[1]) * (m[2].toLowerCase() === "m" ? 1_000_000 : m[2].toLowerCase() === "k" ? 1000 : 1));
}

/** The brief, or the format errors found (a bad Authority value, a Targets line without a branch, a bad Budget). Missing sections are `validateBrief`'s job. */
export function parseBrief(text: string): Brief | { errors: string[] } {
	const errors: string[] = [];
	const { parts } = split(text);
	const b: Brief = { sections: {}, authority: {}, targets: [], amendments: [], version: 1 };
	for (const p of parts) {
		const am = AMEND.exec(p.name);
		if (am) {
			b.amendments.push({ n: Number(am[1]), by: am[2].toLowerCase() as Amendment["by"], text: [am[3], p.body].filter(Boolean).join("\n") });
			continue;
		}
		const key = REQUIRED_SECTIONS.find((r) => r.toLowerCase() === p.name.toLowerCase()) ?? p.name;
		b.sections[key] = p.body;
	}
	b.version = 1 + b.amendments.length;

	for (const l of lines(b.sections.Authority ?? "")) {
		const m = /^(\w+)\s*:\s*(yes|no|n\/a)\b\s*(?:\((.*)\))?\s*$/i.exec(l);
		if (!m || !(CATEGORIES as readonly string[]).includes(m[1].toLowerCase())) {
			errors.push(`Authority: cannot read "${l}" (expected "<${CATEGORIES.join("|")}>: yes (<specifics>) | no | n/a")`);
			continue;
		}
		const cat = m[1].toLowerCase() as Category;
		b.authority[cat] = { value: m[2].toLowerCase() as AuthorityItem["value"], ...(m[3]?.trim() ? { specifics: m[3].trim() } : {}) };
	}
	for (const l of lines(b.sections.Targets ?? "")) {
		const m = /^(.+?)\s*:\s+(\S+)$/.exec(l);
		if (!m) errors.push(`Targets: cannot read "${l}" (expected "<repo dir or key>: <branch>")`);
		else b.targets.push({ repo: m[1].replace(/^`|`$/g, ""), branch: m[2] });
	}
	if (b.sections.Budget) {
		const budget: NonNullable<Brief["budget"]> = {};
		for (const part of b.sections.Budget.split(/[;\n]/).map((s) => bullet(s)).filter(Boolean)) {
			const m = /^(wall|tokens|size)\s*:\s*(.+)$/i.exec(part);
			if (!m) {
				errors.push(`Budget: cannot read "${part}"`);
				continue;
			}
			const k = m[1].toLowerCase();
			if (k === "wall") {
				const w = /^(\d+)\s*(m|min|h)?$/i.exec(m[2].trim());
				if (w) budget.wallMin = Number(w[1]) * (w[2]?.toLowerCase() === "h" ? 60 : 1);
				else errors.push(`Budget: wall "${m[2]}" is not minutes (120m) or hours (2h)`);
			} else if (k === "tokens") {
				const t = parseTokens(m[2]);
				if (t) budget.tokens = t;
				else errors.push(`Budget: tokens "${m[2]}" is not a number (4M, 500k)`);
			} else if (["small", "normal", "large"].includes(m[2].trim())) budget.size = m[2].trim() as Size;
			else errors.push(`Budget: size must be small, normal or large`);
		}
		b.budget = budget;
	}
	if (b.sections.Files) b.files = b.sections.Files.split(/[\n,]/).map((s) => bullet(s).replace(/^`|`$/g, "")).filter(Boolean);
	if (b.sections["Depends on"]) b.dependsOn = lines(b.sections["Depends on"])[0];
	if (b.sections.Publish) b.publish = lines(b.sections.Publish).map((s) => s.replace(/^`|`$/g, ""));
	return errors.length ? { errors } : b;
}

/** What a complete brief needs and this one lacks (D6). Empty when the brief may go. */
export function validateBrief(b: Brief): string[] {
	const e: string[] = [];
	for (const s of REQUIRED_SECTIONS) if (!b.sections[s]?.trim()) e.push(`section "${s}" is missing or empty`);
	if (b.sections["Done when"]?.trim() && !/^\s*[-*]\s+\S/m.test(b.sections["Done when"])) e.push('"Done when" needs at least one bullet');
	for (const c of CATEGORIES) {
		const a = b.authority[c];
		if (!a) e.push(`Authority: "${c}" is missing (yes (<specifics>), no or n/a)`);
		else if (a.value === "yes" && !a.specifics && NEEDS_SPECIFICS.includes(c)) e.push(`Authority: "${c}: yes" needs specifics, e.g. "${c}: yes (<what exactly>)"`);
	}
	if (b.targets.length === 0) e.push("Targets: at least one line `<repo dir or key>: <branch>`");
	if (b.publish?.length && b.authority.publish?.value !== "yes") e.push("Publish commands are allowed only with `publish: yes (...)`");
	return e;
}

/** `parseBrief` then `validateBrief`: the brief, or every problem. */
export function checkBrief(text: string): { brief: Brief } | { errors: string[] } {
	const p = parseBrief(text);
	if ("errors" in p) return p;
	const errors = validateBrief(p);
	return errors.length ? { errors } : { brief: p };
}

/** Adds `## Amendment N (by): body`; the version goes up by one. */
export function appendAmendment(text: string, by: Amendment["by"], body: string): string {
	const parsed = parseBrief(text);
	const version = "errors" in parsed ? 1 + [...text.matchAll(/^##\s+Amendment \d+ \(/gim)].length : parsed.version;
	return `${text.trimEnd()}\n\n## Amendment ${version} (${by}): ${body.trim()}\n`;
}

/** The first line of the Goal, or the first line of the brief: a job title. */
export function briefTitle(text: string): string {
	const p = parseBrief(text);
	const goal = "errors" in p ? "" : p.sections.Goal ?? "";
	const l = goal.split(/\r?\n/).find((x) => x.trim()) ?? text.split(/\r?\n/).find((x) => x.trim()) ?? "job";
	return l.replace(/^#+\s*/, "").trim().slice(0, 80);
}
