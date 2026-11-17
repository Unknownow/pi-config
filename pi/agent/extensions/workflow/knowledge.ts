/**
 * The workflow's side of the judge's team-knowledge step (agents' runJudge runs it): whether the judge
 * really checked every changed file, and the recommended-rule deviations that go into the pull request.
 * Pure functions; index.ts wires them in.
 */
import { type Finding, type ToolCall, toolPrefix } from "../agents/api.ts";

export type KnowledgeStatus = { status: "checked" } | { status: "skipped" | "unavailable"; reason: string };

export interface Deviation {
	id: string;
	where: string;
	rule: string;
	code: string;
	reason: string;
	impact: string;
	follow: string;
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
/** Whether `file` is one of `paths` (either may be a suffix of the other). */
export function covers(paths: string[], file: string): boolean {
	const f = norm(file);
	return paths.some((raw) => {
		const p = norm(raw);
		return p === f || f.endsWith(`/${p}`) || p.endsWith(`/${f}`);
	});
}

/** Whether the judge's tool calls show a real knowledge check of every changed file. */
export function judgeKnowledge(calls: ToolCall[], text: string, files: string[], server: string): KnowledgeStatus {
	const prefix = toolPrefix(server);
	const mine = calls.filter((c) => c.name.startsWith(prefix));
	const packs = mine.filter((c) => c.name === `${prefix}get_rule_pack` && c.isError === false);
	// Rules without paths apply to every file, so a pack with no rules at all means the server has no index.
	if (packs.length > 0 && packs.every((c) => /"rules"\s*:\s*\[\s*\]/.test(c.result ?? ""))) {
		return { status: "unavailable", reason: "the rule pack had no rules (no team index loaded)" };
	}
	const paths: string[] = [];
	for (const c of packs) {
		const p = c.args.paths;
		if (!Array.isArray(p) || p.length === 0) return { status: "checked" };
		paths.push(...p.filter((x): x is string => typeof x === "string"));
	}
	if (packs.length > 0 && files.every((f) => covers(paths, f))) return { status: "checked" };
	const claimed = text.match(/^KNOWLEDGE:\s*unavailable\s*-\s*(.+)$/im)?.[1]?.trim();
	if (mine.length > 0 && mine.every((c) => c.isError === true)) return { status: "unavailable", reason: claimed ?? "every knowledge tool call failed" };
	if (packs.length > 0) return { status: "skipped", reason: "the rule pack did not cover every changed file" };
	return { status: "skipped", reason: claimed ? `"unavailable - ${claimed}" without a failed knowledge call` : "no get_rule_pack call" };
}

const FIELDS = { rule: "Rule", code: "Code", reason: "Reason", impact: "Impact", follow: "To follow it" } as const;

/** The recommended-rule deviations among a judge's findings (`[knowledge <id>]`, five fields), deduplicated by id and place. */
export function parseDeviations(findings: Finding[]): Deviation[] {
	const out: Deviation[] = [];
	for (const f of findings) {
		const id = /^knowledge\s+(\S+)$/i.exec(f.category)?.[1];
		if (f.severity !== "minor" || !id || !/deviation from a recommended rule/i.test(f.head)) continue;
		const d: Deviation = { where: /`([^`]+)`/.exec(f.head)?.[1] ?? "", id, rule: "", code: "", reason: "", impact: "", follow: "" };
		for (const line of f.body.split("\n")) {
			for (const [key, label] of Object.entries(FIELDS)) {
				const m = new RegExp(`^${label}:\\s*(.*)$`, "i").exec(line.trim());
				if (m) d[key as keyof typeof FIELDS] = m[1].trim();
			}
		}
		if (!out.some((o) => o.id === d.id && o.where === d.where)) out.push(d);
	}
	return out;
}

/** The commit message block for D6; "" when there are none. */
export function deviationBlock(devs: Deviation[]): string {
	if (devs.length === 0) return "";
	const t = (s: string) => s.replace(/[.\s]+$/, "") || "not stated";
	return ["Knowledge deviations:", ...devs.map((d) => `- ${d.id} at ${d.where}: ${t(d.code)}; reason: ${t(d.reason)}; impact: ${t(d.impact)}`)].join("\n");
}

/** The line appended to every judge result when knowledge is active. */
export function knowledgeFooter(k: KnowledgeStatus, deviations: number): string {
	if (k.status === "checked") return deviations > 0 ? `Knowledge: checked; ${deviations} recommended-rule deviation(s) above go into the commit message.` : "Knowledge: checked.";
	return `Knowledge: not checked - ${k.reason.replace(/\.$/, "")}.`;
}
