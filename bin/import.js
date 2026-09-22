#!/usr/bin/env node
/**
 * import.js — apply the repo's config to this machine.
 *
 * Writes <repo>/config/*  ->  ~/.pi/agent/*
 * Machine-specific placeholders are resolved from local/machine.json, or
 * auto-detected. Existing files are backed up once per run.
 *
 *   node bin/import.js            apply
 *   node bin/import.js --dry-run  show what would change, write nothing
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const AGENT = path.join(os.homedir(), '.pi', 'agent');
const REPO = path.resolve(__dirname, '..');
const SRC = path.join(REPO, 'config');
const DRY = process.argv.includes('--dry-run');

const FILES = [
  { from: 'settings.json', to: 'settings.json' },
  { from: 'claude-bridge.json', to: 'claude-bridge.json' },
  { from: 'hermes-memory-config.json', to: 'hermes-memory-config.json' },
  { from: 'npm-package.json', to: path.join('npm', 'package.json') },
];

const CLAUDE_PLACEHOLDER = '__CLAUDE_EXECUTABLE__';

function loadOverrides() {
  const p = path.join(REPO, 'local', 'machine.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`local/machine.json is not valid JSON (${e.message}) — ignoring`);
    return {};
  }
}

/** Find the Claude Code executable on this machine. */
function detectClaude() {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c.replace(/\\/g, '/');
  try {
    const probe = process.platform === 'win32' ? 'where claude' : 'command -v claude';
    const out = execSync(probe, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split(/\r?\n/)[0];
    if (out) return out.replace(/\\/g, '/');
  } catch (_) { /* not on PATH */ }
  return null;
}

function sameJson(a, b) {
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch (_) {
    return false;
  }
}

function resolvePlaceholders(name, json, overrides) {
  const warnings = [];
  if (name === 'claude-bridge.json' && json.provider &&
      json.provider.pathToClaudeCodeExecutable === CLAUDE_PLACEHOLDER) {
    const resolved = overrides.pathToClaudeCodeExecutable || detectClaude();
    if (resolved) {
      json.provider.pathToClaudeCodeExecutable = resolved;
      console.log(`          claude executable -> ${resolved}`);
    } else {
      delete json.provider.pathToClaudeCodeExecutable;
      warnings.push(
        'Could not locate the Claude Code executable. Removed the setting so the\n' +
        '          bridge falls back to PATH. If that fails, set it in local/machine.json:\n' +
        '            { "pathToClaudeCodeExecutable": "/full/path/to/claude" }'
      );
    }
  }
  return { json, warnings };
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`No config/ directory in ${REPO}. Run \`node bin/export.js\` on a configured machine first.`);
    process.exit(1);
  }
  fs.mkdirSync(path.join(AGENT, 'npm'), { recursive: true });

  const overrides = loadOverrides();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const allWarnings = [];
  let applied = 0;

  for (const f of FILES) {
    const src = path.join(SRC, f.from);
    if (!fs.existsSync(src)) {
      console.log(`  skip    config/${f.from}  (not in repo)`);
      continue;
    }
    let json;
    try {
      json = JSON.parse(fs.readFileSync(src, 'utf8'));
    } catch (e) {
      console.error(`  FAILED  config/${f.from}  (not valid JSON: ${e.message})`);
      continue;
    }
    const { json: resolved, warnings } = resolvePlaceholders(f.from, json, overrides);
    allWarnings.push(...warnings);

    const dest = path.join(AGENT, f.to);
    const next = JSON.stringify(resolved, null, 2) + '\n';
    const prev = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null;

    // Compare by meaning, not bytes: Pi rewrites these files with its own
    // formatting, so a byte diff would report spurious changes every run.
    if (prev !== null && sameJson(prev, next)) {
      console.log(`  same    ${f.to}`);
      continue;
    }
    if (DRY) {
      console.log(`  WOULD   ${f.to}${prev === null ? '  (create)' : '  (overwrite)'}`);
      continue;
    }
    if (prev !== null) {
      const bak = `${dest}.bak-${stamp}`;
      fs.copyFileSync(dest, bak);
      console.log(`  backup  ${path.basename(bak)}`);
    }
    fs.writeFileSync(dest, next);
    console.log(`  write   ${f.to}`);
    applied++;
  }

  // Global skills.
  const skillsSrc = path.join(REPO, 'skills');
  const skillsDest = path.join(AGENT, 'pi-hermes-memory', 'skills');
  if (fs.existsSync(skillsSrc)) {
    const entries = fs.readdirSync(skillsSrc).filter((n) => !n.startsWith('.'));
    for (const n of entries) {
      if (DRY) { console.log(`  WOULD   skills/${n}`); continue; }
      fs.mkdirSync(skillsDest, { recursive: true });
      fs.cpSync(path.join(skillsSrc, n), path.join(skillsDest, n), { recursive: true });
      console.log(`  write   skills/${n}`);
      applied++;
    }
  }

  if (DRY) {
    console.log('\nDry run — nothing written.');
    return;
  }

  console.log(`\n${applied} file(s) applied.`);
  for (const w of allWarnings) console.log(`\n  WARNING  ${w}`);

  console.log('\nNext steps on this machine:');
  console.log('  1.  cd ~/.pi/agent/npm && npm install      # install the extensions');
  console.log('  2.  restart Pi');
  console.log('  3.  log in                                 # auth is deliberately not synced');
}

main();
