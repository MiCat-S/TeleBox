import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canUsePanelCapability } from "./panel/auth";
import { getRequiredPanelCapability } from "./panel/httpServer";
import { maskToken, SecurePanelConfigAdapter } from "./panel/configStore";
import { createToolRuntime } from "./agentTools";
import {
  ensurePrivateConfigPath,
  redactProxyObject,
  redactProxyUrl,
  writePrivateJsonAtomic,
} from "./apiConfig";
import type { PanelConfig } from "./panel/types";

test("extra panel admins are read-only on privileged routes", () => {
  const ownerOnly: Array<[string, string]> = [
    ["POST", "/api/tpm/install"],
    ["POST", "/api/tpm/uninstall"],
    ["POST", "/api/tpm/update"],
    ["POST", "/api/tpm/source"],
    ["GET", "/api/tpm/update/stream"],
    ["PUT", "/api/settings/agent"],
    ["PUT", "/api/config"],
    ["POST", "/api/admins"],
    ["DELETE", "/api/admins/123"],
  ];
  for (const [method, route] of ownerOnly) {
    const capability = getRequiredPanelCapability(method, route);
    assert.notEqual(capability, "read", `${method} ${route}`);
    assert.equal(canUsePanelCapability(false, capability), false);
    assert.equal(canUsePanelCapability(true, capability), true);
  }
  assert.equal(getRequiredPanelCapability("GET", "/api/settings"), "read");
  assert.equal(getRequiredPanelCapability("GET", "/api/tpm/source"), "read");
});

test("project agents cannot bypass the shell boundary", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-agent-shell-"));
  const marker = path.join(root, "executed.txt");
  try {
    const context = {
      scope: "telebox",
      projectRoot: root,
      workspace: { dir: root },
      provider: {} as never,
      maxSteps: 1,
      timeoutMs: 1_000,
      msg: {},
      onPlanChange: async () => {},
      onToolStart: async () => {},
      onToolFinish: async () => {},
      dispatchPlugin: async () => {},
    } as const;
    const runtime = createToolRuntime(context);
    assert.equal(runtime.definitions.some((tool) => tool.name === "run_command"), false);
    assert.equal(runtime.definitions.some((tool) => tool.name === "write_file"), true);
    const systemRuntime = createToolRuntime({
      ...context,
      scope: "system",
    });
    assert.equal(
      systemRuntime.definitions.some((tool) => tool.name === "run_command"),
      true,
    );

    const result = await runtime.execute("run_command", {
      command: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'owned')"`,
      cwd: root,
    });
    assert.equal(result.ok, false);
    assert.match(result.content, /项目智能体已禁用任意 shell/);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("proxy URLs and objects redact usernames and passwords", () => {
  const url = redactProxyUrl("http://alice:secret@127.0.0.1:8080/path?token=hidden");
  assert.equal(url.includes("alice"), false);
  assert.equal(url.includes("secret"), false);
  assert.equal(url.includes("hidden"), false);

  const object = redactProxyObject({
    host: "127.0.0.1",
    username: "alice",
    password: "secret",
    auth: { username: "nested", password: "nested-secret" },
  }) as Record<string, any>;
  assert.equal(object.username, "***");
  assert.equal(object.password, "***");
  assert.equal(object.auth.username, "***");
  assert.equal(object.auth.password, "***");
  assert.equal(maskToken("123456:secret-bot-token").includes("secret-bot-token"), false);
});

test("main and panel config writes are atomic and private", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-config-mode-"));
  try {
    const mainFile = path.join(root, "main", "config.json");
    fs.mkdirSync(path.dirname(mainFile), { recursive: true, mode: 0o755 });
    fs.writeFileSync(mainFile, "{}", { mode: 0o644 });
    ensurePrivateConfigPath(mainFile);
    assert.equal(fs.statSync(path.dirname(mainFile)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(mainFile).mode & 0o777, 0o600);

    writePrivateJsonAtomic(mainFile, { session: "secret-session" });
    assert.deepEqual(JSON.parse(fs.readFileSync(mainFile, "utf-8")), {
      session: "secret-session",
    });
    assert.equal(fs.statSync(mainFile).mode & 0o777, 0o600);
    assert.equal(
      fs.readdirSync(path.dirname(mainFile)).some((name) => name.endsWith(".tmp")),
      false,
    );

    const panelFile = path.join(root, "panel", "config.json");
    const panelConfig: PanelConfig = {
      enabled: true,
      botToken: "secret-bot-token",
      publicBaseUrl: "",
      bindHost: "127.0.0.1",
      bindPort: 8787,
      sessionSecret: "secret-session-token-value",
      admins: [],
      displayName: "TeleBox Panel",
      updatedAt: Date.now(),
      tunnelMode: "off",
      tunnelUrl: "",
    };
    const adapter = new SecurePanelConfigAdapter(panelFile);
    await adapter.write(panelConfig);
    assert.equal(fs.statSync(path.dirname(panelFile)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(panelFile).mode & 0o777, 0o600);
    assert.deepEqual(await adapter.read(), panelConfig);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
