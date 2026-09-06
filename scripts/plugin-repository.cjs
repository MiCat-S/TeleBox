'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {buildPlugin} = require('./build-v2-plugin.cjs');

function run(action, id) {
  if (!['search', 'build'].includes(action) || action === 'build' && !/^[a-z][a-z0-9_-]{0,63}$/.test(id || '')) throw new Error('Invalid plugin request');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'mibot-plugins-'));
  try {
    const repository = path.join(stage, 'repository');
    const git = (args, cwd) => {
      const result = spawnSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args],
        {cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
          env: {...process.env, GIT_TERMINAL_PROMPT: '0'}});
      if (result.error || result.status !== 0) throw new Error('Plugin repository unavailable');
      return result.stdout;
    };
    git(['clone', '--filter=blob:none', '--no-checkout', '--depth=1', '--branch=main',
      '--single-branch', 'https://github.com/MiCat-S/Mi-Box-Plugins.git', repository],
      stage);
    const ids = git(['ls-tree', '-r', '--name-only', 'HEAD'], repository).split('\n')
      .filter(file => /^[a-z][a-z0-9_-]{0,63}\/v2\.ts$/.test(file))
      .map(file => file.split('/')[0]).sort();
    if (action === 'search') return {ids};
    if (!ids.includes(id)) throw new Error('V2 plugin not available');
    git(['sparse-checkout', 'set', '--no-cone', `/${id}/v2.ts`, `/${id}/v2/`], repository);
    git(['checkout', 'HEAD'], repository);
    const {manifest} = buildPlugin({id, packageRoot: path.join(repository, id), entry: 'v2.ts'});
    return {id, revision: manifest.revision};
  } finally {fs.rmSync(stage, {recursive: true, force: true});}
}
if (require.main === module) {
  try {console.log(JSON.stringify(run(...process.argv.slice(2))));}
  catch (error) {console.error(error.message); process.exitCode = 1;}
}
module.exports = {run};
