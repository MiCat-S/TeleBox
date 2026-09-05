import test from "node:test";
import assert from "node:assert/strict";
import {DelegationPolicy, telegramId} from "./delegation";

const message = {senderId: "9007199254740993", peerId: "200", text: "/ban one two"};
const users = [message.senderId];

test("delegation preserves raw integer identity without number rounding", () => {
  assert.equal(telegramId(9007199254740993n), message.senderId);
  assert.equal(telegramId("000200"), "200");
  assert.equal(telegramId(200), "200");
  for (const value of [Number(message.senderId), "1e3", " 200", "@name", "0", "-100200", "1.5"]) {
    assert.throws(() => telegramId(value));
  }
});

test("sudo/sure authorization requires exact user and optional chat whitelist", () => {
  const open = new DelegationPolicy({users, chats: []});
  const restricted = new DelegationPolicy({users, chats: ["300"]});
  assert.equal(open.allows(message), true);
  assert.equal(restricted.allows(message), false);
  assert.equal(restricted.allows({...message, peerId: "300"}), true);
  for (const candidate of [
    {...message, forwarded: true}, {...message, edited: true},
    {...message, senderId: undefined}, {...message, peerId: undefined},
    {...message, senderId: "9007199254740992"}, {...message, peerId: "@name"},
    {...message, senderId: "09007199254740993"},
  ]) assert.equal(open.allows(candidate), false);
  assert.equal(new DelegationPolicy({users: [], chats: []}).allows(message), false);
});

test("sure requires a message rule and preserves exact string matching", () => {
  assert.equal(new DelegationPolicy({users, chats: []}).match(message), undefined);
  const policy = new DelegationPolicy({users, chats: [], messages: [{id: "1", msg: "hello  world", redirect: "answer"}]});
  assert.deepEqual(policy.match({...message, text: "hello  world"}), {ruleId: "1", text: "answer"});
  for (const text of ["hello world", "hello  world ", "HELLO  WORLD"]) {
    assert.equal(policy.match({...message, text}), undefined);
  }
});

test("sure command rules retain suffix and require the existing space boundary", () => {
  const policy = new DelegationPolicy({users, chats: [], messages: [{id: "1", msg: "_command:/ban", redirect: ".ban"}]});
  assert.deepEqual(policy.match(message), {ruleId: "1", text: ".ban one two"});
  assert.deepEqual(policy.match({...message, text: "/ban"}), {ruleId: "1", text: ".ban"});
  assert.deepEqual(policy.match({...message, text: "/ban  one\ntwo"}), {ruleId: "1", text: ".ban  one\ntwo"});
  for (const text of ["/banned", "x/ban", "/ban\tone", "/ban\none"]) {
    assert.equal(policy.match({...message, text}), undefined);
  }
  assert.equal(policy.match({...message, forwarded: true}), undefined);
});

test("sure observes rule order and empty redirect preserves source text", () => {
  const rules = [{id: "1", msg: "_command:/ban", redirect: ""}, {id: "2", msg: message.text, redirect: "second"}];
  const policy = new DelegationPolicy({users, chats: [], messages: rules});
  assert.deepEqual(policy.match(message), {ruleId: "1", text: message.text});
  rules[0].redirect = "mutated";
  rules.reverse();
  assert.deepEqual(policy.match(message), {ruleId: "1", text: message.text});
});

test("policy snapshots are detached from mutable access lists", () => {
  const config = {users: [...users], chats: ["200"]};
  const policy = new DelegationPolicy(config);
  config.users.length = 0;
  config.chats[0] = "300";
  assert.equal(policy.allows(message), true);
  assert.equal(new DelegationPolicy(config).allows(message), false);
  assert.throws(() => new DelegationPolicy({users, chats: [], messages: [{id: "1", msg: "a"}, {id: "1", msg: "b"}]}));
});
