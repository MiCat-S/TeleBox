'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');

test('run-tsx replaces its launcher process on Node 24', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telebox-run-tsx-'));
  const probe = path.join(tempDir, 'probe.ts');
  fs.writeFileSync(probe, 'console.log(JSON.stringify({ pid: process.pid }));\n');

  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.join(root, 'scripts', 'run-tsx.cjs'), probe],
        { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, pid: child.pid, stdout, stderr }));
    });

    assert.equal(result.code, 0, result.stderr);
    const line = result.stdout.trim().split('\n').at(-1);
    const reported = JSON.parse(line);
    assert.equal(reported.pid, result.pid);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('PM2 ecosystem launches run-tsx directly', () => {
  const config = require(path.join(root, 'ecosystem.config.cjs'));
  const app = config.apps[0];
  assert.equal(app.name, 'telebox');
  assert.equal(app.script, path.join(root, 'scripts', 'run-tsx.cjs'));
  assert.deepEqual(app.args, ['./src/index.ts']);
  assert.equal(app.interpreter, process.execPath);
  assert.equal(app.max_memory_restart, '768M');
});
