import type { PluginHost } from "../host";
import { definePlugin, type CommandInvocation, type PluginContext, type PluginDefinition } from "../sdk";

type HelpHost = Pick<PluginHost, "listCommands" | "listPlugins" | "configuration">;
type PluginInfo = ReturnType<HelpHost["listPlugins"]>[number];
interface Block { html: string; entities: number; }

// Raw HTML UTF-16 length is conservative relative to Telegram's decoded length.
const MAX_HTML_LENGTH = 3_500;
const MAX_ENTITIES = 90;
const supportedTags = new Set([
  "b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "a",
  "code", "pre", "blockquote", "span", "tg-spoiler", "spoiler", "tg-emoji", "tg-date",
]);

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function code(value: string): string { return `<code>${escape(value)}</code>`; }

const pluginIcons: Readonly<Record<string, string>> = {
  ai: "🤖", da: "🛡️", dc: "🌐", dme: "🗑️", gt: "🌍", ids: "🪪",
  ip: "📍", nodeseek: "🔎", rate: "💱", sum: "📝", yvlu: "🖼️",
  memory: "🧠", ping: "🏓", status: "📊", env: "⚙️", alias: "🔗",
  prefix: "📌", loglevel: "🔊", help: "❔",
};
function pluginTitle(id: string): string { return `${pluginIcons[id.toLowerCase()] ?? "🧩"} ${escape(id)}`; }

function plainBlocks(text: string): Block[] {
  const result: Block[] = [];
  let html = "";
  const budget = MAX_HTML_LENGTH - "<pre></pre>".length;
  // Iterate code points so astral characters and multi-byte prefixes stay intact.
  for (const character of text) {
    const escaped = escape(character);
    if (html.length + escaped.length > budget) {
      result.push({ html: `<pre>${html}</pre>`, entities: 1 });
      html = "";
    }
    html += escaped;
  }
  // A single pre entity also prevents URL/command auto-detection in fallback data.
  if (html.trim()) result.push({ html: `<pre>${html}</pre>`, entities: 1 });
  return result;
}

async function formatter() {
  const { parseDocument, DomUtils } = await import("htmlparser2");
  type HtmlNode = ReturnType<typeof parseDocument>["children"][number];
  const serialize = (node: HtmlNode): string => DomUtils.getOuterHTML(node, { encodeEntities: "utf8" });

  const normalize = (source: string): Block[] => {
    if (!source.trim()) return [];
    const document = parseDocument(source);
    const stack: HtmlNode[] = [...document.children];
    let entities = 0;
    let unsupported = false;
    const links = new Set<string>();
    while (stack.length) {
      const node = stack.pop()!;
      if ("attribs" in node) {
        entities += 1;
        if (!supportedTags.has(node.name)) unsupported = true;
        if (node.name === "a" && node.attribs.href) {
          links.add(node.attribs.href);
          try {
            if (!["http:", "https:", "tg:", "mailto:"].includes(new URL(node.attribs.href).protocol)) unsupported = true;
          } catch { unsupported = true; }
        }
      }
      if ("children" in node) stack.push(...node.children);
    }
    if (unsupported) {
      return [{ html: "此段包含不支持的格式，以下按文本显示。", entities: 0 }, ...plainBlocks(source)];
    }
    const html = document.children.map(serialize).join("");
    if (html.length <= MAX_HTML_LENGTH && entities <= MAX_ENTITIES) return [{ html, entities }];
    let text = DomUtils.textContent(document);
    const addresses = [...links];
    if (addresses.length) text += `\n链接地址：\n${addresses.join("\n")}`;
    return [{ html: "此段超出单条消息的长度或格式数量预算，以下以纯文本分段显示。", entities: 0 }, ...plainBlocks(text)];
  };

  const description = (source: string): Block[] => {
    const document = parseDocument(source);
    const result: Block[] = [];
    let current = "";
    // Newlines outside tags are block boundaries; formatted elements stay whole.
    for (const node of document.children) {
      if (node.type !== "text") {
        current += serialize(node);
        continue;
      }
      const lines = node.data.split("\n");
      current += escape(lines[0]);
      for (const line of lines.slice(1)) {
        result.push(...normalize(current));
        current = escape(line);
      }
    }
    result.push(...normalize(current));
    return result;
  };
  return { normalize, description };
}

function pages(blocks: Block[]): string[] {
  const result: string[] = [];
  let text = "";
  let entities = 0;
  for (const block of blocks) {
    if (!block.html.trim()) continue;
    if (text && (text.length + 1 + block.html.length > MAX_HTML_LENGTH || entities + block.entities > MAX_ENTITIES)) {
      result.push(text);
      text = "";
      entities = 0;
    }
    text += `${text ? "\n" : ""}${block.html}`;
    entities += block.entities;
  }
  if (text) result.push(text);
  return result;
}

function aliasesFor(command: string, aliases: Readonly<Record<string, string>>): string[] {
  return Object.entries(aliases)
    .filter(([, expansion]) => expansion.trim().split(/\s+/)[0]?.toLowerCase() === command.toLowerCase())
    .map(([alias]) => alias).sort();
}

function commandLine(command: string, prefix: string, aliases: Readonly<Record<string, string>>): string {
  const names = aliasesFor(command, aliases);
  return code(prefix + command) + (names.length ? `（别名：${names.map((name) => code(prefix + name)).join("、")}）` : "");
}

function resolve(
  query: string,
  plugins: PluginInfo[],
  prefixes: readonly string[],
  aliases: Readonly<Record<string, string>>,
): { plugin: PluginInfo; usage?: string } | undefined {
  const prefix = [...prefixes].sort((a, b) => b.length - a.length).find((candidate) => query.startsWith(candidate));
  if (prefix) query = query.slice(prefix.length);
  const parts = query.trim().split(/\s+/).filter(Boolean);
  let alias: string | undefined;
  for (let length = parts.length; length > 0; length--) {
    const candidate = parts.slice(0, length).join(" ");
    // Match host parsing: longer aliases win, but real commands own single tokens.
    if (length === 1 && plugins.some((plugin) => plugin.commands.some((entry) => entry.name === candidate))) continue;
    if (Object.hasOwn(aliases, candidate) && aliases[candidate]) {
      alias = candidate;
      break;
    }
  }
  const command = (alias ? aliases[alias] : query).trim().split(/\s+/)[0].toLowerCase();
  const owner = plugins.find((plugin) => plugin.commands.some((entry) => entry.name.toLowerCase() === command));
  if (owner) return { plugin: owner, usage: alias ?? owner.commands.find((entry) => entry.name.toLowerCase() === command)!.name };
  if (alias) return undefined;
  const plugin = plugins.find((entry) => entry.id.toLowerCase() === query.toLowerCase());
  return plugin && { plugin, usage: plugin.commands[0]?.name };
}

export function createHelp(host: HelpHost): PluginDefinition {
  const handle = async (invocation: CommandInvocation, context: PluginContext): Promise<void> => {
    context.signal.throwIfAborted();
    let output: string[];
    try {
      const format = await formatter();
      context.signal.throwIfAborted();
      const configuration = host.configuration();
      const prefix = configuration.prefixes[0] ?? invocation.prefix;
      const aliases = configuration.aliases;
      const commands = host.listCommands();
      const plugins = host.listPlugins();
      const blocks: Block[] = [];
      const add = (html: string): void => { blocks.push(...format.normalize(html)); };
      const query = invocation.args.join(" ").trim();
      if (!query) {
        add(`<b>TeleBox 控制台</b>  <code>${commands.length} 个命令</code>`);
        add(`前缀 ${configuration.prefixes.map(code).join(" · ")}　·　发送 ${code(prefix + "help 模块")} 查看详情`);
        add(`<b>基础命令</b>`);
        const singles = plugins.filter((plugin) => plugin.commands.length === 1).flatMap((plugin) => plugin.commands.map((entry) => entry.name));
        const basic = singles.length ? singles : commands.map((entry) => entry.name);
        if (!basic.length) add("暂无基础命令");
        for (const name of [...new Set(basic)].sort()) add(commandLine(name, prefix, aliases));
        add(`使用 ${code(prefix + "help [命令或模块名]")} 查看详情`);
        if (commands.some((entry) => entry.name === "tpm")) {
          add(`${code(prefix + "tpm search")} 显示远程插件列表`);
        }
        add(`<a href="https://github.com/MiCat-S/TeleBox">TeleBox 仓库</a> | <a href="https://github.com/MiCat-S/TeleBox-Plugins">插件仓库</a>`);
        output = pages(blocks);
        const modules: Block[] = [];
        for (const plugin of [...plugins].filter((entry) => entry.commands.length !== 1).sort((a, b) => a.id.localeCompare(b.id))) {
          modules.push(...format.normalize(`<b>${pluginIcons[plugin.id.toLowerCase()] ?? "🧩"} 模块 ${escape(plugin.id)}</b>`));
          if (!plugin.commands.length) modules.push(...format.normalize("无可调用命令"));
          for (const entry of [...plugin.commands].sort((a, b) => a.name.localeCompare(b.name))) {
            modules.push(...format.normalize(commandLine(entry.name, prefix, aliases)));
          }
        }
        if (modules.length) {
          output.push(...pages([
            ...format.normalize("<b>功能模块</b>"), ...modules,
            ...format.normalize(`使用 ${code(prefix + "help [模块名]")} 查看模块详情`),
          ]));
        }
        const quickModules: Block[] = [];
        for (const plugin of [...plugins].filter((entry) => entry.commands.length === 1)
          .sort((a, b) => a.id.localeCompare(b.id))) {
          const command = plugin.commands[0];
          quickModules.push(...format.normalize(
            `<b>${pluginTitle(plugin.id)}</b>　${escape(command.description || plugin.description)}`,
          ));
        }
        if (quickModules.length) {
          output.push(...pages([
            ...format.normalize("<b>快捷模块</b>"), ...quickModules,
            ...format.normalize(`使用 ${code(prefix + "help [模块名]")} 查看详细说明`),
          ]));
        }
      } else {
        const target = resolve(query, plugins, configuration.prefixes, aliases);
        if (!target) {
          add(`未找到命令或模块 ${code(query)}`);
          add(`使用 ${code(prefix + "help")} 查看所有命令`);
        } else {
          const { plugin, usage } = target;
          add(`<b>${pluginTitle(plugin.id)} 帮助</b>　<code>${plugin.commands.length} 个命令</code>`);
          add("━━━━━━━━━━━━");
          add("<b>功能说明</b>");
          blocks.push(...format.description(plugin.description || "暂无描述信息"));
          add("<b>可用命令</b>");
          if (!plugin.commands.length) add("无可调用命令");
          for (const entry of [...plugin.commands].sort((a, b) => a.name.localeCompare(b.name))) {
            add(commandLine(entry.name, prefix, aliases));
            if (entry.description && entry.description !== plugin.description) blocks.push(...format.description(entry.description));
          }
          if (usage) add(`<b>使用方法：</b> ${code(prefix + usage + " [参数]")}`);
          if (plugin.jobs.length) {
            add("<b>定时任务</b>");
            for (const job of plugin.jobs) {
              add(`${code(job.name)} ${code("(" + job.cron + ")")}`);
              blocks.push(...format.description(job.description || "暂无描述信息"));
            }
          }
          add(`使用 ${code(prefix + "help")} 查看所有命令`);
        }
        output = pages(blocks);
      }
    } catch {
      context.signal.throwIfAborted();
      context.log.error("help.failed");
      output = ["帮助暂时不可用，请稍后重试。"];
    }
    for (const [index, text] of output.entries()) {
      context.signal.throwIfAborted();
      const options = { parseMode: "html" as const, linkPreview: false };
      if (index === 0) await context.telegram.edit(invocation.message, text, options);
      else await context.telegram.reply(invocation.message, text, options);
    }
  };
  return definePlugin({
    apiVersion: 1,
    id: "help",
    description: "查看帮助信息和可用命令列表",
    commands: {
      help: { description: "查看命令或模块帮助", handle },
      h: { description: "查看命令或模块帮助", handle },
    },
  });
}
