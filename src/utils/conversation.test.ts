import test from "node:test";
import assert from "node:assert/strict";
import { Api, TelegramClient } from "teleproto";
import { conversation } from "./conversation";
import { MediaScheduler } from "teleproto/network/MediaScheduler";
import bigInt from "big-integer";

function message(button: Api.KeyboardInlineButton): Api.Message {
  return {
    id: 42,
    replyMarkup: new Api.ReplyInlineMarkup({
      rows: [new Api.KeyboardInlineButtonRow({ buttons: [button] })],
    }),
  } as Api.Message;
}

function callbackButton(): Api.KeyboardInlineButton {
  return new Api.KeyboardInlineButton({
    text: "Run",
    type: new Api.InlineButtonTypeCallback({ data: Buffer.from("callback") }),
  });
}

test("conversation sends Layer 229 callback data", async () => {
  const calls: Api.messages.GetBotCallbackAnswer[] = [];
  const client = {
    invoke: async (request: Api.messages.GetBotCallbackAnswer) => calls.push(request),
  } as unknown as TelegramClient;
  await conversation(client, "test-bot", async (conv) => {
    await conv.clickButton(message(callbackButton()), 0, 0);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].msgId, 42);
  assert.deepEqual(calls[0].data, Buffer.from("callback"));
});

test("conversation rejects non-callback buttons and invalid indices", async () => {
  const client = { invoke: async () => assert.fail("unexpected request") } as unknown as TelegramClient;
  const urlButton = new Api.KeyboardInlineButton({
    text: "Open",
    type: new Api.InlineButtonTypeUrl({ url: "https://example.com" }),
  });
  await conversation(client, "test-bot", async (conv) => {
    await assert.rejects(conv.clickButton(message(urlButton), 0, 0), /不是回调按钮/);
    for (const [row, col] of [[-1, 0], [0, -1], [1, 0], [0, 1], [0.5, 0], [0, NaN]]) {
      await assert.rejects(conv.clickButton(message(callbackButton()), row, col), /索引超出范围/);
    }
  });
});

test("conversation does not submit callbacks after cancellation", async () => {
  const controller = new AbortController();
  controller.abort(new Error("test cancellation"));
  const client = { invoke: async () => assert.fail("unexpected request") } as unknown as TelegramClient;
  await conversation(client, "test-bot", async (conv) => {
    await assert.rejects(conv.clickButton(message(callbackButton()), 0, 0), /test cancellation/);
  }, { signal: controller.signal });
});

test("main-DC upload override still invokes the client and respects cancellation", async () => {
  const calls: unknown[] = [];
  const scheduler = {
    _client: {
      session: { dcId: 2 },
      invoke: async (request: unknown) => { calls.push(request); return true; },
    },
  } as unknown as MediaScheduler;
  const request = new Api.upload.SaveFilePart({
    fileId: bigInt(1), filePart: 0, bytes: Buffer.from("part"),
  });
  assert.equal(await MediaScheduler.prototype.savePart.call(scheduler, 2, request), true);
  assert.deepEqual(calls, [request]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    MediaScheduler.prototype.savePart.call(scheduler, 2, request, controller.signal),
    /aborted/,
  );
  assert.equal(calls.length, 1);
});
