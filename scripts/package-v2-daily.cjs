'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {build} = require('./build-v2.cjs');
const {buildPlugin} = require('./build-v2-plugin.cjs');

const DAILY_PLUGINS = Object.freeze(['ai', 'da', 'dc', 'dme', 'gt', 'ids', 'ip', 'nodeseek', 'rate', 'sum', 'yvlu']);

function packageDaily(options = {}) {
  const project = fs.realpathSync(options.project || path.resolve(__dirname, '..'));
  const plugins = fs.realpathSync(options.plugins || path.resolve(project, '../TeleBox-Plugins'));
  build();
  const dist = path.join(project, 'dist');
  fs.mkdirSync(dist, {recursive: true});
  const stage = fs.mkdtempSync(path.join(dist, '.v2-plugins-active-'));
  const active = path.join(dist, 'v2-plugins-active');
  const backup = path.join(dist, `.v2-plugins-active-backup-${process.pid}`);
  const revisions = {};
  try {
    for (const id of DAILY_PLUGINS) {
      const artifact = buildPlugin({id, packageRoot: path.join(plugins, id), entry: 'v2.ts', rootDir: project});
      fs.cpSync(artifact.artifactDir, path.join(stage, id), {recursive: true, errorOnExist: true, force: false});
      revisions[id] = artifact.manifest.revision;
    }
    if (fs.existsSync(active)) fs.renameSync(active, backup);
    try { fs.renameSync(stage, active); }
    catch (error) {
      if (fs.existsSync(backup) && !fs.existsSync(active)) fs.renameSync(backup, active);
      throw error;
    }
    fs.rmSync(backup, {recursive: true, force: true});
    return {active, plugins: [...DAILY_PLUGINS], revisions};
  } finally {
    fs.rmSync(stage, {recursive: true, force: true});
  }
}

if (require.main === module) {
  try { console.log(JSON.stringify(packageDaily(), null, 2)); }
  catch { console.error('V2 daily plugin packaging failed'); process.exitCode = 1; }
}

module.exports = {DAILY_PLUGINS, packageDaily};
