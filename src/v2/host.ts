import { KeyedExecutor, ExecutorClosedError } from "./executor";
import { ResourceScope, type DrainReport } from "./lifecycle";
import { StorageRoot, type JsonStore } from "./storage";
import { PluginScheduler, type ScheduledJob } from "./scheduler";
import { ScopedHttp, type ScopedHttpOptions } from "./http";
import type { TelegramClient } from "teleproto";
import path from "node:path";
import {SqliteStore, type SqliteConnection, type SqliteOptions} from "./sqlite";
import {ScopedProcesses, type ProcessLimits, type ProcessRunOptions} from "./processes";
import {SettingsRegistry} from "./settings";
import {ScopedFiles} from "./files";
import { definePlugin, type PluginDefinition, type PluginContext, type PluginLogger, type MessageEnvelope, type TelegramPort } from "./sdk";

interface PluginStorage { json: StorageRoot; sqlite: Map<string, {store: SqliteStore; readonly: boolean; timeoutMs: number}>; }
interface LoadedPlugin { definition: PluginDefinition; scope: ResourceScope; storage: PluginStorage; context: PluginContext; ready: boolean; owner?: object; }
interface CommandTarget { plugin: LoadedPlugin; name: string; }

export interface HostOptions {
  storageRoot: string;
  tempRoot?: string;
  telegram: TelegramPort;
  logger: PluginLogger;
  prefixes?: readonly string[];
  aliases?: Readonly<Record<string, string>>;
  concurrency?: number;
  queueCapacity?: number;
  http?: ScopedHttpOptions;
  processes?: ProcessLimits;
}

export class PluginHost {
  private readonly root = new ResourceScope();
  private readonly executor: KeyedExecutor;
  private readonly scheduler: PluginScheduler;
  private readonly settings = new SettingsRegistry();
  private processes?: ScopedProcesses;
  private readonly plugins = new Map<string, LoadedPlugin>();
  private readonly commands = new Map<string, CommandTarget>();
  private prefixes: readonly string[] = [];
  private aliases: ReadonlyMap<string, string>;

  constructor(private readonly options: HostOptions) {
    this.replacePrefixes(options.prefixes === undefined ? ["."] : options.prefixes);
    this.aliases = new Map();
    this.replaceAliases(options.aliases ?? {});
    this.scheduler = new PluginScheduler(options.logger);
    this.executor = new KeyedExecutor(options.concurrency ?? 4, options.queueCapacity ?? 64, this.root.signal);
    this.root.add("plugins-executor-storage", async () => {
      const failures: unknown[] = [];
      await Promise.all([this.executor.close(), ...[...this.plugins.values()].map(async plugin => {
        let report: DrainReport;
        do { report = await plugin.scope.drain(); }
        while (report.pendingTasks || report.pendingResources);
        await this.closeStorage(plugin.storage);
        failures.push(...report.errors);
      })]);
      // Keep the cleanup pending across observation timeouts. Stores must not
      // close while a cancelled handler or its cleanup still owns them.
      this.plugins.clear();
      this.commands.clear();
      if (failures.length) throw new AggregateError(failures, "Plugin cleanup failures");
    });
  }

  listCommands(): {name: string; pluginId: string; description: string}[] {
    return [...this.commands].filter(([, target]) => target.plugin.ready).map(([name, target]) => ({
      name, pluginId: target.plugin.definition.id, description: target.plugin.definition.commands[target.name].description,
    })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }

  configuration() {
    return {prefixes: [...this.prefixes], aliases: Object.fromEntries(this.aliases)};
  }

  replacePrefixes(prefixes: readonly string[]): void {
    this.root.signal.throwIfAborted();
    if (!Array.isArray(prefixes) || !prefixes.length ||
        [...prefixes].some(prefix => typeof prefix !== "string" || !prefix || /[\s\0]/u.test(prefix))) {
      throw new Error("Non-empty command prefix tokens required");
    }
    this.prefixes = Object.freeze([...new Set(prefixes)]);
  }

  replaceAliases(aliases: Readonly<Record<string, string>>): void {
    this.root.signal.throwIfAborted();
    const entries = Object.entries(aliases);
    if (entries.some(([name, target]) => !name.trim() || typeof target !== "string" || !target.trim())) {
      throw new Error("Aliases require non-empty names and targets");
    }
    this.aliases = new Map(entries);
  }

  listPlugins() {
    return [...this.plugins.values()].filter(plugin => plugin.ready).map(({definition}) => ({
      id: definition.id, description: definition.description,
      commands: Object.entries(definition.commands).map(([name, command]) => ({name, description: command.description})),
      jobs: Object.entries(definition.jobs ?? {}).map(([name, job]) => ({name, cron: job.cron, description: job.description})),
    }));
  }

  listSettings() { return this.settings.list(); }
  settingsSchema(id: string) { return this.settings.schema(id); }
  readSettings(id: string) { return this.settings.read(id); }
  patchSettings(id: string, patch: unknown) { return this.settings.patch(id, patch); }

  pluginState(id: string, owner?: object): "active" | "draining" | undefined {
    const plugin = this.plugins.get(id);
    if (owner && plugin?.owner !== owner) return undefined;
    return plugin && (plugin.ready ? "active" : "draining");
  }

  assertCanUnload(id: string, timeoutMs = 15000, owner?: object): void {
    const plugin = this.plugins.get(id);
    if (owner && plugin?.owner !== owner) return;
    plugin?.scope.assertCanDrain(timeoutMs);
  }

  preflight(input: PluginDefinition, replacingId?: string): void {
    this.root.signal.throwIfAborted();
    const definition = definePlugin(input);
    if (this.plugins.has(definition.id) && definition.id !== replacingId) throw new Error("Plugin already loaded");
    for (const name of Object.keys(definition.commands)) {
      const target = this.commands.get(name);
      if (target && target.plugin.definition.id !== replacingId) throw new Error("Command conflict");
    }
  }

  private async closeStorage(storage: PluginStorage): Promise<void> {
    await Promise.all([storage.json.close(), ...[...storage.sqlite.values()].map(value => value.store.close())]);
    storage.sqlite.clear();
  }

  private contextFor(id: string, scope: ResourceScope, storage: PluginStorage): PluginContext {
    const combined = (signal: AbortSignal, caller?: AbortSignal) => caller ? AbortSignal.any([signal, caller]) : signal;
    return Object.freeze({
      signal: scope.signal, tasks: scope, log: this.options.logger,
      http: new ScopedHttp(scope, this.options.http),
      files: new ScopedFiles(scope, this.options.storageRoot, this.options.tempRoot ?? path.join(this.options.storageRoot, '.temp'), id),
      processes: {run: (command: string, args: readonly string[] = [], options: ProcessRunOptions = {}) =>
        scope.run("process:run", signal => {
          this.processes ??= new ScopedProcesses(this.root, this.options.processes);
          return this.processes.run(command, args, {...options, signal: combined(signal, options.signal)});
        })},
      storage: {json: <T extends Record<string, unknown>>(file: string, defaults: T): Pick<JsonStore<T>, "read" | "update"> => {
        const store = storage.json.json(id, file, defaults);
        return Object.freeze({
          read: (caller?: AbortSignal) => scope.run("storage:read", signal => store.read(combined(signal, caller))),
          update: (mutator: (current: T) => T | Promise<T>, caller?: AbortSignal) =>
            scope.run("storage:update", signal => store.update(mutator, combined(signal, caller))),
        });
      }, sqlite: (file: string, options: SqliteOptions = {}): Pick<SqliteStore, "read" | "transaction" | "preflight"> => {
        scope.signal.throwIfAborted();
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.(db|sqlite|sqlite3)$/.test(file)) throw new Error("Invalid plugin SQLite filename");
        let entry = storage.sqlite.get(file);
        const readonly = options.readonly ?? false;
        const timeoutMs = options.timeoutMs ?? 5000;
        if (entry && (entry.readonly !== readonly || entry.timeoutMs !== timeoutMs)) throw new Error("SQLite store options conflict");
        if (!entry) {
          entry = {store: new SqliteStore(path.join(this.options.storageRoot, id, file), options), readonly, timeoutMs};
          storage.sqlite.set(file, entry);
        }
        const store = entry.store;
        return Object.freeze({
          read: <T>(callback: (db: SqliteConnection) => T, caller?: AbortSignal) =>
            scope.run("sqlite:read", signal => store.read(callback, combined(signal, caller))),
          transaction: <T>(callback: (db: SqliteConnection) => T, caller?: AbortSignal) =>
            scope.run("sqlite:transaction", signal => store.transaction(callback, combined(signal, caller))),
          preflight: (required?: Readonly<Record<string, readonly string[]>>, caller?: AbortSignal) =>
            scope.run("sqlite:preflight", signal => store.preflight(required, combined(signal, caller))),
        });
      }},
      jobs: {register: (name: string, spec: ScheduledJob, handler: (signal: AbortSignal) => void | Promise<void>) =>
        this.scheduler.register(id, name, spec, scope, signal => this.executor.submit(`job:${id}:${name}`, () => {
          const plugin = this.plugins.get(id);
          if (plugin?.scope === scope && plugin.ready) return handler(signal);
        }, signal))},
      services: {
        available: (pluginId: string, service: string) => {
          const provider = this.plugins.get(pluginId);
          return !!provider?.ready && Object.hasOwn(provider.definition.services ?? {}, service);
        },
        call: <T>(pluginId: string, service: string, input: unknown, caller?: AbortSignal) => scope.run("service:call", signal => {
          const provider = this.plugins.get(pluginId);
          if (!provider?.ready || !Object.hasOwn(provider.definition.services ?? {}, service)) throw new Error("Plugin service unavailable");
          const handler = provider.definition.services![service];
          return provider.scope.run(`service:${service}`, providerSignal => {
            const callSignal = AbortSignal.any([signal, providerSignal, ...(caller ? [caller] : [])]);
            callSignal.throwIfAborted();
            return handler.handle(input, provider.context, callSignal);
          }) as Promise<T>;
        }),
      },
      telegram: {
        edit: (message: MessageEnvelope, text: string, options = {}) => scope.run("telegram:edit", signal => this.options.telegram.edit(message, text, options, signal)),
        reply: (message: MessageEnvelope, text: string, options = {}) => scope.run("telegram:reply", signal => this.options.telegram.reply(message, text, options, signal)),
        invoke: (request: unknown) => scope.run("telegram:invoke", signal => this.options.telegram.invoke(request, signal)),
        getReply: (message: MessageEnvelope) => scope.run("telegram:reply-read", signal => this.options.telegram.getReply(message, signal)),
        withClient: <T>(operation: (client: TelegramClient, signal: AbortSignal) => Promise<T>) =>
          scope.run("telegram:native", signal => this.options.telegram.withClient(operation, signal)),
      },
    });
  }

  async load(input: PluginDefinition, owner?: object): Promise<void> {
    this.root.signal.throwIfAborted();
    const definition = definePlugin(input);
    if (this.plugins.has(definition.id)) throw new Error(`Plugin already loaded: ${definition.id}`);
    for (const name of Object.keys(definition.commands)) {
      if (this.commands.has(name)) throw new Error(`Command conflict: ${name}`);
    }
    const scope = new ResourceScope(this.root.signal);
    const storage: PluginStorage = {json: new StorageRoot(this.options.storageRoot), sqlite: new Map()};
    const context = this.contextFor(definition.id, scope, storage);
    const plugin: LoadedPlugin = {definition, scope, storage, context, ready: false, owner};
    this.plugins.set(definition.id, plugin);
    // Reserve names before asynchronous setup so concurrent loads cannot collide.
    for (const name of Object.keys(definition.commands)) this.commands.set(name, {plugin, name});
    let finishSetup!: () => void;
    const setupSettled = new Promise<void>(resolve => { finishSetup = resolve; });
    if (definition.cleanup) scope.add("plugin:cleanup", async () => {
      await setupSettled;
      await definition.cleanup!(context);
    });
    try {
      try { await scope.run("plugin:setup", () => definition.setup?.(context)); }
      finally { finishSetup(); }
      this.root.signal.throwIfAborted();
      scope.signal.throwIfAborted();
      if (definition.settings) this.settings.register(definition.id, definition.settings(context), scope);
      for (const [name, job] of Object.entries(definition.jobs ?? {})) {
        await context.jobs.register(name, job, signal => job.handle(context, signal));
      }
      this.root.signal.throwIfAborted();
      scope.signal.throwIfAborted();
      plugin.ready = true;
    } catch (error) {
      const report = await scope.drain();
      if (!report.pendingTasks && !report.pendingResources) await this.closeStorage(storage);
      if (report.completed) this.remove(plugin);
      throw error;
    }
  }

  private remove(plugin: LoadedPlugin): void {
    if (this.plugins.get(plugin.definition.id) === plugin) this.plugins.delete(plugin.definition.id);
    for (const [name, target] of this.commands) if (target.plugin === plugin) this.commands.delete(name);
  }

  async unload(id: string, timeoutMs = 15000, owner?: object): Promise<DrainReport | undefined> {
    const plugin = this.plugins.get(id);
    if (!plugin || owner && plugin.owner !== owner) return undefined;
    plugin.scope.assertCanDrain(timeoutMs);
    plugin.ready = false;
    const report = await plugin.scope.drain(timeoutMs);
    if (!report.pendingTasks && !report.pendingResources) await this.closeStorage(plugin.storage);
    if (report.completed) this.remove(plugin);
    return report;
  }

  private parse(text: string): {prefix: string; command: string; args: string[]; text: string} | undefined {
    const prefix = this.prefixes.find(candidate => text.startsWith(candidate));
    if (prefix === undefined) return;
    const parts = text.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return;
    for (let length = parts.length; length > 0; length--) {
      const alias = parts.slice(0, length).join(" ");
      if (length === 1 && this.commands.has(alias)) continue;
      const expansion = this.aliases.get(alias);
      if (expansion) {
        const expanded = [...expansion.trim().split(/\s+/), ...parts.slice(length)];
        return {prefix, command: expanded[0], args: expanded.slice(1), text: prefix + expanded.join(" ")};
      }
    }
    if (!/^[a-z0-9_]+$/i.test(parts[0])) return;
    return {prefix, command: parts[0], args: parts.slice(1), text};
  }

  // Network admission must provide an authenticated envelope. Other users'
  // commands go through the separate sudo/sure policy, never this primary path.
  dispatchPrimary(message: MessageEnvelope): Promise<boolean> {
    if (this.root.signal.aborted) return Promise.reject(new ExecutorClosedError());
    if (!message.outgoing && !message.saved) return Promise.resolve(false);
    const parsed = this.parse(message.text);
    if (!parsed) return Promise.resolve(false);
    const target = this.commands.get(parsed.command);
    if (!target?.plugin.ready) return Promise.resolve(false);
    const command = target.plugin.definition.commands[target.name];
    if (message.edited && (command.ignoreEdited ?? true)) return Promise.resolve(false);
    const snapshot = Object.freeze({...message, text: parsed.text});
    const plugin = target.plugin;
    return plugin.scope.run(`command:${target.name}`, () => this.executor.submit(message.chatId, async () => {
      plugin.scope.signal.throwIfAborted();
      await command.handle({message: snapshot, command: target.name, prefix: parsed.prefix, args: Object.freeze(parsed.args)}, plugin.context);
      return true;
    }, plugin.scope.signal));
  }

  dispatchListeners(message: MessageEnvelope): Promise<void> {
    if (this.root.signal.aborted) return Promise.reject(new ExecutorClosedError());
    const snapshot = Object.freeze({...message});
    const work: Promise<unknown>[] = [];
    for (const plugin of this.plugins.values()) {
      if (!plugin.ready) continue;
      for (const listener of plugin.definition.listeners ?? []) {
        if (message.edited && !listener.edited) continue;
        if (listener.ignoreCommands && (message.text.trimStart().startsWith("/") ||
            this.prefixes.some(prefix => message.text.trimStart().startsWith(prefix)))) continue;
        work.push(plugin.scope.run(`listener:${plugin.definition.id}`, () => this.executor.submit(message.chatId,
          () => listener.handle(snapshot, plugin.context), plugin.scope.signal)));
      }
    }
    return Promise.allSettled(work).then(results => {
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Message listener failures");
    });
  }

  snapshot() { return {plugins: this.plugins.size, commands: this.commands.size, queue: this.executor.snapshot(), jobs: this.scheduler.snapshot(), processes: this.processes?.snapshot(), lifecycle: this.root.snapshot()}; }
  async shutdown(timeoutMs = 15000): Promise<DrainReport> {
    this.root.assertCanDrain(timeoutMs);
    for (const plugin of this.plugins.values()) plugin.scope.assertCanDrain(timeoutMs);
    for (const plugin of this.plugins.values()) plugin.ready = false;
    return this.root.drain(timeoutMs);
  }
}
