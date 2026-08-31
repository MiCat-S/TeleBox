import path from "path";
import fs from "fs";
import crypto from "crypto";
import { AsyncLocalStorage } from "async_hooks";
import { isValidPlugin, Plugin, type PanelSettingsAdapter } from "@utils/pluginBase";
import { NewMessageEvent, NewMessage } from "teleproto/events";
import { AliasDB } from "./aliasDB";
import { Api } from "teleproto";
import { cronManager } from "./cronManager";
import {
  EditedMessage,
  EditedMessageEvent,
} from "teleproto/events/EditedMessage";
import type { TeleBoxRuntime } from "./runtimeManager";
import { createGenerationContext } from "./generationContext";
import {
  getCurrentGeneration,
  getGlobalClient,
  reloadRuntime,
} from "./runtimeAccess";

type ClientEventBuilder = NonNullable<Parameters<TeleBoxRuntime["client"]["removeEventHandler"]>[1]>;

type MessageWithText = Api.Message & {
  text?: string;
  savedPeerId?: unknown;
};

type MutableMessageWithText = MessageWithText & {
  message: string;
  text: string;
};

type PluginEntry = {
  original?: string;
  aliasFinal?: string;
  plugin: Plugin;
  sourceFile?: string;
};

export type PluginLoadFailureStage = "directory" | "require" | "export" | "setup";

export interface PluginLoadFailure {
  stage: PluginLoadFailureStage;
  sourceFile: string;
  pluginName?: string;
  message: string;
}

export interface PluginLoadConflict {
  kind: "command" | "alias" | "cron";
  key: string;
  winnerPlugin: string;
  winnerSourceFile?: string;
  skippedPlugin: string;
  skippedSourceFile?: string;
}

export interface PluginLoadReport {
  generation: number;
  loaded: Array<{ pluginName: string; sourceFile: string }>;
  failures: PluginLoadFailure[];
  conflicts: PluginLoadConflict[];
}

const validPlugins: Plugin[] = [];
const plugins: Map<string, PluginEntry> = new Map();
const loadedPluginFiles: Set<string> = new Set();
const pluginSourceFiles = new WeakMap<Plugin, string>();
let pluginLoadDepth = 0;
let lastPluginLoadReport: PluginLoadReport = {
  generation: 0,
  loaded: [],
  failures: [],
  conflicts: [],
};
let pluginOperationLock: Promise<unknown> = Promise.resolve();
const pluginOperationLockStorage = new AsyncLocalStorage<{ active: boolean }>();

export function withPluginOperationLock<T>(fn: () => Promise<T>): Promise<T> {
  if (pluginOperationLockStorage.getStore()?.active) return fn();
  const execute = () => {
    const state = { active: true };
    return pluginOperationLockStorage.run(state, async () => {
      try {
        return await fn();
      } finally {
        state.active = false;
      }
    });
  };
  const run = pluginOperationLock.then(execute, execute);
  pluginOperationLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function getLastPluginLoadReport(): PluginLoadReport {
  return {
    generation: lastPluginLoadReport.generation,
    loaded: lastPluginLoadReport.loaded.map((item) => ({ ...item })),
    failures: lastPluginLoadReport.failures.map((item) => ({ ...item })),
    conflicts: lastPluginLoadReport.conflicts.map((item) => ({ ...item })),
  };
}

export function createPluginLoadReport(generation: number): PluginLoadReport {
  return { generation, loaded: [], failures: [], conflicts: [] };
}

export function pluginFailedInReport(
  report: PluginLoadReport,
  pluginName: string,
  pluginRoot?: string,
): PluginLoadFailure | undefined {
  const expectedFile = `${pluginName}.ts`;
  return report.failures.find(
    (failure) =>
      path.basename(failure.sourceFile) === expectedFile &&
      (!pluginRoot ||
        path.dirname(path.resolve(failure.sourceFile)) === path.resolve(pluginRoot)),
  );
}

export function writeJsonFileAtomically(
  filePath: string,
  value: unknown,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
    try {
      const dirFd = fs.openSync(path.dirname(filePath), "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Directory fsync is unavailable on some platforms; file fsync + rename completed.
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

const USER_PLUGIN_PATH = path.join(process.cwd(), "plugins");
const DEFAUTL_PLUGIN_PATH = path.join(process.cwd(), "src", "plugin");
const PROJECT_ROOT = process.cwd();
const CACHE_PURGE_EXCLUDE = new Set<string>([
  path.resolve(PROJECT_ROOT, "src/utils/pluginManager.ts"),
  path.resolve(PROJECT_ROOT, "src/utils/pluginManager.js"),
  path.resolve(PROJECT_ROOT, "src/utils/pluginBase.ts"),
  path.resolve(PROJECT_ROOT, "src/utils/pluginBase.js"),
  path.resolve(PROJECT_ROOT, "src/utils/cronManager.ts"),
  path.resolve(PROJECT_ROOT, "src/utils/cronManager.js"),
  path.resolve(PROJECT_ROOT, "src/utils/runtimeManager.ts"),
  path.resolve(PROJECT_ROOT, "src/utils/runtimeManager.js"),
  path.resolve(PROJECT_ROOT, "src/utils/runtimeAccess.ts"),
  path.resolve(PROJECT_ROOT, "src/utils/runtimeAccess.js"),
  // Logger overrides console.* once at startup. Purging it on reload caused
  // the new Logger class to capture the already-wrapped console.log as
  // "original", stacking another wrapper every reload (visible as nested
  // timestamps in PM2 logs).
  path.resolve(PROJECT_ROOT, "src/utils/logger.ts"),
  path.resolve(PROJECT_ROOT, "src/utils/logger.js"),
  // channelGapBreaker holds the per-channel failure window + cooldown map.
  // Purging it on reload reset the 6h cooldown state, allowing the breaker
  // to re-fire repeatedly for the same channel within minutes. Also avoids
  // a split-brain where runtimeManager (excluded) and logger (was purged)
  // referenced different module instances.
  path.resolve(PROJECT_ROOT, "src/utils/channelGapBreaker.ts"),
  path.resolve(PROJECT_ROOT, "src/utils/channelGapBreaker.js"),
  // Shared CJS helpers used by precompiled plugins. Purging this on reload
  // is harmless (stateless) but wasteful — every plugin re-require()s it.
  path.resolve(PROJECT_ROOT, "scripts/cjs-helpers.js"),
]);

let prefixes = [".", "。", "$"];
const envPrefixes =
  process.env.TB_PREFIX?.split(/\s+/g).filter((p) => p.length > 0) || [];
if (envPrefixes.length > 0) {
  prefixes = envPrefixes;
} else if (process.env.NODE_ENV === "development") {
  prefixes = ["!", "！"];
}
console.log(
  `[PREFIXES] ${prefixes.join(" ")} (${envPrefixes.length > 0 ? "" : "可"}使用环境变量 TB_PREFIX 覆盖, 多个前缀用空格分隔)`
);

function getPrefixes(): string[] {
  return prefixes;
}

function setPrefixes(newList: string[]): void {
  prefixes = newList;
}

function normalizePath(filePath: string): string {
  return path.resolve(filePath);
}

function compareStableAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isProjectFile(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return normalized.startsWith(PROJECT_ROOT + path.sep);
}

function shouldPurgeCache(filePath: string): boolean {
  if (!filePath) return false;
  const normalized = normalizePath(filePath);
  if (!isProjectFile(normalized)) return false;
  if (CACHE_PURGE_EXCLUDE.has(normalized)) return false;
  if (normalized.includes(`${path.sep}node_modules${path.sep}`)) return false;
  if (!/\.(ts|js|cjs|mjs|cts|mts)$/.test(normalized)) return false;
  return true;
}

function collectModuleSubtree(moduleId: string, visited = new Set<string>()): Set<string> {
  const resolved = require.resolve(moduleId);
  const mod = require.cache[resolved];
  if (!mod) return visited;
  if (visited.has(mod.id)) return visited;
  visited.add(mod.id);

  for (const child of mod.children || []) {
    if (child?.id && shouldPurgeCache(child.id)) {
      collectModuleSubtree(child.id, visited);
    }
  }

  return visited;
}

function purgeModuleCache(modulePaths: Iterable<string>): void {
  const idsToDelete = new Set<string>();

  for (const filePath of modulePaths) {
    try {
      const resolved = require.resolve(filePath);
      if (!shouldPurgeCache(resolved)) continue;
      idsToDelete.add(resolved);
      const subtree = collectModuleSubtree(resolved);
      for (const id of subtree) {
        if (shouldPurgeCache(id)) {
          idsToDelete.add(id);
        }
      }
    } catch {
      // ignore unresolved files during cleanup
    }
  }

  for (const id of idsToDelete) {
    delete require.cache[id];
  }

  if (idsToDelete.size > 0) {
    console.log(`[RELOAD] Purged ${idsToDelete.size} module cache entries.`);
  }
}

function dynamicRequireWithDeps(filePath: string) {
  try {
    const normalized = normalizePath(filePath);
    loadedPluginFiles.add(normalized);
    delete require.cache[require.resolve(normalized)];
    return require(normalized);
  } catch (err) {
    console.error(`Failed to require ${filePath}:`, err);
    throw new Error(
      `Failed to require plugin ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function setPlugins(
  basePath: string,
  report: PluginLoadReport,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    const baseStat = fs.lstatSync(basePath);
    if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
      throw new Error(`Plugin path must be a real directory: ${basePath}`);
    }
    entries = fs
      .readdirSync(basePath, { withFileTypes: true })
      .sort((a, b) => compareStableAscii(a.name, b.name));
  } catch (error) {
    report.failures.push({
      stage: "directory",
      sourceFile: basePath,
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".ts")) continue;
    const pluginPath = path.resolve(basePath, entry.name);
    if (entry.isSymbolicLink()) {
      report.failures.push({
        stage: "directory",
        sourceFile: pluginPath,
        message: `Refusing symlink plugin: ${pluginPath}`,
      });
      continue;
    }
    if (
      !entry.isFile() ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.ts$/.test(entry.name)
    ) {
      report.failures.push({
        stage: "directory",
        sourceFile: pluginPath,
        message: `Invalid plugin filename: ${entry.name}`,
      });
      continue;
    }

    let mod: unknown;
    try {
      mod = dynamicRequireWithDeps(pluginPath);
    } catch (error) {
      report.failures.push({
        stage: "require",
        sourceFile: pluginPath,
        pluginName: path.basename(entry.name, ".ts"),
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const plugin = (mod as { default?: unknown }).default ?? mod;
    if (!isValidPlugin(plugin)) {
      report.failures.push({
        stage: "export",
        sourceFile: pluginPath,
        pluginName: path.basename(entry.name, ".ts"),
        message: `Invalid plugin export: ${pluginPath}`,
      });
      continue;
    }
    if (!plugin.name) plugin.name = path.basename(entry.name, ".ts");
    pluginSourceFiles.set(plugin, pluginPath);
    validPlugins.push(plugin);
  }
}

function registerPluginCommands(report: PluginLoadReport): void {
  const aliasDB = new AliasDB();
  const aliasList = aliasDB.list();
  aliasDB.close();

  for (const plugin of validPlugins) {
    const sourceFile = pluginSourceFiles.get(plugin);
    for (const cmd of Object.keys(plugin.cmdHandlers).sort(compareStableAscii)) {
      const existing = plugins.get(cmd);
      if (existing) {
        const conflict: PluginLoadConflict = {
          kind: "command",
          key: cmd,
          winnerPlugin: existing.plugin.name || "unknown",
          winnerSourceFile: existing.sourceFile,
          skippedPlugin: plugin.name || "unknown",
          skippedSourceFile: sourceFile,
        };
        report.conflicts.push(conflict);
        console.warn(
          `[RELOAD] Command conflict "${cmd}": keeping ${conflict.winnerPlugin} (${conflict.winnerSourceFile || "unknown"}), skipping ${conflict.skippedPlugin} (${conflict.skippedSourceFile || "unknown"}).`,
        );
        continue;
      }
      plugins.set(cmd, { plugin, sourceFile });

      const relatedAliases = aliasList.filter(
        (rec) => rec.final === cmd || rec.final.startsWith(cmd + " "),
      );
      for (const rec of relatedAliases) {
        const existingAlias = plugins.get(rec.original);
        if (existingAlias) {
          report.conflicts.push({
            kind: "alias",
            key: rec.original,
            winnerPlugin: existingAlias.plugin.name || "unknown",
            winnerSourceFile: existingAlias.sourceFile,
            skippedPlugin: plugin.name || "unknown",
            skippedSourceFile: sourceFile,
          });
          continue;
        }
        plugins.set(rec.original, {
          plugin,
          original: cmd,
          aliasFinal: rec.final,
          sourceFile,
        });
      }
    }
  }
}

function isPluginLoadInProgress(): boolean {
  return pluginLoadDepth > 0;
}

function getPluginEntry(command: string): PluginEntry | undefined {
  return plugins.get(command);
}

function listCommands(): string[] {
  return Array.from(plugins.keys()).sort((a, b) => a.localeCompare(b));
}

function getCommandFromMessage(
  msg: Api.Message | string,
  diyPrefixes?: string[]
): string | null {
  let pfs = getPrefixes();
  if (diyPrefixes && diyPrefixes.length > 0) {
    pfs = diyPrefixes;
  }
  const text = typeof msg === "string" ? msg : msg.message;

  const matched = pfs.find((p) => text.startsWith(p));
  if (!matched) return null;

  const rest = text.slice(matched.length).trim();
  if (!rest) return null;

  const parts = rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;

  const aliasDB = new AliasDB();
  let aliasCandidate: string | null = null;
  for (let i = parts.length; i >= 1; i--) {
    const candidate = parts.slice(0, i).join(" ");
    if (aliasDB.get(candidate)) {
      aliasCandidate = candidate;
      break;
    }
  }
  aliasDB.close();

  if (aliasCandidate) {
    return aliasCandidate;
  }

  const cmd = parts[0];
  if (/^[a-z0-9_]+$/i.test(cmd)) return cmd;

  return null;
}

async function dealCommandPluginWithMessage(param: {
  cmd: string;
  isEdited?: boolean;
  msg: Api.Message;
  trigger?: Api.Message;
}) {
  const { cmd, msg, isEdited, trigger } = param;
  const pluginEntry = getPluginEntry(cmd);

  try {
    if (!pluginEntry) return;

    if (isEdited && pluginEntry.plugin.ignoreEdited) {
      return;
    }

    const original = pluginEntry.original;
    let targetCmd = original || cmd;
    let targetMsg: Api.Message = msg;

    if (original && pluginEntry.aliasFinal && pluginEntry.aliasFinal !== original) {
      const pfs = getPrefixes();
      const base = msg as MessageWithText;
      const text: string = base.message || base.text || "";
      const matched = pfs.find((p) => text.startsWith(p)) || "";
      const rest = text.slice(matched.length).trim();
      const parts = rest.split(/\s+/).filter(Boolean);

      const aliasParts = cmd.split(/\s+/).filter(Boolean);
      const finalParts = pluginEntry.aliasFinal.split(/\s+/).filter(Boolean);

      if (
        parts.length >= aliasParts.length &&
        aliasParts.every((w, idx) => parts[idx] === w)
      ) {
        const extraParts = parts.slice(aliasParts.length);
        const newRest = [...finalParts, ...extraParts].join(" ");
        const newText = matched + newRest;

        const newMsg = Object.create(Object.getPrototypeOf(base)) as MutableMessageWithText;
        Object.assign(newMsg, base);

        Object.defineProperty(newMsg, "message", {
          value: newText,
          writable: true,
          configurable: true,
        });
        Object.defineProperty(newMsg, "text", {
          value: newText,
          writable: true,
          configurable: true,
        });

        targetMsg = newMsg as Api.Message;
      }
    }

    const handler = pluginEntry.plugin.cmdHandlers[targetCmd];
    if (handler) {
      await handler(targetMsg, trigger);
    }
  } catch (error) {
    console.error("Command handler error:", error);
    const errorMsg = `处理命令时出错：${error instanceof Error ? error.message : String(error)}`;
    try {
      await msg.edit({ text: errorMsg });
    } catch (editError) {
      console.error("Failed to show command error message (client may be destroyed):", editError);
    }
  }
}

async function dealCommandPlugin(
  event: NewMessageEvent | EditedMessageEvent
): Promise<void> {
  const msg = event.message;
  const savedMessage = (msg as MessageWithText).savedPeerId;
  if (msg.out || savedMessage) {
    const cmd = getCommandFromMessage(msg);
    if (cmd) {
      const isEdited = event instanceof EditedMessageEvent;
      await dealCommandPluginWithMessage({ cmd, msg, isEdited });
    }
  }
}

async function dealNewMsgEvent(event: NewMessageEvent): Promise<void> {
  await dealCommandPlugin(event);
}

async function dealEditedMsgEvent(event: EditedMessageEvent): Promise<void> {
  await dealCommandPlugin(event);
}

const listenerHandleEdited =
  process.env.TB_LISTENER_HANDLE_EDITED?.split(/\s+/g).filter(
    (p) => p.length > 0
  ) || [];

console.log(
  `[LISTENER_HANDLE_EDITED] 不忽略监听编辑的消息的插件: ${
    listenerHandleEdited.length === 0
      ? "未设置"
      : listenerHandleEdited.join(", ")
  } (可使用环境变量 TB_LISTENER_HANDLE_EDITED 设置, 多个插件用空格分隔)`
);

async function runPluginSetup(plugin: Plugin, runtime: TeleBoxRuntime): Promise<void> {
  if (typeof plugin.setup !== "function") return;
  const pluginLifecycle = createGenerationContext(runtime.generation);
  try {
    await runtime.context.runTask(
      async () => {
        await plugin.setup?.({
          generation: runtime.generation,
          signal: pluginLifecycle.signal,
          lifecycle: pluginLifecycle,
        });
      },
      { label: `plugin-setup:${plugin.name || "unknown"}` },
    );
  } catch (error) {
    pluginLifecycle.abort(`Plugin setup failed: ${plugin.name || "unknown"}`);
    await pluginLifecycle.dispose();
    throw error;
  }
  runtime.context.trackDisposable(
    async () => {
      pluginLifecycle.abort(`Plugin unload: ${plugin.name || "unknown"}`);
      await pluginLifecycle.dispose();
    },
    { label: `plugin-lifecycle:${plugin.name || "unknown"}` },
  );
}

function trackClientEventHandler<TEvent>(
  runtime: TeleBoxRuntime,
  handler: (event: TEvent) => void | Promise<void>,
  eventBuilder: ClientEventBuilder,
  label: string
): void {
  const { client } = runtime;
  runtime.context.trackListener<TEvent>(
    (trackedHandler) => client.addEventHandler(trackedHandler, eventBuilder),
    (trackedHandler) => client.removeEventHandler(trackedHandler, eventBuilder),
    (event) => {
      if (runtime.generation !== getCurrentGeneration()) return;
      return handler(event);
    },
    { label }
  );
}

function dealListenMessagePlugin(runtime: TeleBoxRuntime): void {
  for (const plugin of validPlugins) {
    const messageHandler = plugin.listenMessageHandler;
    if (messageHandler) {
      trackClientEventHandler<NewMessageEvent>(
        runtime,
        async (event) => {
          try {
            await messageHandler(event.message);
          } catch (error) {
            console.log("listenMessageHandler NewMessage error:", error);
          }
        },
        new NewMessage(),
        `listener:${plugin.name || "unknown"}:new-message`
      );

      if (
        !plugin.listenMessageHandlerIgnoreEdited ||
        (plugin.name && listenerHandleEdited.includes(plugin.name))
      ) {
        trackClientEventHandler<EditedMessageEvent>(
          runtime,
          async (event) => {
            try {
              await messageHandler(event.message, { isEdited: true });
            } catch (error) {
              console.log("listenMessageHandler EditedMessage error:", error);
            }
          },
          new EditedMessage({}),
          `listener:${plugin.name || "unknown"}:edited-message`
        );
      }
    }

    const eventHandlers = plugin.eventHandlers;
    if (Array.isArray(eventHandlers) && eventHandlers.length > 0) {
      for (const { event, handler } of eventHandlers) {
        trackClientEventHandler(
          runtime,
          async (ev: unknown) => {
            try {
              await handler(ev);
            } catch (error) {
              console.log("eventHandler error:", error);
            }
          },
          event || new NewMessage(),
          `event:${plugin.name || "unknown"}`
        );
      }
    }
  }
}

function dealCronPlugin(
  runtime: TeleBoxRuntime,
  report: PluginLoadReport,
): void {
  const cronOwners = new Map<string, Plugin>();
  for (const plugin of validPlugins) {
    const cronTasks = plugin.cronTasks;
    if (cronTasks) {
      const keys = Object.keys(cronTasks).sort(compareStableAscii);
      for (const key of keys) {
        const cronTask = cronTasks[key];
        if (cronManager.has(key)) {
          const winner = cronOwners.get(key);
          report.conflicts.push({
            kind: "cron",
            key,
            winnerPlugin: winner?.name || "unknown",
            winnerSourceFile: winner ? pluginSourceFiles.get(winner) : undefined,
            skippedPlugin: plugin.name || "unknown",
            skippedSourceFile: pluginSourceFiles.get(plugin),
          });
          console.warn(
            `[RELOAD] Cron conflict "${key}" from plugin ${plugin.name || "unknown"}; keeping the task registered first.`,
          );
          continue;
        }
        cronManager.set(key, cronTask.cron, async () => {
          if (runtime.signal.aborted || runtime.generation !== getCurrentGeneration()) return;
          const client = await getGlobalClient();
          await cronTask.handler(client as never);
        }, runtime.context);
        if (cronManager.has(key)) cronOwners.set(key, plugin);
      }
    }
  }
}

async function runPluginCleanup(plugin: Plugin, runtime: TeleBoxRuntime): Promise<void> {
  const cleanup = typeof plugin.cleanup === "function"
    ? plugin.cleanup.bind(plugin)
    : async () => {};
  // Do NOT wrap cleanup in runTask — by the time cleanup runs, the runtime
  // context has already been aborted, so runTask would reject immediately
  // with "Unload generation N" / "Runtime reload", preventing all plugin
  // cleanup from executing and crashing the reload flow.
  try {
    await cleanup();
  } catch (error) {
    console.error(`[RELOAD] Plugin cleanup failed: ${plugin.name || "unknown"}`, error);
  }
}

export async function runPluginSetupsForReport(
  candidates: Plugin[],
  runtime: TeleBoxRuntime,
  report: PluginLoadReport,
): Promise<Plugin[]> {
  const successful: Plugin[] = [];
  for (const plugin of candidates) {
    const sourceFile =
      pluginSourceFiles.get(plugin) ?? `<in-memory:${plugin.name || "unknown"}>`;
    try {
      await runPluginSetup(plugin, runtime);
      successful.push(plugin);
      report.loaded.push({
        pluginName: plugin.name || path.basename(sourceFile, ".ts"),
        sourceFile,
      });
    } catch (error) {
      report.failures.push({
        stage: "setup",
        sourceFile,
        pluginName: plugin.name || path.basename(sourceFile, ".ts"),
        message: error instanceof Error ? error.message : String(error),
      });
      console.error(
        `[RELOAD] Plugin setup failed: ${plugin.name || "unknown"}; plugin disabled for this generation.`,
        error,
      );
      await runPluginCleanup(plugin, runtime);
    }
  }
  return successful;
}

async function unloadPluginsForRuntime(runtime: TeleBoxRuntime) {
  const oldPlugins = [...validPlugins];
  const oldPluginFiles = [...loadedPluginFiles];

  if (!runtime.signal.aborted) {
    runtime.context.abort(`Unload generation ${runtime.generation}`);
  }

  for (const plugin of oldPlugins) {
    await runPluginCleanup(plugin, runtime);
  }

  // 兜底：显式清理所有插件注册的事件处理器
  // 即使插件没有 cleanup()，也通过 generation context 的 trackListener 机制清理
  console.log(
    `[RELOAD] Gen${runtime.generation} unloading plugins`
  );

  validPlugins.length = 0;
  plugins.clear();
  loadedPluginFiles.clear();
  purgeModuleCache(oldPluginFiles);
}

async function loadPluginsForRuntime(runtime: TeleBoxRuntime) {
  const report = createPluginLoadReport(runtime.generation);
  pluginLoadDepth++;
  try {
    await setPlugins(USER_PLUGIN_PATH, report);
    await setPlugins(DEFAUTL_PLUGIN_PATH, report);
  } finally {
    pluginLoadDepth--;
  }

  const successful = await runPluginSetupsForReport(
    [...validPlugins],
    runtime,
    report,
  );
  validPlugins.length = 0;
  validPlugins.push(...successful);
  registerPluginCommands(report);

  const { client } = runtime;
  trackClientEventHandler<NewMessageEvent>(
    runtime,
    dealNewMsgEvent,
    new NewMessage(),
    "root:new-message"
  );
  trackClientEventHandler<EditedMessageEvent>(
    runtime,
    dealEditedMsgEvent,
    new EditedMessage({}),
    "root:edited-message"
  );
  dealListenMessagePlugin(runtime);
  dealCronPlugin(runtime, report);
  lastPluginLoadReport = report;
  if (report.failures.length > 0 || report.conflicts.length > 0) {
    console.warn(
      `[RELOAD] Plugin load report: loaded=${report.loaded.length} failures=${report.failures.length} conflicts=${report.conflicts.length}`,
    );
  }
  console.log(`[RELOAD] Event handlers registered after reload`);
}

function getPluginPanelAdapters(): PanelSettingsAdapter[] {
  const adapters: PanelSettingsAdapter[] = [];
  for (const plugin of validPlugins) {
    if (plugin.panelAdapter) {
      adapters.push(plugin.panelAdapter);
    }
  }
  return adapters;
}

async function loadPluginsUnlocked(): Promise<boolean> {
  if (isPluginLoadInProgress()) {
    console.warn(
      "[RELOAD] Skip nested plugin reload while plugins are still being required. Move loadPlugins() out of module top-level initialization."
    );
    return false;
  }

  try {
    // Delegate to reloadRuntime() which handles:
    //   1. Abort the old generation context
    //   2. Unload old plugins & drain disposables
    //   3. Create a NEW generation/context/client
    //   4. Load plugins on the fresh runtime
    //
    // The old approach (unloadPluginsForRuntime + loadPluginsForRuntime on
    // the same aborted runtime) caused all runTask/trackDisposable calls in
    // the new load phase to immediately reject because the context was
    // already aborted, breaking plugin setup, event handlers, and cron tasks.
    // Access via runtimeAccess (registered by runtimeManager) — no cycle.
    await reloadRuntime();
    return true;
  } catch (error) {
    console.error("[RELOAD] loadPlugins via reloadRuntime failed:", error);
    return false;
  }
}

async function loadPlugins(): Promise<boolean> {
  return withPluginOperationLock(loadPluginsUnlocked);
}

export {
  getPrefixes,
  setPrefixes,
  loadPlugins,
  loadPluginsForRuntime,
  unloadPluginsForRuntime,
  listCommands,
  getPluginEntry,
  dealCommandPluginWithMessage,
  getCommandFromMessage,
  getPluginPanelAdapters,
};
