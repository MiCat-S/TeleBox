'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const hash = value => createHash('sha256').update(value).digest('hex');

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function realFile(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || path.isAbsolute(relative)) throw new Error('Expected a relative package file');
  const file = path.resolve(root, relative);
  if (!inside(root, file)) throw new Error('Package file escapes its root');
  let current = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Package symlinks are not supported');
  }
  if (!fs.statSync(file).isFile()) throw new Error('Expected a regular package file');
  return file;
}

function directory(root, parts) {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try { fs.mkdirSync(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Artifact path must be an ordinary directory');
  }
  return current;
}

// Produces an immutable candidate only. Loading and selecting the active
// revision are separate runtime operations after interface validation.
function buildPlugin({id, packageRoot, entry, assets = [], rootDir = PROJECT_ROOT}) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) throw new Error('Invalid plugin id');
  const source = fs.realpathSync(packageRoot);
  const entryFile = realFile(source, entry);
  const root = fs.realpathSync(rootDir);
  const parent = directory(root, ['dist', 'v2-plugins', id]);
  const stage = fs.mkdtempSync(path.join(parent, '.stage-'));
  try {
    const output = path.join(stage, 'index.cjs');
    const metadata = path.join(stage, 'build.json');
    const result = spawnSync(require.resolve('esbuild/bin/esbuild'), [
      entryFile, '--bundle', '--packages=external',
      '--external:telebox/sdk', '--platform=node', '--format=cjs', '--target=node24',
      `--outfile=${output}`, `--metafile=${metadata}`, '--log-level=warning', '--color=false',
    ], {cwd: source, encoding: 'utf8', shell: false});
    if (result.error || result.status !== 0) throw new Error(`Plugin compilation failed (${result.signal || (result.status ?? 'spawn')})`);
    const meta = JSON.parse(fs.readFileSync(metadata, 'utf8'));
    const sources = Object.keys(meta.inputs).sort().map(input => {
      const file = realFile(source, input);
      return {file: input.split(path.sep).join('/'), sha256: hash(fs.readFileSync(file))};
    });
    const imports = [...new Set(Object.values(meta.outputs).flatMap(item => item.imports.filter(value => value.external).map(value => value.path)))].sort();
    if (imports.some(name => name.startsWith('@utils/'))) throw new Error('Plugin imports the legacy runtime interface');
    const files = [{file: 'index.cjs', sha256: hash(fs.readFileSync(output))}];
    const names = new Set(['index.cjs', 'manifest.json', 'build.json']);
    for (const name of assets) {
      const file = realFile(source, name);
      const relative = path.relative(source, file).split(path.sep).join('/');
      if (names.has(relative)) throw new Error('Duplicate or reserved asset filename');
      names.add(relative);
      const target = path.join(stage, relative);
      directory(stage, path.dirname(relative) === '.' ? [] : path.dirname(relative).split('/'));
      fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
      files.push({file: relative, sha256: hash(fs.readFileSync(target))});
    }
    files.sort((a, b) => a.file.localeCompare(b.file, 'en'));
    const content = {schemaVersion: 1, apiVersion: 1, id, entry: 'index.cjs', sources, imports, files};
    const revision = hash(JSON.stringify(content));
    const manifest = {...content, revision};
    const manifestText = JSON.stringify(manifest, null, 2) + '\n';
    fs.rmSync(metadata);
    fs.writeFileSync(path.join(stage, 'manifest.json'), manifestText, {flag: 'wx'});
    const artifactDir = path.join(parent, revision);
    if (fs.existsSync(artifactDir)) {
      directory(parent, [revision]);
      if (fs.readFileSync(realFile(artifactDir, 'manifest.json'), 'utf8') !== manifestText ||
          files.some(file => hash(fs.readFileSync(realFile(artifactDir, file.file))) !== file.sha256)) {
        throw new Error('Existing plugin revision failed integrity verification');
      }
    } else {
      fs.renameSync(stage, artifactDir);
    }
    return {artifactDir, manifest};
  } finally {
    fs.rmSync(stage, {recursive: true, force: true});
  }
}

if (require.main === module) {
  try {
    const [id, packageRoot, entry, ...assets] = process.argv.slice(2);
    if (!id || !packageRoot || !entry) throw new Error('Usage: node scripts/build-v2-plugin.cjs <id> <package-root> <entry.ts> [asset ...]');
    console.log(JSON.stringify(buildPlugin({id, packageRoot, entry, assets})));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {buildPlugin};
