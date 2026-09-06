import {definePlugin} from "../sdk";
import {existsSync} from "node:fs";
import path from "node:path";

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default function createExec() {
  return definePlugin({apiVersion: 1, id: "exec", description: "受控执行系统命令",
    commands: {exec: {description: "执行一个非 shell 系统命令", async handle(invocation, ctx) {
      const [file, ...args] = invocation.args;
      if (!file) {
        await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}exec 命令 参数...`);
        return;
      }
      if (!/^[A-Za-z0-9_./:-]+$/.test(file) || file.length > 160) {
        await ctx.telegram.edit(invocation.message, "命令路径包含不允许的字符");
        return;
      }
      const executable = path.isAbsolute(file) ? file :
        ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(dir => path.join(dir, file)).find(existsSync);
      if (!executable) {
        await ctx.telegram.edit(invocation.message, "找不到该系统命令");
        return;
      }
      try {
        const result = await ctx.processes.run(executable, args, {timeoutMs: 15000, maxOutputBytes: 12000});
        const output = `${result.stdout.toString("utf8")}${result.stderr.toString("utf8")}`.trim() || "(无输出)";
        await ctx.telegram.edit(invocation.message, `<pre>${escape(output.slice(0, 3500))}</pre>`, {parseMode: "html"});
      } catch {
        if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "命令执行失败、超时或输出过大");
      }
    }}},
  });
}
