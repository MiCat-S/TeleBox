'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
test('public commands select the compiled V2 runtime and build chain', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.start, 'node dist/v2/index.js --serve');
  assert.equal(pkg.scripts.login, 'node scripts/login-v2.cjs');
  assert.equal(pkg.scripts.build, 'node scripts/package-v2-daily.cjs');
  assert.equal(pkg.scripts.test, 'node scripts/test-v2.cjs');
  for (const command of Object.values(pkg.scripts)) {
    assert.doesNotMatch(command, /run-tsx|src\/index|src\/plugin|pm2/);
  }
});
test('deployment has one systemd entrypoint', () => {
  const unit = fs.readFileSync(path.join(root, 'deploy/systemd/telebox-v2.service'), 'utf8');
  assert.match(unit, /^ExecStart=\/usr\/bin\/node \/root\/telebox\/dist\/v2\/index.js --serve$/m);
  for (const file of ['ecosystem.config.cjs', 'src/index.ts', 'scripts/deploy-v2-production.sh', 'scripts/restore-v2-production.sh']) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  }
});
