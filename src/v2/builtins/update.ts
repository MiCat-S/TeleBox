import {definePlugin, type PluginContext} from "../sdk";
import {randomUUID} from "node:crypto";
import {readFile, unlink} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import path from "node:path";
import {isOwner} from "../permissions";

type Receipt = {ownerId: string; chatId: string; messageId: number; requestedAt: number; bootId: string};
type UpdateState = {pending: Receipt | null};

export default function createUpdate(root = process.cwd(), ownerId?: string) {
  const bootId = randomUUID();
  let context: PluginContext | undefined;
  let submitted = false;
  const store = (ctx: PluginContext) => ctx.storage.json<UpdateState>("update-receipt.json", {pending: null});
  const resultFile = path.join(root, "temp", "update-result.json");
  const clear = (ctx: PluginContext, receipt: Receipt) => store(ctx).update(state =>
    state.pending?.bootId === receipt.bootId && state.pending.requestedAt === receipt.requestedAt
      ? {pending: null} : state);
  const reportFailure = async (ctx: PluginContext, receipt: Receipt, text: string): Promise<void> => {
    await ctx.telegram.edit({id: receipt.messageId, chatId: receipt.chatId, text: "", outgoing: true}, text, {parseMode: "html"});
    await clear(ctx, receipt);
    try { await unlink(resultFile); } catch {}
  };
  const watchResult = (ctx: PluginContext, receipt: Receipt): void => {
    void ctx.tasks.run("update:result", async signal => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        signal.throwIfAborted();
        try {
          const result = JSON.parse(await readFile(resultFile, "utf8")) as {status?: unknown};
          if (result.status === "failed") {
            await reportFailure(ctx, receipt, "<b>MiBot 更新失败</b>\n更新任务未完成，服务保持当前版本。请稍后重试或查看服务器日志。");
            return;
          }
        } catch {}
        await delay(1000, undefined, {signal});
      }
    });
  };
  const definition = definePlugin({apiVersion: 1, id: "update", description: "检查并更新 MiBot",
    setup(ctx) { context = ctx; },
    cleanup() { context = undefined; },
    commands: {update: {description: "查看版本与自动更新状态", async handle(invocation, ctx) {
      const sub = invocation.args[0]?.toLowerCase() ?? "run";
      if (sub === "ver" || sub === "version") {
        let version = "未知";
        try { version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version ?? version; } catch {}
        await ctx.telegram.edit(invocation.message, `<b>更新状态</b>\n当前版本：<code>${version}</code>\n更新操作暂未开放`, {parseMode: "html"});
        return;
      }
      if (sub === "auto") {
        const store = ctx.storage.json<{enabled: boolean}>("config.json", {enabled: false});
        const action = invocation.args[1]?.toLowerCase();
        if (action === "on" || action === "off") {
          await store.update(value => ({...value, enabled: action === "on"}));
        }
        const current = await store.read();
        await ctx.telegram.edit(invocation.message,
          `自动更新：<b>${current.enabled ? "开启" : "关闭"}</b>\n当前仅保存开关状态，不会在后台自动执行`, {parseMode: "html"});
        return;
      }
      if (sub === "run" || sub === "now" || sub === "check") {
        if (!isOwner(invocation.message, ownerId)) {
          await ctx.telegram.edit(invocation.message, "只有账号所有者可以更新 MiBot");
          return;
        }
        if (sub === "check") {
          const result = await ctx.processes.run("/usr/bin/git", ["-C", root, "fetch", "origin", "main"], {timeoutMs: 30000, maxOutputBytes: 4000});
          await ctx.telegram.edit(invocation.message, `<b>更新检查完成</b>\n<pre>${result.stdout.toString("utf8").slice(0, 3000)}</pre>`, {parseMode: "html"});
          return;
        }
        const receipt: Receipt = {ownerId: ownerId ?? "", chatId: invocation.message.chatId,
          messageId: invocation.message.id, requestedAt: Date.now(), bootId};
        await ctx.telegram.edit(invocation.message, "<b>MiBot 更新</b>\n正在更新代码、依赖和插件…", {parseMode: "html"});
        await store(ctx).update(() => ({pending: receipt}));
        try {
          await ctx.processes.run("/usr/bin/test", ["-f", "/etc/systemd/system/mibot-update.service"],
            {timeoutMs: 3000, maxOutputBytes: 2000});
          await ctx.processes.run("/usr/bin/systemctl", ["daemon-reload"], {timeoutMs: 5000, maxOutputBytes: 2000});
          await ctx.processes.run("/usr/bin/systemctl", ["start", "--no-block", "mibot-update.service"],
            {timeoutMs: 5000, maxOutputBytes: 2000});
          submitted = true;
        } catch (error) {
          await reportFailure(ctx, receipt, "<b>MiBot 更新失败</b>\n无法启动更新任务，请先确认 /etc/systemd/system/mibot-update.service 存在。\n执行：<code>systemctl status mibot-update.service --no-pager</code>\n并贴日志继续排障。");
          return;
        }
        watchResult(ctx, receipt);
        return;
      }
      await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}update ver|check|run|auto`);
    }}},
  });
  return Object.freeze({...definition, async notifyReady(): Promise<void> {
    const ctx = context;
    if (!ctx || submitted) return;
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
      let status: "success" | "failed" | undefined;
      try {
        const result = JSON.parse(await readFile(resultFile, "utf8")) as {status?: unknown};
        if (result.status === "success" || result.status === "failed") status = result.status;
      } catch {}
      if (!status) return;
      await ctx.telegram.edit({id: pending.messageId, chatId: pending.chatId, text: "", outgoing: true},
        status === "success" ? "<b>MiBot 更新成功</b>\n代码、依赖和插件已更新，服务已重新上线。"
          : "<b>MiBot 更新失败</b>\n服务保持当前版本，请查看 <code>.update check</code> 或服务器日志。", {parseMode: "html"});
      await clear(ctx, pending);
      try { await unlink(resultFile); } catch {}
    } catch {
      if (!ctx.signal.aborted) ctx.log.error("update.receipt_failed");
    }
  }});
}
