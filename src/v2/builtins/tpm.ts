import path from "node:path";
import {definePlugin, type PluginContext} from "../sdk";
import type {PluginHost} from "../host";
import type {PluginReleases} from "../releases";
import {isOwner} from "../permissions";

export default function createTpm(host: PluginHost, releases: PluginReleases, root: string, ownerId: string) {
  let busy = false;
  const repository = async (ctx: PluginContext, action: string, id?: string) => {
    const result = await ctx.processes.run(process.execPath, [path.join(root, "scripts/plugin-repository.cjs"), action, ...(id ? [id] : [])],
      {timeoutMs: 90000, maxOutputBytes: 65536});
    return JSON.parse(result.stdout.toString("utf8")) as {ids?: string[]; id?: string; revision?: string};
  };
  return definePlugin({apiVersion: 1, id: "tpm", description: "安装、卸载和更新 V2 扩展插件",
    commands: {tpm: {description: "管理插件仓库中的 V2 扩展", ignoreEdited: true, async handle(invocation, ctx) {
      const [raw = "list", id] = invocation.args;
      const sub = raw.toLowerCase();
      if (sub === "list" || sub === "ls") {
        const ids = releases.snapshot().generations.filter(item => item.state === "active").map(item => item.id);
        await ctx.telegram.edit(invocation.message, `已安装扩展：${ids.join("、") || "无"}\n默认模块不计入扩展列表`);
        return;
      }
      if (!isOwner(invocation.message, ownerId)) {
        await ctx.telegram.edit(invocation.message, "只有账号所有者可以管理插件"); return;
      }
      if (busy) {await ctx.telegram.edit(invocation.message, "插件管理任务正在执行，请稍后再试"); return;}
      if (!["search", "s", "install", "i", "remove", "rm", "update"].includes(sub)) {
        await ctx.telegram.edit(invocation.message, `${invocation.prefix}tpm search [关键词]\n${invocation.prefix}tpm install|remove|update 插件名\n${invocation.prefix}tpm list`); return;
      }
      if (!["search", "s"].includes(sub) && (!id || !/^[a-z][a-z0-9_-]{0,63}$/.test(id) || invocation.args.length !== 2)) {
        await ctx.telegram.edit(invocation.message, "请提供一个有效的插件名"); return;
      }
      busy = true;
      try {
        if (sub === "search" || sub === "s") {
          await ctx.telegram.edit(invocation.message, "正在读取 V2 插件仓库…");
          const {ids} = await repository(ctx, "search");
          const query = invocation.args.slice(1).join(" ").toLowerCase();
          const matches = (ids ?? []).filter(name => /^[a-z][a-z0-9_-]{0,63}$/.test(name) &&
            name.includes(query) && !["ai", "gt"].includes(name));
          for (let start = 0; start < Math.max(matches.length, 1); start += 40) {
            const text = `可安装扩展\n${matches.slice(start, start + 40).join(" · ") || "没有匹配结果"}`;
            if (!start) await ctx.telegram.edit(invocation.message, text);
            else await ctx.telegram.reply(invocation.message, text);
          }
          return;
        }
        const installed = releases.snapshot().generations.some(item => item.id === id);
        if (host.pluginState(id) && !installed) {
          await ctx.telegram.edit(invocation.message, "默认模块由程序管理，不通过 TPM 替换或卸载"); return;
        }
        if (sub === "remove" || sub === "rm") {
          await releases.remove(id);
          await ctx.telegram.edit(invocation.message, `${id} 已卸载，配置数据已保留`);
        } else {
          await ctx.telegram.edit(invocation.message, `正在下载并构建 ${id}…`);
          const candidate = await repository(ctx, "build", id);
          if (candidate.id !== id || !candidate.revision) throw new Error("Invalid candidate");
          await releases.activate(id, candidate.revision);
          await ctx.telegram.edit(invocation.message, `${id} 已${installed ? "更新" : "安装"}并加载`);
        }
      } catch {
        if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "插件操作失败；请检查网络、V2 插件是否存在及运行日志");
      } finally {busy = false;}
    }}},
  });
}
