import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import type { TelegramClient } from "teleproto";
import { PluginHost, type HostOptions } from "../host";
import { definePlugin, type CommandInvocation, type MessageEnvelope, type MessageOptions, type PluginContext } from "../sdk";
import { createAlias } from "./alias";

const SECRET = "alias-secret-sentinel-64f2";
const message: MessageEnvelope = { id: 17, chatId: "123", text: ".alias", outgoing: true };
type Store = ReturnType<PluginContext["storage"]["sqlite"]>;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

interface FixtureOptions {
  seed?: (db: Database.Database) => void;
  initialAliases?: Record<string, string>;
  prefixes?: string[];
  concurrency?: number;
  loadAlias?: boolean;
  decorateStore?: (store: Store, context: PluginContext) => Store;
}

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "telebox-v2-alias-")));
  await mkdir(path.join(root, "alias"));
  const file = path.join(root, "alias", "alias.db");
  function inspect<T>(callback: (db: Database.Database) => T): T {
    const db = new Database(file);
    db.defaultSafeIntegers(true);
    try { return callback(db); } finally { db.close(); }
  }
  if (options.seed) inspect(options.seed);
  const edits: { message: MessageEnvelope; text: string; options: MessageOptions }[] = [];
  const deletes: Parameters<TelegramClient["deleteMessages"]>[] = [];
  const logs: { event: string; fields: unknown }[] = [];
  const commands: CommandInvocation[] = [];
  const contexts: PluginContext[] = [];
  const publications: Record<string, string>[] = [];
  const editWaiters = new Set<() => void>();
  const deleteWaiters = new Set<() => void>();
  const gates: { edit?: Promise<void>; delete?: Promise<void> } = {};
  let targetSetups = 0;
  let targetCleanups = 0;
  const client = {
    async deleteMessages(...args: Parameters<TelegramClient["deleteMessages"]>) {
      deletes.push(args);
      for (const notify of deleteWaiters) notify();
      await gates.delete;
      return [];
    },
  } as unknown as TelegramClient;
  const telegram: HostOptions["telegram"] = {
    async edit(envelope, text, settings, signal) {
      signal.throwIfAborted();
      edits.push({ message: envelope, text, options: settings });
      for (const notify of editWaiters) notify();
      await gates.edit;
      signal.throwIfAborted();
    },
    async reply() { assert.fail("alias edits its command message"); },
    async invoke() { assert.fail("alias does not issue raw invoke calls"); },
    async getReply() { assert.fail("alias does not read replied messages"); },
    async withClient(operation, signal) {
      signal.throwIfAborted();
      const result = await operation(client, signal);
      signal.throwIfAborted();
      return result;
    },
  };
  const host = new PluginHost({
    storageRoot: root,
    telegram,
    logger: { info(event, fields) { logs.push({ event, fields }); }, error(event, fields) { logs.push({ event, fields }); } },
    prefixes: options.prefixes,
    aliases: options.initialAliases,
    concurrency: options.concurrency,
  });
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true, "all work must finish before removing the fixture");
    await rm(root, { recursive: true, force: true });
  });
  const targets = definePlugin({
    apiVersion: 1, id: "targets", description: "fixture", commands: {
      ping: { description: "ping fixture", handle(input) { commands.push(input); } },
      echo: { description: "echo fixture", handle(input) { commands.push(input); } },
    },
    setup() { targetSetups += 1; },
    cleanup() { targetCleanups += 1; },
  });
  await host.load(targets);
  const definition = createAlias({
    listCommands: () => host.listCommands(),
    configuration: () => host.configuration(),
    replaceAliases(aliases) {
      host.replaceAliases(aliases);
      publications.push({ ...aliases });
    },
  });
  async function load() {
    await host.load({ ...definition, async setup(context) {
      contexts.push(context);
      if (options.decorateStore) {
        const sqlite = context.storage.sqlite;
        context.storage.sqlite = (name, storeOptions) => options.decorateStore!(sqlite(name, storeOptions), context);
      }
      await definition.setup!(context);
    } });
  }
  if (options.loadAlias !== false) await load();
  function waitFor(count: number, values: unknown[], waiters: Set<() => void>): Promise<void> {
    if (values.length >= count) return Promise.resolve();
    return new Promise(resolve => {
      const notify = () => {
        if (values.length >= count) { waiters.delete(notify); resolve(); }
      };
      waiters.add(notify);
    });
  }
  return {
    host, root, file, inspect, edits, deletes, logs, commands, contexts, publications, gates, load, targets,
    targetSetups: () => targetSetups, targetCleanups: () => targetCleanups,
    dispatch: (text: string, extra: Partial<MessageEnvelope> = {}) => host.dispatchPrimary({ ...message, text, ...extra }),
    waitForEdits: (count: number) => waitFor(count, edits, editWaiters),
    waitForDeletes: (count: number) => waitFor(count, deletes, deleteWaiters),
    rows: () => inspect(db => db.prepare<[], { original: string; final: string }>(
      "SELECT original, final FROM aliases ORDER BY original",
    ).all()),
  };
}

async function temporaryCommand(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, text: string) {
  const count = f.edits.length + 1;
  const task = f.dispatch(text);
  await f.waitForEdits(count);
  await flush();
  t.mock.timers.tick(5000);
  assert.equal(await task, true);
}

test("new databases use the legacy schema and successful updates publish immediately", async t => {
  const f = await fixture(t, { initialAliases: { stale: "echo" } });
  assert.deepEqual(f.host.configuration().aliases, {});
  const columns = f.inspect(db => db.pragma("table_info(aliases)")) as { name: string; type: string; pk: bigint; notnull: bigint }[];
  assert.deepEqual(columns.map(({ name, type, pk, notnull }) => ({ name, type, pk, notnull })), [
    { name: "original", type: "TEXT", pk: 1n, notnull: 0n },
    { name: "final", type: "TEXT", pk: 0n, notnull: 1n },
  ]);
  assert.equal(await f.dispatch(".alias set quick ping fixed"), true);
  assert.deepEqual(f.rows(), [{ original: "quick", final: "ping fixed" }]);
  assert.deepEqual(f.host.configuration().aliases, { quick: "ping fixed" });
  assert.equal(await f.dispatch(".quick extra"), true);
  assert.equal(f.commands[0].message.text, ".ping fixed extra");
  assert.deepEqual(f.commands[0].args, ["fixed", "extra"]);
  assert.equal(f.targetSetups(), 1);
  assert.equal(f.targetCleanups(), 0);
});

test("legacy records load alongside extension columns, tables, indexes and metadata", async t => {
  const f = await fixture(t, { seed(db) {
    db.exec("CREATE TABLE aliases(original TEXT PRIMARY KEY, final TEXT NOT NULL, note TEXT DEFAULT 'default note');" +
      "CREATE TABLE extension_state(key TEXT PRIMARY KEY, payload TEXT);" +
      "CREATE INDEX aliases_note ON aliases(note);" +
      "INSERT INTO extension_state VALUES ('owned elsewhere', 'retain');" +
      "PRAGMA user_version = 37; PRAGMA application_id = 12345;");
    db.prepare("INSERT INTO aliases VALUES (?, ?, ?)").run("quick", "ping fixed", "original note");
  } });
  assert.deepEqual(f.host.configuration().aliases, { quick: "ping fixed" });
  await f.dispatch(".alias set quick echo");
  await f.dispatch(".alias set quick echo");
  await f.dispatch(".alias set other ping");
  assert.deepEqual(f.inspect(db => db.prepare("SELECT * FROM aliases ORDER BY original").all()), [
    { original: "other", final: "ping", note: "default note" },
    { original: "quick", final: "echo", note: "original note" },
  ]);
  assert.deepEqual(f.inspect(db => db.prepare("SELECT * FROM extension_state").all()), [{ key: "owned elsewhere", payload: "retain" }]);
  assert.equal(f.inspect(db => db.pragma("user_version", { simple: true })), 37n);
  assert.equal(f.inspect(db => db.pragma("application_id", { simple: true })), 12345n);
  assert.equal(f.inspect(db => db.prepare("SELECT count(*) FROM sqlite_schema WHERE name = 'aliases_note'").pluck().get()), 1n);
});

test("same full target replaces old aliases atomically while distinct target arguments remain", async t => {
  const f = await fixture(t, { seed(db) {
    db.exec("CREATE TABLE aliases(original TEXT PRIMARY KEY, final TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO aliases VALUES (?, ?)");
    insert.run("old", "ping one");
    insert.run("duplicate", "ping one");
    insert.run("different", "ping two");
    insert.run("new", "echo previous");
  } });
  await f.dispatch(".alias set new ping one");
  assert.deepEqual(f.rows(), [{ original: "different", final: "ping two" }, { original: "new", final: "ping one" }]);
  assert.deepEqual(f.host.configuration().aliases, { different: "ping two", new: "ping one" });
  assert.equal(await f.dispatch(".old"), false);
  assert.equal(await f.dispatch(".new more"), true);
  assert.deepEqual(f.commands[0].args, ["one", "more"]);
});

test("multiword aliases choose the first real command boundary and route the longest match", async t => {
  const f = await fixture(t);
  await f.dispatch(".alias set go echo short");
  await f.dispatch(".alias set go now ping long echo tail");
  assert.deepEqual(f.host.configuration().aliases, { go: "echo short", "go now": "ping long echo tail" });
  await f.dispatch(".go now additional");
  assert.equal(f.commands[0].command, "ping");
  assert.deepEqual(f.commands[0].args, ["long", "echo", "tail", "additional"]);
  await f.dispatch(".alias del go now");
  assert.deepEqual(f.host.configuration().aliases, { go: "echo short" });
  await f.dispatch(".go now additional");
  assert.equal(f.commands[1].command, "echo");
  assert.deepEqual(f.commands[1].args, ["short", "now", "additional"]);
});

test("SDK message.text drives management aliases and target commands without reading raw.message", async t => {
  const f = await fixture(t);
  await f.dispatch(".alias set manage alias");
  const raw = Object.defineProperty({}, "message", { get() { assert.fail("raw.message must not be parsed"); } });
  await f.dispatch(".manage set quick ping fixed", { raw });
  assert.deepEqual(f.host.configuration().aliases, { manage: "alias", quick: "ping fixed" });
  await f.dispatch(".quick more", { raw });
  assert.equal(f.commands[0].message.text, ".ping fixed more");
  assert.equal(f.commands[0].message.raw, raw);
  await f.dispatch(".manage list", { raw });
  assert.equal(f.edits.at(-1)!.text, "重命名列表：\nmanage -&gt; alias\nquick -&gt; ping fixed");
});

test("set, delete, ls and list escape HTML while SQLite retains original text", async t => {
  const f = await fixture(t);
  const alias = `<a&"'>`;
  const target = `echo <b>text&more</b> "'`;
  await f.dispatch(`.alias set ${alias} ${target}`);
  assert.deepEqual(f.rows(), [{ original: alias, final: target }]);
  assert.equal(f.edits.at(-1)!.text, escapeHtml(`插件命令重命名成功，${alias} -> ${target}`));
  for (const command of ["ls", "list"]) {
    await f.dispatch(`.alias ${command}`);
    assert.equal(f.edits.at(-1)!.text, escapeHtml(`重命名列表：\n${alias} -> ${target}`));
  }
  await f.dispatch(`.alias del ${alias}`);
  assert.equal(f.edits.at(-1)!.text, escapeHtml(`删除 ${alias} 重命名成功`));
  await f.dispatch(".alias ls");
  assert.equal(f.edits.at(-1)!.text, "当前没有任何别名配置");
  assert.ok(f.edits.every(entry => entry.options.parseMode === "html" && entry.options.linkPreview === false));
});

test("SQL-looking aliases and object prototype names are literal stored keys", async t => {
  const f = await fixture(t);
  const name = "x');DROP_TABLE_aliases;--";
  await f.dispatch(`.alias set ${name} ping`);
  await f.dispatch(".alias set __proto__ echo");
  const aliases = f.host.configuration().aliases;
  assert.equal(aliases[name], "ping");
  assert.equal(Object.hasOwn(aliases, "__proto__"), true);
  assert.equal(aliases["__proto__"], "echo");
  assert.equal(await f.dispatch(".__proto__ argument"), true);
  assert.equal(f.commands[0].command, "echo");
  assert.equal(f.rows().length, 2);
});

test("real commands remain valid targets even when a same-named alias exists", async t => {
  const f = await fixture(t);
  await f.dispatch(".alias set ping echo");
  await f.dispatch(".alias set short ping");
  assert.deepEqual(f.host.configuration().aliases, { ping: "echo", short: "ping" });
  await f.dispatch(".ping direct");
  await f.dispatch(".short through-alias");
  assert.deepEqual(f.commands.map(value => [value.command, ...value.args]), [["ping", "direct"], ["ping", "through-alias"]]);
});

test("missing arguments, missing targets and alias targets show temporary errors without mutation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t);
  await f.dispatch(".alias set existing ping");
  const before = f.rows();
  const cases = [
    [".alias set", "参数不足"],
    [".alias set lonely", "参数不足"],
    [".alias del", "参数不足"],
    [".alias set quick nonexistent", "没找到nonexistent该原始命令"],
    [".alias set quick existing", "不应该对重定向的命令再次重定向"],
  ];
  for (const [command, expected] of cases) {
    await temporaryCommand(t, f, command);
    assert.ok(f.edits.at(-1)!.text.includes(expected));
    assert.deepEqual(f.rows(), before);
    assert.deepEqual(f.host.configuration().aliases, { existing: "ping" });
  }
  assert.equal(f.deletes.length, cases.length);
  assert.equal(f.publications.length, 2);
});

test("ordinary notices and missing-alias deletion retain their legacy persistent responses", async t => {
  const f = await fixture(t);
  for (const [command, expected] of [
    [".alias", "不知道你要干什么！"],
    [".alias <unknown>", "未知子命令: &lt;unknown&gt;"],
    [".alias del absent", "删除 absent 重命名失败，请检查命令是否存在"],
  ]) {
    await f.dispatch(command);
    assert.equal(f.edits.at(-1)!.text, expected);
  }
  assert.equal(f.deletes.length, 0);
  assert.deepEqual(f.rows(), []);
});

test("configured prefixes and whitespace are honored in parsing and escaped usage", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t, { prefixes: ["<", "!"] });
  await f.dispatch("!alias\tset\nquick\tping\nfixed");
  assert.deepEqual(f.host.configuration().aliases, { quick: "ping fixed" });
  await temporaryCommand(t, f, "!alias set");
  assert.equal(f.edits.at(-1)!.text, "参数不足，用法：&lt;alias set [别名...] [原命令...]");
});

test("primary ownership and edited-message admission protect alias writes", async t => {
  const f = await fixture(t);
  assert.equal(await f.dispatch(".alias set incoming ping", { outgoing: false }), false);
  assert.equal(await f.dispatch(".alias set edited ping", { edited: true }), false);
  assert.deepEqual(f.rows(), []);
  assert.equal(f.edits.length, 0);
  assert.equal(await f.dispatch(".alias set saved ping", { outgoing: false, saved: true }), true);
  assert.deepEqual(f.host.configuration().aliases, { saved: "ping" });
});

test("concurrent chats serialize transaction and publication without losing alias mappings", async t => {
  const f = await fixture(t);
  await Promise.all([
    f.dispatch(".alias set first ping", { chatId: "1" }),
    f.dispatch(".alias set second echo", { chatId: "2" }),
  ]);
  assert.deepEqual(f.publications, [{}, { first: "ping" }, { first: "ping", second: "echo" }]);
  assert.deepEqual(f.rows(), [{ original: "first", final: "ping" }, { original: "second", final: "echo" }]);
  await Promise.all([
    f.dispatch(".alias set newer ping", { chatId: "1" }),
    f.dispatch(".alias set newest ping", { chatId: "2" }),
  ]);
  assert.deepEqual(f.host.configuration().aliases, { newest: "ping", second: "echo" });
});

test("same-chat operations respect the host queue while committed aliases are immediately usable", async t => {
  const f = await fixture(t);
  const release = deferred();
  f.gates.edit = release.promise;
  const first = f.dispatch(".alias set first ping");
  await f.waitForEdits(1);
  assert.deepEqual(f.host.configuration().aliases, { first: "ping" });
  const second = f.dispatch(".alias set second echo");
  assert.equal(f.host.snapshot().queue.active, 1);
  assert.equal(f.host.snapshot().queue.queued, 1);
  assert.equal(await f.dispatch(".first immediate", { chatId: "another" }), true);
  assert.deepEqual(f.commands[0].args, ["immediate"]);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(f.host.configuration().aliases, { first: "ping", second: "echo" });
});

test("failed insertion rolls back same-target deletion and preserves the published mapping", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t, { seed(db) {
    db.exec("CREATE TABLE aliases(original TEXT PRIMARY KEY, final TEXT NOT NULL); INSERT INTO aliases VALUES ('old', 'ping');");
    db.exec(`CREATE TRIGGER reject_new BEFORE INSERT ON aliases WHEN NEW.original = 'new' BEGIN SELECT RAISE(ABORT, '${SECRET}'); END`);
  } });
  await temporaryCommand(t, f, ".alias set new ping");
  assert.deepEqual(f.rows(), [{ original: "old", final: "ping" }]);
  assert.deepEqual(f.host.configuration().aliases, { old: "ping" });
  assert.deepEqual(f.publications, [{ old: "ping" }]);
  assert.equal(f.edits.at(-1)!.text, "别名数据库操作失败，请稍后重试");
  assert.equal(JSON.stringify(f.logs).includes(SECRET), false);
  assert.equal(JSON.stringify(f.edits).includes(SECRET), false);
  assert.deepEqual(f.logs, [{ event: "alias.storage_failed", fields: { operation: "set" } }]);
  await f.dispatch(".alias set recovered echo");
  assert.deepEqual(f.host.configuration().aliases, { old: "ping", recovered: "echo" });
});

test("failed deletion keeps the SQLite row and active alias", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t, { seed(db) {
    db.exec("CREATE TABLE aliases(original TEXT PRIMARY KEY, final TEXT NOT NULL); INSERT INTO aliases VALUES ('keep', 'ping');" +
      "CREATE TRIGGER reject_delete BEFORE DELETE ON aliases BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  } });
  await temporaryCommand(t, f, ".alias del keep");
  assert.deepEqual(f.rows(), [{ original: "keep", final: "ping" }]);
  assert.deepEqual(f.host.configuration().aliases, { keep: "ping" });
  assert.equal(f.publications.length, 1);
});

test("additional required columns are preserved when a new alias cannot satisfy their constraint", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t, { seed(db) {
    db.exec("CREATE TABLE aliases(original TEXT PRIMARY KEY, final TEXT NOT NULL, extension TEXT NOT NULL);" +
      "INSERT INTO aliases VALUES ('old', 'ping', 'extension value')");
  } });
  await temporaryCommand(t, f, ".alias set new ping");
  assert.deepEqual(f.inspect(db => db.prepare("SELECT * FROM aliases").all()), [{ original: "old", final: "ping", extension: "extension value" }]);
  assert.deepEqual(f.host.configuration().aliases, { old: "ping" });
});

test("existing aliases update while preserving required extension fields without defaults", async t => {
  const f = await fixture(t, { seed(db) {
    db.exec("CREATE TABLE aliases(original TEXT PRIMARY KEY, final TEXT NOT NULL, extension TEXT NOT NULL);" +
      "INSERT INTO aliases VALUES ('keep', 'ping', 'extension value')");
  } });
  await f.dispatch(".alias set keep echo");
  await f.dispatch(".alias set keep echo");
  assert.deepEqual(f.inspect(db => db.prepare("SELECT * FROM aliases").all()), [
    { original: "keep", final: "echo", extension: "extension value" },
  ]);
  assert.deepEqual(f.host.configuration().aliases, { keep: "echo" });
});

test("a failed confirmation edit does not misreport or roll back a committed alias", async t => {
  const f = await fixture(t);
  const release = deferred();
  f.gates.edit = release.promise;
  const task = f.dispatch(".alias set quick ping");
  const rejected = assert.rejects(task, /transport fixture failure/);
  await f.waitForEdits(1);
  release.reject(new Error("transport fixture failure"));
  await rejected;
  assert.deepEqual(f.rows(), [{ original: "quick", final: "ping" }]);
  assert.deepEqual(f.host.configuration().aliases, { quick: "ping" });
  assert.deepEqual(f.logs, []);
  assert.equal(f.deletes.length, 0);
  assert.equal(await f.dispatch(".quick"), true);
});

test("incompatible legacy schema fails setup without replacing configuration or changing tables", async t => {
  const f = await fixture(t, { loadAlias: false, initialAliases: { retained: "ping" }, seed(db) {
    db.exec("CREATE TABLE aliases(original TEXT PRIMARY KEY, payload TEXT); INSERT INTO aliases VALUES ('old', 'retain');" +
      "CREATE TABLE extension(key TEXT); INSERT INTO extension VALUES ('untouched')");
  } });
  const schema = f.inspect(db => db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all());
  await assert.rejects(f.load(), /final/);
  assert.deepEqual(f.host.configuration().aliases, { retained: "ping" });
  assert.deepEqual(f.inspect(db => db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all()), schema);
  assert.deepEqual(f.inspect(db => db.prepare("SELECT * FROM aliases").all()), [{ original: "old", payload: "retain" }]);
  assert.deepEqual(f.inspect(db => db.prepare("SELECT * FROM extension").all()), [{ key: "untouched" }]);
  assert.equal(f.publications.length, 0);
});

test("invalid stored rows fail setup before publishing any mapping", async t => {
  const f = await fixture(t, { loadAlias: false, initialAliases: { retained: "ping" }, seed(db) {
    db.exec("CREATE TABLE aliases(original TEXT PRIMARY KEY, final TEXT NOT NULL); INSERT INTO aliases VALUES (NULL, 'ping')");
  } });
  await assert.rejects(f.load(), /无效记录/);
  assert.deepEqual(f.host.configuration().aliases, { retained: "ping" });
  assert.deepEqual(f.rows(), [{ original: null, final: "ping" }]);
});

test("cancellation inside a transaction rolls back writes and never publishes the candidate", async t => {
  let transactions = 0;
  const f = await fixture(t, { decorateStore(store, context) {
    return { ...store, transaction(callback, signal) {
      return store.transaction(db => {
        const result = callback(db);
        if (++transactions > 1) context.tasks.abort(new Error("cancel fixture mutation"));
        return result;
      }, signal);
    } };
  } });
  await assert.rejects(f.dispatch(".alias set cancelled ping"), /cancel fixture mutation/);
  assert.deepEqual(f.rows(), []);
  assert.deepEqual(f.host.configuration().aliases, {});
  assert.deepEqual(f.publications, [{}]);
  assert.equal(f.edits.length, 0);
  assert.equal((await f.host.unload("alias"))?.completed, true);
});

test("cancellation after committed storage settlement still prevents mapping publication", async t => {
  let transactions = 0;
  const f = await fixture(t, { decorateStore(store, context) {
    return { ...store, async transaction(callback, signal) {
      const result = await store.transaction(callback, signal);
      if (++transactions > 1) context.tasks.abort(new Error("cancel before publication"));
      return result;
    } };
  } });
  await assert.rejects(f.dispatch(".alias set committed ping"), /cancel before publication/);
  assert.deepEqual(f.rows(), [{ original: "committed", final: "ping" }]);
  assert.deepEqual(f.host.configuration().aliases, {});
  assert.deepEqual(f.publications, [{}]);
  assert.equal((await f.host.unload("alias"))?.completed, true);
});

test("cancelled setup leaves the pre-existing in-memory configuration intact", async t => {
  const f = await fixture(t, { loadAlias: false, initialAliases: { retained: "ping" }, decorateStore(store, context) {
    return { ...store, async transaction(callback, signal) {
      const result = await store.transaction(callback, signal);
      context.tasks.abort(new Error("cancel alias setup"));
      return result;
    } };
  } });
  await assert.rejects(f.load(), /cancel alias setup/);
  assert.deepEqual(f.host.configuration().aliases, { retained: "ping" });
  assert.equal(f.publications.length, 0);
});

test("queued cross-chat mutations are cancelled before reaching storage", async t => {
  const started = deferred();
  const release = deferred();
  let transactions = 0;
  const f = await fixture(t, { decorateStore(store) {
    return { ...store, async transaction(callback, signal) {
      if (++transactions === 2) { started.resolve(); await release.promise; }
      return store.transaction(callback, signal);
    } };
  } });
  const first = f.dispatch(".alias set first ping", { chatId: "1" });
  const firstRejected = assert.rejects(first);
  await started.promise;
  const second = f.dispatch(".alias set second echo", { chatId: "2" });
  const secondRejected = assert.rejects(second);
  await flush();
  const report = await f.host.unload("alias", 5);
  assert.equal(report?.completed, false);
  assert.ok(report!.pendingTasks > 0);
  release.resolve();
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(transactions, 2);
  assert.deepEqual(f.rows(), []);
  assert.deepEqual(f.host.configuration().aliases, {});
  assert.equal((await f.host.unload("alias"))?.completed, true);
});

test("targets are revalidated when a queued mutation reaches its transaction", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const started = deferred();
  const release = deferred();
  let transactions = 0;
  const f = await fixture(t, { decorateStore(store) {
    return { ...store, async transaction(callback, signal) {
      if (++transactions === 2) { started.resolve(); await release.promise; }
      return store.transaction(callback, signal);
    } };
  } });
  const task = f.dispatch(".alias set pending ping");
  await started.promise;
  assert.equal((await f.host.unload("targets"))?.completed, true);
  release.resolve();
  await f.waitForEdits(1);
  await flush();
  assert.equal(f.edits[0].text, "没找到ping该原始命令，不保存该重定向");
  t.mock.timers.tick(5000);
  await task;
  assert.deepEqual(f.rows(), []);
  assert.deepEqual(f.host.configuration().aliases, {});
});

test("removing a target disables its aliases while preserving records for a later reload", async t => {
  const f = await fixture(t);
  await f.dispatch(".alias set short ping fixed");
  await f.host.unload("targets");
  assert.equal(await f.dispatch(".short extra"), false);
  assert.deepEqual(f.host.configuration().aliases, { short: "ping fixed" });
  assert.deepEqual(f.rows(), [{ original: "short", final: "ping fixed" }]);
  await f.host.load(f.targets);
  assert.equal(await f.dispatch(".short extra"), true);
  assert.deepEqual(f.commands[0].args, ["fixed", "extra"]);
  await f.host.unload("targets");
  await f.dispatch(".alias del short");
  assert.deepEqual(f.rows(), []);
  assert.deepEqual(f.host.configuration().aliases, {});
});

test("temporary errors delete the actual envelope message after five seconds without raw", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t);
  const task = f.dispatch(".alias set");
  await f.waitForEdits(1);
  await flush();
  t.mock.timers.tick(4999);
  await flush();
  assert.equal(f.deletes.length, 0);
  assert.ok(f.contexts[0].tasks.snapshot().pendingTasks > 0);
  t.mock.timers.tick(1);
  assert.equal(await task, true);
  assert.equal(f.deletes.length, 1);
  const [peer, ids, options] = f.deletes[0];
  assert.equal(peer!.toString(), message.chatId);
  assert.notEqual(typeof peer, "string");
  assert.deepEqual(ids, [message.id]);
  assert.deepEqual(options, { revoke: false });
});

test("temporary deletion uses an available raw input peer but never raw.message", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t);
  const inputChat = { cached: true };
  const raw = Object.defineProperty({ className: "Message", inputChat }, "message", { get() { assert.fail("raw text must not be read"); } });
  const task = f.dispatch(".alias del", { raw });
  await f.waitForEdits(1);
  await flush();
  t.mock.timers.tick(5000);
  await task;
  assert.equal(f.deletes[0][0], inputChat);
});

test("unload cancels the temporary delay and does not dispatch deletion", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t);
  const task = f.dispatch(".alias set");
  const rejected = assert.rejects(task);
  await f.waitForEdits(1);
  await flush();
  assert.equal((await f.host.unload("alias"))?.completed, true);
  await rejected;
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(f.deletes.length, 0);
  assert.equal(f.contexts[0].tasks.snapshot().pendingTasks, 0);
  assert.equal(getEventListeners(f.contexts[0].signal, "abort").length, 0);
});

test("in-flight deletion remains tracked until the client operation actually settles", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t);
  const release = deferred();
  f.gates.delete = release.promise;
  const task = f.dispatch(".alias set");
  const rejected = assert.rejects(task);
  await f.waitForEdits(1);
  await flush();
  t.mock.timers.tick(5000);
  await f.waitForDeletes(1);
  const unloading = f.host.unload("alias", 5);
  t.mock.timers.tick(5);
  const report = await unloading;
  assert.equal(report?.completed, false);
  assert.ok(report!.pendingTasks > 0);
  release.resolve();
  await rejected;
  assert.equal((await f.host.unload("alias"))?.completed, true);
  assert.equal(f.deletes.length, 1);
});

test("deletion errors report a fixed message rather than native details", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t);
  const release = deferred();
  f.gates.delete = release.promise;
  const task = f.dispatch(".alias set");
  const rejected = assert.rejects(task, (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "别名临时消息删除失败");
    assert.equal("cause" in error, false);
    return true;
  });
  await f.waitForEdits(1);
  await flush();
  t.mock.timers.tick(5000);
  await f.waitForDeletes(1);
  release.reject(new Error(SECRET));
  await rejected;
  assert.equal(JSON.stringify(f.logs).includes(SECRET), false);
});

test("50 reload cycles retain committed aliases and release cancelled timers and old capabilities", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t, { loadAlias: false });
  for (let cycle = 0; cycle < 50; cycle += 1) {
    await f.load();
    if (cycle) assert.deepEqual(f.host.configuration().aliases, { short: `ping ${cycle - 1}` });
    await f.dispatch(`.alias set short ping ${cycle}`);
    await f.dispatch(".short extra");
    assert.deepEqual(f.commands.at(-1)!.args, [String(cycle), "extra"]);
    const count = f.edits.length + 1;
    const task = f.dispatch(".alias set");
    const rejected = assert.rejects(task);
    await f.waitForEdits(count);
    await flush();
    assert.equal((await f.host.unload("alias"))?.completed, true);
    await rejected;
    const context = f.contexts[cycle];
    assert.equal(context.tasks.snapshot().pendingTasks, 0);
    assert.equal(context.tasks.snapshot().pendingResources, 0);
    assert.equal(getEventListeners(context.signal, "abort").length, 0);
    assert.throws(() => context.storage.sqlite("alias.db"));
    assert.equal(f.host.snapshot().plugins, 1);
    assert.equal(f.host.snapshot().queue.active, 0);
    assert.equal(f.host.snapshot().queue.queued, 0);
  }
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(f.deletes.length, 0);
  assert.equal(f.targetSetups(), 1);
  assert.equal(f.targetCleanups(), 0);
  assert.deepEqual(f.rows(), [{ original: "short", final: "ping 49" }]);
});
