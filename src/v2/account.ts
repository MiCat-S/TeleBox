import {createHash} from "node:crypto";
import {constants} from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {spawnSync} from "node:child_process";
import {parse as parseEnv} from "dotenv";
import type {TelegramClientParams} from "teleproto/client/telegramBaseClient";

export class AccountError extends Error {
  constructor(readonly code: "CONFIG" | "BUSY" | "LOCK" | "PLATFORM" | "LEGACY") {
    super(`Account startup failed: ${code}`);
  }
}
export interface AccountConfig {
  apiId: number;
  apiHash: string;
  session: string;
  deviceModel: string;
  proxy?: TelegramClientParams["proxy"];
}

export function parseAccount(value: unknown): AccountConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AccountError("CONFIG");
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.api_id) || Number(record.api_id) <= 0 ||
      typeof record.api_hash !== "string" || !record.api_hash.trim() ||
      typeof record.session !== "string" || !record.session.trim()) throw new AccountError("CONFIG");
  let proxy: AccountConfig["proxy"];
  if (record.proxy != null) {
    if (typeof record.proxy !== "object" || Array.isArray(record.proxy)) throw new AccountError("CONFIG");
    const input = record.proxy as Record<string, unknown>;
    if (![4, 5].includes(Number(input.socksType)) || typeof input.ip !== "string" || !input.ip ||
        !Number.isInteger(input.port) || Number(input.port) < 1 || Number(input.port) > 65535 ||
        [input.username, input.password].some(item => item !== undefined && typeof item !== "string")) throw new AccountError("CONFIG");
    proxy = {socksType: Number(input.socksType) as 4 | 5, ip: input.ip, port: Number(input.port),
      username: input.username as string | undefined, password: input.password as string | undefined, timeout: 10};
  }
  return {apiId: Number(record.api_id), apiHash: record.api_hash, session: record.session,
    deviceModel: typeof record.app_name === "string" && record.app_name.trim() ? record.app_name : "Mi Box", proxy};
}

function isCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}

export async function readAccount(root: string): Promise<AccountConfig> {
  let handle;
  try {
    handle = await fs.open(path.join(root, "config.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1_048_576) throw new AccountError("CONFIG");
    return parseAccount(JSON.parse(await handle.readFile("utf8")));
  } catch {throw new AccountError("CONFIG");}
  finally {await handle?.close();}
}

export async function readEnvironment(root: string, inherited: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  let content = "";
  let handle;
  try {
    handle = await fs.open(path.join(root, ".env"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1_048_576) throw new AccountError("CONFIG");
    content = await handle.readFile("utf8");
  }
  catch (error) {if (!isCode(error, "ENOENT")) throw new AccountError("CONFIG");}
  finally {await handle?.close();}
  // Match dotenv's default: an inherited variable takes precedence over the file.
  return {...parseEnv(content), ...Object.fromEntries(Object.entries(inherited).filter(([, value]) => value !== undefined))};
}

export async function assertLegacyStopped(root: string): Promise<void> {
  if (process.platform !== "linux") throw new AccountError("PLATFORM");
  const directory = await fs.realpath(root);
  for (const pid of (await fs.readdir("/proc")).filter(entry => /^\d+$/.test(entry) && Number(entry) !== process.pid)) {
    try {
      if (await fs.realpath(`/proc/${pid}/cwd`) !== directory) continue;
      const executable = path.basename(await fs.readlink(`/proc/${pid}/exe`));
      // PM2 is the direct supervisor, not a second account client.
      if (Number(pid) === process.ppid && /^(node|nodejs)$/.test(executable)) {
        const title = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0")[0];
        if (/^PM2 v\d+\.\d+\.\d+: God Daemon \(.+\)$/.test(title)) continue;
      }
      if (/^(node|nodejs|bun|deno)(?:-[\d.]+)?$/.test(executable)) {
        const command = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8"));
        // Reject the legacy account entrypoint, while allowing supervisors and
        // unrelated short-lived Node helpers in the same working directory.
        if (command.includes("/src/index.ts") || command.includes("scripts/run-tsx.cjs")) {
          throw new AccountError("LEGACY");
        }
      }
    } catch (error) {
      if (isCode(error, "ENOENT") || isCode(error, "ESRCH")) continue;
      // A hidden process cannot prove account exclusivity; fail closed.
      throw error instanceof AccountError ? error : new AccountError("LEGACY");
    }
  }
}

/** Kernel flock survives the short-lived flock utility via the inherited open
 * file description. It releases on process exit, including SIGKILL, without a
 * resident helper or unsafe stale-PID lock deletion. Never unlink the lock file. */
export async function lockAccount(key: Buffer): Promise<() => Promise<void>> {
  if (process.platform !== "linux" || !process.getuid) throw new AccountError("PLATFORM");
  if (key.length !== 256) throw new AccountError("CONFIG");
  const uid = process.getuid();
  const directory = path.join(await fs.realpath(os.tmpdir()), `telebox-v2-accounts-${uid}`);
  await fs.mkdir(directory, {mode: 0o700}).catch(error => {if (!isCode(error, "EEXIST")) throw error;});
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077)) throw new AccountError("LOCK");
  const file = path.join(directory, createHash("sha256").update(key).digest("hex") + ".lock");
  const handle = await fs.open(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.nlink !== 1 || entry.uid !== uid || (entry.mode & 0o077)) throw new AccountError("LOCK");
    const result = spawnSync("/usr/bin/flock", ["--nonblock", "3"], {stdio: ["ignore", "ignore", "ignore", handle.fd], timeout: 5000});
    if (result.status !== 0) throw new AccountError(result.status === 1 ? "BUSY" : "LOCK");
  } catch (error) {await handle.close(); throw error instanceof AccountError ? error : new AccountError("LOCK");}
  let closed = false;
  return async () => {if (!closed) {closed = true; await handle.close();}};
}
