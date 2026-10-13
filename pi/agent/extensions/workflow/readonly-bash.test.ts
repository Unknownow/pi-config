// node --test readonly-bash.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommands, readOnlyProblem } from "./readonly-bash.ts";

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
	const cmds = parseCommands(`X=1; echo "a $(git log -1) b" 'c d' | grep -c x\ncat <<EOF\nrm -rf /\nEOF\nls`);
	assert.deepEqual(
		cmds.map((c) => c.words.join(" ")),
		["git log -1", "echo a $(...) b c d", "grep -c x", "cat", "ls"],
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
