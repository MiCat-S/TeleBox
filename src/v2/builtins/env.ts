import {definePlugin} from "../sdk";

const visible = new Set(["NODE_ENV", "TB_PREFIX", "TB_CMD_IGNORE_EDITED", "TB_LISTENER_HANDLE_EDITED"]);
export default function createEnv() {
  return definePlugin({apiVersion: 1, id: "env", description: "查看安全的运行环境配置",
    commands: {env: {description: "查看运行环境", async handle(invocation, ctx) {
      const name = invocation.args[0];
      const rows = [...visible].filter(key => !name || key === name).map(key => `${key}=${process.env[key] ?? "未设置"}`);
      await ctx.telegram.edit(invocation.message, `<code>${rows.join("\n") || "无可显示配置"}</code>`, {parseMode: "html"});
    }}}
  });
}
