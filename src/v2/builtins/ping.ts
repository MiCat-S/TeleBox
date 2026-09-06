import {definePlugin, type PluginContext} from "../sdk";

function target(value: string): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(value) || value.length > 253) throw new Error("无效的目标");
  return value;
}
async function probe(ctx: PluginContext, host: string): Promise<string> {
  const started = Date.now();
  const response = await ctx.http.withResponse(`https://${host}`, {method: "HEAD"}, async response => response.status,
    {timeoutMs: 5000});
  return `${host}: HTTP ${response}，${Date.now() - started} ms`;
}
export default function createPing() {
  return definePlugin({apiVersion: 1, id: "ping", description: "网络连通性与延迟测试",
    commands: {ping: {description: "测试 Telegram 或目标地址延迟", async handle(invocation, ctx) {
      const value = invocation.args[0];
      if (value === "help" || value === "h") {
        await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}ping 测 Telegram 延迟；${invocation.prefix}ping 域名 测 HTTPS（直连）`); return;
      }
      if (!value) {
        try {
          const started = performance.now();
          await ctx.telegram.withClient(client => client.getMe());
          const apiMs = performance.now() - started;
          const editing = performance.now();
          await ctx.telegram.edit(invocation.message, "Pong!");
          await ctx.telegram.edit(invocation.message, `Pong!\nTelegram API: ${apiMs.toFixed(0)} ms\n消息编辑: ${(performance.now() - editing).toFixed(0)} ms`);
        } catch {
          if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "Telegram 延迟测试失败");
        }
        return;
      }
      try { await ctx.telegram.edit(invocation.message, `<code>${await probe(ctx, target(value))}</code>`, {parseMode: "html"}); }
      catch { if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "网络测试失败或目标不可达"); }
    }}},
  });
}
