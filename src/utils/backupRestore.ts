import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawn, spawnSync } from "child_process";
import type { GenerationContext } from "./generationContext";

const RESTORE_DIRS = ["plugins", "assets"] as const;
const MAX_TAR_LIST_BYTES = 16 * 1024 * 1024;

export interface BackupArchiveLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_BACKUP_ARCHIVE_LIMITS: BackupArchiveLimits = {
  maxEntries: 20_000,
  maxFileBytes: 256 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
};

function tarList(archivePath: string, verbose: boolean): string {
  const args = [verbose ? "-tvzf" : "-tzf", archivePath];
  const result = spawnSync("tar", args, {
    encoding: "utf8",
    maxBuffer: MAX_TAR_LIST_BYTES,
    timeout: 30_000,
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      `无法读取备份目录: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function validateArchivePath(entryName: string): void {
  const name = entryName.replace(/\/$/, "");
  if (!name || name.includes("\0")) {
    throw new Error("备份包含空路径或 NUL 字符");
  }
  if (
    path.posix.isAbsolute(name) ||
    path.win32.isAbsolute(name) ||
    /^[a-zA-Z]:[\\/]/.test(name)
  ) {
    throw new Error(`备份包含绝对路径: ${entryName}`);
  }
  const components = name.split(/[\\/]+/);
  if (components.includes("..")) {
    throw new Error(`备份包含目录穿越路径: ${entryName}`);
  }
  const normalized = components.filter((part) => part !== ".").join("/");
  if (
    normalized !== "telebox_backup" &&
    !normalized.startsWith("telebox_backup/")
  ) {
    throw new Error(`无效的备份顶层目录: ${entryName}`);
  }
}

function parseVerboseEntrySize(line: string): number {
  const match = line.match(
    /\s(\d+)\s+(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}|\d{4}-\d{2}-\d{2})\s/,
  );
  if (!match) throw new Error(`无法可靠识别备份条目大小: ${line}`);
  const size = Number(match[1]);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`备份条目大小无效: ${line}`);
  }
  return size;
}

export function inspectBackupArchive(
  archivePath: string,
  limits: BackupArchiveLimits = DEFAULT_BACKUP_ARCHIVE_LIMITS,
): string[] {
  const entries = tarList(archivePath, false)
    .split(/\r?\n/)
    .filter(Boolean);
  if (entries.length === 0) throw new Error("备份文件为空");
  if (entries.length > limits.maxEntries) {
    throw new Error(`备份条目过多: ${entries.length} > ${limits.maxEntries}`);
  }
  for (const entry of entries) validateArchivePath(entry);

  const verboseLines = tarList(archivePath, true)
    .split(/\r?\n/)
    .filter(Boolean);
  if (verboseLines.length !== entries.length) {
    throw new Error("无法可靠识别备份条目类型");
  }
  let totalBytes = 0;
  for (const line of verboseLines) {
    const type = line[0];
    if (type !== "-" && type !== "d") {
      throw new Error(`备份包含不允许的条目类型: ${line}`);
    }
    if (/\s(?:link to|->)\s/.test(line)) {
      throw new Error(`备份包含链接条目: ${line}`);
    }
    if (type === "-") {
      const size = parseVerboseEntrySize(line);
      if (size > limits.maxFileBytes) {
        throw new Error(`备份单文件过大: ${size} > ${limits.maxFileBytes}`);
      }
      totalBytes += size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
        throw new Error(`备份总大小过大: ${totalBytes} > ${limits.maxTotalBytes}`);
      }
    }
  }
  return entries;
}

function assertSafeTree(
  root: string,
  limits: BackupArchiveLimits = DEFAULT_BACKUP_ARCHIVE_LIMITS,
): void {
  const rootReal = fs.realpathSync(root);
  let entryCount = 0;
  let totalBytes = 0;
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        throw new Error(`staging 条目过多: ${entryCount} > ${limits.maxEntries}`);
      }
      const candidate = path.join(current, entry.name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        throw new Error(`staging 包含符号链接: ${candidate}`);
      }
      if (stat.isDirectory()) {
        visit(candidate);
        continue;
      }
      if (!stat.isFile() || stat.nlink > 1) {
        throw new Error(`staging 包含非常规文件: ${candidate}`);
      }
      if (stat.size > limits.maxFileBytes) {
        throw new Error(`staging 单文件过大: ${stat.size} > ${limits.maxFileBytes}`);
      }
      totalBytes += stat.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
        throw new Error(`staging 总大小过大: ${totalBytes} > ${limits.maxTotalBytes}`);
      }
      const real = fs.realpathSync(candidate);
      if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) {
        throw new Error(`staging 文件逃逸目标目录: ${candidate}`);
      }
    }
  };
  visit(root);
}

function copySafeTree(src: string, dest: string): void {
  const sourceStat = fs.lstatSync(src);
  if (!sourceStat.isDirectory()) {
    throw new Error(`备份目标不是目录: ${src}`);
  }
  fs.mkdirSync(dest, { recursive: true, mode: sourceStat.mode & 0o777 });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const source = path.join(src, entry.name);
    const target = path.join(dest, entry.name);
    const stat = fs.lstatSync(source);
    if (stat.isDirectory()) {
      copySafeTree(source, target);
    } else if (stat.isFile() && stat.nlink === 1) {
      fs.copyFileSync(source, target);
      fs.chmodSync(target, stat.mode & 0o777);
    } else {
      throw new Error(`备份包含不允许的文件: ${source}`);
    }
  }
}

export async function extractBackupArchive(
  archivePath: string,
  lifecycle: GenerationContext,
  limits: BackupArchiveLimits = DEFAULT_BACKUP_ARCHIVE_LIMITS,
): Promise<string> {
  inspectBackupArchive(archivePath, limits);
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-extract-"));
  try {
    await lifecycle.runTask(
      async () =>
        await new Promise<void>((resolve, reject) => {
          const tar = lifecycle.trackChildProcess(
            spawn("tar", ["-xzf", archivePath, "-C", extractDir]),
            { label: "bf:extract-tar" },
          );
          tar.once("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`tar exited with code ${code}`));
          });
          tar.once("error", reject);
          if (lifecycle.signal.aborted) {
            reject(
              lifecycle.signal.reason instanceof Error
                ? lifecycle.signal.reason
                : new Error("Backup operation aborted"),
            );
          }
        }),
      { label: "bf:extract-tar" },
    );
    assertSafeTree(extractDir, limits);
    return extractDir;
  } catch (error) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    throw error;
  }
}

interface RestoreJournalEntry {
  name: (typeof RESTORE_DIRS)[number];
  currentPath: string;
  stagedPath: string;
  savedPath: string;
  oldMoved: boolean;
  installed: boolean;
}

export interface RestoreBackupResult {
  previousFilesDir: string;
  programDir: string;
}

export function restoreBackupFromStaging(
  extractPath: string,
  programDir = process.cwd(),
): RestoreBackupResult {
  const backupRoot = path.join(extractPath, "telebox_backup");
  if (!fs.existsSync(backupRoot) || !fs.lstatSync(backupRoot).isDirectory()) {
    throw new Error("无效的备份文件格式");
  }
  assertSafeTree(backupRoot);

  const token = `${Date.now()}-${process.pid}-${crypto.randomBytes(5).toString("hex")}`;
  const transactionDir = path.join(programDir, `._restore_staging_${token}`);
  const previousFilesDir = path.join(programDir, `_restore_backup_${token}`);
  const stagedRoot = path.join(transactionDir, "staged");
  fs.mkdirSync(stagedRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(previousFilesDir, { mode: 0o700 });

  const entries: RestoreJournalEntry[] = RESTORE_DIRS.map((name) => ({
      name,
      currentPath: path.join(programDir, name),
      stagedPath: path.join(stagedRoot, name),
      savedPath: path.join(previousFilesDir, name),
      oldMoved: false,
      installed: false,
    }));

  try {
    for (const entry of entries) {
      const source = path.join(backupRoot, entry.name);
      if (fs.existsSync(source)) copySafeTree(source, entry.stagedPath);
      else fs.mkdirSync(entry.stagedPath, { mode: 0o700 });
      assertSafeTree(entry.stagedPath);
    }

    for (const entry of entries) {
      if (fs.existsSync(entry.currentPath)) {
        fs.renameSync(entry.currentPath, entry.savedPath);
        entry.oldMoved = true;
      }
      fs.renameSync(entry.stagedPath, entry.currentPath);
      entry.installed = true;
    }
    return { previousFilesDir, programDir };
  } catch (error) {
    for (const entry of [...entries].reverse()) {
      if (entry.installed && fs.existsSync(entry.currentPath)) {
        fs.rmSync(entry.currentPath, { recursive: true, force: true });
        entry.installed = false;
      }
      if (entry.oldMoved && fs.existsSync(entry.savedPath)) {
        if (fs.existsSync(entry.currentPath)) {
          throw new Error(`恢复回滚目标已被占用: ${entry.currentPath}`);
        }
        fs.renameSync(entry.savedPath, entry.currentPath);
        entry.oldMoved = false;
      }
    }
    throw error;
  } finally {
    fs.rmSync(transactionDir, { recursive: true, force: true });
  }
}

export function rollbackRestoredBackup(result: RestoreBackupResult): void {
  const token = `${Date.now()}-${process.pid}-${crypto.randomBytes(5).toString("hex")}`;
  const failedRestoreDir = path.join(
    result.previousFilesDir,
    `failed-restored-files-${token}`,
  );
  fs.mkdirSync(failedRestoreDir, { mode: 0o700 });
  const movedCurrent: Array<{ current: string; failed: string }> = [];
  const restoredPrevious: Array<{ saved: string; current: string }> = [];

  try {
    for (const name of RESTORE_DIRS) {
      const current = path.join(result.programDir, name);
      const failed = path.join(failedRestoreDir, name);
      const saved = path.join(result.previousFilesDir, name);
      if (fs.existsSync(current)) {
        fs.renameSync(current, failed);
        movedCurrent.push({ current, failed });
      }
      if (fs.existsSync(saved)) {
        fs.renameSync(saved, current);
        restoredPrevious.push({ saved, current });
      }
    }
  } catch (error) {
    for (const entry of [...restoredPrevious].reverse()) {
      if (fs.existsSync(entry.current) && !fs.existsSync(entry.saved)) {
        fs.renameSync(entry.current, entry.saved);
      }
    }
    for (const entry of [...movedCurrent].reverse()) {
      if (fs.existsSync(entry.failed) && !fs.existsSync(entry.current)) {
        fs.renameSync(entry.failed, entry.current);
      }
    }
    throw error;
  }
}

export async function reloadRestoredBackupOrRollback(
  result: RestoreBackupResult,
  reload: () => Promise<unknown>,
): Promise<boolean> {
  if ((await reload()) === true) return true;
  rollbackRestoredBackup(result);
  if ((await reload()) !== true) {
    throw new Error("恢复失败后已回滚原目录，但原插件仍无法重新加载");
  }
  return false;
}
