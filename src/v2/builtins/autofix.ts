import {definePlugin} from "../sdk";

const output = (value: {stdout: Buffer; stderr: Buffer}): string =>
  `${value.stdout.toString("utf8")}${value.stderr.toString("utf8")}`.trim().slice(0, 1200);

export default function createAutofix(root = process.cwd()) {
  return definePlugin({apiVersion: 1, id: "autofix", description: "诊断 Mi Box 服务、代码和插件状态",
    commands: {autofix: {description: "只读检查可修复项目", async handle(invocation, ctx) {
      try {
        const [git, service] = await Promise.all([
          ctx.processes.run("/usr/bin/git", ["-C", root, "status", "--short", "--branch"], {timeoutMs: 5000, maxOutputBytes: 3000}),
          ctx.processes.run("/usr/bin/systemctl", ["is-active", "telebox-v2.service"], {timeoutMs: 5000, maxOutputBytes: 1000}),
        ]);
        await ctx.telegram.edit(invocation.message,
          `<b>Autofix 诊断</b>\n\nGit：<pre>${output(git) || "无输出"}</pre>\n服务：<code>${output(service) || "未知"}</code>\n\n当前为只读诊断，未执行修复。`,
          {parseMode: "html"});
      } catch {
        if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "Autofix 诊断失败，未执行任何修改");
      }
    }}},
  });
}
