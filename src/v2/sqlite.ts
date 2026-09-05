import type Database from "better-sqlite3";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Borrowed native SQL API; connections, statements and iterators live only inside a callback. */
export type SqliteConnection = Pick<Database.Database,
  "prepare" | "transaction" | "exec" | "pragma" | "open" | "readonly" | "inTransaction" | "name"
>;

export interface SqliteOptions {
  readonly readonly?: boolean;
  /** SQLite's synchronous busy timeout; AbortSignal cannot interrupt a running native statement. */
  readonly timeoutMs?: number;
}

export interface SqliteColumn {
  cid: bigint;
  name: string;
  type: string;
  notnull: bigint;
  dflt_value: string | null;
  pk: bigint;
  hidden: bigint;
}

export interface SqliteSchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
  columns: SqliteColumn[];
}

export interface SqlitePreflight {
  sqliteVersion: string;
  userVersion: bigint;
  applicationId: bigint;
  journalMode: string;
  schema: SqliteSchemaObject[];
  integrity: string[];
  foreignKeyViolations: { table: string; rowid: bigint | null; parent: string; fkid: bigint }[];
  issues: string[];
  compatible: boolean;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

// Trusted, application-owned directories are required, as in JSON storage. Node's
// path-based native SQLite open is not a sandbox against concurrent directory swaps
// or caller-supplied ATTACH / extension SQL. Check engine-managed sidecars as well.
async function checkPath(file: string, create: boolean, signal?: AbortSignal): Promise<void> {
  const parent = path.dirname(file);
  let current = path.parse(parent).root;
  for (const segment of parent.slice(current.length).split(path.sep).filter(Boolean)) {
    signal?.throwIfAborted();
    current = path.join(current, segment);
    let entry;
    try {
      entry = await fs.lstat(current);
    } catch (error) {
      if (!create || !hasCode(error, "ENOENT")) throw error;
      signal?.throwIfAborted();
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
      entry = await fs.lstat(current);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`SQLite path must be a real directory: ${current}`);
    }
  }
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    signal?.throwIfAborted();
    try {
      const entry = await fs.lstat(file + suffix);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(`SQLite target must be a regular file: ${file + suffix}`);
      }
    } catch (error) {
      if (!hasCode(error, "ENOENT") || (!create && suffix === "")) throw error;
    }
  }
}

function synchronous<T>(value: T): T {
  if (value !== null && (typeof value === "object" || typeof value === "function") &&
      typeof (value as { then?: unknown }).then === "function") {
    // An invalid async callback may reject after rollback/close. Observe that
    // rejection while reporting the synchronous-contract violation to the caller.
    void Promise.resolve(value).catch(() => undefined);
    throw new TypeError("SQLite callbacks must be synchronous; Promise/thenable results are forbidden");
  }
  return value;
}

function scopeConnection(db: Database.Database): () => void {
  const transaction = db.transaction.bind(db);
  db.transaction = (<Args extends unknown[], Result>(fn: (...args: Args) => Result) => {
    if (typeof fn !== "function") throw new TypeError("SQLite transaction requires a function");
    return transaction(function (this: unknown, ...args: Args) {
      return synchronous(fn.apply(this, args));
    });
  }) as typeof db.transaction;
  const iterators = new Set<IterableIterator<unknown>>();
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    const iterate = statement.iterate;
    statement.iterate = function (...bindings: unknown[]) {
      const iterator = iterate.apply(this, bindings);
      iterators.add(iterator);
      return iterator;
    };
    return statement;
  }) as typeof db.prepare;
  return () => {
    for (const iterator of iterators) iterator.return?.();
    iterators.clear();
  };
}

/**
 * One serial queue per file/store; use one store instance per path. Each operation
 * lazily imports better-sqlite3, opens one connection and closes it before settling.
 * Native module code is cached by Node, but no idle connection, timer or worker is kept.
 * All INTEGER results (including counts and rowids) default to bigint. REAL uses
 * IEEE-754; callers must bind bigint/string rather than already-rounded JS IDs.
 * No schema, user_version, application_id or journal_mode migration is performed.
 */
export class SqliteStore {
  private readonly file: string;
  private readonly readonly: boolean;
  private readonly timeout: number;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(file: string, options: SqliteOptions = {}) {
    if (!file || file.includes("\0") || file !== file.trim() ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.(db|sqlite|sqlite3)$/.test(path.basename(file)) ||
        file.split(/[\\/]/).includes("..") || file.includes("\\") || file.startsWith("file:")) {
      throw new TypeError("SQLite requires a local .db, .sqlite or .sqlite3 file path without traversal");
    }
    this.file = path.resolve(file);
    this.readonly = options.readonly ?? false;
    this.timeout = options.timeoutMs ?? 5000;
    if (!Number.isInteger(this.timeout) || this.timeout < 0 || this.timeout > 2_147_483_647) {
      throw new RangeError("SQLite timeoutMs must be an integer between 0 and 2147483647");
    }
  }

  /** Always opens readonly with fileMustExist; callback runs in a consistent read transaction. */
  read<T>(callback: (db: SqliteConnection) => T, signal?: AbortSignal): Promise<T> {
    return this.admit(() => this.operate(callback, true, signal), signal);
  }

  /**
   * Synchronous native IMMEDIATE transaction; throws/thenables/cancellation roll back.
   * Use db.transaction() for nested savepoints; do not manually BEGIN/COMMIT/ROLLBACK.
   */
  transaction<T>(callback: (db: SqliteConnection) => T, signal?: AbortSignal): Promise<T> {
    return this.admit(() => {
      if (this.readonly) throw new Error("SQLite store is readonly");
      return this.operate(callback, false, signal);
    }, signal);
  }

  /** Read-only compatibility snapshot, not a migration or a lock for a later migration. */
  preflight(required: Readonly<Record<string, readonly string[]>> = {}, signal?: AbortSignal): Promise<SqlitePreflight> {
    const requirements = Object.entries(required).map(([table, columns]) => [table, [...columns]] as const);
    return this.read(db => {
      const schema = db.prepare<[], Omit<SqliteSchemaObject, "columns">>(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
      ).all().map(entry => ({
        ...entry,
        columns: entry.type === "table" || entry.type === "view"
          ? db.prepare<[string], SqliteColumn>("SELECT * FROM pragma_table_xinfo(?)").all(entry.name)
          : [],
      }));
      const integrity = db.prepare<[], string>("PRAGMA quick_check").pluck().all();
      const foreignKeyViolations = db.prepare<[], SqlitePreflight["foreignKeyViolations"][number]>("PRAGMA foreign_key_check").all();
      const issues: string[] = [];
      if (integrity.length !== 1 || integrity[0] !== "ok") issues.push("SQLite quick_check failed");
      if (foreignKeyViolations.length) issues.push("SQLite foreign key violations exist");
      for (const [name, columns] of requirements) {
        const table = schema.find(entry => entry.type === "table" && entry.name === name);
        if (!table) issues.push(`Missing table: ${name}`);
        else for (const column of columns) {
          if (!table.columns.some(entry => entry.name === column)) issues.push(`Missing column: ${name}.${column}`);
        }
      }
      return {
        sqliteVersion: db.prepare<[], string>("SELECT sqlite_version()").pluck().get()!,
        userVersion: db.pragma("user_version", { simple: true }) as bigint,
        applicationId: db.pragma("application_id", { simple: true }) as bigint,
        journalMode: db.pragma("journal_mode", { simple: true }) as string,
        schema, integrity, foreignKeyViolations, issues, compatible: issues.length === 0,
      };
    }, signal);
  }

  close(): Promise<void> {
    this.closed = true;
    return this.tail;
  }

  private admit<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error("SQLite store is closed"));
    const result = this.tail.then(() => {
      signal?.throwIfAborted();
      return operation();
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async operate<T>(callback: (db: SqliteConnection) => T, readonly: boolean, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    // Keep this import dynamic and external when bundling: native binding resolution
    // depends on better-sqlite3's installed package location. CJS exports use .default.
    const { default: NativeDatabase } = await import("better-sqlite3");
    signal?.throwIfAborted();
    await checkPath(this.file, !readonly, signal);
    if (!readonly) {
      signal?.throwIfAborted();
      try {
        const file = await fs.open(this.file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await file.close();
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
      await checkPath(this.file, false, signal);
    }
    signal?.throwIfAborted();
    const db = new NativeDatabase(this.file, { readonly, fileMustExist: true, timeout: this.timeout });
    try {
      db.defaultSafeIntegers(true);
      db.pragma("foreign_keys = ON");
      const finishIterators = scopeConnection(db);
      const run = db.transaction(() => {
        try {
          signal?.throwIfAborted();
          const result = synchronous(callback(db));
          signal?.throwIfAborted();
          return result;
        } finally {
          finishIterators();
        }
      });
      return readonly ? run.deferred() : run.immediate();
    } finally {
      db.close();
    }
  }
}
