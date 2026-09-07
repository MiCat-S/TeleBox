import assert from "node:assert/strict";
import test from "node:test";
import createUpdate from "./update";
import type {CommandInvocation, MessageEnvelope, PluginContext} from "../sdk";

type RunResult = {stdout?: string; stderr?: string; exitCode?: number; error?: unknown};

function fixture(outputs: RunResult[] = [], options: {sender?: string} = {}) {
  const controller = new AbortController();
  const calls: string[][] = [];
  const edits: string[] = [];
  let step = 0;
  const originalGetuid = process.getuid;
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");

  const ctx = {
    signal: controller.signal,
    tasks: {
      run: async () => Promise.resolve(),
    } as unknown as PluginContext["tasks"],
    storage: {json: () => ({
      read: async () => ({pending: null}),
      update: async (fn: (value: {pending: null}) => {pending: null | {ownerId: string; chatId: string; messageId: number; requestedAt: number; bootId: string}}) => {
        const current = {pending: null};
        return fn(current);
      },
    })},
    log: {error: () => {}, info: () => {}},
    processes: {
      async run(command: string, args?: readonly string[], _options?: {maxOutputBytes?: number; timeoutMs?: number}) {
        calls.push([command, ...(args ?? [])]);
        const current = outputs[step++];
        if (!current) return {stdout: Buffer.from(""), stderr: Buffer.from(""), exitCode: 0};
        if (current.error) throw current.error;
        return {stdout: Buffer.from(current.stdout ?? ""), stderr: Buffer.from(current.stderr ?? ""), exitCode: current.exitCode ?? 0};
      },
    },
    jobs: {register: () => Promise.resolve(async () => undefined)},
    services: {available: () => false, call: () => Promise.resolve(undefined)},
    http: {withResponse: async () => ({status: 200, headers: new Headers(), body: ""}),
      text: async () => "", json: async () => ({}),
    },
    files: {dataPath: "", dataDirectory: "", dataFile: () => "", withTemp: () => Promise.resolve(undefined)},
    telegram: {
      async edit(_message: MessageEnvelope, text: string) { edits.push(text); },
      async reply(_message: MessageEnvelope, text: string) { edits.push(text); },
      async invoke() { return undefined; },
      async getReply() { return undefined; },
      async withClient() { return undefined as never; },
    },
  } as unknown as PluginContext;

  const invocation: CommandInvocation = {
    command: "update",
    args: ["run"],
    prefix: ".",
    message: {id: 1, chatId: "123", senderId: options.sender ?? "123", outgoing: true, text: ".update"},
  };

  return {
    ctx,
    inv: invocation,
    calls,
    edits,
    restore: () => {
      if (originalDescriptor) {
        Object.defineProperty(process, "getuid", originalDescriptor);
      } else {
        Object.defineProperty(process, "getuid", {value: originalGetuid, configurable: true});
      }
    },
  };
}

test("非所有者无法发起更新", async (t) => {
  const f = fixture([], {sender: "999"});
  t.after(f.restore);
  await createUpdate(undefined, "123").commands.update.handle(f.inv, f.ctx);
  assert.match(f.edits[0], /只有账号所有者/);
  assert.equal(f.calls.length, 0);
});

test("非 root 环境会给出明确的权限提示", async (t) => {
  const f = fixture([]);
  t.after(f.restore);
  Object.defineProperty(process, "getuid", {value: () => 1000, configurable: true});
  await createUpdate(undefined, "123").commands.update.handle(f.inv, f.ctx);
  assert.match(f.edits.at(-1)!, /当前进程 UID=1000/);
  assert.match(f.edits.at(-1)!, /无法直接发起 systemd 服务更新/);
  assert.equal(f.calls.length, 0);
});

test("更新服务未正确加载会直接提示修复", async (t) => {
  const f = fixture([
    // 默认加载状态检查：LoadState 等 7 个字段
    {stdout: "error"}, {stdout: "inactive"}, {stdout: "not-found"}, {stdout: "dead"}, {stdout: "no"},
    {stdout: "unknown"}, {stdout: "unavailable"},
  ]);
  t.after(f.restore);
  Object.defineProperty(process, "getuid", {value: () => 0, configurable: true});
  await createUpdate(undefined, "123").commands.update.handle(f.inv, f.ctx);
  assert.match(f.edits.at(-1)!, /MiBot 更新失败/);
});

test("启动服务后若立即失败，立即返回失败并给出日志定位建议", async (t) => {
  const f = fixture([
    {stdout: "loaded"}, {stdout: "inactive"}, {stdout: "enabled"}, {stdout: "dead"}, {stdout: "yes"},
    {stdout: "/etc/systemd/system/mibot-update.service"}, {stdout: "success"},
    {stdout: "failed"},
    {stdout: "active"},
    {stdout: "loaded"},
    {stdout: "inactive"},
    {stdout: "failed"},
    {stdout: "dead"},
    {stdout: "/etc/systemd/system/mibot-update.service"},
  ]);
  t.after(f.restore);
  Object.defineProperty(process, "getuid", {value: () => 0, configurable: true});
  await createUpdate(undefined, "123").commands.update.handle(f.inv, f.ctx);
  assert.match(f.edits.at(-1)!, /MiBot 更新失败|启动后立即退出/);
  assert.match(f.edits.at(-1)!, /journalctl -u mibot-update.service/);
});
