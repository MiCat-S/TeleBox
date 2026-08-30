import { Plugin, isValidPlugin } from "@utils/pluginBase";
import {
  createDirectoryInTemp,
  createDirectoryInAssets,
} from "@utils/pathHelpers";
import path from "path";
import fs from "fs";
import axios from "axios";
import { Api } from "teleproto";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { JSONFilePreset } from "lowdb/node";
import {
  getLastPluginLoadReport,
  getPrefixes,
  pluginFailedInReport,
  withPluginOperationLock,
  writeJsonFileAtomically,
} from "@utils/pluginManager";
import { tryGetCurrentGenerationContext } from "@utils/runtimeManager";
import { htmlEscape } from "@utils/htmlEscape";
import { createHash, randomBytes } from "crypto";
import {
  sendOrEditMessage,
  reloadAndFinalize,
} from "@utils/postReloadMessage";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const MAX_MESSAGE_LENGTH = 4000;
const PLUGINS_INDEX_URL =
  "https://raw.githubusercontent.com/MiCat-S/TeleBox-Plugins/main/plugins.json";
const PLUGINS_REPOSITORY_URL =
  "https://github.com/MiCat-S/TeleBox-Plugins";
const CUSTOM_SOURCE_CONFIG_PATH = path.join(
  createDirectoryInAssets("tpm"),
  "source.json"
);
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 4;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const DEFAULT_HEADERS = {
  "User-Agent": "TeleBox-TPM/1.0",
  Accept: "application/json, text/plain, */*",
};

interface PluginRecord {
  url: string;
  desc?: string;
  _updatedAt: number;
  /** sha256 of content last written by TPM install/update; used to detect local edits */
  _contentHash?: string;
  _baseline?: "trusted" | "unknown";
}

type Database = Record<string, PluginRecord>;
type RemotePluginInfo = { url: string; desc?: string };
type RemotePluginsIndex = Record<string, RemotePluginInfo>;

export function buildReconciledPluginRecord(
  remote: RemotePluginInfo,
  old?: PluginRecord,
): PluginRecord {
  return {
    url: remote.url,
    desc: remote.desc || old?.desc || "暂无描述",
    _updatedAt: old?._updatedAt || 0,
    ...(old?._contentHash ? { _contentHash: old._contentHash } : {}),
    ...(old?._baseline
      ? { _baseline: old._baseline }
      : old
        ? {}
        : { _baseline: "unknown" as const }),
  };
}

interface CustomSourceConfig {
  url: string;
}

function getCustomSourceConfigPath(): string {
  try {
    return path.join(createDirectoryInAssets("tpm"), "source.json");
  } catch {
    return CUSTOM_SOURCE_CONFIG_PATH;
  }
}

async function getCustomSourceConfig(): Promise<CustomSourceConfig | null> {
  const cfgPath = getCustomSourceConfigPath();
  if (!fs.existsSync(cfgPath)) return null;
  try {
    const raw = fs.readFileSync(cfgPath, "utf-8");
    const parsed = JSON.parse(raw) as { url?: unknown };
    if (typeof parsed.url !== "string" || !parsed.url.trim()) {
      throw new Error("缺少 url");
    }
    return { url: parsed.url.trim() };
  } catch (error) {
    throw new Error(
      `自定义插件源配置无效: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function setCustomSourceConfig(url: string): Promise<void> {
  const cfgPath = getCustomSourceConfigPath();
  writeJsonFileAtomically(cfgPath, { url });
}

export const withTpmOperationLock = withPluginOperationLock;

async function clearCustomSourceConfig(): Promise<void> {
  const cfgPath = getCustomSourceConfigPath();
  if (fs.existsSync(cfgPath)) {
    fs.unlinkSync(cfgPath);
  }
}

export function resolvePluginsIndexUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error("插件源 URL 格式无效");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("插件源仅支持 HTTPS URL");
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parsed.hostname === "raw.githubusercontent.com") {
    if (parts.length < 4 || parts[parts.length - 1] !== "plugins.json") {
      throw new Error("raw 插件源必须直接指向 plugins.json");
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  }
  if (parsed.hostname !== "github.com" || parts.length < 2) {
    throw new Error("插件源必须是 GitHub 仓库或 raw plugins.json URL");
  }

  const [owner, rawRepo, kind, ...rest] = parts;
  const repo = rawRepo.replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("GitHub 仓库 owner/repo 无效");
  }
  if (!kind) {
    return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/plugins.json`;
  }
  if (kind !== "tree" && kind !== "blob") {
    throw new Error("GitHub 插件源仅支持仓库根目录、/tree/<branch> 或 plugins.json 文件");
  }
  if (kind === "blob") {
    if (rest.length !== 2 || rest[1] !== "plugins.json") {
      throw new Error("GitHub blob URL 必须指向仓库根目录的 plugins.json");
    }
    return `https://raw.githubusercontent.com/${owner}/${repo}/${rest[0]}/plugins.json`;
  }
  if (rest.length === 0) throw new Error("GitHub tree URL 缺少分支名");
  if (rest.length > 1 || decodeURIComponent(rest[0]).includes("/")) {
    throw new Error(
      "含斜杠的分支无法从 /tree/ URL 无歧义解析，请直接提供对应的 raw plugins.json URL",
    );
  }
  return `https://raw.githubusercontent.com/${owner}/${repo}/${rest[0]}/plugins.json`;
}

function convertGithubToRawPluginUrl(url: string): string {
  return resolvePluginsIndexUrl(url);
}

function validateRemotePluginsIndex(
  value: unknown,
  sourceLabel: string,
): RemotePluginsIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${sourceLabel} plugins.json 不是对象`);
  }
  const result: RemotePluginsIndex = {};
  for (const [name, rawInfo] of Object.entries(value)) {
    assertValidPluginName(name);
    if (!rawInfo || typeof rawInfo !== "object" || Array.isArray(rawInfo)) {
      throw new Error(`${sourceLabel} 插件 ${name} 的记录无效`);
    }
    const info = rawInfo as Partial<RemotePluginInfo>;
    if (typeof info.url !== "string" || !info.url.trim()) {
      throw new Error(`${sourceLabel} 插件 ${name} 缺少 URL`);
    }
    result[name] = {
      url: info.url.trim(),
      ...(typeof info.desc === "string" ? { desc: info.desc } : {}),
    };
  }
  return result;
}

/** Fetch official + custom source index (custom overrides official). */
async function getMergedRemotePluginsIndex(): Promise<RemotePluginsIndex> {
  const merged: RemotePluginsIndex = {};
  
  // Fetch official index first
  try {
    const officialRes = await fetchWithRetry<RemotePluginsIndex>(PLUGINS_INDEX_URL);
    if (officialRes.status === 200 && officialRes.data && typeof officialRes.data === "object") {
      Object.assign(merged, validateRemotePluginsIndex(officialRes.data, "官方源"));
    } else {
      throw new Error(`HTTP ${officialRes.status}`);
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.log(`[TPM] 获取官方插件源失败: ${errMsg}`);
  }
  
  // Merge custom source entries (override official)
  const customSource = await getCustomSourceConfig();
  if (customSource) {
    const rawUrl = convertGithubToRawPluginUrl(customSource.url);
    try {
      const customRes = await fetchWithRetry<RemotePluginsIndex>(rawUrl);
      if (customRes.status === 200 && customRes.data && typeof customRes.data === "object") {
        Object.assign(merged, validateRemotePluginsIndex(customRes.data, "自定义源"));
      } else {
        throw new Error(`HTTP ${customRes.status}`);
      }
    } catch (error: unknown) {
      throw new Error(
        `自定义插件源获取失败，已中止操作: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  
  return merged;
}

const PLUGIN_PATH = path.join(process.cwd(), "plugins");
const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface PluginFileSnapshot {
  name: string;
  filePath: string;
  existed: boolean;
  content?: Buffer;
}

function assertValidPluginName(name: string): void {
  if (!PLUGIN_NAME_PATTERN.test(name)) {
    throw new Error(
      `非法插件名 "${name}"：仅允许 1-64 位字母、数字、下划线和连字符，且必须以字母或数字开头`,
    );
  }
}

function lstatIfExists(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function ensurePluginDirectory(): void {
  const stat = lstatIfExists(PLUGIN_PATH);
  if (stat) {
    if (stat.isSymbolicLink()) {
      throw new Error(`插件目录不能是符号链接: ${PLUGIN_PATH}`);
    }
    if (!stat.isDirectory()) throw new Error(`插件目录路径不是目录: ${PLUGIN_PATH}`);
    return;
  }
  fs.mkdirSync(PLUGIN_PATH, { recursive: true });
}

export function resolvePluginPathWithin(
  root: string,
  name: string,
  options?: { mustExist?: boolean },
): string {
  assertValidPluginName(name);
  const rootStat = lstatIfExists(root);
  if (rootStat) {
    if (rootStat.isSymbolicLink()) {
      throw new Error(`插件目录不能是符号链接: ${root}`);
    }
    if (!rootStat.isDirectory()) throw new Error(`插件目录路径不是目录: ${root}`);
  } else {
    fs.mkdirSync(root, { recursive: true });
  }
  const resolvedRoot = path.resolve(root);
  const filePath = path.resolve(resolvedRoot, `${name}.ts`);
  const relative = path.relative(resolvedRoot, filePath);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`插件路径越界: ${name}`);
  }
  const fileStat = lstatIfExists(filePath);
  if (fileStat?.isSymbolicLink()) {
    throw new Error(`拒绝访问符号链接插件: ${name}`);
  }
  if (fileStat && !fileStat.isFile()) {
    throw new Error(`插件路径不是普通文件: ${name}`);
  }
  if (options?.mustExist && !fileStat) {
    throw new Error("插件文件不存在");
  }
  return filePath;
}

function resolvePluginFilePath(
  name: string,
  options?: { mustExist?: boolean },
): string {
  ensurePluginDirectory();
  return resolvePluginPathWithin(PLUGIN_PATH, name, options);
}

class EntityManager {
  private count = 0;
  private readonly LIMIT = 100;
  private readonly IMPORTANT_TAGS = ['blockquote', 'a', 'b', 'i', 'u'];
  
  canAdd(tag: string): boolean {
    if (this.IMPORTANT_TAGS.includes(tag)) {
      return true;
    }
    return this.count < this.LIMIT;
  }
  
  add(tag: string) {
    this.count++;
  }
  
  getCount(): number {
    return this.count;
  }
  
  hasReachedLimit(): boolean {
    return this.count >= this.LIMIT;
  }
}

function codeTag(value: string): string {
  return `<code>${htmlEscape(value)}</code>`;
}

function hashPluginContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function isLocallyModifiedPlugin(
  filePath: string,
  currentContent: string,
  record: PluginRecord,
): boolean {
  const localHash = hashPluginContent(currentContent);
  if (record._contentHash) {
    return localHash !== record._contentHash;
  }
  if (record._baseline === "unknown") return true;
  // Legacy records without hash: treat mtime newer than last TPM write as local edit
  try {
    const mtimeMs = fs.statSync(filePath).mtimeMs;
    const updatedAt = record._updatedAt || 0;
    return mtimeMs > updatedAt + 2000;
  } catch {
    return false;
  }
}

function snapshotPluginFile(name: string): PluginFileSnapshot {
  const filePath = resolvePluginFilePath(name);
  const existed = fs.existsSync(filePath);
  return {
    name,
    filePath,
    existed,
    ...(existed ? { content: fs.readFileSync(filePath) } : {}),
  };
}

function atomicReplaceFile(filePath: string, content: string | Buffer): void {
  const existing = lstatIfExists(filePath);
  const mode = existing?.isFile() ? existing.mode & 0o777 : 0o600;
  const tempPath = path.join(
    path.dirname(filePath),
    `_${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, content, { flag: "wx", mode });
    if (lstatIfExists(filePath)?.isSymbolicLink()) {
      throw new Error(`拒绝覆盖符号链接插件: ${path.basename(filePath)}`);
    }
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

export function replacePluginFileAtomicallyWithin(
  root: string,
  name: string,
  content: string,
  backupWriter?: (snapshot: PluginFileSnapshot) => void,
): PluginFileSnapshot {
  const filePath = resolvePluginPathWithin(root, name);
  const existed = fs.existsSync(filePath);
  const snapshot: PluginFileSnapshot = {
    name,
    filePath,
    existed,
    ...(existed ? { content: fs.readFileSync(filePath) } : {}),
  };
  backupWriter?.(snapshot);
  atomicReplaceFile(snapshot.filePath, content);
  return snapshot;
}

function writePluginAtomically(name: string, content: string): PluginFileSnapshot {
  return replacePluginFileAtomicallyWithin(
    PLUGIN_PATH,
    name,
    content,
    saveSnapshotBackup,
  );
}

function deletePluginFile(name: string): PluginFileSnapshot {
  const snapshot = snapshotPluginFile(name);
  if (snapshot.existed) fs.unlinkSync(snapshot.filePath);
  return snapshot;
}

function restorePluginFiles(snapshots: PluginFileSnapshot[]): void {
  for (const snapshot of [...snapshots].reverse()) {
    const filePath = resolvePluginFilePath(snapshot.name);
    if (snapshot.existed && snapshot.content) {
      atomicReplaceFile(filePath, snapshot.content);
    } else if (lstatIfExists(filePath)) {
      if (lstatIfExists(filePath)?.isSymbolicLink()) {
        throw new Error(`回滚时发现符号链接插件: ${snapshot.name}`);
      }
      fs.unlinkSync(filePath);
    }
  }
}

function saveSnapshotBackup(snapshot: PluginFileSnapshot): void {
  if (!snapshot.existed || !snapshot.content) return;
  const cacheDir = createDirectoryInTemp("plugin_backups");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
  fs.writeFileSync(
    path.join(
      cacheDir,
      `${snapshot.name}_${timestamp}_${randomBytes(6).toString("hex")}.ts.bak`,
    ),
    snapshot.content,
    { flag: "wx", mode: 0o600 },
  );
}

async function persistPluginMutations(
  snapshots: PluginFileSnapshot[],
  db: Awaited<ReturnType<typeof getDatabase>>,
  previousDb: Database,
): Promise<void> {
  try {
    await db.write();
  } catch (error) {
    restorePluginFiles(snapshots);
    db.data = { ...previousDb };
    throw error;
  }
}

async function reloadWithRollback(
  snapshots: PluginFileSnapshot[],
  db: Awaited<ReturnType<typeof getDatabase>>,
  previousDb: Database,
): Promise<{ ok: boolean; failedNames: string[]; recovered: boolean }> {
  const { loadPlugins } = require("@utils/pluginManager") as typeof import("@utils/pluginManager");
  const loaded = await loadPlugins();
  const targetNames = [...new Set(snapshots.map((snapshot) => snapshot.name))];
  const report = getLastPluginLoadReport();
  const failedNames = loaded
    ? targetNames.filter((name) => pluginFailedInReport(report, name, PLUGIN_PATH))
    : targetNames;
  if (failedNames.length === 0) {
    return { ok: true, failedNames: [], recovered: true };
  }

  const failedSet = new Set(failedNames);
  restorePluginFiles(snapshots.filter((snapshot) => failedSet.has(snapshot.name)));
  for (const name of failedNames) {
    if (previousDb[name]) db.data[name] = { ...previousDb[name] };
    else delete db.data[name];
  }
  await db.write();
  const recovered = await loadPlugins();
  if (!recovered) {
    console.error("[TPM] 恢复旧插件文件后仍无法重新加载");
  }
  return { ok: false, failedNames, recovered };
}

/**
 * 在调用 loadPlugins() 之后写最终状态消息。
 * 委托 @utils/postReloadMessage.reloadAndFinalize：
 * snapshot peerId+msgId → reload → 用新 client 编辑最终文案。
 */

async function updateProgressMessage(
  msg: Api.Message,
  text: string,
  options?: { parseMode?: string; linkPreview?: boolean }
): Promise<boolean> {
  const messageOptions = {
    text,
    parseMode: options?.parseMode || undefined,
    linkPreview: options?.linkPreview !== false,
  };

  try {
    await msg.edit(messageOptions);
    return true;
  } catch (error) {
    console.log(`[TPM] 编辑进度消息失败，静默继续: ${error}`);
    return false;
  }
}

function splitLongText(text: string, maxLength: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const messages: string[] = [];
  const lines = text.split('\n');
  let currentMessage = '';

  for (const line of lines) {
    if (line.length > maxLength) {
      if (currentMessage) {
        messages.push(currentMessage);
        currentMessage = '';
      }
      for (let i = 0; i < line.length; i += maxLength) {
        messages.push(line.substring(i, i + maxLength));
      }
      continue;
    }

    if (currentMessage.length + line.length + 1 > maxLength) {
      messages.push(currentMessage);
      currentMessage = line;
    } else {
      currentMessage += (currentMessage ? '\n' : '') + line;
    }
  }

  if (currentMessage) {
    messages.push(currentMessage);
  }

  return messages;
}

async function sendLongMessage(
  msg: Api.Message,
  text: string,
  options?: { parseMode?: string; linkPreview?: boolean },
  isEdit: boolean = true,
  footer?: string
): Promise<void> {
  const messages = splitLongText(text);
  
  if (messages.length === 0) {
    return;
  }

  const messageOptions = {
    parseMode: options?.parseMode || undefined,
    linkPreview: options?.linkPreview !== false,
  };

  // Footer must go on the LAST part. Appending to part[0] overflows Telegram's
  // 4096 limit when the body already spans multiple messages, so the repo link
  // (and totals) get truncated / never reach the user-visible last bubble.
  if (footer) {
    const lastIdx = messages.length - 1;
    const candidate = `${messages[lastIdx]}\n${footer}`;
    if (candidate.length <= MAX_MESSAGE_LENGTH) {
      messages[lastIdx] = candidate;
    } else {
      messages.push(footer.replace(/^\n+/, ""));
    }
  }

  const firstMessage = messages[0];

  if (isEdit) {
    try {
      await msg.edit({
        text: firstMessage,
        ...messageOptions,
      });
    } catch (error) {
      await msg.client?.sendMessage(msg.peerId, {
        message: firstMessage,
        ...messageOptions,
        replyTo: msg.replyTo?.replyToTopId || msg.replyTo?.replyToMsgId,
      });
    }
  } else {
    await msg.client?.sendMessage(msg.peerId, {
      message: firstMessage,
      ...messageOptions,
      replyTo: msg.replyTo?.replyToTopId || msg.replyTo?.replyToMsgId,
    });
  }

  for (let i = 1; i < messages.length; i++) {
    await msg.reply({
      message: messages[i],
      ...messageOptions,
    });
  }
}


/** Local plugin .ts basenames under plugins/ (exclude backups / types). */
function listLocalPluginNames(): string[] {
  try {
    if (!fs.existsSync(PLUGIN_PATH)) return [];
    return fs
      .readdirSync(PLUGIN_PATH, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          !entry.isSymbolicLink() &&
          entry.name.endsWith(".ts") &&
          !entry.name.includes("backup") &&
          !entry.name.endsWith(".d.ts") &&
          !entry.name.startsWith("_") &&
          PLUGIN_NAME_PATTERN.test(entry.name.replace(/\.ts$/, "")),
      )
      .map((entry) => entry.name.replace(/\.ts$/, ""));
  } catch (err: unknown) {
    console.error("[TPM] 读取本地插件目录失败:", err);
    return [];
  }
}

/**
 * Always rebuild the installed-plugin DB from disk + remote catalog.
 * Scans plugins/*.ts, fetches remote plugins.json, and writes a fresh
 * record set so tpm ls / update always reflect reality.
 */
async function rebuildPluginDb(db: Awaited<ReturnType<typeof getDatabase>>): Promise<number> {
  const localNames = listLocalPluginNames();
  const catalog = await getMergedRemotePluginsIndex();

  let written = 0;
  const now = Date.now();
  const oldData = { ...db.data };
  db.data = {};

  for (const name of localNames) {
    const entry = catalog[name];
    if (entry?.url) {
      db.data[name] = buildReconciledPluginRecord(entry, oldData[name]);
    } else if (oldData[name]) {
      // local plugin has no remote match — keep old record
      db.data[name] = { ...oldData[name] };
      console.log(`[TPM] 本地插件 ${name} 无远程记录，保留旧记录`);
    } else {
      console.log(`[TPM] 本地插件 ${name} 无远程记录且无旧记录，跳过`);
    }
    written++;
  }

  await db.write();
  console.log(`[TPM] 插件数据库已重建: ${Object.keys(db.data).length} 条记录 (${localNames.length} 个本地文件)`);
  return Object.keys(db.data).length;
}

async function getDatabase() {
  const filePath = path.join(createDirectoryInAssets("tpm"), "plugins.json");
  const db = await JSONFilePreset<Database>(filePath, {});
  return db;
}

async function getMediaFileName(msg: any): Promise<string> {
  const metadata = msg.media as any;
  const attributes = metadata?.document?.attributes;
  if (!attributes || attributes.length === 0) {
    throw new Error("Message media has no document attributes");
  }
  return attributes[0].fileName;
}

function normalizeGithubUrl(input: string): string {
  try {
    const parsed = new URL(input);
    if (parsed.hostname === "github.com") {
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length >= 5 && parts[2] === "blob") {
        const [owner, repo, , branch, ...rest] = parts;
        return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${rest.join("/")}`;
      }
      return input;
    }
    if (parsed.hostname === "raw.githubusercontent.com") {
      parsed.search = "";
      return parsed.toString();
    }
    return input;
  } catch {
    return input;
  }
}

function getRetryDelayMs(error: unknown, attempt: number): number {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 429) {
      const retryAfter = error.response?.headers?.["retry-after"];
      if (typeof retryAfter === "string") {
        const seconds = Number.parseInt(retryAfter, 10);
        if (!Number.isNaN(seconds)) {
          return Math.max(0, seconds * 1000);
        }
        const date = Date.parse(retryAfter);
        if (!Number.isNaN(date)) {
          return Math.max(0, date - Date.now());
        }
      }
    }
  }
  const base = 600 * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

async function lifecycleDelay(ms: number, label: string): Promise<void> {
  const lifecycle = tryGetCurrentGenerationContext();
  if (lifecycle) {
    await lifecycle.delay(ms, { label });
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry<T>(
  url: string,
  options?: Parameters<typeof axios.get>[1]
) {
  let lastError: unknown;
  const normalizedUrl = normalizeGithubUrl(url);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await axios.get<T>(normalizedUrl, {
        timeout: REQUEST_TIMEOUT_MS,
        ...options,
        headers: {
          ...DEFAULT_HEADERS,
          ...(options?.headers || {}),
        },
      });
    } catch (error) {
      lastError = error;
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (!status || !RETRYABLE_STATUS.has(status) || attempt === MAX_RETRIES) {
        throw error;
      }
      const delay = getRetryDelayMs(error, attempt);
      await lifecycleDelay(delay, "tpm:fetch-retry");
    }
  }
  throw lastError;
}

async function installRemotePlugin(plugin: string, msg: Api.Message) {
  const statusMsg = await sendOrEditMessage(msg, `正在安装插件 ${plugin}...`);
  try {
    assertValidPluginName(plugin);
    const mergedCatalog = await getMergedRemotePluginsIndex();
    if (!mergedCatalog[plugin]) {
      await sendOrEditMessage(statusMsg, `未找到插件 ${plugin} 的远程资源`);
      return;
    }
    const pluginUrl = normalizeGithubUrl(mergedCatalog[plugin].url);
    const response = await fetchWithRetry<string>(pluginUrl, {
      responseType: "text",
    });
    if (response.status !== 200) {
      await sendOrEditMessage(statusMsg, `无法下载插件 ${plugin}`);
      return;
    }
    const db = await getDatabase();
    const previousDb = { ...db.data };
    const snapshot = writePluginAtomically(plugin, response.data);
    db.data[plugin] = {
      ...mergedCatalog[plugin],
      url: pluginUrl,
      _updatedAt: Date.now(),
      _contentHash: hashPluginContent(response.data),
      _baseline: "trusted",
    };
    await persistPluginMutations([snapshot], db, previousDb);

    await reloadAndFinalize(statusMsg, `插件 ${plugin} 已安装并加载成功`, {
      reload: async () => (await reloadWithRollback([snapshot], db, previousDb)).ok,
      failureText: `❌ 插件 ${plugin} 加载失败，已恢复安装前文件`,
    });
  } catch (error) {
    await sendOrEditMessage(
      statusMsg,
      `❌ 安装插件 ${htmlEscape(plugin)} 失败: ${htmlEscape(
        error instanceof Error ? error.message : String(error),
      )}`,
      { parseMode: "html" },
    );
  }
}

async function installAllPlugins(msg: Api.Message) {
  const statusMsg = await sendOrEditMessage(msg, "🔍 正在获取远程插件列表...");
  try {
    const mergedCatalog = await getMergedRemotePluginsIndex();
    const plugins = Object.keys(mergedCatalog);
    if (plugins.length === 0) {
      await sendOrEditMessage(statusMsg, "❌ 无法获取远程插件库（官方和自定义源均失败）");
      return;
    }

    const totalPlugins = plugins.length;
    if (totalPlugins === 0) {
      await sendOrEditMessage(statusMsg, "📦 远程插件库为空");
      return;
    }

    let installedCount = 0;
    let failedCount = 0;
    const failedPlugins: string[] = [];
    const db = await getDatabase();
    const previousDb = { ...db.data };
    const snapshots: PluginFileSnapshot[] = [];

    await sendOrEditMessage(statusMsg, `📦 开始安装 ${totalPlugins} 个插件...\n\n🔄 进度: 0/${totalPlugins} (0%)`, { parseMode: "html" });

    for (let i = 0; i < plugins.length; i++) {
      const plugin = plugins[i];
      const progress = Math.round(((i + 1) / totalPlugins) * 100);
      const progressBar = htmlEscape(generateProgressBar(progress));
      try {
        if ([0, plugins.length - 1].includes(i) || i % 2 === 0) {
          await sendOrEditMessage(statusMsg, `📦 正在安装插件: ${codeTag(plugin)}\n\n${progressBar}\n🔄 进度: ${
              i + 1
            }/${totalPlugins} (${progress}%)\n✅ 成功: ${installedCount}\n❌ 失败: ${failedCount}`, { parseMode: "html" });
        }

        const pluginData = mergedCatalog[plugin];
        if (!pluginData || !pluginData.url) {
          failedCount++;
          failedPlugins.push(`${plugin} (无URL)`);
          continue;
        }

        const pluginUrl = normalizeGithubUrl(pluginData.url);
        const response = await fetchWithRetry<string>(pluginUrl, {
          responseType: "text",
        });
        if (response.status !== 200) {
          failedCount++;
          failedPlugins.push(`${plugin} (下载失败)`);
          continue;
        }

        const snapshot = writePluginAtomically(plugin, response.data);
        snapshots.push(snapshot);
        db.data[plugin] = {
          url: pluginUrl,
          desc: pluginData.desc,
          _updatedAt: Date.now(),
          _contentHash: hashPluginContent(response.data),
          _baseline: "trusted",
        };

        installedCount++;
        await lifecycleDelay(100, "tpm:batch-install-throttle");
      } catch (error) {
        failedCount++;
        failedPlugins.push(`${plugin} (${String(error)})`);
        console.error(`[TPM] 安装插件 ${plugin} 失败:`, error);
      }
    }

    await persistPluginMutations(snapshots, db, previousDb);
    const reloadResult = await reloadWithRollback(snapshots, db, previousDb);
    for (const name of reloadResult.failedNames) {
      installedCount = Math.max(0, installedCount - 1);
      failedCount++;
      failedPlugins.push(`${name} (加载失败，已回滚)`);
    }
    const successBar = generateProgressBar(100);
    let resultMsg = `🎉 <b>批量安装完成!</b>\n\n${successBar}\n\n📊 <b>安装统计:</b>\n✅ 成功安装: ${installedCount}/${totalPlugins}\n❌ 安装失败: ${failedCount}/${totalPlugins}`;
    if (failedPlugins.length > 0) {
      const failedList = failedPlugins.slice(0, 5).map(htmlEscape).join("\n• ");
      const moreFailures =
        failedPlugins.length > 5
          ? `\n• ... 还有 ${failedPlugins.length - 5} 个失败`
          : "";
      resultMsg += `\n\n❌ <b>失败列表:</b>\n• ${failedList}${moreFailures}`;
    }
    resultMsg += `\n\n🔄 插件已重新加载，可以开始使用!`;

    await reloadAndFinalize(statusMsg, resultMsg, {
      parseMode: "html",
      reload: async () => reloadResult.recovered,
      failureText: "❌ 批量安装后的插件加载失败，已恢复安装前文件",
    });
  } catch (error) {
    await sendOrEditMessage(statusMsg, `❌ 批量安装失败: ${error}`);
    console.error("[TPM] 批量安装插件失败:", error);
  }
}

async function installMultiplePlugins(pluginNames: string[], msg: Api.Message) {
  const totalPlugins = pluginNames.length;
  if (totalPlugins === 0) {
    await sendOrEditMessage(msg, "❌ 未提供要安装的插件名称");
    return;
  }

  const statusMsg = await sendOrEditMessage(msg, `🔍 正在获取远程插件列表...`, { parseMode: "html" });

  try {
    const mergedCatalog = await getMergedRemotePluginsIndex();
    if (Object.keys(mergedCatalog).length === 0) {
      await sendOrEditMessage(statusMsg, "❌ 无法获取远程插件库");
      return;
    }

    let installedCount = 0;
    let failedCount = 0;
    const failedPlugins: string[] = [];
    const notFoundPlugins: string[] = [];
    const db = await getDatabase();
    const previousDb = { ...db.data };
    const snapshots: PluginFileSnapshot[] = [];

    await sendOrEditMessage(statusMsg, `📦 开始安装 ${totalPlugins} 个插件...\n\n🔄 进度: 0/${totalPlugins} (0%)`, { parseMode: "html" });

    for (let i = 0; i < pluginNames.length; i++) {
      const pluginName = pluginNames[i];
      const progress = Math.round(((i + 1) / totalPlugins) * 100);
      const progressBar = htmlEscape(generateProgressBar(progress));

      try {
        assertValidPluginName(pluginName);
        if ([0, pluginNames.length - 1].includes(i) || i % 2 === 0) {
          await sendOrEditMessage(statusMsg, `📦 正在安装插件: ${codeTag(pluginName)}\n\n${progressBar}\n🔄 进度: ${
              i + 1
            }/${totalPlugins} (${progress}%)\n✅ 成功: ${installedCount}\n❌ 失败: ${failedCount}`, { parseMode: "html" });
        }

        if (!mergedCatalog[pluginName]) {
          failedCount++;
          notFoundPlugins.push(pluginName);
          continue;
        }

        const pluginData = mergedCatalog[pluginName];
        if (!pluginData.url) {
          failedCount++;
          failedPlugins.push(`${pluginName} (无URL)`);
          continue;
        }

        const pluginUrl = normalizeGithubUrl(pluginData.url);
        const response = await fetchWithRetry<string>(pluginUrl, {
          responseType: "text",
        });
        if (response.status !== 200) {
          failedCount++;
          failedPlugins.push(`${pluginName} (下载失败)`);
          continue;
        }

        const snapshot = writePluginAtomically(pluginName, response.data);
        snapshots.push(snapshot);
        db.data[pluginName] = {
          url: pluginUrl,
          desc: pluginData.desc,
          _updatedAt: Date.now(),
          _contentHash: hashPluginContent(response.data),
          _baseline: "trusted",
        };

        installedCount++;
        await lifecycleDelay(100, "tpm:batch-install-throttle");
      } catch (error) {
        failedCount++;
        failedPlugins.push(`${pluginName} (${String(error)})`);
        console.error(`[TPM] 安装插件 ${pluginName} 失败:`, error);
      }
    }

    await persistPluginMutations(snapshots, db, previousDb);
    const reloadResult = await reloadWithRollback(snapshots, db, previousDb);
    for (const name of reloadResult.failedNames) {
      installedCount = Math.max(0, installedCount - 1);
      failedCount++;
      failedPlugins.push(`${name} (加载失败，已回滚)`);
    }
    const successBar = generateProgressBar(100);
    let resultMsg = `🎉 <b>批量安装完成!</b>\n\n${successBar}\n\n📊 <b>安装统计:</b>\n✅ 成功安装: ${installedCount}/${totalPlugins}\n❌ 安装失败: ${failedCount}/${totalPlugins}`;

    if (notFoundPlugins.length > 0) {
      const notFoundList = notFoundPlugins.slice(0, 5).map(htmlEscape).join("\n• ");
      const moreNotFound =
        notFoundPlugins.length > 5
          ? `\n• ... 还有 ${notFoundPlugins.length - 5} 个未找到`
          : "";
      resultMsg += `\n\n🔍 <b>未找到的插件:</b>\n• ${notFoundList}${moreNotFound}`;
    }

    if (failedPlugins.length > 0) {
      const failedList = failedPlugins.slice(0, 5).map(htmlEscape).join("\n• ");
      const moreFailures =
        failedPlugins.length > 5
          ? `\n• ... 还有 ${failedPlugins.length - 5} 个失败`
          : "";
      resultMsg += `\n\n❌ <b>其他失败:</b>\n• ${failedList}${moreFailures}`;
    }

    resultMsg += `\n\n🔄 插件已重新加载，可以开始使用!`;

    await reloadAndFinalize(statusMsg, resultMsg, {
      parseMode: "html",
      reload: async () => reloadResult.recovered,
      failureText: "❌ 批量安装后的插件加载失败，已恢复安装前文件",
    });
  } catch (error) {
    await sendOrEditMessage(statusMsg, `❌ 批量安装失败: ${error}`);
    console.error("[TPM] 批量安装插件失败:", error);
  }
}

function generateProgressBar(percentage: number, length: number = 20): string {
  const filled = Math.round((percentage / 100) * length);
  const empty = length - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return `🔄 当前进度: [${bar}] ${percentage}%`;
}

async function installPlugin(args: string[], msg: Api.Message) {
  if (args.length === 1) {
    if (msg.isReply) {
      const replied = await safeGetReplyMessage(msg);
      if (replied?.media) {
        const fileName = await getMediaFileName(replied);
        if (typeof fileName !== "string" || !fileName.endsWith(".ts")) {
          await sendOrEditMessage(msg, `❌ 文件格式错误\n文件不是有效插件`);
          return;
        }
        const pluginName = fileName.slice(0, -3);
        let tempPath: string | null = null;
        try {
          assertValidPluginName(pluginName);
          const filePath = resolvePluginFilePath(pluginName);
          const statusMsg = await sendOrEditMessage(
            msg,
            `🔍 正在验证插件 ${pluginName} ...`,
          );
          tempPath = path.join(
            createDirectoryInTemp("plugin_uploads"),
            `_${pluginName}.${process.pid}.${randomBytes(8).toString("hex")}.tmp.ts`,
          );
          await msg.client?.downloadMedia(replied, { outputFile: tempPath });
          if (!fs.existsSync(tempPath) || fs.lstatSync(tempPath).isSymbolicLink()) {
            throw new Error("插件下载未生成普通文件");
          }

          const pluginModule = require(tempPath);
          const pluginInstance = pluginModule.default || pluginModule;
          if (!isValidPlugin(pluginInstance)) {
            throw new Error("文件不是有效插件");
          }
          delete require.cache[require.resolve(tempPath)];

          const snapshot = writePluginAtomically(
            pluginName,
            fs.readFileSync(tempPath, "utf8"),
          );
          fs.unlinkSync(tempPath);
          tempPath = null;

          const db = await getDatabase();
          const previousDb = { ...db.data };
          const overrideMessage = db.data[pluginName]
            ? `\n⚠️ 已覆盖之前已安装的远程插件\n若需保持更新, 请 ${codeTag(`${mainPrefix}tpm i ${pluginName}`)}`
            : "";
          delete db.data[pluginName];
          await persistPluginMutations([snapshot], db, previousDb);

          await reloadAndFinalize(
            statusMsg,
            `✅ 插件 ${htmlEscape(pluginName)} 已安装并加载成功${overrideMessage}`,
            {
              parseMode: "html",
              reload: async () =>
                (await reloadWithRollback([snapshot], db, previousDb)).ok,
              failureText: `❌ 插件 ${htmlEscape(pluginName)} 加载失败，已恢复安装前文件`,
            },
          );
        } catch (error) {
          if (tempPath && fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }
          await sendOrEditMessage(
            msg,
            `❌ 插件安装失败\n错误信息:\n${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      } else {
        await sendOrEditMessage(msg, "请回复一个插件文件");
      }
    } else {
      await sendOrEditMessage(msg, "请回复某个插件文件或提供 tpm 包名");
    }
  } else {
    const pluginNames = args.slice(1);

    if (pluginNames.length === 1 && pluginNames[0] === "all") {
      await installAllPlugins(msg);
    } else if (pluginNames.length === 1) {
      await installRemotePlugin(pluginNames[0], msg);
    } else {
      await installMultiplePlugins(pluginNames, msg);
    }
  }
}

async function uninstallPlugin(plugin: string, msg: Api.Message) {
  if (!plugin) {
    await sendOrEditMessage(msg, "请提供要卸载的插件名称");
    return;
  }
  const statusMsg = await sendOrEditMessage(msg, `正在卸载插件 ${plugin}...`);
  try {
    assertValidPluginName(plugin);
    const pluginPath = resolvePluginFilePath(plugin);
    if (!fs.existsSync(pluginPath)) {
      await sendOrEditMessage(statusMsg, `未找到插件 ${plugin}`);
      return;
    }
    const db = await getDatabase();
    const previousDb = { ...db.data };
    const snapshot = deletePluginFile(plugin);
    delete db.data[plugin];
    await persistPluginMutations([snapshot], db, previousDb);
    await reloadAndFinalize(statusMsg, `插件 ${plugin} 已卸载`, {
      reload: async () => (await reloadWithRollback([snapshot], db, previousDb)).ok,
      failureText: `❌ 插件 ${plugin} 卸载后加载失败，已恢复原文件`,
    });
  } catch (error) {
    await sendOrEditMessage(
      statusMsg,
      `❌ 卸载失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function uninstallMultiplePlugins(
  pluginNames: string[],
  msg: Api.Message
) {
  if (!pluginNames || pluginNames.length === 0) {
    await sendOrEditMessage(msg, "请提供要卸载的插件名称");
    return;
  }

  const results: { name: string; success: boolean; reason?: string }[] = [];
  let processedCount = 0;
  const totalCount = pluginNames.length;

  const statusMsg = await sendOrEditMessage(msg, `开始卸载 ${totalCount} 个插件...\n${generateProgressBar(
      0
    )} 0/${totalCount}`);
  let dbForRollback: Awaited<ReturnType<typeof getDatabase>> | null = null;
  let previousDb: Database = {};
  const snapshots: PluginFileSnapshot[] = [];
  let reloadRecovered = true;

  try {
    const db = await getDatabase();
    dbForRollback = db;
    previousDb = { ...db.data };

    for (const pluginName of pluginNames) {
      const trimmedName = pluginName.trim();
      if (!trimmedName) {
        results.push({
          name: pluginName,
          success: false,
          reason: "插件名称为空",
        });
        processedCount++;
        continue;
      }
      try {
        assertValidPluginName(trimmedName);
        const pluginPath = resolvePluginFilePath(trimmedName);
        if (fs.existsSync(pluginPath)) {
          snapshots.push(deletePluginFile(trimmedName));
          if (db.data[trimmedName]) {
            delete db.data[trimmedName];
            console.log(`[TPM] 已从数据库中删除插件记录: ${trimmedName}`);
          }
          results.push({ name: trimmedName, success: true });
        } else {
          results.push({
            name: trimmedName,
            success: false,
            reason: "插件不存在",
          });
        }
      } catch (error) {
        console.error(`[TPM] 卸载插件 ${trimmedName} 失败:`, error);
        results.push({
          name: trimmedName,
          success: false,
          reason: `删除失败: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }

      processedCount++;
      const percentage = Math.round((processedCount / totalCount) * 100);

      await sendOrEditMessage(statusMsg, `卸载插件中...\n${generateProgressBar(
          percentage
        )} ${processedCount}/${totalCount}\n当前: ${trimmedName}`);
    }

    await persistPluginMutations(snapshots, db, previousDb);
  } catch (error) {
    console.error(`[TPM] 批量卸载过程中发生错误:`, error);
    await sendOrEditMessage(msg, `批量卸载过程中发生错误: ${
        error instanceof Error ? error.message : String(error)
      }`);
    return;
  }

  if (dbForRollback && snapshots.length > 0) {
    const reloadResult = await reloadWithRollback(
      snapshots,
      dbForRollback,
      previousDb,
    );
    reloadRecovered = reloadResult.recovered;
    for (const name of reloadResult.failedNames) {
      const result = results.find((item) => item.name === name && item.success);
      if (result) {
        result.success = false;
        result.reason = "插件加载失败，已恢复卸载前文件";
      }
    }
  }

  const successCount = results.filter((r) => r.success).length;
  const failedCount = results.filter((r) => !r.success).length;

  let resultText = `\n📊 卸载完成\n\n`;
  resultText += `✅ 成功: ${successCount}\n`;
  resultText += `❌ 失败: ${failedCount}\n\n`;

  if (successCount > 0) {
    const successPlugins = results.filter((r) => r.success).map((r) => r.name);
    resultText += `✅ 已卸载:\n${successPlugins
      .map((name) => `  • ${name}`)
      .join("\n")}\n\n`;
  }

  if (failedCount > 0) {
    const failedPlugins = results.filter((r) => !r.success);
    resultText += `❌ 卸载失败:\n${failedPlugins
      .map((r) => `  • ${r.name}: ${r.reason}`)
      .join("\n")}`;
  }

  if (successCount > 0 && dbForRollback) {
    await reloadAndFinalize(statusMsg, resultText, {
      reload: async () => reloadRecovered,
      failureText: "❌ 批量卸载后插件加载失败，已恢复卸载前文件",
    });
  } else {
    await sendOrEditMessage(statusMsg, resultText);
  }
}

async function uninstallAllPlugins(msg: Api.Message) {
  try {
    const statusMsg = await sendOrEditMessage(msg, "⚠️ 正在清空插件目录并刷新缓存...");

    let removed = 0;
    let failed: string[] = [];
    const db = await getDatabase();
    const previousDb = { ...db.data };
    const snapshots: PluginFileSnapshot[] = [];

    for (const name of listLocalPluginNames()) {
      try {
        snapshots.push(deletePluginFile(name));
        removed++;
      } catch {
        failed.push(`${name}.ts`);
      }
    }
    for (const k of Object.keys(db.data)) delete db.data[k];
    await persistPluginMutations(snapshots, db, previousDb);
    const reloadResult = await reloadWithRollback(snapshots, db, previousDb);
    for (const name of reloadResult.failedNames) {
      removed = Math.max(0, removed - 1);
      failed.push(`${name}.ts`);
    }

    let text = `✅ 已清空插件目录并刷新缓存\n\n🗑 删除文件: ${removed}`;
    if (failed.length) {
      const show = failed.slice(0, 10).map(htmlEscape).join("\n• ");
      text += `\n❌ 删除失败: ${failed.length}\n• ${show}${
        failed.length > 10 ? `\n• ... 还有 ${failed.length - 10} 个失败` : ""
      }`;
    }
    await reloadAndFinalize(statusMsg, text, {
      parseMode: "html",
      reload: async () => reloadResult.recovered,
      failureText: "❌ 清空插件后加载失败，已恢复原插件文件",
    });
  } catch (error) {
    console.error("[TPM] 清空插件目录失败:", error);
    await sendOrEditMessage(msg, `❌ 清空插件目录失败: ${error}`);
  }
}

async function uploadPlugin(args: string[], msg: Api.Message) {
  const pluginName = args[1];
  if (!pluginName) {
    await sendOrEditMessage(msg, "请提供插件名称");
    return;
  }
  let pluginPath: string;
  try {
    pluginPath = resolvePluginFilePath(pluginName, { mustExist: true });
  } catch (error) {
    await sendOrEditMessage(
      msg,
      `❌ 无法上传插件: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  
  const statusMsg = await sendOrEditMessage(msg, `正在上传插件 ${pluginName}...`);
  
  const sendOptions: any = {
    file: pluginPath,
    thumb: path.join(process.cwd(), "telebox.png"),
    caption: `**TeleBox_Plugin ${pluginName} plugin.**`,
  };

  if (msg.replyTo?.replyToTopId || msg.replyTo?.replyToMsgId) {
    sendOptions.replyTo = msg.replyTo?.replyToTopId || msg.replyTo?.replyToMsgId;
  }

  await msg.client?.sendFile(msg.peerId, sendOptions);
  
  if (statusMsg.id !== msg.id) {
    await statusMsg.delete({ revoke: false });
  } else {
    await msg.delete({ revoke: false });
  }
}

async function search(msg: Api.Message) {
  const text = msg.message;
  const parts = text.trim().split(/\s+/);
  const keyword = parts.length > 2 ? parts[2].toLowerCase() : "";
  
  try {
    const statusMsg = await sendOrEditMessage(msg, keyword ? `🔍 正在搜索插件: ${keyword}` : "🔍 正在获取插件列表...");
    const remotePlugins = await getMergedRemotePluginsIndex();
    if (Object.keys(remotePlugins).length === 0) {
      await sendOrEditMessage(statusMsg, "❌ 无法获取远程插件库");
      return;
    }
    const pluginNames = Object.keys(remotePlugins);

    const localPlugins = new Set<string>();
    try {
      for (const name of listLocalPluginNames()) localPlugins.add(name);
    } catch (error) {
      console.error("[TPM] 读取本地插件失败:", error);
    }

    const db = await getDatabase();
    const dbPlugins = db.data;

    const filteredPlugins = keyword 
      ? pluginNames.filter(name => {
          const pluginData = remotePlugins[name];
          const nameMatch = name.toLowerCase().includes(keyword);
          const descMatch = pluginData?.desc?.toLowerCase().includes(keyword) || false;
          return nameMatch || descMatch;
        })
      : pluginNames;
    
    const totalPlugins = filteredPlugins.length;
    
    if (totalPlugins === 0 && keyword) {
      await sendOrEditMessage(statusMsg, `🔍 未找到包含 "<b>${htmlEscape(keyword)}</b>" 的插件`, { parseMode: "html" });
      return;
    }

    let installedCount = 0;
    let localOnlyCount = 0;
    let notInstalledCount = 0;

    const entityMgr = new EntityManager();
    
    // 预留重要标签的位置
    entityMgr.add('b'); // 标题
    entityMgr.add('b'); // 统计标题
    entityMgr.add('b'); // 搜索关键词
    entityMgr.add('b'); // 搜索结果标题
    entityMgr.add('blockquote'); // 插件列表
    entityMgr.add('b'); // 快捷操作标题
    entityMgr.add('code'); // 第一个命令
    entityMgr.add('code'); // 第二个命令
    entityMgr.add('code'); // 第三个命令
    entityMgr.add('code'); // 第四个命令
    entityMgr.add('code'); // 第五个命令
    entityMgr.add('code'); // 第六个命令
    entityMgr.add('b'); // 仓库标题

    const highlightMatch = (text: string) => {
      const escapedText = htmlEscape(text);
      if (!keyword) return escapedText;
      const escapedKeyword = htmlEscape(keyword);
      const regex = new RegExp(`(${escapedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      return escapedText.replace(regex, '<b>$1</b>');
    };

    function getPluginStatus(pluginName: string) {
      const hasLocal = localPlugins.has(pluginName);
      const dbRecord = dbPlugins[pluginName];

      if (hasLocal && dbRecord && dbRecord._baseline !== "unknown") {
        installedCount++;
        return { status: "✅", label: "已安装" } as const;
      } else if (hasLocal) {
        localOnlyCount++;
        return { status: "🔶", label: "本地/未纳管" } as const;
      } else {
        notInstalledCount++;
        return { status: "❌", label: "未安装" } as const;
      }
    }

    const pluginLines: string[] = [];
    for (const plugin of filteredPlugins) {
      const pluginData = remotePlugins[plugin];
      const { status } = getPluginStatus(plugin);
      const description = pluginData?.desc || "暂无描述";
      
      const highlightedName = highlightMatch(plugin);
      const highlightedDesc = highlightMatch(description);
      
      const allowCodeTag = entityMgr.canAdd('code');
      const nameTag = allowCodeTag && !keyword ? codeTag(plugin) : highlightedName;
      
      pluginLines.push(`${status} ${nameTag} - ${highlightedDesc}`);
      
      if (allowCodeTag) {
        entityMgr.add('code');
      }
      
      if (keyword) {
        entityMgr.add('b');
      }
    }

    let statsInfo = `📊 <b>插件统计:</b>\n`;
    if (keyword) {
      statsInfo += `• 搜索关键词: "<b>${htmlEscape(keyword)}</b>"\n`;
    }
    statsInfo += `• 总计: ${totalPlugins} 个插件\n`;
    statsInfo += `• ✅ 已安装: ${installedCount} 个\n`;
    statsInfo += `• 🔶 本地同名: ${localOnlyCount} 个\n`;
    statsInfo += `• ❌ 未安装: ${notInstalledCount} 个`;

    const installTip = `\n💡 <b>快捷操作:</b>\n` +
      `• <code>${mainPrefix}tpm i [名称1] [名称2 ...]</code> 安装/批量安装\n` +
      `• <code>${mainPrefix}tpm i all</code> 全部安装\n` +
      `• <code>${mainPrefix}tpm update</code> 更新已装\n` +
      `• <code>${mainPrefix}tpm ls</code> 查看记录\n` +
      `• <code>${mainPrefix}tpm rm [名称]</code> 卸载\n` +
      `• <code>${mainPrefix}tpm rm all</code> 清空`;

    const repoLink = `\n🔗 <b>插件仓库:</b> <a href="${PLUGINS_REPOSITORY_URL}">TeleBox-Plugins</a>`;

    const title = keyword ? `🔍 搜索 "${htmlEscape(keyword)}" 结果` : `🔍 远程插件列表`;
    const fullMessage = [
      `${title}`,
      `━━━━━━━━━━━━━━━━━`,
      "",
      statsInfo,
      "",
      keyword ? `📦 <b>搜索结果:</b>` : `📦 <b>插件详情:</b>`,
      `<blockquote expandable>${pluginLines.join("\n")}</blockquote>`,
    ].join("\n");

    const footer = installTip + repoLink;

    await sendLongMessage(statusMsg, fullMessage, { parseMode: "html", linkPreview: false }, true, footer);
  } catch (error) {
    console.error("[TPM] 搜索插件失败:", error);
    await sendOrEditMessage(msg, `❌ 搜索插件失败: ${error}`);
  }
}

async function showPluginRecords(msg: Api.Message, verbose?: boolean) {
  try {
    const statusMsg = await sendOrEditMessage(msg, "📚 正在读取插件数据...");
    const db = await getDatabase();
    await rebuildPluginDb(db);
    const dbNames = Object.keys(db.data);

    const filePlugins = listLocalPluginNames();

    const notInDb = filePlugins.filter((n) => !dbNames.includes(n));

    const sortedPlugins = dbNames
      .map((name) => ({ name, ...db.data[name] }))
      .sort((a, b) => a._updatedAt - b._updatedAt);

    const entityMgr = new EntityManager();
    
    entityMgr.add('b');
    entityMgr.add('b');
    entityMgr.add('b');
    entityMgr.add('b');
    entityMgr.add('b');
    entityMgr.add('blockquote');
    entityMgr.add('blockquote');

    const dbLinesSimple: string[] = [];
    const dbLinesVerbose: string[] = [];
    
    for (const p of sortedPlugins) {
      const allowCodeTag = entityMgr.canAdd('code');
      
      if (verbose) {
        const updateTime = new Date(p._updatedAt).toLocaleString("zh-CN");
        const desc = p.desc ? `\n📝 ${htmlEscape(p.desc)}` : "";
        const nameTag = allowCodeTag ? codeTag(p.name) : htmlEscape(p.name);
        const urlTag = allowCodeTag ? codeTag(p.url) : htmlEscape(p.url);
        dbLinesVerbose.push(`${nameTag} 🕒 ${updateTime}${desc}\n🔗 ${urlTag}`);
        
        if (allowCodeTag) {
          entityMgr.add('code');
          entityMgr.add('code');
        }
      } else {
        const nameTag = allowCodeTag ? codeTag(p.name) : htmlEscape(p.name);
        dbLinesSimple.push(`${nameTag}${p.desc ? ` - ${htmlEscape(p.desc)}` : ""}`);
        
        if (allowCodeTag) {
          entityMgr.add('code');
        }
      }
    }

    const localLinesSimple: string[] = [];
    const localLinesVerbose: string[] = [];
    
    for (const name of notInDb) {
      const allowCodeTag = entityMgr.canAdd('code');
      const nameTag = allowCodeTag ? codeTag(name) : htmlEscape(name);
      
      if (verbose) {
        const filePath = resolvePluginFilePath(name);
        let mtime = "未知";
        try {
          const stat = fs.statSync(filePath);
          mtime = stat.mtime.toLocaleString("zh-CN");
        } catch (statErr) {
          console.debug(`[tpm] stat 失败于 ${name}: ${String(statErr)}`);
        }
        localLinesVerbose.push(`${nameTag} 🗄 ${mtime}`);
      } else {
        localLinesSimple.push(nameTag);
      }
      
      if (allowCodeTag) {
        entityMgr.add('code');
      }
    }

    const tip = verbose
      ? ""
      : `💡 可使用 <code>${mainPrefix}tpm ls -v</code> 查看详情信息`;

    const dbLines = verbose ? dbLinesVerbose : dbLinesSimple;
    const localLines = verbose ? localLinesVerbose : localLinesSimple;

    const messageParts: string[] = [];
    
    messageParts.push(`📚 <b>插件记录</b>`);
    messageParts.push(`━━━━━━━━━━━━━━━━━`);
    
    if (tip) {
      messageParts.push("", tip);
      entityMgr.add('code');
    }
    
    if (dbNames.length > 0) {
      messageParts.push("", `📦 <b>远程插件记录 (${dbNames.length}个):</b>`);
      messageParts.push(`<blockquote expandable>${dbLines.join("\n")}</blockquote>`);
    } else {
      messageParts.push("", `📦 <b>远程插件记录:</b> (空)`);
    }
    
    if (notInDb.length > 0) {
      messageParts.push("", `🗂 <b>本地插件 (${notInDb.length}个):</b>`);
      messageParts.push(`<blockquote expandable>${localLines.join("\n")}</blockquote>`);
    }
    
    const footer = [
      "",
      `━━━━━━━━━━━━━━━━━`,
      `📊 总计: ${dbNames.length + notInDb.length} 个插件`,
      "", `🔗 <b>插件仓库:</b> <a href="${PLUGINS_REPOSITORY_URL}">TeleBox-Plugins</a>`,
    ].join("\n");
    const fullMessage = messageParts.join("\n");
    
    await sendLongMessage(statusMsg, fullMessage, { parseMode: "html", linkPreview: false }, true, footer);
  } catch (error) {
    console.error("[TPM] 读取插件数据库失败:", error);
    await sendOrEditMessage(msg, `❌ 读取数据库失败: ${error}`);
  }
}

export async function updateAllPlugins(
  msg: Api.Message,
  opts?: { silent?: boolean; force?: boolean },
): Promise<{ failedCount: number; statusPeerId?: any; statusMsgId?: number }> {
  return withPluginOperationLock(() => updateAllPluginsUnlocked(msg, opts));
}

async function updateAllPluginsUnlocked(
  msg: Api.Message,
  opts?: { silent?: boolean; force?: boolean },
): Promise<{ failedCount: number; statusPeerId?: any; statusMsgId?: number }> {
  const silent = !!opts?.silent;
  const force = !!opts?.force;
  // silent: skip all progress UI (auto-update path); still need msg for reload peer if any
  let statusMsg: Api.Message = msg;
  let canEdit = !silent;
  if (!silent) {
    statusMsg = await sendOrEditMessage(msg, "🔍 正在检查待更新的插件...");
  }
  
  try {
    const db = await getDatabase();
    const previousDb = { ...db.data };
    const snapshots: PluginFileSnapshot[] = [];
    await rebuildPluginDb(db);
    const dbPlugins = Object.keys(db.data);

    if (dbPlugins.length === 0) {
      if (!silent) {
        await sendOrEditMessage(
          statusMsg,
          "📦 没有可更新的插件记录\n\n" +
            "本地 plugins 目录为空，或远程目录中找不到对应插件。\n" +
            `可用 <code>${mainPrefix}tpm install &lt;插件名&gt;</code> 安装后再更新。`,
        );
      }
      return { failedCount: 0 };
    }

    const totalPlugins = dbPlugins.length;
    let updatedCount = 0;
    let failedCount = 0;
    let skipCount = 0;
    
    const failedPlugins: string[] = [];

    if (canEdit) {
      canEdit = await updateProgressMessage(statusMsg, `📦 开始更新 ${totalPlugins} 个插件...\n\n🔄 进度: 0/${totalPlugins} (0%)`, { parseMode: "html" });
    }

    for (let i = 0; i < dbPlugins.length; i++) {
      const pluginName = dbPlugins[i];
      const pluginRecord = db.data[pluginName];
      const progress = Math.round(((i + 1) / totalPlugins) * 100);
      const progressBar = htmlEscape(generateProgressBar(progress));

      try {
        assertValidPluginName(pluginName);
        if (canEdit && ([0, dbPlugins.length - 1].includes(i) || i % 2 === 0)) {
          canEdit = await updateProgressMessage(statusMsg, `📦 正在更新插件: ${codeTag(pluginName)}\n\n${progressBar}\n🔄 进度: ${
              i + 1
            }/${totalPlugins} (${progress}%)\n✅ 成功: ${updatedCount}\n⏭️ 跳过: ${skipCount}\n❌ 失败: ${failedCount}`, { parseMode: "html" });
        }

        if (!pluginRecord.url) {
          skipCount++;
          console.log(`[TPM] 跳过更新插件 ${pluginName}: 无URL记录`);
          continue;
        }

        const response = await fetchWithRetry<string>(
          normalizeGithubUrl(pluginRecord.url),
          { responseType: "text" }
        );
        if (response.status !== 200) {
          failedCount++;
          failedPlugins.push(`${pluginName} (下载失败)`);
          continue;
        }

        const filePath = resolvePluginFilePath(pluginName);

        if (!fs.existsSync(filePath)) {
          skipCount++;
          console.log(`[TPM] 跳过更新插件 ${pluginName}: 本地文件不存在`);
          continue;
        }

        const currentContent = fs.readFileSync(filePath, "utf8");
        const remoteContent = response.data;
        const localHash = hashPluginContent(currentContent);
        const remoteHash = hashPluginContent(remoteContent);

        if (localHash === remoteHash) {
          if (pluginRecord._contentHash !== localHash) {
            db.data[pluginName]._contentHash = localHash;
            db.data[pluginName]._baseline = "trusted";
          }
          skipCount++;
          console.log(`[TPM] 跳过更新插件 ${pluginName}: 内容无变化`);
          continue;
        }

        if (!force && isLocallyModifiedPlugin(filePath, currentContent, pluginRecord)) {
          skipCount++;
          console.log(`[TPM] 跳过更新插件 ${pluginName}: 检测到本地修改，保留本地版本`);
          continue;
        }

        const snapshot = writePluginAtomically(pluginName, remoteContent);
        snapshots.push(snapshot);

        db.data[pluginName]._updatedAt = Date.now();
        db.data[pluginName]._contentHash = remoteHash;
        db.data[pluginName]._baseline = "trusted";

        updatedCount++;
        await lifecycleDelay(100, "tpm:update-throttle");
      } catch (error) {
        failedCount++;
        failedPlugins.push(`${pluginName} (${String(error)})`);
        console.error(`[TPM] 更新插件 ${pluginName} 失败:`, error);
      }
    }

    await persistPluginMutations(snapshots, db, previousDb);

    let reloadRecovered = true;
    if (updatedCount > 0) {
      const reloadResult = await reloadWithRollback(snapshots, db, previousDb);
      reloadRecovered = reloadResult.recovered;
      for (const name of reloadResult.failedNames) {
        updatedCount = Math.max(0, updatedCount - 1);
        failedCount++;
        failedPlugins.push(`${name} (加载失败，已回滚)`);
      }
    }

    if (updatedCount === 0 && silent) {
      // Nothing changed: skip full reload to avoid crash from
      // unreferenced rejections during disposeRuntime.
      console.log("[TPM] 更新跳过: 无变化，跳过 reload");
      const skipPeerId =
        statusMsg.chatId != null ? String(statusMsg.chatId) : statusMsg.peerId;
      const skipMsgId = statusMsg.id;
      return { failedCount, statusPeerId: skipPeerId, statusMsgId: skipMsgId };
    }

    const finalText = `✅ 更新完成 (成功${updatedCount}个, 跳过${skipCount}个, 失败${failedCount}个)`;
    const statusPeerId =
      statusMsg.chatId != null ? String(statusMsg.chatId) : statusMsg.peerId;
    const statusMsgId = statusMsg.id;
    if (silent) {
      // Reload already completed above so selective failures could be rolled back.
    } else {
      const loaded = await reloadAndFinalize(statusMsg, finalText, {
        parseMode: "html",
        reload: async () => reloadRecovered,
        failureText: "❌ 插件更新后加载失败，已恢复更新前文件",
      });
      if (!loaded) {
        failedCount += updatedCount;
        updatedCount = 0;
      }
    }
    console.log(`[TPM] 更新完成。统计: 成功${updatedCount}个, 跳过${skipCount}个, 失败${failedCount}个`);
    return { failedCount, statusPeerId, statusMsgId };
  } catch (error) {
    console.error("[TPM] 一键更新失败:", error);
    if (!silent) {
      try {
        await statusMsg.edit({ text: `❌ 一键更新失败: ${htmlEscape(String(error))}`, parseMode: "html" });
      } catch (editError) {
        console.log(`[TPM] 错误消息编辑失败: ${editError}`);
      }
    }
    return { failedCount: 1, statusPeerId: statusMsg?.peerId, statusMsgId: statusMsg?.id };
  }
}

async function handleSourceCommand(args: string[], msg: Api.Message): Promise<void> {
  const subCmd = args[1];
  
  if (!subCmd || subCmd === "show" || subCmd === "info") {
    const cfg = await getCustomSourceConfig();
    if (cfg) {
      await sendOrEditMessage(msg, `🗄️ <b>自定义插件源</b>\n\n${codeTag(cfg.url)}\n\n使用 <code>${mainPrefix}tpm source remove</code> 清除`, { parseMode: "html" });
    } else {
      await sendOrEditMessage(msg, `🗄️ <b>自定义插件源</b>\n\n未设置自定义插件源\n\n使用 <code>${mainPrefix}tpm source add &lt;仓库URL&gt;</code> 设置`, { parseMode: "html" });
    }
    return;
  }
  
  if (subCmd === "add") {
    const url = args[2];
    if (!url) {
      await sendOrEditMessage(msg, "❌ 请提供 GitHub 仓库地址\n如: <code>tpm source add https://github.com/xxx/xxx</code>", { parseMode: "html" });
      return;
    }
    const previousCfg = await getCustomSourceConfig();
    const statusMsg = await sendOrEditMessage(msg, "🔍 正在验证自定义插件源...");
    try {
      const rawUrl = convertGithubToRawPluginUrl(url);
      const test = await fetchWithRetry<RemotePluginsIndex>(rawUrl, { timeout: 10000 });
      if (test.status !== 200) {
        await sendOrEditMessage(statusMsg, `❌ 自定义插件源验证失败（HTTP ${test.status}）\n请确保仓库包含 plugins.json`);
        return;
      }
      const validated = validateRemotePluginsIndex(test.data, "自定义源");
      await setCustomSourceConfig(url);
      const pluginCount = Object.keys(validated).length;
      const repoLink = url.replace(/\/?$/, "");
      await reloadAndFinalize(statusMsg,
        `✅ <b>自定义插件源已设置</b>\n\n🔗 ${codeTag(repoLink)}\n📦 包含 ${pluginCount} 个插件\n\n💡 同名插件将优先使用自定义源版本`,
        {
          parseMode: "html",
          failureText: "❌ 自定义插件源加载失败，已恢复原配置",
          reload: async () => {
            const { loadPlugins } = require("@utils/pluginManager") as typeof import("@utils/pluginManager");
            if (await loadPlugins()) return true;
            if (previousCfg) await setCustomSourceConfig(previousCfg.url);
            else await clearCustomSourceConfig();
            await loadPlugins();
            return false;
          },
        }
      );
    } catch (error: unknown) {
      if (previousCfg) await setCustomSourceConfig(previousCfg.url);
      else await clearCustomSourceConfig();
      await sendOrEditMessage(statusMsg, `❌ 自定义插件源验证失败: ${error instanceof Error ? error.message : String(error)}\n请确认仓库可访问且包含 plugins.json`);
    }
    return;
  }
  
  if (subCmd === "remove" || subCmd === "rm" || subCmd === "del" || subCmd === "delete" || subCmd === "clear") {
    const cfg = await getCustomSourceConfig();
    if (!cfg) {
      await sendOrEditMessage(msg, "当前没有设置自定义插件源");
      return;
    }
    await clearCustomSourceConfig();
    await reloadAndFinalize(
      await sendOrEditMessage(msg, "🗑️ 正在清除自定义插件源..."),
      "✅ 自定义插件源已清除",
      {
        failureText: "❌ 清除自定义插件源后加载失败，已恢复原配置",
        reload: async () => {
          const { loadPlugins } = require("@utils/pluginManager") as typeof import("@utils/pluginManager");
          if (await loadPlugins()) return true;
          await setCustomSourceConfig(cfg.url);
          await loadPlugins();
          return false;
        },
      },
    );
    return;
  }
  
  await sendOrEditMessage(msg, `❌ 未知 source 子命令: ${codeTag(subCmd)}\n\n用法:\n• <code>${mainPrefix}tpm source add &lt;url&gt;</code> - 设置\n• <code>${mainPrefix}tpm source remove</code> - 清除\n• <code>${mainPrefix}tpm source</code> - 查看状态`, { parseMode: "html" });
}

class TpmPlugin extends Plugin {

  description: string = `<b>📦 TeleBox 插件管理器 (TPM)</b>

<b>🔍 查看插件:</b>
• <code>${mainPrefix}tpm search</code> (别名: <code>s</code>) - 显示远程插件列表
• <code>${mainPrefix}tpm ls</code> (别名: <code>list</code>) - 查看已安装记录
• <code>${mainPrefix}tpm ls -v</code> 或 <code>${mainPrefix}tpm lv</code> - 查看详细记录

<b>⬇️ 安装插件:</b>
• <code>${mainPrefix}tpm i [插件名]</code> (别名: <code>install</code>) - 安装单个插件
• <code>${mainPrefix}tpm i [插件名1] [插件名2]</code> - 安装多个插件
• <code>${mainPrefix}tpm i all</code> - 一键安装全部远程插件
• <code>${mainPrefix}tpm i</code> (回复插件文件) - 安装本地插件文件

<b>🔄 更新插件:</b>
• <code>${mainPrefix}tpm update</code> (别名: <code>updateAll</code>, <code>ua</code>) - 一键更新所有已安装的远程插件
• <code>${mainPrefix}tpm update -f</code> - 强制更新（覆盖本地修改过的插件）

<b>🗑️ 卸载插件:</b>
• <code>${mainPrefix}tpm rm [插件名]</code> (别名: <code>remove</code>, <code>uninstall</code>, <code>un</code>) - 卸载单个插件
• <code>${mainPrefix}tpm rm [插件名1] [插件名2]</code> - 卸载多个插件
• <code>${mainPrefix}tpm rm all</code> - 清空插件目录并刷新本地缓存

<b>⬆️ 上传插件:</b>
• <code>${mainPrefix}tpm upload [插件名]</code> (别名: <code>ul</code>) - 上传指定插件文件

<b>🗄️ 自定义源:</b>
• <code>${mainPrefix}tpm source add &lt;giturl&gt;</code> - 设置自定义插件源（1个）
• <code>${mainPrefix}tpm source remove</code> - 清除自定义插件源
• <code>${mainPrefix}tpm source</code> - 查看当前自定义源`;

  ignoreEdited: boolean = true;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    tpm: async (msg) => withPluginOperationLock(async () => {
      const text = msg.message;
      const [, ...args] = text.split(" ");
      if (args.length === 0) {
        await sendOrEditMessage(msg, this.description, { parseMode: "html" });
        return;
      }
      const cmd = args[0];
      if (cmd === "install" || cmd === "i") {
        await installPlugin(args, msg);
      } else if (
        cmd === "uninstall" ||
        cmd == "un" ||
        cmd === "remove" ||
        cmd === "rm"
      ) {
        const pluginNames = args.slice(1);
        if (pluginNames.length === 0) {
          await msg.edit({ text: "请提供要卸载的插件名称" });
        } else if (pluginNames.length === 1) {
          const name = pluginNames[0].toLowerCase();
          if (name === "all") {
            await uninstallAllPlugins(msg);
          } else {
            await uninstallPlugin(pluginNames[0], msg);
          }
        } else {
          await uninstallMultiplePlugins(pluginNames, msg);
        }
      } else if (cmd == "upload" || cmd == "ul") {
        await uploadPlugin(args, msg);
      } else if (cmd === "search" || cmd === "s") {
        await search(msg);
      } else if (cmd === "list" || cmd === "ls" || cmd === "lv") {
        await showPluginRecords(
          msg,
          ["-v", "--verbose"].includes(args[1]) || cmd === "lv"
        );
      } else if (cmd === "update" || cmd === "updateAll" || cmd === "ua") {
        // Parse force flag
        const force = args.includes("-f") || args.includes("--force");
        await updateAllPlugins(msg, { force });
      } else if (cmd === "source") {
        await handleSourceCommand(args, msg);
      } else {
        await sendOrEditMessage(msg, `❌ 未知命令: ${codeTag(cmd)}\n\n${this.description}`, { parseMode: "html" });
      }
    }),
  };
}

export default new TpmPlugin();

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args?.[0] !== "install" || args?.length < 2) {
    console.log("Usage: node tpm.ts install plugin1 plugin2 ...");
  }
  withPluginOperationLock(() =>
    installPlugin(args, {
      edit: async ({ text }: any) => {
        console.log(text);
      },
    } as any),
  )
    .then(() => {
      console.log("Plugins processed successfully");
    })
    .catch((error) => {
      console.error("Error processing plugins:", error);
    });
}
