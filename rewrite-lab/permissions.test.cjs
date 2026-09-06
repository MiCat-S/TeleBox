const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const {loadSource, loadFunctions} = require("./source-harness.cjs");
const fixtures = require("./permission-cases.json");

function commandParser(aliases = new Map()) {
  return loadFunctions("src/utils/pluginManager.ts", ["getCommandFromMessage"], {
    getPrefixes: () => ["."],
    AliasDB: class {get(name) {return aliases.get(name);} close() {}},
  }).getCommandFromMessage;
}

for (const item of fixtures.cases) {
  test(item.name, async () => {
    const c = {...fixtures.defaults, ...item};
    const sends = [], dispatches = [], deletes = [];
    let opened = 0, closed = 0;
    class DB {
      constructor() {opened++;}
      ls() {return c.users.map(uid => ({uid}));}
      lsChats() {return c.chats.map(id => ({id}));}
      lsMsgs() {return c.rules || [];}
      close() {closed++;}
    }
    const manager = {
      getPrefixes: () => ["."],
      getCommandFromMessage: commandParser(),
      dealCommandPluginWithMessage: async params => dispatches.push(params),
    };
    const plugin = loadSource(`src/plugin/${c.plugin}.ts`, {
      "@utils/pluginBase": {Plugin: class {}},
      "@utils/pluginManager": manager,
      teleproto: {Api: {}},
      [`@utils/${c.plugin}DB`]: {[c.plugin === "sudo" ? "SudoDB" : "SureDB"]: DB},
      "@utils/safeGetMessages": {safeGetReplyMessage: async () => {throw Error("unexpected reply lookup");}},
      "teleproto/Helpers": {sleep: async () => {throw Error("unexpected sleep");}},
      "@utils/htmlEscape": {},
    }, {process: {env: {TB_SUDO_PREFIX: c.sudoPrefix || ""}}}).default;
    const sentMessage = {id: 9001};
    const msg = {
      message: c.text,
      fromId: c.uid === null ? undefined : {userId: BigInt(c.uid)},
      peerId: c.cid === null ? undefined : {channelId: BigInt(c.cid)},
      fwdFrom: c.forwarded ? {} : undefined,
      replyTo: c.topic ? {forumTopic: true, replyToTopId: c.topic} : undefined,
      replyToMsgId: c.reply,
      entities: [{synthetic: true}],
      client: {sendMessage: async (peer, options) => {sends.push({peer, options}); return sentMessage;}},
      deleteWithDelay: async delay => deletes.push(delay),
    };
    await plugin.listenMessageHandler(msg);
    assert.equal(sends.length, c.send === undefined ? 0 : 1);
    assert.equal(dispatches.length, c.command === undefined ? 0 : 1);
    if (sends.length) {
      assert.equal(sends[0].options.message, c.send);
      assert.equal(sends[0].options.replyTo, c.replyTo);
      assert.equal(sends[0].peer, msg.peerId);
    }
    if (dispatches.length) {
      assert.equal(dispatches[0].cmd, c.command);
      assert.equal(dispatches[0].trigger, msg);
      assert.equal(dispatches[0].msg, sentMessage);
      assert.equal(dispatches[0].isEdited, false);
    }
    assert.deepEqual(deletes, c.deleteDelay === undefined ? [] : [c.deleteDelay]);
    assert.equal(opened, closed, "database handles must close");
    plugin.cleanup();
  });
}

test("parser preserves longest aliases and custom prefixes", () => {
  const parse = commandParser(new Map([["go", true], ["go now", true]]));
  assert.equal(parse(".go now extra"), "go now");
  assert.equal(parse(".go later"), "go");
  assert.equal(parse(".PING arg"), "PING");
  assert.equal(parse("!ping", ["!"]), "ping");
  assert.equal(parse("."), null);
  assert.equal(parse("hello .ping"), null);
  assert.equal(parse(".not-a-command"), null);
});

test("primary dispatcher only admits outgoing or saved messages", async () => {
  class EditedMessageEvent {}
  const calls = [];
  const {dealCommandPlugin} = loadFunctions("src/utils/pluginManager.ts", ["dealCommandPlugin"], {
    EditedMessageEvent, getCommandFromMessage: commandParser(),
    dealCommandPluginWithMessage: async params => calls.push(params),
  });
  for (const [out, savedPeerId, admitted] of [[false, null, false], [true, null, true], [false, {}, true]]) {
    for (const edited of [false, true]) {
      calls.length = 0;
      const event = edited ? new EditedMessageEvent() : {};
      event.message = {message: ".ping", out, savedPeerId};
      await dealCommandPlugin(event);
      assert.equal(calls.length, Number(admitted));
      if (admitted) assert.equal(calls[0].isEdited, edited);
    }
  }
});

test("ignoreEdited and alias arguments survive command dispatch", async () => {
  const calls = [];
  const entry = {original: "ping", aliasFinal: "ping dc1", plugin: {
    ignoreEdited: true, cmdHandlers: {ping: async msg => calls.push(msg)},
  }};
  const {dealCommandPluginWithMessage: dispatch} = loadFunctions("src/utils/pluginManager.ts", ["dealCommandPluginWithMessage"], {
    getPluginEntry: cmd => cmd === "test link" ? entry : undefined,
    getPrefixes: () => ["."],
    console: {error: (...args) => assert.fail(args.join(" "))},
  });
  const msg = {message: ".test link extra", text: ".test link extra", id: 5};
  await dispatch({cmd: "test link", msg, isEdited: true});
  assert.equal(calls.length, 0);
  await dispatch({cmd: "missing", msg});
  assert.equal(calls.length, 0);
  await dispatch({cmd: "test link", msg});
  assert.equal(calls[0].message, ".ping dc1 extra");
  assert.equal(calls[0].text, ".ping dc1 extra");
  assert.equal(calls[0].id, 5);
  assert.equal(msg.message, ".test link extra", "source message must remain unchanged");
});

function panel() {
  const config = {sessionSecret: "synthetic-only-key", admins: [{userId: 2}]};
  const auth = loadSource("src/utils/panel/auth.ts", {
    crypto, "./configStore": {readPanelConfig: async () => config},
    "./owner": {getOwnerId: async () => 1},
  });
  return {auth, config};
}

test("panel owner and read-only admin roles stay distinct and revocable", async () => {
  const {auth, config} = panel();
  assert.equal((await auth.isPanelAdminUser(1)).isOwner, true);
  assert.equal((await auth.isPanelAdminUser(2)).allowed, true);
  assert.equal((await auth.isPanelAdminUser(2)).isOwner, false);
  assert.equal((await auth.isPanelAdminUser(3)).allowed, false);
  const {getRequiredPanelCapability: capability} = loadFunctions("src/utils/panel/httpServer.ts", ["getRequiredPanelCapability"]);
  for (const [method, route] of [
    ["POST", "/api/tpm/install"], ["POST", "/api/tpm/uninstall"],
    ["POST", "/api/tpm/update"], ["POST", "/api/tpm/source"],
    ["GET", "/api/tpm/update/stream"], ["PUT", "/api/settings/ai"],
    ["PUT", "/api/config"], ["POST", "/api/admins"], ["DELETE", "/api/admins/2"],
  ]) {
    assert.notEqual(capability(method, route), "read");
    await assert.rejects(auth.requirePanelCapability({userId: 2}, capability(method, route)), error => error.status === 403);
    await auth.requirePanelCapability({userId: 1}, capability(method, route));
  }
  config.admins = [];
  assert.equal((await auth.isPanelAdminUser(2)).allowed, false);
});

test("panel session gate rechecks role even for a valid signed token", async () => {
  const {auth, config} = panel();
  const {requireSession} = loadFunctions("src/utils/panel/httpServer.ts", ["getBearer", "requireSession"], auth);
  const token = await auth.issueSessionToken({userId: 2, exp: Date.now() + 60000});
  const request = {headers: {authorization: `Bearer ${token}`}};
  assert.equal((await requireSession(request)).userId, 2);
  config.admins = [];
  await assert.rejects(requireSession(request), error => error.status === 403);
  await assert.rejects(requireSession({headers: {}}), error => error.status === 401);
  assert.equal(await auth.verifySessionToken(token + "x"), null);
  const expired = await auth.issueSessionToken({userId: 1, exp: Date.now() - 1000});
  assert.equal(await auth.verifySessionToken(expired), null);
});
