import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {JsonStore} from "../storage";
import createRestart from "./restart";
import type {PluginContext, CommandInvocation} from "../sdk";

function fixture(options: {fail?: boolean; cancel?: boolean; editFail?: boolean} = {}) {
  const controller = new AbortController();
  const edits: string[] = [];
  const calls: unknown[][] = [];
  let state: Record<string, unknown> = {pending: null};
  const errors: string[] = [];
  const ctx = {
    signal: controller.signal,
    storage: {json: () => ({
      read: async () => structuredClone(state),
      update: async (fn: (value: Record<string, unknown>) => Record<string, unknown>) => {
        state = structuredClone(fn(structuredClone(state)));
        return structuredClone(state);
      },
    })},
    log: {error: (event: string) => errors.push(event)},
    telegram: {async edit(_message: unknown, text: string) {
      if (options.editFail) throw new Error("transport failed");
      edits.push(text);
      if (options.cancel) controller.abort();
    }},
    processes: {async run(...args: unknown[]) {
      calls.push(args);
      if (options.fail) throw new Error("private internal error");
    }},
  } as unknown as PluginContext;
  const owner = process.env.TB_OWNER_ID;
  delete process.env.TB_OWNER_ID;
  const restore = () => {
    if (owner === undefined) delete process.env.TB_OWNER_ID;
    else process.env.TB_OWNER_ID = owner;
  };
  const inv: CommandInvocation = {command: "restart", args: [], prefix: ".",
    message: {id: 1, chatId: "123", senderId: "123", outgoing: true, text: ".restart"}};
  return {ctx, inv, edits, calls, restore, errors, state: () => state};
}
test("restart is the sole command and ignores edited messages", () => {
  const plugin = createRestart("123");
  assert.equal(plugin.id, "restart");
  assert.deepEqual(Object.keys(plugin.commands), ["restart"]);
  assert.equal(plugin.commands.restart.ignoreEdited, true);
});
test("owner submits a fixed nonblocking systemd service restart", async t => {
  const f = fixture(); t.after(f.restore);
  await createRestart("123").commands.restart.handle(f.inv, f.ctx);
  assert.deepEqual(f.calls, [["/usr/bin/systemctl", ["--no-block", "restart", "mibot.service"],
    {timeoutMs: 5000, maxOutputBytes: 2000}]]);
  assert.match(f.edits[0], /MiBot 重启/);
  assert.match(f.edits[0], /正在提交重启请求/);
});
test("non-owner cannot restart the service", async t => {
  const f = fixture(); t.after(f.restore);
  await createRestart("123").commands.restart.handle({...f.inv, message: {...f.inv.message, senderId: "999"}}, f.ctx);
  assert.equal(f.calls.length, 0);
  assert.match(f.edits[0], /没有.*权限/);
});
test("cancellation after the notice prevents spawning", async t => {
  const f = fixture({cancel: true}); t.after(f.restore);
  await assert.rejects(() => Promise.resolve(createRestart("123").commands.restart.handle(f.inv, f.ctx)));
  assert.equal(f.calls.length, 0);
});
test("failed notice prevents restarting", async t => {
  const f = fixture({editFail: true}); t.after(f.restore);
  await assert.rejects(() => Promise.resolve(createRestart("123").commands.restart.handle(f.inv, f.ctx)));
  assert.equal(f.calls.length, 0);
});
test("process failures produce a sanitized message", async t => {
  const f = fixture({fail: true}); t.after(f.restore);
  await createRestart("123").commands.restart.handle(f.inv, f.ctx);
  assert.match(f.edits.at(-1), /^服务重启命令执行失败/);
  assert.doesNotMatch(f.edits.join(""), /private/);
});
test("environment owner cannot override authenticated account identity", async t => {
  const f = fixture(); t.after(f.restore);
  process.env.TB_OWNER_ID = "999";
  await createRestart("123").commands.restart.handle({...f.inv, message: {...f.inv.message, senderId: "999"}}, f.ctx);
  assert.equal(f.calls.length, 0);
  await createRestart("123").commands.restart.handle(f.inv, f.ctx);
  assert.equal(f.calls.length, 1);
});
test("missing sender identity cannot restart even on outgoing messages", async t => {
  const f = fixture(); t.after(f.restore);
  await createRestart("123").commands.restart.handle({...f.inv, message: {...f.inv.message, senderId: undefined}}, f.ctx);
  assert.equal(f.calls.length, 0);
});
test("runtime shutdown suppresses process failure while plugin scope is still active", async t => {
  const f = fixture(); t.after(f.restore);
  const shutdown = new AbortController();
  f.ctx.processes.run = async () => {
    shutdown.abort();
    throw new Error("helper terminated during service shutdown");
  };
  await createRestart("123", shutdown.signal).commands.restart.handle(f.inv, f.ctx);
  assert.equal(f.ctx.signal.aborted, false);
  assert.equal(f.edits.length, 1);
  assert.doesNotMatch(f.edits.join(""), /失败/);
});
test("process failure remains visible when runtime shutdown has not started", async t => {
  const f = fixture({fail: true}); t.after(f.restore);
  await createRestart("123", new AbortController().signal).commands.restart.handle(f.inv, f.ctx);
  assert.match(f.edits.at(-1), /^服务重启命令执行失败/);
  assert.equal(f.state().pending, null);
});
test("new runtime edits the original message once after readiness", async t => {
  const f = fixture(); t.after(f.restore);
  const first = createRestart("123");
  await first.setup!(f.ctx);
  await first.commands.restart.handle(f.inv, f.ctx);
  assert.ok(f.state().pending);
  await first.notifyReady();
  assert.equal(f.edits.length, 1);
  const next = createRestart("123");
  await next.setup!(f.ctx);
  const targets: unknown[] = [];
  f.ctx.telegram.edit = async (message, text) => {targets.push(message); f.edits.push(text);};
  await next.notifyReady();
  assert.match(f.edits.at(-1)!, /MiBot 重启成功/);
  assert.deepEqual(targets, [{id: 1, chatId: "123", text: "", outgoing: true}]);
  assert.equal(f.state().pending, null);
  await next.notifyReady();
  assert.equal(targets.length, 1);
});
test("duplicate restart cannot overwrite receipt or spawn twice", async t => {
  const f = fixture(); t.after(f.restore);
  const plugin = createRestart("123");
  await plugin.commands.restart.handle(f.inv, f.ctx);
  await plugin.commands.restart.handle({...f.inv, message: {...f.inv.message, id: 2}}, f.ctx);
  assert.equal(f.calls.length, 1);
  assert.equal((f.state().pending as {messageId: number}).messageId, 1);
});
test("storage failure prevents submitting restart", async t => {
  const f = fixture(); t.after(f.restore);
  f.ctx.storage.json = () => {throw new Error("storage unavailable");};
  await assert.rejects(() => Promise.resolve(createRestart("123").commands.restart.handle(f.inv, f.ctx)));
  assert.equal(f.calls.length, 0);
});
test("expired receipts and different owners do not receive success", async t => {
  for (const mode of ["expired", "owner"]) {
    const f = fixture(); t.after(f.restore);
    await createRestart("123").commands.restart.handle(f.inv, f.ctx);
    if (mode === "expired") (f.state().pending as {requestedAt: number}).requestedAt -= 11 * 60_000;
    const next = createRestart(mode === "owner" ? "456" : "123");
    await next.setup!(f.ctx);
    await next.notifyReady();
    assert.equal(f.edits.length, 1);
    assert.equal(f.state().pending, null);
  }
});
test("receipt delivery failure is logged without failing runtime readiness", async t => {
  const f = fixture(); t.after(f.restore);
  await createRestart("123").commands.restart.handle(f.inv, f.ctx);
  const next = createRestart("123");
  await next.setup!(f.ctx);
  f.ctx.telegram.edit = async () => {throw new Error("private transport details");};
  await next.notifyReady();
  assert.deepEqual(f.errors, ["restart.receipt_failed"]);
  assert.ok(f.state().pending);
});
test("receipt survives closing and reopening real JSON storage", async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "telebox-restart-")));
  const stores: JsonStore<Record<string, unknown>>[] = [];
  t.after(async () => {
    for (const store of stores) await store.close();
    await rm(root, {recursive: true, force: true});
  });
  const f = fixture(); t.after(f.restore);
  const open = () => {
    const store = new JsonStore<Record<string, unknown>>(path.join(root, "receipt.json"), {pending: null});
    stores.push(store);
    f.ctx.storage.json = (() => store) as PluginContext["storage"]["json"];
    return store;
  };
  const firstStore = open();
  const first = createRestart("123");
  await first.setup!(f.ctx);
  await first.commands.restart.handle(f.inv, f.ctx);
  await first.cleanup!(f.ctx);
  await firstStore.close();
  const secondStore = open();
  assert.ok((await secondStore.read()).pending);
  const second = createRestart("123");
  await second.setup!(f.ctx);
  await second.notifyReady();
  assert.match(f.edits.at(-1)!, /重启成功/);
  assert.equal((await secondStore.read()).pending, null);
});
