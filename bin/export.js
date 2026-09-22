#!/usr/bin/env node
/**
 * export.js — capture this machine's Pi setup into the repo.
 *
 *   ~/.pi/agent/<x>  ->  <repo>/pi/agent/<x>
 *
 * What counts as "setup" lives in lib.js. Machine-specific values are replaced
 * with placeholders so the committed files stay portable. Credentials are never
 * read, and nothing in the repo is deleted.
 *
 *   node bin/export.js            capture
 *   node bin/export.js --dry-run  show what would change, write nothing
 */
'use strict';
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const DRY = process.argv.includes('--dry-run');

function main() {
  if (!fs.existsSync(lib.AGENT)) {
    console.error(`No Pi install found at ${lib.AGENT}`);
    process.exit(1);
  }

  const items = lib.inventory(lib.AGENT);
  if (items.length === 0) {
    console.log('Nothing to export — ~/.pi/agent looks empty.');
    return;
  }

  let changed = 0;
  let same = 0;

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

    const prev = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
    const unchanged = prev !== null && (
      item.kind === 'json'
        ? lib.sameJson(prev.toString('utf8'), next)
        : prev.equals(Buffer.isBuffer(next) ? next : Buffer.from(next))
    );

    if (unchanged) {
      same++;
      continue;
    }
    if (DRY) {
      console.log(`  WOULD   ${label}${prev === null ? '  (add)' : '  (update)'}`);
      changed++;
      continue;
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, next);
    console.log(`  export  ${label}${notes.length ? '   [' + notes.join('; ') + ']' : ''}`);
    changed++;
  }

  if (DRY) {
    console.log(`\nDry run — ${changed} file(s) would change, ${same} already current.`);
    return;
  }
  console.log(`\n${changed} file(s) written, ${same} already current.`);
  if (changed > 0) console.log('Review with `git diff`, then commit.');
}

main();
