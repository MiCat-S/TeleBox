import os from "node:os";
import {definePlugin} from "../sdk";

export default function createStatus() {
  return definePlugin({apiVersion: 1, id: "status", description: "查看 Mi Box 运行状态",
    commands: {status: {description: "查看运行状态", async handle(invocation, ctx) {
      const memory = process.memoryUsage();
      const uptime = Math.floor(process.uptime());
      const formatUptime = (seconds: number) => {
        const days = Math.floor(seconds / 86400); seconds %= 86400;
        const hours = Math.floor(seconds / 3600); seconds %= 3600;
        const minutes = Math.floor(seconds / 60);
        return `${days}天 ${hours}小时 ${minutes}分钟`;
      };
      const total = os.totalmem() / 1048576;
      const free = os.freemem() / 1048576;
      const load = os.loadavg().map(value => value.toFixed(2)).join(" / ");
      const text = `<b>Mi Box 状态</b>\n\n` +
        `运行时间: <code>${formatUptime(uptime)}</code>\n` +
        `Node: <code>${process.version}</code>　平台: <code>${process.platform}/${process.arch}</code>\n` +
        `PID: <code>${process.pid}</code>　线程: <code>${process.versions.uv ? "Node" : "未知"}</code>\n` +
        `进程 RSS: <code>${(memory.rss / 1048576).toFixed(2)} MB</code>\n` +
        `JS Heap: <code>${(memory.heapUsed / 1048576).toFixed(2)} / ${(memory.heapTotal / 1048576).toFixed(2)} MB</code>\n` +
        `External: <code>${(memory.external / 1048576).toFixed(2)} MB</code>\n\n` +
        `系统内存: <code>${(total - free).toFixed(2)} / ${total.toFixed(2)} MB</code>\n` +
        `系统负载: <code>${load}</code>`;
      await ctx.telegram.edit(invocation.message, text, {parseMode: "html"});
    }}}
  });
}
