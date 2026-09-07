import {randomUUID} from "node:crypto";
import {definePlugin, type PluginContext} from "../sdk";
import {isOwner} from "../permissions";

type Receipt = {ownerId: string; chatId: string; messageId: number; requestedAt: number; bootId: string};
type RestartState = {pending: Receipt | null};

export default function createRestart(ownerId: string, shutdownSignal?: AbortSignal) {
  const bootId = randomUUID();
  let context: PluginContext | undefined;
  let submitted = false;
  const store = (ctx: PluginContext) => ctx.storage.json<RestartState>("receipt.json", {pending: null});
  const clear = (ctx: PluginContext, receipt: Receipt) => store(ctx).update(state =>
    state.pending?.bootId === receipt.bootId && state.pending.requestedAt === receipt.requestedAt
      ? {pending: null} : state);
  const readServiceStatus = async (ctx: PluginContext): Promise<string> => {
    const fields = ["LoadState", "ActiveState", "SubState", "FragmentPath"];
    const rows: string[] = [];
    for (const field of fields) {
      try {
        const value = await ctx.processes.run("/usr/bin/systemctl",
          ["show", "--value", `-p`, field, "mibot.service"],
          {timeoutMs: 1500, maxOutputBytes: 600});
        rows.push(`${field}: ${value.stdout.toString("utf8").trim() || "unknown"}`);
      } catch {
        rows.push(`${field}: unavailable`);
      }
    }
    return rows.join("<br>");
  };
  const processOwnerHint = (): string => {
    try {
      const uid = typeof process.getuid === "function" ? process.getuid() : NaN;
      return Number.isNaN(uid) ? "当前运行环境未提供用户标识。"
        : uid === 0 ? "当前运行在 root 用户。" : `当前运行用户 UID=${uid}，通常需要 root 或 systemd 管理权限。`;
    } catch {
      return "未能读取运行时用户信息。";
    }
  };
  const definition = definePlugin({apiVersion: 1, id: "restart", description: "重启 MiBot systemd 服务",
    setup(ctx) { context = ctx; },
    cleanup() { context = undefined; },
    commands: {restart: {description: "重启当前 MiBot 服务", ignoreEdited: true, async handle(invocation, ctx) {
      ctx.signal.throwIfAborted();
      if (!isOwner(invocation.message, ownerId)) {
        await ctx.telegram.edit(invocation.message, "没有重启服务的权限");
        return;
      }
      if (submitted) {
        await ctx.telegram.edit(invocation.message, "重启请求已提交，请稍候");
        return;
      }
      submitted = true;
      const receipt: Receipt = {ownerId, chatId: invocation.message.chatId, messageId: invocation.message.id,
        requestedAt: Date.now(), bootId};
      try {
        await ctx.telegram.edit(invocation.message, "<b>MiBot 重启</b>\n正在提交重启请求…", {parseMode: "html"});
        ctx.signal.throwIfAborted();
        await store(ctx).update(() => ({pending: receipt}));
      } catch (error) {
        submitted = false;
        throw error;
      }
      try {
        await ctx.processes.run("/usr/bin/systemctl", ["--no-block", "restart", "mibot.service"], {timeoutMs: 5000, maxOutputBytes: 2000});
      } catch {
        if (!ctx.signal.aborted && !shutdownSignal?.aborted) {
          submitted = false;
          await clear(ctx, receipt);
          const status = await readServiceStatus(ctx);
          await ctx.telegram.edit(invocation.message, `服务重启命令执行失败。\n状态：${status}\n` +
            `${processOwnerHint()}\n\n可执行 <code>systemctl status mibot.service --no-pager</code> 查看详情。`, {parseMode: "html"});
        }
      }
    },},},
  });
  return Object.freeze({...definition, async notifyReady(): Promise<void> {
    const ctx = context;
    if (!ctx) return;
    try {
      const {pending} = await store(ctx).read();
      if (!pending || pending.bootId === bootId) return;
      const age = Date.now() - pending.requestedAt;
      if (pending.ownerId !== ownerId || !/^-?[0-9]+$/.test(pending.chatId) ||
          !Number.isSafeInteger(pending.messageId) || pending.messageId <= 0 ||
          !Number.isFinite(age) || age < 0 || age > 10 * 60_000) {
        await clear(ctx, pending);
        return;
      }
      await ctx.telegram.edit({id: pending.messageId, chatId: pending.chatId, text: "", outgoing: true},
        "<b>MiBot 重启成功</b>\n服务已就绪", {parseMode: "html"});
      await clear(ctx, pending);
    } catch {
      if (!ctx.signal.aborted) ctx.log.error("restart.receipt_failed");
    }
  }});
}
