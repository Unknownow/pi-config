// A scratch world for engine tests: a repo with a bare origin, a fake worktree extension (W1/W2), and the fake pi.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, parseConfig, type RelayConfig } from "../config.ts";
import { Engine, type EngineDeps } from "../engine.ts";
import { run } from "../sh.ts";
import type { Wt, WtCreateReply } from "../types.ts";
import { cleanup, git, makeRepo, tmpDir } from "./helpers.ts";

export const FAKE_PI = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-pi.mjs");

export const fwd = (p: string) => p.split("\\").join("/");

export interface World {
	repo: string;
	bare: string;
	sets: string;
	jobRoot: string;
	script: string;
	wtCalls: { create: any[]; remove: any[]; addRepo: any[]; refuse: number };
	wakes: string[];
	notices: string[];
	events: { name: string; payload: any }[];
	wt: Wt;
	cfg: RelayConfig;
	engine: Engine;
	/** Another engine on the same repo, set factory and sinks (a second lead). */
	mk(over?: Partial<EngineDeps>): Engine;
	calls(): any[];
	/** The RPC commands the fake worker received (prompt, steer, clear_queue, set_model, ...). */
	cmds(): any[];
	write(script: object): void;
	end(): void;
}

export function brief(over: { authority?: Partial<Record<string, string>>; verify?: string; extra?: string; target?: string; repo?: string } = {}): string {
	const a = { merge: "no", publish: "no", comments: "n/a", delete: "no", formats: "no", deps: "no", ...over.authority };
	return `## Goal
Add a greeting file.

## Done when
- greeting.txt exists with the greeting

## Non-goals
- nothing else

## Constraints
- keep it small

## Decisions (locked)
- the file is greeting.txt

## Design
One new file.

## Scale
1 file.

## Verify
${over.verify ?? "node -e \"process.exit(0)\""}

## Targets
- ${over.repo ?? "REPO"}: ${over.target ?? "main"}

## Authority
${Object.entries(a).map(([k, v]) => `- ${k}: ${v}`).join("\n")}
${over.extra ?? ""}`;
}

export async function waitFor(cond: () => boolean, ms = 30_000, what = "condition"): Promise<void> {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

export function makeWt(sets: string, repo: string, wtCalls: { create: any[]; remove: any[]; addRepo: any[]; refuse: number }): Wt {
	return {
		async create(req) {
			wtCalls.create.push(req);
			const tops = Object.keys(req.bases);
			const wtDir = path.join(sets, req.name);
			const repos: { top: string; cwd: string }[] = [];
			for (const top of tops) {
				const sub = tops.length > 1 ? path.join(wtDir, path.basename(top)) : wtDir;
				fs.mkdirSync(path.dirname(sub), { recursive: true });
				const r = await run("git", ["worktree", "add", "-q", "-b", `wt/${req.name}`, sub, req.bases[top]], top);
				if (r.code !== 0) return { error: r.stderr };
				git(sub, "config", "core.autocrlf", "false");
				repos.push({ top: fwd(top), cwd: fwd(sub) });
			}
			const reply: WtCreateReply = { name: req.name, branch: `wt/${req.name}`, cwd: fwd(wtDir), setRoot: fwd(wtDir), launched: false, text: "created, not launched", repos };
			return reply;
		},
		async remove(req) {
			wtCalls.remove.push(req);
			// a test can make the next W2 calls refuse, as a set in use would
			if (wtCalls.refuse > 0) {
				wtCalls.refuse--;
				return { error: "in use by this session" };
			}
			const wtDir = path.join(sets, req.name);
			if (!fs.existsSync(wtDir)) return { error: "unknown set" };
			const gitDir = fs.existsSync(path.join(wtDir, ".git")) ? wtDir : undefined;
			if (gitDir) git(repo, "worktree", "remove", "--force", wtDir);
			fs.rmSync(wtDir, { recursive: true, force: true });
			return { removed: true, paths: [wtDir], backups: [], kept: [], warnings: [] };
		},
		async addRepo(req) {
			wtCalls.addRepo.push(req);
			const dest = path.join(sets, `${req.name}-${path.basename(req.folder)}`);
			const r = await run("git", ["worktree", "add", "-q", "-b", `wt/${req.name}-${path.basename(req.folder)}`, dest, req.base ?? "HEAD"], req.folder);
			if (r.code !== 0) return { error: r.stderr };
			git(dest, "config", "core.autocrlf", "false");
			return { path: fwd(dest), branch: `wt/${req.name}` };
		},
	};
}

export function world(cfgRaw: object = {}, files?: Record<string, string>, over: Partial<EngineDeps> = {}): World {
	const { dir: repo, bare } = makeRepo(files ?? { "a.txt": "a\n", "package.json": "{}\n" }, true);
	const base = tmpDir("relay-w-");
	const sets = path.join(base, "sets");
	fs.mkdirSync(sets, { recursive: true });
	const script = path.join(base, "script.json");
	const jobRoot = path.join(repo, ".git", "pi", "relay");
	const wtCalls = { create: [] as any[], remove: [] as any[], addRepo: [] as any[], refuse: 0 };
	const wt = makeWt(sets, repo, wtCalls);
	const cfg = parseConfig({ stallMin: 10, ...cfgRaw }).config;
	const w: World = {
		repo: fwd(repo),
		bare,
		sets,
		jobRoot,
		script,
		wtCalls,
		wakes: [],
		notices: [],
		events: [],
		wt,
		cfg,
		engine: undefined as unknown as Engine,
		cmds: () => (fs.existsSync(`${script}.cmds.jsonl`) ? fs.readFileSync(`${script}.cmds.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
		mk: () => undefined as unknown as Engine,
		calls: () => (fs.existsSync(`${script}.calls.jsonl`) ? fs.readFileSync(`${script}.calls.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
		write: (s) => fs.writeFileSync(script, JSON.stringify(s)),
		end: () => {
			void w.engine.shutdown();
			cleanup(repo, bare, base);
		},
	};
	process.env.RELAY_PI_BIN = FAKE_PI;
	process.env.FAKE_PI_SCRIPT = script;
	const deps = (): EngineDeps => ({
		cfg: () => w.cfg,
		run,
		root: jobRoot,
		me: { pid: process.pid, sessionId: "test-lead", host: "h" },
		wt,
		notify: (l) => w.notices.push(l),
		wake: (t) => w.wakes.push(t),
		emit: (name, payload) => w.events.push({ name, payload }),
		leadCwd: repo,
		folders: () => [],
		pollMs: 40,
		heartbeatMs: 100_000,
		...over,
	});
	w.mk = (o = {}) => new Engine({ ...deps(), ...o });
	w.engine = w.mk();
	w.engine.start();
	return w;
}

export { DEFAULTS };
