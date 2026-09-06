import {definePlugin} from "../sdk";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {isPrivileged} from "../permissions";
import {existsSync} from "node:fs";

export default function createBf(root = process.cwd()) {
  return definePlugin({apiVersion: 1, id: "bf", description: "创建 TeleBox 配置与数据备份",
    commands: {bf: {description: "打包并发送 TeleBox 备份", async handle(invocation, ctx) {
      if (!await isPrivileged(invocation.message)) {
        await ctx.telegram.edit(invocation.message, "没有创建备份的权限");
        return;
      }
      await ctx.files.withTemp(async (temp, signal) => {
        const output = path.join(temp, `telebox-${randomUUID()}.tar.gz`);
        const entries = ["assets", ".env", "package.json"].filter(entry => existsSync(path.join(root, entry)));
        if (!entries.length) throw new Error("没有可备份的文件");
        await ctx.processes.run("/usr/bin/tar", ["-czf", output, "-C", root, ...entries], {
          timeoutMs: 30000, maxOutputBytes: 2000,
        });
        await ctx.telegram.withClient(async client => {
          const raw = invocation.message.raw as {peerId: unknown};
          await client.sendFile(raw.peerId as never, {file: output, caption: "TeleBox 备份"});
        });
        await ctx.telegram.edit(invocation.message, "备份已生成并发送");
      });
    }}},
  });
}
