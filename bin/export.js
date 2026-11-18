#!/usr/bin/env node
/**
 * export.js — capture this machine's Pi setup into the repo.
 *
 *   ~/.pi/agent/<x>  ->  <repo>/pi/agent/<x>
 *
 * What counts as "setup" lives in lib.js. Machine-specific values are replaced
 * with placeholders so the committed files stay portable. Credentials are never
 * read. A file that was synced earlier, is gone from this machine and is unchanged
 * in the repo is deleted from the repo too (never one with no sync record, never an
 * edited one). More than 20 deletions, or over 25% of the recorded files, need
 * --allow-deletes; without it nothing is deleted and the exit code is 2.
 *
 * A repo file edited since the last sync is never overwritten or deleted by export. A repo
 * edit is a file under pi/agent/ whose content differs from its sync record (with no record:
 * from HEAD). When this machine's copy differs too, export skips the file and prints
 * `conflict <path>`: finish the edit, commit it and import, or run with --force to replace it
 * with this machine's copy. A file that differs from HEAD but matches its record is a pending
 * machine export (written earlier, not committed yet) and is updated normally. A file pulled
 * from another machine but not yet imported (working tree = HEAD, differs from the record)
 * stays protected.
 *
 *   node bin/export.js            capture
 *   node bin/export.js --dry-run  show what would change, write nothing
 *   node bin/export.js --force    also overwrite repo files edited by hand
 *   node bin/export.js --allow-deletes  allow a large number of deletions
 */
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const ALLOW_DELETES = process.argv.includes('--allow-deletes');

function main() {
  if (!fs.existsSync(lib.AGENT)) {
    console.error(`No Pi install found at ${lib.AGENT}`);
    process.exit(1);
  }

  const skippedNames = [];
  const items = lib.inventory(lib.AGENT, skippedNames);
  for (const rel of skippedNames) console.log(`  SKIPPED  ${rel}  (name looks like a credential)`);
  if (items.length === 0) {
    console.log('Nothing to export — ~/.pi/agent looks empty.');
    return;
  }

  const state = lib.readState();
  let changed = 0;
  let same = 0;
  let kept = 0;
  let skipped = skippedNames.length;

  for (const item of items) {
    const src = path.join(lib.AGENT, item.rel);
    const dest = path.join(lib.MIRROR, item.rel);
    const label = item.rel;

    let next;
    let notes = [];

    if (item.kind === 'json') {
      const json = lib.readJson(src);
      if (json === null) {
        console.error(`  FAILED  ${label}  (not valid JSON)`);
        continue;
      }
      notes = lib.scrub(item.rel, json);
      next = JSON.stringify(json, null, 2) + '\n';
    } else {
      next = fs.readFileSync(src);
    }
    const bytes = Buffer.isBuffer(next) ? next : Buffer.from(next);

    // A file that holds a credential never reaches the repo, whatever it is called.
    const secrets = lib.secretsIn(bytes.toString('utf8'));
    if (secrets.length > 0) {
      console.log(`  SKIPPED  ${label}  (looks like a secret: ${secrets.join(', ')})`);
      skipped++;
      continue;
    }

    const prev = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
    const unchanged = prev !== null && (
      item.kind === 'json'
        ? lib.sameJson(prev.toString('utf8'), next)
        : prev.equals(bytes)
    );

    if (unchanged) {
      same++;
      // Record it only if it is not a hand edit; a hand edit stays unrecorded so the commit step keeps it.
      if (lib.recordable(state, item.rel, prev)) state[lib.key(item.rel)] = lib.sha(prev);
      continue;
    }
    // Gone from the repo while this machine's copy still matches the last sync: it was deleted upstream and the
    // delete has not reached this machine yet (e.g. import held it over the deletion cap). Adding it back would undo it.
    if (!FORCE && prev === null && lib.recordedHash(state, item.rel) === lib.sha(bytes)) {
      console.log(`  pending ${label}  (deleted in the repo: run import to delete it here, or --force to add it back)`);
      kept++;
      continue;
    }
    if (!FORCE && lib.editedInRepo(state, item.rel, prev)) {
      // Only the repo copy changed (a hand edit, or a pull not imported yet): nothing to export, no conflict.
      if (lib.recordedHash(state, item.rel) === lib.sha(bytes)) {
        console.log(`  keep    ${label}  (edited in the repo)`);
        kept++;
        continue;
      }
      console.log(`  conflict ${label}  (edited in the repo and changed on this machine: kept; commit the edit and run import, or --force to replace it)`);
      kept++;
      continue;
    }
    if (DRY) {
      console.log(`  WOULD   ${label}${prev === null ? '  (add)' : '  (update)'}`);
      changed++;
      continue;
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    state[lib.key(item.rel)] = lib.sha(bytes);
    console.log(`  export  ${label}${notes.length ? '   [' + notes.join('; ') + ']' : ''}`);
    changed++;
  }

  const del = lib.planDeletes({
    state,
    direction: 'export',
    onSource: (k) => fs.existsSync(path.join(lib.AGENT, k)),
    targetHash: (k) => {
      const f = path.join(lib.MIRROR, k);
      return fs.existsSync(f) ? lib.sha(fs.readFileSync(f)) : null;
    },
  });
  for (const k of del.keptEdited) console.log(`  keep    ${k}  (gone from this machine but edited in the repo: not deleted)`);
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
      const f = path.join(lib.MIRROR, k);
      try {
        fs.unlinkSync(f);
        lib.pruneEmptyParents(path.dirname(f), lib.MIRROR);
      } catch (e) {
        console.log(`  WARNING  could not delete ${k}: ${e.message}`);
        continue;
      }
      state[k] = { deleted: true };
      console.log(`  delete  ${k}`);
    }
  }

  const keptNote = (kept ? `, ${kept} kept (edited in the repo, or pending)` : '') + (skipped ? `, ${skipped} skipped (possible secrets — not synced)` : '');
  if (DRY) {
    console.log(`\nDry run — ${changed} file(s) would change, ${del.toDelete.length} would be deleted, ${same} already current${keptNote}.`);
    if (overCap) process.exitCode = 2;
    return;
  }
  lib.writeState(state);
  if (overCap) process.exitCode = 2;
  console.log(`\n${changed} file(s) written, ${same} already current${keptNote}.`);
  if (changed > 0 || (del.toDelete.length > 0 && !overCap)) console.log('Review with `git diff`, then commit.');
}

main();
