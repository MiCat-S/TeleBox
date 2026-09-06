'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
test('packaging and runtime agree on the two default repository plugins', () => {
  const {DAILY_PLUGINS} = require('./package-v2-daily.cjs');
  const runtime = require('../dist/v2/runtime.js');
  assert.deepEqual(DAILY_PLUGINS, ['ai', 'gt']);
  assert.deepEqual(runtime.DAILY_PLUGINS, DAILY_PLUGINS);
});
test('runtime loads only the requested default builtins', () => {
  const runtime = fs.readFileSync(path.join(root, 'src/v2/runtime.ts'), 'utf8');
  const calls = [...runtime.matchAll(/await host\.load\((create\w+)\(/g)].map(match => match[1]).sort();
  assert.deepEqual(calls, ['createHelp', 'createAlias', 'createPrefix', 'createLogLevel',
    'createMemory', 'createPing', 'createStatus', 'createEnv', 'createSysinfo', 'createVersion',
    'createAgent', 'createExec', 'createBf', 'createSudo', 'createTpm', 'createUpdate', 'createAutofix'].sort());
  assert.match(runtime, /await host\.load\(restart\)/);
});
