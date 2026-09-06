/**
 * TeleBox Panel — TPM service layer (no MessageContext dependency).
 * Mirrors full `.tpm` capability for the WebApp API.
 */

import fs from "fs";
import path from "path";
import axios from "axios";
import { JSONFilePreset } from "lowdb/node";
import {
  createDirectoryInAssets,
  createDirectoryInTemp,
} from "@utils/pathHelpers";
import {
  getLastPluginLoadReport,
  loadPlugins,
  pluginFailedInReport,
  withPluginOperationLock,
  writeJsonFileAtomically,
} from "@utils/pluginManager";
import { logger } from "@utils/logger";
import type { TpmInstalledPlugin, TpmRemotePlugin } from "./types";
import { EventEmitter } from "events";
import { createHash, randomBytes } from "crypto";

export const tpmUpdateEmitter = new EventEmitter();
export const TPM_UPDATE_EVENT = "progress";

const PLUGINS_INDEX_URL =
  "https://raw.githubusercontent.com/MiCat-S/Mi-Box-Plugins/main/plugins.json";
const PLUGIN_PATH = path.join(process.cwd(), "plugins");
const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 4;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const DEFAULT_HEADERS = {
  "User-Agent": "TeleBox-Panel-TPM/1.0",
  Accept: "application/json, text/plain, */*",
};

type RemotePluginInfo = { url: string; desc?: string; name?: string };
type RemotePluginsIndex = Record<string, RemotePluginInfo>;
interface PluginRecord {
  url: string;
  desc?: string;
  _updatedAt: number;
  _contentHash?: string;
  _baseline?: "trusted" | "unknown";
}
type Database = Record<string, PluginRecord>;

export function buildReconciledPluginRecord(
  remote: RemotePluginInfo,
  old?: PluginRecord,
): PluginRecord {
  return {
    url: remote.url,
    desc: remote.desc,
    _updatedAt: old?._updatedAt || 0,
    ...(old?._contentHash ? { _contentHash: old._contentHash } : {}),
    ...(old?._baseline
      ? { _baseline: old._baseline }
      : old
        ? {}
        : { _baseline: "unknown" as const }),
  };
}

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

function ensurePluginDirectory(root = PLUGIN_PATH): void {
  const stat = lstatIfExists(root);
  if (stat) {
    if (stat.isSymbolicLink()) {
      throw new Error(`插件目录不能是符号链接: ${root}`);
    }
    if (!stat.isDirectory()) throw new Error(`插件目录路径不是目录: ${root}`);
    return;
  }
  fs.mkdirSync(root, { recursive: true });
}

export function resolvePluginPathWithin(
  root: string,
  name: string,
  options?: { mustExist?: boolean },
): string {
  assertValidPluginName(name);
  ensurePluginDirectory(root);
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
  return resolvePluginPathWithin(PLUGIN_PATH, name, options);
}

function hashPluginContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function isLocallyModifiedPlugin(
  filePath: string,
  currentContent: string,
  record: PluginRecord,
): boolean {
  const localHash = hashPluginContent(currentContent);
  if (record._contentHash) return localHash !== record._contentHash;
  if (record._baseline === "unknown") return true;
  try {
    return fs.statSync(filePath).mtimeMs > (record._updatedAt || 0) + 2000;
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

export const withTpmOperationLock = withPluginOperationLock;

function getCustomSourceConfigPath(): string {
  return path.join(createDirectoryInAssets("tpm"), "source.json");
}

async function getCustomSourceConfig(): Promise<{ url: string } | null> {
  const cfgPath = getCustomSourceConfigPath();
  if (!fs.existsSync(cfgPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf-8")) as {
      url?: unknown;
    };
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
      ...(typeof info.name === "string" ? { name: info.name } : {}),
    };
  }
  return result;
}

function normalizeGithubUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "github.com") {
      const parts = u.pathname.split("/").filter(Boolean);
      // owner/repo/blob/branch/path -> raw
      if (parts.length >= 5 && parts[2] === "blob") {
        const [owner, repo, , branch, ...rest] = parts;
        return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${rest.join("/")}`;
      }
    }
    return url;
  } catch {
    return url;
  }
}

async function fetchWithRetry<T>(
  url: string,
  options?: { responseType?: "json" | "text" },
): Promise<{ status: number; data: T }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await axios.get(url, {
        timeout: REQUEST_TIMEOUT_MS,
        headers: DEFAULT_HEADERS,
        responseType: options?.responseType === "text" ? "text" : "json",
        validateStatus: () => true,
      });
      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      return { status: res.status, data: res.data as T };
    } catch (e: unknown) {
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function getMergedRemotePluginsIndex(options?: {
  customSource?: { url: string } | null;
  fetchIndex?: (url: string) => Promise<{ status: number; data: unknown }>;
}): Promise<RemotePluginsIndex> {
  const fetchIndex =
    options?.fetchIndex ??
    (async (url: string) => await fetchWithRetry<unknown>(url));
  const merged: RemotePluginsIndex = {};
  try {
    const officialRes = await fetchIndex(PLUGINS_INDEX_URL);
    if (
      officialRes.status === 200 &&
      officialRes.data &&
      typeof officialRes.data === "object"
    ) {
      Object.assign(
        merged,
        validateRemotePluginsIndex(officialRes.data, "官方源"),
      );
    } else {
      throw new Error(`HTTP ${officialRes.status}`);
    }
  } catch (error: unknown) {
    logger.info(
      `[panel-tpm] 官方源失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const customSource =
    options && "customSource" in options
      ? options.customSource ?? null
      : await getCustomSourceConfig();
  if (customSource) {
    const rawUrl = convertGithubToRawPluginUrl(customSource.url);
    try {
      const customRes = await fetchIndex(rawUrl);
      if (
        customRes.status === 200 &&
        customRes.data &&
        typeof customRes.data === "object"
      ) {
        Object.assign(
          merged,
          validateRemotePluginsIndex(customRes.data, "自定义源"),
        );
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

async function getDatabase() {
  const dbPath = path.join(createDirectoryInAssets("tpm"), "plugins.json");
  return JSONFilePreset<Database>(dbPath, {});
}

function listLocalPluginFiles(): string[] {
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
          !entry.name.endsWith(".deployed") &&
          !entry.name.startsWith("_") &&
          PLUGIN_NAME_PATTERN.test(entry.name.replace(/\.ts$/, "")),
      )
      .map((entry) => entry.name.replace(/\.ts$/, ""));
  } catch {
    return [];
  }
}

async function rebuildPluginDb(
  db: Awaited<ReturnType<typeof getDatabase>>,
  catalog?: RemotePluginsIndex,
): Promise<number> {
  const local = new Set(listLocalPluginFiles());
  const remoteCatalog = catalog ?? (await getMergedRemotePluginsIndex());
  const next: Database = {};
  for (const name of local) {
    const remote = remoteCatalog[name];
    const old = db.data[name];
    if (remote) {
      next[name] = buildReconciledPluginRecord(remote, old);
    } else if (old) {
      next[name] = old;
    }
  }
  db.data = next;
  await db.write();
  return Object.keys(next).length;
}

export async function tpmSearch(keyword = ""): Promise<{
  total: number;
  installed: number;
  localOnly: number;
  remoteOnly: number;
  items: TpmRemotePlugin[];
  customSource: string | null;
}> {
  const [catalog, db] = await Promise.all([
    getMergedRemotePluginsIndex(),
    getDatabase(),
  ]);
  const local = new Set(listLocalPluginFiles());
  const kw = keyword.trim().toLowerCase();
  const names = Object.keys(catalog).filter((name) => {
    if (!kw) return true;
    const desc = catalog[name]?.desc || "";
    return (
      name.toLowerCase().includes(kw) || desc.toLowerCase().includes(kw)
    );
  });

  let installed = 0;
  let localOnly = 0;
  let remoteOnly = 0;
  const items: TpmRemotePlugin[] = names
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const info = catalog[name];
      const hasLocal = local.has(name);
      const hasManagedDb =
        !!db.data[name] && db.data[name]._baseline !== "unknown";
      let status: TpmRemotePlugin["status"] = "remote";
      if (hasLocal && hasManagedDb) {
        status = "installed";
        installed++;
      } else if (hasLocal) {
        status = "local";
        localOnly++;
      } else {
        remoteOnly++;
      }
      return {
        name,
        url: info?.url || "",
        desc: info?.desc || "暂无描述",
        status,
      };
    });

  // Include local-only plugins not in catalog
  for (const name of local) {
    if (catalog[name]) continue;
    if (kw && !name.toLowerCase().includes(kw)) continue;
    localOnly++;
    items.push({
      name,
      url: db.data[name]?.url || "",
      desc: db.data[name]?.desc || "本地插件",
      status: "local",
    });
  }

  const custom = await getCustomSourceConfig();
  return {
    total: items.length,
    installed,
    localOnly,
    remoteOnly,
    items,
    customSource: custom?.url || null,
  };
}

export async function tpmListInstalled(verbose = false): Promise<{
  count: number;
  items: TpmInstalledPlugin[];
}> {
  return withPluginOperationLock(() => tpmListInstalledUnlocked(verbose));
}

async function tpmListInstalledUnlocked(verbose = false): Promise<{
  count: number;
  items: TpmInstalledPlugin[];
}> {
  const db = await getDatabase();
  await rebuildPluginDb(db);
  const local = listLocalPluginFiles();
  const items: TpmInstalledPlugin[] = local
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const rec = db.data[name];
      const filePath = resolvePluginFilePath(name);
      let fileSize: number | undefined;
      if (verbose && fs.existsSync(filePath)) {
        try {
          fileSize = fs.statSync(filePath).size;
        } catch {
          /* ignore */
        }
      }
      return {
        name,
        url: rec?.url,
        desc: rec?.desc,
        updatedAt: rec?._updatedAt,
        hasFile: fs.existsSync(filePath),
        fileSize,
      };
    });
  return { count: items.length, items };
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
    logger.error("[panel-tpm] reload failed after restoring previous plugin files");
  }
  return { ok: false, failedNames, recovered };
}

async function downloadAndWritePlugin(
  name: string,
  url: string,
  desc: string | undefined,
  db: Awaited<ReturnType<typeof getDatabase>>,
): Promise<PluginFileSnapshot> {
  assertValidPluginName(name);
  const pluginUrl = normalizeGithubUrl(url);
  const response = await fetchWithRetry<string>(pluginUrl, {
    responseType: "text",
  });
  if (response.status !== 200 || typeof response.data !== "string") {
    throw new Error(`下载失败 HTTP ${response.status}`);
  }
  const snapshot = writePluginAtomically(name, response.data);
  db.data[name] = {
    url: pluginUrl,
    desc,
    _updatedAt: Date.now(),
    _contentHash: hashPluginContent(response.data),
    _baseline: "trusted",
  };
  return snapshot;
}

export async function tpmInstall(
  names: string[],
): Promise<{ ok: string[]; failed: Array<{ name: string; error: string }> }> {
  return withPluginOperationLock(async () => {
    const catalog = await getMergedRemotePluginsIndex();
    const db = await getDatabase();
    const previousDb = { ...db.data };
    const snapshots: PluginFileSnapshot[] = [];
    const ok: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    const targets =
      names.length === 1 && names[0].toLowerCase() === "all"
        ? Object.keys(catalog)
        : names;

    for (const raw of targets) {
      const name = raw.trim();
      if (!name) continue;
      try {
        assertValidPluginName(name);
        const info = catalog[name];
        if (!info?.url) {
          failed.push({ name, error: "远程目录中不存在" });
          continue;
        }
        snapshots.push(
          await downloadAndWritePlugin(name, info.url, info.desc, db),
        );
        ok.push(name);
      } catch (e: unknown) {
        failed.push({
          name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (ok.length > 0) {
      await persistPluginMutations(snapshots, db, previousDb);
      const reloadResult = await reloadWithRollback(snapshots, db, previousDb);
      for (const name of reloadResult.failedNames) {
        const index = ok.indexOf(name);
        if (index >= 0) ok.splice(index, 1);
        failed.push({ name, error: "插件加载失败，已恢复安装前文件" });
      }
    }
    return { ok, failed };
  });
}

export async function tpmUninstall(
  names: string[],
): Promise<{ ok: string[]; failed: Array<{ name: string; error: string }> }> {
  return withPluginOperationLock(async () => {
    const ok: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    const db = await getDatabase();
    const previousDb = { ...db.data };
    const snapshots: PluginFileSnapshot[] = [];

    if (names.length === 1 && names[0].toLowerCase() === "all") {
      const local = listLocalPluginFiles();
      for (const name of local) {
        try {
          snapshots.push(deletePluginFile(name));
          delete db.data[name];
          ok.push(name);
        } catch (e: unknown) {
          failed.push({
            name,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      await persistPluginMutations(snapshots, db, previousDb);
      if (ok.length > 0) {
        const reloadResult = await reloadWithRollback(snapshots, db, previousDb);
        for (const name of reloadResult.failedNames) {
          const index = ok.indexOf(name);
          if (index >= 0) ok.splice(index, 1);
          failed.push({ name, error: "插件加载失败，已恢复卸载前文件" });
        }
      }
      return { ok, failed };
    }

    for (const raw of names) {
      const name = raw.trim();
      if (!name) continue;
      try {
        assertValidPluginName(name);
        const fp = resolvePluginFilePath(name);
        if (!fs.existsSync(fp)) {
          failed.push({ name, error: "本地文件不存在" });
          continue;
        }
        snapshots.push(deletePluginFile(name));
        delete db.data[name];
        ok.push(name);
      } catch (e: unknown) {
        failed.push({
          name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    await persistPluginMutations(snapshots, db, previousDb);
    if (ok.length > 0) {
      const reloadResult = await reloadWithRollback(snapshots, db, previousDb);
      for (const name of reloadResult.failedNames) {
        const index = ok.indexOf(name);
        if (index >= 0) ok.splice(index, 1);
        failed.push({ name, error: "插件加载失败，已恢复卸载前文件" });
      }
    }
    return { ok, failed };
  });
}

export async function tpmUpdateAll(opts?: { force?: boolean }): Promise<{
  updated: string[];
  unchanged: string[];
  failed: Array<{ name: string; error: string }>;
}> {
  return withPluginOperationLock(async () => {
    const force = !!opts?.force;
    const [catalog, db] = await Promise.all([
      getMergedRemotePluginsIndex(),
      getDatabase(),
    ]);
    const previousDb = { ...db.data };
    await rebuildPluginDb(db, catalog);
    const updated: string[] = [];
    const unchanged: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    const snapshots: PluginFileSnapshot[] = [];
    const names = Object.keys(db.data);
    tpmUpdateEmitter.emit(TPM_UPDATE_EVENT, { type: "start", total: names.length });

    for (const name of names) {
      const rec = db.data[name];
      const remote = catalog[name];
      tpmUpdateEmitter.emit(TPM_UPDATE_EVENT, { type: "checking", name, total: names.length });
      if (!remote?.url) {
        unchanged.push(name);
        tpmUpdateEmitter.emit(TPM_UPDATE_EVENT, { type: "unchanged", name });
        continue;
      }
      try {
        assertValidPluginName(name);
        const pluginUrl = normalizeGithubUrl(remote.url);
        const response = await fetchWithRetry<string>(pluginUrl, {
          responseType: "text",
        });
        if (response.status !== 200 || typeof response.data !== "string") {
          failed.push({ name, error: `HTTP ${response.status}` });
          tpmUpdateEmitter.emit(TPM_UPDATE_EVENT, { type: "failed", name, error: `HTTP ${response.status}` });
          continue;
        }
        const filePath = resolvePluginFilePath(name, { mustExist: true });
        const current = fs.existsSync(filePath)
          ? fs.readFileSync(filePath, "utf-8")
          : "";
        if (current === response.data) {
          const currentHash = hashPluginContent(current);
          if (rec._contentHash !== currentHash) rec._contentHash = currentHash;
          rec._baseline = "trusted";
          unchanged.push(name);
          tpmUpdateEmitter.emit(TPM_UPDATE_EVENT, { type: "unchanged", name });
          continue;
        }
        if (!force && isLocallyModifiedPlugin(filePath, current, rec)) {
          failed.push({
            name,
            error: "检测到本地修改；请使用 force=true 明确覆盖",
          });
          tpmUpdateEmitter.emit(TPM_UPDATE_EVENT, {
            type: "failed",
            name,
            error: "检测到本地修改",
          });
          continue;
        }
        const snapshot = writePluginAtomically(name, response.data);
        snapshots.push(snapshot);
        db.data[name] = {
          url: pluginUrl,
          desc: remote.desc,
          _updatedAt: Date.now(),
          _contentHash: hashPluginContent(response.data),
          _baseline: "trusted",
        };
        updated.push(name);
        tpmUpdateEmitter.emit(TPM_UPDATE_EVENT, { type: "updated", name });
      } catch (e: unknown) {
        failed.push({
          name,
          error: e instanceof Error ? e.message : String(e),
        });
        tpmUpdateEmitter.emit(TPM_UPDATE_EVENT, { type: "failed", name, error: e instanceof Error ? e.message : String(e) });
      }
    }
    await persistPluginMutations(snapshots, db, previousDb);
    if (updated.length > 0) {
      const reloadResult = await reloadWithRollback(snapshots, db, previousDb);
      for (const name of reloadResult.failedNames) {
        const index = updated.indexOf(name);
        if (index >= 0) updated.splice(index, 1);
        failed.push({ name, error: "插件加载失败，已恢复更新前文件" });
        tpmUpdateEmitter.emit(TPM_UPDATE_EVENT, {
          type: "failed",
          name,
          error: "插件加载失败，已回滚",
        });
      }
    }
    return { updated, unchanged, failed };
  });
}

export async function tpmGetSource(): Promise<{
  official: string;
  custom: string | null;
}> {
  const custom = await getCustomSourceConfig();
  return { official: PLUGINS_INDEX_URL, custom: custom?.url || null };
}

export async function tpmSetSource(url: string): Promise<void> {
  await withPluginOperationLock(async () => {
    const raw = url.trim();
    if (!raw) throw new Error("URL 不能为空");
    const indexUrl = convertGithubToRawPluginUrl(raw);
    const res = await fetchWithRetry<RemotePluginsIndex>(indexUrl);
    if (res.status !== 200 || !res.data || typeof res.data !== "object") {
      throw new Error(`无法验证插件源 (HTTP ${res.status})`);
    }
    validateRemotePluginsIndex(res.data, "自定义源");
    writeJsonFileAtomically(getCustomSourceConfigPath(), { url: raw });
  });
}

export async function tpmClearSource(): Promise<void> {
  await withPluginOperationLock(async () => {
    const p = getCustomSourceConfigPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
}

export async function tpmReadPluginSource(
  name: string,
): Promise<{ name: string; content: string; size: number }> {
  assertValidPluginName(name);
  const fp = resolvePluginFilePath(name, { mustExist: true });
  const content = fs.readFileSync(fp, "utf-8");
  return { name, content, size: Buffer.byteLength(content) };
}
