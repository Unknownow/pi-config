// node --test readonly-bash.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { commandReadOnlyProblem, parseCommands, readOnlyProblem, unwrapCommand } from "./readonly-bash.ts";

test("commandReadOnlyProblem checks one parsed command", () => {
	assert.ok(commandReadOnlyProblem(parseCommands("git push")[0]));
	assert.equal(commandReadOnlyProblem(parseCommands("git status")[0]), null);
});

const reads = [
	"ls -la && cat README.md | head -20",
	"git status -sb | head -15; git log --oneline -8 origin/main",
	"git fetch -q --prune && git rev-list --left-right --count origin/main...HEAD",
	"git branch -vv --format='%(refname:short) %(upstream:track)'",
	"git tag --sort=-creatordate | head -3",
	"git diff --stat v0.3.1 origin/main -- extensions tools",
	"git -C /d/projects/knowledge log -1 --format='%h %cs' $(git describe --tags --abbrev=0)",
	'GH="/c/Program Files/GitHub CLI/gh.exe"; "$GH" pr list --state open --json number,title',
	'for r in a b; do cd /d/projects/$r; echo "$r: $(git branch --show-current)"; done',
	"gh issue view 42 --json body -q .body | grep -c '\- \[ \]'",
	"gh api repos/iecgames/x/contents/.pi/settings.json -q .content 2>/dev/null | base64 -d",
	"gh pr checks 29 --watch --interval 15 2>&1 | sort -u",
	"grep -rn foo src >/dev/null 2>&1 || echo none",
	"find . -name '*.ts' -not -path './node_modules/*' | wc -l",
	"sed -n 1,30p index.ts",
	"timeout 20 git status",
	"node --version",
	"cat <<'EOF2'\nrm -rf / > x\nEOF2\n",
	"curl -sL https://example.com | head",
	"npm view lodash version",
	"echo $((1 + 2)) >&2",
	"if grep -q x f; then echo yes; fi",
];

const writes: [string, RegExp][] = [
	["echo hi > out.txt", /writes to out.txt/],
	["cat a >> b.md", /writes to b.md/],
	["ls 2> err.log", /writes to err.log/],
	["rm -rf build", /not on the read-only list/],
	["git commit -qam msg", /git commit/],
	["git checkout -q -b feature", /git checkout/],
	["git push -q origin v1.0", /git push/],
	["git tag v0.4.0", /git tag/],
	["git branch -D old", /git branch/],
	["git branch newname", /git branch/],
	["git config user.name x", /git config/],
	['GH="/c/Program Files/GitHub CLI/gh.exe"; "$GH" pr merge 49 --merge', /gh pr merge/],
	["gh issue close 42 --comment done", /gh issue close/],
	["gh issue edit 35 --body-file b.md", /gh issue edit/],
	["gh api -X PATCH repos/a/b", /PATCH/],
	["gh api repos/a/b/issues -f title=x", /POST/],
	["sed -i 's/a/b/' f.txt", /in place/],
	["node -e 'require(\"fs\").writeFileSync(\"x\",\"y\")'", /runs a script/],
	["node - <<'EOF2'\nconsole.log(1)\nEOF2", /runs a script/],
	["echo $(touch x)", /touch/],
	["echo `rm x`", /rm/],
	["git status && git add -A", /git add/],
	["find . -name '*.bak' -delete", /deletes/],
	["xargs rm < list.txt", /rm/],
	["bash -c 'git push'", /git push/],
	["curl -o file https://x", /writes a file/],
	["curl -X POST https://x", /POST/],
	["npm install", /npm install/],
	["cat x | tee y", /tee/],
	["unity cmd editor_status --project-path unity", /read-only list/],
];

for (const cmd of reads) {
	test(`reads: ${cmd.split("\n")[0]}`, () => assert.equal(readOnlyProblem(cmd), null));
}

for (const [cmd, why] of writes) {
	test(`blocks: ${cmd.split("\n")[0]}`, () => assert.match(readOnlyProblem(cmd) ?? "allowed", why));
}

test("planBashAllow patterns let extra commands through", () => {
	const allow = [/^unity (cmd )?(editor_status|console_status)\b/];
	assert.equal(readOnlyProblem("unity cmd editor_status --project-path unity", allow), null);
	assert.match(readOnlyProblem("unity cmd build", allow) ?? "allowed", /read-only list/);
});

test("parser: quotes, substitutions and heredoc bodies", () => {
	// X=1 on its own is kept (env ["X"], no words) so risky assignments can be refused.
	const cmds = parseCommands(`X=1; echo "a $(git log -1) b" 'c d' | grep -c x\ncat <<EOF\nrm -rf /\nEOF\nls`);
	assert.deepEqual(
		cmds.map((c) => c.words.join(" ")),
		["", "git log -1", "echo a $(...) b c d", "grep -c x", "cat", "ls"],
	);
});

// Judge round 1 findings.
const BS = String.fromCharCode(92);
const moreReads = [
	`timeout 20 ${BS}
git status`,
	`gh ${BS}
pr list`,
	"git tag --contains HEAD",
	"git tag --points-at HEAD",
	"git fetch origin main",
	"gh api -X GET search/issues -f q=repo:a/b",
	"gh api graphql -f query='{ viewer { login } }'",
	"curl -XGET https://x",
	"curl -sSL https://x",
	"curl -H 'Accept: text/plain' https://x",
	"yq '.a' f.yaml",
	"sort -u f.txt",
	"uniq -c f.txt",
	"sed -n 1,5p f.txt",
];
const moreWrites: [string, RegExp][] = [
	["yq -i '.a=1' f.yaml", /in place/],
	["yq --inplace '.a=1' f.yaml", /in place/],
	["yq -Pi '.a=1' f.yaml", /in place/],
	["curl --json '{}' https://x", /sends data/],
	["curl -D headers.txt https://x", /writes a file/],
	["curl -c jar https://x", /writes a file/],
	["curl -o/tmp/x https://x", /writes a file/],
	["curl -sSLo out https://x", /writes a file/],
	["curl -XPOST https://x", /POST/],
	["git fetch origin main:main", /git fetch/],
	["git tag -d v1", /git tag/],
	["uniq in.txt out.txt", /second file/],
	["sort -uo out.txt in.txt", /writes a file/],
	["gh api graphql -f query='mutation { x }'", /mutation/],
	["gh api repos/a/b --input body.json", /request body/],
	[`cat <<${BS}EOF
x
EOF
rm -rf build`, /rm/],
	[`cat <<EOF
$(rm -rf build)
EOF`, /rm/],
];
const oneLine = (s: string) => s.split(String.fromCharCode(10)).join(" ");
for (const cmd of moreReads) test(`reads: ${oneLine(cmd)}`, () => assert.equal(readOnlyProblem(cmd), null));
for (const [cmd, why] of moreWrites) test(`blocks: ${oneLine(cmd)}`, () => assert.match(readOnlyProblem(cmd) ?? "allowed", why));

test("quoted heredoc bodies are data", () => assert.equal(readOnlyProblem(`cat <<'EOF'
$(rm -rf build)
EOF`), null));

// Judge round 2 findings.
const round2Reads = [
	"git -c color.ui=always log -3",
	"git -c core.quotepath=false status",
	"git diff -O order.txt",
	"sed -n '/where/p' f.txt",
	"sed -n 's/a/b/gp' f.txt",
	"tree -L 2",
	"xxd f.bin | head",
	"echo $(( 1 + 2 ))",
];
const round2Writes: [string, RegExp][] = [
	["git diff --output=patch.txt", /writes a file/],
	["git log --output patch.txt", /writes a file/],
	["git -c core.fsmonitor=evil status", /core.fsmonitor/],
	["git -c diff.external=evil diff", /diff.external/],
	["git fetch --upload-pack=evil origin", /runs a command/],
	["git grep -O foo", /runs a command/],
	["gh api graphql -F query=@mutation.graphql", /from a file/],
	["echo $(( $(rm -rf build) + 1 ))", /rm/],
	["curl --etag-save e.txt https://x", /writes a file/],
	["curl -Q 'DELE x' ftp://x", /sends data/],
	["sed -n '1w out.txt' f.txt", /sed w/],
	["sed 's/a/b/w out.txt' f.txt", /sed w/],
	["sed -e '1e rm x' f.txt", /sed w/],
	["tree -o out.txt", /writes a file/],
	["xxd -r in.hex out.bin", /second file/],
];
for (const cmd of round2Reads) test(`reads: ${cmd}`, () => assert.equal(readOnlyProblem(cmd), null));
for (const [cmd, why] of round2Writes) test(`blocks: ${cmd}`, () => assert.match(readOnlyProblem(cmd) ?? "allowed", why));

// Judge round 3 findings.
const round3Reads = [
	"command -v rg",
	"xxd -l 64 f.bin",
	"xxd -s 0x100 f.bin",
	"uniq -f 1 f.txt",
	"uniq -w 5 f.txt",
	"X=1; echo $X",
	"export FOO=1",
	"sed -n '/where/p' f.txt",
	"sed -n '/class/p' f.txt",
	"sed -n 1,5p f.txt",
	"echo $((1 + (2 * 3)))",
];
const round3Writes: [string, RegExp][] = [
	["echo $((rm -rf build) )", /rm/],
	["echo $((rm x); rm -rf y)", /rm/],
	["GIT_EXTERNAL_DIFF=evil git diff", /GIT_EXTERNAL_DIFF/],
	["GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=evil git status", /GIT_CONFIG_COUNT/],
	["env GIT_SSH_COMMAND=evil git fetch", /GIT_SSH_COMMAND/],
	["export GIT_PAGER=evil", /GIT_PAGER/],
	["PAGER=evil git log", /PAGER/],
	["X=evil git --config-env=core.fsmonitor=X status", /core.fsmonitor/],
	["sed 's/a/b/gw out' f.txt", /sed w/],
	["sed 's/x/y/ge' f.txt", /sed w/],
	["sed -n '1wout.txt' f.txt", /sed w/],
	["sed --expression='1w out' f.txt", /sed w/],
	["sed -e'1w out' f.txt", /sed w/],
	["sed --file=x f.txt", /script file/],
];
for (const cmd of round3Reads) test(`reads: ${cmd}`, () => assert.equal(readOnlyProblem(cmd), null));
for (const [cmd, why] of round3Writes) test(`blocks: ${cmd}`, () => assert.match(readOnlyProblem(cmd) ?? "allowed", why));

// Judge round 4 findings.
const round4Writes: [string, RegExp][] = [
	["sed -ne '1w out.txt' -e p f.txt", /sed w/],
	["cat x | uniq - out.txt", /second file/],
	["xxd - out.bin", /second file/],
	["sed --i 's/a/b/' f", /in place/],
	["sed --expr='1w x' f", /sed w/],
	["sort --out=x f", /writes a file/],
	["git diff --outp=x", /writes a file/],
];
for (const [cmd, why] of round4Writes) test(`blocks: ${cmd}`, () => assert.match(readOnlyProblem(cmd) ?? "allowed", why));
test("reads: cat x | uniq -", () => assert.equal(readOnlyProblem("cat x | uniq -"), null));
test("reads: git log --oneline", () => assert.equal(readOnlyProblem("git log --oneline -5"), null));

// git config: a key alone reads it; a key with a value, or unset/add flags, change it.
test("reads: git config key, git config --get key, git config --list", () => {
	assert.equal(readOnlyProblem("git config core.autocrlf"), null);
	assert.equal(readOnlyProblem("git config --get user.name"), null);
	assert.equal(readOnlyProblem("git config --list"), null);
});

test("blocks: git config key value, git config --unset key, git config --add key v", () => {
	assert.match(readOnlyProblem("git config user.name x") ?? "allowed", /git config/);
	assert.match(readOnlyProblem("git config --unset user.name") ?? "allowed", /git config/);
	assert.match(readOnlyProblem("git config --add a.b c") ?? "allowed", /git config/);
});

test("git config subcommands: list and get read, remove-section and edit change or open", () => {
	assert.equal(readOnlyProblem("git config list"), null);
	assert.equal(readOnlyProblem("git config get core.autocrlf"), null);
	assert.match(readOnlyProblem("git config remove-section user") ?? "allowed", /git config/);
	assert.match(readOnlyProblem("git config edit") ?? "allowed", /git config/);
});

const round5Reads = [
	"rg --pre-glob '*.gz' foo .",
	"rg -n foo src",
	"ag foo src",
	"less file",
	"date +%F",
	"date -d yesterday +%F",
	"hostname",
	"hostname -f",
	"git help -a",
	"git diff --stat",
	"git diff --no-ext-diff --no-textconv",
];
const round5Writes: [string, RegExp][] = [
	["rg --pre 'sh' foo .", /preprocessor/],
	["rg --pre=./x foo", /preprocessor/],
	["rg --hostname-bin=x foo", /preprocessor/],
	["ag --pager 'sh -c id' foo", /pager/],
	["less -o out.txt file", /log file/],
	["less -ofile file", /log file/],
	["less --log-file=out file", /log file/],
	["less '+!id' file", /log file/],
	["date -s 2020-01-01", /clock/],
	["date 010100002020", /clock/],
	["hostname foo", /hostname/],
	["hostname -F file", /hostname/],
	["git diff --ext-diff", /diff drivers/],
	["git log --textconv -p", /diff drivers/],
	["git help -w status", /viewer/],
	["git help status", /viewer/],
];
for (const cmd of round5Reads) test(`reads: ${cmd}`, () => assert.equal(readOnlyProblem(cmd), null));
for (const [cmd, why] of round5Writes) test(`blocks: ${cmd}`, () => assert.match(readOnlyProblem(cmd) ?? "allowed", why));

test("unwrapCommand", () => {
	const u = (s: string) => unwrapCommand(s.split(" ").filter(Boolean));
	assert.deepEqual(u("timeout 60 adb -s R58 reboot"), ["adb", "-s", "R58", "reboot"]);
	assert.deepEqual(u("env X=1 fastboot flash boot x"), ["fastboot", "flash", "boot", "x"]);
	assert.deepEqual(u("timeout -s KILL 5 git push"), ["git", "push"]);
	assert.deepEqual(u("if git status"), ["git", "status"]);
	assert.deepEqual(u("timeout 5 env A=1 adb devices"), ["adb", "devices"]);
	assert.deepEqual(u("command -v git"), []);
	assert.deepEqual(u("timeout 5"), []);
});
