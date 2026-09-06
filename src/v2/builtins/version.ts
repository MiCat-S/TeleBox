import {readFile} from "node:fs/promises";
import path from "node:path";
import {definePlugin} from "../sdk";

async function packageVersion(root: string): Promise<string> {
  try {
    const value = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {version?: string};
    return value.version ?? "未知";
  } catch {
    return "未知";
  }
}

export default function createVersion(root = process.cwd()) {
  return definePlugin({apiVersion: 1, id: "version", description: "查看 TeleBox 与运行环境版本",
    commands: {version: {description: "查看版本信息", async handle(invocation, ctx) {
      const text = [
        "<b>TeleBox 版本</b>", "",
        `TeleBox: <code>${await packageVersion(root)}</code>`,
        `Node.js: <code>${process.version}</code>`,
        `平台: <code>${process.platform}/${process.arch}</code>`,
        `PID: <code>${process.pid}</code>`,
      ].join("\n");
      await ctx.telegram.edit(invocation.message, text, {parseMode: "html"});
    }}, ver: {description: "version 的简写", async handle(invocation, ctx) {
      const text = `<b>TeleBox 版本</b>\nNode.js: <code>${process.version}</code>\n平台: <code>${process.platform}/${process.arch}</code>`;
      await ctx.telegram.edit(invocation.message, text, {parseMode: "html"});
    }}},
  });
}
