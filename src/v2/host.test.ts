import test, {type TestContext} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {PluginHost, type HostOptions} from "./host";
import {definePlugin, type PluginDefinition, type MessageEnvelope, type CommandInvocation, type PluginContext} from "./sdk";
import {SelfDrainError} from "./lifecycle";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise, resolve};
}

const envelope: MessageEnvelope = {id: 1, chatId: "9007199254740993", senderId: "123", outgoing: true, text: ".ping"};

async function fixture(t: TestContext, options: Partial<HostOptions> = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "telebox-v2-host-")));
  const edits: {text: string; signal: AbortSignal}[] = [];
  const host = new PluginHost({storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit(_message, text, _options, signal) { edits.push({text, signal}); },
    async reply() { assert.fail("unexpected reply"); },
    async invoke() { assert.fail("unexpected RPC"); },
    async getReply() { assert.fail("unexpected read"); },
    async withClient() { assert.fail("unexpected client operation"); },
  }, ...options});
  t.after(async () => {
    const report = await host.shutdown(1000);
    assert.equal(report.completed, true, "fixture runtime must finish before directory removal");
    await rm(root, {recursive: true, force: true});
  });
  return {host, root, edits};
}

function plugin(handle: (input: CommandInvocation, context: PluginContext) => void | Promise<void>, rest: Partial<PluginDefinition> = {}) {
  return definePlugin({apiVersion: 1, id: "ping", description: "fixture", commands: {ping: {description: "fixture", handle}}, ...rest});
}

test("host parses longest aliases without changing the original message", async t => {
  const {host, edits} = await fixture(t, {prefixes: ["!", "."], aliases: {go: "ping one", "go now": "ping two"}});
  let received: CommandInvocation | undefined;
  await host.load(plugin(async (input, context) => { received = input; await context.telegram.edit(input.message, input.args.join(" ")); }));
  const message = {...envelope, text: "!go now extra", topicId: 42};
  assert.equal(await host.dispatchPrimary(message), true);
  assert.equal(edits[0].text, "two extra");
  assert.equal(received!.message.text, "!ping two extra");
  assert.equal(received!.message.chatId, "9007199254740993");
  assert.equal(received!.message.topicId, 42);
  assert.equal(message.text, "!go now extra");
  assert.equal(await host.dispatchPrimary({...envelope, text: ".toString"}), false);
});

test("primary admission and edited-message defaults preserve owner boundary", async t => {
  const {host} = await fixture(t);
  let calls = 0;
  await host.load(plugin(() => { calls++; }));
  assert.equal(await host.dispatchPrimary({...envelope, outgoing: false}), false);
  assert.equal(await host.dispatchPrimary({...envelope, edited: true}), false);
  assert.equal(await host.dispatchPrimary({...envelope, outgoing: false, saved: true}), true);
  assert.equal(calls, 1);
});

test("listener subscription is independent of command owner admission", async t => {
  const {host} = await fixture(t);
  const received: MessageEnvelope[] = [];
  await host.load(plugin(() => {}, {listeners: [{handle(message) { received.push(message); }}]}));
  await host.dispatchListeners({...envelope, outgoing: false});
  await host.dispatchListeners({...envelope, outgoing: false, edited: true});
  assert.equal(received.length, 1);
  assert.equal(received[0].outgoing, false);
});

test("setup reserves commands and failure cleans the candidate", async t => {
  const {host} = await fixture(t);
  const setup = deferred();
  const started = deferred();
  const loading = host.load(plugin(() => {}, {setup: async () => { started.resolve(); await setup.promise; throw new Error("setup failed"); }}));
  const rejected = assert.rejects(loading, /setup failed/);
  await started.promise;
  assert.equal(await host.dispatchPrimary(envelope), false);
  await assert.rejects(host.load(plugin(() => {}, {id: "other"})), /Command conflict/);
  setup.resolve();
  await rejected;
  assert.equal(host.snapshot().plugins, 0);
  await host.load(plugin(() => {}));
  assert.equal(await host.dispatchPrimary(envelope), true);
});

test("host retains cancelled work and refuses new writes through its context", async t => {
  const {host} = await fixture(t);
  const started = deferred();
  const release = deferred();
  await host.load(plugin(async (_input, context) => {
    const store = context.storage.json("config.json", {count: 0});
    started.resolve();
    await release.promise;
    await assert.rejects(store.update(value => ({...value, count: value.count + 1})));
  }));
  const running = host.dispatchPrimary(envelope);
  await started.promise;
  try {
    const report = await host.shutdown(5);
    assert.equal(report.completed, false);
    assert.equal(host.snapshot().plugins, 1);
    await assert.rejects(host.load(plugin(() => {}, {id: "replacement"})));
  } finally { release.resolve(); }
  await running;
  const report = await host.shutdown(1000);
  assert.equal(report.completed, true);
  assert.equal(host.snapshot().plugins, 0);
});

test("unawaited storage operations keep the old generation reserved until settlement", async t => {
  const {host} = await fixture(t);
  const started = deferred();
  const release = deferred();
  let write!: Promise<unknown>;
  await host.load(plugin((_input, context) => {
    write = context.storage.json("config.json", {count: 0}).update(async current => {
      started.resolve();
      await release.promise;
      return {...current, count: 1};
    });
  }));
  await host.dispatchPrimary(envelope);
  await started.promise;
  const rejected = assert.rejects(write);
  try {
    const report = await host.unload("ping", 5);
    assert.equal(report?.completed, false);
    assert.equal(report?.pendingTasks, 1);
    await assert.rejects(host.load(plugin(() => {})), /already loaded/);
  } finally { release.resolve(); }
  await rejected;
  assert.equal((await host.unload("ping", 1000))?.completed, true);
  let count = -1;
  await host.load(plugin(async (_input, context) => { count = (await context.storage.json("config.json", {count: 0}).read()).count; }));
  await host.dispatchPrimary(envelope);
  assert.equal(count, 0);
});

test("cleanup waits for setup settlement during concurrent unload", async t => {
  const {host} = await fixture(t);
  const started = deferred();
  const release = deferred();
  let initialized = false;
  let cleanups = 0;
  const loading = host.load(plugin(() => {}, {
    async setup() { started.resolve(); await release.promise; initialized = true; },
    cleanup() { assert.equal(initialized, true); initialized = false; cleanups++; },
  }));
  const rejected = assert.rejects(loading);
  await started.promise;
  try {
    assert.equal((await host.unload("ping", 5))?.completed, false);
    assert.equal(cleanups, 0);
  } finally { release.resolve(); }
  await rejected;
  assert.equal(cleanups, 1);
  assert.equal(initialized, false);
  assert.equal(host.snapshot().plugins, 0);
});

test("self-unload and self-shutdown reject before disabling or aborting the host", async t => {
  const {host} = await fixture(t);
  let calls = 0;
  await host.load(plugin(async (_input, context) => {
    calls++;
    await assert.rejects(host.unload("ping"), SelfDrainError);
    await assert.rejects(host.shutdown(), SelfDrainError);
    assert.equal(context.signal.aborted, false);
  }));
  await Promise.all([host.dispatchPrimary(envelope), host.dispatchPrimary(envelope)]);
  assert.equal(calls, 2);
  assert.equal(host.listCommands().length, 1);
  assert.equal((await host.shutdown()).completed, true);
});

test("invalid shutdown and unload deadlines leave dispatch enabled", async t => {
  const {host} = await fixture(t);
  await host.load(plugin(() => {}));
  await assert.rejects(host.unload("ping", NaN), RangeError);
  await assert.rejects(host.shutdown(-1), RangeError);
  assert.equal(await host.dispatchPrimary(envelope), true);
});

test("unload and reload cycle keeps resource counts bounded", async t => {
  const {host} = await fixture(t);
  let cleanups = 0;
  for (let iteration = 0; iteration < 50; iteration++) {
    await host.load(plugin(() => {}, {setup(context) { context.tasks.add("fixture", () => { cleanups++; }); }}));
    assert.equal(await host.dispatchPrimary(envelope), true);
    assert.equal((await host.unload("ping"))?.completed, true);
    assert.equal(host.snapshot().plugins, 0);
    assert.equal(host.snapshot().commands, 0);
  }
  assert.equal(cleanups, 50);
});

test("plugin ABI and commands reject invalid exports", () => {
  assert.throws(() => definePlugin({apiVersion: 0} as unknown as PluginDefinition), /API version/);
  assert.throws(() => plugin(() => {}, {id: "../outside"}), /plugin id/);
});

test("plugin services track both owners and preserve cancellation across calls", async t => {
  const {host} = await fixture(t);
  const started = deferred();
  const release = deferred();
  let callSignal!: AbortSignal;
  let context!: PluginContext;
  await host.load(definePlugin({apiVersion: 1, id: "provider", description: "fixture", commands: {}, services: {
    translate: {description: "fixture", async handle(input, _context, signal) {
      callSignal = signal;
      started.resolve();
      await release.promise;
      return input;
    }},
  }}));
  await host.load(plugin(() => {}, {setup(value) { context = value; }}));
  assert.equal(context.services.available("provider", "translate"), true);
  assert.equal(context.services.available("provider", "toString"), false);
  const calling = context.services.call("provider", "translate", "text");
  await started.promise;
  try {
    const report = await host.unload("provider", 5);
    assert.equal(report?.completed, false);
    assert.equal(callSignal.aborted, true);
    assert.equal(context.services.available("provider", "translate"), false);
    await assert.rejects(context.services.call("provider", "translate", "not admitted"));
    assert.equal((await host.unload("ping", 5))?.completed, false);
  } finally { release.resolve(); }
  assert.equal(await calling, "text");
  assert.equal((await host.unload("provider"))?.completed, true);
  assert.equal((await host.unload("ping"))?.completed, true);
});

test("services reject pre-cancelled calls without entering the provider", async t => {
  const {host} = await fixture(t);
  let context!: PluginContext;
  await host.load(plugin(() => {}, {setup(value) { context = value; }, services: {
    test: {description: "fixture", handle() { assert.fail("pre-cancelled service admitted"); }},
  }}));
  await assert.rejects(context.services.call("ping", "test", null, AbortSignal.abort()));
});

test("declarative jobs belong to their plugin generation", async t => {
  const {host} = await fixture(t);
  for (let index = 0; index < 50; index++) {
    await host.load(plugin(() => {}, {jobs: {daily: {
      cron: "0 0 1 1 *", timeZone: "UTC", description: "fixture", handle() {},
    }}}));
    assert.equal(host.snapshot().jobs.jobs, 1);
    assert.equal((await host.unload("ping"))?.completed, true);
    assert.deepEqual(host.snapshot().jobs, {jobs: 0, running: 0});
  }
});

test("reload closes old store capabilities and uses the new generation defaults", async t => {
  const {host} = await fixture(t);
  let store!: ReturnType<PluginContext["storage"]["json"]>;
  await host.load(plugin(() => {}, {setup(context) { store = context.storage.json("not-created.json", {version: 1}); }}));
  assert.deepEqual(await store.read(), {version: 1});
  await host.unload("ping");
  await assert.rejects(store.read());
  await host.load(plugin(() => {}, {setup(context) { store = context.storage.json("not-created.json", {version: 2}); }}));
  assert.deepEqual(await store.read(), {version: 2});
});

test("SQLite capabilities preserve IDs and close with their plugin generation", async t => {
  const {host} = await fixture(t);
  let context!: PluginContext;
  await host.load(plugin(() => {}, {setup(value) { context = value; }}));
  const store = context.storage.sqlite("state.db");
  await store.transaction(db => {
    db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)");
    db.prepare("INSERT INTO users VALUES (?, ?)").run(9007199254740993n, "fixture");
  });
  assert.equal(await store.read(db => db.prepare("SELECT id FROM users").pluck().get()), 9007199254740993n);
  assert.throws(() => context.storage.sqlite("state.db", {readonly: true}), /options conflict/);
  assert.throws(() => context.storage.sqlite("../outside.db"), /filename/);
  assert.equal((await host.unload("ping"))?.completed, true);
  await assert.rejects(store.read(() => assert.fail("closed SQLite callback ran")));
  await host.load(plugin(() => {}, {setup(value) { context = value; }}));
  assert.equal(await context.storage.sqlite("state.db", {readonly: true}).read(db =>
    db.prepare("SELECT id FROM users").pluck().get()), 9007199254740993n);
});

test("alias snapshots update atomically and never shadow a real command", async t => {
  const {host} = await fixture(t, {aliases: {ping: 'missing', 'ping now': 'ping expanded'}});
  const received: string[][] = [];
  await host.load(plugin(({args}) => { received.push([...args]); }));
  assert.equal(await host.dispatchPrimary(envelope), true);
  assert.deepEqual(received[0], []);
  await host.dispatchPrimary({...envelope, text: '.ping now'});
  assert.deepEqual(received[1], ['expanded']);
  host.replaceAliases({go: 'ping one'});
  const snapshot = host.configuration();
  snapshot.aliases.go = 'missing';
  await host.dispatchPrimary({...envelope, text: '.go'});
  assert.deepEqual(received[2], ['one']);
  assert.throws(() => host.replaceAliases({go: ''}));
  assert.equal(host.configuration().aliases.go, 'ping one');
});

test("replacePrefixes publishes a detached snapshot while retaining plugin generations", async t => {
  const {host} = await fixture(t, {aliases: {go: "ping"}});
  let context!: PluginContext;
  let calls = 0;
  let cleanups = 0;
  await host.load(plugin(() => { calls++; }, {setup(value) { context = value; }, cleanup() { cleanups++; }}));
  const prefixes = ["!", "🙂", "!"];
  host.replacePrefixes(prefixes);
  prefixes[0] = "mutated";
  host.configuration().prefixes.push("snapshot");
  assert.deepEqual(host.configuration(), {prefixes: ["!", "🙂"], aliases: {go: "ping"}});
  assert.equal(await host.dispatchPrimary(envelope), false);
  assert.equal(await host.dispatchPrimary({...envelope, text: "🙂go"}), true);
  assert.equal(context.signal.aborted, false);
  assert.equal(cleanups, 0);
  assert.equal(calls, 1);
});

test("replacePrefixes validates atomically and refuses updates after shutdown", async t => {
  const {host} = await fixture(t);
  for (const value of [[], [""], ["a b"], ["\n"], ["\0"], [42], Array(1), null]) {
    assert.throws(() => host.replacePrefixes(value as string[]));
    assert.deepEqual(host.configuration().prefixes, ["."]);
  }
  await host.shutdown();
  assert.throws(() => host.replacePrefixes(["!"]));
  assert.deepEqual(host.configuration().prefixes, ["."]);
});

test("constructor and replacePrefixes share default, validation and deduplication semantics", async t => {
  const {host, root} = await fixture(t);
  const options: HostOptions = {storageRoot: root, logger: {info() {}, error() {}}, telegram: {
    async edit() {}, async reply() {}, async invoke() {}, async getReply() { return undefined; },
    async withClient() { throw new Error("unused"); },
  }};
  assert.deepEqual(host.configuration().prefixes, ["."]);
  for (const prefixes of [[], [""], ["a b"], ["\n"], ["\0"], [42], Array(1), null]) {
    assert.throws(() => new PluginHost({...options, prefixes: prefixes as string[]}));
    assert.throws(() => host.replacePrefixes(prefixes as string[]));
  }
  const initial = ["🙂", "!", "🙂"];
  const other = new PluginHost({...options, prefixes: initial});
  try {
    host.replacePrefixes(initial);
    initial.push("mutated");
    assert.deepEqual(other.configuration().prefixes, ["🙂", "!"]);
    assert.deepEqual(host.configuration().prefixes, other.configuration().prefixes);
  } finally { assert.equal((await other.shutdown()).completed, true); }
});

test("a running command can replace prefixes without aborting itself or admitted commands", async t => {
  const {host} = await fixture(t);
  const started = deferred();
  const release = deferred();
  let calls = 0;
  await host.load(plugin(async (_input, context) => {
    calls++;
    if (calls === 1) { started.resolve(); await release.promise; host.replacePrefixes(["!"]); }
    assert.equal(context.signal.aborted, false);
  }));
  const first = host.dispatchPrimary(envelope);
  await started.promise;
  const admitted = host.dispatchPrimary(envelope);
  release.resolve();
  assert.deepEqual(await Promise.all([first, admitted]), [true, true]);
  assert.equal(await host.dispatchPrimary({...envelope, text: "!ping"}), true);
  assert.equal(calls, 3);
});

test("settings bindings stop at unload and secret updates preserve untouched fields", async t => {
  const {host} = await fixture(t);
  const secret = 'fixture-secret';
  await host.load(plugin(() => {}, {settings(context) {
    const store = context.storage.json('config.json', {token: secret, enabled: true, privateField: 'preserved'});
    return {
      title: 'fixture',
      getSchema() { return [{key: 'token', label: 'token', type: 'password'}, {key: 'enabled', label: 'enabled', type: 'boolean'}]; },
      getValues: () => store.read(),
      setValues: async patch => { await store.update(current => ({...current, ...patch})); },
    };
  }}));
  const before = await host.readSettings('ping');
  assert.doesNotMatch(JSON.stringify(before), new RegExp(secret));
  await host.patchSettings('ping', {enabled: false});
  assert.equal((await host.readSettings('ping')).values.enabled, false);
  assert.equal((await host.readSettings('ping')).secretSet.token, true);
  await assert.rejects(host.patchSettings('ping', {privateField: 'replace'}));
  await host.unload('ping');
  assert.deepEqual(await host.listSettings(), []);
  await assert.rejects(host.readSettings('ping'));
});

test("helper execution is a shared account budget, lazily allocated across plugins", async t => {
  const {host} = await fixture(t, {processes: {concurrency: 1, queueCapacity: 1, timeoutMs: 3000}});
  let first!: PluginContext;
  let second!: PluginContext;
  await host.load(plugin(() => {}, {setup(context) { first = context; }}));
  await host.load(definePlugin({apiVersion: 1, id: 'second', description: 'fixture', commands: {}, setup(context) { second = context; }}));
  assert.equal(host.snapshot().processes, undefined);
  const one = first.processes.run(process.execPath, ['-e', 'setTimeout(() => process.stdout.write("one"), 50)']);
  const two = second.processes.run(process.execPath, ['-e', 'process.stdout.write("two")']);
  await assert.rejects(second.processes.run(process.execPath, ['-e', 'process.exit(1)']), /queue is full/);
  assert.equal(host.snapshot().processes?.active, 1);
  assert.equal(host.snapshot().processes?.queued, 1);
  const results = await Promise.all([one, two]);
  assert.deepEqual(results.map(value => value.stdout.toString()), ['one', 'two']);
  assert.equal(host.snapshot().processes?.active, 0);
});
