import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Parser } from "htmlparser2";
import { HTMLParser } from "teleproto/extensions/html.js";
import { ResourceScope } from "../lifecycle";
import type { MessageEnvelope, MessageOptions, PluginContext } from "../sdk";
import { createHelp } from "./help";

type HelpHost = Parameters<typeof createHelp>[0];
type PluginInfo = ReturnType<HelpHost["listPlugins"]>[number];
interface Sent { kind: "edit" | "reply"; text: string; options?: MessageOptions; message: MessageEnvelope; }

function plugin(id: string, names: string[] = [id], description = `${id} module`): PluginInfo {
  return { id, description, commands: names.map((name) => ({ name, description: `${name} command` })), jobs: [] };
}

function fixture(t: TestContext, initial: PluginInfo[] = []) {
  let plugins = initial;
  let configuration: ReturnType<HelpHost["configuration"]> = { prefixes: ["."], aliases: {} };
  const sent: Sent[] = [];
  const errors: string[] = [];
  const scope = new ResourceScope();
  const calls = { plugins: 0, commands: 0, configuration: 0 };
  const host: HelpHost = {
    listPlugins: () => { calls.plugins += 1; return plugins; },
    listCommands: () => {
      calls.commands += 1;
      return plugins.flatMap((entry) => entry.commands.map((command) => ({ ...command, pluginId: entry.id })));
    },
    configuration: () => { calls.configuration += 1; return configuration; },
  };
  const context = {
    signal: scope.signal,
    tasks: scope,
    telegram: {
      edit: async (message: MessageEnvelope, text: string, options?: MessageOptions) => { sent.push({ kind: "edit", text, options, message }); },
      reply: async (message: MessageEnvelope, text: string, options?: MessageOptions) => { sent.push({ kind: "reply", text, options, message }); },
      invoke: async () => assert.fail("unexpected RPC"),
      getReply: async () => assert.fail("unexpected history read"),
      withClient: async () => assert.fail("unexpected client access"),
    },
    log: { info() {}, error: (event: string) => { errors.push(event); } },
  } as unknown as PluginContext;
  const help = createHelp(host);
  const message: MessageEnvelope = { id: 5, chatId: "-1009007199254740993", text: ".help", outgoing: true, topicId: 6 };
  t.after(async () => {
    assert.equal((await scope.drain()).completed, true);
    assert.equal(scope.snapshot().pendingTasks, 0);
    assert.equal(scope.snapshot().pendingResources, 0);
  });
  const run = async (args: string[] = [], command = "help") => {
    sent.length = 0;
    await scope.run("help", () => help.commands[command].handle({ message, prefix: configuration.prefixes[0], args, command }, context));
    validateMessages(sent);
    return sent;
  };
  return { run, help, host, context, scope, sent, errors, calls, message,
    setPlugins: (next: PluginInfo[]) => { plugins = next; },
    setConfiguration: (next: ReturnType<HelpHost["configuration"]>) => { configuration = next; } };
}

function validateMessages(messages: Sent[]): void {
  assert.ok(messages.length > 0);
  assert.equal(messages[0].kind, "edit");
  for (const [index, message] of messages.entries()) {
    if (index > 0) assert.equal(message.kind, "reply");
    assert.deepEqual(message.options, { parseMode: "html", linkPreview: false });
    assert.ok(message.text.length <= 3500, "raw HTML stays within the conservative budget");
    const [text, entities] = HTMLParser.parse(message.text);
    assert.ok(text.length > 0 && text.length <= 4096);
    assert.ok(entities.length <= 100);
    assert.equal(Buffer.from(text, "utf8").toString("utf8"), text, "never split UTF-16 surrogate pairs");
    let opened = 0;
    const parser = new Parser({
      onopentag() { opened += 1; },
      onclosetag(_name, implied) { assert.equal(implied, false, "each output tag closes explicitly within its page"); },
    }, { xmlMode: true });
    parser.end(message.text);
    assert.ok(opened <= 90);
  }
}

function visible(messages: Sent[]): string { return messages.map((entry) => HTMLParser.parse(entry.text)[0]).join("\n"); }

test("help factory is side-effect-free and exports matching help/h handlers", async (t) => {
  const f = fixture(t, [plugin("ping")]);
  assert.equal(f.help.id, "help");
  assert.equal(f.help.apiVersion, 1);
  assert.equal(f.help.commands.help.handle, f.help.commands.h.handle);
  assert.deepEqual(f.calls, { plugins: 0, commands: 0, configuration: 0 });
  const first = visible(await f.run());
  assert.equal(visible(await f.run([], "h")), first);
  assert.equal(f.scope.snapshot().pendingResources, 0);
});

test("main help shows single commands, grouped modules, dynamic prefixes and repository links", async (t) => {
  const f = fixture(t, [plugin("ping"), plugin("tools", ["one", "two"]), plugin("help", ["help", "h"])]);
  const messages = await f.run();
  const text = visible(messages);
  assert.match(text, /TeleBox By Cat/);
  assert.match(text, /5 个命令/);
  assert.match(text, /基础命令\n\.ping/);
  assert.match(text, /功能模块/);
  assert.match(text, /模块 tools\n\.one\n\.two/);
  assert.match(text, /\.help \[命令或模块名\]/);
  assert.match(text, /\.tpm search/);
  assert.ok(messages.some((entry) => entry.text.includes('href="https://github.com/MiCat-S/TeleBox"')));
  assert.ok(messages.some((entry) => entry.text.includes('href="https://github.com/MiCat-S/TeleBox-Plugins"')));
  assert.equal(messages[1].kind, "reply");
  for (const entry of messages) assert.equal(entry.message, f.message);
});

test("fallback basic commands remain populated when every plugin has multiple commands", async (t) => {
  const f = fixture(t, [plugin("tools", ["one", "two"])]);
  const messages = await f.run();
  assert.match(HTMLParser.parse(messages[0].text)[0], /\.one\n\.two/);
  assert.equal(visible(messages).includes("暂无基础命令"), false);
});

test("empty command catalogs and job-only modules have usable main and detail help", async (t) => {
  const f = fixture(t);
  assert.match(visible(await f.run()), /0 个命令[\s\S]*暂无基础命令/);
  const jobs = plugin("timer", [], "定时模块说明");
  jobs.jobs = [{ name: "daily", cron: "0 0 * * *", description: "每天运行" }];
  f.setPlugins([jobs]);
  assert.match(visible(await f.run()), /模块 timer\n无可调用命令/);
  const detail = visible(await f.run(["timer"]));
  assert.match(detail, /定时模块说明/);
  assert.match(detail, /定时任务\ndaily \(0 0 \* \* \*\)\n每天运行/);
  assert.equal(detail.includes(".undefined"), false);
  assert.equal(detail.includes("使用方法"), false);
});

test("prefixes and alias names are escaped and multi-byte prefixes resolve details", async (t) => {
  const f = fixture(t, [plugin("ping")]);
  f.setConfiguration({ prefixes: ["命令🙂<&", "!!"], aliases: { '快捷<&"': "ping fixed", "two words": "ping", stale: "unloaded" } });
  const messages = await f.run();
  const text = visible(messages);
  assert.match(text, /命令🙂<&ping/);
  assert.ok(text.includes('命令🙂<&快捷<&"'));
  assert.ok(text.includes("命令🙂<&two words"));
  assert.equal(text.includes("stale"), false);
  assert.ok(messages[0].text.includes("&lt;&amp;"));
  assert.match(visible(await f.run(["命令🙂<&ping"])), /ping 帮助/);
  assert.match(visible(await f.run(["two", "words"])), /命令🙂<&two words \[参数\]/);
});

test("alias lookup uses longest matching alias and one host-style expansion", async (t) => {
  const f = fixture(t, [plugin("first", ["one"]), plugin("second", ["two"])]);
  f.setConfiguration({ prefixes: ["."], aliases: { go: "one", "go now": "two preset", one: "two", loop: "missing" } });
  assert.match(visible(await f.run(["go", "now", "extra"])), /second 帮助/);
  assert.match(visible(await f.run(["go"])), /first 帮助/);
  assert.match(visible(await f.run(["one"])), /first 帮助/);
  assert.match(visible(await f.run(["loop"])), /未找到命令或模块/);
});

test("real single-token commands take precedence over aliases while longer aliases still resolve", async (t) => {
  const f = fixture(t, [plugin("first", ["one"]), plugin("second", ["two"])]);
  f.setConfiguration({ prefixes: ["."], aliases: { one: "two", "one now": "two preset" } });
  for (const args of [["one"], [".one"], ["one", "extra"], [".one", "extra"]]) {
    const text = visible(await f.run(args));
    assert.match(text, /first 帮助/);
    assert.match(text, /使用方法： .one \[参数\]/);
  }
  for (const args of [["one", "now"], [".one", "now", "extra"]]) {
    const text = visible(await f.run(args));
    assert.match(text, /second 帮助/);
    assert.match(text, /使用方法： .one now \[参数\]/);
  }
});

test("current configuration and catalog are read per invocation without stale unload entries", async (t) => {
  const f = fixture(t, [plugin("ping"), plugin("removed")]);
  assert.match(visible(await f.run()), /\.removed/);
  f.setConfiguration({ prefixes: ["新🙂", "!"], aliases: { now: "ping" } });
  f.setPlugins([plugin("ping")]);
  const text = visible(await f.run());
  assert.match(text, /新🙂ping/);
  assert.match(text, /新🙂now/);
  assert.equal(text.includes(".ping"), false);
  assert.equal(text.includes("removed"), false);
  assert.match(visible(await f.run(["removed"])), /未找到命令或模块/);
});

test("command and module details include complete command descriptions and cron metadata", async (t) => {
  const module = plugin("tools", ["one", "two"], "模块 <b>完整说明</b>");
  module.commands[0].description = "<i>第一个命令</i>";
  module.commands[1].description = "第二个命令";
  module.jobs = [{ name: 'job<&"', cron: "0 0 * * *", description: "<b>完整任务说明</b>" }];
  const f = fixture(t, [module]);
  for (const query of ["one", "ONE", "tools"]) {
    const messages = await f.run([query]);
    const text = visible(messages);
    assert.match(text, /模块 完整说明/);
    assert.match(text, /第一个命令/);
    assert.match(text, /第二个命令/);
    assert.ok(text.includes('job<&"'));
    assert.match(text, /完整任务说明/);
    assert.match(text, /0 0 \* \* \*/);
  }
});

test("valid description HTML preserves nested tags, escaped text, links and expandable blocks", async (t) => {
  const description = '<b>翻译 &amp; 使用</b>\n<code>gt &lt;消息&gt;</code>\n' +
    '<blockquote expandable>第一行\n<i>第二行</i></blockquote>\n' +
    '<span class="tg-spoiler">隐藏说明</span>\n' +
    '<pre><code class="language-js">if (x &lt; 2) return "好";</code></pre>\n' +
    '<a href="https://example.com/?a=1&amp;b=2">完整链接</a>';
  const entry = plugin("gt", ["gt"], description);
  entry.commands[0].description = description;
  const f = fixture(t, [entry]);
  const messages = await f.run(["gt"]);
  const html = messages.map((message) => message.text).join("\n");
  const text = visible(messages);
  assert.ok(html.includes('<blockquote expandable>第一行\n<i>第二行</i></blockquote>'));
  assert.ok(html.includes('<span class="tg-spoiler">隐藏说明</span>'));
  assert.ok(html.includes('<pre><code class="language-js">'));
  assert.ok(html.includes('href="https://example.com/?a=1&amp;b=2"'));
  assert.match(text, /gt <消息>/);
  assert.ok(text.includes('if (x < 2) return "好";'));
  assert.equal(text.includes("纯文本"), false);
});

test("unknown queries and untrusted labels are escaped instead of injecting HTML", async (t) => {
  const f = fixture(t, [plugin('module<&"', ["cmd"])]);
  let messages = await f.run(['<b>missing</b>&"']);
  assert.ok(visible(messages).includes('<b>missing</b>&"'));
  assert.equal(messages.some((message) => message.text.includes("<b>missing</b>")), false);
  messages = await f.run(["cmd"]);
  assert.ok(visible(messages).includes('module<&" 帮助'));
});

test("hundreds of single entries paginate without dropping commands or exceeding entities", async (t) => {
  const entries = Array.from({ length: 350 }, (_, index) => plugin(`plugin${index}`, [`cmd${String(index).padStart(4, "0")}`]));
  const f = fixture(t, entries);
  const messages = await f.run();
  assert.ok(messages.length > 3);
  const text = visible(messages);
  assert.match(text, /350 个命令/);
  for (let index = 0; index < entries.length; index += 1) {
    const name = `.cmd${String(index).padStart(4, "0")}`;
    assert.equal(text.split(name).length - 1, 1, name);
  }
  assert.equal(text.includes("纯文本"), false);
});

test("hundreds of module commands and aliases preserve all groups across replies", async (t) => {
  const entries = [plugin("single"), ...Array.from({ length: 120 }, (_, index) => plugin(`module${index}`, [`a${index}`, `b${index}`]))];
  const f = fixture(t, entries);
  f.setConfiguration({ prefixes: ["!"], aliases: Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`alias${index}`, `a${index}`])) });
  const messages = await f.run();
  const text = visible(messages);
  assert.ok(messages.length > 3);
  for (let index = 0; index < 120; index += 1) {
    assert.ok(text.includes(`模块 module${index}\n`));
    assert.ok(text.includes(`!a${index}（别名：!alias${index}）`));
    assert.ok(text.includes(`!b${index}`));
  }
});

test("an entity-heavy single block falls back to complete safe text", async (t) => {
  const text = Array.from({ length: 150 }, (_, index) => `<b>token${index};</b>`).join("");
  const entry = plugin("rich", ["rich"], text);
  entry.commands[0].description = "";
  const f = fixture(t, [entry]);
  const messages = await f.run(["rich"]);
  const body = visible(messages);
  assert.match(body, /纯文本分段显示/);
  for (let index = 0; index < 150; index += 1) assert.ok(body.includes(`token${index};`));
});

test("long formatted single blocks retain all multi-byte text and hidden link addresses", async (t) => {
  const body = "🙂<&汉字".repeat(1500);
  const escaped = body.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const url = "https://example.com/complete-help?one=1&two=2";
  const entry = plugin("long", ["long"], `<blockquote>${escaped}<a href="${url.replace(/&/g, "&amp;")}">详情</a></blockquote>`);
  entry.commands[0].description = "";
  const f = fixture(t, [entry]);
  const messages = await f.run(["long"]);
  const text = visible(messages);
  assert.ok(messages.length > 3);
  assert.match(text, /纯文本分段显示/);
  assert.equal((text.match(/🙂/g) ?? []).length, 1500);
  assert.equal((text.match(/汉字/g) ?? []).length, 1500);
  assert.ok(text.replace(/\n/g, "").includes(body));
  assert.ok(text.includes(url));
});

test("many complete description blocks retain formatting when crossing page boundaries", async (t) => {
  const lines = Array.from({ length: 200 }, (_, index) => `<b>段落${index}</b> 内容${index}`);
  const entry = plugin("many", ["many"], lines.join("\n"));
  entry.commands[0].description = "";
  const f = fixture(t, [entry]);
  const messages = await f.run(["many"]);
  assert.ok(messages.length > 2);
  const html = messages.map((message) => message.text).join("\n");
  for (const line of lines) assert.ok(html.includes(line));
  assert.equal(visible(messages).includes("纯文本"), false);
});

test("a complete block at the entity budget moves intact to its own page", async (t) => {
  const block = Array.from({ length: 90 }, (_, index) => `<b>entry${index};</b>`).join("");
  const entry = plugin("boundary", ["boundary"], block);
  entry.commands[0].description = "";
  const f = fixture(t, [entry]);
  const messages = await f.run(["boundary"]);
  assert.ok(messages.some((message) => message.text === block));
  assert.equal(visible(messages).includes("纯文本"), false);
});

test("very large alias lists are retained in safe pages", async (t) => {
  const f = fixture(t, [plugin("ping")]);
  f.setConfiguration({ prefixes: ["🙂"], aliases: Object.fromEntries(Array.from({ length: 250 }, (_, index) => [`shortcut${index}`, "ping"])) });
  const text = visible(await f.run());
  for (let index = 0; index < 250; index += 1) assert.ok(text.includes(`🙂shortcut${index}`));
  assert.match(text, /纯文本分段显示/);
});

test("unsupported markup and unsafe URLs become escaped text without active tags", async (t) => {
  const entry = plugin("unsafe", ["unsafe"], '<script>private-source</script>\n<a href="javascript:alert(1)">link</a>');
  entry.commands[0].description = "";
  const f = fixture(t, [entry]);
  const messages = await f.run(["unsafe"]);
  const html = messages.map((message) => message.text).join("\n");
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes('<a href="javascript:'), false);
  assert.ok(visible(messages).includes("private-source"));
  assert.ok(visible(messages).includes("javascript:alert(1)"));
});

test("empty descriptions have an explicit fallback", async (t) => {
  const entry = plugin("empty", ["empty"], "");
  entry.commands[0].description = "";
  const f = fixture(t, [entry]);
  assert.match(visible(await f.run(["empty"])), /暂无描述信息/);
});

test("generation failures show a fixed safe error without exposing source exceptions", async (t) => {
  const f = fixture(t);
  f.host.listPlugins = () => { throw new Error("private-source"); };
  const text = visible(await f.run());
  assert.equal(text, "帮助暂时不可用，请稍后重试。");
  assert.deepEqual(f.errors, ["help.failed"]);
});

test("transport failures propagate without duplicate sends or error payloads", async (t) => {
  const f = fixture(t, [plugin("ping")]);
  let calls = 0;
  const failure = new Error("transport failure");
  f.context.telegram.edit = async () => { calls += 1; throw failure; };
  await assert.rejects(f.run(), (error) => error === failure);
  assert.equal(calls, 1);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.errors, []);
});

test("cancellation after the first page stops further replies and keeps actual work tracked", async (t) => {
  const f = fixture(t, Array.from({ length: 180 }, (_, index) => plugin(`cmd${index}`)));
  const original = f.context.telegram.edit;
  const reason = new Error("unloaded");
  f.context.telegram.edit = async (...args) => { await original(...args); f.scope.abort(reason); };
  await assert.rejects(f.run(), (error) => error === reason);
  assert.equal(f.sent.length, 1);
  assert.equal(f.scope.snapshot().pendingTasks, 0);
  assert.deepEqual(f.errors, []);
});

test("unload waits for an accepted pending send and sends no later help pages", async (t) => {
  const f = fixture(t, Array.from({ length: 180 }, (_, index) => plugin(`cmd${index}`)));
  let started!: () => void;
  let release!: () => void;
  const sending = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = f.context.telegram.edit;
  f.context.telegram.edit = async (...args) => { await original(...args); started(); await gate; };
  const pending = f.run();
  const rejected = assert.rejects(pending);
  await sending;
  const report = await f.scope.drain(5);
  assert.equal(report.completed, false);
  assert.equal(report.timedOut, true);
  assert.equal(report.pendingTasks, 1);
  release();
  await rejected;
  assert.equal(f.sent.length, 1);
  assert.equal((await f.scope.drain()).completed, true);
});

test("50 help cycles keep scope resources empty and produce independent current output", async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 50; index += 1) {
    f.setPlugins([plugin(`entry${index}`)]);
    const text = visible(await f.run());
    assert.ok(text.includes(`.entry${index}`));
    assert.equal(f.scope.snapshot().pendingTasks, 0);
    assert.equal(f.scope.snapshot().pendingResources, 0);
  }
});
