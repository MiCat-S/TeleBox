import test, {type TestContext} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, realpath, readFile, writeFile, rm, stat, mkdir} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {ResourceScope} from "./lifecycle";
import {RuntimeLogger, LogLevel} from "./logging";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "telebox-v2-log-")));
  const file = path.join(root, "config.json");
  const scope = new ResourceScope();
  const events: {level: number; event: string}[] = [];
  const logger = new RuntimeLogger(file, {write(level, event) {events.push({level, event});}}, scope);
  t.after(async () => {
    assert.equal((await scope.drain()).completed, true);
    await rm(root, {recursive: true, force: true});
  });
  return {file, scope, events, logger};
}

test("logging construction and missing-config initialization never create files or override console", async t => {
  const before = [console.log, console.info, console.warn, console.error, console.debug];
  const {file, logger} = await fixture(t);
  await assert.rejects(stat(file), {code: "ENOENT"});
  await logger.initialize();
  assert.equal(logger.getLevel(), LogLevel.INFO);
  assert.equal(logger.getLevelName(), "INFO");
  assert.equal(logger.getProtocolLevel(), "info");
  await assert.rejects(stat(file), {code: "ENOENT"});
  assert.deepEqual([console.log, console.info, console.warn, console.error, console.debug], before);
});

for (const [level, name, protocol] of [[0, "DEBUG", "debug"], [1, "INFO", "info"], [2, "WARNING", "warn"], [3, "ERROR", "error"], [4, "SILENT", "none"]] as const) {
  test(`logging preserves legacy numeric ${name} and filters before calling its sink`, async t => {
    const {file, events, logger} = await fixture(t);
    await writeFile(file, JSON.stringify({level}));
    await logger.initialize();
    assert.equal(logger.getLevelName(), name);
    assert.equal(logger.getProtocolLevel(), protocol);
    logger.debug("debug"); logger.info("info"); logger.warn("warn"); logger.error("error");
    assert.deepEqual(events.map(item => item.level), [0, 1, 2, 3].filter(value => value >= level));
  });
}

test("logging updates preserve unknown config fields and exact large integer literals", async t => {
  const {file, logger} = await fixture(t);
  await writeFile(file, '{"level":1,"account":9007199254740993,"future":{"mode":"retain"}}');
  await logger.initialize();
  await logger.setLevel(LogLevel.ERROR);
  assert.equal(logger.getLevel(), LogLevel.ERROR);
  assert.equal(await readFile(file, "utf8"), '{"level":3,"account":9007199254740993,"future":{"mode":"retain"}}\n');
});

test("logging rejects invalid existing levels and malformed JSON without defaulting or rewriting", async t => {
  const {file, logger} = await fixture(t);
  for (const source of ['{"level":-1}', '{"level":5}', '{"level":1.5}', '{"level":"debug"}', '{}', 'null', '{']) {
    await writeFile(file, source);
    await assert.rejects(logger.initialize());
    assert.equal(logger.getLevel(), LogLevel.INFO);
    assert.equal(await readFile(file, "utf8"), source);
  }
  for (const value of [-1, 5, 1.5, NaN]) assert.throws(() => logger.setLevel(value), /Invalid/);
});

test("logging serializes concurrent loads and writes, leaving the last committed level active", async t => {
  const {file, logger} = await fixture(t);
  await Promise.all([logger.initialize(), logger.setLevel(LogLevel.DEBUG), logger.setLevel(LogLevel.SILENT), logger.initialize()]);
  assert.equal(logger.getLevel(), LogLevel.SILENT);
  assert.equal(JSON.parse(await readFile(file, "utf8")).level, LogLevel.SILENT);
});

test("logging persistence errors do not publish a level and recovery remains usable", async t => {
  const {file, logger} = await fixture(t);
  await mkdir(file);
  await assert.rejects(logger.setLevel(LogLevel.DEBUG));
  assert.equal(logger.getLevel(), LogLevel.INFO);
  await rm(file, {recursive: true});
  await logger.setLevel(LogLevel.WARNING);
  assert.equal(logger.getLevel(), LogLevel.WARNING);
});

test("logging pre-cancelled operations and shutdown cannot write or emit further events", async t => {
  const {file, logger, events, scope} = await fixture(t);
  const cancelled = AbortSignal.abort(new Error("cancelled"));
  await assert.rejects(logger.initialize(cancelled), /cancelled/);
  await assert.rejects(logger.setLevel(LogLevel.DEBUG, cancelled), /cancelled/);
  assert.equal((await scope.drain()).completed, true);
  await assert.rejects(logger.setLevel(LogLevel.WARNING));
  logger.error("late");
  assert.equal(events.length, 0);
  await assert.rejects(stat(file), {code: "ENOENT"});
});

test("logging can be reopened 50 times without resetting the persisted level", async t => {
  const {file} = await fixture(t);
  await writeFile(file, '{"level":2,"extra":true}');
  for (let i = 0; i < 50; i++) {
    const scope = new ResourceScope();
    const logger = new RuntimeLogger(file, {write() {}}, scope);
    await logger.initialize();
    assert.equal(logger.getLevel(), LogLevel.WARNING);
    assert.equal((await scope.drain()).completed, true);
    assert.deepEqual(scope.snapshot(), {completed: true, timedOut: false, pendingTasks: 0, pendingResources: 0, errors: []});
  }
  assert.equal(await readFile(file, "utf8"), '{"level":2,"extra":true}');
});
