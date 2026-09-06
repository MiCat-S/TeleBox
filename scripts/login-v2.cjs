'use strict';
const fs = require('node:fs/promises');
const readline = require('node:readline/promises');
const {Writable} = require('node:stream');
function diagnostic(error) {
  const allowed = /^(?:EACCES|EEXIST|ENOSPC|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_USE_AFTER_CLOSE|API_ID_INVALID|API_ID_PUBLISHED_FLOOD|PHONE_NUMBER_INVALID|PHONE_NUMBER_BANNED|PHONE_CODE_INVALID|PHONE_CODE_EXPIRED|PASSWORD_HASH_INVALID|AUTH_USER_CANCEL|FLOOD_WAIT_\d+)$/;
  for (const value of [error?.code, error?.errorMessage, error?.message]) {
    if (typeof value === 'string' && allowed.test(value)) return value;
  }
  return 'UNCLASSIFIED';
}

async function login() {
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Node 24 required');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive terminal required');
  try {await fs.lstat('config.json'); throw new Error('config.json exists; preserve it or move it to a private backup before login');}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  let muted = false;
  const output = new Writable({write(chunk, encoding, callback) {
    if (!muted) process.stdout.write(chunk, encoding);
    callback();
  }});
  output.isTTY = true;
  output.columns = process.stdout.columns;
  const rl = readline.createInterface({input: process.stdin, output, terminal: true});
  const ask = async (label, secret = false, trim = true) => {
    process.stdout.write(label);
    muted = secret;
    try {const answer = await rl.question(''); return trim ? answer.trim() : answer;}
    finally {muted = false; if (secret) process.stdout.write('\n');}
  };
  let client, failure;
  let stage = 'credentials';
  try {
    const api_id = Number(await ask('API ID: '));
    const api_hash = await ask('API hash: ', true);
    if (!Number.isSafeInteger(api_id) || api_id <= 0 || !/^[a-f0-9]{32}$/i.test(api_hash)) throw new Error('Invalid API credentials');
    const {TelegramClient} = require('teleproto');
    const {StringSession} = require('teleproto/sessions');
    stage = 'client-initialization';
    client = new TelegramClient(new StringSession(''), api_id, api_hash, {connectionRetries: 3, deviceModel: 'Mi Box'});
    stage = 'connection';
    await client.start({
      phoneNumber: () => {stage = 'phone-number'; return ask('Phone number (+country code): ');},
      phoneCode: () => {stage = 'verification-code'; return ask('Telegram login code: ', true);},
      password: () => {stage = 'two-step-password'; return ask('Two-step verification password: ', true, false);},
      onError: error => {throw error;},
    });
    stage = 'account-verification';
    await client.getMe();
    const session = String(client.session.save());
    if (!session) throw new Error('Empty session');
    stage = 'save-config';
    await fs.writeFile('config.json', JSON.stringify({api_id, api_hash, session, app_name: 'Mi Box'}, null, 2) + '\n',
      {flag: 'wx', mode: 0o600});
    console.log('Mi Box account saved to config.json. Keep this file private.');
  } catch (error) {
    failure = error;
    console.error(`Login failed: stage=${stage} code=${diagnostic(error)}`);
    throw error;
  } finally {
    rl.close();
    if (client) {
      try {await client.destroy();}
      catch (error) {
        console.error(`Login cleanup failed: code=${diagnostic(error)}`);
        if (!failure) throw error;
      }
    }
  }
}
if (require.main === module) login().catch(() => {
  console.error('Login did not complete. Check Node 24, an interactive terminal, account credentials and whether config.json already exists.');
  process.exitCode = 1;
});
module.exports = {login, diagnostic};
