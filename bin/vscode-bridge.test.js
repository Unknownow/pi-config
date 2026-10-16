// node --test bin/vscode-bridge.test.js
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');

const mod = require('./vscode-bridge');
const PACK = ['npx', '--yes', '@vscode/vsce', 'package', '--no-dependencies',
  '--allow-missing-repository', '--skip-license', '-o'];

test('installCommands win32 goes through cmd.exe', () => {
  assert.deepEqual(mod.installCommands('win32', 'C:/t/b.vsix'), [
    { file: 'cmd.exe', args: ['/d', '/c', ...PACK, 'C:/t/b.vsix'] },
    { file: 'cmd.exe', args: ['/d', '/c', 'code', '--install-extension', 'C:/t/b.vsix', '--force'] },
  ]);
});

test('installCommands linux runs directly', () => {
  assert.deepEqual(mod.installCommands('linux', '/tmp/b.vsix'), [
    { file: 'npx', args: PACK.slice(1).concat('/tmp/b.vsix') },
    { file: 'code', args: ['--install-extension', '/tmp/b.vsix', '--force'] },
  ]);
});

test('requiring the module runs nothing', () => {
  assert.equal(typeof mod.installCommands, 'function');
  assert.equal(typeof mod.codeAvailable, 'function');
});
