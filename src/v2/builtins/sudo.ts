import {definePlugin} from "../sdk";
import {isOwner} from "../permissions";

interface SudoConfig extends Record<string, unknown> {users: string[];}
const defaults: SudoConfig = {users: []};

export default function createSudo() {
  return definePlugin({apiVersion: 1, id: "sudo", description: "管理可使用高级命令的用户白名单",
    commands: {sudo: {description: "添加、删除或查看授权用户", async handle(invocation, ctx) {
      if (!isOwner(invocation.message)) {
        await ctx.telegram.edit(invocation.message, "只有 owner 可以管理 sudo 白名单");
        return;
      }
      const store = ctx.storage.json<SudoConfig>("config.json", defaults);
      const sub = invocation.args[0]?.toLowerCase();
      const target = invocation.args[1];
      if (sub === "add" || sub === "del") {
        if (!target || !/^[0-9]+$/.test(target)) {
          await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}sudo ${sub} 用户 ID`);
          return;
        }
        await store.update(value => {
          const users = new Set(value.users);
          if (sub === "add") users.add(target); else users.delete(target);
          return {...value, users: [...users]};
        });
        await ctx.telegram.edit(invocation.message, `sudo 用户已${sub === "add" ? "添加" : "删除"}：<code>${target}</code>`, {parseMode: "html"});
        return;
      }
      if (sub === "ls" || sub === "list") {
        const value = await store.read();
        await ctx.telegram.edit(invocation.message, `<b>sudo 用户</b>\n${value.users.map(user => `<code>${user}</code>`).join("\n") || "暂无授权用户"}`, {parseMode: "html"});
        return;
      }
      await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}sudo add|del|ls 用户 ID`);
    }}},
  });
}
