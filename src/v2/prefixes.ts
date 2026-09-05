import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { parse } from "dotenv";

export interface PrefixPersistence {
  /** Must settle after all I/O, including cancellation cleanup, actually finishes. */
  persist(prefixes: readonly string[], signal: AbortSignal): Promise<void>;
}

export function prefixesFromEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  const configured = env.TB_PREFIX?.split(/\s+/u).filter(Boolean) ?? [];
  return configured.length ? configured : env.NODE_ENV === "development" ? ["!", "！"] : [".", "。", "$"];
}

function failure(): Error { return new Error("Prefix environment persistence failed safely"); }

const MARKER = "# telebox-prefix:";
const END_MARKER = `${MARKER}end`;
function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }

function managedBase(content: string): { content: string; newline?: string } {
  const start = content.indexOf(MARKER);
  if (start < 0) return { content };
  const base = content.slice(0, start);
  const suffix = content.slice(start);
  if (start > 0 && !base.endsWith("\n")) throw failure();
  const header = /^# telebox-prefix:v2 (\d+) ([a-f0-9]{64})(\r?\n)/u.exec(suffix);
  if (!header) throw failure();
  const newline = header[3];
  // Length is measured in JS string code units, matching slice before UTF-8 encoding.
  const length = Number(header[1]);
  if (!Number.isSafeInteger(length) || length <= 0 || length > suffix.length - header[0].length) throw failure();
  const assignment = suffix.slice(header[0].length, header[0].length + length);
  const ending = END_MARKER + newline;
  const assignmentEnd = header[0].length + length;
  if (!suffix.startsWith(ending, assignmentEnd) || digest(assignment) !== header[2]) throw failure();
  const end = assignmentEnd + ending.length;
  const parsed = parse(assignment);
  if (!assignment.startsWith("TB_PREFIX=") || !assignment.endsWith("\n") || Object.keys(parsed).length !== 1 ||
      !Object.hasOwn(parsed, "TB_PREFIX")) throw failure();
  // A valid-looking block embedded in a quoted value is user content, not a comment block.
  let probe = "TELEBOX_PREFIX_BOUNDARY";
  while (content.includes(probe)) probe += "_";
  if (parse(base + `${probe}=1\n` + suffix)[probe] !== "1") throw failure();
  const remaining = base + suffix.slice(end);
  if (remaining.includes(MARKER)) throw failure();
  return { content: remaining, newline };
}

/** Preserve user bytes around a verified block, then place the authoritative block at EOF. */
export function updatePrefixEnv(content: string, value: string): string {
  if (content.includes("\0") || value.includes("\0") || Buffer.from(value).toString("utf8") !== value) throw failure();
  const managed = managedBase(content);
  const original = managed.content;
  const before = parse(content);
  if (before.TB_PREFIX === value && original === content) return content;
  const newline = managed.newline ?? (content.includes("\r\n") ? "\r\n" : "\n");
  const separator = !original || original.endsWith("\n") ? "" : newline;
  const base = original + separator;
  // dotenv is not JSON or a shell: it does not unescape quotes/backslashes.
  // Try literal representations and prove their meaning using its actual parser.
  for (const encoded of [`'${value}'`, `"${value}"`, `\`${value}\``, value]) {
    const assignment = `TB_PREFIX=${encoded}${newline}`;
    const isolated = parse(assignment);
    if (Object.keys(isolated).length !== 1 || isolated.TB_PREFIX !== value) continue;
    const result = base + `${MARKER}v2 ${assignment.length} ${digest(assignment)}${newline}` + assignment + END_MARKER + newline;
    const after = parse(result);
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    if (after.TB_PREFIX === value && [...keys].every(key => key === "TB_PREFIX" ||
        Object.hasOwn(before, key) === Object.hasOwn(after, key) && before[key] === after[key])) return result;
  }
  throw failure();
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function checkParent(file: string, signal: AbortSignal): Promise<void> {
  const parent = path.dirname(file);
  let current = path.parse(parent).root;
  for (const part of parent.slice(current.length).split(path.sep).filter(Boolean)) {
    signal.throwIfAborted();
    current = path.join(current, part);
    const entry = await fs.lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw failure();
  }
}

async function readSource(file: string, signal: AbortSignal) {
  signal.throwIfAborted();
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || !(stat.mode & 0o222n) || (stat.mode & 0o7000n)) throw failure();
    await fs.access(file, constants.W_OK);
    const bytes = await handle.readFile({ signal });
    const content = bytes.toString("utf8");
    if (!Buffer.from(content).equals(bytes)) throw failure();
    return { stat, bytes, content };
  } finally { await handle.close(); }
}

// Shared across instances, including plugin generations; idle paths are not retained.
const writes = new Map<string, Promise<void>>();

/** Explicit, lazy path capability. Parents must be trusted, single-process-owned directories. */
export class PrefixEnvStore implements PrefixPersistence {
  constructor(private readonly file: string) {
    if (!path.isAbsolute(file) || file.includes("\0")) throw failure();
    this.file = path.normalize(file);
  }

  persist(prefixes: readonly string[], signal: AbortSignal): Promise<void> {
    const snapshot = [...prefixes];
    const operation = (writes.get(this.file) ?? Promise.resolve()).then(async () => {
      signal.throwIfAborted();
      if (!snapshot.length || snapshot.some(prefix => typeof prefix !== "string" || !prefix || /[\s\0]/u.test(prefix))) throw failure();
      try { await this.write(snapshot.join(" "), signal); }
      catch { signal.throwIfAborted(); throw failure(); }
    });
    const settled = operation.then(() => undefined, () => undefined);
    writes.set(this.file, settled);
    void settled.then(() => { if (writes.get(this.file) === settled) writes.delete(this.file); });
    return operation;
  }

  private async write(value: string, signal: AbortSignal): Promise<void> {
    await checkParent(this.file, signal);
    const source = await readSource(this.file, signal);
    signal.throwIfAborted();
    const content = updatePrefixEnv(source?.content ?? "", value);
    if (content === source?.content) return;
    const temporary = path.join(path.dirname(this.file), `.telebox-prefix-${randomUUID()}.tmp`);
    let handle;
    let created = false;
    try {
      signal.throwIfAborted();
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      const stat = await handle.stat({ bigint: true });
      if (source && (source.stat.uid !== stat.uid || source.stat.gid !== stat.gid)) throw failure();
      await handle.writeFile(content, { encoding: "utf8", signal });
      await handle.chmod(source ? Number(source.stat.mode & 0o777n) : 0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await checkParent(this.file, signal);
      const current = await readSource(this.file, signal);
      if (source ? !current || !current.bytes.equals(source.bytes) ||
          (["dev", "ino", "mtimeNs", "ctimeNs"] as const).some(key => source.stat[key] !== current.stat[key]) : current) throw failure();
      signal.throwIfAborted();
      // Rename submission is the commit boundary; await actual settlement even on abort.
      // Like the JSON store, this does not promise directory metadata power-loss durability.
      await fs.rename(temporary, this.file);
      created = false;
    } finally {
      try { if (handle) await handle.close(); }
      finally { if (created) await fs.unlink(temporary); }
    }
  }
}
