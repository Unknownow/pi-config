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
  git('config', 'core.autocrlf', 'false'); // the tests write LF files by hand; a machine-wide autocrlf would turn HEAD into CRLF
  return { root, repo, home, git, agent: path.join(home, '.pi', 'agent'), mirror: path.join(repo, 'pi', 'agent') };
}

function run(env, script, ...args) {
  return execFileSync(process.execPath, [path.join(env.repo, 'bin', script), ...args], {
    cwd: env.repo,
    env: { ...process.env, HOME: env.home, USERPROFILE: env.home },
    encoding: 'utf8',
  });
}

/** Commit the mirror (like the extension's auto-commit): additions, edits and deletions under pi/. */
function commit(env, msg = 'base') {
  env.git('add', '-A', 'pi');
  env.git('commit', '-q', '--allow-empty', '-m', msg);
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
  assert.match(out, /conflict\s+extensions[\\/]demo[\\/]index\.ts/);
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
  commit(env);
  write(path.join(env.agent, 'extensions', 'demo', 'index.ts'), 'stale machine\n');
  run(env, 'import.js');
  assert.equal(read(path.join(env.agent, 'extensions', 'demo', 'index.ts')), 'v1\n');
  const out = run(env, 'export.js');
  assert.doesNotMatch(out, /keep/);
});

test('lastChangelogVersion stays on the machine: not exported, not overwritten by import', () => {
  const env = setup();
  const settings = path.join(env.agent, 'settings.json');
  write(settings, JSON.stringify({ lastChangelogVersion: '1.3.0', theme: 'dark' }));
  run(env, 'export.js');
  assert.equal(JSON.parse(read(path.join(env.mirror, 'settings.json'))).lastChangelogVersion, undefined);

  // A mirror written before this rule still holds an older version.
  write(path.join(env.mirror, 'settings.json'), JSON.stringify({ lastChangelogVersion: '1.2.0', theme: 'dark' }));
  commit(env);
  assert.match(run(env, 'import.js', '--dry-run'), /0 file\(s\) would change/);
  write(settings, JSON.stringify({ lastChangelogVersion: '1.3.0', theme: 'light' }));
  run(env, 'import.js');
  assert.deepEqual(JSON.parse(read(settings)), { lastChangelogVersion: '1.3.0', theme: 'dark' });
});

test('dry run writes neither mirror nor state', () => {
  const env = setup();
  write(path.join(env.agent, 'extensions', 'demo', 'index.ts'), 'v1\n');
  run(env, 'export.js', '--dry-run');
  assert.ok(!fs.existsSync(path.join(env.repo, 'local', 'sync-state.json')));
  assert.ok(!fs.existsSync(path.join(env.mirror, 'extensions', 'demo', 'index.ts')));
});

test('import mirrors HEAD, not an uncommitted working-tree edit; the record follows HEAD', () => {
  const env = setup();
  const rel = 'extensions/demo/index.ts';
  const machine = path.join(env.agent, 'extensions', 'demo', 'index.ts');
  write(machine, 'v1\n');
  run(env, 'export.js');
  commit(env);
  write(path.join(env.mirror, 'extensions', 'demo', 'index.ts'), 'hand\n');
  write(machine, 'stale\n');
  run(env, 'import.js');
  assert.equal(read(machine), 'v1\n');
  run(env, 'export.js');
  assert.equal(read(path.join(env.mirror, 'extensions', 'demo', 'index.ts')), 'hand\n');
  const state = JSON.parse(read(path.join(env.repo, 'local', 'sync-state.json')));
  assert.equal(state[rel], require('crypto').createHash('sha256').update('v1\n').digest('hex'));
});

test('a change committed in the repo and then pulled in is recorded by import, so export does not keep it', () => {
  const env = setup();
  const rel = 'extensions/demo/index.ts';
  write(path.join(env.agent, 'extensions', 'demo', 'index.ts'), 'v1\n');
  run(env, 'export.js');
  commit(env);
  write(path.join(env.mirror, 'extensions', 'demo', 'index.ts'), 'v2\n');
  commit(env, 'pulled');
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

test('normalizeSettingsPaths converts package extension paths', () => {
  const { normalizeSettingsPaths } = require('./lib');
  const json = { packages: [{ source: 'npm:x', extensions: ['+src\\index.ts', '-a\\b.ts', '!c\\d'] }] };
  normalizeSettingsPaths(json);
  assert.deepEqual(json.packages[0].extensions, ['+src/index.ts', '-a/b.ts', '!c/d']);
});

test('normalizeSettingsPaths leaves absolute, placeholder and non-string entries', () => {
  const { normalizeSettingsPaths } = require('./lib');
  const json = { extensions: ['C:\\x\\y', '+C:\\x\\y', '__PI_CONFIG_REPO__\\extension', 42, 'rel\\p'], packages: ['npm:y'] };
  normalizeSettingsPaths(json);
  assert.deepEqual(json.extensions, ['C:\\x\\y', '+C:\\x\\y', '__PI_CONFIG_REPO__\\extension', 42, 'rel/p']);
  assert.deepEqual(json.packages, ['npm:y']);
});

test('normalizeSettingsPaths is idempotent', () => {
  const { normalizeSettingsPaths } = require('./lib');
  const json = { skills: ['a\\b'], packages: [{ extensions: ['+src\\i.ts'] }] };
  normalizeSettingsPaths(json);
  const once = JSON.stringify(json);
  normalizeSettingsPaths(json);
  assert.equal(JSON.stringify(json), once);
});

test('export writes forward-slash package extension paths', () => {
  const env = setup();
  write(path.join(env.agent, 'settings.json'), JSON.stringify({ theme: 'dark', packages: [{ source: 'npm:x', extensions: ['+src\\index.ts'] }] }));
  run(env, 'export.js');
  const out = JSON.parse(read(path.join(env.mirror, 'settings.json')));
  assert.deepEqual(out.packages[0].extensions, ['+src/index.ts']);
});

function syncedPair() {
  const env = setup();
  const a = path.join(env.agent, 'extensions', 'demo', 'a.ts');
  const b = path.join(env.agent, 'extensions', 'demo', 'b.ts');
  write(a, 'a\n');
  write(b, 'b\n');
  for (let i = 0; i < 8; i++) write(path.join(env.agent, 'extensions', 'demo', `keep${i}.ts`), `${i}\n`);
  run(env, 'export.js');
  commit(env);
  return { env, a, b, ma: path.join(env.mirror, 'extensions', 'demo', 'a.ts'), mb: path.join(env.mirror, 'extensions', 'demo', 'b.ts') };
}

test('export does not add back a file deleted in the repo whose local copy is unchanged; an edited one goes back', () => {
  const { env, a, b, ma, mb } = syncedPair();
  fs.unlinkSync(ma);
  fs.unlinkSync(mb);
  write(b, 'edited locally\n');
  const out = run(env, 'export.js');
  assert.match(out, /pending\s+extensions\/demo\/a\.ts/);
  assert.ok(!fs.existsSync(ma));
  assert.equal(read(mb), 'edited locally\n');
  run(env, 'export.js', '--force');
  assert.equal(read(ma), 'a\n');
  fs.unlinkSync(ma);
  commit(env, 'delete a');
  run(env, 'import.js');
  assert.ok(!fs.existsSync(a));
});

test('export deletes a repo file that is gone locally and marks the record deleted', () => {
  const { env, a, ma } = syncedPair();
  fs.unlinkSync(a);
  assert.match(run(env, 'export.js', '--dry-run'), /WOULD delete extensions\/demo\/a\.ts/);
  assert.ok(fs.existsSync(ma));
  run(env, 'export.js');
  assert.ok(!fs.existsSync(ma));
  assert.deepEqual(JSON.parse(read(path.join(env.repo, 'local', 'sync-state.json')))['extensions/demo/a.ts'], { deleted: true });
});

test('export keeps a repo file edited by hand and a file with no record', () => {
  const { env, a, mb, b } = syncedPair();
  fs.unlinkSync(a);
  write(path.join(env.mirror, 'extensions', 'demo', 'a.ts'), 'edited\n');
  write(path.join(env.mirror, 'extensions', 'demo', 'norecord.ts'), 'x\n');
  const out = run(env, 'export.js');
  assert.match(out, /keep\s+extensions\/demo\/a\.ts/);
  assert.equal(read(path.join(env.mirror, 'extensions', 'demo', 'a.ts')), 'edited\n');
  assert.ok(fs.existsSync(path.join(env.mirror, 'extensions', 'demo', 'norecord.ts')));
  assert.ok(fs.existsSync(mb) && fs.existsSync(b));
});

test('import deletes a local file gone from HEAD and removes empty folders; an edited copy is backed up first', () => {
  const { env, a, b, ma, mb } = syncedPair();
  fs.unlinkSync(ma);
  fs.unlinkSync(mb);
  commit(env, 'delete a and b');
  write(b, 'edited locally\n');
  const out = run(env, 'import.js');
  assert.ok(!fs.existsSync(a));
  assert.ok(!fs.existsSync(b));
  const baks = fs.readdirSync(path.dirname(b)).filter((f) => f.startsWith('b.ts.bak-'));
  assert.equal(baks.length, 1);
  assert.equal(read(path.join(path.dirname(b), baks[0])), 'edited locally\n');
  assert.match(out, /backup\s+extensions\/demo\/b\.ts\.bak-/);
  assert.match(out, /delete\s+extensions\/demo\/b\.ts/);
  fs.mkdirSync(path.join(env.mirror, 'extensions', 'only'), { recursive: true });
  write(path.join(env.mirror, 'extensions', 'only', 'o.ts'), 'o\n');
  commit(env, 'add o');
  run(env, 'import.js');
  assert.ok(fs.existsSync(path.join(env.agent, 'extensions', 'only', 'o.ts')));
  fs.unlinkSync(path.join(env.mirror, 'extensions', 'only', 'o.ts'));
  commit(env, 'delete o');
  run(env, 'import.js');
  assert.ok(!fs.existsSync(path.join(env.agent, 'extensions', 'only')));
  assert.ok(fs.existsSync(path.join(env.agent, 'extensions')));
});

test('deletes over the cap need --allow-deletes and exit with code 2', () => {
  const env = setup();
  const dir = path.join(env.agent, 'extensions', 'demo');
  write(path.join(dir, 'stay.ts'), 'stay\n');
  for (let i = 0; i < 25; i++) write(path.join(dir, `f${i}.ts`), `${i}\n`);
  run(env, 'export.js');
  for (let i = 0; i < 25; i++) fs.unlinkSync(path.join(dir, `f${i}.ts`));
  assert.throws(() => run(env, 'export.js'), (e) => e.status === 2 && /over the cap/.test(e.stdout));
  assert.ok(fs.existsSync(path.join(env.mirror, 'extensions', 'demo', 'f0.ts')));
  run(env, 'export.js', '--allow-deletes');
  assert.ok(!fs.existsSync(path.join(env.mirror, 'extensions', 'demo', 'f0.ts')));
});

test('25% of the recorded files is refused even with few candidates', () => {
  const env = setup();
  const dir = path.join(env.agent, 'extensions', 'demo');
  for (let i = 0; i < 12; i++) write(path.join(dir, `f${i}.ts`), `${i}\n`);
  run(env, 'export.js');
  for (let i = 0; i < 4; i++) fs.unlinkSync(path.join(dir, `f${i}.ts`));
  assert.throws(() => run(env, 'export.js'), (e) => e.status === 2);
  assert.ok(fs.existsSync(path.join(env.mirror, 'extensions', 'demo', 'f0.ts')));
});

test('import --dry-run deletes nothing, and a real delete leaves no .bak', () => {
  const { env, a, ma } = syncedPair();
  fs.unlinkSync(ma);
  commit(env, 'delete a');
  assert.match(run(env, 'import.js', '--dry-run'), /WOULD delete extensions\/demo\/a\.ts/);
  assert.ok(fs.existsSync(a));
  run(env, 'import.js');
  assert.ok(!fs.existsSync(a));
  assert.deepEqual(fs.readdirSync(path.dirname(a)).filter((f) => f.includes('.bak-')), []);
});

test('import deletes a JSON file that Pi reformatted', () => {
  const env = setup();
  const local = path.join(env.agent, 'workflow.json');
  write(local, JSON.stringify({ a: 1, b: 2 }));
  for (let i = 0; i < 8; i++) write(path.join(env.agent, 'extensions', 'demo', `k${i}.ts`), `${i}\n`);
  run(env, 'export.js');
  commit(env);
  // Pi rewrites the file with its own formatting; it is still the recorded content.
  write(local, '{\n"a": 1,\n"b": 2\n}');
  fs.unlinkSync(path.join(env.mirror, 'workflow.json'));
  commit(env, 'delete');
  run(env, 'import.js');
  assert.ok(!fs.existsSync(local));
});

test('import deletes settings.json that differs only in a scrubbed machine key', () => {
  const env = setup();
  const local = path.join(env.agent, 'settings.json');
  write(local, JSON.stringify({ lastChangelogVersion: '1', a: 1 }));
  for (let i = 0; i < 8; i++) write(path.join(env.agent, 'extensions', 'demo', `k${i}.ts`), `${i}\n`);
  run(env, 'export.js');
  commit(env);
  write(local, JSON.stringify({ lastChangelogVersion: '2', a: 1 }));
  fs.unlinkSync(path.join(env.mirror, 'settings.json'));
  commit(env, 'delete');
  run(env, 'import.js');
  assert.ok(!fs.existsSync(local));
});

test('a delete that fails is a warning, not an error', () => {
  const { env, a, ma } = syncedPair();
  fs.unlinkSync(ma);
  commit(env, 'delete a');
  // Fail the delete of a.ts by injecting the error, so it works the same on every platform.
  const preload = path.join(env.root, 'fail-unlink.js');
  write(preload, [
    "const fs = require('fs');",
    'const orig = fs.unlinkSync;',
    'fs.unlinkSync = function (p, ...rest) {',
    "  if (String(p).replace(/\\\\/g, '/').endsWith('extensions/demo/a.ts')) {",
    "    throw Object.assign(new Error('EPERM: operation not permitted (test)'), { code: 'EPERM' });",
    '  }',
    '  return orig.call(this, p, ...rest);',
    '};',
    '',
  ].join('\n'));
  const out = execFileSync(process.execPath, ['--require', preload, path.join(env.repo, 'bin', 'import.js')], {
    cwd: env.repo,
    env: { ...process.env, HOME: env.home, USERPROFILE: env.home },
    encoding: 'utf8',
  });
  assert.match(out, /WARNING  could not delete extensions\/demo\/a\.ts/);
  assert.ok(fs.existsSync(a));
  const state = JSON.parse(read(path.join(env.repo, 'local', 'sync-state.json')));
  assert.equal(typeof state['extensions/demo/a.ts'], 'string');
});

// ---------------------------------------------------------------------------
// HEAD is the truth, pending machine exports, conflicts
// ---------------------------------------------------------------------------

const readState = (env) => JSON.parse(read(path.join(env.repo, 'local', 'sync-state.json')));

test('import deletes more than 20 recorded files with no flag', () => {
  const env = setup();
  const dir = path.join(env.agent, 'extensions', 'demo');
  write(path.join(dir, 'stay.ts'), 'stay\n');
  for (let i = 0; i < 30; i++) write(path.join(dir, `f${i}.ts`), `${i}\n`);
  run(env, 'export.js');
  commit(env);
  for (let i = 0; i < 30; i++) fs.unlinkSync(path.join(env.mirror, 'extensions', 'demo', `f${i}.ts`));
  commit(env, 'delete 30');
  run(env, 'import.js');
  assert.deepEqual(fs.readdirSync(dir), ['stay.ts']);
  assert.equal(readState(env)['extensions/demo/f0.ts'], undefined);
  // The flag is still accepted and does nothing.
  run(env, 'import.js', '--allow-deletes');
});

test('a new machine file exported with a failed commit is kept by the next import', () => {
  const { env } = syncedPair();
  const fresh = path.join(env.agent, 'extensions', 'demo', 'fresh.ts');
  write(fresh, 'new\n');
  run(env, 'export.js'); // the commit "fails": nothing is committed
  assert.ok(fs.existsSync(path.join(env.mirror, 'extensions', 'demo', 'fresh.ts')));
  const out = run(env, 'import.js');
  assert.match(out, /pending\s+extensions\/demo\/fresh\.ts/);
  assert.equal(read(fresh), 'new\n');
  assert.deepEqual(fs.readdirSync(path.dirname(fresh)).filter((f) => f.includes('.bak-')), []);
});

test('a modified machine file exported with a failed commit is not overwritten by import with HEAD', () => {
  const { env, a } = syncedPair();
  write(a, 'machine v2\n');
  run(env, 'export.js');
  run(env, 'import.js');
  assert.equal(read(a), 'machine v2\n');
  // The machine changes again: export still updates it, with no conflict.
  write(a, 'machine v3\n');
  const out = run(env, 'export.js');
  assert.doesNotMatch(out, /conflict/);
  assert.equal(read(path.join(env.mirror, 'extensions', 'demo', 'a.ts')), 'machine v3\n');
});

test('a pending deletion made by export is not undone by import', () => {
  const { env, a, ma } = syncedPair();
  fs.unlinkSync(a);
  run(env, 'export.js');
  assert.ok(!fs.existsSync(ma));
  run(env, 'import.js');
  assert.ok(!fs.existsSync(a));
});

test('a file with no sync record is kept, even when it is not in HEAD', () => {
  const { env, a, ma } = syncedPair();
  const state = readState(env);
  delete state['extensions/demo/a.ts'];
  write(path.join(env.repo, 'local', 'sync-state.json'), JSON.stringify(state));
  fs.unlinkSync(ma);
  commit(env, 'delete a');
  run(env, 'import.js');
  assert.ok(fs.existsSync(a));
  const stranger = path.join(env.agent, 'extensions', 'demo', 'stranger.ts');
  write(stranger, 's\n');
  run(env, 'import.js');
  assert.ok(fs.existsSync(stranger));
});

test('export skips and logs a conflict for an uncommitted repo edit; --force overrides it', () => {
  const { env, a } = syncedPair();
  const ma = path.join(env.mirror, 'extensions', 'demo', 'a.ts');
  write(ma, 'repo edit\n');
  write(a, 'machine edit\n');
  const out = run(env, 'export.js');
  assert.match(out, /conflict\s+extensions\/demo\/a\.ts/);
  assert.equal(read(ma), 'repo edit\n');
  run(env, 'export.js', '--force');
  assert.equal(read(ma), 'machine edit\n');
});

test('a change pulled from another clone but not imported is not overwritten by export', () => {
  const { env, a, ma } = syncedPair();
  const bare = path.join(env.root, 'remote.git');
  const clone = path.join(env.root, 'clone');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  const branch = env.git('rev-parse', '--abbrev-ref', 'HEAD').toString().trim();
  env.git('remote', 'add', 'origin', bare);
  env.git('push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
  execFileSync('git', ['clone', '-q', '-b', branch, bare, clone]);
  const cgit = (...x) => execFileSync('git', x, { cwd: clone, stdio: 'pipe' });
  cgit('config', 'user.email', 't@example.com');
  cgit('config', 'user.name', 't');
  write(path.join(clone, 'pi', 'agent', 'extensions', 'demo', 'a.ts'), 'from the other pc\n');
  cgit('commit', '-qam', 'other pc');
  cgit('push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
  env.git('pull', '-q', '--ff-only', 'origin', branch);
  assert.equal(read(ma), 'from the other pc\n');
  write(a, 'machine edit\n');
  const out = run(env, 'export.js');
  assert.match(out, /conflict\s+extensions\/demo\/a\.ts/);
  assert.equal(read(ma), 'from the other pc\n');
  run(env, 'import.js');
  assert.equal(read(a), 'from the other pc\n');
});

test('a .bat file round-trips through import and export with no conflict', () => {
  const env = setup();
  write(path.join(env.repo, '.gitattributes'), '*.bat text eol=crlf\n');
  env.git('add', '.gitattributes');
  env.git('commit', '-qm', 'attrs');
  const bat = path.join(env.agent, 'extensions', 'demo', 'run.bat');
  write(bat, '@echo off\r\necho hi\r\n');
  run(env, 'export.js');
  commit(env);
  assert.equal(env.git('show', 'HEAD:pi/agent/extensions/demo/run.bat').toString(), '@echo off\necho hi\n');
  // Import mirrors HEAD in working-copy form: CRLF, same as the machine copy, so nothing is written.
  assert.match(run(env, 'import.js'), /0 file\(s\) applied/);
  assert.equal(read(bat), '@echo off\r\necho hi\r\n');
  const out = run(env, 'export.js');
  assert.doesNotMatch(out, /conflict/);
  assert.equal(read(path.join(env.mirror, 'extensions', 'demo', 'run.bat')), '@echo off\r\necho hi\r\n');
  // A machine that has no copy yet gets the CRLF form from HEAD.
  fs.unlinkSync(bat);
  run(env, 'import.js');
  assert.equal(read(bat), '@echo off\r\necho hi\r\n');
  assert.doesNotMatch(run(env, 'export.js'), /conflict/);
});

test('import without any commit fails and writes nothing', () => {
  const env = setup();
  fs.mkdirSync(env.mirror, { recursive: true });
  write(path.join(env.mirror, 'a.json'), '{}');
  assert.throws(() => run(env, 'import.js'), (e) => e.status === 1);
});

test('classify agrees with inventory on the same tree', () => {
  const lib = require('./lib');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-config-classify-'));
  const files = ['settings.json', 'auth.json', 'AGENTS.md', 'notes.txt', 'mcp-oauth.json', 'npm/package.json', 'npm/package-lock.json',
    'extensions/x/a.ts', 'extensions/x/key.pem', 'extensions/x/node_modules/m/i.js', 'extensions/x/.hidden', 'extensions/x/a.ts.bak-1',
    'skills/s/SKILL.md', 'sessions/s.json', 'other/o.ts', 'bin/fd'];
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), 'x');
  }
  const fromWalk = lib.inventory(root).map((i) => `${i.rel}:${i.kind}`).sort();
  const fromPaths = files.map((f) => [f, lib.classify(f)]).filter(([, k]) => k).map(([f, k]) => `${f}:${k}`).sort();
  assert.deepEqual(fromPaths, fromWalk);
});
