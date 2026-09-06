'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {randomBytes} = require('node:crypto');
const {setTimeout: delay} = require('node:timers/promises');
const DAILY_PLUGINS = Object.freeze(['ai', 'da', 'dc', 'dme', 'gt', 'ids', 'ip', 'nodeseek', 'rate', 'sum', 'yvlu']);

const production = '/root/telebox';
function assertStopped(entries) {
  const matches = entries.filter(entry => entry.name === 'telebox');
  if (matches.length !== 1 || matches[0].pm2_env.status !== 'stopped' || matches[0].pid) {
    throw new Error('Original account process must be stopped');
  }
}
function pm2State() {
  const result = spawnSync('/usr/bin/pm2', ['jlist'], {encoding: 'utf8', env: {...process.env, PM2_HOME: '/root/.pm2'}});
  if (result.status !== 0) throw new Error('Cannot inspect account process');
  return JSON.parse(result.stdout);
}
function processTree() {
  const entries = new Map();
  for (const pid of fs.readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      entries.set(Number(pid), {pid: Number(pid), parent: Number(fields[1]), started: fields[19]});
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  return entries;
}
function memory(pid = 'self') {
  const data = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
  const value = name => Number(data.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))?.[1] ?? 0);
  return {rssKiB: value('Rss'), pssKiB: value('Pss')};
}
function capture(root) {
  const entries = pm2State();
  const app = entries.filter(entry => entry.name === 'telebox');
  if (app.length !== 1 || app[0].pm2_env.status !== 'online' || app[0].pm2_env.pm_cwd !== production) {
    throw new Error('Expected original service is not online');
  }
  const tree = processTree();
  const selected = new Set([app[0].pid]);
  let size;
  do {
    size = selected.size;
    for (const entry of tree.values()) if (selected.has(entry.parent)) selected.add(entry.pid);
  } while (size !== selected.size);
  const processes = [...selected].map(pid => ({...tree.get(pid), ...memory(pid)}));
  fs.writeFileSync(path.join(root, 'pm2-before.private.json'), JSON.stringify(entries), {mode: 0o600, flag: 'wx'});
  fs.writeFileSync(path.join(root, 'processes-before.json'), JSON.stringify(processes), {mode: 0o600, flag: 'wx'});
  const totals = processes.reduce((sum, item) => ({rssKiB: sum.rssKiB + item.rssKiB, pssKiB: sum.pssKiB + item.pssKiB}), {rssKiB: 0, pssKiB: 0});
  console.log(JSON.stringify({stage: 'baseline', processes: processes.length, ...totals}));
}
function guard(root) {
  assertStopped(pm2State());
  const current = processTree();
  const previous = JSON.parse(fs.readFileSync(path.join(root, 'processes-before.json'), 'utf8'));
  if (previous.some(item => current.get(item.pid)?.started === item.started)) throw new Error('Original account process tree is still alive');
}
function allowMessage(message, selfId, ids) {
  return message.chatId === selfId && message.senderId === selfId && ids.has(message.id);
}
function mediaMatches(message, kind) {
  const media = message?.media;
  const document = message?.document ?? media?.document;
  const mimeType = typeof document?.mimeType === 'string' ? document.mimeType.toLowerCase() : '';
  if (kind === 'image') {
    return Boolean(message?.photo || media?.photo || media?.className === 'MessageMediaPhoto' || mimeType.startsWith('image/'));
  }
  return Boolean(message?.video || mimeType.startsWith('video/'));
}
function diagnostic(error) {
  const messages = ['Command target is not Saved Messages', 'Command was not admitted',
    'Server-side command output mismatch', 'Alias unload failed', 'Alias reload mismatch',
    'Logging unload failed', 'Logging reload mismatch', 'Prefix persistence mismatch', 'Admission failed'];
  const rpc = typeof error?.errorMessage === 'string' && /^[A-Z_]{3,64}(?:_\d{1,5})?$/.test(error.errorMessage)
    ? error.errorMessage : undefined;
  // Keep only source locations, never an exception's message, arguments or cause.
  const locations = String(error?.stack ?? '').split('\n').slice(1, 6).flatMap(line => {
    const match = line.match(/\/([A-Za-z0-9_.-]+\.(?:js|cjs|ts)):(\d+):(\d+)/);
    return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
  });
  return {reason: messages.includes(error?.message) ? error.message : 'operation-failed', rpc, locations};
}

async function preflight(root) {
  const core = path.join(root, 'candidate/dist/v2');
  const {prepareArtifact} = require(path.join(core, 'artifacts.js'));
  for (const id of DAILY_PLUGINS) {
    console.log(JSON.stringify({stage: `artifact-preflight-${id}`, result: 'running'}));
    const artifact = await prepareArtifact(path.join(root, 'candidate/plugins', id));
    try {artifact.create();} finally {artifact.release();}
  }
  console.log(JSON.stringify({stage: 'native-preflight', result: 'running'}));
  const result = await require(path.join(core, 'offline-check.js')).offlineCheck();
  if (result.result !== 'ok') throw new Error('Server offline check failed');
  console.log(JSON.stringify({stage: 'artifact-and-native-preflight', result: 'ok'}));
}

async function live(root) {
  guard(root);
  const work = path.join(root, 'work');
  if (fs.realpathSync(process.cwd()) !== fs.realpathSync(work)) throw new Error('A separate working copy is required');
  const core = path.join(root, 'candidate/dist/v2');
  const {TelegramClient, Api} = require('teleproto');
  const {StringSession} = require('teleproto/sessions');
  const {Logger, LogLevel} = require('teleproto/extensions/Logger');
  const {PluginHost} = require(path.join(core, 'host.js'));
  const {ResourceScope} = require(path.join(core, 'lifecycle.js'));
  const {TeleprotoPort, messageEnvelope, subscribeMessages} = require(path.join(core, 'telegram.js'));
  const {RuntimeLogger} = require(path.join(core, 'logging.js'));
  const {PrefixEnvStore, prefixesFromEnv} = require(path.join(core, 'prefixes.js'));
  const {prepareArtifact} = require(path.join(core, 'artifacts.js'));
  const {createHelp} = require(path.join(core, 'builtins/help.js'));
  const {createAlias} = require(path.join(core, 'builtins/alias.js'));
  const {createPrefix} = require(path.join(core, 'builtins/prefix.js'));
  const {createLogLevel} = require(path.join(core, 'builtins/loglevel.js'));
  const {lockAccount} = require(path.join(core, 'account.js'));
  const {installProtocolCompatibility} = require(path.join(core, 'protocol-compat.js'));
  const config = JSON.parse(fs.readFileSync(path.join(work, 'config.json'), 'utf8'));
  if (!Number.isSafeInteger(config.api_id) || config.api_id <= 0 ||
      typeof config.api_hash !== 'string' || !config.api_hash || typeof config.session !== 'string' || !config.session) {
    throw new Error('An existing authorized session is required');
  }
  const counts = {protocolErrors: 0, applicationErrors: 0, observedOwnEvents: 0};
  const session = new StringSession(config.session);
  await session.load();
  const key = session.authKey?.getKey();
  if (!key) throw new Error('An existing authorized session is required');
  const releaseLock = await lockAccount(key);
  let compatibility;
  const protocolLogger = new Logger(LogLevel.ERROR);
  protocolLogger.handler = record => {
    const decision = compatibility?.handleLog({message: record.message, error: record.error}) ?? 'pass';
    if (decision !== 'suppress' && record.level === 'error') counts.protocolErrors++;
  };
  const client = new TelegramClient(session, config.api_id, config.api_hash, {
    baseLogger: protocolLogger, connectionRetries: 1, reconnectRetries: 0, requestRetries: 1,
    autoReconnect: false, timeout: 10, floodSleepThreshold: 0,
    deviceModel: 'TeleBox V2 validation', proxy: config.proxy ? {...config.proxy, timeout: 10} : undefined,
  });
  const transportScope = new ResourceScope();
  const eventScope = new ResourceScope();
  const loggerScope = new ResourceScope();
  const logger = new RuntimeLogger(path.join(work, 'assets/logger/config.json'), {
    write(level) {if (level === 3) counts.applicationErrors++;},
  }, loggerScope);
  const ids = new Set();
  const artifacts = [];
  const checks = [];
  const samples = [];
  let stage = 'connect', host, me, detach, failure = false;
  const mark = name => {checks.push(name); console.log(JSON.stringify({stage: name, result: 'ok'}));};
  const shutdown = {};
  try {
    compatibility = installProtocolCompatibility(client);
    await client.connect();
    stage = 'authorization';
    me = await client.getMe();
    if (!(me instanceof Api.User) || !me.self || me.bot) throw new Error('Expected authorized user session');
    mark('existing-session');
    const selfId = me.id.toString();
    const telegram = new TeleprotoPort(client, transportScope, {selfId});
    host = new PluginHost({storageRoot: path.join(work, 'assets'), tempRoot: path.join(work, 'temp'), telegram, logger});
    stage = 'load-help';
    await host.load(createHelp(host));
    stage = 'load-alias';
    await host.load(createAlias(host));
    stage = 'load-prefix';
    await host.load(createPrefix(host, new PrefixEnvStore(path.join(work, '.env'))));
    stage = 'load-loglevel';
    await host.load(createLogLevel(logger));
    for (const id of DAILY_PLUGINS) {
      stage = `load-${id}`;
      const artifact = await prepareArtifact(path.join(root, 'candidate/plugins', id));
      artifacts.push(artifact);
      await host.load(artifact.create());
    }
    mark('daily-modules-loaded');
    detach = await subscribeMessages(client, eventScope, message => {
      if (allowMessage(message, selfId, ids)) counts.observedOwnEvents++;
    }, {selfId});
    mark('event-subscription');
    const prefix = `.v2-${randomBytes(5).toString('hex')}-`;
    host.replacePrefixes([prefix]);
    async function command(name, text, validate) {
      stage = `${name}:send`;
      const sent = await client.sendMessage(me, {message: text, parseMode: false, silent: true});
      ids.add(sent.id);
      stage = `${name}:envelope`;
      const envelope = messageEnvelope(sent, {selfId});
      console.log(JSON.stringify({stage, selfChat: envelope.chatId === selfId, selfSender: envelope.senderId === selfId,
        textMatches: envelope.text === text, edited: envelope.edited, outgoing: envelope.outgoing, saved: envelope.saved}));
      if (!allowMessage(envelope, selfId, ids)) throw new Error('Command target is not Saved Messages');
      // Explicitly dispatch the server-returned message; this does not claim an
      // independently received command update from another Telegram device.
      stage = `${name}:dispatch`;
      if (!await host.dispatchPrimary(envelope)) throw new Error('Command was not admitted');
      stage = `${name}:readback`;
      const [stored] = await client.getMessages(me, {ids: [sent.id]});
      if (!stored || stored.message === text || !validate(stored.message)) throw new Error('Server-side command output mismatch');
      mark(name);
      await delay(400);
      return envelope;
    }
    async function mediaCommand(name, text, token, kind, timeoutMs) {
      stage = `${name}:send`;
      const sent = await client.sendMessage(me, {message: text, parseMode: false, silent: true});
      ids.add(sent.id);
      stage = `${name}:envelope`;
      const envelope = messageEnvelope(sent, {selfId});
      if (!allowMessage(envelope, selfId, ids)) throw new Error('Command target is not Saved Messages');
      stage = `${name}:dispatch`;
      if (!await host.dispatchPrimary(envelope)) throw new Error('Command was not admitted');
      stage = `${name}:readback`;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        for await (const item of client.iterMessages(me, {limit: 30})) {
          if (item.id <= sent.id || !item.message?.includes(token)) continue;
          if (!mediaMatches(item, kind)) throw new Error('Server-side command output mismatch');
          ids.add(item.id);
          mark(name);
          await delay(400);
          return envelope;
        }
        await delay(2000);
      }
      throw new Error('Server-side command output mismatch');
    }
    const input = await command('help', `${prefix}help`, value => value.includes('help') && value.includes('ids'));
    await command('ai-config', `${prefix}ai config list`, value => value.includes('AI 配置'));
    await command('gt-help', `${prefix}gt help`, value => value.includes('AI 翻译'));
    await command('da-admission', `${prefix}da help`, value => value.includes('仅群组可用'));
    await command('dme-help', `${prefix}dme help`, value => value.includes('智能防撤回删除'));
    await command('sum-list', `${prefix}sum list`, value => value.includes('摘要任务'));
    await command('yvlu-config', `${prefix}yvlu config`, value => value.includes('当前配置'));
    const chatToken = `V2_TEXT_${randomBytes(4).toString('hex')}`;
    await command('ai-chat', `${prefix}ai 只回复字符串 ${chatToken}，不要添加其他内容`, value => value.includes(chatToken));
    await command('gt-translation', `${prefix}gt en 苹果`, value =>
      value.includes('AI 翻译结果') && /\bapple\b/i.test(value));
    const imageToken = `V2_IMAGE_${randomBytes(4).toString('hex')}`;
    await mediaCommand('ai-image', `${prefix}ai image ${imageToken} simple blue square on white background`,
      imageToken, 'image', 120000);
    await command('ids-self', `${prefix}ids`, value => value.includes(selfId) && value.includes('tg://user'));
    await command('dc-self', `${prefix}dc ${selfId}`, value => /DC\d|需要先设置头像/.test(value));
    const alias = `smoke_${randomBytes(5).toString('hex')}`;
    await command('alias-write-copy', `${prefix}alias set ${alias} help`, value => value.includes(alias) && value.includes('help'));
    if (!(await host.unload('alias'))?.completed) throw new Error('Alias unload failed');
    await host.load(createAlias(host));
    if (host.configuration().aliases[alias] !== 'help') throw new Error('Alias reload mismatch');
    await command('alias-reloaded-command', `${prefix}${alias}`, value => value.includes('ids'));
    await command('loglevel-write-copy', `${prefix}loglevel warning`, value => value.includes('WARNING'));
    if (!(await host.unload('loglevel'))?.completed) throw new Error('Logging unload failed');
    await host.load(createLogLevel(logger));
    if (logger.getLevelName() !== 'WARNING') throw new Error('Logging reload mismatch');
    mark('loglevel-reload');
    const nextPrefix = `${prefix}next-`;
    await command('prefix-write-copy', `${prefix}prefix set ${nextPrefix}`, value => value.includes(nextPrefix));
    const env = require('dotenv').parse(fs.readFileSync(path.join(work, '.env')));
    if (prefixesFromEnv(env).join() !== nextPrefix) throw new Error('Prefix persistence mismatch');
    await command('new-prefix-help', `${nextPrefix}help`, value => value.includes('ids'));
    if (await host.dispatchPrimary({...input, text: `${nextPrefix}help`, outgoing: false, saved: false}) ||
        await host.dispatchPrimary({...input, text: `${nextPrefix}help`, edited: true})) throw new Error('Admission failed');
    mark('admission');
    stage = 'idle-observation';
    const before = process.cpuUsage();
    const started = Date.now();
    for (let i = 0; i < 5; i++) {await delay(3000); samples.push(memory());}
    const cpu = process.cpuUsage(before);
    console.log(JSON.stringify({stage, elapsedMs: Date.now() - started, cpuMicroseconds: cpu.user + cpu.system, samples}));
    mark('idle-observation');
  } catch (error) {
    failure = true;
    console.log(JSON.stringify({stage, result: 'failed', diagnostic: diagnostic(error)}));
  } finally {
    stage = 'cleanup';
    try {if (detach) await detach(); shutdown.events = await eventScope.drain(5000);} catch {failure = true;}
    try {if (host) shutdown.host = await host.shutdown(10000);} catch {failure = true;}
    if (shutdown.host?.completed) for (const artifact of artifacts) artifact.release();
    try {
      if (me && ids.size) {
        // Only IDs created in this run, never user messages or history ranges.
        await client.deleteMessages(me, [...ids], {revoke: true});
        const remaining = await client.getMessages(me, {ids: [...ids]});
        shutdown.testMessagesDeleted = !remaining.some(item => item?.className === 'Message');
      } else shutdown.testMessagesDeleted = ids.size === 0;
    } catch {failure = true; shutdown.testMessagesDeleted = false;}
    try {shutdown.transport = await transportScope.drain(5000);} catch {failure = true;}
    try {shutdown.logging = await loggerScope.drain(5000);} catch {failure = true;}
    try {await client.destroy(); shutdown.clientDestroyed = true;} catch {failure = true;}
    try {compatibility?.cleanup(); await releaseLock(); shutdown.accountLockReleased = true;} catch {failure = true;}
  }
  const compilerResident = Object.keys(require.cache).some(file => /[/\\]node_modules[/\\](esbuild|typescript|tsx)[/\\]/.test(file));
  if (compilerResident || !shutdown.host?.completed || !shutdown.events?.completed ||
      !shutdown.transport?.completed || !shutdown.logging?.completed || !shutdown.clientDestroyed ||
      !shutdown.accountLockReleased || !shutdown.testMessagesDeleted) failure = true;
  const reports = Object.fromEntries(Object.entries(shutdown).map(([key, value]) => [key, value && typeof value === 'object'
    ? {completed: value.completed, pendingTasks: value.pendingTasks, pendingResources: value.pendingResources, errors: value.errors?.length} : value]));
  const report = {mode: 'server-live-check', result: failure ? 'failed' : 'ok', node: process.version,
    checks, counts, compilerResident, shutdown: reports, peakRssKiB: process.resourceUsage().maxRSS,
    coverage: 'existing session, account lock, 11 daily plugin load, Saved Messages RPC dispatch, AI chat, GT translation and image generation; destructive DA and DME commands excluded'};
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
  console.log(JSON.stringify(report));
  process.exitCode = failure ? 1 : 0;
}

async function main(args) {
  const [mode, root] = args;
  if (args.length !== 2 || !['--preflight', '--capture', '--guard', '--execute'].includes(mode) ||
      !/^\/root\/telebox-v2-validation\/[A-Za-z0-9._-]+$/.test(root ?? '') || process.platform !== 'linux' ||
      process.versions.node.split('.')[0] !== '24') throw new Error('Expected Linux Node 24 and a private validation directory');
  if (mode === '--preflight') await preflight(root);
  else if (mode === '--capture') capture(root);
  else if (mode === '--guard') guard(root);
  else await live(root);
}
module.exports = {assertStopped, allowMessage, diagnostic, mediaMatches, main};
if (require.main === module) main(process.argv.slice(2)).catch(() => {
  console.error('Server validation precondition or execution failed');
  process.exitCode = 1;
});
