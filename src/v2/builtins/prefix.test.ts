import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, realpath, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { parse } from "dotenv";
import { PluginHost } from "../host";
import { PrefixEnvStore, prefixesFromEnv, type PrefixPersistence } from "../prefixes";
import { definePlugin, type MessageEnvelope, type MessageOptions, type PluginContext } from "../sdk";
import { createPrefix } from "./prefix";

const SECRET = "prefix-private-fixture-753";
const message: MessageEnvelope = { id: 1, chatId: "123", outgoing: true, text: ".prefix" };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, options: { prefixes?: string[]; persistence?: PrefixPersistence } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "telebox-v2-prefix-")));
  const file = path.join(root, ".env");
  const source = `# retain\nTOKEN=${SECRET}\nUNKNOWN="line one\nline two"\n`;
  await writeFile(file, source, { mode: 0o600 });
  const edits: { text: string; options: MessageOptions }[] = [];
  const logs: { event: string; fields: unknown }[] = [];
  const contexts: PluginContext[] = [];
  const targetContexts: PluginContext[] = [];
  let cleanups = 0;
  let calls = 0;
  let editGate: Promise<void> | undefined;
  const host = new PluginHost({
    storageRoot: root, prefixes: options.prefixes ?? ["."], concurrency: 64, queueCapacity: 128,
    logger: { info(event, fields) { logs.push({ event, fields }); }, error(event, fields) { logs.push({ event, fields }); } },
    telegram: {
      async edit(_message, text, settings, signal) {
        signal.throwIfAborted();
        edits.push({ text, options: settings });
        await editGate;
        signal.throwIfAborted();
      },
      async reply() { assert.fail("unexpected reply"); },
      async invoke() { assert.fail("unexpected RPC"); },
      async getReply() { assert.fail("unexpected read"); },
      async withClient() { assert.fail("unexpected client access"); },
    },
  });
  t.after(async () => {
    assert.equal((await host.shutdown(1000)).completed, true);
    await rm(root, { recursive: true, force: true });
  });
  await host.load(definePlugin({
    apiVersion: 1, id: "target", description: "fixture", commands: {
      ping: { description: "fixture", handle() { calls += 1; } },
    },
    setup(context) { targetContexts.push(context); },
    cleanup() { cleanups += 1; },
  }));
  const persistence = options.persistence ?? new PrefixEnvStore(file);
  async function load() {
    const definition = createPrefix(host, persistence);
    await host.load({ ...definition, setup(context) { contexts.push(context); } });
  }
  await load();
  return {
    host, root, file, source, edits, logs, contexts, targetContexts, load,
    cleanups: () => cleanups, calls: () => calls,
    gateEdits(value?: Promise<void>) { editGate = value; },
    dispatch(text: string, extra: Partial<MessageEnvelope> = {}) { return host.dispatchPrimary({ ...message, text, ...extra }); },
    read: () => readFile(file, "utf8"),
  };
}

test("factory is synchronous and pure, with explicit configuration and persistence", () => {
  let reads = 0;
  const env = { TB_PREFIX: "&" };
  const definition = createPrefix({
    configuration() { reads += 1; return { prefixes: prefixesFromEnv(env), aliases: {} }; },
    replacePrefixes() { assert.fail("factory published prefixes"); },
  }, { async persist() { assert.fail("factory persisted prefixes"); } });
  assert.equal(reads, 1);
  assert.equal(definition.id, "prefix");
  assert.equal("then" in definition, false);
  assert.equal(definition.setup, undefined);
  assert.equal(definition.cleanup, undefined);
  assert.deepEqual(Object.keys(definition.commands), ["prefix"]);
  assert.match(definition.description, /&amp;prefix/);
  assert.deepEqual(env, { TB_PREFIX: "&" });
});

test("view/help/h/unknown subcommands retain legacy feedback and avoid persistence", async t => {
  const f = await fixture(t);
  await f.dispatch(".prefix");
  assert.match(f.edits.at(-1)!.text, /当前前缀: <code>\.<\/code>/);
  for (const suffix of ["help", "H", "set help", "add h", "del HELP", "unknown"] ) {
    await f.dispatch(`.prefix ${suffix}`);
    assert.match(f.edits.at(-1)!.text, /<b>前缀管理<\/b>/);
  }
  assert.equal(await f.read(), f.source);
  assert.deepEqual(f.host.configuration().prefixes, ["."]);
  assert.ok(f.edits.every(edit => edit.options.parseMode === "html" && edit.options.linkPreview === false));
});

test("set/add/del deduplicate, preserve order, and publish without reloading other plugins", async t => {
  const f = await fixture(t);
  await f.dispatch(".prefix SET ! ！ !");
  assert.deepEqual(f.host.configuration().prefixes, ["!", "！"]);
  assert.equal(await f.dispatch(".ping"), false);
  assert.equal(await f.dispatch("！ping"), true);
  await f.dispatch("!prefix add ? !");
  assert.deepEqual(f.host.configuration().prefixes, ["!", "！", "?"]);
  await f.dispatch("!prefix del ! absent");
  assert.deepEqual(f.host.configuration().prefixes, ["！", "?"]);
  assert.equal(parse(await f.read()).TB_PREFIX, "！ ?");
  assert.ok((await f.read()).startsWith(f.source));
  assert.equal(f.targetContexts.length, 1);
  assert.equal(f.targetContexts[0].signal.aborted, false);
  assert.equal(f.cleanups(), 0);
  assert.equal(f.calls(), 1);
  assert.match(f.edits.at(-1)!.text, /已写入 \.env/);
});

test("missing parameters and deleting the last prefix do not mutate state", async t => {
  const f = await fixture(t);
  for (const sub of ["set", "add", "del"]) {
    await f.dispatch(`.prefix ${sub}`);
    assert.match(f.edits.at(-1)!.text, /参数不足/);
  }
  await f.dispatch(".prefix del .");
  assert.equal(f.edits.at(-1)!.text, "❌ 至少保留一个前缀");
  await f.dispatch(".prefix set \0");
  assert.match(f.edits.at(-1)!.text, /前缀无效/);
  assert.equal(await f.read(), f.source);
  assert.deepEqual(f.host.configuration().prefixes, ["."]);
});

test("only the first line supplies arguments, including CRLF and help aliases", async t => {
  const f = await fixture(t);
  await f.dispatch(".prefix set !\r\n? ignored");
  assert.deepEqual(f.host.configuration().prefixes, ["!"]);
  await f.dispatch("!prefix add\n?");
  assert.match(f.edits.at(-1)!.text, /参数不足/);
  f.host.replaceAliases({ change: "prefix set ?" });
  await f.dispatch("!change");
  assert.deepEqual(f.host.configuration().prefixes, ["?"]);
});

test("HTML-sensitive and multi-byte prefixes are escaped in success/view/dynamic help", async t => {
  const f = await fixture(t);
  const value = "🙂<&\"'";
  await f.dispatch(`.prefix set ${value} \\n`);
  assert.deepEqual(f.host.configuration().prefixes, [value, "\\n"]);
  assert.match(f.edits.at(-1)!.text, /🙂&lt;&amp;&quot;&#39;/);
  await f.dispatch(`${value}prefix`);
  assert.match(f.edits.at(-1)!.text, /🙂&lt;&amp;&quot;&#39;prefix set/);
  await f.dispatch(`${value}prefix help`);
  assert.match(f.edits.at(-1)!.text, /🙂&lt;&amp;&quot;&#39;prefix add/);
  assert.equal(parse(await f.read()).TB_PREFIX, `${value} \\n`);
});

test("incoming and edited messages cannot mutate owner prefixes; Saved Messages is admitted", async t => {
  const f = await fixture(t);
  assert.equal(await f.dispatch(".prefix set !", { outgoing: false }), false);
  assert.equal(await f.dispatch(".prefix set !", { edited: true }), false);
  assert.equal(await f.read(), f.source);
  assert.equal(f.edits.length, 0);
  assert.equal(await f.dispatch(".prefix set !", { outgoing: false, saved: true }), true);
  assert.deepEqual(f.host.configuration().prefixes, ["!"]);
});

test("persistence failures keep runtime changes and redact secrets from feedback and logs", async t => {
  let fail = true;
  const f = await fixture(t, { persistence: { async persist() { if (fail) throw new Error(SECRET); } } });
  await f.dispatch(".prefix set !");
  assert.deepEqual(f.host.configuration().prefixes, ["!"]);
  assert.match(f.edits.at(-1)!.text, /\.env 写入失败, 仅本次生效/);
  assert.doesNotMatch(JSON.stringify([f.edits, f.logs]), new RegExp(SECRET));
  assert.deepEqual(f.logs, [{ event: "prefix.persistence_failed", fields: undefined }]);
  fail = false;
  await f.dispatch("!prefix add ?");
  assert.deepEqual(f.host.configuration().prefixes, ["!", "?"]);
  assert.match(f.edits.at(-1)!.text, /已写入 \.env/);
});

test("50 concurrent chats serialize read-modify-write and actual persistence", async t => {
  const f = await fixture(t);
  const work = Array.from({ length: 50 }, (_, index) => f.dispatch(`.prefix add !${index}`, { chatId: `${index}` }));
  assert.ok((await Promise.all(work)).every(Boolean));
  const expected = [".", ...Array.from({ length: 50 }, (_, index) => `!${index}`)];
  assert.deepEqual(f.host.configuration().prefixes, expected);
  assert.equal(parse(await f.read()).TB_PREFIX, expected.join(" "));
  assert.equal(parse(await f.read()).TOKEN, SECRET);
  assert.equal(f.edits.length, 50);
  assert.equal(f.targetContexts.length, 1);
  assert.equal(f.cleanups(), 0);
});

test("50 reloads preserve host configuration and leave other generations alive", async t => {
  const f = await fixture(t);
  for (let index = 0; index < 50; index += 1) {
    await f.dispatch(`.prefix set . !${index}`);
    const old = f.contexts.at(-1)!;
    assert.equal((await f.host.unload("prefix"))?.completed, true);
    assert.equal(old.signal.aborted, true);
    assert.equal(getEventListeners(old.signal, "abort").length, 0);
    await f.load();
    assert.equal(f.targetContexts[0].signal.aborted, false);
    assert.equal(await f.dispatch(`!${index}ping`), true);
  }
  assert.equal(f.calls(), 50);
  assert.equal(f.contexts.length, 51);
  assert.equal(f.targetContexts.length, 1);
  assert.equal(f.cleanups(), 0);
  assert.equal(f.host.snapshot().plugins, 2);
  assert.deepEqual(f.host.snapshot().queue, { active: 0, queued: 0, closed: false });
  assert.equal(parse(await f.read()).TB_PREFIX, ". !49");
});

test("cancelled persistence waits for actual settlement, skips queued mutations and keeps other generations", async t => {
  const started = deferred();
  const release = deferred();
  let writes = 0;
  let received!: AbortSignal;
  const f = await fixture(t, { persistence: { async persist(_prefixes, signal) {
    writes += 1;
    received = signal;
    if (writes === 1) { started.resolve(); await release.promise; }
  } } });
  const first = f.dispatch(".prefix add !", { chatId: "one" });
  const second = f.dispatch(".prefix add ?", { chatId: "two" });
  const failures = [assert.rejects(first), assert.rejects(second)];
  await started.promise;
  try {
    assert.equal(received, f.contexts[0].signal);
    const report = await f.host.unload("prefix", 5);
    assert.equal(report?.completed, false);
    assert.ok(report!.pendingTasks > 0);
    assert.equal(received.aborted, true);
    assert.equal(writes, 1);
    await assert.rejects(f.load(), /already loaded/);
    assert.equal(await f.dispatch("!ping"), true);
    assert.equal(f.targetContexts[0].signal.aborted, false);
    assert.deepEqual(f.host.configuration().prefixes, [".", "!"]);
  } finally { release.resolve(); }
  await Promise.all(failures);
  assert.equal(f.edits.length, 0);
  assert.equal(f.logs.length, 0);
  assert.equal((await f.host.unload("prefix", 1000))?.completed, true);
  await f.load();
  await f.dispatch("!prefix add #");
  assert.deepEqual(f.host.configuration().prefixes, [".", "!", "#"]);
  assert.equal(writes, 2);
});

test("unawaited command capability stays tracked through persistence settlement", async t => {
  const started = deferred();
  const release = deferred();
  const f = await fixture(t);
  const definition = createPrefix(f.host, { async persist() { started.resolve(); await release.promise; } });
  const context = f.contexts[0];
  const work = definition.commands.prefix.handle({ message: { ...message, text: ".prefix add !" }, command: "prefix", prefix: ".", args: ["add", "!"] }, context);
  const rejected = assert.rejects(Promise.resolve(work));
  await started.promise;
  try {
    assert.equal((await f.host.unload("prefix", 5))?.completed, false);
  } finally { release.resolve(); }
  await rejected;
  assert.equal((await f.host.unload("prefix", 1000))?.completed, true);
});

test("shutdown cancellation before a queued command starts has no side effects", async t => {
  let writes = 0;
  const f = await fixture(t, { persistence: { async persist() { writes += 1; } } });
  const pending = f.dispatch(".prefix set !");
  const rejected = assert.rejects(pending);
  assert.equal((await f.host.shutdown()).completed, true);
  await rejected;
  assert.equal(writes, 0);
  assert.equal(f.edits.length, 0);
  assert.deepEqual(f.host.configuration().prefixes, ["."]);
});

test("telegram settlement remains tracked without labelling a delivery failure as persistence failure", async t => {
  const f = await fixture(t);
  const release = deferred();
  f.gateEdits(release.promise);
  const running = f.dispatch(".prefix set !");
  const rejected = assert.rejects(running);
  while (!f.edits.length) await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(parse(await f.read()).TB_PREFIX, "!");
    assert.equal((await f.host.unload("prefix", 5))?.completed, false);
  } finally { release.resolve(); }
  await rejected;
  assert.deepEqual(f.logs, []);
  assert.equal((await f.host.unload("prefix", 1000))?.completed, true);
});
