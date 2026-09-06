const assert = require("node:assert/strict");
const {StringSession} = require("../node_modules/teleproto/sessions");
const {AuthKey} = require("../node_modules/teleproto/crypto/AuthKey");

// Test fixture generator only. It accepts no production session input.
async function main() {
  const fixtures = [];
  for (const address of ["149.154.167.51", "2001:db8::1"]) {
    const session = new StringSession("");
    session.setDC(2, address, 443);
    const key = Buffer.alloc(256, 0xa5);
    session.authKey = new AuthKey();
    await session.authKey.setKey(key);
    const encoded = session.save();
    const restored = new StringSession(encoded);
    await restored.load();
    assert.equal(restored.serverAddress, address);
    assert.deepEqual(restored.authKey.getKey(), key);
    fixtures.push({address, dc: 2, port: 443, teleproto: encoded});
  }
  process.stdout.write(JSON.stringify({synthetic: true, fixtures}) + "\n");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
