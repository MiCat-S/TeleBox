import {mkdtemp, realpath, readFile, rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {parse as parseEnv} from "dotenv";
import type {TelegramClient} from "teleproto";
import {PluginHost} from "./host";
import {createHelp} from "./builtins/help";
import {createAlias} from "./builtins/alias";
import {createPrefix} from "./builtins/prefix";
import {createLogLevel} from "./builtins/loglevel";
import {PrefixEnvStore, prefixesFromEnv} from "./prefixes";
import {ResourceScope} from "./lifecycle";
import {RuntimeLogger, LogLevel} from "./logging";
import {definePlugin, PLUGIN_API_VERSION, type MessageEnvelope, type TelegramPort} from "./sdk";
import createMemory from "./builtins/memory";

export async function offlineCheck() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "telebox-v2-check-")));
  const messages: string[] = [];
  const loggerScope = new ResourceScope();
  const logger = new RuntimeLogger(path.join(directory, "assets/logger/config.json"), {write() {}}, loggerScope);
  const nativeLevels: string[] = [];
  const native = {setLogLevel(level: string) {nativeLevels.push(level);}} as TelegramClient;
  const telegram: TelegramPort = {
    async edit(_message, text) {messages.push(text);},
    async reply(_message, text) {messages.push(text);},
    async getReply() {return undefined;},
    async invoke() {throw new Error("Network operations are unavailable during the offline check");},
    async withClient(operation, signal) {return operation(native, signal);},
  };
  const host = new PluginHost({storageRoot: path.join(directory, "assets"), telegram, logger});
  const source: MessageEnvelope = {id: 1, chatId: "1", senderId: "1", outgoing: true, text: ".probe"};
  let probeCalls = 0;
  let serviceCalls = 0;
  let stopped = false;
  try {
    await host.load(definePlugin({apiVersion: 1, id: "check", description: "Offline integration fixture",
      commands: {probe: {description: "Offline probe", async handle(_input, context) {
        const answer = await context.services.call("check", "echo", "ok");
        if (answer !== "ok") throw new Error("Plugin service check failed");
        probeCalls++;
      }}},
      services: {echo: {description: "Offline service", handle(input) {serviceCalls++; return input;}}},
    }));
    await host.load(createHelp(host));
    await host.load(createAlias(host));
    await host.load(createPrefix(host, new PrefixEnvStore(path.join(directory, ".env"))));
    await host.load(createLogLevel(logger));
    await host.load(createMemory());
    await host.dispatchPrimary({...source, text: ".alias set smoke probe"});
    await host.dispatchPrimary({...source, text: ".smoke"});
    await host.dispatchPrimary({...source, text: ".help"});
    await host.dispatchPrimary({...source, text: ".loglevel warning"});
    if (!(await host.unload("loglevel"))?.completed) throw new Error("Offline logging unload failed");
    await host.load(createLogLevel(logger));
    if (logger.getLevel() !== LogLevel.WARNING || nativeLevels.join() !== "warn") throw new Error("Offline logging persistence check failed");
    await host.dispatchPrimary({...source, text: ".prefix set !"});
    if (await host.dispatchPrimary(source)) throw new Error("Old command prefix remains active");
    const savedPrefixes = prefixesFromEnv(parseEnv(await readFile(path.join(directory, ".env"))));
    if (savedPrefixes.join() !== "!" || host.configuration().prefixes.join() !== "!") throw new Error("Offline prefix persistence check failed");
    await host.dispatchPrimary({...source, text: "!smoke"});
    const denied = !await host.dispatchPrimary({...source, text: "!probe", outgoing: false});
    const editedDenied = !await host.dispatchPrimary({...source, text: "!probe", edited: true});
    if (probeCalls !== 2 || serviceCalls !== 2 || !denied || !editedDenied || messages.length < 4) {
      throw new Error("Offline command integration check failed");
    }
    const beforeReload = host.configuration().aliases;
    const unloaded = await host.unload("alias");
    if (!unloaded?.completed) throw new Error("Offline alias unload failed");
    await host.load(createAlias(host));
    if (host.configuration().aliases.smoke !== beforeReload.smoke) throw new Error("Offline alias persistence check failed");
    const loaded = host.listPlugins().map(plugin => plugin.id).sort();
    const lifecycle = await host.shutdown();
    const loggingLifecycle = await loggerScope.drain();
    stopped = lifecycle.completed && loggingLifecycle.completed;
    if (!stopped) throw new Error("Offline runtime did not stop cleanly");
    const compilerResident = Object.keys(require.cache).some(filename =>
      /[/\\]node_modules[/\\](?:esbuild|typescript|tsx)(?:[/\\]|$)/.test(filename));
    if (compilerResident) throw new Error("A runtime compiler was loaded during the offline check");
    return {mode: "offline-check", pluginApiVersion: PLUGIN_API_VERSION, result: "ok", loaded,
      checks: {commands: true, services: true, help: true, aliases: true, sqliteReload: true,
        prefixes: true, prefixPersistence: true, logging: true, loggingReload: true,
        ownerAdmission: true, editedAdmission: true, compilerResident}, lifecycle};
  } finally {
    if (!stopped) {
      const lifecycle = await host.shutdown();
      const loggingLifecycle = await loggerScope.drain();
      stopped = lifecycle.completed && loggingLifecycle.completed;
    }
    // Never remove files still owned by unfinished work, even in a test-only runtime.
    if (stopped) await rm(directory, {recursive: true, force: true});
  }
}
