import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {randomBytes} from "node:crypto";
import {parseAccount, readAccount, readEnvironment, lockAccount} from "./account";

test("account mapping retains existing session, app name and SOCKS settings", () => {
  const config = parseAccount({api_id: 123, api_hash: "private", session: "existing", app_name: "TeleBox",
    unknown: {future: true}, proxy: {socksType: 5, ip: "localhost", port: 1080, username: "name", password: "private"}});
  assert.equal(config.apiId, 123);
  assert.equal(config.deviceModel, "TeleBox");
  assert.equal(config.session, "existing");
  assert.equal(config.proxy?.timeout, 10);
});

test("invalid account inputs fail with fixed diagnostics", () => {
  for (const value of [null, [], {}, {api_id: 1, api_hash: "secret", session: ""},
    {api_id: 1, api_hash: "secret", session: "secret", proxy: {ip: "secret"}}]) {
    assert.throws(() => parseAccount(value), /^Error: Account startup failed: CONFIG$/);
  }
});

test("reading configuration and dotenv does not rewrite private data", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-account-"));
  try {
    const content = '{"api_id":1,"api_hash":"private","session":"existing","unknown":9007199254740993}\n';
    await fs.writeFile(path.join(root, "config.json"), content);
    await fs.writeFile(path.join(root, ".env"), 'TB_PREFIX="!"\nNODE_ENV=production\n');
    assert.equal((await readAccount(root)).session, "existing");
    assert.deepEqual(await readEnvironment(root, {TB_PREFIX: ".", UNSET: undefined}), {TB_PREFIX: ".", NODE_ENV: "production"});
    assert.equal(await fs.readFile(path.join(root, "config.json"), "utf8"), content);
    await fs.unlink(path.join(root, "config.json"));
    await fs.symlink(path.join(root, ".env"), path.join(root, "config.json"));
    await assert.rejects(readAccount(root), /CONFIG/);
  } finally {await fs.rm(root, {recursive: true, force: true});}
});

test("kernel lock excludes competing open descriptions and releases on close", {skip: process.platform !== "linux"}, async () => {
  const key = randomBytes(256);
  const close = await lockAccount(key);
  try {await assert.rejects(lockAccount(key), /BUSY/);} finally {await close();}
  const closeAgain = await lockAccount(key);
  await closeAgain();
  await closeAgain();
});
