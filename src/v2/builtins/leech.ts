import {definePlugin} from "../sdk";

export default function createLeech() {
  return definePlugin({apiVersion: 1, id: "leech", description: "历史消息归档与抓取工具",
    commands: {leech: {description: "查看归档状态和数据库信息", async handle(invocation, ctx) {
      const sub = invocation.args[0]?.toLowerCase() ?? "help";
      if (sub === "help" || sub === "h") {
        await ctx.telegram.edit(invocation.message,
          `用法：${invocation.prefix}leech session|stats|db\n历史抓取功能正在迁移中`);
        return;
      }
      const db = ctx.storage.sqlite("leech.sqlite");
      if (sub === "db") {
        await ctx.telegram.edit(invocation.message, "Leech 数据库已启用：<code>assets/leech.sqlite</code>", {parseMode: "html"});
        return;
      }
      if (sub === "stats") {
        const result = await db.read(connection => {
          const tables = connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{name: string}>;
          return tables.map(table => {
            const name = table.name.replace(/"/g, "\"\"");
            const row = connection.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as {count: number};
            return `${table.name}: ${row.count}`;
          });
        });
        await ctx.telegram.edit(invocation.message, `<b>Leech 统计</b>\n${result.join("\n") || "暂无数据"}`, {parseMode: "html"});
        return;
      }
      if (sub === "session") {
        const me = await ctx.telegram.withClient(client => client.getMe());
        await ctx.telegram.edit(invocation.message, `<b>Telegram 会话正常</b>\n账号：<code>${String((me as {id?: unknown})?.id ?? "unknown")}</code>`, {parseMode: "html"});
        return;
      }
      await ctx.telegram.edit(invocation.message, "未知子命令，请使用 .leech help");
    }}},
  });
}
