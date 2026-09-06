import test from "node:test";
import assert from "node:assert/strict";
import createTpm from "./tpm";
import type {PluginHost} from "../host";
import type {PluginReleases} from "../releases";
import type {PluginContext} from "../sdk";

function fixture() {
  const edits: string[] = [];
  const operations: string[] = [];
  const generations: {id: string; state: string}[] = [];
  const host = {pluginState: (id: string) => ["ai", "gt"].includes(id) || generations.some(g => g.id === id) ? "active" : undefined};
  const releases = {snapshot: () => ({generations}), async activate(id: string) {
    operations.push(`activate:${id}`); generations.push({id, state: "active"});
  }, async remove(id: string) {operations.push(`remove:${id}`); generations.splice(0);}};
  const ctx = {signal: new AbortController().signal, telegram: {async edit(_m: unknown, text: string) {edits.push(text);},
    async reply(_m: unknown, text: string) {edits.push(text);}},
    processes: {async run(_command: string, args: string[]) {
      operations.push(args[1]);
      return {stdout: Buffer.from(JSON.stringify(args[1] === "search" ? {ids: ["ai", "gt", "dig"]} :
        {id: args[2], revision: "a".repeat(64)}))};
    }}};
  const plugin = createTpm(host as unknown as PluginHost, releases as unknown as PluginReleases, "/fixture", "1");
  const run = (args: string[], senderId = "1") => plugin.commands.tpm.handle({
    command: "tpm", prefix: ".", args, message: {id: 1, chatId: "1", senderId, text: ".tpm", outgoing: true},
  }, ctx as unknown as PluginContext);
  return {run, edits, operations, generations};
}
test("TPM installs and removes an extension, and lists actual loaded selections", async () => {
  const f = fixture();
  await f.run(["install", "dig"]);
  await f.run(["list"]);
  assert.match(f.edits.at(-1)!, /dig/);
  await f.run(["remove", "dig"]);
  assert.deepEqual(f.operations, ["build", "activate:dig", "remove:dig"]);
});
test("TPM protects defaults and rejects unprivileged or invalid install requests", async () => {
  const f = fixture();
  await f.run(["install", "dig"], "2");
  await f.run(["install", "../dig"]);
  await f.run(["remove", "ai"]);
  assert.deepEqual(f.operations, []);
});
test("TPM searches V2 entries in the plugin repository and excludes defaults", async () => {
  const f = fixture();
  await f.run(["search"]);
  assert.match(f.edits.at(-1)!, /dig/);
  assert.doesNotMatch(f.edits.at(-1)!, /ai|gt/);
});
