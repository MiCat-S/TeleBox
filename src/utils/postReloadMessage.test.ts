import test from "node:test";
import assert from "node:assert/strict";
import { registerRuntimeAccess } from "./runtimeAccess";
import { reloadAndFinalize } from "./postReloadMessage";
import { cronManager } from "./cronManager";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGenerationContext } from "./generationContext";
import { Plugin } from "./pluginBase";
import {
  createPluginLoadReport,
  loadPlugins,
  runPluginSetupsForReport,
  withPluginOperationLock,
  writeJsonFileAtomically,
} from "./pluginManager";
import type { TeleBoxRuntime } from "./runtimeManager";

test("reloadAndFinalize treats reload false as failure", async () => {
  let editedText = "";
  registerRuntimeAccess({
    getCurrentGeneration: () => 1,
    tryGetCurrentRuntime: () => null,
    getGlobalClient: async () => ({
      editMessage: async (_peer: unknown, options: { text?: string }) => {
        editedText = options.text || "";
      },
    }),
    reloadRuntime: async () => undefined,
    startRuntime: async () => undefined,
  });

  const result = await reloadAndFinalize(
    { peerId: "123", id: 456 } as never,
    "success text must not be shown",
    {
      reload: async () => false,
      failureText: "reload failed and rolled back",
    },
  );

  assert.equal(result, false);
  assert.equal(editedText, "reload failed and rolled back");
});

test("duplicate cron registration keeps the first task without throwing", () => {
  const name = `test-cron-conflict-${process.pid}`;
  const dispose = cronManager.set(name, "0 0 0 1 1 *", async () => undefined);
  try {
    assert.doesNotThrow(() =>
      cronManager.set(name, "0 0 0 2 1 *", async () => undefined),
    );
    assert.equal(cronManager.has(name), true);
  } finally {
    dispose();
  }
});

test("one plugin setup failure is reported without disabling unrelated plugins", async () => {
  const context = createGenerationContext(777);
  const runtime = {
    generation: 777,
    state: "starting",
    client: {},
    context,
    signal: context.signal,
    createdAt: Date.now(),
  } as unknown as TeleBoxRuntime;
  const good = {
    name: "good",
    description: "good",
    cmdHandlers: {},
    setup: async () => undefined,
  } as Plugin;
  let failedSetupDisposed = 0;
  const bad = {
    name: "bad",
    description: "bad",
    cmdHandlers: {},
    setup: async ({ lifecycle }) => {
      lifecycle.trackDisposable(() => {
        failedSetupDisposed++;
      });
      throw new Error("injected setup failure");
    },
  } as Plugin;
  const report = createPluginLoadReport(777);
  const loaded = await runPluginSetupsForReport([bad, good], runtime, report);
  assert.deepEqual(loaded.map((plugin) => plugin.name), ["good"]);
  assert.equal(report.loaded.some((item) => item.pluginName === "good"), true);
  assert.equal(
    report.failures.some(
      (failure) =>
        failure.pluginName === "bad" && failure.stage === "setup",
    ),
    true,
  );
  assert.equal(failedSetupDisposed, 1);
  await context.drain();
});

test("atomic JSON writer fsyncs and preserves the old source on rename failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-source-atomic-"));
  const file = path.join(root, "source.json");
  const originalRename = fs.renameSync;
  const originalFsync = fs.fsyncSync;
  let fsyncCalls = 0;
  try {
    fs.fsyncSync = ((fd) => {
      fsyncCalls++;
      return originalFsync(fd);
    }) as typeof fs.fsyncSync;
    writeJsonFileAtomically(file, { url: "old" });
    fs.renameSync = ((from, to) => {
      if (path.resolve(String(to)) === path.resolve(file)) {
        throw new Error("injected rename failure");
      }
      return originalRename(from, to);
    }) as typeof fs.renameSync;
    assert.throws(
      () => writeJsonFileAtomically(file, { url: "new" }),
      /injected rename failure/,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { url: "old" });
    assert.deepEqual(fs.readdirSync(root), ["source.json"]);
    assert.ok(fsyncCalls >= 2);
  } finally {
    fs.renameSync = originalRename;
    fs.fsyncSync = originalFsync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("direct plugin reload waits for an in-flight TPM operation", async () => {
  const events: string[] = [];
  let release!: () => void;
  let started!: () => void;
  const operationStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  registerRuntimeAccess({
    getCurrentGeneration: () => 1,
    tryGetCurrentRuntime: () => null,
    getGlobalClient: async () => ({}),
    reloadRuntime: async () => {
      events.push("reload");
      return {};
    },
    startRuntime: async () => undefined,
  });

  const operation = withPluginOperationLock(async () => {
    events.push("operation:start");
    started();
    await hold;
    events.push("operation:end");
  });
  await operationStarted;
  const reload = loadPlugins();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, ["operation:start"]);
  release();
  assert.equal(await reload, true);
  await operation;
  assert.deepEqual(events, ["operation:start", "operation:end", "reload"]);

  assert.equal(
    await withPluginOperationLock(async () => await loadPlugins()),
    true,
  );
  assert.deepEqual(events, [
    "operation:start",
    "operation:end",
    "reload",
    "reload",
  ]);
});
