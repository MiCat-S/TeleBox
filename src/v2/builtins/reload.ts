import {definePlugin} from "../sdk";
import {isPrivileged} from "../permissions";

export default function createReload() {
  return definePlugin({apiVersion: 1, id: "reload", description: "重启 TeleBox systemd 服务",
    commands: {reload: {description: "重启当前 TeleBox 服务", async handle(invocation, ctx) {
      if (!await isPrivileged(invocation.message)) {
        await ctx.telegram.edit(invocation.message, "没有重启服务的权限");
        return;
      }
      await ctx.telegram.edit(invocation.message, "正在重启 TeleBox 服务...");
      try {
        await ctx.processes.run("/usr/bin/systemctl", ["restart", "telebox-v2.service"], {timeoutMs: 5000, maxOutputBytes: 2000});
      } catch {
        if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "服务重启命令执行失败");
      }
    },},},
  });
}
