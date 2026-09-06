import test, {type TestContext} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {setImmediate as turn} from "node:timers/promises";
import {PluginHost} from "./host";
import {PluginReleases, ReleaseError, type ReleaseState, type ReleaseOptions} from "./releases";
import {StorageRoot} from "./storage";
import {definePlugin, type PluginContext, type MessageEnvelope, type TelegramPort} from "./sdk";

const {buildPlugin} = require(path.resolve(__dirname, "../../scripts/build-v2-plugin.cjs")) as {
  buildPlugin(options: {id: string; packageRoot: string; entry: string; rootDir: string}): {manifest: {revision: string}};
};
const logger = {info() {}, error() {}};
const message: MessageEnvelope = {id: 1, chatId: "1", senderId: "1", text: ".fixture", outgoing: true};
const code = (expected: string) => (error: unknown) => error instanceof ReleaseError && error.code === expected;
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
}
interface Hooks {
  setup(version: string, context: PluginContext): Promise<void>;
  cleanup(version: string): Promise<void>;
  handle(version: string, context: PluginContext): Promise<void>;
}

function fixture(t: TestContext, configure?: (store: ReleaseOptions["store"]) => ReleaseOptions["store"]) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telebox-release-")));
  const packageRoot = path.join(root, "source");
  fs.mkdirSync(packageRoot);
  const token = `release_${randomUUID()}`;
  const events: string[] = [];
  const hooks: Hooks = {
    async setup(version) {events.push(`setup:${version}`);},
    async cleanup(version) {events.push(`cleanup:${version}`);},
    async handle(version) {events.push(`handle:${version}`);},
  };
  (globalThis as unknown as Record<string, unknown>)[token] = hooks;
  const storage = new StorageRoot(root);
  const store = storage.json<ReleaseState>("runtime", "releases.json", {schemaVersion: 1, plugins: {}, other: "preserved"});
  const telegram: TelegramPort = {
    async edit() {}, async reply() {}, async invoke() {}, async getReply() {return undefined;},
    async withClient() {throw new Error("Native client unavailable");},
  };
  const host = new PluginHost({storageRoot: path.join(root, "assets"), telegram, logger});
  const options = {artifactRoot: path.join(root, "dist", "v2-plugins"), store: configure?.(store) ?? store, stopTimeoutMs: 10};
  const releases = new PluginReleases(host, options);
  function build(version: string, command = "fixture", id = "fixture") {
    fs.writeFileSync(path.join(packageRoot, "index.ts"), `
      import {definePlugin} from 'telebox/sdk';
      export default function create() {
        const hooks = globalThis[${JSON.stringify(token)}];
        return definePlugin({apiVersion: 1, id: ${JSON.stringify(id)}, description: ${JSON.stringify(version)},
          commands: {[${JSON.stringify(command)}]: {description: 'fixture', handle: (_invocation, context) => hooks.handle(${JSON.stringify(version)}, context)}},
          setup: context => hooks.setup(${JSON.stringify(version)}, context),
          cleanup: () => hooks.cleanup(${JSON.stringify(version)})});
      }
    `);
    return buildPlugin({id, packageRoot, entry: "index.ts", rootDir: root}).manifest.revision;
  }
  t.after(async () => {
    await releases.shutdown(100);
    await host.shutdown(100);
    await storage.close();
    delete (globalThis as unknown as Record<string, unknown>)[token];
    fs.rmSync(root, {recursive: true, force: true});
  });
  return {root, host, releases, store, storage, options, build, events, hooks};
}

test("uninstall removes selection and commands while preserving plugin data", async t => {
  const f = fixture(t);
  const revision = f.build("a");
  f.hooks.setup = async (_version, ctx) => {
    await ctx.storage.json("data.json", {value: 7}).update(data => data);
  };
  await f.releases.activate("fixture", revision);
  await f.releases.remove("fixture");
  assert.equal(f.host.pluginState("fixture"), undefined);
  assert.deepEqual((await f.store.read()).plugins, {});
  assert.ok(fs.existsSync(path.join(f.root, "assets/fixture/data.json")));
  assert.deepEqual(f.releases.snapshot().generations, []);
});

test("saved selections reload into a new release manager after shutdown", async t => {
  const f = fixture(t);
  const revision = f.build("a");
  await f.releases.activate("fixture", revision);
  await f.releases.shutdown(100);
  const next = new PluginReleases(f.host, f.options);
  try {
    for (const [id, selected] of Object.entries((await f.store.read()).plugins)) {
      await next.activate(id, selected.current);
    }
    assert.equal(f.host.pluginState("fixture"), "active");
    assert.equal(next.snapshot().generations[0].revision, revision);
    await f.host.dispatchPrimary(message);
    assert.equal(f.events.at(-1), "handle:a");
  } finally {await next.shutdown(100);}
});

test("failed uninstall state commit restores the loaded generation", async t => {
  let fail = false;
  const f = fixture(t, store => ({read: store.read.bind(store), update: async (...args) => {
    if (fail) throw new Error("write failed");
    return store.update(...args);
  }}));
  const revision = f.build("a");
  await f.releases.activate("fixture", revision);
  fail = true;
  await assert.rejects(f.releases.remove("fixture"), /write failed/);
  assert.equal(f.host.pluginState("fixture"), "active");
  assert.equal((await f.store.read()).plugins.fixture.current, revision);
});

test("activation stops the old generation before setup, and rollback preserves current data", async t => {
  const f = fixture(t);
  const a = f.build("a");
  const b = f.build("b");
  const seen: unknown[] = [];
  f.hooks.setup = async (version, context) => {
    f.events.push(`setup:${version}`);
    const data = context.storage.json("state.json", {count: 0, id: 9007199254740993n, unknown: "keep"});
    seen.push(await data.update(current => ({...current, count: current.count + 1})));
  };
  await f.releases.activate("fixture", a);
  await f.host.dispatchPrimary(message);
  await f.releases.activate("fixture", b);
  await f.host.dispatchPrimary(message);
  await f.releases.rollback("fixture");
  assert.deepEqual(f.events, ["setup:a", "handle:a", "cleanup:a", "setup:b", "handle:b", "cleanup:b", "setup:a"]);
  assert.deepEqual(seen.at(-1), {count: 3, id: 9007199254740993n, unknown: "keep"});
  assert.deepEqual(await f.store.read(), {schemaVersion: 1, other: "preserved", plugins: {fixture: {current: a, previous: b}}});
  assert.deepEqual(f.releases.snapshot().generations, [{id: "fixture", revision: a, state: "active"}]);
});

test("same active revision is idempotent and keeps per-plugin selection metadata", async t => {
  const f = fixture(t);
  const a = f.build("a");
  await f.store.update(state => ({...state, plugins: {fixture: {current: a, extension: "keep"}}}));
  await f.releases.activate("fixture", a);
  await f.releases.activate("fixture", a);
  assert.deepEqual(f.events, ["setup:a"]);
  assert.equal((await f.store.read()).plugins.fixture.extension, "keep");
});

test("corrupt candidate fails inspection while the active generation remains usable", async t => {
  const f = fixture(t);
  const a = f.build("a");
  const b = f.build("b");
  await f.releases.activate("fixture", a);
  fs.appendFileSync(path.join(f.options.artifactRoot, "fixture", b, "index.cjs"), "corrupt");
  await assert.rejects(f.releases.activate("fixture", b));
  assert.equal(await f.host.dispatchPrimary(message), true);
  assert.deepEqual(f.events, ["setup:a", "handle:a"]);
  assert.equal((await f.store.read()).plugins.fixture.current, a);
});

test("candidate command conflicts are rejected before old cleanup or candidate setup", async t => {
  const f = fixture(t);
  const a = f.build("a");
  const b = f.build("b", "occupied");
  await f.host.load(definePlugin({apiVersion: 1, id: "native", description: "native", commands: {occupied: {description: "", handle() {}}}}));
  await f.releases.activate("fixture", a);
  await assert.rejects(f.releases.activate("fixture", b), code("CONFLICT"));
  assert.deepEqual(f.events, ["setup:a"]);
  assert.equal(f.host.listPlugins().length, 2);
});

test("a failed setup restores a fresh old instance without restoring a data snapshot", async t => {
  const f = fixture(t);
  const a = f.build("a");
  const b = f.build("b");
  const observed: number[] = [];
  f.hooks.setup = async (version, context) => {
    f.events.push(`setup:${version}`);
    const state = context.storage.json("data.json", {count: 0});
    const data = await state.update(current => ({...current, count: current.count + 1}));
    observed.push(data.count);
    if (version === "b") throw new Error("private setup failure");
  };
  await f.releases.activate("fixture", a);
  await assert.rejects(f.releases.activate("fixture", b), code("ACTIVATE"));
  assert.deepEqual(f.events, ["setup:a", "cleanup:a", "setup:b", "cleanup:b", "setup:a"]);
  assert.deepEqual(observed, [1, 2, 3]);
  assert.equal((await f.store.read()).plugins.fixture.current, a);
  assert.equal(await f.host.dispatchPrimary(message), true);
});

test("failed selection persistence stops the candidate and restores the old generation", async t => {
  let fail = false;
  const f = fixture(t, store => ({read: signal => store.read(signal), update: async (callback, signal) => {
    if (fail) throw new Error("private disk error");
    return store.update(callback, signal);
  }}));
  const a = f.build("a");
  const b = f.build("b");
  await f.releases.activate("fixture", a);
  fail = true;
  await assert.rejects(f.releases.activate("fixture", b), code("ACTIVATE"));
  assert.equal((await f.store.read()).plugins.fixture.current, a);
  assert.equal(f.host.pluginState("fixture"), "active");
  assert.deepEqual(f.events, ["setup:a", "cleanup:a", "setup:b", "cleanup:b", "setup:a"]);
});

test("timed-out cleanup blocks the replacement until actual settlement", async t => {
  const f = fixture(t);
  const a = f.build("a");
  const b = f.build("b");
  const gate = deferred();
  f.hooks.cleanup = async version => {f.events.push(`cleanup:${version}`); if (version === "a") await gate.promise;};
  await f.releases.activate("fixture", a);
  await assert.rejects(f.releases.activate("fixture", b), code("STOP"));
  assert.deepEqual(f.events, ["setup:a", "cleanup:a"]);
  assert.equal(f.host.pluginState("fixture"), "draining");
  assert.equal((await f.store.read()).plugins.fixture.current, a);
  gate.resolve();
  await f.releases.activate("fixture", b);
  assert.equal(f.host.pluginState("fixture"), "active");
  assert.equal((await f.store.read()).plugins.fixture.current, b);
});

test("failed cleanup remains owned and never admits the candidate", async t => {
  const f = fixture(t);
  const a = f.build("a");
  const b = f.build("b");
  f.hooks.cleanup = async () => {throw new Error("private cleanup failure");};
  await f.releases.activate("fixture", a);
  await assert.rejects(f.releases.activate("fixture", b), code("STOP"));
  assert.equal(f.releases.snapshot().generations[0].revision, a);
  assert.deepEqual(f.events, ["setup:a"]);
  assert.equal((await f.releases.shutdown(100)).completed, false);
});

test("failed restoration remains explicit and can be recovered by an independent activation", async t => {
  const f = fixture(t);
  const a = f.build("a");
  const b = f.build("b");
  let fail = false;
  f.hooks.setup = async version => {if (fail) throw new Error(version + " private");};
  await f.releases.activate("fixture", a);
  fail = true;
  await assert.rejects(f.releases.activate("fixture", b), code("RESTORE"));
  assert.equal(f.releases.snapshot().generations[0].state, "failed");
  assert.equal(f.host.pluginState("fixture"), undefined);
  fail = false;
  await f.releases.activate("fixture", a);
  assert.equal(f.host.pluginState("fixture"), "active");
});

test("management from an active plugin handler cannot unload its own scope", async t => {
  const f = fixture(t);
  const a = f.build("a");
  const b = f.build("b");
  f.hooks.handle = async () => {await assert.rejects(f.releases.activate("fixture", b), /cannot drain its own scope/);};
  await f.releases.activate("fixture", a);
  assert.equal(await f.host.dispatchPrimary(message), true);
  assert.deepEqual(f.events, ["setup:a"]);
  assert.equal(f.host.pluginState("fixture"), "active");
});

test("queued changes serialize and do not stop unrelated plugins", async t => {
  const f = fixture(t);
  const a = f.build("a");
  const b = f.build("b");
  const c = f.build("c");
  const unrelated = f.build("other", "other", "other");
  await f.releases.activate("other", unrelated);
  await Promise.all([f.releases.activate("fixture", a), f.releases.activate("fixture", b), f.releases.activate("fixture", c)]);
  assert.deepEqual(f.events, ["setup:other", "setup:a", "cleanup:a", "setup:b", "cleanup:b", "setup:c"]);
  assert.equal(f.host.pluginState("other"), "active");
});

test("shutdown waits for an in-flight setup and releases code only after actual cleanup", async t => {
  const f = fixture(t);
  const a = f.build("a");
  const entered = deferred();
  const gate = deferred();
  f.hooks.setup = async () => {entered.resolve(); await gate.promise;};
  const activation = f.releases.activate("fixture", a);
  const rejected = assert.rejects(activation, code("ACTIVATE"));
  await entered.promise;
  const first = await f.releases.shutdown(5);
  assert.equal(first.completed, false);
  assert.equal(first.pendingTasks, 1);
  gate.resolve();
  await rejected;
  assert.equal((await f.releases.shutdown()).completed, true);
  assert.equal(f.host.pluginState("fixture"), undefined);
  assert.deepEqual((await f.store.read()).plugins, {});
  assert.equal(Object.keys(require.cache).some(file => file.startsWith(f.options.artifactRoot + path.sep)), false);
});

test("50 release changes leave one generation and shutdown clears all owned cache entries", async t => {
  const f = fixture(t);
  const a = f.build("a");
  const b = f.build("b");
  for (let index = 0; index < 50; index++) {
    await f.releases.activate("fixture", index % 2 ? a : b);
    assert.equal(f.releases.snapshot().generations.length, 1);
    assert.equal(f.host.snapshot().plugins, 1);
    assert.equal(f.releases.snapshot().queue.active, 0);
  }
  assert.equal((await f.releases.shutdown()).completed, true);
  await turn();
  assert.equal(Object.keys(require.cache).some(file => file.startsWith(f.options.artifactRoot + path.sep)), false);
  assert.equal(f.host.snapshot().plugins, 0);
});

test("invalid selection schemas, revision paths, and absent rollback fail without setup", async t => {
  const f = fixture(t);
  const a = f.build("a");
  await assert.rejects(f.releases.rollback("fixture"), code("NO_PREVIOUS"));
  await assert.rejects(f.releases.activate("../fixture", a), code("STATE"));
  await assert.rejects(f.releases.activate("fixture", "../a"), code("STATE"));
  await f.store.update(current => ({...current, plugins: {fixture: {current: "bad"}}}));
  await assert.rejects(f.releases.activate("fixture", a), code("STATE"));
  assert.deepEqual(f.events, []);
});

test("externally loaded plugin ownership is never taken over", async t => {
  const f = fixture(t);
  const a = f.build("a");
  await f.host.load(definePlugin({apiVersion: 1, id: "fixture", description: "native", commands: {}}));
  await assert.rejects(f.releases.activate("fixture", a), code("CONFLICT"));
  assert.equal(f.host.pluginState("fixture"), "active");
  assert.deepEqual(f.events, []);
});

test("activation races never unload a foreign instance that acquired the same plugin ID", async t => {
  const f = fixture(t);
  const a = f.build("a");
  const b = f.build("b");
  await f.releases.activate("fixture", a);
  const load = f.host.load.bind(f.host);
  let foreignCleanups = 0;
  let inserted = false;
  t.mock.method(f.host, "load", async (definition: Parameters<PluginHost["load"]>[0], owner?: object) => {
    if (definition.description === "b" && !inserted) {
      inserted = true;
      await load(definePlugin({apiVersion: 1, id: "fixture", description: "foreign", commands: {},
        cleanup() {foreignCleanups++;}}));
    }
    return load(definition, owner);
  });
  await assert.rejects(f.releases.activate("fixture", b), code("RESTORE"));
  assert.equal(f.host.listPlugins()[0].description, "foreign");
  assert.equal(foreignCleanups, 0);
  assert.equal((await f.store.read()).plugins.fixture.current, a);
  await assert.rejects(f.releases.activate("fixture", a), code("CONFLICT"));
  assert.equal((await f.releases.shutdown()).completed, true);
  assert.equal(foreignCleanups, 0);
  assert.equal(f.host.pluginState("fixture"), "active");
});

test("shutdown stops admission for every generation while an earlier cleanup is pending", async t => {
  const f = fixture(t);
  const a = f.build("a");
  const b = f.build("b", "other", "other");
  const gate = deferred();
  f.hooks.cleanup = async version => {if (version === "a") await gate.promise;};
  await f.releases.activate("fixture", a);
  await f.releases.activate("other", b);
  const report = await f.releases.shutdown(5);
  assert.equal(report.completed, false);
  assert.equal(await f.host.dispatchPrimary({...message, text: ".other"}), false);
  assert.notEqual(f.host.pluginState("other"), "active");
  gate.resolve();
  assert.equal((await f.releases.shutdown()).completed, true);
});

test("shutdown cancels a setup waiting on its own plugin signal before waiting for the management queue", async t => {
  const f = fixture(t);
  const a = f.build("a");
  const entered = deferred();
  f.hooks.setup = async (_version, context) => {
    entered.resolve();
    await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), {once: true}));
  };
  const activation = f.releases.activate("fixture", a);
  const rejected = assert.rejects(activation, code("ACTIVATE"));
  await entered.promise;
  assert.equal((await f.releases.shutdown(1000)).completed, true);
  await rejected;
  assert.equal(f.host.pluginState("fixture"), undefined);
  assert.deepEqual(f.releases.snapshot().generations, []);
});
