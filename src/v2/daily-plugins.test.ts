import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, realpath, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {TelegramClient} from "teleproto";
import {prepareArtifact, type PreparedArtifact} from "./artifacts";
import {PluginHost} from "./host";
import type {MessageEnvelope, TelegramPort} from "./sdk";
import {DAILY_PLUGINS} from "./runtime";

test("daily artifact set loads, exposes all commands and handles offline control paths", async () => {
  const root = await realpath(path.resolve(__dirname, "../.."));
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "telebox-v2-daily-")));
  const output: string[] = [];
  const deleted: number[][] = [];
  const files: string[] = [];
  let historyReads = 0;
  let finishDa!: () => void;
  const daFinished = new Promise<void>(resolve => {finishDa = resolve;});
  const reply: MessageEnvelope = {id: 88, chatId: "-100123", senderId: "1", text: "quoted text", outgoing: false,
    raw: {className: "Message", id: 88, peerId: "-100123", senderId: 1n, message: "quoted text", out: false,
      sender: {className: "User", id: 1n, firstName: "Alice"}, entities: []}};
  const native = {
    setLogLevel() {},
    async getEntity() {return {className: "Channel", id: 123n, title: "Fixture Group", username: "fixture_group", broadcast: false};},
    async getMe() {return {className: "User", id: 123n, self: true};},
    async getInputEntity(value: unknown) {return value;},
    async deleteMessages(_peer: unknown, ids: number[]) {deleted.push([...ids]); return [];},
    async sendMessage() {return {id: 700};},
    async editMessage(_peer: unknown, options: {text?: string}) {if (options.text?.includes("任务完成")) finishDa(); return {};},
    async sendFile(_peer: unknown, options: {file?: {name?: string}}) {files.push(options.file?.name ?? ""); return {};},
    async invoke(request: {className?: string}) {
      if (request.className === "channels.GetParticipant") return {participant: {className: "ChannelParticipantAdmin"}};
      if (request.className === "messages.GetHistory") {
        historyReads++;
        return {messages: historyReads === 1 ? [
          {className: "Message", id: 4, message: "mine 4", senderId: 123n, out: true},
          {className: "Message", id: 3, message: "mine 3", senderId: 123n, out: true},
        ] : []};
      }
      return {};
    },
    async *iterMessages() {
      for (let id = 20; id >= 1; id--) yield {className: "Message", id, message: `fixture message ${id}`,
        senderId: BigInt(id % 2 + 1), sender: {firstName: id % 2 ? "Alice" : "Bob"}, entities: []};
    },
  } as unknown as TelegramClient;
  const telegram: TelegramPort = {
    async edit(_message, text) {output.push(text);},
    async reply(_message, text) {output.push(text);},
    async invoke() {throw new Error("network unavailable");},
    async getReply() {return reply;},
    async withClient(operation, signal) {return operation(native, signal);},
  };
  const logger = {info() {}, error() {}};
  const host = new PluginHost({storageRoot: path.join(directory, "assets"), tempRoot: path.join(directory, "temp"), telegram, logger,
    http: {fetch: async (input, init) => {
      const url = String(input);
      if (url.includes("quote-api-enhanced")) return new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), {headers: {"content-type": "image/png"}});
      if (url.includes("fixture.invalid/media.mp4")) return new Response(Buffer.from("fixture-video"), {headers: {"content-type": "video/mp4"}});
      if (url.includes("/images/")) return new Response(JSON.stringify({data: [{b64_json: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")}]}));
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const content = body.model === "fixture-video" ? "https://fixture.invalid/media.mp4" : "<b>fixture answer</b>";
      return new Response(JSON.stringify({choices: [{message: {content}}]}));
    }}});
  const prepared: PreparedArtifact[] = [];
  let stopped = false;
  try {
    for (const id of DAILY_PLUGINS) {
      const artifact = await prepareArtifact(path.join(root, "dist/v2-plugins-active", id));
      prepared.push(artifact);
      await host.load(artifact.create());
    }
    assert.deepEqual(host.listPlugins().map(plugin => plugin.id).sort(), [...DAILY_PLUGINS].sort());
    assert.deepEqual(host.listCommands().map(command => command.name).sort(), [...DAILY_PLUGINS].sort());
    const message = (text: string, chatId = "-100123"): MessageEnvelope => ({
      id: output.length + 1, chatId, senderId: "123", text, outgoing: true, saved: chatId === "123",
    });
    for (const command of [".ai help", ".da help", ".dme help", ".gt help", ".sum list", ".yvlu config"]) {
      assert.equal(await host.dispatchPrimary(message(command)), true, command);
    }
    assert.equal(output.length, 6);
    assert.match(output[0], /AI 助手/);
    assert.match(output[4], /摘要任务/);
    assert.match(output[5], /当前配置/);
    const saved = (text: string): MessageEnvelope => ({id: output.length + 1, chatId: "123", senderId: "123", text,
      outgoing: true, saved: true});
    assert.equal(await host.dispatchPrimary(saved(".ai config add main https://fixture.invalid/v1 secret openai-compatible")), true);
    assert.equal(await host.dispatchPrimary(saved(".ai model chat main fixture-chat")), true);
    assert.equal(await host.dispatchPrimary(saved(".ai fixture question")), true);
    assert.match(output.at(-1) ?? "", /fixture answer/);
    assert.equal(await host.dispatchPrimary(saved(".gt en fixture text")), true);
    assert.match(output.at(-1) ?? "", /fixture answer/);
    assert.equal(await host.dispatchPrimary(saved(".ai model image main gpt-image-2")), true);
    assert.equal(await host.dispatchPrimary(saved(".ai image fixture art")), true);
    assert.match(files[0] ?? "", /ai_image_.*\.png/);
    assert.equal(await host.dispatchPrimary(saved(".ai model video main fixture-video")), true);
    assert.equal(await host.dispatchPrimary(saved(".ai video fixture clip")), true);
    assert.match(files[1] ?? "", /ai_video_.*\.mp4/);
    assert.equal(await host.dispatchPrimary(saved(".sum config add main https://fixture.invalid secret fixture-chat chat")), true);
    assert.equal(await host.dispatchPrimary(message(".sum 10")), true);
    assert.match(output.at(-1) ?? "", /群组总结/);
    assert.equal(await host.dispatchPrimary(message(".dme 2")), true);
    assert.ok(deleted.some(ids => ids.includes(3) && ids.includes(4)));
    assert.equal(await host.dispatchPrimary(message(".yvlu image 1")), true);
    assert.equal(files.at(-1), "quote.png");
    assert.equal(await host.dispatchPrimary(message(".da true")), true);
    await Promise.race([daFinished, new Promise((_, reject) => setTimeout(() => reject(new Error("DA did not finish")), 2000))]);
    assert.ok(deleted.some(ids => ids.length >= 10));
    const report = await host.shutdown(5000);
    stopped = report.completed;
    assert.equal(report.completed, true);
    assert.equal(report.pendingTasks, 0);
    assert.equal(report.pendingResources, 0);
  } finally {
    if (!stopped) stopped = (await host.shutdown(5000)).completed;
    if (stopped) {
      for (const artifact of prepared.reverse()) artifact.release();
      await rm(directory, {recursive: true, force: true});
    }
  }
});
