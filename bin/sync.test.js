// node --test bin/sync.test.js
// Runs export.js and import.js against a throwaway repo and a fake home directory.
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BIN = __dirname;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-config-test-'));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(repo, 'bin'), { recursive: true });
  for (const f of ['lib.js', 'export.js', 'import.js', 'check-secrets.js']) fs.copyFileSync(path.join(BIN, f), path.join(repo, 'bin', f));
  fs.mkdirSync(path.join(home, '.pi', 'agent', 'extensions', 'demo'), { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  return { root, repo, home, git, agent: path.join(home, '.pi', 'agent'), mirror: path.join(repo, 'pi', 'agent') };
}

function run(env, script, ...args) {
  return execFileSync(process.execPath, [path.join(env.repo, 'bin', script), ...args], {
    cwd: env.repo,
    env: { ...process.env, HOME: env.home, USERPROFILE: env.home },
    encoding: 'utf8',
  });
}

const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, s) => fs.writeFileSync(p, s);

test('export writes new files and records them', () => {
  const env = setup();
  write(path.join(env.agent, 'extensions', 'demo', 'index.ts'), 'v1\n');
  run(env, 'export.js');
  assert.equal(read(path.join(env.mirror, 'extensions', 'demo', 'index.ts')), 'v1\n');
  assert.ok(fs.existsSync(path.join(env.repo, 'local', 'sync-state.json')));
});

test('export keeps a file edited in the repo, and writes machine changes to other files', () => {
  const env = setup();
  const a = path.join(env.agent, 'extensions', 'demo', 'index.ts');
  const b = path.join(env.agent, 'extensions', 'demo', 'other.ts');
  write(a, 'v1\n');
  write(b, 'b1\n');
  run(env, 'export.js');
  write(path.join(env.mirror, 'extensions', 'demo', 'index.ts'), 'hand edit\n');
  write(a, 'machine v2\n');
  write(b, 'b2\n');
  const out = run(env, 'export.js');
  assert.match(out, /keep\s+extensions[\\/]demo[\\/]index\.ts/);
  assert.equal(read(path.join(env.mirror, 'extensions', 'demo', 'index.ts')), 'hand edit\n');
  assert.equal(read(path.join(env.mirror, 'extensions', 'demo', 'other.ts')), 'b2\n');
});

test('export --force replaces a hand edit', () => {
  const env = setup();
  const a = path.join(env.agent, 'extensions', 'demo', 'index.ts');
  write(a, 'v1\n');
  run(env, 'export.js');
  write(path.join(env.mirror, 'extensions', 'demo', 'index.ts'), 'hand edit\n');
  run(env, 'export.js', '--force');
  assert.equal(read(path.join(env.mirror, 'extensions', 'demo', 'index.ts')), 'v1\n');
});

test('without a record, HEAD is the baseline: a committed file the machine changed is written', () => {
  const env = setup();
  const m = path.join(env.mirror, 'extensions', 'demo', 'index.ts');
  fs.mkdirSync(path.dirname(m), { recursive: true });
  write(m, 'committed\n');
  env.git('add', '-A');
  env.git('commit', '-qm', 'base');
  write(path.join(env.agent, 'extensions', 'demo', 'index.ts'), 'machine\n');
  run(env, 'export.js');
  assert.equal(read(m), 'machine\n');
});

test('import records what it copied, so the next export does not keep it as a hand edit', () => {
  const env = setup();
  write(path.join(env.agent, 'extensions', 'demo', 'index.ts'), 'v1\n');
  run(env, 'export.js');
  write(path.join(env.agent, 'extensions', 'demo', 'index.ts'), 'stale machine\n');
  run(env, 'import.js');
  assert.equal(read(path.join(env.agent, 'extensions', 'demo', 'index.ts')), 'v1\n');
  const out = run(env, 'export.js');
  assert.doesNotMatch(out, /keep/);
});

test('dry run writes neither mirror nor state', () => {
  const env = setup();
  write(path.join(env.agent, 'extensions', 'demo', 'index.ts'), 'v1\n');
  run(env, 'export.js', '--dry-run');
  assert.ok(!fs.existsSync(path.join(env.repo, 'local', 'sync-state.json')));
  assert.ok(!fs.existsSync(path.join(env.mirror, 'extensions', 'demo', 'index.ts')));
});

test('a hand edit that import copies to the machine is never recorded, so the commit step keeps it', () => {
  const env = setup();
  const rel = 'extensions/demo/index.ts';
  write(path.join(env.agent, 'extensions', 'demo', 'index.ts'), 'v1\n');
  run(env, 'export.js');
  write(path.join(env.mirror, 'extensions', 'demo', 'index.ts'), 'hand\n');
  run(env, 'import.js');
  run(env, 'export.js');
  const state = JSON.parse(read(path.join(env.repo, 'local', 'sync-state.json')));
  assert.equal(state[rel], require('crypto').createHash('sha256').update('v1\n').digest('hex'));
});

test('a change committed in the repo and then pulled in is recorded by import, so export does not keep it', () => {
  const env = setup();
  const rel = 'extensions/demo/index.ts';
  write(path.join(env.agent, 'extensions', 'demo', 'index.ts'), 'v1\n');
  run(env, 'export.js');
  env.git('add', '-A');
  env.git('commit', '-qm', 'base');
  write(path.join(env.mirror, 'extensions', 'demo', 'index.ts'), 'v2\n');
  env.git('add', '-A');
  env.git('commit', '-qm', 'pulled');
  run(env, 'import.js');
  const out = run(env, 'export.js');
  assert.doesNotMatch(out, /keep/);
  const state = JSON.parse(read(path.join(env.repo, 'local', 'sync-state.json')));
  assert.equal(state[rel], require('crypto').createHash('sha256').update('v2\n').digest('hex'));
});

// Fake credentials are built at runtime so this file itself passes the pre-commit hook.
const FAKE_KEY = 'sk-' + 'a'.repeat(30);

test('export skips files whose names look like credentials', () => {
  const env = setup();
  write(path.join(env.agent, 'mcp-oauth.json'), '{}');
  write(path.join(env.agent, 'extensions', 'demo', 'key.pem'), 'x');
  write(path.join(env.agent, 'extensions', 'demo', 'credentials.txt'), 'x');
  write(path.join(env.agent, 'extensions', 'demo', 'index.ts'), 'v1\n');
  const out = run(env, 'export.js');
  assert.match(out, /SKIPPED\s+mcp-oauth\.json/);
  assert.match(out, /SKIPPED\s+extensions\/demo\/key\.pem/);
  assert.match(out, /SKIPPED\s+extensions\/demo\/credentials\.txt/);
  assert.ok(!fs.existsSync(path.join(env.mirror, 'mcp-oauth.json')));
  assert.ok(!fs.existsSync(path.join(env.mirror, 'extensions', 'demo', 'key.pem')));
  assert.ok(fs.existsSync(path.join(env.mirror, 'extensions', 'demo', 'index.ts')));
});

test('export skips a file that holds a key, keeps the rest', () => {
  const env = setup();
  write(path.join(env.agent, 'provider.json'), JSON.stringify({ apiKey: FAKE_KEY }));
  write(path.join(env.agent, 'extensions', 'demo', 'config.json'), JSON.stringify({ password: 'hunter2hunter2' }));
  write(path.join(env.agent, 'other.json'), JSON.stringify({ fine: true }));
  const out = run(env, 'export.js');
  assert.match(out, /SKIPPED\s+provider\.json/);
  assert.match(out, /SKIPPED\s+extensions\/demo\/config\.json/);
  assert.ok(!fs.existsSync(path.join(env.mirror, 'provider.json')));
  assert.ok(fs.existsSync(path.join(env.mirror, 'other.json')));
});

test('placeholders and unrelated keys are not secrets', () => {
  const lib = require('./lib');
  assert.deepEqual(lib.secretsIn('{"apiKey":"__CLAUDE_EXECUTABLE__"}'), []);
  assert.deepEqual(lib.secretsIn('{"apiKey":"${KEY_FROM_ENV}"}'), []);
  assert.deepEqual(lib.secretsIn('{"tokenWeights":{"input":1}}'), []);
  assert.deepEqual(lib.secretsIn('{"Authorization":"Bearer ${GITHUB_TOKEN}"}'), []);
  assert.equal(lib.isSecretName('tokens.ts'), false);
  assert.equal(lib.isSecretName('settings.json'), false);
  assert.equal(lib.isSecretName('check-secrets.js'), false);
  assert.equal(lib.isSecretName('credentials.txt'), true);
  assert.ok(lib.secretsIn(JSON.stringify({ apiKey: FAKE_KEY })).length > 0);
});

test('check-secrets --staged refuses a staged secret and passes a clean file', () => {
  const env = setup();
  const check = () => execFileSync(process.execPath, [path.join(env.repo, 'bin', 'check-secrets.js'), '--staged'], { cwd: env.repo, stdio: 'pipe' });
  write(path.join(env.repo, 'clean.txt'), 'hello\n');
  env.git('add', 'clean.txt');
  check();
  write(path.join(env.repo, 'leak.json'), JSON.stringify({ apiKey: FAKE_KEY }));
  env.git('add', 'leak.json');
  assert.throws(check, (e) => e.status === 1 && /leak\.json/.test(String(e.stderr)));
});

test('the real mirror and config hold no secrets', () => {
  const lib = require('./lib');
  const files = execFileSync('git', ['ls-files'], { cwd: lib.REPO, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  const bad = [];
  for (const f of files) {
    const abs = path.join(lib.REPO, f);
    if (!fs.existsSync(abs)) continue;
    if (lib.isSecretName(path.basename(f)) || lib.secretsIn(fs.readFileSync(abs, 'utf8')).length) bad.push(f);
  }
  assert.deepEqual(bad, []);
});
