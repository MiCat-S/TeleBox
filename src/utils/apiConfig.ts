import fs from "fs";
import path from "path";
import readline from "readline";
import crypto from "crypto";

interface TelegramAPI {
  api_id?: number;
  api_hash?: string;
  session?: string;
  proxy?: {
    socksType: 4 | 5;
    ip: string;
    port: number;
    username?: string;
    password?: string;
    timeout?: number;
  };
  connectionRetries?: number;
}

const CONFIG_PATH = path.join(process.cwd(), "config.json");

function ensurePrivateConfigPath(filePath: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    fs.chmodSync(directory, 0o700);
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
  }
}

function writePrivateJsonAtomic(filePath: string, value: unknown): void {
  ensurePrivateConfigPath(filePath);
  const tempPath = `${filePath}.${process.pid}.${cryptoRandomSuffix()}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), "utf-8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
    if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function cryptoRandomSuffix(): string {
  return crypto.randomBytes(8).toString("hex");
}

function redactProxyUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    const auth = url.username || url.password ? "***:***@" : "";
    return `${url.protocol}//${auth}${url.host}${url.pathname}`;
  } catch {
    return proxyUrl.replace(/\/\/[^/@\s]+@/, "//***:***@");
  }
}

function redactProxyObject(proxy: unknown): unknown {
  if (!proxy || typeof proxy !== "object") return proxy;
  const input = proxy as Record<string, unknown>;
  const output: Record<string, unknown> = { ...input };
  if (output.username) output.username = "***";
  if (output.password) output.password = "***";
  if (output.auth && typeof output.auth === "object") {
    const auth = output.auth as Record<string, unknown>;
    output.auth = {
      ...auth,
      username: auth.username ? "***" : auth.username,
      password: auth.password ? "***" : auth.password,
    };
  }
  return output;
}

function ensureConfigFileExists(): void {
  ensurePrivateConfigPath(CONFIG_PATH);
  if (!fs.existsSync(CONFIG_PATH) || fs.statSync(CONFIG_PATH).size === 0) {
    writePrivateJsonAtomic(CONFIG_PATH, {});
  }
}

function loadConfig(): TelegramAPI {
  ensureConfigFileExists();
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("❌ 无法读取 config.json:", e);
    return {};
  }
}

function saveConfig(config: TelegramAPI): void {
  writePrivateJsonAtomic(CONFIG_PATH, config);
}

function promptInput(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function storeStringSession(session: string): void {
  const config = loadConfig();
  config.session = session;
  saveConfig(config);
}

async function initConfig(): Promise<TelegramAPI> {
  const config = loadConfig();

  let { api_id, api_hash } = config;

  if (!api_id || !api_hash) {
    // 缺失时，提示输入
    if (!api_id) {
      let input: string;
      while (true) {
        input = await promptInput("请输入 API_ID: ");
        if (input) break; // 输入有效，跳出循环
        console.error("❌ API_ID 不能为空，请重新输入。");
      }
      api_id = parseInt(input);
    }

    if (!api_hash) {
      let input: string;
      while (true) {
        input = await promptInput("请输入 API_HASH: ");
        if (input) break; // 输入有效，跳出循环
        console.error("❌ API_HASH 不能为空，请重新输入。");
      }
      api_hash = input;
    }

    const newConfig: TelegramAPI = { api_id, api_hash };
    saveConfig(newConfig);
    return newConfig;
  }

  return config;
}

let configPromise: Promise<TelegramAPI> | null = null;

function getApiConfig(): Promise<TelegramAPI> {
  if (!configPromise) {
    configPromise = initConfig();
  }
  return configPromise;
}

export {
  ensurePrivateConfigPath,
  getApiConfig,
  redactProxyObject,
  redactProxyUrl,
  storeStringSession,
  writePrivateJsonAtomic,
};
