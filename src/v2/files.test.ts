import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, readFile, writeFile, readdir, rm, stat, symlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {ResourceScope} from './lifecycle';
import {ScopedFiles} from './files';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'telebox-files-')));
  const scope = new ResourceScope();
  const files = new ScopedFiles(scope, path.join(root, 'assets'), path.join(root, 'temp'), 'fixture');
  t.after(async () => {
    assert.equal((await scope.drain(1000)).completed, true);
    await rm(root, {recursive: true, force: true});
  });
  return {root, scope, files};
}

test('file capabilities are lazy, private and confined to their plugin', async t => {
  const {root, files} = await fixture(t);
  assert.deepEqual(await readdir(root), []);
  const target = await files.dataFile('nested/worker.py');
  assert.equal(target, path.join(root, 'assets/fixture/nested/worker.py'));
  await assert.rejects(stat(target), {code: 'ENOENT'});
  assert.equal((await stat(path.dirname(target))).mode & 0o777, 0o700);
  for (const name of ['../outside', '/absolute', '', 'a//b', './same', 'a\\b', 'a\u0000b']) {
    await assert.rejects(files.dataFile(name), /Invalid plugin data path/);
  }
});

test('data paths reject symlinked directories and targets', async t => {
  const {root, files} = await fixture(t);
  const directory = await files.dataDirectory();
  const outside = path.join(root, 'outside');
  await writeFile(outside, 'private');
  await symlink(outside, path.join(directory, 'link'));
  await assert.rejects(files.dataFile('link'), /regular file/);
  await symlink(root, path.join(directory, 'redirect'));
  await assert.rejects(files.dataFile('redirect/changed'), /ordinary directory/);
  assert.equal(await readFile(outside, 'utf8'), 'private');
});

test('temporary operations remove files on success and failure including symlink contents', async t => {
  const {root, files} = await fixture(t);
  const outside = path.join(root, 'outside');
  await writeFile(outside, 'preserved');
  let temporary = '';
  assert.equal(await files.withTemp(async directory => {
    temporary = directory;
    await symlink(outside, path.join(directory, 'link'));
    return 7;
  }), 7);
  await assert.rejects(stat(temporary), {code: 'ENOENT'});
  await assert.rejects(files.withTemp(async directory => {
    temporary = directory;
    await writeFile(path.join(directory, 'partial'), 'data');
    throw new Error('fixture failure');
  }), /fixture failure/);
  await assert.rejects(stat(temporary), {code: 'ENOENT'});
  assert.equal(await readFile(outside, 'utf8'), 'preserved');
});

test('cancellation retains active temporary files until actual callback settlement', async t => {
  const {files, scope} = await fixture(t);
  let start!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  let temporary = '';
  const work = files.withTemp(async (directory, signal) => {
    temporary = directory;
    start();
    await released;
    assert.equal(signal.aborted, true);
    assert.equal((await stat(directory)).isDirectory(), true);
    return 'settled';
  });
  const cancelled = assert.rejects(work);
  await started;
  try {
    assert.equal((await scope.drain(5)).completed, false);
    assert.equal((await stat(temporary)).isDirectory(), true);
    await assert.rejects(files.withTemp(async () => assert.fail('cancelled operation admitted')));
  } finally { release(); }
  await cancelled;
  assert.equal((await scope.drain(1000)).completed, true);
  await assert.rejects(stat(temporary), {code: 'ENOENT'});
});

test('50 temporary operations retain no job directories or lifecycle tasks', async t => {
  const {root, files, scope} = await fixture(t);
  for (let index = 0; index < 50; index++) {
    await files.withTemp(async directory => { await writeFile(path.join(directory, 'data'), String(index)); });
  }
  assert.deepEqual(await readdir(path.join(root, 'temp/fixture')), []);
  assert.equal(scope.snapshot().pendingTasks, 0);
  assert.equal(scope.snapshot().pendingResources, 0);
});
