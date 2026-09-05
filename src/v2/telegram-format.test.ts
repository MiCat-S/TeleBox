import test from 'node:test';
import assert from 'node:assert/strict';
import {HTMLParser} from 'teleproto/extensions/html';
import {_parseMessageText} from 'teleproto/client/messageParse';
import type {TelegramClient} from 'teleproto';
import {TeleprotoPort} from './telegram';
import {ResourceScope} from './lifecycle';

test('locked Teleproto HTML parsing preserves escaped text, URLs and UTF-16 offsets', () => {
  const [text, entities] = HTMLParser.parse('<b>😀 &lt;x&gt; &amp; &amp;lt;</b> <a href="https://example.test/?a=1&amp;b=2">link</a>');
  assert.equal(text, '😀 <x> & &lt; link');
  const bold = entities.find(entity => entity.className === 'MessageEntityBold')!;
  assert.equal(text.slice(bold.offset, bold.offset + bold.length), '😀 <x> & &lt;');
  const link = entities.find(entity => entity.className === 'MessageEntityTextUrl')!;
  assert.equal('url' in link && link.url, 'https://example.test/?a=1&b=2');
  assert.equal(text.slice(link.offset, link.offset + link.length), 'link');
  const privateUse = '\uE000\uE001\uE002\uE003\uE004';
  assert.equal(HTMLParser.parse(`<code>${privateUse}</code>`)[0], privateUse);
});

test('literal SDK output cannot inherit a client-wide HTML or Markdown parser', async () => {
  const scope = new ResourceScope();
  const received: string[] = [];
  const client = {
    parseMode: HTMLParser,
    async editMessage(_peer: unknown, options: {text: string; parseMode: Parameters<typeof _parseMessageText>[2]}) {
      const [text] = await _parseMessageText(client as unknown as TelegramClient, options.text, options.parseMode);
      received.push(text);
    },
    async sendMessage(_peer: unknown, options: {message: string; parseMode: Parameters<typeof _parseMessageText>[2]}) {
      const [text] = await _parseMessageText(client as unknown as TelegramClient, options.message, options.parseMode);
      received.push(text);
    },
  };
  const port = new TeleprotoPort(client as unknown as TelegramClient, scope);
  const message = {id: 1, chatId: '1', text: '', outgoing: true};
  const literal = '<b>literal</b> **unchanged** &amp;';
  await port.edit(message, literal, {}, scope.signal);
  await port.reply(message, literal, {}, scope.signal);
  assert.deepEqual(received, [literal, literal]);
  assert.equal((await scope.drain()).completed, true);
});
