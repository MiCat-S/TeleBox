'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function fixture({exists = false, failure = false} = {}) {
  const writes = [], events = [];
  const answers = ['12345', 'a'.repeat(32), '+123456789', '12345', 'password'];
  class Client {
    constructor() {events.push('client'); this.session = {save: () => 'private-session'};}
    async start(options) {
      await options.phoneNumber(); await options.phoneCode(); await options.password();
      if (failure) throw new Error('private upstream error');
    }
    async getMe() {return {id: 1};}
    async destroy() {events.push('destroy');}
  }
  const modules = {
    'node:fs/promises': {
      async lstat() {if (!exists) throw Object.assign(new Error(), {code: 'ENOENT'}); return {};},
      async writeFile(...args) {writes.push(args);},
    },
    'node:readline/promises': {createInterface: () => ({
      question: async () => answers.shift(), close() {events.push('close');},
    })},
    'node:stream': require('node:stream'),
    teleproto: {TelegramClient: Client},
    'teleproto/sessions': {StringSession: class {}},
  };
  const context = {require: name => {assert.ok(name in modules); return modules[name];}, module: {exports: {}},
    process: {versions: {node: '24.15.0'}, stdin: {isTTY: true}, stdout: {isTTY: true, write() {}, columns: 80}},
    console: {log() {}, error() {}},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'login-v2.cjs'), 'utf8'), context);
  return {login: context.module.exports.login, diagnostic: context.module.exports.diagnostic, writes, events};
}
test('login saves complete account exclusively with private permissions and closes client', async () => {
  const f = fixture(); await f.login();
  assert.equal(f.writes.length, 1);
  const [name, text, options] = f.writes[0];
  assert.equal(name, 'config.json');
  assert.equal(options.flag, 'wx');
  assert.equal(options.mode, 0o600);
  assert.equal(JSON.parse(text).session, 'private-session');
  assert.deepEqual(f.events, ['client', 'close', 'destroy']);
});
test('login never opens a Telegram client when a configuration exists', async () => {
  const f = fixture({exists: true});
  await assert.rejects(f.login(), /config.json exists/);
  assert.equal(f.events.length, 0);
  assert.equal(f.writes.length, 0);
});
test('login failure closes client without saving a partial account', async () => {
  const f = fixture({failure: true});
  await assert.rejects(f.login());
  assert.deepEqual(f.events, ['client', 'close', 'destroy']);
  assert.equal(f.writes.length, 0);
});
test('login diagnostics expose known error codes without upstream secrets', () => {
  const {diagnostic} = fixture();
  assert.equal(diagnostic({code: 'ECONNREFUSED'}), 'ECONNREFUSED');
  assert.equal(diagnostic({errorMessage: 'PHONE_CODE_INVALID'}), 'PHONE_CODE_INVALID');
  assert.equal(diagnostic({message: 'secret-session +12345'}), 'UNCLASSIFIED');
});
