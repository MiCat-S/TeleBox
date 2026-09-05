'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');

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
tests.push(path.resolve(root, '../TeleBox-Plugins/scripts/gt-v2.test.js'));
tests.push(path.resolve(root, '../TeleBox-Plugins/scripts/ip-v2.test.js'));
tests.push(path.resolve(root, '../TeleBox-Plugins/scripts/ai-v2-provider.test.js'));
tests.push(path.resolve(root, '../TeleBox-Plugins/scripts/ids-v2.test.js'));
tests.push(path.resolve(root, '../TeleBox-Plugins/scripts/dc-v2.test.js'));
run(['--unhandled-rejections=strict', '--test', ...tests.sort()]);
