import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Theme, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Role } from "../config.ts";
import { gitTaskAllowed, parseMergeArbiter, planFlaws } from "../agent-end.ts";
import * as prompts from "../prompts.ts";
import { type GitGuardSpec, GIT_GUARD_ENV } from "../git-guard.ts";
import { noMerge, recordJudged, defaultRunner, originRepo } from "../../shared/git/merge-gate.ts";
import { repoKey } from "../../shared/repos.ts";
import { lockDecision, parsePublishStep, parseMirrorStep, waitSince, lockWaitCheck, mirrorArgs, NO_JUDGED_MERGE, publishArgs, classifyPublish, blockedWaitCheck } from "../registry-publish.ts";
import { isHuman, openStepsReminder } from "../plan-doc.ts";
import { pidAlive } from "../plan-store.ts";
import { readOnlyProblem } from "../../shared/readonly-bash.ts";
import { mergeDecisions, gateOpenSteps, parseDeliverStep, hasCheckpointAmendment, checkpointAmendment, isPlannedTag, checkpointText } from "../checkpoints.ts";
import { tagDecision, pushArgs } from "../tags.ts";
import { parseVerifyStep, verifyAmendment, cleanCheck, waitKindProblem, waitCheckProblem, parseWaitStep, autopilotSkipsWait, autopilotAmendment, autopilotReply, waitAmendment } from "../waits.ts";
import { claimJudgeCall, type JudgeParams } from "../judge-claim.ts";
import { toolProgress, renderRuns } from "../../agents/api.ts";
import { deviationBlock } from "../knowledge.ts";
import { shortModel } from "../../shared/runs.ts";
import { type Flow, GIT_GUARD_EXTENSION, type ToolReply } from "./context.ts";
import { collectFlowDiff, flowRepos, git, judge, nextAmendmentNumber, planForJudge, refreshReviewBase } from "./diff.ts";
import { flowHasRemote, mergeDue, midFlowMergeRefusal, recordMergeDecision } from "./merge.ts";
import { askUser } from "./notify.ts";
import { autopilotOn, currentStages, deliverHintsText, deliverLine, noteAuto, persist, refreshChecklist, updateStatus } from "./phase.ts";
import { planMilestone, rewritePlanFile } from "./plan-files.ts";
import { modelOf, runRole } from "./roles.ts";
import { runWaitCheck, setWaiting, startWaitTimer } from "./wait-points.ts";

// ----------------------------------------------------------------------
// Tools
// ----------------------------------------------------------------------

export const title = (fl: Flow, theme: Theme, name: string, role: Role | "judge" | "critic") =>
	theme.fg("toolTitle", theme.bold(`${name} `)) + theme.fg("muted", shortModel(modelOf(fl, role).model));

/** Runs `node scripts/<script> <args>` in a repo with stdin closed; resolves with the exit code and the output. */
export function runNodeScript(root: string, script: string, args: string[], timeoutMs = 30 * 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn("node", [path.join(root, "scripts", script), ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ code: 1, stdout, stderr: `${stderr}${e.message}` });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? 1, stdout, stderr });
		});
	});
}

export const lastLines = (text: string, n = 40) => text.trim().split(/\r?\n/).slice(-n).join("\n");

/** The clone's publish lock file (shared by every session and worktree of the clone). */
export async function publishLockFile(fl: Flow, root: string): Promise<string> {
	const common = (await git(fl, root, "rev-parse", "--git-common-dir")).stdout.trim() || ".git";
	return path.resolve(root, common, "iec-publish.lock");
}

/** Takes the clone's publish lock: a release function, or "held" while another session publishes. */
export async function takePublishLock(fl: Flow, file: string): Promise<{ release: () => void } | "held"> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			fs.writeFileSync(file, JSON.stringify({ session: fl.state.planDoc?.flowId ?? "session", pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
			return { release: () => fs.rmSync(file, { force: true }) };
		} catch {
			let lock: { pid: number; startedAt: string } | null = null;
			try {
				lock = JSON.parse(fs.readFileSync(file, "utf8"));
			} catch {
				// A half-written file is a lock being taken: judge it by its age.
				try {
					lock = { pid: 0, startedAt: fs.statSync(file).mtime.toISOString() };
				} catch {
					lock = null;
				}
			}
			if (lockDecision(lock, Date.now(), pidAlive) === "held") return "held";
			fs.rmSync(file, { force: true });
		}
	}
	return "held";
}

/** The commit a judged merge landed in this repo (a merged pull request's merge commit, or a pushed commit that origin has), or the reason there is none. */
export async function judgedMergeHead(fl: Flow, root: string): Promise<{ head: string } | { error: string }> {
	const jm = fl.state.judgedMerges?.[repoKey(root)];
	if (!jm) return { error: NO_JUDGED_MERGE };
	await git(fl, root, "fetch", "--quiet", "origin");
	if (jm.pr) {
		const slug = await originRepo(defaultRunner, root);
		const view = await defaultRunner("gh", ["pr", "view", jm.pr, ...(slug ? ["-R", slug] : []), "--json", "state,mergeCommit"], root);
		if (view.code !== 0) return { error: `Cannot read pull request ${jm.pr} (${view.stderr.trim().split(/\r?\n/)[0] || "gh failed"}). Nothing published.` };
		try {
			const j = JSON.parse(view.stdout) as { state?: unknown; mergeCommit?: { oid?: unknown } | null };
			if (j.state !== "MERGED") return { error: `Pull request ${jm.pr} is ${String(j.state)}, not MERGED: merge the judged pull request first. Nothing published.` };
			const oid = typeof j.mergeCommit?.oid === "string" ? j.mergeCommit.oid : "";
			if (!oid) return { error: `Pull request ${jm.pr} has no merge commit to read. Nothing published.` };
			return { head: oid };
		} catch {
			return { error: `Cannot read pull request ${jm.pr} (gh printed no JSON). Nothing published.` };
		}
	}
	if (jm.commit) {
		const onRemote = await git(fl, root, "branch", "-r", "--contains", jm.commit);
		if (onRemote.code !== 0 || !onRemote.stdout.trim()) return { error: `The judged commit ${jm.commit.slice(0, 9)} is not on origin yet: push it first. Nothing published.` };
		return { head: jm.commit };
	}
	return { error: NO_JUDGED_MERGE };
}

/** The versions the merged head holds for these packages, or the reason it can't be read. */
export async function readMergedItems(fl: Flow, root: string, head: string, packages: string[]): Promise<{ items: { name: string; version: string }[] } | { error: string }> {
	const items: { name: string; version: string }[] = [];
	for (const name of packages) {
		const show = await git(fl, root, "show", `${head}:${name}/package.json`);
		let version = "";
		try {
			version = String(JSON.parse(show.stdout).version ?? "");
		} catch {
			version = "";
		}
		if (show.code !== 0 || !version) return { error: `${name} has no package.json at the merged head ${head.slice(0, 8)}. Nothing published.` };
		items.push({ name, version });
	}
	return { items };
}

/** The script's dry run for these versions: its JSON, or the reason it failed. */
export async function dryRunPublish(root: string, items: { name: string; version: string }[]) {
	const dry = await runNodeScript(root, "update-packages.mjs", publishArgs(items, true));
	let result: { items?: { name: string; version: string }[]; blockedBy?: { tag: string }[]; notCandidates?: string[]; error?: string } | undefined;
	try {
		result = JSON.parse(dry.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "");
	} catch {
		result = undefined;
	}
	if (dry.code !== 0 || !result || result.error) return { error: `exit ${dry.code}${result?.error ? ` (${result.error})` : ""}:\n${lastLines(`${dry.stderr}\n${dry.stdout}`, 20)}` };
	return { result };
}

/** The tags (name/vversion) of these versions that origin has. */
export async function taggedOnOrigin(fl: Flow, root: string, items: { name: string; version: string }[]): Promise<Set<string>> {
	const tagged = new Set<string>();
	for (const i of items) {
		const remote = await git(fl, root, "ls-remote", "--tags", "origin", `${i.name}/v${i.version}`);
		if (remote.code === 0 && remote.stdout.trim()) tagged.add(`${i.name}/v${i.version}`);
	}
	return tagged;
}

/** The Publish step: versions come from the head this flow merged; the script's dry run decides what is published, already on the registry or not publishable; blockers start a wait. */
export async function runPublish(fl: Flow, root: string, step: string, packages: string[], reply: (t: string) => ToolReply, wait: (why: string, check: string) => ToolReply): Promise<ToolReply> {
	if (noMerge(fl.state.approvedPlan ?? "")) return reply("this plan says Delivery: no merge; publishing is not allowed. Nothing published.");
	const merged = await judgedMergeHead(fl, root);
	if ("error" in merged) return reply(merged.error);
	const read = await readMergedItems(fl, root, merged.head, packages);
	if ("error" in read) return reply(read.error);
	const names = (list: { name: string; version: string }[]) => list.map((i) => `${i.name}@${i.version}`).join(", ");
	const dry = await dryRunPublish(root, read.items);
	if ("error" in dry) return reply(`Checking ${names(read.items)} failed (${dry.error})\nNothing published.`);
	const split = classifyPublish(read.items, dry.result, await taggedOnOrigin(fl, root, read.items));
	if (split.notPublishable.length) return reply(`${split.notPublishable.join(", ")}: superseded or not on origin/main; nothing published. Stop and explain to the user.`);
	if (!split.publish.length) {
		fl.wait.publishWaitSince.delete(step);
		return reply(`${names(read.items)} already on the registry. Tick ${step} with plan_check.`);
	}
	if (dry.result.blockedBy?.length) return wait(`waiting for ${dry.result.blockedBy.map((b) => b.tag).join(", ")} to be published`, blockedWaitCheck(root, split.publish));
	const run = await runNodeScript(root, "update-packages.mjs", publishArgs(split.publish, false));
	if (run.code === 0) fl.wait.publishWaitSince.delete(step);
	const skipped = split.alreadyPublished.length ? `Skipped, the registry already has: ${names(split.alreadyPublished)}.\n` : "";
	const next = run.code === 0 ? `Tick ${step} with plan_check.` : run.code === 3 ? "Blocked meanwhile; call publish_packages again." : "Nothing more was done; report the failure.";
	return reply(`${skipped}publish ${names(split.publish)} exit ${run.code}:\n${lastLines(`${run.stdout}\n${run.stderr}`)}\n${next}`);
}

/** The tag part of `deliver`: creates or moves a tag on the remote default branch, safely. A wait is returned for the caller to set. */
export async function deliverTag(fl: Flow, ctx: ExtensionContext, t: { name: string; commit?: string; move: boolean; repo?: string }, planned: boolean): Promise<{ text: string; ok: boolean; wait?: string }> {
	const fail = (text: string) => ({ text: `tag ${t.name}: ${text}`, ok: false });
	const refs = await flowRepos(fl, ctx);
	const want = t.repo?.trim();
	const ref = want ? refs.find((r) => r.root === want || path.basename(r.root) === want || repoKey(r.root) === repoKey(want)) : undefined;
	if (want && !ref) return fail(`no repo of this flow matches "${want}"`);
	const dir = ref?.dir ?? ctx.cwd;
	const remotes = (await git(fl, dir, "remote")).stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	const remote = remotes.includes("origin") ? "origin" : remotes[0];
	if (!remote) return fail("the repo has no remote");
	const sym = await git(fl, dir, "ls-remote", "--symref", remote, "HEAD");
	const head = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(sym.stdout);
	if (sym.code !== 0 || !head) return fail(`cannot read the default branch of ${remote}`);
	const branch = head[1];
	const fetched = await git(fl, dir, "fetch", remote, branch);
	if (fetched.code !== 0) return fail(`cannot fetch ${remote} ${branch}`);
	const remoteRef = `${remote}/${branch}`;
	const resolved = await git(fl, dir, "rev-parse", "--verify", "--quiet", `${t.commit?.trim() || remoteRef}^{commit}`);
	const target = resolved.stdout.trim();
	if (resolved.code !== 0 || !target) return fail(`cannot resolve ${t.commit?.trim() || remoteRef}`);
	const onDefault = (await git(fl, dir, "merge-base", "--is-ancestor", target, remoteRef)).code === 0;

	const listed = await git(fl, dir, "ls-remote", "--tags", remote, `refs/tags/${t.name}`, `refs/tags/${t.name}^{}`);
	if (listed.code !== 0) return fail(`cannot read the tags of ${remote}`);
	let tagObject: string | undefined;
	let peeled: string | undefined;
	for (const line of listed.stdout.split(/\r?\n/)) {
		const [sha, ref2] = line.trim().split(/\s+/);
		if (ref2 === `refs/tags/${t.name}`) tagObject = sha;
		else if (ref2 === `refs/tags/${t.name}^{}`) peeled = sha;
	}
	const remoteSha = peeled ?? tagObject;
	let oldIsAncestor: boolean | undefined;
	if (remoteSha && t.move) {
		if ((await git(fl, dir, "cat-file", "-e", `${remoteSha}^{commit}`)).code !== 0) {
			// A tag ref is always fetchable; a raw SHA only where the server allows it.
			const viaRef = await git(fl, dir, "fetch", remote, `+refs/tags/${t.name}:refs/tmp-deliver/${t.name}`);
			if (viaRef.code !== 0) await git(fl, dir, "fetch", remote, remoteSha);
			await git(fl, dir, "update-ref", "-d", `refs/tmp-deliver/${t.name}`);
		}
		oldIsAncestor = (await git(fl, dir, "merge-base", "--is-ancestor", remoteSha, target)).code === 0;
	}
	const d = tagDecision({ name: t.name, planned, move: t.move, remoteSha, target, onDefault, oldIsAncestor });
	if (d.action === "refuse") return { text: `tag ${t.name}: ${d.text}`, ok: d.ok === true };
	if (d.action === "wait") return { text: `tag ${t.name}: ${d.reason}`, ok: false, wait: d.reason };
	const lease = d.action === "move" ? (tagObject ?? d.lease) : undefined;
	const pushed = await fl.pi.exec("git", ["-C", dir, ...pushArgs(remote, t.name, target, lease)], { timeout: 120_000 });
	if (pushed.code !== 0) {
		const why = `tag ${t.name} was not pushed: ${(pushed.stderr || pushed.stdout).split(/\r?\n/).find((l) => l.trim())?.trim() ?? "git push failed"}`;
		return { text: why, ok: false, wait: why };
	}
	const synced = await git(fl, dir, "fetch", remote, `+refs/tags/${t.name}:refs/tags/${t.name}`);
	const note = synced.code === 0 ? "" : " (the local tag was not updated)";
	return { text: d.action === "move" ? `moved ${t.name} from ${(remoteSha as string).slice(0, 9)} to ${target.slice(0, 9)}${note}` : `tag ${t.name} created at ${target.slice(0, 9)}${note}`, ok: true };
}

export function registerTools(fl: Flow): void {
	fl.pi.registerTool({
		name: "wait_for_user",
		label: "Wait for user",
		description:
			"Pause the flow until a person has done something a later step needs (open the Unity Editor so the unity CLI can run). For a check only a person can do (play it in the Editor, look at visuals) use kind \"verify\": nothing pauses, the check is listed for the user after the flow. Optional `check` is a read-only command that exits 0 once it is done; the workflow runs it once at once, then every few minutes, and resumes you by itself. Then end your turn. With autopilot on, the tool tells you what to do instead of pausing, unless `manual: true`. Name the plan step as `step` when the plan has a `Wait:` step; otherwise the wait is added to the plan as an amendment.",
		promptSnippet: "wait_for_user: pause the flow until a person did something; resumes by check or by their reply",
		parameters: Type.Object({
			reason: Type.String({ description: "What the person must do, in one line" }),
			check: Type.Optional(Type.String({ description: "A read-only command that exits 0 once it is done, e.g. git ls-remote --exit-code --tags origin <tag>. It runs once at once, then every few minutes" })),
			step: Type.Optional(Type.String({ description: "The plan's Wait step, e.g. S7" })),
			kind: Type.Optional(Type.Union([Type.Literal("approve"), Type.Literal("act"), Type.Literal("verify"), Type.Literal("external")], { description: "approve: a person only reviews and agrees; act (default): a person must do something; verify: a person must test or look at the result; nothing waits, it is listed for them after the flow; external: nothing for a person; another package's PR, CI or a release; the check resumes it; needs a check" })),
			manual: Type.Optional(Type.Boolean({ description: "Pause even when autopilot is on" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
			const plan = fl.state.approvedPlan;
			if (fl.state.phase !== "execute" || !plan) return reply("wait_for_user works only while executing an approved plan. Nothing changed.");
			const reason = params.reason.trim();
			if (!reason) return reply("Give a reason: what the person must do. Nothing changed.");
			if (params.kind === "verify") {
				const vstep = params.step?.trim().toUpperCase() || undefined;
				if (!(vstep && parseVerifyStep(plan, vstep))) {
					fl.state.approvedPlan = `${plan.replace(/\s+$/, "")}\n\n${verifyAmendment(nextAmendmentNumber(fl), { steps: reason, step: vstep })}\n`;
					const item = vstep ? fl.state.checklist?.find((i) => i.id === vstep) : undefined;
					if (item && !isHuman(item)) item.done = true;
					refreshChecklist(fl);
				}
				persist(fl);
				updateStatus(fl, ctx);
				planMilestone(fl, ctx);
				return reply(`Recorded as a human check for after the flow: ${reason}. Don't wait; continue in this turn.`);
			}
			const check = cleanCheck(params.check);
			const kindProblem = waitKindProblem(params.kind, check);
			if (kindProblem) return reply(`${kindProblem}. Nothing changed.`);
			if (check) {
				const shape = waitCheckProblem(check);
				if (shape) return reply(`The check ${shape}. Nothing changed.`);
				const problem = readOnlyProblem(check);
				if (problem) return reply(`The check must be read-only (${problem}). Nothing changed.`);
			}
			if (check) {
				const first = await runWaitCheck(fl, check);
				if (first.status === "pass") return reply(`The check passes already: "${reason}" is done. Tick the step with plan_check and continue in this turn. Nothing to wait for.`);
				if (first.status === "broken") return reply(`The check can't run (${first.detail}). Fix the check (it runs in bash from ${ctx.cwd}) and call wait_for_user again. Nothing changed.`);
			}
			const step = params.step?.trim().toUpperCase() || undefined;
			const planned = !!step && !!parseWaitStep(plan, step);
			if (autopilotSkipsWait(autopilotOn(fl), params.manual, params.kind)) {
				const kind = params.kind === "approve" ? "approve" : "act";
				noteAuto(fl, `wait skipped: ${reason}`);
				fl.state.approvedPlan = `${plan.replace(/\s+$/, "")}\n\n${autopilotAmendment(nextAmendmentNumber(fl), { reason, step, kind })}\n`;
				refreshChecklist(fl);
				persist(fl);
				planMilestone(fl, ctx);
				return reply(autopilotReply(kind, reason, check));
			}
			if (!planned) {
				fl.state.approvedPlan = `${plan.replace(/\s+$/, "")}\n\n${waitAmendment(nextAmendmentNumber(fl), { reason, step, check })}\n`;
				refreshChecklist(fl);
			}
			setWaiting(fl, { reason, ...(check ? { check } : {}), ...(params.kind === "external" ? { waitKind: "external" as const } : {}), ...(step ? { step } : {}), stage: fl.state.stage, since: new Date().toISOString(), planned });
			persist(fl);
			updateStatus(fl, ctx);
			planMilestone(fl, ctx);
			startWaitTimer(fl);
			return reply(`Waiting for: ${reason}. End your turn now; the workflow resumes you when ${check ? "the check passes" : "the user replies"}.`);
		},
		renderCall(args, theme) {
			return new Text(`${title(fl, theme, "wait_for_user", "execute")}${theme.fg("accent", ` ${String(args.reason ?? "").slice(0, 80)}`)}`, 0, 0);
		},
	});

	fl.pi.registerTool({
		name: "publish_packages",
		label: "Publish packages",
		description:
			"Run a plan's `Publish:` or `Mirror:` step: publishes the unity-packages versions this flow merged (with the person's registry token, on this computer) or mirrors vendor packages. Pass the plan step ID. If an earlier version or a pinned package is not published yet, the flow waits and resumes by itself; then call this again with the same step. Never run updates.bat, update-packages.mjs publish, maintenance.mjs mirror --confirm, publish-package.mjs or npm publish yourself.",
		promptSnippet: "publish_packages: run the plan's Publish:/Mirror: step S<n>",
		parameters: Type.Object({ step: Type.String({ description: "The plan's Publish: or Mirror: step, e.g. S9" }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const reply = (text: string): ToolReply => ({ content: [{ type: "text" as const, text }], details: {} });
			const plan = fl.state.approvedPlan;
			if (fl.state.phase !== "execute" || !plan) return reply("publish_packages works only while executing an approved plan. Nothing published.");
			const step = params.step.trim().toUpperCase();
			const pub = parsePublishStep(plan, step);
			const mir = pub ? null : parseMirrorStep(plan, step);
			if (!pub && !mir) return reply(`Step ${step} is not a \`Publish: <package>\` or \`Mirror: <folder>|all\` step of the approved plan (packages only, no versions). Nothing published.`);
			if (fl.state.checklist?.find((i) => i.id === step)?.done) return reply(`Step ${step} is already ticked. Nothing published.`);
			const repo = (await flowRepos(fl, ctx)).find((r) => fs.existsSync(path.join(r.root, "scripts", "update-packages.mjs")));
			if (!repo) return reply("No repo of this flow has scripts/update-packages.mjs (add the unity-packages folder to the flow). Nothing published.");
			const root = repo.root;
			const wait = (why: string, check: string): ToolReply => {
				const since = waitSince(fl.wait.publishWaitSince.get(step), new Date().toISOString());
				fl.wait.publishWaitSince.set(step, since);
				setWaiting(fl, { reason: why, check, step, stage: fl.state.stage, since, planned: true, held: `Call publish_packages again with step ${step}.` });
				persist(fl);
				updateStatus(fl, ctx);
				planMilestone(fl, ctx);
				startWaitTimer(fl, Date.parse(since));
				return reply(`Waiting: ${why}. End your turn now; the workflow resumes you when the check passes. Then call publish_packages again with step ${step}.`);
			};
			const lockFile = await publishLockFile(fl, root);
			const lock = await takePublishLock(fl, lockFile);
			if (lock === "held") return wait("another session is publishing", lockWaitCheck(lockFile));
			try {
				if (mir) {
					const r = await runNodeScript(root, "maintenance.mjs", mirrorArgs(mir));
					if (r.code === 0) fl.wait.publishWaitSince.delete(step);
					return reply(`mirror ${mir.target} exit ${r.code}:\n${lastLines(`${r.stdout}\n${r.stderr}`)}\n${r.code === 0 ? `Tick ${step} with plan_check.` : "Nothing more was done; report the failure."}`);
				}
				return await runPublish(fl, root, step, pub!.packages, reply, wait);
			} finally {
				lock.release();
			}
		},
		renderCall(args, theme) {
			return new Text(`${title(fl, theme, "publish_packages", "execute")}${theme.fg("accent", ` ${String(args.step ?? "")}`)}`, 0, 0);
		},
	});

	fl.pi.registerTool({
		name: "git_task",
		label: "Git task",
		description:
			"Delegate messy git work (merge conflicts, rebases, a long sequence of split commits) to a cheaper model and get its report back in the same turn. Plain commits, pushes and pull requests are faster in bash with git and gh. It runs under the same guard as you: a merge or a push to a protected branch is refused until the exact tree has passed judge in a flow; in normal mode (no flow) there is no judge gate. Give the exact task (repo, branch, commit messages, base). If it fails, do the work yourself.",
		promptSnippet: "git_task: delegate messy git work (conflicts, rebases, long split-commit sequences) to a cheap model; plain commit/push/PR go through bash",
		parameters: Type.Object({
			task: Type.String({ description: "What to do, e.g. 'commit the staged changes as \"feat: x\", push the branch, open a PR against main'" }),
			repo: Type.Optional(Type.String({ description: "Folder of the repo to work in; default the working folder" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const reply = (text: string, details: object = {}) => ({ content: [{ type: "text" as const, text }], details });
			const allowed = gitTaskAllowed(fl.state.phase, !!fl.state.approvedPlan);
			if (!allowed.ok) return reply("git_task works only in normal mode or while executing an approved plan. Nothing changed.");
			if (!fs.existsSync(GIT_GUARD_EXTENSION)) return reply(`git_task failed: git guard extension not found at ${GIT_GUARD_EXTENSION}`);
			const repos = await flowRepos(fl, ctx);
			const cwd = params.repo ? path.resolve(ctx.cwd, params.repo) : ctx.cwd;
			if (!fs.existsSync(cwd)) return reply(`git_task failed: ${cwd} does not exist.`);
			const multi = (fl.state.folders?.length ?? 0) > 0 || (fl.state.touchedRepos?.length ?? 0) > 0;
			const spec: GitGuardSpec = {
				roots: multi ? repos.map((r) => r.root) : [],
				protectedBranches: fl.cfg.protectedBranches,
				passedTrees: fl.state.passedTrees ?? {},
				noMerge: noMerge(fl.state.approvedPlan ?? ""),
				...(allowed.ungated ? { ungated: true } : (() => { const mf = midFlowMergeRefusal(fl); return mf ? { midFlow: mf } : {}; })()),
			};
			const task = [
				params.task.trim(),
				"",
				"Rules:",
				`- Work only in ${multi ? repos.map((r) => r.root).join(", ") : cwd}.`,
				"- Never force-push, use --no-verify, --admin or --auto.",
				"- Chain dependent steps with &&.",
				"- Stop at the first failure and report the command and its error.",
				"- Report each commit subject, branch and pull request URL.",
			].join("\n");
			const repoList = repos.length ? repos : [{ root: cwd, dir: cwd, changed: false }];
			// A merge with --delete-branch leaves the checkout on the default branch, so the branch is read first.
			const branchBefore = new Map<string, string>();
			const headBefore = new Map<string, string>();
			const remoteBefore = new Map<string, boolean>();
			for (const r of repoList) {
				branchBefore.set(r.root, (await git(fl, r.dir, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim());
				headBefore.set(r.root, (await git(fl, r.dir, "rev-parse", "HEAD")).stdout.trim());
				remoteBefore.set(r.root, !!(await git(fl, r.dir, "branch", "-r", "--contains", "HEAD")).stdout.trim());
			}
			const progress = toolProgress(onUpdate);
			const prevStage = fl.view.stage;
			fl.view.stage = "commit";
			let text: string;
			try {
				ctx.ui.setWorkingMessage("git_task running…");
				const ran = await runRole(fl,
					"commit",
					"git task",
					{ systemPrompts: [prompts.COMMIT], tools: ["bash", "read"], task, cwd, signal, env: { [GIT_GUARD_ENV]: JSON.stringify(spec) }, extensions: [GIT_GUARD_EXTENSION] },
					progress.track,
				);
				if (ran.result.ok) fl.view.finish(ran.run, true, "report ready");
				text = ran.result.ok ? ran.result.text : `git_task failed: ${ran.result.error}`;
			} catch (e) {
				text = `git_task failed: ${e instanceof Error ? e.message : String(e)}`;
			} finally {
				fl.view.stage = prevStage;
				ctx.ui.setWorkingMessage();
			}
			const lines: string[] = [];
			for (const r of repoList) {
				const key = repoKey(r.root);
				const branch = (await git(fl, r.dir, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
				const base = fl.state.reviewBase?.[key];
				const n = base ? (await git(fl, r.dir, "rev-list", "--count", `${base}..HEAD`)).stdout.trim() : "?";
				const rec = await recordJudged(defaultRunner, r.dir, { startBranch: branchBefore.get(r.root) ?? "", headBefore: headBefore.get(r.root), remoteBefore: remoteBefore.get(r.root), report: text, passed: fl.state.passedTrees?.[key] ?? [], protectedBranches: fl.cfg.protectedBranches });
				const pr = rec.pr;
				const existing = fl.state.judgedMerges?.[key];
				if (rec.entry && !(rec.entry.commit && existing?.pr && existing.stage === fl.state.stage)) {
					fl.state.judgedMerges = { ...(fl.state.judgedMerges ?? {}), [key]: { ...rec.entry, ...(fl.state.stage ? { stage: fl.state.stage } : {}) } };
					persist(fl);
				}
				lines.push(`${path.basename(r.root)}: branch ${branch}, ${n} commits since review base, ${pr}`);
			}
			return reply(`${text}\n\n${lines.join("\n")}`, { runs: progress.snapshot() });
		},
		renderCall(args, theme) {
			return new Text(`${title(fl, theme, "git_task", "commit")}${theme.fg("accent", ` ${String(args.task ?? "").slice(0, 80)}`)}`, 0, 0);
		},
	});

	fl.pi.registerTool({
		name: "plan_check",
		label: "Plan check",
		description: "Tick the plan's steps you finished (their IDs, e.g. S3), or untick ones with `undone`. Keeps the checklist in step with your work; the judge still checks the diff.",
		promptSnippet: "plan_check: tick finished plan steps by ID (S1, S2, ...)",
		parameters: Type.Object({
			done: Type.Array(Type.String({ description: "Step ID, e.g. S3" }), { description: "Steps you finished" }),
			undone: Type.Optional(Type.Array(Type.String({ description: "Step ID, e.g. S3" }), { description: "Steps to untick again" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const list = fl.state.checklist;
			const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
			if (fl.state.phase !== "execute" || !list?.length) return reply("No plan checklist is active (it exists only while executing a plan whose steps are numbered S1, S2, ...). Nothing changed.");
			const norm = (ids: string[] | undefined) => (ids ?? []).map((s) => s.trim().toUpperCase());
			const unknown: string[] = [];
			for (const [ids, value] of [[norm(params.done), true], [norm(params.undone), false]] as const) {
				for (const id of ids) {
					const item = list.find((i) => i.id === id);
					if (item) item.done = value;
					else unknown.push(id);
				}
			}
			persist(fl);
			updateStatus(fl, ctx);
			rewritePlanFile(fl);
			const staged = currentStages(fl);
			const open = list.filter((i) => !isHuman(i) && !i.done && (!staged || i.stage === undefined || i.stage === staged.current));
			const done = list.filter((i) => !isHuman(i) && i.done).length;
			const head = `${done} of ${list.filter((i) => !isHuman(i)).length} steps done${unknown.length ? `; unknown IDs: ${unknown.join(", ")}` : ""}.`;
			const rest = open.length ? `Open${staged ? ` in stage ${staged.current}` : ""}:\n${open.map((i) => `- ${i.id} ${i.text}${deliverLine(fl, i.id, staged?.current)}`).join("\n")}` : `No open steps${staged ? " in this stage" : ""}.`;
			return reply(`${head}\n${rest}`);
		},
		renderCall(args, theme) {
			const ids = [...((args.done ?? []) as string[]), ...((args.undone ?? []) as string[]).map((s) => `-${s}`)];
			return new Text(`${title(fl, theme, "plan_check", "execute")}${theme.fg("accent", ` ${ids.join(", ")}`)}`, 0, 0);
		},
	});

	fl.pi.registerTool({
		name: "request_merge",
		label: "Request merge",
		description:
			"Ask to merge the pull request before the end of the flow, only when a later step cannot run until the change is on the default branch. An arbiter decides; when it cannot, the user is asked. A merge that is not planned (a `Deliver: merge` step) or approved this way is refused by the merge gate.",
		promptSnippet: "request_merge: ask to merge before the end of the flow (arbiter, then the user)",
		parameters: Type.Object({
			reason: Type.String({ description: "Which later step needs the change on the default branch, and why" }),
			repos: Type.Optional(Type.Array(Type.String(), { description: "The repos concerned, by folder" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
			if (fl.state.phase !== "execute") return reply("request_merge works only while a plan executes. Nothing changed.");
			if (noMerge(fl.state.approvedPlan ?? "")) return reply("No merge: this plan says Delivery: no merge.");
			const reason = String(params.reason ?? "").replace(/\s+/g, " ").trim();
			if (!reason) return reply("Give the reason: which later step needs the change merged now.");
			const allowedText = (why: string) => `Merge allowed: ${why}. Run judge if the tree changed since the last pass, merge with gh pr merge as its own command, then continue on a new branch from the updated default branch.`;
			const refusedText = (why: string) => `No merge: ${why}. Keep committing and pushing to the branch and continue the plan.`;
			if (midFlowMergeRefusal(fl) === null) return reply(allowedText("the gate already allows a merge here (the end of the flow, a planned Deliver: merge step or an earlier approval)"));
			const staged = currentStages(fl);
			const stage = staged?.current ?? 0;
			const mine = mergeDecisions(fl.state.approvedPlan).filter((d) => d.stage === 0 || d.stage === stage);
			const userNo = mine.find((d) => !d.allowed && d.by === "user");
			if (userNo) return reply(refusedText(`the user refused a merge here: ${userNo.reason}`));
			const arbiterNo = mine.some((d) => !d.allowed && d.by === "arbiter");
			let decided: ReturnType<typeof parseMergeArbiter> = null;
			if (!arbiterNo) {
				ctx.ui.setWorkingMessage("arbiter checking the merge request…");
				try {
					const repoLines: string[] = [];
					for (const r of await flowRepos(fl, ctx)) {
						const status = (await git(fl, r.dir, "status", "--short")).stdout.trim();
						const log = (await git(fl, r.dir, "log", "--oneline", "-20")).stdout.trim();
						repoLines.push(`### ${r.root}\n${status || "(clean)"}\n${log}`);
					}
					const openIds = gateOpenSteps(fl.state.approvedPlan ?? "", fl.state.checklist, staged ? { current: staged.current, total: staged.stages.length } : undefined);
					const open = (fl.state.checklist ?? []).filter((i) => openIds.includes(i.id));
					const position = staged ? `Stage ${staged.current} of ${staged.stages.length}: ${staged.stages[staged.current - 1].title}` : "No stages";
					const { result, run } = await runRole(fl, "arbiter", "merge", {
						systemPrompts: [
							prompts.MERGE_ARBITER,
							`## Approved plan\n\n${planForJudge(fl)}`,
							`## Position\n\n${position}\nOpen steps: ${open.map((i) => `${i.id} ${i.text}`).join("; ") || "none"}`,
							`## Repos\n\n${repoLines.join("\n\n") || "(none)"}`,
							`## Executor's reason\n\n${reason}`,
						],
						tools: fl.cfg.arbiter.tools,
						task: "Decide on the merge request in your system prompt.",
						cwd: ctx.cwd,
					});
					if (!result.ok) ctx.ui.notify(`workflow: merge arbiter failed: ${result.error}`, "error");
					else {
						decided = parseMergeArbiter(result.text);
						fl.view.finish(run, true, decided?.decision ?? "no decision");
					}
				} catch (e) {
					ctx.ui.notify(`workflow: merge arbiter failed: ${String(e)}`, "error");
				} finally {
					ctx.ui.setWorkingMessage();
				}
			}
			if (decided && decided.decision !== "ASK_USER") {
				const allowed = decided.decision === "MERGE";
				const why = decided.reason || reason;
				recordMergeDecision(fl, ctx, "arbiter", allowed, why);
				return reply(allowed ? allowedText(why) : refusedText(why));
			}
			if (!ctx.hasUI) return reply("No merge: nobody to ask. Continue without merging; the pull request is merged at the end of the flow.");
			const seen = decided ? decided.reason : arbiterNo ? "The arbiter already refused a merge in this stage." : "The arbiter gave no decision.";
			fl.pi.sendMessage({ customType: "workflow-judge", content: `**Merge request before the end of the flow**\n\nThe executor's reason: ${reason}\n\nThe arbiter's view: ${seen || "it hands the decision to you"}`, display: true }, { triggerTurn: false });
			let answer: string | undefined;
			try {
				answer = await askUser(fl, ctx, `Merge before the end of the flow? ${reason}`, ["Allow the merge", "Don't merge"]);
			} catch {}
			const allowed = answer === "Allow the merge";
			recordMergeDecision(fl, ctx, "user", allowed, reason);
			return reply(allowed ? allowedText(`you allowed it: ${reason}`) : refusedText("the user did not allow it"));
		},
		renderCall(args, theme) {
			return new Text(`${title(fl, theme, "request_merge", "execute")}${theme.fg("accent", ` ${String(args.reason ?? "").slice(0, 80)}`)}`, 0, 0);
		},
	});

	// The judge tool is the agents extension's; while a flow is on the workflow takes its calls over with
	// its own review (review base, rounds, gates). Errors the review throws reject the claim.
	fl.pi.events.on("agents:judge-call", (payload) =>
		claimJudgeCall(fl.state.phase, payload, async (params: JudgeParams, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) => {
			const baseNote = params.base ? undefined : await refreshReviewBase(fl, ctx);
			const diff = await collectFlowDiff(fl, ctx, params.base || undefined);
			if (!diff) throw new Error("no git work tree in this flow (working folder, /folders, or repos edited this flow); the judge reviews git diffs");
			if (fl.state.phase === "execute" && currentStages(fl)) {
				fl.state.stageJudged = true;
				persist(fl);
			}
			if (!diff.text) return { content: [{ type: "text", text: "No changes to review." }], details: undefined };
			const progress = toolProgress(onUpdate);
			const r = await judge(fl, ctx, diff, [params.focus, baseNote].filter(Boolean).join("\n") || undefined, signal, progress.track, params.full === true, params.disputes);
			if (r.verdict === "ERROR") throw new Error(r.text);
			if (r.verdict === "FAIL") fl.state.judgeRounds++;
			let text = r.text;
			const flawed = planFlaws(r.findings).length > 0;
			if (r.verdict === "PASS" && fl.state.phase === "execute" && !flawed && !noMerge(fl.state.approvedPlan ?? "") && (await flowHasRemote(fl, ctx))) {
				text += mergeDue(fl)
					? "\n\nTick any finished steps not ticked yet with plan_check. Now deliver this exact tree: commit, push, open or update the pull request and merge it with gh pr merge (as its own command), then end your turn."
					: "\n\nNow commit and push this exact tree to the flow branch (no merge: the pull request is merged at the end of the flow), tick any finished steps not ticked yet with plan_check, then end your turn.";
			}
			if (r.verdict === "PASS") {
				const knowledge = fl.state.lastKnowledge?.hash === diff.hash ? fl.state.lastKnowledge : undefined;
				const block = knowledge ? deviationBlock(knowledge.deviations) : "";
				if (block) text += `\n\nEnd the pull request body (or the last commit message if there is no pull request) with this block, unchanged:\n\n${block}`;
				if (fl.state.lateFindings?.length) text += `\n\nAdd a "Late findings (not fixed)" section to the pull request body (or the last commit message) listing:\n${fl.state.lateFindings.map((l) => `- ${l}`).join("\n")}`;
			}
			const reminder = fl.state.phase === "execute" ? openStepsReminder(fl.state.checklist, currentStages(fl)?.current) : undefined;
			if (reminder) text += `\n\n${reminder}${fl.state.phase === "execute" ? deliverHintsText(fl, currentStages(fl)?.current) : ""}`;
			// Every call replaces the pending report, so a stale one never outlives a clean review.
			fl.state.pendingPlanFlaw = flawed ? r.text : undefined;
			if (fl.state.pendingPlanFlaw) {
				text += "\n\nThis review questions the plan. Do not change the plan's design yourself: end your turn now; the workflow resolves it.";
			}
			persist(fl);
			return { content: [{ type: "text", text }], details: { runs: progress.snapshot(), verdict: r.verdict }, usage: r.usage };
		}),
	);

	fl.pi.registerTool({
		name: "deliver",
		label: "Deliver",
		description:
			"Create or move a tag on the remote default branch (`tag`), inside the plan, then carry on in the same turn. Commit, push, pull requests and merges are done with git and gh directly, not with this tool. Name the plan's `Deliver:` step as `step`; a call without one is added to the plan as an amendment. Tags are created or moved only for a named plan step or when you need them to continue; a move needs a plan step that names the tag and the word move.",
		promptSnippet: "deliver: create or move a tag inside the plan, then continue",
		parameters: Type.Object({
			tag: Type.Optional(
				Type.Object({
					name: Type.String({ description: "Tag name, e.g. unity-build/v1.0.8" }),
					commit: Type.Optional(Type.String({ description: "Commit to tag. Default: the tip of the remote default branch" })),
					move: Type.Optional(Type.Boolean({ description: "Move an existing tag forward (needs a plan step that names it)" })),
					repo: Type.Optional(Type.String({ description: "Repo root or folder name. Default: the working folder's repo" })),
				}),
			),
			step: Type.Optional(Type.String({ description: "The plan's Deliver step, e.g. S4" })),
			reason: Type.Optional(Type.String({ description: "Why, for an unplanned checkpoint (goes into the plan's amendment)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const reply = (text: string, details?: unknown) => ({ content: [{ type: "text" as const, text }], details });
			const plan = fl.state.approvedPlan;
			if (fl.state.phase !== "execute" || !plan) return reply("deliver works only while executing an approved plan. Nothing changed.");
			const tag = params.tag && params.tag.name?.trim() ? { ...params.tag, name: params.tag.name.trim(), move: params.tag.move === true } : undefined;
			if (!tag) return reply("Give a tag: deliver only creates or moves tags. Commit, push, pull requests and merges are done with git and gh. Nothing changed.");

			const step = params.step?.trim().toUpperCase() || undefined;
			const stepText = step ? parseDeliverStep(plan, step) : null;
			const planned = stepText !== null;
			if (!planned) {
				const reason = params.reason?.trim() || "needed to continue";
				const amend = { tag: tag.name, reason };
				if (!hasCheckpointAmendment(plan, amend)) {
					fl.state.approvedPlan = `${plan.replace(/\s+$/, "")}\n\n${checkpointAmendment(nextAmendmentNumber(fl), amend)}\n`;
					refreshChecklist(fl);
					planMilestone(fl, ctx);
					persist(fl);
				}
			}

			const t = await deliverTag(fl, ctx, tag, isPlannedTag(stepText, tag.name, tag.move));
			if (t.wait) {
				setWaiting(fl, { reason: t.wait, ...(planned && step ? { step } : {}), stage: fl.state.stage, since: new Date().toISOString(), planned });
			}
			fl.state.checkpoints = [...(fl.state.checkpoints ?? []), { ...(planned && step ? { step } : {}), stage: fl.state.stage, text: checkpointText(planned ? step : undefined, t.text), ok: t.ok }];
			persist(fl);
			updateStatus(fl, ctx);
			planMilestone(fl, ctx);
			if (t.wait) return reply(`${t.text}\n\nWaiting for: ${t.wait}. End your turn now; the workflow resumes you when the user replies.`);
			const branches: string[] = [];
			for (const ref of await flowRepos(fl, ctx)) {
				const b = (await git(fl, ref.dir, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
				if (b) branches.push(`${path.basename(ref.root)}: ${b}`);
			}
			return reply(`${t.text}${branches.length ? `\n\nCurrent branch: ${branches.join(", ")}` : ""}\n\nContinue with the next steps in this turn.`);
		},
		renderCall(args, theme) {
			return new Text(`${title(fl, theme, "deliver", "execute")}${theme.fg("accent", args.tag?.name ? ` tag ${args.tag.name}` : "")}`, 0, 0);
		},
		renderResult: (result, opts, theme) => renderRuns(result, opts, theme, 40),
	});
}
