import {definePlugin} from "../sdk";
import {isOwner} from "../permissions";

interface SureConfig extends Record<string, unknown> {users: string[]; chats: string[]; messages: Record<string, string>;}
const defaults: SureConfig = {users: [], chats: [], messages: {}};

export default function createSure() {
  return definePlugin({apiVersion: 1, id: "sure", description: "管理 bot 代发消息的白名单规则",
    commands: {sure: {description: "维护代发用户、对话和消息白名单", async handle(invocation, ctx) {
      if (!isOwner(invocation.message)) {
        await ctx.telegram.edit(invocation.message, "只有 owner 可以管理 sure 白名单");
        return;
      }
      const store = ctx.storage.json<SureConfig>("config.json", defaults);
      const [scope, action, value] = invocation.args;
      if (scope === "user" || scope === "chat") {
        if ((action !== "add" && action !== "del") || !value || !/^[0-9]+$/.test(value)) {
          await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}sure user|chat add|del ID`);
          return;
        }
        await store.update(current => {
          const key = scope === "user" ? "users" : "chats";
          const values = new Set(current[key]);
          if (action === "add") values.add(value); else values.delete(value);
          return {...current, [key]: [...values]};
        });
        await ctx.telegram.edit(invocation.message, `sure ${scope} 已${action === "add" ? "添加" : "删除"}：<code>${value}</code>`, {parseMode: "html"});
        return;
      }
      if (scope === "msg" && action === "add" && value) {
        await store.update(current => ({...current, messages: {...current.messages, [value]: value}}));
        await ctx.telegram.edit(invocation.message, "sure 消息规则已添加");
        return;
      }
      if (scope === "ls" || scope === "list") {
        const current = await store.read();
        await ctx.telegram.edit(invocation.message,
          `<b>sure 白名单</b>\n用户：${current.users.length}\n对话：${current.chats.length}\n消息规则：${Object.keys(current.messages).length}`, {parseMode: "html"});
        return;
      }
      await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}sure user|chat|msg add|del ...`);
    }}},
  });
}
