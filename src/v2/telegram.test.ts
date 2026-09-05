import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { spawnSync } from "node:child_process";
import { inspect } from "node:util";
import test from "node:test";
import { Api } from "teleproto";
import type { TelegramClient } from "teleproto";
import { returnBigInt } from "teleproto/Helpers";
import { getPeerId } from "teleproto/Utils";
import { NewMessage, NewMessageEvent } from "teleproto/events/NewMessage";
import { EditedMessage } from "teleproto/events/EditedMessage";
import type { EventBuilder } from "teleproto/events/common";
import type { MessageEnvelope } from "./sdk";
import { ResourceScope } from "./lifecycle";
import { messageEnvelope, subscribeMessages, TelegramAbortError, TelegramEventError, TeleprotoPort } from "./telegram";

const LARGE = "9007199254740993";
const SELF = "9007199254740995";
const SECRET = "telegram-secret-sentinel-4ae7";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function message(options: Partial<ConstructorParameters<typeof Api.Message>[0]> = {}): Api.Message {
  return new Api.Message({
    id: 71,
    peerId: new Api.PeerChannel({ channelId: returnBigInt(LARGE) }),
    fromId: new Api.PeerUser({ userId: returnBigInt(SELF) }),
    message: "fixture text",
    date: 1_700_000_000,
    ...options,
  });
}

type Callback = (event: NewMessageEvent) => unknown;
class FakeClient {
  handlers: Array<[EventBuilder, Callback]> = [];
  removed: Array<[EventBuilder, CallableFunction]> = [];
  calls: Array<{ method: string; args: unknown[] }> = [];
  response: unknown = message();
  gate?: Promise<unknown>;
  onAdd?: () => void;
  onRemove?: () => void;

  get client(): TelegramClient { return this as unknown as TelegramClient; }

  addEventHandler(callback: Callback, builder: EventBuilder): void {
    this.handlers.push([builder, callback]);
    this.onAdd?.();
  }

  removeEventHandler(callback: CallableFunction, builder: EventBuilder): void {
    this.removed.push([builder, callback]);
    this.onRemove?.();
    // Mirror 1.229.0: matching either callback or builder removes an entry.
    this.handlers = this.handlers.filter(([otherBuilder, otherCallback]) => otherBuilder !== builder && otherCallback !== callback);
  }

  async editMessage(...args: Parameters<TelegramClient["editMessage"]>): Promise<unknown> {
    this.calls.push({ method: "edit", args });
    return this.gate ?? this.response;
  }

  async sendMessage(...args: Parameters<TelegramClient["sendMessage"]>): Promise<unknown> {
    this.calls.push({ method: "reply", args });
    return this.gate ?? this.response;
  }

  async getMessages(...args: Parameters<TelegramClient["getMessages"]>): Promise<unknown> {
    this.calls.push({ method: "getReply", args });
    return this.gate ?? this.response;
  }

  async invoke(request: unknown): Promise<unknown> {
    this.calls.push({ method: "invoke", args: [request] });
    return this.gate ?? this.response;
  }

  connect(): never { assert.fail("no connection is permitted"); }
  start(): never { assert.fail("no authentication is permitted"); }
  disconnect(): never { assert.fail("shared client must not be disconnected"); }
  getMe(): never { assert.fail("identity must be supplied"); }
  getEntity(): never { assert.fail("conversion must not fetch entities"); }

  async emit(update: Api.TypeUpdate): Promise<void> {
    for (const [builder, callback] of [...this.handlers]) {
      const event = builder.build(update, undefined, returnBigInt(SELF));
      if (event) await callback(event as NewMessageEvent);
    }
  }
}

test("loading the adapter does not load Teleproto at runtime", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--eval", `
    require(${JSON.stringify(require.resolve("./telegram"))});
    const loaded = Object.keys(require.cache).some(path => path.includes('/node_modules/teleproto/'));
    process.stdout.write(JSON.stringify({ loaded }));
  `], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { loaded: false });
});

for (const kind of ["user", "chat", "channel"] as const) {
  test(`envelope preserves ${kind} IDs beyond 2^53 exactly`, () => {
    const peer = kind === "user" ? new Api.PeerUser({ userId: returnBigInt(LARGE) })
      : kind === "chat" ? new Api.PeerChat({ chatId: returnBigInt(LARGE) })
        : new Api.PeerChannel({ channelId: returnBigInt(LARGE) });
    const raw = message({ peerId: peer });
    const envelope = messageEnvelope(raw);
    assert.equal(envelope.chatId, getPeerId(peer));
    assert.equal(envelope.senderId, getPeerId(raw.fromId!));
    assert.equal(messageEnvelope(message({ fromId: peer })).senderId, getPeerId(peer));
    assert.equal(envelope.raw, raw);
  });
}

test("conversion is a frozen scalar snapshot, retaining the complete mutable raw object", () => {
  const raw = message();
  for (const name of ["getSender", "getChat", "getInputChat", "getReplyMessage"]) {
    Object.defineProperty(raw, name, { value: () => assert.fail(`${name} must not run`) });
  }
  for (const name of ["text", "buttons", "inputChat"]) {
    Object.defineProperty(raw, name, { get: () => assert.fail(`${name} must not be inspected`) });
  }
  const envelope = messageEnvelope(raw);
  assert.equal(Object.isFrozen(envelope), true);
  assert.equal(Object.isFrozen(raw), false);
  assert.equal(envelope.raw, raw);
  assert.throws(() => { (envelope as { text: string }).text = "changed"; }, TypeError);
  raw.message = "later edit";
  assert.equal(envelope.text, "fixture text");
  assert.equal((envelope.raw as Api.Message).message, "later edit");
});

test("conversion does not mutate peer IDs even when their objects are frozen", () => {
  const raw = message();
  const expected = getPeerId(message().peerId);
  Object.freeze(raw.peerId);
  Object.freeze(raw.fromId);
  assert.equal(messageEnvelope(raw).chatId, expected);
});

test("outgoing, saved, edited and forwarded flags remain independent", () => {
  const fwdFrom = new Api.MessageFwdHeader({ date: 1, fromId: new Api.PeerUser({ userId: returnBigInt(LARGE) }) });
  const raw = message({ out: false, editDate: 2, fwdFrom });
  Object.assign(raw, { savedPeerId: new Api.PeerUser({ userId: returnBigInt(LARGE) }) });
  const envelope = messageEnvelope(raw);
  assert.equal(envelope.outgoing, false);
  assert.equal(envelope.saved, true);
  assert.equal(envelope.edited, true);
  assert.equal(envelope.forwarded, true);
  assert.equal((envelope.raw as Api.Message).fwdFrom, fwdFrom);
  const outgoing = messageEnvelope(message({ out: true }));
  assert.equal(outgoing.outgoing, true);
  assert.equal(outgoing.saved, false);
  assert.equal(outgoing.edited, false);
  assert.equal(outgoing.forwarded, false);
});

test("supplied self ID recognizes Saved Messages without getMe", () => {
  const raw = message({ peerId: new Api.PeerUser({ userId: returnBigInt(SELF) }), out: false });
  assert.equal(messageEnvelope(raw, { selfId: SELF }).saved, true);
  assert.equal(messageEnvelope(raw).saved, false);
});

test("missing sender IDs use only local peer and supplied account identity", () => {
  const peer = new Api.PeerUser({ userId: returnBigInt(LARGE) });
  assert.equal(messageEnvelope(message({ peerId: peer, fromId: undefined, out: false })).senderId, getPeerId(peer));
  assert.equal(messageEnvelope(message({ peerId: peer, fromId: undefined, out: true }), { selfId: SELF }).senderId, SELF);
  assert.equal(messageEnvelope(message({ fromId: undefined, out: false })).senderId, undefined);
  const post = message({ fromId: undefined, post: true });
  assert.equal(messageEnvelope(post).senderId, getPeerId(post.peerId));
});

test("forum topic roots, nested replies and ordinary replies keep distinct IDs", () => {
  const nested = messageEnvelope(message({ replyTo: new Api.MessageReplyHeader({
    forumTopic: true, replyToMsgId: 90, replyToTopId: 20,
  }) }));
  assert.equal(nested.replyToId, 90);
  assert.equal(nested.topicId, 20);
  const root = messageEnvelope(message({ replyTo: new Api.MessageReplyHeader({ forumTopic: true, replyToMsgId: 20 }) }));
  assert.equal(root.replyToId, 20);
  assert.equal(root.topicId, 20);
  const ordinary = messageEnvelope(message({ replyTo: new Api.MessageReplyHeader({ replyToMsgId: 20 }) }));
  assert.equal(ordinary.replyToId, 20);
  assert.equal(ordinary.topicId, undefined);
  const story = messageEnvelope(message({ replyTo: new Api.MessageReplyStoryHeader({
    peer: new Api.PeerUser({ userId: returnBigInt(LARGE) }), storyId: 20,
  }) }));
  assert.equal(story.replyToId, undefined);
  assert.equal(story.topicId, undefined);
});

test("event edit marker and empty media captions convert without formatted-text access", () => {
  const raw = message({ message: undefined });
  const envelope = messageEnvelope(raw, { edited: true });
  assert.equal(envelope.text, "");
  assert.equal(envelope.edited, true);
});

test("edit uses injected client and cached input peer, preserving options and reply markup", async () => {
  const fake = new FakeClient();
  const scope = new ResourceScope();
  const port = new TeleprotoPort(fake.client, scope);
  const raw = message({ out: true });
  const peer = new Api.InputPeerChannel({ channelId: returnBigInt(LARGE), accessHash: returnBigInt("456") });
  const markup = new Api.ReplyInlineMarkup({ rows: [] });
  raw.replyMarkup = markup;
  Object.defineProperty(raw, "inputChat", { value: peer });
  const options = Object.freeze({ parseMode: "html" as const, linkPreview: false });
  assert.equal(await port.edit(messageEnvelope(raw), "<b>updated</b>", options, scope.signal), undefined);
  assert.deepEqual(fake.calls, [{ method: "edit", args: [peer, {
    message: 71, text: "<b>updated</b>", parseMode: "html", linkPreview: false, buttons: markup,
  }] }]);
  await scope.drain();
});

test("reply addresses the current message inside its forum topic", async () => {
  const fake = new FakeClient();
  const scope = new ResourceScope();
  const port = new TeleprotoPort(fake.client, scope);
  const raw = message({ replyTo: new Api.MessageReplyHeader({ forumTopic: true, replyToMsgId: 66, replyToTopId: 20 }) });
  await port.reply(messageEnvelope(raw), "response", { linkPreview: true }, scope.signal);
  assert.equal(fake.calls[0].args[0], raw.peerId);
  assert.deepEqual(fake.calls[0].args[1], {
    message: "response", replyTo: 71, topMsgId: 20, parseMode: false, linkPreview: true,
  });
  await scope.drain();
});

test("envelopes without raw convert decimal IDs to precise integer entities only on demand", async () => {
  const fake = new FakeClient();
  const scope = new ResourceScope();
  const expected = getPeerId(message().peerId);
  const envelope: MessageEnvelope = { id: 11, chatId: expected, text: "", outgoing: true };
  await new TeleprotoPort(fake.client, scope).reply(envelope, "response", {}, scope.signal);
  const target = fake.calls[0].args[0] as { toString(): string };
  assert.equal(typeof target, "object");
  assert.equal(target.toString(), expected);
  await scope.drain();
});

test("invoke passes raw request and native response through unchanged", async () => {
  const fake = new FakeClient();
  const scope = new ResourceScope();
  const request = new Api.messages.GetMessages({ id: [new Api.InputMessageID({ id: 17 })] });
  const result = { value: 1 };
  fake.response = result;
  assert.equal(await new TeleprotoPort(fake.client, scope).invoke(request, scope.signal), result);
  assert.equal(fake.calls[0].args[0], request);
  await scope.drain();
});

test("withClient exposes only the supplied client and returns typed operation results", async () => {
  const fake = new FakeClient();
  const scope = new ResourceScope();
  const controller = new AbortController();
  const port = new TeleprotoPort(fake.client, scope);
  const value = await port.withClient(async (client, signal) => {
    assert.equal(client, fake.client);
    assert.equal(signal.aborted, false);
    assert.equal(scope.snapshot().pendingTasks, 1);
    return { answer: 42 };
  }, controller.signal);
  assert.deepEqual(value, { answer: 42 });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(getEventListeners(scope.signal, "abort").length, 0);
  await scope.drain();
});

const methods = ["edit", "reply", "invoke", "getReply", "withClient"] as const;
type Method = typeof methods[number];
function operation(port: TeleprotoPort, fake: FakeClient, method: Method, signal: AbortSignal): Promise<unknown> {
  const raw = message({ replyTo: new Api.MessageReplyHeader({ replyToMsgId: 70 }) });
  const envelope = messageEnvelope(raw);
  if (method === "edit" || method === "reply") return port[method](envelope, "text", {}, signal);
  if (method === "getReply") return port.getReply(envelope, signal);
  if (method === "invoke") return port.invoke({ classType: "request" }, signal);
  return port.withClient(async () => {
    fake.calls.push({ method: "withClient", args: [] });
    return fake.gate ?? fake.response;
  }, signal);
}

for (const method of methods) {
  test(`${method} prechecks caller and scope cancellation before any client work`, async () => {
    for (const source of ["caller", "scope"] as const) {
      const fake = new FakeClient();
      const scope = new ResourceScope();
      const controller = new AbortController();
      if (source === "scope") scope.abort(new Error(SECRET));
      else controller.abort(new Error(SECRET));
      await assert.rejects(operation(new TeleprotoPort(fake.client, scope), fake, method, controller.signal), (error) => {
        assert.ok(error instanceof TelegramAbortError);
        assert.equal(inspect(error).includes(SECRET), false);
        return true;
      });
      assert.deepEqual(fake.calls, []);
      assert.equal(scope.snapshot().pendingTasks, 0);
      await scope.drain();
    }
  });

  test(`${method} cancellation waits for real settlement and stays tracked across drain timeout`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fake = new FakeClient();
    const scope = new ResourceScope();
    const controller = new AbortController();
    const gate = deferred<unknown>();
    fake.gate = gate.promise;
    const task = operation(new TeleprotoPort(fake.client, scope), fake, method, controller.signal);
    await flush();
    assert.equal(fake.calls.length, 1);
    controller.abort(new Error(SECRET));
    let settled = false;
    void task.then(() => { settled = true; }, () => { settled = true; });
    const draining = scope.drain(5);
    t.mock.timers.tick(5);
    const report = await draining;
    assert.equal(report.completed, false);
    assert.equal(report.pendingTasks, 1);
    assert.equal(settled, false);
    gate.resolve(message({ id: 70 }));
    await assert.rejects(task, TelegramAbortError);
    assert.equal(fake.calls.length, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal(getEventListeners(scope.signal, "abort").length, 0);
    assert.equal((await scope.drain()).completed, true);
  });
}

test("cancellation between peer preparation and send prevents dispatch", async () => {
  const fake = new FakeClient();
  const scope = new ResourceScope();
  const controller = new AbortController();
  const port = new TeleprotoPort(fake.client, scope);
  const task = port.reply(messageEnvelope(message()), "text", {}, controller.signal);
  controller.abort();
  await assert.rejects(task, TelegramAbortError);
  assert.deepEqual(fake.calls, []);
  await scope.drain();
});

test("withClient forwards sanitized cancellation and waits through the operation's finally", async () => {
  const fake = new FakeClient();
  const scope = new ResourceScope();
  const port = new TeleprotoPort(fake.client, scope);
  const cleanup = deferred();
  const cleaning = deferred();
  const task = port.withClient(async (_client, signal) => {
    try {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      assert.equal(inspect(signal.reason).includes(SECRET), false);
    } finally {
      cleaning.resolve();
      await cleanup.promise;
    }
  }, scope.signal);
  scope.abort(new Error(SECRET));
  await cleaning.promise;
  assert.equal(scope.snapshot().pendingTasks, 1);
  cleanup.resolve();
  await assert.rejects(task, TelegramAbortError);
  await scope.drain();
});

test("native RPC errors reach callers unchanged after cancellation and are never logged", async (t) => {
  const log = t.mock.method(console, "log", () => undefined);
  const errorLog = t.mock.method(console, "error", () => undefined);
  const warn = t.mock.method(console, "warn", () => undefined);
  for (const method of methods) {
    const fake = new FakeClient();
    const scope = new ResourceScope();
    const gate = deferred<unknown>();
    fake.gate = gate.promise;
    const task = operation(new TeleprotoPort(fake.client, scope), fake, method, scope.signal);
    await flush();
    scope.abort();
    const error = Object.assign(new Error(SECRET), { errorMessage: "FLOOD_WAIT", seconds: 10 });
    gate.reject(error);
    await assert.rejects(task, (received) => received === error);
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(scope.snapshot().errors, []);
    await scope.drain();
  }
  assert.equal(log.mock.callCount(), 0);
  assert.equal(errorLog.mock.callCount(), 0);
  assert.equal(warn.mock.callCount(), 0);
});

test("getReply prioritizes raw.replyTo and retains the returned protocol object", async () => {
  const fake = new FakeClient();
  const scope = new ResourceScope();
  const raw = message({ replyTo: new Api.MessageReplyHeader({ replyToMsgId: 50, replyToTopId: 20 }) });
  const reply = message({ id: 50, out: true, editDate: 4 });
  fake.response = [reply];
  const envelope = { ...messageEnvelope(raw), replyToId: 999, topicId: 888 };
  const result = await new TeleprotoPort(fake.client, scope).getReply(envelope, scope.signal);
  assert.equal(result?.id, 50);
  assert.equal(result?.raw, reply);
  assert.equal(result?.edited, true);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(fake.calls, [{ method: "getReply", args: [raw.peerId, { ids: [50] }] }]);
  await scope.drain();
});

test("cross-chat reply headers select their own peer instead of the current input chat", async () => {
  const fake = new FakeClient();
  const scope = new ResourceScope();
  const peer = new Api.PeerChannel({ channelId: returnBigInt("9007199254740997") });
  const raw = message({ replyTo: new Api.MessageReplyHeader({ replyToMsgId: 50, replyToPeerId: peer }) });
  fake.response = message({ id: 50, peerId: peer });
  const result = await new TeleprotoPort(fake.client, scope).getReply(messageEnvelope(raw), scope.signal);
  assert.equal(fake.calls[0].args[0], peer);
  assert.equal(result?.raw, fake.response);
  await scope.drain();
});

for (const kind of ["user", "chat", "channel"] as const) {
  test(`getReply supports a pure envelope with an exact ${kind} peer ID`, async () => {
    const fake = new FakeClient();
    const scope = new ResourceScope();
    const peer = kind === "user" ? new Api.PeerUser({ userId: returnBigInt(LARGE) })
      : kind === "chat" ? new Api.PeerChat({ chatId: returnBigInt(LARGE) })
        : new Api.PeerChannel({ channelId: returnBigInt(LARGE) });
    const chatId = getPeerId(peer);
    const envelope: MessageEnvelope = {
      id: 71, chatId, text: "fixture", outgoing: true, replyToId: 50, topicId: 20,
    };
    const reply = message({ id: 50, peerId: peer });
    fake.response = [reply];
    const result = await new TeleprotoPort(fake.client, scope).getReply(envelope, scope.signal);
    assert.equal(result?.raw, reply);
    assert.equal(result?.chatId, getPeerId(peer));
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].method, "getReply");
    const target = fake.calls[0].args[0] as ReturnType<typeof returnBigInt>;
    assert.equal(typeof target, "object");
    assert.equal(getPeerId(target), chatId);
    assert.deepEqual(fake.calls[0].args[1], { ids: [50] });
    await scope.drain();
  });
}

test("getReply uses envelope replyToId when raw has no reply message ID", async () => {
  const fake = new FakeClient();
  const scope = new ResourceScope();
  const port = new TeleprotoPort(fake.client, scope);
  const input = new Api.InputPeerChannel({ channelId: returnBigInt(LARGE), accessHash: returnBigInt(456) });
  for (const replyTo of [undefined, new Api.MessageReplyHeader({ replyToTopId: 20 })]) {
    const raw = message({ replyTo });
    Object.defineProperty(raw, "inputChat", { value: input });
    const reply = message({ id: 50 });
    fake.response = [reply];
    const result = await port.getReply({ ...messageEnvelope(raw), replyToId: 50 }, scope.signal);
    assert.equal(result?.raw, reply);
    assert.equal(fake.calls.at(-1)!.args[0], input);
    assert.deepEqual(fake.calls.at(-1)!.args[1], { ids: [50] });
  }
  assert.equal(fake.calls.length, 2);
  await scope.drain();
});

test("pure-envelope getReply cancellation retains the task until RPC settlement", async () => {
  const fake = new FakeClient();
  const scope = new ResourceScope();
  const entered = deferred();
  const gate = deferred<unknown>();
  fake.gate = gate.promise;
  const getMessages = fake.getMessages.bind(fake);
  fake.getMessages = async (...args) => {
    entered.resolve();
    return getMessages(...args);
  };
  const envelope: MessageEnvelope = {
    id: 71, chatId: getPeerId(message().peerId), text: "", outgoing: true, replyToId: 50,
  };
  const task = new TeleprotoPort(fake.client, scope).getReply(envelope, scope.signal);
  await entered.promise;
  scope.abort(new Error(SECRET));
  await flush();
  assert.equal(scope.snapshot().pendingTasks, 1);
  gate.resolve([message({ id: 50 })]);
  await assert.rejects(task, TelegramAbortError);
  assert.equal(fake.calls.length, 1);
  assert.equal((await scope.drain()).completed, true);
});

test("getReply requires an explicit reply ID and rejects unrelated results", async () => {
  const fake = new FakeClient();
  const scope = new ResourceScope();
  const port = new TeleprotoPort(fake.client, scope);
  const ordinary = messageEnvelope(message());
  assert.equal(await port.getReply({ ...ordinary, raw: undefined }, scope.signal), undefined);
  assert.equal(await port.getReply(ordinary, scope.signal), undefined);
  const topicOnly = message({ replyTo: new Api.MessageReplyHeader({ replyToTopId: 20 }) });
  assert.equal(await port.getReply(messageEnvelope(topicOnly), scope.signal), undefined);
  const story = message({ replyTo: new Api.MessageReplyStoryHeader({ peer: message().peerId, storyId: 50 }) });
  assert.equal(await port.getReply(messageEnvelope(story), scope.signal), undefined);
  assert.equal(fake.calls.length, 0);
  const envelope = messageEnvelope(message({ replyTo: new Api.MessageReplyHeader({ replyToMsgId: 50 }) }));
  for (const result of [undefined, [], [undefined], [new Api.MessageEmpty({ id: 50 })], [message({ id: 51 })]]) {
    fake.response = result;
    assert.equal(await port.getReply(envelope, scope.signal), undefined);
  }
  assert.equal(fake.calls.length, 5);
  await scope.drain();
});

test("getReply suppresses only the known missing-message date crash", async () => {
  const fake = new FakeClient();
  const scope = new ResourceScope();
  const port = new TeleprotoPort(fake.client, scope);
  const envelope = messageEnvelope(message({ replyTo: new Api.MessageReplyHeader({ replyToMsgId: 50 }) }));
  const known = new TypeError("Cannot read properties of undefined (reading 'date')");
  fake.gate = Promise.reject(known);
  assert.equal(await port.getReply(envelope, scope.signal), undefined);
  const other = new TypeError("Cannot read properties of undefined (reading 'id')");
  fake.gate = Promise.reject(other);
  await assert.rejects(port.getReply(envelope, scope.signal), (error) => error === other);
  assert.equal(fake.calls.length, 2);
  await scope.drain();
});

test("real NewMessage and EditedMessage builders deliver immutable envelopes to one sink", async () => {
  const fake = new FakeClient();
  const scope = new ResourceScope();
  const seen: MessageEnvelope[] = [];
  const dispose = await subscribeMessages(fake.client, scope, (envelope, signal) => {
    assert.equal(signal, scope.signal);
    seen.push(envelope);
  }, { selfId: SELF });
  assert.equal(fake.handlers.length, 2);
  assert.ok(fake.handlers[0][0] instanceof NewMessage);
  assert.ok(fake.handlers[1][0] instanceof EditedMessage);
  const first = message({ out: true });
  const second = message({ message: "edited" });
  await fake.emit(new Api.UpdateNewChannelMessage({ message: first, pts: 1, ptsCount: 1 }));
  await fake.emit(new Api.UpdateEditChannelMessage({ message: second, pts: 2, ptsCount: 1 }));
  assert.equal(seen.length, 2);
  assert.equal(seen[0].raw, first);
  assert.equal(seen[0].edited, false);
  assert.equal(seen[1].raw, second);
  assert.equal(seen[1].edited, true);
  assert.ok(seen.every(Object.isFrozen));
  const result = dispose();
  assert.equal(dispose(), result);
  await result;
  assert.equal(fake.handlers.length, 0);
  assert.equal((await scope.drain()).completed, true);
});

test("50 subscription cycles remove only owned callbacks and builders, never the shared client", async () => {
  const fake = new FakeClient();
  const foreignBuilder = new NewMessage({});
  const foreignHandler = (): void => undefined;
  fake.addEventHandler(foreignHandler, foreignBuilder);
  for (let i = 0; i < 50; i += 1) {
    const scope = new ResourceScope();
    await subscribeMessages(fake.client, scope, () => undefined);
    assert.equal(fake.handlers.length, 3);
    assert.equal(scope.snapshot().pendingResources, 1);
    assert.equal((await scope.drain()).completed, true);
    assert.deepEqual(fake.handlers, [[foreignBuilder, foreignHandler]]);
    assert.equal(scope.snapshot().pendingResources, 0);
    assert.equal(getEventListeners(scope.signal, "abort").length, 0);
  }
  assert.equal(fake.removed.length, 100);
});

test("one subscription per client is enforced even while registration is awaiting imports", async () => {
  const fake = new FakeClient();
  const scope = new ResourceScope();
  const other = new ResourceScope();
  const first = subscribeMessages(fake.client, scope, () => undefined);
  await assert.rejects(subscribeMessages(fake.client, other, () => undefined), /already has a message subscription/);
  const dispose = await first;
  assert.equal(fake.handlers.length, 2);
  await dispose();
  const second = await subscribeMessages(fake.client, other, () => undefined);
  await second();
  await scope.drain();
  await other.drain();
});

test("scope abort detaches listeners immediately; stale callbacks do not enter sink", async () => {
  const fake = new FakeClient();
  const scope = new ResourceScope();
  let calls = 0;
  await subscribeMessages(fake.client, scope, () => { calls += 1; });
  const callback = fake.handlers[0][1];
  scope.abort(SECRET);
  assert.equal(fake.handlers.length, 0);
  const raw = message();
  await callback(new NewMessageEvent(raw, new Api.UpdateNewMessage({ message: raw, pts: 1, ptsCount: 1 })));
  assert.equal(calls, 0);
  await scope.drain();
});

test("subscription cancellation does not prematurely settle an in-flight sink or its finally", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = new FakeClient();
  const scope = new ResourceScope();
  const entered = deferred();
  const work = deferred();
  const cleaning = deferred();
  const cleanup = deferred();
  await subscribeMessages(fake.client, scope, async () => {
    entered.resolve();
    try { await work.promise; } finally { cleaning.resolve(); await cleanup.promise; }
  });
  const raw = message();
  const pending = fake.emit(new Api.UpdateNewMessage({ message: raw, pts: 1, ptsCount: 1 }));
  await entered.promise;
  const draining = scope.drain(5);
  t.mock.timers.tick(5);
  const report = await draining;
  assert.equal(report.pendingTasks, 1);
  assert.equal(report.completed, false);
  assert.equal(fake.handlers.length, 0);
  work.resolve();
  await cleaning.promise;
  assert.equal(scope.snapshot().pendingTasks, 1);
  cleanup.resolve();
  await pending;
  assert.equal((await scope.drain()).completed, true);
});

test("sink exceptions are redacted before Teleproto can log handler failures", async () => {
  const fake = new FakeClient();
  const scope = new ResourceScope();
  await subscribeMessages(fake.client, scope, async () => { throw new Error(SECRET, { cause: { token: SECRET } }); });
  const raw = message();
  await assert.rejects(fake.emit(new Api.UpdateNewMessage({ message: raw, pts: 1, ptsCount: 1 })), (error) => {
    assert.ok(error instanceof TelegramEventError);
    assert.equal(inspect(error, { depth: 10 }).includes(SECRET), false);
    assert.equal("cause" in error, false);
    return true;
  });
  assert.deepEqual(scope.snapshot().errors, []);
  await scope.drain();
});

test("cancelled subscription setup adds no listeners and releases its reservation", async () => {
  const fake = new FakeClient();
  const scope = new ResourceScope();
  const pending = subscribeMessages(fake.client, scope, () => undefined);
  scope.abort(SECRET);
  await assert.rejects(pending, TelegramAbortError);
  assert.equal(fake.handlers.length, 0);
  await scope.drain();
  const next = new ResourceScope();
  await subscribeMessages(fake.client, next, () => undefined);
  await next.drain();
});

test("pre-aborted subscription never registers a listener", async () => {
  const fake = new FakeClient();
  const scope = new ResourceScope();
  scope.abort(SECRET);
  await assert.rejects(subscribeMessages(fake.client, scope, () => undefined), TelegramAbortError);
  assert.equal(fake.handlers.length, 0);
  await scope.drain();
});

test("partial registration failure rolls back its handlers and redacts error details", async () => {
  const fake = new FakeClient();
  const scope = new ResourceScope();
  fake.onAdd = () => { if (fake.handlers.length === 2) throw new Error(SECRET); };
  await assert.rejects(subscribeMessages(fake.client, scope, () => undefined), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(inspect(error).includes(SECRET), false);
    return true;
  });
  assert.equal(fake.handlers.length, 0);
  fake.onAdd = undefined;
  await subscribeMessages(fake.client, scope, () => undefined);
  await scope.drain();
});

test("abort during registration rolls back before a second handler is added", async () => {
  const fake = new FakeClient();
  const scope = new ResourceScope();
  let additions = 0;
  fake.onAdd = () => { additions += 1; scope.abort(SECRET); };
  await assert.rejects(subscribeMessages(fake.client, scope, () => undefined), TelegramAbortError);
  assert.equal(additions, 1);
  assert.equal(fake.handlers.length, 0);
  await scope.drain();
});

test("cleanup attempts both removals and reports only a fixed error to ResourceScope", async () => {
  const fake = new FakeClient();
  const scope = new ResourceScope();
  await subscribeMessages(fake.client, scope, () => undefined);
  fake.onRemove = () => { throw new Error(SECRET); };
  const report = await scope.drain();
  assert.equal(fake.removed.length, 2);
  assert.equal(report.completed, false);
  assert.equal(report.errors.length, 1);
  assert.equal(inspect(report.errors).includes(SECRET), false);
});

test("inline callback payloads stay in raw and are not inspected by generic adaptation", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(Api, "InlineButtonTypeCallback")!;
  const callbackType = new Api.InlineButtonTypeCallback({ data: Buffer.from(SECRET) });
  const raw = message();
  const markup = { callbackType };
  Object.assign(raw, { replyMarkup: markup });
  let reads = 0;
  Object.defineProperty(Api, "InlineButtonTypeCallback", { configurable: true, get() {
    reads += 1;
    throw new Error("callback type must only be read for explicit callback operations");
  } });
  const scope = new ResourceScope();
  try {
    const fake = new FakeClient();
    const envelope = messageEnvelope(raw);
    assert.equal((envelope.raw as Api.Message).replyMarkup, markup);
    await new TeleprotoPort(fake.client, scope).edit(envelope, "text", {}, scope.signal);
    await subscribeMessages(fake.client, scope, () => undefined);
    assert.equal(reads, 0);
  } finally {
    Object.defineProperty(Api, "InlineButtonTypeCallback", descriptor);
    await scope.drain();
  }
});
