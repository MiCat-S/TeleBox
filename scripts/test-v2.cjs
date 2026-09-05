'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const plugins = path.resolve(root, '../TeleBox-Plugins');

function run(args) {
  const result = spawnSync(process.execPath, args, {cwd: root, stdio: 'inherit', shell: false});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
run([tsc, '-p', 'tsconfig.v2.json']);
run([tsc, '-p', '../TeleBox-Plugins/tsconfig.v2.json']);
run([path.join(__dirname, 'build-v2.cjs'), '--test']);
const tests = [];
function visit(directory) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.isFile() && file.endsWith('.test.js')) tests.push(file);
  }
}
visit(path.join(root, 'dist/v2'));
if (!tests.length) throw new Error('No compiled v2 tests found');
tests.push(path.join(__dirname, 'build-v2.test.cjs'));
tests.push(path.join(__dirname, 'build-v2-plugin.test.cjs'));
const extensionTests = fs.readdirSync(path.join(plugins, 'scripts'), {withFileTypes: true})
  .filter(entry => entry.isFile() && /-v2(?:-[a-z0-9-]+)?\.test\.js$/.test(entry.name))
  .map(entry => path.join(plugins, 'scripts', entry.name));
if (!extensionTests.length) throw new Error('No migrated extension tests found');
tests.push(...extensionTests);
run(['--unhandled-rejections=strict', '--test', ...tests.sort()]);
