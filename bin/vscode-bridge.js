#!/usr/bin/env node
/**
 * vscode-bridge.js — build and install the pi-terminal-bridge VS Code extension.
 *
 *   node bin/vscode-bridge.js                 install, fail if `code` is missing
 *   node bin/vscode-bridge.js --if-available  skip quietly if `code` is missing
 */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const lib = require('./lib');

function wrap(platform, file, args) {
  return platform === 'win32'
    ? { file: 'cmd.exe', args: ['/d', '/c', file, ...args] }
    : { file, args };
}

function installCommands(platform, vsix) {
  return [
    wrap(platform, 'npx', ['--yes', '@vscode/vsce', 'package', '--no-dependencies',
      '--allow-missing-repository', '--skip-license', '-o', vsix]),
    wrap(platform, 'code', ['--install-extension', vsix, '--force']),
  ];
}

function codeAvailable(platform) {
  const c = wrap(platform, 'code', ['--version']);
  const r = spawnSync(c.file, c.args, { stdio: 'ignore', timeout: 30000 });
  return !r.error && r.status === 0;
}

function main() {
  const src = path.join(lib.REPO, 'pi', 'agent', 'extensions', 'worktree', 'vscode');
  if (!fs.existsSync(path.join(src, 'package.json'))) {
    console.error(`ERROR: bridge source not found in ${src}`);
    process.exit(1);
  }
  if (!codeAvailable(process.platform)) {
    if (process.argv.includes('--if-available')) {
      console.log("Skipped: the VS Code 'code' command is not on PATH. Run 'pi-config vscode' after installing VS Code.");
      process.exit(0);
    }
    console.error("ERROR: the VS Code 'code' command is not on PATH.");
    process.exit(1);
  }
  const vsix = path.join(os.tmpdir(), 'pi-terminal-bridge.vsix');
  const labels = ['packaging', 'installing'];
  const cmds = installCommands(process.platform, vsix);
  for (let i = 0; i < cmds.length; i++) {
    const r = spawnSync(cmds[i].file, cmds[i].args, { cwd: src, stdio: 'inherit', timeout: 180000 });
    if (r.error || r.status !== 0) {
      console.error(`ERROR: ${labels[i]} the bridge failed (exit ${r.error ? r.error.message : r.status}).`);
      process.exit(1);
    }
  }
  console.log('Installed pi-terminal-bridge. Reload each VS Code window, then open a new terminal.');
}

if (require.main === module) main();

module.exports = { installCommands, codeAvailable };
