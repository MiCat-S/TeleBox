'use strict';
/**
 * Node 22+ exposes global localStorage backed by --localstorage-file.
 * teleproto → store2 touches localStorage at load time; without a valid path,
 * Node warns. tsx may spawn child processes that only inherit env, not
 * the parent argv flag — so this sets NODE_OPTIONS (merged with any existing).
 *
 * Only applies the flag on Node.js 22+, as it causes errors on earlier versions.
 * Override file path with TB_LOCALSTORAGE_FILE.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const root = path.join(__dirname, '..');
const cacheBase = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
const defaultFile = path.join(cacheBase, 'telebox', 'node-localstorage');
const lsFile = process.env.TB_LOCALSTORAGE_FILE || defaultFile;

fs.mkdirSync(path.dirname(lsFile), { recursive: true });

// Check Node.js version - --localstorage-file requires Node 22+
const nodeVersion = process.versions.node.split('.').map(Number);
const majorVersion = nodeVersion[0];

const esbuildRegister = path.join(__dirname, 'esbuild-register.cjs');
const entryArgs = process.argv.slice(2);
if (entryArgs.length === 0) {
  console.error('usage: node scripts/run-tsx.cjs <script.ts> [args...]');
  process.exit(1);
}

const env = { ...process.env };

// Only add --localstorage-file for Node.js 22+
if (majorVersion >= 22) {
  const flag = `--localstorage-file=${lsFile}`;
  let existing = (env.NODE_OPTIONS || '').trim();
  // Deduplicate any inherited --localstorage-file to avoid V8 flag confusion
  existing = existing.replace(/--localstorage-file=\S+/g, '').trim();
  env.NODE_OPTIONS = existing ? `${existing} ${flag}` : flag;
}

// Limit V8 heap to 512 MB and expose gc() for the health plugin.
// 192 MB was too low for teleproto's baseline (233+ MB), causing repeated
// OOM crashes. 512 MB matches PM2 max_memory_restart for graceful restart.
// Replace any existing --max-old-space-size so an inherited mtcute-era
// NODE_OPTIONS (e.g. --max-semi-space-size) cannot confuse V8 heap config.
const heapFlag = '--max-old-space-size=512';
let existingOpts = (env.NODE_OPTIONS || '').trim();
existingOpts = existingOpts.replace(/--max-old-space-size=\d+/g, '').trim();
env.NODE_OPTIONS = existingOpts ? `${existingOpts} ${heapFlag} --expose-gc` : `${heapFlag} --expose-gc`;

// Strip any inherited --max-semi-space-size (mtcute-specific tuning) —
// teleproto's baseline doesn't need a 128 MB young generation, and combining
// it with a fresh 512 MB old-space cap blew past the heap limit at startup.
existingOpts = (env.NODE_OPTIONS || '').trim();
existingOpts = existingOpts.replace(/--max-semi-space-size=\d+/g, '').trim();
env.NODE_OPTIONS = existingOpts ? existingOpts : env.NODE_OPTIONS;

// Use esbuild-register instead of tsx to eliminate heap waste from
// inline source maps, CJS polyfill duplication, and source string retention.
// Precompile plugins to shared-helpers cache if cache is missing.
const cacheDir = path.join(root, '.plugin-cache');
if (!fs.existsSync(path.join(cacheDir, 'cjs-helpers.js'))) {
  console.log('[run-tsx] Plugin cache missing, precompiling...');
  const pre = spawnSync(process.execPath, [path.join(__dirname, 'precompile-plugins.cjs')], {
    cwd: root, stdio: 'inherit',
  });
  if (pre.status !== 0) {
    console.error('[run-tsx] Precompile failed, continuing with on-the-fly compilation');
  }
}

const runtimeArgs = [
  '-r',
  'tsconfig-paths/register',
  '-r',
  esbuildRegister,
  ...entryArgs,
];

// Node 24 provides process.execve(): replace this launcher instead of keeping
// another V8 process alive for the entire TeleBox lifetime. This also lets PM2
// monitor the real runtime RSS rather than a lightweight npm/launcher parent.
if (typeof process.execve === 'function') {
  try {
    process.execve(process.execPath, [process.execPath, ...runtimeArgs], env);
  } catch (error) {
    console.error('[run-tsx] execve failed, falling back to child process:', error);
  }
}

const r = spawnSync(process.execPath, runtimeArgs, {
  cwd: root,
  env,
  stdio: 'inherit',
});
process.exit(r.status === null ? 1 : r.status);
