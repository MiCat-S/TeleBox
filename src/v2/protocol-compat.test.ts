import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { TelegramClient, Api } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { returnBigInt } from "teleproto/Helpers";
import { PtsWaiter } from "teleproto/client/updates/ptsWaiter";
import { installProtocolCompatibility } from "./protocol-compat";

const gap = (id = "123456789") => ({ message: `fetchChannelDifference ${id}: HISTORY_GET_FAILED` });
function fixture() {
  const calls: unknown[][] = [];
  const mediaPrototype = {
    async savePart(dc: number, request: unknown, signal?: AbortSignal): Promise<unknown> {
      calls.push([this, dc, request, signal]);
      return "native";
    },
  };
  const managerPrototype = { async fetchChannelDifference(_id: string, ..._args: unknown[]): Promise<unknown> { return "diff"; } };
  const manager = Object.assign(Object.create(managerPrototype) as typeof managerPrototype, {
    channels: new Map<string, { timer?: ReturnType<typeof setTimeout>; pollTimer?: ReturnType<typeof setTimeout>; pts: PtsWaiter }>(),
    channelFailRetryTimers: new Map<string, ReturnType<typeof setTimeout>>(),
    channelFailTimeoutS: new Map<string, number>(),
  });
  const client = {
    session: { dcId: 2 },
    async invoke(request: unknown): Promise<unknown> { calls.push([this, request]); return "main"; },
    _media: Object.create(mediaPrototype) as typeof mediaPrototype,
    updateManager: manager,
  };
  function tracker(id = "123456789") {
    const pts = new PtsWaiter({ onWaitForSkipped() {}, onWaitForShortPoll() {} });
    pts.init(10);
    pts.setRequesting(true);
    const value = { pts, timer: setTimeout(() => assert.fail("gap timer survived"), 60_000), pollTimer: setTimeout(() => assert.fail("poll timer survived"), 60_000) };
    manager.channels.set(id, value);
    manager.channelFailRetryTimers.set(id, setTimeout(() => assert.fail("retry timer survived"), 60_000));
    manager.channelFailTimeoutS.set(id, 64);
    return value;
  }
  return { client, manager, calls, tracker, mediaPrototype, managerPrototype };
}

test("import is inert and does not load the old runtime or Teleproto", () => {
  const result = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(require.resolve("./protocol-compat"))}); console.log(Object.keys(require.cache).filter(p => /teleproto|runtimeManager|channelGapBreaker|utils[/\\\\]logger/.test(p)))`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "[]");
});

test("main DC uses invoke, migration reads current session, other DC retains receiver and signal", async () => {
  const f = fixture();
  const untouched = fixture();
  const compat = installProtocolCompatibility(f.client);
  try {
    const request = {};
    assert.equal(await f.client._media.savePart(2, request), "main");
    assert.deepEqual(f.calls[0], [f.client, request]);
    const signal = new AbortController().signal;
    assert.equal(await f.client._media.savePart(3, request, signal), "native");
    assert.deepEqual(f.calls[1], [f.client._media, 3, request, signal]);
    f.client.session.dcId = 3;
    assert.equal(await f.client._media.savePart(3, request), "main");
    assert.equal(await untouched.client._media.savePart(2, request), "native");
    assert.equal(f.mediaPrototype.savePart, untouched.mediaPrototype.savePart === f.mediaPrototype.savePart ? untouched.mediaPrototype.savePart : f.mediaPrototype.savePart);
  } finally { compat.cleanup(); }
});

test("pre-cancelled main upload never invokes and RPC failures propagate unchanged", async () => {
  const f = fixture();
  const compat = installProtocolCompatibility(f.client);
  try {
    await assert.rejects(f.client._media.savePart(2, {}, AbortSignal.abort()), /Media operation aborted/);
    assert.equal(f.calls.length, 0);
    const error = new Error("rpc");
    f.client.invoke = async () => { throw error; };
    await assert.rejects(f.client._media.savePart(2, {}), e => e === error);
  } finally { compat.cleanup(); }
});

test("cleanup restores inherited and own descriptors, rejects duplicates and allows reinstall", () => {
  const f = fixture();
  Object.defineProperty(f.client._media, "savePart", { value: f.mediaPrototype.savePart, writable: false, configurable: true, enumerable: true });
  const before = Object.getOwnPropertyDescriptor(f.client._media, "savePart");
  const compat = installProtocolCompatibility(f.client);
  assert.throws(() => installProtocolCompatibility(f.client), /already installed/);
  compat.cleanup();
  compat.cleanup();
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.client._media, "savePart"), before);
  assert.equal(Object.hasOwn(f.manager, "fetchChannelDifference"), false);
  assert.equal(compat.handleLog(gap()), "pass");
  installProtocolCompatibility(f.client).cleanup();
});

test("foreign patches survive cleanup and retained wrappers become inert", async () => {
  const f = fixture();
  const compat = installProtocolCompatibility(f.client);
  const retained = f.client._media.savePart;
  const foreign = async () => "foreign";
  f.client._media.savePart = foreign;
  compat.cleanup();
  assert.equal(f.client._media.savePart, foreign);
  assert.equal(await retained.call(f.client._media, 2, {}), "native");
});

test("partial install failure rolls back the first patch and releases ownership", () => {
  const f = fixture();
  Object.preventExtensions(f.manager);
  assert.throws(() => installProtocolCompatibility(f.client), TypeError);
  assert.equal(Object.hasOwn(f.client._media, "savePart"), false);
  assert.throws(() => installProtocolCompatibility(f.client), TypeError);
});

test("two failures clear all actual tracker state and timers, including cooldown re-clear", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = fixture();
  const compat = installProtocolCompatibility(f.client);
  try {
    const tracker = f.tracker();
    assert.equal(compat.handleLog(gap()), "warn");
    assert.equal(compat.handleLog(gap()), "suppress");
    assert.equal(tracker.pts.requesting(), false);
    assert.equal(tracker.timer, undefined);
    assert.equal(tracker.pollTimer, undefined);
    assert.equal(f.manager.channels.size, 0);
    assert.equal(f.manager.channelFailRetryTimers.size, 0);
    assert.equal(f.manager.channelFailTimeoutS.size, 0);
    f.tracker();
    assert.equal(compat.handleLog(gap()), "suppress");
    assert.equal(f.manager.channels.size, 0);
    t.mock.timers.tick(60_000);
  } finally { compat.cleanup(); }
});

test("sliding window resets failures and cooldown escalates to its 72-hour cap", t => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const f = fixture();
  const compat = installProtocolCompatibility(f.client);
  const hour = 3_600_000;
  try {
    assert.equal(compat.handleLog(gap()), "warn");
    t.mock.timers.tick(hour);
    assert.equal(compat.handleLog(gap()), "warn");
    for (const hours of [6, 12, 24, 48, 72, 72]) {
      assert.equal(compat.handleLog(gap()), "suppress");
      t.mock.timers.tick(hours * hour - 1);
      assert.equal(compat.handleLog(gap()), "suppress");
      t.mock.timers.tick(1);
      assert.equal(compat.handleLog(gap()), "warn");
    }
  } finally { compat.cleanup(); }
});

for (const message of [
  "Channel 123456789 difference too long",
  "getChannelDifference (cid = 123456789) returned channelDifferenceTooLong",
  "Error recovering channel gap for 123456789: Could not find a matching Constructor ID",
  "fetchChannelDifference 123456789: Could not find a matching Constructor ID",
]) {
  test(`fatal recognition: ${message}`, t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture();
    const compat = installProtocolCompatibility(f.client);
    try {
      f.tracker();
      assert.equal(compat.handleLog({ message: `\x1b[31m${message}\x1b[0m` }), "suppress");
      assert.equal(f.manager.channels.size, 0);
    } finally { compat.cleanup(); }
  });
}

test("recognition supports Error records, unknown IDs are throttled without guessing, state stays capped", () => {
  const f = fixture();
  const compat = installProtocolCompatibility(f.client);
  try {
    assert.equal(compat.handleLog({ message: "unrelated 123456789" }), "pass");
    assert.equal(compat.handleLog({ message: "HISTORY_GET_FAILED request=123456789" }), "warn");
    assert.equal(compat.handleLog({ message: "HISTORY_GET_FAILED request=123456789" }), "suppress");
    assert.equal(compat.handleLog({ message: "fetching difference for 123456789", error: new Error("HISTORY_GET_FAILED") }), "warn");
    for (let i = 0; i < 500; i += 1) compat.handleLog(gap(String(i)));
    assert.equal(compat.handleLog(gap()), "warn", "oldest active record is evicted at the hard cap");
  } finally { compat.cleanup(); }
});

test("real installed 1.229.0 manager retry created after logging is cleared on completion", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  assert.equal(require("teleproto/package.json").version, "1.229.0");
  const client = new TelegramClient(new StringSession(""), 1, "offline-test", {});
  const manager = client.updateManager as unknown as ReturnType<typeof fixture>["manager"] & { running: boolean };
  const compat = installProtocolCompatibility(client);
  let logged = 0;
  client._log.handler = entry => { logged += 1; compat.handleLog(entry); };
  client.invoke = async () => { throw new Error("HISTORY_GET_FAILED"); };
  const pts = new PtsWaiter({ onWaitForSkipped() {}, onWaitForShortPoll() {} });
  pts.init(10);
  manager.channels.set("123456789", Object.assign({ pts }, { inputChannel: new Api.InputChannel({ channelId: returnBigInt("123456789"), accessHash: returnBigInt(1) }) }));
  manager.running = true;
  try {
    compat.handleLog(gap());
    await manager.fetchChannelDifference("123456789");
    assert.ok(logged > 0);
    assert.equal(manager.channels.size, 0);
    assert.equal(manager.channelFailRetryTimers.size, 0);
    assert.equal(manager.channelFailTimeoutS.size, 0);
    assert.equal(pts.requesting(), false);
  } finally { compat.cleanup(); manager.running = false; client.updateManager.stop(); }
});
