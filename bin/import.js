#!/usr/bin/env node
/**
 * import.js — apply the repo's Pi setup to this machine.
 *
 *   <repo>/pi/agent/<x>  ->  ~/.pi/agent/<x>
 *
 * Placeholders are resolved from local/machine.json or auto-detected. Every
 * file that gets overwritten is backed up to <name>.bak-<timestamp> first.
 * Nothing on this machine is deleted.
 *
 *   node bin/import.js            apply
 *   node bin/import.js --dry-run  show what would change, write nothing
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
  if (!fs.existsSync(lib.MIRROR)) {
    console.error(`No pi/agent directory in ${lib.REPO}. Run \`node bin/export.js\` on a configured machine first.`);
    process.exit(1);
  }

  const items = lib.inventory(lib.MIRROR);
  const overrides = loadOverrides();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const warnings = [];
  let changed = 0;
  let same = 0;

  for (const item of items) {
    const src = path.join(lib.MIRROR, item.rel);
    const dest = path.join(lib.AGENT, item.rel);
    const label = item.rel;
    const note = (line) => { if (!DRY) console.log(`          ${line}`); };

    let next;
    if (item.kind === 'json') {
      const json = lib.readJson(src);
      if (json === null) {
        console.error(`  FAILED  ${label}  (not valid JSON)`);
        continue;
      }
      warnings.push(...lib.resolvePlaceholders(item.rel, json, overrides, note));
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
    console.log(`  write   ${label}`);
    changed++;
  }

  if (DRY) {
    console.log(`\nDry run — ${changed} file(s) would change, ${same} already current.`);
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
