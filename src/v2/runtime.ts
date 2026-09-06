import path from "node:path";
import * as fs from "node:fs/promises";
import {TelegramClient, Api} from "teleproto";
import {StringSession} from "teleproto/sessions";
import {Logger, LogLevel as NativeLogLevel, type LogRecord} from "teleproto/extensions/Logger";
import {PluginHost} from "./host";
import {ResourceScope, type DrainReport} from "./lifecycle";
import {RuntimeLogger, LogLevel} from "./logging";
import {PrefixEnvStore, prefixesFromEnv} from "./prefixes";
import {createHelp} from "./builtins/help";
import {createAlias} from "./builtins/alias";
import {createPrefix} from "./builtins/prefix";
import {createLogLevel} from "./builtins/loglevel";
import createMemory from "./builtins/memory";
import createPing from "./builtins/ping";
import createStatus from "./builtins/status";
import createEnv from "./builtins/env";
import createSysinfo from "./builtins/sysinfo";
import createVersion from "./builtins/version";
import createRe from "./builtins/re";
import createAgent from "./builtins/agent";
import createExec from "./builtins/exec";
import createReload from "./builtins/reload";
import createBf from "./builtins/bf";
import createLeech from "./builtins/leech";
import createSudo from "./builtins/sudo";
import createSure from "./builtins/sure";
import createTpm from "./builtins/tpm";
import createUpdate from "./builtins/update";
import createAutofix from "./builtins/autofix";
import {prepareArtifact, type PreparedArtifact} from "./artifacts";
import {TeleprotoPort, subscribeMessages} from "./telegram";
import {AccountError, assertLegacyStopped, lockAccount, readAccount, readEnvironment} from "./account";
import {installProtocolCompatibility, type ProtocolCompatibility, type ProtocolLogDecision} from "./protocol-compat";

export const DAILY_PLUGINS = Object.freeze(["ai", "da", "dc", "dme", "gt", "ids", "ip", "nodeseek", "rate", "sum", "yvlu"] as const);
export interface RuntimeOptions {
  root?: string;
  pluginRoot?: string;
  signals?: readonly NodeJS.Signals[];
}
export interface RuntimeResult {
  reason: string;
  plugins: readonly string[];
  lifecycle: {host: DrainReport; events: DrainReport; transport: DrainReport; logging: DrainReport};
}

function logLine(level: "info" | "error", event: string, fields?: Readonly<Record<string, string | number | boolean>>): void {
  const line = JSON.stringify({time: new Date().toISOString(), level, event, ...fields}) + "\n";
  (level === "error" ? process.stderr : process.stdout).write(line);
}

function protocolSink(compatibility: () => ProtocolCompatibility | undefined): (record: LogRecord) => void {
  return record => {
    const decision: ProtocolLogDecision = compatibility()?.handleLog({message: record.message, error: record.error}) ?? "pass";
    if (decision === "suppress") return;
    const level = decision === "warn" || record.level === NativeLogLevel.WARN ? "info" : record.level === NativeLogLevel.ERROR ? "error" : "info";
    logLine(level, decision === "warn" ? "telegram.channel_gap" : "telegram.protocol", {nativeLevel: record.level});
  };
}

async function loadDaily(host: PluginHost, root: string, prepared: PreparedArtifact[]): Promise<void> {
  for (const id of DAILY_PLUGINS) {
    const artifact = await prepareArtifact(path.join(root, id));
    if (artifact.artifact.manifest.id !== id) {
      artifact.release();
      throw new Error("Plugin artifact identity mismatch");
    }
    prepared.push(artifact);
    await host.load(artifact.create());
  }
}

function waitForStop(signals: readonly NodeJS.Signals[], scope: ResourceScope): Promise<string> {
  return new Promise(resolve => {
    let settled = false;
    const handlers = new Map<NodeJS.Signals, () => void>();
    const finish = (reason: string): void => {
      if (settled) return;
      settled = true;
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      resolve(reason);
    };
    for (const signal of signals) {
      const handler = (): void => finish(signal);
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
    scope.add("runtime:signal-listeners", () => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      finish("scope");
    });
  });
}

function requireComplete(name: string, report: DrainReport): void {
  if (!report.completed) throw new Error(`${name} did not stop cleanly`);
}

export async function serve(options: RuntimeOptions = {}): Promise<RuntimeResult> {
  if (process.platform !== "linux") throw new AccountError("PLATFORM");
  const root = await fs.realpath(options.root ?? process.cwd());
  const pluginRoot = await fs.realpath(options.pluginRoot ?? path.join(root, "dist/v2-plugins-active"));
  await assertLegacyStopped(root);
  const configuration = await readAccount(root);
  const environment = await readEnvironment(root, process.env);
  const session = new StringSession(configuration.session);
  await session.load();
  const key = session.authKey?.getKey();
  if (!key) throw new AccountError("CONFIG");
  const releaseLock = await lockAccount(key);
  const transport = new ResourceScope();
  const events = new ResourceScope();
  const logging = new ResourceScope();
  const rootScope = new ResourceScope();
  let compatibility: ProtocolCompatibility | undefined;
  const nativeLogger = new Logger(NativeLogLevel.WARN);
  nativeLogger.handler = protocolSink(() => compatibility);
  const logger = new RuntimeLogger(path.join(root, "assets/logger/config.json"), {
    write(level, event, fields) {logLine(level >= LogLevel.ERROR ? "error" : "info", event, fields);},
  }, logging);
  const client = new TelegramClient(session, configuration.apiId, configuration.apiHash, {
    deviceModel: configuration.deviceModel, proxy: configuration.proxy,
    baseLogger: nativeLogger, connectionRetries: 5, reconnectRetries: Infinity,
    requestRetries: 5, autoReconnect: true, timeout: 10,
  });
  let host: PluginHost | undefined;
  let detach: (() => Promise<void>) | undefined;
  const prepared: PreparedArtifact[] = [];
  let reason = "startup-failed";
  let failure: unknown;
  let lifecycle: RuntimeResult["lifecycle"] | undefined;
  try {
    compatibility = installProtocolCompatibility(client);
    await client.connect();
    if (!await client.checkAuthorization()) throw new AccountError("CONFIG");
    const me = await client.getMe();
    if (!(me instanceof Api.User) || !me.self || me.bot) throw new AccountError("CONFIG");
    const selfId = me.id.toString();
    await logger.initialize();
    client.setLogLevel(logger.getProtocolLevel() as NativeLogLevel);
    host = new PluginHost({storageRoot: path.join(root, "assets"), tempRoot: path.join(root, "temp"),
      telegram: new TeleprotoPort(client, transport, {selfId}), logger, prefixes: prefixesFromEnv(environment)});
    await host.load(createHelp(host));
    await host.load(createAlias(host));
    await host.load(createPrefix(host, new PrefixEnvStore(path.join(root, ".env"))));
    await host.load(createLogLevel(logger));
    await host.load(createMemory());
    await host.load(createPing());
    await host.load(createStatus());
    await host.load(createEnv());
    await host.load(createSysinfo());
    await host.load(createVersion(root));
    await host.load(createRe());
    await host.load(createAgent());
    await host.load(createExec());
    await host.load(createReload());
    await host.load(createBf(root));
    await host.load(createLeech());
    await host.load(createSudo());
    await host.load(createSure());
    await host.load(createTpm());
    await host.load(createUpdate(root));
    await host.load(createAutofix(root));
    await loadDaily(host, pluginRoot, prepared);
    detach = await subscribeMessages(client, events, async (message, signal) => {
      signal.throwIfAborted();
      try {
        await host!.dispatchPrimary(message);
        signal.throwIfAborted();
        await host!.dispatchListeners(message);
      } catch (error) {
        if (!signal.aborted) logger.error("runtime.message_failed", {kind: error instanceof Error ? error.name : "unknown"});
      }
    }, {selfId});
    logLine("info", "runtime.ready", {plugins: DAILY_PLUGINS.length, builtins: 21});
    reason = await waitForStop(options.signals ?? ["SIGINT", "SIGTERM"], rootScope);
  } catch (error) {
    failure = error;
  } finally {
    const failures: unknown[] = [];
    const attempt = async (operation: () => void | Promise<void>): Promise<void> => {try {await operation();} catch (error) {failures.push(error);}};
    await attempt(() => rootScope.drain(5000).then(report => requireComplete("runtime", report)));
    await attempt(async () => {if (detach) await detach();});
    let eventReport = events.snapshot();
    let hostReport = host ? host.snapshot().lifecycle : rootScope.snapshot();
    let transportReport = transport.snapshot();
    let loggingReport = logging.snapshot();
    await attempt(async () => {eventReport = await events.drain(15000); requireComplete("events", eventReport);});
    await attempt(async () => {if (host) {hostReport = await host.shutdown(30000); requireComplete("host", hostReport);}});
    if (hostReport.completed) for (const artifact of prepared.reverse()) await attempt(() => artifact.release());
    await attempt(async () => {transportReport = await transport.drain(15000); requireComplete("transport", transportReport);});
    await attempt(async () => {loggingReport = await logging.drain(15000); requireComplete("logging", loggingReport);});
    await attempt(() => client.destroy());
    compatibility?.cleanup();
    await attempt(releaseLock);
    lifecycle = {host: hostReport, events: eventReport, transport: transportReport, logging: loggingReport};
    if (failures.length) failure = failure === undefined ? new AggregateError(failures, "Runtime shutdown failed")
      : new AggregateError([failure, ...failures], "Runtime and shutdown failed");
  }
  if (failure !== undefined) throw failure;
  return {reason, plugins: [...DAILY_PLUGINS], lifecycle: lifecycle!};
}
