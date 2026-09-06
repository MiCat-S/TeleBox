import {definePlugin} from "../sdk";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {isOwner} from "../permissions";

export default function createUpdate(root = process.cwd()) {
  return definePlugin({apiVersion: 1, id: "update", description: "检查并更新 MiBot",
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
        if (!isOwner(invocation.message)) {
          await ctx.telegram.edit(invocation.message, "只有账号所有者可以更新 MiBot");
          return;
        }
        if (sub === "check") {
          const result = await ctx.processes.run("/usr/bin/git", ["-C", root, "fetch", "origin", "main"], {timeoutMs: 30000, maxOutputBytes: 4000});
          await ctx.telegram.edit(invocation.message, `<b>更新检查完成</b>\n<pre>${result.stdout.toString("utf8").slice(0, 3000)}</pre>`, {parseMode: "html"});
          return;
        }
        await ctx.telegram.edit(invocation.message, "<b>MiBot 更新</b>\n正在拉取代码、安装依赖并重新构建…", {parseMode: "html"});
        await ctx.processes.run("/usr/bin/git", ["-C", root, "pull", "--ff-only", "origin", "main"], {timeoutMs: 30000, maxOutputBytes: 8000});
        await ctx.processes.run("/usr/bin/npm", ["ci"], {cwd: root, timeoutMs: 120000, maxOutputBytes: 8000});
        await ctx.processes.run("/usr/bin/npm", ["run", "package:v2"], {cwd: root, timeoutMs: 120000, maxOutputBytes: 8000});
        await ctx.processes.run("/usr/bin/systemctl", ["--no-block", "restart", "mibot.service"], {timeoutMs: 5000, maxOutputBytes: 1000});
        return;
      }
      await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}update ver|check|run|auto`);
    }}},
  });
}
