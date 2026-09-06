'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {assertStopped, allowMessage, diagnostic, mediaMatches, main} = require('./server-v2-check.cjs');
test('requires exactly one stopped account process', () => {
  const stopped = {name: 'telebox', pid: 0, pm2_env: {status: 'stopped'}};
  assert.doesNotThrow(() => assertStopped([stopped]));
  for (const entries of [[], [stopped, stopped], [{...stopped, pid: 123}],
    [{...stopped, pm2_env: {status: 'online'}}], [{...stopped, name: 'other'}]]) {
    assert.throws(() => assertStopped(entries));
  }
});
test('observes only this run own Saved Messages IDs', () => {
  const original = {chatId: '123', senderId: '123', id: 9};
  assert.equal(allowMessage(original, '123', new Set([9])), true);
  for (const message of [{...original, id: 10}, {...original, senderId: '456'},
    {...original, chatId: '-100123'}, {...original, senderId: undefined}]) {
    assert.equal(allowMessage(message, '123', new Set([9])), false);
  }
});
test('accepts Telegram image and video media representations', () => {
  assert.equal(mediaMatches({media: {className: 'MessageMediaPhoto'}}, 'image'), true);
  assert.equal(mediaMatches({document: {mimeType: 'image/png'}}, 'image'), true);
  assert.equal(mediaMatches({media: {document: {mimeType: 'video/mp4'}}}, 'video'), true);
  assert.equal(mediaMatches({document: {mimeType: 'application/pdf'}}, 'image'), false);
  assert.equal(mediaMatches({photo: {}}, 'video'), false);
});
test('CLI rejects missing opt-in and production target before accessing credentials', async () => {
  for (const args of [[], ['--execute', '/root/telebox'], ['--unknown', '/root/telebox-v2-validation/test']]) {
    await assert.rejects(main(args));
  }
});
test('diagnostics redact exception content while preserving RPC and source locations', () => {
  const error = new Error('session=secret, profile content');
  error.stack = 'Error: session=secret\n    at handler (/root/private/server-v2-check.cjs:99:5)';
  error.errorMessage = 'FLOOD_WAIT_20';
  assert.deepEqual(diagnostic(error), {reason: 'operation-failed', rpc: 'FLOOD_WAIT_20', locations: ['server-v2-check.cjs:99:5']});
  error.errorMessage = 'secret-token-123';
  assert.equal(diagnostic(error).rpc, undefined);
});
