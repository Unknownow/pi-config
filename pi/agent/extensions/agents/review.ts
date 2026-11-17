/**
 * The generic reviewer roles: `runJudge` reviews a code change, `runCritic` a document. Both run
 * read-only (reviewer.ts refuses every tool but the reading and knowledge tools), write findings in the
 * format ../shared/findings.ts parses and end with a VERDICT line. Callers add their spec, criteria and
 * extra output sections; the findings format and the verdict rule stay fixed. The prompt assembly is pure.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { ToolCall } from "./subagent.ts";
import { collectRepoDiff, defaultReviewBase, type RunGit } from "../shared/git/repo-diff.ts";
import { type Finding, findingsBlock, isClean, judgeVerdict, parseFindings } from "../shared/findings.ts";
import type { RunView } from "../shared/runs.ts";
import { endRun } from "../shared/runs.ts";
import { loadConfig } from "./config.ts";
import { roleTools } from "./knowledge.ts";
import { CRITIC, JUDGE, JUDGE_INCREMENTAL, judgeKnowledgeStep, knowledgeTools } from "./prompts.ts";
import { REVIEW_ALLOW_ENV } from "./reviewer.ts";
import { type EventSink, type McpServer, REVIEWER_EXTENSION, type RoleRun, runRole } from "./run-role.ts";
import { toolProgress, type ToolDetails } from "./render.ts";

/** One repo's part of a change. `names`: changed paths relative to the repo root. */
export interface DiffPart {
	key: string;
	base: string;
	full: string;
	names: string[];
}

/** Per-repo diffs as one text, within `max` characters: past it only the file list plus the diffs that fit. */
export function fitDiffs(parts: DiffPart[], max: number): string {
	const total = parts.reduce((n, p) => n + p.full.length, 0);
	if (total <= max) return parts.map((p) => `### Repo ${p.key} (base ${p.base.slice(0, 10)})\n\n${p.full || "(no changes)"}`).join("\n\n");
	let left = max;
	const out: string[] = [`The diff is ${total} characters, over the limit of ${max}: the file list of every repo comes first, then as many diffs as fit. Read the rest with the read tool.`];
	for (const p of parts) out.push(`### Repo ${p.key} files\n${p.names.map((n) => `- ${n}`).join("\n")}`);
	for (const p of [...parts].sort((a, b) => a.full.length - b.full.length)) {
		if (p.full.length > left) continue;
		left -= p.full.length;
		out.push(`### Repo ${p.key} diff (base ${p.base.slice(0, 10)})\n\n${p.full}`);
	}
	return out.join("\n\n");
}

/** Inputs every review takes. */
export interface ReviewCommon {
	/** What the reviewer must check beyond the base prompt; appended as its own section. */
	criteria?: string;
	/** Extra sections the reviewer writes after its findings; they never change the findings format or the verdict line. */
	output?: string;
	/** The last round's findings (text or parsed), to check each again. */
	previousFindings?: string | Finding[];
	/** The author's disputes of earlier findings, with evidence; decided from the code. */
	disputes?: string;
	cwd: string;
	signal?: AbortSignal;
	/** A tool's update callback: the live run row is streamed into it. */
	onUpdate?: (p: { content: { type: "text"; text: string }[]; details: ToolDetails }) => void;
	/** `pi.events`: the finished run is emitted as `agents:subagent-finished`. */
	events?: EventSink;
	/** `pi.getMcpServers()`. Without it there is no knowledge forwarding and no knowledge step. */
	mcpServers?: McpServer[];
	/** Called with the run row on every update (for a caller's own widget). */
	onRun?: (run: RunView) => void;
	/** Id for the run row. */
	runId?: number;
	/** Test hook: replaces runSubagent. */
	runner?: RoleRun["runner"];
	/** Time limit of the run; default agents.json `subagent.timeoutMs`. */
	timeoutMs?: number;
	/** Idle limit of the run; default agents.json `subagent.idleTimeoutMs`. */
	idleTimeoutMs?: number;
	/** The caller's project trust (`-a` / `-na`); unset passes neither. */
	trusted?: boolean;
}

export interface JudgeRequest extends ReviewCommon {
	/** The change: a ready text is used as is; parts are fitted to `judge.maxDiffChars` (fitDiffs). */
	diff: string | DiffPart[];
	/** Paths for the knowledge step; when absent and `diff` is parts, the parts' names. */
	files?: string[];
	/** What the change must do (a plan, a brief); the judge checks it is met. */
	spec?: string;
	/** The author's framing or areas to scrutinise; it does not narrow the review. */
	focus?: string;
	/** "incremental": `diff` is only the change since the last round. */
	mode: "full" | "incremental";
}

export interface CriticRequest extends ReviewCommon {
	/** The document to review. */
	document: string;
	/** One line: what the document is and what it is for. */
	about: string;
}

export interface ReviewResult {
	ok: boolean;
	text: string;
	findings: Finding[];
	/** PASS only when the reply says PASS and no blocker or non-late major is left. */
	verdict: "PASS" | "FAIL";
	usage: Usage;
	/** Cost-weighted tokens × the model's multiplier (cost.ts), not dollars. */
	weightedCost: number;
	model: string;
	/** The run's tool calls (what a caller checks, e.g. that the knowledge step really ran); [] when it did not run. */
	toolCalls: ToolCall[];
	error?: string;
}

/** The verdict rule of both reviewers: `isClean(judgeVerdict(text), parseFindings(text))`. */
export function reviewVerdict(text: string): { verdict: "PASS" | "FAIL"; findings: Finding[] } {
	const findings = parseFindings(text);
	return { verdict: isClean(judgeVerdict(text), findings) ? "PASS" : "FAIL", findings };
}

const section = (title: string, body: string | undefined) => (body?.trim() ? `## ${title}\n\n${body.trim()}` : "");
const previousText = (p: string | Finding[] | undefined) => (Array.isArray(p) ? (p.length ? findingsBlock(p) : "") : (p ?? ""));

/** The caller's criteria and output sections, appended to a base prompt. */
function callerSections(req: Pick<ReviewCommon, "criteria" | "output">): string[] {
	return [
		section("Criteria", req.criteria),
		req.output?.trim()
			? `## Extra output\n\nAfter your findings and before the VERDICT line, add these sections. They never change the findings format or the verdict line.\n\n${req.output.trim()}`
			: "",
	].filter(Boolean);
}

/** The files the knowledge step checks. */
export function judgeFiles(req: Pick<JudgeRequest, "files" | "diff">): string[] {
	if (req.files) return req.files;
	if (typeof req.diff === "string") return [];
	const multi = req.diff.length > 1;
	return req.diff.flatMap((p) => p.names.map((n) => (multi ? `${p.key.replace(/\\/g, "/").replace(/\/+$/, "")}/${n}` : n)));
}

/** System prompts and task of a judge run (the knowledge step is added by runJudge when knowledge is on). */
export function judgePrompt(req: JudgeRequest, maxDiffChars: number): { systemPrompts: string[]; task: string } {
	const diff = typeof req.diff === "string" ? req.diff : fitDiffs(req.diff, maxDiffChars);
	const incremental = req.mode === "incremental";
	return {
		systemPrompts: [JUDGE, ...(incremental ? [JUDGE_INCREMENTAL] : []), ...callerSections(req)],
		task: [
			incremental ? "Re-review the change: the diff below is only the change since the last round." : "Review the change: the diff below is the whole change.",
			section("Focus", req.focus),
			section("Spec", req.spec),
			section(incremental ? "Findings of the previous round (check each; the code may have fixed it)" : "Findings of the previous review (check each is fixed; report it again only if it is still there)", previousText(req.previousFindings)),
			section("Disputes from the author (decide each from the code)", req.disputes),
			`## Diff${incremental ? " since the last round" : ""}\n\n${diff || "(empty)"}`,
			"End with a `VERDICT: PASS` or `VERDICT: FAIL` line.",
		]
			.filter(Boolean)
			.join("\n\n"),
	};
}

/** System prompts and task of a critic run. */
export function criticPrompt(req: CriticRequest): { systemPrompts: string[]; task: string } {
	return {
		systemPrompts: [CRITIC, ...callerSections(req)],
		task: [
			"Review the document below against the code.",
			section("About", req.about),
			section("Previous findings (check each is fixed; report it again only if it is still there)", previousText(req.previousFindings)),
			section("Disputes from the author (decide each from the code)", req.disputes),
			`## Document\n\n${req.document}`,
			"End with a `VERDICT: PASS` or `VERDICT: FAIL` line.",
		]
			.filter(Boolean)
			.join("\n\n"),
	};
}

async function review(role: "judge" | "critic", label: string, prompt: { systemPrompts: string[]; task: string }, req: ReviewCommon, knowledgePrompt: RoleRun["knowledgePrompt"]): Promise<ReviewResult> {
	const cfg = loadConfig().config;
	const progress = req.onUpdate ? toolProgress(req.onUpdate) : undefined;
	const onRun = (run: RunView) => {
		progress?.track(run);
		req.onRun?.(run);
	};
	// The allow list names the knowledge tools the role may get; reviewer.ts refuses all else but reading.
	const { result, run, model, weightedCost } = await runRole({
		role,
		label,
		systemPrompts: prompt.systemPrompts,
		tools: cfg[role].tools,
		task: prompt.task,
		cwd: req.cwd,
		signal: req.signal,
		extensions: [REVIEWER_EXTENSION],
		env: { [REVIEW_ALLOW_ENV]: allowList(role, req.mcpServers) },
		events: req.events,
		mcpServers: req.mcpServers,
		knowledgePrompt,
		onRun,
		runId: req.runId,
		runner: req.runner,
		timeoutMs: req.timeoutMs,
		idleTimeoutMs: req.idleTimeoutMs,
		trusted: req.trusted,
	});
	const { verdict, findings } = result.ok ? reviewVerdict(result.text) : { verdict: "FAIL" as const, findings: [] };
	if (result.ok) endRun(run, verdict === "PASS", `${verdict}${findings.length ? ` · ${findings.length} finding${findings.length === 1 ? "" : "s"}` : ""}`);
	onRun(run);
	return { ok: result.ok, text: result.text, findings, verdict, usage: result.usage, weightedCost, model, toolCalls: result.toolCalls ?? [], ...(result.error ? { error: result.error } : {}) };
}

/** The knowledge tool names the reviewer extension lets through: the role's configured knowledge tools when forwarding is on. */
function allowList(role: string, mcpServers: McpServer[] | undefined): string {
	return mcpServers ? roleTools(role, loadConfig().config.knowledge).join(",") : "";
}

/** Reviews a code change read-only with the `judge` role. */
export async function runJudge(req: JudgeRequest): Promise<ReviewResult> {
	const cfg = loadConfig().config;
	const files = judgeFiles(req);
	const knowledgePrompt = (tools: string[], server: string) => (cfg.knowledge.judgeCheck ? judgeKnowledgeStep(server, files) : knowledgeTools(tools));
	const label = req.focus?.split("\n")[0]?.slice(0, 80) || (req.mode === "incremental" ? "changes since the last round" : "current diff");
	return review("judge", label, judgePrompt(req, cfg.judge.maxDiffChars), req, knowledgePrompt);
}

/** Reviews a document read-only with the `critic` role. */
export async function runCritic(req: CriticRequest): Promise<ReviewResult> {
	return review("critic", req.about.split("\n")[0].slice(0, 80) || "document", criticPrompt(req), req, undefined);
}

/**
 * The diff of each repo as a DiffPart: against `base` when given, else against the merge-base of HEAD
 * with the origin default branch (defaultReviewBase), plus uncommitted and untracked files.
 */
export async function collectDiffParts(git: RunGit, roots: string[], base?: string): Promise<DiffPart[]> {
	const parts = await Promise.all(
		roots.map(async (root): Promise<DiffPart | null> => {
			const b = base?.trim() || (await defaultReviewBase(git, root));
			const d = await collectRepoDiff(git, root, b);
			return d ? { key: root, base: b, full: d.full, names: d.rootNames } : null;
		}),
	);
	return parts.filter((p): p is DiffPart => p !== null);
}
