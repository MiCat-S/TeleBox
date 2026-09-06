import {definePlugin} from "../sdk";

const active = ["ai", "da", "dc", "dme", "gt", "ids", "ip", "nodeseek", "rate", "sum", "yvlu"];
const escape = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export default function createTpm() {
  return definePlugin({apiVersion: 1, id: "tpm", description: "查看 V2 插件状态与官方插件索引",
    commands: {tpm: {description: "列出或搜索插件", async handle(invocation, ctx) {
      const sub = invocation.args[0]?.toLowerCase() ?? "list";
      if (sub === "list" || sub === "ls") {
        await ctx.telegram.edit(invocation.message, `<b>已加载插件</b>\n${active.map(id => `• <code>${id}</code>`).join("\n")}`, {parseMode: "html"});
        return;
      }
      if (sub === "search") {
        const query = invocation.args.slice(1).join(" ").trim().toLowerCase();
        if (!query) {
          await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}tpm search 关键词`);
          return;
        }
        try {
          const data = await ctx.http.json<{items?: Array<{name?: string; description?: string}>}>(
            `https://api.github.com/search/repositories?q=${encodeURIComponent(`TeleBox ${query}`)}&per_page=5`,
            {headers: {accept: "application/vnd.github+json"}}, {timeoutMs: 5000});
          const items = (data.items ?? []).filter(item => item.name);
          await ctx.telegram.edit(invocation.message, `<b>插件搜索</b>\n${items.slice(0, 5).map(item => `• <code>${escape(item.name!)}</code> ${escape(item.description ?? "")}`).join("\n") || "没有找到结果"}`, {parseMode: "html"});
        } catch {
          await ctx.telegram.edit(invocation.message, "插件索引暂时不可用");
        }
        return;
      }
      await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}tpm list|search 关键词`);
    }}},
  });
}
