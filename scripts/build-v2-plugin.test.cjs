'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {buildPlugin} = require('./build-v2-plugin.cjs');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'telebox-plugin-build-')));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const write = (file, body) => fs.writeFileSync(path.join(source, file), body);
  write('index.ts', 'export default function create() { return {apiVersion: 1, id: "fixture", commands: {}}; }');
  return {root, source, write, build: options => buildPlugin({id: 'fixture', packageRoot: source, entry: 'index.ts', rootDir: root, ...options})};
}

test('plugin candidates are deterministic, immutable, and do not execute source while compiling', t => {
  const {build, write, source} = fixture(t);
  write('index.ts', 'throw new Error("must not run during build"); export default {};');
  const first = build();
  assert.equal(build().artifactDir, first.artifactDir);
  assert.equal(first.manifest.sources[0].file, 'index.ts');
  const bytes = fs.readFileSync(path.join(first.artifactDir, 'index.cjs'));
  write('index.ts', 'export default {changed: true};');
  assert.notEqual(build().artifactDir, first.artifactDir);
  assert.deepEqual(fs.readFileSync(path.join(first.artifactDir, 'index.cjs')), bytes);
  assert.deepEqual(fs.readdirSync(source), ['index.ts']);
});

test('local helpers bundle, dependencies stay external, explicit assets have hashes', t => {
  const {build, write} = fixture(t);
  write('helper.ts', 'export const value = 7;');
  write('worker.py', 'print("fixture")\n');
  write('index.ts', 'import {value} from "./helper"; import fs from "node:fs"; export default {value, read: fs.readFileSync};');
  const artifact = build({assets: ['worker.py']});
  assert.deepEqual(artifact.manifest.sources.map(value => value.file), ['helper.ts', 'index.ts']);
  assert.deepEqual(artifact.manifest.imports, ['node:fs']);
  assert.equal(require(path.join(artifact.artifactDir, 'index.cjs')).default.value, 7);
  assert.equal(fs.readFileSync(path.join(artifact.artifactDir, 'worker.py'), 'utf8'), 'print("fixture")\n');
});

test('compile failures and legacy imports preserve candidates and remove staging', t => {
  const {build, write} = fixture(t);
  const first = build();
  for (const source of ['export default {', 'import {Plugin} from "@utils/pluginBase"; export default new Plugin();']) {
    write('index.ts', source);
    assert.throws(() => build());
    assert.deepEqual(fs.readdirSync(path.dirname(first.artifactDir)), [first.manifest.revision]);
  }
});

test('integrity verification rejects modified published bytes', t => {
  const {build} = fixture(t);
  const first = build();
  fs.appendFileSync(path.join(first.artifactDir, 'index.cjs'), '\n// tampered');
  assert.throws(() => build(), /integrity/);
});

test('source, asset and output boundaries reject symlinks and traversal', t => {
  const {build, root, source} = fixture(t);
  assert.throws(() => build({id: '../outside'}));
  assert.throws(() => build({entry: '../elsewhere.ts'}));
  fs.symlinkSync(path.join(source, 'index.ts'), path.join(source, 'link.ts'));
  assert.throws(() => build({entry: 'link.ts'}), /symlinks/);
  assert.throws(() => build({assets: ['link.ts']}), /symlinks/);
  assert.throws(() => build({assets: ['../elsewhere']}));
  const other = path.join(root, 'other');
  fs.mkdirSync(other);
  const parent = path.join(root, 'dist', 'v2-plugins');
  fs.rmSync(parent, {recursive: true});
  fs.symlinkSync(other, parent);
  assert.throws(() => build(), /ordinary directory/);
  assert.deepEqual(fs.readdirSync(other), []);
});

test('bundled sources must belong to the declared plugin package', t => {
  const {build, write, root} = fixture(t);
  fs.writeFileSync(path.join(root, 'outside.ts'), 'export const value = 1;');
  write('index.ts', 'export {value} from "../outside";');
  assert.throws(() => build(), /escapes/);
});

test('asset names cannot replace code or integrity metadata', t => {
  const {build, write} = fixture(t);
  for (const file of ['index.cjs', 'manifest.json', 'build.json']) {
    write(file, 'fixture');
    assert.throws(() => build({assets: [file]}), /reserved/);
  }
  write('asset.txt', 'fixture');
  assert.throws(() => build({assets: ['asset.txt', './asset.txt']}), /Duplicate/);
});
