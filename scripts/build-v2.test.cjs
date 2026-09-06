'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { test } = require('node:test');
const { build } = require('./build-v2.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function put(root, relative, content) {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telebox v2 ;$ fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  put(root, 'src/v2/index.ts', 'console.log("offline fixture");\n');
  return root;
}

function tree(dir) {
  const result = {};
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) visit(filename);
      else result[path.relative(dir, filename)] = fs.readFileSync(filename, 'utf8');
    }
  }
  visit(dir);
  return result;
}

function assertClean(root) {
  assert.deepEqual(fs.readdirSync(path.join(root, 'dist')).sort(), ['v2']);
}

function node(args, cwd) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return childProcess.spawnSync(process.execPath, args, {
    cwd, env, encoding: 'utf8', timeout: 30000,
  });
}

function assertSuccess(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function addTooling(root) {
  put(root, 'scripts/build-v2.cjs', fs.readFileSync(path.join(__dirname, 'build-v2.cjs')));
  put(root, 'tsconfig.v2.json', fs.readFileSync(path.join(PROJECT_ROOT, 'tsconfig.v2.json')));
  fs.symlinkSync(path.join(PROJECT_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
}

test('production preserves directories and runs plain JS with intact module helpers', (t) => {
  const root = fixture(t);
  put(root, 'src/v2/index.ts', [
    'import label, { answer } from "./nested/value.js";',
    'console.log(`${label}:${answer}`);',
    'if (require.extensions[".ts"]) throw new Error("unexpected TS hook");',
  ].join('\n'));
  put(root, 'src/v2/nested/value.ts', 'export default "ready"; export const answer: number = 42;');
  put(root, 'src/v2/unused.ts', 'export const unused = true;\n//# sourceMappingURL=data:application/json;base64,e30=');
  put(root, 'src/v2/types.d.ts', 'declare const declared: string;');
  put(root, 'src/v2/broken.test.ts', 'export const invalid: = ;');
  put(root, 'src/v2/nested/broken.test.ts', 'export const invalid: = ;');
  put(root, 'src/v2/readme.txt', 'not a build input');
  // Legacy settings must not influence the new build.
  put(root, 'tsconfig.json', '{"compilerOptions":{"target":"ES5","sourceMap":true}}');

  const result = build({ rootDir: root });
  assert.equal(result.sourceCount, 3);
  assert.equal(result.includeTests, false);
  const output = tree(result.outDir);
  assert.deepEqual(Object.keys(output).sort(), ['index.js', path.join('nested', 'value.js'), 'unused.js'].sort());
  for (const code of Object.values(output)) {
    assert.doesNotMatch(code, /sourceMappingURL|sourcesContent|esbuild-register|cjs-helpers|run-tsx/);
  }
  fs.rmSync(path.join(root, 'src'), { recursive: true });
  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
  const run = node([path.join(result.outDir, 'index.js')], root);
  assertSuccess(run);
  assert.equal(run.stdout.trim(), 'ready:42');
  assertClean(root);
});

test('package imports remain external, including Teleproto and native modules', (t) => {
  const root = fixture(t);
  put(root, 'src/v2/dependencies.ts', [
    'import { TelegramClient } from "teleproto";',
    'import Database from "better-sqlite3";',
    'export { TelegramClient, Database };',
  ].join('\n'));
  const { outDir } = build({ rootDir: root });
  const output = fs.readFileSync(path.join(outDir, 'dependencies.js'), 'utf8');
  assert.match(output, /require\("teleproto"\)/);
  assert.match(output, /require\("better-sqlite3"\)/);
  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
});

test('test mode compiles tests at all depths for the Node test runner', (t) => {
  const root = fixture(t);
  const source = 'import { test } from "node:test"; import assert from "node:assert/strict"; test("fixture", () => assert.equal(2 + 2, 4));';
  put(root, 'src/v2/example.test.ts', source);
  put(root, 'src/v2/nested/example.test.ts', source);
  const { outDir, sourceCount } = build({ rootDir: root, includeTests: true });
  assert.equal(sourceCount, 3);
  assertSuccess(node(['--test', path.join(outDir, '*.test.js')], root));
  assertSuccess(node(['--test', path.join(outDir, 'nested', '*.test.js')], root));
  assertClean(root);
});

test('replacement drops deleted sources, prior test outputs, and stale source maps', (t) => {
  const root = fixture(t);
  put(root, 'src/v2/nested/deleted.ts', 'export const deleted = true;');
  put(root, 'src/v2/example.test.ts', 'export const test = true;');
  build({ rootDir: root, includeTests: true });
  put(root, 'dist/v2/index.js.map', 'stale map');
  put(root, 'dist/legacy/keep.js', 'old service artifact');
  fs.unlinkSync(path.join(root, 'src/v2/nested/deleted.ts'));
  const { outDir } = build({ rootDir: root });
  assert.deepEqual(Object.keys(tree(outDir)), ['index.js']);
  assert.equal(fs.readFileSync(path.join(root, 'dist/legacy/keep.js'), 'utf8'), 'old service artifact');
  assert.deepEqual(fs.readdirSync(path.join(root, 'dist')).sort(), ['legacy', 'v2']);
});

test('invalid compilation preserves every last-good output and cleans staging', (t) => {
  const root = fixture(t);
  const { outDir } = build({ rootDir: root });
  const before = tree(outDir);
  put(root, 'src/v2/index.ts', 'console.log("changed");');
  put(root, 'src/v2/invalid.ts', 'export const value: = ;');
  assert.throws(() => build({ rootDir: root }), /esbuild failed/);
  assert.deepEqual(tree(outDir), before);
  assertClean(root);
});

test('a failed initial compile creates no published artifact', (t) => {
  const root = fixture(t);
  put(root, 'src/v2/index.ts', 'export const value: = ;');
  assert.throws(() => build({ rootDir: root }), /esbuild failed/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'dist')), []);
});

test('missing or empty production source sets cannot replace an artifact', (t) => {
  const root = fixture(t);
  const { outDir } = build({ rootDir: root });
  const before = tree(outDir);
  fs.rmSync(path.join(root, 'src/v2'), { recursive: true });
  assert.throws(() => build({ rootDir: root }), { code: 'ENOENT' });
  put(root, 'src/v2/types.d.ts', 'declare const value: number;');
  put(root, 'src/v2/only.test.ts', 'export const value = 1;');
  assert.throws(() => build({ rootDir: root }), /No compilable TypeScript/);
  assert.deepEqual(tree(outDir), before);
  assertClean(root);
});

for (const location of ['src', 'src/v2', 'src/v2/link.ts', 'src/v2/nested', 'dist', 'dist/v2']) {
  test(`rejects symlinks at ${location} without touching their targets`, (t) => {
    const root = fixture(t);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'telebox-build-target-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    put(outside, 'keep.txt', 'preserved');
    const filename = path.join(root, location);
    fs.rmSync(filename, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.symlinkSync(outside, filename, 'dir');
    assert.throws(() => build({ rootDir: root }), /ordinary directories|Source symlinks/);
    assert.deepEqual(tree(outside), { 'keep.txt': 'preserved' });
    assert.equal(fs.lstatSync(filename).isSymbolicLink(), true);
  });
}

test('rejects output aliases to sources, dangling links, and ordinary files', (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'dist'));
  const outDir = path.join(root, 'dist/v2');
  for (const target of [path.join(root, 'src/v2'), path.join(root, 'missing')]) {
    fs.symlinkSync(target, outDir, 'dir');
    assert.throws(() => build({ rootDir: root }), /ordinary directories/);
    fs.unlinkSync(outDir);
  }
  put(root, 'dist/v2', 'preserved ordinary file');
  assert.throws(() => build({ rootDir: root }), /ordinary directories/);
  assert.equal(fs.readFileSync(outDir, 'utf8'), 'preserved ordinary file');
  assert.equal(fs.readFileSync(path.join(root, 'src/v2/index.ts'), 'utf8'), 'console.log("offline fixture");\n');
});

test('validates fixture options before creating directories', () => {
  for (const rootDir of ['', '   ', null, 42]) {
    assert.throws(() => build({ rootDir }), /rootDir must be/);
  }
  assert.throws(() => build({ includeTests: 'false' }), /includeTests must be/);
});

test('canonicalizes a fixture root alias while keeping output inside that root', (t) => {
  const root = fixture(t);
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'telebox-root-alias-'));
  t.after(() => fs.rmSync(container, { recursive: true, force: true }));
  const alias = path.join(container, 'alias');
  fs.symlinkSync(root, alias, 'dir');
  const { outDir } = build({ rootDir: alias });
  assert.equal(outDir, path.join(fs.realpathSync(root), 'dist/v2'));
  assertClean(root);
});

test('a failed compiler launch preserves the artifact and cleans staging', (t) => {
  const root = fixture(t);
  const { outDir } = build({ rootDir: root });
  const before = tree(outDir);
  t.mock.method(childProcess, 'spawnSync', () => ({ error: new Error('fixture launch failure') }));
  assert.throws(() => build({ rootDir: root }), /fixture launch failure/);
  assert.deepEqual(tree(outDir), before);
  assertClean(root);
});

test('failed promotion restores the last good tree and cleans temporary directories', (t) => {
  const root = fixture(t);
  const { outDir } = build({ rootDir: root });
  const before = tree(outDir);
  put(root, 'src/v2/index.ts', 'console.log("new artifact");');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.basename(from).startsWith('.v2-stage-')) throw new Error('fixture promotion failure');
    return rename(from, to);
  });
  assert.throws(() => build({ rootDir: root }), /fixture promotion failure/);
  assert.deepEqual(tree(outDir), before);
  assertClean(root);
});

test('failed restoration retains the backup and reports its recovery path', (t) => {
  const root = fixture(t);
  const { outDir } = build({ rootDir: root });
  const before = tree(outDir);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === outDir) throw new Error('fixture destination failure');
    return rename(from, to);
  });
  let failure;
  assert.throws(() => build({ rootDir: root }), (error) => {
    failure = error;
    return error instanceof AggregateError;
  });
  const siblings = fs.readdirSync(path.join(root, 'dist'));
  assert.equal(siblings.length, 1);
  assert.match(siblings[0], /^\.v2-backup-/);
  const recovery = path.join(fs.realpathSync(root), 'dist', siblings[0], 'artifact');
  assert.ok(failure.message.includes(recovery));
  assert.deepEqual(tree(recovery), before);
});

test('CLI defaults to production, supports --test, and rejects other arguments', (t) => {
  const root = fixture(t);
  addTooling(root);
  put(root, 'src/v2/example.test.ts', 'import { test } from "node:test"; test("fixture", () => {});');
  const script = path.join(root, 'scripts/build-v2.cjs');
  // An unrelated cwd must not redirect production outputs.
  assertSuccess(node([script], os.tmpdir()));
  assert.equal(fs.existsSync(path.join(root, 'dist/v2/example.test.js')), false);
  assertSuccess(node([script, '--test'], os.tmpdir()));
  assertSuccess(node(['--test', 'dist/v2/*.test.js'], root));
  const before = tree(path.join(root, 'dist/v2'));
  for (const args of [['--unknown'], ['--test', '--test']]) {
    const result = node([script, ...args], root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
    assert.deepEqual(tree(path.join(root, 'dist/v2')), before);
  }
  put(root, 'src/v2/index.ts', 'export const invalid: = ;');
  const invalid = node([script], root);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /esbuild failed/);
  assert.deepEqual(tree(path.join(root, 'dist/v2')), before);
  assertClean(root);
});

test('v2 typecheck is strict, noEmit, and independent from legacy inputs', (t) => {
  const root = fixture(t);
  addTooling(root);
  put(root, 'src/legacy.ts', 'export const invalid: = ;');
  put(root, 'plugins/legacy.ts', 'export const invalid: = ;');
  put(root, 'tsconfig.json', 'invalid legacy config');
  put(root, 'src/v2/index.ts', 'const value: string = "valid"; console.log(value);');
  const tsc = path.join(PROJECT_ROOT, 'node_modules/typescript/bin/tsc');
  assertSuccess(node([tsc, '-p', path.join(root, 'tsconfig.v2.json')], root));
  assert.equal(fs.existsSync(path.join(root, 'dist')), false);
  assert.deepEqual(Object.keys(tree(path.join(root, 'src/v2'))), ['index.ts']);
  put(root, 'src/v2/index.ts', 'function invalid(value) { return value; }');
  const invalid = node([tsc, '-p', path.join(root, 'tsconfig.v2.json')], root);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stdout + invalid.stderr, /implicitly has an 'any' type/);
  assert.equal(fs.existsSync(path.join(root, 'dist')), false);
  put(root, 'src/v2/index.ts', 'export const value = 1;');
  put(root, 'src/v2/example.test.ts', 'function invalid(value) { return value; }');
  const invalidTest = node([tsc, '-p', path.join(root, 'tsconfig.v2.json')], root);
  assert.notEqual(invalidTest.status, 0);
  assert.match(invalidTest.stdout + invalidTest.stderr, /example\.test\.ts/);
});

test('service template preserves direct startup, group cleanup, and journal logging', () => {
  const service = fs.readFileSync(path.join(PROJECT_ROOT, 'deploy/systemd/telebox-v2.service'), 'utf8');
  const directives = service.split(/\r?\n/).filter((line) => line && !line.startsWith('#') && !line.startsWith('['));
  assert.ok(directives.includes('ExecStart=/usr/bin/node /root/telebox/dist/v2/index.js --serve'));
  assert.ok(directives.includes('WorkingDirectory=/root/telebox'));
  for (const directive of [
    'Restart=on-failure', 'RestartSec=5s', 'KillSignal=SIGTERM',
    'KillMode=control-group', 'TimeoutStopSec=60s', 'SendSIGKILL=yes',
    'StandardOutput=journal', 'StandardError=journal',
  ]) {
    assert.ok(directives.includes(directive), directive);
  }
  assert.equal(directives.filter((line) => line.startsWith('Exec')).length, 1);
  assert.match(service, /Install after foreground account verification/);
  assert.match(service, /Description=Mi Box/);
  const readme = fs.readFileSync(path.join(PROJECT_ROOT, 'deploy/systemd/README.md'), 'utf8');
  assert.match(readme, /INSTALL\.md/);
  assert.match(readme, /runtime\.ready/);
  assert.match(readme, /回滚/);
});
