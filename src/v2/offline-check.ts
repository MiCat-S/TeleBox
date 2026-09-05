import {mkdtemp, realpath, rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {PluginHost} from "./host";
import {createHelp} from "./builtins/help";
import {createAlias} from "./builtins/alias";
import {definePlugin, PLUGIN_API_VERSION, type MessageEnvelope, type TelegramPort} from "./sdk";

export async function offlineCheck() {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "telebox-v2-check-")));
  const messages: string[] = [];
  const logger = {info() {}, error() {}};
  const telegram: TelegramPort = {
    async edit(_message, text) {messages.push(text);},
    async reply(_message, text) {messages.push(text);},
    async getReply() {return undefined;},
    async invoke() {throw new Error("Network operations are unavailable during the offline check");},
    async withClient() {throw new Error("Native clients are unavailable during the offline check");},
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
    await host.dispatchPrimary({...source, text: ".alias set smoke probe"});
    await host.dispatchPrimary({...source, text: ".smoke"});
    await host.dispatchPrimary({...source, text: ".help"});
    const denied = !await host.dispatchPrimary({...source, outgoing: false});
    const editedDenied = !await host.dispatchPrimary({...source, edited: true});
    if (probeCalls !== 1 || serviceCalls !== 1 || !denied || !editedDenied || messages.length < 2) {
      throw new Error("Offline command integration check failed");
    }
    const beforeReload = host.configuration().aliases;
    const unloaded = await host.unload("alias");
    if (!unloaded?.completed) throw new Error("Offline alias unload failed");
    await host.load(createAlias(host));
    if (host.configuration().aliases.smoke !== beforeReload.smoke) throw new Error("Offline alias persistence check failed");
    const loaded = host.listPlugins().map(plugin => plugin.id).sort();
    const lifecycle = await host.shutdown();
    stopped = lifecycle.completed;
    if (!stopped) throw new Error("Offline runtime did not stop cleanly");
    const compilerResident = Object.keys(require.cache).some(filename =>
      /[/\\]node_modules[/\\](?:esbuild|typescript|tsx)(?:[/\\]|$)/.test(filename));
    if (compilerResident) throw new Error("A runtime compiler was loaded during the offline check");
    return {mode: "offline-check", pluginApiVersion: PLUGIN_API_VERSION, result: "ok", loaded,
      checks: {commands: true, services: true, help: true, aliases: true, sqliteReload: true,
        ownerAdmission: true, editedAdmission: true, compilerResident}, lifecycle};
  } finally {
    if (!stopped) stopped = (await host.shutdown()).completed;
    // Never remove files still owned by unfinished work, even in a test-only runtime.
    if (stopped) await rm(directory, {recursive: true, force: true});
  }
}
