import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {spawnSync} from "node:child_process";

test("offline CLI integrates built-ins, SQLite reload, services and admission without user data", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telebox-check-cli-")));
  const marker = Buffer.from('{"private_config_marker":"untouched"}');
  fs.writeFileSync(path.join(root, "config.json"), marker);
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const result = spawnSync(process.execPath, [path.join(__dirname, "index.js"), "--check"], {
    cwd: root, env: {...process.env, TMPDIR: root, TEMP: root, TMP: root}, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.result, "ok");
  assert.deepEqual(output.loaded, ["alias", "check", "help", "loglevel", "prefix"]);
  assert.deepEqual(output.checks, {commands: true, services: true, help: true, aliases: true,
    prefixes: true, prefixPersistence: true, logging: true, loggingReload: true,
    sqliteReload: true, ownerAdmission: true, editedAdmission: true, compilerResident: false});
  assert.deepEqual(output.lifecycle, {completed: true, timedOut: false, pendingTasks: 0, pendingResources: 0, errors: []});
  assert.deepEqual(fs.readFileSync(path.join(root, "config.json")), marker);
  assert.deepEqual(fs.readdirSync(root), ["config.json"]);
});

test("CLI requires explicit offline mode and does not touch the current directory", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telebox-check-mode-")));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const args of [[], ["--start"], ["--check", "--start"]]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, "index.js"), ...args], {cwd: root, encoding: "utf8", timeout: 5000});
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /online startup is not available/);
    assert.deepEqual(fs.readdirSync(root), []);
  }
});
