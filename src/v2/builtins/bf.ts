import {definePlugin} from "../sdk";
import path from "node:path";
import {randomUUID} from "node:crypto";

export default function createBf(root = process.cwd()) {
  return definePlugin({apiVersion: 1, id: "bf", description: "创建 TeleBox 配置与数据备份",
    commands: {bf: {description: "打包并发送 TeleBox 备份", async handle(invocation, ctx) {
      await ctx.files.withTemp(async (temp, signal) => {
        const output = path.join(temp, `telebox-${randomUUID()}.tar.gz`);
        const entries = ["assets", ".env", "package.json"].filter(entry => entry === ".env" || entry === "package.json" || root);
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
