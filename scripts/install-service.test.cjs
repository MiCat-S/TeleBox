'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const script = path.join(__dirname, 'install-service.sh');
test('service installer passes bash syntax validation', () => {
  const result = spawnSync('bash', ['-n', script], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
});
test('installer help is available without root or systemd and does not install', () => {
  const result = spawnSync('bash', [script, '--help'], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Requires Linux\/systemd/);
  assert.match(result.stdout, /Refuses active or enabled services/);
});
test('installer rejects unexpected arguments before operating on host', () => {
  const result = spawnSync('bash', [script, '--force'], {encoding: 'utf8'});
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unsupported arguments/);
});
test('public installer command and documented invocation match', () => {
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['service:install'], 'bash scripts/install-service.sh');
  assert.match(fs.readFileSync(path.join(root, 'INSTALL.md'), 'utf8'), /npm run service:install/);
});
