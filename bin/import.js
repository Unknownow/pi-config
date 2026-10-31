#!/usr/bin/env node
/**
 * import.js — apply the repo's Pi setup to this machine.
 *
 *   <repo>/pi/agent/<x>  ->  ~/.pi/agent/<x>
 *
 * Placeholders are resolved from local/machine.json or auto-detected. Every
 * file that gets overwritten is backed up to <name>.bak-<timestamp> first.
 * A file that was synced earlier, is gone from the repo and is unchanged on this machine
 * is deleted here too (no backup; never a file with no sync record, never an edited
 * one). More than 20 deletions, or over 25% of the recorded files, need --allow-deletes;
 * without it nothing is deleted and the exit code is 2.
 *
 *   node bin/import.js            apply
 *   node bin/import.js --dry-run  show what would change, write nothing
 *   node bin/import.js --allow-deletes  allow a large number of deletions
 */
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const DRY = process.argv.includes('--dry-run');
const ALLOW_DELETES = process.argv.includes('--allow-deletes');

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
  if (!fs.existsSync(lib.MIRROR)) {
    console.error(`No pi/agent directory in ${lib.REPO}. Run \`node bin/export.js\` on a configured machine first.`);
    process.exit(1);
  }

  const items = lib.inventory(lib.MIRROR);
  const overrides = loadOverrides();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const warnings = [];
  const state = lib.readState();
  let changed = 0;
  let same = 0;

  for (const item of items) {
    const src = path.join(lib.MIRROR, item.rel);
    const dest = path.join(lib.AGENT, item.rel);
    const label = item.rel;
    const note = (line) => { if (!DRY) console.log(`          ${line}`); };

    // What this machine now matches: the mirror file's bytes, whether or not it is written.
    const mirrorBytes = fs.readFileSync(src);
    let next;
    if (item.kind === 'json') {
      const json = lib.readJson(src);
      if (json === null) {
        console.error(`  FAILED  ${label}  (not valid JSON)`);
        continue;
      }
      warnings.push(...lib.resolvePlaceholders(item.rel, json, overrides, note));
      lib.keepMachineKeys(item.rel, json, fs.existsSync(dest) ? lib.readJson(dest) : null);
      next = Buffer.from(JSON.stringify(json, null, 2) + '\n');
    } else {
      next = fs.readFileSync(src);
    }

    const prev = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
    // Compare JSON by meaning, not bytes: Pi rewrites these files with its own
    // formatting, so a byte diff would report spurious changes every run.
    const unchanged = prev !== null && (
      item.kind === 'json' ? lib.sameJson(prev.toString('utf8'), next.toString('utf8')) : prev.equals(next)
    );

    if (unchanged) {
      same++;
      if (!DRY && lib.recordable(state, item.rel, mirrorBytes)) state[lib.key(item.rel)] = lib.sha(mirrorBytes);
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
    // A hand edit in the repo is copied to this machine but not recorded: the next export keeps it out of commits.
    if (lib.recordable(state, item.rel, mirrorBytes)) state[lib.key(item.rel)] = lib.sha(mirrorBytes);
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
    onSource: (k) => fs.existsSync(path.join(lib.MIRROR, k)),
    targetHash: localForm,
  });
  for (const k of del.keptEdited) console.log(`  keep    ${k}  (gone from the repo but edited on this machine: not deleted)`);
  const overCap = del.toDelete.length > 0 && !ALLOW_DELETES && lib.tooMany(del.toDelete.length, del.recorded);
  if (overCap) {
    console.log(`\n${del.toDelete.length} deletion(s) are over the cap (20, or 25% of ${del.recorded} recorded files); nothing deleted. Rerun with --allow-deletes after checking:`);
    for (const k of del.toDelete) console.log(`  WOULD delete ${k}`);
  } else {
    for (const k of del.toDelete) {
      if (DRY) {
        console.log(`  WOULD delete ${k}`);
        continue;
      }
      const f = path.join(lib.AGENT, k);
      try {
        fs.unlinkSync(f);
        lib.pruneEmptyParents(path.dirname(f), lib.AGENT);
      } catch (e) {
        console.log(`  WARNING  could not delete ${k}: ${e.message}`);
        continue;
      }
      delete state[k];
      console.log(`  delete  ${k}`);
    }
  }

  if (!DRY) lib.writeState(state);
  if (!DRY && fs.existsSync(path.join(lib.REPO, '.githooks', 'pre-commit'))) {
    // The hook refuses commits that hold credentials.
    try {
      require('child_process').execFileSync('git', ['-C', lib.REPO, 'config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
    } catch (_) { /* not a git checkout */ }
  }
  if (DRY) {
    console.log(`\nDry run — ${changed} file(s) would change, ${del.toDelete.length} would be deleted, ${same} already current.`);
    if (overCap) process.exitCode = 2;
    return;
  }

  console.log(`\n${changed} file(s) applied, ${same} already current.`);
  if (overCap) process.exitCode = 2;
  for (const w of warnings) console.log(`\n  WARNING  ${w}`);

  if (changed > 0) {
    console.log('\nNext steps on this machine:');
    console.log('  1.  pi-config install     # npm install the extensions');
    console.log('  2.  restart Pi');
    console.log('  3.  log in               # auth is deliberately not synced');
  }
}

main();
