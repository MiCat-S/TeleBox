import {definePlugin} from "../sdk";

export default function createAgent() {
  return definePlugin({apiVersion: 1, id: "agent", description: "调用已加载的 AI 服务进行对话",
    commands: {agent: {description: "向 AI 提问，可回复消息提供上下文", async handle(invocation, ctx) {
      const prompt = invocation.args.join(" ").trim();
      if (!prompt) {
        await ctx.telegram.edit(invocation.message, `用法：${invocation.prefix}agent 你的问题\n也可以回复一条消息后提问`);
        return;
      }
      if (!ctx.services.available("ai", "chat")) {
        await ctx.telegram.edit(invocation.message, "AI 服务当前不可用");
        return;
      }
      const reply = await ctx.telegram.getReply(invocation.message);
      const context = reply?.text ? `\n\n引用消息：\n${reply.text}` : "";
      try {
        const result = await ctx.services.call<{text?: string}>("ai", "chat", {prompt: prompt + context}, ctx.signal);
        await ctx.telegram.edit(invocation.message, result?.text?.trim() || "AI 未返回内容");
      } catch {
        if (!ctx.signal.aborted) await ctx.telegram.edit(invocation.message, "AI 请求失败，请稍后重试");
      }
    }}},
  });
}
