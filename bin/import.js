#!/usr/bin/env node
/**
 * import.js — apply the repo's committed Pi setup to this machine.
 *
 *   <repo> HEAD:pi/agent/<x>  ->  ~/.pi/agent/<x>
 *
 * The committed `master` is the truth: import reads the files of `HEAD` (in working-copy
 * form, so `.bat` is CRLF), never the working tree. An uncommitted edit under pi/agent/
 * never reaches the machine. Placeholders are resolved from local/machine.json or
 * auto-detected. Every file that gets overwritten is backed up to <name>.bak-<timestamp> first.
 *
 * A pending machine export is left alone: a file whose working-tree copy differs from HEAD
 * but matches its sync record (export wrote it, the commit has not happened yet) keeps its
 * machine copy, and is never deleted.
 *
 * A file is deleted from this machine when it has a record in local/sync-state.json, is not
 * in HEAD, and the working tree holds no copy of it that matches the record (a committed
 * deletion, not an uncommitted new export). There is no deletion cap. An edited machine copy
 * is backed up to <name>.bak-<timestamp> first, then deleted. A file with no record (never
 * in the repo) is never deleted.
 *
 *   node bin/import.js            apply
 *   node bin/import.js --dry-run  show what would change, write nothing
 *   node bin/import.js --allow-deletes  accepted, does nothing (there is no cap)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const DRY = process.argv.includes('--dry-run');

function loadOverrides() {
  const p = path.join(lib.REPO, 'local', 'machine.json');
  if (!fs.existsSync(p)) return {};
  const json = lib.readJson(p);
  if (json === null) {
    console.error('local/machine.json is not valid JSON — ignoring');
    return {};
  }
  return json;
}

function main() {
  let head;
  try {
    head = lib.loadHead();
  } catch (e) {
    console.error(`Cannot read HEAD of ${lib.REPO}: ${e.message}`);
    process.exit(1);
  }
  if (head.size === 0) {
    console.error(`No committed pi/agent in ${lib.REPO}. Run \`node bin/export.js\` on a configured machine and commit first.`);
    process.exit(1);
  }

  const items = [...head.keys()].sort().map((rel) => ({ rel, kind: lib.classify(rel) })).filter((i) => i.kind);
  const overrides = loadOverrides();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const warnings = [];
  const state = lib.readState();
  let changed = 0;
  let same = 0;

  // The working-tree copy of a mirror file, or null.
  const wtBytes = (k) => {
    const f = path.join(lib.MIRROR, k);
    return fs.existsSync(f) ? fs.readFileSync(f) : null;
  };
  // A working-tree copy that matches the sync record is the machine's own export, not committed yet.
  const wtMatchesRecord = (k) => {
    const b = wtBytes(k);
    return b !== null && typeof state[k] === 'string' && lib.sha(b) === state[k];
  };
  // An export deleted this repo file and the commit has not happened: HEAD still holds it.
  const pendingDelete = (k) => state[k] && state[k].deleted === true && !fs.existsSync(path.join(lib.MIRROR, k));

  for (const item of items) {
    const dest = path.join(lib.AGENT, item.rel);
    const label = item.rel;
    const k = lib.key(item.rel);
    const note = (line) => { if (!DRY) console.log(`          ${line}`); };

    // What this machine now matches: the committed bytes, whether or not they are written.
    const entry = head.get(k);
    const mirrorBytes = entry.buf;
    const wt = wtBytes(k);
    const wtIsHead = wt !== null && entry.shas.has(lib.sha(wt));
    if (!wtIsHead && (wtMatchesRecord(k) || pendingDelete(k))) {
      console.log(`  pending ${label}  (machine export not committed yet: kept)`);
      continue;
    }
    let next;
    if (item.kind === 'json') {
      const json = lib.parseJson(mirrorBytes.toString('utf8'));
      if (json === null) {
        console.error(`  FAILED  ${label}  (not valid JSON)`);
        continue;
      }
      warnings.push(...lib.resolvePlaceholders(item.rel, json, overrides, note));
      lib.keepMachineKeys(item.rel, json, fs.existsSync(dest) ? lib.readJson(dest) : null);
      next = Buffer.from(JSON.stringify(json, null, 2) + '\n');
    } else {
      next = mirrorBytes;
    }

    const prev = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
    // Compare JSON by meaning, not bytes: Pi rewrites these files with its own
    // formatting, so a byte diff would report spurious changes every run.
    const unchanged = prev !== null && (
      item.kind === 'json' ? lib.sameJson(prev.toString('utf8'), next.toString('utf8')) : prev.equals(next)
    );

    if (unchanged) {
      same++;
      if (!DRY) state[k] = lib.sha(mirrorBytes);
      continue;
    }
    if (DRY) {
      console.log(`  WOULD   ${label}${prev === null ? '  (create)' : '  (overwrite)'}`);
      changed++;
      continue;
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (prev !== null) {
      fs.copyFileSync(dest, `${dest}.bak-${stamp}`);
      console.log(`  backup  ${label}.bak-${stamp}`);
    }
    fs.writeFileSync(dest, next);
    state[k] = lib.sha(mirrorBytes);
    console.log(`  write   ${label}`);
    changed++;
  }

  // This machine's copy in the form the record holds (what export would write).
  const localForm = (k) => {
    const f = path.join(lib.AGENT, k);
    if (!fs.existsSync(f)) return null;
    if (!k.endsWith('.json')) return lib.sha(fs.readFileSync(f));
    const json = lib.readJson(f);
    if (json === null) return 'unreadable';
    lib.scrub(k, json);
    return lib.sha(Buffer.from(JSON.stringify(json, null, 2) + '\n'));
  };
  const del = lib.planDeletes({
    state,
    direction: 'import',
    onSource: (k) => head.has(k) || wtMatchesRecord(k),
    targetHash: localForm,
  });
  // No cap: a committed deletion goes. An edited machine copy is backed up first.
  const gone = [...del.toDelete, ...del.keptEdited].sort();
  for (const k of gone) {
    const edited = del.keptEdited.includes(k);
    if (DRY) {
      console.log(`  WOULD delete ${k}${edited ? '  (edited on this machine: backed up first)' : ''}`);
      continue;
    }
    const f = path.join(lib.AGENT, k);
    try {
      if (edited) {
        fs.copyFileSync(f, `${f}.bak-${stamp}`);
        console.log(`  backup  ${k}.bak-${stamp}`);
      }
      fs.unlinkSync(f);
      lib.pruneEmptyParents(path.dirname(f), lib.AGENT);
    } catch (e) {
      console.log(`  WARNING  could not delete ${k}: ${e.message}`);
      continue;
    }
    delete state[k];
    console.log(`  delete  ${k}`);
  }

  if (!DRY) lib.writeState(state);
  if (!DRY && fs.existsSync(path.join(lib.REPO, '.githooks', 'pre-commit'))) {
    // The hook refuses commits that hold credentials.
    try {
      require('child_process').execFileSync('git', ['-C', lib.REPO, 'config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
    } catch (_) { /* not a git checkout */ }
  }
  if (DRY) {
    console.log(`\nDry run — ${changed} file(s) would change, ${gone.length} would be deleted, ${same} already current.`);
    return;
  }

  console.log(`\n${changed} file(s) applied, ${same} already current.`);
  for (const w of warnings) console.log(`\n  WARNING  ${w}`);

  if (changed > 0) {
    console.log('\nNext steps on this machine:');
    console.log('  1.  pi-config install     # npm install the extensions');
    console.log('  2.  restart Pi');
    console.log('  3.  log in               # auth is deliberately not synced');
  }
}

main();
