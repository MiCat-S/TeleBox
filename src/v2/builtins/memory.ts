import {definePlugin, type PluginContext} from "../sdk";

interface MemoryConfig extends Record<string, unknown> {enabled: boolean; heap: number; rss: number; silent: boolean; baselineHeap?: number; baselineRss?: number;}
const defaults: MemoryConfig = {enabled: false, heap: 150, rss: 512, silent: false};

function snapshot() {
  const value = process.memoryUsage();
  return {heap: value.heapUsed / 1048576, heapTotal: value.heapTotal / 1048576,
    rss: value.rss / 1048576, external: value.external / 1048576,
    arrayBuffers: value.arrayBuffers / 1048576};
}
function html(value: number): string {return value.toFixed(2);}
function report(config: MemoryConfig): string {
  const m = snapshot();
  const level = m.rss > config.rss || m.heap > config.heap ? "偏高" : "正常";
  const heapPercent = m.heapTotal > 0 ? (m.heap / m.heapTotal) * 100 : 0;
  const baseline = config.baselineRss === undefined ? "" :
    `\nRSS 变化: <code>${m.rss >= config.baselineRss ? "+" : ""}${html(m.rss - config.baselineRss)} MB</code>`;
  return `<b>内存状态</b>\n\n` +
    `RSS（进程总占用）: <code>${html(m.rss)} / ${config.rss} MB</code>\n` +
    `Heap（JS 已用）: <code>${html(m.heap)} / ${html(m.heapTotal)} MB</code>　<code>${html(heapPercent)}%</code>\n` +
    `External（原生内存）: <code>${html(m.external)} MB</code>\n` +
    `ArrayBuffer（缓冲区）: <code>${html(m.arrayBuffers)} MB</code>\n` +
    `状态: <b>${level}</b>\n` +
    `基线 RSS: <code>${config.baselineRss === undefined ? "未设置" : html(config.baselineRss) + " MB"}</code>${baseline}\n` +
    `自动保护: <b>${config.enabled ? "开启" : "关闭"}</b>`;
}
function parsePositive(value: string | undefined): number | undefined {
  const number = Number(value); return Number.isFinite(number) && number > 0 ? number : undefined;
}
async function configOf(ctx: PluginContext) {
  return ctx.storage.json<MemoryConfig>("config.json", defaults);
}
export default function createMemory() {
  return definePlugin({apiVersion: 1, id: "memory", description: "内存快照与自动保护",
    commands: {memory: {description: "查看内存与系统状态", async handle(invocation, ctx) {
      const store = await configOf(ctx); const current = await store.read();
      const sub = invocation.args[0]?.toLowerCase() ?? "health";
      if (sub === "health" || sub === "protect" || sub === "status") {
        await ctx.telegram.edit(invocation.message, report(current), {parseMode: "html"}); return;
      }
      if (sub === "sysinfo") {
        const result = await ctx.processes.run("/usr/bin/uptime", [], {timeoutMs: 3000});
        await ctx.telegram.edit(invocation.message, `<b>系统状态</b>\n<code>${result.stdout.toString().trim()}</code>\n\n${report(current)}`, {parseMode: "html"}); return;
      }
      if (sub === "on" || sub === "off") {
        await store.update(value => ({...value, enabled: sub === "on"}));
        await ctx.telegram.edit(invocation.message, `自动内存保护已${sub === "on" ? "开启" : "关闭"}`); return;
      }
      if (sub === "silent") {
        const value = invocation.args[1] === "on";
        await store.update(current => ({...current, silent: value}));
        await ctx.telegram.edit(invocation.message, `内存通知已${value ? "静默" : "开启"}`); return;
      }
      if (sub === "set") {
        const target = invocation.args[1]; const value = parsePositive(invocation.args[2]);
        if (!value || !["heap", "rss"].includes(target ?? "")) {await ctx.telegram.edit(invocation.message, "用法：.memory set heap|rss 数值"); return;}
        await store.update(current => ({...current, [target!]: value}));
        await ctx.telegram.edit(invocation.message, `已设置 ${target} 上限为 ${value} MB`); return;
      }
      if (sub === "reset") {
        const m = snapshot();
        await store.update(value => ({...value, baselineHeap: m.heap, baselineRss: m.rss}));
        await ctx.telegram.edit(invocation.message, "当前内存已记录为观察起点"); return;
      }
      await ctx.telegram.edit(invocation.message, "用法：.memory health|status|sysinfo|on|off|protect|reset|set heap|rss 数值");
    }},
    },
    jobs: {monitor: {cron: "*/10 * * * *", description: "定时记录内存状态", async handle(ctx) {
      const store = await configOf(ctx); const config = await store.read(); const m = snapshot();
      if (config.enabled && (m.heap > config.heap || m.rss > config.rss)) {
        ctx.log.info("memory.threshold", {heap: Math.round(m.heap), rss: Math.round(m.rss)});
      }
    }}},
  });
}
