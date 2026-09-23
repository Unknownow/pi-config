/**
 * lib.js — what counts as "your Pi setup", shared by export.js and import.js.
 *
 * The repo mirrors `~/.pi/agent` under `pi/agent`. That one rule covers
 * settings, every extension's config file, the extension version pins, and the
 * global skills / prompts / themes / extensions folders — including ones that
 * do not exist yet. Anything secret, machine-local or rebuildable is excluded
 * by name below.
 *
 * Neither direction ever deletes. A file you have and the other machine does
 * not is added; a file you removed stays in the repo until you `git rm` it.
 * Mirroring deletions would mean machine A wiping machine B's config simply by
 * never having installed that extension.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const AGENT = path.join(os.homedir(), '.pi', 'agent');
const REPO = path.resolve(__dirname, '..');
/** The mirror root inside the repo. `pi/agent/x` <-> `~/.pi/agent/x`. */
const MIRROR = path.join(REPO, 'pi', 'agent');

// ---------------------------------------------------------------------------
// What is in, what is out
// ---------------------------------------------------------------------------

/** Credentials and per-machine state. Never read, never written. */
const DENY_FILES = new Set([
  'auth.json',        // OAuth access + refresh tokens
  'trust.json',       // per-machine trusted project paths
  'models-store.json' // regenerates from the catalogs
]);

/** Directories mirrored whole. Everything Pi discovers globally. */
const MIRROR_DIRS = ['skills', 'prompts', 'themes', 'extensions'];

/** Directories never mirrored, whatever they contain. */
const DENY_DIRS = new Set([
  'bin',       // fd / rg platform binaries, fetched by Pi
  'sessions',  // conversation history, per-machine
  'node_modules'
]);

/** Live SQLite, backups, OS noise. Syncing any of these corrupts or clutters. */
function isJunk(name) {
  return (
    name.startsWith('.') ||
    name.includes('.bak-') ||
    /\.(db|sqlite)(-shm|-wal)?$/.test(name) ||
    name === 'package-lock.json' ||
    name === 'Thumbs.db' ||
    name === '.DS_Store'
  );
}

// ---------------------------------------------------------------------------
// Placeholders — values that are true on one machine only
// ---------------------------------------------------------------------------

const CLAUDE_PLACEHOLDER = '__CLAUDE_EXECUTABLE__';
const REPO_PLACEHOLDER = '__PI_CONFIG_REPO__';

/** Path equality the way the filesystem sees it: separators and case are noise on Windows. */
function samePath(a, b) {
  const norm = (s) => path.resolve(s).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/** True when `p` points at something inside this repo. */
function insideRepo(p) {
  const rel = path.relative(REPO, path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * settings.json can point at resources living in this repo — the sync extension
 * itself, and any skills/prompts/themes you keep here. Those absolute paths are
 * meaningless on the next machine, so they travel as `__PI_CONFIG_REPO__/...`.
 */
const PATH_ARRAYS = ['extensions', 'skills', 'prompts', 'themes'];

function scrubSettings(json, notes) {
  for (const key of PATH_ARRAYS) {
    if (!Array.isArray(json[key])) continue;
    json[key] = json[key].map((entry) => {
      if (typeof entry !== 'string' || !path.isAbsolute(entry) || !insideRepo(entry)) return entry;
      const rel = path.relative(REPO, path.resolve(entry)).replace(/\\/g, '/');
      notes.push(`${key}[] -> ${REPO_PLACEHOLDER}/${rel}`);
      return `${REPO_PLACEHOLDER}/${rel}`;
    });
  }
}

function resolveSettings(json, log) {
  for (const key of PATH_ARRAYS) {
    if (!Array.isArray(json[key])) continue;
    json[key] = json[key].map((entry) => {
      if (typeof entry !== 'string' || !entry.startsWith(REPO_PLACEHOLDER)) return entry;
      const resolved = path.join(REPO, entry.slice(REPO_PLACEHOLDER.length).replace(/^[\\/]+/, ''));
      log(`${key}[] -> ${resolved}`);
      return resolved;
    });
  }
  registerSyncExtension(json, log);
}

/**
 * Every machine that imports should also run the sync extension, otherwise the
 * automation never starts. Add it unless some entry already points at it.
 */
function registerSyncExtension(json, log) {
  const ext = path.join(REPO, 'extension');
  if (!fs.existsSync(path.join(ext, 'index.ts'))) return;
  const list = Array.isArray(json.extensions) ? json.extensions : [];
  if (list.some((e) => typeof e === 'string' && samePath(e, ext))) return;
  json.extensions = [...list, ext];
  log(`extensions[] += ${ext}`);
}

/** Find the Claude Code executable on this machine. */
function detectClaude() {
  const { execSync } = require('child_process');
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

/** Machine -> repo. Mutates `json`, returns human-readable notes. */
function scrub(rel, json) {
  const notes = [];
  const name = path.basename(rel);
  if (name === 'settings.json') scrubSettings(json, notes);
  if (name === 'claude-bridge.json' && json.provider &&
      typeof json.provider.pathToClaudeCodeExecutable === 'string') {
    notes.push(`pathToClaudeCodeExecutable -> ${CLAUDE_PLACEHOLDER}`);
    json.provider.pathToClaudeCodeExecutable = CLAUDE_PLACEHOLDER;
  }
  return notes;
}

/** Repo -> machine. Mutates `json`, returns warnings worth printing loudly. */
function resolvePlaceholders(rel, json, overrides, log) {
  const warnings = [];
  const name = path.basename(rel);
  if (name === 'settings.json') resolveSettings(json, log);
  if (name === 'claude-bridge.json' && json.provider &&
      json.provider.pathToClaudeCodeExecutable === CLAUDE_PLACEHOLDER) {
    const resolved = overrides.pathToClaudeCodeExecutable || detectClaude();
    if (resolved) {
      json.provider.pathToClaudeCodeExecutable = resolved;
      log(`claude executable -> ${resolved}`);
    } else {
      delete json.provider.pathToClaudeCodeExecutable;
      warnings.push(
        'Could not locate the Claude Code executable. Removed the setting so the\n' +
        '          bridge falls back to PATH. If that fails, set it in local/machine.json:\n' +
        '            { "pathToClaudeCodeExecutable": "/full/path/to/claude" }'
      );
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/** Every file under `dir`, as paths relative to it. Skips junk and denied dirs. */
function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (isJunk(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (DENY_DIRS.has(entry.name)) continue;
      out.push(...walk(abs, base));
    } else {
      out.push(path.relative(base, abs).replace(/\\/g, '/'));
    }
  }
  return out;
}

/**
 * The sync set, as paths relative to `root` (either ~/.pi/agent or pi/agent).
 * Both sides use the same rules, so export and import can never disagree about
 * what is in scope.
 */
function inventory(root) {
  const items = [];
  if (!fs.existsSync(root)) return items;

  // Top-level JSON: settings.json plus one config file per extension.
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || isJunk(entry.name)) continue;
    if (!entry.name.endsWith('.json') || DENY_FILES.has(entry.name)) continue;
    items.push({ rel: entry.name, kind: 'json' });
  }

  // Extension version pins. node_modules stays out; `npm install` rebuilds it.
  if (fs.existsSync(path.join(root, 'npm', 'package.json'))) {
    items.push({ rel: 'npm/package.json', kind: 'json' });
  }

  // Global resource folders, whole.
  for (const dir of MIRROR_DIRS) {
    for (const rel of walk(path.join(root, dir))) {
      items.push({ rel: `${dir}/${rel}`, kind: 'file' });
    }
  }
  return items;
}

/** Read JSON, or null when missing/unparseable. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** Compare by meaning: Pi rewrites these files with its own formatting. */
function sameJson(a, b) {
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch (_) {
    return false;
  }
}

module.exports = {
  AGENT, REPO, MIRROR,
  MIRROR_DIRS, DENY_FILES, DENY_DIRS,
  CLAUDE_PLACEHOLDER, REPO_PLACEHOLDER,
  inventory, walk, scrub, resolvePlaceholders, detectClaude,
  readJson, sameJson, samePath, insideRepo, isJunk,
};
