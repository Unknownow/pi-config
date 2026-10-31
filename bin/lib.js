/**
 * lib.js — what counts as "your Pi setup", shared by export.js and import.js.
 *
 * The repo mirrors `~/.pi/agent` under `pi/agent`. That one rule covers
 * settings, every extension's config file, the extension version pins, and the
 * global skills / prompts / themes / extensions folders — including ones that
 * do not exist yet. Anything secret, machine-local or rebuildable is excluded
 * by name below.
 *
 * Deletions are mirrored only for files this machine's sync record knows (see
 * planDeletes below): a file that was synced, is now gone on one side and is
 * unchanged on the other is deleted there too. A file with no record is never
 * deleted, so a machine that never had an extension cannot wipe it elsewhere.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

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

/** Global context files: instructions Pi adds to every session, on any machine. */
const CONTEXT_FILES = new Set(['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'SYSTEM.md', 'APPEND_SYSTEM.md']);

/** Directories mirrored whole. Everything Pi discovers globally. */
const MIRROR_DIRS = ['skills', 'prompts', 'themes', 'extensions'];

/** Directories never mirrored, whatever they contain. */
const DENY_DIRS = new Set([
  'bin',       // fd / rg platform binaries, fetched by Pi
  'sessions',  // conversation history, per-machine
  'node_modules'
]);

/**
 * Names that look like credentials: skipped on export whatever they contain.
 * Keep in sync with the copy in extension/index.ts (inScope). "token" is left out on
 * purpose: it would match extensions/workflow/tokens.ts.
 */
const SECRET_NAME_PATTERNS = [
  /(^|[._-])(o?auth|credentials?|secrets?)([._-]|$)/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/
];

/** Source and docs about credentials are not credentials; the content scan still covers them. */
const CODE_OR_DOC = /\.(js|mjs|cjs|jsx|ts|tsx|md|sh|bat)$/i;

function isSecretName(name) {
  if (CODE_OR_DOC.test(name)) return false;
  return SECRET_NAME_PATTERNS.some((re) => re.test(name));
}

/** Values that are placeholders or references, not secrets. */
const PLACEHOLDER_VALUE = /^(__\w+__|\$\{[^}]+\}|env:|<|your|example|changeme|x{4,})/i;

const SECRET_CONTENT = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, 'API key (sk-)'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/, 'GitHub token'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bAIza[0-9A-Za-z_-]{35}/, 'Google API key'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/, 'GitLab token'],
  [/\bnpm_[A-Za-z0-9]{36}/, 'npm token'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./, 'JWT']
];

const SECRET_PAIR = /"(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|private[_-]?key|bearer|authorization)"\s*:\s*"([^"]{8,})"/gi;

/** Reasons `text` looks like it holds a credential; empty when it does not. */
function secretsIn(text) {
  const reasons = [];
  for (const [re, why] of SECRET_CONTENT) if (re.test(text) && !reasons.includes(why)) reasons.push(why);
  for (const m of text.matchAll(SECRET_PAIR)) {
    if (PLACEHOLDER_VALUE.test(m[2].replace(/^(Bearer|Basic|Token)\s+/i, ''))) continue;
    const why = `"${m[1]}" has a literal value`;
    if (!reasons.includes(why)) reasons.push(why);
  }
  return reasons;
}

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

/**
 * Settings Pi writes about this install rather than about your setup. They stay
 * out of the repo, and import keeps the machine's own value: syncing
 * `lastChangelogVersion` from a machine on another Pi version made every start
 * import, warn "restart Pi to apply" and skip the export that would end it.
 */
const MACHINE_KEYS = ['lastChangelogVersion'];

/**
 * Relative resource paths are written with `/`: Windows accepts it, POSIX needs it.
 * Absolute paths and repo placeholders are left alone; a leading +, - or ! marker is kept.
 */
function normalizeSettingsPaths(json) {
  const fix = (list) => list.map((entry) => {
    if (typeof entry !== 'string') return entry;
    const bare = entry.replace(/^[+!-]/, '');
    if (path.isAbsolute(bare) || /^[A-Za-z]:[\\/]|^\\\\/.test(bare) || bare.startsWith(REPO_PLACEHOLDER)) return entry;
    return entry.replace(/\\/g, '/');
  });
  const apply = (obj) => {
    for (const key of PATH_ARRAYS) if (Array.isArray(obj[key])) obj[key] = fix(obj[key]);
  };
  apply(json);
  if (Array.isArray(json.packages)) {
    for (const pkg of json.packages) if (pkg && typeof pkg === 'object') apply(pkg);
  }
}

function scrubSettings(json, notes) {
  normalizeSettingsPaths(json);
  for (const key of MACHINE_KEYS) delete json[key];
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
  normalizeSettingsPaths(json);
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

/** Repo -> machine: keep this machine's MACHINE_KEYS from `current`, its settings before the import. */
function keepMachineKeys(rel, json, current) {
  if (path.basename(rel) !== 'settings.json') return;
  for (const key of MACHINE_KEYS) {
    delete json[key];
    if (current && current[key] !== undefined) json[key] = current[key];
  }
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
function walk(dir, base = dir, skipped = []) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (isJunk(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (!entry.isDirectory() && isSecretName(entry.name)) {
      skipped.push(path.relative(base, abs).replace(/\\/g, '/'));
      continue;
    }
    if (entry.isDirectory()) {
      if (DENY_DIRS.has(entry.name)) continue;
      out.push(...walk(abs, base, skipped));
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
function inventory(root, skipped = []) {
  const items = [];
  if (!fs.existsSync(root)) return items;

  // Top-level JSON: settings.json plus one config file per extension; and the global context files.
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || isJunk(entry.name)) continue;
    if (isSecretName(entry.name) && !DENY_FILES.has(entry.name)) {
      skipped.push(entry.name);
      continue;
    }
    if (CONTEXT_FILES.has(entry.name)) {
      items.push({ rel: entry.name, kind: 'file' });
      continue;
    }
    if (!entry.name.endsWith('.json') || DENY_FILES.has(entry.name)) continue;
    items.push({ rel: entry.name, kind: 'json' });
  }

  // Extension version pins. node_modules stays out; `npm install` rebuilds it.
  if (fs.existsSync(path.join(root, 'npm', 'package.json'))) {
    items.push({ rel: 'npm/package.json', kind: 'json' });
  }

  // Global resource folders, whole.
  for (const dir of MIRROR_DIRS) {
    const base = path.join(root, dir);
    const inner = [];
    for (const rel of walk(base, base, inner)) {
      items.push({ rel: `${dir}/${rel}`, kind: 'file' });
    }
    for (const rel of inner) skipped.push(`${dir}/${rel}`);
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

/** Same value with object keys sorted, so key order never counts as a change. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
}

/** Compare by meaning: Pi rewrites these files with its own formatting. */
function sameJson(a, b) {
  try {
    return JSON.stringify(sortKeys(JSON.parse(a))) === JSON.stringify(sortKeys(JSON.parse(b)));
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sync record: the hash of each mirror file as it last moved between the repo
// and this machine (written by export and import). export.js uses it to tell an
// edit made in the repo, which it keeps, from a machine change, which it writes.
// The commit step only commits files that still match it. Per machine, gitignored.
// ---------------------------------------------------------------------------

const STATE = path.join(REPO, 'local', 'sync-state.json');

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Key for a mirror file: its path under pi/agent, with forward slashes. */
function key(rel) {
  return rel.split(path.sep).join('/');
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Hashes of the file as committed in HEAD: the raw blob and the working-copy form
 * (`--filters` applies the autocrlf/eol rules). Either can match a file on disk.
 */
function headShas(rel) {
  const out = new Set();
  const object = `HEAD:pi/agent/${key(rel)}`;
  for (const args of [['cat-file', 'blob', object], ['cat-file', '--filters', `--path=pi/agent/${key(rel)}`, object]]) {
    try {
      out.add(sha(execFileSync('git', args, { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] })));
    } catch {
      // not in HEAD
    }
  }
  return out;
}

/** The recorded hash of a mirror file; a file marked deleted has none. */
function recordedHash(state, rel) {
  const v = state[key(rel)];
  return typeof v === 'string' ? v : undefined;
}

/**
 * True when a mirror file (`prev`, its current bytes) was changed in the repo by hand: its
 * bytes differ from the last sync record. With no record, the committed file is the baseline.
 */
function editedInRepo(state, rel, prev) {
  if (prev === null) return false;
  const current = sha(prev);
  const recorded = recordedHash(state, rel);
  return recorded !== undefined ? current !== recorded : !headShas(rel).has(current);
}

/**
 * Whether the sync record may be set to these bytes: not a hand edit, or a change that is
 * already committed (a pulled-in change, which import must record or it would never sync).
 */
function recordable(state, rel, prev) {
  return !editedInRepo(state, rel, prev) || headShas(rel).has(sha(prev));
}

/** Mirroring more deletions than this at once needs --allow-deletes. */
function tooMany(n, recorded) {
  return n > 20 || n > 0.25 * recorded;
}

/**
 * Which recorded files to delete on the target side. Pure: the caller supplies
 *   state       the sync record
 *   direction   'export' (target is the repo) or 'import' (target is this machine)
 *   onSource    (key) => true while the file still exists on the source side
 *   targetHash  (key) => hash of the target copy in the form the record holds
 *               (JSON scrubbed like the export writes it), or null when absent
 * A file goes only when it has a record, is gone from the source and the target copy
 * still matches the record; an edited target copy is kept (keptEdited).
 */
function planDeletes({ state, direction, onSource, targetHash }) {
  const toDelete = [];
  const keptEdited = [];
  let recorded = 0;
  for (const k of Object.keys(state)) {
    if (typeof state[k] !== 'string') continue;
    recorded++;
    if (onSource(k)) continue;
    const h = targetHash(k);
    if (h === null) continue;
    (h === state[k] ? toDelete : keptEdited).push(k);
  }
  return { toDelete: toDelete.sort(), keptEdited: keptEdited.sort(), recorded, direction };
}

/** Remove empty folders from `dir` upwards, stopping before `stop`. */
function pruneEmptyParents(dir, stop) {
  let d = path.resolve(dir);
  const end = path.resolve(stop);
  while (d !== end && d.startsWith(end + path.sep)) {
    try {
      if (fs.readdirSync(d).length > 0) return;
      fs.rmdirSync(d);
    } catch (_) {
      return;
    }
    d = path.dirname(d);
  }
}

module.exports = {
  planDeletes, tooMany, pruneEmptyParents, recordedHash,
  AGENT, REPO, MIRROR, STATE,
  readState, writeState, editedInRepo, recordable, sha, key,
  MIRROR_DIRS, DENY_FILES, DENY_DIRS, isSecretName, secretsIn,
  CLAUDE_PLACEHOLDER, REPO_PLACEHOLDER,
  inventory, walk, scrub, resolvePlaceholders, keepMachineKeys, detectClaude,
  normalizeSettingsPaths, readJson, sameJson, samePath, insideRepo, isJunk,
};
