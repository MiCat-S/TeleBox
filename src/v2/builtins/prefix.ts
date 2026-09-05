import type { PluginHost } from "../host";
import type { PrefixPersistence } from "../prefixes";
import { definePlugin, type PluginDefinition } from "../sdk";

type PrefixHost = Pick<PluginHost, "configuration" | "replacePrefixes">;
const queues = new WeakMap<PrefixHost, Promise<void>>();

function html(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function list(prefixes: readonly string[]): string {
  return prefixes.map(prefix => `<code>${html(prefix)}</code>`).join(" • ");
}

function help(prefix: string): string {
  return `🛠 <b>前缀管理</b>\n\n` +
    `• <code>${html(prefix)}prefix</code> - 查看当前前缀\n` +
    `• <code>${html(prefix)}prefix set [前缀...]</code> - 设置并持久化\n` +
    `• <code>${html(prefix)}prefix add [前缀...]</code> - 追加前缀\n` +
    `• <code>${html(prefix)}prefix del [前缀...]</code> - 删除前缀`;
}

export function createPrefix(host: PrefixHost, persistence: PrefixPersistence): PluginDefinition {
  return definePlugin({
    apiVersion: 1, id: "prefix", description: help(host.configuration().prefixes[0]),
    commands: {
      prefix: {
        description: "查看、设置、追加或删除命令前缀",
        handle(input, context) {
          // Own the entire operation through actual settlement, not an abort race.
          return context.tasks.run("prefix:update", () => {
            const result = (queues.get(host) ?? Promise.resolve()).then(async () => {
              context.signal.throwIfAborted();
              const current = host.configuration().prefixes;
              const usage = help(current[0]);
              const [, ...args] = input.message.text.trim().split(/\r?\n/u)[0].split(/\s+/u);
              const sub = (args[0] ?? "").toLowerCase();
              const edit = (text: string) => {
                context.signal.throwIfAborted();
                return context.telegram.edit(input.message, text, { parseMode: "html", linkPreview: false });
              };
              if (!sub) return edit(`🔧 当前前缀: ${list(current)}\n用法: <code>${html(current[0])}prefix set . ！</code>`);
              if ([sub, args[1]?.toLowerCase()].some(value => value === "help" || value === "h") ||
                  !["set", "add", "del"].includes(sub)) return edit(usage);
              const tokens = args.slice(1).filter(Boolean);
              if (!tokens.length) return edit(`❌ 参数不足\n\n${usage}`);
              const prefixes = [...new Set(sub === "set" ? tokens : sub === "add" ? [...current, ...tokens]
                : current.filter(prefix => !tokens.includes(prefix)))];
              if (!prefixes.length) return edit("❌ 至少保留一个前缀");
              if (prefixes.some(prefix => prefix.includes("\0"))) return edit(`❌ 前缀无效\n\n${usage}`);
              host.replacePrefixes(prefixes);
              let persisted = true;
              try { await persistence.persist(Object.freeze([...prefixes]), context.signal); }
              catch {
                context.signal.throwIfAborted();
                persisted = false;
                context.log.error("prefix.persistence_failed");
              }
              return edit(`✅ 已设置前缀: ${list(prefixes)} ${persisted ? "(已写入 .env)" : "(.env 写入失败, 仅本次生效)"}`);
            });
            const settled = result.then(() => undefined, () => undefined);
            queues.set(host, settled);
            void settled.then(() => { if (queues.get(host) === settled) queues.delete(host); });
            return result;
          });
        },
      },
    },
  });
}
