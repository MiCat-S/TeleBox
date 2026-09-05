'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function directory(root, relative, create = false) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      fs.mkdirSync(current);
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Build paths must be ordinary directories: ${current}`);
    }
  }
  return current;
}

function sourcesIn(sourceDir, includeTests) {
  const sources = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Source symlinks are not supported: ${filename}`);
      }
      if (entry.isDirectory()) {
        visit(filename);
      } else if (entry.isFile() && entry.name.endsWith('.ts') &&
                 !entry.name.endsWith('.d.ts') &&
                 (includeTests || !entry.name.endsWith('.test.ts'))) {
        sources.push(filename);
      }
    }
  }
  visit(sourceDir);
  return sources.sort();
}

// Only the project root is configurable for fixtures. Source/output paths stay
// fixed, disjoint, and symlink-free so cleanup cannot follow an output alias.
function build({ rootDir = PROJECT_ROOT, includeTests = false } = {}) {
  if (typeof rootDir !== 'string' || rootDir.trim() === '') {
    throw new TypeError('rootDir must be a non-empty directory path');
  }
  if (typeof includeTests !== 'boolean') {
    throw new TypeError('includeTests must be a boolean');
  }
  const root = fs.realpathSync(path.resolve(rootDir));
  const sourceDir = directory(root, 'src/v2');
  const sources = sourcesIn(sourceDir, includeTests);
  if (sources.length === 0) {
    throw new Error(`No compilable TypeScript sources in ${sourceDir}`);
  }
  const parent = directory(root, 'dist', true);
  const outDir = path.join(parent, 'v2');
  try {
    directory(root, 'dist/v2');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const staging = fs.mkdtempSync(path.join(parent, '.v2-stage-'));
  let backup;
  try {
    // Invoke the installed CLI directly; do not load esbuild's service API into
    // this process. No bundling, source maps, or post-processing of helpers.
    const result = childProcess.spawnSync(require.resolve('esbuild/bin/esbuild'), [
      ...sources,
      '--platform=node',
      '--format=cjs',
      '--target=es2022',
      '--bundle=false',
      `--tsconfig=${path.join(PROJECT_ROOT, 'tsconfig.v2.json')}`,
      `--outbase=${sourceDir}`,
      `--outdir=${staging}`,
      '--log-level=warning',
      '--color=false',
    ], { cwd: root, encoding: 'utf8', shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`esbuild failed (${result.signal || result.status}):\n${result.stderr || result.stdout || ''}`);
    }

    // Directory renames share a filesystem. Keep the last artifact until the
    // staged tree is promoted, and restore it if that rename fails.
    if (fs.existsSync(outDir)) {
      backup = fs.mkdtempSync(path.join(parent, '.v2-backup-'));
      fs.renameSync(outDir, path.join(backup, 'artifact'));
    }
    try {
      fs.renameSync(staging, outDir);
    } catch (error) {
      if (backup) {
        try {
          fs.renameSync(path.join(backup, 'artifact'), outDir);
        } catch (restoreError) {
          throw new AggregateError([error, restoreError],
            `Promotion and restore failed; last good artifact retained at ${path.join(backup, 'artifact')}`);
        }
      }
      throw error;
    }
    if (backup) fs.rmSync(backup, { recursive: true });
    return { outDir, sourceCount: sources.length, includeTests };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    // An unsuccessful restore must never delete the only good artifact.
    if (backup && fs.existsSync(backup) && !fs.existsSync(path.join(backup, 'artifact'))) {
      fs.rmdirSync(backup);
    }
  }
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--test')) {
      throw new Error('Usage: node scripts/build-v2.cjs [--test]');
    }
    const result = build({ includeTests: args[0] === '--test' });
    console.log(`Built ${result.sourceCount} TypeScript files into ${result.outDir}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { build };
