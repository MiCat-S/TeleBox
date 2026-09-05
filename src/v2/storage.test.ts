import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { JsonStore, StorageRoot } from "./storage";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  // macOS exposes /var through a symlink; supply its real path to the storage API.
  const directory = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), "telebox-storage-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, "state.json") };
}

async function missing(file: string) {
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
}

test("local runtime preserves unsafe integer source text and emits raw JSON", () => {
  const json = JSON as JSON & { rawJSON(text: string): unknown };
  const reviver = (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value === "number") {
      assert.equal(context?.source, "900719925474099312345");
      return BigInt(context!.source!);
    }
    return value;
  };
  const value = JSON.parse('{"id":900719925474099312345}', reviver);
  assert.equal(value.id, 900719925474099312345n);
  assert.equal(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? json.rawJSON(String(item)) : item), '{"id":900719925474099312345}');
});

test("defaults are detached, nested, lazy and never written by reads or close", async t => {
  const { directory } = await fixture(t);
  const rootPath = path.join(directory, "not-created");
  const defaults = { count: 0, nested: { enabled: true }, id: 9007199254740993n };
  const root = new StorageRoot(rootPath);
  const store = root.json("plugin", "state.json", defaults);
  defaults.nested.enabled = false;
  const first = await store.read();
  assert.equal(first.nested.enabled, true);
  first.nested.enabled = false;
  first.count = 50;
  assert.deepEqual(await store.read(), { count: 0, nested: { enabled: true }, id: 9007199254740993n });
  await root.close();
  await missing(rootPath);
});

test("concurrent updates and reads are serialized in admission order", async t => {
  const { file } = await fixture(t);
  const store = new JsonStore(file, { count: 0 });
  t.after(() => store.close());
  let active = 0;
  const writes = Array.from({ length: 60 }, () => store.update(async current => {
    assert.equal(++active, 1);
    await new Promise<void>(resolve => setImmediate(resolve));
    --active;
    return { count: current.count + 1 };
  }));
  const read = store.read();
  assert.deepEqual((await Promise.all(writes)).map(value => value.count), Array.from({ length: 60 }, (_, i) => i + 1));
  assert.deepEqual(await read, { count: 60 });
});

test("updates create private files and survive reopening", async t => {
  const { directory } = await fixture(t);
  const rootPath = path.join(directory, "storage");
  const root = new StorageRoot(rootPath);
  const store = root.json("plugin-a_1", "state.v2.json", { count: 0 });
  const result = await store.update(() => ({ count: 4 }));
  result.count = 100;
  const file = path.join(rootPath, "plugin-a_1", "state.v2.json");
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  await root.close();
  const reopened = new StorageRoot(rootPath);
  assert.deepEqual(await reopened.json("plugin-a_1", "state.v2.json", { count: 0 }).read(), { count: 4 });
  await reopened.close();
  assert.deepEqual(await fs.readdir(path.dirname(file)), ["state.v2.json"]);
});

test("read preserves existing bytes and permissions; commit applies 0600", async t => {
  const { file } = await fixture(t);
  const bytes = '{ "count" : 2 }\n';
  await fs.writeFile(file, bytes, { mode: 0o644 });
  const beforeMode = (await fs.stat(file)).mode;
  const store = new JsonStore(file, { count: 0 });
  assert.deepEqual(await store.read(), { count: 2 });
  assert.equal(await fs.readFile(file, "utf8"), bytes);
  assert.equal((await fs.stat(file)).mode, beforeMode);
  await store.update(value => value);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await store.close();
});

test("complete document updates preserve untouched unknown fields and large integers", async t => {
  const { file } = await fixture(t);
  await fs.writeFile(file, '{"count":2,"nested":{"known":1,"future":{"id":900719925474099312345}},"unknown":[1,{"id":-900719925474099312345}],"__proto__":{"safe":true},"constructor":{"version":2}}');
  const store = new JsonStore<Record<string, unknown>>(file, { count: 0, nested: { known: 0, defaulted: true } });
  const mutated = await store.update(value => {
    value.count = 3;
    (value.nested as Record<string, unknown>).known = 7;
    return value;
  });
  const result = await store.update(value => ({
    ...value,
    nested: { ...(value.nested as Record<string, unknown>), known: 8 },
  }));
  assert.deepEqual(mutated.nested, { known: 7, future: { id: 900719925474099312345n } });
  assert.deepEqual(result.nested, { known: 8, future: { id: 900719925474099312345n } });
  assert.deepEqual(result.unknown, [1, { id: -900719925474099312345n }]);
  assert.deepEqual(result.__proto__, { safe: true });
  assert.deepEqual(result.constructor, { version: 2 });
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(({} as Record<string, unknown>).safe, undefined);
  assert.deepEqual(await store.read(), result);
  await store.close();
  const reopened = new JsonStore<Record<string, unknown>>(file, {});
  assert.deepEqual(await reopened.read(), result);
  await reopened.close();
});

test("complete document updates support arrays, null and scalars", async t => {
  const { file } = await fixture(t);
  const store = new JsonStore<Record<string, unknown>>(file, { list: [1, 2], nested: { known: 1 }, text: "old" });
  assert.deepEqual(await store.update(() => ({ list: [3], nested: null, text: "new" })), { list: [3], nested: null, text: "new" });
  await store.close();
});

test("existing documents are authoritative; defaults apply only to missing files", async t => {
  const { file } = await fixture(t);
  const bytes = '{"nested":{"enabled":false},"unknown":7}';
  await fs.writeFile(file, bytes);
  const defaults = { count: 0, nested: { enabled: true, extra: true } };
  const store = new JsonStore<Record<string, unknown>>(file, defaults);
  assert.deepEqual(await store.read(), { nested: { enabled: false }, unknown: 7 });
  assert.equal(await fs.readFile(file, "utf8"), bytes);
  await store.update(value => value);
  await store.close();
  const reopened = new JsonStore<Record<string, unknown>>(file, defaults);
  assert.deepEqual(await reopened.read(), { nested: { enabled: false }, unknown: 7 });
  await reopened.close();
});

test("explicit provider, alias and top-level deletions persist across reads and reopening", async t => {
  const { file } = await fixture(t);
  const defaults: Record<string, unknown> = {
    providers: { retired: { model: "old" }, active: { model: "current", futureId: 900719925474099312345n } },
    aliases: { old: "retired", keep: "active" },
    selectedProvider: "retired",
    unknown: { cursor: -900719925474099312345n },
  };
  const store = new JsonStore(file, defaults);
  await store.update(value => value);
  const result = await store.update(async value => {
    await Promise.resolve();
    delete (value.providers as Record<string, unknown>).retired;
    delete (value.aliases as Record<string, unknown>).old;
    delete value.selectedProvider;
    return value;
  });
  const expected = {
    providers: { active: { model: "current", futureId: 900719925474099312345n } },
    aliases: { keep: "active" },
    unknown: { cursor: -900719925474099312345n },
  };
  assert.deepEqual(result, expected);
  assert.deepEqual(await store.read(), expected);
  const bytes = await fs.readFile(file, "utf8");
  assert.ok(!bytes.includes('"retired"'));
  assert.ok(!bytes.includes('"old"'));
  assert.ok(!bytes.includes('"selectedProvider"'));
  await store.close();
  const reopened = new JsonStore(file, defaults);
  assert.deepEqual(await reopened.read(), expected);
  assert.deepEqual(await reopened.update(value => value), expected);
  await reopened.close();
});

test("returned complete objects authoritatively replace nested maps and root keys", async t => {
  const { file } = await fixture(t);
  const defaults = { providers: { old: { model: "old" } }, aliases: { old: "old" }, optional: true };
  const store = new JsonStore<Record<string, unknown>>(file, defaults);
  await store.update(value => value);
  const result = await store.update(value => ({ ...value, providers: {}, aliases: {} }));
  assert.deepEqual(result, { providers: {}, aliases: {}, optional: true });
  assert.deepEqual(await store.read(), result);
  assert.deepEqual(await store.update(() => ({ providers: { active: { model: "new" } } })), { providers: { active: { model: "new" } } });
  assert.deepEqual(await store.read(), { providers: { active: { model: "new" } } });
  assert.deepEqual(await store.update(() => ({})), {});
  assert.equal(await fs.readFile(file, "utf8"), "{}\n");
  await store.close();
  const reopened = new JsonStore<Record<string, unknown>>(file, defaults);
  assert.deepEqual(await reopened.read(), {});
  await reopened.close();
});

test("failed or canceled deletions preserve the prior document byte for byte", async t => {
  const { file } = await fixture(t);
  const bytes = '{ "providers": {"active": {"model": "current"}}, "aliases": {"keep": "active"} }';
  await fs.writeFile(file, bytes);
  const store = new JsonStore<Record<string, unknown>>(file, {});
  await assert.rejects(store.update(value => {
    delete (value.providers as Record<string, unknown>).active;
    delete value.aliases;
    throw new Error("deletion failed");
  }), /deletion failed/);
  assert.equal(await fs.readFile(file, "utf8"), bytes);
  const controller = new AbortController();
  await assert.rejects(store.update(value => {
    delete (value.providers as Record<string, unknown>).active;
    delete value.aliases;
    controller.abort();
    return value;
  }, controller.signal), { name: "AbortError" });
  assert.equal(await fs.readFile(file, "utf8"), bytes);
  assert.deepEqual(await store.read(), JSON.parse(bytes));
  await store.close();
});

test("integer literals including hundreds of digits round-trip exactly", async t => {
  const { file } = await fixture(t);
  const huge = "9".repeat(400);
  const source = `{"safe":9007199254740991,"edge":9007199254740992,"positive":900719925474099312345,"negative":-900719925474099312345,"huge":${huge},"array":[900719925474099312345],"count":0}`;
  await fs.writeFile(file, source);
  const store = new JsonStore<Record<string, unknown>>(file, { count: 0 });
  const value = await store.read();
  assert.equal(value.safe, 9007199254740991);
  assert.equal(value.edge, 9007199254740992n);
  assert.equal(value.positive, 900719925474099312345n);
  assert.equal(value.negative, -900719925474099312345n);
  assert.equal(value.huge, BigInt(huge));
  await store.update(value => ({ ...value, count: 1, added: 9223372036854775807n }));
  const bytes = await fs.readFile(file, "utf8");
  assert.ok(bytes.includes(`"huge":${huge}`));
  assert.ok(bytes.includes('"positive":900719925474099312345'));
  assert.ok(bytes.includes('"negative":-900719925474099312345'));
  assert.ok(bytes.includes('"added":9223372036854775807'));
  await store.close();
  const reopened = new JsonStore<Record<string, unknown>>(file, {});
  assert.equal((await reopened.read()).huge, BigInt(huge));
  await reopened.close();
});

test("ordinary decimal numbers use IEEE-754 and do not preserve lexical representation", async t => {
  const { file } = await fixture(t);
  await fs.writeFile(file, '{"fraction":0.1234567890123456789,"exponent":1e3,"zero":-0}');
  const store = new JsonStore<Record<string, unknown>>(file, {});
  const value = await store.read();
  assert.equal(value.fraction, 0.12345678901234568);
  assert.equal(value.exponent, 1000);
  assert.ok(Object.is(value.zero, -0));
  await store.update(value => value);
  assert.equal(await fs.readFile(file, "utf8"), '{"fraction":0.12345678901234568,"exponent":1000,"zero":0}\n');
  await store.close();
});

test("unsafe decimals, exponent integers and overflow fail without altering bytes", async t => {
  const { file } = await fixture(t);
  const store = new JsonStore<Record<string, unknown>>(file, {});
  for (const literal of ["9007199254740993.0", "9007199254740993.1", "9.007199254740993e15", "1e400", "-1e400"]) {
    const bytes = `{"id":${literal}}`;
    await fs.writeFile(file, bytes);
    await assert.rejects(store.read(), /Unsafe decimal or exponent/);
    await assert.rejects(store.update(() => ({})), /Unsafe decimal or exponent/);
    assert.equal(await fs.readFile(file, "utf8"), bytes);
  }
  await store.close();
});

test("mutator and serialization failures roll back and leave the queue usable", async t => {
  const { directory, file } = await fixture(t);
  const bytes = '{ "count": 2, "nested": {"id": 7} }';
  await fs.writeFile(file, bytes);
  const store = new JsonStore<Record<string, unknown>>(file, {});
  await assert.rejects(store.update(async value => {
    (value.nested as Record<string, unknown>).id = 0;
    throw new Error("mutation failed");
  }), /mutation failed/);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const invalid of [cyclic, { id: Number.MAX_SAFE_INTEGER + 1 }, { id: Infinity }, { id: NaN }, { id: undefined }, { id: () => 0 }, { id: Symbol("id") }, null, [], 3]) {
    await assert.rejects(store.update(() => invalid as Record<string, unknown>));
    assert.equal(await fs.readFile(file, "utf8"), bytes);
    assert.deepEqual(await fs.readdir(directory), ["state.json"]);
  }
  assert.deepEqual(await store.update(value => ({ ...value, count: 3 })), { count: 3, nested: { id: 7 } });
  await store.close();
});

test("malformed or non-object files are reported, not replaced with defaults", async t => {
  const { file } = await fixture(t);
  const store = new JsonStore(file, { count: 0 });
  for (const bytes of ["", "{broken", "null", "[]", "1", '"text"']) {
    await fs.writeFile(file, bytes);
    await assert.rejects(store.read());
    await assert.rejects(store.update(() => ({ count: 1 })));
    assert.equal(await fs.readFile(file, "utf8"), bytes);
  }
  await store.close();
});

test("pre-aborted operations do not invoke mutators or create directories", async t => {
  const { directory } = await fixture(t);
  const file = path.join(directory, "missing", "state.json");
  const store = new JsonStore(file, { count: 0 });
  const controller = new AbortController();
  const reason = new Error("canceled");
  controller.abort(reason);
  await assert.rejects(store.read(controller.signal), error => error === reason);
  await assert.rejects(store.update(() => { assert.fail("mutator ran"); }, controller.signal), error => error === reason);
  await missing(path.dirname(file));
  await store.close();
});

test("queued cancellation skips the mutator and active cancellation discards changes", async t => {
  const { file } = await fixture(t);
  await fs.writeFile(file, '{"count":2}');
  const store = new JsonStore(file, { count: 0 });
  const started = gate();
  const release = gate();
  const active = new AbortController();
  const queued = new AbortController();
  const first = store.update(async value => {
    started.resolve();
    await release.promise;
    value.count = 9;
    return value;
  }, active.signal);
  const second = store.update(() => { assert.fail("queued mutator ran"); }, queued.signal);
  const firstRejected = assert.rejects(first, { name: "AbortError" });
  const secondRejected = assert.rejects(second, { name: "AbortError" });
  await started.promise;
  active.abort();
  queued.abort();
  release.resolve();
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(await fs.readFile(file, "utf8"), '{"count":2}');
  assert.deepEqual(await store.update(() => ({ count: 3 })), { count: 3 });
  await store.close();
});

for (const phase of ["open", "chmod", "writeFile", "sync", "close", "rename"] as const) {
  test(`failure during ${phase} preserves old bytes and removes the temporary file`, async t => {
    const { directory, file } = await fixture(t);
    const bytes = '{ "count" : 2 }';
    await fs.writeFile(file, bytes);
    const store = new JsonStore(file, { count: 0 });
    const fail = new Error(`injected ${phase} failure`);
    const originalOpen = fs.open;
    if (phase === "rename") {
      t.mock.method(fs, "rename", async () => { throw fail; });
    } else {
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        if (String(args[0]).endsWith(".tmp") && phase === "open") throw fail;
        const handle = await originalOpen(...args);
        if (String(args[0]).endsWith(".tmp")) {
          if (phase === "writeFile") {
            t.mock.method(handle, "writeFile", async () => {
              await handle.write("partial bytes");
              throw fail;
            });
          } else if (phase === "chmod") {
            t.mock.method(handle, "chmod", async () => { throw fail; });
          } else if (phase === "close") {
            const close = handle.close.bind(handle);
            t.mock.method(handle, "close", async () => { await close(); throw fail; }, { times: 1 });
          } else {
            t.mock.method(handle, "sync", async () => { throw fail; });
          }
        }
        return handle;
      });
    }
    await assert.rejects(store.update(() => ({ count: 9 })), error => error === fail);
    t.mock.restoreAll();
    assert.equal(await fs.readFile(file, "utf8"), bytes);
    assert.deepEqual(await fs.readdir(directory), ["state.json"]);
    assert.deepEqual(await store.update(() => ({ count: 3 })), { count: 3 });
    await store.close();
  });
}

test("cancellation after file fsync and before rename leaves old bytes", async t => {
  const { directory, file } = await fixture(t);
  await fs.writeFile(file, '{"count":2}');
  const store = new JsonStore(file, { count: 0 });
  const controller = new AbortController();
  const originalOpen = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith(".tmp")) {
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, "sync", async () => {
        await sync();
        controller.abort();
      });
    }
    return handle;
  });
  await assert.rejects(store.update(() => ({ count: 9 }), controller.signal), { name: "AbortError" });
  assert.equal(await fs.readFile(file, "utf8"), '{"count":2}');
  assert.deepEqual(await fs.readdir(directory), ["state.json"]);
  await store.close();
});

test("fsync and descriptor close precede atomic rename; commit wins later cancellation", async t => {
  const { file } = await fixture(t);
  const store = new JsonStore(file, { count: 0 });
  const events: string[] = [];
  const controller = new AbortController();
  const originalOpen = fs.open;
  const originalRename = fs.rename;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith(".tmp")) {
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);
      t.mock.method(handle, "sync", async () => { await sync(); events.push("sync"); });
      t.mock.method(handle, "close", async () => { await close(); events.push("close"); });
    }
    return handle;
  });
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    assert.deepEqual(events, ["sync", "close"]);
    assert.equal(path.dirname(String(args[0])), path.dirname(String(args[1])));
    assert.equal((await fs.stat(args[0])).mode & 0o777, 0o600);
    await originalRename(...args);
    controller.abort();
    events.push("rename");
  });
  assert.deepEqual(await store.update(() => ({ count: 1 }), controller.signal), { count: 1 });
  assert.deepEqual(events, ["sync", "close", "rename"]);
  assert.equal(await fs.readFile(file, "utf8"), '{"count":1}\n');
  await store.close();
});

test("store close rejects new work and waits for all admitted operations, including failures", async t => {
  const { file } = await fixture(t);
  const store = new JsonStore(file, { count: 0 });
  const started = gate();
  const release = gate();
  const first = store.update(async () => { started.resolve(); await release.promise; return { count: 1 }; });
  const failed = store.update(() => { throw new Error("expected"); });
  const rejected = assert.rejects(failed, /expected/);
  const last = store.update(value => ({ count: value.count + 1 }));
  const admittedRead = store.read();
  await started.promise;
  const closing = store.close();
  assert.equal(store.close(), closing);
  let closed = false;
  void closing.then(() => { closed = true; });
  await assert.rejects(store.read(), /closed/);
  await assert.rejects(store.update(value => value), /closed/);
  assert.equal(closed, false);
  release.resolve();
  await Promise.all([first, rejected, last, closing]);
  assert.deepEqual(await admittedRead, { count: 2 });
  assert.equal(closed, true);
});

test("root caches full paths, isolates plugins, and closes every owned store", async t => {
  const { directory } = await fixture(t);
  const root = new StorageRoot(directory);
  const first = root.json("a", "state.json", { count: 1 });
  assert.equal(root.json("a", "state.json", { count: 99 }), first);
  const second = root.json("b", "state.json", { count: 2 });
  const third = root.json("a", "other.json", { count: 3 });
  assert.notEqual(first, second);
  assert.notEqual(first, third);
  const release = gate();
  const active = first.update(async value => { await release.promise; return value; });
  const secondUpdate = second.update(value => value);
  const closing = root.close();
  assert.equal(root.close(), closing);
  assert.throws(() => root.json("a", "state.json", { count: 0 }), /closed/);
  for (const store of [first, second, third]) await assert.rejects(store.read(), /closed/);
  release.resolve();
  await Promise.all([active, secondUpdate, closing]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "a", "state.json"), "utf8")), { count: 1 });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "b", "state.json"), "utf8")), { count: 2 });
  await missing(path.join(directory, "a", "other.json"));
});

test("plugin IDs and filenames cannot escape their scope", async t => {
  const { directory } = await fixture(t);
  const root = new StorageRoot(directory);
  for (const id of ["", ".", "..", "../other", "a/b", "a\\b", "/absolute", "a\0b", "a.b", " x", "x\n"]) {
    assert.throws(() => root.json(id, "state.json", {}), /Invalid plugin/);
  }
  for (const name of ["", ".json", "..", "../x.json", "a/b.json", "a\\b.json", "/x.json", "x.txt", "x.JSON", "x.json\0", "x.json\n"]) {
    assert.throws(() => root.json("plugin", name, {}), /Invalid JSON filename/);
  }
  assert.deepEqual(await fs.readdir(directory), []);
  await root.close();
});

for (const kind of ["root", "plugin", "file", "dangling-file", "ancestor"] as const) {
  test(`rejects ${kind} symlinks without touching the external target`, async t => {
    const { directory } = await fixture(t);
    const outside = path.join(directory, "outside");
    await fs.mkdir(outside);
    const sentinel = path.join(outside, "state.json");
    await fs.writeFile(sentinel, '{"count":99}');
    let rootPath = path.join(directory, "root");
    if (kind === "root") {
      await fs.symlink(outside, rootPath);
    } else if (kind === "ancestor") {
      await fs.symlink(outside, rootPath);
      rootPath = path.join(rootPath, "child");
    } else {
      await fs.mkdir(rootPath);
      const pluginPath = path.join(rootPath, "plugin");
      if (kind === "plugin") {
        await fs.symlink(outside, pluginPath);
      } else {
        await fs.mkdir(pluginPath);
        await fs.symlink(kind === "file" ? sentinel : path.join(outside, "missing.json"), path.join(pluginPath, "state.json"));
      }
    }
    const root = new StorageRoot(rootPath);
    const store = root.json("plugin", "state.json", { count: 0 });
    await assert.rejects(store.read());
    await assert.rejects(store.update(() => ({ count: 1 })));
    assert.equal(await fs.readFile(sentinel, "utf8"), '{"count":99}');
    assert.deepEqual(await fs.readdir(outside), ["state.json"]);
    await root.close();
  });
}

test("rechecks directories after an awaited mutator", async t => {
  const { directory } = await fixture(t);
  const root = new StorageRoot(path.join(directory, "root"));
  const store = root.json("plugin", "state.json", { count: 0 });
  await store.update(value => value);
  const pluginPath = path.join(directory, "root", "plugin");
  const outside = path.join(directory, "outside");
  await fs.mkdir(outside);
  await assert.rejects(store.update(async () => {
    await fs.rename(pluginPath, path.join(directory, "original"));
    await fs.symlink(outside, pluginPath);
    return { count: 1 };
  }), /real directory/);
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(await fs.readFile(path.join(directory, "original", "state.json"), "utf8"), '{"count":0}\n');
  await root.close();
});

test("non-regular targets and non-directory parents are rejected", async t => {
  const { directory, file } = await fixture(t);
  await fs.mkdir(file);
  const store = new JsonStore(file, { count: 0 });
  await assert.rejects(store.read(), /regular file/);
  await assert.rejects(store.update(value => value), /regular file/);
  await store.close();
  const parent = path.join(directory, "parent");
  await fs.writeFile(parent, "sentinel");
  const nested = new JsonStore(path.join(parent, "state.json"), {});
  await assert.rejects(nested.read(), /real directory/);
  await assert.rejects(nested.update(value => value), /real directory/);
  assert.equal(await fs.readFile(parent, "utf8"), "sentinel");
  await nested.close();
});

test("successful and failed reads and writes close every opened descriptor", async t => {
  const { file } = await fixture(t);
  const originalOpen = fs.open;
  let openHandles = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    ++openHandles;
    const close = handle.close.bind(handle);
    t.mock.method(handle, "close", async () => { await close(); --openHandles; });
    return handle;
  });
  const store = new JsonStore(file, { count: 0 });
  await store.read();
  assert.equal(openHandles, 0);
  await store.update(value => value);
  assert.equal(openHandles, 0);
  await store.read();
  assert.equal(openHandles, 0);
  await fs.writeFile(file, "{bad");
  await assert.rejects(store.read());
  assert.equal(openHandles, 0);
  await store.close();
  assert.equal(openHandles, 0);
});

test("read errors propagate instead of being treated as missing data", async t => {
  const { directory, file } = await fixture(t);
  const store = new JsonStore(file, { count: 0 });
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  t.mock.method(fs, "open", async () => { throw denied; });
  await assert.rejects(store.read(), error => error === denied);
  await assert.rejects(store.update(value => value), error => error === denied);
  t.mock.restoreAll();
  assert.deepEqual(await fs.readdir(directory), []);
  await store.close();
});

test("canceled reads close the descriptor and the queue remains usable", async t => {
  const { file } = await fixture(t);
  await fs.writeFile(file, '{"count":1}');
  const store = new JsonStore(file, { count: 0 });
  const controller = new AbortController();
  const originalOpen = fs.open;
  let closed = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const readFile = handle.readFile.bind(handle);
    const close = handle.close.bind(handle);
    t.mock.method(handle, "readFile", async (...options: Parameters<typeof handle.readFile>) => {
      controller.abort();
      return readFile(...options);
    });
    t.mock.method(handle, "close", async () => { await close(); closed = true; });
    return handle;
  });
  await assert.rejects(store.read(controller.signal), { name: "AbortError" });
  assert.equal(closed, true);
  t.mock.restoreAll();
  assert.deepEqual(await store.read(), { count: 1 });
  await store.close();
});

test("failed initial mutation and failed initial commit leave no JSON file", async t => {
  const { directory } = await fixture(t);
  const rootPath = path.join(directory, "root");
  const root = new StorageRoot(rootPath);
  const store = root.json("plugin", "state.json", { count: 0 });
  await assert.rejects(store.update(() => { throw new Error("mutation failed"); }), /mutation failed/);
  await missing(rootPath);
  t.mock.method(fs, "rename", async () => { throw new Error("rename failed"); });
  await assert.rejects(store.update(value => value), /rename failed/);
  t.mock.restoreAll();
  assert.deepEqual(await fs.readdir(path.join(rootPath, "plugin")), []);
  assert.deepEqual(await store.read(), { count: 0 });
  await root.close();
});
