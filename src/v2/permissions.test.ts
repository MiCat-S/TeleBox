import assert from "node:assert/strict";
import test from "node:test";
import {isOwner} from "./permissions";

test("owner checks use exact decimal string identity", () => {
  const message = {id: 1, chatId: "1", senderId: "9007199254740993", text: "", outgoing: false};
  assert.equal(isOwner(message, "9007199254740993"), true);
  assert.equal(isOwner(message, "9007199254740992"), false);
  assert.equal(isOwner(message, "1e3"), false);
});
