#!/usr/bin/env node
/**
 * test-all.js — run every test suite of pi-config, one after another. On demand only: no hook or flow calls it.
 *
 *   node bin/test-all.js          one line per suite, then the failing test names; exit 1 when a suite fails
 *   node bin/test-all.js --json   { suites: [{ name, pass, fail, seconds, failing }], ok }
 *
 * Each suite runs with the command its README or test files use (`node --test ...`), `--test-reporter=spec`,
 * `PI_AGENTS_TOOLS` removed from the child env, and a 10 minute timeout (a timeout is a failed suite).
 * A glob that matches no file is skipped. Takes a few minutes (relay alone about 2 min).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const EXT = path.join(REPO, 'pi', 'agent', 'extensions');
const STRIP = '--experimental-strip-types';
const TIMEOUT_MS = 10 * 60 * 1000;

/** name, cwd, node flags and file globs (relative to cwd; only the last path segment may hold `*`). */
const SUITES = [
  { name: 'bin', cwd: REPO, flags: [], globs: ['bin/sync.test.js', 'bin/vscode-bridge.test.js'] },
  { name: 'extension', cwd: REPO, flags: [STRIP], globs: ['extension/*.test.ts'] },
  { name: 'agents', cwd: path.join(EXT, 'agents'), flags: [STRIP], globs: ['*.test.ts'] },
  { name: 'markdown-view', cwd: path.join(EXT, 'markdown-view'), flags: [STRIP], globs: ['*.test.ts'] },
  { name: 'quiet-tools', cwd: path.join(EXT, 'quiet-tools'), flags: [STRIP], globs: ['*.test.ts'] },
  { name: 'relay', cwd: path.join(EXT, 'relay'), flags: [STRIP, '--import', '../agents/test-hooks.ts'], globs: ['*.test.ts'] },
  { name: 'sandbox', cwd: path.join(EXT, 'sandbox'), flags: [STRIP], globs: ['*.test.ts'] },
  { name: 'shared', cwd: path.join(EXT, 'shared'), flags: [STRIP], globs: ['*.test.ts', 'git/*.test.ts'] },
  { name: 'workflow', cwd: path.join(EXT, 'workflow'), flags: [STRIP], globs: ['*.test.ts'] },
  { name: 'workspace', cwd: path.join(EXT, 'workspace'), flags: [STRIP], globs: ['*.test.ts'] },
  { name: 'workspace/vscode', cwd: path.join(EXT, 'workspace'), flags: [], globs: ['vscode/request.test.js'] },
];

/** Expand globs relative to cwd in JS (no shell); a glob with no match gives nothing. */
function expand(cwd, globs) {
  const files = [];
  for (const g of globs) {
    const slash = g.lastIndexOf('/');
    const dir = slash < 0 ? '' : g.slice(0, slash);
    const base = g.slice(slash + 1);
    if (!base.includes('*')) {
      if (fs.existsSync(path.join(cwd, g))) files.push(g);
      continue;
    }
    const re = new RegExp('^' + base.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    let names = [];
    try { names = fs.readdirSync(path.join(cwd, dir)); } catch (_) { /* missing folder: no match */ }
    for (const n of names.sort()) if (re.test(n)) files.push(dir ? `${dir}/${n}` : n);
  }
  return files;
}

const strip = (s) => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');

/** Counts and failing test names from node's spec reporter output. */
function parse(text) {
  const num = (label) => {
    const m = new RegExp('^\\s*ℹ ' + label + ' (\\d+)\\s*$', 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const failing = [];
  const at = text.indexOf('failing tests:');
  if (at >= 0) {
    let file = '';
    for (const line of text.slice(at).split('\n')) {
      const t = /^\s*test at (.+?)(?::\d+:\d+)?\s*$/.exec(line);
      if (t) { file = path.basename(t[1].replace(/^file:\/\/\/?/, '')); continue; }
      const f = /^\s*✖ (.+?) \([\d.]+ms\)\s*$/.exec(line);
      if (f) {
        const name = file ? `${file}: ${f[1]}` : f[1];
        if (!failing.includes(name)) failing.push(name);
      }
    }
  }
  return { pass: num('pass'), fail: num('fail'), failing };
}

function runSuite(suite, files) {
  const env = { ...process.env };
  delete env.PI_AGENTS_TOOLS;
  const args = [...suite.flags, '--test', '--test-reporter=spec', ...files];
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, {
    cwd: suite.cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  const p = parse(strip(`${r.stdout || ''}\n${r.stderr || ''}`));
  const out = { name: suite.name, pass: p.pass ?? 0, fail: p.fail ?? 0, seconds, failing: p.failing };
  if (r.error) {
    out.fail = Math.max(out.fail, 1);
    out.failing.push(r.error.code === 'ETIMEDOUT' ? `timed out after ${TIMEOUT_MS / 60000} min` : `could not run: ${r.error.message}`);
  } else if (r.status !== 0 && (p.pass === null || p.fail === null)) {
    out.fail = Math.max(out.fail, 1);
    out.failing.push(`no test summary (exit ${r.status})`);
  } else if (r.status !== 0 && out.fail === 0) {
    out.fail = 1;
    out.failing.push(`exit ${r.status} with no failing test`);
  }
  return out;
}

function main() {
  const json = process.argv.includes('--json');
  const results = [];
  for (const suite of SUITES) {
    const files = expand(suite.cwd, suite.globs);
    if (files.length === 0) {
      if (!json) console.log(`${suite.name.padEnd(18)} skipped (no test files)`);
      continue;
    }
    const res = runSuite(suite, files);
    results.push(res);
    if (!json) console.log(`${res.name.padEnd(18)} pass ${String(res.pass).padStart(4)}  fail ${String(res.fail).padStart(3)}  ${res.seconds}s`);
  }
  const ok = results.every((r) => r.fail === 0);
  if (json) {
    console.log(JSON.stringify({ suites: results, ok }, null, 2));
  } else {
    const bad = results.filter((r) => r.fail > 0);
    if (bad.length) {
      console.log('\nFailing tests:');
      for (const r of bad) {
        if (r.failing.length === 0) console.log(`  [${r.name}] ${r.fail} failed (names not parsed)`);
        for (const n of r.failing) console.log(`  [${r.name}] ${n}`);
      }
    }
    console.log(ok ? '\nAll suites passed.' : `\n${bad.length} suite(s) failed.`);
  }
  process.exit(ok ? 0 : 1);
}

main();
