import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  buildReconciledPluginRecord,
  getMergedRemotePluginsIndex,
  isLocallyModifiedPlugin,
  replacePluginFileAtomicallyWithin,
  resolvePluginPathWithin,
  resolvePluginsIndexUrl,
  withTpmOperationLock as withPanelTpmOperationLock,
} from "./tpmService";
import {
  buildReconciledPluginRecord as buildCliReconciledPluginRecord,
  replacePluginFileAtomicallyWithin as replaceCliPluginFileAtomicallyWithin,
  resolvePluginPathWithin as resolveCliPluginPathWithin,
  resolvePluginsIndexUrl as resolveCliPluginsIndexUrl,
  withTpmOperationLock as withCliTpmOperationLock,
} from "../../plugin/tpm";

test("plugin paths reject traversal and symlinks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-tpm-path-"));
  try {
    for (const name of ["../evil", "a/b", ".hidden", "x".repeat(65)]) {
      assert.throws(() => resolvePluginPathWithin(root, name), /非法插件名/);
      assert.throws(() => resolveCliPluginPathWithin(root, name), /非法插件名/);
    }

    const outside = path.join(root, "outside.ts");
    fs.writeFileSync(outside, "export default {}", "utf8");
    fs.symlinkSync(outside, path.join(root, "linked.ts"));
    assert.throws(
      () => resolvePluginPathWithin(root, "linked"),
      /符号链接/,
    );
    fs.symlinkSync(path.join(root, "missing.ts"), path.join(root, "dangling.ts"));
    assert.throws(
      () => resolvePluginPathWithin(root, "dangling"),
      /符号链接/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub plugin source URLs handle root, tree branch, and raw index", () => {
  assert.equal(
    resolvePluginsIndexUrl("https://github.com/acme/plugins"),
    "https://raw.githubusercontent.com/acme/plugins/HEAD/plugins.json",
  );
  assert.equal(
    resolvePluginsIndexUrl("https://github.com/acme/plugins/tree/dev"),
    "https://raw.githubusercontent.com/acme/plugins/dev/plugins.json",
  );
  assert.equal(
    resolvePluginsIndexUrl(
      "https://raw.githubusercontent.com/acme/plugins/feature/x/plugins.json",
    ),
    "https://raw.githubusercontent.com/acme/plugins/feature/x/plugins.json",
  );
  assert.throws(
    () => resolvePluginsIndexUrl("https://github.com/acme/plugins/tree/feature/x"),
    /含斜杠的分支/,
  );
  for (const input of [
    "https://github.com/acme/plugins",
    "https://github.com/acme/plugins/tree/dev",
    "https://raw.githubusercontent.com/acme/plugins/feature/x/plugins.json",
  ]) {
    assert.equal(resolveCliPluginsIndexUrl(input), resolvePluginsIndexUrl(input));
  }
  assert.throws(
    () => resolveCliPluginsIndexUrl("https://github.com/acme/plugins/tree/feature/x"),
    /含斜杠的分支/,
  );
});

test("configured custom source failure aborts instead of using official only", async () => {
  await assert.rejects(
    getMergedRemotePluginsIndex({
      customSource: { url: "https://github.com/acme/plugins" },
      fetchIndex: async (url) =>
        url.includes("TeleBoxOrg")
          ? {
              status: 200,
              data: { official: { url: "https://example.com/official.ts" } },
            }
          : { status: 503, data: {} },
    }),
    /自定义插件源获取失败，已中止操作/,
  );

  await assert.rejects(
    getMergedRemotePluginsIndex({
      customSource: { url: "https://github.com/acme/plugins" },
      fetchIndex: async (url) => ({
        status: 200,
        data: url.includes("TeleBoxOrg")
          ? {}
          : { "../../escape": { url: "https://example.com/escape.ts" } },
      }),
    }),
    /非法插件名/,
  );
});

test("content hash protects local changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-tpm-hash-"));
  const filePath = path.join(root, "demo.ts");
  try {
    const installed = "export default 'installed';\n";
    fs.writeFileSync(filePath, installed, "utf8");
    const record = {
      url: "https://example.com/demo.ts",
      _updatedAt: Date.now(),
      _contentHash: createHash("sha256").update(installed).digest("hex"),
    };
    assert.equal(isLocallyModifiedPlugin(filePath, installed, record), false);

    const edited = "export default 'locally-edited';\n";
    fs.writeFileSync(filePath, edited, "utf8");
    assert.equal(isLocallyModifiedPlugin(filePath, edited, record), true);
    assert.equal(
      isLocallyModifiedPlugin(filePath, installed, {
        url: "https://example.com/demo.ts",
        _updatedAt: 0,
        _baseline: "unknown",
      }),
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("first-time adoption records an unknown baseline in CLI and Panel", () => {
  const remote = {
    url: "https://example.com/demo.ts",
    desc: "demo",
  };
  for (const build of [
    buildReconciledPluginRecord,
    buildCliReconciledPluginRecord,
  ]) {
    const record = build(remote);
    assert.equal(record._baseline, "unknown");
    assert.equal(record._contentHash, undefined);
    assert.equal(record._updatedAt, 0);
  }
});

test("CLI and Panel serialize on the same TPM operation lock", async () => {
  const events: string[] = [];
  let release!: () => void;
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });

  const cli = withCliTpmOperationLock(async () => {
    events.push("cli:start");
    started();
    await hold;
    events.push("cli:end");
  });
  await firstStarted;
  const panel = withPanelTpmOperationLock(async () => {
    events.push("panel:start");
    events.push("panel:end");
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, ["cli:start"]);
  release();
  await Promise.all([cli, panel]);
  assert.deepEqual(events, ["cli:start", "cli:end", "panel:start", "panel:end"]);
});

test("backup failure leaves the original plugin untouched in CLI and Panel", () => {
  for (const replace of [
    replacePluginFileAtomicallyWithin,
    replaceCliPluginFileAtomicallyWithin,
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-tpm-backup-"));
    try {
      const filePath = path.join(root, "demo.ts");
      fs.writeFileSync(filePath, "old", "utf8");
      assert.throws(
        () =>
          replace(root, "demo", "new", () => {
            throw new Error("injected backup failure");
          }),
        /injected backup failure/,
      );
      assert.equal(fs.readFileSync(filePath, "utf8"), "old");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
