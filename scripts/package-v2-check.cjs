'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {build} = require('./build-v2.cjs');
const {buildPlugin} = require('./build-v2-plugin.cjs');
const {DAILY_PLUGINS} = require('./package-v2-daily.cjs');

function packageCheck() {
  const project = path.resolve(__dirname, '..');
  build();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telebox-v2-server-'));
  const candidate = path.join(root, 'candidate');
  fs.mkdirSync(path.join(candidate, 'scripts'), {recursive: true});
  fs.cpSync(path.join(project, 'dist/v2'), path.join(candidate, 'dist/v2'), {recursive: true});
  for (const name of ['server-v2-check.cjs', 'server-v2-check.sh']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(candidate, 'scripts', name));
  }
  for (const id of DAILY_PLUGINS) {
    const artifact = buildPlugin({id, packageRoot: path.resolve(project, '../TeleBox-Plugins', id), entry: 'v2.ts'});
    fs.cpSync(artifact.artifactDir, path.join(candidate, 'plugins', id), {recursive: true});
  }
  const archive = path.join(root, 'candidate.tar');
  // macOS copyfile metadata becomes extra ._* files under GNU tar and violates
  // the plugin manifest. Keep the verified artifact's byte/file set portable.
  const result = spawnSync('tar', ['-cf', archive, '-C', root, 'candidate'], {
    encoding: 'utf8', env: {...process.env, COPYFILE_DISABLE: '1'},
  });
  if (result.status !== 0) throw new Error('Validation archive packaging failed');
  return {archive, sha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex')};
}
if (require.main === module) {
  try {console.log(JSON.stringify(packageCheck()));}
  catch {console.error('Validation archive packaging failed'); process.exitCode = 1;}
}
module.exports = {packageCheck};
