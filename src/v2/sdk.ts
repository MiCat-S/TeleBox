import type { ResourceScope } from "./lifecycle";
import type { JsonStore } from "./storage";
import type { ScheduledJob } from "./scheduler";
import type { ScopedHttp } from "./http";
import type { TelegramClient } from "teleproto";
import type { SqliteStore, SqliteOptions } from "./sqlite";
import type {ScopedProcesses} from "./processes";
import type {SettingsAdapter} from "./settings";
import type {ScopedFiles} from "./files";

export const PLUGIN_API_VERSION = 1 as const;

export interface MessageEnvelope {
  readonly id: number;
  readonly chatId: string;
  readonly senderId?: string;
  readonly text: string;
  readonly outgoing: boolean;
  readonly saved?: boolean;
  readonly edited?: boolean;
  readonly forwarded?: boolean;
  readonly replyToId?: number;
  readonly topicId?: number;
  readonly raw?: unknown;
}

/** Omitted parseMode means literal text, independent of the client's global default. */
export interface MessageOptions { parseMode?: "html" | "markdown"; linkPreview?: boolean; }

// The transport is supplied by the authenticated account runtime. The SDK
// never creates another client or imports the protocol library at module load.
export interface TelegramPort {
  edit(message: MessageEnvelope, text: string, options: MessageOptions, signal: AbortSignal): Promise<void>;
  reply(message: MessageEnvelope, text: string, options: MessageOptions, signal: AbortSignal): Promise<void>;
  invoke(request: unknown, signal: AbortSignal): Promise<unknown>;
  getReply(message: MessageEnvelope, signal: AbortSignal): Promise<MessageEnvelope | undefined>;
  withClient<T>(operation: (client: TelegramClient, signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T>;
}

export interface PluginLogger {
  info(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
  error(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
}

export interface PluginContext {
  readonly signal: AbortSignal;
  readonly tasks: ResourceScope;
  readonly telegram: {
    edit(message: MessageEnvelope, text: string, options?: MessageOptions): Promise<void>;
    reply(message: MessageEnvelope, text: string, options?: MessageOptions): Promise<void>;
    invoke(request: unknown): Promise<unknown>;
    getReply(message: MessageEnvelope): Promise<MessageEnvelope | undefined>;
    withClient<T>(operation: (client: TelegramClient, signal: AbortSignal) => Promise<T>): Promise<T>;
  };
  readonly storage: {
    json<T extends Record<string, unknown>>(fileName: string, defaults: T): Pick<JsonStore<T>, "read" | "update">;
    sqlite(fileName: string, options?: SqliteOptions): Pick<SqliteStore, "read" | "transaction" | "preflight">;
  };
  readonly jobs: {
    register(id: string, spec: ScheduledJob, handler: (signal: AbortSignal) => void | Promise<void>): Promise<() => Promise<void>>;
  };
  readonly services: {
    available(pluginId: string, service: string): boolean;
    call<T = unknown>(pluginId: string, service: string, input: unknown, signal?: AbortSignal): Promise<T>;
  };
  readonly http: Pick<ScopedHttp, "withResponse" | "text" | "json">;
  readonly processes: Pick<ScopedProcesses, "run">;
  readonly files: Pick<ScopedFiles, "dataDirectory" | "dataFile" | "withTemp">;
  readonly log: PluginLogger;
}

export interface CommandInvocation {
  readonly message: MessageEnvelope;
  readonly command: string;
  readonly prefix: string;
  readonly args: readonly string[];
}

export interface CommandDefinition {
  readonly description: string;
  readonly ignoreEdited?: boolean;
  handle(invocation: CommandInvocation, context: PluginContext): void | Promise<void>;
}

export interface MessageListener {
  readonly edited?: boolean;
  handle(message: MessageEnvelope, context: PluginContext): void | Promise<void>;
}

export interface JobDefinition extends ScheduledJob {
  handle(context: PluginContext, signal: AbortSignal): void | Promise<void>;
}

export interface ServiceDefinition {
  readonly description: string;
  handle(input: unknown, context: PluginContext, signal: AbortSignal): unknown | Promise<unknown>;
}

export interface PluginDefinition {
  readonly apiVersion: typeof PLUGIN_API_VERSION;
  readonly id: string;
  readonly description: string;
  readonly commands: Readonly<Record<string, CommandDefinition>>;
  readonly listeners?: readonly MessageListener[];
  readonly jobs?: Readonly<Record<string, JobDefinition>>;
  readonly services?: Readonly<Record<string, ServiceDefinition>>;
  readonly settings?: (context: PluginContext) => SettingsAdapter;
  setup?(context: PluginContext): void | Promise<void>;
  cleanup?(context: PluginContext): void | Promise<void>;
}

export function definePlugin(definition: PluginDefinition): PluginDefinition {
  if (definition.apiVersion !== PLUGIN_API_VERSION) throw new Error("Unsupported plugin API version");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(definition.id)) throw new Error("Invalid plugin id");
  if (typeof definition.description !== "string" || !definition.commands || typeof definition.commands !== "object") {
    throw new Error("Plugin description and commands are required");
  }
  const commands: Record<string, CommandDefinition> = Object.create(null);
  for (const [name, value] of Object.entries(definition.commands)) {
    if (!/^[a-z0-9_]+$/i.test(name) || !value || typeof value.handle !== "function" || typeof value.description !== "string") {
      throw new Error(`Invalid command definition: ${name}`);
    }
    commands[name] = Object.freeze({...value});
  }
  if (definition.listeners?.some(listener => typeof listener?.handle !== "function")) throw new Error("Invalid message listener");
  if (definition.settings !== undefined && typeof definition.settings !== "function") throw new Error("Invalid settings factory");
  for (const [name, service] of Object.entries(definition.services ?? {})) {
    if (!/^[a-z0-9_]+$/i.test(name) || !service || typeof service.description !== "string" || typeof service.handle !== "function") {
      throw new Error("Invalid service definition");
    }
  }
  for (const [name, job] of Object.entries(definition.jobs ?? {})) {
    if (!/^[a-z0-9_]+$/i.test(name) || !job || typeof job.cron !== "string" || typeof job.description !== "string" || typeof job.handle !== "function") {
      throw new Error("Invalid scheduled job definition");
    }
  }
  const freezeEntries = <T extends object>(entries: Readonly<Record<string, T>> | undefined) => entries &&
    Object.freeze(Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, Object.freeze({...value})])));
  return Object.freeze({...definition, commands: Object.freeze(commands),
    listeners: definition.listeners && Object.freeze(definition.listeners.map(listener => Object.freeze({...listener}))),
    jobs: freezeEntries(definition.jobs), services: freezeEntries(definition.services),
  });
}
