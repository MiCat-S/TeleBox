import {definePlugin} from "../sdk";
import {isOwner} from "../permissions";

export default function createRestart(ownerId: string, shutdownSignal?: AbortSignal) {
  return definePlugin({apiVersion: 1, id: "restart", description: "重启 TeleBox systemd 服务",
    commands: {restart: {description: "重启当前 TeleBox 服务", ignoreEdited: true, async handle(invocation, ctx) {
      ctx.signal.throwIfAborted();
      if (!isOwner(invocation.message, ownerId)) {
        await ctx.telegram.edit(invocation.message, "没有重启服务的权限");
        return;
      }
      await ctx.telegram.edit(invocation.message, "<b>TeleBox 重启</b>\n正在提交重启请求…", {parseMode: "html"});
      ctx.signal.throwIfAborted();
      try {
        await ctx.processes.run("/usr/bin/systemctl", ["--no-block", "restart", "telebox-v2.service"], {timeoutMs: 5000, maxOutputBytes: 2000});
      } catch {
        if (!ctx.signal.aborted && !shutdownSignal?.aborted) {
          await ctx.telegram.edit(invocation.message, "服务重启命令执行失败");
        }
      }
    },},},
  });
}
