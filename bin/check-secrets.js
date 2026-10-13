#!/usr/bin/env node
/**
 * check-secrets.js — refuse to commit files that look like credentials.
 *
 *   node bin/check-secrets.js --staged     check what is staged (the pre-commit hook)
 *   node bin/check-secrets.js <file>...   check the given files
 *
 * The rules live in lib.js (isSecretName, secretsIn), shared with export.js.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./lib');

function git(args) {
  return execFileSync('git', args, { cwd: lib.REPO, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function main() {
  const staged = process.argv.includes('--staged');
  let files;
  if (staged) {
    files = git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']).toString('utf8').split('\0').filter(Boolean);
  } else {
    files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  }

  const flagged = [];
  for (const file of files) {
    const name = path.basename(file);
    if (lib.isSecretName(name)) {
      flagged.push([file, 'name looks like a credential']);
      continue;
    }
    let buf;
    try {
      buf = staged ? git(['show', `:${file}`]) : fs.readFileSync(path.resolve(lib.REPO, file));
    } catch (_) {
      continue; // gone, a directory or a submodule
    }
    if (buf.includes(0)) continue; // binary
    const reasons = lib.secretsIn(buf.toString('utf8'));
    if (reasons.length > 0) flagged.push([file, reasons.join(', ')]);
  }

  if (flagged.length === 0) return;
  console.error('pi-config: refusing to commit possible secrets:');
  for (const [file, why] of flagged) console.error(`  ${file}  (${why})`);
  console.error('Unstage with: git restore --staged <path>. False positive? Adjust secretsIn in bin/lib.js.');
  process.exit(1);
}

main();
