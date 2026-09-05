import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

type RecordValue = Record<string, unknown>;
type SourceJSON = {
  parse(text: string, reviver: (key: string, value: unknown, context: { source?: string }) => unknown): unknown;
  rawJSON(text: string): unknown;
};
// The project's ES2022 typings predate the source-aware JSON API available in Node 24.
const sourceJSON = JSON as unknown as SourceJSON;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parse(text: string): RecordValue {
  const value = sourceJSON.parse(text, (_key, value, context) => {
    if (typeof value !== "number") return value;
    if (context?.source === undefined || typeof sourceJSON.rawJSON !== "function") {
      throw new Error("JSON storage requires Node.js 24 source-aware JSON support");
    }
    if (/^-?\d+$/.test(context.source) && !Number.isSafeInteger(value)) {
      return BigInt(context.source);
    }
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new RangeError("Unsafe decimal or exponent JSON number; use an integer literal or a string");
    }
    return value;
  });
  if (!isRecord(value)) throw new TypeError("JSON storage requires an object at the root");
  return value;
}

function stringify(value: RecordValue): string {
  if (!isRecord(value)) throw new TypeError("JSON storage requires an object at the root");
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") {
      if (typeof sourceJSON.rawJSON !== "function") {
        throw new Error("JSON storage requires Node.js 24 JSON.rawJSON support");
      }
      return sourceJSON.rawJSON(item.toString());
    }
    if (typeof item === "number" && (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))) {
      throw new RangeError("Unsafe JavaScript number; supply a bigint or string instead");
    }
    if (item === undefined || typeof item === "function" || typeof item === "symbol") {
      throw new TypeError("JSON storage values must be JSON-compatible (or bigint)");
    }
    return item;
  });
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

// Reject symlinks at every path component, including ancestors of the supplied root.
// As with Node's path-based rename, the parent directories must be application-owned:
// this is not a sandbox against another process concurrently replacing directories.
async function parentExists(file: string, create: boolean, signal?: AbortSignal): Promise<boolean> {
  const parent = path.dirname(file);
  let current = path.parse(parent).root;
  for (const segment of parent.slice(current.length).split(path.sep).filter(Boolean)) {
    signal?.throwIfAborted();
    current = path.join(current, segment);
    let entry;
    try {
      entry = await fs.lstat(current);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      if (!create) return false;
      signal?.throwIfAborted();
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
      entry = await fs.lstat(current);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Storage path must be a real directory: ${current}`);
    }
  }
  return true;
}

async function checkTarget(file: string): Promise<void> {
  try {
    const entry = await fs.lstat(file);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Storage target must be a regular file: ${file}`);
    }
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

/**
 * Lazy, single-writer JSON storage. Use one instance per path (StorageRoot caches it).
 * Defaults seed missing files only; an existing document is authoritative.
 * Bare unsafe integer literals round-trip as bigint; other numbers use IEEE-754,
 * so decimal precision, exponent spelling and negative-zero spelling are not retained.
 * Unsafe integer-valued decimals/exponents and non-finite numbers are rejected.
 * No descriptor, timer, worker or parsed document is retained while idle.
 */
export class JsonStore<T extends RecordValue> {
  private readonly file: string;
  private readonly defaults: string;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(file: string, defaults: T) {
    if (!file || file.includes("\0")) throw new TypeError("Invalid storage file path");
    this.file = path.resolve(file);
    this.defaults = stringify(defaults);
    parse(this.defaults);
  }

  read(signal?: AbortSignal): Promise<T> {
    return this.admit(() => this.load(signal), signal);
  }

  /**
   * The mutator receives a detached complete document and must return a complete
   * document. Mutate and return it, or spread it, to preserve untouched fields;
   * omitted keys are deleted, including keys present in defaults.
   */
  update(mutator: (current: T) => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.admit(async () => {
      const before = await this.load(signal);
      signal?.throwIfAborted();
      const changed = await mutator(structuredClone(before));
      signal?.throwIfAborted();
      if (!isRecord(changed)) throw new TypeError("JSON storage requires an object at the root");
      const bytes = stringify(changed) + "\n";
      const result = parse(bytes) as T;
      await this.write(bytes, signal);
      return result;
    }, signal);
  }

  close(): Promise<void> {
    this.closed = true;
    return this.tail;
  }

  private admit<R>(operation: () => Promise<R>, signal?: AbortSignal): Promise<R> {
    if (this.closed) return Promise.reject(new Error("JSON store is closed"));
    const result = this.tail.then(() => {
      signal?.throwIfAborted();
      return operation();
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async load(signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (!(await parentExists(this.file, false, signal))) {
      signal?.throwIfAborted();
      return parse(this.defaults) as T;
    }
    signal?.throwIfAborted();
    let handle;
    try {
      handle = await fs.open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      signal?.throwIfAborted();
      if (hasCode(error, "ENOENT")) return parse(this.defaults) as T;
      throw error;
    }
    try {
      if (!(await handle.stat()).isFile()) throw new Error("Storage target must be a regular file");
      const text = await handle.readFile({ encoding: "utf8", signal });
      signal?.throwIfAborted();
      return parse(text) as T;
    } finally {
      await handle.close();
    }
  }

  private async write(bytes: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await parentExists(this.file, true, signal);
    await checkTarget(this.file);
    const temporary = path.join(path.dirname(this.file), `.telebox-${randomUUID()}.tmp`);
    let handle;
    let created = false;
    try {
      signal?.throwIfAborted();
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      await handle.chmod(0o600);
      await handle.writeFile(bytes, { encoding: "utf8", signal });
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (!(await parentExists(this.file, false, signal))) {
        throw new Error("Storage parent disappeared before commit");
      }
      await checkTarget(this.file);
      signal?.throwIfAborted();
      // Rename submission is the commit boundary. Later cancellation cannot undo it.
      // File fsync precedes rename; power-loss durability of directory metadata is not promised.
      await fs.rename(temporary, this.file);
    } catch (error) {
      const errors: unknown[] = [error];
      if (handle) {
        try { await handle.close(); } catch (failure) { errors.push(failure); }
      }
      if (created) {
        try { await fs.unlink(temporary); } catch (failure) {
          if (!hasCode(failure, "ENOENT")) errors.push(failure);
        }
      }
      if (errors.length > 1) throw new AggregateError(errors, "Storage write and cleanup failed");
      throw error;
    }
  }
}

/** Owns plugin stores; the first defaults supplied for each path remain in effect. */
export class StorageRoot {
  private readonly root: string;
  private readonly stores = new Map<string, JsonStore<RecordValue>>();
  private closing?: Promise<void>;

  constructor(root: string) {
    if (!root || root.includes("\0")) throw new TypeError("Invalid storage root");
    this.root = path.resolve(root);
  }

  json<T extends RecordValue>(pluginId: string, fileName: string, defaults: T): JsonStore<T> {
    if (this.closing) throw new Error("Storage root is closed");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(pluginId)) throw new TypeError("Invalid plugin id");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/.test(fileName)) throw new TypeError("Invalid JSON filename");
    const file = path.join(this.root, pluginId, fileName);
    let store = this.stores.get(file);
    if (!store) {
      store = new JsonStore(file, defaults);
      this.stores.set(file, store);
    }
    return store as JsonStore<T>;
  }

  close(): Promise<void> {
    this.closing ??= Promise.all([...this.stores.values()].map(store => store.close())).then(() => {
      this.stores.clear();
    });
    return this.closing;
  }
}
