import assert from "node:assert/strict";
import test from "node:test";
import createRestart from "./restart";
import type {PluginContext, CommandInvocation} from "../sdk";

function fixture(options: {fail?: boolean; cancel?: boolean; editFail?: boolean} = {}) {
  const controller = new AbortController();
  const edits: string[] = [];
  const calls: unknown[][] = [];
  const ctx = {
    signal: controller.signal,
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
  return {ctx, inv, edits, calls, restore};
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
  assert.deepEqual(f.calls, [["/usr/bin/systemctl", ["--no-block", "restart", "telebox-v2.service"],
    {timeoutMs: 5000, maxOutputBytes: 2000}]]);
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
  assert.equal(f.edits.at(-1), "服务重启命令执行失败");
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
  assert.equal(f.edits.at(-1), "服务重启命令执行失败");
});
