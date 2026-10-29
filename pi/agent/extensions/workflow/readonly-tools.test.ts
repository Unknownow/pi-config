// node --test readonly-tools.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { PLAN_TOOLS, planToolProblem, planToolRefused } from "./readonly-tools.ts";

const allow: RegExp[] = [];
const check = (name: string, input: Record<string, unknown>) => planToolProblem(name, input, allow);

test("bash goes through the shell check", () => {
	assert.equal(check("bash", { command: "ls -la" }), null);
	assert.match(check("bash", { command: "touch x" }) ?? "", /not on the read-only list/);
});

test("run_code goes through the JavaScript check, with or without an MCP prefix", () => {
	assert.equal(check("run_code", { code: "console.log(1)" }), null);
	assert.equal(check("run_code", { code: "console.log(require('fs').readFileSync('a', 'utf8').split('\n').length)" }), null);
	assert.equal(check("run_code", { code: "process.stdout.write('x')" }), null);
	assert.match(check("run_code", { code: "require('fs').writeFileSync('x', 'y')" }) ?? "", /writes/);
	assert.match(check("mcp__sandbox__run_code", { code: "fs.rmSync('build', { recursive: true })" }) ?? "", /writes/);
	assert.match(check("run_code", { code: "fs.writeSync(1, 'x')" }) ?? "", /writes or opens/);
	assert.match(check("run_code", { code: "fs.openSync(p, 'w')" }) ?? "", /writes or opens/);
	assert.match(check("run_code", { code: "Bun.write('x', 'y')" }) ?? "", /writes files/);
	assert.match(check("run_code", { code: "require('child_process').execSync('ls')" }) ?? "", /other programs/);
	assert.match(check("run_code", { code: "eval(s)" }) ?? "", /runtime/);
	assert.match(check("run_code", { code: "fetch(u, { method: 'POST' })" }) ?? "", /changes data/);
});

test("fetch_url and other tools are not checked here", () => {
	assert.equal(check("fetch_url", { url: "https://example.com" }), null);
	assert.equal(check("read", { path: "a" }), null);
});

test("the allow list admits reading tools and refuses the rest", () => {
	const allowed = PLAN_TOOLS.map((p) => new RegExp(p));
	const blocked = ["edit", "write"];
	for (const name of ["read", "bash", "run_code", "fetch_url", "video_frames", "mcp__knowledge__get_entry", "mcp__knowledge__search"]) {
		assert.equal(planToolRefused(name, allowed, blocked), null, name);
	}
	for (const name of ["AskClaude", "mcp__knowledge__propose_entry", "mcp__x__find_and_replace", "mcp__x__get_or_create_item", "ctx_execute", "ctx_purge", "mcp__custom-tools__ctx_search", "edit", "powershell"]) {
		assert.ok(planToolRefused(name, allowed, blocked), name);
	}
});

const bypasses: string[] = [
	"fs['wri'+'teFileSync']('a','b')",
	"const r=globalThis['req'+'uire']",
	"import('node:'+'fs')",
	"process.binding('fs')",
	"await fetch(u,{method:'PO'+'ST'})",
	"process.kill(1)",
	"const n=['writeFileS','ync'].join(''); fs[n]('a','b')",
	"const k=Object.keys(fs).find(k=>k.startsWith('writeF')); fs[k]('a','b')",
	"fs2[n].call(fs2,'a','b')",
];
for (const code of bypasses) {
	test(`refuses runtime-built code: ${code.slice(0, 40)}`, () => {
		assert.notEqual(planToolProblem("run_code", { code }, []), null);
	});
}
const harmless: string[] = [
	"JSON.parse(require('fs').readFileSync('a','utf8'))",
	"const arr=[1,2,3]; console.log(arr[1+1], arr.length)",
	"const o={key:1}; console.log(o['key'])",
	"console.log(data[0](1), items[i], path[0])",
];
for (const code of harmless) {
	test(`allows plain reads: ${code.slice(0, 40)}`, () => {
		assert.equal(planToolProblem("run_code", { code }, []), null);
	});
}
test("an MCP tool that sends a statement changing data is refused", () => {
	assert.match(planToolProblem("mcp__x__query_database", { sql: "drop table a" }, []) ?? "", /changes data/);
	assert.match(planToolProblem("mcp__x__query_database", { nested: { q: "select 1; delete from t" } }, []) ?? "", /changes data/);
	assert.match(planToolProblem("mcp__x__query_graph", { q: "mutation { x }" }, []) ?? "", /changes data/);
	for (const sql of ["WITH x AS (SELECT 1) DELETE FROM t", "/* c */ DROP TABLE t", "select 1; COPY t FROM 'f'", "select 1 -- x\n; drop table t", "SELECT '--'; DROP TABLE t", "SELECT '/*'; DELETE FROM t; SELECT '*/'", "-- don't\nDROP TABLE t -- '", "/* it's */ DELETE FROM t /* ' */"]) {
		assert.match(planToolProblem("mcp__x__query_database", { sql }, []) ?? "", /changes data/, sql);
	}
	assert.equal(planToolProblem("mcp__x__query_database", { sql: "select 1" }, []), null);
	assert.equal(planToolProblem("mcp__x__search_docs", { query: "update the docs" }, []), null);
});
