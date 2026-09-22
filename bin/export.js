#!/usr/bin/env node
/**
 * export.js — capture this machine's portable Pi config into the repo.
 *
 * Reads  ~/.pi/agent/<file>   ->  writes  <repo>/config/<name>.json
 * Machine-specific values are replaced with placeholders so the committed
 * files stay portable. Credentials are never read.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const AGENT = path.join(os.homedir(), '.pi', 'agent');
const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, 'config');

/** Files we sync. `from` is relative to ~/.pi/agent. */
const FILES = [
  { from: 'settings.json', to: 'settings.json' },
  { from: 'claude-bridge.json', to: 'claude-bridge.json' },
  { from: 'hermes-memory-config.json', to: 'hermes-memory-config.json' },
  { from: path.join('npm', 'package.json'), to: 'npm-package.json' },
];

/** Never read these, even by accident. */
const FORBIDDEN = new Set(['auth.json', 'trust.json', 'models-store.json']);

const CLAUDE_PLACEHOLDER = '__CLAUDE_EXECUTABLE__';

function scrub(name, json) {
  if (name !== 'claude-bridge.json') return { json, notes: [] };
  const notes = [];
  if (json.provider && typeof json.provider.pathToClaudeCodeExecutable === 'string') {
    notes.push(`pathToClaudeCodeExecutable -> ${CLAUDE_PLACEHOLDER}`);
    json.provider.pathToClaudeCodeExecutable = CLAUDE_PLACEHOLDER;
  }
  return { json, notes };
}

function main() {
  if (!fs.existsSync(AGENT)) {
    console.error(`No Pi install found at ${AGENT}`);
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  let exported = 0;
  for (const f of FILES) {
    const base = path.basename(f.from);
    if (FORBIDDEN.has(base)) {
      console.error(`refusing to export ${base}`);
      continue;
    }
    const src = path.join(AGENT, f.from);
    if (!fs.existsSync(src)) {
      console.log(`  skip    ${f.from}  (not present on this machine)`);
      continue;
    }
    let json;
    try {
      json = JSON.parse(fs.readFileSync(src, 'utf8'));
    } catch (e) {
      console.error(`  FAILED  ${f.from}  (not valid JSON: ${e.message})`);
      continue;
    }
    const { json: clean, notes } = scrub(f.to, json);
    fs.writeFileSync(path.join(OUT, f.to), JSON.stringify(clean, null, 2) + '\n');
    console.log(`  export  ${f.from}  ->  config/${f.to}${notes.length ? '   [' + notes.join('; ') + ']' : ''}`);
    exported++;
  }

  // Global skills, if any exist yet.
  const skillsSrc = path.join(AGENT, 'pi-hermes-memory', 'skills');
  const skillsOut = path.join(REPO, 'skills');
  if (fs.existsSync(skillsSrc)) {
    const entries = fs.readdirSync(skillsSrc).filter((n) => !n.startsWith('.'));
    if (entries.length) {
      fs.mkdirSync(skillsOut, { recursive: true });
      for (const n of entries) {
        fs.cpSync(path.join(skillsSrc, n), path.join(skillsOut, n), { recursive: true });
        console.log(`  export  skills/${n}`);
        exported++;
      }
    } else {
      console.log('  skip    global skills  (none created yet)');
    }
  }

  console.log(`\n${exported} item(s) exported to ${OUT}`);
  console.log('Review with `git diff`, then commit.');
}

main();
