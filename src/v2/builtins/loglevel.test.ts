import test, {type TestContext} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, realpath, rm, readFile, stat, mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {TelegramClient} from "teleproto";
import {createLogLevel} from "./loglevel";
import {PluginHost} from "../host";
import {ResourceScope} from "../lifecycle";
import {RuntimeLogger, LogLevel} from "../logging";
import type {TelegramPort, MessageEnvelope} from "../sdk";

const message: MessageEnvelope = {id: 1, chatId: "1", senderId: "1", text: ".loglevel", outgoing: true};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {resolve, promise};
}

async function fixture(t: TestContext, options: {native?: TelegramPort["withClient"]; edit?: TelegramPort["edit"]; load?: boolean} = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "telebox-v2-loglevel-")));
  const directory = path.join(root, "logger");
  const file = path.join(directory, "config.json");
  const scope = new ResourceScope();
  const events: string[] = [];
  const logger = new RuntimeLogger(file, {write(_level, event) {events.push(event);}}, scope);
  const edits: string[] = [];
  const levels: string[] = [];
  const client = {setLogLevel(level: string) {levels.push(level);}} as TelegramClient;
  const host = new PluginHost({storageRoot: root, logger, aliases: {ll: "loglevel"}, prefixes: [".", "!"], telegram: {
    edit: options.edit ?? (async (_message, text, mode) => {assert.equal(mode.parseMode, "html"); edits.push(text);}),
    async reply() {assert.fail("unexpected reply");},
    async getReply() {assert.fail("unexpected reply read");},
    async invoke() {assert.fail("unexpected RPC");},
    withClient: options.native ?? (async (operation, signal) => operation(client, signal)),
  }});
  t.after(async () => {
    assert.equal((await host.shutdown()).completed, true);
    assert.equal((await scope.drain()).completed, true);
    await rm(root, {recursive: true, force: true});
  });
  if (options.load !== false) await host.load(createLogLevel(logger));
  return {host, logger, scope, file, directory, edits, levels, events};
}

test("loglevel factory is pure and reads legacy configuration only during tracked setup", async t => {
  const {host, logger, file, directory, edits, levels} = await fixture(t, {load: false});
  const plugin = createLogLevel(logger);
  await assert.rejects(stat(directory), {code: "ENOENT"});
  await mkdir(directory);
  await writeFile(file, '{"level":2,"future":true}');
  await host.load(plugin);
  await host.dispatchPrimary(message);
  assert.ok(edits[0].includes("WARNING"));
  assert.deepEqual(levels, []);
  assert.equal(await readFile(file, "utf8"), '{"level":2,"future":true}');
});

for (const [input, numeric, native] of [
  ["DEBUG", 0, "debug"], ["info", 1, "info"], ["warning", 2, "warn"], ["warn", 2, "warn"],
  ["error", 3, "error"], ["err", 3, "error"], ["silent", 4, "none"], ["off", 4, "none"],
] as const) {
  test(`loglevel ${input} preserves aliases and numeric storage and synchronizes the native client`, async t => {
    const {host, file, logger, edits, levels} = await fixture(t);
    await host.dispatchPrimary({...message, text: `!ll ${input} ignored`});
    assert.equal(logger.getLevel(), numeric);
    assert.equal(JSON.parse(await readFile(file, "utf8")).level, numeric);
    assert.deepEqual(levels, [native]);
    assert.ok(edits[0].includes("已同步更新"));
  });
}

test("loglevel rejects unrecognized and HTML inputs with fixed output and no persistence", async t => {
  const {host, file, levels, edits} = await fixture(t);
  for (const input of ["toString", "constructor", "<b>secret</b>", "trace", "none"]) {
    await host.dispatchPrimary({...message, text: `.loglevel ${input}`});
    assert.ok(edits.at(-1)?.includes("无效"));
    assert.ok(!edits.at(-1)?.includes(input));
  }
  assert.deepEqual(levels, []);
  await assert.rejects(stat(file), {code: "ENOENT"});
});

test("loglevel owner and edited-message admission prevent state changes", async t => {
  const {host, levels, logger} = await fixture(t);
  assert.equal(await host.dispatchPrimary({...message, text: ".loglevel debug", outgoing: false}), false);
  assert.equal(await host.dispatchPrimary({...message, text: ".loglevel debug", edited: true}), false);
  assert.equal(logger.getLevel(), LogLevel.INFO);
  assert.deepEqual(levels, []);
  assert.equal(await host.dispatchPrimary({...message, text: ".loglevel debug", outgoing: false, saved: true}), true);
  assert.deepEqual(levels, ["debug"]);
});

test("loglevel persistence failure stays fixed and cannot claim client synchronization", async t => {
  const output: string[] = [];
  const {host, file, logger, levels, events} = await fixture(t, {edit: async (_message, text) => {output.push(text);}});
  await mkdir(file, {recursive: true});
  await host.dispatchPrimary({...message, text: ".loglevel debug"});
  assert.equal(logger.getLevel(), LogLevel.INFO);
  assert.deepEqual(levels, []);
  assert.deepEqual(events, ["loglevel.persistence_failed"]);
  assert.deepEqual(output, ["❌ 日志等级保存失败，请检查日志配置文件"]);
  assert.ok(!output[0].includes(file));
});

test("loglevel reports native synchronization failure while retaining committed config", async t => {
  const {host, file, edits, events} = await fixture(t, {native: async () => {throw new Error("sensitive-native-state");}});
  await host.dispatchPrimary({...message, text: ".loglevel debug"});
  assert.equal(JSON.parse(await readFile(file, "utf8")).level, LogLevel.DEBUG);
  assert.ok(edits[0].includes("同步失败"));
  assert.ok(!edits[0].includes("sensitive"));
  assert.deepEqual(events, ["loglevel.protocol_sync_failed"]);
});

test("loglevel cross-chat changes cannot overtake an earlier protocol operation", async t => {
  const entered = deferred();
  const release = deferred();
  const levels: string[] = [];
  let calls = 0;
  const {host, file, logger} = await fixture(t, {native: async (operation, signal) => {
    if (++calls === 1) {entered.resolve(); await release.promise;}
    return operation({setLogLevel(level: string) {levels.push(level);}} as TelegramClient, signal);
  }});
  const first = host.dispatchPrimary({...message, text: ".loglevel debug"});
  await entered.promise;
  const second = host.dispatchPrimary({...message, chatId: "2", text: ".loglevel error"});
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(logger.getLevel(), LogLevel.DEBUG);
    assert.equal(calls, 1);
  } finally {release.resolve();}
  await Promise.all([first, second]);
  assert.deepEqual(levels, ["debug", "error"]);
  assert.equal(JSON.parse(await readFile(file, "utf8")).level, LogLevel.ERROR);
});

test("loglevel cancellation retains native ownership and prevents queued writes and late replies", async t => {
  const entered = deferred();
  const release = deferred();
  let nativeCalls = 0;
  const {host, edits, logger} = await fixture(t, {native: async (operation, signal) => {
    entered.resolve();
    await release.promise;
    return operation({setLogLevel() {nativeCalls++;}} as unknown as TelegramClient, signal);
  }});
  const first = host.dispatchPrimary({...message, text: ".loglevel debug"});
  const rejected = assert.rejects(first);
  await entered.promise;
  const second = host.dispatchPrimary({...message, chatId: "2", text: ".loglevel error"});
  const queuedRejected = assert.rejects(second);
  try {
    const report = await host.unload("loglevel", 1);
    assert.equal(report?.completed, false);
    assert.ok((report?.pendingTasks ?? 0) > 0);
    await assert.rejects(host.load(createLogLevel(logger)), /already loaded/);
  } finally {release.resolve();}
  await rejected;
  await queuedRejected;
  assert.equal((await host.unload("loglevel"))?.completed, true);
  assert.equal(nativeCalls, 0);
  assert.equal(logger.getLevel(), LogLevel.DEBUG);
  assert.deepEqual(edits, []);
});

test("loglevel final edit remains owned until real settlement", async t => {
  const entered = deferred();
  const release = deferred();
  const {host} = await fixture(t, {edit: async () => {entered.resolve(); await release.promise;}});
  const running = host.dispatchPrimary(message);
  await entered.promise;
  try {assert.equal((await host.unload("loglevel", 1))?.completed, false);}
  finally {release.resolve();}
  await running;
  assert.equal((await host.unload("loglevel"))?.completed, true);
});

test("loglevel invalid persisted data fails setup and does not reserve the command", async t => {
  const {host, logger, file, directory} = await fixture(t, {load: false});
  await mkdir(directory);
  await writeFile(file, '{"level":"debug"}');
  await assert.rejects(host.load(createLogLevel(logger)), /Invalid/);
  assert.equal(host.snapshot().plugins, 0);
  assert.equal(await host.dispatchPrimary(message), false);
  assert.equal(await readFile(file, "utf8"), '{"level":"debug"}');
});

test("loglevel 50 reloads retain config without resetting other modules or leaking tasks", async t => {
  const {host, logger, file} = await fixture(t);
  await host.dispatchPrimary({...message, text: ".loglevel warn"});
  for (let i = 0; i < 50; i++) {
    assert.equal((await host.unload("loglevel"))?.completed, true);
    await host.load(createLogLevel(logger));
    await host.dispatchPrimary(message);
    assert.equal(host.snapshot().plugins, 1);
    assert.equal(host.snapshot().lifecycle.pendingTasks, 0);
    assert.equal(logger.getLevel(), LogLevel.WARNING);
  }
  assert.equal(JSON.parse(await readFile(file, "utf8")).level, LogLevel.WARNING);
});
