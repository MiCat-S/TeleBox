import {definePlugin} from "../sdk";

export default function createStatus() {
  return definePlugin({apiVersion: 1, id: "status", description: "查看 TeleBox 运行状态",
    commands: {status: {description: "查看运行状态", async handle(invocation, ctx) {
      const memory = process.memoryUsage();
      const uptime = Math.floor(process.uptime());
      const text = `<b>TeleBox 状态</b>\n\n` +
        `运行时间: <code>${uptime}s</code>\n` +
        `Node: <code>${process.version}</code>\n` +
        `PID: <code>${process.pid}</code>\n` +
        `RSS: <code>${(memory.rss / 1048576).toFixed(2)} MB</code>\n` +
        `Heap: <code>${(memory.heapUsed / 1048576).toFixed(2)} MB</code>`;
      await ctx.telegram.edit(invocation.message, text, {parseMode: "html"});
    }}}
  });
}
