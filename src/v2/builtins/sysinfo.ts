import os from "node:os";
import {definePlugin} from "../sdk";

const mb = (value: number): string => (value / 1048576).toFixed(2);
const uptime = (value: number): string => {
  const days = Math.floor(value / 86400);
  const hours = Math.floor(value / 3600) % 24;
  const minutes = Math.floor(value / 60) % 60;
  return `${days}天 ${hours}小时 ${minutes}分钟`;
};

export default function createSysinfo() {
  return definePlugin({apiVersion: 1, id: "sysinfo", description: "查看主机系统、资源与 Mi Box 运行信息",
    commands: {sysinfo: {description: "查看详细系统信息", async handle(invocation, ctx) {
      const memory = process.memoryUsage();
      const total = os.totalmem();
      const free = os.freemem();
      const lines = [
        "<b>系统信息</b>", "",
        `主机: <code>${os.hostname()}</code>`,
        `系统: <code>${os.platform()} ${os.arch()}</code>`,
        `内核: <code>${os.release()}</code>`,
        `运行时间: <code>${uptime(os.uptime())}</code>`,
        `负载: <code>${os.loadavg().map(value => value.toFixed(2)).join(" / ")}</code>`,
        `CPU: <code>${os.cpus().length} 核</code>`,
        `系统内存: <code>${mb(total - free)} / ${mb(total)} MB</code>`, "",
        "<b>Mi Box 进程</b>",
        `Node: <code>${process.version}</code>`,
        `PID: <code>${process.pid}</code>`,
        `RSS: <code>${mb(memory.rss)} MB</code>`,
        `Heap: <code>${mb(memory.heapUsed)} / ${mb(memory.heapTotal)} MB</code>`,
        `External: <code>${mb(memory.external)} MB</code>`,
      ];
      await ctx.telegram.edit(invocation.message, lines.join("\n"), {parseMode: "html"});
    }}}
  });
}
