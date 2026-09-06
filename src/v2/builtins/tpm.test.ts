import test from "node:test";
import assert from "node:assert/strict";
import createTpm from "./tpm";
import {PluginHost} from "../host";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {PluginReleases} from "../releases";
import type {PluginContext} from "../sdk";

function fixture() {
  const edits: string[] = [];
  const operations: string[] = [];
  const failures: unknown[] = [];
  const generations: {id: string; state: string}[] = [];
  const host = {pluginState: (id: string) => ["ai", "gt"].includes(id) || generations.some(g => g.id === id) ? "active" : undefined};
  const releases = {snapshot: () => ({generations}), async activate(id: string) {
    operations.push(`activate:${id}`); generations.push({id, state: "active"});
  }, async remove(id: string) {operations.push(`remove:${id}`); generations.splice(0);}};
  const ctx = {signal: new AbortController().signal, log: {error: (_event: string, fields: unknown) => failures.push(fields)},
    telegram: {async edit(_m: unknown, text: string) {edits.push(text);},
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
  return {run, edits, operations, generations, ctx, failures};
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
test("TPM reports failure stage and known code without exposing private process errors", async () => {
  const f = fixture();
  f.ctx.processes.run = async () => {throw Object.assign(new Error("secret-token"), {code: "TIMED_OUT"});};
  await f.run(["install", "dig"]);
  assert.match(f.edits.at(-1)!, /repository \/ TIMED_OUT/);
  assert.doesNotMatch(f.edits.join(""), /secret-token/);
  assert.deepEqual(f.failures, [{stage: "repository", code: "TIMED_OUT"}]);
});

test("TPM repository search runs through the real host process limits", async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mibot-tpm-")));
  await fs.mkdir(path.join(root, "scripts"));
  await fs.writeFile(path.join(root, "scripts/plugin-repository.cjs"),
    'console.log(JSON.stringify({ids:["dig","subinfo"]}));\n');
  const edits: string[] = [];
  const host = new PluginHost({storageRoot: path.join(root, "assets"),
    logger: {info() {}, error() {}},
    telegram: {async edit(_message, text) {edits.push(text);}, async reply() {},
      async invoke() {throw new Error("unexpected");}, async getReply() {return undefined;},
      async withClient() {throw new Error("unexpected");}}});
  t.after(async () => {await host.shutdown(1000); await fs.rm(root, {recursive: true, force: true});});
  const releases = {snapshot: () => ({generations: []})} as unknown as PluginReleases;
  await host.load(createTpm(host, releases, root, "1"));
  await host.dispatchPrimary({id: 1, chatId: "1", senderId: "1", outgoing: true, text: ".tpm search"});
  assert.match(edits.at(-1)!, /dig · subinfo/);
  assert.doesNotMatch(edits.at(-1)!, /失败/);
});
