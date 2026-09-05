import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { SqliteStore, type SqliteConnection } from "./sqlite";

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), "telebox-sqlite-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, "state.db") };
}

async function missing(file: string) {
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
}

async function seed(file: string, sql = "CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)") {
  const { default: NativeDatabase } = await import("better-sqlite3");
  const db = new NativeDatabase(file);
  try { db.exec(sql); } finally { db.close(); }
}

function count(db: SqliteConnection): bigint {
  return db.prepare<[], bigint>("SELECT count(*) FROM items").pluck().get()!;
}

async function databaseDescriptors(directory: string): Promise<string[]> {
  if (process.platform === "linux") {
    const targets = await Promise.all((await fs.readdir("/proc/self/fd")).map(async fd => {
      try { return await fs.readlink(`/proc/self/fd/${fd}`); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
        throw error;
      }
    }));
    return targets.filter(name => name.startsWith(directory + path.sep));
  }
  assert.equal(process.platform, "darwin", "FD verification requires Linux /proc or macOS lsof");
  const output = execFileSync("/usr/sbin/lsof", ["-a", "-p", String(process.pid), "-Fn"], { encoding: "utf8" });
  return output.split("\n").filter(line => line.startsWith("n" + directory + path.sep)).map(line => line.slice(1));
}

test("import, construction and close are lazy; first operation loads the native library", async t => {
  const require = createRequire(__filename);
  const driver = require.resolve("better-sqlite3");
  assert.equal(require.cache[driver], undefined);
  const { directory } = await fixture(t);
  const file = path.join(directory, "missing", "lazy.db");
  const unopened = new SqliteStore(file);
  assert.equal(require.cache[driver], undefined);
  await unopened.close();
  assert.equal(require.cache[driver], undefined);
  await missing(path.dirname(file));
  const store = new SqliteStore(file);
  assert.equal(await store.transaction(db => {
    assert.equal(db.open, true);
    assert.equal(db.readonly, false);
    return db.prepare<[], bigint>("SELECT 9007199254740993123").pluck().get();
  }), 9007199254740993123n);
  assert.ok(require.cache[driver]);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.deepEqual((await store.preflight()).schema, []);
  await store.close();
});

test("native INTEGER IDs, rowids and counts use bigint across reopen", async t => {
  const { file } = await fixture(t);
  const store = new SqliteStore(file);
  const maximum = 9223372036854775807n;
  const minimum = -9223372036854775808n;
  const rowid = await store.transaction(db => {
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO items VALUES (?, ?)").run(minimum, "negative");
    return db.prepare("INSERT INTO items VALUES (?, ?)").run(maximum, "positive").lastInsertRowid;
  });
  assert.equal(rowid, maximum);
  assert.equal(await store.read(count), 2n);
  assert.deepEqual(await store.read(db => db.prepare("SELECT * FROM items ORDER BY id").all()), [
    { id: minimum, value: "negative" }, { id: maximum, value: "positive" },
  ]);
  await store.close();
  const reopened = new SqliteStore(file);
  assert.equal(await reopened.read(db => db.prepare("SELECT id FROM items WHERE id = ?").pluck().get(maximum)), maximum);
  assert.deepEqual(await reopened.read(db => db.prepare("SELECT 0.1 AS fraction, '9223372036854775808' AS text_id").get()), {
    fraction: 0.1, text_id: "9223372036854775808",
  });
  await reopened.close();
});

test("preflight inspects legacy schemas without migrating them or discarding unknown data", async t => {
  const { file } = await fixture(t);
  await seed(file, `
    CREATE TABLE aliases (original TEXT PRIMARY KEY, final TEXT NOT NULL);
    CREATE TABLE users (uid INTEGER PRIMARY KEY, username TEXT NOT NULL, future_payload TEXT);
    CREATE TABLE chats (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT NOT NULL UNIQUE, redirect TEXT);
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE leech_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action_id TEXT NOT NULL, target TEXT NOT NULL,
      chat_id TEXT, chat_title TEXT, chat_type TEXT, from_ts INTEGER NOT NULL, to_ts INTEGER NOT NULL,
      status TEXT NOT NULL, requested_limit INTEGER, batch_size INTEGER NOT NULL,
      saved_count INTEGER NOT NULL DEFAULT 0, scanned_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL, finished_at TEXT, error TEXT, options_json TEXT
    );
    CREATE TABLE leech_messages (
      chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, first_job_id INTEGER NOT NULL,
      last_job_id INTEGER NOT NULL, date_ts INTEGER NOT NULL, date_iso TEXT NOT NULL,
      edit_date_ts INTEGER, sender_id TEXT, sender_username TEXT, sender_name TEXT,
      message_text TEXT, raw_json TEXT NOT NULL, media_type TEXT, reply_to_msg_id INTEGER,
      grouped_id TEXT, views INTEGER, forwards INTEGER, is_out INTEGER NOT NULL DEFAULT 0,
      saved_at TEXT NOT NULL, PRIMARY KEY (chat_id, message_id)
    );
    CREATE INDEX idx_leech_messages_date ON leech_messages(chat_id, date_ts);
    CREATE TABLE leech_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action_id TEXT NOT NULL, job_id INTEGER,
      action TEXT NOT NULL, status TEXT NOT NULL, timestamp TEXT NOT NULL, actor TEXT,
      target TEXT, details_json TEXT
    );
    CREATE INDEX idx_leech_actions_action_id ON leech_actions(action_id);
    CREATE TABLE future_data (id INTEGER PRIMARY KEY, payload BLOB);
    CREATE VIEW future_view AS SELECT id FROM future_data;
    CREATE TRIGGER future_trigger AFTER INSERT ON aliases BEGIN
      INSERT INTO config VALUES (NEW.original, NEW.final);
    END;
    INSERT INTO users VALUES (9007199254740993123, 'before', 'unknown field');
    INSERT INTO future_data VALUES (9223372036854775807, X'00FF0102');
    INSERT INTO aliases VALUES ('old', 'ping');
    PRAGMA user_version = 17;
    PRAGMA application_id = 12345;
  `);
  const bytes = await fs.readFile(file);
  const store = new SqliteStore(file);
  const required = {
    aliases: ["original", "final"], users: ["uid", "username"], chats: ["id", "name"],
    msgs: ["id", "msg", "redirect"], config: ["key", "value"],
    leech_jobs: ["id", "options_json"], leech_messages: ["chat_id", "message_id", "raw_json"],
    leech_actions: ["id", "action_id", "details_json"],
  };
  const before = await store.preflight(required);
  assert.equal(before.compatible, true);
  assert.deepEqual(before.issues, []);
  assert.deepEqual(before.integrity, ["ok"]);
  assert.deepEqual(before.foreignKeyViolations, []);
  assert.equal(before.userVersion, 17n);
  assert.equal(before.applicationId, 12345n);
  assert.match(before.sqliteVersion, /^3\./);
  assert.equal(before.journalMode, "delete");
  assert.deepEqual(await fs.readFile(file), bytes);
  await store.transaction(db => {
    db.prepare("UPDATE users SET username = ? WHERE uid = ?").run("after", 9007199254740993123n);
    db.prepare("DELETE FROM aliases WHERE original = ?").run("old");
  });
  const after = await store.preflight(required);
  assert.deepEqual(after, before);
  assert.deepEqual(await store.read(db => db.prepare("SELECT * FROM users").get()), {
    uid: 9007199254740993123n, username: "after", future_payload: "unknown field",
  });
  assert.deepEqual(await store.read(db => db.prepare("SELECT * FROM future_data").get()), {
    id: 9223372036854775807n, payload: Buffer.from([0, 255, 1, 2]),
  });
  assert.equal(await store.read(db => db.prepare("SELECT count(*) FROM aliases").pluck().get()), 0n);
  await store.close();
});

test("preflight reports missing requirements and foreign key violations without writes", async t => {
  const { file } = await fixture(t);
  await seed(file, `
    PRAGMA foreign_keys = OFF;
    CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
    INSERT INTO child VALUES (9007199254740993123, 7);
    CREATE TABLE "quoted' table" ("quoted' column" TEXT);
  `);
  const bytes = await fs.readFile(file);
  const store = new SqliteStore(file, { readonly: true });
  const result = await store.preflight({ absent: ["id"], child: ["missing"], "quoted' table": ["quoted' column"] });
  assert.equal(result.compatible, false);
  assert.deepEqual(result.issues, ["SQLite foreign key violations exist", "Missing table: absent", "Missing column: child.missing"]);
  assert.deepEqual(result.foreignKeyViolations, [{ table: "child", rowid: 9007199254740993123n, parent: "parent", fkid: 0n }]);
  assert.deepEqual(await fs.readFile(file), bytes);
  await store.close();
});

test("transaction errors roll back both SQL data and DDL and leave the queue usable", async t => {
  const { file } = await fixture(t);
  await seed(file);
  const store = new SqliteStore(file);
  const failure = new Error("failed operation");
  let captured!: SqliteConnection;
  await assert.rejects(store.transaction(db => {
    captured = db;
    db.exec("INSERT INTO items VALUES (1, 'failed'); CREATE TABLE failed_schema (id INTEGER)");
    throw failure;
  }), error => error === failure);
  assert.equal(captured.open, false);
  assert.equal(await store.read(count), 0n);
  assert.ok(!(await store.preflight()).schema.some(entry => entry.name === "failed_schema"));
  await assert.rejects(store.transaction(db => {
    db.exec("INSERT INTO items VALUES (2, 'failed')");
    db.prepare("INSERT INTO items VALUES (?, ?)").run(2, "duplicate");
  }), /UNIQUE/);
  assert.equal(await store.read(count), 0n);
  await store.transaction(db => db.exec("INSERT INTO items VALUES (3, 'kept')"));
  assert.equal(await store.read(count), 1n);
  await store.close();
});

test("native prepared statements, named bindings and nested transactions remain available", async t => {
  const { file } = await fixture(t);
  await seed(file);
  const store = new SqliteStore(file);
  await store.transaction(db => {
    const insert = db.prepare("INSERT INTO items VALUES (@id, @value)");
    insert.run({ id: 1n, value: "first" });
    assert.throws(db.transaction(() => {
      insert.run({ id: 2n, value: "rolled back savepoint" });
      throw new Error("nested failure");
    }), /nested failure/);
    db.transaction(() => insert.run({ id: 3n, value: "third" })).immediate();
  });
  assert.deepEqual(await store.read(db => [...db.prepare("SELECT id FROM items ORDER BY id").pluck().iterate()]), [1n, 3n]);
  await store.close();
});

test("Promise and thenable transaction returns are rejected before commit", async t => {
  const { file } = await fixture(t);
  await seed(file);
  const store = new SqliteStore(file);
  for (const result of [() => Promise.resolve(1), () => Promise.reject(new Error("late rejection")), () => ({ then(resolve: (value: number) => void) { resolve(1); } })]) {
    await assert.rejects(store.transaction(db => {
      db.exec("INSERT INTO items VALUES (1, 'rollback')");
      return result();
    }), /must be synchronous/);
    assert.equal(await store.read(count), 0n);
  }
  let captured!: SqliteConnection;
  await assert.rejects(store.transaction(async db => {
    captured = db;
    db.exec("INSERT INTO items VALUES (1, 'rollback')");
    await new Promise<void>(resolve => setImmediate(resolve));
    db.exec("INSERT INTO items VALUES (2, 'closed connection')");
  }), /must be synchronous/);
  assert.equal(captured.open, false);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(await store.read(count), 0n);
  await assert.rejects(store.read(async () => 1), /must be synchronous/);
  await store.close();
});

test("unfinished iterators are finalized before commit, rollback and connection close", async t => {
  const { directory, file } = await fixture(t);
  await seed(file, "CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES (1, 'one'), (2, 'two')");
  const store = new SqliteStore(file);
  let captured!: SqliteConnection;
  const iterator = await store.read(db => {
    captured = db;
    const iterator = db.prepare("SELECT * FROM items").iterate();
    assert.deepEqual(iterator.next().value, { id: 1n, value: "one" });
    return iterator;
  });
  assert.equal(captured.open, false);
  assert.equal(iterator.next().done, true);
  await assert.rejects(store.transaction(db => {
    db.exec("INSERT INTO items VALUES (3, 'rollback')");
    db.prepare("SELECT * FROM items").iterate().next();
    throw new Error("unfinished iterator failure");
  }), /unfinished iterator failure/);
  assert.equal(await store.read(count), 2n);
  assert.deepEqual(await databaseDescriptors(directory), []);
  const statement = await store.read(db => db.prepare("SELECT * FROM items"));
  assert.throws(() => statement.get(), /not open/);
  await store.close();
});

test("nested transaction Promise rejections are observed and their writes roll back", async t => {
  const { file } = await fixture(t);
  await seed(file);
  const store = new SqliteStore(file);
  await store.transaction(db => {
    db.exec("INSERT INTO items VALUES (1, 'outer')");
    assert.throws(db.transaction(() => {
      db.exec("INSERT INTO items VALUES (2, 'nested rollback')");
      return Promise.reject(new Error("nested late rejection"));
    }), /must be synchronous/);
    assert.equal(count(db), 1n);
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(await store.read(count), 1n);
  await store.close();
});

test("readonly requires existing files, creates no directories and rejects SQL writes", async t => {
  const { directory, file } = await fixture(t);
  const absent = path.join(directory, "absent", "readonly.db");
  const readonly = new SqliteStore(absent, { readonly: true });
  await assert.rejects(readonly.read(() => 1), { code: "ENOENT" });
  await assert.rejects(readonly.preflight(), { code: "ENOENT" });
  await assert.rejects(readonly.transaction(() => 1), /readonly/);
  await missing(path.dirname(absent));
  await readonly.close();
  const readThroughWritable = new SqliteStore(file);
  await assert.rejects(readThroughWritable.read(() => 1), { code: "ENOENT" });
  await missing(file);
  await readThroughWritable.close();
  await seed(file);
  const bytes = await fs.readFile(file);
  const existing = new SqliteStore(file, { readonly: true });
  assert.equal(await existing.read(db => db.readonly), true);
  await assert.rejects(existing.read(db => db.exec("INSERT INTO items VALUES (1, 'forbidden')")), /readonly/);
  await assert.rejects(existing.transaction(() => 1), /readonly/);
  assert.deepEqual(await fs.readFile(file), bytes);
  assert.deepEqual(await fs.readdir(directory), ["state.db"]);
  await existing.close();
});

test("serial operations close their connections before the next operation", async t => {
  const { file } = await fixture(t);
  await seed(file);
  const store = new SqliteStore(file);
  let previous: SqliteConnection | undefined;
  const values = await Promise.all(Array.from({ length: 50 }, (_, index) => store.transaction(db => {
    if (previous) assert.equal(previous.open, false);
    previous = db;
    assert.equal(count(db), BigInt(index));
    db.prepare("INSERT INTO items VALUES (?, ?)").run(BigInt(index), "serial");
    return count(db);
  })));
  assert.deepEqual(values, Array.from({ length: 50 }, (_, index) => BigInt(index + 1)));
  assert.equal(previous?.open, false);
  assert.equal(await store.read(count), 50n);
  await store.close();
});

test("close rejects new work and waits for admitted reads, transactions and failures", async t => {
  const { file } = await fixture(t);
  await seed(file);
  const store = new SqliteStore(file);
  const first = store.transaction(db => db.exec("INSERT INTO items VALUES (1, 'first')"));
  const failed = store.transaction(() => { throw new Error("admitted failure"); });
  const failure = assert.rejects(failed, /admitted failure/);
  const last = store.transaction(db => db.exec("INSERT INTO items VALUES (2, 'last')"));
  const read = store.read(count);
  const closing = store.close();
  assert.equal(store.close(), closing);
  let settled = false;
  void closing.then(() => { settled = true; });
  await assert.rejects(store.read(count), /closed/);
  await assert.rejects(store.transaction(() => 1), /closed/);
  await assert.rejects(store.preflight(), /closed/);
  assert.equal(settled, false);
  await Promise.all([first, failure, last, closing]);
  assert.equal(await read, 2n);
  assert.equal(settled, true);
});

test("cancellation skips queued work and rolls back synchronous callback mutations", async t => {
  const { directory, file } = await fixture(t);
  const absent = path.join(directory, "absent", "state.db");
  const canceled = new AbortController();
  const reason = new Error("canceled");
  canceled.abort(reason);
  const unopened = new SqliteStore(absent);
  await assert.rejects(unopened.transaction(() => assert.fail("must not run"), canceled.signal), error => error === reason);
  await missing(path.dirname(absent));
  await unopened.close();
  await seed(file);
  const store = new SqliteStore(file);
  const queued = new AbortController();
  const first = store.transaction(db => db.exec("INSERT INTO items VALUES (1, 'first')"));
  const skipped = store.transaction(() => assert.fail("queued callback must not run"), queued.signal);
  const rejected = assert.rejects(skipped, { name: "AbortError" });
  queued.abort();
  await Promise.all([first, rejected]);
  const active = new AbortController();
  await assert.rejects(store.transaction(db => {
    db.exec("INSERT INTO items VALUES (2, 'rollback')");
    active.abort();
  }, active.signal), { name: "AbortError" });
  assert.equal(await store.read(count), 1n);
  await store.close();
});

test("existing WAL mode and unknown schema survive connection cycles", async t => {
  const { file } = await fixture(t);
  await seed(file, "PRAGMA journal_mode = WAL; CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES (1, 'wal')");
  for (let i = 0; i < 5; i++) {
    const store = new SqliteStore(file);
    assert.equal((await store.preflight()).journalMode, "wal");
    await store.transaction(db => db.prepare("UPDATE items SET value = ? WHERE id = 1").run(String(i)));
    await store.close();
  }
  const readonly = new SqliteStore(file, { readonly: true });
  assert.equal((await readonly.preflight()).journalMode, "wal");
  assert.equal(await readonly.read(db => db.prepare("SELECT value FROM items").pluck().get()), "4");
  await readonly.close();
});

test("50 open/read/write/close cycles leave no database or sidecar descriptors", async t => {
  const { directory, file } = await fixture(t);
  await seed(file, "PRAGMA journal_mode = WAL; CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)");
  assert.deepEqual(await databaseDescriptors(directory), []);
  for (let index = 0; index < 50; index++) {
    const store = new SqliteStore(file);
    let connection!: SqliteConnection;
    await store.transaction(db => {
      connection = db;
      db.prepare("INSERT INTO items VALUES (?, ?)").run(BigInt(index), "cycle");
    });
    assert.equal(connection.open, false);
    assert.equal(await store.read(count), BigInt(index + 1));
    if (index % 10 === 0) assert.deepEqual(await databaseDescriptors(directory), []);
    await store.close();
    assert.equal(connection.open, false);
  }
  assert.deepEqual(await databaseDescriptors(directory), []);
});

test("invalid paths, traversal, URI databases and invalid timeouts are rejected", () => {
  for (const file of ["", ":memory:", "file:memory.db", "../outside.db", "safe/../../outside.db", "safe\\outside.db", "x.db\0", "x.json", ".db", " state.db", "state.db "]) {
    assert.throws(() => new SqliteStore(file), /local/);
  }
  for (const timeoutMs of [-1, 0.5, Infinity, NaN, 2_147_483_648]) {
    assert.throws(() => new SqliteStore("valid.db", { timeoutMs }), /timeoutMs/);
  }
});

for (const location of ["ancestor", "parent", "file", "dangling", "-wal", "-shm", "-journal"] as const) {
  test(`rejects ${location} symlinks without modifying external fixtures`, async t => {
    const { directory } = await fixture(t);
    const outside = path.join(directory, "outside");
    await fs.mkdir(outside);
    const external = path.join(outside, "sentinel.db");
    await seed(external);
    const bytes = await fs.readFile(external);
    let file = path.join(directory, "target", "state.db");
    if (location === "parent" || location === "ancestor") {
      await fs.symlink(outside, path.dirname(file));
      if (location === "ancestor") file = path.join(path.dirname(file), "child", "state.db");
    } else {
      await fs.mkdir(path.dirname(file));
      if (location === "file" || location === "dangling") {
        await fs.symlink(location === "file" ? external : path.join(outside, "missing.db"), file);
      } else {
        await seed(file);
        await fs.symlink(external, file + location);
      }
    }
    const store = new SqliteStore(file);
    await assert.rejects(store.read(() => assert.fail("must not run")), /real directory|regular file/);
    await assert.rejects(store.transaction(() => assert.fail("must not run")), /real directory|regular file/);
    assert.deepEqual(await fs.readFile(external), bytes);
    assert.deepEqual(await fs.readdir(outside), ["sentinel.db"]);
    await store.close();
  });
}

test("non-regular and corrupt databases fail without being overwritten", async t => {
  const { directory, file } = await fixture(t);
  await fs.mkdir(file);
  const nonregular = new SqliteStore(file);
  await assert.rejects(nonregular.read(() => 1), /regular file/);
  await nonregular.close();
  const corrupt = path.join(directory, "corrupt.db");
  const bytes = Buffer.from("this is not a SQLite database");
  await fs.writeFile(corrupt, bytes);
  const store = new SqliteStore(corrupt);
  await assert.rejects(store.preflight(), /not a database/);
  await assert.rejects(store.transaction(db => db.exec("CREATE TABLE test (id INTEGER)")), /not a database/);
  assert.deepEqual(await fs.readFile(corrupt), bytes);
  assert.deepEqual(await databaseDescriptors(directory), []);
  await store.close();
});
