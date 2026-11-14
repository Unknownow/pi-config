// Live end-to-end run of relay with real models (15-25 min, costs tokens):
//   node pi/agent/extensions/relay/e2e/live.mjs
//
// Scratch repo with a local bare origin -> temp relay.json (merge after-pass for the scratch repo, RELAY_CONFIG) ->
// `pi --mode rpc -ne -e relay -e worktree -e sandbox` in the scratch repo -> a short discussion, then "go" ->
// wait up to 30 min for the job to end -> assert report.md (Approvals, Done when), the change on the bare remote's main,
// the set removed. Prints the job id and "delivered"; exit 0 on success.
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "..", "..");
const model = process.env.RELAY_E2E_MODEL ?? "claude-bridge/claude-opus-5-5";
const limitMs = Number(process.env.RELAY_E2E_MINUTES ?? 30) * 60_000;
const fail = (m) => {
	console.error(`FAIL: ${m}`);
	process.exit(1);
};
const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@e2e", ...a], { cwd, encoding: "utf8" }).trim();
const fwd = (p) => p.split("\\").join("/");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2e-"));
const repo = path.join(base, "scratch");
const bare = path.join(base, "origin.git");
fs.mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "core.autocrlf", "false");
fs.writeFileSync(path.join(repo, "README.md"), "# scratch\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "init");
fs.mkdirSync(bare);
git(bare, "init", "-q", "--bare", "-b", "main");
git(repo, "remote", "add", "origin", bare);
git(repo, "push", "-q", "-u", "origin", "main");

const cfgFile = path.join(base, "relay.json");
const provider = process.env.RELAY_E2E_PROVIDER ?? path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-claude-bridge", "src", "index.ts");
fs.writeFileSync(cfgFile, JSON.stringify({ repos: { [fwd(repo)]: { merge: "after-pass" } }, caps: { critic: 2 }, worker: { extensions: [provider] }, reviewer: { extensions: [provider] } }));

const pi = spawn(process.env.RELAY_E2E_PI ?? "pi", ["--mode", "rpc", "-ne", "-a", "--model", model, "-e", provider, "-e", path.join(ext, "relay", "index.ts"), "-e", path.join(ext, "worktree", "index.ts"), "-e", path.join(ext, "sandbox", "index.ts")], {
	cwd: repo,
	env: { ...process.env, RELAY_CONFIG: cfgFile },
	stdio: ["pipe", "pipe", "inherit"],
	shell: process.platform === "win32",
});
let piExited = false;
pi.on("exit", (c) => {
	piExited = true;
	if (c !== 0 && c !== null) console.error(`pi exited with ${c}`);
});
pi.stdin.on("error", () => {});

// strict LF framing
let buf = Buffer.alloc(0);
let settled = 0;
pi.stdout.on("data", (d) => {
	buf = Buffer.concat([buf, d]);
	for (;;) {
		const i = buf.indexOf(0x0a);
		if (i < 0) break;
		const line = buf.subarray(0, i).toString("utf8").replace(/\r$/, "");
		buf = buf.subarray(i + 1);
		try {
			const ev = JSON.parse(line);
			if (ev.type === "agent_settled") settled++;
			if (ev.type === "extension_ui_request" && ev.id && ["select", "confirm", "input", "editor"].includes(ev.method)) pi.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: ev.id, cancelled: true })}\n`);
		} catch {
			// not a record
		}
	}
});
const send = (o) => pi.stdin.write(`${JSON.stringify(o)}\n`);
const waitSettled = async (n, ms) => {
	const t0 = Date.now();
	while (settled < n) {
		if (Date.now() - t0 > ms) fail("the lead did not settle");
		await new Promise((r) => setTimeout(r, 500));
	}
};

send({ type: "prompt", message: `We are working in the scratch repo ${fwd(repo)} (branch main, remote origin). The task: add a file greeting.txt at the repo root containing exactly one line, "hello". Settled: Design is one new file, no code. Scale: 1 file, one line. Verify: \`node -e "process.exit(require('fs').readFileSync('greeting.txt','utf8')==='hello\\n'?0:1)"\` run in the repo. Targets: ${fwd(repo)}: main. Authority: merge: yes (fast-forward to main after the judge passes); publish: no; comments: n/a; delete: no; formats: no; deps: no. Do not do anything yet; just confirm in one line.` });
await waitSettled(1, 10 * 60_000);
send({ type: "prompt", message: "go" });

const root = path.join(repo, ".git", "pi", "relay");
const t0 = Date.now();
let job;
for (;;) {
	if (Date.now() - t0 > limitMs) fail(`no job ended within ${limitMs / 60_000} min`);
	await new Promise((r) => setTimeout(r, 5000));
	if (!fs.existsSync(root)) continue;
	for (const d of fs.readdirSync(root)) {
		const f = path.join(root, d, "job.json");
		if (!/^r[0-9a-z]{6}$/.test(d) || !fs.existsSync(f)) continue;
		try {
			const j = JSON.parse(fs.readFileSync(f, "utf8"));
			if (["done", "stopped", "failed"].includes(j.state) && fs.existsSync(path.join(root, d, "report.md"))) job = { id: d, ...j };
		} catch {
			// being written
		}
	}
	if (job) break;
}
await new Promise((r) => setTimeout(r, 15_000)); // cleanup: the worker exits, the set is removed
send({ type: "abort" });
pi.stdin.end();
for (let i = 0; i < 40 && !piExited; i++) await new Promise((r) => setTimeout(r, 500));
if (!piExited) pi.kill();

if (job.state !== "done") fail(`job ${job.id} ended ${job.state}: ${job.endReason ?? ""}`);
const report = fs.readFileSync(path.join(root, job.id, "report.md"), "utf8");
if (!report.includes("## Approvals") || !report.includes("## Done when")) fail("report.md lacks Approvals or Done when");
const shown = git(bare, "show", "main:greeting.txt");
if (shown !== "hello") fail(`origin main greeting.txt is "${shown}"`);
const listed = git(repo, "worktree", "list");
if (listed.split("\n").length !== 1) fail(`the set was not removed:\n${listed}`);
console.log(`${job.id} delivered`);
try {
	fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
} catch (e) {
	console.error(`(left ${base}: ${e.code})`);
}
process.exit(0);
