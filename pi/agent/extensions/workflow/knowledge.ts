/**
 * Team knowledge (an MCP server such as IEC's `knowledge`) for the workflow's subagents, and the
 * check that the judge really ran its knowledge step. Pure functions; index.ts wires them in.
 */
import type { KnowledgeConfig, Role } from "./config.ts";
import type { ToolCall } from "./subagent.ts";

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

/** `mcp__<server>__`, with the server name normalized like pi's tool names. */
export function toolPrefix(server: string): string {
	return `mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}__`;
}

/** Tools that write; never handed to a subagent, whatever the config says. */
const WRITE_TOOLS = new Set(["propose_entry"]);

/** Knowledge tool names `role` gets; [] when the role is not in `cfg.roles`. */
export function roleTools(role: Role, cfg: KnowledgeConfig): string[] {
	return cfg.server && cfg.roles.includes(role) ? cfg.tools.filter((t) => !WRITE_TOOLS.has(t)).map((t) => toolPrefix(cfg.server) + t) : [];
}

/**
 * The server config for subagents: as registered, plus `cfg.env` for stdio servers, with its tools
 * exposed directly (the subagents name them in --tools). {} when not registered.
 */
export function forwardedServers(registered: { name: string; config: object }[], cfg: KnowledgeConfig): Record<string, Record<string, unknown>> {
	const found = cfg.server ? registered.find((r) => r.name === cfg.server) : undefined;
	if (!found) return {};
	const config = { ...(found.config as Record<string, unknown>) };
	if (typeof config.command === "string") config.env = { ...((config.env as Record<string, string> | undefined) ?? {}), ...cfg.env };
	config.exposure = "direct";
	delete config.toolExposure;
	return { [cfg.server]: config };
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
function covers(paths: string[], file: string): boolean {
	const f = norm(file);
	return paths.some((raw) => {
		const p = norm(raw);
		return p === f || f.endsWith(`/${p}`) || p.endsWith(`/${f}`);
	});
}

/**
 * The files a judge run must knowledge-check. On a re-review after a round whose knowledge check passed,
 * only the files changed since that round (that are still in the change); otherwise all of them.
 */
export function recheckKnowledgeFiles(prevChecked: boolean, changed: string[], all: string[]): { files: string[]; scoped: boolean } {
	if (!prevChecked) return { files: all, scoped: false };
	const files = all.filter((f) => covers(changed, f));
	return files.length > 0 ? { files, scoped: true } : { files: all, scoped: false };
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

/** Recommended-rule deviation findings, in the judge's five-field format; deduplicated by id and place. */
export function parseDeviations(text: string): Deviation[] {
	const labels = { rule: "Rule", code: "Code", reason: "Reason", impact: "Impact", follow: "To follow it" } as const;
	const lines = text.split(/\r?\n/);
	const out: Deviation[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^(\S.*?) - minor - \[knowledge ([^\]\s]+)\] deviation from a recommended rule/i);
		if (!m) continue;
		const d: Deviation = { where: m[1].trim(), id: m[2], rule: "", code: "", reason: "", impact: "", follow: "" };
		for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) {
			for (const [key, label] of Object.entries(labels)) {
				const f = lines[j].match(new RegExp(`^\\s+${label}:\\s*(.*)$`, "i"));
				if (f) d[key as keyof typeof labels] = f[1].trim();
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

/** The judge's text plus the knowledge pass, under one verdict: FAIL when either says FAIL or has none. */
export function mergeKnowledgePass(first: string, pass: string): string {
	const passed = (t: string) => /VERDICT:\s*PASS/i.test(t) && !/VERDICT:\s*FAIL/i.test(t);
	const strip = (t: string) => t.replace(/^\s*VERDICT:\s*(PASS|FAIL)\s*$/gim, "").trim();
	const verdict = passed(first) && passed(pass) ? "PASS" : "FAIL";
	return [strip(first), "## Knowledge check (separate pass; the judge skipped it)", strip(pass), `VERDICT: ${verdict}`].filter(Boolean).join("\n\n");
}

/** The line appended to every judge result when knowledge is active. */
export function knowledgeFooter(k: KnowledgeStatus, deviations: number): string {
	if (k.status === "checked") return deviations > 0 ? `Knowledge: checked; ${deviations} recommended-rule deviation(s) above go into the commit message.` : "Knowledge: checked.";
	return `Knowledge: not checked - ${k.reason.replace(/\.$/, "")}.`;
}
