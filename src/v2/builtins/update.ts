import {definePlugin} from "../sdk";
import {readFile} from "node:fs/promises";
import path from "node:path";

export default function createUpdate(root = process.cwd()) {
  return definePlugin({apiVersion: 1, id: "update", description: "查看 TeleBox 更新状态",
    commands: {update: {description: "查看版本与自动更新状态", async handle(invocation, ctx) {
      const sub = invocation.args[0]?.toLowerCase() ?? "ver";
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
          `自动更新：<b>${current.enabled ? "开启" : "关闭"}</b>\nV2 当前仅记录状态，不会自动拉取或安装代码`, {parseMode: "html"});
        return;
      }
      await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}update ver|auto`);
    }}},
  });
}
